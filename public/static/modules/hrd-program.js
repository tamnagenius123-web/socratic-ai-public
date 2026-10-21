// ======================================================
// SocraticAI v35.1 — HRD Program operator surface
// ======================================================

import { apiGet } from './utils.js';
import { getEl } from './state.js';

const OBSERVATION_STATES = new Set([
  'MEASURED',
  'UNOBSERVED',
  'UNKNOWN',
  'UNAVAILABLE',
  'FAILED',
  'IN_PROGRESS',
]);

const state = {
  mode: 'idle',
  programs: [],
  selectedProgramId: '',
  enrollments: [],
  selectedEnrollmentId: '',
  detail: null,
  filter: 'all',
  error: null,
  requestGeneration: 0,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function getRoot() {
  return getEl('hrd-program-content');
}

function clearRoot() {
  const root = getRoot();
  if (root) root.replaceChildren();
  return root;
}

function statusLabel(value) {
  return OBSERVATION_STATES.has(value) ? value : 'UNKNOWN';
}

function statePanel(title, message, nextStep, retry) {
  const panel = element('div', 'card border border-gray-200 bg-white p-5 md:p-6');
  panel.setAttribute('role', 'status');
  panel.append(
    element('h2', 'text-lg font-bold text-gray-900', title),
    element('p', 'mt-2 text-sm text-gray-600', message),
    element('p', 'mt-3 text-sm font-semibold text-primary-700', `Next step: ${nextStep}`),
  );
  if (retry) {
    const button = element('button', 'btn-primary mt-4 min-h-[44px] px-4', 'Retry');
    button.type = 'button';
    button.addEventListener('click', retry);
    panel.append(button);
  }
  return panel;
}

function renderState() {
  const root = clearRoot();
  if (!root) return;
  if (state.mode === 'loading-programs') {
    root.append(statePanel('Loading HRD Programs', 'Checking authorized program memberships.', 'Wait for the authorized program list.'));
    return;
  }
  if (state.mode === 'loading-enrollments') {
    root.append(statePanel('Loading Enrollment Records', 'Loading the selected program’s current enrollment records.', 'Wait for the enrollment list.'));
    return;
  }
  if (state.mode === 'loading-detail') {
    root.append(statePanel('Loading Competency Evidence', 'Loading rubric-pinned observations for the selected enrollment.', 'Wait for the competency detail.'));
    return;
  }
  if (state.error) {
    root.append(statePanel(state.error.title, state.error.message, state.error.nextStep, state.error.retry));
    return;
  }
  if (state.programs.length === 0) {
    root.append(statePanel(
      'No Active HRD Program Membership',
      'No authorized HRD Program membership is available for this account.',
      'Use your organization’s HRD access-provisioning channel to request an active program membership for this account.',
    ));
    return;
  }
  renderWorkspace(root);
}

function labelValue(label, value) {
  const wrapper = element('div', 'min-w-0');
  wrapper.append(element('dt', 'text-[11px] font-semibold uppercase tracking-wide text-gray-500', label));
  wrapper.append(element('dd', 'mt-1 break-words text-sm font-semibold text-gray-900', displayValue(value)));
  return wrapper;
}

function formatDate(value, timezone) {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  try {
    return new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone || undefined,
    }).format(date);
  } catch {
    return 'Not recorded';
  }
}

function renderProgramSelector(root) {
  const wrapper = element('div', 'card mb-4 border border-gray-200 bg-white p-4 md:p-5');
  const heading = element('div', 'flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between');
  const title = element('div');
  title.append(
    element('p', 'text-xs font-bold uppercase tracking-[0.12em] text-primary-600', 'HRD Program'),
    element('h2', 'mt-1 text-xl font-bold text-gray-900', 'Evidence review'),
  );
  const selectLabel = element('label', 'block w-full min-w-0 text-sm font-semibold text-gray-700 sm:w-auto', 'Authorized program');
  const select = document.createElement('select');
  select.className = 'mt-1 block min-h-[44px] w-full min-w-0 max-w-full rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-900 sm:w-[22rem]';
  select.id = 'hrd-program-selector';
  select.setAttribute('aria-label', 'Authorized HRD Program');
  for (const program of state.programs) {
    const option = document.createElement('option');
    option.value = program.id;
    option.textContent = `${program.displayName} (${program.code})`;
    option.selected = program.id === state.selectedProgramId;
    select.append(option);
  }
  select.addEventListener('change', () => loadEnrollments(select.value));
  selectLabel.append(select);
  heading.append(title, selectLabel);
  wrapper.append(heading);
  root.append(wrapper);
}

function renderScopeSpine(program, root) {
  const banner = element('section', 'card mb-4 border border-indigo-100 bg-indigo-50/50 p-4 md:p-5');
  banner.setAttribute('aria-labelledby', 'hrd-program-scope-title');
  const title = element('h2', 'text-base font-bold text-indigo-950', 'Program scope and evidence spine');
  title.id = 'hrd-program-scope-title';
  const intro = element('p', 'mt-1 text-sm text-indigo-900/80', 'This scope binds the records below to the authorized program policy.');
  const grid = element('dl', 'mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4');
  grid.append(
    labelValue('Program code', program.code),
    labelValue('Declared organization reference', `${program.scope?.type || 'Not recorded'} / ${program.scope?.reference || 'Not recorded'}`),
    labelValue('Policy revision', program.policyRevision),
    labelValue('Operator role', program.operatorRole),
    labelValue('Denominator policy', program.denominatorPolicy),
    labelValue('Enrollment records', state.enrollments.length),
    labelValue('Measured records', state.enrollments.filter((enrollment) => enrollment.evidenceState === 'MEASURED').length),
    labelValue('Last observed', formatDate(program.lastObservedAt)),
  );
  banner.append(title, intro, grid);
  root.append(banner);
}

function filterEnrollments() {
  if (state.filter === 'measured') return state.enrollments.filter((enrollment) => enrollment.evidenceState === 'MEASURED');
  if (state.filter === 'needs-evidence') return state.enrollments.filter((enrollment) => enrollment.evidenceState !== 'MEASURED');
  return state.enrollments;
}

function renderFilters(root) {
  const toolbar = element('div', 'mb-3 flex flex-wrap items-center gap-2');
  toolbar.append(element('span', 'mr-1 text-sm font-semibold text-gray-700', 'Enrollment records'));
  const filters = [
    ['all', 'All', state.enrollments.length],
    ['measured', 'Measured', state.enrollments.filter((enrollment) => enrollment.evidenceState === 'MEASURED').length],
    ['needs-evidence', 'Needs evidence', state.enrollments.filter((enrollment) => enrollment.evidenceState !== 'MEASURED').length],
  ];
  for (const [id, label, count] of filters) {
    const button = element('button', `min-h-[44px] rounded-xl border px-3 text-sm font-semibold ${state.filter === id ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300 bg-white text-gray-700'}`, `${label} (${count})`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.filter === id));
    button.addEventListener('click', () => {
      state.filter = id;
      renderState();
    });
    toolbar.append(button);
  }
  root.append(toolbar);
}

function renderEnrollmentRow(enrollment) {
  const button = element('button', 'w-full rounded-xl border border-gray-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-indigo-600');
  button.type = 'button';
  button.setAttribute('aria-pressed', String(enrollment.id === state.selectedEnrollmentId));
  if (enrollment.id === state.selectedEnrollmentId) button.classList.add('border-indigo-500', 'bg-indigo-50');
  const top = element('div', 'flex flex-wrap items-start justify-between gap-2');
  top.append(element('span', 'font-bold text-gray-900', enrollment.learner?.displayName || 'Not recorded'));
  top.append(element('span', 'rounded-full bg-gray-100 px-2 py-1 text-[11px] font-bold text-gray-700', statusLabel(enrollment.evidenceState)));
  const meta = element('div', 'mt-3 grid grid-cols-1 gap-2 text-xs text-gray-600 sm:grid-cols-2');
  meta.append(element('span', '', `Enrollment: ${enrollment.status || 'Not recorded'}`));
  meta.append(element('span', '', `Revision: ${enrollment.enrollmentRevision ?? 'Not recorded'}`));
  meta.append(element('span', '', `Allocation: ${enrollment.allocationSource || 'Not recorded'}`));
  meta.append(element('span', '', `Start: ${formatDate(enrollment.schedule?.startAt, enrollment.schedule?.timezone)}`));
  button.append(top, meta);
  button.addEventListener('click', () => loadEnrollmentDetail(enrollment.id));
  return button;
}

function renderEnrollmentList(root) {
  const panel = element('section', 'min-w-0', undefined);
  panel.setAttribute('aria-labelledby', 'hrd-enrollment-list-title');
  const title = element('h2', 'sr-only', 'Enrollment list');
  title.id = 'hrd-enrollment-list-title';
  panel.append(title);
  const rows = filterEnrollments();
  if (rows.length === 0) {
    panel.append(statePanel(
      state.enrollments.length === 0 ? 'No Enrollment Records' : 'No Matching Enrollment Records',
      state.enrollments.length === 0 ? 'This authorized program has no visible enrollment records.' : 'No currently loaded enrollment matches this filter.',
      state.enrollments.length === 0 ? 'Ask the program administrator to verify enrollment provisioning.' : 'Choose All or another filter to inspect the loaded records.',
    ));
  } else {
    const list = element('div', 'space-y-3');
    for (const enrollment of rows) list.append(renderEnrollmentRow(enrollment));
    panel.append(list);
  }
  root.append(panel);
}

function measuredValue(observation) {
  if (observation?.status !== 'MEASURED') return 'Not recorded';
  if (typeof observation.value !== 'number' || !observation.valueScale) return 'Not recorded';
  return `${observation.value} (${observation.valueScale})`;
}

function evidenceCount(observation) {
  return Array.isArray(observation?.evidenceManifestIds)
    ? String(observation.evidenceManifestIds.length)
    : 'Not recorded';
}

function renderCompetency(competency, timezone) {
  const card = element('article', 'rounded-xl border border-gray-200 bg-white p-4');
  const heading = element('div', 'flex flex-wrap items-start justify-between gap-3');
  const name = element('div');
  name.append(
    element('h3', 'font-bold text-gray-900', competency.displayName || 'Not recorded'),
    element('p', 'mt-1 text-xs text-gray-500', competency.code || 'Not recorded'),
  );
  const observation = competency.observation || {};
  heading.append(name, element('span', 'rounded-full bg-gray-100 px-2 py-1 text-[11px] font-bold text-gray-700', statusLabel(observation.status)));
  const grid = element('dl', 'mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2');
  grid.append(
    labelValue('Rubric version', observation.rubricVersion?.version ?? competency.rubricVersion?.version ?? 'Not recorded'),
    labelValue('Typed evidence state', statusLabel(observation.status)),
    labelValue('Stored status', observation.storedStatus || 'Not recorded'),
    labelValue('Observation time', formatDate(observation.observedAt, timezone)),
    labelValue('Evidence count', evidenceCount(observation)),
    labelValue('Stored value', measuredValue(observation)),
  );
  card.append(heading, grid);
  const evidenceStatus = statusLabel(observation.status);
  if (evidenceStatus !== 'MEASURED') {
    card.append(element('p', 'mt-4 rounded-lg bg-gray-50 p-3 text-sm text-gray-700', `Next step: ${nextStepForObservation(evidenceStatus)}`));
  }
  return card;
}

function nextStepForObservation(status) {
  switch (statusLabel(status)) {
    case 'UNOBSERVED':
      return 'Contact the team responsible for HRD evidence provisioning to create an authorized program-owned evidence record; keep this UNOBSERVED until it exists, then reload.';
    case 'IN_PROGRESS':
      return 'Finish the active evidence attempt in this HRD Program.';
    case 'UNAVAILABLE':
      return 'Retry later or contact the program operator.';
    case 'FAILED':
      return 'Contact the program operator to inspect the failed evidence record.';
    case 'UNKNOWN':
    default:
      return 'Ask the program operator to verify rubric and evidence configuration.';
  }
}

function renderDetail(root) {
  const panel = element('section', 'min-w-0', undefined);
  panel.setAttribute('aria-labelledby', 'hrd-competency-detail-title');
  const title = element('h2', 'text-base font-bold text-gray-900', 'Competency detail');
  title.id = 'hrd-competency-detail-title';
  panel.append(title);
  if (!state.detail) {
    panel.append(statePanel('Select an Enrollment', 'Choose an enrollment record to inspect its rubric-pinned evidence.', 'Select an enrollment record from the list.'));
  } else {
    const { program, enrollment, authorization, competencies } = state.detail;
    const context = element('div', 'mb-3 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700');
    context.append(
      element('p', 'font-semibold text-gray-900', enrollment.learner?.displayName || 'Not recorded'),
      element('p', 'mt-1', `Authorization: ${authorization?.role || 'Not recorded'} · Policy revision: ${authorization?.policyRevision ?? 'Not recorded'}`),
      element('p', 'mt-1', `Evaluated: ${formatDate(authorization?.evaluatedAt)} · Program: ${program?.code || 'Not recorded'}`),
    );
    panel.append(context);
    if (!Array.isArray(competencies) || competencies.length === 0) {
      panel.append(statePanel('No Competencies Recorded', 'The selected enrollment has no active competency records available.', 'Ask the program administrator to verify competency provisioning.'));
    } else {
      const list = element('div', 'space-y-3');
      for (const competency of competencies) list.append(renderCompetency(competency, enrollment.schedule?.timezone));
      panel.append(list);
    }
  }
  root.append(panel);
}

function renderWorkspace(root) {
  const program = state.programs.find((candidate) => candidate.id === state.selectedProgramId) || state.programs[0];
  if (!program) return;
  renderProgramSelector(root);
  renderScopeSpine(program, root);
  renderFilters(root);
  const workArea = element('div', 'grid grid-cols-1 gap-6 xl:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.4fr)]');
  renderEnrollmentList(workArea);
  renderDetail(workArea);
  root.append(workArea);
}

function displayValue(value) {
  return value === null || value === undefined || value === '' ? 'Not recorded' : String(value);
}

function errorState(error, retry) {
  const status = Number(error?.status || 0);
  if (status === 403) return { title: 'HRD Program Access Required', message: 'HRD Program is available only to provisioned HRD operator accounts.', nextStep: 'Ask a SocraticAI administrator to provision the operator role and program membership.', retry: null };
  if (status === 404) return { title: 'Program Scope Unavailable', message: 'The selected program was not found or is no longer authorized for this account.', nextStep: 'Reload the authorized program list.', retry };
  return { title: status === 503 || status === 0 ? 'HRD Program Unavailable' : 'HRD Program Request Failed', message: 'The requested HRD Program data could not be loaded.', nextStep: status === 503 || status === 0 ? 'Retry when the service is available.' : 'Review the account scope with an administrator.', retry: status === 503 || status === 0 ? retry : null };
}

function isSharedAuthExpiry(error) {
  return Number(error?.status || 0) === 401;
}

async function loadPrograms() {
  const generation = ++state.requestGeneration;
  state.mode = 'loading-programs';
  state.error = null;
  state.detail = null;
  renderState();
  try {
    const data = await apiGet('/api/hrd/programs');
    if (generation !== state.requestGeneration) return;
    state.programs = Array.isArray(data?.programs) ? data.programs : [];
    state.selectedProgramId = state.programs.some((program) => program.id === state.selectedProgramId)
      ? state.selectedProgramId
      : state.programs[0]?.id || '';
    state.mode = 'idle';
    if (!state.selectedProgramId) {
      renderState();
      return;
    }
    await loadEnrollments(state.selectedProgramId);
  } catch (error) {
    if (generation !== state.requestGeneration) return;
    if (isSharedAuthExpiry(error)) return;
    state.mode = 'idle';
    state.error = errorState(error, loadPrograms);
    renderState();
  }
}

async function loadEnrollments(programId) {
  const generation = ++state.requestGeneration;
  state.mode = 'loading-enrollments';
  state.error = null;
  state.selectedProgramId = programId;
  state.selectedEnrollmentId = '';
  state.enrollments = [];
  state.detail = null;
  renderState();
  try {
    const data = await apiGet(`/api/hrd/programs/${encodeURIComponent(programId)}/enrollments`);
    if (generation !== state.requestGeneration) return;
    state.enrollments = Array.isArray(data?.enrollments) ? data.enrollments : [];
    state.mode = 'idle';
    renderState();
  } catch (error) {
    if (generation !== state.requestGeneration) return;
    if (isSharedAuthExpiry(error)) return;
    if (Number(error?.status || 0) === 404) {
      state.programs = [];
      state.selectedProgramId = '';
      state.mode = 'idle';
      state.error = errorState(error, loadPrograms);
      renderState();
      await loadPrograms();
      return;
    }
    state.mode = 'idle';
    state.error = errorState(error, () => loadEnrollments(programId));
    renderState();
  }
}

async function loadEnrollmentDetail(enrollmentId) {
  const programId = state.selectedProgramId;
  if (!programId || !enrollmentId) return;
  const generation = ++state.requestGeneration;
  state.mode = 'loading-detail';
  state.error = null;
  state.selectedEnrollmentId = enrollmentId;
  state.detail = null;
  renderState();
  try {
    const data = await apiGet(`/api/hrd/programs/${encodeURIComponent(programId)}/enrollments/${encodeURIComponent(enrollmentId)}`);
    if (generation !== state.requestGeneration) return;
    state.detail = data;
    state.mode = 'idle';
    renderState();
  } catch (error) {
    if (generation !== state.requestGeneration) return;
    if (isSharedAuthExpiry(error)) return;
    if (Number(error?.status || 0) === 404) {
      state.mode = 'idle';
      state.error = errorState(error, loadPrograms);
      state.selectedProgramId = '';
      state.selectedEnrollmentId = '';
      state.detail = null;
      renderState();
      await loadPrograms();
      return;
    }
    state.mode = 'idle';
    state.error = errorState(error, () => loadEnrollmentDetail(enrollmentId));
    renderState();
  }
}

export function loadHrdProgramTab() {
  state.error = null;
  return loadPrograms();
}
