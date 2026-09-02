import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AuditLogEntry, CredentialEnvelope } from '@openpool/application';
import type {
  LogicalBucket,
  ShardMigration,
  StorageAccount,
  StorageShard,
  StoredObject,
  ObjectLocation,
  UploadSession,
} from '@openpool/domain';

import {
  D1AuditOutboxRepository,
  D1LogicalBucketRepository,
  D1ObjectRepository,
  D1ShardMigrationRepository,
  D1StorageAccountRepository,
  D1StorageShardRepository,
} from '../src/adapters/d1';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;
const auditOutbox = new D1AuditOutboxRepository(testEnv.DB);
const accounts = new D1StorageAccountRepository(testEnv.DB, auditOutbox);
const buckets = new D1LogicalBucketRepository(testEnv.DB, auditOutbox);
const shards = new D1StorageShardRepository(testEnv.DB, auditOutbox);
const objects = new D1ObjectRepository(testEnv.DB, auditOutbox);
const migrations = new D1ShardMigrationRepository(testEnv.DB, auditOutbox);

const envelope: CredentialEnvelope = {
  version: 1,
  algorithm: 'AES-256-GCM',
  keyId: 'test-key',
  iv: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'encrypted',
};

const capabilities = {
  presignedUpload: true,
  presignedDownload: true,
  headObject: true,
  deleteObject: true,
  bucketProbe: true,
  usageProbe: true,
};

function account(id: string, name: string): StorageAccount {
  return {
    id,
    name,
    provider: 'r2',
    providerConfig: {},
    status: 'ACTIVE',
    priority: 100,
    writeEnabled: true,
    capacityBytes: 10_000,
    usedBytes: 0,
    healthStatus: 'HEALTHY',
    capacityAccuracy: 'CONFIGURED',
    capabilities,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastHealthCheckedAt: '2026-09-01T00:00:00.000Z',
  };
}

const bucket: LogicalBucket = {
  id: 'bucket-1',
  name: 'documents',
  description: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function shard(
  id: string,
  storageAccountId: string,
  status: StorageShard['status'],
): StorageShard {
  return {
    id,
    logicalBucketId: bucket.id,
    storageAccountId,
    physicalBucket: `${id}-physical`,
    status,
    capacityBytes: 10_000,
    usedBytes: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function setupAudit(
  action: 'STORAGE_ACCOUNT_CREATED' | 'STORAGE_SHARD_CREATED',
  resourceType: 'STORAGE_ACCOUNT' | 'STORAGE_SHARD',
  resourceId: string,
): AuditLogEntry {
  return {
    actorType: 'SYSTEM',
    actorId: null,
    action,
    resourceType,
    resourceId,
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

function mutationAudit(
  action: string,
  resourceType: string,
  resourceId: string | null,
  createdAt: string,
): AuditLogEntry {
  return {
    actorType: 'SYSTEM',
    actorId: null,
    action,
    resourceType,
    resourceId,
    createdAt,
  };
}

function migrationAudit(
  action: string,
  migrationId: string,
  createdAt: string,
): AuditLogEntry {
  return mutationAudit(action, 'SHARD_MIGRATION', migrationId, createdAt);
}

function transferAudit(
  action: string,
  taskId: string,
  createdAt: string,
): AuditLogEntry {
  return mutationAudit(action, 'SHARD_MIGRATION_OBJECT', taskId, createdAt);
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM shard_migration_objects'),
    testEnv.DB.prepare('DELETE FROM shard_migrations'),
    testEnv.DB.prepare('DELETE FROM audit_outbox'),
    testEnv.DB.prepare('DELETE FROM upload_sessions'),
    testEnv.DB.prepare('DELETE FROM object_locations'),
    testEnv.DB.prepare('DELETE FROM objects'),
    testEnv.DB.prepare('DELETE FROM storage_shards'),
    testEnv.DB.prepare('DELETE FROM logical_buckets'),
    testEnv.DB.prepare('DELETE FROM storage_accounts'),
  ]);
});

async function auditOutboxCount(): Promise<number> {
  const row = await testEnv.DB.prepare(
    'SELECT COUNT(*) AS count FROM audit_outbox',
  ).first<{ count: number }>();
  return row?.count ?? -1;
}

async function auditActionCount(action: string): Promise<number> {
  const row = await testEnv.DB.prepare(
    'SELECT COUNT(*) AS count FROM audit_outbox WHERE action = ?',
  )
    .bind(action)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

async function migrationTaskCount(): Promise<number> {
  const row = await testEnv.DB.prepare(
    'SELECT COUNT(*) AS count FROM shard_migration_objects',
  ).first<{ count: number }>();
  return row?.count ?? -1;
}

async function setupReadyObject(): Promise<{
  readonly source: StorageShard;
  readonly target: StorageShard;
  readonly migration: ShardMigration;
}> {
  const sourceAccount = account('account-source', 'Source');
  const targetAccount = account('account-target', 'Target');
  expect(
    await accounts.create(
      sourceAccount,
      envelope,
      setupAudit(
        'STORAGE_ACCOUNT_CREATED',
        'STORAGE_ACCOUNT',
        sourceAccount.id,
      ),
    ),
  ).toBe(true);
  expect(
    await accounts.create(
      targetAccount,
      envelope,
      setupAudit(
        'STORAGE_ACCOUNT_CREATED',
        'STORAGE_ACCOUNT',
        targetAccount.id,
      ),
    ),
  ).toBe(true);
  expect(
    await buckets.create(bucket, {
      actorType: 'SYSTEM',
      actorId: null,
      action: 'LOGICAL_BUCKET_CREATED',
      resourceType: 'LOGICAL_BUCKET',
      resourceId: bucket.id,
      createdAt: bucket.createdAt,
    }),
  ).toBe(true);
  const source = shard('shard-source', sourceAccount.id, 'ACTIVE');
  const target = shard('shard-target', targetAccount.id, 'STANDBY');
  expect(
    await shards.create(
      source,
      setupAudit('STORAGE_SHARD_CREATED', 'STORAGE_SHARD', source.id),
    ),
  ).toBe(true);
  expect(
    await shards.create(
      target,
      setupAudit('STORAGE_SHARD_CREATED', 'STORAGE_SHARD', target.id),
    ),
  ).toBe(true);

  const object: StoredObject = {
    id: 'object-1',
    logicalBucketId: bucket.id,
    logicalKey: 'reports/one.txt',
    sizeBytes: 100,
    contentType: 'text/plain',
    checksum: null,
    status: 'PENDING',
    createdAt: '2026-09-01T00:01:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
  };
  const location: ObjectLocation = {
    id: 'location-source',
    objectId: object.id,
    storageAccountId: sourceAccount.id,
    storageShardId: source.id,
    physicalBucket: source.physicalBucket,
    physicalKey: 'objects/ob/object-1',
    etag: null,
    isPrimary: true,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
  };
  const session: UploadSession = {
    id: 'upload-1',
    objectId: object.id,
    status: 'PENDING',
    expiresAt: '2026-09-01T00:15:00.000Z',
    createdAt: object.createdAt,
    completedAt: null,
  };
  expect(
    await objects.reserveUploadAndCapacity(
      object,
      location,
      session,
      mutationAudit(
        'OBJECT_RESERVED',
        'OBJECT',
        object.id,
        object.createdAt,
      ),
    ),
  ).toBe('RESERVED');
  expect(
    await objects.completeUpload(
      object.id,
      session.id,
      '2026-09-01T00:02:00.000Z',
      'source-etag',
      null,
      mutationAudit(
        'OBJECT_COMPLETED',
        'OBJECT',
        object.id,
        '2026-09-01T00:02:00.000Z',
      ),
    ),
  ).toBe('COMPLETED');
  await testEnv.DB.prepare(
    `UPDATE storage_accounts
     SET status = 'DRAINING', write_enabled = 0,
         updated_at = '2026-09-01T00:03:00.000Z'
     WHERE id = ?`,
  )
    .bind(sourceAccount.id)
    .run();

  return {
    source: { ...source, usedBytes: 100, updatedAt: object.updatedAt },
    target,
    migration: {
      id: 'migration-1',
      sourceShardId: source.id,
      targetShardId: target.id,
      status: 'RUNNING',
      createdAt: '2026-09-01T00:04:00.000Z',
      updatedAt: '2026-09-01T00:04:00.000Z',
      completedAt: null,
    },
  };
}

describe('shard migration D1 repository', () => {
  it('cuts over shards, reserves a target copy, switches primary, and cleans source', async () => {
    const fixture = await setupReadyObject();
    expect(
      await migrations.createAndCutover(
        fixture.migration,
        fixture.source.updatedAt,
        fixture.target.updatedAt,
        migrationAudit(
          'SHARD_MIGRATION_CREATED',
          fixture.migration.id,
          fixture.migration.createdAt,
        ),
      ),
    ).toBe('CREATED');
    expect(await auditActionCount('SHARD_MIGRATION_CREATED')).toBe(1);
    expect(await shards.findById(fixture.source.id)).toMatchObject({
      status: 'MIGRATING',
    });
    expect(await shards.findById(fixture.target.id)).toMatchObject({
      status: 'ACTIVE',
    });
    expect(await migrations.listByLogicalBucketId(bucket.id)).toEqual([
      fixture.migration,
    ]);

    const claimed = await migrations.claimTransfer(
      {
        migrationId: fixture.migration.id,
        taskId: 'task-1',
        targetLocationId: 'location-target',
        targetPhysicalKeyPrefix: 'objects/',
        leaseToken: 'lease-1',
        leasedAt: '2026-09-01T00:05:00.000Z',
        leaseExpiresAt: '2026-09-01T00:20:00.000Z',
      },
      transferAudit(
        'SHARD_MIGRATION_TRANSFER_CLAIMED',
        'task-1',
        '2026-09-01T00:05:00.000Z',
      ),
    );
    expect(claimed.outcome).toBe('CLAIMED');
    if (claimed.outcome !== 'CLAIMED') throw new Error('Missing transfer');
    expect(
      await auditActionCount('SHARD_MIGRATION_TRANSFER_CLAIMED'),
    ).toBe(1);
    expect(claimed.transfer).toMatchObject({
      object: { id: 'object-1', sizeBytes: 100 },
      sourceLocation: { id: 'location-source', isPrimary: true },
      targetLocation: {
        id: 'location-target',
        isPrimary: false,
        physicalKey: 'objects/ob/object-1',
      },
    });
    expect(await accounts.findById('account-target')).toMatchObject({
      usedBytes: 100,
    });
    expect(await shards.findById('shard-target')).toMatchObject({
      usedBytes: 100,
    });
    expect(
      await objects.beginDelete(
        'object-1',
        '2026-09-01T00:06:00.000Z',
        mutationAudit(
          'OBJECT_DELETE_STARTED',
          'OBJECT',
          'object-1',
          '2026-09-01T00:06:00.000Z',
        ),
      ),
    ).toBe('CONFLICT');

    expect(
      await migrations.switchPrimary(
        'task-1',
        'lease-1',
        'target-etag',
        '2026-09-01T00:10:00.000Z',
        transferAudit(
          'SHARD_MIGRATION_PRIMARY_SWITCHED',
          'task-1',
          '2026-09-01T00:10:00.000Z',
        ),
      ),
    ).toBe('SWITCHED');
    const switched = await migrations.findTransfer('task-1', 'lease-1');
    expect(switched).toMatchObject({
      task: { status: 'SWITCHED' },
      sourceLocation: { isPrimary: false },
      targetLocation: { isPrimary: true, etag: 'target-etag' },
    });
    expect(await migrations.listSourceCleanupCandidates(100)).toEqual([
      switched,
    ]);

    expect(
      await migrations.finishSourceCleanup(
        'task-1',
        '2026-09-01T00:11:00.000Z',
        transferAudit(
          'SHARD_MIGRATION_SOURCE_CLEANED',
          'task-1',
          '2026-09-01T00:11:00.000Z',
        ),
      ),
    ).toBe('COMPLETED');
    expect(await accounts.findById('account-source')).toMatchObject({
      usedBytes: 0,
    });
    expect(await accounts.findById('account-target')).toMatchObject({
      usedBytes: 100,
    });
    expect(await migrations.progress(fixture.migration.id)).toEqual({
      reserved: 0,
      switched: 0,
      completed: 1,
      failed: 0,
      remainingReady: 0,
      blocking: 0,
    });
    expect(await migrations.listSourceCleanupCandidates(100)).toEqual([]);

    expect(
      await migrations.completeIfReady(
        fixture.migration.id,
        '2026-09-01T00:12:00.000Z',
        migrationAudit(
          'SHARD_MIGRATION_COMPLETED',
          fixture.migration.id,
          '2026-09-01T00:12:00.000Z',
        ),
      ),
    ).toBe('COMPLETED');
    expect(await migrations.findById(fixture.migration.id)).toMatchObject({
      status: 'COMPLETED',
      completedAt: '2026-09-01T00:12:00.000Z',
    });
    expect(await shards.findById(fixture.source.id)).toMatchObject({
      status: 'RETIRED',
      usedBytes: 0,
    });

    const outboxBeforeNoOp = await auditOutboxCount();
    expect(
      await migrations.completeIfReady(
        fixture.migration.id,
        '2026-09-01T00:13:00.000Z',
        migrationAudit(
          'SHARD_MIGRATION_COMPLETED',
          fixture.migration.id,
          '2026-09-01T00:13:00.000Z',
        ),
      ),
    ).toBe('ALREADY_COMPLETED');
    expect(await auditOutboxCount()).toBe(outboxBeforeNoOp);
  });

  it('rejects stale cutover and reclaims only expired transfer leases', async () => {
    const fixture = await setupReadyObject();
    const outboxBeforeStaleCutover = await auditOutboxCount();
    expect(
      await migrations.createAndCutover(
        fixture.migration,
        '2026-09-01T00:00:00.000Z',
        fixture.target.updatedAt,
        migrationAudit(
          'SHARD_MIGRATION_CREATED',
          fixture.migration.id,
          fixture.migration.createdAt,
        ),
      ),
    ).toBe('CONFLICT');
    expect(await auditOutboxCount()).toBe(outboxBeforeStaleCutover);

    expect(
      await migrations.createAndCutover(
        fixture.migration,
        fixture.source.updatedAt,
        fixture.target.updatedAt,
        migrationAudit(
          'SHARD_MIGRATION_CREATED',
          fixture.migration.id,
          fixture.migration.createdAt,
        ),
      ),
    ).toBe('CREATED');
    expect(
      (
        await migrations.claimTransfer(
          {
            migrationId: fixture.migration.id,
            taskId: 'task-1',
            targetLocationId: 'location-target',
            targetPhysicalKeyPrefix: 'objects/',
            leaseToken: 'lease-1',
            leasedAt: '2026-09-01T00:05:00.000Z',
            leaseExpiresAt: '2026-09-01T00:20:00.000Z',
          },
          transferAudit(
            'SHARD_MIGRATION_TRANSFER_CLAIMED',
            'task-1',
            '2026-09-01T00:05:00.000Z',
          ),
        )
      ).outcome,
    ).toBe('CLAIMED');
    expect(
      (
        await migrations.claimTransfer(
          {
            migrationId: fixture.migration.id,
            taskId: 'task-2',
            targetLocationId: 'location-target-2',
            targetPhysicalKeyPrefix: 'objects/',
            leaseToken: 'lease-too-early',
            leasedAt: '2026-09-01T00:10:00.000Z',
            leaseExpiresAt: '2026-09-01T00:25:00.000Z',
          },
          transferAudit(
            'SHARD_MIGRATION_TRANSFER_CLAIMED',
            'task-2',
            '2026-09-01T00:10:00.000Z',
          ),
        )
      ).outcome,
    ).toBe('NONE');
    expect(await auditOutboxCount()).toBe(outboxBeforeStaleCutover + 2);
    const reclaimed = await migrations.claimTransfer(
      {
        migrationId: fixture.migration.id,
        taskId: 'unused',
        targetLocationId: 'unused-location',
        targetPhysicalKeyPrefix: 'objects/',
        leaseToken: 'lease-2',
        leasedAt: '2026-09-01T00:21:00.000Z',
        leaseExpiresAt: '2026-09-01T00:36:00.000Z',
      },
      transferAudit(
        'SHARD_MIGRATION_TRANSFER_CLAIMED',
        'unused',
        '2026-09-01T00:21:00.000Z',
      ),
    );
    expect(reclaimed).toMatchObject({
      outcome: 'CLAIMED',
      transfer: {
        task: { id: 'task-1', leaseToken: 'lease-2', attemptCount: 2 },
      },
    });
  });

  it('rolls back shard cutover when its fixed outbox event id conflicts', async () => {
    const fixture = await setupReadyObject();
    const outboxBeforeFixedEvent = await auditOutboxCount();
    const fixedOutbox = new D1AuditOutboxRepository(testEnv.DB, {
      idGenerator: () => 'event-fixed-cutover',
    });
    await fixedOutbox.record(
      mutationAudit(
        'TEST_EVENT',
        'TEST_RESOURCE',
        'event-fixed-cutover',
        '2026-09-01T00:04:30.000Z',
      ),
    );
    const conflicting = new D1ShardMigrationRepository(
      testEnv.DB,
      fixedOutbox,
    );

    await expect(
      conflicting.createAndCutover(
        fixture.migration,
        fixture.source.updatedAt,
        fixture.target.updatedAt,
        migrationAudit(
          'SHARD_MIGRATION_CREATED',
          fixture.migration.id,
          fixture.migration.createdAt,
        ),
      ),
    ).rejects.toThrow();
    expect(await shards.findById(fixture.source.id)).toMatchObject({
      status: 'ACTIVE',
    });
    expect(await shards.findById(fixture.target.id)).toMatchObject({
      status: 'STANDBY',
    });
    expect(await migrations.findById(fixture.migration.id)).toBeUndefined();
    expect(await auditOutboxCount()).toBe(outboxBeforeFixedEvent + 1);
  });

  it('rolls back claimTransfer capacity and task when its fixed outbox event id conflicts', async () => {
    const fixture = await setupReadyObject();
    expect(
      await migrations.createAndCutover(
        fixture.migration,
        fixture.source.updatedAt,
        fixture.target.updatedAt,
        migrationAudit(
          'SHARD_MIGRATION_CREATED',
          fixture.migration.id,
          fixture.migration.createdAt,
        ),
      ),
    ).toBe('CREATED');
    const fixedOutbox = new D1AuditOutboxRepository(testEnv.DB, {
      idGenerator: () => 'event-fixed-claim',
    });
    await fixedOutbox.record(
      mutationAudit(
        'TEST_EVENT',
        'TEST_RESOURCE',
        'event-fixed-claim',
        '2026-09-01T00:04:30.000Z',
      ),
    );
    const conflicting = new D1ShardMigrationRepository(
      testEnv.DB,
      fixedOutbox,
    );
    const outboxBeforeClaim = await auditOutboxCount();

    await expect(
      conflicting.claimTransfer(
        {
          migrationId: fixture.migration.id,
          taskId: 'task-conflict',
          targetLocationId: 'location-target-conflict',
          targetPhysicalKeyPrefix: 'objects/',
          leaseToken: 'lease-conflict',
          leasedAt: '2026-09-01T00:05:00.000Z',
          leaseExpiresAt: '2026-09-01T00:20:00.000Z',
        },
        transferAudit(
          'SHARD_MIGRATION_TRANSFER_CLAIMED',
          'task-conflict',
          '2026-09-01T00:05:00.000Z',
        ),
      ),
    ).rejects.toThrow();
    expect(await migrationTaskCount()).toBe(0);
    expect(await accounts.findById('account-target')).toMatchObject({
      usedBytes: 0,
    });
    expect(await shards.findById('shard-target')).toMatchObject({
      usedBytes: 0,
    });
    expect(await auditOutboxCount()).toBe(outboxBeforeClaim);
  });

  it('fails closed when migration or object mutations have no audit outbox', async () => {
    const fixture = await setupReadyObject();
    const unconfiguredMigrations = new D1ShardMigrationRepository(testEnv.DB);
    await expect(
      unconfiguredMigrations.createAndCutover(
        fixture.migration,
        fixture.source.updatedAt,
        fixture.target.updatedAt,
        migrationAudit(
          'SHARD_MIGRATION_CREATED',
          fixture.migration.id,
          fixture.migration.createdAt,
        ),
      ),
    ).rejects.toThrow('Shard migration audit outbox unavailable');
    expect(await migrations.findById(fixture.migration.id)).toBeUndefined();
    expect(await shards.findById(fixture.source.id)).toMatchObject({
      status: 'ACTIVE',
    });

    const unconfiguredObjects = new D1ObjectRepository(testEnv.DB);
    await expect(
      unconfiguredObjects.beginDelete(
        'object-1',
        '2026-09-01T00:06:00.000Z',
        mutationAudit(
          'OBJECT_DELETE_STARTED',
          'OBJECT',
          'object-1',
          '2026-09-01T00:06:00.000Z',
        ),
      ),
    ).rejects.toThrow('Object mutation requires audit outbox');
    expect(await objects.findById('object-1')).toMatchObject({
      object: { status: 'READY' },
    });
  });
});
