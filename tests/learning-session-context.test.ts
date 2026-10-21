import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/types';
import { AIRouter, AIRouteUnavailableError } from '../src/services/ai-router';
import {
  createGrowthLabSparringContext,
  LearningSessionContextError,
  loadOwnedSparringContext,
  pinAIRoutePlan,
  type PinnedLaneRoutePlan,
} from '../src/services/learning-session-context';

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

function createDb(rows: unknown[] = []): { db: D1Database; statements: RecordedStatement[] } {
  const statements: RecordedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const record: RecordedStatement = { sql, values: [] };
      statements.push(record);
      const statement = {
        bind(...values: unknown[]) {
          record.values = values;
          return statement;
        },
        async run() {
          return {};
        },
        async first<T>() {
          return (rows.shift() ?? null) as T | null;
        },
        async all<T>() {
          return { results: rows.splice(0) as T[] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, statements };
}

function bindings(db: D1Database, overrides: Partial<Bindings> = {}): Bindings {
  return {
    SOONGSIL_API_KEY: '',
    GEMINI_API_KEY: '',
    JWT_SECRET: 'test-jwt-secret',
    DB: db,
    ...overrides,
  };
}

function pinnedPlan(): PinnedLaneRoutePlan {
  return {
    interactive_generation: ['ssu-luna'],
    learner_evaluation: ['deepseek-v4-pro'],
    release_critic: ['deepseek-v4-flash'],
    background_reasoning: ['deepseek-v4-pro'],
  };
}

function storedContextRow(routePlanJson: string): Record<string, unknown> {
  return {
    id: 'context-1',
    session_kind: 'SPARRING',
    session_id: 'session-1',
    owner_user_id: 'user-1',
    context_kind: 'GROWTH_LAB',
    subject_id: 'user-1',
    authority_capabilities_json: '["growth_lab:owner"]',
    context_policy_revision: 'growth-lab-policy-v1',
    corpus_binding_id: 'book:book-1',
    corpus_manifest_revision: 'sha256:opening-manifest',
    route_plan_json: routePlanJson,
    prompt_cache_namespace: 'sparring:session-1',
    evidence_policy_revision: 'evidence-policy-v1',
    status: 'ACTIVE',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };
}

function openMigratedContextDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA recursive_triggers = OFF;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE sparring_evidence_manifests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      query_text TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      source_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, turn_number)
    );
    CREATE TABLE sparring_turn_evidence (
      id TEXT PRIMARY KEY,
      manifest_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      book_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      char_start INTEGER,
      char_end INTEGER,
      content_snapshot TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      relevance_score REAL NOT NULL,
      created_at INTEGER NOT NULL,
      source_id TEXT,
      book_title TEXT,
      book_author TEXT,
      UNIQUE(session_id, turn_number, chunk_id)
    );
    CREATE TABLE ai_invocation_attempts (id TEXT PRIMARY KEY);
    INSERT INTO users (id) VALUES ('user-1');
    INSERT INTO sessions (id, user_id) VALUES ('session-1', 'user-1');
    INSERT INTO sparring_evidence_manifests (
      id, session_id, turn_number, user_id, book_id, query_text,
      manifest_sha256, source_count, created_at
    ) VALUES (
      'manifest-1', 'session-1', 0, 'user-1', 'book-1', 'opening query',
      'sha256:opening-manifest', 1, 1700000000000
    );
    INSERT INTO sparring_turn_evidence (
      id, manifest_id, session_id, turn_number, book_id, chunk_id, chunk_index,
      char_start, char_end, content_snapshot, content_sha256, relevance_score, created_at,
      source_id, book_title, book_author
    ) VALUES (
      'evidence-1', 'manifest-1', 'session-1', 0, 'book-1', 'chunk-1', 0,
      0, 20, 'immutable opening evidence', 'chunk-sha256', 1, 1700000000000,
      'source-1', 'Opening Book', 'Opening Author'
    );
  `);
  db.exec(readFileSync('migrations/0063_learning_session_context.sql', 'utf8'));
  db.exec(`
    INSERT INTO learning_session_contexts (
      id, session_kind, session_id, owner_user_id, context_kind, subject_id,
      authority_capabilities_json, context_policy_revision, corpus_binding_id,
      corpus_manifest_revision, route_plan_json, prompt_cache_namespace,
      evidence_policy_revision, status, created_at, updated_at
    ) VALUES (
      'context-1', 'SPARRING', 'session-1', 'user-1', 'GROWTH_LAB', 'user-1',
      '["growth_lab:owner"]', 'growth-lab-policy-v1', 'book:book-1',
      'sha256:opening-manifest',
      '{"interactive_generation":[],"learner_evaluation":[],"release_critic":[],"background_reasoning":[]}',
      'sparring:session-1', 'evidence-policy-v1', 'ACTIVE', 1700000000000, 1700000000000
    );
  `);
  return db;
}

function asD1Database(sqlite: DatabaseSync): D1Database {
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...nextValues: unknown[]) {
          values = nextValues;
          return statement;
        },
        async run() {
          sqlite.prepare(sql).run(...values);
          return {};
        },
        async first<T>() {
          return (sqlite.prepare(sql).get(...values) ?? null) as T | null;
        },
        async all<T>() {
          return { results: sqlite.prepare(sql).all(...values) as T[] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return db;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LearningSessionContext', () => {
  it('freezes configured routes in ordered plans for every execution lane', () => {
    const { db } = createDb();

    const plan = pinAIRoutePlan(bindings(db, {
      AI_ACTOR_SSU_API_KEY: '[REDACTED]',
      AI_ASSESSMENT_DEEPSEEK_API_KEY: '[REDACTED]',
    }));

    expect(plan).toEqual({
      interactive_generation: ['ssu-luna'],
      learner_evaluation: ['deepseek-v4-pro'],
      release_critic: ['deepseek-v4-flash'],
      background_reasoning: ['deepseek-v4-pro'],
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.interactive_generation)).toBe(true);
  });

  it('rejects a route plan that assigns a route to the wrong lane', async () => {
    const { db } = createDb([storedContextRow(JSON.stringify({
      ...pinnedPlan(),
      release_critic: ['ssu-luna'],
    }))]);

    await expect(loadOwnedSparringContext(db, 'session-1', 'user-1'))
      .rejects.toMatchObject<Partial<LearningSessionContextError>>({
        code: 'INVALID_ROUTE_PLAN',
      });
  });

  it('rejects duplicate route IDs in a stored lane plan', async () => {
    const { db } = createDb([storedContextRow(JSON.stringify({
      ...pinnedPlan(),
      interactive_generation: ['ssu-luna', 'ssu-luna'],
    }))]);

    await expect(loadOwnedSparringContext(db, 'session-1', 'user-1'))
      .rejects.toMatchObject<Partial<LearningSessionContextError>>({
        code: 'INVALID_ROUTE_PLAN',
      });
  });

  it('persists an owner-bound, Growth Lab, secret-free immutable context', async () => {
    const { db, statements } = createDb();
    const routes = pinAIRoutePlan(bindings(db, {
      AI_ACTOR_SSU_API_KEY: '[REDACTED]',
      AI_ASSESSMENT_DEEPSEEK_API_KEY: '[REDACTED]',
    }));

    const context = await createGrowthLabSparringContext({
      db,
      id: 'context-1',
      sessionId: 'session-1',
      ownerUserId: 'user-1',
      subjectId: 'user-1',
      authorityCapabilities: ['growth_lab:owner'],
      contextPolicyRevision: 'growth-lab-policy-v1',
      corpusBindingId: 'book:book-1',
      corpusManifestRevision: 'sha256:opening-manifest',
      routes,
      promptCacheNamespace: 'sparring:session-1',
      evidencePolicyRevision: 'evidence-policy-v1',
      now: 1_700_000_000_000,
    });

    expect(context).toMatchObject({
      id: 'context-1',
      sessionKind: 'SPARRING',
      sessionId: 'session-1',
      context: {
        kind: 'GROWTH_LAB',
        subjectId: 'user-1',
        authorityCapabilities: ['growth_lab:owner'],
        policyRevision: 'growth-lab-policy-v1',
      },
    });
    expect(Object.isFrozen(context)).toBe(true);

    const insert = statements.find((statement) => statement.sql.includes('INSERT INTO learning_session_contexts'));
    expect(insert).toBeDefined();
    expect(JSON.stringify(insert?.values)).not.toContain('actor-credential');
    expect(JSON.stringify(insert?.values)).not.toContain('assessment-credential');

    const migration = readFileSync('migrations/0063_learning_session_context.sql', 'utf8');
    expect(migration).toContain('UNIQUE (session_kind, session_id)');
    expect(migration).toContain('LEARNING_SESSION_CONTEXT_SESSION_OWNER_REQUIRED');
    expect(migration).toContain('LEARNING_SESSION_CONTEXT_IMMUTABLE');
    expect(migration).toContain('session_context_id');
    expect(migration).toContain('prompt_cache_namespace');
  });

  it('fails closed when stored route-plan JSON is malformed', async () => {
    const { db } = createDb([storedContextRow('{not-json')]);

    await expect(loadOwnedSparringContext(db, 'session-1', 'user-1'))
      .rejects.toMatchObject<Partial<LearningSessionContextError>>({
        code: 'MALFORMED_ROUTE_PLAN',
      });
  });

  it('enforces context immutability against SQLite UPDATE, DELETE, and INSERT OR REPLACE', () => {
    const db = openMigratedContextDatabase();
    try {
      expect(() => db.exec(`
        UPDATE learning_session_contexts
        SET prompt_cache_namespace = 'tampered'
        WHERE id = 'context-1';
      `)).toThrow('LEARNING_SESSION_CONTEXT_IMMUTABLE');
      expect(() => db.exec(`
        DELETE FROM learning_session_contexts
        WHERE id = 'context-1';
      `)).toThrow('LEARNING_SESSION_CONTEXT_IMMUTABLE');
      expect(() => db.exec(`
        INSERT OR REPLACE INTO learning_session_contexts (
          id, session_kind, session_id, owner_user_id, context_kind, subject_id,
          authority_capabilities_json, context_policy_revision, corpus_binding_id,
          corpus_manifest_revision, route_plan_json, prompt_cache_namespace,
          evidence_policy_revision, status, created_at, updated_at
        ) VALUES (
          'context-1', 'SPARRING', 'session-1', 'user-1', 'GROWTH_LAB', 'user-1',
          '["growth_lab:owner"]', 'tampered-policy', 'book:book-1',
          'sha256:opening-manifest',
          '{"interactive_generation":[],"learner_evaluation":[],"release_critic":[],"background_reasoning":[]}',
          'tampered', 'evidence-policy-v1', 'ACTIVE', 1700000000001, 1700000000001
        );
      `)).toThrow('LEARNING_SESSION_CONTEXT_ALREADY_EXISTS');

      const row = db.prepare(`
        SELECT context_policy_revision, prompt_cache_namespace, created_at
        FROM learning_session_contexts
        WHERE id = 'context-1';
      `).get() as Record<string, unknown>;
      expect(row).toEqual({
        context_policy_revision: 'growth-lab-policy-v1',
        prompt_cache_namespace: 'sparring:session-1',
        created_at: 1_700_000_000_000,
      });
    } finally {
      db.close();
    }
  });

  it('requires the exact immutable opening manifest before context creation', () => {
    const db = openMigratedContextDatabase();
    try {
      db.exec(`
        INSERT INTO sessions (id, user_id) VALUES
          ('session-without-opening', 'user-1'),
          ('session-mismatched-opening', 'user-1'),
          ('session-valid-opening', 'user-1');
        INSERT INTO sparring_evidence_manifests (
          id, session_id, turn_number, user_id, book_id, query_text,
          manifest_sha256, source_count, created_at
        ) VALUES
          ('manifest-mismatched', 'session-mismatched-opening', 0, 'user-1', 'book-2', 'opening query', 'sha256:expected', 1, 1700000000001),
          ('manifest-valid', 'session-valid-opening', 0, 'user-1', 'book-3', 'opening query', 'sha256:valid', 1, 1700000000001);
      `);

      const contextColumns = `
        id, session_kind, session_id, owner_user_id, context_kind, subject_id,
        authority_capabilities_json, context_policy_revision, corpus_binding_id,
        corpus_manifest_revision, route_plan_json, prompt_cache_namespace,
        evidence_policy_revision, status, created_at, updated_at
      `;
      const emptyRoutes = '{"interactive_generation":[],"learner_evaluation":[],"release_critic":[],"background_reasoning":[]}';

      expect(() => db.exec(`
        INSERT INTO learning_session_contexts (${contextColumns}) VALUES (
          'context-without-opening', 'SPARRING', 'session-without-opening', 'user-1', 'GROWTH_LAB', 'user-1',
          '["growth_lab:owner"]', 'growth-lab-policy-v1', 'book:book-1',
          'sha256:missing', '${emptyRoutes}', 'sparring:session-without-opening',
          'evidence-policy-v1', 'ACTIVE', 1700000000001, 1700000000001
        );
      `)).toThrow('LEARNING_SESSION_CONTEXT_OPENING_MANIFEST_REQUIRED');

      expect(() => db.exec(`
        INSERT INTO learning_session_contexts (${contextColumns}) VALUES (
          'context-mismatched-opening', 'SPARRING', 'session-mismatched-opening', 'user-1', 'GROWTH_LAB', 'user-1',
          '["growth_lab:owner"]', 'growth-lab-policy-v1', 'book:book-2',
          'sha256:wrong', '${emptyRoutes}', 'sparring:session-mismatched-opening',
          'evidence-policy-v1', 'ACTIVE', 1700000000001, 1700000000001
        );
      `)).toThrow('LEARNING_SESSION_CONTEXT_OPENING_MANIFEST_REQUIRED');

      expect(() => db.exec(`
        INSERT INTO learning_session_contexts (${contextColumns}) VALUES (
          'context-valid-opening', 'SPARRING', 'session-valid-opening', 'user-1', 'GROWTH_LAB', 'user-1',
          '["growth_lab:owner"]', 'growth-lab-policy-v1', 'book:book-3',
          'sha256:valid', '${emptyRoutes}', 'sparring:session-valid-opening',
          'evidence-policy-v1', 'ACTIVE', 1700000000001, 1700000000001
        );
      `)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('blocks evidence snapshot tampering, deletion, and replacement', () => {
    const db = openMigratedContextDatabase();
    try {
      expect(() => db.exec(`
        UPDATE sparring_evidence_manifests
        SET query_text = 'tampered'
        WHERE id = 'manifest-1';
      `)).toThrow('SPARRING_EVIDENCE_MANIFEST_IMMUTABLE');
      expect(() => db.exec(`
        DELETE FROM sparring_evidence_manifests
        WHERE id = 'manifest-1';
      `)).toThrow('SPARRING_EVIDENCE_MANIFEST_IMMUTABLE');
      expect(() => db.exec(`
        INSERT OR REPLACE INTO sparring_evidence_manifests (
          id, session_id, turn_number, user_id, book_id, query_text,
          manifest_sha256, source_count, created_at
        ) VALUES (
          'manifest-1', 'session-1', 0, 'user-1', 'book-1', 'replacement',
          'sha256:replacement', 1, 1700000000001
        );
      `)).toThrow('SPARRING_EVIDENCE_MANIFEST_IMMUTABLE');

      expect(() => db.exec(`
        UPDATE sparring_turn_evidence
        SET content_snapshot = 'tampered'
        WHERE id = 'evidence-1';
      `)).toThrow('SPARRING_TURN_EVIDENCE_IMMUTABLE');
      expect(() => db.exec(`
        UPDATE sparring_turn_evidence
        SET source_id = 'tampered-source'
        WHERE id = 'evidence-1';
      `)).toThrow('SPARRING_TURN_EVIDENCE_IMMUTABLE');
      expect(() => db.exec(`
        UPDATE sparring_turn_evidence
        SET book_title = 'Tampered Book'
        WHERE id = 'evidence-1';
      `)).toThrow('SPARRING_TURN_EVIDENCE_IMMUTABLE');
      expect(() => db.exec(`
        UPDATE sparring_turn_evidence
        SET book_author = 'Tampered Author'
        WHERE id = 'evidence-1';
      `)).toThrow('SPARRING_TURN_EVIDENCE_IMMUTABLE');
      expect(() => db.exec(`
        DELETE FROM sparring_turn_evidence
        WHERE id = 'evidence-1';
      `)).toThrow('SPARRING_TURN_EVIDENCE_IMMUTABLE');
      expect(() => db.exec(`
        INSERT OR REPLACE INTO sparring_turn_evidence (
          id, manifest_id, session_id, turn_number, book_id, chunk_id, chunk_index,
          char_start, char_end, content_snapshot, content_sha256, relevance_score, created_at
        ) VALUES (
          'evidence-1', 'manifest-1', 'session-1', 0, 'book-1', 'chunk-1', 0,
          0, 20, 'replacement', 'replacement-sha256', 1, 1700000000001
        );
      `)).toThrow('SPARRING_TURN_EVIDENCE_IMMUTABLE');

      const attribution = db.prepare(`
        SELECT source_id, book_title, book_author
        FROM sparring_turn_evidence
        WHERE id = 'evidence-1';
      `).get() as Record<string, unknown>;
      expect(attribution).toEqual({
        source_id: 'source-1',
        book_title: 'Opening Book',
        book_author: 'Opening Author',
      });

      // Context-bound evidence may be removed only as part of an authorized
      // context deletion. The authorization is intentionally absent above.
      db.exec(`
        INSERT INTO learning_session_context_deletion_authorizations (
          session_context_id, authorization_id, created_at
        ) VALUES ('context-1', 'delete-context-1', 1700000000001);
      `);
      expect(() => db.exec(`
        DELETE FROM sparring_turn_evidence WHERE id = 'evidence-1';
        DELETE FROM sparring_evidence_manifests WHERE id = 'manifest-1';
        DELETE FROM learning_session_contexts WHERE id = 'context-1';
      `)).not.toThrow();

      // Legacy sessions intentionally have no LearningSessionContext and must
      // remain deletable through the compatibility history route.
      db.exec(`
        INSERT INTO sessions (id, user_id) VALUES ('legacy-session', 'user-1');
        INSERT INTO sparring_evidence_manifests (
          id, session_id, turn_number, user_id, book_id, query_text,
          manifest_sha256, source_count, created_at
        ) VALUES (
          'legacy-manifest', 'legacy-session', 0, 'user-1', 'book-1', 'legacy query',
          'sha256:legacy', 1, 1700000000002
        );
        INSERT INTO sparring_turn_evidence (
          id, manifest_id, session_id, turn_number, book_id, chunk_id, chunk_index,
          char_start, char_end, content_snapshot, content_sha256, relevance_score, created_at,
          source_id, book_title, book_author
        ) VALUES (
          'legacy-evidence', 'legacy-manifest', 'legacy-session', 0, 'book-1', 'legacy-chunk', 0,
          0, 20, 'legacy evidence', 'legacy-sha256', 1, 1700000000002,
          'legacy-source', 'Legacy Book', 'Legacy Author'
        );
      `);
      expect(() => db.exec(`
        DELETE FROM sparring_turn_evidence WHERE id = 'legacy-evidence';
        DELETE FROM sparring_evidence_manifests WHERE id = 'legacy-manifest';
      `)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('maps real SQLite duplicate-session and owner trigger failures to stable context errors', async () => {
    const sqlite = openMigratedContextDatabase();
    try {
      sqlite.exec(`
        INSERT INTO users (id) VALUES ('user-2');
        INSERT INTO sessions (id, user_id) VALUES ('session-2', 'user-1');
      `);
      const db = asD1Database(sqlite);

      await expect(createGrowthLabSparringContext({
        db,
        id: 'context-duplicate',
        sessionId: 'session-1',
        ownerUserId: 'user-1',
        subjectId: 'user-1',
        authorityCapabilities: ['growth_lab:owner'],
        contextPolicyRevision: 'growth-lab-policy-v1',
        corpusBindingId: 'book:book-1',
        corpusManifestRevision: 'sha256:opening-manifest',
        routes: pinnedPlan(),
        promptCacheNamespace: 'sparring:session-1',
        evidencePolicyRevision: 'evidence-policy-v1',
        now: 1_700_000_000_001,
      })).rejects.toMatchObject<Partial<LearningSessionContextError>>({
        code: 'CONTEXT_ALREADY_EXISTS',
      });

      await expect(createGrowthLabSparringContext({
        db,
        id: 'context-wrong-owner',
        sessionId: 'session-2',
        ownerUserId: 'user-2',
        subjectId: 'user-2',
        authorityCapabilities: ['growth_lab:owner'],
        contextPolicyRevision: 'growth-lab-policy-v1',
        corpusBindingId: 'book:book-1',
        corpusManifestRevision: 'sha256:opening-manifest',
        routes: pinnedPlan(),
        promptCacheNamespace: 'sparring:session-2',
        evidencePolicyRevision: 'evidence-policy-v1',
        now: 1_700_000_000_002,
      })).rejects.toMatchObject<Partial<LearningSessionContextError>>({
        code: 'CONTEXT_OWNER_REQUIRED',
      });
    } finally {
      sqlite.close();
    }
  });

  it('allows legacy receipt linkage only when every context field is null', () => {
    const db = openMigratedContextDatabase();
    try {
      expect(() => db.exec(`
        INSERT INTO ai_invocation_attempts (id)
        VALUES ('legacy-receipt');
      `)).not.toThrow();
      expect(() => db.exec(`
        INSERT INTO ai_invocation_attempts (
          id, session_context_id, session_id, turn_number, prompt_cache_namespace
        ) VALUES ('scoped-receipt', 'context-1', 'session-1', 0, 'sparring:session-1');
      `)).not.toThrow();
      expect(() => db.exec(`
        INSERT INTO ai_invocation_attempts (
          id, session_context_id, session_id, turn_number, prompt_cache_namespace
        ) VALUES ('wrong-session-receipt', 'context-1', 'session-2', 0, 'sparring:session-1');
      `)).toThrow('AI_INVOCATION_ATTEMPT_CONTEXT_LINK_INVALID');
      expect(() => db.exec(`
        INSERT INTO ai_invocation_attempts (
          id, session_context_id, session_id, turn_number, prompt_cache_namespace
        ) VALUES ('negative-turn-receipt', 'context-1', 'session-1', -1, 'sparring:session-1');
      `)).toThrow('AI_INVOCATION_ATTEMPT_CONTEXT_LINK_INVALID');
      expect(() => db.exec(`
        INSERT INTO ai_invocation_attempts (
          id, session_context_id, session_id, turn_number, prompt_cache_namespace
        ) VALUES ('unsafe-turn-receipt', 'context-1', 'session-1', 9007199254740992, 'sparring:session-1');
      `)).toThrow('AI_INVOCATION_ATTEMPT_CONTEXT_LINK_INVALID');
      expect(() => db.exec(`
        INSERT INTO ai_invocation_attempts (
          id, session_context_id, session_id, turn_number, prompt_cache_namespace
        ) VALUES ('empty-cache-receipt', 'context-1', 'session-1', 1, '');
      `)).toThrow('AI_INVOCATION_ATTEMPT_CONTEXT_LINK_INVALID');
    } finally {
      db.close();
    }
  });
});

describe('AIRouter pinned plans', () => {
  it('rejects partial and mixed legacy/context-bound option shapes', () => {
    const { db } = createDb();
    const scope = {
      sessionContextId: 'context-1',
      sessionId: 'session-1',
      turnNumber: 1,
      promptCacheNamespace: 'sparring:session-1',
    };

    expect(() => new AIRouter(bindings(db))).not.toThrow();
    expect(() => new AIRouter(bindings(db), {
      mode: 'context_bound',
      pinnedRoutePlan: pinnedPlan(),
    } as never)).toThrow('AI_ROUTER_CONTEXT_OPTIONS_INVALID');
    expect(() => new AIRouter(bindings(db), {
      mode: 'legacy',
      pinnedRoutePlan: pinnedPlan(),
      invocationScope: scope,
    } as never)).toThrow('AI_ROUTER_CONTEXT_OPTIONS_INVALID');
  });

  it('rejects duplicate route IDs before they can simulate a fallback retry', () => {
    const { db } = createDb();

    expect(() => new AIRouter(bindings(db), {
      mode: 'context_bound',
      pinnedRoutePlan: {
        ...pinnedPlan(),
        interactive_generation: ['ssu-luna', 'ssu-luna'],
      },
      invocationScope: {
        sessionContextId: 'context-1',
        sessionId: 'session-1',
        turnNumber: 1,
        promptCacheNamespace: 'sparring:session-1',
      },
    } as never)).toThrow('AI_ROUTER_CONTEXT_OPTIONS_INVALID');
  });

  it('never attempts a configured fallback route omitted from the pinned plan', async () => {
    const { db, statements } = createDb();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('mindlogic.ai')) return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify({
        id: 'completion-1',
        choices: [{ message: { content: 'unexpected fallback' }, finish_reason: 'stop' }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const router = new AIRouter(bindings(db, {
      AI_ACTOR_SSU_API_KEY: '[REDACTED]',
      AI_ACTOR_OPENROUTER_API_KEY: '[REDACTED]',
    }), {
      mode: 'context_bound',
      pinnedRoutePlan: pinnedPlan(),
      invocationScope: {
        sessionContextId: 'context-1',
        sessionId: 'session-1',
        turnNumber: 1,
        promptCacheNamespace: 'sparring:session-1',
      },
    });

    await expect(router.complete('interactive_generation', { userPrompt: 'Hello.' }))
      .rejects.toBeInstanceOf(AIRouteUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('mindlogic.ai');

    const receipt = statements.find((statement) => statement.sql.includes('INSERT INTO ai_invocation_attempts'));
    expect(receipt?.values).toContain('context-1');
    expect(receipt?.values).toContain('session-1');
    expect(receipt?.values).toContain(1);
    expect(receipt?.values).toContain('sparring:session-1');
  });

  it('aborts a context-bound result when its invocation receipt cannot persist', async () => {
    const failingDb = {
      prepare(sql: string) {
        const statement = {
          bind(..._values: unknown[]) {
            return statement;
          },
          async run() {
            if (sql.includes('INSERT INTO ai_invocation_attempts')) {
              throw new Error('D1 receipt write failed');
            }
            return {};
          },
          async first<T>() {
            return null as T | null;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'completion-1',
      choices: [{ message: { content: 'Provider output must not escape.' }, finish_reason: 'stop' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const router = new AIRouter(bindings(failingDb, {
      AI_ACTOR_SSU_API_KEY: '[REDACTED]',
      AI_ACTOR_OPENROUTER_API_KEY: '[REDACTED]',
    }), {
      mode: 'context_bound',
      pinnedRoutePlan: {
        ...pinnedPlan(),
        interactive_generation: ['ssu-luna', 'openrouter-step-3.7-flash'],
      },
      invocationScope: {
        sessionContextId: 'context-1',
        sessionId: 'session-1',
        turnNumber: 1,
        promptCacheNamespace: 'sparring:session-1',
      },
    });

    await expect(router.complete('interactive_generation', { userPrompt: 'Hello.' }))
      .rejects.toMatchObject({ code: 'AI_INVOCATION_RECEIPT_PERSISTENCE_FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
