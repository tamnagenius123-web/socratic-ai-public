/**
 * Counter-Question Depth Classifier
 * Classifies student's counter-questions into cognitive depth levels
 * 0 = no counter-question
 * 1 = clarification seeking
 * 2 = assumption validation
 * 3 = alternative proposal
 *
 * Reference: Stealth Assessment, pp. 34-56 (Flexibility, Critical Thinking)
 */

export type QuestionDepthLevel = 0 | 1 | 2 | 3;

export interface CounterQuestionAnalysis {
  depth: QuestionDepthLevel;
  isCounterQuestion: boolean;
  expressionType: 'none' | 'clarification' | 'assumption' | 'alternative';
  confidence: number;
  reasoning: string;
}

/**
 * Detect if text contains a counter-question or questioning
 * @param text - Student message
 * @returns True if counter-question detected
 */
export function isCounterQuestion(text: string): boolean {
  if (!text || text.length < 5) return false;

  // Question markers
  const questionMarkers = [
    /\?$/, // Ends with question mark
    /\?[\s!]*$/, // Question mark at end
    /^(그런데|하지만|그렇다면|그럼|근데|잠깐|그런데요|아|그놈)[^.]*\?/, // Korean question openings
  ];

  return questionMarkers.some((pattern) => pattern.test(text.trim()));
}

/**
 * Classify question depth: 1 = clarification, 2 = assumption, 3 = alternative
 * @param text - Student message
 * @returns Depth level (1-3) or 0 if no counter-question
 */
export function classifyQuestionDepth(text: string): QuestionDepthLevel {
  if (!isCounterQuestion(text)) {
    return 0;
  }

  // Level 3: Alternative proposal (새로운 관점, 다른 접근)
  const alternativePatterns = [
    /그렇다면\s*~은|~라면|그럼\s*~할\s*수\s*있지|다르게|다른\s*방법|대신\s*~은|역으로/, // 대안 제시
    /is\s+that\s+why|what\s+if|could\s+we|alternatively|on\s+the\s+other\s+hand|instead/, // English
  ];

  if (alternativePatterns.some((p) => p.test(text))) {
    return 3;
  }

  // Level 2: Assumption validation (전제 검증, 가정 확인)
  const assumptionPatterns = [
    /가정|전제|기반|조건|근거|~라고\s*가정|~라고\s*하면|~가\s*사실이라면|그렇다면/, // 전제 검증
    /how\s+do\s+you\s+know|what's\s+the\s+basis|is\s+that\s+assumption|upon\s+what/, // English
    /왜\s*~이어야|왜\s*꼭|반드시|필수적|확실한/, // 필수성 검증
  ];

  if (assumptionPatterns.some((p) => p.test(text))) {
    return 2;
  }

  // Level 1: Clarification (명확화 요청, 구체화)
  // Default for questions: clarification seeking
  return 1;
}

/**
 * Map depth level to expression type
 * @param depth - Question depth level (0-3)
 * @returns Human-readable expression type
 */
export function depthToExpressionType(
  depth: QuestionDepthLevel
): 'none' | 'clarification' | 'assumption' | 'alternative' {
  switch (depth) {
    case 0:
      return 'none';
    case 1:
      return 'clarification';
    case 2:
      return 'assumption';
    case 3:
      return 'alternative';
  }
}

/**
 * Analyze student message for counter-question depth
 * Combines pattern matching with heuristic reasoning
 * @param text - Student message
 * @param context - Optional context (previous tutor message)
 * @returns Detailed analysis
 */
export function analyzeCounterQuestionDepth(
  text: string,
  context?: string
): CounterQuestionAnalysis {
  const isQuestion = isCounterQuestion(text);

  if (!isQuestion) {
    return {
      depth: 0,
      isCounterQuestion: false,
      expressionType: 'none',
      confidence: 0.95,
      reasoning: '역질문이 감지되지 않음',
    };
  }

  const depth = classifyQuestionDepth(text);
  const expressionType = depthToExpressionType(depth);

  // Build reasoning string for transparency
  let reasoning = '';
  switch (depth) {
    case 1:
      reasoning = '명확화를 위한 질문 (예: 무엇을, 어떻게, 구체적으로)';
      break;
    case 2:
      reasoning = '전제/가정을 검증하는 질문 (예: 왜 그래야 하는가, 기반은)';
      break;
    case 3:
      reasoning = '대안 관점을 제시하는 질문 (예: 그렇다면, 다르게는)';
      break;
  }

  return {
    depth,
    isCounterQuestion: true,
    expressionType,
    confidence: depth === 1 ? 0.8 : depth === 2 ? 0.75 : 0.7, // Deeper levels have lower confidence
    reasoning,
  };
}

/**
 * Compute normalized score from depth (0-1 scale)
 * @param depth - Question depth level (0-3)
 * @returns Normalized score (0-1)
 */
export function depthToScore(depth: QuestionDepthLevel): number {
  return depth / 3;
}

/**
 * Batch analyze messages for counter-question patterns
 * @param messages - Array of student messages
 * @returns Array of analysis results with aggregated statistics
 */
export function analyzeBatch(
  messages: Array<{ text: string; turn?: number }>
): CounterQuestionAnalysis[] {
  return messages.map((msg) => analyzeCounterQuestionDepth(msg.text));
}

/**
 * Aggregate counter-question statistics from session
 * @param analyses - Array of counter-question analyses
 * @returns Summary statistics
 */
export function aggregateStatistics(
  analyses: CounterQuestionAnalysis[]
): {
  totalQuestions: number;
  avgDepth: number;
  depthDistribution: Record<QuestionDepthLevel, number>;
  maxDepth: QuestionDepthLevel;
  clarificationCount: number;
  assumptionCount: number;
  alternativeCount: number;
} {
  const depthDist: Record<QuestionDepthLevel, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let sumDepth = 0;
  let maxDepth: QuestionDepthLevel = 0;

  for (const analysis of analyses) {
    depthDist[analysis.depth]++;
    sumDepth += analysis.depth;
    maxDepth = Math.max(maxDepth, analysis.depth) as QuestionDepthLevel;
  }

  const totalQuestions = analyses.filter((a) => a.isCounterQuestion).length;
  const avgDepth = totalQuestions > 0 ? sumDepth / totalQuestions : 0;

  return {
    totalQuestions,
    avgDepth,
    depthDistribution: depthDist,
    maxDepth,
    clarificationCount: depthDist[1],
    assumptionCount: depthDist[2],
    alternativeCount: depthDist[3],
  };
}
