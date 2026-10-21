// D-Plan: Action Selector
// Determines the next tutor action based on evaluation + student model
// Rule-based with priority ordering (not model-dependent)

import type {
  TutorAction,
  TutorState,
  DeepEvaluation,
  StudentModel,
} from './types';

// v10.0: MAB Bandit Policy Engine integration
// If DB is available and Q-Table has sufficient data, use ε-Greedy selection
// Otherwise, fall back to deterministic rule-based selection
export async function selectActionWithBandit(
  db: D1Database | null,
  studentLevelBucket: string,
  input: {
    currentState: TutorState;
    evaluation: DeepEvaluation;
    studentModel: StudentModel;
    studentMessage?: string;
  },
): Promise<{ action: TutorAction; source: 'bandit' | 'rules' }> {
  // Priority checks still override bandit (off-topic recovery, etc.)
  const { evaluation: ev, studentModel: sm } = input;
  if (ev.relevance <= 2) return { action: 'narrow_scope', source: 'rules' };
  const repeatedAction = checkRepeatedWeaknessOverride(sm);
  if (repeatedAction) return { action: repeatedAction, source: 'rules' };

  // Try MAB if DB available
  if (db) {
    try {
      const { selectActionViaBandit } = await import('../mab-engine');
      const availableActions: TutorAction[] = [
        'ask_evidence', 'ask_reasoning', 'ask_clarification',
        'ask_counterexample', 'ask_revision', 'narrow_scope',
        'give_hint', 'request_text_reference', 'move_to_synthesis',
      ];
      const decision = await selectActionViaBandit(db, studentLevelBucket, availableActions);
      if (decision.isExploit && decision.avgReward !== null && decision.avgReward > 0.3) {
        return { action: decision.selectedAction as TutorAction, source: 'bandit' };
      }
    } catch (e) {
      console.error('[MAB] Bandit selection failed, using rules:', e);
    }
  }

  // Fallback: deterministic rules
  return { action: selectAction(input), source: 'rules' };
}

// =============================================
// Priority-based Action Selection (Deterministic)
// =============================================
export function selectAction(input: {
  currentState: TutorState;
  evaluation: DeepEvaluation;
  studentModel: StudentModel;
  studentMessage?: string; // v9.0: Dynamic Bypass를 위해 학생 메시지 전달
}): TutorAction {
  const { currentState, evaluation: ev, studentModel: sm, studentMessage } = input;

  // --- Priority 0 (v9.0): Dynamic Bypass ---
  // 학생이 이미 명확한 텍스트 근거를 제시한 경우, grounding에서 reasoning으로 즉시 점프
  if (studentMessage) {
    const bypassCheck = detectEvidenceInMessage(studentMessage, ev);
    if (bypassCheck.hasEvidence) {
      // grounding 상태에서 근거를 제시했으면 reasoning으로 바로 이동
      if (currentState === 'grounding' || currentState === 'elicitation') {
        if (ev.reasoning_strength <= 2) return 'ask_reasoning';
        return 'ask_counterexample';
      }
    }
  }

  // --- Priority 1: Off-topic recovery ---
  if (ev.relevance <= 2) {
    return 'narrow_scope';
  }

  // --- Priority 2: Repeated weakness override ---
  const repeatedAction = checkRepeatedWeaknessOverride(sm);
  if (repeatedAction) {
    return repeatedAction;
  }

  // --- Priority 3: State-specific rules ---
  switch (currentState) {
    case 'elicitation':
      if (ev.claim_clarity <= 2) return 'ask_clarification';
      // v9.0: evidence_detected가 있으면 ask_evidence 대신 ask_reasoning
      if (ev.evidence_use <= 2) {
        if (ev.evidence_detected && ev.evidence_detected.length > 0) return 'ask_reasoning';
        return 'ask_evidence';
      }
      return 'ask_evidence';

    case 'grounding':
      // v9.0: Benefit of the Doubt - evidence_detected가 있으면 reasoning으로 이동
      if (ev.evidence_use <= 2) {
        if (ev.evidence_detected && ev.evidence_detected.length > 0) return 'ask_reasoning';
        return 'request_text_reference';
      }
      if (ev.claim_clarity <= 2) return 'ask_clarification';
      return 'ask_reasoning';

    case 'reasoning':
      if (ev.reasoning_strength <= 2) return 'ask_reasoning';
      if (ev.consistency <= 2) return 'ask_revision';
      if (ev.evidence_use <= 2) return 'ask_evidence';
      return 'ask_counterexample';

    case 'counterexample':
      if (ev.reasoning_strength <= 2) return 'ask_revision';
      if (ev.consistency <= 3) return 'ask_revision';
      return 'move_to_synthesis';

    case 'revision':
      if (ev.claim_clarity <= 2) return 'ask_clarification';
      if (ev.evidence_use <= 2) {
        if (ev.evidence_detected && ev.evidence_detected.length > 0) return 'ask_reasoning';
        return 'request_text_reference';
      }
      if (ev.reasoning_strength <= 2) return 'ask_reasoning';
      return 'move_to_synthesis';

    case 'synthesis':
      return 'move_to_synthesis';

    default:
      return 'ask_reasoning';
  }
}

// v9.0: 학생 메시지에서 인용/근거 패턴을 직접 감지
function detectEvidenceInMessage(
  message: string,
  ev: DeepEvaluation,
): { hasEvidence: boolean } {
  // 패턴: 인용부호, 구절 번호, 권/장/절 언급
  const citationPatterns = /[""“”「」『』\[\]]|\d+[\s]?[권장절편부]|제\s?\d+|프롤로그|에필로그/;
  const hasExplicitCitation = citationPatterns.test(message);
  const hasDetectedEvidence = ev.evidence_detected && ev.evidence_detected.length > 0;
  return { hasEvidence: hasExplicitCitation || !!hasDetectedEvidence };
}

// =============================================
// Repeated Weakness Override Rules
// =============================================
function checkRepeatedWeaknessOverride(
  sm: StudentModel,
): TutorAction | null {
  const counts = sm.repeatedWeaknessCounts;

  // '근거 부족' repeated 2+ times → give_hint
  if ((counts['근거 부족'] || 0) >= 2 && sm.helpLevel < 3) {
    return 'give_hint';
  }

  // '질문 이탈' repeated 2+ times → narrow_scope
  if ((counts['질문 이탈'] || 0) >= 2) {
    return 'narrow_scope';
  }

  // '모순 발생' repeated 2+ times → ask_revision
  if ((counts['모순 발생'] || 0) >= 2) {
    return 'ask_revision';
  }

  // '추상어 과다' repeated 2+ times → request_text_reference
  if ((counts['추상어 과다'] || 0) >= 2) {
    return 'request_text_reference';
  }

  // '결론만 제시' repeated 2+ times → ask_evidence
  if ((counts['결론만 제시'] || 0) >= 2) {
    return 'ask_evidence';
  }

  // '추론 비약' repeated 2+ times → ask_reasoning
  if ((counts['추론 비약'] || 0) >= 2) {
    return 'ask_reasoning';
  }

  return null;
}

// =============================================
// Get Action Description (for UI display)
// =============================================
export function getActionDescription(action: TutorAction): string {
  const descriptions: Record<TutorAction, string> = {
    ask_evidence: '텍스트 근거 요청',
    ask_reasoning: '추론 연결 검증',
    ask_clarification: '주장 명료화 요청',
    ask_counterexample: '반례/예외 검토',
    narrow_scope: '범위 축소 유도',
    give_hint: '단계별 힌트 제공',
    request_text_reference: '텍스트 참조 요청',
    ask_revision: '자기 수정 유도',
    move_to_synthesis: '종합 정리 유도',
  };
  return descriptions[action] || action;
}

// =============================================
// Prevent Same Action Repeat
// =============================================
export function adjustForRepetition(
  action: TutorAction,
  lastAction: TutorAction | null,
  evaluation: DeepEvaluation,
): TutorAction {
  // If same action as last turn, try alternative
  if (action === lastAction) {
    // Find the weakest score and pivot
    const scores = [
      { key: 'ask_clarification' as TutorAction, val: evaluation.claim_clarity },
      { key: 'ask_evidence' as TutorAction, val: evaluation.evidence_use },
      { key: 'ask_reasoning' as TutorAction, val: evaluation.reasoning_strength },
    ];

    const weakest = scores
      .filter(s => s.key !== action)
      .sort((a, b) => a.val - b.val)[0];

    if (weakest && weakest.val <= 3) {
      return weakest.key;
    }
  }

  return action;
}
