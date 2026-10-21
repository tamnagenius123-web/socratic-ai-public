// SocraticAI v28 — Admin Module
(function(S) {
  const { State, getEl, api, apiGet, showToast, esc } = S;

  function hasFiniteNumber(value) { return value !== null && Number.isFinite(value); }
  function metricValue(value, suffix = '') { return hasFiniteNumber(value) ? String(value) + suffix : 'No record'; }
  function measuredAverageValue(value, sampleCount, suffix = '') {
    if (!hasFiniteNumber(value)) return 'No record';
    const hasExplicitSample = Number.isInteger(sampleCount) && sampleCount > 0;
    return value === 0 && !hasExplicitSample ? 'No record' : String(value) + suffix;
  }
  function errorState(error, subject, requiredRole = 'Admin or Instructor') {
    const status = Number(error?.status);
    const payload = error?.payload && typeof error.payload === 'object' ? error.payload : null;
    const cause = payload?.reason || error?.message || 'Unknown failure';
    const state = status === 404 ? 'No record' : status ? 'Unavailable' : 'Unknown';
    const nextAction = status === 401 ? 'Sign in again and retry.'
      : status === 403 ? 'Use an authorized ' + requiredRole + ' account.'
        : error?.retryable ? 'Retry shortly.' : 'Check the request and account permissions.';
    return '<div class="text-center text-gray-500 py-8"><p class="font-medium">'+esc(state)+': '+esc(subject)+'</p><p class="text-sm mt-1">'+esc(cause)+'</p><p class="text-xs mt-2">'+esc(nextAction)+'</p></div>';
  }
  function noRecordState(subject, nextAction) {
    return '<div class="text-center text-gray-500 py-8"><p class="font-medium">No record: '+esc(subject)+'</p><p class="text-xs mt-2">'+esc(nextAction)+'</p></div>';
  }
  function unknownState(subject, nextAction) {
    return '<div class="text-center text-gray-500 py-8"><p class="font-medium">Unknown: '+esc(subject)+'</p><p class="text-xs mt-2">'+esc(nextAction)+'</p></div>';
  }

  function switchAdminTab(tab) {
    State.adminTab = tab;
    document.querySelectorAll('[data-admintab]').forEach(el => el.classList.toggle('active', el.dataset.admintab === tab));
    if (tab === 'overview') loadAdminOverview();
    else if (tab === 'users') loadAdminUsers();
    else if (tab === 'ranking') loadAdminRanking();
    else if (tab === 'attrition') loadAdminAttrition();
    else if (tab === 'tokens') loadAdminTokenDashboard();
    else if (tab === 'arc') loadAdminARC();
    else if (tab === 'teacher') loadTeacherDashboard();
    else if (tab === 'counterfactual') loadCounterfactualUI();
  }

  function renderLearningEvidenceMetrics(value,container) {
    const section=document.createElement('section');section.className='card';section.dataset.learningRecordMetrics='true';
    const heading=document.createElement('h3');heading.textContent='스파링의 직접 기록';section.appendChild(heading);
    const fields=[['declaredRevisions','학습자가 남긴 수정 기록'],['acceptedRevisionFollowUps','수락된 후속 답변에 연결된 수정'],['pendingRevisionSessions','최신 수정이 아직 연결되지 않은 세션'],['savedSupportResponses','저장된 근거 설명'],['supportReferencedRevisions','저장 설명을 참고했다고 선택한 수정']];
    const available=value?.status==='AVAILABLE'&&value.scope==='SPARRING_EXPLICIT_RECORDS'&&fields.every(([key])=>Number.isSafeInteger(value[key])&&value[key]>=0);
    if(available){const list=document.createElement('dl');for(const [key,label] of fields){const term=document.createElement('dt'),count=document.createElement('dd');term.textContent=label;count.textContent=String(value[key]);list.append(term,count);}section.appendChild(list);}
    else {const missing=document.createElement('p');missing.textContent='직접 기록 수를 현재 확인할 수 없습니다. 0건이나 실패를 의미하지 않습니다.';section.appendChild(missing);}
    const limit=document.createElement('p');limit.textContent='저장된 직접 기록만 집계합니다. 과거 세션의 기록 범위, 설명의 실제 전달 여부와 학습 효과는 확인되지 않았습니다. 이 수치는 수정 성공률이나 숙련도를 뜻하지 않습니다.';section.appendChild(limit);container.appendChild(section);
  }

  async function loadAdminOverview() {
    const container = getEl('admin-content'); if (!container) return;
    try {
      const data = await apiGet('/api/analytics/overview');
      const avgLogicSampleCount = data.avgLogicSampleCount ?? data.avgLogicScoreSampleCount;
      container.innerHTML = '<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"><div class="card text-center"><p class="text-3xl font-bold text-primary-500">'+metricValue(data.totalUsers)+'</p><p class="text-xs text-gray-500">전체 부원</p></div><div class="card text-center"><p class="text-3xl font-bold text-green-500">'+metricValue(data.activeUsers)+'</p><p class="text-xs text-gray-500">활성 사용자</p></div><div class="card text-center"><p class="text-3xl font-bold text-indigo-500">'+metricValue(data.totalSessions)+'</p><p class="text-xs text-gray-500">누적 세션</p></div><div class="card text-center"><p class="text-3xl font-bold text-amber-500">'+measuredAverageValue(data.avgLogicScore, avgLogicSampleCount, '%')+'</p><p class="text-xs text-gray-500">평균 논리</p></div></div>';
      renderLearningEvidenceMetrics(data.opsMetrics?.learningEvidence,container);
    } catch(e) { container.innerHTML = errorState(e, 'Admin overview'); }
  }

  async function loadAdminUsers() {
    const container = getEl('admin-content'); if (!container) return;
    try {
      const data = await apiGet('/api/admin/users');
      if (!Array.isArray(data.users)) { container.innerHTML = unknownState('User directory', 'Ask an administrator to verify the user record response.'); return; }
      if (!data.users.length) { container.innerHTML = noRecordState('User directory', 'There are no active users.'); return; }

      const list = document.createElement('div');
      list.className = 'space-y-3';
      data.users.forEach((user) => {
        const row = document.createElement('div');
        row.className = 'card flex items-center justify-between';
        const identity = document.createElement('div');
        const username = document.createElement('span');
        username.className = 'font-bold text-gray-900';
        username.textContent = String(user.username || 'Unknown');
        const email = document.createElement('span');
        email.className = 'text-xs text-gray-500 ml-2';
        email.textContent = String(user.email || 'No record');
        const role = document.createElement('span');
        role.className = 'text-[10px] bg-primary-50 text-primary-600 px-2 py-0.5 rounded-full ml-2';
        role.textContent = String(user.role || 'Unknown');
        identity.append(username, email, role);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-secondary text-xs';
        button.setAttribute('aria-label', 'View ' + username.textContent + ' sessions');
        const icon = document.createElement('i');
        icon.className = 'fas fa-eye';
        button.appendChild(icon);
        button.addEventListener('click', () => viewUserSessions(String(user.id || ''), username.textContent || 'Unknown'));
        row.append(identity, button);
        list.appendChild(row);
      });
      container.replaceChildren(list);
    } catch(e) { container.innerHTML = errorState(e, 'User directory', 'Admin'); }
  }

  async function viewUserSessions(userId, username) {
    try {
      const data = await apiGet('/api/admin/users/' + encodeURIComponent(String(userId)) + '/sessions');
      const container = getEl('admin-content'); if (!container) return;
      if (!Array.isArray(data.sessions)) { container.innerHTML = unknownState('User sessions', 'Ask an administrator to verify the session record response.'); return; }
      if (!data.sessions.length) { container.innerHTML = noRecordState('User sessions', 'This user has no recorded sessions.'); return; }
      container.innerHTML = '<div class="mb-4"><button onclick="switchAdminTab(\'users\')" class="btn-secondary text-sm"><i class="fas fa-arrow-left mr-1"></i>돌아가기</button><h3 class="font-bold text-gray-900 mt-2">'+esc(username)+' 세션 기록</h3></div><div class="space-y-2">' + data.sessions.map(s => '<div class="card"><div class="flex justify-between"><span class="font-bold text-sm">'+esc(s.bookTitle || s.topic || 'No record')+'</span><span class="text-xs text-gray-500">'+(s.createdAt ? new Date(s.createdAt).toLocaleDateString('ko-KR') : 'No record')+'</span></div></div>').join('') + '</div>';
    } catch(e) { const container = getEl('admin-content'); if (container) container.innerHTML = errorState(e, 'User sessions', 'Admin'); }
  }

  async function loadAdminRanking() {
    const container = getEl('admin-content'); if (!container) return;
    try {
      const data = await apiGet('/api/analytics/performance-ranking');
      const rankings = Array.isArray(data.rankings) ? data.rankings : null;
      if (!rankings) { container.innerHTML = unknownState('Performance ranking', 'Ask an authorized Admin or Instructor to verify analytics data.'); return; }
      if (!rankings.length) { container.innerHTML = noRecordState('Performance ranking', 'There are no ranked sessions yet.'); return; }
      container.innerHTML = '<div class="space-y-2">' + rankings.map((r,i) => '<div class="card flex items-center gap-4"><span class="text-lg font-bold text-gray-300 w-8">#'+(hasFiniteNumber(r.rank) ? r.rank : i + 1)+'</span><div class="flex-1"><span class="font-bold text-gray-900">'+esc(r.username || 'Unknown')+'</span><div class="text-xs text-gray-500">'+metricValue(r.totalSessions)+' sessions · '+metricValue(r.avgLogic, '%')+' avg</div></div><span class="text-lg font-bold text-primary-500">'+metricValue(r.completionRate, '%')+'</span></div>').join('') + '</div>';
    } catch(e) { container.innerHTML = errorState(e, 'Performance ranking'); }
  }

  async function loadAdminAttrition() {
    const container = getEl('admin-content'); if (!container) return;
    try {
      const data = await apiGet('/api/analytics/attrition-analysis');
      if (!Array.isArray(data.byTurn)) {
        container.innerHTML = unknownState('Attrition analysis', 'Ask an authorized Admin or Instructor to verify analytics data.');
        return;
      }
      if (!data.byTurn.length) {
        container.innerHTML = noRecordState('Attrition analysis', 'There are no recorded abandoned sessions.');
        return;
      }
      container.innerHTML = '<div class="card"><h3 class="font-bold text-gray-900 mb-3"><i class="fas fa-chart-bar text-red-500 mr-2"></i>이탈 분석</h3><canvas id="attrition-chart" height="250"></canvas></div>';
      const cv = getEl('attrition-chart'); if (!cv) return;
      new Chart(cv.getContext('2d'), { type: 'bar', data: { labels: data.byTurn.map(entry => 'Turn ' + metricValue(entry.turn)), datasets: [{ label: 'Abandoned sessions', data: data.byTurn.map(entry => hasFiniteNumber(entry.count) ? entry.count : null), backgroundColor: 'rgba(239,68,68,0.6)' }] }, options: { responsive: true, scales: { y: { beginAtZero: true } } } });
    } catch(e) { container.innerHTML = errorState(e, 'Attrition analysis'); }
  }

  async function loadAdminTokenDashboard() {
    const container = getEl('admin-content'); if (!container) return;
    try {
      const data = await apiGet('/api/admin/token-usage/summary');
      container.innerHTML = '<div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6"><div class="card text-center"><p class="text-2xl font-bold text-primary-500">'+(hasFiniteNumber(data.totalTokens) ? formatNumber(data.totalTokens) : 'No record')+'</p><p class="text-xs text-gray-500">Total Tokens</p></div><div class="card text-center"><p class="text-2xl font-bold text-green-500">'+(hasFiniteNumber(data.totalCredits) ? formatNumber(data.totalCredits) : 'No record')+'</p><p class="text-xs text-gray-500">Total Credits</p></div><div class="card text-center"><p class="text-2xl font-bold text-amber-500">'+(hasFiniteNumber(data.totalCostKRW) ? formatNumber(data.totalCostKRW) + ' KRW' : 'No record')+'</p><p class="text-xs text-gray-500">예상 비용</p></div></div>';
    } catch(e) { container.innerHTML = errorState(e, 'Token usage', 'Admin'); }
  }

  function formatNumber(n) { if (n >= 1000000) return (n/1000000).toFixed(1)+'M'; if (n >= 1000) return (n/1000).toFixed(1)+'K'; return String(n); }

  async function loadAdminARC() {
    const container = getEl('admin-content'); if (!container) return;
    try {
      const data = await apiGet('/api/admin/arc-weights');
      const snapshots = Array.isArray(data.snapshots) ? data.snapshots : null;
      if (!snapshots) { container.innerHTML = unknownState('ARC weights', 'Ask an administrator to verify the ARC weight response.'); return; }
      if (!snapshots.length) { container.innerHTML = noRecordState('ARC weights', 'No ARC weight snapshots have been recorded.'); return; }
      container.innerHTML = '<div class="card"><h3 class="font-bold text-gray-900 mb-3"><i class="fas fa-cogs text-purple-500 mr-2"></i>ARC 관리</h3><p class="text-sm text-gray-600">Latest snapshot: '+metricValue(snapshots[0].version)+'</p></div>';
    } catch(e) { container.innerHTML = errorState(e, 'ARC weights', 'Admin'); }
  }

  async function loadTeacherDashboard(orgId) {
    const container = getEl('admin-content'); if (!container) return;
    if (!orgId || !String(orgId).trim()) {
      container.innerHTML = '<div class="card mb-6"><h3 class="font-bold text-gray-900 mb-3"><i class="fas fa-chalkboard-teacher text-primary-500 mr-2"></i>교사 대시보드</h3><p class="text-sm text-gray-600 mb-4">Organization ID is required before class progress can be requested.</p><div class="flex gap-3"><input type="text" id="teacher-org-id" class="flex-1 px-4 py-2 border rounded-xl text-sm" placeholder="Organization ID"><button onclick="loadTeacherDashboard(document.getElementById(\'teacher-org-id\').value)" class="btn-primary text-sm">Load progress</button></div></div>';
      return;
    }
    try {
      const data = await apiGet('/api/teacher/class/' + encodeURIComponent(String(orgId).trim()) + '/progress');
      const progress = Array.isArray(data.classProgress) ? data.classProgress : null;
      if (!progress) { container.innerHTML = unknownState('Class progress', 'Confirm the organization ID and membership.'); return; }
      if (!progress.length) { container.innerHTML = noRecordState('Class progress', 'This organization has no recorded class progress.'); return; }
      container.innerHTML = '<div class="card mb-6"><h3 class="font-bold text-gray-900 mb-3"><i class="fas fa-chalkboard-teacher text-primary-500 mr-2"></i>교사 대시보드</h3><p class="text-xs text-gray-500 mb-3">Organization: '+esc(data.orgId || String(orgId).trim())+'</p><div class="space-y-2">'+progress.map(student => '<div class="flex justify-between text-sm"><span>'+esc(student.username || 'Unknown')+'</span><span>'+metricValue(student.avg_overall, '%')+' overall · '+metricValue(student.session_count)+' sessions</span></div>').join('')+'</div></div>';
    } catch(e) { container.innerHTML = errorState(e, 'Class progress'); }
  }

  async function loadCounterfactualUI() {
    const container = getEl('admin-content'); if (!container) return;
    container.innerHTML = '<div class="card"><h3 class="font-bold text-gray-900 mb-3"><i class="fas fa-magic text-violet-500 mr-2"></i>반사실적 코칭</h3><p class="text-sm text-gray-600 mb-4">학생의 세션을 선택하여 "만약 다른 전략을 사용했다면?" 시뮬레이션을 실행합니다.</p><div class="flex gap-3"><input type="text" id="cf-session-id" class="flex-1 px-4 py-2 border rounded-xl text-sm" placeholder="세션 ID"><button onclick="runCounterfactual(document.getElementById(\'cf-session-id\').value)" class="btn-primary text-sm"><i class="fas fa-play mr-1"></i>실행</button></div><div id="cf-result" class="mt-4"></div></div>';
  }

  async function runCounterfactual(sessionId) {
    if (!sessionId) return showToast('세션 ID를 입력하세요.', 'error');
    const result = getEl('cf-result'); if (!result) return;
    result.innerHTML = '<div class="text-center py-4"><i class="fas fa-spinner fa-spin text-primary-500"></i> 시뮬레이션 중...</div>';
    try {
      const data = await apiGet('/api/counterfactual/' + encodeURIComponent(sessionId));
      result.innerHTML = '<div class="bg-violet-50 border border-violet-200 rounded-xl p-4"><p class="text-xs font-bold text-violet-700 uppercase mb-2">반사실적 분석 결과</p><p class="text-sm text-gray-700">'+esc(data.reason || data.analysis || 'No record')+'</p></div>';
    } catch(e) {
      const payload = e?.payload && typeof e.payload === 'object' ? e.payload : null;
      if (e?.status === 503 && payload?.status === 'UNGRADABLE') {
        result.innerHTML = '<div class="text-sm text-gray-600"><p class="font-medium">Unavailable: UNGRADABLE</p><p class="mt-1">'+esc(payload.reason || e.message)+'</p><p class="text-xs mt-2">Use observed session evidence; no counterfactual result is available.</p></div>';
      } else {
        result.innerHTML = '<div class="text-red-500 text-sm">'+esc(e?.message || 'Failed')+'</div>';
      }
    }
  }

  function openAddUserModal() { const m = getEl('adduser-modal'); if (m) m.style.display = 'flex'; }
  function closeAddUserModal() { const m = getEl('adduser-modal'); if (m) m.style.display = 'none'; }
  async function doAddUser() {
    const name = getEl('au-name')?.value.trim(), email = getEl('au-email')?.value.trim(), password = getEl('au-password')?.value.trim();
    const studentId = getEl('au-studentid')?.value.trim(), grade = getEl('au-grade')?.value, role = getEl('au-role')?.value;
    if (!name || !email || !password) return showToast('필수 항목을 입력하세요.', 'error');
    try { await api('/api/admin/users', { username: name, email, password, studentId, grade: grade?parseInt(grade):undefined, role }); showToast('부원이 추가되었습니다!', 'success'); closeAddUserModal(); loadAdminUsers(); } catch(e) { showToast(e.message, 'error'); }
  }

  window.switchAdminTab = switchAdminTab;
  window.loadAdminOverview = loadAdminOverview;
  window.loadAdminUsers = loadAdminUsers;
  window.viewUserSessions = viewUserSessions;
  window.loadAdminRanking = loadAdminRanking;
  window.loadAdminAttrition = loadAdminAttrition;
  window.loadAdminTokenDashboard = loadAdminTokenDashboard;
  window.loadAdminARC = loadAdminARC;
  window.loadTeacherDashboard = loadTeacherDashboard;
  window.loadCounterfactualUI = loadCounterfactualUI;
  window.runCounterfactual = runCounterfactual;
  window.openAddUserModal = openAddUserModal;
  window.closeAddUserModal = closeAddUserModal;
  window.doAddUser = doAddUser;
  S.loadAdminOverview = loadAdminOverview;
  S.switchAdminTab = switchAdminTab;
})(window.SocraticAI);
