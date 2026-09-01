ALTER TABLE audit_logs ADD COLUMN event_id TEXT;

CREATE UNIQUE INDEX idx_audit_logs_event_id
  ON audit_logs(event_id)
  WHERE event_id IS NOT NULL;

CREATE TABLE audit_outbox (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('ADMIN', 'API_KEY', 'SYSTEM')),
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  request_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'DELIVERED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  delivered_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'PENDING'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND delivered_at IS NULL)
    OR
    (status = 'PROCESSING'
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND delivered_at IS NULL)
    OR
    (status = 'DELIVERED'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND delivered_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_audit_outbox_claim
  ON audit_outbox(status, available_at, lease_expires_at, created_at, id);

CREATE TABLE audit_outbox_assertions (
  ok INTEGER NOT NULL
) STRICT;

CREATE TRIGGER audit_outbox_assertion_guard
BEFORE INSERT ON audit_outbox_assertions
WHEN NEW.ok <> 1
BEGIN
  SELECT RAISE(ABORT, 'openpool_audit_outbox_conflict');
END;

CREATE TRIGGER audit_outbox_assertion_cleanup
AFTER INSERT ON audit_outbox_assertions
BEGIN
  DELETE FROM audit_outbox_assertions WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER audit_outbox_core_immutable
BEFORE UPDATE OF
  actor_type,
  actor_id,
  action,
  resource_type,
  resource_id,
  request_id,
  metadata,
  created_at
ON audit_outbox
WHEN
  OLD.actor_type <> NEW.actor_type
  OR OLD.actor_id IS NOT NEW.actor_id
  OR OLD.action <> NEW.action
  OR OLD.resource_type <> NEW.resource_type
  OR OLD.resource_id IS NOT NEW.resource_id
  OR OLD.request_id IS NOT NEW.request_id
  OR OLD.metadata <> NEW.metadata
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'openpool_audit_outbox_immutable');
END;
