-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS micro_indicator_catalog (
  id TEXT PRIMARY KEY,
  axis TEXT NOT NULL CHECK(axis IN ('logical', 'data', 'flexibility', 'communication')),
  cluster TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  score_type TEXT NOT NULL CHECK(score_type IN ('ratio', 'binary', 'latency', 'count', 'rubric')),
  weight REAL NOT NULL DEFAULT 1.0,
  threshold_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_micro_catalog_axis ON micro_indicator_catalog(axis);

CREATE INDEX IF NOT EXISTS idx_micro_catalog_active ON micro_indicator_catalog(active);

CREATE TABLE IF NOT EXISTS session_micro_scores (
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  indicator_id TEXT NOT NULL,
  raw_value REAL NOT NULL DEFAULT 0,
  normalized_score REAL NOT NULL DEFAULT 0 CHECK(normalized_score BETWEEN 0 AND 1),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (session_id, turn_number, indicator_id)
);

INSERT OR IGNORE INTO micro_indicator_catalog (id, axis, cluster, name, description, score_type, weight) VALUES
     ('ls_claim_clarity', 'logical', 'claim_quality', '주장 명확성', '핵심 논지의 조작적 정의와 명확한 표현', 'rubric', 1.5),
  ('ls_premise_sufficiency', 'logical', 'warrant', '전제 충분성', '결론 도출에 필요한 전제가 충분히 제시됨', 'rubric', 1.2),
  ('ls_circular_logic', 'logical', 'fallacy', '순환논리 탐지', 'A→B→A 형태의 순환적 지지 발생 빈도', 'binary', 1.5),
  ('ls_hasty_generalization', 'logical', 'fallacy', '성급한 일반화', '부분에서 전체로의 비약적 일반화', 'binary', 1.3),
  ('ls_hidden_assumption', 'logical', 'hidden_assumption', '숨겨진 가정 탐지율', '미명시된 가정을 학생이 인지하는 비율', 'ratio', 1.4),
  ('ls_synthesis_quality', 'logical', 'synthesis', '종합 품질', '다중 논점을 통합하는 능력', 'rubric', 1.0),
     ('dl_evidence_density', 'data', 'evidence_usage', '근거 밀도', '턴당 텍스트 근거 인용 비율', 'ratio', 1.5),
  ('dl_citation_specificity', 'data', 'evidence_usage', '인용 구체성', '구절/페이지 수준의 구체적 인용', 'rubric', 1.2),
  ('dl_causal_distinction', 'data', 'causal_caution', '상관-인과 구분', '상관관계와 인과관계를 올바르게 구분', 'binary', 1.4),
  ('dl_uncertainty_marking', 'data', 'uncertainty', '불확실성 표기', '주장의 확실성 수준을 명시적으로 표현', 'binary', 1.0),
  ('dl_bias_awareness', 'data', 'bias', '데이터 편향 인지', '자기 편향이나 선택적 데이터 사용 인지', 'rubric', 1.3),
  ('dl_quant_reasoning', 'data', 'quant_reasoning', '정량적 추론', '수치/통계를 활용한 논증', 'ratio', 0.8),
     ('cf_revision_speed', 'flexibility', 'revision', '주장 수정 속도', '반례 제시 후 주장 수정까지의 턴 수', 'latency', 1.5),
  ('cf_counterexample_acceptance', 'flexibility', 'counterexample', '반례 수용도', '반례를 수용하고 통합하는 비율', 'ratio', 1.4),
  ('cf_openness_score', 'flexibility', 'openness', '개방성 지수', '새로운 관점에 대한 수용도', 'rubric', 1.2),
  ('cf_self_correction', 'flexibility', 'self_correction', '자기 교정', '스스로 오류를 발견하고 수정하는 빈도', 'count', 1.3),
  ('cf_defense_intensity', 'flexibility', 'defense_intensity', '방어적 태도 지수', '비합리적 방어 반응 빈도 (역수)', 'ratio', 1.1),
  ('cf_alternative_framing', 'flexibility', 'alternative_framing', '대안 프레임 생성', '동일 주제에 대한 대안 관점 제시', 'count', 1.0),
     ('bc_conclusion_first', 'communication', 'executive_clarity', '결론 선행', '결론→근거→상세 구조 준수율', 'binary', 1.3),
  ('bc_mece_compliance', 'communication', 'mece', 'MECE 여부', '중복/누락 없는 구조화 달성도', 'rubric', 1.2),
  ('bc_stakeholder_framing', 'communication', 'stakeholder', '이해관계자 구조화', '다수 이해관계자 관점 고려', 'rubric', 0.9),
  ('bc_tradeoff_explicit', 'communication', 'trade_off', '트레이드오프 명시', '의사결정의 장단점을 명시적으로 제시', 'binary', 1.1),
  ('bc_actionability', 'communication', 'actionability', '실행가능성', '주장이 구체적 행동으로 전환 가능한 정도', 'rubric', 1.0),
  ('bc_concision', 'communication', 'concision', '간결성', '군더더기 표현 비율 (역수)', 'ratio', 0.8);
