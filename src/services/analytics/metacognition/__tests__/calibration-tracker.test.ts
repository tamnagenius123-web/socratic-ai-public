/**
 * Calibration Tracker Tests
 * Brier Score + Reliability Diagram validation
 * v35 Feature: T1.5.2 Metacognition Widget
 */

import { describe, it, expect } from 'vitest';
import {
  computeBrierScore,
  computeCalibrationCurve,
  classifyCalibrationQuality,
  detectMiscalibrationType,
  type CalibrationRecord,
} from '../calibration-tracker';

describe('Brier Score', () => {
  // Test 1: Perfect predictions
  it('should return 0 for perfect predictions', () => {
    const records: CalibrationRecord[] = [
      {
        userId: 'user1',
        sessionId: 'sess1',
        confidence: 0.9,
        correct: 1,
        calibrationError: 0.1,
        recordedAt: Date.now(),
      },
      {
        userId: 'user1',
        sessionId: 'sess1',
        confidence: 0.1,
        correct: 0,
        calibrationError: 0.1,
        recordedAt: Date.now(),
      },
    ];

    const score = computeBrierScore(records);
    expect(score).toBeLessThan(0.01);
  });

  // Test 2: Worst case (maximally miscalibrated)
  it('should return 1 for completely wrong predictions', () => {
    const records: CalibrationRecord[] = [
      {
        userId: 'user1',
        sessionId: 'sess1',
        confidence: 1.0,
        correct: 0,
        calibrationError: 1.0,
        recordedAt: Date.now(),
      },
      {
        userId: 'user1',
        sessionId: 'sess1',
        confidence: 0.0,
        correct: 1,
        calibrationError: 1.0,
        recordedAt: Date.now(),
      },
    ];

    const score = computeBrierScore(records);
    expect(score).toBeCloseTo(1.0, 2);
  });

  // Test 3: Typical case
  it('should compute Brier Score correctly (typical range)', () => {
    const records: CalibrationRecord[] = [
      {
        userId: 'user1',
        sessionId: 'sess1',
        confidence: 0.8,
        correct: 1,
        calibrationError: 0.2,
        recordedAt: Date.now(),
      },
      {
        userId: 'user1',
        sessionId: 'sess1',
        confidence: 0.7,
        correct: 0,
        calibrationError: 0.7,
        recordedAt: Date.now(),
      },
      {
        userId: 'user1',
        sessionId: 'sess1',
        confidence: 0.5,
        correct: 1,
        calibrationError: 0.5,
        recordedAt: Date.now(),
      },
    ];

    const score = computeBrierScore(records);
    // BS = (0.2² + 0.7² + 0.5²) / 3 = (0.04 + 0.49 + 0.25) / 3 = 0.78 / 3 ≈ 0.26
    expect(score).toBeCloseTo(0.26, 1);
  });
});

describe('Reliability Diagram (10-bin Calibration Curve)', () => {
  // Test 1: Basic structure
  it('should return 10 bins with correct structure', () => {
    const records: CalibrationRecord[] = Array.from({ length: 50 }, (_, i) => ({
      userId: 'user1',
      sessionId: 'sess1',
      confidence: Math.random(),
      correct: Math.random() > 0.5 ? 1 : 0,
      calibrationError: Math.abs(Math.random() - (Math.random() > 0.5 ? 1 : 0)),
      recordedAt: Date.now(),
    }));

    const curve = computeCalibrationCurve(records, 10);
    expect(curve).toHaveLength(10);
    expect(curve[0].bin).toBe(0);
    expect(curve[9].bin).toBe(9);
    expect(curve.every((b) => b.count >= 0)).toBe(true);
  });

  // Test 2: Correct binning
  it('should bin records correctly by confidence', () => {
    const records: CalibrationRecord[] = [
      {
        userId: 'user1',
        sessionId: 'sess1',
        confidence: 0.05, // bin 0
        correct: 1,
        calibrationError: 0.95,
        recordedAt: Date.now(),
      },
      {
        userId: 'user1',
        sessionId: 'sess1',
        confidence: 0.55, // bin 5
        correct: 0,
        calibrationError: 0.55,
        recordedAt: Date.now(),
      },
      {
        userId: 'user1',
        sessionId: 'sess1',
        confidence: 0.95, // bin 9
        correct: 1,
        calibrationError: 0.05,
        recordedAt: Date.now(),
      },
    ];

    const curve = computeCalibrationCurve(records, 10);

    // Check bin 0: average confidence ≈ 0.05
    expect(curve[0].count).toBe(1);
    expect(curve[0].predicted).toBeCloseTo(0.05, 1);
    expect(curve[0].actual).toBeCloseTo(1.0, 1);

    // Check bin 5: average confidence ≈ 0.55
    expect(curve[5].count).toBe(1);
    expect(curve[5].predicted).toBeCloseTo(0.55, 1);
    expect(curve[5].actual).toBeCloseTo(0.0, 1);

    // Check bin 9: average confidence ≈ 0.95
    expect(curve[9].count).toBe(1);
    expect(curve[9].predicted).toBeCloseTo(0.95, 1);
    expect(curve[9].actual).toBeCloseTo(1.0, 1);
  });

  // Test 3: Edge case — confidence = 1.0 should go to bin 9
  it('should handle confidence = 1.0 correctly (bin 9)', () => {
    const records: CalibrationRecord[] = [
      {
        userId: 'user1',
        sessionId: 'sess1',
        confidence: 1.0,
        correct: 1,
        calibrationError: 0.0,
        recordedAt: Date.now(),
      },
    ];

    const curve = computeCalibrationCurve(records, 10);
    expect(curve[9].count).toBe(1);
    expect(curve[9].actual).toBeCloseTo(1.0, 1);
  });
});

describe('Calibration Quality Classification', () => {
  it('should classify Brier Score correctly', () => {
    expect(classifyCalibrationQuality(0.05)).toBe('excellent');
    expect(classifyCalibrationQuality(0.15)).toBe('good');
    expect(classifyCalibrationQuality(0.25)).toBe('fair');
    expect(classifyCalibrationQuality(0.35)).toBe('poor');
  });
});

describe('Miscalibration Type Detection', () => {
  it('should detect overconfident pattern', () => {
    const curve = [
      { bin: 0, predicted: 0.2, actual: 0.1, count: 10 },
      { bin: 1, predicted: 0.3, actual: 0.15, count: 10 },
      { bin: 2, predicted: 0.4, actual: 0.25, count: 10 },
    ];

    const type = detectMiscalibrationType(curve);
    expect(type).toBe('overconfident');
  });

  it('should detect underconfident pattern', () => {
    const curve = [
      { bin: 0, predicted: 0.2, actual: 0.4, count: 10 },
      { bin: 1, predicted: 0.3, actual: 0.5, count: 10 },
      { bin: 2, predicted: 0.4, actual: 0.6, count: 10 },
    ];

    const type = detectMiscalibrationType(curve);
    expect(type).toBe('underconfident');
  });

  it('should detect well-calibrated pattern', () => {
    const curve = [
      { bin: 0, predicted: 0.2, actual: 0.2, count: 10 },
      { bin: 1, predicted: 0.3, actual: 0.3, count: 10 },
      { bin: 2, predicted: 0.4, actual: 0.4, count: 10 },
    ];

    const type = detectMiscalibrationType(curve);
    expect(type).toBe('well-calibrated');
  });

  it('should ignore bins with insufficient samples', () => {
    const curve = [
      { bin: 0, predicted: 0.2, actual: 0.1, count: 2 }, // Too few
      { bin: 1, predicted: 0.3, actual: 0.3, count: 10 }, // Reliable
      { bin: 2, predicted: 0.4, actual: 0.4, count: 10 }, // Reliable
    ];

    const type = detectMiscalibrationType(curve);
    // Should be well-calibrated based on reliable bins only
    expect(type).toBe('well-calibrated');
  });
});
