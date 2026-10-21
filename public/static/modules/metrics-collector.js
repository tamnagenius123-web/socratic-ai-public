/**
 * Socratic AI Metrics Collector
 * Captures real-time keystroke timing events on frontend
 * Debounces every 500ms, sends batch to backend on session end
 *
 * Usage:
 *   const collector = new MetricsCollector(sessionId, userId);
 *   // Automatically attached to input elements with data-collect-keystrokes
 *   // Call collector.flush() on session end
 */

class MetricsCollector {
  constructor(sessionId, userId, apiEndpoint = '/api/analytics/typing-events') {
    this.sessionId = sessionId;
    this.userId = userId;
    this.apiEndpoint = apiEndpoint;
    this.events = [];
    this.debounceTimer = null;
    this.debounceMs = 500;
    this.isEnabled = true;

    this.attachListeners();
  }

  /**
   * Attach keystroke listeners to all monitored inputs
   */
  attachListeners() {
    const inputs = document.querySelectorAll('[data-collect-keystrokes]');
    inputs.forEach((input) => {
      input.addEventListener('keydown', (e) => this.recordKeystroke(e, 'keydown'));
      input.addEventListener('keyup', (e) => this.recordKeystroke(e, 'keyup'));
      input.addEventListener('input', (e) => this.recordKeystroke(e, 'input'));
    });

    // Also attach to contenteditable divs
    document.addEventListener('keydown', (e) => {
      if (
        e.target?.contentEditable === 'true' &&
        !e.target.classList.contains('ignore-metrics')
      ) {
        this.recordKeystroke(e, 'keydown');
      }
    });

    // Flush on page unload
    window.addEventListener('beforeunload', () => {
      if (this.events.length > 0) {
        // Use sendBeacon for reliability
        this.sendBeacon();
      }
    });
  }

  /**
   * Record a single keystroke event
   * @param {KeyboardEvent} event - The keyboard event
   * @param {string} type - Event type (keydown, keyup, input)
   */
  recordKeystroke(event, type) {
    if (!this.isEnabled) return;

    // Filter out meta keys, navigation, etc.
    if (this.shouldIgnore(event)) return;

    this.events.push({
      timestamp: Date.now(),
      keyCode: event.keyCode || event.which,
      key: event.key || '',
      type: type,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
    });

    // Debounce batch processing
    this.scheduleBatch();
  }

  /**
   * Check if keystroke should be ignored
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  shouldIgnore(event) {
    const code = event.keyCode || event.which;

    // Ignore meta keys
    const metaKeys = [
      16, // Shift
      17, // Ctrl
      18, // Alt
      91, // Win/Cmd
      19, // Pause
      20, // Caps Lock
      27, // Escape
      33, 34, 35, 36, // Page keys
      45, // Insert
      91, 93, // Win/Cmd keys
    ];

    if (metaKeys.includes(code)) return true;

    // Allow printable keys and backspace/delete
    if (code === 8 || code === 46 || (code >= 32 && code <= 126)) {
      return false;
    }

    // Allow tab, enter
    if (code === 9 || code === 13) {
      return false;
    }

    return true;
  }

  /**
   * Schedule debounced batch processing
   */
  scheduleBatch() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      if (this.events.length > 0) {
        this.processBatch();
      }
    }, this.debounceMs);
  }

  /**
   * Process accumulated keystroke events into metrics
   */
  processBatch() {
    if (this.events.length === 0) return;

    // Calculate inter-keystroke delays
    const deltas = [];
    for (let i = 1; i < this.events.length; i++) {
      const delta = this.events[i].timestamp - this.events[i - 1].timestamp;
      if (delta > 0 && delta <= 5000) {
        // Filter outliers
        deltas.push(delta);
      }
    }

    // Send batch
    if (deltas.length > 0) {
      this.sendBatch({
        sessionId: this.sessionId,
        userId: this.userId,
        eventCount: this.events.length,
        deltaCount: deltas.length,
        deltas: deltas,
        averageDelta: Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length),
        minDelta: Math.min(...deltas),
        maxDelta: Math.max(...deltas),
        timestamp: Date.now(),
      });
    }

    // Keep only last 10 events for sliding window
    this.events = this.events.slice(-10);
  }

  /**
   * Send keystroke batch to backend
   * @param {Object} data - Batch data
   */
  async sendBatch(data) {
    try {
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        console.error('[MetricsCollector] Batch send failed:', response.status);
      }
    } catch (error) {
      console.error('[MetricsCollector] Network error:', error);
    }
  }

  /**
   * Send batch using sendBeacon (for page unload)
   */
  sendBeacon() {
    if (this.events.length === 0) return;

    const deltas = [];
    for (let i = 1; i < this.events.length; i++) {
      const delta = this.events[i].timestamp - this.events[i - 1].timestamp;
      if (delta > 0 && delta <= 5000) {
        deltas.push(delta);
      }
    }

    if (deltas.length === 0) return;

    const data = JSON.stringify({
      sessionId: this.sessionId,
      userId: this.userId,
      eventCount: this.events.length,
      deltaCount: deltas.length,
      deltas: deltas,
      averageDelta: Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length),
      timestamp: Date.now(),
    });

    navigator.sendBeacon(this.apiEndpoint, data);
  }

  /**
   * Manually flush all pending events
   */
  flush() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    if (this.events.length > 0) {
      this.processBatch();
      this.sendBeacon();
    }

    this.events = [];
  }

  /**
   * Enable/disable collection
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.isEnabled = enabled;
  }

  /**
   * Get current event count (for testing)
   * @returns {number}
   */
  getEventCount() {
    return this.events.length;
  }

  /**
   * Load metrics collector globally (for inline script)
   */
  static init(sessionId, userId) {
    window.metricsCollector = new MetricsCollector(sessionId, userId);
    console.log('[MetricsCollector] Initialized for session:', sessionId);
  }
}

// Export for use in modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MetricsCollector;
}
