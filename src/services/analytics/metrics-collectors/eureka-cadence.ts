/**
 * Eureka Cadence Collector
 * Computes typing rhythm pattern to detect thought activity (eureka moments)
 * Short pauses (100ms) → active thinking; long pauses → stuck state
 *
 * Reference: Stealth Assessment, pp. 59-62
 */

export interface KeystrokeEvent {
  timestamp: number;
  type: 'keystroke' | 'space' | 'backspace';
}

export interface EurekaCadenceResult {
  rawScore: number;
  normalizedScore: number;
  deltaBucket: number[];
  shortPauseCount: number;
  totalPauseCount: number;
  pauseRatio: number;
}

const PAUSE_THRESHOLD_MS = 100; // Short vs long pause threshold

/**
 * Compute eureka cadence from keystroke timing events
 * @param events - Keystroke events with timestamps
 * @returns Score (0-1) indicating thought activity level
 */
export function computeEurekaCadence(events: KeystrokeEvent[]): EurekaCadenceResult {
  if (events.length < 5) {
    return {
      rawScore: 0.3,
      normalizedScore: 0.3,
      deltaBucket: [],
      shortPauseCount: 0,
      totalPauseCount: 0,
      pauseRatio: 0,
    };
  }

  // Compute time deltas between consecutive keystroke events
  const deltas: number[] = [];
  for (let i = 1; i < events.length; i++) {
    const delta = events[i].timestamp - events[i - 1].timestamp;
    // Filter outliers: remove pauses > 5 seconds (session break)
    if (delta > 0 && delta <= 5000) {
      deltas.push(delta);
    }
  }

  if (deltas.length === 0) {
    return {
      rawScore: 0.3,
      normalizedScore: 0.3,
      deltaBucket: [],
      shortPauseCount: 0,
      totalPauseCount: 0,
      pauseRatio: 0,
    };
  }

  // Count short vs long pauses
  const shortPauseCount = deltas.filter((d) => d <= PAUSE_THRESHOLD_MS).length;
  const pauseRatio = shortPauseCount / deltas.length;

  // Sigmoid transformation: ratio 50% = score 0.5
  const sigmoid = 1 / (1 + Math.exp(-10 * (pauseRatio - 0.5)));
  const normalizedScore = Math.max(0, Math.min(1, sigmoid));

  return {
    rawScore: pauseRatio,
    normalizedScore,
    deltaBucket: deltas,
    shortPauseCount,
    totalPauseCount: deltas.length,
    pauseRatio,
  };
}

/**
 * Debounce keystroke events into buckets
 * Collects events over 500ms window, then processes as batch
 * @param events - Raw keystroke events
 * @param windowMs - Debounce window in milliseconds
 * @returns Bucketed events ready for processing
 */
export function debounceKeystrokeEvents(
  events: KeystrokeEvent[],
  windowMs: number = 500
): KeystrokeEvent[][] {
  if (events.length === 0) return [];

  const buckets: KeystrokeEvent[][] = [];
  let currentBucket: KeystrokeEvent[] = [];
  let bucketStart = events[0].timestamp;

  for (const event of events) {
    if (event.timestamp - bucketStart > windowMs) {
      if (currentBucket.length > 0) {
        buckets.push(currentBucket);
      }
      currentBucket = [event];
      bucketStart = event.timestamp;
    } else {
      currentBucket.push(event);
    }
  }

  if (currentBucket.length > 0) {
    buckets.push(currentBucket);
  }

  return buckets;
}

/**
 * Process keystroke buckets to compute per-bucket eureka cadence
 * @param buckets - Bucketed keystroke events
 * @returns Array of cadence scores (one per bucket)
 */
export function processBuckets(buckets: KeystrokeEvent[][]): number[] {
  return buckets.map((bucket) => computeEurekaCadence(bucket).normalizedScore);
}
