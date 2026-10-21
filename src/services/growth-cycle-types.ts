import type { FollowUpProtocol } from './growth-follow-up-protocol';
export type GrowthHttpStatus =
  400 | 401 | 404 | 409 | 410 | 422 | 500 | 503;

export type GrowthOriginKind = 'TRAINING' | 'SPARRING';
export type GrowthState = 'EVIDENCE_PENDING' | 'GAP_PROPOSED' | 'GAP_ACCEPTED' | 'GAP_CONTESTED' | 'GAP_DISMISSED' | 'GAP_DEFERRED' | 'GAP_UNKNOWN' | 'FOCUS_SELECTED' | 'PRACTICE_OFFERED' | 'PRACTICE_ACCEPTED' | 'PRACTICE_DECLINED' | 'PRACTICE_DEFERRED' | 'RECHECK_SCHEDULED' | 'RECHECKED' | 'TRANSFER_PENDING' | 'CLOSED';

export interface GrowthCycleSecurity {
  /** Returns a lowercase, 64-character HMAC-SHA-256 hex digest for the exact bytes. */
  hmacSha256(purpose: string, canonicalBytes: Uint8Array): Promise<string>;
}

export type GrowthErrorPhase = 'authorization' | 'policy' | 'validation' | 'evidence' | 'conflict' | 'unavailable';
export class GrowthServiceError extends Error {
  readonly status: GrowthHttpStatus; readonly code: string; readonly phase: GrowthErrorPhase; readonly retryable: boolean; readonly details?: Record<string, unknown>;
  constructor(input: { status: GrowthHttpStatus; code: string; phase: GrowthErrorPhase; retryable?: boolean; details?: Record<string, unknown> }) {
    super(input.code); this.name = 'GrowthServiceError'; this.status = input.status; this.code = input.code; this.phase = input.phase; this.retryable = input.retryable ?? false; this.details = input.details;
  }
}

export interface PrivateSoloConsentInput { purpose: string; dataClasses: string[]; policyRevision: number; retentionPolicy: string; }
export interface OpenGrowthCycleInput { originKind: GrowthOriginKind; originAttemptId: string; }
export interface ListGrowthCyclesFilters { state?: GrowthState; originKind?: GrowthOriginKind; limit?: number; cursorUpdatedAt?: number; cursorId?: string; }
export interface GapResponseInput { action: 'accept' | 'contest' | 'dismiss' | 'defer' | 'resume' | 'retry_evidence' | 'close_unknown' | 'close'; hypothesisId?: string; rationale?: string; }
export interface GrowthFocusInput { capabilityId?: string; capabilityRevision?: number; statement: string; reason?: string; }
export interface PracticeResponseInput { action: 'accept' | 'decline' | 'defer' | 'resume' | 'retry_schedule' | 'close_unknown' | 'close'; practiceQuestId?: string; revisitAt?: number; }
export interface RecordRecheckInput { action: 'record' | 'reschedule' | 'close_unknown' | 'close' | 'retry_transfer'; recheckId?: string; followUpOrigin?: OpenGrowthCycleInput; followUpLaunchId?: string; revisitAt?: number; }
export interface GrowthPrivateConsentProjection { receiptId: string; purpose: string; dataClasses: string[]; policyRevision: number; retentionPolicy: string; issuedAt: number; revokedAt: number | null; }
/** Only usable spaces are readable through the public service surface. */
export interface GrowthSpaceProjection { id: string; spaceType: 'SOLO'; privacyMode: 'PRIVATE'; status: 'ACTIVE'; aggregateRevision: number; createdAt: number; updatedAt: number; archivedAt: null; consent: GrowthPrivateConsentProjection; }
export interface GrowthCycleSummary { id: string; spaceId: string; state: GrowthState; aggregateRevision: number; originKind: GrowthOriginKind; originAttemptId: string; originTurnNumber: number | null; openedAt: number; updatedAt: number; closedAt: number | null; }
export interface HumanReviewRequestV1 { readonly id: string; readonly cycleId: string; readonly state: 'PENDING'; readonly createdAt: number; }
export interface GrowthObservationProjection { id: string; capabilityId: string; capabilityRevision: number; rubricRevisionId: string | null; status: string; valueNumeric: number | null; valueScale: string | null; evidenceEventIds: string[]; inferenceRuleId: string; inferenceRuleRevision: number; inferenceValidation: string; confidence: number | null; observedAt: number; recordedAt: number; }
export interface GrowthGapHypothesisProjection { id: string; observationId: string | null; capabilityId: string; capabilityRevision: number; gapRuleId: string; gapRuleRevision: number; statement: string; state: string; supportingEventIds: string[]; contradictingEventIds: string[]; participantRationale: string | null; sourceRevision: string | null; revisesHypothesisId: string | null; revisionRationale: string | null; createdAt: number; updatedAt: number; }
export interface GrowthFocusProjection { id: string; capabilityId: string | null; capabilityRevision: number | null; selectionKind: string; statement: string; reason: string | null; createdAt: number; }
export interface GrowthPracticeQuestProjection { id: string; gapHypothesisId: string | null; focusSelectionId: string | null; practiceRuleId: string; practiceRuleRevision: number; questType: string; selectionReason: string; learningPurpose: string; status: string; targetRetentionHorizonHours: number; revisitAt: number | null; createdAt: number; updatedAt: number; }
export interface GrowthRecheckProjection { assistance?: GrowthRecheckAssistanceProjection; followUpLaunch?: {originKind?:GrowthOriginKind;protocol?: FollowUpProtocol;id:string;changedCondition:string;sessionId:string|null;completed:boolean;sessionCompleted?:boolean;recheckRecorded?:boolean;semanticValidation:'UNKNOWN'} | null; id: string; practiceQuestId: string; targetHorizonHours: number; scheduledFor: number; variantPolicyRevision: string; followUpOriginKind: GrowthOriginKind | null; followUpAttemptId: string | null; openingObservationId: string | null; recheckObservationId: string | null; evidenceEventIds: string[]; outcome: string | null; createdAt: number; recordedAt: number | null; }
/** `sourceCategory` intentionally omits persisted external source IDs and request keys. */
export interface GrowthTimelineEventProjection { id: string; eventType: string; objectType: string; objectId: string; objectRevision: number; lifecycleAction: string | null; previousState: GrowthState | null; nextState: GrowthState | null; transitionSubjectType: string | null; transitionSubjectId: string | null; occurredAt: number; recordedAt: number; sourceCategory: 'OWNED_PERSISTED_ORIGIN' | 'GROWTH_CYCLE_SERVICE' | 'UNKNOWN'; visibility: 'PRIVATE'; consentReceiptId: string; }
export interface GrowthCycleDetail extends GrowthCycleSummary { observations: GrowthObservationProjection[]; hypotheses: GrowthGapHypothesisProjection[]; focuses: GrowthFocusProjection[]; quests: GrowthPracticeQuestProjection[]; rechecks: GrowthRecheckProjection[]; timeline: GrowthTimelineEventProjection[]; }

export interface GrowthAssistanceSummary { acceptedTurns: number; supportRequested: number; supportRecorded: number; pauses: number; turnsWithHints: number; }
export interface GrowthSparringAssistanceTotals {
  sessionId: string; contextId: string; completedAt: number | null;
  acceptedTurns: number; evaluatedTurns: number; hintRequests: number; hintLevelAtCompletion: number;
  deliveredHints: 'NOT_RECORDED'; controls: 'NOT_RECORDED';
}
export type GrowthRecheckAssistanceProjection = { status: 'NOT_RECORDED' | 'UNAVAILABLE' } | {
  status: 'RECORDED'; coverage: 'LOCAL_RECORDED_ONLY'; externalAssistance: 'UNKNOWN'; deliveryValidation: 'UNKNOWN'; protocolValidation: 'UNKNOWN';
} & ({ kind: 'TRAINING_RECORDS_V1'; baseline: GrowthAssistanceSummary; followUp: GrowthAssistanceSummary }
  | { kind: 'SPARRING_SESSION_TOTALS_V1'; baseline: GrowthSparringAssistanceTotals; followUp: GrowthSparringAssistanceTotals }
  | { kind: 'SPARRING_RECORDS_V2'; baseline: Omit<GrowthSparringAssistanceTotals,'controls'> & {controls:'INDEXED_SOURCE_RECORDS';detail:import('./growth-sparring-records').GrowthSparringRecordDetail}; followUp: Omit<GrowthSparringAssistanceTotals,'controls'> & {controls:'INDEXED_SOURCE_RECORDS';detail:import('./growth-sparring-records').GrowthSparringRecordDetail} });
