-- Keep one current attempt per logical object, retaining superseded sessions
-- and their distinct physical locations until their signed PUTs have expired.
ALTER TABLE upload_sessions ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1
  CHECK (is_current IN (0, 1));
ALTER TABLE upload_sessions ADD COLUMN location_id TEXT
  REFERENCES object_locations(id) ON DELETE SET NULL;

UPDATE upload_sessions SET location_id = (
  SELECT id FROM object_locations
  WHERE object_id = upload_sessions.object_id AND is_primary = 1
);

DROP INDEX idx_upload_sessions_one_per_object;
CREATE UNIQUE INDEX idx_upload_sessions_current_per_object
  ON upload_sessions(object_id) WHERE is_current = 1;
CREATE INDEX idx_upload_sessions_cleanup
  ON upload_sessions(status, expires_at, id);
CREATE INDEX idx_upload_sessions_location ON upload_sessions(location_id);

CREATE TRIGGER upload_session_location_insert_guard
BEFORE INSERT ON upload_sessions
WHEN NEW.location_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'openpool_object_upload_location_conflict')
  WHERE NOT EXISTS (SELECT 1 FROM object_locations
    WHERE id = NEW.location_id AND object_id = NEW.object_id AND is_primary = 1);
END;

CREATE TRIGGER upload_session_location_update_guard
BEFORE UPDATE OF location_id ON upload_sessions
WHEN NEW.location_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'openpool_object_upload_location_conflict')
  WHERE (OLD.location_id IS NOT NULL AND OLD.location_id <> NEW.location_id)
    OR NOT EXISTS (SELECT 1 FROM object_locations
      WHERE id = NEW.location_id AND object_id = NEW.object_id);
END;

-- Also supports reservations made by the pre-upgrade Worker during rollout.
CREATE TRIGGER upload_session_bind_location
AFTER INSERT ON upload_sessions
WHEN NEW.location_id IS NULL
BEGIN
  UPDATE upload_sessions SET location_id = (
    SELECT id FROM object_locations
    WHERE object_id = NEW.object_id AND is_primary = 1
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER upload_session_supersede_guard
BEFORE UPDATE OF is_current ON upload_sessions
WHEN OLD.is_current <> NEW.is_current
BEGIN
  SELECT RAISE(ABORT, 'openpool_object_retry_conflict')
  WHERE OLD.is_current <> 1 OR NEW.is_current <> 0
    OR NEW.status NOT IN ('EXPIRED', 'ABORTED');
END;

CREATE TRIGGER upload_session_history_status_guard
BEFORE UPDATE OF status ON upload_sessions
WHEN NEW.is_current = 0 AND NEW.status NOT IN ('EXPIRED', 'ABORTED')
BEGIN
  SELECT RAISE(ABORT, 'openpool_object_retry_conflict');
END;
