// MAB Engine - Multi-Armed Bandit (Contextual ε-Greedy)
// Lightweight reinforcement learning for tutor action selection
//
// Mathematical Model:
// - State: student_level_bucket (novice, apprentice, journeyman, expert, master)
// - Action: tutor question type (ask_evidence, ask_reasoning, etc.)
// - Reward: score improvement after the action was taken
//
// Policy: ε-Greedy
// - With probability (1-ε) = 0.80 → Exploit: SELECT action with highest avg_reward
// - With probability ε = 0.20 → Explore: SELECT random action
//
// SQL-based: ORDER BY avg_reward DESC LIMIT 1
// No ML libraries needed. Pure D1 queries.

import type { QTableEntry as QTableRow } from './math/mab-engine';

export interface QTableEntry {
  studentLevelBucket: string;
  tutorAction: string;
  timesSelected: number | null;
  totalReward: number | null;
  avgReward: number | null;
}

export interface MABDecision {
  selectedAction: string;
  isExploit: boolean; // true=exploit, false=explore
  avgReward: number | null;
  bucket: string;
}

// ε-Greedy parameters
const EPSILON = 0.20;  // 20% exploration rate
const MIN_OBSERVATIONS = 3; // Minimum observations before trusting Q-table

// =============================================
// Map rating to student level bucket
// =============================================
export function ratingToBucket(rating: string | null, avgScore: number): string {
  if (rating === 'MASTER') return 'master';
  if (rating === 'EXPERT') return 'expert';
  if (rating === 'JOURNEYMAN') return 'journeyman';
  if (rating === 'APPRENTICE') return 'apprentice';
  // Fallback: score-based
  if (avgScore >= 90) return 'master';
  if (avgScore >= 75) return 'expert';
  if (avgScore >= 60) return 'journeyman';
  if (avgScore >= 40) return 'apprentice';
  return 'novice';
}

// =============================================
// Select Action via ε-Greedy Bandit Policy
// =============================================
export async function selectActionViaBandit(
  db: D1Database,
  studentLevelBucket: string,
  availableActions: string[],
): Promise<MABDecision> {
  // Decide: explore or exploit
  const isExploit = Math.random() > EPSILON;

  if (isExploit) {
    // EXPLOIT: Query Q-Table for best action
    // SQL: ORDER BY avg_reward DESC LIMIT 1
    const result = await db.prepare(`
      SELECT tutor_action, avg_reward, times_selected
      FROM tutor_policy_q_table
      WHERE student_level_bucket = ?1 AND times_selected >= ?2
      ORDER BY avg_reward DESC
      LIMIT 1
    `).bind(studentLevelBucket, MIN_OBSERVATIONS).first<Pick<QTableRow, 'tutor_action' | 'avg_reward'>>();

    if (result) {
      return {
        selectedAction: result.tutor_action,
        isExploit: true,
        avgReward: result.avg_reward,
        bucket: studentLevelBucket,
      };
    }

    // Fallback: not enough data, use highest avg from seeded values
    const seededResult = await db.prepare(`
      SELECT tutor_action, avg_reward
      FROM tutor_policy_q_table
      WHERE student_level_bucket = ?1
      ORDER BY avg_reward DESC
      LIMIT 1
    `).bind(studentLevelBucket).first<Pick<QTableRow, 'tutor_action' | 'avg_reward'>>();

    if (seededResult) {
      return {
        selectedAction: seededResult.tutor_action,
        isExploit: true,
        avgReward: seededResult.avg_reward,
        bucket: studentLevelBucket,
      };
    }
  }

  // EXPLORE: Random action selection
  const randomIndex = Math.floor(Math.random() * availableActions.length);
  return {
    selectedAction: availableActions[randomIndex],
    isExploit: false,
    avgReward: 0,
    bucket: studentLevelBucket,
  };
}

// =============================================
// Update Q-Table with reward
// Reward = (next_turn_avg_score - current_avg_score) / 100
// Positive reward means the action improved student performance
// =============================================
export async function updateQTableReward(
  db: D1Database,
  studentLevelBucket: string,
  action: string,
  reward: number, // [-1.0 ~ 1.0] range
): Promise<void> {
  const now = Date.now();

  // Upsert: increment times_selected, add reward, recalculate avg
  await db.prepare(`
    INSERT INTO tutor_policy_q_table (student_level_bucket, tutor_action, times_selected, total_reward, avg_reward, last_used_at, updated_at)
    VALUES (?1, ?2, 1, ?3, ?3, ?4, ?4)
    ON CONFLICT(student_level_bucket, tutor_action) DO UPDATE SET
      times_selected = times_selected + 1,
      total_reward = total_reward + ?3,
      avg_reward = (total_reward + ?3) / (times_selected + 1),
      last_used_at = ?4,
      updated_at = ?4
  `).bind(studentLevelBucket, action, reward, now).run();
}

// =============================================
// Compute reward from score delta
// =============================================
export function computeReward(
  prevScores: { claim_clarity: number; evidence_use: number; reasoning_strength: number; consistency: number; relevance: number },
  nextScores: { claim_clarity: number; evidence_use: number; reasoning_strength: number; consistency: number; relevance: number },
): number {
  const prevAvg = (prevScores.claim_clarity + prevScores.evidence_use + prevScores.reasoning_strength + prevScores.consistency + prevScores.relevance) / 5;
  const nextAvg = (nextScores.claim_clarity + nextScores.evidence_use + nextScores.reasoning_strength + nextScores.consistency + nextScores.relevance) / 5;
  // Normalize to [-1, 1] range (max delta from 1→5 is +4, min is -4)
  return (nextAvg - prevAvg) / 4;
}

// =============================================
// Get Q-Table overview for analytics
// =============================================
export async function getQTableOverview(
  db: D1Database,
  bucket?: string,
): Promise<QTableEntry[]> {
  let query = 'SELECT student_level_bucket, tutor_action, times_selected, total_reward, avg_reward FROM tutor_policy_q_table';
  let stmt;

  if (bucket) {
    query += ' WHERE student_level_bucket = ?1 ORDER BY avg_reward DESC';
    stmt = db.prepare(query).bind(bucket);
  } else {
    query += ' ORDER BY student_level_bucket, avg_reward DESC';
    stmt = db.prepare(query);
  }

  const result = await stmt.all<QTableRow>();
  return (result.results || []).map((row) => ({
    studentLevelBucket: row.student_level_bucket,
    tutorAction: row.tutor_action,
    timesSelected: row.times_selected,
    totalReward: row.total_reward,
    avgReward: row.avg_reward,
  }));
}
