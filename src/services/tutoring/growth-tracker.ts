import type { StudentGrowthProfileRow } from '../../types/d1-rows';
// v14.0: Growth Tracker — 세션 간 성장 추적 + ELO 업데이트 + 마일스톤 감지
// student_growth_profile 테이블에 UPSERT, growth_milestones에 INSERT

import type { ThoughtProfile } from './thought-profiler';

// =============================================
// Types
// =============================================
export interface SessionResult {
  totalTurns: number;
  avgScores: {
    evidence: number;
    reasoning: number;
    defense: number;
    clarity: number;
    consistency: number;
  };
  weaknessPatterns: string[];
  revisionSuccessCount: number;
  maxLayerReached: string;
  thoughtProfile: ThoughtProfile;
}

// =============================================
// PATCH-011: Task 2 — Standard ELO Formula + Dynamic K-factor (Pelánek 2016)
// =============================================
const BASE_K_FACTOR = 24;

/**
 * Standard ELO update using logistic expected score formula.
 * Dynamic K-factor: higher for early sessions (fast convergence), lower later (stability).
 * Reference: Pelánek (2016) "Applications of the Elo rating system in adaptive educational systems"
 */
function updateElo(current: number, observedScore: number, _k: number, sessionCount?: number): number {
  // Dynamic K-factor based on session count
  const K = sessionCount !== undefined
    ? (sessionCount < 5 ? 40 : sessionCount < 20 ? 24 : 16)
    : BASE_K_FACTOR;
  // Standard ELO expected score: E = 1 / (1 + 10^((D - S) / 400))
  // Using a reference difficulty of 1000 (baseline)
  const expected = 1 / (1 + Math.pow(10, (1000 - current) / 400));
  // Observed score normalized to 0-1 (input is 1-5 scale)
  const actual = Math.max(0, Math.min(1, observedScore / 5));
  return Math.round(current + K * (actual - expected));
}

function initialElo(score: number): number {
  // Map 1-5 score to ~750-1250 ELO range
  return Math.round(1000 + (score - 2.5) * 100);
}

// =============================================
// Chronic Weakness Tracker
// =============================================
interface ChronicWeakness {
  pattern: string;
  count: number;
  lastSeen: string;
}

function updateChronicWeaknesses(
  existing: ChronicWeakness[],
  newPatterns: string[],
): ChronicWeakness[] {
  const map = new Map<string, ChronicWeakness>();
  for (const w of existing) {
    map.set(w.pattern, w);
  }
  for (const pattern of newPatterns) {
    const prev = map.get(pattern);
    map.set(pattern, {
      pattern,
      count: (prev?.count || 0) + 1,
      lastSeen: new Date().toISOString(),
    });
  }
  // Sort by frequency, keep top 10
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

// =============================================
// Main: Update Growth Profile
// =============================================
export async function updateGrowthProfile(
  db: D1Database,
  userId: string,
  sessionResult: SessionResult,
): Promise<void> {
  try {
    const existing = await db.prepare(
      'SELECT * FROM student_growth_profile WHERE user_id = ?1'
    ).bind(userId).first<StudentGrowthProfileRow>();

    if (existing) {
      // UPDATE existing profile (PATCH-011: pass session count for dynamic K-factor)
      const sessCount = existing.total_sessions || 0;
      const newEloEvidence = updateElo(existing.elo_evidence || 1000, sessionResult.avgScores.evidence, BASE_K_FACTOR, sessCount);
      const newEloReasoning = updateElo(existing.elo_reasoning || 1000, sessionResult.avgScores.reasoning, BASE_K_FACTOR, sessCount);
      const newEloDefense = updateElo(existing.elo_defense || 1000, sessionResult.avgScores.defense, BASE_K_FACTOR, sessCount);
      const newEloClarity = updateElo(existing.elo_clarity || 1000, sessionResult.avgScores.clarity, BASE_K_FACTOR, sessCount);
      const newEloConsistency = updateElo(existing.elo_consistency || 1000, sessionResult.avgScores.consistency, BASE_K_FACTOR, sessCount);

      // chronic_weaknesses 갱신 (빈도 기반)
      let prevWeaknesses: ChronicWeakness[] = [];
      try { prevWeaknesses = JSON.parse(existing.chronic_weaknesses || '[]'); } catch (e) { console.error("[P1-004] Caught:", e); }
      const chronicWeaknesses = updateChronicWeaknesses(prevWeaknesses, sessionResult.weaknessPatterns);

      // recent_session_scores sliding window (최근 10개)
      let recentScores: { score: number; date: string }[] = [];
      try { recentScores = JSON.parse(existing.recent_session_scores || '[]'); } catch (e) { console.error("[P1-004] Caught:", e); }
      const overallScore = Object.values(sessionResult.avgScores).reduce((a, b) => a + b, 0) / 5;
      recentScores.push({ score: overallScore, date: new Date().toISOString() });
      if (recentScores.length > 10) recentScores.shift();

      await db.prepare(`
        UPDATE student_growth_profile SET
          total_sessions = total_sessions + 1,
          total_turns = total_turns + ?2,
          elo_evidence = ?3, elo_reasoning = ?4, elo_defense = ?5,
          elo_clarity = ?6, elo_consistency = ?7,
          thought_profile_json = ?8,
          chronic_weaknesses = ?9,
          recent_session_scores = ?10,
          updated_at = ?11
        WHERE user_id = ?1
      `).bind(
        userId,
        sessionResult.totalTurns,
        newEloEvidence, newEloReasoning, newEloDefense,
        newEloClarity, newEloConsistency,
        JSON.stringify(sessionResult.thoughtProfile),
        JSON.stringify(chronicWeaknesses),
        JSON.stringify(recentScores),
        Date.now(),
      ).run();

      // Detect milestones
      await detectAndRecordMilestones(db, userId, sessionResult, existing);
    } else {
      // INSERT new profile
      const overallScore = Object.values(sessionResult.avgScores).reduce((a, b) => a + b, 0) / 5;
      await db.prepare(`
        INSERT INTO student_growth_profile
        (user_id, total_sessions, total_turns,
         elo_evidence, elo_reasoning, elo_defense, elo_clarity, elo_consistency,
         thought_profile_json, chronic_weaknesses, recent_session_scores, updated_at)
        VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      `).bind(
        userId,
        sessionResult.totalTurns,
        initialElo(sessionResult.avgScores.evidence),
        initialElo(sessionResult.avgScores.reasoning),
        initialElo(sessionResult.avgScores.defense),
        initialElo(sessionResult.avgScores.clarity),
        initialElo(sessionResult.avgScores.consistency),
        JSON.stringify(sessionResult.thoughtProfile),
        JSON.stringify(sessionResult.weaknessPatterns.map(p => ({ pattern: p, count: 1, lastSeen: new Date().toISOString() }))),
        JSON.stringify([{ score: overallScore, date: new Date().toISOString() }]),
        Date.now(),
      ).run();

      // First session milestone
      await detectAndRecordMilestones(db, userId, sessionResult, null);
    }
  } catch (e) {
    console.warn('[GROWTH_TRACKER] Non-critical error:', e);
  }
}

// =============================================
// Milestone Detection
// =============================================
async function detectAndRecordMilestones(
  db: D1Database,
  userId: string,
  sessionResult: SessionResult,
  previousProfile: StudentGrowthProfileRow | null,
): Promise<void> {
  const milestones: { type: string; details: string }[] = [];

  // 첫 세션 완료
  if (!previousProfile) {
    milestones.push({ type: 'first_session', details: '첫 소크라테스 토론 세션 완료!' });
  }

  // 첫 revision 성공
  if (sessionResult.revisionSuccessCount > 0 && (!previousProfile || (previousProfile.total_sessions ?? 0) <= 1)) {
    milestones.push({ type: 'first_revision', details: '첫 주장 수정 성공!' });
  }

  // 텍스트 마스터 (evidence_use 평균 4.0+)
  if (sessionResult.avgScores.evidence >= 4.0) {
    milestones.push({ type: 'text_master', details: '텍스트 근거 활용 우수 달성' });
  }

  // 10세션 돌파
  if (previousProfile && previousProfile.total_sessions === 9) {
    milestones.push({ type: 'ten_sessions', details: '10세션 돌파!' });
  }

  // 최심층 레이어 도달 (assumption or worldview)
  if (sessionResult.maxLayerReached === 'assumption' || sessionResult.maxLayerReached === 'worldview') {
    milestones.push({ type: 'deep_layer', details: `가장 깊은 논증 레이어(${sessionResult.maxLayerReached}) 도달` });
  }

  // ELO 1200 돌파 (어느 역량이든)
  // PATCH-NEW-003: Use actual cumulative ELO values (not virtual session ELO)
  if (previousProfile) {
    const sessCount = previousProfile.total_sessions || 0;
    const newElos = [
      updateElo(previousProfile.elo_evidence || 1000, sessionResult.avgScores.evidence, BASE_K_FACTOR, sessCount),
      updateElo(previousProfile.elo_reasoning || 1000, sessionResult.avgScores.reasoning, BASE_K_FACTOR, sessCount),
      updateElo(previousProfile.elo_defense || 1000, sessionResult.avgScores.defense, BASE_K_FACTOR, sessCount),
    ];
    const prevElos = [
      previousProfile.elo_evidence || 1000,
      previousProfile.elo_reasoning || 1000,
      previousProfile.elo_defense || 1000,
    ];
    // Check if any new ELO crossed 1200 when previous was below
    for (let i = 0; i < newElos.length; i++) {
      if (newElos[i] >= 1200 && prevElos[i] < 1200) {
        milestones.push({ type: 'elo_1200', details: '역량 점수 1200 돌파!' });
        break;
      }
    }
  }

  for (const ms of milestones) {
    try {
      await db.prepare(`
        INSERT INTO growth_milestones (user_id, milestone_type, achieved_at, details)
        VALUES (?1, ?2, ?3, ?4)
      `).bind(userId, ms.type, Date.now(), ms.details).run();
    } catch (e) { console.error("[P1-004] Caught:", e);
      // Ignore duplicate milestones
    }
  }
}
