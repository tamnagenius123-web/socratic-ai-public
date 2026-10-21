import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Bindings } from '../types';
import { getAuthUser, requireAuth } from '../middleware/auth';

type CompatibilityRole = 'instructor' | 'admin';
type ProgramMembershipRole = 'HRD_OPERATOR' | 'HRD_VIEWER';
type ProgramStatus = 'ACTIVE' | 'ARCHIVED';
type EnrollmentStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'REMOVED';
type AllocationSource = 'MANUAL' | 'RULE' | 'IMPORT';
type CompetencyStatus = 'ACTIVE' | 'RETIRED';
type ObservationStatus = 'MEASURED' | 'UNOBSERVED' | 'UNKNOWN' | 'UNAVAILABLE' | 'FAILED' | 'IN_PROGRESS';
type ValueScale = 'PERCENT_0_100' | 'RUBRIC_LEVEL';

interface ProgramListRow {
  id: string;
  program_code: string;
  display_name: string;
  scope_type: string;
  scope_reference: string;
  policy_revision: number;
  status: ProgramStatus;
  membership_id: string;
  membership_role: ProgramMembershipRole;
  enrollment_count: number;
  measured_enrollment_count: number;
  last_observed_at: number | null;
}

interface ProgramMeasurementRow {
  program_id: string;
  enrollment_id: string;
  status: ObservationStatus;
  value_numeric: number | null;
  value_scale: ValueScale | null;
  evidence_manifest_ids_json: string | null;
}

interface AuthorizedProgramRow {
  id: string;
  program_code: string;
  display_name: string;
  scope_type: string;
  scope_reference: string;
  policy_revision: number;
  status: ProgramStatus;
  membership_id: string;
  membership_role: ProgramMembershipRole;
  membership_policy_revision: number;
}

interface EnrollmentListRow {
  id: string;
  program_id: string;
  learner_user_id: string;
  learner_display_name: string;
  status: EnrollmentStatus;
  enrollment_revision: number;
  allocation_source: AllocationSource;
  scheduled_start_at: number | null;
  scheduled_end_at: number | null;
  schedule_timezone: string | null;
  created_at: number;
  updated_at: number;
  evidence_state: ObservationStatus;
}

type AuthorizedEnrollmentRow = Omit<EnrollmentListRow, 'evidence_state'> & {
  program_code: string;
  display_name: string;
  scope_type: string;
  scope_reference: string;
  policy_revision: number;
  program_status: ProgramStatus;
  membership_id: string;
  membership_role: ProgramMembershipRole;
  membership_policy_revision: number;
};

interface EnrollmentEvidenceRow extends EnrollmentListRow {
  active_competency_id: string | null;
  observation_status: ObservationStatus | null;
  value_numeric: number | null;
  value_scale: ValueScale | null;
  evidence_manifest_ids_json: string | null;
}

interface CompetencyDetailRow {
  competency_id: string;
  competency_code: string;
  competency_name: string;
  competency_status: CompetencyStatus;
  sort_order: number;
  active_rubric_version_id: string | null;
  active_rubric_version: number | null;
  active_rubric_criteria_json: string | null;
  observation_id: string | null;
  observation_rubric_version_id: string | null;
  observation_rubric_version: number | null;
  observation_status: ObservationStatus | null;
  value_numeric: number | null;
  value_scale: ValueScale | null;
  evidence_manifest_ids_json: string | null;
  observed_at: number | null;
  recorded_at: number | null;
}

const hrdProgramRoute = new Hono<{ Bindings: Bindings }>();
type HrdContext = Context<{ Bindings: Bindings }>;

hrdProgramRoute.use('/api/hrd/*', requireAuth);

function isCompatibilityRole(role: string): role is CompatibilityRole {
  return role === 'instructor' || role === 'admin';
}

function unavailable(c: HrdContext, code: string) {
  return c.json({
    status: 'UNAVAILABLE',
    code,
    error: 'The HRD program data is temporarily unavailable.',
    retryable: true,
  }, 503);
}

function compatibilityRoleRequired(c: HrdContext) {
  return c.json({
    code: 'HRD_COMPATIBILITY_ROLE_REQUIRED',
    error: 'An instructor or admin compatibility role is required.',
  }, 403);
}

function notFoundOrUnauthorized(c: HrdContext) {
  return c.json({
    code: 'PROGRAM_NOT_FOUND_OR_UNAUTHORIZED',
    error: 'The requested program was not found or is not available to this operator.',
  }, 404);
}

async function assertProgramMembershipQueryAvailable(db: D1Database, userId: string): Promise<void> {
  await db.prepare(`
    SELECT id
    FROM hrd_program_memberships
    WHERE user_id = ?1 AND status = 'ACTIVE'
    LIMIT 1
  `).bind(userId).first<{ id: string }>();
}

async function loadAuthorizedEnrollment(
  db: D1Database,
  programId: string,
  enrollmentId: string,
  userId: string,
): Promise<AuthorizedEnrollmentRow | null> {
  return db.prepare(`
    SELECT
      e.id,
      e.program_id,
      e.learner_user_id,
      e.learner_display_name,
      e.status,
      e.enrollment_revision,
      e.allocation_source,
      e.scheduled_start_at,
      e.scheduled_end_at,
      e.schedule_timezone,
      e.created_at,
      e.updated_at,
      p.program_code,
      p.display_name,
      p.scope_type,
      p.scope_reference,
      p.policy_revision,
      p.status AS program_status,
      m.id AS membership_id,
      m.role AS membership_role,
      m.policy_revision AS membership_policy_revision
    FROM hrd_program_enrollments e
    JOIN hrd_programs p ON p.id = e.program_id
    JOIN hrd_program_memberships m
      ON m.program_id = p.id
      AND m.user_id = ?3
      AND m.status = 'ACTIVE'
    WHERE e.program_id = ?1 AND e.id = ?2
    LIMIT 1
  `).bind(programId, enrollmentId, userId).first<AuthorizedEnrollmentRow>();
}

async function loadAuthorizedProgram(
  db: D1Database,
  programId: string,
  userId: string,
): Promise<AuthorizedProgramRow | null> {
  return db.prepare(`
    SELECT
      p.id,
      p.program_code,
      p.display_name,
      p.scope_type,
      p.scope_reference,
      p.policy_revision,
      p.status,
      m.id AS membership_id,
      m.role AS membership_role,
      m.policy_revision AS membership_policy_revision
    FROM hrd_programs p
    JOIN hrd_program_memberships m
      ON m.program_id = p.id
      AND m.user_id = ?2
      AND m.status = 'ACTIVE'
    WHERE p.id = ?1
    LIMIT 1
  `).bind(programId, userId).first<AuthorizedProgramRow>();
}

function toProgram(row: AuthorizedProgramRow | ProgramListRow) {
  return {
    id: row.id,
    code: row.program_code,
    displayName: row.display_name,
    scope: {
      type: row.scope_type,
      reference: row.scope_reference,
    },
    policyRevision: row.policy_revision,
    status: row.status,
  };
}

function toProgramFromEnrollment(row: AuthorizedEnrollmentRow) {
  return {
    id: row.program_id,
    code: row.program_code,
    displayName: row.display_name,
    scope: {
      type: row.scope_type,
      reference: row.scope_reference,
    },
    policyRevision: row.policy_revision,
    status: row.program_status,
  };
}

function toEnrollment(row: EnrollmentListRow) {
  return {
    id: row.id,
    programId: row.program_id,
    learner: {
      userId: row.learner_user_id,
      displayName: row.learner_display_name,
    },
    status: row.status,
    enrollmentRevision: row.enrollment_revision,
    allocationSource: row.allocation_source,
    schedule: {
      startAt: row.scheduled_start_at,
      endAt: row.scheduled_end_at,
      timezone: row.schedule_timezone,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    evidenceState: row.evidence_state,
  };
}

function validatedEvidenceManifestIds(
  status: ObservationStatus | null,
  valueNumeric: number | null,
  valueScale: ValueScale | null,
  serialized: string | null,
): string[] | null {
  if (status === null || serialized === null) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string' && item.length > 0)) return null;
    if (status === 'MEASURED') {
      if (parsed.length === 0 || typeof valueNumeric !== 'number' || !Number.isFinite(valueNumeric)) return null;
      if (valueScale !== 'PERCENT_0_100' && valueScale !== 'RUBRIC_LEVEL') return null;
      if (valueScale === 'PERCENT_0_100' && (valueNumeric < 0 || valueNumeric > 100)) return null;
    } else if (valueNumeric !== null || valueScale !== null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function observationEvidenceState(row: CompetencyDetailRow): ObservationStatus {
  if (row.observation_status === null) return 'UNOBSERVED';
  return validatedEvidenceManifestIds(
    row.observation_status,
    row.value_numeric,
    row.value_scale,
    row.evidence_manifest_ids_json,
  ) === null
    ? 'UNAVAILABLE'
    : row.observation_status;
}

function deriveEnrollmentEvidenceState(
  activeCompetencyIds: ReadonlySet<string>,
  latestObservations: ReadonlyMap<string, {
    status: ObservationStatus;
    valueNumeric: number | null;
    valueScale: ValueScale | null;
    evidenceManifestIdsJson: string | null;
  }>,
): ObservationStatus {
  if (activeCompetencyIds.size === 0) return 'UNKNOWN';
  if (latestObservations.size === 0) return 'UNOBSERVED';

  const states = Array.from(latestObservations.values(), (observation) => (
    validatedEvidenceManifestIds(
      observation.status,
      observation.valueNumeric,
      observation.valueScale,
      observation.evidenceManifestIdsJson,
    ) === null
      ? 'UNAVAILABLE'
      : observation.status
  ));
  if (states.includes('FAILED')) return 'FAILED';
  if (states.includes('UNAVAILABLE')) return 'UNAVAILABLE';
  if (states.length === activeCompetencyIds.size && states.every((status) => status === 'MEASURED')) return 'MEASURED';
  if (states.some((status) => status === 'MEASURED' || status === 'IN_PROGRESS')) return 'IN_PROGRESS';
  if (states.includes('UNKNOWN')) return 'UNKNOWN';
  return 'UNOBSERVED';
}

hrdProgramRoute.get('/api/hrd/programs', async (c) => {
  const auth = getAuthUser(c);
  if (!auth) return c.json({ code: 'AUTHENTICATION_REQUIRED', error: 'Authentication is required.' }, 401);
  if (!isCompatibilityRole(auth.role)) return compatibilityRoleRequired(c);

  try {
    await assertProgramMembershipQueryAvailable(c.env.DB, auth.userId);
  } catch (error) {
    console.error('[HRD] Program membership authorization state unavailable:', error);
    return unavailable(c, 'HRD_AUTHORIZATION_UNAVAILABLE');
  }

  try {
    const [programResult, measurementResult] = await Promise.all([
      c.env.DB.prepare(`
      SELECT
        p.id,
        p.program_code,
        p.display_name,
        p.scope_type,
        p.scope_reference,
        p.policy_revision,
        p.status,
        m.id AS membership_id,
        m.role AS membership_role,
        COUNT(DISTINCT CASE WHEN e.status <> 'REMOVED' THEN e.id END) AS enrollment_count,
        0 AS measured_enrollment_count,
        MAX(o.observed_at) AS last_observed_at
      FROM hrd_programs p
      JOIN hrd_program_memberships m
        ON m.program_id = p.id
        AND m.user_id = ?1
        AND m.status = 'ACTIVE'
      LEFT JOIN hrd_program_enrollments e ON e.program_id = p.id
      LEFT JOIN hrd_program_competency_observations o ON o.enrollment_id = e.id
      GROUP BY p.id, m.id
      ORDER BY p.display_name ASC, p.id ASC
      `).bind(auth.userId).all<ProgramListRow>(),
      c.env.DB.prepare(`
        SELECT
          observation.program_id,
          observation.enrollment_id,
          observation.status,
          observation.value_numeric,
          observation.value_scale,
          observation.evidence_manifest_ids_json
        FROM hrd_program_competency_observations observation
        JOIN hrd_program_enrollments enrollment
          ON enrollment.id = observation.enrollment_id
          AND enrollment.program_id = observation.program_id
          AND enrollment.status <> 'REMOVED'
        JOIN hrd_program_memberships membership
          ON membership.program_id = observation.program_id
          AND membership.user_id = ?1
          AND membership.status = 'ACTIVE'
      `).bind(auth.userId).all<ProgramMeasurementRow>(),
    ]);
    const measuredEnrollmentIdsByProgram = new Map<string, Set<string>>();
    for (const measurement of measurementResult.results ?? []) {
      if (measurement.status !== 'MEASURED' || validatedEvidenceManifestIds(
        measurement.status,
        measurement.value_numeric,
        measurement.value_scale,
        measurement.evidence_manifest_ids_json,
      ) === null) continue;
      let enrollmentIds = measuredEnrollmentIdsByProgram.get(measurement.program_id);
      if (!enrollmentIds) {
        enrollmentIds = new Set<string>();
        measuredEnrollmentIdsByProgram.set(measurement.program_id, enrollmentIds);
      }
      enrollmentIds.add(measurement.enrollment_id);
    }
    const programs = (programResult.results ?? []).map((row) => ({
      ...toProgram(row),
      operatorRole: row.membership_role,
      enrollmentCount: row.enrollment_count,
      measuredEnrollmentCount: measuredEnrollmentIdsByProgram.get(row.id)?.size ?? 0,
      lastObservedAt: row.last_observed_at,
      denominatorPolicy: 'all_non_removed_program_enrollments',
    }));

    return c.json({ programs, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[HRD] Program list query unavailable:', error);
    return unavailable(c, 'HRD_PROGRAM_QUERY_UNAVAILABLE');
  }
});

hrdProgramRoute.get('/api/hrd/programs/:programId/enrollments', async (c) => {
  const auth = getAuthUser(c);
  if (!auth) return c.json({ code: 'AUTHENTICATION_REQUIRED', error: 'Authentication is required.' }, 401);
  if (!isCompatibilityRole(auth.role)) return compatibilityRoleRequired(c);

  const programId = c.req.param('programId');
  let program: AuthorizedProgramRow | null;
  try {
    program = await loadAuthorizedProgram(c.env.DB, programId, auth.userId);
  } catch (error) {
    console.error('[HRD] Enrollment-list authorization query unavailable:', error);
    return unavailable(c, 'HRD_AUTHORIZATION_UNAVAILABLE');
  }
  if (!program) return notFoundOrUnauthorized(c);

  try {
    const result = await c.env.DB.prepare(`
      WITH active_competencies AS (
        SELECT id
        FROM hrd_competencies
        WHERE program_id = ?1 AND status = 'ACTIVE'
      ),
      ranked_observations AS (
        SELECT
          o.enrollment_id,
          o.competency_id,
          o.status,
          o.value_numeric,
          o.value_scale,
          o.evidence_manifest_ids_json,
          ROW_NUMBER() OVER (
            PARTITION BY o.enrollment_id, o.competency_id
            ORDER BY o.observed_at DESC, o.recorded_at DESC, o.id DESC
          ) AS observation_rank
        FROM hrd_program_competency_observations o
        JOIN active_competencies competency ON competency.id = o.competency_id
        WHERE o.program_id = ?1
      )
      SELECT
        e.id,
        e.program_id,
        e.learner_user_id,
        e.learner_display_name,
        e.status,
        e.enrollment_revision,
        e.allocation_source,
        e.scheduled_start_at,
        e.scheduled_end_at,
        e.schedule_timezone,
        e.created_at,
        e.updated_at,
        'UNOBSERVED' AS evidence_state,
        competency.id AS active_competency_id,
        observation.status AS observation_status,
        observation.value_numeric,
        observation.value_scale,
        observation.evidence_manifest_ids_json
      FROM hrd_program_enrollments e
      LEFT JOIN active_competencies competency ON 1 = 1
      LEFT JOIN ranked_observations observation
        ON observation.enrollment_id = e.id
        AND observation.competency_id = competency.id
        AND observation.observation_rank = 1
      WHERE e.program_id = ?1 AND e.status <> 'REMOVED'
      ORDER BY e.scheduled_start_at ASC, e.id ASC, competency.id ASC
    `).bind(programId).all<EnrollmentEvidenceRow>();

    const enrollmentGroups = new Map<string, {
      enrollment: EnrollmentListRow;
      activeCompetencyIds: Set<string>;
      latestObservations: Map<string, {
        status: ObservationStatus;
        valueNumeric: number | null;
        valueScale: ValueScale | null;
        evidenceManifestIdsJson: string | null;
      }>;
    }>();
    for (const row of result.results ?? []) {
      let group = enrollmentGroups.get(row.id);
      if (!group) {
        group = {
          enrollment: row,
          activeCompetencyIds: new Set<string>(),
          latestObservations: new Map<string, {
            status: ObservationStatus;
            valueNumeric: number | null;
            valueScale: ValueScale | null;
            evidenceManifestIdsJson: string | null;
          }>(),
        };
        enrollmentGroups.set(row.id, group);
      }
      if (row.active_competency_id !== null) group.activeCompetencyIds.add(row.active_competency_id);
      if (row.active_competency_id !== null && row.observation_status !== null) {
        group.latestObservations.set(row.active_competency_id, {
          status: row.observation_status,
          valueNumeric: row.value_numeric,
          valueScale: row.value_scale,
          evidenceManifestIdsJson: row.evidence_manifest_ids_json,
        });
      }
    }
    const enrollments = Array.from(enrollmentGroups.values(), (group) => toEnrollment({
      ...group.enrollment,
      evidence_state: deriveEnrollmentEvidenceState(group.activeCompetencyIds, group.latestObservations),
    }));

    return c.json({
      program: toProgram(program),
      enrollments,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[HRD] Enrollment-list query unavailable:', error);
    return unavailable(c, 'HRD_PROGRAM_QUERY_UNAVAILABLE');
  }
});

hrdProgramRoute.get('/api/hrd/programs/:programId/enrollments/:enrollmentId', async (c) => {
  const auth = getAuthUser(c);
  if (!auth) return c.json({ code: 'AUTHENTICATION_REQUIRED', error: 'Authentication is required.' }, 401);
  if (!isCompatibilityRole(auth.role)) return compatibilityRoleRequired(c);

  const programId = c.req.param('programId');
  const enrollmentId = c.req.param('enrollmentId');
  let enrollment: AuthorizedEnrollmentRow | null;
  try {
    enrollment = await loadAuthorizedEnrollment(c.env.DB, programId, enrollmentId, auth.userId);
  } catch (error) {
    console.error('[HRD] Enrollment-detail authorization query unavailable:', error);
    return unavailable(c, 'HRD_AUTHORIZATION_UNAVAILABLE');
  }
  if (!enrollment) return notFoundOrUnauthorized(c);

  try {
    const competencies = await c.env.DB.prepare(`
      WITH ranked_observations AS (
        SELECT
          o.id,
          o.competency_id,
          o.rubric_version_id,
          o.status,
          o.value_numeric,
          o.value_scale,
          o.evidence_manifest_ids_json,
          o.observed_at,
          o.recorded_at,
          ROW_NUMBER() OVER (
            PARTITION BY o.competency_id
            ORDER BY o.observed_at DESC, o.recorded_at DESC, o.id DESC
          ) AS observation_rank
        FROM hrd_program_competency_observations o
        WHERE o.enrollment_id = ?1 AND o.program_id = ?2
      )
      SELECT
        competency.id AS competency_id,
        competency.competency_code,
        competency.display_name AS competency_name,
        competency.status AS competency_status,
        competency.sort_order,
        active_rubric.id AS active_rubric_version_id,
        active_rubric.version AS active_rubric_version,
        active_rubric.criteria_json AS active_rubric_criteria_json,
        observation.id AS observation_id,
        observation.rubric_version_id AS observation_rubric_version_id,
        observation_rubric.version AS observation_rubric_version,
        observation.status AS observation_status,
        observation.value_numeric,
        observation.value_scale,
        observation.evidence_manifest_ids_json,
        observation.observed_at,
        observation.recorded_at
      FROM hrd_competencies competency
      LEFT JOIN ranked_observations observation
        ON observation.competency_id = competency.id
        AND observation.observation_rank = 1
      LEFT JOIN hrd_rubric_versions active_rubric
        ON active_rubric.id = competency.active_rubric_version_id
        AND active_rubric.program_id = competency.program_id
        AND active_rubric.competency_id = competency.id
      LEFT JOIN hrd_rubric_versions observation_rubric
        ON observation_rubric.id = observation.rubric_version_id
        AND observation_rubric.program_id = competency.program_id
        AND observation_rubric.competency_id = competency.id
      WHERE competency.program_id = ?2 AND competency.status = 'ACTIVE'
      ORDER BY competency.sort_order ASC, competency.id ASC
    `).bind(enrollmentId, programId).all<CompetencyDetailRow>();

    const activeCompetencyIds = new Set<string>();
    const latestObservations = new Map<string, {
      status: ObservationStatus;
      valueNumeric: number | null;
      valueScale: ValueScale | null;
      evidenceManifestIdsJson: string | null;
    }>();
    for (const row of competencies.results ?? []) {
      activeCompetencyIds.add(row.competency_id);
      if (row.observation_status !== null) {
        latestObservations.set(row.competency_id, {
          status: row.observation_status,
          valueNumeric: row.value_numeric,
          valueScale: row.value_scale,
          evidenceManifestIdsJson: row.evidence_manifest_ids_json,
        });
      }
    }
    const enrollmentEvidenceState = deriveEnrollmentEvidenceState(activeCompetencyIds, latestObservations);
    const competencyRows = (competencies.results ?? []).map((row) => {
      const evidenceState = observationEvidenceState(row);
      return {
        id: row.competency_id,
        code: row.competency_code,
        displayName: row.competency_name,
        status: row.competency_status,
        sortOrder: row.sort_order,
        rubricVersion: row.active_rubric_version_id === null ? null : {
          id: row.active_rubric_version_id,
          version: row.active_rubric_version,
          criteria: row.active_rubric_criteria_json === null ? null : JSON.parse(row.active_rubric_criteria_json) as unknown,
        },
        observation: {
          id: row.observation_id,
          rubricVersion: row.observation_rubric_version_id === null ? null : {
            id: row.observation_rubric_version_id,
            version: row.observation_rubric_version,
          },
          status: evidenceState,
          storedStatus: row.observation_status,
          value: evidenceState === 'MEASURED' ? row.value_numeric : null,
          valueScale: evidenceState === 'MEASURED' ? row.value_scale : null,
          evidenceManifestIds: evidenceState === 'UNAVAILABLE'
            ? null
            : validatedEvidenceManifestIds(
              row.observation_status,
              row.value_numeric,
              row.value_scale,
              row.evidence_manifest_ids_json,
            ),
          observedAt: row.observed_at,
          recordedAt: row.recorded_at,
        },
      };
    });

    return c.json({
      program: toProgramFromEnrollment(enrollment),
      enrollment: toEnrollment({ ...enrollment, evidence_state: enrollmentEvidenceState }),
      authorization: {
        programMembershipId: enrollment.membership_id,
        role: enrollment.membership_role,
        policyRevision: enrollment.membership_policy_revision,
        evaluatedAt: new Date().toISOString(),
      },
      competencies: competencyRows,
    });
  } catch (error) {
    console.error('[HRD] Enrollment-detail query unavailable:', error);
    return unavailable(c, 'HRD_PROGRAM_QUERY_UNAVAILABLE');
  }
});

export default hrdProgramRoute;
