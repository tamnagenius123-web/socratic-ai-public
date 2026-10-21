// ======================================================
// SocraticAI v33 — ClassChat Module (extracted from app.js)
// v33: NC-002 FIX — Modular extraction of ClassChat functions
// v32: ClassChat Peer Learning with AI Facilitator
// ======================================================

import { api, apiGet, showToast } from './utils.js';
import { State, getEl, setDisplay, setText } from './state.js';

let currentClassChatRoom = null;
let classChatWS = null;

export function loadClassChatRooms() {
  var container = getEl('classchat-rooms-list');
  if (!container) return;
  apiGet('/api/classchat/rooms').then(function(data) {
    var rooms = data.rooms || [];
    if (rooms.length === 0) {
      container.innerHTML = '<div class="text-center py-12 text-gray-400"><i class="fas fa-people-arrows text-5xl mb-4 block"></i><p class="text-lg font-semibold mb-2">아직 ClassChat 방이 없습니다</p><p class="text-sm">새 ClassChat을 만들어 동료와 함께 토론을 시작하세요.</p></div>';
      return;
    }
    container.innerHTML = rooms.map(function(r) {
      return '<div class="card hover:shadow-md transition-shadow cursor-pointer" onclick="joinClassChat(\'' + r.id + '\',\'' + (r.topic || '').replace(/'/g, "\\'") + '\')">' +
        '<div class="flex items-center justify-between">' +
        '<div class="flex items-center gap-3"><div class="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center"><i class="fas fa-people-arrows text-indigo-500"></i></div>' +
        '<div><h4 class="font-bold text-gray-900">' + (r.topic || 'ClassChat') + '</h4>' +
        '<p class="text-xs text-gray-500">' + r.facilitator_mode + ' · 최대 ' + r.max_participants + '명</p></div></div>' +
        '<span class="text-xs px-2 py-1 rounded-full font-bold ' + (r.status === 'open' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500') + '">' + (r.status || 'open').toUpperCase() + '</span>' +
        '</div></div>';
    }).join('');
  }).catch(function(e) {
    console.error('[ClassChat] Failed to load rooms:', e);
    container.innerHTML = '<div class="text-center py-12 text-gray-400">ClassChat을 불러올 수 없습니다.</div>';
  });
}

export function showCreateClassChatModal() {
  var topic = prompt('ClassChat 토론 주제를 입력하세요:');
  if (!topic) return;
  api('/api/classchat/rooms', { topic: topic, maxParticipants: 6, facilitatorMode: 'ai_guided' }).then(function(data) {
    showToast('ClassChat 방이 생성되었습니다!', 'success');
    joinClassChat(data.roomId, topic);
    loadClassChatRooms();
  }).catch(function(e) { showToast('생성 실패: ' + e.message, 'error'); });
}

export function joinClassChat(roomId, topic) {
  currentClassChatRoom = roomId;
  setDisplay('classchat-rooms-list', 'none');
  setDisplay('classchat-chat-area', 'block');
  setText('cc-room-topic', topic || 'ClassChat');
  loadClassChatMessages(roomId);

  // v33: Attempt WebSocket connection if available
  connectClassChatWS(roomId);
}

export function loadClassChatMessages(roomId) {
  var container = getEl('cc-messages');
  if (!container) return;
  apiGet('/api/classchat/rooms/' + roomId + '/messages').then(function(data) {
    var msgs = data.messages || [];
    container.innerHTML = msgs.map(function(m) {
      var isFacilitator = m.role === 'facilitator';
      return '<div class="flex gap-2 ' + (isFacilitator ? 'justify-center' : '') + '">' +
        '<div class="' + (isFacilitator ? 'bg-indigo-50 border border-indigo-200' : 'bg-white border border-gray-200') + ' rounded-xl px-4 py-2 max-w-[80%]">' +
        '<p class="text-xs font-bold ' + (isFacilitator ? 'text-indigo-600' : 'text-primary-600') + ' mb-1">' +
        (isFacilitator ? '🤖 AI Facilitator' : '👤 ' + (m.user_id || 'Student').slice(0, 8)) + '</p>' +
        '<p class="text-sm text-gray-800">' + (m.content || '') + '</p></div></div>';
    }).join('');
    container.scrollTop = container.scrollHeight;
  }).catch(function(e) { console.error('[ClassChat] Failed to load messages:', e); });
}

export function submitClassChatMessage() {
  if (!currentClassChatRoom) return;
  var input = getEl('cc-input');
  var content = input ? input.value.trim() : '';
  if (!content) return;
  input.value = '';

  // v33: Try WebSocket first, fallback to HTTP
  if (classChatWS && classChatWS.readyState === WebSocket.OPEN) {
    classChatWS.send(JSON.stringify({ content: content, userId: State.user?.id }));
    // Optimistic: add message locally immediately
    appendLocalMessage(content);
    return;
  }

  // HTTP fallback
  api('/api/classchat/rooms/' + currentClassChatRoom + '/message', { content: content }).then(function(data) {
    loadClassChatMessages(currentClassChatRoom);
    if (data.facilitator && data.facilitator.message) {
      var card = getEl('cc-facilitator-card');
      if (card) card.style.display = 'block';
      setText('cc-facilitator-msg', data.facilitator.message);
      if (data.facilitator.missingPerspectives && data.facilitator.missingPerspectives.length > 0) {
        var mpContainer = getEl('cc-missing-perspectives');
        if (mpContainer) {
          mpContainer.innerHTML = data.facilitator.missingPerspectives.map(function(p) {
            return '<span class="inline-block text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-full mr-1">💡 ' + p + '</span>';
          }).join('');
        }
      }
    }
  }).catch(function(e) { showToast('전송 실패: ' + e.message, 'error'); });
}

// v33: WebSocket connection for real-time ClassChat (NC-004 preparation)
export function connectClassChatWS(roomId) {
  // Determine WebSocket URL based on current environment
  var wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsHost = window.__CLASSCHAT_WS_HOST || window.location.host;
  var wsUrl = wsProtocol + '//' + wsHost + '/ws/classchat/' + roomId;

  try {
    classChatWS = new WebSocket(wsUrl);

    classChatWS.onopen = function() {
      console.log('[ClassChat WS] Connected to room:', roomId);
      showToast('ClassChat 실시간 연결됨', 'success');
    };

    classChatWS.onmessage = function(e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === 'message') {
          appendRemoteMessage(data);
        } else if (data.type === 'facilitator') {
          appendFacilitatorMessage(data);
        }
      } catch (err) {
        console.error('[ClassChat WS] Parse error:', err);
      }
    };

    classChatWS.onclose = function() {
      console.log('[ClassChat WS] Disconnected. Falling back to HTTP polling.');
      classChatWS = null;
    };

    classChatWS.onerror = function(err) {
      console.error('[ClassChat WS] Error:', err);
      classChatWS = null;
      // Silent fallback to HTTP — no toast since WS is optional
    };
  } catch (e) {
    console.log('[ClassChat WS] WebSocket not available, using HTTP fallback.');
    classChatWS = null;
  }
}

function appendLocalMessage(content) {
  var container = getEl('cc-messages');
  if (!container) return;
  var div = document.createElement('div');
  div.className = 'flex gap-2';
  div.innerHTML = '<div class="bg-white border border-gray-200 rounded-xl px-4 py-2 max-w-[80%]">' +
    '<p class="text-xs font-bold text-primary-600 mb-1">👤 ' + ((State.user?.id || 'Me').slice(0, 8)) + '</p>' +
    '<p class="text-sm text-gray-800">' + content + '</p></div>';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function appendRemoteMessage(data) {
  var container = getEl('cc-messages');
  if (!container) return;
  var div = document.createElement('div');
  div.className = 'flex gap-2';
  div.innerHTML = '<div class="bg-white border border-gray-200 rounded-xl px-4 py-2 max-w-[80%]">' +
    '<p class="text-xs font-bold text-primary-600 mb-1">👤 ' + ((data.userId || 'Peer').slice(0, 8)) + '</p>' +
    '<p class="text-sm text-gray-800">' + (data.content || '') + '</p></div>';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function appendFacilitatorMessage(data) {
  var container = getEl('cc-messages');
  if (!container) return;
  var div = document.createElement('div');
  div.className = 'flex gap-2 justify-center';
  div.innerHTML = '<div class="bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-2 max-w-[80%]">' +
    '<p class="text-xs font-bold text-indigo-600 mb-1">🤖 AI Facilitator</p>' +
    '<p class="text-sm text-gray-800">' + (data.content || data.message || '') + '</p></div>';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  // Show facilitator card
  var card = getEl('cc-facilitator-card');
  if (card) card.style.display = 'block';
  setText('cc-facilitator-msg', data.content || data.message || '');
}

export function disconnectClassChatWS() {
  if (classChatWS) {
    classChatWS.close();
    classChatWS = null;
  }
}

export function getCurrentClassChatRoom() {
  return currentClassChatRoom;
}
