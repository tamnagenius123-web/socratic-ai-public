import type { GrowthOriginKind } from './growth-cycle-types';
export const FOLLOW_UP_PROTOCOL_REVISION = 'growth-follow-up-local-v1';
export const SPARRING_ASSISTANCE_CAPTURE_POLICY_REVISION = 'sparring-assistance-capture-v1';
export const ASSISTANCE_CAPTURE_POLICY_REVISION = 'training-assistance-capture-v1';
export const SPARRING_ASSISTANCE_RECORD_REVISION = 'sparring-record-index-v2';
export const SPARRING_ASSISTANCE_TOTALS_REVISION = 'sparring-session-totals-v1';

export type FollowUpProtocolRow = {
  protocol_revision?: string | null;
  assistance_policy_revision?: string | null;
  assistance_capture_revision?: string | null;
  created_at: number;
  changed_condition: string;
};

/** A local declaration is not a validated longitudinal protocol or delivery receipt. */
export function projectFollowUpProtocol(row: FollowUpProtocolRow, kind: GrowthOriginKind = 'TRAINING') {
  const assistanceRevision = kind === 'SPARRING' ? SPARRING_ASSISTANCE_CAPTURE_POLICY_REVISION : ASSISTANCE_CAPTURE_POLICY_REVISION;
  if (row.protocol_revision == null && row.assistance_policy_revision == null) {
    return { status: 'NOT_PREDECLARED', protocolValidation: 'UNKNOWN', outcome: 'UNKNOWN' } as const;
  }
  if (row.protocol_revision !== FOLLOW_UP_PROTOCOL_REVISION
    || row.assistance_policy_revision !== assistanceRevision
    || (kind === 'SPARRING' && row.assistance_capture_revision != null
      && ![SPARRING_ASSISTANCE_TOTALS_REVISION,SPARRING_ASSISTANCE_RECORD_REVISION].includes(row.assistance_capture_revision))
    || !Number.isSafeInteger(row.created_at) || row.created_at < 0) {
    return { status: 'UNAVAILABLE', protocolValidation: 'UNKNOWN', outcome: 'UNKNOWN' } as const;
  }
  return {
    status: 'PREDECLARED_LOCAL', protocolRevision: FOLLOW_UP_PROTOCOL_REVISION,
    declaredAt: row.created_at,
    changedContextDefinition: { source: 'LEARNER_DECLARED', text: row.changed_condition,
      semanticValidation: 'UNKNOWN', evidenceRelation: 'RECORDED_AS_SAME_OR_DISTINCT_EVIDENCE_CONTENT' },
    assistanceLogPolicy: {
      revision: assistanceRevision, coverage: 'LOCAL_RECORDED_ONLY',
      ...(kind === 'SPARRING' ? {recordRevision:row.assistance_capture_revision??SPARRING_ASSISTANCE_TOTALS_REVISION} : {}),
      records: kind === 'SPARRING' ? (row.assistance_capture_revision===SPARRING_ASSISTANCE_RECORD_REVISION
        ? ['SESSION_TOTALS','SOURCE_RECORD_IDS_AND_HASHES','OWNER_SCOPED_SOURCE_READBACK','SOURCE_ERASURE_WITHHOLDS_DETAILS']
        : ['ACCEPTED_TURN_COUNTS', 'OWNED_EVALUATION_COUNTS', 'SESSION_HINT_COUNTERS']) : ['ACCEPTED_TURNS', 'HINT_LEVELS', 'HELP_PAUSE_RESUME_STOP', 'PERSISTED_SUPPORT', 'ROUTE_DECISIONS', 'LEARNER_REVISIONS'],
      externalAssistance: 'UNKNOWN', deliveryValidation: 'UNKNOWN',
    },
    protocolValidation: 'UNKNOWN', outcome: 'UNKNOWN',
  } as const;
}

export type FollowUpProtocol = ReturnType<typeof projectFollowUpProtocol>;
