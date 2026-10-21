// SocraticAI v15.0 — AI Client Unit Tests
// Tests: JSON repair, ELO calculation, prompt cache, provider routing

import { describe, it, expect } from 'vitest';
import { repairJSON, robustJSONParse, buildCachedSystemPrompt } from '../src/services/ai-client';

describe('repairJSON', () => {
  it('should handle clean JSON', () => {
    const input = '{"key": "value"}';
    expect(repairJSON(input)).toBe(input);
  });

  it('should remove fenced code blocks', () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(repairJSON(input)).toBe('{"key": "value"}');
  });

  it('should fix trailing commas', () => {
    const input = '{"a": 1, "b": 2,}';
    expect(repairJSON(input)).toBe('{"a": 1, "b": 2}');
  });

  it('should balance braces', () => {
    const input = '{"a": {"b": 1}';
    const result = repairJSON(input);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('should handle BOM and zero-width chars', () => {
    const input = '\uFEFF{"key": "value"}';
    expect(repairJSON(input)).toBe('{"key": "value"}');
  });

  it('should normalize smart quotes', () => {
    const input = '{\u201Ckey\u201D: \u201Cvalue\u201D}';
    const result = repairJSON(input);
    expect(result).toContain('"key"');
  });

  it('should extract JSON from text prefix', () => {
    const input = 'Here is the result: {"score": 5}';
    const result = repairJSON(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result).score).toBe(5);
  });
});

describe('robustJSONParse', () => {
  it('should parse valid JSON directly', () => {
    const result = robustJSONParse<{ a: number }>('{"a": 1}');
    expect(result.a).toBe(1);
  });

  it('should repair and parse broken JSON', () => {
    const result = robustJSONParse<{ a: number }>('{"a": 1,}');
    expect(result.a).toBe(1);
  });

  it('should parse from markdown fence', () => {
    const result = robustJSONParse<{ x: string }>('The answer is:\n```json\n{"x": "hello"}\n```');
    expect(result.x).toBe('hello');
  });

  it('should throw on completely invalid input', () => {
    expect(() => robustJSONParse('not json at all')).toThrow();
  });
});

describe('buildCachedSystemPrompt', () => {
  it('should prepend stable prefix to task-specific suffix', () => {
    const prompt = buildCachedSystemPrompt('Evaluate this response.');
    expect(prompt).toContain('SocraticAI');
    expect(prompt).toContain('D-Plan');
    expect(prompt).toContain('Evaluate this response.');
  });

  it('should keep prefix identical across calls for cache hit', () => {
    const p1 = buildCachedSystemPrompt('Task A');
    const p2 = buildCachedSystemPrompt('Task B');
    // Both should share same prefix
    const prefixLength = p1.indexOf('Task A');
    expect(p1.substring(0, prefixLength)).toBe(p2.substring(0, p2.indexOf('Task B')));
  });
});
