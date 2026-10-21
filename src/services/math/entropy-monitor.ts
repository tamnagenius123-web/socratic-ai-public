// Semantic Entropy Monitor
// Run 3 evaluation samples at temperature=0.8, compute score variance
// If std_dev > 15: flag as "high" entropy → use conservative (min) score
// If std_dev > 25: flag as "critical" → alert admin
//
// Formula: H(X) = -Σ P(x) · log₂ P(x)
// Simplified: We use sample variance of radar score averages as proxy

export interface EntropyResult {
  sessionId: string;
  turnNumber: number;
  sampleScores: number[][]; // 3 samples, each = [claim, evidence, reasoning, consistency, relevance]
  meanScore: number;
  stdDev: number;
  entropyFlag: 'normal' | 'high' | 'critical';
  actionTaken: 'none' | 'use_min' | 'alert_admin';
  conservativeScore?: number; // Used when flag is 'high'
}

// ==============================================
// Compute standard deviation of sample averages
// ==============================================
export function computeSemanticEntropy(
  samples: { claim_clarity: number; evidence_use: number; reasoning_strength: number; consistency: number; relevance: number }[],
): { mean: number; stdDev: number; flag: 'normal' | 'high' | 'critical'; minAvg: number } {
  if (samples.length === 0) {
    return { mean: 0, stdDev: 0, flag: 'normal', minAvg: 0 };
  }

  // Compute average score per sample (0-100 scale)
  const avgs = samples.map(s =>
    ((s.claim_clarity + s.evidence_use + s.reasoning_strength + s.consistency + s.relevance) / 5) * 20
  );

  const mean = avgs.reduce((a, b) => a + b, 0) / avgs.length;
  const variance = avgs.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / avgs.length;
  const stdDev = Math.sqrt(variance);
  const minAvg = Math.min(...avgs);

  let flag: 'normal' | 'high' | 'critical' = 'normal';
  if (stdDev > 25) flag = 'critical';
  else if (stdDev > 15) flag = 'high';

  return { mean, stdDev, flag, minAvg };
}

// ==============================================
// Build entropy log insert SQL
// ==============================================
export function buildEntropyLogSQL(
  sessionId: string,
  turnNumber: number,
  samples: number[][],
  mean: number,
  stdDev: number,
  flag: string,
  action: string,
): { sql: string; binds: unknown[] } {
  return {
    sql: `INSERT INTO semantic_entropy_log (session_id, turn_number, sample_scores, mean_score, std_dev, entropy_flag, action_taken, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    binds: [sessionId, turnNumber, JSON.stringify(samples), mean, stdDev, flag, action, Date.now()],
  };
}

// ==============================================
// Determine action based on entropy flag
// ==============================================
export function getEntropyAction(flag: 'normal' | 'high' | 'critical'): 'none' | 'use_min' | 'alert_admin' {
  switch (flag) {
    case 'critical': return 'alert_admin';
    case 'high': return 'use_min';
    default: return 'none';
  }
}
