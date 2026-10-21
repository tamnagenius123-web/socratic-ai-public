// SocraticAI v35 — Intuition Discriminator (T1.3.3)
// 3-stage 저항 감별 + Chinn-Brewer 7+1 분류기
// 원문: Chinn & Brewer (1993), R3_dialectical_learning_evidence_deep.md

import { callAI } from '../ai-client';
import { robustJSONParse } from '../ai-client';
import type { Bindings } from '../../types';
import type { ChinnBrewerClassification, ResistanceClassification } from './types';
import classifierPrompt from './prompts/chinn_brewer_classifier.prompt.md?raw';

/**
 * Chinn-Brewer 분류기 프롬프트 로드
 * 파일: src/services/taiji/prompts/chinn_brewer_classifier.prompt.md (이미 존재)
 */
/**
 * 3-stage 저항 감별 로직
 *
 * Stage 1: 응답 길이 휴리스틱 (200자 미만 → 판단 보류 가능성)
 * Stage 2: 부정형 키워드 매칭 (명시적 거부 표현 감지)
 * Stage 3: LLM 분류기 호출 (정교한 분류)
 *
 * @param studentResponse 학생 응답 텍스트
 * @param counterExample 제시된 반례 (맥락용)
 * @param env 환경변수
 * @returns 분류 결과
 */
export async function classifyStudentResponse(
  studentResponse: string,
  counterExample: { claim: string; targetFallacy: string },
  env: Bindings
): Promise<ResistanceClassification> {
  // Stage 1: 길이 휴리스틱
  if (!studentResponse || studentResponse.trim().length < 10) {
    return {
      classification: 'uncertain',
      confidence: 0.3,
      reasoning: 'Response too short or empty',
    };
  }

  // Stage 2: 부정형 키워드 빠른 감지
  const rejectKeywords = [
    '잘못됐',
    '틀렸',
    '아니야',
    'wrong',
    'incorrect',
    'false',
    'no way',
  ];
  const hasRejectKeyword = rejectKeywords.some(kw =>
    studentResponse.toLowerCase().includes(kw.toLowerCase())
  );

  if (hasRejectKeyword && studentResponse.length < 100) {
    // 짧은 명시적 거부
    return {
      classification: 'reject',
      confidence: 0.65,
      reasoning: 'Explicit rejection keyword detected',
    };
  }

  // Stage 3: LLM 분류기 호출
  return await classifyWithLLM(studentResponse, counterExample, env);
}

/**
 * LLM 기반 Chinn-Brewer 분류기
 *
 * @param studentResponse 학생 응답
 * @param counterExample 맥락 (반례)
 * @param env 환경변수
 * @returns 분류 결과
 */
async function classifyWithLLM(
  studentResponse: string,
  counterExample: { claim: string; targetFallacy: string },
  env: Bindings
): Promise<ResistanceClassification> {
  const userMessage = JSON.stringify({
    counterexample: counterExample.claim,
    targetFallacy: counterExample.targetFallacy,
    learnerResponse: studentResponse,
  });

  try {
    const result = await callAI(
      env.DEEPSEEK_API_KEY || '',
      env.GEMINI_API_KEY,
      classifierPrompt,
      userMessage,
      {
        env,
        jsonMode: true,
        maxTokens: 1024,
        temperature: 0.5,
        preferFast: true, // 분류는 빠르게 처리
      }
    );

    const parsed = robustJSONParse<{
      classification: ChinnBrewerClassification;
      confidence: number;
    }>(result.content);

    // 신뢰도 <0.7이면 uncertain으로 다운그레이드
    if (parsed.confidence < 0.7) {
      return {
        classification: 'uncertain',
        confidence: parsed.confidence,
        reasoning: 'Low confidence classification',
      };
    }

    return {
      classification: parsed.classification,
      confidence: parsed.confidence,
    };
  } catch (error) {
    console.error('[TaijiDiscriminator] LLM classification failed:', error);
    throw new Error('Chinn-Brewer classification unavailable');
  }
}

/**
 * 저항 분류 결과를 기반으로 엔진 동작 결정
 *
 * @param classification 분류 결과
 * @returns 엔진 동작 지시 (continue, suspend, reinforce, clarify)
 */
export function getEngineAction(
  classification: ChinnBrewerClassification
): {
  action: 'continue' | 'suspend' | 'reinforce' | 'clarify';
  duration?: number; // suspend 시 분(minutes)
  message?: string;
} {
  switch (classification) {
    case 'theory_change':
      return {
        action: 'reinforce',
        message: '이론 변화 감지. 시냅스 가중치 강화 +0.15.',
      };

    case 'ignore':
    case 'reject':
    case 'exclude':
    case 'abeyance':
    case 'reinterpret':
    case 'peripheral':
      return {
        action: 'suspend',
        duration: 10,
        message: '저항 감지. 10분 태극 엔진 일시 중지. Socratic 기본 모드로 회귀.',
      };

    case 'uncertain':
      return {
        action: 'clarify',
        message: '판단 보류. 명확화 질문 1회 후 재분류.',
      };

    default:
      return {
        action: 'continue',
      };
  }
}

/**
 * 저항 패턴 연속성 검사
 * 같은 저항 유형이 연속 2회 감지 시 경고
 */
export function checkResistancePattern(
  classifications: ChinnBrewerClassification[],
  maxRecent: number = 3
): {
  isPattern: boolean;
  type?: ChinnBrewerClassification;
  count: number;
  recommendation: string;
} {
  if (classifications.length < 2) {
    return {
      isPattern: false,
      count: 0,
      recommendation: '패턴 판정 불가 (데이터 부족)',
    };
  }

  const recent = classifications.slice(-maxRecent);
  const last = recent[recent.length - 1];
  const count = recent.filter(c => c === last).length;

  if (count >= 2 && last !== 'uncertain') {
    return {
      isPattern: true,
      type: last,
      count,
      recommendation: `"${last}" 저항 ${count}회 연속. 기존 신념 명시 요구 필요.`,
    };
  }

  return {
    isPattern: false,
    count,
    recommendation: '패턴 감지 안 됨. 계속 진행.',
  };
}
