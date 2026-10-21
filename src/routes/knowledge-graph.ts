import { Hono } from 'hono';
import type { Bindings } from '../types';
import { requireAuth, getAuthUser } from '../middleware/auth';

const knowledgeGraphRoute = new Hono<{ Bindings: Bindings }>();

// Require authentication for all knowledge-graph routes
knowledgeGraphRoute.use('/api/knowledge-graph/*', requireAuth);

/**
 * POST /api/knowledge-graph/synapse-update
 *
 * 시냅스(엣지) 가중치를 EMA 공식으로 동적 업데이트합니다.
 *
 * Request body:
 * {
 *   fromNodeId: string,
 *   toNodeId: string,
 *   answerSpeedMs: number,        // 답변 속도 (밀리초)
 *   metaphorDensity: number,      // 은유 밀도 (0~1)
 *   counterQuestionDepth: number  // 반질문 깊이 (0~3)
 * }
 *
 * Response:
 * {
 *   userId: string,
 *   fromNodeId: string,
 *   toNodeId: string,
 *   oldWeight: number,
 *   newWeight: number,
 *   signal: {
 *     speedComponent: number,
 *     metaphorComponent: number,
 *     counterComponent: number,
 *     normalizedSignal: number
 *   }
 * }
 */
knowledgeGraphRoute.post('/api/knowledge-graph/synapse-update', async (c) => {
  const auth = getAuthUser(c);
  if (!auth?.userId) {
    return c.json({ error: '인증이 필요합니다.' }, 401);
  }

  return c.json({ error: 'synapse_update_unavailable', reason: 'learner_signal_not_server_verified' }, 409);
});

/**
 * GET /api/knowledge-graph/nodes/:nodeId
 * 특정 노드의 상세 정보를 조회합니다.
 */
knowledgeGraphRoute.get('/api/knowledge-graph/nodes/:nodeId', async (c) => {
  const nodeId = c.req.param('nodeId');

  try {
    const node = await c.env.DB.prepare(
      `
      SELECT
        id, domain_id, concept, category, bloom_level,
        description, core_essence, building_blocks_json, metaphorical_bridges_json,
        metadata_json, created_at
      FROM knowledge_nodes
      WHERE id = ?1
    `,
    )
      .bind(nodeId)
      .first<Record<string, unknown>>();

    if (!node) {
      return c.json({ error: '노드를 찾을 수 없습니다.' }, 404);
    }

    // JSON 필드 파싱
    const { metadata_json, building_blocks_json, metaphorical_bridges_json, ...nodeFields } = node;
    const parsedNode = {
      ...nodeFields,
      metadata: JSON.parse(typeof metadata_json === 'string' ? metadata_json : '{}'),
      coreEssence: typeof node.core_essence === 'string' ? node.core_essence : '',
      buildingBlocks: JSON.parse(typeof building_blocks_json === 'string' ? building_blocks_json : '{}'),
      metaphoricalBridges: JSON.parse(typeof metaphorical_bridges_json === 'string' ? metaphorical_bridges_json : '{}'),
    };

    return c.json(parsedNode);
  } catch (error) {
    console.error('노드 조회 중 오류:', error);
    return c.json({ error: '노드 조회 실패' }, 500);
  }
});

/**
 * GET /api/knowledge-graph/domain/:domainId/edges
 * 특정 도메인의 모든 엣지(시냅스)를 조회합니다.
 */
knowledgeGraphRoute.get('/api/knowledge-graph/domain/:domainId/edges', async (c) => {
  const domainId = c.req.param('domainId');

  try {
    const edges = await c.env.DB.prepare(
      `
      SELECT
        id, domain_id, from_id, to_id, relation_type, strength, metadata_json, created_at
      FROM knowledge_edges
      WHERE domain_id = ?1
      ORDER BY created_at DESC
    `,
    )
      .bind(domainId)
      .all<Record<string, unknown>>();

    const parsedEdges = (edges.results || []).map((edge: Record<string, unknown>) => ({
      ...edge,
      metadata: JSON.parse((edge.metadata_json as string) || '{}'),
    }));

    return c.json({
      domainId,
      edges: parsedEdges,
      total: parsedEdges.length,
    });
  } catch (error) {
    console.error('엣지 조회 중 오류:', error);
    return c.json({ error: '엣지 조회 실패' }, 500);
  }
});

/**
 * GET /api/knowledge-graph/domain/:domainId/full-graph
 * 특정 도메인의 전체 그래프(노드 + 엣지 + 사용자 시냅스 가중치)를 조회합니다.
 *
 * Response schema:
 * {
 *   nodes: [
 *     { id, concept, description, mastery?, bloom_level, core_essence, building_blocks_json, metaphorical_bridges_json }
 *   ],
 *   edges: [
 *     { id, from_id, to_id, relation_type, strength }
 *   ],
 *   synapses: [
 *     { from_id, to_id, synapse_weight, user_id }
 *   ]
 * }
 */
knowledgeGraphRoute.get('/api/knowledge-graph/domain/:domainId/full-graph', async (c) => {
  const domainId = c.req.param('domainId');
  const auth = getAuthUser(c);
  if (!auth?.userId) return c.json({ error: '인증이 필요합니다.' }, 401);

  try {
    // 1. 모든 노드 조회
    const nodesResult = await c.env.DB.prepare(
      `
      SELECT
        id, domain_id, concept, category, bloom_level,
        description, core_essence, building_blocks_json, metaphorical_bridges_json,
        metadata_json, created_at
      FROM knowledge_nodes
      WHERE domain_id = ?1
      ORDER BY created_at ASC
    `,
    )
      .bind(domainId)
      .all<Record<string, unknown>>();

    const nodes = (nodesResult.results || []).map((node: Record<string, unknown>) => ({
      id: node.id,
      concept: node.concept,
      description: node.description,
      bloomLevel: node.bloom_level,
      coreEssence: node.core_essence || '',
      buildingBlocks: JSON.parse((node.building_blocks_json as string) || '{}'),
      metaphoricalBridges: JSON.parse((node.metaphorical_bridges_json as string) || '{}'),
      metadata: JSON.parse(typeof node.metadata_json === 'string' ? node.metadata_json : '{}'),
    }));

    // 2. 모든 엣지 조회
    const edgesResult = await c.env.DB.prepare(
      `
      SELECT
        id, domain_id, from_id, to_id, relation_type, strength, metadata_json
      FROM knowledge_edges
      WHERE domain_id = ?1
      ORDER BY created_at ASC
    `,
    )
      .bind(domainId)
      .all<Record<string, unknown>>();

    const edges = (edgesResult.results || []).map((edge: Record<string, unknown>) => ({
      id: edge.id,
      fromId: edge.from_id,
      toId: edge.to_id,
      relationType: edge.relation_type,
      strength: edge.strength,
    }));

    // Per-user progress is read from the same composite key that the updater writes.
    const [synapsesResult, masteryResult] = await Promise.all([
      c.env.DB.prepare(`
        SELECT from_node_id, to_node_id, synapse_weight, user_id
        FROM user_knowledge_synapses
        WHERE domain_id = ?1 AND user_id = ?2
        ORDER BY updated_at DESC
      `).bind(domainId, auth.userId).all<Record<string, unknown>>(),
      c.env.DB.prepare(`
        SELECT concept_id, p_know
        FROM user_concept_mastery
        WHERE user_id = ?1 AND concept_id IN (
          SELECT id FROM knowledge_nodes WHERE domain_id = ?2
        )
      `).bind(auth.userId, domainId).all<Record<string, unknown>>(),
    ]);
    const masteryByNode = new Map((masteryResult.results || []).map((row) => [
      String(row.concept_id), typeof row.p_know === 'number' ? row.p_know : null,
    ]));
    const learnerNodes = nodes.map((node) => ({
      ...node,
      mastery: masteryByNode.get(String(node.id)) ?? null,
    }));
    const synapses = (synapsesResult.results || []).map((syn) => ({
      fromId: syn.from_node_id,
      toId: syn.to_node_id,
      synapseWeight: syn.synapse_weight,
      userId: syn.user_id,
    }));

    return c.json({
      domainId,
      nodes: learnerNodes,
      edges,
      synapses,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      totalSynapses: synapses.length,
    });
  } catch (error) {
    console.error('전체 그래프 조회 중 오류:', error);
    return c.json({ error: '그래프 조회 실패' }, 500);
  }
});

export { knowledgeGraphRoute };
