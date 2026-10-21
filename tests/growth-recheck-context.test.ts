import { describe, expect, it } from 'vitest';
import { createMigratedLearningDatabase } from './fixtures/learning-engine-db';
import { createSession } from '../src/services/student-model';
import { persistSparringEvidence } from '../src/services/library-retrieval';
import { createGrowthLabSparringContext } from '../src/services/learning-session-context';
import { sha256Hex } from '../src/services/library-ingestion';
import { compareRecheckContexts } from '../src/services/growth-recheck-context';

describe('Sparring recheck source context', () => {
  it('distinguishes unchanged source content from a new manifest without claiming transfer', async () => {
    const { sqlite, db } = createMigratedLearningDatabase();
    try {
      sqlite.exec("INSERT INTO users(id,username,email,password_hash) VALUES('owner','owner','owner@example.test','fixture'); INSERT INTO books(id,title,author,text,visibility,owner_user_id,lifecycle_status) VALUES('book','Book','Author','Source','private','owner','active')");
      let sequence = 0;
      const add = async (content: string, createdAt: number) => {
        const session = await createSession(db, 'book', 'Book', '', 'Topic', 'Claim', 'owner');
        const chunkId = 'chunk-' + sequence++;
        sqlite.prepare('INSERT INTO document_chunks(id,book_id,chunk_index,content) VALUES(?,?,?,?)').run(chunkId, 'book', sequence, content);
        const opening = await persistSparringEvidence(db, { sessionId: session.id, turnNumber: 0, userId: 'owner', bookId: 'book', query: 'Evidence',
          chunks: [{ chunkId, bookId: 'book', bookTitle: 'Book', bookAuthor: 'Author', lifecycleStatus: 'active', chunkIndex: sequence,
            charStart: 0, charEnd: content.length, content, contentSha256: await sha256Hex(content), relevanceScore: 1 }] });
        await createGrowthLabSparringContext({ db, sessionId: session.id, ownerUserId: 'owner', subjectId: 'owner', authorityCapabilities: ['learning'],
          contextPolicyRevision: 'fixture-v1', corpusBindingId: 'book:book', corpusManifestRevision: opening.manifestSha256,
          routes: { interactive_generation: ['ssu-luna'], learner_evaluation: ['deepseek-v4-pro'], release_critic: ['deepseek-v4-flash'], background_reasoning: ['deepseek-v4-pro'] },
          promptCacheNamespace: 'fixture:' + session.id, evidencePolicyRevision: 'fixture-v1', now: createdAt });
        return session.id;
      };
      const baseline = await add('Same source passage', 1000);
      const repeated = await add('Same source passage', 2000);
      const changed = await add('A passage with a different causal condition', 2001);
      const input = { owner: 'owner', kind: 'SPARRING' as const, baselineSessionId: baseline, scheduledFor: 1500, recordedAt: 3000 };
      await expect(compareRecheckContexts(db, { ...input, followUpSessionId: repeated })).resolves.toMatchObject({ status: 'SAME_EVIDENCE_CONTENT', semanticValidation: 'UNKNOWN' });
      const comparison = await compareRecheckContexts(db, { ...input, followUpSessionId: changed });
      expect(comparison).toMatchObject({ status: 'DISTINCT_EVIDENCE_CONTENT', semanticValidation: 'UNKNOWN' });
      expect(comparison.baseline.contentFingerprint).not.toBe(comparison.followUp.contentFingerprint);
      await expect(compareRecheckContexts(db, { ...input, owner: 'foreign', followUpSessionId: changed })).rejects.toMatchObject({ code: 'GROWTH_RECHECK_CONTEXT_UNAVAILABLE' });
      await expect(compareRecheckContexts(db, { ...input, followUpSessionId: baseline })).rejects.toMatchObject({ code: 'GROWTH_RECHECK_NEW_ATTEMPT_REQUIRED' });
      await expect(compareRecheckContexts(db, { ...input, scheduledFor: 2500, followUpSessionId: changed })).rejects.toMatchObject({ code: 'GROWTH_RECHECK_FOLLOW_UP_STARTED_TOO_EARLY' });
    } finally { sqlite.close(); }
  });
});
