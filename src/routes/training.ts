import { loadOwnedFollowUpLaunch, prepareFollowUpBinding, readTrainingFollowUpLink } from '../services/growth-follow-up';
import { GrowthServiceError } from '../services/growth-cycle-types';
import { requestTrainingIntervention, loadTrainingInterventions, guardTrainingIntervention, TrainingInterventionError } from '../services/training/interventions';
import { generateBoundedSupport } from '../services/training/bounded-support';
import { Hono } from 'hono';
import { declareLearnerRevision, loadLearnerRevisions, LearnerRevisionError } from '../services/training/learner-revision';
import { loadOwnedTrainingEvidenceModels } from '../services/training/evidence-model';
import { readOwnedTrainingHistorySupplements } from '../services/training/history-supplements';
import { prepareTrainingRouteOffer, loadTrainingRoute, reviseTrainingRoute, isTrainingRoute, TrainingRouteError, type TrainingRouteProjection } from '../services/training/training-route';
import type { Bindings, CitationSource } from '../types';
import { AIRouteUnavailableError, createAIRouter, describeAIRouting, isAIInvocationReceiptPersistenceError, type AIFailureClass } from '../services/ai-router';
import { processStudentTurn, createStudentModel, serializeStudentModel, deserializeStudentModel } from '../services/tutoring/orchestrator';
import type { HintLadderLevel, StudentModel, TutorState } from '../services/tutoring/types';
import type { TrainingMessageRow, QuestionBankRow, TrainingEvaluation } from '../types/d1-rows';
import { requireAuth, requireRole, getAuthUser, canAccessOwnerResource } from '../middleware/auth';
import { handleCronQuestionGeneration } from '../workers/cron-question-generator';
import { buildEvidenceGroundedTrainingScenario, buildTrainingScenarioPersistenceStatements, loadTrainingCaseContractProjection, loadTrainingScenarioEvidenceContext, type ReadyEvidenceGroundedScenario, type TrainingScenarioDifficulty } from '../services/training/scenario-evidence';
import { buildTrainingCaseEvaluationReference, buildTrainingCasePromptBinding, projectTrainingCaseContract, resolveTrainingCase, type TrainingCaseEvaluationReference } from '../services/training/case-contracts/haneul-harbor-investment';
import { getPublicTrainingCaseEntries, getPublicTrainingCaseEntry } from '../services/training/case-catalog';
import constructedScenarioSystemPrompt from '../services/training/prompts/constructed-scenario.system.md?raw';
import constructedScenarioUserPrompt from '../services/training/prompts/constructed-scenario.user.md?raw';
import constructedHintUserPrompt from '../services/training/prompts/constructed-hint.user.md?raw';
import { loadLearnerSourceAttributions, prepareLearnerSourceAttribution } from '../services/source-attribution';
import { pinAIRoutePlan } from '../services/learning-session-context';
import {
  loadOwnedTrainingSessionContext,
  prepareTrainingSessionContext,
  TrainingSessionContextError,
} from '../services/training/training-session-context';
import {
  armHeldOutAttempt,
  HeldOutDeliveryError,
  openHeldOutAttempt,
  quarantineHeldOutAssistanceReference,
  readOperatorHeldOutAttempt,
  readOwnedHeldOutAttempt,
  reportHeldOutContamination,
  stopHeldOutAttempt,
  submitHeldOutAttempt,
} from '../services/training/heldout-delivery';
import { deleteOwnedTrainingSession, TrainingDeletionError } from '../services/training/governed-deletion';

const trainingRoute = new Hono<{ Bindings: Bindings }>();
trainingRoute.use('/api/training/*', requireAuth);

const EVALUATOR_UNAVAILABLE_RESPONSE = Object.freeze({
  error: '학습자 평가를 완료하지 못했습니다. 잠시 후 같은 답변으로 다시 시도해 주세요.',
  code: 'EVALUATOR_UNAVAILABLE',
  phase: 'evaluate_student',
  retryable: true,
  assessmentState: 'UNGRADABLE',
});

type TrainingNormalizedEvaluation = {
  claimClarity: number;
  evidenceUse: number;
  reasoningStrength: number;
  consistency: number;
  relevance: number;
  weaknessTags: string[];
  diagnosis: string;
  caseEvaluation?: TrainingCaseEvaluationReference;
};

type TrainingSessionListRow = Record<string, unknown> & {
  id: string;
  created_at: number;
};

export type TrainingMode = 'evidence' | 'constructed';
type PersistedTrainingMode = 'scenario' | 'discussion';
export type TrainingStartRequest = { category: string; difficulty: TrainingScenarioDifficulty; mode: TrainingMode; evidenceQuery: string; evidenceBookIds: string[]; caseId?: string; constructedFocus?: string; maxTurns?: number; learningRouteVersion?: 1; growthFollowUpLaunchId?: string };

const MIN_TRAINING_TURNS = 1;
const MAX_TRAINING_TURNS = 10;
const TRAINING_EVIDENCE_POLICY_REVISION = 'critical-path-b-v1';

export class TrainingOperationError extends Error {
  constructor(public readonly status: number, public readonly body: Record<string, unknown>) { super(typeof body.error === 'string' ? body.error : 'training_operation_failed'); }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function readString(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function readStringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : []; }
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function heldOutMutationInput(value: unknown): { expectedRevision: number; mutationKey: string } | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['expectedRevision', 'mutationKey']) || !Number.isInteger(value.expectedRevision) || typeof value.mutationKey !== 'string') return null;
  return { expectedRevision: value.expectedRevision as number, mutationKey: value.mutationKey };
}
async function rejectHeldOutAssistanceReference(db: D1Database, ownerUserId: string, attemptId: string): Promise<void> {
  if (await quarantineHeldOutAssistanceReference(db, ownerUserId, attemptId)) {
    throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_ASSISTANCE_FORBIDDEN');
  }
}
function generateId(prefix = 'trn_'): string { return `${prefix}${crypto.randomUUID()}`; }
function hasTutorProvider(env: Bindings): boolean {
  const routing = describeAIRouting(env);
  return routing.interactiveGeneration.status === 'configured_unverified'
    && routing.learnerEvaluation.status === 'configured_unverified'
    && routing.releaseCritic.status === 'configured_unverified';
}
function hasGenerationProvider(env: Bindings): boolean {
  return describeAIRouting(env).backgroundReasoning.status === 'configured_unverified';
}

function toPersistedTrainingMode(mode: TrainingMode): PersistedTrainingMode { return mode === 'evidence' ? 'scenario' : 'discussion'; }
export function toPublicTrainingMode(value: unknown): TrainingMode { return value === 'scenario' ? 'evidence' : 'constructed'; }
function defaultTrainingMaxTurns(mode: TrainingMode): number { return mode === 'constructed' ? 6 : 8; }
function isValidTrainingMaxTurns(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_TRAINING_TURNS
    && value <= MAX_TRAINING_TURNS;
}

function parseTrainingStartRequest(value: unknown): TrainingStartRequest | null {
  if (!isRecord(value)) return null;
  const category = readString(value.category);
  const difficulty = readString(value.difficulty) as TrainingScenarioDifficulty;
  const mode = value.mode === undefined ? 'evidence' : value.mode;
  const maxTurns = value.maxTurns;
  const caseId = readString(value.caseId);
  if (value.growthFollowUpLaunchId !== undefined && (typeof value.growthFollowUpLaunchId !== 'string' || !value.growthFollowUpLaunchId.trim() || value.growthFollowUpLaunchId.length>256)) return null;
  if (value.learningRouteVersion !== undefined && value.learningRouteVersion !== 1) return null;
  if (value.learningRouteVersion === 1 && mode !== 'evidence' && !caseId) return null;
  if (value.caseId !== undefined && (!caseId || caseId.length > 120)) return null;
  if (!category || !['beginner', 'intermediate', 'advanced'].includes(difficulty) || (mode !== 'evidence' && mode !== 'constructed') || (maxTurns !== undefined && !isValidTrainingMaxTurns(maxTurns))) return null;
  return { category, difficulty, mode, evidenceQuery: readString(value.evidenceQuery), evidenceBookIds: readStringArray(value.evidenceBookIds), caseId: caseId || undefined, constructedFocus: readString(value.constructedFocus), maxTurns, learningRouteVersion: value.learningRouteVersion === 1 ? 1 : undefined, growthFollowUpLaunchId: readString(value.growthFollowUpLaunchId) || undefined };
}

type ConstructedQuestion = { title: string; context: string; question: string; expected_tensions: string[]; sessionGoal: string };
function parseConstructedQuestion(value: unknown): ConstructedQuestion | null {
  if (!isRecord(value)) return null;
  const title = readString(value.title); const context = readString(value.context); const question = readString(value.question);
  const expectedTensions = readStringArray(value.expected_tensions); const sessionGoal = readString(value.sessionGoal);
  return title && context && question && expectedTensions.length >= 2 && sessionGoal ? { title, context, question, expected_tensions: expectedTensions, sessionGoal } : null;
}

type TrainingHintPayload = { hint: string };
function parseTrainingHint(value: unknown): TrainingHintPayload | null {
  if (!isRecord(value)) return null;
  const hint = readString(value.hint);
  return hint ? { hint } : null;
}

async function buildConstructedQuestion(env: Bindings, request: TrainingStartRequest): Promise<ConstructedQuestion> {
  if (!hasGenerationProvider(env)) throw new TrainingOperationError(503, { error: 'training_generation_provider_not_configured' });
  const userPrompt = constructedScenarioUserPrompt.replace('{{category}}', request.category).replace('{{difficulty}}', request.difficulty).replace('{{focus}}', request.constructedFocus || 'none');
  try {
    const generated = await createAIRouter(env).completeValidatedJSON('background_reasoning', {
      systemPrompt: constructedScenarioSystemPrompt,
      userPrompt,
      temperature: 0.7,
      maxTokens: 1_200,
      promptSchemaVersion: 'training-constructed-scenario-schema-v1',
      promptVersion: 'training-constructed-scenario-v1',
    }, parseConstructedQuestion);
    return generated.value;
  } catch (error) {
    console.error('Constructed scenario generation failed:', error);
    if (error instanceof AIRouteUnavailableError) {
      throw new TrainingOperationError(503, {
        error: 'constructed_scenario_generation_failed',
        code: 'TRAINING_GENERATION_UNAVAILABLE',
        phase: 'construct_scenario',
        retryable: error.retryable,
        failureClass: error.failureClass,
        assessmentState: 'UNGRADABLE',
      });
    }
    throw new TrainingOperationError(502, { error: 'constructed_scenario_generation_failed' });
  }
}

async function assertCategory(db: D1Database, category: string): Promise<{ id: string; nameKo: string }> {
  try {
    const row = await db.prepare(
      'SELECT * FROM category_hierarchy WHERE id = ?1 AND is_active = 1 LIMIT 1'
    ).bind(category).first<{ id: string; name_ko?: string }>();
    if (!row) throw new TrainingOperationError(400, { error: 'training_category_invalid' });
    return { id: row.id, nameKo: readString(row.name_ko) || row.id };
  } catch (error) {
    if (error instanceof TrainingOperationError) throw error;
    console.error('Training category validation failed:', error);
    throw new TrainingOperationError(503, { error: 'training_category_catalog_unavailable' });
  }
}

function evidenceGrounding(evidence: ReadyEvidenceGroundedScenario) {
  return { status: 'ready', manifestSha256: evidence.evidencePack.manifestSha256, sourceCount: evidence.evidencePack.sourceCount, bookCount: evidence.evidencePack.bookCount, sources: evidence.evidencePack.sources.map((source) => ({ sourceId: source.sourceId, passage: source.excerpt, bookId: source.bookId, bookTitle: source.bookTitle, bookAuthor: source.bookAuthor, chunkIndex: source.chunkIndex, charStart: source.charStart, charEnd: source.charEnd, contentSha256: source.contentSha256, relevanceScore: source.relevanceScore, lifecycleStatus: source.lifecycleStatus })) };
}
function persistedEvidenceGrounding(grounding: Awaited<ReturnType<typeof requireTrainingEvidenceGrounding>>) {
  return { status: 'ready', manifestSha256: grounding.manifestSha256, sourceCount: grounding.sources.length, sources: grounding.sources.map((source) => ({ sourceId: source.sourceId, passage: source.excerpt, bookId: source.bookId, bookTitle: source.bookTitle, bookAuthor: source.bookAuthor, chunkIndex: source.chunkIndex, charStart: source.charStart, charEnd: source.charEnd, contentSha256: source.contentSha256, relevanceScore: source.relevanceScore, lifecycleStatus: source.lifecycleStatus })) };
}

export async function startTrainingSession(env: Bindings, userId: string, request: TrainingStartRequest, options: { sessionId?: string; maxTurns?: number } = {}) {
  const selectedCase = resolveTrainingCase(request.caseId);
  if (request.caseId && !selectedCase) {
    throw new TrainingOperationError(404, { code: 'TRAINING_CASE_NOT_FOUND', error: '요청한 훈련 사례를 찾을 수 없습니다.' });
  }
  const selectedCaseEntry = selectedCase ? getPublicTrainingCaseEntry(selectedCase.id) : null;
  if (selectedCase && !selectedCaseEntry) {
    throw new TrainingOperationError(503, { code: 'TRAINING_CASE_CATALOG_UNAVAILABLE', error: '훈련 사례 카탈로그를 확인하지 못했습니다.' });
  }
  const effectiveRequest: TrainingStartRequest = selectedCaseEntry
    ? {
        ...request,
        category: selectedCaseEntry.category,
        difficulty: selectedCaseEntry.difficulty,
        mode: selectedCaseEntry.mode,
        maxTurns: selectedCaseEntry.defaultMaxTurns,
      }
    : request;
  if (selectedCase && request.growthFollowUpLaunchId) {
    throw new TrainingOperationError(400, { code: 'TRAINING_CASE_FOLLOW_UP_UNSUPPORTED', error: '선택한 훈련 사례는 성장 후속 세션을 지원하지 않습니다.' });
  }
  if (effectiveRequest.learningRouteVersion === 1 && effectiveRequest.mode !== 'evidence') throw new TrainingRouteError(400, 'TRAINING_ROUTE_NOT_ENABLED');
  const followUp = request.growthFollowUpLaunchId ? await loadOwnedFollowUpLaunch(env.DB,userId,request.growthFollowUpLaunchId) : null;
  if(followUp && effectiveRequest.mode!=='evidence') throw new GrowthServiceError({status:400,code:'GROWTH_FOLLOW_UP_EVIDENCE_REQUIRED',phase:'validation'});
  if(followUp?.session_id) throw new GrowthServiceError({status:409,code:'GROWTH_FOLLOW_UP_ALREADY_STARTED',phase:'conflict',details:{sessionId:followUp.session_id}});
  const category = await assertCategory(env.DB, effectiveRequest.category);
  if (!hasTutorProvider(env)) throw new TrainingOperationError(503, { error: 'training_tutor_provider_not_configured' });
  const sessionId = options.sessionId || generateId();
  const now = Date.now();
  let evidence: ReadyEvidenceGroundedScenario | null = null;
  let question: ConstructedQuestion;
  if (effectiveRequest.mode === 'evidence') {
    try {
      const build = await buildEvidenceGroundedTrainingScenario(env, env.DB, {
        category: effectiveRequest.category,
        categoryLabel: category.nameKo,
        difficulty: effectiveRequest.difficulty,
        evidenceQuery: selectedCase?.evidenceQuery ?? effectiveRequest.evidenceQuery,
        evidenceBookIds: selectedCase ? [...selectedCase.evidenceBookIds] : effectiveRequest.evidenceBookIds,
        ownerUserId: userId,
        ...(selectedCase ? { caseDefinition: selectedCase } : {}),
        ...(followUp ? {followUpVariant:{launchId:followUp.id,changedCondition:followUp.changed_condition,semanticValidation:'UNKNOWN' as const}} : {}),
      });
      if (build.status !== 'ready') throw new TrainingOperationError(422, { error: 'scenario_evidence_insufficient', reason: build.evidencePack.reason, availableBookCount: build.evidencePack.availableBookCount, relevantSourceCount: build.evidencePack.relevantSourceCount });
      evidence = build;
      question = { title: readString(build.question.title) || effectiveRequest.category, context: readString(build.question.context), question: readString(build.question.question), expected_tensions: readStringArray(build.question.expected_tensions), sessionGoal: readString(build.question.sessionGoal) || '핵심 주장을 논리적으로 구성하기' };
    } catch (error) {
      if (error instanceof TrainingOperationError) throw error;
      console.error('Evidence-grounded scenario generation failed:', error);
      throw new TrainingOperationError(502, { error: 'scenario_generation_failed' });
    }
  } else question = await buildConstructedQuestion(env, effectiveRequest);
  if (!question.question) throw new TrainingOperationError(502, { error: 'training_question_contract_failed' });
  const maxTurns = effectiveRequest.maxTurns ?? options.maxTurns ?? defaultTrainingMaxTurns(effectiveRequest.mode);
  if (!isValidTrainingMaxTurns(maxTurns)) {
    throw new TrainingOperationError(400, { error: `maxTurns must be an integer between ${MIN_TRAINING_TURNS} and ${MAX_TRAINING_TURNS}` });
  }
  const routeOffer = effectiveRequest.learningRouteVersion === 1 && evidence ? prepareTrainingRouteOffer(env.DB, sessionId, userId, evidence) : null;
  const model = createStudentModel(sessionId, question.title, question.sessionGoal);
  const sessionInsert = env.DB.prepare(`INSERT INTO training_sessions (id, user_id, category, difficulty, question, question_title, context, expected_tensions, session_goal, tutor_state, student_model, current_turn, max_turns, training_mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)`).bind(sessionId, userId, effectiveRequest.category, effectiveRequest.difficulty, question.question, question.title, question.context, JSON.stringify(question.expected_tensions), question.sessionGoal, 'elicitation', serializeStudentModel(model), 1, maxTurns, toPersistedTrainingMode(effectiveRequest.mode), now);
  try {
    if (evidence) {
      const preparedContext = prepareTrainingSessionContext(env.DB, {
        sessionId,
        ownerUserId: userId,
        evidenceManifestSha256: evidence.evidencePack.manifestSha256,
        routes: pinAIRoutePlan(env),
        promptCacheNamespace: `training:${sessionId}`,
        evidencePolicyRevision: TRAINING_EVIDENCE_POLICY_REVISION,
        createdAt: now,
      });
      await env.DB.batch([
        sessionInsert,
        ...(routeOffer ? [env.DB.prepare('UPDATE training_sessions SET learning_route_version = 1 WHERE id = ?1 AND user_id = ?2').bind(sessionId, userId)] : []),
        ...buildTrainingScenarioPersistenceStatements(env.DB, sessionId, evidence, now),
        preparedContext.statement,
        ...(followUp ? [prepareFollowUpBinding(env.DB,followUp.id,sessionId,preparedContext.context.id,now)] : []),
        ...(routeOffer ? [routeOffer.statement] : []),
      ]);
    } else {
      await env.DB.batch([sessionInsert]);
    }
  } catch (error) {
    if (error instanceof TrainingOperationError) throw error;
    if(String(error).includes('TRAINING_SOURCE_UNAVAILABLE'))throw trainingSourceUnavailable();
    throw new TrainingOperationError(503, {
      error: '훈련 근거와 실행 컨텍스트를 안전하게 저장하지 못했습니다. 다시 시도해 주세요.',
      code: 'TRAINING_CONTEXT_PERSISTENCE_FAILED',
      assessmentState: 'UNGRADABLE',
      retryable: true,
    });
  }
  const learningRoute: TrainingRouteProjection = routeOffer ? { status: 'AWAITING_CHOICE', offer: routeOffer.offer, decision: null } : { status: 'UNKNOWN', offer: null, decision: null };
  return { growthFollowUp: followUp ? await readTrainingFollowUpLink(env.DB,userId,sessionId) : null, learningRoute, caseContract: selectedCase ? projectTrainingCaseContract(selectedCase) : null, caseContractStatus: selectedCase ? 'ready' : 'not_applicable', sessionId, question: question.question, title: question.title, context: question.context, category: effectiveRequest.category, difficulty: effectiveRequest.difficulty, maxTurns, sessionGoal: question.sessionGoal, expectedTensions: question.expected_tensions, mode: effectiveRequest.mode, avgScore: null, rating: 'UNKNOWN', evaluationStatus: 'UNKNOWN', grounding: evidence ? evidenceGrounding(evidence) : { status: 'not_applicable', reason: 'constructed_scenario' } };
}

const ROUTE_FAILURE_CLASSES = [
  'unconfigured', 'unauthorized', 'not_found', 'rate_limited', 'bad_request',
  'timeout', 'network', 'provider_unavailable', 'invalid_response', 'unknown',
] as const;

function routeFailureMetadata(error: unknown): { failureClass: AIFailureClass; retryable: boolean } {
  if (error instanceof AIRouteUnavailableError) {
    return { failureClass: error.failureClass, retryable: error.retryable };
  }
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { failureClass?: unknown; retryable?: unknown };
    if (typeof candidate.failureClass === 'string'
      && (ROUTE_FAILURE_CLASSES as readonly string[]).includes(candidate.failureClass)) {
      return { failureClass: candidate.failureClass as AIFailureClass, retryable: candidate.retryable === true };
    }
  }
  return { failureClass: 'invalid_response', retryable: true };
}

function isCriticUnavailable(error: unknown): boolean { return error instanceof Error && error.name === 'CriticUnavailableError'; }
function criticUnavailableError(error?: unknown) {
  const routeFailure = routeFailureMetadata(error);
  return new TrainingOperationError(503, {
    error: '튜터 응답 검수를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    code: 'CRITIC_UNAVAILABLE',
    phase: 'training',
    retryable: routeFailure.retryable,
    failureClass: routeFailure.failureClass,
    assessmentState: 'UNGRADABLE',
    timestamp: new Date().toISOString(),
  });
}
function isEvaluatorUnavailable(error: unknown): boolean { return error instanceof Error && error.name === 'EvaluatorUnavailableError'; }
function evaluatorUnavailableError(error?: unknown) {
  const routeFailure = routeFailureMetadata(error);
  return new TrainingOperationError(503, {
    ...EVALUATOR_UNAVAILABLE_RESPONSE,
    retryable: routeFailure.retryable,
    failureClass: routeFailure.failureClass,
    timestamp: new Date().toISOString(),
  });
}
function isTutorGenerationUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === 'TutorGenerationUnavailableError';
}
function tutorGenerationUnavailableError(error: unknown) {
  const routeFailure = routeFailureMetadata(error);
  return new TrainingOperationError(503, {
    error: '훈련 응답을 생성하지 못했습니다. 잠시 후 같은 입력으로 다시 시도해 주세요.',
    code: 'TUTOR_GENERATION_FAILED',
    phase: 'training_generation',
    retryable: routeFailure.retryable,
    failureClass: routeFailure.failureClass,
    assessmentState: 'UNGRADABLE',
    timestamp: new Date().toISOString(),
  });
}
// Saved history and learner controls do not require generation-ready sources.
// Only known evidence states become an unavailable projection; storage failures still propagate.
export async function readTrainingHistoryGrounding(db: D1Database, sessionId: string, mode: TrainingMode) {
  if (mode === 'constructed') return { status: 'not_applicable', reason: 'constructed_scenario' };
  const grounding = await loadTrainingScenarioEvidenceContext(db, sessionId);
  return grounding.status === 'ready' ? persistedEvidenceGrounding(grounding)
    : { status: 'unavailable', reason: grounding.status === 'broken' ? grounding.reason : 'evidence_snapshot_missing' };
}

function trainingSourceUnavailable() {
 return new TrainingOperationError(409,{error:'훈련 자료 중 현재 사용할 수 없는 근거가 있습니다. 저장된 기록은 유지되며, 사용 가능한 자료로 새 훈련을 시작할 수 있습니다.',code:'TRAINING_SOURCE_UNAVAILABLE',retryable:false});
}

export async function requireTrainingEvidenceGrounding(env: Bindings, sessionId: string) {
  const grounding = await loadTrainingScenarioEvidenceContext(env.DB, sessionId);
  if (grounding.status !== 'ready') throw new TrainingOperationError(409, { error: 'scenario_grounding_broken', reason: grounding.status === 'broken' ? grounding.reason : 'evidence_snapshot_missing' });
  // History uses the loader above directly. Generation must also establish
  // current access to every source in the pinned pack; never silently trim it.
  const eligible=await env.DB.prepare(`SELECT s.id FROM training_sessions s
    WHERE s.id=?1 AND s.training_mode='scenario'
     AND EXISTS(SELECT 1 FROM training_scenario_evidence WHERE session_id=s.id)
     AND NOT EXISTS(SELECT 1 FROM training_scenario_evidence e WHERE e.session_id=s.id AND NOT EXISTS(
       SELECT 1 FROM books b WHERE b.id=e.book_id AND b.lifecycle_status='active'
        AND ((b.is_builtin=1 AND b.visibility='builtin') OR (b.visibility='private' AND b.owner_user_id=s.user_id))
     ))`).bind(sessionId).first<{id:string}>();
  if(!eligible)throw trainingSourceUnavailable();
  return grounding;
}

export async function provideTrainingSupport(env: Bindings, owner:string, sessionId:string) {
 const control=await loadTrainingInterventions(env.DB,owner,sessionId);
 if(control.latest?.action==='HELP' && control.latest.response) return {response:control.latest.response,interventionId:control.latest.id,graded:false};
 if(control.state!=='SUPPORT_PENDING' || !control.latest?.prior_turn_id) throw new TrainingInterventionError(409,'TRAINING_SUPPORT_NOT_PENDING');
 const grounding=await requireTrainingEvidenceGrounding(env,sessionId);
 const context=await loadOwnedTrainingSessionContext(env.DB,sessionId,owner);
 if(context.evidenceManifestSha256!==grounding.manifestSha256) throw new TrainingInterventionError(503,'TRAINING_SUPPORT_EVIDENCE_CHANGED');
 const session=await env.DB.prepare('SELECT current_turn,category FROM training_sessions WHERE id=?1 AND user_id=?2').bind(sessionId,owner).first<{current_turn:number;category:string}>();
 const prior=await env.DB.prepare('SELECT student_message,diagnosis,tutor_state FROM training_turns WHERE id=?1 AND session_id=?2').bind(control.latest.prior_turn_id,sessionId).first<{student_message:string;diagnosis:string;tutor_state:string}>();
 if(!session || !prior) throw new TrainingInterventionError(409,'TRAINING_SUPPORT_DIAGNOSIS_REQUIRED');
 const router=createAIRouter(env,{mode:'context_bound',pinnedRoutePlan:context.routes,invocationScope:{sessionContextId:context.id,sessionId,turnNumber:session.current_turn,promptCacheNamespace:context.promptCacheNamespace}});
 const supported=await generateBoundedSupport(router,{studentMessage:prior.student_message,diagnosis:prior.diagnosis,currentState:prior.tutor_state,topic:session.category,sources:grounding.sources.map(source=>({sourceId:source.sourceId,excerpt:source.excerpt}))});
 try {
  await env.DB.prepare("INSERT INTO training_support_responses (intervention_id,session_id,response,source_ids_json,diagnosis_snapshot,routing_json,policy_revision,created_at) VALUES (?1,?2,?3,?4,?5,?6,'bounded-support-v1',?7)")
  .bind(control.latest.id,sessionId,supported.finalResponse,JSON.stringify([...new Set([...supported.finalResponse.matchAll(/\[SOURCE_ID=([^\]]+)\]/g)].map(match=>match[1]))]),prior.diagnosis,JSON.stringify({actor:supported.actorRoute,critic:supported.criticRoute,verdict:supported.criticVerdict}),Date.now()).run();
 } catch(error) {
  if(/TRAINING_INTERVENTION_CONFLICT|UNIQUE constraint/.test(String(error))) {
   const now=await loadTrainingInterventions(env.DB,owner,sessionId);
   if(now.latest?.id===control.latest.id && now.latest.response) return {response:now.latest.response,interventionId:now.latest.id,graded:false};
  }
  throw error;
 }
 return {response:supported.finalResponse,interventionId:control.latest.id,graded:false};
}

export async function respondTrainingSession(env: Bindings, userId: string, sessionId: string, message: string, executionCtx?: ExecutionContext) {
  if (!sessionId || !message.trim()) throw new TrainingOperationError(400, { error: 'sessionId and message are required' });
  const session = await env.DB.prepare('SELECT * FROM training_sessions WHERE id = ?1').bind(sessionId).first<Record<string, unknown>>();
  if (!session) throw new TrainingOperationError(404, { error: 'Training session not found' });
  if (!canAccessOwnerResource((session.user_id as string | null) || null, userId)) throw new TrainingOperationError(403, { error: '접근 권한이 없습니다.' });
  if (session.is_completed) throw new TrainingOperationError(400, { error: 'Session already completed' });
  const mode = toPublicTrainingMode(session.training_mode);
  const caseReadback = mode === 'evidence'
    ? await loadTrainingCaseContractProjection(env.DB, sessionId)
    : { status: 'not_applicable' as const, caseContract: null };
  if (caseReadback.status === 'broken') {
    throw new TrainingOperationError(409, {
      code: 'TRAINING_CASE_SNAPSHOT_INVALID',
      error: '훈련 사례 스냅샷을 검증하지 못했습니다.',
      assessmentState: 'UNGRADABLE',
      caseContractStatus: 'broken',
    });
  }
  const caseDefinition = caseReadback.status === 'ready'
    ? resolveTrainingCase(caseReadback.caseContract.caseId)
    : null;
  if (caseReadback.status === 'ready' && !caseDefinition) {
    throw new TrainingOperationError(409, {
      code: 'TRAINING_CASE_SNAPSHOT_INVALID',
      error: '훈련 사례 스냅샷을 검증하지 못했습니다.',
      assessmentState: 'UNGRADABLE',
      caseContractStatus: 'broken',
    });
  }
  const intervention = await guardTrainingIntervention(env.DB,userId,sessionId);
  const grounding = mode === 'evidence' ? await requireTrainingEvidenceGrounding(env, sessionId) : null;
  const casePromptBinding = caseDefinition && grounding?.status === 'ready'
    ? buildTrainingCasePromptBinding(caseDefinition, grounding.sources.map((source) => source.sourceId))
    : null;
  let trainingContext = null;
  if (mode === 'evidence') {
    try {
      trainingContext = await loadOwnedTrainingSessionContext(env.DB, sessionId, userId);
    } catch (error) {
      const contextCode = error instanceof TrainingSessionContextError ? error.code : 'CONTEXT_UNAVAILABLE';
      throw new TrainingOperationError(503, {
        error: '훈련 실행 컨텍스트를 확인하지 못해 답변을 안전하게 평가할 수 없습니다.',
        code: 'TRAINING_CONTEXT_UNAVAILABLE',
        contextError: contextCode,
        assessmentState: 'UNGRADABLE',
        retryable: contextCode === 'CONTEXT_UNAVAILABLE',
      });
    }
  }
  const learningRoute = session.learning_route_version === 1 ? await loadTrainingRoute(env.DB, userId, sessionId) : null;
  if (learningRoute && !learningRoute.decision) throw new TrainingRouteError(409, 'TRAINING_ROUTE_CHOICE_REQUIRED');
  if (learningRoute?.offer?.manifestSha256 && learningRoute.offer.manifestSha256 !== grounding?.manifestSha256) throw new TrainingRouteError(503, 'TRAINING_ROUTE_EVIDENCE_CHANGED');
  const learnerRevisions = mode === 'evidence' ? await loadLearnerRevisions(env.DB, userId, sessionId) : null;
  if (learnerRevisions?.pending && learnerRevisions.pending.manifestSha256 !== grounding?.manifestSha256) throw new LearnerRevisionError(503, 'TRAINING_REVISION_EVIDENCE_CHANGED');
  if (!hasTutorProvider(env)) throw new TrainingOperationError(503, { error: 'training_tutor_provider_not_configured', assessmentState: 'UNGRADABLE' });
  const messages = await env.DB.prepare('SELECT role, content FROM training_messages WHERE session_id = ?1 ORDER BY timestamp ASC').bind(sessionId).all<TrainingMessageRow>();
  const history = (messages.results || []).map((item) => ({ role: item.role === 'user' ? 'user' as const : 'assistant' as const, content: item.content }));
  const turnNumber = Number(session.current_turn || 1); const maxTurns = Number(session.max_turns || 8);
  const bookText = grounding?.status === 'ready' ? grounding.context : `This is a fictional constructed scenario. Do not cite sources or present real-world facts.\nQuestion: ${String(session.question)}\nContext: ${String(session.context || '')}`;
  let result;
  const attributionSources = grounding?.status === 'ready' ? grounding.sources.map((source) => ({
    sourceId: source.sourceId, passage: source.excerpt, bookId: source.bookId,
    bookTitle: source.bookTitle || null, bookAuthor: source.bookAuthor || null,
    chunkIndex: source.chunkIndex, charStart: source.charStart, charEnd: source.charEnd,
    contentSha256: source.contentSha256, relevanceScore: source.relevanceScore,
    lifecycleStatus: source.lifecycleStatus,
  })) : [];
  const router = trainingContext
    ? createAIRouter(env, {
        mode: 'context_bound',
        pinnedRoutePlan: trainingContext.routes,
        invocationScope: {
          sessionContextId: trainingContext.id,
          sessionId,
          turnNumber,
          promptCacheNamespace: trainingContext.promptCacheNamespace,
        },
      })
    : createAIRouter(env);
  try { result = await processStudentTurn({ router, sessionId, currentState: (session.tutor_state as TutorState) || 'elicitation', studentModel: deserializeStudentModel((session.student_model as string) || '{}'), studentMessage: message, bookText, conversationHistory: history, turnNumber, maxTurns, db: env.DB, userId, learningRoute: learningRoute?.decision, learnerRevision: learnerRevisions?.pending, revisionAttemptScope: 'TRAINING', evidenceSourceIds: attributionSources.map((source) => source.sourceId), caseDirective: casePromptBinding?.directive, casePromptVersion: casePromptBinding?.casePromptVersion, argumentGraphScope: 'training' }); }
  catch (error) {
    if (isAIInvocationReceiptPersistenceError(error)) {
      throw new TrainingOperationError(503, {
        error: '훈련 실행 기록을 안전하게 저장하지 못해 이번 답변을 평가할 수 없습니다.',
        code: 'TRAINING_RECEIPT_PERSISTENCE_FAILED',
        assessmentState: 'UNGRADABLE',
        retryable: true,
      });
    }
    if (isCriticUnavailable(error)) throw criticUnavailableError(error);
    if (isEvaluatorUnavailable(error)) throw evaluatorUnavailableError(error);
    throw error;
  }
  const now = Date.now(); const isSessionEnd = result.state === 'completed' || turnNumber >= maxTurns;
  const evaluation = result.evaluation as TrainingEvaluation;
  const averageScore = Math.round((evaluation.claim_clarity + evaluation.evidence_use + evaluation.reasoning_strength + evaluation.consistency + evaluation.relevance) * 4);
  const normalized: TrainingNormalizedEvaluation = { claimClarity: evaluation.claim_clarity, evidenceUse: evaluation.evidence_use, reasoningStrength: evaluation.reasoning_strength, consistency: evaluation.consistency, relevance: evaluation.relevance, weaknessTags: evaluation.weakness_tags || [], diagnosis: evaluation.diagnosis || '', ...(caseDefinition ? { caseEvaluation: buildTrainingCaseEvaluationReference(caseDefinition) } : {}) };
  const citations: CitationSource[] = [];
  const preparedAttribution = prepareLearnerSourceAttribution(env.DB, {
    userId,
    sessionKind: 'training',
    sessionId,
    turnNumber,
    claim: message,
    manifestSha256: grounding?.status === 'ready' ? grounding.manifestSha256 : 'training_manifest_unavailable',
    sources: attributionSources,
    evaluatorSourceIds: evaluation.evidence_source_ids,
    evaluatorFallback: evaluation.evidence_source_ids === undefined,
  });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO training_messages (session_id, role, content, turn, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)').bind(sessionId, 'user', message, turnNumber, now),
    env.DB.prepare('INSERT INTO training_messages (session_id, role, content, turn, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)').bind(sessionId, 'ai', result.tutorResponse, turnNumber, now),
    env.DB.prepare('INSERT INTO training_turns (session_id, turn_number, student_message, ai_response, claim_clarity, evidence_use, reasoning_strength, consistency_score, relevance_score, tutor_action_type, hint_level, weakness_tags, diagnosis, student_model_snapshot, tutor_state, evaluation_json, citation_sources, created_at, learning_route_decision_id, learning_route_revision, learner_revision_event_id, learner_revision_number, intervention_revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)').bind(sessionId, turnNumber, message, result.tutorResponse, evaluation.claim_clarity, evaluation.evidence_use, evaluation.reasoning_strength, evaluation.consistency, evaluation.relevance, result.action, result.hintLevel, JSON.stringify(evaluation.weakness_tags || []), evaluation.diagnosis, serializeStudentModel(result.studentModel as StudentModel), result.state, JSON.stringify(normalized), JSON.stringify(citations), now, learningRoute?.decision?.id ?? null, learningRoute?.decision?.revision ?? null, learnerRevisions?.pending?.id ?? null, learnerRevisions?.pending?.revision ?? null, intervention.revision),
    env.DB.prepare('UPDATE training_sessions SET current_turn = ?2, tutor_state = ?3, student_model = ?4, deep_hint_level = ?5, avg_score = ?6, rating = ?7, updated_at = ?8, is_completed = ?9, completed_at = ?10 WHERE id = ?1').bind(sessionId, turnNumber + 1, result.state, serializeStudentModel(result.studentModel as StudentModel), result.hintLevel, averageScore, getRating(averageScore), now, isSessionEnd ? 1 : 0, isSessionEnd ? now : null),
    ...preparedAttribution.statements,
  ]);
  const attribution = preparedAttribution.attribution;
  const acceptedSideEffects = (async () => {
    try {
      await result.runAcceptedSideEffects();
    } catch (error) {
      console.error('[TRAINING_ACCEPTED_SIDE_EFFECTS] Non-critical:', error);
    }
    await runAcceptedLearningIntegrations(env, userId, sessionId, session, message, result.tutorResponse, turnNumber, averageScore, result.action, evaluation);
  })();
  if (executionCtx?.waitUntil) {
    try {
      executionCtx.waitUntil(acceptedSideEffects);
    } catch (error) {
      console.error('[TRAINING_SIDE_EFFECT_DISPATCH] Non-critical:', error);
      void acceptedSideEffects;
    }
  } else await acceptedSideEffects;
  const responseGrounding = mode === 'constructed' ? { status: 'not_applicable', reason: 'constructed_scenario' } : grounding?.status === 'ready' ? persistedEvidenceGrounding(grounding) : { status: 'unavailable' };
  return { learnerRevisionApplied: learnerRevisions?.pending ? { id: learnerRevisions.pending.id, revision: learnerRevisions.pending.revision, reason: 'LEARNER_REQUESTED_CAUSAL_REVIEW', validationStatus: 'UNVERIFIED' } : null, learningRoute, aiReply: result.tutorResponse, aiRouting: result.aiRouting, evaluation: { ...evaluation, avgScore: averageScore }, evaluationNormalized: normalized, citationSources: citations, grounding: responseGrounding, attribution, session: { currentTurn: turnNumber, maxTurns, tutorState: result.state, action: result.action, hintLevel: result.hintLevel, sessionGoal: (result.studentModel as StudentModel).sessionGoal }, studentModel: { currentClaim: (result.studentModel as StudentModel).currentClaim, helpLevel: (result.studentModel as StudentModel).helpLevel, weaknessPatterns: (result.studentModel as StudentModel).weaknessPatterns, evidenceUsed: (result.studentModel as StudentModel).evidenceUsed, revisionCount: (result.studentModel as StudentModel).revisionCount }, isSessionEnd };
}

async function runAcceptedLearningIntegrations(env: Bindings, userId: string, sessionId: string, session: Record<string, unknown>, message: string, tutorResponse: string, turnNumber: number, averageScore: number, action: string | null | undefined, evaluation: TrainingEvaluation) {
  try {
    const { processSessionBKT } = await import('../services/bkt-engine');
    const { processArgumentGraph } = await import('../services/faf-engine');
    await processSessionBKT(env.DB, userId, sessionId, { claim_clarity: evaluation.claim_clarity, evidence_use: evaluation.evidence_use, reasoning_strength: evaluation.reasoning_strength, consistency: evaluation.consistency, relevance: evaluation.relevance, weakness_tags: evaluation.weakness_tags });
    try {
      await processArgumentGraph(env.DB, sessionId, turnNumber, message, tutorResponse, { claim_clarity: evaluation.claim_clarity, evidence_use: evaluation.evidence_use, reasoning_strength: evaluation.reasoning_strength }, 'training');
    } catch (error) {
      // Optional graph diagnostics cannot suppress the accepted learner-model update.
      console.error('[TRAINING_ARGUMENT_GRAPH] Non-critical:', error);
    }
    if (turnNumber > 1 && action) {
      const { updateQTableReward, ratingToBucket } = await import('../services/mab-engine');
      await updateQTableReward(env.DB, ratingToBucket(null, averageScore), action, (averageScore - 50) / 100);
    }
    const { initHybridKTState, updateBKTState, initBKTState, buildContextVector, recommendNextAction, updateLinUCBArm } = await import('../services/hybrid-kt-engine');
    let ktState = initHybridKTState(userId);
    const stored = await env.DB.prepare('SELECT state_json FROM hybrid_kt_states WHERE user_id = ?1').bind(userId).first<Record<string, unknown>>();
    if (stored?.state_json) ktState = JSON.parse(String(stored.state_json));
    const conceptId = readString(session.category) || 'training_general';
    if (!ktState.bktStates[conceptId]) ktState.bktStates[conceptId] = initBKTState(conceptId);
    ktState.bktStates[conceptId] = updateBKTState(ktState.bktStates[conceptId], averageScore >= 60, 0.5);
    if (ktState.lastAction && ktState.linucbArms[ktState.lastAction]) {
      ktState.linucbArms[ktState.lastAction] = updateLinUCBArm(ktState.linucbArms[ktState.lastAction], buildContextVector(ktState.bktStates, turnNumber, averageScore, 0.5), averageScore / 100);
    }
    ktState.lastAction = recommendNextAction(ktState, turnNumber, averageScore, 0.5).action;
    await env.DB.prepare('INSERT OR REPLACE INTO hybrid_kt_states (user_id, state_json, updated_at) VALUES (?1, ?2, ?3)').bind(userId, JSON.stringify(ktState), new Date().toISOString()).run();
  } catch (error) { console.error('[TRAINING_ACCEPTED_INTEGRATIONS] non-fatal:', error); }
}

function getRating(score: number): string { if (score >= 90) return 'MASTER'; if (score >= 80) return 'EXPERT'; if (score >= 70) return 'JOURNEYMAN'; if (score >= 60) return 'APPRENTICE'; return 'NOVICE'; }
function safeJson(value: unknown): Record<string, unknown> { try { const parsed = JSON.parse(typeof value === 'string' ? value : '{}'); return isRecord(parsed) ? parsed : {}; } catch { return {}; } }
function legacyDifficulty(value: unknown): TrainingScenarioDifficulty { const numberValue = Number(value); return numberValue >= 2.3 ? 'advanced' : numberValue >= 1.5 ? 'intermediate' : 'beginner'; }

export function publicTrainingSession<T extends Record<string, unknown>>(session: T) {
  const {
    training_mode: _internalTrainingMode,
    has_evaluated_turn: _internalHasEvaluatedTurn,
    logic_score: _internalLegacyLogicScore,
    creativity_score: _internalLegacyCreativityScore,
    evidence_score: _internalLegacyEvidenceScore,
    depth_score: _internalLegacyDepthScore,
    feasibility_score: _internalLegacyFeasibilityScore,
    ...publicSession
  } = session;
  const score = typeof session.avg_score === 'number' ? session.avg_score : Number(session.avg_score);
  const rating = typeof session.rating === 'string' ? session.rating.trim() : '';
  const measured = (session.has_evaluated_turn === true || Number(session.has_evaluated_turn) === 1)
    && rating !== '' && rating !== 'UNKNOWN'
    && Number.isFinite(score) && score >= 20 && score <= 100;
  return {
    ...publicSession,
    avg_score: measured ? score : null,
    rating: measured ? rating : 'UNKNOWN',
    evaluation_status: measured ? 'MEASURED' : 'UNKNOWN',
    logic_score: null,
    creativity_score: null,
    evidence_score: null,
    depth_score: null,
    feasibility_score: null,
    mode: toPublicTrainingMode(session.training_mode),
    origin: String(session.id).startsWith('scn_') ? 'legacy_scenario' : 'training',
  };
}

async function legacyScenarioRows(env: Bindings, userId: string) {
  const result = await env.DB.prepare('SELECT id, domain, sub_domain, difficulty, scenario_json, status, current_turn, final_scores_json, created_at FROM scenario_sessions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50').bind(userId).all<Record<string, unknown>>();
  return (result.results || []).map((row) => { const scenario = safeJson(row.scenario_json); return { id: row.id, category: row.domain, difficulty: legacyDifficulty(row.difficulty), question_title: readString(scenario.title) || readString(row.domain), question: readString(scenario.challenge), avg_score: null, rating: null, current_turn: Number(row.current_turn || 0) + 1, max_turns: 6, is_completed: row.status === 'completed' ? 1 : 0, created_at: row.created_at, mode: 'constructed', origin: 'legacy_scenario', source_count: 0 }; });
}

export async function listTrainingSessions(env: Bindings, userId: string) {
  const current = await env.DB.prepare(`
    SELECT ts.id, ts.category, ts.difficulty, ts.question_title, ts.question,
      ts.avg_score, ts.rating, ts.current_turn, ts.max_turns, ts.is_completed,
      ts.created_at, ts.training_mode,
      EXISTS(
        SELECT 1 FROM training_turns tt
        WHERE tt.session_id = ts.id
          AND tt.claim_clarity BETWEEN 1 AND 5
          AND tt.evidence_use BETWEEN 1 AND 5
          AND tt.reasoning_strength BETWEEN 1 AND 5
          AND tt.consistency_score BETWEEN 1 AND 5
          AND tt.relevance_score BETWEEN 1 AND 5
      ) AS has_evaluated_turn
    FROM training_sessions ts
    WHERE ts.user_id = ?1
    ORDER BY ts.created_at DESC LIMIT 50
  `).bind(userId).all<TrainingSessionListRow>();
  const canonical = (current.results || []).map(publicTrainingSession);
  const ids = new Set(canonical.map((row) => String(row.id)));
  return [...canonical, ...(await legacyScenarioRows(env, userId)).filter((row) => !ids.has(String(row.id)))].sort((a, b) => Number(b.created_at) - Number(a.created_at)).slice(0, 50);
}

export async function promoteLegacyScenarioForResume(env: Bindings, userId: string, sessionId: string) {
  const legacy = await env.DB.prepare('SELECT * FROM scenario_sessions WHERE id = ?1 AND user_id = ?2').bind(sessionId, userId).first<Record<string, unknown>>();
  if (!legacy) return null;
  if (legacy.status === 'completed') throw new TrainingOperationError(400, { error: '이미 완료된 세션입니다.' });
  const scenario = safeJson(legacy.scenario_json); const createdAt = Number(legacy.created_at || Date.now()); const currentTurn = Number(legacy.current_turn || 0) + 1;
  const model = createStudentModel(sessionId, readString(scenario.title) || readString(legacy.domain), '');
  const turns = await env.DB.prepare('SELECT turn_number, user_response, evaluation_json, next_challenge_json, created_at FROM scenario_turns WHERE session_id = ?1 ORDER BY turn_number ASC').bind(sessionId).all<Record<string, unknown>>();
  const rawLegacy = (turns.results || []).map((turn) => ({ turnNumber: turn.turn_number, userResponse: turn.user_response, evaluation: safeJson(turn.evaluation_json), nextChallenge: safeJson(turn.next_challenge_json), createdAt: turn.created_at }));
  const modelWithLegacy = JSON.stringify({ ...model, legacyScenario: { origin: 'legacy_scenario', evaluations: rawLegacy } });
  await env.DB.batch([env.DB.prepare('INSERT INTO training_sessions (id, user_id, category, difficulty, question, question_title, context, expected_tensions, session_goal, tutor_state, student_model, current_turn, max_turns, training_mode, avg_score, rating, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 6, ?13, NULL, NULL, ?14, ?14)').bind(sessionId, userId, readString(legacy.domain), legacyDifficulty(legacy.difficulty), readString(scenario.challenge), readString(scenario.title), readString(scenario.context), '[]', '', 'elicitation', modelWithLegacy, currentTurn, toPersistedTrainingMode('constructed'), createdAt)]);
  return true;
}

export async function legacyScenarioProjection(env: Bindings, userId: string, sessionId: string) {
  const legacy = await env.DB.prepare('SELECT * FROM scenario_sessions WHERE id = ?1 AND user_id = ?2').bind(sessionId, userId).first<Record<string, unknown>>();
  if (!legacy) return null;
  const scenario = safeJson(legacy.scenario_json);
  const turns = await env.DB.prepare('SELECT * FROM scenario_turns WHERE session_id = ?1 ORDER BY turn_number ASC').bind(sessionId).all<Record<string, unknown>>();
  return {
    session: {
      id: legacy.id,
      user_id: legacy.user_id,
      category: legacy.domain,
      difficulty: legacyDifficulty(legacy.difficulty),
      question_title: readString(scenario.title) || readString(legacy.domain),
      question: readString(scenario.challenge),
      context: readString(scenario.context),
      current_turn: Number(legacy.current_turn || 0) + 1,
      max_turns: 6,
      is_completed: legacy.status === 'completed' ? 1 : 0,
      mode: 'constructed',
      origin: 'legacy_scenario',
      scenario,
      finalScores: safeJson(legacy.final_scores_json),
      legacyScenarioRaw: { scenarioJson: legacy.scenario_json, finalScoresJson: legacy.final_scores_json },
    },
    messages: [],
    turns: (turns.results || []).map((turn) => {
      const { evaluation_json: evaluationJson, next_challenge_json: nextChallengeJson, ...legacyTurn } = turn;
      return { ...legacyTurn, evaluation: safeJson(evaluationJson), nextChallenge: safeJson(nextChallengeJson), legacyScenarioEvaluation: evaluationJson, legacyScenarioNextChallenge: nextChallengeJson, legacyScenarioRaw: { evaluationJson, nextChallengeJson } };
    }),
  };
}

trainingRoute.get('/api/training/cases', (c) => {
  return c.json({ cases: getPublicTrainingCaseEntries() });
});
trainingRoute.post('/api/training/start', async (c) => { const request = parseTrainingStartRequest(await c.req.json<unknown>()); const userId = getAuthUser(c)?.userId; if (!request) return c.json({ error: `category, difficulty, mode, and an optional maxTurns integer between ${MIN_TRAINING_TURNS} and ${MAX_TRAINING_TURNS} are required` }, 400); if (!userId) return c.json({ error: '인증이 필요합니다.' }, 401); try { return c.json(await startTrainingSession(c.env, userId, request)); } catch (error) { return operationResponse(c, error, 'Training start error'); } });
trainingRoute.post('/api/training/operator/heldout-attempts', requireRole('admin'), async c => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ code: 'TRAINING_HELDOUT_ARM_INPUT_INVALID' }, 400); }
  if (!isRecord(body) || !hasOnlyKeys(body, ['baseSessionId', 'ownerUserId', 'opaqueVariantId', 'taskText', 'mutationKey'])
    || typeof body.baseSessionId !== 'string' || typeof body.ownerUserId !== 'string' || typeof body.opaqueVariantId !== 'string'
    || typeof body.taskText !== 'string' || typeof body.mutationKey !== 'string') return c.json({ code: 'TRAINING_HELDOUT_ARM_INPUT_INVALID' }, 400);
  try {
    const result = await armHeldOutAttempt(c.env.DB, getAuthUser(c)!.userId, body as { baseSessionId: string; ownerUserId: string; opaqueVariantId: string; taskText: string; mutationKey: string });
    return c.json(result, result.replayed ? 200 : 201);
  } catch (error) { return operationResponse(c, error, 'Held-out attempt arm error'); }
});
trainingRoute.get('/api/training/evidence-models', async (c) => {
  const userId = getAuthUser(c)?.userId;
  if (!userId) return c.json({ error: 'Authentication required' }, 401);
  try {
    return c.json(await loadOwnedTrainingEvidenceModels(c.env.DB, userId));
  } catch (error) {
    return operationResponse(c, error, 'Training evidence-model read error');
  }
});
trainingRoute.get('/api/training/operator/heldout-attempts/:id', requireRole('admin'), async c => {
  try { return c.json(await readOperatorHeldOutAttempt(c.env.DB, getAuthUser(c)!.userId, c.req.param('id'))); }
  catch (error) { return operationResponse(c, error, 'Held-out attempt audit error'); }
});
trainingRoute.post('/api/training/heldout-attempts/:id/open', async c => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ code: 'TRAINING_HELDOUT_MUTATION_INPUT_INVALID' }, 400); }
  const input = heldOutMutationInput(body);
  if (!input) return c.json({ code: 'TRAINING_HELDOUT_MUTATION_INPUT_INVALID' }, 400);
  try { return c.json(await openHeldOutAttempt(c.env.DB, getAuthUser(c)!.userId, c.req.param('id'), input)); }
  catch (error) { return operationResponse(c, error, 'Held-out attempt open error'); }
});
trainingRoute.post('/api/training/heldout-attempts/:id/submit', async c => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ code: 'TRAINING_HELDOUT_RESPONSE_INVALID' }, 400); }
  if (!isRecord(body) || !hasOnlyKeys(body, ['response', 'expectedRevision', 'mutationKey']) || typeof body.response !== 'string') return c.json({ code: 'TRAINING_HELDOUT_RESPONSE_INVALID' }, 400);
  const mutation = heldOutMutationInput({ expectedRevision: body.expectedRevision, mutationKey: body.mutationKey });
  if (!mutation) return c.json({ code: 'TRAINING_HELDOUT_MUTATION_INPUT_INVALID' }, 400);
  try { return c.json(await submitHeldOutAttempt(c.env.DB, getAuthUser(c)!.userId, c.req.param('id'), { ...mutation, response: body.response })); }
  catch (error) { return operationResponse(c, error, 'Held-out attempt submit error'); }
});
trainingRoute.post('/api/training/heldout-attempts/:id/stop', async c => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ code: 'TRAINING_HELDOUT_MUTATION_INPUT_INVALID' }, 400); }
  const input = heldOutMutationInput(body);
  if (!input) return c.json({ code: 'TRAINING_HELDOUT_MUTATION_INPUT_INVALID' }, 400);
  try { return c.json(await stopHeldOutAttempt(c.env.DB, getAuthUser(c)!.userId, c.req.param('id'), input)); }
  catch (error) { return operationResponse(c, error, 'Held-out attempt stop error'); }
});
trainingRoute.post('/api/training/heldout-attempts/:id/contamination', async c => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ code: 'TRAINING_HELDOUT_CONTAMINATION_INPUT_INVALID' }, 400); }
  if (!isRecord(body) || !hasOnlyKeys(body, ['contaminationCode', 'expectedRevision', 'mutationKey']) || typeof body.contaminationCode !== 'string') return c.json({ code: 'TRAINING_HELDOUT_CONTAMINATION_INPUT_INVALID' }, 400);
  const mutation = heldOutMutationInput({ expectedRevision: body.expectedRevision, mutationKey: body.mutationKey });
  if (!mutation) return c.json({ code: 'TRAINING_HELDOUT_MUTATION_INPUT_INVALID' }, 400);
  try { return c.json(await reportHeldOutContamination(c.env.DB, getAuthUser(c)!.userId, c.req.param('id'), { ...mutation, contaminationCode: body.contaminationCode })); }
  catch (error) { return operationResponse(c, error, 'Held-out contamination error'); }
});
trainingRoute.delete('/api/training/session/:id', async c => {
  const ownerUserId = getAuthUser(c)?.userId;
  if (!ownerUserId) return c.json({ error: '인증이 필요합니다.' }, 401);
  try {
    return c.json(await deleteOwnedTrainingSession(c.env.DB, ownerUserId, c.req.param('id')));
  } catch (error) { return operationResponse(c, error, 'Training deletion error'); }
});
trainingRoute.get('/api/training/session/:id/interventions', async c => {
 const owner=getAuthUser(c)?.userId; if(!owner) return c.json({error:'Authentication required'},401);
 try { await rejectHeldOutAssistanceReference(c.env.DB, owner, c.req.param('id')); return c.json(await loadTrainingInterventions(c.env.DB,owner,c.req.param('id'))); } catch(error) { return operationResponse(c,error,'Training control read'); }
});
trainingRoute.post('/api/training/session/:id/interventions', async c => {
 const owner=getAuthUser(c)?.userId; if(!owner) return c.json({error:'Authentication required'},401);
 let body:unknown; try { body=await c.req.json(); } catch { return c.json({code:'TRAINING_INTERVENTION_INPUT_INVALID'},400); }
 try { await rejectHeldOutAssistanceReference(c.env.DB, owner, c.req.param('id')); return c.json(await requestTrainingIntervention(c.env.DB,owner,c.req.param('id'),body)); } catch(error) { return operationResponse(c,error,'Training control write'); }
});
trainingRoute.post('/api/training/session/:id/support', async c => {
 const owner=getAuthUser(c)?.userId; if(!owner) return c.json({error:'Authentication required'},401);
 try { await rejectHeldOutAssistanceReference(c.env.DB, owner, c.req.param('id')); return c.json(await provideTrainingSupport(c.env,owner,c.req.param('id'))); } catch(error) { return operationResponse(c,error,'Training support'); }
});
trainingRoute.get('/api/training/session/:id/revisions', async (c) => {
 const userId = getAuthUser(c)?.userId; if (!userId) return c.json({ error: 'Authentication required' }, 401);
 try { await rejectHeldOutAssistanceReference(c.env.DB, userId, c.req.param('id')); return c.json(await loadLearnerRevisions(c.env.DB, userId, c.req.param('id'))); } catch (error) { return operationResponse(c, error, 'Learner revision read error'); }
});
trainingRoute.post('/api/training/session/:id/revisions', async (c) => {
 const userId = getAuthUser(c)?.userId; if (!userId) return c.json({ error: 'Authentication required' }, 401);
 let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'TRAINING_REVISION_INPUT_INVALID' }, 400); }
 try { await rejectHeldOutAssistanceReference(c.env.DB, userId, c.req.param('id')); return c.json(await declareLearnerRevision(c.env.DB, userId, c.req.param('id'), body)); } catch (error) { return operationResponse(c, error, 'Learner revision write error'); }
});
trainingRoute.post('/api/training/session/:id/route', async (c) => {
 const userId = getAuthUser(c)?.userId;
 if (!userId) return c.json({ error: 'Authentication required' }, 401);
 const body = await c.req.json<unknown>();
 if (!isRecord(body) || !isTrainingRoute(body.selectedRoute) || typeof body.expectedRevision !== 'number' || typeof body.mutationKey !== 'string' || Object.keys(body).some(key => !['selectedRoute','expectedRevision','mutationKey'].includes(key))) return c.json({ error: 'Invalid route choice' }, 400);
 try { return c.json(await reviseTrainingRoute(c.env.DB, userId, c.req.param('id'), { selectedRoute: body.selectedRoute, expectedRevision: body.expectedRevision, mutationKey: body.mutationKey })); }
 catch (error) { return operationResponse(c, error, 'Training route revision error'); }
});
trainingRoute.get('/api/training/session/:id/route', async (c) => {
 const userId = getAuthUser(c)?.userId;
 if (!userId) return c.json({ error: 'Authentication required' }, 401);
 try { return c.json(await loadTrainingRoute(c.env.DB, userId, c.req.param('id'))); }
 catch (error) { return operationResponse(c, error, 'Training route read error'); }
});
trainingRoute.post('/api/training/chat', async (c) => { const body = await c.req.json<unknown>(); const userId = getAuthUser(c)?.userId; if (!isRecord(body) || !userId) return c.json({ error: 'sessionId and message are required' }, 400); try { const sessionId = readString(body.sessionId); await rejectHeldOutAssistanceReference(c.env.DB, userId, sessionId); return c.json(await respondTrainingSession(c.env, userId, sessionId, readString(body.message), c.executionCtx)); } catch (error) { return operationResponse(c, error, 'Training chat error'); } });
trainingRoute.get('/api/training/sessions', async (c) => { const userId = getAuthUser(c)?.userId; if (!userId) return c.json({ error: '인증이 필요합니다.' }, 401); try { return c.json({ sessions: await listTrainingSessions(c.env, userId) }); } catch (error) { return operationResponse(c, error, 'Training sessions error'); } });
trainingRoute.post('/api/training/session/:id/resume', async (c) => {
  const userId = getAuthUser(c)?.userId; const id = c.req.param('id');
  if (!userId) return c.json({ error: '인증이 필요합니다.' }, 401);
  try {
    const exists = await c.env.DB.prepare('SELECT id FROM training_sessions WHERE id = ?1').bind(id).first();
    if (!exists) await promoteLegacyScenarioForResume(c.env, userId, id);
    const session = await c.env.DB.prepare(`
      SELECT ts.*,
        EXISTS(
          SELECT 1 FROM training_turns tt
          WHERE tt.session_id = ts.id
            AND tt.claim_clarity BETWEEN 1 AND 5
            AND tt.evidence_use BETWEEN 1 AND 5
            AND tt.reasoning_strength BETWEEN 1 AND 5
            AND tt.consistency_score BETWEEN 1 AND 5
            AND tt.relevance_score BETWEEN 1 AND 5
        ) AS has_evaluated_turn
      FROM training_sessions ts
      WHERE ts.id = ?1 AND ts.user_id = ?2
    `).bind(id, userId).first<Record<string, unknown>>();
    if (!session) throw new TrainingOperationError(404, { error: 'Session not found' });
    const heldOutAttempt = await readOwnedHeldOutAttempt(c.env.DB, userId, id);
    if (session.is_completed && heldOutAttempt.status === 'NONE') throw new TrainingOperationError(400, { error: '이미 완료된 세션입니다.' });
    const mode = toPublicTrainingMode(session.training_mode);
    const grounding = await readTrainingHistoryGrounding(c.env.DB, id, mode);
    const caseReadback = await loadTrainingCaseContractProjection(c.env.DB, id);
    if (caseReadback.status === 'broken') {
      throw new TrainingOperationError(409, { code: 'TRAINING_CASE_SNAPSHOT_INVALID', error: '훈련 사례 스냅샷을 검증하지 못했습니다.', assessmentState: 'UNGRADABLE', caseContractStatus: 'broken' });
    }
    const messages = await c.env.DB.prepare('SELECT role, content, turn, timestamp FROM training_messages WHERE session_id = ?1 ORDER BY timestamp ASC').bind(id).all();
    const attributions = await loadLearnerSourceAttributions(c.env.DB, { userId, sessionKind: 'training', sessionId: id });
    const learningRoute = session.learning_route_version === 1 ? await loadTrainingRoute(c.env.DB, userId, id) : { status: 'UNKNOWN', offer: null, decision: null };
    return c.json({ success: true, sessionId: id, session: publicTrainingSession(session), messages: messages.results || [], grounding, caseContract: caseReadback.caseContract, caseContractStatus: caseReadback.status, attributions, learningRoute, trainingHistory: await readOwnedTrainingHistorySupplements(c.env.DB, userId, id), heldOutAttempt, growthFollowUp: await readTrainingFollowUpLink(c.env.DB,userId,id) });
  } catch (error) { return operationResponse(c, error, 'Training resume error'); }
});
trainingRoute.get('/api/training/session/:id', async (c) => {
  const userId = getAuthUser(c)?.userId; const id = c.req.param('id');
  if (!userId) return c.json({ error: '인증이 필요합니다.' }, 401);
  try {
    const session = await c.env.DB.prepare(`
      SELECT ts.*,
        EXISTS(
          SELECT 1 FROM training_turns tt
          WHERE tt.session_id = ts.id
            AND tt.claim_clarity BETWEEN 1 AND 5
            AND tt.evidence_use BETWEEN 1 AND 5
            AND tt.reasoning_strength BETWEEN 1 AND 5
            AND tt.consistency_score BETWEEN 1 AND 5
            AND tt.relevance_score BETWEEN 1 AND 5
        ) AS has_evaluated_turn
      FROM training_sessions ts WHERE ts.id = ?1
    `).bind(id).first<Record<string, unknown>>();
    if (!session) { const legacy = await legacyScenarioProjection(c.env, userId, id); if (!legacy) throw new TrainingOperationError(404, { error: 'Session not found' }); return c.json({ ...legacy, grounding: { status: 'not_applicable', reason: 'constructed_scenario' } }); }
    if (!canAccessOwnerResource((session.user_id as string | null) || null, userId)) throw new TrainingOperationError(403, { error: '접근 권한이 없습니다.' });
    const mode = toPublicTrainingMode(session.training_mode);
    const grounding = await readTrainingHistoryGrounding(c.env.DB, id, mode);
    const caseReadback = await loadTrainingCaseContractProjection(c.env.DB, id);
    if (caseReadback.status === 'broken') {
      throw new TrainingOperationError(409, { code: 'TRAINING_CASE_SNAPSHOT_INVALID', error: '훈련 사례 스냅샷을 검증하지 못했습니다.', assessmentState: 'UNGRADABLE', caseContractStatus: 'broken' });
    }
    const messages = await c.env.DB.prepare('SELECT role, content, turn, timestamp FROM training_messages WHERE session_id = ?1 ORDER BY timestamp ASC').bind(id).all();
    const turns = await c.env.DB.prepare('SELECT * FROM training_turns WHERE session_id = ?1 ORDER BY turn_number ASC').bind(id).all();
    const attributions = await loadLearnerSourceAttributions(c.env.DB, { userId, sessionKind: 'training', sessionId: id });
    const learningRoute = session.learning_route_version === 1 ? await loadTrainingRoute(c.env.DB, userId, id) : { status: 'UNKNOWN', offer: null, decision: null };
    return c.json({ session: publicTrainingSession(session), messages: messages.results || [], turns: turns.results || [], grounding, caseContract: caseReadback.caseContract, caseContractStatus: caseReadback.status, attributions, learningRoute, trainingHistory: await readOwnedTrainingHistorySupplements(c.env.DB, userId, id), heldOutAttempt: await readOwnedHeldOutAttempt(c.env.DB, userId, id), growthFollowUp: await readTrainingFollowUpLink(c.env.DB,userId,id) });
  } catch (error) { return operationResponse(c, error, 'Training detail error'); }
});
trainingRoute.post('/api/training/hint', async (c) => {
  const body = await c.req.json<unknown>(); const userId = getAuthUser(c)?.userId;
  if (!isRecord(body) || !userId) return c.json({ error: 'sessionId is required' }, 400);
  try {
    const sessionId = readString(body.sessionId); await rejectHeldOutAssistanceReference(c.env.DB, userId, sessionId); const session = await c.env.DB.prepare('SELECT * FROM training_sessions WHERE id = ?1').bind(sessionId).first<Record<string, unknown>>();
    if (!session || !canAccessOwnerResource((session.user_id as string | null) || null, userId)) throw new TrainingOperationError(404, { error: 'Session not found' });
    const control = await loadTrainingInterventions(c.env.DB,userId,sessionId);
    if (control.state !== 'ACTIVE') throw new TrainingInterventionError(409,'TRAINING_'+control.state);
    const mode = toPublicTrainingMode(session.training_mode);
    if (mode === 'evidence') {
      throw new TrainingOperationError(409, {
        code: 'EVIDENCE_HINT_UNAVAILABLE',
        error: '근거 기반 훈련에서는 힌트를 사용할 수 없습니다.',
      });
    }
    const evidence = null;
    if (!hasGenerationProvider(c.env)) throw new TrainingOperationError(503, { error: 'training_hint_provider_not_configured' });
    const referenceText = '';
    const model = deserializeStudentModel((session.student_model as string) || '{}');
    const level = Math.min(5, (model.helpLevel || 0) + 1) as HintLadderLevel;
    const { buildHintPrompt } = await import('../services/tutoring/hint-ladder');
    const constructedHintPrompt = constructedHintUserPrompt.replace('{{category}}', String(session.category)).replace('{{difficulty}}', String(session.difficulty)).replace('{{scenario}}', `${String(session.question)}\n${String(session.context || '')}`).replace('{{hint_level}}', String(level));
    const result = await createAIRouter(c.env).completeValidatedJSON('interactive_generation', {
      systemPrompt: mode === 'constructed'
        ? constructedScenarioSystemPrompt
        : buildHintPrompt(level, model.topic, model.currentClaim, model.lastDiagnosis, referenceText),
      userPrompt: mode === 'constructed'
        ? constructedHintPrompt
        : '위 규칙에 맞는 힌트를 JSON으로 작성하세요: { "hint": "..." }',
      temperature: 0.5,
      maxTokens: 300,
      promptSchemaVersion: 'training-hint-schema-v1',
      promptVersion: 'training-hint-v1',
    }, parseTrainingHint);
    const hint = result.value.hint;
    model.helpLevel = level; const update = await c.env.DB.prepare('UPDATE training_sessions SET student_model = ?2, deep_hint_level = ?3 WHERE id = ?1 AND (SELECT COALESCE(MAX(revision),0) FROM training_interventions WHERE session_id=?1)=?4').bind(sessionId, serializeStudentModel(model), level, control.revision).run();
    if (update.meta.changes !== 1) throw new TrainingInterventionError(409,'TRAINING_INTERVENTION_CONFLICT');
    return c.json({ hintLevel: level, hintMessage: hint, hintLevelChanged: true });
  } catch (error) { return operationResponse(c, error, 'Training hint error'); }
});

trainingRoute.get('/api/training/categories', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT id, parent_id, name_ko, name_en, icon, level, sort_order FROM category_hierarchy WHERE is_active = 1 ORDER BY level ASC, sort_order ASC').all();
    return c.json({ categories: result.results || [] });
  } catch (error) { console.error('Training categories error:', error); return c.json({ error: 'training_category_catalog_unavailable' }, 503); }
});
trainingRoute.get('/api/training/question-bank', async (c) => {
  try {
    const category = c.req.query('category'); const difficulty = c.req.query('difficulty'); const limit = Math.min(parseInt(c.req.query('limit') || '5', 10), 20);
    let sql = 'SELECT id, category, question_type, scenario, challenge, expected_tensions, difficulty, times_used, avg_score, created_at FROM daily_question_bank WHERE is_active = 1';
    const binds: (string | number)[] = [];
    if (category) { sql += ` AND category = ?${binds.length + 1}`; binds.push(category); }
    if (difficulty) { sql += ` AND difficulty = ?${binds.length + 1}`; binds.push(difficulty); }
    sql += ` ORDER BY RANDOM() LIMIT ?${binds.length + 1}`; binds.push(limit);
    const result = await c.env.DB.prepare(sql).bind(...binds).all<QuestionBankRow>();
    return c.json({ questions: (result.results || []).map((question) => ({ ...question, expected_tensions: JSON.parse(question.expected_tensions || '[]') })) });
  } catch (error) { console.error('Training question bank error:', error); return c.json({ error: '문제 목록을 불러오지 못했습니다.' }, 500); }
});
trainingRoute.post('/api/training/question-bank/generate', requireRole('admin'), async (c) => {
  try {
    const result = await handleCronQuestionGeneration({
      DB: c.env.DB,
      DEEPSEEK_API_KEY: c.env.DEEPSEEK_API_KEY,
    }, { trigger: 'manual', actorUserId: getAuthUser(c)?.userId || null });
    const httpStatus = result.status === 'failed' ? 502 : result.status === 'partial' ? 207 : 200;
    return c.json({
      success: result.status === 'completed',
      status: result.status,
      runId: result.runId,
      requested: result.requested,
      generated: result.generated,
      deactivated: result.deactivated,
      errors: result.errors,
    }, httpStatus);
  } catch (error) { console.error('Training question generation error:', error); return c.json({ error: '문제를 생성하지 못했습니다.' }, 500); }
});
trainingRoute.get('/api/training/bkt', async (c) => {
  try {
    const userId = getAuthUser(c)?.userId || null;
    const result = await c.env.DB.prepare('SELECT concept, p_know, observations, updated_at FROM bkt_knowledge_states WHERE user_id IS ?1 ORDER BY p_know ASC').bind(userId).all();
    return c.json({ knowledgeStates: result.results || [] });
  } catch (error) { console.error('Training BKT error:', error); return c.json({ error: '학습 상태를 불러오지 못했습니다.' }, 500); }
});

function operationResponse(c: { json: (value: Record<string, unknown>, status?: number) => Response }, error: unknown, label: string) {
  if (error instanceof HeldOutDeliveryError) return c.json({ code: error.code, error: error.code, ...error.body }, error.status);
  if (error instanceof TrainingDeletionError) return c.json({ code: error.code, error: error.code }, error.status);
  if(String(error).includes('TRAINING_SOURCE_UNAVAILABLE'))return c.json(trainingSourceUnavailable().body,409);
  if(error instanceof GrowthServiceError) return c.json({code:error.code,error:error.code,phase:error.phase,retryable:error.retryable,...(error.details || {})},error.status);
  if (/TRAINING_INTERVENTION_TERMINAL/.test(String(error))) return c.json({error:'This session has stopped.',code:'TRAINING_INTERVENTION_TERMINAL'},409);
  if (error instanceof TrainingInterventionError) return c.json({error:error.code,code:error.code},error.status);
  if (/TRAINING_INTERVENTION_CONFLICT/.test(String(error))) return c.json({error:'The session control changed. Review its current state.',code:'TRAINING_INTERVENTION_CONFLICT'},409);
  if (error instanceof LearnerRevisionError) return c.json({ error: error.code, code: error.code }, error.status);
  if (/TRAINING_REVISION_CONFLICT/.test(String(error))) return c.json({ error: 'A learner correction changed. Review the current correction and retry.', code: 'TRAINING_REVISION_CONFLICT' }, 409);
  if (error instanceof TrainingRouteError) return c.json({ error: error.code, code: error.code }, error.status);
  if (/TRAINING_ROUTE_CONFLICT/.test(String(error))) return c.json({ error: 'The learning route changed. Review it and retry this answer.', code: 'TRAINING_ROUTE_CONFLICT' }, 409);
  if (error instanceof TrainingOperationError) return c.json(error.body, error.status);
  if (isCriticUnavailable(error)) return c.json(criticUnavailableError(error).body, 503);
  if (isEvaluatorUnavailable(error)) return c.json(evaluatorUnavailableError(error).body, 503);
  if (isTutorGenerationUnavailable(error)) return c.json(tutorGenerationUnavailableError(error).body, 503);
  if (error instanceof AIRouteUnavailableError) {
    return c.json(tutorGenerationUnavailableError(error).body, 503);
  }
  console.error(label, error);
  return c.json({ error: '훈련 요청을 처리하지 못했습니다.' }, 500);
}

export { trainingRoute };
export default trainingRoute;
