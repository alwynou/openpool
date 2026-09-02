import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AuditLogEntry } from '@openpool/application';
import type { ObjectLocation, StoredObject, UploadSession } from '@openpool/domain';

import { D1AuditOutboxRepository, D1ObjectRepository, D1StorageAccountRepository } from '../src/adapters/d1';
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
const now = '2026-09-01T00:00:00.000Z';
const auditOutbox = new D1AuditOutboxRepository(testEnv.DB);
const objects = new D1ObjectRepository(testEnv.DB, auditOutbox);

function audit(
  action: string,
  resourceId: string,
  createdAt: string = now,
): AuditLogEntry {
  return {
    actorType: 'ADMIN',
    actorId: 'admin-1',
    action,
    resourceType: 'OBJECT',
    resourceId,
    createdAt,
  };
}

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
    audit('OBJECT_UPLOAD_RESERVED', value.object.id),
  );
}

async function outboxCount(action?: string): Promise<number> {
  const row = action === undefined
    ? await testEnv.DB.prepare(
        'SELECT COUNT(*) AS count FROM audit_outbox',
      ).first<{ count: number }>()
    : await testEnv.DB.prepare(
        'SELECT COUNT(*) AS count FROM audit_outbox WHERE action = ?',
      ).bind(action).first<{ count: number }>();
  return row?.count ?? -1;
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
    testEnv.DB.prepare('DELETE FROM audit_outbox'),
    testEnv.DB.prepare('DELETE FROM audit_logs'),
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
    await expect(outboxCount('OBJECT_UPLOAD_RESERVED')).resolves.toBe(1);
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
    await expect(outboxCount('OBJECT_UPLOAD_RESERVED')).resolves.toBe(1);
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
    await expect(outboxCount('OBJECT_UPLOAD_RESERVED')).resolves.toBe(1);
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
    await expect(outboxCount('OBJECT_UPLOAD_RESERVED')).resolves.toBe(1);
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
    await expect(outboxCount()).resolves.toBe(0);
  });

  it('rolls back the business mutation when a fixed audit event id conflicts', async () => {
    await setupPlacement({ accountUsed: 0, shardUsed: 0 });
    const fixedOutbox = new D1AuditOutboxRepository(testEnv.DB, {
      idGenerator: () => 'event-fixed',
    });
    const repository = new D1ObjectRepository(testEnv.DB, fixedOutbox);
    const first = reservation('fixed-first');
    const second = reservation('fixed-second');

    await expect(
      repository.reserveUploadAndCapacity(
        first.object,
        first.location,
        first.session,
        audit('OBJECT_UPLOAD_RESERVED', first.object.id),
      ),
    ).resolves.toBe('RESERVED');
    await expect(
      repository.reserveUploadAndCapacity(
        second.object,
        second.location,
        second.session,
        audit('OBJECT_UPLOAD_RESERVED', second.object.id),
      ),
    ).rejects.toThrow();

    await expect(repository.findById(first.object.id)).resolves.toBeDefined();
    await expect(repository.findById(second.object.id)).resolves.toBeUndefined();
    await expect(capacity()).resolves.toEqual({
      account_used: 50,
      shard_used: 50,
    });
    await expect(outboxCount()).resolves.toBe(1);
  });

  it('fails closed when a mutation repository has no audit outbox', async () => {
    await setupPlacement({ accountUsed: 0, shardUsed: 0 });
    const repository = new D1ObjectRepository(testEnv.DB);
    const value = reservation('missing-outbox');

    await expect(
      repository.reserveUploadAndCapacity(
        value.object,
        value.location,
        value.session,
        audit('OBJECT_UPLOAD_RESERVED', value.object.id),
      ),
    ).rejects.toThrow('Object mutation requires audit outbox');
    await expect(repository.findById(value.object.id)).resolves.toBeUndefined();
    await expect(capacity()).resolves.toEqual({
      account_used: 0,
      shard_used: 0,
    });
    await expect(outboxCount()).resolves.toBe(0);
  });

  it('does not append audit events for no-op mutations', async () => {
    await setupPlacement({ accountUsed: 0, shardUsed: 0 });
    const value = reservation('no-op');
    await expect(reserve(value)).resolves.toBe('RESERVED');

    await expect(
      reserve(value),
    ).resolves.toBe('OBJECT_CONFLICT');
    await expect(
      objects.completeUpload(
        value.object.id,
        'missing-session',
        '2026-09-01T00:01:00.000Z',
        'etag',
        null,
        audit('OBJECT_UPLOAD_COMPLETED', value.object.id, '2026-09-01T00:01:00.000Z'),
      ),
    ).resolves.toBe('NOT_FOUND');
    await expect(outboxCount()).resolves.toBe(1);
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
        audit('OBJECT_UPLOAD_COMPLETED', value.object.id, '2026-09-01T00:01:00.000Z'),
      ),
      objects.completeUpload(
        value.object.id,
        value.session.id,
        '2026-09-01T00:01:00.000Z',
        'etag-one',
        'checksum-one',
        audit('OBJECT_UPLOAD_COMPLETED', value.object.id, '2026-09-01T00:01:00.000Z'),
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
        audit('OBJECT_UPLOAD_COMPLETED', value.object.id, '2026-09-01T00:02:00.000Z'),
      ),
    ).toBe('ALREADY_COMPLETED');
    await expect(capacity()).resolves.toEqual({
      account_used: 120,
      shard_used: 120,
    });
    await expect(outboxCount('OBJECT_UPLOAD_RESERVED')).resolves.toBe(1);
    await expect(outboxCount('OBJECT_UPLOAD_COMPLETED')).resolves.toBe(1);
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
        audit('OBJECT_UPLOAD_COMPLETED', value.object.id, '2026-09-01T00:01:00.000Z'),
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
        audit('OBJECT_UPLOAD_COMPLETED', value.object.id, '2026-09-01T00:01:00.000Z'),
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
    await expect(outboxCount()).resolves.toBe(1);
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
        audit('OBJECT_UPLOAD_EXPIRED', value.object.id, '2026-09-01T00:16:00.000Z'),
      ),
    ).toBe('EXPIRED');
    expect(
      await objects.expireUploadAndReleaseCapacity(
        value.object.id,
        value.session.id,
        '2026-09-01T00:17:00.000Z',
        audit('OBJECT_UPLOAD_EXPIRED', value.object.id, '2026-09-01T00:17:00.000Z'),
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
      objects.listExpiredUploadsAwaitingCleanup(10, '2026-09-01T00:15:00.000Z'),
    ).resolves.toEqual([
      { objectId: value.object.id, uploadSessionId: value.session.id },
    ]);
    await expect(
      objects.finishExpiredUploadCleanup(
        value.object.id,
        value.session.id,
        audit('OBJECT_UPLOAD_ABORTED', value.object.id),
      ),
    ).resolves.toBe('CLEANED');
    await expect(
      objects.finishExpiredUploadCleanup(
        value.object.id,
        value.session.id,
        audit('OBJECT_UPLOAD_ABORTED', value.object.id),
      ),
    ).resolves.toBe('ALREADY_CLEANED');
    await expect(capacity()).resolves.toEqual({
      account_used: 100,
      shard_used: 100,
    });
    expect(await objects.findById(value.object.id)).toMatchObject({
      object: { status: 'PENDING' },
      uploadSession: { status: 'ABORTED', completedAt: null },
    });
    await expect(
      objects.listExpiredUploadsAwaitingCleanup(10, '2026-09-01T00:15:00.000Z'),
    ).resolves.toEqual([]);
    await expect(outboxCount('OBJECT_UPLOAD_EXPIRED')).resolves.toBe(1);
    await expect(outboxCount('OBJECT_UPLOAD_ABORTED')).resolves.toBe(1);
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
        audit('OBJECT_UPLOAD_COMPLETED', value.object.id, '2026-09-01T00:01:00.000Z'),
      ),
    ).toBe('COMPLETED');

    expect(
      await objects.beginDelete(
        value.object.id,
        '2026-09-01T00:02:00.000Z',
        audit('OBJECT_DELETE_STARTED', value.object.id, '2026-09-01T00:02:00.000Z'),
      ),
    ).toBe('STARTED');
    expect(
      await objects.beginDelete(
        value.object.id,
        '2026-09-01T00:03:00.000Z',
        audit('OBJECT_DELETE_STARTED', value.object.id, '2026-09-01T00:03:00.000Z'),
      ),
    ).toBe('ALREADY_DELETING');
    expect(
      await objects.finishDeleteAndReleaseCapacity(
        value.object.id,
        '2026-09-01T00:04:00.000Z',
        audit('OBJECT_DELETED', value.object.id, '2026-09-01T00:04:00.000Z'),
      ),
    ).toBe('DELETED');
    expect(
      await objects.finishDeleteAndReleaseCapacity(
        value.object.id,
        '2026-09-01T00:05:00.000Z',
        audit('OBJECT_DELETED', value.object.id, '2026-09-01T00:05:00.000Z'),
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
    await expect(outboxCount('OBJECT_UPLOAD_RESERVED')).resolves.toBe(1);
    await expect(outboxCount('OBJECT_UPLOAD_COMPLETED')).resolves.toBe(1);
    await expect(outboxCount('OBJECT_DELETE_STARTED')).resolves.toBe(1);
    await expect(outboxCount('OBJECT_DELETED')).resolves.toBe(1);
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

describe('atomic upload retries', () => {
  function nextAttempt(previous: Reservation, suffix = 'retry', sizeBytes = 75): Reservation {
    return {
      object: { ...previous.object, sizeBytes, contentType: 'text/plain', updatedAt: '2026-09-01T00:01:00.000Z' },
      location: { ...previous.location, id: `location-${suffix}`, physicalKey: `objects/${suffix}` },
      session: { ...previous.session, id: `session-${suffix}`, expiresAt: '2026-09-01T00:16:00.000Z' },
    };
  }

  function retry(next: Reservation, previousId: string, repository = objects) {
    return repository.reserveUploadAndCapacity(next.object, next.location, next.session,
      audit('OBJECT_UPLOAD_RETRIED', next.object.id, next.object.updatedAt), previousId);
  }

  it.each(['PENDING', 'EXPIRED', 'ABORTED'] as const)('retries %s with exactly one current session and no double release', async (status) => {
    await setupPlacement();
    const first = reservation('first');
    expect(await reserve(first)).toBe('RESERVED');
    if (status !== 'PENDING') {
      await objects.expireUploadAndReleaseCapacity(first.object.id, first.session.id, now,
        audit('OBJECT_UPLOAD_EXPIRED', first.object.id));
      if (status === 'ABORTED') await objects.finishExpiredUploadCleanup(first.object.id, first.session.id,
        audit('OBJECT_UPLOAD_ABORTED', first.object.id));
    }
    const next = nextAttempt(first);
    expect(await retry(next, first.session.id)).toBe('RESERVED');
    expect(await objects.findByLogicalKey('bucket-1', first.object.logicalKey)).toEqual({
      object: next.object, primaryLocation: next.location, uploadSession: next.session,
    });
    expect(await capacity()).toEqual({ account_used: 175, shard_used: 175 });
    expect(await rowCount('objects')).toBe(1);
    expect(await rowCount('upload_sessions')).toBe(2);
    expect(await objects.findUploadCleanupTarget(first.object.id, first.session.id)).toMatchObject({
      location: { id: first.location.id, physicalKey: first.location.physicalKey, isPrimary: false },
      session: { status: status === 'ABORTED' ? 'ABORTED' : 'EXPIRED' },
    });
    expect(await outboxCount('OBJECT_UPLOAD_RETRIED')).toBe(1);
  });

  it('allows only one concurrent retry of the same expected session', async () => {
    await setupPlacement();
    const first = reservation('first');
    await reserve(first);
    const results = await Promise.all([
      retry(nextAttempt(first, 'a'), first.session.id),
      retry(nextAttempt(first, 'b'), first.session.id),
    ]);
    expect(results.sort()).toEqual(['CONFLICT', 'RESERVED']);
    expect(await capacity()).toEqual({ account_used: 175, shard_used: 175 });
    expect(await rowCount('upload_sessions')).toBe(2);
    expect(await rowCount('object_locations')).toBe(2);
    expect(await outboxCount('OBJECT_UPLOAD_RETRIED')).toBe(1);
  });

  it('rolls back the old session, primary, size, capacity and audit when new capacity is unavailable', async () => {
    await setupPlacement();
    const first = reservation('first');
    await reserve(first);
    expect(await retry(nextAttempt(first, 'large', 801), first.session.id)).toBe('CAPACITY_UNAVAILABLE');
    expect(await objects.findById(first.object.id)).toEqual({ object: first.object,
      primaryLocation: first.location, uploadSession: first.session });
    expect(await capacity()).toEqual({ account_used: 150, shard_used: 150 });
    expect(await rowCount('upload_sessions')).toBe(1);
    expect(await outboxCount('OBJECT_UPLOAD_RETRIED')).toBe(0);
  });

  it('serializes scheduled expiry against retry and never releases the new reservation', async () => {
    await setupPlacement();
    const first = reservation('expiry-race');
    await reserve(first);
    const [retried] = await Promise.all([
      retry(nextAttempt(first), first.session.id),
      objects.expireUploadAndReleaseCapacity(first.object.id, first.session.id, now,
        audit('OBJECT_UPLOAD_EXPIRED', first.object.id)),
    ]);
    expect(retried).toBe('RESERVED');
    expect(await capacity()).toEqual({ account_used: 175, shard_used: 175 });
    expect(await objects.findById(first.object.id)).toMatchObject({
      object: { sizeBytes: 75 }, uploadSession: { id: 'session-retry', status: 'PENDING' },
    });
  });

  it('rolls back a retry when the audit statement fails in the same transaction', async () => {
    await setupPlacement();
    const first = reservation('first');
    await reserve(first);
    const broken = new D1ObjectRepository(testEnv.DB, { statement: () => testEnv.DB.prepare(
      'INSERT INTO audit_outbox (id) VALUES (NULL)',
    ) });
    await expect(retry(nextAttempt(first), first.session.id, broken)).rejects.toThrow();
    expect(await objects.findById(first.object.id)).toEqual({ object: first.object,
      primaryLocation: first.location, uploadSession: first.session });
    expect(await capacity()).toEqual({ account_used: 150, shard_used: 150 });
    expect(await rowCount('upload_sessions')).toBe(1);
  });

  it('never completes the new primary with an old session and cleans history even after READY/DELETED', async () => {
    await setupPlacement();
    const first = reservation('first');
    await reserve(first);
    const next = nextAttempt(first);
    await retry(next, first.session.id);
    expect(await objects.completeUpload(first.object.id, first.session.id, now, 'stale', null,
      audit('OBJECT_UPLOAD_COMPLETED', first.object.id))).toBe('INVALID_STATE');
    expect(await objects.completeUpload(next.object.id, next.session.id, now, 'new-etag', null,
      audit('OBJECT_UPLOAD_COMPLETED', next.object.id))).toBe('COMPLETED');
    expect(await retry(nextAttempt(first, 'overwrite'), next.session.id)).toBe('CONFLICT');
    expect(await objects.listExpiredUploadsAwaitingCleanup(10, '2026-09-01T00:14:59.999Z')).toEqual([]);
    expect(await objects.listExpiredUploadsAwaitingCleanup(10, '2026-09-01T00:15:00.000Z'))
      .toEqual([{ objectId: first.object.id, uploadSessionId: first.session.id }]);
    await objects.beginDelete(next.object.id, now, audit('OBJECT_DELETE_STARTED', next.object.id));
    await objects.finishDeleteAndReleaseCapacity(next.object.id, now, audit('OBJECT_DELETED', next.object.id));
    await testEnv.DB.prepare("UPDATE storage_shards SET status = 'RETIRED' WHERE id = 'shard-1'").run();
    const accounts = new D1StorageAccountRepository(testEnv.DB);
    expect(await accounts.hasBlockingReferences('account-1')).toBe(true);
    expect(await objects.listExpiredUploadsAwaitingCleanup(10, '2026-09-01T00:15:00.000Z')).toHaveLength(1);
    expect(await objects.finishExpiredUploadCleanup(first.object.id, first.session.id,
      audit('OBJECT_UPLOAD_ABORTED', first.object.id))).toBe('CLEANED');
    expect(await objects.finishExpiredUploadCleanup(first.object.id, first.session.id,
      audit('OBJECT_UPLOAD_ABORTED', first.object.id))).toBe('ALREADY_CLEANED');
    expect(await accounts.hasBlockingReferences('account-1')).toBe(false);
    expect(await capacity()).toEqual({ account_used: 100, shard_used: 100 });
    expect(await objects.findById(next.object.id)).toMatchObject({ object: { status: 'DELETED' },
      primaryLocation: { id: next.location.id, etag: 'new-etag' }, uploadSession: { id: next.session.id } });
  });

  it('serializes completion against retry without overwriting the winning state', async () => {
    await setupPlacement();
    const first = reservation('first');
    await reserve(first);
    const [completion, retried] = await Promise.all([
      objects.completeUpload(first.object.id, first.session.id, now, 'old-etag', null,
        audit('OBJECT_UPLOAD_COMPLETED', first.object.id)),
      retry(nextAttempt(first), first.session.id),
    ]);
    const current = await objects.findById(first.object.id);
    if (retried === 'RESERVED') {
      expect(completion).not.toBe('COMPLETED');
      expect(current?.uploadSession?.id).toBe('session-retry');
      expect(await capacity()).toEqual({ account_used: 175, shard_used: 175 });
    } else {
      expect(completion).toBe('COMPLETED');
      expect(current?.object.status).toBe('READY');
      expect(await capacity()).toEqual({ account_used: 150, shard_used: 150 });
    }
  });

  it('rejects cross-object session location bindings', async () => {
    await setupPlacement();
    const first = reservation('first');
    const second = reservation('second');
    await reserve(first);
    await reserve(second);
    await expect(testEnv.DB.prepare('UPDATE upload_sessions SET location_id = ? WHERE id = ?')
      .bind(second.location.id, first.session.id).run()).rejects.toThrow('openpool_object_upload_location_conflict');
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
