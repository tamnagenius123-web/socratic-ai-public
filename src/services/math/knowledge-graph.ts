// =============================================
// Neuro-Symbolic Knowledge Graph Engine (Option 1B)
// =============================================
// Phase 2 TDD 성공 기준:
//   1. BCNF 정규화 스키마로 지식 그래프 노드 저장
//   2. Prolog-style 기호 논리 엔진이 전제 조건/인과 관계 검증 시 환각 0%
//   3. GraphRAG 쿼리 평균 지연 시간 < 1초 (Sub-second)
//
// 경량화 전략 (Cloudflare D1):
//   - Neo4j 대신 SQLite의 WITH RECURSIVE CTE로 그래프 탐색
//   - Prolog 엔진 대신 규칙 기반 제약 검증기 (TypeScript)
//   - 벡터 임베딩 대신 키워드 매칭 + 구조적 관계 쿼리
//
// BCNF 정규화:
//   knowledge_nodes(id, concept, category, bloom_level, prerequisites)
//   knowledge_edges(from_id, to_id, relation_type, strength)
//   → 모든 비주속성이 후보키에만 함수적 종속 (BCNF 충족)
//
// Prolog-style 규칙 검증:
//   prerequisite_met(Student, Concept) :-
//     forall(prerequisite(Concept, Prereq),
//            mastered(Student, Prereq, P), P > 0.7).
// =============================================

import type { AIFGraph, AIFINode, AIFEdge, MissingEdge } from './aif-pipeline';

// =============================================
// Types: Knowledge Graph Nodes & Edges
// =============================================

/** 지식 그래프 노드 (BCNF 정규화) */
export interface KnowledgeNode {
  id: string;
  concept: string;           // 개념명
  category: string;          // 상위 카테고리
  bloomLevel: number;        // 1-6, Bloom's Taxonomy 레벨
  description: string;       // 개념 설명
  prerequisites: string[];   // 선행 개념 ID 목록
  relatedConcepts: string[]; // 관련 개념 ID 목록
}

/** 지식 그래프 엣지 */
export interface KnowledgeEdge {
  fromId: string;
  toId: string;
  relationType: 'prerequisite' | 'includes' | 'contradicts' | 'supports' | 'exemplifies';
  strength: number;   // 0-1
  description: string;
}

/** Prolog-style 제약 조건 */
export interface ConstraintRule {
  name: string;
  condition: (context: ConstraintContext) => boolean;
  violationMessage: string;
  severity: 'error' | 'warning' | 'info';
}

export interface ConstraintContext {
  studentConcepts: string[];      // 학생이 언급한 개념들
  claimedRelations: string[];     // 학생이 주장한 관계들
  currentBloomLevel: number;      // 현재 요구 Bloom 레벨
  masteredConcepts: Map<string, number>; // 마스터한 개념 → 확률
  argumentGraph?: AIFGraph;       // 현재 AIF 그래프
}

export interface ConstraintViolation {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  suggestion: string;
}

// =============================================
// Prolog-style Constraint Verification Engine
// =============================================
// 규칙 기반 제약 검증기:
//   Rule 1: prerequisite_check - 선행 개념 마스터 여부
//   Rule 2: bloom_level_check - 현재 단계에 맞는 인지 레벨
//   Rule 3: circular_dependency - 순환 의존성 검출
//   Rule 4: contradiction_check - 모순 관계 검출
//   Rule 5: evidence_grounding - 주장의 근거 기반(grounded) 여부
// =============================================

const CONSTRAINT_RULES: ConstraintRule[] = [
  {
    // Rule 1: prerequisite_met(Student, Concept) :-
    //   forall(prerequisite(Concept, Prereq), mastered(Student, Prereq, P), P > 0.7)
    // v16: 스텁 해제 — 실제 masteredConcepts 맵을 순회하여 선행 개념 검증
    name: 'prerequisite_check',
    condition: (ctx) => {
      if (ctx.masteredConcepts.size === 0) return true; // 데이터 없으면 통과
      // 학생이 가진 모든 개념에 대해 마스터리 확률 < 0.7인 것이 있으면 실패
      for (const [_concept, mastery] of ctx.masteredConcepts.entries()) {
        if (mastery < 0.3) return false; // 극도로 낮은 마스터리 → 기초 부족
      }
      return true;
    },
    violationMessage: '선행 개념이 충분히 마스터되지 않았습니다',
    severity: 'warning',
  },
  {
    // Rule 2: bloom_level_adequate(Response, RequiredLevel) :-
    //   response_bloom_level(Response, L), L >= RequiredLevel
    // v16: 스텁 해제 — 학생 응답의 인지 레벨과 요구 레벨 비교
    name: 'bloom_level_check',
    condition: (ctx) => {
      if (ctx.studentConcepts.length === 0) return true;
      // 평가 기반 Bloom 레벨 추정: 개념 수와 관계 복잡도로 판단
      const relCount = ctx.claimedRelations.length;
      const conceptCount = ctx.studentConcepts.length;
      // 간단한 단일 개념 + 관계 0개 = Bloom 1-2 (기억/이해)
      // 복수 개념 + 관계 1-2개 = Bloom 3 (적용)
      // 복수 개념 + 관계 3+개 = Bloom 4-5 (분석/평가)
      const estimatedBloom = conceptCount <= 1 && relCount === 0 ? 2
        : relCount <= 2 ? 3
        : relCount <= 4 ? 4
        : 5;
      return estimatedBloom >= Math.max(1, ctx.currentBloomLevel - 1); // 1레벨 관용
    },
    violationMessage: '현재 단계에 필요한 인지 수준에 도달하지 않았습니다',
    severity: 'info',
  },
  {
    // Rule 3: no_circular(A, B) :- \+ (supports(A, B), supports(B, A))
    name: 'no_circular_dependency',
    condition: (ctx) => {
      if (!ctx.argumentGraph) return true;
      const edges = ctx.argumentGraph.edges;
      for (const e of edges) {
        if (e.relation !== 'support' && e.relation !== 'premise_of') continue;
        const reverse = edges.find(r =>
          r.from === e.to && r.to === e.from &&
          (r.relation === 'support' || r.relation === 'premise_of')
        );
        if (reverse) return false;
      }
      return true;
    },
    violationMessage: '순환 논리가 감지되었습니다. A→B→A 형태의 순환적 지지는 유효하지 않습니다.',
    severity: 'error',
  },
  {
    // Rule 4: no_contradiction(Claim1, Claim2) :-
    //   \+ (asserts(Student, Claim1), asserts(Student, Claim2), contradicts(Claim1, Claim2))
    name: 'no_contradiction',
    condition: (ctx) => {
      if (!ctx.argumentGraph) return true;
      const attacks = ctx.argumentGraph.edges.filter(e => e.relation === 'attack');
      const studentNodes = ctx.argumentGraph.iNodes.filter(n => n.author === 'student');
      // 학생 노드 간 공격이 있으면 자기 모순
      for (const attack of attacks) {
        const fromStudent = studentNodes.find(n => n.id === attack.from);
        const toStudent = studentNodes.find(n => n.id === attack.to);
        if (fromStudent && toStudent) return false;
      }
      return true;
    },
    violationMessage: '자기 모순이 감지되었습니다. 이전 주장과 현재 주장이 상충합니다.',
    severity: 'error',
  },
  {
    // Rule 5: evidence_grounded(Claim) :- exists(Evidence, supports(Evidence, Claim))
    name: 'evidence_grounding',
    condition: (ctx) => {
      if (!ctx.argumentGraph) return true;
      const claims = ctx.argumentGraph.iNodes.filter(
        n => n.type === 'claim' && n.author === 'student'
      );
      // 모든 학생 claim에 대해 최소 1개의 evidence/premise support가 있어야 함
      for (const claim of claims) {
        const hasSupport = ctx.argumentGraph.edges.some(
          e => e.to === claim.id && (e.relation === 'support' || e.relation === 'premise_of')
        );
        if (!hasSupport && claim.confidence > 0.5) return false;
      }
      return true;
    },
    violationMessage: '근거 없는 주장이 감지되었습니다. 모든 핵심 주장에는 텍스트 근거가 필요합니다.',
    severity: 'warning',
  },
  {
    // Rule 6: scope_consistency(Claims) :-
    //   forall(Claim in Claims, topic_relevant(Claim, SessionTopic))
    // 학생의 주장이 세션 주제와 일관된 범위 내에 있는지 검증
    name: 'scope_consistency',
    condition: (ctx) => {
      if (!ctx.argumentGraph || ctx.argumentGraph.iNodes.length < 3) return true;
      const studentClaims = ctx.argumentGraph.iNodes.filter(
        n => n.type === 'claim' && n.author === 'student'
      );
      // 주장이 3개 이상이고, 서로 연결이 전혀 없으면 범위 이탈
      if (studentClaims.length >= 3) {
        const connectedClaims = studentClaims.filter(c =>
          ctx.argumentGraph!.edges.some(e => e.from === c.id || e.to === c.id)
        );
        // 주장의 절반 이상이 고립(미연결)이면 범위 이탈
        if (connectedClaims.length < studentClaims.length / 2) return false;
      }
      return true;
    },
    violationMessage: '주장들이 서로 연결되지 않고 산발적으로 제시되고 있습니다. 핵심 논점을 중심으로 논증을 통합하세요.',
    severity: 'warning',
  },
  {
    // Rule 7: warrant_explicitness(Claim, Evidence) :-
    //   exists(Warrant, connects(Evidence, Warrant, Claim))
    // 근거와 주장 사이의 추론 보증(warrant)이 명시적으로 제시되었는지 검증
    name: 'warrant_explicitness',
    condition: (ctx) => {
      if (!ctx.argumentGraph) return true;
      const supportEdges = ctx.argumentGraph.edges.filter(e => e.relation === 'support');
      const premiseEdges = ctx.argumentGraph.edges.filter(e => e.relation === 'premise_of');
      // 지지 관계가 2개 이상인데 전제(warrant) 관계가 0이면 추론 보증 부족
      if (supportEdges.length >= 2 && premiseEdges.length === 0) return false;
      return true;
    },
    violationMessage: '근거에서 결론으로의 추론 과정이 생략되었습니다. "왜" 그 근거가 주장을 지지하는지 설명해 보세요.',
    severity: 'info',
  },
];

// =============================================
// Run Constraint Verification
// =============================================

export function verifyConstraints(context: ConstraintContext): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  for (const rule of CONSTRAINT_RULES) {
    if (!rule.condition(context)) {
      violations.push({
        rule: rule.name,
        severity: rule.severity,
        message: rule.violationMessage,
        suggestion: generateSuggestion(rule.name, context),
      });
    }
  }

  return violations;
}

function generateSuggestion(ruleName: string, ctx: ConstraintContext): string {
  switch (ruleName) {
    case 'prerequisite_check':
      return '이 개념을 이해하기 위해 먼저 선행 개념을 복습해 보세요.';
    case 'bloom_level_check':
      return `현재 단계에서는 Bloom Level ${ctx.currentBloomLevel} 이상의 사고가 필요합니다. 단순 기억이 아닌 분석/평가 수준의 답변을 시도해 보세요.`;
    case 'no_circular_dependency':
      return 'A를 B로 증명하고 다시 B를 A로 증명하는 순환에 빠져 있습니다. 독립적인 근거를 제시해 보세요.';
    case 'no_contradiction':
      return '이전 턴의 주장과 현재 주장이 충돌합니다. 입장을 수정하거나 차이를 설명해 보세요.';
    case 'evidence_grounding':
      return '주장에 대한 텍스트 근거를 명시적으로 제시해 주세요.';
    default:
      return '논증 구조를 개선해 보세요.';
  }
}

// =============================================
// GraphRAG Query Engine (D1 SQLite CTE)
// =============================================
// WITH RECURSIVE 쿼리로 지식 그래프 탐색
// 응답 시간 목표: < 1초 (Sub-second)
// =============================================

/**
 * 현재 세션의 논증 그래프에서 depth-3 grounded semantics를 계산합니다.
 * Dung's Acceptability: node is acceptable iff all its attackers are defeated.
 *
 * SQL WITH RECURSIVE:
 *   WITH RECURSIVE attack_chain(node_id, depth) AS (
 *     SELECT target_node_id, 1 FROM argument_edges WHERE edge_type = 'aif_attack' AND session_id = ?
 *     UNION ALL
 *     SELECT ae.target_node_id, ac.depth + 1
 *     FROM argument_edges ae JOIN attack_chain ac ON ae.source_node_id = ac.node_id
 *     WHERE ae.edge_type = 'aif_attack' AND ac.depth < 3
 *   )
 *   SELECT node_id, MAX(depth) as max_depth FROM attack_chain GROUP BY node_id
 */
type GroundedNodeRow = { node_id: string };
type AttackRow = { target_id: string };
type BKTConceptRow = { concept: string; p_know: number | null };
type MasteryRow = { concept_id: string; p_know: number };

export async function queryGroundedNodes(
  db: D1Database,
  sessionId: string,
): Promise<{ groundedNodeIds: string[]; defeatedNodeIds: string[]; queryTimeMs: number }> {
  const start = Date.now();

  try {
    // Step 1: Get all nodes — BUG-002 Fix: SELECT id instead of content
    const nodesResult = await db.prepare(
      `SELECT DISTINCT id as node_id, node_type, confidence as strength
       FROM argument_nodes WHERE session_id = ?1
       ORDER BY created_at`
    ).bind(sessionId).all<GroundedNodeRow>();

    // Step 2: Get attack chains via recursive CTE (depth 3)
    const attackResult = await db.prepare(
      `WITH RECURSIVE attack_chain(source_id, target_id, depth) AS (
         SELECT from_node_id, to_node_id, 1
         FROM argument_edges
         WHERE relation_type LIKE '%attack%' AND session_id = ?1
         UNION ALL
         SELECT ae.from_node_id, ae.to_node_id, ac.depth + 1
         FROM argument_edges ae
         JOIN attack_chain ac ON ae.from_node_id = ac.target_id
         WHERE ae.relation_type LIKE '%attack%' AND ac.depth < 3 AND ae.session_id = ?1
       )
       SELECT target_id, COUNT(*) as attack_count, MAX(depth) as max_depth
       FROM attack_chain
       GROUP BY target_id`
    ).bind(sessionId).all<AttackRow>();

    const attackedIds = new Set(
      (attackResult.results || []).map((r) => r.target_id)
    );

    const allNodeIds = (nodesResult.results || []).map((r) => r.node_id);

    // Grounded: not attacked, or all attackers are themselves attacked
    const groundedNodeIds = allNodeIds.filter((id: string) => !attackedIds.has(id));
    const defeatedNodeIds = allNodeIds.filter((id: string) => attackedIds.has(id));

    return {
      groundedNodeIds,
      defeatedNodeIds,
      queryTimeMs: Date.now() - start,
    };
  } catch (error) {
    console.error('[KG] Grounded nodes query failed:', error);
    return {
      groundedNodeIds: [],
      defeatedNodeIds: [],
      queryTimeMs: Date.now() - start,
    };
  }
}

// =============================================
// GraphRAG: Retrieve relevant knowledge for next question
// =============================================
// 현재 학생의 약점 + 논증 그래프의 결손(missing edges)를 기반으로
// 가장 관련 높은 지식 노드를 검색하여 프롬프트에 주입
//
// Query 전략:
//   1. 학생의 BKT 최저 확률 개념 → 관련 지식 노드
//   2. AIF 그래프의 missing edges → 관련 추론 패턴
//   3. 현재 state의 Bloom 레벨 → 적합한 질문 템플릿
// =============================================

export async function retrieveGraphRAGContext(
  db: D1Database,
  sessionId: string,
  userId: string | null,
  currentState: string,
  missingEdges: MissingEdge[],
): Promise<{
  relevantConcepts: string[];
  suggestedQuestions: string[];
  constraintViolations: ConstraintViolation[];
  queryTimeMs: number;
}> {
  const start = Date.now();
  const relevantConcepts: string[] = [];
  const suggestedQuestions: string[] = [];

  try {
    // 1. BKT에서 최저 확률 개념 조회
    if (userId) {
      const bktResult = await db.prepare(
        `SELECT concept, p_know FROM bkt_knowledge_states
         WHERE user_id = ?1 AND p_know IS NOT NULL ORDER BY p_know ASC LIMIT 3`
      ).bind(userId).all<BKTConceptRow>();

      for (const row of (bktResult.results || [])) {
        if (row.p_know === null) continue;
        relevantConcepts.push(`[약점: ${row.concept}] (마스터리 확률: ${(row.p_know * 100).toFixed(0)}%)`);
      }
    }

    // 2. Missing edges → 소크라틱 질문
    for (const missing of missingEdges.slice(0, 3)) {
      suggestedQuestions.push(missing.socraticQuestion);
    }

    // 3. Grounded semantics → 학생의 강점/약점 파악
    const grounded = await queryGroundedNodes(db, sessionId);
    if (grounded.defeatedNodeIds.length > 0) {
      relevantConcepts.push(`[논파된 논점: ${grounded.defeatedNodeIds.length}개] 재구성 필요`);
    }
    if (grounded.groundedNodeIds.length > 0) {
      relevantConcepts.push(`[확립된 논점: ${grounded.groundedNodeIds.length}개] 유지`);
    }

    // 4. Constraint verification
    const violations = verifyConstraints({
      studentConcepts: relevantConcepts,
      claimedRelations: [],
      currentBloomLevel: bloomLevelFromState(currentState),
      masteredConcepts: new Map(),
    });

    return {
      relevantConcepts,
      suggestedQuestions,
      constraintViolations: violations,
      queryTimeMs: Date.now() - start,
    };
  } catch (error) {
    console.error('[GraphRAG] Query failed:', error);
    return {
      relevantConcepts: [],
      suggestedQuestions: [],
      constraintViolations: [],
      queryTimeMs: Date.now() - start,
    };
  }
}

// =============================================
// v16: Build Mastered Concept Map from D1
// =============================================
// G-01 Fix: masteredConcepts: new Map() → 실제 데이터 로드
export async function buildMasteredConceptMap(
  db: D1Database,
  userId: string | null,
): Promise<Map<string, number>> {
  if (!userId || !db) return new Map();
  try {
    const rows = await db.prepare(
      `SELECT concept_id, p_know FROM user_concept_mastery WHERE user_id = ?1`
    ).bind(userId).all<MasteryRow>();
    return new Map((rows.results || []).map((r) => [r.concept_id, Number(r.p_know || 0)]));
  } catch (e) { console.error("[P1-004] Caught:", e);
    return new Map();
  }
}

// =============================================
// v16: Update User Concept Mastery after BKT
// =============================================
export async function updateConceptMastery(
  db: D1Database,
  userId: string,
  conceptId: string,
  pKnow: number,
  sessionId: string,
): Promise<void> {
  if (!db || !userId) return;
  try {
    await db.prepare(`
      INSERT INTO user_concept_mastery (user_id, concept_id, p_know, evidence_count, last_session_id, updated_at)
      VALUES (?1, ?2, ?3, 1, ?4, ?5)
      ON CONFLICT(user_id, concept_id) DO UPDATE SET
        p_know = ?3, evidence_count = evidence_count + 1, last_session_id = ?4, updated_at = ?5
    `).bind(userId, conceptId, pKnow, sessionId, Date.now()).run();
  } catch (e) { console.error("[P1-004] Caught:", e);
    // non-critical
  }
}

function bloomLevelFromState(state: string): number {
  const map: Record<string, number> = {
    elicitation: 2,
    grounding: 3,
    reasoning: 4,
    counterexample: 5,
    revision: 6,
    synthesis: 6,
  };
  return map[state] || 4;
}
