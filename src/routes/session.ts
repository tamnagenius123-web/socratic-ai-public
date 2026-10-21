import { requireSparringControl } from '../services/sparring-controls';
import { loadOwnedFollowUpLaunch, prepareFollowUpBinding, readFollowUpLink } from '../services/growth-follow-up';
import { GrowthServiceError } from '../services/growth-cycle-types';
// Session API Route - POST /api/session/start, GET /api/session/:id (V2)
// Uses GPT-5 Nano via Soongsil API Gateway with Gemini fallback
import { Hono, type Context } from 'hono';
import type { Bindings, SessionStartRequest, SessionStartResponse, SparringStartMode } from '../types';
import { createSession, getSession, seedBuiltinBooks, getBookFromDB } from '../services/student-model';
import { getAllBooks, BOOKS } from '../data/books';
import { requireAuth, getAuthUser, canAccessOwnerResource } from '../middleware/auth';
import { persistSparringEvidence, renderLibraryEvidence, retrieveLibraryChunks, requireSparringSource } from '../services/library-retrieval';
import { createAIRouter, isAIInvocationReceiptPersistenceError } from '../services/ai-router';
import { renderPromptTemplate } from '../services/prompt-template';
import contextBoundOpeningSystemPrompt from '../services/learning-session-context/prompts/context-bound-opening.system.md?raw';
import contextBoundOpeningUserPrompt from '../services/learning-session-context/prompts/context-bound-opening.user.md?raw';
import {
  createGrowthLabSparringContext,
  LearningSessionContextError,
  loadOwnedSparringContext,
  pinAIRoutePlan,
  type PinnedLaneRoutePlan,
  type SessionExecutionContext,
} from '../services/learning-session-context';

const sessionRoute = new Hono<{ Bindings: Bindings }>();

const GROWTH_LAB_CONTEXT_POLICY_REVISION = 'growth-lab-policy-v1';
const GROWTH_LAB_EVIDENCE_POLICY_REVISION = 'evidence-policy-v1';

sessionRoute.use('/api/session/*', requireAuth);

function requesterId(c: Context<{ Bindings: Bindings }>): string | null {
  return getAuthUser(c)?.userId || null;
}

function normalizeStartMode(mode?: string): SparringStartMode {
  if (mode === 'deep_reading_question') return 'deep_reading_question';
  return 'initial_claim';
}

function getStartModeLabel(mode: SparringStartMode): string {
  return mode === 'deep_reading_question' ? '심화 독해 질문' : '초기 입장 정하기';
}

function stableSeed(...parts: readonly string[]): number {
  let hash = 2166136261;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

interface ContextBoundOpening {
  openingMessage: string;
}

function validateContextBoundOpening(value: unknown): ContextBoundOpening | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const openingMessage = (value as Record<string, unknown>).openingMessage;
  if (typeof openingMessage !== 'string' || openingMessage.trim().length === 0 || openingMessage.length > 1200) {
    return null;
  }
  return { openingMessage: openingMessage.trim() };
}

function matchingContext(
  context: SessionExecutionContext,
  input: {
    sessionId: string;
    userId: string;
    corpusBindingId: string;
    corpusManifestRevision: string;
    routes: PinnedLaneRoutePlan;
    promptCacheNamespace: string;
  },
): boolean {
  return context.sessionKind === 'SPARRING'
    && context.sessionId === input.sessionId
    && context.context.kind === 'GROWTH_LAB'
    && context.context.subjectId === input.userId
    && context.context.policyRevision === GROWTH_LAB_CONTEXT_POLICY_REVISION
    && context.context.authorityCapabilities.length === 1
    && context.context.authorityCapabilities[0] === 'growth_lab:owner'
    && context.corpus.bindingId === input.corpusBindingId
    && context.corpus.manifestRevision === input.corpusManifestRevision
    && context.promptCacheNamespace === input.promptCacheNamespace
    && context.evidencePolicyRevision === GROWTH_LAB_EVIDENCE_POLICY_REVISION
    && context.status === 'ACTIVE'
    && JSON.stringify(context.routes) === JSON.stringify(input.routes);
}

async function compensateSessionStart(db: D1Database, sessionId: string): Promise<void> {
  const context = await db.prepare(`
    SELECT id FROM learning_session_contexts
    WHERE session_kind = 'SPARRING' AND session_id = ?1
    LIMIT 1
  `).bind(sessionId).first<{ id: string }>();

  const statements = [
    ...(context ? [db.prepare(`
      INSERT INTO learning_session_context_deletion_authorizations (
        session_context_id, authorization_id, created_at
      ) VALUES (?1, ?2, ?3)
    `).bind(context.id, `start_cleanup_${crypto.randomUUID()}`, Date.now())] : []),
    db.prepare('DELETE FROM sparring_turn_evidence WHERE session_id = ?1').bind(sessionId),
    db.prepare('DELETE FROM sparring_evidence_manifests WHERE session_id = ?1').bind(sessionId),
    db.prepare('DELETE FROM messages WHERE session_id = ?1').bind(sessionId),
    ...(context ? [db.prepare(`
      DELETE FROM learning_session_contexts
      WHERE session_kind = 'SPARRING' AND session_id = ?1
    `).bind(sessionId)] : []),
    db.prepare('DELETE FROM sessions WHERE id = ?1').bind(sessionId),
  ];
  await db.batch(statements);

  const remainingSession = await db.prepare(
    'SELECT id FROM sessions WHERE id = ?1 LIMIT 1',
  ).bind(sessionId).first<{ id: string }>();
  const remainingEvidence = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM messages WHERE session_id = ?1) AS message_count,
      (SELECT COUNT(*) FROM sparring_evidence_manifests WHERE session_id = ?1) AS manifest_count,
      (SELECT COUNT(*) FROM sparring_turn_evidence WHERE session_id = ?1) AS evidence_count,
      (SELECT COUNT(*) FROM learning_session_contexts
        WHERE session_kind = 'SPARRING' AND session_id = ?1) AS context_count
  `).bind(sessionId).first<{
    message_count: number | string;
    manifest_count: number | string;
    evidence_count: number | string;
    context_count: number | string;
  }>();
  const messageCount = Number(remainingEvidence?.message_count ?? NaN);
  const manifestCount = Number(remainingEvidence?.manifest_count ?? NaN);
  const evidenceCount = Number(remainingEvidence?.evidence_count ?? NaN);
  const contextCount = Number(remainingEvidence?.context_count ?? NaN);
  if (remainingSession || messageCount !== 0 || manifestCount !== 0 || evidenceCount !== 0 || contextCount !== 0) {
    throw new Error('Start compensation could not be verified.');
  }
}

// 🔴 Dynamic passage picker V3: Draws from book's keyPassages FIRST for rich, curated content
// Supports BOTH built-in books (BOOKS map) AND DB-uploaded books (dbKeyPassages parameter)
// Falls back to sentence extraction only if keyPassages unavailable
function pickFocusPassage(text: string, modeSeed: number = 0, bookId?: string, dbKeyPassages?: { verse: string; text: string }[]): string {
  // Strategy 1a: Use curated keyPassages from built-in book data (best quality)
  if (bookId && BOOKS[bookId]?.keyPassages?.length) {
    const passages = BOOKS[bookId].keyPassages;
    const randomIdx = Math.abs(modeSeed * 31) % passages.length;
    const picked = passages[randomIdx];
    return `[${picked.verse}] ${picked.text}`.substring(0, 300);
  }

  // Strategy 1b: Use keyPassages from DB-uploaded book
  if (dbKeyPassages && dbKeyPassages.length > 0) {
    const randomIdx = Math.abs(modeSeed * 31) % dbKeyPassages.length;
    const picked = dbKeyPassages[randomIdx];
    return `[${picked.verse}] ${picked.text}`.substring(0, 300);
  }

  // Strategy 2: Extract from full text using sentence-level analysis
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  // Prefer sentences with philosophical/argumentative markers
  const allSentences = normalized
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40);

  if (!allSentences.length) {
    return normalized.substring(0, 220);
  }

  // Score sentences: prefer those with key philosophical terms
  const markers = /왜냐하면|따라서|그러므로|마치|비유|본성|덕|정의|영혼|자유|진리|선|악|행복|의견|판단|정념|성채|은둔|그림자|태양|동굴|근거|논증|전제|결론/;
  const scored = allSentences.map((s, i) => ({
    text: s,
    score: markers.test(s) ? 2 : 1,
    index: i,
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  // Pick reproducibly so retries preserve the same source-grounded opening.
  const topPool = scored.slice(0, Math.min(5, scored.length));
  const stableIndex = Math.abs(modeSeed * 31) % topPool.length;
  return topPool[stableIndex].text.substring(0, 260);
}

// 🔴 심화 질문 동적 생성 V3: 12개 확장 템플릿 + 구절 단위 출처 포함 + 도서 keyPassages 활용
// Supports BOTH built-in books AND DB-uploaded books
function buildDeepReadingQuestion(focusPassage: string, topic: string, templateSeed: number, bookId?: string, dbKeyPassages?: { verse: string; text: string }[]): string {
  // Get additional context passages from the book for richer questions
  let secondaryPassage = '';
  // Try built-in book first, then DB-uploaded book passages
  const allPassages = (bookId && BOOKS[bookId]?.keyPassages?.length > 1)
    ? BOOKS[bookId].keyPassages
    : (dbKeyPassages && dbKeyPassages.length > 1 ? dbKeyPassages : null);
  if (allPassages) {
    const altIdx = Math.abs(templateSeed * 13 + 7) % allPassages.length;
    const altPassage = allPassages[altIdx];
    if (altPassage.text !== focusPassage) {
      secondaryPassage = `[${altPassage.verse}] ${altPassage.text}`;
    }
  }

  const templates = [
    // 1. 핵심 명제 분석
    `다음 구절에 주목해 봅시다:\n"${focusPassage}"\n\n이 구절의 핵심 명제는 무엇이며, 그 명제가 토픽("${topic}")과 연결되는 이유를 텍스트 근거 1개 이상으로 설명해 주세요.`,
    // 2. 암묵적 전제 분석
    `핵심 구절:\n"${focusPassage}"\n\n이 문장에서 저자가 암묵적으로 전제한 가치판단은 무엇인가요? 반드시 같은 문단 또는 인접 구절을 근거로 들어 해석해 주세요.`,
    // 3. 장면 비교
    `다음 구절을 중심으로 읽어봅시다:\n"${focusPassage}"\n\n이 구절을 다른 장면과 비교했을 때 의미가 어떻게 달라지나요? 텍스트의 표현 1개 이상을 인용해 설명해 주세요.`,
    // 4. 비유/수사법 분석
    `구절:\n"${focusPassage}"\n\n이 구절에서 사용된 비유나 수사법은 무엇이며, 그것이 텍스트의 전체 논지("${topic}")를 어떻게 강화하는지 분석해 주세요.`,
    // 5. 비판적 평가
    `아래 구절을 면밀히 읽어보세요:\n"${focusPassage}"\n\n이 구절이 독자에게 전달하려는 핵심 메시지와, 그 메시지에 대한 당신의 비판적 평가를 텍스트 근거와 함께 제시해 주세요.`,
    // 6. 반론 구성
    `다음 텍스트를 분석합시다:\n"${focusPassage}"\n\n이 구절에 대해 반대 입장을 취한다면 어떤 논거를 들 수 있을까요? 텍스트의 다른 부분에서 근거를 찾아 반론을 구성해 보세요.`,
    // 7. 논증 전략 분석
    `구절 분석:\n"${focusPassage}"\n\n저자는 이 부분에서 어떤 논증 전략을 사용하고 있나요? 해당 전략의 강점과 한계를 텍스트 내에서 찾아 설명해 주세요.`,
    // 8. 현대적 유효성
    `핵심 텍스트:\n"${focusPassage}"\n\n이 구절의 의미가 현대 사회에도 여전히 유효한지, 아니면 시대적 한계가 있는지를 텍스트 근거와 함께 논증해 주세요.`,
    // 9. 인과 추론 분석 (NEW)
    `구절:\n"${focusPassage}"\n\n저자가 이 구절에서 제시하는 인과관계는 무엇인가요? 그 인과 추론의 논리적 타당성을 검토하고, 약점이 있다면 텍스트 근거를 들어 지적해 보세요.`,
    // 10. 다중 구절 교차 분석 (NEW - uses secondary passage)
    secondaryPassage
      ? `두 구절을 비교해 봅시다:\n구절 A: "${focusPassage}"\n구절 B: "${secondaryPassage}"\n\n이 두 구절은 서로 보완하는가, 아니면 긴장 관계에 있는가? 텍스트 근거를 들어 관계를 분석해 주세요.`
      : `구절:\n"${focusPassage}"\n\n이 구절에서 드러나는 저자의 세계관은 무엇이며, 텍스트의 다른 부분과 어떤 관계를 맺는지 근거를 들어 설명해 주세요.`,
    // 11. 독자 반응 예측 (NEW)
    `아래 구절을 읽고 답하세요:\n"${focusPassage}"\n\n이 구절에 대해 동의하지 않는 독자가 있다면, 그 반론의 핵심은 무엇일까요? 그리고 저자는 어떻게 방어할 수 있을지 텍스트를 근거로 구성해 보세요.`,
    // 12. 핵심 개념 재정의 (NEW)
    `핵심 구절:\n"${focusPassage}"\n\n이 구절에 등장하는 핵심 개념을 당신만의 언어로 재정의하고, 그 재정의가 원문의 의도와 어떻게 같거나 다른지 텍스트 근거로 설명해 주세요.`,
  ];

  const randomIndex = Math.abs(templateSeed * 17) % templates.length;
  return templates[randomIndex];
}

sessionRoute.post('/api/session/start', async (c) => {
  let phase = 'request_parse';

  try {
    const body = await c.req.json<SessionStartRequest>();
    let bookId = body.bookId || 'meditations-iv';
    const startMode = normalizeStartMode(body.startMode);
    const db = c.env.DB;

    // Persistent learning data always belongs to an authenticated user.
    const userId = requesterId(c);
    if (!userId) return c.json({ error: '인증이 필요합니다.' }, 401);

    const launchId = body.growthFollowUpLaunchId;
    if (launchId !== undefined && (typeof launchId !== 'string' || !launchId.trim()
      || Object.keys(body).some(key => key !== 'growthFollowUpLaunchId'))) {
      return c.json({ error: '후속 시도는 발급된 시작 ID만 사용해야 합니다.', code: 'GROWTH_FOLLOW_UP_INPUT_INVALID' }, 400);
    }
    const followUp = launchId ? await loadOwnedFollowUpLaunch(db, userId, launchId, 'SPARRING') : null;
    if (followUp?.session_id) {
      const saved = await getSession(db, followUp.session_id);
      if (saved?.isCompleted || (saved && saved.currentTurn > saved.maxTurns)) throw new GrowthServiceError({status:409,code:'GROWTH_FOLLOW_UP_ALREADY_COMPLETED',phase:'conflict'});
      const context = await loadOwnedSparringContext(db, followUp.session_id, userId);
      await requireSparringControl(db,userId,followUp.session_id,true);
      const opening = saved?.conversationHistory.find(message => message.role === 'ai' && message.turn === 0);
      if (!saved || saved.userId !== userId || !opening) throw new GrowthServiceError({status:503,code:'GROWTH_FOLLOW_UP_SESSION_UNAVAILABLE',phase:'evidence'});
      return c.json({resumed:true,sessionId:saved.id,topic:saved.topic,openingMessage:opening.content,
        bookTitle:saved.bookTitle,bookChapter:saved.bookChapter,maxTurns:saved.maxTurns,
        phases:['elicitation','grounding','reasoning','counterexample','revision','synthesis'],
        startMode:'initial_claim',startModeLabel:getStartModeLabel('initial_claim'),
        context:{id:context.id,kind:context.context.kind},
        growthFollowUp:await readFollowUpLink(db,userId,saved.id,'SPARRING')});
    }
    if (followUp) {
      const baseline = await getSession(db, followUp.baseline_session_id);
      if (!baseline || baseline.userId !== userId || !baseline.isCompleted) throw new GrowthServiceError({status:422,code:'GROWTH_FOLLOW_UP_BASELINE_UNAVAILABLE',phase:'evidence'});
      bookId = baseline.bookId;
    }

    // Ensure built-in books are seeded
    phase = 'seed_books';
    await seedBuiltinBooks(db, getAllBooks());

    // Get book from D1
    phase = 'load_book';
    const bookRow = await getBookFromDB(db, bookId, userId);
    if (!bookRow) {
      return c.json({ error: 'Book not found' }, 404);
    }

    const book = {
      id: bookRow.id as string,
      title: bookRow.title as string,
      author: bookRow.author as string,
      chapter: bookRow.chapter as string,
      text: bookRow.text as string,
    };

    phase = 'select_opening_evidence';
    const openingEvidence = await retrieveLibraryChunks(db, book.id, followUp?.changed_condition || body.topic || book.title, userId);
    if (openingEvidence.length === 0) {
      return c.json({ error: '이 도서에서 사용할 수 있는 근거가 없습니다. 다른 도서를 선택해 주세요.', code: 'SPARRING_SOURCE_UNAVAILABLE', retryable: false }, 409);
    }
    const openingEvidenceText = renderLibraryEvidence(openingEvidence);

    // Parse DB-stored keyPassages for dynamic question generation (V3)
    let dbKeyPassages: { verse: string; text: string }[] = [];
    try {
      const rawPassages = bookRow.key_passages as string;
      if (rawPassages) {
        dbKeyPassages = JSON.parse(rawPassages);
      }
    } catch (e) { console.error('[P1-004] parse:', e); }

    // The context must exist before any optional model-generated wording.
    // These deterministic values remain the safe fallback for unavailable
    // providers and make the opening authority independent of global keys.
    const topic = followUp?.changed_condition || body.topic?.trim() || (startMode === 'deep_reading_question'
      ? '핵심 구절의 의미와 함의 재구성'
      : `${book.title}의 핵심 주장 검토`);
    const startSeed = stableSeed(book.id, topic, startMode);
    let focusPassage = openingEvidence[0]?.content.substring(0, 280)
      || pickFocusPassage(book.text || '', startSeed, book.id, dbKeyPassages);
    const deterministicOpening = startMode === 'deep_reading_question'
      ? buildDeepReadingQuestion(
        focusPassage || pickFocusPassage(book.text || '', startSeed + 7, book.id, dbKeyPassages),
        topic,
        startSeed,
        book.id,
        dbKeyPassages,
      )
      : `오늘의 탐구에 오신 것을 환영합니다. 우리는 "${book.title}"의 핵심 주제를 검토합니다. 이 텍스트에 대한 당신의 초기 입장은 무엇인가요? 자유롭게 주장을 제시해 주세요.`;
    let openingMessage = followUp ? `${deterministicOpening}\n\n이번 시도의 달라진 조건: ${followUp.changed_condition}\n이 조건을 반영해 주장을 다시 구성해 주세요.` : deterministicOpening;

    // Create session in D1 with user_id
    phase = 'create_session';
    const session = await createSession(
      db,
      book.id,
      book.title,
      book.chapter,
      topic,
      '', // Core claim will be set when student provides initial claim
      userId
    );

    let preserveExistingContext = false;
    let openingManifest: { manifestId: string; manifestSha256: string };
    let learningSessionContext: SessionExecutionContext;
    try {
      phase = 'persist_opening_evidence';
      openingManifest = await persistSparringEvidence(db, {
        sessionId: session.id,
        turnNumber: 0,
        userId,
        bookId: book.id,
        query: topic,
        chunks: openingEvidence,
      });

      // The opening manifest is the first immutable evidence boundary for a
      // Sparring session. Only after it exists may the session acquire a
      // durable authority and runtime-policy context.
      phase = 'create_learning_session_context';
      const routePlan = pinAIRoutePlan(c.env);
      const contextInput = {
        db,
        sessionId: session.id,
        ownerUserId: userId,
        subjectId: userId,
        authorityCapabilities: ['growth_lab:owner'],
        contextPolicyRevision: GROWTH_LAB_CONTEXT_POLICY_REVISION,
        corpusBindingId: `book:${book.id}`,
        corpusManifestRevision: openingManifest.manifestSha256,
        routes: routePlan,
        promptCacheNamespace: `sparring:${session.id}`,
        evidencePolicyRevision: GROWTH_LAB_EVIDENCE_POLICY_REVISION,
      } as const;
      try {
        learningSessionContext = await createGrowthLabSparringContext(contextInput);
      } catch (error) {
        if (error instanceof LearningSessionContextError && error.code === 'CONTEXT_ALREADY_EXISTS') {
          const existingContext = await loadOwnedSparringContext(db, session.id, userId);
          if (!matchingContext(existingContext, {
            sessionId: session.id,
            userId,
            corpusBindingId: contextInput.corpusBindingId,
            corpusManifestRevision: contextInput.corpusManifestRevision,
            routes: routePlan,
            promptCacheNamespace: contextInput.promptCacheNamespace,
          })) {
            preserveExistingContext = true;
            throw new LearningSessionContextError('CONTEXT_WRITE_FAILED');
          }
          learningSessionContext = existingContext;
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (!preserveExistingContext) {
        phase = 'compensate_start_failure';
        try {
          await compensateSessionStart(db, session.id);
        } catch (compensationError) {
          console.error('[SESSION] Start compensation failed:', compensationError);
        }
      }
      throw error;
    }

    // Optional opening wording is a normal context-bound turn-zero invocation.
    // It cannot alter the deterministic topic or opening evidence authority.
    phase = 'generate_context_bound_opening';
    try {
      await requireSparringSource(db,book.id,userId);
      const router = createAIRouter(c.env, {
        mode: 'context_bound',
        pinnedRoutePlan: learningSessionContext.routes,
        invocationScope: {
          sessionContextId: learningSessionContext.id,
          sessionId: session.id,
          turnNumber: 0,
          promptCacheNamespace: learningSessionContext.promptCacheNamespace,
        },
      });
      const opening = await router.completeValidatedJSON(
        'interactive_generation',
        {
          systemPrompt: contextBoundOpeningSystemPrompt,
          userPrompt: renderPromptTemplate(contextBoundOpeningUserPrompt, {
            BOOK_TITLE: book.title,
            MODE: getStartModeLabel(startMode),
            TOPIC: topic,
            FOCUS_PASSAGE: focusPassage,
            APPROVED_EVIDENCE: openingEvidenceText.substring(0, 1800),
          }),
          temperature: 0.2,
          maxTokens: 500,
        },
        validateContextBoundOpening,
      );
      openingMessage = opening.value.openingMessage;
    } catch (error) {
      if (isAIInvocationReceiptPersistenceError(error) || (error instanceof GrowthServiceError && error.code==='SPARRING_SOURCE_UNAVAILABLE')) {
        phase = 'compensate_opening_receipt_failure';
        try {
          await compensateSessionStart(db, session.id);
        } catch (compensationError) {
          console.error('[SESSION] Opening receipt compensation failed:', compensationError);
        }
        throw error;
      }
      // Provider output and source content are never logged. The deterministic
      // opening remains valid when the context-bound lane is unavailable.
      console.warn('[SESSION] Context-bound opening unavailable; deterministic opening retained.');
    }

    if (followUp && !openingMessage.includes(followUp.changed_condition)) openingMessage += `\n\n이번 시도의 달라진 조건: ${followUp.changed_condition}`;

    // A successful start must contain both recoverable learning state and its opening.
    phase = 'save_initial_session';
    try {
      const { createStudentModel, serializeStudentModel } = await import('../services/tutoring/orchestrator');
      const { createLayerState, serializeLayerState } = await import('../services/tutoring/question-layer-tracker');
      const initStudentModel = createStudentModel(session.id, topic, '핵심 주장을 명확하게 표현하기');
      const results = await db.batch([
        db.prepare(
          'UPDATE sessions SET tutor_state = ?2, student_model = ?3, layer_state_json = ?4 WHERE id = ?1'
        ).bind(session.id, 'elicitation', serializeStudentModel(initStudentModel), serializeLayerState(createLayerState())),
        db.prepare(
          'INSERT INTO messages (session_id, role, content, turn, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)'
        ).bind(session.id, 'ai', openingMessage, 0, Date.now()),
        ...(followUp ? [prepareFollowUpBinding(db,followUp.id,session.id,learningSessionContext.id,Date.now(),'SPARRING')] : []),
      ]);
      if (results.length !== (followUp ? 3 : 2) || results.some(result => !result.success || result.meta.changes !== 1)) {
        throw new Error('Initial session persistence was not confirmed.');
      }
    } catch (error) {
      let cleanupVerified = false;
      try {
        await compensateSessionStart(db, session.id);
        cleanupVerified = true;
      } catch {
        console.error('[SESSION] Initial session cleanup could not be verified.');
      }
      if(cleanupVerified && String(error).includes('SPARRING_SOURCE_UNAVAILABLE'))return c.json({error:'이 도서의 근거를 더 이상 사용할 수 없어 대화를 시작하지 않았습니다.',code:'SPARRING_SOURCE_UNAVAILABLE',retryable:false,cleanupState:'VERIFIED'},409);
      return c.json({
        error: '세션의 시작 내용을 저장하지 못했습니다.',
        code: 'SESSION_START_PERSISTENCE_REQUIRED',
        phase,
        retryable: cleanupVerified,
        cleanupState: cleanupVerified ? 'VERIFIED' : 'UNVERIFIED',
        assessmentState: 'UNGRADABLE',
      }, 503);
    }

    const response: SessionStartResponse = {
      ...(followUp ? {growthFollowUp:await readFollowUpLink(db,userId,session.id,'SPARRING')} : {}),
      sessionId: session.id,
      topic,
      openingMessage,
      bookTitle: book.title,
      bookChapter: book.chapter,
      maxTurns: 10,
      phases: ['elicitation', 'grounding', 'reasoning', 'counterexample', 'revision', 'synthesis'] as const,
      startMode,
      startModeLabel: getStartModeLabel(startMode),
      grounding: {
        manifestSha256: openingManifest.manifestSha256,
        sourceIds: openingEvidence.map((source) => source.chunkId),
      },
      context: {
        id: learningSessionContext.id,
        kind: learningSessionContext.context.kind,
      },
    };

    return c.json(response);
  } catch (error: unknown) {
    if (error instanceof GrowthServiceError) return c.json({code:error.code,phase:error.phase,retryable:error.retryable,assessmentState:'UNGRADABLE'},error.status);
    if(String(error).includes('SPARRING_SOURCE_UNAVAILABLE'))return c.json({error:'이 도서의 근거를 사용할 수 없습니다.',code:'SPARRING_SOURCE_UNAVAILABLE',retryable:false},409);
    console.error('Session start error:', error);
    if (isAIInvocationReceiptPersistenceError(error)) {
      return c.json({
        error: 'AI invocation receipt persistence is required before session start can complete.',
        code: 'AI_INVOCATION_RECEIPT_REQUIRED',
        phase,
        retryable: false,
        failureClass: 'receipt_persistence',
        assessmentState: 'UNGRADABLE',
      }, 503);
    }
    return c.json({ error: 'Sparring 세션을 시작하지 못했습니다.', phase }, 500);
  }
});

sessionRoute.get('/api/session/:id', async (c) => {
  const id = c.req.param('id');
  const requesterUserId = requesterId(c);
  const db = c.env.DB;
  const session = await getSession(db, id);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  if (!canAccessOwnerResource(session.userId, requesterUserId)) {
    return c.json({ error: '접근 권한이 없습니다.' }, 403);
  }

  const persistedEvaluation = await db.prepare(
    'SELECT 1 AS present FROM evaluations WHERE session_id = ?1 LIMIT 1'
  ).bind(id).first<{ present: number }>();
  const hasMeasuredEvaluation = Boolean(persistedEvaluation)
    && session.rating !== 'UNKNOWN'
    && Number.isFinite(session.avgLogic)
    && session.avgLogic >= 20
    && session.avgLogic <= 100;

  return c.json({
    id: session.id,
    topic: session.topic,
    bookTitle: session.bookTitle,
    bookChapter: session.bookChapter,
    currentTurn: session.currentTurn,
    maxTurns: session.maxTurns,
    currentPhase: session.currentPhase,
    hintLevel: session.hintLevel,
    radarScores: hasMeasuredEvaluation ? session.radarScores : null,
    avgLogic: hasMeasuredEvaluation ? session.avgLogic : null,
    rating: hasMeasuredEvaluation ? session.rating : 'UNKNOWN',
    evaluationStatus: hasMeasuredEvaluation ? 'MEASURED' : 'UNKNOWN',
    conversationHistory: session.conversationHistory,
    isActive: session.currentTurn <= session.maxTurns,
  });
});

// POST /api/session/:id/abandon - Mark session as abandoned
sessionRoute.post('/api/session/:id/abandon', async (c) => {
  const id = c.req.param('id');
  const requesterUserId = requesterId(c);
  const db = c.env.DB;

  const session = await getSession(db, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (!canAccessOwnerResource(session.userId, requesterUserId)) {
    return c.json({ error: '접근 권한이 없습니다.' }, 403);
  }

  const { markSessionAbandoned } = await import('../services/student-model');
  const success = await markSessionAbandoned(db, id);

  if (!success) {
    return c.json({ error: 'Session not found or already completed/abandoned' }, 400);
  }

  return c.json({ success: true, message: '세션이 이탈 처리되었습니다.' });
});

export default sessionRoute;
