/**
 * Metaphor Density Collector
 * Measures metaphor/analogy expression density using LLM classification
 * Sampled every 3 turns to reduce costs
 *
 * Reference: Stealth Assessment, pp. 46-56 (Flexibility, Originality)
 */

export interface MetaphorAnalysisRequest {
  studentMessage: string;
  turnNumber: number;
  sampleRate?: number; // turns between samples (default: 3)
}

export interface MetaphorAnalysisResult {
  hasMetaphors: boolean;
  metaphorScore: number; // 0-1
  metaphorCount: number;
  expressionTypes: string[];
  confidence: number;
  sampled: boolean;
  rawText?: string;
}

const DEFAULT_SAMPLE_RATE = 3;
const LLM_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Determine if this turn should be sampled for LLM analysis
 * @param turnNumber - Current turn number (1-indexed)
 * @param sampleRate - Number of turns between samples
 * @returns Whether to sample this turn
 */
export function shouldSampleTurn(turnNumber: number, sampleRate: number = DEFAULT_SAMPLE_RATE): boolean {
  return turnNumber % sampleRate === 0;
}

/**
 * Parse LLM response to extract metaphor score
 * Expected format: JSON with metaphorScore (0-1)
 * @param llmResponse - Raw LLM output
 * @returns Parsed metaphor score or 0 if parsing fails
 */
export function parseMetaphorScore(llmResponse: string): number {
  try {
    const cleaned = llmResponse.trim();

    // Try to extract JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const score = parsed.metaphorScore ?? parsed.score;
      if (typeof score === 'number') {
        return Math.max(0, Math.min(1, score));
      }
    }

    // Fallback: try to find number between 0-1
    const numberMatch = cleaned.match(/0\.\d+|^1$/);
    if (numberMatch) {
      return parseFloat(numberMatch[0]);
    }

    return 0;
  } catch (e) {
    console.error('[Metaphor Density] Failed to parse LLM response:', e);
    return 0;
  }
}

/**
 * Extract metaphor expressions from text
 * Simple pattern matching for common metaphor markers
 * @param text - Student message
 * @returns Found expression types and count
 */
export function extractMetaphorPatterns(text: string): { types: string[]; count: number } {
  const types: string[] = [];
  let count = 0;

  // Metaphor patterns in Korean and English
  const patterns = [
    { regex: /처럼|같이|처럼|마치|마냥/, type: 'simile_ko' },
    { regex: /is\s+like|as\s+if|as\s+though/, type: 'simile_en' },
    { regex: /~의\s*비유|~에\s*빗대|~처럼\s*비유/, type: 'analogy_ko' },
    { regex: /metaphor|analogy/, type: 'explicit_reference' },
    { regex: /~이\s*곧\s*~|~는\s*사실상/, type: 'equation_ko' },
  ];

  for (const { regex, type } of patterns) {
    const matches = text.match(new RegExp(regex, 'gi'));
    if (matches) {
      count += matches.length;
      if (!types.includes(type)) {
        types.push(type);
      }
    }
  }

  return { types, count };
}

/**
 * Compute metaphor density score (offline, without LLM)
 * Uses pattern matching as fallback
 * @param text - Student message
 * @returns Metaphor density score (0-1)
 */
export function computeMetaphorDensityLocal(text: string): number {
  if (!text || text.length < 10) {
    return 0;
  }

  const { count } = extractMetaphorPatterns(text);

  // Normalize by message length
  // Assumption: high-quality metaphor = 1-2 per 100 chars
  const wordCount = text.split(/\s+/).length;
  const density = count / Math.max(wordCount / 10, 1); // density per 10 words
  const normalized = Math.max(0, Math.min(1, density / 0.3)); // cap at 0.3 per 10 words

  return normalized;
}

/**
 * Main entry point for metaphor analysis
 * Decides whether to use LLM (sampled) or local fallback
 * @param request - Analysis request
 * @param llmAnalyzer - Optional LLM function (called only if sampled)
 * @returns Metaphor analysis result
 */
export async function analyzeMetaphorDensity(
  request: MetaphorAnalysisRequest,
  llmAnalyzer?: (text: string) => Promise<string>
): Promise<MetaphorAnalysisResult> {
  const sampleRate = request.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const sampled = shouldSampleTurn(request.turnNumber, sampleRate);

  if (sampled && llmAnalyzer) {
    try {
      const llmResponse = await llmAnalyzer(request.studentMessage);
      const score = parseMetaphorScore(llmResponse);
      const { types, count } = extractMetaphorPatterns(request.studentMessage);

      return {
        hasMetaphors: score > 0.3,
        metaphorScore: score,
        metaphorCount: count,
        expressionTypes: types,
        confidence: LLM_CONFIDENCE_THRESHOLD,
        sampled: true,
        rawText: request.studentMessage,
      };
    } catch (e) {
      console.error('[Metaphor Density] LLM call failed:', e);
      // Fall through to local analysis
    }
  }

  // Local fallback analysis
  const localScore = computeMetaphorDensityLocal(request.studentMessage);
  const { types, count } = extractMetaphorPatterns(request.studentMessage);

  return {
    hasMetaphors: localScore > 0.3,
    metaphorScore: localScore,
    metaphorCount: count,
    expressionTypes: types,
    confidence: 0.4, // Lower confidence for local analysis
    sampled: false,
  };
}
