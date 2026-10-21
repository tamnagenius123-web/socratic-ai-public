import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedLearningDatabase } from './fixtures/learning-engine-db';
import { buildAIFGraph, persistAIFToD1 } from '../src/services/math/aif-pipeline';
import { processArgumentGraph } from '../src/services/faf-engine';
import { argumentGraphTables } from '../src/services/argument-graph-store';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function database() {
  const fixture = createMigratedLearningDatabase();
  databases.push(fixture.sqlite);
  fixture.sqlite.prepare(`INSERT INTO training_sessions
    (id, category, difficulty, question, session_goal)
    VALUES (?, 'social_science', 'intermediate', '질문', '근거를 사용해 판단하기')`).run('training-a');
  fixture.sqlite.prepare(`INSERT INTO training_sessions
    (id, category, difficulty, question, session_goal)
    VALUES (?, 'social_science', 'intermediate', '질문', '근거를 사용해 판단하기')`).run('training-b');
  return fixture;
}

type FailurePoint = 'node' | 'edge' | 'grounded-update';

function databaseThatFailsDuringTrainingGraphWrite(db: D1Database, failurePoint: FailurePoint): D1Database {
  let matchingStatementCount = 0;
  const shouldFail = (sql: string) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    const matches = failurePoint === 'node'
      ? normalized.startsWith('INSERT INTO training_argument_nodes')
      : failurePoint === 'edge'
        ? normalized.startsWith('INSERT INTO training_argument_edges')
        : normalized.startsWith('UPDATE training_argument_nodes SET is_grounded');
    if (!matches) return false;
    matchingStatementCount += 1;
    return failurePoint !== 'node' || matchingStatementCount === 2;
  };

  return {
    ...db,
    prepare(sql: string) {
      const prepared = db.prepare(sql);
      return {
        bind(...values: unknown[]) {
          const bound = prepared.bind(...values);
          if (!shouldFail(sql)) return bound;
          return {
            ...bound,
            async run() { throw new Error(`injected ${failurePoint} failure`); },
          };
        },
      };
    },
  } as D1Database;
}

function expectNoCurrentTrainingGraphRows(sqlite: DatabaseSync) {
  expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_argument_nodes WHERE session_id = ?').get('training-a'))
    .toEqual({ count: 0 });
  expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_argument_edges WHERE session_id = ?').get('training-a'))
    .toEqual({ count: 0 });
}

describe('Training-owned argument graph persistence', () => {
  it('persists AIF and grounded FAF evidence under a real Training parent only', async () => {
    const { sqlite, db, failures } = database();
    const graph = buildAIFGraph('training-a', 1, {
      iNodes: [
        { id: 'claim', type: 'claim', text: '학습자 주장', author: 'student', turn: 1, confidence: 0.7 },
        { id: 'counter', type: 'rebuttal', text: '튜터 반론', author: 'tutor', turn: 1, confidence: 0.8 },
      ],
      edges: [{ id: 'attack', from: 'counter', to: 'claim', relation: 'attack', strength: 0.8 }],
    });

    await persistAIFToD1(db, 'training-a', graph, 'training');
    const analysis = await processArgumentGraph(db, 'training-a', 1, '학습자 주장', '튜터 반론', {
      claim_clarity: 3,
      evidence_use: 3,
      reasoning_strength: 3,
    }, 'training');

    expect(analysis.totalNodes).toBeGreaterThanOrEqual(3);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_argument_nodes WHERE session_id = ?').get('training-a'))
      .toEqual({ count: 5 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_argument_edges WHERE session_id = ?').get('training-a'))
      .toEqual({ count: 2 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM argument_nodes WHERE session_id = ?').get('training-a'))
      .toEqual({ count: 0 });
    expect(failures).toEqual([]);
  });

  it('rejects orphan nodes and edges that cross Training session custody', async () => {
    const { sqlite } = database();
    expect(() => sqlite.prepare(`INSERT INTO training_argument_nodes
      (id, session_id, turn_number, node_type, content) VALUES ('orphan-node', 'missing', 1, 'claim', 'x')`).run())
      .toThrow(/FOREIGN KEY/);

    sqlite.prepare(`INSERT INTO training_argument_nodes
      (id, session_id, turn_number, node_type, content) VALUES ('node-a', 'training-a', 1, 'claim', 'a')`).run();
    sqlite.prepare(`INSERT INTO training_argument_nodes
      (id, session_id, turn_number, node_type, content) VALUES ('node-b', 'training-b', 1, 'claim', 'b')`).run();
    expect(() => sqlite.prepare(`INSERT INTO training_argument_nodes
      (id, session_id, turn_number, node_type, content, parent_node_id)
      VALUES ('cross-child', 'training-a', 1, 'claim', 'child', 'node-b')`).run())
      .toThrow(/FOREIGN KEY/);
    expect(() => sqlite.prepare(`INSERT INTO training_argument_edges
      (id, session_id, from_node_id, to_node_id, relation_type)
      VALUES ('cross-edge', 'training-a', 'node-a', 'node-b', 'attacks')`).run())
      .toThrow(/FOREIGN KEY/);
  });

  it('rejects an invalid runtime scope before a database statement can be prepared', () => {
    expect(() => argumentGraphTables('unexpected' as never)).toThrow('Unsupported argument graph scope.');
  });

  it('rolls back all current Training graph rows when a later node insert fails', async () => {
    const { sqlite, db } = database();
    await expect(processArgumentGraph(databaseThatFailsDuringTrainingGraphWrite(db, 'node'), 'training-a', 1, '학습자 주장', '튜터 반론', {
      claim_clarity: 3,
      evidence_use: 3,
      reasoning_strength: 3,
    }, 'training')).rejects.toThrow('injected node failure');

    expectNoCurrentTrainingGraphRows(sqlite);
  });

  it('rolls back all current Training graph rows when an edge insert fails', async () => {
    const { sqlite, db } = database();
    await expect(processArgumentGraph(databaseThatFailsDuringTrainingGraphWrite(db, 'edge'), 'training-a', 1, '학습자 주장', '튜터 반론', {
      claim_clarity: 3,
      evidence_use: 3,
      reasoning_strength: 3,
    }, 'training')).rejects.toThrow('injected edge failure');

    expectNoCurrentTrainingGraphRows(sqlite);
  });

  it('rolls back all current Training graph rows when a grounded-status update fails', async () => {
    const { sqlite, db } = database();
    await expect(processArgumentGraph(databaseThatFailsDuringTrainingGraphWrite(db, 'grounded-update'), 'training-a', 1, '학습자 주장', '튜터 반론', {
      claim_clarity: 3,
      evidence_use: 3,
      reasoning_strength: 3,
    }, 'training')).rejects.toThrow('injected grounded-update failure');

    expectNoCurrentTrainingGraphRows(sqlite);
  });

  it('cascades Training graph rows on parent deletion without leaving an xAIF derivative', async () => {
    const { sqlite, db } = database();
    await processArgumentGraph(db, 'training-a', 1, '학습자 주장', '튜터 반론', {
      claim_clarity: 3,
      evidence_use: 3,
      reasoning_strength: 3,
    }, 'training');

    sqlite.prepare('DELETE FROM training_sessions WHERE id = ?').run('training-a');

    expectNoCurrentTrainingGraphRows(sqlite);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM aif_graph_snapshots WHERE session_id = ?').get('training-a'))
      .toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM aif_l_nodes WHERE session_id = ?').get('training-a'))
      .toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM aif_ta_edges WHERE session_id = ?').get('training-a'))
      .toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM argument_scheme_stats WHERE session_id = ?').get('training-a'))
      .toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM xaif_jsonld_cache WHERE session_id = ?').get('training-a'))
      .toEqual({ count: 0 });
  });
});
