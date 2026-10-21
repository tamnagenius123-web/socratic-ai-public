// SocraticAI v28 — Training Module
(function(S) {
  const {
    State, getEl, setDisplay, api, apiGet, showToast, esc,
    isAuthExpiryScreenVisible, focusLoginAfterAuthExpiry,
  } = S;
  // Supplied by ./korean-journey-copy.js through the main.js lifecycle bridge.
  const KOREAN_JOURNEY_COPY = S.KOREAN_JOURNEY_COPY;
  let trainingCategory = null, trainingDifficulty = null, trainingSessionId = null;
  let trainingFollowUp = null;
  let trainingMode = 'evidence';
  let activeTrainingMode = null;
  let trainingGroundingReady = false;
  let trainingResumeVersion = 0;
  let trainingCategoryLoadVersion = 0;
  let trainingControlReadVersion = 0;
  let trainingEvidenceBookIds = new Set();
  let trainingCaseEntries = [];
  let trainingSelectedCase = null;
  let trainingCaseSelectionTransition = false;
  let trainingStartPending = false;
  let trainingRouteProjection = null, trainingRouteBusy = false, trainingTurnBusy = false, trainingCompleted = false;
  let trainingRevisionBusy = false;
  let trainingControl = null, trainingControlBusy = false, trainingSupportBusy = false, trainingCanSupport = false;
  function isActiveHeldOutAttempt(projection) {
    return projection?.status === 'AVAILABLE' && ['ARMED', 'IN_PROGRESS'].includes(projection.attempt?.state);
  }
  function clearHeldOutAssistanceUI() {
    trainingControl = null; trainingControlBusy = false; trainingSupportBusy = false; trainingCanSupport = false;
    const controls = getEl('training-control-panel'); if (controls) { controls.replaceChildren(); controls.hidden = true; }
    trainingRevisionBusy = false;
    const revisionPanel = getEl('training-revision-panel'); if (revisionPanel) { revisionPanel.replaceChildren(); revisionPanel.hidden = true; }
  }
  async function refreshTrainingControl(sessionId = trainingSessionId) {
    if (!sessionId) return;
    const requestVersion = trainingResumeVersion;
    const readVersion = ++trainingControlReadVersion;
    const control = await apiGet('/api/training/session/' + encodeURIComponent(sessionId) + '/interventions');
    if (sessionId === trainingSessionId && requestVersion === trainingResumeVersion && readVersion === trainingControlReadVersion) { trainingControl = control; renderTrainingControl(); }
  }
  function renderTrainingControl() {
    const panel = getEl('training-control-panel'); if (!panel) return;
    panel.replaceChildren(); panel.hidden = !trainingSessionId;
    if (panel.hidden) return;
    const el = (tag,text) => { const n=document.createElement(tag); if(text)n.textContent=text; return n; };
    const state=trainingControl?.state || 'UNKNOWN';
    const status=el('p', ({ACTIVE:'대화 중 · 필요하면 설명을 요청하거나 쉴 수 있습니다.',PAUSED:'잠시 멈췄습니다. 도움을 받거나, 원할 때 다시 시작하세요.',STOPPED:'대화를 종료했습니다. 중단은 실패나 학습 완료로 평가되지 않습니다.',SUPPORT_PENDING:'도움 요청이 저장되었습니다. 설명을 받는 동안 평가는 진행되지 않습니다.',COMPLETED:'완료된 대화입니다.',UNKNOWN:'대화 제어 상태를 확인하고 있습니다.'})[state]); status.setAttribute('role','status');
    panel.append(el('h3','도움과 휴식'),status);
    if(state==='UNKNOWN') {
      const retry=el('button','제어 상태 다시 확인');retry.type='button';retry.className='btn-secondary';
      retry.addEventListener('click',async()=>{retry.disabled=true;try{await refreshTrainingControl();}catch{showToast('제어 상태를 불러오지 못했습니다. 다시 시도해 주세요.','error');}finally{retry.disabled=false;}});
      panel.appendChild(retry);
    }

    if(trainingControl?.latest?.reason==='NON_PROGRESS') panel.appendChild(el('p','최근 두 답변에서 근거와 추론의 어려움이 반복되어 질문을 잠시 멈췄습니다. 학습 능력을 단정한 결과가 아닙니다.'));
    const label=el('label','멈추거나 도움을 요청하는 이유');label.htmlFor='training-control-reason';const reason=el('select');reason.id='training-control-reason';
    for(const [value,text] of [['LEARNER_REQUEST','내가 원해서'],['DISTRESS','부담스럽거나 힘들어서'],['UNSAFE_ERROR','안전하지 않거나 잘못된 내용이 있어서'],['TIME_LIMIT','시간이 부족해서'],['INSUFFICIENT_EVIDENCE','근거가 부족해서']]) {const option=el('option',text);option.value=value;reason.appendChild(option);}
    panel.append(label,reason);
    const actions=el('div');actions.className='training-control-actions';
    for(const [action,text] of [['HELP','한 단계 설명 받기'],['PAUSE','잠시 쉬기'],['RESUME','대화 다시 시작'],['STOP','대화 종료']]) {
      const button=el('button',text);button.type='button';button.className='btn-secondary';button.dataset.controlAction=action;
      button.disabled=trainingControlBusy || ['STOPPED','COMPLETED','UNKNOWN'].includes(state) || (action==='RESUME' && state!=='PAUSED') || (action==='PAUSE' && state==='PAUSED') || (action==='HELP' && (state==='SUPPORT_PENDING' || !trainingGroundingReady || !trainingCanSupport || activeTrainingMode!=='evidence' || trainingTurnBusy || trainingSupportBusy));
      button.addEventListener('click',()=>changeTrainingControl(action,reason.value));actions.appendChild(button);
    }
    panel.appendChild(actions);
    if(state==='STOPPED') { const restart=el('button','새 대화 시작'); restart.type='button';restart.className='btn-primary';restart.addEventListener('click',resetTrainingUI);panel.appendChild(restart); }
    if(!trainingCanSupport) panel.appendChild(el('small','첫 답변을 검토한 뒤, 그 답변의 근거와 이유를 한 단계씩 설명받을 수 있습니다.'));
    if(state==='SUPPORT_PENDING' && trainingGroundingReady && !trainingSupportBusy) { const retry=el('button','저장된 도움 요청 다시 시도');retry.type='button';retry.className='btn-secondary';retry.addEventListener('click',()=>receiveTrainingSupport(trainingSessionId));panel.appendChild(retry); }
    if(trainingControl?.history?.length) {
      const history=el('details');history.appendChild(el('summary','도움·휴식 선택 기록'));const list=el('ol');
      const actionNames={HELP:'설명 요청',PAUSE:'잠시 멈춤',RESUME:'다시 시작',STOP:'대화 종료'};
      const reasonNames={LEARNER_REQUEST:'내 선택',NON_PROGRESS:'반복된 어려움으로 질문을 잠시 멈춤',DISTRESS:'부담이나 어려움',UNSAFE_ERROR:'안전하지 않거나 잘못된 내용',TIME_LIMIT:'시간 부족',INSUFFICIENT_EVIDENCE:'근거 부족'};
      for(const event of trainingControl.history) list.appendChild(el('li',event.revision+' · '+actionNames[event.action]+' · '+reasonNames[event.reason]));
      history.appendChild(list);panel.appendChild(history);
    }
    const supported=(trainingControl?.history || []).filter(event=>event.response);
    if(supported.length) { const history=el('details');history.open=Boolean(trainingControl?.latest?.response);history.appendChild(el('summary','설명 기록 (평가하지 않음)'));for(const event of supported) history.appendChild(el('p',event.response));panel.appendChild(history); }
    syncTrainingRouteControls();
  }
  async function changeTrainingControl(action,reason) {
    if(trainingControlBusy || !trainingSessionId) return;
    const sessionId=trainingSessionId;const requestVersion=trainingResumeVersion;trainingControlReadVersion++;trainingControlBusy=true;renderTrainingControl();
    try {
      const control=await api('/api/training/session/'+encodeURIComponent(sessionId)+'/interventions',{action,reason,expectedRevision:trainingControl?.revision || 0,mutationKey:crypto.randomUUID()});
      if(sessionId!==trainingSessionId || requestVersion!==trainingResumeVersion)return;
      trainingControlReadVersion++;trainingControl=control;trainingControlBusy=false;renderTrainingControl();
      if(action==='HELP') await receiveTrainingSupport(sessionId);
    } catch(error) {if(sessionId===trainingSessionId && requestVersion===trainingResumeVersion){try{await refreshTrainingControl(sessionId);}catch{} showToast('요청 상태를 확인해 주세요. 저장된 답변과 평가는 유지됩니다.','error');}}
    finally {if(sessionId===trainingSessionId && requestVersion===trainingResumeVersion){trainingControlBusy=false;renderTrainingControl();}}
  }
  async function receiveTrainingSupport(sessionId) {
    if(trainingSupportBusy || !trainingGroundingReady)return;trainingSupportBusy=true;renderTrainingControl();
    try {
      await api('/api/training/session/'+encodeURIComponent(sessionId)+'/support',{});
      if(sessionId!==trainingSessionId)return;
      await refreshTrainingControl(sessionId);
      showToast('아래 설명을 확인하세요. 평가는 진행하지 않았습니다.','success');
    } catch(error) {if(sessionId===trainingSessionId){try{await refreshTrainingControl(sessionId);}catch{} showToast('설명을 완료하지 못했습니다. 잠시 쉬거나 저장된 요청을 다시 시도할 수 있습니다.','error');}}
    finally {if(sessionId===trainingSessionId){trainingSupportBusy=false;renderTrainingControl();}}
  }

  async function refreshLearnerRevisions(sessionId = trainingSessionId) {
    if (!sessionId || activeTrainingMode !== 'evidence') return;
    const requestVersion = trainingResumeVersion;
    const [detail, revisions] = await Promise.all([
      apiGet('/api/training/session/' + encodeURIComponent(sessionId)),
      apiGet('/api/training/session/' + encodeURIComponent(sessionId) + '/revisions'),
    ]);
    if (sessionId === trainingSessionId && requestVersion === trainingResumeVersion) renderLearnerRevisions(detail, revisions);
  }
  function renderLearnerRevisions(detail, projection) {
    const panel = getEl('training-revision-panel'); if (!panel) return;
    panel.replaceChildren(); panel.hidden = activeTrainingMode !== 'evidence';
    if (panel.hidden) return;
    const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
    const heading = el('h3', '내 생각의 수정 기록');
    const status = el('p'); status.setAttribute('role', 'status');
    status.textContent = projection.pending ? '수정 기록 ' + projection.pending.revision + ' 검토 대기 · 다음 답변에서 근거와 이유를 함께 살펴봅니다.' : '검토 대기 중인 수정이 없습니다.';
    panel.append(heading, el('p', '원래 답변과 AI의 해석을 구분해 확인하세요. 수정한 생각의 타당성과 학습 효과는 아직 확인되지 않았습니다 (UNKNOWN).'), status);
    const count = getEl('tr-revision'); if (count) count.textContent = (projection.history?.length || 0) + '건 · 미검증';
    if (projection.history?.length) {
      const history = el('details'); history.appendChild(el('summary', '이전 생각과 수정 이유 보기'));
      const list = el('ol');
      for (const event of projection.history) {
        const row = el('li');
        row.append(el('strong', '수정 ' + event.revision + ' · ' + event.priorTurnNumber + '번째 답변'),
          el('p', '원래 답변: ' + event.priorStatement), el('p', '수정한 생각: ' + event.revisedStatement),
          el('p', '이유: ' + event.explanation), el('p', '선택 출처: ' + (event.sourceIds.join(' · ') || '없음 (UNKNOWN)')),
          el('p', event.consumedByTurn ? event.consumedByTurn + '번째 대화에서 검토 · 타당성 미검증' : event.id === projection.pending?.id ? '다음 대화에서 검토 대기' : '후속 수정으로 대체됨 · 타당성 미검증'));
        list.appendChild(row);
      }
      history.appendChild(list); panel.appendChild(history);
    }
    const turns = detail.turns || [];
    trainingCanSupport = turns.length > 0; renderTrainingControl();
    if (detail.session?.is_completed || !turns.length) {
      panel.appendChild(el('p', turns.length ? '완료된 대화의 기록입니다.' : '첫 답변이 저장되면 생각을 수정하고 이유를 남길 수 있습니다.')); return;
    }
    const form = el('form'); form.className = 'training-revision-form';
    const field = (id, text, node) => { node.id = id; const label = el('label', text); label.htmlFor = id; form.append(label, node); return node; };
    const select = field('training-revision-prior', '돌아볼 내 답변', el('select'));
    for (const turn of turns) { const option = el('option', turn.turn_number + '번째 답변'); option.value = turn.id; select.appendChild(option); }
    select.value = String(turns.at(-1).id);
    const observation = el('blockquote'), hypothesis = el('p');
    const showPrior = () => { const turn = turns.find(t => String(t.id) === select.value); observation.textContent = turn?.student_message || ''; let model; try { model = JSON.parse(turn?.student_model_snapshot || '{}'); } catch {} hypothesis.textContent = 'AI가 해석한 주장 (가설 · 신뢰도 UNKNOWN): ' + (model?.currentClaim || '확인되지 않음'); };
    select.addEventListener('change', showPrior); showPrior(); form.append(observation, hypothesis);
    const statement = field('training-revision-statement', '지금은 어떻게 생각하나요?', el('textarea')); statement.rows = 3; statement.maxLength = 4000; statement.required = true;
    const explanation = field('training-revision-explanation', '어떤 근거나 조건 때문에 생각이 바뀌었나요?', el('textarea')); explanation.rows = 3; explanation.maxLength = 4000; explanation.required = true;
    const sources = el('fieldset'); sources.appendChild(el('legend', '생각을 바꾸게 한 출처 (선택 사항)'));
    for (const source of detail.grounding?.sources || []) {
      if (!source.sourceId) continue;
      const label = el('label'); const box = el('input'); box.type = 'checkbox'; box.value = source.sourceId; box.name = 'revision-source';
      label.append(box, document.createTextNode((source.bookTitle || source.title || source.sourceId) + ' · ' + source.sourceId)); sources.appendChild(label);
    }
    form.appendChild(sources);
    const save = el('button', '수정 기록 저장'); save.type = 'submit'; save.className = 'btn-primary'; form.appendChild(save);
    let mutationKey = crypto.randomUUID();
    form.addEventListener('input', () => { mutationKey = crypto.randomUUID(); });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (trainingRevisionBusy || trainingTurnBusy || trainingRouteBusy || trainingCompleted) return;
      const sessionId = trainingSessionId;
      let saved = false;
      trainingRevisionBusy = true; syncTrainingRouteControls();
      try {
        await api('/api/training/session/' + encodeURIComponent(sessionId) + '/revisions', {
          priorTurnId: Number(select.value), revisedStatement: statement.value, explanation: explanation.value,
          sourceIds: [...sources.querySelectorAll('input:checked')].map(box => box.value), expectedRevision: projection.revision, mutationKey,
        });
        await refreshLearnerRevisions(sessionId);
        saved = true;

      } catch (error) {
        if (sessionId === trainingSessionId) { status.textContent = error?.code === 'TRAINING_REVISION_CONFLICT' ? '다른 수정이 먼저 저장되었습니다. 입력한 내용을 보관한 뒤 대화를 다시 열어 최신 기록을 확인해 주세요.' : '저장 상태를 확인하지 못했습니다. 입력은 유지됩니다. 같은 내용으로 다시 시도해 주세요.'; }
      } finally { if (sessionId === trainingSessionId) { trainingRevisionBusy = false; syncTrainingRouteControls(); if (saved) getEl('training-input')?.focus(); } }
    });
    const editor = el('details'); editor.appendChild(el('summary', '답변 돌아보고 수정하기')); editor.appendChild(form); panel.appendChild(editor); syncTrainingRouteControls();
  }


  function renderTrainingRoute(projection, completed = false) {
    trainingRouteProjection = projection || null;
    trainingCompleted = completed;
    const panel = getEl('training-route-panel');
    if (!panel) return;
    panel.innerHTML = '';
    panel.hidden = !projection?.offer;
    syncTrainingRouteControls();
    if (!projection?.offer) return;
    const copy = KOREAN_JOURNEY_COPY.learningRoute;
    const heading = document.createElement('h3'); heading.textContent = copy.title;
    const explanation = document.createElement('p'); explanation.textContent = copy.explanation;
    const fieldset = document.createElement('fieldset'); fieldset.className = 'training-route-options';
    const legend = document.createElement('legend'); legend.textContent = '같은 목표, 세 가지 순서'; fieldset.appendChild(legend);
    for (const option of projection.offer.options) {
      const label = document.createElement('label'); label.className = 'training-route-option';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'training-learning-route'; radio.value = option.route;
      radio.checked = projection.decision?.selectedRoute === option.route;
      radio.disabled = completed || trainingRouteBusy || trainingTurnBusy || trainingRevisionBusy;
      const title = document.createElement('strong'); title.id = 'training-route-label-' + option.route; title.textContent = copy[option.route].title; radio.setAttribute('aria-labelledby', title.id);
      const order = document.createElement('span'); order.textContent = copy[option.route].order;
      const reason = document.createElement('p'); reason.id = 'training-route-reason-' + option.route; radio.setAttribute('aria-describedby', reason.id); reason.textContent = option.supportStatus === 'TASK_SUPPORTED' ? copy[option.route].reason : copy.unknown;
      const evidence = document.createElement('small'); evidence.textContent = '판단 근거: ' + option.evidenceRefs.map(ref => ref.startsWith('source:') ? '선택한 출처' : ({ 'scenario:decisionQuestion': '학습 질문', 'scenario:stakeholders': '이해관계자', 'scenario:constraints': '문제의 제약', 'scenario:rubric': '평가 기준', 'scenario:tradeoffs': '상충 관계' }[ref] || ref)).filter((value, index, values) => values.indexOf(value) === index).join(' · ');
      if (!option.evidenceRefs.length) evidence.textContent = '판단 근거: 확인되지 않음 (UNKNOWN)';
      const alternatives = document.createElement('small'); alternatives.textContent = '함께 검토할 대안: ' + option.alternatives.map(other => copy[other.route].title + (other.evidenceRefs.length ? '' : ' (근거 부족)')).join(' · ');
      label.append(radio, title, order, reason, evidence, alternatives); fieldset.appendChild(label);
    }
    const target = document.createElement('p'); target.textContent = '공통 목표: ' + projection.offer.target.goal;
    const rubric = document.createElement('ul');
    for (const item of projection.offer.target.rubric) { const li = document.createElement('li'); li.textContent = item.label + ': ' + item.description; rubric.appendChild(li); }
    const status = document.createElement('p'); status.id = 'training-route-status'; status.setAttribute('role', 'status');
    status.textContent = projection.decision ? '선택 기록 ' + projection.decision.revision + ' · ' + projection.decision.effectiveFromTurn + '번째 답변부터 적용. ' + copy.efficacy : copy.required + ' ' + copy.efficacy;
    const save = document.createElement('button'); save.type = 'button'; save.id = 'training-route-save'; save.className = 'btn-primary'; save.textContent = projection.decision ? copy.revise : copy.save;
    save.disabled = completed || trainingRouteBusy || trainingTurnBusy || trainingRevisionBusy;
    save.addEventListener('click', async () => {
      const chosen = panel.querySelector('input[name="training-learning-route"]:checked');
      if (!chosen || trainingRouteBusy || trainingTurnBusy || trainingRevisionBusy) return;
      const routeSessionId = trainingSessionId;
      trainingRouteBusy = true; syncTrainingRouteControls(); save.disabled = true;
      try {
        const result = await api('/api/training/session/' + encodeURIComponent(routeSessionId) + '/route', { selectedRoute: chosen.value, expectedRevision: trainingRouteProjection.decision?.revision || 0, mutationKey: crypto.randomUUID() });
        if (routeSessionId !== trainingSessionId) return;
        const current = await apiGet('/api/training/session/' + encodeURIComponent(routeSessionId) + '/route');
        if (routeSessionId !== trainingSessionId) return;
        trainingRouteBusy = false; renderTrainingRoute(current, completed); getEl('training-input')?.focus();
      } catch (error) {
        if (routeSessionId !== trainingSessionId) return;
        trainingRouteBusy = false;
        try { renderTrainingRoute(await apiGet('/api/training/session/' + encodeURIComponent(trainingSessionId) + '/route'), completed); } catch { syncTrainingRouteControls(); }
        showToast('학습 순서를 저장하지 못했습니다. 현재 선택을 확인하고 다시 시도해 주세요.', 'error');
      }
    });
    panel.append(heading, explanation, fieldset, target, rubric, status, save);
    if (projection.history?.length) {
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '학습 순서 선택 기록'; details.appendChild(summary);
      const list = document.createElement('ol');
      for (const decision of projection.history) { const li = document.createElement('li'); li.textContent = decision.revision + ': ' + copy[decision.selectedRoute].title + ' · ' + decision.effectiveFromTurn + '번째 답변부터'; list.appendChild(li); }
      details.appendChild(list); panel.appendChild(details);
    }
    syncTrainingRouteControls();
  }
  function syncTrainingRouteControls() {
    const stopped = trainingControl?.state === 'STOPPED';
    const controlled = trainingControl?.state !== 'ACTIVE';
    const disabled = !trainingGroundingReady || controlled || trainingControlBusy || trainingSupportBusy || stopped || trainingCompleted || trainingRouteBusy || trainingTurnBusy || trainingRevisionBusy || trainingRouteProjection?.status === 'AWAITING_CHOICE';
    getEl('training-revision-panel')?.querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = stopped || trainingCompleted || trainingRouteBusy || trainingTurnBusy || trainingRevisionBusy; });
    const submit = getEl('training-submit-btn'); if (submit) submit.disabled = disabled;
    const hint = getEl('training-hint-btn'); if (hint) { hint.disabled = disabled || activeTrainingMode !== 'constructed'; hint.setAttribute('aria-disabled',String(hint.disabled)); }
    const input = getEl('training-input'); if (input) input.disabled = disabled;
    const save = getEl('training-route-save'); if (save) save.disabled = stopped || trainingCompleted || trainingRouteBusy || trainingTurnBusy || trainingRevisionBusy;
    getEl('training-route-panel')?.querySelectorAll('input[name="training-learning-route"]').forEach(input => { input.disabled = stopped || trainingCompleted || trainingRouteBusy || trainingTurnBusy || trainingRevisionBusy; });
  }

  function handleTrainingAuthExpiry() {
    if (!isAuthExpiryScreenVisible()) return false;
    focusLoginAfterAuthExpiry();
    return true;
  }

  function learnerSafeTrainingFailure(error, context = 'turn') {
    const apiError = error && typeof error === 'object' ? error : null;
    const code = typeof apiError?.code === 'string' ? apiError.code : 'UNKNOWN_ERROR';
    const phase = typeof apiError?.phase === 'string' ? apiError.phase : 'unknown';
    const retryable = apiError?.retryable === true;
    const rawDetail = typeof apiError?.payload?.error === 'string'
      ? apiError.payload.error
      : error instanceof Error && error.message
        ? error.message
        : 'training_response_unavailable';
    const learnerMessages = {
      training_tutor_provider_not_configured: context === 'start'
        ? 'AI 튜터 연결이 준비되지 않아 훈련을 시작하지 못했습니다. 입력과 세션은 저장되지 않았습니다.'
        : 'AI 튜터 연결이 준비되지 않아 답변을 처리하지 못했습니다. 작성한 답변은 입력란에 남아 있으며 기존 세션은 유지됩니다.',
      training_category_invalid: '선택한 카테고리를 현재 사용할 수 없습니다. 카테고리를 다시 불러온 뒤 선택해 주세요.',
      training_category_catalog_unavailable: '카테고리 목록을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      training_category_catalog_empty: '사용할 수 있는 카테고리가 없습니다. 잠시 후 다시 확인해 주세요.',
      training_response_unavailable: '훈련 응답을 완료하지 못했습니다.',
    };
    const detail = learnerMessages[rawDetail]
      || (context === 'catalog' ? learnerMessages.training_category_catalog_unavailable : rawDetail);
    const retryGuidance = retryable
      ? '같은 입력으로 다시 시도할 수 있습니다.'
      : '자동 재시도 가능 여부가 확인되지 않았습니다.';
    return `${detail}\n오류 코드: ${code}\n단계: ${phase}\n재시도 가능: ${retryable ? '예' : '아니요'} · ${retryGuidance}`;
  }

  function resetTrainingMeasurement() {
    ['claim', 'evidence', 'reasoning', 'consistency', 'relevance'].forEach((key) => {
      const bar = getEl('tr-bar-' + key);
      const score = getEl('tr-sc-' + key);
      if (bar) bar.style.width = '0%';
      if (score) score.textContent = '—';
    });
    const weakness = getEl('tr-weakness');
    if (weakness) weakness.textContent = '아직 평가 기록이 없습니다.';
  }

  function renderTrainingGrowthAction(session, container = getEl('training-messages')) {
    if (!container || !session?.is_completed) return;
    container.querySelector('[data-training-growth-origin]')?.remove();
    if(trainingFollowUp?.cycleId){
      const link={...trainingFollowUp};const card=document.createElement('section');card.dataset.trainingGrowthOrigin=String(session.id||trainingSessionId||'');
      const text=document.createElement('p');text.textContent='후속 시도가 완료되었습니다. 성장 실험실에서 UNKNOWN 기록을 확인할 수 있습니다.';
      const action=document.createElement('button');action.type='button';action.className='btn-primary';action.textContent='예약한 재확인으로 돌아가기';
      action.addEventListener('click',async()=>{action.disabled=true;try{await S.openGrowthRecheck(link);}catch{showToast('재확인 기록을 열지 못했습니다. 다시 시도해 주세요.','error');}finally{action.disabled=false;}});
      card.append(text,action);container.appendChild(card);return;
    }
    const origin = String(session.origin || 'training');
    const card = document.createElement('section');
    card.dataset.trainingGrowthOrigin = String(session.id || trainingSessionId || '');
    card.className = 'mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4';
    const heading = document.createElement('h3');
    heading.className = 'text-sm font-bold text-gray-900';
    heading.textContent = KOREAN_JOURNEY_COPY.trainingGrowthCta.title;
    const copy = document.createElement('p');
    copy.className = 'mt-1 text-xs text-gray-600';
    if (origin === 'legacy_scenario') {
      copy.textContent = KOREAN_JOURNEY_COPY.trainingGrowthCta.legacyUnavailable;
      card.append(heading, copy);
      container.appendChild(card);
      return;
    }
    const attemptId = String(session.id || trainingSessionId || '').trim();
    if (!attemptId) return;
    copy.textContent = KOREAN_JOURNEY_COPY.trainingGrowthCta.explanation;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn-primary mt-3';
    action.textContent = KOREAN_JOURNEY_COPY.trainingGrowthCta.open;
    action.setAttribute('aria-label', KOREAN_JOURNEY_COPY.trainingGrowthCta.ariaLabel);
    action.addEventListener('click', async () => {
      action.disabled = true;
      action.textContent = KOREAN_JOURNEY_COPY.trainingGrowthCta.opening;
      const opened = await S.openGrowthCycleFromOrigin?.({ originKind: 'TRAINING', originAttemptId: attemptId });
      if (!opened && document.body.contains(action)) {
        action.disabled = false;
        action.textContent = KOREAN_JOURNEY_COPY.trainingGrowthCta.open;
      }
    });
    card.append(heading, copy, action);
    container.appendChild(card);
  }

  function renderTrainingMeasurement(evaluation) {
    const scoreKeys = {
      claim: 'claim_clarity',
      evidence: 'evidence_use',
      reasoning: 'reasoning_strength',
      consistency: 'consistency',
      relevance: 'relevance',
    };
    const scores = Object.values(scoreKeys).map((key) => Number(evaluation?.[key]));
    if (scores.some((score) => !Number.isFinite(score) || score < 1 || score > 5)) {
      resetTrainingMeasurement();
      return;
    }
    Object.entries(scoreKeys).forEach(([displayKey, scoreKey]) => {
      const value = Number(evaluation[scoreKey]);
      const bar = getEl('tr-bar-' + displayKey);
      const score = getEl('tr-sc-' + displayKey);
      if (bar) bar.style.width = (value / 5) * 100 + '%';
      if (score) score.textContent = String(value);
    });
  }

  async function loadTrainingCategories() {
    const container = getEl('training-categories');
    if (!container) return false;
    const requestVersion = ++trainingCategoryLoadVersion;
    try {
      const data = await apiGet('/api/training/categories');
      if (requestVersion !== trainingCategoryLoadVersion) return true;
      const categories = (data.categories || []).filter((category) => Number(category.level) === 0);
      if (!categories.length) throw new Error('training_category_catalog_empty');
      const availableIds = new Set(categories.map((category) => String(category.id)));
      if (trainingCategory && !availableIds.has(trainingCategory)) trainingCategory = null;
      container.replaceChildren();
      for (const category of categories) {
        const id = String(category.id);
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.cat = id;
        button.className = 'training-cat-btn card flex flex-col items-center gap-2 py-3 hover:border-primary-500 transition cursor-pointer border-2 border-transparent';
        button.setAttribute('aria-pressed', String(trainingCategory === id));
        const icon = document.createElement('span');
        icon.className = 'text-xl';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = String(category.icon || '📚');
        const label = document.createElement('span');
        label.className = 'font-bold text-xs';
        label.textContent = String(category.name_ko || category.name_en || id);
        button.append(icon, label);
        button.addEventListener('click', () => selectTrainingCategory(id));
        container.appendChild(button);
      }
      updateTrainingStartBtn();
      return true;
    } catch (error) {
      if (requestVersion !== trainingCategoryLoadVersion) return true;
      trainingCategory = null;
      container.replaceChildren();
      const message = document.createElement('p');
      message.className = 'text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3 col-span-3';
      message.textContent = '카테고리를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
      container.appendChild(message);
      updateTrainingStartBtn();
      if (!handleTrainingAuthExpiry()) showToast(learnerSafeTrainingFailure(error, 'catalog'), 'error');
      return false;
    }
  }

  async function loadTrainingTab() {
    const loads = [loadTrainingHistory(), loadTrainingCategories(), loadTrainingCaseCatalog()];
    if (trainingMode === 'evidence') loads.push(loadTrainingEvidenceBooks());
    const results = await Promise.all(loads);
    const categoryLoadFailed = results[1] === false;
    const evidenceLoadFailed = trainingMode === 'evidence' && results[3] === false;
    if (handleTrainingAuthExpiry() || categoryLoadFailed || evidenceLoadFailed) return false;
    updateTrainingStartBtn();
    return true;
  }

  function validTrainingCaseEntry(entry) {
    return entry && typeof entry.caseId === 'string'
      && typeof entry.title === 'string'
      && typeof entry.summary === 'string'
      && entry.mode === 'evidence'
      && typeof entry.category === 'string'
      && typeof entry.difficulty === 'string'
      && Number.isInteger(entry.defaultMaxTurns)
      && entry.defaultMaxTurns >= 1
      && entry.defaultMaxTurns <= 10;
  }

  function renderTrainingCaseCatalog() {
    const container = getEl('training-case-catalog');
    if (!container) return;
    container.replaceChildren();
    if (trainingCaseEntries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-xs text-gray-500';
      empty.textContent = '지금 시작할 수 있는 사례를 불러오지 못했습니다. 아래의 일반 훈련은 계속 사용할 수 있습니다.';
      container.appendChild(empty);
      return;
    }
    trainingCaseEntries.forEach((entry) => {
      const card = document.createElement('article');
      card.className = 'rounded-xl border border-primary-200 bg-white p-4';
      const title = document.createElement('h3');
      title.className = 'font-bold text-gray-900';
      title.textContent = entry.title;
      const summary = document.createElement('p');
      summary.className = 'mt-1 text-xs leading-5 text-gray-600';
      summary.textContent = entry.summary;
      const boundary = document.createElement('p');
      boundary.className = 'mt-2 text-[11px] text-primary-700';
      boundary.textContent = '공개 출처는 유추 자료이며, 가상 사례의 사실이나 정답을 뜻하지 않습니다.';
      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'btn-primary mt-3 text-sm';
      start.dataset.caseId = entry.caseId;
      start.textContent = '이 사례로 시작';
      start.addEventListener('click', () => { void startTrainingCase(entry.caseId); });
      card.append(title, summary, boundary, start);
      container.appendChild(card);
    });
  }

  async function loadTrainingCaseCatalog() {
    try {
      const data = await apiGet('/api/training/cases');
      trainingCaseEntries = Array.isArray(data.cases) ? data.cases.filter(validTrainingCaseEntry) : [];
      renderTrainingCaseCatalog();
      return true;
    } catch (error) {
      if (handleTrainingAuthExpiry()) return false;
      trainingCaseEntries = [];
      renderTrainingCaseCatalog();
      return false;
    }
  }

  function selectTrainingCase(entry) {
    if (!validTrainingCaseEntry(entry)) return false;
    trainingSelectedCase = entry;
    trainingCaseSelectionTransition = true;
    setTrainingMode('evidence');
    selectTrainingCategory(entry.category, { preserveSelectedCase: true });
    selectTrainingDifficulty(entry.difficulty, { preserveSelectedCase: true });
    const turns = getEl('training-evidence-max-turns');
    if (turns) turns.value = String(entry.defaultMaxTurns);
    updateTrainingStartBtn();
    return true;
  }

  async function startTrainingCase(caseId) {
    let entry = trainingCaseEntries.find((candidate) => candidate.caseId === caseId);
    if (!entry) {
      const loaded = await loadTrainingCaseCatalog();
      if (!loaded) {
        showToast('사례 목록을 확인하지 못했습니다. 일반 훈련을 선택하거나 다시 시도해 주세요.', 'error');
        return;
      }
      entry = trainingCaseEntries.find((candidate) => candidate.caseId === caseId);
    }
    if (!selectTrainingCase(entry)) {
      showToast('선택한 사례를 확인하지 못했습니다.', 'error');
      return;
    }
    await startTraining();
  }

  function normalizeTrainingMode(mode, fallback = 'evidence') {
    if (mode === 'evidence' || mode === 'constructed') return mode;
    return fallback === 'constructed' ? 'constructed' : 'evidence';
  }

  function syncTrainingHintControl(mode) {
    const evidenceMode = mode !== 'constructed';
    const hintButton = getEl('training-hint-btn');
    const hintReason = getEl('training-hint-unavailable-reason');
    if (hintButton) {
      hintButton.disabled = mode !== 'constructed';
      hintButton.setAttribute('aria-disabled', String(evidenceMode));
      if (evidenceMode) hintButton.setAttribute('aria-describedby', 'training-hint-unavailable-reason');
      else hintButton.removeAttribute('aria-describedby');
    }
    if (hintReason) {
      hintReason.hidden = mode !== 'evidence';
      hintReason.textContent = KOREAN_JOURNEY_COPY.uncertainty.evidenceHintReason;
    }
  }

  function setTrainingMode(mode) {
    if(trainingFollowUp && mode==='constructed'){showToast('후속 훈련은 출처가 있는 근거 모드를 사용합니다.','error');return;}
    const preserveSelectedCase = trainingCaseSelectionTransition;
    trainingCaseSelectionTransition = false;
    if (!preserveSelectedCase) trainingSelectedCase = null;
    trainingMode = mode === 'constructed' ? 'constructed' : 'evidence';
    document.querySelectorAll('[data-training-mode]').forEach((button) => {
      const selected = button.dataset.trainingMode === trainingMode;
      button.setAttribute('aria-pressed', String(selected));
      button.classList.toggle('border-primary-500', selected);
      button.classList.toggle('bg-primary-50', selected);
    });
    const evidenceConfig = getEl('training-evidence-config');
    const constructedConfig = getEl('training-constructed-config');
    if (evidenceConfig) evidenceConfig.hidden = trainingMode !== 'evidence';
    if (constructedConfig) constructedConfig.hidden = trainingMode !== 'constructed';
    syncTrainingHintControl(activeTrainingMode || trainingMode);
    const summaryIcon = getEl('training-mode-summary-icon');
    const summaryTitle = getEl('training-mode-summary-title');
    const summaryDescription = getEl('training-mode-summary-description');
    if (summaryIcon) summaryIcon.className = trainingMode === 'constructed'
      ? 'fas fa-chess text-amber-600 mr-2'
      : 'fas fa-project-diagram text-primary-500 mr-2';
    if (summaryTitle) summaryTitle.textContent = trainingMode === 'constructed'
      ? '가상 구성 시나리오'
      : '실세계 근거 시나리오';
    if (summaryDescription) summaryDescription.textContent = trainingMode === 'constructed'
      ? '출처나 실제 사실을 주장하지 않는 허구의 의사결정 문제로 연습합니다. 기본 6회입니다.'
      : 'Library 도서 2권 이상의 관점을 결합해 의사결정 문제를 해결합니다. 기본 8회입니다.';
    if (trainingMode === 'evidence') loadTrainingEvidenceBooks();
    updateTrainingStartBtn();
  }

  async function loadTrainingEvidenceBooks() {
    const container = getEl('training-evidence-books');
    if (!container) return;
    try {
      const data = await apiGet('/api/books');
      const books = (data.books || []).filter((book) => {
        const chunkCount = Number(book.chunkCount || 0);
        return chunkCount > 0 && book.ingestionStatus !== 'failed';
      });
      const availableIds = new Set(books.map((book) => String(book.id)));
      trainingEvidenceBookIds = new Set(
        [...trainingEvidenceBookIds].filter((bookId) => availableIds.has(bookId)),
      );
      container.innerHTML = '';
      if (books.length < 2) {
        const empty = document.createElement('p');
        empty.className = 'text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3 col-span-2';
        empty.textContent = '근거 청크가 있는 Library 도서가 2권 이상 필요합니다.';
        container.appendChild(empty);
      } else {
        books.forEach((book) => {
          const label = document.createElement('label');
          label.className = 'flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-3 cursor-pointer hover:border-primary-300 transition';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.className = 'mt-1 accent-primary-500';
          input.value = String(book.id);
          input.checked = trainingEvidenceBookIds.has(input.value);
          input.addEventListener('change', () => {
            trainingSelectedCase = null;
            if (input.checked) trainingEvidenceBookIds.add(input.value);
            else trainingEvidenceBookIds.delete(input.value);
            updateTrainingStartBtn();
          });
          const copy = document.createElement('span');
          copy.className = 'min-w-0';
          const title = document.createElement('span');
          title.className = 'block text-sm font-bold text-gray-900 truncate';
          title.textContent = String(book.title || '제목 없음');
          const meta = document.createElement('span');
          meta.className = 'block text-xs text-gray-500 mt-1';
          meta.textContent = `${book.author || '저자 미상'} · 근거 조각 ${Number(book.chunkCount || 0)}개`;
          copy.append(title, meta);
          label.append(input, copy);
          container.appendChild(label);
        });
      }
      updateTrainingStartBtn();
    } catch (error) {
      if (handleTrainingAuthExpiry()) return false;
      container.innerHTML = '<p class="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3 col-span-2">라이브러리 근거를 불러오지 못했습니다.</p>';
      showToast(error.message, 'error');
      updateTrainingStartBtn();
      return false;
    }
  }

  function updateTrainingEvidenceQuery() { trainingSelectedCase = null; updateTrainingStartBtn(); }
  function selectedTrainingMaxTurns() {
    const input = getEl(trainingMode === 'constructed' ? 'training-constructed-max-turns' : 'training-evidence-max-turns');
    const maxTurns = Number(input?.value);
    return Number.isInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 10 ? maxTurns : null;
  }
  function updateTrainingTurns() { trainingSelectedCase = null; updateTrainingStartBtn(); }
  function selectTrainingCategory(cat, options = {}) {
    if (!options.preserveSelectedCase) trainingSelectedCase = null;
    trainingCategory = cat;
    document.querySelectorAll('.training-cat-btn').forEach(b => {
      const selected = b.dataset.cat === cat;
      b.setAttribute('aria-pressed', String(selected));
      b.classList.toggle('border-primary-500', selected);
      b.classList.toggle('bg-primary-50', selected);
      b.classList.toggle('border-transparent', !selected);
    });
    updateTrainingStartBtn();
  }
  function selectTrainingDifficulty(diff, options = {}) {
    if (!options.preserveSelectedCase) trainingSelectedCase = null;
    trainingDifficulty = diff;
    document.querySelectorAll('.training-diff-btn').forEach(b => { b.classList.toggle('border-primary-500', b.dataset.diff === diff); b.classList.toggle('bg-primary-50', b.dataset.diff === diff); b.classList.toggle('border-transparent', b.dataset.diff !== diff); });
    updateTrainingStartBtn();
  }
  function updateTrainingStartBtn() {
    const btn = getEl('training-start-btn');
    const label = getEl('training-start-label');
    const icon = getEl('training-start-icon');
    const count = getEl('training-evidence-count');
    const status = getEl('training-evidence-status');
    const query = getEl('training-evidence-query')?.value.trim() || '';
    const maxTurns = selectedTrainingMaxTurns();
    const hasBaseSelection = Boolean(trainingCategory && trainingDifficulty);
    const hasEvidence = trainingMode === 'constructed' || Boolean(trainingSelectedCase) || (query.length >= 4 && trainingEvidenceBookIds.size >= 2);
    if (count) count.textContent = trainingEvidenceBookIds.size + '권 선택';
    if (status) {
      status.textContent = trainingMode === 'constructed'
        ? (!hasBaseSelection ? '카테고리와 난이도를 선택하세요.' : !maxTurns ? '훈련 턴 수는 1~10회의 정수여야 합니다.' : `가상의 구성 시나리오를 ${maxTurns}회로 만들 준비가 되었습니다.`)
        : !hasBaseSelection
        ? '카테고리와 난이도를 선택하세요.'
        : !maxTurns
          ? '훈련 턴 수는 1~10회의 정수여야 합니다.'
        : trainingSelectedCase
          ? '선택한 사례의 공개 출처와 근거 계약을 서버에서 확인한 뒤 시작합니다.'
        : query.length < 4
          ? '해결할 실제 문제를 4자 이상 입력하세요.'
          : trainingEvidenceBookIds.size < 2
            ? '서로 다른 근거 도서를 2권 이상 선택하세요.'
            : '라이브러리 근거 스냅샷으로 시나리오를 만들 준비가 되었습니다.';
      status.classList.toggle('text-green-700', hasBaseSelection && hasEvidence && Boolean(maxTurns));
      status.classList.toggle('text-gray-500', !(hasBaseSelection && hasEvidence && maxTurns));
    }
    if (btn) btn.disabled = trainingStartPending || !hasBaseSelection || !hasEvidence || !maxTurns;
    if (!trainingStartPending && label) label.textContent = trainingMode === 'constructed' ? '가상 시나리오 생성' : '근거 시나리오 생성';
    if (!trainingStartPending && icon) icon.className = trainingMode === 'constructed' ? 'fas fa-chess mr-2' : 'fas fa-project-diagram mr-2';
  }

  async function startTraining() {
    if(trainingStartPending)return;
    const btn = getEl('training-start-btn'); if (!btn) return;
    if (!trainingCategory || !trainingDifficulty) {
      updateTrainingStartBtn();
      showToast('카테고리와 난이도를 다시 선택해 주세요.', 'error');
      return;
    }
    const submittedTrainingMode = trainingMode;
    const label = getEl('training-start-label');
    const icon = getEl('training-start-icon');
    const evidenceQuery = getEl('training-evidence-query')?.value.trim() || '';
    const maxTurns = selectedTrainingMaxTurns();
    if (!maxTurns) { showToast('훈련 턴 수는 1~10회의 정수여야 합니다.', 'error'); return; }
    const requestVersion = ++trainingResumeVersion;
    trainingControl = null;
    trainingStartPending = true;
    btn.disabled = true;
    if (icon) icon.className = 'fas fa-spinner fa-spin mr-2';
    if (label) label.textContent = '근거 분석 중...';
    try {
      const data = await api('/api/training/start', {
        category: trainingCategory,
        difficulty: trainingDifficulty,
        mode: submittedTrainingMode,
        ...(submittedTrainingMode === 'evidence' ? { learningRouteVersion: 1 } : {}),
        ...(trainingFollowUp ? {growthFollowUpLaunchId:trainingFollowUp.launchId} : {}),
        ...(trainingSelectedCase ? {caseId:trainingSelectedCase.caseId} : {}),
        evidenceQuery,
        evidenceBookIds: [...trainingEvidenceBookIds],
        constructedFocus: getEl('training-constructed-focus')?.value.trim() || '',
        maxTurns,
      });
      if(requestVersion!==trainingResumeVersion)return;
      trainingSessionId = data.sessionId;
      trainingFollowUp = data.growthFollowUp || null;
      renderFollowUpNotice(trainingFollowUp);
      activeTrainingMode = normalizeTrainingMode(data?.session?.mode ?? data?.mode);
      syncTrainingHintControl(activeTrainingMode);
      resetTrainingMeasurement();
      setDisplay('training-selection', 'none'); setDisplay('training-session', 'block');
      const qt = getEl('training-q-title'); if (qt) qt.textContent = data.title || trainingCategory;
      const qq = getEl('training-question-text'); if (qq) qq.textContent = data.question;
      const qc = getEl('training-context'); if (qc) qc.textContent = data.context || '';
      renderTrainingGrounding(data.grounding);
      renderTrainingBriefing(data.briefing);
      renderTrainingRoute(data.learningRoute);
      try { await refreshTrainingControl(); } catch { if(requestVersion===trainingResumeVersion){trainingControl={state:'UNKNOWN'};renderTrainingControl();} }
      if(requestVersion!==trainingResumeVersion)return;
      try { await refreshLearnerRevisions(); } catch { if(requestVersion===trainingResumeVersion)showToast('수정 기록을 불러오지 못했습니다.', 'error'); }
      if(requestVersion!==trainingResumeVersion)return;
      const mm = getEl('training-messages'); if (mm) mm.innerHTML = '';
      const tt = getEl('tr-turn'); if (tt) tt.textContent = '1/' + data.maxTurns;
      const tg = getEl('tr-goal'); if (tg) tg.textContent = data.sessionGoal || '-';
      showToast(activeTrainingMode === 'constructed' ? '가상의 구성 시나리오가 생성되었습니다.' : '라이브러리 근거 시나리오가 생성되었습니다.', 'success');
    } catch(e) {
      if(requestVersion!==trainingResumeVersion)return;
      if(e.code==='GROWTH_FOLLOW_UP_ALREADY_STARTED' && typeof e.payload?.sessionId==='string'){await resumeTrainingSession(e.payload.sessionId);return;}
      const message = e.message === 'scenario_evidence_insufficient'
        ? '선택한 도서에서 문제와 연결되는 근거를 충분히 찾지 못했습니다.'
        : learnerSafeTrainingFailure(e, 'start');
      showToast(message, 'error');
    } finally {
      if(requestVersion===trainingResumeVersion)trainingStartPending = false;
      updateTrainingStartBtn();
    }
  }

  function renderTrainingGrounding(grounding) {
    trainingGroundingReady = activeTrainingMode === 'constructed' || grounding?.status === 'ready';
    syncTrainingRouteControls();
    const container = getEl('training-grounding');
    if (!container) return;
    if (grounding && grounding.status === 'not_applicable') {
      container.innerHTML = '<div class="rounded-xl border border-amber-200 bg-amber-50 p-3"><p class="text-xs font-bold text-amber-800"><i class="fas fa-chess mr-1"></i>가상 구성 시나리오</p><p class="text-xs text-amber-700 mt-1">이 연습은 허구로 구성되며 출처나 실제 사실을 주장하지 않습니다.</p></div>';
      return;
    }
    if (!grounding || grounding.status !== 'ready') {
      container.innerHTML = '<div class="rounded-xl border border-red-200 bg-red-50 p-3"><p class="text-xs font-bold text-red-800">근거 스냅샷을 검증하지 못했습니다.</p><p class="text-xs text-red-700 mt-1">근거를 확인할 때까지 새 답변과 설명 생성은 멈춥니다. 저장된 기록을 읽거나 아래에서 쉬기·종료를 선택할 수 있습니다.</p></div>';
      const retry=document.createElement('button');retry.type='button';retry.className='btn-secondary';retry.textContent='근거 상태 다시 확인';
      retry.addEventListener('click',async()=>{
        const sessionId=trainingSessionId;const requestVersion=trainingResumeVersion;retry.disabled=true;
        trainingControl=null;renderTrainingControl();
        try { const detail=await apiGet('/api/training/session/'+encodeURIComponent(sessionId));if(sessionId===trainingSessionId && requestVersion===trainingResumeVersion){renderTrainingGrounding(detail.grounding);await refreshTrainingControl(sessionId);} }
        catch { if(sessionId===trainingSessionId && requestVersion===trainingResumeVersion){trainingControl={state:'UNKNOWN'};renderTrainingControl();showToast('근거 또는 제어 상태를 확인하지 못했습니다. 다시 확인한 뒤 이어가세요.','error');} }
        finally { retry.disabled=false; }
      });
      container.appendChild(retry);

      return;
    }
    const sources = Array.isArray(grounding.sources) ? grounding.sources : [];
    const bookTitles = [...new Set(sources.map((source) => source.bookTitle).filter(Boolean))];
    container.innerHTML = '<div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3"><div class="flex items-center justify-between gap-3"><p class="text-xs font-bold text-emerald-800"><i class="fas fa-shield-alt mr-1"></i>라이브러리 근거 확정</p><span class="text-xs text-emerald-700">근거 '+sources.length+'개 · 도서 '+bookTitles.length+'권</span></div><p class="text-xs text-emerald-800 mt-2">'+bookTitles.map(esc).join(' · ')+'</p><p class="text-[11px] text-emerald-700 mt-2 font-mono">근거 ID '+esc(String(grounding.manifestSha256 || '').slice(0, 16))+'…</p></div>';
  }

  function renderTrainingBriefing(briefing) {
    const container = getEl('training-briefing'); if (!container) return;
    if (!briefing || !Array.isArray(briefing.sources) || briefing.sources.length === 0) { container.innerHTML = ''; return; }
    const keyNumbers = Array.isArray(briefing.key_numbers) ? briefing.key_numbers : [];
    const angles = Array.isArray(briefing.angles) ? briefing.angles : [];
    const typeCount = { article: 0, report: 0, paper: 0, library: 0 };
    briefing.sources.forEach(s => { const t = String(s.type||'').toLowerCase(); if (typeCount[t] !== undefined) typeCount[t]++; });
    const isLibraryGrounded = typeCount.library > 0;
    const qualityScore = [briefing.summary?1:0, keyNumbers.length>=3?1:0, angles.length>=3?1:0, typeCount.article>=3?1:0, typeCount.report>=1?1:0, typeCount.paper>=1?1:0].reduce((a,b)=>a+b,0);
    const badge = isLibraryGrounded
      ? '<span class="text-[11px] font-bold px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">확정된 라이브러리 근거 '+typeCount.library+'개</span>'
      : '<span class="text-[11px] font-bold px-2 py-1 rounded-full bg-amber-100 text-amber-700">품질 점수 '+qualityScore+'/6</span>';
    const typeSummary = isLibraryGrounded
      ? '<span class="text-[11px] px-2 py-1 rounded-full bg-emerald-50 text-emerald-700">라이브러리 '+typeCount.library+'</span>'
      : '<span class="text-[11px] px-2 py-1 rounded-full bg-blue-50 text-blue-700">기사 '+typeCount.article+'</span><span class="text-[11px] px-2 py-1 rounded-full bg-emerald-50 text-emerald-700">보고서 '+typeCount.report+'</span><span class="text-[11px] px-2 py-1 rounded-full bg-violet-50 text-violet-700">논문 '+typeCount.paper+'</span>';
    const sourceCards = briefing.sources.map((source, index) => {
      const title = '['+(index+1)+'] '+esc(source.title || '출처');
      const heading = source.url
        ? '<a href="'+esc(source.url)+'" target="_blank" rel="noopener noreferrer" class="text-sm font-semibold text-primary-600 hover:underline">'+title+'</a>'
        : '<p class="text-sm font-semibold text-gray-900">'+title+'</p>';
      const hash = source.contentSha256
        ? '<p class="text-[11px] text-gray-400 mt-1 font-mono">sha256 '+esc(String(source.contentSha256).slice(0, 16))+'…</p>'
        : '';
      return '<div class="bg-white border border-gray-200 rounded-lg p-2">'+heading+'<p class="text-[11px] text-gray-500 uppercase">'+esc(source.type||'source')+(source.author?' · '+esc(source.author):'')+'</p><p class="text-xs text-gray-600 mt-1">'+esc(source.summary||'')+'</p>'+hash+'</div>';
    }).join('');
    container.innerHTML = '<div class="bg-gray-50 border border-gray-200 rounded-xl p-3"><div class="flex items-center justify-between gap-3 mb-2"><p class="text-xs font-bold text-gray-500 uppercase">근거 브리핑</p>'+badge+'</div><p class="text-sm text-gray-700 mb-2">'+esc(briefing.summary||'')+'</p><div class="flex flex-wrap gap-2 mb-2">'+typeSummary+'</div>'+(keyNumbers.length?'<p class="text-xs text-gray-600 mb-2"><strong>핵심 수치:</strong> '+keyNumbers.map(esc).join(' · ')+'</p>':'')+(angles.length?'<p class="text-xs text-gray-600 mb-2"><strong>관점:</strong> '+angles.map(esc).join(', ')+'</p>':'')+'<div class="space-y-2">'+sourceCards+'</div></div>';
  }

  async function submitTrainingMessage() {
    const input = getEl('training-input'); const message = input ? input.value.trim() : '';
    if (trainingControl?.state !== 'ACTIVE') return;
    if (!trainingGroundingReady || !message || !trainingSessionId || trainingRouteBusy || trainingTurnBusy || trainingRevisionBusy || trainingCompleted) return;
    if (trainingRouteProjection?.status === 'AWAITING_CHOICE') { showToast(KOREAN_JOURNEY_COPY.learningRoute.required, 'error'); return; }
    trainingTurnBusy = true; syncTrainingRouteControls();
    const btn = getEl('training-submit-btn'); if (btn) btn.disabled = true;
    let sessionEnded = false;
    const msgDiv = getEl('training-messages');
    if (msgDiv) { msgDiv.innerHTML += '<div class="flex gap-2 flex-row-reverse fade-in"><div class="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0"><i class="fas fa-user text-gray-500 text-xs"></i></div><div class="bg-primary-50 rounded-xl px-4 py-2 text-sm max-w-[80%]">'+esc(message)+'</div></div>'; }
    if (input) input.value = '';
    if (msgDiv) { msgDiv.innerHTML += '<div id="tr-typing" class="flex gap-2 fade-in"><div class="w-7 h-7 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0"><i class="fas fa-brain text-primary-500 text-xs"></i></div><div class="bg-white border border-gray-100 rounded-xl px-4 py-2 text-sm typing-indicator"><span>.</span><span>.</span><span>.</span></div></div>'; msgDiv.scrollTop = msgDiv.scrollHeight; }
    try {
      const data = await api('/api/training/chat', { sessionId: trainingSessionId, message });
      const ty = getEl('tr-typing'); if (ty) ty.remove();
      if (msgDiv) { msgDiv.innerHTML += '<div data-training-turn="'+esc(String(data.session?.currentTurn || ''))+'" class="flex gap-2 fade-in"><div class="w-7 h-7 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0"><i class="fas fa-brain text-primary-500 text-xs"></i></div><div class="bg-white border border-gray-100 rounded-xl px-4 py-2 text-sm max-w-[80%]">'+esc(data.aiReply)+'</div></div>'; msgDiv.scrollTop = msgDiv.scrollHeight; }
      renderTrainingAttribution(data.attribution);
      try { await refreshTrainingControl(); } catch { trainingControl={state:'UNKNOWN'}; renderTrainingControl(); }
      if (data.learningRoute) renderTrainingRoute(data.learningRoute, Boolean(data.isSessionEnd));
      if (data.session) { const ts = getEl('tr-state'); if (ts) ts.textContent = data.session.tutorState||'-'; const tg = getEl('tr-goal'); if (tg) tg.textContent = data.session.sessionGoal||'-'; const tt = getEl('tr-turn'); if (tt) tt.textContent = data.session.currentTurn+'/'+data.session.maxTurns; const th = getEl('tr-hint'); if (th) th.textContent = 'H'+(data.session.hintLevel||0); }
      if (data.evaluation) { renderTrainingMeasurement(data.evaluation);
        if (data.evaluation.weakness_tags && data.evaluation.weakness_tags.length) { const tw = getEl('tr-weakness'); if (tw) tw.innerHTML = data.evaluation.weakness_tags.map(t=>'<span class="inline-block bg-warning-light text-warning-dark text-xs px-2 py-0.5 rounded-full mr-1 mb-1 border border-warning-border">'+esc(t)+'</span>').join(''); }
      }
      try { await refreshLearnerRevisions(); } catch { showToast('수정 기록을 불러오지 못했습니다. 대화를 다시 열어 확인해 주세요.', 'error'); }
      if (data.isSessionEnd) {
        sessionEnded = true;
        showToast('Training 세션이 완료되었습니다.', 'success');
        if (input) input.disabled = true;
        if (msgDiv) {
          renderTrainingGrowthAction({ id: trainingSessionId, is_completed: true, origin: 'training' }, msgDiv);
          const restart = document.createElement('button');
          restart.type = 'button';
          restart.className = 'btn-primary mt-4';
          restart.textContent = '다른 시나리오 시작';
          restart.addEventListener('click', resetTrainingUI);
          msgDiv.appendChild(restart);
        }
      }
    } catch(e) {
      const ty = getEl('tr-typing'); if (ty) ty.remove();
      if (input && !input.value) input.value = message;
      if (trainingRouteProjection?.offer) { try { renderTrainingRoute(await apiGet('/api/training/session/' + encodeURIComponent(trainingSessionId) + '/route')); } catch {} }
      try { await refreshTrainingControl(); } catch {}
      const failureMessage = learnerSafeTrainingFailure(e);
      if (msgDiv) {
        msgDiv.innerHTML += '<div class="flex gap-2 fade-in"><div class="w-7 h-7 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0"><i class="fas fa-triangle-exclamation text-red-600 text-xs"></i></div><div class="bg-red-50 border border-red-200 rounded-xl px-4 py-2 text-sm max-w-[80%] whitespace-pre-line">'+esc(failureMessage)+'</div></div>';
        msgDiv.scrollTop = msgDiv.scrollHeight;
      } else {
        showToast(failureMessage, 'error');
      }
    } finally { trainingTurnBusy = false; trainingCompleted = sessionEnded; renderTrainingControl(); syncTrainingRouteControls(); }
  }

  async function requestTrainingHint() {
    if (!trainingSessionId) return;
    if (activeTrainingMode !== 'constructed') {
      const hintReason = getEl('training-hint-unavailable-reason');
      if (hintReason) {
        hintReason.hidden = false;
        hintReason.textContent = KOREAN_JOURNEY_COPY.uncertainty.evidenceHintReason;
      }
      showToast(KOREAN_JOURNEY_COPY.uncertainty.evidenceHintReason, 'error');
      return;
    }
    try {
      const data = await api('/api/training/hint', { sessionId: trainingSessionId });
      const msgDiv = getEl('training-messages');
      if (msgDiv) { msgDiv.innerHTML += '<div class="flex gap-2 fade-in"><div class="w-7 h-7 rounded-full bg-yellow-100 flex items-center justify-center flex-shrink-0"><i class="fas fa-lightbulb text-yellow-500 text-xs"></i></div><div class="bg-yellow-50 border border-yellow-200 rounded-xl px-4 py-2 text-sm max-w-[80%]"><span class="font-bold text-yellow-700 text-xs">힌트 H'+data.hintLevel+'</span><br>'+esc(data.hintMessage)+'</div></div>'; msgDiv.scrollTop = msgDiv.scrollHeight; }
      const th = getEl('tr-hint'); if (th) th.textContent = 'H'+data.hintLevel;
    } catch(e) { showToast(learnerSafeTrainingFailure(e), 'error'); }
  }

  function renderFollowUpNotice(launch, destination = 'training-question-card') {
    getEl('training-follow-up-notice')?.remove();
    if (!launch) return;
    const panel=document.createElement('section');panel.id='training-follow-up-notice';panel.className='training-control-panel';
    const title=document.createElement('h3');title.textContent='후속 훈련의 조건과 기록 안내';
    const condition=document.createElement('p');condition.textContent='내가 정한 가정 조건: '+launch.changedCondition;
    const note=document.createElement('p');note.textContent='같은 자료를 다시 사용할 수 있습니다. 이 조건의 적절성과 학습 효과는 아직 확인되지 않았습니다.';
    const policy=document.createElement('p');const protocol=launch.protocol;
    if(protocol?.status==='PREDECLARED_LOCAL'){
      policy.textContent='시작 전에 정한 앱 내 기록 범위: 제출한 답변과 튜터 설명, 힌트 단계, 도움 요청, 일시 정지·재개·중단, 학습 경로와 주장 수정 기록입니다.';
    }else if(protocol?.status==='NOT_PREDECLARED'){
      policy.textContent='이 후속 훈련에는 시작 전에 정한 기록 정책이 없습니다. 이후의 기록을 사전 선언으로 간주하지 않습니다.';
    }else{
      policy.textContent='시작 전에 정한 기록 정책을 확인할 수 없습니다. 기록이 없거나 도움을 받지 않았다는 뜻은 아닙니다.';
    }
    const limits=document.createElement('p');limits.textContent='앱 밖의 도움과 실제로 읽었는지는 확인할 수 없습니다. 기록만으로 학습 효과나 전이를 판단하지 않으며 결과는 UNKNOWN으로 남습니다.';
    const back=document.createElement('button');back.type='button';back.className='btn-secondary';back.textContent='저장한 재확인으로 돌아가기';
    back.addEventListener('click',async()=>{try{await S.openGrowthRecheck(launch);}catch{showToast('성장 실험실에서 저장한 후속 훈련을 다시 열 수 있습니다.','error');}});
    panel.append(title,condition,note,policy,limits,back);getEl(destination)?.prepend(panel);
  }

  function startTrainingFollowUp(launch) {
    resetTrainingUI();trainingFollowUp={...launch,launchId:launch.launchId||launch.id};trainingEvidenceBookIds=new Set();
    const query=getEl('training-evidence-query');if(query)query.value='';setTrainingMode('evidence');
    renderFollowUpNotice(trainingFollowUp,'training-selection');
  }

  function renderHeldOutAttempt(projection) {
    getEl('training-m4-attempt')?.remove();
    const host = getEl('training-session');
    const attempt = projection?.status === 'AVAILABLE' ? projection.attempt : null;
    if (!host || (!attempt && projection?.status !== 'UNAVAILABLE')) return;
    const panel = document.createElement('section');
    panel.id = 'training-m4-attempt';
    panel.className = 'training-control-panel';
    const title = document.createElement('h3'); title.textContent = 'M4 즉시 무지원 응답';
    if (!attempt) { const unavailable = document.createElement('p'); unavailable.textContent = 'M4 시도 기록을 현재 확인할 수 없습니다. 배정이 없었다고 추정하지 않습니다.'; panel.append(title, unavailable); host.appendChild(panel); return; }
    const status = document.createElement('p');
    status.textContent = `${attempt.opaqueVariantId || 'opaque variant'} · ${({ ARMED: '열기 전', IN_PROGRESS: '작성 중', SUBMITTED: '제출됨', ABANDONED: '내 선택으로 멈춤', QUARANTINED: '격리됨' })[attempt.state] || '상태 확인 필요'}`;
    const assessment = document.createElement('p'); assessment.textContent = '평가 결과는 UNKNOWN입니다. 제출은 응답 기록만 뜻하며 점수·학습·숙달을 뜻하지 않습니다.';
    panel.append(title, status, assessment);
    const requestVersion = trainingResumeVersion;
    const rerender = async (path, body) => {
      try {
        const data = await api(path, body);
        if (requestVersion !== trainingResumeVersion || trainingSessionId !== attempt.baseSessionId) return;
        renderHeldOutAttempt({ status: 'AVAILABLE', attempt: data.attempt });
      } catch (error) { if (requestVersion === trainingResumeVersion) showToast(learnerSafeTrainingFailure(error), 'error'); }
    };
    const appendContaminationControl = () => {
      const disclosure = document.createElement('p'); disclosure.textContent = '외부 도움 또는 문제 노출을 신고하면 이 시도는 격리됩니다.';
      const report = document.createElement('button'); report.type = 'button'; report.className = 'btn-secondary'; report.textContent = '신고하고 이 시도 격리';
      report.addEventListener('click', () => rerender(`/api/training/heldout-attempts/${encodeURIComponent(attempt.id)}/contamination`, { contaminationCode: 'LEARNER_REPORTED_EXPOSURE', expectedRevision: attempt.revision, mutationKey: crypto.randomUUID() }));
      panel.append(disclosure, report);
    };
    if (attempt.state === 'ARMED') {
      const open = document.createElement('button'); open.type = 'button'; open.className = 'btn-primary'; open.textContent = '문제 열기';
      open.addEventListener('click', () => rerender(`/api/training/heldout-attempts/${encodeURIComponent(attempt.id)}/open`, { expectedRevision: attempt.revision, mutationKey: crypto.randomUUID() }));
      panel.appendChild(open); appendContaminationControl();
    } else if (attempt.state === 'IN_PROGRESS') {
      const task = document.createElement('p'); task.className = 'whitespace-pre-wrap'; task.textContent = attempt.taskText || '문제를 현재 확인할 수 없습니다.';
      const label = document.createElement('label'); label.htmlFor = 'training-m4-response'; label.textContent = '도움 없이 작성한 응답';
      const response = document.createElement('textarea'); response.id = 'training-m4-response'; response.rows = 6; response.maxLength = 8000; response.setAttribute('aria-label', '도움 없이 작성한 응답');
      const actions = document.createElement('div'); actions.className = 'flex gap-2';
      const submit = document.createElement('button'); submit.type = 'button'; submit.className = 'btn-primary'; submit.textContent = '응답 기록';
      const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'btn-secondary'; stop.textContent = '여기서 멈추기';
      submit.addEventListener('click', () => rerender(`/api/training/heldout-attempts/${encodeURIComponent(attempt.id)}/submit`, { response: response.value, expectedRevision: attempt.revision, mutationKey: crypto.randomUUID() }));
      stop.addEventListener('click', () => rerender(`/api/training/heldout-attempts/${encodeURIComponent(attempt.id)}/stop`, { expectedRevision: attempt.revision, mutationKey: crypto.randomUUID() }));
      actions.append(submit, stop); panel.append(task, label, response, actions); appendContaminationControl();
      requestAnimationFrame(() => response.focus());
    } else if (attempt.state === 'SUBMITTED') {
      const response = document.createElement('p'); response.className = 'whitespace-pre-wrap'; response.textContent = `내 응답: ${attempt.response || ''}`;
      const hash = document.createElement('p'); hash.textContent = `응답 해시: ${attempt.responseHash || 'UNKNOWN'}`;
      panel.append(response, hash);
    } else if (attempt.state === 'ABANDONED') {
      const copy = document.createElement('p'); copy.textContent = '내가 멈춘 기록입니다. 실패나 0점으로 평가하지 않습니다.'; panel.appendChild(copy);
    } else if (attempt.state === 'QUARANTINED') {
      const copy = document.createElement('p'); copy.textContent = '문제 또는 노출 경계를 확인하지 못해 이 시도는 격리되었습니다. 새 문제나 점수로 바꾸지 않습니다.'; panel.appendChild(copy);
    }
    host.appendChild(panel);
  }

  function resetTrainingUI() {
    trainingFollowUp=null;getEl('training-follow-up-notice')?.remove();
    trainingSelectedCase=null;
    getEl('training-m4-attempt')?.remove();
    trainingResumeVersion++;trainingStartPending=false;
    trainingControl=null;trainingControlBusy=false;trainingSupportBusy=false;trainingCanSupport=false; const controls=getEl('training-control-panel');if(controls){controls.replaceChildren();controls.hidden=true;}
    trainingRevisionBusy = false; const revisionPanel = getEl('training-revision-panel'); if (revisionPanel) { revisionPanel.replaceChildren(); revisionPanel.hidden = true; }
    trainingSessionId = null; trainingGroundingReady = false;
    trainingRouteBusy = false; trainingTurnBusy = false; renderTrainingRoute(null);
    activeTrainingMode = null;
    syncTrainingHintControl(trainingMode);
    setDisplay('training-session', 'none');
    setDisplay('training-selection', 'block');
    const input = getEl('training-input'); if (input) input.disabled = false;
    const submit = getEl('training-submit-btn'); if (submit) submit.disabled = false;
    resetTrainingMeasurement();
    renderTrainingGrounding(null);
    renderTrainingBriefing(null);
  }

  function renderTrainingAttribution(attribution) {
    const container = getEl('training-messages');
    if (!container || !attribution) return;
    const sources = Array.isArray(attribution.sources) ? attribution.sources : [];
    const label = attribution.status === 'cited' ? '검증된 출처' : attribution.status === 'uncited' ? '출처 미인용' : '출처 확인 불가';
    const cards = sources.map((source) => {
      const location = [source.chunkIndex === null || source.chunkIndex === undefined ? '' : 'chunk '+source.chunkIndex, source.charStart === null || source.charStart === undefined ? '' : source.charStart+'–'+(source.charEnd ?? '?')].filter(Boolean).join(' · ');
      const life = source.lifecycleBadge === 'unknown' ? '상태 미상' : source.lifecycleBadge === 'deleted' ? '삭제됨' : source.lifecycleBadge === 'quarantined' ? '격리됨' : '활성';
      return '<div class="rounded-lg border border-gray-200 bg-white p-2"><p class="text-xs font-bold text-gray-800">'+esc(source.bookTitle || '제목 미상')+(source.bookAuthor?' · '+esc(source.bookAuthor):'')+'</p><p class="text-[11px] text-gray-500">'+esc(location)+' · '+esc(life)+'</p><p class="mt-1 whitespace-pre-wrap text-xs text-gray-700">'+esc(source.passage || '')+'</p><p class="mt-1 font-mono text-[10px] text-gray-400">sha256 '+esc(String(source.contentSha256 || '').slice(0,16))+'…</p></div>';
    }).join('');
    const card = document.createElement('section');
    card.className = 'ml-9 mt-2 max-w-[80%] rounded-xl border border-gray-200 bg-gray-50 p-3';
    card.innerHTML = '<p class="text-xs font-bold text-gray-700">학습자 출처 기록 · Turn '+esc(String(attribution.turnNumber))+' · '+esc(label)+'</p><p class="mt-1 text-xs text-gray-600">주장: '+esc(attribution.claim || '')+'</p>'+(cards || '<p class="mt-1 text-xs text-gray-500">'+esc(attribution.unavailableReason || '이 응답에는 검증 가능한 출처가 기록되지 않았습니다.')+'</p>');
    const anchors = [...container.querySelectorAll('[data-training-turn]')];
    const anchor = anchors.filter((item) => item.dataset.trainingTurn === String(attribution.turnNumber)).at(-1);
    if (anchor) anchor.after(card); else container.appendChild(card);
    container.scrollTop = container.scrollHeight;
  }

  async function loadTrainingHistory() {
    try {
      const data = await apiGet('/api/training/sessions');
      const list = getEl('training-history-list'), histDiv = getEl('training-history');
      if (!list || !histDiv) return;
      if (data.sessions && data.sessions.length > 0) {
        histDiv.style.display = 'block';
        const catIcons = { business:'fa-briefcase text-blue-500', economics:'fa-chart-line text-indigo-500', philosophy:'fa-yin-yang text-violet-500', psychology:'fa-brain text-pink-500', politics:'fa-balance-scale text-red-500', policy:'fa-landmark text-green-500', technology:'fa-microchip text-purple-500', environment:'fa-leaf text-emerald-500', science:'fa-flask text-cyan-500', humanities:'fa-book-reader text-amber-500' };
        list.innerHTML = data.sessions.map(s => {
          const icon = catIcons[s.category]||'fa-question text-gray-400';
          const date = new Date(s.created_at).toLocaleDateString('ko-KR');
          const status = s.is_completed
            ? '<span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">완료</span>'
            : '<span class="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">진행중</span>';
          const mode = s.mode === 'evidence'
            ? '<span class="text-xs bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full">훈련 · 근거 기반</span>'
            : '<span class="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">훈련 · 구성 시나리오'+(s.origin === 'legacy_scenario' ? ' · 이전 방식' : '')+'</span>';
          const storedRating = typeof s.rating === 'string' ? s.rating.trim() : '';
          const rating = storedRating && storedRating !== 'UNKNOWN'
            ? storedRating
            : (s.origin === 'legacy_scenario' ? '확인 불가' : '기록 없음');
          const legacyNotice = s.origin === 'legacy_scenario'
            ? '<p class="mt-2 text-xs text-amber-700">Not eligible for a private Growth Cycle: this is a legacy scenario record.</p>'
            : '';
          return '<button type="button" class="training-history-card history-card mb-3 w-full text-left hover:border-primary-300 transition" data-training-session="'+esc(String(s.id))+'"><div class="flex items-center justify-between gap-3 mb-1"><div class="flex items-center gap-2 min-w-0"><i class="fas '+icon+'"></i><span class="font-bold text-sm truncate">'+esc(s.question_title||s.category)+'</span></div>'+status+'</div><div class="flex items-center gap-3 text-xs text-gray-500 flex-wrap"><span>'+date+'</span><span>'+Math.max(0, Number(s.current_turn||1)-1)+'/'+Number(s.max_turns||8)+'회차</span><span class="font-bold text-primary-500">'+esc(rating)+'</span>'+mode+'</div>'+legacyNotice+'</button>';
        }).join('');
        list.querySelectorAll('[data-training-session]').forEach((card) => {
          card.addEventListener('click', () => resumeTrainingSession(card.dataset.trainingSession));
        });
      } else { histDiv.style.display = 'none'; }
    } catch(e) {
      if (handleTrainingAuthExpiry()) return false;
      console.warn('[TRAINING]', e);
      return false;
    }
  }

  async function resumeTrainingSession(sessionId) {
    const requestVersion = ++trainingResumeVersion;
    trainingStartPending=false;
    clearHeldOutAssistanceUI();
    try {
      const data = await apiGet('/api/training/session/' + encodeURIComponent(sessionId));
      if (requestVersion !== trainingResumeVersion) return;
      if (!data || !data.session) throw new Error('세션을 찾을 수 없습니다.');
      if (trainingSessionId !== sessionId) { trainingRevisionBusy = false;trainingControl=null;trainingControlBusy=false;trainingSupportBusy=false;trainingCanSupport=false; }
      trainingSessionId = sessionId;
      trainingFollowUp = data.growthFollowUp || null;
      renderFollowUpNotice(trainingFollowUp);
      activeTrainingMode = normalizeTrainingMode(data.session.mode, 'evidence');
      syncTrainingHintControl(activeTrainingMode);
      resetTrainingMeasurement();
      const latestTurn = Array.isArray(data.turns)
        ? [...data.turns].reverse().find((turn) => {
            const values = [turn?.claim_clarity, turn?.evidence_use, turn?.reasoning_strength, turn?.consistency_score, turn?.relevance_score]
              .map((value) => Number(value));
            return values.every((value) => Number.isFinite(value) && value >= 1 && value <= 5);
          })
        : null;
      if (data.session.evaluation_status === 'MEASURED' && latestTurn) {
        renderTrainingMeasurement({
          claim_clarity: latestTurn.claim_clarity,
          evidence_use: latestTurn.evidence_use,
          reasoning_strength: latestTurn.reasoning_strength,
          consistency: latestTurn.consistency_score,
          relevance: latestTurn.relevance_score,
        });
      }
      setDisplay('training-selection', 'none'); setDisplay('training-session', 'block');
      const qt = getEl('training-q-title'); if (qt) qt.textContent = data.session.question_title || data.session.category;
      const qq = getEl('training-question-text'); if (qq) qq.textContent = data.session.question || '';
      const qc = getEl('training-context'); if (qc) qc.textContent = data.session.context || '';
      const tt = getEl('tr-turn'); if (tt) tt.textContent = (data.session.current_turn || 1) + '/' + (data.session.max_turns || 8);
      const tg = getEl('tr-goal'); if (tg) tg.textContent = data.session.session_goal || '-';
      const ts = getEl('tr-state'); if (ts) ts.textContent = data.session.tutor_state || 'elicitation';
      const th = getEl('tr-hint'); if (th) th.textContent = 'H' + (data.session.deep_hint_level || 0);
      renderTrainingGrounding(data.grounding);
      renderTrainingBriefing(null);
      const mm = getEl('training-messages');
      if (mm && data.messages) {
        mm.innerHTML = data.messages.map(m => {
          if (m.role === 'ai' || m.role === 'assistant') return '<div data-training-turn="'+esc(String(m.turn || 0))+'" class="flex gap-2 fade-in"><div class="w-7 h-7 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0"><i class="fas fa-brain text-primary-500 text-xs"></i></div><div class="bg-white border border-gray-100 rounded-xl px-4 py-2 text-sm max-w-[80%]">'+esc(m.content)+'</div></div>';
          return '<div data-training-turn="'+esc(String(m.turn || 0))+'" class="flex gap-2 flex-row-reverse fade-in"><div class="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0"><i class="fas fa-user text-gray-500 text-xs"></i></div><div class="bg-primary-50 rounded-xl px-4 py-2 text-sm max-w-[80%]">'+esc(m.content)+'</div></div>';
        }).join('');
        mm.scrollTop = mm.scrollHeight;
      }
      (data.attributions || []).forEach(renderTrainingAttribution);
      const input = getEl('training-input'); if (input) input.disabled = Boolean(data.session.is_completed);
      const submit = getEl('training-submit-btn'); if (submit) submit.disabled = Boolean(data.session.is_completed);
      renderTrainingGrowthAction(data.session, mm);
      renderTrainingRoute(data.learningRoute, Boolean(data.session.is_completed));
      renderHeldOutAttempt(data.heldOutAttempt);
      if (isActiveHeldOutAttempt(data.heldOutAttempt)) {
        clearHeldOutAssistanceUI();
      } else {
        try { await refreshTrainingControl(sessionId); } catch { if(requestVersion===trainingResumeVersion){trainingControl={state:'UNKNOWN'};renderTrainingControl();} }
        if(requestVersion!==trainingResumeVersion)return;
        try { await refreshLearnerRevisions(sessionId); } catch { if(requestVersion===trainingResumeVersion)showToast('수정 기록을 불러오지 못했습니다.', 'error'); }
        if(requestVersion!==trainingResumeVersion)return;
      }
      showToast(data.session.is_completed ? '완료된 세션을 읽기 전용으로 열었습니다.' : 'Training 세션을 이어갑니다.', 'success');
    } catch(e) { if(requestVersion===trainingResumeVersion){showToast(e.message, 'error'); resetTrainingUI();} }
  }

  function seedTrainingEvidenceBook(bookId) {
    const normalizedBookId = String(bookId || '').trim();
    if (!normalizedBookId) return;
    trainingSelectedCase = null;
    trainingEvidenceBookIds.add(normalizedBookId);
    const checkbox = document.querySelector('#training-evidence-books input[value="' + CSS.escape(normalizedBookId) + '"]');
    if (checkbox) checkbox.checked = true;
    updateTrainingStartBtn();
  }

  window.renderTrainingRoute = renderTrainingRoute;
  window.loadTrainingTab = loadTrainingTab;
  window.loadTrainingCaseCatalog = loadTrainingCaseCatalog;
  window.updateTrainingEvidenceQuery = updateTrainingEvidenceQuery;
  window.updateTrainingTurns = updateTrainingTurns;
  window.selectTrainingCategory = selectTrainingCategory;
  window.selectTrainingDifficulty = selectTrainingDifficulty;
  window.setTrainingMode = setTrainingMode;
  window.startTrainingCase = startTrainingCase;
  window.startTrainingFollowUp = startTrainingFollowUp;
  window.startTraining = startTraining;
  window.submitTrainingMessage = submitTrainingMessage;
  window.requestTrainingHint = requestTrainingHint;
  window.resetTrainingUI = resetTrainingUI;
  window.resumeTrainingSession = resumeTrainingSession;
  window.renderTrainingAttribution = renderTrainingAttribution;
  window.seedTrainingEvidenceBook = seedTrainingEvidenceBook;
  S.loadTrainingTab = loadTrainingTab;
  S.seedTrainingEvidenceBook = seedTrainingEvidenceBook;
})(window.SocraticAI);
