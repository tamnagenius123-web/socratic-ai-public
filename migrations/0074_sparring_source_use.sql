-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TRIGGER sparring_source_manifest_guard BEFORE INSERT ON sparring_evidence_manifests BEGIN
 SELECT RAISE(ABORT,'SPARRING_SOURCE_UNAVAILABLE') WHERE NOT EXISTS(
  SELECT 1 FROM sessions s JOIN books b ON b.id=s.book_id
  WHERE s.id=NEW.session_id AND s.user_id=NEW.user_id AND b.id=NEW.book_id
   AND b.lifecycle_status='active'
   AND ((b.is_builtin=1 AND b.visibility='builtin') OR (b.visibility='private' AND b.owner_user_id=NEW.user_id))
 );
END;

CREATE TRIGGER sparring_source_message_guard BEFORE INSERT ON messages
WHEN EXISTS(SELECT 1 FROM learning_session_contexts WHERE session_id=NEW.session_id AND session_kind='SPARRING') BEGIN
 SELECT RAISE(ABORT,'SPARRING_SOURCE_UNAVAILABLE') WHERE NOT EXISTS(
  SELECT 1 FROM sessions s JOIN books b ON b.id=s.book_id
  WHERE s.id=NEW.session_id AND b.lifecycle_status='active'
   AND ((b.is_builtin=1 AND b.visibility='builtin') OR (b.visibility='private' AND b.owner_user_id=s.user_id))
 );
END;

CREATE TRIGGER sparring_source_hint_guard BEFORE INSERT ON sparring_hint_responses BEGIN
 SELECT RAISE(ABORT,'SPARRING_SOURCE_UNAVAILABLE') WHERE NOT EXISTS(
  SELECT 1 FROM sessions s JOIN books b ON b.id=s.book_id
  WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_user_id AND b.lifecycle_status='active'
   AND ((b.is_builtin=1 AND b.visibility='builtin') OR (b.visibility='private' AND b.owner_user_id=NEW.owner_user_id))
 );
END;
