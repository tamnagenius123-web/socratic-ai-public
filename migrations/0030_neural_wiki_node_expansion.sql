-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE knowledge_nodes ADD COLUMN core_essence TEXT NOT NULL DEFAULT '{}';

ALTER TABLE knowledge_nodes ADD COLUMN building_blocks_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE knowledge_nodes ADD COLUMN metaphorical_bridges_json TEXT NOT NULL DEFAULT '{}';
