// FAF Engine - Formal Argumentation Framework (Lightweight Dung's FAF)
// Uses SQLite WITH RECURSIVE CTE to evaluate argument graphs up to Depth 3
//
// Mathematical Model:
// - Node = claim/rebuttal/re-rebuttal
// - Edge = attack relationship (A attacks B)
// - Grounded semantics: a node is "grounded" if it has no undefeated attackers
//   i.e., all its attackers are themselves defeated
//
// WITH RECURSIVE approach:
//   1. Start with all root claims (depth=0)
//   2. For each node, find all attackers (depth+1)
//   3. A node is grounded iff every attacker is NOT grounded
//   4. Max depth = 3 (claim → rebuttal → re-rebuttal)
//
// This replaces the need for a full graph traversal library.

import { argumentGraphTables, type ArgumentGraphScope } from './argument-graph-store';

export interface ArgumentNode {
  id?: string;
  sessionId: string;
  turnNumber: number;
  nodeType: 'claim' | 'rebuttal' | 're_rebuttal' | 'evidence';
  author: 'student' | 'tutor';
  content: string;
  strength: number; // AI-assessed [0.0 ~ 1.0]
  depth: number;
  parentNodeId?: string | null;
}

export interface ArgumentEdge {
  sessionId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: 'attack' | 'support' | 'undercut';
  weight: number;
}

export interface GroundedResult {
  nodeId: string;
  content: string;
  author: string | null;
  isGrounded: boolean;
  depth: number;
  attackerCount: number;
  defeatedAttackers: number;
}

type GroundedResultRow = {
  id: string;
  content: string;
  author: string | null;
  depth: number | null;
  attacker_count: number;
  defeated_attackers: number;
  is_grounded: number;
};

export interface FAFAnalysis {
  totalNodes: number;
  studentClaims: number;
  tutorRebuttals: number;
  groundedClaims: number;
  ungroundedClaims: number;
  groundednessRatio: number; // 0.0 ~ 1.0: fraction of student claims that survived
  maxDepth: number;
  details: GroundedResult[];
}

// =============================================
// Record Argument Node (from AI extraction)
// =============================================
export async function recordArgumentNode(
  db: D1Database,
  node: ArgumentNode,
  scope: ArgumentGraphScope = 'sparring',
): Promise<string> {
  const tables = argumentGraphTables(scope);
  const nodeId = `arg_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
  await db.prepare(`
    INSERT INTO ${tables.nodes} (id, session_id, turn_number, node_type, author, content, strength, is_grounded, depth, parent_node_id, metadata_json)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, '{}')
  `).bind(
    nodeId,
    node.sessionId,
    node.turnNumber,
    node.nodeType,
    node.author,
    node.content,
    node.strength,
    node.depth,
    node.parentNodeId || null,
  ).run();
  return nodeId;
}

// =============================================
// Record Attack Edge
// =============================================
export async function recordArgumentEdge(
  db: D1Database,
  edge: ArgumentEdge,
  scope: ArgumentGraphScope = 'sparring',
): Promise<void> {
  const tables = argumentGraphTables(scope);
  const edgeId = `edge_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
  await db.prepare(`
    INSERT INTO ${tables.edges} (id, session_id, from_node_id, to_node_id, relation_type, weight, edge_type_faf, attack_weight, metadata_json)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5, ?6, '{}')
  `).bind(
    edgeId,
    edge.sessionId,
    edge.sourceNodeId,
    edge.targetNodeId,
    edge.edgeType,
    edge.weight,
  ).run();
}

// =============================================
// Evaluate Grounded Semantics via WITH RECURSIVE
// Core Mathematical Query:
// A claim is "grounded" iff ALL its attackers are NOT grounded
// (i.e., attackers are themselves defeated by other arguments)
// =============================================
export async function evaluateGroundedSemantics(
  db: D1Database,
  sessionId: string,
  scope: ArgumentGraphScope = 'sparring',
): Promise<FAFAnalysis> {
  const tables = argumentGraphTables(scope);
  // Step 1: Get all nodes for this session
  const nodesResult = await db.prepare(
    `SELECT id, node_type, author, content, strength, depth, parent_node_id FROM ${tables.nodes} WHERE session_id = ?1 ORDER BY turn_number ASC`
  ).bind(sessionId).all();

  const nodes = nodesResult.results || [];
  if (nodes.length === 0) {
    return {
      totalNodes: 0, studentClaims: 0, tutorRebuttals: 0,
      groundedClaims: 0, ungroundedClaims: 0, groundednessRatio: 0,
      maxDepth: 0, details: [],
    };
  }

  // Step 2: WITH RECURSIVE query to compute grounded status
  // This query walks the attack graph depth-first (max depth 3)
  // and determines which nodes are "grounded" (survive all attacks)
  const groundedQuery = await db.prepare(`
    WITH RECURSIVE attack_chain(node_id, attacker_id, chain_depth) AS (
      -- Base: find all direct attackers of each node
      SELECT e.to_node_id AS node_id, e.from_node_id AS attacker_id, 1 AS chain_depth
      FROM ${tables.edges} e
      WHERE e.session_id = ?1 AND (e.relation_type = 'attacks' OR e.edge_type_faf = 'attack')
      
      UNION ALL
      
      -- Recursive: find attackers of attackers (depth 2, 3)
      SELECT ac.attacker_id AS node_id, e.from_node_id AS attacker_id, ac.chain_depth + 1
      FROM attack_chain ac
      JOIN ${tables.edges} e ON e.to_node_id = ac.attacker_id
      WHERE e.session_id = ?1 AND ac.chain_depth < 3
        AND (e.relation_type = 'attacks' OR e.edge_type_faf = 'attack')
    ),
    -- Count attackers per node
    attack_counts AS (
      SELECT node_id, COUNT(DISTINCT attacker_id) AS total_attackers
      FROM attack_chain WHERE chain_depth = 1
      GROUP BY node_id
    ),
    -- Count attackers that are themselves attacked (i.e., defeated)
    defeated_attackers AS (
      SELECT ac1.node_id,
             COUNT(DISTINCT CASE WHEN ac2.attacker_id IS NOT NULL THEN ac1.attacker_id END) AS defeated_count
      FROM attack_chain ac1
      LEFT JOIN attack_chain ac2 ON ac2.node_id = ac1.attacker_id AND ac2.chain_depth = 1
      WHERE ac1.chain_depth = 1
      GROUP BY ac1.node_id
    )
    SELECT
      n.id, n.content, n.author, n.depth, n.node_type,
      COALESCE(atk.total_attackers, 0) AS attacker_count,
      COALESCE(def.defeated_count, 0) AS defeated_attackers,
      CASE
        WHEN COALESCE(atk.total_attackers, 0) = 0 THEN 1
        WHEN COALESCE(def.defeated_count, 0) >= COALESCE(atk.total_attackers, 0) THEN 1
        ELSE 0
      END AS is_grounded
    FROM ${tables.nodes} n
    LEFT JOIN attack_counts atk ON atk.node_id = n.id
    LEFT JOIN defeated_attackers def ON def.node_id = n.id
    WHERE n.session_id = ?1
    ORDER BY n.turn_number ASC
  `).bind(sessionId).all<GroundedResultRow>();

  const details: GroundedResult[] = (groundedQuery.results || []).map((row) => ({
    nodeId: row.id,
    content: row.content,
    author: row.author,
    isGrounded: row.is_grounded === 1,
    depth: row.depth ?? 0,
    attackerCount: row.attacker_count ?? 0,
    defeatedAttackers: row.defeated_attackers ?? 0,
  }));

  // Step 3: Update grounded status in DB
  const batch = details.map(d =>
    db.prepare(`UPDATE ${tables.nodes} SET is_grounded = ?1 WHERE id = ?2`)
      .bind(d.isGrounded ? 1 : 0, d.nodeId)
  );
  if (batch.length > 0) {
    await db.batch(batch);
  }

  // Step 4: Compute summary
  const studentClaims = details.filter(d => d.author === 'student');
  const tutorRebuttals = details.filter(d => d.author === 'tutor');
  const groundedClaims = studentClaims.filter(d => d.isGrounded).length;
  const maxDepth = Math.max(0, ...details.map(d => d.depth));

  return {
    totalNodes: details.length,
    studentClaims: studentClaims.length,
    tutorRebuttals: tutorRebuttals.length,
    groundedClaims,
    ungroundedClaims: studentClaims.length - groundedClaims,
    groundednessRatio: studentClaims.length > 0 ? groundedClaims / studentClaims.length : 0,
    maxDepth,
    details,
  };
}

// =============================================
// Extract Claims/Rebuttals from Conversation Turn
// Uses simple heuristic extraction (can be enhanced with AI later)
// =============================================
export function extractArgumentsFromTurn(
  sessionId: string,
  turnNumber: number,
  studentMessage: string,
  tutorResponse: string,
  evaluation: { claim_clarity: number; evidence_use: number; reasoning_strength: number },
): { studentNodes: ArgumentNode[]; tutorNodes: ArgumentNode[] } {
  const studentNodes: ArgumentNode[] = [];
  const tutorNodes: ArgumentNode[] = [];

  // Student claim: main argument from the student
  // Strength is derived from evaluation scores
  // Calculate strength: average of claim_clarity and reasoning_strength / 5
  const studentStrength = ((evaluation.claim_clarity + evaluation.reasoning_strength) / 2) / 5;
  studentNodes.push({
    sessionId,
    turnNumber,
    nodeType: turnNumber === 1 ? 'claim' : (turnNumber <= 3 ? 'claim' : 're_rebuttal'),
    author: 'student',
    content: studentMessage.substring(0, 500), // cap at 500 chars
    strength: clamp(studentStrength, 0, 1),
    depth: Math.min(2, Math.floor(turnNumber / 2)),
  });

  // If student cited evidence, add evidence node
  if (evaluation.evidence_use >= 3) {
    studentNodes.push({
      sessionId,
      turnNumber,
      nodeType: 'evidence',
      author: 'student',
      content: `[Evidence from turn ${turnNumber}]`,
      strength: evaluation.evidence_use / 5,
      depth: Math.min(2, Math.floor(turnNumber / 2)),
    });
  }

  // Tutor rebuttal node
  const tutorStrength = 0.6 + (Math.random() * 0.2); // Tutor typically has moderate-high strength
  tutorNodes.push({
    sessionId,
    turnNumber,
    nodeType: 'rebuttal',
    author: 'tutor',
    content: tutorResponse.substring(0, 500),
    strength: clamp(tutorStrength, 0, 1),
    depth: Math.min(2, Math.floor(turnNumber / 2) + 1),
  });

  return { studentNodes, tutorNodes };
}

type StoredArgumentNode = {
  id: string;
  session_id: string;
  turn_number: number;
  node_type: string;
  author: string | null;
  content: string;
  strength: number | null;
  is_grounded: number | null;
  depth: number | null;
  parent_node_id: string | null;
};

type StoredArgumentEdge = {
  id: string;
  session_id: string;
  from_node_id: string;
  to_node_id: string;
  relation_type: string;
  weight: number | null;
  edge_type_faf: string | null;
  attack_weight: number | null;
};

type PendingArgumentNode = ArgumentNode & { id: string };
type PendingArgumentEdge = ArgumentEdge & { id: string };

function isAttackEdge(edge: Pick<StoredArgumentEdge, 'relation_type' | 'edge_type_faf'>): boolean {
  return edge.relation_type === 'attacks' || edge.edge_type_faf === 'attack';
}

function analyzeArgumentGraph(nodes: StoredArgumentNode[], edges: StoredArgumentEdge[]): FAFAnalysis {
  const attackersByTarget = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!isAttackEdge(edge)) continue;
    const attackers = attackersByTarget.get(edge.to_node_id) || new Set<string>();
    attackers.add(edge.from_node_id);
    attackersByTarget.set(edge.to_node_id, attackers);
  }

  const details = nodes.map((node) => {
    const attackers = attackersByTarget.get(node.id) || new Set<string>();
    const defeatedAttackers = [...attackers].filter((attackerId) => (attackersByTarget.get(attackerId)?.size || 0) > 0).length;
    const attackerCount = attackers.size;
    return {
      nodeId: node.id,
      content: node.content,
      author: node.author,
      isGrounded: attackerCount === 0 || defeatedAttackers >= attackerCount,
      depth: node.depth ?? 0,
      attackerCount,
      defeatedAttackers,
    };
  });
  const studentClaims = details.filter((detail) => detail.author === 'student');
  const tutorRebuttals = details.filter((detail) => detail.author === 'tutor');
  const groundedClaims = studentClaims.filter((detail) => detail.isGrounded).length;

  return {
    totalNodes: details.length,
    studentClaims: studentClaims.length,
    tutorRebuttals: tutorRebuttals.length,
    groundedClaims,
    ungroundedClaims: studentClaims.length - groundedClaims,
    groundednessRatio: studentClaims.length > 0 ? groundedClaims / studentClaims.length : 0,
    maxDepth: Math.max(0, ...details.map((detail) => detail.depth)),
    details,
  };
}

async function processTrainingArgumentGraphAtomically(
  db: D1Database,
  sessionId: string,
  turnNumber: number,
  studentMessage: string,
  tutorResponse: string,
  evaluation: { claim_clarity: number; evidence_use: number; reasoning_strength: number },
): Promise<FAFAnalysis> {
  const tables = argumentGraphTables('training');
  const [existingNodeRows, existingEdgeRows] = await Promise.all([
    db.prepare(`SELECT id, session_id, turn_number, node_type, author, content, strength, is_grounded, depth, parent_node_id
      FROM ${tables.nodes} WHERE session_id = ?1 ORDER BY turn_number ASC, created_at ASC, id ASC`)
      .bind(sessionId).all<StoredArgumentNode>(),
    db.prepare(`SELECT id, session_id, from_node_id, to_node_id, relation_type, weight, edge_type_faf, attack_weight
      FROM ${tables.edges} WHERE session_id = ?1 ORDER BY created_at ASC, id ASC`)
      .bind(sessionId).all<StoredArgumentEdge>(),
  ]);
  const existingNodes = existingNodeRows.results || [];
  const existingEdges = existingEdgeRows.results || [];
  const { studentNodes, tutorNodes } = extractArgumentsFromTurn(
    sessionId, turnNumber, studentMessage, tutorResponse, evaluation,
  );
  const currentNodes: PendingArgumentNode[] = [
    ...studentNodes.map((node, index) => ({ ...node, id: `training_faf_${sessionId}_${turnNumber}_student_${index}` })),
    ...tutorNodes.map((node, index) => ({ ...node, id: `training_faf_${sessionId}_${turnNumber}_tutor_${index}` })),
  ];
  const currentStudentIds = currentNodes.filter((node) => node.author === 'student').map((node) => node.id);
  const currentTutorIds = currentNodes.filter((node) => node.author === 'tutor').map((node) => node.id);
  const currentEdges: PendingArgumentEdge[] = [];
  if (currentStudentIds[0] && currentTutorIds[0]) {
    currentEdges.push({
      id: `training_faf_${sessionId}_${turnNumber}_tutor_attack`,
      sessionId,
      sourceNodeId: currentTutorIds[0],
      targetNodeId: currentStudentIds[0],
      edgeType: 'attack',
      weight: 0.7,
    });
  }
  if (turnNumber > 2 && currentStudentIds[0]) {
    const priorTutor = [...existingNodes].reverse().find((node) => node.author === 'tutor' && node.turn_number === turnNumber - 1);
    if (priorTutor) {
      currentEdges.push({
        id: `training_faf_${sessionId}_${turnNumber}_student_attack`,
        sessionId,
        sourceNodeId: currentStudentIds[0],
        targetNodeId: priorTutor.id,
        edgeType: 'attack',
        weight: clamp(evaluation.reasoning_strength / 5, 0, 1),
      });
    }
  }

  const graphNodes: StoredArgumentNode[] = [
    ...existingNodes,
    ...currentNodes.map((node) => ({
      id: node.id,
      session_id: node.sessionId,
      turn_number: node.turnNumber,
      node_type: node.nodeType,
      author: node.author,
      content: node.content,
      strength: node.strength,
      is_grounded: 0,
      depth: node.depth,
      parent_node_id: node.parentNodeId || null,
    })),
  ];
  const graphEdges: StoredArgumentEdge[] = [
    ...existingEdges,
    ...currentEdges.map((edge) => ({
      id: edge.id,
      session_id: edge.sessionId,
      from_node_id: edge.sourceNodeId,
      to_node_id: edge.targetNodeId,
      relation_type: edge.edgeType,
      weight: edge.weight,
      edge_type_faf: edge.edgeType,
      attack_weight: edge.weight,
    })),
  ];
  const analysis = analyzeArgumentGraph(graphNodes, graphEdges);
  const createdAt = Date.now();
  const statements: D1PreparedStatement[] = [
    ...currentNodes.map((node) => db.prepare(`INSERT INTO ${tables.nodes}
      (id, session_id, turn_number, node_type, author, content, strength, is_grounded, depth, parent_node_id, metadata_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, '{}', ?10)`)
      .bind(node.id, node.sessionId, node.turnNumber, node.nodeType, node.author, node.content, node.strength, node.depth, node.parentNodeId || null, createdAt)),
    ...currentEdges.map((edge) => db.prepare(`INSERT INTO ${tables.edges}
      (id, session_id, from_node_id, to_node_id, relation_type, weight, edge_type_faf, attack_weight, metadata_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '{}', ?9)`)
      .bind(edge.id, edge.sessionId, edge.sourceNodeId, edge.targetNodeId, edge.edgeType, edge.weight, edge.edgeType, edge.weight, createdAt)),
    ...analysis.details.map((detail) => db.prepare(`UPDATE ${tables.nodes} SET is_grounded = ?1 WHERE id = ?2 AND session_id = ?3`)
      .bind(detail.isGrounded ? 1 : 0, detail.nodeId, sessionId)),
  ];
  await db.batch(statements);
  return analysis;
}

// =============================================
// Full Pipeline: Extract → Record → Evaluate
// =============================================
export async function processArgumentGraph(
  db: D1Database,
  sessionId: string,
  turnNumber: number,
  studentMessage: string,
  tutorResponse: string,
  evaluation: { claim_clarity: number; evidence_use: number; reasoning_strength: number },
  scope: ArgumentGraphScope = 'sparring',
): Promise<FAFAnalysis> {
  if (scope === 'training') {
    return processTrainingArgumentGraphAtomically(db, sessionId, turnNumber, studentMessage, tutorResponse, evaluation);
  }
  const { studentNodes, tutorNodes } = extractArgumentsFromTurn(
    sessionId, turnNumber, studentMessage, tutorResponse, evaluation,
  );

  // Record student nodes
  const studentNodeIds: string[] = [];
  for (const node of studentNodes) {
    const id = await recordArgumentNode(db, node, scope);
    studentNodeIds.push(id);
  }

  // Record tutor nodes
  const tutorNodeIds: string[] = [];
  for (const node of tutorNodes) {
    const id = await recordArgumentNode(db, node, scope);
    tutorNodeIds.push(id);
  }

  // Create attack edges: tutor rebuttals attack student claims
  if (studentNodeIds.length > 0 && tutorNodeIds.length > 0) {
    await recordArgumentEdge(db, {
      sessionId,
      sourceNodeId: tutorNodeIds[0],       // tutor's rebuttal
      targetNodeId: studentNodeIds[0],     // student's claim
      edgeType: 'attack',
      weight: 0.7,
    }, scope);
  }

  // If this is turn > 2, student's re-rebuttal attacks previous tutor rebuttal
  if (turnNumber > 2 && studentNodeIds.length > 0) {
    // Find the previous tutor node
    const prevTutorNode = await db.prepare(
      `SELECT id FROM ${argumentGraphTables(scope).nodes} WHERE session_id = ?1 AND author = 'tutor' AND turn_number = ?2 LIMIT 1`
    ).bind(sessionId, turnNumber - 1).first();

    if (prevTutorNode) {
      await recordArgumentEdge(db, {
        sessionId,
        sourceNodeId: studentNodeIds[0],
        targetNodeId: prevTutorNode.id as string,
        edgeType: 'attack',
        weight: clamp(evaluation.reasoning_strength / 5, 0, 1),
      }, scope);
    }
  }

  // Evaluate grounded semantics
  return evaluateGroundedSemantics(db, sessionId, scope);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
