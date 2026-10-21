아래 정보는 이번 최종 턴이 저장되기 전의 검증된 입력입니다.
토픽: {{TOPIC}}
도서: {{BOOK_TITLE}}
초기 주장: {{INITIAL_CLAIM}}
최종 주장(이번 턴): {{FINAL_CLAIM}}
이번 턴 평가: {{EVALUATION_JSON}}
이전 근거 인용: {{EVIDENCE_CITED}}회
약점 패턴: {{WEAKNESS_PATTERN}}
힌트 사용: {{HINT_REQUEST_COUNT}}회

대화 기록(기존 기록 + 이번 학습자/튜터 메시지):
{{CONVERSATION_JSON}}

JSON: {
  "summary": "3문장 종합 요약",
  "microAnalysis": {"comprehension":0-100,"judgment":0-100,"persuasion":0-100,"evidenceQuality":0-100,"reasoning":0-100,"consistency":0-100,"revision":0-100,"relevance":0-100},
  "strengths": ["강점(턴 번호 포함)"],
  "weaknesses": ["약점(턴 번호 포함)"],
  "growthTrajectory": "성장 경로 2-3문장",
  "prescriptiveFeedback": {"immediate":["즉시 개선"],"nextSession":["다음 세션 전략"],"longTerm":["장기 능력"]},
  "turnByTurnGrowth": {"earlyPhase":"1-3턴 특성","midPhase":"4-7턴 변화","latePhase":"8-10턴 도달"}
}
