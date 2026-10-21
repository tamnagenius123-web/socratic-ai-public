/**
 * Flow Index Collector
 * Composite indicator of learning flow state using:
 * - LinUCB reward (adaptive exploration-exploitation balance)
 * - Response latency variance (consistency in engagement speed)
 * - Accuracy moving average (competence feedback loop)
 *
 * Reference: Stealth Assessment, pp. 59-62 (Adaptive Engagement, Learning Flow)
 */

export interface FlowIndexInput {
  linubReward: number; // [0, 1] - average reward from recent turns
  responseLatencies: number[]; // milliseconds per response
  accuracies: number[]; // [0, 1] per turn (recent turns)
  windowSize?: number; // number of recent turns to consider (default: 5)
}

export interface FlowIndexResult {
  flowScore: number; // composite score [0, 1]
  rewardComponent: number; // normalized LinUCB reward
  latencyComponent: number; // latency consistency (inverse variance)
  accuracyComponent: number; // moving average accuracy
  latencyVariance: number; // raw variance
  latencyMean: number; // mean response time
  accuracy5MA: number; // 5-turn moving average accuracy
  flowState: 'low' | 'moderate' | 'high'; // classified state
}

const DEFAULT_WINDOW_SIZE = 5;
const EXPECTED_LATENCY_MS = 2000; // Expected response time (2 seconds)
const LATENCY_VARIANCE_MAX = 10000; // Max latency variance threshold

/**
 * Compute variance of latency values
 * @param latencies - Response latencies in milliseconds
 * @returns Variance (squared deviations)
 */
export function computeLatencyVariance(latencies: number[]): number {
  if (latencies.length < 2) return 0;

  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const squaredDiffs = latencies.map((l) => Math.pow(l - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / latencies.length;

  return variance;
}

/**
 * Compute moving average of accuracy
 * @param accuracies - Array of accuracy scores [0, 1]
 * @param windowSize - Window size for moving average (default: 5)
 * @returns Most recent moving average
 */
export function computeAccuracyMA(accuracies: number[], windowSize: number = DEFAULT_WINDOW_SIZE): number {
  if (accuracies.length === 0) return 0;

  const window = Math.min(windowSize, accuracies.length);
  const recentAccuracies = accuracies.slice(-window);
  const sum = recentAccuracies.reduce((a, b) => a + b, 0);

  return sum / window;
}

/**
 * Normalize latency variance to [0, 1] scale
 * Lower variance → higher score (more consistent engagement)
 * @param variance - Raw latency variance
 * @returns Normalized score [0, 1]
 */
export function normalizeLatencyVariance(variance: number): number {
  if (variance === 0) return 1;

  // Use inverse sigmoid transformation
  // High variance → low score
  const normalized = Math.max(0, Math.min(1, 1 - variance / LATENCY_VARIANCE_MAX));

  return normalized;
}

/**
 * Compute mean response latency
 * @param latencies - Response latencies in milliseconds
 * @returns Mean latency
 */
export function computeLatencyMean(latencies: number[]): number {
  if (latencies.length === 0) return 0;

  return latencies.reduce((a, b) => a + b, 0) / latencies.length;
}

/**
 * Compute flow index composite score
 * Weights: reward (40%) + latency consistency (30%) + accuracy (30%)
 * @param input - Flow index computation input
 * @returns Detailed flow index result
 */
export function computeFlowIndex(input: FlowIndexInput): FlowIndexResult {
  const windowSize = input.windowSize ?? DEFAULT_WINDOW_SIZE;

  // Component 1: LinUCB reward (already normalized [0, 1])
  const rewardComponent = Math.max(0, Math.min(1, input.linubReward ?? 0.5));

  // Component 2: Latency consistency (inverse variance)
  const latencyVariance = computeLatencyVariance(input.responseLatencies);
  const latencyComponent = normalizeLatencyVariance(latencyVariance);

  // Component 3: Accuracy moving average
  const accuracy5MA = computeAccuracyMA(input.accuracies, windowSize);
  const accuracyComponent = Math.max(0, Math.min(1, accuracy5MA));

  // Composite: weighted sum
  const flowScore = 0.4 * rewardComponent + 0.3 * latencyComponent + 0.3 * accuracyComponent;

  // Classify flow state
  let flowState: 'low' | 'moderate' | 'high';
  if (flowScore >= 0.7) {
    flowState = 'high';
  } else if (flowScore >= 0.4) {
    flowState = 'moderate';
  } else {
    flowState = 'low';
  }

  return {
    flowScore: Math.max(0, Math.min(1, flowScore)),
    rewardComponent,
    latencyComponent,
    accuracyComponent,
    latencyVariance,
    latencyMean: computeLatencyMean(input.responseLatencies),
    accuracy5MA,
    flowState,
  };
}

/**
 * Update flow index with new data point
 * Maintains running statistics for incremental computation
 * @param current - Current flow index result
 * @param newLatency - New response latency (ms)
 * @param newAccuracy - New accuracy score [0, 1]
 * @param newReward - Updated LinUCB reward
 * @param windowSize - Window size for moving averages
 * @returns Updated flow index result
 */
export function updateFlowIndex(
  current: FlowIndexResult,
  newLatency: number,
  newAccuracy: number,
  newReward: number,
  windowSize: number = DEFAULT_WINDOW_SIZE
): FlowIndexResult {
  // Simulate adding new data point to window
  const updatedInput: FlowIndexInput = {
    linubReward: newReward,
    responseLatencies: [newLatency], // In practice, maintain rolling window
    accuracies: [newAccuracy],
    windowSize,
  };

  return computeFlowIndex(updatedInput);
}

/**
 * Batch compute flow index for multiple sessions
 * @param inputs - Array of flow index inputs
 * @returns Array of flow index results
 */
export function computeBatch(inputs: FlowIndexInput[]): FlowIndexResult[] {
  return inputs.map((input) => computeFlowIndex(input));
}

/**
 * Aggregate flow metrics across session
 * @param results - Array of flow index results from turns
 * @returns Session-level aggregated statistics
 */
export function aggregateSession(
  results: FlowIndexResult[]
): {
  avgFlowScore: number;
  maxFlowScore: number;
  minFlowScore: number;
  flowTrend: 'improving' | 'stable' | 'declining';
  highFlowTurns: number;
  averageLatency: number;
  overallAccuracy: number;
  dominantFlowState: 'low' | 'moderate' | 'high';
} {
  if (results.length === 0) {
    return {
      avgFlowScore: 0,
      maxFlowScore: 0,
      minFlowScore: 0,
      flowTrend: 'stable',
      highFlowTurns: 0,
      averageLatency: 0,
      overallAccuracy: 0,
      dominantFlowState: 'low',
    };
  }

  const scores = results.map((r) => r.flowScore);
  const avgFlowScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const maxFlowScore = Math.max(...scores);
  const minFlowScore = Math.min(...scores);

  // Compute trend (first 1/3 vs last 1/3)
  const firstThird = Math.ceil(results.length / 3);
  const earlyScores = scores.slice(0, firstThird);
  const lateScores = scores.slice(-firstThird);
  const earlyAvg = earlyScores.reduce((a, b) => a + b, 0) / earlyScores.length;
  const lateAvg = lateScores.reduce((a, b) => a + b, 0) / lateScores.length;

  let flowTrend: 'improving' | 'stable' | 'declining';
  if (lateAvg > earlyAvg + 0.1) {
    flowTrend = 'improving';
  } else if (lateAvg < earlyAvg - 0.1) {
    flowTrend = 'declining';
  } else {
    flowTrend = 'stable';
  }

  const highFlowTurns = results.filter((r) => r.flowState === 'high').length;
  const avgLatency = results.reduce((sum, r) => sum + r.latencyMean, 0) / results.length;
  const overallAccuracy = results.reduce((sum, r) => sum + r.accuracy5MA, 0) / results.length;

  // Dominant flow state
  const stateCounts = { low: 0, moderate: 0, high: 0 };
  results.forEach((r) => {
    stateCounts[r.flowState]++;
  });
  const dominantFlowState = Object.entries(stateCounts).sort(([, a], [, b]) => b - a)[0][0] as
    | 'low'
    | 'moderate'
    | 'high';

  return {
    avgFlowScore,
    maxFlowScore,
    minFlowScore,
    flowTrend,
    highFlowTurns,
    averageLatency: Math.round(avgLatency),
    overallAccuracy: Math.round(overallAccuracy * 100) / 100,
    dominantFlowState,
  };
}
