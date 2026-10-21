import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectFollowUpProtocol } from '../src/services/growth-follow-up-protocol';

describe('additive follow-up declaration migration', () => {
  it('keeps historical Sparring launches at totals-only when the record-index migration is applied', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("CREATE TABLE growth_recheck_sparring_follow_up_launches(id TEXT PRIMARY KEY); INSERT INTO growth_recheck_sparring_follow_up_launches VALUES('old'); CREATE TABLE growth_recheck_sparring_follow_up_bindings(launch_id TEXT,session_id TEXT,context_id TEXT); CREATE TRIGGER growth_sparring_follow_up_binding_delete BEFORE DELETE ON growth_recheck_sparring_follow_up_bindings BEGIN SELECT RAISE(ABORT,'old guard'); END;");
      db.exec(readFileSync(new URL('../migrations/0078_sparring_assistance_record_index.sql',import.meta.url),'utf8'));
      expect(db.prepare('SELECT * FROM growth_recheck_sparring_follow_up_launches').get()).toEqual({id:'old',assistance_capture_revision:'sparring-session-totals-v1'});
      expect(()=>db.exec("INSERT INTO growth_recheck_sparring_follow_up_launches VALUES('new','invented')")).toThrow('CHECK constraint failed');
      const declaration={protocol_revision:'growth-follow-up-local-v1',assistance_policy_revision:'sparring-assistance-capture-v1',created_at:100,changed_condition:'Changed context'};
      expect(projectFollowUpProtocol(declaration,'SPARRING')).toMatchObject({assistanceLogPolicy:{recordRevision:'sparring-session-totals-v1'}});
      expect(projectFollowUpProtocol({...declaration,assistance_capture_revision:'sparring-record-index-v2'},'SPARRING')).toMatchObject({assistanceLogPolicy:{recordRevision:'sparring-record-index-v2'}});
      expect(projectFollowUpProtocol({...declaration,assistance_capture_revision:'invented'},'SPARRING')).toMatchObject({status:'UNAVAILABLE'});
    } finally {db.close();}
  });
  it('does not retroactively predeclare old launches and requires explicit supported revisions for new rows', () => {
    const db = new DatabaseSync(':memory:');
    try {
      // Minimal historical table projection tests the additive DDL independently;
      // production-entrypoint HTTP tests cover the complete migration chain/guards.
      db.exec("CREATE TABLE growth_recheck_follow_up_launches (id TEXT PRIMARY KEY, changed_condition TEXT, created_at INTEGER); INSERT INTO growth_recheck_follow_up_launches VALUES ('old', 'A prior learner condition', 100);");
      db.exec(readFileSync(new URL('../migrations/0070_growth_follow_up_protocol.sql', import.meta.url), 'utf8'));
      expect(db.prepare('SELECT * FROM growth_recheck_follow_up_launches WHERE id=?').get('old')).toEqual({ id: 'old', changed_condition: 'A prior learner condition', created_at: 100, protocol_revision: null, assistance_policy_revision: null });
      expect(projectFollowUpProtocol({ changed_condition: 'A prior learner condition', created_at: 100, protocol_revision: null, assistance_policy_revision: null })).toMatchObject({ status: 'NOT_PREDECLARED', outcome: 'UNKNOWN' });
      expect(() => db.exec("INSERT INTO growth_recheck_follow_up_launches (id,changed_condition,created_at) VALUES ('new','A new condition',200)")).toThrow('GROWTH_FOLLOW_UP_PROTOCOL_REQUIRED');
      expect(() => db.exec("INSERT INTO growth_recheck_follow_up_launches VALUES ('new','A new condition',200,'invented','training-assistance-capture-v1')")).toThrow('GROWTH_FOLLOW_UP_PROTOCOL_REQUIRED');
      expect(projectFollowUpProtocol({ changed_condition: 'A condition', created_at: 200, protocol_revision: 'invented', assistance_policy_revision: 'training-assistance-capture-v1' })).toMatchObject({ status: 'UNAVAILABLE', outcome: 'UNKNOWN' });
    } finally { db.close(); }
  });
});
