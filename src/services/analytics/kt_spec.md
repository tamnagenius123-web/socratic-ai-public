# Knowledge Tracing 구현 스펙 (T2.4.1)

**작성**: Cowork (v35→v36 브릿지)
**정독 원전**:
- `library/05_Corbett_Anderson_1995_BKT.pdf` (pp.1-25)
- `library/10_Ghosh_2020_AKT.pdf` (KDD 2020)
- `library/09_Rafferty_2016_POMDP_teaching.pdf`

---

## 1. BKT 원전 공식 (Corbett & Anderson 1995)

### 1.1 4 파라미터 정의 (p.261 Fig.4)

| 기호 | 이름 | 정의 |
|------|------|------|
| **p(L₀)** | Initial Learning | 학생이 연습 전에 이미 해당 규칙을 아는 확률(텍스트 읽기 등으로) |
| **p(T)** | Acquisition | 연습 한 번에 unlearned → learned 전이 확률 |
| **p(G)** | Guess | unlearned 상태에서 우연히 맞출 확률 |
| **p(S)** | Slip | learned 상태에서 실수로 틀릴 확률 |

### 1.2 업데이트 식 (p.261, Eq.1)

```
p(Lₙ) = p(L_{n-1} | evidence) + (1 - p(L_{n-1} | evidence)) × p(T)
```

**정답 시 사후확률** (Bayes):
```
p(L_{n-1} | correct) = p(L_{n-1}) × (1 - p(S))
                       ─────────────────────────────────────
                       p(L_{n-1}) × (1 - p(S)) + (1 - p(L_{n-1})) × p(G)
```

**오답 시 사후확률**:
```
p(L_{n-1} | incorrect) = p(L_{n-1}) × p(S)
                          ────────────────────────────────
                          p(L_{n-1}) × p(S) + (1 - p(L_{n-1})) × (1 - p(G))
```

### 1.3 Mastery Criterion
- 원전: **p(L) ≥ 0.95 도달 시 해당 스킬 "숙달"** (p.261)
- Socratic AI 적용: 0.95 유지. 단 0.85 구간부터 ZONE ZERO 전환 UI 트리거 (Deci 1999 반영).

### 1.4 파라미터 권장 초기값
- 원전은 "경험적으로 개별 규칙마다 추정" (p.261)
- 실전 권고(ITS 연구 관례):
  - p(L₀) = 0.30
  - p(T) = 0.10
  - p(G) = 0.20 (객관식/자동 채점)
  - p(S) = 0.10
- 주의: p(G) + p(S) ≥ 1.0 이면 degenerate (identifiability 문제). 반드시 제약.

---

## 2. TypeScript 스펙

```typescript
// src/services/analytics/kt/bkt.ts

export interface BKTParams {
  pL0: number;    // Initial
  pT: number;     // Acquisition
  pG: number;     // Guess
  pS: number;     // Slip
}

export interface BKTState {
  skillId: string;
  userId: string;
  pKnow: number;     // p(L_n)
  n: number;         // opportunities observed
  lastUpdateAt: number;
}

export const DEFAULT_BKT_PARAMS: BKTParams = {
  pL0: 0.30,
  pT: 0.10,
  pG: 0.20,
  pS: 0.10,
};

/** Corbett & Anderson 1995, Eq.1 */
export function updateBKT(
  state: BKTState,
  correct: boolean,
  params: BKTParams = DEFAULT_BKT_PARAMS
): BKTState {
  // validate
  if (params.pG + params.pS >= 1.0) {
    throw new Error(`BKT degenerate: pG(${params.pG}) + pS(${params.pS}) >= 1`);
  }

  const prior = state.pKnow;
  let posterior: number;

  if (correct) {
    const num = prior * (1 - params.pS);
    const den = num + (1 - prior) * params.pG;
    posterior = den > 0 ? num / den : prior;
  } else {
    const num = prior * params.pS;
    const den = num + (1 - prior) * (1 - params.pG);
    posterior = den > 0 ? num / den : prior;
  }

  const pLn = posterior + (1 - posterior) * params.pT;

  return {
    ...state,
    pKnow: Math.min(0.9999, Math.max(0.0001, pLn)),
    n: state.n + 1,
    lastUpdateAt: Date.now(),
  };
}

/** Predict probability of correct response */
export function predictCorrect(state: BKTState, params: BKTParams = DEFAULT_BKT_PARAMS): number {
  return state.pKnow * (1 - params.pS) + (1 - state.pKnow) * params.pG;
}
```

---

## 3. AKT (Attentive KT, Ghosh et al. 2020)

### 3.1 원전 개요
- **Architecture**: Rasch-encoded representation + monotonic attention with exponential decay distance weighting
- **SOTA at time**: ASSISTments 2009, STATICS, Algebra 2005-6 benchmarks에서 SAINT/SAKT/DKT 대비 AUC 개선
- **강점**: Interpretability (attention map이 "어느 과거 응답이 현재 예측에 기여했는지" 시각화)

### 3.2 우리 적용 조건
- **파라미터 수**: ~1M 수준 (저비용)
- **학습 데이터 요구**: 수천 학생 × 수십 세션 × 수십 스킬. v34 기준 데이터량 미달 → 콜드 스타트 문제.
- **권고**: v36 초기에는 BKT 단독, 누적 세션 50,000+ 시점에서 AKT 전환.

### 3.3 TypeScript 인터페이스 (스텁)

```typescript
export interface AKTState {
  userId: string;
  sequenceEmbedding: Float32Array;  // latent; stored as JSON in D1
  lastSkills: string[];
  lastResponses: boolean[];
  modelVersion: string;
}

export interface AKTPrediction {
  skillId: string;
  pCorrect: number;
  attentionMap: Array<{ pastTurn: number; weight: number }>;
}

// 실제 모델은 Workers AI 또는 외부 엔드포인트 호출.
// 이 서비스는 어댑터만.
export async function predictAKT(
  state: AKTState,
  skillId: string,
  env: Env
): Promise<AKTPrediction> {
  throw new Error('Not implemented: v36 T2.4.1 target');
}
```

---

## 4. 앙상블 전략 (BKT + AKT)

원전 비교 없이 실증적 선택:
- **Cold start** (총 응답 수 < 30): BKT 단독. 파라미터는 스킬별 공유 prior.
- **Warm** (≥ 30): 0.7 × BKT + 0.3 × AKT (가중 평균)
- **Mature** (≥ 200): 0.3 × BKT + 0.7 × AKT

전환 기준은 세션당 응답 수 누적 기반. `analytics_reports` 테이블에 `kt_mode` 필드 추가.

---

## 5. Rafferty et al. (2016) POMDP 교수 — 통합 여부

### 5.1 원전 요약
- 상태: 학생의 믿음 확률 분포
- 행동: 다음 문제 선택(난이도/개념)
- 관찰: 학생 응답(correct/incorrect)
- Horizon: 무한, 할인 factor 0.9 권장
- 계산 비용: 큰 state space에서는 oneline planning 한계

### 5.2 Socratic AI 적용 판정
- BKT/AKT는 **"학생이 얼마나 아는가"** 추정.
- POMDP는 **"다음에 뭘 줘야 하는가"** 결정.
- 이미 LinUCB(§6 참조)가 그 역할을 맡음 → **POMDP 채택 보류**.
- 대신 POMDP의 "horizon 개념"을 LinUCB reward에 반영 (즉각 정답률뿐 아니라 향후 3턴 마스터리 상승 기대).

---

## 6. LinUCB Contextual Bandit (T1.4.4 통합)

**원전 공식** (Li et al. 2010, Algorithm 1):
```
θ̂_a = A_a^{-1} b_a
UCB_a = θ̂_a^T x_{t,a} + α × sqrt(x_{t,a}^T A_a^{-1} x_{t,a})
action = argmax_a UCB_a
After reward r_t,a:
  A_a ← A_a + x_{t,a} x_{t,a}^T
  b_a ← b_a + r_t,a x_{t,a}
```

### 6.1 Socratic AI 적용 스펙

- **α (exploration)**: 초기 0.5, 프로덕션 0.1 (원전 §4.2의 실증 설정)
- **Context vector x_{t,a}** (d=8):
  - [0] mastery (BKT pKnow)
  - [1] engagement (실시간 입력 속도 신호)
  - [2] flow_index
  - [3] domain_id one-hot (top-4까지)
- **Arms (actions)**: 난이도 레벨 5단계(1~5) + 질문 타입 3종(definition/application/counterexample) = 15 arms
- **Reward**: 0.7 × (다음 턴 정답 여부) + 0.3 × (3턴 내 마스터리 증가)

### 6.2 ±1% 난이도 조정 주장 평가
- 원전 이론 근거: d-차원에서 regret O(√(KdT)). 해상도는 arm 분할에 달림.
- **우리 5단계 arm으로는 ±1% 달성 불가**. 마케팅 카피에서 "세밀 조정" 정도로 표현 조정 필요.

### 6.3 구현 스펙 (TypeScript)

```typescript
// src/services/analytics/bandit/linucb.ts
export interface LinUCBArm {
  id: string;
  A: number[][];   // d×d matrix
  b: number[];     // d-vector
}

export class LinUCB {
  constructor(private d: number, private alpha: number = 0.5) {}

  chooseArm(arms: LinUCBArm[], context: number[]): string {
    let best = { id: '', ucb: -Infinity };
    for (const arm of arms) {
      const Ainv = invertMatrix(arm.A);
      const thetaHat = matVec(Ainv, arm.b);
      const mean = dot(thetaHat, context);
      const variance = dot(context, matVec(Ainv, context));
      const ucb = mean + this.alpha * Math.sqrt(variance);
      if (ucb > best.ucb) best = { id: arm.id, ucb };
    }
    return best.id;
  }

  update(arm: LinUCBArm, context: number[], reward: number): LinUCBArm {
    const A_new = addOuter(arm.A, context);
    const b_new = arm.b.map((bi, i) => bi + reward * context[i]);
    return { ...arm, A: A_new, b: b_new };
  }
}
```

### 6.4 D1 저장
```sql
-- migrations/0031_linucb_state.sql
CREATE TABLE IF NOT EXISTS linucb_arms (
  arm_id TEXT PRIMARY KEY,
  context_dim INTEGER NOT NULL,
  A_matrix_json TEXT NOT NULL,   -- d×d
  b_vector_json TEXT NOT NULL,   -- d
  n_pulls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
```

---

## 7. 참고 페이지 인덱스

| 주제 | 원전 페이지 |
|------|-----------|
| BKT 4-파라미터 정의 | Corbett-Anderson 1995, p.261 Fig.4 |
| BKT 업데이트 식 | Corbett-Anderson 1995, p.261 Eq.1 |
| Mastery 0.95 | Corbett-Anderson 1995, p.261 |
| LinUCB Algorithm 1 | Li et al. 2010, p.663 |
| AKT 구조 | Ghosh et al. 2020, KDD (본문) |
| POMDP horizon | Rafferty et al. 2016 |

---

**문서 끝**
