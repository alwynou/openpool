import { describe, expect, it } from 'vitest';

import {
  ProviderError,
  type ObjectLocation,
  type ShardMigration,
  type ShardMigrationObject,
  type StorageAccount,
  type StorageShard,
  type StoredObject,
} from '@openpool/domain';

import type { AuditLog, AuditLogEntry } from '../ports/auth';
import type {
  CredentialEnvelope,
  CredentialPayload,
  CredentialVault,
} from '../ports/credential-vault';
import type {
  ClaimShardMigrationTransferInput,
  ClaimShardMigrationTransferPersistenceResult,
  CompleteShardMigrationResult,
  CreateShardMigrationPersistenceResult,
  FinishShardMigrationCleanupResult,
  LogicalBucketRepository,
  ManagedStorageAccountRepository,
  ProviderRegistry,
  ShardMigrationProgress,
  ShardMigrationRepository,
  ShardMigrationTransferAggregate,
  StorageAccountRecord,
  StorageProvider,
  StorageShardRepository,
  SwitchShardMigrationPrimaryResult,
} from '../ports/storage';
import {
  ClaimShardMigrationTransfer,
  CompleteShardMigrationTransfer,
  GetShardMigration,
  ListShardMigrations,
  StartShardMigration,
  SweepShardMigrationCleanup,
} from './shard-migrations';

const capabilities = {
  presignedUpload: true,
  presignedDownload: true,
  headObject: true,
  deleteObject: true,
  bucketProbe: true,
  usageProbe: true,
};

const envelope: CredentialEnvelope = {
  version: 1,
  algorithm: 'AES-256-GCM',
  keyId: 'key-1',
  iv: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'encrypted',
};

function account(
  id: string,
  status: StorageAccount['status'],
): StorageAccountRecord {
  return {
    id,
    name: id,
    provider: 'r2',
    providerConfig: {},
    status,
    priority: 100,
    writeEnabled: status === 'ACTIVE',
    capacityBytes: 10_000,
    usedBytes: status === 'DRAINING' ? 100 : 0,
    healthStatus: 'HEALTHY',
    capacityAccuracy: 'CONFIGURED',
    capabilities,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastHealthCheckedAt: '2026-09-01T00:00:00.000Z',
    credentialEnvelope: envelope,
  };
}

const sourceAccount = account('account-source', 'DRAINING');
const targetAccount = account('account-target', 'ACTIVE');
const sourceShard: StorageShard = {
  id: 'shard-source',
  logicalBucketId: 'bucket-1',
  storageAccountId: sourceAccount.id,
  physicalBucket: 'source-bucket',
  status: 'ACTIVE',
  capacityBytes: 10_000,
  usedBytes: 100,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};
const targetShard: StorageShard = {
  ...sourceShard,
  id: 'shard-target',
  storageAccountId: targetAccount.id,
  physicalBucket: 'target-bucket',
  status: 'STANDBY',
  usedBytes: 0,
};

class FakeAccounts implements ManagedStorageAccountRepository {
  readonly values = new Map<string, StorageAccountRecord>([
    [sourceAccount.id, sourceAccount],
    [targetAccount.id, targetAccount],
  ]);

  async create(): Promise<boolean> {
    return true;
  }

  async findById(id: string) {
    return this.values.get(id);
  }

  async list() {
    return [...this.values.values()];
  }

  async listWritable() {
    return [...this.values.values()].filter(({ writeEnabled }) => writeEnabled);
  }

  async update(): Promise<boolean> {
    return true;
  }
}

class FakeShards implements StorageShardRepository {
  readonly values = new Map<string, StorageShard>([
    [sourceShard.id, sourceShard],
    [targetShard.id, targetShard],
  ]);

  async create(): Promise<boolean> {
    return true;
  }

  async findById(id: string) {
    return this.values.get(id);
  }

  async findActiveByLogicalBucketId() {
    return sourceShard;
  }

  async list() {
    return [...this.values.values()];
  }

  async listByLogicalBucketId() {
    return [...this.values.values()];
  }

  async update(): Promise<boolean> {
    return true;
  }
}

const migration: ShardMigration = {
  id: 'migration-1',
  sourceShardId: sourceShard.id,
  targetShardId: targetShard.id,
  status: 'RUNNING',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  completedAt: null,
};
const object: StoredObject = {
  id: 'object-1',
  logicalBucketId: 'bucket-1',
  logicalKey: 'reports/one.txt',
  sizeBytes: 100,
  contentType: 'text/plain',
  checksum: 'checksum-1',
  status: 'READY',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};
const sourceLocation: ObjectLocation = {
  id: 'location-source',
  objectId: object.id,
  storageAccountId: sourceAccount.id,
  storageShardId: sourceShard.id,
  physicalBucket: sourceShard.physicalBucket,
  physicalKey: 'objects/ob/object-1',
  etag: 'source-etag',
  isPrimary: true,
  createdAt: object.createdAt,
  updatedAt: object.updatedAt,
};
const targetLocation: ObjectLocation = {
  ...sourceLocation,
  id: 'location-target',
  storageAccountId: targetAccount.id,
  storageShardId: targetShard.id,
  physicalBucket: targetShard.physicalBucket,
  etag: null,
  isPrimary: false,
};
const task: ShardMigrationObject = {
  id: 'task-1',
  migrationId: migration.id,
  objectId: object.id,
  sourceLocationId: sourceLocation.id,
  targetLocationId: targetLocation.id,
  targetPhysicalKey: targetLocation.physicalKey,
  status: 'RESERVED',
  leaseToken: 'lease-1',
  leaseExpiresAt: '2026-09-01T00:15:00.000Z',
  attemptCount: 1,
  lastErrorCode: null,
  createdAt: migration.createdAt,
  updatedAt: migration.updatedAt,
  completedAt: null,
};

class FakeMigrations implements ShardMigrationRepository {
  audit?: AuditLog;
  current: ShardMigration | undefined;
  transfer: ShardMigrationTransferAggregate = {
    migration,
    task,
    object,
    sourceLocation,
    targetLocation,
  };
  createResult: CreateShardMigrationPersistenceResult = 'CREATED';
  claimResult: ClaimShardMigrationTransferPersistenceResult = {
    outcome: 'CLAIMED',
    transfer: this.transfer,
  };
  completeResult: CompleteShardMigrationResult = 'BLOCKED';
  switched = 0;
  cleaned = 0;

  async createAndCutover(
    value: ShardMigration,
    _expectedSourceUpdatedAt: string,
    _expectedTargetUpdatedAt: string,
    audit: AuditLogEntry,
  ) {
    if (this.createResult === 'CREATED') {
      this.current = value;
      await this.audit?.record(audit);
    }
    return this.createResult;
  }

  async findById(id: string) {
    if (this.current?.id === id) return this.current;
    return id === migration.id ? migration : undefined;
  }

  async listByLogicalBucketId(logicalBucketId: string) {
    return logicalBucketId === sourceShard.logicalBucketId
      ? [this.current ?? migration]
      : [];
  }

  async progress(id: string): Promise<ShardMigrationProgress | undefined> {
    return id === migration.id || id === this.current?.id
      ? {
          reserved: 1,
          switched: 0,
          completed: 0,
          failed: 0,
          remainingReady: 0,
          blocking: 0,
        }
      : undefined;
  }

  async claimTransfer(
    _input: ClaimShardMigrationTransferInput,
    audit: AuditLogEntry,
  ) {
    if (this.claimResult.outcome === 'CLAIMED') {
      await this.audit?.record(audit);
    }
    return this.claimResult;
  }

  async findTransfer(id: string, leaseToken: string) {
    return id === this.transfer.task.id && leaseToken === this.transfer.task.leaseToken
      ? this.transfer
      : undefined;
  }

  async listSourceCleanupCandidates() {
    return this.transfer.task.status === 'SWITCHED' ? [this.transfer] : [];
  }

  async switchPrimary(
    _taskId: string,
    _leaseToken: string,
    _etag: string | null,
    _updatedAt: string,
    audit: AuditLogEntry,
  ): Promise<SwitchShardMigrationPrimaryResult> {
    this.switched += 1;
    this.transfer = {
      ...this.transfer,
      task: { ...this.transfer.task, status: 'SWITCHED' },
      sourceLocation: { ...sourceLocation, isPrimary: false },
      targetLocation: { ...targetLocation, isPrimary: true },
    };
    await this.audit?.record(audit);
    return 'SWITCHED';
  }

  async finishSourceCleanup(
    _taskId: string,
    _updatedAt: string,
    audit: AuditLogEntry,
  ): Promise<FinishShardMigrationCleanupResult> {
    this.cleaned += 1;
    this.transfer = {
      ...this.transfer,
      task: { ...this.transfer.task, status: 'COMPLETED' },
      sourceLocation: null,
    };
    await this.audit?.record(audit);
    return 'COMPLETED';
  }

  async completeIfReady(
    _migrationId: string,
    _completedAt: string,
    audit: AuditLogEntry,
  ) {
    if (this.completeResult === 'COMPLETED') {
      await this.audit?.record(audit);
    }
    return this.completeResult;
  }
}

class FakeVault implements CredentialVault {
  readonly decrypted: string[] = [];

  async encrypt(): Promise<CredentialEnvelope> {
    return envelope;
  }

  async decrypt(): Promise<CredentialPayload> {
    const value = { accessKeyId: `credential-${this.decrypted.length + 1}` };
    this.decrypted.push(value.accessKeyId);
    return value;
  }
}

class FakeProvider implements StorageProvider {
  readonly capabilities = capabilities;
  readonly deleted: string[] = [];
  headSize = 100;
  headChecksum: string | null = 'checksum-1';
  deleteError: Error | undefined;

  async createUploadUrl() {
    return {
      url: 'https://target.example/upload-signed',
      expiresAt: '2026-09-01T00:15:00.000Z',
    };
  }

  async createDownloadUrl() {
    return {
      url: 'https://source.example/download-signed',
      expiresAt: '2026-09-01T00:15:00.000Z',
    };
  }

  async headObject() {
    return {
      sizeBytes: this.headSize,
      etag: 'target-etag',
      checksum: this.headChecksum,
    };
  }

  async deleteObject(request: { key: string }) {
    if (this.deleteError) throw this.deleteError;
    this.deleted.push(request.key);
  }

  async validate() {
    return { capabilities };
  }

  async probe() {
    return {
      healthStatus: 'HEALTHY' as const,
      capacityBytes: 10_000,
      usedBytes: 100,
      capacityAccuracy: 'EXACT' as const,
    };
  }
}

class FakeAudit implements AuditLog {
  readonly actions: string[] = [];

  async record(entry: AuditLogEntry) {
    this.actions.push(entry.action);
  }
}

function setup() {
  const accounts = new FakeAccounts();
  const shards = new FakeShards();
  const migrations = new FakeMigrations();
  const provider = new FakeProvider();
  const vault = new FakeVault();
  const audit = new FakeAudit();
  migrations.audit = audit;
  let id = 0;
  const providers: ProviderRegistry = { forAccount: () => provider };
  const common = {
    accounts,
    shards,
    migrations,
    provider,
    providers,
    vault,
    audit,
    ids: { next: () => `generated-${++id}` },
    clock: { now: () => new Date('2026-09-01T00:00:00.000Z') },
  };
  return common;
}

describe('shard migration use cases', () => {
  it('lists durable migration progress for a logical bucket', async () => {
    const deps = setup();
    const buckets: Pick<LogicalBucketRepository, 'findById'> = {
      findById: async (id) =>
        id === sourceShard.logicalBucketId
          ? {
              id,
              name: 'documents',
              description: null,
              createdAt: migration.createdAt,
              updatedAt: migration.updatedAt,
            }
          : undefined,
    };

    await expect(
      new ListShardMigrations(buckets, deps.migrations).execute(
        sourceShard.logicalBucketId,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        migration: expect.objectContaining({ id: migration.id }),
        progress: expect.objectContaining({ reserved: 1 }),
      }),
    ]);
    await expect(
      new ListShardMigrations(buckets, deps.migrations).execute('missing'),
    ).rejects.toMatchObject({ code: 'SHARD_MIGRATION_BUCKET_NOT_FOUND' });
  });

  it('starts a migration only from a draining account and safe target', async () => {
    const deps = setup();
    const result = await new StartShardMigration(deps).execute({
      actorId: 'admin-1',
      sourceShardId: sourceShard.id,
      targetShardId: targetShard.id,
      expectedSourceUpdatedAt: sourceShard.updatedAt,
      expectedTargetUpdatedAt: targetShard.updatedAt,
    });

    expect(result.migration).toMatchObject({
      id: 'generated-1',
      status: 'RUNNING',
      sourceShardId: sourceShard.id,
      targetShardId: targetShard.id,
    });
    expect(deps.audit.actions).toEqual(['SHARD_MIGRATION_STARTED']);
    await expect(
      new GetShardMigration(deps.migrations).execute(result.migration.id),
    ).resolves.toMatchObject({ migration: { id: result.migration.id } });
  });

  it('rejects a source account that is not draining', async () => {
    const deps = setup();
    deps.accounts.values.set(
      sourceAccount.id,
      account(sourceAccount.id, 'ACTIVE'),
    );

    await expect(
      new StartShardMigration(deps).execute({
        actorId: 'admin-1',
        sourceShardId: sourceShard.id,
        targetShardId: targetShard.id,
        expectedSourceUpdatedAt: sourceShard.updatedAt,
        expectedTargetUpdatedAt: targetShard.updatedAt,
      }),
    ).rejects.toMatchObject({ code: 'SHARD_MIGRATION_SOURCE_NOT_DRAINING' });
  });

  it('claims one-time signed source and target transfer instructions', async () => {
    const deps = setup();
    const result = await new ClaimShardMigrationTransfer(deps).execute({
      actorId: 'admin-1',
      migrationId: migration.id,
    });

    expect(result).toMatchObject({
      taskId: task.id,
      objectId: object.id,
      sizeBytes: object.sizeBytes,
      downloadUrl: 'https://source.example/download-signed',
      uploadUrl: 'https://target.example/upload-signed',
      leaseToken: task.leaseToken,
    });
    expect(deps.vault.decrypted).toHaveLength(2);
    expect(deps.audit.actions).toEqual([
      'SHARD_MIGRATION_TRANSFER_CLAIMED',
    ]);
  });

  it('verifies target metadata, switches primary, and cleans the source', async () => {
    const deps = setup();
    deps.migrations.completeResult = 'COMPLETED';

    const result = await new CompleteShardMigrationTransfer(deps).execute({
      actorId: 'admin-1',
      taskId: task.id,
      leaseToken: task.leaseToken,
    });

    expect(result).toEqual({
      taskId: task.id,
      status: 'COMPLETED',
      migrationCompleted: true,
    });
    expect(deps.migrations.switched).toBe(1);
    expect(deps.migrations.cleaned).toBe(1);
    expect(deps.provider.deleted).toEqual([sourceLocation.physicalKey]);
    expect(deps.audit.actions).toEqual([
      'SHARD_MIGRATION_OBJECT_SWITCHED',
      'SHARD_MIGRATION_OBJECT_COMPLETED',
      'SHARD_MIGRATION_COMPLETED',
    ]);
  });

  it('keeps source primary when target metadata does not match', async () => {
    const deps = setup();
    deps.provider.headSize = 99;

    await expect(
      new CompleteShardMigrationTransfer(deps).execute({
        actorId: 'admin-1',
        taskId: task.id,
        leaseToken: task.leaseToken,
      }),
    ).rejects.toMatchObject({ code: 'SHARD_MIGRATION_TARGET_MISMATCH' });
    expect(deps.migrations.switched).toBe(0);
    expect(deps.migrations.cleaned).toBe(0);
    expect(deps.provider.deleted).toEqual([]);
  });

  it('never cleans the source for a failed transfer task', async () => {
    const deps = setup();
    deps.migrations.transfer = {
      ...deps.migrations.transfer,
      task: { ...deps.migrations.transfer.task, status: 'FAILED' },
    };

    await expect(
      new CompleteShardMigrationTransfer(deps).execute({
        actorId: 'admin-1',
        taskId: task.id,
        leaseToken: task.leaseToken,
      }),
    ).rejects.toMatchObject({ code: 'SHARD_MIGRATION_CONFLICT' });
    expect(deps.migrations.switched).toBe(0);
    expect(deps.migrations.cleaned).toBe(0);
    expect(deps.provider.deleted).toEqual([]);
  });

  it('scheduled cleanup recovers a switched task and treats an absent source as deleted', async () => {
    const deps = setup();
    deps.migrations.transfer = {
      ...deps.migrations.transfer,
      task: { ...deps.migrations.transfer.task, status: 'SWITCHED' },
      sourceLocation: { ...sourceLocation, isPrimary: false },
      targetLocation: { ...targetLocation, isPrimary: true },
    };
    deps.migrations.completeResult = 'COMPLETED';
    deps.provider.deleteError = new ProviderError('NOT_FOUND');

    await expect(
      new SweepShardMigrationCleanup(deps).execute(),
    ).resolves.toEqual({
      candidates: 1,
      cleaned: 1,
      completedMigrations: 1,
      failed: 0,
    });
    expect(deps.migrations.cleaned).toBe(1);
    expect(deps.audit.actions).toEqual([
      'SHARD_MIGRATION_OBJECT_COMPLETED',
      'SHARD_MIGRATION_COMPLETED',
    ]);
  });
});
