CREATE UNIQUE INDEX idx_upload_sessions_one_per_object
  ON upload_sessions(object_id);

-- D1 batches are transactional, but a conditional UPDATE that affects no rows
-- does not fail the batch. Repository batches insert into this internal guard
-- immediately after each required write so a lost race rolls the whole batch
-- back instead of leaving a partially completed aggregate.
CREATE TABLE object_repository_assertions (
  ok INTEGER NOT NULL
) STRICT;

CREATE TRIGGER object_repository_assertion_guard
BEFORE INSERT ON object_repository_assertions
WHEN NEW.ok <> 1
BEGIN
  SELECT RAISE(ABORT, 'openpool_object_repository_conflict');
END;

CREATE TRIGGER object_repository_assertion_cleanup
AFTER INSERT ON object_repository_assertions
BEGIN
  DELETE FROM object_repository_assertions WHERE rowid = NEW.rowid;
END;

-- A primary location is the reservation boundary. The trigger validates both
-- placement levels against the same database snapshot before incrementing the
-- counters. Any failure aborts the surrounding D1 batch (object + location +
-- upload session), so no row or counter can be left behind.
CREATE TRIGGER object_primary_location_reservation_guard
BEFORE INSERT ON object_locations
WHEN NEW.is_primary = 1
BEGIN
  SELECT RAISE(ABORT, 'openpool_object_reservation_unavailable')
  WHERE NOT EXISTS (
    SELECT 1
    FROM objects AS object
    JOIN storage_shards AS shard
      ON shard.id = NEW.storage_shard_id
     AND shard.logical_bucket_id = object.logical_bucket_id
     AND shard.storage_account_id = NEW.storage_account_id
     AND shard.physical_bucket = NEW.physical_bucket
    JOIN storage_accounts AS account
      ON account.id = NEW.storage_account_id
    WHERE object.id = NEW.object_id
      AND object.status = 'PENDING'
      AND shard.status = 'ACTIVE'
      AND account.status = 'ACTIVE'
      AND account.write_enabled = 1
      AND account.last_health_status = 'HEALTHY'
      AND account.capacity_accuracy <> 'UNKNOWN'
      AND object.size_bytes <=
        shard.capacity_bytes - ((shard.capacity_bytes + 9) / 10) - shard.used_bytes
      AND object.size_bytes <=
        account.capacity_bytes - ((account.capacity_bytes + 9) / 10) - account.used_bytes
  );
END;

CREATE TRIGGER object_primary_location_reservation_apply
AFTER INSERT ON object_locations
WHEN NEW.is_primary = 1
BEGIN
  UPDATE storage_shards
  SET used_bytes = used_bytes + (
    SELECT size_bytes FROM objects WHERE id = NEW.object_id
  ),
      updated_at = (
        SELECT updated_at FROM objects WHERE id = NEW.object_id
      )
  WHERE id = NEW.storage_shard_id;

  UPDATE storage_accounts
  SET used_bytes = used_bytes + (
    SELECT size_bytes FROM objects WHERE id = NEW.object_id
  ),
      updated_at = (
        SELECT updated_at FROM objects WHERE id = NEW.object_id
      )
  WHERE id = NEW.storage_account_id;
END;

-- Expiry retains the PENDING object as an audit record but gives its capacity
-- back exactly once. The OLD/NEW predicate makes retries idempotent.
CREATE TRIGGER upload_session_expiry_release_guard
BEFORE UPDATE OF status ON upload_sessions
WHEN OLD.status = 'PENDING' AND NEW.status = 'EXPIRED'
BEGIN
  SELECT RAISE(ABORT, 'openpool_object_capacity_underflow')
  WHERE NOT EXISTS (
    SELECT 1
    FROM objects AS object
    JOIN object_locations AS location
      ON location.object_id = object.id
     AND location.is_primary = 1
    JOIN storage_shards AS shard
      ON shard.id = location.storage_shard_id
    JOIN storage_accounts AS account
      ON account.id = location.storage_account_id
    WHERE object.id = OLD.object_id
      AND object.status = 'PENDING'
      AND shard.used_bytes >= object.size_bytes
      AND account.used_bytes >= object.size_bytes
  );
END;

CREATE TRIGGER upload_session_expiry_release_apply
AFTER UPDATE OF status ON upload_sessions
WHEN OLD.status = 'PENDING' AND NEW.status = 'EXPIRED'
BEGIN
  UPDATE storage_shards
  SET used_bytes = used_bytes - (
    SELECT size_bytes FROM objects WHERE id = NEW.object_id
  ),
      updated_at = (
        SELECT updated_at FROM objects WHERE id = NEW.object_id
      )
  WHERE id = (
    SELECT storage_shard_id
    FROM object_locations
    WHERE object_id = NEW.object_id AND is_primary = 1
  );

  UPDATE storage_accounts
  SET used_bytes = used_bytes - (
    SELECT size_bytes FROM objects WHERE id = NEW.object_id
  ),
      updated_at = (
        SELECT updated_at FROM objects WHERE id = NEW.object_id
      )
  WHERE id = (
    SELECT storage_account_id
    FROM object_locations
    WHERE object_id = NEW.object_id AND is_primary = 1
  );
END;

-- A completed object keeps its reservation until deletion reaches DELETED.
-- Only the DELETING -> DELETED edge releases capacity, so retries cannot
-- decrement either counter twice.
CREATE TRIGGER object_deletion_release_guard
BEFORE UPDATE OF status ON objects
WHEN OLD.status = 'DELETING' AND NEW.status = 'DELETED'
BEGIN
  SELECT RAISE(ABORT, 'openpool_object_capacity_underflow')
  WHERE NOT EXISTS (
    SELECT 1
    FROM object_locations AS location
    JOIN storage_shards AS shard
      ON shard.id = location.storage_shard_id
    JOIN storage_accounts AS account
      ON account.id = location.storage_account_id
    WHERE location.object_id = OLD.id
      AND location.is_primary = 1
      AND shard.used_bytes >= OLD.size_bytes
      AND account.used_bytes >= OLD.size_bytes
      AND (
        SELECT COUNT(*)
        FROM upload_sessions
        WHERE object_id = OLD.id AND status = 'COMPLETED'
      ) = 1
  );
END;

CREATE TRIGGER object_deletion_release_apply
AFTER UPDATE OF status ON objects
WHEN OLD.status = 'DELETING' AND NEW.status = 'DELETED'
BEGIN
  UPDATE storage_shards
  SET used_bytes = used_bytes - OLD.size_bytes,
      updated_at = NEW.updated_at
  WHERE id = (
    SELECT storage_shard_id
    FROM object_locations
    WHERE object_id = OLD.id AND is_primary = 1
  );

  UPDATE storage_accounts
  SET used_bytes = used_bytes - OLD.size_bytes,
      updated_at = NEW.updated_at
  WHERE id = (
    SELECT storage_account_id
    FROM object_locations
    WHERE object_id = OLD.id AND is_primary = 1
  );
END;
