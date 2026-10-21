// ======================================================
// SocraticAI v27 — ArguNet Dialogue Act Classification Service
// UPGRADED: Rule-based → LLM-based classification (v27 P0)
// Based on Stefano Mezza (UNSW) ArguNet model
// Reference: aclanthology.org/2024.argmining-1.4.pdf
// ISO 24617-2 Dialogue Act standard implementation
// ======================================================

import type { DialogueActClassification, ArgumentNode, ArgumentRelation, OAMFProcessResult } from '../types/d1-rows';
import { callAIJSONWithEnv } from './ai-client';

// ArguNet DA taxonomy based on ISO 24617-2 (fallback patterns)
const DA_TAXONOMY: Record<string, { weight: number; patterns: RegExp[] }> = {
  claim: { weight: 1.0, patterns: [/주장|생각|의견|판단|결론|확신|분명|틀림없/] },
  evidence: { weight: 1.2, patterns: [/연구|데이터|통계|조사|실험|결과|사례|보고서|논문|근거/] },
  rebuttal: { weight: 1.3, patterns: [/반박|그러나|하지만|반대|틀린|동의하지|반론|오류/] },
  question: { weight: 0.8, patterns: [/\?|왜|어떻게|무엇|어디|누가|언제|질문/] },
  concession: { weight: 0.9, patterns: [/인정|동의|맞는|사실|맞다|그렇긴|일리가/] },
  clarification: { weight: 0.7, patterns: [/즉|다시 말해|풀어서|정리하면|명확히|구체적/] },
  challenge: { weight: 1.4, patterns: [/과연|정말|확실|증명|입증|근거가|어떤 근거/] },
  counter_claim: { weight: 1.5, patterns: [/오히려|반대로|역으로|대안|다른 관점|새로운/] }
};

const VALID_ACT_TYPES = ['question', 'claim', 'evidence', 'rebuttal', 'concession', 'clarification', 'challenge', 'counter_claim'] as const;

/**
 * v27: LLM-based Dialogue Act Classifier
 * Primary: Uses AI model for ISO 24617-2 classification
 * Fallback: Pattern matching when LLM unavailable
 */
export async function classifyDialogueActLLM(
  utterance: string,
  previousActs: DialogueActClassification[] = [],
  turnIndex: number = 0,
  env?: Record<string, unknown>
): Promise<DialogueActClassification> {
  // Try LLM-based classification first
  if (env) {
    try {
      const previousContext = previousActs.length > 0
        ? `이전 대화 행위 시퀀스: ${previousActs.slice(-3).map(a => a.actType).join(' → ')}`
        : '대화 시작';

      const prompt = `ISO 24617-2 대화 행위(Dialogue Act) 분류를 수행하세요.

${previousContext}
현재 발화 (턴 ${turnIndex + 1}): "${utterance}"

다음 JSON 형식으로 분류 결과를 반환하세요:
{
  "actType": "question | claim | evidence | rebuttal | concession | clarification | challenge | counter_claim 중 하나",
  "confidence": 0.0~1.0 (분류 신뢰도),
  "illocutionaryForce": 0.0~1.0 (화행적 수반력 - 발화의 수행적 강도),
  "reasoning": "분류 이유 (1줄)"
}

분류 기준:
- question: 정보 요청, 질문
- claim: 주장, 의견 표명
- evidence: 근거, 데이터 제시
- rebuttal: 반박, 반론
- concession: 양보, 인정
- clarification: 명확화, 부연
- challenge: 도전, 문제 제기
- counter_claim: 대안 주장, 반대 제안

화행적 수반력(illocutionary force):
- 강한 주장/도전 → 높은 값 (0.7~1.0)
- 중립적 진술/질문 → 중간 값 (0.4~0.6)
- 양보/명확화 → 낮은 값 (0.2~0.4)`;

      const result = await callAIJSONWithEnv<{
        actType: string;
        confidence: number;
        illocutionaryForce: number;
        reasoning?: string;
      }>(env, 'You are an ISO 24617-2 Dialogue Act classifier for educational argumentation analysis. Always respond in valid JSON only.', prompt, { temperature: 0.3 });

      // Validate and sanitize result
      const actType = VALID_ACT_TYPES.includes(result.actType as typeof VALID_ACT_TYPES[number])
        ? result.actType
        : 'claim';
      
      const confidence = Math.max(0, Math.min(1, result.confidence ?? 0.5));
      const illocutionaryForce = Math.max(0, Math.min(1, result.illocutionaryForce ?? 0.5));

      return {
        actType: actType as DialogueActClassification['actType'],
        confidence: Math.round(confidence * 100) / 100,
        illocutionaryForce: Math.round(illocutionaryForce * 100) / 100,
        argunetScore: Math.round((confidence * illocutionaryForce) * 100) / 100,
        llmClassified: true,
        reasoning: result.reasoning || ''
      };
    } catch (llmError) {
      console.warn('[ArguNet-DA] LLM classification failed, falling back to rules:', llmError);
    }
  }

  // Fallback: Pattern-based classification
  return classifyDialogueAct(utterance, previousActs, turnIndex);
}

/**
 * Rule-based fallback classifier (v26 legacy)
 */
export function classifyDialogueAct(
  utterance: string,
  previousActs: DialogueActClassification[] = [],
  turnIndex: number = 0
): DialogueActClassification {
  const scores: Record<string, number> = {};
  let totalScore = 0;

  for (const [actType, config] of Object.entries(DA_TAXONOMY)) {
    let score = 0;
    for (const pattern of config.patterns) {
      if (pattern.test(utterance)) {
        score += config.weight;
      }
    }
    if (previousActs.length > 0) {
      const lastAct = previousActs[previousActs.length - 1];
      if (lastAct.actType === 'question' && (actType === 'claim' || actType === 'evidence')) {
        score += 0.3;
      }
      if (lastAct.actType === 'claim' && actType === 'rebuttal') {
        score += 0.4;
      }
    }
    scores[actType] = score;
    totalScore += score;
  }

  if (totalScore === 0) {
    scores['claim'] = 1.0;
    totalScore = 1.0;
  }

  let topAct = 'claim';
  let topScore = 0;
  for (const [actType, score] of Object.entries(scores)) {
    if (score > topScore) {
      topScore = score;
      topAct = actType;
    }
  }

  const confidence = Math.min(0.99, topScore / Math.max(totalScore, 0.01));
  const illocutionaryForce = calculateIllocutionaryForce(utterance, topAct, turnIndex);

  return {
    actType: topAct as DialogueActClassification['actType'],
    confidence: Math.round(confidence * 100) / 100,
    illocutionaryForce: Math.round(illocutionaryForce * 100) / 100,
    argunetScore: Math.round((confidence * illocutionaryForce) * 100) / 100,
    llmClassified: false
  };
}

function calculateIllocutionaryForce(
  utterance: string,
  actType: string,
  turnIndex: number
): number {
  let force = 0.5;
  const wordCount = utterance.split(/\s+/).length;
  if (wordCount > 50) force += 0.15;
  else if (wordCount > 20) force += 0.08;
  if (/반드시|절대|확실히|분명히|의심의 여지/.test(utterance)) force += 0.2;
  if (/아마|아마도|어쩌면|~일 수|~겠지/.test(utterance)) force -= 0.1;
  const forceMultipliers: Record<string, number> = {
    challenge: 1.3, counter_claim: 1.2, rebuttal: 1.2,
    evidence: 1.1, claim: 1.0, question: 0.7,
    concession: 0.6, clarification: 0.5
  };
  force *= (forceMultipliers[actType] || 1.0);
  force += Math.min(0.1, turnIndex * 0.01);
  return Math.max(0, Math.min(1, force));
}

/**
 * v27: LLM-enhanced Argument Mining Pipeline
 * Uses LLM for argument extraction + relation classification
 */
export async function processArgumentMiningPipelineLLM(
  utterances: string[],
  existingGraph?: Record<string, unknown>,
  env?: Record<string, unknown>
): Promise<OAMFProcessResult> {
  const allDAs: DialogueActClassification[] = [];
  const allNodes: ArgumentNode[] = [];
  const allRelations: ArgumentRelation[] = [];
  const tokens: string[] = [];

  // Stage 1 & 2: Tokenize and classify each utterance
  for (let idx = 0; idx < utterances.length; idx++) {
    const utterance = utterances[idx];
    const sentenceTokens = utterance.split(/[.!?。]+/).filter(s => s.trim());
    tokens.push(...sentenceTokens);

    // v27: Use LLM classification when available
    const da = env
      ? await classifyDialogueActLLM(utterance, allDAs, idx, env)
      : classifyDialogueAct(utterance, allDAs, idx);
    allDAs.push(da);

    // Stage 3: Argument Extraction
    sentenceTokens.forEach((sentence, sentIdx) => {
      const trimmed = sentence.trim();
      if (trimmed.length < 5) return;
      const node: ArgumentNode = {
        id: `arg_${idx}_${sentIdx}`,
        text: trimmed,
        type: mapDAToNodeType(da.actType),
        confidence: da.confidence,
        toulminRole: mapDAToToulmin(da.actType)
      };
      allNodes.push(node);
    });
  }

  // Stage 4: LLM-enhanced Relation Classification
  if (env && allNodes.length >= 2) {
    try {
      const nodesSummary = allNodes.map(n => `[${n.id}] ${n.type}: "${n.text.substring(0, 50)}"`).join('\n');
      const relPrompt = `다음 논증 노드들 사이의 관계를 분석하세요:\n${nodesSummary}\n\n각 인접 노드 쌍의 관계를 JSON 배열로 반환:\n[{"sourceId":"...", "targetId":"...", "type":"support|attack", "strength": 0.0-1.0}]`;
      
      const relResult = await callAIJSONWithEnv<ArgumentRelation[]>(
        env,
        'Analyze argument relations. Return JSON array only.',
        relPrompt,
        { temperature: 0.2 }
      );

      if (Array.isArray(relResult)) {
        const validNodeIds = new Set(allNodes.map(n => n.id));
        relResult.forEach(r => {
          if (validNodeIds.has(r.sourceId) && validNodeIds.has(r.targetId)) {
            allRelations.push({
              sourceId: r.sourceId,
              targetId: r.targetId,
              type: r.type === 'attack' ? 'attack' : 'support',
              strength: Math.max(0, Math.min(1, r.strength || 0.5))
            });
          }
        });
      }
    } catch (e) { console.error("[P1-004] Caught:", e);
      // Fallback to rule-based relations
      for (let i = 1; i < allNodes.length; i++) {
        const relation = classifyRelation(allNodes[i], allNodes[i - 1], allDAs);
        if (relation) allRelations.push(relation);
      }
    }
  } else {
    // Rule-based fallback
    for (let i = 1; i < allNodes.length; i++) {
      const relation = classifyRelation(allNodes[i], allNodes[i - 1], allDAs);
      if (relation) allRelations.push(relation);
    }
  }

  const xaifGraph = buildXAIFGraph(allNodes, allRelations, allDAs);

  return {
    tokens,
    dialogueActs: allDAs,
    arguments: allNodes,
    relations: allRelations,
    xaifGraph
  };
}

/**
 * v26 compatible wrapper (non-LLM)
 */
export function processArgumentMiningPipeline(
  utterances: string[],
  existingGraph?: Record<string, unknown>
): OAMFProcessResult {
  const allDAs: DialogueActClassification[] = [];
  const allNodes: ArgumentNode[] = [];
  const allRelations: ArgumentRelation[] = [];
  const tokens: string[] = [];

  utterances.forEach((utterance, idx) => {
    const sentenceTokens = utterance.split(/[.!?。]+/).filter(s => s.trim());
    tokens.push(...sentenceTokens);
    const da = classifyDialogueAct(utterance, allDAs, idx);
    allDAs.push(da);
    sentenceTokens.forEach((sentence, sentIdx) => {
      const trimmed = sentence.trim();
      if (trimmed.length < 5) return;
      const node: ArgumentNode = {
        id: `arg_${idx}_${sentIdx}`,
        text: trimmed,
        type: mapDAToNodeType(da.actType),
        confidence: da.confidence,
        toulminRole: mapDAToToulmin(da.actType)
      };
      allNodes.push(node);
    });
  });

  for (let i = 1; i < allNodes.length; i++) {
    const relation = classifyRelation(allNodes[i], allNodes[i - 1], allDAs);
    if (relation) allRelations.push(relation);
  }

  return { tokens, dialogueActs: allDAs, arguments: allNodes, relations: allRelations, xaifGraph: buildXAIFGraph(allNodes, allRelations, allDAs) };
}

function mapDAToNodeType(actType: string): ArgumentNode['type'] {
  const mapping: Record<string, ArgumentNode['type']> = {
    claim: 'claim', evidence: 'evidence', rebuttal: 'premise',
    question: 'premise', concession: 'premise', clarification: 'premise',
    challenge: 'claim', counter_claim: 'conclusion'
  };
  return mapping[actType] || 'claim';
}

function mapDAToToulmin(actType: string): ArgumentNode['toulminRole'] {
  const mapping: Record<string, ArgumentNode['toulminRole']> = {
    claim: 'claim', evidence: 'data', rebuttal: 'rebuttal',
    question: 'qualifier', concession: 'qualifier', clarification: 'warrant',
    challenge: 'qualifier', counter_claim: 'claim'
  };
  return mapping[actType] || 'claim';
}

function classifyRelation(
  source: ArgumentNode,
  target: ArgumentNode,
  das: DialogueActClassification[]
): ArgumentRelation | null {
  let type: ArgumentRelation['type'] = 'support';
  let strength = 0.5;

  if (source.type === 'evidence' && target.type === 'claim') {
    type = 'support'; strength = 0.8;
  } else if (source.type === 'premise' && source.toulminRole === 'rebuttal') {
    type = 'attack'; strength = 0.7;
  } else if (source.type === 'conclusion') {
    type = 'support'; strength = 0.6;
  }

  if (strength < 0.3) return null;

  return {
    sourceId: source.id,
    targetId: target.id,
    type,
    strength: Math.round(strength * 100) / 100
  };
}

function buildXAIFGraph(
  nodes: ArgumentNode[],
  relations: ArgumentRelation[],
  das: DialogueActClassification[]
): Record<string, unknown> {
  return {
    AIF: {
      nodes: nodes.map(n => ({
        nodeID: n.id,
        text: n.text,
        type: n.type === 'claim' ? 'I' : n.type === 'evidence' ? 'I' : 'L',
        timestamp: new Date().toISOString()
      })),
      edges: relations.map((r, i) => ({
        edgeID: `edge_${i}`,
        fromID: r.sourceId,
        toID: r.targetId,
        formEdgeID: null
      })),
      schemeFulfillments: relations.map((r, i) => ({
        schemeID: `scheme_${i}`,
        type: r.type === 'support' ? 'RA' : 'CA',
        strength: r.strength
      }))
    },
    dialogueActs: das,
    metadata: {
      version: 'xAIF-2.0',
      processor: 'SocraticAI-oAMF-v27-LLM',
      timestamp: new Date().toISOString(),
      nodeCount: nodes.length,
      edgeCount: relations.length,
      llmEnhanced: das.some((d) => d.llmClassified === true)
    }
  };
}
