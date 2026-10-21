// Tutor Service - Agent A (V2)
// Generates Socratic questions using GPT-5 Nano via Soongsil API Gateway

import { callAIJSON } from './ai-client';
// v16: tutor-prompt.ts deleted (dead code). Inline fallback prompt.
function buildTutorPrompt(
  session: Record<string, unknown>, evaluation: Record<string, unknown>, bookText: string,
  latestStudentAnswer: string, selectedAction: string, recentTutorActions: string[],
): string {
  return `당신은 소크라테스식 독서토론 AI 튜터입니다.
주제: ${session.topic || ''}
현재 상태: ${session.tutorState || 'elicitation'}
선택된 액션: ${selectedAction}
최근 학생 답변: ${latestStudentAnswer}
도서 발췌: ${(bookText || '').substring(0, 500)}
진단: ${evaluation?.diagnosis || ''}
약점: ${(evaluation?.weaknessTags || []).join(', ')}

소크라테스식 질문을 JSON으로 생성하세요: {"aiReply":"질문 텍스트","questionType":"유형"}`;
}
import type { SessionState, EvaluationResult, TutorResponse } from '../types';

const ACTION_TO_QUESTION: Record<string, TutorResponse['questionType']> = {
  ask_evidence: 'evidence_request',
  request_text_reference: 'text_return',
  ask_reasoning: 'premise_tracking',
  ask_clarification: 'clarification',
  ask_counterexample: 'counterexample',
  ask_revision: 'revision',
  narrow_scope: 'clarification',
  move_to_synthesis: 'comparison',
};

const ACTION_ROTATION: Record<string, string[]> = {
  ask_evidence: ['ask_reasoning', 'request_text_reference', 'ask_clarification'],
  request_text_reference: ['ask_evidence', 'ask_reasoning', 'ask_revision'],
  ask_reasoning: ['ask_counterexample', 'ask_revision', 'ask_evidence'],
  ask_clarification: ['ask_evidence', 'ask_reasoning', 'narrow_scope'],
  ask_counterexample: ['ask_reasoning', 'ask_revision', 'move_to_synthesis'],
  ask_revision: ['ask_evidence', 'ask_reasoning', 'ask_counterexample'],
  narrow_scope: ['ask_clarification', 'ask_evidence', 'ask_reasoning'],
  move_to_synthesis: ['ask_revision', 'ask_counterexample', 'ask_reasoning'],
};

export async function generateTutorResponse(
  soongsilApiKey: string,
  session: SessionState,
  evaluation: EvaluationResult,
  bookText: string,
  latestStudentAnswer: string,
  geminiApiKey?: string,
): Promise<TutorResponse> {
  const recentTutorActions = inferRecentTutorActions(session);
  // 🔴 v9.0 Dynamic Bypass: 학생이 이미 근거를 제시한 경우 ask_evidence 반복 방지
  const bypassResult = checkDynamicBypass(session, evaluation, latestStudentAnswer);
  const selectedAction = bypassResult.shouldBypass
    ? bypassResult.bypassAction!
    : selectTutorAction(session, evaluation, recentTutorActions);

  // 🔵 v10.0 Minimax Questioning: 3개 질문 후보 중 가장 날카로운 질문 선택
  // Game Theory: tutor-student 대화를 zero-sum game으로 모델링
  // Tutor의 목표: 학생의 논리적 허점을 최대로 드러내는 질문 선택
  const minimaxResult = await selectMinimaxQuestion(
    soongsilApiKey,
    geminiApiKey,
    session,
    evaluation,
    bookText,
    latestStudentAnswer,
    selectedAction,
    recentTutorActions,
  );

  if (minimaxResult) {
    return minimaxResult;
  }

  // Fallback: single-shot generation (기존 로직)
  const systemPrompt = buildTutorPrompt(
    session,
    evaluation,
    bookText,
    latestStudentAnswer,
    selectedAction,
    recentTutorActions,
  );

  try {
    const result = await callAIJSON<TutorResponse>(
      soongsilApiKey,
      geminiApiKey,
      systemPrompt,
      `selected_action=${selectedAction} 기준으로 한 턴 질문을 생성하세요.`,
      { temperature: 0.7, maxTokens: 1000 },
    );

    return {
      aiReply: result.aiReply || getFallbackMessageByAction(
        selectedAction, latestStudentAnswer,
        (session.conversationHistory || []).filter(m => m.role === 'ai').slice(-3).map(m => m.content),
      ),
      questionType: normalizeQuestionType(result.questionType, selectedAction),
    };
  } catch (error) {
    console.error('Tutor generation error:', error);
    return {
      aiReply: getFallbackMessageByAction(
        selectedAction, latestStudentAnswer,
        (session.conversationHistory || []).filter(m => m.role === 'ai').slice(-3).map(m => m.content),
      ),
      questionType: ACTION_TO_QUESTION[selectedAction] || 'evidence_request',
    };
  }
}

// =============================================
// 🔵 v10.0: Minimax Socratic Questioning
// Game-theoretic question selection:
// 1. Generate 3 candidate questions (temperature 0.9 for diversity)
// 2. For each, simulate student's defense via lightweight GPT-5 Nano call
// 3. Pick the question where simulated defense score is LOWEST
//    (= most incisive question that hits the weakest spot)
//
// Minimax formula: argmin_q [ E[defense_score | q] ]
// Total extra tokens: ~3 * (500 gen + 200 sim) = ~2,100 tokens overhead
// =============================================
async function selectMinimaxQuestion(
  soongsilApiKey: string,
  geminiApiKey: string | undefined,
  session: SessionState,
  evaluation: EvaluationResult,
  bookText: string,
  latestStudentAnswer: string,
  selectedAction: string,
  recentTutorActions: string[],
): Promise<TutorResponse | null> {
  try {
    // Step 1: Generate 3 diverse question candidates
    const systemPrompt = buildTutorPrompt(
      session, evaluation, bookText, latestStudentAnswer,
      selectedAction, recentTutorActions,
    );

    const candidatePrompt = `
      selected_action=${selectedAction} 기준으로 서로 다른 질문 3개를 JSON 배열로 생성하세요.
      각 질문은 학생의 논리적 허점을 다른 각도에서 공략합니다.
      응답 형식: { "candidates": [{"aiReply": "질문1", "angle": "공략 각도"}, {"aiReply": "질문2", "angle": "공략 각도"}, {"aiReply": "질문3", "angle": "공략 각도"}] }
    `.trim();

    const candidatesResult = await callAIJSON<{
      candidates: Array<{ aiReply: string; angle: string }>;
    }>(
      soongsilApiKey, geminiApiKey,
      systemPrompt, candidatePrompt,
      { temperature: 0.9, maxTokens: 1200 },
    );

    const candidates = candidatesResult.candidates;
    if (!Array.isArray(candidates) || candidates.length < 2) {
      return null; // Not enough candidates, fallback to single-shot
    }

    // Step 2: Simulate student defense for each candidate
    // Using lightweight GPT-5 Nano: "학생이 이 질문을 받으면 방어 점수가 몇 점?"
    const simPrompt = `당신은 학생 시뮬레이터입니다. 현재 학생의 상태:
- 주제: ${session.topic || '독서 토론'}
- 학생의 마지막 답변 요약: ${latestStudentAnswer.substring(0, 150)}
- 현재 약점: evidence=${evaluation.radarScores?.evidence ?? 50}, defense=${evaluation.radarScores?.defense ?? 50}

각 질문에 대해 학생이 얼마나 잘 방어할 수 있을지 1-100 점수를 예측하세요.
점수가 낮을수록 학생이 방어하기 어려운(=더 날카로운) 질문입니다.
응답 형식: { "scores": [점수1, 점수2, 점수3] }`;

    const questionsText = candidates.map((c, i) => `질문${i + 1}: ${c.aiReply}`).join('\n');

    const simResult = await callAIJSON<{ scores: number[] }>(
      soongsilApiKey, geminiApiKey,
      simPrompt, questionsText,
      { temperature: 0.3, maxTokens: 200 },
    );

    const scores = simResult.scores;
    if (!Array.isArray(scores) || scores.length !== candidates.length) {
      // Simulation failed, use first candidate
      return {
        aiReply: candidates[0].aiReply,
        questionType: normalizeQuestionType(undefined, selectedAction),
      };
    }

    // Step 3: Minimax selection — pick question with LOWEST defense score
    // argmin_q [ E[defense_score | q] ]
    let minIndex = 0;
    let minScore = scores[0];
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] < minScore) {
        minScore = scores[i];
        minIndex = i;
      }
    }

    console.log(`[MINIMAX] Selected Q${minIndex + 1} (defense=${minScore}) from ${scores.join(',')}`);

    return {
      aiReply: candidates[minIndex].aiReply,
      questionType: normalizeQuestionType(undefined, selectedAction),
    };
  } catch (error) {
    console.error('[MINIMAX] Failed, falling back to single-shot:', error);
    return null; // Fallback to normal generation
  }
}

// 🔴 v9.0 Dynamic Bypass Logic
// 학생이 명확한 텍스트 근거(인용부호, 구절 번호 등)를 제시했는데도
// 시스템이 기계적으로 "근거를 대라"고 반복하는 Blind Tutor 현상 방지
function checkDynamicBypass(
  session: SessionState,
  evaluation: EvaluationResult,
  studentAnswer: string,
): { shouldBypass: boolean; bypassAction?: string; reason?: string } {
  // 패턴 1: 인용 부호/구절 표시 감지 (" ", [ ], 절, 장, 권)
  const citationPatterns = /[""「」『』\[\]]|\d+[권장절편부]|제\d+|프롤로그|에필로그|서문|본문|\[.*?\]/;
  const hasExplicitCitation = citationPatterns.test(studentAnswer);

  // 패턴 2: 평가자(Agent B)가 evidence 점수를 충분히 높게 줌
  const evidenceScoreHigh = (evaluation.radarScores?.evidence ?? 0) >= 40;

  // 패턴 3: evidenceFound가 true
  const evidenceDetected = evaluation.evidenceFound === true;

  // 패턴 4: 학생 답변이 충분히 긴 논증 (최소 50자 이상, 구체적 내용 포함)
  const isSubstantialAnswer = studentAnswer.trim().length >= 50;

  // Dynamic Bypass 조건: 인용 감지 OR (높은 evidence 점수 AND 근거 발견)
  const shouldBypass = (
    (hasExplicitCitation && isSubstantialAnswer) ||
    (evidenceScoreHigh && evidenceDetected) ||
    (hasExplicitCitation && evidenceDetected)
  );

  if (!shouldBypass) {
    return { shouldBypass: false };
  }

  // 바이패스 시: 현재 phase에 따라 다음 심화 단계의 액션 선택
  const phase = session.currentPhase;
  const defenseScore = evaluation.radarScores?.defense ?? 50;
  const consistencyScore = evaluation.radarScores?.consistency ?? 50;

  let bypassAction: string;
  if (phase === 'thesis' || phase === 'opening') {
    // 근거를 이미 제시 → 논리 검증 단계로 점프
    bypassAction = defenseScore < 50 ? 'ask_reasoning' : 'ask_counterexample';
  } else if (phase === 'defense') {
    bypassAction = consistencyScore < 50 ? 'ask_revision' : 'ask_counterexample';
  } else {
    bypassAction = 'move_to_synthesis';
  }

  return {
    shouldBypass: true,
    bypassAction,
    reason: hasExplicitCitation
      ? `학생이 명확한 텍스트 인용을 제시함 → ${bypassAction}로 점프`
      : `평가자가 근거 인식(evidence=${evaluation.radarScores?.evidence}) → ${bypassAction}로 점프`,
  };
}

function selectTutorAction(
  session: SessionState,
  evaluation: EvaluationResult,
  recentTutorActions: string[],
): string {
  let action = (evaluation.recommendedMove || '').trim();

  if (!action) {
    action = inferActionFromScores(evaluation.radarScores);
  }

  // 규칙 기반 보정 (v9.0: evidence 단독 강제를 완화)
  if (evaluation.radarScores.relevance < 35) action = 'narrow_scope';
  // 🔴 v9.0: evidence < 35일 때 무조건 ask_evidence로 강제하지 않음
  // evidenceFound가 true이거나 학생이 인용을 시도한 경우 ask_reasoning으로 전환
  if (evaluation.radarScores.evidence < 35) {
    if (evaluation.evidenceFound) {
      action = 'ask_reasoning'; // 근거는 있으나 약함 → 논리 보강 유도
    } else {
      action = 'ask_evidence';
    }
  }
  if (evaluation.radarScores.consistency < 35) action = 'ask_revision';

  // 최근 2턴과 동일 action 반복 금지
  const last2 = recentTutorActions.slice(-2);
  if (last2.length === 2 && last2.every((a) => a === action)) {
    action = pickAlternativeAction(action, last2);
  } else if (session.lastQuestionType && ACTION_TO_QUESTION[action] === session.lastQuestionType) {
    action = pickAlternativeAction(action, [session.lastQuestionType]);
  }

  return action;
}

function inferActionFromScores(scores: SessionState['radarScores']): string {
  const ordered = [
    { action: 'ask_evidence', score: scores.evidence },
    { action: 'ask_clarification', score: scores.clarity },
    { action: 'ask_reasoning', score: scores.defense },
    { action: 'ask_revision', score: scores.consistency },
    { action: 'narrow_scope', score: scores.relevance },
  ].sort((a, b) => a.score - b.score);

  return ordered[0]?.action || 'ask_reasoning';
}

function pickAlternativeAction(baseAction: string, recent: string[]): string {
  const candidates = ACTION_ROTATION[baseAction] || ['ask_reasoning', 'ask_evidence', 'ask_clarification'];
  return candidates.find((candidate) => !recent.includes(candidate) && ACTION_TO_QUESTION[candidate] !== recent[0]) || candidates[0];
}

function normalizeQuestionType(rawType: string | undefined, action: string): string {
  const allowed = new Set([
    'evidence_request',
    'clarification',
    'counterexample',
    'comparison',
    'premise_tracking',
    'text_return',
    'revision',
  ]);
  if (rawType && allowed.has(rawType)) return rawType;
  return ACTION_TO_QUESTION[action] || 'evidence_request';
}

function inferRecentTutorActions(session: SessionState): string[] {
  const recentAiMessages = (session.conversationHistory || []).filter((m) => m.role === 'ai').slice(-3).map((m) => m.content);
  return recentAiMessages.map((content) => {
    if (/근거|인용|구절/.test(content)) return 'ask_evidence';
    if (/왜|이어지는|추론/.test(content)) return 'ask_reasoning';
    if (/모순|수정|다시/.test(content)) return 'ask_revision';
    if (/반례|예외|만약/.test(content)) return 'ask_counterexample';
    return 'ask_clarification';
  });
}

function getFallbackMessageByAction(
  action: string,
  studentAnswer?: string,
  previousReplies: string[] = [],
): string {
  // v12.0 수정안 F: 학생 답변을 반영한 동적 폴백 생성
  // v12.2: previousReplies로 중복 폴백 필터링
  const phrase = studentAnswer ? studentAnswer.substring(0, 50).trim() : '';
  const hasPhrase = phrase.length > 10;

  const dynamicFallbacks: Record<string, () => string[]> = {
    ask_evidence: () => [
      hasPhrase
        ? `"${phrase}..." — 이 해석을 뒷받침하는 텍스트 문장을 정확히 짚어주실래요?`
        : '지금 주장과 연결되는 텍스트 구절을 한 문장이라도 직접 인용해 주실 수 있을까요?',
      '그 판단을 뒷받침하는 장면이나 문장을 본문에서 찾아 제시해 보시겠어요?',
    ],
    request_text_reference: () => [
      hasPhrase
        ? `"${phrase}..." — 이 주장과 직접 연결되는 텍스트 표현을 정확히 지정해 볼까요?`
        : '본문의 어느 부분을 근거로 삼는지 구절 단위로 짚어 주실 수 있을까요?',
      '지금 답변과 직접 연결되는 텍스트 표현을 정확히 지정해 볼까요?',
    ],
    ask_reasoning: () => [
      hasPhrase
        ? `"${phrase}..."에서 결론까지의 논리적 연결을 단계적으로 설명해 주실래요?`
        : '방금 제시한 근거가 결론으로 이어지는 이유를 한 단계 더 설명해 주실래요?',
      '근거와 주장 사이에 빠진 추론 단계가 있지 않나요?',
    ],
    ask_clarification: () => [
      hasPhrase
        ? `"${phrase}..." — 이 표현을 더 정확하게 한 문장으로 재정의해 주실 수 있나요?`
        : '핵심 주장을 한 문장으로 다시 명확하게 정의해 주실 수 있을까요?',
      '지금 말한 입장의 범위와 조건을 조금 더 구체화해 볼까요?',
    ],
    ask_counterexample: () => [
      hasPhrase
        ? `"${phrase}..."가 성립하지 않는 반대 사례가 있다면 어떻게 되나요?`
        : '만약 반대 사례가 성립한다면, 지금 주장은 어떻게 보완되어야 할까요?',
      '예외 상황 하나를 가정했을 때도 같은 결론이 유지되는지 점검해 보시겠어요?',
      hasPhrase
        ? `"${phrase}..." — 이 주장이 틀릴 수 있는 경우를 하나 들어볼 수 있을까요?`
        : '이 주장이 깨지는 상황을 하나 상상해 본다면, 어떤 경우일까요?',
      '텍스트에서 지금 주장과 정반대 해석을 뒷받침할 수 있는 구절이 혹시 있나요?',
      hasPhrase
        ? `"${phrase}..."의 논리가 다른 맥락에서도 동일하게 성립할까요?`
        : '다른 관점에서 보면 같은 텍스트가 정반대 결론도 지지하지 않나요?',
    ],
    ask_revision: () => [
      hasPhrase
        ? `"${phrase}..."의 약점을 보완해서 더 강한 버전으로 다시 말해 주실 수 있을까요?`
        : '이전 답변의 약점을 보완해서 더 강한 버전으로 다시 말해 주실 수 있을까요?',
      '앞선 주장과 충돌하지 않도록 논지를 재구성해 보시겠어요?',
    ],
    narrow_scope: () => [
      '논점을 한 장면 또는 한 개념으로 좁혀서 다시 답해 주실래요?',
      '지금 주제에서 가장 핵심인 쟁점 하나만 골라 집중해 볼까요?',
    ],
    move_to_synthesis: () => [
      hasPhrase
        ? `"${phrase}..."를 출발점으로, 처음 주장과 지금 주장이 어떻게 달라졌는지 정리해볼까요?`
        : '지금까지의 주장과 근거를 묶어서 최종 입장을 간결하게 정리해 보시겠어요?',
      '핵심 쟁점을 통합해, 한 단계 정교한 결론으로 재구성해 보실래요?',
    ],
  };

  const generator = dynamicFallbacks[action] || dynamicFallbacks.ask_reasoning;
  const pool = generator();
  // v12.2: 이전 응답과 중복되는 폴백 메시지 필터링
  const filtered = pool.filter(msg =>
    !previousReplies.some(prev => prev.includes(msg.substring(0, 25)))
  );
  const candidates = filtered.length > 0 ? filtered : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
