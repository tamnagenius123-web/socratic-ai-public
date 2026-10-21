// SocraticAI v35 — Walton Argumentation Schemes Catalog
// 원전: Walton, D., Reed, C., & Macagno, F. (2008). Argumentation Schemes. Cambridge University Press.
// 관련 태스크: T1.3.1 counter-simulation, T1.3.3 intuition-discriminator
// 사용처: 태극 엔진이 현재 학생 논증의 스키마를 식별하고, 해당 스키마의 Critical Questions 중 하나를
//         "최강 반례"로 선택해 주입할 때 참조.

export type SchemeCategory =
  | 'reasoning'        // Deductive/Inductive/Practical/Abductive/Causal
  | 'source_based'     // 전문가/증언/무지/편향 등
  | 'rules_to_cases'   // 예시/유추/선례/규칙
  | 'verbal_classif';  // 언어적 분류

export type EducationalFit = 'high' | 'medium' | 'low';

export interface WaltonScheme {
  id: string;
  nameEn: string;
  nameKo: string;
  category: SchemeCategory;
  premises: string[];
  conclusion: string;
  criticalQuestions: string[];  // CQ
  educationalFit: EducationalFit;
  pageRef: string;  // 원전 페이지
}

/**
 * 상위 30개 스키마 카탈로그.
 * 각 스키마의 `criticalQuestions`가 태극 엔진이 반례를 만들 때 쓸 템플릿.
 * educationalFit 'high' = 일반 학습자가 자주 마주치는 논증 유형.
 */
export const WALTON_SCHEMES: WaltonScheme[] = [
  // ===== Practical Reasoning =====
  {
    id: 'arg_from_consequences_positive',
    nameEn: 'Argument from Positive Consequences',
    nameKo: '긍정적 결과 논증',
    category: 'reasoning',
    premises: [
      'If action A is done, then positive consequence C follows.',
      'C is good/desirable.',
    ],
    conclusion: 'Therefore, A should be done.',
    criticalQuestions: [
      'How strong is the causal link from A to C?',
      'Is C actually desirable from all relevant viewpoints?',
      'Are there negative consequences of A that outweigh C?',
    ],
    educationalFit: 'high',
    pageRef: 'p.100, p.332',
  },
  {
    id: 'arg_from_consequences_negative',
    nameEn: 'Argument from Negative Consequences',
    nameKo: '부정적 결과 논증',
    category: 'reasoning',
    premises: [
      'If A is done, negative consequence C follows.',
      'C is bad.',
    ],
    conclusion: 'Therefore, A should not be done.',
    criticalQuestions: [
      'How strong is the causal link?',
      'Is C actually bad?',
      'Are there positive consequences that outweigh C?',
    ],
    educationalFit: 'high',
    pageRef: 'p.100, p.332',
  },
  {
    id: 'arg_from_alternatives',
    nameEn: 'Argument from Alternatives',
    nameKo: '대안 논증',
    category: 'reasoning',
    premises: [
      'Either A or B must be chosen.',
      'B is bad.',
    ],
    conclusion: 'Therefore, A should be chosen.',
    criticalQuestions: [
      'Are A and B truly the only options?',
      'Is B really as bad as claimed?',
      'Is the dichotomy false?',
    ],
    educationalFit: 'high',
    pageRef: 'p.332',
  },
  {
    id: 'arg_from_sunk_costs',
    nameEn: 'Argument from Sunk Costs',
    nameKo: '매몰 비용 논증',
    category: 'reasoning',
    premises: [
      'I have already invested heavily in A.',
      'Stopping now wastes the investment.',
    ],
    conclusion: 'Therefore, continue A.',
    criticalQuestions: [
      'Is the past investment truly recoverable only via continuation?',
      'Does the expected future benefit justify further investment?',
      'Is this a sunk-cost fallacy?',
    ],
    educationalFit: 'high',
    pageRef: 'p.332',
  },
  {
    id: 'arg_from_threat',
    nameEn: 'Argument from Threat',
    nameKo: '위협 논증',
    category: 'reasoning',
    premises: [
      'If A is not done, bad consequence happens.',
      'Source making threat has power.',
    ],
    conclusion: 'Therefore, A must be done.',
    criticalQuestions: [
      'Is the threat credible?',
      'Does the source actually have power?',
      'Is this a coercive fallacy?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.332',
  },

  // ===== Causal =====
  {
    id: 'arg_from_cause_to_effect',
    nameEn: 'Argument from Cause to Effect',
    nameKo: '원인→결과 논증',
    category: 'reasoning',
    premises: [
      'Generally, if A occurs, B will (might) occur.',
      'In this case, A occurs.',
    ],
    conclusion: 'Therefore, in this case, B will occur.',
    criticalQuestions: [
      'How strong is the causal generalization?',
      'Is the evidence cited strong enough to warrant the generalization as stated?',
      'Are there other factors that would interfere with or counteract the production of the effect?',
    ],
    educationalFit: 'high',
    pageRef: 'pp.168-170',
  },
  {
    id: 'arg_from_correlation_to_cause',
    nameEn: 'Argument from Correlation to Cause',
    nameKo: '상관→인과 논증',
    category: 'reasoning',
    premises: [
      'A positive correlation between A and B has been found.',
    ],
    conclusion: 'Therefore, A causes B.',
    criticalQuestions: [
      'Is there a genuine correlation?',
      'Could B cause A (reverse causation)?',
      'Could a third variable C cause both?',
      'Is the correlation spurious or coincidental?',
    ],
    educationalFit: 'high',
    pageRef: 'p.170',
  },
  {
    id: 'causal_slippery_slope',
    nameEn: 'Causal Slippery Slope',
    nameKo: '인과 미끄러운 경사',
    category: 'reasoning',
    premises: [
      'Action A₀ leads to A₁, A₁ leads to A₂, ..., A_{n-1} leads to A_n (bad).',
    ],
    conclusion: 'Therefore, A₀ should not be done.',
    criticalQuestions: [
      'Is each causal step probable?',
      'Is there a reasonable stopping point?',
      'Is cumulative probability of the chain high?',
    ],
    educationalFit: 'medium',
    pageRef: 'pp.331, 339',
  },

  // ===== Abductive =====
  {
    id: 'arg_from_sign',
    nameEn: 'Argument from Sign',
    nameKo: '징후 논증',
    category: 'reasoning',
    premises: [
      'Sign S is present.',
      'S is generally a sign of condition C.',
    ],
    conclusion: 'Therefore, C is present.',
    criticalQuestions: [
      'Is S really present?',
      'Could S be due to something other than C?',
      'Is the general S→C association strong?',
    ],
    educationalFit: 'high',
    pageRef: 'pp.329-330',
  },
  {
    id: 'arg_from_evidence_to_hypothesis',
    nameEn: 'Argument from Evidence to Hypothesis',
    nameKo: '증거→가설 논증',
    category: 'reasoning',
    premises: [
      'If H is true, evidence E would be observed.',
      'E is observed.',
    ],
    conclusion: 'Therefore, H is (probably) true.',
    criticalQuestions: [
      'Are there alternative hypotheses that predict E equally well?',
      'Is E actually observed reliably?',
      'Does H predict anything that is NOT observed?',
    ],
    educationalFit: 'high',
    pageRef: 'pp.330-331',
  },

  // ===== Source-Based =====
  {
    id: 'arg_from_position_to_know',
    nameEn: 'Argument from Position to Know',
    nameKo: '지식 위치 논증',
    category: 'source_based',
    premises: [
      'Person a is in a position to know about domain D.',
      'a asserts that P (in D) is true.',
    ],
    conclusion: 'Therefore, P is true.',
    criticalQuestions: [
      'Is a really in a position to know about D?',
      'Is a honest/reliable?',
      'Did a actually assert P?',
    ],
    educationalFit: 'high',
    pageRef: 'pp.13-14',
  },
  {
    id: 'arg_from_expert_opinion',
    nameEn: 'Argument from Expert Opinion',
    nameKo: '전문가 의견 논증',
    category: 'source_based',
    premises: [
      'E is an expert in field F.',
      'E asserts P (within F).',
    ],
    conclusion: 'Therefore, P is true.',
    criticalQuestions: [
      'Expertise: how credible is E?',
      'Field: is E an expert in the field A is in?',
      'Opinion: what did E actually assert? Verifiable?',
      'Trustworthiness: is E personally reliable (bias, honesty)?',
      'Consistency: is A consistent with what other experts assert?',
      'Backup: is E\'s assertion based on evidence?',
    ],
    educationalFit: 'high',
    pageRef: 'pp.85-94',
  },
  {
    id: 'arg_from_witness_testimony',
    nameEn: 'Argument from Witness Testimony',
    nameKo: '증인 증언 논증',
    category: 'source_based',
    premises: [
      'Witness W testifies that P.',
      'W was in a position to observe P.',
    ],
    conclusion: 'Therefore, P is true.',
    criticalQuestions: [
      'Was W in a position to observe?',
      'Is W reliable?',
      'Is W biased?',
      'Are there conflicting testimonies?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.350',
  },
  {
    id: 'arg_from_ignorance',
    nameEn: 'Argument from Ignorance',
    nameKo: '무지 논증',
    category: 'source_based',
    premises: [
      'P has not been proven true.',
    ],
    conclusion: 'Therefore, P is false. (또는 역: has not been proven false ∴ true)',
    criticalQuestions: [
      'Has a reasonable search been made?',
      'Does absence of evidence imply evidence of absence in this domain?',
      'Is this a closed-world assumption case?',
    ],
    educationalFit: 'high',
    pageRef: 'p.350',
  },
  {
    id: 'arg_from_inconsistent_commitment',
    nameEn: 'Argument from Inconsistent Commitment',
    nameKo: '상충된 개입 논증',
    category: 'source_based',
    premises: [
      'a is committed to P₁.',
      'P₁ is inconsistent with P₂ which a also asserts.',
    ],
    conclusion: 'Therefore, a\'s position is undermined.',
    criticalQuestions: [
      'Is there a real inconsistency?',
      'Can a resolve it without abandoning core position?',
      'Is this an ad hominem trap?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.350',
  },
  {
    id: 'arg_from_allegation_of_bias',
    nameEn: 'Argument from Allegation of Bias',
    nameKo: '편향 지적 논증',
    category: 'source_based',
    premises: [
      'Source a has bias B in domain D.',
    ],
    conclusion: 'Therefore, a\'s assertions in D are less credible.',
    criticalQuestions: [
      'Is the bias real?',
      'Does bias actually affect this particular claim?',
      'Is this an ad hominem fallacy?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.350',
  },
  {
    id: 'arg_from_popular_opinion',
    nameEn: 'Argument from Popular Opinion',
    nameKo: '대중 의견 논증',
    category: 'source_based',
    premises: [
      'Most people believe P.',
    ],
    conclusion: 'Therefore, P is true.',
    criticalQuestions: [
      'Is the "most people" claim accurate?',
      'Are they informed?',
      'Is this a bandwagon fallacy?',
    ],
    educationalFit: 'high',
    pageRef: 'p.350',
  },
  {
    id: 'arg_from_popular_practice',
    nameEn: 'Argument from Popular Practice',
    nameKo: '대중 관행 논증',
    category: 'source_based',
    premises: [
      'Most people do X.',
    ],
    conclusion: 'Therefore, X is correct/acceptable.',
    criticalQuestions: [
      'Is popular practice evidence of correctness?',
      'Are there moral/practical reasons to deviate?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.350',
  },

  // ===== Rules to Cases =====
  {
    id: 'arg_from_example',
    nameEn: 'Argument from Example',
    nameKo: '예시 논증',
    category: 'rules_to_cases',
    premises: [
      'In case C, property P holds.',
      'C is typical of domain D.',
    ],
    conclusion: 'Therefore, P holds generally in D.',
    criticalQuestions: [
      'Is C truly representative?',
      'Are there counter-examples?',
      'Is the sample too small?',
    ],
    educationalFit: 'high',
    pageRef: 'p.350',
  },
  {
    id: 'arg_from_analogy',
    nameEn: 'Argument from Analogy',
    nameKo: '유추 논증',
    category: 'rules_to_cases',
    premises: [
      'Case C₁ is similar to case C₂.',
      'Property A is true in C₁.',
    ],
    conclusion: 'Therefore, A is true in C₂.',
    criticalQuestions: [
      'Is A true in C₁?',
      'Are C₁ and C₂ similar in the respects cited?',
      'Are there important differences (dissimilarities) between C₁ and C₂?',
      'Is there some other case C₃ similar to C₁ except that A is false in C₃?',
    ],
    educationalFit: 'high',
    pageRef: 'pp.56-63',
  },
  {
    id: 'arg_from_precedent',
    nameEn: 'Argument from Precedent',
    nameKo: '선례 논증',
    category: 'rules_to_cases',
    premises: [
      'In previous case C_prev, decision D was made.',
      'Current case C_now is similar.',
    ],
    conclusion: 'Therefore, D should be made in C_now.',
    criticalQuestions: [
      'Is C_prev truly similar?',
      'Was D_prev the correct decision?',
      'Are conditions different now?',
    ],
    educationalFit: 'high',
    pageRef: 'p.350',
  },

  // ===== Defeasible Rules =====
  {
    id: 'arg_from_established_rule',
    nameEn: 'Argument from an Established Rule',
    nameKo: '기존 규칙 논증',
    category: 'rules_to_cases',
    premises: [
      'If the case is of type T, then action A should be carried out.',
      'The current case is of type T.',
    ],
    conclusion: 'Therefore, A should be carried out.',
    criticalQuestions: [
      'Does the case really fit type T?',
      'Is this an exceptional case?',
      'Is the rule justified in this context?',
    ],
    educationalFit: 'high',
    pageRef: 'pp.73-74',
  },
  {
    id: 'arg_from_exceptional_case',
    nameEn: 'Argument from an Exceptional Case',
    nameKo: '예외 사례 논증',
    category: 'rules_to_cases',
    premises: [
      'General rule R applies to cases of type T.',
      'Current case has special property E that removes it from T.',
    ],
    conclusion: 'Therefore, R does not apply.',
    criticalQuestions: [
      'Is E a legitimate exception?',
      'Does E appear ad hoc?',
      'Is the exception too broad (rule hollowing)?',
    ],
    educationalFit: 'medium',
    pageRef: 'pp.74-75',
  },
  {
    id: 'arg_from_plea_for_excuse',
    nameEn: 'Argument from Plea for Excuse',
    nameKo: '변명 논증',
    category: 'rules_to_cases',
    premises: [
      'a violated rule R.',
      'a had mitigating condition M.',
    ],
    conclusion: 'Therefore, a is excused.',
    criticalQuestions: [
      'Is M genuine?',
      'Does M actually justify violation?',
      'Is this excuse-abuse?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.350',
  },

  // ===== Verbal Classification =====
  {
    id: 'arg_from_verbal_classification',
    nameEn: 'Argument from Verbal Classification',
    nameKo: '언어적 분류 논증',
    category: 'verbal_classif',
    premises: [
      'x has property P.',
      'Anything with P falls under classification C.',
    ],
    conclusion: 'Therefore, x is C.',
    criticalQuestions: [
      'Is the classification definition clear?',
      'Does x truly have P?',
      'Are there borderline cases?',
    ],
    educationalFit: 'medium',
    pageRef: 'pp.316-328',
  },
  {
    id: 'arg_from_vagueness',
    nameEn: 'Argument from Vagueness of a Verbal Classification',
    nameKo: '언어적 분류 모호성 논증',
    category: 'verbal_classif',
    premises: [
      'The classification C is too vague to apply.',
    ],
    conclusion: 'Therefore, the argument using C is unsound.',
    criticalQuestions: [
      'Is C really vague in this context?',
      'Can C be refined?',
    ],
    educationalFit: 'medium',
    pageRef: 'pp.327-328',
  },
  {
    id: 'arg_from_gradualism',
    nameEn: 'Argument from Gradualism',
    nameKo: '점진주의 논증',
    category: 'verbal_classif',
    premises: [
      'Small step from A to B is acceptable.',
      'Many small steps lead to C.',
    ],
    conclusion: 'Therefore, C is acceptable.',
    criticalQuestions: [
      'Is the incremental step really as small as claimed?',
      'Do the steps cumulate?',
      'Is there a clear stopping rule?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.350',
  },

  // ===== 추가 교육 맥락 고빈도 =====
  {
    id: 'arg_from_opposites',
    nameEn: 'Argument from Opposites',
    nameKo: '대립 논증',
    category: 'reasoning',
    premises: [
      'A and B are opposites.',
      'P is true of A.',
    ],
    conclusion: 'Therefore, ¬P is true of B.',
    criticalQuestions: [
      'Are A and B truly opposites?',
      'Is this a false dichotomy?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.246',
  },
  {
    id: 'sorites_slippery_slope',
    nameEn: 'Sorites Slippery Slope',
    nameKo: '소리테스 경사',
    category: 'reasoning',
    premises: [
      'Removing one unit does not change the classification.',
    ],
    conclusion: 'Therefore, classification can never change regardless of removals.',
    criticalQuestions: [
      'Does repeated small change cumulate?',
      'Is the boundary truly continuous?',
    ],
    educationalFit: 'low',
    pageRef: 'p.263',
  },

  // ===== Appendix B 추가 스키마 (Walton 2008, Chapter 9 pp.308-346) =====
  // 원전: Walton, D., Reed, C., & Macagno, F. (2008). Argumentation Schemes. Cambridge University Press.
  // 범위: Chapter 9 "A User's Compendium of Schemes" - 총 60개 스키마 중 추가 30개

  {
    id: 'arg_from_witness_testimony',
    nameEn: 'Argument from Witness Testimony',
    nameKo: '증인 증언 논증',
    category: 'source_based',
    premises: [
      'Witness W states that P.',
      'W was in a position to observe/know P.',
      'W has no reason to lie.',
    ],
    conclusion: 'Therefore, P is true.',
    criticalQuestions: [
      'Was W in a position to observe?',
      'Is W reliable and trustworthy?',
      'Is W biased or has a motive?',
      'Are there conflicting testimonies?',
    ],
    educationalFit: 'high',
    pageRef: 'p.310',
  },
  {
    id: 'arg_from_illustration',
    nameEn: 'Argument from Illustration',
    nameKo: '예시 설명 논증',
    category: 'rules_to_cases',
    premises: [
      'Usually, if x has property F, then x has property G.',
      'In this case, k has property F and property G.',
    ],
    conclusion: 'Therefore, the rule is valid.',
    criticalQuestions: [
      'Is the example truly representative?',
      'Are there counter-examples?',
      'Is the rule properly formulated?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.314',
  },
  {
    id: 'arg_from_model',
    nameEn: 'Argument from Model',
    nameKo: '모델 논증',
    category: 'rules_to_cases',
    premises: [
      'Individual P is prestigious or admired by individuals Q.',
      'P carries out acts A.',
      'If P carries out A, then A are worth imitating.',
    ],
    conclusion: 'Therefore, Q should do A.',
    criticalQuestions: [
      'Is P truly prestigious/admired?',
      'Are the acts A worth imitating?',
      'Does prestige in one domain justify imitation in another?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.314',
  },
  {
    id: 'arg_from_anti_model',
    nameEn: 'Argument from Anti-Model',
    nameKo: '반면 모델 논증',
    category: 'rules_to_cases',
    premises: [
      'Individual P is not prestigious or not admired by Q.',
      'P carries out acts A.',
      'Q want to be different from P.',
    ],
    conclusion: 'Therefore, Q should not do A.',
    criticalQuestions: [
      'Is P truly not admired?',
      'Do Q want to differ from P in this specific way?',
      'Is the contrast justified?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.314',
  },
  {
    id: 'practical_reasoning_analogy_negative',
    nameEn: 'Practical Reasoning from Analogy (Negative Schema)',
    nameKo: '유추에서의 실제적 추론 (부정형)',
    category: 'reasoning',
    premises: [
      'The wrong thing to do in situation S₁ was to carry out action x.',
      'S₂ is similar to S₁.',
    ],
    conclusion: 'Therefore, the wrong thing to do in S₂ is to carry out x.',
    criticalQuestions: [
      'Was it truly wrong in S₁?',
      'Are S₁ and S₂ similar in relevant respects?',
      'Are there important differences?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.316',
  },
  {
    id: 'arg_from_composition_inclusion',
    nameEn: 'Argument from Composition (Inclusion of Part in Whole)',
    nameKo: '합성 논증 (부분→전체)',
    category: 'reasoning',
    premises: [
      'y is a species (part) of X.',
      'X is A.',
    ],
    conclusion: 'Therefore, y is A (or less A than X).',
    criticalQuestions: [
      'Is y truly part of X?',
      'Does the property A compose hereditably?',
      'Is there a size/scope issue?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.316',
  },
  {
    id: 'arg_from_division_whole_parts',
    nameEn: 'Argument from Division (Whole into Parts)',
    nameKo: '분할 논증 (전체→부분)',
    category: 'reasoning',
    premises: [
      'X is the whole composed of parts x₁, x₂, ..., xₙ.',
      'Only if at least one xᵢ is A, then X is A.',
      'x₁ is A (or no part is A).',
    ],
    conclusion: 'Therefore, X is A (or X is not A).',
    criticalQuestions: [
      'Is the part-whole relationship clear?',
      'Does the property divide hereditably?',
      'Are the conditions correctly stated?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.317',
  },
  {
    id: 'rhetorical_arg_from_oppositions_normative',
    nameEn: 'Rhetorical Argument from Oppositions (Normative)',
    nameKo: '수사적 대립 논증 (규범형)',
    category: 'reasoning',
    premises: [
      'If treatment Y is required for subject X, then contrary treatment Y\' is required for contrary subject X\'.',
      'Treatment Y is required for subject X.',
    ],
    conclusion: 'Therefore, contrary treatment Y\' is required for subject X\'.',
    criticalQuestions: [
      'Is X\' truly contrary to X?',
      'Is Y\' truly the appropriate contrary treatment?',
      'Are the situations genuinely comparable?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.318',
  },
  {
    id: 'rhetorical_arg_from_oppositions_descriptive',
    nameEn: 'Rhetorical Argument from Oppositions (Descriptive)',
    nameKo: '수사적 대립 논증 (서술형)',
    category: 'reasoning',
    premises: [
      'If X is in relation R with Y, then Y can be in converse relation R\' with X.',
      'X is in relation R with Y.',
    ],
    conclusion: 'Therefore, Y can be in converse relation R\' with X.',
    criticalQuestions: [
      'Is R truly reversible to R\'?',
      'Is the converse relation logically possible?',
      'Are practical factors involved?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.318',
  },
  {
    id: 'arg_from_definition_to_classification',
    nameEn: 'Argument from Definition to Verbal Classification',
    nameKo: '정의→언어적 분류 논증',
    category: 'verbal_classif',
    premises: [
      'a fits definition D.',
      'For all x, if x fits definition D, then x can be classified as having property G.',
    ],
    conclusion: 'Therefore, a has property G.',
    criticalQuestions: [
      'Is D an adequate definition?',
      'Are there alternative definitions that would exclude a\'s having G?',
      'Is the classification based on a biased or stipulative definition?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.319',
  },
  {
    id: 'arg_from_arbitrariness_classification',
    nameEn: 'Argument from Arbitrariness of Verbal Classification',
    nameKo: '언어적 분류의 자의성 논증',
    category: 'verbal_classif',
    premises: [
      'The boundary between classifications C₁ and C₂ is arbitrary.',
    ],
    conclusion: 'Therefore, the classification system is unreliable or illegitimate.',
    criticalQuestions: [
      'Is the boundary truly arbitrary?',
      'Are some boundaries necessarily arbitrary?',
      'Does arbitrariness undermine the classification?',
    ],
    educationalFit: 'low',
    pageRef: 'p.320',
  },
  {
    id: 'arg_from_interaction_act_person',
    nameEn: 'Argument from Interaction of Act and Person',
    nameKo: '행동과 인물의 상호작용 논증',
    category: 'reasoning',
    premises: [
      'Person a carried out act A.',
      'Act A is indicative of character trait T.',
    ],
    conclusion: 'Therefore, person a has character trait T.',
    criticalQuestions: [
      'Is the act truly indicative?',
      'Could the act have other causes?',
      'Is one act sufficient evidence of character?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.321',
  },
  {
    id: 'arg_from_values',
    nameEn: 'Argument from Values',
    nameKo: '가치 논증',
    category: 'reasoning',
    premises: [
      'Value V is important or desirable.',
      'Action/Policy A promotes value V.',
    ],
    conclusion: 'Therefore, A should be done/adopted.',
    criticalQuestions: [
      'Is V truly important?',
      'Does A genuinely promote V?',
      'Are there conflicting values?',
      'What are the trade-offs?',
    ],
    educationalFit: 'high',
    pageRef: 'p.321',
  },
  {
    id: 'arg_from_sacrifice',
    nameEn: 'Argument from Sacrifice',
    nameKo: '희생 논증',
    category: 'reasoning',
    premises: [
      'Agent a made significant sacrifice S for goal G.',
      'Continuing with G honors the sacrifice.',
      'Stopping now would waste the sacrifice.',
    ],
    conclusion: 'Therefore, a should continue with G.',
    criticalQuestions: [
      'Was the sacrifice truly significant?',
      'Does continuing actually honor the sacrifice?',
      'Is this a sunk cost fallacy?',
      'Is the goal still worth pursuing?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.322',
  },
  {
    id: 'arg_from_group_members',
    nameEn: 'Argument from the Group and Its Members',
    nameKo: '집단과 그 구성원 논증',
    category: 'reasoning',
    premises: [
      'Property P is true of group G (or its members).',
    ],
    conclusion: 'Therefore, property P is true of individual members of G (or of G as a whole).',
    criticalQuestions: [
      'Does the property distribute?',
      'Is the group-to-member inference valid?',
      'Are there counterexamples?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.322',
  },
  {
    id: 'practical_reasoning_general',
    nameEn: 'Practical Reasoning',
    nameKo: '실제적 추론',
    category: 'reasoning',
    premises: [
      'I have goal G.',
      'Action A is a reasonable means to achieve G.',
      'Circumstances C are appropriate for doing A.',
    ],
    conclusion: 'Therefore, I should do A.',
    criticalQuestions: [
      'Is G a legitimate goal?',
      'Is A an effective means to G?',
      'Are circumstances C satisfied?',
      'Are there alternative means?',
      'Are there negative consequences?',
    ],
    educationalFit: 'high',
    pageRef: 'p.323',
  },
  {
    id: 'two_person_practical_reasoning',
    nameEn: 'Two-Person Practical Reasoning',
    nameKo: '이인 실제적 추론',
    category: 'reasoning',
    premises: [
      'Agent A has goal G.',
      'Agent B can help A achieve G.',
      'B is capable and willing.',
    ],
    conclusion: 'Therefore, B should help A.',
    criticalQuestions: [
      'Is G legitimate?',
      'Can B truly help?',
      'What is B\'s incentive?',
      'Are there social/moral obligations?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.325',
  },
  {
    id: 'arg_from_waste',
    nameEn: 'Argument from Waste',
    nameKo: '낭비 논증',
    category: 'reasoning',
    premises: [
      'If agent a stops trying to realize goal A now, all previous efforts to realize A will be wasted.',
      'Wasting previous efforts would be bad.',
    ],
    conclusion: 'Therefore, a ought to continue trying to realize A.',
    criticalQuestions: [
      'Is goal A still achievable?',
      'Is the expected future benefit worth the continued investment?',
      'Are the costs increasing?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.326',
  },
  {
    id: 'arg_from_sunk_costs_extended',
    nameEn: 'Argument from Sunk Costs (Extended)',
    nameKo: '매몰 비용 논증 (확대형)',
    category: 'reasoning',
    premises: [
      'Agent a made a pre-commitment to action A at time T₁.',
      'At time T₂, a is confronted with the decision to continue or stop A.',
      'Because of the pre-commitment, a should continue with A.',
    ],
    conclusion: 'Therefore, a should choose A at T₂.',
    criticalQuestions: [
      'Was the pre-commitment binding?',
      'Have circumstances changed?',
      'Should a reassess costs vs. benefits from T₂ onward?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.326',
  },
  {
    id: 'arg_from_ignorance_negative_expectations',
    nameEn: 'Argument from Ignorance (Negative Reasoning from Normal Expectations)',
    nameKo: '무지 논증 (정상적 기대로부터의 부정 추론)',
    category: 'source_based',
    premises: [
      'If the situation were normal, proposition A would be true.',
      'It is not the case that A is true.',
    ],
    conclusion: 'Therefore, the situation is not normal.',
    criticalQuestions: [
      'What counts as "normal"?',
      'Is the expectation reasonable?',
      'Could A be false for other reasons?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.327',
  },
  {
    id: 'epistemic_arg_from_ignorance',
    nameEn: 'Epistemic Argument from Ignorance',
    nameKo: '인식론적 무지 논증',
    category: 'source_based',
    premises: [
      'Proposition A is a type such that if A were true, A would normally be in knowledge base K.',
      'A is not in K.',
      'All true propositions of A\'s type are expected to be in K.',
    ],
    conclusion: 'Therefore, it is plausible to presume A is false (pending further investigation).',
    criticalQuestions: [
      'Is K comprehensive?',
      'Is the proposition type truly expected to be in K?',
      'Could A be omitted for other reasons?',
    ],
    educationalFit: 'low',
    pageRef: 'p.328',
  },
  {
    id: 'arg_from_effect_to_cause',
    nameEn: 'Argument from Effect to Cause',
    nameKo: '결과→원인 논증',
    category: 'reasoning',
    premises: [
      'Effect/event B is observed.',
      'A is the only plausible cause of B.',
    ],
    conclusion: 'Therefore, A caused B.',
    criticalQuestions: [
      'Is B really an effect (not coincidence)?',
      'Are there alternative causes?',
      'Is A sufficient to produce B?',
    ],
    educationalFit: 'high',
    pageRef: 'p.169',
  },
  {
    id: 'abductive_argumentation',
    nameEn: 'Abductive Argumentation Scheme',
    nameKo: '귀추 논증 스키마',
    category: 'reasoning',
    premises: [
      'If hypothesis H is true, evidence E would be observed.',
      'Evidence E is observed.',
      'There is no better explanation.',
    ],
    conclusion: 'Therefore, H is probably true.',
    criticalQuestions: [
      'Is H the best explanation for E?',
      'Are there competing hypotheses?',
      'Is the abduction to the best explanation justified?',
    ],
    educationalFit: 'high',
    pageRef: 'p.329',
  },
  {
    id: 'arg_from_perception',
    nameEn: 'Argument from Perception',
    nameKo: '지각 논증',
    category: 'source_based',
    premises: [
      'I perceive that P.',
      'My perception is not distorted or mistaken.',
    ],
    conclusion: 'Therefore, P is true.',
    criticalQuestions: [
      'Is my perception reliable?',
      'Could there be perceptual illusion?',
      'Are the conditions optimal for perception?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.345',
  },
  {
    id: 'arg_from_memory',
    nameEn: 'Argument from Memory',
    nameKo: '기억 논증',
    category: 'source_based',
    premises: [
      'I remember that P happened.',
      'My memory is reliable.',
    ],
    conclusion: 'Therefore, P happened.',
    criticalQuestions: [
      'Is my memory accurate?',
      'Could the memory be distorted or confused?',
      'Is there corroborating evidence?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.346',
  },
  {
    id: 'arg_from_constitutive_rule',
    nameEn: 'Argument from Constitution-Rule Claims',
    nameKo: '구성 규칙 주장 논증',
    category: 'rules_to_cases',
    premises: [
      'Rule R defines the constitution or structure of practice/institution I.',
      'Action/situation X falls under condition C of rule R.',
    ],
    conclusion: 'Therefore, X is a valid/legitimate instance of I.',
    criticalQuestions: [
      'Is R the correct constitutive rule?',
      'Does X truly fall under condition C?',
      'Are there exceptions?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.342',
  },
  {
    id: 'arg_from_rules',
    nameEn: 'Argument from Rules',
    nameKo: '규칙 논증',
    category: 'rules_to_cases',
    premises: [
      'General rule R applies to cases of type T.',
      'Current case is of type T.',
    ],
    conclusion: 'Therefore, R applies to the current case.',
    criticalQuestions: [
      'Is R correctly formulated?',
      'Does the case truly fit type T?',
      'Are there legitimate exceptions?',
    ],
    educationalFit: 'high',
    pageRef: 'p.343',
  },
  {
    id: 'ethotic_argument',
    nameEn: 'Ethotic Argument',
    nameKo: '품성 논증',
    category: 'source_based',
    premises: [
      'Agent a has character trait T.',
      'Agents with trait T are reliable/trustworthy.',
    ],
    conclusion: 'Therefore, a\'s assertion/testimony is credible.',
    criticalQuestions: [
      'Does a truly have trait T?',
      'Does T make one reliable?',
      'Is T relevant to this specific claim?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.336',
  },
  {
    id: 'generic_ad_hominem',
    nameEn: 'Generic Ad Hominem',
    nameKo: '일반적 인신공격',
    category: 'source_based',
    premises: [
      'Person a makes assertion P.',
      'Person a has defect/is not credible.',
    ],
    conclusion: 'Therefore, P is false (or less credible).',
    criticalQuestions: [
      'Does a\'s defect genuinely undermine the claim?',
      'Is this an abusive fallacy?',
      'Is the character attack relevant?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.336',
  },
  {
    id: 'pragmatic_inconsistency',
    nameEn: 'Pragmatic Inconsistency',
    nameKo: '실용적 모순',
    category: 'reasoning',
    premises: [
      'Person a asserts P.',
      'Person a\'s actions/behavior contradict P.',
    ],
    conclusion: 'Therefore, a\'s assertion is undermined.',
    criticalQuestions: [
      'Is there genuine inconsistency?',
      'Could a have changed view?',
      'Are the action and assertion in different contexts?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.336',
  },
  {
    id: 'bias_ad_hominem',
    nameEn: 'Bias Ad Hominem',
    nameKo: '편향 인신공격',
    category: 'source_based',
    premises: [
      'Person a asserts P.',
      'a has a bias toward P.',
    ],
    conclusion: 'Therefore, a\'s assertion is less credible.',
    criticalQuestions: [
      'Is the bias real?',
      'Does bias actually affect this particular claim?',
      'Is this a fallacious ad hominem?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.338',
  },
  {
    id: 'slippery_slope_general',
    nameEn: 'Slippery Slope Argument (General)',
    nameKo: '미끄러운 경사 논증 (일반형)',
    category: 'reasoning',
    premises: [
      'Action A₀ leads to A₁, ..., Aₙ (bad outcome).',
      'There is no principled stopping point between Aᵢ and Aᵢ₊₁.',
    ],
    conclusion: 'Therefore, A₀ should not be done.',
    criticalQuestions: [
      'Is each step probable?',
      'Is there a reasonable stopping point?',
      'What is the cumulative probability?',
    ],
    educationalFit: 'high',
    pageRef: 'p.339',
  },
  {
    id: 'full_slippery_slope',
    nameEn: 'Full Slippery Slope Argument',
    nameKo: '완전 미끄러운 경사 논증',
    category: 'reasoning',
    premises: [
      'Action A₀ necessarily leads to sequence A₁, ..., Aₙ.',
      'Aₙ is extremely bad.',
    ],
    conclusion: 'Therefore, A₀ must not be done.',
    criticalQuestions: [
      'Is the causal chain truly necessary?',
      'Are all steps inevitable?',
      'Can the chain be broken?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.341',
  },
  {
    id: 'verbal_slippery_slope',
    nameEn: 'Verbal Slippery Slope Argument',
    nameKo: '언어적 미끄러운 경사 논증',
    category: 'verbal_classif',
    premises: [
      'Word/concept C₀ gradually shifts meaning to C₁, ..., Cₙ.',
      'Cₙ is unacceptable.',
    ],
    conclusion: 'Therefore, accepting C₀ leads to accepting unacceptable Cₙ.',
    criticalQuestions: [
      'Is the semantic shift real?',
      'Can meaning drift be prevented?',
      'Is the final meaning truly unacceptable?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.341',
  },
  {
    id: 'pragmatic_alternative_argument',
    nameEn: 'Pragmatic Argument from Alternatives',
    nameKo: '실용적 대안 논증',
    category: 'reasoning',
    premises: [
      'Either action A or action B can be carried out.',
      'Action B is incompatible with important goal G.',
    ],
    conclusion: 'Therefore, A should be chosen.',
    criticalQuestions: [
      'Are A and B truly exhaustive?',
      'Is B genuinely incompatible with G?',
      'Are there other alternatives?',
    ],
    educationalFit: 'high',
    pageRef: 'p.333',
  },
  {
    id: 'arg_from_fear_appeal',
    nameEn: 'Argument from Fear Appeal',
    nameKo: '공포 호소 논증',
    category: 'reasoning',
    premises: [
      'If action A is not taken, danger D will result.',
      'D is fearful/dangerous.',
      'Taking A prevents D.',
    ],
    conclusion: 'Therefore, A should be done.',
    criticalQuestions: [
      'Is danger D real?',
      'Is the threat imminent?',
      'Does A actually prevent D?',
      'Is fear being manipulated?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.333',
  },
  {
    id: 'arg_from_danger_appeal',
    nameEn: 'Argument from Danger Appeal',
    nameKo: '위험 호소 논증',
    category: 'reasoning',
    premises: [
      'Action A carries inherent danger D.',
      'D is unacceptable.',
    ],
    conclusion: 'Therefore, A should not be done.',
    criticalQuestions: [
      'Is the danger real?',
      'Is the danger level unacceptable?',
      'Are there mitigating measures?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.334',
  },
  {
    id: 'arg_from_need_help',
    nameEn: 'Argument from Need for Help',
    nameKo: '도움의 필요 논증',
    category: 'reasoning',
    premises: [
      'Agent a is in need of help H.',
      'Agent b is able to provide H.',
    ],
    conclusion: 'Therefore, b should provide H to a.',
    criticalQuestions: [
      'Is the need genuine?',
      'Is b truly able to help?',
      'What is b\'s obligation?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.334',
  },
  {
    id: 'arg_from_distress',
    nameEn: 'Argument from Distress',
    nameKo: '고통 논증',
    category: 'reasoning',
    premises: [
      'Entity X is in severe distress.',
      'Action A would alleviate the distress.',
    ],
    conclusion: 'Therefore, A should be done.',
    criticalQuestions: [
      'Is the distress real?',
      'Would A truly alleviate it?',
      'Does one have duty to help?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.334',
  },
  {
    id: 'circumstantial_ad_hominem',
    nameEn: 'Circumstantial Ad Hominem',
    nameKo: '상황적 인신공격',
    category: 'source_based',
    premises: [
      'Agent a asserts P.',
      'a is in circumstance C that benefits from P being true.',
    ],
    conclusion: 'Therefore, a\'s assertion is suspect (less credible).',
    criticalQuestions: [
      'Is the circumstantial link real?',
      'Does C genuinely bias a?',
      'Is this a legitimate form of argument?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.337',
  },
  {
    id: 'arg_from_precedent',
    nameEn: 'Argument from Precedent',
    nameKo: '선례 논증',
    category: 'rules_to_cases',
    premises: [
      'In previous case C_prev, decision D was made.',
      'Current case C_now is similar to C_prev.',
    ],
    conclusion: 'Therefore, decision D should be made in C_now.',
    criticalQuestions: [
      'Is C_prev truly similar to C_now?',
      'Was decision D correct in C_prev?',
      'Have circumstances changed?',
      'Is there a distinguishing factor?',
    ],
    educationalFit: 'high',
    pageRef: 'p.344',
  },
  {
    id: 'arg_from_exceptional_case',
    nameEn: 'Argument for an Exceptional Case',
    nameKo: '예외 사례 논증',
    category: 'rules_to_cases',
    premises: [
      'General rule R applies to cases of type T.',
      'Current case has special property E that removes it from T.',
    ],
    conclusion: 'Therefore, R does not apply to this case.',
    criticalQuestions: [
      'Is E a legitimate exception?',
      'Does E appear ad hoc?',
      'Is the exception too broad (rule hollowing)?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.344',
  },
  {
    id: 'arg_from_plea_excuse',
    nameEn: 'Argument from Plea for Excuse',
    nameKo: '변명 논증',
    category: 'rules_to_cases',
    premises: [
      'Agent a violated rule R.',
      'Agent a had mitigating condition M.',
    ],
    conclusion: 'Therefore, a is excused.',
    criticalQuestions: [
      'Is M genuine?',
      'Does M actually justify violation?',
      'Is this excuse-abuse?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.345',
  },
  {
    id: 'arg_from_effect_to_cause',
    nameEn: 'Argument from Effect to Cause',
    nameKo: '결과→원인 논증',
    category: 'reasoning',
    premises: [
      'Effect/event B is observed.',
      'A is the only plausible cause of B.',
    ],
    conclusion: 'Therefore, A caused B.',
    criticalQuestions: [
      'Is B really an effect (not coincidence)?',
      'Are there alternative causes?',
      'Is A sufficient to produce B?',
    ],
    educationalFit: 'high',
    pageRef: 'p.169',
  },
  {
    id: 'abductive_scheme',
    nameEn: 'Abductive Argumentation Scheme',
    nameKo: '귀추 논증 스키마',
    category: 'reasoning',
    premises: [
      'If hypothesis H is true, evidence E would be observed.',
      'Evidence E is observed.',
      'There is no better explanation.',
    ],
    conclusion: 'Therefore, H is probably true.',
    criticalQuestions: [
      'Is H the best explanation for E?',
      'Are there competing hypotheses?',
      'Is the abduction to the best explanation justified?',
    ],
    educationalFit: 'high',
    pageRef: 'p.329',
  },
  {
    id: 'arg_from_perception',
    nameEn: 'Argument from Perception',
    nameKo: '지각 논증',
    category: 'source_based',
    premises: [
      'I perceive that P.',
      'My perception is not distorted or mistaken.',
    ],
    conclusion: 'Therefore, P is true.',
    criticalQuestions: [
      'Is my perception reliable?',
      'Could there be perceptual illusion?',
      'Are the conditions optimal for perception?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.345',
  },
  {
    id: 'arg_from_memory',
    nameEn: 'Argument from Memory',
    nameKo: '기억 논증',
    category: 'source_based',
    premises: [
      'I remember that P happened.',
      'My memory is reliable.',
    ],
    conclusion: 'Therefore, P happened.',
    criticalQuestions: [
      'Is my memory accurate?',
      'Could the memory be distorted or confused?',
      'Is there corroborating evidence?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.346',
  },
  {
    id: 'slippery_slope_precedent',
    nameEn: 'Precedent Slippery Slope Argument',
    nameKo: '선례 미끄러운 경사 논증',
    category: 'reasoning',
    premises: [
      'Precedent P₀ leads to precedent P₁, ..., Pₙ (bad).',
      'There is no principled stopping point.',
    ],
    conclusion: 'Therefore, P₀ should not be accepted.',
    criticalQuestions: [
      'Is each step inevitable?',
      'Is there a reasonable stopping point?',
      'Is the final outcome really bad?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.340',
  },
  {
    id: 'sorites_slippery_slope_scheme',
    nameEn: 'Sorites Slippery Slope Argument',
    nameKo: '소리테스 미끄러운 경사 논증',
    category: 'reasoning',
    premises: [
      'Removing one unit from collection C does not change the classification.',
      'This holds for each successive removal.',
    ],
    conclusion: 'Therefore, classification can never change regardless of removals.',
    criticalQuestions: [
      'Does repeated small change cumulate?',
      'Is the boundary truly continuous?',
      'Is there a threshold effect?',
    ],
    educationalFit: 'low',
    pageRef: 'p.340',
  },
  {
    id: 'verbal_slippery_slope_scheme',
    nameEn: 'Verbal Slippery Slope Argument',
    nameKo: '언어적 미끄러운 경사 논증',
    category: 'verbal_classif',
    premises: [
      'Word/concept C₀ gradually shifts meaning to C₁, ..., Cₙ.',
      'Cₙ is unacceptable.',
    ],
    conclusion: 'Therefore, accepting C₀ leads to accepting unacceptable Cₙ.',
    criticalQuestions: [
      'Is the semantic shift real?',
      'Can meaning drift be prevented?',
      'Is the final meaning truly unacceptable?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.341',
  },
  {
    id: 'full_slippery_slope_scheme',
    nameEn: 'Full Slippery Slope Argument',
    nameKo: '완전 미끄러운 경사 논증',
    category: 'reasoning',
    premises: [
      'Action A₀ necessarily leads to sequence A₁, ..., Aₙ.',
      'Aₙ is extremely bad.',
    ],
    conclusion: 'Therefore, A₀ must not be done.',
    criticalQuestions: [
      'Is the causal chain truly necessary?',
      'Are all steps inevitable?',
      'Can the chain be broken?',
    ],
    educationalFit: 'medium',
    pageRef: 'p.341',
  },
];

/**
 * 주어진 학생 논증 텍스트에서 가장 가까운 스키마 id를 추정하기 위한 키워드 힌트.
 * 실제 분류는 LLM으로 수행 (ai-client.ts 경유). 이 맵은 폴백 규칙용.
 */
export const SCHEME_KEYWORD_HINTS: Record<string, string[]> = {
  arg_from_analogy: ['처럼', 'like', '유사', 'analog', '마찬가지'],
  arg_from_cause_to_effect: ['때문에', '원인', 'cause', '결과', 'effect'],
  arg_from_correlation_to_cause: ['상관', 'correlation', '같이 움직'],
  arg_from_expert_opinion: ['교수', '박사', 'expert', '권위', '전문가'],
  arg_from_popular_opinion: ['다들', '대부분', 'everyone', '많은 사람'],
  arg_from_consequences_positive: ['좋을', 'benefit', '이득'],
  arg_from_consequences_negative: ['나쁠', '위험', 'risk', '손해'],
  arg_from_sunk_costs: ['이미 투자', '지금까지', 'so far'],
  arg_from_ignorance: ['증명되지 않', 'no evidence', '반증 없'],
};

export function schemesByCategory(cat: SchemeCategory): WaltonScheme[] {
  return WALTON_SCHEMES.filter(s => s.category === cat);
}

export function highFitSchemes(): WaltonScheme[] {
  return WALTON_SCHEMES.filter(s => s.educationalFit === 'high');
}
