/**
 * Validity Checker Service
 * Automated validation pipeline for new indicator proposals in Socratic AI
 *
 * Usage:
 *   const report = await analyzeNewIndicator(newDef, existingIndicators, historicalData);
 *   if (report.recommendation === 'add') {
 *     addIndicatorToModel(newDef);
 *   }
 *
 * Reference: Shute & Ventura (2013), INDICATOR_EXPANSION_VALIDITY_GUIDE.md
 */

export interface IndicatorDefinition {
  id: string;
  name: string;
  axis: 'persistence' | 'creativity' | 'physics' | 'problem_solving';
  description: string;
  formula: string; // e.g., "count(action_type='restart')"
  expectedDirection: 'higher_is_better' | 'lower_is_better';
  competencyNode: string; // e.g., "Persistence", "Fluency"
}

export interface MicroScore {
  studentId: string;
  indicatorId: string;
  value: number;
  timestamp: number;
  context?: Record<string, any>;
}

export interface MicroScoreBatch {
  studentId: string;
  indicators: Record<string, number>; // indicatorId -> value
  externalCriteria?: Record<string, number>; // e.g., gpa, physics_score
  timestamp: number;
}

export interface ValidityReport {
  indicatorId: string;
  conceptualAlignment: {
    isValid: boolean;
    competencyNode: string;
    shcuteReference: string;
    observableBehavior: string;
  };
  axisCorrelation: {
    meanCorrelationWithAxis: number;
    expectedRangeMin: number;
    expectedRangeMax: number;
    withinExpectedRange: boolean;
    problematicPairs?: Array<{
      existingIndicatorId: string;
      correlation: number;
      status: 'too_weak' | 'too_strong' | 'expected';
    }>;
  };
  redundancyAnalysis: {
    maxCorrelationWithExisting: number;
    redundantIndicatorId?: string;
    hasRedundancy: boolean; // true if r >= 0.90
    mergeCandidate?: {
      indicatorId: string;
      correlation: number;
      recommendedApproach: 'remove' | 'merge' | 'conditional_keep';
    };
  };
  varianceExplained: {
    incrementalVariance: number; // ΔR² as decimal (0.0 - 1.0)
    discriminationIndex: number; // (high_mean - low_mean) / SD
    parsimonyScore: 'low' | 'medium' | 'high'; // based on ΔR²
    sufficientForInclusion: boolean; // ΔR² >= 0.02
  };
  externalValidation: {
    constructRelatedCriteria: Array<{
      criterionName: string;
      correlation: number;
      expectedMin: number;
      isValid: boolean;
    }>;
    constructUnrelatedCriteria: Array<{
      criterionName: string;
      correlation: number;
      expectedMax: number;
      isValid: boolean;
    }>;
    overallExternalValidity: boolean;
  };
  reliabilityMetrics: {
    omegaTotal: number; // >= 0.70 = acceptable
    mcdonaldH: number; // >= 0.70 = acceptable
    splitHalfRho: number; // >= 0.60 = acceptable
    reliabilityAdequate: boolean;
    facetConsistency?: Record<string, number>;
  };
  recommendation: 'add' | 'merge_with' | 'conditional_add' | 'reject';
  recommendedMergeWith?: string;
  rationale: string;
  timestamp: number;
  version: string; // validity_checker version
}

// ============ AXIS CORRELATION EXPECTATIONS ============
// Reference: INDICATOR_EXPANSION_VALIDITY_GUIDE.md, Section 2.1

const AXIS_CORRELATION_EXPECTATIONS: Record<string, Record<string, [number, number]>> = {
  persistence: {
    'time_on_unsolved__restart_count': [0.4, 0.7],
    'time_on_unsolved__revisit_count': [0.3, 0.6],
    'restart_count__gold_trophy': [-0.2, 0.1],
    'revisit_count__gold_trophy': [0.0, 0.3],
  },
  creativity: {
    'fluency__flexibility': [0.2, 0.5],
    'fluency__originality': [0.1, 0.4],
    'flexibility__originality': [0.3, 0.6],
  },
  physics: {
    'lever_accuracy__pendulum_accuracy': [0.4, 0.7],
    'success_rate__concept_test': [0.5, 0.8],
  },
};

// ============ EXTERNAL CRITERION MAPPINGS ============

interface CriterionMapping {
  name: string;
  type: 'construct_related' | 'construct_unrelated';
  expectedCorrelation: [number, number]; // [min, max]
}

const EXTERNAL_CRITERIA: Record<string, CriterionMapping[]> = {
  persistence: [
    {
      name: 'GPA',
      type: 'construct_related',
      expectedCorrelation: [0.20, 0.40],
    },
    {
      name: 'course_completion_rate',
      type: 'construct_related',
      expectedCorrelation: [0.25, 0.45],
    },
    {
      name: 'PBMP_score',
      type: 'construct_related',
      expectedCorrelation: [0.35, 0.65],
    },
    {
      name: 'creativity_score',
      type: 'construct_unrelated',
      expectedCorrelation: [0.0, 0.15],
    },
  ],
  creativity: [
    {
      name: 'TTCT_divergent_thinking',
      type: 'construct_related',
      expectedCorrelation: [0.25, 0.55],
    },
    {
      name: 'portfolio_rating',
      type: 'construct_related',
      expectedCorrelation: [0.30, 0.60],
    },
    {
      name: 'creative_project_grade',
      type: 'construct_related',
      expectedCorrelation: [0.25, 0.50],
    },
    {
      name: 'GPA',
      type: 'construct_unrelated',
      expectedCorrelation: [0.0, 0.20],
    },
  ],
  physics: [
    {
      name: 'physics_concept_inventory',
      type: 'construct_related',
      expectedCorrelation: [0.40, 0.75],
    },
    {
      name: 'physics_course_grade',
      type: 'construct_related',
      expectedCorrelation: [0.35, 0.70],
    },
    {
      name: 'transfer_task_score',
      type: 'construct_related',
      expectedCorrelation: [0.30, 0.65],
    },
    {
      name: 'GPA',
      type: 'construct_unrelated',
      expectedCorrelation: [0.0, 0.20],
    },
  ],
};

// ============ MAIN ANALYSIS FUNCTION ============

export async function analyzeNewIndicator(
  newDef: IndicatorDefinition,
  existing: IndicatorDefinition[],
  historicalData: MicroScoreBatch[]
): Promise<ValidityReport> {
  const timestamp = Date.now();

  // Stage 1: Conceptual Alignment
  const conceptualAlignment = validateConceptualAlignment(newDef);

  // Stage 2: Axis Correlation Sanity Check
  const axisCorrelation = calculateAxisCorrelation(
    newDef,
    existing,
    historicalData
  );

  // Stage 3: Redundancy Detection
  const redundancyAnalysis = detectRedundancy(
    newDef,
    existing,
    historicalData,
    axisCorrelation.correlations
  );

  // Stage 4: Variance Explained & Discrimination
  const varianceExplained = calculateVarianceExplained(
    newDef,
    existing,
    historicalData
  );

  // Stage 5: External Validation
  const externalValidation = validateExternalCriteria(
    newDef,
    historicalData
  );

  // Reliability Metrics
  const reliabilityMetrics = calculateReliabilityMetrics(
    newDef,
    existing,
    historicalData
  );

  // Generate recommendation
  const { recommendation, rationale, recommendedMergeWith } = generateRecommendation(
    conceptualAlignment,
    axisCorrelation,
    redundancyAnalysis,
    varianceExplained,
    externalValidation,
    reliabilityMetrics
  );

  return {
    indicatorId: newDef.id,
    conceptualAlignment,
    axisCorrelation,
    redundancyAnalysis,
    varianceExplained,
    externalValidation,
    reliabilityMetrics,
    recommendation,
    recommendedMergeWith,
    rationale,
    timestamp,
    version: '1.0.0',
  };
}

// ============ STAGE 1: CONCEPTUAL ALIGNMENT ============

function validateConceptualAlignment(
  newDef: IndicatorDefinition
): ValidityReport['conceptualAlignment'] {
  // Mock implementation - would integrate with actual Shute references
  const shuteReferences: Record<string, string> = {
    persistence: 'pp. 39-56: "motivation to work hard despite challenging conditions"',
    creativity: 'pp. 46-56: "ability to produce solutions that are both novel and effective"',
    physics: 'pp. 53-72: Appendix 1 competency model',
  };

  // Check if competency node is recognized
  const validNodes = ['Persistence', 'Fluency', 'Flexibility', 'Originality', 'Physics Understanding'];
  const nodeIsValid = validNodes.includes(newDef.competencyNode);

  return {
    isValid: nodeIsValid,
    competencyNode: newDef.competencyNode,
    shcuteReference: shuteReferences[newDef.axis] || 'Unknown',
    observableBehavior: newDef.description,
  };
}

// ============ STAGE 2: AXIS CORRELATION ============

interface CorrelationData {
  correlations: Record<string, number>; // existingId -> newId correlation
  status: 'within_range' | 'too_weak' | 'too_strong';
  meanCorrelation: number;
}

function calculateAxisCorrelation(
  newDef: IndicatorDefinition,
  existing: IndicatorDefinition[],
  historicalData: MicroScoreBatch[]
): ValidityReport['axisCorrelation'] {
  // Filter existing indicators on same axis
  const sameAxisExisting = existing.filter(
    (ind) => ind.axis === newDef.axis
  );

  const correlations: Record<string, number> = {};
  let sumCorr = 0;

  // Calculate correlations between new and existing indicators
  for (const existingInd of sameAxisExisting) {
    const corr = pearsonCorrelation(
      extractIndicatorValues(newDef.id, historicalData),
      extractIndicatorValues(existingInd.id, historicalData)
    );
    correlations[existingInd.id] = corr;
    sumCorr += corr;
  }

  const meanCorr = sameAxisExisting.length > 0 ? sumCorr / sameAxisExisting.length : 0;

  // Get expected range for this axis
  const expectations = AXIS_CORRELATION_EXPECTATIONS[newDef.axis] || {};
  const [expectedMin, expectedMax] = Object.values(expectations)[0] || [0.2, 0.5];

  // Classify each correlation
  const problematicPairs = Object.entries(correlations)
    .map(([existingId, corr]) => {
      let status: 'too_weak' | 'too_strong' | 'expected';
      if (corr < expectedMin * 0.8) status = 'too_weak';
      else if (corr > expectedMax * 1.2) status = 'too_strong';
      else status = 'expected';

      return {
        existingIndicatorId: existingId,
        correlation: corr,
        status,
      };
    })
    .filter((p) => p.status !== 'expected');

  return {
    meanCorrelationWithAxis: meanCorr,
    expectedRangeMin: expectedMin,
    expectedRangeMax: expectedMax,
    withinExpectedRange: meanCorr >= expectedMin && meanCorr <= expectedMax,
    problematicPairs: problematicPairs.length > 0 ? problematicPairs : undefined,
  };
}

// ============ STAGE 3: REDUNDANCY DETECTION ============

function detectRedundancy(
  newDef: IndicatorDefinition,
  existing: IndicatorDefinition[],
  historicalData: MicroScoreBatch[],
  correlations: Record<string, number>
): ValidityReport['redundancyAnalysis'] {
  // Find max correlation across all existing
  const maxCorr = Math.max(0, ...Object.values(correlations));
  const maxCorrIndicatorId = Object.entries(correlations).reduce((max, [id, corr]) =>
    corr > max[1] ? [id, corr] : max
  )[0];

  const hasRedundancy = maxCorr >= 0.90;

  let mergeCandidate: ValidityReport['redundancyAnalysis']['mergeCandidate'] | undefined;
  if (hasRedundancy) {
    const recommendedApproach = maxCorr >= 0.95 ? 'remove' : 'merge';
    mergeCandidate = {
      indicatorId: maxCorrIndicatorId,
      correlation: maxCorr,
      recommendedApproach,
    };
  }

  return {
    maxCorrelationWithExisting: maxCorr,
    redundantIndicatorId: hasRedundancy ? maxCorrIndicatorId : undefined,
    hasRedundancy,
    mergeCandidate,
  };
}

// ============ STAGE 4: VARIANCE EXPLAINED ============

function calculateVarianceExplained(
  newDef: IndicatorDefinition,
  existing: IndicatorDefinition[],
  historicalData: MicroScoreBatch[]
): ValidityReport['varianceExplained'] {
  // Extract dependent variable (e.g., overall learning outcome)
  const dependentVar = extractDependentVariable(historicalData);

  // Baseline model: existing indicators only
  const baselineR2 = calculateR2(
    existing.map((ind) => extractIndicatorValues(ind.id, historicalData)),
    dependentVar
  );

  // New model: existing + new
  const allIndicators = [
    ...existing,
    newDef,
  ];
  const newR2 = calculateR2(
    allIndicators.map((ind) => extractIndicatorValues(ind.id, historicalData)),
    dependentVar
  );

  const deltaR2 = newR2 - baselineR2;

  // Discrimination Index
  const newIndicatorValues = extractIndicatorValues(newDef.id, historicalData);
  const discriminationIndex = calculateDiscriminationIndex(
    newIndicatorValues,
    dependentVar
  );

  // Determine parsimony score
  let parsimonyScore: 'low' | 'medium' | 'high';
  if (deltaR2 >= 0.05) {
    parsimonyScore = 'high'; // substantial improvement
  } else if (deltaR2 >= 0.02) {
    parsimonyScore = 'medium'; // modest improvement
  } else {
    parsimonyScore = 'low'; // minimal improvement
  }

  return {
    incrementalVariance: deltaR2,
    discriminationIndex,
    parsimonyScore,
    sufficientForInclusion: deltaR2 >= 0.02,
  };
}

// ============ STAGE 5: EXTERNAL VALIDATION ============

function validateExternalCriteria(
  newDef: IndicatorDefinition,
  historicalData: MicroScoreBatch[]
): ValidityReport['externalValidation'] {
  const criteria = EXTERNAL_CRITERIA[newDef.axis] || [];
  const newIndicatorValues = extractIndicatorValues(newDef.id, historicalData);

  const constructRelatedCriteria: ValidityReport['externalValidation']['constructRelatedCriteria'] = [];
  const constructUnrelatedCriteria: ValidityReport['externalValidation']['constructUnrelatedCriteria'] = [];

  for (const criterion of criteria) {
    const criterionValues = extractExternalCriterion(criterion.name, historicalData);
    if (!criterionValues || criterionValues.length === 0) continue;

    const correlation = pearsonCorrelation(newIndicatorValues, criterionValues);
    const [expectedMin, expectedMax] = criterion.expectedCorrelation;
    const isValid = correlation >= expectedMin && correlation <= expectedMax;

    const item = {
      criterionName: criterion.name,
      correlation,
      expectedMin: criterion.type === 'construct_related' ? expectedMin : expectedMax,
      isValid,
    };

    if (criterion.type === 'construct_related') {
      constructRelatedCriteria.push({
        ...item,
        expectedMin,
      });
    } else {
      constructUnrelatedCriteria.push({
        ...item,
        expectedMax,
      });
    }
  }

  // Overall validity: all related >= min, all unrelated <= max
  const allRelatedValid = constructRelatedCriteria.every((c) => c.isValid);
  const allUnrelatedValid = constructUnrelatedCriteria.every((c) => c.isValid);
  const overallExternalValidity = allRelatedValid && allUnrelatedValid;

  return {
    constructRelatedCriteria,
    constructUnrelatedCriteria,
    overallExternalValidity,
  };
}

// ============ RELIABILITY METRICS ============

function calculateReliabilityMetrics(
  newDef: IndicatorDefinition,
  existing: IndicatorDefinition[],
  historicalData: MicroScoreBatch[]
): ValidityReport['reliabilityMetrics'] {
  const allIndicators = [...existing, newDef];
  const newIndicatorValues = extractIndicatorValues(newDef.id, historicalData);
  const correlationMatrix = buildCorrelationMatrix(allIndicators, historicalData);

  // Omega Total
  const omegaTotal = calculateOmegaTotal(correlationMatrix, newDef.axis);

  // McDonald's H
  const mcdonaldH = calculateMcdonaldH(correlationMatrix, newDef.axis);

  // Split-half (time-based)
  const splitHalfRho = calculateSplitHalfRho(newIndicatorValues);

  // Facet consistency (optional)
  const facetConsistency: Record<string, number> = {};

  return {
    omegaTotal,
    mcdonaldH,
    splitHalfRho,
    reliabilityAdequate: omegaTotal >= 0.70 && splitHalfRho >= 0.60,
    facetConsistency,
  };
}

// ============ RECOMMENDATION LOGIC ============

function generateRecommendation(
  conceptual: ValidityReport['conceptualAlignment'],
  axisCorr: ValidityReport['axisCorrelation'],
  redundancy: ValidityReport['redundancyAnalysis'],
  variance: ValidityReport['varianceExplained'],
  external: ValidityReport['externalValidation'],
  reliability: ValidityReport['reliabilityMetrics']
): {
  recommendation: ValidityReport['recommendation'];
  rationale: string;
  recommendedMergeWith?: string;
} {
  // Decision tree
  if (!conceptual.isValid) {
    return {
      recommendation: 'reject',
      rationale: 'Conceptual alignment failed: indicator does not clearly map to recognized competency node.',
    };
  }

  if (redundancy.hasRedundancy) {
    if (redundancy.mergeCandidate?.recommendedApproach === 'remove') {
      return {
        recommendation: 'reject',
        rationale: `Very high redundancy (r=${redundancy.maxCorrelationWithExisting.toFixed(2)}) with ${redundancy.mergeCandidate.indicatorId}. Recommend removing new indicator.`,
      };
    } else {
      return {
        recommendation: 'merge_with',
        recommendedMergeWith: redundancy.mergeCandidate?.indicatorId,
        rationale: `High redundancy (r=${redundancy.maxCorrelationWithExisting.toFixed(2)}). Recommend merging with ${redundancy.mergeCandidate?.indicatorId} as composite indicator.`,
      };
    }
  }

  if (!axisCorr.withinExpectedRange) {
    return {
      recommendation: 'reject',
      rationale: `Axis correlation (r=${axisCorr.meanCorrelationWithAxis.toFixed(2)}) outside expected range [${axisCorr.expectedRangeMin}, ${axisCorr.expectedRangeMax}]. May measure different construct.`,
    };
  }

  if (!variance.sufficientForInclusion) {
    if (!external.overallExternalValidity || !reliability.reliabilityAdequate) {
      return {
        recommendation: 'reject',
        rationale: `Low incremental variance (ΔR²=${variance.incrementalVariance.toFixed(3)}), poor external validity, or inadequate reliability. Recommend rejection per parsimony principle.`,
      };
    } else {
      return {
        recommendation: 'conditional_add',
        rationale: `Modest incremental variance (ΔR²=${variance.incrementalVariance.toFixed(3)}), but strong external validity (r=${external.constructRelatedCriteria[0]?.correlation.toFixed(2)}) and adequate reliability. Recommend conditional addition with periodic review.`,
      };
    }
  }

  if (!external.overallExternalValidity) {
    return {
      recommendation: 'reject',
      rationale: `External validation failed. Construct-related criteria insufficient or construct-unrelated criteria too high.`,
    };
  }

  if (!reliability.reliabilityAdequate) {
    return {
      recommendation: 'reject',
      rationale: `Reliability inadequate (ω=${reliability.omegaTotal.toFixed(2)}, split-half ρ=${reliability.splitHalfRho.toFixed(2)}). Cannot trust repeated measurement.`,
    };
  }

  // All checks passed
  return {
    recommendation: 'add',
    rationale: `All validation stages passed. Indicator has strong conceptual alignment, expected axis correlations, meaningful incremental variance (ΔR²=${variance.incrementalVariance.toFixed(3)}), strong external validity, and adequate reliability. Ready for inclusion.`,
  };
}

// ============ UTILITY FUNCTIONS ============

function extractIndicatorValues(indicatorId: string, data: MicroScoreBatch[]): number[] {
  return data
    .map((batch) => batch.indicators?.[indicatorId])
    .filter((v) => v !== undefined && !isNaN(v)) as number[];
}

function extractDependentVariable(data: MicroScoreBatch[]): number[] {
  return data
    .map((batch) => batch.externalCriteria?.['learning_outcome'] || 0)
    .filter((v) => !isNaN(v)) as number[];
}

function extractExternalCriterion(criterionName: string, data: MicroScoreBatch[]): number[] | null {
  const values = data
    .map((batch) => batch.externalCriteria?.[criterionName])
    .filter((v) => v !== undefined && !isNaN(v)) as number[];
  return values.length > 0 ? values : null;
}

function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length === 0 || y.length === 0 || x.length !== y.length) return 0;

  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denominator = Math.sqrt(denomX * denomY);
  return denominator === 0 ? 0 : numerator / denominator;
}

function calculateR2(independentVars: number[][], dependentVar: number[]): number {
  // Simplified: use sum of correlations squared
  // In production, use actual regression
  if (independentVars.length === 0) return 0;
  const correlations = independentVars.map((x) => Math.abs(pearsonCorrelation(x, dependentVar)));
  return Math.min(1, correlations.reduce((a, b) => a + b * b, 0));
}

function calculateDiscriminationIndex(indicatorValues: number[], outcome: number[]): number {
  const median = calculateMedian(outcome);
  const high = indicatorValues.filter((_, i) => outcome[i] >= median);
  const low = indicatorValues.filter((_, i) => outcome[i] < median);

  const meanHigh = high.reduce((a, b) => a + b, 0) / (high.length || 1);
  const meanLow = low.reduce((a, b) => a + b, 0) / (low.length || 1);
  const sd = calculateStdDev(indicatorValues);

  return sd > 0 ? (meanHigh - meanLow) / sd : 0;
}

function calculateMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calculateStdDev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squareDiffs = values.map((v) => Math.pow(v - mean, 2));
  return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / values.length);
}

function buildCorrelationMatrix(
  indicators: IndicatorDefinition[],
  data: MicroScoreBatch[]
): number[][] {
  const n = indicators.length;
  const matrix: number[][] = Array(n)
    .fill(null)
    .map(() => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1;
      } else {
        const x = extractIndicatorValues(indicators[i].id, data);
        const y = extractIndicatorValues(indicators[j].id, data);
        matrix[i][j] = pearsonCorrelation(x, y);
      }
    }
  }

  return matrix;
}

function calculateOmegaTotal(correlationMatrix: number[][], axis: string): number {
  // Simplified: average correlation as proxy
  // In production, use factor analysis loadings
  const n = correlationMatrix.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      sum += correlationMatrix[i][j];
    }
  }
  const avgCorr = n > 1 ? sum / ((n * (n - 1)) / 2) : 0;
  return Math.min(1, 0.5 + avgCorr); // 0.5 baseline + correlation effect
}

function calculateMcdonaldH(correlationMatrix: number[][], axis: string): number {
  // Simplified version
  return calculateOmegaTotal(correlationMatrix, axis) * 0.95;
}

function calculateSplitHalfRho(indicatorValues: number[]): number {
  const mid = Math.floor(indicatorValues.length / 2);
  const first = indicatorValues.slice(0, mid);
  const second = indicatorValues.slice(mid);
  const r = pearsonCorrelation(first, second);
  // Spearman-Brown correction: ρ = 2r / (1 + r)
  return (2 * r) / (1 + r);
}

// ============ EXPORT FOR TESTING ============

export {
  calculateAxisCorrelation,
  detectRedundancy,
  calculateVarianceExplained,
  validateExternalCriteria,
  calculateReliabilityMetrics,
  generateRecommendation,
  pearsonCorrelation,
};
