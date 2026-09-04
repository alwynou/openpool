import { describe, expect, it } from 'vitest';

import type {
  StorageAccountResponse,
  StorageShardResponse,
} from '@openpool/contracts';

import { eligibleMigrationTargets } from './shard-migrations';

const capabilities = {
  presignedUpload: true,
  presignedDownload: true,
  headObject: true,
  deleteObject: true,
  bucketProbe: true,
  usageProbe: true,
};

function account(
  id: string,
  status: StorageAccountResponse['status'],
): StorageAccountResponse {
  return {
    id,
    name: id,
    provider: 'r2',
    providerConfig: {},
    status,
    priority: 100,
    writeEnabled: status === 'ACTIVE',
    capacityBytes: 10_000,
    usedBytes: 0,
    availableBytes: 10_000,
    healthStatus: 'HEALTHY',
    capacityAccuracy: 'CONFIGURED',
    capabilities,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastHealthCheckedAt: '2026-09-01T00:00:00.000Z',
  };
}

function shard(
  id: string,
  storageAccountId: string,
  status: StorageShardResponse['status'],
): StorageShardResponse {
  return {
    id,
    logicalBucketId: 'bucket-1',
    storageAccountId,
    physicalBucket: id,
    status,
    capacityBytes: 10_000,
    usedBytes: id === 'source' ? 100 : 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('eligibleMigrationTargets', () => {
  it('keeps only healthy active standby targets with soft capacity', () => {
    const source = shard('source', 'source-account', 'ACTIVE');
    const eligible = shard('eligible', 'target-account', 'STANDBY');
    const active = shard('active-target', 'target-account', 'ACTIVE');
    const small = { ...shard('small', 'target-account', 'STANDBY'), capacityBytes: 100 };

    expect(
      eligibleMigrationTargets(
        source,
        [source, eligible, active, small],
        [
          account('source-account', 'DRAINING'),
          account('target-account', 'ACTIVE'),
        ],
      ),
    ).toEqual([eligible]);
  });

  it('requires a draining source and a fully capable target account', () => {
    const source = shard('source', 'source-account', 'ACTIVE');
    const target = shard('target', 'target-account', 'STANDBY');
    const incapable = {
      ...account('target-account', 'ACTIVE'),
      capabilities: { ...capabilities, presignedUpload: false },
    };

    expect(
      eligibleMigrationTargets(source, [source, target], [
        account('source-account', 'ACTIVE'),
        account('target-account', 'ACTIVE'),
      ]),
    ).toEqual([]);
    expect(
      eligibleMigrationTargets(source, [source, target], [
        account('source-account', 'DRAINING'),
        incapable,
      ]),
    ).toEqual([]);
  });
});
