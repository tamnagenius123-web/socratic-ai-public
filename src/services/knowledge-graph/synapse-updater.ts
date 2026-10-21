// SocraticAI v35 — Synapse Weight Updater (EMA-based)
// Task: T1.2.1 뉴럴 위키 노드 스키마 확장 + 시냅스 동적 업데이트
// 시냅스(엣지) 가중치를 EMA 공식으로 업데이트: new_weight = old_weight * 0.7 + normalized_signal * 0.3

export interface SynapseSignals {
  answerSpeedMs: number;        // 답변 속도 (ms)
  metaphorDensity: number;      // 은유 밀도 (0~1)
  counterQuestionDepth: number; // 반질문 깊이 (0~3)
}

export interface SynapseUpdateResult {
  userId: string;
  fromNodeId: string;
  toNodeId: string;
  oldWeight: number | null;
  newWeight: number;
  signal: {
    speedComponent: number;       // sigmoid((15000 - ms) / 10000)
    metaphorComponent: number;    // metaphorDensity (0~1)
    counterComponent: number;     // counterQuestionDepth / 3
    normalizedSignal: number;     // weighted average
  };
}

/**
 * 속도 신호를 정규화합니다.
 * - 빠를수록(15초 이상 빠르면) 강화
 * - 느리면(30초 이상) 약화
 * @param answerSpeedMs 답변 시간 (밀리초)
 * @returns 0~1 범위의 신호값
 */
export function computeSpeedSignal(answerSpeedMs: number): number {
  // Sigmoid: (15000 - answerSpeedMs) / 10000
  // 15초 (15000ms) = 0.5
  // 5초 (5000ms) = 0.9
  // 25초 (25000ms) = 0.1
  const normalized = (15000 - answerSpeedMs) / 10000;
  return 1 / (1 + Math.exp(-normalized));
}

/**
 * 반질문 깊이를 정규화합니다.
 * @param counterQuestionDepth 0~3 범위
 * @returns 0~1 범위의 신호값
 */
export function computeCounterComponent(counterQuestionDepth: number): number {
  const clamped = Math.max(0, Math.min(3, counterQuestionDepth));
  return clamped / 3;
}

/**
 * 세 신호를 가중 평균으로 결합합니다.
 * - speed: 0.3
 * - metaphor: 0.4
 * - counter: 0.3
 */
export function normalizeSignals(
  speedComponent: number,
  metaphorComponent: number,
  counterComponent: number,
): number {
  const weighted =
    speedComponent * 0.3 +
    metaphorComponent * 0.4 +
    counterComponent * 0.3;

  // 최종 0~1 범위 보장
  return Math.max(0, Math.min(1, weighted));
}

/**
 * EMA 공식으로 시냅스 가중치를 업데이트합니다.
 * new_weight = old_weight * 0.7 + normalized_signal * 0.3
 *
 * @param oldWeight 기존 가중치 (0~1)
 * @param signals 답변 속도, 은유 밀도, 반질문 깊이
 * @returns 업데이트된 가중치
 */
export function updateSynapseWeight(oldWeight: number, signals: SynapseSignals): SynapseUpdateResult['signal'] {
  // 각 신호 성분 계산
  const speedComponent = computeSpeedSignal(signals.answerSpeedMs);
  const metaphorComponent = Math.max(0, Math.min(1, signals.metaphorDensity));
  const counterComponent = computeCounterComponent(signals.counterQuestionDepth);

  // 정규화된 신호
  const normalizedSignal = normalizeSignals(
    speedComponent,
    metaphorComponent,
    counterComponent,
  );

  return {
    speedComponent,
    metaphorComponent,
    counterComponent,
    normalizedSignal,
  };
}

/**
 * EMA 가중치 계산: new_weight = old_weight * 0.7 + signal * 0.3
 */
export function computeEMAWeight(oldWeight: number, normalizedSignal: number): number {
  const newWeight = oldWeight * 0.7 + normalizedSignal * 0.3;
  return Math.max(0, Math.min(1, newWeight));
}

/**
 * 전체 시냅스 업데이트 로직
 * 데이터베이스에서 기존 가중치를 조회하고, 신호로 업데이트한 후 반환합니다.
 */
export async function updateSynapseInDatabase(
  db: D1Database,
  userId: string,
  fromNodeId: string,
  toNodeId: string,
  signals: SynapseSignals,
  sessionId?: string,
  event?: SynapseEventContext,
): Promise<SynapseUpdateResult> {
  const nodes = await db.prepare(`
    SELECT source.domain_id AS domain_id
    FROM knowledge_nodes source
    INNER JOIN knowledge_nodes target ON target.id = ?2
    WHERE source.id = ?1 AND source.domain_id = target.domain_id
  `).bind(fromNodeId, toNodeId).first<{ domain_id: string }>();
  if (!nodes) throw new Error('Synapse nodes must exist in the same domain');

  const existing = await db.prepare(`
    SELECT synapse_weight FROM user_knowledge_synapses
    WHERE user_id = ?1 AND domain_id = ?2 AND from_node_id = ?3 AND to_node_id = ?4
  `).bind(userId, nodes.domain_id, fromNodeId, toNodeId).first<{ synapse_weight: number }>();
  const oldWeight = existing?.synapse_weight ?? null;
  const signalResult = updateSynapseWeight(0, signals);
  const newWeight = oldWeight === null
    ? signalResult.normalizedSignal
    : computeEMAWeight(oldWeight, signalResult.normalizedSignal);
  const now = Date.now();

  if (event) {
    const eventExists = await db.prepare(`
      SELECT id FROM user_knowledge_synapse_events WHERE taiji_action_id = ?1 LIMIT 1
    `).bind(event.taijiActionId).first<{ id: string }>();
    if (eventExists) return { userId, fromNodeId, toNodeId, oldWeight, newWeight: oldWeight ?? newWeight, signal: signalResult };
    await db.batch([
      db.prepare(`
        UPDATE user_knowledge_synapses
        SET synapse_weight = ?5, evidence_count = evidence_count + 1, last_session_id = ?6, updated_at = ?7
        WHERE user_id = ?1 AND domain_id = ?2 AND from_node_id = ?3 AND to_node_id = ?4
          AND NOT EXISTS (SELECT 1 FROM user_knowledge_synapse_events WHERE taiji_action_id = ?8)
      `).bind(userId, nodes.domain_id, fromNodeId, toNodeId, newWeight, sessionId ?? null, now, event.taijiActionId),
      db.prepare(`
        INSERT INTO user_knowledge_synapses (
          user_id, domain_id, from_node_id, to_node_id, synapse_weight, evidence_count, last_session_id, updated_at
        ) SELECT ?1, ?2, ?3, ?4, ?5, 1, ?6, ?7
        WHERE NOT EXISTS (
          SELECT 1 FROM user_knowledge_synapses
          WHERE user_id = ?1 AND domain_id = ?2 AND from_node_id = ?3 AND to_node_id = ?4
        ) AND NOT EXISTS (SELECT 1 FROM user_knowledge_synapse_events WHERE taiji_action_id = ?8)
      `).bind(userId, nodes.domain_id, fromNodeId, toNodeId, newWeight, sessionId ?? null, now, event.taijiActionId),
      db.prepare(`
      INSERT OR IGNORE INTO user_knowledge_synapse_events (
        id, user_id, taiji_action_id, domain_id, from_node_id, to_node_id, old_weight, new_weight, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `).bind(event.eventId, userId, event.taijiActionId, nodes.domain_id, fromNodeId, toNodeId, oldWeight, newWeight, now),
    ]);
  } else {
    await db.prepare(`
      INSERT INTO user_knowledge_synapses (
        user_id, domain_id, from_node_id, to_node_id, synapse_weight, evidence_count, last_session_id, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)
      ON CONFLICT(user_id, domain_id, from_node_id, to_node_id) DO UPDATE SET
        synapse_weight = excluded.synapse_weight,
        evidence_count = user_knowledge_synapses.evidence_count + 1,
        last_session_id = excluded.last_session_id,
        updated_at = excluded.updated_at
    `).bind(userId, nodes.domain_id, fromNodeId, toNodeId, newWeight, sessionId ?? null, now).run();
  }

  return {
    userId,
    fromNodeId,
    toNodeId,
    oldWeight,
    newWeight,
    signal: signalResult,
  };
}

/** Records Taiji's explicit reinforcement policy without inventing learner metrics. */
export async function recordTaijiSynapseReinforcement(
  db: D1Database,
  userId: string,
  fromNodeId: string,
  toNodeId: string,
  sessionId: string,
  event: SynapseEventContext,
): Promise<void> {
  const alreadyRecorded = await db.prepare(`
    SELECT id FROM user_knowledge_synapse_events WHERE taiji_action_id = ?1 LIMIT 1
  `).bind(event.taijiActionId).first<{ id: string }>();
  if (alreadyRecorded) return;
  const node = await db.prepare(`
    SELECT source.domain_id AS domain_id FROM knowledge_nodes source
    INNER JOIN knowledge_nodes target ON target.id = ?2
    WHERE source.id = ?1 AND source.domain_id = target.domain_id
  `).bind(fromNodeId, toNodeId).first<{ domain_id: string }>();
  if (!node) throw new Error('Synapse nodes must exist in the same domain');
  const existing = await db.prepare(`
    SELECT synapse_weight FROM user_knowledge_synapses
    WHERE user_id = ?1 AND domain_id = ?2 AND from_node_id = ?3 AND to_node_id = ?4
  `).bind(userId, node.domain_id, fromNodeId, toNodeId).first<{ synapse_weight: number }>();
  const oldWeight = existing?.synapse_weight ?? null;
  const newWeight = Math.min((oldWeight ?? 0) + 0.15, 1);
  const now = Date.now();
  await db.batch([
    db.prepare(`
      UPDATE user_knowledge_synapses
      SET synapse_weight = ?5, evidence_count = evidence_count + 1, last_session_id = ?6, updated_at = ?7
      WHERE user_id = ?1 AND domain_id = ?2 AND from_node_id = ?3 AND to_node_id = ?4
        AND NOT EXISTS (SELECT 1 FROM user_knowledge_synapse_events WHERE taiji_action_id = ?8)
    `).bind(userId, node.domain_id, fromNodeId, toNodeId, newWeight, sessionId, now, event.taijiActionId),
    db.prepare(`
      INSERT INTO user_knowledge_synapses (user_id, domain_id, from_node_id, to_node_id, synapse_weight, evidence_count, last_session_id, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?5, 1, ?6, ?7
      WHERE NOT EXISTS (
        SELECT 1 FROM user_knowledge_synapses
        WHERE user_id = ?1 AND domain_id = ?2 AND from_node_id = ?3 AND to_node_id = ?4
      ) AND NOT EXISTS (SELECT 1 FROM user_knowledge_synapse_events WHERE taiji_action_id = ?8)
    `).bind(userId, node.domain_id, fromNodeId, toNodeId, newWeight, sessionId, now, event.taijiActionId),
    db.prepare(`
      INSERT OR IGNORE INTO user_knowledge_synapse_events (
        id, user_id, taiji_action_id, domain_id, from_node_id, to_node_id, old_weight, new_weight, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).bind(event.eventId, userId, event.taijiActionId, node.domain_id, fromNodeId, toNodeId, oldWeight, newWeight, now),
  ]);
}

export interface SynapseEventContext {
  eventId: string;
  taijiActionId: string;
}
