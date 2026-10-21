import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8');

describe('Task 3 prompt and AIF ownership boundaries', () => {
  it('file-backs every Task 3 prompt and leaves no moved prompt bodies inline', async () => {
    const [chat, session, researcher] = await Promise.all([
      source('src/routes/chat.ts'),
      source('src/routes/session.ts'),
      source('src/services/math/researcher-agent.ts'),
    ]);

    expect(chat).toContain('session-end-analysis.system.md?raw');
    expect(chat).toContain('session-end-analysis.user.md?raw');
    expect(session).toContain('context-bound-opening.system.md?raw');
    expect(session).toContain('context-bound-opening.user.md?raw');
    expect(researcher).toContain('researcher-fact-check.system.md?raw');
    expect(researcher).toContain('researcher-fact-check.user.md?raw');

    expect(chat).not.toContain('당신은 교육 평가 전문가입니다. 소크라테스식 독서 토론 세션의 전체 내용을 분석하세요.');
    expect(session).not.toContain('You write a concise Korean Socratic opening.');
    expect(researcher).not.toContain('당신은 팩트체크 전문가입니다. 학생의 주장이 제공된 텍스트에 근거하고 있는지 엄밀히 검증합니다.');
  });

  it('keeps AIF extraction and persistence solely in accepted orchestrator side effects', async () => {
    const chat = await source('src/routes/chat.ts');

    expect(chat).toContain('runAcceptedSideEffects');
    expect(chat).not.toContain("await import('../services/math/aif-pipeline')");
    expect(chat).not.toContain('extractAIFRuleBased');
    expect(chat).not.toContain('persistAIFToD1');
  });
});
