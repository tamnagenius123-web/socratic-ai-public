import type { ContentIdentity } from './identity';
import type {
  ReceiptIntegrityProofV1,
  ResolvedReceiptPayloadV1,
  VerifiedRuntimeTargetV1,
} from './product-receipts';

export const RECORD_FAMILIES = Object.freeze([
  'ARTIFACT', 'NEGATIVE_CONTROL_RESULT', 'GRADE', 'CORRECTION',
] as const);

export type EvidenceRecordFamily = typeof RECORD_FAMILIES[number];
export type ArtifactKind = 'STATIC' | 'RUNTIME' | 'DEPLOYMENT' | 'AUTHENTICATED_E2E' | 'LONGITUDINAL' | 'ACCESSIBILITY' | 'DELETION' | 'GRADE_INPUT';
export type ArtifactStatus = 'PENDING' | 'PASS' | 'FAIL' | 'UNKNOWN' | 'UNGRADABLE';
export type ArtifactOutcome = 'CLAIM_SUPPORTED' | 'CLAIM_CONTRADICTED' | 'EXPECTED_RESULT_OBSERVED' | 'EXPECTED_RESULT_NOT_OBSERVED' | 'NO_RESULT' | 'UNKNOWN' | 'UNGRADABLE';
export type GradeVerdict = 'SAME GRADE' | 'A CLEARLY BETTER' | 'B CLEARLY BETTER' | 'UNGRADABLE';
export type EvidenceGate = 'D' | 'S' | 'R' | 'P' | 'A' | 'L' | 'V0';
export type EvidenceSliceId = 'N0' | 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6' | 'N7' | 'N8' | 'N9' | 'N10';
export type RequirementIndependence = 'NON_BUILDER' | 'NON_BUILDER_CROSS_VENDOR';

export interface RootSourceBytes {
  specification: Uint8Array;
  implementationPlan: Uint8Array;
  matrix: Uint8Array;
  answerKey: Uint8Array;
  historicalTask4Capsule: Uint8Array;
  failureTellDefinitions: Uint8Array;
  negativeControlDefinitions: Uint8Array;
  successorLaneDefinition: Uint8Array;
  firstVerticalJourney: Uint8Array;
  recordSchemas: Uint8Array;
  deterministicReducer: Uint8Array;
  task13Experiment: Uint8Array;
  closureRule: Uint8Array;
  n9SuccessorPolicy: Uint8Array;
}

export interface ExpectedRootIdentities {
  specification: ContentIdentity;
  implementationPlan: ContentIdentity;
  matrix: ContentIdentity;
  answerKey: ContentIdentity;
  historicalTask4Capsule: ContentIdentity;
  failureTellDefinitions: ContentIdentity;
  negativeControlDefinitions: ContentIdentity;
  successorLaneDefinition: ContentIdentity;
  firstVerticalJourney: ContentIdentity;
  recordSchemas: ContentIdentity;
  deterministicReducer: ContentIdentity;
  task13Experiment: ContentIdentity;
  closureRule: ContentIdentity;
  n9SuccessorPolicy: ContentIdentity;
}

export interface ContentBoundSubjectIdentity {
  subject_type: string;
  subject_key: string;
  content_identity: ContentIdentity;
}

export interface EvidenceScopeV1 {
  purpose_identity: ContentIdentity;
  subject_identity: ContentIdentity;
  time_identity: ContentIdentity;
  environment_identity: ContentIdentity;
  exclusion_identities: readonly ContentIdentity[];
}

export interface ProducerIdentityV1 {
  producer_id: string;
  role: string;
  vendor_family: string;
  attestation: string;
}

export interface IndependentReviewV1 {
  builder_identity: string;
  reviewer_identity: string;
  separation: 'VERIFIED' | 'UNKNOWN';
  review_output_identity: ContentIdentity;
  verdict: 'ADMIT' | 'REJECT' | 'UNKNOWN';
  vendor_family: string;
}

export type SourceReceiptKind =
  | 'SOURCE_MANIFEST'
  | 'LEARNING_SESSION_CONTEXT'
  | 'AI_INVOCATION_ATTEMPT'
  | 'GROWTH_CONSENT'
  | 'GROWTH_CYCLE'
  | 'GROWTH_EVENT'
  | 'MUTATION_RECEIPT'
  | 'RECHECK'
  | 'DELETION'
  | 'BUILD'
  | 'DEPLOYMENT'
  | 'CONTROL_PLANE'
  | 'BROWSER_ACTION_LOG'
  | 'ACCESSIBILITY'
  | 'REVIEW'
  | 'GRADE_OUTPUT';

export interface SourceReceiptRefV1 {
  receipt_kind: SourceReceiptKind;
  receipt_id: string;
  content_identity: ContentIdentity;
}

export interface FailureTellObservationV1 {
  failure_tell_id: string;
  slice_ids: readonly string[];
  gate_ids: readonly string[];
  requirement_ids: readonly string[];
  subject_identity: ContentBoundSubjectIdentity;
  observed: true;
  artifact_ids: readonly string[];
  scope: EvidenceScopeV1;
  review_output_identities: readonly ContentIdentity[];
}

export interface ConditionalClaimAssertionV1 {
  claim_id: string;
  conditional_requirement_ids: readonly string[];
  subject_identity: ContentBoundSubjectIdentity;
  assertion_state: 'ASSERTED' | 'NOT_ASSERTED' | 'UNKNOWN';
  artifact_ids: readonly string[];
  review_output_identities: readonly ContentIdentity[];
}

export interface StaticKindDetailsV1 {
  kind: 'STATIC';
  source_subject_ids: readonly string[];
  source_snapshot_identity: ContentIdentity;
  code_bound: boolean;
}

export interface RuntimeKindDetailsV1 {
  kind: 'RUNTIME';
  invocation_receipt_ids: readonly string[];
  action_log_artifact_id: string;
  started_at: string;
  completed_at: string;
}

export interface DeploymentKindDetailsV1 {
  kind: 'DEPLOYMENT';
  control_plane_artifact_id: string;
  production_probe_artifact_ids: readonly string[];
  route_ids: readonly string[];
}

export interface AuthenticatedE2EKindDetailsV1 {
  kind: 'AUTHENTICATED_E2E';
  journey_id: string;
  step_ids: readonly string[];
  action_log_artifact_id: string;
  capture_artifact_ids: readonly string[];
  korean_comprehension_artifact_id: string;
  isolation_result_ids: readonly string[];
}

export interface LongitudinalKindDetailsV1 {
  kind: 'LONGITUDINAL';
  protocol_id: string;
  baseline_artifact_id: string;
  followup_artifact_ids: readonly string[];
  scheduled_at: string;
  observed_at: string;
  horizon_seconds: number;
  changed_context: boolean;
  outcome_status: ArtifactStatus;
}

export interface AccessibilityKindDetailsV1 {
  kind: 'ACCESSIBILITY';
  evaluation_id: string;
  route_ids: readonly string[];
  viewport_artifact_ids: readonly string[];
  input_mode_artifact_ids: readonly string[];
  assistive_technology_artifact_ids: readonly string[];
  korean_comprehension_artifact_ids: readonly string[];
  issue_ids: readonly string[];
}

export interface DeletionKindDetailsV1 {
  kind: 'DELETION';
  deletion_receipt_id: string;
  declared_store_ids: readonly string[];
  before_manifest_artifact_id: string;
  after_manifest_artifact_id: string;
  residue_probe_ids: readonly string[];
  authorized_actor: string;
  completed_at: string;
}

export interface GradeInputKindDetailsV1 {
  kind: 'GRADE_INPUT';
  presentation_packet_id: string;
  randomized_mapping_commitment: string;
  presented_artifact_ids: readonly string[];
  same_state_material: true;
}

export type ArtifactKindDetailsV1 =
  | StaticKindDetailsV1
  | RuntimeKindDetailsV1
  | DeploymentKindDetailsV1
  | AuthenticatedE2EKindDetailsV1
  | LongitudinalKindDetailsV1
  | AccessibilityKindDetailsV1
  | DeletionKindDetailsV1
  | GradeInputKindDetailsV1;

interface ArtifactBindingFieldsV1 {
  source_receipts: readonly SourceReceiptRefV1[];
  build_identity: ContentIdentity | null;
  deployment_identity: ContentIdentity | null;
  account_scope_identity: ContentIdentity | null;
  capture_environment_identity: ContentIdentity | null;
  retention_policy_identity: ContentIdentity | null;
  access_policy_identity: ContentIdentity | null;
  negative_control_result_ids: readonly string[];
  failure_tell_observations: readonly FailureTellObservationV1[];
  claim_assertions: readonly ConditionalClaimAssertionV1[];
}

type ArtifactBindingsForKindV1<K extends ArtifactKind> = ArtifactBindingFieldsV1 & Readonly<{
  kind_details: Extract<ArtifactKindDetailsV1, Readonly<{ kind: K }>>;
}>;

export type ArtifactBindingsV1 = {
  [K in ArtifactKind]: ArtifactBindingsForKindV1<K>;
}[ArtifactKind];

export type ExternalCaptureKindV1 = 'BUILD' | 'DEPLOYMENT' | 'CONTROL_PLANE';

export interface ArtifactCaptureBindingV1 {
  readonly artifactId: string;
  readonly sliceId: EvidenceSliceId;
  readonly gateId: EvidenceGate;
  readonly requirementIds: readonly string[];
  readonly artifactKind: ArtifactKind;
  readonly requiredCaptureKinds: readonly ExternalCaptureKindV1[];
  readonly requiredReceiptKinds: readonly SourceReceiptKind[];
  readonly maximumClaim: string;
}

export interface ArtifactCapturePlanV1 {
  readonly schemaVersion: 'MES-ARTIFACT-CAPTURE-PLAN-1';
  readonly rootIdentity: ContentIdentity;
  readonly implementationPlanIdentity: ContentIdentity;
  readonly subject: ContentBoundSubjectIdentity;
  readonly accountScopeIdentity: ContentIdentity;
  readonly buildIdentity: ContentIdentity;
  readonly deploymentIdentity: ContentIdentity;
  readonly routeManifestIdentity: ContentIdentity;
  readonly controlPlaneIdentity: ContentIdentity;
  readonly bindings: readonly ArtifactCaptureBindingV1[];
}

export interface ExternalArtifactObservationV1 {
  readonly bindingIndex: number;
  readonly artifactId: string;
  readonly capturedAt: string;
  readonly privacySafeLocator: string;
  readonly artifactBytesIdentity: ContentIdentity;
  readonly evidenceLabel: 'CODE_VERIFIED' | 'DOCS_VERIFIED' | 'LIVE_VERIFIED' | 'UNKNOWN';
  readonly status: ArtifactStatus;
  readonly outcome: ArtifactOutcome;
  readonly producer: ProducerIdentityV1;
  readonly scope: EvidenceScopeV1;
  readonly limitations: readonly string[];
  readonly artifactBindings: ArtifactBindingsV1;
}

export interface ExternalCaptureCarrierV1 {
  readonly schemaVersion: 'MES-EXTERNAL-CAPTURE-1';
  readonly rootIdentity: ContentIdentity;
  readonly implementationPlanIdentity: ContentIdentity;
  readonly artifactCapturePlan: ArtifactCapturePlanV1;
  readonly artifactCapturePlanIdentity: ContentIdentity;
  readonly subject: ContentBoundSubjectIdentity;
  readonly accountScopeIdentity: ContentIdentity;
  readonly buildRef: SourceReceiptRefV1;
  readonly deploymentRef: SourceReceiptRefV1;
  readonly controlPlaneRef: SourceReceiptRefV1;
  readonly externalContainerIdentity: ContentIdentity;
  readonly policyIdentity: ContentIdentity;
  readonly independentReadbackIdentity: ContentIdentity;
  readonly observations: readonly ExternalArtifactObservationV1[];
}

export interface FrozenArtifactCapturePlanV1 {
  readonly plan: ArtifactCapturePlanV1;
  readonly planIdentity: ContentIdentity;
  readonly carrier: ExternalCaptureCarrierV1;
  readonly carrierBytes: Uint8Array;
  readonly carrierIdentity: ContentIdentity;
}

export interface VerifiedArtifactProvenanceV1 {
  readonly rootIdentity: ContentIdentity;
  readonly artifactCapturePlanIdentity: ContentIdentity;
  readonly carrierIdentity: ContentIdentity;
  readonly bindingIndex: number;
  readonly binding: ArtifactCaptureBindingV1;
  readonly observation: ExternalArtifactObservationV1;
  readonly target: VerifiedRuntimeTargetV1;
}

interface ArtifactPayloadFieldsV1 {
  id: string;
  slice_id: EvidenceSliceId;
  evidence_requirement_ids: readonly string[];
  gate: EvidenceGate;
  path_or_url: string;
  sha256: string;
  captured_at: string;
  evidence_label: 'CODE_VERIFIED' | 'DOCS_VERIFIED' | 'LIVE_VERIFIED' | 'UNKNOWN';
  outcome: ArtifactOutcome;
  status: ArtifactStatus;
  scope: EvidenceScopeV1;
  limitations: readonly string[];
}

type ArtifactPayloadForKindV1<K extends ArtifactKind> = ArtifactPayloadFieldsV1 & Readonly<{
  kind: K;
  bindings: ArtifactBindingsForKindV1<K>;
}>;

export type ArtifactPayloadV1 = {
  [K in ArtifactKind]: ArtifactPayloadForKindV1<K>;
}[ArtifactKind];

export interface RequirementLinkV1 {
  slice_id: string;
  gate: EvidenceGate;
  evidence_requirement_ids: readonly string[];
}

export interface LogNetworkEvidenceV1 {
  kind: 'LOG';
  content_identity: ContentIdentity;
  reason: null;
}

export interface NotApplicableNetworkEvidenceV1 {
  kind: 'NOT_APPLICABLE';
  content_identity: null;
  reason: 'LOCAL_STATIC_ONLY' | 'NO_NETWORK_SURFACE';
}

export interface NegativeControlPayloadV1 {
  control_id: string;
  slice_ids: readonly string[];
  requirement_links: readonly RequirementLinkV1[];
  subject_identity: ContentBoundSubjectIdentity;
  expected_outcome: string;
  observed_outcome: string | null;
  before_state_identity: ContentIdentity;
  after_state_identity: ContentIdentity;
  action_log_identity: ContentIdentity;
  network_evidence: LogNetworkEvidenceV1 | NotApplicableNetworkEvidenceV1;
  artifact_ids: readonly string[];
  scope: EvidenceScopeV1;
  status: 'PASS' | 'FAIL' | 'UNKNOWN' | 'UNGRADABLE';
}

export interface GradePayloadV1 {
  id: string;
  slice_ids: readonly string[];
  frozen_rubric_sha256: string;
  matrix_sha256: string;
  artifact_ids: readonly string[];
  builder_vendor_family: string;
  grader_vendor_family: string;
  grader_is_non_builder: true;
  builder_report_used: false;
  branding_treatment: 'STRIPPED' | 'UNAVOIDABLE_DISCLOSED';
  same_state_material: true;
  mapping_commitment: string;
  prompt_sha256: string;
  verdict: GradeVerdict;
  reasons: readonly string[];
  unassessable_dimensions: readonly string[];
  timestamp: string;
  output_sha256: string;
}

export interface CorrectionPayloadV1 {
  target_record_id: string;
  target_record_identity: ContentIdentity;
  defect_code: string;
  reason: string;
  replacement_record_ids: readonly string[];
  approval_identity: ContentIdentity;
  review_output_identities: readonly ContentIdentity[];
  effective_manifest_head_identity: ContentIdentity;
}

export interface MinimalEvidenceEnvelopeV1 {
  schema_version: 'MES-1';
  record_id: string;
  root_identity: ContentIdentity;
  evidence_key: string;
  subject_identity: ContentBoundSubjectIdentity;
  created_at: string;
  producer_identity: ProducerIdentityV1;
  source_receipts: readonly SourceReceiptRefV1[];
  limitations: readonly string[];
  independent_review: IndependentReviewV1;
}

export interface ArtifactEvidenceRecordV1 extends MinimalEvidenceEnvelopeV1 {
  record_family: 'ARTIFACT';
  payload: ArtifactPayloadV1;
}

export interface NegativeControlEvidenceRecordV1 extends MinimalEvidenceEnvelopeV1 {
  record_family: 'NEGATIVE_CONTROL_RESULT';
  payload: NegativeControlPayloadV1;
}

export interface GradeEvidenceRecordV1 extends MinimalEvidenceEnvelopeV1 {
  record_family: 'GRADE';
  payload: GradePayloadV1;
}

export interface CorrectionEvidenceRecordV1 extends MinimalEvidenceEnvelopeV1 {
  record_family: 'CORRECTION';
  payload: CorrectionPayloadV1;
}

export type EvidenceRecordV1 = ArtifactEvidenceRecordV1 | NegativeControlEvidenceRecordV1 | GradeEvidenceRecordV1 | CorrectionEvidenceRecordV1;

export type ManifestDispositionV1 = 'ADMITTED' | 'REJECTED' | 'UNKNOWN';

export interface EvidenceManifestEntryV1 {
  schema_version: 'MES-1';
  root_identity: ContentIdentity;
  ordinal: number;
  predecessor_identity: ContentIdentity | null;
  candidate_identity: ContentIdentity | null;
  review_identity: ContentIdentity | null;
  reviewer_identity: string | null;
  reviewer_vendor_family: string | null;
  builder_identity: string | null;
  builder_vendor_family: string | null;
  independence_verified: boolean;
  disposition: ManifestDispositionV1;
  reason_codes: readonly string[];
}

export interface DetachedRecordCandidate {
  record: EvidenceRecordV1;
  canonical_bytes: Uint8Array;
  record_identity: ContentIdentity;
}

export interface IndependentRecordReviewBodyV1 {
  schema_version: 'MES-REVIEW-1';
  root_identity: ContentIdentity;
  candidate_identity: ContentIdentity;
  builder_identity: string;
  builder_vendor_family: string;
  reviewer_identity: string;
  reviewer_vendor_family: string;
  separation: 'VERIFIED' | 'UNKNOWN';
  verdict: 'ADMIT' | 'REJECT' | 'UNKNOWN';
  reason_codes: readonly string[];
}

export interface CorrectionAuthorityBodyV1 {
  schema_version: 'MES-CORRECTION-AUTHORITY-1';
  root_identity: ContentIdentity;
  target_record_id: string;
  target_record_identity: ContentIdentity;
  defect_code: string;
  replacement_record_ids: readonly string[];
  effective_manifest_head_identity: ContentIdentity;
  approver_identity: string;
  approver_vendor_family: string;
  decision: 'APPROVE';
}

export interface DetachedCorrectionAuthorityV1 {
  authority: CorrectionAuthorityBodyV1;
  canonical_bytes: Uint8Array;
  approval_identity: ContentIdentity;
}

export interface CorrectionSupportingReviewBodyV1 {
  schema_version: 'MES-CORRECTION-REVIEW-1';
  root_identity: ContentIdentity;
  target_record_id: string;
  target_record_identity: ContentIdentity;
  defect_code: string;
  replacement_record_ids: readonly string[];
  approval_identity: ContentIdentity;
  effective_manifest_head_identity: ContentIdentity;
  builder_identity: string;
  reviewer_identity: string;
  reviewer_vendor_family: string;
  separation: 'VERIFIED';
  verdict: 'APPROVE' | 'REJECT' | 'UNKNOWN';
  reason_codes: readonly string[];
}

export interface DetachedCorrectionSupportingReviewV1 {
  review: CorrectionSupportingReviewBodyV1;
  canonical_bytes: Uint8Array;
  review_output_identity: ContentIdentity;
}

export interface IndependentRecordReviewV1 {
  review: IndependentRecordReviewBodyV1;
  canonical_bytes: Uint8Array;
  review_identity: ContentIdentity;
  correction_authority: DetachedCorrectionAuthorityV1 | null;
  correction_reviews: readonly DetachedCorrectionSupportingReviewV1[];
}

export interface VerifiedManifestPrefix {
  schema_version: 'MES-MANIFEST-PREFIX-1';
  status: 'VERIFIED' | 'UNKNOWN';
  root_identity: ContentIdentity;
  entries: readonly EvidenceManifestEntryV1[];
  entry_identities: readonly ContentIdentity[];
  head_identity: ContentIdentity | null;
  records_by_identity: Readonly<Record<string, EvidenceRecordV1>>;
  reviews_by_identity: Readonly<Record<string, IndependentRecordReviewBodyV1>>;
  correction_authorities_by_identity: Readonly<Record<string, CorrectionAuthorityBodyV1>>;
  correction_reviews_by_identity: Readonly<Record<string, CorrectionSupportingReviewBodyV1>>;
  conflict_codes: readonly string[];
}

export type ProjectionRequirementStatusV1 =
  | 'BLOCKED_CONTRACT'
  | 'FAIL'
  | 'UNKNOWN'
  | 'UNGRADABLE'
  | 'PENDING'
  | 'PASS';

export interface ProjectedRequirementV1 {
  requirement_id: string;
  slice_id: EvidenceSliceId;
  gate: EvidenceGate;
  status: ProjectionRequirementStatusV1;
  lineage_record_identities: readonly ContentIdentity[];
}

export interface ProjectedSliceV1 {
  slice_id: EvidenceSliceId;
  requirement_ids: readonly string[];
}

export interface SpineProjectionV1 {
  schema_version: 'MES-PROJECTION-1';
  root_identity: ContentIdentity;
  manifest_head_identity: ContentIdentity | null;
  manifest_status: 'VERIFIED' | 'UNKNOWN';
  slices: readonly ProjectedSliceV1[];
  requirements: readonly ProjectedRequirementV1[];
  active_artifact_count: number;
  active_grade_count: number;
  same_grade_count: number;
  closure_status: 'NOT_EVALUATED';
}

export interface EvidenceRequirementV1 {
  id: string;
  slice_id: EvidenceSliceId;
  gate: EvidenceGate;
  independence: RequirementIndependence;
}

export interface FailureTellLinkV1 {
  failure_tell_id: string;
  slice_id: EvidenceSliceId;
  links: readonly Readonly<{ gate: EvidenceGate; requirement_ids: readonly string[] }>[];
}

export type ConditionalClaimIdV1 =
  | 'CLAIM-N1-LEARNER-MODEL-VALIDITY-CALIBRATION'
  | 'CLAIM-N2-ROUTE-EFFICACY-FAIRNESS'
  | 'CLAIM-N10-DURABILITY-SCAFFOLD-FADE';

export interface ConditionalClaimV1 {
  claim_id: ConditionalClaimIdV1;
  matrix_identity: ContentIdentity;
  slice_id: 'N1' | 'N2' | 'N10';
  gate: 'L';
  requirement_id: 'N1-L1' | 'N2-L1' | 'N10-L1';
  gate_rule: string;
  condition: string;
}

export interface RootSourceIdentitiesV1 {
  specification: ContentIdentity;
  implementation_plan: ContentIdentity;
  matrix: ContentIdentity;
  answer_key: ContentIdentity;
  historical_task4_capsule: ContentIdentity;
  failure_tell_definitions: ContentIdentity;
  negative_control_definitions: ContentIdentity;
  successor_lane_definition: ContentIdentity;
  first_vertical_journey: ContentIdentity;
  record_schemas: ContentIdentity;
  deterministic_reducer: ContentIdentity;
  task13_experiment: ContentIdentity;
  closure_rule: ContentIdentity;
  n9_successor_policy: ContentIdentity;
}

export interface FailureTellDefinitionV1 {
  id: string;
  slice_id: EvidenceSliceId;
  text: string;
}

export interface FailureTellDefinitionsV1 {
  schema_version: 'MES-1';
  matrix_identity: ContentIdentity;
  failure_tells: readonly FailureTellDefinitionV1[];
}

export interface NegativeControlDefinitionV1 {
  id: string;
  applicable_slice_ids: readonly EvidenceSliceId[];
  requirement_links: readonly RequirementLinkV1[];
  probe: string;
  expected_outcome: string;
}

export interface NegativeControlDefinitionsV1 {
  schema_version: 'MES-1';
  matrix_identity: ContentIdentity;
  negative_controls: readonly NegativeControlDefinitionV1[];
}

export type FirstVerticalBaselineStepIdV1 =
  | 'bind-runtime-identities'
  | 'authenticate-distinct-accounts'
  | 'select-books-and-query-in-korean'
  | 'complete-two-attributable-training-turns'
  | 'inspect-evidence-and-provenance'
  | 'create-growth-consent-and-private-space'
  | 'open-growth-cycle-from-training-origin'
  | 'contest-gap-and-choose-practice'
  | 'schedule-real-recheck'
  | 'attempt-foreign-account-operations'
  | 'exercise-korean-accessibility'
  | 'delete-cycle-and-inspect-residue'
  | 'emit-detached-evidence-candidates';

export interface SuccessorLaneDefinitionV1 {
  schema_version: 'MES-1';
  lane_id: 'N9_SUCCESSOR_V1';
  blocked_requirement_ids: readonly ('N9-S1' | 'N9-R1' | 'N9-P1' | 'N9-A1' | 'N9-L1')[];
  required_negative_control_ids: readonly ('NC-ACCESS' | 'NC-DELETE' | 'NC-SCOPE' | 'NC-SURVEILLANCE')[];
  required_authorization_bindings: readonly string[];
  safeguard_dimensions: readonly string[];
  stop_condition_ids: readonly string[];
  maximum_claim: `N9_SUCCESSOR_EVIDENCE_CANDIDATE_ONLY${string}`;
}

export interface FirstVerticalJourneyDefinitionV1 {
  schema_version: 'MES-1';
  journey_id: string;
  learner_locale: 'ko';
  distinct_account_roles: readonly ('LEARNER_A' | 'LEARNER_B')[];
  required_target_identity_kinds: readonly ('AI_INVOCATION_ATTEMPT' | 'TRAINING_SCENARIO_EVIDENCE' | 'TRAINING_SCENARIO_PACK')[];
  ordered_step_ids: readonly [
    'bind-runtime-identities',
    'authenticate-distinct-accounts',
    'select-books-and-query-in-korean',
    'complete-two-attributable-training-turns',
    'inspect-evidence-and-provenance',
    'create-growth-consent-and-private-space',
    'open-growth-cycle-from-training-origin',
    'contest-gap-and-choose-practice',
    'schedule-real-recheck',
    'attempt-foreign-account-operations',
    'exercise-korean-accessibility',
    'delete-cycle-and-inspect-residue',
    'emit-detached-evidence-candidates',
    ...string[],
  ];
  immediate_evidence_scopes: readonly ('account-isolation' | 'context-binding' | 'korean-comprehension')[];
  longitudinal_follow_up: 'SEPARATELY_GATED_AFTER_CONTEXT_CHANGE';
}

export interface RecordSchemasDefinitionV1 {
  schema_version: 'MES-1';
  common_envelope: string;
  families: readonly EvidenceRecordFamily[];
  artifact_kind_details: readonly ArtifactKind[];
  vocabulary: Readonly<{
    artifact_statuses: readonly ArtifactStatus[];
    grade_verdicts: readonly GradeVerdict[];
  }>;
}

export interface DeterministicReducerDefinitionV1 {
  schema_version: 'MES-1';
  reducer_id: string;
  admitted_record_rule: 'ADMITTED_ACTIVE_RECORDS_ONLY';
  active_record_rule: 'ALL_UNSUPERSEDED_RECORDS_PER_EVIDENCE_KEY';
  status_precedence: readonly ['BLOCKED_CONTRACT', 'FAIL', 'UNKNOWN', 'UNGRADABLE', 'PENDING', 'PASS'];
  pass_prerequisites: readonly string[];
  correction_rule: 'EXACT_TARGET_AND_ADMITTED_SAME_ROOT_REPLACEMENTS';
  missing_evidence_rule: 'PENDING_OR_UNKNOWN_NEVER_PASS';
}

export interface Task13ExperimentDefinitionV1 {
  schema_version: 'MES-1';
  experiment_id: string;
  separately_authorized: true;
  pre_e2e_prerequisite: false;
  pre_authorization_output: 'CONFIGURATION_ONLY';
  prohibited_claims: readonly ('EXPERIMENT_PASSED' | 'FIFTY_PERCENT_REDUCTION_PROVED')[];
  later_execution_contract: 'EXACT_ROOT_AND_SEPARATE_DIRECT_AUTHORIZATION_REQUIRED';
}

export interface ClosureRuleDefinitionV1 {
  schema_version: 'MES-1';
  unauthorized_status: 'NOT_EVALUATED';
  incomplete_status: 'NOT_CLEARED';
  cleared_status: 'CLEARED';
  required_conditions: readonly string[];
}

export interface EvidenceSpineRootV1 {
  schema_version: 'MES-1';
  source_identities: RootSourceIdentitiesV1;
  slice_ids: readonly EvidenceSliceId[];
  requirements: readonly EvidenceRequirementV1[];
  failure_tell_definitions: readonly FailureTellDefinitionV1[];
  failure_tell_links: readonly FailureTellLinkV1[];
  negative_controls: readonly NegativeControlDefinitionV1[];
  conditional_claims: readonly ConditionalClaimV1[];
  successor_lane: SuccessorLaneDefinitionV1;
  first_vertical_journey: FirstVerticalJourneyDefinitionV1;
  record_schemas: RecordSchemasDefinitionV1;
  deterministic_reducer: DeterministicReducerDefinitionV1;
  task13_experiment: Task13ExperimentDefinitionV1;
  closure_rule: ClosureRuleDefinitionV1;
  n9_successor_policy: N9SuccessorPolicyV1;
}

export interface N9ControlPolicyBindingV1 {
  readonly stepIndex: number;
  readonly controlId: string;
  readonly accountAliasIdentity: ContentIdentity;
  readonly routeId: string;
  readonly actionId: string;
  readonly allowedFileIds: readonly string[];
  readonly prohibitedActionIds: readonly string[];
  readonly stopConditionIds: readonly string[];
  readonly maximumClaim: string;
  readonly expectedOutcome: string;
  readonly beforeCaptureId: string;
  readonly afterCaptureId: string;
  readonly actionLogCaptureId: string;
  readonly networkEvidenceCaptureId: string;
  readonly artifactIds: readonly string[];
  readonly sliceId: EvidenceSliceId;
  readonly gateId: EvidenceGate;
  readonly requirementIds: readonly string[];
  readonly requiredReceiptKinds: readonly SourceReceiptKind[];
  readonly privateContainerPolicyIdentities: readonly ContentIdentity[];
}

export interface N9SuccessorPolicyV1 {
  readonly schemaVersion: 'MES-1';
  readonly policyId: 'N9_SUCCESSOR_POLICY_V1';
  readonly implementationPlanIdentity: ContentIdentity;
  readonly historicalCapsuleIdentity: ContentIdentity;
  readonly successorLaneId: 'N9_SUCCESSOR_V1';
  readonly blockedRequirementIds: readonly ('N9-S1' | 'N9-R1' | 'N9-P1' | 'N9-A1' | 'N9-L1')[];
  readonly accountAliasIdentities: readonly ContentIdentity[];
  readonly allowedActionIds: readonly string[];
  readonly allowedFileIds: readonly string[];
  readonly prohibitedActionIds: readonly string[];
  readonly stopConditionIds: readonly string[];
  readonly maximumClaim: string;
  readonly controls: readonly N9ControlPolicyBindingV1[];
  readonly declaredStorePolicyIdentity: ContentIdentity;
  readonly privateContainerPolicyIdentities: readonly ContentIdentity[];
}

export interface N9ValidationClockV1 {
  readonly evaluatedAt: string;
}

export interface N9SuccessorAuthorizationV1 {
  readonly rootIdentity: ContentIdentity;
  readonly implementationPlanIdentity: ContentIdentity;
  readonly historicalCapsuleIdentity: ContentIdentity;
  readonly successorLaneId: 'N9_SUCCESSOR_V1';
  readonly accountAliasIdentities: readonly ContentIdentity[];
  readonly allowedActionIds: readonly string[];
  readonly allowedFileIds: readonly string[];
  readonly prohibitedActionIds: readonly string[];
  readonly stopConditionIds: readonly string[];
  readonly maximumClaim: string;
  readonly buildIdentity: ContentIdentity;
  readonly deploymentIdentity: ContentIdentity;
  readonly routeManifestIdentity: ContentIdentity;
  readonly controlPlaneIdentity: ContentIdentity;
  readonly approvalIdentity: ContentIdentity;
  readonly authorizedAt: string;
  readonly expiresAt: string;
}

export interface N9AuthorizedStep {
  readonly stepIndex: number;
  readonly controlId: string;
  readonly accountAliasIdentity: ContentIdentity;
  readonly routeId: string;
  readonly actionId: string;
  readonly allowedFileIds: readonly string[];
  readonly prohibitedActionIds: readonly string[];
  readonly stopConditionIds: readonly string[];
  readonly maximumClaim: string;
}

export interface N9ControlObservationCarrierV1 {
  readonly controlId: string;
  readonly beforeIdentity: ContentIdentity;
  readonly afterIdentity: ContentIdentity;
  readonly actionLogIdentity: ContentIdentity;
  readonly networkEvidenceIdentity: ContentIdentity;
  readonly receiptRefs: readonly SourceReceiptRefV1[];
}

export interface ControlCaptureBindingV1 {
  readonly rootIdentity: ContentIdentity;
  readonly implementationPlanIdentity: ContentIdentity;
  readonly successorLaneId: 'N9_SUCCESSOR_V1';
  readonly controlId: string;
  readonly subjectIdentity: ContentIdentity;
  readonly accountScopeIdentity: ContentIdentity;
  readonly sliceId: EvidenceSliceId;
  readonly gateId: EvidenceGate;
  readonly requirementIds: readonly string[];
  readonly routeId: string;
  readonly actionId: string;
  readonly expectedOutcome: string;
  readonly buildIdentity: ContentIdentity;
  readonly deploymentIdentity: ContentIdentity;
  readonly routeManifestIdentity: ContentIdentity;
  readonly controlPlaneIdentity: ContentIdentity;
  readonly beforeIdentity: ContentIdentity;
  readonly afterIdentity: ContentIdentity;
  readonly actionLogIdentity: ContentIdentity;
  readonly networkEvidenceIdentity: ContentIdentity;
  readonly artifactIds: readonly string[];
  readonly requiredReceiptKinds: readonly SourceReceiptKind[];
  readonly stopConditionIds: readonly string[];
  readonly maximumClaim: string;
}

export interface N9EvidenceCapturePlanV1 {
  readonly rootIdentity: ContentIdentity;
  readonly implementationPlanIdentity: ContentIdentity;
  readonly historicalCapsuleIdentity: ContentIdentity;
  readonly successorLaneId: 'N9_SUCCESSOR_V1';
  readonly authorizationIdentity: ContentIdentity;
  readonly buildIdentity: ContentIdentity;
  readonly deploymentIdentity: ContentIdentity;
  readonly routeManifestIdentity: ContentIdentity;
  readonly controlPlaneIdentity: ContentIdentity;
  readonly controls: readonly ControlCaptureBindingV1[];
  readonly declaredStoreManifestIdentity: ContentIdentity;
  readonly privateContainerPolicyIdentities: readonly ContentIdentity[];
}

export interface FrozenN9EvidenceCapturePlanV1 {
  readonly plan: N9EvidenceCapturePlanV1;
  readonly planIdentity: ContentIdentity;
  readonly authorization: N9SuccessorAuthorizationV1;
  readonly authorizationIdentity: ContentIdentity;
}

/** Exact canonical JSON bytes plus the identity of those bytes. */
export interface ExactCanonicalBlobV1 {
  readonly bytesBase64: string;
  readonly contentIdentity: ContentIdentity;
}

export interface ManifestPrefixReplayPacketV1 {
  readonly entry: ExactCanonicalBlobV1;
  readonly candidate: ExactCanonicalBlobV1 | null;
  readonly review: ExactCanonicalBlobV1 | null;
  readonly correctionAuthority: ExactCanonicalBlobV1 | null;
  readonly correctionReviews: readonly ExactCanonicalBlobV1[];
}

export interface ManifestPrefixCarrierV1 {
  readonly schemaVersion: 'MES-MANIFEST-PREFIX-CARRIER-1';
  readonly rootIdentity: ContentIdentity;
  readonly packets: readonly ManifestPrefixReplayPacketV1[];
}

/** Convenience projection only; every consumer must reverify carrier bytes. */
export interface VerifiedManifestPrefixCarrierV1 {
  readonly carrierBytes: Uint8Array;
  readonly carrierIdentity: ContentIdentity;
  readonly prefix: VerifiedManifestPrefix;
}

export interface IntegrationAdmissionPolicyV1 {
  readonly schemaVersion: 'MES-INTEGRATION-ADMISSION-POLICY-1';
  readonly rootIdentity: ContentIdentity;
  readonly policyId: 'ROOT_REQUIREMENT_INDEPENDENCE_V1';
  readonly nonBuilderRule: 'REVIEWER_IDENTITY_DISTINCT_AND_SEPARATION_VERIFIED';
  readonly crossVendorRule: 'ANY_LINKED_CROSS_VENDOR_REQUIREMENT_REQUIRES_DISTINCT_VENDOR_FAMILY';
  readonly sourceReceiptRule: 'EXACT_RESOLVED_CARRIER_REQUIRED';
}

export interface IntegrationReceiptResolutionV1 {
  readonly ref: SourceReceiptRefV1;
  readonly subjectIdentity: ContentIdentity;
  readonly committedAt: string;
  readonly privacy: 'PUBLIC_METADATA' | 'ENCRYPTED_PRIVATE_CONTAINER';
  readonly integrityProof: ReceiptIntegrityProofV1;
  readonly canonicalBytesBase64: string;
  readonly payload: ResolvedReceiptPayloadV1;
}

export interface IntegrationReceiptResolutionCarrierV1 {
  readonly schemaVersion: 'MES-INTEGRATION-RECEIPT-RESOLUTION-CARRIER-1';
  readonly rootIdentity: ContentIdentity;
  readonly candidateIdentity: ContentIdentity;
  readonly resolutions: readonly IntegrationReceiptResolutionV1[];
}

export interface IntegrateReviewedCandidateInput {
  readonly candidateBytes: Uint8Array;
  readonly reviewBytes: Uint8Array;
  readonly expectedRootIdentity: ContentIdentity;
  readonly expectedHeadIdentity: ContentIdentity;
  readonly independencePolicyBytes: Uint8Array;
  readonly independencePolicyIdentity: ContentIdentity;
  readonly receiptResolutionCarrierBytes: Uint8Array;
  readonly receiptResolutionCarrierIdentity: ContentIdentity;
  readonly integratorAttribution: Readonly<{
    actorIdentity: string;
    sessionIdentity: string;
  }>;
  readonly prefixCarrierBytes: Uint8Array;
  readonly prefixCarrierIdentity: ContentIdentity;
}

export interface ReviewedManifestAppendProposalV1 {
  readonly status: 'PROPOSED_NOT_ADMITTED';
  readonly rootIdentity: ContentIdentity;
  readonly expectedHeadIdentity: ContentIdentity;
  readonly candidateIdentity: ContentIdentity;
  readonly reviewIdentity: ContentIdentity;
  readonly prefixCarrierIdentity: ContentIdentity;
  readonly independencePolicyIdentity: ContentIdentity;
  readonly receiptResolutionCarrierIdentity: ContentIdentity;
  readonly proposedEntryBytes: Uint8Array;
  readonly proposedHeadIdentity: ContentIdentity;
  readonly integratorAttribution: Readonly<{
    actorIdentity: string;
    sessionIdentity: string;
  }>;
}

export interface ResolvedTargetLinkV1 {
  readonly rootIdentity: ContentIdentity;
  readonly implementationPlanIdentity: ContentIdentity;
  readonly buildIdentity: ContentIdentity;
  readonly deploymentIdentity: ContentIdentity;
  readonly routeManifestIdentity: ContentIdentity;
  readonly controlPlaneIdentity: ContentIdentity;
  readonly supportingReceiptRefs: readonly SourceReceiptRefV1[];
}

export interface CanonicalGradeStatePreimageV1 {
  readonly schemaVersion: 'MES-GRADE-STATE-PREIMAGE-1';
  readonly rootIdentity: ContentIdentity;
  readonly targetLink: ResolvedTargetLinkV1;
  readonly evidenceCategoryIds: readonly string[];
}

export interface CanonicalGradeStateDescriptorV1 {
  readonly schemaVersion: 'MES-GRADE-STATE-DESCRIPTOR-1';
  readonly rootIdentity: ContentIdentity;
  readonly statePreimageIdentity: ContentIdentity;
  readonly viewportProfileIdentity: ContentIdentity;
  readonly contextProfileIdentity: ContentIdentity;
  readonly targetLinkIdentity: ContentIdentity;
}

export interface VerifiedActiveGradeInputCarrierV1 {
  readonly schemaVersion: 'MES-VERIFIED-GRADE-INPUT-1';
  readonly rootIdentity: ContentIdentity;
  readonly prefixCarrierIdentity: ContentIdentity;
  readonly manifestHeadIdentity: ContentIdentity;
  readonly gradeInputArtifactBytesBase64: string;
  readonly gradeInputArtifactIdentity: ContentIdentity;
  readonly targetReceiptCarrierBytesBase64: string;
  readonly targetReceiptCarrierIdentity: ContentIdentity;
  readonly statePreimageBytesBase64: string;
  readonly statePreimageIdentity: ContentIdentity;
  readonly stateDescriptorBytesBase64: string;
  readonly stateDescriptorIdentity: ContentIdentity;
  readonly graderMaterialBytesBase64: string;
  readonly graderMaterialIdentity: ContentIdentity;
}

export interface BlindGradeSanitizationPolicyV1 {
  readonly schemaVersion: 'MES-BLIND-GRADE-SANITIZATION-POLICY-1';
  readonly rootIdentity: ContentIdentity;
  readonly policyId: 'STRIP_BRANDING_EXCLUDE_BUILDER_NARRATIVE_V1';
  readonly forbiddenSemanticFields: readonly [
    'builder_identity', 'builder_vendor_family', 'builder_report', 'reviewer_identity',
    'reviewer_vendor_family', 'account_identity', 'raw_learner_content', 'plaintext_hash',
  ];
  readonly unavoidableDisclosureRule: 'SORTED_EXACT_DISCLOSURES_OR_REJECT';
}

export interface ExternalBlindMappingCommitmentCarrierV1 {
  readonly schemaVersion: 'MES-BLIND-MAPPING-COMMITMENT-1';
  readonly rootIdentity: ContentIdentity;
  readonly commitmentBytesBase64: string;
  readonly commitmentIdentity: ContentIdentity;
}

export interface BlindMappingCommitmentBodyV1 {
  readonly schemaVersion: 'MES-BLIND-MAPPING-COMMITMENT-BODY-1';
  readonly rootIdentity: ContentIdentity;
  /** Identity of the canonical sorted two-artifact/state-descriptor projection. */
  readonly gradeMaterialSetIdentity: ContentIdentity;
  readonly candidateArtifactIdentity: ContentIdentity;
  readonly slotMapping: readonly [Readonly<{
    slotId: 'SLOT_1'; gradeInputArtifactIdentity: ContentIdentity;
  }>, Readonly<{
    slotId: 'SLOT_2'; gradeInputArtifactIdentity: ContentIdentity;
  }>];
  readonly nonceCommitmentIdentity: ContentIdentity;
  readonly externalRandomizationReceiptIdentity: ContentIdentity;
}

export interface BlindGraderMaterialV1 {
  readonly schemaVersion: 'MES-BLIND-GRADER-MATERIAL-1';
  readonly slotId: 'SLOT_1' | 'SLOT_2';
  readonly rootIdentity: ContentIdentity;
  readonly gradeMaterialSetIdentity: ContentIdentity;
  readonly stateDescriptorIdentity: ContentIdentity;
  readonly redactedMaterialBytesBase64: string;
  readonly redactedMaterialIdentity: ContentIdentity;
  readonly unavoidableDisclosureTokens: readonly string[];
}

export interface BrandingAssessmentDisclosureBodyV1 {
  readonly schemaVersion: 'MES-BRANDING-ASSESSMENT-1';
  readonly rootIdentity: ContentIdentity;
  readonly gradeMaterialSetIdentity: ContentIdentity;
  readonly sanitizationPolicyIdentity: ContentIdentity;
  readonly semanticBrandingTokens: readonly string[];
  readonly visualBrandingTokens: readonly string[];
  readonly treatment: 'STRIPPED' | 'UNAVOIDABLE_DISCLOSED';
  readonly externalAssessmentReceiptIdentity: ContentIdentity;
}

export interface ExternalBrandingAssessmentCarrierV1 {
  readonly schemaVersion: 'MES-BRANDING-ASSESSMENT-CARRIER-1';
  readonly rootIdentity: ContentIdentity;
  readonly assessmentBytesBase64: string;
  readonly assessmentIdentity: ContentIdentity;
  readonly disclosureReceiptBytesBase64: string;
  readonly disclosureReceiptIdentity: ContentIdentity;
}

export interface VerifiedGradeRubricCarrierV1 {
  readonly schemaVersion: 'MES-GRADE-RUBRIC-CARRIER-1';
  readonly rootIdentity: ContentIdentity;
  readonly matrixBytesBase64: string;
  readonly matrixIdentity: ContentIdentity;
  readonly answerKeyBytesBase64: string;
  readonly answerKeyIdentity: ContentIdentity;
  readonly rubricBytesBase64: string;
  readonly rubricIdentity: ContentIdentity;
  readonly viewportProfileBytesBase64: string;
  readonly viewportProfileIdentity: ContentIdentity;
  readonly contextProfileBytesBase64: string;
  readonly contextProfileIdentity: ContentIdentity;
}

export type GradeReasonCodeV1 =
  | 'EVIDENCE_PARITY'
  | 'INTERACTION_PARITY'
  | 'ACCESSIBILITY_PARITY'
  | 'PRIVACY_PARITY'
  | 'DELETION_PARITY'
  | 'PROVENANCE_PARITY'
  | 'ISOLATION_PARITY'
  | 'KOREAN_COMPREHENSION_PARITY'
  | 'TRUTHFUL_DEGRADATION_PARITY'
  | 'DIMENSION_UNASSESSABLE';

export interface IndependentGraderIdentityV1 {
  readonly reviewerIdentity: string;
  readonly vendorFamily: string;
  readonly modelIdentity: ContentIdentity;
  readonly independenceReceiptIdentity: ContentIdentity;
}

/** Canonical body: deliberately has no self-referential packet identity. */
export interface BlindGradePacketBodyV1 {
  readonly schemaVersion: 'MES-BLIND-GRADE-PACKET-1';
  readonly rootIdentity: ContentIdentity;
  readonly targetLinkIdentity: ContentIdentity;
  readonly stateDescriptorIdentity: ContentIdentity;
  readonly gradeMaterialSetIdentity: ContentIdentity;
  readonly matrixIdentity: ContentIdentity;
  readonly answerKeyIdentity: ContentIdentity;
  readonly rubricIdentity: ContentIdentity;
  readonly rubricCarrier: VerifiedGradeRubricCarrierV1;
  readonly sanitizationPolicyIdentity: ContentIdentity;
  readonly brandingAssessmentIdentity: ContentIdentity;
  readonly mappingCommitmentIdentity: ContentIdentity;
  readonly items: readonly [BlindGraderMaterialV1, BlindGraderMaterialV1];
}

export interface FrozenBlindGradePacketV1 {
  readonly packet: BlindGradePacketBodyV1;
  readonly packetBytes: Uint8Array;
  readonly packetIdentity: ContentIdentity;
}

export interface BlindGradeOutputBodyV1 {
  readonly schemaVersion: 'MES-BLIND-GRADE-OUTPUT-1';
  readonly rootIdentity: ContentIdentity;
  readonly packetIdentity: ContentIdentity;
  readonly grader: IndependentGraderIdentityV1;
  readonly verdict: GradeVerdict;
  readonly reasonCodes: readonly GradeReasonCodeV1[];
  readonly unassessableDimensions: readonly string[];
}

export interface GradeOutputCarrierBodyV1 {
  readonly schemaVersion: 'MES-GRADE-OUTPUT-CARRIER-1';
  readonly rootIdentity: ContentIdentity;
  readonly packetBytesBase64: string;
  readonly packetIdentity: ContentIdentity;
  readonly outputBytesBase64: string;
  readonly outputIdentity: ContentIdentity;
  readonly outputReceiptCarrierBytesBase64: string;
  readonly outputReceiptCarrierIdentity: ContentIdentity;
  readonly mappingCommitmentBytesBase64: string;
  readonly mappingCommitmentIdentity: ContentIdentity;
  readonly brandingAssessmentCarrierBytesBase64: string;
  readonly brandingAssessmentCarrierIdentity: ContentIdentity;
  readonly candidateArtifactIdentity: ContentIdentity;
  readonly grader: IndependentGraderIdentityV1;
  readonly producedAt: string;
}

export interface VerifiedGradeOutputCarrierV1 {
  readonly carrierBytes: Uint8Array;
  readonly carrierIdentity: ContentIdentity;
}

export interface PreparedBlindGradeCandidateV1 {
  readonly status: 'PENDING_INDEPENDENT_REVIEW';
  readonly candidate: DetachedRecordCandidate;
  readonly outputBytes: Uint8Array;
  readonly outputIdentity: ContentIdentity;
  readonly pendingIndependentReview: IndependentReviewV1;
}
