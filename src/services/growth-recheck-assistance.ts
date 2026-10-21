import { ASSISTANCE_CAPTURE_POLICY_REVISION, SPARRING_ASSISTANCE_CAPTURE_POLICY_REVISION, SPARRING_ASSISTANCE_RECORD_REVISION, SPARRING_ASSISTANCE_TOTALS_REVISION } from './growth-follow-up-protocol';
import {captureSparringRecordIndex,resolveSparringRecordIndex} from './growth-sparring-records';
import { loadOwnedSparringContext } from './learning-session-context';
import { GrowthServiceError, type GrowthAssistanceSummary, type GrowthSparringAssistanceTotals, type GrowthOriginKind, type GrowthRecheckAssistanceProjection } from './growth-cycle-types';
import { sha256Hex } from './library-ingestion';

type StoredValue = string | number | null;
type StoredRow = Record<string, StoredValue>;
export type SparringAssistanceBinding = {launchId:string;recheckId:string;baselineContextId:string;followUpContextId:string;
  completedMessageId:number;completedEvaluationId:number|null};
type SparringAssistanceReadContext = SparringAssistanceBinding & {db:D1Database;owner:string;recordRevision:string|null|undefined};

/** Historical capture policy retains totals, even when the source session has newer records. */
export async function captureSparringRecheckAssistance(db: D1Database, input: {
  owner: string; baselineSessionId: string; baselineContextId: string;
  followUpSessionId: string; followUpContextId: string;
  recordRevision?:string|null; binding?:SparringAssistanceBinding;
}) {
  const episode = async (sessionId: string, contextId: string) => {
    const context = await loadOwnedSparringContext(db,sessionId,input.owner);
    const row = await db.prepare(`SELECT ended_at, hint_request_count, hint_level,
      (SELECT COUNT(DISTINCT turn) FROM messages WHERE session_id=s.id AND role='user' AND turn>=1) AS accepted_turns,
      (SELECT COUNT(DISTINCT turn) FROM evaluations WHERE session_id=s.id AND user_id=?2) AS evaluated_turns
      FROM sessions s WHERE id=?1 AND user_id=?2 AND is_completed=1`)
      .bind(sessionId,input.owner).first<{ended_at:number|null;hint_request_count:number;hint_level:number;accepted_turns:number;evaluated_turns:number}>();
    if (!row || context.id!==contextId || row.accepted_turns<1
      || [row.accepted_turns,row.evaluated_turns,row.hint_request_count,row.hint_level].some(value=>!Number.isSafeInteger(value)||value<0)) {
      throw new GrowthServiceError({status:422,code:'GROWTH_RECHECK_ASSISTANCE_UNAVAILABLE',phase:'evidence'});
    }
    return {kind:'SPARRING_SESSION_TOTALS_V1',sessionId,contextId,completedAt:row.ended_at,
      acceptedTurns:row.accepted_turns,evaluatedTurns:row.evaluated_turns,hintRequests:row.hint_request_count,
      hintLevelAtCompletion:row.hint_level,openingManifestSha256:context.corpus.manifestRevision,
      deliveredHints:'NOT_RECORDED',controls:'NOT_RECORDED'};
  };
  const [baseline,followUp]=await Promise.all([episode(input.baselineSessionId,input.baselineContextId),episode(input.followUpSessionId,input.followUpContextId)]);
  if(input.recordRevision!=null && input.recordRevision!==SPARRING_ASSISTANCE_TOTALS_REVISION) {
    if(input.recordRevision!==SPARRING_ASSISTANCE_RECORD_REVISION||!input.binding
      ||input.binding.baselineContextId!==baseline.contextId||input.binding.followUpContextId!==followUp.contextId)
      throw new GrowthServiceError({status:422,code:'GROWTH_RECHECK_ASSISTANCE_UNAVAILABLE',phase:'evidence'});
    const [baselineIndex,followUpIndex]=await Promise.all([
      captureSparringRecordIndex(db,input.owner,baseline.sessionId,baseline.contextId),
      captureSparringRecordIndex(db,input.owner,followUp.sessionId,followUp.contextId),
    ]);
    const logJson=JSON.stringify({binding:input.binding,baseline:{...baseline,index:baselineIndex},followUp:{...followUp,index:followUpIndex}});
    return {capturePolicyRevision:SPARRING_ASSISTANCE_CAPTURE_POLICY_REVISION,recordRevision:SPARRING_ASSISTANCE_RECORD_REVISION,
      coverage:'LOCAL_RECORDED_ONLY',externalAssistance:'UNKNOWN',deliveryValidation:'UNKNOWN',protocolValidation:'UNKNOWN',logJson,logSha256:await sha256Hex(logJson)};
  }
  const logJson=JSON.stringify({baseline,followUp});
  return {capturePolicyRevision:SPARRING_ASSISTANCE_CAPTURE_POLICY_REVISION,coverage:'LOCAL_RECORDED_ONLY',
    externalAssistance:'UNKNOWN',deliveryValidation:'UNKNOWN',protocolValidation:'UNKNOWN',logJson,logSha256:await sha256Hex(logJson)};
}

async function trainingLog(db: D1Database, owner: string, sessionId: string, contextId: string) {
  const session = await db.prepare(`SELECT s.completed_at FROM training_sessions s
    JOIN training_session_contexts c ON c.session_id=s.id AND c.owner_user_id=s.user_id
    WHERE s.id=?1 AND s.user_id=?2 AND c.id=?3 AND s.is_completed=1 AND s.training_mode='scenario'`)
    .bind(sessionId, owner, contextId).first<{ completed_at: number | null }>();
  if (!session) throw new GrowthServiceError({ status: 422, code: 'GROWTH_RECHECK_ASSISTANCE_UNAVAILABLE', phase: 'evidence' });

  const [turns, interventions, routes, revisions] = await Promise.all([
    db.prepare(`SELECT id, turn_number, student_message, ai_response, tutor_action_type, hint_level,
      intervention_revision, learning_route_decision_id, learner_revision_event_id, created_at
      FROM training_turns WHERE session_id=?1 ORDER BY turn_number, id`).bind(sessionId).all<StoredRow>(),
    db.prepare(`SELECT e.id, e.revision, e.action, e.reason, e.origin, e.prior_turn_id, e.created_at,
      r.response, r.source_ids_json, r.diagnosis_snapshot, r.routing_json,
      r.policy_revision AS support_policy_revision, r.created_at AS support_created_at
      FROM training_interventions e LEFT JOIN training_support_responses r
      ON r.intervention_id=e.id AND r.session_id=e.session_id
      WHERE e.session_id=?1 AND e.owner_user_id=?2 ORDER BY e.revision, e.id`).bind(sessionId, owner).all<StoredRow>(),
    db.prepare(`SELECT id, decision_revision, selected_route, effective_from_turn, created_at
      FROM training_route_decisions WHERE session_id=?1 AND owner_user_id=?2
      ORDER BY decision_revision, id`).bind(sessionId, owner).all<StoredRow>(),
    db.prepare(`SELECT id, revision_number, prior_turn_id, prior_statement, revised_statement,
      explanation, source_ids_json, validation_status, policy_revision, created_at
      FROM training_learner_revision_events WHERE session_id=?1 AND owner_user_id=?2
      ORDER BY revision_number, id`).bind(sessionId, owner).all<StoredRow>(),
  ]);
  if ([turns, interventions, routes, revisions].some(result => !result.success || !Array.isArray(result.results))) {
    throw new GrowthServiceError({ status: 503, code: 'GROWTH_RECHECK_ASSISTANCE_UNAVAILABLE', phase: 'unavailable', retryable: true });
  }
  if (!(turns.results?.length)) throw new GrowthServiceError({ status: 422, code: 'GROWTH_RECHECK_ASSISTANCE_UNAVAILABLE', phase: 'evidence' });
  return { sessionId, contextId, completedAt: session.completed_at, turns: turns.results,
    interventions: interventions.results ?? [], routes: routes.results ?? [], revisions: revisions.results ?? [] };
}

/** Capture persisted local assistance, not verified delivery or a validated study protocol. */
export async function captureRecheckAssistance(db: D1Database, input: {
  owner: string; baselineSessionId: string; baselineContextId: string;
  followUpSessionId: string; followUpContextId: string;
}) {
  const [baseline, followUp] = await Promise.all([
    trainingLog(db, input.owner, input.baselineSessionId, input.baselineContextId),
    trainingLog(db, input.owner, input.followUpSessionId, input.followUpContextId),
  ]);
  // Retain these exact UTF-8 JSON bytes so the digest survives enclosing JSON key sorting.
  const logJson = JSON.stringify({ baseline, followUp });
  return { capturePolicyRevision: ASSISTANCE_CAPTURE_POLICY_REVISION, coverage: 'LOCAL_RECORDED_ONLY',
    externalAssistance: 'UNKNOWN', deliveryValidation: 'UNKNOWN', protocolValidation: 'UNKNOWN',
    logJson, logSha256: await sha256Hex(logJson) } as const;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function summarizeEpisode(value: unknown, sessionId: string): GrowthAssistanceSummary | null {
  const episode = object(value);
  if (!episode || episode.sessionId !== sessionId || !Array.isArray(episode.turns) || !episode.turns.length
    || !Array.isArray(episode.interventions)) return null;
  const turns = episode.turns.map(object), interventions = episode.interventions.map(object);
  if (turns.some(turn => !turn || !Number.isSafeInteger(turn.hint_level) || Number(turn.hint_level) < 0 || Number(turn.hint_level) > 5)
    || interventions.some(event => !event || !['HELP', 'PAUSE', 'RESUME', 'STOP'].includes(String(event.action))
      || (event.response !== null && (typeof event.response !== 'string' || !event.response.trim())))) return null;
  return { acceptedTurns: turns.length,
    supportRequested: interventions.filter(event => event?.action === 'HELP').length,
    supportRecorded: interventions.filter(event => event?.action === 'HELP' && typeof event.response === 'string').length,
    pauses: interventions.filter(event => event?.action === 'PAUSE').length,
    turnsWithHints: turns.filter(turn => Number(turn?.hint_level) > 0).length };
}

function summarizeSparringTotals(value: unknown, sessionId: string): GrowthSparringAssistanceTotals | null {
  const episode = object(value);
  if (!episode || episode.kind !== 'SPARRING_SESSION_TOTALS_V1' || episode.sessionId !== sessionId
    || typeof episode.contextId !== 'string' || !episode.contextId.trim()
    || (episode.completedAt !== null && (!Number.isSafeInteger(episode.completedAt) || Number(episode.completedAt) < 0))
    || typeof episode.openingManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(episode.openingManifestSha256)
    || ['acceptedTurns','evaluatedTurns','hintRequests','hintLevelAtCompletion'].some(key => !Number.isSafeInteger(episode[key]) || Number(episode[key]) < 0)
    || Number(episode.acceptedTurns) < 1 || Number(episode.hintLevelAtCompletion) > 5
    || episode.deliveredHints !== 'NOT_RECORDED' || episode.controls !== 'NOT_RECORDED') return null;
  return { sessionId, contextId: episode.contextId, completedAt: episode.completedAt as number | null,
    acceptedTurns: Number(episode.acceptedTurns), evaluatedTurns: Number(episode.evaluatedTurns),
    hintRequests: Number(episode.hintRequests), hintLevelAtCompletion: Number(episode.hintLevelAtCompletion),
    deliveredHints: 'NOT_RECORDED', controls: 'NOT_RECORDED' };
}

/** Owner-scoped callers receive the recorded format. Absent or damaged captures never mean no help. */
export async function projectRecheckAssistance(rawSignal: string | null, baselineSessionId: string,
  followUpSessionId: string | null, originKind: GrowthOriginKind = 'TRAINING', readContext?:SparringAssistanceReadContext): Promise<GrowthRecheckAssistanceProjection> {
  if (rawSignal === null) return { status: 'NOT_RECORDED' };
  const unavailable = { status: 'UNAVAILABLE' } as const;
  try {
    const signal = object(JSON.parse(rawSignal));
    const payload = object(signal?.storedSourcePayload);
    if (!signal || !payload) return unavailable;
    if (payload.assistance === undefined) return { status: 'NOT_RECORDED' };
    const assistance = object(payload.assistance);
    const policy = originKind === 'SPARRING' ? SPARRING_ASSISTANCE_CAPTURE_POLICY_REVISION : ASSISTANCE_CAPTURE_POLICY_REVISION;
    if (!assistance || assistance.capturePolicyRevision !== policy
      || assistance.coverage !== 'LOCAL_RECORDED_ONLY' || assistance.externalAssistance !== 'UNKNOWN'
      || assistance.deliveryValidation !== 'UNKNOWN' || assistance.protocolValidation !== 'UNKNOWN'
      || typeof assistance.logJson !== 'string' || typeof assistance.logSha256 !== 'string'
      || await sha256Hex(assistance.logJson) !== assistance.logSha256 || !followUpSessionId) return unavailable;
    const log = object(JSON.parse(assistance.logJson));
    if (originKind === 'SPARRING') {
      if(readContext?.recordRevision===SPARRING_ASSISTANCE_RECORD_REVISION&&assistance.recordRevision!==SPARRING_ASSISTANCE_RECORD_REVISION) return unavailable;
      const baseline = summarizeSparringTotals(log?.baseline, baselineSessionId);
      const followUp = summarizeSparringTotals(log?.followUp, followUpSessionId);
      if (!baseline || !followUp || baseline.sessionId === followUp.sessionId || baseline.contextId === followUp.contextId) return unavailable;
      if(assistance.recordRevision!==undefined) {
        const binding=object(log?.binding);
        if(assistance.recordRevision!==SPARRING_ASSISTANCE_RECORD_REVISION||!readContext
          ||readContext.recordRevision!==SPARRING_ASSISTANCE_RECORD_REVISION||!binding
          ||baseline.contextId!==readContext.baselineContextId||followUp.contextId!==readContext.followUpContextId
          ||['launchId','recheckId','baselineContextId','followUpContextId','completedMessageId','completedEvaluationId']
            .some(key=>binding[key]!==readContext[key as keyof SparringAssistanceBinding])) return unavailable;
        const [baselineDetail,followUpDetail]=await Promise.all([
          resolveSparringRecordIndex(readContext.db,readContext.owner,baselineSessionId,baseline.contextId,object(log?.baseline)?.index),
          resolveSparringRecordIndex(readContext.db,readContext.owner,followUpSessionId,followUp.contextId,object(log?.followUp)?.index),
        ]);
        return {status:'RECORDED',kind:'SPARRING_RECORDS_V2',coverage:'LOCAL_RECORDED_ONLY',externalAssistance:'UNKNOWN',
          deliveryValidation:'UNKNOWN',protocolValidation:'UNKNOWN',baseline:{...baseline,controls:'INDEXED_SOURCE_RECORDS',detail:baselineDetail},followUp:{...followUp,controls:'INDEXED_SOURCE_RECORDS',detail:followUpDetail}};
      }
      return { status: 'RECORDED', kind: 'SPARRING_SESSION_TOTALS_V1', coverage: 'LOCAL_RECORDED_ONLY',
        externalAssistance: 'UNKNOWN', deliveryValidation: 'UNKNOWN', protocolValidation: 'UNKNOWN', baseline, followUp };
    }
    const baseline = summarizeEpisode(log?.baseline, baselineSessionId);
    const followUp = summarizeEpisode(log?.followUp, followUpSessionId);
    if (!baseline || !followUp) return unavailable;
    return { status: 'RECORDED', kind: 'TRAINING_RECORDS_V1', coverage: 'LOCAL_RECORDED_ONLY', externalAssistance: 'UNKNOWN',
      deliveryValidation: 'UNKNOWN', protocolValidation: 'UNKNOWN', baseline, followUp };
  } catch (error) {
    if (error instanceof SyntaxError) return unavailable;
    throw error;
  }
}
