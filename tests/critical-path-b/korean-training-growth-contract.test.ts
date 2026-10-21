import { existsSync, readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const PLAN_SHA256 = 'e4aca90670bebe7adcee106d4df2d63ef6ec01ca476faab4029fd9ba59869756';
const SPEC_SHA256 = '132454449036677bbc39678bbf5a31f7f2fd0990860e59a9bcd7b2aef237c59f';

const COPY_KEYS = [
  'trainingGrowthCta',
  'purposeConsent',
  'retention',
  'optOutBeforeConsent',
  'revocation',
  'contest',
  'correction',
  'humanReviewPending',
  'gapUnknown',
  'focus',
  'practice',
  'recheckUnknown',
  'delete',
  'uncertainty',
] as const;

const PROTOCOL_IDS = [
  'GAP_UNKNOWN',
  'UNKNOWN',
  'RECHECK_SCHEDULED',
  'TRAINING',
  'EVIDENCE_HINT_UNAVAILABLE',
] as const;

function source(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

type HarnessCall = {
  type: 'api' | 'apiGet';
  path: string;
  body?: Record<string, unknown>;
};

type HarnessWindow = {
  startTrainingFollowUp: (launch:Record<string,unknown>) => void;
  seedTrainingEvidenceBook: (id:string) => void;
  resetTrainingUI: () => void;
  loadTrainingCaseCatalog: () => Promise<boolean>;
  startTrainingCase: (caseId: string) => Promise<void>;
  setTrainingMode: (mode: string) => void;
  updateTrainingEvidenceQuery: () => void;
  updateTrainingTurns: () => void;
  selectTrainingCategory: (category: string) => void;
  selectTrainingDifficulty: (difficulty: string) => void;
  startTraining: () => Promise<void>;
  resumeTrainingSession: (sessionId: string) => Promise<void>;
  requestTrainingHint: () => Promise<void>;
  submitTrainingMessage: () => Promise<void>;
};

class HintControlElement {
  readonly id: string;
  children: HintControlElement[] = [];
  parent: HintControlElement | null = null;
  listeners = new Map<string, (...args: unknown[]) => unknown>();
  async click(): Promise<void> { if (!this.disabled) await this.listeners.get('click')?.(); }
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly classList = { toggle: (_className: string, _selected: boolean) => undefined };
  disabled = false;
  hidden = false;
  textContent = '';
  innerHTML = '';
  value = '';
  scrollTop = 0;
  scrollHeight = 0;

  constructor(id: string) {
    this.id = id;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelectorAll(_selector: string): HintControlElement[] {
    return [];
  }

  querySelector(_selector: string): HintControlElement | null {
    return null;
  }

  appendChild(child: HintControlElement): void { this.append(child); }
  append(...children: HintControlElement[]): void { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } }
  prepend(...children: HintControlElement[]): void { for (const child of [...children].reverse()) { child.remove(); child.parent = this; this.children.unshift(child); } }
  replaceChildren(...children: HintControlElement[]): void { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
  addEventListener(event: string, listener: (...args: unknown[]) => unknown): void { this.listeners.set(event, listener); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
}

function createTrainingHarness(
  session: Record<string, unknown>,
  startResponse: Record<string, unknown> = { sessionId: 'started-session', mode: 'constructed' },
  recovery: { grounding?: Record<string, unknown>; controlUnavailable?: boolean; read?: (path: string) => Promise<Record<string, unknown> | undefined>; write?: (path: string) => Promise<Record<string, unknown> | undefined> } = {},
) {
  const elements = new Map<string, HintControlElement>();
  const calls: HarnessCall[] = [];
  const toasts: Array<{ message: string; type: string }> = [];
  const getEl = (id: string): HintControlElement => {
    const find = (node: HintControlElement): HintControlElement | undefined => node.children.find(child => child.id === id) || node.children.map(find).find(Boolean);
    const attached = [...elements.values()].map(find).find(Boolean);
    if (attached) return attached;
    const existing = elements.get(id);
    if (existing) return existing;
    const created = new HintControlElement(id);
    elements.set(id, created);
    return created;
  };
  const api = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    calls.push({ type: 'api', path, body });
    const override=await recovery.write?.(path);if(override)return override;
    if (path === '/api/training/hint') return { hintLevel: 1, hintMessage: 'fixture hint' };
    if (path === '/api/training/start') return startResponse;
    if (path.endsWith('/interventions')) return {state:body.action==='STOP'?'STOPPED':'PAUSED',revision:1,latest:null,history:[]};
    return {};
  };
  const apiGet = async (path: string): Promise<Record<string, unknown>> => {
    calls.push({ type: 'apiGet', path });
    const override=await recovery.read?.(path); if(override) return override;
    if (path.endsWith('/interventions')) { if(recovery.controlUnavailable) throw new Error('offline control read'); return { state: 'ACTIVE', revision: 0, latest: null, history: [] }; }
    if (path.endsWith('/revisions')) return { revision: 0, pending: null, history: [] };
    if (path.startsWith('/api/training/session/')) {
      return { session, grounding: recovery.grounding, messages: [], turns: [], attributions: [] };
    }
    if (path === '/api/books') return { books: [] };
    if (path === '/api/training/sessions') return { sessions: [] };
    return {};
  };
  const SocraticAI = {
    State: {},
    getEl,
    setDisplay: (id: string, display: string) => { getEl(id).style.display = display; },
    api,
    apiGet,
    showToast: (message: string, type: string) => { toasts.push({ message, type }); },
    esc: (value: unknown) => String(value),
    isAuthExpiryScreenVisible: () => false,
    focusLoginAfterAuthExpiry: () => undefined,
    KOREAN_JOURNEY_COPY: {
      uncertainty: { evidenceHintReason: '근거 기반 훈련에서는 힌트를 사용할 수 없습니다.' },
    },
  };
  const windowObject: { SocraticAI: typeof SocraticAI; [key: string]: unknown } = { SocraticAI };
  const documentObject = {
    querySelectorAll: (_selector: string): HintControlElement[] => [],
    querySelector: (_selector: string): HintControlElement | null => null,
    createElement: (tag: string): HintControlElement => new HintControlElement(tag),
  };
  const context = createContext({ window: windowObject, document: documentObject, console, CSS: { escape: (value: string) => value }, crypto: {randomUUID:()=> 'fixture-control-key'} });
  runInContext(source('public/static/modules/training.js'), context);
  getEl('training-hint-btn');
  getEl('training-hint-unavailable-reason');
  return {
    window: windowObject as unknown as HarnessWindow,
    elements,
    calls,
    toasts,
  };
}

function harnessElement(
  harness: ReturnType<typeof createTrainingHarness>,
  id: string,
): HintControlElement {
  const element = harness.elements.get(id);
  if (!element) throw new Error(`Missing harness element: ${id}`);
  return element;
}

async function startConstructedSelection(
  harness: ReturnType<typeof createTrainingHarness>,
): Promise<void> {
  harness.window.setTrainingMode('constructed');
  harnessElement(harness, 'training-constructed-max-turns').value = '6';
  harness.window.selectTrainingCategory('policy');
  harness.window.selectTrainingDifficulty('beginner');
  await harness.window.startTraining();
}

describe('Critical Path B Delivery 3 Step 3 — Korean Training to Growth RED', () => {
  it('starts the Korean first-case browser entry with the server-catalogued canonical caseId', async () => {
    const harness = createTrainingHarness({ id: 'first-case-session', mode: 'evidence' }, {
      sessionId: 'first-case-session', mode: 'evidence', title: '하늘항 테마파크 1000억 원 투자 판단', maxTurns: 8,
    }, {
      read: async (path) => {
        if (path === '/api/training/cases') {
          return {
            cases: [{
              caseId: 'HH-INVEST-100B', title: '하늘항 테마파크 1000억 원 투자 판단',
              summary: '공개 출처 유추 자료를 구분하는 한국어 첫 사례', category: 'business', difficulty: 'intermediate',
              mode: 'evidence', defaultMaxTurns: 8,
            }],
          };
        }
        if (path === '/api/books') return { books: [{ id: 'SYNTHETIC-HH-DEMAND-EXAMPLE', chunkCount: 2 }, { id: 'SYNTHETIC-HH-OPERATIONS-EXAMPLE', chunkCount: 1 }] };
        return undefined;
      },
    });

    await harness.window.startTrainingCase('HH-INVEST-100B');

    expect(harness.calls.find((call) => call.type === 'apiGet' && call.path === '/api/training/cases')).toBeDefined();
    expect(harness.calls.find((call) => call.type === 'api' && call.path === '/api/training/start')?.body).toMatchObject({
      caseId: 'HH-INVEST-100B', category: 'business', difficulty: 'intermediate', mode: 'evidence', maxTurns: 8,
    });
  });

  it('clears a failed case selection before the learner starts a generic evidence Training session', async () => {
    let firstStart = true;
    const harness = createTrainingHarness({ id: 'generic-after-failure', mode: 'evidence' }, {
      sessionId: 'generic-after-failure', mode: 'evidence', caseContractStatus: 'not_applicable', maxTurns: 6,
    }, {
      read: async (path) => {
        if (path === '/api/training/cases') return { cases: [{
          caseId: 'HH-INVEST-100B', title: '하늘항 테마파크 1000억 원 투자 판단', summary: '공개 출처 유추 자료',
          category: 'business', difficulty: 'intermediate', mode: 'evidence', defaultMaxTurns: 8,
        }] };
        if (path === '/api/books') return { books: [{ id: 'book-a', chunkCount: 2 }, { id: 'book-b', chunkCount: 1 }] };
        return undefined;
      },
      write: async (path) => {
        if (path === '/api/training/start' && firstStart) {
          firstStart = false;
          throw new Error('case source unavailable');
        }
        return undefined;
      },
    });

    await harness.window.startTrainingCase('HH-INVEST-100B');
    harness.window.setTrainingMode('evidence');
    harnessElement(harness, 'training-evidence-query').value = 'generic policy evidence';
    harness.window.updateTrainingEvidenceQuery();
    harness.window.seedTrainingEvidenceBook('book-a');
    harness.window.seedTrainingEvidenceBook('book-b');
    harness.window.selectTrainingCategory('business');
    harness.window.selectTrainingDifficulty('beginner');
    harnessElement(harness, 'training-evidence-max-turns').value = '6';
    harness.window.updateTrainingTurns();
    await harness.window.startTraining();

    const starts = harness.calls.filter((call) => call.type === 'api' && call.path === '/api/training/start');
    expect(starts).toHaveLength(2);
    expect(starts[0].body).toMatchObject({ caseId: 'HH-INVEST-100B' });
    expect(starts[1].body).toMatchObject({ mode: 'evidence', category: 'business', difficulty: 'beginner', maxTurns: 6 });
    expect(starts[1].body).not.toHaveProperty('caseId');
  });

  it.each(['PREDECLARED_LOCAL', 'NOT_PREDECLARED', 'UNAVAILABLE'])('shows the server protocol before starting and after resuming: %s', async status => {
    const launch = { launchId: 'launch-a', cycleId: 'cycle-a', spaceId: 'space-a', changedCondition: 'A different causal condition', protocol: { status } };
    const harness = createTrainingHarness({ id: 'follow-up', mode: 'evidence' }, undefined, { read: async path => path === '/api/training/session/follow-up'
      ? { session: { id: 'follow-up', mode: 'evidence' }, growthFollowUp: launch, grounding: { status: 'ready' }, turns: [], messages: [] } : undefined });
    const expected = status === 'PREDECLARED_LOCAL' ? '시작 전에 정한 앱 내 기록 범위' : status === 'NOT_PREDECLARED' ? '사전 선언으로 간주하지 않습니다' : '기록 정책을 확인할 수 없습니다';
    const noticeText = (container: string) => harnessElement(harness, container).children.find(node => node.id === 'training-follow-up-notice')?.children.map(node => node.textContent).join(' ');
    harness.window.startTrainingFollowUp(launch);
    expect(noticeText('training-selection')).toContain(expected);
    expect(noticeText('training-selection')).toContain('앱 밖의 도움');
    await harness.window.resumeTrainingSession('follow-up');
    expect(noticeText('training-question-card')).toContain(expected);
    expect(noticeText('training-question-card')).toContain('UNKNOWN');
  });

  it('preserves the opaque follow-up launch in Training start and clears it for an unrelated new task', async () => {
    const harness=createTrainingHarness({id:'a'}, { sessionId:'started-session',mode:'evidence',growthFollowUp:{launchId:'launch-a',changedCondition:'Server-confirmed condition',protocol:{status:'PREDECLARED_LOCAL'}} },{read:async path=>path==='/api/books'?{books:[{id:'a',chunkCount:1},{id:'b',chunkCount:1}]}:undefined});
    harness.window.startTrainingFollowUp({launchId:'launch-a',cycleId:'cycle-a',spaceId:'space-a',changedCondition:'A different causal condition'});
    await Promise.resolve();await Promise.resolve();
    harness.window.setTrainingMode('constructed');
    harness.window.selectTrainingCategory('policy');harness.window.selectTrainingDifficulty('beginner');
    harnessElement(harness,'training-evidence-query').value='policy evidence';harnessElement(harness,'training-evidence-max-turns').value='1';
    await harness.window.startTraining();
    const started=harness.calls.find(call=>call.path==='/api/training/start');
    expect(started?.body).toMatchObject({mode:'evidence',growthFollowUpLaunchId:'launch-a'});
    const notice = harnessElement(harness,'training-question-card').children.find(node=>node.id==='training-follow-up-notice');
    expect(notice?.children.map(node=>node.textContent).join(' ')).toContain('Server-confirmed condition');
    expect(notice?.children.map(node=>node.textContent).join(' ')).not.toContain('A different causal condition');
    expect(harnessElement(harness,'training-selection').children.some(node=>node.id==='training-follow-up-notice')).toBe(false);
    await harness.window.resumeTrainingSession('a');
    expect(harnessElement(harness,'training-question-card').children.some(node=>node.id==='training-follow-up-notice')).toBe(false);
    harness.window.resetTrainingUI();await startConstructedSelection(harness);
    expect(harness.calls.filter(call=>call.path==='/api/training/start').at(-1)?.body).not.toHaveProperty('growthFollowUpLaunchId');
  });

  it('does not let a control read started during STOP overwrite its terminal response', async () => {
    let finishStop!: (value: Record<string, unknown>) => void;
    let finishRead!: (value: Record<string, unknown>) => void;
    let readStarted!: () => void;
    const stopWaiting=new Promise<Record<string, unknown>>(resolve=>{finishStop=resolve;});
    const readWaiting=new Promise<Record<string, unknown>>(resolve=>{finishRead=resolve;});
    const started=new Promise<void>(resolve=>{readStarted=resolve;});
    let reads=0;
    const recovery={grounding:{status:'unavailable'},write:async(path:string)=>path.endsWith('/interventions')?stopWaiting:undefined,
      read:async(path:string)=>{if(path.endsWith('/interventions') && ++reads>1){readStarted();return readWaiting;}}};
    const harness=createTrainingHarness({id:'session-a',mode:'evidence',is_completed:0},undefined,recovery);
    await harness.window.resumeTrainingSession('session-a');
    const descendants=(node:HintControlElement):HintControlElement[]=>[node,...node.children.flatMap(descendants)];
    const stop=descendants(harnessElement(harness,'training-control-panel')).find(node=>node.dataset.controlAction==='STOP')!;
    const stopping=stop.click();
    recovery.grounding={status:'ready'};
    const retry=harnessElement(harness,'training-grounding').children.find(node=>node.textContent==='근거 상태 다시 확인')!;
    const retrying=retry.click();await started;
    finishStop({state:'STOPPED',revision:1,latest:null,history:[]});await stopping;
    finishRead({state:'ACTIVE',revision:0,latest:null,history:[]});await retrying;
    expect(harnessElement(harness,'training-submit-btn').disabled).toBe(true);
    expect(descendants(harnessElement(harness,'training-control-panel')).find(node=>node.dataset.controlAction==='STOP')?.disabled).toBe(true);
  });

  it('does not let a delayed start overwrite a newer saved-session selection or issue a duplicate start', async () => {
    let finish!: (value: Record<string, unknown>) => void;
    const waiting=new Promise<Record<string, unknown>>(resolve=>{finish=resolve;});
    const harness=createTrainingHarness({id:'session-b',mode:'constructed',question_title:'Saved B',is_completed:0},undefined,{write:async path=>path==='/api/training/start'?waiting:undefined});
    const starting=startConstructedSelection(harness);
    await harness.window.startTraining();
    expect(harness.calls.filter(call=>call.path==='/api/training/start')).toHaveLength(1);
    await harness.window.resumeTrainingSession('session-b');
    finish({sessionId:'late-start',mode:'constructed',title:'Late start',maxTurns:6});await starting;
    expect(harnessElement(harness,'training-q-title').textContent).toBe('Saved B');
    await harness.window.requestTrainingHint();
    expect(harness.calls.findLast(call=>call.path==='/api/training/hint')?.body?.sessionId).toBe('session-b');
  });

  it('keeps generation blocked while the saved control read is pending', async () => {
    let finish!: (value: Record<string, unknown>) => void;
    let readStarted!: () => void;
    const started=new Promise<void>(resolve=>{readStarted=resolve;});
    const waiting=new Promise<Record<string, unknown>>(resolve=>{finish=resolve;});
    const harness=createTrainingHarness({id:'paused-history',mode:'constructed',is_completed:0},undefined,{read:async path=>{if(path.endsWith('/interventions')){readStarted();return waiting;}}});
    const opening=harness.window.resumeTrainingSession('paused-history');
    await started;
    expect(harnessElement(harness,'training-input').disabled).toBe(true);
    harnessElement(harness,'training-input').value='Do not send while status is unknown';
    await harness.window.submitTrainingMessage();
    expect(harness.calls.some(call=>call.path==='/api/training/chat')).toBe(false);
    finish({state:'PAUSED',revision:1,history:[]});await opening;
    expect(harnessElement(harness,'training-input').disabled).toBe(true);
  });

  it.each(['late-success','late-failure'])('keeps the newer history selection after %s from an earlier request', async failure => {
    let finish!: (value: Record<string, unknown>) => void;let reject!: (error: Error) => void;
    const slow=new Promise<Record<string, unknown>>((resolve,no)=>{finish=resolve;reject=no;});
    const harness=createTrainingHarness({id:'session-b',mode:'constructed',question_title:'B remains selected',is_completed:0},undefined,{read:async path=>path==='/api/training/session/session-a'?slow:undefined});
    const first=harness.window.resumeTrainingSession('session-a');
    await harness.window.resumeTrainingSession('session-b');
    if(failure==='late-failure')reject(new Error('Earlier session failed'));
    else finish({session:{id:'session-a',mode:'constructed',question_title:'Stale A'},messages:[],turns:[]});
    await first;
    expect(harnessElement(harness,'training-q-title').textContent).toBe('B remains selected');
    expect(harnessElement(harness,'training-session').style.display).toBe('block');
    await harness.window.requestTrainingHint();
    expect(harness.calls.findLast(call=>call.path==='/api/training/hint')?.body?.sessionId).toBe('session-b');
    expect(harness.toasts.some(toast=>toast.message==='Earlier session failed')).toBe(false);
  });

  it('keeps unavailable-source history and learner stop controls open while blocking new answers', async () => {
    const recovery={grounding:{status:'unavailable',reason:'missing_evidence_pack'}};
    const harness=createTrainingHarness({id:'saved-evidence',mode:'evidence',is_completed:0},undefined,recovery);
    await harness.window.resumeTrainingSession('saved-evidence');
    expect(harnessElement(harness,'training-session').style.display).toBe('block');
    expect(harnessElement(harness,'training-control-panel').hidden).toBe(false);
    expect(harnessElement(harness,'training-input').disabled).toBe(true);
    harnessElement(harness,'training-input').value='An answer must not be sent';
    await harness.window.submitTrainingMessage();
    expect(harness.calls.some(call=>call.path==='/api/training/chat')).toBe(false);
    const descendants=(node:HintControlElement):HintControlElement[]=>[node,...node.children.flatMap(descendants)];
    const controls=descendants(harnessElement(harness,'training-control-panel'));
    expect(controls.find(node=>node.dataset.controlAction==='HELP')?.disabled).toBe(true);
    const stop=controls.find(node=>node.dataset.controlAction==='STOP')!;
    expect(stop.disabled).toBe(false);
    await stop.click();
    expect(harness.calls).toContainEqual({type:'api',path:'/api/training/session/saved-evidence/interventions',body:{action:'STOP',reason:'',expectedRevision:0,mutationKey:'fixture-control-key'}});
    expect(harnessElement(harness,'training-input').disabled).toBe(true);
  });

  it('retries unavailable control and grounding reads without closing the saved conversation', async () => {
    const recovery={grounding:{status:'unavailable'},controlUnavailable:true};
    const harness=createTrainingHarness({id:'saved-evidence',mode:'evidence',is_completed:0},undefined,recovery);
    await harness.window.resumeTrainingSession('saved-evidence');
    expect(harnessElement(harness,'training-session').style.display).toBe('block');
    expect(harnessElement(harness,'training-submit-btn').disabled).toBe(true);
    const panel=harnessElement(harness,'training-control-panel');
    const retry=panel.children.find(node=>node.textContent==='제어 상태 다시 확인')!;
    expect(retry).toBeDefined();
    recovery.controlUnavailable=false;
    await retry.click();
    expect(harnessElement(harness,'training-submit-btn').disabled).toBe(true);
    const groundingRetry=harnessElement(harness,'training-grounding').children.find(node=>node.textContent==='근거 상태 다시 확인')!;
    recovery.grounding={status:'ready'};
    await groundingRetry.click();
    expect(harnessElement(harness,'training-submit-btn').disabled).toBe(false);
    expect(harness.calls.filter(call=>call.type==='api')).toEqual([]);
  });

  it('requires the single Korean registry and Training/Growth CTA consumption', () => {
    const copy = source('public/static/modules/korean-journey-copy.js');
    const training = source('public/static/modules/training.js');
    const growth = source('public/static/modules/growth-lab.js');

    expect(copy, `plan ${PLAN_SHA256}, spec ${SPEC_SHA256}: Korean registry is required`).not.toBe('');
    expect(copy).toMatch(/[가-힣]/);
    for (const key of COPY_KEYS) {
      expect(copy, `Korean registry key missing: ${key}`).toContain(key);
    }
    expect(training, 'Training must consume korean-journey-copy.js').toMatch(/korean-journey-copy/);
    expect(training, 'Training must consume registry values').toMatch(/KOREAN_JOURNEY_COPY/);
    expect(growth, 'Growth must consume korean-journey-copy.js').toMatch(/korean-journey-copy/);
    expect(growth, 'Growth must consume registry values').toMatch(/KOREAN_JOURNEY_COPY/);

    const combined = `${copy}\n${training}\n${growth}`;
    for (const protocolId of PROTOCOL_IDS) {
      expect(combined, `literal protocol ID must remain adjacent to Korean copy: ${protocolId}`).toContain(protocolId);
    }
    expect(training).toMatch(/originKind:\s*['"]TRAINING['"]/);
  });

  it('requires Korean safeguard states and truthful pending/unknown copy without provider fallback', () => {
    const copy = source('public/static/modules/korean-journey-copy.js');
    const training = source('public/static/modules/training.js');
    const growth = source('public/static/modules/growth-lab.js');
    const combined = `${copy}\n${training}\n${growth}`;

    for (const token of [
      'purposeConsent', 'retention', 'optOutBeforeConsent', 'revocation', 'contest',
      'correction', 'humanReviewPending', 'PENDING', 'GAP_UNKNOWN', 'UNKNOWN',
    ]) {
      expect(combined, `safeguard contract token missing: ${token}`).toContain(token);
    }
    expect(copy, 'learner-visible safeguard text must include Korean').toMatch(/[가-힣]/);
    expect(growth, 'Growth uncertainty must be visible in Korean').toMatch(/[가-힣]/);
    expect(growth, 'the existing contest flow must expose correction without erasing the claim')
      .toContain('KOREAN_JOURNEY_COPY.correction');
    expect(growth, 'human-review PENDING copy must not pass from an unused registry key')
      .toContain('KOREAN_JOURNEY_COPY.humanReviewPending');
    expect(growth, 'Growth must not silently fall back to a provider').not.toMatch(
      /(?:createAIRouter|callAIJSONWithEnv|callAI)\s*\(/,
    );
  });

  it('keeps the existing Growth route/auth/lifecycle protocol surface explicit', () => {
    const route = source('src/routes/growth.ts');
    const service = source('src/services/growth-cycle.ts');
    const trainingRoute = source('src/routes/training.ts');
    const trainingEvidence = source('src/services/training/scenario-evidence.ts');

    expect(route).toContain('resolveAuthUser');
    for (const routeId of [
      '/api/growth/privacy/consent',
      '/api/growth/spaces/solo',
      '/api/growth/spaces/:spaceId/cycles',
      'gap-response',
      'practice-response',
      'rechecks',
    ]) {
      expect(route, `Growth route ID changed or disappeared: ${routeId}`).toContain(routeId);
    }
    for (const action of ["'accept'", "'contest'", "'decline'", "'defer'", "'close_unknown'"]) {
      expect(route, `Growth action protocol changed: ${action}`).toContain(action);
    }
    for (const code of [
      'GROWTH_PRIVATE_SOLO_CONSENT_REQUIRED',
      'GROWTH_RESOURCE_NOT_FOUND',
      'GROWTH_ORIGIN_TERMINALLY_DELETED',
    ]) {
      expect(service, `Growth error protocol changed: ${code}`).toContain(code);
    }
    expect(trainingRoute).toContain('EVIDENCE_HINT_UNAVAILABLE');
    expect(trainingEvidence).toMatch(/context/i);
    expect(trainingEvidence).toMatch(/evidence_manifest_sha256/);

    // The existing contest transition is the correction path: it preserves the
    // original hypothesis while recording participant rationale and a receipt.
    expect(service).toContain('participant_rationale');
    expect(service).toContain('growth_mutation_receipts');
    expect(service).toContain('GAP_CONTESTED');
    // Human review remains a causal RED until an additive durable-request
    // contract is separately approved; an in-memory PENDING label is not enough.
    expect(route, 'human review must expose a truthful PENDING state').toMatch(/human.?review/i);
  });

  it('labels static Korean/a11y checks as code contracts: language, dialog, focus, live region, motion, zoom, reflow', () => {
    const html = source('public/index.html');
    const growth = source('public/static/modules/growth-lab.js');
    const styles = source('public/static/styles.css');

    expect(html).toMatch(/<html\b[^>]*\blang=["']ko["']/i);
    expect(html).toMatch(/data-tab="training"[^>]*>[가-힣]/);
    expect(html).toMatch(/data-tab="growth-lab"[\s\S]*?<span>[가-힣]/);
    expect(html).toMatch(/id="growth-delete-modal"[^>]*role="dialog"/);
    expect(html).toMatch(/id="growth-delete-modal"[^>]*aria-modal="true"/);
    expect(html).toMatch(/id="growth-delete-modal"[^>]*aria-labelledby="growth-delete-modal-title"/);
    expect(html).toMatch(/id="growth-delete-modal"[^>]*aria-describedby="growth-delete-modal-copy"/);
    expect(html).toMatch(/id="growth-lab-status"[^>]*role="status"[^>]*aria-live="polite"/);
    expect(growth).toMatch(/requestAnimationFrame\(\(\) => [^\n]*\.focus\(\)/);
    expect(growth).toMatch(/event\.key\s*(?:===|!==)\s*['"]Tab['"]/);
    expect(growth).toMatch(/aria-describedby/);
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion\s*:\s*reduce\)/);
    expect(styles).toMatch(/@media\s*\(max-width\s*:\s*320px\)/);
    expect(styles).toMatch(/overflow-wrap\s*:\s*anywhere/);
    expect(styles).toMatch(/min-width\s*:\s*0/);
  });

  it('keeps a visible Korean Training route in compact More for every authenticated learning role', () => {
    const html = source('public/index.html');
    const moreStart = html.indexOf('<div id="mobile-more-menu"');
    const moreEnd = html.indexOf('</nav>', moreStart);
    const mobileMore = moreStart >= 0 && moreEnd > moreStart ? html.slice(moreStart, moreEnd) : '';
    const trainingControl = mobileMore.match(
      /<button\b(?=[^>]*\bdata-navigation-control\b)(?=[^>]*\bdata-tab=["']training["'])[^>]*>[\s\S]*?<\/button>/i,
    )?.[0] ?? '';
    const trainingControlOpenTag = trainingControl.match(/^<button\b[^>]*>/i)?.[0] ?? '';

    expect(mobileMore, 'compact navigation must retain the More destination group').not.toBe('');
    expect(trainingControl, 'compact More must expose a visible Korean Training destination').not.toBe('');
    expect(trainingControl).toContain('<span>훈련</span>');
    expect(trainingControl).toMatch(/data-auth-required=["']true["']/);
    expect(trainingControl).toMatch(/data-role-required=["']student,instructor,admin["']/);
    expect(trainingControlOpenTag).not.toMatch(/\bhidden\b|aria-hidden=["']true["']/i);
    expect(trainingControl).toMatch(/onclick=["']switchTab\('training', \{ focusDestination: true \}\)["']/);
  });

  it('keeps evidence-mode hint control disabled, explained, accessible, and request-free', () => {
    const html = source('public/index.html');
    const training = source('public/static/modules/training.js');
    const copy = source('public/static/modules/korean-journey-copy.js');
    const reason = '근거 기반 훈련에서는 힌트를 사용할 수 없습니다.';

    const hintButton = html.match(
      /<button\b(?=[^>]*\bid=["']training-hint-btn["'])[^>]*>[\s\S]*?<\/button>/i,
    )?.[0] ?? '';
    const reasonElement = html.match(
      /<(?:p|span|div)\b(?=[^>]*\bid=["']training-hint-unavailable-reason["'])[^>]*>[\s\S]*?<\/(?:p|span|div)>/i,
    )?.[0] ?? '';
    expect(hintButton, 'Training hint control needs a stable element ID').not.toBe('');
    expect(hintButton, 'evidence mode must be safe in the initial HTML').toMatch(/\bdisabled\b/);
    expect(hintButton).toMatch(/aria-disabled=["']true["']/i);
    expect(hintButton).toMatch(/aria-describedby=["']training-hint-unavailable-reason["']/i);
    expect(reasonElement, 'the evidence-only Korean reason needs a stable element ID').not.toBe('');
    expect(reasonElement).toContain(reason);
    expect(reasonElement).not.toMatch(/\bhidden\b/);

    const protocolIndex = copy.indexOf("evidenceHintCode: 'EVIDENCE_HINT_UNAVAILABLE'");
    const reasonIndex = copy.indexOf(reason);
    expect(protocolIndex, 'the evidence hint protocol code must remain in the registry').toBeGreaterThanOrEqual(0);
    expect(reasonIndex, 'the evidence hint reason must live in the registry').toBeGreaterThanOrEqual(0);
    expect(Math.abs(protocolIndex - reasonIndex), 'protocol and learner copy must stay adjacent').toBeLessThanOrEqual(200);
    expect(training).toContain('KOREAN_JOURNEY_COPY.uncertainty.evidenceHintReason');

    const setMode = training.match(/function setTrainingMode\(mode\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const hintSync = training.match(/function syncTrainingHintControl\(mode\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(setMode).toContain('syncTrainingHintControl');
    expect(hintSync).toMatch(/\.disabled\s*=\s*mode\s*!==\s*['"]constructed['"]/);
    expect(hintSync).toMatch(/setAttribute\(\s*['"]aria-disabled['"]/);
    expect(hintSync).toMatch(/training-hint-unavailable-reason/);
    expect(hintSync).toMatch(/\.hidden\s*=\s*mode\s*!==\s*['"]evidence['"]/);
    expect(hintSync).toMatch(/removeAttribute\(\s*['"]aria-describedby['"]\s*\)/);

    const requestHint = training.match(/async function requestTrainingHint\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const guardIndex = requestHint.indexOf("activeTrainingMode !== 'constructed'");
    const apiIndex = requestHint.indexOf("api('/api/training/hint'");
    expect(guardIndex, 'hint requests need an evidence-mode defensive guard').toBeGreaterThanOrEqual(0);
    expect(apiIndex, 'the non-evidence hint path must remain available').toBeGreaterThan(guardIndex);
    expect(requestHint).toMatch(/activeTrainingMode\s*!==\s*['"]constructed['"][\s\S]*?showToast\([\s\S]*?evidenceHintReason[\s\S]*?return;/);
    expect(requestHint).not.toMatch(/trainingMode\s*===\s*['"]evidence['"]/);
  });

  it('applies authoritative resumed evidence mode over stale constructed selection for hint safety', async () => {
    const harness = createTrainingHarness({
      id: 'evidence-session',
      mode: 'evidence',
      is_completed: 0,
      category: 'policy',
      question_title: 'Evidence fixture',
      question: 'Fixture question',
    });

    harness.window.setTrainingMode('constructed');
    await harness.window.resumeTrainingSession('evidence-session');

    const button = harnessElement(harness, 'training-hint-btn');
    const reason = harnessElement(harness, 'training-hint-unavailable-reason');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(reason.hidden).toBe(false);
    await harness.window.requestTrainingHint();
    expect(harness.calls.filter((call) => call.path === '/api/training/hint')).toHaveLength(0);
    expect(harness.toasts.at(-1)?.message).toBe('근거 기반 훈련에서는 힌트를 사용할 수 없습니다.');
  });

  it('applies authoritative resumed constructed mode over stale evidence selection for legacy hints', async () => {
    const harness = createTrainingHarness({
      id: 'constructed-session',
      mode: 'constructed',
      is_completed: 0,
      category: 'policy',
      question_title: 'Constructed fixture',
      question: 'Fixture question',
    });

    await harness.window.resumeTrainingSession('constructed-session');

    const button = harnessElement(harness, 'training-hint-btn');
    const reason = harnessElement(harness, 'training-hint-unavailable-reason');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(reason.hidden).toBe(true);
    await harness.window.requestTrainingHint();
    expect(harness.calls.filter((call) => call.path === '/api/training/hint')).toHaveLength(1);
  });

  it('binds authoritative started session mode over submitted selection for hint safety', async () => {
    const harness = createTrainingHarness(
      {
        id: 'started-session',
        mode: 'evidence',
        is_completed: 0,
        category: 'policy',
        question_title: 'Evidence fixture',
        question: 'Fixture question',
      },
      { sessionId: 'started-session', mode: 'evidence' },
    );

    harness.window.setTrainingMode('constructed');
    harnessElement(harness, 'training-constructed-max-turns').value = '6';
    harness.window.selectTrainingCategory('policy');
    harness.window.selectTrainingDifficulty('beginner');
    await harness.window.startTraining();

    const button = harnessElement(harness, 'training-hint-btn');
    const reason = harnessElement(harness, 'training-hint-unavailable-reason');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(reason.hidden).toBe(false);
    await harness.window.requestTrainingHint();
    expect(harness.calls.filter((call) => call.path === '/api/training/hint')).toHaveLength(0);
  });

  it('fails closed when started session mode authority is missing after constructed selection', async () => {
    const harness = createTrainingHarness(
      { id: 'started-missing-mode', mode: 'evidence', is_completed: 0 },
      { sessionId: 'started-missing-mode' },
    );

    await startConstructedSelection(harness);

    const button = harnessElement(harness, 'training-hint-btn');
    const reason = harnessElement(harness, 'training-hint-unavailable-reason');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(reason.hidden).toBe(false);
    await harness.window.requestTrainingHint();
    expect(harness.calls.filter((call) => call.path === '/api/training/hint')).toHaveLength(0);
  });

  it('fails closed when started session mode authority is malformed after constructed selection', async () => {
    const harness = createTrainingHarness(
      { id: 'started-malformed-mode', mode: 'evidence', is_completed: 0 },
      { sessionId: 'started-malformed-mode', mode: 'unexpected-mode' },
    );

    await startConstructedSelection(harness);

    const button = harnessElement(harness, 'training-hint-btn');
    const reason = harnessElement(harness, 'training-hint-unavailable-reason');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(reason.hidden).toBe(false);
    await harness.window.requestTrainingHint();
    expect(harness.calls.filter((call) => call.path === '/api/training/hint')).toHaveLength(0);
  });
});

describe('Critical Path B Task 2 — private human-review request RED', () => {
  it('requires the additive PENDING-only request seam and exact POST boundary', async () => {
    const migration = source('migrations/0065_growth_human_review_requests.sql');
    const serviceSource = source('src/services/growth-cycle.ts');
    const route = source('src/routes/growth.ts');
    const service = await import('../../src/services/growth-cycle');

    expect.soft(migration, 'Task 2 migration must add the request table').toContain(
      'CREATE TABLE growth_human_review_requests',
    );
    expect.soft(migration, 'the request table must have exactly six columns').toMatch(
      /id TEXT PRIMARY KEY[\s\S]*growth_cycle_id TEXT NOT NULL[\s\S]*owner_user_id TEXT NOT NULL[\s\S]*state TEXT NOT NULL CHECK \(state = 'PENDING'\)[\s\S]*request_dedup_digest TEXT NOT NULL[\s\S]*created_at INTEGER NOT NULL/,
    );
    expect.soft(typeof service.requestGrowthHumanReview).toBe('function');
    expect.soft(serviceSource).toContain("growth-human-review-request:dedup:v1");
    expect.soft(route).toContain('/api/growth/spaces/:spaceId/cycles/:cycleId/human-review-requests');
    expect.soft(route).toContain("jsonObject(c, ['expectedRevision'])");
    expect.soft(route).not.toMatch(/human-review-requests\/:|human-review-requests.*\.get|\.get\([^)]*human-review/);
  });

  it('requires the exact pending-only Korean action and truthful announcement', () => {
    const copy = source('public/static/modules/korean-journey-copy.js');
    const growth = source('public/static/modules/growth-lab.js');
    const exact = '사람의 검토 요청이 접수되어 PENDING 상태입니다. 요청만으로 검토가 완료되지는 않습니다.';

    expect.soft(copy).toContain("protocolId: 'PENDING'");
    expect.soft(copy).toContain(exact);
    expect.soft(growth).toContain('KOREAN_JOURNEY_COPY.humanReviewPending');
    expect.soft(growth).toContain('/human-review-requests');
    expect.soft(growth).toContain('PENDING');
    expect.soft(growth).not.toMatch(/reviewer|approved|approval|completed review|scheduled review/i);
  });
});
