export class TrainingHistorySupplementError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

type ReadStatus = 'AVAILABLE' | 'PENDING' | 'UNAVAILABLE';

type ControlRow = {
  id: string;
  revision: number;
  action: 'HELP' | 'PAUSE' | 'RESUME' | 'STOP';
  reason: string;
  origin: 'LEARNER' | 'POLICY';
  created_at: number;
};

type SupportRow = ControlRow & {
  prior_turn_id: number | null;
  support_created_at: number | null;
  response: string | null;
  source_ids_json: string | null;
  prior_turn_number: number | null;
  answer_turn_id: number | null;
  answer_turn_number: number | null;
};

type RevisionRow = {
  id: string;
  revision_number: number;
  prior_turn_id: number;
  prior_turn_number: number;
  prior_statement: string;
  revised_statement: string;
  explanation: string;
  source_ids_json: string;
  created_at: number;
  consumed_turn_id: number | null;
  consumed_turn_number: number | null;
};

type SourceSnapshotRow = {
  source_id: string;
  book_id: string;
  book_title: string;
  book_author: string;
  chunk_id: string;
  chunk_index: number;
  excerpt: string;
  content_sha256: string;
};

type QueryResult<T> = { results?: T[]; success?: boolean };

function sourceIds(value: string | null): string[] {
  const parsed: unknown = JSON.parse(value || '[]');
  if (!Array.isArray(parsed) || parsed.some(id => typeof id !== 'string' || !id)) throw new Error('TRAINING_HISTORY_SOURCE_IDS_INVALID');
  return parsed;
}

async function rows<T>(db: D1Database, sql: string, ...values: unknown[]): Promise<T[]> {
  const result = await db.prepare(sql).bind(...values).all<T>() as QueryResult<T>;
  if (result.success === false) throw new Error('TRAINING_HISTORY_READ_FAILED');
  return result.results || [];
}

function unavailable<T>(records: T[] = []) { return { status: 'UNAVAILABLE' as const, records }; }

export async function readOwnedTrainingHistorySupplements(db: D1Database, owner: string, sessionId: string) {
  const session = await db.prepare('SELECT id, is_completed FROM training_sessions WHERE id=?1 AND user_id=?2').bind(sessionId, owner).first<{ id: string; is_completed: number }>();
  if (!session) throw new TrainingHistorySupplementError(404, 'TRAINING_HISTORY_NOT_FOUND');

  const [controlsRead, supportRead, revisionsRead] = await Promise.allSettled([
    rows<ControlRow>(db, `SELECT id, revision, action, reason, origin, created_at
      FROM training_interventions WHERE session_id=?1 AND owner_user_id=?2 ORDER BY revision ASC`, sessionId, owner),
    rows<SupportRow>(db, `SELECT e.id, e.revision, e.action, e.reason, e.origin, e.prior_turn_id, e.created_at,
      r.created_at AS support_created_at, r.response, r.source_ids_json,
      prior.turn_number AS prior_turn_number,
      answer.id AS answer_turn_id, answer.turn_number AS answer_turn_number
      FROM training_interventions e
      LEFT JOIN training_support_responses r ON r.intervention_id=e.id AND r.session_id=e.session_id
      LEFT JOIN training_turns prior ON prior.id=e.prior_turn_id AND prior.session_id=e.session_id
      LEFT JOIN training_turns answer ON answer.id=(
        SELECT candidate.id FROM training_turns candidate
        WHERE candidate.session_id=e.session_id AND candidate.intervention_revision=e.revision
        ORDER BY candidate.turn_number ASC, candidate.id ASC LIMIT 1
      )
      WHERE e.session_id=?1 AND e.owner_user_id=?2 AND e.action='HELP' ORDER BY e.revision ASC`, sessionId, owner),
    rows<RevisionRow>(db, `SELECT e.id, e.revision_number, e.prior_turn_id, e.prior_turn_number, e.prior_statement,
      e.revised_statement, e.explanation, e.source_ids_json, e.created_at,
      consumed.id AS consumed_turn_id, consumed.turn_number AS consumed_turn_number
      FROM training_learner_revision_events e
      LEFT JOIN training_turns consumed ON consumed.learner_revision_event_id=e.id AND consumed.session_id=e.session_id
      WHERE e.session_id=?1 AND e.owner_user_id=?2 ORDER BY e.revision_number ASC`, sessionId, owner),
  ]);

  const controls = controlsRead.status === 'fulfilled'
    ? { status: 'AVAILABLE' as const, state: session.is_completed ? 'COMPLETED' : controlsRead.value.at(-1)?.action === 'STOP' ? 'STOPPED' : controlsRead.value.at(-1)?.action === 'PAUSE' ? 'PAUSED' : 'ACTIVE', records: controlsRead.value.map(row => ({ action: row.action, reason: row.reason, origin: row.origin, revision: row.revision, timestamp: row.created_at })) }
    : unavailable();

  let support: { status: ReadStatus; records: Array<Record<string, unknown>> };
  if (supportRead.status !== 'fulfilled') {
    support = unavailable();
  } else {
    try {
      const committed = supportRead.value.filter(row => typeof row.response === 'string' && row.support_created_at !== null);
      const neededSourceIds = [...new Set(committed.flatMap(row => sourceIds(row.source_ids_json)))];
      const snapshots = neededSourceIds.length === 0 ? [] : await rows<SourceSnapshotRow>(db, `SELECT source_id, book_id, book_title, book_author, chunk_id, chunk_index, excerpt, content_sha256
        FROM training_scenario_evidence WHERE session_id=?1 ORDER BY selection_index ASC`, sessionId);
      const snapshotsById = new Map(snapshots.map(snapshot => [snapshot.source_id, snapshot]));
      support = {
        status: supportRead.value.some(row => row.response === null) ? 'PENDING' : 'AVAILABLE',
        records: committed.map(row => {
          const ids = sourceIds(row.source_ids_json);
          if (ids.some(id => !snapshotsById.has(id))) throw new Error('TRAINING_HISTORY_SOURCE_SNAPSHOT_UNAVAILABLE');
          return {
            interventionId: row.id,
            priorTurn: row.prior_turn_id === null || row.prior_turn_number === null ? null : { id: row.prior_turn_id, turnNumber: row.prior_turn_number },
            answerTurn: row.answer_turn_id === null || row.answer_turn_number === null ? null : { id: row.answer_turn_id, turnNumber: row.answer_turn_number },
            createdAt: row.support_created_at,
            response: row.response,
            graded: false,
            deliveryValidation: 'UNKNOWN',
            readingValidation: 'UNKNOWN',
            sourceIds: ids,
            sourceSnapshots: ids.map(id => {
              const snapshot = snapshotsById.get(id)!;
              return { sourceId: snapshot.source_id, bookId: snapshot.book_id, bookTitle: snapshot.book_title, bookAuthor: snapshot.book_author, chunkId: snapshot.chunk_id, chunkIndex: snapshot.chunk_index, excerpt: snapshot.excerpt, contentSha256: snapshot.content_sha256 };
            }),
          };
        }),
      };
    } catch {
      support = unavailable();
    }
  }

  let revisions: { status: 'AVAILABLE' | 'UNAVAILABLE'; explicitDefenseStatus: 'NOT_RECORDED' | 'UNAVAILABLE'; records: unknown[] };
  if (revisionsRead.status !== 'fulfilled') {
    revisions = { ...unavailable(), explicitDefenseStatus: 'UNAVAILABLE' };
  } else {
    try {
      revisions = {
        status: 'AVAILABLE',
        explicitDefenseStatus: 'NOT_RECORDED',
        records: revisionsRead.value.map(row => ({
          revision: row.revision_number,
          priorTurn: { id: row.prior_turn_id, turnNumber: row.prior_turn_number },
          priorStatement: row.prior_statement,
          revisedStatement: row.revised_statement,
          explanation: row.explanation,
          sourceIds: sourceIds(row.source_ids_json),
          createdAt: row.created_at,
          validationStatus: 'UNVERIFIED' as const,
          consumedFollowUpTurn: row.consumed_turn_id === null || row.consumed_turn_number === null ? null : { id: row.consumed_turn_id, turnNumber: row.consumed_turn_number },
        })),
      };
    } catch {
      revisions = { ...unavailable(), explicitDefenseStatus: 'UNAVAILABLE' };
    }
  }

  return {
    status: controls.status === 'UNAVAILABLE' || support.status === 'UNAVAILABLE' || revisions.status === 'UNAVAILABLE' ? 'UNAVAILABLE' as const : 'AVAILABLE' as const,
    controls,
    support,
    revisions,
  };
}
