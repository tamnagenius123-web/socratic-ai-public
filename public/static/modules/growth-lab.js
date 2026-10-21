// ======================================================
// SocraticAI — private participant Growth Lab surface
// ======================================================

import { apiGet, apiWithHeaders } from './utils.js';
import { getEl } from './state.js';
import { KOREAN_JOURNEY_COPY } from './korean-journey-copy.js';

const state = {
  mode: 'idle',
  spaces: [],
  cycles: [],
  selectedSpaceId: '',
  selectedCycleId: '',
  detail: null,
  error: null,
  actionError: null,
  retryAction: null,
  pendingAction: '',
  activeMutation: null,
  mutationSequence: 0,
  gapContestId: '',
  focusFormOpen: false,
  practiceDeferId: '',
  recheckFormId: '',
  deleteConfirmationOpen: false,
  consentRevocationOpen: false,
  provisionedConsent: null,
  pendingOrigin: null,
  originAttachment: null,
  listRefreshWarning: null,
  deletionReceipt: null,
  humanReviewRequest: null,
  requestGeneration: 0,
};

const actionKeys = new Map();
let deleteDialogReturnFocus = null;
let deleteDialogInertState = [];
let deleteDialogReady = false;

class GrowthLabActionError extends Error {
  constructor(code, phase = 'conflict', retryable = false) {
    super(code);
    this.name = 'GrowthLabActionError';
    this.status = phase === 'unavailable' ? 503 : phase === 'validation' ? 400 : 409;
    this.code = code;
    this.phase = phase;
    this.retryable = retryable;
    this.requestId = null;
    this.payload = null;
  }
}

const STATE_COPY = KOREAN_JOURNEY_COPY.states;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function button(text, className, handler, options = {}) {
  const node = element('button', className, text);
  node.type = options.type === 'submit' ? 'submit' : 'button';
  if (options.disabled) node.disabled = true;
  if (options.describedBy) node.setAttribute('aria-describedby', options.describedBy);
  if (handler) node.addEventListener('click', handler);
  return node;
}

function getRoot() {
  return getEl('growth-lab-content');
}

function announceGrowthStatus(message) {
  const status = getEl('growth-lab-status');
  if (status) status.textContent = message;
}

function getDeleteDialog() {
  return getEl('growth-delete-modal');
}

function dialogFocusableElements(dialog) {
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((node) => node instanceof HTMLElement && node.offsetParent !== null);
}

function setDeleteDialogBackgroundInert(dialog, shouldInert) {
  if (shouldInert) {
    if (deleteDialogInertState.length) return;
    let activeBranch = dialog;
    while (activeBranch.parentElement && activeBranch.parentElement !== document.documentElement) {
      const parent = activeBranch.parentElement;
      Array.from(parent.children).forEach((sibling) => {
        if (sibling === activeBranch || !(sibling instanceof HTMLElement)) return;
        deleteDialogInertState.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      });
      activeBranch = parent;
    }
    return;
  }
  deleteDialogInertState.forEach(({ element, inert }) => { element.inert = inert; });
  deleteDialogInertState = [];
}

function closeDeleteConfirmation(returnFocus = true) {
  const dialog = getDeleteDialog();
  const restoreFocus = returnFocus
    && Boolean(dialog?.contains(document.activeElement))
    && deleteDialogReturnFocus?.isConnected;
  state.deleteConfirmationOpen = false;
  if (dialog) dialog.hidden = true;
  document.documentElement.classList.remove('growth-delete-modal-open');
  document.body.classList.remove('growth-delete-modal-open');
  if (dialog) setDeleteDialogBackgroundInert(dialog, false);
  const focusTarget = deleteDialogReturnFocus;
  deleteDialogReturnFocus = null;
  if (restoreFocus) window.requestAnimationFrame(() => focusTarget.focus());
}

function openDeleteConfirmation(trigger) {
  const dialog = getDeleteDialog();
  if (!dialog || !state.detail) return;
  deleteDialogReturnFocus = trigger instanceof HTMLElement && trigger.isConnected
    ? trigger
    : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const copy = getEl('growth-delete-modal-copy');
  if (copy) copy.textContent = `주기 리비전 ${displayValue(state.detail.aggregateRevision)}의 삭제를 요청합니다. ${KOREAN_JOURNEY_COPY.delete.confirmExplanation}`;
  state.deleteConfirmationOpen = true;
  dialog.hidden = false;
  document.documentElement.classList.add('growth-delete-modal-open');
  document.body.classList.add('growth-delete-modal-open');
  setDeleteDialogBackgroundInert(dialog, true);
  window.requestAnimationFrame(() => getEl('growth-delete-modal-confirm')?.focus());
}

function handleDeleteDialogKeydown(event) {
  const dialog = getDeleteDialog();
  if (!dialog || dialog.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDeleteConfirmation();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = dialogFocusableElements(dialog);
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!focusable.includes(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function ensureDeleteDialog() {
  if (deleteDialogReady) return;
  const dialog = getDeleteDialog();
  if (!dialog) return;
  deleteDialogReady = true;
  getEl('growth-delete-modal-cancel')?.addEventListener('click', () => closeDeleteConfirmation());
  getEl('growth-delete-modal-close')?.addEventListener('click', () => closeDeleteConfirmation());
  getEl('growth-delete-modal-confirm')?.addEventListener('click', () => deleteCycle());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDeleteConfirmation();
  });
  document.addEventListener('keydown', handleDeleteDialogKeydown);
}

function syncDeleteDialogPending() {
  const confirm = getEl('growth-delete-modal-confirm');
  if (!confirm) return;
  const pending = Boolean(state.pendingAction && state.pendingAction.startsWith('delete-'));
  confirm.disabled = pending;
  confirm.textContent = pending ? '삭제하는 중…' : KOREAN_JOURNEY_COPY.delete.confirmAction;
}

function clearRoot() {
  const root = getRoot();
  if (root) root.replaceChildren();
  return root;
}

function displayValue(value, fallback = '기록 없음') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function arrayValue(value) {
  return Array.isArray(value) && value.length ? value : [];
}

function statusText(value) {
  const [label] = STATE_COPY[String(value)] || [];
  const labels = { UNKNOWN:'확인되지 않음', MEASURED:'관찰값 있음', INITIAL:'직접 선택', REVISED:'다시 선택',
    PROPOSED:'검토할 제안', CONTESTED:'이의 제기됨', DISMISSED:'기각됨', OFFERED:'선택 가능', ACCEPTED:'수락함',
    DECLINED:'거절함', DEFERRED:'나중에 결정', SCHEDULED:'예약됨', RECORDED:'기록됨', PENDING:'대기 중',
    VALIDATED:'검증됨', UNVALIDATED:'검증되지 않음', UNVERIFIED:'검증되지 않음',
    FOCUS_SELECTED:'학습 초점 선택', GAP_REMAINS_UNKNOWN:'격차를 확정하지 못함',
    PRACTICE_ACCEPTED:'연습 수락', PRACTICE_OFFERED:'연습 제안',
    RAW_ORIGIN_EVALUATION_RECORDED:'원본 평가 기록 연결', RECHECK_FOLLOW_UP_LAUNCHED:'후속 시도 시작',
    RECHECK_RECORDED:'재확인 시도 기록', RECHECK_SCHEDULED:'재확인 예약' };
  return label || labels[value] || '상태 확인 필요';
}

function timestamp(value) {
  if (!Number.isFinite(value)) return '기록 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '기록 없음';
  try {
    return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return '기록 없음';
  }
}

function dateInputValue(value) {
  if (!Number.isFinite(value)) return '';
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function idempotencyKey(operation, payload) {
  const fingerprint = `${operation}:${JSON.stringify(payload ?? null)}`;
  if (actionKeys.has(fingerprint)) return actionKeys.get(fingerprint);
  const suffix = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
  const key = `growth-ui-${operation}-${suffix}`;
  actionKeys.set(fingerprint, key);
  return key;
}

function completeIdempotencyKey(operation, payload) {
  actionKeys.delete(`${operation}:${JSON.stringify(payload ?? null)}`);
}

async function growthMutation(path, method, body, operation) {
  const key = idempotencyKey(operation, body);
  return apiWithHeaders(path, body, method, { 'Idempotency-Key': key });
}

function safeActionError(error) {
  const expectedRevision = error?.payload?.details?.expectedRevision;
  return {
    status: Number.isSafeInteger(error?.status) ? error.status : 0,
    code: typeof error?.code === 'string' ? error.code : 'GROWTH_REQUEST_FAILED',
    phase: typeof error?.phase === 'string' ? error.phase : 'unavailable',
    retryable: Boolean(error?.retryable),
    requestId: typeof error?.requestId === 'string' ? error.requestId : null,
    expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
  };
}

function actionErrorGuidance(error) {
  if(error?.savedFollowUp) return {category:'후속 훈련 저장됨',next:'조건은 저장되었습니다. 훈련 화면만 다시 열어 주세요.'};
  const recheck = {
    GROWTH_RECHECK_NOT_DUE: '예약한 시각 이후에 새 후속 시도를 시작해 주세요. 지금은 일정을 바꾸거나 UNKNOWN으로 종료할 수 있습니다.',
    GROWTH_RECHECK_FOLLOW_UP_STARTED_TOO_EARLY: '예약한 시각보다 먼저 시작한 시도는 지연 재확인으로 기록하지 않습니다. 예약 시각 이후 새 시도를 완료해 주세요.',
    GROWTH_RECHECK_NEW_ATTEMPT_REQUIRED: '원래 대화의 다른 답변 대신 새 후속 시도를 사용해 주세요.',
    GROWTH_RECHECK_CONTEXT_UNAVAILABLE: '원래 시도나 후속 시도의 근거 맥락을 확인할 수 없습니다. 학습 효과는 UNKNOWN으로 남습니다.',
  }[error?.code];
  if (recheck) return { category: '재확인 조건', next: recheck };

  const status = Number.isSafeInteger(error?.status) && error.status > 0 ? error.status : null;
  if (status === 401 || error?.phase === 'authorization') {
    return { category: '접근 확인', next: '이 비공개 공간을 소유한 계정으로 다시 로그인하세요.' };
  }
  if (status === 409 || error?.phase === 'conflict') {
    return { category: '리비전 충돌', next: '다른 변경 전에 현재 비공개 기록을 다시 불러오세요.' };
  }
  if (error?.phase === 'evidence') {
    return { category: '근거 경계', next: '기록된 근거 계약을 충족하는 본인 소유의 저장된 Training 또는 Sparring 시도를 사용하세요.' };
  }
  if (error?.phase === 'policy') {
    return { category: '비공개 동의 정책', next: '기존 설정을 이어가거나 공간 생성 전에 비공개 SOLO 동의를 제공하세요.' };
  }
  if (status === 503 || error?.phase === 'unavailable') {
    return { category: '서비스 이용 불가', next: '서비스가 다시 이용 가능해진 뒤에만 같은 요청을 다시 시도하세요.' };
  }
  return { category: '요청 검증', next: '필수 비공개 기록 내용을 확인하고 다시 시도하세요.' };
}

function statePanel(title, description, nextStep, retry) {
  const panel = element('section', 'growth-state-panel');
  panel.setAttribute('role', 'status');
  panel.append(
    element('h2', 'growth-state-title', title),
    element('p', 'growth-state-copy', description),
    element('p', 'growth-state-next', `다음 단계: ${nextStep}`),
  );
  if (retry) panel.append(button('다시 시도', 'growth-button growth-button-primary', retry));
  return panel;
}

function definitionItem(label, value, subtle = false) {
  const item = element('div', subtle ? 'growth-definition growth-definition-subtle' : 'growth-definition');
  item.append(
    element('dt', 'growth-definition-label', label),
    element('dd', 'growth-definition-value', displayValue(value)),
  );
  return item;
}

function evidenceList(label, ids) {
  const section = element('div', 'growth-evidence-list');
  section.append(element('p', 'growth-mini-label', label));
  const items = arrayValue(ids);
  if (!items.length) {
    section.append(element('p', 'growth-evidence-empty', '이 화면에서 확인할 수 있는 근거 식별자가 없습니다.'));
    return section;
  }
  const list = element('ul', 'growth-id-list');
  for (const id of items) list.append(element('li', 'growth-id', id));
  section.append(list);
  return section;
}

function recordDetails(label, ...content) {
  const detail = element('details', 'growth-record-details growth-diagnostic-details');
  detail.append(element('summary', '', label), ...content);
  return detail;
}

function originLabel(kind) {
  return kind === 'SPARRING' ? '도서 스파링' : kind === 'TRAINING' ? '근거 기반 훈련' : '학습 기록';
}

function recordCard(title, meta, status, body) {
  const card = element('article', 'growth-record-card');
  const heading = element('div', 'growth-record-heading');
  const headingText = element('div');
  headingText.append(element('h3', 'growth-record-title', title));
  if (meta) headingText.append(element('p', 'growth-record-meta', meta));
  const badge = element('span', `growth-status growth-status-${String(status || 'UNKNOWN').toLowerCase()}`, statusText(status));
  badge.title = displayValue(status, 'UNKNOWN');
  heading.append(headingText, badge);
  card.append(heading);
  if (body) card.append(body);
  return card;
}

function setBusy(value) {
  const root = getRoot();
  if (root) root.setAttribute('aria-busy', value ? 'true' : 'false');
}

function selectedSpace() {
  return state.spaces.find((space) => space.id === state.selectedSpaceId) || null;
}

async function loadGrowthLab() {
  ensureDeleteDialog();
  const generation = ++state.requestGeneration;
  state.humanReviewRequest = null;
  announceGrowthStatus('비공개 성장 실험실을 불러오는 중입니다.');
  state.mode = 'loading-spaces';
  state.error = null;
  state.actionError = null;
  state.listRefreshWarning = null;
  setBusy(true);
  render();
  try {
    const data = await apiGet('/api/growth/spaces');
    if (generation !== state.requestGeneration) return;
    state.spaces = arrayValue(data?.spaces);
    if (!state.spaces.length) {
      state.selectedSpaceId = '';
      state.cycles = [];
      state.selectedCycleId = '';
      state.detail = null;
      state.mode = 'idle';
      announceGrowthStatus('사용 가능한 비공개 성장 실험실 공간이 없습니다.');
      return;
    }
    if (!state.spaces.some((space) => space.id === state.selectedSpaceId)) state.selectedSpaceId = state.spaces[0].id;
    await loadCycles(state.selectedSpaceId, generation);
  } catch (error) {
    if (generation !== state.requestGeneration) return;
    state.mode = 'idle';
    state.error = safeActionError(error);
    announceGrowthStatus('성장 실험실을 불러오지 못했습니다. 비공개 기록이 바뀌었다고 추정하지 않습니다.');
  } finally {
    if (generation === state.requestGeneration) {
      setBusy(false);
      render();
    }
  }
}

async function loadCycles(spaceId, generation = ++state.requestGeneration) {
  state.mode = 'loading-cycles';
  announceGrowthStatus('비공개 성장 주기를 불러오는 중입니다.');
  render();
  try {
    const data = await apiGet(`/api/growth/spaces/${encodeURIComponent(spaceId)}/cycles?limit=50`);
    if (generation !== state.requestGeneration) return;
    state.cycles = arrayValue(data?.cycles);
    if (!state.cycles.some((cycle) => cycle.id === state.selectedCycleId)) {
      state.selectedCycleId = state.cycles[0]?.id || '';
      state.detail = null;
    }
    if (state.selectedCycleId) await loadCycle(state.selectedCycleId, generation, false);
    else {
      state.mode = 'idle';
      announceGrowthStatus('비공개 성장 주기를 불러왔습니다. 현재 선택한 주기는 없습니다.');
    }
  } catch (error) {
    if (generation !== state.requestGeneration) return;
    state.mode = 'idle';
    state.error = safeActionError(error);
    announceGrowthStatus('비공개 성장 주기를 불러오지 못했습니다. 비공개 기록이 바뀌었다고 추정하지 않습니다.');
  }
}

async function loadCycle(cycleId, generation = ++state.requestGeneration, repaint = true) {
  const space = selectedSpace();
  if (!space || !cycleId) return;
  state.mode = 'loading-cycle';
  announceGrowthStatus('선택한 비공개 성장 주기를 불러오는 중입니다.');
  if (repaint) render();
  try {
    const data = await apiGet(`/api/growth/spaces/${encodeURIComponent(space.id)}/cycles/${encodeURIComponent(cycleId)}`);
    if (generation !== state.requestGeneration) return;
    state.detail = data?.cycle && typeof data.cycle === 'object' ? data.cycle : null;
    state.selectedCycleId = cycleId;
    state.mode = 'idle';
    announceGrowthStatus('선택한 비공개 성장 주기를 불러왔습니다.');
  } catch (error) {
    if (generation !== state.requestGeneration) return;
    state.mode = 'idle';
    state.error = safeActionError(error);
    announceGrowthStatus('선택한 비공개 성장 주기를 불러오지 못했습니다. 비공개 기록이 바뀌었다고 추정하지 않습니다.');
  }
}

async function selectCycle(cycleId) {
  if (state.activeMutation) {
    announceGrowthStatus('현재 비공개 변경이 끝난 뒤 다른 성장 주기를 선택하세요.');
    return;
  }
  state.selectedCycleId = cycleId;
  state.detail = null;
  state.humanReviewRequest = null;
  state.actionError = null;
  await loadCycle(cycleId);
  render();
}

function beginMutation(operation) {
  return {
    id: ++state.mutationSequence,
    operation,
    cycleId: state.detail?.id || state.selectedCycleId || null,
    spaceId: selectedSpace()?.id || null,
    requestGeneration: ++state.requestGeneration,
  };
}

function mutationStillBound(mutation) {
  if (state.activeMutation !== mutation) return false;
  if (state.requestGeneration !== mutation.requestGeneration) return false;
  if (mutation.spaceId && state.selectedSpaceId !== mutation.spaceId) return false;
  if (mutation.cycleId && (state.selectedCycleId !== mutation.cycleId || state.detail?.id !== mutation.cycleId)) return false;
  return true;
}

async function afterCycleMutation(result, mutation) {
  if (!mutationStillBound(mutation) || !mutation.cycleId || !mutation.spaceId) return;
  const responseCycleId = typeof result?.cycleId === 'string' ? result.cycleId : null;
  if (!responseCycleId || responseCycleId !== mutation.cycleId) {
    throw new GrowthLabActionError('GROWTH_MUTATION_CYCLE_MISMATCH', 'conflict', true);
  }
  await loadCycles(mutation.spaceId, mutation.requestGeneration);
  if (!mutationStillBound(mutation) || !state.cycles.some((cycle) => cycle.id === mutation.cycleId)) return;
  state.selectedCycleId = mutation.cycleId;
  await loadCycle(mutation.cycleId, mutation.requestGeneration, false);
}

async function performAction(operation, path, method, body, success, options = {}) {
  let completed = false;
  const mutation = beginMutation(operation);
  state.activeMutation = mutation;
  state.pendingAction = operation;
  state.actionError = null;
  state.retryAction = null;
  announceGrowthStatus('비공개 성장 실험실 요청을 보내는 중입니다.');
  syncDeleteDialogPending();
  render();
  try {
    const result = await growthMutation(path, method, body, operation);
    if (!mutationStillBound(mutation)) return false;
    await success(result, mutation);
    if (!options.retainIdempotencyKey) completeIdempotencyKey(operation, body);
    completed = true;
    announceGrowthStatus(options.successMessage || '비공개 성장 실험실 요청을 완료했습니다.');
  } catch (error) {
    if (mutationStillBound(mutation)) {
      state.actionError = safeActionError(error);
      state.retryAction = () => performAction(operation, path, method, body, success, options);
      announceGrowthStatus(KOREAN_JOURNEY_COPY.uncertainty.unavailable);
    }
  } finally {
    if (state.activeMutation === mutation) {
      state.pendingAction = '';
      state.activeMutation = null;
    }
  }
  syncDeleteDialogPending();
  render();
  return completed;
}

function parseDataClasses(value) {
  const entries = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return Array.from(new Set(entries));
}

async function provisionSoloSpace() {
  const completed = await performAction('solo-space', '/api/growth/spaces/solo', 'POST', undefined, async () => {
    state.provisionedConsent = null;
    state.deletionReceipt = null;
    await loadGrowthLab();
  });
  return completed;
}

async function submitConsent(form) {
  const purpose = form.elements.namedItem('purpose')?.value?.trim();
  const dataClasses = parseDataClasses(form.elements.namedItem('dataClasses')?.value);
  const retentionPolicy = form.elements.namedItem('retentionPolicy')?.value?.trim();
  const policyRevision = Number(form.elements.namedItem('policyRevision')?.value);
  if (!purpose || !retentionPolicy || !dataClasses.length || !Number.isSafeInteger(policyRevision) || policyRevision < 1) {
    state.actionError = { code: 'GROWTH_PRIVATE_CONSENT_INVALID', phase: 'validation', retryable: false, requestId: null, expectedRevision: null };
    render();
    return false;
  }
  const payload = { purpose, dataClasses, retentionPolicy, policyRevision };
  const consentRecorded = await performAction('private-consent', '/api/growth/privacy/consent', 'POST', payload, async (result) => {
    const consentReceiptId = typeof result?.consentReceiptId === 'string' ? result.consentReceiptId : null;
    state.provisionedConsent = consentReceiptId ? { consentReceiptId, policyRevision } : null;
  });
  return consentRecorded;
}

function normalizeOrigin(input) {
  const originKind = typeof input?.originKind === 'string' ? input.originKind : '';
  const originAttemptId = typeof input?.originAttemptId === 'string' ? input.originAttemptId.trim() : '';
  if (!['TRAINING', 'SPARRING'].includes(originKind) || !originAttemptId) return null;
  return { originKind, originAttemptId };
}

function privateSoloSpace(spaces) {
  return arrayValue(spaces).find((space) => space
    && space.spaceType === 'SOLO'
    && space.privacyMode === 'PRIVATE'
    && space.status === 'ACTIVE') || null;
}

function focusSelectedGrowthDetail() {
  const detail = getRoot()?.querySelector('.growth-detail');
  const focusTarget = detail?.querySelector('h2, h3') || detail;
  if (!(focusTarget instanceof HTMLElement)) return false;
  const previousTabIndex = focusTarget.getAttribute('tabindex');
  if (previousTabIndex === null) focusTarget.tabIndex = -1;
  focusTarget.focus({ preventScroll: false });
  if (previousTabIndex === null) {
    focusTarget.addEventListener('blur', () => focusTarget.removeAttribute('tabindex'), { once: true });
  }
  return document.activeElement === focusTarget;
}

async function navigateToGrowthLab() {
  const bridge = window.SocraticAI || window.SocraticModules;
  if (typeof bridge?.switchTab !== 'function') {
    throw new GrowthLabActionError('GROWTH_NAVIGATION_UNAVAILABLE', 'unavailable', true);
  }
  const opened = await bridge.switchTab('growth-lab', { focusDestination: false });
  if (opened === false) throw new GrowthLabActionError('GROWTH_NAVIGATION_FAILED', 'unavailable', true);
}

function validateOpenCycleResult(result, origin) {
  if (!result || typeof result !== 'object'
    || typeof result.cycleId !== 'string' || !result.cycleId.trim()
    || result.originKind !== origin.originKind
    || result.state !== 'GAP_UNKNOWN'
    || !Number.isSafeInteger(result.aggregateRevision)) {
    throw new GrowthLabActionError('GROWTH_OPEN_RESPONSE_INVALID', 'conflict', true);
  }
  return result.cycleId;
}

function validateOpenedCycleDetail(detail, cycleId, origin) {
  if (!detail || typeof detail !== 'object'
    || detail.id !== cycleId
    || detail.originKind !== origin.originKind
    || detail.originAttemptId !== origin.originAttemptId) {
    throw new GrowthLabActionError('GROWTH_OPEN_CYCLE_MISMATCH', 'conflict', true);
  }
}

async function showOpenedCycle(spaceId, cycleId, origin) {
  await navigateToGrowthLab();
  const generation = ++state.requestGeneration;
  state.selectedSpaceId = spaceId;
  state.selectedCycleId = cycleId;
  state.detail = null;
  state.error = null;
  state.listRefreshWarning = null;
  await loadCycle(cycleId, generation, false);
  if (state.error) throw state.error;
  validateOpenedCycleDetail(state.detail, cycleId, origin);
  try {
    const data = await apiGet(`/api/growth/spaces/${encodeURIComponent(spaceId)}/cycles?limit=50`);
    if (generation === state.requestGeneration) state.cycles = arrayValue(data?.cycles);
  } catch (error) {
    state.listRefreshWarning = safeActionError(error);
    announceGrowthStatus('정확한 비공개 성장 주기는 불러왔지만 제한된 주기 목록은 새로고침하지 못했습니다.');
  }
  render();
  focusSelectedGrowthDetail();
}

async function revealOriginFailure(origin, error, message) {
  const safeError = safeActionError(error);
  const retryAction = state.retryAction || (safeError.retryable ? () => openGrowthCycleFromOrigin(origin) : null);
  try {
    await navigateToGrowthLab();
  } catch (navigationError) {
    state.error = null;
    state.actionError = safeError;
    state.retryAction = retryAction;
    announceGrowthStatus(message);
    render();
    return;
  }
  state.error = null;
  state.actionError = safeError;
  state.retryAction = retryAction;
  announceGrowthStatus(message);
  render();
}

function originActionPending(origin) {
  return state.originAttachment === `${origin.originKind}:${origin.originAttemptId}`
    || actionPending(`open-origin-${origin.originKind}-${origin.originAttemptId}`);
}

async function openGrowthCycleFromOrigin(input) {
  const origin = normalizeOrigin(input);
  if (!origin) {
    state.actionError = { code: 'GROWTH_ORIGIN_INPUT_INVALID', phase: 'validation', retryable: false, requestId: null, expectedRevision: null };
    announceGrowthStatus('완료한 Training 또는 Sparring 시도 ID가 필요합니다. 비공개 기록은 바뀌지 않았습니다.');
    render();
    return false;
  }
  const fingerprint = `${origin.originKind}:${origin.originAttemptId}`;
  if (state.originAttachment) {
    announceGrowthStatus(state.originAttachment === fingerprint
      ? 'This private Growth Cycle request is already in progress.'
      : 'Wait for the current private Growth Cycle request before choosing another attempt.');
    return false;
  }
  if (state.activeMutation) {
    state.actionError = { code: 'GROWTH_ORIGIN_ACTION_IN_PROGRESS', phase: 'conflict', retryable: true, requestId: null, expectedRevision: null };
    announceGrowthStatus('현재 비공개 요청이 끝난 뒤 다른 주기를 여세요.');
    render();
    return false;
  }
  state.originAttachment = fingerprint;
  state.actionError = null;
  state.retryAction = null;
  announceGrowthStatus('비공개 성장 실험실 공간을 확인하는 중입니다.');
  render();
  try {
    const data = await apiGet('/api/growth/spaces');
    state.spaces = arrayValue(data?.spaces);
    const space = privateSoloSpace(state.spaces);
    if (!space) {
      state.pendingOrigin = origin;
      state.originAttachment = null;
      await navigateToGrowthLab();
      render();
      announceGrowthStatus('완료한 시도가 명시적인 비공개 설정을 기다리고 있습니다. 성장 주기는 생성되지 않았습니다.');
      return false;
    }
    state.selectedSpaceId = space.id;
    const operation = `open-origin-${origin.originKind}-${origin.originAttemptId}`;
    const completed = await performAction(
      operation,
      `/api/growth/spaces/${encodeURIComponent(space.id)}/cycles`,
      'POST',
      origin,
      async (result) => {
        const cycleId = validateOpenCycleResult(result, origin);
        await showOpenedCycle(space.id, cycleId, origin);
        state.pendingOrigin = null;
      },
    );
    state.originAttachment = null;
    if (!completed) {
      await revealOriginFailure(origin, state.actionError || new GrowthLabActionError('GROWTH_OPEN_RESPONSE_UNVERIFIABLE', 'conflict', true), 'The Growth Cycle was not opened. No private record is inferred.');
    } else {
      render();
    }
    return completed;
  } catch (error) {
    state.originAttachment = null;
    await revealOriginFailure(origin, error, 'The Growth Cycle was not opened. No private record is inferred.');
    return false;
  }
}

function clearPendingOrigin() {
  if (!state.pendingOrigin) return;
  state.pendingOrigin = null;
  state.actionError = null;
  state.retryAction = null;
  announceGrowthStatus('대기 중인 원본 시도를 지웠습니다. 비공개 기록은 바뀌지 않았습니다.');
  render();
}

async function revokePrivateConsent(consentReceiptId) {
  if (!consentReceiptId) return;
  await performAction(`revoke-consent-${consentReceiptId}`, `/api/growth/privacy/consent/${encodeURIComponent(consentReceiptId)}/revoke`, 'POST', undefined, async () => {
    state.consentRevocationOpen = false;
    state.provisionedConsent = null;
    state.deletionReceipt = null;
    state.selectedSpaceId = '';
    state.selectedCycleId = '';
    state.cycles = [];
    state.detail = null;
    await loadGrowthLab();
  });
}

function actionPending(operation) {
  return state.pendingAction === operation;
}

function currentRevision() {
  const revision = state.detail?.aggregateRevision;
  return Number.isSafeInteger(revision) ? revision : null;
}

function submitGap(action, hypothesisId, rationale = undefined) {
  const space = selectedSpace();
  const revision = currentRevision();
  if (!space || !state.detail || revision === null) return;
  const payload = { action, hypothesisId, ...(rationale ? { rationale } : {}), expectedRevision: revision };
  performAction(`gap-${action}-${hypothesisId}`, `/api/growth/spaces/${encodeURIComponent(space.id)}/cycles/${encodeURIComponent(state.detail.id)}/gap-response`, 'POST', payload, afterCycleMutation);
}

function submitFocus(form) {
  const space = selectedSpace();
  const revision = currentRevision();
  if (!space || !state.detail || revision === null) return;
  const statement = form.elements.namedItem('statement')?.value?.trim();
  const reason = form.elements.namedItem('reason')?.value?.trim();
  const capabilityId = form.elements.namedItem('capability')?.value?.trim();
  const capabilityRevision = Number(form.elements.namedItem('capabilityRevision')?.value);
  if (!statement || !capabilityId || capabilityRevision !== 1) {
    state.actionError = {
      status: 0,
      code: !statement ? 'GROWTH_FOCUS_STATEMENT_INVALID' : 'GROWTH_FOCUS_REQUIRES_EXPLICIT_CAPABILITY',
      phase: 'validation',
      retryable: false,
      requestId: null,
      expectedRevision: null,
    };
    render();
    return;
  }
  const payload = {
    statement,
    capabilityId,
    capabilityRevision,
    ...(reason ? { reason } : {}),
    expectedRevision: revision,
  };
  performAction('select-focus', `/api/growth/spaces/${encodeURIComponent(space.id)}/cycles/${encodeURIComponent(state.detail.id)}/focus`, 'POST', payload, afterCycleMutation);
}

function submitPractice(action, questId, revisitAt = undefined) {
  const space = selectedSpace();
  const revision = currentRevision();
  if (!space || !state.detail || revision === null) return;
  const payload = { action, practiceQuestId: questId, ...(revisitAt ? { revisitAt } : {}), expectedRevision: revision };
  performAction(`practice-${action}-${questId}`, `/api/growth/spaces/${encodeURIComponent(space.id)}/cycles/${encodeURIComponent(state.detail.id)}/practice-response`, 'POST', payload, afterCycleMutation);
}

function submitRecheck(action, recheckId, options = {}) {
  const space = selectedSpace();
  const revision = currentRevision();
  if (!space || !state.detail || revision === null) return;
  const payload = { action, ...(recheckId ? { recheckId } : {}), ...options, expectedRevision: revision };
  performAction(`recheck-${action}-${recheckId || 'cycle'}`, `/api/growth/spaces/${encodeURIComponent(space.id)}/cycles/${encodeURIComponent(state.detail.id)}/rechecks`, 'POST', payload, afterCycleMutation);
}

function validateHumanReviewResult(result, cycleId) {
  const request = result?.request;
  const keys = request && typeof request === 'object' ? Object.keys(request).sort() : [];
  if (keys.join(',') !== 'createdAt,cycleId,id,state'
    || typeof request.id !== 'string'
    || request.cycleId !== cycleId
    || request.state !== 'PENDING'
    || !Number.isSafeInteger(request.createdAt)) {
    throw new GrowthLabActionError('GROWTH_HUMAN_REVIEW_RESPONSE_INVALID', 'conflict', true);
  }
  return request;
}

function requestHumanReview() {
  const space = selectedSpace();
  const revision = currentRevision();
  if (!space || !state.detail || revision === null) return;
  const cycleId = state.detail.id;
  const payload = { expectedRevision: revision };
  performAction(
    `human-review-${cycleId}`,
    `/api/growth/spaces/${encodeURIComponent(space.id)}/cycles/${encodeURIComponent(cycleId)}/human-review-requests`,
    'POST',
    payload,
    async (result) => {
      state.humanReviewRequest = validateHumanReviewResult(result, cycleId);
    },
    {
      retainIdempotencyKey: true,
      successMessage: KOREAN_JOURNEY_COPY.humanReviewPending.explanation,
    },
  );
}

async function deleteCycle() {
  const space = selectedSpace();
  const revision = currentRevision();
  if (!space || !state.detail || revision === null) return;
  const cycleId = state.detail.id;
  const completed = await performAction(`delete-${cycleId}`, `/api/growth/spaces/${encodeURIComponent(space.id)}/cycles/${encodeURIComponent(cycleId)}`, 'DELETE', { expectedRevision: revision }, async (result) => {
    state.deletionReceipt = {
      id: typeof result?.deletionReceiptId === 'string' ? result.deletionReceiptId : '기록 없음',
      completedAt: result?.completedAt,
    };
    state.selectedCycleId = '';
    state.detail = null;
    closeDeleteConfirmation(false);
    await loadGrowthLab();
  });
  if (!completed) closeDeleteConfirmation();
}

function renderActionError(root) {
  if (!state.actionError) return;
  const error = state.actionError;
  const guidance = actionErrorGuidance(error);
  const panel = element('section', 'growth-action-error');
  panel.setAttribute('role', 'alert');
  panel.append(
    element('h2', 'growth-action-error-title', error.savedFollowUp ? '후속 훈련은 저장되었지만 화면을 열지 못했습니다' : '요청한 변경을 완료하지 못했습니다'),
    element('p', 'growth-action-error-copy', `상태: ${error.status || '기록 없음'}. 코드: ${error.code}.`),
    element('p', 'growth-action-error-copy', `단계: ${error.phase || '기록 없음'}.`),
    element('p', 'growth-action-error-copy', `원인 범주: ${guidance.category}. 다음 행동: ${guidance.next}`),
  );
  if (Number.isSafeInteger(error.expectedRevision)) {
    panel.append(element('p', 'growth-action-error-copy', `현재 기록은 리비전 ${String(error.expectedRevision)}을(를) 요구합니다. 새로고침한 뒤 다시 시도하세요.`));
  }
  if (error.requestId) panel.append(element('p', 'growth-request-id', `Request ID: ${error.requestId}`));
  const actions = element('div', 'growth-inline-actions');
  actions.append(button(error.status === 409 ? '현재 기록 다시 불러오기' : '기록 새로고침', 'growth-button growth-button-secondary', () => loadGrowthLab()));
  if (state.retryAction && error.retryable) actions.append(button(error.savedFollowUp ? '훈련 화면 다시 열기' : '같은 요청 다시 시도', 'growth-button growth-button-primary', state.retryAction));
  panel.append(actions);
  root.append(panel);
}

function renderConsentFirst(root) {
  const intro = element('section', 'growth-consent-intro');
  intro.append(
    element('p', 'growth-eyebrow', '학습자 전용 비공개 공간'),
    element('h2', 'growth-section-title', '비공개 성장 실험실 만들기'),
    element('p', 'growth-lede', '근거 → 선택 → 연습 → 재확인 순서를 자발적으로 진행합니다. 이 첫 공간은 비공개이며 공유되지 않고, 순위·임상 평가·고용 기록이 아닙니다.'),
  );
  root.append(intro);

  renderPendingOrigin(root, false);

  const recovery = element('section', 'growth-setup-recovery');
  recovery.setAttribute('aria-labelledby', 'growth-setup-recovery-title');
  recovery.append(
    element('h3', 'growth-record-title', state.provisionedConsent ? '동의 저장됨 · 비공개 공간 생성 필요' : '기존 비공개 설정 이어가기'),
    element('p', 'growth-record-meta', state.provisionedConsent
      ? `동의 영수증 ${state.provisionedConsent.consentReceiptId}이(가) 이 브라우저 세션에 저장되었습니다. 다시 시도하면 비공개 SOLO 공간만 만들며 동의 영수증을 다시 제출하지 않습니다.`
      : '동의를 저장했지만 공간을 만들지 못했다면 동의를 다시 제출하지 않고 공간 만들기를 이어갈 수 있습니다.'),
    button(actionPending('solo-space') ? '비공개 공간을 만드는 중…' : '비공개 설정 이어가기', 'growth-button growth-button-secondary', () => provisionSoloSpace(), { disabled: Boolean(state.pendingAction) }),
    element('p', 'growth-record-boundary', '페이지를 완전히 새로고친 뒤에는 아직 공간에 연결되지 않은 동의 영수증을 이 목록에서 확인할 수 없습니다. 이전 동의 존재 여부는 여기서 UNKNOWN이며, 동의가 없다는 증거로 해석하지 않습니다.'),
  );
  root.append(recovery);
  if (state.provisionedConsent) return;

  const form = element('form', 'growth-consent-card');
  form.noValidate = true;
  form.append(
    element('h3', 'growth-record-title', KOREAN_JOURNEY_COPY.purposeConsent.title),
    element('p', 'growth-record-meta', KOREAN_JOURNEY_COPY.purposeConsent.explanation),
    field('학습 목적', 'purpose', 'text', '이 공간에서 이루려는 학습 목적을 적어 주세요', '', true),
    field('사용 데이터 범주', 'dataClasses', 'text', '예: 본인 소유 학습 근거, 연습 선택', '', true),
    field('보관 정책', 'retentionPolicy', 'text', '동의하는 보관 정책을 적어 주세요', '', true),
    field('정책 버전', 'policyRevision', 'number', '', '1', true),
  );
  const boundary = element('aside', 'growth-policy-note');
  boundary.append(
    element('h4', 'growth-note-title', KOREAN_JOURNEY_COPY.retention.title),
    element('p', 'growth-note-copy', `${KOREAN_JOURNEY_COPY.retention.explanation} 이 첫 경로는 비공개 SOLO 전용이며 커뮤니티 피드, 공개 점수 또는 순위를 제공하지 않습니다.`),
  );
  form.append(boundary);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitConsent(form);
  });
  const consentActions = element('div', 'growth-inline-actions');
  consentActions.append(
    button(actionPending('private-consent') ? '비공개 동의를 저장하는 중…' : KOREAN_JOURNEY_COPY.purposeConsent.action, 'growth-button growth-button-primary', null, { disabled: Boolean(state.pendingAction), type: 'submit' }),
    button(KOREAN_JOURNEY_COPY.optOutBeforeConsent.action, 'growth-button growth-button-secondary', clearPendingOrigin, { disabled: Boolean(state.pendingAction) }),
  );
  form.append(element('p', 'growth-record-boundary', KOREAN_JOURNEY_COPY.optOutBeforeConsent.explanation), consentActions);
  root.append(form);
}

function renderPendingOrigin(root, readyToConfirm) {
  const origin = state.pendingOrigin;
  if (!origin) return;
  const section = element('section', 'growth-policy-note');
  section.setAttribute('role', 'status');
  section.append(
    element('h2', 'growth-note-title', readyToConfirm ? '완료한 시도를 확인할 준비가 됐습니다' : '완료한 시도를 이 브라우저에 보관 중입니다'),
    element('p', 'growth-note-copy', `완료한 ${origin.originKind} 시도에서 임시 출발점 UNKNOWN을 열 수 있습니다. 기존 점수나 약점 표시가 검증되었다는 뜻은 아닙니다.`),
    element('p', 'growth-record-boundary', readyToConfirm
      ? '이 주기를 여는 것은 비공개 공간을 만든 뒤 별도로 확인하는 명시적 행동입니다.'
      : '비공개 설정을 완료하고 직접 확인하기 전에는 주기를 만들지 않습니다.'),
  );
  const actions = element('div', 'growth-inline-actions');
  if (readyToConfirm) {
    const pending = originActionPending(origin);
    actions.append(button(
      pending ? KOREAN_JOURNEY_COPY.trainingGrowthCta.opening : KOREAN_JOURNEY_COPY.trainingGrowthCta.open,
      'growth-button growth-button-primary',
      () => openGrowthCycleFromOrigin(origin),
      { disabled: pending || Boolean(state.pendingAction) },
    ));
  }
  actions.append(button('대기 중인 시도 지우기', 'growth-button growth-button-secondary', clearPendingOrigin, { disabled: Boolean(state.pendingAction) }));
  section.append(actions);
  root.append(section);
}

function renderListRefreshWarning(root) {
  const warning = state.listRefreshWarning;
  if (!warning) return;
  const section = element('section', 'growth-policy-note');
  section.setAttribute('role', 'status');
  section.append(
    element('h2', 'growth-note-title', '주기 열림 · 목록 새로고침 불가'),
    element('p', 'growth-note-copy', '선택한 비공개 성장 주기는 정상적으로 열렸습니다. 제한된 주기 목록을 새로고침하지 못했지만 열린 주기의 결과는 바뀌지 않습니다.'),
    element('p', 'growth-record-boundary', `코드: ${warning.code}. 단계: ${warning.phase}.`),
  );
  if (warning.requestId) section.append(element('p', 'growth-request-id', `Request ID: ${warning.requestId}`));
  root.append(section);
}

function field(label, name, type, placeholder, value, required) {
  const wrapper = element('label', 'growth-field');
  wrapper.append(element('span', 'growth-field-label', label));
  const input = element('input', 'growth-input');
  input.name = name;
  input.type = type;
  input.placeholder = placeholder;
  input.value = value;
  input.required = Boolean(required);
  if (type === 'number') {
    input.min = '1';
    input.step = '1';
  }
  wrapper.append(input);
  return wrapper;
}

function renderPrivacyScope(root, space) {
  const scope = element('section', 'growth-privacy-scope');
  scope.setAttribute('aria-labelledby', 'growth-privacy-title');
  const heading = element('div', 'growth-section-heading');
  const copy = element('div');
  const title = element('h2', 'growth-section-title', '비공개 학습 범위');
  title.id = 'growth-privacy-title';
  copy.append(title, element('p', 'growth-section-copy', '나만 보는 학습 기록입니다. 무엇을 다시 살펴볼지 직접 선택하세요.'));
  heading.append(copy, element('span', 'growth-status growth-status-private', '비공개'));
  const values = element('dl', 'growth-definition-grid');
  values.append(
    definitionItem('동의 기록 식별자', space.consent?.receiptId),
    definitionItem('이용 목적', space.consent?.purpose),
    definitionItem('데이터 범주', arrayValue(space.consent?.dataClasses).join(', ') || '기록 없음'),
    definitionItem('보관 정책', space.consent?.retentionPolicy),
    definitionItem('정책 버전', space.consent?.policyRevision),
    definitionItem('동의한 시각', timestamp(space.consent?.issuedAt), true),
    definitionItem('공간 버전', space.aggregateRevision, true),
  );
  const projectionBoundary = element('aside', 'growth-policy-note');
  projectionBoundary.append(
    element('h3', 'growth-note-title', '확인되지 않은 정보'),
    element('p', 'growth-note-copy', KOREAN_JOURNEY_COPY.uncertainty.explanation),
  );
  const revoke = element('div', 'growth-consent-revoke');
  revoke.append(
    element('h3', 'growth-subsection-title', KOREAN_JOURNEY_COPY.revocation.title),
    element('p', 'growth-section-copy', KOREAN_JOURNEY_COPY.revocation.explanation),
  );
  if (!state.consentRevocationOpen) {
    revoke.append(button(KOREAN_JOURNEY_COPY.revocation.action, 'growth-button growth-button-secondary', () => { state.consentRevocationOpen = true; render(); }, { disabled: Boolean(state.pendingAction) }));
  } else {
    const confirmation = element('div', 'growth-consent-revoke-confirmation');
    confirmation.setAttribute('role', 'alert');
    confirmation.append(
      element('p', 'growth-note-copy', '확인하면 이 비공개 공간에 대한 접근을 보관 처리합니다. 특정 주기의 통제된 삭제를 원할 때만 별도의 주기 삭제 기능을 사용하세요.'),
      button(actionPending(`revoke-consent-${space.consent?.receiptId}`) ? '동의를 철회하는 중…' : KOREAN_JOURNEY_COPY.revocation.confirm, 'growth-button growth-button-danger', () => revokePrivateConsent(space.consent?.receiptId), { disabled: Boolean(state.pendingAction) }),
      button('취소', 'growth-button growth-button-secondary', () => { state.consentRevocationOpen = false; render(); }, { disabled: Boolean(state.pendingAction) }),
    );
    revoke.append(confirmation);
  }
  const management = recordDetails('이용 동의·보관 조건과 철회', values, projectionBoundary, revoke);
  management.open = state.consentRevocationOpen;
  scope.append(heading, management);
  root.append(scope);
}

function renderCycleList(root) {
  const section = element('section', 'growth-cycle-list');
  section.setAttribute('aria-labelledby', 'growth-cycle-list-title');
  const heading = element('div', 'growth-section-heading');
  const title = element('h2', 'growth-section-title', '성장 주기');
  title.id = 'growth-cycle-list-title';
  heading.append(title, button('새로고침', 'growth-button growth-button-secondary', () => loadGrowthLab(), { disabled: Boolean(state.activeMutation) }));
  section.append(heading);
  if (!state.cycles.length) {
    section.append(statePanel(
      '아직 성장 주기가 없습니다',
      '본인 소유의 저장된 Training 또는 Sparring 시도에서만 주기를 시작합니다. 이 화면은 원본을 만들어 내거나 요약 점수에서 주기를 열지 않습니다.',
      '사용 가능한 Training 또는 Sparring 시도를 먼저 완료하세요.',
    ));
    root.append(section);
    return;
  }
  const list = element('div', 'growth-cycle-options');
  for (const cycle of state.cycles) {
    const item = button('', 'growth-cycle-option', () => selectCycle(cycle.id), { disabled: Boolean(state.activeMutation) });
    item.classList.toggle('is-selected', cycle.id === state.selectedCycleId);
    item.setAttribute('aria-pressed', String(cycle.id === state.selectedCycleId));
    const content = element('span', 'growth-cycle-option-copy');
    content.append(
      element('span', 'growth-cycle-option-title', originLabel(cycle.originKind)),
      element('span', 'growth-cycle-option-meta', `시작 ${timestamp(cycle.openedAt)}`),
    );
    item.append(content, element('span', `growth-status growth-status-${String(cycle.state || 'UNKNOWN').toLowerCase()}`, statusText(cycle.state)));
    list.append(item);
  }
  section.append(list);
  root.append(section);
}

function renderCycleHeader(root, detail) {
  const [stateName, stateExplanation] = STATE_COPY[detail.state] || [statusText(detail.state), '현재 수명주기 상태를 기록하되 점수는 추론하지 않습니다.'];
  const header = element('section', 'growth-cycle-header');
  header.setAttribute('aria-labelledby', 'growth-cycle-title');
  const identity = element('div');
  const focus = arrayValue(detail.focuses).at(-1);
  const title = element('h2', 'growth-cycle-title', focus?.statement || '이번 학습에서 다시 살펴볼 생각');
  title.id = 'growth-cycle-title';
  identity.append(
    element('p', 'growth-eyebrow', `${originLabel(detail.originKind)} · ${timestamp(detail.openedAt)}`),
    title,
    element('p', 'growth-lede', stateExplanation),
  );
  header.append(identity, element('span', `growth-status growth-status-${String(detail.state || 'UNKNOWN').toLowerCase()}`, stateName));
  const facts = element('dl', 'growth-definition-grid growth-cycle-facts');
  facts.append(
    definitionItem('시작한 학습 경로', detail.originKind),
    definitionItem('원본 시도 식별자', detail.originAttemptId),
    definitionItem('원본 답변 차례', detail.originTurnNumber),
    definitionItem('주기 버전', detail.aggregateRevision),
    definitionItem('시작한 시각', timestamp(detail.openedAt), true),
    definitionItem('마지막 변경', timestamp(detail.updatedAt), true),
  );
  header.append(recordDetails('이 학습 기록의 출처와 버전', facts));
  const source = element('div', 'growth-inline-actions');
  source.append(button('이전 시도의 원본 대화와 근거 열기', 'growth-button growth-button-secondary', () => {
    if (typeof window.viewHistoryDetail === 'function') {
      window.viewHistoryDetail(detail.originAttemptId, detail.originKind === 'TRAINING' ? 'training' : 'sparring');
    } else announceGrowthStatus('원본 기록 화면을 현재 열 수 없습니다. 잠시 후 다시 시도해 주세요.');
  }, { disabled: !detail.originAttemptId || !['SPARRING', 'TRAINING'].includes(detail.originKind) }));
  header.append(source);
  root.append(header);
}

function renderOutcomeBoundary(root, detail) {
  const measured = arrayValue(detail.observations).filter((observation) => observation.status === 'MEASURED');
  const scheduled = arrayValue(detail.rechecks).find((recheck) => !recheck.recordedAt);
  const recorded = arrayValue(detail.rechecks).find((recheck) => recheck.recordedAt);
  const section = element('section', 'growth-outcome-boundary');
  section.setAttribute('aria-labelledby', 'growth-outcome-boundary-title');
  const title = element('h3', 'growth-subsection-title', '이 기록으로 알 수 있는 것');
  title.id = 'growth-outcome-boundary-title';
  const grid = element('dl', 'growth-outcome-grid');
  grid.append(
    definitionItem('참여도', '이 주기에서는 측정하지 않음'),
    definitionItem('관찰 기록', measured.length ? `${measured.length}건 · 숙달 판정과는 다름` : '측정된 관찰값 없음 · 능력 판정 불가'),
    definitionItem('시간을 둔 재확인', scheduled ? `${timestamp(scheduled.scheduledFor)} 예약` : recorded ? '시도 기록 있음 · 학습 유지 효과는 별도 확인 필요' : '기록 없음'),
    definitionItem('다른 상황에 적용하기', detail.state === 'TRANSFER_PENDING' ? '검증 대기 중' : '검증된 결과 없음'),
  );
  section.append(title, element('p', 'growth-section-copy', KOREAN_JOURNEY_COPY.practice.explanation), grid);
  root.append(section);
}

function renderObservation(observation) {
  const body = element('div', 'growth-record-body');
  const values = element('dl', 'growth-definition-grid');
  const measuredValue = observation.status === 'MEASURED' && Number.isFinite(observation.valueNumeric)
    ? `${observation.valueNumeric}${observation.valueScale ? ` (${observation.valueScale})` : ''}`
    : '기록 없음';
  const unknownReason = observation.status === 'UNKNOWN'
    ? '관찰 결과를 확인할 수 없습니다. 이 화면의 정보만으로 원인이나 능력을 판단할 수 없으며, 확인되지 않은 이유와 원문 구간 전체가 제공되는 것은 아닙니다.'
    : null;
  values.append(
    definitionItem('관찰 식별자', observation.id),
    definitionItem('관찰 항목', observation.capabilityId),
    definitionItem('관찰 항목 버전', observation.capabilityRevision),
    definitionItem('관찰값', measuredValue),
    definitionItem('추론 검증 상태', observation.inferenceValidation),
    definitionItem('추론 규칙', `${observation.inferenceRuleId} · rev ${displayValue(observation.inferenceRuleRevision)}`),
    definitionItem('관찰한 시각', timestamp(observation.observedAt), true),
  );
  body.append(element('p', 'growth-statement', observation.status === 'MEASURED'
    ? `기록된 관찰값: ${measuredValue}. 이 수치만으로 이해나 숙달을 판단하지 않습니다.`
    : '이 관찰로 능력을 판단할 수 없습니다.'),
    recordDetails('관찰 항목·계산 규칙과 근거 식별자', values, evidenceList('근거 이벤트 식별자', observation.evidenceEventIds)));
  if (unknownReason) body.append(element('p', 'growth-unknown-reason', unknownReason));
  if (observation.status !== 'MEASURED') body.append(element('p', 'growth-record-boundary', '측정값이 확인되지 않아 숫자를 표시하지 않습니다.'));
  return recordCard('학습 중 관찰', `기록 ${timestamp(observation.recordedAt)}`, observation.status, body);
}

function renderGapActions(body, hypothesis) {
  const cycleState = state.detail?.state;
  if (cycleState === 'GAP_PROPOSED' && hypothesis.state === 'PROPOSED') {
    const actions = element('div', 'growth-inline-actions');
    actions.append(
      button(actionPending(`gap-accept-${hypothesis.id}`) ? '수락하는 중…' : '가설 수락', 'growth-button growth-button-primary', () => submitGap('accept', hypothesis.id), { disabled: Boolean(state.pendingAction) }),
      button(KOREAN_JOURNEY_COPY.contest.action, 'growth-button growth-button-secondary', () => { state.gapContestId = hypothesis.id; render(); }, { disabled: Boolean(state.pendingAction) }),
      button('기각', 'growth-button growth-button-secondary', () => submitGap('dismiss', hypothesis.id), { disabled: Boolean(state.pendingAction) }),
      button('보류', 'growth-button growth-button-secondary', () => submitGap('defer', hypothesis.id), { disabled: Boolean(state.pendingAction) }),
    );
    body.append(actions);
  }
  if (state.gapContestId === hypothesis.id) {
    const form = element('form', 'growth-inline-form');
    form.append(
      element('h4', 'growth-record-title', KOREAN_JOURNEY_COPY.correction.title),
      element('p', 'growth-record-boundary', KOREAN_JOURNEY_COPY.correction.explanation),
    );
    const label = element('label', 'growth-field');
    label.append(element('span', 'growth-field-label', '이 과제 수준의 가설에 이의를 제기하는 이유는 무엇인가요?'));
    const rationale = element('textarea', 'growth-textarea');
    rationale.name = 'rationale';
    rationale.required = true;
    rationale.maxLength = 2000;
    rationale.placeholder = '가설이 놓친 근거, 맥락 또는 추론을 적어 주세요.';
    label.append(rationale);
    form.append(label);
    const actions = element('div', 'growth-inline-actions');
    actions.append(
      button(KOREAN_JOURNEY_COPY.contest.submit, 'growth-button growth-button-primary', null, { disabled: Boolean(state.pendingAction), type: 'submit' }),
      button('취소', 'growth-button growth-button-secondary', () => { state.gapContestId = ''; render(); }),
    );
    form.append(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = rationale.value.trim();
      if (!text) {
        state.actionError = { code: 'GROWTH_GAP_RATIONALE_INVALID', phase: 'validation', retryable: false, requestId: null, expectedRevision: null };
        render();
        return;
      }
      state.gapContestId = '';
      submitGap('contest', hypothesis.id, text);
    });
    body.append(form);
  }
  if (cycleState === 'GAP_CONTESTED' && hypothesis.state === 'CONTESTED') {
    const actions = element('div', 'growth-inline-actions');
    actions.append(
      button('기각', 'growth-button growth-button-secondary', () => submitGap('dismiss', hypothesis.id), { disabled: Boolean(state.pendingAction) }),
      button('UNKNOWN으로 종료', 'growth-button growth-button-secondary', () => submitGap('close_unknown', hypothesis.id), { disabled: Boolean(state.pendingAction) }),
    );
    body.append(actions);
  }
  if (cycleState === 'GAP_DEFERRED' && hypothesis.state === 'DEFERRED') {
    const actions = element('div', 'growth-inline-actions');
    actions.append(
      button('다시 시작', 'growth-button growth-button-primary', () => submitGap('resume', hypothesis.id), { disabled: Boolean(state.pendingAction) }),
      button('기각', 'growth-button growth-button-secondary', () => submitGap('dismiss', hypothesis.id), { disabled: Boolean(state.pendingAction) }),
      button('UNKNOWN으로 종료', 'growth-button growth-button-secondary', () => submitGap('close_unknown', hypothesis.id), { disabled: Boolean(state.pendingAction) }),
    );
    body.append(actions);
  }
}

function renderHypothesis(hypothesis) {
  const body = element('div', 'growth-record-body');
  body.append(element('p', 'growth-statement', hypothesis.statement || '기록된 과제 수준 진술이 없습니다.'));
  const values = element('dl', 'growth-definition-grid');
  values.append(
    definitionItem('제안 식별자', hypothesis.id),
    definitionItem('관찰 식별자', hypothesis.observationId),
    definitionItem('관찰 항목', `${displayValue(hypothesis.capabilityId)} · rev ${displayValue(hypothesis.capabilityRevision)}`),
    definitionItem('제안 규칙', `${displayValue(hypothesis.gapRuleId)} · rev ${displayValue(hypothesis.gapRuleRevision)}`),
    definitionItem('출처 버전', hypothesis.sourceRevision),
    definitionItem('내가 남긴 이유', hypothesis.participantRationale),
  );
  if (hypothesis.participantRationale) body.append(element('p', 'growth-record-copy', `내가 남긴 이유: ${hypothesis.participantRationale}`));
  body.append(recordDetails('제안의 규칙과 근거 식별자', values, evidenceList('뒷받침하는 근거 식별자', hypothesis.supportingEventIds), evidenceList('반대 근거 식별자', hypothesis.contradictingEventIds)));
  if (hypothesis.revisesHypothesisId) body.append(element('p', 'growth-record-boundary', `정정 대상 가설: ${hypothesis.revisesHypothesisId}. ${hypothesis.revisionRationale || '기록된 정정 이유가 없습니다.'}`));
  renderGapActions(body, hypothesis);
  return recordCard('함께 검토할 제안', `수정 ${timestamp(hypothesis.updatedAt)}`, hypothesis.state, body);
}

function renderFocusControl(root, detail) {
  if (detail.state !== 'GAP_UNKNOWN') return;
  const section = element('section', 'growth-focus-control');
  section.setAttribute('aria-labelledby', 'growth-focus-title');
  const title = element('h3', 'growth-subsection-title', KOREAN_JOURNEY_COPY.focus.title);
  title.id = 'growth-focus-title';
  section.append(title, element('p', 'growth-section-copy', KOREAN_JOURNEY_COPY.focus.explanation));
  if (!state.focusFormOpen) {
    section.append(button(KOREAN_JOURNEY_COPY.focus.action, 'growth-button growth-button-primary', () => { state.focusFormOpen = true; render(); }, { disabled: Boolean(state.pendingAction) }));
    root.append(section);
    return;
  }
  const form = element('form', 'growth-focus-form');
  const options = Array.from(new Map(arrayValue(detail.observations)
    .filter((observation) => typeof observation.capabilityId === 'string' && observation.capabilityRevision === 1)
    .map((observation) => [observation.capabilityId, { value: observation.capabilityId, label: `${observation.capabilityId} · revision 1` }]))
    .values());
  if (!options.length) {
    section.append(element('p', 'growth-record-boundary', '비공개 초점을 만들려면 리비전 1의 명시적인 관찰 능력이 필요합니다. 이 공개 투영에는 해당 기록이 없어 초점을 만들 수 없습니다.'));
    section.append(button('돌아가기', 'growth-button growth-button-secondary', () => { state.focusFormOpen = false; render(); }));
    root.append(section);
    return;
  }
  const selectLabel = element('label', 'growth-field');
  selectLabel.append(element('span', 'growth-field-label', '관찰된 능력 (필수)'));
  const select = element('select', 'growth-select');
  select.name = 'capability';
  select.required = true;
  for (const optionData of options) {
    const option = element('option', '', optionData.label);
    option.value = optionData.value;
    select.append(option);
  }
  selectLabel.append(select);
  const revisionLabel = element('label', 'growth-field');
  revisionLabel.append(element('span', 'growth-field-label', '능력 리비전 (필수)'));
  const revisionInput = element('input', 'growth-input');
  revisionInput.name = 'capabilityRevision';
  revisionInput.type = 'number';
  revisionInput.value = '1';
  revisionInput.min = '1';
  revisionInput.max = '1';
  revisionInput.step = '1';
  revisionInput.required = true;
  revisionInput.readOnly = true;
  revisionLabel.append(revisionInput);
  const statement = element('label', 'growth-field');
  statement.append(element('span', 'growth-field-label', '무엇을 연습하고 싶나요?'));
  const statementInput = element('textarea', 'growth-textarea');
  statementInput.name = 'statement';
  statementInput.maxLength = 2000;
  statementInput.required = true;
  statementInput.placeholder = '연습할 구체적인 추론 또는 문제 해결 행동을 적어 주세요.';
  statement.append(statementInput);
  const reason = element('label', 'growth-field');
  reason.append(element('span', 'growth-field-label', '이 초점을 고른 이유 (선택)'));
  const reasonInput = element('input', 'growth-input');
  reasonInput.name = 'reason';
  reasonInput.maxLength = 2000;
  reason.append(reasonInput);
  const actions = element('div', 'growth-inline-actions');
  actions.append(
    button('비공개 초점 저장', 'growth-button growth-button-primary', null, { disabled: Boolean(state.pendingAction), type: 'submit' }),
    button('취소', 'growth-button growth-button-secondary', () => { state.focusFormOpen = false; render(); }),
  );
  form.append(selectLabel, revisionLabel, statement, reason, actions);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    state.focusFormOpen = false;
    submitFocus(form);
  });
  section.append(form);
  root.append(section);
}

function renderHumanReviewRequest(root, detail) {
  const section = element('section', 'growth-human-review-request');
  section.setAttribute('role', 'status');
  section.setAttribute('aria-labelledby', 'growth-human-review-title');
  const pending = state.humanReviewRequest?.cycleId === detail.id && state.humanReviewRequest.state === 'PENDING';
  const title = element(
    'h3',
    'growth-subsection-title',
    pending ? KOREAN_JOURNEY_COPY.humanReviewPending.title : '사람의 검토 요청',
  );
  title.id = 'growth-human-review-title';
  const explanation = element(
    'p',
    'growth-section-copy',
    pending
      ? KOREAN_JOURNEY_COPY.humanReviewPending.explanation
      : '본인 비공개 주기의 검토 요청을 보낼 수 있습니다. 요청 결과는 PENDING으로만 남습니다.',
  );
  explanation.id = 'growth-human-review-copy';
  section.append(title, explanation);
  if (pending) {
    section.append(element('span', 'growth-status growth-status-pending', KOREAN_JOURNEY_COPY.humanReviewPending.protocolId));
  } else {
    section.append(button(
      KOREAN_JOURNEY_COPY.humanReviewPending.action,
      'growth-button growth-button-primary',
      requestHumanReview,
      { disabled: Boolean(state.pendingAction), describedBy: explanation.id },
    ));
  }
  root.append(section);
}

function renderFocus(focus) {
  const body = element('div', 'growth-record-body');
  body.append(element('p', 'growth-statement', focus.statement || '기록된 초점 진술이 없습니다.'));
  const values = element('dl', 'growth-definition-grid');
  values.append(
    definitionItem('초점 선택 식별자', focus.id),
    definitionItem('선택 유형', focus.selectionKind),
    definitionItem('관찰 항목', focus.capabilityId ? `${focus.capabilityId} · rev ${displayValue(focus.capabilityRevision)}` : '기록 없음'),
    definitionItem('선택한 이유', focus.reason),
    definitionItem('기록한 시각', timestamp(focus.createdAt), true),
  );
  if (focus.reason) body.append(element('p', 'growth-record-copy', `선택한 이유: ${focus.reason}`));
  body.append(recordDetails('초점 선택 기록과 연결 정보', values), element('p', 'growth-record-boundary', KOREAN_JOURNEY_COPY.focus.explanation));
  return recordCard('내가 선택한 학습 초점', '', focus.selectionKind || 'UNKNOWN', body);
}

function renderLifecycleBoundaryActions(root, detail) {
  const section = element('section', 'growth-lifecycle-actions');
  section.setAttribute('aria-labelledby', 'growth-lifecycle-actions-title');
  const title = element('h3', 'growth-subsection-title', '다음에 무엇을 할까요?');
  title.id = 'growth-lifecycle-actions-title';
  section.append(title);
  const actions = element('div', 'growth-inline-actions');
  const hypotheses = arrayValue(detail.hypotheses);
  const quests = arrayValue(detail.quests);
  if (detail.state === 'GAP_UNKNOWN') {
    section.append(element('p', 'growth-section-copy', '위에서 학습 초점을 선택하거나 가능한 근거 검증을 다시 시도하거나 이 주기를 UNKNOWN으로 종료할 수 있습니다. 재시도는 근거가 유효해졌다는 뜻이 아닙니다.'));
    actions.append(
      button('근거 검증 다시 시도', 'growth-button growth-button-secondary', () => submitGap('retry_evidence'), { disabled: Boolean(state.pendingAction) }),
      button('UNKNOWN으로 종료', 'growth-button growth-button-secondary', () => submitGap('close_unknown'), { disabled: Boolean(state.pendingAction) }),
    );
  } else if (detail.state === 'GAP_CONTESTED') {
    section.append(element('p', 'growth-section-copy', '더 새로운 검증 근거나 검증된 규칙 리비전이 기록된 뒤에만 정정 제안이 나타날 수 있습니다. 이 화면은 정정을 만들어 내지 않습니다. 위에서 이의를 제기한 가설을 기각하거나 종료할 수 있습니다.'));
  } else if (detail.state === 'GAP_DISMISSED') {
    const dismissed = hypotheses.find((hypothesis) => hypothesis.state === 'DISMISSED');
    section.append(element('p', 'growth-section-copy', '가설을 기각해도 성장 결과는 생성되지 않습니다. 결과 주장 없이 주기를 종료할 수 있습니다.'));
    actions.append(button('기각한 주기 종료', 'growth-button growth-button-secondary', () => submitGap('close', dismissed?.id), { disabled: Boolean(state.pendingAction) }));
  } else if (detail.state === 'PRACTICE_ACCEPTED') {
    const accepted = quests.find((quest) => quest.status === 'ACCEPTED');
    if (!accepted) return;
    section.append(element('p', 'growth-section-copy', '예약이 완료되지 않았다면 기록된 연습 예약 경로를 다시 시도하거나 성장 결과 없이 종료하세요.'));
    actions.append(
      button('재확인 예약 다시 시도', 'growth-button growth-button-secondary', () => submitPractice('retry_schedule', accepted.id), { disabled: Boolean(state.pendingAction) }),
      button('UNKNOWN으로 종료', 'growth-button growth-button-secondary', () => submitPractice('close_unknown', accepted.id), { disabled: Boolean(state.pendingAction) }),
    );
  } else if (detail.state === 'PRACTICE_DECLINED') {
    const declined = quests.find((quest) => quest.status === 'DECLINED');
    section.append(element('p', 'growth-section-copy', '연습을 거절해도 성장 결과는 생성되지 않습니다. 거절한 경로를 종료할 수 있습니다.'));
    actions.append(button('거절한 경로 종료', 'growth-button growth-button-secondary', () => submitPractice('close', declined?.id), { disabled: Boolean(state.pendingAction) }));
  } else if (detail.state === 'RECHECKED') {
    section.append(element('p', 'growth-section-copy', '비교 계약이 결과를 허용하기 전까지 기록된 재확인 결과는 UNKNOWN입니다. 검증된 비교 없이 종료할 수 있습니다.'));
    actions.append(button('검증된 비교 없이 종료', 'growth-button growth-button-secondary', () => submitRecheck('close'), { disabled: Boolean(state.pendingAction) }));
  } else if (detail.state === 'TRANSFER_PENDING') {
    section.append(element('p', 'growth-section-copy', '이 경로에서는 전이 검증을 사용할 수 없습니다. 재시도해도 닫힌 상태를 유지하며 전이 결과를 만들어 내지 않습니다.'));
    actions.append(button('전이 검증 다시 시도', 'growth-button growth-button-secondary', () => submitRecheck('retry_transfer'), { disabled: Boolean(state.pendingAction) }));
  } else {
    return;
  }
  section.append(actions);
  root.append(section);
}

function renderPracticeActions(body, quest) {
  const cycleState = state.detail?.state;
  if (cycleState === 'PRACTICE_OFFERED' && quest.status === 'OFFERED') {
    const actions = element('div', 'growth-inline-actions');
    actions.append(
      button(KOREAN_JOURNEY_COPY.practice.accept, 'growth-button growth-button-primary', () => submitPractice('accept', quest.id), { disabled: Boolean(state.pendingAction) }),
      button(KOREAN_JOURNEY_COPY.practice.decline, 'growth-button growth-button-secondary', () => submitPractice('decline', quest.id), { disabled: Boolean(state.pendingAction) }),
      button(KOREAN_JOURNEY_COPY.practice.defer, 'growth-button growth-button-secondary', () => { state.practiceDeferId = quest.id; render(); }, { disabled: Boolean(state.pendingAction) }),
    );
    body.append(actions);
  }
  if (state.practiceDeferId === quest.id) {
    const form = element('form', 'growth-inline-form');
    const label = element('label', 'growth-field');
    label.append(element('span', 'growth-field-label', '다시 살펴볼 시각'));
    const input = element('input', 'growth-input');
    input.type = 'datetime-local';
    input.name = 'revisitAt';
    input.required = true;
    label.append(input);
    const actions = element('div', 'growth-inline-actions');
    actions.append(
      button('보류 저장', 'growth-button growth-button-primary', null, { disabled: Boolean(state.pendingAction), type: 'submit' }),
      button('취소', 'growth-button growth-button-secondary', () => { state.practiceDeferId = ''; render(); }),
    );
    form.append(label, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const revisitAt = new Date(input.value).getTime();
      if (!Number.isFinite(revisitAt) || revisitAt <= Date.now()) {
        state.actionError = { code: 'GROWTH_REVISIT_TIME_REQUIRED', phase: 'validation', retryable: false, requestId: null, expectedRevision: null };
        render();
        return;
      }
      state.practiceDeferId = '';
      submitPractice('defer', quest.id, revisitAt);
    });
    body.append(form);
  }
  if (cycleState === 'PRACTICE_DEFERRED' && quest.status === 'DEFERRED') {
    const actions = element('div', 'growth-inline-actions');
    actions.append(
      button('다시 시작', 'growth-button growth-button-primary', () => submitPractice('resume', quest.id), { disabled: Boolean(state.pendingAction) }),
      button('UNKNOWN으로 종료', 'growth-button growth-button-secondary', () => submitPractice('close_unknown', quest.id), { disabled: Boolean(state.pendingAction) }),
    );
    body.append(actions);
  }
}

function renderQuest(quest) {
  const body = element('div', 'growth-record-body');
  const values = element('dl', 'growth-definition-grid');
  values.append(
    definitionItem('연습 식별자', quest.id),
    definitionItem('연습 유형', quest.questType),
    definitionItem('제안 식별자', quest.gapHypothesisId),
    definitionItem('초점 선택 식별자', quest.focusSelectionId),
    definitionItem('학습 목적', quest.learningPurpose),
    definitionItem('제안 이유', quest.selectionReason),
    definitionItem('연습 규칙', `${quest.practiceRuleId} · rev ${displayValue(quest.practiceRuleRevision)}`),
    definitionItem('재확인 간격', `${displayValue(quest.targetRetentionHorizonHours)} hours`),
    definitionItem('다시 살펴볼 시각', quest.revisitAt ? timestamp(quest.revisitAt) : '일정 없음'),
  );
  body.append(element('p', 'growth-statement', quest.learningPurpose === 'Practice the learner-selected capability with a variant task.'
    ? '내가 고른 학습 초점을 조건이 달라진 문제에서 다시 살펴봅니다.' : quest.learningPurpose || '기록된 연습 목적이 없습니다.'),
    element('p', 'growth-record-copy', quest.selectionReason === 'learner-chosen focus'
      ? '내가 직접 고른 초점을 바탕으로 제안된 연습입니다.' : quest.selectionReason || '이 연습을 제안한 이유가 기록되지 않았습니다.'),
    element('p', 'growth-record-copy', `재확인 간격: ${displayValue(quest.targetRetentionHorizonHours)}시간 · ${quest.revisitAt ? `다시 살펴볼 시각 ${timestamp(quest.revisitAt)}` : '다시 살펴볼 시각 미정'}`),
    recordDetails('연습 유형·규칙과 연결 정보', values));
  renderPracticeActions(body, quest);
  return recordCard('내가 선택할 연습', `제안 ${timestamp(quest.createdAt)}`, quest.status, body);
}

async function enterFollowUpTraining(launch) {
  const bridge=window.SocraticAI || window.SocraticModules;
  if(typeof bridge?.switchTab!=='function')throw new GrowthLabActionError('GROWTH_NAVIGATION_UNAVAILABLE','unavailable',true);
  try{
    const sparring=launch.originKind==='SPARRING';
    const opened=await bridge.switchTab(sparring?'sparring':'training',{focusDestination:true});
    if(opened===false)throw new GrowthLabActionError('GROWTH_NAVIGATION_FAILED','unavailable',true);
    const action=sparring ? (launch.sessionId ? window.resumeSession : window.startSparringFollowUp) : (launch.sessionId?window.resumeTrainingSession:window.startTrainingFollowUp);
    if(typeof action!=='function')throw new GrowthLabActionError('GROWTH_TRAINING_MODULE_UNAVAILABLE','unavailable',true);
    const resumed=await action(launch.sessionId || launch, sparring ? 'sparring' : undefined);
    if(resumed===false)throw new GrowthLabActionError('GROWTH_NAVIGATION_FAILED','unavailable',true);
  }catch(error){await bridge.switchTab('growth-lab',{focusDestination:true});throw error;}
}
async function navigateSavedFollowUp(launch) {
  try{await enterFollowUpTraining(launch);state.actionError=null;state.retryAction=null;}
  catch(error){state.actionError={...safeActionError(error),savedFollowUp:true};state.retryAction=()=>navigateSavedFollowUp(launch);render();}
}
async function openGrowthRecheck(link) {
  if(!link || typeof link.spaceId!=='string' || !link.spaceId || typeof link.cycleId!=='string' || !link.cycleId) throw new GrowthLabActionError('GROWTH_NAVIGATION_TARGET_INVALID','validation',false);
  await navigateToGrowthLab();const generation=++state.requestGeneration;
  state.selectedSpaceId=link.spaceId;state.selectedCycleId=link.cycleId;
  await loadCycles(link.spaceId,generation);await loadCycle(link.cycleId,generation,false);
  render();focusSelectedGrowthDetail();
}
function renderRecheckControls(body, recheck) {
  if(state.detail?.state!=='RECHECK_SCHEDULED'||recheck.recordedAt)return;
  const launch=recheck.followUpLaunch;const busy=Boolean(state.pendingAction);const early=Date.now()<recheck.scheduledFor;
  if(state.recheckFormId!==recheck.id&&state.recheckFormId!==`${recheck.id}:reschedule`){
    const actions=element('div','growth-inline-actions');
    if(['TRAINING','SPARRING'].includes(state.detail.originKind)){
      if(!launch)actions.append(button(state.detail.originKind==='SPARRING'?'조건을 바꿔 후속 대화 시작':'조건을 바꿔 후속 훈련 시작','growth-button growth-button-primary',()=>{state.recheckFormId=recheck.id;render();},{disabled:busy||early}));
      else{
        if(launch.sessionCompleted ?? launch.completed)actions.append(button('완료한 후속 시도 기록','growth-button growth-button-primary',()=>submitRecheck('record',recheck.id,{followUpLaunchId:launch.id}),{disabled:busy||early}));
        else actions.append(button(state.detail.originKind==='SPARRING'?(launch.sessionId?'후속 대화 이어가기':'후속 대화 시작'):(launch.sessionId?'후속 훈련 이어가기':'후속 훈련 자료 선택'),'growth-button growth-button-primary',()=>navigateSavedFollowUp({...launch,originKind:state.detail.originKind,launchId:launch.id,spaceId:state.selectedSpaceId,cycleId:state.selectedCycleId}),{disabled:busy||early}));
      }
    }else body.append(element('p','growth-record-copy','이 대화 유형의 후속 훈련 연결은 아직 준비되지 않았습니다. 일정을 바꾸거나 UNKNOWN으로 종료할 수 있습니다.'));
    actions.append(button('일정 변경','growth-button growth-button-secondary',()=>{state.recheckFormId=`${recheck.id}:reschedule`;render();},{disabled:busy||Boolean(launch?.sessionId)}),button('UNKNOWN으로 종료','growth-button growth-button-secondary',()=>submitRecheck('close_unknown',recheck.id),{disabled:busy}));
    if(early)body.append(element('p','growth-record-copy','예약 시각 이후 새 후속 시도를 시작해 주세요.'));
    body.append(element('p','growth-record-copy','새 조건은 학습자가 정한 가정입니다. 학습 효과와 전이 여부는 UNKNOWN으로 남습니다.'),actions);return;
  }
  const reschedule=state.recheckFormId.endsWith(':reschedule');const form=element('form','growth-inline-form');const label=element('label','growth-field');
  label.append(element('span','growth-field-label',reschedule?'새 재확인 시각':'이전 판단을 다시 살펴볼 가정 조건'));
  const input=element(reschedule?'input':'textarea','growth-input');input.name=reschedule?'revisitAt':'changedCondition';input.required=true;input.addEventListener('input',()=>input.setCustomValidity(''));
  if(reschedule){input.type='datetime-local';input.value=dateInputValue(recheck.scheduledFor);}else{input.minLength=10;input.maxLength=1000;input.rows=3;input.placeholder='예: 같은 정책의 예산이 절반이라면 인과적 이유 중 무엇이 달라질까요?';}
  label.append(input);form.append(label);const actions=element('div','growth-inline-actions');
  actions.append(button(reschedule?'재확인 시각 저장':'조건 저장 후 훈련으로','growth-button growth-button-primary',null,{disabled:busy,type:'submit'}),button('취소','growth-button growth-button-secondary',()=>{state.recheckFormId='';render();}));form.append(actions);
  form.addEventListener('submit',event=>{
    event.preventDefault();
    if(reschedule){const revisitAt=new Date(input.value).getTime();if(!Number.isFinite(revisitAt)||revisitAt<=Date.now())return;state.recheckFormId='';submitRecheck('reschedule',recheck.id,{revisitAt});return;}
    const changedCondition=input.value.trim();if(changedCondition.length<10||changedCondition.length>1000){input.setCustomValidity('가정 조건을 10~1000자로 입력해 주세요.');input.reportValidity();return;}input.setCustomValidity('');
    const spaceId=state.selectedSpaceId;const cycleId=state.selectedCycleId;state.recheckFormId='';
    performAction(`follow-up:${recheck.id}`,`/api/growth/spaces/${encodeURIComponent(spaceId)}/cycles/${encodeURIComponent(cycleId)}/recheck-follow-up-launches`,'POST',{recheckId:recheck.id,changedCondition,expectedRevision:state.detail.aggregateRevision},async(result,mutation)=>{
      await afterCycleMutation(result,mutation);if(mutationStillBound(mutation))await navigateSavedFollowUp({...result,spaceId,cycleId});
    });
  });body.append(form);
}

function renderRecheck(recheck) {
  const body = element('div', 'growth-record-body');
  if (recheck.followUpLaunch?.changedCondition) {
    body.append(element('h4', 'growth-record-title', '내가 정한 가정 조건'),
      element('p', 'growth-record-copy', recheck.followUpLaunch.changedCondition),
      element('p', 'growth-record-copy', '학습자가 정한 가정이며, 출처의 사실이나 검증된 전이 과제를 뜻하지 않습니다.'));
  }
  const values = element('dl', 'growth-definition-grid');
  values.append(
    definitionItem('예정한 간격', `${displayValue(recheck.targetHorizonHours)}시간`),
    definitionItem('예약 시각', timestamp(recheck.scheduledFor)),
    definitionItem('기록 시각', recheck.recordedAt ? timestamp(recheck.recordedAt) : '아직 기록하지 않음'),
  );
  body.append(values);
  if (recheck.recordedAt) renderRecheckAssistance(body, recheck.assistance);
  const technical = element('details', 'growth-record-details');
  technical.append(element('summary', 'growth-record-copy', '기록 식별 정보'));
  const identifiers = element('dl', 'growth-definition-grid');
  identifiers.append(
    definitionItem('Recheck ID', recheck.id), definitionItem('연습 식별자', recheck.practiceQuestId),
    definitionItem('Variant policy revision', recheck.variantPolicyRevision),
    definitionItem('Follow-up origin kind', recheck.followUpOriginKind),
    definitionItem('Follow-up attempt ID', recheck.followUpAttemptId),
    definitionItem('Opening observation ID', recheck.openingObservationId),
    definitionItem('Recheck observation ID', recheck.recheckObservationId),
    definitionItem('Outcome', recheck.outcome || 'Unknown'),
  );
  technical.append(identifiers, evidenceList('Recheck evidence IDs', recheck.evidenceEventIds));
  body.append(technical);
  if (!recheck.outcome || recheck.outcome === 'UNKNOWN') body.append(element('p', 'growth-unknown-reason', KOREAN_JOURNEY_COPY.recheckUnknown.explanation));
  renderRecheckControls(body, recheck);
  return recordCard('후속 시도 돌아보기', `만든 시각 ${timestamp(recheck.createdAt)}`, recheck.outcome || 'UNKNOWN', body);
}

function renderRecheckAssistance(body, assistance) {
  body.append(element('h4', 'growth-record-title', '답변과 생각이 바뀐 과정'));
  if (assistance?.status !== 'RECORDED') {
    body.append(element('p', 'growth-unknown-reason', assistance?.status === 'UNAVAILABLE'
      ? '저장된 도움 기록을 확인할 수 없습니다. 도움을 받지 않았다는 뜻은 아닙니다.'
      : '이 시도의 도움 요약이 기록되지 않았습니다. 도움을 받지 않았다는 뜻은 아닙니다.'));
    return;
  }
  const comparison = element('dl', 'growth-definition-grid');
  for (const [label, episode] of [['처음 시도', assistance.baseline], ['후속 시도', assistance.followUp]]) {
    comparison.append(definitionItem(label,
      assistance.kind === 'SPARRING_SESSION_TOTALS_V1' || assistance.kind === 'SPARRING_RECORDS_V2'
        ? `저장된 답변 ${episode.acceptedTurns}회 · 평가 기록 ${episode.evaluatedTurns}회 · 도움 요청 ${episode.hintRequests}회 · 종료 시 힌트 단계 ${episode.hintLevelAtCompletion}`
        : `답변 ${episode.acceptedTurns}회 · 도움 요청 ${episode.supportRequested}회 · 저장된 설명 ${episode.supportRecorded}회 · 힌트가 포함된 답변 ${episode.turnsWithHints}회 · 일시정지 ${episode.pauses}회`));
  }
  if (assistance.kind === 'SPARRING_SESSION_TOTALS_V1') body.append(element('p', 'growth-unknown-reason',
    '이전 형식에는 횟수만 저장되어 있습니다. 당시 설명의 내용, 실제 열람과 일시정지 내역은 이 기록으로 확인할 수 없습니다.'));
  body.append(element('p', 'growth-record-copy',
    '앱 밖에서 받은 도움과 저장된 설명을 실제로 읽었는지는 확인할 수 없습니다. 도움 요청이나 일시정지 횟수는 점수가 아닙니다. 이 기록만으로 학습 효과나 전이를 판단하지 않습니다.'));
  if (assistance.kind === 'SPARRING_RECORDS_V2') {
    for (const [label, episode] of [['처음 시도', assistance.baseline], ['후속 시도', assistance.followUp]]) {
      renderSparringAssistanceRecords(body, label, episode);
    }
  }
  body.append(recordDetails('답변·평가·도움 횟수 보기', comparison));
}

function renderSparringAssistanceRecords(body, label, episode) {
  const available = episode.detail?.status === 'AVAILABLE';
  const section = element(available ? 'details' : 'section', 'growth-record-body growth-assistance-records');
  section.append(element(available ? 'summary' : 'h4', 'growth-record-title', `${label} · ${timestamp(episode.completedAt)}`));
  if (episode.detail?.status !== 'AVAILABLE') {
    section.append(element('p', 'growth-unknown-reason', '원본이 삭제되었거나 저장 당시의 내용과 일치하는지 확인할 수 없어 상세 기록을 표시하지 않습니다. 도움을 받지 않았다는 뜻은 아닙니다.'));
    body.append(section); return;
  }
  section.append(element('p', 'growth-record-copy', '나만 보는 기록 · 저장 당시와 원본 내용이 일치하는지 확인했습니다. 수정한 생각의 타당성과 학습 효과는 검증되지 않았습니다.'));
  const records = episode.detail.records;
  section.open = label === '후속 시도';
  const selectedTurn = records.revisions.at(-1)?.priorMessageId || records.turns.at(-1)?.id;
  const list = element('ol', 'growth-timeline');
  for (const turn of records.turns) {
    const item = element('li', 'growth-timeline-event');
    const detail = element('details', 'growth-record-details');
    detail.open = turn.id === selectedTurn;
    const revised = records.revisions.some(revision => revision.priorMessageId === turn.id);
    detail.append(element('summary', 'growth-record-copy', `${turn.turn}번째 답변${revised ? ' · 내가 수정한 생각 포함' : turn.revisionId ? ' · 수정 후 답변' : ''} · ${timestamp(turn.timestamp)}`));
    detail.append(element('h5', 'growth-record-title', '당시 내가 쓴 답변'), element('p', 'growth-record-copy', turn.content));
    if (turn.revisionId) detail.append(element('p', 'growth-record-copy', '앞서 저장한 생각 수정에 연결된 후속 답변입니다. 정답 판정은 아닙니다.'));
    for (const hint of records.hints.filter(hint => hint.turnNumber === turn.turn + 1)) {
      detail.append(element('h5', 'growth-record-title', '다음 답변 전 저장된 도움'), element('p', 'growth-record-copy', hint.hintMessage.replace(/\s*\[SOURCE_ID=[^\]]+\]/g, '')),
        element('p', 'growth-record-copy', `저장 시각 ${timestamp(hint.createdAt)} · 실제 열람 여부는 확인되지 않음`));
      const sources = element('details', 'growth-record-details');
      sources.append(element('summary', 'growth-record-copy', '도움을 만들 때 저장된 근거 보기'));
      for (const source of arrayValue(hint.sources)) sources.append(element('p', 'growth-record-copy', source.excerpt));
      if (!arrayValue(hint.sources).length) sources.append(element('p', 'growth-unknown-reason', '저장된 근거 내용을 현재 확인할 수 없습니다.'));
      detail.append(sources);
    }
    for (const revision of records.revisions.filter(revision => revision.priorMessageId === turn.id)) {
      detail.append(element('h5', 'growth-record-title', '내가 수정한 생각 · 검증되지 않은 수정'),
        element('p', 'growth-record-copy', revision.revisedStatement), element('h5', 'growth-record-title', '생각을 바꾼 이유'),
        element('p', 'growth-record-copy', revision.explanation), element('p', 'growth-record-copy',
          `${timestamp(revision.createdAt)} · ${revision.consumedByTurn === null ? '연결된 후속 답변 없음' : `${revision.consumedByTurn}번째 답변에 연결됨`}`));
    }
    detail.append(element('p', 'growth-record-copy', records.evaluations.some(evaluation => evaluation.turn === turn.turn)
      ? '이 답변에 연결된 평가 기록이 있습니다. 평가 기록의 존재는 이해나 학습 효과의 증거가 아닙니다.' : '이 답변에 연결된 평가 기록이 없습니다.'));
    item.append(detail); list.append(item);
  }
  section.append(list);
  const controls = element('details', 'growth-record-details');
  controls.append(element('summary', 'growth-record-copy', `휴식·재개·종료 기록 ${records.controls.length}건`));
  const reasonCopy = {LEARNER_REQUEST:'내 요청',DISTRESS:'부담을 느껴서',UNSAFE_ERROR:'안전하지 않은 오류',TIME_LIMIT:'시간 제한',INSUFFICIENT_EVIDENCE:'근거가 충분하지 않음'};
  for (const control of records.controls) controls.append(element('p', 'growth-record-copy',
    `${timestamp(control.createdAt)} · ${{PAUSE:'잠시 쉬기',RESUME:'다시 시작',STOP:'내 선택으로 종료'}[control.action]} · ${control.origin === 'POLICY' ? '앱이 연속된 관찰을 바탕으로 휴식을 제안함 · 진단이 아님' : reasonCopy[control.reason] || '이유 확인 필요'}`));
  if (!records.controls.length) controls.append(element('p', 'growth-record-copy', '이 시도에 저장된 휴식·재개·종료 기록은 없습니다.'));
  section.append(controls, button('원문과 출처 함께 열기', 'growth-button growth-button-secondary',
    () => window.viewHistoryDetail(episode.sessionId, 'sparring'), {disabled: typeof window.viewHistoryDetail !== 'function'}));
  body.append(section);
}

function renderTimeline(root, detail) {
  const section = element('section', 'growth-timeline-section');
  section.setAttribute('aria-labelledby', 'growth-timeline-title');
  const title = element('h3', 'growth-subsection-title', '비공개 근거 타임라인');
  title.id = 'growth-timeline-title';
  section.append(title, element('p', 'growth-section-copy', '타임라인 항목은 비공개입니다. 각 이벤트는 공개 점수 대신 거친 출처 범주와 리비전을 보존합니다.'));
  const events = arrayValue(detail.timeline);
  if (!events.length) {
    section.append(element('p', 'growth-empty-inline', '이 주기에서 표시할 수 있는 타임라인 이벤트가 없습니다.'));
    root.append(section);
    return;
  }
  const list = element('ol', 'growth-timeline');
  for (const event of events) {
    const item = element('li', 'growth-timeline-event');
    const heading = element('div', 'growth-timeline-heading');
    heading.append(
      element('h4', 'growth-timeline-event-title', statusText(event.eventType)),
      element('span', 'growth-timeline-time', timestamp(event.occurredAt)),
    );
    const details = element('dl', 'growth-timeline-definition');
    details.append(
      definitionItem('이벤트 유형', event.eventType),
      definitionItem('변경 이벤트 식별자', event.id),
      definitionItem('출처 범주', event.sourceCategory),
      definitionItem('대상 식별자', event.objectId),
      definitionItem('대상 버전', `${event.objectType} · revision ${displayValue(event.objectRevision)}`),
      definitionItem('변경 종류', event.lifecycleAction),
      definitionItem('변경 대상', event.transitionSubjectType && event.transitionSubjectId
        ? `${event.transitionSubjectType} · ${event.transitionSubjectId}`
        : '기록 없음'),
      definitionItem('상태 변화', event.previousState || event.nextState ? `${statusText(event.previousState)} → ${statusText(event.nextState)}` : '기록 없음'),
    );
    item.append(heading, details);
    list.append(item);
  }
  section.append(list);
  root.append(recordDetails('비공개 변경 이력과 근거 식별자', section));
}

function renderDeleteControl(root, detail) {
  const section = element('section', 'growth-delete-control');
  section.setAttribute('aria-labelledby', 'growth-delete-title');
  const title = element('h3', 'growth-subsection-title', KOREAN_JOURNEY_COPY.delete.title);
  title.id = 'growth-delete-title';
  section.append(title, element('p', 'growth-section-copy', KOREAN_JOURNEY_COPY.delete.explanation));
  section.append(button(KOREAN_JOURNEY_COPY.delete.action, 'growth-button growth-button-danger', (event) => openDeleteConfirmation(event.currentTarget), { disabled: Boolean(state.pendingAction) }));
  root.append(section);
}

function renderDetail(root, detail) {
  const section = element('section', 'growth-detail');
  section.setAttribute('aria-labelledby', 'growth-cycle-title');
  renderCycleHeader(section, detail);

  renderActionError(section);
  const columns = element('div', 'growth-detail-columns');
  const evidence = element('div', 'growth-evidence-column');
  evidence.append(element('h3', 'growth-subsection-title', '근거와 결정'));
  const observations = arrayValue(detail.observations);
  if (observations.length) observations.forEach((observation) => evidence.append(renderObservation(observation)));
  else evidence.append(element('p', 'growth-empty-inline', '사용 가능한 능력 관찰 기록이 없습니다.'));
  const hypotheses = arrayValue(detail.hypotheses);
  if (hypotheses.length) hypotheses.forEach((hypothesis) => evidence.append(renderHypothesis(hypothesis)));
  else evidence.append(element('p', 'growth-empty-inline', '사용 가능한 격차 가설이 없습니다.'));
  const practice = element('div', 'growth-practice-column');
  practice.append(element('h3', 'growth-subsection-title', '초점, 연습, 재확인'));
  const focuses = arrayValue(detail.focuses);
  if (focuses.length) focuses.forEach((focus) => practice.append(renderFocus(focus)));
  const quests = arrayValue(detail.quests);
  if (quests.length) quests.forEach((quest) => practice.append(renderQuest(quest)));
  else practice.append(element('p', 'growth-empty-inline', '아직 사용할 수 있는 연습 과제가 없습니다.'));
  const rechecks = arrayValue(detail.rechecks);
  if (rechecks.length) rechecks.forEach((recheck) => practice.append(renderRecheck(recheck)));
  else practice.append(element('p', 'growth-empty-inline', '예약된 재확인이 없습니다.'));
  const needsDecision = ['GAP_UNKNOWN', 'GAP_PROPOSED', 'GAP_CONTESTED', 'GAP_DISMISSED'].includes(detail.state);
  if (needsDecision) columns.append(evidence, practice);
  else columns.append(practice, recordDetails('앞선 관찰과 제안 다시 보기', evidence));
  section.append(columns);
  renderFocusControl(section, detail);
  renderHumanReviewRequest(section, detail);
  renderLifecycleBoundaryActions(section, detail);
  renderOutcomeBoundary(section, detail);
  renderTimeline(section, detail);
  renderDeleteControl(section, detail);
  root.append(section);
}

function renderDeletionReceipt(root) {
  if (!state.deletionReceipt) return;
  const panel = element('section', 'growth-deletion-receipt');
  panel.setAttribute('role', 'status');
  panel.append(
    element('h2', 'growth-note-title', '비공개 주기 삭제 완료'),
    element('p', 'growth-note-copy', '이 화면의 완료 응답에는 주기 내용이 남지 않습니다.'),
    element('p', 'growth-request-id', `삭제 영수증: ${state.deletionReceipt.id}`),
    element('p', 'growth-request-id', `완료 시각: ${timestamp(state.deletionReceipt.completedAt)}`),
  );
  root.append(panel);
}

function renderWorkspace(root) {
  const space = selectedSpace();
  if (!space) {
    renderConsentFirst(root);
    return;
  }
  renderPrivacyScope(root, space);
  renderPendingOrigin(root, true);
  renderListRefreshWarning(root);
  renderDeletionReceipt(root);
  if (!state.detail) renderActionError(root);
  const layout = element('div', 'growth-workspace-grid');
  const cycles = element('div', 'growth-workspace-sidebar');
  renderCycleList(cycles);
  const detail = element('div', 'growth-workspace-detail');
  if (state.mode === 'loading-cycle') detail.append(statePanel('주기를 불러오는 중', '비공개 기록과 근거 타임라인을 불러오고 있습니다.', '선택한 주기를 기다려 주세요.'));
  else if (state.detail) renderDetail(detail, state.detail);
  else detail.append(statePanel('성장 주기 선택', '근거, 선택, 연습, 재확인 기록을 살펴볼 비공개 주기를 고르세요.', '목록에서 주기를 선택하세요.'));
  layout.append(cycles, detail);
  root.append(layout);
}

function render() {
  const root = clearRoot();
  if (!root) return;
  if (state.mode === 'loading-spaces') {
    root.append(statePanel('비공개 성장 실험실을 불러오는 중', '로그인한 학습자가 사용할 수 있는 공간을 확인하고 있습니다.', '비공개 공간 확인을 기다려 주세요.'));
    return;
  }
  if (state.error) {
    const error = state.error;
    const retry = error.retryable ? () => loadGrowthLab() : null;
    root.append(statePanel(
      error.status === 401 ? '성장 실험실 로그인이 필요합니다' : '성장 실험실을 사용할 수 없습니다',
      `비공개 성장 실험실을 불러오지 못했습니다. 코드: ${error.code}.`,
      error.retryable ? '서비스를 다시 이용할 수 있을 때 재시도하세요.' : '로그인 계정과 비공개 공간 접근 권한을 확인하세요.',
      retry,
    ));
    return;
  }
  if (state.mode === 'loading-cycles') {
    root.append(statePanel('비공개 주기를 불러오는 중', '활성 비공개 공간이 소유한 주기만 불러옵니다.', '비공개 주기 목록을 기다려 주세요.'));
    return;
  }
  if (!state.spaces.length) {
    renderActionError(root);
    renderConsentFirst(root);
    return;
  }
  renderWorkspace(root);
}

function resetGrowthLab() {
  state.requestGeneration += 1;
  closeDeleteConfirmation(false);
  state.detail = null;
  state.spaces = [];
  state.cycles = [];
  state.selectedSpaceId = '';
  state.selectedCycleId = '';
  state.pendingOrigin = null;
  state.originAttachment = null;
  state.humanReviewRequest = null;
  clearRoot();
}

export { loadGrowthLab, openGrowthCycleFromOrigin, openGrowthRecheck, resetGrowthLab };
