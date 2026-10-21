import { GrowthServiceError } from './growth-cycle-types';
import { sha256Hex } from './library-ingestion';

export const SPARRING_EVIDENCE_TOP_K = 3;

export type LibraryEvidenceChunk = {
  chunkId: string;
  bookId: string;
  bookTitle: string | null;
  bookAuthor: string | null;
  lifecycleStatus: 'active' | 'quarantined' | 'deleted' | null;
  chunkIndex: number;
  charStart: number | null;
  charEnd: number | null;
  content: string;
  contentSha256: string;
  relevanceScore: number;
};

function queryTokens(query: string): string[] {
  return [...new Set(
    query.toLowerCase().replace(/[^\w가-힣]/g, ' ').split(/\s+/).filter((token) => token.length >= 2),
  )];
}

function relevance(content: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const normalized = content.toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    let offset = 0;
    while ((offset = normalized.indexOf(token, offset)) !== -1) {
      hits += 1;
      offset += token.length;
    }
  }
  return hits / Math.max(1, content.length / 100);
}

export async function retrieveLibraryChunks(
  db: D1Database,
  bookId: string,
  query: string,
  requesterUserId: string,
  topK: number = SPARRING_EVIDENCE_TOP_K,
): Promise<LibraryEvidenceChunk[]> {
  const rows = await db.prepare(`
    SELECT dc.id, dc.book_id, dc.chunk_index, dc.content, dc.char_start, dc.char_end,
           b.title AS book_title, b.author AS book_author, b.lifecycle_status, b.visibility
    FROM document_chunks dc
    INNER JOIN books b ON b.id = dc.book_id
    WHERE dc.book_id = ?1 AND b.lifecycle_status = 'active'
      AND ((b.is_builtin = 1 AND b.visibility = 'builtin') OR (b.visibility = 'private' AND b.owner_user_id = ?2))
    ORDER BY chunk_index ASC
  `).bind(bookId, requesterUserId).all<{
    id: string;
    book_id: string;
    chunk_index: number;
    content: string;
    char_start: number | null;
    char_end: number | null;
    book_title: string | null;
    book_author: string | null;
    lifecycle_status: string | null;
    visibility: string | null;
  }>();
  const tokens = queryTokens(query);
  const ranked = (rows.results || [])
    .map((row) => ({ row, score: relevance(row.content, tokens) }))
    .sort((a, b) => b.score - a.score || a.row.chunk_index - b.row.chunk_index)
    .slice(0, Math.max(1, Math.min(8, topK)))
    .sort((a, b) => a.row.chunk_index - b.row.chunk_index);

  return Promise.all(ranked.map(async ({ row, score }) => ({
    chunkId: row.id,
    bookId: row.book_id,
    bookTitle: row.book_title || null,
    bookAuthor: row.book_author || null,
    lifecycleStatus: row.lifecycle_status === 'deleted' ? 'deleted' : row.visibility === 'quarantined' ? 'quarantined' : row.lifecycle_status === 'active' ? 'active' : null,
    chunkIndex: Number(row.chunk_index),
    charStart: row.char_start === null ? null : Number(row.char_start),
    charEnd: row.char_end === null ? null : Number(row.char_end),
    content: row.content,
    contentSha256: await sha256Hex(row.content),
    relevanceScore: score,
  })));
}

export async function requireSparringSource(db:D1Database,bookId:string,owner:string){
 const allowed=await db.prepare(`SELECT id FROM books WHERE id=?1 AND lifecycle_status='active'
  AND ((is_builtin=1 AND visibility='builtin') OR (visibility='private' AND owner_user_id=?2))`)
  .bind(bookId,owner).first<{id:string}>();
 if(!allowed)throw new GrowthServiceError({status:409,code:'SPARRING_SOURCE_UNAVAILABLE',phase:'evidence',retryable:false});
}

export function renderLibraryEvidence(chunks: LibraryEvidenceChunk[]): string {
  return chunks.map((chunk) => [
    `[source_id=${chunk.chunkId}; chars=${chunk.charStart ?? '?'}-${chunk.charEnd ?? '?'}]`,
    chunk.content.trim(),
  ].join('\n')).join('\n\n---\n\n');
}

export async function prepareSparringEvidence(
  db: D1Database,
  input: {
    sessionId: string;
    turnNumber: number;
    userId: string;
    bookId: string;
    query: string;
    chunks: LibraryEvidenceChunk[];
  },
): Promise<{ manifestId: string; manifestSha256: string; statements: D1PreparedStatement[] }> {
  const manifestId = `spmanifest_${crypto.randomUUID()}`;
  const manifestSha256 = await sha256Hex(JSON.stringify({
    sessionId: input.sessionId,
    turnNumber: input.turnNumber,
    bookId: input.bookId,
    query: input.query,
    sources: input.chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      chunkIndex: chunk.chunkIndex,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      contentSha256: chunk.contentSha256,
    })),
  }));
  const existing = await db.prepare(`
    SELECT id, manifest_sha256
    FROM sparring_evidence_manifests
    WHERE session_id = ?1 AND turn_number = ?2
  `).bind(input.sessionId, input.turnNumber).first<{
    id: string;
    manifest_sha256: string;
  }>();
  if (existing) {
    if (existing.manifest_sha256 === manifestSha256) {
      return { manifestId: existing.id, manifestSha256, statements: [] };
    }
    throw new Error('sparring_evidence_conflict');
  }
  const now = Date.now();
  const statements = [
    db.prepare(`
      INSERT INTO sparring_evidence_manifests (
        id, session_id, turn_number, user_id, book_id, query_text,
        manifest_sha256, source_count, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).bind(
      manifestId,
      input.sessionId,
      input.turnNumber,
      input.userId,
      input.bookId,
      input.query.substring(0, 1000),
      manifestSha256,
      input.chunks.length,
      now,
    ),
    ...input.chunks.map((chunk) => db.prepare(`
      INSERT INTO sparring_turn_evidence (
        id, manifest_id, session_id, turn_number, book_id, chunk_id,
        chunk_index, char_start, char_end, content_snapshot, content_sha256,
        source_id, book_title, book_author,
        relevance_score, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
    `).bind(
      `spevidence_${crypto.randomUUID()}`,
      manifestId,
      input.sessionId,
      input.turnNumber,
      input.bookId,
      chunk.chunkId,
      chunk.chunkIndex,
      chunk.charStart,
      chunk.charEnd,
      chunk.content,
      chunk.contentSha256,
      chunk.chunkId,
      chunk.bookTitle,
      chunk.bookAuthor,
      chunk.relevanceScore,
      now,
    )),
  ];
  return { manifestId, manifestSha256, statements };
}

export async function persistSparringEvidence(db:D1Database,input:Parameters<typeof prepareSparringEvidence>[1]){
 const prepared=await prepareSparringEvidence(db,input);
 if(prepared.statements.length)await db.batch(prepared.statements);
 return {manifestId:prepared.manifestId,manifestSha256:prepared.manifestSha256};
}
