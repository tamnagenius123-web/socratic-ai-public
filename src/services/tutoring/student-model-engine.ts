// D-Plan: Student Model Engine
// Tracks student thinking patterns cumulatively across turns

import type {
  StudentModel,
  DeepEvaluation,
  TutorAction,
  WeaknessTag,
  HintLadderLevel,
} from './types';

// =============================================
// Create Initial Student Model
// =============================================
export function createStudentModel(
  sessionId: string,
  topic: string,
  sessionGoal: string = '핵심 주장을 명확하게 표현하기',
): StudentModel {
  return {
    sessionId,
    topic,
    sessionGoal,
    currentClaim: '',
    evidenceUsed: [],
    referencedChunkIds: [],
    reasoningStrength: 2,
    consistencyRisk: 0,
    relevanceLevel: 3,
    helpLevel: 0,
    weaknessPatterns: [],
    repeatedWeaknessCounts: {},
    lastTutorAction: null,
    lastDiagnosis: '',
    revisionCount: 0,
    evidenceUsageCount: 0,
    offTopicCount: 0,
    contradictionCount: 0,
    progressNotes: [],
    updatedAt: new Date().toISOString(),
  };
}

// =============================================
// Update Student Model After Evaluation
// =============================================
export function updateStudentModel(
  model: StudentModel,
  evaluation: DeepEvaluation,
  tutorAction: TutorAction,
  context: { reviewingLearnerRevision: boolean } = { reviewingLearnerRevision: false },
): StudentModel {
  const updated = { ...model };
  updated.updatedAt = new Date().toISOString();

  // --- Claim Update ---
  if (evaluation.claim && evaluation.claim.length > 0) {
    // Evaluator wording is a hypothesis, not evidence of a learner revision.
    updated.currentClaim = evaluation.claim;
  }

  // --- Evidence Update ---
  if (evaluation.evidence_detected && evaluation.evidence_detected.length > 0) {
    for (const ev of evaluation.evidence_detected) {
      if (!updated.evidenceUsed.includes(ev)) {
        updated.evidenceUsed.push(ev);
      }
    }
    updated.evidenceUsageCount++;
  }

  // --- Score Updates (running blend: 40% old + 60% new) ---
  updated.reasoningStrength = blendScore(
    updated.reasoningStrength,
    evaluation.reasoning_strength,
  );
  updated.relevanceLevel = blendScore(
    updated.relevanceLevel,
    evaluation.relevance,
  );

  // --- Consistency Risk ---
  if (evaluation.consistency <= 2) {
    updated.consistencyRisk = Math.min(5, updated.consistencyRisk + 1);
    if (evaluation.weakness_tags.includes('모순 발생')) {
      updated.contradictionCount++;
    }
  } else if (evaluation.consistency >= 4) {
    updated.consistencyRisk = Math.max(0, updated.consistencyRisk - 1);
  }

  // --- Off-topic tracking ---
  if (evaluation.relevance <= 2) {
    updated.offTopicCount++;
  }

  // --- Weakness Pattern Accumulation ---
  const currentWeaknessPatterns: WeaknessTag[] = [];
  for (const tag of evaluation.weakness_tags) {
    const count = (updated.repeatedWeaknessCounts[tag] || 0) + 1;
    updated.repeatedWeaknessCounts[tag] = count;
    currentWeaknessPatterns.push(tag);
  }
  // Keep only recent high-frequency weaknesses (appeared 2+ times)
  updated.weaknessPatterns = Object.entries(updated.repeatedWeaknessCounts)
    .filter(([, count]) => count >= 2)
    .map(([tag]) => tag as WeaknessTag);

  // --- Help Level Adjustment ---
  updated.helpLevel = calculateHelpLevel(updated, evaluation, context.reviewingLearnerRevision);

  // --- Tutor Action ---
  updated.lastTutorAction = tutorAction;
  updated.lastDiagnosis = evaluation.diagnosis;

  // --- Session Goal Update (based on state progression) ---
  // This will be set by the state machine externally

  return updated;
}

// =============================================
// Help Level Calculation
// =============================================
function calculateHelpLevel(
  model: StudentModel,
  evaluation: DeepEvaluation,
  reviewingLearnerRevision: boolean,
): HintLadderLevel {
  let level = model.helpLevel;

  // Same weakness repeated twice -> level up
  for (const tag of evaluation.weakness_tags) {
    if ((model.repeatedWeaknessCounts[tag] || 0) >= 2) {
      level = Math.min(5, level + 1) as HintLadderLevel;
      break; // Only escalate once per turn
    }
  }

  // Provisional support adjustment for a current explicit correction under review.
  // The canonical accepted batch persists it; it is not a learning-success verdict.
  if (
    reviewingLearnerRevision &&
    evaluation.claim_clarity >= 4 &&
    evaluation.evidence_use >= 3 &&
    evaluation.reasoning_strength >= 3
  ) {
    level = Math.max(0, level - 1) as HintLadderLevel;
  }

  // Safety: first 2 turns max H2
  // (checked externally by hint ladder)

  return level as HintLadderLevel;
}

// =============================================
// Helpers
// =============================================
function blendScore(old: number, newVal: number): number {
  return Math.round((old * 0.4 + newVal * 0.6) * 10) / 10;
}

// Get high-priority weakness (most repeated)
export function getHighPriorityWeakness(
  model: StudentModel,
): WeaknessTag | null {
  const entries = Object.entries(model.repeatedWeaknessCounts);
  if (entries.length === 0) return null;

  const sorted = entries.sort((a, b) => b[1] - a[1]);
  return sorted[0][1] >= 2 ? (sorted[0][0] as WeaknessTag) : null;
}

// Serialize for DB storage
export function serializeStudentModel(model: StudentModel): string {
  return JSON.stringify(model);
}

// Deserialize from DB
export function deserializeStudentModel(json: string): StudentModel {
  return JSON.parse(json) as StudentModel;
}
