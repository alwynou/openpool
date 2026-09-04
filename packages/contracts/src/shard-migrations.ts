export type ShardMigrationStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface StartShardMigrationRequest {
  readonly sourceShardId: string;
  readonly targetShardId: string;
  readonly expectedSourceUpdatedAt: string;
  readonly expectedTargetUpdatedAt: string;
}

export interface ShardMigrationProgressResponse {
  readonly reserved: number;
  readonly switched: number;
  readonly completed: number;
  readonly failed: number;
  readonly remainingReady: number;
  readonly blocking: number;
}

export interface ShardMigrationResponse {
  readonly id: string;
  readonly sourceShardId: string;
  readonly targetShardId: string;
  readonly status: ShardMigrationStatus;
  readonly progress: ShardMigrationProgressResponse;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/** One-time direct-transfer instructions; signed URLs are never persisted. */
export interface ShardMigrationTransferResponse {
  readonly taskId: string;
  readonly objectId: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly downloadUrl: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
  readonly leaseToken: string;
}

export interface CompleteShardMigrationTransferRequest {
  readonly leaseToken: string;
}

export interface CompleteShardMigrationTransferResponse {
  readonly taskId: string;
  readonly status: 'SWITCHED' | 'COMPLETED';
  readonly migrationCompleted: boolean;
}

export type ShardMigrationErrorCode =
  | 'UNAUTHORIZED'
  | 'SHARD_MIGRATION_INVALID'
  | 'SHARD_MIGRATION_BUCKET_NOT_FOUND'
  | 'SHARD_MIGRATION_NOT_FOUND'
  | 'SHARD_MIGRATION_SOURCE_NOT_FOUND'
  | 'SHARD_MIGRATION_TARGET_NOT_FOUND'
  | 'SHARD_MIGRATION_ACCOUNT_NOT_FOUND'
  | 'SHARD_MIGRATION_SOURCE_NOT_DRAINING'
  | 'SHARD_MIGRATION_TARGET_UNAVAILABLE'
  | 'SHARD_MIGRATION_ALREADY_RUNNING'
  | 'SHARD_MIGRATION_CONFLICT'
  | 'SHARD_MIGRATION_CAPACITY_UNAVAILABLE'
  | 'SHARD_MIGRATION_NO_TRANSFER_AVAILABLE'
  | 'SHARD_MIGRATION_TRANSFER_NOT_FOUND'
  | 'SHARD_MIGRATION_TRANSFER_EXPIRED'
  | 'SHARD_MIGRATION_TARGET_MISMATCH'
  | 'SHARD_MIGRATION_BLOCKED'
  | 'PROVIDER_INVALID_CREDENTIALS'
  | 'PROVIDER_FORBIDDEN'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_UNSUPPORTED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_QUOTA_EXCEEDED'
  | 'PROVIDER_PROTOCOL_ERROR'
  | 'CREDENTIAL_VAULT_UNAVAILABLE';
