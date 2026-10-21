/**
 * Unit tests for Flow Index Collector
 */

import { describe, it, expect } from '@jest/globals';
import {
  computeFlowIndex,
  computeLatencyVariance,
  computeAccuracyMA,
  normalizeLatencyVariance,
  aggregateSession,
  FlowIndexInput,
} from '../flow-index';

describe('Flow Index Collector', () => {
  describe('computeLatencyVariance', () => {
    it('should compute variance correctly', () => {
      const latencies = [1000, 1000, 1000]; // all same
      const variance = computeLatencyVariance(latencies);
      expect(variance).toBe(0);
    });

    it('should detect variability', () => {
      const latencies = [500, 1000, 1500]; // high variance
      const variance = computeLatencyVariance(latencies);
      expect(variance).toBeGreaterThan(0);
    });

    it('should handle insufficient data', () => {
      expect(computeLatencyVariance([])).toBe(0);
      expect(computeLatencyVariance([1000])).toBe(0);
    });

    it('should handle edge cases', () => {
      const latencies = [100, 100, 100, 5000, 100]; // with outlier
      const variance = computeLatencyVariance(latencies);
      expect(variance).toBeGreaterThan(0);
    });
  });

  describe('computeAccuracyMA', () => {
    it('should compute 5-turn moving average', () => {
      const accuracies = [0.5, 0.6, 0.7, 0.8, 0.9];
      const ma = computeAccuracyMA(accuracies, 5);
      expect(ma).toBeCloseTo(0.7);
    });

    it('should handle window smaller than data', () => {
      const accuracies = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
      const ma = computeAccuracyMA(accuracies, 3); // last 3 values
      expect(ma).toBeCloseTo((0.8 + 0.9 + 1.0) / 3);
    });

    it('should use entire array if window > length', () => {
      const accuracies = [0.5, 0.6, 0.7];
      const ma = computeAccuracyMA(accuracies, 10);
      expect(ma).toBeCloseTo((0.5 + 0.6 + 0.7) / 3);
    });

    it('should handle empty input', () => {
      expect(computeAccuracyMA([])).toBe(0);
    });
  });

  describe('normalizeLatencyVariance', () => {
    it('should return 1 for zero variance', () => {
      expect(normalizeLatencyVariance(0)).toBe(1);
    });

    it('should return <1 for positive variance', () => {
      expect(normalizeLatencyVariance(100)).toBeLessThan(1);
      expect(normalizeLatencyVariance(100)).toBeGreaterThan(0);
    });

    it('should cap at [0, 1]', () => {
      const result = normalizeLatencyVariance(100000);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    });
  });

  describe('computeFlowIndex', () => {
    it('should compute high flow state', () => {
      const input: FlowIndexInput = {
        linubReward: 0.9, // high reward
        responseLatencies: [2000, 2100, 2050], // consistent
        accuracies: [0.8, 0.85, 0.9], // improving accuracy
      };

      const result = computeFlowIndex(input);
      expect(result.flowScore).toBeGreaterThan(0.6);
      expect(result.flowState).toBe('high');
    });

    it('should compute low flow state', () => {
      const input: FlowIndexInput = {
        linubReward: 0.2, // low reward
        responseLatencies: [500, 3000, 1000], // inconsistent
        accuracies: [0.2, 0.1, 0.15], // low accuracy
      };

      const result = computeFlowIndex(input);
      expect(result.flowScore).toBeLessThan(0.4);
      expect(result.flowState).toBe('low');
    });

    it('should compute moderate flow state', () => {
      const input: FlowIndexInput = {
        linubReward: 0.5,
        responseLatencies: [2000, 2000, 2000],
        accuracies: [0.5, 0.5, 0.5],
      };

      const result = computeFlowIndex(input);
      expect(result.flowScore).toBeGreaterThanOrEqual(0.4);
      expect(result.flowScore).toBeLessThan(0.7);
      expect(result.flowState).toBe('moderate');
    });

    it('should weight components correctly', () => {
      const input: FlowIndexInput = {
        linubReward: 1.0, // 40% weight
        responseLatencies: [2000, 2000, 2000], // 30% weight
        accuracies: [1.0, 1.0, 1.0], // 30% weight
      };

      const result = computeFlowIndex(input);
      expect(result.flowScore).toBeCloseTo(1.0);
      expect(result.rewardComponent).toBeCloseTo(1.0);
      expect(result.latencyComponent).toBeCloseTo(1.0);
      expect(result.accuracyComponent).toBeCloseTo(1.0);
    });

    it('should handle missing data gracefully', () => {
      const input: FlowIndexInput = {
        linubReward: undefined as any,
        responseLatencies: [],
        accuracies: [],
      };

      const result = computeFlowIndex(input);
      expect(result.flowScore).toBeGreaterThanOrEqual(0);
      expect(result.flowScore).toBeLessThanOrEqual(1);
    });

    it('should clamp values to [0, 1]', () => {
      const input: FlowIndexInput = {
        linubReward: 1.5, // out of range
        responseLatencies: [-1000], // invalid
        accuracies: [2.0], // out of range
      };

      const result = computeFlowIndex(input);
      expect(result.flowScore).toBeGreaterThanOrEqual(0);
      expect(result.flowScore).toBeLessThanOrEqual(1);
    });
  });

  describe('aggregateSession', () => {
    it('should compute session statistics', () => {
      const results = [
        computeFlowIndex({
          linubReward: 0.5,
          responseLatencies: [2000],
          accuracies: [0.5],
        }),
        computeFlowIndex({
          linubReward: 0.6,
          responseLatencies: [2000],
          accuracies: [0.6],
        }),
        computeFlowIndex({
          linubReward: 0.7,
          responseLatencies: [2000],
          accuracies: [0.7],
        }),
      ];

      const agg = aggregateSession(results);
      expect(agg.avgFlowScore).toBeGreaterThan(0.4);
      expect(agg.maxFlowScore).toBeGreaterThan(agg.minFlowScore);
      expect(agg.highFlowTurns).toBeGreaterThanOrEqual(0);
    });

    it('should detect improving trend', () => {
      const results = Array.from({ length: 10 }, (_, i) =>
        computeFlowIndex({
          linubReward: 0.3 + (i * 0.05), // improving
          responseLatencies: [2000],
          accuracies: [0.3 + (i * 0.05)],
        })
      );

      const agg = aggregateSession(results);
      expect(agg.flowTrend).toBe('improving');
    });

    it('should detect declining trend', () => {
      const results = Array.from({ length: 10 }, (_, i) =>
        computeFlowIndex({
          linubReward: 0.9 - (i * 0.05), // declining
          responseLatencies: [2000],
          accuracies: [0.9 - (i * 0.05)],
        })
      );

      const agg = aggregateSession(results);
      expect(agg.flowTrend).toBe('declining');
    });

    it('should handle empty input', () => {
      const agg = aggregateSession([]);
      expect(agg.avgFlowScore).toBe(0);
      expect(agg.flowTrend).toBe('stable');
    });
  });
});
