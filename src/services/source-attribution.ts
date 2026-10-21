export type LearnerSessionKind = 'sparring' | 'training';
export type AttributionStatus = 'cited' | 'uncited' | 'unavailable';
export type AttributionLifecycle = 'active' | 'quarantined' | 'deleted' | null;

export interface AttributionManifestSource {
  sourceId: string;
  passage: string;
  bookId: string;
  bookTitle: string | null;
  bookAuthor: string | null;
  chunkIndex: number | null;
  charStart: number | null;
  charEnd: number | null;
  contentSha256: string;
  relevanceScore: number;
  lifecycleStatus: AttributionLifecycle;
}

export interface LearnerSourceAttribution {
  id: string;
  sessionKind: LearnerSessionKind;
  sessionId: string;
  turnNumber: number;
  status: AttributionStatus;
  evaluatorStatus: 'verified' | 'unavailable';
  claim: string;
  manifestSha256: string;
  unavailableReason: string | null;
  sources: Array<AttributionManifestSource & { lifecycleBadge: 'active' | 'quarantined' | 'deleted' | 'unknown' }>;
}

export interface PreparedLearnerSourceAttribution {
  attribution: LearnerSourceAttribution;
  statements: D1PreparedStatement[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function lifecycle(value: unknown): AttributionLifecycle {
  return value === 'active' || value === 'quarantined' || value === 'deleted' ? value : null;
}

function manifestJson(sources: AttributionManifestSource[]): string {
  return JSON.stringify({
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      bookId: source.bookId,
      contentSha256: source.contentSha256,
    })),
  });
}

function verifyEvaluatorSourceIds(value: unknown, sources: AttributionManifestSource[]): {
  status: AttributionStatus;
  evaluatorStatus: 'verified' | 'unavailable';
  ids: string[];
  unavailableReason: string | null;
} {
  if (!Array.isArray(value)) return { status: 'unavailable', evaluatorStatus: 'unavailable', ids: [], unavailableReason: 'evaluator_source_ids_missing_or_malformed' };
  if (!value.every((id) => typeof id === 'string' && id.trim().length > 0)) return { status: 'unavailable', evaluatorStatus: 'unavailable', ids: [], unavailableReason: 'evaluator_source_ids_missing_or_malformed' };
  const ids = value.map((id) => id.trim());
  if (new Set(ids).size !== ids.length) return { status: 'unavailable', evaluatorStatus: 'unavailable', ids: [], unavailableReason: 'evaluator_source_ids_duplicate' };
  const manifestIds = new Set(sources.map((source) => source.sourceId));
  if (!sources.length || new Set(sources.map((source) => source.sourceId)).size !== sources.length || sources.some((source) => !source.sourceId || !source.passage || !source.bookId || !source.contentSha256)) {
    return { status: 'unavailable', evaluatorStatus: 'unavailable', ids: [], unavailableReason: 'source_manifest_integrity_failure' };
  }
  if (ids.some((id) => !manifestIds.has(id))) return { status: 'unavailable', evaluatorStatus: 'unavailable', ids: [], unavailableReason: 'evaluator_source_id_not_in_manifest' };
  return ids.length === 0
    ? { status: 'uncited', evaluatorStatus: 'verified', ids, unavailableReason: null }
    : { status: 'cited', evaluatorStatus: 'verified', ids, unavailableReason: null };
}

export function prepareLearnerSourceAttribution(db: D1Database, input: {
  userId: string;
  sessionKind: LearnerSessionKind;
  sessionId: string;
  turnNumber: number;
  claim: string;
  manifestSha256: string;
  sources: AttributionManifestSource[];
  evaluatorSourceIds: unknown;
  evaluatorFallback?: boolean;
}): PreparedLearnerSourceAttribution {
  const verified = input.evaluatorFallback || !input.manifestSha256.trim()
    ? { status: 'unavailable' as const, evaluatorStatus: 'unavailable' as const, ids: [], unavailableReason: 'evaluator_fallback' }
    : verifyEvaluatorSourceIds(input.evaluatorSourceIds, input.sources);
  const selected = verified.status === 'cited'
    ? input.sources.filter((source) => verified.ids.includes(source.sourceId))
    : [];
  const id = `lca_${crypto.randomUUID()}`;
  const now = Date.now();
  const root = db.prepare(`
    INSERT INTO learner_claim_attributions (
      id, user_id, session_kind, session_id, turn_number, status, evaluator_status,
      claim_snapshot, manifest_sha256, manifest_json, unavailable_reason, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
  `).bind(id, input.userId, input.sessionKind, input.sessionId, input.turnNumber, verified.status, verified.evaluatorStatus, input.claim, input.manifestSha256, manifestJson(input.sources), verified.unavailableReason, now);
  const children = selected.map((source, index) => db.prepare(`
    INSERT INTO learner_claim_attribution_sources (
      id, attribution_id, source_id, passage_snapshot, book_id, book_title, book_author,
      chunk_index, char_start, char_end, content_sha256, relevance_score, lifecycle_status, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
  `).bind(
    `${id}:${index + 1}`, id, source.sourceId, source.passage, source.bookId,
    source.bookTitle, source.bookAuthor, source.chunkIndex, source.charStart,
    source.charEnd, source.contentSha256, source.relevanceScore, source.lifecycleStatus, now,
  ));
  return {
    statements: [root, ...children],
    attribution: {
    id,
    sessionKind: input.sessionKind,
    sessionId: input.sessionId,
    turnNumber: input.turnNumber,
    status: verified.status,
    evaluatorStatus: verified.evaluatorStatus,
    claim: input.claim,
    manifestSha256: input.manifestSha256,
    unavailableReason: verified.unavailableReason,
    sources: selected.map((source) => ({ ...source, lifecycleBadge: source.lifecycleStatus || 'unknown' })),
    },
  };
}

export async function persistLearnerSourceAttribution(db: D1Database, input: {
  userId: string;
  sessionKind: LearnerSessionKind;
  sessionId: string;
  turnNumber: number;
  claim: string;
  manifestSha256: string;
  sources: AttributionManifestSource[];
  evaluatorSourceIds: unknown;
  evaluatorFallback?: boolean;
}): Promise<LearnerSourceAttribution> {
  const prepared = prepareLearnerSourceAttribution(db, input);
  await db.batch(prepared.statements);
  return prepared.attribution;
}

export async function loadLearnerSourceAttributions(db: D1Database, input: {
  userId: string;
  sessionKind: LearnerSessionKind;
  sessionId: string;
}): Promise<LearnerSourceAttribution[]> {
  const roots = await db.prepare(`
    SELECT id, session_kind, session_id, turn_number, status, evaluator_status,
           claim_snapshot, manifest_sha256, unavailable_reason
    FROM learner_claim_attributions
    WHERE user_id = ?1 AND session_kind = ?2 AND session_id = ?3
    ORDER BY turn_number ASC
  `).bind(input.userId, input.sessionKind, input.sessionId).all<Record<string, unknown>>();
  const rootRows = roots.results || [];
  if (!rootRows.length) return [];
  const children = await db.prepare(`
    SELECT attribution_id, source_id, passage_snapshot, book_id, book_title, book_author,
           chunk_index, char_start, char_end, content_sha256, relevance_score, lifecycle_status
    FROM learner_claim_attribution_sources
    WHERE attribution_id IN (${rootRows.map(() => '?').join(', ')})
    ORDER BY attribution_id ASC, id ASC
  `).bind(...rootRows.map((row) => String(row.id))).all<Record<string, unknown>>();
  const byRoot = new Map<string, AttributionManifestSource[]>();
  for (const row of children.results || []) {
    const source: AttributionManifestSource = {
      sourceId: String(row.source_id), passage: String(row.passage_snapshot), bookId: String(row.book_id),
      bookTitle: stringOrNull(row.book_title), bookAuthor: stringOrNull(row.book_author),
      chunkIndex: numberOrNull(row.chunk_index), charStart: numberOrNull(row.char_start), charEnd: numberOrNull(row.char_end),
      contentSha256: String(row.content_sha256), relevanceScore: Number(row.relevance_score), lifecycleStatus: lifecycle(row.lifecycle_status),
    };
    const key = String(row.attribution_id); byRoot.set(key, [...(byRoot.get(key) || []), source]);
  }
  return rootRows.map((row) => {
    const sources = byRoot.get(String(row.id)) || [];
    return {
      id: String(row.id), sessionKind: row.session_kind as LearnerSessionKind, sessionId: String(row.session_id),
      turnNumber: Number(row.turn_number), status: row.status as AttributionStatus,
      evaluatorStatus: row.evaluator_status === 'verified' ? 'verified' : 'unavailable',
      claim: String(row.claim_snapshot), manifestSha256: String(row.manifest_sha256),
      unavailableReason: stringOrNull(row.unavailable_reason),
      sources: sources.map((source) => ({ ...source, lifecycleBadge: source.lifecycleStatus || 'unknown' })),
    };
  });
}
