// =============================================
// AIF (Argument Interchange Format) Pipeline (Option 2B)
// =============================================
// Phase 2 TDD 성공 기준:
//   1. 학생 자연어 → AIF JSON 100% 매핑 (Claim + Premises 누락 없이)
//   2. 주장-근거 간 위상학적 네트워크 자동 계산
//   3. 논리적 결손(Missing Edge) 감지 시 해당 취약점 타겟팅 질문 생성
//
// AIF 표준 구조 (Chris Reed's xAIF):
//   - I-Node (Information Node): 주장, 전제, 결론 등 정보 단위
//   - S-Node (Scheme Node): 추론 스킴 (연역, 귀납, 유추 등)
//   - Edge: I-Node와 S-Node 간의 관계 (support, attack, rephrase)
//
// 경량화 전략 (Cloudflare Workers 환경):
//   - 무거운 NLP 파이프라인(oAMF) 대신 LLM 기반 추출
//   - D1 SQLite에 AIF 노드/엣지 저장
//   - WITH RECURSIVE CTE로 그래프 탐색 (기존 FAF 확장)
//
// 수학적 모델:
//   논증 강도 S(a) = Σ(support_edges) - Σ(attack_edges)
//   Grounded semantics: node is grounded iff all attackers are defeated
//   Missing edge detection: Claim without premise → 결손
// =============================================

import { callAIJSON } from '../ai-client';

// =============================================
// AIF Types (xAIF 표준 경량화)
// =============================================

/** I-Node: 정보 단위 (주장, 전제, 증거, 결론) */
export interface AIFINode {
  id: string;
  type: 'claim' | 'premise' | 'evidence' | 'conclusion' | 'rebuttal';
  text: string;
  author: 'student' | 'tutor';
  turn: number;
  confidence: number;  // 0-1, LLM이 추출한 신뢰도
  sourceRef?: string;  // 텍스트 인용 출처 (page, chapter 등)
}

/** S-Node: 추론 스킴 */
export interface AIFSNode {
  id: string;
  scheme: 'deductive' | 'inductive' | 'analogical' | 'causal' | 'authority';
  description: string;
}

/** Edge: 노드 간 관계 */
export interface AIFEdge {
  id: string;
  from: string;   // source node id
  to: string;     // target node id
  relation: 'support' | 'attack' | 'rephrase' | 'premise_of';
  strength: number;  // 0-1
}

/** AIF Graph: 전체 논증 그래프 */
export interface AIFGraph {
  iNodes: AIFINode[];
  sNodes: AIFSNode[];
  edges: AIFEdge[];
  metadata: {
    sessionId: string;
    turnNumber: number;
    totalNodes: number;
    totalEdges: number;
    missingEdges: MissingEdge[];
    argumentStrength: number;  // 전체 논증 강도 S(a)
  };
}

/** 논리적 결손 */
export interface MissingEdge {
  fromNode: string;
  toNode: string;
  missingType: 'missing_premise' | 'missing_evidence' | 'undefended_claim' | 'circular_logic';
  description: string;
  severity: 'low' | 'medium' | 'high';
  socraticQuestion: string;  // 이 결손을 타겟팅하는 소크라틱 질문
}

// =============================================
// AIF Extraction: 학생 발화 → AIF JSON
// =============================================
// LLM 기반 논증 마이닝:
//   1. 학생 메시지에서 주장(Claim), 전제(Premise), 증거(Evidence) 추출
//   2. 추론 스킴(Scheme) 식별
//   3. 노드 간 관계(Edge) 매핑
//   4. 이전 턴의 AIF 그래프와 병합
// =============================================

export async function extractAIFFromMessage(
  soongsilApiKey: string,
  geminiApiKey: string | undefined,
  message: string,
  context: {
    sessionId: string;
    turnNumber: number;
    author: 'student' | 'tutor';
    previousGraph?: AIFGraph;
    topic: string;
  },
): Promise<{ iNodes: AIFINode[]; sNodes: AIFSNode[]; edges: AIFEdge[] }> {
  const existingNodes = context.previousGraph?.iNodes
    .map(n => `- [${n.id}] ${n.type}: "${n.text.substring(0, 80)}"`)
    .join('\n') || '(없음)';

  const systemPrompt = `당신은 논증 분석 전문가입니다. 자연어 텍스트에서 AIF(Argument Interchange Format) 구조를 추출합니다.

## 추출 규칙
1. **I-Node (정보 노드)**: 텍스트에서 주장(claim), 전제(premise), 증거(evidence), 결론(conclusion), 반박(rebuttal) 식별
2. **S-Node (추론 스킴)**: 연역(deductive), 귀납(inductive), 유추(analogical), 인과(causal), 권위(authority)
3. **Edge (관계)**: support(지지), attack(공격), rephrase(재진술), premise_of(전제 관계)
4. 각 노드에 confidence(0-1) 부여: 명시적 표현=0.9+, 암시적=0.5-0.8

## 기존 논증 그래프의 노드
${existingNodes}

## 출력 형식 (JSON)
{
  "iNodes": [{"id":"i_t{turn}_{idx}","type":"claim|premise|evidence|conclusion|rebuttal","text":"추출된 텍스트","confidence":0.0-1.0,"sourceRef":"출처(있으면)"}],
  "sNodes": [{"id":"s_t{turn}_{idx}","scheme":"deductive|inductive|analogical|causal|authority","description":"추론 설명"}],
  "edges": [{"id":"e_t{turn}_{idx}","from":"노드id","to":"노드id","relation":"support|attack|rephrase|premise_of","strength":0.0-1.0}]
}

없으면 빈 배열 반환. 기존 노드와의 관계도 edge로 포함하세요.`;

  const userPrompt = `주제: ${context.topic}
발화자: ${context.author === 'student' ? '학생' : 'AI 튜터'}
턴: ${context.turnNumber}

텍스트:
"${message}"

위 텍스트에서 AIF 구조를 추출하세요.`;

  try {
    const result = await callAIJSON<{
      iNodes: AIFINode[];
      sNodes: AIFSNode[];
      edges: AIFEdge[];
    }>(
      soongsilApiKey, geminiApiKey,
      systemPrompt, userPrompt,
      { temperature: 0.2, maxTokens: 800 },
    );

    // Sanitize and assign metadata
    const iNodes = (result.iNodes || []).map((n, i) => ({
      ...n,
      id: n.id || `i_t${context.turnNumber}_${i}`,
      author: context.author,
      turn: context.turnNumber,
      confidence: Math.max(0, Math.min(1, n.confidence || 0.5)),
    }));

    const sNodes = (result.sNodes || []).map((n, i) => ({
      ...n,
      id: n.id || `s_t${context.turnNumber}_${i}`,
    }));

    const edges = (result.edges || []).map((e, i) => ({
      ...e,
      id: e.id || `e_t${context.turnNumber}_${i}`,
      strength: Math.max(0, Math.min(1, e.strength || 0.5)),
    }));

    return { iNodes, sNodes, edges };
  } catch (error) {
    console.error('[AIF] Extraction failed:', error);
    // Fallback: 단순 claim 노드 생성
    return {
      iNodes: [{
        id: `i_t${context.turnNumber}_0`,
        type: 'claim',
        text: message.substring(0, 200),
        author: context.author,
        turn: context.turnNumber,
        confidence: 0.3,
      }],
      sNodes: [],
      edges: [],
    };
  }
}

// =============================================
// Rule-based AIF Extraction (No LLM, fast fallback)
// =============================================
// 정규식 + 휴리스틱 기반 빠른 추출
// LLM 호출 실패 시 또는 토큰 절약 시 사용
// =============================================

export function extractAIFRuleBased(
  message: string,
  turnNumber: number,
  author: 'student' | 'tutor',
): { iNodes: AIFINode[]; edges: AIFEdge[] } {
  const iNodes: AIFINode[] = [];
  const edges: AIFEdge[] = [];
  let idx = 0;

  // 주장 감지 패턴
  const claimPatterns = /(?:(?:나는|저는)\s*)?(?:.*(?:라고\s*(?:생각|주장|판단)|라\s*(?:본다|봅니다)|(?:이다|입니다|것이다)(?:$|[.\s])))/g;
  // 근거 감지 패턴
  const evidencePatterns = /(?:(?:텍스트|본문|작품|책)(?:에서|에|의|에는|에선)\s*["""「『]?[^"""」』]{5,}["""」』]?)|(?:\d+[권장절편부페이지쪽]\s*(?:에서|에|의))/g;
  // 인과 관계 패턴
  const causalPatterns = /(?:왜냐하면|그\s*이유는|때문에|따라서|그러므로|결과적으로)/g;

  // Extract claims
  let match;
  const sentences = message.split(/(?<=[.?!。？！])\s*/).filter(s => s.trim().length > 5);

  for (const sentence of sentences) {
    // 인용 증거
    if (evidencePatterns.test(sentence)) {
      evidencePatterns.lastIndex = 0;
      iNodes.push({
        id: `i_${author}_t${turnNumber}_${idx}`,
        type: 'evidence',
        text: sentence.trim(),
        author,
        turn: turnNumber,
        confidence: 0.8,
      });
      idx++;
      continue;
    }

    // 인과/전제
    if (causalPatterns.test(sentence)) {
      causalPatterns.lastIndex = 0;
      iNodes.push({
        id: `i_${author}_t${turnNumber}_${idx}`,
        type: 'premise',
        text: sentence.trim(),
        author,
        turn: turnNumber,
        confidence: 0.6,
      });
      idx++;
      continue;
    }

    // 기본: 주장
    if (sentence.trim().length > 15) {
      iNodes.push({
        id: `i_${author}_t${turnNumber}_${idx}`,
        type: 'claim',
        text: sentence.trim(),
        author,
        turn: turnNumber,
        confidence: 0.5,
      });
      idx++;
    }
  }

  // Build edges: premises support claims
  const claims = iNodes.filter(n => n.type === 'claim');
  const premises = iNodes.filter(n => n.type === 'premise' || n.type === 'evidence');
  for (const premise of premises) {
    if (claims.length > 0) {
      edges.push({
        id: `e_${author}_t${turnNumber}_${edges.length}`,
        from: premise.id,
        to: claims[claims.length - 1].id,
        relation: premise.type === 'evidence' ? 'support' : 'premise_of',
        strength: premise.confidence,
      });
    }
  }

  return { iNodes, edges };
}

// =============================================
// Missing Edge Detection (논리적 결손 분석)
// =============================================
// 그래프 분석:
//   1. Claim without Premise → missing_premise
//   2. Claim without Evidence → missing_evidence
//   3. Claim attacked but not defended → undefended_claim
//   4. A supports B, B supports A → circular_logic
// =============================================

export function detectMissingEdges(graph: AIFGraph): MissingEdge[] {
  const missing: MissingEdge[] = [];
  const { iNodes, edges } = graph;

  for (const node of iNodes) {
    if (node.type !== 'claim' && node.type !== 'conclusion') continue;

    // Check for supporting premises
    const supporters = edges.filter(e =>
      e.to === node.id && (e.relation === 'support' || e.relation === 'premise_of')
    );

    // Check for attacks
    const attackers = edges.filter(e =>
      e.to === node.id && e.relation === 'attack'
    );

    // 1. Claim without premise
    const hasPremise = supporters.some(s => {
      const sourceNode = iNodes.find(n => n.id === s.from);
      return sourceNode?.type === 'premise';
    });

    if (!hasPremise && node.type === 'claim') {
      missing.push({
        fromNode: '?',
        toNode: node.id,
        missingType: 'missing_premise',
        description: `주장 "${node.text.substring(0, 50)}..."에 대한 전제가 없습니다`,
        severity: 'high',
        socraticQuestion: `"${node.text.substring(0, 40)}..."라고 주장하셨는데, 이 주장의 전제(기본 가정)는 무엇인가요?`,
      });
    }

    // 2. Claim without evidence
    const hasEvidence = supporters.some(s => {
      const sourceNode = iNodes.find(n => n.id === s.from);
      return sourceNode?.type === 'evidence';
    });

    if (!hasEvidence && node.type === 'claim') {
      missing.push({
        fromNode: '?',
        toNode: node.id,
        missingType: 'missing_evidence',
        description: `주장 "${node.text.substring(0, 50)}..."을 뒷받침하는 텍스트 근거가 없습니다`,
        severity: 'medium',
        socraticQuestion: `그 주장을 텍스트의 어떤 구절이나 장면이 뒷받침해 줄 수 있을까요?`,
      });
    }

    // 3. Attacked but undefended
    if (attackers.length > 0) {
      const defenses = edges.filter(e => {
        const target = iNodes.find(n => n.id === e.to);
        return attackers.some(a => a.from === e.to) && e.relation === 'attack';
      });

      if (defenses.length < attackers.length) {
        missing.push({
          fromNode: attackers[0].from,
          toNode: node.id,
          missingType: 'undefended_claim',
          description: `주장이 공격받았으나 방어되지 않았습니다`,
          severity: 'high',
          socraticQuestion: `이 반론에 대해 어떻게 방어하실 수 있나요? 반론의 약점은 무엇일까요?`,
        });
      }
    }
  }

  // 4. Circular logic detection
  for (const edge of edges) {
    if (edge.relation !== 'support' && edge.relation !== 'premise_of') continue;
    const reverse = edges.find(e =>
      e.from === edge.to && e.to === edge.from &&
      (e.relation === 'support' || e.relation === 'premise_of')
    );
    if (reverse) {
      missing.push({
        fromNode: edge.from,
        toNode: edge.to,
        missingType: 'circular_logic',
        description: `순환 논리 감지: ${edge.from} ↔ ${edge.to}`,
        severity: 'high',
        socraticQuestion: `A가 B를 증명하고 B가 A를 증명한다면, 실제로 증명된 것은 무엇인가요? 순환을 끊는 독립적 근거를 찾아볼까요?`,
      });
    }
  }

  return missing;
}

// =============================================
// Compute Argument Strength
// =============================================
// S(a) = Σ(support_strength) - Σ(attack_strength)
// Normalized to 0-100 scale
// =============================================

export function computeArgumentStrength(graph: Pick<AIFGraph, 'iNodes' | 'edges'>): number {
  const claims = graph.iNodes.filter(n => n.type === 'claim' || n.type === 'conclusion');
  if (claims.length === 0) return 0;

  let totalStrength = 0;

  for (const claim of claims) {
    const supports = graph.edges
      .filter(e => e.to === claim.id && (e.relation === 'support' || e.relation === 'premise_of'))
      .reduce((sum, e) => sum + e.strength, 0);

    const attacks = graph.edges
      .filter(e => e.to === claim.id && e.relation === 'attack')
      .reduce((sum, e) => sum + e.strength, 0);

    // S(claim) = supports - attacks, clamped to [0, ∞)
    totalStrength += Math.max(0, supports - attacks);
  }

  // Normalize: 각 claim당 최대 strength 2.0 (2개 강한 support) 기준
  const maxPossible = claims.length * 2.0;
  return Math.round(Math.min(100, (totalStrength / maxPossible) * 100));
}

// =============================================
// Build Full AIF Graph
// =============================================

export function buildAIFGraph(
  sessionId: string,
  turnNumber: number,
  currentExtraction: { iNodes: AIFINode[]; sNodes?: AIFSNode[]; edges: AIFEdge[] },
  previousGraph?: AIFGraph,
): AIFGraph {
  const prevINodes = previousGraph?.iNodes || [];
  const prevSNodes = previousGraph?.sNodes || [];
  const prevEdges = previousGraph?.edges || [];

  const allINodes = [...prevINodes, ...currentExtraction.iNodes];
  const allSNodes = [...prevSNodes, ...(currentExtraction.sNodes || [])];
  const allEdges = [...prevEdges, ...currentExtraction.edges];

  const graph: AIFGraph = {
    iNodes: allINodes,
    sNodes: allSNodes,
    edges: allEdges,
    metadata: {
      sessionId,
      turnNumber,
      totalNodes: allINodes.length + allSNodes.length,
      totalEdges: allEdges.length,
      missingEdges: [],
      argumentStrength: 0,
    },
  };

  // Compute missing edges and strength
  graph.metadata.missingEdges = detectMissingEdges(graph);
  graph.metadata.argumentStrength = computeArgumentStrength(graph);

  return graph;
}

// =============================================
// Persist AIF to D1 (extends existing argument_nodes/edges)
// =============================================

import { argumentGraphTables, type ArgumentGraphScope } from '../argument-graph-store';

export async function persistAIFToD1(
  db: D1Database,
  sessionId: string,
  graph: AIFGraph,
  scope: ArgumentGraphScope = 'sparring',
): Promise<void> {
  const tables = argumentGraphTables(scope);
  const statements: D1PreparedStatement[] = [];
  const persistedId = (id: string) => `${sessionId}_${id}`;
  const createdAt = Date.now();

  for (const node of graph.iNodes) {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO ${tables.nodes}
       (id, session_id, turn_number, node_type, content, confidence, metadata_json, author, strength, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    ).bind(
      persistedId(node.id), sessionId, node.turn, `aif_${node.type}`,
      node.text.substring(0, 500), node.confidence,
      JSON.stringify({ author: node.author, sourceRef: node.sourceRef || null }),
      node.author, node.confidence, createdAt,
    ));
  }

  for (const edge of graph.edges) {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO ${tables.edges}
       (id, session_id, from_node_id, to_node_id, relation_type, weight, metadata_json, edge_type_faf, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(
      persistedId(edge.id), sessionId, persistedId(edge.from), persistedId(edge.to),
      `aif_${edge.relation}`, edge.strength, '{}',
      edge.relation === 'attack' ? 'attack' : 'support', createdAt,
    ));
  }

  // D1 batches are transactional: callers must observe a failed graph write.
  if (statements.length > 0) await db.batch(statements);
  // Graph metrics belong to the following xAIF snapshot, not sampled entropy.
}

// =============================================
// v18: xAIF V2 Document Builder (Reed 2025 완전 규격)
// L-node + TA-edge + locutions + participants
// =============================================

import type {
  XAIFDocument, XAIFLNode, XAIFINode, XAIFRANode, XAIFCANode,
  XAIFNode, XAIFTAEdge, XAIFRAEdge, XAIFEdge, XAIFLocution,
  ToulminOverlay, CASSMetrics, DialogueActSummary,
} from './xaif-schema';
import {
  createLNode, createTAEdge, inferArgumentScheme,
  computeCASSMetrics, buildToulminOverlay, serializeToJSONLD,
} from './xaif-schema';

/**
 * v18 xAIF Document 빌더
 * Reed (2025) oAMF 완전 규격: L→TA→I→RA 그래프 구조
 */
export function buildXAIFDocument(
  sessionId: string,
  turnNumber: number,
  studentMessage: string,
  tutorMessage: string,
  legacyGraph: AIFGraph,
  dialogueActSummary?: DialogueActSummary,
  timestamp: number = Date.now(),
): XAIFDocument {
  const nodes: XAIFNode[] = [];
  const edges: XAIFEdge[] = [];
  const locutions: XAIFLocution[] = [];

  // Step 1: L-node 생성 (학생 + 튜터 원본 발화)
  const studentLNode = createLNode(sessionId, turnNumber, 0, studentMessage, 'student', timestamp);
  const tutorLNode = createLNode(sessionId, turnNumber, 1, tutorMessage, 'tutor', timestamp);
  nodes.push(studentLNode, tutorLNode);
  locutions.push(
    { nodeID: studentLNode.nodeID, personID: 'student', timestamp },
    { nodeID: tutorLNode.nodeID, personID: 'tutor', timestamp },
  );

  // Step 2: I-node 생성 (기존 AIF 노드 → xAIF I-node 변환) + TA edge 연결
  let iNodeSeq = 0;
  for (const iNode of legacyGraph.iNodes) {
    const xaifINode: XAIFINode = {
      nodeID: `I_${sessionId}_t${turnNumber}_${iNodeSeq}`,
      type: 'I',
      text: iNode.text,
      scheme: inferArgumentScheme(iNode.text),
      confidence: iNode.confidence || 0.5,
      subtype: iNode.type as XAIFINode['subtype'],
    };
    nodes.push(xaifINode);

    // TA edge: L-node → I-node
    const sourceLNode = iNode.author === 'student' ? studentLNode : tutorLNode;
    edges.push(createTAEdge(sourceLNode.nodeID, xaifINode.nodeID, iNodeSeq));
    iNodeSeq++;
  }

  // Step 3: RA-node (S-Node 변환)
  let raNodeSeq = 0;
  for (const sNode of legacyGraph.sNodes) {
    const raNode: XAIFRANode = {
      nodeID: `RA_${sessionId}_t${turnNumber}_${raNodeSeq}`,
      type: 'RA',
      scheme: (sNode.scheme as XAIFRANode['scheme']) || 'modus_ponens',
      description: sNode.description || '',
      defeasible: true,
    };
    nodes.push(raNode);
    raNodeSeq++;
  }

  // Step 4: CA-node (attack 관계가 있는 경우)
  const attackEdges = legacyGraph.edges.filter(e => e.relation === 'attack');
  for (let i = 0; i < attackEdges.length; i++) {
    const caNode: XAIFCANode = {
      nodeID: `CA_${sessionId}_t${turnNumber}_${i}`,
      type: 'CA',
      description: `Conflict between ${attackEdges[i].from} and ${attackEdges[i].to}`,
    };
    nodes.push(caNode);
  }

  // Step 5: 기존 edges → RA-edge / CA-edge 변환
  for (const edge of legacyGraph.edges) {
    const raEdge: XAIFRAEdge = {
      edgeID: `RAE_${sessionId}_t${turnNumber}_${edge.id}`,
      fromID: `I_${sessionId}_t${turnNumber}_${legacyGraph.iNodes.findIndex(n => n.id === edge.from)}`,
      toID: `I_${sessionId}_t${turnNumber}_${legacyGraph.iNodes.findIndex(n => n.id === edge.to)}`,
      type: edge.relation === 'attack' ? 'CA' : 'RA',
      relation: edge.relation as XAIFRAEdge['relation'],
    };
    // 유효한 노드 참조만 추가
    if (!raEdge.fromID.endsWith('_-1') && !raEdge.toID.endsWith('_-1')) {
      edges.push(raEdge);
    }
  }

  // Step 6: Toulmin 6요소 overlay 빌드 (v18 Backing, Qualifier 포함)
  const toulminOverlay = buildToulminOverlay(nodes, edges);

  // Step 7: 논증 강도 계산
  const iNodes = nodes.filter(n => n.type === 'I') as XAIFINode[];
  const supportEdgeCount = edges.filter(e => 'relation' in e && (e as XAIFRAEdge).relation === 'support').length;
  const attackEdgeCount = edges.filter(e => 'relation' in e && (e as XAIFRAEdge).relation === 'attack').length;
  const argumentStrength = iNodes.length > 0
    ? Math.min(100, Math.round((supportEdgeCount * 30 + iNodes.length * 10) / Math.max(1, attackEdgeCount + 1)))
    : 0;

  // Step 8: 스킴 분포 계산
  const schemeDistribution: Record<string, number> = {};
  for (const node of iNodes) {
    if (node.scheme) {
      schemeDistribution[node.scheme] = (schemeDistribution[node.scheme] || 0) + 1;
    }
  }

  const doc: XAIFDocument = {
    AIF: {
      nodes,
      edges,
      locutions,
      participants: [
        { participantID: 'student', firstname: 'Student', role: 'learner' },
        { participantID: 'tutor', firstname: 'SocraticAI', role: 'tutor' },
      ],
    },
    metadata: {
      sessionId,
      turnNumber,
      timestamp,
      argumentStrength,
      missingEdgeCount: legacyGraph.metadata.missingEdges.length,
      toulminOverlay,
      dialogueActSummary,
      schemeDistribution,
    },
    version: '2.0',
  };

  // Step 9: CASS 평가 메트릭스 계산
  doc.metadata.cassMetrics = computeCASSMetrics(doc);

  return doc;
}

// =============================================
// v18: xAIF Document를 D1에 완전 저장
// =============================================

export async function persistXAIFDocument(
  db: D1Database,
  sessionId: string,
  turnNumber: number,
  doc: XAIFDocument,
): Promise<void> {
  if (!db) return;

  try {
    const xaifJson = JSON.stringify(doc.AIF);
    const toulminJson = JSON.stringify(doc.metadata.toulminOverlay || {});
    const daSummary = JSON.stringify(doc.metadata.dialogueActSummary || {});
    const cassJson = JSON.stringify(doc.metadata.cassMetrics || {});

    const lNodeCount = doc.AIF.nodes.filter(n => n.type === 'L').length;
    const iNodeCount = doc.AIF.nodes.filter(n => n.type === 'I').length;
    const raNodeCount = doc.AIF.nodes.filter(n => n.type === 'RA' || n.type === 'CA').length;
    const taEdgeCount = doc.AIF.edges.filter(e => e.type === 'TA').length;

    await db.prepare(`
      INSERT OR REPLACE INTO aif_graph_snapshots
      (id, session_id, turn_number, xaif_json, toulmin_json,
       total_i_nodes, total_s_nodes, total_edges,
       argument_strength, missing_edges_count,
       grounded_nodes_count, defeated_nodes_count,
       dialogue_act_summary_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    `).bind(
      `snap_${sessionId}_t${turnNumber}`,
      sessionId, turnNumber,
      xaifJson, toulminJson,
      iNodeCount, raNodeCount,
      doc.AIF.edges.length,
      doc.metadata.argumentStrength,
      doc.metadata.missingEdgeCount,
      lNodeCount, taEdgeCount,
      daSummary, Date.now(),
    ).run();

    // L-node 독립 저장 (v18)
    for (const node of doc.AIF.nodes) {
      if (node.type === 'L') {
        const lNode = node as XAIFLNode;
        await db.prepare(`
          INSERT OR IGNORE INTO aif_l_nodes
          (id, session_id, turn_number, seq, person_id, raw_text, timestamp_ms, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        `).bind(
          lNode.nodeID, sessionId, turnNumber,
          lNode.turnNumber, lNode.personID,
          lNode.text.substring(0, 2000),
          lNode.timestamp, Date.now(),
        ).run().catch(() => {});
      }
    }

    // TA-edge 독립 저장 (v18)
    for (const edge of doc.AIF.edges) {
      if (edge.type === 'TA') {
        const taEdge = edge as XAIFTAEdge;
        await db.prepare(`
          INSERT OR IGNORE INTO aif_ta_edges
          (id, session_id, turn_number, l_node_id, i_node_id, confidence, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        `).bind(
          taEdge.edgeID, sessionId, turnNumber,
          taEdge.fromID, taEdge.toID,
          1.0, Date.now(),
        ).run().catch(() => {});
      }
    }

    // 스킴 분포 저장 (v18)
    if (doc.metadata.schemeDistribution) {
      for (const [scheme, count] of Object.entries(doc.metadata.schemeDistribution)) {
        await db.prepare(`
          INSERT OR REPLACE INTO argument_scheme_stats
          (id, session_id, turn_number, scheme, count, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        `).bind(
          `scheme_${sessionId}_t${turnNumber}_${scheme}`,
          sessionId, turnNumber, scheme, count, Date.now(),
        ).run().catch(() => {});
      }
    }

    // v19: JSON-LD 직렬화 캐시 저장
    try {
      const jsonld = serializeToJSONLD(doc);
      await db.prepare(`
        INSERT OR REPLACE INTO xaif_jsonld_cache
        (id, session_id, turn_number, jsonld_text, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
      `).bind(
        `jsonld_${sessionId}_t${turnNumber}`,
        sessionId, turnNumber,
        JSON.stringify(jsonld),
        Date.now(),
      ).run().catch(() => {});
    } catch (e) { console.error('[P1-004] JSON-LD:', e); }

    console.log(`[xAIF v19] Document saved: t${turnNumber}, ${lNodeCount}L + ${iNodeCount}I + ${raNodeCount}RA nodes, CASS=${doc.metadata.cassMetrics?.agreementLevel || 'N/A'}, JSON-LD=cached`);
  } catch (error) {
    console.warn('[xAIF_PERSIST] Non-critical:', error);
  }
}
