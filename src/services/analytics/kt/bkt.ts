/**
 * Bayesian Knowledge Tracing (BKT) Implementation
 * Reference: Corbett & Anderson 1995, Equation 1 (p.261)
 *
 * Core formula:
 * p(L_n) = p(L_{n-1} | evidence) + (1 - p(L_{n-1} | evidence)) × p(T)
 *
 * Where:
 * - p(L_{n-1} | evidence) is the posterior probability after observing response
 * - evidence is either "correct" or "incorrect"
 * - p(T) is the acquisition/transition probability
 */

import type { BKTParams, BKTState } from './types';

export const DEFAULT_BKT_PARAMS: BKTParams = {
  pL0: 0.30, // Initial knowledge probability
  pT: 0.10, // Acquisition/transition probability
  pG: 0.20, // Guess probability
  pS: 0.10, // Slip probability
};

/**
 * Validate BKT parameters for degeneracy
 * Throws error if p(G) + p(S) >= 1.0 (identifiability problem)
 */
export function validateBKTParams(params: BKTParams): void {
  if (params.pG + params.pS >= 1.0) {
    throw new Error(
      `BKT degenerate: pG(${params.pG}) + pS(${params.pS}) >= 1.0. This causes identifiability issues.`
    );
  }
}

/**
 * Compute posterior probability given evidence using Bayes' theorem
 * @param prior Prior probability p(L_{n-1})
 * @param correct Whether the response was correct
 * @param params BKT parameters
 * @returns Posterior probability p(L_{n-1} | evidence)
 */
function computePosterior(
  prior: number,
  correct: boolean,
  params: BKTParams
): number {
  if (correct) {
    // p(L_{n-1} | correct) = p(L_{n-1}) × (1 - p(S))
    //                        ──────────────────────────────────────────
    //                        p(L_{n-1}) × (1 - p(S)) + (1 - p(L_{n-1})) × p(G)
    const numerator = prior * (1 - params.pS);
    const denominator =
      numerator + (1 - prior) * params.pG;
    return denominator > 0 ? numerator / denominator : prior;
  } else {
    // p(L_{n-1} | incorrect) = p(L_{n-1}) × p(S)
    //                          ─────────────────────────────────────────
    //                          p(L_{n-1}) × p(S) + (1 - p(L_{n-1})) × (1 - p(G))
    const numerator = prior * params.pS;
    const denominator =
      numerator + (1 - prior) * (1 - params.pG);
    return denominator > 0 ? numerator / denominator : prior;
  }
}

/**
 * Clip probability to valid range [0.0001, 0.9999]
 * Prevents extreme values and numerical instability
 */
function clipProbability(value: number): number {
  return Math.min(0.9999, Math.max(0.0001, value));
}

/**
 * Update BKT state given student response
 * Implements Corbett & Anderson 1995, Eq.1
 *
 * @param state Current BKT state
 * @param correct Whether the student's response was correct
 * @param params BKT parameters (defaults provided)
 * @returns Updated BKT state
 * @throws Error if parameters are degenerate
 */
export function updateBKT(
  state: BKTState,
  correct: boolean,
  params: BKTParams = DEFAULT_BKT_PARAMS
): BKTState {
  // Validate parameters
  validateBKTParams(params);

  const prior = state.pKnow;

  // Step 1: Compute posterior probability given evidence
  const posterior = computePosterior(prior, correct, params);

  // Step 2: Apply acquisition transition
  // p(L_n) = posterior + (1 - posterior) × p(T)
  const pLn = posterior + (1 - posterior) * params.pT;

  // Step 3: Clip result to valid range
  const clippedPKnow = clipProbability(pLn);

  return {
    ...state,
    pKnow: clippedPKnow,
    n: state.n + 1,
    lastUpdateAt: Date.now(),
  };
}

/**
 * Predict probability of correct response for next attempt
 * Used for difficulty calibration and next question selection
 *
 * @param state Current BKT state
 * @param params BKT parameters
 * @returns Predicted probability of correct response [0, 1]
 */
export function predictCorrect(
  state: BKTState,
  params: BKTParams = DEFAULT_BKT_PARAMS
): number {
  // P(correct) = p(K) × (1 - p(S)) + (1 - p(K)) × p(G)
  // If student knows: (1 - slip) chance of correct
  // If student doesn't know: p(G) chance of correct (guessing)
  return (
    state.pKnow * (1 - params.pS) +
    (1 - state.pKnow) * params.pG
  );
}

/**
 * Create initial BKT state for a new skill
 * @param userId User identifier
 * @param skillId Skill identifier
 * @param pL0 Initial knowledge probability (defaults to 0.30)
 * @returns Initial BKT state
 */
export function createInitialBKTState(
  userId: string,
  skillId: string,
  pL0: number = DEFAULT_BKT_PARAMS.pL0
): BKTState {
  return {
    userId,
    skillId,
    pKnow: pL0,
    n: 0,
    lastUpdateAt: Date.now(),
  };
}
