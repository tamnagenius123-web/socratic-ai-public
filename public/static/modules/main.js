// ======================================================
// SocraticAI v35 — Browser entrypoint and lifecycle bridge
// ======================================================

import {
  State,
  getEl,
  setDisplay,
  setText,
  esc,
  setSparringState,
  resetSparringState,
} from './state.js';
import {
  api,
  apiGet,
  apiDelete,
  showToast,
  formatNumber,
  escapeAttribute,
  authHeaders,
  isTokenExpired,
  isAuthExpiryScreenVisible,
  focusLoginAfterAuthExpiry,
  handleAuthExpired,
  tryRefreshToken,
} from './utils.js';
import { initRadarChart, updateRadarChart, render18AxisRadar } from './charts.js';
import { renderXAIFGraph, renderDemoGraph } from './xaif-graph.js';
import {
  loadClassChatRooms,
  showCreateClassChatModal,
  joinClassChat,
  submitClassChatMessage,
  connectClassChatWS,
  disconnectClassChatWS,
  loadClassChatMessages,
} from './classchat.js';
import { loadEnterpriseDashboard, switchEnterpriseTab } from './enterprise.js';
import { loadHrdProgramTab } from './hrd-program.js';
import { loadGrowthLab, openGrowthCycleFromOrigin, openGrowthRecheck, resetGrowthLab } from './growth-lab.js';
import { KOREAN_JOURNEY_COPY } from './korean-journey-copy.js';
import { toggleDarkMode, initAutoTheme } from './theme.js';
import {
  initMobileNav,
  updateMobileNavActive,
  toggleDesktopMore,
  closeDesktopMore,
  toggleMobileMore,
  closeMobileMore,
  closeAllNavigationMenus,
} from './mobile-nav.js';
import { initAuth } from './auth.js';
import { loadNeuralWiki } from './neural-wiki.js';

const bridge = window.SocraticAI || window.SocraticModules || {};
Object.assign(bridge, {
  State,
  getEl,
  setDisplay,
  setText,
  esc,
  setSparringState,
  resetSparringState,
  api,
  apiGet,
  apiDelete,
  showToast,
  formatNumber,
  escapeAttribute,
  authHeaders,
  isTokenExpired,
  isAuthExpiryScreenVisible,
  focusLoginAfterAuthExpiry,
  handleAuthExpired,
  tryRefreshToken,
  initRadarChart,
  updateRadarChart,
  render18AxisRadar,
  renderXAIFGraph,
  renderDemoGraph,
  loadClassChatRooms,
  showCreateClassChatModal,
  joinClassChat,
  submitClassChatMessage,
  connectClassChatWS,
  disconnectClassChatWS,
  loadClassChatMessages,
  loadEnterpriseDashboard,
  switchEnterpriseTab,
  loadHrdProgramTab,
  KOREAN_JOURNEY_COPY,
  loadGrowthLab,
  openGrowthCycleFromOrigin, openGrowthRecheck,
  toggleDarkMode,
  initAutoTheme,
  initMobileNav,
  updateMobileNavActive,
  toggleDesktopMore,
  closeDesktopMore,
  toggleMobileMore,
  closeMobileMore,
  closeAllNavigationMenus,
});
window.SocraticAI = bridge;
window.SocraticModules = bridge;

Object.assign(window, {
  initRadarChart,
  updateRadarChart,
  render18AxisRadar,
  renderXAIFGraph,
  renderDemoGraph,
  showToast,
  loadClassChatRooms,
  showCreateClassChatModal,
  joinClassChat,
  submitClassChatMessage,
  connectClassChatWS,
  disconnectClassChatWS,
  loadClassChatMessages,
  loadEnterpriseDashboard,
  switchEnterpriseTab,
  loadHrdProgramTab,
  loadGrowthLab,
  toggleDarkMode,
  toggleDesktopMore,
  closeDesktopMore,
  toggleMobileMore,
  closeMobileMore,
});

// These files are legacy IIFEs. Import them only after the shared bridge exists.
const legacyModules = [
  './library.js',
  './sparring.js',
  './sparring-revisions.js',
  './training.js',
  './scenario.js',
  './history.js',
  './dashboard.js',
  './debate.js',
  './admin.js',
  './casestudy.js',
];

const moduleErrors = [];
for (const modulePath of legacyModules) {
  try {
    await import(modulePath);
  } catch (error) {
    moduleErrors.push({ modulePath, message: error instanceof Error ? error.message : String(error) });
    console.error(`[BOOT] Failed to load ${modulePath}`, error);
  }
}

const auth = initAuth(State, bridge);
Object.assign(bridge, auth);

let sessionConfig = {
  bookId: '',
  mode: 'sparring',
  startMode: 'initial_claim',
};
let sessionConfigReturnFocus = null;
let sessionConfigInertState = [];
let sessionConfigRequestId = 0;

const MORE_TABS = new Set(['growth-lab', 'neuralwiki', 'debate', 'classchat', 'hrd-program', 'enterprise', 'admin']);

function navigationDecision(control, user, requireAccessToken = false) {
  if (!control) return false;
  if (!control.hasAttribute('data-auth-required') || !control.hasAttribute('data-role-required')) return false;
  const role = typeof user?.role === 'string' ? user.role : '';
  const authRequired = control.dataset.authRequired === 'true';
  const allowedRoles = (control.dataset.roleRequired || '')
    .split(',')
    .map((allowedRole) => allowedRole.trim())
    .filter(Boolean);

  if (authRequired && (!user || (requireAccessToken && !State.accessToken))) return false;
  if (allowedRoles.length && !allowedRoles.includes(role)) return false;
  return true;
}

function syncNavigation(user) {
  const role = typeof user?.role === 'string' ? user.role : '';
  const visibleTabs = new Set();

  document.querySelectorAll('[data-navigation-control][data-tab]').forEach((control) => {
    const authorized = navigationDecision(control, user, false);
    control.hidden = !authorized;
    if (authorized) {
      control.removeAttribute('aria-hidden');
      control.removeAttribute('tabindex');
      visibleTabs.add(control.dataset.tab);
    } else {
      control.setAttribute('aria-hidden', 'true');
      control.tabIndex = -1;
    }
  });

  document.querySelectorAll('.tab-content[id^="tab-"]').forEach((content) => {
    const tab = content.id.slice(4);
    if (!visibleTabs.has(tab)) content.classList.add('hidden');
  });

  if (!visibleTabs.has(State.currentTab)) State.currentTab = 'library';
  return { role, visibleTabs: Array.from(visibleTabs) };
}

function updateDesktopNavigationActive(tab) {
  const activeTab = String(tab || '');
  document.querySelectorAll('#main-nav [data-tab]').forEach((control) => {
    const active = control.dataset.tab === activeTab;
    control.classList.toggle('active', active);
    if (active) control.setAttribute('aria-current', 'page');
    else control.removeAttribute('aria-current');
  });

  const moreButton = getEl('desktop-more-btn');
  const moreActive = MORE_TABS.has(activeTab);
  moreButton?.classList.toggle('active', moreActive);
  moreButton?.removeAttribute('aria-current');
}

function hideLanding() {
  setDisplay('landing-screen', 'none');
  setDisplay('main-app', 'none');
  setDisplay('auth-screen', 'flex');
}

function updateIdentityUI() {
  const identity = State.user;
  const user = identity || { username: '체험 사용자', email: '', role: 'student' };
  const username = String(user.username || user.name || '사용자');
  const role = String(user.role || 'student');
  setText('menu-username', username);
  setText('menu-email', String(user.email || '계정 정보 없음'));
  setText('menu-role', role);
  setText('user-avatar', username.slice(0, 1).toLocaleUpperCase('ko-KR'));
  syncNavigation(identity);
}

async function enterApp() {
  setDisplay('landing-screen', 'none');
  setDisplay('auth-screen', 'none');
  updateIdentityUI();
  setDisplay('main-app', 'block');
  setDisplay('mobile-bottom-nav', '');
  await switchTab(State.currentTab || 'sparring');
}

const tabLoaders = {
  sparring: () => bridge.loadSparringBookSelector?.(),
  training: () => bridge.loadTrainingTab?.(),
  library: () => bridge.loadBooks?.(),
  history: () => bridge.loadHistory?.(),
  dashboard: () => bridge.loadPersonalDashboard?.(),
  debate: () => bridge.loadDebateTab?.(),
  classchat: () => loadClassChatRooms(),
  'growth-lab': () => loadGrowthLab(),
  'hrd-program': () => loadHrdProgramTab(),
  enterprise: () => loadEnterpriseDashboard(),
  admin: () => bridge.loadAdminOverview?.(),
  neuralwiki: () => loadNeuralWiki(),
};

function focusTabDestination(target) {
  if (!(target instanceof HTMLElement)) return false;
  const focusTarget = target.querySelector('h1, h2, h3, main, [role="main"]') || target;
  if (!(focusTarget instanceof HTMLElement)) return false;
  const previousTabIndex = focusTarget.getAttribute('tabindex');
  if (previousTabIndex === null) focusTarget.tabIndex = -1;
  focusTarget.focus({ preventScroll: false });
  if (previousTabIndex === null) {
    focusTarget.addEventListener('blur', () => focusTarget.removeAttribute('tabindex'), { once: true });
  }
  return document.activeElement === focusTarget;
}

async function switchTab(tab, options = {}) {
  const scenarioRedirect = tab === 'scenario';
  if (scenarioRedirect) tab = 'training';
  const target = getEl(`tab-${tab}`);
  const nav = document.querySelector(`#main-nav [data-tab="${CSS.escape(String(tab))}"]`);
  if (!target || !nav) {
    showToast('요청한 화면을 찾을 수 없습니다.', 'error');
    return false;
  }

  if (nav.dataset.authRequired === 'true' && !State.accessToken) {
    showToast('이 기능은 로그인 후 사용할 수 있습니다.', 'info');
    hideLanding();
    return false;
  }

  if (!navigationDecision(nav, State.user, true)) {
    showToast('이 화면에 접근할 권한이 없습니다.', 'error');
    return false;
  }

  document.querySelectorAll('.tab-content').forEach((element) => element.classList.add('hidden'));
  target.classList.remove('hidden');
  updateDesktopNavigationActive(tab);
  State.currentTab = tab;
  setDisplay('sub-header', tab === 'sparring' && State.isSessionActive ? 'flex' : 'none');
  updateMobileNavActive(tab);
  if (options?.focusDestination === true) focusTabDestination(target);
  closeAllNavigationMenus(false);
  closeMobileDashboard(false);

  const loader = tabLoaders[tab];
  if (loader) {
    try {
      if (await loader() === false) return false;
    } catch (error) {
      console.error(`[NAV] ${tab} initialization failed`, error);
      showToast('화면 데이터를 불러오지 못했습니다.', 'error');
      return false;
    }
  }
  if (scenarioRedirect) window.setTrainingMode?.('constructed');
  return true;
}

async function openSessionConfigModal(bookId, trigger) {
  const requestId = ++sessionConfigRequestId;
  const modal = getEl('session-config-modal');
  sessionConfigReturnFocus = trigger instanceof HTMLElement && trigger.isConnected
    ? trigger
    : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  sessionConfig = { bookId: String(bookId || ''), mode: 'sparring', startMode: 'initial_claim' };
  State.selectedBookId = sessionConfig.bookId;
  setText('scm-book-title', '불러오는 중…');
  setText('scm-book-author', '');
  setSessionConfigMode('sparring', 'initial_claim');
  document.documentElement.classList.add('session-config-modal-open');
  document.body.classList.add('session-config-modal-open');
  setDisplay('session-config-modal', 'flex');
  if (modal) setSessionConfigBackgroundInert(modal, true);
  window.requestAnimationFrame(() => {
    if (requestId !== sessionConfigRequestId || modal?.style.display === 'none') return;
    (dashboardFocusableElements(modal)[0] || modal)?.focus();
  });
  try {
    const book = await apiGet(`/api/books/${encodeURIComponent(sessionConfig.bookId)}`);
    if (requestId !== sessionConfigRequestId) return;
    setText('scm-book-title', String(book.title || '제목 없음'));
    setText('scm-book-author', String(book.author || '저자 미상'));
  } catch (error) {
    if (requestId !== sessionConfigRequestId) return;
    const authExpired = isAuthExpiryScreenVisible();
    closeSessionConfigModal();
    if (!authExpired) showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

function closeSessionConfigModal(returnFocus = true) {
  const modal = getEl('session-config-modal');
  const focusTarget = sessionConfigReturnFocus;
  const shouldRestoreFocus = returnFocus
    && Boolean(modal?.contains(document.activeElement));
  ++sessionConfigRequestId;
  setDisplay('session-config-modal', 'none');
  document.documentElement.classList.remove('session-config-modal-open');
  document.body.classList.remove('session-config-modal-open');
  if (modal) setSessionConfigBackgroundInert(modal, false);
  if (shouldRestoreFocus) window.requestAnimationFrame(() => focusSessionConfigExit(focusTarget));
  sessionConfigReturnFocus = null;
}

function focusSessionConfigExit(focusTarget) {
  if (isRendered(focusTarget)) {
    focusTarget.focus();
    return;
  }
  if (isAuthExpiryScreenVisible()) focusLoginAfterAuthExpiry();
}

function setSessionConfigBackgroundInert(modal, shouldInert) {
  if (shouldInert) {
    if (sessionConfigInertState.length) return;
    let activeBranch = modal;
    while (activeBranch.parentElement && activeBranch.parentElement !== document.documentElement) {
      const parent = activeBranch.parentElement;
      Array.from(parent.children).forEach((sibling) => {
        if (sibling === activeBranch || !(sibling instanceof HTMLElement)) return;
        sessionConfigInertState.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      });
      activeBranch = parent;
    }
    return;
  }

  sessionConfigInertState.forEach(({ element, inert }) => {
    element.inert = inert;
  });
  sessionConfigInertState = [];
}

function handleSessionConfigModalKeydown(event) {
  const modal = getEl('session-config-modal');
  if (!modal || modal.style.display === 'none') return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSessionConfigModal();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = dashboardFocusableElements(modal);
  if (!focusable.length) {
    event.preventDefault();
    modal.focus();
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

function setSessionConfigMode(mode, startMode) {
  sessionConfig.mode = mode === 'training' ? 'training' : 'sparring';
  sessionConfig.startMode = startMode || 'initial_claim';
  const activeId = sessionConfig.mode === 'training'
    ? 'scm-training'
    : sessionConfig.startMode === 'deep_reading_question'
      ? 'scm-sparring-deep'
      : 'scm-sparring-initial';
  ['scm-sparring-initial', 'scm-sparring-deep', 'scm-training'].forEach((id) => {
    const button = getEl(id);
    if (!button) return;
    const active = id === activeId;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('border-primary-300', active);
    button.classList.toggle('bg-primary-50', active);
    button.classList.toggle('border-gray-200', !active);
    button.classList.toggle('bg-white', !active);
  });
}

async function confirmSessionConfig() {
  closeSessionConfigModal(false);
  if (sessionConfig.mode === 'training') {
    const trainingLoaded = await switchTab('training', { focusDestination: true });
    if (!trainingLoaded) {
      if (isAuthExpiryScreenVisible()) focusLoginAfterAuthExpiry();
      return;
    }
    if (isAuthExpiryScreenVisible()) {
      focusLoginAfterAuthExpiry();
      return;
    }
    bridge.seedTrainingEvidenceBook?.(sessionConfig.bookId);
    if (isAuthExpiryScreenVisible()) {
      focusLoginAfterAuthExpiry();
      return;
    }
    showToast('선택한 도서를 첫 근거로 추가했습니다. 다른 도서 1권 이상을 선택하세요.', 'info');
    return;
  }
  State.selectedBookId = sessionConfig.bookId;
  bridge.setSparringStartMode?.(sessionConfig.startMode);
  await switchTab('sparring', { focusDestination: true });
  await bridge.startSession?.(sessionConfig.bookId);
}

function toggleUserMenu() {
  const menu = getEl('user-menu');
  const button = getEl('user-avatar');
  if (!menu) return;
  const open = menu.style.display !== 'block';
  menu.style.display = open ? 'block' : 'none';
  button?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

let mobileDashboardReturnFocus = null;
let mobileDashboardInertState = [];
let mobileDashboardHome = null;

function mountMobileDashboardOverlay(sidebar) {
  if (!sidebar || sidebar.parentElement === document.body) return;
  mobileDashboardHome = {
    parent: sidebar.parentNode,
    nextSibling: sidebar.nextSibling,
  };
  document.body.appendChild(sidebar);
}

function restoreMobileDashboardHome(sidebar) {
  if (!sidebar || !mobileDashboardHome?.parent?.isConnected) return;
  const { parent, nextSibling } = mobileDashboardHome;
  if (nextSibling?.parentNode === parent) parent.insertBefore(sidebar, nextSibling);
  else parent.appendChild(sidebar);
  mobileDashboardHome = null;
}

function isRendered(element) {
  return element instanceof HTMLElement
    && !element.hidden
    && element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0;
}

function focusVisibleDashboardExit(sidebar) {
  if (isRendered(sidebar)) {
    sidebar.focus();
    return document.activeElement === sidebar;
  }

  const currentTab = getEl(`tab-${State.currentTab}`);
  if (isRendered(currentTab) && focusTabDestination(currentTab)) return true;

  const currentControl = document.querySelector(
    `#main-nav [data-tab="${CSS.escape(String(State.currentTab || ''))}"]`,
  );
  if (isRendered(currentControl)) {
    currentControl.focus();
    return document.activeElement === currentControl;
  }
  return false;
}

function focusVisibleMobileDashboardExit(trigger) {
  if (isRendered(trigger)) {
    trigger.focus();
    return document.activeElement === trigger;
  }

  const currentTab = getEl(`tab-${State.currentTab}`);
  return isRendered(currentTab) && focusTabDestination(currentTab);
}

function dashboardFocusableElements(sidebar) {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return Array.from(sidebar.querySelectorAll(selector)).filter((element) => (
    element instanceof HTMLElement
    && !element.hidden
    && element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0
  ));
}

function setMobileDashboardBackgroundInert(sidebar, shouldInert) {
  if (shouldInert) {
    if (mobileDashboardInertState.length) return;
    let activeBranch = sidebar;
    while (activeBranch.parentElement && activeBranch.parentElement !== document.documentElement) {
      const parent = activeBranch.parentElement;
      Array.from(parent.children).forEach((sibling) => {
        if (sibling === activeBranch || !(sibling instanceof HTMLElement)) return;
        mobileDashboardInertState.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      });
      activeBranch = parent;
    }
    return;
  }

  mobileDashboardInertState.forEach(({ element, inert }) => {
    element.inert = inert;
  });
  mobileDashboardInertState = [];
}

function handleMobileDashboardKeydown(event) {
  const sidebar = getEl('dashboard-sidebar');
  if (event.key !== 'Tab' || !sidebar?.classList.contains('mobile-open')) return;
  const focusable = dashboardFocusableElements(sidebar);
  if (!focusable.length) {
    event.preventDefault();
    sidebar.focus();
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

function containMobileDashboardFocus(event) {
  const sidebar = getEl('dashboard-sidebar');
  if (!sidebar?.classList.contains('mobile-open') || sidebar.contains(event.target)) return;
  (dashboardFocusableElements(sidebar)[0] || sidebar).focus();
}

function closeMobileDashboard(returnFocus = false) {
  const sidebar = getEl('dashboard-sidebar');
  const trigger = getEl('mobile-dash-btn');
  if (!sidebar) return false;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const wasOpen = sidebar.classList.contains('mobile-open');
  if (!wasOpen) {
    if (isMobile) {
      sidebar.setAttribute('aria-hidden', 'true');
      sidebar.inert = true;
    }
    return false;
  }
  const shouldRestoreFocus = returnFocus || sidebar.contains(document.activeElement);
  const focusTarget = mobileDashboardReturnFocus?.isConnected ? mobileDashboardReturnFocus : trigger;
  sidebar.classList.remove('mobile-open');
  document.body.classList.remove('mobile-dashboard-open');
  setMobileDashboardBackgroundInert(sidebar, false);
  trigger?.setAttribute('aria-expanded', 'false');
  trigger?.setAttribute('aria-label', '실시간 대시보드 열기');
  if (shouldRestoreFocus) focusTarget?.focus();
  sidebar.setAttribute('aria-hidden', 'true');
  sidebar.removeAttribute('aria-modal');
  sidebar.removeAttribute('role');
  sidebar.inert = true;
  restoreMobileDashboardHome(sidebar);
  mobileDashboardReturnFocus = null;
  return true;
}

function toggleMobileDashboard() {
  const sidebar = getEl('dashboard-sidebar');
  const trigger = getEl('mobile-dash-btn');
  if (!sidebar) return false;
  if (sidebar.classList.contains('mobile-open')) return closeMobileDashboard(true);

  mobileDashboardReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : trigger;
  closeAllNavigationMenus(false);
  mountMobileDashboardOverlay(sidebar);
  setMobileDashboardBackgroundInert(sidebar, true);
  document.body.classList.add('mobile-dashboard-open');
  sidebar.style.display = 'block';
  sidebar.classList.add('mobile-open');
  sidebar.setAttribute('aria-hidden', 'false');
  sidebar.setAttribute('role', 'dialog');
  sidebar.setAttribute('aria-modal', 'true');
  sidebar.inert = false;
  trigger?.setAttribute('aria-expanded', 'true');
  trigger?.setAttribute('aria-label', '실시간 대시보드 닫기');
  window.requestAnimationFrame(() => getEl('mobile-dashboard-close')?.focus());
  return true;
}

function syncDashboardAccessibilityForViewport() {
  const sidebar = getEl('dashboard-sidebar');
  if (!sidebar) return;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  if (isMobile) {
    const focusWasInside = sidebar.contains(document.activeElement);
    const trigger = getEl('mobile-dash-btn');
    const open = sidebar.classList.contains('mobile-open');
    sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
    sidebar.inert = !open;
    if (open) {
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
      document.body.classList.add('mobile-dashboard-open');
      setMobileDashboardBackgroundInert(sidebar, true);
    } else {
      sidebar.removeAttribute('aria-modal');
      sidebar.removeAttribute('role');
      document.body.classList.remove('mobile-dashboard-open');
      setMobileDashboardBackgroundInert(sidebar, false);
      if (focusWasInside) {
        window.requestAnimationFrame(() => focusVisibleMobileDashboardExit(trigger));
      }
    }
  } else {
    const focusWasInside = sidebar.contains(document.activeElement);
    const trigger = getEl('mobile-dash-btn');
    sidebar.classList.remove('mobile-open');
    sidebar.removeAttribute('aria-hidden');
    sidebar.removeAttribute('aria-modal');
    sidebar.removeAttribute('role');
    sidebar.inert = false;
    document.body.classList.remove('mobile-dashboard-open');
    setMobileDashboardBackgroundInert(sidebar, false);
    restoreMobileDashboardHome(sidebar);
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.setAttribute('aria-label', '실시간 대시보드 열기');
    mobileDashboardReturnFocus = null;
    if (focusWasInside) window.requestAnimationFrame(() => focusVisibleDashboardExit(sidebar));
  }
}

function openSettings() { setDisplay('settings-modal', 'flex'); }
function closeSettings() { setDisplay('settings-modal', 'none'); }

function setHintLevel(level) {
  State.hintLevel = Math.max(0, Math.min(2, Number(level) || 0));
  setText('hint-level-display', `Lv.${State.hintLevel}`);
}

function updateDashboard(data) {
  const evaluation = data?.evaluation || {};
  const session = data?.session || {};
  const discourse = data?.discourse || {};
  const avgLogic = Number(evaluation.avgLogic);
  const hasMeasuredEvaluation = evaluation.rating !== 'UNKNOWN'
    && Number.isFinite(avgLogic)
    && avgLogic >= 20
    && avgLogic <= 100;
  if (hasMeasuredEvaluation && evaluation.radarScores) {
    State.radarScores = evaluation.radarScores;
    updateRadarChart(evaluation.radarScores);
  }
  State.currentTurn = Number(session.currentTurn || State.currentTurn || 1);
  State.currentPhase = session.currentPhase || State.currentPhase;
  State.coreClaim = discourse.coreClaim || State.coreClaim;
  State.currentClaim = discourse.currentClaim || State.currentClaim;
  setText('dash-topic', discourse.topic || State.topic || '-');
  setText('dash-claim', State.currentClaim || State.coreClaim || '아직 주장이 제출되지 않았습니다.');
  setText('dash-avg-logic', hasMeasuredEvaluation ? `${avgLogic}%` : 'No record');
  setText('dash-rating', hasMeasuredEvaluation ? evaluation.rating : 'UNKNOWN');
  setText('turn-badge', `TURN ${State.currentTurn} OF ${Number(session.maxTurns || 10)}`);
  setText('metric-evidence', `${Number(session.textualEvidenceCited || 0)}/3`);
  setText('metric-fallacies', `${Number(session.logicalFallaciesAvoided || 0)}/2`);
  const pace = Number(session.dialecticPace);
  setText('dash-pace', Number.isFinite(pace) && pace > 0 ? pace.toFixed(1) : 'No record');
  setText('dash-cred-level', hasMeasuredEvaluation ? (session.credibility?.level || 'UNKNOWN') : 'UNKNOWN');
  setText('dash-cred-tier', hasMeasuredEvaluation && session.credibility?.tier ? ` ${session.credibility.tier}` : ' —');
  bridge.updatePhaseDisplay?.();

  const weakness = data?.weakness;
  setDisplay('weakness-card', weakness ? 'block' : 'none');
  if (weakness) {
    setText('weakness-text', weakness.description || weakness.weaknessDescription || '');
    setText('weakness-prompt', weakness.prompt || weakness.weaknessPrompt || '');
  }
}

function showSessionReport(report) {
  const body = getEl('report-body');
  if (!body) return;
  const reportAvg = Number(report.avgLogic);
  const rows = [
    ['최종 등급', report.finalRating || report.rating || '-'],
    ['평균 논리', Number.isFinite(reportAvg) && reportAvg >= 20 && reportAvg <= 100 ? `${reportAvg}%` : 'No record'],
    ['완료 턴', String(report.totalTurns || State.currentTurn || 0)],
  ];
  body.innerHTML = '<div class="grid grid-cols-3 gap-3 mb-4">' + rows.map(([label, value]) =>
    `<div class="stat-card text-center"><p class="text-lg font-bold text-gray-900">${esc(value)}</p><p class="text-xs text-gray-500">${esc(label)}</p></div>`,
  ).join('') + '</div>' +
    `<div class="card"><p class="text-sm text-gray-700 whitespace-pre-wrap">${esc(report.summary || report.strengths || '세션이 완료되었습니다.')}</p></div>`;
  setDisplay('report-modal', 'flex');
}

function closeReport() { setDisplay('report-modal', 'none'); }

async function startDeepReportPolling(sessionId, attempt = 0) {
  if (!sessionId || attempt >= 8) return;
  const epoch = State.authEpoch;
  window.setTimeout(async () => {
    if (epoch !== State.authEpoch) return;
    try {
      const report = await apiGet(`/api/session/${encodeURIComponent(sessionId)}/deep-report`);
      if (report.status === 'completed' || report.deepReport) {
        showSessionReport(report.deepReport || report.report || report);
        return;
      }
      if (report.status !== 'failed') startDeepReportPolling(sessionId, attempt + 1);
    } catch (error) {
      console.warn('[REPORT] Polling stopped:', error);
    }
  }, 3_000);
}

async function exportXAIFJsonLD() {
  if (!State.sessionId) return showToast('활성 세션이 없습니다.', 'info');
  try {
    const graph = await apiGet(`/api/session/${encodeURIComponent(State.sessionId)}/aif-graph`);
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/ld+json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `socratic-${State.sessionId}-xaif.jsonld`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

Object.assign(window, {
  hideLanding,
  resetGrowthLab,
  _enterApp: enterApp,
  syncNavigation,
  switchTab,
  openSessionConfigModal,
  closeSessionConfigModal,
  setSessionConfigMode,
  confirmSessionConfig,
  toggleUserMenu,
  toggleMobileDashboard,
  closeMobileDashboard,
  openSettings,
  closeSettings,
  setHintLevel,
  updateDashboard,
  showSessionReport,
  closeReport,
  startDeepReportPolling,
  exportXAIFJsonLD,
});
Object.assign(bridge, {
  enterApp,
  updateIdentityUI,
  syncNavigation,
  switchTab,
  closeMobileDashboard,
  openSessionConfigModal,
  updateDashboard,
  showSessionReport,
  startDeepReportPolling,
});

function initialize() {
  initAutoTheme();
  initMobileNav();
  document.addEventListener('keydown', handleMobileDashboardKeydown);
  document.addEventListener('keydown', handleSessionConfigModalKeydown);
  document.addEventListener('focusin', containMobileDashboardFocus);
  syncDashboardAccessibilityForViewport();
  window.matchMedia('(max-width: 768px)').addEventListener('change', syncDashboardAccessibilityForViewport);
  document.querySelectorAll('[data-version]').forEach((element) => {
    element.textContent = 'v35.1.0';
  });
  renderDemoGraph('landing-arg-demo').catch((error) => console.warn('[xAIF] Landing graph unavailable:', error));
  auth.checkSavedAuth().catch((error) => console.warn('[AUTH] Saved session check failed:', error));
  bridge.loadSparringBookSelector?.();
}

window.__SOCRATIC_MODULES_LOADED = moduleErrors.length === 0;
window.__SOCRATIC_MODULE_ERRORS = moduleErrors;
window.__SOCRATIC_MODULE_COUNT = 19;
window.__SOCRATIC_VERSION = '35.1.0';
window.__DEEPSKILL_FIDELITY_TARGET = 100;
window.__SOCRATIC_AI_PROVIDER = 'provider-registry';

initialize();
console.info(`[SocraticAI v35.1] Core lifecycle ready; legacy module errors: ${moduleErrors.length}`);
