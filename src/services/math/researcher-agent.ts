// =============================================
// Researcher Agent (Phase 3A - Option 2C Extension)
// =============================================
// Role: Fact-checking and evidence retrieval from book text / knowledge base
// Part of Multi-Agent Pipeline: Mentor(Gen) → Researcher(Fact) → Critic(Verify) → Final
//
// Responsibilities:
//   1. RAG-based fact retrieval from book chunks
//   2. Cross-reference student claims against book text
//   3. Identify supporting/contradicting evidence for tutor's question
//   4. Feed verified facts to Mentor for more targeted Socratic questions
//
// Lightweight Implementation (Cloudflare Workers):
//   - D1 SQLite text search instead of vector embeddings
//   - Keyword extraction + TF-IDF-lite scoring
//   - Chunk-level relevance ranking
// =============================================

import { isAIInvocationReceiptPersistenceError, type AIRouter } from '../ai-router';
import { renderPromptTemplate } from '../prompt-template';
import researcherFactCheckSystemPrompt from './prompts/researcher-fact-check.system.md?raw';
import researcherFactCheckUserPrompt from './prompts/researcher-fact-check.user.md?raw';

// =============================================
// Types
// =============================================

export interface ResearcherContext {
  sessionId: string;
  studentMessage: string;
  topic: string;
  bookText: string;  // Already RAG-retrieved chunks
  approvedEvidenceSources: readonly ApprovedEvidenceSource[];
  currentClaim?: string;
  weaknessPattern?: string[];
}

/** Immutable library-retrieval source snapshot approved for this turn. */
export interface ApprovedEvidenceSource {
  sourceId: string;
  content: string;
  contentSha256: string;
  charStart: number | null;
  charEnd: number | null;
}

/** A model quote with enough provenance to re-verify against a source snapshot. */
export interface SourceBoundEvidenceSpan {
  sourceId: string;
  sourceSha256: string;
  quote: string;
  startOffset: number;
  endOffset: number;
}

export interface ResearcherResult {
  relevantPassages: RelevantPassage[];
  factCheckResult: FactCheckResult;
  suggestedAngles: string[];        // Angles the tutor could explore
  trustMarkers: TrustMarker[];      // For frontend trust indicators
  researchTimeMs: number;
}

export interface RelevantPassage {
  text: string;
  relevanceScore: number;     // 0-1
  sourceType: 'book_text' | 'student_claim' | 'knowledge_base';
  citationRef?: string;       // e.g., "p.45" or "Chapter 3"
}

export interface FactCheckResult {
  status: 'verified' | 'unavailable';
  claimVerified: boolean | null;
  confidence: number;         // 0-1
  supportingEvidence: SourceBoundEvidenceSpan[];
  contradictingEvidence: SourceBoundEvidenceSpan[];
  missingContext: string[];
}

export interface TrustMarker {
  type: 'verified_fact' | 'ai_inference' | 'student_claim' | 'unverified';
  label: string;
  confidence: number;
}

// =============================================
// Researcher Agent: Fact-Check & Evidence Retrieval
// =============================================

export async function runResearcherAgent(
  router: AIRouter,
  context: ResearcherContext,
): Promise<ResearcherResult> {
  const start = Date.now();

  try {
    // Step 1: Extract key claims from student message
    const claims = extractClaims(context.studentMessage);

    // Step 2: Find relevant passages from book text
    const relevantPassages = findRelevantPassages(
      context.bookText,
      claims,
      context.topic,
    );

    // Step 3: AI-powered fact check (lightweight)
    const factCheckResult = await performFactCheck(
      router,
      context.studentMessage,
      context.bookText,
      context.topic,
      context.approvedEvidenceSources,
    );

    // Step 4: Generate suggested angles for Mentor
    const suggestedAngles = generateSuggestedAngles(
      factCheckResult,
      context.weaknessPattern || [],
    );

    // Step 5: Build trust markers for frontend
    const trustMarkers = buildTrustMarkers(
      relevantPassages,
      factCheckResult,
    );

    return {
      relevantPassages,
      factCheckResult,
      suggestedAngles,
      trustMarkers,
      researchTimeMs: Date.now() - start,
    };
  } catch (error) {
    if (isAIInvocationReceiptPersistenceError(error)) throw error;
    console.error('[RESEARCHER] Agent failed:', error);
    return {
      relevantPassages: [],
      factCheckResult: {
        status: 'unavailable',
        claimVerified: null,
        confidence: 0,
        supportingEvidence: [],
        contradictingEvidence: [],
        missingContext: ['리서처 에이전트 처리 중 오류 발생'],
      },
      suggestedAngles: ['학생의 텍스트 근거 요청'],
      trustMarkers: [],
      researchTimeMs: Date.now() - start,
    };
  }
}

// =============================================
// Claim Extraction (Rule-based, Fast)
// =============================================

function extractClaims(message: string): string[] {
  const claims: string[] = [];

  // Split by sentence boundaries
  const sentences = message.split(/[.!?。！？]\s*/).filter(s => s.trim().length > 10);

  for (const sentence of sentences) {
    // Detect claim patterns (Korean)
    const isClaimLike =
      /(?:생각한다|주장한다|믿는다|판단한다|이다$|있다$|없다$|해야 한다|할 것이다)/.test(sentence) ||
      /(?:따라서|그러므로|결론적으로|이것은|이는)/.test(sentence) ||
      /(?:~이라고|~라고|~다고)/.test(sentence) ||
      sentence.trim().length > 30; // Long sentences are likely claims

    if (isClaimLike) {
      claims.push(sentence.trim());
    }
  }

  // If no claims detected, use the whole message as a claim
  if (claims.length === 0 && message.trim().length > 15) {
    claims.push(message.trim().substring(0, 200));
  }

  return claims.slice(0, 5); // Max 5 claims
}

// =============================================
// Passage Retrieval (TF-IDF-lite)
// =============================================

function findRelevantPassages(
  bookText: string,
  claims: string[],
  topic: string,
): RelevantPassage[] {
  if (!bookText || bookText.length < 20) return [];

  const passages: RelevantPassage[] = [];

  // Split book text into chunks of ~200 chars
  const chunks = bookText.match(/.{1,200}/g) || [];

  // Extract keywords from claims + topic
  const keywords = new Set<string>();
  const allText = claims.join(' ') + ' ' + topic;
  const words = allText.split(/[\s,;:'"()[\]{}·…]+/)
    .filter(w => w.length > 1)
    .map(w => w.toLowerCase());
  words.forEach(w => keywords.add(w));

  // Score each chunk by keyword overlap
  for (const chunk of chunks) {
    const chunkLower = chunk.toLowerCase();
    let score = 0;
    let matchCount = 0;

    for (const kw of keywords) {
      if (chunkLower.includes(kw)) {
        score += kw.length; // Longer keywords = more specific = higher score
        matchCount++;
      }
    }

    // Normalize score (0-1)
    const normalizedScore = keywords.size > 0
      ? Math.min(1, (matchCount / keywords.size) * 2)
      : 0;

    if (normalizedScore > 0.1) {
      passages.push({
        text: chunk.trim(),
        relevanceScore: normalizedScore,
        sourceType: 'book_text',
      });
    }
  }

  // Sort by relevance and return top 5
  return passages
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 5);
}

// =============================================
// AI Fact Check (Lightweight)
// =============================================

async function performFactCheck(
  router: AIRouter,
  studentMessage: string,
  bookText: string,
  topic: string,
  approvedEvidenceSources: readonly ApprovedEvidenceSource[],
): Promise<FactCheckResult> {
  const approvedSources = approvedSourceIndex(approvedEvidenceSources);
  if (!approvedSources) return unavailableFactCheck();
  const approvedEvidenceJson = JSON.stringify(
    approvedEvidenceSources.map((source) => ({
      sourceId: source.sourceId,
      sourceSha256: source.contentSha256,
      content: source.content,
    })),
  ).substring(0, 8000);

  try {
    const routed = await router.completeValidatedJSON(
      'background_reasoning',
      {
        systemPrompt: researcherFactCheckSystemPrompt,
        userPrompt: renderPromptTemplate(researcherFactCheckUserPrompt, {
          TOPIC: topic,
          STUDENT_MESSAGE: studentMessage.substring(0, 300),
          APPROVED_EVIDENCE_JSON: approvedEvidenceJson,
          REFERENCE_TEXT: bookText.substring(0, 800),
        }),
        temperature: 0.2,
        maxTokens: 500,
      },
      validateFactCheckPayload,
    );
    const result = routed.value;
    const supportingEvidence = validateSourceBoundSpans(result.supportingEvidence, approvedSources);
    const contradictingEvidence = validateSourceBoundSpans(result.contradictingEvidence, approvedSources);

    // Any malformed, non-unique, or unapproved citation makes the model
    // verdict ungradable. A polarity needs its own affirmative witness.
    if (!supportingEvidence || !contradictingEvidence
      || spansOverlapAcrossPolarities(supportingEvidence, contradictingEvidence)
      || (result.claimVerified && supportingEvidence.length === 0)
      || (!result.claimVerified && contradictingEvidence.length === 0)) {
      return unavailableFactCheck();
    }

    return {
      status: 'verified',
      claimVerified: result.claimVerified,
      confidence: result.confidence,
      supportingEvidence: supportingEvidence.slice(0, 3),
      contradictingEvidence: contradictingEvidence.slice(0, 2),
      missingContext: result.missingContext.slice(0, 2),
    };
  } catch (error) {
    if (isAIInvocationReceiptPersistenceError(error)) throw error;
    console.error('[RESEARCHER] Fact check unavailable:', error);
    return unavailableFactCheck();
  }
}

interface FactCheckPayload {
  claimVerified: boolean;
  confidence: number;
  supportingEvidence: SourceBoundEvidenceSpan[];
  contradictingEvidence: SourceBoundEvidenceSpan[];
  missingContext: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isSourceBoundEvidenceSpan(value: unknown): value is SourceBoundEvidenceSpan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const span = value as Record<string, unknown>;
  return typeof span.sourceId === 'string'
    && typeof span.sourceSha256 === 'string'
    && typeof span.quote === 'string'
    && Number.isSafeInteger(span.startOffset)
    && Number.isSafeInteger(span.endOffset);
}

function isSourceBoundEvidenceSpanArray(value: unknown): value is SourceBoundEvidenceSpan[] {
  return Array.isArray(value) && value.every(isSourceBoundEvidenceSpan);
}

function validateFactCheckPayload(value: unknown): FactCheckPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.claimVerified !== 'boolean'
    || typeof payload.confidence !== 'number'
    || !Number.isFinite(payload.confidence)
    || payload.confidence < 0
    || payload.confidence > 1
    || !isSourceBoundEvidenceSpanArray(payload.supportingEvidence)
    || !isSourceBoundEvidenceSpanArray(payload.contradictingEvidence)
    || !isStringArray(payload.missingContext)
  ) return null;
  return {
    claimVerified: payload.claimVerified,
    confidence: payload.confidence,
    supportingEvidence: payload.supportingEvidence,
    contradictingEvidence: payload.contradictingEvidence,
    missingContext: payload.missingContext,
  };
}

const MIN_EVIDENCE_QUOTE_LENGTH = 12;

function approvedSourceIndex(
  sources: readonly ApprovedEvidenceSource[],
): ReadonlyMap<string, ApprovedEvidenceSource> | null {
  if (sources.length === 0) return null;
  const indexed = new Map<string, ApprovedEvidenceSource>();
  for (const source of sources) {
    if (!source.sourceId.trim() || !source.contentSha256.trim() || !source.content
      || indexed.has(source.sourceId)) return null;
    indexed.set(source.sourceId, source);
  }
  return indexed;
}

function validateSourceBoundSpans(
  spans: readonly SourceBoundEvidenceSpan[],
  approvedSources: ReadonlyMap<string, ApprovedEvidenceSource>,
): SourceBoundEvidenceSpan[] | null {
  const validated: SourceBoundEvidenceSpan[] = [];
  const canonicalSpanKeys = new Set<string>();
  for (const span of spans) {
    const source = approvedSources.get(span.sourceId);
    if (!source
      || span.sourceSha256 !== source.contentSha256
      || span.quote.trim().length < MIN_EVIDENCE_QUOTE_LENGTH
      || span.startOffset < 0
      || span.endOffset <= span.startOffset
      || span.endOffset > source.content.length
      || source.content.slice(span.startOffset, span.endOffset) !== span.quote) {
      return null;
    }

    // A repeated quote without a unique witness would let a model select the
    // favorable occurrence after the fact. The returned offsets must identify
    // the single approved source span unambiguously.
    const firstOccurrence = source.content.indexOf(span.quote);
    if (firstOccurrence !== span.startOffset
      || source.content.indexOf(span.quote, firstOccurrence + 1) !== -1) return null;
    const canonicalKey = canonicalSpanKey(span);
    if (canonicalSpanKeys.has(canonicalKey)) return null;
    if (validated.some((existing) => groundedSpansOverlap(existing, span))) return null;
    canonicalSpanKeys.add(canonicalKey);
    validated.push(Object.freeze({ ...span }));
  }
  return validated;
}

function canonicalSpanKey(span: SourceBoundEvidenceSpan): string {
  return [
    span.sourceId,
    span.startOffset,
    span.endOffset,
    span.sourceSha256,
    span.quote,
  ].join('\u0000');
}

function spansOverlapAcrossPolarities(
  supportingEvidence: readonly SourceBoundEvidenceSpan[],
  contradictingEvidence: readonly SourceBoundEvidenceSpan[],
): boolean {
  return supportingEvidence.some((supportingSpan) => contradictingEvidence.some(
    (contradictingSpan) => groundedSpansOverlap(supportingSpan, contradictingSpan),
  ));
}

function groundedSpansOverlap(
  first: SourceBoundEvidenceSpan,
  second: SourceBoundEvidenceSpan,
): boolean {
  return first.sourceId === second.sourceId
    && first.sourceSha256 === second.sourceSha256
    && first.startOffset < second.endOffset
    && second.startOffset < first.endOffset;
}

function unavailableFactCheck(): FactCheckResult {
  return {
    status: 'unavailable',
    claimVerified: null,
    confidence: 0,
    supportingEvidence: [],
    contradictingEvidence: [],
    missingContext: [],
  };
}

// =============================================
// Suggested Angles for Mentor
// =============================================

function generateSuggestedAngles(
  factCheck: FactCheckResult,
  weaknessPattern: string[],
): string[] {
  const angles: string[] = [];

  if (factCheck.contradictingEvidence.length > 0) {
    angles.push('학생 주장과 상충하는 텍스트 근거를 활용한 반례 질문');
  }

  if (factCheck.missingContext.length > 0) {
    angles.push(`학생이 놓치고 있는 맥락(${factCheck.missingContext[0]})을 탐색하는 질문`);
  }

  if (factCheck.status === 'verified' && factCheck.claimVerified === false) {
    angles.push('주장의 텍스트 근거 제시를 요청하는 질문');
  }

  if (weaknessPattern.includes('논리적 비약')) {
    angles.push('추론 과정의 논리적 연결을 묻는 질문');
  }

  if (weaknessPattern.includes('근거 부족')) {
    angles.push('구체적 텍스트 인용을 유도하는 질문');
  }

  // Default angle
  if (angles.length === 0) {
    angles.push('학생의 논증 구조를 심화하는 소크라틱 질문');
  }

  return angles.slice(0, 3);
}

// =============================================
// Trust Markers for Frontend (Option 3C)
// =============================================

function buildTrustMarkers(
  passages: RelevantPassage[],
  factCheck: FactCheckResult,
): TrustMarker[] {
  const markers: TrustMarker[] = [];

  // Book text passages
  for (const p of passages.slice(0, 3)) {
    markers.push({
      type: 'verified_fact',
      label: `텍스트 근거 (관련도: ${(p.relevanceScore * 100).toFixed(0)}%)`,
      confidence: p.relevanceScore,
    });
  }

  // Fact check result
  if (factCheck.claimVerified) {
    markers.push({
      type: 'verified_fact',
      label: '학생 주장 텍스트 검증됨',
      confidence: factCheck.confidence,
    });
  } else if (factCheck.status === 'verified' && factCheck.confidence > 0) {
    markers.push({
      type: 'unverified',
      label: '학생 주장 텍스트 미검증',
      confidence: 1 - factCheck.confidence,
    });
  }

  return markers;
}

// =============================================
// D1 Research History Persistence
// =============================================

export async function persistResearchToD1(
  db: D1Database,
  sessionId: string,
  turnNumber: number,
  result: ResearcherResult,
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO semantic_entropy_log (session_id, turn_number, entropy_value, is_high_entropy, evaluation_count, scores_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(
      sessionId,
      turnNumber,
      result.factCheckResult.confidence,
      result.factCheckResult.contradictingEvidence.length > 0 ? 1 : 0,
      result.relevantPassages.length,
      JSON.stringify({
        researchTimeMs: result.researchTimeMs,
        passageCount: result.relevantPassages.length,
        suggestedAngles: result.suggestedAngles,
        trustMarkerCount: result.trustMarkers.length,
        claimVerified: result.factCheckResult.claimVerified,
      }),
      Date.now(),
    ).run();
  } catch (error) {
    console.warn('[RESEARCHER] D1 persistence error:', error);
  }
}
