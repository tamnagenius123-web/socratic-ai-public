// SocraticAI v35 — Library-grounded Sparring module
(function initializeSparringModule(S) {
  const LEARNER_SAFE_SUBMIT_FAILURE = '답변을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.';

  const {
    State,
    getEl,
    setDisplay,
    setText,
    api,
    apiGet,
    showToast,
    esc,
    setSparringState,
    resetSparringState,
    initRadarChart,
    isAuthExpiryScreenVisible,
    focusLoginAfterAuthExpiry,
  } = S;

  let controlBusy = false;
  function invalidateSparringRequests() {
    State.sparringRequestVersion = (State.sparringRequestVersion || 0) + 1;
    State.isLoading = false;
    hideTyping();
  }
  function requestIdentity() { return {sessionId:State.sessionId,version:State.sparringRequestVersion || 0}; }
  function isCurrentRequest(request) { return request.sessionId === State.sessionId && request.version === (State.sparringRequestVersion || 0); }
  function isPolicyPause(control) {
    const latest=control?.history?.at(-1);
    return control?.state==='PAUSED' && latest?.origin==='POLICY' && latest?.policy_reason==='NON_PROGRESS';
  }
  function canRequestSparringHelp() { return State.sparringControl?.state==='ACTIVE' || isPolicyPause(State.sparringControl); }
  function renderSparringControl(value) {
    const valid = value && ['ACTIVE','PAUSED','STOPPED','COMPLETED','ABANDONED'].includes(value.state) && Number.isSafeInteger(value.revision) && value.revision >= 0;
    const control = valid ? value : {state:'UNAVAILABLE',revision:null,history:[]};
    if(State.sparringControl?.revision !== control.revision || State.sparringControl?.state !== control.state) invalidateSparringRequests();
    State.sparringControl = control;
    const inputBar = getEl('input-bar');
    if(!inputBar) return;
    let panel = getEl('sparring-controls');
    if(!panel) { panel=document.createElement('section');panel.id='sparring-controls';panel.className='mt-3 rounded-xl border border-primary-100 p-3';inputBar.appendChild(panel); }
    const previousReason=getEl('sparring-control-reason')?.value || 'LEARNER_REQUEST';
    panel.replaceChildren();
    const el=(tag,text)=>{const element=document.createElement(tag);if(text)element.textContent=text;return element;};
    const status=el('p',({ACTIVE:'대화를 진행할 수 있습니다.',PAUSED:'잠시 쉬는 중입니다. 다시 시작하기 전에는 답변과 도움을 생성하지 않습니다.',STOPPED:'내 선택으로 이번 대화를 마쳤습니다. 저장된 답변과 평가는 유지되며 종료를 실패로 평가하지 않습니다.',COMPLETED:'대화가 완료되었습니다.',ABANDONED:'종료된 대화입니다.',UNAVAILABLE:'대화 상태를 확인할 수 없어 새 답변을 잠시 멈췄습니다.'})[control.state]);
    if(isPolicyPause(control))status.textContent='최근 두 답변에서 추론과 근거를 연결하는 데 어려움이 있을 수 있어 질문을 잠시 멈췄습니다. 이는 확정된 진단이 아닙니다. 같은 주제의 근거 설명을 선택해 생각을 다시 구성하거나, 대화를 재개하거나 종료할 수 있습니다. 점수는 바뀌지 않습니다.';
    status.setAttribute('role','status');panel.append(el('h3','휴식과 대화 종료'),status);
    if(isPolicyPause(control)){
      const support=el('button','근거 설명으로 다시 구성하기');support.type='button';support.className='btn-secondary m-1';support.dataset.sparringPolicyHelp='true';
      support.disabled=State.isLoading||controlBusy;support.onclick=askForHint;panel.appendChild(support);
      panel.appendChild(el('p','설명은 내 요청으로만 제공됩니다. 같은 휴식에서는 저장된 설명을 다시 보여 줍니다. 설명을 읽어도 대화는 자동으로 재개되지 않습니다.'));
    }
    const label=el('label','쉬거나 종료하는 이유');label.htmlFor='sparring-control-reason';
    const reason=el('select');reason.id='sparring-control-reason';reason.className='rounded-lg border border-gray-200 p-2';
    for(const [value,text] of [['LEARNER_REQUEST','내 선택'],['DISTRESS','부담스럽거나 힘들어서'],['UNSAFE_ERROR','안전하지 않거나 잘못된 내용'],['TIME_LIMIT','시간 부족'],['INSUFFICIENT_EVIDENCE','근거 부족']]){const option=el('option',text);option.value=value;option.selected=value===previousReason;reason.appendChild(option);}
    panel.append(label,reason);
    for(const [action,text] of [['PAUSE','잠시 쉬기'],['RESUME','대화 다시 시작'],['STOP','이번 대화 종료']]){
      const button=el('button',text);button.type='button';button.className='btn-secondary m-1';button.dataset.sparringControl=action;
      button.disabled=controlBusy || !['ACTIVE','PAUSED'].includes(control.state) || (action==='RESUME'&&control.state!=='PAUSED') || (action==='PAUSE'&&control.state==='PAUSED');
      button.onclick=()=>changeSparringControl(action,reason.value);panel.appendChild(button);
    }
    if(control.state==='UNAVAILABLE'){const retry=el('button','상태 다시 확인');retry.type='button';retry.className='btn-secondary';retry.onclick=refreshSparringControl;panel.appendChild(retry);}
    if(control.history?.length){const history=el('details');history.appendChild(el('summary','휴식·종료 기록'));for(const event of control.history)history.appendChild(el('p',`${event.revision} · ${event.origin==='POLICY'?'추론·근거 관찰에 따른 제안 · ':''}${({PAUSE:'잠시 멈춤',RESUME:'다시 시작',STOP:'내 선택으로 종료'})[event.action] || '기록 확인 필요'}`));panel.appendChild(history);}
    const input=getEl('user-input');if(input)input.disabled=control.state!=='ACTIVE'||State.isLoading||controlBusy;
    const hint=getEl('sparring-hint-btn');if(hint)hint.disabled=!canRequestSparringHelp()||State.isLoading||controlBusy||State.currentTurn<2;
    setSubmitEnabled(Boolean(input?.value.trim()));
    window.updateSparringRevisionControls?.();
  }
  async function refreshSparringControl() {
    const request=requestIdentity();if(!request.sessionId)return;
    try { const control=await apiGet(`/api/sessions/${encodeURIComponent(request.sessionId)}/controls`);if(isCurrentRequest(request))renderSparringControl(control); }
    catch { if(isCurrentRequest(request))renderSparringControl(null); }
  }
  async function changeSparringControl(action,reason='LEARNER_REQUEST') {
    if(controlBusy || !State.sessionId || !Number.isSafeInteger(State.sparringControl?.revision))return;
    const sessionId=State.sessionId,revision=State.sparringControl.revision,draft=getEl('user-input')?.value || '',draftTurn=State.currentTurn;
    invalidateSparringRequests();const request=requestIdentity();controlBusy=true;renderSparringControl(State.sparringControl);
    try {
      const control=await api(`/api/sessions/${encodeURIComponent(sessionId)}/controls`,{action,reason,expectedRevision:revision,mutationKey:crypto.randomUUID()});
      if(!isCurrentRequest(request))return;
      renderSparringControl(control);
      const resumed=await window.resumeSession?.(sessionId,'sparring');
      if(resumed && State.sessionId===sessionId && State.messages.some(message=>message.role==='user'&&message.turn===draftTurn&&message.content===draft.trim())){const input=getEl('user-input');if(input?.value===draft)input.value='';}
    } catch(error) {
      if(isCurrentRequest(request)){await window.resumeSession?.(sessionId,'sparring');await refreshSparringControl();showToast('대화 상태를 다시 확인했습니다. 저장된 답변은 유지됩니다.','error');}
    } finally {controlBusy=false;renderSparringControl(State.sparringControl);}
  }

  function learnerSafeSubmitFailure(error) {
    const apiError = error && typeof error === 'object' ? error : null;
    const code = typeof apiError?.code === 'string' ? apiError.code : 'UNKNOWN_ERROR';
    const phase = typeof apiError?.phase === 'string' ? apiError.phase : 'unknown';
    const retryable = apiError?.retryable === true;
    const detail = typeof apiError?.payload?.error === 'string'
      ? apiError.payload.error
      : error instanceof Error && error.message
        ? error.message
        : LEARNER_SAFE_SUBMIT_FAILURE;
    const retryGuidance = retryable
      ? ' The same answer can be retried safely.'
      : ' This response is not marked retryable.';
    return `${detail}\nCode: ${code}\nPhase: ${phase}\nRetryable: ${retryable ? 'yes' : 'no'}.${retryGuidance}`;
  }

  function isRendered(element) {
    return element instanceof HTMLElement && !element.hidden && element.getClientRects().length > 0;
  }

  function focusStartedSessionDestination() {
    const input = getEl('user-input');
    if (isRendered(input) && !input.disabled) {
      input.focus();
      return document.activeElement === input;
    }

    const fallback = getEl('sub-header') || getEl('tab-sparring');
    if (!isRendered(fallback)) return false;
    const previousTabIndex = fallback.getAttribute('tabindex');
    if (previousTabIndex === null) fallback.tabIndex = -1;
    fallback.focus();
    if (previousTabIndex === null) {
      fallback.addEventListener('blur', () => fallback.removeAttribute('tabindex'), { once: true });
    }
    return document.activeElement === fallback;
  }

  function renderSparringGrowthAction() {
    const container = getEl('chat-messages');
    const attemptId = String(State.sessionId || '').trim();
    if (!container || !attemptId) return;
    container.querySelector('[data-sparring-growth-origin]')?.remove();
    const card = document.createElement('section');
    card.dataset.sparringGrowthOrigin = attemptId;
    card.className = 'fade-in rounded-xl border border-gray-200 bg-gray-50 p-4';
    const heading = document.createElement('h3');
    heading.className = 'text-sm font-bold text-gray-900';
    heading.textContent = '나의 성장 기록';
    const copy = document.createElement('p');
    copy.className = 'mt-1 text-xs text-gray-600';
    copy.textContent = '학습 기록을 비공개로 살펴봅니다. 점수나 약점의 타당성, 학습 효과는 아직 확인되지 않았습니다.';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn-primary mt-3';
    action.textContent = State.growthFollowUp ? '후속 시도 기록하러 가기' : '비공개 성장 기록 열기';
    action.setAttribute('aria-label', 'Open private Growth Cycle from this completed Sparring session');
    action.addEventListener('click', async () => {
      action.disabled = true;
      action.textContent = '성장 기록 여는 중…';
      const opened = State.growthFollowUp ? await S.openGrowthRecheck(State.growthFollowUp) : await S.openGrowthCycleFromOrigin?.({ originKind: 'SPARRING', originAttemptId: attemptId });
      if (!opened && document.body.contains(action)) {
        action.disabled = false;
        action.textContent = State.growthFollowUp ? '후속 시도 기록하러 가기' : '비공개 성장 기록 열기';
      }
    });
    card.append(heading, copy, action);
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
  }

  function renderSparringFollowUpNotice(link) {
    document.getElementById('sparring-follow-up-notice')?.remove();
    State.growthFollowUp = link || null;
    const container = getEl('chat-messages');
    if (!link || !container) return;
    const notice = document.createElement('section');
    notice.id = 'sparring-follow-up-notice';
    notice.className = 'growth-record-body';
    notice.setAttribute('aria-label', '후속 대화의 조건과 도움 기록');
    const heading = document.createElement('h3');
    heading.textContent = '조건을 바꾼 후속 대화';
    const condition = document.createElement('p');
    condition.textContent = link.changedCondition || '';
    const limits = document.createElement('p');
    limits.textContent = '이 조건은 학습자가 정한 가정입니다. 이 재확인의 비교 자료에는 답변·평가 수와 힌트 요청 합계만 포함됩니다. 저장된 도움은 대화 기록에서 확인할 수 있으며, 휴식·종료 기록은 대화에서 확인할 수 있지만 이 비교 자료에는 아직 포함되지 않습니다. 외부 도움, 학습 효과와 전이 여부는 UNKNOWN입니다.';
    const back = document.createElement('button');
    back.type = 'button'; back.className = 'growth-button growth-button-secondary';
    back.textContent = '성장 재확인으로 돌아가기';
    back.addEventListener('click', async () => { try { await S.openGrowthRecheck(link); } catch { showToast('성장 재확인 기록을 열지 못했습니다. 다시 시도해 주세요.', 'error'); } });
    notice.append(heading, condition, limits, back);
    container.prepend(notice);
  }

  async function startSparringFollowUp(launch) {
    if (!launch || typeof launch.launchId !== 'string' || !launch.launchId) throw new Error('후속 대화 시작 정보를 확인할 수 없습니다.');
    return startSession(null, launch.launchId);
  }

  async function startSession(bookId, followUpLaunchId) {
    const selectedBookId = bookId || State.selectedBookId;
    if (!selectedBookId && !followUpLaunchId) return showToast('도서를 선택하세요.', 'error');
    resetSparringState({ preserveSelectedBook: true });
    setText('dash-avg-logic', 'No record');
    setText('dash-rating', 'UNKNOWN');
    setText('dash-pace', 'No record');
    setText('dash-cred-level', 'UNKNOWN');
    setText('dash-cred-tier', ' —');
    initRadarChart(null);
    setSparringState('starting');
    const startVersion = State.sparringRequestVersion;
    try {
      const response = await api('/api/session/start', followUpLaunchId ? { growthFollowUpLaunchId: followUpLaunchId } : {
        bookId: selectedBookId,
        startMode: State.sparringStartMode,
      });
      if (startVersion !== State.sparringRequestVersion) return;
      if (response.resumed && typeof window.resumeSession === 'function') return window.resumeSession(response.sessionId, 'sparring');
      State.sessionId = response.sessionId;
      State.topic = response.topic || '';
      State.currentTurn = 1;
      if (response.coreClaim) State.coreClaim = response.coreClaim;
      setSparringState('active');
      State.isSessionActive = true;
      localStorage.setItem('sat_active_session', response.sessionId);
      setDisplay('welcome-state', 'none');
      setDisplay('sub-header', 'flex');
      setDisplay('input-bar', 'block');
      setDisplay('dashboard-sidebar', 'block');
      setDisplay('mobile-dash-btn', '');
      if (response.bookTitle) setText('sub-book-info', response.bookTitle);
      if (response.topic) setText('dash-topic', response.topic);
      initRadarChart(null);
      if (response.openingMessage) addMessage('ai', response.openingMessage, 0);
      renderSparringFollowUpNotice(response.growthFollowUp || null);
      await refreshSparringControl();
      await window.refreshSparringRevisions?.();
      focusStartedSessionDestination();
      showToast('도서 근거 세션이 시작되었습니다.', 'success');
    } catch (error) {
      if (startVersion !== State.sparringRequestVersion) return;
      setSparringState('idle');
      State.isSessionActive = false;
      if (isAuthExpiryScreenVisible()) {
        focusLoginAfterAuthExpiry();
        return;
      }
      showToast(error instanceof Error ? error.message : String(error), 'error');
      if (followUpLaunchId) throw error;
    }
  }

  async function submitMessage() {
    const input = getEl('user-input');
    const message = input ? input.value.trim() : '';
    if (!message || State.isLoading || !State.sessionId || controlBusy || State.sparringControl?.state !== 'ACTIVE') return;
    const request = requestIdentity(), submittedTurn = State.currentTurn;
    State.isLoading = true;
    const button = getEl('submit-btn');
    if (button) button.disabled = true;
    renderSparringControl(State.sparringControl);
    showTyping();
    try {
      const data = await api('/api/chat', { sessionId: request.sessionId, message });
      if (!isCurrentRequest(request)) return;
      addMessage('user', message, submittedTurn);
      if (input?.value.trim() === message) input.value = '';
      hideTyping();
      // The persisted attribution records the evaluated learner turn, whereas
      // currentTurn is the next prompt. Keep its feedback bubble on that same
      // canonical evaluated turn so the card follows the tutor feedback.
      const feedbackTurn = Number(data.attribution?.turnNumber ?? State.currentTurn);
      const turn = Number(data.session?.currentTurn || State.currentTurn + 1);
      if (data.aiReply) addMessage('ai', data.aiReply, feedbackTurn, data.dialogueAct);
      renderAttribution(data.attribution);
      State.currentTurn = turn;
      await window.refreshSparringRevisions?.();
      if(!isCurrentRequest(request))return;
      window.updateDashboard?.(data);
      if (data.isSessionEnd) {
        showToast('세션이 종료되었습니다.', 'success');
        setSparringState('completed');
        await refreshSparringControl();
        if(State.sessionId!==request.sessionId)return;
        window.updateSparringRevisionControls?.();
        setDisplay('input-bar', 'none');
        localStorage.removeItem('sat_active_session');
        renderSparringGrowthAction();
        const report = data.sessionReport || data.report;
        if (report) window.showSessionReport?.(report);
        if (data.deepReportStatus === 'processing') {
          window.startDeepReportPolling?.(State.sessionId);
        }
        if (data.reportStatus === 'unavailable') {
          showToast('세션은 저장되었지만 성장 리포트는 현재 사용할 수 없습니다.', 'info');
        }
      }
    } catch (error) {
      if (!isCurrentRequest(request)) return;
      hideTyping();
      if (['SPARRING_TURN_CONFLICT','SPARRING_CONTROL_CONFLICT','SPARRING_REVISION_CONFLICT','SPARRING_PAUSED','SPARRING_STOPPED'].includes(error?.code)) {
        const resumed = await window.resumeSession?.(request.sessionId, 'sparring');
        if (resumed && State.sessionId === request.sessionId && State.messages.some(item => item.role === 'user' && item.turn === submittedTurn && item.content === message) && input?.value.trim() === message) input.value = '';
        setSubmitEnabled(Boolean(input?.value.trim()));
        showToast('저장된 대화와 현재 상태를 다시 불러왔습니다.', 'info');
        return;
      }
      const failureMessage = learnerSafeSubmitFailure(error);
      if (getEl('chat-messages')) {
        addSystemMessage(failureMessage);
      } else {
        showToast(failureMessage, 'error');
      }
    } finally {
      if (isCurrentRequest(request)) {
        State.isLoading = false;
        hideTyping();
        renderSparringControl(State.sparringControl);
      }
    }
  }

  let pendingHintRequest = null;
  async function askForHint() {
    if (!State.sessionId || State.isLoading || controlBusy || !canRequestSparringHelp()) return;
    const request = requestIdentity();
    State.isLoading = true;
    renderSparringControl(State.sparringControl);
    showTyping();
    try {
      if (!pendingHintRequest || pendingHintRequest.sessionId !== State.sessionId || pendingHintRequest.turnNumber !== State.currentTurn || pendingHintRequest.controlRevision !== State.sparringControl?.revision) pendingHintRequest = {sessionId:State.sessionId,turnNumber:State.currentTurn,controlRevision:State.sparringControl?.revision,mutationKey:crypto.randomUUID()};
      const data = await api('/api/hint', { sessionId: State.sessionId, mutationKey:pendingHintRequest.mutationKey, expectedTurn:pendingHintRequest.turnNumber });
      if (!isCurrentRequest(request)) return;
      pendingHintRequest = null;
      hideTyping();
      if (data.hintMessage) {
        addSystemMessage(`힌트 H${data.hintLevel}: ${data.hintMessage}`);
        State.hintLevel = Number(data.hintLevel || 0);
        setText('hint-level-display', `Lv.${State.hintLevel}`);
        await window.refreshSparringRevisions?.();
      }
    } catch (error) {
      if (!isCurrentRequest(request)) return;
      hideTyping();
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      if (isCurrentRequest(request)) {State.isLoading = false;hideTyping();renderSparringControl(State.sparringControl);}
    }
  }

  function addMessage(role, content, turn, dialogueAct) {
    const container = getEl('chat-messages');
    if (!container) return;
    const message = document.createElement('div');
    message.className = `fade-in flex ${role === 'user' ? 'justify-end' : 'justify-start'}`;
    message.dataset.socraticTurn = String(turn);
    const dialogueBadge = role === 'user' && dialogueAct
      ? `<span class="text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full ml-2">${esc(dialogueAct)}</span>`
      : '';
    if (role === 'ai') {
      message.innerHTML = `<div class="flex gap-3 max-w-[85%]"><div class="w-9 h-9 bg-primary-50 rounded-xl flex items-center justify-center flex-shrink-0 mt-1"><i class="fas fa-brain text-primary-500 text-sm" aria-hidden="true"></i></div><div class="bg-gradient-to-br from-primary-50 to-white border border-primary-100 rounded-2xl rounded-tl-md px-5 py-4"><p class="text-gray-800 text-sm leading-relaxed whitespace-pre-wrap">${esc(content)}</p></div></div>`;
    } else {
      message.innerHTML = `<div class="max-w-[75%]"><div class="bg-primary-500 text-white rounded-2xl rounded-tr-md px-5 py-4"><p class="text-sm leading-relaxed whitespace-pre-wrap">${esc(content)}</p>${dialogueBadge}</div></div>`;
    }
    container.appendChild(message);
    container.scrollTop = container.scrollHeight;
    State.messages.push({ role, content, turn });
  }

  function addSystemMessage(content) {
    const container = getEl('chat-messages');
    if (!container) return;
    const message = document.createElement('div');
    message.className = 'fade-in flex justify-center';
    const bubble = document.createElement('div');
    bubble.className = 'bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-sm text-amber-800 max-w-[80%]';
    bubble.textContent = content;
    message.appendChild(bubble);
    container.appendChild(message);
    container.scrollTop = container.scrollHeight;
  }

  function renderAttribution(attribution) {
    if (!attribution) return;
    const container = getEl('chat-messages');
    if (!container) return;
    const card = document.createElement('section');
    const status = attribution.status === 'cited' ? '검증된 출처' : attribution.status === 'uncited' ? '출처 미인용' : '출처 확인 불가';
    const sources = Array.isArray(attribution.sources) ? attribution.sources : [];
    const sourceCards = sources.map((source) => {
      const location = [source.chunkIndex === null || source.chunkIndex === undefined ? '' : 'chunk ' + source.chunkIndex, source.charStart === null || source.charStart === undefined ? '' : source.charStart + '–' + (source.charEnd ?? '?')].filter(Boolean).join(' · ');
      const lifecycle = source.lifecycleBadge === 'unknown' ? '상태 미상' : source.lifecycleBadge === 'deleted' ? '삭제됨' : source.lifecycleBadge === 'quarantined' ? '격리됨' : '활성';
      return '<article class="rounded-lg border border-gray-200 bg-white p-3"><p class="text-xs font-bold text-gray-800">'+esc(source.bookTitle || '제목 미상')+(source.bookAuthor ? ' · '+esc(source.bookAuthor) : '')+'</p><p class="mt-1 text-xs text-gray-500">'+esc(location)+' · '+esc(lifecycle)+'</p><p class="mt-2 whitespace-pre-wrap text-xs text-gray-700">'+esc(source.passage || '')+'</p><p class="mt-2 font-mono text-[10px] text-gray-400">sha256 '+esc(String(source.contentSha256 || '').slice(0, 16))+'…</p></article>';
    }).join('');
    card.className = 'fade-in ml-12 max-w-[85%] rounded-xl border border-gray-200 bg-gray-50 p-3';
    card.innerHTML = '<p class="text-xs font-bold text-gray-700">학습자 출처 기록 · Turn '+esc(String(attribution.turnNumber))+' · '+esc(status)+'</p><p class="mt-1 text-xs text-gray-600">주장: '+esc(attribution.claim || '')+'</p>' + (sourceCards || '<p class="mt-1 text-xs text-gray-500">'+esc(attribution.unavailableReason || '이 응답에는 검증 가능한 출처가 기록되지 않았습니다.')+'</p>');
    const anchors = [...container.querySelectorAll('[data-socratic-turn]')];
    const anchor = anchors.filter((item) => item.dataset.socraticTurn === String(attribution.turnNumber)).at(-1);
    if (anchor) anchor.after(card); else container.appendChild(card);
    container.scrollTop = container.scrollHeight;
  }

  function showTyping() {
    const container = getEl('chat-messages');
    if (!container || getEl('typing-bubble')) return;
    const typing = document.createElement('div');
    typing.id = 'typing-bubble';
    typing.className = 'fade-in flex justify-start';
    typing.innerHTML = '<div class="flex gap-3"><div class="w-9 h-9 bg-primary-50 rounded-xl flex items-center justify-center flex-shrink-0 mt-1"><i class="fas fa-brain text-primary-500 text-sm" aria-hidden="true"></i></div><div class="bg-gray-100 rounded-2xl rounded-tl-md px-5 py-4"><div class="typing-indicator flex gap-1.5" aria-label="AI가 응답을 작성 중입니다"><span class="w-2 h-2 bg-gray-400 rounded-full inline-block"></span><span class="w-2 h-2 bg-gray-400 rounded-full inline-block"></span><span class="w-2 h-2 bg-gray-400 rounded-full inline-block"></span></div></div></div>';
    container.appendChild(typing);
    container.scrollTop = container.scrollHeight;
  }

  function hideTyping() { getEl('typing-bubble')?.remove(); }

  function updatePhaseDisplay() {
    const phases = ['elicitation', 'grounding', 'reasoning', 'counterexample', 'revision', 'synthesis'];
    const currentIndex = Math.max(0, phases.indexOf(State.currentPhase));
    const progress = getEl('phase-progress-line');
    if (progress) progress.style.width = `${(currentIndex / (phases.length - 1)) * 100}%`;
    phases.forEach((phase, index) => {
      const dot = getEl(`dot-${phase}`);
      const label = getEl(`label-${phase}`);
      if (!dot || !label) return;
      dot.className = `phase-dot z-10 ${index < currentIndex ? 'completed' : index === currentIndex ? 'active' : 'upcoming'}`;
      label.className = index <= currentIndex ? 'text-[10px] font-bold text-gray-900' : 'text-[10px] text-gray-400';
    });
  }

  function handleInputKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitMessage();
    }
    setTimeout(() => setSubmitEnabled(event.target.value.trim().length > 0), 0);
  }

  function autoResizeTextarea(element) {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
    setSubmitEnabled(element.value.trim().length > 0);
  }

  function setSubmitEnabled(enabled) {
    const button = getEl('submit-btn');
    if (button) button.disabled = !enabled || State.isLoading || controlBusy || State.sparringControl?.state !== 'ACTIVE';
  }

  function setSparringStartMode(mode) {
    State.sparringStartMode = mode === 'deep_reading_question' ? 'deep_reading_question' : 'initial_claim';
    const initial = getEl('start-mode-initial');
    const deep = getEl('start-mode-deep');
    if (initial) initial.className = `w-full text-left px-3 py-2 rounded-lg border ${State.sparringStartMode === 'initial_claim' ? 'border-primary-300 bg-primary-50' : 'border-gray-200 bg-white hover:border-primary-200'}`;
    if (deep) deep.className = `w-full text-left px-3 py-2 rounded-lg border ${State.sparringStartMode === 'deep_reading_question' ? 'border-primary-300 bg-primary-50' : 'border-gray-200 bg-white hover:border-primary-200'}`;
  }

  Object.assign(window, {
    invalidateSparringRequests, renderSparringControl, refreshSparringControl, changeSparringControl,
    startSession,
    startSparringFollowUp,
    renderSparringFollowUpNotice,
    submitMessage,
    askForHint,
    addMessage,
    addSystemMessage,
    renderAttribution,
    showTyping,
    hideTyping,
    updatePhaseDisplay,
    handleInputKeydown,
    autoResizeTextarea,
    setSparringStartMode,
  });
  Object.assign(S, {
    invalidateSparringRequests, renderSparringControl, refreshSparringControl, changeSparringControl,
    startSession,
    startSparringFollowUp,
    renderSparringFollowUpNotice,
    setSparringStartMode,
    addMessage,
    addSystemMessage,
    renderAttribution,
    showTyping,
    hideTyping,
    updatePhaseDisplay,
  });
})(window.SocraticAI);
