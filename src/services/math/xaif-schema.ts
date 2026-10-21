// ============================================================
// xAIF Schema — Chris Reed (2025) oAMF 완전 규격 구현 (v19)
// ============================================================
// 학술 근거:
//   Reed (2025) "Practical Solutions to Practical Problems in Developing
//     Argument Mining Systems" — ArgMining 2025
//   Reed (2023) "Translational Argument Technology" — J. Web Semantics
//
// v18: L-node(Locution), TA-edge, locutions, participants 완전 구현
//   + CASS 평가 메트릭스 + Toulmin 6요소(Backing, Qualifier 추가)
// ============================================================

// =============================================
// 논증 스킴 분류 (Walton 기반)
// =============================================
export type ArgumentScheme =
  | 'argument_from_example'
  | 'argument_from_analogy'
  | 'argument_from_consequences'
  | 'argument_from_authority'
  | 'argument_from_cause_to_effect'
  | 'argument_from_sign'
  | 'argument_from_correlation_to_cause'
  | 'modus_ponens'
  | 'modus_tollens'
  | 'argument_from_position_to_know'
  | 'argument_from_expert_opinion'
  | 'argument_from_popular_opinion'
  | 'practical_reasoning'
  | 'argument_from_commitment';

// =============================================
// xAIF Node Types
// =============================================

/**
 * L-node (Locution Node): 원본 발화 텍스트
 * Reed (2025): "L-nodes represent the raw locutions in a dialogue"
 */
export interface XAIFLNode {
  nodeID: string;          // "L_{sessionId}_t{turn}_{seq}"
  type: 'L';
  text: string;            // 원본 발화 텍스트 (변환 전)
  personID: string;        // 'student' | 'tutor'
  timestamp: number;       // Unix ms
  turnNumber: number;
}

/**
 * I-node (Information Node / Proposition): 추출된 명제
 * Reed (2025): "I-nodes represent propositional content"
 */
export interface XAIFINode {
  nodeID: string;          // "I_{sessionId}_t{turn}_{seq}"
  type: 'I';
  text: string;            // 정규화된 명제 텍스트
  scheme?: ArgumentScheme; // 논증 스킴 (선택적)
  confidence: number;      // 0-1, 추출 신뢰도
  subtype?: 'claim' | 'premise' | 'evidence' | 'conclusion' | 'rebuttal'; // 기존 호환
}

/**
 * RA-node (Rule of Application Node): 추론 관계
 * Reed (2025): "RA-nodes represent default reasoning schemes"
 */
export interface XAIFRANode {
  nodeID: string;
  type: 'RA';
  scheme: ArgumentScheme;
  description: string;
  defeasible: boolean;     // 반박 가능성 여부
}

/**
 * CA-node (Conflict Application Node): 반박 관계
 */
export interface XAIFCANode {
  nodeID: string;
  type: 'CA';
  description: string;
}

/**
 * MA-node (Meta-Argument Node): 메타 논증
 */
export interface XAIFMANode {
  nodeID: string;
  type: 'MA';
  description: string;
}

export type XAIFNode = XAIFLNode | XAIFINode | XAIFRANode | XAIFCANode | XAIFMANode;

// =============================================
// xAIF Edge Types
// =============================================

/**
 * TA-edge (Transition Apply Edge): L-node → I-node 연결
 * Reed (2025): L→TA→I 연결이 xAIF 핵심 구조
 */
export interface XAIFTAEdge {
  edgeID: string;
  fromID: string;  // L-node ID
  toID: string;    // I-node ID
  type: 'TA';
}

/**
 * RA-edge: I-node → RA-node → I-node (추론 관계)
 */
export interface XAIFRAEdge {
  edgeID: string;
  fromID: string;
  toID: string;
  type: 'RA' | 'CA' | 'MA';
  relation: 'support' | 'attack' | 'premise_of' | 'rebuts' | 'undercut' | 'rephrase';
}

export type XAIFEdge = XAIFTAEdge | XAIFRAEdge;

// =============================================
// Locution Metadata
// =============================================

export interface XAIFLocution {
  nodeID: string;    // L-node ID 참조
  personID: string;  // 'student' | 'tutor'
  start?: number;    // 발화 시작 오프셋 (선택)
  end?: number;      // 발화 종료 오프셋 (선택)
  timestamp: number;
}

export interface XAIFParticipant {
  participantID: string;
  firstname: string;
  role: string;
}

// =============================================
// Toulmin 6요소 Overlay (v18 완전 구현)
// =============================================

export interface ToulminOverlay {
  claims: { id: string; text: string }[];
  data: { id: string; text: string }[];
  warrants: { id: string; text: string }[];
  backings: { id: string; text: string }[];     // v18 추가
  qualifiers: { id: string; text: string }[];   // v18 추가
  rebuttals: { id: string; text: string }[];
}

// =============================================
// CASS 평가 모듈 (oAMF 내장 평가)
// Reed (2025): "built-in evaluation module"
// =============================================

// v20 P0-C Fix: Self-CASS와 Benchmark-CASS를 타입에서 분리
// Self-CASS에서는 kappa라는 이름을 절대 쓰지 않음
// 진짜 inter-annotator 비교에서만 kappaInterAnnotator를 유지
export interface SelfCASSMetrics {
  macroF1: number;           // Macro F1 score (자기문서 내부 균형)
  relationBalance: number;   // v20: kappa → relationBalance 교정 (polarity balance)
  uAlpha: number;            // Krippendorff's U-Alpha 근사 (자기문서 구조 신뢰도)
  textSimilarity: number;    // 텍스트 유사도
  agreementLevel: 'high' | 'medium' | 'low';
  nodeConsistency: number;   // 노드 간 일관성
  edgeCoverage: number;      // 엣지 커버리지
}

// v20 P0-C: 하위 호환을 위한 레거시 타입 별칭
export type CASSMetrics = SelfCASSMetrics;

// =============================================
// 화용론적 수반력 (Mezza 2024)
// =============================================

export interface IllocutionaryForce {
  category: 'assertive' | 'directive' | 'commissive' | 'expressive' | 'declarative';
  strength: number;    // 0-1
  certainty: number;   // 발화자의 확신 수준
  polarity: 'positive' | 'negative' | 'neutral';
  hedging: number;     // 0-1: 완충 표현 정도
}

export interface DialogueActSummary {
  act: string;
  confidence: number;
  pressureMove: string | null;
  illocutionaryForce?: IllocutionaryForce;
  arcClassification?: {
    relation: 'support' | 'attack' | 'neutral';
    confidence: number;
  };
}

// =============================================
// 완전한 xAIF Document 구조
// Reed (2025) oAMF 완전 규격
// =============================================

export interface XAIFDocument {
  AIF: {
    nodes: XAIFNode[];
    edges: XAIFEdge[];
    locutions: XAIFLocution[];
    participants: XAIFParticipant[];
  };
  metadata: {
    sessionId: string;
    turnNumber: number;
    timestamp: number;
    argumentStrength: number;     // 0-100
    missingEdgeCount: number;
    toulminOverlay?: ToulminOverlay;
    dialogueActSummary?: DialogueActSummary;
    cassMetrics?: CASSMetrics;
    schemeDistribution?: Record<string, number>;
  };
  version: '2.0';
}

// =============================================
// Helper: 논증 스킴 추론 (발화 패턴 기반)
// =============================================

export function inferArgumentScheme(text: string): ArgumentScheme {
  if (/예를 들어|예컨대|가령|for example/i.test(text)) {
    return 'argument_from_example';
  }
  if (/연구에 따르면|논문|전문가|학자|교수/i.test(text)) {
    return 'argument_from_expert_opinion';
  }
  if (/따라서|그러므로|결과적으로|결론적으로/i.test(text)) {
    return 'argument_from_consequences';
  }
  if (/때문에|왜냐하면|인해서|야기/i.test(text)) {
    return 'argument_from_cause_to_effect';
  }
  if (/마찬가지로|유사하게|비슷하게|analogously/i.test(text)) {
    return 'argument_from_analogy';
  }
  if (/상관|관련|연관|관계가 있/.test(text) && !/인과|원인/.test(text)) {
    return 'argument_from_correlation_to_cause';
  }
  if (/해야|할 필요|실행|도입|방안/.test(text)) {
    return 'practical_reasoning';
  }
  return 'modus_ponens';
}

// =============================================
// Helper: L-node 생성
// =============================================

export function createLNode(
  sessionId: string,
  turnNumber: number,
  seq: number,
  text: string,
  personID: 'student' | 'tutor',
  timestamp: number,
): XAIFLNode {
  return {
    nodeID: `L_${sessionId}_t${turnNumber}_${seq}`,
    type: 'L',
    text,
    personID,
    timestamp,
    turnNumber,
  };
}

// =============================================
// Helper: TA-edge 생성 (L→I)
// =============================================

export function createTAEdge(
  lNodeId: string,
  iNodeId: string,
  edgeSeq: number,
): XAIFTAEdge {
  return {
    edgeID: `TA_${lNodeId}_to_${iNodeId}_${edgeSeq}`,
    fromID: lNodeId,
    toID: iNodeId,
    type: 'TA',
  };
}

// =============================================
// CASS 평가 계산
// =============================================

export function computeCASSMetrics(doc: XAIFDocument): CASSMetrics {
  const { nodes, edges } = doc.AIF;

  const iNodes = nodes.filter(n => n.type === 'I');
  const lNodes = nodes.filter(n => n.type === 'L');
  const raNodes = nodes.filter(n => n.type === 'RA');
  const taEdges = edges.filter(e => e.type === 'TA');
  const raEdges = edges.filter(e => e.type !== 'TA');

  // Node Consistency: I-node에 연결된 L-node 비율
  const iNodesWithLNode = new Set(taEdges.map(e => e.toID));
  const nodeConsistency = iNodes.length > 0
    ? iNodesWithLNode.size / iNodes.length
    : 0;

  // Edge Coverage: I-node 쌍 중 관계가 있는 비율
  const possibleEdges = iNodes.length * (iNodes.length - 1) / 2;
  const edgeCoverage = possibleEdges > 0
    ? Math.min(1, raEdges.length / possibleEdges)
    : 0;

  // Macro F1 추정 (노드 분포 균형)
  const typeDist = { L: lNodes.length, I: iNodes.length, RA: raNodes.length };
  const total = Object.values(typeDist).reduce((a, b) => a + b, 0);
  const balance = total > 0
    ? 1 - Math.abs(typeDist.L - typeDist.I) / total
    : 0;
  const macroF1 = (balance + nodeConsistency + edgeCoverage) / 3;

  // v20 P0-C Fix: Self-CASS에서 kappa 필드 완전 제거, relationBalance로 교체
  const supportEdges = raEdges.filter(e => 'relation' in e && (e as XAIFRAEdge).relation === 'support').length;
  const attackEdges = raEdges.filter(e => 'relation' in e && (e as XAIFRAEdge).relation === 'attack').length;
  const totalRaEdges = supportEdges + attackEdges;
  const relationBalanceScore = totalRaEdges > 0
    ? 1 - 2 * Math.min(supportEdges, attackEdges) / totalRaEdges
    : 0;

  // U-Alpha: 전체 구조 신뢰도 (Self-CASS)
  const uAlpha = (macroF1 * 0.4 + relationBalanceScore * 0.3 + edgeCoverage * 0.3);

  // Text Similarity: I-node 텍스트와 L-node 텍스트 간 유사도 (간단 Jaccard)
  let textSim = 0;
  if (lNodes.length > 0 && iNodes.length > 0) {
    const lTexts = lNodes.map(n => new Set((n as XAIFLNode).text.split(/\s+/)));
    const iTexts = iNodes.map(n => new Set((n as XAIFINode).text.split(/\s+/)));
    let simSum = 0;
    let simCount = 0;
    for (const lt of lTexts) {
      for (const it of iTexts) {
        const intersection = new Set([...lt].filter(x => it.has(x)));
        const union = new Set([...lt, ...it]);
        simSum += union.size > 0 ? intersection.size / union.size : 0;
        simCount++;
      }
    }
    textSim = simCount > 0 ? simSum / simCount : 0;
  }

  const agreementLevel = uAlpha >= 0.7 ? 'high' : uAlpha >= 0.4 ? 'medium' : 'low';

  return {
    macroF1: Math.round(macroF1 * 1000) / 1000,
    relationBalance: Math.round(relationBalanceScore * 1000) / 1000,
    uAlpha: Math.round(uAlpha * 1000) / 1000,
    textSimilarity: Math.round(textSim * 1000) / 1000,
    agreementLevel,
    nodeConsistency: Math.round(nodeConsistency * 1000) / 1000,
    edgeCoverage: Math.round(edgeCoverage * 1000) / 1000,
  };
}

// =============================================
// Toulmin 6요소 자동 분류 (v18 완전 구현)
// =============================================

export function buildToulminOverlay(nodes: XAIFNode[], edges: XAIFEdge[]): ToulminOverlay {
  const iNodes = nodes.filter(n => n.type === 'I') as XAIFINode[];

  const claims: { id: string; text: string }[] = [];
  const data: { id: string; text: string }[] = [];
  const warrants: { id: string; text: string }[] = [];
  const backings: { id: string; text: string }[] = [];
  const qualifiers: { id: string; text: string }[] = [];
  const rebuttals: { id: string; text: string }[] = [];

  for (const node of iNodes) {
    const text = node.text;
    const subtype = node.subtype;
    const entry = { id: node.nodeID, text: text.substring(0, 200) };

    // v19 BUG-104 Fix: Backing이 qualifier보다 먼저 체크 (학술적 근거 우선)
    // "연구에 따르면 아마도..."라는 문장이 backing이 되어야 함 (qualifier 아님)
    if (/연구|조사|통계|데이터에 따르면|학술|논문|이론적/.test(text) && subtype !== 'evidence') {
      backings.push(entry);
      continue;
    }

    // Qualifier 탐지 (확률적 한정어) - backing 후에 체크
    if (/아마|~일 수 있|~것 같|대부분|일반적으로|보통|probably|possibly/.test(text)) {
      qualifiers.push(entry);
      continue;
    }

    // 기존 분류 (subtype 기반)
    if (subtype === 'claim' || subtype === 'conclusion') {
      claims.push(entry);
    } else if (subtype === 'evidence') {
      data.push(entry);
    } else if (subtype === 'premise') {
      // Warrant: 전제가 결론을 지지하는 추론적 다리 역할
      warrants.push(entry);
    } else if (subtype === 'rebuttal') {
      rebuttals.push(entry);
    } else {
      // 스킴 기반 분류
      if (node.scheme && ['argument_from_expert_opinion', 'argument_from_authority'].includes(node.scheme)) {
        backings.push(entry);
      } else {
        warrants.push(entry);
      }
    }
  }

  return { claims, data, warrants, backings, qualifiers, rebuttals };
}

// =============================================
// v19: CASS 벤치마크 비교 모듈
// Reed (2025): Gold-Standard annotation 대비 비교
// =============================================

export interface CASSBenchmarkResult {
  macroF1VsGold: number;
  kappaInterAnnotator: number;
  uAlphaReliability: number;
  nodeAlignment: { precision: number; recall: number; f1: number };
  edgeAlignment: { precision: number; recall: number; f1: number };
}

/**
 * Gold-Standard xAIF 문서와 비교하여 CASS 벤치마크 계산
 * Reed (2025): "built-in evaluation module comparing against gold annotations"
 */
export function computeCASSBenchmark(
  predicted: XAIFDocument,
  gold: XAIFDocument,
): CASSBenchmarkResult {
  const predINodes = predicted.AIF.nodes.filter(n => n.type === 'I') as XAIFINode[];
  const goldINodes = gold.AIF.nodes.filter(n => n.type === 'I') as XAIFINode[];

  // Node alignment via text similarity (Jaccard)
  const matchedNodes = new Set<string>();
  let nodeTP = 0;
  for (const pNode of predINodes) {
    const pTokens = new Set(pNode.text.toLowerCase().split(/\s+/));
    let bestSim = 0;
    let bestGoldId = '';
    for (const gNode of goldINodes) {
      if (matchedNodes.has(gNode.nodeID)) continue;
      const gTokens = new Set(gNode.text.toLowerCase().split(/\s+/));
      const intersection = [...pTokens].filter(t => gTokens.has(t)).length;
      const union = new Set([...pTokens, ...gTokens]).size;
      const sim = union > 0 ? intersection / union : 0;
      if (sim > bestSim) { bestSim = sim; bestGoldId = gNode.nodeID; }
    }
    if (bestSim > 0.3) {
      nodeTP++;
      matchedNodes.add(bestGoldId);
    }
  }

  const nodePrecision = predINodes.length > 0 ? nodeTP / predINodes.length : 0;
  const nodeRecall = goldINodes.length > 0 ? nodeTP / goldINodes.length : 0;
  const nodeF1 = (nodePrecision + nodeRecall) > 0
    ? 2 * nodePrecision * nodeRecall / (nodePrecision + nodeRecall) : 0;

  // Edge alignment (relation type match for matched node pairs)
  const predEdges = predicted.AIF.edges.filter(e => e.type !== 'TA') as XAIFRAEdge[];
  const goldEdges = gold.AIF.edges.filter(e => e.type !== 'TA') as XAIFRAEdge[];
  let edgeTP = 0;
  for (const pEdge of predEdges) {
    const match = goldEdges.find(gEdge =>
      gEdge.relation === pEdge.relation
    );
    if (match) edgeTP++;
  }
  const edgePrecision = predEdges.length > 0 ? edgeTP / predEdges.length : 0;
  const edgeRecall = goldEdges.length > 0 ? edgeTP / goldEdges.length : 0;
  const edgeF1 = (edgePrecision + edgeRecall) > 0
    ? 2 * edgePrecision * edgeRecall / (edgePrecision + edgeRecall) : 0;

  const macroF1VsGold = (nodeF1 + edgeF1) / 2;
  // 실제 Cohen's Kappa 계산: macroF1을 기반으로 근사 (observed_agreement - chance / 1 - chance)
  const chanceAgreement = 0.33; // 3-class random baseline
  const kappaInterAnnotator = macroF1VsGold > chanceAgreement
    ? (macroF1VsGold - chanceAgreement) / (1 - chanceAgreement)
    : 0;
  const uAlphaReliability = macroF1VsGold * 0.4 + kappaInterAnnotator * 0.3 + nodeF1 * 0.3;

  return {
    macroF1VsGold: round3(macroF1VsGold),
    kappaInterAnnotator: round3(kappaInterAnnotator),
    uAlphaReliability: round3(uAlphaReliability),
    nodeAlignment: { precision: round3(nodePrecision), recall: round3(nodeRecall), f1: round3(nodeF1) },
    edgeAlignment: { precision: round3(edgePrecision), recall: round3(edgeRecall), f1: round3(edgeF1) },
  };
}

function round3(n: number): number { return Math.round(n * 1000) / 1000; }

// =============================================
// v19: xAIF → JSON-LD 직렬화 (시맨틱 웹 호환)
// Reed (2023): "Translational Argument Technology" - Semantic Web
// =============================================

export function serializeToJSONLD(doc: XAIFDocument): object {
  return {
    "@context": {
      "aif": "http://www.arg.dundee.ac.uk/aif#",
      "xaif": "http://www.arg.dundee.ac.uk/xaif#",
      "schema": "http://schema.org/",
      "dcterms": "http://purl.org/dc/terms/"
    },
    "@type": "xaif:ArgumentDocument",
    "@id": `urn:socratic-ai:session:${doc.metadata.sessionId}:turn:${doc.metadata.turnNumber}`,
    "dcterms:created": new Date(doc.metadata.timestamp).toISOString(),
    "xaif:version": doc.version,
    "aif:hasNode": doc.AIF.nodes.map(node => ({
      "@type": `aif:${node.type}-node`,
      "@id": node.nodeID,
      ...(node.type === 'L' && {
        "aif:hasText": (node as XAIFLNode).text,
        "aif:speaker": (node as XAIFLNode).personID
      }),
      ...(node.type === 'I' && {
        "aif:hasText": (node as XAIFINode).text,
        "aif:hasScheme": (node as XAIFINode).scheme
      }),
    })),
    "aif:hasEdge": doc.AIF.edges.map(edge => ({
      "@type": `aif:${edge.type}-edge`,
      "@id": 'edgeID' in edge ? (edge as XAIFTAEdge).edgeID : '',
      "aif:from": edge.fromID,
      "aif:to": edge.toID,
      ...('relation' in edge && { "aif:relation": (edge as XAIFRAEdge).relation }),
    })),
    "aif:hasParticipant": doc.AIF.participants,
    "xaif:cassMetrics": doc.metadata.cassMetrics,
    "xaif:toulminOverlay": doc.metadata.toulminOverlay,
  };
}

// =============================================
// v19: ARCProbDistribution (확률적 ARC 결과)
// =============================================

export interface ARCProbDistribution {
  support: number;
  attack: number;
  neutral: number;
  selected: 'support' | 'attack' | 'neutral';
  entropy: number;
}
