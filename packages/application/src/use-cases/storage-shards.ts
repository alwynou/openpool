import {
  hasWriteCapabilities,
  isWritableStorageShard,
  transitionStorageShardStatus,
  validatePhysicalBucketName,
  validateStorageShardCapacity,
  type StorageAccount,
  type StorageShard,
  type StorageShardStatus,
} from '@openpool/domain';

import type { AuditLog } from '../ports/auth';
import type {
  Clock,
  IdGenerator,
  LogicalBucketRepository,
  ManagedStorageAccountRepository,
  StorageShardRepository,
} from '../ports/storage';

export type StorageShardErrorCode =
  | 'STORAGE_SHARD_INVALID_INPUT'
  | 'STORAGE_SHARD_ALREADY_EXISTS'
  | 'STORAGE_SHARD_NOT_FOUND'
  | 'STORAGE_SHARD_BUCKET_NOT_FOUND'
  | 'STORAGE_SHARD_ACCOUNT_NOT_FOUND'
  | 'STORAGE_SHARD_ACCOUNT_UNAVAILABLE'
  | 'STORAGE_SHARD_ACTIVE_CONFLICT'
  | 'STORAGE_SHARD_CONFLICT'
  | 'STORAGE_SHARD_INVALID_STATE_TRANSITION';

export class StorageShardApplicationError extends Error {
  constructor(
    readonly code: StorageShardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StorageShardApplicationError';
  }
}

export interface CreateStorageShardCommand {
  readonly actorId: string;
  readonly logicalBucketId: string;
  readonly storageAccountId: string;
  readonly physicalBucket: string;
  readonly status?: StorageShardStatus;
  readonly capacityBytes?: number;
  readonly usedBytes?: number;
}

export interface StorageShardMutationDependencies {
  readonly buckets: Pick<LogicalBucketRepository, 'findById'>;
  readonly accounts: Pick<ManagedStorageAccountRepository, 'findById'>;
  readonly shards: StorageShardRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly audit: AuditLog;
}

function invalidInput(message: string): StorageShardApplicationError {
  return new StorageShardApplicationError(
    'STORAGE_SHARD_INVALID_INPUT',
    message,
  );
}

function assertInput(command: CreateStorageShardCommand): void {
  if (!command.logicalBucketId.trim() || !command.storageAccountId.trim()) {
    throw invalidInput('Logical bucket and storage account are required');
  }
  try {
    validatePhysicalBucketName(command.physicalBucket.trim());
  } catch {
    throw invalidInput('Physical bucket or capacity is invalid');
  }
  if (
    (command.capacityBytes !== undefined &&
      (!Number.isSafeInteger(command.capacityBytes) ||
        command.capacityBytes < 0)) ||
    (command.usedBytes !== undefined &&
      (!Number.isSafeInteger(command.usedBytes) || command.usedBytes < 0))
  ) {
    throw invalidInput('Physical bucket or capacity is invalid');
  }
  if (
    command.status !== undefined &&
    command.status !== 'STANDBY' &&
    command.status !== 'ACTIVE'
  ) {
    throw invalidInput('A new storage shard must be standby or active');
  }
  if (command.status === 'ACTIVE' && command.capacityBytes === undefined) {
    throw invalidInput('An active shard must have explicit capacity');
  }
}

function accountCanHostShard(account: StorageAccount): boolean {
  return (
    account.status === 'ACTIVE' &&
    account.writeEnabled &&
    account.healthStatus === 'HEALTHY' &&
    account.capacityAccuracy !== 'UNKNOWN' &&
    hasWriteCapabilities(account.capabilities)
  );
}

export class CreateStorageShard {
  constructor(private readonly dependencies: StorageShardMutationDependencies) {}

  async execute(command: CreateStorageShardCommand): Promise<StorageShard> {
    assertInput(command);
    if (!(await this.dependencies.buckets.findById(command.logicalBucketId))) {
      throw new StorageShardApplicationError(
        'STORAGE_SHARD_BUCKET_NOT_FOUND',
        'Logical bucket was not found',
      );
    }
    const account = await this.dependencies.accounts.findById(
      command.storageAccountId,
    );
    if (!account) {
      throw new StorageShardApplicationError(
        'STORAGE_SHARD_ACCOUNT_NOT_FOUND',
        'Storage account was not found',
      );
    }
    if (!accountCanHostShard(account)) {
      throw new StorageShardApplicationError(
        'STORAGE_SHARD_ACCOUNT_UNAVAILABLE',
        'Storage account cannot host a new shard',
      );
    }

    const status = command.status ?? 'STANDBY';
    if (status === 'ACTIVE') {
      const active = await this.dependencies.shards.findActiveByLogicalBucketId(
        command.logicalBucketId,
      );
      if (active) {
        throw activeShardConflict();
      }
    }
    const now = this.dependencies.clock.now().toISOString();
    const capacityBytes = command.capacityBytes ?? account.capacityBytes;
    const usedBytes = command.usedBytes ?? account.usedBytes;
    try {
      validateStorageShardCapacity(capacityBytes, usedBytes);
    } catch {
      throw invalidInput('Physical bucket or capacity is invalid');
    }
    const shard: StorageShard = {
      id: this.dependencies.ids.next(),
      logicalBucketId: command.logicalBucketId,
      storageAccountId: command.storageAccountId,
      physicalBucket: command.physicalBucket.trim(),
      status,
      capacityBytes,
      usedBytes,
      createdAt: now,
      updatedAt: now,
    };
    if (!(await this.dependencies.shards.create(shard))) {
      if (status === 'ACTIVE') throw activeShardConflict();
      throw new StorageShardApplicationError(
        'STORAGE_SHARD_ALREADY_EXISTS',
        'The storage shard already exists',
      );
    }
    await this.dependencies.audit.record({
      actorType: 'ADMIN',
      actorId: command.actorId,
      action: 'STORAGE_SHARD_CREATED',
      resourceType: 'STORAGE_SHARD',
      resourceId: shard.id,
      createdAt: now,
      metadata: { status: shard.status },
    });
    return shard;
  }
}

export class ListStorageShards {
  constructor(
    private readonly shards: Pick<StorageShardRepository, 'list' | 'listByLogicalBucketId'>,
  ) {}

  execute(logicalBucketId?: string): Promise<readonly StorageShard[]> {
    return logicalBucketId === undefined
      ? this.shards.list()
      : this.shards.listByLogicalBucketId(logicalBucketId);
  }
}

/** Lookup used by the future object reserve/upload flow. */
export class FindActiveStorageShard {
  constructor(
    private readonly shards: Pick<StorageShardRepository, 'findActiveByLogicalBucketId'>,
  ) {}

  execute(logicalBucketId: string): Promise<StorageShard | undefined> {
    return this.shards.findActiveByLogicalBucketId(logicalBucketId);
  }
}

export class TransitionStorageShard {
  constructor(
    private readonly dependencies: Pick<
      StorageShardMutationDependencies,
      'shards' | 'accounts' | 'clock' | 'audit'
    >,
  ) {}

  async execute(command: {
    readonly actorId: string;
    readonly shardId: string;
    readonly status: StorageShardStatus;
  }): Promise<StorageShard> {
    const current = await this.dependencies.shards.findById(command.shardId);
    if (!current) {
      throw new StorageShardApplicationError(
        'STORAGE_SHARD_NOT_FOUND',
        'Storage shard was not found',
      );
    }
    let shard: StorageShard;
    try {
      shard = transitionStorageShardStatus(current, command.status);
    } catch {
      throw new StorageShardApplicationError(
        'STORAGE_SHARD_INVALID_STATE_TRANSITION',
        'Storage shard state transition is not allowed',
      );
    }
    if (current.status === 'ACTIVE' && shard.status === 'READ_ONLY') {
      const account = await this.dependencies.accounts.findById(
        shard.storageAccountId,
      );
      if (!account) {
        throw new StorageShardApplicationError(
          'STORAGE_SHARD_ACCOUNT_NOT_FOUND',
          'Storage account was not found',
        );
      }
      if (account.status !== 'ACTIVE') {
        throw new StorageShardApplicationError(
          'STORAGE_SHARD_INVALID_STATE_TRANSITION',
          'A shard on a draining account must be retired through migration',
        );
      }
    }
    if (isWritableStorageShard(shard)) {
      const account = await this.dependencies.accounts.findById(
        shard.storageAccountId,
      );
      if (!account) {
        throw new StorageShardApplicationError(
          'STORAGE_SHARD_ACCOUNT_NOT_FOUND',
          'Storage account was not found',
        );
      }
      if (!accountCanHostShard(account)) {
        throw new StorageShardApplicationError(
          'STORAGE_SHARD_ACCOUNT_UNAVAILABLE',
          'Storage account cannot host an active shard',
        );
      }
      const active =
        await this.dependencies.shards.findActiveByLogicalBucketId(
          shard.logicalBucketId,
        );
      if (active && active.id !== shard.id) throw activeShardConflict();
    }
    const now = this.dependencies.clock.now().toISOString();
    shard = { ...shard, updatedAt: now };
    if (
      !(await this.dependencies.shards.update(
        shard,
        current.status,
        current.updatedAt,
      ))
    ) {
      throw new StorageShardApplicationError(
        'STORAGE_SHARD_CONFLICT',
        'Storage shard changed while the operation was in progress',
      );
    }
    await this.dependencies.audit.record({
      actorType: 'ADMIN',
      actorId: command.actorId,
      action: 'STORAGE_SHARD_STATUS_CHANGED',
      resourceType: 'STORAGE_SHARD',
      resourceId: shard.id,
      createdAt: now,
      metadata: { from: current.status, to: shard.status },
    });
    return shard;
  }
}

function activeShardConflict(): StorageShardApplicationError {
  return new StorageShardApplicationError(
    'STORAGE_SHARD_ACTIVE_CONFLICT',
    'A logical bucket can have only one active storage shard',
  );
}
