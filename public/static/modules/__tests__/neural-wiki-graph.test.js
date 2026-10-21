// Test suite for Neural Wiki Graph visualization
// Pure function tests for radius calculation and color mapping

import { calculateNodeRadius, mapMasteryToColor } from '../neural-wiki-graph.js';

describe('Neural Wiki Graph - Pure Functions', () => {
  describe('calculateNodeRadius', () => {
    test('should calculate radius for high mastery (0.9)', () => {
      const radius = calculateNodeRadius(0.9);
      // 8 + log(0.9 * 20) = 8 + log(18) ≈ 8 + 2.89 = 10.89
      expect(radius).toBeCloseTo(10.89, 1);
    });

    test('should calculate radius for medium mastery (0.5)', () => {
      const radius = calculateNodeRadius(0.5);
      // 8 + log(0.5 * 20) = 8 + log(10) ≈ 8 + 2.30 = 10.30
      expect(radius).toBeCloseTo(10.30, 1);
    });

    test('should calculate radius for low mastery (0.1)', () => {
      const radius = calculateNodeRadius(0.1);
      // 8 + log(0.1 * 20) = 8 + log(2) ≈ 8 + 0.69 = 8.69
      expect(radius).toBeCloseTo(8.69, 1);
    });

    test('should handle mastery = 0 (edge case)', () => {
      const radius = calculateNodeRadius(0);
      // 8 + log(max(0, 1)) = 8 + log(1) = 8 + 0 = 8
      expect(radius).toBe(8);
    });

    test('should handle invalid input (non-number)', () => {
      const radius = calculateNodeRadius('invalid');
      expect(radius).toBe(8);
    });

    test('should handle negative mastery', () => {
      const radius = calculateNodeRadius(-0.5);
      expect(radius).toBe(8);
    });
  });

  describe('mapMasteryToColor', () => {
    test('should return signal-progress for high mastery (≥0.8)', () => {
      const color = mapMasteryToColor(0.8);
      expect(color).toContain('--signal-progress');
    });

    test('should return signal-progress for very high mastery (0.95)', () => {
      const color = mapMasteryToColor(0.95);
      expect(color).toContain('--signal-progress');
    });

    test('should return ink-primary for medium mastery (0.3~0.8)', () => {
      const color = mapMasteryToColor(0.5);
      expect(color).toContain('--ink-primary');
    });

    test('should return ink-primary for mastery at lower boundary (0.3)', () => {
      const color = mapMasteryToColor(0.3);
      expect(color).toContain('--ink-primary');
    });

    test('should return ink-primary for mastery just below boundary (0.79)', () => {
      const color = mapMasteryToColor(0.79);
      expect(color).toContain('--ink-primary');
    });

    test('should return ink-tertiary for low mastery (<0.3)', () => {
      const color = mapMasteryToColor(0.2);
      expect(color).toContain('--ink-tertiary');
    });

    test('should return ink-tertiary for very low mastery (0.0)', () => {
      const color = mapMasteryToColor(0.0);
      expect(color).toContain('--ink-tertiary');
    });

    test('should include fallback hex color', () => {
      const color = mapMasteryToColor(0.5);
      expect(color).toMatch(/var\(--ink-primary,\s*#[0-9A-Fa-f]{6}\)/);
    });

    test('should accept custom CSS variable map', () => {
      const customVars = {
        high: '--custom-high',
        medium: '--custom-medium',
        low: '--custom-low',
      };
      const color = mapMasteryToColor(0.9, customVars);
      expect(color).toContain('--custom-high');
    });

    test('should apply correct colors across mastery spectrum', () => {
      // Test all three regions
      const high = mapMasteryToColor(0.85);
      const medium = mapMasteryToColor(0.55);
      const low = mapMasteryToColor(0.15);

      expect(high).toContain('--signal-progress');
      expect(medium).toContain('--ink-primary');
      expect(low).toContain('--ink-tertiary');
    });
  });

  describe('Color mapping boundary conditions', () => {
    test('mastery = 0.8 exactly should map to signal-progress', () => {
      const color = mapMasteryToColor(0.8);
      expect(color).toContain('--signal-progress');
    });

    test('mastery = 0.799 should map to ink-primary', () => {
      const color = mapMasteryToColor(0.799);
      expect(color).toContain('--ink-primary');
    });

    test('mastery = 0.3 exactly should map to ink-primary', () => {
      const color = mapMasteryToColor(0.3);
      expect(color).toContain('--ink-primary');
    });

    test('mastery = 0.299 should map to ink-tertiary', () => {
      const color = mapMasteryToColor(0.299);
      expect(color).toContain('--ink-tertiary');
    });
  });

  describe('Radius calculation formula consistency', () => {
    test('should follow formula: 8 + log(mastery * 20)', () => {
      // Helper to verify formula
      const verify = (mastery) => {
        const expected = 8 + Math.log(Math.max(mastery * 20, 1));
        const actual = calculateNodeRadius(mastery);
        expect(actual).toBeCloseTo(expected, 5);
      };

      verify(0.1);
      verify(0.25);
      verify(0.5);
      verify(0.75);
      verify(1.0);
    });

    test('should scale radius monotonically with mastery', () => {
      const r1 = calculateNodeRadius(0.2);
      const r2 = calculateNodeRadius(0.5);
      const r3 = calculateNodeRadius(0.8);

      expect(r1).toBeLessThan(r2);
      expect(r2).toBeLessThan(r3);
    });

    test('radius should always be at least 8px', () => {
      expect(calculateNodeRadius(0)).toBe(8);
      expect(calculateNodeRadius(0.001)).toBeGreaterThanOrEqual(8);
      expect(calculateNodeRadius(0.05)).toBeGreaterThanOrEqual(8);
    });

    test('radius should be between 8 and ~12 for normal mastery range', () => {
      for (let mastery = 0.1; mastery <= 1.0; mastery += 0.1) {
        const radius = calculateNodeRadius(mastery);
        expect(radius).toBeGreaterThanOrEqual(8);
        expect(radius).toBeLessThanOrEqual(15);
      }
    });
  });
});

/**
 * Simple test runner (when imported in Node.js or test environment)
 * Usage: node --loader ./test-runner.js neural-wiki-graph.test.js
 */
if (typeof describe !== 'undefined' && typeof test !== 'undefined') {
  console.log('Test suite loaded. Run with jest or similar test runner.');
}
