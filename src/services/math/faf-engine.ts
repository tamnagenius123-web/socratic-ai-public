// FAF Engine – Formal Argumentation Framework (Dung's Semantics)
// Implements depth-3 argument graph with grounded extension computation
// Uses SQLite WITH RECURSIVE CTE for attack chain resolution
//
// Architecture:
//   - argument_nodes: claims, rebuttals, re-rebuttals, evidence
//   - argument_edges: attack, support, undercut relationships
//   - Grounded extension: a node is "grounded" if all its attackers are defeated

export interface ArgumentNode {
  session_id: string;
  turn_number: number;
  node_type: 'claim' | 'rebuttal' | 're_rebuttal' | 'evidence';
  author: 'student' | 'tutor';
  content: string;
  strength: number; // 0.0 - 1.0
  depth: number;    // 0=root, 1=rebuttal, 2=re-rebuttal
  parent_node_id?: number;
  metadata?: Record<string, any>;
}

export interface ArgumentEdge {
  session_id: string;
  source_node_id: number;
  target_node_id: number;
  edge_type: 'attack' | 'support' | 'undercut';
  weight: number; // 0.0 - 1.0
}

export interface GroundedResult {
  nodeId: number;
  content: string;
  isGrounded: boolean;
  depth: number;
  attackerCount: number;
  defeatedAttackerCount: number;
}

// ==============================================
// Extract arguments from a turn's evaluation
// ==============================================
export function extractArgumentNodes(
  sessionId: string,
  turnNumber: number,
  studentMessage: string,
  aiReply: string,
  evaluation: {
    claim: string;
    evidence_detected: string[];
    reasoning_gap: string;
    claim_clarity: number;
    evidence_use: number;
    reasoning_strength: number;
  },
): { nodes: ArgumentNode[]; edges: Partial<ArgumentEdge>[] } {
  const nodes: ArgumentNode[] = [];
  const edges: Partial<ArgumentEdge>[] = [];

  // Student's claim node
  if (evaluation.claim && evaluation.claim.length > 0) {
    nodes.push({
      session_id: sessionId,
      turn_number: turnNumber,
      node_type: 'claim',
      author: 'student',
      content: evaluation.claim,
      strength: evaluation.claim_clarity / 5,
      depth: 0,
    });
  }

  // Student's evidence nodes
  if (evaluation.evidence_detected) {
    for (const evidence of evaluation.evidence_detected) {
      if (evidence && evidence.length > 0) {
        nodes.push({
          session_id: sessionId,
          turn_number: turnNumber,
          node_type: 'evidence',
          author: 'student',
          content: evidence,
          strength: evaluation.evidence_use / 5,
          depth: 0,
        });
      }
    }
  }

  // Tutor's rebuttal node (extracted from AI reply)
  // The tutor's question/challenge acts as a depth-1 attack
  if (aiReply && aiReply.length > 0) {
    const isChallenge = /왜|어떻게|반례|모순|정말|근거|과연/.test(aiReply);
    nodes.push({
      session_id: sessionId,
      turn_number: turnNumber,
      node_type: isChallenge ? 'rebuttal' : 'claim',
      author: 'tutor',
      content: aiReply.substring(0, 300), // Truncate for storage
      strength: 0.7, // Tutor questions are moderately strong
      depth: isChallenge ? 1 : 0,
    });
  }

  return { nodes, edges };
}

// ==============================================
// SQL: Insert argument node
// ==============================================
export function buildInsertNodeSQL(node: ArgumentNode): { sql: string; binds: unknown[] } {
  return {
    sql: `INSERT INTO argument_nodes (session_id, turn_number, node_type, author, content, strength, depth, parent_node_id, metadata, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    binds: [
      node.session_id, node.turn_number, node.node_type,
      node.author, node.content, node.strength, node.depth,
      node.parent_node_id || null,
      node.metadata ? JSON.stringify(node.metadata) : null,
      Date.now(),
    ],
  };
}

// ==============================================
// SQL: Insert argument edge
// ==============================================
export function buildInsertEdgeSQL(edge: ArgumentEdge): { sql: string; binds: unknown[] } {
  return {
    sql: `INSERT INTO argument_edges (session_id, source_node_id, target_node_id, edge_type, weight, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    binds: [
      edge.session_id, edge.source_node_id, edge.target_node_id,
      edge.edge_type, edge.weight, Date.now(),
    ],
  };
}

// ==============================================
// SQL: WITH RECURSIVE grounded extension check
// Depth-3 recursive attack chain resolution
// ==============================================
export const GROUNDED_EXTENSION_CTE = `
WITH RECURSIVE attack_chain(node_id, depth, is_defeated) AS (
  -- Base case: all root claims (depth=0) start as potentially grounded
  SELECT an.id AS node_id, 0 AS depth, 0 AS is_defeated
  FROM argument_nodes an
  WHERE an.session_id = ?1
    AND an.depth = 0

  UNION ALL

  -- Recursive step: follow attack edges up to depth 3
  SELECT
    ae.source_node_id AS node_id,
    ac.depth + 1 AS depth,
    CASE
      -- An attacker is defeated if IT has a stronger counter-attack
      WHEN EXISTS (
        SELECT 1 FROM argument_edges ae2
        JOIN argument_nodes an2 ON an2.id = ae2.source_node_id
        WHERE ae2.target_node_id = ae.source_node_id
          AND an2.strength > (SELECT strength FROM argument_nodes WHERE id = ae.source_node_id)
      ) THEN 1
      ELSE 0
    END AS is_defeated
  FROM argument_edges ae
  JOIN attack_chain ac ON ae.target_node_id = ac.node_id
  WHERE ac.depth < 3
    AND ae.edge_type = 'attack'
)
SELECT
  an.id,
  an.content,
  an.node_type,
  an.author,
  an.strength,
  an.depth AS node_depth,
  -- A node is grounded if all its attackers are defeated
  CASE
    WHEN (
      SELECT COUNT(*) FROM argument_edges ae
      WHERE ae.target_node_id = an.id AND ae.edge_type = 'attack'
    ) = 0 THEN 1  -- No attackers → grounded
    WHEN (
      SELECT COUNT(*) FROM argument_edges ae
      JOIN attack_chain ac ON ac.node_id = ae.source_node_id
      WHERE ae.target_node_id = an.id
        AND ae.edge_type = 'attack'
        AND ac.is_defeated = 0
    ) = 0 THEN 1  -- All attackers defeated → grounded
    ELSE 0  -- Has undefeated attackers → not grounded
  END AS is_grounded,
  (SELECT COUNT(*) FROM argument_edges ae WHERE ae.target_node_id = an.id AND ae.edge_type = 'attack') AS attacker_count
FROM argument_nodes an
WHERE an.session_id = ?1
ORDER BY an.turn_number ASC, an.depth ASC;
`;

// ==============================================
// Compute logical consistency score from grounded extension
// ==============================================
export function computeLogicalConsistencyScore(
  groundedResults: GroundedResult[],
): { score: number; groundedRatio: number; summary: string } {
  if (groundedResults.length === 0) {
    return { score: 50, groundedRatio: 0, summary: '논증 노드가 아직 없습니다.' };
  }

  const studentNodes = groundedResults.filter(r => r.depth === 0);
  const groundedCount = studentNodes.filter(r => r.isGrounded).length;
  const totalCount = studentNodes.length;
  const groundedRatio = totalCount > 0 ? groundedCount / totalCount : 0;

  // Score: 0-100 based on grounded ratio + average strength
  const avgStrength = groundedResults.reduce((sum, r) => sum + (r.isGrounded ? 1 : 0), 0) / groundedResults.length;
  const score = Math.round(groundedRatio * 70 + avgStrength * 30);

  const summary = groundedRatio >= 0.8
    ? `학생의 주장 ${groundedCount}/${totalCount}개가 논리적으로 방어됨 (강함)`
    : groundedRatio >= 0.5
    ? `학생의 주장 ${groundedCount}/${totalCount}개가 방어됨, 일부 취약점 존재`
    : `학생의 주장 ${groundedCount}/${totalCount}개만 방어됨, 논증 보강 필요`;

  return { score, groundedRatio, summary };
}

// ==============================================
// Auto-link edges between consecutive turns
// ==============================================
export function inferAttackEdges(
  sessionId: string,
  nodes: { id: number; turn_number: number; author: string; node_type: string; strength: number }[],
): ArgumentEdge[] {
  const edges: ArgumentEdge[] = [];

  // Simple heuristic: tutor rebuttals attack the previous student claim
  for (let i = 1; i < nodes.length; i++) {
    const current = nodes[i];
    const previous = nodes[i - 1];

    // Tutor rebuttal → attacks student claim
    if (current.author === 'tutor' && current.node_type === 'rebuttal' &&
        previous.author === 'student' && previous.node_type === 'claim') {
      edges.push({
        session_id: sessionId,
        source_node_id: current.id,
        target_node_id: previous.id,
        edge_type: 'attack',
        weight: current.strength,
      });
    }

    // Student re-rebuttal → attacks tutor rebuttal
    if (current.author === 'student' && current.turn_number > previous.turn_number &&
        previous.author === 'tutor' && previous.node_type === 'rebuttal') {
      edges.push({
        session_id: sessionId,
        source_node_id: current.id,
        target_node_id: previous.id,
        edge_type: 'attack',
        weight: current.strength,
      });
    }
  }

  return edges;
}
