export interface CreateLogicalBucketRequest {
  readonly name: string;
  readonly description?: string | null;
}

/** Public logical namespace; it contains no provider-specific details. */
export interface LogicalBucketResponse {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type StorageShardStatus =
  | 'STANDBY'
  | 'ACTIVE'
  | 'READ_ONLY'
  | 'MIGRATING'
  | 'RETIRED';

export interface CreateStorageShardRequest {
  readonly storageAccountId: string;
  readonly physicalBucket: string;
  readonly status?: 'STANDBY' | 'ACTIVE';
  readonly capacityBytes?: number;
  readonly usedBytes?: number;
}

/** Safe public representation; account credentials and envelopes are omitted. */
export interface StorageShardResponse {
  readonly id: string;
  readonly logicalBucketId: string;
  readonly storageAccountId: string;
  readonly physicalBucket: string;
  readonly status: StorageShardStatus;
  readonly capacityBytes: number;
  readonly usedBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateStorageShardStatusRequest {
  readonly status: StorageShardStatus;
}

/** Stable errors shared by the logical bucket and storage shard endpoints. */
export type BucketErrorCode =
  | 'UNAUTHORIZED'
  | 'LOGICAL_BUCKET_INVALID'
  | 'LOGICAL_BUCKET_NOT_FOUND'
  | 'LOGICAL_BUCKET_ALREADY_EXISTS'
  | 'STORAGE_SHARD_INVALID'
  | 'STORAGE_SHARD_NOT_FOUND'
  | 'STORAGE_SHARD_BUCKET_NOT_FOUND'
  | 'STORAGE_SHARD_ACCOUNT_NOT_FOUND'
  | 'STORAGE_SHARD_ACCOUNT_UNAVAILABLE'
  | 'STORAGE_SHARD_ACTIVE_CONFLICT'
  | 'STORAGE_SHARD_ALREADY_EXISTS'
  | 'STORAGE_SHARD_CONFLICT'
  | 'STORAGE_SHARD_INVALID_STATE_TRANSITION';
