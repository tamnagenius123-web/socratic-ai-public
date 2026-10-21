// IntelligentHintGenerator - 5-Level Hint System
// Architecture Override #2: Educational approach to hint levels
// - Low scores (< 50) or high failure count -> Level 1-2 (basic guidance)
// - High scores (>= 80) AND 5+ turns -> Level 4-5 (academic/expert)
// This overrides the document's avgScore inverse-proportion logic.

import { callAIJSON } from './ai-client';
import { WebSearchAggregator, type SearchResult } from './web-search';
import type { SessionState, RadarScores } from '../types';

// =============================================
// Types
// =============================================

export type HintLevel = 1 | 2 | 3 | 4 | 5;

export interface IntelligentHint {
  level: HintLevel;
  levelName: string;
  message: string;
  sources?: SearchResult[];
  searchSummary?: string;
}

interface HintGenerationResult {
  hintMessage: string;
  explanation: string;
}

// =============================================
// HintLevelDeterminer - Education-first logic
// =============================================

export class HintLevelDeterminer {
  /**
   * Determine the appropriate hint level based on educational principles.
   *
   * KEY OVERRIDE (Architecture Modification #2):
   * - Struggling students (low scores, many failures) get Level 1-2
   *   -> Basic guidance and real-world examples to build confidence
   * - Advanced students (high scores, 5+ turns) get Level 4-5
   *   -> Academic papers and expert insights for deeper exploration
   * - Everyone else gets Level 3 (data/statistics)
   */
  static determine(session: SessionState): HintLevel {
    const avgScore = session.avgLogic;
    const turn = session.currentTurn;
    const hintRequests = session.hintRequestCount;
    const consecutiveFail = session.consecutiveNoEvidence;

    // === STRUGGLING STUDENTS (Need basic support) ===
    // Low avg score OR many consecutive failures -> simple, encouraging hints
    if (avgScore < 50 || consecutiveFail >= 3) {
      // Very low or repeated failures -> most basic guidance
      if (avgScore < 30 || consecutiveFail >= 4) {
        return 1; // Level 1: Basic text guide
      }
      return 2; // Level 2: Real-world example
    }

    // === INTERMEDIATE STUDENTS ===
    // Moderate scores, still building competence
    if (avgScore < 80) {
      // If they've requested many hints, escalate slightly
      if (hintRequests >= 3 && turn >= 4) {
        return 3; // Level 3: Data/statistics
      }
      return 2; // Level 2: Real-world example
    }

    // === ADVANCED STUDENTS (High scores, deep into session) ===
    // Score >= 80 AND at least 5 turns -> ready for advanced material
    if (avgScore >= 80 && turn >= 5) {
      // Deep into synthesis/conclusion phase -> expert level
      if (turn >= 7) {
        return 5; // Level 5: Expert insight
      }
      return 4; // Level 4: Academic paper
    }

    // Default: intermediate level
    return 3;
  }

  static getLevelName(level: HintLevel): string {
    const names: Record<HintLevel, string> = {
      1: '기본 가이드',
      2: '실제 사례',
      3: '데이터/통계',
      4: '학술 논문',
      5: '전문가 인사이트',
    };
    return names[level];
  }

  static getLevelDescription(level: HintLevel): string {
    const descriptions: Record<HintLevel, string> = {
      1: '텍스트의 관련 부분을 안내하여 기본적인 이해를 돕습니다.',
      2: '실제 세계의 사례와 비유를 통해 개념을 이해하도록 합니다.',
      3: '관련 데이터와 통계를 제공하여 논증의 근거를 강화합니다.',
      4: '관련 학술 논문과 연구 결과를 소개합니다.',
      5: '해당 분야 전문가의 관점과 분석을 공유합니다.',
    };
    return descriptions[level];
  }
}

// =============================================
// IntelligentHintGenerator Class
// =============================================

export class IntelligentHintGenerator {
  private soongsilApiKey: string;
  private geminiApiKey: string | undefined;
  private webSearch: WebSearchAggregator;

  constructor(soongsilApiKey: string, geminiApiKey?: string) {
    this.soongsilApiKey = soongsilApiKey;
    this.geminiApiKey = geminiApiKey;
    this.webSearch = new WebSearchAggregator(soongsilApiKey, geminiApiKey);
  }

  /**
   * Generate an intelligent hint based on session state
   */
  async generateHint(
    session: SessionState,
    bookText: string,
  ): Promise<IntelligentHint> {
    const level = HintLevelDeterminer.determine(session);
    const levelName = HintLevelDeterminer.getLevelName(level);

    try {
      switch (level) {
        case 1:
          return await this.generateLevel1Hint(session, bookText, level, levelName);
        case 2:
          return await this.generateLevel2Hint(session, bookText, level, levelName);
        case 3:
          return await this.generateLevel3Hint(session, bookText, level, levelName);
        case 4:
          return await this.generateLevel4Hint(session, bookText, level, levelName);
        case 5:
          return await this.generateLevel5Hint(session, bookText, level, levelName);
        default:
          throw new Error('unsupported_hint_level');
      }
    } catch (error) {
      console.error(`Hint generation error (level ${level}):`, error);
      throw error;
    }
  }

  // ---- Level 1: Basic Text Guide ----
  private async generateLevel1Hint(
    session: SessionState,
    bookText: string,
    level: HintLevel,
    levelName: string,
  ): Promise<IntelligentHint> {
    const result = await callAIJSON<HintGenerationResult>(
      this.soongsilApiKey,
      this.geminiApiKey,
      `당신은 독서 토론 코치입니다. 학생이 텍스트에서 근거를 찾는 것을 도와야 합니다.
힌트 레벨 1: 텍스트의 특정 부분이나 장을 안내하세요.
정답을 직접 제시하지 마세요. 학생이 스스로 찾도록 방향만 제시하세요.
한국어로 응답하세요.
JSON으로 응답: { "hintMessage": "힌트 내용", "explanation": "이 힌트를 선택한 이유" }`,
      `토픽: ${session.topic}
학생 주장: ${session.currentClaim || session.coreClaim}
현재 약점: ${session.currentWeakness?.description || '없음'}
턴: ${session.currentTurn}/${session.maxTurns}
Phase: ${session.currentPhase}

텍스트 일부:
${bookText.substring(0, 1500)}

학생이 참고할 수 있는 텍스트 부분을 안내하는 힌트를 작성하세요.`,
      { temperature: 0.5, maxTokens: 500 },
    );

    return {
      level,
      levelName,
      message: result.hintMessage,
    };
  }

  // ---- Level 2: Real-world Example ----
  private async generateLevel2Hint(
    session: SessionState,
    bookText: string,
    level: HintLevel,
    levelName: string,
  ): Promise<IntelligentHint> {
    const result = await callAIJSON<HintGenerationResult>(
      this.soongsilApiKey,
      this.geminiApiKey,
      `당신은 독서 토론 코치입니다.
힌트 레벨 2: 토론 주제와 관련된 실제 세계 사례를 제시하세요.
비즈니스, 사회, 기술 등 실제 사례를 통해 학생의 사고를 확장하세요.
한국어로 응답하세요.
JSON으로 응답: { "hintMessage": "힌트 내용 (실제 사례 포함)", "explanation": "이유" }`,
      `토픽: ${session.topic}
학생 주장: ${session.currentClaim || session.coreClaim}
약점: ${session.currentWeakness?.description || '없음'}

이 주제와 관련된 실제 세계 사례를 활용한 힌트를 작성하세요.`,
      { temperature: 0.7, maxTokens: 600 },
    );

    return {
      level,
      levelName,
      message: result.hintMessage,
    };
  }

  // ---- Level 3: Data/Statistics ----
  private async generateLevel3Hint(
    session: SessionState,
    bookText: string,
    level: HintLevel,
    levelName: string,
  ): Promise<IntelligentHint> {
    // Use web search for data
    let searchResults: SearchResult[] = [];
    let searchSummary = '';

    try {
      const searchOutput = await this.webSearch.searchAndAggregate(
        session.topic,
        `학생이 "${session.currentClaim}" 주장에 대한 데이터 근거를 찾고 있습니다.`,
        session.currentWeakness?.description,
      );
      searchResults = searchOutput.results.slice(0, 3);
      searchSummary = searchOutput.summary;
    } catch (e) {
      console.error('Web search for Level 3 hint failed:', e);
    }

    const result = await callAIJSON<HintGenerationResult>(
      this.soongsilApiKey,
      this.geminiApiKey,
      `당신은 데이터 분석가 겸 교육 코치입니다.
힌트 레벨 3: 통계, 데이터, 조사 결과를 활용한 힌트를 제시하세요.
구체적인 수치와 출처를 포함하세요.
한국어로 응답하세요.
JSON으로 응답: { "hintMessage": "데이터 기반 힌트", "explanation": "이유" }`,
      `토픽: ${session.topic}
학생 주장: ${session.currentClaim}
${searchSummary ? `관련 검색 결과 요약: ${searchSummary}` : ''}

데이터와 통계를 활용한 힌트를 작성하세요.`,
      { temperature: 0.5, maxTokens: 700 },
    );

    return {
      level,
      levelName,
      message: result.hintMessage,
      sources: searchResults.length > 0 ? searchResults : undefined,
      searchSummary: searchSummary || undefined,
    };
  }

  // ---- Level 4: Academic Paper ----
  private async generateLevel4Hint(
    session: SessionState,
    bookText: string,
    level: HintLevel,
    levelName: string,
  ): Promise<IntelligentHint> {
    let searchResults: SearchResult[] = [];
    let searchSummary = '';

    try {
      const searchOutput = await this.webSearch.searchAndAggregate(
        session.topic,
        `학술적 관점에서 "${session.currentClaim}" 주장을 검증할 논문이 필요합니다.`,
        session.currentWeakness?.description,
      );
      searchResults = searchOutput.results
        .filter(r => r.source === 'paper' || r.relevanceScore >= 70)
        .slice(0, 3);
      searchSummary = searchOutput.summary;
    } catch (e) {
      console.error('Web search for Level 4 hint failed:', e);
    }

    const result = await callAIJSON<HintGenerationResult>(
      this.soongsilApiKey,
      this.geminiApiKey,
      `당신은 학술 연구 전문가입니다.
힌트 레벨 4: 관련 학술 논문이나 연구 결과를 소개하세요.
저자명, 연도, 핵심 발견을 포함하세요.
한국어로 응답하세요.
JSON으로 응답: { "hintMessage": "학술 논문 기반 힌트", "explanation": "이유" }`,
      `토픽: ${session.topic}
학생 주장: ${session.currentClaim}
현재 Phase: ${session.currentPhase}
${searchSummary ? `검색 결과: ${searchSummary}` : ''}

학술적 관점에서 사고를 심화시킬 힌트를 작성하세요.`,
      { temperature: 0.5, maxTokens: 800 },
    );

    return {
      level,
      levelName,
      message: result.hintMessage,
      sources: searchResults.length > 0 ? searchResults : undefined,
      searchSummary: searchSummary || undefined,
    };
  }

  // ---- Level 5: Expert Insight ----
  private async generateLevel5Hint(
    session: SessionState,
    bookText: string,
    level: HintLevel,
    levelName: string,
  ): Promise<IntelligentHint> {
    let searchResults: SearchResult[] = [];
    let searchSummary = '';

    try {
      const searchOutput = await this.webSearch.searchAndAggregate(
        session.topic,
        `전문가 관점에서 "${session.currentClaim}"에 대한 깊이 있는 분석이 필요합니다.`,
      );
      searchResults = searchOutput.results
        .filter(r => r.source === 'expert_opinion' || r.relevanceScore >= 80)
        .slice(0, 3);
      searchSummary = searchOutput.summary;
    } catch (e) {
      console.error('Web search for Level 5 hint failed:', e);
    }

    const result = await callAIJSON<HintGenerationResult>(
      this.soongsilApiKey,
      this.geminiApiKey,
      `당신은 해당 분야의 최고 전문가입니다.
힌트 레벨 5: 전문가의 관점에서 깊이 있는 통찰을 제공하세요.
다양한 학파의 관점, 최신 연구 동향, 비판적 분석을 포함하세요.
한국어로 응답하세요.
JSON으로 응답: { "hintMessage": "전문가 인사이트", "explanation": "이유" }`,
      `토픽: ${session.topic}
학생 주장: ${session.currentClaim}
Phase: ${session.currentPhase} (${session.currentTurn}/${session.maxTurns}턴)
학생 등급: ${session.rating}
${searchSummary ? `전문가 검색 결과: ${searchSummary}` : ''}

전문가 수준의 심화 인사이트를 제공하세요.`,
      { temperature: 0.7, maxTokens: 1000 },
    );

    return {
      level,
      levelName,
      message: result.hintMessage,
      sources: searchResults.length > 0 ? searchResults : undefined,
      searchSummary: searchSummary || undefined,
    };
  }

}
