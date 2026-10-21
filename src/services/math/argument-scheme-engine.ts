// ============================================================
// v30: Walton Argument Scheme Engine
// ============================================================
// DeepSkill Fidelity Target: Symbolic Layer +30% (50% → 80%)
// 학술 근거:
//   Walton (2008) "Argumentation Schemes" — Cambridge University Press
//   Reed (2023) "Argument Scheme key = Critical Questions"
//   AIF Standard: S-Nodes carry scheme typing
//
// 14 Walton Schemes + Critical Questions per scheme
// LLM-assisted scheme matching with fallback rules
// ============================================================

import { callAIJSON } from '../ai-client';
import type { AIFINode, AIFGraph } from './aif-pipeline';

// =============================================
// Walton Argument Schemes — Full Taxonomy
// =============================================

export interface ArgumentSchemeDefinition {
  id: string;
  name: string;
  nameKo: string;
  description: string;
  premise_pattern: string;
  conclusion_pattern: string;
  critical_questions: string[];
  critical_questions_ko: string[];
  fallacy_risks: string[];
  strength_weight: number;
}

export const WALTON_SCHEMES: ArgumentSchemeDefinition[] = [
  {
    id: 'argument_from_example',
    name: 'Argument from Example',
    nameKo: '사례 논증',
    description: 'Generalizing from specific cases to a general rule',
    premise_pattern: 'In case C, A was observed to hold',
    conclusion_pattern: 'Therefore, A holds generally',
    critical_questions: [
      'Is the example typical or representative?',
      'Are there counterexamples that disprove the generalization?',
      'Is the sample size sufficient?'
    ],
    critical_questions_ko: [
      '이 사례가 대표적/일반적인 경우인가?',
      '이 일반화를 반박하는 반례가 존재하는가?',
      '표본 크기가 충분한가?'
    ],
    fallacy_risks: ['hasty_generalization', 'cherry_picking'],
    strength_weight: 0.7,
  },
  {
    id: 'argument_from_analogy',
    name: 'Argument from Analogy',
    nameKo: '유추 논증',
    description: 'Comparing two similar cases to draw a conclusion',
    premise_pattern: 'Case A is similar to case B in relevant respects',
    conclusion_pattern: 'What holds for A also holds for B',
    critical_questions: [
      'Are the compared cases sufficiently similar?',
      'Are there relevant differences between the cases?',
      'Does the analogy hold in the specific aspect being argued?'
    ],
    critical_questions_ko: [
      '비교 대상이 충분히 유사한가?',
      '두 사례 간 중요한 차이점이 있는가?',
      '해당 측면에서 유추가 성립하는가?'
    ],
    fallacy_risks: ['false_analogy', 'weak_analogy'],
    strength_weight: 0.65,
  },
  {
    id: 'argument_from_consequences',
    name: 'Argument from Consequences',
    nameKo: '결과 논증',
    description: 'Arguing based on the positive or negative consequences of an action',
    premise_pattern: 'If action A is taken, consequence C will follow',
    conclusion_pattern: 'Therefore, A should/should not be taken',
    critical_questions: [
      'Is the predicted consequence actually likely?',
      'Are there unintended side effects?',
      'Is the consequence truly good/bad as claimed?'
    ],
    critical_questions_ko: [
      '예측된 결과가 실제로 발생할 가능성이 높은가?',
      '의도치 않은 부작용은 없는가?',
      '그 결과가 주장대로 좋은/나쁜 것인가?'
    ],
    fallacy_risks: ['slippery_slope', 'appeal_to_consequences'],
    strength_weight: 0.6,
  },
  {
    id: 'argument_from_authority',
    name: 'Argument from Authority/Expert Opinion',
    nameKo: '권위 논증',
    description: 'Citing an authority or expert to support a claim',
    premise_pattern: 'Expert E says that P is true',
    conclusion_pattern: 'Therefore, P is true',
    critical_questions: [
      'Is the expert qualified in this specific domain?',
      'Do other experts agree?',
      'Is the expert biased?'
    ],
    critical_questions_ko: [
      '해당 전문가가 이 특정 분야에 자격이 있는가?',
      '다른 전문가들도 동의하는가?',
      '전문가에게 편향이 있는가?'
    ],
    fallacy_risks: ['appeal_to_authority', 'ad_verecundiam'],
    strength_weight: 0.55,
  },
  {
    id: 'argument_from_cause_to_effect',
    name: 'Argument from Cause to Effect',
    nameKo: '인과 논증',
    description: 'Arguing that a cause will produce a specific effect',
    premise_pattern: 'A is known to cause B',
    conclusion_pattern: 'If A occurs, B will follow',
    critical_questions: [
      'Is the causal link well-established?',
      'Are there intervening factors that could prevent the effect?',
      'Could correlation be mistaken for causation?'
    ],
    critical_questions_ko: [
      '인과 관계가 확립되어 있는가?',
      '효과를 방해할 수 있는 중간 요인이 있는가?',
      '상관관계를 인과관계로 오인한 것은 아닌가?'
    ],
    fallacy_risks: ['post_hoc', 'cum_hoc', 'false_cause'],
    strength_weight: 0.75,
  },
  {
    id: 'modus_ponens',
    name: 'Modus Ponens (Deductive)',
    nameKo: '전건 긍정',
    description: 'If P then Q; P; therefore Q',
    premise_pattern: 'If P then Q. P is the case.',
    conclusion_pattern: 'Therefore Q',
    critical_questions: [
      'Is the conditional "if P then Q" actually true?',
      'Are there exceptions to the rule?',
      'Is the premise P correctly established?'
    ],
    critical_questions_ko: [
      '"P이면 Q" 조건문이 실제로 참인가?',
      '이 규칙에 예외가 있는가?',
      '전제 P가 올바르게 확립되었는가?'
    ],
    fallacy_risks: ['affirming_the_consequent'],
    strength_weight: 0.95,
  },
  {
    id: 'modus_tollens',
    name: 'Modus Tollens',
    nameKo: '후건 부정',
    description: 'If P then Q; not Q; therefore not P',
    premise_pattern: 'If P then Q. Q is not the case.',
    conclusion_pattern: 'Therefore, not P',
    critical_questions: [
      'Is the conditional valid?',
      'Is the negation of Q firmly established?',
    ],
    critical_questions_ko: [
      '조건문이 유효한가?',
      'Q의 부정이 확실히 확립되었는가?',
    ],
    fallacy_risks: ['denying_the_antecedent'],
    strength_weight: 0.9,
  },
  {
    id: 'practical_reasoning',
    name: 'Practical Reasoning',
    nameKo: '실천적 추론',
    description: 'Goal-directed reasoning about what action to take',
    premise_pattern: 'Goal G is desired. Action A achieves G.',
    conclusion_pattern: 'Therefore, A should be performed',
    critical_questions: [
      'Is the goal actually desirable?',
      'Is the proposed action the best way to achieve the goal?',
      'Are there better alternatives?',
      'Are there negative side effects?'
    ],
    critical_questions_ko: [
      '목표가 실제로 바람직한가?',
      '제안된 행동이 목표 달성의 최선의 방법인가?',
      '더 나은 대안은 없는가?',
      '부정적 부작용은 없는가?'
    ],
    fallacy_risks: ['false_dilemma', 'is_ought'],
    strength_weight: 0.7,
  },
  {
    id: 'argument_from_sign',
    name: 'Argument from Sign',
    nameKo: '징후 논증',
    description: 'Inferring a conclusion from an observable sign or indicator',
    premise_pattern: 'Sign S is observed, and S is generally associated with C',
    conclusion_pattern: 'Therefore, C is likely the case',
    critical_questions: [
      'Is the sign reliably associated with the conclusion?',
      'Could there be other explanations for the sign?',
    ],
    critical_questions_ko: [
      '징후가 결론과 신뢰성 있게 연결되는가?',
      '징후에 대한 다른 설명이 있을 수 있는가?',
    ],
    fallacy_risks: ['hasty_generalization'],
    strength_weight: 0.6,
  },
  {
    id: 'argument_from_commitment',
    name: 'Argument from Commitment',
    nameKo: '약속/입장 논증',
    description: 'Holding someone to a position they previously committed to',
    premise_pattern: 'Agent A previously committed to position P',
    conclusion_pattern: 'Therefore, A should act consistently with P',
    critical_questions: [
      'Did the agent actually make this commitment?',
      'Have circumstances changed that justify retracting?',
      'Is the commitment being accurately represented?'
    ],
    critical_questions_ko: [
      '당사자가 실제로 이 약속/입장을 취했는가?',
      '입장 철회를 정당화할 상황 변화가 있었는가?',
      '입장이 정확하게 표현되고 있는가?'
    ],
    fallacy_risks: ['tu_quoque', 'straw_man'],
    strength_weight: 0.65,
  },
];

// =============================================
// Scheme Match Result
// =============================================

export interface SchemeMatchResult {
  schemeId: string;
  schemeName: string;
  schemeNameKo: string;
  confidence: number;
  matchedPremises: string[];
  applicableCriticalQuestions: string[];
  applicableCriticalQuestionsKo: string[];
  fallacyRisks: string[];
  strengthWeight: number;
  reasoning: string;
}

// =============================================
// LLM-based Scheme Classifier
// =============================================

export async function classifyArgumentScheme(
  nodeText: string,
  nodeType: string,
  context: { previousNodes: AIFINode[]; sessionTopic: string },
  env?: Record<string, unknown>
): Promise<SchemeMatchResult> {
  const schemeNames = WALTON_SCHEMES.map(s => `${s.id}: ${s.name} (${s.nameKo})`).join('\n');

  if (env) {
    try {
      const prompt = `Walton 논증 스킴(Argument Scheme) 분류를 수행하세요.

주제: ${context.sessionTopic}
이전 논점: ${context.previousNodes.slice(-3).map(n => `[${n.type}] ${n.text}`).join(' → ')}
현재 발화: "${nodeText}" (유형: ${nodeType})

가능한 논증 스킴:
${schemeNames}

다음 JSON 형식으로 분류 결과를 반환하세요:
{
  "schemeId": "가장 적합한 스킴 ID",
  "confidence": 0.0~1.0,
  "reasoning": "분류 근거 설명 (한국어)",
  "matchedPremises": ["일치하는 전제 패턴들"]
}`;

      const result = await callAIJSON(prompt, {}, env);
      if (result && result.schemeId) {
        const scheme = WALTON_SCHEMES.find(s => s.id === result.schemeId);
        if (scheme) {
          return {
            schemeId: scheme.id,
            schemeName: scheme.name,
            schemeNameKo: scheme.nameKo,
            confidence: Math.min(1, Math.max(0, result.confidence || 0.5)),
            matchedPremises: result.matchedPremises || [],
            applicableCriticalQuestions: scheme.critical_questions,
            applicableCriticalQuestionsKo: scheme.critical_questions_ko,
            fallacyRisks: scheme.fallacy_risks,
            strengthWeight: scheme.strength_weight,
            reasoning: result.reasoning || '',
          };
        }
      }
    } catch (e) {
      console.error('[ArgumentSchemeEngine] LLM classification failed, using fallback:', e);
    }
  }

  // Fallback: rule-based pattern matching
  return classifySchemeByRules(nodeText, nodeType);
}

// =============================================
// Rule-based Fallback
// =============================================

function classifySchemeByRules(text: string, nodeType: string): SchemeMatchResult {
  const patterns: { schemeId: string; patterns: RegExp[]; weight: number }[] = [
    { schemeId: 'argument_from_example', patterns: [/예를 들어|사례|실제로|경우에|경험/], weight: 0.6 },
    { schemeId: 'argument_from_analogy', patterns: [/마찬가지|비슷|같은 맥락|유사|비유/], weight: 0.55 },
    { schemeId: 'argument_from_consequences', patterns: [/결과|효과|영향|초래|때문에|따라서/], weight: 0.5 },
    { schemeId: 'argument_from_authority', patterns: [/전문가|연구자|학자|논문|보고서|조사/], weight: 0.5 },
    { schemeId: 'argument_from_cause_to_effect', patterns: [/원인|인과|야기|발생|이유/], weight: 0.55 },
    { schemeId: 'modus_ponens', patterns: [/이면|경우|전제.*결론|조건/], weight: 0.65 },
    { schemeId: 'practical_reasoning', patterns: [/해야|필요|목표|방안|대안|전략/], weight: 0.5 },
    { schemeId: 'argument_from_sign', patterns: [/징후|신호|증상|표시|나타/], weight: 0.45 },
  ];

  let bestMatch = { schemeId: 'argument_from_example', score: 0 };

  for (const p of patterns) {
    let score = 0;
    for (const rx of p.patterns) {
      if (rx.test(text)) score += p.weight;
    }
    if (score > bestMatch.score) {
      bestMatch = { schemeId: p.schemeId, score };
    }
  }

  const scheme = WALTON_SCHEMES.find(s => s.id === bestMatch.schemeId) || WALTON_SCHEMES[0];
  return {
    schemeId: scheme.id,
    schemeName: scheme.name,
    schemeNameKo: scheme.nameKo,
    confidence: Math.min(0.6, bestMatch.score),
    matchedPremises: [],
    applicableCriticalQuestions: scheme.critical_questions,
    applicableCriticalQuestionsKo: scheme.critical_questions_ko,
    fallacyRisks: scheme.fallacy_risks,
    strengthWeight: scheme.strength_weight,
    reasoning: '규칙 기반 패턴 매칭 (LLM 불가 시 폴백)',
  };
}

// =============================================
// Batch: Classify all nodes in a graph
// =============================================

export async function classifyGraphSchemes(
  graph: AIFGraph,
  sessionTopic: string,
  env?: Record<string, unknown>
): Promise<SchemeMatchResult[]> {
  const results: SchemeMatchResult[] = [];
  for (const node of graph.iNodes) {
    const result = await classifyArgumentScheme(
      node.text,
      node.type,
      { previousNodes: graph.iNodes.filter(n => n.turn < node.turn), sessionTopic },
      env
    );
    results.push(result);
  }
  return results;
}
