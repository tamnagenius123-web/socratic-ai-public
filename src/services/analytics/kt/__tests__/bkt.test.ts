/**
 * BKT (Bayesian Knowledge Tracing) Unit Tests
 * Test cases covering:
 * 1. Initial state with correct response
 * 2. Initial state with incorrect response
 * 3. High mastery (pKnow ≈ 1) with incorrect response
 * 4. Low mastery (pKnow ≈ 0) with correct response
 * 5. Degenerate parameter validation
 */

import { describe, it, expect } from 'vitest';
import {
  updateBKT,
  predictCorrect,
  createInitialBKTState,
  validateBKTParams,
  DEFAULT_BKT_PARAMS,
} from '../bkt';
import type { BKTState, BKTParams } from '../types';

describe('BKT (Bayesian Knowledge Tracing)', () => {
  // Test Case 1: Initial state p(L₀) = 0.30 + correct answer
  // Expected: pKnow should rise (posterior rises + transition)
  it('TC1: Initial pKnow=0.30 + correct → pKnow increases', () => {
    const initialState: BKTState = {
      userId: 'user1',
      skillId: 'skill_algebra_1',
      pKnow: 0.30,
      n: 0,
      lastUpdateAt: Date.now(),
    };

    const updated = updateBKT(
      initialState,
      true,
      DEFAULT_BKT_PARAMS
    );

    // Posterior when correct:
    // p(L|correct) = 0.30 × (1 - 0.10) / [0.30 × 0.90 + 0.70 × 0.20]
    //              = 0.27 / [0.27 + 0.14]
    //              = 0.27 / 0.41 ≈ 0.6585
    // Then: p(L_n) = 0.6585 + (1 - 0.6585) × 0.10
    //              = 0.6585 + 0.03415 ≈ 0.693
    const expectedPosterior = 0.27 / (0.27 + 0.14); // ≈ 0.6585
    const expectedPLn =
      expectedPosterior + (1 - expectedPosterior) * 0.10;

    expect(updated.pKnow).toBeCloseTo(expectedPLn, 3);
    expect(updated.n).toBe(1);
    expect(updated.pKnow).toBeGreaterThan(0.30); // Should rise
    expect(updated.pKnow).toBeLessThan(1.0);
  });

  // Test Case 2: Initial state p(L₀) = 0.30 + incorrect answer
  // Expected: pKnow should fall (posterior falls + transition)
  it('TC2: Initial pKnow=0.30 + incorrect → pKnow decreases', () => {
    const initialState: BKTState = {
      userId: 'user2',
      skillId: 'skill_algebra_1',
      pKnow: 0.30,
      n: 0,
      lastUpdateAt: Date.now(),
    };

    const updated = updateBKT(
      initialState,
      false,
      DEFAULT_BKT_PARAMS
    );

    // Posterior when incorrect:
    // p(L|incorrect) = 0.30 × 0.10 / [0.30 × 0.10 + 0.70 × (1 - 0.20)]
    //                = 0.03 / [0.03 + 0.56]
    //                = 0.03 / 0.59 ≈ 0.0508
    // Then: p(L_n) = 0.0508 + (1 - 0.0508) × 0.10
    //              ≈ 0.0508 + 0.0955 ≈ 0.1463
    const expectedPosterior = 0.03 / (0.03 + 0.56); // ≈ 0.0508
    const expectedPLn =
      expectedPosterior + (1 - expectedPosterior) * 0.10;

    expect(updated.pKnow).toBeCloseTo(expectedPLn, 3);
    expect(updated.n).toBe(1);
    expect(updated.pKnow).toBeLessThan(0.30); // Should fall
    expect(updated.pKnow).toBeGreaterThan(0.0);
  });

  // Test Case 3: High mastery pKnow=0.99 + incorrect answer
  // Expected: Weak decline due to slip probability (pS=0.10)
  it('TC3: High pKnow=0.99 + incorrect → weak decline (slip effect)', () => {
    const highMasteryState: BKTState = {
      userId: 'user3',
      skillId: 'skill_algebra_2',
      pKnow: 0.99,
      n: 50,
      lastUpdateAt: Date.now(),
    };

    const updated = updateBKT(
      highMasteryState,
      false,
      DEFAULT_BKT_PARAMS
    );

    // Posterior when incorrect (high prior):
    // p(L|incorrect) = 0.99 × 0.10 / [0.99 × 0.10 + 0.01 × 0.80]
    //                = 0.099 / [0.099 + 0.008]
    //                = 0.099 / 0.107 ≈ 0.9252
    const expectedPosterior = 0.099 / 0.107; // ≈ 0.9252
    const expectedPLn =
      expectedPosterior + (1 - expectedPosterior) * 0.10;

    expect(updated.pKnow).toBeCloseTo(expectedPLn, 3);
    expect(updated.pKnow).toBeLessThan(0.99); // Declined
    expect(updated.pKnow).toBeGreaterThan(0.90); // But only slightly
  });

  // Test Case 4: Low mastery pKnow=0.01 + correct answer
  // Expected: Weak increase due to guess probability (pG=0.20)
  it('TC4: Low pKnow=0.01 + correct → weak rise (guess effect)', () => {
    const lowMasteryState: BKTState = {
      userId: 'user4',
      skillId: 'skill_algebra_3',
      pKnow: 0.01,
      n: 5,
      lastUpdateAt: Date.now(),
    };

    const updated = updateBKT(
      lowMasteryState,
      true,
      DEFAULT_BKT_PARAMS
    );

    // Posterior when correct (low prior):
    // p(L|correct) = 0.01 × 0.90 / [0.01 × 0.90 + 0.99 × 0.20]
    //              = 0.009 / [0.009 + 0.198]
    //              = 0.009 / 0.207 ≈ 0.0435
    const expectedPosterior = 0.009 / 0.207; // ≈ 0.0435
    const expectedPLn =
      expectedPosterior + (1 - expectedPosterior) * 0.10;

    expect(updated.pKnow).toBeCloseTo(expectedPLn, 3);
    expect(updated.pKnow).toBeGreaterThan(0.01); // Slightly increased
    expect(updated.pKnow).toBeLessThan(0.15); // But not much
  });

  // Test Case 5: Degenerate parameter validation
  // p(G) + p(S) >= 1.0 should throw error
  it('TC5: pG + pS >= 1.0 → throws degenerate error', () => {
    const testState: BKTState = {
      userId: 'user5',
      skillId: 'skill_test',
      pKnow: 0.5,
      n: 0,
      lastUpdateAt: Date.now(),
    };

    const degenerateParams: BKTParams = {
      pL0: 0.30,
      pT: 0.10,
      pG: 0.60, // 0.60 + 0.50 = 1.10 >= 1.0
      pS: 0.50,
    };

    expect(() => updateBKT(testState, true, degenerateParams)).toThrow(
      /BKT degenerate/
    );
  });

  // Additional: Test probability clipping [0.0001, 0.9999]
  it('Clipping: Extreme values clipped to valid range', () => {
    const state: BKTState = {
      userId: 'user6',
      skillId: 'skill_clip',
      pKnow: 0.9999,
      n: 100,
      lastUpdateAt: Date.now(),
    };

    // Many correct answers should not exceed 0.9999
    let current = state;
    for (let i = 0; i < 20; i++) {
      current = updateBKT(current, true, DEFAULT_BKT_PARAMS);
    }

    expect(current.pKnow).toBeLessThanOrEqual(0.9999);
    expect(current.pKnow).toBeGreaterThanOrEqual(0.0001);
  });

  // Test: predictCorrect function
  it('Predict: Predict probability of correct response', () => {
    const state: BKTState = {
      userId: 'user7',
      skillId: 'skill_predict',
      pKnow: 0.5,
      n: 10,
      lastUpdateAt: Date.now(),
    };

    const pCorrect = predictCorrect(state, DEFAULT_BKT_PARAMS);
    // P(correct) = 0.5 × (1 - 0.10) + (1 - 0.5) × 0.20
    //            = 0.5 × 0.90 + 0.5 × 0.20
    //            = 0.45 + 0.10
    //            = 0.55
    expect(pCorrect).toBeCloseTo(0.55, 3);
    expect(pCorrect).toBeGreaterThan(0);
    expect(pCorrect).toBeLessThan(1);
  });

  // Test: createInitialBKTState
  it('Initial: Create initial BKT state', () => {
    const state = createInitialBKTState('user8', 'skill_new');
    expect(state.userId).toBe('user8');
    expect(state.skillId).toBe('skill_new');
    expect(state.pKnow).toBe(0.30); // DEFAULT p(L0)
    expect(state.n).toBe(0);
    expect(state.lastUpdateAt).toBeTruthy();
  });

  // Test: validateBKTParams directly
  it('Validate: Valid params pass, invalid params throw', () => {
    const validParams: BKTParams = {
      pL0: 0.30,
      pT: 0.10,
      pG: 0.20,
      pS: 0.10,
    };
    expect(() => validateBKTParams(validParams)).not.toThrow();

    const invalidParams: BKTParams = {
      pL0: 0.30,
      pT: 0.10,
      pG: 0.55,
      pS: 0.55, // 0.55 + 0.55 = 1.10
    };
    expect(() => validateBKTParams(invalidParams)).toThrow();
  });
});
