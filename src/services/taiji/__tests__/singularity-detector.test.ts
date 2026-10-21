// SocraticAI v35 — Singularity Detector Unit Tests
// 더블 게이트 3가지 케이스 + 상태 조회

import { describe, it, expect } from 'vitest';
import { checkSingularityGate, isSingularityReady, getSingularityGateStatus } from '../singularity-detector';

describe('SingularityDetector', () => {
  describe('checkSingularityGate', () => {
    it('should return ready=true when all conditions pass (mastery >= 0.65, engagement >= 0.70, grade >= 6)', () => {
      const result = checkSingularityGate(0.75, 0.80, 8);
      expect(result.ready).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should return ready=false when mastery < 0.65', () => {
      const result = checkSingularityGate(0.50, 0.80, 8);
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/mastery.*below_0.65/);
    });

    it('should return ready=false when engagement < 0.70', () => {
      const result = checkSingularityGate(0.75, 0.60, 8);
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/engagement.*below_0.70/);
    });

    it('should return ready=false when grade < 6', () => {
      const result = checkSingularityGate(0.75, 0.80, 5);
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/grade_below_6/);
    });

    it('should check grade first before mastery and engagement (grade acts as hard boundary)', () => {
      const result = checkSingularityGate(0.30, 0.40, 4);
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/grade_below_6/);
    });
  });

  describe('isSingularityReady', () => {
    it('should return true when gate passes', () => {
      expect(isSingularityReady(0.70, 0.75, 7)).toBe(true);
    });

    it('should return false when gate fails', () => {
      expect(isSingularityReady(0.50, 0.80, 8)).toBe(false);
    });
  });

  describe('getSingularityGateStatus', () => {
    it('should provide detailed status of each check', () => {
      const status = getSingularityGateStatus(0.75, 0.80, 8);
      expect(status.gradeCheck).toBe(true);
      expect(status.masteryCheck).toBe(true);
      expect(status.engagementCheck).toBe(true);
      expect(status.allPassed).toBe(true);
      expect(status.failureReasons).toHaveLength(0);
    });

    it('should list all failure reasons when multiple conditions fail', () => {
      const status = getSingularityGateStatus(0.50, 0.60, 5);
      expect(status.gradeCheck).toBe(false);
      expect(status.masteryCheck).toBe(false);
      expect(status.engagementCheck).toBe(false);
      expect(status.allPassed).toBe(false);
      expect(status.failureReasons).toHaveLength(3);
      expect(status.failureReasons.some(r => r.includes('grade'))).toBe(true);
      expect(status.failureReasons.some(r => r.includes('mastery'))).toBe(true);
      expect(status.failureReasons.some(r => r.includes('engagement'))).toBe(true);
    });
  });

  describe('Boundary Cases', () => {
    it('should allow exact threshold values', () => {
      const result = checkSingularityGate(0.65, 0.70, 6);
      expect(result.ready).toBe(true);
    });

    it('should reject just below threshold values', () => {
      const result1 = checkSingularityGate(0.649, 0.70, 6);
      expect(result1.ready).toBe(false);

      const result2 = checkSingularityGate(0.65, 0.699, 6);
      expect(result2.ready).toBe(false);

      const result3 = checkSingularityGate(0.65, 0.70, 5);
      expect(result3.ready).toBe(false);
    });
  });
});
