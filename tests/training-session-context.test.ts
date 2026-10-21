import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/types';

const seams = vi.hoisted(() => ({
  authUserId: 'fixture-a',
  callAIJSONWithEnv: vi.fn(),
  createAIRouter: vi.fn(),
  processStudentTurn: vi.fn(),
}));

vi.mock('../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: async (_context: unknown, next: () => Promise<void>) => next(),
    getAuthUser: () => ({ userId: seams.authUserId, role: 'student' }),
    canAccessOwnerResource: (owner: string | null | undefined, requester: string | null) => (
      Boolean(owner && requester && owner === requester)
    ),
  };
});

vi.mock('../src/middleware/usage-limit', () => ({
  checkUsageLimit: async (_context: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../src/services/ai-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ai-client')>();
  return { ...actual, callAIJSONWithEnv: seams.callAIJSONWithEnv };
});

vi.mock('../src/services/ai-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ai-router')>();
  return { ...actual, createAIRouter: seams.createAIRouter };
});

vi.mock('../src/services/tutoring/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/tutoring/orchestrator')>();
  return { ...actual, processStudentTurn: seams.processStudentTurn };
});

const { buildEvidenceGroundedTrainingScenario, loadTrainingScenarioEvidenceContext } = await import('../src/services/training/scenario-evidence');
const { default: trainingRoute, respondTrainingSession, startTrainingSession, TrainingOperationError } = await import('../src/routes/training');

const MANIFEST = 'a'.repeat(64);
const ROUTES = Object.freeze({
  interactive_generation: Object.freeze(['ssu-luna'] as const),
  learner_evaluation: Object.freeze(['deepseek-v4-pro'] as const),
  release_critic: Object.freeze(['deepseek-v4-flash'] as const),
  background_reasoning: Object.freeze(['deepseek-v4-pro'] as const),
});

function migration(name: string): string {
  return readFileSync(`migrations/${name}`, 'utf8');
}

function openCurrentSchema(): DatabaseSync {
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
      difficulty TEXT NOT NULL DEFAULT 'intermediate',
      question TEXT NOT NULL DEFAULT 'fixture', question_title TEXT NOT NULL DEFAULT 'fixture',
      context TEXT NOT NULL DEFAULT '', expected_tensions TEXT NOT NULL DEFAULT '[]',
      session_goal TEXT NOT NULL DEFAULT '', tutor_state TEXT NOT NULL DEFAULT 'elicitation',
      student_model TEXT NOT NULL DEFAULT '{}', current_turn INTEGER NOT NULL DEFAULT 1,
      max_turns INTEGER NOT NULL DEFAULT 8, created_at INTEGER NOT NULL DEFAULT 1700000000000,
      updated_at INTEGER NOT NULL DEFAULT 1700000000000
    );
    CREATE TABLE category_hierarchy (id TEXT PRIMARY KEY, is_active INTEGER NOT NULL);
    CREATE TABLE books (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL,
      lifecycle_status TEXT, is_builtin INTEGER NOT NULL, visibility TEXT NOT NULL,
      owner_user_id TEXT
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
  return db;
}

function apply0064(db: DatabaseSync): void {
  db.exec(migration('0064_training_session_context.sql'));
}

function seedTraining(db: DatabaseSync, options: {
  sessionId?: string; owner?: string; mode?: 'scenario' | 'discussion';
  manifest?: string; withPack?: boolean;
} = {}): void {
  const sessionId = options.sessionId ?? 'training-a';
  const owner = options.owner ?? 'fixture-a';
  const mode = options.mode ?? 'scenario';
  const manifest = options.manifest ?? MANIFEST;
  db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?1)').run(owner);
  db.prepare('INSERT INTO training_sessions (id, user_id, training_mode) VALUES (?1, ?2, ?3)')
    .run(sessionId, owner, mode);
  if (options.withPack === false) return;
  db.prepare(`
    INSERT INTO training_scenario_packs (
      session_id, mode, evidence_query, evidence_status,
      evidence_manifest_sha256, source_count, book_count,
      scenario_json, rubric_json, created_at
    ) VALUES (?1, 'scenario', 'policy evidence', 'ready', ?2, 3, 2, '{}', '[]', 1700000000000)
  `).run(sessionId, manifest);
  const insertEvidence = db.prepare(`
    INSERT INTO training_scenario_evidence (
      id, session_id, source_id, selection_index, book_id, chunk_id,
      book_title, book_author, chunk_index, excerpt, content_sha256,
      relevance_score, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Fixture Author', ?8, ?9, ?10, 1, 1700000000000)
  `);
  insertEvidence.run('evidence-a1', sessionId, 'source-a1', 0, 'book-a', 'chunk-a1', 'Book A', 0, 'policy evidence alpha', '1'.repeat(64));
  insertEvidence.run('evidence-a2', sessionId, 'source-a2', 1, 'book-a', 'chunk-a2', 'Book A', 1, 'policy evidence beta', '2'.repeat(64));
  insertEvidence.run('evidence-b1', sessionId, 'source-b1', 2, 'book-b', 'chunk-b1', 'Book B', 0, 'policy evidence gamma', '3'.repeat(64));
}

function insertContext(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const value = {
    id: 'trctx_fixture', sessionId: 'training-a', owner: 'fixture-a', manifest: MANIFEST,
    routes: JSON.stringify(ROUTES), cache: 'training:training-a', policy: 'critical-path-b-v1',
    status: 'ACTIVE', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO training_session_contexts (
      id, session_id, owner_user_id, evidence_manifest_sha256,
      route_plan_json, prompt_cache_namespace, evidence_policy_revision,
      status, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  `).run(
    value.id as string, value.sessionId as string, value.owner as string,
    value.manifest as string, value.routes as string, value.cache as string,
    value.policy as string, value.status as string, value.createdAt as number,
    value.updatedAt as number,
  );
}

function insertSparringContextWithTrainingIdentity(db: DatabaseSync): void {
  db.prepare(`INSERT INTO sessions (id, user_id) VALUES ('training-a', 'fixture-a')`).run();
  db.prepare(`
    INSERT INTO sparring_evidence_manifests (
      id, session_id, turn_number, user_id, book_id, query_text,
      manifest_sha256, source_count, created_at
    ) VALUES (
      'sparring-manifest-a', 'training-a', 0, 'fixture-a', 'book-a',
      'fixture query', ?1, 1, 1700000000000
    )
  `).run(MANIFEST);
  db.prepare(`
    INSERT INTO learning_session_contexts (
      id, session_kind, session_id, owner_user_id, context_kind, subject_id,
      authority_capabilities_json, context_policy_revision, corpus_binding_id,
      corpus_manifest_revision, route_plan_json, prompt_cache_namespace,
      evidence_policy_revision, status, created_at, updated_at
    ) VALUES (
      'trctx_fixture', 'SPARRING', 'training-a', 'fixture-a', 'GROWTH_LAB', 'subject-a',
      '[]', 'fixture-context-policy-v1', 'book:book-a', ?1, ?2,
      'training:training-a', 'critical-path-b-v1', 'ACTIVE',
      1700000000000, 1700000000000
    )
  `).run(MANIFEST, JSON.stringify(ROUTES));
}

function insertAttempt(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const value = {
    id: 'attempt-a', invocationId: 'invocation-a', lane: 'interactive_generation',
    routeId: 'ssu-luna', contextId: 'trctx_fixture', sessionId: 'training-a',
    turnNumber: 1, cache: 'training:training-a', ...overrides,
  };
  db.prepare(`
    INSERT INTO ai_invocation_attempts (
      id, invocation_id, invocation_kind, lane, route_id, provider, model,
      credential_alias, attempt_index, started_at, completed_at, latency_ms,
      outcome, failure_class, retryable, prompt_schema_version, prompt_version,
      prompt_sha256, response_sha256, prompt_tokens, completion_tokens,
      total_tokens, created_at, session_context_id, session_id, turn_number,
      prompt_cache_namespace
    ) VALUES (
      ?1, ?2, 'route', ?3, ?4, 'fixture-provider', 'fixture-model',
      'fixture-alias', 1, 1700000000000, 1700000000001, 1,
      'success', NULL, 0, 'fixture-schema-v1', 'fixture-prompt-v1',
      ?5, ?6, 1, 1, 2, 1700000000001, ?7, ?8, ?9, ?10
    )
  `).run(
    value.id as string, value.invocationId as string, value.lane as string,
    value.routeId as string, '4'.repeat(64), '5'.repeat(64),
    value.contextId as string | null, value.sessionId as string | null,
    value.turnNumber as number | null, value.cache as string | null,
  );
}

function asD1Database(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...next: unknown[]) { values = next as SQLInputValue[]; return statement; },
        async run() { sqlite.prepare(sql).run(...values); return {}; },
        async first<T>() { return (sqlite.prepare(sql).get(...values) ?? null) as T | null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[] }; },
      };
      return statement;
    },
  } as unknown as D1Database;
}

interface SqliteD1Statement {
  readonly sql: string;
  bind(...values: unknown[]): SqliteD1Statement;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  executeBatch(): Promise<unknown>;
}

function transactionalD1(sqlite: DatabaseSync): { db: D1Database; trace: string[] } {
  const trace: string[] = [];
  function prepare(sql: string): SqliteD1Statement {
    let values: SQLInputValue[] = [];
    const statement: SqliteD1Statement = {
      sql,
      bind(...next: unknown[]) { values = next as SQLInputValue[]; return statement; },
      async run() { trace.push(sql); return sqlite.prepare(sql).run(...values); },
      async first<T>() { return (sqlite.prepare(sql).get(...values) ?? null) as T | null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[] }; },
      async executeBatch() {
        trace.push(sql);
        return /^\s*(?:SELECT|WITH)\b/i.test(sql)
          ? { results: sqlite.prepare(sql).all(...values) }
          : sqlite.prepare(sql).run(...values);
      },
    };
    return statement;
  }
  return {
    trace,
    db: {
      prepare,
      async batch(statements: D1PreparedStatement[]) {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const results: unknown[] = [];
          for (const statement of statements as unknown as SqliteD1Statement[]) {
            results.push(await statement.executeBatch());
          }
          sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    } as unknown as D1Database,
  };
}

function openStartSchema(): DatabaseSync {
  const sqlite = openCurrentSchema();
  apply0064(sqlite);
  sqlite.exec(migration('0079_training_case_contract.sql'));
  sqlite.exec(`
    INSERT INTO users (id) VALUES ('fixture-a');
    INSERT INTO category_hierarchy (id, is_active) VALUES ('policy', 1);
    INSERT INTO books VALUES
      ('book-a', 'Book A', 'Fixture Author', 'active', 1, 'builtin', NULL),
      ('book-b', 'Book B', 'Fixture Author', 'active', 1, 'builtin', NULL);
    INSERT INTO document_chunks VALUES
      ('chunk-a1', 'book-a', 0, 0, 21, 'policy evidence alpha'),
      ('chunk-a2', 'book-a', 1, 0, 20, 'policy evidence beta'),
      ('chunk-b1', 'book-b', 0, 0, 21, 'policy evidence gamma');
  `);
  return sqlite;
}

function legacyScenarioFixture() {
  return {
    title: 'Evidence policy choice', role: 'Policy analyst',
    context: 'Compare the supplied evidence.', decision_question: 'Which policy is best supported?',
    constraints: ['Use supplied evidence', 'Compare alternatives'],
    stakeholders: ['Learners', 'Teachers'], tradeoffs: ['Speed versus depth', 'Cost versus reach'],
    expected_tensions: ['Equity versus efficiency', 'Evidence versus uncertainty'],
    session_goal: 'Reach a cited judgment',
    evidence_source_ids: ['library:book-a:chunk-a1', 'library:book-b:chunk-b1'],
    rubric: [
      { id: 'claim', label: 'Claim', description: 'State a claim.', weight: 0.34 },
      { id: 'evidence', label: 'Evidence', description: 'Use evidence.', weight: 0.33 },
      { id: 'tradeoff', label: 'Tradeoff', description: 'Compare tradeoffs.', weight: 0.33 },
    ],
  };
}

function validContextInput() {
  return {
    sessionId: 'training-a', ownerUserId: 'fixture-a', evidenceManifestSha256: MANIFEST,
    routes: ROUTES, promptCacheNamespace: 'training:training-a',
    evidencePolicyRevision: 'critical-path-b-v1', createdAt: 1_700_000_000_000,
  };
}

function libraryDatabase(): D1Database {
  const rows = [
    { chunk_id: 'chunk-a1', book_id: 'book-a', chunk_index: 0, char_start: 0, char_end: 21, content: 'policy evidence alpha', book_title: 'Book A', book_author: 'Author A', lifecycle_status: 'active' },
    { chunk_id: 'chunk-a2', book_id: 'book-a', chunk_index: 1, char_start: 0, char_end: 20, content: 'policy evidence beta', book_title: 'Book A', book_author: 'Author A', lifecycle_status: 'active' },
    { chunk_id: 'chunk-b1', book_id: 'book-b', chunk_index: 0, char_start: 0, char_end: 21, content: 'policy evidence gamma', book_title: 'Book B', book_author: 'Author B', lifecycle_status: 'active' },
  ];
  return {
    prepare() {
      let bookId = '';
      const statement = {
        bind(nextBookId: string) { bookId = nextBookId; return statement; },
        __rows() { return rows.filter((row) => row.book_id === bookId); },
      };
      return statement;
    },
    async batch(statements: Array<{ __rows(): unknown[] }>) {
      return statements.map((statement) => ({ results: statement.__rows() }));
    },
  } as unknown as D1Database;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hintDatabase(): Promise<{ db: D1Database; statements: string[] }> {
  const statements: string[] = [];
  const evidenceQuery = 'policy evidence';
  const excerpts = ['policy evidence alpha', 'policy evidence beta', 'policy evidence gamma'];
  const rows = await Promise.all(excerpts.map(async (excerpt, index) => ({
    source_id: index < 2 ? `library:book-a:chunk-a${index + 1}` : 'library:book-b:chunk-b1',
    selection_index: index,
    book_id: index < 2 ? 'book-a' : 'book-b',
    chunk_id: index < 2 ? `chunk-a${index + 1}` : 'chunk-b1',
    book_title: index < 2 ? 'Book A' : 'Book B',
    book_author: 'Fixture Author',
    chunk_index: index < 2 ? index : 0,
    char_start: 0,
    char_end: excerpt.length,
    excerpt,
    content_sha256: await sha256Hex(excerpt),
    relevance_score: 1,
    lifecycle_status: 'active',
    book_lifecycle_status: 'active',
    book_visibility: 'builtin',
  })));
  const manifest = await sha256Hex(JSON.stringify({
    query: evidenceQuery,
    sources: rows.map((row) => ({
      sourceId: row.source_id,
      selectionIndex: row.selection_index,
      bookId: row.book_id,
      bookTitle: row.book_title,
      bookAuthor: row.book_author,
      chunkId: row.chunk_id,
      chunkIndex: row.chunk_index,
      contentSha256: row.content_sha256,
      relevanceScore: row.relevance_score,
    })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
  }));
  const rubric = [
    { id: 'claim', label: 'Claim', description: 'State a defensible claim.', weight: 0.34 },
    { id: 'evidence', label: 'Evidence', description: 'Use the supplied evidence.', weight: 0.33 },
    { id: 'tradeoff', label: 'Tradeoff', description: 'Address the main tradeoff.', weight: 0.33 },
  ];
  const scenario = {
    title: 'Evidence fixture', role: 'Policy analyst', context: 'Choose a defensible policy.',
    decisionQuestion: 'Which option is best supported?', constraints: ['Limited time', 'Limited budget'],
    stakeholders: ['Learners', 'Teachers'], tradeoffs: ['Speed versus depth', 'Cost versus reach'],
    expectedTensions: ['Equity versus efficiency', 'Evidence versus uncertainty'],
    sessionGoal: 'Build a cited recommendation', evidenceSourceIds: rows.map((row) => row.source_id), rubric,
  };
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      const statement = {
        bind() { return statement; },
        async first<T>() {
          if (sql.includes('LEFT JOIN training_scenario_packs')) {
            return {
              training_mode: 'scenario', pack_session_id: 'training-a',
              evidence_query: evidenceQuery, evidence_status: 'ready',
              evidence_manifest_sha256: manifest, source_count: 3, book_count: 2,
              scenario_json: JSON.stringify(scenario), rubric_json: JSON.stringify(rubric),
            } as T;
          }
          if (sql.includes('FROM training_session_contexts')) {
            return {
              id: 'trctx_fixture', session_id: 'training-a', owner_user_id: 'fixture-a',
              evidence_manifest_sha256: manifest, route_plan_json: JSON.stringify(ROUTES),
              prompt_cache_namespace: 'training:training-a', evidence_policy_revision: 'critical-path-b-v1',
              status: 'ACTIVE', created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
            } as T;
          }
          if (sql.includes('FROM training_sessions')) {
            return {
              id: 'training-a', user_id: 'fixture-a', training_mode: 'scenario',
              category: 'policy', difficulty: 'intermediate', question: 'Fixture question',
              context: 'Fixture context', student_model: '{}',
            } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          return { results: sql.includes('FROM training_scenario_evidence') ? rows as T[] : [] as T[] };
        },
        async run() { return {}; },
      };
      return statement;
    },
    async batch() { return []; },
  } as unknown as D1Database;
  return { db, statements };
}

beforeEach(() => {
  seams.callAIJSONWithEnv.mockReset();
  seams.createAIRouter.mockReset();
  seams.processStudentTurn.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('Critical Path B Training-native session context', () => {
  it('provides the additive 0064 migration and closed Training context seams', async () => {
    const sql = migration('0064_training_session_context.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS training_session_contexts');
    const service = await import('../src/services/training/training-session-context');
    expect(typeof service.prepareTrainingSessionContext).toBe('function');
    expect(typeof service.loadOwnedTrainingSessionContext).toBe('function');
  });

  it('proves 0063 has no Training context and rejects a Training-scoped attempt', () => {
    const db = openCurrentSchema();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'training_session_contexts'`).get()).toEqual({ count: 0 });
    expect(() => insertAttempt(db)).toThrow(/AI_INVOCATION_ATTEMPT_CONTEXT_LINK_INVALID/);
  });

  it.each([
    ['wrong owner', { owner: 'fixture-b' }],
    ['changed manifest', { manifest: 'b'.repeat(64) }],
    ['mismatched session', { sessionId: 'training-missing' }],
  ])('rejects %s context linkage', (_label, overrides) => {
    const db = openCurrentSchema(); apply0064(db); seedTraining(db);
    db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?1)').run('fixture-b');
    expect(() => insertContext(db, overrides)).toThrow(/TRAINING_SESSION_CONTEXT_/);
  });

  it('rejects non-evidence and missing-pack contexts while accepting the exact ready pack', () => {
    const accepted = openCurrentSchema(); apply0064(accepted); seedTraining(accepted);
    expect(() => insertContext(accepted)).not.toThrow();
    const nonEvidence = openCurrentSchema(); apply0064(nonEvidence); seedTraining(nonEvidence, { mode: 'discussion' });
    expect(() => insertContext(nonEvidence)).toThrow(/TRAINING_SESSION_CONTEXT_/);
    const missingPack = openCurrentSchema(); apply0064(missingPack); seedTraining(missingPack, { withPack: false });
    expect(() => insertContext(missingPack)).toThrow(/TRAINING_SESSION_CONTEXT_/);
  });

  it('blocks duplicate, replace, update, and ungoverned delete but permits governed deletion', () => {
    const db = openCurrentSchema(); apply0064(db); seedTraining(db); insertContext(db); insertAttempt(db);
    expect(() => insertContext(db)).toThrow(/ALREADY_EXISTS/);
    expect(() => insertContext(db, { id: 'trctx_same_session' })).toThrow(/ALREADY_EXISTS/);
    expect(() => db.prepare(`INSERT OR REPLACE INTO training_session_contexts SELECT * FROM training_session_contexts WHERE id = 'trctx_fixture'`).run()).toThrow(/ALREADY_EXISTS|IMMUTABLE/);
    expect(() => db.prepare(`
      INSERT OR REPLACE INTO training_session_contexts
      SELECT 'trctx_same_session', session_id, owner_user_id, evidence_manifest_sha256,
             route_plan_json, prompt_cache_namespace, evidence_policy_revision,
             status, created_at, updated_at
      FROM training_session_contexts WHERE id = 'trctx_fixture'
    `).run()).toThrow(/ALREADY_EXISTS|IMMUTABLE/);
    expect(db.prepare(`SELECT id FROM training_session_contexts WHERE session_id = 'training-a'`).all())
      .toEqual([{ id: 'trctx_fixture' }]);
    expect(() => db.prepare(`UPDATE training_session_contexts SET route_plan_json = '{}' WHERE id = 'trctx_fixture'`).run()).toThrow(/IMMUTABLE/);
    expect(() => db.prepare(`DELETE FROM training_session_contexts WHERE id = 'trctx_fixture'`).run()).toThrow(/IMMUTABLE/);
    db.prepare(`INSERT INTO training_session_context_deletion_authorizations (session_context_id, authorization_id, created_at) VALUES ('trctx_fixture', 'fixture-deletion', 1700000000001)`).run();
    expect(() => db.prepare(`DELETE FROM training_session_contexts WHERE id = 'trctx_fixture'`).run()).toThrow(/DEPENDENCIES_REMAIN|IMMUTABLE/);
    expect(() => db.prepare(`DELETE FROM training_scenario_evidence WHERE session_id = 'training-a'`).run()).not.toThrow();
    expect(() => db.prepare(`DELETE FROM training_scenario_packs WHERE session_id = 'training-a'`).run()).not.toThrow();
    expect(() => db.prepare(`DELETE FROM training_session_contexts WHERE id = 'trctx_fixture'`).run()).toThrow(/DEPENDENCIES_REMAIN/);
    expect(() => db.prepare(`DELETE FROM ai_invocation_attempts WHERE id = 'attempt-a'`).run()).not.toThrow();
    expect(() => db.prepare(`DELETE FROM training_session_contexts WHERE id = 'trctx_fixture'`).run()).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM training_scenario_evidence WHERE session_id = 'training-a'`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM training_scenario_packs WHERE session_id = 'training-a'`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM training_session_contexts WHERE id = 'trctx_fixture'`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ai_invocation_attempts WHERE id = 'attempt-a'`).get()).toEqual({ count: 0 });
  });

  it.each([
    ['pack update', `UPDATE training_scenario_packs SET evidence_query = 'changed' WHERE session_id = 'training-a'`],
    ['pack delete', `DELETE FROM training_scenario_packs WHERE session_id = 'training-a'`],
    ['pack replace', `INSERT OR REPLACE INTO training_scenario_packs SELECT * FROM training_scenario_packs WHERE session_id = 'training-a'`],
    ['evidence update', `UPDATE training_scenario_evidence SET excerpt = 'changed' WHERE id = 'evidence-a1'`],
    ['evidence delete', `DELETE FROM training_scenario_evidence WHERE id = 'evidence-a1'`],
    ['evidence replace', `INSERT OR REPLACE INTO training_scenario_evidence SELECT * FROM training_scenario_evidence WHERE id = 'evidence-a1'`],
  ])('protects bound Training receipt bytes from %s', (_label, sql) => {
    const db = openCurrentSchema(); apply0064(db); seedTraining(db); insertContext(db);
    expect(() => db.exec(sql)).toThrow(/TRAINING_.*IMMUTABLE/);
  });

  it('rejects cross-session replacement of a protected evidence identity', () => {
    const db = openCurrentSchema(); apply0064(db); seedTraining(db); insertContext(db);
    db.prepare(`INSERT INTO training_sessions (id, user_id, training_mode) VALUES ('training-b', 'fixture-a', 'scenario')`).run();
    db.prepare(`
      INSERT INTO training_scenario_packs (
        session_id, mode, evidence_query, evidence_status, evidence_manifest_sha256,
        source_count, book_count, scenario_json, rubric_json, created_at
      ) VALUES ('training-b', 'scenario', 'other evidence', 'ready', ?1, 3, 2, '{}', '[]', 1700000000000)
    `).run('b'.repeat(64));
    expect(() => db.prepare(`
      UPDATE training_scenario_packs SET session_id = 'training-a' WHERE session_id = 'training-b'
    `).run()).toThrow(/TRAINING_SCENARIO_PACK_IMMUTABLE/);
    expect(() => db.prepare(`
      INSERT OR REPLACE INTO training_scenario_evidence (
        id, session_id, source_id, selection_index, book_id, chunk_id,
        book_title, book_author, chunk_index, excerpt, content_sha256,
        relevance_score, created_at, char_start, char_end
      )
      SELECT id, 'training-b', 'source-cross-session', selection_index, book_id, chunk_id,
             book_title, book_author, chunk_index, excerpt, content_sha256,
             relevance_score, created_at, char_start, char_end
      FROM training_scenario_evidence WHERE id = 'evidence-a1'
    `).run()).toThrow(/TRAINING_SCENARIO_EVIDENCE_IMMUTABLE/);
    expect(db.prepare(`SELECT session_id FROM training_scenario_evidence WHERE id = 'evidence-a1'`).get())
      .toEqual({ session_id: 'training-a' });
    db.prepare(`
      INSERT INTO training_scenario_evidence (
        id, session_id, source_id, selection_index, book_id, chunk_id,
        book_title, book_author, chunk_index, excerpt, content_sha256,
        relevance_score, created_at, char_start, char_end
      ) VALUES (
        'evidence-c1', 'training-b', 'source-c1', 0, 'book-b', 'chunk-b1',
        'Book B', 'Fixture Author', 0, 'other evidence', ?1, 1,
        1700000000000, 0, 14
      )
    `).run('6'.repeat(64));
    expect(() => db.prepare(`
      UPDATE training_scenario_evidence SET session_id = 'training-a' WHERE id = 'evidence-c1'
    `).run()).toThrow(/TRAINING_SCENARIO_EVIDENCE_IMMUTABLE/);
    expect(db.prepare(`SELECT session_id FROM training_scenario_evidence WHERE id = 'evidence-c1'`).get())
      .toEqual({ session_id: 'training-b' });
  });

  it('keeps deletion authorization deletion-only while the context remains active', () => {
    const db = openCurrentSchema(); apply0064(db); seedTraining(db); insertContext(db);
    db.prepare(`
      INSERT INTO training_session_context_deletion_authorizations (
        session_context_id, authorization_id, created_at
      ) VALUES ('trctx_fixture', 'fixture-deletion', 1700000000001)
    `).run();
    db.prepare(`DELETE FROM training_scenario_evidence WHERE session_id = 'training-a'`).run();
    expect(() => db.prepare(`
      INSERT INTO training_scenario_evidence (
        id, session_id, source_id, selection_index, book_id, chunk_id,
        book_title, book_author, chunk_index, excerpt, content_sha256,
        relevance_score, created_at, char_start, char_end
      ) VALUES (
        'replacement-evidence', 'training-a', 'replacement-source', 0,
        'book-a', 'replacement-chunk', 'Book A', 'Fixture Author', 0,
        'replacement evidence', ?1, 1, 1700000000000, 0, 20
      )
    `).run('7'.repeat(64))).toThrow(/TRAINING_SCENARIO_EVIDENCE_IMMUTABLE/);
    db.prepare(`DELETE FROM training_scenario_packs WHERE session_id = 'training-a'`).run();
    expect(() => db.prepare(`
      INSERT INTO training_scenario_packs (
        session_id, mode, evidence_query, evidence_status, evidence_manifest_sha256,
        source_count, book_count, scenario_json, rubric_json, created_at
      ) VALUES ('training-a', 'scenario', 'replacement', 'ready', ?1, 3, 2, '{}', '[]', 1700000000000)
    `).run('8'.repeat(64))).toThrow(/TRAINING_SCENARIO_PACK_IMMUTABLE/);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM training_session_contexts WHERE id = 'trctx_fixture'`).get())
      .toEqual({ count: 1 });
  });

  it('accepts one exact context-bound attempt and preserves all-null legacy receipts', () => {
    const db = openCurrentSchema(); apply0064(db); seedTraining(db); insertContext(db);
    expect(() => insertAttempt(db)).not.toThrow();
    expect(() => insertAttempt(db, {
      id: 'attempt-legacy', invocationId: 'invocation-legacy', contextId: null,
      sessionId: null, turnNumber: null, cache: null,
    })).not.toThrow();
    expect(() => db.prepare(`
      UPDATE ai_invocation_attempts SET session_context_id = NULL WHERE id = 'attempt-a'
    `).run()).toThrow(/AI_INVOCATION_ATTEMPT_IMMUTABLE/);
    expect(() => db.prepare(`
      UPDATE ai_invocation_attempts SET session_id = 'training-a' WHERE id = 'attempt-legacy'
    `).run()).toThrow(/AI_INVOCATION_ATTEMPT_IMMUTABLE/);
  });

  it('preserves immutable evidence bytes while allowing the existing lifecycle tombstone update', () => {
    const db = openCurrentSchema(); apply0064(db); seedTraining(db); insertContext(db);
    expect(() => db.prepare(`
      UPDATE training_scenario_evidence
      SET lifecycle_status = 'deleted', deleted_at = 1700000000001
      WHERE id = 'evidence-a1'
    `).run()).not.toThrow();
    expect(db.prepare(`
      SELECT excerpt, content_sha256, lifecycle_status, deleted_at
      FROM training_scenario_evidence WHERE id = 'evidence-a1'
    `).get()).toEqual({
      excerpt: 'policy evidence alpha', content_sha256: '1'.repeat(64),
      lifecycle_status: 'deleted', deleted_at: 1_700_000_000_001,
    });
  });

  it('rejects an attempt when the same context identity matches both Sparring and Training', () => {
    const db = openCurrentSchema(); apply0064(db); seedTraining(db);
    insertSparringContextWithTrainingIdentity(db);
    insertContext(db);
    expect(() => insertAttempt(db)).toThrow(/AI_INVOCATION_ATTEMPT_CONTEXT_LINK_INVALID/);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ai_invocation_attempts WHERE id = 'attempt-a'`).get())
      .toEqual({ count: 0 });
  });

  it.each([
    ['unknown context', { contextId: 'trctx_missing' }],
    ['wrong session', { sessionId: 'training-other' }],
    ['wrong cache', { cache: 'training:wrong' }],
    ['unsafe turn', { turnNumber: -1 }],
    ['unsafe maximum turn', { turnNumber: 9_007_199_254_740_992 }],
    ['wrong lane', { lane: 'background_reasoning' }],
    ['wrong route', { routeId: 'wrong-route' }],
    ['partial legacy', { contextId: null, sessionId: 'training-a', turnNumber: null, cache: null }],
  ])('rejects an attempt with %s', (_label, overrides) => {
    const db = openCurrentSchema(); apply0064(db); seedTraining(db); insertContext(db);
    expect(() => insertAttempt(db, overrides)).toThrow(/AI_INVOCATION_ATTEMPT_CONTEXT_LINK_INVALID/);
  });

  it('generates a frozen context internally and loads it only through the owner boundary', async () => {
    const sqlite = openCurrentSchema(); apply0064(sqlite); seedTraining(sqlite);
    const db = asD1Database(sqlite);
    const service = await import('../src/services/training/training-session-context');
    const prepared = service.prepareTrainingSessionContext(db, validContextInput());
    expect(prepared.context.id).toMatch(/^trctx_[0-9a-f-]{36}$/);
    expect(prepared.context.status).toBe('ACTIVE');
    expect(prepared.context.updatedAt).toBe(prepared.context.createdAt);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.context)).toBe(true);
    await prepared.statement.run();
    await expect(service.loadOwnedTrainingSessionContext(db, 'training-a', 'fixture-a')).resolves.toEqual(prepared.context);
    await expect(service.loadOwnedTrainingSessionContext(db, 'training-a', 'fixture-b')).rejects.toThrow();
    for (const rejected of [
      { ...validContextInput(), id: 'caller-id' },
      { ...validContextInput(), status: 'ACTIVE' },
      { ...validContextInput(), updatedAt: 1_700_000_000_000 },
      { ...validContextInput(), createdAt: -1 },
      { ...validContextInput(), createdAt: 9_007_199_254_740_992 },
    ]) {
      expect(() => service.prepareTrainingSessionContext(db, rejected as never)).toThrow();
    }
  });

  it('derives the evidence opening deterministically without any provider call', async () => {
    const result = await buildEvidenceGroundedTrainingScenario({}, libraryDatabase(), {
      category: 'policy', difficulty: 'intermediate', evidenceQuery: 'policy evidence',
      evidenceBookIds: ['book-a', 'book-b'], ownerUserId: 'fixture-a', categoryLabel: '정책',
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('fixture must be ready');
    expect(result.evidencePack.sourceCount).toBe(3);
    expect(result.evidencePack.bookCount).toBe(2);
    expect(result.question.question).toMatch(/[가-힣]/);
    expect(result.question.title).toBe('정책 근거 기반 의사결정');
    expect(result.question.question).not.toContain('policy');
    expect(result.scenario.evidenceSourceIds).toEqual(result.evidencePack.sources.map((source) => source.sourceId));
    expect(seams.callAIJSONWithEnv).not.toHaveBeenCalled();
  });

  it('rolls back a Training start when the real 0064 context identity trigger rejects it', async () => {
    const sqlite = openStartSchema();
    const { db, trace } = transactionalD1(sqlite);
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000001');
    const env = {
      DB: db, JWT_SECRET: 'fixture-jwt',
      AI_ACTOR_SSU_API_KEY: '[REDACTED]',
      AI_ASSESSMENT_DEEPSEEK_API_KEY: '[REDACTED]',
      SOONGSIL_API_KEY: '[REDACTED]',
      DEEPSEEK_API_KEY: '[REDACTED]',
      GEMINI_API_KEY: '',
    } as Bindings;
    const request = {
      category: 'policy', difficulty: 'intermediate' as const, mode: 'evidence' as const,
      evidenceQuery: 'policy evidence', evidenceBookIds: ['book-a', 'book-b'],
    };
    seams.callAIJSONWithEnv.mockResolvedValue(legacyScenarioFixture());
    seams.createAIRouter.mockImplementation(() => {
      throw new Error('provider router must not be constructed during evidence opening');
    });
    try {
      await startTrainingSession(env, 'fixture-a', request, { sessionId: 'training-baseline' });
      trace.length = 0;
      seams.callAIJSONWithEnv.mockClear();
      seams.createAIRouter.mockClear();
      const failure = await startTrainingSession(env, 'fixture-a', request, { sessionId: 'training-rollback' })
        .then(() => null, (error: unknown) => error);
      const targetCount = (table: string, column = 'session_id') => (
        sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?1`)
          .get('training-rollback') as { count: number }
      ).count;
      const sessionAt = trace.findIndex((sql) => sql.includes('INSERT INTO training_sessions'));
      const packAt = trace.findIndex((sql) => sql.includes('INSERT INTO training_scenario_packs'));
      const evidenceAt = trace.findIndex((sql) => sql.includes('INSERT INTO training_scenario_evidence'));
      const contextAt = trace.findIndex((sql) => sql.includes('INSERT INTO training_session_contexts'));
      expect.soft(failure).toBeInstanceOf(TrainingOperationError);
      expect.soft(failure).toMatchObject({
        status: 503,
        body: {
          code: 'TRAINING_CONTEXT_PERSISTENCE_FAILED',
          error: expect.stringMatching(/[가-힣]/),
          assessmentState: 'UNGRADABLE',
        },
      });
      expect.soft(sessionAt).toBeGreaterThanOrEqual(0);
      expect.soft(packAt).toBeGreaterThan(sessionAt);
      expect.soft(evidenceAt).toBeGreaterThan(packAt);
      expect.soft(contextAt).toBeGreaterThan(evidenceAt);
      expect.soft(targetCount('training_sessions', 'id')).toBe(0);
      expect.soft(targetCount('training_scenario_packs')).toBe(0);
      expect.soft(targetCount('training_scenario_evidence')).toBe(0);
      expect.soft(targetCount('training_session_contexts')).toBe(0);
      expect.soft(targetCount('ai_invocation_attempts')).toBe(0);
      expect.soft(seams.callAIJSONWithEnv).not.toHaveBeenCalled();
      expect.soft(seams.createAIRouter).not.toHaveBeenCalled();
    } finally {
      randomUUID.mockRestore();
    }
  });

  it('binds evidence turns to the owned context and fails closed when receipt persistence fails', async () => {
    const { db } = await hintDatabase();
    const env = {
      DB: db, JWT_SECRET: 'fixture-jwt',
      AI_ACTOR_SSU_API_KEY: '[REDACTED]',
      AI_ASSESSMENT_DEEPSEEK_API_KEY: '[REDACTED]',
      SOONGSIL_API_KEY: '[REDACTED]',
      DEEPSEEK_API_KEY: '[REDACTED]',
      GEMINI_API_KEY: '',
    } as Bindings;
    const router = Object.freeze({ fixture: 'context-bound-router' });
    seams.createAIRouter.mockReturnValue(router);
    seams.processStudentTurn.mockRejectedValue({
      code: 'AI_INVOCATION_RECEIPT_PERSISTENCE_FAILED',
    });
    const failure = await respondTrainingSession(env, 'fixture-a', 'training-a', '근거를 비교한 답변입니다.')
      .then(() => null, (error: unknown) => error);
    expect(seams.createAIRouter).toHaveBeenCalledTimes(1);
    expect(seams.createAIRouter).toHaveBeenCalledWith(env, {
      mode: 'context_bound',
      pinnedRoutePlan: ROUTES,
      invocationScope: {
        sessionContextId: 'trctx_fixture', sessionId: 'training-a', turnNumber: 1,
        promptCacheNamespace: 'training:training-a',
      },
    });
    expect(seams.processStudentTurn).toHaveBeenCalledWith(expect.objectContaining({ router }));
    expect(failure).toBeInstanceOf(TrainingOperationError);
    expect(failure).toMatchObject({
      status: 503,
      body: {
        code: 'TRAINING_RECEIPT_PERSISTENCE_FAILED',
        error: expect.stringMatching(/[가-힣]/),
        assessmentState: 'UNGRADABLE',
      },
    });
  });

  it('refuses evidence-mode hints in Korean before grounding, provider, or receipt work', async () => {
    const { db, statements } = await hintDatabase();
    await expect(loadTrainingScenarioEvidenceContext(db, 'training-a')).resolves.toMatchObject({
      status: 'ready',
    });
    statements.length = 0;
    const env = { DB: db, JWT_SECRET: 'fixture-jwt', SOONGSIL_API_KEY: '[REDACTED]', GEMINI_API_KEY: '' } as Bindings;
    const response = await trainingRoute.fetch(new Request('http://fixture.local/api/training/hint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'training-a' }),
    }), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'EVIDENCE_HINT_UNAVAILABLE',
      error: '근거 기반 훈련에서는 힌트를 사용할 수 없습니다.',
    });
    expect(seams.createAIRouter).not.toHaveBeenCalled();
    expect(seams.callAIJSONWithEnv).not.toHaveBeenCalled();
    expect(statements.some((sql) => sql.includes('FROM training_scenario_evidence'))).toBe(false);
    expect(statements.some((sql) => /INSERT\s+INTO\s+ai_invocation_attempts/i.test(sql))).toBe(false);
  });
});
