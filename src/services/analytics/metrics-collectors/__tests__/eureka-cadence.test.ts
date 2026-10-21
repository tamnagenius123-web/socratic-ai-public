/**
 * Unit tests for Eureka Cadence Collector
 */

import { describe, it, expect } from '@jest/globals';
import {
  computeEurekaCadence,
  debounceKeystrokeEvents,
  processBuckets,
  KeystrokeEvent,
} from '../eureka-cadence';

describe('Eureka Cadence Collector', () => {
  describe('computeEurekaCadence', () => {
    it('should return low score for few events', () => {
      const events: KeystrokeEvent[] = [{ timestamp: 0, type: 'keystroke' }];
      const result = computeEurekaCadence(events);
      expect(result.rawScore).toBe(0);
      expect(result.normalizedScore).toBe(0.3);
    });

    it('should detect active thinking (short pauses)', () => {
      const now = Date.now();
      const events: KeystrokeEvent[] = [
        { timestamp: now, type: 'keystroke' },
        { timestamp: now + 50, type: 'keystroke' }, // short pause
        { timestamp: now + 80, type: 'keystroke' }, // short pause
        { timestamp: now + 120, type: 'keystroke' }, // short pause
        { timestamp: now + 150, type: 'keystroke' }, // short pause
        { timestamp: now + 200, type: 'keystroke' }, // short pause
      ];

      const result = computeEurekaCadence(events);
      expect(result.shortPauseCount).toBe(5);
      expect(result.totalPauseCount).toBe(5);
      expect(result.pauseRatio).toBeCloseTo(1.0);
      expect(result.normalizedScore).toBeGreaterThan(0.8); // high activity
    });

    it('should detect stuck state (long pauses)', () => {
      const now = Date.now();
      const events: KeystrokeEvent[] = [
        { timestamp: now, type: 'keystroke' },
        { timestamp: now + 2000, type: 'keystroke' }, // long pause
        { timestamp: now + 4000, type: 'keystroke' }, // long pause
        { timestamp: now + 6000, type: 'keystroke' }, // long pause
        { timestamp: now + 8000, type: 'keystroke' }, // long pause
        { timestamp: now + 10000, type: 'keystroke' }, // long pause
      ];

      const result = computeEurekaCadence(events);
      expect(result.shortPauseCount).toBe(0);
      expect(result.totalPauseCount).toBe(5);
      expect(result.pauseRatio).toBeCloseTo(0.0);
      expect(result.normalizedScore).toBeLessThan(0.2); // low activity
    });

    it('should filter outliers (pauses > 5 seconds)', () => {
      const now = Date.now();
      const events: KeystrokeEvent[] = [
        { timestamp: now, type: 'keystroke' },
        { timestamp: now + 50, type: 'keystroke' }, // short pause
        { timestamp: now + 10000, type: 'keystroke' }, // outlier (10s) - filtered
        { timestamp: now + 10050, type: 'keystroke' }, // short pause
      ];

      const result = computeEurekaCadence(events);
      // Only 2 deltas should be counted (50ms and 50ms, the 10s is filtered)
      expect(result.totalPauseCount).toBe(2);
      expect(result.shortPauseCount).toBe(2);
    });

    it('should handle mixed short and long pauses', () => {
      const now = Date.now();
      const events: KeystrokeEvent[] = [
        { timestamp: now, type: 'keystroke' },
        { timestamp: now + 50, type: 'keystroke' }, // short
        { timestamp: now + 100, type: 'keystroke' }, // short
        { timestamp: now + 1500, type: 'keystroke' }, // long
        { timestamp: now + 1550, type: 'keystroke' }, // short
      ];

      const result = computeEurekaCadence(events);
      expect(result.shortPauseCount).toBe(3);
      expect(result.totalPauseCount).toBe(4);
      expect(result.pauseRatio).toBeCloseTo(0.75);
    });
  });

  describe('debounceKeystrokeEvents', () => {
    it('should bucket events by 500ms window', () => {
      const now = Date.now();
      const events: KeystrokeEvent[] = [
        { timestamp: now, type: 'keystroke' },
        { timestamp: now + 100, type: 'keystroke' },
        { timestamp: now + 200, type: 'keystroke' },
        { timestamp: now + 600, type: 'keystroke' }, // new bucket
        { timestamp: now + 700, type: 'keystroke' },
      ];

      const buckets = debounceKeystrokeEvents(events, 500);
      expect(buckets.length).toBe(2);
      expect(buckets[0].length).toBe(3);
      expect(buckets[1].length).toBe(2);
    });

    it('should handle empty input', () => {
      const buckets = debounceKeystrokeEvents([]);
      expect(buckets.length).toBe(0);
    });

    it('should respect custom window size', () => {
      const now = Date.now();
      const events: KeystrokeEvent[] = [
        { timestamp: now, type: 'keystroke' },
        { timestamp: now + 100, type: 'keystroke' },
        { timestamp: now + 150, type: 'keystroke' },
      ];

      const buckets = debounceKeystrokeEvents(events, 100);
      expect(buckets.length).toBe(2);
    });
  });

  describe('processBuckets', () => {
    it('should compute cadence score for each bucket', () => {
      const now = Date.now();
      const bucket1: KeystrokeEvent[] = [
        { timestamp: now, type: 'keystroke' },
        { timestamp: now + 50, type: 'keystroke' },
        { timestamp: now + 80, type: 'keystroke' },
      ];

      const bucket2: KeystrokeEvent[] = [
        { timestamp: now + 600, type: 'keystroke' },
        { timestamp: now + 2600, type: 'keystroke' }, // long pause
      ];

      const scores = processBuckets([bucket1, bucket2]);
      expect(scores.length).toBe(2);
      expect(scores[0]).toBeGreaterThan(scores[1]); // bucket1 has short pauses
    });

    it('should handle empty buckets', () => {
      const scores = processBuckets([]);
      expect(scores.length).toBe(0);
    });
  });
});
