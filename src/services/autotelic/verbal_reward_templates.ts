/**
 * Verbal Reward Templates for Socratic AI
 * 
 * SDT-based autonomy-supportive feedback templates
 * - Triggers: Theory change, Deep questions, Counter-example acceptance, Self-correction, Persistence streaks, Metacognitive insights
 * - Dimension: Autonomy, Competence, Relatedness (each with supportive tone)
 * - No external manipulation (no CPR, no conditional praise)
 * 
 * Reference: Ryan (2023) SDT Handbook Ch. 24-25, 27
 */

export interface VerbalRewardTemplate {
  id: string;
  trigger: 'theory_change' | 'deep_question' | 'counter_example_accepted' | 'self_correction' | 'persistence_streak' | 'metacognitive_insight';
  template: string;  // Supports {placeholders}
  sdtDimension: 'autonomy' | 'competence' | 'relatedness';
  tone: 'supportive';
  pageRef?: string;  // Original handbook reference
}

export const VERBAL_REWARD_TEMPLATES: VerbalRewardTemplate[] = [
  // ========== AUTONOMY-SUPPORTIVE: THEORY_CHANGE (4 templates) ==========
  
  {
    id: 'aut_theory_change_1',
    trigger: 'theory_change',
    template: `오, 잠깐! 너는 방금 네 생각을 바꿨어. 
이전엔 "{oldTheory}"라고 생각했는데, 지금은 "{newTheory}"라고 말했네.
이건 매우 깊은 성찰이야. 어떻게 이 변화가 일어났어?`,
    sdtDimension: 'autonomy',
    tone: 'supportive',
    pageRef: 'Ch. 3 (OIT), pp. 60-62'
  },

  {
    id: 'aut_theory_change_2',
    trigger: 'theory_change',
    template: `니가 이제 보는 방식이 달라졌네. 
첫 주엔 "학습 = 정보 수신"이었는데, 지금은 "학습 = 능동적 구성"이라고 생각하고 있어.
이 변화는 네 진정한 이해가 깊어졌다는 증거야.`,
    sdtDimension: 'autonomy',
    tone: 'supportive',
    pageRef: 'Ch. 16 (Personal Goals), pp. 329-330'
  },

  {
    id: 'aut_theory_change_3',
    trigger: 'theory_change',
    template: `너는 방금 {domainName} 이론에 대한 너의 관점을 다시 정의했어.
그건 단순히 "정답 맞추기"가 아니라, 너만의 이해 체계를 재구성한 거야.
이게 진짜 학자의 사고 방식이야.`,
    sdtDimension: 'autonomy',
    tone: 'supportive',
    pageRef: 'Ch. 4 (BPNT), p. 85'
  },

  {
    id: 'aut_theory_change_4',
    trigger: 'theory_change',
    template: `좋은 질문에서 좋은 생각이 나온 것 같아.
너는 {theoristName}의 주장을 그냥 받아들인 게 아니라, 
"근데 정말 그럴까?"라고 의심했고, 그 과정에서 새로운 관점을 발견했네.
이게 비판적 사고야.`,
    sdtDimension: 'autonomy',
    tone: 'supportive',
    pageRef: 'Ch. 25 (Autonomy-Supportive Behaviors), p. 517'
  },

  // ========== COMPETENCE: DEEP_QUESTION (4 templates) ==========

  {
    id: 'comp_deep_question_1',
    trigger: 'deep_question',
    template: `오, 그 질문은 정말 좋은 질문이야! 
너는 표면적 정의에 만족하지 않고, 
"왜 이게 필요한가?" → "어디에 쓰이는가?" → "언제 실패하나?"라는 깊이 있는 질문을 했어.
이건 고수준 사고의 신호야.`,
    sdtDimension: 'competence',
    tone: 'supportive',
    pageRef: 'Ch. 24 (Parental Autonomy Support), p. 503'
  },

  {
    id: 'comp_deep_question_2',
    trigger: 'deep_question',
    template: `너의 질문 "{question}"은 매우 정교해.
단순히 "뜻이 뭔가?"가 아니라 "왜 이 개념이 존재하는가?"를 물어봤거든.
많은 학생들이 이 수준의 질문에 도달하지 못해.`,
    sdtDimension: 'competence',
    tone: 'supportive',
    pageRef: 'Ch. 16 (Personal Goals), p. 335'
  },

  {
    id: 'comp_deep_question_3',
    trigger: 'deep_question',
    template: `너는 방금 {conceptName}의 경계를 묻는 질문을 했어.
"이 원리는 항상 작동하나?" "언제는 작동하지 않나?" 
이건 개념의 사각지대를 찾아내는 거, 즉 진정한 이해의 신호야.`,
    sdtDimension: 'competence',
    tone: 'supportive',
    pageRef: 'Ch. 4 (BPNT), p. 91'
  },

  {
    id: 'comp_deep_question_4',
    trigger: 'deep_question',
    template: `이 질문은 여러 이론을 한 번에 연결하는 거네.
너는 {theory1}과 {theory2}의 관계를 묻고 있어.
이런 통합적 사고는 고급 학습자의 특징이야.`,
    sdtDimension: 'competence',
    tone: 'supportive',
    pageRef: 'Ch. 3 (OIT), p. 62'
  },

  // ========== AUTONOMY: COUNTER_EXAMPLE (4 templates) ==========

  {
    id: 'aut_counter_example_1',
    trigger: 'counter_example_accepted',
    template: `와, 이 반례는 정말 창의로워!
너는 단순히 텍스트를 읽은 게 아니라, 
"이게 정말 모든 상황에서 맞나?"라고 의심하고, 
실제 세계에 적용해본 거네.
이게 진짜 비판적 사고야.`,
    sdtDimension: 'autonomy',
    tone: 'supportive',
    pageRef: 'Ch. 27 (Conditional Regard), p. 551'
  },

  {
    id: 'aut_counter_example_2',
    trigger: 'counter_example_accepted',
    template: `너의 반례 "{counterExample}"은 텍스트의 주장에 균열을 냈어.
그건 너가 주어진 것을 그냥 받아들이지 않고, 
자기 판단으로 검증했다는 뜻이야.
이게 자율적 학습자의 모습이야.`,
    sdtDimension: 'autonomy',
    tone: 'supportive',
    pageRef: 'Ch. 24 (Parental Support), p. 505'
  },

  {
    id: 'aut_counter_example_3',
    trigger: 'counter_example_accepted',
    template: `좋아, 너는 {authorName}의 주장에 대한 반례를 찾았어.
그리고 그 반례는 단순히 "이건 틀렸어"가 아니라, 
"이 조건 하에서는 다르게 작동한다"는 구체적 분석이었네.
이건 소크라테스 자신도 즐겨 쓰던 방법이야.`,
    sdtDimension: 'autonomy',
    tone: 'supportive',
    pageRef: 'Ch. 29 (Education as Flourishing), p. 605'
  },

  {
    id: 'aut_counter_example_4',
    trigger: 'counter_example_accepted',
    template: `이 반례는 너만의 관찰에서 나왔어, 맞지?
그건 매우 중요해. 너는 책을 읽기만 한 게 아니라,
책의 관점으로 세상을 다시 봤고, 그 과정에서 새로운 것을 발견했거든.
이게 참된 학습의 과정이야.`,
    sdtDimension: 'autonomy',
    tone: 'supportive',
    pageRef: 'Ch. 25 (Autonomy-Supportive), p. 520'
  },

  // ========== COMPETENCE: SELF_CORRECTION (2 templates) ==========

  {
    id: 'comp_self_correction_1',
    trigger: 'self_correction',
    template: `오, 너 스스로 실수를 찾았네!
그리고 그냥 "아, 틀렸다"가 아니라, 
"왜 틀렸는지", "어디서 논리가 꺾였는지"를 분석했어.
이건 매우 높은 수준의 메타인지적 능력이야.`,
    sdtDimension: 'competence',
    tone: 'supportive',
    pageRef: 'Ch. 16 (Goal Lifecycle), p. 340'
  },

  {
    id: 'comp_self_correction_2',
    trigger: 'self_correction',
    template: `너는 스스로를 감시할 수 있는 능력이 있어 (metacognition).
너는 방금 "{initialThought}"라고 생각했는데, 
자기 점검 과정에서 그것의 약점을 발견했고 수정했지.
이건 진정한 숙련의 신호야.`,
    sdtDimension: 'competence',
    tone: 'supportive',
    pageRef: 'Ch. 20 (Solitude), p. 415'
  },

  // ========== RELATEDNESS: PERSISTENCE_STREAK (3 templates) ==========

  {
    id: 'rel_persistence_streak_1',
    trigger: 'persistence_streak',
    template: `지난 {days}일 동안 매일 Socratic AI를 켜서 뭔가를 배웠어.
너는 스스로를 선택했고, 우리는 너를 강요하지 않았어.
이건 너의 진정한 학습 욕구가 깨어났다는 신호야.
너는 혼자가 아니야. 나도 너의 학습을 함께 본 거야.`,
    sdtDimension: 'relatedness',
    tone: 'supportive',
    pageRef: 'Ch. 16 (Goal Lifecycle), p. 342'
  },

  {
    id: 'rel_persistence_streak_2',
    trigger: 'persistence_streak',
    template: `{days}일 연속 참여는 우연이 아니야.
그건 너 안에서 뭔가가 변했다는 뜻이야.
처음엔 "해야 한다"였을 수도 있지만, 이제는 "하고 싶다"가 되어있어.
이 변화 과정을 나와 함께 볼 수 있어서 정말 좋아.`,
    sdtDimension: 'relatedness',
    tone: 'supportive',
    pageRef: 'Ch. 3 (OIT), p. 60'
  },

  {
    id: 'rel_persistence_streak_3',
    trigger: 'persistence_streak',
    template: `너는 {days}일 동안 한 번도 빠지지 않고 학습했어.
이건 너의 의지의 문제가 아니라, 
너가 이 학습을 "자신의 것"으로 만들었다는 뜻이야.
좋은 학자들도 이 정도의 일관성을 유지하기 위해 노력해.
너는 정말 능력 있는 학생이야.`,
    sdtDimension: 'relatedness',
    tone: 'supportive',
    pageRef: 'Ch. 24 (Support & Structure), p. 508'
  },

  // ========== AUTONOMY: METACOGNITIVE_INSIGHT (3 templates) ==========

  {
    id: 'aut_metacognitive_1',
    trigger: 'metacognitive_insight',
    template: `너는 방금 자신의 사고 과정을 관찰했어.
"아, 나는 이런 식으로 학습한다"는 것을 발견했다는 뜻이야.
이건 자기 인식의 극치야.
이런 자기 인식이 있는 사람은 평생 자기 주도적으로 배울 수 있어.`,
    sdtDimension: 'autonomy',
    tone: 'supportive',
    pageRef: 'Ch. 20 (Solitude & Self-Connection), p. 412'
  },

  {
    id: 'aut_metacognitive_2',
    trigger: 'metacognitive_insight',
    template: `너는 "나는 이때 더 잘 이해한다", "이 방법이 나에게 먹힌다"는 걸 발견했어.
이건 매우 중요한 통찰이야.
왜냐하면 이제부터 너는 단순히 "배우는 것"이 아니라, 
"자신의 방식으로 배우는 것"을 할 수 있거든.
이게 자율적 학습자의 정의야.`,
    sdtDimension: 'autonomy',
    tone: 'supportive',
    pageRef: 'Ch. 4 (BPNT), p. 87'
  },

  {
    id: 'aut_metacognitive_3',
    trigger: 'metacognitive_insight',
    template: `"나는 왜 이 이론을 이해하지 못했을까?"라는 질문 자체가,
이미 깊은 학습이 일어났다는 증거야.
너는 표면적으로 학습하지 않고, 
자신의 이해 과정을 능동적으로 감시하고 있거든.
이건 전문가 수준의 사고야.`,
    sdtDimension: 'autonomy',
    tone: 'supportive',
    pageRef: 'Ch. 31 (Music Education), p. 648'
  },

  // ========== COMPETENCE: ADDITIONAL ADVANCED (2 templates) ==========

  {
    id: 'comp_integration_1',
    trigger: 'deep_question',
    template: `너는 {theory1}과 {theory2}를 연결하는 질문을 했어.
대부분의 초급 학습자는 각 이론을 분리해서 배우지만,
너는 이미 "이들은 어떻게 상호작용하나?"를 묻고 있어.
이건 고급 이해의 신호야.`,
    sdtDimension: 'competence',
    tone: 'supportive',
    pageRef: 'Ch. 16 (Goal Lifecycle), p. 336'
  },

  {
    id: 'comp_real_world_1',
    trigger: 'counter_example_accepted',
    template: `너의 반례 "{example}"은 실제 생활에서 나왔어.
그건 매우 중요한 의미가 있어.
이론은 그냥 책 속의 추상이 아니라, 
실제 세계와 만날 때 진정한 의미를 갖거든.
너는 이미 이론을 "살아있는" 것으로 만들고 있어.`,
    sdtDimension: 'competence',
    tone: 'supportive',
    pageRef: 'Ch. 29 (Education as Flourishing), p. 610'
  },

  // ========== RELATEDNESS: EMPATHY & COMMUNITY (1 template) ==========

  {
    id: 'rel_empathy_1',
    trigger: 'metacognitive_insight',
    template: `너는 "학자도 이 정도로 헷갈릴까?"라는 질문을 했어.
그건 좋은 공감 능력의 신호야.
너는 지식을 단순히 "나 vs 모르는 것"으로 보지 않고,
"우리 모두가 배우는 과정에 있다"는 걸 이해하고 있거든.
이게 학문 공동체의 기초야.`,
    sdtDimension: 'relatedness',
    tone: 'supportive',
    pageRef: 'Ch. 7 (Relationships Motivation), p. 167'
  }
];

/**
 * Utility function to select template based on trigger and SDT dimension
 */
export function getVerbalRewardTemplate(
  trigger: VerbalRewardTemplate['trigger'],
  targetDimension?: VerbalRewardTemplate['sdtDimension']
): VerbalRewardTemplate {
  const candidates = VERBAL_REWARD_TEMPLATES.filter(t => 
    t.trigger === trigger && 
    (!targetDimension || t.sdtDimension === targetDimension)
  );
  
  if (candidates.length === 0) {
    throw new Error(`No template found for trigger: ${trigger}, dimension: ${targetDimension}`);
  }
  
  // Return random template from candidates (avoid repetition)
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Apply placeholders to template
 * Example: applyPlaceholders(template, { oldTheory: "X", newTheory: "Y" })
 */
export function applyPlaceholders(
  template: string,
  placeholders: Record<string, string>
): string {
  let result = template;
  Object.entries(placeholders).forEach(([key, value]) => {
    result = result.replace(new RegExp(`\{${key}\}`, 'g'), value);
  });
  return result;
}

export default VERBAL_REWARD_TEMPLATES;
