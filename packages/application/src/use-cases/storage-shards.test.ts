import { describe, expect, it } from 'vitest';

import type {
  ProviderCapabilities,
  StorageShard,
} from '@openpool/domain';
import type { AuditLog } from '../ports/auth';
import type {
  CredentialEnvelope,
} from '../ports/credential-vault';
import type {
  Clock,
  IdGenerator,
  LogicalBucketRepository,
  ManagedStorageAccountRepository,
  StorageAccountRecord,
  StorageShardRepository,
} from '../ports/storage';
import {
  CreateStorageShard,
  FindActiveStorageShard,
  ListStorageShards,
  StorageShardApplicationError,
  TransitionStorageShard,
} from './storage-shards';

const account: StorageAccountRecord = {
  id: 'account-1',
  name: 'primary',
  provider: 'r2',
  providerConfig: {},
  status: 'ACTIVE',
  priority: 0,
  writeEnabled: true,
  capacityBytes: 10_000,
  usedBytes: 100,
  healthStatus: 'HEALTHY',
  capacityAccuracy: 'EXACT',
  capabilities: {
    presignedUpload: true,
    presignedDownload: true,
    headObject: true,
    deleteObject: true,
    bucketProbe: true,
    usageProbe: true,
  } satisfies ProviderCapabilities,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastHealthCheckedAt: '2026-01-01T00:00:00.000Z',
  credentialEnvelope: {
    version: 1,
    algorithm: 'AES-256-GCM',
    keyId: 'key-1',
    iv: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'ciphertext',
  } satisfies CredentialEnvelope,
};

class FakeBuckets implements LogicalBucketRepository {
  readonly bucket = {
    id: 'bucket-1',
    name: 'documents',
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  async create(): Promise<boolean> {
    return true;
  }

  async findById(id: string) {
    return id === this.bucket.id ? this.bucket : undefined;
  }

  async list() {
    return [this.bucket];
  }
}

class FakeAccounts implements ManagedStorageAccountRepository {
  async create(): Promise<boolean> {
    return true;
  }

  async findById(id: string): Promise<StorageAccountRecord | undefined> {
    return id === account.id ? account : undefined;
  }

  async list() {
    return [account];
  }

  async listWritable() {
    return [account];
  }

  async update(): Promise<boolean> {
    return true;
  }
}

class FakeShards implements StorageShardRepository {
  readonly values = new Map<string, StorageShard>();
  forceConflict = false;

  async create(shard: StorageShard): Promise<boolean> {
    if (
      this.values.has(shard.id) ||
      (shard.status === 'ACTIVE' &&
        [...this.values.values()].some(
          (value) =>
            value.logicalBucketId === shard.logicalBucketId &&
            value.status === 'ACTIVE',
        ))
    ) {
      return false;
    }
    this.values.set(shard.id, shard);
    return true;
  }

  async findById(id: string) {
    return this.values.get(id);
  }

  async findActiveByLogicalBucketId(logicalBucketId: string) {
    return [...this.values.values()].find(
      (shard) =>
        shard.logicalBucketId === logicalBucketId && shard.status === 'ACTIVE',
    );
  }

  async list() {
    return [...this.values.values()];
  }

  async listByLogicalBucketId(logicalBucketId: string) {
    return [...this.values.values()].filter(
      (shard) => shard.logicalBucketId === logicalBucketId,
    );
  }

  async update(shard: StorageShard, expectedStatus: StorageShard['status']) {
    if (this.forceConflict) return false;
    const current = this.values.get(shard.id);
    if (!current || current.status !== expectedStatus) return false;
    if (
      shard.status === 'ACTIVE' &&
      [...this.values.values()].some(
        (value) =>
          value.id !== shard.id &&
          value.logicalBucketId === shard.logicalBucketId &&
          value.status === 'ACTIVE',
      )
    ) {
      return false;
    }
    this.values.set(shard.id, shard);
    return true;
  }
}

class FakeAudit implements AuditLog {
  readonly actions: string[] = [];

  async record(entry: { action: string }): Promise<void> {
    this.actions.push(entry.action);
  }
}

const clock: Clock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
};

function setup() {
  const shards = new FakeShards();
  const audit = new FakeAudit();
  const dependencies = {
    buckets: new FakeBuckets(),
    accounts: new FakeAccounts(),
    shards,
    audit,
    clock,
    ids: { next: () => `shard-${shards.values.size + 1}` } satisfies IdGenerator,
  };
  return { ...dependencies, create: new CreateStorageShard(dependencies) };
}

describe('storage shard use cases', () => {
  it('creates a standby shard using account capacity and audits it', async () => {
    const deps = setup();
    await expect(
      deps.create.execute({
        actorId: 'admin-1',
        logicalBucketId: 'bucket-1',
        storageAccountId: 'account-1',
        physicalBucket: ' physical-bucket ',
      }),
    ).resolves.toMatchObject({
      status: 'STANDBY',
      physicalBucket: 'physical-bucket',
      capacityBytes: 10_000,
      usedBytes: 100,
    });
    expect(deps.audit.actions).toEqual(['STORAGE_SHARD_CREATED']);
  });

  it('allows only one active shard per logical bucket, including races', async () => {
    const deps = setup();
    const first = await deps.create.execute({
      actorId: 'admin-1',
      logicalBucketId: 'bucket-1',
      storageAccountId: 'account-1',
      physicalBucket: 'physical-one',
    });
    await expect(
      new TransitionStorageShard(deps).execute({
        actorId: 'admin-1',
        shardId: first.id,
        status: 'ACTIVE',
      }),
    ).resolves.toMatchObject({ status: 'ACTIVE' });

    await expect(
      deps.create.execute({
        actorId: 'admin-1',
        logicalBucketId: 'bucket-1',
        storageAccountId: 'account-1',
        physicalBucket: 'physical-two',
        status: 'ACTIVE',
        capacityBytes: 10_000,
        usedBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_SHARD_ACTIVE_CONFLICT' });
    expect(deps.audit.actions).toEqual([
      'STORAGE_SHARD_CREATED',
      'STORAGE_SHARD_STATUS_CHANGED',
    ]);
  });

  it('supports listing and active-shard lookup without mutation', async () => {
    const deps = setup();
    const shard = await deps.create.execute({
      actorId: 'admin-1',
      logicalBucketId: 'bucket-1',
      storageAccountId: 'account-1',
      physicalBucket: 'physical-one',
    });
    const list = await new ListStorageShards(deps.shards).execute('bucket-1');
    expect(list).toHaveLength(1);
    expect(
      await new FindActiveStorageShard(deps.shards).execute('bucket-1'),
    ).toBeUndefined();
    await new TransitionStorageShard(deps).execute({
      actorId: 'admin-1',
      shardId: shard.id,
      status: 'ACTIVE',
    });
    expect(
      await new FindActiveStorageShard(deps.shards).execute('bucket-1'),
    ).toMatchObject({ physicalBucket: 'physical-one', storageAccountId: 'account-1' });
  });

  it('rejects missing resources and concurrent conditional-update conflicts', async () => {
    const deps = setup();
    await expect(
      deps.create.execute({
        actorId: 'admin-1',
        logicalBucketId: 'missing',
        storageAccountId: 'account-1',
        physicalBucket: 'physical-one',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_SHARD_BUCKET_NOT_FOUND' });
    const shard = await deps.create.execute({
      actorId: 'admin-1',
      logicalBucketId: 'bucket-1',
      storageAccountId: 'account-1',
      physicalBucket: 'physical-one',
    });
    deps.shards.forceConflict = true;
    await expect(
      new TransitionStorageShard(deps).execute({
        actorId: 'admin-1',
        shardId: shard.id,
        status: 'ACTIVE',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_SHARD_CONFLICT' });
    expect(deps.audit.actions).toEqual(['STORAGE_SHARD_CREATED']);
  });

  it('exposes stable invalid-input errors', async () => {
    const deps = setup();
    await expect(
      deps.create.execute({
        actorId: 'admin-1',
        logicalBucketId: 'bucket-1',
        storageAccountId: 'account-1',
        physicalBucket: '',
      }),
    ).rejects.toBeInstanceOf(StorageShardApplicationError);
    await expect(
      deps.create.execute({
        actorId: 'admin-1',
        logicalBucketId: 'bucket-1',
        storageAccountId: 'account-1',
        physicalBucket: 'physical-one',
        status: 'RETIRED',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_SHARD_INVALID_INPUT' });
    await expect(
      deps.create.execute({
        actorId: 'admin-1',
        logicalBucketId: 'bucket-1',
        storageAccountId: 'account-1',
        physicalBucket: 'physical-one',
        capacityBytes: 50,
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_SHARD_INVALID_INPUT' });
  });
});
