-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE growth_recheck_sparring_follow_up_launches ADD COLUMN assistance_capture_revision
 TEXT NOT NULL DEFAULT 'sparring-session-totals-v1'
 CHECK(assistance_capture_revision IN ('sparring-session-totals-v1','sparring-record-index-v2'));

DROP TRIGGER growth_sparring_follow_up_binding_delete;

CREATE TRIGGER growth_sparring_follow_up_binding_delete BEFORE DELETE ON growth_recheck_sparring_follow_up_bindings
WHEN EXISTS (SELECT 1 FROM growth_recheck_sparring_follow_up_launches launch WHERE launch.id=OLD.launch_id
 AND NOT EXISTS (SELECT 1 FROM growth_deletion_context WHERE growth_cycle_id=launch.growth_cycle_id))
 AND EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id)
 AND EXISTS (SELECT 1 FROM learning_session_contexts WHERE id=OLD.context_id)
 AND NOT EXISTS (SELECT 1 FROM learning_session_context_deletion_authorizations WHERE session_context_id=OLD.context_id)
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_IMMUTABLE'); END;
