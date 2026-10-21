// ======================================================
// SocraticAI v33 — Enterprise Module (extracted from app.js)
// v33: NC-002 FIX — Modular extraction of Enterprise functions
// v31: Enterprise HRD Dashboard with DeepSkill Fidelity
// ======================================================

import { apiGet, showToast } from './utils.js';
import { esc, getEl } from './state.js';

let enterpriseTab = 'overview';

function finiteNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'object' || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeNumber(value, fallback = 0) {
  return finiteNumber(value) ?? fallback;
}

function measuredNumber(value, { suffix = '', digits = 0 } = {}) {
  const number = finiteNumber(value);
  return number === null ? 'No record' : number.toFixed(digits) + suffix;
}

function escapeText(value) {
  return esc(String(value ?? ''));
}

export function switchEnterpriseTab(tab) {
  enterpriseTab = tab;
  document.querySelectorAll('[data-enttab]').forEach(function(el) {
    el.classList.toggle('active', el.dataset.enttab === tab);
  });
  loadEnterpriseDashboard();
}

export function loadEnterpriseDashboard() {
  var container = getEl('enterprise-content');
  if (!container) return;
  container.innerHTML = '<div class="text-center py-12"><i class="fas fa-spinner fa-spin text-primary-500 text-xl"></i></div>';

  if (enterpriseTab === 'fidelity') {
    loadFidelityTab(container);
    return;
  }

  if (enterpriseTab === 'roi') {
    loadROITab(container);
    return;
  }

  if (enterpriseTab === 'team-radar') {
    loadTeamRadarTab(container);
    return;
  }

  // Default: overview
  loadOverviewTab(container);
}

function loadFidelityTab(container) {
  apiGet('/api/enterprise/fidelity').then(function(data) {
    var f = data.fidelity || {};
    var dynamicInfo = data._dynamic || {};
    var sessionCount = safeNumber(dynamicInfo.sessionCount);
    var modeLabel = dynamicInfo.mode === 'dynamic'
      ? '<span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full ml-2">동적 계산 (' + sessionCount + ' sessions)</span>'
      : '<span class="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full ml-2">아키텍처 기반</span>';
    var overall = safeNumber(f.overall);

    container.innerHTML = '<div class="grid grid-cols-1 md:grid-cols-2 gap-6">' +
      '<div class="card col-span-2"><div class="text-center">' +
      '<h3 class="text-lg font-bold text-gray-900 mb-2">DeepSkill Fidelity Score' + modeLabel + '</h3>' +
      '<p class="text-6xl font-extrabold bg-gradient-to-r from-primary-500 to-indigo-500 bg-clip-text text-transparent">' + overall.toFixed(1) + '</p>' +
      '<p class="text-gray-500 mt-1">/ 100 (Target: 100)</p></div></div>' +
      ['neural', 'bridge', 'symbolic', 'analytics'].map(function(layer) {
        var layerData = f[layer] && typeof f[layer] === 'object' ? f[layer] : { score: 0, components: {} };
        var layerScore = safeNumber(layerData.score);
        var layerNames = { neural: '🧠 인지/의도 (Neural)', bridge: '🔗 브릿지 (Neuro-Symbolic)', symbolic: '⚙️ 심볼릭 연산 (Symbolic)', analytics: '📊 메타분석 (Analytics)' };
        var comps = Object.entries(layerData.components || {}).map(function(e) {
          var k = e[0], v = e[1];
          var componentScore = safeNumber(v && v.score);
          var componentWidth = Math.max(0, Math.min(componentScore, 100));
          return '<div class="flex justify-between items-center text-xs">' +
            '<span class="text-gray-600">' + escapeText(k.replace(/_/g, ' ')) + '</span>' +
            '<div class="flex items-center gap-2"><div class="w-24 bg-gray-200 rounded-full h-1.5"><div class="h-1.5 rounded-full ' + (componentScore >= 80 ? 'bg-green-500' : componentScore >= 50 ? 'bg-yellow-500' : 'bg-red-500') + '" style="width:' + componentWidth + '%"></div></div>' +
            '<span class="font-bold w-8 text-right">' + componentScore + '</span></div></div>';
        }).join('');
        return '<div class="card"><h4 class="font-bold text-gray-900 mb-3">' + layerNames[layer] + ' <span class="text-primary-500">' + layerScore.toFixed(1) + '%</span></h4>' +
          '<div class="space-y-2">' + comps + '</div></div>';
      }).join('') + '</div>';
  }).catch(function(e) {
    console.error('[Enterprise] Fidelity load error:', e);
    var errorMessage = e && typeof e.message === 'string' ? escapeText(e.message) : 'Unknown failure';
    container.innerHTML = '<div class="text-center py-12 text-red-500">Fidelity 데이터 로딩 실패: ' + errorMessage + '</div>';
  });
}

function loadROITab(container) {
  apiGet('/api/enterprise/roi').then(function(data) {
    var roi = data.roi || {};
    var avgImprovement = finiteNumber(roi.avgImprovement);
    var totalParticipants = safeNumber(roi.totalParticipants);
    var improvedCount = safeNumber(roi.improvedCount);
    container.innerHTML = '<div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">' +
      '<div class="card text-center"><p class="text-3xl font-extrabold text-green-600">' + (avgImprovement === null ? 'No record' : (avgImprovement > 0 ? '+' : '') + avgImprovement.toFixed(1)) + '</p><p class="text-xs text-gray-500 mt-1">평균 점수 향상</p></div>' +
      '<div class="card text-center"><p class="text-3xl font-extrabold text-primary-600">' + totalParticipants + '</p><p class="text-xs text-gray-500 mt-1">참가자 수</p></div>' +
      '<div class="card text-center"><p class="text-3xl font-extrabold text-indigo-600">' + improvedCount + '</p><p class="text-xs text-gray-500 mt-1">점수 향상 인원</p></div>' +
      '</div>' +
      '<div class="card"><h3 class="font-bold text-gray-900 mb-3">개인별 ROI (점수 변화)</h3>' +
      '<div class="space-y-2">' +
      (Array.isArray(data.details) ? data.details : []).map(function(d) {
        var imp = safeNumber(d && d.improvement);
        return '<div class="flex items-center justify-between text-sm"><span class="text-gray-700">' + escapeText(d.username || '-') + '</span>' +
          '<span class="font-bold ' + (imp > 0 ? 'text-green-600' : 'text-red-600') + '">' + (imp > 0 ? '+' : '') + imp.toFixed(1) + '</span></div>';
      }).join('') + '</div></div>';
  }).catch(function(e) {
    console.error('[Enterprise] ROI load error:', e);
    container.innerHTML = '<div class="text-center py-12 text-red-500">ROI 데이터 로딩 실패</div>';
  });
}

function loadTeamRadarTab(container) {
  apiGet('/api/enterprise/team-radar').then(function(data) {
    var teams = Array.isArray(data.teamScores) ? data.teamScores : [];
    if (teams.length === 0) {
      container.innerHTML = '<div class="text-center py-12 text-gray-400"><i class="fas fa-users text-5xl mb-4 block"></i><p>팀 데이터가 없습니다.</p></div>';
      return;
    }
    container.innerHTML = '<div class="card"><h3 class="font-bold text-gray-900 mb-4">팀별 성과 분석</h3>' +
      '<div class="space-y-3">' +
      teams.map(function(t) {
        var score = safeNumber(t && t.avg_logic).toFixed(0);
        var scoreWidth = Math.max(0, Math.min(Number(score), 100));
        var memberCount = safeNumber(t && t.member_count);
        var sessionCount = safeNumber(t && t.session_count);
        return '<div class="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">' +
          '<div><span class="font-bold text-gray-900">' + escapeText(t.grade || '미분류') + '</span>' +
          '<span class="text-xs text-gray-500 ml-2">' + memberCount + '명 · ' + sessionCount + ' sessions</span></div>' +
          '<div class="flex items-center gap-2"><div class="w-32 bg-gray-200 rounded-full h-2"><div class="h-2 rounded-full bg-primary-500" style="width:' + scoreWidth + '%"></div></div>' +
          '<span class="font-bold text-primary-600 w-10 text-right">' + score + '%</span></div></div>';
      }).join('') + '</div></div>';
  }).catch(function(e) {
    console.error('[Enterprise] Team radar load error:', e);
    container.innerHTML = '<div class="text-center py-12 text-red-500">팀 데이터 로딩 실패</div>';
  });
}

function loadOverviewTab(container) {
  apiGet('/api/enterprise/dashboard').then(function(data) {
    var ov = data.overview || {};
    container.innerHTML = '<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">' +
      statBox('총 사용자', safeNumber(ov.total_users), 'fa-users', 'primary') +
      statBox('총 세션', safeNumber(ov.total_sessions), 'fa-comments', 'indigo') +
      statBox('평균 논리력', measuredNumber(ov.avg_logic, { suffix: '%' }), 'fa-brain', 'green') +
      statBox('30일 활성 사용자', safeNumber(ov.active_users_30d), 'fa-chart-line', 'amber') +
      '</div>' +
      '<div class="card"><h3 class="font-bold text-gray-900 mb-3"><i class="fas fa-trophy text-amber-500 mr-2"></i>Top Performers</h3>' +
      '<div class="space-y-2">' +
      (Array.isArray(data.topPerformers) ? data.topPerformers : []).map(function(p, i) {
        var sessionCount = safeNumber(p && p.session_count);
        var averageScore = safeNumber(p && p.avg_score);
        return '<div class="flex items-center justify-between text-sm bg-gray-50 rounded-xl px-4 py-2">' +
          '<div class="flex items-center gap-3"><span class="w-6 h-6 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center text-xs font-bold">' + (i+1) + '</span>' +
          '<span class="font-semibold text-gray-900">' + escapeText(p.username || '-') + '</span></div>' +
          '<div class="flex items-center gap-4"><span class="text-xs text-gray-500">' + sessionCount + ' sessions</span>' +
          '<span class="font-bold text-primary-600">' + averageScore.toFixed(0) + '%</span></div></div>';
      }).join('') + '</div></div>';
  }).catch(function(e) {
    console.error('[Enterprise] Overview load error:', e);
    container.innerHTML = '<div class="text-center py-12 text-red-500">대시보드 로딩 실패</div>';
  });
}

function statBox(label, value, icon, color) {
  return '<div class="card text-center"><div class="w-10 h-10 bg-' + color + '-50 rounded-xl flex items-center justify-center mx-auto mb-2"><i class="fas ' + icon + ' text-' + color + '-500"></i></div>' +
    '<p class="text-2xl font-extrabold text-gray-900">' + escapeText(value) + '</p><p class="text-xs text-gray-500 mt-1">' + escapeText(label) + '</p></div>';
}
