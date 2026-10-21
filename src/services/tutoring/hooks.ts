import type { TutorServiceHookRow } from '../../types/d1-rows';
import type { Bindings, CitationSource, TutorServiceHook } from '../../types';

export interface TutoringServiceHooksRepository {
  listHooks(db: Bindings['DB']): Promise<TutorServiceHook[]>;
  updateHook(db: Bindings['DB'], hookKey: string, enabled: boolean, configJson?: Record<string, any>): Promise<boolean>;
  appendSessionRetrievalTrace(db: Bindings['DB'], sessionId: string, trace: CitationSource[]): Promise<void>;
}

export const tutoringServiceHooksRepository: TutoringServiceHooksRepository = {
  async listHooks(db) {
    const res = await db.prepare('SELECT * FROM tutor_service_hooks ORDER BY hook_key ASC').all<TutorServiceHookRow>();
    return (res.results || []).map((row) => ({
      id: row.id,
      hookKey: row.hook_key,
      description: row.description || '',
      configJson: safeJsonParse<Record<string, unknown>>(row.config_json, {}),
      enabled: !!row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  },

  async updateHook(db, hookKey, enabled, configJson) {
    const now = Date.now();
    const result = await db.prepare(`
      UPDATE tutor_service_hooks
      SET enabled = ?2,
          config_json = COALESCE(?3, config_json),
          updated_at = ?4
      WHERE hook_key = ?1
    `).bind(hookKey, enabled ? 1 : 0, configJson ? JSON.stringify(configJson) : null, now).run();

    return !!result.meta?.changes;
  },

  async appendSessionRetrievalTrace(db, sessionId, trace) {
    const row = await db.prepare('SELECT retrieval_trace FROM sessions WHERE id = ?1').bind(sessionId).first<{ retrieval_trace: string }>();
    const previous = safeJsonParse<CitationSource[]>(row?.retrieval_trace, []);
    const merged = [...previous, ...trace].slice(-20);

    await db.prepare('UPDATE sessions SET retrieval_trace = ?2 WHERE id = ?1').bind(sessionId, JSON.stringify(merged)).run();
  },
};

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (e) { console.error("[P1-004] Caught:", e);
    return fallback;
  }
}
