import { describe, expect, it } from 'vitest';

import {
  transitionStorageShardStatus,
  validatePhysicalBucketName,
  validateStorageShardCapacity,
} from './storage-shard';
import type { StorageShard } from './storage-shard';

const shard: StorageShard = {
  id: 'shard-1',
  logicalBucketId: 'bucket-1',
  storageAccountId: 'account-1',
  physicalBucket: 'physical-bucket',
  status: 'STANDBY',
  capacityBytes: 1_000,
  usedBytes: 100,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('storage shard domain rules', () => {
  it('allows conservative lifecycle transitions', () => {
    expect(transitionStorageShardStatus(shard, 'ACTIVE').status).toBe('ACTIVE');
    expect(
      transitionStorageShardStatus(
        transitionStorageShardStatus(shard, 'ACTIVE'),
        'MIGRATING',
      ).status,
    ).toBe('MIGRATING');
    expect(() => transitionStorageShardStatus(shard, 'READ_ONLY')).toThrow(
      'Cannot transition storage shard',
    );
    expect(() =>
      transitionStorageShardStatus({ ...shard, status: 'RETIRED' }, 'ACTIVE'),
    ).toThrow('Cannot transition storage shard');
  });

  it('validates physical names and capacity without provider assumptions', () => {
    expect(() => validatePhysicalBucketName('r2-bucket')).not.toThrow();
    expect(() => validatePhysicalBucketName('')).toThrow(RangeError);
    expect(() => validatePhysicalBucketName('bucket\nname')).toThrow(RangeError);
    expect(() => validateStorageShardCapacity(100, 100)).not.toThrow();
    expect(() => validateStorageShardCapacity(100, 101)).toThrow(RangeError);
    expect(() => validateStorageShardCapacity(Number.MAX_SAFE_INTEGER + 1, 0)).toThrow(
      RangeError,
    );
  });
});
