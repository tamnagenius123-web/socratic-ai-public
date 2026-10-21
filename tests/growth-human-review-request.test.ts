import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createGrowthCycleSecurity } from '../src/services/growth-cycle-security';
import type { GrowthCycleSecurity } from '../src/services/growth-cycle-types';

const REQUEST_MIGRATION = 'migrations/0065_growth_human_review_requests.sql';
const REQUEST_MIGRATION_PRESENT = existsSync(REQUEST_MIGRATION);
const NOW = 1_700_000_000_000;
const SURFACE_CYCLE_ID = 'cycle-a2';
const SURFACE_RAW_EVENT_ID = 'fixture-surface-raw-event-a2';
const SURFACE_OBSERVATION_ID = 'fixture-surface-observation-a2';
const SURFACE_HYPOTHESIS_ID = 'fixture-surface-hypothesis-a2';
const SURFACE_CAPABILITY_ID = 'growth-capability:training-five-axis:claim-clarity:1';
const SURFACE_OBSERVATION_RULE_ID = 'growth-observation-rule:training-lowest-axis-descriptive:en:1';
const SURFACE_GAP_RULE_ID = 'growth-gap-rule:training-five-axis:provisional:en:1';

function migration(name: string): string {
  return readFileSync(`migrations/${name}`, 'utf8');
}

function openSchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA recursive_triggers = OFF;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE sparring_evidence_manifests (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_number INTEGER NOT NULL,
      user_id TEXT NOT NULL, book_id TEXT NOT NULL, query_text TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL, source_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(session_id, turn_number)
    );
    CREATE TABLE sparring_turn_evidence (
      id TEXT PRIMARY KEY, manifest_id TEXT NOT NULL, session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL, book_id TEXT NOT NULL, chunk_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL, char_start INTEGER, char_end INTEGER,
      content_snapshot TEXT NOT NULL, content_sha256 TEXT NOT NULL,
      relevance_score REAL NOT NULL, created_at INTEGER NOT NULL, source_id TEXT,
      book_title TEXT, book_author TEXT, UNIQUE(session_id, turn_number, chunk_id)
    );
    CREATE TABLE training_sessions (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), category TEXT NOT NULL DEFAULT 'policy',
      difficulty TEXT NOT NULL DEFAULT 'intermediate', question TEXT NOT NULL DEFAULT 'fixture',
      question_title TEXT NOT NULL DEFAULT 'fixture', context TEXT NOT NULL DEFAULT '',
      expected_tensions TEXT NOT NULL DEFAULT '[]', session_goal TEXT NOT NULL DEFAULT '',
      tutor_state TEXT NOT NULL DEFAULT 'elicitation', student_model TEXT NOT NULL DEFAULT '{}',
      current_turn INTEGER NOT NULL DEFAULT 1, max_turns INTEGER NOT NULL DEFAULT 8,
      created_at INTEGER NOT NULL DEFAULT 1700000000000, updated_at INTEGER NOT NULL DEFAULT 1700000000000
    );
    CREATE TABLE category_hierarchy (id TEXT PRIMARY KEY, is_active INTEGER NOT NULL);
    CREATE TABLE books (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL,
      lifecycle_status TEXT, is_builtin INTEGER NOT NULL, visibility TEXT NOT NULL, owner_user_id TEXT
    );
    CREATE TABLE document_chunks (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      char_start INTEGER, char_end INTEGER, content TEXT NOT NULL
    );
  `);
  db.exec(migration('0036_training_scenario_evidence_spine.sql'));
  db.exec(`
    ALTER TABLE training_scenario_evidence ADD COLUMN char_start INTEGER;
    ALTER TABLE training_scenario_evidence ADD COLUMN char_end INTEGER;
    ALTER TABLE training_scenario_evidence ADD COLUMN lifecycle_status TEXT;
    ALTER TABLE training_scenario_evidence ADD COLUMN quarantined_at INTEGER;
    ALTER TABLE training_scenario_evidence ADD COLUMN deleted_at INTEGER;
  `);
  db.exec(migration('0062_ai_invocation_attempt_receipts.sql'));
  db.exec(migration('0063_learning_session_context.sql'));
  db.exec(migration('0064_training_session_context.sql'));
  db.exec(migration('0047_growth_cycle_foundation.sql'));
  return db;
}

function applyRequestMigration(db: DatabaseSync): void {
  if (!REQUEST_MIGRATION_PRESENT) return;
  db.exec(migration('0065_growth_human_review_requests.sql'));
}

function seedSpace(db: DatabaseSync, spaceId: string, ownerUserId: string, consentId: string): void {
  db.prepare('INSERT INTO users (id) VALUES (?1)').run(ownerUserId);
  db.prepare(`
    INSERT INTO growth_private_consent_receipts (
      id, subject_user_id, purpose, data_classes_json, policy_revision,
      retention_policy, issued_at, revoked_at, created_at
    ) VALUES (?1, ?2, 'human-review-test', '["growth"]', 1, 'fixture-only', ?3, NULL, ?3)
  `).run(consentId, ownerUserId, NOW);
  db.prepare(`
    INSERT INTO growth_spaces (
      id, space_type, host_user_id, privacy_mode, consent_receipt_id,
      aggregate_revision, status, created_at, updated_at, archived_at
    ) VALUES (?1, 'SOLO', ?2, 'PRIVATE', ?3, 1, 'ACTIVE', ?4, ?4, NULL)
  `).run(spaceId, ownerUserId, consentId, NOW);
}

function seedCycle(
  db: DatabaseSync,
  cycleId: string,
  spaceId: string,
  ownerUserId: string,
  consentId: string,
  suffix: string,
): void {
  db.prepare(`
    INSERT INTO growth_cycles (
      id, space_id, participant_membership_id, path_revision_id,
      origin_kind, origin_attempt_id, origin_turn_number, origin_event_identity,
      origin_lookup_digest, origin_request_digest, state, aggregate_revision,
      consent_receipt_id, opened_at, updated_at, closed_at
    ) VALUES (
      ?1, ?2, ?3, 'growth-path:training-five-axis:en:1',
      'TRAINING', ?4, 1, ?5, ?6, ?7, 'EVIDENCE_PENDING', 1, ?8, ?9, ?9, NULL
    )
  `).run(
    cycleId,
    spaceId,
    `growth-host:${spaceId}`,
    `attempt-${suffix}`,
    `event-${suffix}`,
    `${suffix}1`.repeat(64 / (`${suffix}1`.length)),
    `${suffix}2`.repeat(64 / (`${suffix}2`.length)),
    consentId,
    NOW,
  );
}

function fixture(): DatabaseSync {
  const db = openSchema();
  seedSpace(db, 'space-a', 'fixture-a', 'consent-a');
  seedSpace(db, 'space-b', 'fixture-b', 'consent-b');
  seedCycle(db, 'cycle-a', 'space-a', 'fixture-a', 'consent-a', 'a');
  seedCycle(db, 'cycle-a2', 'space-a', 'fixture-a', 'consent-a', 'c');
  seedCycle(db, 'cycle-b', 'space-b', 'fixture-b', 'consent-b', 'b');
  applyRequestMigration(db);
  return db;
}

type SqliteD1Statement = {
  readonly sql: string;
  bind(...values: unknown[]): SqliteD1Statement;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  executeBatch(): Promise<unknown>;
};

type SqlTraceEntry = { sql: string; values: unknown[] };

type D1Hooks = {
  readonly afterHumanReviewLookup?: () => void;
  readonly trace?: SqlTraceEntry[];
};

function asD1(db: DatabaseSync, hooks: D1Hooks = {}): D1Database {
  function prepare(sql: string): SqliteD1Statement {
    let values: SQLInputValue[] = [];
    const statement: SqliteD1Statement = {
      sql,
      bind(...next: unknown[]) {
        values = next as SQLInputValue[];
        hooks.trace?.push({ sql, values: [...next] });
        return statement;
      },
      async run() { return db.prepare(sql).run(...values); },
      async first<T>() {
        const result = (db.prepare(sql).get(...values) ?? null) as T | null;
        if (/FROM\s+growth_human_review_requests\b/i.test(sql)) hooks.afterHumanReviewLookup?.();
        return result;
      },
      async all<T>() { return { results: db.prepare(sql).all(...values) as T[] }; },
      async executeBatch() {
        return /^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql)
          ? { results: db.prepare(sql).all(...values) }
          : db.prepare(sql).run(...values);
      },
    };
    return statement;
  }
  return {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result: unknown[] = [];
        for (const statement of statements as unknown as SqliteD1Statement[]) result.push(await statement.executeBatch());
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function asConcurrentWinnerD1(db: DatabaseSync, afterWinner: () => void): D1Database {
  const regular = asD1(db);
  return {
    prepare: regular.prepare,
    async batch(statements: D1PreparedStatement[]) {
      const [statement] = statements as unknown as SqliteD1Statement[];
      if (statement?.sql.includes('INSERT INTO growth_human_review_requests')) {
        await statement.executeBatch();
        afterWinner();
        throw new Error('UNIQUE constraint failed: simulated concurrent winner');
      }
      return regular.batch(statements);
    },
  } as unknown as D1Database;
}

function asCycleRevisionOverrideD1(db: DatabaseSync, aggregateRevision: number): D1Database {
  const regular = asD1(db);
  return {
    prepare(sql: string) {
      const statement = regular.prepare(sql) as unknown as SqliteD1Statement;
      if (!/FROM\s+growth_cycles\s+cycle\b/i.test(sql)) return statement;
      const overridden: SqliteD1Statement = {
        sql: statement.sql,
        bind(...values: unknown[]) { statement.bind(...values); return overridden; },
        run() { return statement.run(); },
        async first<T>() {
          const result = await statement.first<T>();
          if (!result || typeof result !== 'object' || !('aggregate_revision' in result)) return result;
          return { ...(result as Record<string, unknown>), aggregate_revision: aggregateRevision } as T;
        },
        all<T>() { return statement.all<T>(); },
        executeBatch() { return statement.executeBatch(); },
      };
      return overridden;
    },
    batch: regular.batch,
  } as unknown as D1Database;
}

function seedSurfaceRowsAndAdvanceToGapUnknown(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO growth_mutation_receipts (
        id, actor_user_id, route_action, idempotency_key, growth_cycle_id,
        expected_aggregate_revision, lifecycle_action, request_digest,
        response_digest, response_json, result_resource_type, result_resource_id,
        result_aggregate_revision, created_at
      ) VALUES (
        ?1, 'fixture-a', 'SYSTEM:GROWTH_CYCLE', 'fixture-surface-raw-a2', ?2,
        1, NULL, ?3, ?4, ?5, 'GROWTH_CYCLE', ?2, 1, ?6
      )
    `).run(
      'fixture-surface-raw-receipt-a2',
      SURFACE_CYCLE_ID,
      'a'.repeat(64),
      'b'.repeat(64),
      JSON.stringify({ cycleId: SURFACE_CYCLE_ID, state: 'EVIDENCE_PENDING', aggregateRevision: 1 }),
      NOW,
    );
    db.prepare(`
      INSERT INTO growth_events (
        id, space_id, growth_cycle_id, actor_membership_id, actor_pseudonym_id,
        event_type, object_type, object_id, object_revision, lifecycle_action,
        previous_state, next_state, transition_subject_type, transition_subject_id,
        occurred_at, recorded_at, source_system, source_event_id, payload_digest,
        mutation_receipt_id, visibility, consent_receipt_id
      ) VALUES (
        ?1, 'space-a', ?2, 'growth-host:space-a', 'growth-host:space-a',
        'RAW_ORIGIN_EVALUATION_RECORDED', 'OBSERVATION', ?3, 1, NULL,
        NULL, NULL, NULL, NULL, ?4, ?4, 'owned-persisted-origin', 'event-c',
        ?5, 'fixture-surface-raw-receipt-a2', 'PRIVATE', 'consent-a'
      )
    `).run(
      SURFACE_RAW_EVENT_ID,
      SURFACE_CYCLE_ID,
      SURFACE_OBSERVATION_ID,
      NOW,
      'c'.repeat(64),
    );
    db.prepare(`
      INSERT INTO growth_capability_observations (
        id, growth_cycle_id, capability_id, capability_revision, rubric_revision_id,
        status, value_numeric, value_scale, evidence_event_ids_json,
        inference_rule_id, inference_rule_revision, inference_validation, confidence,
        raw_signal_json, observed_at, recorded_at
      ) VALUES (
        ?1, ?2, ?3, 1, NULL, 'UNKNOWN', NULL, NULL, ?4, ?5, 1,
        'PROVISIONAL_UNCALIBRATED', NULL, ?6, ?7, ?7
      )
    `).run(
      SURFACE_OBSERVATION_ID,
      SURFACE_CYCLE_ID,
      SURFACE_CAPABILITY_ID,
      JSON.stringify([SURFACE_RAW_EVENT_ID]),
      SURFACE_OBSERVATION_RULE_ID,
      JSON.stringify({ fixture: 'unchanged-surface' }),
      NOW + 1,
    );
    db.prepare(`
      INSERT INTO growth_gap_hypotheses (
        id, growth_cycle_id, observation_id, capability_id, capability_revision,
        gap_rule_id, gap_rule_revision, statement, state, supporting_event_ids_json,
        contradicting_event_ids_json, participant_rationale, generator_revision,
        model_revision, prompt_revision, source_revision, revises_hypothesis_id,
        revision_rationale, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, 1, ?5, 1, ?6, 'UNKNOWN', '[]', '[]',
        NULL, 'fixture-test', 'fixture-test', 'fixture-test', 'fixture-test',
        NULL, NULL, ?7, ?7
      )
    `).run(
      SURFACE_HYPOTHESIS_ID,
      SURFACE_CYCLE_ID,
      SURFACE_OBSERVATION_ID,
      SURFACE_CAPABILITY_ID,
      SURFACE_GAP_RULE_ID,
      'Fixture hypothesis for unchanged-surface control',
      NOW + 2,
    );
    db.prepare(`
      INSERT INTO growth_mutation_receipts (
        id, actor_user_id, route_action, idempotency_key, growth_cycle_id,
        expected_aggregate_revision, lifecycle_action, request_digest,
        response_digest, response_json, result_resource_type, result_resource_id,
        result_aggregate_revision, created_at
      ) VALUES (
        ?1, 'fixture-a', 'SYSTEM:GROWTH_CYCLE', 'fixture-surface-gap-a2', ?2,
        1, ?3, ?4, ?5, ?6, 'GROWTH_CYCLE', ?2, 2, ?7
      )
    `).run(
      'fixture-surface-gap-receipt-a2',
      SURFACE_CYCLE_ID,
      'PROVISIONAL_OR_INSUFFICIENT_SIGNAL_RECORDED',
      'd'.repeat(64),
      'e'.repeat(64),
      JSON.stringify({ cycleId: SURFACE_CYCLE_ID, state: 'GAP_UNKNOWN', aggregateRevision: 2 }),
      NOW + 3,
    );
    db.prepare(`
      INSERT INTO growth_events (
        id, space_id, growth_cycle_id, actor_membership_id, actor_pseudonym_id,
        event_type, object_type, object_id, object_revision, lifecycle_action,
        previous_state, next_state, transition_subject_type, transition_subject_id,
        occurred_at, recorded_at, source_system, source_event_id, payload_digest,
        mutation_receipt_id, visibility, consent_receipt_id
      ) VALUES (
        ?1, 'space-a', ?2, NULL, 'system:growth-cycle',
        'GAP_REMAINS_UNKNOWN', 'GROWTH_CYCLE', ?2, 2, ?3,
        'EVIDENCE_PENDING', 'GAP_UNKNOWN', 'GAP_HYPOTHESIS', ?4,
        ?5, ?5, 'growth-cycle-service', 'cycle-a2:2:fixture-surface-gap-a2',
        ?6, 'fixture-surface-gap-receipt-a2', 'PRIVATE', 'consent-a'
      )
    `).run(
      'fixture-surface-gap-event-a2',
      SURFACE_CYCLE_ID,
      'PROVISIONAL_OR_INSUFFICIENT_SIGNAL_RECORDED',
      SURFACE_HYPOTHESIS_ID,
      NOW + 3,
      'f'.repeat(64),
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function fixtureWithSeededSurfaceFacts(): Promise<{
  db: DatabaseSync;
  cycleId: string;
  expectedRevision: number;
  recheckId: string;
}> {
  const db = fixture();
  seedSurfaceRowsAndAdvanceToGapUnknown(db);
  const service = await import('../src/services/growth-cycle');
  const security = createGrowthCycleSecurity('fixture-growth-secret');
  const focus = await service.selectGrowthFocus(
    asD1(db),
    security,
    'fixture-a',
    'space-a',
    SURFACE_CYCLE_ID,
    {
      capabilityId: SURFACE_CAPABILITY_ID,
      capabilityRevision: 1,
      statement: 'Fixture focus for unchanged-surface control',
      reason: 'Fixture-only evidence coverage',
    },
    'fixture-surface-focus-a2',
    2,
  );
  const practiceQuestId = (focus as Record<string, unknown>).practiceQuestId;
  if (typeof practiceQuestId !== 'string') {
    db.close();
    throw new Error('surface fixture focus did not create a practice quest');
  }
  const scheduled = await service.respondToPractice(
    asD1(db),
    security,
    'fixture-a',
    'space-a',
    SURFACE_CYCLE_ID,
    { action: 'accept', practiceQuestId },
    'fixture-surface-practice-a2',
    4,
  );
  const recheckId = (scheduled as Record<string, unknown>).recheckId;
  if (typeof recheckId !== 'string') {
    db.close();
    throw new Error('surface fixture practice did not create a recheck');
  }
  const recheck = db.prepare('SELECT created_at FROM growth_rechecks WHERE id = ?1').get(recheckId) as { created_at: number } | undefined;
  if (!recheck || typeof recheck.created_at !== 'number') {
    db.close();
    throw new Error('surface fixture recheck row is unavailable');
  }
  const recordedAt = Math.max(NOW + 5, recheck.created_at + 1);
  db.prepare(`
    UPDATE growth_rechecks
    SET follow_up_origin_kind = 'TRAINING', follow_up_attempt_id = 'fixture-follow-up-a2',
      outcome = 'UNKNOWN', recorded_at = ?2
    WHERE id = ?1
  `).run(recheckId, recordedAt);
  const cycle = db.prepare('SELECT aggregate_revision FROM growth_cycles WHERE id = ?1').get(SURFACE_CYCLE_ID) as { aggregate_revision: number } | undefined;
  if (!cycle || !Number.isSafeInteger(cycle.aggregate_revision)) {
    db.close();
    throw new Error('surface fixture cycle revision is unavailable');
  }
  return { db, cycleId: SURFACE_CYCLE_ID, expectedRevision: cycle.aggregate_revision, recheckId };
}

type RecordedHmacCall = { purpose: string; canonical: string; digest: string };

function recordingSecurity(secret: string, calls: RecordedHmacCall[]): GrowthCycleSecurity {
  const delegate = createGrowthCycleSecurity(secret);
  return {
    async hmacSha256(purpose: string, canonicalBytes: Uint8Array): Promise<string> {
      const canonical = new TextDecoder().decode(canonicalBytes);
      const digest = await delegate.hmacSha256(purpose, canonicalBytes);
      calls.push({ purpose, canonical, digest });
      return digest;
    },
  };
}

type FailureFingerprint = { status: unknown; code: unknown; phase: unknown; retryable: unknown };

async function failureFingerprint(action: Promise<unknown>): Promise<FailureFingerprint | null> {
  try {
    await action;
    return null;
  } catch (error) {
    const candidate = error as Partial<FailureFingerprint>;
    return {
      status: candidate.status,
      code: candidate.code,
      phase: candidate.phase,
      retryable: candidate.retryable,
    };
  }
}

function unchangedSurfaceSnapshot(db: DatabaseSync, cycleId = 'cycle-a'): Record<string, unknown> {
  return {
    cycle: db.prepare(`
      SELECT id, space_id, participant_membership_id, path_revision_id,
        origin_kind, origin_attempt_id, origin_turn_number, origin_event_identity,
        origin_lookup_digest, origin_request_digest, state, aggregate_revision,
        consent_receipt_id, opened_at, updated_at, closed_at
      FROM growth_cycles WHERE id = ?1
    `).get(cycleId),
    outcome: db.prepare(`
      SELECT id, growth_cycle_id, practice_quest_id, target_horizon_hours,
        scheduled_for, variant_policy_revision, follow_up_origin_kind,
        follow_up_attempt_id, opening_observation_id, recheck_observation_id,
        evidence_event_ids_json, outcome, created_at, recorded_at
      FROM growth_rechecks WHERE growth_cycle_id = ?1 ORDER BY id
    `).all(cycleId),
    evidence: db.prepare(`
      SELECT id, growth_cycle_id, capability_id, capability_revision,
        rubric_revision_id, status, value_numeric, value_scale,
        evidence_event_ids_json, inference_rule_id, inference_rule_revision,
        inference_validation, confidence, raw_signal_json, observed_at, recorded_at
      FROM growth_capability_observations WHERE growth_cycle_id = ?1 ORDER BY id
    `).all(cycleId),
    claim: db.prepare(`
      SELECT id, growth_cycle_id, observation_id, capability_id, capability_revision,
        gap_rule_id, gap_rule_revision, statement, state, supporting_event_ids_json,
        contradicting_event_ids_json, participant_rationale, generator_revision,
        model_revision, prompt_revision, source_revision, revises_hypothesis_id,
        revision_rationale, created_at, updated_at
      FROM growth_gap_hypotheses WHERE growth_cycle_id = ?1 ORDER BY id
    `).all(cycleId),
  };
}

function insertRawRequest(
  db: DatabaseSync,
  id: string,
  cycleId: string,
  ownerUserId: string,
  digest: string,
): void {
  db.prepare(`
    INSERT INTO growth_human_review_requests (
      id, growth_cycle_id, owner_user_id, state, request_dedup_digest, created_at
    ) VALUES (?1, ?2, ?3, 'PENDING', ?4, ?5)
  `).run(id, cycleId, ownerUserId, digest, NOW);
}

function insertValidDeletionContext(db: DatabaseSync, cycleId = 'cycle-a'): void {
  const lookupDigest = 'f'.repeat(64);
  const requestDigest = 'e'.repeat(64);
  db.prepare(`
    INSERT INTO growth_deletion_receipts (
      id, idempotency_lookup_digest, request_digest, policy_revision, created_at
    ) VALUES ('delete-receipt-a', ?1, ?2, 1, ?3)
  `).run(lookupDigest, requestDigest, NOW);
  db.prepare(`
    INSERT INTO growth_deletion_context (
      growth_cycle_id, requested_by_user_id, request_id, route_action, idempotency_key,
      expected_aggregate_revision, request_digest, idempotency_lookup_digest,
      deletion_receipt_id, requested_at, reason_code, created_at
    ) VALUES (?1, 'fixture-a', 'delete-request-a', 'DELETE_GROWTH_CYCLE', 'delete-key-a',
      1, ?2, ?3, 'delete-receipt-a', ?4, 'OWNER_REQUESTED', ?4)
  `).run(cycleId, requestDigest, lookupDigest, NOW);
}

function bareCascadeCharacterization(): { directError: string; parentError: string; remaining: number } {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA recursive_triggers = OFF;
    CREATE TABLE growth_cycles (id TEXT PRIMARY KEY, owner TEXT NOT NULL);
    CREATE TABLE growth_deletion_context (growth_cycle_id TEXT PRIMARY KEY, owner TEXT NOT NULL);
    CREATE TABLE request (id TEXT PRIMARY KEY, growth_cycle_id TEXT NOT NULL, owner TEXT NOT NULL,
      FOREIGN KEY(growth_cycle_id) REFERENCES growth_cycles(id) ON DELETE CASCADE);
    CREATE TRIGGER request_delete_guard
    BEFORE DELETE ON request FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM growth_cycles WHERE id = OLD.growth_cycle_id)
      OR NOT EXISTS (
        SELECT 1 FROM growth_deletion_context
        WHERE growth_cycle_id = OLD.growth_cycle_id AND owner = OLD.owner
      )
    BEGIN SELECT RAISE(ABORT, 'REQUEST_DELETE_GUARD'); END;
  `);
  db.prepare('INSERT INTO growth_cycles VALUES (?1, ?2)').run('cycle-a', 'fixture-a');
  db.prepare('INSERT INTO growth_deletion_context VALUES (?1, ?2)').run('cycle-a', 'fixture-a');
  db.prepare('INSERT INTO request VALUES (?1, ?2, ?3)').run('request-a', 'cycle-a', 'fixture-a');
  let directError = '';
  try { db.prepare('DELETE FROM request WHERE id = ?1').run('request-a'); } catch (error) { directError = String(error); }
  let parentError = '';
  try { db.prepare('DELETE FROM growth_cycles WHERE id = ?1').run('cycle-a'); } catch (error) { parentError = String(error); }
  const remaining = (db.prepare('SELECT COUNT(*) AS count FROM request').get() as { count: number }).count;
  db.close();
  return { directError, parentError, remaining };
}

describe('Growth human-review request — causal contract', () => {
  it('reports the missing migration/service boundary as a causal RED', async () => {
    const source = REQUEST_MIGRATION_PRESENT ? migration('0065_growth_human_review_requests.sql') : '';
    const service = await import('../src/services/growth-cycle');
    expect.soft(source).toContain('CREATE TABLE growth_human_review_requests');
    expect.soft(typeof service.requestGrowthHumanReview).toBe('function');
  });

  it('characterizes direct-child rejection and parent-cascade visibility in disposable SQLite', () => {
    const result = bareCascadeCharacterization();
    expect(result.directError).toMatch(/REQUEST_DELETE_GUARD/);
    expect(result.parentError).toBe('');
    expect(result.remaining).toBe(0);
  });

  it.skipIf(!REQUEST_MIGRATION_PRESENT)('creates exactly one owner-scoped PENDING request and replays only the same key', async () => {
    const seeded = await fixtureWithSeededSurfaceFacts();
    const { db, cycleId, expectedRevision, recheckId } = seeded;
    const service = await import('../src/services/growth-cycle');
    const security = createGrowthCycleSecurity('fixture-growth-secret');
    const d1 = asD1(db);
    const before = unchangedSurfaceSnapshot(db, cycleId);
    expect(Object.keys(before.cycle as Record<string, unknown>).sort()).toEqual([
      'aggregate_revision', 'closed_at', 'consent_receipt_id', 'id', 'opened_at',
      'origin_attempt_id', 'origin_event_identity', 'origin_kind', 'origin_lookup_digest',
      'origin_request_digest', 'origin_turn_number', 'participant_membership_id',
      'path_revision_id', 'space_id', 'state', 'updated_at',
    ]);
    expect(before.cycle).toMatchObject({
      id: cycleId,
      space_id: 'space-a',
      participant_membership_id: 'growth-host:space-a',
      path_revision_id: 'growth-path:training-five-axis:en:1',
      origin_kind: 'TRAINING',
      origin_attempt_id: 'attempt-c',
      origin_turn_number: 1,
      origin_event_identity: 'event-c',
      origin_lookup_digest: 'c1'.repeat(32),
      origin_request_digest: 'c2'.repeat(32),
      state: 'RECHECK_SCHEDULED',
      aggregate_revision: expectedRevision,
      consent_receipt_id: 'consent-a',
      opened_at: NOW,
      updated_at: expect.any(Number),
      closed_at: null,
    });
    const outcomes = before.outcome as Array<Record<string, unknown>>;
    const observations = before.evidence as Array<Record<string, unknown>>;
    const hypotheses = before.claim as Array<Record<string, unknown>>;
    expect(outcomes).toHaveLength(1);
    expect(observations).toHaveLength(1);
    expect(hypotheses).toHaveLength(1);
    expect(Object.keys(outcomes[0]).sort()).toEqual([
      'created_at', 'evidence_event_ids_json', 'follow_up_attempt_id',
      'follow_up_origin_kind', 'growth_cycle_id', 'id', 'opening_observation_id',
      'outcome', 'practice_quest_id', 'recheck_observation_id', 'recorded_at',
      'scheduled_for', 'target_horizon_hours', 'variant_policy_revision',
    ]);
    expect(outcomes[0]).toMatchObject({
      id: recheckId,
      growth_cycle_id: cycleId,
      practice_quest_id: expect.any(String),
      target_horizon_hours: 168,
      variant_policy_revision: 'growth-practice-rule:training-five-axis:learner-focus:en:1:1',
      follow_up_origin_kind: 'TRAINING',
      follow_up_attempt_id: 'fixture-follow-up-a2',
      opening_observation_id: null,
      recheck_observation_id: null,
      evidence_event_ids_json: '[]',
      outcome: 'UNKNOWN',
      created_at: expect.any(Number),
      recorded_at: expect.any(Number),
    });
    expect(expectedRevision).toBe(6);
    expect(observations[0]).toEqual({
      id: SURFACE_OBSERVATION_ID,
      growth_cycle_id: cycleId,
      capability_id: SURFACE_CAPABILITY_ID,
      capability_revision: 1,
      rubric_revision_id: null,
      status: 'UNKNOWN',
      value_numeric: null,
      value_scale: null,
      evidence_event_ids_json: JSON.stringify([SURFACE_RAW_EVENT_ID]),
      inference_rule_id: SURFACE_OBSERVATION_RULE_ID,
      inference_rule_revision: 1,
      inference_validation: 'PROVISIONAL_UNCALIBRATED',
      confidence: null,
      raw_signal_json: JSON.stringify({ fixture: 'unchanged-surface' }),
      observed_at: NOW + 1,
      recorded_at: NOW + 1,
    });
    expect(hypotheses[0]).toEqual({
      id: SURFACE_HYPOTHESIS_ID,
      growth_cycle_id: cycleId,
      observation_id: SURFACE_OBSERVATION_ID,
      capability_id: SURFACE_CAPABILITY_ID,
      capability_revision: 1,
      gap_rule_id: SURFACE_GAP_RULE_ID,
      gap_rule_revision: 1,
      statement: 'Fixture hypothesis for unchanged-surface control',
      state: 'UNKNOWN',
      supporting_event_ids_json: '[]',
      contradicting_event_ids_json: '[]',
      participant_rationale: null,
      generator_revision: 'fixture-test',
      model_revision: 'fixture-test',
      prompt_revision: 'fixture-test',
      source_revision: 'fixture-test',
      revises_hypothesis_id: null,
      revision_rationale: null,
      created_at: NOW + 2,
      updated_at: NOW + 2,
    });
    const sensitivityFixture = await fixtureWithSeededSurfaceFacts();
    try {
      const sensitivityBefore = unchangedSurfaceSnapshot(sensitivityFixture.db, sensitivityFixture.cycleId);
      const sensitivityBeforeOutcome = (sensitivityBefore.outcome as Array<Record<string, unknown>>)[0];
      const scheduledForBefore = sensitivityBeforeOutcome.scheduled_for as number;
      const scheduledForAfter = scheduledForBefore + 1;
      sensitivityFixture.db.prepare(`
        UPDATE growth_rechecks
        SET scheduled_for = ?1
        WHERE id = ?2 AND growth_cycle_id = ?3
      `).run(scheduledForAfter, sensitivityFixture.recheckId, sensitivityFixture.cycleId);
      expect(sensitivityFixture.db.prepare(`
        SELECT id, growth_cycle_id, scheduled_for
        FROM growth_rechecks
        WHERE id = ?1 AND growth_cycle_id = ?2
      `).get(sensitivityFixture.recheckId, sensitivityFixture.cycleId)).toEqual({
        id: sensitivityFixture.recheckId,
        growth_cycle_id: sensitivityFixture.cycleId,
        scheduled_for: scheduledForAfter,
      });
      const sensitivityAfter = unchangedSurfaceSnapshot(sensitivityFixture.db, sensitivityFixture.cycleId);
      expect(sensitivityAfter).toEqual({
        ...sensitivityBefore,
        outcome: [{ ...sensitivityBeforeOutcome, scheduled_for: scheduledForAfter }],
      });
      expect(sensitivityAfter).not.toEqual(sensitivityBefore);
    } finally {
      sensitivityFixture.db.close();
    }

    const result = await service.requestGrowthHumanReview(
      d1, security, 'fixture-a', 'space-a', cycleId, expectedRevision, 'same-key-a',
    );
    expect(result).toMatchObject({ cycleId, state: 'PENDING' });
    expect(Object.keys(result).sort()).toEqual(['createdAt', 'cycleId', 'id', 'state']);
    const row = db.prepare('SELECT * FROM growth_human_review_requests WHERE id = ?1').get(result.id) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['created_at', 'growth_cycle_id', 'id', 'owner_user_id', 'request_dedup_digest', 'state']);
    expect(row.state).toBe('PENDING');
    expect(String(row.request_dedup_digest)).toMatch(/^[a-f0-9]{64}$/);
    expect(String(row.request_dedup_digest)).not.toContain('same-key-a');
    expect(unchangedSurfaceSnapshot(db, cycleId)).toEqual(before);
    const replay = await service.requestGrowthHumanReview(
      d1, security, 'fixture-a', 'space-a', cycleId, expectedRevision, 'same-key-a',
    );
    expect(replay).toEqual(result);
    expect(unchangedSurfaceSnapshot(db, cycleId)).toEqual(before);
    expect((db.prepare('SELECT COUNT(*) AS count FROM growth_human_review_requests').get() as { count: number }).count).toBe(1);
    db.close();
  });

  it.skipIf(!REQUEST_MIGRATION_PRESENT)('revalidates owner and consent before an existing-row replay return', async () => {
    const db = fixture();
    const service = await import('../src/services/growth-cycle');
    const security = createGrowthCycleSecurity('fixture-growth-secret');
    const firstD1 = asD1(db);
    await service.requestGrowthHumanReview(firstD1, security, 'fixture-a', 'space-a', 'cycle-a', 1, 'revocation-replay-key');
    let interleavingApplied = false;
    const replayD1 = asD1(db, {
      afterHumanReviewLookup: () => {
        if (!interleavingApplied) {
          interleavingApplied = true;
          db.prepare('UPDATE growth_private_consent_receipts SET revoked_at = ?1 WHERE id = ?2').run(NOW + 1, 'consent-a');
        }
      },
    });
    await expect(service.requestGrowthHumanReview(
      replayD1, security, 'fixture-a', 'space-a', 'cycle-a', 1, 'revocation-replay-key',
    )).rejects.toMatchObject({ status: 404, code: 'GROWTH_RESOURCE_NOT_FOUND' });
    expect(interleavingApplied).toBe(true);
    db.close();
  });

  it.skipIf(!REQUEST_MIGRATION_PRESENT)('revalidates owner and consent before a concurrent-winner replay return', async () => {
    const db = fixture();
    const service = await import('../src/services/growth-cycle');
    const security = createGrowthCycleSecurity('fixture-growth-secret');
    let interleavingApplied = false;
    const racedD1 = asConcurrentWinnerD1(db, () => {
      interleavingApplied = true;
      db.prepare('UPDATE growth_private_consent_receipts SET revoked_at = ?1 WHERE id = ?2').run(NOW + 1, 'consent-a');
    });
    await expect(service.requestGrowthHumanReview(
      racedD1, security, 'fixture-a', 'space-a', 'cycle-a', 1, 'concurrent-replay-key',
    )).rejects.toMatchObject({ status: 404, code: 'GROWTH_RESOURCE_NOT_FOUND' });
    expect(interleavingApplied).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS count FROM growth_human_review_requests').get() as { count: number }).count).toBe(1);
    db.close();
  });

  it.skipIf(!REQUEST_MIGRATION_PRESENT)('records the exact domain-separated HMAC tuple and field-sensitive digests', async () => {
    const service = await import('../src/services/growth-cycle');
    const purpose = 'growth-human-review-request:dedup:v1';
    const calls: RecordedHmacCall[] = [];
    const db = fixture();
    await service.requestGrowthHumanReview(
      asD1(db), recordingSecurity('fixture-growth-secret', calls),
      'fixture-a', 'space-a', 'cycle-a', 1, 'hmac-baseline-key',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].purpose).toBe(purpose);
    expect(calls[0].canonical).toBe(JSON.stringify({
      cycleId: 'cycle-a',
      expectedRevision: 1,
      idempotencyKey: 'hmac-baseline-key',
      ownerUserId: 'fixture-a',
      routeAction: 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/human-review-requests',
      spaceId: 'space-a',
    }));
    const digests = [calls[0].digest];

    const variants = [
      ['fixture-a', 'space-a', 'cycle-a', 1, 'hmac-key-variant'],
      ['fixture-a', 'space-a', 'cycle-a2', 1, 'hmac-baseline-key'],
      ['fixture-b', 'space-b', 'cycle-b', 1, 'hmac-baseline-key'],
    ] as const;
    for (const [owner, space, cycle, revision, key] of variants) {
      const variantDb = fixture();
      const variantCalls: RecordedHmacCall[] = [];
      await service.requestGrowthHumanReview(
        asD1(variantDb), recordingSecurity('fixture-growth-secret', variantCalls),
        owner, space, cycle, revision, key,
      );
      expect(variantCalls).toHaveLength(1);
      expect(variantCalls[0].purpose).toBe(purpose);
      digests.push(variantCalls[0].digest);
      variantDb.close();
    }

    const revisionDb = fixture();
    const revisionCalls: RecordedHmacCall[] = [];
    await service.requestGrowthHumanReview(
      asCycleRevisionOverrideD1(revisionDb, 2), recordingSecurity('fixture-growth-secret', revisionCalls),
      'fixture-a', 'space-a', 'cycle-a', 2, 'hmac-baseline-key',
    );
    expect(revisionCalls).toHaveLength(1);
    expect(JSON.parse(revisionCalls[0].canonical)).toMatchObject({ expectedRevision: 2 });
    digests.push(revisionCalls[0].digest);
    expect(new Set(digests).size).toBe(digests.length);
    revisionDb.close();
    db.close();
  });

  it.skipIf(!REQUEST_MIGRATION_PRESENT)('fails closed before lookup for foreign, cross-space, stale, revoked, and deleted targets', async () => {
    const service = await import('../src/services/growth-cycle');
    const security = createGrowthCycleSecurity('fixture-growth-secret');
    const db = fixture();
    const d1 = asD1(db);
    const request = (owner: string, space: string, cycle: string, revision = 1, key = 'foreign-key') => (
      service.requestGrowthHumanReview(d1, security, owner, space, cycle, revision, key)
    );
    await request('fixture-a', 'space-a', 'cycle-a', 1, 'owner-seeded-key');
    const foreignSameKey = await failureFingerprint(request('fixture-b', 'space-a', 'cycle-a', 1, 'owner-seeded-key'));
    const foreignDifferentKey = await failureFingerprint(request('fixture-b', 'space-a', 'cycle-a', 1, 'foreign-different-key'));
    const absentTarget = await failureFingerprint(request('fixture-a', 'space-a', 'missing-cycle', 1, 'owner-seeded-key'));
    expect(foreignSameKey).toEqual({ status: 404, code: 'GROWTH_RESOURCE_NOT_FOUND', phase: 'authorization', retryable: false });
    expect(foreignDifferentKey).toEqual(foreignSameKey);
    expect(absentTarget).toEqual(foreignSameKey);
    await expect(request('fixture-a', 'space-a', 'cycle-b'))
      .rejects.toMatchObject({ status: 404, code: 'GROWTH_RESOURCE_NOT_FOUND' });
    await expect(request('fixture-a', 'space-a', 'cycle-a', 2, 'stale-key'))
      .rejects.toMatchObject({ status: 409, code: 'GROWTH_REVISION_CONFLICT' });
    db.prepare('UPDATE growth_private_consent_receipts SET revoked_at = ?1 WHERE id = ?2').run(NOW + 1, 'consent-a');
    await expect(request('fixture-a', 'space-a', 'cycle-a', 1, 'revoked-key')).rejects.toMatchObject({ status: 404, code: 'GROWTH_RESOURCE_NOT_FOUND' });
    db.close();

    const deletedDb = fixture();
    insertValidDeletionContext(deletedDb);
    deletedDb.prepare("DELETE FROM growth_cycles WHERE id = 'cycle-a'").run();
    const deletedD1 = asD1(deletedDb);
    await expect(service.requestGrowthHumanReview(deletedD1, security, 'fixture-a', 'space-a', 'cycle-a', 1, 'deleted-key'))
      .rejects.toMatchObject({ status: 404, code: 'GROWTH_RESOURCE_NOT_FOUND' });
    deletedDb.close();
  });

  it.skipIf(!REQUEST_MIGRATION_PRESENT)('rejects a different key or changed input without changing the cycle', async () => {
    const db = fixture();
    const service = await import('../src/services/growth-cycle');
    const d1 = asD1(db);
    const security = createGrowthCycleSecurity('fixture-growth-secret');
    const first = await service.requestGrowthHumanReview(d1, security, 'fixture-a', 'space-a', 'cycle-a', 1, 'first-key');
    await expect(service.requestGrowthHumanReview(d1, security, 'fixture-a', 'space-a', 'cycle-a', 1, 'second-key'))
      .rejects.toMatchObject({ status: 409, phase: 'conflict' });
    await expect(service.requestGrowthHumanReview(d1, security, 'fixture-a', 'space-a', 'cycle-a', 2, 'first-key'))
      .rejects.toMatchObject({ status: 409 });
    expect((db.prepare('SELECT COUNT(*) AS count FROM growth_human_review_requests').get() as { count: number }).count).toBe(1);
    expect(db.prepare('SELECT id, state, aggregate_revision FROM growth_cycles WHERE id = ?1').get('cycle-a')).toEqual({
      id: 'cycle-a', state: 'EVIDENCE_PENDING', aggregate_revision: 1,
    });
    expect(first.state).toBe('PENDING');
    db.close();
  });

  it.skipIf(!REQUEST_MIGRATION_PRESENT)('rejects INSERT OR REPLACE collisions, updates, direct deletes, and unsupported fields', () => {
    const make = () => fixture();
    {
      const db = make();
      insertRawRequest(db, 'request-a', 'cycle-a', 'fixture-a', 'a'.repeat(64));
      expect(() => db.prepare(`INSERT OR REPLACE INTO growth_human_review_requests
        (id, growth_cycle_id, owner_user_id, state, request_dedup_digest, created_at)
        VALUES ('request-a', 'cycle-a2', 'fixture-a', 'PENDING', ?1, ?2)`).run('b'.repeat(64), NOW + 1))
        .toThrow(/GROWTH_HUMAN_REVIEW_REQUEST_ALREADY_EXISTS/);
      expect((db.prepare('SELECT COUNT(*) AS count FROM growth_human_review_requests').get() as { count: number }).count).toBe(1);
      db.close();
    }
    {
      const db = make();
      insertRawRequest(db, 'request-a', 'cycle-a', 'fixture-a', 'a'.repeat(64));
      expect(() => db.prepare(`INSERT OR REPLACE INTO growth_human_review_requests
        (id, growth_cycle_id, owner_user_id, state, request_dedup_digest, created_at)
        VALUES ('request-b', 'cycle-a', 'fixture-a', 'PENDING', ?1, ?2)`).run('b'.repeat(64), NOW + 1))
        .toThrow(/GROWTH_HUMAN_REVIEW_REQUEST_ALREADY_EXISTS/);
      db.close();
    }
    {
      const db = make();
      insertRawRequest(db, 'request-a', 'cycle-a', 'fixture-a', 'a'.repeat(64));
      expect(() => db.prepare(`INSERT OR REPLACE INTO growth_human_review_requests
        (id, growth_cycle_id, owner_user_id, state, request_dedup_digest, created_at)
        VALUES ('request-b', 'cycle-a2', 'fixture-a', 'PENDING', ?1, ?2)`).run('a'.repeat(64), NOW + 1))
        .toThrow(/GROWTH_HUMAN_REVIEW_REQUEST_ALREADY_EXISTS/);
      db.close();
    }
    {
      const db = make();
      insertRawRequest(db, 'request-a', 'cycle-a', 'fixture-a', 'a'.repeat(64));
      expect(() => db.prepare("UPDATE growth_human_review_requests SET state = 'PENDING' WHERE id = 'request-a'").run())
        .toThrow(/GROWTH_HUMAN_REVIEW_REQUEST_IMMUTABLE/);
      expect(() => db.prepare("DELETE FROM growth_human_review_requests WHERE id = 'request-a'").run())
        .toThrow(/GROWTH_HUMAN_REVIEW_REQUEST_IMMUTABLE/);
      expect(() => db.prepare(`INSERT INTO growth_human_review_requests
        (id, growth_cycle_id, owner_user_id, state, request_dedup_digest, created_at, reviewer_id)
        VALUES ('request-b', 'cycle-a2', 'fixture-a', 'PENDING', ?1, ?2, 'reviewer')`).run('b'.repeat(64), NOW + 1))
        .toThrow(/no column named reviewer_id/);
      insertValidDeletionContext(db);
      expect(() => db.prepare("DELETE FROM growth_human_review_requests WHERE id = 'request-a'").run())
        .toThrow(/GROWTH_HUMAN_REVIEW_REQUEST_IMMUTABLE/);
      db.close();
    }
  });

  it.skipIf(!REQUEST_MIGRATION_PRESENT)('rejects learner plaintext across the request, response, row, and SQL trace boundaries', async () => {
    const db = fixture();
    const service = await import('../src/services/growth-cycle');
    const trace: SqlTraceEntry[] = [];
    const d1 = asD1(db, { trace });
    const plaintextCanary = 'learner-rationale-reviewer-verdict-schedule-completion-plaintext';
    const result = await service.requestGrowthHumanReview(
      d1, createGrowthCycleSecurity('fixture-growth-secret'),
      'fixture-a', 'space-a', 'cycle-a', 1, plaintextCanary,
    );
    const row = db.prepare('SELECT * FROM growth_human_review_requests WHERE id = ?1').get(result.id) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['createdAt', 'cycleId', 'id', 'state']);
    expect(Object.keys(row).sort()).toEqual(['created_at', 'growth_cycle_id', 'id', 'owner_user_id', 'request_dedup_digest', 'state']);
    expect(JSON.stringify({ result, row, trace })).not.toContain(plaintextCanary);
    expect(trace.some((entry) => entry.values.some((value) => value === plaintextCanary))).toBe(false);

    const serviceSource = migration('0065_growth_human_review_requests.sql');
    const routeSource = readFileSync('src/routes/growth.ts', 'utf8');
    const serviceFile = readFileSync('src/services/growth-cycle.ts', 'utf8');
    const uiSource = readFileSync('public/static/modules/growth-lab.js', 'utf8');
    const serviceFunction = serviceFile.slice(
      serviceFile.indexOf('export async function requestGrowthHumanReview'),
      serviceFile.indexOf('async function lifecyclePlan'),
    );
    const routeFunction = routeSource.slice(
      routeSource.indexOf("growthRoute.post('/api/growth/spaces/:spaceId/cycles/:cycleId/human-review-requests'"),
      routeSource.indexOf("growthRoute.delete('/api/growth/spaces/:spaceId/cycles/:cycleId'"),
    );
    const uiFunction = uiSource.slice(
      uiSource.indexOf('function requestHumanReview'),
      uiSource.indexOf('async function deleteCycle'),
    );
    for (const surface of [serviceSource, serviceFunction, routeFunction, uiFunction]) {
      expect(surface).not.toMatch(/learner[_ -]?text|free[_ -]?text|reviewer|verdict|rationale|schedule|completion/i);
      expect(surface).not.toMatch(/console\.|logger\.|\blog\s*\(/i);
    }
    expect(routeFunction).toContain("jsonObject(c, ['expectedRevision'])");
    db.close();
  });

  it.skipIf(!REQUEST_MIGRATION_PRESENT)('cascades the request only through a governed owner-cycle delete and leaves no residue', () => {
    const db = fixture();
    insertRawRequest(db, 'request-a', 'cycle-a', 'fixture-a', 'a'.repeat(64));
    insertValidDeletionContext(db);
    expect(() => db.prepare("DELETE FROM growth_human_review_requests WHERE id = 'request-a'").run())
      .toThrow(/GROWTH_HUMAN_REVIEW_REQUEST_IMMUTABLE/);
    db.prepare("DELETE FROM growth_cycles WHERE id = 'cycle-a'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM growth_human_review_requests WHERE growth_cycle_id = 'cycle-a'").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM growth_deletion_context WHERE growth_cycle_id = 'cycle-a'").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM growth_cycles WHERE id = 'cycle-a'").get()).toEqual({ count: 0 });
    db.close();
  });
});
