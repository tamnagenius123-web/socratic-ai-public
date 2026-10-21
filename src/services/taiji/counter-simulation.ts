// SocraticAI v35 — Counter-Simulation Engine (T1.3.1)
// DeepSeek thinking mode로 최강 반례 생성
// 원문: R3_dialectical_learning_evidence.md, Walton Schemes Catalog

import { callAI, robustJSONParse } from '../ai-client';
import type { Bindings } from '../../types';
import type { CounterSimulationRequest, CounterExample } from './types';
import { WALTON_SCHEMES, highFitSchemes } from './walton_schemes_catalog';
import counterSimulationPrompt from './prompts/counter_simulation.prompt.md?raw';

/**
 * 반례 생성 프롬프트 로드
 * 파일: src/services/taiji/prompts/counter_simulation.prompt.md
 */
/**
 * 학생 논증으로부터 가능한 Walton 스키마 식별
 * (간단한 휴리스틱, 실제 분류는 LLM)
 */
function estimateWaltonScheme(claim: string): string {
  const lowerClaim = claim.toLowerCase();

  // 키워드 기반 매칭 (walton_schemes_catalog.ts SCHEME_KEYWORD_HINTS 참조)
  for (const [schemeId, hints] of Object.entries({
    arg_from_analogy: ['처럼', 'like', '유사', 'analog', '마찬가지'],
    arg_from_cause_to_effect: ['때문에', '원인', 'cause', '결과', 'effect'],
    arg_from_consequences_positive: ['좋을', 'benefit', '이득'],
    arg_from_expert_opinion: ['교수', '박사', 'expert', '권위'],
    arg_from_popular_opinion: ['다들', '대부분', 'everyone'],
  })) {
    if ((hints as string[]).some(h => lowerClaim.includes(h.toLowerCase()))) {
      return schemeId;
    }
  }

  // 기본값: high-fit 스키마 중 하나
  const highFit = highFitSchemes();
  return highFit.length > 0 ? highFit[0].id : 'arg_from_cause_to_effect';
}

/**
 * DeepSeek thinking mode로 반례 생성
 *
 * @param request 반례 생성 요청
 * @param env 환경변수 (API 키 포함)
 * @returns 생성된 반례
 */
export async function generateCounterExample(
  request: CounterSimulationRequest,
  env: Bindings
): Promise<CounterExample> {
  // 학생 주장에서 가능한 스키마 추정
  const estimatedScheme = estimateWaltonScheme(request.studentClaim);
  const waltonScheme = WALTON_SCHEMES.find(s => s.id === estimatedScheme);

  // 사용자 메시지 구성
  const userMessage = JSON.stringify({
    learnerClaim: request.studentClaim,
    gradeLevel: request.gradeLevel,
    masteryScore: request.masteryScore,
    engagementScore: request.engagementScore,
    waltonScheme: waltonScheme?.nameKo || estimatedScheme,
    waltonPremises: waltonScheme?.premises || [],
  });

  try {
    const result = await callAI(
      env.DEEPSEEK_API_KEY || '',
      env.GEMINI_API_KEY,
      counterSimulationPrompt,
      userMessage,
      {
        env,
        useThinking: true,
        thinkingBudget: 8192,
        jsonMode: true,
        maxTokens: 4096,
        temperature: 0.7,
      }
    );

    // 응답 파싱
    const parsed = robustJSONParse<{
      counterClaim: string;
      premises: string[];
      targetFallacy: string;
      confidence: number;
    }>(result.content);

    return {
      counterClaim: parsed.counterClaim,
      premises: parsed.premises,
      targetFallacy: parsed.targetFallacy,
      confidence: parsed.confidence,
      waltonSchemeId: estimatedScheme,
    };
  } catch (error) {
    console.error('[TaijiCounterSim] Generation failed:', error);
    throw new Error(
      `Counter-example generation failed: ${(error as Error).message}`
    );
  }
}

/**
 * 배치 반례 생성 (여러 학생 주장에 대해)
 */
export async function generateMultipleCounterExamples(
  requests: CounterSimulationRequest[],
  env: Bindings
): Promise<CounterExample[]> {
  const results = await Promise.all(
    requests.map(req => generateCounterExample(req, env))
  );
  return results;
}
