// MAB Engine – Contextual Multi-Armed Bandit (ε-Greedy)
// Q-Table: [student_level_bucket × tutor_action] → avg_reward
// Policy: 80% exploit (pick best action), 20% explore (random action)
//
// Reward signal: improvement in evaluation score after action
// R = (next_avg_score - current_avg_score) / 5, clamped to [-1, 1]

import type { TutorAction } from '../tutoring/types';

export interface QTableEntry {
  student_level_bucket: string;
  tutor_action: string;
  times_selected: number | null;
  total_reward: number | null;
  avg_reward: number | null;
}

export type StudentLevelBucket = 'novice' | 'apprentice' | 'journeyman' | 'expert' | 'master';

const ALL_ACTIONS: TutorAction[] = [
  'ask_evidence', 'ask_reasoning', 'ask_clarification',
  'ask_counterexample', 'ask_revision', 'narrow_scope',
  'give_hint', 'request_text_reference', 'move_to_synthesis',
];

const EPSILON = 0.2; // 20% exploration rate

// ==============================================
// ε-Greedy Action Selection
// ==============================================
export function selectActionByMAB(
  qTable: QTableEntry[],
  studentBucket: StudentLevelBucket,
  excludeActions: TutorAction[] = [],
): { action: TutorAction; isExploration: boolean } {
  const bucketEntries = qTable.filter(e => e.student_level_bucket === studentBucket);
  const availableActions = ALL_ACTIONS.filter(a => !excludeActions.includes(a));

  if (availableActions.length === 0) {
    return { action: 'ask_reasoning', isExploration: false };
  }

  // ε-Greedy: explore with probability EPSILON
  const isExploration = Math.random() < EPSILON;

  if (isExploration || bucketEntries.length === 0) {
    // Random exploration
    const randomIdx = Math.floor(Math.random() * availableActions.length);
    return { action: availableActions[randomIdx], isExploration: true };
  }

  // Exploit: pick the action with highest avg_reward
  let bestAction: TutorAction = availableActions[0];
  let bestReward = -Infinity;

  for (const action of availableActions) {
    const entry = bucketEntries.find(e => e.tutor_action === action);
    const reward = entry?.avg_reward ?? 0.5; // Default prior for unseen actions
    if (reward > bestReward) {
      bestReward = reward;
      bestAction = action;
    }
  }

  return { action: bestAction, isExploration: false };
}

// ==============================================
// Compute Reward Signal
// ==============================================
export function computeReward(
  prevScores: { claim_clarity: number; evidence_use: number; reasoning_strength: number; consistency: number; relevance: number },
  nextScores: { claim_clarity: number; evidence_use: number; reasoning_strength: number; consistency: number; relevance: number },
): number {
  const prevAvg = (prevScores.claim_clarity + prevScores.evidence_use + prevScores.reasoning_strength + prevScores.consistency + prevScores.relevance) / 5;
  const nextAvg = (nextScores.claim_clarity + nextScores.evidence_use + nextScores.reasoning_strength + nextScores.consistency + nextScores.relevance) / 5;

  // Reward = normalized improvement, clamped to [-1, 1]
  const reward = (nextAvg - prevAvg) / 5;
  return Math.max(-1, Math.min(1, reward));
}

// ==============================================
// SQL: Update Q-Table after reward observation
// ==============================================
export function buildQTableUpdateSQL(
  studentBucket: StudentLevelBucket,
  action: TutorAction,
  reward: number,
): { sql: string; binds: unknown[] } {
  return {
    sql: `UPDATE tutor_policy_q_table
          SET times_selected = times_selected + 1,
              total_reward = total_reward + ?3,
              avg_reward = (total_reward + ?3) / (times_selected + 1),
              last_used_at = ?4,
              updated_at = ?4
          WHERE student_level_bucket = ?1 AND tutor_action = ?2`,
    binds: [studentBucket, action, reward, Date.now()],
  };
}

// ==============================================
// SQL: Load Q-Table for a student bucket
// ==============================================
export function buildQTableLoadSQL(studentBucket: StudentLevelBucket): { sql: string; binds: unknown[] } {
  return {
    sql: `SELECT student_level_bucket, tutor_action, times_selected, total_reward, avg_reward
          FROM tutor_policy_q_table
          WHERE student_level_bucket = ?1
          ORDER BY avg_reward DESC`,
    binds: [studentBucket],
  };
}

// ==============================================
// UCB1 variant for exploration bonus (optional advanced)
// UCB1: avg_reward + sqrt(2 * ln(total_trials) / times_selected)
// ==============================================
export function selectActionByUCB1(
  qTable: QTableEntry[],
  studentBucket: StudentLevelBucket,
  totalTrials: number,
  excludeActions: TutorAction[] = [],
): { action: TutorAction; ucbScore: number } {
  const bucketEntries = qTable.filter(e => e.student_level_bucket === studentBucket);
  const availableActions = ALL_ACTIONS.filter(a => !excludeActions.includes(a));

  let bestAction: TutorAction = availableActions[0];
  let bestUCB = -Infinity;

  for (const action of availableActions) {
    const entry = bucketEntries.find(e => e.tutor_action === action);

    if (!entry || entry.times_selected === null || entry.times_selected === 0 || entry.avg_reward === null) {
      // Unseen actions get infinite UCB → always tried first
      return { action, ucbScore: Infinity };
    }

    const exploitTerm = entry.avg_reward;
    const exploreTerm = Math.sqrt(2 * Math.log(totalTrials) / entry.times_selected);
    const ucb = exploitTerm + exploreTerm;

    if (ucb > bestUCB) {
      bestUCB = ucb;
      bestAction = action;
    }
  }

  return { action: bestAction, ucbScore: bestUCB };
}

// ==============================================
// Determine student bucket from BKT average
// ==============================================
export function inferBucketFromBKT(avgPKnow: number): StudentLevelBucket {
  if (avgPKnow >= 0.9) return 'master';
  if (avgPKnow >= 0.75) return 'expert';
  if (avgPKnow >= 0.55) return 'journeyman';
  if (avgPKnow >= 0.35) return 'apprentice';
  return 'novice';
}

// ==============================================
// Determine student bucket from average score
// ==============================================
export function inferBucketFromScore(avgScore: number): StudentLevelBucket {
  if (avgScore >= 90) return 'master';
  if (avgScore >= 80) return 'expert';
  if (avgScore >= 70) return 'journeyman';
  if (avgScore >= 60) return 'apprentice';
  return 'novice';
}
