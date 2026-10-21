type Counts={pendingRevisionSessions:number;declaredRevisions:number;acceptedRevisionFollowUps:number;savedSupportResponses:number;supportReferencedRevisions:number};
export type SparringLearningEvidenceMetrics={
 status:'AVAILABLE'|'UNAVAILABLE';scope:'SPARRING_EXPLICIT_RECORDS';historicalCoverage:'UNKNOWN';learningEffect:'UNKNOWN';
 pendingRevisionSessions:number|null;declaredRevisions:number|null;acceptedRevisionFollowUps:number|null;savedSupportResponses:number|null;supportReferencedRevisions:number|null;
};

// Counts describe attributable records. Neither sequence nor score change proves
// causal benefit, mastery, delivery, or complete coverage of legacy sessions.
export async function readSparringLearningEvidenceMetrics(db:D1Database):Promise<SparringLearningEvidenceMetrics>{
 const base={scope:'SPARRING_EXPLICIT_RECORDS',historicalCoverage:'UNKNOWN',learningEffect:'UNKNOWN'} as const;
 try{
  const row=await db.prepare(`SELECT /* SPARRING_LEARNING_EVIDENCE_COUNTS */
   (SELECT COUNT(*) FROM sparring_learner_revisions r JOIN sessions s ON s.id=r.session_id AND s.user_id=r.owner_user_id) AS declaredRevisions,
   (SELECT COUNT(DISTINCT r.id) FROM sparring_learner_revisions r JOIN sessions s ON s.id=r.session_id AND s.user_id=r.owner_user_id
    JOIN messages m ON m.sparring_revision_id=r.id AND m.session_id=s.id AND m.role='user'
    JOIN evaluations e ON e.session_id=s.id AND e.user_id=s.user_id AND e.turn=m.turn) AS acceptedRevisionFollowUps,
   (SELECT COUNT(*) FROM sparring_learner_revisions r JOIN sessions s ON s.id=r.session_id AND s.user_id=r.owner_user_id
    WHERE r.revision=(SELECT MAX(revision) FROM sparring_learner_revisions WHERE session_id=s.id)
     AND NOT EXISTS(SELECT 1 FROM messages WHERE session_id=s.id AND role='user' AND sparring_revision_id=r.id)) AS pendingRevisionSessions,
   (SELECT COUNT(*) FROM sparring_hint_responses h JOIN sessions s ON s.id=h.session_id AND s.user_id=h.owner_user_id) AS savedSupportResponses,
   (SELECT COUNT(*) FROM sparring_learner_revisions r JOIN sessions s ON s.id=r.session_id AND s.user_id=r.owner_user_id
    JOIN sparring_hint_responses h ON h.id=r.support_id AND h.session_id=s.id AND h.owner_user_id=s.user_id) AS supportReferencedRevisions
  `).first<Counts>();
  if(!row||Object.values(row).length!==5||Object.values(row).some(value=>!Number.isSafeInteger(value)||value<0))throw new Error('Learning record counts unavailable');
  return {...base,status:'AVAILABLE',...row};
 }catch{
  return {...base,status:'UNAVAILABLE',pendingRevisionSessions:null,declaredRevisions:null,acceptedRevisionFollowUps:null,savedSupportResponses:null,supportReferencedRevisions:null};
 }
}
