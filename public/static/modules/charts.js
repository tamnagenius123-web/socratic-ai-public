// ======================================================
// SocraticAI v26 — Charts Module (Radar, 18-Axis, Micro)
// ======================================================
import { getEl } from './state.js';

let radarChartInstance = null;

export function initRadarChart(scores) {
  const canvas = getEl('radar-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const keys = ['defense', 'consistency', 'evidence', 'relevance', 'clarity'];
  const hasMeasuredScores = Boolean(scores) && keys.every(key => (
    Number.isFinite(Number(scores[key]))
    && Number(scores[key]) >= 20
    && Number(scores[key]) <= 100
  ));
  if (radarChartInstance) { radarChartInstance.destroy(); radarChartInstance = null; }
  const labels = ['논리 방어', '일관성', '근거 사용', '관련성', '명확성'];
  const data = hasMeasuredScores ? keys.map(key => Number(scores[key])) : keys.map(() => null);
  radarChartInstance = new Chart(canvas, {
    type: 'radar',
    data: {
      labels,
      datasets: [{
        label: hasMeasuredScores ? '역량 프로필' : 'No record',
        data,
        backgroundColor: 'rgba(91,76,219,0.15)',
        borderColor: '#5B4CDB',
        pointBackgroundColor: '#5B4CDB',
        pointRadius: hasMeasuredScores ? 4 : 0,
        borderWidth: 2
      }]
    },
    options: {
      scales: { r: { min: 0, max: 100, ticks: { stepSize: 20, display: false }, grid: { color: 'rgba(0,0,0,0.06)' }, pointLabels: { font: { size: 11 } } } },
      plugins: { legend: { display: false } },
      responsive: true, maintainAspectRatio: false
    }
  });
}

export function updateRadarChart(scores) {
  if (radarChartInstance) {
    const keys = ['defense', 'consistency', 'evidence', 'relevance', 'clarity'];
    const hasMeasuredScores = Boolean(scores) && keys.every(key => (
      Number.isFinite(Number(scores[key]))
      && Number(scores[key]) >= 20
      && Number(scores[key]) <= 100
    ));
    radarChartInstance.data.datasets[0].data = hasMeasuredScores
      ? keys.map(key => Number(scores[key]))
      : keys.map(() => null);
    radarChartInstance.data.datasets[0].label = hasMeasuredScores ? '역량 프로필' : 'No record';
    radarChartInstance.data.datasets[0].pointRadius = hasMeasuredScores ? 4 : 0;
    radarChartInstance.update();
  }
}

// v24: 18-Axis Radar Chart for DeepSkill analytics
export function render18AxisRadar(containerId, scores) {
  const canvas = getEl(containerId);
  if (!canvas || typeof Chart === 'undefined') return null;
  
  const keys = ['defense','consistency','evidence','relevance','clarity','logical_coherence',
    'premise_validity','inference_quality','counter_argument','data_literacy','cognitive_flexibility',
    'reframing','metacognition','communication','mece','actionability','originality','synthesis'];
  const labels = ['방어력','일관성','근거','관련성','명확성','논리 정합',
    '전제 타당','추론 질','반론','데이터','인지 유연',
    '리프레이밍','메타인지','소통','MECE','실행력','독창성','통합'];
  
  const data = keys.map(k => Math.round((scores[k] || 0) * (scores[k] > 1 ? 1 : 100)));
  
  return new Chart(canvas, {
    type: 'radar',
    data: {
      labels,
      datasets: [{
        label: '18축 역량',
        data,
        backgroundColor: 'rgba(99,102,241,0.12)',
        borderColor: '#6366F1',
        pointBackgroundColor: '#6366F1',
        pointRadius: 3,
        borderWidth: 2
      }]
    },
    options: {
      scales: { r: { min: 0, max: 100, ticks: { stepSize: 20, display: false }, grid: { color: 'rgba(0,0,0,0.05)' }, pointLabels: { font: { size: 9 } } } },
      plugins: { legend: { display: false } },
      responsive: true, maintainAspectRatio: false
    }
  });
}

// v17: Micro-Indicator 4-Axis Radar
export function drawMicroRadar(canvasId, scores, maxVal) {
  maxVal = maxVal || 100;
  const canvas = getEl(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) * 0.38;
  const axes = Object.keys(scores);
  const n = axes.length;
  if (!n) return;
  
  ctx.clearRect(0, 0, w, h);
  // Grid
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath();
    const gr = r * i / 4;
    for (let j = 0; j <= n; j++) {
      const angle = (Math.PI * 2 / n) * j - Math.PI / 2;
      const x = cx + gr * Math.cos(angle);
      const y = cy + gr * Math.sin(angle);
      j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.stroke();
  }
  // Data polygon
  ctx.beginPath();
  axes.forEach((key, i) => {
    const val = Math.min(scores[key] || 0, maxVal);
    const angle = (Math.PI * 2 / n) * i - Math.PI / 2;
    const x = cx + r * (val / maxVal) * Math.cos(angle);
    const y = cy + r * (val / maxVal) * Math.sin(angle);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(91,76,219,0.15)';
  ctx.fill();
  ctx.strokeStyle = '#5B4CDB';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Points + labels
  axes.forEach((key, i) => {
    const val = Math.min(scores[key] || 0, maxVal);
    const angle = (Math.PI * 2 / n) * i - Math.PI / 2;
    const x = cx + r * (val / maxVal) * Math.cos(angle);
    const y = cy + r * (val / maxVal) * Math.sin(angle);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, 2 * Math.PI);
    ctx.fillStyle = '#5B4CDB';
    ctx.fill();
    // Label
    const lx = cx + (r + 14) * Math.cos(angle);
    const ly = cy + (r + 14) * Math.sin(angle);
    ctx.font = '10px Inter';
    ctx.fillStyle = '#6B7280';
    ctx.textAlign = 'center';
    ctx.fillText(key.replace(/_/g, ' '), lx, ly + 3);
  });
}
