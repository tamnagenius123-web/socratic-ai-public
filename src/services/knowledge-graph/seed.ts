// SocraticAI v35 — Neural Wiki Domain Seed Helper (T1.2.4)
// 5개 도메인 × 50+ 노드 시드 데이터를 프로그래매틱으로 삽입하는 유틸.
// 프로덕션 배포는 migrations/0035_neural_wiki_domain_seed.sql 로 수행되며,
// 이 모듈은 테스트·로컬 재시드·관리자 툴링 용도로 사용된다.
//
// 원칙:
//   - IDEMPOTENT: INSERT OR IGNORE 사용. 여러 번 호출해도 안전.
//   - SQL 과 동일한 데이터를 유지. 양쪽을 수정할 때는 반드시 동기화.
//   - no `any`: D1Database 는 @cloudflare/workers-types 의 전역 타입.

export interface SeedNode {
  id: string;
  domainId: string;
  concept: string;
  category: string;
  bloomLevel: number;
  description: string;
  metadata: Record<string, unknown>;
  coreEssence: string;
  buildingBlocks: { blocks: string[] };
  metaphoricalBridges: { bridges: string[] };
}

export interface SeedEdge {
  id: string;
  domainId: string;
  fromId: string;
  toId: string;
  relationType: 'prerequisite' | 'includes' | 'contradicts' | 'supports' | 'exemplifies';
  strength: number;
  metadata: Record<string, unknown>;
}

export interface SeedResult {
  insertedNodes: number;
  insertedEdges: number;
}

// ---------------------------------------------------------------------------
// Node seed definitions (50 nodes across 5 domains)
// ---------------------------------------------------------------------------

export const SEED_NODES: readonly SeedNode[] = [
  // ---- Domain 1: meditations_4 (additions only; 기존 8노드는 0015+0030 에서 삽입됨) ----
  {
    id: 'amor_fati',
    domainId: 'meditations_4',
    concept: '운명애(Amor Fati)',
    category: '윤리학',
    bloomLevel: 4,
    description: '일어나는 모든 일을 긍정적으로 수용하는 스토아의 태도',
    metadata: { keyPassages: ['4권 23절'] },
    coreEssence: '우주의 흐름에 저항하지 않고 일치시키는 내적 수용의 자세.',
    buildingBlocks: { blocks: ['현실 수용', '의지의 일치', '감사의 관점'] },
    metaphoricalBridges: { bridges: ['우주적 관점의 실천 형태', '무상함의 긍정적 승화'] },
  },
  {
    id: 'logos_universal',
    domainId: 'meditations_4',
    concept: '보편 로고스(Logos)',
    category: '형이상학',
    bloomLevel: 5,
    description: '모든 존재를 관통하는 우주적 이성',
    metadata: { keyPassages: ['4권 4절', '4권 40절'] },
    coreEssence: '개별 이성의 근원이자 자연 법칙을 가능케 하는 우주적 원리.',
    buildingBlocks: { blocks: ['우주의 합리성', '개별 이성의 뿌리', '자연 법칙의 일체성'] },
    metaphoricalBridges: { bridges: ['이성적 본성의 원천', '의무 윤리의 존재론적 근거'] },
  },

  // ---- Domain 2: logic_reasoning (10) ----
  {
    id: 'logic_syllogism',
    domainId: 'logic_reasoning',
    concept: '삼단논법(Syllogism)',
    category: '형식논리',
    bloomLevel: 3,
    description: '두 전제로부터 결론을 도출하는 아리스토텔레스 추론 틀',
    metadata: { origin: 'Aristotle Prior Analytics' },
    coreEssence: '대전제와 소전제로부터 타당한 결론을 연역하는 최소 추론 단위.',
    buildingBlocks: { blocks: ['대전제', '소전제', '매개념', '결론'] },
    metaphoricalBridges: { bridges: ['수사학 logos의 기초 기계', '판단 훈련의 형식화'] },
  },
  {
    id: 'logic_validity_soundness',
    domainId: 'logic_reasoning',
    concept: '타당성과 건전성',
    category: '형식논리',
    bloomLevel: 4,
    description: '형식의 올바름(타당)과 전제의 참(건전)을 구분',
    metadata: {},
    coreEssence: '논증의 형식적 적합성과 내용적 진리성을 분리 평가하는 메타 능력.',
    buildingBlocks: { blocks: ['형식 평가', '전제 검증', '반례 탐색'] },
    metaphoricalBridges: { bridges: ['통계적 가설검정과 유사 구조', '판단 훈련의 정밀화'] },
  },
  {
    id: 'logic_fallacy_adhominem',
    domainId: 'logic_reasoning',
    concept: '인신공격의 오류',
    category: '비형식적 오류',
    bloomLevel: 2,
    description: '주장이 아닌 사람을 공격하는 비형식적 오류',
    metadata: {},
    coreEssence: '논증의 내용 대신 발화자의 특성을 표적으로 삼는 관련성 오류.',
    buildingBlocks: { blocks: ['주장/발화자 혼동', '감정 유발', '관련성 상실'] },
    metaphoricalBridges: { bridges: ['수사학 pathos 악용', '신뢰 파괴의 동역학'] },
  },
  {
    id: 'logic_fallacy_straw_man',
    domainId: 'logic_reasoning',
    concept: '허수아비 오류',
    category: '비형식적 오류',
    bloomLevel: 2,
    description: '상대 주장을 왜곡하여 공격하기 쉬운 형태로 만드는 오류',
    metadata: {},
    coreEssence: '반박 대상의 입장을 의도적으로 왜곡해 쉬운 표적으로 재구성.',
    buildingBlocks: { blocks: ['원 주장 왜곡', '약화된 대체 명제', '오도된 반박'] },
    metaphoricalBridges: { bridges: ['수사적 프레이밍의 남용', '반례 생성과 대비'] },
  },
  {
    id: 'logic_fallacy_slippery_slope',
    domainId: 'logic_reasoning',
    concept: '미끄러운 비탈길 오류',
    category: '비형식적 오류',
    bloomLevel: 3,
    description: '한 사건이 극단적 결과로 이어진다고 가정하는 오류',
    metadata: {},
    coreEssence: '작은 단계에서 파국적 결과로의 연쇄 필연성을 근거 없이 주장.',
    buildingBlocks: { blocks: ['인과 연쇄 가정', '확률 생략', '극단화'] },
    metaphoricalBridges: { bridges: ['통계적 추론 부재의 표식', '불확실성 무시'] },
  },
  {
    id: 'logic_fallacy_false_cause',
    domainId: 'logic_reasoning',
    concept: '거짓 인과(Post Hoc)',
    category: '비형식적 오류',
    bloomLevel: 3,
    description: '시간적 선후를 원인으로 혼동하는 오류',
    metadata: {},
    coreEssence: '"A 이후 B" 를 "A 때문에 B" 로 오판하는 상관-인과 혼동.',
    buildingBlocks: { blocks: ['선행 관찰', '인과 단정', '대안 원인 무시'] },
    metaphoricalBridges: { bridges: ['상관과 인과 구분의 통계적 사촌', '미시경제 혼동변수'] },
  },
  {
    id: 'logic_induction',
    domainId: 'logic_reasoning',
    concept: '귀납(Induction)',
    category: '추론 양식',
    bloomLevel: 3,
    description: '관찰 사례로부터 일반 명제를 추론',
    metadata: {},
    coreEssence: '개별 관찰의 규칙성에서 일반화된 명제를 가설로 제안.',
    buildingBlocks: { blocks: ['관찰 수집', '패턴 식별', '일반화'] },
    metaphoricalBridges: { bridges: ['기술통계의 철학적 기원', '베이즈 갱신의 직관'] },
  },
  {
    id: 'logic_deduction',
    domainId: 'logic_reasoning',
    concept: '연역(Deduction)',
    category: '추론 양식',
    bloomLevel: 3,
    description: '일반 원리로부터 특정 사례를 도출',
    metadata: {},
    coreEssence: '참인 전제로부터 필연적으로 참인 결론에 도달하는 추론.',
    buildingBlocks: { blocks: ['공리', '추론 규칙', '결론 도출'] },
    metaphoricalBridges: { bridges: ['삼단논법의 일반화', '수학적 증명의 뼈대'] },
  },
  {
    id: 'logic_abduction',
    domainId: 'logic_reasoning',
    concept: '가추(Abduction)',
    category: '추론 양식',
    bloomLevel: 4,
    description: '관찰된 현상을 가장 잘 설명하는 가설을 선택',
    metadata: { origin: 'C.S. Peirce' },
    coreEssence: '퍼스가 제시한 "최선의 설명으로의 추론" — 진단적 사고의 핵심.',
    buildingBlocks: { blocks: ['현상 관찰', '가설 생성', '설명력 비교'] },
    metaphoricalBridges: { bridges: ['베이즈 추론의 사전 단계', '반례 탐색과 대칭'] },
  },
  {
    id: 'logic_counterexample',
    domainId: 'logic_reasoning',
    concept: '반례(Counterexample)',
    category: '비판적 사고',
    bloomLevel: 4,
    description: '일반 명제를 반박하는 단 하나의 예시',
    metadata: {},
    coreEssence: '전칭 주장을 논박하는 최소 증거 — 태극 엔진 반례 생성의 논리적 토대.',
    buildingBlocks: { blocks: ['전칭 명제 식별', '경계 사례 탐색', '반박 구성'] },
    metaphoricalBridges: { bridges: ['태극 엔진의 직접 동력', '과학 이론 검증'] },
  },

  // ---- Domain 3: statistical_inference (10) ----
  {
    id: 'stat_descriptive',
    domainId: 'statistical_inference',
    concept: '기술통계',
    category: '데이터 요약',
    bloomLevel: 2,
    description: '데이터의 중심/산포/모양을 수치로 요약',
    metadata: {},
    coreEssence: '관찰 데이터를 평균·분산·분포 형태로 압축 표현하는 수단.',
    buildingBlocks: { blocks: ['중심 경향', '산포', '분포 모양'] },
    metaphoricalBridges: { bridges: ['귀납의 수량적 전환', '의사결정의 증거 기반'] },
  },
  {
    id: 'stat_distribution_normal',
    domainId: 'statistical_inference',
    concept: '정규분포',
    category: '확률분포',
    bloomLevel: 3,
    description: '평균과 분산으로 특징지어지는 종형 분포',
    metadata: {},
    coreEssence: '중심극한정리로 자주 등장하는 대칭 종형 확률 모형.',
    buildingBlocks: { blocks: ['평균', '표준편차', '대칭 꼬리'] },
    metaphoricalBridges: { bridges: ['가설검정의 기준 분포', '수요 변동의 근사'] },
  },
  {
    id: 'stat_clt',
    domainId: 'statistical_inference',
    concept: '중심극한정리',
    category: '확률론 정리',
    bloomLevel: 5,
    description: '표본평균의 분포가 정규분포로 수렴',
    metadata: {},
    coreEssence: '표본 크기가 커질수록 표본평균이 정규분포로 근사된다는 대정리.',
    buildingBlocks: { blocks: ['독립 동일 분포', '표본 크기 성장', '정규 근사'] },
    metaphoricalBridges: { bridges: ['추론통계의 인식론적 토대', '대수의 법칙의 심화'] },
  },
  {
    id: 'stat_hypothesis_test',
    domainId: 'statistical_inference',
    concept: '가설검정',
    category: '추론통계',
    bloomLevel: 4,
    description: '귀무가설을 데이터로 기각할지 결정',
    metadata: {},
    coreEssence: '표집오차를 고려해 귀무가설의 타당성을 정량적으로 판단.',
    buildingBlocks: { blocks: ['귀무가설', '유의수준', '검정통계량', 'p-값'] },
    metaphoricalBridges: { bridges: ['연역의 확률적 판본', '타당성/건전성과 평행'] },
  },
  {
    id: 'stat_confidence_interval',
    domainId: 'statistical_inference',
    concept: '신뢰구간',
    category: '추론통계',
    bloomLevel: 4,
    description: '모수를 포함할 가능성이 높은 구간 추정',
    metadata: {},
    coreEssence: '반복 표집 시 모수를 포함할 확률로 해석되는 구간 추정치.',
    buildingBlocks: { blocks: ['점 추정', '표준오차', '신뢰 수준'] },
    metaphoricalBridges: { bridges: ['불확실성의 시각화', '메타인지 보정과 대응'] },
  },
  {
    id: 'stat_correlation_causation',
    domainId: 'statistical_inference',
    concept: '상관과 인과',
    category: '추론통계',
    bloomLevel: 4,
    description: '상관관계가 인과관계를 함의하지 않음',
    metadata: {},
    coreEssence: '공변 패턴과 인과 구조의 차이 — 혼동변수와 반사실을 요구.',
    buildingBlocks: { blocks: ['상관계수', '혼동변수', '반사실 추론'] },
    metaphoricalBridges: { bridges: ['거짓 인과 오류와 직접 연결', '미시경제 정책 평가'] },
  },
  {
    id: 'stat_bayes_theorem',
    domainId: 'statistical_inference',
    concept: '베이즈 정리',
    category: '베이즈 추론',
    bloomLevel: 5,
    description: '사전 확률과 새 증거로 사후 확률 갱신',
    metadata: {},
    coreEssence: '증거에 따라 신념을 정량적으로 개정하는 확률 갱신 규칙.',
    buildingBlocks: { blocks: ['사전 확률', '가능도', '사후 확률'] },
    metaphoricalBridges: { bridges: ['가추 추론의 수학적 형식', 'BKT 모델의 기반'] },
  },
  {
    id: 'stat_sampling_bias',
    domainId: 'statistical_inference',
    concept: '표집 편향',
    category: '연구 설계',
    bloomLevel: 3,
    description: '표본이 모집단을 대표하지 못해 발생하는 체계적 왜곡',
    metadata: {},
    coreEssence: '비무작위 표집으로 추정치가 체계적으로 빗나가는 구조적 결함.',
    buildingBlocks: { blocks: ['선택 편향', '비응답 편향', '생존자 편향'] },
    metaphoricalBridges: { bridges: ['수사학 ethos 조작의 통계판', '정책 평가의 위험'] },
  },
  {
    id: 'stat_variance_bias_tradeoff',
    domainId: 'statistical_inference',
    concept: '편향-분산 절충',
    category: '추론통계',
    bloomLevel: 5,
    description: '모델 복잡도에 따른 편향과 분산의 상충',
    metadata: {},
    coreEssence: '단순 모델의 편향과 복잡 모델의 분산 사이의 구조적 상충.',
    buildingBlocks: { blocks: ['편향', '분산', '일반화 오차'] },
    metaphoricalBridges: { bridges: ['과적합 방지 전략', 'LinUCB 탐험-활용과 유비'] },
  },
  {
    id: 'stat_regression_linear',
    domainId: 'statistical_inference',
    concept: '선형회귀',
    category: '모형화',
    bloomLevel: 4,
    description: '종속변수를 독립변수의 선형 결합으로 설명',
    metadata: {},
    coreEssence: '조건부 기댓값을 선형함수로 근사해 예측·해석하는 기초 모형.',
    buildingBlocks: { blocks: ['최소제곱', '잔차', '결정계수 R²'] },
    metaphoricalBridges: { bridges: ['수요함수 추정 도구', '귀납의 계량 변형'] },
  },

  // ---- Domain 4: microeconomics (10) ----
  {
    id: 'micro_supply_demand',
    domainId: 'microeconomics',
    concept: '수요와 공급',
    category: '시장 기초',
    bloomLevel: 2,
    description: '가격-수량 평면에서의 시장 균형',
    metadata: {},
    coreEssence: '구매자와 판매자의 선호가 교차하며 균형 가격이 형성되는 기본 기구.',
    buildingBlocks: { blocks: ['수요곡선', '공급곡선', '균형'] },
    metaphoricalBridges: { bridges: ['가격 신호로서의 정보 압축', '사회적 평형의 은유'] },
  },
  {
    id: 'micro_elasticity',
    domainId: 'microeconomics',
    concept: '탄력성',
    category: '반응 민감도',
    bloomLevel: 3,
    description: '가격 변화에 대한 수량 변화의 민감도',
    metadata: {},
    coreEssence: '변수 변화에 대한 다른 변수의 상대적 반응 강도를 수치화.',
    buildingBlocks: { blocks: ['변화율', '민감도', '탄력/비탄력 구분'] },
    metaphoricalBridges: { bridges: ['회귀의 기울기 해석', '감정 통제의 반응 조절 유비'] },
  },
  {
    id: 'micro_opportunity_cost',
    domainId: 'microeconomics',
    concept: '기회비용',
    category: '의사결정',
    bloomLevel: 3,
    description: '선택으로 포기한 차선 대안의 가치',
    metadata: {},
    coreEssence: '선택이 배제한 최선의 대안이 가졌을 가치 — 의사결정의 진짜 비용.',
    buildingBlocks: { blocks: ['명시적 비용', '암묵적 비용', '대안 평가'] },
    metaphoricalBridges: { bridges: ['의무 윤리의 경제적 사촌', '자율성 선택의 비용'] },
  },
  {
    id: 'micro_marginal_analysis',
    domainId: 'microeconomics',
    concept: '한계분석',
    category: '의사결정',
    bloomLevel: 4,
    description: '한계편익과 한계비용의 비교로 최적 결정',
    metadata: {},
    coreEssence: '추가 한 단위의 편익과 비용을 비교해 최적 수준을 탐색.',
    buildingBlocks: { blocks: ['한계편익', '한계비용', '균등 원리'] },
    metaphoricalBridges: { bridges: ['미분의 경제적 해석', '정밀 튜닝의 은유'] },
  },
  {
    id: 'micro_consumer_surplus',
    domainId: 'microeconomics',
    concept: '소비자잉여',
    category: '후생경제',
    bloomLevel: 3,
    description: '지불의사와 실제 지불액의 차이',
    metadata: {},
    coreEssence: '거래에서 소비자가 얻는 순 가치 — 시장 후생의 절반.',
    buildingBlocks: { blocks: ['지불의사', '시장가격', '차액 합'] },
    metaphoricalBridges: { bridges: ['기회비용과 대칭 구조', '가치 분배의 시각화'] },
  },
  {
    id: 'micro_externality',
    domainId: 'microeconomics',
    concept: '외부효과',
    category: '시장실패',
    bloomLevel: 4,
    description: '거래 당사자 외부에 미치는 비용/편익',
    metadata: {},
    coreEssence: '시장 거래가 제3자에게 전가하는 비용 또는 편익의 누출.',
    buildingBlocks: { blocks: ['부정적 외부성', '긍정적 외부성', '교정 수단'] },
    metaphoricalBridges: { bridges: ['공동선의 경제학적 번역', '의무 윤리와 접점'] },
  },
  {
    id: 'micro_public_goods',
    domainId: 'microeconomics',
    concept: '공공재',
    category: '시장실패',
    bloomLevel: 4,
    description: '비경합성과 비배제성을 가진 재화',
    metadata: {},
    coreEssence: '소비가 배타적이지 않고 경합적이지 않아 무임승차를 유발하는 재화.',
    buildingBlocks: { blocks: ['비경합성', '비배제성', '무임승차 문제'] },
    metaphoricalBridges: { bridges: ['집단 의사결정의 딜레마', '게임이론과 연결'] },
  },
  {
    id: 'micro_nash_equilibrium',
    domainId: 'microeconomics',
    concept: '내쉬 균형',
    category: '게임이론',
    bloomLevel: 5,
    description: '어떤 참가자도 단독으로 전략을 바꿀 유인이 없는 상태',
    metadata: { origin: 'John Nash 1950' },
    coreEssence: '각 플레이어가 상대 전략을 고려해 자기 전략을 최적화한 안정 지점.',
    buildingBlocks: { blocks: ['최적 반응', '전략 조합', '안정성'] },
    metaphoricalBridges: { bridges: ['내면의 성채의 게임이론적 유비', '합리적 본성의 제도화'] },
  },
  {
    id: 'micro_prisoners_dilemma',
    domainId: 'microeconomics',
    concept: '죄수의 딜레마',
    category: '게임이론',
    bloomLevel: 4,
    description: '협력이 더 낫지만 각자는 배신을 선택하는 상황',
    metadata: {},
    coreEssence: '개인 합리성과 집단 합리성의 충돌을 드러내는 고전적 게임.',
    buildingBlocks: { blocks: ['협력/배신', '보수 행렬', '지배 전략'] },
    metaphoricalBridges: { bridges: ['공공재 문제의 축소판', '수사학 ethos의 반복 게임'] },
  },
  {
    id: 'micro_information_asymmetry',
    domainId: 'microeconomics',
    concept: '정보 비대칭',
    category: '정보경제',
    bloomLevel: 5,
    description: '거래 당사자가 보유한 정보의 차이',
    metadata: { origin: 'Akerlof 1970' },
    coreEssence: '거래 참가자 간 정보 격차가 역선택·도덕적 해이를 유발하는 구조.',
    buildingBlocks: { blocks: ['역선택', '도덕적 해이', '신호 보내기'] },
    metaphoricalBridges: { bridges: ['수사학 ethos 의 경제학 판', '표집 편향의 거래 버전'] },
  },

  // ---- Domain 5: rhetoric (10) ----
  {
    id: 'rhet_ethos',
    domainId: 'rhetoric',
    concept: '에토스(Ethos)',
    category: '설득 수단',
    bloomLevel: 3,
    description: '발화자의 신뢰성에 기반한 설득',
    metadata: { origin: 'Aristotle Rhetoric I' },
    coreEssence: '화자의 성품·전문성·선의로 청중의 신뢰를 얻어 논증을 지탱.',
    buildingBlocks: { blocks: ['전문성', '성품', '선의'] },
    metaphoricalBridges: { bridges: ['정보 비대칭 하의 신호', '인신공격 오류의 역설계'] },
  },
  {
    id: 'rhet_pathos',
    domainId: 'rhetoric',
    concept: '파토스(Pathos)',
    category: '설득 수단',
    bloomLevel: 3,
    description: '청중의 감정을 움직이는 설득',
    metadata: { origin: 'Aristotle Rhetoric II' },
    coreEssence: '청중의 감정 상태를 이해·조정해 판단을 유도하는 기술.',
    buildingBlocks: { blocks: ['감정 식별', '상황 유발', '공감 구축'] },
    metaphoricalBridges: { bridges: ['감정 통제의 역방향', '마케팅의 심리학'] },
  },
  {
    id: 'rhet_logos',
    domainId: 'rhetoric',
    concept: '로고스(Logos)',
    category: '설득 수단',
    bloomLevel: 4,
    description: '논증의 논리적 구조에 기반한 설득',
    metadata: { origin: 'Aristotle Rhetoric I' },
    coreEssence: '전제·추론·결론의 합리적 연결로 지성을 설득하는 축.',
    buildingBlocks: { blocks: ['명제', '추론 구조', '증거'] },
    metaphoricalBridges: { bridges: ['삼단논법의 수사적 활용', '통계적 증거의 현대 변형'] },
  },
  {
    id: 'rhet_enthymeme',
    domainId: 'rhetoric',
    concept: '생략삼단논법',
    category: '논증 구성',
    bloomLevel: 4,
    description: '전제 일부를 생략한 수사적 삼단논법',
    metadata: {},
    coreEssence: '청중이 빈 전제를 스스로 채우게 함으로써 더 설득력 있는 약식 추론.',
    buildingBlocks: { blocks: ['암묵 전제', '명시 전제', '유도된 결론'] },
    metaphoricalBridges: { bridges: ['허수아비 오류의 취약 지점', '인지 부하 조정 기법'] },
  },
  {
    id: 'rhet_kairos',
    domainId: 'rhetoric',
    concept: '카이로스(Kairos)',
    category: '수사적 시점',
    bloomLevel: 4,
    description: '설득에 적합한 결정적 순간',
    metadata: {},
    coreEssence: '논증의 내용이 아닌 제시 시점의 적시성을 전략적으로 활용.',
    buildingBlocks: { blocks: ['청중 상태', '문맥', '타이밍 선택'] },
    metaphoricalBridges: { bridges: ['의사결정의 한계분석과 유비', '메타인지 보정 시점'] },
  },
  {
    id: 'rhet_genres',
    domainId: 'rhetoric',
    concept: '연설 장르 삼분',
    category: '수사학 구조',
    bloomLevel: 3,
    description: '심의·법정·전시 세 장르 구분',
    metadata: { origin: 'Aristotle Rhetoric I' },
    coreEssence: '심의·법정·과시 장르별 목적과 시제 구조의 차이를 인식.',
    buildingBlocks: { blocks: ['심의적', '법정적', '과시적'] },
    metaphoricalBridges: { bridges: ['사회적 상황 맥락화', '공공재 논의 틀'] },
  },
  {
    id: 'rhet_canons_five',
    domainId: 'rhetoric',
    concept: '수사학 5 정전',
    category: '수사 과정',
    bloomLevel: 4,
    description: '발상·배열·표현·기억·연기 다섯 단계',
    metadata: { origin: 'Cicero De Inventione' },
    coreEssence: '고전 수사학이 설득 과정을 다섯 국면으로 분할한 체계적 표준.',
    buildingBlocks: { blocks: ['Inventio', 'Dispositio', 'Elocutio', 'Memoria', 'Pronuntiatio'] },
    metaphoricalBridges: { bridges: ['글쓰기 워크플로 원형', '학습 루틴 설계'] },
  },
  {
    id: 'rhet_figures_metaphor',
    domainId: 'rhetoric',
    concept: '은유(Metaphor)',
    category: '수사적 장치',
    bloomLevel: 4,
    description: '개념 간 사상(mapping)을 통한 의미 확장',
    metadata: { origin: 'Aristotle Poetics' },
    coreEssence: '한 영역의 구조를 다른 영역에 투사해 새로운 이해를 생성.',
    buildingBlocks: { blocks: ['원천 영역', '목표 영역', '사상 관계'] },
    metaphoricalBridges: { bridges: ['메타인지 은유 밀도 지표의 원천', '학습의 전이 메커니즘'] },
  },
  {
    id: 'rhet_audience_analysis',
    domainId: 'rhetoric',
    concept: '청중 분석',
    category: '수사적 준비',
    bloomLevel: 3,
    description: '청중의 신념·욕구·제약을 사전 파악',
    metadata: {},
    coreEssence: '설득 대상의 배경·가치·제약 조건을 체계적으로 진단하는 활동.',
    buildingBlocks: { blocks: ['인구통계', '신념 체계', '상황 제약'] },
    metaphoricalBridges: { bridges: ['표집 편향의 질적 대응', '정보 비대칭 완화'] },
  },
  {
    id: 'rhet_refutation',
    domainId: 'rhetoric',
    concept: '반박(Refutatio)',
    category: '논증 구성',
    bloomLevel: 4,
    description: '반대 입장을 예상하고 사전에 반박',
    metadata: {},
    coreEssence: '예상되는 반대 논증을 미리 도입해 무력화하는 능동적 수사 전략.',
    buildingBlocks: { blocks: ['상대 주장 재구성', '약점 식별', '반박 제시'] },
    metaphoricalBridges: { bridges: ['반례 논리와 직접 연결', '태극 엔진의 수사 판본'] },
  },
];

// ---------------------------------------------------------------------------
// Edge seed definitions (21 edges, cross-domain fractal bridges)
// ---------------------------------------------------------------------------

export const SEED_EDGES: readonly SeedEdge[] = [
  // Logic <-> Rhetoric
  { id: 'ke_x_001', domainId: 'cross_logic_rhetoric', fromId: 'logic_syllogism',         toId: 'rhet_logos',          relationType: 'supports',     strength: 0.85, metadata: { fractal: 'formal_core' } },
  { id: 'ke_x_002', domainId: 'cross_logic_rhetoric', fromId: 'logic_syllogism',         toId: 'rhet_enthymeme',      relationType: 'includes',     strength: 0.80, metadata: { fractal: 'compressed_form' } },
  { id: 'ke_x_003', domainId: 'cross_logic_rhetoric', fromId: 'logic_fallacy_adhominem', toId: 'rhet_ethos',          relationType: 'contradicts',  strength: 0.75, metadata: { fractal: 'ethos_abuse' } },
  { id: 'ke_x_004', domainId: 'cross_logic_rhetoric', fromId: 'logic_counterexample',    toId: 'rhet_refutation',     relationType: 'supports',     strength: 0.82, metadata: { fractal: 'negation_engine' } },

  // Logic <-> Statistics
  { id: 'ke_x_005', domainId: 'cross_logic_stat',     fromId: 'logic_induction',             toId: 'stat_descriptive',            relationType: 'prerequisite', strength: 0.70, metadata: { fractal: 'empirical_path' } },
  { id: 'ke_x_006', domainId: 'cross_logic_stat',     fromId: 'logic_fallacy_false_cause',   toId: 'stat_correlation_causation',  relationType: 'contradicts', strength: 0.88, metadata: { fractal: 'cause_confusion' } },
  { id: 'ke_x_007', domainId: 'cross_logic_stat',     fromId: 'logic_abduction',             toId: 'stat_bayes_theorem',          relationType: 'exemplifies', strength: 0.80, metadata: { fractal: 'best_explanation' } },
  { id: 'ke_x_008', domainId: 'cross_logic_stat',     fromId: 'logic_validity_soundness',    toId: 'stat_hypothesis_test',        relationType: 'supports',     strength: 0.72, metadata: { fractal: 'structure_vs_content' } },

  // Statistics <-> Microeconomics
  { id: 'ke_x_009', domainId: 'cross_stat_micro',     fromId: 'stat_regression_linear',      toId: 'micro_elasticity',            relationType: 'supports',     strength: 0.78, metadata: { fractal: 'slope_as_sensitivity' } },
  { id: 'ke_x_010', domainId: 'cross_stat_micro',     fromId: 'stat_sampling_bias',          toId: 'micro_information_asymmetry', relationType: 'supports',     strength: 0.70, metadata: { fractal: 'info_gap' } },
  { id: 'ke_x_011', domainId: 'cross_stat_micro',     fromId: 'stat_variance_bias_tradeoff', toId: 'micro_marginal_analysis',     relationType: 'supports',     strength: 0.65, metadata: { fractal: 'optimization_tension' } },

  // Microeconomics <-> Meditations
  { id: 'ke_x_012', domainId: 'cross_micro_meditations', fromId: 'micro_opportunity_cost',   toId: 'duty_ethics',     relationType: 'supports',    strength: 0.70, metadata: { fractal: 'choice_as_obligation' } },
  { id: 'ke_x_013', domainId: 'cross_micro_meditations', fromId: 'micro_nash_equilibrium',   toId: 'inner_citadel',   relationType: 'exemplifies', strength: 0.60, metadata: { fractal: 'rational_stability' } },
  { id: 'ke_x_014', domainId: 'cross_micro_meditations', fromId: 'micro_externality',        toId: 'duty_ethics',     relationType: 'supports',    strength: 0.75, metadata: { fractal: 'other_regarding' } },

  // Rhetoric <-> Meditations
  { id: 'ke_x_015', domainId: 'cross_rhet_meditations', fromId: 'rhet_pathos',                toId: 'emotion_control',    relationType: 'contradicts', strength: 0.72, metadata: { fractal: 'affect_direction' } },
  { id: 'ke_x_016', domainId: 'cross_rhet_meditations', fromId: 'rhet_figures_metaphor',      toId: 'cosmic_perspective', relationType: 'supports',    strength: 0.68, metadata: { fractal: 'scale_mapping' } },
  { id: 'ke_x_017', domainId: 'cross_rhet_meditations', fromId: 'rhet_logos',                 toId: 'rational_nature',    relationType: 'supports',    strength: 0.80, metadata: { fractal: 'logos_shared' } },

  // Statistics <-> Meditations
  { id: 'ke_x_018', domainId: 'cross_stat_meditations', fromId: 'stat_variance_bias_tradeoff', toId: 'amor_fati',         relationType: 'exemplifies', strength: 0.55, metadata: { fractal: 'accepting_tradeoff' } },

  // Logos <-> Rhet logos
  { id: 'ke_x_019', domainId: 'cross_logos_logos',     fromId: 'logos_universal',             toId: 'rhet_logos',         relationType: 'prerequisite', strength: 0.90, metadata: { fractal: 'metaphysical_to_rhetorical' } },

  // Within-domain exemplars for meditations additions
  { id: 'ke_x_020', domainId: 'meditations_4', fromId: 'cosmic_perspective', toId: 'amor_fati',       relationType: 'supports',    strength: 0.75, metadata: { fractal: 'scale_acceptance' } },
  { id: 'ke_x_021', domainId: 'meditations_4', fromId: 'rational_nature',    toId: 'logos_universal', relationType: 'prerequisite', strength: 0.85, metadata: { fractal: 'individual_to_universal' } },
];

// ---------------------------------------------------------------------------
// Idempotent seed executor
// ---------------------------------------------------------------------------

/**
 * 5개 도메인 50+ 노드 시드 데이터를 삽입한다.
 *
 * IDEMPOTENT: `INSERT OR IGNORE` 를 사용하므로 여러 번 호출해도 안전.
 * 반환 값은 성공적으로 준비된(prepare 완료) 노드/엣지의 개수 — SQLite
 * D1 에서 실제 insert/ignored 구분은 meta.changes 로 확인하며, 본 헬퍼는
 * 단순히 시도된 총 행 수를 반환한다.
 *
 * @param db Cloudflare D1 Database binding
 * @returns 시드된 노드 수와 엣지 수
 */
export async function seedDomains(
  db: D1Database,
): Promise<SeedResult> {
  const nodeSql = `
    INSERT OR IGNORE INTO knowledge_nodes (
      id, domain_id, concept, category, bloom_level, description, metadata_json,
      core_essence, building_blocks_json, metaphorical_bridges_json, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)
  `;

  const edgeSql = `
    INSERT OR IGNORE INTO knowledge_edges (
      id, domain_id, from_id, to_id, relation_type, strength, metadata_json, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
  `;

  const nodeStatements = SEED_NODES.map((n) =>
    db
      .prepare(nodeSql)
      .bind(
        n.id,
        n.domainId,
        n.concept,
        n.category,
        n.bloomLevel,
        n.description,
        JSON.stringify(n.metadata),
        n.coreEssence,
        JSON.stringify(n.buildingBlocks),
        JSON.stringify(n.metaphoricalBridges),
      ),
  );

  const edgeStatements = SEED_EDGES.map((e) =>
    db
      .prepare(edgeSql)
      .bind(
        e.id,
        e.domainId,
        e.fromId,
        e.toId,
        e.relationType,
        e.strength,
        JSON.stringify(e.metadata),
      ),
  );

  // D1 batch 는 atomic transaction 을 제공. 시드 전체가 한 단위로 커밋된다.
  await db.batch([...nodeStatements, ...edgeStatements]);

  return {
    insertedNodes: nodeStatements.length,
    insertedEdges: edgeStatements.length,
  };
}

/**
 * 총 노드 수 카운트. 시드 정의의 정적 검증에 사용.
 * 기존 8개 명상록 노드(0015 migration 기반)는 포함하지 않음.
 */
export function countSeedNodes(): number {
  return SEED_NODES.length;
}

/**
 * 도메인별 노드 수 분포를 반환.
 */
export function countNodesByDomain(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of SEED_NODES) {
    counts[node.domainId] = (counts[node.domainId] ?? 0) + 1;
  }
  return counts;
}

/**
 * 교차 도메인 엣지 수 반환 (cross_* 접두사 domain_id 기준).
 */
export function countCrossDomainEdges(): number {
  return SEED_EDGES.filter((e) => e.domainId.startsWith('cross_')).length;
}
