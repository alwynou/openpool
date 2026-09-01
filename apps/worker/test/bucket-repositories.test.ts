import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LogicalBucket, StorageShard } from '@openpool/domain';
import {
  D1AuditOutboxRepository,
  D1LogicalBucketRepository,
  D1StorageShardRepository,
} from '../src/adapters/d1';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;
const auditOutbox = new D1AuditOutboxRepository(testEnv.DB);
const buckets = new D1LogicalBucketRepository(testEnv.DB, auditOutbox);
const shards = new D1StorageShardRepository(testEnv.DB);

function bucket(overrides: Partial<LogicalBucket> = {}): LogicalBucket {
  return {
    id: 'bucket-1',
    name: 'documents',
    description: 'User files',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function createBucket(value: LogicalBucket): Promise<boolean> {
  return buckets.create(value, {
    actorType: 'ADMIN',
    actorId: 'admin-1',
    action: 'LOGICAL_BUCKET_CREATED',
    resourceType: 'LOGICAL_BUCKET',
    resourceId: value.id,
    createdAt: value.createdAt,
  });
}

function shard(overrides: Partial<StorageShard> = {}): StorageShard {
  return {
    id: 'shard-1',
    logicalBucketId: 'bucket-1',
    storageAccountId: 'account-1',
    physicalBucket: 'physical-one',
    status: 'STANDBY',
    capacityBytes: 1_000,
    usedBytes: 100,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

async function insertStorageAccount(): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO storage_accounts
     (id, name, provider, status, priority, write_enabled, capacity_bytes,
      used_bytes, provider_config, credential_envelope, last_health_status,
      created_at, updated_at)
     VALUES (?, ?, 'r2', 'ACTIVE', 0, 1, 1000, 100, '{}', ?, 'HEALTHY', ?, ?)`,
  )
    .bind(
      'account-1',
      'Primary',
      JSON.stringify({
        version: 1,
        algorithm: 'AES-256-GCM',
        keyId: 'test-key',
        iv: 'aXY=',
        ciphertext: 'Y2lwaGVydGV4dA==',
      }),
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
    )
    .run();
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.prepare('DELETE FROM audit_outbox').run();
  await testEnv.DB.prepare('DELETE FROM storage_shards').run();
  await testEnv.DB.prepare('DELETE FROM logical_buckets').run();
  await testEnv.DB.prepare('DELETE FROM storage_accounts').run();
});

describe('logical bucket D1 repository', () => {
  it('round-trips buckets and lists them in a stable order', async () => {
    const later = bucket({
      id: 'bucket-z',
      name: 'later',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    });
    const firstAtSameTime = bucket({ id: 'bucket-a', name: 'first' });
    const secondAtSameTime = bucket({ id: 'bucket-b', name: 'second' });

    expect(await createBucket(later)).toBe(true);
    expect(await createBucket(secondAtSameTime)).toBe(true);
    expect(await createBucket(firstAtSameTime)).toBe(true);
    expect(await buckets.findById(firstAtSameTime.id)).toEqual(firstAtSameTime);
    expect((await buckets.list()).map(({ id }) => id)).toEqual([
      'bucket-a',
      'bucket-b',
      'bucket-z',
    ]);
  });

  it('returns false for duplicate names or ids', async () => {
    expect(await createBucket(bucket())).toBe(true);
    expect(
      await createBucket(bucket({ id: 'bucket-2', name: 'documents' })),
    ).toBe(false);
    expect(
      await createBucket(bucket({ id: 'bucket-1', name: 'pictures' })),
    ).toBe(false);
    expect(await buckets.list()).toHaveLength(1);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM audit_outbox').first<{
        count: number;
      }>(),
    ).toEqual({ count: 1 });
  });

  it('rolls back the bucket when its transactional outbox append fails', async () => {
    const eventIds = ['event-1', 'event-1'];
    const deterministicOutbox = new D1AuditOutboxRepository(testEnv.DB, {
      idGenerator: () => eventIds.shift() ?? 'event-fallback',
    });
    const repository = new D1LogicalBucketRepository(
      testEnv.DB,
      deterministicOutbox,
    );
    const first = bucket();
    const second = bucket({ id: 'bucket-2', name: 'pictures' });
    const audit = (value: LogicalBucket) => ({
      actorType: 'ADMIN' as const,
      actorId: 'admin-1',
      action: 'LOGICAL_BUCKET_CREATED',
      resourceType: 'LOGICAL_BUCKET',
      resourceId: value.id,
      createdAt: value.createdAt,
    });

    await expect(repository.create(first, audit(first))).resolves.toBe(true);
    await expect(repository.create(second, audit(second))).rejects.toThrow();
    expect((await repository.list()).map(({ id }) => id)).toEqual([
      'bucket-1',
    ]);
  });

  it('fails closed when a persisted bucket row violates the domain', async () => {
    expect(await createBucket(bucket())).toBe(true);
    await testEnv.DB.prepare("UPDATE logical_buckets SET name = '' WHERE id = ?")
      .bind('bucket-1')
      .run();
    await expect(buckets.findById('bucket-1')).rejects.toThrow(
      'Invalid logical bucket name',
    );
  });
});

describe('storage shard D1 repository', () => {
  beforeEach(async () => {
    expect(await createBucket(bucket())).toBe(true);
    await insertStorageAccount();
  });

  it('round-trips shards and returns stable global and bucket lists', async () => {
    const later = shard({
      id: 'shard-z',
      physicalBucket: 'physical-z',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    });
    const firstAtSameTime = shard({
      id: 'shard-a',
      physicalBucket: 'physical-a',
      status: 'ACTIVE',
    });
    const secondAtSameTime = shard({
      id: 'shard-b',
      physicalBucket: 'physical-b',
    });

    expect(await shards.create(later)).toBe(true);
    expect(await shards.create(secondAtSameTime)).toBe(true);
    expect(await shards.create(firstAtSameTime)).toBe(true);
    expect(await shards.findById(firstAtSameTime.id)).toEqual(firstAtSameTime);
    expect(await shards.findActiveByLogicalBucketId('bucket-1')).toEqual(
      firstAtSameTime,
    );
    expect((await shards.list()).map(({ id }) => id)).toEqual([
      'shard-a',
      'shard-b',
      'shard-z',
    ]);
    expect(
      (await shards.listByLogicalBucketId('bucket-1')).map(({ id }) => id),
    ).toEqual(['shard-a', 'shard-b', 'shard-z']);
  });

  it('returns false for duplicate ids and active-shard uniqueness conflicts', async () => {
    expect(await shards.create(shard({ status: 'ACTIVE' }))).toBe(true);
    expect(
      await shards.create(
        shard({ id: 'shard-1', physicalBucket: 'duplicate-id' }),
      ),
    ).toBe(false);
    expect(
      await shards.create(
        shard({
          id: 'shard-2',
          physicalBucket: 'second-active',
          status: 'ACTIVE',
        }),
      ),
    ).toBe(false);
    expect(await shards.list()).toHaveLength(1);
  });

  it('atomically checks expected status and returns false on active conflicts', async () => {
    const active = shard({ status: 'ACTIVE' });
    const standby = shard({
      id: 'shard-2',
      physicalBucket: 'physical-two',
    });
    expect(await shards.create(active)).toBe(true);
    expect(await shards.create(standby)).toBe(true);

    const conflicting = {
      ...standby,
      status: 'ACTIVE' as const,
      updatedAt: '2026-09-01T01:00:00.000Z',
    };
    expect(
      await shards.update(conflicting, 'STANDBY', standby.updatedAt),
    ).toBe(false);
    expect((await shards.findById(standby.id))?.status).toBe('STANDBY');

    const retired = {
      ...standby,
      status: 'RETIRED' as const,
      updatedAt: '2026-09-01T02:00:00.000Z',
    };
    expect(
      await shards.update(retired, 'ACTIVE', standby.updatedAt),
    ).toBe(false);
    expect(
      await shards.update(retired, 'STANDBY', standby.updatedAt),
    ).toBe(true);
    expect(
      await shards.update(retired, 'STANDBY', standby.updatedAt),
    ).toBe(false);
    expect(await shards.findById(standby.id)).toEqual(retired);
  });

  it('does not overwrite shard capacity changed after a stale read', async () => {
    const original = shard();
    expect(await shards.create(original)).toBe(true);
    await testEnv.DB.prepare(
      `UPDATE storage_shards
       SET used_bytes = 125, updated_at = '2026-09-01T00:30:00.000Z'
       WHERE id = ?`,
    )
      .bind(original.id)
      .run();

    const stale = {
      ...original,
      status: 'RETIRED' as const,
      updatedAt: '2026-09-01T01:00:00.000Z',
    };
    expect(
      await shards.update(stale, 'STANDBY', original.updatedAt),
    ).toBe(false);
    expect(await shards.findById(original.id)).toMatchObject({
      status: 'STANDBY',
      usedBytes: 125,
      updatedAt: '2026-09-01T00:30:00.000Z',
    });
  });

  it('fails closed when persisted capacity values are inconsistent', async () => {
    expect(await shards.create(shard())).toBe(true);
    await testEnv.DB.prepare(
      'UPDATE storage_shards SET used_bytes = capacity_bytes + 1 WHERE id = ?',
    )
      .bind('shard-1')
      .run();
    await expect(shards.findById('shard-1')).rejects.toThrow(
      'Invalid storage shard state',
    );
  });
});
