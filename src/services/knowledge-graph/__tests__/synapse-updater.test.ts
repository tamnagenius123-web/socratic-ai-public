import { describe, it, expect } from 'vitest';
import {
  computeSpeedSignal,
  computeCounterComponent,
  normalizeSignals,
  updateSynapseWeight,
  computeEMAWeight,
  SynapseSignals,
} from '../synapse-updater';

describe('SynapseUpdater - Speed Signal Computation', () => {
  it('should return ~0.5 for 15 seconds (baseline)', () => {
    const signal = computeSpeedSignal(15000);
    expect(signal).toBeCloseTo(0.5, 1); // 약 0.5
  });

  it('should return high signal for fast answers (5 seconds)', () => {
    const signal = computeSpeedSignal(5000);
    expect(signal).toBeGreaterThan(0.85);
  });

  it('should return low signal for slow answers (25 seconds)', () => {
    const signal = computeSpeedSignal(25000);
    expect(signal).toBeLessThan(0.15);
  });

  it('should be bounded between 0 and 1', () => {
    expect(computeSpeedSignal(0)).toBeGreaterThanOrEqual(0.99);
    expect(computeSpeedSignal(60000)).toBeLessThanOrEqual(0.01);
  });
});

describe('SynapseUpdater - Counter Question Depth', () => {
  it('should map 0 depth to 0.0', () => {
    const result = computeCounterComponent(0);
    expect(result).toBe(0);
  });

  it('should map 3 depth to 1.0', () => {
    const result = computeCounterComponent(3);
    expect(result).toBe(1);
  });

  it('should map 1.5 depth to 0.5', () => {
    const result = computeCounterComponent(1.5);
    expect(result).toBe(0.5);
  });

  it('should clamp negative values to 0', () => {
    const result = computeCounterComponent(-1);
    expect(result).toBe(0);
  });

  it('should clamp values > 3 to 1.0', () => {
    const result = computeCounterComponent(5);
    expect(result).toBe(1);
  });
});

describe('SynapseUpdater - Signal Normalization', () => {
  it('should average three components with weights 0.3, 0.4, 0.3', () => {
    const result = normalizeSignals(1.0, 1.0, 1.0);
    expect(result).toBeCloseTo(1.0, 5);
  });

  it('should handle mixed signals correctly', () => {
    // speed: 0.6 * 0.3 = 0.18
    // metaphor: 0.8 * 0.4 = 0.32
    // counter: 0.4 * 0.3 = 0.12
    // total: 0.62
    const result = normalizeSignals(0.6, 0.8, 0.4);
    expect(result).toBeCloseTo(0.62, 5);
  });

  it('should be bounded between 0 and 1', () => {
    expect(normalizeSignals(0, 0, 0)).toBe(0);
    expect(normalizeSignals(1, 1, 1)).toBeCloseTo(1, 5);
  });
});

describe('SynapseUpdater - Full Weight Update', () => {
  it('should compute all signal components', () => {
    const signals: SynapseSignals = {
      answerSpeedMs: 10000,
      metaphorDensity: 0.7,
      counterQuestionDepth: 2,
    };

    const result = updateSynapseWeight(0.5, signals);

    expect(result.speedComponent).toBeGreaterThan(0.5);
    expect(result.metaphorComponent).toBe(0.7);
    expect(result.counterComponent).toBeCloseTo(0.667, 2);
    expect(result.normalizedSignal).toBeGreaterThan(0.6);
  });

  it('should compute EMA weight correctly', () => {
    // old_weight * 0.7 + signal * 0.3
    const oldWeight = 0.5;
    const signal = 0.8;
    const newWeight = computeEMAWeight(oldWeight, signal);
    const expected = 0.5 * 0.7 + 0.8 * 0.3;
    expect(newWeight).toBeCloseTo(expected, 5);
  });
});

describe('SynapseUpdater - Integration Test (Full EMA Pipeline)', () => {
  it('should increase weight when signal is strong (fast answer + high metaphor)', () => {
    const signals: SynapseSignals = {
      answerSpeedMs: 5000,     // Fast → ~0.9
      metaphorDensity: 0.9,    // High
      counterQuestionDepth: 2.5, // Medium-high
    };

    const signalResult = updateSynapseWeight(0.5, signals);
    const newWeight = computeEMAWeight(0.5, signalResult.normalizedSignal);

    expect(newWeight).toBeGreaterThan(0.5);
  });

  it('should decrease weight when signal is weak (slow answer + low metaphor)', () => {
    const signals: SynapseSignals = {
      answerSpeedMs: 30000,    // Slow → ~0.1
      metaphorDensity: 0.2,    // Low
      counterQuestionDepth: 0,  // None
    };

    const signalResult = updateSynapseWeight(0.5, signals);
    const newWeight = computeEMAWeight(0.5, signalResult.normalizedSignal);

    expect(newWeight).toBeLessThan(0.5);
  });

  it('should converge around 0.5 for balanced signals', () => {
    const signals: SynapseSignals = {
      answerSpeedMs: 15000,    // Neutral → ~0.5
      metaphorDensity: 0.5,    // Neutral
      counterQuestionDepth: 1.5, // Neutral
    };

    const signalResult = updateSynapseWeight(0.5, signals);
    const newWeight = computeEMAWeight(0.5, signalResult.normalizedSignal);

    // Should be close to 0.5
    expect(newWeight).toBeCloseTo(0.5, 0);
  });

  it('should remain within bounds [0, 1] after multiple updates', () => {
    let weight = 0.5;

    const testCases: SynapseSignals[] = [
      {
        answerSpeedMs: 3000,
        metaphorDensity: 1.0,
        counterQuestionDepth: 3,
      },
      {
        answerSpeedMs: 40000,
        metaphorDensity: 0.0,
        counterQuestionDepth: 0,
      },
      {
        answerSpeedMs: 15000,
        metaphorDensity: 0.5,
        counterQuestionDepth: 1.5,
      },
    ];

    for (const signals of testCases) {
      const signalResult = updateSynapseWeight(weight, signals);
      weight = computeEMAWeight(weight, signalResult.normalizedSignal);
      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThanOrEqual(1);
    }
  });
});
