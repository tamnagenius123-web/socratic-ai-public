-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE sessions ADD COLUMN thought_profile_json TEXT DEFAULT '{}';

ALTER TABLE sessions ADD COLUMN challenge_state_json TEXT DEFAULT '{"currentLevel":1,"history":[],"consecutiveSuccess":0,"consecutiveStruggle":0}';
