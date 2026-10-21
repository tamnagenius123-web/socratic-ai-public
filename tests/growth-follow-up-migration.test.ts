import { URL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

function beforeLaunchMigration(legacy: boolean) {
  const db = new DatabaseSync(':memory:');
  const directory = new URL('../migrations/', import.meta.url);
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql') && name < '0069').sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  if (legacy) {
    db.exec(`CREATE TABLE catalog_fixture AS SELECT from_state,action,to_state,event_type FROM growth_lifecycle_transitions;
      DROP TABLE growth_lifecycle_transitions;
      CREATE TABLE growth_lifecycle_transitions (from_state TEXT NOT NULL,action TEXT NOT NULL,to_state TEXT NOT NULL,event_type TEXT NOT NULL,PRIMARY KEY(from_state,action,to_state));
      INSERT INTO growth_lifecycle_transitions SELECT * FROM catalog_fixture; DROP TABLE catalog_fixture;`);
  }
  return db;
}
const migration = readFileSync(new URL('../migrations/0069_growth_recheck_follow_up.sql', import.meta.url), 'utf8');

describe('follow-up migration catalog compatibility', () => {
  it.each([false, true])('preserves existing routes and frozen contracts with legacy catalog=%s', legacy => {
    const db = beforeLaunchMigration(legacy);
    try {
      const expected = db.prepare('SELECT * FROM growth_lifecycle_transition_contracts ORDER BY from_state,action,to_state').all();
      db.exec('BEGIN'); db.exec(migration); db.exec('COMMIT');
      expect(db.prepare("SELECT * FROM growth_lifecycle_transitions WHERE action<>'LAUNCH_RECHECK_FOLLOW_UP' ORDER BY from_state,action,to_state").all()).toEqual(expected);
      expect(db.prepare("SELECT actor_class,route_action FROM growth_lifecycle_transitions WHERE action='LAUNCH_RECHECK_FOLLOW_UP'").get()).toMatchObject({ actor_class: 'PARTICIPANT', route_action: 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/recheck-follow-up-launches' });
      expect(() => db.exec("UPDATE growth_lifecycle_transitions SET actor_class='SYSTEM' WHERE action='LAUNCH_RECHECK_FOLLOW_UP'")).toThrow('GROWTH_LIFECYCLE_CATALOG_IMMUTABLE');
      expect(() => db.exec("INSERT INTO growth_lifecycle_transitions VALUES('RECHECKED','FAKE_TRANSFER','CLOSED','TRANSFER_OUTCOME_RECORDED','SYSTEM','SYSTEM:GROWTH_CYCLE')")).toThrow('GROWTH_LIFECYCLE_CATALOG_IMMUTABLE');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('refuses a six-column parent that diverges from its frozen sidecar before replacing it', () => {
    const db=beforeLaunchMigration(false);
    try {
      db.exec("DROP TRIGGER growth_lifecycle_transitions_immutable_update; UPDATE growth_lifecycle_transitions SET actor_class='SYSTEM' WHERE action='RECORD_RECHECK'");
      const before=db.prepare('SELECT * FROM growth_lifecycle_transitions').all();
      expect(()=>db.exec(migration)).toThrow();
      expect(db.prepare('SELECT * FROM growth_lifecycle_transitions').all()).toEqual(before);
    } finally { db.close(); }
  });

  it('fails before replacing a legacy catalog when a frozen route contract is missing', () => {
    const db=beforeLaunchMigration(true);
    try {
      db.exec("INSERT INTO growth_lifecycle_transitions VALUES('RECHECKED','UNCONTRACTED','CLOSED','UNKNOWN_EVENT')");
      const before=db.prepare('SELECT * FROM growth_lifecycle_transitions').all();
      expect(()=>db.exec(migration)).toThrow();
      expect(db.prepare('SELECT * FROM growth_lifecycle_transitions').all()).toEqual(before);
    } finally { db.close(); }
  });
});
