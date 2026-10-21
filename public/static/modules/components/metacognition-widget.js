/**
 * Metacognition Widget
 * Student confidence slider → honest verification state
 * Brier Score + Reliability Diagram (only when server-side outcomes exist)
 * v35 Feature: Stealth Assessment (T1.5.2)
 */

/**
 * Mount metacognition widget into container
 * @param {HTMLElement} container
 * @param {Object} opts
 *   - userId {string} required
 *   - sessionId {string} required
 *   - problemId {string} optional
 *   - authenticatedFetch {Function(url, init): Promise<Response>} optional
 *   - onSubmit {Function(confidence)} callback
 */
export function mountMetacognitionWidget(container, opts = {}) {
  const { userId, sessionId, problemId, onSubmit } = opts;
  const authenticatedFetch = typeof opts.authenticatedFetch === 'function'
    ? opts.authenticatedFetch
    : (...args) => fetch(...args);

  if (!userId || !sessionId) {
    console.error('mountMetacognitionWidget: missing userId or sessionId');
    return;
  }

  // HTML structure
  const html = `
    <div class="metacognition-widget" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: var(--surface-1, #FAFAF7); border-radius: 10px; border: 1px solid var(--surface-3, #E8E6DE);">

      <!-- Phase 1: Confidence Input -->
      <div class="phase-confidence" id="phase-confidence">
        <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 500; color: var(--ink-primary, #0E0E0C);">Confidence</h3>
        <p style="margin: 0 0 16px 0; font-size: 13px; color: var(--ink-secondary, #6B695F);">How confident are you in your answer?</p>

        <div style="margin-bottom: 16px;">
          <input
            type="range"
            id="confidence-slider"
            min="0"
            max="100"
            value="50"
            style="width: 100%; cursor: pointer; height: 4px; border-radius: 2px; background: var(--surface-3, #E8E6DE); outline: none; -webkit-appearance: none; appearance: none;"
          />
          <style>
            #confidence-slider::-webkit-slider-thumb {
              -webkit-appearance: none;
              appearance: none;
              width: 24px;
              height: 24px;
              border-radius: 50%;
              background: var(--signal-insight, #D97757);
              cursor: pointer;
              box-shadow: 0 2px 8px rgba(217, 119, 87, 0.3);
            }
            #confidence-slider::-moz-range-thumb {
              width: 24px;
              height: 24px;
              border-radius: 50%;
              background: var(--signal-insight, #D97757);
              cursor: pointer;
              border: none;
              box-shadow: 0 2px 8px rgba(217, 119, 87, 0.3);
            }
          </style>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
          <span style="font-size: 13px; color: var(--ink-tertiary, #A09E92);">Not confident</span>
          <span id="confidence-display" style="font-size: 24px; font-weight: 500; color: var(--signal-insight, #D97757);">50%</span>
          <span style="font-size: 13px; color: var(--ink-tertiary, #A09E92);">Fully confident</span>
        </div>

        <button
          id="submit-confidence-btn"
          style="width: 100%; padding: 12px 16px; background: var(--action-primary, #0E0E0C); color: var(--ink-inverse, #FAFAF7); border: none; border-radius: 10px; font-size: 16px; font-weight: 500; cursor: pointer; transition: background 120ms cubic-bezier(0.2, 0.0, 0.0, 1);"
        >Submit confidence</button>
      </div>

      <!-- Phase 2: Verification status + charts -->
      <div class="phase-result" id="phase-result" style="display: none;">
        <div style="margin-bottom: 24px; padding: 16px; background: var(--surface-0, #FFFFFF); border-radius: 10px; border-left: 4px solid var(--signal-insight, #D97757);">
          <p style="margin: 0 0 8px 0; font-size: 13px; font-weight: 500; color: var(--ink-secondary, #6B695F);">Verification status</p>
          <p id="result-text" style="margin: 0; font-size: 18px; font-weight: 500; color: var(--ink-primary, #0E0E0C);"></p>
          <p id="calibration-error-text" style="margin: 8px 0 0 0; font-size: 13px; color: var(--ink-tertiary, #A09E92);"></p>
        </div>

        <!-- Calibration Error Chart -->
        <div style="margin-bottom: 24px; padding: 16px; background: var(--surface-0, #FFFFFF); border-radius: 10px;">
          <h4 style="margin: 0 0 16px 0; font-size: 13px; font-weight: 500; color: var(--ink-secondary, #6B695F);">Recent calibration (up to 5 items)</h4>
          <canvas id="calibration-chart" width="300" height="150" style="max-width: 100%; height: auto;"></canvas>
        </div>

        <!-- Brier Score -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px;">
          <div style="padding: 16px; background: var(--surface-0, #FFFFFF); border-radius: 10px; border: 1px solid var(--surface-3, #E8E6DE); text-align: center;">
            <p style="margin: 0 0 8px 0; font-size: 12px; color: var(--ink-secondary, #6B695F); text-transform: uppercase; letter-spacing: 0.05em;">Brier Score</p>
            <p id="brier-score" style="margin: 0; font-size: 20px; font-weight: 500; color: var(--signal-insight, #D97757);">--</p>
            <p id="brier-quality" style="margin: 4px 0 0 0; font-size: 11px; color: var(--ink-tertiary, #A09E92);">Unavailable until verified outcomes exist</p>
          </div>
          <div style="padding: 16px; background: var(--surface-0, #FFFFFF); border-radius: 10px; border: 1px solid var(--surface-3, #E8E6DE); text-align: center;">
            <p style="margin: 0 0 8px 0; font-size: 12px; color: var(--ink-secondary, #6B695F); text-transform: uppercase; letter-spacing: 0.05em;">Verified records</p>
            <p id="record-count" style="margin: 0; font-size: 20px; font-weight: 500; color: var(--action-primary, #0E0E0C);">—</p>
            <p id="miscal-type" style="margin: 4px 0 0 0; font-size: 11px; color: var(--ink-tertiary, #A09E92);">Unavailable</p>
          </div>
        </div>

        <!-- Reliability Diagram -->
        <div style="padding: 16px; background: var(--surface-0, #FFFFFF); border-radius: 10px; border: 1px solid var(--surface-3, #E8E6DE);">
          <h4 style="margin: 0 0 16px 0; font-size: 13px; font-weight: 500; color: var(--ink-secondary, #6B695F);">Reliability diagram (10 bins)</h4>
          <canvas id="reliability-diagram" width="300" height="250" style="max-width: 100%; height: auto;"></canvas>
          <p style="margin: 12px 0 0 0; font-size: 11px; color: var(--ink-tertiary, #A09E92); line-height: 1.5;">The diagram appears only after answer outcomes are verified server-side.</p>
        </div>

        <button
          id="reset-btn"
          style="width: 100%; margin-top: 24px; padding: 12px 16px; background: var(--surface-2, #F3F2ED); color: var(--ink-primary, #0E0E0C); border: 1px solid var(--surface-3, #E8E6DE); border-radius: 10px; font-size: 16px; font-weight: 500; cursor: pointer; transition: background 120ms cubic-bezier(0.2, 0.0, 0.0, 1);"
        >Set confidence again</button>
      </div>
    </div>
  `;

  container.innerHTML = html;

  // State
  let currentConfidence = 50;
  let calibrationData = [];

  // DOM references
  const slider = container.querySelector('#confidence-slider');
  const display = container.querySelector('#confidence-display');
  const submitBtn = container.querySelector('#submit-confidence-btn');
  const resetBtn = container.querySelector('#reset-btn');
  const phaseConfidence = container.querySelector('.phase-confidence');
  const phaseResult = container.querySelector('.phase-result');

  // Event listeners
  slider.addEventListener('input', (e) => {
    currentConfidence = parseInt(e.target.value, 10);
    display.textContent = `${currentConfidence}%`;
  });

  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    try {
      const response = await authenticatedFetch('/api/metacognition/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          problemId: problemId || null,
          confidence: currentConfidence / 100,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (response.status === 401 || data.status === 'auth_required' || data.code === 'AUTH_REQUIRED') {
        showAuthRequired(data.error || data.message);
        return;
      }
      if (data.status === 'verification_unavailable') {
        showVerificationUnavailable(data.message);
      } else if (!response.ok) {
        showRequestError(data.error || 'Unable to process confidence.');
        return;
      } else {
        showVerificationUnavailable('The server did not return a verified outcome. No metric was calculated.');
      }

      await fetchAndUpdateMetrics();

      if (onSubmit) {
        onSubmit(currentConfidence / 100);
      }
    } catch (error) {
      console.error('Error recording calibration:', error);
      if (error?.status === 401 || error?.code === 'AUTH_REQUIRED') {
        showAuthRequired('Authentication is required to submit confidence.');
      } else {
        showRequestError('Confidence could not be submitted. Please try again.');
      }
    } finally {
      submitBtn.disabled = false;
    }
  });

  resetBtn.addEventListener('click', () => {
    currentConfidence = 50;
    slider.value = 50;
    display.textContent = '50%';
    phaseConfidence.style.display = 'block';
    phaseResult.style.display = 'none';
  });

  function showVerificationUnavailable(message) {
    const resultText = container.querySelector('#result-text');
    const calibrationErrorText = container.querySelector('#calibration-error-text');

    resultText.textContent = 'Verification unavailable';
    resultText.style.color = 'var(--ink-secondary, #6B695F)';
    calibrationErrorText.textContent = message || 'No calibration record was written.';

    phaseConfidence.style.display = 'none';
    phaseResult.style.display = 'block';
    renderUnavailableMetrics();
  }

  function showAuthRequired(message) {
    const resultText = container.querySelector('#result-text');
    const calibrationErrorText = container.querySelector('#calibration-error-text');

    resultText.textContent = 'Authentication required';
    resultText.style.color = 'var(--signal-friction, #B85450)';
    calibrationErrorText.textContent = message || 'Sign in again before submitting confidence.';

    phaseConfidence.style.display = 'none';
    phaseResult.style.display = 'block';
    renderUnavailableMetrics();
  }

  function showRequestError(message) {
    const resultText = container.querySelector('#result-text');
    const calibrationErrorText = container.querySelector('#calibration-error-text');

    resultText.textContent = 'Unable to submit confidence';
    resultText.style.color = 'var(--signal-friction, #B85450)';
    calibrationErrorText.textContent = message || 'Please try again.';

    phaseConfidence.style.display = 'none';
    phaseResult.style.display = 'block';
    renderUnavailableMetrics();
  }

  async function fetchAndUpdateMetrics() {
    try {
      const response = await authenticatedFetch(`/api/metacognition/calibration/${userId}`);
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 || data.status === 'auth_required' || data.code === 'AUTH_REQUIRED') {
        showAuthRequired(data.error || data.message);
        return;
      }
      if (data.status === 'verification_unavailable') {
        renderUnavailableMetrics();
        return;
      }
      if (!response.ok) {
        showRequestError(data.error || 'Unable to retrieve calibration status.');
        return;
      }
      calibrationData = Array.isArray(data.records) ? data.records : [];

      // Update Brier Score
      const brierEl = container.querySelector('#brier-score');
      const qualityEl = container.querySelector('#brier-quality');
      brierEl.textContent = Number.isFinite(data.brierScore) ? data.brierScore.toFixed(4) : '—';
      qualityEl.textContent = data.calibrationQuality || 'Unavailable';

      // Update record count & miscalibration type
      const recordEl = container.querySelector('#record-count');
      const miscalEl = container.querySelector('#miscal-type');
      recordEl.textContent = data.recordCount ?? '—';
      miscalEl.textContent = data.miscalibrationType || 'Unavailable';

      // Update charts
      updateCalibrationChart(calibrationData);
      updateReliabilityDiagram(data.curve || []);
    } catch (error) {
      console.error('Error fetching metrics:', error);
      if (error?.status === 401 || error?.code === 'AUTH_REQUIRED') {
        showAuthRequired('Authentication is required to view calibration status.');
      } else {
        showRequestError('Unable to retrieve calibration status.');
      }
    }
  }

  function renderUnavailableMetrics() {
    calibrationData = [];
    const brierEl = container.querySelector('#brier-score');
    const qualityEl = container.querySelector('#brier-quality');
    const recordEl = container.querySelector('#record-count');
    const miscalEl = container.querySelector('#miscal-type');
    if (brierEl) brierEl.textContent = '—';
    if (qualityEl) qualityEl.textContent = 'Unavailable until verified outcomes exist';
    if (recordEl) recordEl.textContent = '—';
    if (miscalEl) miscalEl.textContent = 'Unavailable';
    updateCalibrationChart([]);
    updateReliabilityDiagram([]);
  }

  function updateCalibrationChart(records) {
    const canvas = container.querySelector('#calibration-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const lastN = records.slice(0, 5).reverse(); // Last 5, chronological

    ctx.fillStyle = 'var(--surface-1, #FAFAF7)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!lastN || lastN.length === 0) {
      ctx.fillStyle = 'var(--ink-tertiary, #A09E92)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Verification unavailable', canvas.width / 2, canvas.height / 2);
      return;
    }

    // Simple confidence chart. Correctness is deliberately not rendered from
    // a client-controlled field; the server must provide a verified outcome.
    const padding = 30;
    const chartWidth = canvas.width - padding * 2;
    const chartHeight = canvas.height - padding * 2;
    const barWidth = chartWidth / (lastN.length * 2);

    // Draw axes
    ctx.strokeStyle = 'var(--surface-3, #E8E6DE)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, canvas.height - padding);
    ctx.lineTo(canvas.width - padding, canvas.height - padding);
    ctx.stroke();

    // Draw bars
    lastN.forEach((record, i) => {
      const x = padding + i * (barWidth * 2.5);

      // Confidence bar
      const confidenceHeight = record.confidence * chartHeight;
      ctx.fillStyle = 'rgba(217, 119, 87, 0.6)'; // signal-insight
      ctx.fillRect(x, canvas.height - padding - confidenceHeight, barWidth, confidenceHeight);

    });

    // Legend
    ctx.fillStyle = 'var(--ink-secondary, #6B695F)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Confidence', padding + 5, padding - 10);
    ctx.fillStyle = 'rgba(217, 119, 87, 0.6)';
    ctx.fillRect(padding + 45, padding - 18, 8, 8);
  }

  function updateReliabilityDiagram(curveData) {
    const canvas = container.querySelector('#reliability-diagram');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const padding = 40;
    const chartWidth = canvas.width - padding * 2;
    const chartHeight = canvas.height - padding * 2;

    // Clear
    ctx.fillStyle = 'var(--surface-1, #FAFAF7)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!curveData || curveData.length === 0) {
      ctx.fillStyle = 'var(--ink-tertiary, #A09E92)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Verification unavailable', canvas.width / 2, canvas.height / 2);
      return;
    }

    // Draw axes
    ctx.strokeStyle = 'var(--surface-3, #E8E6DE)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, canvas.height - padding);
    ctx.lineTo(canvas.width - padding, canvas.height - padding);
    ctx.stroke();

    // Draw perfect calibration line (diagonal)
    ctx.strokeStyle = 'rgba(160, 158, 146, 0.3)'; // ink-tertiary light
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padding, canvas.height - padding); // (0, 0)
    ctx.lineTo(canvas.width - padding, padding); // (1, 1)
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw reliability curve
    if (curveData && curveData.length > 0) {
      ctx.strokeStyle = 'var(--signal-insight, #D97757)';
      ctx.lineWidth = 2;
      ctx.beginPath();

      curveData.forEach((bin, i) => {
        const x = padding + bin.predicted * chartWidth;
        const y = canvas.height - padding - bin.actual * chartHeight;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();

      // Draw points
      curveData.forEach((bin) => {
        if (bin.count > 0) {
          const x = padding + bin.predicted * chartWidth;
          const y = canvas.height - padding - bin.actual * chartHeight;

          ctx.fillStyle = 'var(--signal-insight, #D97757)';
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fill();

          // Small label: count
          ctx.fillStyle = 'var(--ink-tertiary, #A09E92)';
          ctx.font = '9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(bin.count.toString(), x, y - 12);
        }
      });
    }

    // Axis labels
    ctx.fillStyle = 'var(--ink-secondary, #6B695F)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Predicted Confidence', canvas.width / 2, canvas.height - 5);

    ctx.save();
    ctx.translate(10, canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Actual Accuracy', 0, 0);
    ctx.restore();

    // Axis ticks
    for (let i = 0; i <= 5; i++) {
      const val = i / 5;
      const x = padding + val * chartWidth;
      const y = canvas.height - padding;

      ctx.fillStyle = 'var(--ink-tertiary, #A09E92)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText((i / 5).toFixed(1), x, y + 15);
    }
  }

  // Initial load
  return {
    getState: () => ({ confidence: currentConfidence, data: calibrationData }),
    reset: () => resetBtn.click(),
  };
}
