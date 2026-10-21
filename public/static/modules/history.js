// SocraticAI v35 — Unified Sparring + Training history
(function initializeHistoryModule(S) {
  const { State, getEl, setDisplay, setText, api, apiGet, apiDelete, showToast, esc, escapeAttribute } = S;
  let sessionToDelete = null;
  let detailRequest = 0;
  let listRequest = 0;
  let detailReturnFocus = null;
  let detailInert = [];

  function showHistoryDialog(trigger) {
    const dialog = getEl('history-detail-modal');
    if (!dialog) return;
    if (!detailInert.length) {
      detailReturnFocus = trigger instanceof HTMLElement ? trigger : null;
      let branch = dialog;
      while (branch.parentElement && branch.parentElement !== document.documentElement) {
        for (const sibling of branch.parentElement.children) {
          if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
          detailInert.push({ node: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
        branch = branch.parentElement;
      }
    }
    setDisplay('history-detail-modal', 'flex');
    document.documentElement.classList.add('history-detail-open');
    document.body.classList.add('history-detail-open');
    (getEl('history-detail-title') || dialog).focus();
  }

  document.addEventListener('keydown', (event) => {
    const dialog = getEl('history-detail-modal');
    if (!dialog || dialog.style.display === 'none' || !detailInert.length) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeHistoryDetail();
    } else if (event.key === 'Tab') {
      const items = [...dialog.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')]
        .filter(node => node instanceof HTMLElement && node.checkVisibility({ visibilityProperty: true }) && !node.closest('[inert]'));
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog || document.activeElement === getEl('history-detail-title') || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
  });

  function finiteNumber(value) {
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'object' || (typeof value === 'string' && value.trim() === '')) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatScore(value) {
    const score = finiteNumber(value);
    return score === null ? '—' : `${score}%`;
  }

  function formatProgress(value, fallback = 'No record') {
    const number = finiteNumber(value);
    return number === null ? fallback : String(number);
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown date';
    return date.toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function statusBadge(value) {
    if (value === true || value === 1) return '<span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Complete</span>';
    if (value === false || value === 0) return '<span class="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">In progress</span>';
    return '<span class="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">Unknown</span>';
  }

  function sessionTypeLabel(session) {
    if (session.type === 'training') {
      if (session.mode === 'evidence') return '훈련 · 근거 기반';
      if (session.mode === 'constructed') return `훈련 · 구성 시나리오${session.origin === 'legacy_scenario' ? ' · 이전 방식' : ''}`;
      return '훈련 · 유형 미상';
    }
    if (session.type === 'sparring') return '도서 스파링';
    return '세션 유형 미상';
  }

  function ratingLabel(session) {
    if (typeof session.rating === 'string' && session.rating.trim() !== '') return session.rating;
    return session.origin === 'legacy_scenario' ? 'Unknown' : 'No record';
  }

  function renderHistoryState(list, status, message, retry = false) {
    const panel = document.createElement('div');
    panel.className = 'text-center py-12 text-gray-400';
    const description = document.createElement('p');
    description.textContent = `${status} — ${message}`;
    panel.appendChild(description);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-secondary mt-4';
      button.textContent = 'Retry';
      button.addEventListener('click', loadHistory);
      panel.appendChild(button);
    }
    list.replaceChildren(panel);
  }

  function renderSessionCard(session) {
    const date = formatDate(session.createdAt);
    const status = statusBadge(session.isCompleted);
    const mode = sessionTypeLabel(session);
    const score = formatScore(session.avgLogic);
    const title = session.bookTitle || session.topic || '세션';
    const actions = [
      `<button type="button" data-history-action="detail" data-session-id="${escapeAttribute(session.id)}" data-session-type="${escapeAttribute(session.type)}" class="btn-secondary text-xs flex-1"><i class="fas fa-eye mr-1" aria-hidden="true"></i>상세</button>`,
    ];
    if (session.canResume) {
      actions.push(`<button type="button" data-history-action="resume" data-session-id="${escapeAttribute(session.id)}" data-session-type="${escapeAttribute(session.type)}" class="btn-primary text-xs flex-1"><i class="fas fa-play mr-1" aria-hidden="true"></i>이어하기</button>`);
    }
    if (session.canDelete) {
      actions.push(`<button type="button" data-history-action="delete" data-session-id="${escapeAttribute(session.id)}" data-session-type="${escapeAttribute(session.type)}" data-session-title="${escapeAttribute(title)}" class="text-red-400 hover:text-red-600 text-xs px-2" aria-label="${escapeAttribute(`${title} 삭제`)}"><i class="fas fa-trash" aria-hidden="true"></i></button>`);
    }
    const type = typeof session.type === 'string' && session.type.trim() !== '' ? session.type : 'unknown';
    const progress = `${formatProgress(session.currentTurn)}/${formatProgress(session.maxTurns)}`;
    return `<article class="history-card" data-session-type="${escapeAttribute(type)}"><div class="flex items-center justify-between mb-2"><div class="flex-1 min-w-0 mr-4"><h4 class="font-bold text-gray-900 truncate">${esc(title)}</h4><p class="text-xs text-gray-500 mt-0.5">${esc(date)} · ${esc(mode)}</p></div><div class="flex items-center gap-2">${status}<span class="text-sm font-bold text-primary-500">${esc(score)}</span></div></div><div class="flex items-center gap-3 text-xs text-gray-500"><span>${esc(progress)}회차</span><span class="font-bold text-primary-500">${esc(ratingLabel(session))}</span></div><div class="flex gap-2 mt-3">${actions.join('')}</div></article>`;
  }

  async function loadHistory() {
    const request = ++listRequest;
    const list = getEl('history-list');
    if (!list) return;
    renderHistoryState(list, 'Unknown', '세션 기록을 불러오는 중입니다.');
    try {
      const data = await apiGet('/api/sessions');
      if (request !== listRequest) return;
      if (!data || typeof data !== 'object' || !Array.isArray(data.sessions)) {
        renderHistoryState(list, 'Unknown', '세션 기록 응답 형식을 확인할 수 없습니다.', true);
        return;
      }
      if (data.sessions.length === 0) {
        renderHistoryState(list, 'No record', '저장된 세션 기록이 없습니다.');
        return;
      }
      list.innerHTML = data.sessions.map(renderSessionCard).join('');
      list.querySelectorAll('[data-history-action]').forEach((button) => {
        button.addEventListener('click', () => {
          const action = button.dataset.historyAction;
          if (action === 'detail') viewHistoryDetail(button.dataset.sessionId, button.dataset.sessionType);
          if (action === 'resume') resumeSession(button.dataset.sessionId, button.dataset.sessionType);
          if (action === 'delete') deleteSession(button.dataset.sessionId, button.dataset.sessionTitle, button.dataset.sessionType);
        });
      });
    } catch (error) {
      if (request !== listRequest) return;
      renderHistoryState(list, 'Unavailable', '세션 기록을 불러오지 못했습니다.', true);
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function resumeSession(sessionId, sessionType) {
    if (sessionType === 'training') {
      await window.switchTab('training');
      await window.resumeTrainingSession?.(sessionId);
      return;
    }

    window.invalidateSparringRequests?.();
    let requestVersion = State.sparringRequestVersion;
    try {
      S.setSparringState('resuming');
      const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {});
      if (requestVersion !== State.sparringRequestVersion) return false;
      const session = data.session;
      if (!session) throw new Error('세션 데이터를 찾을 수 없습니다.');
      S.resetSparringState({ preserveSelectedBook: true });
      requestVersion = State.sparringRequestVersion;
      S.setSparringState('resuming');
      const radarKeys = ['defense', 'consistency', 'evidence', 'relevance', 'clarity'];
      const hasMeasuredRadar = session.evaluationStatus === 'MEASURED'
        && session.radarScores && radarKeys.every((key) => {
          const score = finiteNumber(session.radarScores[key]);
          return score !== null && score >= 20 && score <= 100;
        });
      const measuredAverage = finiteNumber(session.avgLogic);
      const hasMeasuredEvaluation = hasMeasuredRadar
        && measuredAverage !== null && measuredAverage >= 20 && measuredAverage <= 100
        && typeof session.rating === 'string' && session.rating !== 'UNKNOWN';
      if(State.sessionId!==sessionId)window.resetSparringRevisions?.();
      State.sessionId = sessionId;
      State.topic = session.topic || '';
      State.coreClaim = session.coreClaim || '';
      State.currentClaim = session.currentClaim || '';
      State.radarScores = hasMeasuredEvaluation ? { ...session.radarScores } : null;
      State.currentTurn = finiteNumber(session.currentTurn) ?? 1;
      State.currentPhase = session.currentPhase || 'elicitation';
      State.hintLevel = finiteNumber(session.hintLevel) ?? 0;
      State.isSessionActive = true;
      State.selectedBookId = session.bookId || State.selectedBookId;
      localStorage.setItem('sat_active_session', sessionId);
      await window.switchTab('sparring');
      if (requestVersion !== State.sparringRequestVersion || State.sessionId !== sessionId) return false;
      setDisplay('welcome-state', 'none');
      setDisplay('sub-header', 'flex');
      setDisplay('input-bar', 'block');
      setDisplay('dashboard-sidebar', 'block');
      setDisplay('mobile-dash-btn', '');
      if (session.bookTitle) getEl('sub-book-info').textContent = session.bookTitle;
      if (session.topic) getEl('dash-topic').textContent = session.topic;
      setText('dash-claim', State.currentClaim || State.coreClaim || '아직 주장이 제출되지 않았습니다.');
      setText('dash-avg-logic', hasMeasuredEvaluation ? `${measuredAverage}%` : 'No record');
      setText('dash-rating', hasMeasuredEvaluation ? session.rating : 'UNKNOWN');
      setText('dash-pace', 'No record');
      setText('dash-cred-level', 'UNKNOWN');
      setText('dash-cred-tier', ' —');
      window.initRadarChart?.(hasMeasuredEvaluation ? State.radarScores : null);
      const chat = getEl('chat-messages');
      if (chat) chat.innerHTML = '';
      (session.conversationHistory || []).forEach((message) => {
        const role = message.role === 'student' || message.role === 'user' ? 'user' : 'ai';
        window.addMessage?.(role, message.content, finiteNumber(message.turn) ?? finiteNumber(message.turnNumber));
      });
      (session.attributions || []).forEach((attribution) => window.renderAttribution?.(attribution));
      (data.hintResponses || []).forEach(hint => window.addSystemMessage?.(`${hint.turnNumber}번째 답변 전 저장된 도움: ${hint.hintMessage}`));
      if(data.hintHistoryStatus === 'UNAVAILABLE') window.addSystemMessage?.('저장된 도움을 현재 불러올 수 없습니다. 도움을 받지 않았다는 뜻은 아닙니다.');
      window.renderSparringFollowUpNotice?.(data.growthFollowUp || null);
      S.setSparringState('active');
      window.renderSparringControl?.(data.controls);
      window.renderSparringRevisions?.(data.revisions);
      showToast(data.controls?.state === 'ACTIVE' ? '세션을 이어서 진행합니다.' : '저장된 대화와 휴식·종료 상태를 불러왔습니다.', 'success');
      return true;
    } catch (error) {
      if (requestVersion !== State.sparringRequestVersion) return false;
      S.setSparringState('idle');
      showToast(error instanceof Error ? error.message : String(error), 'error');
      return false;
    }
  }

  function deleteSession(sessionId, title, sessionType = 'sparring') {
    sessionToDelete = { id: sessionId, type: sessionType };
    const label = getEl('delete-session-title');
    if (label) label.textContent = title || '세션';
    setDisplay('delete-session-modal', 'flex');
  }

  function closeDeleteDialog() {
    setDisplay('delete-session-modal', 'none');
    sessionToDelete = null;
  }

  async function confirmDeleteSession() {
    if (!sessionToDelete) return;
    try {
      const path = sessionToDelete.type === 'training'
        ? `/api/training/session/${encodeURIComponent(sessionToDelete.id)}`
        : `/api/sessions/${encodeURIComponent(sessionToDelete.id)}`;
      await apiDelete(path);
      showToast('세션이 삭제되었습니다.', 'success');
      closeDeleteDialog();
      await loadHistory();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function viewHistoryDetail(sessionId, sessionType) {
    const request = ++detailRequest;
    const trigger = document.activeElement;
    try {
      const data = sessionType === 'training'
        ? await apiGet(`/api/training/session/${encodeURIComponent(sessionId)}`)
        : await apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/report`);
      if (request !== detailRequest) return;
      const messages = sessionType === 'training'
        ? (data.messages || [])
        : (data.session?.conversationHistory || []);
      const body = getEl('history-detail-body');
      if (!body) return;
      const attributions = data.attributions || [];
      const attributionCard = (attribution) => {
        const label = attribution.status === 'cited' ? '검증된 출처' : attribution.status === 'uncited' ? '출처 미인용' : '출처 확인 불가';
        const sources = (attribution.sources || []).map((source) => { const location = [source.chunkIndex === null || source.chunkIndex === undefined ? '' : 'chunk '+source.chunkIndex, source.charStart === null || source.charStart === undefined ? '' : source.charStart+'–'+(source.charEnd ?? '?')].filter(Boolean).join(' · '); return '<div class="mt-2 rounded-lg border border-gray-200 bg-white p-2"><p class="text-xs font-bold text-gray-800">'+esc(source.bookTitle || '제목 미상')+(source.bookAuthor ? ' · '+esc(source.bookAuthor) : '')+'</p><p class="mt-1 text-[10px] text-gray-500">'+esc(location)+' · '+esc(source.lifecycleBadge || 'unknown')+'</p><p class="mt-1 whitespace-pre-wrap text-xs text-gray-700">'+esc(source.passage || '')+'</p><p class="text-[10px] text-gray-400">sha256 '+esc(String(source.contentSha256 || '').slice(0,16))+'…</p></div>'; }).join('');
        return '<section class="rounded-xl border border-gray-200 bg-gray-50 p-3"><p class="text-xs font-bold text-gray-700">학습자 출처 기록 · Turn '+esc(String(attribution.turnNumber))+' · '+esc(label)+'</p><p class="mt-1 text-xs text-gray-600">주장: '+esc(attribution.claim || '')+'</p>'+(sources || '<p class="mt-1 text-xs text-gray-500">'+esc(attribution.unavailableReason || '검증 가능한 출처가 없습니다.')+'</p>')+'</section>';
      };
      const byTurn = new Map();
      attributions.forEach((attribution) => byTurn.set(String(attribution.turnNumber), [...(byTurn.get(String(attribution.turnNumber)) || []), attribution]));
      const turns = new Set(messages.filter(message => ['user','student'].includes(message.role))
        .map(message => finiteNumber(message.turn) ?? finiteNumber(message.turnNumber)).filter(turn => turn !== null));
      const linked = new Map(), unmatched = [];
      const attach = (turn, html) => {
        if (turn !== null && turns.has(turn)) linked.set(turn, [...(linked.get(turn) || []), html]);
        else unmatched.push(html);
      };
      const trainingHistory = sessionType === 'training' && data.trainingHistory && typeof data.trainingHistory === 'object' ? data.trainingHistory : null;
      const heldOutAttempt = sessionType === 'training' && data.heldOutAttempt && typeof data.heldOutAttempt === 'object' ? data.heldOutAttempt : null;
      if (sessionType === 'training') {
        for (const support of trainingHistory?.support?.records || []) {
          const prior = finiteNumber(support.priorTurn?.turnNumber);
          const nextTurn = finiteNumber(support.answerTurn?.turnNumber);
          const next = nextTurn !== null && turns.has(nextTurn)
            ? `<a href="#history-turn-${nextTurn}">${nextTurn}번째 수락된 후속 답변으로</a>`
            : nextTurn === null ? '연결된 후속 답변 없음' : '연결된 후속 답변을 이 기록에서 확인할 수 없습니다.';
          const sources = (support.sourceSnapshots || []).map(source => `<p class="whitespace-pre-wrap">${esc(source.excerpt || '')}</p>`).join('');
          attach(prior, `<section class="history-linked-record" data-history-record="training-help"><h3>앱이 저장한 도움 · 채점 제외</h3><p>${esc(formatDate(support.createdAt))} · 실제 열람 여부는 확인되지 않음 · 실제 전달 여부도 확인되지 않음</p><p class="whitespace-pre-wrap">${esc(String(support.response || '').replace(/\s*\[SOURCE_ID=[^\]]+\]/g, ''))}</p><p>${next}</p><details><summary>도움에 연결된 저장 근거</summary>${sources || '<p>저장된 근거 내용을 현재 확인할 수 없습니다.</p>'}</details></section>`);
        }
        for (const revision of trainingHistory?.revisions?.records || []) {
          const prior = finiteNumber(revision.priorTurn?.turnNumber);
          const consumed = finiteNumber(revision.consumedFollowUpTurn?.turnNumber);
          const next = consumed !== null && turns.has(consumed)
            ? `<a href="#history-turn-${consumed}">${consumed}번째 수락된 후속 답변으로</a>`
            : consumed === null ? '연결된 후속 답변 없음' : '연결된 후속 답변을 이 기록에서 확인할 수 없습니다.';
          attach(prior, `<section class="history-linked-record" data-history-record="training-revision"><h3>이 답변에 연결된 내 생각 수정 · 검증되지 않음</h3><p>${esc(formatDate(revision.createdAt))}</p><p class="whitespace-pre-wrap">이전 생각: ${esc(revision.priorStatement || '')}</p><p class="whitespace-pre-wrap">내가 수정한 생각: ${esc(revision.revisedStatement || '')}</p><p class="whitespace-pre-wrap">생각을 바꾼 이유: ${esc(revision.explanation || '')}</p><p>${next}</p><p>연결은 수정의 타당성이나 학습 효과를 증명하지 않습니다.</p></section>`);
        }
      } else {
        for (const hint of data.hintResponses || []) {
          const before = finiteNumber(hint.turnNumber);
          const sources = (hint.sources || []).map(source => `<p class="whitespace-pre-wrap">${esc(source.excerpt)}</p>`).join('');
          attach(before === null ? null : before - 1,
            `<section class="history-linked-record" data-history-record="help"><h3>${esc(before === null ? '답변 차례 확인 불가' : `${before}번째 답변 전`)} · 앱이 저장한 도움 · 채점 제외</h3><p>${esc(formatDate(hint.createdAt))} · 실제 열람 여부는 확인되지 않음</p><p class="whitespace-pre-wrap">${esc(String(hint.hintMessage || '').replace(/\s*\[SOURCE_ID=[^\]]+\]/g, ''))}</p><details><summary>도움에 연결된 저장 근거</summary>${sources || '<p>저장된 근거 내용을 현재 확인할 수 없습니다.</p>'}</details></section>`);
        }
        for (const revision of data.revisions?.history || []) {
          const prior = finiteNumber(revision.priorTurn);
          const consumed = finiteNumber(revision.consumedByTurn);
          const next = consumed !== null && turns.has(consumed)
            ? `<a href="#history-turn-${consumed}">${consumed}번째 수락된 후속 답변으로</a>`
            : consumed === null ? '연결된 후속 답변 없음' : '연결된 후속 답변을 이 기록에서 확인할 수 없습니다.';
          attach(prior, `<section class="history-linked-record" data-history-record="revision"><h3>이 답변에 연결된 내 생각 수정 · 검증되지 않음</h3><p>${esc(formatDate(revision.createdAt))}</p><p class="whitespace-pre-wrap">이전 생각: ${esc(revision.priorStatement || '')}</p><p class="whitespace-pre-wrap">내가 수정한 생각: ${esc(revision.revisedStatement || '')}</p><p class="whitespace-pre-wrap">생각을 바꾼 이유: ${esc(revision.explanation || '')}</p><p>${next}</p><p>연결은 수정의 타당성이나 학습 효과를 증명하지 않습니다.</p></section>`);
        }
      }
      const lastIndex = new Map();
      messages.forEach((message,index) => lastIndex.set(finiteNumber(message.turn) ?? finiteNumber(message.turnNumber),index));
      const controlCopy = sessionType === 'training'
        ? `<section><h3>휴식·도움·종료 기록</h3><p>${esc(({ACTIVE:'진행 중',PAUSED:'잠시 쉬는 중',STOPPED:'내 선택으로 종료 · 실패로 평가하지 않음',COMPLETED:'완료'})[trainingHistory?.controls?.state] || '제어 기록을 현재 불러올 수 없습니다.')}</p>${(trainingHistory?.controls?.records || []).map(event=>`<p>${esc(formatDate(event.timestamp))} · ${esc(String(event.revision))} · ${event.origin==='POLICY'?'앱 정책 기록 · ':'내 요청 · '}${esc(({HELP:'도움 요청',PAUSE:'잠시 멈춤',RESUME:'다시 시작',STOP:'내 선택으로 종료 · 실패로 평가하지 않음'})[event.action] || '기록 확인 필요')} · ${esc(String(event.reason || '사유 확인 필요'))}</p>`).join('')}</section>`
        : `<section><h3>휴식·종료 기록</h3><p>${esc(({ACTIVE:'진행 중',PAUSED:'잠시 쉬는 중',STOPPED:'내 선택으로 종료 · 실패로 평가하지 않음',COMPLETED:'완료',ABANDONED:'종료됨'})[data.controls?.state] || '대화 상태를 확인할 수 없습니다.')}</p>${(data.controls?.history || []).map(event=>`<p>${esc(String(event.revision))} · ${event.origin==='POLICY'?'추론·근거 관찰에 따른 제안 · ':''}${esc(({PAUSE:'잠시 멈춤',RESUME:'다시 시작',STOP:'내 선택으로 종료'})[event.action] || '기록 확인 필요')}</p>`).join('')}</section>`;
      body.innerHTML = '<div class="space-y-3">' + messages.map((message,index) => {
        const isAI = message.role === 'ai' || message.role === 'assistant';
        const isLearner = message.role === 'user' || message.role === 'student';
        const messageTurn = finiteNumber(message.turn) ?? finiteNumber(message.turnNumber);
        const cards = isLearner && messageTurn !== null ? (byTurn.get(String(messageTurn)) || []).map(attributionCard).join('') : '';
        const identity = isLearner && messageTurn !== null ? ` id="history-turn-${messageTurn}" tabindex="-1" data-history-turn="${messageTurn}"` : '';
        const speaker = isAI ? '앱의 질문·응답' : isLearner ? '내가 쓴 답변' : '화자 확인 필요';
        const supplements = lastIndex.get(messageTurn) === index ? (linked.get(messageTurn) || []).join('') : '';
        return `<section${identity} class="history-message"><h3>${speaker}${messageTurn === null ? '' : messageTurn === 0 ? ' · 대화 시작' : ` · ${messageTurn}번째`}</h3><p class="whitespace-pre-wrap">${esc(message.content)}</p>${cards}</section>${supplements}`;
      }).join('') + '</div>';
      if (sessionType === 'training' && heldOutAttempt?.status === 'AVAILABLE' && heldOutAttempt.attempt) {
        const attempt = heldOutAttempt.attempt;
        const stateCopy = ({ ARMED: '열기 전', IN_PROGRESS: '작성 중', SUBMITTED: '제출됨', ABANDONED: '내 선택으로 멈춤', QUARANTINED: '격리됨', UNAVAILABLE: '현재 확인할 수 없음' })[attempt.state] || '현재 확인할 수 없음';
        const task = attempt.taskText ? `<p class="whitespace-pre-wrap">문제: ${esc(attempt.taskText)}</p>` : '<p>문제는 내가 명시적으로 열기 전에는 표시되지 않습니다.</p>';
        const response = attempt.response !== undefined && attempt.response !== null ? `<p class="whitespace-pre-wrap">내 응답: ${esc(attempt.response)}</p><p>응답 해시: ${esc(attempt.responseHash || 'UNKNOWN')}</p>` : '';
        const unavailable = attempt.state === 'QUARANTINED' ? '<p>문제 또는 노출 경계를 확인하지 못해 이 시도는 격리되었습니다. 실패나 점수로 바꾸지 않습니다.</p>' : attempt.state === 'ABANDONED' ? '<p>내가 멈춘 기록입니다. 실패나 0점으로 평가하지 않습니다.</p>' : '';
        body.insertAdjacentHTML('beforeend', `<section class="history-linked-record" data-history-record="training-heldout"><h3>M4 즉시 무지원 응답</h3><p>${esc(attempt.opaqueVariantId || 'opaque variant')} · ${esc(stateCopy)}</p><p>평가 결과는 UNKNOWN입니다. 제출은 응답 기록만 뜻하며 점수·학습·숙달을 뜻하지 않습니다.</p>${task}${response}${unavailable}</section>`);
      } else if (sessionType === 'training' && heldOutAttempt?.status === 'UNAVAILABLE') {
        body.insertAdjacentHTML('beforeend', '<p>M4 즉시 무지원 응답 기록을 현재 불러올 수 없습니다. 기록이 없다는 뜻은 아닙니다.</p>');
      }
      if (unmatched.length) body.insertAdjacentHTML('beforeend', `<section><h3>원본 답변 위치를 확인할 수 없는 연결 기록</h3><p>기록을 보존하되 답변 차례를 임의로 정하지 않습니다.</p>${unmatched.join('')}</section>`);
      if (data.hintHistoryStatus === 'UNAVAILABLE') body.insertAdjacentHTML('beforeend','<p>저장된 도움을 현재 불러올 수 없습니다. 도움을 받지 않았다는 뜻은 아닙니다.</p>');
      if (sessionType !== 'training' && data.revisions?.status !== 'AVAILABLE') body.insertAdjacentHTML('beforeend','<p>수정 기록을 현재 확인할 수 없습니다. 기록이 없다는 뜻은 아닙니다.</p>');
      if (sessionType === 'training' && !trainingHistory) body.insertAdjacentHTML('beforeend','<p>훈련의 도움·수정·제어 기록을 현재 불러올 수 없습니다. 기록이 없다는 뜻은 아닙니다.</p>');
      if (sessionType === 'training' && trainingHistory?.support?.status === 'PENDING') body.insertAdjacentHTML('beforeend','<p>도움 요청은 저장되어 있으나 앱의 지원 응답은 아직 저장되지 않았습니다. 전달·열람 여부는 확인되지 않음입니다.</p>');
      if (sessionType === 'training' && (trainingHistory?.status === 'UNAVAILABLE' || trainingHistory?.support?.status === 'UNAVAILABLE' || trainingHistory?.revisions?.status === 'UNAVAILABLE' || trainingHistory?.controls?.status === 'UNAVAILABLE')) body.insertAdjacentHTML('beforeend','<p>훈련의 도움·수정·제어 기록 일부를 현재 불러올 수 없습니다. 기록이 없다는 뜻은 아닙니다.</p>');
      if (sessionType === 'training' && trainingHistory?.revisions?.status === 'AVAILABLE' && trainingHistory.revisions.explicitDefenseStatus === 'NOT_RECORDED') body.insertAdjacentHTML('beforeend','<p>명시적으로 주장을 유지한다는 기록은 현재 저장되지 않았습니다.</p>');
      body.insertAdjacentHTML('beforeend',controlCopy);
      showHistoryDialog(trigger);
    } catch (error) {
      if (request !== detailRequest) return;
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function closeHistoryDetail(returnFocus = true) {
    ++detailRequest;
    const wasOpen = detailInert.length > 0;
    setDisplay('history-detail-modal', 'none');
    document.documentElement.classList.remove('history-detail-open');
    document.body.classList.remove('history-detail-open');
    getEl('history-detail-body')?.replaceChildren();
    for (const { node, inert } of detailInert) node.inert = inert;
    detailInert = [];
    const target = detailReturnFocus;
    detailReturnFocus = null;
    if (returnFocus && wasOpen && target?.isConnected && !target.closest('[inert]')) target.focus();
    else if (returnFocus && wasOpen) {
      const fallback = getEl('growth-cycle-title') || getEl('history-list');
      if (fallback && !fallback.closest('[inert]')) { fallback.tabIndex = -1; fallback.focus(); }
    }
  }

  function clearPrivateHistory() {
    ++listRequest;
    closeHistoryDetail(false);
    getEl('history-list')?.replaceChildren();
    closeDeleteDialog();
    const title = getEl('delete-session-title');
    if (title) title.textContent = '';
  }

  Object.assign(window, {
    loadHistory,
    resumeSession,
    deleteSession,
    closeDeleteDialog,
    confirmDeleteSession,
    viewHistoryDetail,
    closeHistoryDetail,
    clearPrivateHistory,
  });
  S.loadHistory = loadHistory;
  S.clearPrivateHistory = clearPrivateHistory;
})(window.SocraticAI);
