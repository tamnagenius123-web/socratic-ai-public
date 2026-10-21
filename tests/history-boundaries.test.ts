import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createSession, getAllSessions, getSession } from '../src/services/student-model';
import { getEmbeddings, ingestBookToVectorize } from '../src/services/rag-ingestion';
import { createMigratedLearningDatabase } from './fixtures/learning-engine-db';

afterEach(() => vi.unstubAllGlobals());

describe('browser API account boundaries', () => {
  function harness(fetch: (path: string, options?: RequestInit) => Promise<Response>) {
    const State = { authEpoch: 0, user: { id: 'learner-a' }, accessToken: 'token-a', refreshToken: 'refresh-a' };
    const stored = new Map<string, string>();
    const context = createContext({ State, fetch, Response, Error, console,
      localStorage: { setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
      window: {}, document: { getElementById: () => null },
      resetPrivateLearningState: () => { State.authEpoch += 1; },
    });
    const source = readFileSync('public/static/modules/utils.js', 'utf8')
      .replace(/^import .*$/gm, '').replace(/\bexport /g, '');
    runInContext(source + '\nglobalThis.testApi = { apiGet, tryRefreshToken };', context);
    const api = context.testApi as { apiGet: (path: string) => Promise<unknown>; tryRefreshToken: () => Promise<boolean> };
    const switchAccount = () => { State.authEpoch += 1; State.user = { id: 'learner-b' }; State.accessToken = 'token-b'; State.refreshToken = 'refresh-b'; };
    return { State, stored, api, switchAccount };
  }

  it.each([200, 401])('rejects an old %i response without discarding the newer identity', async status => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const h = harness(fetch);
    const pending = h.api.apiGet('/private');
    h.switchAccount();
    release(Response.json({ privateText: 'learner-a' }, { status }));
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED', status: 409, payload: null });
    expect(h.State).toMatchObject({ user: { id: 'learner-b' }, accessToken: 'token-b', refreshToken: 'refresh-b' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('withholds a body decoded after the account changes', async () => {
    let releaseBody!: () => void;
    const bodyReady = new Promise<void>(resolve => { releaseBody = resolve; });
    let decoding!: () => void;
    const started = new Promise<void>(resolve => { decoding = resolve; });
    const response = Response.json({ privateText: 'learner-a' });
    const decode = response.json.bind(response);
    response.json = async <T>() => { decoding(); await bodyReady; return await decode() as T; };
    const h = harness(async () => response);
    const pending = h.api.apiGet('/private');
    await started;
    h.switchAccount();
    releaseBody();
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED', payload: null });
  });

  it('does not persist an old refresh identity after a new account takes over', async () => {
    let release!: (response: Response) => void;
    let reachedIdentity!: () => void;
    const identityStarted = new Promise<void>(resolve => { reachedIdentity = resolve; });
    const h = harness(async path => {
      if (path === '/api/auth/refresh') return Response.json({ accessToken: 'old-new-token', refreshToken: 'old-next-refresh' });
      reachedIdentity();
      return new Promise<Response>(resolve => { release = resolve; });
    });
    const pending = h.api.tryRefreshToken();
    await identityStarted;
    h.switchAccount();
    release(Response.json({ user: { id: 'learner-a' } }));
    expect(await pending).toBe(false);
    expect(h.State.accessToken).toBe('token-b');
    expect(h.stored.size).toBe(0);
  });

  it('refuses a refresh that resolves to another owner in the same epoch', async () => {
    const h = harness(async path => path === '/api/auth/refresh'
      ? Response.json({ accessToken: 'new-token', refreshToken: 'new-refresh' })
      : Response.json({ user: { id: 'another-owner' } }));
    expect(await h.api.tryRefreshToken()).toBe(false);
    expect(h.State.user.id).toBe('learner-a');
    expect(h.stored.size).toBe(0);
  });

  it('still refreshes and retries for the same current identity', async () => {
    const paths: string[] = [];
    const h = harness(async (path, options) => {
      paths.push(path);
      if (path === '/api/auth/refresh') return Response.json({ accessToken: 'new-token', refreshToken: 'new-refresh' });
      if (path === '/api/auth/me') return Response.json({ user: { id: 'learner-a' } });
      if (paths.length === 1) return Response.json({ error: 'expired' }, { status: 401 });
      expect(options?.headers).toMatchObject({ Authorization: 'Bearer [REDACTED]' });
      return Response.json({ owner: 'learner-a' });
    });
    expect(await h.api.apiGet('/private')).toEqual({ owner: 'learner-a' });
    expect(paths).toEqual(['/private', '/api/auth/refresh', '/api/auth/me', '/private']);
    expect(h.stored.get('sat_access')).toBe('new-token');
  });
});

describe('persisted history boundaries', () => {
  it('renders linked Training supplements instead of claiming they are absent', async () => {
    class Element {
      innerHTML = '';
      inserted: string[] = [];
      style = { display: 'none' };
      parentElement: Element | null = null;
      classList = { add: () => undefined, remove: () => undefined };
      inert = false;
      isConnected = true;
      focus() {}
      closest() { return null; }
      replaceChildren() { this.innerHTML = ''; this.inserted = []; }
      insertAdjacentHTML(_position: string, html: string) { this.inserted.push(html); }
    }
    const detailBody = new Element();
    const dialog = new Element();
    const title = new Element();
    const elements = new Map([['history-detail-body', detailBody], ['history-detail-modal', dialog], ['history-detail-title', title]]);
    const escape = (value: unknown) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    const payload = {
      messages: [
        { role: 'student', content: 'Original learner answer', turn: 1, timestamp: 1 },
        { role: 'assistant', content: 'App response', turn: 1, timestamp: 2 },
        { role: 'student', content: 'Follow-up learner answer', turn: 2, timestamp: 3 },
      ],
      trainingHistory: {
        status: 'AVAILABLE',
        controls: { status: 'AVAILABLE', records: [{ action: 'STOP', reason: 'TIME_LIMIT', origin: 'LEARNER', revision: 4, timestamp: 4 }] },
        support: { status: 'AVAILABLE', records: [{
          interventionId: 'help-1', priorTurn: { id: 10, turnNumber: 1 }, answerTurn: { id: 11, turnNumber: 2 }, createdAt: 2,
          response: '<script>app support</script>', graded: false, deliveryValidation: 'UNKNOWN', readingValidation: 'UNKNOWN',
          sourceIds: ['source-1'], sourceSnapshots: [{ sourceId: 'source-1', excerpt: '<b>saved evidence</b>', contentSha256: 'abc' }],
        }] },
        revisions: { status: 'AVAILABLE', explicitDefenseStatus: 'NOT_RECORDED', records: [{
          priorTurn: { id: 10, turnNumber: 1 }, priorStatement: 'Original learner answer', revisedStatement: 'Learner revision', explanation: 'Learner explanation',
          sourceIds: ['source-1'], createdAt: 3, validationStatus: 'UNVERIFIED', consumedFollowUpTurn: { id: 11, turnNumber: 2 },
        }] },
      },
    };
    const window = { SocraticAI: { State: {}, getEl: (id: string) => elements.get(id) || null, setDisplay: (id: string, display: string) => { const element = elements.get(id); if (element) element.style.display = display; }, setText: () => undefined, api: () => undefined, apiGet: async () => payload, apiDelete: () => undefined, showToast: () => undefined, esc: escape, escapeAttribute: escape } };
    const document = { activeElement: null, addEventListener: () => undefined, documentElement: new Element(), body: new Element(), getElementById: (id: string) => elements.get(id) || null };
    const source = readFileSync('public/static/modules/history.js', 'utf8');
    const context = createContext({ window, document, HTMLElement: Element, Map, Set, Number, String, Date, Object, Error });
    runInContext(source, context);
    await (window as unknown as { viewHistoryDetail: (id: string, type: string) => Promise<void> }).viewHistoryDetail('training-1', 'training');

    const html = detailBody.innerHTML + detailBody.inserted.join('');
    expect(html).not.toContain('별도로 저장된 도움과 수정 내역이 포함되지 않습니다');
    expect(html).toContain('앱이 저장한 도움 · 채점 제외');
    expect(html).toContain('실제 열람 여부는 확인되지 않음');
    expect(html).toContain('내 생각 수정 · 검증되지 않음');
    expect(html).toContain('history-turn-2');
    expect(html).toContain('내 선택으로 종료 · 실패로 평가하지 않음');
    expect(html).toContain('&lt;script&gt;app support&lt;/script&gt;');
    expect(html).not.toContain('<script>app support</script>');
    expect(html).toContain('명시적으로 주장을 유지한다는 기록은 현재 저장되지 않았습니다');

    payload.trainingHistory.status = 'UNAVAILABLE';
    payload.trainingHistory.revisions.status = 'UNAVAILABLE';
    payload.trainingHistory.revisions.explicitDefenseStatus = 'NOT_RECORDED';
    payload.trainingHistory.revisions.records = [];
    detailBody.inserted = [];
    await (window as unknown as { viewHistoryDetail: (id: string, type: string) => Promise<void> }).viewHistoryDetail('training-1', 'training');
    const unavailableHtml = detailBody.innerHTML + detailBody.inserted.join('');
    expect(unavailableHtml).toContain('훈련의 도움·수정·제어 기록 일부를 현재 불러올 수 없습니다. 기록이 없다는 뜻은 아닙니다.');
    expect(unavailableHtml).not.toContain('명시적으로 주장을 유지한다는 기록은 현재 저장되지 않았습니다');
  });

  it('reads legacy and modern phase values and numeric message timestamps without rewriting sessions', async () => {
    const { sqlite, db } = createMigratedLearningDatabase();
    try {
      sqlite.exec("INSERT INTO books (id,title,author,text) VALUES ('history-book','History','Fixture','A source')");
      const created = await createSession(db, 'history-book', 'History', '', 'A topic', 'A claim');
      expect(created.currentPhase).toBe('thesis');
      expect(created.rating).toBe('UNKNOWN');
      expect(JSON.parse(created.thoughtProfileJson)).toEqual({});
      expect(JSON.parse(created.challengeStateJson)).toMatchObject({ currentLevel: 1, history: [] });
      sqlite.prepare('INSERT INTO messages (session_id,role,content,turn,timestamp) VALUES (?, ?, ?, ?, ?)')
        .run(created.id, 'user', 'Saved answer', 1, 123456);
      for (const phase of ['thesis', 'opening', 'defense', 'conclusion', 'elicitation', 'grounding', 'reasoning', 'counterexample', 'revision', 'synthesis']) {
        sqlite.prepare('UPDATE sessions SET current_phase=? WHERE id=?').run(phase, created.id);
        const before = sqlite.prepare('SELECT * FROM sessions WHERE id=?').get(created.id);
        const session = await getSession(db, created.id);
        expect(session?.currentPhase).toBe(phase);
        expect(session?.conversationHistory).toEqual([{ role: 'user', content: 'Saved answer', turn: 1, timestamp: 123456 }]);
        expect((await getAllSessions(db))[0].currentPhase).toBe(phase);
        expect(sqlite.prepare('SELECT * FROM sessions WHERE id=?').get(created.id)).toEqual(before);
      }
    } finally { sqlite.close(); }
  });
});

describe('embedding response boundary', () => {
  it('preserves valid finite vectors and the requested input payload', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ embedding: [0, -0.4, 0.9] }, { embedding: [0.1, 0.2, 0.3] }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await getEmbeddings(['first', 'second'], 'fixture-only')).toEqual([[0, -0.4, 0.9], [0.1, 0.2, 0.3]]);
    const request = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(request.body))).toMatchObject({ input: ['first', 'second'] });
  });

  it.each([null, {}, { data: [] }, { data: [{ embedding: [] }] }, { data: [{ embedding: ['0.5'] }] }, { data: [{ embedding: [null] }] }])
    ('rejects malformed or incomplete vectors before any upload: %j', async payload => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)));
      const upsert = vi.fn();
      const index = { upsert } as unknown as VectorizeIndex;
      await expect(ingestBookToVectorize(index, 'book', 'A single short passage.', 'fixture-only'))
        .rejects.toThrow('Invalid embedding response');
      expect(upsert).not.toHaveBeenCalled();
    });
});
