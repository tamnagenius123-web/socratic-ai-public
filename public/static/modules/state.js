// ======================================================
// SocraticAI v26 — State Management Module
// ======================================================
export const State = {
  user: null, accessToken: null, refreshToken: null, authEpoch: 0,
  sessionId: null, messages: [], growthFollowUp: null,
  radarScores: {defense:0,consistency:0,evidence:0,relevance:0,clarity:0},
  currentTurn: 0, currentPhase: 'elicitation', hintLevel: 0, 
  topic: '', coreClaim: '', currentClaim: '',
  weakness: null, isLoading: false, isSessionActive: false, radarChart: null,
  selectedBookId: 'meditations-iv', currentTab: 'sparring', mobileDashOpen: false, searchTimeout: null,
  adminTab: 'overview',
  sparringStartMode: 'initial_claim',
  sparringState: 'idle',
  sparringControl: null, sparringRequestVersion: 0,
  // v26: Dark mode
  darkMode: localStorage.getItem('theme') === 'dark' || 
    (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches),
};

export function setSparringState(newState) {
  const prev = State.sparringState;
  State.sparringState = newState;
  console.log('[STATE] Sparring: ' + prev + ' -> ' + newState);
}

export function resetSparringState(opts) {
  opts = opts || {};
  window.invalidateSparringRequests?.();
  State.sparringControl = null;
  window.resetSparringRevisions?.();
  getEl('sparring-controls')?.remove();
  State.sessionId = null;
  State.growthFollowUp = null;
  State.messages = [];
  State.radarScores = {defense:0,consistency:0,evidence:0,relevance:0,clarity:0};
  State.currentTurn = 0;
  State.currentPhase = 'elicitation';
  State.hintLevel = 0;
  State.topic = '';
  State.coreClaim = '';
  State.currentClaim = '';
  State.weakness = null;
  State.isSessionActive = false;
  State.isLoading = false;
  if (!opts.preserveSelectedBook) State.selectedBookId = 'meditations-iv';
  setSparringState('idle');
  const chatContainer = getEl('chat-messages');
  if (chatContainer) chatContainer.innerHTML = '';
  setDisplay('sub-header', 'none');
  setDisplay('input-bar', 'none');
  setDisplay('weakness-card', 'none');
  if (window.innerWidth < 769) setDisplay('dashboard-sidebar', 'none');
  setDisplay('mobile-dash-btn', 'none');
}

// ---- DOM Helpers ----
// Account transitions discard browser-only learning data; persisted owner records remain on the server.
export function resetPrivateLearningState() {
  State.authEpoch += 1;
  resetSparringState();
  State.sparringRequestVersion += 1;
  State.currentTab = 'sparring';
  window.resetTrainingUI?.();
  window.clearPrivateNeuralWiki?.();
  window.clearPrivateHistory?.();
  window.closeSessionConfigModal?.(false);
  window.resetGrowthLab?.();
  getEl('report-body')?.replaceChildren();
  document.querySelectorAll('.report-overlay, .modal-overlay').forEach(dialog => { dialog.style.display = 'none'; });
  getEl('training-messages')?.replaceChildren();
  for (const id of ['user-input', 'training-input', 'debate-input', 'cc-input']) {
    const input = getEl(id);
    if (input) input.value = '';
  }
  localStorage.removeItem('sat_active_session');
  const pendingKeys = [];
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith('socratic-debate-pending-turn:')) pendingKeys.push(key);
  }
  pendingKeys.forEach(key => sessionStorage.removeItem(key));
}

export function getEl(id) { return document.getElementById(id); }
export function setDisplay(id, display) { const el = getEl(id); if (!el) return false; el.style.display = display; return true; }
export function setText(id, value) { const el = getEl(id); if (!el) return false; el.textContent = value; return true; }

export function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}
