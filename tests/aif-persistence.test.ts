import type { DatabaseSync } from 'node:sqlite';
import { createLearningEngineDatabase } from './fixtures/learning-engine-db';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAIFGraph, extractAIFRuleBased, persistAIFToD1, type AIFGraph } from '../src/services/math/aif-pipeline';
import { queryGroundedNodes } from '../src/services/math/knowledge-graph';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function database() {
  const fixture = createLearningEngineDatabase();
  databases.push(fixture.sqlite);
  return fixture;
}

function graph(): AIFGraph {
  return buildAIFGraph('session-a', 1, {
    iNodes: [
      { id: 'claim', type: 'claim', text: 'Learner claim', author: 'student', turn: 1, confidence: 0.6 },
      { id: 'counter', type: 'rebuttal', text: 'Tutor counterargument', author: 'tutor', turn: 1, confidence: 0.8 },
      { id: 'evidence', type: 'evidence', text: 'Learner evidence', author: 'student', turn: 1, confidence: 0.9 },
    ],
    edges: [
      { id: 'attack', from: 'counter', to: 'claim', relation: 'attack', strength: 0.8 },
      { id: 'support', from: 'evidence', to: 'claim', relation: 'support', strength: 0.9 },
    ],
  });
}

describe('accepted AIF graph persistence', () => {
  it('keeps learner and tutor nodes and edges distinct when their turn numbers match', () => {
    const learner = extractAIFRuleBased('서로 다른 관점을 이해하는 태도가 중요한 가치입니다. 본문에서 인물이 상대의 이유를 듣고 판단을 바꿉니다.', 1, 'student');
    const tutor = extractAIFRuleBased('자신의 판단 근거를 확인하는 태도가 중요한 가치입니다. 본문에서 다른 인물의 경험이 판단의 근거가 됩니다.', 1, 'tutor');
    const merged = buildAIFGraph('session-a', 1, { iNodes: [...learner.iNodes, ...tutor.iNodes], edges: [...learner.edges, ...tutor.edges] });
    expect(merged.iNodes).toHaveLength(4);
    expect(new Set(merged.iNodes.map(node => node.id)).size).toBe(4);
    expect(merged.edges).toHaveLength(2);
    expect(new Set(merged.edges.map(edge => edge.id)).size).toBe(2);
    for (const edge of merged.edges) {
      expect(merged.iNodes.find(node => node.id === edge.from)?.author)
        .toBe(merged.iNodes.find(node => node.id === edge.to)?.author);
    }
  });

  it('persists connected nodes with their real authors and attack/support semantics', async () => {
    const { sqlite, db, failures } = database();
    await persistAIFToD1(db, 'session-a', graph());
    const rows = sqlite.prepare(`SELECT source.content AS source, source.author, target.content AS target, edge.edge_type_faf AS relation
      FROM argument_edges edge JOIN argument_nodes source ON source.id = edge.from_node_id
      JOIN argument_nodes target ON target.id = edge.to_node_id ORDER BY edge.id`).all();
    expect(rows).toEqual([
      { source: 'Tutor counterargument', author: 'tutor', target: 'Learner claim', relation: 'attack' },
      { source: 'Learner evidence', author: 'student', target: 'Learner claim', relation: 'support' },
    ]);
    const grounded = await queryGroundedNodes(db, 'session-a');
    expect(grounded.defeatedNodeIds).toEqual(['session-a_claim']);
    expect(failures).toEqual([]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM semantic_entropy_log').get()).toEqual({ count: 0 });
  });

  it('leaves no partial graph when a write fails and rejects instead of reporting success', async () => {
    const { sqlite, db } = database();
    sqlite.exec("CREATE TRIGGER reject_graph_edge BEFORE INSERT ON argument_edges BEGIN SELECT RAISE(ABORT, 'edge unavailable'); END;");
    await expect(persistAIFToD1(db, 'session-a', graph())).rejects.toThrow('edge unavailable');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM argument_nodes').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM argument_edges').get()).toEqual({ count: 0 });
  });

  it('retries the same graph without duplicating nodes or edges', async () => {
    const { sqlite, db } = database();
    await persistAIFToD1(db, 'session-a', graph());
    await persistAIFToD1(db, 'session-a', graph());
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM argument_nodes').get()).toEqual({ count: 3 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM argument_edges').get()).toEqual({ count: 2 });
  });
});
