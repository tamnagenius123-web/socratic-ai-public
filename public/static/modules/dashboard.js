// SocraticAI v35 — Personal learning dashboard
(function initializeDashboardModule(S) {
  const { State, getEl, api, apiGet, showToast, esc, escapeAttribute } = S;

  function finiteNumber(value) {
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'object' || (typeof value === 'string' && value.trim() === '')) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function finiteCount(value) {
    const number = finiteNumber(value);
    return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
  }

  // The current dashboard response exposes all-session averages, not a matching
  // completed/measured sample. Only an explicitly paired aggregate may be used.
  function completedMeasuredAverage(group, averageKey, sampleCountKey) {
    const completed = finiteCount(group?.completed);
    const sampleCount = finiteCount(group?.[sampleCountKey]);
    const average = finiteNumber(group?.[averageKey]);
    return completed !== null && completed > 0 && sampleCount === completed && average !== null ? average : null;
  }

  function metricValue(value, format = (number) => String(number)) {
    const number = finiteNumber(value);
    return number === null ? 'No record' : format(number);
  }

  function noRecord(message = 'No record') {
    return `<p class="text-center text-gray-400 text-sm py-4">${esc(message)}</p>`;
  }

  function statBox(label, value, icon, color) {
    return `<div class="card text-center"><div class="w-10 h-10 bg-${color}-50 rounded-xl flex items-center justify-center mx-auto mb-2"><i class="fas ${icon} text-${color}-500" aria-hidden="true"></i></div><p class="text-xl font-bold text-gray-900">${esc(String(value))}</p><p class="text-xs text-gray-500 mt-1">${esc(label)}</p></div>`;
  }

  async function loadPersonalDashboard() {
    const container = getEl('personal-dashboard-content');
    if (!container) return;
    try {
      const data = await apiGet('/api/dashboard');
      const sparring = data.sparring || {};
      const training = data.training || {};
      const sparringTotal = finiteCount(sparring.total);
      const trainingTotal = finiteCount(training.total);
      const sparringCompleted = finiteCount(sparring.completed);
      const trainingCompleted = finiteCount(training.completed);
      const totalSessions = sparringTotal !== null && trainingTotal !== null ? sparringTotal + trainingTotal : null;
      const completedSessions = sparringCompleted !== null && trainingCompleted !== null
        ? sparringCompleted + trainingCompleted
        : null;
      const sparringScore = completedMeasuredAverage(sparring, 'completedAvgScore', 'completedScoreSampleCount');
      const trainingScore = completedMeasuredAverage(training, 'completedAvgScore', 'completedScoreSampleCount');
      const scoreSamples = [
        { count: sparringCompleted, score: sparringScore },
        { count: trainingCompleted, score: trainingScore },
      ];
      const knownCompletionCounts = sparringCompleted !== null && trainingCompleted !== null;
      const hasCompletedScore = scoreSamples.some((sample) => sample.count !== null && sample.count > 0);
      const completedModesMeasured = scoreSamples.every((sample) => sample.count === 0 || sample.score !== null);
      const weightedScore = knownCompletionCounts && hasCompletedScore && completedModesMeasured
        ? Math.round(scoreSamples.reduce((sum, sample) => sum + sample.score * sample.count, 0) / scoreSamples.reduce((sum, sample) => sum + sample.count, 0))
        : null;
      const evidence = completedMeasuredAverage(sparring, 'completedAvgEvidence', 'completedEvidenceSampleCount');
      let html = '<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">';
      html += statBox('총 세션', metricValue(totalSessions), 'fa-comments', 'primary');
      html += statBox('완료 세션', metricValue(completedSessions), 'fa-check-circle', 'green');
      html += statBox('평균 논리', metricValue(weightedScore, (number) => `${number}%`), 'fa-brain', 'indigo');
      html += statBox('근거 사용', metricValue(evidence, (number) => number.toFixed(1)), 'fa-book-open', 'amber');
      html += '</div>';
      const measuredProgression = getMeasuredProgression(data.progression);
      html += '<div class="card mb-6"><h3 class="font-bold text-gray-900 mb-3"><i class="fas fa-chart-line text-primary-500 mr-2" aria-hidden="true"></i>세션별 성장 추이</h3><div id="progression-card-body">';
      html += measuredProgression.length > 0 ? '<canvas id="weekly-chart" height="200"></canvas>' : noRecord('No record — 측정된 진행 점수가 없습니다.');
      html += '</div></div>';
      html += '<div class="card mb-6"><h3 class="font-bold text-gray-900 mb-3"><i class="fas fa-th text-emerald-500 mr-2" aria-hidden="true"></i>BKT 지식 상태 히트맵</h3><div id="bkt-heatmap" class="grid grid-cols-2 sm:grid-cols-5 gap-2">'+noRecord()+'</div></div>';
      html += '<div class="card mb-6"><h3 class="font-bold text-gray-900 mb-3"><i class="fas fa-robot text-primary-500 mr-2" aria-hidden="true"></i>LinUCB 튜터링 전략 분포</h3><div id="linucb-card-body">'+noRecord('측정된 LinUCB 데이터를 확인하는 중입니다.')+'</div></div>';
      container.innerHTML = html;
      if (measuredProgression.length > 0) renderProgressionChart(measuredProgression);
      await Promise.allSettled([loadBKTHeatmap(), loadLinUCBChart()]);
    } catch (error) {
      container.innerHTML = '<div class="text-center text-gray-400 py-8">Unavailable — 대시보드 데이터를 불러올 수 없습니다.</div>';
      console.warn('[DASHBOARD] Load failed:', error);
    }
  }

  function getMeasuredProgression(progression) {
    if (!Array.isArray(progression)) return [];
    return progression.map((row) => {
      const score = finiteNumber(row?.avg_logic ?? row?.avgLogic);
      return score === null ? null : { ...row, measuredScore: score };
    }).filter(Boolean);
  }

  function renderProgressionChart(progression) {
    const canvas = getEl('weekly-chart');
    const panel = getEl('progression-card-body');
    if (!canvas || typeof window.Chart !== 'function') {
      if (panel) panel.innerHTML = noRecord('Unavailable — 차트 기능을 사용할 수 없습니다.');
      return;
    }
    const labels = progression.map((row) => {
      const date = new Date(row.created_at || row.createdAt);
      return Number.isNaN(date.getTime()) ? '날짜 없음' : date.toLocaleDateString('ko-KR');
    });
    const scores = progression.map((row) => row.measuredScore);
    new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '평균 논리 점수',
          data: scores,
          borderColor: '#D97757',
          backgroundColor: 'rgba(217,119,87,0.12)',
          fill: true,
          tension: 0.35,
        }],
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } },
    });
  }

  async function loadBKTHeatmap() {
    const container = getEl('bkt-heatmap');
    if (!container) return;
    try {
      const data = await apiGet('/api/hybrid-kt/state');
      const state = data && data.state && typeof data.state === 'object' ? data.state : {};
      const percentageConcepts = state.concepts && typeof state.concepts === 'object' && !Array.isArray(state.concepts)
        ? state.concepts
        : null;
      const legacyConcepts = data.knowledgeState && typeof data.knowledgeState === 'object' && !Array.isArray(data.knowledgeState)
        ? data.knowledgeState
        : data.bktStates && typeof data.bktStates === 'object' && !Array.isArray(data.bktStates)
          ? data.bktStates
          : {};
      const percentageContract = percentageConcepts !== null;
      const knowledgeState = percentageConcepts ?? legacyConcepts;
      const concepts = Object.entries(knowledgeState);
      if (concepts.length === 0) {
        container.innerHTML = '<div class="col-span-5">'+noRecord('No record — 측정된 BKT 지식 상태가 없습니다.')+'</div>';
        return;
      }
      const measuredConcepts = concepts.map(([concept, rawState]) => {
        const rawMastery = typeof rawState === 'number'
          ? rawState
          : rawState?.mastery ?? rawState?.pMastery ?? rawState?.pKnown;
        const mastery = finiteNumber(rawMastery);
        if (mastery === null || mastery < 0) return null;
        const percentage = Math.round(percentageContract ? mastery : mastery <= 1 ? mastery * 100 : mastery);
        if (percentage < 0 || percentage > 100) return null;
        const color = percentage >= 80 ? 'bg-emerald-500' : percentage >= 60 ? 'bg-emerald-400' : percentage >= 40 ? 'bg-yellow-400' : percentage >= 20 ? 'bg-orange-400' : 'bg-red-400';
        return `<div class="${color} rounded-lg p-2 text-center text-white text-xs font-bold" title="${escapeAttribute(`${concept}: ${percentage}%`)}">${esc(concept.slice(0, 12))}<br>${percentage}%</div>`;
      }).filter(Boolean);
      container.innerHTML = measuredConcepts.length > 0
        ? measuredConcepts.join('')
        : '<div class="col-span-5">'+noRecord('No record — 측정된 BKT 지식 상태가 없습니다.')+'</div>';
    } catch (error) {
      container.innerHTML = '<div class="col-span-5">'+noRecord('Unavailable — BKT 데이터를 불러오지 못했습니다.')+'</div>';
    }
  }

  async function loadLinUCBChart() {
    const panel = getEl('linucb-card-body');
    if (!panel) return;
    if (typeof window.Chart !== 'function') {
      panel.innerHTML = noRecord('Unavailable — 차트 기능을 사용할 수 없습니다.');
      return;
    }
    try {
      const data = await apiGet('/api/hybrid-kt/state');
      const state = data && data.state && typeof data.state === 'object' ? data.state : {};
      const arms = data.linucbArms || state.actionStats || {};
      const measuredArms = Object.entries(arms).map(([label, rawArm]) => {
        const pulls = finiteCount(rawArm?.pulls ?? rawArm?.pullCount);
        const avgReward = finiteNumber(rawArm?.avgReward);
        return pulls !== null && pulls > 0 && avgReward !== null ? { label, pulls, avgReward } : null;
      }).filter(Boolean);
      if (measuredArms.length === 0) {
        panel.innerHTML = noRecord('No record — 측정된 LinUCB 전략 선택이 없습니다.');
        return;
      }
      const labels = measuredArms.map((arm) => arm.label);
      panel.innerHTML = '<canvas id="linucb-chart" height="200"></canvas>';
      const chartCanvas = getEl('linucb-chart');
      new window.Chart(chartCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: '선택 횟수', data: measuredArms.map((arm) => arm.pulls), backgroundColor: 'rgba(217,119,87,0.65)' },
            { label: '평균 보상', data: measuredArms.map((arm) => arm.avgReward), backgroundColor: 'rgba(91,140,90,0.65)' },
          ],
        },
        options: { responsive: true, plugins: { legend: { position: 'top' } }, scales: { y: { beginAtZero: true } } },
      });
    } catch (error) {
      panel.innerHTML = noRecord('Unavailable — LinUCB 데이터를 불러오지 못했습니다.');
      console.warn('[DASHBOARD] LinUCB unavailable:', error);
    }
  }

  async function updateTokenBar() {
    try {
      const data = await apiGet('/api/dashboard/today-usage');
      const bar = getEl('header-token-bar');
      if (!bar) return;
      const tokens = finiteNumber(data?.tokens);
      const limit = data?.limit === null || data?.limit === undefined || data?.limit === Infinity ? '∞' : finiteNumber(data?.limit);
      if (tokens === null || (limit !== '∞' && limit === null)) return;
      bar.classList.remove('hidden');
      bar.classList.add('flex');
      bar.innerHTML = `<span class="text-xs text-gray-500 mr-1">Token</span><span class="text-xs font-bold text-primary-600">${tokens.toLocaleString()}/${limit === '∞' ? '∞' : limit.toLocaleString()}</span>`;
    } catch (error) {
      console.warn('[DASHBOARD] Token usage unavailable:', error);
    }
  }

  async function loadBadges() {
    if (!State.accessToken || !State.user) return;
    try {
      await apiGet(`/api/badges/user/${encodeURIComponent(State.user.id || State.user.userId)}`);
    } catch (error) {
      console.warn('[BADGE] Load failed:', error);
    }
  }

  async function requestBadgeIssue() {
    try {
      await api('/api/badges/issue', { sessionId: State.sessionId });
      showToast('배지가 발급되었습니다.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function requestBadgeFromReport() {
    if (!State.sessionId) return showToast('세션이 없습니다.', 'error');
    requestBadgeIssue();
  }

  Object.assign(window, {
    loadPersonalDashboard,
    updateTokenBar,
    loadBadges,
    requestBadgeIssue,
    requestBadgeFromReport,
  });
  Object.assign(S, { loadPersonalDashboard, updateTokenBar, loadBadges });
})(window.SocraticAI);
