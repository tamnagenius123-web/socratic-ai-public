import { trainingRouteDirective, trainingRouteActionPreference, type TrainingRouteDecision } from '../training/training-route';
import type { TrainingCasePromptVersion } from '../training/case-contracts/haneul-harbor-investment';
// D-Plan + B-Plan: Tutoring Orchestrator (v21.0)
// Coordinates: Evaluator → Action Selector → State Machine → Actor → Student Model Update
// v14.0: ThoughtProfile + ChallengeEngine integration
// v17.0: Pressure Move injection, Micro Scoring, xAIF Snapshot
// v18.0: xAIF V2 (L-node/TA-edge), Illocutionary Force, Process Evaluator, ASYNC-001 fix, DB-001 batch
// v19.0: BUG-101~106 Full Fix, Hybrid KT Integration, LinUCB Experiment,
//        Probabilistic ARC, CASS Benchmark, JSON-LD, Process Evaluation Complete
// v20.0: P0-A Hybrid KT 실데이터 루프, P0-B LinUCB 실선택/실업데이트,
//        Adapter-aware ARC inference, ctx.waitUntil 운영 안정성
// v21.0: CRITICAL-001 LinUCB Step 10→2.5 이동 (응답 생성 전 결정),
//        CRITICAL-002 ctx.waitUntil 전면 도입 (side-effects 비동기 분리),
//        P0-4 D1 batch chunk 유틸 적용, as any 전수 청산
// This is the main entry point for processing a student turn

import { AIRouteUnavailableError, type AIFailureClass, type AIRouteMetadata, type AIRouter } from '../ai-router';
import { recordRoutedAIUsage } from '../ai-client';
import type {
  TutorState,
  TutorAction,
  DeepEvaluation,
  StudentModel,
  TutorTurnResult,
  HintLadderLevel,
  WeaknessTag,
} from './types';
import { learnerRevisionAction, learnerRevisionDirective, type LearnerRevisionPrompt } from '../training/learner-revision';
import { readPriorAcceptedRevisionAttempts, type RevisionAttemptScope } from './revision-attempts';
import { createStudentModel, updateStudentModel, serializeStudentModel, deserializeStudentModel } from './student-model-engine';
import { nextState, getSessionGoal, tutorStateToPhase } from './state-machine';
import { selectAction, adjustForRepetition } from './action-selector';
import { calculateEffectiveHintLevel } from './hint-ladder';
import {
  getEvaluatorSystemPrompt,
  buildEvaluatorUserPrompt,
  getActorSystemPrompt,
  buildActorUserPrompt,
} from './prompt-registry';
// v14.0: Intelligence Layer
import { updateThoughtProfile, formatThoughtProfileForPrompt, createDefaultThoughtProfile, type ThoughtProfile } from './thought-profiler';
import { determineChallengeLevel, getChallengeConstraints, filterActionByChallenge, createDefaultChallengeState, type ChallengeState } from './challenge-engine';
// v16.0: DeepSkill Argumentation Intelligence
import { fastRuleTag, selectPressureMove, PRESSURE_TEMPLATES, type DialogueActResult, type PressureMove } from './dialogue-act';
import { buildMasteredConceptMap, updateConceptMastery } from '../math/knowledge-graph';
// v17: Micro-Indicator Scoring Engine (BUG-005 Fix)
import { computeMicroScores, persistMicroScores, type MicroScoreBatch } from './micro-indicator-engine';
// v18: Illocutionary Force Encoder + DA V2 (Mezza 2024 ArguNet 완전 규격)
import { classifyDialogueActV2RuleBased, type DialogueActResultV2 } from './illocutionary-encoder';
// v19: Process Evaluator (Park et al. 2024 과정 중심 평가 완전 통합)
import { persistTurnSnapshot, computeProcessMetrics, persistProcessEvaluation, computeSmoothedTrajectory, type TurnSnapshot } from './process-evaluator';
// v19 BUG-102 Fix: Hybrid KT 엔진 (BKT+DKT 앵상블) 완전 연동
import { computeHybridKT, type HybridKTResult } from '../math/hybrid-kt-engine';
// v19 BUG-102 Fix: LinUCB Contextual Bandit 연동
import { selectLinUCBAction, updateLinUCBArm, createLinUCBArm, type LinUCBContext, type LinUCBArm } from '../math/linucb-engine';
// v9.0+ Math Engines
import { extractArgumentNodes, type ArgumentNode } from '../math/faf-engine';
import { computeBKTUpdates, type BKTObservation } from '../math/bkt-engine';
import { computeReward, inferBucketFromScore, selectActionByMAB, type QTableEntry } from '../math/mab-engine';
// v10.0+ Phase 2: Mentor-Critic + AIF + KG
import { runMentorCriticPipeline, quickLeakageCheck, type MentorCriticResult } from '../math/critic-agent';
import { extractAIFRuleBased, buildAIFGraph, persistAIFToD1, computeArgumentStrength, detectMissingEdges, buildXAIFDocument, persistXAIFDocument, type AIFGraph } from '../math/aif-pipeline';
import type { ArgumentGraphScope } from '../argument-graph-store';
import type { DialogueActSummary, ARCProbDistribution } from '../math/xaif-schema';
import { serializeToJSONLD } from '../math/xaif-schema';
import { verifyConstraints, retrieveGraphRAGContext, type ConstraintViolation } from '../math/knowledge-graph';
// v21 P0-4: D1 batch chunk utility
import { batchExecute, batchExecuteSafe } from '../../utils/d1-batch';

// =============================================
// Process Student Turn (Main Entry Point)
// =============================================
export class EvaluatorUnavailableError extends Error {
  readonly code = 'EVALUATOR_UNAVAILABLE' as const;
  readonly status = 503 as const;

  constructor(
    readonly failureClass: AIFailureClass = 'invalid_response',
    readonly retryable = true,
  ) {
    super('Student evaluation provider failed or returned an invalid score payload.');
    this.name = 'EvaluatorUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TutorGenerationUnavailableError extends Error {
  readonly code = 'TUTOR_GENERATION_FAILED' as const;
  readonly status = 503 as const;

  constructor(
    readonly failureClass: AIFailureClass = 'invalid_response',
    readonly retryable = true,
  ) {
    super('Tutor generation provider failed or returned an invalid response payload.');
    this.name = 'TutorGenerationUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function processStudentTurn(input: {
  router: AIRouter;
  sessionId: string;
  currentState: TutorState;
  studentModel: StudentModel;
  studentMessage: string;
  bookText: string;
  conversationHistory: { role: string; content: string }[];
  turnNumber: number;
  maxTurns: number;
  db?: D1Database; // v21: strict typing (was any)
  userId?: string | null; // for BKT tracking
  // v14.0: Intelligence Layer inputs
  thoughtProfile?: ThoughtProfile;
  challengeState?: ChallengeState;
  // Immutable source IDs supplied to the evaluator; they are validated by the route
  // before any learner-facing attribution is persisted.
  evidenceSourceIds?: string[];
  learningRoute?: TrainingRouteDecision | null;
  learnerRevision?: LearnerRevisionPrompt | null;
  revisionAttemptScope?: RevisionAttemptScope;
  caseDirective?: string | null;
  casePromptVersion?: TrainingCasePromptVersion | null;
  argumentGraphScope?: ArgumentGraphScope;
}): Promise<TutorTurnResult> {
  const {
    router,
    currentState,
    studentModel,
    studentMessage,
    bookText,
    conversationHistory,
    turnNumber,
    maxTurns,
    db,
    userId,
  } = input;

  // v14.0: Initialize intelligence layer state
  let thoughtProfile = input.thoughtProfile || createDefaultThoughtProfile();
  let challengeState = input.challengeState || createDefaultChallengeState();

  const priorAcceptedRevisionAttempts = db && userId && input.revisionAttemptScope
    ? await readPriorAcceptedRevisionAttempts(db, userId, input.sessionId, input.revisionAttemptScope, turnNumber)
    : null;

  // --- Step 1: Evaluate student answer ---
  const evaluated = await evaluateStudent(router, {
      sessionGoal: studentModel.sessionGoal,
      currentState,
      topic: studentModel.topic,
      latestStudentAnswer: studentMessage,
      previousStudentAnswer: getPreviousStudentAnswer(conversationHistory),
      studentModel,
      bookTextSnippet: bookText,
      conversationHistory: formatRecentHistory(conversationHistory, 6),
      evidenceSourceIds: input.evidenceSourceIds || [],
      caseDirective: input.caseDirective,
      casePromptVersion: input.casePromptVersion,
  });
  const evaluation = evaluated.evaluation;

  // --- Step 2: Select action (MAB-enhanced, v9.0+) ---
  // v9.0: Pass studentMessage for Dynamic Bypass detection
  let action = selectAction({
    currentState,
    evaluation,
    studentModel,
    studentMessage,
  });

  const routePreference = trainingRouteActionPreference(input.learningRoute, action, evaluation, currentState);
  action = routePreference.initial;

  // v9.0+: MAB Q-Table override (if DB available)
  if (db && !input.learnerRevision) {
    try {
      const avgScore = Math.round(
        (evaluation.claim_clarity + evaluation.evidence_use +
         evaluation.reasoning_strength + evaluation.consistency +
         evaluation.relevance) * 20 / 5
      );
      const bucket = inferBucketFromScore(avgScore);
      const qTableResult = await db.prepare(
        'SELECT student_level_bucket, tutor_action, times_selected, total_reward, avg_reward FROM tutor_policy_q_table WHERE student_level_bucket = ?1'
      ).bind(bucket).all<QTableEntry>();

      if (qTableResult.results && qTableResult.results.length > 0) {
        const mabResult = selectActionByMAB(
          qTableResult.results.filter(row => !routePreference.candidates || routePreference.candidates.includes(row.tutor_action as TutorAction)),
          bucket,
          [studentModel.lastTutorAction as TutorAction].filter(Boolean),
        );
        // MAB suggests action only if confidence is sufficient (times_selected > 5)
        const mabEntry = (qTableResult.results).find(
          e => e.tutor_action === mabResult.action
        );
        if (mabEntry && (!routePreference.candidates || routePreference.candidates.includes(mabResult.action as TutorAction)) && mabEntry.avg_reward !== null && (mabEntry.times_selected ?? 0) > 5) {
          action = mabResult.action as TutorAction;
        }
      }
    } catch (e) {
      console.warn('[MAB] Q-Table lookup failed, using rule-based action:', e);
    }
  }

  // --- Step 2.5: v21 CRITICAL-001 Fix — LinUCB override BEFORE response generation ---
  // LinUCB must select action BEFORE Step 5 so the response reflects LinUCB's choice.
  // Previously at Step 10 (post-response), which caused action-reward mismatch.
  let linucbArms: LinUCBArm[] = [];
  let linucbContext: LinUCBContext | undefined;
  let linucbUsed = false;
  let pendingLinucbInitialization: Array<{ arm: LinUCBArm; createdAt: number }> = [];
  if (db && turnNumber >= 2 && !input.learnerRevision) {
    try {
      // Build DA context early — we need previous DA tags for LinUCB context
      // Use lightweight extraction from conversation history
      const prevDATags = new Array(14).fill(0);
      // LinUCB context construction
      linucbContext = {
        daTags: prevDATags,
        thoughtProfile: [
          thoughtProfile.absolutistTendency,
          thoughtProfile.binaryThinking,
          thoughtProfile.definitionalVagueness,
          thoughtProfile.intuitionOverText,
        ],
        challengeLevel: challengeState.currentLevel / 5,
        eloNormalized: 0,
        // No attributable request/response denominator exists for this legacy ratio.
        revisionDebt: null,
        turnProgress: turnNumber / maxTurns,
      };

      // Load arms from D1
      const defaultActions = ['ask_evidence', 'ask_counterexample', 'ask_definition', 'ask_warrant', 'invite_revision'];
      try {
        const armsResult = await db.prepare(
          'SELECT action, a_matrix_json, b_vector_json, times_selected, total_reward FROM linucb_arms'
        ).all();
        if (armsResult.results && armsResult.results.length > 0) {
          const armRows = armsResult.results as Array<{
            action: string; a_matrix_json: string; b_vector_json: string;
            times_selected: number; total_reward: number;
          }>;
          linucbArms = armRows.map((r) => ({
            action: r.action,
            A: JSON.parse(r.a_matrix_json),
            b: JSON.parse(r.b_vector_json),
            timesSelected: r.times_selected || 0,
            totalReward: r.total_reward || 0,
          }));
        }
      } catch (e) { console.error('[P1-004] arm load:', e); }

      if (linucbArms.length === 0) {
        linucbArms = defaultActions.map(a => createLinUCBArm(a));
        // Initializing the in-memory arms is necessary to choose this turn's
        // action. Persist the exact arm payload only after critic acceptance.
        pendingLinucbInitialization = linucbArms.map((arm) => ({ arm, createdAt: Date.now() }));
      }

      // v21 CRITICAL-001: Select action via LinUCB BEFORE response generation
      // Only override if LinUCB has sufficient learning data (timesSelected > 10)
      const totalSelections = linucbArms.reduce((s, a) => s + a.timesSelected, 0);
      const eligibleArms = linucbArms.filter(arm => !routePreference.candidates || routePreference.candidates.includes(arm.action as TutorAction));
      if (totalSelections > 10 && eligibleArms.length > 0) {
        const linucbChoice = selectLinUCBAction(eligibleArms, linucbContext, 0.75);
        action = linucbChoice.action as TutorAction;
        linucbUsed = true;
        console.log(`[LINUCB v21] Step 2.5: selected=${action} ucb=${linucbChoice.ucb.toFixed(3)} (BEFORE response gen)`);
      } else {
        console.log(`[LINUCB v21] Step 2.5: insufficient data (${totalSelections} selections), using MAB/rule action=${action}`);
      }
    } catch (e) {
      console.warn('[LINUCB_STEP2.5] Non-critical:', e);
    }
  }

  // v18: Dialogue Act Tagging V2 (Mezza 2024 ArguNet + Illocutionary Force)
  let dialogueActResult: DialogueActResult | undefined;
  let dialogueActV2: DialogueActResultV2 | undefined;
  let pendingDialogueActEvent: { id: string; actCode: string; confidence: number; sourceText: string; contextJson: string; createdAt: number } | undefined;
  try {
    // v18: 컨텍스트 인식 DA V2 (ISO 24617-2 완전 태그셋 + ARC 분류)
    dialogueActV2 = classifyDialogueActV2RuleBased(
      studentMessage,
      conversationHistory.slice(-5).map(m => ({ role: m.role, content: m.content })),
      currentState,
      turnNumber,
      maxTurns,
    );
    // 하위 호환: 기존 DialogueActResult 형태로도 전달
    dialogueActResult = {
      act: dialogueActV2.legacyAct,
      confidence: dialogueActV2.confidence,
      rationale: `v18_iso:${dialogueActV2.act}_arc:${dialogueActV2.arcClassification?.relation || 'N/A'}`,
    };
    // Capture the same v18 event payload now, but do not write it until the
    // mentor/critic pipeline has accepted the response.
    if (dialogueActV2) pendingDialogueActEvent = {
      id: `da_${input.sessionId}_t${turnNumber}`,
      actCode: dialogueActV2.act,
      confidence: dialogueActV2.confidence,
      sourceText: studentMessage.substring(0, 200),
      contextJson: JSON.stringify({
        illocutionary: dialogueActV2.illocutionaryForce,
        arc: dialogueActV2.arcClassification,
        source: dialogueActV2.source,
      }),
      createdAt: Date.now(),
    };
    console.log(`[DA v18] Turn ${turnNumber}: ISO=${dialogueActV2.act} Legacy=${dialogueActV2.legacyAct} ARC=${dialogueActV2.arcClassification?.relation || 'N/A'} Illo=${dialogueActV2.illocutionaryForce.category}/${dialogueActV2.illocutionaryForce.strength}`);
  } catch (e) {
    console.warn('[DA_TAGGER_V2] Fallback to v16:', e);
    // v16 폴백
    try {
      dialogueActResult = fastRuleTag(
        studentMessage,
        conversationHistory.filter(m => m.role === 'user').map(m => m.content).slice(-3),
      );
    } catch (e) { console.error('[P1-004] skipped:', e); }
  }

  // v17 BUG-004 Fix: selectPressureMove() 실제 호출 및 결과를 프롬프트에 주입
  let pressureMove: PressureMove | undefined;
  let pressurePrompt = '';
  try {
    if (dialogueActResult) {
      // KG violations와 weak indicators 수집
      const topViolations: string[] = [];
      const weakIndicators: string[] = [];
      // Missing revision-demand evidence cannot become a debt or pressure signal.
      const revisionDebt = null;

      // evaluation 기반 weak indicator 추출
      if (evaluation.evidence_use < 2) { topViolations.push('evidence_grounding'); weakIndicators.push('dl_evidence_density'); }
      if (evaluation.claim_clarity < 2) { topViolations.push('warrant_explicitness'); weakIndicators.push('ls_claim_clarity'); }
      if (evaluation.reasoning_strength < 2) { topViolations.push('missing_premise'); weakIndicators.push('ls_premise_sufficiency'); }
      if (evaluation.consistency < 2) weakIndicators.push('cf_counterexample_acceptance');

      pressureMove = selectPressureMove({
        dialogueAct: dialogueActResult.act,
        topViolations,
        weakIndicators,
        revisionDebt,
      });

      pressurePrompt = `\n## Socratic Pressure\n- 선택된 압박 전략: ${pressureMove}\n- 적용 템플릿: ${PRESSURE_TEMPLATES[pressureMove]}\n`;
      console.log(`[PRESSURE v17] Turn ${turnNumber}: DA=${dialogueActResult.act} → Pressure=${pressureMove}`);
    }
  } catch (e) {
    console.warn('[PRESSURE] Non-critical:', e);
  }

  // v14.0 + v16.0: Update ThoughtProfile (regex + LLM 하이브리드)
  thoughtProfile = updateThoughtProfile(thoughtProfile, studentMessage, evaluation, turnNumber);

  // The optional thought-profile refinement is intentionally not invoked from
  // this fail-loud core. Its deterministic profile remains available without
  // sharing actor credentials with an unrelated positional-key call.

  // v14.0 + v16.0: Update ChallengeLevel (Flow Channel + Cognitive Load)
  challengeState = determineChallengeLevel(challengeState, evaluation, turnNumber, studentModel);

  // v14.0: Filter action by challenge level constraints
  action = filterActionByChallenge(action, challengeState.currentLevel);

  // Prevent same action repeat
  action = adjustForRepetition(action, studentModel.lastTutorAction, evaluation);

  // One explicit learner request outranks adaptive presentation choices. It is not a mastery signal.
  if (input.learnerRevision) {
    action = learnerRevisionAction(input.learnerRevision);
    pressurePrompt = '';
  }

  // --- Step 3: Calculate effective hint level ---
  const hintLevel = calculateEffectiveHintLevel(studentModel, turnNumber, priorAcceptedRevisionAttempts);

  // --- Step 4: Determine next state ---
  const newState = nextState({
    currentState,
    scores: {
      claim_clarity: evaluation.claim_clarity,
      evidence_use: evaluation.evidence_use,
      reasoning_strength: evaluation.reasoning_strength,
      consistency: evaluation.consistency,
      relevance: evaluation.relevance,
    },
    repeatedWeaknessCounts: studentModel.repeatedWeaknessCounts,
    // Legacy revisionCount does not participate in state progression.
    turnNumber,
    maxTurns,
  });

  // v14.0: Build intelligence layer prompt enrichments
  const thoughtInsight = formatThoughtProfileForPrompt(thoughtProfile);
  const challengeConstraint = getChallengeConstraints(challengeState.currentLevel);

  // --- Step 5: Generate tutor response via Mentor-Critic Pipeline (v10.0+) ---
  // Architecture: Mentor(생성) → Critic(검수) → [Pass/Reject] → Final Response
  // Phase 2 TDD: 정답 유출률 0%, Bloom's Taxonomy 준수
  // v17: pressurePrompt 주입으로 소크라틱 압박 반영
  let tutorResult: { aiReply: string; questionType: string };
  let criticVerdict: unknown = null;

  const mentorGenerate = () => generateTutorResponse(
    router,
    {
      currentState: newState,
      selectedAction: action,
      hintLevel,
      latestStudentAnswer: studentMessage,
      studentModel,
      bookTextSnippet: bookText + thoughtInsight + challengeConstraint + pressurePrompt,
      topic: studentModel.topic,
      sessionGoal: getSessionGoal(newState),
      learningRoute: input.learningRoute,
      learnerRevision: input.learnerRevision,
      caseDirective: input.caseDirective,
      casePromptVersion: input.casePromptVersion,
    },
  );

  const mcResult = await runMentorCriticPipeline(
    router,
    mentorGenerate,
    {
      currentState: newState,
      topic: studentModel.topic,
      studentMessage,
      selectedAction: action,
      hintLevel,
      learningOrderDirective: trainingRouteDirective(input.learningRoute) + learnerRevisionDirective(input.learnerRevision) + (input.caseDirective || ''),
      casePromptVersion: input.casePromptVersion,
    },
  );
  tutorResult = { aiReply: mcResult.finalResponse, questionType: mcResult.questionType };
  criticVerdict = mcResult.criticVerdict;
  if (mcResult.attempts > 1) {
    console.log(`[MENTOR-CRITIC] Regenerated (attempt=${mcResult.attempts}, leakage=${mcResult.criticVerdict.leakageScore})`);
  }

  // --- Step 6: Update student model ---
  const updatedModel = updateStudentModel(studentModel, evaluation, action, { reviewingLearnerRevision: Boolean(input.learnerRevision) });
  updatedModel.sessionGoal = getSessionGoal(newState);

  // Steps 7~10 are non-critical and must run only after the route has committed
  // the accepted turn. Returning the callback prevents orphan analytics/KT state
  // when canonical persistence rejects the turn.

  // Capture closures for side effects
  const sideEffectInputs = {
    db, sessionId: input.sessionId, turnNumber, userId,
    evaluation, studentMessage, tutorReply: tutorResult.aiReply,
    newState, dialogueActV2, dialogueActResult, pressureMove,
    thoughtProfile, challengeState, studentModel, conversationHistory,
    maxTurns, action, linucbArms, linucbContext, linucbUsed, pendingLinucbInitialization, pendingDialogueActEvent,
  };

  const runSideEffects = async () => {
    if (!db) return;
    let aifGraph: AIFGraph | undefined;
    let microScoreBatch: MicroScoreBatch | undefined;
    const se = sideEffectInputs;

    // These are the only instrumentation writes that used to precede critic
    // acceptance. Their data was captured above; persist it first so all later
    // orchestrator reads and writes retain native D1 ordering.
    try {
      if (se.pendingLinucbInitialization.length > 0) {
        const initStmts = se.pendingLinucbInitialization.map(({ arm, createdAt }) => db.prepare(
          `INSERT OR IGNORE INTO linucb_arms
           (id, action, a_matrix_json, b_vector_json, times_selected, total_reward, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        ).bind(
          `linucb_arm_${arm.action}`, arm.action,
          JSON.stringify(arm.A), JSON.stringify(arm.b),
          0, 0, createdAt,
        ));
        await batchExecuteSafe(db, initStmts);
      }
      if (se.pendingDialogueActEvent) {
        const event = se.pendingDialogueActEvent;
        await db.prepare(
          `INSERT OR IGNORE INTO dialogue_act_events (id, session_id, turn_number, utterance_role, act_code, confidence, source_text, context_json, created_at)
           VALUES (?1, ?2, ?3, 'student', ?4, ?5, ?6, ?7, ?8)`
        ).bind(event.id, se.sessionId, se.turnNumber, event.actCode, event.confidence, event.sourceText, event.contextJson, event.createdAt).run();
      }
    } catch (e) {
      console.warn('[POST_CRITIC_TELEMETRY] Non-critical:', e);
    }

    // Step 7a: AIF 추출 + 저장 (독립)
    try {
      const aifExtraction = extractAIFRuleBased(se.studentMessage, se.turnNumber, 'student');
      const tutorAif = extractAIFRuleBased(se.tutorReply, se.turnNumber, 'tutor');
      const mergedExtraction = {
        iNodes: [...aifExtraction.iNodes, ...tutorAif.iNodes],
        edges: [...aifExtraction.edges, ...tutorAif.edges],
      };
      const candidateGraph = buildAIFGraph(se.sessionId, se.turnNumber, mergedExtraction);
      await persistAIFToD1(db, se.sessionId, candidateGraph, input.argumentGraphScope);
      aifGraph = candidateGraph;
    } catch (e) {
      console.warn('[7a AIF_EXTRACT] Non-critical:', e);
    }

    // Step 7a-2: xAIF V2 Document
    // Training xAIF derivatives do not yet have Training-owned lifecycle and
    // deletion contracts. Keep them out of the shared Sparring snapshot store.
    if (aifGraph && input.argumentGraphScope !== 'training') {
      try {
        const daSummary: DialogueActSummary = se.dialogueActV2 ? {
          act: se.dialogueActV2.act,
          confidence: se.dialogueActV2.confidence,
          pressureMove: se.pressureMove || null,
          illocutionaryForce: se.dialogueActV2.illocutionaryForce,
          arcClassification: se.dialogueActV2.arcClassification,
        } : {
          act: se.dialogueActResult?.act || 'unknown',
          confidence: se.dialogueActResult?.confidence || 0,
          pressureMove: se.pressureMove || null,
        };
        const xaifDoc = buildXAIFDocument(
          se.sessionId, se.turnNumber,
          se.studentMessage, se.tutorReply,
          aifGraph, daSummary,
        );
        await persistXAIFDocument(db, se.sessionId, se.turnNumber, xaifDoc);
      } catch (e) {
        console.warn('[7a-2 xAIF_V2] Non-critical:', e);
      }
    }

    // Step 7b: KG 검증
    if (aifGraph) {
      try {
        const masteredConcepts = await buildMasteredConceptMap(db, se.userId || null);
        const bloomMap: Record<string, number> = {'elicitation':2,'grounding':3,'reasoning':4,'counterexample':5,'revision':6,'synthesis':6};
        const violations = verifyConstraints({
          studentConcepts: aifGraph.iNodes.filter(n => n.author === 'student').map(n => n.text.substring(0, 50)),
          claimedRelations: aifGraph.edges.map(e => `${e.from}→${e.to}:${e.relation}`),
          currentBloomLevel: bloomMap[se.newState] || 4,
          masteredConcepts,
          argumentGraph: aifGraph,
        });
        if (violations.length > 0) {
          console.log(`[7b KG] Violations: ${violations.map(v => v.rule).join(', ')}`);
        }
      } catch (e) {
        console.warn('[7b KG_VERIFY] Non-critical:', e);
      }
    }

    // Step 7c: FAF Legacy — v21: batch chunk
    if (input.argumentGraphScope !== 'training') try {
      const { nodes: argNodes } = extractArgumentNodes(
        se.sessionId, se.turnNumber, se.studentMessage, se.tutorReply, se.evaluation
      );
      const fafStmts = argNodes.map(node => db.prepare(
        `INSERT OR IGNORE INTO argument_nodes (session_id, turn_number, node_type, author, content, strength, depth, parent_node_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).bind(
        node.session_id, node.turn_number, node.node_type,
        node.author, node.content, node.strength, node.depth,
        node.parent_node_id || null, Date.now()
      ));
      await batchExecuteSafe(db, fafStmts);
    } catch (e) {
      console.warn('[7c FAF] Non-critical:', e);
    }

    // Step 7d: BKT — v21: batch chunk
    try {
      if (se.evaluation.weakness_tags && se.evaluation.weakness_tags.length > 0) {
        const existingBKT = await db.prepare(
          'SELECT concept, p_know, p_transit, p_slip, p_guess, observations FROM bkt_knowledge_states WHERE user_id IS ?1'
        ).bind(se.userId || null).all<BKTRow>();

        let studentElo = 1000;
        try {
          if (se.userId) {
            const growth = await db.prepare(
              'SELECT elo_evidence, elo_reasoning, elo_defense, elo_clarity, elo_consistency FROM student_growth_profile WHERE user_id = ?1'
            ).bind(se.userId).first<GrowthProfileRow>();
            if (growth) {
              studentElo = Math.round((
                (growth.elo_evidence || 1000) + (growth.elo_reasoning || 1000) +
                (growth.elo_defense || 1000) + (growth.elo_clarity || 1000) +
                (growth.elo_consistency || 1000)
              ) / 5);
            }
          }
        } catch (e) { console.error('[P1-004] default 1000:', e); }

        const { getEloInfusedBKTParams } = await import('../math/bkt-engine');
        const bktRows = (existingBKT.results || []);
        const bktUpdates = computeBKTUpdates(
          bktRows.map((r) => {
            const infused = getEloInfusedBKTParams(studentElo, r.concept, {
              concept: r.concept,
              p_know: r.p_know || 0.3,
              p_transit: r.p_transit || 0.1,
              p_slip: r.p_slip || 0.15,
              p_guess: r.p_guess || 0.25,
              observations: r.observations || 0,
            });
            return { ...r, p_know: r.p_know ?? 0.3, observations: r.observations ?? 0, p_transit: infused.p_transit, p_slip: infused.p_slip, p_guess: infused.p_guess };
          }),
          se.evaluation.weakness_tags as string[],
          {
            claim_clarity: se.evaluation.claim_clarity,
            evidence_use: se.evaluation.evidence_use,
            reasoning_strength: se.evaluation.reasoning_strength,
            consistency: se.evaluation.consistency,
            relevance: se.evaluation.relevance,
          },
        );

        // v21: Collect all BKT statements then batch execute
        const bktBatchStmts: D1PreparedStatement[] = [];
        for (const update of bktUpdates) {
          bktBatchStmts.push(db.prepare(
            `INSERT INTO bkt_knowledge_states (user_id, concept, p_know, observations, last_session_id, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?5)
             ON CONFLICT(user_id, concept) DO UPDATE SET
               p_know = ?3, observations = observations + 1, last_session_id = ?4, updated_at = ?5`
          ).bind(se.userId || null, update.concept, update.newPKnow, se.sessionId, Date.now()));
          if (se.userId) {
            bktBatchStmts.push(db.prepare(
              `INSERT INTO user_concept_mastery
               (user_id, concept_id, p_know, evidence_count, last_session_id, updated_at)
               VALUES (?1, ?2, ?3, 1, ?4, ?5)
               ON CONFLICT(user_id, concept_id) DO UPDATE SET
                 p_know = excluded.p_know, evidence_count = evidence_count + 1,
                 last_session_id = excluded.last_session_id, updated_at = excluded.updated_at`
            ).bind(se.userId, update.concept, update.newPKnow, se.sessionId, Date.now()));
          }
        }
        await batchExecuteSafe(db, bktBatchStmts);
      }
    } catch (e) {
      console.warn('[7d BKT] Non-critical:', e);
    }

    // Step 7e: MAB Q-Table 업데이트
    try {
      if (se.studentModel.lastTutorAction && se.conversationHistory.length >= 2) {
        const reward = computeReward(
          { claim_clarity: 3, evidence_use: 3, reasoning_strength: se.studentModel.reasoningStrength, consistency: 3, relevance: se.studentModel.relevanceLevel },
          { claim_clarity: se.evaluation.claim_clarity, evidence_use: se.evaluation.evidence_use, reasoning_strength: se.evaluation.reasoning_strength, consistency: se.evaluation.consistency, relevance: se.evaluation.relevance },
        );
        const currAvgScore = (se.evaluation.claim_clarity + se.evaluation.evidence_use +
          se.evaluation.reasoning_strength + se.evaluation.consistency + se.evaluation.relevance) / 5;
        const bucket = inferBucketFromScore(Math.round(currAvgScore * 20));
        await db.prepare(
          `UPDATE tutor_policy_q_table SET times_selected = times_selected + 1, total_reward = total_reward + ?3, avg_reward = (total_reward + ?3) / (times_selected + 1), last_used_at = ?4, updated_at = ?4 WHERE student_level_bucket = ?1 AND tutor_action = ?2`
        ).bind(bucket, se.studentModel.lastTutorAction, reward, Date.now()).run().catch(() => {});
      }
    } catch (e) {
      console.warn('[7e MAB] Non-critical:', e);
    }

    // Step 7f: Micro-Indicator Scoring
    try {
      microScoreBatch = computeMicroScores({
        evaluation: se.evaluation,
        dialogueAct: se.dialogueActResult,
        aifGraph,
        thoughtProfile: se.thoughtProfile,
        studentMessage: se.studentMessage,
        turnNumber: se.turnNumber,
        conversationHistory: se.conversationHistory,
        challengeLevel: se.challengeState.currentLevel,
      });
      await persistMicroScores(db, se.sessionId, se.turnNumber, microScoreBatch);
      console.log(`[7f MICRO v21] Turn ${se.turnNumber}: overall=${(microScoreBatch.overallScore * 100).toFixed(0)}%`);
    } catch (e) {
      console.warn('[7f MICRO_SCORE] Non-critical:', e);
    }

    // Step 7g: Process Evaluation Turn Snapshot
    if (microScoreBatch) {
      try {
        const isRevision = se.dialogueActV2?.act === 'claim_revision' ||
          se.dialogueActV2?.act === 'self_correction' ||
          se.dialogueActResult?.act === 'revision';
        const turnSnapshot: TurnSnapshot = {
          turnNumber: se.turnNumber,
          microScores: {
            axisSummary: microScoreBatch.axisSummary,
            overallScore: microScoreBatch.overallScore,
            scores: microScoreBatch.scores.map(s => ({ indicatorId: s.indicatorId, normalizedScore: s.normalizedScore })),
          },
          daAct: se.dialogueActV2?.act || se.dialogueActResult?.act || 'unknown',
          illocutionaryStrength: se.dialogueActV2?.illocutionaryForce?.strength || 0,
          state: se.newState,
          pressureMove: se.pressureMove || null,
          revisionOccurred: isRevision || false,
        };
        await persistTurnSnapshot(db, se.sessionId, turnSnapshot);
      } catch (e) {
        console.warn('[7g PROCESS_SNAP] Non-critical:', e);
      }
    }

    // Step 8: Session-end Process Evaluation
    if (se.newState === 'synthesis' || se.turnNumber >= se.maxTurns - 1) {
      try {
        const allSnapshots = await db.prepare(
          'SELECT * FROM session_process_snapshots WHERE session_id = ?1 ORDER BY turn_number'
        ).bind(se.sessionId).all<ProcessSnapshotRow>();

        const trajectory: TurnSnapshot[] = (allSnapshots.results || []).map((row: ProcessSnapshotRow) => ({
          turnNumber: row.turn_number,
          microScores: {
            axisSummary: {
              logical: row.logical_score,
              data: row.data_score,
              flexibility: row.flexibility_score,
              communication: row.communication_score,
            },
            overallScore: row.overall_score,
            scores: [],
          },
          daAct: row.da_act,
          illocutionaryStrength: row.illocutionary_strength,
          state: row.state,
          pressureMove: row.pressure_move,
          revisionOccurred: row.revision_occurred === null ? null : row.revision_occurred === 1,
        }));

        const processMetrics = computeProcessMetrics(trajectory);
        await persistProcessEvaluation(db, se.sessionId, se.userId || null, processMetrics, trajectory);
        console.log(`[PROCESS v21] Session ${se.sessionId} FINAL: processScore=${processMetrics.processScore}`);
      } catch (e) {
        console.warn('[8 PROCESS_FINAL] Non-critical:', e);
      }
    }

    // Step 9: Hybrid KT ensemble update
    if (se.evaluation.weakness_tags && se.evaluation.weakness_tags.length > 0) {
      try {
        let studentElo = 1000;
        try {
          if (se.userId) {
            const growth = await db.prepare(
              'SELECT elo_evidence, elo_reasoning, elo_defense, elo_clarity, elo_consistency FROM student_growth_profile WHERE user_id = ?1'
            ).bind(se.userId).first<GrowthProfileRow>();
            if (growth) {
              studentElo = Math.round((
                (growth.elo_evidence || 1000) + (growth.elo_reasoning || 1000) +
                (growth.elo_defense || 1000) + (growth.elo_clarity || 1000) +
                (growth.elo_consistency || 1000)
              ) / 5);
            }
          }
        } catch (e) { console.error('[P1-004] default 1000:', e); }

        for (const concept of se.evaluation.weakness_tags as string[]) {
          const existing = await db.prepare(
            'SELECT p_know, p_transit, p_slip, p_guess FROM bkt_knowledge_states WHERE user_id IS ?1 AND concept = ?2'
          ).bind(se.userId || null, concept).first<BKTRow>();

          if (existing) {
            const correct = se.evaluation.reasoning_strength >= 3;
            const interactionRows = await db.prepare(
              `SELECT correct, difficulty FROM interaction_history
               WHERE user_id IS ?1 AND concept = ?2 ORDER BY created_at DESC LIMIT 30`
            ).bind(se.userId || null, concept).all<InteractionRow>();

            const interactionHistory = ((interactionRows.results || [])).map((row) => ({
              correct: !!row.correct,
              difficulty: Number(row.difficulty || 0.5),
            })).reverse();

            const hybridResult = computeHybridKT(
              concept,
              { p_know: existing.p_know || 0.3, p_transit: existing.p_transit || 0.1, p_slip: existing.p_slip || 0.15, p_guess: existing.p_guess || 0.25 },
              interactionHistory, studentElo, correct,
            );

            await db.prepare(
              `INSERT INTO interaction_history
               (id, user_id, concept, correct, difficulty, session_id, turn_number, hybrid_kt_json, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
            ).bind(
              `ih_${se.sessionId}_${concept}_${se.turnNumber}`,
              se.userId || null, concept,
              correct ? 1 : 0,
              Math.max(0.1, 1 - (se.evaluation.reasoning_strength / 5)),
              se.sessionId, se.turnNumber,
              JSON.stringify(hybridResult), Date.now(),
            ).run().catch((err) => console.warn('[IH_INSERT]', err));

            await db.prepare(
              'UPDATE bkt_knowledge_states SET p_know = ?1, updated_at = ?2 WHERE user_id IS ?3 AND concept = ?4'
            ).bind(hybridResult.ensembledPKnow, Date.now(), se.userId || null, concept).run().catch(() => {});

            console.log(`[HYBRID_KT v21] ${concept}: bkt=${hybridResult.bktPKnow} dkt=${hybridResult.dktPKnow} ensemble=${hybridResult.ensembledPKnow} history=${interactionHistory.length}`);
          }
        }
      } catch (e) {
        console.warn('[9 HYBRID_KT] Non-critical:', e);
      }
    }

    // Step 10: v21 CRITICAL-001 Fix — LinUCB arm UPDATE only (selection already done in Step 2.5)
    // Now we update with correct action-reward pairing since the action was used in Step 5.
    try {
      if (se.turnNumber >= 2 && se.linucbContext && se.linucbArms.length > 0) {
        // Update DA tags in context with actual V2 tags if available
        if (se.dialogueActV2?.contextVector?.prevDATags) {
          se.linucbContext.daTags = se.dialogueActV2.contextVector.prevDATags;
        }

        const reward = microScoreBatch
          ? microScoreBatch.overallScore
          : (se.evaluation.reasoning_strength + se.evaluation.evidence_use) / 10;

        // v21: Update the arm that was ACTUALLY used for response generation (correct action-reward pair)
        const selectedArm = se.linucbArms.find((a) => a.action === se.action);
        if (selectedArm) {
          const updatedArm = updateLinUCBArm(selectedArm, se.linucbContext, reward);
          await db.prepare(
            `INSERT OR REPLACE INTO linucb_arms
             (id, action, a_matrix_json, b_vector_json, times_selected, total_reward, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
          ).bind(
            `linucb_arm_${updatedArm.action}`, updatedArm.action,
            JSON.stringify(updatedArm.A), JSON.stringify(updatedArm.b),
            updatedArm.timesSelected, updatedArm.totalReward, Date.now(),
          ).run().catch(() => {});
        }

        // Experiment log — correct engine attribution
        await db.prepare(
          `INSERT OR IGNORE INTO linucb_experiment_log
           (id, session_id, turn_number, engine, action, reward, context_json, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        ).bind(
          `linucb_exp_${se.sessionId}_t${se.turnNumber}`,
          se.sessionId, se.turnNumber,
          se.linucbUsed ? 'linucb' : 'mab_legacy',
          se.action, reward,
          JSON.stringify(se.linucbContext), Date.now(),
        ).run().catch(() => {});

        console.log(`[LINUCB v21] Step 10: arm update for action=${se.action} reward=${reward.toFixed(3)} engine=${se.linucbUsed ? 'linucb' : 'mab_legacy'}`);
      }
    } catch (e) {
      console.warn('[10 LINUCB_UPDATE] Non-critical:', e);
    }
  };

  // v14.0: Log intelligence layer state
  console.log(`[INTEL v14] Turn ${turnNumber}: thought=[abs=${(thoughtProfile.absolutistTendency*100).toFixed(0)}%,bin=${(thoughtProfile.binaryThinking*100).toFixed(0)}%,vag=${(thoughtProfile.definitionalVagueness*100).toFixed(0)}%,int=${(thoughtProfile.intuitionOverText*100).toFixed(0)}%] challenge=L${challengeState.currentLevel}`);

  return {
    state: newState,
    action,
    hintLevel,
    evaluation,
    studentModel: updatedModel,
    tutorResponse: tutorResult.aiReply,
    questionType: tutorResult.questionType,
    aiRouting: {
      learnerEvaluation: evaluated.routeMetadata,
      interactiveGeneration: mcResult.actorRoute,
      releaseCritic: mcResult.criticRoute,
    },
    // v14.0: Intelligence layer results
    thoughtProfile,
    challengeState,
    runAcceptedSideEffects: runSideEffects,
  };
}

// =============================================
// D1 Row Type Interfaces (v21: as any 제거용)
// =============================================
interface GrowthProfileRow {
  elo_evidence: number;
  elo_reasoning: number;
  elo_defense: number;
  elo_clarity: number;
  elo_consistency: number;
}

interface BKTRow {
  concept: string;
  p_know: number | null;
  p_transit: number | null;
  p_slip: number | null;
  p_guess: number | null;
  observations: number | null;
}

interface InteractionRow {
  correct: number;
  difficulty: number;
}

interface ProcessSnapshotRow {
  turn_number: number;
  logical_score: number;
  data_score: number;
  flexibility_score: number;
  communication_score: number;
  overall_score: number;
  da_act: string | null;
  illocutionary_strength: number | null;
  state: TutorState | null;
  pressure_move: string | null;
  revision_occurred: number | null;
}

// =============================================
// Step 1: Evaluate Student (GPT-5 Nano)
// =============================================
async function evaluateStudent(
  router: AIRouter,
  input: {
    sessionGoal: string;
    currentState: TutorState;
    topic: string;
    latestStudentAnswer: string;
    previousStudentAnswer: string;
    studentModel: Partial<StudentModel>;
    bookTextSnippet: string;
    conversationHistory: string;
    evidenceSourceIds: string[];
    caseDirective?: string | null;
    casePromptVersion?: TrainingCasePromptVersion | null;
  },
): Promise<{ evaluation: DeepEvaluation; routeMetadata: AIRouteMetadata }> {
  try {
    const routed = await router.completeValidatedJSON('learner_evaluation', {
      systemPrompt: getEvaluatorSystemPrompt(),
      userPrompt: buildEvaluatorUserPrompt(input),
      temperature: 0.3,
      maxTokens: 800,
      promptSchemaVersion: 'tutoring-evaluator-schema-v1',
      promptVersion: input.casePromptVersion ? `tutoring-evaluator-case-v2-${input.casePromptVersion}` : input.caseDirective ? 'tutoring-evaluator-case-v2' : 'tutoring-evaluator-v1',
    }, (value) => validateEvaluatorPayload(value, input.evidenceSourceIds));
    recordRoutedAIUsage(routed, 'evaluate');
    return {
      routeMetadata: routed.metadata,
      evaluation: routed.value,
    };
  } catch (error) {
    console.error('Evaluation failed:', error);
    if (error instanceof EvaluatorUnavailableError) throw error;
    if (error instanceof AIRouteUnavailableError) {
      throw new EvaluatorUnavailableError(error.failureClass, error.retryable);
    }
    throw new EvaluatorUnavailableError('invalid_response', true);
  }
}

// =============================================
// Step 5: Generate Tutor Response (GPT-5 Nano)
// =============================================
async function generateTutorResponse(
  router: AIRouter,
  input: {
    currentState: TutorState;
    selectedAction: TutorAction;
    hintLevel: HintLadderLevel;
    latestStudentAnswer: string;
    studentModel: Partial<StudentModel>;
    bookTextSnippet: string;
    topic: string;
    sessionGoal: string;
    learningRoute?: TrainingRouteDecision | null;
    learnerRevision?: LearnerRevisionPrompt | null;
    caseDirective?: string | null;
    casePromptVersion?: TrainingCasePromptVersion | null;
  },
): Promise<{ aiReply: string; questionType: string; routeMetadata: AIRouteMetadata }> {
  try {
    const routed = await router.completeValidatedJSON('interactive_generation', {
      systemPrompt: getActorSystemPrompt(),
      userPrompt: buildActorUserPrompt(input) + trainingRouteDirective(input.learningRoute) + learnerRevisionDirective(input.learnerRevision),
      temperature: 0.7,
      maxTokens: 500,
      promptSchemaVersion: 'tutoring-actor-schema-v1',
      promptVersion: input.casePromptVersion ? (input.learnerRevision ? `tutoring-actor-case-revision-v2-${input.casePromptVersion}` : `tutoring-actor-case-v2-${input.casePromptVersion}`) : input.caseDirective ? (input.learnerRevision ? 'tutoring-actor-case-revision-v2' : 'tutoring-actor-case-v2') : input.learnerRevision ? 'tutoring-actor-revision-v1' : input.learningRoute ? 'tutoring-actor-route-v2' : 'tutoring-actor-v1',
    }, validateTutorActorPayload);
    recordRoutedAIUsage(routed, 'mentor');

    return {
      aiReply: routed.value.aiReply,
      questionType: routed.value.questionType,
      routeMetadata: routed.metadata,
    };
  } catch (error) {
    console.error('Tutor response generation failed; response remains withheld:', error);
    if (error instanceof TutorGenerationUnavailableError) throw error;
    if (error instanceof AIRouteUnavailableError) {
      throw new TutorGenerationUnavailableError(error.failureClass, error.retryable);
    }
    throw new TutorGenerationUnavailableError('invalid_response', true);
  }
}

// =============================================
// Helpers
// =============================================
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type TutorActorPayload = { aiReply: string; questionType: string };

function validateTutorActorPayload(value: unknown): TutorActorPayload | null {
  if (!isPlainObject(value)) return null;
  const aiReply = value.aiReply;
  const questionType = value.questionType;
  return typeof aiReply === 'string' && aiReply.trim().length > 0
    && typeof questionType === 'string' && questionType.trim().length > 0
    ? { aiReply, questionType }
    : null;
}

const EVALUATOR_OUTPUT_KEYS = [
  'claim_clarity',
  'evidence_use',
  'reasoning_strength',
  'consistency',
  'relevance',
  'next_action',
  'hint_level',
  'weakness_tags',
  'diagnosis',
  'claim',
  'evidence_source_ids',
  'evidence_detected',
  'reasoning_gap',
  'student_implicit_assumptions',
  'alternative_interpretations',
  'reasoning_chain_weakest_link',
  'cognitive_level',
  'misconceptions',
  'student_growth_since_last_turn',
] as const;

function hasExactEvaluatorKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === EVALUATOR_OUTPUT_KEYS.length
    && EVALUATOR_OUTPUT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validateEvaluatorPayload(
  value: unknown,
  allowedSourceIds: readonly string[],
): DeepEvaluation | null {
  if (!isPlainObject(value) || !hasExactEvaluatorKeys(value)) return null;
  const claimClarity = value.claim_clarity;
  const evidenceUse = value.evidence_use;
  const reasoningStrength = value.reasoning_strength;
  const consistency = value.consistency;
  const relevance = value.relevance;
  const nextAction = value.next_action;
  const hintLevel = value.hint_level;
  const weaknessTags = value.weakness_tags;
  const diagnosis = value.diagnosis;
  const claim = value.claim;
  const evidenceSourceIds = value.evidence_source_ids;
  const evidenceDetected = value.evidence_detected;
  const reasoningGap = value.reasoning_gap;
  const implicitAssumptions = value.student_implicit_assumptions;
  const alternativeInterpretations = value.alternative_interpretations;
  const weakestLink = value.reasoning_chain_weakest_link;
  const cognitiveLevel = value.cognitive_level;
  const misconceptions = value.misconceptions;
  const studentGrowth = value.student_growth_since_last_turn;
  const allowedEvidenceSourceIds = new Set(allowedSourceIds);

  if (
    !isRubricScore(claimClarity)
    || !isRubricScore(evidenceUse)
    || !isRubricScore(reasoningStrength)
    || !isRubricScore(consistency)
    || !isRubricScore(relevance)
    || !isTutorAction(nextAction)
    || !isHintLevel(hintLevel)
    || !isWeaknessTagArray(weaknessTags)
    || typeof diagnosis !== 'string'
    || typeof claim !== 'string'
    || !isStringArray(evidenceSourceIds)
    || !isStringArray(evidenceDetected)
    || typeof reasoningGap !== 'string'
    || !isStringArray(implicitAssumptions)
    || !isStringArray(alternativeInterpretations)
    || typeof weakestLink !== 'string'
    || !isCognitiveLevel(cognitiveLevel)
    || !isStringArray(misconceptions)
    || !isStudentGrowth(studentGrowth)
    || !evidenceSourceIds.every((sourceId) => allowedEvidenceSourceIds.has(sourceId))
  ) return null;

  return {
    claim_clarity: claimClarity,
    evidence_use: evidenceUse,
    reasoning_strength: reasoningStrength,
    consistency,
    relevance,
    next_action: nextAction,
    hint_level: hintLevel,
    weakness_tags: weaknessTags,
    diagnosis,
    claim,
    evidence_source_ids: evidenceSourceIds,
    evidence_detected: evidenceDetected,
    reasoning_gap: reasoningGap,
    student_implicit_assumptions: implicitAssumptions,
    alternative_interpretations: alternativeInterpretations,
    reasoning_chain_weakest_link: weakestLink,
    cognitive_level: cognitiveLevel,
    misconceptions,
    student_growth_since_last_turn: studentGrowth,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function isRubricScore(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 1
    && value <= 5;
}

const WEAKNESS_TAGS: readonly WeaknessTag[] = [
  '근거 부족', '추상어 과다', '결론만 제시', '추론 비약',
  '텍스트 미참조', '모순 발생', '질문 이탈', '반례 미고려',
];

function isWeaknessTagArray(value: unknown): value is WeaknessTag[] {
  return Array.isArray(value)
    && value.every((item): item is WeaknessTag => (
      typeof item === 'string' && WEAKNESS_TAGS.includes(item as WeaknessTag)
    ));
}

const TUTOR_ACTIONS: readonly TutorAction[] = [
  'ask_evidence', 'ask_reasoning', 'ask_clarification', 'ask_counterexample',
  'narrow_scope', 'give_hint', 'request_text_reference', 'ask_revision', 'move_to_synthesis',
];

function isTutorAction(value: unknown): value is TutorAction {
  return typeof value === 'string' && TUTOR_ACTIONS.includes(value as TutorAction);
}

function isHintLevel(value: unknown): value is HintLadderLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5;
}

const COGNITIVE_LEVELS = [
  'recall', 'comprehension', 'application', 'analysis', 'synthesis', 'evaluation',
] as const;

function isCognitiveLevel(value: unknown): value is NonNullable<DeepEvaluation['cognitive_level']> {
  return typeof value === 'string'
    && (COGNITIVE_LEVELS as readonly string[]).includes(value);
}

const STUDENT_GROWTH_VALUES = ['regressed', 'stagnant', 'marginal', 'significant'] as const;

function isStudentGrowth(value: unknown): value is NonNullable<DeepEvaluation['student_growth_since_last_turn']> {
  return typeof value === 'string'
    && (STUDENT_GROWTH_VALUES as readonly string[]).includes(value);
}

function getPreviousStudentAnswer(
  history: { role: string; content: string }[],
): string {
  const studentMsgs = history.filter(m => m.role === 'user');
  if (studentMsgs.length < 2) return '';
  return studentMsgs[studentMsgs.length - 2]?.content || '';
}

function formatRecentHistory(
  history: { role: string; content: string }[],
  maxEntries: number,
): string {
  return history
    .slice(-maxEntries)
    .map(m => `${m.role === 'user' ? '학생' : 'AI'}: ${m.content}`)
    .join('\n');
}

// Re-export for convenience
export { createStudentModel, serializeStudentModel, deserializeStudentModel } from './student-model-engine';
export { nextState, getSessionGoal, tutorStateToPhase, shouldEndSession } from './state-machine';
export { getActionDescription } from './action-selector';
export { getHintPolicy, buildHintPrompt, calculateEffectiveHintLevel } from './hint-ladder';
