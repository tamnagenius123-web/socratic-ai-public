// D-Plan: Tutoring State Machine
// Controls session flow through pedagogical states
// States: elicitation → grounding → reasoning → counterexample → revision → synthesis → completed

import type {
  TutorState,
  DeepEvaluation,
  StudentModel,
  HintLadderLevel,
} from './types';
import { SESSION_GOALS } from './types';

// =============================================
// State Transition Function
// =============================================
export function nextState(input: {
  currentState: TutorState;
  scores: {
    claim_clarity: number;
    evidence_use: number;
    reasoning_strength: number;
    consistency: number;
    relevance: number;
  };
  repeatedWeaknessCounts: Record<string, number>;
  /** Legacy input retained for compatibility; never a learning-success gate. */
  revisionCount?: number;
  turnNumber: number;
  maxTurns: number;
}): TutorState {
  const { currentState: s, scores: sc, turnNumber, maxTurns } = input;

  // Force completion if at max turns
  if (turnNumber >= maxTurns) {
    return 'completed';
  }

  // Force synthesis in last 2 turns
  if (turnNumber >= maxTurns - 1 && s !== 'synthesis' && s !== 'completed') {
    return 'synthesis';
  }

  switch (s) {
    case 'elicitation':
      // Move to grounding when claim is clear enough
      if (sc.claim_clarity >= 3) return 'grounding';
      // Stay in elicitation if claim unclear (give them another chance)
      if (sc.claim_clarity >= 2 && turnNumber >= 2) return 'grounding';
      return 'elicitation';

    case 'grounding':
      // Move to reasoning when evidence is sufficient
      if (sc.evidence_use >= 3) return 'reasoning';
      // If stuck too long in grounding with repeated failure, stay but with hints
      if (turnNumber >= 4 && sc.evidence_use >= 2) return 'reasoning';
      return 'grounding';

    case 'reasoning':
      // Strong reasoning + consistency → counterexample
      if (sc.reasoning_strength >= 3 && sc.consistency >= 3) return 'counterexample';
      // Weak reasoning → revision
      if (sc.reasoning_strength <= 2 || sc.consistency <= 2) return 'revision';
      return 'reasoning';

    case 'counterexample':
      // Handles counterexample well → synthesis
      if (sc.reasoning_strength >= 4 && sc.consistency >= 4) return 'synthesis';
      // Struggles with counterexample → revision
      return 'revision';

    case 'revision':
      // Improved after revision → synthesis
      if (
        sc.claim_clarity >= 3 &&
        sc.evidence_use >= 3 &&
        sc.reasoning_strength >= 3
      ) {
        return 'synthesis';
      }
      // Revision attempts cannot bypass missing claim or evidence criteria.
      return 'revision';

    case 'synthesis':
      return 'completed';

    case 'completed':
      return 'completed';

    default:
      return 'completed';
  }
}

// =============================================
// Get Session Goal for Current State
// =============================================
export function getSessionGoal(state: TutorState): string {
  return SESSION_GOALS[state] || '논의를 정리합니다';
}

// =============================================
// Map TutorState to legacy Phase for backward compatibility
// =============================================
export function tutorStateToPhase(
  state: TutorState,
): 'thesis' | 'opening' | 'defense' | 'synthesis' | 'conclusion' {
  switch (state) {
    case 'elicitation':
      return 'thesis';
    case 'grounding':
      return 'opening';
    case 'reasoning':
    case 'counterexample':
      return 'defense';
    case 'revision':
      return 'synthesis';
    case 'synthesis':
    case 'completed':
      return 'conclusion';
    default:
      return 'thesis';
  }
}

// =============================================
// Map legacy Phase to TutorState
// =============================================
export function phaseToTutorState(
  phase: string,
  turnNumber: number,
): TutorState {
  switch (phase) {
    case 'thesis':
      return 'elicitation';
    case 'opening':
      return 'grounding';
    case 'defense':
      return turnNumber >= 6 ? 'counterexample' : 'reasoning';
    case 'synthesis':
      return 'revision';
    case 'conclusion':
      return 'synthesis';
    default:
      return 'elicitation';
  }
}

// =============================================
// Check if session should end
// =============================================
export function shouldEndSession(
  state: TutorState,
  turnNumber: number,
  maxTurns: number,
): boolean {
  return state === 'completed' || turnNumber > maxTurns;
}
