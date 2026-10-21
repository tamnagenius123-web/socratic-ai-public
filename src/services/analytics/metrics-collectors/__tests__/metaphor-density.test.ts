/**
 * Unit tests for Metaphor Density Collector
 */

import { describe, it, expect } from '@jest/globals';
import {
  shouldSampleTurn,
  parseMetaphorScore,
  extractMetaphorPatterns,
  computeMetaphorDensityLocal,
  analyzeMetaphorDensity,
  MetaphorAnalysisRequest,
} from '../metaphor-density';

describe('Metaphor Density Collector', () => {
  describe('shouldSampleTurn', () => {
    it('should sample every 3 turns by default', () => {
      expect(shouldSampleTurn(1)).toBe(false);
      expect(shouldSampleTurn(2)).toBe(false);
      expect(shouldSampleTurn(3)).toBe(true);
      expect(shouldSampleTurn(4)).toBe(false);
      expect(shouldSampleTurn(6)).toBe(true);
      expect(shouldSampleTurn(9)).toBe(true);
    });

    it('should respect custom sample rate', () => {
      expect(shouldSampleTurn(1, 2)).toBe(false);
      expect(shouldSampleTurn(2, 2)).toBe(true);
      expect(shouldSampleTurn(3, 2)).toBe(false);
      expect(shouldSampleTurn(4, 2)).toBe(true);
    });
  });

  describe('parseMetaphorScore', () => {
    it('should parse JSON response', () => {
      const response = '{"metaphorScore": 0.75}';
      expect(parseMetaphorScore(response)).toBeCloseTo(0.75);
    });

    it('should handle alternative JSON key', () => {
      const response = '{"score": 0.6}';
      expect(parseMetaphorScore(response)).toBeCloseTo(0.6);
    });

    it('should extract number from plain text', () => {
      const response = '0.82';
      expect(parseMetaphorScore(response)).toBeCloseTo(0.82);
    });

    it('should clamp values to [0, 1]', () => {
      expect(parseMetaphorScore('1.5')).toBe(1);
      expect(parseMetaphorScore('-0.5')).toBe(0);
    });

    it('should return 0 for unparseable input', () => {
      expect(parseMetaphorScore('invalid')).toBe(0);
      expect(parseMetaphorScore('')).toBe(0);
    });

    it('should handle malformed JSON gracefully', () => {
      const response = 'This is not JSON but has 0.3 in it';
      expect(parseMetaphorScore(response)).toBeCloseTo(0.3);
    });
  });

  describe('extractMetaphorPatterns', () => {
    it('should detect Korean metaphor markers', () => {
      const text = '마치 물처럼 흐르는 시간처럼, 우리의 생각도 흐른다.';
      const { types, count } = extractMetaphorPatterns(text);
      expect(count).toBeGreaterThan(0);
      expect(types.length).toBeGreaterThan(0);
    });

    it('should detect English similes', () => {
      const text = 'Like a river, our thoughts flow. As if by magic, understanding dawned.';
      const { types, count } = extractMetaphorPatterns(text);
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it('should handle mixed language', () => {
      const text = '마치 물처럼 흐르고, as if magic happens.';
      const { types, count } = extractMetaphorPatterns(text);
      expect(count).toBeGreaterThan(0);
    });

    it('should return empty for non-metaphorical text', () => {
      const text = '나는 학교에 간다.';
      const { types, count } = extractMetaphorPatterns(text);
      expect(count).toBe(0);
      expect(types.length).toBe(0);
    });

    it('should detect analogy patterns', () => {
      const text = '문제 해결은 퍼즐을 푸는 것에 비유할 수 있다.';
      const { count } = extractMetaphorPatterns(text);
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('computeMetaphorDensityLocal', () => {
    it('should return 0 for short text', () => {
      expect(computeMetaphorDensityLocal('hi')).toBe(0);
    });

    it('should compute density with metaphors', () => {
      const text = '마치 물처럼 흐르는 시간처럼 우리 생각도 흐른다 그것은 강처럼 강하다';
      const score = computeMetaphorDensityLocal(text);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('should return 0 for non-metaphorical text', () => {
      const text = '나는 학교에 간다 우리는 공부한다 학생들은 시험을 본다';
      const score = computeMetaphorDensityLocal(text);
      expect(score).toBeCloseTo(0);
    });

    it('should normalize by message length', () => {
      const shortMeta = '마치 물처럼';
      const longMeta =
        '마치 물처럼 흐르는 시간처럼 우리 생각도 흐른다 그것은 강처럼 강하고 깊다 산처럼 안정적이고 하늘처럼 높다';

      const shortScore = computeMetaphorDensityLocal(shortMeta);
      const longScore = computeMetaphorDensityLocal(longMeta);

      expect(shortScore).toBeGreaterThan(longScore);
    });
  });

  describe('analyzeMetaphorDensity', () => {
    it('should sample at correct turns', async () => {
      const request: MetaphorAnalysisRequest = {
        studentMessage: '마치 물처럼',
        turnNumber: 3, // sampled
      };

      const result = await analyzeMetaphorDensity(request);
      expect(result.sampled).toBe(true);
    });

    it('should use local fallback for non-sampled turns', async () => {
      const request: MetaphorAnalysisRequest = {
        studentMessage: '마치 물처럼',
        turnNumber: 1, // not sampled
      };

      const result = await analyzeMetaphorDensity(request);
      expect(result.sampled).toBe(false);
      expect(result.confidence).toBe(0.4);
    });

    it('should call LLM analyzer when sampled', async () => {
      const mockLLM = async (text: string) => JSON.stringify({ metaphorScore: 0.85 });

      const request: MetaphorAnalysisRequest = {
        studentMessage: '마치 물처럼',
        turnNumber: 3,
      };

      const result = await analyzeMetaphorDensity(request, mockLLM);
      expect(result.metaphorScore).toBeCloseTo(0.85);
    });

    it('should handle LLM failure gracefully', async () => {
      const failingLLM = async () => {
        throw new Error('LLM error');
      };

      const request: MetaphorAnalysisRequest = {
        studentMessage: '마치 물처럼',
        turnNumber: 3,
      };

      const result = await analyzeMetaphorDensity(request, failingLLM);
      expect(result).toBeDefined();
      // Falls back to local analysis
    });

    it('should compute hasMetaphors boolean', async () => {
      const withMeta: MetaphorAnalysisRequest = {
        studentMessage: '마치 물처럼 흐르는',
        turnNumber: 1,
      };

      const withoutMeta: MetaphorAnalysisRequest = {
        studentMessage: '나는 학교에 간다',
        turnNumber: 1,
      };

      const result1 = await analyzeMetaphorDensity(withMeta);
      const result2 = await analyzeMetaphorDensity(withoutMeta);

      expect(result1.hasMetaphors).toBe(true);
      expect(result2.hasMetaphors).toBe(false);
    });

    it('should support custom sample rate', async () => {
      const request: MetaphorAnalysisRequest = {
        studentMessage: '마치 물처럼',
        turnNumber: 5,
        sampleRate: 5,
      };

      const result = await analyzeMetaphorDensity(request);
      expect(result.sampled).toBe(true);
    });
  });
});
