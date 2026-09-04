export const storageShardStatuses = [
  'STANDBY',
  'ACTIVE',
  'READ_ONLY',
  'MIGRATING',
  'RETIRED',
] as const;

export type StorageShardStatus = (typeof storageShardStatuses)[number];

export interface StorageShard {
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

const allowedTransitions: Readonly<
  Record<StorageShardStatus, readonly StorageShardStatus[]>
> = {
  STANDBY: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['READ_ONLY'],
  READ_ONLY: ['RETIRED'],
  // MIGRATING is owned by the durable migration workflow, not manual status APIs.
  MIGRATING: [],
  RETIRED: [],
};

export class StorageShardStateError extends Error {
  readonly code = 'INVALID_STORAGE_SHARD_STATE_TRANSITION' as const;

  constructor(
    readonly from: StorageShardStatus,
    readonly to: StorageShardStatus,
  ) {
    super(`Cannot transition storage shard from ${from} to ${to}`);
    this.name = 'StorageShardStateError';
  }
}

/** Apply a legal shard lifecycle transition. */
export function transitionStorageShardStatus(
  shard: StorageShard,
  nextStatus: StorageShardStatus,
): StorageShard {
  if (!allowedTransitions[shard.status].includes(nextStatus)) {
    throw new StorageShardStateError(shard.status, nextStatus);
  }

  return { ...shard, status: nextStatus };
}

export const transitionStorageShard = transitionStorageShardStatus;

export function isWritableStorageShard(shard: StorageShard): boolean {
  return shard.status === 'ACTIVE';
}

export function validateStorageShardCapacity(
  capacityBytes: number,
  usedBytes: number,
): void {
  if (
    !Number.isSafeInteger(capacityBytes) ||
    capacityBytes < 0 ||
    !Number.isSafeInteger(usedBytes) ||
    usedBytes < 0 ||
    usedBytes > capacityBytes
  ) {
    throw new RangeError(
      'Storage shard capacity must be safe, non-negative, and consistent',
    );
  }
}

export function validatePhysicalBucketName(name: string): void {
  if (name.length === 0 || name.length > 255) {
    throw new RangeError('Physical bucket name must be 1-255 characters');
  }

  for (const character of name) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || codePoint === 0x7f)
    ) {
      throw new RangeError('Physical bucket name contains a control character');
    }
  }
}
