import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLearningEngineDatabase } from './fixtures/learning-engine-db';
import { retrieveGraphRAGContext } from '../src/services/math/knowledge-graph';
import { selectActionByMAB, selectActionByUCB1, type QTableEntry } from '../src/services/math/mab-engine';
import { selectActionViaBandit } from '../src/services/mab-engine';
import { persistTurnSnapshot } from '../src/services/tutoring/process-evaluator';
import type { TutorAction } from '../src/services/tutoring/types';

const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
function database() {
  const fixture = createLearningEngineDatabase();
  databases.push(fixture.sqlite);
  return fixture;
}
const excluded: TutorAction[] = ['ask_clarification', 'ask_counterexample', 'ask_revision', 'narrow_scope', 'give_hint', 'request_text_reference', 'move_to_synthesis'];

describe('nullable persisted learning observations', () => {
  it('does not describe a NULL mastery probability as a measured zero-percent weakness', async () => {
    const { sqlite, db } = database();
    sqlite.exec("INSERT INTO bkt_knowledge_states (user_id, concept, p_know) VALUES ('learner', 'unobserved', NULL)");
    const context = await retrieveGraphRAGContext(db, 'session-a', 'learner', 'elicitation', []);
    expect(context.relevantConcepts).toEqual([]);
  });

  it('fills the weakness limit with observed probabilities instead of earlier NULL rows', async () => {
    const { sqlite, db } = database();
    sqlite.exec("INSERT INTO bkt_knowledge_states (user_id, concept, p_know) VALUES ('learner', 'unknown-a', NULL), ('learner', 'unknown-b', NULL), ('learner', 'unknown-c', NULL), ('learner', 'observed', 0.4)");
    const context = await retrieveGraphRAGContext(db, 'session-a', 'learner', 'elicitation', []);
    expect(context.relevantConcepts).toEqual(['[약점: observed] (마스터리 확률: 40%)']);
  });

  it.each([0, 6])('preserves a NULL reward in the database bandit path with %i observations', async (observations) => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { sqlite, db } = database();
    sqlite.exec('DELETE FROM tutor_policy_q_table');
    sqlite.prepare('INSERT INTO tutor_policy_q_table (student_level_bucket, tutor_action, times_selected, avg_reward) VALUES (?, ?, ?, NULL)')
      .run('novice', 'ask_evidence', observations);
    const decision = await selectActionViaBandit(db, 'novice', ['ask_evidence']);
    expect(decision.avgReward).toBeNull();
  });

  it('uses the unobserved action prior when a persisted reward is NULL', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const rows: QTableEntry[] = [
      { student_level_bucket: 'novice', tutor_action: 'ask_evidence', times_selected: 6, total_reward: null, avg_reward: null },
      { student_level_bucket: 'novice', tutor_action: 'ask_reasoning', times_selected: 6, total_reward: 2.4, avg_reward: 0.4 },
    ];
    expect(selectActionByMAB(rows, 'novice', excluded).action).toBe('ask_evidence');
  });

  it('does not calculate an observed UCB reward from a NULL average', () => {
    const rows: QTableEntry[] = [{ student_level_bucket: 'novice', tutor_action: 'ask_evidence', times_selected: 6, total_reward: null, avg_reward: null }];
    expect(selectActionByUCB1(rows, 'novice', 10, [...excluded, 'ask_reasoning'])).toEqual({ action: 'ask_evidence', ucbScore: Infinity });
  });

  it('preserves an unknown revision observation when storing a process snapshot', async () => {
    const { sqlite, db } = database();
    sqlite.exec(readFileSync(new URL('../migrations/0020_v18_xaif_process_evaluation.sql', import.meta.url), 'utf8'));
    await persistTurnSnapshot(db, 'session-a', {
      turnNumber: 1,
      microScores: { axisSummary: { logical: 0.4, data: 0.5, flexibility: 0.6, communication: 0.7 }, overallScore: 0.55, scores: [] },
      daAct: null, illocutionaryStrength: null, state: null, pressureMove: null, revisionOccurred: null,
    });
    expect(sqlite.prepare('SELECT da_act, illocutionary_strength, state, revision_occurred FROM session_process_snapshots').get())
      .toEqual({ da_act: null, illocutionary_strength: null, state: null, revision_occurred: null });
  });
});
