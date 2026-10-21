/**
 * Unit tests for Counter-Question Depth Classifier
 */

import { describe, it, expect } from '@jest/globals';
import {
  isCounterQuestion,
  classifyQuestionDepth,
  analyzeCounterQuestionDepth,
  depthToScore,
  aggregateStatistics,
  analyzeBatch,
} from '../counter-question';

describe('Counter-Question Depth Classifier', () => {
  describe('isCounterQuestion', () => {
    it('should detect explicit questions', () => {
      expect(isCounterQuestion('그렇다면 어떻게?')).toBe(true);
      expect(isCounterQuestion('What is the basis?')).toBe(true);
      expect(isCounterQuestion('Can you clarify?')).toBe(true);
    });

    it('should reject statements', () => {
      expect(isCounterQuestion('나는 동의한다')).toBe(false);
      expect(isCounterQuestion('I understand.')).toBe(false);
    });

    it('should handle empty input', () => {
      expect(isCounterQuestion('')).toBe(false);
      expect(isCounterQuestion('  ')).toBe(false);
    });

    it('should detect questions with trailing punctuation', () => {
      expect(isCounterQuestion('정말인가?!')).toBe(true);
      expect(isCounterQuestion('why   ?')).toBe(true);
    });
  });

  describe('classifyQuestionDepth', () => {
    it('should classify clarification (depth 1)', () => {
      const depth = classifyQuestionDepth('이게 뭔가요?');
      expect(depth).toBe(1);
    });

    it('should classify assumption validation (depth 2)', () => {
      const depth2a = classifyQuestionDepth('그런데 이 가정이 맞나요?');
      expect(depth2a).toBe(2);

      const depth2b = classifyQuestionDepth('왜 꼭 그래야 하나요?');
      expect(depth2b).toBe(2);

      const depth2c = classifyQuestionDepth('이게 항상 참인가요?');
      expect(depth2c).toBe(2);
    });

    it('should classify alternative proposals (depth 3)', () => {
      const depth3a = classifyQuestionDepth('그렇다면 다르게 생각하면 어떨까요?');
      expect(depth3a).toBe(3);

      const depth3b = classifyQuestionDepth('반대로 생각해보면?');
      expect(depth3b).toBe(3);

      const depth3c = classifyQuestionDepth('대신 이렇게 할 수는 없을까?');
      expect(depth3c).toBe(3);
    });

    it('should return 0 for non-questions', () => {
      expect(classifyQuestionDepth('나는 동의한다')).toBe(0);
    });

    it('should default simple questions to depth 1', () => {
      const depth = classifyQuestionDepth('뭐?');
      expect(depth).toBe(1);
    });
  });

  describe('analyzeCounterQuestionDepth', () => {
    it('should return zero depth for non-questions', () => {
      const result = analyzeCounterQuestionDepth('I agree.');
      expect(result.depth).toBe(0);
      expect(result.isCounterQuestion).toBe(false);
      expect(result.expressionType).toBe('none');
    });

    it('should provide reasoning string', () => {
      const result = analyzeCounterQuestionDepth('이게 맞나요?');
      expect(result.reasoning).toBeTruthy();
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should compute confidence scores', () => {
      const depth1 = analyzeCounterQuestionDepth('뭔가?');
      expect(depth1.confidence).toBeGreaterThan(0.7);

      const depth3 = analyzeCounterQuestionDepth('그렇다면?');
      expect(depth3.confidence).toBeGreaterThan(0.6);
    });

    it('should be case-insensitive for English', () => {
      const result = analyzeCounterQuestionDepth('HOW DO YOU KNOW?');
      expect(result.isCounterQuestion).toBe(true);
      expect(result.depth).toBeGreaterThan(0);
    });
  });

  describe('depthToScore', () => {
    it('should convert depth to [0, 1] scale', () => {
      expect(depthToScore(0)).toBe(0);
      expect(depthToScore(1)).toBeCloseTo(0.333);
      expect(depthToScore(2)).toBeCloseTo(0.667);
      expect(depthToScore(3)).toBe(1);
    });
  });

  describe('analyzeBatch', () => {
    it('should analyze multiple messages', () => {
      const messages = [
        { text: '뭐지?', turn: 1 },
        { text: '그렇다면?', turn: 2 },
        { text: '동의한다', turn: 3 },
      ];

      const results = analyzeBatch(messages);
      expect(results.length).toBe(3);
      expect(results[0].depth).toBe(1);
      expect(results[1].depth).toBeGreaterThan(0);
      expect(results[2].depth).toBe(0);
    });

    it('should handle empty batch', () => {
      const results = analyzeBatch([]);
      expect(results.length).toBe(0);
    });
  });

  describe('aggregateStatistics', () => {
    it('should compute distribution of depths', () => {
      const analyses = [
        analyzeCounterQuestionDepth(''),
        analyzeCounterQuestionDepth('뭐?'),
        analyzeCounterQuestionDepth('뭐?'),
        analyzeCounterQuestionDepth('가정?'),
      ];

      const stats = aggregateStatistics(analyses);
      expect(stats.totalQuestions).toBe(3); // non-questions not counted
      expect(stats.depthDistribution[0]).toBe(1);
      expect(stats.depthDistribution[1]).toBe(2);
      expect(stats.depthDistribution[2]).toBe(1);
    });

    it('should compute average depth', () => {
      const analyses = [
        analyzeCounterQuestionDepth('뭐?'), // depth 1
        analyzeCounterQuestionDepth('가정?'), // depth 2
        analyzeCounterQuestionDepth('대신?'), // depth 3
      ];

      const stats = aggregateStatistics(analyses);
      expect(stats.avgDepth).toBeCloseTo(2.0);
      expect(stats.maxDepth).toBe(3);
    });

    it('should handle empty analysis', () => {
      const stats = aggregateStatistics([]);
      expect(stats.totalQuestions).toBe(0);
      expect(stats.avgDepth).toBe(0);
    });

    it('should count by expression type', () => {
      const analyses = [
        analyzeCounterQuestionDepth('뭐?'), // clarification
        analyzeCounterQuestionDepth('뭐?'), // clarification
        analyzeCounterQuestionDepth('왜?'), // assumption
        analyzeCounterQuestionDepth('다르게?'), // alternative
      ];

      const stats = aggregateStatistics(analyses);
      expect(stats.clarificationCount).toBe(2);
      expect(stats.assumptionCount).toBe(1);
      expect(stats.alternativeCount).toBe(1);
    });
  });
});
