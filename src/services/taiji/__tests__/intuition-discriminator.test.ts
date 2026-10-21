// SocraticAI v35 — Intuition Discriminator Unit Tests
// Chinn-Brewer 분류 + 엔진 액션

import { describe, it, expect } from 'vitest';
import { getEngineAction, checkResistancePattern } from '../intuition-discriminator';

describe('IntuitioinDiscriminator', () => {
  describe('getEngineAction', () => {
    it('should return reinforce action for theory_change classification', () => {
      const action = getEngineAction('theory_change');
      expect(action.action).toBe('reinforce');
      expect(action.message).toMatch(/이론 변화/);
    });

    it('should return suspend action for resistance classifications (ignore, reject, exclude, abeyance, reinterpret, peripheral)', () => {
      const resistances = [
        'ignore' as const,
        'reject' as const,
        'exclude' as const,
        'abeyance' as const,
        'reinterpret' as const,
        'peripheral' as const,
      ];

      resistances.forEach(cls => {
        const action = getEngineAction(cls);
        expect(action.action).toBe('suspend');
        expect(action.duration).toBe(10);
        expect(action.message).toMatch(/저항|일시 중지/);
      });
    });

    it('should return clarify action for uncertain classification', () => {
      const action = getEngineAction('uncertain');
      expect(action.action).toBe('clarify');
      expect(action.message).toMatch(/판단 보류|명확화/);
    });
  });

  describe('checkResistancePattern', () => {
    it('should not detect pattern with insufficient data', () => {
      const result = checkResistancePattern(['reject']);
      expect(result.isPattern).toBe(false);
      expect(result.count).toBe(1);
    });

    it('should detect pattern when same resistance type appears twice consecutively', () => {
      const result = checkResistancePattern(['reinterpret', 'reinterpret']);
      expect(result.isPattern).toBe(true);
      expect(result.type).toBe('reinterpret');
      expect(result.count).toBe(2);
    });

    it('should detect pattern within recent window (default 3)', () => {
      const result = checkResistancePattern(['peripheral', 'uncertain', 'peripheral', 'peripheral']);
      expect(result.isPattern).toBe(true);
      expect(result.type).toBe('peripheral');
      expect(result.count).toBe(2);
    });

    it('should not detect pattern for uncertain classifications (special handling)', () => {
      const result = checkResistancePattern(['uncertain', 'uncertain', 'uncertain']);
      expect(result.isPattern).toBe(false);
      expect(result.recommendation).toMatch(/패턴 감지 안/);
    });

    it('should not detect pattern if non-consecutive', () => {
      const result = checkResistancePattern(['reject', 'uncertain', 'reject']);
      expect(result.isPattern).toBe(false);
    });

    it('should handle maxRecent parameter', () => {
      const result = checkResistancePattern(
        ['ignore', 'reject', 'ignore', 'ignore', 'ignore'],
        2 // maxRecent = 2
      );
      // Within last 2: ['ignore', 'ignore'], so count = 2
      expect(result.count).toBe(2);
    });
  });

  describe('Integration Cases', () => {
    it('should recommend intervention for consistent resistance pattern', () => {
      const classifications = ['reject', 'reject', 'reject'];
      const pattern = checkResistancePattern(classifications);
      expect(pattern.isPattern).toBe(true);
      expect(pattern.recommendation).toMatch(/기존 신념 명시 요구/);
    });

    it('should recommend continue if no pattern', () => {
      const classifications = ['theory_change', 'uncertain', 'peripheral'];
      const pattern = checkResistancePattern(classifications);
      expect(pattern.isPattern).toBe(false);
      expect(pattern.recommendation).toMatch(/계속 진행/);
    });
  });
});
