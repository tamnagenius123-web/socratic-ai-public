// ============================================================
// v18 Voice Analyzer — 파괴적 혁신 #3 스켈레톤
// ============================================================
// 음성 기반 소크라틱 대화 분석
// Web Speech API (STT) + TTS 결합
// 경영진 대상 구두 발표 훈련 특화
// ============================================================

export interface VoiceAnalysis {
  transcription: string;
  speechRate: number;          // 초당 단어 수
  disfluencyCount: number;     // 망설임 횟수
  pausePattern: number[];      // 발화 내 침묵 패턴 (ms)
  vocalConfidence: number;     // 0-1
  totalDuration: number;       // 발화 시간 (ms)
}

export interface VoiceMetacognitionSignals {
  cognitiveLoad: number;    // 인지 부하 (0-1)
  certainty: number;        // 확신도 (0-1)
  thoughtfulness: number;   // 숙고도 (0-1)
}

/**
 * 음성 메타데이터에서 메타인지 신호 추출
 */
export function extractVoiceMetacognitionSignals(
  analysis: VoiceAnalysis,
): VoiceMetacognitionSignals {
  // 망설임이 많을수록 인지 부하 높음
  const wordCount = analysis.transcription.split(/\s+/).length;
  const disfluencyRate = analysis.disfluencyCount / Math.max(1, wordCount);
  const cognitiveLoad = Math.min(1, disfluencyRate * 5);

  // 발화 속도 분석
  const normalRate = 3.5; // 정상: 초당 3.5단어
  const speedDeviation = Math.abs(analysis.speechRate - normalRate) / normalRate;
  const certainty = analysis.vocalConfidence * (1 - Math.min(0.5, speedDeviation));

  // 긴 pause (> 2초)는 숙고 신호
  const longPauses = analysis.pausePattern.filter(p => p > 2000).length;
  const thoughtfulness = Math.min(1, longPauses / 3);

  return {
    cognitiveLoad: Math.round(cognitiveLoad * 1000) / 1000,
    certainty: Math.round(certainty * 1000) / 1000,
    thoughtfulness: Math.round(thoughtfulness * 1000) / 1000,
  };
}

/**
 * 텍스트 기반 망설임 탐지 (한국어)
 */
export function detectDisfluencies(text: string): {
  count: number;
  markers: string[];
} {
  const pattern = /\b(음|어|그|뭐|아|이제|사실|그러니까|저기|그게)\b/g;
  const matches = text.match(pattern) || [];
  return {
    count: matches.length,
    markers: matches,
  };
}
