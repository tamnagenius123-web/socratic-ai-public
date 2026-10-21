// ======================================================
// SocraticAI v26 — Utility Module (API, Notifications, Formatting)
// ======================================================
import { State, getEl, resetPrivateLearningState } from './state.js';

export function authHeaders() {
  return State.accessToken
    ? { 'Authorization': 'Bearer ' + State.accessToken, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

export class ApiError extends Error {
  constructor(message, { status, code, phase, requestId, retryable, payload }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.phase = phase;
    this.requestId = requestId;
    this.retryable = retryable;
    this.payload = payload;
  }
}

export function escapeAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function parseErrorPayload(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function apiErrorFromResponse(res, payload) {
  const structured = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const code = typeof structured.code === 'string' ? structured.code : null;
  const phase = typeof structured.phase === 'string' ? structured.phase : null;
  const structuralStatus = typeof structured.status === 'string' ? structured.status : null;
  const requestId = typeof structured.requestId === 'string'
    ? structured.requestId
    : res.headers.get('x-request-id') || res.headers.get('cf-ray');
  const retryable = typeof structured.retryable === 'boolean'
    ? structured.retryable
    : structuralStatus === 'UNGRADABLE' || code === 'AUTHORIZATION_UNGRADABLE'
      ? false
      : [408, 425, 429, 500, 502, 503, 504].includes(res.status);
  const detail = typeof structured.error === 'string'
    ? structured.error
    : typeof structured.message === 'string'
      ? structured.message
      : typeof payload === 'string' && payload
        ? payload
        : res.statusText || 'API Error';
  const message = detail + (code ? ' (' + code + ')' : '') + (phase ? ' [phase: ' + phase + ']' : '');
  return new ApiError(message, { status: res.status, code, phase, requestId, retryable, payload });
}

async function requestApi(ep, data, method, refreshed, options = {}) {
  const epoch = State.authEpoch;
  const requireCurrentIdentity = () => {
    if (epoch !== State.authEpoch) throw new ApiError('계정이 변경되어 이전 요청을 취소했습니다.', {
      status: 409, code: 'AUTH_CONTEXT_CHANGED', phase: 'authorization', requestId: null, retryable: false, payload: null,
    });
  };
  const headers = { ...authHeaders(), ...(options.headers || {}) };
  const opts = { method, headers };
  const shouldSendJsonBody = options.sendJsonBody === true
    || (options.sendJsonBody === undefined && Boolean(data));
  if (shouldSendJsonBody && method !== 'GET') opts.body = JSON.stringify(data);
  let res;
  try {
    res = await fetch(ep, method === 'GET' ? { headers } : opts);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Network request failed';
    throw new ApiError(message, {
      status: 0,
      code: 'NETWORK_ERROR',
      phase: null,
      requestId: null,
      retryable: true,
      payload: null,
    });
  }
  let authExpiryHandled = false;
  requireCurrentIdentity();
  if (res.status === 401 && State.refreshToken && !refreshed) {
    const ok = await tryRefreshToken();
    requireCurrentIdentity();
    if (ok) return requestApi(ep, data, method, true, options);
    handleAuthExpired();
    authExpiryHandled = true;
  }
  if (!res.ok) {
    const payload = await parseErrorPayload(res);
    if (!authExpiryHandled) requireCurrentIdentity();
    if (res.status === 401 && !authExpiryHandled) handleAuthExpired();
    throw apiErrorFromResponse(res, payload);
  }
  const payload = await res.json();
  requireCurrentIdentity();
  return payload;
}

export async function api(ep, data, method = 'POST') {
  return requestApi(ep, data, method, false);
}

export async function apiGet(ep) { return api(ep, null, 'GET'); }
export async function apiDelete(ep) { return api(ep, null, 'DELETE'); }

// Additive path for contracts that require a request-scoped header (such as an
// idempotency key) and may legitimately send a JSON DELETE body. Existing
// `api` / `apiDelete` semantics remain unchanged.
export async function apiWithHeaders(ep, data, method = 'POST', headers = {}) {
  return requestApi(ep, data, method, false, {
    headers,
    sendJsonBody: data !== undefined,
  });
}

export async function tryRefreshToken() {
  const epoch = State.authEpoch;
  try {
    const res = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: State.refreshToken }) });
    if (!res.ok) return false;
    const data = await res.json();
    if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string') return false;

    const identityRes = await fetch('/api/auth/me', {
      headers: {
        'Authorization': 'Bearer ' + data.accessToken,
        'Content-Type': 'application/json',
      },
    });
    if (!identityRes.ok) return false;
    const identityData = await identityRes.json();
    if (epoch !== State.authEpoch) return false;
    if (!identityData?.user || typeof identityData.user !== 'object' || Array.isArray(identityData.user)) return false;
    if (State.user?.id && identityData.user.id !== State.user.id) return false;

    State.accessToken = data.accessToken;
    State.refreshToken = data.refreshToken;
    State.user = identityData.user;
    localStorage.setItem('sat_access', data.accessToken);
    localStorage.setItem('sat_refresh', data.refreshToken);
    localStorage.setItem('sat_user', JSON.stringify(identityData.user));
    const bridge = window.SocraticAI || window.SocraticModules;
    if (typeof bridge?.updateIdentityUI === 'function') bridge.updateIdentityUI();
    else bridge?.syncNavigation?.(State.user);
    return true;
  } catch { return false; }
}

export function isTokenExpired(token) {
  if (!token) return true;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return !payload.exp || Date.now() > payload.exp * 1000;
  } catch { return true; }
}

function isRendered(element) {
  return element instanceof HTMLElement && !element.hidden && element.getClientRects().length > 0;
}

export function isAuthExpiryScreenVisible() {
  return !State.accessToken
    && !isRendered(document.getElementById('main-app'))
    && isRendered(document.getElementById('auth-screen'));
}

export function focusLoginAfterAuthExpiry() {
  const loginEmail = document.getElementById('login-email');
  if (!isAuthExpiryScreenVisible() || !isRendered(loginEmail)) return false;
  loginEmail.focus();
  return document.activeElement === loginEmail;
}

export function handleAuthExpired() {
  const bridge = window.SocraticAI || window.SocraticModules;
  resetPrivateLearningState();
  bridge?.closeMobileDashboard?.(false);
  State.accessToken = null;
  State.refreshToken = null;
  State.user = null;
  localStorage.removeItem('sat_access');
  localStorage.removeItem('sat_refresh');
  localStorage.removeItem('sat_user');
  const main = document.getElementById('main-app');
  const auth = document.getElementById('auth-screen');
  if (main && auth) {
    main.style.display = 'none';
    auth.style.display = 'flex';
    window.showLogin && window.showLogin();
    showToast('세션이 만료되어 다시 로그인해주세요.', 'info');
    focusLoginAfterAuthExpiry();
  }
}

export function showToast(msg, type = 'info') {
  const e = document.querySelector('.toast');
  if (e) e.remove();
  const d = document.createElement('div');
  d.className = 'toast toast-' + type;
  const icon = document.createElement('i');
  icon.className = 'fas fa-' + (type === 'error' ? 'exclamation-circle' : type === 'success' ? 'check-circle' : 'info-circle') + ' mr-2';
  d.append(icon, document.createTextNode(String(msg)));
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 4000);
}

export function formatNumber(n) {
  if (!n && n !== 0) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}

export function statBox(label, value, icon, color) {
  return '<div class="stat-card"><i class="fas ' + icon + ' ' + color + ' text-lg mb-1"></i><p class="text-2xl font-bold text-gray-900">' + value + '</p><p class="text-xs text-gray-500">' + label + '</p></div>';
}
