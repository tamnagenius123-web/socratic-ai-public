import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/types';
import { LearningSessionContextError } from '../src/services/learning-session-context';
import { AIInvocationReceiptPersistenceError } from '../src/services/ai-router';

const routeState = vi.hoisted(() => ({
  authUserId: 'user-1' as string | null,
  events: [] as string[],
  seedBuiltinBooks: vi.fn(),
  getBookFromDB: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSessionAfterEvaluation: vi.fn(),
  generateSessionReport: vi.fn(),
  generateSessionSummary: vi.fn(),
  saveSessionReport: vi.fn(),
  buildEvaluationSaveStatement: vi.fn(),
  callAIJSON: vi.fn(),
  retrieveLibraryChunks: vi.fn(),
  renderLibraryEvidence: vi.fn(),
  persistSparringEvidence: vi.fn(),
  prepareSparringEvidence: vi.fn(),
  createGrowthLabSparringContext: vi.fn(),
  loadOwnedSparringContext: vi.fn(),
  pinAIRoutePlan: vi.fn(),
  createAIRouter: vi.fn(),
  initDeepReport: vi.fn(),
  enqueueDeepAnalytics: vi.fn(),
  runDeepAnalytics: vi.fn(),
  getDeepReport: vi.fn(),
  verifyConstraints: vi.fn(),
  queryGroundedNodes: vi.fn(),
  runResearcherAgent: vi.fn(),
  persistResearchToD1: vi.fn(),
  setTokenTrackingContext: vi.fn(),
  resetRequestTokenUsage: vi.fn(),
  getRequestTokenUsage: vi.fn(),
  prepareLearnerSourceAttribution: vi.fn(),
  loadLearnerSourceAttributions: vi.fn(),
  processStudentTurn: vi.fn(),
  createStudentModel: vi.fn(),
  serializeStudentModel: vi.fn(),
  deserializeStudentModel: vi.fn(),
  createLayerState: vi.fn(),
  serializeLayerState: vi.fn(),
  deserializeLayerState: vi.fn(),
  determineNextLayer: vi.fn(),
  updateLayerState: vi.fn(),
  processArgumentGraph: vi.fn(),
  extractAIFFromMessage: vi.fn(),
  extractAIFRuleBased: vi.fn(),
  persistAIFToD1: vi.fn(),
  buildAIFGraph: vi.fn(),
}));

vi.mock('../src/services/sparring-revisions',()=>({loadSparringRevisions:async()=>({status:'AVAILABLE',revision:0,history:[],pending:null,candidates:[]})}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: async (_context: unknown, next: () => Promise<void>) => next(),
  getAuthUser: () => routeState.authUserId
    ? { userId: routeState.authUserId, role: 'student' }
    : null,
  canAccessOwnerResource: (ownerUserId: string | null | undefined, requesterUserId: string | null) => (
    Boolean(ownerUserId && requesterUserId && ownerUserId === requesterUserId)
  ),
}));

vi.mock('../src/middleware/usage-limit', () => ({
  checkUsageLimit: async (_context: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../src/services/student-model', () => ({
  seedBuiltinBooks: routeState.seedBuiltinBooks,
  getBookFromDB: routeState.getBookFromDB,
  createSession: routeState.createSession,
  getSession: routeState.getSession,
  updateSessionAfterEvaluation: routeState.updateSessionAfterEvaluation,
  generateSessionReport: routeState.generateSessionReport,
  generateSessionSummary: routeState.generateSessionSummary,
  saveSessionReport: routeState.saveSessionReport,
  buildEvaluationSaveStatement: routeState.buildEvaluationSaveStatement,
}));

vi.mock('../src/data/books', () => ({
  BOOKS: {},
  getAllBooks: () => [],
}));

vi.mock('../src/services/ai-client', () => ({
  callAIJSON: routeState.callAIJSON,
  setTokenTrackingContext: routeState.setTokenTrackingContext,
  resetRequestTokenUsage: routeState.resetRequestTokenUsage,
  getRequestTokenUsage: routeState.getRequestTokenUsage,
}));

vi.mock('../src/services/library-retrieval', () => ({
  // This adapter suite uses a fake book store; full-schema entrypoint tests
  // exercise lifecycle/owner rejection and quarantine during generation.
  requireSparringSource: vi.fn(async () => undefined),
  retrieveLibraryChunks: routeState.retrieveLibraryChunks,
  renderLibraryEvidence: routeState.renderLibraryEvidence,
  persistSparringEvidence: routeState.persistSparringEvidence,
  prepareSparringEvidence: routeState.prepareSparringEvidence,
}));

// This suite isolates context adapters; migrated production-entrypoint tests exercise control storage and races.
vi.mock('../src/services/sparring-controls', async (importOriginal) => {
  const actual=await importOriginal<typeof import('../src/services/sparring-controls')>();
  return {...actual,guardSparringNonProgress:vi.fn(async()=>({state:'ACTIVE',revision:0,history:[]}))};
});

vi.mock('../src/services/learning-session-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/learning-session-context')>();
  return {
    ...actual,
    createGrowthLabSparringContext: routeState.createGrowthLabSparringContext,
    loadOwnedSparringContext: routeState.loadOwnedSparringContext,
    pinAIRoutePlan: routeState.pinAIRoutePlan,
  };
});

vi.mock('../src/services/ai-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ai-router')>();
  return { ...actual, createAIRouter: routeState.createAIRouter };
});

vi.mock('../src/services/deep-analytics', () => ({
  initDeepReport: routeState.initDeepReport,
  enqueueDeepAnalytics: routeState.enqueueDeepAnalytics,
  runDeepAnalytics: routeState.runDeepAnalytics,
  getDeepReport: routeState.getDeepReport,
}));

vi.mock('../src/services/math/knowledge-graph', () => ({
  verifyConstraints: routeState.verifyConstraints,
  queryGroundedNodes: routeState.queryGroundedNodes,
}));

vi.mock('../src/services/math/researcher-agent', () => ({
  runResearcherAgent: routeState.runResearcherAgent,
  persistResearchToD1: routeState.persistResearchToD1,
}));

vi.mock('../src/services/source-attribution', () => ({
  prepareLearnerSourceAttribution: routeState.prepareLearnerSourceAttribution,
  loadLearnerSourceAttributions: routeState.loadLearnerSourceAttributions,
}));

vi.mock('../src/routes/training', () => ({
  TrainingOperationError: class TrainingOperationError extends Error {},
  legacyScenarioProjection: vi.fn(),
  listTrainingSessions: vi.fn(),
  promoteLegacyScenarioForResume: vi.fn(),
  publicTrainingSession: vi.fn(),
  requireTrainingEvidenceGrounding: vi.fn(),
  toPublicTrainingMode: vi.fn(),
}));

vi.mock('../src/services/tutoring/orchestrator', () => ({
  processStudentTurn: routeState.processStudentTurn,
  createStudentModel: routeState.createStudentModel,
  serializeStudentModel: routeState.serializeStudentModel,
  deserializeStudentModel: routeState.deserializeStudentModel,
}));

vi.mock('../src/services/tutoring/question-layer-tracker', () => ({
  createLayerState: routeState.createLayerState,
  serializeLayerState: routeState.serializeLayerState,
  deserializeLayerState: routeState.deserializeLayerState,
  determineNextLayer: routeState.determineNextLayer,
  updateLayerState: routeState.updateLayerState,
}));

vi.mock('../src/services/faf-engine', () => ({
  processArgumentGraph: routeState.processArgumentGraph,
}));

vi.mock('../src/services/math/aif-pipeline', () => ({
  extractAIFFromMessage: routeState.extractAIFFromMessage,
  extractAIFRuleBased: routeState.extractAIFRuleBased,
  persistAIFToD1: routeState.persistAIFToD1,
  buildAIFGraph: routeState.buildAIFGraph,
}));

const { default: sessionRoute } = await import('../src/routes/session');
const { default: chatRoute } = await import('../src/routes/chat');
const { default: historyRoute } = await import('../src/routes/history');

const pinnedRoutes = {
  interactive_generation: ['ssu-luna'],
  learner_evaluation: ['deepseek-v4-pro'],
  release_critic: ['deepseek-v4-flash'],
  background_reasoning: ['deepseek-v4-pro'],
} as const;

const activeContext = {
  id: 'context-1',
  sessionKind: 'SPARRING' as const,
  sessionId: 'session-1',
  context: {
    kind: 'GROWTH_LAB' as const,
    subjectId: 'user-1',
    authorityCapabilities: ['growth_lab:owner'],
    policyRevision: 'growth-lab-policy-v1',
  },
  corpus: {
    bindingId: 'book:book-1',
    manifestRevision: 'opening-manifest-sha256',
  },
  routes: pinnedRoutes,
  promptCacheNamespace: 'sparring:session-1',
  evidencePolicyRevision: 'evidence-policy-v1',
  status: 'ACTIVE' as const,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const openingEvidence = [{
  chunkId: 'chunk-1',
  bookId: 'book-1',
  bookTitle: 'Book One',
  bookAuthor: 'Author One',
  lifecycleStatus: 'active' as const,
  chunkIndex: 0,
  charStart: 0,
  charEnd: 20,
  content: 'Opening evidence.',
  contentSha256: 'chunk-sha256',
  relevanceScore: 1,
}];

const activeSession = {
  id: 'session-1',
  userId: 'user-1',
  bookId: 'book-1',
  bookTitle: 'Book One',
  bookChapter: 'Chapter One',
  topic: 'A source-grounded topic',
  currentTurn: 1,
  maxTurns: 10,
  currentPhase: 'elicitation',
  conversationHistory: [],
  currentClaim: '',
  weaknessPattern: [],
  studentModelRaw: '{}',
  tutorState: 'elicitation',
  layerStateJson: '',
  initialClaimV12: '',
  thoughtProfileJson: '{}',
  challengeStateJson: '{}',
  radarScores: {
    defense: 70,
    consistency: 70,
    evidence: 70,
    relevance: 70,
    clarity: 70,
  },
  previousRadarScores: {
    defense: 60,
    consistency: 60,
    evidence: 60,
    relevance: 60,
    clarity: 60,
  },
  avgLogic: 70,
  rating: 'B',
  hintLevel: 0,
  textualEvidenceCited: 1,
  logicalFallaciesAvoided: 0,
  fallaciesDetected: 0,
  dialecticPace: 1,
  credibility: { level: 'developing', tier: 1 },
  currentWeakness: null,
  isCompleted: false,
  initialRadarScores: {
    defense: 60,
    consistency: 60,
    evidence: 60,
    relevance: 60,
    clarity: 60,
  },
  coreClaim: '',
  hintRequestCount: 0,
};

function createDatabase(): D1Database {
  const statement = {
    bind(..._values: unknown[]) {
      return statement;
    },
    async run() {
      return {};
    },
    async first<T>() {
      return null as T | null;
    },
    async all<T>() {
      return { results: [] as T[] };
    },
  };
  return {
    prepare: () => statement,
    async batch(statements: D1PreparedStatement[]) {
      return statements.map(() => ({ success: true, meta: { changes: 1 }, results: [] }));
    },
  } as unknown as D1Database;
}

interface RecordedDbStatement {
  sql: string;
  values: unknown[];
}

function createRecordingDatabase(initialContextId: string | null = null): { db: D1Database; statements: RecordedDbStatement[]; batches: RecordedDbStatement[][] } {
  const statements: RecordedDbStatement[] = [];
  const batches: RecordedDbStatement[][] = [];
  let contextId = initialContextId;
  const db = {
    prepare(sql: string) {
      const record: RecordedDbStatement = { sql, values: [] };
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
          if (sql.includes('SELECT id FROM learning_session_contexts')) {
            return (contextId ? { id: contextId } : null) as T | null;
          }
          if (sql.includes('COUNT(*) AS manifest_count')) {
            return { message_count: 0, manifest_count: 0, evidence_count: 0, context_count: contextId ? 1 : 0 } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        __record: record,
      };
      return statement;
    },
    async batch(batchStatements: Array<{ __record?: RecordedDbStatement }>) {
      const records = batchStatements.flatMap((statement) => statement.__record ? [statement.__record] : []);
      batches.push(records);
      if (records.some((statement) => statement.sql.includes('DELETE FROM learning_session_contexts'))) {
        contextId = null;
      }
      return batchStatements.map(() => ({ success: true, meta: { changes: 1 }, results: [] }));
    },
  } as unknown as D1Database;
  return { db, statements, batches };
}

function bindings(): Bindings {
  return {
    DB: createDatabase(),
    JWT_SECRET: 'test-jwt-secret',
    SOONGSIL_API_KEY: '',
    GEMINI_API_KEY: '',
  };
}

async function startSparring(env: Bindings): Promise<Response> {
  return sessionRoute.fetch(new Request('http://test.local/api/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId: 'book-1' }),
  }), env);
}

async function submitChat(env: Bindings): Promise<Response> {
  return chatRoute.fetch(new Request('http://test.local/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-1', message: 'My evidence-backed claim.' }),
  }), env);
}

async function deleteSparring(env: Bindings): Promise<Response> {
  return historyRoute.fetch(new Request('http://test.local/api/sessions/session-1', {
    method: 'DELETE',
  }), env);
}

function resetRouteState(): void {
  routeState.authUserId = 'user-1';
  routeState.events.length = 0;
  for (const mock of Object.values(routeState)) {
    if (typeof mock === 'function' && 'mockReset' in mock) mock.mockReset();
  }

  routeState.getBookFromDB.mockResolvedValue({
    id: 'book-1',
    title: 'Book One',
    author: 'Author One',
    chapter: 'Chapter One',
    text: 'Book text.',
    key_passages: '',
  });
  routeState.createSession.mockResolvedValue({ id: 'session-1' });
  routeState.getSession.mockResolvedValue(activeSession);
  routeState.updateSessionAfterEvaluation.mockResolvedValue({
    ...activeSession,
    currentTurn: 2,
    isCompleted: false,
  });
  routeState.generateSessionReport.mockReturnValue({
    topic: 'A source-grounded topic',
    bookTitle: 'Book One',
    coreClaim: '',
    finalClaim: '',
    radarChange: [],
    strengths: '',
    improvements: '',
    nextRecommendation: '',
    totalTurns: 10,
    totalEvidenceCited: 1,
    avgLogic: 70,
    finalRating: 'B',
  });
  routeState.buildEvaluationSaveStatement.mockReturnValue({});
  routeState.prepareLearnerSourceAttribution.mockReturnValue({
    statements: [],
    attribution: null,
  });
  routeState.loadLearnerSourceAttributions.mockResolvedValue([]);
  routeState.getRequestTokenUsage.mockReturnValue({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCredits: 0,
    callCount: 0,
    models: [],
  });
  routeState.createStudentModel.mockReturnValue({ currentClaim: '', weaknessPatterns: [] });
  routeState.serializeStudentModel.mockReturnValue('{}');
  routeState.deserializeStudentModel.mockReturnValue({ currentClaim: '', weaknessPatterns: [] });
  routeState.createLayerState.mockReturnValue({ currentLayer: 'surface', layerHistory: ['surface'], turnsInCurrentLayer: 0 });
  routeState.serializeLayerState.mockReturnValue('{}');
  routeState.deserializeLayerState.mockReturnValue({ currentLayer: 'surface', layerHistory: ['surface'], turnsInCurrentLayer: 0 });
  routeState.determineNextLayer.mockReturnValue({ nextLayer: 'surface', shouldTransition: false, reason: '' });
  routeState.updateLayerState.mockReturnValue({ currentLayer: 'surface', layerHistory: ['surface'], turnsInCurrentLayer: 1 });
  routeState.processStudentTurn.mockResolvedValue({
    tutorResponse: 'What evidence supports that claim?',
    questionType: 'evidence',
    aiRouting: {
      learnerEvaluation: { lane: 'learner_evaluation', provider: 'deepseek', model: 'v4', fallback: false, attemptCount: 1, latencyMs: 1 },
      interactiveGeneration: { lane: 'interactive_generation', provider: 'ssu_mindlogic', model: 'luna', fallback: false, attemptCount: 1, latencyMs: 1 },
      releaseCritic: { lane: 'release_critic', provider: 'deepseek', model: 'flash', fallback: false, attemptCount: 1, latencyMs: 1 },
    },
    evaluation: {
      claim_clarity: 4,
      evidence_use: 4,
      reasoning_strength: 4,
      consistency: 4,
      relevance: 4,
      evidence_detected: [],
      claim: 'A claim',
      diagnosis: '',
      reasoning_gap: '',
      next_action: 'ask_evidence',
      weakness_tags: [],
      evidence_source_ids: [],
    },
    state: 'reasoning',
    studentModel: { currentClaim: 'A claim', weaknessPatterns: [] },
    runAcceptedSideEffects: undefined,
    criticVerdict: undefined,
  });
  routeState.runResearcherAgent.mockResolvedValue({
    relevantPassages: [],
    factCheckResult: {
      status: 'unavailable',
      claimVerified: null,
      confidence: 0,
      supportingEvidence: [],
      contradictingEvidence: [],
      missingContext: [],
    },
    suggestedAngles: [],
    trustMarkers: [],
    researchTimeMs: 1,
  });
  routeState.persistResearchToD1.mockResolvedValue(undefined);
  routeState.extractAIFFromMessage.mockResolvedValue({ iNodes: [], sNodes: [], edges: [] });
  routeState.extractAIFRuleBased.mockReturnValue({ iNodes: [], edges: [] });
  routeState.buildAIFGraph.mockReturnValue({ metadata: { missingEdges: [] } });
  routeState.getDeepReport.mockResolvedValue({ status: 'processing' });
  routeState.runDeepAnalytics.mockResolvedValue({ status: 'completed' });
  routeState.retrieveLibraryChunks.mockImplementation(async () => {
    routeState.events.push('select-evidence');
    return openingEvidence;
  });
  routeState.renderLibraryEvidence.mockReturnValue('Opening evidence.');
  routeState.prepareSparringEvidence.mockImplementation(async()=>{routeState.events.push('prepare-turn-evidence');return {manifestId:'turn-manifest',manifestSha256:'turn-manifest-sha256',statements:[]};});
  routeState.persistSparringEvidence.mockImplementation(async () => {
    routeState.events.push('persist-opening-evidence');
    return { manifestId: 'manifest-1', manifestSha256: 'opening-manifest-sha256' };
  });
  routeState.pinAIRoutePlan.mockReturnValue(pinnedRoutes);
  routeState.createGrowthLabSparringContext.mockImplementation(async () => {
    routeState.events.push('create-context');
    return activeContext;
  });
  routeState.loadOwnedSparringContext.mockImplementation(async () => {
    routeState.events.push('load-context');
    return activeContext;
  });
  routeState.createAIRouter.mockImplementation((_env: Bindings, _options: unknown) => {
    routeState.events.push('create-router');
    return {
      completeValidatedJSON: vi.fn(async () => {
        throw new Error('No opening provider configured');
      }),
    };
  });
}

beforeEach(() => {
  resetRouteState();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('context-bound Sparring session adapters', () => {
  it('creates one immutable Growth Lab context after the opening manifest and returns redacted metadata', async () => {
    const response = await startSparring(bindings());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: 'session-1',
      context: { id: 'context-1', kind: 'GROWTH_LAB' },
    });
    expect(routeState.events).toEqual([
      'select-evidence',
      'persist-opening-evidence',
      'create-context',
      'create-router',
    ]);
    expect(routeState.createGrowthLabSparringContext).toHaveBeenCalledTimes(1);
    expect(routeState.createGrowthLabSparringContext).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      ownerUserId: 'user-1',
      subjectId: 'user-1',
      corpusBindingId: 'book:book-1',
      corpusManifestRevision: 'opening-manifest-sha256',
      promptCacheNamespace: 'sparring:session-1',
      routes: pinnedRoutes,
    }));
  });

  it('does not report session readiness when immutable context creation fails', async () => {
    routeState.createGrowthLabSparringContext.mockRejectedValue(new Error('D1 unavailable'));

    const response = await startSparring(bindings());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.not.toHaveProperty('context');
    expect(routeState.events).toEqual([
      'select-evidence',
      'persist-opening-evidence',
    ]);
  });

  it('compensates an unbound failed start and verifies no session or opening evidence remains', async () => {
    routeState.createGrowthLabSparringContext.mockRejectedValue(new Error('D1 unavailable'));
    const recording = createRecordingDatabase();

    const response = await startSparring({ ...bindings(), DB: recording.db });

    expect(response.status).toBe(500);
    const batchSql = recording.batches.flat().map((statement) => statement.sql);
    expect(batchSql).toEqual(expect.arrayContaining([
      expect.stringContaining('DELETE FROM sparring_turn_evidence'),
      expect.stringContaining('DELETE FROM sparring_evidence_manifests'),
      expect.stringContaining('DELETE FROM sessions'),
    ]));
    expect(recording.statements.some((statement) => statement.sql.includes('learning_session_contexts'))).toBe(true);
    expect(recording.statements.some((statement) => statement.sql.includes('manifest_count'))).toBe(true);
  });

  it('compensates evidence persistence rejection without leaving an unbound session or context', async () => {
    routeState.persistSparringEvidence.mockRejectedValue(new Error('evidence write rejected'));
    const recording = createRecordingDatabase();

    const response = await startSparring({ ...bindings(), DB: recording.db });

    expect(response.status).toBe(500);
    expect(routeState.createGrowthLabSparringContext).not.toHaveBeenCalled();
    const batchSql = recording.batches.flat().map((statement) => statement.sql);
    expect(batchSql).toEqual(expect.arrayContaining([
      expect.stringContaining('DELETE FROM sparring_turn_evidence'),
      expect.stringContaining('DELETE FROM sparring_evidence_manifests'),
      expect.stringContaining('DELETE FROM sessions'),
    ]));
    expect(recording.statements.some((statement) => statement.sql.includes('learning_session_contexts'))).toBe(true);
  });

  it('recovers only an exact already-created context instead of failing a retry', async () => {
    routeState.createGrowthLabSparringContext.mockRejectedValue(
      new LearningSessionContextError('CONTEXT_ALREADY_EXISTS'),
    );
    routeState.loadOwnedSparringContext.mockResolvedValue(activeContext);

    const response = await startSparring(bindings());

    expect(response.status).toBe(200);
    expect(routeState.loadOwnedSparringContext).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      'user-1',
    );
  });

  it('fails closed on a mismatched duplicate context without deleting an existing context', async () => {
    routeState.createGrowthLabSparringContext.mockRejectedValue(
      new LearningSessionContextError('CONTEXT_ALREADY_EXISTS'),
    );
    routeState.loadOwnedSparringContext.mockResolvedValue({
      ...activeContext,
      corpus: { ...activeContext.corpus, manifestRevision: 'wrong-opening-manifest' },
    });
    const recording = createRecordingDatabase();

    const response = await startSparring({ ...bindings(), DB: recording.db });

    expect(response.status).toBe(500);
    expect(recording.batches).toHaveLength(0);
  });

  it('uses only a turn-zero context-bound router for optional opening generation', async () => {
    const openingRouter = {
      completeValidatedJSON: vi.fn(async (
        lane: string,
        _input: unknown,
        validate: (value: unknown) => unknown,
      ) => ({ value: validate({ openingMessage: 'Context-bound opening question.' }) })),
    };
    routeState.createAIRouter.mockReturnValue(openingRouter);
    const env = {
      ...bindings(),
      SOONGSIL_API_KEY: '[REDACTED]',
      GEMINI_API_KEY: '[REDACTED]',
    };

    const response = await startSparring(env);

    expect(response.status).toBe(200);
    expect(routeState.createAIRouter).toHaveBeenCalledWith(env, {
      mode: 'context_bound',
      pinnedRoutePlan: pinnedRoutes,
      invocationScope: {
        sessionContextId: 'context-1',
        sessionId: 'session-1',
        turnNumber: 0,
        promptCacheNamespace: 'sparring:session-1',
      },
    });
    expect(openingRouter.completeValidatedJSON).toHaveBeenCalledWith(
      'interactive_generation',
      expect.anything(),
      expect.any(Function),
    );
    expect(routeState.callAIJSON).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      openingMessage: 'Context-bound opening question.',
    });
  });

  it('fails closed and governed-cleans a start when opening receipt persistence fails', async () => {
    const openingRouter = {
      completeValidatedJSON: vi.fn(async () => {
        throw new AIInvocationReceiptPersistenceError();
      }),
    };
    routeState.createAIRouter.mockReturnValue(openingRouter);
    const recording = createRecordingDatabase('context-1');

    const response = await startSparring({ ...bindings(), DB: recording.db });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'AI_INVOCATION_RECEIPT_REQUIRED',
      assessmentState: 'UNGRADABLE',
      retryable: false,
    });
    const batchSql = recording.batches.flat().map((statement) => statement.sql);
    expect(batchSql).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO learning_session_context_deletion_authorizations'),
      expect.stringContaining('DELETE FROM sparring_turn_evidence'),
      expect.stringContaining('DELETE FROM sparring_evidence_manifests'),
      expect.stringContaining('DELETE FROM learning_session_contexts'),
      expect.stringContaining('DELETE FROM sessions'),
    ]));
    expect(recording.statements.some((statement) => statement.sql.includes('INSERT INTO messages'))).toBe(false);
  });

  it('deletes a context-bound session through one authorized batch', async () => {
    const recording = createRecordingDatabase();

    const response = await deleteSparring({ ...bindings(), DB: recording.db });

    expect(response.status).toBe(200);
    const batchSql = recording.batches.flat().map((statement) => statement.sql);
    expect(batchSql).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO learning_session_context_deletion_authorizations'),
      expect.stringContaining('DELETE FROM sparring_turn_evidence'),
      expect.stringContaining('DELETE FROM sparring_evidence_manifests'),
      expect.stringContaining('DELETE FROM learning_session_contexts'),
      expect.stringContaining('DELETE FROM sessions'),
    ]));
  });

  it('preserves wrong-owner chat denial before loading context', async () => {
    routeState.authUserId = 'user-2';

    const response = await submitChat(bindings());

    expect(response.status).toBe(403);
    expect(routeState.loadOwnedSparringContext).not.toHaveBeenCalled();
    expect(routeState.retrieveLibraryChunks).not.toHaveBeenCalled();
    expect(routeState.createAIRouter).not.toHaveBeenCalled();
  });

  it('fails legacy Sparring chat with a recoverable context-required result before evidence or AI routing', async () => {
    routeState.loadOwnedSparringContext.mockRejectedValue(
      new LearningSessionContextError('CONTEXT_NOT_FOUND'),
    );

    const response = await submitChat(bindings());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'SESSION_CONTEXT_REQUIRED',
      recoverable: true,
      assessmentState: 'UNGRADABLE',
    });
    expect(routeState.loadOwnedSparringContext).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      'user-1',
    );
    expect(routeState.retrieveLibraryChunks).not.toHaveBeenCalled();
    expect(routeState.createAIRouter).not.toHaveBeenCalled();
  });

  it('keeps malformed and unavailable contexts distinct while failing closed', async () => {
    routeState.loadOwnedSparringContext.mockRejectedValueOnce(
      new LearningSessionContextError('MALFORMED_ROUTE_PLAN'),
    );

    const malformed = await submitChat(bindings());

    expect(malformed.status).toBe(503);
    await expect(malformed.json()).resolves.toMatchObject({
      code: 'SESSION_CONTEXT_INVALID',
      contextError: 'MALFORMED_ROUTE_PLAN',
      recoverable: false,
      assessmentState: 'UNGRADABLE',
    });
    expect(routeState.retrieveLibraryChunks).not.toHaveBeenCalled();
    expect(routeState.createAIRouter).not.toHaveBeenCalled();

    routeState.loadOwnedSparringContext.mockRejectedValueOnce(new Error('D1 unavailable'));
    const unavailable = await submitChat(bindings());

    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      code: 'SESSION_CONTEXT_UNAVAILABLE',
      retryable: true,
      assessmentState: 'UNGRADABLE',
    });
    expect(routeState.retrieveLibraryChunks).not.toHaveBeenCalled();
    expect(routeState.createAIRouter).not.toHaveBeenCalled();
  });

  it('loads the owned context before evidence selection and creates an atomic context-bound router scope', async () => {
    routeState.retrieveLibraryChunks.mockImplementation(async () => {
      routeState.events.push('select-evidence');
      return [];
    });
    const env = bindings();

    const response = await submitChat(env);

    expect(response.status).toBe(409);
    expect(routeState.events).toEqual(['load-context', 'create-router', 'select-evidence']);
    expect(routeState.createAIRouter).toHaveBeenCalledWith(env, {
      mode: 'context_bound',
      pinnedRoutePlan: pinnedRoutes,
      invocationScope: {
        sessionContextId: 'context-1',
        sessionId: 'session-1',
        turnNumber: 1,
        promptCacheNamespace: 'sparring:session-1',
      },
    });
  });

  it.each([
    ['thoughtProfileJson', '{"sampleSize":2}'],
    ['challengeStateJson', '{"currentLevel":9}'],
    ['thoughtProfileJson', '[]'],
    ['challengeStateJson', '{broken'],
    ['challengeStateJson', '{"currentLevel":2,"history":[{"turn":1,"level":8,"reason":"invalid"}],"consecutiveSuccess":0,"consecutiveStruggle":0}'],
  ])('refuses damaged saved intelligence before AI or an accepted turn: %s %s', async (field, raw) => {
    routeState.getSession.mockResolvedValue({ ...activeSession, [field]: raw });
    const response = await submitChat(bindings());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'SAVED_LEARNING_STATE_UNAVAILABLE', assessmentState: 'UNGRADABLE', retryable: false });
    expect(routeState.processStudentTurn).not.toHaveBeenCalled();
    expect(routeState.runResearcherAgent).not.toHaveBeenCalled();
    expect(routeState.updateSessionAfterEvaluation).not.toHaveBeenCalled();
    expect(routeState.persistSparringEvidence).not.toHaveBeenCalled();
  });

  it('passes a complete saved thought profile and challenge history unchanged into the tutor', async () => {
    const thoughtProfile = { absolutistTendency: 0, binaryThinking: 0.2, definitionalVagueness: 1, intuitionOverText: 0.1, lastUpdatedTurn: 0, sampleSize: 0 };
    const challengeState = { currentLevel: 2, history: [{ turn: 1, level: 2, reason: 'Earlier saved transition' }], consecutiveSuccess: 0, consecutiveStruggle: 1 };
    routeState.getSession.mockResolvedValue({ ...activeSession, thoughtProfileJson: JSON.stringify(thoughtProfile), challengeStateJson: JSON.stringify(challengeState) });
    expect((await submitChat(bindings())).status).toBe(200);
    expect(routeState.processStudentTurn).toHaveBeenCalledWith(expect.objectContaining({ thoughtProfile, challengeState }));
  });

  it('continues past evidence with a scoped researcher and never passes legacy credentials into a Sparring turn', async () => {
    const scopedRouter = { completeValidatedJSON: vi.fn() };
    routeState.createAIRouter.mockReturnValue(scopedRouter);
    routeState.processStudentTurn.mockRejectedValueOnce(new Error('stop after researcher'));
    const env = {
      ...bindings(),
      SOONGSIL_API_KEY: '[REDACTED]',
      GEMINI_API_KEY: '[REDACTED]',
    };

    const response = await submitChat(env);

    expect(response.status).toBe(503);
    expect(routeState.events).toContain('select-evidence');
    expect(routeState.runResearcherAgent).toHaveBeenCalledWith(
      scopedRouter,
      expect.objectContaining({
        sessionId: 'session-1',
        studentMessage: 'My evidence-backed claim.',
      }),
    );
    expect(routeState.callAIJSON).not.toHaveBeenCalled();
  });

  it('returns a distinct ungradable response and does not persist a canonical turn when Researcher receipts fail', async () => {
    routeState.runResearcherAgent.mockRejectedValue(new AIInvocationReceiptPersistenceError());

    const response = await submitChat(bindings());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'AI_INVOCATION_RECEIPT_REQUIRED',
      assessmentState: 'UNGRADABLE',
      retryable: false,
      failureClass: 'receipt_persistence',
    });
    expect(routeState.processStudentTurn).not.toHaveBeenCalled();
    expect(routeState.updateSessionAfterEvaluation).not.toHaveBeenCalled();
  });

  it('returns a distinct ungradable response and does not persist a canonical turn when tutor receipts fail', async () => {
    routeState.processStudentTurn.mockRejectedValue(new AIInvocationReceiptPersistenceError());

    const response = await submitChat(bindings());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'AI_INVOCATION_RECEIPT_REQUIRED',
      assessmentState: 'UNGRADABLE',
      retryable: false,
      failureClass: 'receipt_persistence',
    });
    expect(routeState.updateSessionAfterEvaluation).not.toHaveBeenCalled();
  });

  it('dispatches accepted side effects exactly once while the route leaves AIF persistence to the orchestrator', async () => {
    const acceptedSideEffects = vi.fn(async () => undefined);
    routeState.processStudentTurn.mockResolvedValueOnce({
      tutorResponse: 'What evidence supports that claim?',
      questionType: 'evidence',
      aiRouting: {
        learnerEvaluation: { lane: 'learner_evaluation', provider: 'deepseek', model: 'v4', fallback: false, attemptCount: 1, latencyMs: 1 },
        interactiveGeneration: { lane: 'interactive_generation', provider: 'ssu_mindlogic', model: 'luna', fallback: false, attemptCount: 1, latencyMs: 1 },
        releaseCritic: { lane: 'release_critic', provider: 'deepseek', model: 'flash', fallback: false, attemptCount: 1, latencyMs: 1 },
      },
      evaluation: {
        claim_clarity: 4,
        evidence_use: 4,
        reasoning_strength: 4,
        consistency: 4,
        relevance: 4,
        evidence_detected: [],
        claim: 'A claim',
        diagnosis: '',
        reasoning_gap: '',
        next_action: 'ask_evidence',
        weakness_tags: [],
        evidence_source_ids: [],
      },
      state: 'reasoning',
      studentModel: { currentClaim: 'A claim', weaknessPatterns: [] },
      runAcceptedSideEffects: acceptedSideEffects,
      criticVerdict: undefined,
    });

    const response = await submitChat(bindings());

    expect(response.status).toBe(200);
    expect(acceptedSideEffects).toHaveBeenCalledTimes(1);
    expect(routeState.extractAIFRuleBased).not.toHaveBeenCalled();
    expect(routeState.persistAIFToD1).not.toHaveBeenCalled();
  });

  it('uses the scoped background lane for the session-end report, disables unscoped deep analytics, and leaves AIF to accepted side effects', async () => {
    const sessionEndAnalysis = {
      summary: 'The learner improved their evidence use.',
      microAnalysis: {
        comprehension: 70,
        judgment: 70,
        persuasion: 70,
        evidenceQuality: 70,
        reasoning: 70,
        consistency: 70,
        revision: 70,
        relevance: 70,
      },
      strengths: ['Uses evidence'],
      weaknesses: ['Needs more counterexamples'],
      growthTrajectory: 'Evidence use improved over the session.',
      prescriptiveFeedback: {
        immediate: ['Cite one passage'],
        nextSession: ['Compare passages'],
        longTerm: ['Test counterexamples'],
      },
      turnByTurnGrowth: {
        earlyPhase: 'Initial claim',
        midPhase: 'Evidence added',
        latePhase: 'Reasoning refined',
      },
    };
    const scopedRouter = {
      completeValidatedJSON: vi.fn(async (
        lane: string,
        _input: unknown,
        validate: (value: unknown) => unknown,
      ) => ({ value: validate(sessionEndAnalysis) })),
    };
    routeState.createAIRouter.mockReturnValue(scopedRouter);
    routeState.getSession.mockResolvedValue({
      ...activeSession,
      currentTurn: activeSession.maxTurns,
    });
    routeState.updateSessionAfterEvaluation.mockResolvedValue({
      ...activeSession,
      currentTurn: 11,
      isCompleted: true,
    });
    routeState.callAIJSON.mockResolvedValue(sessionEndAnalysis);

    const response = await submitChat(bindings());

    expect(response.status).toBe(200);
    expect(scopedRouter.completeValidatedJSON).toHaveBeenCalledWith(
      'background_reasoning',
      expect.anything(),
      expect.any(Function),
    );
    expect(routeState.callAIJSON).not.toHaveBeenCalled();
    expect(routeState.enqueueDeepAnalytics).not.toHaveBeenCalled();
    expect(routeState.runDeepAnalytics).not.toHaveBeenCalled();
    expect(routeState.extractAIFRuleBased).not.toHaveBeenCalled();
    expect(routeState.extractAIFFromMessage).not.toHaveBeenCalled();
    expect(routeState.persistAIFToD1).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      isSessionEnd: true,
      deepReportStatus: 'unavailable',
      sessionReport: {
        microAnalysisStatus: 'PROVISIONAL_UNCALIBRATED',
      },
    });
  });

  it('does not commit a final turn or dispatch accepted side effects when the pre-commit report receipt fails', async () => {
    const scopedRouter = {
      completeValidatedJSON: vi.fn(async () => {
        throw new AIInvocationReceiptPersistenceError();
      }),
    };
    const acceptedSideEffects = vi.fn(async () => undefined);
    routeState.createAIRouter.mockReturnValue(scopedRouter);
    routeState.getSession.mockResolvedValue({
      ...activeSession,
      currentTurn: activeSession.maxTurns,
    });
    routeState.processStudentTurn.mockResolvedValueOnce({
      tutorResponse: 'What evidence supports that claim?',
      questionType: 'evidence',
      aiRouting: {
        learnerEvaluation: { lane: 'learner_evaluation', provider: 'deepseek', model: 'v4', fallback: false, attemptCount: 1, latencyMs: 1 },
        interactiveGeneration: { lane: 'interactive_generation', provider: 'ssu_mindlogic', model: 'luna', fallback: false, attemptCount: 1, latencyMs: 1 },
        releaseCritic: { lane: 'release_critic', provider: 'deepseek', model: 'flash', fallback: false, attemptCount: 1, latencyMs: 1 },
      },
      evaluation: {
        claim_clarity: 4,
        evidence_use: 4,
        reasoning_strength: 4,
        consistency: 4,
        relevance: 4,
        evidence_detected: [],
        claim: 'A claim',
        diagnosis: '',
        reasoning_gap: '',
        next_action: 'ask_evidence',
        weakness_tags: [],
        evidence_source_ids: [],
      },
      state: 'reasoning',
      studentModel: { currentClaim: 'A claim', weaknessPatterns: [] },
      runAcceptedSideEffects: acceptedSideEffects,
      criticVerdict: undefined,
    });
    routeState.updateSessionAfterEvaluation.mockResolvedValue({
      ...activeSession,
      currentTurn: 11,
      isCompleted: true,
    });

    const response = await submitChat(bindings());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'AI_INVOCATION_RECEIPT_REQUIRED',
      assessmentState: 'UNGRADABLE',
      retryable: false,
    });
    expect(routeState.updateSessionAfterEvaluation).not.toHaveBeenCalled();
    expect(acceptedSideEffects).not.toHaveBeenCalled();
    expect(routeState.saveSessionReport).not.toHaveBeenCalled();
  });

  it('rejects incomplete, extra, and out-of-range session-end micro-analysis scores', async () => {
    const invalidValues = [
      {
        summary: 'Missing a required axis.',
        microAnalysis: { comprehension: 70 },
      },
      {
        summary: 'Contains an unapproved axis.',
        microAnalysis: {
          comprehension: 70, judgment: 70, persuasion: 70, evidenceQuality: 70,
          reasoning: 70, consistency: 70, revision: 70, relevance: 70, extra: 70,
        },
      },
      {
        summary: 'Contains an out-of-range score.',
        microAnalysis: {
          comprehension: 101, judgment: 70, persuasion: 70, evidenceQuality: 70,
          reasoning: 70, consistency: 70, revision: 70, relevance: 70,
        },
      },
    ];
    const scopedRouter = {
      completeValidatedJSON: vi.fn(async (
        _lane: string,
        _input: unknown,
        validate: (value: unknown) => unknown,
      ) => {
        for (const invalid of invalidValues) expect(validate(invalid)).toBeNull();
        throw new Error('validated router rejected invalid session-end analysis');
      }),
    };
    routeState.createAIRouter.mockReturnValue(scopedRouter);
    routeState.getSession.mockResolvedValue({
      ...activeSession,
      currentTurn: activeSession.maxTurns,
    });
    routeState.updateSessionAfterEvaluation.mockResolvedValue({
      ...activeSession,
      currentTurn: 11,
      isCompleted: true,
    });

    const response = await submitChat(bindings());

    expect(response.status).toBe(200);
    const body = await response.json() as { reportStatus: string; sessionReport?: { microAnalysisStatus?: string } };
    expect(body.reportStatus).toBe('ready');
    expect(body.sessionReport?.microAnalysisStatus).toBe('UNAVAILABLE');
  });
});
