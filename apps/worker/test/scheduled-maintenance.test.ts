import { env } from 'cloudflare:workers';
import {
  applyD1Migrations,
  createExecutionContext,
  type D1Migration,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CredentialPayload,
  ProviderRegistry,
  StorageProvider,
} from '@openpool/application';

import worker from '../src';
import { D1AuditOutboxRepository } from '../src/adapters/d1';
import { runScheduledMaintenance } from '../src/composition/root';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;
const now = '2026-09-01T00:30:00.000Z';

const credentialEnvelope = JSON.stringify({
  version: 1,
  algorithm: 'AES-256-GCM',
  keyId: 'test-key',
  iv: 'aXY=',
  ciphertext: 'Y2lwaGVydGV4dA==',
});

const provider: StorageProvider = {
  capabilities: {
    presignedUpload: true,
    presignedDownload: true,
    headObject: true,
    deleteObject: true,
    bucketProbe: true,
    usageProbe: false,
  },
  validate: vi.fn(),
  createUploadUrl: vi.fn(),
  createDownloadUrl: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(async () => undefined),
  probe: vi.fn(),
};

const providers: ProviderRegistry = {
  forAccount: () => provider,
};

const vault = {
  encrypt: vi.fn(async (payload: CredentialPayload) => ({
    version: 1 as const,
    algorithm: 'AES-256-GCM' as const,
    keyId: 'test-key',
    iv: 'aXY=',
    ciphertext: JSON.stringify(payload),
  })),
  decrypt: vi.fn(async () => ({
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
  })),
};

beforeEach(async () => {
  vi.clearAllMocks();
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
    testEnv.DB.prepare('DELETE FROM audit_logs'),
  ]);
});

async function seedExpiredUpload(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB
      .prepare(
        `INSERT INTO storage_accounts
         (id, name, provider, status, priority, write_enabled, capacity_bytes,
          used_bytes, provider_config, credential_envelope,
          last_health_status, capabilities, capacity_accuracy, created_at,
          updated_at)
         VALUES ('account-1', 'Primary', 'r2', 'ACTIVE', 0, 1, 1000, 50,
                 '{}', ?, 'HEALTHY',
                 '{"presignedUpload":true,"presignedDownload":true,"headObject":true,"deleteObject":true,"bucketProbe":true,"usageProbe":false}',
                 'CONFIGURED', ?, ?)`,
      )
      .bind(credentialEnvelope, now, now),
    testEnv.DB.prepare(
      `INSERT INTO logical_buckets
       (id, name, description, created_at, updated_at)
       VALUES ('bucket-1', 'documents', NULL, ?, ?)`,
    ).bind(now, now),
    testEnv.DB.prepare(
      `INSERT INTO storage_shards
       (id, logical_bucket_id, storage_account_id, physical_bucket, status,
        capacity_bytes, used_bytes, created_at, updated_at)
       VALUES ('shard-1', 'bucket-1', 'account-1', 'physical-one', 'ACTIVE',
               1000, 50, ?, ?)`,
    ).bind(now, now),
    testEnv.DB.prepare(
      `INSERT INTO objects
       (id, logical_bucket_id, logical_key, size_bytes, content_type, checksum,
        status, created_at, updated_at)
       VALUES ('object-1', 'bucket-1', 'key-1', 50, 'application/octet-stream',
               NULL, 'PENDING', ?, ?)`,
    ).bind(now, now),
    testEnv.DB.prepare(
      `INSERT INTO object_locations
       (id, object_id, storage_account_id, storage_shard_id, physical_bucket,
        physical_key, etag, is_primary, created_at, updated_at)
       VALUES ('location-1', 'object-1', 'account-1', 'shard-1', 'physical-one',
               'objects/key-1', NULL, 1, ?, ?)`,
    ).bind(now, now),
    testEnv.DB.prepare(
      `INSERT INTO upload_sessions
       (id, object_id, status, expires_at, created_at, completed_at)
       VALUES ('session-1', 'object-1', 'PENDING', '2026-09-01T00:15:00.000Z',
               ?, NULL)`,
    ).bind(now),
  ]);
}

async function seedSwitchedMigrationCleanup(): Promise<void> {
  const capabilityJson =
    '{"presignedUpload":true,"presignedDownload":true,"headObject":true,"deleteObject":true,"bucketProbe":true,"usageProbe":false}';
  await testEnv.DB.batch([
    testEnv.DB
      .prepare(
        `INSERT INTO storage_accounts
         (id, name, provider, status, priority, write_enabled, capacity_bytes,
          used_bytes, provider_config, credential_envelope,
          last_health_status, capabilities, capacity_accuracy, created_at,
          updated_at)
         VALUES ('source-account', 'Source', 'r2', 'ACTIVE', 0, 1, 1000,
                 0, '{}', ?, 'HEALTHY', ?, 'CONFIGURED', ?, ?),
                ('target-account', 'Target', 'r2', 'ACTIVE', 0, 1, 1000,
                 0, '{}', ?, 'HEALTHY', ?, 'CONFIGURED', ?, ?)`,
      )
      .bind(
        credentialEnvelope,
        capabilityJson,
        now,
        now,
        credentialEnvelope,
        capabilityJson,
        now,
        now,
      ),
    testEnv.DB.prepare(
      `INSERT INTO logical_buckets
       (id, name, description, created_at, updated_at)
       VALUES ('migration-bucket', 'migration', NULL, ?, ?)`,
    ).bind(now, now),
    testEnv.DB.prepare(
      `INSERT INTO storage_shards
       (id, logical_bucket_id, storage_account_id, physical_bucket, status,
        capacity_bytes, used_bytes, created_at, updated_at)
       VALUES ('source-shard', 'migration-bucket', 'source-account',
               'source-physical', 'ACTIVE', 1000, 0, ?, ?),
              ('target-shard', 'migration-bucket', 'target-account',
               'target-physical', 'STANDBY', 1000, 0, ?, ?)`,
    ).bind(now, now, now, now),
    testEnv.DB.prepare(
      `INSERT INTO objects
       (id, logical_bucket_id, logical_key, size_bytes, content_type, checksum,
        status, created_at, updated_at)
       VALUES ('migration-object', 'migration-bucket', 'object.txt', 50,
               'text/plain', NULL, 'PENDING', ?, ?)`,
    ).bind(now, now),
    testEnv.DB.prepare(
      `INSERT INTO object_locations
       (id, object_id, storage_account_id, storage_shard_id, physical_bucket,
        physical_key, etag, is_primary, created_at, updated_at)
       VALUES ('source-location', 'migration-object', 'source-account',
               'source-shard', 'source-physical', 'objects/migration-object',
               'source-etag', 1, ?, ?),
              ('target-location', 'migration-object', 'target-account',
               'target-shard', 'target-physical', 'objects/migration-object',
               'target-etag', 0, ?, ?)`,
    ).bind(now, now, now, now),
    testEnv.DB.prepare(
      `UPDATE objects SET status = 'READY' WHERE id = 'migration-object'`,
    ),
    testEnv.DB.prepare(
      `UPDATE storage_accounts
       SET status = 'DRAINING', write_enabled = 0
       WHERE id = 'source-account'`,
    ),
    testEnv.DB.prepare(
      `UPDATE storage_accounts SET used_bytes = 50
       WHERE id = 'target-account'`,
    ),
    testEnv.DB.prepare(
      `UPDATE storage_shards SET status = 'MIGRATING'
       WHERE id = 'source-shard'`,
    ),
    testEnv.DB.prepare(
      `UPDATE storage_shards SET status = 'ACTIVE', used_bytes = 50
       WHERE id = 'target-shard'`,
    ),
    testEnv.DB.prepare(
      `UPDATE object_locations SET is_primary = 0
       WHERE id = 'source-location'`,
    ),
    testEnv.DB.prepare(
      `UPDATE object_locations SET is_primary = 1
       WHERE id = 'target-location'`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO shard_migrations
       (id, source_shard_id, target_shard_id, status, created_at, updated_at,
        completed_at)
       VALUES ('migration-1', 'source-shard', 'target-shard', 'RUNNING', ?, ?,
               NULL)`,
    ).bind(now, now),
    testEnv.DB.prepare(
      `INSERT INTO shard_migration_objects
       (id, migration_id, object_id, source_location_id, target_location_id,
        target_physical_key, status, lease_token, lease_expires_at,
        attempt_count, last_error_code, created_at, updated_at, completed_at)
       VALUES ('migration-task', 'migration-1', 'migration-object',
               'source-location', 'target-location', 'objects/migration-object',
               'SWITCHED', 'lease-secret', '2026-09-01T00:15:00.000Z', 1,
               NULL, ?, ?, NULL)`,
    ).bind(now, now),
  ]);
}

describe('scheduled maintenance composition', () => {
  it('sweeps expired uploads through local D1 and injected provider ports', async () => {
    await seedExpiredUpload();
    let maintenanceId = 0;

    await expect(
      runScheduledMaintenance(testEnv, {
        clock: { now: () => new Date('2026-09-01T00:30:00.000Z') },
        providerRegistry: providers,
        credentialVault: vault,
        idGenerator: { next: () => `maintenance-id-${maintenanceId++}` },
      }),
    ).resolves.toEqual({
      pendingCandidates: 1,
      expired: 1,
      cleanupCandidates: 1,
      cleaned: 1,
      failed: 0,
      migrationCleanupCandidates: 0,
      migrationsCleaned: 0,
      migrationsCompleted: 0,
      migrationCleanupFailed: 0,
      auditOutboxClaimed: 2,
      auditOutboxDelivered: 2,
      auditOutboxRetried: 0,
      auditOutboxFailed: 0,
    });

    expect(provider.deleteObject).toHaveBeenCalledOnce();
    expect(vault.decrypt).toHaveBeenCalledOnce();
    await expect(
      testEnv.DB.prepare(
        'SELECT status FROM upload_sessions WHERE id = ?',
      )
        .bind('session-1')
        .first<{ status: string }>(),
    ).resolves.toEqual({ status: 'ABORTED' });
  });

  it('recovers switched shard migration source cleanup', async () => {
    await seedSwitchedMigrationCleanup();
    let maintenanceId = 0;

    await expect(
      runScheduledMaintenance(testEnv, {
        clock: { now: () => new Date(now) },
        providerRegistry: providers,
        credentialVault: vault,
        idGenerator: { next: () => `maintenance-id-${maintenanceId++}` },
      }),
    ).resolves.toEqual({
      pendingCandidates: 0,
      expired: 0,
      cleanupCandidates: 0,
      cleaned: 0,
      failed: 0,
      migrationCleanupCandidates: 1,
      migrationsCleaned: 1,
      migrationsCompleted: 1,
      migrationCleanupFailed: 0,
      auditOutboxClaimed: 2,
      auditOutboxDelivered: 2,
      auditOutboxRetried: 0,
      auditOutboxFailed: 0,
    });

    expect(provider.deleteObject).toHaveBeenCalledOnce();
    expect(vault.decrypt).toHaveBeenCalledOnce();
    await expect(
      testEnv.DB.prepare(
        `SELECT migration.status AS migration_status,
                task.status AS task_status, source.status AS source_status
         FROM shard_migrations AS migration
         JOIN shard_migration_objects AS task
           ON task.migration_id = migration.id
         JOIN storage_shards AS source ON source.id = migration.source_shard_id
         WHERE migration.id = 'migration-1'`,
      ).first(),
    ).resolves.toEqual({
      migration_status: 'COMPLETED',
      task_status: 'COMPLETED',
      source_status: 'RETIRED',
    });
  });

  it('projects a pending audit outbox event during maintenance', async () => {
    const outbox = new D1AuditOutboxRepository(testEnv.DB, {
      requestId: 'request-1',
      idGenerator: () => 'event-1',
    });
    await outbox.record({
      actorType: 'ADMIN',
      actorId: 'admin-1',
      action: 'LOGICAL_BUCKET_CREATED',
      resourceType: 'LOGICAL_BUCKET',
      resourceId: 'bucket-1',
      createdAt: now,
    });
    let maintenanceId = 0;

    await expect(
      runScheduledMaintenance(testEnv, {
        clock: { now: () => new Date(now) },
        providerRegistry: providers,
        credentialVault: vault,
        idGenerator: { next: () => `maintenance-id-${maintenanceId++}` },
      }),
    ).resolves.toMatchObject({
      auditOutboxClaimed: 1,
      auditOutboxDelivered: 1,
      auditOutboxRetried: 0,
      auditOutboxFailed: 0,
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT event_id, action
         FROM audit_logs
         WHERE event_id = 'event-1'`,
      ).first(),
    ).resolves.toEqual({
      event_id: 'event-1',
      action: 'LOGICAL_BUCKET_CREATED',
    });
  });
});

describe('Worker scheduled handler', () => {
  it('dispatches maintenance with waitUntil on the local runtime', async () => {
    const executionContext = createExecutionContext();
    const waitUntil = vi.spyOn(executionContext, 'waitUntil');
    const fetch = vi.spyOn(globalThis, 'fetch');

    if (!worker.scheduled) throw new Error('Worker scheduled handler missing');
    worker.scheduled(
      {
        cron: '*/5 * * * *',
        scheduledTime: Date.now(),
        type: 'scheduled',
      },
      testEnv,
      executionContext,
    );

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil.mock.calls[0]?.[0]).toEqual(expect.any(Promise));
    await waitOnExecutionContext(executionContext);
    expect(fetch).not.toHaveBeenCalled();
  });
});
