// SocraticAI v34 — Case Study (In-Basket) Frontend Module
(function(S) {
  const { State, getEl, setDisplay, api, apiGet, showToast, esc } = S;
  let csSessionId = null;
  let csCaseStudyId = null;
  let csPersonas = [];
  let csActivePersonaIdx = 0;

  function loadCaseStudyTab() {
    const container = getEl('scenario-content'); if (!container) return;
    container.innerHTML = `
      <div class="mb-6">
        <div class="flex gap-2 mb-4">
          <button onclick="showScenarioMode('standard')" id="mode-standard" class="px-4 py-2 rounded-lg text-sm font-medium bg-primary-100 text-primary-700 transition">시나리오 모드</button>
          <button onclick="showScenarioMode('casestudy')" id="mode-casestudy" class="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-primary-50 transition">
            <i class="fas fa-briefcase mr-1"></i>케이스 스터디
          </button>
        </div>
      </div>
      <div id="standard-scenario-content"></div>
      <div id="casestudy-content" style="display:none;"></div>
    `;
    renderCaseStudyHome();
  }

  window.showScenarioMode = function(mode) {
    const standardBtn = getEl('mode-standard');
    const csBtn = getEl('mode-casestudy');
    const standardContent = getEl('standard-scenario-content');
    const csContent = getEl('casestudy-content');
    if (!standardBtn || !csBtn || !standardContent || !csContent) return;

    if (mode === 'casestudy') {
      csBtn.className = 'px-4 py-2 rounded-lg text-sm font-medium bg-primary-100 text-primary-700 transition';
      standardBtn.className = 'px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-primary-50 transition';
      standardContent.style.display = 'none';
      csContent.style.display = 'block';
      renderCaseStudyHome();
    } else {
      standardBtn.className = 'px-4 py-2 rounded-lg text-sm font-medium bg-primary-100 text-primary-700 transition';
      csBtn.className = 'px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-primary-50 transition';
      standardContent.style.display = 'block';
      csContent.style.display = 'none';
      if (window.loadScenarioTab) window.loadScenarioTab();
    }
  };

  function renderCaseStudyHome() {
    const container = getEl('casestudy-content'); if (!container) return;
    const industries = [
      { id: '식품', icon: 'fa-utensils', color: 'orange', title: '식품 산업', desc: '매출 하락, 고객 이탈, 브랜드 위기 대응' },
      { id: 'IT', icon: 'fa-laptop-code', color: 'blue', title: 'IT/테크', desc: 'SaaS 성장 정체, 기술 투자, 인재 확보' },
      { id: '금융', icon: 'fa-landmark', color: 'emerald', title: '금융 서비스', desc: '리스크 관리, 규제 대응, 디지털 전환' },
      { id: '제조', icon: 'fa-industry', color: 'gray', title: '제조업', desc: '공급망 위기, 자동화, ESG 대응' },
      { id: '유통', icon: 'fa-store', color: 'purple', title: '유통/리테일', desc: '옴니채널 전략, 재고 관리, 고객 경험' },
      { id: '헬스케어', icon: 'fa-heartbeat', color: 'rose', title: '헬스케어', desc: '의료 혁신, 규제, 디지털 헬스' },
    ];

    container.innerHTML = `
      <div class="mb-6">
        <h3 class="font-bold text-lg text-gray-900 mb-2">
          <i class="fas fa-briefcase text-primary-500 mr-2"></i>In-Basket 케이스 스터디
        </h3>
        <p class="text-sm text-gray-600">실제 비즈니스 상황에서 데이터 기반 의사결정을 연습합니다. AI 페르소나가 당신의 논리를 검증합니다.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6" id="cs-industries">
        ${industries.map(i => `
          <button onclick="startCaseStudy('${i.id}')" class="p-4 bg-gradient-to-br from-${i.color}-50 to-${i.color}-100 rounded-xl border border-${i.color}-200 hover:shadow-md transition cursor-pointer text-left">
            <div class="w-8 h-8 bg-${i.color}-500 rounded-lg flex items-center justify-center mb-2">
              <i class="fas ${i.icon} text-white text-sm"></i>
            </div>
            <h4 class="font-bold text-gray-900 text-sm mb-1">${i.title}</h4>
            <p class="text-xs text-gray-600">${i.desc}</p>
          </button>
        `).join('')}
      </div>
      <div id="cs-active" style="display:none;"></div>
    `;
  }

  window.startCaseStudy = async function(industry) {
    try {
      showToast('케이스 스터디 생성 중...', 'info');
      const data = await api('/api/case-study/generate', {
        industry,
      });

      if (!data.success || !data.caseStudy) {
        showToast('케이스 스터디 생성 실패', 'error');
        return;
      }

      const cs = data.caseStudy;
      csCaseStudyId = cs.id;
      csSessionId = cs.sessionId;
      csPersonas = cs.personas || [];
      csActivePersonaIdx = 0;

      const industriesDiv = getEl('cs-industries');
      if (industriesDiv) industriesDiv.style.display = 'none';

      const active = getEl('cs-active');
      if (!active) return;
      active.style.display = 'block';

      // Build data points display
      const dpHtml = cs.dataPoints.map(dp =>
        `<div class="flex justify-between text-xs"><span class="text-gray-600">${esc(dp.key)}</span><span class="font-mono font-bold ${dp.importance >= 4 ? 'text-red-600' : 'text-gray-900'}">${esc(dp.value)}</span></div>`
      ).join('');

      // Build persona badges
      const personaHtml = csPersonas.map((p, i) =>
        `<button onclick="switchCsPersona(${i})" class="text-xs px-2 py-1 rounded-full ${i === 0 ? 'bg-primary-100 text-primary-700' : 'bg-gray-100 text-gray-600'}" id="persona-badge-${i}">
          ${esc(p.name)}
        </button>`
      ).join(' ');

      active.innerHTML = `
        <div class="card mb-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-bold text-gray-900 text-sm">${esc(cs.title)}</h3>
            <span class="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">
              <i class="fas fa-briefcase mr-1"></i>${esc(cs.industry)} | 난이도 ${cs.difficulty.toFixed(1)}
            </span>
          </div>
          <p class="text-sm text-gray-700 leading-relaxed mb-3">${esc(cs.scenario)}</p>
          <div class="text-xs text-gray-500 mb-2">당신의 역할: <strong>${esc(cs.role)}</strong></div>
          
          <details class="mb-3">
            <summary class="text-xs font-medium text-blue-600 cursor-pointer">📊 제공 데이터 보기</summary>
            <div class="mt-2 p-3 bg-gray-50 rounded-lg space-y-1">${dpHtml}</div>
          </details>

          <div class="flex gap-1 items-center">
            <span class="text-xs text-gray-500 mr-1">페르소나:</span>
            ${personaHtml}
          </div>
        </div>

        <div class="card">
          <div id="cs-messages" class="space-y-3 mb-4 max-h-[400px] overflow-y-auto scrollbar-thin"></div>
          <div class="flex gap-3">
            <textarea id="cs-input" class="flex-1 p-3 border border-gray-200 rounded-xl text-sm" placeholder="재무 데이터를 인용하며 의사결정과 근거를 입력하세요..." rows="3"
              onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitCsTurn()}"></textarea>
            <button onclick="submitCsTurn()" class="btn-primary text-sm" id="cs-submit-btn">
              <i class="fas fa-paper-plane"></i>
            </button>
          </div>
          <div id="cs-data-feedback" class="mt-2 text-xs text-gray-500"></div>
        </div>

        <div class="mt-3 text-center">
          <button onclick="endCaseStudy()" class="btn-secondary text-sm">
            <i class="fas fa-stop mr-1"></i>케이스 스터디 종료
          </button>
        </div>
      `;

      showToast('케이스 스터디가 시작되었습니다!', 'success');
    } catch(e) {
      showToast(e.message || '케이스 스터디 생성 실패', 'error');
    }
  };

  window.switchCsPersona = function(idx) {
    csActivePersonaIdx = idx;
    csPersonas.forEach((_, i) => {
      const badge = getEl('persona-badge-' + i);
      if (badge) {
        badge.className = i === idx
          ? 'text-xs px-2 py-1 rounded-full bg-primary-100 text-primary-700'
          : 'text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-600';
      }
    });
    showToast('페르소나: ' + csPersonas[idx].name, 'info');
  };

  window.submitCsTurn = async function() {
    const input = getEl('cs-input');
    const message = input ? input.value.trim() : '';
    if (!message || !csCaseStudyId) return;

    const btn = getEl('cs-submit-btn'); if (btn) btn.disabled = true;
    const msgDiv = getEl('cs-messages');

    // Show user message
    if (msgDiv) {
      msgDiv.innerHTML += `<div class="flex gap-2 flex-row-reverse fade-in">
        <div class="bg-primary-50 rounded-xl px-4 py-2 text-sm max-w-[80%]">${esc(message)}</div>
      </div>`;
    }
    if (input) input.value = '';

    try {
      const persona = csPersonas[csActivePersonaIdx];
      const data = await api('/api/case-study/turn', {
        sessionId: csSessionId,
        caseStudyId: csCaseStudyId,
        message,
        personaId: persona?.id,
      });

      if (msgDiv && data.response) {
        const pName = data.persona?.name || '페르소나';
        msgDiv.innerHTML += `<div class="flex gap-2 fade-in">
          <div class="w-7 h-7 rounded-full bg-orange-50 flex items-center justify-center flex-shrink-0">
            <i class="fas fa-user-tie text-orange-500 text-xs"></i>
          </div>
          <div>
            <div class="text-xs text-gray-500 mb-0.5">${esc(pName)}</div>
            <div class="bg-white border border-gray-100 rounded-xl px-4 py-2 text-sm max-w-[80%]">${esc(data.response)}</div>
          </div>
        </div>`;
        msgDiv.scrollTop = msgDiv.scrollHeight;
      }

      // Data reference feedback
      const feedbackDiv = getEl('cs-data-feedback');
      if (feedbackDiv && data.dataReferences) {
        const dr = data.dataReferences;
        let feedbackHtml = `<span class="font-medium">데이터 인용률: ${(dr.referenceRate * 100).toFixed(0)}%</span>`;
        if (dr.importantMissed && dr.importantMissed.length > 0) {
          feedbackHtml += ` | <span class="text-red-500">미인용 핵심 데이터: ${dr.importantMissed.join(', ')}</span>`;
        }
        feedbackDiv.innerHTML = feedbackHtml;
      }

    } catch(e) {
      showToast(e.message || '응답 실패', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  window.endCaseStudy = function() {
    csSessionId = null;
    csCaseStudyId = null;
    csPersonas = [];
    renderCaseStudyHome();
  };

  // Override scenario tab to include case study mode
  const originalLoadScenarioTab = window.loadScenarioTab;
  window.loadScenarioTab = function() {
    loadCaseStudyTab();
    // Load standard scenario into its container
    setTimeout(() => {
      if (originalLoadScenarioTab && getEl('standard-scenario-content')) {
        // redirect scenario content
      }
    }, 100);
  };

  S.loadCaseStudyTab = loadCaseStudyTab;
  S.startCaseStudy = window.startCaseStudy;
})(window.SocraticAI);
