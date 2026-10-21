-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE training_scenario_packs ADD COLUMN case_id TEXT;

ALTER TABLE training_scenario_packs ADD COLUMN case_version TEXT;

ALTER TABLE training_scenario_packs ADD COLUMN case_contract_sha256 TEXT;

CREATE TRIGGER training_scenario_packs_case_contract_insert_guard
BEFORE INSERT ON training_scenario_packs
FOR EACH ROW WHEN
  (NEW.case_id IS NULL AND (NEW.case_version IS NOT NULL OR NEW.case_contract_sha256 IS NOT NULL))
  OR (NEW.case_id IS NOT NULL AND (NEW.case_version IS NULL OR NEW.case_contract_sha256 IS NULL))
  OR (NEW.case_id IS NOT NULL AND (
    length(trim(NEW.case_id)) = 0
    OR length(trim(NEW.case_version)) = 0
    OR length(NEW.case_contract_sha256) <> 64
    OR NEW.case_contract_sha256 GLOB '*[^0-9a-f]*'
  ))
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_CASE_CONTRACT_INVALID');
END;

CREATE TRIGGER training_scenario_packs_case_contract_immutable
BEFORE UPDATE OF case_id, case_version, case_contract_sha256 ON training_scenario_packs
FOR EACH ROW WHEN
  NEW.case_id IS NOT OLD.case_id
  OR NEW.case_version IS NOT OLD.case_version
  OR NEW.case_contract_sha256 IS NOT OLD.case_contract_sha256
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_CASE_CONTRACT_IMMUTABLE');
END;
