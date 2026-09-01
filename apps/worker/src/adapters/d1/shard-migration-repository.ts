import type {
  ClaimShardMigrationTransferInput,
  ClaimShardMigrationTransferPersistenceResult,
  CompleteShardMigrationResult,
  CreateShardMigrationPersistenceResult,
  FinishShardMigrationCleanupResult,
  ShardMigrationProgress,
  ShardMigrationRepository,
  ShardMigrationTransferAggregate,
  SwitchShardMigrationPrimaryResult,
} from '@openpool/application';
import type {
  ObjectLocation,
  ObjectStatus,
  ShardMigration,
  ShardMigrationObject,
  ShardMigrationObjectStatus,
  ShardMigrationStatus,
  StoredObject,
} from '@openpool/domain';

const migrationStatuses = new Set<ShardMigrationStatus>([
  'RUNNING',
  'COMPLETED',
  'FAILED',
]);
const taskStatuses = new Set<ShardMigrationObjectStatus>([
  'RESERVED',
  'SWITCHED',
  'COMPLETED',
  'FAILED',
]);
const objectStatuses = new Set<ObjectStatus>([
  'PENDING',
  'READY',
  'DELETING',
  'DELETED',
]);

interface MigrationRow {
  readonly id: unknown;
  readonly source_shard_id: unknown;
  readonly target_shard_id: unknown;
  readonly status: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly completed_at: unknown;
}

interface TransferRow extends MigrationRow {
  readonly task_id: unknown;
  readonly task_object_id: unknown;
  readonly source_location_id: unknown;
  readonly target_location_id: unknown;
  readonly target_physical_key: unknown;
  readonly task_status: unknown;
  readonly lease_token: unknown;
  readonly lease_expires_at: unknown;
  readonly attempt_count: unknown;
  readonly last_error_code: unknown;
  readonly task_created_at: unknown;
  readonly task_updated_at: unknown;
  readonly task_completed_at: unknown;
  readonly logical_bucket_id: unknown;
  readonly logical_key: unknown;
  readonly size_bytes: unknown;
  readonly content_type: unknown;
  readonly checksum: unknown;
  readonly object_status: unknown;
  readonly object_created_at: unknown;
  readonly object_updated_at: unknown;
  readonly source_storage_account_id: unknown;
  readonly source_storage_shard_id: unknown;
  readonly source_physical_bucket: unknown;
  readonly source_physical_key: unknown;
  readonly source_etag: unknown;
  readonly source_is_primary: unknown;
  readonly source_created_at: unknown;
  readonly source_updated_at: unknown;
  readonly target_storage_account_id: unknown;
  readonly target_storage_shard_id: unknown;
  readonly target_physical_bucket: unknown;
  readonly target_location_physical_key: unknown;
  readonly target_etag: unknown;
  readonly target_is_primary: unknown;
  readonly target_created_at: unknown;
  readonly target_updated_at: unknown;
}

function failClosed(field: string): never {
  throw new Error(`Invalid shard migration ${field}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) failClosed(field);
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') failClosed(field);
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    failClosed(field);
  }
  return value;
}

function flag(value: unknown, field: string): boolean {
  if (value !== 0 && value !== 1) failClosed(field);
  return value === 1;
}

function oneOf<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  field: string,
): T {
  if (typeof value !== 'string' || !values.has(value as T)) failClosed(field);
  return value as T;
}

function mapMigration(row: MigrationRow): ShardMigration {
  return {
    id: text(row.id, 'id'),
    sourceShardId: text(row.source_shard_id, 'source_shard_id'),
    targetShardId: text(row.target_shard_id, 'target_shard_id'),
    status: oneOf(row.status, migrationStatuses, 'status'),
    createdAt: text(row.created_at, 'created_at'),
    updatedAt: text(row.updated_at, 'updated_at'),
    completedAt: nullableText(row.completed_at, 'completed_at'),
  };
}

function mapLocation(
  row: TransferRow,
  prefix: 'source' | 'target',
): ObjectLocation | null {
  const idValue =
    prefix === 'source' ? row.source_location_id : row.target_location_id;
  if (idValue === null && prefix === 'source') return null;
  return {
    id: text(idValue, `${prefix}.id`),
    objectId: text(row.task_object_id, `${prefix}.object_id`),
    storageAccountId: text(
      prefix === 'source'
        ? row.source_storage_account_id
        : row.target_storage_account_id,
      `${prefix}.storage_account_id`,
    ),
    storageShardId: text(
      prefix === 'source'
        ? row.source_storage_shard_id
        : row.target_storage_shard_id,
      `${prefix}.storage_shard_id`,
    ),
    physicalBucket: text(
      prefix === 'source'
        ? row.source_physical_bucket
        : row.target_physical_bucket,
      `${prefix}.physical_bucket`,
    ),
    physicalKey: text(
      prefix === 'source'
        ? row.source_physical_key
        : row.target_location_physical_key,
      `${prefix}.physical_key`,
    ),
    etag: nullableText(
      prefix === 'source' ? row.source_etag : row.target_etag,
      `${prefix}.etag`,
    ),
    isPrimary: flag(
      prefix === 'source'
        ? row.source_is_primary
        : row.target_is_primary,
      `${prefix}.is_primary`,
    ),
    createdAt: text(
      prefix === 'source' ? row.source_created_at : row.target_created_at,
      `${prefix}.created_at`,
    ),
    updatedAt: text(
      prefix === 'source' ? row.source_updated_at : row.target_updated_at,
      `${prefix}.updated_at`,
    ),
  };
}

function mapTransfer(row: TransferRow): ShardMigrationTransferAggregate {
  const object: StoredObject = {
    id: text(row.task_object_id, 'object.id'),
    logicalBucketId: text(row.logical_bucket_id, 'object.logical_bucket_id'),
    logicalKey: text(row.logical_key, 'object.logical_key'),
    sizeBytes: integer(row.size_bytes, 'object.size_bytes'),
    contentType: text(row.content_type, 'object.content_type'),
    checksum: nullableText(row.checksum, 'object.checksum'),
    status: oneOf(row.object_status, objectStatuses, 'object.status'),
    createdAt: text(row.object_created_at, 'object.created_at'),
    updatedAt: text(row.object_updated_at, 'object.updated_at'),
  };
  const task: ShardMigrationObject = {
    id: text(row.task_id, 'task.id'),
    migrationId: text(row.id, 'task.migration_id'),
    objectId: object.id,
    sourceLocationId:
      row.source_location_id === null
        ? null
        : text(row.source_location_id, 'task.source_location_id'),
    targetLocationId: text(row.target_location_id, 'task.target_location_id'),
    targetPhysicalKey: text(
      row.target_physical_key,
      'task.target_physical_key',
    ),
    status: oneOf(row.task_status, taskStatuses, 'task.status'),
    leaseToken: text(row.lease_token, 'task.lease_token'),
    leaseExpiresAt: text(row.lease_expires_at, 'task.lease_expires_at'),
    attemptCount: integer(row.attempt_count, 'task.attempt_count'),
    lastErrorCode: nullableText(row.last_error_code, 'task.last_error_code'),
    createdAt: text(row.task_created_at, 'task.created_at'),
    updatedAt: text(row.task_updated_at, 'task.updated_at'),
    completedAt: nullableText(row.task_completed_at, 'task.completed_at'),
  };
  const targetLocation = mapLocation(row, 'target');
  if (!targetLocation) failClosed('target_location');
  return {
    migration: mapMigration(row),
    task,
    object,
    sourceLocation: mapLocation(row, 'source'),
    targetLocation,
  };
}

function isExpectedD1Conflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('constraint') ||
    message.includes('openpool_shard_migration_') ||
    message.includes('unique') ||
    message.includes('foreign key')
  );
}

const migrationColumns = `
  migration.id, migration.source_shard_id, migration.target_shard_id,
  migration.status, migration.created_at, migration.updated_at,
  migration.completed_at`;

const transferColumns = `
  ${migrationColumns},
  task.id AS task_id, task.object_id AS task_object_id,
  task.source_location_id, task.target_location_id,
  task.target_physical_key, task.status AS task_status,
  task.lease_token, task.lease_expires_at, task.attempt_count,
  task.last_error_code, task.created_at AS task_created_at,
  task.updated_at AS task_updated_at,
  task.completed_at AS task_completed_at,
  object.logical_bucket_id, object.logical_key, object.size_bytes,
  object.content_type, object.checksum, object.status AS object_status,
  object.created_at AS object_created_at,
  object.updated_at AS object_updated_at,
  source.storage_account_id AS source_storage_account_id,
  source.storage_shard_id AS source_storage_shard_id,
  source.physical_bucket AS source_physical_bucket,
  source.physical_key AS source_physical_key,
  source.etag AS source_etag, source.is_primary AS source_is_primary,
  source.created_at AS source_created_at,
  source.updated_at AS source_updated_at,
  target.storage_account_id AS target_storage_account_id,
  target.storage_shard_id AS target_storage_shard_id,
  target.physical_bucket AS target_physical_bucket,
  target.physical_key AS target_location_physical_key,
  target.etag AS target_etag, target.is_primary AS target_is_primary,
  target.created_at AS target_created_at,
  target.updated_at AS target_updated_at`;

export class D1ShardMigrationRepository implements ShardMigrationRepository {
  constructor(private readonly db: D1Database) {}

  async createAndCutover(
    migration: ShardMigration,
    expectedSourceUpdatedAt: string,
    expectedTargetUpdatedAt: string,
  ): Promise<CreateShardMigrationPersistenceResult> {
    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE storage_shards
             SET status = 'MIGRATING', updated_at = ?
             WHERE id = ? AND status = 'ACTIVE' AND updated_at = ?
               AND EXISTS (
                 SELECT 1 FROM storage_accounts
                 WHERE id = storage_shards.storage_account_id
                   AND status = 'DRAINING'
               )`,
          )
          .bind(
            migration.createdAt,
            migration.sourceShardId,
            expectedSourceUpdatedAt,
          ),
        this.db.prepare(
          'INSERT INTO shard_migration_assertions (ok) VALUES (changes())',
        ),
        this.db
          .prepare(
            `UPDATE storage_shards
             SET status = 'ACTIVE', updated_at = ?
             WHERE id = ? AND status = 'STANDBY' AND updated_at = ?
               AND logical_bucket_id = (
                 SELECT logical_bucket_id FROM storage_shards WHERE id = ?
               )
               AND EXISTS (
                 SELECT 1 FROM storage_accounts
                 WHERE id = storage_shards.storage_account_id
                   AND status = 'ACTIVE' AND write_enabled = 1
                   AND last_health_status = 'HEALTHY'
                   AND capacity_accuracy <> 'UNKNOWN'
               )`,
          )
          .bind(
            migration.createdAt,
            migration.targetShardId,
            expectedTargetUpdatedAt,
            migration.sourceShardId,
          ),
        this.db.prepare(
          'INSERT INTO shard_migration_assertions (ok) VALUES (changes())',
        ),
        this.db
          .prepare(
            `INSERT INTO shard_migrations
             (id, source_shard_id, target_shard_id, status, created_at,
              updated_at, completed_at)
             VALUES (?, ?, ?, 'RUNNING', ?, ?, NULL)`,
          )
          .bind(
            migration.id,
            migration.sourceShardId,
            migration.targetShardId,
            migration.createdAt,
            migration.updatedAt,
          ),
      ]);
      return 'CREATED';
    } catch (error) {
      if (!isExpectedD1Conflict(error)) throw error;
      const running = await this.db
        .prepare(
          `SELECT id FROM shard_migrations
           WHERE source_shard_id = ? AND status = 'RUNNING' LIMIT 1`,
        )
        .bind(migration.sourceShardId)
        .first<{ id: unknown }>();
      return running === null ? 'CONFLICT' : 'ALREADY_RUNNING';
    }
  }

  async findById(id: string): Promise<ShardMigration | undefined> {
    const row = await this.db
      .prepare(
        `SELECT ${migrationColumns}
         FROM shard_migrations AS migration
         WHERE migration.id = ? LIMIT 1`,
      )
      .bind(id)
      .first<MigrationRow>();
    return row === null ? undefined : mapMigration(row);
  }

  async listByLogicalBucketId(
    logicalBucketId: string,
  ): Promise<readonly ShardMigration[]> {
    const result = await this.db
      .prepare(
        `SELECT ${migrationColumns}
         FROM shard_migrations AS migration
         JOIN storage_shards AS source
           ON source.id = migration.source_shard_id
         WHERE source.logical_bucket_id = ?
         ORDER BY migration.created_at DESC, migration.id DESC
         LIMIT 100`,
      )
      .bind(logicalBucketId)
      .all<MigrationRow>();
    return result.results.map(mapMigration);
  }

  async progress(id: string): Promise<ShardMigrationProgress | undefined> {
    const row = await this.db
      .prepare(
        `SELECT
           migration.id,
           (SELECT COUNT(*) FROM shard_migration_objects
            WHERE migration_id = migration.id AND status = 'RESERVED') AS reserved,
           (SELECT COUNT(*) FROM shard_migration_objects
            WHERE migration_id = migration.id AND status = 'SWITCHED') AS switched,
           (SELECT COUNT(*) FROM shard_migration_objects
            WHERE migration_id = migration.id AND status = 'COMPLETED') AS completed,
           (SELECT COUNT(*) FROM shard_migration_objects
            WHERE migration_id = migration.id AND status = 'FAILED') AS failed,
           (SELECT COUNT(*)
            FROM object_locations AS location
            JOIN objects AS object ON object.id = location.object_id
            WHERE location.storage_shard_id = migration.source_shard_id
              AND location.is_primary = 1 AND object.status = 'READY'
              AND NOT EXISTS (
                SELECT 1 FROM shard_migration_objects AS task
                WHERE task.migration_id = migration.id
                  AND task.object_id = object.id
              )) AS remaining_ready,
           (SELECT COUNT(*)
            FROM object_locations AS location
            JOIN objects AS object ON object.id = location.object_id
            WHERE location.storage_shard_id = migration.source_shard_id
              AND location.is_primary = 1
              AND object.status NOT IN ('READY', 'DELETED')) AS blocking
         FROM shard_migrations AS migration
         WHERE migration.id = ? LIMIT 1`,
      )
      .bind(id)
      .first<Record<string, unknown>>();
    if (row === null) return undefined;
    return {
      reserved: integer(row.reserved, 'progress.reserved'),
      switched: integer(row.switched, 'progress.switched'),
      completed: integer(row.completed, 'progress.completed'),
      failed: integer(row.failed, 'progress.failed'),
      remainingReady: integer(row.remaining_ready, 'progress.remaining_ready'),
      blocking: integer(row.blocking, 'progress.blocking'),
    };
  }

  async claimTransfer(
    input: ClaimShardMigrationTransferInput,
  ): Promise<ClaimShardMigrationTransferPersistenceResult> {
    let taskId: string | undefined;
    const reclaimed = await this.db
      .prepare(
        `UPDATE shard_migration_objects
         SET status = 'RESERVED', lease_token = ?, lease_expires_at = ?,
             attempt_count = attempt_count + 1, last_error_code = NULL,
             updated_at = ?
         WHERE id = (
           SELECT task.id
           FROM shard_migration_objects AS task
           JOIN shard_migrations AS migration ON migration.id = task.migration_id
           WHERE task.migration_id = ? AND migration.status = 'RUNNING'
             AND (
               task.status = 'FAILED' OR
               (task.status = 'RESERVED' AND task.lease_expires_at <= ?)
             )
           ORDER BY task.updated_at ASC, task.id ASC
           LIMIT 1
         )
         RETURNING id`,
      )
      .bind(
        input.leaseToken,
        input.leaseExpiresAt,
        input.leasedAt,
        input.migrationId,
        input.leasedAt,
      )
      .first<{ id: unknown }>();
    if (reclaimed !== null) taskId = text(reclaimed.id, 'claim.reclaimed_id');

    if (taskId === undefined) {
      try {
        const inserted = await this.db
          .prepare(
            `INSERT INTO shard_migration_objects
             (id, migration_id, object_id, source_location_id,
              target_location_id, target_physical_key, status, lease_token,
              lease_expires_at, attempt_count, last_error_code, created_at,
              updated_at, completed_at)
             SELECT ?, migration.id, object.id, source.id, ?,
                    ? || substr(object.id, 1, 2) || '/' || object.id,
                    'RESERVED', ?, ?, 1, NULL, ?, ?, NULL
             FROM shard_migrations AS migration
             JOIN object_locations AS source
               ON source.storage_shard_id = migration.source_shard_id
              AND source.is_primary = 1
             JOIN objects AS object ON object.id = source.object_id
             WHERE migration.id = ? AND migration.status = 'RUNNING'
               AND object.status = 'READY'
               AND NOT EXISTS (
                 SELECT 1 FROM shard_migration_objects AS existing
                 WHERE existing.migration_id = migration.id
                   AND existing.object_id = object.id
               )
             ORDER BY object.logical_key ASC, object.id ASC
             LIMIT 1
             RETURNING id`,
          )
          .bind(
            input.taskId,
            input.targetLocationId,
            input.targetPhysicalKeyPrefix,
            input.leaseToken,
            input.leaseExpiresAt,
            input.leasedAt,
            input.leasedAt,
            input.migrationId,
          )
          .first<{ id: unknown }>();
        if (inserted === null) return { outcome: 'NONE' };
        taskId = text(inserted.id, 'claim.inserted_id');
      } catch (error) {
        if (!isExpectedD1Conflict(error)) throw error;
        const message = error instanceof Error ? error.message : '';
        return {
          outcome: message.includes('openpool_shard_migration_unavailable')
            ? 'CAPACITY_UNAVAILABLE'
            : 'CONFLICT',
        };
      }
    }

    const transfer = await this.findTransfer(taskId, input.leaseToken);
    return transfer
      ? { outcome: 'CLAIMED', transfer }
      : { outcome: 'CONFLICT' };
  }

  async findTransfer(
    taskId: string,
    leaseToken: string,
  ): Promise<ShardMigrationTransferAggregate | undefined> {
    const row = await this.db
      .prepare(
        `SELECT ${transferColumns}
         FROM shard_migration_objects AS task
         JOIN shard_migrations AS migration ON migration.id = task.migration_id
         JOIN objects AS object ON object.id = task.object_id
         LEFT JOIN object_locations AS source
           ON source.id = task.source_location_id
         JOIN object_locations AS target ON target.id = task.target_location_id
         WHERE task.id = ? AND task.lease_token = ? LIMIT 1`,
      )
      .bind(taskId, leaseToken)
      .first<TransferRow>();
    return row === null ? undefined : mapTransfer(row);
  }

  async listSourceCleanupCandidates(
    limit: number,
  ): Promise<readonly ShardMigrationTransferAggregate[]> {
    const result = await this.db
      .prepare(
        `SELECT ${transferColumns}
         FROM shard_migration_objects AS task
         JOIN shard_migrations AS migration ON migration.id = task.migration_id
         JOIN objects AS object ON object.id = task.object_id
         LEFT JOIN object_locations AS source
           ON source.id = task.source_location_id
         JOIN object_locations AS target ON target.id = task.target_location_id
         WHERE task.status = 'SWITCHED'
         ORDER BY task.updated_at ASC, task.id ASC
         LIMIT ?`,
      )
      .bind(limit)
      .all<TransferRow>();
    return result.results.map(mapTransfer);
  }

  async switchPrimary(
    taskId: string,
    leaseToken: string,
    etag: string | null,
    updatedAt: string,
  ): Promise<SwitchShardMigrationPrimaryResult> {
    const before = await this.taskStatus(taskId);
    if (before === undefined) return 'NOT_FOUND';
    if (before === 'COMPLETED') return 'ALREADY_COMPLETED';
    if (before === 'SWITCHED') return 'ALREADY_SWITCHED';
    if (before !== 'RESERVED') return 'CONFLICT';
    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE object_locations
             SET is_primary = 0, updated_at = ?
             WHERE id = (
               SELECT source_location_id FROM shard_migration_objects
               WHERE id = ? AND status = 'RESERVED' AND lease_token = ?
                 AND lease_expires_at > ?
             ) AND is_primary = 1`,
          )
          .bind(updatedAt, taskId, leaseToken, updatedAt),
        this.db.prepare(
          'INSERT INTO shard_migration_assertions (ok) VALUES (changes())',
        ),
        this.db
          .prepare(
            `UPDATE object_locations
             SET is_primary = 1, etag = ?, updated_at = ?
             WHERE id = (
               SELECT target_location_id FROM shard_migration_objects
               WHERE id = ? AND status = 'RESERVED' AND lease_token = ?
                 AND lease_expires_at > ?
             ) AND is_primary = 0`,
          )
          .bind(etag, updatedAt, taskId, leaseToken, updatedAt),
        this.db.prepare(
          'INSERT INTO shard_migration_assertions (ok) VALUES (changes())',
        ),
        this.db
          .prepare(
            `UPDATE objects
             SET updated_at = ?
             WHERE id = (
               SELECT object_id FROM shard_migration_objects
               WHERE id = ? AND status = 'RESERVED' AND lease_token = ?
             ) AND status = 'READY'`,
          )
          .bind(updatedAt, taskId, leaseToken),
        this.db.prepare(
          'INSERT INTO shard_migration_assertions (ok) VALUES (changes())',
        ),
        this.db
          .prepare(
            `UPDATE shard_migration_objects
             SET status = 'SWITCHED', updated_at = ?
             WHERE id = ? AND status = 'RESERVED' AND lease_token = ?
               AND lease_expires_at > ?`,
          )
          .bind(updatedAt, taskId, leaseToken, updatedAt),
        this.db.prepare(
          'INSERT INTO shard_migration_assertions (ok) VALUES (changes())',
        ),
      ]);
      return 'SWITCHED';
    } catch (error) {
      if (!isExpectedD1Conflict(error)) throw error;
      const after = await this.taskStatus(taskId);
      if (after === 'SWITCHED') return 'ALREADY_SWITCHED';
      if (after === 'COMPLETED') return 'ALREADY_COMPLETED';
      return 'CONFLICT';
    }
  }

  async finishSourceCleanup(
    taskId: string,
    updatedAt: string,
  ): Promise<FinishShardMigrationCleanupResult> {
    const before = await this.taskStatus(taskId);
    if (before === undefined) return 'NOT_FOUND';
    if (before === 'COMPLETED') return 'ALREADY_COMPLETED';
    if (before !== 'SWITCHED') return 'CONFLICT';
    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE storage_shards
             SET used_bytes = used_bytes - (
                   SELECT object.size_bytes
                   FROM shard_migration_objects AS task
                   JOIN objects AS object ON object.id = task.object_id
                   WHERE task.id = ? AND task.status = 'SWITCHED'
                 ), updated_at = ?
             WHERE id = (
               SELECT source.storage_shard_id
               FROM shard_migration_objects AS task
               JOIN object_locations AS source
                 ON source.id = task.source_location_id
               WHERE task.id = ? AND task.status = 'SWITCHED'
             ) AND used_bytes >= (
               SELECT object.size_bytes
               FROM shard_migration_objects AS task
               JOIN objects AS object ON object.id = task.object_id
               WHERE task.id = ? AND task.status = 'SWITCHED'
             )`,
          )
          .bind(taskId, updatedAt, taskId, taskId),
        this.db.prepare(
          'INSERT INTO shard_migration_assertions (ok) VALUES (changes())',
        ),
        this.db
          .prepare(
            `UPDATE storage_accounts
             SET used_bytes = used_bytes - (
                   SELECT object.size_bytes
                   FROM shard_migration_objects AS task
                   JOIN objects AS object ON object.id = task.object_id
                   WHERE task.id = ? AND task.status = 'SWITCHED'
                 ), updated_at = ?
             WHERE id = (
               SELECT source.storage_account_id
               FROM shard_migration_objects AS task
               JOIN object_locations AS source
                 ON source.id = task.source_location_id
               WHERE task.id = ? AND task.status = 'SWITCHED'
             ) AND used_bytes >= (
               SELECT object.size_bytes
               FROM shard_migration_objects AS task
               JOIN objects AS object ON object.id = task.object_id
               WHERE task.id = ? AND task.status = 'SWITCHED'
             )`,
          )
          .bind(taskId, updatedAt, taskId, taskId),
        this.db.prepare(
          'INSERT INTO shard_migration_assertions (ok) VALUES (changes())',
        ),
        this.db
          .prepare(
            `DELETE FROM object_locations
             WHERE id = (
               SELECT source_location_id FROM shard_migration_objects
               WHERE id = ? AND status = 'SWITCHED'
             ) AND is_primary = 0`,
          )
          .bind(taskId),
        this.db.prepare(
          'INSERT INTO shard_migration_assertions (ok) VALUES (changes())',
        ),
        this.db
          .prepare(
            `UPDATE shard_migration_objects
             SET status = 'COMPLETED', completed_at = ?, updated_at = ?
             WHERE id = ? AND status = 'SWITCHED'`,
          )
          .bind(updatedAt, updatedAt, taskId),
        this.db.prepare(
          'INSERT INTO shard_migration_assertions (ok) VALUES (changes())',
        ),
      ]);
      return 'COMPLETED';
    } catch (error) {
      if (!isExpectedD1Conflict(error)) throw error;
      return (await this.taskStatus(taskId)) === 'COMPLETED'
        ? 'ALREADY_COMPLETED'
        : 'CONFLICT';
    }
  }

  async completeIfReady(
    migrationId: string,
    completedAt: string,
  ): Promise<CompleteShardMigrationResult> {
    const migration = await this.findById(migrationId);
    if (!migration) return 'NOT_FOUND';
    if (migration.status === 'COMPLETED') return 'ALREADY_COMPLETED';
    if (migration.status !== 'RUNNING') return 'BLOCKED';
    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE storage_shards
             SET status = 'RETIRED', updated_at = ?
             WHERE id = (
               SELECT source_shard_id FROM shard_migrations
               WHERE id = ? AND status = 'RUNNING'
             ) AND status = 'MIGRATING' AND used_bytes = 0
               AND NOT EXISTS (
                 SELECT 1
                 FROM object_locations AS location
                 JOIN objects AS object ON object.id = location.object_id
                 WHERE location.storage_shard_id = storage_shards.id
                   AND object.status <> 'DELETED'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM shard_migration_objects AS task
                 WHERE task.migration_id = ? AND task.status <> 'COMPLETED'
               )`,
          )
          .bind(completedAt, migrationId, migrationId),
        this.db.prepare(
          'INSERT INTO shard_migration_assertions (ok) VALUES (changes())',
        ),
        this.db
          .prepare(
            `UPDATE shard_migrations
             SET status = 'COMPLETED', completed_at = ?, updated_at = ?
             WHERE id = ? AND status = 'RUNNING'
               AND EXISTS (
                 SELECT 1 FROM storage_shards
                 WHERE id = shard_migrations.source_shard_id
                   AND status = 'RETIRED' AND used_bytes = 0
               )`,
          )
          .bind(completedAt, completedAt, migrationId),
        this.db.prepare(
          'INSERT INTO shard_migration_assertions (ok) VALUES (changes())',
        ),
      ]);
      return 'COMPLETED';
    } catch (error) {
      if (!isExpectedD1Conflict(error)) throw error;
      const current = await this.findById(migrationId);
      if (current?.status === 'COMPLETED') return 'ALREADY_COMPLETED';
      return 'BLOCKED';
    }
  }

  private async taskStatus(
    taskId: string,
  ): Promise<ShardMigrationObjectStatus | undefined> {
    const row = await this.db
      .prepare('SELECT status FROM shard_migration_objects WHERE id = ? LIMIT 1')
      .bind(taskId)
      .first<{ status: unknown }>();
    return row === null ? undefined : oneOf(row.status, taskStatuses, 'task.status');
  }
}
