import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import type { DatabaseSync } from 'node:sqlite';
import { createMigratedLearningDatabase } from './fixtures/learning-engine-db';
import { generateTokens } from '../src/services/auth';
import type { Bindings } from '../src/types';

const { startTrainingSession, trainingRoute } = await import('../src/routes/training');
const { armHeldOutAttempt, openHeldOutAttempt, stopHeldOutAttempt } = await import('../src/services/training/heldout-delivery');
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture(withRecord = true) {
  const database = createMigratedLearningDatabase();
  databases.push(database.sqlite);
  const { sqlite, db } = database;
  sqlite.exec(`
    INSERT INTO users (id, username, email, password_hash, role) VALUES
      ('learner-a', 'learner-a', 'learner-a@example.test', 'fixture-only', 'student'),
      ('learner-b', 'learner-b', 'learner-b@example.test', 'fixture-only', 'student'),
      ('operator-a', 'operator-a', 'operator-a@example.test', 'fixture-only', 'admin');
  `);
  const sources = [
    ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'Synthetic example: demand and seasonality', 'Socratic AI synthetic example', 'synthetic-demand-seasonality', 'seasonality demand attendance operating cost'],
    ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'Synthetic example: demand and seasonality', 'Socratic AI synthetic example', 'synthetic-demand-weather', 'weather leisure demand facilities'],
    ['SYNTHETIC-HH-OPERATIONS-EXAMPLE', 'Synthetic example: operations and safety', 'Socratic AI synthetic example', 'synthetic-operations-safety', 'safety maintenance competition attendance demand'],
  ] as const;
  for (const [bookId, title, author, chunkId, content] of sources) {
    sqlite.prepare('INSERT OR IGNORE INTO books (id, title, author, text, is_builtin, visibility, lifecycle_status) VALUES (?, ?, ?, ?, 1, \'builtin\', \'active\')')
      .run(bookId, title, author, content);
    const index = (sqlite.prepare('SELECT COUNT(*) AS count FROM document_chunks WHERE book_id = ?').get(bookId) as { count: number }).count;
    sqlite.prepare('INSERT INTO document_chunks (id, book_id, chunk_index, content, char_start, char_end) VALUES (?, ?, ?, ?, 0, ?)')
      .run(chunkId, bookId, index, content, content.length);
  }
  const category = sqlite.prepare('SELECT id FROM category_hierarchy WHERE is_active = 1 LIMIT 1').get() as { id: string };
  const env = {
    DB: db,
    JWT_SECRET: 'evidence-model-fixture-secret',
    AI_ACTOR_SSU_API_KEY: '[REDACTED]',
    AI_ASSESSMENT_DEEPSEEK_API_KEY: '[REDACTED]',
    SOONGSIL_API_KEY: '[REDACTED]',
    DEEPSEEK_API_KEY: '[REDACTED]',
  } as Bindings;
  const base = await startTrainingSession(env, 'learner-a', {
    category: category.id,
    difficulty: 'intermediate',
    mode: 'evidence',
    caseId: 'HH-INVEST-100B',
    evidenceQuery: 'seasonality safety demand',
    evidenceBookIds: ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'SYNTHETIC-HH-OPERATIONS-EXAMPLE'],
    maxTurns: 3,
  });
  const now = 1_700_000_000_000;
  if (withRecord) {
    sqlite.prepare(`INSERT INTO training_turns (
      session_id, turn_number, student_message, ai_response,
      claim_clarity, evidence_use, reasoning_strength, consistency_score, relevance_score, created_at
    ) VALUES (?, 1, ?, ?, 3, 3, 3, 3, 3, ?)`)
      .run(base.sessionId, 'Initial learner observation.', 'Recorded application response.', now);
    const initialTurn = sqlite.prepare('SELECT id FROM training_turns WHERE session_id = ? AND turn_number = 1').get(base.sessionId) as { id: number };
    const source = sqlite.prepare('SELECT source_id, content_sha256 FROM training_scenario_evidence WHERE session_id = ? ORDER BY selection_index LIMIT 1').get(base.sessionId) as { source_id: string; content_sha256: string };
    const manifest = sqlite.prepare('SELECT evidence_manifest_sha256 FROM training_scenario_packs WHERE session_id = ?').get(base.sessionId) as { evidence_manifest_sha256: string };
    sqlite.prepare('UPDATE training_sessions SET current_turn = 2, updated_at = ? WHERE id = ?').run(now + 1, base.sessionId);
    sqlite.prepare(`INSERT INTO training_learner_revision_events (
      id, session_id, owner_user_id, revision_number, expected_revision, mutation_key,
      prior_turn_id, prior_turn_number, prior_statement, revised_statement, explanation,
      source_ids_json, evidence_manifest_sha256, validation_status, policy_revision, created_at
    ) VALUES ('evidence-model-revision', ?, 'learner-a', 1, 0, 'evidence-model-revision-key', ?, 1,
      'Initial learner observation.', 'Revised learner hypothesis.', 'The cited source narrows the claim.',
      ?, ?, 'UNVERIFIED', 'learner-revision-v1', ?)`)
      .run(base.sessionId, initialTurn.id, JSON.stringify([source.source_id]), manifest.evidence_manifest_sha256, now + 2);
    sqlite.prepare(`INSERT INTO training_turns (
      session_id, turn_number, student_message, ai_response,
      claim_clarity, evidence_use, reasoning_strength, consistency_score, relevance_score,
      tutor_action_type, learner_revision_event_id, learner_revision_number, created_at
    ) VALUES (?, 2, 'Revised learner hypothesis.', 'Accepted bounded follow-up.', 3, 3, 3, 3, 3,
      'ask_revision', 'evidence-model-revision', 1, ?)`)
      .run(base.sessionId, now + 3);
    sqlite.prepare('UPDATE training_sessions SET current_turn = 3, updated_at = ? WHERE id = ?').run(now + 4, base.sessionId);
    return { sqlite, env, base, source, now };
  }
  return { sqlite, env, base, source: null, now };
}

async function headers(env: Bindings, id: string) {
  const token = (await generateTokens({
    id, username: id, email: `${id}@example.test`, studentId: null, grade: null,
    role: 'student', createdAt: 1, lastLogin: null, isActive: true,
  }, env.JWT_SECRET)).accessToken;
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('Training evidence-model ledger', () => {
  it('projects one immutable learner observation and hypothesis with exact source identity and the consumed next action', async () => {
    const subject = await fixture();
    const response = await trainingRoute.request('/api/training/evidence-models', {
      method: 'GET', headers: await headers(subject.env, 'learner-a'),
    }, subject.env);

    expect(response.status).toBe(200);
    const projection = await response.json() as {
      status: string;
      records: Array<Record<string, unknown>>;
    };
    expect(projection).toMatchObject({
      status: 'AVAILABLE',
      records: [expect.objectContaining({
        eventId: 'evidence-model-revision',
        sessionId: subject.base.sessionId,
        revision: 1,
        model: { id: 'training-learner-revision', version: 'learner-revision-v1' },
        recordedAt: subject.now + 2,
        observation: { kind: 'LEARNER_OBSERVATION', statement: 'Initial learner observation.' },
        hypothesis: { kind: 'UNVERIFIED_LEARNER_HYPOTHESIS', statement: 'Revised learner hypothesis.' },
        causalRationale: {
          kind: 'LEARNER_UNVERIFIED_CAUSAL_RATIONALE',
          statement: 'The cited source narrows the claim.',
          validationStatus: 'UNVERIFIED',
        },
        confidence: 'UNKNOWN',
        validationStatus: 'UNVERIFIED',
        manifestSha256: expect.any(String),
        sources: [{ sourceId: subject.source!.source_id, contentSha256: subject.source!.content_sha256 }],
        alternatives: [
          { kind: 'LEARNER_OBSERVATION', statement: 'Initial learner observation.' },
          { kind: 'UNVERIFIED_LEARNER_HYPOTHESIS', statement: 'Revised learner hypothesis.' },
        ],
        nextAction: { status: 'CONSUMED', turnNumber: 2, tutorAction: 'ask_revision' },
      })],
    });
  });

  it('returns no record and UNKNOWN for a foreign learner', async () => {
    const subject = await fixture();
    const response = await trainingRoute.request('/api/training/evidence-models', {
      method: 'GET', headers: await headers(subject.env, 'learner-b'),
    }, subject.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'UNKNOWN', records: [] });
  });

  it('returns no record and UNKNOWN when the owner has made no correction', async () => {
    const subject = await fixture(false);
    const response = await trainingRoute.request('/api/training/evidence-models', {
      method: 'GET', headers: await headers(subject.env, 'learner-a'),
    }, subject.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'UNKNOWN', records: [] });
  });

  it('suppresses every owner ledger record while any held-out attempt is ARMED or IN_PROGRESS, then restores it after a terminal event', async () => {
    const subject = await fixture();
    const category = subject.sqlite.prepare('SELECT id FROM category_hierarchy WHERE is_active = 1 LIMIT 1').get() as { id: string };
    const other = await startTrainingSession(subject.env, 'learner-a', {
      category: category.id,
      difficulty: 'intermediate',
      mode: 'evidence',
      caseId: 'HH-INVEST-100B',
      evidenceQuery: 'seasonality safety demand',
      evidenceBookIds: ['SYNTHETIC-HH-DEMAND-EXAMPLE', 'SYNTHETIC-HH-OPERATIONS-EXAMPLE'],
      maxTurns: 3,
    });
    const otherSource = subject.sqlite.prepare('SELECT source_id FROM training_scenario_evidence WHERE session_id = ? ORDER BY selection_index LIMIT 1').get(other.sessionId) as { source_id: string };
    const otherManifest = subject.sqlite.prepare('SELECT evidence_manifest_sha256 FROM training_scenario_packs WHERE session_id = ?').get(other.sessionId) as { evidence_manifest_sha256: string };
    subject.sqlite.prepare(`INSERT INTO training_turns (
      session_id, turn_number, student_message, ai_response,
      claim_clarity, evidence_use, reasoning_strength, consistency_score, relevance_score, created_at
    ) VALUES (?, 1, 'Other observation.', 'Other response.', 3, 3, 3, 3, 3, ?)`)
      .run(other.sessionId, subject.now + 10);
    const otherPrior = subject.sqlite.prepare('SELECT id FROM training_turns WHERE session_id = ? AND turn_number = 1').get(other.sessionId) as { id: number };
    subject.sqlite.prepare('UPDATE training_sessions SET current_turn = 2, updated_at = ? WHERE id = ?').run(subject.now + 11, other.sessionId);
    subject.sqlite.prepare(`INSERT INTO training_learner_revision_events (
      id, session_id, owner_user_id, revision_number, expected_revision, mutation_key,
      prior_turn_id, prior_turn_number, prior_statement, revised_statement, explanation,
      source_ids_json, evidence_manifest_sha256, validation_status, policy_revision, created_at
    ) VALUES ('other-evidence-model-revision', ?, 'learner-a', 1, 0, 'other-evidence-model-revision-key', ?, 1,
      'Other observation.', 'Other revised hypothesis.', 'Other causal rationale.', ?, ?, 'UNVERIFIED', 'learner-revision-v1', ?)`)
      .run(other.sessionId, otherPrior.id, JSON.stringify([otherSource.source_id]), otherManifest.evidence_manifest_sha256, subject.now + 12);
    const initialTurn = subject.sqlite.prepare('SELECT id FROM training_turns WHERE session_id = ? AND turn_number = 1').get(subject.base.sessionId) as { id: number };
    subject.sqlite.prepare(`INSERT INTO training_interventions (
      id, session_id, owner_user_id, revision, expected_revision, mutation_key, action, reason, origin, prior_turn_id, created_at
    ) VALUES ('evidence-model-help', ?, 'learner-a', 1, 0, 'evidence-model-help-key', 'HELP', 'LEARNER_REQUEST', 'LEARNER', ?, ?)`)
      .run(subject.base.sessionId, initialTurn.id, subject.now + 5);
    subject.sqlite.prepare(`INSERT INTO training_support_responses (
      intervention_id, session_id, response, source_ids_json, diagnosis_snapshot, routing_json, policy_revision, created_at
    ) VALUES ('evidence-model-help', ?, 'Bounded support before the separate held-out attempt.', ?, 'fixture diagnosis', '{}', 'bounded-support-v1', ?)`)
      .run(subject.base.sessionId, JSON.stringify([subject.source!.source_id]), subject.now + 6);
    subject.sqlite.prepare('UPDATE training_sessions SET is_completed = 1, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(subject.now + 7, subject.now + 7, subject.base.sessionId);
    const armed = await armHeldOutAttempt(subject.env.DB, 'operator-a', {
      baseSessionId: subject.base.sessionId,
      ownerUserId: 'learner-a',
      opaqueVariantId: 'HH-V-IMMEDIATE-01',
      taskText: '[SYNTHETIC TEST TASK] N1 ledger must not disclose an armed M4 base.',
      mutationKey: 'evidence-model-heldout-arm',
    });

    const armedResponse = await trainingRoute.request('/api/training/evidence-models', {
      method: 'GET', headers: await headers(subject.env, 'learner-a'),
    }, subject.env);
    expect(armedResponse.status).toBe(200);
    expect(await armedResponse.json()).toEqual({ status: 'UNKNOWN', records: [] });

    await openHeldOutAttempt(subject.env.DB, 'learner-a', armed.attempt.id, {
      expectedRevision: 1,
      mutationKey: 'evidence-model-heldout-open',
    });
    const openResponse = await trainingRoute.request('/api/training/evidence-models', {
      method: 'GET', headers: await headers(subject.env, 'learner-a'),
    }, subject.env);
    expect(openResponse.status).toBe(200);
    expect(await openResponse.json()).toEqual({ status: 'UNKNOWN', records: [] });

    await stopHeldOutAttempt(subject.env.DB, 'learner-a', armed.attempt.id, {
      expectedRevision: 2,
      mutationKey: 'evidence-model-heldout-stop',
    });
    const terminalResponse = await trainingRoute.request('/api/training/evidence-models', {
      method: 'GET', headers: await headers(subject.env, 'learner-a'),
    }, subject.env);
    expect(terminalResponse.status).toBe(200);
    expect((await terminalResponse.json() as { status: string; records: Array<{ sessionId: string }> }).records)
      .toContainEqual(expect.objectContaining({ sessionId: other.sessionId }));
  });

  it('fails closed when a stored source hash has an invalid SHA-256 shape', async () => {
    const subject = await fixture();
    subject.sqlite.exec('DROP TRIGGER IF EXISTS training_scenario_evidence_bound_immutable_update');
    subject.sqlite.prepare('UPDATE training_scenario_evidence SET content_sha256 = ? WHERE session_id = ? AND source_id = ?')
      .run('malformed', subject.base.sessionId, subject.source!.source_id);

    const response = await trainingRoute.request('/api/training/evidence-models', {
      method: 'GET', headers: await headers(subject.env, 'learner-a'),
    }, subject.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'UNAVAILABLE', records: [] });
  });

  it('fails closed when the canonical stored source excerpt no longer matches its hash', async () => {
    const subject = await fixture();
    subject.sqlite.exec('DROP TRIGGER IF EXISTS training_scenario_evidence_bound_immutable_update');
    subject.sqlite.prepare('UPDATE training_scenario_evidence SET excerpt = ? WHERE session_id = ? AND source_id = ?')
      .run('tampered canonical source excerpt', subject.base.sessionId, subject.source!.source_id);

    const response = await trainingRoute.request('/api/training/evidence-models', {
      method: 'GET', headers: await headers(subject.env, 'learner-a'),
    }, subject.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'UNAVAILABLE', records: [] });
  });

  it('fails closed when a revision event manifest does not equal its session pack manifest', async () => {
    const subject = await fixture();
    subject.sqlite.exec('DROP TRIGGER IF EXISTS training_revision_immutable');
    subject.sqlite.prepare('UPDATE training_learner_revision_events SET evidence_manifest_sha256 = ? WHERE id = ?')
      .run('a'.repeat(64), 'evidence-model-revision');

    const response = await trainingRoute.request('/api/training/evidence-models', {
      method: 'GET', headers: await headers(subject.env, 'learner-a'),
    }, subject.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'UNAVAILABLE', records: [] });
  });

  it('renders source-backed ledger entries with text nodes and safe Training/history navigation', async () => {
    class Element {
      children: Element[] = [];
      textContent = '';
      className = '';
      type = '';
      hidden = false;
      dataset: Record<string, string> = {};
      innerHTML = '';
      classList = {
        add: () => undefined,
        toggle: () => undefined,
      };
      private readonly listeners = new Map<string, Array<() => unknown>>();

      constructor(readonly tagName: string) {}

      append(...nodes: Element[]) { this.children.push(...nodes); }
      appendChild(node: Element) { this.children.push(node); return node; }
      replaceChildren(...nodes: Element[]) { this.children = nodes; this.textContent = ''; }
      addEventListener(type: string, listener: () => unknown) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
      }
      async click() { await Promise.all((this.listeners.get('click') || []).map(listener => listener())); }
    }
    const ledger = new Element('section');
    const elements = new Map([['neural-wiki-evidence-model', ledger]]);
    const calls: Array<unknown[]> = [];
    const window = {
      SocraticAI: {
        State: {},
        getEl: (id: string) => elements.get(id) || null,
        setText: () => undefined,
        apiGet: async () => ({ status: 'UNKNOWN', records: [] }),
      },
      switchTab: async (...args: unknown[]) => { calls.push(['switchTab', ...args]); },
      resumeTrainingSession: async (...args: unknown[]) => { calls.push(['resumeTrainingSession', ...args]); },
      deleteSession: (...args: unknown[]) => { calls.push(['deleteSession', ...args]); },
    };
    const document = {
      createElement: (tag: string) => new Element(tag),
      getElementById: (id: string) => elements.get(id) || null,
    };
    const source = readFileSync('public/static/modules/neural-wiki.js', 'utf8')
      .replace(/^import .*$/gm, '')
      .replace(/\bexport\s+/g, '');
    const context = createContext({
      window, document, Map, Set, Number, String, Object, Error, Array,
      KnowledgeGraphViewer: class {},
    });
    runInContext(`const { State, getEl, setText, apiGet } = window.SocraticAI; ${source}`, context);
    const render = runInContext('renderEvidenceModelLedger', context) as (value: unknown) => void;
    render({
      status: 'AVAILABLE',
      records: [{
        eventId: 'record-1', sessionId: 'training-1', revision: 1,
        model: { id: 'training-learner-revision', version: 'learner-revision-v1' },
        recordedAt: 1_700_000_000_000,
        observation: { kind: 'LEARNER_OBSERVATION', statement: '<img src=x onerror=alert(1)>' },
        hypothesis: { kind: 'UNVERIFIED_LEARNER_HYPOTHESIS', statement: 'A revised boundary.' },
        causalRationale: {
          kind: 'LEARNER_UNVERIFIED_CAUSAL_RATIONALE',
          statement: 'Because the cited source narrows the causal claim.',
          validationStatus: 'UNVERIFIED',
        },
        sources: [{ sourceId: 'library:book:chunk', contentSha256: 'abc123' }],
        manifestSha256: 'manifest-1', confidence: 'UNKNOWN', validationStatus: 'UNVERIFIED',
        alternatives: [], nextAction: { status: 'PENDING', turnNumber: null, tutorAction: null },
      }],
    });

    const text = (node: Element): string => node.textContent + node.children.map(text).join('');
    const findButton = (node: Element, label: string): Element | undefined =>
      node.tagName === 'button' && node.textContent === label ? node : node.children.map(child => findButton(child, label)).find(Boolean);
    expect(text(ledger)).toContain('참조 그래프와 별도의 내 수정 가능한 근거 모델 기록');
    expect(text(ledger)).toContain('<img src=x onerror=alert(1)>');
    expect(text(ledger)).toContain('수정 이유 (학습자 작성 · 미검증)');
    expect(text(ledger)).toContain('Because the cited source narrows the causal claim.');
    expect(text(ledger)).toContain('UNKNOWN');
    expect(ledger.innerHTML).toBe('');
    const correct = findButton(ledger, '수정 기록 열기');
    const erase = findButton(ledger, '기록 삭제로 이동');
    expect(correct).toBeDefined();
    expect(erase).toBeDefined();
    await correct!.click();
    await erase!.click();
    expect(calls).toEqual([
      ['switchTab', 'training', { focusDestination: true }],
      ['resumeTrainingSession', 'training-1'],
      ['switchTab', 'history', { focusDestination: true }],
      ['deleteSession', 'training-1', '내 근거 모델 기록', 'training'],
    ]);
  });

  it('invalidates a late ledger response and clears private Neural Wiki DOM on an account transition', async () => {
    class Element {
      children: Element[] = [];
      textContent = '';
      className = '';
      value = '';
      innerHTML = '';
      classList = {
        add: () => undefined,
        toggle: () => undefined,
      };

      constructor(readonly tagName: string) {}

      append(...nodes: Element[]) { this.children.push(...nodes); }
      appendChild(node: Element) { this.children.push(node); return node; }
      replaceChildren(...nodes: Element[]) { this.children = nodes; this.textContent = ''; }
    }
    const ledger = new Element('section');
    const graph = new Element('section');
    graph.textContent = 'prior learner graph';
    const selected = new Element('section');
    selected.textContent = 'prior learner selection';
    const selectedTitle = new Element('h3');
    const selectedDescription = new Element('p');
    const selectedEssence = new Element('p');
    const selectedEstimate = new Element('span');
    const selectedTaiji = new Element('p');
    const elements = new Map([
      ['neural-wiki-evidence-model', ledger],
      ['neural-wiki-graph', graph],
      ['neural-wiki-selected', selected],
      ['neural-wiki-node-title', selectedTitle],
      ['neural-wiki-node-description', selectedDescription],
      ['neural-wiki-node-essence', selectedEssence],
      ['neural-wiki-node-mastery', selectedEstimate],
      ['neural-wiki-taiji-status', selectedTaiji],
      ['neural-wiki-loading', new Element('section')],
      ['neural-wiki-empty', new Element('section')],
      ['neural-wiki-unavailable', new Element('section')],
      ['neural-wiki-domain', new Element('select')],
    ]);
    let resolveProjection: ((value: unknown) => void) | undefined;
    const pendingProjection = new Promise<unknown>((resolve) => { resolveProjection = resolve; });
    let resolveGraph: (() => void) | undefined;
    const pendingGraph = new Promise<void>((resolve) => { resolveGraph = resolve; });
    const window = {
      SocraticAI: {
        State: { isSessionActive: false, sessionId: null },
        getEl: (id: string) => elements.get(id) || null,
        setText: (id: string, value: string) => { const element = elements.get(id); if (element) element.textContent = value; },
        apiGet: () => pendingProjection,
      },
      innerWidth: 1024,
      matchMedia: () => ({ matches: false }),
    } as Record<string, unknown>;
    const document = {
      createElement: (tag: string) => new Element(tag),
      getElementById: (id: string) => elements.get(id) || null,
      querySelectorAll: () => [],
    };
    class Viewer {
      constructor(private readonly config: { isCurrent: () => boolean }) {}
      async mount() {
        await pendingGraph;
        if (this.config.isCurrent()) graph.textContent = 'late private graph';
      }
      getGraphData() { return null; }
    }
    const source = readFileSync('public/static/modules/neural-wiki.js', 'utf8')
      .replace(/^import .*$/gm, '')
      .replace(/\bexport\s+/g, '');
    const context = createContext({
      window, document, Map, Set, Number, String, Object, Error, Array, Promise,
      KnowledgeGraphViewer: Viewer,
      localStorage: { getItem: () => null, removeItem: () => undefined },
      sessionStorage: { length: 0, key: () => null, removeItem: () => undefined },
    });
    runInContext(`const { State, getEl, setText, apiGet } = window.SocraticAI; ${source}`, context);
    const load = runInContext('loadNeuralWiki', context) as () => Promise<void>;
    const loadPromise = load();
    const stateSource = readFileSync('public/static/modules/state.js', 'utf8')
      .replace(/\bexport\s+/g, '');
    runInContext(`(() => { ${stateSource}; window.__resetPrivateLearningState = resetPrivateLearningState; })()`, context);
    runInContext('window.__resetPrivateLearningState()', context);
    resolveProjection!({
      status: 'AVAILABLE',
      records: [{ eventId: 'late-private-record', sessionId: 'other-owner-session' }],
    });
    resolveGraph!();
    await loadPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ledger.children).toEqual([]);
    expect(graph.children).toEqual([]);
    expect(graph.textContent).toBe('');
    expect(selectedTitle.textContent).toBe('그래프에서 개념을 선택하세요.');
    expect(selectedEstimate.textContent).toContain('검증되지 않은 모델 추정치');
    const viewerSource = readFileSync('public/static/modules/components/knowledge-graph-viewer.js', 'utf8');
    expect(viewerSource).toContain('if (!this.isCurrent()) return;');
    expect(viewerSource).toContain('isCurrent: () => this.isCurrent()');
    expect(readFileSync('public/static/modules/neural-wiki-graph.js', 'utf8')).toContain('if (options.isCurrent?.() === false) return;');
  });

  it('uses explicit unvalidated learner-model wording in the selected-node label, graph legend, and tooltip', () => {
    const markup = readFileSync('public/index.html', 'utf8');
    const graphSource = readFileSync('public/static/modules/neural-wiki-graph.js', 'utf8');
    const moduleSource = readFileSync('public/static/modules/neural-wiki.js', 'utf8');

    expect(markup).toContain('학습 모델 추정치 (검증되지 않음): <span id="neural-wiki-node-mastery">');
    expect(graphSource).toContain('학습 모델 추정치 (검증되지 않음): ${d.mastery === null');
    expect(graphSource).toContain(".text('학습 모델 추정치 (검증되지 않음)')");
    expect(graphSource).not.toContain(".text('숙련도 범례')");
    expect(moduleSource).toContain('검증되지 않은 모델 추정치');
  });
});
