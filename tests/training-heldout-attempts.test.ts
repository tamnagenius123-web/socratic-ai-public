import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import type { DatabaseSync } from 'node:sqlite';
import { createMigratedLearningDatabase } from './fixtures/learning-engine-db';
import { generateTokens } from '../src/services/auth';
import type { Bindings } from '../src/types';

const { startTrainingSession, trainingRoute } = await import('../src/routes/training');
const { default: historyRoute } = await import('../src/routes/history');
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
  const database = createMigratedLearningDatabase();
  databases.push(database.sqlite);
  const { sqlite, db } = database;
  sqlite.exec(`
    INSERT INTO users (id, username, email, password_hash, role) VALUES
      ('learner-a', 'learner-a', 'learner-a@example.test', 'fixture-only', 'student'),
      ('learner-b', 'learner-b', 'learner-b@example.test', 'fixture-only', 'student'),
      ('local-admin', 'local-admin', 'local-admin@example.test', 'fixture-only', 'admin'),
      ('other-admin', 'other-admin', 'other-admin@example.test', 'fixture-only', 'admin');
  `);
  const category = sqlite.prepare('SELECT id FROM category_hierarchy WHERE is_active = 1 LIMIT 1').get() as { id: string };
  const sources = [
    ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'Synthetic example: demand and seasonality', 'Socratic AI synthetic example', 'synthetic-demand-seasonality', 'seasonality demand attendance operating cost'],
    ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'Synthetic example: demand and seasonality', 'Socratic AI synthetic example', 'synthetic-demand-weather', 'weather leisure demand facilities'],
    ['SYNTHETIC-HH-OPERATIONS-EXAMPLE', 'Synthetic example: operations and safety', 'Socratic AI synthetic example', 'synthetic-operations-safety', 'safety maintenance competition attendance demand'],
  ] as const;
  for (const [bookId, title, author, chunkId, content] of sources) {
    sqlite.prepare('INSERT OR IGNORE INTO books (id, title, author, text, is_builtin, visibility, lifecycle_status) VALUES (?, ?, ?, ?, 1, \'builtin\', \'active\')')
      .run(bookId, title, author, content);
    const index = (sqlite.prepare('SELECT COUNT(*) AS count FROM document_chunks WHERE book_id = ?').get(bookId) as { count: number }).count;
    sqlite.prepare('INSERT INTO document_chunks (id, book_id, chunk_index, content, char_start, char_end) VALUES (?, ?, ?, ?, 0, ?)')
      .run(chunkId, bookId, index, content, content.length);
  }
  const env = {
    DB: db,
    JWT_SECRET: 'heldout-fixture-secret',
    AI_ACTOR_SSU_API_KEY: '[REDACTED]',
    AI_ASSESSMENT_DEEPSEEK_API_KEY: '[REDACTED]',
    SOONGSIL_API_KEY: '[REDACTED]',
    DEEPSEEK_API_KEY: '[REDACTED]',
  } as Bindings;
  const base = await startTrainingSession(env, 'learner-a', {
    category: category.id,
    difficulty: 'intermediate',
    mode: 'evidence',
    caseId: 'HH-INVEST-100B',
    evidenceQuery: 'seasonality safety demand',
    evidenceBookIds: ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'SYNTHETIC-HH-OPERATIONS-EXAMPLE'],
    maxTurns: 1,
  });
  const now = 1_700_000_000_000;
  sqlite.prepare('INSERT INTO training_messages (session_id, role, content, turn, timestamp) VALUES (?, \'user\', ?, 1, ?)')
    .run(base.sessionId, 'Initial accepted learner response.', now);
  sqlite.prepare('INSERT INTO training_messages (session_id, role, content, turn, timestamp) VALUES (?, \'ai\', ?, 1, ?)')
    .run(base.sessionId, 'Recorded application response.', now + 1);
  sqlite.prepare(`INSERT INTO training_turns (
    session_id, turn_number, student_message, ai_response,
    claim_clarity, evidence_use, reasoning_strength, consistency_score, relevance_score,
    created_at
  ) VALUES (?, 1, ?, ?, 3, 3, 3, 3, 3, ?)`)
    .run(base.sessionId, 'Initial accepted learner response.', 'Recorded application response.', now + 1);
  const initialTurn = sqlite.prepare('SELECT id FROM training_turns WHERE session_id = ? AND turn_number = 1').get(base.sessionId) as { id: number };
  const source = sqlite.prepare('SELECT source_id FROM training_scenario_evidence WHERE session_id = ? ORDER BY selection_index LIMIT 1').get(base.sessionId) as { source_id: string };
  const manifest = sqlite.prepare('SELECT evidence_manifest_sha256 FROM training_scenario_packs WHERE session_id = ?').get(base.sessionId) as { evidence_manifest_sha256: string };
  sqlite.prepare('UPDATE training_sessions SET current_turn = 2, updated_at = ? WHERE id = ?').run(now + 2, base.sessionId);
  sqlite.prepare(`INSERT INTO training_interventions (id, session_id, owner_user_id, revision, expected_revision, mutation_key, action, reason, origin, prior_turn_id, created_at)
    VALUES ('help-m4-path', ?, 'learner-a', 1, 0, 'help-m4-path-key', 'HELP', 'LEARNER_REQUEST', 'LEARNER', ?, ?)`)
    .run(base.sessionId, initialTurn.id, now + 3);
  sqlite.prepare(`INSERT INTO training_support_responses (intervention_id, session_id, response, source_ids_json, diagnosis_snapshot, routing_json, policy_revision, created_at)
    VALUES ('help-m4-path', ?, 'Committed bounded support.', ?, 'fixture diagnosis', '{}', 'bounded-support-v1', ?)`)
    .run(base.sessionId, JSON.stringify([source.source_id]), now + 4);
  sqlite.prepare(`INSERT INTO training_learner_revision_events (id, session_id, owner_user_id, revision_number, expected_revision, mutation_key, prior_turn_id, prior_turn_number, prior_statement, revised_statement, explanation, source_ids_json, evidence_manifest_sha256, validation_status, policy_revision, created_at)
    VALUES ('revision-m4-path', ?, 'learner-a', 1, 0, 'revision-m4-path-key', ?, 1, 'Initial accepted learner response.', 'Revised synthetic learner statement.', 'Synthetic revision explanation.', ?, ?, 'UNVERIFIED', 'learner-revision-v1', ?)`)
    .run(base.sessionId, initialTurn.id, JSON.stringify([source.source_id]), manifest.evidence_manifest_sha256, now + 5);
  sqlite.prepare('INSERT INTO training_messages (session_id, role, content, turn, timestamp) VALUES (?, ?, ?, 2, ?)')
    .run(base.sessionId, 'user', 'Revised synthetic learner statement.', now + 6);
  sqlite.prepare('INSERT INTO training_messages (session_id, role, content, turn, timestamp) VALUES (?, ?, ?, 2, ?)')
    .run(base.sessionId, 'ai', 'Accepted synthetic follow-up.', now + 7);
  sqlite.prepare(`INSERT INTO training_turns (session_id, turn_number, student_message, ai_response, claim_clarity, evidence_use, reasoning_strength, consistency_score, relevance_score, learner_revision_event_id, learner_revision_number, intervention_revision, created_at)
    VALUES (?, 2, 'Revised synthetic learner statement.', 'Accepted synthetic follow-up.', 3, 3, 3, 3, 3, 'revision-m4-path', 1, 1, ?)`)
    .run(base.sessionId, now + 7);
  sqlite.prepare('UPDATE training_sessions SET current_turn = 3, is_completed = 1, completed_at = ?, updated_at = ? WHERE id = ?')
    .run(now + 8, now + 8, base.sessionId);

  const headers = async (id: string, role: 'student' | 'admin') => ({
    Authorization: `Bearer ${(await generateTokens({ id, username: id, email: `${id}@example.test`, studentId: null, grade: null, role, createdAt: 1, lastLogin: null, isActive: true }, env.JWT_SECRET)).accessToken}`,
    'Content-Type': 'application/json',
  });
  const request = async (path: string, id: string, role: 'student' | 'admin', body?: object, method = 'POST') => trainingRoute.request(path, {
    method,
    headers: await headers(id, role),
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, env);
  return { sqlite, env, base, request, headers };
}

describe('opaque M4 held-out delivery', () => {
  it('rejects learner free text and records only a closed contamination code', async () => {
    const subject = await fixture();
    const arm = await subject.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: subject.base.sessionId,
      ownerUserId: 'learner-a',
      opaqueVariantId: 'HH-V-IMMEDIATE-01',
      taskText: '[SYNTHETIC TEST TASK] closed contamination vocabulary',
      mutationKey: 'fixture-closed-code-arm',
    });
    const attempt = (await arm.json() as { attempt: { id: string; revision: number } }).attempt;
    const learnerText = '[SYNTHETIC LEARNER TEXT] I copied the task into another tool.';

    const rejected = await subject.request(`/api/training/heldout-attempts/${attempt.id}/contamination`, 'learner-a', 'student', {
      reason: learnerText,
      expectedRevision: attempt.revision,
      mutationKey: 'fixture-free-text-contamination',
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain(learnerText);
    expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ?').get(attempt.id)).toEqual({ count: 1 });
    expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_variant_quarantines').get()).toEqual({ count: 0 });

    const unknownCode = await subject.request(`/api/training/heldout-attempts/${attempt.id}/contamination`, 'learner-a', 'student', {
      contaminationCode: 'LEARNER_AUTHORED_FREE_TEXT',
      expectedRevision: attempt.revision,
      mutationKey: 'fixture-unknown-code-contamination',
    });
    expect(unknownCode.status).toBe(400);
    expect(await unknownCode.text()).not.toContain('LEARNER_AUTHORED_FREE_TEXT');
    expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ?').get(attempt.id)).toEqual({ count: 1 });
    expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_variant_quarantines').get()).toEqual({ count: 0 });

    const accepted = await subject.request(`/api/training/heldout-attempts/${attempt.id}/contamination`, 'learner-a', 'student', {
      contaminationCode: 'LEARNER_REPORTED_EXPOSURE',
      expectedRevision: attempt.revision,
      mutationKey: 'fixture-closed-code-contamination',
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).not.toContain(learnerText);
    expect(subject.sqlite.prepare('SELECT contamination_code, reason FROM training_heldout_attempt_events WHERE attempt_id = ? ORDER BY revision DESC LIMIT 1').get(attempt.id)).toEqual({
      contamination_code: 'LEARNER_REPORTED_EXPOSURE',
      reason: null,
    });
    expect(subject.sqlite.prepare('SELECT opaque_variant_id, contamination_code FROM training_heldout_variant_quarantines').get()).toEqual({
      opaque_variant_id: 'HH-V-IMMEDIATE-01',
      contamination_code: 'LEARNER_REPORTED_EXPOSURE',
    });
  });

  it('deletes only the owner Training graph and retains opaque quarantine metadata', async () => {
    const subject = await fixture();
    const arm = await subject.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: subject.base.sessionId,
      ownerUserId: 'learner-a',
      opaqueVariantId: 'HH-V-IMMEDIATE-02',
      taskText: '[SYNTHETIC TEST TASK] governed owner deletion',
      mutationKey: 'fixture-owner-delete-arm',
    });
    const attempt = (await arm.json() as { attempt: { id: string; revision: number } }).attempt;
    const contamination = await subject.request(`/api/training/heldout-attempts/${attempt.id}/contamination`, 'learner-a', 'student', {
      contaminationCode: 'LEARNER_REPORTED_EXPOSURE',
      expectedRevision: attempt.revision,
      mutationKey: 'fixture-owner-delete-quarantine',
    });
    expect(contamination.status).toBe(200);
    const context = subject.sqlite.prepare('SELECT evidence_manifest_sha256 FROM training_session_contexts WHERE session_id = ?').get(subject.base.sessionId) as { evidence_manifest_sha256: string };
    subject.sqlite.prepare(`UPDATE training_sessions
      SET training_mode = 'scenario', learning_route_version = 1, is_completed = 0, current_turn = 3
      WHERE id = ?`).run(subject.base.sessionId);
    subject.sqlite.prepare(`INSERT INTO training_route_offers (session_id, owner_user_id, offer_json, created_at)
      VALUES (?, ?, ?, ?)`).run(
      subject.base.sessionId, 'learner-a', JSON.stringify({ manifestSha256: context.evidence_manifest_sha256 }), Date.now(),
    );
    subject.sqlite.prepare(`INSERT INTO training_route_decisions (
      id, session_id, owner_user_id, decision_revision, selected_route, effective_from_turn,
      mutation_key, expected_revision, created_at
    ) VALUES (?, ?, ?, 1, 'case-first', 3, ?, 0, ?)`).run(
      'fixture-owner-delete-route-decision', subject.base.sessionId, 'learner-a',
      'fixture-owner-delete-route-key', Date.now(),
    );

    const foreign = await subject.request(`/api/training/session/${subject.base.sessionId}`, 'learner-b', 'student', undefined, 'DELETE');
    expect(foreign.status).toBe(404);
    expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_sessions WHERE id = ?').get(subject.base.sessionId)).toEqual({ count: 1 });

    const deleted = await subject.request(`/api/training/session/${subject.base.sessionId}`, 'learner-a', 'student', undefined, 'DELETE');
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deletedSessionId: subject.base.sessionId, deleted: true, replayed: false });
    for (const [table, ownerColumn] of [
      ['training_sessions', 'id'], ['training_messages', 'session_id'], ['training_turns', 'session_id'],
      ['training_learner_revision_events', 'session_id'], ['training_interventions', 'session_id'],
      ['training_support_responses', 'session_id'], ['training_scenario_evidence', 'session_id'],
      ['training_scenario_packs', 'session_id'], ['training_session_contexts', 'session_id'],
      ['training_route_offers', 'session_id'], ['training_route_decisions', 'session_id'],
      ['training_heldout_attempts', 'base_session_id'],
    ]) {
      expect(subject.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${ownerColumn} = ?`).get(subject.base.sessionId)).toEqual({ count: 0 });
    }
    expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events').get()).toEqual({ count: 0 });
    const retainedIndex = subject.sqlite.prepare('SELECT opaque_variant_id, contamination_code FROM training_heldout_variant_quarantines').get();
    expect(retainedIndex).toEqual({ opaque_variant_id: 'HH-V-IMMEDIATE-02', contamination_code: 'LEARNER_REPORTED_EXPOSURE' });
    expect(Object.keys(retainedIndex as object)).not.toContain('attempt_id');

    const replay = await subject.request(`/api/training/session/${subject.base.sessionId}`, 'learner-a', 'student', undefined, 'DELETE');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ deletedSessionId: subject.base.sessionId, deleted: true, replayed: true });
  });

  it('does not report Training deletion when a persistence failure rolls back its authorization', async () => {
    const subject = await fixture();
    subject.sqlite.exec(`CREATE TRIGGER fixture_training_delete_failure BEFORE DELETE ON training_messages
      WHEN OLD.session_id = '${subject.base.sessionId}' BEGIN SELECT RAISE(ABORT, 'fixture training delete failure'); END`);

    const failed = await subject.request(`/api/training/session/${subject.base.sessionId}`, 'learner-a', 'student', undefined, 'DELETE');
    expect(failed.status).toBe(500);
    expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_sessions WHERE id = ?').get(subject.base.sessionId)).toEqual({ count: 1 });
    expect(subject.sqlite.prepare(`SELECT COUNT(*) AS count FROM training_session_context_deletion_authorizations authorization
      JOIN training_session_contexts context ON context.id = authorization.session_context_id
      WHERE context.session_id = ?`).get(subject.base.sessionId)).toEqual({ count: 0 });
  });

  it('arms, explicitly delivers, submits, and safely projects a synthetic M4 task', async () => {
    const { sqlite, env, base, request, headers } = await fixture();
    const taskText = '[SYNTHETIC TEST TASK] Explain a changed decision without assistance.';
    const aiBefore = sqlite.prepare('SELECT COUNT(*) AS count FROM ai_invocation_attempts').get();
    const unauthenticated = await trainingRoute.request('/api/training/operator/heldout-attempts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    }, env);
    expect(unauthenticated.status).toBe(401);
    const nonAdmin = await request('/api/training/operator/heldout-attempts', 'learner-a', 'student', {
      baseSessionId: base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText, mutationKey: 'fixture-nonadmin-arm',
    });
    expect(nonAdmin.status).toBe(403);
    const ownerOperator = await request('/api/training/operator/heldout-attempts', 'learner-a', 'admin', {
      baseSessionId: base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText, mutationKey: 'fixture-owner-arm',
    });
    expect(ownerOperator.status).toBe(403);
    const delayedVariant = await request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-DELAYED-01', taskText, mutationKey: 'fixture-delayed-arm',
    });
    expect(delayedVariant.status).toBe(400);
    const rejectedClientClaims = await request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: base.sessionId,
      ownerUserId: 'learner-a',
      opaqueVariantId: 'HH-V-IMMEDIATE-01',
      taskText,
      mutationKey: 'fixture-arm-m4-01',
      clientSuppliedHash: 'must-not-be-accepted',
      state: 'SUBMITTED',
      createdAt: 1,
    });
    expect(rejectedClientClaims.status).toBe(400);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_sessions WHERE id = ?').get(base.sessionId)).toEqual({ count: 1 });
    const arm = await request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: base.sessionId,
      ownerUserId: 'learner-a',
      opaqueVariantId: 'HH-V-IMMEDIATE-01',
      taskText,
      mutationKey: 'fixture-arm-m4-01',
    });
    expect(arm.status).toBe(201);
    const armed = await arm.json() as { attempt: { id: string; state: string; revision: number; taskText?: string; measurement: string; opaqueVariantId: string } };
    expect(armed.attempt).toMatchObject({ state: 'ARMED', measurement: 'M4', opaqueVariantId: 'HH-V-IMMEDIATE-01' });
    expect(armed.attempt.taskText).toBeUndefined();
    expect(JSON.stringify(armed)).not.toContain(taskText);
    const armReplay = await request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText, mutationKey: 'fixture-arm-m4-01',
    });
    expect(armReplay.status).toBe(200);
    expect((await armReplay.json() as { replayed: boolean }).replayed).toBe(true);
    const armConflict = await request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-02', taskText, mutationKey: 'fixture-arm-m4-01',
    });
    expect(armConflict.status).toBe(409);
    const operatorAudit = await request(`/api/training/operator/heldout-attempts/${armed.attempt.id}`, 'local-admin', 'admin', undefined, 'GET');
    expect(operatorAudit.status).toBe(200);
    expect(JSON.stringify(await operatorAudit.json())).toContain(taskText);

    const detailBeforeOpen = await request(`/api/training/session/${base.sessionId}`, 'learner-a', 'student', undefined, 'GET');
    expect(detailBeforeOpen.status).toBe(200);
    const beforeOpen = await detailBeforeOpen.json() as Record<string, unknown>;
    expect(JSON.stringify(beforeOpen)).not.toContain(taskText);
    expect(JSON.stringify(beforeOpen)).toContain('HH-V-IMMEDIATE-01');
    const trainingResumeBeforeOpen = await request(`/api/training/session/${base.sessionId}/resume`, 'learner-a', 'student', {}, 'POST');
    expect(trainingResumeBeforeOpen.status).toBe(200);
    expect(await trainingResumeBeforeOpen.text()).not.toContain(taskText);
    const historyDetailBeforeOpen = await historyRoute.request(`/api/sessions/${base.sessionId}`, { method: 'GET', headers: await headers('learner-a', 'student') }, env);
    expect(historyDetailBeforeOpen.status).toBe(200);
    expect(await historyDetailBeforeOpen.text()).not.toContain(taskText);
    const historyResumeBeforeOpen = await historyRoute.request(`/api/sessions/${base.sessionId}/resume`, { method: 'POST', headers: await headers('learner-a', 'student'), body: '{}' }, env);
    expect(historyResumeBeforeOpen.status).toBe(200);
    expect(await historyResumeBeforeOpen.text()).not.toContain(taskText);
    const foreignDetail = await request(`/api/training/session/${base.sessionId}`, 'learner-b', 'student', undefined, 'GET');
    expect([403, 404]).toContain(foreignDetail.status);
    expect(await foreignDetail.text()).not.toContain(taskText);
    const unauthenticatedOpen = await trainingRoute.request(`/api/training/heldout-attempts/${armed.attempt.id}/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, mutationKey: 'fixture-unauth-open' }),
    }, env);
    expect(unauthenticatedOpen.status).toBe(401);
    expect(await unauthenticatedOpen.text()).not.toContain(taskText);

    const foreign = await request(`/api/training/heldout-attempts/${armed.attempt.id}/open`, 'learner-b', 'student', { expectedRevision: armed.attempt.revision, mutationKey: 'fixture-foreign-open' });
    expect([403, 404]).toContain(foreign.status);
    expect(await foreign.text()).not.toContain(taskText);

    const opened = await request(`/api/training/heldout-attempts/${armed.attempt.id}/open`, 'learner-a', 'student', { expectedRevision: armed.attempt.revision, mutationKey: 'fixture-open-m4-01' });
    expect(opened.status).toBe(200);
    const delivery = await opened.json() as { attempt: { state: string; revision: number; taskText: string } };
    expect(delivery.attempt).toMatchObject({ state: 'IN_PROGRESS', taskText });
    const openReplay = await request(`/api/training/heldout-attempts/${armed.attempt.id}/open`, 'learner-a', 'student', { expectedRevision: armed.attempt.revision, mutationKey: 'fixture-open-m4-01' });
    expect(openReplay.status).toBe(200);
    expect((await openReplay.json() as { replayed: boolean }).replayed).toBe(true);

    const submitted = await request(`/api/training/heldout-attempts/${armed.attempt.id}/submit`, 'learner-a', 'student', {
      response: '<strong>Synthetic learner response</strong>', expectedRevision: delivery.attempt.revision, mutationKey: 'fixture-submit-m4-01',
    });
    expect(submitted.status).toBe(200);
    const submittedBody = await submitted.json() as { attempt: { state: string; missingness: string; assistanceIds: string[]; responseHash: string; response?: string } };
    expect(submittedBody.attempt).toMatchObject({ state: 'SUBMITTED', missingness: 'NONE', assistanceIds: [] });
    expect(submittedBody.attempt.responseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(submittedBody.attempt.response).toBe('<strong>Synthetic learner response</strong>');
    const submitReplay = await request(`/api/training/heldout-attempts/${armed.attempt.id}/submit`, 'learner-a', 'student', {
      response: '<strong>Synthetic learner response</strong>', expectedRevision: delivery.attempt.revision, mutationKey: 'fixture-submit-m4-01',
    });
    expect(submitReplay.status).toBe(200);
    expect((await submitReplay.json() as { replayed: boolean }).replayed).toBe(true);
    const submitConflict = await request(`/api/training/heldout-attempts/${armed.attempt.id}/submit`, 'learner-a', 'student', {
      response: 'Different synthetic response', expectedRevision: delivery.attempt.revision, mutationKey: 'fixture-submit-m4-01',
    });
    expect(submitConflict.status).toBe(409);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_messages WHERE session_id = ?').get(base.sessionId)).toEqual({ count: 4 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_turns WHERE session_id = ?').get(base.sessionId)).toEqual({ count: 2 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM ai_invocation_attempts').get()).toEqual(aiBefore);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ?').get(armed.attempt.id)).toEqual({ count: 3 });
    expect(() => sqlite.prepare('UPDATE training_heldout_attempt_events SET missingness = ? WHERE attempt_id = ?').run('UNKNOWN', armed.attempt.id)).toThrow('TRAINING_HELDOUT_EVENT_IMMUTABLE');
    expect(() => sqlite.prepare('DELETE FROM training_heldout_attempts WHERE id = ?').run(armed.attempt.id)).toThrow();
  });

  it('stops and quarantines without disclosure, rejects assistance seams, and fails closed when state cannot be read', async () => {
    const stoppedFixture = await fixture();
    const stopTask = '[SYNTHETIC TEST TASK] Stop before delivery.';
    const stopArm = await stoppedFixture.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: stoppedFixture.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-02', taskText: stopTask, mutationKey: 'fixture-stop-arm',
    });
    const stoppedAttempt = (await stopArm.json() as { attempt: { id: string; revision: number } }).attempt;
    const stopped = await stoppedFixture.request(`/api/training/heldout-attempts/${stoppedAttempt.id}/stop`, 'learner-a', 'student', {
      expectedRevision: stoppedAttempt.revision, mutationKey: 'fixture-stop-attempt',
    });
    expect(stopped.status).toBe(200);
    const stoppedProjection = (await stopped.json() as { attempt: { state: string; missingness: string; taskText?: string } }).attempt;
    expect(stoppedProjection).toMatchObject({ state: 'ABANDONED', missingness: 'NOT_STARTED' });
    expect(stoppedProjection.taskText).toBeUndefined();
    const stoppedOpen = await stoppedFixture.request(`/api/training/heldout-attempts/${stoppedAttempt.id}/open`, 'learner-a', 'student', {
      expectedRevision: 2, mutationKey: 'fixture-stop-open',
    });
    expect(stoppedOpen.status).toBe(409);
    expect(() => stoppedFixture.sqlite.prepare('UPDATE training_heldout_attempts SET task_text = ? WHERE id = ?').run('tamper', stoppedAttempt.id)).toThrow('TRAINING_HELDOUT_ASSIGNMENT_IMMUTABLE');

    const contaminatedFixture = await fixture();
    const contaminatedTask = '[SYNTHETIC TEST TASK] Quarantine on local assistance reference.';
    const aiBefore = contaminatedFixture.sqlite.prepare('SELECT COUNT(*) AS count FROM ai_invocation_attempts').get();
    const contaminatedArm = await contaminatedFixture.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: contaminatedFixture.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: contaminatedTask, mutationKey: 'fixture-contaminated-arm',
    });
    const contaminatedAttempt = (await contaminatedArm.json() as { attempt: { id: string } }).attempt;
    const forbiddenHint = await contaminatedFixture.request('/api/training/hint', 'learner-a', 'student', { sessionId: contaminatedAttempt.id });
    expect(forbiddenHint.status).toBe(409);
    expect(await forbiddenHint.text()).not.toContain(contaminatedTask);
    const contaminatedDetail = await contaminatedFixture.request(`/api/training/session/${contaminatedFixture.base.sessionId}`, 'learner-a', 'student', undefined, 'GET');
    const contaminatedProjection = await contaminatedDetail.json() as { heldOutAttempt: { status: string; attempt: null } };
    expect(contaminatedProjection.heldOutAttempt).toEqual({ status: 'UNAVAILABLE', attempt: null });
    expect(contaminatedFixture.sqlite.prepare('SELECT COUNT(*) AS count FROM ai_invocation_attempts').get()).toEqual(aiBefore);
    const contaminationReplay = await contaminatedFixture.request(`/api/training/heldout-attempts/${contaminatedAttempt.id}/contamination`, 'learner-a', 'student', {
      contaminationCode: 'LEARNER_REPORTED_EXPOSURE', expectedRevision: 2, mutationKey: 'fixture-contamination-report',
    });
    expect(contaminationReplay.status).toBe(409);

    const damagedFixture = await fixture();
    const damagedTask = '[SYNTHETIC TEST TASK] Digest damage must quarantine before delivery.';
    const damagedArm = await damagedFixture.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: damagedFixture.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: damagedTask, mutationKey: 'fixture-damaged-arm',
    });
    const damagedAttempt = (await damagedArm.json() as { attempt: { id: string } }).attempt;
    const damagedOpen = await damagedFixture.request(`/api/training/heldout-attempts/${damagedAttempt.id}/open`, 'learner-a', 'student', {
      expectedRevision: 1, mutationKey: 'fixture-damaged-open',
    });
    expect(damagedOpen.status).toBe(200);
    expect(await damagedOpen.text()).toContain(damagedTask);
    damagedFixture.sqlite.exec('DROP TRIGGER training_heldout_attempts_immutable_update');
    damagedFixture.sqlite.prepare('UPDATE training_heldout_attempts SET task_text = ? WHERE id = ?').run('corrupted fixture payload', damagedAttempt.id);
    const damagedDetail = await damagedFixture.request(`/api/training/session/${damagedFixture.base.sessionId}`, 'learner-a', 'student', undefined, 'GET');
    const damagedProjection = await damagedDetail.json() as { heldOutAttempt: { attempt: { state: string; missingness: string; taskText?: string } } };
    expect(damagedProjection.heldOutAttempt.attempt).toMatchObject({ state: 'QUARANTINED', missingness: 'PAYLOAD_UNAVAILABLE' });
    expect(damagedProjection.heldOutAttempt.attempt.taskText).toBeUndefined();
    damagedFixture.sqlite.exec('DROP TABLE training_heldout_attempt_events');
    const unavailableDetail = await damagedFixture.request(`/api/training/session/${damagedFixture.base.sessionId}`, 'learner-a', 'student', undefined, 'GET');
    expect((await unavailableDetail.json() as { heldOutAttempt: { status: string; attempt: null } }).heldOutAttempt).toEqual({ status: 'UNAVAILABLE', attempt: null });
  });

  it('rejects incomplete, generic, and damaged-manifest bases before an assignment is persisted', async () => {
    const incompleteFixture = await fixture();
    incompleteFixture.sqlite.prepare('UPDATE training_sessions SET is_completed = 0 WHERE id = ?').run(incompleteFixture.base.sessionId);
    const incompleteArm = await incompleteFixture.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: incompleteFixture.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: '[SYNTHETIC TEST TASK] incomplete base', mutationKey: 'fixture-incomplete-arm',
    });
    expect(incompleteArm.status).toBe(409);
    expect(incompleteFixture.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempts').get()).toEqual({ count: 0 });

    const genericFixture = await fixture();
    const category = genericFixture.sqlite.prepare('SELECT category FROM training_sessions WHERE id = ?').get(genericFixture.base.sessionId) as { category: string };
    genericFixture.sqlite.prepare(`INSERT INTO training_sessions (id, user_id, category, difficulty, question, training_mode, is_completed, current_turn, max_turns)
      VALUES ('generic-heldout-base', 'learner-a', ?, 'intermediate', 'Generic synthetic session', 'discussion', 1, 2, 1)`).run(category.category);
    genericFixture.sqlite.prepare(`INSERT INTO training_turns (session_id, turn_number, student_message, ai_response, claim_clarity, evidence_use, reasoning_strength, consistency_score, relevance_score)
      VALUES ('generic-heldout-base', 1, 'Synthetic generic answer.', 'Synthetic generic reply.', 3, 3, 3, 3, 3)`).run();
    genericFixture.sqlite.prepare("UPDATE training_sessions SET training_mode = 'scenario' WHERE id = 'generic-heldout-base'").run();
    const genericArm = await genericFixture.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: 'generic-heldout-base', ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: '[SYNTHETIC TEST TASK] generic base', mutationKey: 'fixture-generic-arm',
    });
    expect(genericArm.status).toBe(409);
    expect(genericFixture.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempts').get()).toEqual({ count: 0 });

    const damagedManifestFixture = await fixture();
    damagedManifestFixture.sqlite.exec('DROP TRIGGER training_scenario_packs_bound_immutable_update');
    damagedManifestFixture.sqlite.prepare('UPDATE training_scenario_packs SET evidence_manifest_sha256 = ? WHERE session_id = ?').run('0'.repeat(64), damagedManifestFixture.base.sessionId);
    const damagedManifestArm = await damagedManifestFixture.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: damagedManifestFixture.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: '[SYNTHETIC TEST TASK] damaged manifest', mutationKey: 'fixture-manifest-arm',
    });
    expect(damagedManifestArm.status).toBe(409);
    expect(damagedManifestFixture.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempts').get()).toEqual({ count: 0 });
  });

  it('keeps unavailable readback resumable and scopes an audit to its arming operator', async () => {
    const { sqlite, base, request } = await fixture();
    const arm = await request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: '[SYNTHETIC TEST TASK] repair readback', mutationKey: 'fixture-repair-arm',
    });
    const armed = await arm.json() as { attempt: { id: string } };
    const foreignAudit = await request(`/api/training/operator/heldout-attempts/${armed.attempt.id}`, 'other-admin', 'admin', undefined, 'GET');
    expect(foreignAudit.status).toBe(404);
    sqlite.exec('DROP TABLE training_heldout_attempt_events');
    const unavailableResume = await request(`/api/training/session/${base.sessionId}/resume`, 'learner-a', 'student', {}, 'POST');
    expect(unavailableResume.status).toBe(200);
    expect((await unavailableResume.json() as { heldOutAttempt: { status: string; attempt: null } }).heldOutAttempt).toEqual({ status: 'UNAVAILABLE', attempt: null });
  });

  it('fails races closed and leaves no false arm or submit persistence after injected failures', async () => {
    const armFailure = await fixture();
    armFailure.sqlite.exec(`CREATE TRIGGER fixture_arm_failure BEFORE INSERT ON training_heldout_attempt_events
      WHEN NEW.event_type = 'ARM' BEGIN SELECT RAISE(ABORT, 'fixture arm failure'); END`);
    const failedArm = await armFailure.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: armFailure.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: '[SYNTHETIC TEST TASK] arm failure', mutationKey: 'fixture-failed-arm',
    });
    expect(failedArm.status).toBe(500);
    expect(armFailure.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempts').get()).toEqual({ count: 0 });

    const transitionFailure = await fixture();
    const arm = await transitionFailure.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: transitionFailure.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: '[SYNTHETIC TEST TASK] transition failure', mutationKey: 'fixture-transition-arm',
    });
    const attempt = (await arm.json() as { attempt: { id: string; revision: number } }).attempt;
    transitionFailure.sqlite.exec(`CREATE TRIGGER fixture_open_race BEFORE INSERT ON training_heldout_attempt_events
      WHEN NEW.event_type = 'OPEN' BEGIN SELECT RAISE(ABORT, 'TRAINING_HELDOUT_REVISION_CONFLICT'); END`);
    const racedOpen = await transitionFailure.request(`/api/training/heldout-attempts/${attempt.id}/open`, 'learner-a', 'student', { expectedRevision: attempt.revision, mutationKey: 'fixture-raced-open' });
    expect(racedOpen.status).toBe(409);
    expect((await racedOpen.json() as { code: string }).code).toBe('TRAINING_HELDOUT_REVISION_CONFLICT');
    expect(transitionFailure.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ?').get(attempt.id)).toEqual({ count: 1 });

    const submitFailure = await fixture();
    const submitArm = await submitFailure.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: submitFailure.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-02', taskText: '[SYNTHETIC TEST TASK] submit event failure', mutationKey: 'fixture-submit-failure-arm',
    });
    const submitAttempt = (await submitArm.json() as { attempt: { id: string; revision: number } }).attempt;
    const submitOpen = await submitFailure.request(`/api/training/heldout-attempts/${submitAttempt.id}/open`, 'learner-a', 'student', { expectedRevision: submitAttempt.revision, mutationKey: 'fixture-submit-failure-open' });
    const openedAttempt = (await submitOpen.json() as { attempt: { revision: number } }).attempt;
    submitFailure.sqlite.exec(`CREATE TRIGGER fixture_submit_event_failure BEFORE INSERT ON training_heldout_attempt_events
      WHEN NEW.event_type = 'SUBMIT' BEGIN SELECT RAISE(ABORT, 'fixture unrelated submit failure'); END`);
    const failedSubmit = await submitFailure.request(`/api/training/heldout-attempts/${submitAttempt.id}/submit`, 'learner-a', 'student', { response: 'Synthetic failed persistence response.', expectedRevision: openedAttempt.revision, mutationKey: 'fixture-submit-event-failure' });
    expect(failedSubmit.status).toBe(500);
    expect(submitFailure.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ?').get(submitAttempt.id)).toEqual({ count: 2 });
    expect(submitFailure.sqlite.prepare('SELECT response_text, response_sha256 FROM training_heldout_attempt_events WHERE attempt_id = ? ORDER BY revision DESC LIMIT 1').get(submitAttempt.id)).toEqual({ response_text: null, response_sha256: null });
  });

  it('durably blocks a contaminated opaque variant from re-arm', async () => {
    const subject = await fixture();
    const task = '[SYNTHETIC TEST TASK] contamination quarantine index';
    const arm = await subject.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: subject.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-02', taskText: task, mutationKey: 'fixture-variant-arm',
    });
    const attempt = (await arm.json() as { attempt: { id: string; revision: number } }).attempt;
    const contamination = await subject.request(`/api/training/heldout-attempts/${attempt.id}/contamination`, 'learner-a', 'student', { contaminationCode: 'LEARNER_REPORTED_EXPOSURE', expectedRevision: attempt.revision, mutationKey: 'fixture-variant-contamination' });
    expect(contamination.status).toBe(200);
    expect(subject.sqlite.prepare('SELECT opaque_variant_id FROM training_heldout_variant_quarantines').get()).toEqual({ opaque_variant_id: 'HH-V-IMMEDIATE-02' });
    subject.sqlite.exec('DROP TRIGGER training_heldout_attempts_preserve_on_delete; DROP TRIGGER training_heldout_attempt_events_append_only_delete;');
    subject.sqlite.prepare('DELETE FROM training_heldout_attempts WHERE id = ?').run(attempt.id);
    const rearm = await subject.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: subject.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-02', taskText: task, mutationKey: 'fixture-variant-rearm',
    });
    expect(rearm.status).toBe(409);
    expect((await rearm.json() as { code: string }).code).toBe('TRAINING_HELDOUT_VARIANT_QUARANTINED');
  });

  it('preserves children against direct deletion but follows the governed base hard-delete path', async () => {
    const subject = await fixture();
    const arm = await subject.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: subject.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: '[SYNTHETIC TEST TASK] governed deletion', mutationKey: 'fixture-delete-arm',
    });
    const attempt = (await arm.json() as { attempt: { id: string; revision: number } }).attempt;
    const contamination = await subject.request(`/api/training/heldout-attempts/${attempt.id}/contamination`, 'learner-a', 'student', { contaminationCode: 'LEARNER_REPORTED_EXPOSURE', expectedRevision: attempt.revision, mutationKey: 'fixture-governed-delete-contamination' });
    expect(contamination.status).toBe(200);
    expect(() => subject.sqlite.prepare('DELETE FROM training_heldout_attempt_events WHERE attempt_id = ?').run(attempt.id)).toThrow();
    const context = subject.sqlite.prepare('SELECT id FROM training_session_contexts WHERE session_id = ?').get(subject.base.sessionId) as { id: string };
    subject.sqlite.prepare('INSERT INTO training_session_context_deletion_authorizations (session_context_id, authorization_id, created_at) VALUES (?, ?, ?)').run(context.id, 'fixture-governed-delete', Date.now());
    subject.sqlite.prepare('DELETE FROM training_turns WHERE session_id = ?').run(subject.base.sessionId);
    subject.sqlite.prepare('DELETE FROM training_learner_revision_events WHERE session_id = ?').run(subject.base.sessionId);
    subject.sqlite.prepare('DELETE FROM training_support_responses WHERE session_id = ?').run(subject.base.sessionId);
    subject.sqlite.prepare('DELETE FROM training_interventions WHERE session_id = ?').run(subject.base.sessionId);
    subject.sqlite.prepare('DELETE FROM training_scenario_evidence WHERE session_id = ?').run(subject.base.sessionId);
    subject.sqlite.prepare('DELETE FROM training_scenario_packs WHERE session_id = ?').run(subject.base.sessionId);
    subject.sqlite.prepare('DELETE FROM training_session_contexts WHERE id = ?').run(context.id);
    expect(() => subject.sqlite.prepare('DELETE FROM training_sessions WHERE id = ?').run(subject.base.sessionId)).not.toThrow();
    expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempts').get()).toEqual({ count: 0 });
    expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events').get()).toEqual({ count: 0 });
    expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_variant_quarantines').get()).toEqual({ count: 1 });
  });

  it('quarantines an active attempt passed to the Training chat seam without message or turn writes', async () => {
    const subject = await fixture();
    const arm = await subject.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: subject.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: '[SYNTHETIC TEST TASK] chat guard', mutationKey: 'fixture-chat-arm',
    });
    const attempt = (await arm.json() as { attempt: { id: string } }).attempt;
    const beforeMessages = subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_messages WHERE session_id = ?').get(subject.base.sessionId);
    const beforeTurns = subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_turns WHERE session_id = ?').get(subject.base.sessionId);
    const chat = await subject.request('/api/training/chat', 'learner-a', 'student', { sessionId: attempt.id, message: 'Synthetic forbidden help request.' });
    expect(chat.status).toBe(409);
    expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_messages WHERE session_id = ?').get(subject.base.sessionId)).toEqual(beforeMessages);
    expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_turns WHERE session_id = ?').get(subject.base.sessionId)).toEqual(beforeTurns);
    expect(subject.sqlite.prepare('SELECT opaque_variant_id FROM training_heldout_variant_quarantines').get()).toEqual({ opaque_variant_id: 'HH-V-IMMEDIATE-01' });
    const detail = await subject.request(`/api/training/session/${subject.base.sessionId}`, 'learner-a', 'student', undefined, 'GET');
    expect((await detail.json() as { heldOutAttempt: { status: string; attempt: null } }).heldOutAttempt).toEqual({ status: 'UNAVAILABLE', attempt: null });
  });

  it('quarantines ARMED and IN_PROGRESS attempts addressed by their base session exactly once before intervention readback', async () => {
    for (const state of ['ARMED', 'IN_PROGRESS'] as const) {
      const subject = await fixture();
      const taskText = `[SYNTHETIC TEST TASK] base-session ${state.toLowerCase()} intervention control`;
      const arm = await subject.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
        baseSessionId: subject.base.sessionId,
        ownerUserId: 'learner-a',
        opaqueVariantId: 'HH-V-IMMEDIATE-01',
        taskText,
        mutationKey: `fixture-base-session-${state.toLowerCase()}-arm`,
      });
      const attempt = (await arm.json() as { attempt: { id: string } }).attempt;
      if (state === 'IN_PROGRESS') {
        const opened = await subject.request(`/api/training/heldout-attempts/${attempt.id}/open`, 'learner-a', 'student', {
          expectedRevision: 1,
          mutationKey: 'fixture-base-session-in-progress-open',
        });
        expect(opened.status).toBe(200);
      }
      const beforeMessages = subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_messages WHERE session_id = ?').get(subject.base.sessionId);
      const beforeTurns = subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_turns WHERE session_id = ?').get(subject.base.sessionId);

      const intervention = await subject.request(
        `/api/training/session/${subject.base.sessionId}/interventions`,
        'learner-a',
        'student',
        undefined,
        'GET',
      );
      const interventionBody = await intervention.text();

      expect(intervention.status).toBe(409);
      expect(JSON.parse(interventionBody)).toMatchObject({ code: 'TRAINING_HELDOUT_ASSISTANCE_FORBIDDEN' });
      expect(interventionBody).not.toContain(taskText);
      expect(subject.sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM training_heldout_attempt_events
        WHERE attempt_id = ? AND event_type = 'QUARANTINE' AND contamination_code = 'LOCAL_ASSISTANCE_REFERENCE'
      `).get(attempt.id)).toEqual({ count: 1 });
      expect(subject.sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM training_heldout_variant_quarantines
        WHERE opaque_variant_id = ? AND contamination_code = 'LOCAL_ASSISTANCE_REFERENCE'
      `).get('HH-V-IMMEDIATE-01')).toEqual({ count: 1 });
      expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_messages WHERE session_id = ?').get(subject.base.sessionId)).toEqual(beforeMessages);
      expect(subject.sqlite.prepare('SELECT COUNT(*) AS count FROM training_turns WHERE session_id = ?').get(subject.base.sessionId)).toEqual(beforeTurns);

      const repeat = await subject.request(`/api/training/session/${subject.base.sessionId}/interventions`, 'learner-a', 'student', undefined, 'GET');
      expect(repeat.status).toBe(409);
      expect(subject.sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM training_heldout_attempt_events
        WHERE attempt_id = ? AND event_type = 'QUARANTINE' AND contamination_code = 'LOCAL_ASSISTANCE_REFERENCE'
      `).get(attempt.id)).toEqual({ count: 1 });
      expect(subject.sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM training_heldout_variant_quarantines
        WHERE opaque_variant_id = ? AND contamination_code = 'LOCAL_ASSISTANCE_REFERENCE'
      `).get('HH-V-IMMEDIATE-01')).toEqual({ count: 1 });

      const detail = await subject.request(`/api/training/session/${subject.base.sessionId}`, 'learner-a', 'student', undefined, 'GET');
      const detailBody = await detail.text();
      expect(detail.status).toBe(200);
      expect(detailBody).not.toContain(taskText);
      expect(JSON.parse(detailBody).heldOutAttempt).toEqual({ status: 'UNAVAILABLE', attempt: null });
    }
  });

  it('does not newly quarantine inactive or foreign base-session assistance references', async () => {
    const submitted = await fixture();
    const submittedTask = '[SYNTHETIC TEST TASK] submitted base-session control';
    const submittedArm = await submitted.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: submitted.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: submittedTask, mutationKey: 'fixture-submitted-base-session-arm',
    });
    const submittedAttempt = (await submittedArm.json() as { attempt: { id: string } }).attempt;
    expect((await submitted.request(`/api/training/heldout-attempts/${submittedAttempt.id}/open`, 'learner-a', 'student', { expectedRevision: 1, mutationKey: 'fixture-submitted-base-session-open' })).status).toBe(200);
    const submittedResponse = 'Synthetic unaided response.';
    expect((await submitted.request(`/api/training/heldout-attempts/${submittedAttempt.id}/submit`, 'learner-a', 'student', { response: submittedResponse, expectedRevision: 2, mutationKey: 'fixture-submitted-base-session-submit' })).status).toBe(200);
    const submittedEvents = submitted.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ?').get(submittedAttempt.id);
    const submittedControl = await submitted.request(`/api/training/session/${submitted.base.sessionId}/interventions`, 'learner-a', 'student', undefined, 'GET');
    expect(submittedControl.status).toBe(409);
    const submittedControlBody = await submittedControl.text();
    expect(submittedControlBody).not.toContain(submittedTask);
    expect(submittedControlBody).not.toContain(submittedResponse);
    expect(submitted.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ?').get(submittedAttempt.id)).toEqual(submittedEvents);
    expect(submitted.sqlite.prepare(`SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ? AND contamination_code = 'LOCAL_ASSISTANCE_REFERENCE'`).get(submittedAttempt.id)).toEqual({ count: 0 });
    expect(submitted.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_variant_quarantines').get()).toEqual({ count: 0 });

    const abandoned = await fixture();
    const abandonedTask = '[SYNTHETIC TEST TASK] abandoned base-session control';
    const abandonedArm = await abandoned.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: abandoned.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: abandonedTask, mutationKey: 'fixture-abandoned-base-session-arm',
    });
    const abandonedAttempt = (await abandonedArm.json() as { attempt: { id: string } }).attempt;
    expect((await abandoned.request(`/api/training/heldout-attempts/${abandonedAttempt.id}/open`, 'learner-a', 'student', { expectedRevision: 1, mutationKey: 'fixture-abandoned-base-session-open' })).status).toBe(200);
    expect((await abandoned.request(`/api/training/heldout-attempts/${abandonedAttempt.id}/stop`, 'learner-a', 'student', { expectedRevision: 2, mutationKey: 'fixture-abandoned-base-session-stop' })).status).toBe(200);
    const abandonedEvents = abandoned.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ?').get(abandonedAttempt.id);
    const abandonedControl = await abandoned.request(`/api/training/session/${abandoned.base.sessionId}/interventions`, 'learner-a', 'student', undefined, 'GET');
    expect(abandonedControl.status).toBe(409);
    expect(await abandonedControl.text()).not.toContain(abandonedTask);
    expect(abandoned.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ?').get(abandonedAttempt.id)).toEqual(abandonedEvents);
    expect(abandoned.sqlite.prepare(`SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ? AND contamination_code = 'LOCAL_ASSISTANCE_REFERENCE'`).get(abandonedAttempt.id)).toEqual({ count: 0 });
    expect(abandoned.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_variant_quarantines').get()).toEqual({ count: 0 });

    const foreign = await fixture();
    const foreignTask = '[SYNTHETIC TEST TASK] foreign base-session control';
    const foreignArm = await foreign.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: foreign.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: foreignTask, mutationKey: 'fixture-foreign-base-session-arm',
    });
    const foreignAttempt = (await foreignArm.json() as { attempt: { id: string } }).attempt;
    const foreignControl = await foreign.request(`/api/training/session/${foreign.base.sessionId}/interventions`, 'learner-b', 'student', undefined, 'GET');
    expect(foreignControl.status).toBe(404);
    expect(await foreignControl.text()).not.toContain(foreignTask);
    expect(foreign.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ?').get(foreignAttempt.id)).toEqual({ count: 1 });
    expect(foreign.sqlite.prepare(`SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ? AND contamination_code = 'LOCAL_ASSISTANCE_REFERENCE'`).get(foreignAttempt.id)).toEqual({ count: 0 });
    expect(foreign.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_variant_quarantines').get()).toEqual({ count: 0 });
  });

  it('atomically persists contamination and its variant quarantine without disclosing damaged task text', async () => {
    const indexFailure = await fixture();
    const arm = await indexFailure.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: indexFailure.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: '[SYNTHETIC TEST TASK] atomic contamination', mutationKey: 'fixture-atomic-arm',
    });
    const attempt = (await arm.json() as { attempt: { id: string; revision: number } }).attempt;
    indexFailure.sqlite.exec(`CREATE TRIGGER fixture_variant_index_failure BEFORE INSERT ON training_heldout_variant_quarantines
      BEGIN SELECT RAISE(ABORT, 'fixture variant quarantine failure'); END`);
    const failed = await indexFailure.request(`/api/training/heldout-attempts/${attempt.id}/contamination`, 'learner-a', 'student', { contaminationCode: 'LEARNER_REPORTED_EXPOSURE', expectedRevision: attempt.revision, mutationKey: 'fixture-atomic-contamination' });
    expect(failed.status).toBe(500);
    expect(indexFailure.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_attempt_events WHERE attempt_id = ?').get(attempt.id)).toEqual({ count: 1 });
    expect(indexFailure.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_variant_quarantines').get()).toEqual({ count: 0 });

    const damaged = await fixture();
    const damagedArm = await damaged.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: damaged.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-02', taskText: '[SYNTHETIC TEST TASK] damaged contamination', mutationKey: 'fixture-damaged-contamination-arm',
    });
    const damagedAttempt = (await damagedArm.json() as { attempt: { id: string; revision: number } }).attempt;
    const opened = await damaged.request(`/api/training/heldout-attempts/${damagedAttempt.id}/open`, 'learner-a', 'student', { expectedRevision: damagedAttempt.revision, mutationKey: 'fixture-damaged-contamination-open' });
    expect(opened.status).toBe(200);
    damaged.sqlite.exec('DROP TRIGGER training_heldout_attempts_immutable_update');
    damaged.sqlite.prepare('UPDATE training_heldout_attempts SET task_text = ? WHERE id = ?').run('corrupted contamination task', damagedAttempt.id);
    const disclosure = await damaged.request(`/api/training/heldout-attempts/${damagedAttempt.id}/contamination`, 'learner-a', 'student', { contaminationCode: 'LEARNER_REPORTED_EXPOSURE', expectedRevision: 2, mutationKey: 'fixture-damaged-contamination' });
    expect(disclosure.status).toBe(409);
    expect(await disclosure.text()).not.toContain('corrupted contamination task');
  });

  it('reconciles explicit contamination replays and blocks pre-armed cross-attempt disclosure', async () => {
    const repaired = await fixture();
    const repairedArm = await repaired.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: repaired.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: '[SYNTHETIC TEST TASK] replay index repair', mutationKey: 'fixture-replay-index-arm',
    });
    const repairedAttempt = (await repairedArm.json() as { attempt: { id: string; revision: number } }).attempt;
    const repairInput = { contaminationCode: 'LEARNER_REPORTED_EXPOSURE', expectedRevision: repairedAttempt.revision, mutationKey: 'fixture-replay-index-contamination' };
    expect((await repaired.request(`/api/training/heldout-attempts/${repairedAttempt.id}/contamination`, 'learner-a', 'student', repairInput)).status).toBe(200);
    repaired.sqlite.prepare('DELETE FROM training_heldout_variant_quarantines WHERE opaque_variant_id = ?').run('HH-V-IMMEDIATE-01');
    const repairedReplay = await repaired.request(`/api/training/heldout-attempts/${repairedAttempt.id}/contamination`, 'learner-a', 'student', repairInput);
    expect(repairedReplay.status).toBe(200);
    expect((await repairedReplay.json() as { replayed: boolean }).replayed).toBe(true);
    expect(repaired.sqlite.prepare('SELECT opaque_variant_id, contamination_code FROM training_heldout_variant_quarantines').get()).toEqual({ opaque_variant_id: 'HH-V-IMMEDIATE-01', contamination_code: repairInput.contaminationCode });

    const mismatched = await fixture();
    const mismatchedArm = await mismatched.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: mismatched.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-02', taskText: '[SYNTHETIC TEST TASK] replay index mismatch', mutationKey: 'fixture-mismatch-index-arm',
    });
    const mismatchedAttempt = (await mismatchedArm.json() as { attempt: { id: string; revision: number } }).attempt;
    const mismatchInput = { contaminationCode: 'LEARNER_REPORTED_EXPOSURE', expectedRevision: mismatchedAttempt.revision, mutationKey: 'fixture-mismatch-index-contamination' };
    expect((await mismatched.request(`/api/training/heldout-attempts/${mismatchedAttempt.id}/contamination`, 'learner-a', 'student', mismatchInput)).status).toBe(200);
    mismatched.sqlite.prepare('UPDATE training_heldout_variant_quarantines SET contamination_code = ? WHERE opaque_variant_id = ?').run('LOCAL_ASSISTANCE_REFERENCE', 'HH-V-IMMEDIATE-02');
    const rejectedMismatch = await mismatched.request(`/api/training/heldout-attempts/${mismatchedAttempt.id}/contamination`, 'learner-a', 'student', mismatchInput);
    expect(rejectedMismatch.status).toBe(409);
    expect((await rejectedMismatch.json() as { code: string }).code).toBe('TRAINING_HELDOUT_VARIANT_QUARANTINED');

    const recoveryFailure = await fixture();
    const recoveryArm = await recoveryFailure.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: recoveryFailure.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: '[SYNTHETIC TEST TASK] replay recovery failure', mutationKey: 'fixture-recovery-index-arm',
    });
    const recoveryAttempt = (await recoveryArm.json() as { attempt: { id: string; revision: number } }).attempt;
    const recoveryInput = { contaminationCode: 'LEARNER_REPORTED_EXPOSURE', expectedRevision: recoveryAttempt.revision, mutationKey: 'fixture-recovery-index-contamination' };
    expect((await recoveryFailure.request(`/api/training/heldout-attempts/${recoveryAttempt.id}/contamination`, 'learner-a', 'student', recoveryInput)).status).toBe(200);
    recoveryFailure.sqlite.prepare('DELETE FROM training_heldout_variant_quarantines WHERE opaque_variant_id = ?').run('HH-V-IMMEDIATE-01');
    recoveryFailure.sqlite.exec(`CREATE TRIGGER fixture_recovery_index_failure BEFORE INSERT ON training_heldout_variant_quarantines
      BEGIN SELECT RAISE(ABORT, 'fixture replay index recovery failure'); END`);
    const failedRecovery = await recoveryFailure.request(`/api/training/heldout-attempts/${recoveryAttempt.id}/contamination`, 'learner-a', 'student', recoveryInput);
    expect(failedRecovery.status).toBe(500);
    expect(recoveryFailure.sqlite.prepare('SELECT COUNT(*) AS count FROM training_heldout_variant_quarantines').get()).toEqual({ count: 0 });

    const crossAttempt = await fixture();
    const preArmedTask = '[SYNTHETIC TEST TASK] pre-armed task must stay undisclosed.';
    const preArmed = await crossAttempt.request('/api/training/operator/heldout-attempts', 'local-admin', 'admin', {
      baseSessionId: crossAttempt.base.sessionId, ownerUserId: 'learner-a', opaqueVariantId: 'HH-V-IMMEDIATE-01', taskText: preArmedTask, mutationKey: 'fixture-cross-prearm',
    });
    const preArmedAttempt = (await preArmed.json() as { attempt: { id: string; revision: number } }).attempt;
    const preArmedOpen = await crossAttempt.request(`/api/training/heldout-attempts/${preArmedAttempt.id}/open`, 'learner-a', 'student', {
      expectedRevision: preArmedAttempt.revision, mutationKey: 'fixture-cross-prearm-open',
    });
    expect(preArmedOpen.status).toBe(200);
    const preArmedResponse = '[SYNTHETIC LEARNER RESPONSE] Completed before a separate attempt reported contamination.';
    const preArmedSubmit = await crossAttempt.request(`/api/training/heldout-attempts/${preArmedAttempt.id}/submit`, 'learner-a', 'student', {
      response: preArmedResponse, expectedRevision: 2, mutationKey: 'fixture-cross-prearm-submit',
    });
    expect(preArmedSubmit.status).toBe(200);
    const category = crossAttempt.sqlite.prepare('SELECT category FROM training_sessions WHERE id = ?').get(crossAttempt.base.sessionId) as { category: string };
    crossAttempt.sqlite.prepare(`INSERT INTO training_sessions (id, user_id, category, difficulty, question, training_mode, is_completed, current_turn, max_turns)
      VALUES ('fixture-cross-base', 'learner-a', ?, 'intermediate', 'Synthetic cross-attempt base.', 'scenario', 0, 0, 1)`).run(category.category);
    crossAttempt.sqlite.prepare(`INSERT INTO training_heldout_attempts (
      id, base_session_id, owner_user_id, operator_user_id, case_id, case_version, locale, rubric_version,
      baseline_version, measurement_id, opaque_variant_id, adapter_manifest_sha256, source_manifest_sha256,
      task_text, task_sha256, created_at
    ) SELECT 'fixture-cross-contaminated', 'fixture-cross-base', owner_user_id, operator_user_id, case_id, case_version, locale, rubric_version,
      baseline_version, measurement_id, opaque_variant_id, adapter_manifest_sha256, source_manifest_sha256,
      task_text, task_sha256, created_at
      FROM training_heldout_attempts WHERE id = ?`).run(preArmedAttempt.id);
    crossAttempt.sqlite.prepare(`INSERT INTO training_heldout_attempt_events (
      id, attempt_id, revision, event_type, actor_user_id, mutation_key, missingness,
      response_text, response_sha256, assistance_ids_json, reason, created_at
    ) VALUES ('fixture-cross-contaminated-arm', 'fixture-cross-contaminated', 1, 'ARM', 'local-admin', 'fixture-cross-contaminated-arm', 'NOT_STARTED', NULL, NULL, '[]', NULL, ?)`)
      .run(Date.now());
    const crossContamination = await crossAttempt.request('/api/training/heldout-attempts/fixture-cross-contaminated/contamination', 'learner-a', 'student', {
      contaminationCode: 'LEARNER_REPORTED_EXPOSURE', expectedRevision: 1, mutationKey: 'fixture-cross-contamination',
    });
    expect(crossContamination.status).toBe(200);
    const blockedOpen = await crossAttempt.request(`/api/training/heldout-attempts/${preArmedAttempt.id}/open`, 'learner-a', 'student', {
      expectedRevision: preArmedAttempt.revision, mutationKey: 'fixture-cross-open',
    });
    expect(blockedOpen.status).toBe(409);
    const blockedText = await blockedOpen.text();
    expect((JSON.parse(blockedText) as { code: string }).code).toBe('TRAINING_HELDOUT_VARIANT_QUARANTINED');
    expect(blockedText).not.toContain(preArmedTask);
    expect(blockedText).not.toContain(preArmedResponse);
    const ownerDetail = await crossAttempt.request(`/api/training/session/${crossAttempt.base.sessionId}`, 'learner-a', 'student', undefined, 'GET');
    expect(ownerDetail.status).toBe(200);
    const ownerDetailText = await ownerDetail.text();
    expect(ownerDetailText).not.toContain(preArmedTask);
    expect(ownerDetailText).not.toContain(preArmedResponse);
    expect((JSON.parse(ownerDetailText) as { heldOutAttempt: unknown }).heldOutAttempt).toEqual({ status: 'UNAVAILABLE', attempt: null });
    const ownerResume = await crossAttempt.request(`/api/training/session/${crossAttempt.base.sessionId}/resume`, 'learner-a', 'student', {}, 'POST');
    expect(ownerResume.status).toBe(200);
    const ownerResumeText = await ownerResume.text();
    expect(ownerResumeText).not.toContain(preArmedTask);
    expect(ownerResumeText).not.toContain(preArmedResponse);
    expect((JSON.parse(ownerResumeText) as { heldOutAttempt: unknown }).heldOutAttempt).toEqual({ status: 'UNAVAILABLE', attempt: null });
    const historyDetail = await historyRoute.request(`/api/sessions/${crossAttempt.base.sessionId}`, {
      method: 'GET', headers: await crossAttempt.headers('learner-a', 'student'),
    }, crossAttempt.env);
    expect(historyDetail.status).toBe(200);
    const historyDetailText = await historyDetail.text();
    expect(historyDetailText).not.toContain(preArmedTask);
    expect(historyDetailText).not.toContain(preArmedResponse);
    expect((JSON.parse(historyDetailText) as { heldOutAttempt: unknown }).heldOutAttempt).toEqual({ status: 'UNAVAILABLE', attempt: null });
    const historyResume = await historyRoute.request(`/api/sessions/${crossAttempt.base.sessionId}/resume`, {
      method: 'POST', headers: await crossAttempt.headers('learner-a', 'student'), body: '{}',
    }, crossAttempt.env);
    expect(historyResume.status).toBe(200);
    const historyResumeText = await historyResume.text();
    expect(historyResumeText).not.toContain(preArmedTask);
    expect(historyResumeText).not.toContain(preArmedResponse);
    expect((JSON.parse(historyResumeText) as { heldOutAttempt: unknown }).heldOutAttempt).toEqual({ status: 'UNAVAILABLE', attempt: null });
    const blockedSubmit = await crossAttempt.request(`/api/training/heldout-attempts/${preArmedAttempt.id}/submit`, 'learner-a', 'student', {
      response: preArmedResponse, expectedRevision: 3, mutationKey: 'fixture-cross-blocked-submit',
    });
    expect(blockedSubmit.status).toBe(409);
    expect(await blockedSubmit.text()).not.toContain(preArmedResponse);
    const blockedStop = await crossAttempt.request(`/api/training/heldout-attempts/${preArmedAttempt.id}/stop`, 'learner-a', 'student', {
      expectedRevision: 3, mutationKey: 'fixture-cross-blocked-stop',
    });
    expect(blockedStop.status).toBe(409);
    expect(await blockedStop.text()).not.toContain(preArmedResponse);
    const audit = await crossAttempt.request(`/api/training/operator/heldout-attempts/${preArmedAttempt.id}`, 'local-admin', 'admin', undefined, 'GET');
    expect(audit.status).toBe(200);
    const auditProjection = await audit.json() as { attempt: Record<string, unknown> };
    expect(auditProjection.attempt.taskText).toBeUndefined();
    expect(auditProjection.attempt.response).toBeUndefined();
    expect(auditProjection.attempt.taskHash).toEqual(expect.any(String));
    expect(JSON.stringify(auditProjection)).not.toContain(preArmedTask);
    expect(JSON.stringify(auditProjection)).not.toContain(preArmedResponse);
    expect(crossAttempt.sqlite.prepare('SELECT event_type, missingness, contamination_code, reason FROM training_heldout_attempt_events WHERE attempt_id = ? ORDER BY revision DESC LIMIT 1').get(preArmedAttempt.id)).toEqual({
      event_type: 'QUARANTINE', missingness: 'CONTAMINATED', contamination_code: 'GLOBAL_VARIANT_QUARANTINE', reason: null,
    });
    expect(crossAttempt.sqlite.prepare('SELECT contamination_code FROM training_heldout_variant_quarantines WHERE opaque_variant_id = ?').get('HH-V-IMMEDIATE-01')).toEqual({ contamination_code: 'LEARNER_REPORTED_EXPOSURE' });
  });

  it('renders an escaped M4 readback card with UNKNOWN assessment copy', async () => {
    class Element {
      innerHTML = '';
      inserted: string[] = [];
      style = { display: 'none' };
      parentElement: Element | null = null;
      classList = { add: () => undefined, remove: () => undefined };
      inert = false;
      isConnected = true;
      focus() {}
      closest() { return null; }
      replaceChildren() { this.innerHTML = ''; this.inserted = []; }
      insertAdjacentHTML(_position: string, html: string) { this.inserted.push(html); }
    }
    const body = new Element();
    const elements = new Map([['history-detail-body', body], ['history-detail-modal', new Element()], ['history-detail-title', new Element()]]);
    const escape = (value: unknown) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    const payload = {
      messages: [],
      heldOutAttempt: {
        status: 'AVAILABLE',
        attempt: { id: 'm4-1', state: 'SUBMITTED', measurement: 'M4', opaqueVariantId: 'HH-V-IMMEDIATE-01', missingness: 'NONE', assessmentState: 'UNKNOWN', response: '<script>learner response</script>' },
      },
    };
    const window = { SocraticAI: { State: {}, getEl: (id: string) => elements.get(id) || null, setDisplay: (id: string, display: string) => { const element = elements.get(id); if (element) element.style.display = display; }, setText: () => undefined, api: () => undefined, apiGet: async () => payload, apiDelete: () => undefined, showToast: () => undefined, esc: escape, escapeAttribute: escape } };
    const document = { activeElement: null, addEventListener: () => undefined, documentElement: new Element(), body: new Element(), getElementById: (id: string) => elements.get(id) || null };
    const context = createContext({ window, document, HTMLElement: Element, Map, Set, Number, String, Date, Object, Error });
    runInContext(readFileSync('public/static/modules/history.js', 'utf8'), context);
    await (window as unknown as { viewHistoryDetail: (id: string, type: string) => Promise<void> }).viewHistoryDetail('training-1', 'training');
    const html = body.innerHTML + body.inserted.join('');
    expect(html).toContain('M4 즉시 무지원 응답');
    expect(html).toContain('평가 결과는 UNKNOWN');
    expect(html).toContain('&lt;script&gt;learner response&lt;/script&gt;');
    expect(html).not.toContain('<script>learner response</script>');
    const trainingModule = readFileSync('public/static/modules/training.js', 'utf8');
    const m4Renderer = trainingModule.slice(trainingModule.indexOf('function renderHeldOutAttempt'), trainingModule.indexOf('function resetTrainingUI'));
    expect(m4Renderer).toContain("label.textContent = '도움 없이 작성한 응답'");
    expect(m4Renderer).toContain("response.setAttribute('aria-label', '도움 없이 작성한 응답')");
    expect(m4Renderer).toContain('requestAnimationFrame(() => response.focus())');
    expect(m4Renderer).toContain('requestVersion !== trainingResumeVersion');
    expect(m4Renderer).not.toContain('/api/training/hint');
    expect(m4Renderer).not.toContain('/support');
    expect(m4Renderer).not.toContain('/revisions');
  });

  it('posts the exact closed exposure payload from the rendered M4 contamination control', async () => {
    class Element {
      children: Element[] = [];
      className = '';
      dataset: Record<string, string> = {};
      disabled = false;
      hidden = false;
      id = '';
      textContent = '';
      type = '';
      private readonly listeners = new Map<string, Array<() => unknown>>();
      readonly classList = { add: () => undefined, remove: () => undefined, toggle: () => undefined };

      constructor(readonly tagName: string) {}

      append(...nodes: Element[]) { this.children.push(...nodes); }
      appendChild(node: Element) { this.children.push(node); return node; }
      addEventListener(type: string, listener: () => unknown) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
      }
      click() { for (const listener of this.listeners.get('click') || []) listener(); }
      remove() {}
      replaceChildren(...nodes: Element[]) { this.children = nodes; }
      setAttribute() {}
    }

    const host = new Element('section');
    const elements = new Map([['training-session', host]]);
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    let mutationSequence = 0;
    const attempt = {
      id: 'm4-attempt-1',
      baseSessionId: 'base-session-1',
      state: 'ARMED',
      opaqueVariantId: 'HH-V-IMMEDIATE-01',
      revision: 7,
    };
    const window = {
      SocraticAI: {
        State: {},
        KOREAN_JOURNEY_COPY: {},
        getEl: (id: string) => elements.get(id) || null,
        setDisplay: () => undefined,
        api: async (path: string, body: Record<string, unknown>) => {
          calls.push({ path, body });
          return { attempt };
        },
        apiGet: async () => ({}),
        showToast: () => undefined,
        esc: (value: unknown) => String(value),
        isAuthExpiryScreenVisible: () => false,
        focusLoginAfterAuthExpiry: () => undefined,
      },
    };
    const document = {
      addEventListener: () => undefined,
      createElement: (tagName: string) => new Element(tagName),
      getElementById: (id: string) => elements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const context = createContext({
      window,
      document,
      HTMLElement: Element,
      Map,
      Set,
      Number,
      String,
      Date,
      Object,
      Error,
      crypto: { randomUUID: () => `m4-mutation-${++mutationSequence}` },
      encodeURIComponent,
      requestAnimationFrame: () => undefined,
      CSS: { escape: (value: string) => value },
    });
    const trainingModule = readFileSync('public/static/modules/training.js', 'utf8');
    const renderer = trainingModule.slice(trainingModule.indexOf('function renderHeldOutAttempt'), trainingModule.indexOf('function resetTrainingUI'));
    runInContext(`
      const getEl = window.SocraticAI.getEl;
      const api = window.SocraticAI.api;
      const showToast = window.SocraticAI.showToast;
      let trainingResumeVersion = 0;
      let trainingSessionId = null;
      function learnerSafeTrainingFailure() { return 'safe failure'; }
      ${renderer}
    `, context);
    (runInContext('renderHeldOutAttempt', context) as (projection: unknown) => void)({ status: 'AVAILABLE', attempt });

    const findButton = (node: Element): Element | undefined => {
      if (node.tagName === 'button' && node.textContent === '신고하고 이 시도 격리') return node;
      return node.children.map(findButton).find(Boolean);
    };
    const report = findButton(host);
    expect(report).toBeDefined();
    report!.click();
    report!.click();
    await Promise.resolve();

    expect(calls).toHaveLength(2);
    expect(calls[0].path).toBe('/api/training/heldout-attempts/m4-attempt-1/contamination');
    expect(Object.keys(calls[0].body).sort()).toEqual(['contaminationCode', 'expectedRevision', 'mutationKey']);
    expect(calls[0].body).toMatchObject({ contaminationCode: 'LEARNER_REPORTED_EXPOSURE', expectedRevision: 7, mutationKey: 'm4-mutation-1' });
    expect(calls[1].body.mutationKey).toBe('m4-mutation-2');
  });

  it('resumes ARMED and IN_PROGRESS M4 attempts without assistance-history reads while rendering the held-out card', async () => {
    for (const state of ['ARMED', 'IN_PROGRESS'] as const) {
      class Element {
        children: Element[] = [];
        className = '';
        dataset: Record<string, string> = {};
        disabled = false;
        hidden = false;
        id = '';
        innerHTML = '';
        textContent = '';
        type = '';
        value = '';
        readonly classList = { add: () => undefined, remove: () => undefined, toggle: () => undefined };

        constructor(readonly tagName: string) {}

        append(...nodes: Element[]) { this.children.push(...nodes); }
        appendChild(node: Element) { this.children.push(node); return node; }
        addEventListener() {}
        focus() {}
        prepend(...nodes: Element[]) { this.children.unshift(...nodes); }
        querySelectorAll() { return []; }
        remove() {}
        removeAttribute() {}
        replaceChildren(...nodes: Element[]) { this.children = nodes; this.innerHTML = ''; }
        setAttribute() {}
      }

      const sessionId = `heldout-resume-${state.toLowerCase()}`;
      const host = new Element('section');
      const controlPanel = new Element('section'); controlPanel.hidden = false; controlPanel.children = [new Element('p')];
      const revisionPanel = new Element('section'); revisionPanel.hidden = false; revisionPanel.children = [new Element('p')];
      const elements = new Map([
        ['training-session', host],
        ['training-control-panel', controlPanel],
        ['training-revision-panel', revisionPanel],
      ]);
      const calls: string[] = [];
      const detail = {
        session: { id: sessionId, mode: 'evidence', is_completed: true, current_turn: 1, max_turns: 1 },
        messages: [],
        turns: [],
        attributions: [],
        grounding: null,
        briefing: null,
        learningRoute: null,
        growthFollowUp: null,
        heldOutAttempt: {
          status: 'AVAILABLE',
          attempt: { id: `m4-${state.toLowerCase()}`, baseSessionId: sessionId, state, opaqueVariantId: 'HH-V-IMMEDIATE-01', revision: state === 'ARMED' ? 1 : 2 },
        },
      };
      const window = {
        SocraticAI: {
          State: {},
          KOREAN_JOURNEY_COPY: { uncertainty: { evidenceHintReason: 'fixture' } },
          getEl: (id: string) => elements.get(id) || null,
          setDisplay: () => undefined,
          api: async () => ({}),
          apiGet: async (path: string) => {
            calls.push(path);
            if (path === `/api/training/session/${sessionId}`) return detail;
            if (path === `/api/training/session/${sessionId}/interventions`) return { state: 'COMPLETED', revision: 0, history: [] };
            if (path === `/api/training/session/${sessionId}/revisions`) return { history: [], pending: null, revision: 0 };
            throw new Error(`Unexpected path: ${path}`);
          },
          showToast: () => undefined,
          esc: (value: unknown) => String(value),
          isAuthExpiryScreenVisible: () => false,
          focusLoginAfterAuthExpiry: () => undefined,
        },
      };
      const document = {
        addEventListener: () => undefined,
        createElement: (tagName: string) => new Element(tagName),
        getElementById: (id: string) => elements.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      const context = createContext({
        window,
        document,
        HTMLElement: Element,
        Map,
        Set,
        Number,
        String,
        Date,
        Object,
        Error,
        console: { warn: () => undefined },
        crypto: { randomUUID: () => 'fixture-mutation-key' },
        encodeURIComponent,
        requestAnimationFrame: () => undefined,
        CSS: { escape: (value: string) => value },
      });
      runInContext(readFileSync('public/static/modules/training.js', 'utf8'), context);
      await (window as unknown as { resumeTrainingSession: (id: string) => Promise<void> }).resumeTrainingSession(sessionId);

      expect(calls).toEqual([`/api/training/session/${sessionId}`]);
      expect(host.children.some((child) => child.id === 'training-m4-attempt')).toBe(true);
      expect(controlPanel.hidden).toBe(true);
      expect(controlPanel.children).toEqual([]);
      expect(revisionPanel.hidden).toBe(true);
      expect(revisionPanel.children).toEqual([]);
    }
  });
});
