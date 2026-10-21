import type { ThoughtProfile } from './thought-profiler';
import type { ChallengeState, ChallengeLevel } from './challenge-engine';

export class SavedIntelligenceError extends Error {
  constructor() { super('SAVED_LEARNING_STATE_UNAVAILABLE'); }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function unit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function level(value: unknown): value is ChallengeLevel {
  return value === 1 || value === 2 || value === 3 || value === 4;
}
function optionalRecord(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new SavedIntelligenceError(); }
  if (value === null || (object(value) && Object.keys(value).length === 0)) return undefined;
  if (!object(value)) throw new SavedIntelligenceError();
  return value;
}

/** Legacy empty state is absent; damaged populated state must not silently reset. */
export function readSavedIntelligence(thoughtJson: string | null | undefined, challengeJson: string | null | undefined): {
  thoughtProfile?: ThoughtProfile; challengeState?: ChallengeState;
} {
  const thought = optionalRecord(thoughtJson);
  const challenge = optionalRecord(challengeJson);
  let thoughtProfile: ThoughtProfile | undefined;
  let challengeState: ChallengeState | undefined;
  if (thought) {
    const { absolutistTendency, binaryThinking, definitionalVagueness, intuitionOverText, lastUpdatedTurn, sampleSize } = thought;
    if (!unit(absolutistTendency) || !unit(binaryThinking) || !unit(definitionalVagueness)
      || !unit(intuitionOverText) || !count(lastUpdatedTurn) || !count(sampleSize)) throw new SavedIntelligenceError();
    thoughtProfile = { absolutistTendency, binaryThinking, definitionalVagueness, intuitionOverText, lastUpdatedTurn, sampleSize };
  }
  if (challenge) {
    const { currentLevel, history, consecutiveSuccess, consecutiveStruggle } = challenge;
    if (!level(currentLevel) || !Array.isArray(history) || !count(consecutiveSuccess) || !count(consecutiveStruggle)) throw new SavedIntelligenceError();
    const checkedHistory = history.map((entry: unknown) => {
      if (!object(entry) || !count(entry.turn) || !level(entry.level) || typeof entry.reason !== 'string') throw new SavedIntelligenceError();
      return { turn: entry.turn, level: entry.level, reason: entry.reason };
    });
    challengeState = { currentLevel, history: checkedHistory, consecutiveSuccess, consecutiveStruggle };
  }
  return { thoughtProfile, challengeState };
}
