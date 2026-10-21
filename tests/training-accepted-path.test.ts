import { Hono } from 'hono';
import growthRoute from '../src/routes/growth';
import { launchRecheckFollowUp, deleteGrowthCycle } from '../src/services/growth-cycle';
import { createHash, createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { AIJSONValidator, AIRouteLane, AIRouteRequest, AIRouter } from '../src/services/ai-router';
import type { Bindings } from '../src/types';
import type { GrowthCycleDetail } from '../src/services/growth-cycle-types';
import { generateTokens } from '../src/services/auth';
import { recordPrivateSoloConsent, ensureSoloGrowthSpace, openGrowthCycle, loadGrowthCycle, selectGrowthFocus, respondToPractice, recordRecheck } from '../src/services/growth-cycle';
import { loadTrainingRoute, reviseTrainingRoute } from '../src/services/training/training-route';
import { declareLearnerRevision, loadLearnerRevisions } from '../src/services/training/learner-revision';
import { requestTrainingIntervention, loadTrainingInterventions, guardTrainingIntervention } from '../src/services/training/interventions';
import { readOwnedTrainingHistorySupplements } from '../src/services/training/history-supplements';
import { createMigratedLearningDatabase } from './fixtures/learning-engine-db';
import { readPriorAcceptedRevisionAttempts } from '../src/services/tutoring/revision-attempts';

const seams = vi.hoisted(() => ({ router: null as AIRouter | null, scenario: {} as unknown, routerOptions: [] as unknown[], requests: [] as Array<{ lane: string; request: AIRouteRequest }>, beforeGeneration: null as (() => Promise<void>) | null, beforeEvaluation: null as (() => Promise<void>) | null }));
vi.mock('../src/services/ai-client', async (original) => {
  const actual = await original<typeof import('../src/services/ai-client')>();
  return { ...actual, callAIJSONWithEnv: async () => seams.scenario };
});
vi.mock('../src/services/ai-router', async (original) => {
  const actual = await original<typeof import('../src/services/ai-router')>();
  return { ...actual, createAIRouter: (...args: Parameters<typeof actual.createAIRouter>) => {
    seams.routerOptions.push(args[1]);
    if (!seams.router) throw new Error('No deterministic provider fixture');
    return seams.router;
  } };
});
const { startTrainingSession, respondTrainingSession, provideTrainingSupport, trainingRoute } = await import('../src/routes/training');
const { default: historyRoute } = await import('../src/routes/history');
const databases: DatabaseSync[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); seams.router = null; seams.routerOptions = []; seams.requests = []; seams.beforeEvaluation = null; seams.beforeGeneration = null; for (const db of databases.splice(0)) db.close(); });

function seed() {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network call in offline learner fixture'); }));
  const fixture = createMigratedLearningDatabase();
  databases.push(fixture.sqlite);
  const { sqlite } = fixture;
  sqlite.exec("INSERT INTO users (id, username, email, password_hash) VALUES ('learner-a', 'learner-a', 'a@example.test', 'fixture-only')");
  const category = sqlite.prepare('SELECT id FROM category_hierarchy WHERE is_active = 1 LIMIT 1').get() as { id: string };
  for (const id of ['book-a', 'book-b']) {
    sqlite.prepare("INSERT INTO books (id, title, author, text, is_builtin, visibility, lifecycle_status) VALUES (?, ?, 'Fixture author', ?, 1, 'builtin', 'active')")
      .run(id, id, 'policy evidence alpha policy evidence beta');
  }
  for (const [id, book, index, content] of [
    ['chunk-a1', 'book-a', 0, 'policy evidence alpha'],
    ['chunk-a2', 'book-a', 1, 'policy evidence beta'],
    ['chunk-b1', 'book-b', 0, 'policy evidence gamma'],
  ] as const) {
    sqlite.prepare('INSERT INTO document_chunks (id, book_id, chunk_index, content, char_start, char_end) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, book, index, content, content.length);
  }
  seams.scenario = {
    title: '근거를 비교하는 정책 판단', role: '정책 분석가', context: '제공된 근거를 비교하세요.',
    decision_question: '어떤 판단이 근거에 더 잘 맞나요?', constraints: ['근거를 사용하세요', '대안을 비교하세요'],
    stakeholders: ['학습자', '교사'], tradeoffs: ['속도와 깊이', '비용과 접근성'],
    expected_tensions: ['형평성과 효율', '근거와 불확실성'], session_goal: '출처를 밝혀 판단하기',
    evidence_source_ids: ['library:book-a:chunk-a1', 'library:book-b:chunk-b1'],
    rubric: [
      { id: 'claim', label: '주장', description: '주장을 설명합니다.', weight: 0.34 },
      { id: 'evidence', label: '근거', description: '근거를 제시합니다.', weight: 0.33 },
      { id: 'tradeoff', label: '대안', description: '대안을 비교합니다.', weight: 0.33 },
    ],
  };
  const payloads: Record<string, unknown> = {
    learner_evaluation: {
      claim_clarity: 4, evidence_use: 3, reasoning_strength: 3, consistency: 4, relevance: 4,
      next_action: 'ask_reasoning', hint_level: 0, weakness_tags: ['근거 부족'], diagnosis: '근거와 판단의 연결을 확인하세요.',
      claim: '관점을 비교해야 합니다.', evidence_source_ids: ['library:book-a:chunk-a1'], evidence_detected: ['정책 근거'],
      reasoning_gap: '대안 비교', student_implicit_assumptions: [], alternative_interpretations: [],
      reasoning_chain_weakest_link: '근거의 적용 범위', cognitive_level: 'analysis', misconceptions: [], student_growth_since_last_turn: 'stagnant',
    },
    interactive_generation: { aiReply: '판단의 근거를 확인한다고 하셨습니다. 적용 범위와 반례를 함께 반영한 새로운 판단 기준을 어떻게 만들 수 있을까요?', questionType: 'evidence_request' },
    release_critic: { leakageScore: 0, bloomLevel: 'create', bloomCompliant: true, passed: true, issues: [], suggestions: [], reasoning: '학습자의 근거를 질문으로 확인합니다.', engagementScore: 90, quotesStudentWords: true, isGenericQuestion: false, intellectualTension: 80, diversityFromPrevious: 80 },
  };
  seams.router = {
    async completeValidatedJSON<T>(lane: AIRouteLane, _request: AIRouteRequest, validate: AIJSONValidator<T>) {
      if (lane === 'learner_evaluation' && seams.beforeEvaluation) { const hook = seams.beforeEvaluation; seams.beforeEvaluation = null; await hook(); }
      if (lane === 'interactive_generation' && seams.beforeGeneration) { const hook=seams.beforeGeneration; seams.beforeGeneration=null; await hook(); }
      seams.requests.push({ lane, request: _request });
      const support = _request.promptVersion?.includes('support');
      const value = validate(support && lane === 'interactive_generation' ? { aiReply: '정책을 적용해야 한다고 하셨습니다. 근거가 성립하는 조건이 달라지면 같은 결과를 보장하지 못합니다 [SOURCE_ID=library:book-a:chunk-a1]. 이 조건을 반영해 적용 기준을 어떻게 다시 구성할 수 있을까요?', questionType: 'bounded_support' } : support && lane === 'release_critic' ? { ...(payloads.release_critic as object), intellectualTension: 0 } : payloads[lane]);
      if (value === null) throw new Error(`Invalid deterministic ${lane} payload`);
      return { value, metadata: { lane, provider: 'deepseek', model: 'offline-fixture', fallback: false, attemptCount: 1, latencyMs: 0 } };
    },
  } as AIRouter;
  const env = { DB: fixture.db, JWT_SECRET: 'fixture-only', AI_ACTOR_SSU_API_KEY: '[REDACTED]', AI_ASSESSMENT_DEEPSEEK_API_KEY: '[REDACTED]', SOONGSIL_API_KEY: '[REDACTED]', DEEPSEEK_API_KEY: '[REDACTED]' } as Bindings;
  return { ...fixture, env, category: category.id };
}

async function trainingHTTPFixture(){
  const fixture=seed(),{env}=fixture;
  const app=(await import('../src/index')).default;
  const token=(await generateTokens({id:'learner-a',username:'learner-a',email:'a@example.test',studentId:null,grade:null,role:'student',createdAt:1,lastLogin:null,isActive:true},env.JWT_SECRET)).accessToken;
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const post=async(path:string,body?:object)=>{
    const pending:Promise<unknown>[]=[];
    const response=await app.request(path,{method:'POST',headers,...(body?{body:JSON.stringify(body)}:{})},env,{waitUntil:task=>pending.push(task),passThroughOnException:()=>undefined,props:{}});
    await Promise.all(pending);return response;
  };
  const start={category:fixture.category,difficulty:'intermediate',mode:'evidence',evidenceQuery:'policy evidence',evidenceBookIds:['book-a','book-b']};
  return {...fixture,app,headers,post,start};
}

function seedHaneulHarborSources(sqlite: DatabaseSync) {
  const sources = [
    ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'Synthetic example: demand and seasonality', 'Socratic AI synthetic example', 'synthetic-demand-seasonality', 'seasonality demand attendance operating cost'],
    ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'Synthetic example: demand and seasonality', 'Socratic AI synthetic example', 'synthetic-demand-weather', 'weather leisure demand facilities'],
    ['SYNTHETIC-HH-OPERATIONS-EXAMPLE', 'Synthetic example: operations and safety', 'Socratic AI synthetic example', 'synthetic-operations-safety', 'safety maintenance competition attendance demand'],
  ] as const;
  for (const [bookId, title, author, chunkId, content] of sources) {
    sqlite.prepare('INSERT OR IGNORE INTO books (id, title, author, text, is_builtin, visibility, lifecycle_status) VALUES (?, ?, ?, ?, 1, \'builtin\', \'active\')')
      .run(bookId, title, author, content);
    const chunkCount = sqlite.prepare('SELECT COUNT(*) AS count FROM document_chunks WHERE book_id = ?').get(bookId) as { count: number };
    sqlite.prepare('INSERT INTO document_chunks (id, book_id, chunk_index, content, char_start, char_end) VALUES (?, ?, ?, ?, 0, ?)')
      .run(chunkId, bookId, chunkCount.count, content, content.length);
  }
}

function allowHaneulHarborEvaluatorPayload(options: { rejectFirstCritic?: boolean } = {}) {
  const router = seams.router!;
  let criticCalls = 0;
  seams.router = new Proxy(router, {
    get(target, property, receiver) {
      if (property !== 'completeValidatedJSON') return Reflect.get(target, property, receiver);
      return <T>(lane: AIRouteLane, request: AIRouteRequest, validate: AIJSONValidator<T>) => target.completeValidatedJSON(lane, request, (value) => {
        if (!value || typeof value !== 'object') return validate(value);
        if (lane === 'learner_evaluation' && request.userPrompt.includes('하늘항 테마파크')) return validate({ ...(value as Record<string, unknown>), evidence_source_ids: ['library:SYNTHETIC-HH-DEMAND-EXAMPLE:synthetic-demand-seasonality'] });
        if (lane === 'release_critic' && options.rejectFirstCritic && ++criticCalls === 1) {
          return validate({ ...(value as Record<string, unknown>), leakageScore: 20, passed: false, issues: ['case-bound regeneration fixture'], suggestions: ['retain the learner reconstruction question'] });
        }
        return validate(value);
      });
    },
  });
}

async function sparringHTTPFixture(){
    const fixture=seed();
    const {env}=fixture;
    env.GROWTH_CYCLE_HMAC_SECRET = 'offline-accepted-sparring';
    env.SOONGSIL_API_KEY=''; // Context-bound routes work without legacy global keys.
    const router=seams.router!;
    seams.router=new Proxy(router,{get(target,property,receiver){
      if(property!=='completeValidatedJSON')return Reflect.get(target,property,receiver);
      return <T>(lane:AIRouteLane,request:AIRouteRequest,validate:AIJSONValidator<T>)=>target.completeValidatedJSON(lane,request,value=>{
        if(!value||typeof value!=='object')return validate(value);
        const fields=value as Record<string,unknown>;
        return validate({...fields,...(lane==='learner_evaluation'?{evidence_source_ids:['chunk-a1']}:{ }),
          ...(typeof fields.aiReply==='string'?{aiReply:fields.aiReply.replaceAll('library:book-a:chunk-a1','chunk-a1')}:{})});
      });
    }});
    const app=(await import('../src/index')).default;
    const token=(await generateTokens({id:'learner-a',username:'learner-a',email:'a@example.test',studentId:null,grade:null,role:'student',createdAt:1,lastLogin:null,isActive:true},env.JWT_SECRET)).accessToken;
    const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
    const post=async(path:string,body?:object,key?:string)=>{
      const pending:Promise<unknown>[]=[];
      const response=await app.request(path,{method:'POST',headers:{...headers,...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})},env,{waitUntil:task=>pending.push(task),passThroughOnException:()=>undefined,props:{}});
      await Promise.all(pending);
      return response;
    };
    return {...fixture,app,headers,token,post};
}

describe('accepted evidence training on the complete migrated schema', () => {
  it('persists the canonical turn before one background dispatch and awaits accepted effects without an execution context', async () => {
    const { sqlite, env, category } = seed();
    await startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      evidenceQuery: 'policy evidence',
      evidenceBookIds: ['book-a', 'book-b'],
    }, { sessionId: 'accepted-effects-background' });

    const pending: Promise<unknown>[] = [];
    let persistedBeforeDispatch = false;
    await respondTrainingSession(
      env,
      'learner-a',
      'accepted-effects-background',
      'The policy claim needs evidence and a causal reason.',
      {
        waitUntil(task: Promise<unknown>) {
          persistedBeforeDispatch = Number(sqlite.prepare("SELECT COUNT(*) AS count FROM training_turns WHERE session_id = 'accepted-effects-background'").get()?.count) === 1;
          pending.push(task);
        },
      } as unknown as ExecutionContext,
    );
    expect(persistedBeforeDispatch).toBe(true);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(sqlite.prepare("SELECT evidence_count FROM user_concept_mastery WHERE user_id = 'learner-a' AND concept_id = '근거 부족'").get()).toEqual({ evidence_count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM training_argument_nodes WHERE session_id = 'accepted-effects-background'").get()).toEqual({ count: 6 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM training_argument_edges WHERE session_id = 'accepted-effects-background'").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM argument_nodes WHERE session_id = 'accepted-effects-background'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM aif_graph_snapshots WHERE session_id = 'accepted-effects-background'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM aif_l_nodes WHERE session_id = 'accepted-effects-background'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM aif_ta_edges WHERE session_id = 'accepted-effects-background'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM argument_scheme_stats WHERE session_id = 'accepted-effects-background'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM xaif_jsonld_cache WHERE session_id = 'accepted-effects-background'").get()).toEqual({ count: 0 });

    await startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      evidenceQuery: 'policy evidence',
      evidenceBookIds: ['book-a', 'book-b'],
    }, { sessionId: 'accepted-effects-local' });
    await respondTrainingSession(
      env,
      'learner-a',
      'accepted-effects-local',
      'A causal claim must name the evidence and its limits.',
    );
    expect(sqlite.prepare("SELECT evidence_count FROM user_concept_mastery WHERE user_id = 'learner-a' AND concept_id = '근거 부족'").get()).toEqual({ evidence_count: 2 });
  });

  it('forwards the HTTP execution context only after canonical persistence and awaits the route fallback', async () => {
    const { sqlite, env, category } = seed();
    const app = (await import('../src/index')).default;
    const token = (await generateTokens({
      id: 'learner-a', username: 'learner-a', email: 'a@example.test', studentId: null,
      grade: null, role: 'student', createdAt: 1, lastLogin: null, isActive: true,
    }, env.JWT_SECRET)).accessToken;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    await startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      evidenceQuery: 'policy evidence',
      evidenceBookIds: ['book-a', 'book-b'],
    }, { sessionId: 'accepted-effects-http-background' });

    const pending: Promise<unknown>[] = [];
    let persistedBeforeDispatch = false;
    const response = await app.request('/api/training/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: 'accepted-effects-http-background',
        message: 'The policy claim needs evidence and a causal reason.',
      }),
    }, env, {
      waitUntil(task: Promise<unknown>) {
        persistedBeforeDispatch = Number(sqlite.prepare("SELECT COUNT(*) AS count FROM training_turns WHERE session_id = 'accepted-effects-http-background'").get()?.count) === 1;
        pending.push(task);
      },
      passThroughOnException: () => undefined,
      props: {},
    });

    expect(response.status).toBe(200);
    expect(persistedBeforeDispatch).toBe(true);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(sqlite.prepare("SELECT evidence_count FROM user_concept_mastery WHERE user_id = 'learner-a' AND concept_id = '근거 부족'").get()).toEqual({ evidence_count: 1 });

    await startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      evidenceQuery: 'policy evidence',
      evidenceBookIds: ['book-a', 'book-b'],
    }, { sessionId: 'accepted-effects-http-local' });
    const localResponse = await app.request('/api/training/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: 'accepted-effects-http-local',
        message: 'A causal claim must identify its evidence and limits.',
      }),
    }, env, {
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext);
    expect(localResponse.status).toBe(200);
    expect(sqlite.prepare("SELECT evidence_count FROM user_concept_mastery WHERE user_id = 'learner-a' AND concept_id = '근거 부족'").get()).toEqual({ evidence_count: 2 });
  });

  it('binds the server-owned Haneul Harbor case through start and owner detail readback', async () => {
    const fixture = await trainingHTTPFixture();
    const { sqlite, env, category, app, headers } = fixture;
    const sources = [
      ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'Synthetic example: demand and seasonality', 'Socratic AI synthetic example', 'synthetic-demand-seasonality', 'seasonality demand attendance operating cost'],
      ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'Synthetic example: demand and seasonality', 'Socratic AI synthetic example', 'synthetic-demand-weather', 'weather leisure demand facilities'],
      ['SYNTHETIC-HH-OPERATIONS-EXAMPLE', 'Synthetic example: operations and safety', 'Socratic AI synthetic example', 'synthetic-operations-safety', 'safety maintenance competition attendance demand'],
    ] as const;
    for (const [bookId, title, author, chunkId, content] of sources) {
      sqlite.prepare('INSERT OR IGNORE INTO books (id, title, author, text, is_builtin, visibility, lifecycle_status) VALUES (?, ?, ?, ?, 1, \'builtin\', \'active\')')
        .run(bookId, title, author, content);
      const chunkCount = sqlite.prepare('SELECT COUNT(*) AS count FROM document_chunks WHERE book_id = ?').get(bookId) as { count: number };
      sqlite.prepare('INSERT INTO document_chunks (id, book_id, chunk_index, content, char_start, char_end) VALUES (?, ?, ?, ?, 0, ?)')
        .run(chunkId, bookId, chunkCount.count, content, content.length);
    }

    const started = await startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      caseId: 'HH-INVEST-100B',
      evidenceQuery: 'seasonality safety demand',
      evidenceBookIds: ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'SYNTHETIC-HH-OPERATIONS-EXAMPLE'],
    } as Parameters<typeof startTrainingSession>[2]);
    const detail = await app.request(`/api/training/session/${started.sessionId}`, { headers }, env);
    const stored = sqlite.prepare('SELECT scenario_json, rubric_json, case_id, case_version, case_contract_sha256 FROM training_scenario_packs WHERE session_id = ?').get(started.sessionId) as { scenario_json: string; rubric_json: string; case_id: string; case_version: string; case_contract_sha256: string };
    const expectedCaseContract = {
      status: 'ready',
      caseId: 'HH-INVEST-100B',
      caseVersion: '1.1.0-synthetic',
      locale: 'ko-KR',
      rubricVersion: 'HH-RUBRIC-1.0.0',
      publicFactIds: ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'SYNTHETIC-HH-OPERATIONS-EXAMPLE'],
      assumptionIds: ['A-01', 'A-02', 'A-03', 'A-04', 'A-05'],
      unknownIds: ['U-01', 'U-02', 'U-03', 'U-04', 'U-05', 'U-06', 'U-07', 'U-08'],
      baselineVersion: 'HH-SYNTHETIC-BASE-1.0.0',
      adapterManifestId: 'HH-SYNTHETIC-DEMO-ADAPTER-1.0.0',
      contractSnapshotSha256: '4617346d57fddf2bc30a094ff172586d201ae68bf5453dcf86ef30d7f87a5c87',
      opaqueVariantIds: ['HH-V-IMMEDIATE-01', 'HH-V-IMMEDIATE-02', 'HH-D-DELAYED-BASE-01', 'HH-D-CHANGED-01'],
    };

    expect((started as Record<string, unknown>).caseContract).toEqual(expectedCaseContract);
    expect(detail.status).toBe(200);
    expect((await detail.json() as { caseContract?: unknown }).caseContract).toEqual(expectedCaseContract);
    expect(stored.case_id).toBe('HH-INVEST-100B');
    expect(stored.case_version).toBe('1.1.0-synthetic');
    expect(stored.case_contract_sha256).toBe('4617346d57fddf2bc30a094ff172586d201ae68bf5453dcf86ef30d7f87a5c87');
    expect(JSON.parse(stored.scenario_json)).toMatchObject({ caseContract: expectedCaseContract });
    expect(JSON.parse(stored.rubric_json)).toEqual([
      expect.objectContaining({ id: 'R1', label: '문제 정의', weight: 0.2 }),
      expect.objectContaining({ id: 'R2', label: '근거와 불확실성', weight: 0.2 }),
      expect.objectContaining({ id: 'R3', label: '인과 추론', weight: 0.2 }),
      expect.objectContaining({ id: 'R4', label: '전략과 상충관계', weight: 0.2 }),
      expect.objectContaining({ id: 'R5', label: '측정, 안전장치, 수정', weight: 0.2 }),
    ]);
  });

  it('boots the authored Korean first case through the public start contract without source fixtures', async () => {
    const { sqlite, env, category, app, headers, post } = await trainingHTTPFixture();
    const started = await post('/api/training/start', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      caseId: 'HH-INVEST-100B',
      // The server catalog owns the real query and source identities.
      evidenceQuery: 'ignored browser input',
      evidenceBookIds: ['book-a', 'book-b'],
    });

    expect(started.status).toBe(200);
    const body = await started.json() as { sessionId: string; caseContract?: { caseId?: string }; caseContractStatus?: string };
    expect(body.caseContract).toMatchObject({ caseId: 'HH-INVEST-100B' });
    expect(body.caseContractStatus).toBe('ready');
    const sourceChunks = sqlite.prepare('SELECT COUNT(*) AS count FROM document_chunks WHERE book_id IN (?, ?)')
      .get('SYNTHETIC-HH-DEMAND-EXAMPLE', 'SYNTHETIC-HH-OPERATIONS-EXAMPLE') as { count: number };
    expect(sourceChunks.count).toBeGreaterThanOrEqual(3);

    const catalog = await app.request('/api/training/cases', { headers }, env);
    expect(catalog.status).toBe(200);
    const catalogBody = await catalog.json() as { cases: Array<Record<string, unknown>> };
    expect(catalogBody.cases).toHaveLength(1);
    expect(catalogBody.cases[0]).toMatchObject({
      caseId: 'HH-INVEST-100B', caseVersion: '1.1.0-synthetic', locale: 'ko-KR',
      sourceManifestVersion: 'HH-SYNTHETIC-SOURCES-1.0.0',
    });
    expect(catalogBody.cases[0].sources).toEqual([
      expect.objectContaining({
        requiredLifecycleStatus: 'active', requiredVisibility: 'builtin',
        reviewedExcerptVersion: 'HH-SYNTHETIC-EXAMPLES-1.0.0',
      }),
      expect.objectContaining({
        requiredLifecycleStatus: 'active', requiredVisibility: 'builtin',
        reviewedExcerptVersion: 'HH-SYNTHETIC-EXAMPLES-1.0.0',
      }),
    ]);

    const ownerDetail = await app.request(`/api/training/session/${body.sessionId}`, { headers }, env);
    expect(ownerDetail.status).toBe(200);
    expect(await ownerDetail.json()).toMatchObject({ caseContractStatus: 'ready' });

    sqlite.prepare("INSERT INTO users (id, username, email, password_hash) VALUES ('learner-b', 'learner-b', 'b@example.test', 'fixture-only')").run();
    const otherToken = (await generateTokens({
      id: 'learner-b', username: 'learner-b', email: 'b@example.test', studentId: null,
      grade: null, role: 'student', createdAt: 1, lastLogin: null, isActive: true,
    }, env.JWT_SECRET)).accessToken;
    const otherDetail = await app.request(`/api/training/session/${body.sessionId}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    }, env);
    expect(otherDetail.status).toBe(403);
  });

  it('canonicalizes every persisted case launch field from the server catalog', async () => {
    const { sqlite, env, category, app, headers, post } = await trainingHTTPFixture();
    const response = await post('/api/training/start', {
      category: 'philosophy',
      difficulty: 'beginner',
      mode: 'constructed',
      maxTurns: 1,
      caseId: 'HH-INVEST-100B',
      evidenceQuery: 'client-selected text must not replace the case contract',
      evidenceBookIds: ['book-a', 'book-b'],
    });

    expect(response.status).toBe(200);
    const started = await response.json() as { sessionId: string; category: string; difficulty: string; mode: string; maxTurns: number; caseContractStatus: string };
    expect(started).toMatchObject({
      category: 'business', difficulty: 'intermediate', mode: 'evidence', maxTurns: 8,
      caseContractStatus: 'ready',
    });
    expect(sqlite.prepare('SELECT category, difficulty, training_mode, max_turns FROM training_sessions WHERE id = ?')
      .get(started.sessionId)).toEqual({ category: 'business', difficulty: 'intermediate', training_mode: 'scenario', max_turns: 8 });

    const detail = await app.request(`/api/training/session/${started.sessionId}`, { headers }, env);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      caseContractStatus: 'ready',
      session: { category: 'business', difficulty: 'intermediate', mode: 'evidence', max_turns: 8 },
    });
  });

  it('fails a missing or quarantined catalog source before a Training session is persisted', async () => {
    const { sqlite, env, category, app, headers, post } = await trainingHTTPFixture();
    const catalog = await app.request('/api/training/cases', { headers }, env);
    expect(catalog.status).toBe(200);
    const before = sqlite.prepare('SELECT COUNT(*) AS count FROM training_sessions').get() as { count: number };

    sqlite.prepare("UPDATE books SET lifecycle_status = 'quarantined' WHERE id = ?").run('SYNTHETIC-HH-OPERATIONS-EXAMPLE');
    const quarantined = await post('/api/training/start', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      caseId: 'HH-INVEST-100B',
      evidenceQuery: 'ignored browser input',
      evidenceBookIds: [],
    });
    expect(quarantined.status).toBe(422);
    expect(await quarantined.json()).toMatchObject({ error: 'scenario_evidence_insufficient', reason: 'library_chunks_not_found' });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_sessions').get()).toEqual(before);

    sqlite.prepare("UPDATE books SET lifecycle_status = 'active' WHERE id = ?").run('SYNTHETIC-HH-OPERATIONS-EXAMPLE');
    sqlite.prepare('DELETE FROM document_chunks WHERE book_id = ?').run('SYNTHETIC-HH-DEMAND-EXAMPLE');
    const missing = await post('/api/training/start', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      caseId: 'HH-INVEST-100B',
      evidenceQuery: 'ignored browser input',
      evidenceBookIds: [],
    });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ error: 'scenario_evidence_insufficient', reason: 'library_chunks_not_found' });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_sessions').get()).toEqual(before);
  });

  it('keeps an opt-in generic Training start outside the case contract', async () => {
    const { app, env, headers, post, start } = await trainingHTTPFixture();
    const started = await post('/api/training/start', start);
    expect(started.status).toBe(200);
    const body = await started.json() as { sessionId: string; caseContract?: unknown; caseContractStatus?: string };
    expect(body.caseContract).toBeNull();
    expect(body.caseContractStatus).toBe('not_applicable');
    const detail = await app.request(`/api/training/session/${body.sessionId}`, { headers }, env);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ caseContract: null, caseContractStatus: 'not_applicable' });
  });

  it('binds a validated Haneul Harbor case to every response lane and its evaluation snapshot', async () => {
    const fixture = await trainingHTTPFixture();
    const { sqlite, env, category, app, headers } = fixture;
    seedHaneulHarborSources(sqlite);
    allowHaneulHarborEvaluatorPayload();

    const started = await startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      caseId: 'HH-INVEST-100B',
      evidenceQuery: 'seasonality safety demand',
      evidenceBookIds: ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'SYNTHETIC-HH-OPERATIONS-EXAMPLE'],
    } as Parameters<typeof startTrainingSession>[2]);

    await expect(respondTrainingSession(
      env,
      'learner-a',
      started.sessionId,
      '인접 상권과 야간 프로그램을 우선하는 Family B를 택하되, 대기 이탈과 상권의 순증 효과는 아직 UNKNOWN이므로 1000억 전액을 확정하지 않고 단계 실험과 중단 기준을 두겠습니다.',
    )).resolves.toMatchObject({ evaluation: expect.any(Object) });

    const routed = new Map(seams.requests.map(({ lane, request }) => [lane, request]));
    for (const lane of ['learner_evaluation', 'interactive_generation', 'release_critic']) {
      const request = routed.get(lane);
      expect(request?.userPrompt).toContain('HH-INVEST-100B@1.1.0-synthetic');
      expect(request?.userPrompt).toContain('HH-RUBRIC-1.0.0');
      expect(request?.userPrompt).toContain('problem framing');
      expect(request?.userPrompt).toContain('evidence and uncertainty');
      expect(request?.userPrompt).toContain('causal reasoning');
      expect(request?.userPrompt).toContain('strategy and tradeoffs');
      expect(request?.userPrompt).toContain('measurement, guardrails, and revision');
      expect(request?.userPrompt).toContain('PUBLIC_FACT');
      expect(request?.userPrompt).toContain('SCENARIO_ASSUMPTION');
      expect(request?.userPrompt).toContain('UNKNOWN');
      expect(request?.userPrompt).toContain('EVIDENCE_STATUS=READY');
      expect(request?.userPrompt).toContain('immutable case/source snapshot just passed full revalidation');
      expect(request?.userPrompt).toContain('not proof of real-world causal truth');
      expect(request?.userPrompt).toMatch(/multiple coherent strategies and hybrids are valid/i);
      expect(request?.userPrompt).toMatch(/insufficient evidence may be a defensible answer/i);
      expect(request?.userPrompt).toContain('library:SYNTHETIC-HH-DEMAND-EXAMPLE:synthetic-demand-seasonality');
      expect(request?.userPrompt).toContain('library:SYNTHETIC-HH-OPERATIONS-EXAMPLE:synthetic-operations-safety');
    }

    const stored = sqlite.prepare('SELECT evaluation_json FROM training_turns WHERE session_id = ?').get(started.sessionId) as { evaluation_json: string };
    expect(JSON.parse(stored.evaluation_json)).toMatchObject({
      caseEvaluation: {
        caseId: 'HH-INVEST-100B',
        caseVersion: '1.1.0-synthetic',
        rubricVersion: 'HH-RUBRIC-1.0.0',
        rubricIds: ['R1', 'R2', 'R3', 'R4', 'R5'],
      },
    });
    const detail = await app.request(`/api/training/session/${started.sessionId}`, { headers }, env);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as { turns: Array<{ evaluation_json: string }> };
    expect(JSON.parse(detailBody.turns[0].evaluation_json)).toMatchObject({
      caseEvaluation: { caseId: 'HH-INVEST-100B', caseVersion: '1.1.0-synthetic', rubricVersion: 'HH-RUBRIC-1.0.0', rubricIds: ['R1', 'R2', 'R3', 'R4', 'R5'] },
    });

    seams.requests = [];
    const generic = await startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      evidenceQuery: 'policy evidence',
      evidenceBookIds: ['book-a', 'book-b'],
    }, { sessionId: 'generic-contract-control' });
    await respondTrainingSession(env, 'learner-a', generic.sessionId, '이 주장은 제시된 근거의 적용 범위를 더 확인해야 합니다.');
    for (const { request } of seams.requests) {
      expect(request.userPrompt).not.toContain('HH-INVEST-100B@1.1.0-synthetic');
    }
    const genericVersions = new Map(seams.requests.map(({ lane, request }) => [lane, request.promptVersion]));
    expect(genericVersions.get('learner_evaluation')).toBe('tutoring-evaluator-v1');
    expect(genericVersions.get('interactive_generation')).toBe('tutoring-actor-v1');
    expect(genericVersions.get('release_critic')).toBe('mentor-critic-v1');
    const genericStored = sqlite.prepare('SELECT evaluation_json FROM training_turns WHERE session_id = ?').get(generic.sessionId) as { evaluation_json: string };
    expect(JSON.parse(genericStored.evaluation_json)).not.toHaveProperty('caseEvaluation');
  });

  it('binds ready case evidence and contract identity to both critic passes', async () => {
    const fixture = await trainingHTTPFixture();
    const { sqlite, env, category } = fixture;
    seedHaneulHarborSources(sqlite);
    allowHaneulHarborEvaluatorPayload({ rejectFirstCritic: true });
    const started = await startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      caseId: 'HH-INVEST-100B',
      evidenceQuery: 'seasonality safety demand',
      evidenceBookIds: ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'SYNTHETIC-HH-OPERATIONS-EXAMPLE'],
    } as Parameters<typeof startTrainingSession>[2]);

    await expect(respondTrainingSession(
      env,
      'learner-a',
      started.sessionId,
      '혼합 전략을 조건부로 제안합니다. 순증 방문과 대체 효과는 UNKNOWN이므로 작은 비교 실험에서 근거가 바뀌면 제 권고도 수정하겠습니다.',
    )).resolves.toMatchObject({ evaluation: expect.any(Object) });

    const casePromptVersion = 'HH-INVEST-100B@1.1.0-synthetic:HH-RUBRIC-1.0.0';
    const evaluator = seams.requests.filter(({ lane }) => lane === 'learner_evaluation');
    const actors = seams.requests.filter(({ lane }) => lane === 'interactive_generation');
    const critics = seams.requests.filter(({ lane }) => lane === 'release_critic');
    expect(evaluator).toHaveLength(1);
    expect(actors).toHaveLength(2);
    expect(critics).toHaveLength(2);
    for (const { request } of [...evaluator, ...actors, ...critics]) {
      expect(request.userPrompt).toContain('EVIDENCE_STATUS=READY');
      expect(request.userPrompt).toContain('immutable case/source snapshot just passed full revalidation');
      expect(request.userPrompt).toContain('not proof of real-world causal truth');
      expect(request.promptVersion).toContain(casePromptVersion);
    }
    expect(actors[1].request.promptVersion).toMatch(/^mentor-regeneration-/);
    expect(critics[0].request.promptVersion).toMatch(/^mentor-critic-/);
    expect(critics[1].request.promptVersion).toMatch(/^mentor-critic-/);
  });

  it('keeps a Family A provisional answer eligible for the same Haneul Harbor prompt contract', async () => {
    const fixture = await trainingHTTPFixture();
    const { sqlite, env, category } = fixture;
    seedHaneulHarborSources(sqlite);
    allowHaneulHarborEvaluatorPayload();
    const started = await startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      caseId: 'HH-INVEST-100B',
      evidenceQuery: 'seasonality safety demand',
      evidenceBookIds: ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'SYNTHETIC-HH-OPERATIONS-EXAMPLE'],
    } as Parameters<typeof startTrainingSession>[2]);

    await expect(respondTrainingSession(
      env,
      'learner-a',
      started.sessionId,
      'Family A의 수용력 개선을 단계적으로 시험하겠습니다. 계절성과 대기 이탈의 인과는 확정하지 않고, 접근성·안전·운영비를 포함한 비교 측정과 중단 기준을 먼저 두겠습니다.',
    )).resolves.toMatchObject({ evaluation: expect.any(Object) });
    expect(seams.requests.filter(({ lane }) => lane === 'learner_evaluation' || lane === 'interactive_generation' || lane === 'release_critic')).toHaveLength(3);
  });

  it('withholds a broken Haneul Harbor snapshot before provider calls or accepted writes', async () => {
    const fixture = await trainingHTTPFixture();
    const { sqlite, env, category } = fixture;
    seedHaneulHarborSources(sqlite);
    const started = await startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      caseId: 'HH-INVEST-100B',
      evidenceQuery: 'seasonality safety demand',
      evidenceBookIds: ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'SYNTHETIC-HH-OPERATIONS-EXAMPLE'],
    } as Parameters<typeof startTrainingSession>[2]);
    sqlite.exec(`
      DROP TRIGGER IF EXISTS training_scenario_packs_bound_immutable_update;
      DROP TRIGGER IF EXISTS training_scenario_packs_case_contract_immutable;
      DROP TRIGGER IF EXISTS training_scenario_evidence_bound_immutable_update;
    `);
    sqlite.prepare('UPDATE training_scenario_packs SET scenario_json = ? WHERE session_id = ?').run('{}', started.sessionId);
    const before = Object.fromEntries(['training_messages', 'training_turns'].map((table) => [table, sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(started.sessionId)]));
    seams.requests = [];

    await expect(respondTrainingSession(env, 'learner-a', started.sessionId, '깨진 사례 스냅샷을 통해 답변을 제출합니다.')).rejects.toMatchObject({
      status: 409,
      body: { code: 'TRAINING_CASE_SNAPSHOT_INVALID', assessmentState: 'UNGRADABLE', caseContractStatus: 'broken' },
    });
    expect(seams.requests).toHaveLength(0);
    expect(Object.fromEntries(['training_messages', 'training_turns'].map((table) => [table, sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(started.sessionId)]))).toEqual(before);
  });

  it('rejects an unknown Training case selector with a stable machine-readable code', async () => {
    const fixture = await trainingHTTPFixture();
    await expect(startTrainingSession(fixture.env, 'learner-a', {
      category: fixture.category,
      difficulty: 'intermediate',
      mode: 'evidence',
      caseId: 'HH-UNKNOWN',
      evidenceQuery: 'policy evidence',
      evidenceBookIds: ['book-a', 'book-b'],
    } as Parameters<typeof startTrainingSession>[2])).rejects.toMatchObject({
      status: 404,
      body: { code: 'TRAINING_CASE_NOT_FOUND' },
    });
  });

  it('rejects a case-bound Growth follow-up before source, provider, or session work', async () => {
    const fixture = await trainingHTTPFixture();
    const { sqlite, post, start } = fixture;
    const before = Object.fromEntries([
      'training_sessions',
      'training_scenario_packs',
      'training_scenario_evidence',
      'training_session_contexts',
      'growth_recheck_follow_up_launches',
      'growth_recheck_follow_up_bindings',
    ].map((table) => [table, sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()]));

    const response = await post('/api/training/start', {
      ...start,
      caseId: 'HH-INVEST-100B',
      growthFollowUpLaunchId: 'follow-up-without-case-semantics',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'TRAINING_CASE_FOLLOW_UP_UNSUPPORTED',
      error: expect.any(String),
    });
    expect(Object.fromEntries([
      'training_sessions',
      'training_scenario_packs',
      'training_scenario_evidence',
      'training_session_contexts',
      'growth_recheck_follow_up_launches',
      'growth_recheck_follow_up_bindings',
    ].map((table) => [table, sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()]))).toEqual(before);
    expect(seams.requests).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed for corrupted Haneul Harbor snapshots while generic evidence remains not applicable', async () => {
    const fixture = await trainingHTTPFixture();
    const { sqlite, env, category, app, headers } = fixture;
    const sources = [
      ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'Synthetic example: demand and seasonality', 'Socratic AI synthetic example', 'synthetic-demand-seasonality', 'seasonality demand attendance operating cost'],
      ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'Synthetic example: demand and seasonality', 'Socratic AI synthetic example', 'synthetic-demand-weather', 'weather leisure demand facilities'],
      ['SYNTHETIC-HH-OPERATIONS-EXAMPLE', 'Synthetic example: operations and safety', 'Socratic AI synthetic example', 'synthetic-operations-safety', 'safety maintenance competition attendance demand'],
    ] as const;
    for (const [bookId, title, author, chunkId, content] of sources) {
      sqlite.prepare('INSERT OR IGNORE INTO books (id, title, author, text, is_builtin, visibility, lifecycle_status) VALUES (?, ?, ?, ?, 1, \'builtin\', \'active\')')
        .run(bookId, title, author, content);
      const chunkCount = sqlite.prepare('SELECT COUNT(*) AS count FROM document_chunks WHERE book_id = ?').get(bookId) as { count: number };
      sqlite.prepare('INSERT INTO document_chunks (id, book_id, chunk_index, content, char_start, char_end) VALUES (?, ?, ?, ?, 0, ?)')
        .run(chunkId, bookId, chunkCount.count, content, content.length);
    }

    const startCase = () => startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      caseId: 'HH-INVEST-100B',
      evidenceQuery: 'seasonality safety demand',
      evidenceBookIds: ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'SYNTHETIC-HH-OPERATIONS-EXAMPLE'],
    } as Parameters<typeof startTrainingSession>[2]);
    const allowOutOfBandCorruption = () => sqlite.exec(`
      DROP TRIGGER IF EXISTS training_scenario_packs_bound_immutable_update;
      DROP TRIGGER IF EXISTS training_scenario_packs_case_contract_immutable;
      DROP TRIGGER IF EXISTS training_scenario_evidence_bound_immutable_update;
    `);

    const missingScenario = await startCase();
    allowOutOfBandCorruption();
    sqlite.prepare('UPDATE training_scenario_packs SET scenario_json = ? WHERE session_id = ?').run('{}', missingScenario.sessionId);
    const malformedDetail = await app.request(`/api/training/session/${missingScenario.sessionId}`, { headers }, env);
    expect(malformedDetail.status).toBe(409);
    expect(await malformedDetail.json()).toMatchObject({ code: 'TRAINING_CASE_SNAPSHOT_INVALID', assessmentState: 'UNGRADABLE', caseContractStatus: 'broken' });

    const wrongRubric = await startCase();
    const stored = sqlite.prepare('SELECT scenario_json, rubric_json FROM training_scenario_packs WHERE session_id = ?').get(wrongRubric.sessionId) as { scenario_json: string; rubric_json: string };
    const rubric = JSON.parse(stored.rubric_json) as Array<{ description: string }>;
    rubric[0].description = '수정된 자가 일관적 루브릭 설명';
    const scenario = JSON.parse(stored.scenario_json) as { rubric: unknown };
    scenario.rubric = rubric;
    sqlite.prepare('UPDATE training_scenario_packs SET scenario_json = ?, rubric_json = ? WHERE session_id = ?')
      .run(JSON.stringify(scenario), JSON.stringify(rubric), wrongRubric.sessionId);
    const malformedResume = await app.request(`/api/training/session/${wrongRubric.sessionId}/resume`, { method: 'POST', headers }, env);
    expect(malformedResume.status).toBe(409);
    expect(await malformedResume.json()).toMatchObject({ code: 'TRAINING_CASE_SNAPSHOT_INVALID', assessmentState: 'UNGRADABLE', caseContractStatus: 'broken' });

    const wrongSource = await startCase();
    sqlite.prepare('UPDATE training_scenario_evidence SET book_author = ? WHERE session_id = ? AND book_id = ?')
      .run('Wrong authoritative author', wrongSource.sessionId, 'SYNTHETIC-HH-OPERATIONS-EXAMPLE');
    const sourceDetail = await app.request(`/api/training/session/${wrongSource.sessionId}`, { headers }, env);
    expect(sourceDetail.status).toBe(409);
    expect(await sourceDetail.json()).toMatchObject({ code: 'TRAINING_CASE_SNAPSHOT_INVALID', assessmentState: 'UNGRADABLE', caseContractStatus: 'broken' });

    const missingIdentity = await startCase();
    sqlite.prepare('UPDATE training_scenario_packs SET case_id = NULL, case_version = NULL, case_contract_sha256 = NULL WHERE session_id = ?')
      .run(missingIdentity.sessionId);
    const identityDetail = await app.request(`/api/training/session/${missingIdentity.sessionId}`, { headers }, env);
    expect(identityDetail.status).toBe(409);
    expect(await identityDetail.json()).toMatchObject({ code: 'TRAINING_CASE_SNAPSHOT_INVALID', assessmentState: 'UNGRADABLE', caseContractStatus: 'broken' });

    const generic = await startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      evidenceQuery: 'policy evidence',
      evidenceBookIds: ['book-a', 'book-b'],
    } as Parameters<typeof startTrainingSession>[2]);
    const genericDetail = await app.request(`/api/training/session/${generic.sessionId}`, { headers }, env);
    expect(genericDetail.status).toBe(200);
    expect(await genericDetail.json()).toMatchObject({ caseContract: null, caseContractStatus: 'not_applicable' });
  });

  it.each(['SPARRING','TRAINING'] as const)('paces %s scaffolding from canonical prior follow-ups rather than serialized inferences',async scope=>{
    const f=scope==='SPARRING'?await sparringHTTPFixture():await trainingHTTPFixture();
    const {sqlite,db,post}=f;
    const start=await post(scope==='SPARRING'?'/api/session/start':'/api/training/start',scope==='SPARRING'?{bookId:'book-a'}:{category:f.category,difficulty:'intermediate',mode:'evidence',evidenceQuery:'policy evidence',evidenceBookIds:['book-a','book-b']});
    expect(start.status).toBe(200);const {sessionId}=await start.json() as {sessionId:string};
    const chat=scope==='SPARRING'?'/api/chat':'/api/training/chat';
    const attempts=(turn=10,owner='learner-a')=>readPriorAcceptedRevisionAttempts(db,owner,sessionId,scope,turn);
    expect((await post(chat,{sessionId,message:'The original claim needs a causal condition.'})).status).toBe(200);
    const prior=sqlite.prepare(scope==='SPARRING'?"SELECT id FROM messages WHERE session_id=? AND role='user'":"SELECT id FROM training_turns WHERE session_id=?").get(sessionId)!;
    const path=scope==='SPARRING'?`/api/sessions/${sessionId}/revisions`:`/api/training/session/${sessionId}/revisions`;
    const input={revisedStatement:'The claim holds under explicit causal conditions.',explanation:'A changed condition alters the predicted result.',sourceIds:[scope==='SPARRING'?'chunk-a1':'library:book-a:chunk-a1'],expectedRevision:0,mutationKey:'accepted-attempt-policy',...(scope==='SPARRING'?{priorMessageId:prior.id,supportId:null,expectedTurn:2,controlRevision:0}:{priorTurnId:prior.id})};
    expect((await post(path,input)).status).toBe(200);expect(await attempts()).toBe(0);
    seams.beforeGeneration=async()=>{throw new Error('Interrupted attempt policy fixture');};
    expect((await post(chat,{sessionId,message:'Test my proposed mechanism.'})).status).toBe(503);expect(await attempts()).toBe(0);
    expect((await post(chat,{sessionId,message:'Test my proposed mechanism.'})).status).toBe(200);
    expect(await attempts()).toBe(1);expect(await attempts(2)).toBe(0);expect(await attempts(3)).toBe(1);
    expect(await attempts(3,'learner-b')).toBe(0);
    expect((await post(path,input)).status).toBe(200);expect(await attempts()).toBe(1);
    const table=scope==='SPARRING'?'sessions':'training_sessions';
    const stored=sqlite.prepare(`SELECT student_model FROM ${table} WHERE id=?`).get(sessionId)!;
    const model=JSON.parse(String(stored.student_model));model.helpLevel=5;model.revisionCount=99;
    sqlite.prepare(`UPDATE ${table} SET student_model=? WHERE id=?`).run(JSON.stringify(model),sessionId);
    seams.requests=[];
    expect((await post(chat,{sessionId,message:'Which evidence would distinguish the revised mechanism?'})).status).toBe(200);
    expect(seams.requests.find(r=>r.lane==='interactive_generation')?.request.userPrompt).toContain('도움 레벨: H4');
    expect(await attempts()).toBe(1);
    expect(JSON.parse(String(sqlite.prepare(`SELECT student_model FROM ${table} WHERE id=?`).get(sessionId)!.student_model)).revisionCount).toBe(99);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['missing','failed'] as const)('keeps %s accepted-attempt reads unknown',async mode=>{
    const {db}=seed();
    const unavailable=new Proxy(db,{get(target,key){if(key!=='prepare')return Reflect.get(target,key);return (sql:string)=>{const statement=target.prepare(sql);return new Proxy(statement,{get(s,member){if(member==='bind')return ()=>new Proxy(s,{get(bound,m){if(m==='first')return async()=>{if(mode==='failed')throw Error('Unavailable attempt count');return null;};return Reflect.get(bound,m);}});return Reflect.get(s,member);}});};}});
    expect(await readPriorAcceptedRevisionAttempts(unavailable,'learner-a','session','SPARRING',3)).toBeNull();
  });
  it('reports explicit Sparring records without converting legacy counters or score changes into learning success',async()=>{
    const {sqlite,post,app,env,headers}=await sparringHTTPFixture();
    sqlite.exec("INSERT INTO users(id,username,email,password_hash,role) VALUES ('metrics-admin','metrics-admin','metrics@example.test','fixture-only','admin')");
    const adminToken=(await generateTokens({id:'metrics-admin',username:'metrics-admin',email:'metrics@example.test',studentId:null,grade:null,role:'admin',createdAt:1,lastLogin:null,isActive:true},env.JWT_SECRET)).accessToken;
    const overview=()=>app.request('/api/analytics/overview',{headers:{Authorization:'Bearer '+adminToken}},env);
    expect((await app.request('/api/analytics/overview',{headers},env)).status).toBe(403);
    const start=await post('/api/session/start',{bookId:'book-a'});expect(start.status).toBe(200);const {sessionId}=await start.json() as {sessionId:string};
    sqlite.prepare("UPDATE sessions SET revision_count=7,hint_success_after=2,current_claim='A different evaluator paraphrase',consecutive_no_evidence=1,hint_level=1 WHERE id=?").run(sessionId);
    const initial=await overview();expect(initial.status).toBe(200);expect(await initial.json()).toMatchObject({opsMetrics:{hintSuccessRate:null,hintEfficacyStatus:'UNKNOWN',learningEvidence:{status:'AVAILABLE',declaredRevisions:0,pendingRevisionSessions:0,acceptedRevisionFollowUps:0,savedSupportResponses:0,learningEffect:'UNKNOWN',historicalCoverage:'UNKNOWN'}}});
    expect((await post('/api/chat',{sessionId,message:'An accepted explanation mentioning evidence.'})).status).toBe(200);
    expect(sqlite.prepare('SELECT revision_count,hint_success_after FROM sessions WHERE id=?').get(sessionId)).toEqual({revision_count:7,hint_success_after:2});
    const help=await post('/api/hint',{sessionId,expectedTurn:2,mutationKey:'metrics-saved-help'});expect(help.status).toBe(200);const hint=await help.json() as {hintId:string};
    const prior=sqlite.prepare("SELECT id FROM messages WHERE session_id=? AND role='user'").get(sessionId)!;
    const input={priorMessageId:prior.id,revisedStatement:'A learner-declared conditional claim.',explanation:'A causal condition changes the conclusion.',sourceIds:['chunk-a1'],supportId:hint.hintId,expectedRevision:0,expectedTurn:2,controlRevision:0,mutationKey:'metrics-declaration'};
    expect((await post(`/api/sessions/${sessionId}/revisions`,input)).status).toBe(200);
    expect(await (await overview()).json()).toMatchObject({opsMetrics:{learningEvidence:{declaredRevisions:1,pendingRevisionSessions:1,acceptedRevisionFollowUps:0,savedSupportResponses:1,supportReferencedRevisions:1,learningEffect:'UNKNOWN'}}});
    expect((await post('/api/chat',{sessionId,message:'Compare the conditional model against the old claim.'})).status).toBe(200);
    expect(await (await overview()).json()).toMatchObject({opsMetrics:{hintSuccessRate:null,hintEfficacyStatus:'UNKNOWN',learningEvidence:{declaredRevisions:1,pendingRevisionSessions:0,acceptedRevisionFollowUps:1,savedSupportResponses:1,supportReferencedRevisions:1,learningEffect:'UNKNOWN'}}});
    expect(sqlite.prepare('SELECT revision_count,hint_success_after FROM sessions WHERE id=?').get(sessionId)).toEqual({revision_count:7,hint_success_after:2});
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['missing','failed'])('reports unavailable explicit learning metrics for a %s measurement read',async kind=>{
    const {app,env,db,sqlite}=await sparringHTTPFixture();
    sqlite.exec("INSERT INTO users(id,username,email,password_hash,role) VALUES ('metrics-admin','metrics-admin','metrics@example.test','fixture-only','admin')");
    const token=(await generateTokens({id:'metrics-admin',username:'metrics-admin',email:'metrics@example.test',studentId:null,grade:null,role:'admin',createdAt:1,lastLogin:null,isActive:true},env.JWT_SECRET)).accessToken;
    const failingDB=new Proxy(db,{get(target,property){if(property==='prepare')return (sql:string)=>{const statement=target.prepare(sql);if(!sql.includes('SPARRING_LEARNING_EVIDENCE_COUNTS'))return statement;return new Proxy(statement,{get(s,key){if(key==='first')return async()=>{if(kind==='failed')throw new Error('Offline count read failed');return null;};return Reflect.get(s,key);}});};return Reflect.get(target,property);}});
    const response=await app.request('/api/analytics/overview',{headers:{Authorization:'Bearer '+token}},{...env,DB:failingDB});expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({opsMetrics:{hintSuccessRate:null,hintEfficacyStatus:'UNKNOWN',learningEvidence:{status:'UNAVAILABLE',declaredRevisions:null,pendingRevisionSessions:null,acceptedRevisionFollowUps:null,savedSupportResponses:null,supportReferencedRevisions:null,learningEffect:'UNKNOWN'}}});
  });

  it.each(['new','superseded'])('rejects a stale Sparring answer when a %s reconstruction wins during generation',async kind=>{
    const {sqlite,post,app,env,headers}=await sparringHTTPFixture();
    const start=await post('/api/session/start',{bookId:'book-a'});expect(start.status).toBe(200);const {sessionId}=await start.json() as {sessionId:string};
    expect((await post('/api/chat',{sessionId,message:'The old causal model is universal.'})).status).toBe(200);
    const prior=sqlite.prepare("SELECT id FROM messages WHERE session_id=? AND role='user'").get(sessionId)!;
    const path=`/api/sessions/${sessionId}/revisions`;
    const input={priorMessageId:prior.id,revisedStatement:'Initial proposed causal model.',explanation:'The scope might differ.',sourceIds:[],supportId:null,expectedRevision:0,expectedTurn:2,controlRevision:0,mutationKey:'revision-before-race'};
    if(kind==='superseded')expect((await post(path,input)).status).toBe(200);
    const before=sqlite.prepare('SELECT current_turn,student_model,avg_logic FROM sessions WHERE id=?').get(sessionId);
    seams.beforeGeneration=async()=>{const r=await post(path,{...input,revisedStatement:'A newer learner-owned causal model.',expectedRevision:kind==='new'?0:1,mutationKey:'revision-wins-race'});expect(r.status,await r.clone().text()).toBe(200);};
    const response=await post('/api/chat',{sessionId,message:'An answer based on stale revision context.'});expect(response.status,await response.clone().text()).toBe(409);expect(await response.json()).toMatchObject({code:'SPARRING_REVISION_CONFLICT'});
    expect(sqlite.prepare('SELECT current_turn,student_model,avg_logic FROM sessions WHERE id=?').get(sessionId)).toEqual(before);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE session_id=?').get(sessionId)).toEqual({count:1});
    expect((await post('/api/chat',{sessionId,message:'Compare the newer causal model against the original.'})).status).toBe(200);
    const read=await (await app.request(path,{headers},env)).json() as {history:Array<{revisedStatement:string;consumedByTurn:number|null}>;pending:unknown};expect(read.pending).toBeNull();expect(read.history.at(-1)).toMatchObject({revisedStatement:'A newer learner-owned causal model.',consumedByTurn:2});
    if(kind==='superseded')expect(read.history[0].consumedByTurn).toBeNull();
  });
  it('allows learner reconstruction during a pause without resuming and refuses new declarations after stop',async()=>{
    const {sqlite,post}=await sparringHTTPFixture();
    const start=await post('/api/session/start',{bookId:'book-a'});expect(start.status).toBe(200);const {sessionId}=await start.json() as {sessionId:string};
    expect((await post('/api/chat',{sessionId,message:'My original explanation needs a condition.'})).status).toBe(200);
    const prior=sqlite.prepare("SELECT id FROM messages WHERE session_id=? AND role='user'").get(sessionId)!;
    const controlPath=`/api/sessions/${sessionId}/controls`,path=`/api/sessions/${sessionId}/revisions`;
    expect((await post(controlPath,{action:'PAUSE',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'revision-pause'})).status).toBe(200);
    const calls=seams.requests.length;
    const input={priorMessageId:prior.id,revisedStatement:'A proposed conditional explanation.',explanation:'The assumption needs evidence.',sourceIds:[],supportId:null,expectedRevision:0,expectedTurn:2,controlRevision:1,mutationKey:'paused-reconstruction'};
    const saved=await post(path,input);expect(saved.status).toBe(200);const event=await saved.json();
    expect(sqlite.prepare('SELECT action FROM sparring_controls ORDER BY revision DESC LIMIT 1').get()).toEqual({action:'PAUSE'});expect(seams.requests).toHaveLength(calls);
    expect((await post(controlPath,{action:'STOP',reason:'LEARNER_REQUEST',expectedRevision:1,mutationKey:'revision-stop'})).status).toBe(200);
    expect(await (await post(path,input)).json()).toEqual(event);
    expect((await post(path,{...input,expectedRevision:1,controlRevision:2,mutationKey:'stopped-reconstruction'})).status).toBe(409);expect(seams.requests).toHaveLength(calls);
  });
  it('preserves a learner-declared Sparring reconstruction and consumes it only with an accepted follow-up',async()=>{
    const {sqlite,post,app,env,headers}=await sparringHTTPFixture();
    const start=await post('/api/session/start',{bookId:'book-a'});expect(start.status).toBe(200);
    const {sessionId}=await start.json() as {sessionId:string};
    expect((await post('/api/chat',{sessionId,message:'The policy must work in every setting.'})).status).toBe(200);
    const help=await post('/api/hint',{sessionId,expectedTurn:2,mutationKey:'revision-support'});expect(help.status).toBe(200);const hint=await help.json() as {hintId:string};
    const original=sqlite.prepare("SELECT * FROM messages WHERE session_id=? AND role='user'").get(sessionId)!;
    const evaluation=sqlite.prepare('SELECT * FROM evaluations WHERE session_id=?').get(sessionId)!;
    const before=sqlite.prepare('SELECT current_turn,student_model,avg_logic FROM sessions WHERE id=?').get(sessionId);
    const path=`/api/sessions/${sessionId}/revisions`;
    const input={priorMessageId:original.id,revisedStatement:'The policy only works when its causal condition holds.',explanation:'A changed condition breaks the earlier causal inference.',sourceIds:['chunk-a1'],supportId:hint.hintId,expectedRevision:0,expectedTurn:2,controlRevision:0,mutationKey:'reconstruction-first'};
    const calls=seams.requests.length;
    const declared=await post(path,input);expect(declared.status,await declared.clone().text()).toBe(200);
    const event=await declared.json() as {id:string};expect(event).toMatchObject({validationStatus:'UNVERIFIED',consumedByTurn:null,priorStatement:original.content,priorEvaluationId:evaluation.id,supportId:hint.hintId});
    expect(await (await post(path,input)).json()).toEqual(event);
    expect(sqlite.prepare('SELECT current_turn,student_model,avg_logic FROM sessions WHERE id=?').get(sessionId)).toEqual(before);expect(seams.requests).toHaveLength(calls);
    expect((await post(path,{...input,explanation:'Conflicting replay'})).status).toBe(409);
    const foreign=(await generateTokens({id:'learner-b',username:'learner-b',email:'b@example.test',studentId:null,grade:null,role:'student',createdAt:1,lastLogin:null,isActive:true},env.JWT_SECRET)).accessToken;
    expect((await app.request(path,{headers:{Authorization:'Bearer '+foreign}},env)).status).toBe(404);
    expect((await post(path,{...input,expectedRevision:1,mutationKey:'invalid-source',sourceIds:['foreign-source']})).status).toBe(400);
    seams.beforeGeneration=async()=>{throw new Error('Offline interrupted reconstruction');};
    expect((await post('/api/chat',{sessionId,message:'I will test that condition against the counterexample.'})).status).toBe(503);
    let projection=await (await app.request(path,{headers},env)).json() as {pending:{id:string};history:Array<{consumedByTurn:number|null}>};expect(projection.pending.id).toBe(event.id);expect(projection.history[0].consumedByTurn).toBeNull();
    expect((await post('/api/chat',{sessionId,message:'I will test that condition against the counterexample.'})).status).toBe(200);
    expect(seams.requests.some(call=>call.lane==='interactive_generation'&&JSON.stringify(call.request).includes(input.revisedStatement)&&JSON.stringify(call.request).includes(input.explanation)&&JSON.stringify(call.request).includes('UNVERIFIED'))).toBe(true);
    expect(sqlite.prepare("SELECT sparring_revision_id FROM messages WHERE session_id=? AND role='user' AND turn=2").get(sessionId)).toEqual({sparring_revision_id:event.id});
    projection=await (await app.request(path,{headers},env)).json() as typeof projection;expect(projection.pending).toBeNull();expect(projection.history[0].consumedByTurn).toBe(2);
    expect(await (await post(path,input)).json()).toMatchObject({id:event.id,consumedByTurn:2});
    expect(sqlite.prepare('SELECT content FROM messages WHERE id=?').get(original.id)).toEqual({content:original.content});
    expect(sqlite.prepare('SELECT * FROM evaluations WHERE id=?').get(evaluation.id)).toEqual(evaluation);
    expect(()=>sqlite.exec('INSERT OR REPLACE INTO sparring_learner_revisions SELECT * FROM sparring_learner_revisions')).toThrow('SPARRING_REVISION_CONFLICT');
    expect(()=>sqlite.prepare('UPDATE messages SET content=? WHERE id=?').run('Overwrite original claim',original.id)).toThrow('SPARRING_REVISION_IMMUTABLE');
    expect(()=>sqlite.prepare('UPDATE evaluations SET defense_score=100 WHERE id=?').run(evaluation.id)).toThrow('SPARRING_REVISION_IMMUTABLE');
    expect(()=>sqlite.prepare('UPDATE messages SET timestamp=0 WHERE id=?').run(original.id)).toThrow('SPARRING_REVISION_IMMUTABLE');
    const resumed=await post(`/api/sessions/${sessionId}/resume`,{});expect(await resumed.json()).toMatchObject({revisions:{history:[{id:event.id,consumedByTurn:2}]}});
    expect((await app.request(`/api/sessions/${sessionId}`,{method:'DELETE',headers},env)).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_learner_revisions').get()).toEqual({count:0});expect(fetch).not.toHaveBeenCalled();
  });

  it('pauses concurrent Sparring retries after two accepted low observations and offers one voluntary support episode',async()=>{
    const {sqlite,post}=await sparringHTTPFixture();
    seams.router=new Proxy(seams.router!,{get(target,property,receiver){
      if(property!=='completeValidatedJSON')return Reflect.get(target,property,receiver);
      return <T>(lane:AIRouteLane,request:AIRouteRequest,validate:AIJSONValidator<T>)=>target.completeValidatedJSON(lane,request,value=>validate(lane==='learner_evaluation'&&value&&typeof value==='object'?{...value,reasoning_strength:2,evidence_use:2}:value));
    }});
    const started=await post('/api/session/start',{bookId:'book-a'});expect(started.status).toBe(200);
    const {sessionId}=await started.json() as {sessionId:string};
    for(const message of ['I think the policy always works.','I still think it always works.'])expect((await post('/api/chat',{sessionId,message})).status).toBe(200);
    const before=sqlite.prepare('SELECT student_model,current_turn,avg_logic FROM sessions WHERE id=?').get(sessionId);
    const calls=seams.requests.length;
    const attempts=await Promise.all([post('/api/chat',{sessionId,message:'A third attempt.'}),post('/api/chat',{sessionId,message:'Concurrent third attempt.'})]);
    for(const response of attempts){expect(response.status,await response.clone().text()).toBe(409);expect(await response.json()).toMatchObject({code:'SPARRING_PAUSED'});}
    expect(seams.requests).toHaveLength(calls);
    expect(sqlite.prepare('SELECT student_model,current_turn,avg_logic FROM sessions WHERE id=?').get(sessionId)).toEqual(before);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE session_id=?').get(sessionId)).toEqual({count:2});
    const policy=sqlite.prepare('SELECT origin,policy_reason,revision,previous_message_id,latest_message_id FROM sparring_controls WHERE session_id=?').all(sessionId);
    expect(policy).toEqual([{origin:'POLICY',policy_reason:'NON_PROGRESS',revision:1,previous_message_id:expect.any(Number),latest_message_id:expect.any(Number)}]);
    const hint=await post('/api/hint',{sessionId,expectedTurn:3,mutationKey:'policy-help-first'});expect(hint.status,await hint.clone().text()).toBe(200);
    const saved=await hint.json();expect(saved).toMatchObject({graded:false,responseStatus:'RESPONSE_COMMITTED'});
    const afterHelp=seams.requests.length;
    const replay=await post('/api/hint',{sessionId,expectedTurn:3,mutationKey:'policy-help-second'});expect(replay.status).toBe(200);expect(await replay.json()).toEqual(saved);
    expect(seams.requests).toHaveLength(afterHelp);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_hint_responses').get()).toEqual({count:1});
    const path=`/api/sessions/${sessionId}/controls`;
    const resumed=await post(path,{action:'RESUME',reason:'LEARNER_REQUEST',expectedRevision:1,mutationKey:'policy-resume'});expect(resumed.status).toBe(200);
    expect((await post('/api/chat',{sessionId,message:'I will reconstruct the conditions under which the policy works.'})).status).toBe(200);
    expect((await post('/api/chat',{sessionId,message:'Another low observation pair.'})).status).toBe(409);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM sparring_controls WHERE origin='POLICY'").get()).toEqual({count:2});
    const stopBefore=sqlite.prepare('SELECT student_model,current_turn,avg_logic,is_completed FROM sessions WHERE id=?').get(sessionId);
    expect((await post(path,{action:'STOP',reason:'LEARNER_REQUEST',expectedRevision:3,mutationKey:'policy-stop'})).status).toBe(200);
    expect(sqlite.prepare('SELECT student_model,current_turn,avg_logic,is_completed FROM sessions WHERE id=?').get(sessionId)).toEqual(stopBefore);
    const stoppedCalls=seams.requests.length;
    const retained=await post('/api/hint',{sessionId,expectedTurn:3,mutationKey:'policy-help-first'});
    expect(retained.status).toBe(200);expect(await retained.json()).toEqual(saved);
    expect(seams.requests).toHaveLength(stoppedCalls);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_hint_responses').get()).toEqual({count:1});
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['RESUME','STOP'])('rejects policy-paused support when %s wins during generation',async action=>{
    const {sqlite,post,app,env,headers}=await sparringHTTPFixture();
    const start=await post('/api/session/start',{bookId:'book-a'});expect(start.status).toBe(200);
    const {sessionId}=await start.json() as {sessionId:string};
    for(const message of ['First learner explanation.','Second learner explanation.'])expect((await post('/api/chat',{sessionId,message})).status).toBe(200);
    sqlite.prepare('UPDATE evaluations SET defense_score=40,evidence_score=40 WHERE session_id=?').run(sessionId);
    expect((await post('/api/chat',{sessionId,message:'Trigger support offer.'})).status).toBe(409);
    const before=sqlite.prepare('SELECT student_model,current_turn,avg_logic,hint_request_count FROM sessions WHERE id=?').get(sessionId);
    seams.beforeGeneration=async()=>{expect((await post(`/api/sessions/${sessionId}/controls`,{action,reason:'LEARNER_REQUEST',expectedRevision:1,mutationKey:'support-control-race'})).status).toBe(200);};
    const response=await post('/api/hint',{sessionId,expectedTurn:3,mutationKey:'policy-racing-help'});expect(response.status,await response.clone().text()).toBe(409);
    expect(sqlite.prepare('SELECT student_model,current_turn,avg_logic,hint_request_count FROM sessions WHERE id=?').get(sessionId)).toEqual(before);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_hint_responses').get()).toEqual({count:0});
    expect((await post(`/api/sessions/${sessionId}/controls`,{action:'PAUSE',reason:'INSUFFICIENT_EVIDENCE',expectedRevision:2,mutationKey:'forged-policy',origin:'POLICY',policy_reason:'NON_PROGRESS'})).status).toBe(400);
    expect(()=>sqlite.exec('INSERT OR REPLACE INTO sparring_controls SELECT * FROM sparring_controls')).toThrow('SPARRING_CONTROL_CONFLICT');
    expect((await app.request(`/api/sessions/${sessionId}`,{method:'DELETE',headers},env)).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_controls').get()).toEqual({count:0});
  });
  it.each(['one-low','zero','missing','invalid-step'])('does not infer Sparring non-progress from %s observations',async kind=>{
    const {sqlite,post}=await sparringHTTPFixture();
    const started=await post('/api/session/start',{bookId:'book-a'});expect(started.status).toBe(200);
    const {sessionId}=await started.json() as {sessionId:string};
    for(const message of ['First accepted explanation.','Second accepted explanation.'])expect((await post('/api/chat',{sessionId,message})).status).toBe(200);
    sqlite.prepare('UPDATE evaluations SET defense_score=40,evidence_score=40 WHERE session_id=?').run(sessionId);
    if(kind==='missing')sqlite.prepare('DELETE FROM evaluations WHERE session_id=? AND turn=1').run(sessionId);
    else sqlite.prepare('UPDATE evaluations SET defense_score=? WHERE session_id=? AND turn=1').run(kind==='one-low'?60:kind==='zero'?0:30,sessionId);
    const response=await post('/api/chat',{sessionId,message:'This observation should remain unclassified.'});expect(response.status,await response.clone().text()).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_controls').get()).toEqual({count:0});
  });

  it.each(['',' with follow-up source erased first',' with baseline source erased first'])('reaches canonical Sparring completion through ten accepted production chat turns and opens Growth from that result%s', async (erasure) => {
    const {sqlite,env,failures,app,headers,token,post}=await sparringHTTPFixture();
    const started=await post('/api/session/start',{bookId:'book-a'});
    expect(started.status).toBe(200);
    const {sessionId}=await started.json() as {sessionId:string};
    expect((await post('/api/hint',{sessionId,mutationKey:'before-diagnosis',expectedTurn:1})).status).toBe(409);
    const inputCalls=seams.requests.length;
    for(const body of [{sessionId,mutationKey:'missing-turn'},{sessionId,expectedTurn:1},
      {sessionId,mutationKey:'short',expectedTurn:1},{sessionId,mutationKey:'invalid-turn',expectedTurn:1.5},
      {sessionId,mutationKey:'extra-fields',expectedTurn:1,owner:'learner-a'}]){
      expect((await post('/api/hint',body)).status).toBe(400);
    }
    expect((await app.request('/api/hint',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,mutationKey:'unauthenticated-hint',expectedTurn:1})},env)).status).toBe(401);
    expect(seams.requests).toHaveLength(inputCalls);
    const complete=async(sessionId:string,failFinal=false)=>{for(let turn=1;turn<=10;turn++){
      if(failFinal&&turn===2){
        seams.beforeGeneration=async()=>{
          expect((await post('/api/hint',{sessionId,mutationKey:'concurrent-hint',expectedTurn:2})).status).toBe(200);
        };
        const raced=await post('/api/chat',{sessionId,message:`정책 근거를 확인하면 판단의 적용 범위를 제한해야 합니다. 조건과 반례를 비교한 ${turn}번째 설명입니다.`});
        expect(raced.status).toBeGreaterThanOrEqual(500);
        expect(failures.at(-1)).toContain('SPARRING_HINT_CONTEXT_CHANGED');
        expect(sqlite.prepare('SELECT current_turn,hint_request_count FROM sessions WHERE id=?').get(sessionId)).toEqual({current_turn:2,hint_request_count:2});
        expect(sqlite.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND role='user'").get(sessionId)).toEqual({count:1});
      }
      if(failFinal&&turn===10){
        const before=sqlite.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
        sqlite.exec("CREATE TRIGGER fixture_final_turn_failure BEFORE INSERT ON evaluations WHEN NEW.turn=10 BEGIN SELECT RAISE(ABORT,'fixture final turn failure'); END");
        const refused=await post('/api/chat',{sessionId,message:`정책 근거를 확인하면 판단의 적용 범위를 제한해야 합니다. 조건과 반례를 비교한 ${turn}번째 설명입니다.`});
        expect(refused.status).toBeGreaterThanOrEqual(500);
        expect(sqlite.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId)).toEqual(before);
        expect(sqlite.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND role='user'").get(sessionId)).toEqual({count:9});
        sqlite.exec('DROP TRIGGER fixture_final_turn_failure');
      }
      const response=await post('/api/chat',{sessionId,message:`정책 근거를 확인하면 판단의 적용 범위를 제한해야 합니다. 조건과 반례를 비교한 ${turn}번째 설명입니다.`});
      const body=await response.json();
      expect(response.status,JSON.stringify(body)).toBe(200);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND role='user'").get(sessionId)).toEqual({count:turn});
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE session_id=? AND user_id=?').get(sessionId,'learner-a')).toEqual({count:turn});
      expect(sqlite.prepare('SELECT current_turn,is_completed,session_completion_turn FROM sessions WHERE id=?').get(sessionId)).toEqual({current_turn:turn+1,is_completed:turn===10?1:0,session_completion_turn:turn===10?10:null});
      if(failFinal&&turn===2){
        const calls=seams.requests.length;
        const beforeHints=sqlite.prepare('SELECT hint_request_count FROM sessions WHERE id=?').get(sessionId);
        const stale=await post('/api/hint',{sessionId,mutationKey:'failed-before-advance',expectedTurn:2});
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({code:'SPARRING_HINT_CONTEXT_CHANGED',retryable:false});
        const replay=await post('/api/hint',{sessionId,mutationKey:'accepted-sp-hint',expectedTurn:2});
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({turnNumber:2,graded:false});
        expect(seams.requests).toHaveLength(calls);
        expect(sqlite.prepare('SELECT hint_request_count FROM sessions WHERE id=?').get(sessionId)).toEqual(beforeHints);
      }
      if(failFinal&&turn===1){
        const before=sqlite.prepare('SELECT student_model,layer_state_json,current_turn FROM sessions WHERE id=?').get(sessionId);
        seams.beforeGeneration=async()=>{throw new Error('Offline hint provider unavailable');};
        expect((await post('/api/hint',{sessionId,mutationKey:'failed-before-advance',expectedTurn:2})).status).toBe(503);
        sqlite.exec('CREATE TRIGGER fixture_hint_counter_failure BEFORE UPDATE OF hint_request_count ON sessions BEGIN SELECT RAISE(ABORT,\'fixture hint counter failure\'); END');
        expect((await post('/api/hint',{sessionId,mutationKey:'accepted-sp-hint',expectedTurn:2})).status).toBe(503);
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_hint_responses WHERE session_id=?').get(sessionId)).toEqual({count:0});
        expect(sqlite.prepare('SELECT hint_request_count FROM sessions WHERE id=?').get(sessionId)).toEqual({hint_request_count:0});
        sqlite.exec('DROP TRIGGER fixture_hint_counter_failure');
        const hint=await post('/api/hint',{sessionId,mutationKey:'accepted-sp-hint',expectedTurn:2});
        expect(hint.status,await hint.clone().text()).toBe(200);
        const saved=await hint.json() as {hintId:string};
        const context=sqlite.prepare('SELECT id,route_plan_json,prompt_cache_namespace FROM learning_session_contexts WHERE session_id=?').get(sessionId)!;
        expect(seams.routerOptions.at(-1)).toMatchObject({mode:'context_bound',pinnedRoutePlan:JSON.parse(String(context.route_plan_json)),invocationScope:{sessionId,sessionContextId:context.id,turnNumber:2,promptCacheNamespace:context.prompt_cache_namespace}});
        expect(saved,JSON.stringify(saved)).toMatchObject({graded:false,responseStatus:'RESPONSE_COMMITTED',deliveryValidation:'UNKNOWN',sourceIds:expect.arrayContaining(['chunk-a1'])});
        expect(sqlite.prepare('SELECT student_model,layer_state_json,current_turn FROM sessions WHERE id=?').get(sessionId)).toEqual(before);
        const calls=seams.requests.length;
        expect(await (await post('/api/hint',{sessionId,mutationKey:'accepted-sp-hint',expectedTurn:2})).json()).toEqual(saved);
        expect((await post('/api/hint',{sessionId,mutationKey:'accepted-sp-hint',expectedTurn:3})).status).toBe(409);
        expect(seams.requests).toHaveLength(calls);
        expect(sqlite.prepare('SELECT hint_request_count FROM sessions WHERE id=?').get(sessionId)).toEqual({hint_request_count:1});
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_hint_responses WHERE session_id=?').get(sessionId)).toEqual({count:1});
        expect(()=>sqlite.exec('INSERT OR REPLACE INTO sparring_hint_responses SELECT * FROM sparring_hint_responses')).toThrow('SPARRING_HINT_CONTEXT_CHANGED');
        expect(()=>sqlite.exec("UPDATE sparring_hint_responses SET response_text='Rewrite'")).toThrow('SPARRING_HINT_IMMUTABLE');
        const resumed=await post(`/api/sessions/${sessionId}/resume`,{});
        expect(resumed.status).toBe(200);
        expect(await resumed.json()).toMatchObject({hintResponses:[saved]});
        const controlPath=`/api/sessions/${sessionId}/controls`;
        expect((await post(controlPath,{action:'PAUSE',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'growth-record-pause'})).status).toBe(200);
        const original=sqlite.prepare("SELECT id FROM messages WHERE session_id=? AND role='user' AND turn=1").get(sessionId)!;
        const revision=await post(`/api/sessions/${sessionId}/revisions`,{priorMessageId:original.id,revisedStatement:'조건이 달라지면 정책의 적용 범위를 다시 제한해야 합니다.',
          explanation:'이전 판단은 같은 조건이 유지된다고 가정했기 때문입니다.',sourceIds:['chunk-a1'],supportId:saved.hintId,
          expectedRevision:0,expectedTurn:2,controlRevision:1,mutationKey:'growth-record-revision'});
        expect(revision.status,await revision.clone().text()).toBe(200);
        expect((await post(controlPath,{action:'RESUME',reason:'LEARNER_REQUEST',expectedRevision:1,mutationKey:'growth-record-resume'})).status).toBe(200);
      }
    }};
    await complete(sessionId);
    const before=sqlite.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    expect((await post('/api/chat',{sessionId,message:'One extra turn'})).status).toBe(400);
    expect(sqlite.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId)).toEqual(before);
    expect((await post('/api/growth/privacy/consent',{purpose:'Private learning review',dataClasses:['learning_evidence'],policyRevision:1,retentionPolicy:'Until learner deletion'},'accepted-sp-consent')).status).toBe(200);
    const spaceResponse=await post('/api/growth/spaces/solo',undefined,'accepted-sp-space');
    expect(spaceResponse.status).toBe(200);
    const {spaceId}=await spaceResponse.json() as {spaceId:string};
    const opened=await post(`/api/growth/spaces/${spaceId}/cycles`,{originKind:'SPARRING',originAttemptId:sessionId},'accepted-sp-open');
    expect(opened.status,await opened.clone().text()).toBe(200);
    expect(sqlite.prepare('SELECT origin_event_identity FROM growth_cycles').get()?.origin_event_identity).toContain(':message:');
    const cycle=await opened.json() as {cycleId:string;aggregateRevision:number};
    const path=`/api/growth/spaces/${spaceId}/cycles/${cycle.cycleId}`;
    const detail=async()=>{const response=await app.request(path,{headers},env);expect(response.status).toBe(200);return (await response.json() as {cycle:GrowthCycleDetail}).cycle;};
    const focusResponse=await post(path+'/focus',{capabilityId:(await detail()).observations[0].capabilityId,capabilityRevision:1,statement:'Explain a causal claim under a changed condition',expectedRevision:cycle.aggregateRevision},'accepted-sp-focus');
    expect(focusResponse.status).toBe(200);
    const focus=await focusResponse.json() as {practiceQuestId:string;aggregateRevision:number};
    const scheduledResponse=await post(path+'/practice-response',{action:'accept',practiceQuestId:focus.practiceQuestId,expectedRevision:focus.aggregateRevision},'accepted-sp-practice');
    expect(scheduledResponse.status).toBe(200);
    const scheduled=await scheduledResponse.json() as {aggregateRevision:number};
    const recheck=(await detail()).rechecks[0];
    const clock=vi.spyOn(Date,'now').mockReturnValue(recheck.scheduledFor+1); // Simulated delay, not longitudinal evidence.
    headers.Authorization='Bearer '+(await generateTokens({id:'learner-a',username:'learner-a',email:'a@example.test',studentId:null,grade:null,role:'student',createdAt:1,lastLogin:null,isActive:true},env.JWT_SECRET)).accessToken;
    const launchResponse=await post(path+'/recheck-follow-up-launches',{recheckId:recheck.id,changedCondition:'Assume the evidence applies to only half the original population.',expectedRevision:scheduled.aggregateRevision},'accepted-sp-launch');
    expect(launchResponse.status).toBe(200);
    const launch=await launchResponse.json() as {launchId:string;aggregateRevision:number};
    expect(sqlite.prepare('SELECT assistance_capture_revision FROM growth_recheck_sparring_follow_up_launches WHERE id=?').get(launch.launchId))
      .toEqual({assistance_capture_revision:'sparring-record-index-v2'});
    expect(()=>sqlite.prepare("UPDATE growth_recheck_sparring_follow_up_launches SET assistance_capture_revision='sparring-session-totals-v1' WHERE id=?").run(launch.launchId)).toThrow('GROWTH_FOLLOW_UP_IMMUTABLE');
    const followUpResponse=await post('/api/session/start',{growthFollowUpLaunchId:launch.launchId});
    expect(followUpResponse.status).toBe(200);
    const followUp=await followUpResponse.json() as {sessionId:string};
    await complete(followUp.sessionId,true);
    const hintCalls=seams.requests.length;
    expect((await post('/api/hint',{sessionId:followUp.sessionId,mutationKey:'after-completion',expectedTurn:11})).status).toBe(409);
    expect(seams.requests).toHaveLength(hintCalls);
    const reportPath=`/api/sessions/${followUp.sessionId}/report`;
    const report=await app.request(reportPath,{headers},env);
    expect(report.status).toBe(200);
    expect(await report.json()).toMatchObject({hintHistoryStatus:'RECORDED',hintResponses:[{turnNumber:2,graded:false},{turnNumber:2,graded:false}]});
    const readyDB=env.DB;
    env.DB=new Proxy(readyDB,{get(target,property,receiver){
      if(property!=='prepare')return Reflect.get(target,property,receiver);
      return (sql:string)=>sql.includes('SELECT hint.* FROM sparring_hint_responses')
        ? {bind:()=>({all:async()=>{throw new Error('Offline hint history unavailable');}})} : target.prepare(sql);
    }});
    const unavailableHistory=await app.request(reportPath,{headers},env);
    expect(unavailableHistory.status).toBe(200);
    expect(await unavailableHistory.json()).toMatchObject({hintHistoryStatus:'UNAVAILABLE',hintResponses:[],session:{currentTurn:11}});
    env.DB=readyDB;
    const rawHint=sqlite.prepare('SELECT * FROM sparring_hint_responses LIMIT 1').get()!;
    for(const corrupt of [{source_snapshot_json:'[{"sourceId":"x"}]'},
      {source_snapshot_json:'[{"sourceId":"x","excerpt":"text","contentSha256":"invalid"}]'},
      {id:''},{created_at:-1}]){
      env.DB=new Proxy(readyDB,{get(target,property,receiver){
        if(property!=='prepare')return Reflect.get(target,property,receiver);
        return (sql:string)=>sql.includes('SELECT hint.* FROM sparring_hint_responses')
          ? {bind:()=>({all:async()=>({success:true,results:[{...rawHint,...corrupt}]})})} : target.prepare(sql);
      }});
      const corruptHistory=await app.request(reportPath,{headers},env);
      expect(corruptHistory.status).toBe(200);
      expect(await corruptHistory.json()).toMatchObject({hintHistoryStatus:'UNAVAILABLE',hintResponses:[]});
    }
    env.DB=readyDB;
    const beforeRecord=sqlite.prepare('SELECT COUNT(*) AS count FROM growth_capability_observations').get();
    const failedCollections=['SELECT hint.* FROM sparring_hint_responses','SELECT r.*,m.turn AS consumed_by_turn FROM sparring_learner_revisions','SELECT * FROM sparring_controls'];
    const failCollection=(pattern:string)=>new Proxy(readyDB,{get(target,property,receiver){
        if(property!=='prepare')return Reflect.get(target,property,receiver);
        return (sql:string)=>sql.includes(pattern) ? {bind:()=>({all:async()=>({success:false,results:[]})})} : target.prepare(sql);
      }});
    for(const pattern of failedCollections){
      env.DB=failCollection(pattern);
      const unavailableCapture=await post(path+'/rechecks',{action:'record',recheckId:recheck.id,followUpLaunchId:launch.launchId,expectedRevision:launch.aggregateRevision},'accepted-sp-record');
      expect(unavailableCapture.status,pattern).toBe(503);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM growth_capability_observations').get()).toEqual(beforeRecord);
      expect(sqlite.prepare('SELECT completed_message_id FROM growth_recheck_sparring_follow_up_bindings WHERE launch_id=?').get(launch.launchId)).toEqual({completed_message_id:null});
    }
    env.DB=readyDB;
    const recorded=await post(path+'/rechecks',{action:'record',recheckId:recheck.id,followUpLaunchId:launch.launchId,expectedRevision:launch.aggregateRevision},'accepted-sp-record');
    expect(recorded.status,await recorded.clone().text()).toBe(200);
    const recheckDetail=(await detail()).rechecks[0];
    expect(recheckDetail).toMatchObject({outcome:'UNKNOWN',followUpOriginKind:'SPARRING',followUpLaunch:{sessionCompleted:true,recheckRecorded:true},
      assistance:{status:'RECORDED',kind:'SPARRING_RECORDS_V2',baseline:{detail:{status:'AVAILABLE'}},followUp:{detail:{status:'AVAILABLE',records:{
        turns:expect.arrayContaining([expect.objectContaining({turn:2,revisionId:expect.any(String)})]),
        hints:expect.arrayContaining([expect.objectContaining({graded:false,deliveryValidation:'UNKNOWN',sources:expect.arrayContaining([expect.objectContaining({sourceId:'chunk-a1',excerpt:'policy evidence alpha',contentSha256:expect.stringMatching(/^[a-f0-9]{64}$/)})])})]),
        revisions:[expect.objectContaining({validationStatus:'UNVERIFIED',consumedByTurn:2,explanation:'이전 판단은 같은 조건이 유지된다고 가정했기 때문입니다.'})],
        controls:[expect.objectContaining({action:'PAUSE',origin:'LEARNER'}),expect.objectContaining({action:'RESUME',origin:'LEARNER'})],
      }}}}});
    const observation=sqlite.prepare('SELECT raw_signal_json FROM growth_capability_observations WHERE id=?').get(recheckDetail.recheckObservationId!)!;
    expect((await app.request(path,{},env)).status).toBe(401);
    sqlite.exec("INSERT INTO users (id,username,email,password_hash) VALUES('learner-b','learner-b','b@example.test','fixture-only')");
    const foreignToken=(await generateTokens({id:'learner-b',username:'learner-b',email:'b@example.test',studentId:null,grade:null,role:'student',createdAt:1,lastLogin:null,isActive:true},env.JWT_SECRET)).accessToken;
    const foreignDetail=await app.request(path,{headers:{Authorization:'Bearer '+foreignToken}},env);
    expect(foreignDetail.status).toBe(404);
    expect(await foreignDetail.text()).not.toContain('이전 판단은');
    const captured=JSON.parse(String(observation.raw_signal_json)).storedSourcePayload.assistance;
    expect(captured.logSha256).toBe(createHash('sha256').update(captured.logJson).digest('hex'));
    expect(captured.logJson).not.toContain('이전 판단은');
    expect(captured.logJson).not.toContain('hintMessage');
    for(const pattern of failedCollections){
      env.DB=failCollection(pattern);
      expect((await detail()).rechecks[0].assistance).toMatchObject({kind:'SPARRING_RECORDS_V2',followUp:{detail:{status:'UNAVAILABLE'}}});
    }
    env.DB=readyDB;
    if(process.env.SOCRATIC_ASSISTANCE_FIXTURE_OUTPUT&&!erasure){
      const spaces=await (await app.request('/api/growth/spaces',{headers},env)).json();
      const report=await (await app.request(reportPath,{headers},env)).json();
      const baselineResponse=await app.request(`/api/sessions/${sessionId}/report`,{headers},env);
      expect(baselineResponse.status).toBe(200);
      const baselineReport=await baselineResponse.json();
      writeFileSync(process.env.SOCRATIC_ASSISTANCE_FIXTURE_OUTPUT,JSON.stringify({mode:'OFFLINE_PRODUCTION_HTTP_FIXTURE',spaces,cycle:await detail(),report,baselineReport},null,2));
    }
    expect(()=>sqlite.exec('DELETE FROM growth_recheck_sparring_follow_up_bindings')).toThrow('GROWTH_FOLLOW_UP_IMMUTABLE');
    expect(()=>sqlite.prepare("UPDATE messages SET content='Rewrite protected reconstruction source' WHERE session_id=? AND role='user' AND turn=1").run(followUp.sessionId)).toThrow('SPARRING_REVISION_IMMUTABLE');
    const originalContent=sqlite.prepare("SELECT content FROM messages WHERE session_id=? AND role='user' AND turn=3").get(followUp.sessionId)!;
    sqlite.prepare("UPDATE messages SET content='Changed original after recording' WHERE session_id=? AND role='user' AND turn=3").run(followUp.sessionId);
    expect((await detail()).rechecks[0].assistance).toMatchObject({kind:'SPARRING_RECORDS_V2',followUp:{detail:{status:'UNAVAILABLE'}}});
    sqlite.prepare("UPDATE messages SET content=? WHERE session_id=? AND role='user' AND turn=3").run(originalContent.content!,followUp.sessionId);
    if(erasure){
      const erasedId=erasure.includes('baseline')?sessionId:followUp.sessionId;
      const erasedSource=await app.request(`/api/sessions/${erasedId}`,{method:'DELETE',headers},env);
      expect(erasedSource.status,(await erasedSource.clone().text())+' '+JSON.stringify(failures.slice(-1))).toBe(200);
      const afterErasure=await detail();
      expect(afterErasure.rechecks[0].assistance).toEqual({status:'UNAVAILABLE'});
      expect(JSON.stringify(afterErasure)).not.toContain('이전 판단은 같은 조건');
    }
    const recording=await recorded.json() as {aggregateRevision:number};
    clock.mockRestore(); headers.Authorization='Bearer '+token;
    const erasedGrowth=await app.request(path,{method:'DELETE',headers:{...headers,'Idempotency-Key':'accepted-sp-delete'},body:JSON.stringify({expectedRevision:recording.aggregateRevision})},env);
    expect(erasedGrowth.status,await erasedGrowth.clone().text()).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM growth_capability_observations').get()).toEqual({count:0});
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_hint_responses').get()).toEqual({count:erasure.includes('follow-up')?0:2});
    if(!erasure.includes('follow-up')){
      const erasedSession=await app.request(`/api/sessions/${followUp.sessionId}`,{method:'DELETE',headers},env);
      expect(erasedSession.status,await erasedSession.clone().text()).toBe(200);
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_hint_responses').get()).toEqual({count:0});
    expect(Boolean(sqlite.prepare('SELECT id FROM sessions WHERE id=?').get(sessionId))).toBe(!erasure.includes('baseline'));
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a hint whose same retry key commits for a later turn while generation is pending', async () => {
    const {sqlite,env,post}=await sparringHTTPFixture();
    const started=await post('/api/session/start',{bookId:'book-a'});
    expect(started.status).toBe(200);
    const {sessionId}=await started.json() as {sessionId:string};
    expect((await post('/api/chat',{sessionId,message:'A claim needs evidence and a stated condition.'})).status).toBe(200);
    seams.beforeGeneration=async()=>{
      expect((await post('/api/chat',{sessionId,message:'The condition limits which cases the evidence supports.'})).status).toBe(200);
      const later=await post('/api/hint',{sessionId,mutationKey:'same-key-later-turn',expectedTurn:3});
      expect(later.status,await later.clone().text()).toBe(200);
    };
    const stale=await post('/api/hint',{sessionId,mutationKey:'same-key-later-turn',expectedTurn:2});
    expect(stale.status,await stale.clone().text()).toBe(409);
    expect(await stale.json()).toMatchObject({code:'SPARRING_HINT_CONTEXT_CHANGED',retryable:false});
    expect(sqlite.prepare('SELECT current_turn,hint_request_count FROM sessions WHERE id=?').get(sessionId)).toEqual({current_turn:3,hint_request_count:1});
    expect(sqlite.prepare('SELECT turn_number FROM sparring_hint_responses WHERE session_id=?').all(sessionId)).toEqual([{turn_number:3}]);
    const calls=seams.requests.length;
    expect((await post('/api/hint',{sessionId,mutationKey:'same-key-later-turn',expectedTurn:2})).status).toBe(409);
    const replay=await post('/api/hint',{sessionId,mutationKey:'same-key-later-turn',expectedTurn:3});
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({turnNumber:3,graded:false});
    expect(seams.requests).toHaveLength(calls);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['','   '])('refuses Sparring help without a usable diagnosis: %j',async diagnosis=>{
    const {sqlite,env,post}=await sparringHTTPFixture();
    const started=await post('/api/session/start',{bookId:'book-a'});
    expect(started.status).toBe(200);
    const {sessionId}=await started.json() as {sessionId:string};
    expect((await post('/api/chat',{sessionId,message:'A claim needs evidence and a condition.'})).status).toBe(200);
    sqlite.prepare("UPDATE evaluations SET feedback=json_set(feedback,'$.diagnosis',?) WHERE session_id=?").run(diagnosis,sessionId);
    const calls=seams.requests.length;
    const response=await post('/api/hint',{sessionId,mutationKey:'empty-diagnosis',expectedTurn:2});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({code:'SPARRING_HINT_DIAGNOSIS_UNAVAILABLE',retryable:false});
    expect(seams.requests).toHaveLength(calls);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_hint_responses').get()).toEqual({count:0});
    expect(sqlite.prepare('SELECT hint_request_count FROM sessions WHERE id=?').get(sessionId)).toEqual({hint_request_count:0});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports erased Sparring context as nonretryable during hint persistence',async()=>{
    const {sqlite,post}=await sparringHTTPFixture();
    const started=await post('/api/session/start',{bookId:'book-a'});
    expect(started.status).toBe(200);
    const {sessionId}=await started.json() as {sessionId:string};
    expect((await post('/api/chat',{sessionId,message:'A claim needs evidence and a condition.'})).status).toBe(200);
    seams.beforeGeneration=async()=>{
      sqlite.prepare("INSERT INTO learning_session_context_deletion_authorizations SELECT id,'fixture-context-erasure',? FROM learning_session_contexts WHERE session_id=?").run(Date.now(),sessionId);
      sqlite.prepare('DELETE FROM learning_session_contexts WHERE session_id=?').run(sessionId);
    };
    const response=await post('/api/hint',{sessionId,mutationKey:'erased-context-help',expectedTurn:2});
    expect(response.status,await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({code:'SESSION_CONTEXT_REQUIRED',retryable:false});
    const calls=seams.requests.length;
    expect((await post('/api/hint',{sessionId,mutationKey:'erased-context-help',expectedTurn:2})).status).toBe(409);
    expect(seams.requests).toHaveLength(calls);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_hint_responses').get()).toEqual({count:0});
    expect(sqlite.prepare('SELECT hint_request_count FROM sessions WHERE id=?').get(sessionId)).toEqual({hint_request_count:0});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('persists learner pause resume and stop without treating a stopped Sparring session as completed',async()=>{
    const {sqlite,env,post,app,headers}=await sparringHTTPFixture();
    const start=await post('/api/session/start',{bookId:'book-a'});
    expect(start.status).toBe(200);
    const {sessionId}=await start.json() as {sessionId:string};
    expect((await post('/api/chat',{sessionId,message:'Evidence supports a claim under a condition.'})).status).toBe(200);
    const path=`/api/sessions/${sessionId}/controls`;
    const pause=await post(path,{action:'PAUSE',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'learner-pause'});
    expect(pause.status,await pause.clone().text()).toBe(200);
    expect(await pause.json()).toMatchObject({state:'PAUSED',revision:1});
    const calls=seams.requests.length;
    expect((await post('/api/chat',{sessionId,message:'An answer while paused'})).status).toBe(409);
    expect(seams.requests).toHaveLength(calls);
    const resume=await post(path,{action:'RESUME',reason:'LEARNER_REQUEST',expectedRevision:1,mutationKey:'learner-resume'});
    expect(resume.status).toBe(200);
    expect(await resume.json()).toMatchObject({state:'ACTIVE',revision:2});
    expect((await post('/api/chat',{sessionId,message:'The condition excludes a counterexample.'})).status).toBe(200);
    const before=sqlite.prepare('SELECT student_model,layer_state_json,current_turn,avg_logic,is_completed,is_abandoned FROM sessions WHERE id=?').get(sessionId);
    const stop={action:'STOP',reason:'LEARNER_REQUEST',expectedRevision:2,mutationKey:'learner-stop'};
    const stopped=await post(path,stop);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({state:'STOPPED',revision:3});
    expect(()=>sqlite.exec('INSERT OR REPLACE INTO sparring_controls SELECT * FROM sparring_controls')).toThrow('SPARRING_CONTROL_CONFLICT');
    expect(()=>sqlite.exec("UPDATE sparring_controls SET reason='TIME_LIMIT'")).toThrow('SPARRING_CONTROL_IMMUTABLE');
    expect(()=>sqlite.exec('DELETE FROM sparring_controls')).toThrow('SPARRING_CONTROL_IMMUTABLE');
    expect((await post(path,stop)).status).toBe(200);
    expect(sqlite.prepare('SELECT student_model,layer_state_json,current_turn,avg_logic,is_completed,is_abandoned FROM sessions WHERE id=?').get(sessionId)).toEqual(before);
    const stoppedCalls=seams.requests.length;
    expect((await post('/api/chat',{sessionId,message:'An answer after stopping'})).status).toBe(409);
    expect((await post('/api/hint',{sessionId,mutationKey:'stopped-hint',expectedTurn:3})).status).toBe(409);
    expect((await post(path,{action:'RESUME',reason:'LEARNER_REQUEST',expectedRevision:3,mutationKey:'after-stop-resume'})).status).toBe(409);
    expect(seams.requests).toHaveLength(stoppedCalls);
    const history=await app.request(`/api/sessions/${sessionId}/report`,{headers},env);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({controls:{state:'STOPPED',revision:3}});
    const list=await app.request('/api/sessions',{headers},env);
    expect((await list.json() as {sessions:Array<{id:string;canResume:boolean;controlState:string}>}).sessions.find(s=>s.id===sessionId)).toMatchObject({canResume:false,controlState:'STOPPED'});
    const hydrated=await post(`/api/sessions/${sessionId}/resume`,{});
    expect(await hydrated.json()).toMatchObject({controls:{state:'STOPPED'},message:expect.not.stringContaining('진행할 수 있습니다')});
    expect((await app.request(`/api/sessions/${sessionId}`,{method:'DELETE',headers},env)).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_controls').get()).toEqual({count:0});
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['quarantined','deleted','foreign-private','unknown','missing'])('refuses new Training source use after %s while retaining saved history',async state=>{
    const {sqlite,post,app,env,headers,start}=await trainingHTTPFixture();
    const created=await post('/api/training/start',start);expect(created.status).toBe(200);
    const {sessionId}=await created.json() as {sessionId:string};
    const path=`/api/training/session/${sessionId}`;
    expect((await post('/api/training/chat',{sessionId,message:'Evidence supports a conditional policy claim.'})).status).toBe(200);
    expect((await post(path+'/interventions',{action:'HELP',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'before-training-source'})).status).toBe(200);
    const recorded=await post(path+'/support',{});expect(recorded.status).toBe(200);const saved=await recorded.json();
    const before=sqlite.prepare('SELECT current_turn,student_model,avg_score,is_completed FROM training_sessions WHERE id=?').get(sessionId);
    const snapshot=sqlite.prepare('SELECT source_id,excerpt,content_sha256 FROM training_scenario_evidence WHERE session_id=? ORDER BY source_id').all(sessionId);
    if(state==='quarantined')sqlite.exec("UPDATE books SET visibility='quarantined' WHERE id='book-a'");
    if(state==='deleted')sqlite.exec("UPDATE books SET lifecycle_status='deleted' WHERE id='book-a'");
    if(state==='unknown')sqlite.exec("UPDATE books SET lifecycle_status='unconfirmed' WHERE id='book-a'");
    if(state==='foreign-private'){
      sqlite.exec("INSERT INTO users(id,username,email,password_hash) VALUES ('foreign-book-owner','foreign-book-owner','foreign@example.test','fixture'); UPDATE books SET is_builtin=0,visibility='private',owner_user_id='foreign-book-owner' WHERE id='book-a'");
    }
    if(state==='missing')sqlite.exec("DELETE FROM document_chunks WHERE book_id='book-a'; DELETE FROM books WHERE id='book-a'");
    const calls=seams.requests.length;
    const rejected=await post('/api/training/chat',{sessionId,message:'This answer must not use the revoked evidence.'});
    expect(rejected.status,await rejected.clone().text()).toBe(409);
    expect(await rejected.json()).toMatchObject({code:'TRAINING_SOURCE_UNAVAILABLE',retryable:false});
    expect(await (await post(path+'/support',{})).json()).toEqual(saved); // Saved response replay is not generation.
    expect((await post(path+'/interventions',{action:'HELP',reason:'LEARNER_REQUEST',expectedRevision:1,mutationKey:'after-training-source'})).status).toBe(200);
    const support=await post(path+'/support',{});expect(support.status).toBe(409);
    expect(await support.json()).toMatchObject({code:'TRAINING_SOURCE_UNAVAILABLE',retryable:false});
    expect(seams.requests).toHaveLength(calls);
    expect(sqlite.prepare('SELECT current_turn,student_model,avg_score,is_completed FROM training_sessions WHERE id=?').get(sessionId)).toEqual(before);
    expect(sqlite.prepare('SELECT source_id,excerpt,content_sha256 FROM training_scenario_evidence WHERE session_id=? ORDER BY source_id').all(sessionId)).toEqual(snapshot);
    expect((await app.request(path,{headers},env)).status).toBe(200);
    expect((await post(path+'/resume',{})).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_turns WHERE session_id=?').get(sessionId)).toEqual({count:1});
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_support_responses WHERE session_id=?').get(sessionId)).toEqual({count:1});
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['start','chat','support'])('withholds Training %s when quarantine wins its accepted write',async operation=>{
    const {sqlite,db,env,post,start}=await trainingHTTPFixture();let sessionId='';
    if(operation!=='start'){
      sessionId=(await (await post('/api/training/start',start)).json() as {sessionId:string}).sessionId;
      if(operation==='support'){
        expect((await post('/api/training/chat',{sessionId,message:'Evidence supports a conditional policy claim.'})).status).toBe(200);
        expect((await post(`/api/training/session/${sessionId}/interventions`,{action:'HELP',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'pending-training-support'})).status).toBe(200);
      }
    }
    const before=sessionId?sqlite.prepare('SELECT current_turn,student_model,avg_score FROM training_sessions WHERE id=?').get(sessionId):null;
    const revoke=()=>sqlite.exec("UPDATE books SET visibility='quarantined' WHERE id='book-a'");
    if(operation==='start'){
      let pending=true;
      const startWrites=new WeakSet<D1PreparedStatement>();
      const mark=(statement:D1PreparedStatement):D1PreparedStatement=>{
        const wrapped=new Proxy(statement,{get(inner,key){if(key==='bind')return (...values:unknown[])=>mark(inner.bind(...values));return Reflect.get(inner,key);}});
        startWrites.add(wrapped);return wrapped;
      };
      env.DB=new Proxy(db,{get(target,key){
        if(key==='prepare')return (sql:string)=>sql.startsWith('INSERT INTO training_sessions')?mark(db.prepare(sql)):db.prepare(sql);
        if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(pending&&statements.some(s=>startWrites.has(s))){pending=false;revoke();}return db.batch(statements);};
        return Reflect.get(target,key);
      }});
    }else seams.beforeGeneration=async()=>{revoke();};
    const result=operation==='start'?await post('/api/training/start',start):operation==='chat'?await post('/api/training/chat',{sessionId,message:'This generation loses source access.'}):await post(`/api/training/session/${sessionId}/support`,{});
    expect(result.status,await result.clone().text()).toBe(409);
    expect(await result.json()).toMatchObject({code:'TRAINING_SOURCE_UNAVAILABLE',retryable:false});
    if(operation==='start')for(const table of ['training_sessions','training_scenario_packs','training_scenario_evidence','training_session_contexts'])expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({count:0});
    else{
      expect(sqlite.prepare('SELECT current_turn,student_model,avg_score FROM training_sessions WHERE id=?').get(sessionId)).toEqual(before);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_turns WHERE session_id=?').get(sessionId)).toEqual({count:operation==='support'?1:0});
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_messages WHERE session_id=?').get(sessionId)).toEqual({count:operation==='support'?2:0});
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_support_responses WHERE session_id=?').get(sessionId)).toEqual({count:0});
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps owned private Training sources usable for answers and support',async()=>{
    const {sqlite,post,start}=await trainingHTTPFixture();
    sqlite.exec("UPDATE books SET is_builtin=0,visibility='private',owner_user_id='learner-a' WHERE id IN ('book-a','book-b')");
    const result=await post('/api/training/start',start);expect(result.status).toBe(200);
    const {sessionId}=await result.json() as {sessionId:string};
    expect((await post('/api/training/chat',{sessionId,message:'The private sources support this conditional claim.'})).status).toBe(200);
    expect((await post(`/api/training/session/${sessionId}/interventions`,{action:'HELP',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'owned-private-support'})).status).toBe(200);
    expect((await post(`/api/training/session/${sessionId}/support`,{})).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps an owned private Sparring source usable for chat and saved help',async()=>{
    const {sqlite,post}=await sparringHTTPFixture();
    sqlite.prepare("UPDATE books SET is_builtin=0,visibility='private',owner_user_id='learner-a' WHERE id='book-a'").run();
    const start=await post('/api/session/start',{bookId:'book-a'});
    expect(start.status).toBe(200);
    const {sessionId}=await start.json() as {sessionId:string};
    expect((await post('/api/chat',{sessionId,message:'A private source supports the conditional claim.'})).status).toBe(200);
    expect((await post('/api/hint',{sessionId,expectedTurn:2,mutationKey:'private-source-help'})).status).toBe(200);
    expect(sqlite.prepare('SELECT current_turn,hint_request_count FROM sessions WHERE id=?').get(sessionId)).toEqual({current_turn:2,hint_request_count:1});
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['quarantined','deleted','foreign-private','unknown'])('refuses new use of an inaccessible Sparring source: %s',async state=>{
    const {sqlite,post,app,env,headers}=await sparringHTTPFixture();
    const {sessionId}=await (await post('/api/session/start',{bookId:'book-a'})).json() as {sessionId:string};
    expect((await post('/api/chat',{sessionId,message:'The source supports a conditional claim.'})).status).toBe(200);
    const savedHint={sessionId,expectedTurn:2,mutationKey:'before-source-change'};
    expect((await post('/api/hint',savedHint)).status).toBe(200);
    const before=sqlite.prepare('SELECT current_turn,student_model,layer_state_json,hint_request_count FROM sessions WHERE id=?').get(sessionId);
    if(state==='quarantined')sqlite.prepare("UPDATE books SET visibility='quarantined' WHERE id='book-a'").run();
    if(state==='deleted')sqlite.prepare("UPDATE books SET lifecycle_status='deleted' WHERE id='book-a'").run();
    if(state==='unknown')sqlite.prepare("UPDATE books SET lifecycle_status='unconfirmed' WHERE id='book-a'").run();
    if(state==='foreign-private'){
      sqlite.exec("INSERT INTO users(id,username,email,password_hash) VALUES ('foreign-book-owner','foreign-book-owner','foreign@example.test','fixture')");
      sqlite.prepare("UPDATE books SET is_builtin=0,visibility='private',owner_user_id='foreign-book-owner' WHERE id='book-a'").run();
    }
    const calls=seams.requests.length;
    const chat=await post('/api/chat',{sessionId,message:'Do not generate from the revoked source.'});
    expect(chat.status,await chat.clone().text()).toBe(409);
    const hint=await post('/api/hint',{sessionId,expectedTurn:2,mutationKey:'after-source-change'});
    expect(hint.status,await hint.clone().text()).toBe(409);
    expect((await post('/api/session/start',{bookId:'book-a'})).status).toBe(404);
    expect((await post('/api/hint',savedHint)).status).toBe(200); // Saved response only, no new generation.
    expect(seams.requests).toHaveLength(calls);
    expect(sqlite.prepare('SELECT current_turn,student_model,layer_state_json,hint_request_count FROM sessions WHERE id=?').get(sessionId)).toEqual(before);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND role='user'").get(sessionId)).toEqual({count:1});
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_hint_responses WHERE session_id=?').get(sessionId)).toEqual({count:1});
    const history=await app.request(`/api/sessions/${sessionId}/report`,{headers},env);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({hintHistoryStatus:'RECORDED',hintResponses:[expect.objectContaining({responseStatus:'RESPONSE_COMMITTED'})]});
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['start','chat','hint'])('withholds pending Sparring %s when source quarantine wins generation',async operation=>{
    const {sqlite,post}=await sparringHTTPFixture();
    let sessionId='';
    if(operation!=='start'){
      sessionId=(await (await post('/api/session/start',{bookId:'book-a'})).json() as {sessionId:string}).sessionId;
      if(operation==='hint')expect((await post('/api/chat',{sessionId,message:'Evidence supports a conditional claim.'})).status).toBe(200);
    }
    const before=sessionId?sqlite.prepare('SELECT current_turn,student_model,hint_request_count FROM sessions WHERE id=?').get(sessionId):null;
    seams.beforeGeneration=async()=>{sqlite.prepare("UPDATE books SET visibility='quarantined' WHERE id='book-a'").run();};
    const response=operation==='start'?await post('/api/session/start',{bookId:'book-a'}):operation==='chat'?await post('/api/chat',{sessionId,message:'Quarantine happens during this generation.'}):await post('/api/hint',{sessionId,expectedTurn:2,mutationKey:'pending-source-hint'});
    expect(response.status,await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({code:'SPARRING_SOURCE_UNAVAILABLE',retryable:false});
    if(operation==='start'){
      for(const table of ['sessions','learning_session_contexts','sparring_evidence_manifests','sparring_turn_evidence','messages'])expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({count:0});
    }else{
      expect(sqlite.prepare('SELECT current_turn,student_model,hint_request_count FROM sessions WHERE id=?').get(sessionId)).toEqual(before);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_hint_responses WHERE session_id=?').get(sessionId)).toEqual({count:0});
      const accepted=operation==='hint'?1:0;
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND role='user'").get(sessionId)).toEqual({count:accepted});
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_evidence_manifests WHERE session_id=? AND turn_number>0').get(sessionId)).toEqual({count:accepted});
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts one concurrent Sparring answer even when its evidence manifest already exists',async()=>{
    const {sqlite,db,post}=await sparringHTTPFixture();
    const {sessionId}=await (await post('/api/session/start',{bookId:'book-a'})).json() as {sessionId:string};
    const message='The source supports a conditional policy claim.';
    const {retrieveLibraryChunks,persistSparringEvidence}=await import('../src/services/library-retrieval');
    const chunks=await retrieveLibraryChunks(db,'book-a',message,'learner-a');
    await persistSparringEvidence(db,{sessionId,turnNumber:1,userId:'learner-a',bookId:'book-a',query:message,chunks});
    // Historical pre-generation evidence is legitimate persisted input. Both
    // requests reuse it; only the canonical turn boundary can reject the loser.
    seams.beforeEvaluation=async()=>{expect((await post('/api/chat',{sessionId,message})).status).toBe(200);};
    const loser=await post('/api/chat',{sessionId,message});
    expect(loser.status,await loser.clone().text()).toBe(409);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND role='user' AND turn=1").get(sessionId)).toEqual({count:1});
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE session_id=?').get(sessionId)).toEqual({count:1});
    expect(sqlite.prepare('SELECT current_turn FROM sessions WHERE id=?').get(sessionId)).toEqual({current_turn:2});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('denies foreign control access and conflicting replay without changing the learner record',async()=>{
    const {sqlite,env,app,headers,post}=await sparringHTTPFixture();
    const {sessionId}=await (await post('/api/session/start',{bookId:'book-a'})).json() as {sessionId:string};
    const path=`/api/sessions/${sessionId}/controls`;
    const foreign=(await generateTokens({id:'learner-b',username:'learner-b',email:'b@example.test',studentId:null,grade:null,role:'student',createdAt:1,lastLogin:null,isActive:true},env.JWT_SECRET)).accessToken;
    const body={action:'PAUSE',reason:'DISTRESS',expectedRevision:0,mutationKey:'owned-control-key'};
    for(const method of ['GET','POST']){
      const init={method,headers:{...headers,Authorization:'Bearer '+foreign},...(method==='POST'?{body:JSON.stringify(body)}:{})};
      expect((await app.request(path,init,env)).status).toBe(404);
      expect((await app.request(path,{...init,headers:{'Content-Type':'application/json'}},env)).status).toBe(401);
    }
    expect((await post(path,{...body,ownerUserId:'learner-a'})).status).toBe(400);
    expect((await post(path,body)).status).toBe(200);
    expect((await post(path,{...body,reason:'TIME_LIMIT'})).status).toBe(409);
    expect(sqlite.prepare('SELECT revision,reason FROM sparring_controls').all()).toEqual([{revision:1,reason:'DISTRESS'}]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports a nonretryable missing context when governed erasure wins a control insert',async()=>{
    const {sqlite,db,env,app,headers,post}=await sparringHTTPFixture();
    const {sessionId}=await (await post('/api/session/start',{bookId:'book-a'})).json() as {sessionId:string};
    env.DB=new Proxy(db,{get(target,key){
      if(key!=='prepare')return Reflect.get(target,key);
      return (sql:string)=>{
        const statement=db.prepare(sql);
        if(!sql.startsWith('INSERT INTO sparring_controls'))return statement;
        const raced=new Proxy(statement,{get(inner,property){
          if(property==='bind')return (...values:unknown[])=>{inner.bind(...values);return raced;};
          if(property==='run')return async()=>{expect((await app.request(`/api/sessions/${sessionId}`,{method:'DELETE',headers},env)).status).toBe(200);return inner.run();};
          return Reflect.get(inner,property);
        }});
        return raced;
      };
    }});
    const response=await post(`/api/sessions/${sessionId}/controls`,{action:'STOP',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'erased-stop-key'});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({code:'SESSION_CONTEXT_REQUIRED',retryable:false});
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_controls').get()).toEqual({count:0});
    expect(sqlite.prepare('SELECT id FROM sessions WHERE id=?').get(sessionId)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['PAUSE','STOP','PAUSE_RESUME'])('rejects stale Sparring chat and evidence after %s wins generation',async action=>{
    const {sqlite,post}=await sparringHTTPFixture();
    const start=await post('/api/session/start',{bookId:'book-a'});
    expect(start.status).toBe(200);
    const {sessionId}=await start.json() as {sessionId:string};
    const before=sqlite.prepare('SELECT student_model,layer_state_json,current_turn,avg_logic,is_completed FROM sessions WHERE id=?').get(sessionId);
    const path=`/api/sessions/${sessionId}/controls`;
    seams.beforeGeneration=async()=>{
      expect((await post(path,{action:action==='STOP'?'STOP':'PAUSE',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'during-chat-control'})).status).toBe(200);
      if(action==='PAUSE_RESUME')expect((await post(path,{action:'RESUME',reason:'LEARNER_REQUEST',expectedRevision:1,mutationKey:'during-chat-resume'})).status).toBe(200);
    };
    const rejected=await post('/api/chat',{sessionId,message:'The first answer has a particular source query.'});
    expect(rejected.status,await rejected.clone().text()).toBe(409);
    expect(await rejected.json()).toMatchObject({code:'SPARRING_CONTROL_CONFLICT',retryable:false});
    expect(sqlite.prepare('SELECT student_model,layer_state_json,current_turn,avg_logic,is_completed FROM sessions WHERE id=?').get(sessionId)).toEqual(before);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND role='user'").get(sessionId)).toEqual({count:0});
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE session_id=?').get(sessionId)).toEqual({count:0});
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_evidence_manifests WHERE session_id=? AND turn_number>0').get(sessionId)).toEqual({count:0});
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_turn_evidence WHERE session_id=? AND turn_number>0').get(sessionId)).toEqual({count:0});
    if(action!=='STOP'){
      if(action==='PAUSE')expect((await post(path,{action:'RESUME',reason:'LEARNER_REQUEST',expectedRevision:1,mutationKey:'later-chat-resume'})).status).toBe(200);
      const retry=await post('/api/chat',{sessionId,message:'A different answer must use its own evidence query after resume.'});
      expect(retry.status,await retry.clone().text()).toBe(200);
      expect(sqlite.prepare('SELECT query_text FROM sparring_evidence_manifests WHERE session_id=? AND turn_number=1').get(sessionId)?.query_text).toBe('A different answer must use its own evidence query after resume.');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['PAUSE','STOP','PAUSE_RESUME'])('rejects pending Sparring help after %s changes controls',async action=>{
    const {sqlite,post}=await sparringHTTPFixture();
    const start=await post('/api/session/start',{bookId:'book-a'});
    expect(start.status).toBe(200);
    const {sessionId}=await start.json() as {sessionId:string};
    expect((await post('/api/chat',{sessionId,message:'A claim needs a source and a condition.'})).status).toBe(200);
    const path=`/api/sessions/${sessionId}/controls`;
    seams.beforeGeneration=async()=>{
      expect((await post(path,{action:action==='STOP'?'STOP':'PAUSE',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'during-hint-control'})).status).toBe(200);
      if(action==='PAUSE_RESUME')expect((await post(path,{action:'RESUME',reason:'LEARNER_REQUEST',expectedRevision:1,mutationKey:'during-hint-resume'})).status).toBe(200);
    };
    const request={sessionId,mutationKey:'pending-help-request',expectedTurn:2};
    const rejected=await post('/api/hint',request);
    expect(rejected.status,await rejected.clone().text()).toBe(409);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sparring_hint_responses').get()).toEqual({count:0});
    expect(sqlite.prepare('SELECT hint_request_count,current_turn FROM sessions WHERE id=?').get(sessionId)).toEqual({hint_request_count:0,current_turn:2});
    if(action==='PAUSE_RESUME')expect((await post('/api/hint',request)).status).toBe(200);
    else{
      const calls=seams.requests.length;
      expect((await post('/api/hint',request)).status).toBe(409);
      expect(seams.requests).toHaveLength(calls);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([false,true])('launches an owned Sparring follow-up and records the same bound attempt with evaluation=%s', async (withEvaluation) => {
    const { sqlite, env } = seed();
    env.GROWTH_CYCLE_HMAC_SECRET = 'offline-sparring-follow-up';
    const app = (await import('../src/index')).default;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const request = async (path: string, body?: object, key?: string, owner = 'learner-a') => {
      const token = (await generateTokens({ id: owner, username: owner, email: owner + '@example.test', studentId: null, grade: null, role: 'student', createdAt: 1, lastLogin: null, isActive: true }, env.JWT_SECRET)).accessToken;
      return app.request(path, { method: body || key ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
    };
    type Body = {sessionId:string;spaceId:string;cycleId:string;aggregateRevision:number;practiceQuestId:string;launchId:string;topic:string;openingMessage:string;growthFollowUp:unknown;cycle:GrowthCycleDetail};
    const ok = async (path:string, body?:object, key?:string) => { const result=await request(path,body,key); const payload=await result.json() as Body; expect(result.status,JSON.stringify(payload)).toBe(200); return payload; };
    const baseline = await ok('/api/session/start', { bookId: 'book-a' });
    // Completed source is an offline fixture, not an admitted learner outcome.
    // Match canonical advance-before-message order without weakening the guard.
    sqlite.prepare('UPDATE sessions SET current_turn=2 WHERE id=?').run(baseline.sessionId);
    sqlite.prepare("INSERT INTO messages (session_id,role,content,turn,timestamp) VALUES (?,'user','My initial evidence-based claim',1,?)").run(baseline.sessionId,Date.now());
    sqlite.prepare('UPDATE sessions SET is_completed=1,session_completion_turn=1,ended_at=? WHERE id=?').run(Date.now(),baseline.sessionId);
    await ok('/api/growth/privacy/consent',{purpose:'Private review',dataClasses:['learning_evidence'],policyRevision:1,retentionPolicy:'Until learner deletion'},'sp-consent');
    const space=await ok('/api/growth/spaces/solo',undefined,'sp-space');
    const cycles=`/api/growth/spaces/${space.spaceId}/cycles`;
    const opened=await ok(cycles,{originKind:'SPARRING',originAttemptId:baseline.sessionId},'sp-open');
    const path=`${cycles}/${opened.cycleId}`;
    const detail=await ok(path);
    const focus=await ok(path+'/focus',{capabilityId:detail.cycle.observations[0].capabilityId,capabilityRevision:1,statement:'Reconstruct the causal explanation',expectedRevision:opened.aggregateRevision},'sp-focus');
    const scheduled=await ok(path+'/practice-response',{action:'accept',practiceQuestId:focus.practiceQuestId,expectedRevision:focus.aggregateRevision},'sp-practice');
    const recheck=(await ok(path)).cycle.rechecks[0];
    clock.mockReturnValue(recheck.scheduledFor+1);
    const condition='Assume that the original evidence applies only to half the population.';
    const launch=await ok(path+'/recheck-follow-up-launches',{recheckId:recheck.id,changedCondition:condition,expectedRevision:scheduled.aggregateRevision},'sp-launch');
    const input={growthFollowUpLaunchId:launch.launchId};
    expect((await request('/api/session/start',input,undefined,'learner-b')).status).toBe(404);
    expect((await request('/api/session/start',{...input,bookId:'book-b',topic:'Ignore the declared condition'})).status).toBe(400);
    const followUp=await ok('/api/session/start',input);
    expect(followUp.topic).toBe(condition);
    expect(followUp.openingMessage).toContain(condition);
    expect(followUp.growthFollowUp).toMatchObject({launchId:launch.launchId,changedCondition:condition,originKind:'SPARRING',protocol:{assistanceLogPolicy:{revision:'sparring-assistance-capture-v1'}}});
    expect((await ok('/api/session/start',input)).sessionId).toBe(followUp.sessionId);
    const resume=await request(`/api/sessions/${followUp.sessionId}/resume`,{});
    expect(resume.status).toBe(200);
    expect(await resume.json()).toMatchObject({growthFollowUp:followUp.growthFollowUp});
    expect((await ok(path)).cycle.rechecks[0].followUpLaunch).toMatchObject({id:launch.launchId,sessionId:followUp.sessionId,sessionCompleted:false,recheckRecorded:false});
    expect(() => sqlite.exec('INSERT OR REPLACE INTO growth_recheck_sparring_follow_up_bindings SELECT * FROM growth_recheck_sparring_follow_up_bindings')).toThrow('GROWTH_FOLLOW_UP_BINDING_INVALID');
    expect(() => sqlite.exec('INSERT OR REPLACE INTO growth_recheck_sparring_follow_up_launches SELECT * FROM growth_recheck_sparring_follow_up_launches')).toThrow('GROWTH_FOLLOW_UP_LAUNCH_INVALID');
    const record={action:'record',recheckId:recheck.id,followUpLaunchId:launch.launchId,expectedRevision:launch.aggregateRevision};
    expect((await request(path+'/rechecks',record,'sp-record-early')).status).toBe(422);
    expect((await request(path+'/rechecks',{action:'reschedule',recheckId:recheck.id,revisitAt:Date.now()+10000,expectedRevision:launch.aggregateRevision},'sp-reschedule')).status).toBe(409);
    sqlite.prepare('UPDATE sessions SET current_turn=2 WHERE id=?').run(followUp.sessionId);
    sqlite.prepare("INSERT INTO messages (session_id,role,content,turn,timestamp) VALUES (?,'user','Private revised claim',1,?)").run(followUp.sessionId,Date.now());
    sqlite.prepare('UPDATE sessions SET is_completed=1,session_completion_turn=1,ended_at=?,hint_request_count=2 WHERE id=?').run(Date.now(),followUp.sessionId);
    expect((await request('/api/session/start',input)).status).toBe(409);
    expect((await ok(path)).cycle.rechecks[0].followUpLaunch).toMatchObject({sessionCompleted:true,recheckRecorded:false});
    for (const completionTurn of [null, 2]) {
      sqlite.prepare('UPDATE sessions SET session_completion_turn=? WHERE id=?').run(completionTurn,followUp.sessionId);
      expect((await request(path+'/rechecks',record,'sp-invalid-completion-'+completionTurn)).status).toBe(422);
    }
    sqlite.prepare('UPDATE sessions SET session_completion_turn=1 WHERE id=?').run(followUp.sessionId);
    // Simulate historical residue using explicit fixture-only turn drift; the
    // Growth read must still reject the same invalid completion evidence.
    sqlite.prepare('UPDATE sessions SET current_turn=3 WHERE id=?').run(followUp.sessionId);
    const extra=sqlite.prepare("INSERT INTO messages (session_id,role,content,turn,timestamp) VALUES (?,'user','Post-completion residue',2,?)").run(followUp.sessionId,Date.now());
    expect((await request(path+'/rechecks',record,'sp-post-completion-message')).status).toBe(422);
    sqlite.prepare('DELETE FROM messages WHERE id=?').run(extra.lastInsertRowid);
    sqlite.prepare('UPDATE sessions SET current_turn=2 WHERE id=?').run(followUp.sessionId);
    sqlite.exec("INSERT INTO users (id,username,email,password_hash) VALUES ('unrelated-evaluator','unrelated-evaluator','unrelated@example.test','fixture')");
    sqlite.prepare("INSERT INTO evaluations (session_id,user_id,turn) VALUES (?,'unrelated-evaluator',99)").run(followUp.sessionId);
    let expectedEvaluation: number|null = null;
    if (withEvaluation) {
      expectedEvaluation=Number(sqlite.prepare("INSERT INTO evaluations (session_id,user_id,turn,created_at) VALUES (?,'learner-a',1,?)").run(followUp.sessionId,Date.now()).lastInsertRowid);
      // Higher ID alone must not override the most recent evaluation timestamp.
      sqlite.prepare("INSERT INTO evaluations (session_id,user_id,turn,created_at) VALUES (?,'learner-a',1,?)").run(followUp.sessionId,Date.now()-1000);
    }
    sqlite.exec('CREATE TRIGGER fixture_completion_drift BEFORE UPDATE OF recorded_at ON growth_rechecks WHEN NEW.recorded_at IS NOT NULL BEGIN UPDATE sessions SET session_completion_turn=2 WHERE id=NEW.follow_up_attempt_id; END');
    expect((await request(path+'/rechecks',record,'sp-completion-drift')).status).toBe(409);
    expect(sqlite.prepare('SELECT completed_message_id FROM growth_recheck_sparring_follow_up_bindings').get()).toEqual({completed_message_id:null});
    expect(sqlite.prepare('SELECT session_completion_turn FROM sessions WHERE id=?').get(followUp.sessionId)).toEqual({session_completion_turn:1});
    sqlite.exec('DROP TRIGGER fixture_completion_drift');
    const recorded=await ok(path+'/rechecks',record,'sp-record');
    const completed=(await ok(path)).cycle.rechecks[0];
    expect(completed.followUpLaunch).toMatchObject({sessionCompleted:true,recheckRecorded:true});
    expect(completed).toMatchObject({outcome:'UNKNOWN',followUpOriginKind:'SPARRING',followUpAttemptId:followUp.sessionId,assistance:{status:'RECORDED',kind:'SPARRING_RECORDS_V2',followUp:{acceptedTurns:1,evaluatedTurns:withEvaluation?1:0,hintRequests:2,deliveredHints:'NOT_RECORDED',controls:'INDEXED_SOURCE_RECORDS',detail:{status:'AVAILABLE'}}}});
    expect(sqlite.prepare('SELECT completed_message_id,completed_evaluation_id FROM growth_recheck_sparring_follow_up_bindings').get()).toMatchObject({completed_message_id:expect.any(Number),completed_evaluation_id:expectedEvaluation});
    const observation=sqlite.prepare('SELECT raw_signal_json FROM growth_capability_observations WHERE id=?').get(completed.recheckObservationId!)!;
    const signal=JSON.parse(String(observation.raw_signal_json));
    const capture=signal.storedSourcePayload.assistance;
    expect(capture.logSha256).toBe(createHash('sha256').update(capture.logJson).digest('hex'));
    expect(JSON.parse(capture.logJson).followUp).toMatchObject({acceptedTurns:1,evaluatedTurns:withEvaluation?1:0,hintRequests:2,deliveredHints:'NOT_RECORDED',controls:'NOT_RECORDED'});
    expect(capture.logJson).not.toContain('Private revised claim');
    expect(() => sqlite.exec('UPDATE growth_recheck_sparring_follow_up_bindings SET completed_message_id=completed_message_id')).toThrow('GROWTH_FOLLOW_UP_COMPLETION_INVALID');
    const security={hmacSha256:async(purpose:string,bytes:Uint8Array)=>createHmac('sha256',env.GROWTH_CYCLE_HMAC_SECRET!).update(purpose).update(bytes).digest('hex')};
    clock.mockRestore(); // Deletion receipts use SQLite wall time.
    await deleteGrowthCycle(env.DB,security,'learner-a',space.spaceId,opened.cycleId,'sp-delete',recorded.aggregateRevision);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM growth_recheck_sparring_follow_up_launches').get()).toEqual({count:0});
    expect((await ok(`/api/sessions/${followUp.sessionId}`)).growthFollowUp).toBeNull();
    expect(sqlite.prepare('SELECT id FROM sessions WHERE id=?').get(followUp.sessionId)).toBeDefined();
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it.each(['opening', 'learning-state', 'ignored-opening', 'ignored-state'])('refuses an incomplete Sparring start when saving %s fails, then permits a recoverable retry', async (failure) => {
    const { sqlite, env } = seed();
    const app = (await import('../src/index')).default;
    const token = (await generateTokens({ id: 'learner-a', username: 'learner-a', email: 'a@example.test', studentId: null, grade: null, role: 'student', createdAt: 1, lastLogin: null, isActive: true }, env.JWT_SECRET)).accessToken;
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const start = () => app.request('/api/session/start', { method: 'POST', headers, body: JSON.stringify({ bookId: 'book-a', startMode: 'initial_claim' }) }, env);
    const baseline = await start();
    expect(baseline.status).toBe(200);
    const saved = await baseline.json() as { sessionId: string; openingMessage: string };
    const before = sqlite.prepare('SELECT * FROM sessions').all();
    const write = failure.includes('opening') ? "INSERT ON messages WHEN NEW.role='ai' AND NEW.turn=0" : 'UPDATE OF student_model ON sessions';
    const refusal = failure.startsWith('ignored') ? 'RAISE(IGNORE)' : "RAISE(ABORT, 'fixture start failure')";
    sqlite.exec(`CREATE TRIGGER fixture_start_failure BEFORE ${write} BEGIN SELECT ${refusal}; END`);
    const rejected = await start();
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ code: 'SESSION_START_PERSISTENCE_REQUIRED', retryable: true, assessmentState: 'UNGRADABLE' });
    expect(sqlite.prepare('SELECT * FROM sessions').all()).toEqual(before);
    for (const table of ['messages', 'learning_session_contexts', 'sparring_evidence_manifests', 'sparring_turn_evidence']) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id <> ?`).get(saved.sessionId)).toEqual({ count: 0 });
    }
    sqlite.exec('DROP TRIGGER fixture_start_failure');
    const retry = await start();
    expect(retry.status).toBe(200);
    const opened = await retry.json() as { sessionId: string; openingMessage: string };
    const state = sqlite.prepare('SELECT tutor_state, student_model, layer_state_json FROM sessions WHERE id=?').get(opened.sessionId)!;
    expect(state.tutor_state).toBe('elicitation');
    expect(JSON.parse(String(state.student_model))).toMatchObject({ sessionId: opened.sessionId });
    expect(JSON.parse(String(state.layer_state_json))).toBeTypeOf('object');
    for (const session of [saved, opened]) {
      const resume = await app.request(`/api/sessions/${session.sessionId}/resume`, { method: 'POST', headers }, env);
      expect(resume.status).toBe(200);
      expect(await resume.json()).toMatchObject({ success: true, session: { conversationHistory: [{ role: 'ai', content: session.openingMessage, turn: 0 }] } });
    }
  });
  it('withholds retry when Sparring cleanup fails and rolls back initial state with its failed opening', async () => {
    const { sqlite, env } = seed();
    const app = (await import('../src/index')).default;
    let initialState: unknown;
    seams.beforeGeneration = async () => { initialState = sqlite.prepare('SELECT student_model, layer_state_json FROM sessions').get(); };
    const token = (await generateTokens({ id: 'learner-a', username: 'learner-a', email: 'a@example.test', studentId: null, grade: null, role: 'student', createdAt: 1, lastLogin: null, isActive: true }, env.JWT_SECRET)).accessToken;
    sqlite.exec("CREATE TRIGGER fixture_opening_failure BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture opening failure'); END; CREATE TRIGGER fixture_cleanup_failure BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture cleanup failure'); END;");
    const response = await app.request('/api/session/start', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId: 'book-a' }) }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'SESSION_START_PERSISTENCE_REQUIRED', retryable: false, cleanupState: 'UNVERIFIED', assessmentState: 'UNGRADABLE' });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    const state = sqlite.prepare('SELECT student_model, layer_state_json FROM sessions').get()!;
    expect(initialState).toBeDefined();
    expect(state).toEqual(initialState);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM learning_session_contexts').get()).toEqual({ count: 1 });
  });
  it('opens owned history and permits pause/stop when an evidence snapshot is missing, without enabling generation', async () => {
    const {sqlite,env,category}=seed();
    sqlite.prepare("INSERT INTO training_sessions (id,user_id,category,difficulty,question,training_mode) VALUES ('missing-grounding','learner-a',?,'intermediate','Saved question','scenario')").run(category);
    const sessionBefore=sqlite.prepare("SELECT * FROM training_sessions WHERE id='missing-grounding'").get();
    const token=async(id:string)=>(await generateTokens({id,username:id,email:id+'@example.test',studentId:null,grade:null,role:'student',createdAt:1,lastLogin:null,isActive:true},env.JWT_SECRET)).accessToken;
    const headers={Authorization:'Bearer '+await token('learner-a'),'Content-Type':'application/json'};
    const path='/api/training/session/missing-grounding';
    for(const [url,method] of [[path,'GET'],[path+'/resume','POST']]) {
      const response=await trainingRoute.request(url,{method,headers},env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({session:{id:'missing-grounding'},grounding:{status:'unavailable',reason:'missing_evidence_pack'}});
      const foreign=await trainingRoute.request(url,{method,headers:{Authorization:'Bearer '+await token('other')}},env);
      expect([403,404]).toContain(foreign.status);
      expect(await foreign.text()).not.toContain('Saved question');
      expect((await trainingRoute.request(url,{method},env)).status).toBe(401);
    }
    for(const [url,method] of [['/api/sessions/missing-grounding','GET'],['/api/sessions/missing-grounding/resume','POST']]) {
      const response=await historyRoute.request(url,{method,headers},env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({grounding:{status:'unavailable',reason:'missing_evidence_pack'}});
      expect((await historyRoute.request(url,{method,headers:{Authorization:'Bearer '+await token('other')}},env)).status).toBe(403);
      expect((await historyRoute.request(url,{method},env)).status).toBe(401);
    }
    expect(sqlite.prepare("SELECT * FROM training_sessions WHERE id='missing-grounding'").get()).toEqual(sessionBefore);
    const callsBefore=seams.requests.length;
    const blocked=await trainingRoute.request('/api/training/chat',{method:'POST',headers,body:JSON.stringify({sessionId:'missing-grounding',message:'My answer'})},env,{waitUntil:()=>undefined,passThroughOnException:()=>undefined,props:{}});
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({error:'scenario_grounding_broken'});
    for(const [revision,action] of ['PAUSE','RESUME','STOP'].entries()) {
      const response=await trainingRoute.request(path+'/interventions',{method:'POST',headers,body:JSON.stringify({action,reason:'INSUFFICIENT_EVIDENCE',expectedRevision:revision,mutationKey:'missing-'+action})},env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({state:action==='PAUSE'?'PAUSED':action==='STOP'?'STOPPED':'ACTIVE'});
    }
    expect(seams.requests).toHaveLength(callsBefore);
    expect(sqlite.prepare("SELECT * FROM training_sessions WHERE id='missing-grounding'").get()).toEqual(sessionBefore);
  });

  it('retains failed support requests and withholds generated support when a pause supersedes it',async()=>{
    const {sqlite,db,env,category}=seed();
    await startTrainingSession(env,'learner-a',{category,difficulty:'intermediate',mode:'evidence',evidenceQuery:'policy evidence',evidenceBookIds:['book-a','book-b']},{sessionId:'support-race'});
    await respondTrainingSession(env,'learner-a','support-race','My prior claim');
    await requestTrainingIntervention(db,'learner-a','support-race',{action:'HELP',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'help-race'});
    seams.beforeGeneration=async()=>{throw new Error('Offline support provider failed');};
    await expect(provideTrainingSupport(env,'learner-a','support-race')).rejects.toThrow();
    expect((await loadTrainingInterventions(db,'learner-a','support-race')).state).toBe('SUPPORT_PENDING');
    seams.beforeGeneration=async()=>{await requestTrainingIntervention(db,'learner-a','support-race',{action:'PAUSE',reason:'UNSAFE_ERROR',expectedRevision:1,mutationKey:'pause-support'});};
    await expect(provideTrainingSupport(env,'learner-a','support-race')).rejects.toThrow('TRAINING_INTERVENTION_CONFLICT');
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM training_support_responses WHERE session_id='support-race'").get()).toEqual({count:0});
    const token=async(id:string)=>(await generateTokens({id,username:id,email:id+'@example.test',studentId:null,grade:null,role:'student',createdAt:1,lastLogin:null,isActive:true},env.JWT_SECRET)).accessToken;
    const path='/api/training/session/support-race/interventions';
    expect((await trainingRoute.request(path,{},env)).status).toBe(401);
    expect((await trainingRoute.request(path,{headers:{Authorization:'Bearer '+await token('other')}},env)).status).toBe(404);
    const headers={Authorization:'Bearer '+await token('learner-a'),'Content-Type':'application/json'};
    sqlite.prepare("INSERT INTO training_sessions (id,user_id,category,difficulty,question,training_mode) VALUES ('constructed-paused','learner-a',?,'intermediate','A fictional decision','discussion')").run(category);
    await requestTrainingIntervention(db,'learner-a','constructed-paused',{action:'PAUSE',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'pause-constructed'});
    const callsBeforeHint=seams.requests.length;
    const blockedHint=await trainingRoute.request('/api/training/hint',{method:'POST',headers,body:JSON.stringify({sessionId:'constructed-paused'})},env);
    expect(blockedHint.status).toBe(409);
    expect(await blockedHint.json()).toMatchObject({code:'TRAINING_PAUSED'});
    expect(seams.requests).toHaveLength(callsBeforeHint);
    expect((await trainingRoute.request(path,{method:'POST',headers,body:JSON.stringify({action:'RESUME',reason:'LEARNER_REQUEST',expectedRevision:2,mutationKey:'http-resume',origin:'POLICY'})},env)).status).toBe(400);
    expect((await trainingRoute.request(path,{method:'POST',headers,body:JSON.stringify({action:'RESUME',reason:'LEARNER_REQUEST',expectedRevision:2,mutationKey:'http-resume'})},env)).status).toBe(200);
    await requestTrainingIntervention(db,'learner-a','support-race',{action:'HELP',reason:'LEARNER_REQUEST',expectedRevision:3,mutationKey:'help-after-pause'});
    expect((await trainingRoute.request('/api/training/session/support-race/support',{method:'POST',headers,body:'{}'},env)).status).toBe(200);
    expect(() => sqlite.exec("UPDATE training_turns SET diagnosis='rewrite' WHERE session_id='support-race'")).toThrow('TRAINING_INTERVENTION_IMMUTABLE');
    expect(() => sqlite.exec("INSERT OR REPLACE INTO training_support_responses SELECT * FROM training_support_responses WHERE session_id='support-race'")).toThrow('TRAINING_INTERVENTION_CONFLICT');
    const context=sqlite.prepare("SELECT id FROM training_session_contexts WHERE session_id='support-race'").get()!;
    sqlite.prepare('INSERT INTO training_session_context_deletion_authorizations (session_context_id,authorization_id,created_at) VALUES (?,?,?)').run(context.id!,'offline-only',Date.now());
    sqlite.exec("BEGIN; DELETE FROM training_support_responses WHERE session_id='support-race'; DELETE FROM training_interventions WHERE session_id='support-race'; DELETE FROM training_turns WHERE session_id='support-race'; COMMIT;");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM training_interventions WHERE session_id='support-race'").get()).toEqual({count:0});
  });
  it('provides source-grounded explanation after diagnosis without scoring help as a learner turn', async () => {
    const { sqlite, db, env, category }=seed();
    await startTrainingSession(env,'learner-a',{category,difficulty:'intermediate',mode:'evidence',evidenceQuery:'policy evidence',evidenceBookIds:['book-a','book-b']},{sessionId:'support-a'});
    await expect(requestTrainingIntervention(db,'learner-a','support-a',{action:'HELP',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'too-early-help'})).rejects.toMatchObject({code:'TRAINING_SUPPORT_DIAGNOSIS_REQUIRED'});
    await respondTrainingSession(env,'learner-a','support-a','정책을 적용해야 한다고 생각합니다.');
    const before=sqlite.prepare("SELECT * FROM training_sessions WHERE id='support-a'").get();
    const bkt=sqlite.prepare('SELECT * FROM bkt_knowledge_states').all();
    const request={action:'HELP',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'help-first'};
    await expect(requestTrainingIntervention(db,'learner-b','support-a',request)).rejects.toMatchObject({status:404});
    const [control,replay]=await Promise.all([requestTrainingIntervention(db,'learner-a','support-a',request),requestTrainingIntervention(db,'learner-a','support-a',request)]);
    expect(control.latest?.id).toBe(replay.latest?.id);
    expect(control.state).toBe('SUPPORT_PENDING');
    await expect(respondTrainingSession(env,'learner-a','support-a','Help')).rejects.toMatchObject({code:'TRAINING_SUPPORT_PENDING'});
    seams.requests=[];
    const response=await provideTrainingSupport(env,'learner-a','support-a');
    expect(response.graded).toBe(false);
    expect(response.response).toContain('[SOURCE_ID=library:book-a:chunk-a1]');
    expect(seams.requests.map(r=>r.lane)).toEqual(['interactive_generation','release_critic']);
    expect(seams.requests[0].request.systemPrompt).toContain('Explain or explicitly correct ONE causal reasoning step');
    expect(seams.requests[1].request.systemPrompt).not.toContain('직접/간접적으로 노출하면 REJECT');
    expect(sqlite.prepare("SELECT * FROM training_sessions WHERE id='support-a'").get()).toEqual(before);
    expect(sqlite.prepare('SELECT * FROM bkt_knowledge_states').all()).toEqual(bkt);
    expect((await loadTrainingInterventions(db,'learner-a','support-a')).state).toBe('ACTIVE');
    expect(await provideTrainingSupport(env,'learner-a','support-a')).toEqual(response);
    expect(seams.requests).toHaveLength(2);
  });
  it('keeps controls and committed support inspectable when a malformed revision projection is unavailable', async () => {
    const { app, db, env, headers, post, start, sqlite } = await trainingHTTPFixture();
    const started = await post('/api/training/start', start);
    expect(started.status).toBe(200);
    const { sessionId } = await started.json() as { sessionId: string };
    expect((await post('/api/training/chat', { sessionId, message: 'The first claim has a stated source boundary.' })).status).toBe(200);
    const prior = sqlite.prepare('SELECT id FROM training_turns WHERE session_id=?').get(sessionId) as { id: number };
    expect((await post(`/api/training/session/${sessionId}/interventions`, { action: 'HELP', reason: 'LEARNER_REQUEST', expectedRevision: 0, mutationKey: 'malformed-revision-help' })).status).toBe(200);
    expect((await post(`/api/training/session/${sessionId}/support`)).status).toBe(200);
    expect((await post(`/api/training/session/${sessionId}/revisions`, {
      priorTurnId: prior.id,
      revisedStatement: 'The revised claim needs an explicit boundary.',
      explanation: 'The source limits the conclusion.',
      sourceIds: ['library:book-a:chunk-a1'],
      expectedRevision: 0,
      mutationKey: 'malformed-revision-event',
    })).status).toBe(200);
    await expect(readOwnedTrainingHistorySupplements(db, 'learner-b', sessionId)).rejects.toMatchObject({ status: 404, code: 'TRAINING_HISTORY_NOT_FOUND' });
    await expect(readOwnedTrainingHistorySupplements(db, 'learner-a', 'missing-training-session')).rejects.toMatchObject({ status: 404, code: 'TRAINING_HISTORY_NOT_FOUND' });

    sqlite.exec('DROP TRIGGER IF EXISTS training_revision_immutable; PRAGMA ignore_check_constraints = ON;');
    try {
      sqlite.prepare('UPDATE training_learner_revision_events SET source_ids_json=? WHERE session_id=?').run('{not-valid-json', sessionId);
      const detail = await app.request(`/api/training/session/${sessionId}`, { headers }, env);
      expect(detail.status).toBe(200);
      const payload = await detail.json() as { trainingHistory: { revisions: { status: string; records: unknown[]; explicitDefenseStatus: string } } };
      expect(payload).toMatchObject({
        trainingHistory: {
          status: 'UNAVAILABLE',
          controls: { status: 'AVAILABLE', records: [expect.objectContaining({ action: 'HELP' })] },
          support: { status: 'AVAILABLE', records: [expect.objectContaining({ graded: false, response: expect.any(String) })] },
          revisions: { status: 'UNAVAILABLE', records: [], explicitDefenseStatus: 'UNAVAILABLE' },
        },
      });
      expect(JSON.stringify(payload.trainingHistory.revisions)).not.toContain('NOT_RECORDED');
    } finally {
      sqlite.exec('PRAGMA ignore_check_constraints = OFF;');
    }
  });
  it('leaves a support request pending when its response persistence fails after provider success', async () => {
    const { app, db, env, headers, post, start, sqlite } = await trainingHTTPFixture();
    const started = await post('/api/training/start', start);
    expect(started.status).toBe(200);
    const { sessionId } = await started.json() as { sessionId: string };
    expect((await post('/api/training/chat', { sessionId, message: 'The claim needs a source-grounded explanation.' })).status).toBe(200);
    expect((await post(`/api/training/session/${sessionId}/interventions`, { action: 'HELP', reason: 'LEARNER_REQUEST', expectedRevision: 0, mutationKey: 'support-persistence-failure' })).status).toBe(200);

    const readyDB = env.DB;
    env.DB = new Proxy(readyDB, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes('INSERT INTO training_support_responses')) return statement;
          const failedStatement = new Proxy(statement, {
            get(inner, member, innerReceiver) {
              if (member === 'bind') return (...values: unknown[]) => { inner.bind(...values); return failedStatement; };
              if (member === 'run') return async () => { throw new Error('TRAINING_SUPPORT_PERSISTENCE_TEST_FAILURE'); };
              return Reflect.get(inner, member, innerReceiver);
            },
          });
          return failedStatement;
        };
      },
    });
    seams.requests = [];
    try {
      await expect(provideTrainingSupport(env, 'learner-a', sessionId)).rejects.toThrow('TRAINING_SUPPORT_PERSISTENCE_TEST_FAILURE');
    } finally {
      env.DB = readyDB;
    }
    expect(seams.requests.map(request => request.lane)).toEqual(['interactive_generation', 'release_critic']);
    expect((await loadTrainingInterventions(db, 'learner-a', sessionId)).state).toBe('SUPPORT_PENDING');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM training_support_responses WHERE session_id=?').get(sessionId)).toEqual({ count: 0 });
    const detail = await app.request(`/api/training/session/${sessionId}`, { headers }, env);
    expect(detail.status).toBe(200);
    const payload = await detail.json() as { trainingHistory: { support: { status: string; records: unknown[] } } };
    expect(payload.trainingHistory.support).toEqual({ status: 'PENDING', records: [] });
    expect(JSON.stringify(payload.trainingHistory.support)).not.toContain('[SOURCE_ID=');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('projects owner-scoped Training support, revisions, and controls through every history readback', async () => {
    const { app, category, db, env, headers, post, sqlite, start } = await trainingHTTPFixture();
    const startedResponse = await post('/api/training/start', start);
    expect(startedResponse.status).toBe(200);
    const { sessionId } = await startedResponse.json() as { sessionId: string };

    expect((await post('/api/training/chat', { sessionId, message: 'The policy applies when the cited condition holds.' })).status).toBe(200);
    const prior = sqlite.prepare('SELECT id, turn_number FROM training_turns WHERE session_id=?').get(sessionId) as { id: number; turn_number: number };
    expect((await post(`/api/training/session/${sessionId}/interventions`, { action: 'HELP', reason: 'LEARNER_REQUEST', expectedRevision: 0, mutationKey: 'history-help-first' })).status).toBe(200);

    const pendingDetail = await app.request(`/api/training/session/${sessionId}`, { headers }, env);
    expect(pendingDetail.status).toBe(200);
    expect(await pendingDetail.json()).toMatchObject({
      trainingHistory: { status: 'AVAILABLE', support: { status: 'PENDING', records: [] } },
    });

    const support = await post(`/api/training/session/${sessionId}/support`);
    expect(support.status).toBe(200);
    expect((await support.json() as { graded: boolean }).graded).toBe(false);
    expect((await post(`/api/training/session/${sessionId}/revisions`, {
      priorTurnId: prior.id,
      revisedStatement: 'The policy claim needs the cited condition and a stated boundary.',
      explanation: 'The saved source limits the causal conclusion.',
      sourceIds: ['library:book-a:chunk-a1'],
      expectedRevision: 0,
      mutationKey: 'history-revision-first',
    })).status).toBe(200);
    expect((await post('/api/training/chat', { sessionId, message: 'I will compare the earlier claim with the source boundary.' })).status).toBe(200);
    expect((await post(`/api/training/session/${sessionId}/interventions`, { action: 'PAUSE', reason: 'DISTRESS', expectedRevision: 1, mutationKey: 'history-pause-first' })).status).toBe(200);
    expect((await post(`/api/training/session/${sessionId}/interventions`, { action: 'RESUME', reason: 'LEARNER_REQUEST', expectedRevision: 2, mutationKey: 'history-resume-first' })).status).toBe(200);
    expect((await post(`/api/training/session/${sessionId}/interventions`, { action: 'STOP', reason: 'TIME_LIMIT', expectedRevision: 3, mutationKey: 'history-stop-first' })).status).toBe(200);

    sqlite.prepare("UPDATE books SET lifecycle_status='quarantined' WHERE id='book-a'").run();
    const reads = [
      await app.request(`/api/training/session/${sessionId}`, { headers }, env),
      await post(`/api/training/session/${sessionId}/resume`),
      await app.request(`/api/sessions/${sessionId}`, { headers }, env),
      await post(`/api/sessions/${sessionId}/resume`),
    ];
    const payloads = [] as Array<{ trainingHistory?: Record<string, unknown> }>;
    for (const response of reads) {
      expect(response.status).toBe(200);
      payloads.push(await response.json() as { trainingHistory?: Record<string, unknown> });
    }
    for (const payload of payloads) {
      expect(payload.trainingHistory).toMatchObject({
        status: 'AVAILABLE',
        controls: {
          status: 'AVAILABLE',
          records: [
            { action: 'HELP', reason: 'LEARNER_REQUEST', origin: 'LEARNER', revision: 1, timestamp: expect.any(Number) },
            { action: 'PAUSE', reason: 'DISTRESS', origin: 'LEARNER', revision: 2, timestamp: expect.any(Number) },
            { action: 'RESUME', reason: 'LEARNER_REQUEST', origin: 'LEARNER', revision: 3, timestamp: expect.any(Number) },
            { action: 'STOP', reason: 'TIME_LIMIT', origin: 'LEARNER', revision: 4, timestamp: expect.any(Number) },
          ],
        },
        support: {
          status: 'AVAILABLE',
          records: [{
            interventionId: expect.any(String),
            priorTurn: { id: prior.id, turnNumber: prior.turn_number },
            answerTurn: { turnNumber: 2 },
            graded: false,
            deliveryValidation: 'UNKNOWN',
            readingValidation: 'UNKNOWN',
            sourceIds: ['library:book-a:chunk-a1'],
            sourceSnapshots: [expect.objectContaining({ sourceId: 'library:book-a:chunk-a1', excerpt: 'policy evidence alpha', contentSha256: expect.any(String) })],
          }],
        },
        revisions: {
          status: 'AVAILABLE',
          explicitDefenseStatus: 'NOT_RECORDED',
          records: [{
            priorTurn: { id: prior.id, turnNumber: prior.turn_number },
            revisedStatement: 'The policy claim needs the cited condition and a stated boundary.',
            validationStatus: 'UNVERIFIED',
            consumedFollowUpTurn: { turnNumber: 2 },
          }],
        },
      });
    }
    const storedSupport = ((payloads[0].trainingHistory as { support: { records: unknown[] } }).support.records);
    expect(storedSupport).toHaveLength(1);
    expect(JSON.stringify(payloads)).not.toContain('learning success');

    sqlite.exec("INSERT INTO users (id, username, email, password_hash) VALUES ('learner-b', 'learner-b', 'b@example.test', 'fixture-only')");
    const foreignToken = (await generateTokens({ id: 'learner-b', username: 'learner-b', email: 'b@example.test', studentId: null, grade: null, role: 'student', createdAt: 1, lastLogin: null, isActive: true }, env.JWT_SECRET)).accessToken;
    const foreignHeaders = { Authorization: `Bearer ${foreignToken}` };
    for (const path of [`/api/training/session/${sessionId}`, `/api/sessions/${sessionId}`]) {
      expect((await app.request(path, { headers: foreignHeaders }, env)).status).toBe(403);
    }
    expect(await db.prepare('SELECT COUNT(*) AS count FROM training_learner_revision_events WHERE session_id=?').bind(sessionId).first<{ count: number }>()).toEqual({ count: 1 });
  });
  it('keeps case-bound common history detail and resume fail closed for a broken snapshot', async () => {
    const { app, category, env, headers, post, sqlite } = await trainingHTTPFixture();
    seedHaneulHarborSources(sqlite);
    const started = await startTrainingSession(env, 'learner-a', {
      category,
      difficulty: 'intermediate',
      mode: 'evidence',
      caseId: 'HH-INVEST-100B',
      evidenceQuery: 'seasonality safety demand',
      evidenceBookIds: ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'SYNTHETIC-HH-OPERATIONS-EXAMPLE'],
    });
    sqlite.exec(`
      DROP TRIGGER IF EXISTS training_scenario_packs_bound_immutable_update;
      DROP TRIGGER IF EXISTS training_scenario_packs_case_contract_immutable;
      DROP TRIGGER IF EXISTS training_scenario_evidence_bound_immutable_update;
    `);
    sqlite.prepare('UPDATE training_scenario_packs SET scenario_json=? WHERE session_id=?').run('{}', started.sessionId);
    const detail = await app.request(`/api/sessions/${started.sessionId}`, { headers }, env);
    const resume = await post(`/api/sessions/${started.sessionId}/resume`);
    for (const response of [detail, resume]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'TRAINING_CASE_SNAPSHOT_INVALID', assessmentState: 'UNGRADABLE' });
    }
  });
  it('rejects an in-flight answer if a pause wins, and pauses repeated low-score questioning before the provider', async()=>{
    const {sqlite,db,env,category}=seed();
    await startTrainingSession(env,'learner-a',{category,difficulty:'intermediate',mode:'evidence',evidenceQuery:'policy evidence',evidenceBookIds:['book-a','book-b']},{sessionId:'control-race'});
    seams.beforeEvaluation=async()=>{await requestTrainingIntervention(db,'learner-a','control-race',{action:'PAUSE',reason:'LEARNER_REQUEST',expectedRevision:0,mutationKey:'pause-race'});};
    await expect(respondTrainingSession(env,'learner-a','control-race','A claim')).rejects.toThrow('TRAINING_INTERVENTION_CONFLICT');
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM training_messages WHERE session_id='control-race'").get()).toEqual({count:0});
    await requestTrainingIntervention(db,'learner-a','control-race',{action:'RESUME',reason:'LEARNER_REQUEST',expectedRevision:1,mutationKey:'resume-race'});
    await respondTrainingSession(env,'learner-a','control-race','First claim');
    await respondTrainingSession(env,'learner-a','control-race','Second claim');
    sqlite.exec("UPDATE training_turns SET reasoning_strength=NULL,evidence_use=NULL WHERE session_id='control-race'");
    expect((await guardTrainingIntervention(db,'learner-a','control-race')).state).toBe('ACTIVE');
    sqlite.exec("UPDATE training_turns SET reasoning_strength=0,evidence_use=0 WHERE session_id='control-race'");
    expect((await guardTrainingIntervention(db,'learner-a','control-race')).state).toBe('ACTIVE');
    sqlite.exec("UPDATE training_turns SET reasoning_strength=2,evidence_use=2 WHERE session_id='control-race'");
    seams.requests=[];
    await expect(respondTrainingSession(env,'learner-a','control-race','Same unresolved reasoning')).rejects.toMatchObject({code:'TRAINING_PAUSED'});
    expect(seams.requests).toHaveLength(0);
    expect((await loadTrainingInterventions(db,'learner-a','control-race')).latest).toMatchObject({action:'PAUSE',reason:'NON_PROGRESS',origin:'POLICY'});
  });
  it('pauses before provider execution and stops without awarding completion or changing learner scores', async () => {
    const { sqlite, db, env, category } = seed();
    await startTrainingSession(env, 'learner-a', { category, difficulty: 'intermediate', mode: 'evidence', evidenceQuery: 'policy evidence', evidenceBookIds: ['book-a', 'book-b'], learningRouteVersion:1 }, { sessionId: 'control-a' });
    await reviseTrainingRoute(db,'learner-a','control-a',{selectedRoute:'mixed',expectedRevision:0,mutationKey:'control-initial-route'});
    const paused = await requestTrainingIntervention(db,'learner-a','control-a',{action:'PAUSE',reason:'DISTRESS',expectedRevision:0,mutationKey:'pause-first'});
    expect(paused.state).toBe('PAUSED');
    await expect(respondTrainingSession(env,'learner-a','control-a','My answer')).rejects.toMatchObject({code:'TRAINING_PAUSED'});
    expect(seams.requests).toHaveLength(0);
    await requestTrainingIntervention(db,'learner-a','control-a',{action:'RESUME',reason:'LEARNER_REQUEST',expectedRevision:1,mutationKey:'resume-first'});
    await respondTrainingSession(env,'learner-a','control-a','My answer with evidence');
    const priorTurn=sqlite.prepare("SELECT id FROM training_turns WHERE session_id='control-a'").get()!;
    const revisionRequest={priorTurnId:priorTurn.id,revisedStatement:'A bounded claim',explanation:'Conditions limit it',sourceIds:[],expectedRevision:0,mutationKey:'control-initial-revision'};
    await declareLearnerRevision(db,'learner-a','control-a',revisionRequest);
    const before = sqlite.prepare("SELECT is_completed,avg_score,rating,current_turn FROM training_sessions WHERE id='control-a'").get();
    await requestTrainingIntervention(db,'learner-a','control-a',{action:'STOP',reason:'TIME_LIMIT',expectedRevision:2,mutationKey:'stop-first'});
    expect(sqlite.prepare("SELECT is_completed,avg_score,rating,current_turn FROM training_sessions WHERE id='control-a'").get()).toEqual(before);
    await expect(respondTrainingSession(env,'learner-a','control-a','Another answer')).rejects.toMatchObject({code:'TRAINING_STOPPED'});
    await expect(reviseTrainingRoute(db,'learner-a','control-a',{selectedRoute:'case-first',expectedRevision:1,mutationKey:'post-stop-route'})).rejects.toMatchObject({code:'TRAINING_INTERVENTION_TERMINAL'});
    await expect(declareLearnerRevision(db,'learner-a','control-a',{...revisionRequest,expectedRevision:1,mutationKey:'post-stop-revision'})).rejects.toMatchObject({code:'TRAINING_INTERVENTION_TERMINAL'});
    // Bypass the application precheck as a stand-in for STOP winning between read and insert.
    expect(()=>sqlite.exec("INSERT INTO training_route_decisions (id,session_id,owner_user_id,decision_revision,selected_route,effective_from_turn,mutation_key,expected_revision,created_at) SELECT 'post-stop-route','control-a',owner_user_id,2,'case-first',2,'post-stop-route',1,created_at FROM training_route_decisions WHERE session_id='control-a'")).toThrow('TRAINING_INTERVENTION_TERMINAL');
    expect(()=>sqlite.exec("INSERT INTO training_learner_revision_events SELECT 'post-stop-revision',session_id,owner_user_id,2,1,'post-stop-revision',prior_turn_id,prior_turn_number,prior_statement,revised_statement,explanation,source_ids_json,evidence_manifest_sha256,validation_status,policy_revision,created_at FROM training_learner_revision_events WHERE session_id='control-a'")).toThrow('TRAINING_INTERVENTION_TERMINAL');
    await expect(requestTrainingIntervention(db,'learner-a','control-a',{action:'RESUME',reason:'LEARNER_REQUEST',expectedRevision:3,mutationKey:'invalid-resume'})).rejects.toMatchObject({code:'TRAINING_INTERVENTION_TERMINAL'});
    expect((await loadTrainingInterventions(db,'learner-a','control-a')).history).toHaveLength(3);
  });
  it('preserves explicit unverified corrections, rejects forged references and follows up once', async () => {
    const { sqlite, db, env, category } = seed();
    await startTrainingSession(env, 'learner-a', { category, difficulty: 'intermediate', mode: 'evidence', evidenceQuery: 'policy evidence', evidenceBookIds: ['book-a', 'book-b'] }, { sessionId: 'revision-a' });
    await respondTrainingSession(env, 'learner-a', 'revision-a', 'My original claim needs a causal warrant.');
    const prior = sqlite.prepare("SELECT * FROM training_turns WHERE session_id='revision-a'").get()!;
    const input = { priorTurnId: prior.id, revisedStatement: 'My claim holds only under the stated conditions.', explanation: 'The source limits the causal mechanism.', sourceIds: ['library:book-a:chunk-a1'], expectedRevision: 0, mutationKey: 'revision-first' };
    await expect(declareLearnerRevision(db, 'learner-b', 'revision-a', input)).rejects.toMatchObject({ status: 404 });
    await expect(declareLearnerRevision(db, 'learner-a', 'revision-a', { ...input, sourceIds: ['foreign-source'] })).rejects.toMatchObject({ code: 'TRAINING_REVISION_SOURCE_INVALID' });
    await expect(declareLearnerRevision(db, 'learner-a', 'revision-a', { ...input, priorTurnId: 9999 })).rejects.toMatchObject({ status: 404 });
    const [first, replay] = await Promise.all([declareLearnerRevision(db, 'learner-a', 'revision-a', input), declareLearnerRevision(db, 'learner-a', 'revision-a', input)]);
    expect(first.id).toBe(replay.id);
    expect(first.validationStatus).toBe('UNVERIFIED');
    expect(sqlite.prepare("SELECT * FROM training_turns WHERE session_id='revision-a'").get()).toEqual(prior);
    await expect(declareLearnerRevision(db, 'learner-a', 'revision-a', { ...input, explanation: 'Conflicting replay' })).rejects.toMatchObject({ status: 409 });
    await expect(declareLearnerRevision(db, 'learner-a', 'revision-a', { ...input, mutationKey: 'revision-stale' })).rejects.toMatchObject({ status: 409 });
    expect(() => sqlite.prepare('UPDATE training_learner_revision_events SET explanation=? WHERE id=?').run('overwrite', first.id)).toThrow('TRAINING_REVISION_IMMUTABLE');
    expect(() => sqlite.prepare('DELETE FROM training_turns WHERE id=?').run(prior.id!)).toThrow('TRAINING_REVISION_IMMUTABLE');
    expect(() => sqlite.prepare('UPDATE training_turns SET id=9999 WHERE id=?').run(prior.id!)).toThrow('TRAINING_REVISION_IMMUTABLE');
    expect(() => sqlite.prepare('UPDATE training_turns SET student_model_snapshot=? WHERE id=?').run('{}', prior.id!)).toThrow('TRAINING_REVISION_IMMUTABLE');
    expect(() => sqlite.exec("INSERT OR REPLACE INTO training_learner_revision_events SELECT * FROM training_learner_revision_events WHERE session_id='revision-a'")).toThrow('TRAINING_REVISION_CONFLICT');
    seams.requests = [];
    const accepted = await respondTrainingSession(env, 'learner-a', 'revision-a', 'Please compare the mechanism behind my correction.');
    expect(accepted.session.action).toBe('ask_revision');
    expect(accepted.learnerRevisionApplied).toMatchObject({ id: first.id, reason: 'LEARNER_REQUESTED_CAUSAL_REVIEW', validationStatus: 'UNVERIFIED' });
    expect(accepted.studentModel.revisionCount).toBe(0);
    for (const lane of ['interactive_generation', 'release_critic']) expect(seams.requests.find(r => r.lane === lane)?.request.userPrompt).toContain(first.revisedStatement);
    expect(seams.requests.find(r => r.lane === 'learner_evaluation')?.request.userPrompt).not.toContain(first.revisedStatement);
    expect((await loadLearnerRevisions(db, 'learner-a', 'revision-a'))).toMatchObject({ pending: null, history: [{ id: first.id, consumedByTurn: 2, validationStatus: 'UNVERIFIED' }] });
    expect(await declareLearnerRevision(db, 'learner-a', 'revision-a', input)).toMatchObject({ id: first.id, consumedByTurn: 2 });
    const next = await respondTrainingSession(env, 'learner-a', 'revision-a', 'Now I will test a different case.');
    expect(next.learnerRevisionApplied).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('leaves a correction pending after generation failure and rejects a superseded response atomically', async () => {
    const { sqlite, db, env, category } = seed();
    await startTrainingSession(env, 'learner-a', { category, difficulty: 'intermediate', mode: 'evidence', evidenceQuery: 'policy evidence', evidenceBookIds: ['book-a', 'book-b'] }, { sessionId: 'revision-race' });
    await respondTrainingSession(env, 'learner-a', 'revision-race', 'Original statement');
    const prior = sqlite.prepare("SELECT id FROM training_turns WHERE session_id='revision-race'").get()!;
    const input = { priorTurnId: prior.id, revisedStatement: 'Revised mechanism', explanation: 'A condition changed.', sourceIds: [], expectedRevision: 0, mutationKey: 'revision-race-first' };
    const first = await declareLearnerRevision(db, 'learner-a', 'revision-race', input);
    seams.beforeEvaluation = async () => { throw new Error('Offline provider failure'); };
    await expect(respondTrainingSession(env, 'learner-a', 'revision-race', 'Review this')).rejects.toThrow();
    expect((await loadLearnerRevisions(db, 'learner-a', 'revision-race')).pending?.id).toBe(first.id);
    const beforeTurns = sqlite.prepare("SELECT * FROM training_turns WHERE session_id='revision-race'").all();
    const beforeMessages = sqlite.prepare("SELECT * FROM training_messages WHERE session_id='revision-race'").all();
    const beforeBkt = sqlite.prepare('SELECT * FROM bkt_knowledge_states').all();
    seams.beforeEvaluation = async () => { await declareLearnerRevision(db, 'learner-a', 'revision-race', { ...input, revisedStatement: 'A second correction', expectedRevision: 1, mutationKey: 'revision-race-second' }); };
    await expect(respondTrainingSession(env, 'learner-a', 'revision-race', 'Review this')).rejects.toThrow('TRAINING_REVISION_CONFLICT');
    expect(sqlite.prepare("SELECT * FROM training_turns WHERE session_id='revision-race'").all()).toEqual(beforeTurns);
    expect(sqlite.prepare("SELECT * FROM training_messages WHERE session_id='revision-race'").all()).toEqual(beforeMessages);
    expect(sqlite.prepare('SELECT * FROM bkt_knowledge_states').all()).toEqual(beforeBkt);
    const accepted = await respondTrainingSession(env, 'learner-a', 'revision-race', 'Review the latest correction');
    expect(accepted.session.action).toBe('ask_evidence');
    expect(accepted.learnerRevisionApplied?.revision).toBe(2);
    const projection = await loadLearnerRevisions(db, 'learner-a', 'revision-race');
    expect(projection.history.map(e => e.consumedByTurn)).toEqual([null, 2]);
    expect(projection.pending).toBeNull();
    expect(() => sqlite.exec("UPDATE training_turns SET learner_revision_event_id=NULL, learner_revision_number=NULL WHERE session_id='revision-race' AND turn_number=2")).toThrow('TRAINING_REVISION_IMMUTABLE');
    expect(() => sqlite.exec("DELETE FROM training_learner_revision_events WHERE session_id='revision-race'")).toThrow('TRAINING_REVISION_IMMUTABLE');
    const context = sqlite.prepare("SELECT id FROM training_session_contexts WHERE session_id='revision-race'").get()!;
    sqlite.prepare('INSERT INTO training_session_context_deletion_authorizations (session_context_id, authorization_id, created_at) VALUES (?, ?, ?)').run(context.id!, 'offline-deletion-fixture', Date.now());
    sqlite.exec("BEGIN; DELETE FROM training_turns WHERE session_id='revision-race'; DELETE FROM training_learner_revision_events WHERE session_id='revision-race'; COMMIT;");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM training_learner_revision_events WHERE session_id='revision-race'").get()).toEqual({ count: 0 });
  });
  it('authenticates correction HTTP routes and rejects caller authority fields', async () => {
    const { sqlite, env, category } = seed();
    await startTrainingSession(env, 'learner-a', { category, difficulty: 'intermediate', mode: 'evidence', evidenceQuery: 'policy evidence', evidenceBookIds: ['book-a', 'book-b'] }, { sessionId: 'revision-http' });
    await respondTrainingSession(env, 'learner-a', 'revision-http', 'Original statement');
    const prior = sqlite.prepare("SELECT id FROM training_turns WHERE session_id='revision-http'").get()!;
    const token = async (id: string) => (await generateTokens({ id, username: id, email: id + '@example.test', studentId: null, grade: null, role: 'student', createdAt: 1, lastLogin: null, isActive: true }, env.JWT_SECRET)).accessToken;
    const path = '/api/training/session/revision-http/revisions';
    expect((await trainingRoute.request(path, {}, env)).status).toBe(401);
    expect((await trainingRoute.request(path, { headers: { Authorization: 'Bearer ' + await token('learner-b') } }, env)).status).toBe(404);
    const headers = { Authorization: 'Bearer ' + await token('learner-a'), 'Content-Type': 'application/json' };
    const body = { priorTurnId: prior.id, revisedStatement: 'Revised statement', explanation: 'My reason', sourceIds: [], expectedRevision: 0, mutationKey: 'revision-http-first' };
    expect((await trainingRoute.request(path, { method: 'POST', headers, body: JSON.stringify({ ...body, validationStatus: 'VERIFIED' }) }, env)).status).toBe(400);
    expect((await trainingRoute.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, env)).status).toBe(200);
    expect(await (await trainingRoute.request(path, { headers }, env)).json()).toMatchObject({ revision: 1, pending: { validationStatus: 'UNVERIFIED' } });
  });
  it('preserves accepted training and learner-model updates when optional legacy graph work fails', async () => {
    const { sqlite, env, category } = seed();
    await startTrainingSession(env, 'learner-a', {
      category, difficulty: 'intermediate', mode: 'evidence', evidenceQuery: 'policy evidence', evidenceBookIds: ['book-a', 'book-b'],
    }, { sessionId: 'training-a' });
    const response = await respondTrainingSession(env, 'learner-a', 'training-a', '서로 다른 관점을 이해하는 태도가 중요한 가치입니다. 본문에서 판단을 바꾸는 근거를 확인합니다.');
    expect(response.evaluationNormalized).toMatchObject({ claimClarity: 4, evidenceUse: 3, reasoningStrength: 3 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM training_turns WHERE session_id = 'training-a'").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'training-a'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM learner_claim_attributions WHERE session_id = 'training-a' AND session_kind = 'training'").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM hybrid_kt_states WHERE user_id = 'learner-a'").get()).toEqual({ count: 1 });
  });
  it('rolls back the canonical turn and leaves learner models unchanged when acceptance persistence fails', async () => {
    const { sqlite, env, category } = seed();
    await startTrainingSession(env, 'learner-a', {
      category, difficulty: 'intermediate', mode: 'evidence', evidenceQuery: 'policy evidence', evidenceBookIds: ['book-a', 'book-b'],
    }, { sessionId: 'training-rejected' });
    const before = sqlite.prepare("SELECT current_turn FROM training_sessions WHERE id = 'training-rejected'").get();
    const messagesBefore = sqlite.prepare("SELECT COUNT(*) AS count FROM training_messages WHERE session_id = 'training-rejected'").get();
    sqlite.prepare('INSERT INTO bkt_knowledge_states (user_id, concept, p_know, observations, last_session_id) VALUES (?, ?, 0.4, 2, ?)').run('learner-a', '근거 부족', 'earlier-accepted-attempt');
    const bktBefore = sqlite.prepare('SELECT * FROM bkt_knowledge_states ORDER BY id').all();
    sqlite.exec("CREATE TRIGGER reject_training_turn BEFORE INSERT ON training_turns BEGIN SELECT RAISE(ABORT, 'fixture acceptance failure'); END");
    await expect(respondTrainingSession(env, 'learner-a', 'training-rejected', 'A claim supported by the selected policy evidence.')).rejects.toThrow('fixture acceptance failure');
    expect(sqlite.prepare("SELECT current_turn FROM training_sessions WHERE id = 'training-rejected'").get()).toEqual(before);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM training_messages WHERE session_id = 'training-rejected'").get()).toEqual(messagesBefore);
    for (const table of ['training_turns', 'learner_claim_attributions', 'hybrid_kt_states', 'user_concept_mastery']) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    expect(sqlite.prepare('SELECT * FROM bkt_knowledge_states ORDER BY id').all()).toEqual(bktBefore);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires an informed route choice and binds the accepted turn to its pre-outcome revision', async () => {
    const { sqlite, db, env, category } = seed();
    const started = await startTrainingSession(env, 'learner-a', {
      category, difficulty: 'intermediate', mode: 'evidence', evidenceQuery: 'policy evidence', evidenceBookIds: ['book-a', 'book-b'], learningRouteVersion: 1,
    }, { sessionId: 'training-routes' });
    expect(started.learningRoute?.status).toBe('AWAITING_CHOICE');
    const contextBefore = sqlite.prepare("SELECT * FROM training_session_contexts WHERE session_id='training-routes'").get();
    await expect(respondTrainingSession(env, 'learner-a', 'training-routes', 'A claim')).rejects.toMatchObject({ code: 'TRAINING_ROUTE_CHOICE_REQUIRED' });
    expect(seams.requests).toHaveLength(0);
    await expect(reviseTrainingRoute(db, 'learner-b', 'training-routes', { selectedRoute: 'case-first', expectedRevision: 0, mutationKey: 'foreign-choice' })).rejects.toMatchObject({ code: 'TRAINING_ROUTE_NOT_FOUND' });
    const [first, concurrentRetry] = await Promise.all([1, 2].map(() => reviseTrainingRoute(db, 'learner-a', 'training-routes', { selectedRoute: 'case-first', expectedRevision: 0, mutationKey: 'initial-choice' })));
    expect(concurrentRetry).toEqual(first);
    expect(await reviseTrainingRoute(db, 'learner-a', 'training-routes', { selectedRoute: 'case-first', expectedRevision: 0, mutationKey: 'initial-choice' })).toEqual(first);
    await expect(reviseTrainingRoute(db, 'learner-a', 'training-routes', { selectedRoute: 'mixed', expectedRevision: 0, mutationKey: 'stale-revision' })).rejects.toMatchObject({ code: 'TRAINING_ROUTE_CONFLICT' });
    await respondTrainingSession(env, 'learner-a', 'training-routes', 'The policy claim needs evidence and a reason.');
    const turn = sqlite.prepare("SELECT learning_route_decision_id, learning_route_revision FROM training_turns WHERE session_id='training-routes'").get();
    expect(turn).toEqual({ learning_route_decision_id: first.decision?.id, learning_route_revision: 1 });
    expect(seams.requests.find(r => r.lane === 'interactive_generation')?.request.userPrompt).toContain(first.decision!.id);
    expect(seams.requests.find(r => r.lane === 'learner_evaluation')?.request.userPrompt).not.toContain(first.decision!.id);
    expect(seams.requests.find(r => r.lane === 'release_critic')?.request.userPrompt).toContain(first.decision!.id);
    expect(seams.requests.find(r => r.lane === 'interactive_generation')?.request.promptVersion).toBe('tutoring-actor-route-v2');
    const second = await reviseTrainingRoute(db, 'learner-a', 'training-routes', { selectedRoute: 'proof-first', expectedRevision: 1, mutationKey: 'second-choice' });
    expect(second.decision).toMatchObject({ revision: 2, effectiveFromTurn: 2 });
    const current = await loadTrainingRoute(db, 'learner-a', 'training-routes');
    expect(current.decision).toEqual(second.decision);
    expect(current.history?.map(d => d.selectedRoute)).toEqual(['case-first', 'proof-first']);
    expect(sqlite.prepare("SELECT learning_route_revision FROM training_turns WHERE session_id='training-routes'").get()).toEqual({ learning_route_revision: 1 });
    expect(sqlite.prepare("SELECT * FROM training_session_contexts WHERE session_id='training-routes'").get()).toEqual(contextBefore);
    expect(() => sqlite.prepare("UPDATE training_route_decisions SET selected_route='mixed' WHERE session_id='training-routes'").run()).toThrow('TRAINING_ROUTE_IMMUTABLE');
    await expect(reviseTrainingRoute(db, 'learner-a', 'training-routes', { selectedRoute: 'mixed', expectedRevision: 1, mutationKey: 'second-choice' })).rejects.toMatchObject({ code: 'TRAINING_ROUTE_IDEMPOTENCY_CONFLICT' });
    sqlite.prepare("UPDATE training_sessions SET is_completed=1 WHERE id='training-routes'").run();
    await expect(reviseTrainingRoute(db, 'learner-a', 'training-routes', { selectedRoute: 'mixed', expectedRevision: 2, mutationKey: 'completed-choice' })).rejects.toMatchObject({ code: 'TRAINING_ROUTE_COMPLETED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('enforces HTTP bearer identity and rejects client-authored route authority', async () => {
    const { env, category } = seed();
    await startTrainingSession(env, 'learner-a', { category, difficulty: 'intermediate', mode: 'evidence', evidenceQuery: 'policy evidence', evidenceBookIds: ['book-a', 'book-b'], learningRouteVersion: 1 }, { sessionId: 'route-http' });
    const token = async (id: string) => (await generateTokens({ id, username: id, email: id + '@example.test', studentId: null, grade: null, role: 'student', createdAt: 1, lastLogin: null, isActive: true }, env.JWT_SECRET)).accessToken;
    const path = '/api/training/session/route-http/route';
    expect((await trainingRoute.request(path, {}, env)).status).toBe(401);
    const foreign = { Authorization: 'Bearer ' + await token('learner-b') };
    expect((await trainingRoute.request(path, { headers: foreign }, env)).status).toBe(404);
    const headers = { Authorization: 'Bearer ' + await token('learner-a'), 'Content-Type': 'application/json' };
    const body = { selectedRoute: 'mixed', expectedRevision: 0, mutationKey: 'http-choice' };
    expect((await trainingRoute.request(path, { method: 'POST', headers, body: JSON.stringify({ ...body, rationale: 'Trust my learning personality' }) }, env)).status).toBe(400);
    expect((await trainingRoute.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, env)).status).toBe(200);
    const read = await trainingRoute.request(path, { headers }, env);
    expect(await read.json()).toMatchObject({ status: 'SELECTED', decision: { selectedRoute: 'mixed', revision: 1 }, history: [{ revision: 1 }] });
    expect(seams.requests).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a stale generated response when a route revision wins before canonical persistence', async () => {
    const { sqlite, db, env, category } = seed();
    await startTrainingSession(env, 'learner-a', { category, difficulty: 'intermediate', mode: 'evidence', evidenceQuery: 'policy evidence', evidenceBookIds: ['book-a', 'book-b'], learningRouteVersion: 1 }, { sessionId: 'route-race' });
    await reviseTrainingRoute(db, 'learner-a', 'route-race', { selectedRoute: 'case-first', expectedRevision: 0, mutationKey: 'race-initial' });
    seams.beforeEvaluation = async () => { await reviseTrainingRoute(db, 'learner-a', 'route-race', { selectedRoute: 'proof-first', expectedRevision: 1, mutationKey: 'race-revision' }); };
    await expect(respondTrainingSession(env, 'learner-a', 'route-race', 'My claim needs a reason.')).rejects.toThrow('TRAINING_ROUTE_CONFLICT');
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM training_turns WHERE session_id='route-race'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM training_messages WHERE session_id='route-race'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT current_turn FROM training_sessions WHERE id='route-race'").get()).toEqual({ current_turn: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM bkt_knowledge_states').get()).toEqual({ count: 0 });
    const accepted = await respondTrainingSession(env, 'learner-a', 'route-race', 'My claim needs a reason.');
    expect(accepted.learningRoute?.decision?.revision).toBe(2);
    expect(sqlite.prepare("SELECT learning_route_revision FROM training_turns WHERE session_id='route-race'").get()).toEqual({ learning_route_revision: 2 });
    expect(() => sqlite.prepare("DELETE FROM training_route_decisions WHERE session_id='route-race'").run()).toThrow('TRAINING_ROUTE_IMMUTABLE');
    const context = sqlite.prepare("SELECT id FROM training_session_contexts WHERE session_id='route-race'").get() as { id: string };
    sqlite.prepare('INSERT INTO training_session_context_deletion_authorizations (session_context_id, authorization_id, created_at) VALUES (?, ?, ?)').run(context.id, 'offline-fixture-only', Date.now());
    sqlite.exec("BEGIN; DELETE FROM training_turns WHERE session_id='route-race'; DELETE FROM training_route_decisions WHERE session_id='route-race'; DELETE FROM training_route_offers WHERE session_id='route-race'; COMMIT;");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM training_route_offers WHERE session_id='route-race'").get()).toEqual({ count: 0 });
    // This verifies compatibility with the existing deletion gate, not a production N9 run.
  });
  it.each(['SAME_EVIDENCE_CONTENT', 'DISTINCT_EVIDENCE_CONTENT'] as const)('records a due new attempt with %s and replays without claiming transfer', async (contentStatus) => {
    const {sqlite,db,env,category}=seed();
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now());
    const security={async hmacSha256(purpose:string,bytes:Uint8Array){return createHmac('sha256','offline-recheck-only').update(purpose).update(bytes).digest('hex');}};
    const complete=async(sessionId:string,query='policy evidence')=>{
      await startTrainingSession(env,'learner-a',{category,difficulty:'intermediate',mode:'evidence',evidenceQuery:query,evidenceBookIds:['book-a','book-b'],maxTurns:1},{sessionId});
      await respondTrainingSession(env,'learner-a',sessionId,'The policy claim needs evidence and a causal reason.');
    };
    await complete('recheck-baseline');
    await recordPrivateSoloConsent(db,security,'learner-a',{purpose:'Private learning review',dataClasses:['learning_evidence'],policyRevision:1,retentionPolicy:'Until learner deletion'},'recheck-consent');
    const space=await ensureSoloGrowthSpace(db,security,'learner-a','recheck-space');const spaceId=String(space.spaceId);
    const opened=await openGrowthCycle(db,security,'learner-a',spaceId,{originKind:'TRAINING',originAttemptId:'recheck-baseline'},'recheck-open');const cycleId=String(opened.cycleId);
    const detail=await loadGrowthCycle(db,'learner-a',spaceId,cycleId);
    const focused=await selectGrowthFocus(db,security,'learner-a',spaceId,cycleId,{capabilityId:detail.observations[0].capabilityId,capabilityRevision:1,statement:'I want to test a causal explanation'},'recheck-focus',Number(opened.aggregateRevision));
    const scheduled=await respondToPractice(db,security,'learner-a',spaceId,cycleId,{action:'accept',practiceQuestId:String(focused.practiceQuestId)},'recheck-accept',Number(focused.aggregateRevision));
    const scheduledDetail=await loadGrowthCycle(db,'learner-a',spaceId,cycleId);const recheck=scheduledDetail.rechecks[0];const revision=Number(scheduled.aggregateRevision);
    const record=(attempt:string,key='recheck-record')=>recordRecheck(db,security,'learner-a',spaceId,cycleId,{action:'record',recheckId:recheck.id,followUpOrigin:{originKind:'TRAINING',originAttemptId:attempt}},key,revision);
    await expect(record('recheck-baseline')).rejects.toMatchObject({code:'GROWTH_RECHECK_NOT_DUE'});
    clock.mockReturnValue(recheck.scheduledFor-1);await complete('recheck-too-early','policy evidence alternative');
    clock.mockReturnValue(recheck.scheduledFor+1);
    await expect(record('recheck-too-early')).rejects.toMatchObject({code:'GROWTH_RECHECK_FOLLOW_UP_STARTED_TOO_EARLY'});
    await complete('recheck-same-content','policy evidence alternative');
    await expect(record('recheck-baseline')).rejects.toMatchObject({code:'GROWTH_RECHECK_ORIGIN_KIND_OR_IDENTITY_MISMATCH'});
    await expect(recordRecheck(db,security,'learner-b',spaceId,cycleId,{action:'record',recheckId:recheck.id,followUpOrigin:{originKind:'TRAINING',originAttemptId:'recheck-same-content'}},'foreign-recheck',revision)).rejects.toMatchObject({code:'GROWTH_RESOURCE_NOT_FOUND'});
    // New library stimulus, not a different session ID/query over the same source content.
    const changedContent = 'Policy evidence: the intervention now has a different cost and population. Compare boundary conditions.';
    if (contentStatus === 'DISTINCT_EVIDENCE_CONTENT') sqlite.prepare("UPDATE document_chunks SET content=?,char_end=? WHERE id='chunk-a1'").run(changedContent,changedContent.length);
    clock.mockReturnValue(recheck.scheduledFor+2);await complete('recheck-new-context','policy evidence alternative');
    const result=await record('recheck-new-context');
    expect(result).toMatchObject({state:'RECHECKED',outcome:'UNKNOWN'});
    const observationsBefore=sqlite.prepare('SELECT COUNT(*) AS count FROM growth_capability_observations WHERE growth_cycle_id=?').get(cycleId);
    expect(await record('recheck-new-context')).toEqual(result);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM growth_capability_observations WHERE growth_cycle_id=?').get(cycleId)).toEqual(observationsBefore);
    const persisted=sqlite.prepare('SELECT raw_signal_json,status,inference_validation FROM growth_capability_observations WHERE id=?').get(String(result.recheckObservationId))!;
    expect(persisted.status).toBe('UNKNOWN');expect(persisted.inference_validation).toBe('PROVISIONAL_UNCALIBRATED');
    expect(JSON.parse(String(persisted.raw_signal_json)).contextComparison).toMatchObject({status:contentStatus,semanticValidation:'UNKNOWN',scheduledFor:recheck.scheduledFor});
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['route-modules', 'production-entrypoint'])('carries an authenticated learner through the HTTP follow-up path using %s and withholds it from other identities', async (entrypoint) => {
    const { sqlite, env, category } = seed();
    env.GROWTH_CYCLE_HMAC_SECRET = 'offline-http-hmac-only';
    const app = entrypoint === 'production-entrypoint' ? (await import('../src/index')).default
      : new Hono<{ Bindings: Bindings }>().route('/', trainingRoute).route('/', growthRoute);
    type JourneyBody = { sessionId: string; spaceId: string; cycleId: string; launchId: string;
      aggregateRevision: number; practiceQuestId: string; recheckObservationId: string;
      deletionReceiptId: string; completedAt: number; response: string; protocol: unknown; growthFollowUp: unknown; cycle: GrowthCycleDetail };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const token = async (id: string, secret = env.JWT_SECRET) => (await generateTokens({ id, username: id, email: id + '@example.test', studentId: null, grade: null, role: 'student', createdAt: 1, lastLogin: null, isActive: true }, secret)).accessToken;
    const request = async (path: string, body?: object, key?: string, identity: string | null = 'learner-a', method = body || key ? 'POST' : 'GET', secret = env.JWT_SECRET) => {
      const pending: Promise<unknown>[] = [];
      const response = await app.request(path, {
        method,
        headers: { ...(identity ? { Authorization: 'Bearer ' + await token(identity, secret) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }, env, { waitUntil: promise => pending.push(promise), passThroughOnException: () => undefined, props: {} });
      await Promise.all(pending);
      return { status: response.status, body: await response.json() as JourneyBody };
    };
    const ok = async (path: string, body?: object, key?: string, method?: string) => {
      const result = await request(path, body, key, 'learner-a', method);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return result.body;
    };
    const start = { category, difficulty: 'intermediate', mode: 'evidence', evidenceQuery: 'policy evidence', evidenceBookIds: ['book-a', 'book-b'], maxTurns: 1 };
    for (const path of ['/api/training/start', '/api/growth/privacy/consent']) {
      expect((await request(path, start, 'http-unauth', null)).status).toBe(401);
      expect((await request(path, start, 'http-forged', 'learner-a', 'POST', 'incorrect-signing-secret')).status).toBe(401);
    }
    if (entrypoint === 'production-entrypoint') {
      const { getAllBooks } = await import('../src/data/books');
      for (const book of getAllBooks()) {
        const seeded = sqlite.prepare('SELECT id, chunk_count, ingestion_status FROM books WHERE id=?').get(book.id);
        expect(seeded).toMatchObject({ id: book.id, ingestion_status: 'd1_ready' });
        expect(Number(seeded?.chunk_count)).toBeGreaterThan(0);
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM document_chunks WHERE book_id=?').get(book.id)?.count).toBe(seeded?.chunk_count);
      }
      const preflight = await app.request('/api/growth/spaces', { method: 'OPTIONS', headers: { Origin: 'https://offline.example.test', 'Access-Control-Request-Method': 'GET' } }, env);
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }
    const baseline = await ok('/api/training/start', start);
    await ok('/api/training/chat', { sessionId: baseline.sessionId, message: 'The claim requires causal evidence.' });
    await ok('/api/growth/privacy/consent', { purpose: 'Private learning review', dataClasses: ['learning_evidence'], policyRevision: 1, retentionPolicy: 'Until learner deletion' }, 'http-consent');
    const space = await ok('/api/growth/spaces/solo', undefined, 'http-space');
    const cyclesPath = `/api/growth/spaces/${space.spaceId}/cycles`;
    const opened = await ok(cyclesPath, { originKind: 'TRAINING', originAttemptId: baseline.sessionId }, 'http-open');
    const cyclePath = `${cyclesPath}/${opened.cycleId}`;
    const detail = await ok(cyclePath);
    const focused = await ok(`${cyclePath}/focus`, { capabilityId: detail.cycle.observations[0].capabilityId, capabilityRevision: 1, statement: 'Reconstruct the causal explanation', expectedRevision: opened.aggregateRevision }, 'http-focus');
    const scheduled = await ok(`${cyclePath}/practice-response`, { action: 'accept', practiceQuestId: focused.practiceQuestId, expectedRevision: focused.aggregateRevision }, 'http-practice');
    const recheck = (await ok(cyclePath)).cycle.rechecks[0];
    const launchPath = `${cyclePath}/recheck-follow-up-launches`;
    const launchBody = { recheckId: recheck.id, changedCondition: 'Assume half the budget; explain which causal steps still hold.', expectedRevision: scheduled.aggregateRevision };
    expect(await request(launchPath, launchBody, 'http-launch')).toMatchObject({ status: 409, body: { code: 'GROWTH_RECHECK_NOT_DUE' } });
    clock.mockReturnValue(recheck.scheduledFor + 1);
    expect(await request(launchPath, launchBody, 'http-foreign', 'learner-b')).toMatchObject({ status: 404, body: { code: 'GROWTH_RESOURCE_NOT_FOUND' } });
    expect((await request(launchPath, { ...launchBody, ownerUserId: 'learner-a' }, 'http-injected')).status).toBe(400);
    for (const missing of ['launch-tables', 'protocol-columns', 'rejected-table-read', 'rejected-column-read']) {
      const readyDB = env.DB;
      env.DB = new Proxy(readyDB, { get(target, property) {
        if (property === 'prepare') return (sql: string) => {
          const statement = readyDB.prepare(sql);
          const unavailable = missing === 'launch-tables' || missing === 'rejected-table-read'
            ? sql.includes('sqlite_master') && sql.includes("'growth_recheck_follow_up_bindings'")
            : sql === 'PRAGMA table_info(growth_recheck_follow_up_launches)';
          return unavailable ? new Proxy(statement, { get(inner, key) {
            if (key === 'all') return async () => {
              if (missing.startsWith('rejected-')) throw new Error('Offline schema read outage');
              return {success:true,results:[]};
            };
            return Reflect.get(inner,key);
          } }) : statement;
        };
        return Reflect.get(target,property);
      } });
      try {
        expect(await request(launchPath, launchBody, 'http-skew-'+missing)).toMatchObject({status:503,body:{code:'GROWTH_FOLLOW_UP_PROTOCOL_UNAVAILABLE',retryable:true}});
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM growth_recheck_follow_up_launches').get()?.count).toBe(0);
      } finally { env.DB = readyDB; }
    }
    const launch = await ok(launchPath, launchBody, 'http-launch');
    expect(launch.protocol).toMatchObject({ status: 'PREDECLARED_LOCAL', protocolRevision: 'growth-follow-up-local-v1', declaredAt: recheck.scheduledFor + 1,
      assistanceLogPolicy: { revision: 'training-assistance-capture-v1', coverage: 'LOCAL_RECORDED_ONLY', externalAssistance: 'UNKNOWN' }, outcome: 'UNKNOWN' });
    expect((await request(launchPath, { ...launchBody, protocolRevision: 'client-approved' }, 'http-injected-protocol')).status).toBe(400);
    expect((await ok(cyclePath)).cycle.rechecks[0].followUpLaunch).toMatchObject({ protocol: launch.protocol });
    const declaredRow = sqlite.prepare('SELECT protocol_revision, assistance_policy_revision FROM growth_recheck_follow_up_launches WHERE id=?').get(launch.launchId);
    expect(declaredRow).toEqual({ protocol_revision: 'growth-follow-up-local-v1', assistance_policy_revision: 'training-assistance-capture-v1' });
    expect(() => sqlite.prepare('UPDATE growth_recheck_follow_up_launches SET protocol_revision=? WHERE id=?').run('retroactive', launch.launchId)).toThrow('GROWTH_FOLLOW_UP_IMMUTABLE');
    expect(() => sqlite.prepare('INSERT OR REPLACE INTO growth_recheck_follow_up_launches SELECT * FROM growth_recheck_follow_up_launches WHERE id=?').run(launch.launchId)).toThrow();
    expect(sqlite.prepare('SELECT protocol_revision, assistance_policy_revision FROM growth_recheck_follow_up_launches WHERE id=?').get(launch.launchId)).toEqual(declaredRow);
    expect(await ok(launchPath, launchBody, 'http-launch')).toEqual(launch);
    expect((await request(launchPath, { ...launchBody, changedCondition: 'A different condition under the same mutation key.' }, 'http-launch')).status).toBe(409);
    const followUpBody = { ...start, maxTurns: 2, growthFollowUpLaunchId: launch.launchId };
    expect(await request('/api/training/start', followUpBody, undefined, 'learner-b')).toMatchObject({ status: 404, body: { code: 'GROWTH_FOLLOW_UP_NOT_FOUND' } });
    const followUp = await ok('/api/training/start', followUpBody);
    expect(followUp.growthFollowUp).toMatchObject({ launchId: launch.launchId, cycleId: opened.cycleId, spaceId: space.spaceId, changedCondition: launchBody.changedCondition });
    expect(followUp.growthFollowUp).toMatchObject({ protocol: launch.protocol });
    expect(await request('/api/training/start', followUpBody)).toMatchObject({ status: 409, body: { code: 'GROWTH_FOLLOW_UP_ALREADY_STARTED', sessionId: followUp.sessionId } });
    const trainingPath = `/api/training/session/${followUp.sessionId}`;
    expect((await ok(`${trainingPath}/resume`, undefined, undefined, 'POST')).growthFollowUp).toEqual(followUp.growthFollowUp);
    if (entrypoint === 'production-entrypoint') {
      for (const [path, method] of [[`/api/sessions/${followUp.sessionId}`, 'GET'], [`/api/sessions/${followUp.sessionId}/resume`, 'POST']]) {
        expect((await ok(path, undefined, undefined, method)).growthFollowUp).toEqual(followUp.growthFollowUp);
        expect((await request(path, undefined, undefined, 'learner-b', method)).status).toBe(403);
        expect((await request(path, undefined, undefined, null, method)).status).toBe(401);
      }
    }
    for (const [path, method] of [[cyclePath, 'GET'], [trainingPath, 'GET'], [`${trainingPath}/resume`, 'POST']]) {
      const foreign = await request(path, undefined, undefined, 'learner-b', method);
      expect([403, 404]).toContain(foreign.status);
      expect(JSON.stringify(foreign.body)).not.toContain(launchBody.changedCondition);
      expect((await request(path, undefined, undefined, null, method)).status).toBe(401);
    }
    const recordBody = { action: 'record', recheckId: recheck.id, followUpLaunchId: launch.launchId, expectedRevision: launch.aggregateRevision };
    expect(await request(`${cyclePath}/rechecks`, recordBody, 'http-record')).toMatchObject({ status: 422, body: { code: 'GROWTH_OWNED_COMPLETED_TRAINING_ORIGIN_REQUIRED' } });
    await ok('/api/training/chat', { sessionId: followUp.sessionId, message: 'Reduced budget limits the causal step supported by the source.' });
    await ok(`${trainingPath}/interventions`, { action: 'HELP', reason: 'LEARNER_REQUEST', expectedRevision: 0, mutationKey: 'http-help' });
    const support = await ok(`${trainingPath}/support`, {});
    await ok('/api/training/chat', { sessionId: followUp.sessionId, message: 'After the explanation, I would revise the causal claim to include the budget condition.' });
    expect((await ok(cyclePath)).cycle.rechecks[0].followUpLaunch).toMatchObject({ sessionId: followUp.sessionId, completed: true, semanticValidation: 'UNKNOWN' });
    const originalDB = env.DB;
    const beforeUnavailable = sqlite.prepare('SELECT COUNT(*) AS count FROM growth_capability_observations').get();
    env.DB = new Proxy(originalDB, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        const statement = originalDB.prepare(sql);
        if (!sql.includes('r.created_at AS support_created_at')) return statement;
        const unavailable = new Proxy(statement, { get(inner, property) {
          if (property === 'bind') return (...values: unknown[]) => { inner.bind(...values); return unavailable; };
          if (property === 'all') return async () => ({ success: false, results: [] });
          return Reflect.get(inner, property);
        } });
        return unavailable;
      };
      return Reflect.get(target, key);
    } });
    try {
      expect(await request(`${cyclePath}/rechecks`, recordBody, 'http-record')).toMatchObject({ status: 503, body: { code: 'GROWTH_RECHECK_ASSISTANCE_UNAVAILABLE' } });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM growth_capability_observations').get()).toEqual(beforeUnavailable);
      expect(sqlite.prepare('SELECT completed_turn_id FROM growth_recheck_follow_up_bindings WHERE launch_id=?').get(launch.launchId)?.completed_turn_id).toBeNull();
    } finally { env.DB = originalDB; }
    const recorded = await ok(`${cyclePath}/rechecks`, recordBody, 'http-record');
    expect(recorded).toMatchObject({ state: 'RECHECKED', outcome: 'UNKNOWN' });
    expect(await ok(`${cyclePath}/rechecks`, recordBody, 'http-record')).toEqual(recorded);
    const publicRecheck = (await ok(cyclePath)).cycle.rechecks[0];
    expect(publicRecheck.assistance).toEqual({ status: 'RECORDED', kind: 'TRAINING_RECORDS_V1', coverage: 'LOCAL_RECORDED_ONLY',
      externalAssistance: 'UNKNOWN', deliveryValidation: 'UNKNOWN', protocolValidation: 'UNKNOWN',
      baseline: { acceptedTurns: 1, supportRequested: 0, supportRecorded: 0, pauses: 0, turnsWithHints: 0 },
      followUp: { acceptedTurns: 2, supportRequested: 1, supportRecorded: 1, pauses: 0, turnsWithHints: 0 } });
    expect(JSON.stringify(publicRecheck)).not.toContain(support.response);
    expect(JSON.stringify(publicRecheck)).not.toContain('logJson');
    expect((await request(cyclePath, undefined, undefined, 'learner-b')).status).toBe(404);
    expect(sqlite.prepare('SELECT completed_turn_id FROM growth_recheck_follow_up_bindings WHERE launch_id=?').get(launch.launchId)?.completed_turn_id).toBeTruthy();
    const observation = sqlite.prepare('SELECT raw_signal_json FROM growth_capability_observations WHERE id=?').get(recorded.recheckObservationId)!;
    const stored = JSON.parse(String(observation.raw_signal_json)).storedSourcePayload;
    expect(stored.assistance).toMatchObject({ capturePolicyRevision: 'training-assistance-capture-v1', coverage: 'LOCAL_RECORDED_ONLY', externalAssistance: 'UNKNOWN', deliveryValidation: 'UNKNOWN', protocolValidation: 'UNKNOWN' });
    expect(createHash('sha256').update(stored.assistance.logJson, 'utf8').digest('hex')).toBe(stored.assistance.logSha256);
    const log = JSON.parse(stored.assistance.logJson);
    expect(log.baseline.sessionId).toBe(baseline.sessionId);
    expect(log.baseline.interventions).toEqual([]);
    expect(log.followUp.turns).toHaveLength(2);
    expect(log.followUp.interventions).toHaveLength(1);
    expect(log.followUp.interventions[0]).toMatchObject({ action: 'HELP', response: support.response, support_policy_revision: 'bounded-support-v1' });
    expect(log.followUp.turns[1].intervention_revision).toBe(1);
    expect(stored.changedContextDefinition).toEqual({ source: 'LEARNER_DECLARED', text: launchBody.changedCondition, semanticValidation: 'UNKNOWN' });
    expect(stored.followUpCapture).toMatchObject({ launchId: launch.launchId, scheduledFor: recheck.scheduledFor });
    expect(stored.followUpProtocol).toEqual(launch.protocol);
    const event = sqlite.prepare('SELECT payload_digest, source_event_id FROM growth_events WHERE id=?').get(JSON.parse(String(sqlite.prepare('SELECT evidence_event_ids_json FROM growth_capability_observations WHERE id=?').get(recorded.recheckObservationId)!.evidence_event_ids_json))[0])!;
    const { createGrowthCycleSecurity } = await import('../src/services/growth-cycle-security');
    const canonical = (value: unknown): string => JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : child);
    expect(await createGrowthCycleSecurity(env.GROWTH_CYCLE_HMAC_SECRET).hmacSha256('growth-cycle:raw-origin:v1', new TextEncoder().encode(canonical({ originIdentity: event.source_event_id, payload: stored })))).toBe(event.payload_digest);
    clock.mockRestore(); // Growth erasure receipts use SQLite's wall clock.
    const deleted = await ok(cyclePath, { expectedRevision: recorded.aggregateRevision }, 'http-delete', 'DELETE');
    expect(await ok(cyclePath, { expectedRevision: recorded.aggregateRevision }, 'http-delete', 'DELETE')).toEqual(deleted);
    expect((await ok(trainingPath)).growthFollowUp).toBeNull();
    if (entrypoint === 'production-entrypoint') expect((await ok(`/api/sessions/${followUp.sessionId}`)).growthFollowUp).toBeNull();
    expect(sqlite.prepare('SELECT id FROM growth_recheck_follow_up_launches WHERE id=?').get(launch.launchId)).toBeUndefined();
    expect(sqlite.prepare('SELECT launch_id FROM growth_recheck_follow_up_bindings WHERE launch_id=?').get(launch.launchId)).toBeUndefined();
    for (const table of ['growth_capability_observations', 'growth_events', 'growth_mutation_receipts', 'growth_rechecks']) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE growth_cycle_id=?`).get(opened.cycleId)).toEqual({ count: 0 });
    }
    expect(sqlite.prepare('SELECT completed_at FROM growth_deletion_receipts WHERE id=?').get(deleted.deletionReceiptId)?.completed_at).toBe(deleted.completedAt);
    expect((await request(`${cyclePath}/rechecks`, recordBody, 'http-record')).status).toBe(404);
    expect((await request(launchPath, launchBody, 'http-launch')).status).toBe(404);
    expect(sqlite.prepare('SELECT response FROM training_support_responses WHERE session_id=?').get(followUp.sessionId)?.response).toBe(support.response);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['normal','interleaved','revoked','clock-skew'] as const)('launches and binds one completed Training attempt with %s', async (variant) => {
    const {sqlite,db,env,category,failures}=seed();
    const realNow=Date.now.bind(Date);
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now());
    const security={async hmacSha256(purpose:string,bytes:Uint8Array){return createHmac('sha256','offline-launch-only').update(purpose).update(bytes).digest('hex');}};
    const start={category,difficulty:'intermediate' as const,mode:'evidence' as const,evidenceQuery:'policy evidence',evidenceBookIds:['book-a','book-b'],maxTurns:1};
    await startTrainingSession(env,'learner-a',start,{sessionId:'launch-baseline'});
    await respondTrainingSession(env,'learner-a','launch-baseline','The claim requires causal evidence.');
    await recordPrivateSoloConsent(db,security,'learner-a',{purpose:'Private learning review',dataClasses:['learning_evidence'],policyRevision:1,retentionPolicy:'Until learner deletion'},'launch-consent');
    const spaceId=String((await ensureSoloGrowthSpace(db,security,'learner-a','launch-space')).spaceId);
    const opened=await openGrowthCycle(db,security,'learner-a',spaceId,{originKind:'TRAINING',originAttemptId:'launch-baseline'},'launch-open');const cycleId=String(opened.cycleId);
    const detail=await loadGrowthCycle(db,'learner-a',spaceId,cycleId);
    const focused=await selectGrowthFocus(db,security,'learner-a',spaceId,cycleId,{capabilityId:detail.observations[0].capabilityId,capabilityRevision:1,statement:'Reconstruct the causal explanation'},'launch-focus',Number(opened.aggregateRevision));
    const scheduled=await respondToPractice(db,security,'learner-a',spaceId,cycleId,{action:'accept',practiceQuestId:String(focused.practiceQuestId)},'launch-accept',Number(focused.aggregateRevision));
    const recheck=(await loadGrowthCycle(db,'learner-a',spaceId,cycleId)).rechecks[0];
    const input={recheckId:recheck.id,changedCondition:'Assume the intervention has half the budget; explain which causal steps still hold.'};
    const launch=()=>launchRecheckFollowUp(db,security,'learner-a',spaceId,cycleId,input,'launch-new',Number(scheduled.aggregateRevision));
    await expect(launch()).rejects.toMatchObject({code:'GROWTH_RECHECK_NOT_DUE'});
    clock.mockReturnValue(recheck.scheduledFor+1);
    await expect(launchRecheckFollowUp(db,security,'learner-b',spaceId,cycleId,input,'launch-foreign',Number(scheduled.aggregateRevision))).rejects.toMatchObject({code:'GROWTH_RESOURCE_NOT_FOUND'});
    const created=await launch();expect(await launch()).toEqual(created);
    const followUpLaunchId=String(created.launchId);
    expect((await loadGrowthCycle(db,'learner-a',spaceId,cycleId)).rechecks[0].followUpLaunch).toMatchObject({id:followUpLaunchId,sessionId:null,completed:false});
    await expect(startTrainingSession(env,'learner-b',{...start,growthFollowUpLaunchId:followUpLaunchId})).rejects.toMatchObject({code:'GROWTH_FOLLOW_UP_NOT_FOUND'});
    await expect(startTrainingSession(env,'learner-a',{...start,mode:'constructed',growthFollowUpLaunchId:followUpLaunchId})).rejects.toMatchObject({code:'GROWTH_FOLLOW_UP_EVIDENCE_REQUIRED'});
    if(variant==='revoked'){
      const revokeEnv={...env,DB:new Proxy(db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
        sqlite.prepare('UPDATE growth_private_consent_receipts SET revoked_at=? WHERE id=(SELECT consent_receipt_id FROM growth_cycles WHERE id=?)').run(Date.now(),cycleId);
        return db.batch(statements);
      };return Reflect.get(target,key);}})};
      await expect(startTrainingSession(revokeEnv,'learner-a',{...start,growthFollowUpLaunchId:followUpLaunchId},{sessionId:'launch-revoked'})).rejects.toMatchObject({body:{code:'TRAINING_CONTEXT_PERSISTENCE_FAILED'}});
      expect(sqlite.prepare("SELECT id FROM training_sessions WHERE id='launch-revoked'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT session_id FROM training_scenario_packs WHERE session_id='launch-revoked'").get()).toBeUndefined();
      expect(sqlite.prepare('SELECT launch_id FROM growth_recheck_follow_up_bindings WHERE launch_id=?').get(followUpLaunchId)).toBeUndefined();
      await expect(startTrainingSession(env,'learner-a',{...start,growthFollowUpLaunchId:followUpLaunchId})).rejects.toMatchObject({code:'GROWTH_FOLLOW_UP_NOT_FOUND'});
      expect(fetch).not.toHaveBeenCalled();return;
    }
    let followUp!: Awaited<ReturnType<typeof startTrainingSession>>;
    if(variant==='interleaved'){
      const raceEnv={...env,DB:new Proxy(db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
        followUp=await startTrainingSession(env,'learner-a',{...start,growthFollowUpLaunchId:followUpLaunchId},{sessionId:'launch-follow-up'});
        return db.batch(statements);
      };return Reflect.get(target,key);}})};
      await expect(startTrainingSession(raceEnv,'learner-a',{...start,growthFollowUpLaunchId:followUpLaunchId},{sessionId:'launch-race-loser'})).rejects.toMatchObject({body:{code:'TRAINING_CONTEXT_PERSISTENCE_FAILED'}});
      expect(sqlite.prepare("SELECT id FROM training_sessions WHERE id='launch-race-loser'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT session_id FROM training_scenario_packs WHERE session_id='launch-race-loser'").get()).toBeUndefined();
    }else followUp=await startTrainingSession(env,'learner-a',{...start,growthFollowUpLaunchId:followUpLaunchId},{sessionId:'launch-follow-up'});

    expect(followUp.context).toContain(input.changedCondition);
    expect(followUp.question).toContain('다시 구성');
    await expect(startTrainingSession(env,'learner-a',{...start,growthFollowUpLaunchId:followUpLaunchId},{sessionId:'launch-duplicate'})).rejects.toMatchObject({code:'GROWTH_FOLLOW_UP_ALREADY_STARTED'});
    expect(sqlite.prepare("SELECT id FROM training_sessions WHERE id='launch-duplicate'").get()).toBeUndefined();
    const record=()=>recordRecheck(db,security,'learner-a',spaceId,cycleId,{action:'record',recheckId:recheck.id,followUpLaunchId},'launch-record',Number(created.aggregateRevision));
    await expect(recordRecheck(db,security,'learner-a',spaceId,cycleId,{action:'reschedule',recheckId:recheck.id,revisitAt:recheck.scheduledFor+10000},'launch-reschedule',Number(created.aggregateRevision))).rejects.toMatchObject({code:'GROWTH_FOLLOW_UP_ALREADY_STARTED'});
    await expect(recordRecheck(db,security,'learner-a',spaceId,cycleId,{action:'record',recheckId:recheck.id,followUpOrigin:{originKind:'TRAINING',originAttemptId:followUp.sessionId}},'launch-bypass',Number(created.aggregateRevision))).rejects.toMatchObject({code:'GROWTH_FOLLOW_UP_BINDING_REQUIRED'});
    await expect(record()).rejects.toMatchObject({code:'GROWTH_OWNED_COMPLETED_TRAINING_ORIGIN_REQUIRED'});
    await respondTrainingSession(env,'learner-a',followUp.sessionId,'The changed budget limits a causal step; source evidence sets its boundary.');
    expect((await loadGrowthCycle(db,'learner-a',spaceId,cycleId)).rechecks[0].followUpLaunch).toMatchObject({id:followUpLaunchId,sessionId:followUp.sessionId,completed:true});
    const recorded=await record();expect(recorded).toMatchObject({state:'RECHECKED',outcome:'UNKNOWN'});expect(await record()).toEqual(recorded);
    const binding=sqlite.prepare('SELECT * FROM growth_recheck_follow_up_bindings WHERE launch_id=?').get(followUpLaunchId)!;
    expect(binding.session_id).toBe(followUp.sessionId);expect(binding.completed_turn_id).toBeTruthy();
    expect(sqlite.prepare('SELECT context_id FROM growth_recheck_follow_up_bindings WHERE launch_id=?').get(followUpLaunchId)?.context_id).toBe(sqlite.prepare('SELECT id FROM training_session_contexts WHERE session_id=?').get(followUp.sessionId)?.id);
    if(variant==='clock-skew')clock.mockReturnValue(realNow()+2000);
    else clock.mockRestore(); // Database receipt chronology must not depend on the app clock.
    await deleteGrowthCycle(db,security,'learner-a',spaceId,cycleId,'launch-delete',Number(recorded.aggregateRevision)).catch(error => { throw new Error(String(error)+'\n'+failures.join('\n')); });
    expect(sqlite.prepare('SELECT id FROM growth_recheck_follow_up_launches WHERE id=?').get(followUpLaunchId)).toBeUndefined();
    expect(sqlite.prepare('SELECT launch_id FROM growth_recheck_follow_up_bindings WHERE launch_id=?').get(followUpLaunchId)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('opens an owned private Growth cycle from two real attributable Training turns', async () => {
    const { sqlite, db, env, category } = seed();
    await startTrainingSession(env, 'learner-a', {
      category, difficulty: 'intermediate', mode: 'evidence', evidenceQuery: 'policy evidence', evidenceBookIds: ['book-a', 'book-b'], maxTurns: 2,
    }, { sessionId: 'training-two-turns' });
    await respondTrainingSession(env, 'learner-a', 'training-two-turns', '서로 다른 관점을 이해하는 태도가 중요한 가치입니다. 본문에서 판단을 바꾸는 근거를 확인합니다.');
    const completed = await respondTrainingSession(env, 'learner-a', 'training-two-turns', '근거의 적용 범위를 한정해서 판단해야 합니다. 본문에서 다른 관점이 가능한 이유를 확인합니다.');
    expect(completed.isSessionEnd).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM learner_claim_attributions WHERE session_id = 'training-two-turns' AND session_kind = 'training'").get()).toEqual({ count: 2 });
    expect(sqlite.prepare("SELECT evidence_count FROM user_concept_mastery WHERE user_id = 'learner-a' AND concept_id = '근거 부족'").get()).toEqual({ evidence_count: 2 });
    const security = { async hmacSha256(purpose: string, bytes: Uint8Array) {
      return createHmac('sha256', 'offline-test-only').update(purpose).update(bytes).digest('hex');
    } };
    await recordPrivateSoloConsent(db, security, 'learner-a', { purpose: '개인 학습 돌아보기', dataClasses: ['learning_evidence'], policyRevision: 1, retentionPolicy: '학습자가 삭제할 때까지' }, 'consent-two-turns');
    const space = await ensureSoloGrowthSpace(db, security, 'learner-a', 'space-two-turns');
    const spaceId = String(space.spaceId);
    const opened = await openGrowthCycle(db, security, 'learner-a', spaceId, { originKind: 'TRAINING', originAttemptId: 'training-two-turns' }, 'open-two-turns');
    expect(opened).toMatchObject({ state: 'GAP_UNKNOWN' });
    const detail = await loadGrowthCycle(db, 'learner-a', spaceId, String(opened.cycleId));
    expect(detail.observations).toHaveLength(1);
    expect(detail.observations[0].status).toBe('UNKNOWN');
    await expect(loadGrowthCycle(db, 'learner-b', spaceId, String(opened.cycleId))).rejects.toMatchObject({ code: 'GROWTH_RESOURCE_NOT_FOUND' });
    expect(fetch).not.toHaveBeenCalled();
  });

});
