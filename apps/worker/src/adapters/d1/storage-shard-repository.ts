import type { StorageShardRepository } from '@openpool/application';
import {
  storageShardStatuses,
  validatePhysicalBucketName,
  validateStorageShardCapacity,
  type StorageShard,
  type StorageShardStatus,
} from '@openpool/domain';

interface StorageShardRow {
  readonly id: unknown;
  readonly logical_bucket_id: unknown;
  readonly storage_account_id: unknown;
  readonly physical_bucket: unknown;
  readonly status: unknown;
  readonly capacity_bytes: unknown;
  readonly used_bytes: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

const statuses = new Set<StorageShardStatus>(storageShardStatuses);

const selectColumns = `
  SELECT id, logical_bucket_id, storage_account_id, physical_bucket, status,
         capacity_bytes, used_bytes, created_at, updated_at
  FROM storage_shards`;

function failClosed(field: string): never {
  throw new Error(`Invalid storage shard ${field}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) failClosed(field);
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    failClosed(field);
  }
  return value;
}

function status(value: unknown): StorageShardStatus {
  if (typeof value !== 'string' || !statuses.has(value as StorageShardStatus)) {
    failClosed('status');
  }
  return value as StorageShardStatus;
}

function validateShard(shard: StorageShard): void {
  text(shard.id, 'id');
  text(shard.logicalBucketId, 'logical_bucket_id');
  text(shard.storageAccountId, 'storage_account_id');
  text(shard.createdAt, 'created_at');
  text(shard.updatedAt, 'updated_at');

  if (!statuses.has(shard.status)) failClosed('status');

  try {
    validatePhysicalBucketName(shard.physicalBucket);
    validateStorageShardCapacity(shard.capacityBytes, shard.usedBytes);
  } catch {
    failClosed('state');
  }
}

function mapStorageShard(row: StorageShardRow): StorageShard {
  const shard: StorageShard = {
    id: text(row.id, 'id'),
    logicalBucketId: text(row.logical_bucket_id, 'logical_bucket_id'),
    storageAccountId: text(row.storage_account_id, 'storage_account_id'),
    physicalBucket: text(row.physical_bucket, 'physical_bucket'),
    status: status(row.status),
    capacityBytes: integer(row.capacity_bytes, 'capacity_bytes'),
    usedBytes: integer(row.used_bytes, 'used_bytes'),
    createdAt: text(row.created_at, 'created_at'),
    updatedAt: text(row.updated_at, 'updated_at'),
  };
  validateShard(shard);
  return shard;
}

function bindings(shard: StorageShard): readonly unknown[] {
  validateShard(shard);
  return [
    shard.id,
    shard.logicalBucketId,
    shard.storageAccountId,
    shard.physicalBucket,
    shard.status,
    shard.capacityBytes,
    shard.usedBytes,
    shard.createdAt,
    shard.updatedAt,
  ];
}

/** D1 adapter for logical-bucket to physical-bucket shard mappings. */
export class D1StorageShardRepository implements StorageShardRepository {
  constructor(private readonly db: D1Database) {}

  async create(shard: StorageShard): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO storage_shards
         (id, logical_bucket_id, storage_account_id, physical_bucket, status,
          capacity_bytes, used_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(...bindings(shard))
      .run();
    return result.meta.changes === 1;
  }

  async findById(id: string): Promise<StorageShard | undefined> {
    const row = await this.db
      .prepare(`${selectColumns} WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<StorageShardRow>();
    return row === null ? undefined : mapStorageShard(row);
  }

  async findActiveByLogicalBucketId(
    logicalBucketId: string,
  ): Promise<StorageShard | undefined> {
    const row = await this.db
      .prepare(
        `${selectColumns}
         WHERE logical_bucket_id = ? AND status = 'ACTIVE'
         LIMIT 1`,
      )
      .bind(logicalBucketId)
      .first<StorageShardRow>();
    return row === null ? undefined : mapStorageShard(row);
  }

  async list(): Promise<readonly StorageShard[]> {
    const result = await this.db
      .prepare(`${selectColumns} ORDER BY created_at ASC, id ASC`)
      .all<StorageShardRow>();
    return result.results.map(mapStorageShard);
  }

  async listByLogicalBucketId(
    logicalBucketId: string,
  ): Promise<readonly StorageShard[]> {
    const result = await this.db
      .prepare(
        `${selectColumns}
         WHERE logical_bucket_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .bind(logicalBucketId)
      .all<StorageShardRow>();
    return result.results.map(mapStorageShard);
  }

  async update(
    shard: StorageShard,
    expectedStatus: StorageShardStatus,
    expectedUpdatedAt: string,
  ): Promise<boolean> {
    if (!statuses.has(expectedStatus)) failClosed('expected_status');
    validateShard(shard);
    const result = await this.db
      .prepare(
        `UPDATE OR IGNORE storage_shards
         SET status = ?, capacity_bytes = ?, used_bytes = ?, updated_at = ?
         WHERE id = ? AND status = ? AND updated_at = ?`,
      )
      .bind(
        shard.status,
        shard.capacityBytes,
        shard.usedBytes,
        shard.updatedAt,
        shard.id,
        expectedStatus,
        expectedUpdatedAt,
      )
      .run();
    return result.meta.changes === 1;
  }
}
