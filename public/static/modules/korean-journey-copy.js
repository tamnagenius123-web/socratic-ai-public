// Critical Path B — learner-visible Korean copy for the first Training → Growth journey.
// Protocol identifiers remain literal; the Korean text explains rather than renames them.

const freeze = (value) => Object.freeze(value);

export const KOREAN_JOURNEY_COPY = freeze({
  learningRoute: freeze({
    title: '이번 문제는 어떤 순서로 풀어볼까요?',
    explanation: '학습 성향을 진단하지 않습니다. 아래 문제와 출처를 확인한 뒤 순서를 고르세요. 평가 기준과 사고의 깊이는 같습니다.',
    save: '이 순서로 진행', revise: '다음 답변부터 순서 바꾸기',
    unknown: '이 순서의 적합성을 뒷받침할 근거가 부족합니다. 선택은 기록하지만 기존 지도 방식을 유지합니다.',
    efficacy: '어느 순서가 더 효과적인지는 아직 확인되지 않았습니다.',
    required: '답변을 보내기 전에 학습 순서를 선택해 주세요.',
    'case-first': freeze({ title: '사례 먼저', order: '상황 → 판단 → 근거 검토', reason: '문제의 이해관계자와 제약에서 시작하고, 근거로 판단을 다시 검토합니다.' }),
    'proof-first': freeze({ title: '근거 먼저', order: '근거 → 기준 → 판단', reason: '문제의 주장과 근거 기준을 먼저 세우고, 구체적인 상황에 적용합니다.' }),
    mixed: freeze({ title: '사례와 근거 함께', order: '상황 ↔ 근거 → 비교 판단', reason: '문제에 드러난 상충 관계와 근거를 번갈아 비교합니다.' }),
  }),

  trainingGrowthCta: freeze({
    title: '비공개 성장 주기',
    legacyUnavailable: '이전 방식으로 만든 시나리오는 비공개 성장 주기를 시작할 근거로 사용할 수 없습니다.',
    explanation: '완료한 Training 기록에서 임시 출발점 UNKNOWN을 엽니다. 기존 점수나 약점 표시가 검증되었다는 뜻은 아닙니다.',
    open: '비공개 성장 주기 열기',
    opening: '비공개 성장 주기를 여는 중…',
    ariaLabel: '완료한 Training 세션에서 비공개 성장 주기 열기',
  }),
  purposeConsent: freeze({
    title: '목적별 비공개 이용 동의',
    explanation: '비공개 공간을 만들기 전에 학습 목적, 사용할 데이터 범주, 보관 정책과 정책 버전을 직접 확인하고 동의합니다.',
    action: '이 목적에 동의하고 저장',
  }),
  retention: freeze({
    title: '보관 조건',
    explanation: '동의 화면에 표시된 보관 정책은 비공개 공간과 기록에 적용됩니다. 주기 삭제와 동의 철회는 서로 다른 절차입니다.',
  }),
  optOutBeforeConsent: freeze({
    title: '동의하지 않고 나가기',
    explanation: '동의 전에는 비공개 공간이나 성장 주기가 생성되지 않습니다.',
    action: '동의하지 않고 돌아가기',
  }),
  revocation: freeze({
    title: '비공개 이용 동의 철회',
    explanation: '철회하면 이 비공개 SOLO 공간에 더 이상 쓸 수 없습니다. 철회만으로 보관 기록이 삭제되었다고 주장하지 않습니다.',
    action: '비공개 이용 동의 철회',
    confirm: '철회 확인',
  }),
  contest: freeze({
    title: '이의 제기',
    explanation: '과제 수준의 가설에 이의를 제기해도 원래 주장과 이의 기록은 함께 보존됩니다. 능력 결과를 추론하지 않습니다.',
    action: '이의 제기',
    submit: '이의 제기 제출',
  }),
  correction: freeze({
    title: '정정 요청',
    explanation: '원래 기록을 지우지 않고 정정 요청과 근거를 별도 기록으로 남깁니다.',
    action: '정정 요청',
  }),
  humanReviewPending: freeze({
    protocolId: 'PENDING',
    title: '사람의 검토 요청 대기 중',
    explanation: '사람의 검토 요청이 접수되어 PENDING 상태입니다. 요청만으로 검토가 완료되지는 않습니다.',
    action: '사람의 검토 요청',
  }),
  gapUnknown: freeze({
    protocolId: 'GAP_UNKNOWN',
    title: '격차 확인 안 됨',
    explanation: '현재 근거로는 검증된 격차를 확정할 수 없습니다. 격차 주장에 동의하지 않고도 비공개 학습 초점을 선택할 수 있습니다.',
  }),
  focus: freeze({
    title: '학습 초점 선택',
    explanation: '학습자가 고른 초점은 검증된 격차나 능력 판정이 아닙니다.',
    action: '비공개 초점 선택',
  }),
  practice: freeze({
    title: '연습 선택',
    explanation: '연습 수락은 숙달, 향상 또는 전이를 의미하지 않습니다.',
    accept: '연습 수락',
    decline: '거절',
    defer: '나중에 결정',
  }),
  recheckUnknown: freeze({
    protocolId: 'RECHECK_SCHEDULED',
    outcome: 'UNKNOWN',
    title: '재확인 예약됨',
    explanation: '재확인 결과는 비교 계약을 충족하기 전까지 UNKNOWN으로 남습니다.',
  }),
  delete: freeze({
    title: '이 비공개 주기 삭제',
    explanation: '소유자 요청 삭제 절차로 주기와 비공개 하위 기록을 제거합니다. 완료 응답에는 삭제 영수증만 남습니다.',
    action: '비공개 주기 삭제',
    confirmTitle: '비공개 주기 삭제 확인',
    confirmExplanation: '이 화면에서는 삭제를 되돌릴 수 없습니다.',
    confirmAction: '삭제 확인',
    cancel: '취소',
  }),
  uncertainty: freeze({
    protocolId: 'UNKNOWN',
    evidenceHintCode: 'EVIDENCE_HINT_UNAVAILABLE',
    evidenceHintReason: '근거 기반 훈련에서는 힌트를 사용할 수 없습니다.',
    explanation: '확인할 수 없는 상태는 UNKNOWN으로 표시합니다. 점수 0, 실패, 성공 또는 진단으로 바꾸지 않습니다.',
    unavailable: '요청을 완료하지 못했습니다. 비공개 기록이 바뀌었다고 추정하지 않습니다.',
  }),
  trainingOriginKind: 'TRAINING',
  states: freeze({
    EVIDENCE_PENDING: freeze(['근거 확인 대기', '저장된 시도에 아직 사용할 수 있는 근거와 검증 관계가 필요합니다.']),
    GAP_PROPOSED: freeze(['격차 가설 제안됨', '과제 수준의 가설을 검토할 수 있습니다. 아직 검증된 격차가 아닙니다.']),
    GAP_ACCEPTED: freeze(['격차 가설 수락됨', '수락한 가설은 다음 허용 학습 행동을 기다립니다. 능력 판정은 아닙니다.']),
    GAP_CONTESTED: freeze(['이의 제기 기록됨', '이의 기록과 원래 가설을 함께 보존합니다. 능력 결과를 추론하지 않습니다.']),
    GAP_DISMISSED: freeze(['격차 가설 기각됨', '가설을 기각했으며 성장 결과를 기록하지 않습니다.']),
    GAP_DEFERRED: freeze(['격차 가설 보류됨', '다시 시작하거나 종료하기 전까지 가설을 보류합니다.']),
    GAP_UNKNOWN: freeze(['격차 확인 안 됨', '현재 기록으로 검증된 격차를 확정할 수 없습니다. 격차 주장에 동의하지 않고 비공개 초점을 선택할 수 있습니다.']),
    FOCUS_SELECTED: freeze(['학습 초점 선택됨', '학습자가 고른 초점이며 검증된 격차가 아닙니다.']),
    PRACTICE_OFFERED: freeze(['연습 제안됨', '버전이 고정된 연습 선택지를 검토할 수 있습니다.']),
    PRACTICE_ACCEPTED: freeze(['연습 수락됨', '연습 수락은 숙달이 아닙니다. 기록된 정책을 통해서만 재확인을 예약할 수 있습니다.']),
    PRACTICE_DECLINED: freeze(['연습 거절됨', '연습을 거절해도 성장 결과를 추론하지 않습니다.']),
    PRACTICE_DEFERRED: freeze(['연습 보류됨', '다시 시작하거나 종료하기 전까지 제안을 보류합니다.']),
    RECHECK_SCHEDULED: freeze(['재확인 예약됨', '나중에 다른 시도를 확인하도록 예약되었습니다. 비교 계약이 충족되기 전 결과는 UNKNOWN입니다.']),
    RECHECKED: freeze(['재확인 기록됨', '재확인 기록은 존재하지만 비교 계약이 허용하기 전까지 지속 가능한 결과를 추론하지 않습니다.']),
    TRANSFER_PENDING: freeze(['전이 확인 대기', '전이 결과는 아직 확인되지 않았습니다.']),
    CLOSED: freeze(['주기 종료됨', '주기를 종료해도 향상을 의미하지 않습니다.']),
  }),
});
