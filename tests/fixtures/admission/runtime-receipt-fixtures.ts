import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { canonicalDocument, type CanonicalJsonValue } from '../../../src/services/admission/canonical-json';
import { contentIdentity, sha256Hex, type ContentIdentity } from '../../../src/services/admission/identity';
import type { SourceReceiptRefV1 } from '../../../src/services/admission/evidence-spine-types';

export const FIXTURE_ACCOUNT_CANARY = 'fixture-account-private-canary-a';
export const FIXTURE_PASSAGE_CANARY = 'fixture-passage-private-canary-a';
export const FIXTURE_CLAIM_CANARY = 'fixture-claim-private-canary-a';
export const FIXTURE_BROWSER_CANARY = 'fixture-browser-private-canary-a';

export const FIXTURE_ROUTES = Object.freeze({
  background_reasoning: Object.freeze(['deepseek-v4-pro'] as const),
  interactive_generation: Object.freeze(['ssu-luna'] as const),
  learner_evaluation: Object.freeze(['deepseek-v4-pro'] as const),
  release_critic: Object.freeze(['deepseek-v4-flash'] as const),
});

export interface RuntimeReceiptFixture {
  readonly sqlite: DatabaseSync;
  readonly db: D1Database;
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly contextId: string;
  readonly attemptId: string;
  readonly manifestSha256: string;
  readonly refs: Readonly<{
    sourceManifest: SourceReceiptRefV1;
    trainingContext: SourceReceiptRefV1;
    attempt: SourceReceiptRefV1;
  }>;
  close(): void;
}

/**
 * Byte-bearing synthetic carrier material used by the offline adapter tests.
 * The fixture deliberately exposes only canonical bytes and their independently
 * derived identity; production code must not treat the parsed convenience
 * object as authority.
 */
export interface ExternalCaptureFixture {
  readonly carrier: CanonicalJsonValue;
  readonly carrierBytes: Uint8Array;
  readonly carrierIdentity: ContentIdentity;
}

export async function canonicalExternalCaptureFixture(
  carrier: CanonicalJsonValue,
): Promise<ExternalCaptureFixture> {
  const carrierBytes = canonicalDocument(carrier);
  const carrierIdentity = await contentIdentity(carrierBytes);
  return Object.freeze({
    carrier,
    carrierBytes: new Uint8Array(carrierBytes),
    carrierIdentity: Object.freeze({ ...carrierIdentity }),
  });
}

type EvidenceFixtureRow = Readonly<{
  sourceId: string;
  selectionIndex: number;
  bookId: string;
  chunkId: string;
  bookTitle: string;
  bookAuthor: string;
  chunkIndex: number;
  excerpt: string;
  contentSha256: string;
  relevanceScore: number;
}>;

function migration(name: string): string {
  return readFileSync(`migrations/${name}`, 'utf8');
}

function asD1Database(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next as SQLInputValue[];
          return statement;
        },
        async run() {
          return sqlite.prepare(sql).run(...values);
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
}

async function sha256Text(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value));
}

async function identity(value: CanonicalJsonValue): Promise<ContentIdentity> {
  return contentIdentity(canonicalDocument(value));
}

function canonicalIdentity(value: ContentIdentity): CanonicalJsonValue {
  return { byte_length: value.byte_length, sha256: value.sha256 };
}

function canonicalFixtureRoutes(): CanonicalJsonValue {
  return {
    background_reasoning: [...FIXTURE_ROUTES.background_reasoning],
    interactive_generation: [...FIXTURE_ROUTES.interactive_generation],
    learner_evaluation: [...FIXTURE_ROUTES.learner_evaluation],
    release_critic: [...FIXTURE_ROUTES.release_critic],
  };
}

async function evidenceRows(): Promise<readonly EvidenceFixtureRow[]> {
  const rows = [
    {
      sourceId: 'library:book-a:chunk-a1', selectionIndex: 0, bookId: 'book-a',
      chunkId: 'chunk-a1', bookTitle: 'Synthetic Book A', bookAuthor: 'Fixture Author',
      chunkIndex: 0, excerpt: FIXTURE_PASSAGE_CANARY, relevanceScore: 1,
    },
    {
      sourceId: 'library:book-a:chunk-a2', selectionIndex: 1, bookId: 'book-a',
      chunkId: 'chunk-a2', bookTitle: 'Synthetic Book A', bookAuthor: 'Fixture Author',
      chunkIndex: 1, excerpt: 'Synthetic public passage beta.', relevanceScore: 0.75,
    },
    {
      sourceId: 'library:book-b:chunk-b1', selectionIndex: 2, bookId: 'book-b',
      chunkId: 'chunk-b1', bookTitle: 'Synthetic Book B', bookAuthor: 'Fixture Author',
      chunkIndex: 0, excerpt: 'Synthetic public passage gamma.', relevanceScore: 0.5,
    },
  ] as const;
  return Promise.all(rows.map(async (row) => ({
    ...row,
    contentSha256: await sha256Text(row.excerpt),
  })));
}

async function manifestSha256(query: string, rows: readonly EvidenceFixtureRow[]): Promise<string> {
  return sha256Text(JSON.stringify({
    query,
    sources: [...rows]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .map((row) => ({
        sourceId: row.sourceId,
        selectionIndex: row.selectionIndex,
        bookId: row.bookId,
        bookTitle: row.bookTitle,
        bookAuthor: row.bookAuthor,
        chunkId: row.chunkId,
        chunkIndex: row.chunkIndex,
        contentSha256: row.contentSha256,
        relevanceScore: row.relevanceScore,
      })),
  }));
}

export async function expectedTrainingReceiptPayloads(input: {
  ownerKey: string;
  sessionId: string;
  contextId: string;
  attemptId: string;
  manifestSha256: string;
  rows: readonly EvidenceFixtureRow[];
}): Promise<Readonly<{
  sourceManifest: CanonicalJsonValue;
  trainingContext: CanonicalJsonValue;
  attempt: CanonicalJsonValue;
}>> {
  const subjectIdentity = await identity({ session_id: input.sessionId, subject_kind: 'TRAINING_SESSION' });
  const accountScopeIdentity = await identity({ account_key: input.ownerKey, scope_kind: 'OWNER' });
  const sessionIdentity = await identity({ session_id: input.sessionId });
  const routePlan = canonicalFixtureRoutes();
  const contextIdentity = await identity({
    context_id: input.contextId,
    evidence_manifest_sha256: input.manifestSha256,
    evidence_policy_revision: 'critical-path-b-v1',
    prompt_cache_namespace: `training:${input.sessionId}`,
    route_plan: routePlan,
    session_id: input.sessionId,
  });
  const cacheNamespaceIdentity = await identity({ prompt_cache_namespace: `training:${input.sessionId}` });
  const routePlanIdentity = await identity(routePlan);
  const manifestIdentity = await identity({ evidence_manifest_sha256: input.manifestSha256 });
  const sourceItemIdentities = await Promise.all(input.rows.map((row) => identity({
    book_author: row.bookAuthor,
    book_id: row.bookId,
    book_title: row.bookTitle,
    chunk_id: row.chunkId,
    chunk_index: row.chunkIndex,
    content_sha256: row.contentSha256,
    relevance_score_micros: Math.round(row.relevanceScore * 1_000_000),
    selection_index: row.selectionIndex,
    source_id: row.sourceId,
  })));
  const routeTargetIdentity = await identity({
    lane: 'interactive_generation',
    model: 'fixture-model',
    provider: 'fixture-provider',
    route_id: 'ssu-luna',
  });

  return Object.freeze({
    sourceManifest: {
      accountScopeIdentity: canonicalIdentity(accountScopeIdentity),
      causal: {
        manifestIdentity: canonicalIdentity(manifestIdentity),
        sessionContextIdentity: canonicalIdentity(contextIdentity),
        sourceItemIdentities: sourceItemIdentities.map(canonicalIdentity),
      },
      receiptKind: 'SOURCE_MANIFEST',
      subjectIdentity: canonicalIdentity(subjectIdentity),
    },
    trainingContext: {
      accountScopeIdentity: canonicalIdentity(accountScopeIdentity),
      causal: {
        cacheNamespaceIdentity: canonicalIdentity(cacheNamespaceIdentity),
        contextIdentity: canonicalIdentity(contextIdentity),
        routePlanIdentity: canonicalIdentity(routePlanIdentity),
        sessionIdentity: canonicalIdentity(sessionIdentity),
      },
      receiptKind: 'LEARNING_SESSION_CONTEXT',
      subjectIdentity: canonicalIdentity(subjectIdentity),
    },
    attempt: {
      accountScopeIdentity: canonicalIdentity(accountScopeIdentity),
      causal: {
        cacheNamespaceIdentity: canonicalIdentity(cacheNamespaceIdentity),
        contextIdentity: canonicalIdentity(contextIdentity),
        routeTargetIdentity: canonicalIdentity(routeTargetIdentity),
        sessionIdentity: canonicalIdentity(sessionIdentity),
        terminalOutcome: 'success',
        turnNumber: 1,
      },
      receiptKind: 'AI_INVOCATION_ATTEMPT',
      subjectIdentity: canonicalIdentity(subjectIdentity),
    },
  });
}

export async function createRuntimeReceiptFixture(options: {
  ownerKey?: string;
  sessionId?: string;
  contextId?: string;
  attemptId?: string;
} = {}): Promise<RuntimeReceiptFixture> {
  const ownerKey = options.ownerKey ?? FIXTURE_ACCOUNT_CANARY;
  const sessionId = options.sessionId ?? 'training-fixture-a';
  const contextId = options.contextId ?? 'trctx_fixture_a';
  const attemptId = options.attemptId ?? 'attempt-fixture-a-1';
  const query = 'Synthetic evidence query';
  const rows = await evidenceRows();
  const evidenceManifestSha256 = await manifestSha256(query, rows);
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
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
      created_at INTEGER NOT NULL DEFAULT 1700000000000,
      updated_at INTEGER NOT NULL DEFAULT 1700000000000
    );
  `);
  sqlite.exec(migration('0036_training_scenario_evidence_spine.sql'));
  sqlite.exec(`
    ALTER TABLE training_scenario_evidence ADD COLUMN char_start INTEGER;
    ALTER TABLE training_scenario_evidence ADD COLUMN char_end INTEGER;
    ALTER TABLE training_scenario_evidence ADD COLUMN lifecycle_status TEXT;
    ALTER TABLE training_scenario_evidence ADD COLUMN quarantined_at INTEGER;
    ALTER TABLE training_scenario_evidence ADD COLUMN deleted_at INTEGER;
  `);
  sqlite.exec(migration('0062_ai_invocation_attempt_receipts.sql'));
  sqlite.exec(migration('0063_learning_session_context.sql'));
  sqlite.exec(migration('0064_training_session_context.sql'));

  sqlite.prepare('INSERT INTO users (id) VALUES (?1)').run(ownerKey);
  sqlite.prepare(`INSERT INTO training_sessions (id, user_id, training_mode) VALUES (?1, ?2, 'scenario')`)
    .run(sessionId, ownerKey);
  sqlite.prepare(`UPDATE training_sessions SET context = ?1 WHERE id = ?2`)
    .run(FIXTURE_CLAIM_CANARY, sessionId);
  sqlite.prepare(`
    INSERT INTO training_scenario_packs (
      session_id, mode, evidence_query, evidence_status, evidence_manifest_sha256,
      source_count, book_count, scenario_json, rubric_json, created_at
    ) VALUES (?1, 'scenario', ?2, 'ready', ?3, ?4, 2, ?5, '[]', 1700000000000)
  `).run(
    sessionId,
    query,
    evidenceManifestSha256,
    rows.length,
    JSON.stringify({ private_fixture_canary: FIXTURE_BROWSER_CANARY }),
  );
  const insertEvidence = sqlite.prepare(`
    INSERT INTO training_scenario_evidence (
      id, session_id, source_id, selection_index, book_id, chunk_id, book_title,
      book_author, chunk_index, excerpt, content_sha256, relevance_score, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1700000000000)
  `);
  for (const row of rows) {
    insertEvidence.run(
      `evidence-${row.selectionIndex}`, sessionId, row.sourceId, row.selectionIndex,
      row.bookId, row.chunkId, row.bookTitle, row.bookAuthor, row.chunkIndex,
      row.excerpt, row.contentSha256, row.relevanceScore,
    );
  }
  sqlite.prepare(`UPDATE training_scenario_evidence SET lifecycle_status = 'active' WHERE session_id = ?1`)
    .run(sessionId);
  sqlite.prepare(`
    INSERT INTO training_session_contexts (
      id, session_id, owner_user_id, evidence_manifest_sha256, route_plan_json,
      prompt_cache_namespace, evidence_policy_revision, status, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'critical-path-b-v1', 'ACTIVE', 1700000000000, 1700000000000)
  `).run(contextId, sessionId, ownerKey, evidenceManifestSha256, JSON.stringify(FIXTURE_ROUTES), `training:${sessionId}`);
  sqlite.prepare(`
    INSERT INTO ai_invocation_attempts (
      id, invocation_id, invocation_kind, lane, route_id, provider, model,
      credential_alias, attempt_index, started_at, completed_at, latency_ms,
      outcome, failure_class, retryable, prompt_schema_version, prompt_version,
      prompt_sha256, response_sha256, prompt_tokens, completion_tokens, total_tokens,
      created_at, session_context_id, session_id, turn_number, prompt_cache_namespace
    ) VALUES (
      ?1, ?2, 'route', 'interactive_generation', 'ssu-luna', 'fixture-provider',
      'fixture-model', 'fixture-alias', 1, 1700000000000, 1700000000001, 1,
      'success', NULL, 0, 'fixture-schema-v1', 'fixture-prompt-v1', ?3, ?4,
      1, 1, 2, 1700000000001, ?5, ?6, 1, ?7
    )
  `).run(
    attemptId, `invocation-${attemptId}`, '4'.repeat(64), '5'.repeat(64),
    contextId, sessionId, `training:${sessionId}`,
  );

  const payloads = await expectedTrainingReceiptPayloads({
    ownerKey,
    sessionId,
    contextId,
    attemptId,
    manifestSha256: evidenceManifestSha256,
    rows,
  });
  const refs = Object.freeze({
    sourceManifest: Object.freeze({
      receipt_kind: 'SOURCE_MANIFEST' as const,
      receipt_id: sessionId,
      content_identity: await contentIdentity(canonicalDocument(payloads.sourceManifest)),
    }),
    trainingContext: Object.freeze({
      receipt_kind: 'LEARNING_SESSION_CONTEXT' as const,
      receipt_id: contextId,
      content_identity: await contentIdentity(canonicalDocument(payloads.trainingContext)),
    }),
    attempt: Object.freeze({
      receipt_kind: 'AI_INVOCATION_ATTEMPT' as const,
      receipt_id: attemptId,
      content_identity: await contentIdentity(canonicalDocument(payloads.attempt)),
    }),
  });

  return Object.freeze({
    sqlite,
    db: asD1Database(sqlite),
    ownerKey,
    sessionId,
    contextId,
    attemptId,
    manifestSha256: evidenceManifestSha256,
    refs,
    close: () => sqlite.close(),
  });
}
