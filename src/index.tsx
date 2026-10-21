// SocraticAI v34.0 - Main Entry Point
// v34: DeepSeek V3.2 Transition, In-Basket Case Study System, Provider Registry, Indicator Registry (200+)
// v33: Module Bridge (NC-001), Role-based Tab Access (NC-003), Dynamic Fidelity (NC-005), Empty Catch Fix (P1-004), ClassChat WS Scaffolding
// v32: DeepSkill Fidelity 100 — ClassChat Peer Learning, PDF Export, Enterprise HRD Dashboard, Full Integration
// v31: Enterprise Dashboard, xAIF Canvas Editor, Knowledge Graph Enhancement, Walton Critical Questions
// v30: Argument Scheme Engine (Walton 10+), Canvas UI Interactive, DeepSkill Fidelity Calculator, Migration 0028
// v29: Module Integration Fix (C-001 RESOLVED), Tailwind PostCSS Flag Fix (C-002 RESOLVED), Password Form Fix, Audit Accuracy
// v28: Workers 3-type Deployment, 13 Module Files Created, BKT/LinUCB Frontend, xAIF Live Session
// v27: LLM-based ArguNet DA, app.js Modular Architecture, Hybrid KT Session Integration, xAIF D3.js Graph
// v26: ArguNet DA Classification, oAMF Pipeline, BKT/LinUCB Hybrid Engine, DDA Engine, PWA, Dark Mode
// v25: :any Elimination (0 remaining), Mobile UI, ES Module Architecture, 18-Axis Radar Integration
// v24: Type Safety Completion, 18-Axis Radar, Scenario Lab, Category Hierarchy
// v23: Infrastructure Completion — Queue Consumer, DO Debate, ZKP Provider, Security, Teacher Dashboard UI
// v16: DeepSkill Argumentation Intelligence Layer
// v17: Pressure Move, Micro Scoring, xAIF Snapshot, ELO-BKT Link
// v18: xAIF V2 (L-node/TA-edge/CASS), Illocutionary Force, Process Evaluator
// v19: BUG-101~106 Full Fix, Hybrid KT Integration, LinUCB Experiment,
//      Probabilistic ARC, CASS Benchmark, JSON-LD, Session Process Evaluation
// v20: P0 Remediation (HybridKT data loop, LinUCB real selection, Self-CASS fix,
//      JSON-LD export, Adapter-aware ARC), Vectorize RAG, Debate Arena, ZKP Badges
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Bindings } from './types';
import chatRoute from './routes/chat';
import sessionRoute from './routes/session';
import hintRoute from './routes/hint';
import booksRoute from './routes/books';
import historyRoute from './routes/history';
import authRoute from './routes/auth';
import adminRoute from './routes/admin';
import analyticsRoute from './routes/analytics';
import trainingRoute from './routes/training';
import dashboardRoute from './routes/dashboard';
import deepskillRoute from './routes/deepskill';
import talentRoute from './routes/talent-analytics';
import { teacherRoute } from './routes/teacher-dashboard';
// v20: New routes
import { xaifRoute } from './routes/xaif';
import { vectorizeRoute } from './routes/vectorize';
import { debateRoute } from './routes/debate';
import { badgeRoute } from './routes/badge';
import { scenarioRoute } from './routes/scenario';
// v26: ArguNet + oAMF + Hybrid KT
import { argunetRoute } from './routes/argunet';
// v31: Enterprise HRD Dashboard
import { enterpriseRoute } from './routes/enterprise';
// v32: ClassChat Peer Learning
import { classchatRoute } from './routes/classchat';
// v33: ODE (OpenDebateEvidence) integration
import { odeRoute } from './routes/ode';
// v34: In-Basket Case Study System
import caseStudyRoutes from './routes/case-study';
// v35: Neural Wiki + Synapse Update
import { knowledgeGraphRoute } from './routes/knowledge-graph';
// v35: Taiji Engine
import { taijiRoute } from './routes/taiji';
// v35: Knowledge Tracing (BKT) — T2.4.1 선제
import ktRoute from './routes/kt';
// v35: LinUCB Contextual Bandit — T1.4.4
import banditRoute from './routes/bandit';
// v35: Metacognition Calibration Widget — T1.5.2
import metacognitionRoute from './routes/metacognition';
import hrdProgramRoute from './routes/hrd-program';
import growthRoute from './routes/growth';
import { seedBuiltinBooks } from './services/student-model';
// v15: Static HTML served from public/index.html via Cloudflare Pages
// No longer need getMainHTML() — frontend is fully separated
import { getAllBooks } from './data/books';
import { describeAIRouting, getAIRoutingRuntimeHealth } from './services/ai-router';

const app = new Hono<{ Bindings: Bindings }>();

// CORS
app.use('/api/*', cors());

// DB initialization middleware - seed built-in books on first request
app.use('/api/*', async (c, next) => {
  try {
    if (c.env.DB) {
      await seedBuiltinBooks(c.env.DB, getAllBooks());
    }
  } catch (e) {
    console.error('DB seed check:', e);
  }
  await next();
});

// API Routes
app.route('/', authRoute);
app.route('/', adminRoute);
app.route('/', analyticsRoute);
app.route('/', chatRoute);
app.route('/', sessionRoute);
app.route('/', hintRoute);
app.route('/', booksRoute);
app.route('/', historyRoute);
app.route('/', trainingRoute);
app.route('/', dashboardRoute);
app.route('/', deepskillRoute);
app.route('/', talentRoute);
app.route('/', teacherRoute);
// v20: New feature routes
app.route('/', xaifRoute);
app.route('/', vectorizeRoute);
app.route('/', debateRoute);
app.route('/', badgeRoute);
// v24: New feature routes
app.route('/', scenarioRoute);
// v26: ArguNet + oAMF + Hybrid KT routes
app.route('/', argunetRoute);
// v31: Enterprise HRD Dashboard
app.route('/', enterpriseRoute);
// v32: ClassChat Peer Learning
app.route('/', classchatRoute);
// v33: ODE (OpenDebateEvidence) integration
app.route('/', odeRoute);
// v34: In-Basket Case Study System
app.route('/api/case-study', caseStudyRoutes);
// v35: Neural Wiki Node Schema + Synapse Updater
app.route('/', knowledgeGraphRoute);
// v35: Taiji Engine
app.route('/', taijiRoute);
// v35: Knowledge Tracing (BKT) — routes already prefixed with /api/kt internally
app.route('/', ktRoute);
// v35: LinUCB Contextual Bandit — mount at /api/bandit (internal routes are /choose, /update)
app.route('/api/bandit', banditRoute);
// v35: Metacognition Calibration Widget — T1.5.2
app.route('/', metacognitionRoute);
// v35.1: Explicit program-scoped HRD read model
app.route('/', hrdProgramRoute);
// v36: Private participant Growth Cycle API
app.route('/', growthRoute);

const APP_RELEASE = '35.1.0';
const REQUIRED_MIGRATION = '0082_training_argument_graph.sql';
type TrainingJourneyProbe = {
  table: string;
  query: string;
};

const TRAINING_JOURNEY_PROBES = [
  {
    table: 'training_session_contexts',
    query: 'SELECT id, session_id, owner_user_id, evidence_manifest_sha256, route_plan_json, prompt_cache_namespace, evidence_policy_revision, status FROM training_session_contexts LIMIT 1',
  },
  {
    table: 'training_scenario_packs',
    query: 'SELECT session_id, evidence_manifest_sha256, case_id, case_version, case_contract_sha256 FROM training_scenario_packs LIMIT 1',
  },
  {
    table: 'training_heldout_attempts',
    query: 'SELECT id, base_session_id, owner_user_id, operator_user_id, case_id, case_version, opaque_variant_id, adapter_manifest_sha256, source_manifest_sha256, task_sha256 FROM training_heldout_attempts LIMIT 1',
  },
  {
    table: 'training_heldout_attempt_events',
    query: 'SELECT id, attempt_id, revision, event_type, actor_user_id, mutation_key, missingness, response_sha256, assistance_ids_json, contamination_code, created_at FROM training_heldout_attempt_events LIMIT 1',
  },
  {
    table: 'training_heldout_variant_quarantines',
    query: 'SELECT opaque_variant_id, contamination_code, quarantined_at FROM training_heldout_variant_quarantines LIMIT 1',
  },
  {
    table: 'training_session_context_deletion_authorizations',
    query: 'SELECT session_context_id, authorization_id, created_at FROM training_session_context_deletion_authorizations LIMIT 1',
  },
  {
    table: 'training_argument_nodes',
    query: 'SELECT id, session_id, turn_number, node_type, author, is_grounded FROM training_argument_nodes LIMIT 1',
  },
  {
    table: 'training_argument_edges',
    query: 'SELECT id, session_id, from_node_id, to_node_id, relation_type FROM training_argument_edges LIMIT 1',
  },
] as const satisfies readonly TrainingJourneyProbe[];
type TrainingJourneyTable = typeof TRAINING_JOURNEY_PROBES[number]['table'];
type DebateRuntimeProbeStatus = 'not_configured' | 'token_missing' | 'configured_unverified' | 'unavailable' | 'ready';

function isPlainHealthObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function probeDebateRuntime(url: string, serviceToken: string): Promise<{
  status: DebateRuntimeProbeStatus;
  httpStatus: number | null;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) return { status: 'unavailable', httpStatus: response.status };
    const payload = await response.json() as unknown;
    if (!isPlainHealthObject(payload) || payload.status !== 'ok' || !isPlainHealthObject(payload.checks)
      || payload.checks.runtimeServiceToken !== 'configured'
      || payload.checks.provider !== 'configured'
      || payload.checks.d1 !== 'ready') {
      return { status: 'unavailable', httpStatus: response.status };
    }
    return { status: 'ready', httpStatus: response.status };
  } catch (error) {
    console.error('[Health] Debate runtime readiness probe was not conclusive:', error);
    return { status: 'configured_unverified', httpStatus: null };
  } finally {
    clearTimeout(timeout);
  }
}

// Operational health: liveness is local; readiness is based on a real D1 probe plus
// the minimum configured secrets/providers required to serve authenticated AI flows.
app.get('/api/health', async (c) => {
  let database: {
    status: 'ready' | 'migration_required' | 'unavailable';
    latestMigration: string | null;
    requiredMigration: string;
  } = {
    status: 'unavailable',
    latestMigration: null,
    requiredMigration: REQUIRED_MIGRATION,
  };

  try {
    const [latest, required] = await Promise.all([
      c.env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<{ name: string }>(),
      c.env.DB.prepare('SELECT name FROM d1_migrations WHERE name = ?1 LIMIT 1')
        .bind(REQUIRED_MIGRATION).first<{ name: string }>(),
    ]);
    database = {
      status: required ? 'ready' : 'migration_required',
      latestMigration: latest?.name || null,
      requiredMigration: REQUIRED_MIGRATION,
    };
  } catch (error) {
    console.error('[Health] D1 readiness probe failed:', error);
    database = { status: 'unavailable', latestMigration: null, requiredMigration: REQUIRED_MIGRATION };
  }

  let trainingJourney: {
    status: 'ready' | 'migration_required' | 'unavailable';
    requiredMigration: string;
    tableProbe: 'passed' | 'not_run' | 'failed';
    reason: 'migration_required' | 'journey_table_unavailable' | null;
    unavailableTable: TrainingJourneyTable | null;
  } = {
    status: database.status,
    requiredMigration: REQUIRED_MIGRATION,
    tableProbe: 'not_run',
    reason: database.status === 'migration_required' ? 'migration_required' : null,
    unavailableTable: null,
  };
  if (database.status === 'ready') {
    let probedTable: TrainingJourneyTable | null = null;
    try {
      for (const probe of TRAINING_JOURNEY_PROBES) {
        probedTable = probe.table;
        await c.env.DB.prepare(probe.query).first<Record<string, unknown>>();
      }
      trainingJourney = {
        status: 'ready',
        requiredMigration: REQUIRED_MIGRATION,
        tableProbe: 'passed',
        reason: null,
        unavailableTable: null,
      };
    } catch (error) {
      console.error('[Health] Training journey readiness probe failed:', error);
      trainingJourney = {
        status: 'unavailable',
        requiredMigration: REQUIRED_MIGRATION,
        tableProbe: 'failed',
        reason: 'journey_table_unavailable',
        unavailableTable: probedTable,
      };
    }
  }

  const jwtConfigured = Boolean(c.env.JWT_SECRET);
  const growthHmacSecretConfigured = typeof c.env.GROWTH_CYCLE_HMAC_SECRET === 'string'
    && c.env.GROWTH_CYCLE_HMAC_SECRET.trim().length > 0;
  const aiRouting = describeAIRouting(c.env);
  const aiRuntime = await getAIRoutingRuntimeHealth(c.env);
  const aiRuntimeVerified = aiRuntime.status === 'verified';
  const debateRuntimeConfigured = Boolean(c.env.DEBATE_WORKER_URL?.trim());
  const debateRuntimeTokenConfigured = Boolean(c.env.DEBATE_RUNTIME_SERVICE_TOKEN?.trim());
  let debateRuntime: { status: DebateRuntimeProbeStatus; httpStatus: number | null } = {
    status: debateRuntimeConfigured ? 'token_missing' : 'not_configured',
    httpStatus: null,
  };
  if (debateRuntimeConfigured && debateRuntimeTokenConfigured) {
    debateRuntime = await probeDebateRuntime(
      c.env.DEBATE_WORKER_URL!.trim(),
      c.env.DEBATE_RUNTIME_SERVICE_TOKEN!.trim(),
    );
  }
  const debateRuntimeReady = !debateRuntimeConfigured || debateRuntime.status === 'ready';
  const growthCycle = {
    status: database.status === 'ready'
      ? (growthHmacSecretConfigured ? 'ready' : 'unavailable')
      : database.status,
    hmacSecretConfigured: growthHmacSecretConfigured,
    migrationApplied: database.status === 'ready'
      ? true
      : database.status === 'migration_required'
        ? false
        : null,
    requiredMigration: REQUIRED_MIGRATION,
  };
  const readiness = database.status === 'ready' && trainingJourney.status === 'ready' && growthCycle.status === 'ready'
    && jwtConfigured && aiRuntimeVerified && debateRuntimeReady
    ? 'ready'
    : 'degraded';

  return c.json({
    status: readiness === 'ready' ? 'ok' : 'degraded',
    liveness: 'ok',
    readiness,
    service: 'SocraticAI',
    version: APP_RELEASE,
    checkedAt: new Date().toISOString(),
    checks: {
      database,
      trainingJourney,
      growthCycle,
      jwt: { status: jwtConfigured ? 'configured' : 'unconfigured' },
      aiRouting: {
        ...aiRouting,
        runtimeVerification: aiRuntime.status,
        requiredPrimaryRoutes: aiRuntime.requiredPrimaryRoutes,
        nonReadinessLanes: aiRuntime.nonReadinessLanes,
        freshnessWindowMs: aiRuntime.freshnessWindowMs,
        checkedAt: aiRuntime.checkedAt,
        readinessRule: 'Configured routes require fresh successful redacted invocation receipts; a missing receipt schema fails closed.',
      },
      debateRuntime: {
        status: debateRuntime.status,
        httpStatus: debateRuntime.httpStatus,
      },
      workersAI: { status: c.env.AI ? 'configured_unverified' : 'unconfigured' },
      vectorize: { status: c.env.VECTORIZE_INDEX ? 'configured_unverified' : 'unconfigured' },
      analyticsQueue: { status: c.env.ANALYTICS_QUEUE ? 'configured_unverified' : 'unconfigured' },
    },
  }, readiness === 'ready' ? 200 : 503);
});

// v15: Static files (index.html, /static/*) are served by Cloudflare Pages CDN
// The _routes.json in dist/ controls which paths go to _worker.js vs static

export default app;
