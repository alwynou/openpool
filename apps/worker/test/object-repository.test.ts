import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ObjectLocation, StoredObject, UploadSession } from '@openpool/domain';

import { D1ObjectRepository } from '../src/adapters/d1';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

interface Reservation {
  readonly object: StoredObject;
  readonly location: ObjectLocation;
  readonly session: UploadSession;
}

interface CapacityRow {
  readonly account_used: number;
  readonly shard_used: number;
}

const testEnv = env as unknown as TestEnv;
const objects = new D1ObjectRepository(testEnv.DB);
const now = '2026-09-01T00:00:00.000Z';

async function setupPlacement(options: {
  readonly accountCapacity?: number;
  readonly accountUsed?: number;
  readonly shardCapacity?: number;
  readonly shardUsed?: number;
} = {}): Promise<void> {
  const accountCapacity = options.accountCapacity ?? 1_000;
  const accountUsed = options.accountUsed ?? 100;
  const shardCapacity = options.shardCapacity ?? 1_000;
  const shardUsed = options.shardUsed ?? 100;
  await testEnv.DB.batch([
    testEnv.DB
      .prepare(
        `INSERT INTO storage_accounts
         (id, name, provider, status, priority, write_enabled, capacity_bytes,
          used_bytes, provider_config, credential_envelope,
          last_health_status, capabilities, capacity_accuracy, created_at,
          updated_at)
         VALUES (?, ?, 'r2', 'ACTIVE', 0, 1, ?, ?, '{}', ?, 'HEALTHY',
                 '{"presignedUpload":true,"presignedDownload":true,"headObject":true,"deleteObject":true,"bucketProbe":true,"usageProbe":false}',
                 'CONFIGURED', ?, ?)`,
      )
      .bind(
        'account-1',
        'Primary',
        accountCapacity,
        accountUsed,
        JSON.stringify({
          version: 1,
          algorithm: 'AES-256-GCM',
          keyId: 'test-key',
          iv: 'aXY=',
          ciphertext: 'Y2lwaGVydGV4dA==',
        }),
        now,
        now,
      ),
    testEnv.DB.prepare(
      `INSERT INTO logical_buckets
       (id, name, description, created_at, updated_at)
       VALUES ('bucket-1', 'documents', NULL, '${now}', '${now}')`,
    ),
    testEnv.DB
      .prepare(
        `INSERT INTO storage_shards
         (id, logical_bucket_id, storage_account_id, physical_bucket, status,
          capacity_bytes, used_bytes, created_at, updated_at)
         VALUES ('shard-1', 'bucket-1', 'account-1', 'physical-one',
                 'ACTIVE', ?, ?, '${now}', '${now}')`,
      )
      .bind(shardCapacity, shardUsed),
  ]);
}

function reservation(
  seed: string,
  overrides: {
    readonly logicalKey?: string;
    readonly sizeBytes?: number;
    readonly sessionId?: string;
  } = {},
): Reservation {
  const objectId = `object-${seed}`;
  return {
    object: {
      id: objectId,
      logicalBucketId: 'bucket-1',
      logicalKey: overrides.logicalKey ?? `key-${seed}`,
      sizeBytes: overrides.sizeBytes ?? 50,
      contentType: 'application/octet-stream',
      checksum: null,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    },
    location: {
      id: `location-${seed}`,
      objectId,
      storageAccountId: 'account-1',
      storageShardId: 'shard-1',
      physicalBucket: 'physical-one',
      physicalKey: `objects/${seed}`,
      etag: null,
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: overrides.sessionId ?? `session-${seed}`,
      objectId,
      status: 'PENDING',
      expiresAt: '2026-09-01T00:15:00.000Z',
      createdAt: now,
      completedAt: null,
    },
  };
}

async function reserve(value: Reservation) {
  return objects.reserveUploadAndCapacity(
    value.object,
    value.location,
    value.session,
  );
}

async function capacity(): Promise<CapacityRow> {
  const row = await testEnv.DB.prepare(
    `SELECT account.used_bytes AS account_used,
            shard.used_bytes AS shard_used
     FROM storage_accounts AS account
     JOIN storage_shards AS shard ON shard.storage_account_id = account.id
     WHERE account.id = 'account-1' AND shard.id = 'shard-1'`,
  ).first<CapacityRow>();
  if (row === null) throw new Error('Missing capacity fixture');
  return row;
}

async function rowCount(table: string): Promise<number> {
  const allowed = new Set(['objects', 'object_locations', 'upload_sessions']);
  if (!allowed.has(table)) throw new Error('Unexpected test table');
  const row = await testEnv.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).first<{ count: number }>();
  return row?.count ?? -1;
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM upload_sessions'),
    testEnv.DB.prepare('DELETE FROM object_locations'),
    testEnv.DB.prepare('DELETE FROM objects'),
    testEnv.DB.prepare('DELETE FROM storage_shards'),
    testEnv.DB.prepare('DELETE FROM logical_buckets'),
    testEnv.DB.prepare('DELETE FROM storage_accounts'),
  ]);
});

describe('object D1 repository reservation', () => {
  it('atomically reserves an aggregate and both capacity counters', async () => {
    await setupPlacement();
    const value = reservation('one');

    await expect(reserve(value)).resolves.toBe('RESERVED');
    await expect(objects.findById(value.object.id)).resolves.toEqual({
      object: value.object,
      primaryLocation: value.location,
      uploadSession: value.session,
    });
    await expect(
      objects.findByLogicalKey('bucket-1', value.object.logicalKey),
    ).resolves.toEqual({
      object: value.object,
      primaryLocation: value.location,
      uploadSession: value.session,
    });
    await expect(capacity()).resolves.toEqual({
      account_used: 150,
      shard_used: 150,
    });
  });

  it('serializes concurrent reservations at the 90% soft limit', async () => {
    await setupPlacement({
      accountCapacity: 100,
      accountUsed: 80,
      shardCapacity: 100,
      shardUsed: 80,
    });
    const results = await Promise.all([
      reserve(reservation('a', { sizeBytes: 10 })),
      reserve(reservation('b', { sizeBytes: 10 })),
    ]);

    expect(results.sort()).toEqual(['CAPACITY_UNAVAILABLE', 'RESERVED']);
    expect(await rowCount('objects')).toBe(1);
    await expect(capacity()).resolves.toEqual({
      account_used: 90,
      shard_used: 90,
    });
  });

  it('keeps namespace conflicts atomic under concurrency', async () => {
    await setupPlacement({ accountUsed: 0, shardUsed: 0 });
    const results = await Promise.all([
      reserve(reservation('a', { logicalKey: 'same-key', sizeBytes: 10 })),
      reserve(reservation('b', { logicalKey: 'same-key', sizeBytes: 10 })),
    ]);

    expect(results.sort()).toEqual(['OBJECT_CONFLICT', 'RESERVED']);
    expect(await rowCount('objects')).toBe(1);
    expect(await rowCount('object_locations')).toBe(1);
    expect(await rowCount('upload_sessions')).toBe(1);
    await expect(capacity()).resolves.toEqual({
      account_used: 10,
      shard_used: 10,
    });
  });

  it('rolls back rows and counters when a later batch insert conflicts', async () => {
    await setupPlacement({ accountUsed: 0, shardUsed: 0 });
    const first = reservation('first', { sizeBytes: 10 });
    expect(await reserve(first)).toBe('RESERVED');
    const second = reservation('second', {
      sizeBytes: 20,
      sessionId: first.session.id,
    });

    expect(await reserve(second)).toBe('CONFLICT');
    expect(await rowCount('objects')).toBe(1);
    expect(await rowCount('object_locations')).toBe(1);
    expect(await rowCount('upload_sessions')).toBe(1);
    await expect(capacity()).resolves.toEqual({
      account_used: 10,
      shard_used: 10,
    });
  });

  it('rejects unavailable placement and either level exceeding its soft limit', async () => {
    await setupPlacement({ accountUsed: 0, shardUsed: 89, shardCapacity: 100 });
    expect(await reserve(reservation('shard-full', { sizeBytes: 2 }))).toBe(
      'CAPACITY_UNAVAILABLE',
    );
    await testEnv.DB.prepare(
      `UPDATE storage_shards
       SET used_bytes = 0, capacity_bytes = 1000, status = 'READ_ONLY'
       WHERE id = 'shard-1'`,
    ).run();
    expect(await reserve(reservation('read-only', { sizeBytes: 2 }))).toBe(
      'SHARD_UNAVAILABLE',
    );
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE storage_shards SET status = 'ACTIVE' WHERE id = 'shard-1'`,
      ),
      testEnv.DB.prepare(
        `UPDATE storage_accounts
         SET status = 'DRAINING', write_enabled = 0
         WHERE id = 'account-1'`,
      ),
    ]);
    expect(
      await reserve(reservation('account-draining', { sizeBytes: 2 })),
    ).toBe('SHARD_UNAVAILABLE');
    await testEnv.DB.prepare(
      `UPDATE storage_accounts
       SET status = 'ACTIVE', write_enabled = 1,
           capacity_bytes = 100, used_bytes = 89
       WHERE id = 'account-1'`,
    ).run();
    expect(await reserve(reservation('account-full', { sizeBytes: 2 }))).toBe(
      'CAPACITY_UNAVAILABLE',
    );
    expect(await rowCount('objects')).toBe(0);
  });
});

describe('object D1 repository lifecycle', () => {
  it('completes atomically and reports concurrent/idempotent completion accurately', async () => {
    await setupPlacement();
    const value = reservation('complete', { sizeBytes: 20 });
    expect(await reserve(value)).toBe('RESERVED');

    const results = await Promise.all([
      objects.completeUpload(
        value.object.id,
        value.session.id,
        '2026-09-01T00:01:00.000Z',
        'etag-one',
        'checksum-one',
      ),
      objects.completeUpload(
        value.object.id,
        value.session.id,
        '2026-09-01T00:01:00.000Z',
        'etag-one',
        'checksum-one',
      ),
    ]);
    expect(results.sort()).toEqual(['ALREADY_COMPLETED', 'COMPLETED']);

    const aggregate = await objects.findById(value.object.id);
    expect(aggregate).toMatchObject({
      object: {
        status: 'READY',
        checksum: 'checksum-one',
        updatedAt: '2026-09-01T00:01:00.000Z',
      },
      primaryLocation: {
        etag: 'etag-one',
        updatedAt: '2026-09-01T00:01:00.000Z',
      },
      uploadSession: {
        status: 'COMPLETED',
        completedAt: '2026-09-01T00:01:00.000Z',
      },
    });
    expect(
      await objects.completeUpload(
        value.object.id,
        value.session.id,
        '2026-09-01T00:02:00.000Z',
        'different-etag',
        'different-checksum',
      ),
    ).toBe('ALREADY_COMPLETED');
    await expect(capacity()).resolves.toEqual({
      account_used: 120,
      shard_used: 120,
    });
  });

  it('does not mutate a pending aggregate when completion identifiers conflict', async () => {
    await setupPlacement();
    const value = reservation('wrong-session');
    expect(await reserve(value)).toBe('RESERVED');

    expect(
      await objects.completeUpload(
        value.object.id,
        'missing-session',
        '2026-09-01T00:01:00.000Z',
        'etag',
        'checksum',
      ),
    ).toBe('NOT_FOUND');
    await expect(objects.findById(value.object.id)).resolves.toEqual({
      object: value.object,
      primaryLocation: value.location,
      uploadSession: value.session,
    });
  });

  it('rolls completion back when its required primary location disappears', async () => {
    await setupPlacement();
    const value = reservation('complete-conflict', { sizeBytes: 1 });
    expect(await reserve(value)).toBe('RESERVED');
    await testEnv.DB.prepare(
      'DELETE FROM object_locations WHERE object_id = ?',
    )
      .bind(value.object.id)
      .run();

    expect(
      await objects.completeUpload(
        value.object.id,
        value.session.id,
        '2026-09-01T00:01:00.000Z',
        'etag',
        'checksum',
      ),
    ).toBe('CONFLICT');
    const state = await testEnv.DB.prepare(
      `SELECT object.status AS object_status,
              object.checksum,
              session.status AS session_status
       FROM objects AS object
       JOIN upload_sessions AS session ON session.object_id = object.id
       WHERE object.id = ?`,
    )
      .bind(value.object.id)
      .first<{
        object_status: string;
        checksum: string | null;
        session_status: string;
      }>();
    expect(state).toEqual({
      object_status: 'PENDING',
      checksum: null,
      session_status: 'PENDING',
    });
  });

  it('expires only once and retains the pending aggregate for audit', async () => {
    await setupPlacement();
    const value = reservation('expire', { sizeBytes: 20 });
    expect(await reserve(value)).toBe('RESERVED');

    expect(
      await objects.expireUploadAndReleaseCapacity(
        value.object.id,
        value.session.id,
        '2026-09-01T00:16:00.000Z',
      ),
    ).toBe('EXPIRED');
    expect(
      await objects.expireUploadAndReleaseCapacity(
        value.object.id,
        value.session.id,
        '2026-09-01T00:17:00.000Z',
      ),
    ).toBe('ALREADY_EXPIRED');
    await expect(capacity()).resolves.toEqual({
      account_used: 100,
      shard_used: 100,
    });
    expect(await objects.findById(value.object.id)).toMatchObject({
      object: {
        status: 'PENDING',
        updatedAt: '2026-09-01T00:16:00.000Z',
      },
      uploadSession: { status: 'EXPIRED', completedAt: null },
    });

    await expect(
      objects.listExpiredUploadsAwaitingCleanup(10),
    ).resolves.toEqual([
      { objectId: value.object.id, uploadSessionId: value.session.id },
    ]);
    const cleanup = await Promise.all([
      objects.finishExpiredUploadCleanup(value.object.id, value.session.id),
      objects.finishExpiredUploadCleanup(value.object.id, value.session.id),
    ]);
    expect(cleanup.sort()).toEqual(['ALREADY_CLEANED', 'CLEANED']);
    await expect(capacity()).resolves.toEqual({
      account_used: 100,
      shard_used: 100,
    });
    expect(await objects.findById(value.object.id)).toMatchObject({
      object: { status: 'PENDING' },
      uploadSession: { status: 'ABORTED', completedAt: null },
    });
    await expect(
      objects.listExpiredUploadsAwaitingCleanup(10),
    ).resolves.toEqual([]);
  });

  it('lists only pending sessions older than the requested cleanup cutoff', async () => {
    await setupPlacement({ accountUsed: 0, shardUsed: 0 });
    const first = reservation('expired-a', { sizeBytes: 1 });
    const second = reservation('expired-b', { sizeBytes: 1 });
    expect(await reserve(first)).toBe('RESERVED');
    expect(await reserve(second)).toBe('RESERVED');

    await expect(
      objects.listExpiredPendingUploads('2026-09-01T00:14:59.999Z', 10),
    ).resolves.toEqual([]);
    await expect(
      objects.listExpiredPendingUploads('2026-09-01T00:15:00.000Z', 1),
    ).resolves.toEqual([
      { objectId: first.object.id, uploadSessionId: first.session.id },
    ]);
  });

  it('conditions both delete edges and releases capacity exactly once', async () => {
    await setupPlacement();
    const value = reservation('delete', { sizeBytes: 20 });
    expect(await reserve(value)).toBe('RESERVED');
    expect(
      await objects.completeUpload(
        value.object.id,
        value.session.id,
        '2026-09-01T00:01:00.000Z',
        'etag',
        null,
      ),
    ).toBe('COMPLETED');

    expect(
      await objects.beginDelete(
        value.object.id,
        '2026-09-01T00:02:00.000Z',
      ),
    ).toBe('STARTED');
    expect(
      await objects.beginDelete(
        value.object.id,
        '2026-09-01T00:03:00.000Z',
      ),
    ).toBe('ALREADY_DELETING');
    expect(
      await objects.finishDeleteAndReleaseCapacity(
        value.object.id,
        '2026-09-01T00:04:00.000Z',
      ),
    ).toBe('DELETED');
    expect(
      await objects.finishDeleteAndReleaseCapacity(
        value.object.id,
        '2026-09-01T00:05:00.000Z',
      ),
    ).toBe('ALREADY_DELETED');
    await expect(capacity()).resolves.toEqual({
      account_used: 100,
      shard_used: 100,
    });
    expect(await objects.findById(value.object.id)).toMatchObject({
      object: { status: 'DELETED' },
      uploadSession: { status: 'COMPLETED' },
    });
  });

  it('rolls a batch back when a required conditional update changes no rows', async () => {
    await setupPlacement();
    const value = reservation('assertion', { sizeBytes: 1 });
    expect(await reserve(value)).toBe('RESERVED');

    await expect(
      testEnv.DB.batch([
        testEnv.DB
          .prepare('UPDATE objects SET logical_key = ? WHERE id = ?')
          .bind('must-roll-back', value.object.id),
        testEnv.DB.prepare(
          'INSERT INTO object_repository_assertions (ok) VALUES (changes())',
        ),
        testEnv.DB.prepare(
          "UPDATE upload_sessions SET status = 'COMPLETED' WHERE id = 'missing'",
        ),
        testEnv.DB.prepare(
          'INSERT INTO object_repository_assertions (ok) VALUES (changes())',
        ),
      ]),
    ).rejects.toThrow('openpool_object_repository_conflict');
    expect((await objects.findById(value.object.id))?.object.logicalKey).toBe(
      value.object.logicalKey,
    );
  });
});

describe('object D1 repository reads', () => {
  it('lists with bound filters and a stable logical-key/id order', async () => {
    await setupPlacement({ accountUsed: 0, shardUsed: 0 });
    for (const value of [
      reservation('z', { logicalKey: 'photos/z.jpg', sizeBytes: 1 }),
      reservation('a', { logicalKey: 'photos/a.jpg', sizeBytes: 1 }),
      reservation('literal', { logicalKey: 'photos/%_literal', sizeBytes: 1 }),
      reservation('doc', { logicalKey: 'docs/a.txt', sizeBytes: 1 }),
    ]) {
      expect(await reserve(value)).toBe('RESERVED');
    }

    expect(
      (
        await objects.list({
          logicalBucketId: 'bucket-1',
          prefix: 'photos/',
          limit: 10,
        })
      ).map(({ logicalKey }) => logicalKey),
    ).toEqual(['photos/%_literal', 'photos/a.jpg', 'photos/z.jpg']);
    expect(
      (
        await objects.list({
          logicalBucketId: 'bucket-1',
          prefix: 'photos/%_',
          limit: 10,
        })
      ).map(({ logicalKey }) => logicalKey),
    ).toEqual(['photos/%_literal']);
    expect(
      (
        await objects.list({
          logicalBucketId: 'bucket-1',
          afterKey: 'photos/a.jpg',
          limit: 1,
        })
      ).map(({ logicalKey }) => logicalKey),
    ).toEqual(['photos/z.jpg']);
  });

  it('fails closed for a missing primary location and invalid persisted object', async () => {
    await setupPlacement({ accountUsed: 0, shardUsed: 0 });
    const missingLocation = reservation('missing-location', { sizeBytes: 1 });
    const invalidObject = reservation('invalid-object', { sizeBytes: 1 });
    expect(await reserve(missingLocation)).toBe('RESERVED');
    expect(await reserve(invalidObject)).toBe('RESERVED');

    await testEnv.DB.batch([
      testEnv.DB
        .prepare('DELETE FROM object_locations WHERE object_id = ?')
        .bind(missingLocation.object.id),
      testEnv.DB
        .prepare("UPDATE objects SET content_type = '' WHERE id = ?")
        .bind(invalidObject.object.id),
    ]);
    await expect(objects.findById(missingLocation.object.id)).rejects.toThrow(
      'Invalid object aggregate primary_location.count',
    );
    await expect(objects.findById(invalidObject.object.id)).rejects.toThrow(
      'Invalid object aggregate object.content_type',
    );
  });
});
