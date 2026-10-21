import { projectFollowUpProtocol, type FollowUpProtocolRow } from './growth-follow-up-protocol';
import { GrowthServiceError, type GrowthOriginKind } from './growth-cycle-types';

export function followUpTables(kind: GrowthOriginKind = 'TRAINING') {
  return kind === 'SPARRING'
    ? { launches: 'growth_recheck_sparring_follow_up_launches', bindings: 'growth_recheck_sparring_follow_up_bindings', sessions: 'sessions' }
    : { launches: 'growth_recheck_follow_up_launches', bindings: 'growth_recheck_follow_up_bindings', sessions: 'training_sessions' };
}

export type FollowUpLaunch = FollowUpProtocolRow & {
  id: string; growth_cycle_id: string; recheck_id: string; baseline_session_id: string;
  baseline_context_id: string; changed_condition: string; scheduled_for: number;
  session_id: string | null; context_id: string | null; completed_turn_id: string | null;
};

export async function loadOwnedFollowUpLaunch(db: D1Database, owner: string, launchId: string, kind: GrowthOriginKind = 'TRAINING'): Promise<FollowUpLaunch> {
  const tables = followUpTables(kind);
  if (!await hasFollowUpLaunchSchema(db, kind)) throw new GrowthServiceError({status:503,code:'GROWTH_FOLLOW_UP_PROTOCOL_UNAVAILABLE',phase:'unavailable',retryable:true});
  const row = await db.prepare(`SELECT launch.*, r.scheduled_for, binding.session_id,
      binding.context_id, ${kind === 'TRAINING' ? 'binding.completed_turn_id' : 'NULL AS completed_turn_id'}
    FROM ${tables.launches} launch
    JOIN growth_cycles c ON c.id=launch.growth_cycle_id
    JOIN growth_rechecks r ON r.id=launch.recheck_id
    JOIN growth_spaces s ON s.id=c.space_id
    JOIN growth_space_memberships m ON m.id=c.participant_membership_id
    JOIN growth_private_consent_receipts consent ON consent.id=c.consent_receipt_id
    LEFT JOIN ${tables.bindings} binding ON binding.launch_id=launch.id
    WHERE launch.id=?1 AND launch.owner_user_id=?2 AND s.host_user_id=?2 AND s.status='ACTIVE'
      AND m.user_id=?2 AND m.status='ACTIVE' AND m.role='HOST'
      AND consent.subject_user_id=?2 AND consent.revoked_at IS NULL
      AND c.state='RECHECK_SCHEDULED' AND r.recorded_at IS NULL`)
    .bind(launchId, owner).first<FollowUpLaunch>();
  if (!row) throw new GrowthServiceError({ status: 404, code: 'GROWTH_FOLLOW_UP_NOT_FOUND', phase: 'authorization' });
  if (projectFollowUpProtocol(row, kind).status === 'UNAVAILABLE') throw new GrowthServiceError({ status: 503, code: 'GROWTH_FOLLOW_UP_PROTOCOL_UNAVAILABLE', phase: 'evidence' });
  if (Date.now() < row.scheduled_for) throw new GrowthServiceError({ status: 409, code: 'GROWTH_RECHECK_NOT_DUE', phase: 'conflict' });
  return row;
}

export function prepareFollowUpBinding(db: D1Database, launchId: string, sessionId: string, contextId: string, createdAt: number, kind: GrowthOriginKind = 'TRAINING') {
  const tables = followUpTables(kind);
  return db.prepare(`INSERT INTO ${tables.bindings} (launch_id,session_id,context_id,created_at)
    VALUES (?1,?2,?3,?4)`).bind(launchId,sessionId,contextId,createdAt);
}

export async function hasFollowUpLaunchSchema(db: D1Database, kind: GrowthOriginKind = 'TRAINING') {
  const tables = followUpTables(kind);
  try {
  const inventory = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('${tables.launches}','${tables.bindings}')`).all<{name:string}>();
  if (!inventory.success || !Array.isArray(inventory.results) || inventory.results.length === 1) {
    throw new GrowthServiceError({status:503,code:'GROWTH_FOLLOW_UP_PROTOCOL_UNAVAILABLE',phase:'unavailable',retryable:true});
  }
  return inventory.results.length === 2;

  } catch (error) {
    if (error instanceof GrowthServiceError) throw error;
    throw new GrowthServiceError({status:503,code:'GROWTH_FOLLOW_UP_PROTOCOL_UNAVAILABLE',phase:'unavailable',retryable:true});
  }
}

export async function requireFollowUpProtocolSchema(db: D1Database, kind: GrowthOriginKind = 'TRAINING'): Promise<void> {
  const tables = followUpTables(kind);
  try {
  const available = await hasFollowUpLaunchSchema(db, kind);
  const columns = available ? await db.prepare(`PRAGMA table_info(${tables.launches})`).all<{name:string}>() : null;
  if (!columns?.success || !Array.isArray(columns.results)
    || !['protocol_revision','assistance_policy_revision',...(kind==='SPARRING'?['assistance_capture_revision']:[])].every(name => columns.results.some(column => column.name === name))) {
    throw new GrowthServiceError({status:503,code:'GROWTH_FOLLOW_UP_PROTOCOL_UNAVAILABLE',phase:'unavailable',retryable:true});
  }

  } catch (error) {
    if (error instanceof GrowthServiceError) throw error;
    throw new GrowthServiceError({status:503,code:'GROWTH_FOLLOW_UP_PROTOCOL_UNAVAILABLE',phase:'unavailable',retryable:true});
  }
}

/** Private navigation metadata only; Training history remains readable after Growth erasure. */
export async function readTrainingFollowUpLink(db: D1Database, owner: string, sessionId: string) {
  return readFollowUpLink(db, owner, sessionId, 'TRAINING');
}

export async function readFollowUpLink(db: D1Database, owner: string, sessionId: string, kind: GrowthOriginKind) {
  const tables = followUpTables(kind);
  if(!await hasFollowUpLaunchSchema(db, kind)) return null;
  const row = await db.prepare(`SELECT launch.*, launch.id AS launchId,launch.growth_cycle_id AS cycleId,
      c.space_id AS spaceId,launch.changed_condition AS changedCondition
    FROM ${tables.bindings} binding
    JOIN ${tables.launches} launch ON launch.id=binding.launch_id
    JOIN growth_cycles c ON c.id=launch.growth_cycle_id
    JOIN growth_spaces s ON s.id=c.space_id
    JOIN growth_space_memberships m ON m.id=c.participant_membership_id
    JOIN growth_private_consent_receipts consent ON consent.id=c.consent_receipt_id
    WHERE binding.session_id=?1 AND launch.owner_user_id=?2 AND s.host_user_id=?2
      AND s.status='ACTIVE' AND m.user_id=?2 AND m.status='ACTIVE' AND m.role='HOST'
      AND consent.subject_user_id=?2 AND consent.revoked_at IS NULL`)
    .bind(sessionId,owner).first<FollowUpProtocolRow & {launchId:string;cycleId:string;spaceId:string;changedCondition:string}>();
  return row ? { originKind:kind, launchId:row.launchId, cycleId:row.cycleId, spaceId:row.spaceId, changedCondition:row.changedCondition, protocol:projectFollowUpProtocol(row, kind) } : null;
}
