import { State, getEl, setText } from './state.js';
import { KnowledgeGraphViewer } from './components/knowledge-graph-viewer.js';
import { apiGet } from './utils.js';

let viewer = null;
let requestGeneration = 0;

function resetSelectedNode() {
  setText('neural-wiki-node-title', '그래프에서 개념을 선택하세요.');
  setText('neural-wiki-node-description', '');
  setText('neural-wiki-node-essence', '');
  setText('neural-wiki-node-mastery', '기록 없음 (검증되지 않은 모델 추정치)');
  setText('neural-wiki-taiji-status', '');
}

function showPanel(id) {
  ['neural-wiki-loading', 'neural-wiki-empty', 'neural-wiki-unavailable', 'neural-wiki-selected'].forEach((panelId) => {
    getEl(panelId)?.classList.toggle('hidden', panelId !== id);
  });
}

function showSelectedNode(node) {
  setText('neural-wiki-node-title', node.concept || '이름 없는 개념');
  setText('neural-wiki-node-description', node.description || '이 개념에는 설명이 아직 기록되지 않았습니다.');
  setText('neural-wiki-node-essence', node.coreEssence || '핵심 본질 정보가 아직 기록되지 않았습니다.');
  const mastery = typeof node.mastery === 'number'
    ? `${Math.round(node.mastery * 100)}% (검증되지 않은 모델 추정치)`
    : '기록 없음 (검증되지 않은 모델 추정치)';
  setText('neural-wiki-node-mastery', mastery);
  const taijiAvailable = Boolean(State.isSessionActive && State.sessionId);
  setText('neural-wiki-taiji-status', taijiAvailable
    ? '태극 행동은 현재 사용할 수 없습니다: grade/engagement gate evidence가 아직 없습니다.'
    : '태극은 활성 Sparring 세션에서만 사용할 수 있습니다. Training 세션은 지원하지 않습니다.');
  showPanel('neural-wiki-selected');
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function textValue(value, fallback = 'UNKNOWN') {
  return typeof value === 'string' && value ? value : fallback;
}

function appendField(container, label, value) {
  const row = document.createElement('p');
  row.className = 'mt-2 text-sm text-gray-700';
  const title = document.createElement('strong');
  title.textContent = `${label}: `;
  const detail = document.createElement('span');
  detail.textContent = value;
  row.append(title, detail);
  container.appendChild(row);
}

async function openTrainingCorrection(sessionId) {
  await window.switchTab?.('training', { focusDestination: true });
  await window.resumeTrainingSession?.(sessionId);
}

async function openTrainingDeletion(sessionId) {
  await window.switchTab?.('history', { focusDestination: true });
  window.deleteSession?.(sessionId, '내 근거 모델 기록', 'training');
}

export function renderEvidenceModelLedger(projection) {
  const panel = getEl('neural-wiki-evidence-model');
  if (!panel) return;
  panel.replaceChildren();
  const heading = document.createElement('h3');
  heading.className = 'font-bold text-gray-900';
  heading.textContent = '내 수정 가능한 근거 모델';
  const disclosure = document.createElement('p');
  disclosure.className = 'mt-2 text-sm text-gray-600';
  disclosure.textContent = '참조 그래프와 별도의 내 수정 가능한 근거 모델 기록입니다. 이 기록은 숙련도, 진단, 보정 또는 학습 효과의 증거가 아닙니다.';
  panel.append(heading, disclosure);

  const value = asRecord(projection);
  const records = Array.isArray(value?.records) ? value.records.map(asRecord).filter(Boolean) : [];
  if (value?.status === 'UNAVAILABLE') {
    const unavailable = document.createElement('p');
    unavailable.className = 'mt-3 text-sm text-amber-800';
    unavailable.textContent = '수정 기록을 안전하게 확인할 수 없습니다. UNKNOWN 상태로 유지합니다.';
    panel.appendChild(unavailable);
    return;
  }
  if (records.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'mt-3 text-sm text-gray-500';
    empty.textContent = '수정 가능한 근거 모델 기록이 없습니다. 상태는 UNKNOWN입니다.';
    panel.appendChild(empty);
    return;
  }

  const list = document.createElement('ol');
  list.className = 'mt-4 space-y-4';
  for (const record of records) {
    const sessionId = textValue(record.sessionId, '');
    if (!sessionId) continue;
    const item = document.createElement('li');
    item.className = 'rounded-xl border border-gray-200 p-4';
    const title = document.createElement('h4');
    title.className = 'font-semibold text-gray-900';
    title.textContent = `수정 기록 ${textValue(record.revision)} · ${textValue(record.eventId)}`;
    item.appendChild(title);
    const model = asRecord(record.model);
    appendField(item, '모델', `${textValue(model?.id)} · ${textValue(model?.version)}`);
    appendField(item, '기록 시각', typeof record.recordedAt === 'number' ? new Date(record.recordedAt).toLocaleString('ko-KR') : 'UNKNOWN');
    const observation = asRecord(record.observation);
    const hypothesis = asRecord(record.hypothesis);
    const causalRationale = asRecord(record.causalRationale);
    appendField(item, '내 이전 관찰', textValue(observation?.statement));
    appendField(item, '수정한 가설', textValue(hypothesis?.statement));
    appendField(item, '수정 이유 (학습자 작성 · 미검증)', textValue(causalRationale?.statement));
    appendField(item, '신뢰도', textValue(record.confidence));
    appendField(item, '검증 상태', textValue(record.validationStatus));
    appendField(item, '근거 매니페스트', textValue(record.manifestSha256));
    const sources = Array.isArray(record.sources) ? record.sources.map(asRecord).filter(Boolean) : [];
    appendField(item, '선택 근거', sources.length
      ? sources.map((source) => `${textValue(source.sourceId)} · ${textValue(source.contentSha256)}`).join(' / ')
      : '없음 (UNKNOWN)');
    const nextAction = asRecord(record.nextAction);
    const actionState = textValue(nextAction?.status);
    const action = textValue(nextAction?.tutorAction);
    appendField(item, '다음 대화 반영', actionState === 'CONSUMED'
      ? `${textValue(nextAction?.turnNumber)}번째 대화 · ${action}`
      : '검토 대기 (PENDING)');
    const actions = document.createElement('div');
    actions.className = 'mt-4 flex flex-wrap gap-2';
    const correction = document.createElement('button');
    correction.type = 'button';
    correction.className = 'btn-secondary text-sm';
    correction.textContent = '수정 기록 열기';
    correction.addEventListener('click', () => openTrainingCorrection(sessionId));
    const deletion = document.createElement('button');
    deletion.type = 'button';
    deletion.className = 'text-sm text-red-700 underline';
    deletion.textContent = '기록 삭제로 이동';
    deletion.addEventListener('click', () => openTrainingDeletion(sessionId));
    actions.append(correction, deletion);
    item.appendChild(actions);
    list.appendChild(item);
  }
  panel.appendChild(list);
}

async function loadEvidenceModelLedger(generation) {
  try {
    const projection = await apiGet('/api/training/evidence-models');
    if (generation !== requestGeneration) return;
    renderEvidenceModelLedger(projection);
  } catch (error) {
    if (generation !== requestGeneration) return;
    console.warn('[NeuralWiki] evidence model unavailable', error);
    renderEvidenceModelLedger({ status: 'UNAVAILABLE', records: [] });
  }
}

export function clearPrivateNeuralWiki() {
  requestGeneration += 1;
  viewer = null;
  resetSelectedNode();
  ['neural-wiki-loading', 'neural-wiki-empty', 'neural-wiki-unavailable', 'neural-wiki-selected'].forEach((id) => {
    getEl(id)?.classList.add('hidden');
  });
  getEl('neural-wiki-graph')?.replaceChildren();
  getEl('neural-wiki-evidence-model')?.replaceChildren();
}

export async function loadNeuralWiki() {
  const generation = ++requestGeneration;
  const domainId = String(getEl('neural-wiki-domain')?.value || 'meditations_4');
  resetSelectedNode();
  showPanel('neural-wiki-loading');
  void loadEvidenceModelLedger(generation);
  const currentViewer = new KnowledgeGraphViewer({
    containerId: 'neural-wiki-graph',
    domainId,
    isCurrent: () => generation === requestGeneration,
    onGraphLoad(graph) {
      if (generation !== requestGeneration) return;
      if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) showPanel('neural-wiki-empty');
    },
    onGraphError() {
      if (generation === requestGeneration) showPanel('neural-wiki-unavailable');
    },
    onNodeClick(_nodeId, node) {
      if (generation !== requestGeneration) return;
      showSelectedNode(node);
    },
  });
  viewer = currentViewer;
  try {
    await currentViewer.mount();
    if (generation !== requestGeneration) return;
    if (currentViewer.getGraphData()?.nodes?.length) showPanel('neural-wiki-selected');
  } catch (error) {
    if (generation !== requestGeneration) return;
    console.error('[NeuralWiki] unavailable', error);
    showPanel('neural-wiki-unavailable');
  }
}

window.loadNeuralWiki = loadNeuralWiki;
window.clearPrivateNeuralWiki = clearPrivateNeuralWiki;
