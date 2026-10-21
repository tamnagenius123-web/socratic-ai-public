// v12.0: Student Phrase Extractor (수정안 C)
// 학생 발화에서 인용 가능한 핵심 구절, 암묵적 전제, 논리적 약점을 추출
// 튜터 프롬프트에 "이 표현을 인용하여 반격하라"고 전달

/**
 * 학생 발화에서 인용 가능한 핵심 구절을 추출
 * 튜터 프롬프트에 "이 표현을 인용하여 반격하라"고 전달
 */
export function extractQuotablePhrase(studentMessage: string): {
  keyPhrases: string[];          // 인용할 핵심 표현
  implicitAssumptions: string[]; // 암묵적 전제
  vulnerablePoints: string[];    // 공격 가능한 논리적 약점
} {
  const msg = studentMessage.trim();
  const keyPhrases: string[] = [];
  const implicitAssumptions: string[] = [];
  const vulnerablePoints: string[] = [];

  // 1. 핵심 주장 문장 추출 (인과/결론 표현 포함 문장)
  const sentences = msg.split(/[.!?。！？]/).filter(s => s.trim().length > 10);
  for (const sentence of sentences) {
    if (/따라서|그러므로|결국|결론적으로|즉/.test(sentence)) {
      keyPhrases.push(sentence.trim());
    }
    if (/때문에|이유는|왜냐하면/.test(sentence)) {
      keyPhrases.push(sentence.trim());
    }
  }

  // 2. 절대 표현 → 반례 공격 가능
  const absoluteMatch = msg.match(/(모든|항상|절대|반드시|결코|전부|어떤\s*\S+도)[^.!?]*[.!?]?/g);
  if (absoluteMatch) {
    absoluteMatch.forEach(m => vulnerablePoints.push(`절대 표현: "${m.trim()}"`));
  }

  // 3. 이분법적 사고 → 제3의 가능성 제시 가능
  const binaryMatch = msg.match(/(이거나|이든|둘\s*중\s*하나|아니면)[^.!?]*/g);
  if (binaryMatch) {
    vulnerablePoints.push('이분법적 사고 감지 → 제3의 가능성을 질문하세요');
  }

  // 4. 인과 주장 감지 → 인과의 방향/필연성 도전
  if (/때문에|이므로|따라서|결과적으로/.test(msg)) {
    vulnerablePoints.push('인과 주장 감지 → 인과의 방향/필연성에 도전하세요');
  }

  // 5. 감정 호소 감지 → 구체적 텍스트 근거로 전환 유도
  if (/느끼|감정|마음|영혼|정신|공감/.test(msg)) {
    vulnerablePoints.push('감정/추상어 감지 → 구체적 텍스트 근거로 전환을 유도하세요');
  }

  // 6. 암묵적 전제 추론
  if (/자유|자유롭/.test(msg) && !/자유란|자유의\s*정의/.test(msg)) {
    implicitAssumptions.push('"자유"의 정의가 암묵적으로 전제됨 → 정의를 요구하세요');
  }
  if (/좋[은다]|나[쁜쁘]|옳[은다]|그[른렇]/.test(msg) && !/기준|척도|근거/.test(msg)) {
    implicitAssumptions.push('가치 판단의 기준이 명시되지 않음 → 기준을 요구하세요');
  }
  if (/당연|명백|분명|물론/.test(msg)) {
    implicitAssumptions.push('자명성 주장 감지 → 왜 당연한지를 물어보세요');
  }

  // 7. 최소 1개는 반환 (첫 문장 사용)
  if (keyPhrases.length === 0 && sentences.length > 0) {
    keyPhrases.push(sentences[0].trim());
  }

  return { keyPhrases, implicitAssumptions, vulnerablePoints };
}

/**
 * 학생 답변에서 핵심 키워드 추출 (폴백 응답 동적화용)
 */
export function extractKeywordsFromAnswer(answer: string): string[] {
  const words = answer.split(/\s+/).filter(w => w.length >= 2);
  const stopwords = new Set(['그리고', '하지만', '따라서', '그러므로', '때문에', '있다', '없다', '것이다', '합니다', '입니다', '있습니다', '없습니다', '이다', '아니다']);
  return words.filter(w => !stopwords.has(w)).slice(0, 5);
}

/**
 * 프롬프트용 학생 공격 컨텍스트 문자열 빌드
 */
export function buildStudentAttackContext(
  latestStudentAnswer: string,
  implicitAssumptions: string[],
  vulnerablePoints: string[],
): string {
  const lines: string[] = [];

  if (vulnerablePoints.length > 0) {
    lines.push('## ⚔️ 공격 가능 지점 (집중 공략)');
    vulnerablePoints.forEach(p => lines.push(`- ${p}`));
  }

  if (implicitAssumptions.length > 0) {
    lines.push('## 🔍 학생의 숨겨진 전제');
    implicitAssumptions.forEach(p => lines.push(`- ${p}`));
  }

  return lines.join('\n');
}
