import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AIRouteLane, AIRouteRequest, AIRouter, AIJSONValidator } from '../src/services/ai-router';
import { createStudentModel } from '../src/services/tutoring/student-model-engine';
import type { AnalyticsMessage, Bindings } from '../src/types';
import { batchExecute, batchExecuteSafe } from '../src/utils/d1-batch';
import { generateTokens } from '../src/services/auth';
import adminRoute from '../src/routes/admin';
import analyticsConsumer from '../workers/analytics-consumer/src/index';

const linucbEvents = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('../src/services/math/linucb-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/math/linucb-engine')>();
  return {
    ...actual,
    selectLinUCBAction: (...args: Parameters<typeof actual.selectLinUCBAction>) => {
      const choice = actual.selectLinUCBAction(...args);
      linucbEvents.events.push(`select:${choice.action}`);
      return choice;
    },
    updateLinUCBArm: (...args: Parameters<typeof actual.updateLinUCBArm>) => {
      linucbEvents.events.push(`update:${args[0].action}`);
      return actual.updateLinUCBArm(...args);
    },
  };
});

vi.mock('../src/services/tutoring/prompt-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/tutoring/prompt-registry')>();
  return {
    ...actual,
    buildActorUserPrompt: (input: Parameters<typeof actual.buildActorUserPrompt>[0]) => {
      linucbEvents.events.push(`generate:${input.selectedAction}`);
      return actual.buildActorUserPrompt(input);
    },
  };
});

const { createLinUCBArm } = await import('../src/services/math/linucb-engine');
const { processStudentTurn } = await import('../src/services/tutoring/orchestrator');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type PagesConfig = {
  ai?: { binding?: string };
  queues?: { producers?: Array<{ binding: string; queue: string }>; consumers?: unknown };
};

function readPagesConfig(): PagesConfig {
  const source = readFileSync(path.join(__dirname, '../wrangler.jsonc'), 'utf-8');
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, '')) as PagesConfig;
}

function parseConsumerToml(source: string) {
  const sections = new Map<string, Record<string, string | number>>();
  let current = 'root';
  sections.set(current, {});
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const section = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (section) {
      current = section[1];
      sections.set(current, {});
      continue;
    }
    const entry = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (!entry) continue;
    const [, key, rawValue] = entry;
    const quoted = /^"(.*)"$/.exec(rawValue);
    sections.get(current)![key] = quoted ? quoted[1] : Number(rawValue);
  }
  return sections;
}

function metadata(lane: AIRouteLane) {
  return { lane, provider: 'fixture', model: 'fixture', fallback: false, attemptCount: 1, latencyMs: 0 };
}

function linucbDatabase(events: string[]): D1Database {
  const selectedArm = createLinUCBArm('ask_counterexample');
  selectedArm.timesSelected = 11;
  selectedArm.totalReward = 6;
  const database = {
    prepare(sql: string) {
      const statement = {
        bind: (..._values: unknown[]) => statement,
        first: async () => null,
        all: async () => {
          if (sql.includes('FROM linucb_arms')) {
            return {
              results: [{
                action: selectedArm.action,
                a_matrix_json: JSON.stringify(selectedArm.A),
                b_vector_json: JSON.stringify(selectedArm.b),
                times_selected: selectedArm.timesSelected,
                total_reward: selectedArm.totalReward,
              }],
            };
          }
          return { results: [] };
        },
        run: async () => {
          if (sql.includes('INSERT OR REPLACE INTO linucb_arms')) events.push('persist-arm');
          if (sql.includes('INSERT OR IGNORE INTO linucb_experiment_log')) events.push('experiment-log');
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((statement) => statement.run())),
  };
  return database as unknown as D1Database;
}

function linucbRouter(): AIRouter {
  const evaluator = {
    claim_clarity: 3,
    evidence_use: 3,
    reasoning_strength: 3,
    consistency: 3,
    relevance: 3,
    next_action: 'ask_evidence',
    hint_level: 0,
    weakness_tags: ['근거 부족'],
    diagnosis: 'Name the evidence and its causal link.',
    claim: 'The policy should change.',
    evidence_source_ids: [],
    evidence_detected: [],
    reasoning_gap: 'causal connection',
    student_implicit_assumptions: [],
    alternative_interpretations: [],
    reasoning_chain_weakest_link: 'warrant',
    cognitive_level: 'analysis',
    misconceptions: [],
    student_growth_since_last_turn: 'stagnant',
  };
  const payloads: Record<string, unknown> = {
    learner_evaluation: evaluator,
    interactive_generation: { aiReply: 'What counterexample would test that causal link?', questionType: 'counterexample' },
    release_critic: {
      leakageScore: 0,
      bloomLevel: 'create',
      bloomCompliant: true,
      passed: true,
      issues: [],
      suggestions: [],
      reasoning: 'Fixture critic pass.',
      engagementScore: 90,
      quotesStudentWords: true,
      isGenericQuestion: false,
      intellectualTension: 80,
      diversityFromPrevious: 80,
    },
  };
  return {
    async completeValidatedJSON<T>(lane: AIRouteLane, _request: AIRouteRequest, validate: AIJSONValidator<T>) {
      const value = validate(payloads[lane]);
      if (value === null) throw new Error(`Invalid ${lane} fixture`);
      return { value, metadata: metadata(lane) };
    },
  } as AIRouter;
}

function analyticsBody(sessionId: string, topic = 'policy') {
  return {
    sessionId, userId: null, topic, bookTitle: 'fixture', coreClaim: '', currentClaim: '',
    radarScores: {}, avgLogic: 0, totalEvidenceCited: 0, weaknessPattern: [], conversationHistory: [],
  };
}

function analyticsMessage(body: ReturnType<typeof analyticsBody>, attempts: number) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function analyticsDatabase(failSessionId?: string) {
  const persistedSessions: string[] = [];
  const database = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind: (...bound: unknown[]) => {
          values = bound;
          return statement;
        },
        run: async () => {
          if (sql.includes('INSERT OR REPLACE INTO session_deep_reports')) {
            if (values[1] === failSessionId) throw new Error('fixture D1 persistence failure');
            persistedSessions.push(String(values[1]));
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
  return { database: database as unknown as D1Database, persistedSessions };
}

function stubAnalyticsSuccess() {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        argNodes: [], argEdges: [], microMetrics: {}, prescriptiveFeedback: '', growthTrajectory: '', strengths: [], weaknesses: [],
      }) } }],
    }),
  }));
}

describe('current production boundary contracts', () => {
  it('selects the LinUCB action before actor generation and updates/logs that accepted action afterward', async () => {
    linucbEvents.events = [];
    const result = await processStudentTurn({
      router: linucbRouter(),
      sessionId: 'linucb-contract',
      currentState: 'reasoning',
      studentModel: createStudentModel('linucb-contract', 'policy'),
      studentMessage: 'The policy needs evidence and a causal warrant.',
      bookText: 'Policy evidence describes counterexamples and causal limits.',
      conversationHistory: [],
      turnNumber: 2,
      maxTurns: 10,
      db: linucbDatabase(linucbEvents.events),
      userId: 'learner-contract',
      challengeState: { currentLevel: 2, history: [], consecutiveSuccess: 0, consecutiveStruggle: 0 },
    });

    expect(result.action).toBe('ask_counterexample');
    expect(linucbEvents.events).toEqual([
      'select:ask_counterexample',
      'generate:ask_counterexample',
    ]);

    await result.runAcceptedSideEffects();
    expect(linucbEvents.events).toEqual(expect.arrayContaining([
      'update:ask_counterexample',
      'persist-arm',
      'experiment-log',
    ]));
    expect(linucbEvents.events.indexOf('generate:ask_counterexample')).toBeLessThan(
      linucbEvents.events.indexOf('update:ask_counterexample'),
    );
  });

  it('chunks D1 statements deterministically and continues non-critical batches after a failed chunk', async () => {
    const statements = Array.from({ length: 5 }, (_unused, index) => ({ id: index })) as unknown as D1PreparedStatement[];
    const chunks: number[][] = [];
    const database = {
      batch: vi.fn(async (chunk: Array<{ id: number }>) => {
        chunks.push(chunk.map(({ id }) => id));
        return chunk.map(({ id }) => ({ success: true, meta: { changes: id } }));
      }),
    } as unknown as D1Database;

    const results = await batchExecute(database, statements, 2);
    expect(chunks).toEqual([[0, 1], [2, 3], [4]]);
    expect(results).toHaveLength(3);

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const safeChunks: number[][] = [];
    const safeDatabase = {
      batch: vi.fn(async (chunk: Array<{ id: number }>) => {
        safeChunks.push(chunk.map(({ id }) => id));
        if (safeChunks.length === 1) throw new Error('fixture batch failure');
        return [];
      }),
    } as unknown as D1Database;
    await expect(batchExecuteSafe(safeDatabase, statements, 2)).resolves.toBeUndefined();
    warning.mockRestore();
    expect(safeChunks).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('persists ARC teacher feedback and a versioned weight snapshot through the HTTP endpoint', async () => {
    let feedbackCount = 9;
    const feedbackWrites: unknown[][] = [];
    const snapshotWrites: unknown[][] = [];
    const database = {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind: (...bound: unknown[]) => {
            values = bound;
            return statement;
          },
          first: async () => {
            if (sql.includes('COUNT(*) as cnt FROM arc_teacher_feedback')) return { cnt: feedbackCount };
            if (sql.includes('FROM arc_weight_snapshots')) return { version: 4, weights_json: JSON.stringify({ support: [0.3], attack: [0.3], neutral: [0.3] }) };
            return null;
          },
          all: async () => ({
            results: Array.from({ length: 10 }, (_unused, index) => ({
              predicted_arc: index === 0 ? 'support' : 'attack',
              gold_arc: 'attack',
            })),
          }),
          run: async () => {
            if (sql.includes('INSERT OR REPLACE INTO arc_teacher_feedback')) {
              feedbackCount += 1;
              feedbackWrites.push(values);
            }
            if (sql.includes('INSERT INTO arc_weight_snapshots')) snapshotWrites.push(values);
            return { success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
    } as unknown as D1Database;

    const jwtSecret = 'arc-admin-fixture';
    const token = (await generateTokens({
      id: 'arc-admin', username: 'arc-admin', email: 'arc-admin@example.test', studentId: null,
      grade: null, role: 'admin', createdAt: 1, lastLogin: null, isActive: true,
    }, jwtSecret)).accessToken;
    const response = await adminRoute.request('/api/admin/arc-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: 'arc-session', turnNumber: 2, predictedArc: 'support', goldArc: 'attack' }),
    }, { DB: database, JWT_SECRET: jwtSecret } as Bindings);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, weightUpdate: { updated: true, version: 5 } });
    expect(feedbackWrites).toHaveLength(1);
    expect(feedbackWrites[0]).toEqual(expect.arrayContaining(['arc-session', 2, 'support', 'attack']));
    expect(snapshotWrites).toHaveLength(1);
    expect(snapshotWrites[0]).toEqual(expect.arrayContaining([5, 10, 0.9]));
  });

  it('keeps the Pages producer separate from the parsed deployed analytics-consumer configuration', () => {
    const pages = readPagesConfig();
    expect(pages.ai?.binding).toBe('AI');
    expect(pages.queues?.producers).toEqual([
      { binding: 'ANALYTICS_QUEUE', queue: 'socratic-analytics-queue' },
    ]);
    expect(pages.queues?.consumers).toBeUndefined();

    const consumer = parseConsumerToml(readFileSync(path.join(__dirname, '../workers/analytics-consumer/wrangler.toml'), 'utf-8'));
    expect(consumer.get('root')).toMatchObject({ name: 'socratic-analytics-consumer', main: 'src/index.ts' });
    expect(consumer.get('queues.consumers')).toEqual({
      queue: 'socratic-analytics-queue',
      max_batch_size: 5,
      max_batch_timeout: 30,
      max_retries: 3,
      dead_letter_queue: 'socratic-analytics-dlq',
    });
    expect(consumer.get('d1_databases')).toMatchObject({ binding: 'DB', database_name: 'socratic-ai-db' });
  });

  it('retries failed one-based attempts 1, 2, and 3 without acknowledging any failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { database } = analyticsDatabase();
    const messages = [1, 2, 3].map((attempts) => analyticsMessage(analyticsBody(`failed-${attempts}`), attempts));

    await analyticsConsumer.queue({ messages } as unknown as MessageBatch<AnalyticsMessage>, {
      DB: database, SOONGSIL_API_KEY: '', GEMINI_API_KEY: '',
    });

    for (const message of messages) {
      expect(message.retry).toHaveBeenCalledOnce();
      expect(message.ack).not.toHaveBeenCalled();
    }
  });

  it('acknowledges a successful mocked analysis and D1 persistence once without retrying', async () => {
    const { database, persistedSessions } = analyticsDatabase();
    const message = analyticsMessage(analyticsBody('successful'), 1);
    const fetch = stubAnalyticsSuccess();
    vi.stubGlobal('fetch', fetch);

    await analyticsConsumer.queue({ messages: [message] } as unknown as MessageBatch<AnalyticsMessage>, {
      DB: database, SOONGSIL_API_KEY: '[REDACTED]', GEMINI_API_KEY: '',
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(persistedSessions).toEqual(['successful']);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('isolates a successful message from a D1-persistence failure in the same batch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { database, persistedSessions } = analyticsDatabase('failed');
    const successful = analyticsMessage(analyticsBody('successful'), 1);
    const failed = analyticsMessage(analyticsBody('failed'), 1);
    vi.stubGlobal('fetch', stubAnalyticsSuccess());

    await analyticsConsumer.queue({ messages: [successful, failed] } as unknown as MessageBatch<AnalyticsMessage>, {
      DB: database, SOONGSIL_API_KEY: '[REDACTED]', GEMINI_API_KEY: '',
    });

    expect(persistedSessions).toEqual(['successful']);
    expect(successful.ack).toHaveBeenCalledOnce();
    expect(successful.retry).not.toHaveBeenCalled();
    expect(failed.retry).toHaveBeenCalledOnce();
    expect(failed.ack).not.toHaveBeenCalled();
  });

  it('keeps the selected critical-path cast policy local to production boundaries', () => {
    const criticalPathFiles = [
      '../src/index.tsx',
      '../src/routes/training.ts',
      '../src/routes/vectorize.ts',
      '../src/services/workers-embeddings.ts',
      '../workers/analytics-consumer/src/index.ts',
    ];
    for (const file of criticalPathFiles) {
      expect(readFileSync(path.join(__dirname, file), 'utf-8')).not.toMatch(/\bas any\b/);
    }
  });

  it('retains the explicit current infrastructure bindings as a type and runtime contract', () => {
    const bindings: Pick<Bindings, 'DB' | 'SOONGSIL_API_KEY' | 'GEMINI_API_KEY' | 'JWT_SECRET' | 'VECTORIZE_INDEX' | 'ANALYTICS_QUEUE' | 'AI' | 'ARGUNET_ADAPTER_URL' | 'ARGUNET_ADAPTER_TOKEN'> = {
      DB: {} as D1Database,
      SOONGSIL_API_KEY: '[REDACTED]',
      GEMINI_API_KEY: '[REDACTED]',
      JWT_SECRET: 'fixture',
      VECTORIZE_INDEX: {} as VectorizeIndex,
      ANALYTICS_QUEUE: {} as Queue<AnalyticsMessage>,
      AI: {} as Ai,
      ARGUNET_ADAPTER_URL: 'https://adapter.invalid',
      ARGUNET_ADAPTER_TOKEN: 'fixture',
    };
    expect(Object.keys(bindings).sort()).toEqual([
      'AI', 'ANALYTICS_QUEUE', 'ARGUNET_ADAPTER_TOKEN', 'ARGUNET_ADAPTER_URL', 'DB', 'GEMINI_API_KEY', 'JWT_SECRET', 'SOONGSIL_API_KEY', 'VECTORIZE_INDEX',
    ]);
  });

  it('keeps the historical v21 infrastructure migration additive', () => {
    const migration = readFileSync(path.join(__dirname, '../migrations/0023_v21_infra_optimization.sql'), 'utf-8');
    expect(migration).toContain('arc_weight_snapshots');
    expect(migration).toContain('queue_dead_letter_log');
  });
});
