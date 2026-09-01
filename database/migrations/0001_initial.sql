PRAGMA foreign_keys = ON;

CREATE TABLE administrators (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  administrator_id TEXT NOT NULL REFERENCES administrators(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_auth_sessions_administrator
  ON auth_sessions(administrator_id, expires_at);

CREATE TABLE storage_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('r2', 'b2', 's3')),
  status TEXT NOT NULL DEFAULT 'VERIFYING'
    CHECK (status IN ('VERIFYING', 'ACTIVE', 'DRAINING', 'READ_ONLY', 'REMOVED')),
  priority INTEGER NOT NULL DEFAULT 0,
  write_enabled INTEGER NOT NULL DEFAULT 0 CHECK (write_enabled IN (0, 1)),
  capacity_bytes INTEGER NOT NULL CHECK (capacity_bytes >= 0),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  provider_config TEXT NOT NULL DEFAULT '{}',
  credential_envelope TEXT NOT NULL,
  last_health_status TEXT,
  last_health_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_storage_accounts_placement
  ON storage_accounts(status, write_enabled, priority DESC);

CREATE TABLE logical_buckets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE storage_shards (
  id TEXT PRIMARY KEY,
  logical_bucket_id TEXT NOT NULL REFERENCES logical_buckets(id) ON DELETE RESTRICT,
  storage_account_id TEXT NOT NULL REFERENCES storage_accounts(id) ON DELETE RESTRICT,
  physical_bucket TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'STANDBY'
    CHECK (status IN ('STANDBY', 'ACTIVE', 'READ_ONLY', 'MIGRATING', 'RETIRED')),
  capacity_bytes INTEGER NOT NULL CHECK (capacity_bytes >= 0),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_storage_shards_one_active_per_bucket
  ON storage_shards(logical_bucket_id)
  WHERE status = 'ACTIVE';

CREATE TABLE objects (
  id TEXT PRIMARY KEY,
  logical_bucket_id TEXT NOT NULL REFERENCES logical_buckets(id) ON DELETE RESTRICT,
  logical_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_type TEXT NOT NULL,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'READY', 'DELETING', 'DELETED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (logical_bucket_id, logical_key)
) STRICT;

CREATE INDEX idx_objects_list
  ON objects(logical_bucket_id, status, logical_key);

CREATE TABLE object_locations (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  storage_account_id TEXT NOT NULL REFERENCES storage_accounts(id) ON DELETE RESTRICT,
  storage_shard_id TEXT REFERENCES storage_shards(id) ON DELETE RESTRICT,
  physical_bucket TEXT NOT NULL,
  physical_key TEXT NOT NULL,
  etag TEXT,
  is_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (storage_account_id, physical_bucket, physical_key)
) STRICT;

CREATE UNIQUE INDEX idx_object_locations_primary
  ON object_locations(object_id)
  WHERE is_primary = 1;

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'COMPLETED', 'EXPIRED', 'ABORTED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE INDEX idx_upload_sessions_expiry
  ON upload_sessions(status, expires_at);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  logical_bucket_id TEXT REFERENCES logical_buckets(id) ON DELETE CASCADE,
  path_prefix TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('ADMIN', 'API_KEY', 'SYSTEM')),
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  request_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
