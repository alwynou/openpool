-- Store public-access policy on logical buckets and objects.
ALTER TABLE logical_buckets ADD COLUMN public_access_enabled INTEGER NOT NULL
  DEFAULT 0 CHECK (public_access_enabled IN (0, 1));

ALTER TABLE objects ADD COLUMN public_access_mode TEXT NOT NULL DEFAULT 'INHERIT'
  CHECK (public_access_mode IN ('INHERIT', 'PUBLIC', 'PRIVATE'));
ALTER TABLE objects ADD COLUMN public_access_expires_at TEXT NULL;

-- An expiry is meaningful only for an explicitly public object.  Keep this
-- invariant in the database so direct D1 writes cannot create an ambiguous
-- access policy.  Use SELECT RAISE rather than CASE/END: D1's migration
-- splitter can mistake CASE END for the end of a trigger body.
CREATE TRIGGER object_public_access_insert_guard
BEFORE INSERT ON objects
WHEN NEW.public_access_mode <> 'PUBLIC'
BEGIN
  SELECT RAISE(ABORT, 'openpool_object_public_access_expiry_conflict')
  WHERE NEW.public_access_expires_at IS NOT NULL;
END;

CREATE TRIGGER object_public_access_update_guard
BEFORE UPDATE OF public_access_mode, public_access_expires_at ON objects
WHEN NEW.public_access_mode <> 'PUBLIC'
BEGIN
  SELECT RAISE(ABORT, 'openpool_object_public_access_expiry_conflict')
  WHERE NEW.public_access_expires_at IS NOT NULL;
END;
