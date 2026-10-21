/**
 * Metacognition Calibration Tracker
 * Brier Score & Reliability Diagram (10-bin calibration curve)
 * Reference: Murphy 1973, Niculescu-Mizil & Caruana 2005
 * v35 Feature: Stealth Assessment confidence ≠ correctness
 */

export interface CalibrationRecord {
  userId: string;
  sessionId: string;
  problemId?: string;
  confidence: number;  // 0-1
  correct: 0 | 1;
  calibrationError: number;  // |confidence - correct|
  recordedAt: number;
}

export interface CalibrationBinData {
  bin: number;  // bin index 0-9 (0-10%, 10-20%, ..., 90-100%)
  predicted: number;  // mean confidence in this bin
  actual: number;  // mean accuracy in this bin (0 or 1)
  count: number;  // number of records in this bin
}

/**
 * Compute Brier Score
 * BS = (1/n) * ∑(confidence_i - correct_i)²
 * Range: 0 (perfect) to 1 (worst)
 * Reference: Brier 1950
 */
export function computeBrierScore(records: CalibrationRecord[]): number {
  if (records.length === 0) return 0;

  const sumSquaredErrors = records.reduce((sum, record) => {
    const error = record.confidence - record.correct;
    return sum + (error * error);
  }, 0);

  return sumSquaredErrors / records.length;
}

/**
 * Compute Calibration Curve (Reliability Diagram)
 * Divides predictions into 10 bins by confidence percentile
 * For each bin, calculates mean predicted confidence vs actual accuracy
 * Used to detect miscalibration patterns (overconfidence/underconfidence)
 */
export function computeCalibrationCurve(
  records: CalibrationRecord[],
  bins: number = 10
): CalibrationBinData[] {
  if (records.length === 0) {
    return Array.from({ length: bins }, (_, i) => ({
      bin: i,
      predicted: 0,
      actual: 0,
      count: 0,
    }));
  }

  // Initialize bins
  const binData: CalibrationBinData[] = Array.from({ length: bins }, (_, i) => ({
    bin: i,
    predicted: 0,
    actual: 0,
    count: 0,
  }));

  // Assign each record to bin based on confidence
  // bin 0 = [0, 0.1), bin 1 = [0.1, 0.2), ..., bin 9 = [0.9, 1.0]
  records.forEach((record) => {
    let binIndex = Math.floor(record.confidence * bins);
    // Handle edge case: confidence = 1.0 should go to bin 9
    if (binIndex >= bins) {
      binIndex = bins - 1;
    }

    const bin = binData[binIndex];
    bin.predicted += record.confidence;
    bin.actual += record.correct;
    bin.count += 1;
  });

  // Compute averages for each bin
  binData.forEach((bin) => {
    if (bin.count > 0) {
      bin.predicted = bin.predicted / bin.count;
      bin.actual = bin.actual / bin.count;
    }
  });

  return binData;
}

/**
 * Helper: Format Brier Score for display
 * Smaller is better. Typical range for calibrated predictions: 0.15-0.25
 */
export function formatBrierScore(score: number): string {
  return score.toFixed(4);
}

/**
 * Helper: Classify calibration quality
 * Based on Brier Score thresholds
 */
export function classifyCalibrationQuality(
  brierScore: number
): 'excellent' | 'good' | 'fair' | 'poor' {
  if (brierScore < 0.10) return 'excellent';
  if (brierScore < 0.20) return 'good';
  if (brierScore < 0.30) return 'fair';
  return 'poor';
}

/**
 * Helper: Detect miscalibration type
 * Compares predicted vs actual in calibration curve
 */
export function detectMiscalibrationType(
  curve: CalibrationBinData[]
): 'overconfident' | 'underconfident' | 'well-calibrated' {
  // Filter bins with at least 5 samples for reliability
  const reliableBins = curve.filter((b) => b.count >= 5);
  if (reliableBins.length === 0) return 'well-calibrated';

  // Calculate mean difference (predicted - actual)
  const meanDiff = reliableBins.reduce(
    (sum, bin) => sum + (bin.predicted - bin.actual),
    0
  ) / reliableBins.length;

  // Threshold: ±0.05 tolerance
  if (meanDiff > 0.05) return 'overconfident';
  if (meanDiff < -0.05) return 'underconfident';
  return 'well-calibrated';
}
