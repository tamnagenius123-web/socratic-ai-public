-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE growth_recheck_follow_up_launches ADD COLUMN protocol_revision TEXT;

ALTER TABLE growth_recheck_follow_up_launches ADD COLUMN assistance_policy_revision TEXT;

CREATE TRIGGER growth_follow_up_protocol_insert_guard
BEFORE INSERT ON growth_recheck_follow_up_launches
WHEN NEW.protocol_revision IS NOT 'growth-follow-up-local-v1'
  OR NEW.assistance_policy_revision IS NOT 'training-assistance-capture-v1'
BEGIN SELECT RAISE(ABORT, 'GROWTH_FOLLOW_UP_PROTOCOL_REQUIRED'); END;
