import { describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/types';

vi.mock('../src/services/student-model', () => ({
  seedBuiltinBooks: vi.fn(async () => undefined),
}));

vi.mock('../src/services/ai-router', () => ({
  describeAIRouting: () => ({}),
  getAIRoutingRuntimeHealth: vi.fn(async () => ({
    status: 'unverified',
    requiredPrimaryRoutes: [],
    nonReadinessLanes: [],
    freshnessWindowMs: 0,
    checkedAt: '2026-09-07T00:00:00.000Z',
  })),
}));

import app from '../src/index';

type HealthFixture = {
  migrations: readonly string[];
  unavailableTable?: string;
  unavailableColumn?: string;
};

const EXPECTED_TRAINING_JOURNEY_PROBES = [
  {
    table: 'training_session_contexts',
    columns: ['id', 'session_id', 'owner_user_id', 'evidence_manifest_sha256', 'route_plan_json', 'prompt_cache_namespace', 'evidence_policy_revision', 'status'],
  },
  {
    table: 'training_scenario_packs',
    columns: ['session_id', 'evidence_manifest_sha256', 'case_id', 'case_version', 'case_contract_sha256'],
  },
  {
    table: 'training_heldout_attempts',
    columns: ['id', 'base_session_id', 'owner_user_id', 'operator_user_id', 'case_id', 'case_version', 'opaque_variant_id', 'adapter_manifest_sha256', 'source_manifest_sha256', 'task_sha256'],
  },
  {
    table: 'training_heldout_attempt_events',
    columns: ['id', 'attempt_id', 'revision', 'event_type', 'actor_user_id', 'mutation_key', 'missingness', 'response_sha256', 'assistance_ids_json', 'contamination_code', 'created_at'],
  },
  {
    table: 'training_heldout_variant_quarantines',
    columns: ['opaque_variant_id', 'contamination_code', 'quarantined_at'],
  },
  {
    table: 'training_session_context_deletion_authorizations',
    columns: ['session_context_id', 'authorization_id', 'created_at'],
  },
  {
    table: 'training_argument_nodes',
    columns: ['id', 'session_id', 'turn_number', 'node_type', 'author', 'is_grounded'],
  },
  {
    table: 'training_argument_edges',
    columns: ['id', 'session_id', 'from_node_id', 'to_node_id', 'relation_type'],
  },
] as const;

function healthEnvironment(fixture: HealthFixture) {
  const migrations = new Set(fixture.migrations);
  const latestMigration = fixture.migrations.at(-1) ?? null;
  const preparedQueries: string[] = [];
  const database = {
    prepare(sql: string) {
      preparedQueries.push(sql);
      const table = /\bFROM ([a-z_]+)/.exec(sql)?.[1];
      return {
        first: async () => {
          if (sql.includes('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')) {
            return latestMigration ? { name: latestMigration } : null;
          }
          if (table) {
            if (table === fixture.unavailableTable) throw new Error(`${table} unavailable`);
            if (fixture.unavailableColumn && sql.includes(fixture.unavailableColumn)) {
              throw new Error(`${table}.${fixture.unavailableColumn} unavailable`);
            }
            return { present: 1 };
          }
          return null;
        },
        bind: (...parameters: unknown[]) => ({
          first: async () => migrations.has(String(parameters[0]))
            ? { name: String(parameters[0]) }
            : null,
        }),
      };
    },
  };
  return { environment: { DB: database } as unknown as Bindings, preparedQueries };
}

async function readHealth(fixture: HealthFixture) {
  const { environment, preparedQueries } = healthEnvironment(fixture);
  const response = await app.request('/api/health', {}, environment);
  return { response, body: await response.json() as Record<string, unknown>, preparedQueries };
}

function trainingJourneyProbes(preparedQueries: readonly string[]) {
  const expectedTables = new Set(EXPECTED_TRAINING_JOURNEY_PROBES.map(({ table }) => table));
  return preparedQueries.flatMap((query) => {
    const match = /^SELECT (.+) FROM ([a-z_]+) LIMIT 1$/.exec(query);
    if (!match || !expectedTables.has(match[2])) return [];
    return [{ table: match[2], columns: match[1].split(', ') }];
  });
}

describe('Training-first health readiness', () => {
  it('reports the final Training migration as required when only 0064 is recorded', async () => {
    const { response, body } = await readHealth({
      migrations: ['0064_training_session_context.sql'],
    });

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: 'degraded',
      readiness: 'degraded',
      checks: {
        database: {
          status: 'migration_required',
          requiredMigration: '0082_training_argument_graph.sql',
        },
      },
    });
  });

  it('reports the specific Training journey table that cannot be queried', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { response, body } = await readHealth({
      migrations: ['0064_training_session_context.sql', '0082_training_argument_graph.sql'],
      unavailableTable: 'training_heldout_attempt_events',
    });
    errorSpy.mockRestore();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: 'degraded',
      checks: {
        trainingJourney: {
          status: 'unavailable',
          reason: 'journey_table_unavailable',
          unavailableTable: 'training_heldout_attempt_events',
        },
      },
    });
  });

  it('degrades readiness when a Training argument graph table is unavailable', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { response, body } = await readHealth({
      migrations: ['0064_training_session_context.sql', '0082_training_argument_graph.sql'],
      unavailableTable: 'training_argument_edges',
    });
    errorSpy.mockRestore();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: 'degraded',
      checks: {
        trainingJourney: {
          status: 'unavailable',
          reason: 'journey_table_unavailable',
          unavailableTable: 'training_argument_edges',
        },
      },
    });
  });

  it('probes the Training-owned context table rather than the unrelated learning context table', async () => {
    const { response, body } = await readHealth({
      migrations: ['0064_training_session_context.sql', '0082_training_argument_graph.sql'],
      unavailableTable: 'learning_session_contexts',
    });

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      checks: {
        trainingJourney: {
          status: 'ready',
          tableProbe: 'passed',
          unavailableTable: null,
        },
      },
    });
  });

  it('fails closed when a 0079 case-contract column cannot be queried', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { response, body } = await readHealth({
      migrations: ['0064_training_session_context.sql', '0082_training_argument_graph.sql'],
      unavailableColumn: 'case_contract_sha256',
    });
    errorSpy.mockRestore();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      checks: {
        trainingJourney: {
          status: 'unavailable',
          reason: 'journey_table_unavailable',
          unavailableTable: 'training_scenario_packs',
        },
      },
    });
  });

  it('reports complete local Training schema separately from missing runtime configuration', async () => {
    const { response, body, preparedQueries } = await readHealth({
      migrations: ['0064_training_session_context.sql', '0082_training_argument_graph.sql'],
    });

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: 'degraded',
      checks: {
        database: {
          status: 'ready',
          requiredMigration: '0082_training_argument_graph.sql',
        },
        trainingJourney: {
          status: 'ready',
          requiredMigration: '0082_training_argument_graph.sql',
          tableProbe: 'passed',
        },
        jwt: { status: 'unconfigured' },
      },
    });
    expect(trainingJourneyProbes(preparedQueries)).toEqual(EXPECTED_TRAINING_JOURNEY_PROBES);
  });
});
