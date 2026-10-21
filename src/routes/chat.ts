import { loadSparringRevisions } from '../services/sparring-revisions';
import { guardSparringNonProgress } from '../services/sparring-controls';
import { GrowthServiceError } from '../services/growth-cycle-types';
// Chat API Route - POST /api/chat (V14.0 - Intelligence Layer + Token Tracking)
// Architecture: processStudentTurn() → Mentor-Critic → Final Response (SINGLE LLM evaluation)
// v13.0: ✅ 이중 LLM 호출 제거 (legacy evaluateStudent 삭제)
//        ✅ 토큰 사용량 추적 (per-call logging + request-level accumulation)
//        ✅ 프롬프트 캐싱 지원 (시스템 프롬프트 안정화)
import { Hono, type Context } from 'hono';
import type { Bindings, ChatRequest, ChatResponse, EvaluationResult, SessionReport } from '../types';
import type { TutorState, WeaknessTag, DeepEvaluation, StudentModel } from '../services/tutoring/types';
import { getSession, updateSessionAfterEvaluation, generateSessionReport, saveSessionReport, buildEvaluationSaveStatement } from '../services/student-model';
// v13.0: evaluateStudent from evaluator.ts REMOVED (이중 호출 제거 - P0)
import { getDeepReport } from '../services/deep-analytics';
import { requireAuth, getAuthUser, canAccessOwnerResource } from '../middleware/auth';
import { checkUsageLimit } from '../middleware/usage-limit';
import { verifyConstraints, queryGroundedNodes } from '../services/math/knowledge-graph';
import { runResearcherAgent, persistResearchToD1 } from '../services/math/researcher-agent';
import { setTokenTrackingContext, resetRequestTokenUsage, getRequestTokenUsage } from '../services/ai-client';
import { AIRouteUnavailableError, createAIRouter, isAIInvocationReceiptPersistenceError, type AIFailureClass, type AIRouter } from '../services/ai-router';
import { prepareSparringEvidence, renderLibraryEvidence, retrieveLibraryChunks } from '../services/library-retrieval';
import { prepareLearnerSourceAttribution } from '../services/source-attribution';
import { renderPromptTemplate } from '../services/prompt-template';
import sessionEndAnalysisSystemPrompt from '../services/tutoring/prompts/session-end-analysis.system.md?raw';
import sessionEndAnalysisUserPrompt from '../services/tutoring/prompts/session-end-analysis.user.md?raw';
import {
  LearningSessionContextError,
  loadOwnedSparringContext,
  type SessionExecutionContext,
} from '../services/learning-session-context';

import { readSavedIntelligence, SavedIntelligenceError } from '../services/tutoring/saved-intelligence';
import type { LayerState } from '../services/tutoring/question-layer-tracker';

const chatRoute = new Hono<{ Bindings: Bindings }>();

chatRoute.use('/api/chat', requireAuth);
chatRoute.use('/api/chat', checkUsageLimit); // v14.0: Daily token limit enforcement

function requesterId(c: Context<{ Bindings: Bindings }>): string | null {
  return getAuthUser(c)?.userId || null;
}

const ROUTE_FAILURE_CLASSES = [
  'unconfigured', 'unauthorized', 'not_found', 'rate_limited', 'bad_request',
  'timeout', 'network', 'provider_unavailable', 'invalid_response', 'receipt_persistence', 'unknown',
] as const;

function routeFailureMetadata(error: unknown): { failureClass: AIFailureClass; retryable: boolean } {
  if (error instanceof AIRouteUnavailableError) {
    return { failureClass: error.failureClass, retryable: error.retryable };
  }
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { failureClass?: unknown; retryable?: unknown };
    if (typeof candidate.failureClass === 'string'
      && (ROUTE_FAILURE_CLASSES as readonly string[]).includes(candidate.failureClass)) {
      return {
        failureClass: candidate.failureClass as AIFailureClass,
        retryable: candidate.retryable === true,
      };
    }
  }
  return { failureClass: 'invalid_response', retryable: true };
}

const MICRO_ANALYSIS_AXES = [
  'comprehension',
  'judgment',
  'persuasion',
  'evidenceQuality',
  'reasoning',
  'consistency',
  'revision',
  'relevance',
] as const;

type MicroAnalysis = Record<(typeof MICRO_ANALYSIS_AXES)[number], number>;

interface SessionEndAnalysis {
  summary: string;
  microAnalysis?: MicroAnalysis;
  strengths?: string[];
  weaknesses?: string[];
  growthTrajectory?: string;
  prescriptiveFeedback?: {
    immediate: string[];
    nextSession: string[];
    longTerm: string[];
  };
  turnByTurnGrowth?: {
    earlyPhase: string;
    midPhase: string;
    latePhase: string;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateMicroAnalysis(value: unknown): MicroAnalysis | undefined | null {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== MICRO_ANALYSIS_AXES.length
    || MICRO_ANALYSIS_AXES.some((axis) => !Object.prototype.hasOwnProperty.call(value, axis))) {
    return null;
  }
  const scores = {} as MicroAnalysis;
  for (const axis of MICRO_ANALYSIS_AXES) {
    const score = value[axis];
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 100) return null;
    scores[axis] = score;
  }
  return scores;
}

function validateSessionEndAnalysis(value: unknown): SessionEndAnalysis | null {
  if (!isPlainObject(value) || typeof value.summary !== 'string' || value.summary.trim().length === 0) return null;

  const microAnalysis = validateMicroAnalysis(value.microAnalysis);
  if (microAnalysis === null) return null;
  if (value.strengths !== undefined && !isStringArray(value.strengths)) return null;
  if (value.weaknesses !== undefined && !isStringArray(value.weaknesses)) return null;
  if (value.growthTrajectory !== undefined && typeof value.growthTrajectory !== 'string') return null;

  let prescriptiveFeedback: SessionEndAnalysis['prescriptiveFeedback'];
  if (value.prescriptiveFeedback !== undefined) {
    if (!isPlainObject(value.prescriptiveFeedback)
      || !isStringArray(value.prescriptiveFeedback.immediate)
      || !isStringArray(value.prescriptiveFeedback.nextSession)
      || !isStringArray(value.prescriptiveFeedback.longTerm)) return null;
    prescriptiveFeedback = {
      immediate: value.prescriptiveFeedback.immediate,
      nextSession: value.prescriptiveFeedback.nextSession,
      longTerm: value.prescriptiveFeedback.longTerm,
    };
  }

  let turnByTurnGrowth: SessionEndAnalysis['turnByTurnGrowth'];
  if (value.turnByTurnGrowth !== undefined) {
    if (!isPlainObject(value.turnByTurnGrowth)
      || typeof value.turnByTurnGrowth.earlyPhase !== 'string'
      || typeof value.turnByTurnGrowth.midPhase !== 'string'
      || typeof value.turnByTurnGrowth.latePhase !== 'string') return null;
    turnByTurnGrowth = {
      earlyPhase: value.turnByTurnGrowth.earlyPhase,
      midPhase: value.turnByTurnGrowth.midPhase,
      latePhase: value.turnByTurnGrowth.latePhase,
    };
  }

  return {
    summary: value.summary,
    ...(microAnalysis === undefined ? {} : { microAnalysis }),
    ...(value.strengths === undefined ? {} : { strengths: value.strengths }),
    ...(value.weaknesses === undefined ? {} : { weaknesses: value.weaknesses }),
    ...(value.growthTrajectory === undefined ? {} : { growthTrajectory: value.growthTrajectory }),
    ...(prescriptiveFeedback === undefined ? {} : { prescriptiveFeedback }),
    ...(turnByTurnGrowth === undefined ? {} : { turnByTurnGrowth }),
  };
}

interface PreCommitSessionEndInput {
  topic: string;
  bookTitle: string;
  initialClaim: string;
  finalClaim: string;
  currentEvaluation: EvaluationResult & { claim: string };
  evidenceCited: number;
  weaknessPattern: readonly string[];
  hintRequestCount: number;
  conversation: readonly { turn: number; role: string; content: string }[];
}

async function requestPreCommitSessionEndAnalysis(
  router: AIRouter,
  input: PreCommitSessionEndInput,
): Promise<SessionEndAnalysis> {
  const conversationSummary = JSON.stringify(input.conversation
    .slice(-20)
    .map((message) => ({
      turn: message.turn,
      role: message.role,
      content: message.content.substring(0, 250),
    })));
  const scores = input.currentEvaluation.radarScores;
  const evaluationSummary = JSON.stringify({
    claim: input.currentEvaluation.claim,
    diagnosis: input.currentEvaluation.diagnosis,
    reasoningGap: input.currentEvaluation.reasoningGap,
    recommendedMove: input.currentEvaluation.recommendedMove,
    radarScores: scores,
  });

  return (await router.completeValidatedJSON(
    'background_reasoning',
    {
      systemPrompt: sessionEndAnalysisSystemPrompt,
      userPrompt: renderPromptTemplate(sessionEndAnalysisUserPrompt, {
        TOPIC: input.topic,
        BOOK_TITLE: input.bookTitle,
        INITIAL_CLAIM: input.initialClaim,
        FINAL_CLAIM: input.finalClaim,
        EVALUATION_JSON: evaluationSummary,
        EVIDENCE_CITED: String(input.evidenceCited),
        WEAKNESS_PATTERN: input.weaknessPattern.join(', '),
        HINT_REQUEST_COUNT: String(input.hintRequestCount),
        CONVERSATION_JSON: conversationSummary,
      }),
      temperature: 0.4,
      maxTokens: 1500,
    },
    validateSessionEndAnalysis,
  )).value;
}

chatRoute.post('/api/chat', async (c) => {
  let phase = 'request_parse';
  let body: ChatRequest | undefined;

  try {
    body = await c.req.json<ChatRequest>();
    const { sessionId, message } = body;

    if (!sessionId || !message) {
      return c.json({ error: 'sessionId and message are required' }, 400);
    }

    const db = c.env.DB;

    // TURN-DRIFT FIX: Always load session from DB (includes conversationHistory)
    // This ensures we always have the latest state, regardless of client state
    phase = 'load_session';
    const session = await getSession(db, sessionId);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const requesterUserId = requesterId(c);
    if (!requesterUserId || !canAccessOwnerResource(session.userId, requesterUserId)) {
      return c.json({ error: '접근 권한이 없습니다.' }, 403);
    }

    // A Sparring turn has no authority to inspect evidence or call AI until it
    // has reloaded the immutable context for this authenticated owner.
    let learningSessionContext: SessionExecutionContext;
    phase = 'load_learning_session_context';
    try {
      learningSessionContext = await loadOwnedSparringContext(db, session.id, requesterUserId);
    } catch (contextError) {
      if (contextError instanceof LearningSessionContextError) {
        if (contextError.code === 'CONTEXT_NOT_FOUND') {
          return c.json({
            error: 'This Sparring session needs a learning context before a new turn can begin.',
            code: 'SESSION_CONTEXT_REQUIRED',
            recoverable: true,
            assessmentState: 'UNGRADABLE',
          }, 409);
        }
        return c.json({
          error: 'The Sparring learning context is invalid and cannot be used.',
          code: 'SESSION_CONTEXT_INVALID',
          contextError: contextError.code,
          recoverable: false,
          assessmentState: 'UNGRADABLE',
        }, 503);
      }
      console.error('[CHAT] Learning session context could not be loaded:', contextError);
      return c.json({
        error: 'The Sparring learning context is temporarily unavailable.',
        code: 'SESSION_CONTEXT_UNAVAILABLE',
        retryable: true,
        assessmentState: 'UNGRADABLE',
      }, 503);
    }

    // Check if session is already ended
    if (session.currentTurn > session.maxTurns) {
      return c.json({ error: 'Session has ended' }, 400);
    }

    const control=await guardSparringNonProgress(db,requesterUserId,sessionId);
    const revisionState=await loadSparringRevisions(db,requesterUserId,sessionId);
    const learnerRevision=revisionState.pending?{...revisionState.pending,supportResponse:revisionState.candidates.find(p=>p.messageId===revisionState.pending?.priorMessageId)?.support.find(h=>h.id===revisionState.pending?.supportId)?.responseText??null}:null;
    const { thoughtProfile: prevThoughtProfile, challengeState: prevChallengeState } = readSavedIntelligence(session.thoughtProfileJson, session.challengeStateJson);

    const router = createAIRouter(c.env, {
      mode: 'context_bound',
      pinnedRoutePlan: learningSessionContext.routes,
      invocationScope: {
        sessionContextId: learningSessionContext.id,
        sessionId: session.id,
        turnNumber: session.currentTurn,
        promptCacheNamespace: learningSessionContext.promptCacheNamespace,
      },
    });

    // v13.0: Initialize token tracking for this request
    resetRequestTokenUsage();
    setTokenTrackingContext({
      db,
      sessionId,
      userId: session.userId || requesterId(c),
      turnNumber: session.currentTurn,
      callType: 'evaluate', // Will be updated per-call via orchestrator
    });

    phase = 'select_evidence';
    const evidenceChunks = await retrieveLibraryChunks(db, session.bookId, message, requesterUserId!);
    if (evidenceChunks.length === 0) {
      return c.json({ error: '이 도서에서 사용할 수 있는 근거가 없습니다. 저장된 대화는 기록에서 확인하고, 다른 도서로 새 대화를 시작할 수 있습니다.', code: 'SPARRING_SOURCE_UNAVAILABLE', retryable: false }, 409);
    }
    const evidenceManifest = await prepareSparringEvidence(db, {
      sessionId,
      turnNumber: session.currentTurn,
      userId: requesterUserId!,
      bookId: session.bookId,
      query: message,
      chunks: evidenceChunks,
    });
    const bookText = renderLibraryEvidence(evidenceChunks);

    // v13.0: REMOVED legacy evaluateStudent() call (was at line 81)
    // processStudentTurn() handles evaluation internally — single LLM call instead of double
    // This saves ~2,500 prompt + ~800 completion tokens per turn (~50% cost reduction)

    // Step 1: v13.0 - processStudentTurn 오케스트레이터 단일 진입점
    // training.ts와 동일한 D-Plan 오케스트레이터 사용 (아키텍처 통합)
    phase = 'generate_tutor_response';
    let tutorResponse: { aiReply: string; questionType: string };
    let criticMetadata: Record<string, unknown> | null = null;
    let researchMetadata: Record<string, unknown> | null = null;
    let aiRouting: ChatResponse['aiRouting'];
    let evaluation: EvaluationResult & { claim: string }; // populated only after a successful AI evaluation
    let evaluatorSourceIds: unknown = undefined;
    let runAcceptedSideEffects: (() => Promise<void>) | null = null;

    // D-Plan StudentModel 복원 (SessionState에서 직접 읽기)
    const { processStudentTurn, createStudentModel, serializeStudentModel, deserializeStudentModel }
      = await import('../services/tutoring/orchestrator');
    const { createLayerState, serializeLayerState, deserializeLayerState, determineNextLayer, updateLayerState }
      = await import('../services/tutoring/question-layer-tracker');

    let studentModel: StudentModel;
    try {
      studentModel = (session.studentModelRaw && session.studentModelRaw !== '{}' && session.studentModelRaw !== '')
        ? deserializeStudentModel(session.studentModelRaw)
        : createStudentModel(session.id, session.topic || '', '핵심 주장을 명확하게 표현하기');
    } catch (e) { console.error("[P1-004] Caught:", e);
      studentModel = createStudentModel(session.id, session.topic || '', '핵심 주장을 명확하게 표현하기');
    }

    // v12.2: StudentModel에 최신 세션 상태 동기화
    if (session.currentClaim && !studentModel.currentClaim) {
      studentModel.currentClaim = session.currentClaim;
    }
    if (session.weaknessPattern && session.weaknessPattern.length > 0 && (!studentModel.weaknessPatterns || studentModel.weaknessPatterns.length === 0)) {
      studentModel.weaknessPatterns = session.weaknessPattern as WeaknessTag[];
    }

    const currentTutorState = (session.tutorState || 'elicitation') as TutorState;

    // PATCH-002: BUG-004 fix — layerState declared outside try block to prevent scope leak
    let layerState: LayerState = createLayerState();


    try {
      // v13.0: Set tracking context for researcher call
      setTokenTrackingContext({ db, sessionId, userId: session.userId || requesterId(c), turnNumber: session.currentTurn, callType: 'researcher' });

      // Phase 3A-Step1: the Researcher is scoped to the same immutable
      // background lane plan. An unavailable route remains unavailable; it
      // is never rewritten as a negative fact-check result.
      try {
        const researchResult = await runResearcherAgent(
          router,
          {
            sessionId: session.id,
            studentMessage: message,
            topic: session.topic || '',
            bookText,
            approvedEvidenceSources: evidenceChunks.map((source) => ({
              sourceId: source.chunkId,
              content: source.content,
              contentSha256: source.contentSha256,
              charStart: source.charStart,
              charEnd: source.charEnd,
            })),
            currentClaim: session.currentClaim || '',
            weaknessPattern: session.weaknessPattern || [],
          },
        );
        researchMetadata = {
          status: researchResult.factCheckResult.status,
          claimVerified: researchResult.factCheckResult.claimVerified,
          confidence: researchResult.factCheckResult.confidence,
          suggestedAngles: researchResult.suggestedAngles,
          trustMarkers: researchResult.trustMarkers.slice(0, 3),
          passageCount: researchResult.relevantPassages.length,
          researchTimeMs: researchResult.researchTimeMs,
        };
        persistResearchToD1(db, session.id, session.currentTurn, researchResult).catch(() => {});
      } catch (resErr) {
        if (isAIInvocationReceiptPersistenceError(resErr)) throw resErr;
        console.warn('[RESEARCHER] Non-critical error:', resErr);
      }

      // v13.0: Set tracking context for orchestrator (evaluate+mentor+critic)
      setTokenTrackingContext({ db, sessionId, userId: session.userId || requesterId(c), turnNumber: session.currentTurn, callType: 'evaluate' });

      // processStudentTurn 호출 — training.ts와 동일 패턴 (SINGLE evaluation)
      // v14.0: Pass thoughtProfile and challengeState from session

      phase = 'process_student_turn';
      const result = await processStudentTurn({
        router,
        sessionId: session.id,
        currentState: currentTutorState,
        studentModel,
        studentMessage: message,
        bookText,
        conversationHistory: session.conversationHistory.map(m => ({
          role: m.role === 'ai' ? 'assistant' : 'user',
          content: m.content,
        })),
        turnNumber: session.currentTurn,
        maxTurns: session.maxTurns,
        db,
        userId: session.userId,
        // v14.0: Intelligence layer
        thoughtProfile: prevThoughtProfile,
        challengeState: prevChallengeState,
        evidenceSourceIds: evidenceChunks.map((source) => source.chunkId),
        learnerRevision,
        revisionAttemptScope: 'SPARRING',
      });
      runAcceptedSideEffects = result.runAcceptedSideEffects;
      aiRouting = result.aiRouting;

      tutorResponse = {
        aiReply: result.tutorResponse,
        questionType: result.questionType,
      };

      // v13.0: Use orchestrator's evaluation result (SINGLE source of truth)
      const de = result.evaluation;
      evaluatorSourceIds = de.evidence_source_ids;
      evaluation = {
        radarScores: {
          defense: Math.round(de.reasoning_strength * 20),
          consistency: Math.round(de.consistency * 20),
          evidence: Math.round(de.evidence_use * 20),
          relevance: Math.round(de.relevance * 20),
          clarity: Math.round(de.claim_clarity * 20),
        },
        evidenceFound: (de.evidence_detected || []).length > 0,
        fallacyDetected: false,
        fallacyType: null,
        currentClaimUpdate: de.claim || message.substring(0, 100),
        weaknessDescription: de.diagnosis || '',
        weaknessPrompt: '',
        diagnosis: de.diagnosis || '',
        reasoningGap: de.reasoning_gap || '',
        missingPiece: '',
        recommendedMove: de.next_action || 'ask_evidence',
        weaknessTags: de.weakness_tags || [],
        claim: de.claim || '',
      };

      criticMetadata = result.criticVerdict ? {
        passed: result.criticVerdict.passed,
        leakageScore: result.criticVerdict.leakageScore,
        bloomLevel: result.criticVerdict.bloomLevel,
        source: 'orchestrator',
      } : null;
      if (criticMetadata) criticMetadata.aiRouting = aiRouting;

      // D-Plan 상태를 session 객체에 업데이트 → saveSession에서 통합 저장
      const updatedStudentModelJson = serializeStudentModel(result.studentModel);

      // LayerState 업데이트 (PATCH-002: BUG-004 fix — moved layerState init above try block)
      try {
        layerState = (session.layerStateJson && session.layerStateJson !== '')
          ? deserializeLayerState(session.layerStateJson)
          : createLayerState();
      } catch (e) { console.error('[P1-004] layerState:', e); layerState = createLayerState(); }

      const layerTransition = determineNextLayer(
        layerState.currentLayer, result.evaluation,
        layerState.turnsInCurrentLayer, session.currentTurn,
      );
      const updatedLayerState = updateLayerState(layerState, layerTransition.nextLayer, session.currentTurn);

      // initial_claim_v12 (첫 주장 보존)
      const initialClaim = !session.initialClaimV12
        ? (result.evaluation?.claim || evaluation?.currentClaimUpdate || message).substring(0, 500)
        : session.initialClaimV12;

      // ★ 핵심: session 객체의 D-Plan 상태를 업데이트하여
      // 이후 saveSession()에서 올바른 값이 저장되도록 함
      session.tutorState = result.state;
      session.studentModelRaw = updatedStudentModelJson;
      session.layerStateJson = serializeLayerState(updatedLayerState);
      session.initialClaimV12 = initialClaim;

      if (criticMetadata) {
        criticMetadata.layerTransition = layerTransition.shouldTransition ? layerTransition.reason : null;
        criticMetadata.engagementScore = result.criticVerdict?.engagementScore;
        criticMetadata.isGenericQuestion = result.criticVerdict?.isGenericQuestion;
        criticMetadata.intellectualTension = result.criticVerdict?.intellectualTension;
      }

      // v14.0: Save ThoughtProfile and ChallengeState from orchestrator
      if (result.thoughtProfile) {
        session.thoughtProfileJson = JSON.stringify(result.thoughtProfile);
      }
      if (result.challengeState) {
        session.challengeStateJson = JSON.stringify(result.challengeState);
      }

      console.log(`[D-PLAN v13.0] Turn ${session.currentTurn}: state ${currentTutorState}→${result.state}, action ${result.action}, layer ${layerState.currentLayer}→${updatedLayerState.currentLayer}`);

    } catch (orchError) {
      console.error('[ORCHESTRATOR] Tutor turn failed:', orchError);
      setTokenTrackingContext(null);
      if (isAIInvocationReceiptPersistenceError(orchError)) {
        return c.json({
          error: 'AI invocation receipt persistence is required before learner state can change.',
          code: 'AI_INVOCATION_RECEIPT_REQUIRED',
          phase,
          retryable: false,
          failureClass: 'receipt_persistence',
          assessmentState: 'UNGRADABLE',
          timestamp: new Date().toISOString(),
        }, 503);
      }
      if (orchError instanceof Error && (
        orchError.name === 'CriticUnavailableError'
        || orchError.name === 'EvaluatorUnavailableError'
      )) {
        throw orchError;
      }
      const routeFailure = routeFailureMetadata(orchError);
      return c.json({
        error: '튜터 응답 생성에 실패했습니다. 잠시 후 같은 답변으로 다시 시도해 주세요.',
        code: 'TUTOR_GENERATION_FAILED',
        phase: 'generate_tutor',
        retryable: routeFailure.retryable,
        failureClass: routeFailure.failureClass,
        assessmentState: 'UNGRADABLE',
        timestamp: new Date().toISOString(),
      }, 503);
    }

    const willEndSession = session.currentTurn >= session.maxTurns;
    let preCommitSessionEndAnalysis: SessionEndAnalysis | undefined;
    let preCommitReportUnavailable = false;
    if (willEndSession) {
      phase = 'generate_precommit_session_report';
      setTokenTrackingContext({
        db,
        sessionId,
        userId: session.userId || requesterId(c),
        turnNumber: session.currentTurn,
        callType: 'session_report',
      });
      const preCommitConversation = [
        ...session.conversationHistory.map((entry) => ({
          turn: entry.turn,
          role: entry.role,
          content: entry.content,
        })),
        { turn: session.currentTurn, role: 'student', content: message },
        { turn: session.currentTurn, role: 'ai', content: tutorResponse.aiReply },
      ];
      try {
        preCommitSessionEndAnalysis = await requestPreCommitSessionEndAnalysis(router, {
          topic: session.topic,
          bookTitle: session.bookTitle,
          initialClaim: session.initialClaimV12 || session.coreClaim,
          finalClaim: evaluation.currentClaimUpdate,
          currentEvaluation: evaluation,
          evidenceCited: session.textualEvidenceCited,
          weaknessPattern: session.weaknessPattern || [],
          hintRequestCount: session.hintRequestCount || 0,
          conversation: preCommitConversation,
        });
      } catch (error) {
        if (isAIInvocationReceiptPersistenceError(error)) throw error;
        // A normal provider or validation failure has a persisted attempt
        // receipt; the deterministic report below is explicitly unanalysed.
        preCommitReportUnavailable = true;
        console.warn('[SESSION_REPORT] Pre-commit analysis unavailable; deterministic report retained.');
      }
    }

    // v13.0: Clear token tracking context after LLM calls complete
    setTokenTrackingContext(null);

    // Step 4: Update student model (persists to D1)
    phase = 'update_session';
    const preparedAttribution = prepareLearnerSourceAttribution(db, {
      userId: requesterUserId!,
      sessionKind: 'sparring',
      sessionId,
      turnNumber: session.currentTurn,
      claim: message,
      manifestSha256: evidenceManifest.manifestSha256,
      sources: evidenceChunks.map((source) => ({
        sourceId: source.chunkId,
        passage: source.content,
        bookId: source.bookId,
        bookTitle: source.bookTitle,
        bookAuthor: source.bookAuthor,
        chunkIndex: source.chunkIndex,
        charStart: source.charStart,
        charEnd: source.charEnd,
        contentSha256: source.contentSha256,
        relevanceScore: source.relevanceScore,
        lifecycleStatus: source.lifecycleStatus,
      })),
      evaluatorSourceIds,
      evaluatorFallback: evaluatorSourceIds === undefined,
    });
    const updatedSession = await updateSessionAfterEvaluation(
      db,
      session,
      evaluation,
      message,
      tutorResponse.aiReply,
      tutorResponse.questionType,
      [
        ...evidenceManifest.statements,
        buildEvaluationSaveStatement(db, sessionId, session.userId, session.currentTurn, evaluation),
        ...preparedAttribution.statements,
      ],
      control.revision,
      learnerRevision,
    );
    const attribution = preparedAttribution.attribution;

    // Canonical turn persistence is now committed. Only now may orchestrator
    // analytics/KT side effects run, and their failure cannot reject the turn.
    if (runAcceptedSideEffects) {
      const task = runAcceptedSideEffects().catch(error => {
        console.error('[ACCEPTED_SIDE_EFFECTS] Non-critical:', error);
      });
      try {
        if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(task);
        else void task;
      } catch (error) {
        console.error('[ACCEPTED_SIDE_EFFECT_DISPATCH] Non-critical:', error);
        void task;
      }
    }

    // Step 5: Check session end
    const isSessionEnd = updatedSession.isCompleted;
    let sessionReport: SessionReport | undefined;
    let reportStatus: 'not_applicable' | 'ready' | 'unavailable' = 'not_applicable';
    let deepReportStatus: 'not_applicable' | 'processing' | 'unavailable' = 'not_applicable';
    let aiReply = tutorResponse.aiReply;

    if (isSessionEnd) {
      // The accepted-turn batch already committed completion. Everything below
      // is enrichment: it may affect availability, never acceptance of the turn.
      aiReply = '10턴의 토론이 모두 완료되었고 세션 기록이 저장되었습니다. 수고하셨습니다!';
      try {
        sessionReport = generateSessionReport(updatedSession);

      // The only provider-backed session-end analysis was completed before the
      // canonical turn commit. After commit, this block only overlays an
      // already validated result or retains the deterministic report.
      if (preCommitSessionEndAnalysis) {
        sessionReport.summary = preCommitSessionEndAnalysis.summary;
        if (preCommitSessionEndAnalysis.microAnalysis) {
          sessionReport.microAnalysis = preCommitSessionEndAnalysis.microAnalysis;
          sessionReport.microAnalysisStatus = 'PROVISIONAL_UNCALIBRATED';
        }
        if (preCommitSessionEndAnalysis.strengths) sessionReport.detailedStrengths = preCommitSessionEndAnalysis.strengths;
        if (preCommitSessionEndAnalysis.weaknesses) sessionReport.detailedWeaknesses = preCommitSessionEndAnalysis.weaknesses;
        if (preCommitSessionEndAnalysis.growthTrajectory) sessionReport.growthTrajectory = preCommitSessionEndAnalysis.growthTrajectory;
        if (preCommitSessionEndAnalysis.prescriptiveFeedback) sessionReport.prescriptiveFeedback = preCommitSessionEndAnalysis.prescriptiveFeedback;
        if (preCommitSessionEndAnalysis.turnByTurnGrowth) sessionReport.turnByTurnGrowth = preCommitSessionEndAnalysis.turnByTurnGrowth;
      } else if (preCommitReportUnavailable) {
        sessionReport.microAnalysisStatus = 'UNAVAILABLE';
      }

      // v14.0: Growth Profile update on session end
      try {
        if (session.userId) {
          const { updateGrowthProfile } = await import('../services/tutoring/growth-tracker');
          const thoughtProfile = JSON.parse(session.thoughtProfileJson || '{}');
          await updateGrowthProfile(db, session.userId, {
            totalTurns: updatedSession.currentTurn,
            avgScores: {
              evidence: (updatedSession.radarScores.evidence || 30) / 20,
              reasoning: (updatedSession.radarScores.defense || 30) / 20,
              defense: (updatedSession.radarScores.defense || 30) / 20,
              clarity: (updatedSession.radarScores.clarity || 30) / 20,
              consistency: (updatedSession.radarScores.consistency || 30) / 20,
            },
            weaknessPatterns: updatedSession.weaknessPattern || [],
            revisionSuccessCount: 0, // extracted from studentModel if available
            maxLayerReached: layerState?.currentLayer || 'surface',
            thoughtProfile: thoughtProfile.sampleSize ? thoughtProfile : { absolutistTendency: 0, binaryThinking: 0, definitionalVagueness: 0, intuitionOverText: 0, lastUpdatedTurn: 0, sampleSize: 0 },
          });
        }
      } catch (e) { console.warn('[GROWTH_TRACKER] Non-critical:', e); }

      // Deep analytics does not yet carry the frozen context and route plan
      // through its queue/worker boundary. It is intentionally unavailable
      // for context-bound Sparring instead of being dispatched with legacy
      // credentials or unscoped authority.
      deepReportStatus = 'unavailable';

      // Save report to D1 sessions table
      phase = 'save_session_report';
      try {
        await saveSessionReport(db, sessionId, sessionReport);
        reportStatus = 'ready';
      } catch (reportSaveError) {
        console.error('[SESSION_REPORT_SAVE] Non-critical:', reportSaveError);
        sessionReport = undefined;
        reportStatus = 'unavailable';
      }

      // Also save to session_reports table
      if (sessionReport) try {
        await db.prepare(`
          INSERT OR REPLACE INTO session_reports (session_id, user_id, initial_radar, final_radar, progress_summary, strengths, improvements, next_recommendation, total_turns, total_evidence_cited, avg_logic, final_rating, summary, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        `).bind(
          sessionId,
          updatedSession.userId,
          JSON.stringify(updatedSession.initialRadarScores),
          JSON.stringify(updatedSession.radarScores),
          sessionReport.summary || '',
          sessionReport.strengths,
          sessionReport.improvements,
          sessionReport.nextRecommendation,
          sessionReport.totalTurns,
          sessionReport.totalEvidenceCited,
          sessionReport.avgLogic,
          sessionReport.finalRating,
          sessionReport.summary || '',
          Date.now()
        ).run();
      } catch (e) {
        console.error('Session report table save error:', e);
      }

      if (reportStatus === 'ready') {
        aiReply = '10턴의 토론이 모두 완료되었습니다. 🎉 저장된 성장 리포트에서 오늘의 토론을 돌아보세요. 수고하셨습니다!';
      }
      } catch (reportGenerationError) {
        if (isAIInvocationReceiptPersistenceError(reportGenerationError)) throw reportGenerationError;
        console.error('[SESSION_REPORT_GENERATION] Non-critical:', reportGenerationError);
        sessionReport = undefined;
        reportStatus = 'unavailable';
      }
    }

    // Build response
    // A response reaches this point only after a successful provider evaluation.
    const evaluationSource = 'ai' as const;

    // v13.0: Capture accumulated token usage for this request
    const tokenUsage = getRequestTokenUsage();

    const response: ChatResponse = {
      aiReply,

      evaluation: {
        radarScores: updatedSession.radarScores,
        avgLogic: updatedSession.avgLogic,
        rating: updatedSession.rating,
        reasoningGap: evaluation.reasoningGap || '',
        missingPiece: evaluation.missingPiece || '',
        recommendedMove: evaluation.recommendedMove || '',
      },
      evaluationSource,
      evaluationExtended: evaluation.extendedMetrics || null,
      aiRouting,

      session: {
        currentTurn: updatedSession.currentTurn,
        maxTurns: updatedSession.maxTurns,
        currentPhase: updatedSession.currentPhase,
        tutorState: updatedSession.tutorState || 'elicitation',
        hintLevel: updatedSession.hintLevel,
        textualEvidenceCited: updatedSession.textualEvidenceCited,
        logicalFallaciesAvoided: updatedSession.logicalFallaciesAvoided,
        fallaciesDetected: updatedSession.fallaciesDetected,
        dialecticPace: updatedSession.dialecticPace,
        credibility: updatedSession.credibility,
      },

      discourse: {
        topic: updatedSession.topic,
        coreClaim: updatedSession.coreClaim,
        currentClaim: updatedSession.currentClaim,
      },

      weakness: updatedSession.currentWeakness,
      isSessionEnd,
      sessionReport,
      reportStatus,
      deepReportStatus,
      criticMetadata: criticMetadata || null,
      researchMetadata: researchMetadata || null,
      // Phase 3C: CTA suggestions based on evaluation & research
      ctaSuggestions: generateCTASuggestions(evaluation, researchMetadata),
      grounding: {
        manifestSha256: evidenceManifest.manifestSha256,
        sources: evidenceChunks.map((source) => ({
          sourceId: source.chunkId,
          passage: source.content,
          bookId: source.bookId,
          bookTitle: source.bookTitle,
          bookAuthor: source.bookAuthor,
          chunkIndex: source.chunkIndex,
          charStart: source.charStart,
          charEnd: source.charEnd,
          contentSha256: source.contentSha256,
          relevanceScore: source.relevanceScore,
          lifecycleStatus: source.lifecycleStatus,
        })),
      },
      attribution,
      // v13.0: Token usage metadata
      tokenUsage: {
        promptTokens: tokenUsage.promptTokens,
        completionTokens: tokenUsage.completionTokens,
        totalTokens: tokenUsage.totalTokens,
        estimatedCredits: Math.round(tokenUsage.estimatedCredits * 1000) / 1000,
        estimatedCostKRW: Math.round(tokenUsage.estimatedCredits * 2 * 100) / 100,
        llmCalls: tokenUsage.callCount,
        models: tokenUsage.models,
      },
      // v14.0: Intelligence layer metadata
      v14: (() => {
        try {
          const tp = JSON.parse(session.thoughtProfileJson || '{}');
          const cs = JSON.parse(session.challengeStateJson || '{}');
          return {
            thoughtProfile: tp.sampleSize > 0 ? {
              absolutistTendency: Math.round((tp.absolutistTendency || 0) * 100) / 100,
              binaryThinking: Math.round((tp.binaryThinking || 0) * 100) / 100,
              definitionalVagueness: Math.round((tp.definitionalVagueness || 0) * 100) / 100,
              intuitionOverText: Math.round((tp.intuitionOverText || 0) * 100) / 100,
              sampleSize: tp.sampleSize || 0,
            } : undefined,
            challengeLevel: cs.currentLevel || 1,
            challengeReason: cs.history?.length > 0 ? cs.history[cs.history.length - 1]?.reason : undefined,
          };
        } catch (e) { console.error('[P1-004] undef:', e); return undefined; }
      })(),
    };

    // 🔵 v9.0/v10.0 + v27: Mathematical engines integration (non-blocking)
    // BKT update + FAF argument graph recording + MAB reward update + Hybrid KT
    try {
      const db = c.env.DB;
      const userId = session.userId || null;

      // 1. BKT: Update Bayesian Knowledge Tracking probabilities
      const { processSessionBKT, percentageToBKTScore } = await import('../services/bkt-engine');
      const bktScores = {
        claim_clarity: percentageToBKTScore(evaluation.radarScores?.clarity),
        evidence_use: percentageToBKTScore(evaluation.radarScores?.evidence),
        reasoning_strength: percentageToBKTScore(evaluation.radarScores?.defense),
        consistency: percentageToBKTScore(evaluation.radarScores?.consistency),
        relevance: percentageToBKTScore(evaluation.radarScores?.relevance),
      };
      const hasCompleteBKTEvidence = Object.values(bktScores).every(score => score !== null);
      if (hasCompleteBKTEvidence) {
        await processSessionBKT(db, userId, sessionId, {
          claim_clarity: bktScores.claim_clarity!,
          evidence_use: bktScores.evidence_use!,
          reasoning_strength: bktScores.reasoning_strength!,
          consistency: bktScores.consistency!,
          relevance: bktScores.relevance!,
          weakness_tags: evaluation.weaknessTags || [],
        });
      } else {
        console.warn('[BKT] Evaluation scale is UNKNOWN; mutation skipped.');
      }

      // v27: Hybrid KT (BKT + LinUCB) real session integration
      if (userId) {
        try {
          const { initHybridKTState, updateBKTState, initBKTState, buildContextVector, recommendNextAction, updateLinUCBArm } = await import('../services/hybrid-kt-engine');
          let ktState = initHybridKTState(userId);
          
          // Load existing state from DB
          const storedKT = await db.prepare(
            'SELECT state_json FROM hybrid_kt_states WHERE user_id = ?'
          ).bind(userId).first();
          if (storedKT && (storedKT as Record<string, unknown>).state_json) {
            ktState = JSON.parse((storedKT as Record<string, unknown>).state_json as string);
          }

          // updatedSession.avgLogic is the measured 0-100 aggregate produced above.
          // Hybrid KT consumes 0-100; lightweight BKT receives explicit /20 conversion.
          const avgScore = updatedSession.avgLogic;
          if (!Number.isFinite(avgScore) || avgScore < 20 || avgScore > 100) {
            console.warn('[HYBRID-KT] Measured score is UNKNOWN; mutation skipped.');
          } else {
            // SessionState has no persisted difficulty; retain the legacy fallback.
            const difficulty = 0.5;

            // Update BKT for relevant concepts based on evaluation
            const conceptId = session.topic || session.bookId || 'general';
            if (!ktState.bktStates[conceptId]) {
              ktState.bktStates[conceptId] = initBKTState(conceptId);
            }
            ktState.bktStates[conceptId] = updateBKTState(
              ktState.bktStates[conceptId],
              avgScore >= 60,
              difficulty
            );

            // Update LinUCB arm if we had a previous action
            if (ktState.lastAction && ktState.linucbArms[ktState.lastAction]) {
              const reward = avgScore / 100;
              const context = buildContextVector(ktState.bktStates, updatedSession.currentTurn, avgScore, difficulty);
              ktState.linucbArms[ktState.lastAction] = updateLinUCBArm(
                ktState.linucbArms[ktState.lastAction],
                context,
                reward
              );
            }

            // Get next recommendation
            const recommendation = recommendNextAction(
              ktState, updatedSession.currentTurn, avgScore, difficulty
            );
            ktState.lastAction = recommendation.action;
            ktState.lastReward = avgScore;

            // Persist only when a real measured score was available.
            await db.prepare(
              'INSERT OR REPLACE INTO hybrid_kt_states (user_id, state_json, updated_at) VALUES (?, ?, ?)'
            ).bind(userId, JSON.stringify(ktState), new Date().toISOString()).run();
          }
        } catch (ktErr) {
          console.warn('[HYBRID-KT] Integration error (non-fatal):', ktErr);
        }
      }

      // 2. FAF: Record argument graph nodes and evaluate grounded semantics
      const { processArgumentGraph } = await import('../services/faf-engine');
      if (hasCompleteBKTEvidence) {
        await processArgumentGraph(
          db, sessionId, updatedSession.currentTurn - 1,
          message, tutorResponse.aiReply,
          {
            claim_clarity: bktScores.claim_clarity!,
            evidence_use: bktScores.evidence_use!,
            reasoning_strength: bktScores.reasoning_strength!,
          },
        );
      } else {
        console.warn('[FAF] Evaluation scale is UNKNOWN; mutation skipped.');
      }
    } catch (engErr) {
      // Non-critical: log but don't fail the request
      console.error('[MATH_ENGINE] BKT/FAF integration error (non-fatal):', engErr);
    }

    return c.json(response);
  } catch (error: unknown) {
    console.error(`[CHAT ERROR] phase=${phase}, session=${body?.sessionId || 'unknown'}`, error);

    if(error instanceof GrowthServiceError)return c.json({error:'현재 대화 상태에서는 답변을 진행할 수 없습니다.',code:error.code,phase:error.phase,retryable:error.retryable},error.status);
    if(String(error).includes('SPARRING_SOURCE_UNAVAILABLE'))return c.json({error:'이 도서의 근거를 더 이상 사용할 수 없습니다. 저장된 대화는 기록에서 확인할 수 있습니다.',code:'SPARRING_SOURCE_UNAVAILABLE',retryable:false},409);
    if(String(error).includes('SPARRING_REVISION_CONFLICT'))return c.json({error:'생각 수정 기록이 바뀌어 답변을 저장하지 않았습니다. 대화를 다시 불러와 주세요.',code:'SPARRING_REVISION_CONFLICT',retryable:false},409);
    if(String(error).includes('SPARRING_TURN_CONFLICT'))return c.json({error:'다른 답변이 먼저 저장되었습니다. 대화를 다시 불러와 주세요.',code:'SPARRING_TURN_CONFLICT',retryable:false},409);
    if(String(error).includes('SPARRING_CONTROL_CONFLICT'))return c.json({error:'대화 상태가 바뀌어 답변을 저장하지 않았습니다.',code:'SPARRING_CONTROL_CONFLICT',retryable:false},409);
    if (error instanceof SavedIntelligenceError) {
      return c.json({
        error: '저장된 학습 상태를 확인할 수 없습니다. 상태를 복구한 뒤 다시 시도해 주세요.',
        code: 'SAVED_LEARNING_STATE_UNAVAILABLE', phase, retryable: false,
        assessmentState: 'UNGRADABLE',
      }, 503);
    }

    if (isAIInvocationReceiptPersistenceError(error)) {
      return c.json({
        error: 'AI invocation receipt persistence is required before learner state can change.',
        code: 'AI_INVOCATION_RECEIPT_REQUIRED',
        phase,
        retryable: false,
        failureClass: 'receipt_persistence',
        assessmentState: 'UNGRADABLE',
        timestamp: new Date().toISOString(),
      }, 503);
    }

    if (error instanceof Error && error.name === 'CriticUnavailableError') {
      const routeFailure = routeFailureMetadata(error);
      return c.json({
        error: '튜터 응답 검수를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        code: 'CRITIC_UNAVAILABLE',
        phase,
        retryable: routeFailure.retryable,
        failureClass: routeFailure.failureClass,
        assessmentState: 'UNGRADABLE',
        timestamp: new Date().toISOString(),
      }, 503);
    }

    if (error instanceof Error && error.name === 'EvaluatorUnavailableError') {
      const routeFailure = routeFailureMetadata(error);
      return c.json({
        error: '학습자 평가를 완료하지 못했습니다. 잠시 후 같은 답변으로 다시 시도해 주세요.',
        code: 'EVALUATOR_UNAVAILABLE',
        phase: 'evaluate_student',
        retryable: routeFailure.retryable,
        failureClass: routeFailure.failureClass,
        assessmentState: 'UNGRADABLE',
        timestamp: new Date().toISOString(),
      }, 503);
    }

    // Keep structured AI failures private while returning an actionable retry state.
    if ((isPlainObject(error) && error.status === 400) || (error instanceof Error && error.name === 'AIResponseFormatError')) {
      console.error(`[CHAT] AIResponseFormatError reached handler (should not happen in Phase 2):`, error);
      return c.json({
        error: 'AI 평가 처리 중 일시적 오류가 발생했습니다. 다시 시도해 주세요.',
        code: 'AI_EVAL_ERROR',
        phase,
        timestamp: new Date().toISOString(),
      }, 400);
    }

    return c.json({
      error: '요청을 처리하지 못했습니다.',
      code: 'INTERNAL_ERROR',
      phase,
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

// GET /api/session/:id/deep-report - Polling endpoint for async deep analytics
chatRoute.get('/api/session/:id/deep-report', requireAuth, async (c) => {
  try {
    const sessionId = c.req.param('id');
    const db = c.env.DB;

    // Check ownership
    const session = await getSession(db, sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const requesterUserId = requesterId(c);
    if (!canAccessOwnerResource(session.userId, requesterUserId)) {
      return c.json({ error: '접근 권한이 없습니다.' }, 403);
    }

    // Fetch deep report
    const report = await getDeepReport(db, sessionId);

    if (!report) {
      return c.json({ status: 'not_found', message: '심층 분석 리포트가 없습니다.' });
    }

    if (report.status === 'processing') {
      return c.json({ status: 'processing', message: '심층 분석 리포트를 생성 중입니다... (최대 1~2분 소요)' });
    }

    if (report.status === 'failed') {
      return c.json({ status: 'failed', message: '심층 분석 생성에 실패했습니다.' });
    }

    // Return completed report
    return c.json({
      status: 'completed',
      argGraph: report.arg_graph_json ? JSON.parse(report.arg_graph_json) : null,
      microMetrics: report.micro_metrics ? JSON.parse(report.micro_metrics) : null,
      prescriptiveFeedback: report.prescriptive_feedback || '',
      growthTrajectory: report.growth_trajectory || '',
      strengths: report.strengths_json ? JSON.parse(report.strengths_json) : [],
      weaknesses: report.weaknesses_json ? JSON.parse(report.weaknesses_json) : [],
      completedAt: report.completed_at,
    });
  } catch (error: unknown) {
    console.error('[DEEP_REPORT] Error:', error);
    return c.json({ error: (error instanceof Error ? error.message : '') || 'Failed to get deep report' }, 500);
  }
});

// =============================================
// GET /api/session/:id/aif-graph - AIF 논증 그래프 조회
// Phase 3B: 프론트엔드 시각화 캔버스용 데이터
// =============================================
chatRoute.get('/api/session/:id/aif-graph', requireAuth, async (c) => {
  try {
    const sessionId = c.req.param('id');
    const db = c.env.DB;

    const session = await getSession(db, sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const requesterUserId = requesterId(c);
    if (!canAccessOwnerResource(session.userId, requesterUserId)) {
      return c.json({ error: '접근 권한이 없습니다.' }, 403);
    }

    // Fetch AIF nodes — v16 G-11 Fix: id 컬럼 추가 (edge mapping 파손 수정)
    const nodesResult = await db.prepare(
      `SELECT id, turn_number, node_type, content, confidence, metadata_json
       FROM argument_nodes WHERE session_id = ?1 ORDER BY turn_number, created_at`
    ).bind(sessionId).all<{ id: string; turn_number: number; node_type: string | null; content: string | null; confidence: number | null; metadata_json: string | null }>();

    // Fetch AIF edges
    const edgesResult = await db.prepare(
      `SELECT from_node_id, to_node_id, relation_type, weight
       FROM argument_edges WHERE session_id = ?1 ORDER BY created_at`
    ).bind(sessionId).all<{ from_node_id: string; to_node_id: string; relation_type: string | null; weight: number | null }>();

    // Build visualization-ready format
    // v12.2: ID 매핑으로 엣지 from/to를 합성 노드 ID와 일치시킴
    const idMap = new Map<string, string>();

    // v16 G-11 Fix: id를 확실히 매핑하여 edge 렌더링 파손 수정
    const nodes = (nodesResult.results || []).map((r, i) => {
      const originalId = String(r.id || `unknown_${i}`);
      const syntheticId = `n_${i}`;
      idMap.set(originalId, syntheticId);
      // AIF pipeline에서 저장 시 sessionId_nodeId 형태로 저장됨
      // edge의 from_node_id는 nodeId만 가지므로 둘 다 매핑
      if (originalId.includes('_')) {
        const shortId = originalId.split('_').slice(1).join('_');
        idMap.set(shortId, syntheticId);
      }
      const meta = (() => { try { return JSON.parse(r.metadata_json || '{}'); } catch (e) { console.error('[P1-004] obj:', e); return {}; } })();
      return {
        id: syntheticId,
        originalId,
        type: r.node_type?.replace('aif_', '') || 'claim',
        author: meta.author || 'student',
        text: r.content || '',
        turn: r.turn_number,
        strength: r.confidence || 0.5,
      };
    });

    const edges = (edgesResult.results || []).map((r, i) => ({
      id: `e_${i}`,
      from: idMap.get(r.from_node_id) || idMap.get(String(r.from_node_id)) || r.from_node_id || '',
      to: idMap.get(r.to_node_id) || idMap.get(String(r.to_node_id)) || r.to_node_id || '',
      relation: r.relation_type?.replace('aif_', '') || 'support',
      strength: r.weight || 0.5,
    }));

    // Grounded semantics via recursive CTE
    let groundedCount = 0;
    let defeatedCount = 0;
    try {
      const { queryGroundedNodes } = await import('../services/math/knowledge-graph');
      const grounded = await queryGroundedNodes(db, sessionId);
      groundedCount = grounded.groundedNodeIds.length;
      defeatedCount = grounded.defeatedNodeIds.length;
    } catch (e) { console.error("[P1-004] Caught:", e); }

    return c.json({
      sessionId,
      nodes,
      edges,
      metadata: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        groundedNodes: groundedCount,
        defeatedNodes: defeatedCount,
      },
    });
  } catch (error: unknown) {
    console.error('[AIF_GRAPH] Error:', error);
    return c.json({ error: (error instanceof Error ? error.message : '') || 'Failed to get AIF graph' }, 500);
  }
});

// Phase 3C: Generate context-aware CTA (Call-to-Action) suggestions
function generateCTASuggestions(evaluation: Pick<EvaluationResult, 'radarScores'>, research: Record<string, unknown> | null): string[] {
  const suggestions: string[] = [];

  // Based on evaluation weaknesses
  if (evaluation.radarScores?.evidence < 40) {
    suggestions.push('텍스트 구절을 직접 인용하여 뒷받침하겠습니다');
  }
  if (evaluation.radarScores?.defense < 40) {
    suggestions.push('반례를 고려하여 주장을 보완하겠습니다');
  }
  if (evaluation.radarScores?.consistency < 40) {
    suggestions.push('이전 주장과의 일관성을 설명하겠습니다');
  }

  // Based on researcher findings
  if (research?.claimVerified === false) {
    suggestions.push('다른 각도에서 접근해 보겠습니다');
  }
  if (Array.isArray(research?.suggestedAngles) && research.suggestedAngles.length > 0) {
    suggestions.push('추론 과정을 더 자세히 설명하겠습니다');
  }

  // Default if none
  if (suggestions.length === 0) {
    suggestions.push('다른 예시를 통해 접근하겠습니다');
    suggestions.push('이 전제를 반박해 보겠습니다');
  }

  return suggestions.slice(0, 3);
}

export default chatRoute;
