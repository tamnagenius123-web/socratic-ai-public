import {
  buildHaneulHarborScenario,
  hasExactCaseSourceIdentities,
  hasExactTrainingCaseSnapshot,
  readStoredTrainingCaseContract,
  resolveTrainingCase,
  type TrainingCaseContractProjection,
  type TrainingCaseDefinition,
  type TrainingCaseEvidenceSource,
} from './case-contracts/haneul-harbor-investment';

const MIN_BOOKS = 2;
const MIN_EVIDENCE_ITEMS = 3;
const DEFAULT_EVIDENCE_ITEMS = 6;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_BOOK_IDS = 8;
const MAX_CANDIDATE_CHUNKS_PER_BOOK = 240;
const MAX_EXCERPT_LENGTH = 1_200;

export type TrainingScenarioDifficulty = 'beginner' | 'intermediate' | 'advanced';

export interface ScenarioAIEnvironment {
  DEEPSEEK_API_KEY?: string;
  SOONGSIL_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

export interface TrainingScenarioEvidenceInput {
  category: string;
  categoryLabel?: string;
  difficulty: TrainingScenarioDifficulty;
  evidenceQuery: string;
  evidenceBookIds: string[];
  ownerUserId: string;
  maxEvidenceItems?: number;
  followUpVariant?: { launchId: string; changedCondition: string; semanticValidation: 'UNKNOWN' };
  caseDefinition?: TrainingCaseDefinition;
}

export interface LibraryEvidenceSource {
  sourceId: string;
  selectionIndex: number;
  bookId: string;
  bookTitle: string;
  bookAuthor: string;
  chunkId: string;
  chunkIndex: number;
  charStart: number | null;
  charEnd: number | null;
  excerpt: string;
  contentSha256: string;
  relevanceScore: number;
  lifecycleStatus: 'active' | 'quarantined' | 'deleted' | null;
}

export interface ReadyTrainingEvidencePack {
  status: 'ready';
  query: string;
  sources: LibraryEvidenceSource[];
  manifestSha256: string;
  sourceCount: number;
  bookCount: number;
}

export interface InsufficientTrainingEvidencePack {
  status: 'insufficient';
  query: string;
  reason:
    | 'requires_two_library_books'
    | 'evidence_query_too_short'
    | 'library_chunks_not_found'
    | 'not_enough_relevant_evidence'
    | 'case_source_identity_mismatch';
  availableBookCount: number;
  relevantSourceCount: number;
}

export type TrainingEvidencePack =
  | ReadyTrainingEvidencePack
  | InsufficientTrainingEvidencePack;

export interface ScenarioRubricCriterion {
  id: string;
  label: string;
  description: string;
  weight: number;
}

export interface EvidenceGroundedScenario {
  followUpVariant?: TrainingScenarioEvidenceInput['followUpVariant'];
  caseContract?: TrainingCaseContractProjection;
  title: string;
  role: string;
  context: string;
  decisionQuestion: string;
  constraints: string[];
  stakeholders: string[];
  tradeoffs: string[];
  expectedTensions: string[];
  sessionGoal: string;
  evidenceSourceIds: string[];
  rubric: ScenarioRubricCriterion[];
}

export interface TrainingQuestionPayload {
  title: string;
  question: string;
  context: string;
  expected_tensions: string[];
  sessionGoal: string;
  briefing: {
    summary: string;
    key_numbers: string[];
    angles: string[];
    sources: Array<{
      sourceId: string;
      title: string;
      author: string;
      type: 'library';
      summary: string;
      contentSha256: string;
    }>;
  };
}

export interface ReadyEvidenceGroundedScenario {
  status: 'ready';
  evidencePack: ReadyTrainingEvidencePack;
  scenario: EvidenceGroundedScenario;
  question: TrainingQuestionPayload;
}

export type LoadedTrainingCaseContract =
  | { status: 'not_applicable'; caseContract: null }
  | { status: 'ready'; caseContract: TrainingCaseContractProjection }
  | { status: 'broken'; reason: 'TRAINING_CASE_SNAPSHOT_INVALID' };

export type EvidenceGroundedScenarioBuild =
  | ReadyEvidenceGroundedScenario
  | {
      status: 'insufficient';
      evidencePack: InsufficientTrainingEvidencePack;
    };

export type LoadedTrainingScenarioContext =
  | { status: 'none' }
  | {
      status: 'ready';
      context: string;
      manifestSha256: string;
      sources: LibraryEvidenceSource[];
    }
  | {
      status: 'broken';
      reason:
        | 'invalid_pack_record'
        | 'missing_evidence_pack'
        | 'invalid_evidence_snapshot'
        | 'missing_evidence_rows'
        | 'content_hash_mismatch'
        | 'source_count_mismatch'
        | 'book_count_mismatch'
        | 'manifest_mismatch';
    };

interface LibraryChunkRow {
  chunkId: string;
  bookId: string;
  chunkIndex: number;
  charStart: number | null;
  charEnd: number | null;
  content: string;
  bookTitle: string;
  bookAuthor: string;
  lifecycleStatus: 'active' | 'quarantined' | 'deleted' | null;
}

interface ScoredLibraryChunk extends LibraryChunkRow {
  relevanceScore: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeBookIds(bookIds: string[]): string[] {
  return uniqueStrings(
    bookIds
      .map((bookId) => bookId.trim())
      .filter((bookId) => /^[a-zA-Z0-9_-]{1,120}$/.test(bookId)),
  ).slice(0, MAX_BOOK_IDS);
}

function tokenize(value: string): string[] {
  return uniqueStrings(
    value
      .toLocaleLowerCase('ko-KR')
      .replace(/[^a-z0-9가-힣]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  ).slice(0, 24);
}

function parseLibraryChunkRow(value: unknown): LibraryChunkRow | null {
  if (!isRecord(value)) return null;

  const chunkId = readString(value.chunk_id);
  const bookId = readString(value.book_id);
  const content = readString(value.content);
  const bookTitle = readString(value.book_title);
  const bookAuthor = readString(value.book_author);
  const chunkIndex = readNumber(value.chunk_index);
  const charStart = readNumber(value.char_start);
  const charEnd = readNumber(value.char_end);
  const lifecycleStatus = value.lifecycle_status === 'active' || value.lifecycle_status === 'quarantined' || value.lifecycle_status === 'deleted' ? value.lifecycle_status : null;

  if (!chunkId || !bookId || !content || !bookTitle || chunkIndex === null) {
    return null;
  }

  return {
    chunkId,
    bookId,
    chunkIndex,
    charStart,
    charEnd,
    content,
    bookTitle,
    bookAuthor,
    lifecycleStatus,
  };
}

function scoreChunk(row: LibraryChunkRow, tokens: string[]): number {
  if (tokens.length === 0) return 0;

  const content = row.content.toLocaleLowerCase('ko-KR');
  const metadata = `${row.bookTitle} ${row.bookAuthor}`.toLocaleLowerCase('ko-KR');
  let contentMatches = 0;
  let metadataMatches = 0;

  for (const token of tokens) {
    if (content.includes(token)) contentMatches += 1;
    if (metadata.includes(token)) metadataMatches += 1;
  }

  if (contentMatches === 0 && metadataMatches === 0) return 0;
  const coverage = contentMatches / tokens.length;
  const metadataBoost = metadataMatches / tokens.length;
  return Number((coverage + metadataBoost * 0.25).toFixed(4));
}

function excerptWindow(row: LibraryChunkRow): {
  excerpt: string;
  charStart: number | null;
  charEnd: number | null;
} {
  // Ingestion coordinates use JavaScript string indices. The stored chunk can
  // retain whitespace, while the learner-visible excerpt is capped and trimmed.
  // Derive coordinates from that exact same window so passage, hash, and range
  // identify identical text.
  const sourceStart = row.charStart;
  const sourceEnd = row.charEnd;
  const capped = row.content.slice(0, MAX_EXCERPT_LENGTH);
  const leadingTrim = capped.length - capped.trimStart().length;
  const excerpt = capped.trim();
  // Ingestion historically trimmed the stored chunk while retaining the
  // pre-trim source range. Exact leading/trailing trim distribution is only
  // provable when the retained range length equals the stored chunk length.
  if (
    typeof sourceStart !== 'number'
    || typeof sourceEnd !== 'number'
    || !Number.isInteger(sourceStart)
    || !Number.isInteger(sourceEnd)
    || sourceStart < 0
    || sourceEnd < sourceStart
    || sourceEnd - sourceStart !== row.content.length
  ) {
    return { excerpt, charStart: null, charEnd: null };
  }
  const charStart = sourceStart + leadingTrim;
  const charEnd = charStart + excerpt.length;
  if (sourceEnd < charEnd) {
    return { excerpt, charStart: null, charEnd: null };
  }
  return { excerpt, charStart, charEnd };
}

function selectBalancedEvidence(
  chunks: ScoredLibraryChunk[],
  maxEvidenceItems: number,
): ScoredLibraryChunk[] {
  const grouped = new Map<string, ScoredLibraryChunk[]>();
  for (const chunk of chunks) {
    const current = grouped.get(chunk.bookId) || [];
    current.push(chunk);
    grouped.set(chunk.bookId, current);
  }

  for (const group of grouped.values()) {
    group.sort((a, b) =>
      b.relevanceScore - a.relevanceScore
      || a.chunkIndex - b.chunkIndex
      || a.chunkId.localeCompare(b.chunkId),
    );
  }

  const selected: ScoredLibraryChunk[] = [];
  const selectedIds = new Set<string>();
  const bestPerBook = [...grouped.values()]
    .map((group) => group[0])
    .sort((a, b) =>
      b.relevanceScore - a.relevanceScore
      || a.bookId.localeCompare(b.bookId),
    );

  for (const chunk of bestPerBook) {
    if (selected.length >= maxEvidenceItems) break;
    selected.push(chunk);
    selectedIds.add(chunk.chunkId);
  }

  const remaining = chunks
    .filter((chunk) => !selectedIds.has(chunk.chunkId))
    .sort((a, b) =>
      b.relevanceScore - a.relevanceScore
      || a.bookId.localeCompare(b.bookId)
      || a.chunkIndex - b.chunkIndex,
    );

  for (const chunk of remaining) {
    if (selected.length >= maxEvidenceItems) break;
    selected.push(chunk);
  }

  return selected;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function evidenceManifestSha256(
  query: string,
  sources: LibraryEvidenceSource[],
): Promise<string> {
  const manifest = JSON.stringify({
    query,
    sources: [...sources]
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
      .map((source) => ({
        sourceId: source.sourceId,
        selectionIndex: source.selectionIndex,
        bookId: source.bookId,
        bookTitle: source.bookTitle,
        bookAuthor: source.bookAuthor,
        chunkId: source.chunkId,
        chunkIndex: source.chunkIndex,
        contentSha256: source.contentSha256,
        relevanceScore: source.relevanceScore,
      })),
  });
  return sha256Hex(manifest);
}

export async function retrieveTrainingScenarioEvidence(
  db: D1Database,
  input: TrainingScenarioEvidenceInput,
): Promise<TrainingEvidencePack> {
  const query = input.evidenceQuery.trim().slice(0, 600);
  const bookIds = normalizeBookIds(input.evidenceBookIds);

  if (bookIds.length < MIN_BOOKS) {
    return {
      status: 'insufficient',
      query,
      reason: 'requires_two_library_books',
      availableBookCount: bookIds.length,
      relevantSourceCount: 0,
    };
  }

  const tokens = tokenize(query);
  if (query.length < 4 || tokens.length === 0) {
    return {
      status: 'insufficient',
      query,
      reason: 'evidence_query_too_short',
      availableBookCount: bookIds.length,
      relevantSourceCount: 0,
    };
  }

  // Bound each source independently so a long book cannot exhaust the shared
  // candidate window before the other disciplines are considered.
  const chunksPerBook = MAX_CANDIDATE_CHUNKS_PER_BOOK;
  const results = await db.batch(bookIds.map((bookId) => db.prepare(`
    SELECT
      dc.id AS chunk_id,
      dc.book_id,
      dc.chunk_index,
      dc.char_start,
      dc.char_end,
      dc.content,
      b.title AS book_title,
      b.author AS book_author,
      b.lifecycle_status
    FROM document_chunks dc
    INNER JOIN books b ON b.id = dc.book_id
    WHERE dc.book_id = ?1
      AND b.lifecycle_status = 'active'
      AND (
        (b.is_builtin = 1 AND b.visibility = 'builtin')
        OR (b.owner_user_id = ?3 AND b.visibility = 'private')
      )
    ORDER BY dc.chunk_index ASC
    LIMIT ?2
  `).bind(bookId, chunksPerBook, input.ownerUserId)));

  const rows = results
    .flatMap((result) => result.results || [])
    .map(parseLibraryChunkRow)
    .filter((row): row is LibraryChunkRow => row !== null);

  const availableBookCount = new Set(rows.map((row) => row.bookId)).size;
  if (rows.length === 0 || availableBookCount < MIN_BOOKS) {
    return {
      status: 'insufficient',
      query,
      reason: 'library_chunks_not_found',
      availableBookCount,
      relevantSourceCount: 0,
    };
  }

  const scored = rows
    .map((row): ScoredLibraryChunk => ({
      ...row,
      relevanceScore: scoreChunk(row, tokens),
    }))
    .filter((row) => row.relevanceScore > 0);

  const maxEvidenceItems = Math.min(
    MAX_EVIDENCE_ITEMS,
    Math.max(
      MIN_EVIDENCE_ITEMS,
      Math.trunc(input.maxEvidenceItems || DEFAULT_EVIDENCE_ITEMS),
    ),
  );
  const selected = selectBalancedEvidence(scored, maxEvidenceItems);
  const selectedBookCount = new Set(selected.map((row) => row.bookId)).size;

  if (selected.length < MIN_EVIDENCE_ITEMS || selectedBookCount < MIN_BOOKS) {
    return {
      status: 'insufficient',
      query,
      reason: 'not_enough_relevant_evidence',
      availableBookCount,
      relevantSourceCount: scored.length,
    };
  }

  const sources = await Promise.all(selected.map(async (row, index): Promise<LibraryEvidenceSource> => {
    const window = excerptWindow(row);
    return {
      sourceId: `library:${row.bookId}:${row.chunkId}`,
      selectionIndex: index,
      bookId: row.bookId,
      bookTitle: row.bookTitle,
      bookAuthor: row.bookAuthor,
      chunkId: row.chunkId,
      chunkIndex: row.chunkIndex,
      charStart: window.charStart,
      charEnd: window.charEnd,
      excerpt: window.excerpt,
      contentSha256: await sha256Hex(window.excerpt),
      relevanceScore: row.relevanceScore,
      lifecycleStatus: row.lifecycleStatus,
    };
  }));

  return {
    status: 'ready',
    query,
    sources,
    manifestSha256: await evidenceManifestSha256(query, sources),
    sourceCount: sources.length,
    bookCount: new Set(sources.map((source) => source.bookId)).size,
  };
}

function parseRubric(value: unknown): ScenarioRubricCriterion[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item): ScenarioRubricCriterion | null => {
      if (!isRecord(item)) return null;
      const id = readString(item.id);
      const label = readString(item.label);
      const description = readString(item.description);
      const weight = readNumber(item.weight);
      if (!id || !label || !description || weight === null || weight <= 0 || weight > 1) {
        return null;
      }
      return { id, label, description, weight };
    })
    .filter((criterion): criterion is ScenarioRubricCriterion => criterion !== null);
}

function parseScenario(
  value: unknown,
  sourceBookIds: Map<string, string>,
): EvidenceGroundedScenario {
  if (!isRecord(value)) {
    throw new Error('scenario_output_not_an_object');
  }

  const title = readString(value.title);
  const role = readString(value.role);
  const context = readString(value.context);
  const decisionQuestion = readString(value.decision_question ?? value.decisionQuestion);
  const constraints = readStringArray(value.constraints);
  const stakeholders = readStringArray(value.stakeholders);
  const tradeoffs = readStringArray(value.tradeoffs);
  const expectedTensions = readStringArray(value.expected_tensions ?? value.expectedTensions);
  const sessionGoal = readString(value.session_goal ?? value.sessionGoal);
  const evidenceSourceIds = uniqueStrings(readStringArray(value.evidence_source_ids ?? value.evidenceSourceIds));
  const rubric = parseRubric(value.rubric);
  const caseContract = value.caseContract === undefined
    ? undefined
    : readStoredTrainingCaseContract(value.caseContract);
  const rubricWeight = rubric.reduce((sum, criterion) => sum + criterion.weight, 0);

  const invalidSourceId = evidenceSourceIds.some((sourceId) => !sourceBookIds.has(sourceId));
  const citedBookCount = new Set(
    evidenceSourceIds
      .map((sourceId) => sourceBookIds.get(sourceId))
      .filter((bookId): bookId is string => typeof bookId === 'string'),
  ).size;
  if (
    !title
    || !role
    || !context
    || !decisionQuestion
    || constraints.length < 2
    || stakeholders.length < 2
    || tradeoffs.length < 2
    || expectedTensions.length < 2
    || !sessionGoal
    || evidenceSourceIds.length < MIN_BOOKS
    || citedBookCount < MIN_BOOKS
    || invalidSourceId
    || rubric.length < 3
    || Math.abs(rubricWeight - 1) > 0.05
    || (value.caseContract !== undefined && !caseContract)
  ) {
    throw new Error('scenario_output_failed_grounding_contract');
  }

  return {
    ...(caseContract ? { caseContract } : {}),
    title,
    role,
    context,
    decisionQuestion,
    constraints,
    stakeholders,
    tradeoffs,
    expectedTensions,
    sessionGoal,
    evidenceSourceIds,
    rubric,
  };
}

function extractKeyNumbers(sources: LibraryEvidenceSource[]): string[] {
  const values: string[] = [];
  for (const source of sources) {
    const matches = source.excerpt.match(/\b\d+(?:[.,]\d+)?(?:%|년|명|개|원|달러|배)?\b/g) || [];
    for (const match of matches) {
      if (!values.includes(match)) values.push(match);
      if (values.length >= 5) return values;
    }
  }
  return values;
}

function toTrainingQuestion(
  scenario: EvidenceGroundedScenario,
  evidencePack: ReadyTrainingEvidencePack,
): TrainingQuestionPayload {
  return {
    title: scenario.title,
    question: `${scenario.role}의 입장에서 다음 결정을 내려야 합니다. ${scenario.decisionQuestion}`,
    context: [
      scenario.context,
      `제약: ${scenario.constraints.join(' / ')}`,
      `이해관계자: ${scenario.stakeholders.join(', ')}`,
    ].join('\n'),
    expected_tensions: scenario.expectedTensions,
    sessionGoal: scenario.sessionGoal,
    briefing: {
      summary: scenario.context,
      key_numbers: extractKeyNumbers(evidencePack.sources),
      angles: scenario.tradeoffs,
      sources: evidencePack.sources.map((source) => ({
        sourceId: source.sourceId,
        title: source.bookTitle,
        author: source.bookAuthor,
        type: 'library',
        summary: source.excerpt,
        contentSha256: source.contentSha256,
      })),
    },
  };
}

export async function buildEvidenceGroundedTrainingScenario(
  _env: ScenarioAIEnvironment,
  db: D1Database,
  input: TrainingScenarioEvidenceInput,
): Promise<EvidenceGroundedScenarioBuild> {
  const evidencePack = await retrieveTrainingScenarioEvidence(db, input);
  if (evidencePack.status !== 'ready') {
    return { status: 'insufficient', evidencePack };
  }

  if (input.caseDefinition && !hasExactCaseSourceIdentities(input.caseDefinition, evidencePack.sources)) {
    return {
      status: 'insufficient',
      evidencePack: {
        status: 'insufficient',
        query: evidencePack.query,
        reason: 'case_source_identity_mismatch',
        availableBookCount: evidencePack.bookCount,
        relevantSourceCount: evidencePack.sourceCount,
      },
    };
  }

  const sourceTitles = [...new Set(evidencePack.sources.map((source) => source.bookTitle))];
  const category = input.categoryLabel?.trim() || input.category.trim();
  const scenario: EvidenceGroundedScenario = input.caseDefinition
    ? buildHaneulHarborScenario(input.caseDefinition, evidencePack.sources.map((source) => source.sourceId))
    : {
    title: `${category} 근거 기반 의사결정`,
    role: '서로 다른 근거를 검토하는 학습자',
    context: `“${evidencePack.query}”에 관한 ${sourceTitles.length}권의 자료를 비교해 판단해야 합니다.`,
    decisionQuestion: `제공된 근거를 바탕으로 ${category}에 관해 어떤 결정을 내리겠습니까?`,
    constraints: [
      '제공된 자료의 구체적인 근거를 최소 두 개 사용합니다.',
      '근거가 뒷받침하지 않는 사실은 단정하지 않습니다.',
    ],
    stakeholders: ['학습자', '결정의 영향을 받는 사람들'],
    tradeoffs: ['결정의 기대 효과와 비용', '빠른 결론과 추가 검토의 필요성'],
    expectedTensions: ['서로 일치하지 않는 근거의 해석', '확실한 정보와 남아 있는 불확실성'],
    sessionGoal: '출처를 인용하고 반대 근거까지 고려한 판단을 구성하기',
    evidenceSourceIds: evidencePack.sources.map((source) => source.sourceId),
    rubric: [
      { id: 'claim', label: '주장', description: '질문에 답하는 분명한 판단을 제시합니다.', weight: 0.34 },
      { id: 'evidence', label: '근거', description: '제공된 자료를 정확하게 연결합니다.', weight: 0.33 },
      { id: 'tradeoff', label: '균형', description: '반대 근거와 불확실성을 함께 다룹니다.', weight: 0.33 },
    ],
  };

  if (input.followUpVariant) {
    scenario.followUpVariant = input.followUpVariant;
    scenario.context += '\n학습자가 정한 가정 조건 (자료에서 확인된 사실이 아님): ' + input.followUpVariant.changedCondition;
    scenario.decisionQuestion += ' 이 조건에서 이전 판단의 인과적 이유를 다시 구성하고, 유지되는 부분과 달라지는 부분을 근거로 설명해 주세요.';
    scenario.constraints.push('가정 조건과 출처가 확인한 사실을 구분합니다.');
  }

  return {
    status: 'ready',
    evidencePack,
    scenario,
    question: toTrainingQuestion(scenario, evidencePack),
  };
}

export function buildTrainingScenarioPersistenceStatements(
  db: D1Database,
  sessionId: string,
  build: ReadyEvidenceGroundedScenario,
  createdAt: number,
) {
  const caseContract = build.scenario.caseContract === undefined
    ? null
    : readStoredTrainingCaseContract(build.scenario.caseContract);
  if (build.scenario.caseContract !== undefined && !caseContract) {
    throw new Error('training_case_contract_persistence_invalid');
  }
  const pack = db.prepare(`
    INSERT INTO training_scenario_packs (
      session_id, mode, evidence_query, evidence_status,
      evidence_manifest_sha256, source_count, book_count,
      scenario_json, rubric_json, created_at,
      case_id, case_version, case_contract_sha256
    ) VALUES (?1, 'scenario', ?2, 'ready', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  `).bind(
    sessionId,
    build.evidencePack.query,
    build.evidencePack.manifestSha256,
    build.evidencePack.sourceCount,
    build.evidencePack.bookCount,
    JSON.stringify(build.scenario),
    JSON.stringify(build.scenario.rubric),
    createdAt,
    caseContract?.caseId ?? null,
    caseContract?.caseVersion ?? null,
    caseContract?.contractSnapshotSha256 ?? null,
  );

  const evidence = build.evidencePack.sources.map((source, index) =>
    db.prepare(`
      INSERT INTO training_scenario_evidence (
        id, session_id, source_id, selection_index, book_id, chunk_id,
        book_title, book_author, chunk_index, char_start, char_end, excerpt,
        content_sha256, relevance_score, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
    `).bind(
      `${sessionId}:${index + 1}:${source.contentSha256.slice(0, 16)}`,
      sessionId,
      source.sourceId,
      source.selectionIndex,
      source.bookId,
      source.chunkId,
      source.bookTitle,
      source.bookAuthor,
      source.chunkIndex,
      source.charStart,
      source.charEnd,
      source.excerpt,
      source.contentSha256,
      source.relevanceScore,
      createdAt,
    ),
  );

  return [pack, ...evidence];
}

export async function loadTrainingCaseContractProjection(
  db: D1Database,
  sessionId: string,
): Promise<LoadedTrainingCaseContract> {
  const pack = await db.prepare(
    'SELECT case_id, case_version, case_contract_sha256, scenario_json, rubric_json FROM training_scenario_packs WHERE session_id = ?1',
  ).bind(sessionId).first<Record<string, unknown>>();
  if (!pack) return { status: 'not_applicable', caseContract: null };

  const caseId = typeof pack.case_id === 'string' && pack.case_id.length > 0 ? pack.case_id : null;
  const caseVersion = typeof pack.case_version === 'string' && pack.case_version.length > 0 ? pack.case_version : null;
  const contractSnapshotSha256 = typeof pack.case_contract_sha256 === 'string' && pack.case_contract_sha256.length > 0
    ? pack.case_contract_sha256
    : null;
  if (caseId === null && caseVersion === null && contractSnapshotSha256 === null) {
    try {
      const scenario = JSON.parse(readString(pack.scenario_json));
      if (isRecord(scenario) && Object.prototype.hasOwnProperty.call(scenario, 'caseContract')) {
        return { status: 'broken', reason: 'TRAINING_CASE_SNAPSHOT_INVALID' };
      }
    } catch {
      // A legacy/generic pack has no case-bound identity to validate here.
    }
    return { status: 'not_applicable', caseContract: null };
  }
  if (!caseId || !caseVersion || !contractSnapshotSha256) {
    return { status: 'broken', reason: 'TRAINING_CASE_SNAPSHOT_INVALID' };
  }

  const definition = resolveTrainingCase(caseId);
  if (!definition
    || definition.projection.caseVersion !== caseVersion
    || definition.projection.contractSnapshotSha256 !== contractSnapshotSha256) {
    return { status: 'broken', reason: 'TRAINING_CASE_SNAPSHOT_INVALID' };
  }

  try {
    const scenario = JSON.parse(readString(pack.scenario_json));
    const rubric = JSON.parse(readString(pack.rubric_json));
    const evidence = await db.prepare(`
      SELECT source_id, book_id, book_title, book_author, chunk_id
      FROM training_scenario_evidence
      WHERE session_id = ?1
      ORDER BY selection_index ASC
    `).bind(sessionId).all<Record<string, unknown>>();
    const sources = (evidence.results || []).map((value): TrainingCaseEvidenceSource | null => {
      if (!isRecord(value)) return null;
      const sourceId = typeof value.source_id === 'string' && value.source_id.length > 0 ? value.source_id : null;
      const bookId = typeof value.book_id === 'string' && value.book_id.length > 0 ? value.book_id : null;
      const bookTitle = typeof value.book_title === 'string' && value.book_title.length > 0 ? value.book_title : null;
      const bookAuthor = typeof value.book_author === 'string' && value.book_author.length > 0 ? value.book_author : null;
      const chunkId = typeof value.chunk_id === 'string' && value.chunk_id.length > 0 ? value.chunk_id : null;
      return sourceId && bookId && bookTitle && bookAuthor && chunkId
        ? { sourceId, bookId, bookTitle, bookAuthor, chunkId }
        : null;
    });
    if (sources.some((source) => source === null)
      || !hasExactTrainingCaseSnapshot(
        definition,
        scenario,
        rubric,
        sources.filter((source): source is TrainingCaseEvidenceSource => source !== null),
      )) {
      return { status: 'broken', reason: 'TRAINING_CASE_SNAPSHOT_INVALID' };
    }
    const caseContract = isRecord(scenario)
      ? readStoredTrainingCaseContract(scenario.caseContract)
      : null;
    return caseContract
      ? { status: 'ready', caseContract }
      : { status: 'broken', reason: 'TRAINING_CASE_SNAPSHOT_INVALID' };
  } catch {
    return { status: 'broken', reason: 'TRAINING_CASE_SNAPSHOT_INVALID' };
  }
}

function parseEvidenceSnapshot(value: unknown): LibraryEvidenceSource | null {
  if (!isRecord(value)) return null;

  const sourceId = readString(value.source_id);
  const selectionIndex = readNumber(value.selection_index);
  const bookId = readString(value.book_id);
  const bookTitle = readString(value.book_title);
  const bookAuthor = readString(value.book_author);
  const chunkId = readString(value.chunk_id);
  const chunkIndex = readNumber(value.chunk_index);
  const charStart = readNumber(value.char_start);
  const charEnd = readNumber(value.char_end);
  const excerpt = readString(value.excerpt);
  const contentSha256 = readString(value.content_sha256);
  const relevanceScore = readNumber(value.relevance_score);
  const snapshotLifecycle = value.lifecycle_status === 'active' || value.lifecycle_status === 'quarantined' || value.lifecycle_status === 'deleted' ? value.lifecycle_status : null;
  const bookLifecycle = value.book_lifecycle_status === 'active' || value.book_lifecycle_status === 'quarantined' || value.book_lifecycle_status === 'deleted' ? value.book_lifecycle_status : null;
  const bookVisibility = readString(value.book_visibility);
  // Preserve the excerpt/hash snapshot while deriving a display badge from the
  // current book state. A missing lifecycle remains explicitly unknown.
  const lifecycleStatus = bookLifecycle === 'deleted' || snapshotLifecycle === 'deleted'
    ? 'deleted'
    : bookVisibility === 'quarantined' || bookLifecycle === 'quarantined' || snapshotLifecycle === 'quarantined'
      ? 'quarantined'
      : bookLifecycle === 'active'
        ? 'active'
        : null;

  if (
    !sourceId
    || selectionIndex === null
    || !bookId
    || !bookTitle
    || !chunkId
    || chunkIndex === null
    || !excerpt
    || !/^[a-f0-9]{64}$/.test(contentSha256)
    || relevanceScore === null
  ) {
    return null;
  }

  return {
    sourceId,
    selectionIndex,
    bookId,
    bookTitle,
    bookAuthor,
    chunkId,
    chunkIndex,
    charStart,
    charEnd,
    excerpt,
    contentSha256,
    relevanceScore,
    lifecycleStatus,
  };
}

function formatEvidenceContext(
  manifestSha256: string,
  sources: LibraryEvidenceSource[],
  scenario: EvidenceGroundedScenario,
): string {
  const blocks = sources.map((source) => [
    `[SOURCE_ID=${source.sourceId}]`,
    `도서: ${source.bookTitle}`,
    `저자: ${source.bookAuthor || '미상'}`,
    `청크: ${source.chunkIndex}`,
    source.excerpt,
  ].join('\n'));

  return [
    `[TRAINING_SCENARIO_EVIDENCE manifest_sha256=${manifestSha256}]`,
    [
      `[SCENARIO] ${scenario.title}`,
      `역할: ${scenario.role}`,
      `결정 질문: ${scenario.decisionQuestion}`,
      `제약: ${scenario.constraints.join(' / ')}`,
      `이해관계자: ${scenario.stakeholders.join(', ')}`,
      `트레이드오프: ${scenario.tradeoffs.join(' / ')}`,
      `평가 기준: ${scenario.rubric.map((criterion) => `${criterion.label}(${criterion.weight})`).join(' / ')}`,
    ].join('\n'),
    ...blocks,
  ].join('\n\n---\n\n');
}

export async function loadTrainingScenarioEvidenceContext(
  db: D1Database,
  sessionId: string,
): Promise<LoadedTrainingScenarioContext> {
  const pack = await db.prepare(`
    SELECT
      ts.training_mode,
      tsp.session_id AS pack_session_id,
      tsp.evidence_query,
      tsp.evidence_status,
      tsp.evidence_manifest_sha256,
      tsp.source_count,
      tsp.book_count,
      tsp.scenario_json,
      tsp.rubric_json
    FROM training_sessions ts
    LEFT JOIN training_scenario_packs tsp ON tsp.session_id = ts.id
    WHERE ts.id = ?1
  `).bind(sessionId).first();

  if (!pack) return { status: 'none' };
  if (!isRecord(pack)) return { status: 'broken', reason: 'invalid_pack_record' };

  const trainingMode = readString(pack.training_mode);
  const packSessionId = readString(pack.pack_session_id);
  if (trainingMode === 'discussion') return { status: 'none' };
  if (trainingMode !== 'scenario') {
    return { status: 'broken', reason: 'invalid_pack_record' };
  }
  if (!packSessionId) {
    return { status: 'broken', reason: 'missing_evidence_pack' };
  }

  const evidenceQuery = readString(pack.evidence_query);
  const evidenceStatus = readString(pack.evidence_status);
  const expectedManifestSha256 = readString(pack.evidence_manifest_sha256);
  const expectedSourceCount = readNumber(pack.source_count);
  const expectedBookCount = readNumber(pack.book_count);
  if (
    !evidenceQuery
    || evidenceStatus !== 'ready'
    || !/^[a-f0-9]{64}$/.test(expectedManifestSha256)
    || expectedSourceCount === null
    || expectedBookCount === null
  ) {
    return { status: 'broken', reason: 'invalid_pack_record' };
  }

  const result = await db.prepare(`
    SELECT
      source_id, selection_index, book_id, chunk_id, book_title, book_author,
      tse.chunk_index, tse.char_start, tse.char_end, tse.excerpt, tse.content_sha256, tse.relevance_score,
      tse.lifecycle_status, b.lifecycle_status AS book_lifecycle_status,
      b.visibility AS book_visibility
    FROM training_scenario_evidence tse
    LEFT JOIN books b ON b.id = tse.book_id
    WHERE tse.session_id = ?1
    ORDER BY tse.selection_index ASC
  `).bind(sessionId).all();

  const sources = (result.results || [])
    .map(parseEvidenceSnapshot)
    .filter((source): source is LibraryEvidenceSource => source !== null);

  if ((result.results || []).length !== sources.length) {
    return { status: 'broken', reason: 'invalid_evidence_snapshot' };
  }
  if (sources.some((source) => source.sourceId !== `library:${source.bookId}:${source.chunkId}`)) {
    return { status: 'broken', reason: 'invalid_evidence_snapshot' };
  }
  if (
    new Set(sources.map((source) => source.sourceId)).size !== sources.length
    || new Set(sources.map((source) => source.selectionIndex)).size !== sources.length
    || sources.some((source, index) => source.selectionIndex !== index)
  ) {
    return { status: 'broken', reason: 'invalid_evidence_snapshot' };
  }
  if (sources.length === 0) {
    return { status: 'broken', reason: 'missing_evidence_rows' };
  }
  const contentHashes = await Promise.all(
    sources.map((source) => sha256Hex(source.excerpt)),
  );
  if (contentHashes.some((hash, index) => hash !== sources[index].contentSha256)) {
    return { status: 'broken', reason: 'content_hash_mismatch' };
  }
  if (sources.length !== expectedSourceCount) {
    return { status: 'broken', reason: 'source_count_mismatch' };
  }
  if (new Set(sources.map((source) => source.bookId)).size !== expectedBookCount) {
    return { status: 'broken', reason: 'book_count_mismatch' };
  }

  const actualManifestSha256 = await evidenceManifestSha256(evidenceQuery, sources);
  if (actualManifestSha256 !== expectedManifestSha256) {
    return { status: 'broken', reason: 'manifest_mismatch' };
  }

  let scenario: EvidenceGroundedScenario;
  try {
    const rawScenario = JSON.parse(readString(pack.scenario_json));
    const rawRubric = JSON.parse(readString(pack.rubric_json));
    scenario = parseScenario(
      rawScenario,
      new Map(sources.map((source) => [source.sourceId, source.bookId])),
    );
    if (JSON.stringify(parseRubric(rawRubric)) !== JSON.stringify(scenario.rubric)) {
      return { status: 'broken', reason: 'invalid_pack_record' };
    }
  } catch {
    return { status: 'broken', reason: 'invalid_pack_record' };
  }

  return {
    status: 'ready',
    context: formatEvidenceContext(expectedManifestSha256, sources, scenario),
    manifestSha256: expectedManifestSha256,
    sources,
  };
}
