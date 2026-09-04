export const shardMigrationStatuses = [
  'RUNNING',
  'COMPLETED',
  'FAILED',
] as const;

export type ShardMigrationStatus = (typeof shardMigrationStatuses)[number];

export const shardMigrationObjectStatuses = [
  'RESERVED',
  'SWITCHED',
  'COMPLETED',
  'FAILED',
] as const;

export type ShardMigrationObjectStatus =
  (typeof shardMigrationObjectStatuses)[number];

export interface ShardMigration {
  readonly id: string;
  readonly sourceShardId: string;
  readonly targetShardId: string;
  readonly status: ShardMigrationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface ShardMigrationObject {
  readonly id: string;
  readonly migrationId: string;
  readonly objectId: string;
  readonly sourceLocationId: string | null;
  readonly targetLocationId: string;
  readonly targetPhysicalKey: string;
  readonly status: ShardMigrationObjectStatus;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

const migrationTransitions: Readonly<
  Record<ShardMigrationStatus, readonly ShardMigrationStatus[]>
> = {
  RUNNING: ['COMPLETED', 'FAILED'],
  FAILED: ['RUNNING'],
  COMPLETED: [],
};

const objectTransitions: Readonly<
  Record<ShardMigrationObjectStatus, readonly ShardMigrationObjectStatus[]>
> = {
  RESERVED: ['SWITCHED', 'FAILED'],
  FAILED: ['RESERVED'],
  SWITCHED: ['COMPLETED'],
  COMPLETED: [],
};

export class ShardMigrationStateError extends Error {
  readonly code = 'INVALID_SHARD_MIGRATION_STATE_TRANSITION' as const;

  constructor(
    readonly from: ShardMigrationStatus,
    readonly to: ShardMigrationStatus,
  ) {
    super(`Cannot transition shard migration from ${from} to ${to}`);
    this.name = 'ShardMigrationStateError';
  }
}

export class ShardMigrationObjectStateError extends Error {
  readonly code = 'INVALID_SHARD_MIGRATION_OBJECT_STATE_TRANSITION' as const;

  constructor(
    readonly from: ShardMigrationObjectStatus,
    readonly to: ShardMigrationObjectStatus,
  ) {
    super(`Cannot transition shard migration object from ${from} to ${to}`);
    this.name = 'ShardMigrationObjectStateError';
  }
}

export function transitionShardMigrationStatus(
  migration: ShardMigration,
  status: ShardMigrationStatus,
  updatedAt: string,
): ShardMigration {
  if (!migrationTransitions[migration.status].includes(status)) {
    throw new ShardMigrationStateError(migration.status, status);
  }
  return {
    ...migration,
    status,
    updatedAt,
    completedAt: status === 'COMPLETED' ? updatedAt : null,
  };
}

export function transitionShardMigrationObjectStatus(
  task: ShardMigrationObject,
  status: ShardMigrationObjectStatus,
  updatedAt: string,
): ShardMigrationObject {
  if (!objectTransitions[task.status].includes(status)) {
    throw new ShardMigrationObjectStateError(task.status, status);
  }
  return {
    ...task,
    status,
    updatedAt,
    completedAt: status === 'COMPLETED' ? updatedAt : null,
  };
}

export function validateShardMigrationEndpoints(
  sourceShardId: string,
  targetShardId: string,
): void {
  if (
    !sourceShardId.trim() ||
    !targetShardId.trim() ||
    sourceShardId === targetShardId
  ) {
    throw new RangeError(
      'Shard migration needs distinct source and target shards',
    );
  }
}
