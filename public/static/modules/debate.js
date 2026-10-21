// SocraticAI v28 — Debate Arena Module
(function(S) {
  const { State, getEl, setDisplay, api, apiGet, showToast, esc } = S;
  let activeDebateRoomId = null;
  const PENDING_TURN_STORAGE_PREFIX = 'socratic-debate-pending-turn:';
  const pendingTurns = new Map();

  function pendingTurnStorageKey(roomId) { return PENDING_TURN_STORAGE_PREFIX + roomId; }

  function isValidPendingTurn(value, roomId) {
    return value && value.roomId === roomId
      && typeof value.content === 'string' && value.content.length > 0
      && typeof value.turnMutationId === 'string'
      && /^debate-turn_[A-Za-z0-9-]+$/.test(value.turnMutationId)
      && value.turnMutationId.length <= 128;
  }

  function getPendingTurn(roomId) {
    if (pendingTurns.has(roomId)) return pendingTurns.get(roomId);
    try {
      const parsed = JSON.parse(sessionStorage.getItem(pendingTurnStorageKey(roomId)) || 'null');
      if (isValidPendingTurn(parsed, roomId)) {
        pendingTurns.set(roomId, parsed);
        return parsed;
      }
    } catch { /* Session storage is an optional recovery aid. */ }
    return null;
  }

  function storePendingTurn(pending) {
    pendingTurns.set(pending.roomId, pending);
    try { sessionStorage.setItem(pendingTurnStorageKey(pending.roomId), JSON.stringify(pending)); } catch { /* best effort */ }
  }

  function clearPendingTurn(roomId) {
    pendingTurns.delete(roomId);
    try { sessionStorage.removeItem(pendingTurnStorageKey(roomId)); } catch { /* best effort */ }
  }

  function createTurnMutationId() {
    if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
      throw new Error('Secure browser turn identifiers are unavailable.');
    }
    return 'debate-turn_' + globalThis.crypto.randomUUID();
  }

  function renderPendingTurnState(pending, lifecycleStatus) {
    const aiDiv = getEl('debate-ai-responses');
    if (!aiDiv) return;
    const status = lifecycleStatus === 'pending' ? 'PENDING' : 'UNKNOWN';
    const color = status === 'PENDING' ? 'amber' : 'orange';
    aiDiv.innerHTML = '<div class="p-4 bg-' + color + '-50 rounded-xl border border-' + color + '-200">'
      + '<p class="text-xs font-bold text-' + color + '-700 uppercase mb-1">Turn ' + status + '</p>'
      + '<p class="text-sm text-gray-700">Your exact turn is retained for safe recovery. It will never be submitted as a new turn.</p>'
      + '<p class="text-xs text-gray-500 mt-2">' + esc(pending.content) + '</p>'
      + '<button type="button" class="mt-3 px-3 py-1.5 text-xs font-bold text-white bg-' + color + '-600 rounded" onclick="retryPendingDebateTurn()">Retry exact turn</button>'
      + '</div>';
  }

  function renderAgentResponses(data) {
    const aiDiv = getEl('debate-ai-responses');
    if (!aiDiv || !data.agentResponses) return;
    aiDiv.innerHTML = Object.entries(data.agentResponses).map(([role, reply]) => { const colors = { critic:'red', advocate:'green', moderator:'blue' }; const color = colors[role] || 'gray'; return '<div class="p-4 bg-' + color + '-50 rounded-xl border border-' + color + '-200"><p class="text-xs font-bold text-' + color + '-700 uppercase mb-1"><i class="fas fa-robot mr-1"></i>' + esc(role) + '</p><p class="text-sm text-gray-700">' + esc(reply) + '</p></div>'; }).join('');
  }

  function isTrackedPendingResponse(data, pending) {
    return data && data.turnMutationId === pending.turnMutationId
      && (data.status === 'UNKNOWN' || data.code === 'DEBATE_RUNTIME_TURN_PENDING'
        || data.code === 'DEBATE_RUNTIME_TURN_UNCERTAIN'
        || data.code === 'DEBATE_RUNTIME_TURN_FINALIZATION_UNCERTAIN');
  }

  function isRetryableTurnError(error) {
    const payload = error && error.apiError ? error.apiError : {};
    if (!error || !Number.isInteger(error.status)) return true; // lost browser/network response
    return error.status >= 500 && typeof payload.code === 'string'
      && payload.code.indexOf('DEBATE_RUNTIME_TURN_') === 0;
  }

  async function refreshPendingDebateTurnStatus(roomId) {
    const pending = getPendingTurn(roomId);
    if (!pending) return null;
    try {
      const status = await apiGet('/api/debate/rooms/' + encodeURIComponent(roomId) + '/turns/' + encodeURIComponent(pending.turnMutationId));
      if (status.status === 'complete' && status.replayAvailable) {
        clearPendingTurn(roomId);
        return status;
      }
      const lifecycleStatus = status.status === 'pending' ? 'pending' : 'unknown';
      storePendingTurn({ ...pending, lifecycleStatus, updatedAt: status.updatedAt || Date.now() });
      renderPendingTurnState(pending, lifecycleStatus);
      return status;
    } catch {
      // Keep the exact id/content when a status read is unavailable. A retry
      // can safely replay it, whereas a new id could create a second turn.
      storePendingTurn({ ...pending, lifecycleStatus: 'unknown', updatedAt: Date.now() });
      renderPendingTurnState(pending, 'unknown');
      return null;
    }
  }

  function loadDebateTab() { loadDebateRooms(); }

  async function loadDebateRooms() {
    try {
      const data = await apiGet('/api/debate/rooms');
      const list = getEl('debate-rooms-list'); if (!list) return;
      if (!data.rooms || data.rooms.length === 0) { list.innerHTML = '<div class="text-center py-8 text-gray-400">아직 토론방이 없습니다. 새 토론방을 만들어보세요!</div>'; return; }
      list.innerHTML = data.rooms.map(r => '<div class="card hover:shadow-md transition cursor-pointer" onclick="loadDebateRoom(\''+r.id+'\')"><div class="flex justify-between items-center mb-2"><h4 class="font-bold text-gray-900">'+esc(r.topic)+'</h4><span class="text-xs '+(r.status==='open'?'bg-green-100 text-green-700':'bg-gray-100 text-gray-500')+' px-2 py-0.5 rounded-full">'+(r.status==='open'?'OPEN':'CLOSED')+'</span></div><div class="flex gap-4 text-xs text-gray-500"><span><i class="fas fa-comment mr-1"></i>'+(r.turn_count||0)+' turns</span><span><i class="fas fa-clock mr-1"></i>'+new Date(r.created_at).toLocaleDateString('ko-KR')+'</span></div></div>').join('');
    } catch(e) { showToast(e.message, 'error'); }
  }

  function showCreateDebateModal() {
    const topic = prompt('토론 주제를 입력하세요:');
    if (topic && topic.trim()) createDebateRoom(topic.trim());
  }

  async function createDebateRoom(topic) {
    try {
      const data = await api('/api/debate/rooms', { topic });
      showToast('토론방이 생성되었습니다!', 'success');
      loadDebateRooms();
      if (data.roomId) loadDebateRoom(data.roomId);
    } catch(e) { showToast(e.message, 'error'); }
  }

  async function loadDebateRoom(roomId) {
    activeDebateRoomId = roomId;
    try {
      const data = await apiGet('/api/debate/rooms/' + roomId);
      setDisplay('debate-chat-area', 'block');
      const topicEl = getEl('debate-room-topic'); if (topicEl) topicEl.textContent = data.topic || roomId;
      const statusEl = getEl('debate-room-status'); if (statusEl) { statusEl.textContent = (data.status||'open').toUpperCase(); statusEl.className = 'text-xs px-2 py-0.5 rounded-full font-bold ' + (data.status==='open'?'bg-green-100 text-green-700':'bg-gray-100 text-gray-500'); }
      const msgDiv = getEl('debate-messages'); if (!msgDiv) return;
      if (data.turns && data.turns.length > 0) {
        msgDiv.innerHTML = data.turns.map(t => { const isAI = t.role !== 'student'; const roleColors = { critic:'bg-red-50 text-red-700', advocate:'bg-green-50 text-green-700', moderator:'bg-blue-50 text-blue-700' }; const rc = roleColors[t.role] || 'bg-gray-50 text-gray-700'; return '<div class="'+(isAI?'':'flex justify-end')+'"><div class="'+rc+' rounded-xl px-4 py-2 text-sm max-w-[85%] inline-block">'+(isAI?'<span class="text-xs font-bold uppercase">'+esc(t.role)+'</span><br>':'')+''+esc(t.content)+'</div></div>'; }).join('');
        msgDiv.scrollTop = msgDiv.scrollHeight;
      } else { msgDiv.innerHTML = '<div class="text-center text-gray-400 text-sm py-4">첫 발언을 해보세요!</div>'; }
      await refreshPendingDebateTurnStatus(roomId);
    } catch(e) { showToast(e.message, 'error'); }
  }

  async function dispatchDebateTurn(pending, input) {
    const btn = getEl('debate-submit-btn'); if (btn) btn.disabled = true;
    try {
      const data = await api('/api/debate/rooms/' + encodeURIComponent(pending.roomId) + '/turns', {
        content: pending.content,
        turnMutationId: pending.turnMutationId,
      }, 'POST', {
        headers: {
          'Idempotency-Key': pending.turnMutationId,
          'X-Debate-Turn-Mutation-Id': pending.turnMutationId,
        },
      });
      if (data && data.ok === true) {
        clearPendingTurn(pending.roomId);
        renderAgentResponses(data);
        await loadDebateRoom(pending.roomId);
        return;
      }
      // The optional no-runtime fallback has already persisted its student
      // turn and exposes a server turn id rather than this runtime mutation.
      // Do not retry it with a synthetic client id and create a duplicate.
      if (data && !data.turnMutationId && data.studentTurnId) {
        clearPendingTurn(pending.roomId);
        renderAgentResponses(data);
        await loadDebateRoom(pending.roomId);
        return;
      }
      if (isTrackedPendingResponse(data, pending)) {
        const lifecycleStatus = data.code === 'DEBATE_RUNTIME_TURN_PENDING' ? 'pending' : 'unknown';
        storePendingTurn({ ...pending, lifecycleStatus, updatedAt: Date.now() });
        renderPendingTurnState(pending, lifecycleStatus);
        showToast('토론 응답을 확인 중입니다. 동일한 발언만 다시 시도할 수 있습니다.', 'info');
        return;
      }
      storePendingTurn({ ...pending, lifecycleStatus: 'unknown', updatedAt: Date.now() });
      renderPendingTurnState(pending, 'unknown');
      showToast('토론 결과를 확인할 수 없습니다. 동일한 발언만 재시도할 수 있습니다.', 'error');
    } catch (error) {
      if (isRetryableTurnError(error)) {
        storePendingTurn({ ...pending, lifecycleStatus: 'unknown', updatedAt: Date.now() });
        renderPendingTurnState(pending, 'unknown');
        showToast('토론 응답 상태를 확인할 수 없습니다. 동일한 발언을 재시도하세요.', 'error');
        return;
      }
      clearPendingTurn(pending.roomId);
      if (input) input.value = pending.content;
      showToast(error.message, 'error');
    } finally { if (btn) btn.disabled = false; }
  }

  async function submitDebateTurn() {
    if (!activeDebateRoomId) return;
    const input = getEl('debate-input');
    const content = input ? input.value.trim() : '';
    const existing = getPendingTurn(activeDebateRoomId);
    if (existing) {
      if (content && content !== existing.content) {
        showToast('이전 발언의 상태를 먼저 확인하거나 동일한 발언을 재시도하세요.', 'info');
        return;
      }
      await dispatchDebateTurn(existing, input);
      return;
    }
    if (!content) return;
    let turnMutationId;
    try { turnMutationId = createTurnMutationId(); } catch (error) { showToast(error.message, 'error'); return; }
    const pending = { roomId: activeDebateRoomId, content, turnMutationId, lifecycleStatus: 'pending', createdAt: Date.now() };
    storePendingTurn(pending);
    if (input) input.value = '';
    await dispatchDebateTurn(pending, input);
  }

  async function retryPendingDebateTurn() {
    if (!activeDebateRoomId) return;
    const pending = getPendingTurn(activeDebateRoomId);
    if (!pending) return showToast('재시도할 토론 발언이 없습니다.', 'info');
    await dispatchDebateTurn(pending, getEl('debate-input'));
  }

  window.loadDebateTab = loadDebateTab;
  window.loadDebateRooms = loadDebateRooms;
  window.showCreateDebateModal = showCreateDebateModal;
  window.loadDebateRoom = loadDebateRoom;
  window.submitDebateTurn = submitDebateTurn;
  window.retryPendingDebateTurn = retryPendingDebateTurn;
  window.refreshPendingDebateTurnStatus = () => activeDebateRoomId && refreshPendingDebateTurnStatus(activeDebateRoomId);
  S.loadDebateTab = loadDebateTab;
})(window.SocraticAI);
