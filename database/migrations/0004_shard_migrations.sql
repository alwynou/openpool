CREATE TABLE shard_migrations (
  id TEXT PRIMARY KEY,
  source_shard_id TEXT NOT NULL
    REFERENCES storage_shards(id) ON DELETE RESTRICT,
  target_shard_id TEXT NOT NULL
    REFERENCES storage_shards(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (source_shard_id <> target_shard_id),
  CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL) OR
    (status <> 'COMPLETED' AND completed_at IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX idx_shard_migrations_one_running_source
  ON shard_migrations(source_shard_id)
  WHERE status = 'RUNNING';

CREATE INDEX idx_shard_migrations_target
  ON shard_migrations(target_shard_id, status, updated_at);

CREATE TABLE shard_migration_objects (
  id TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL
    REFERENCES shard_migrations(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL
    REFERENCES objects(id) ON DELETE CASCADE,
  source_location_id TEXT
    REFERENCES object_locations(id) ON DELETE SET NULL,
  target_location_id TEXT NOT NULL UNIQUE
    REFERENCES object_locations(id) ON DELETE RESTRICT,
  target_physical_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RESERVED'
    CHECK (status IN ('RESERVED', 'SWITCHED', 'COMPLETED', 'FAILED')),
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (migration_id, object_id),
  CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL) OR
    (status <> 'COMPLETED' AND completed_at IS NULL)
  )
) STRICT;

CREATE INDEX idx_shard_migration_objects_claim
  ON shard_migration_objects(
    migration_id,
    status,
    lease_expires_at,
    updated_at,
    id
  );

CREATE TABLE shard_migration_assertions (
  ok INTEGER NOT NULL
) STRICT;

CREATE TRIGGER shard_migration_assertion_guard
BEFORE INSERT ON shard_migration_assertions
WHEN NEW.ok <> 1
BEGIN
  SELECT RAISE(ABORT, 'openpool_shard_migration_conflict');
END;

CREATE TRIGGER shard_migration_assertion_cleanup
AFTER INSERT ON shard_migration_assertions
BEGIN
  DELETE FROM shard_migration_assertions WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER shard_migration_object_reservation_guard
BEFORE INSERT ON shard_migration_objects
WHEN NEW.status = 'RESERVED'
BEGIN
  SELECT RAISE(ABORT, 'openpool_shard_migration_unavailable')
  WHERE NOT EXISTS (
    SELECT 1
    FROM shard_migrations AS migration
    JOIN objects AS object ON object.id = NEW.object_id
    JOIN object_locations AS source_location
      ON source_location.id = NEW.source_location_id
     AND source_location.object_id = object.id
     AND source_location.storage_shard_id = migration.source_shard_id
     AND source_location.is_primary = 1
    JOIN storage_shards AS target_shard
      ON target_shard.id = migration.target_shard_id
     AND target_shard.logical_bucket_id = object.logical_bucket_id
     AND target_shard.status = 'ACTIVE'
    JOIN storage_accounts AS target_account
      ON target_account.id = target_shard.storage_account_id
    WHERE migration.id = NEW.migration_id
      AND migration.status = 'RUNNING'
      AND object.status = 'READY'
      AND target_account.status = 'ACTIVE'
      AND target_account.write_enabled = 1
      AND target_account.last_health_status = 'HEALTHY'
      AND target_account.capacity_accuracy <> 'UNKNOWN'
      AND object.size_bytes <=
        target_shard.capacity_bytes -
        ((target_shard.capacity_bytes + 9) / 10) -
        target_shard.used_bytes
      AND object.size_bytes <=
        target_account.capacity_bytes -
        ((target_account.capacity_bytes + 9) / 10) -
        target_account.used_bytes
  );
END;

CREATE TRIGGER shard_migration_object_reservation_apply
AFTER INSERT ON shard_migration_objects
WHEN NEW.status = 'RESERVED'
BEGIN
  INSERT INTO object_locations
    (id, object_id, storage_account_id, storage_shard_id, physical_bucket,
     physical_key, etag, is_primary, created_at, updated_at)
  SELECT NEW.target_location_id, NEW.object_id, target.storage_account_id,
         target.id, target.physical_bucket, NEW.target_physical_key, NULL, 0,
         NEW.created_at, NEW.updated_at
  FROM shard_migrations AS migration
  JOIN storage_shards AS target ON target.id = migration.target_shard_id
  WHERE migration.id = NEW.migration_id;

  UPDATE storage_shards
  SET used_bytes = used_bytes + (
        SELECT size_bytes FROM objects WHERE id = NEW.object_id
      ),
      updated_at = NEW.updated_at
  WHERE id = (
    SELECT target_shard_id
    FROM shard_migrations
    WHERE id = NEW.migration_id
  );

  UPDATE storage_accounts
  SET used_bytes = used_bytes + (
        SELECT size_bytes FROM objects WHERE id = NEW.object_id
      ),
      updated_at = NEW.updated_at
  WHERE id = (
    SELECT target.storage_account_id
    FROM shard_migrations AS migration
    JOIN storage_shards AS target ON target.id = migration.target_shard_id
    WHERE migration.id = NEW.migration_id
  );
END;
