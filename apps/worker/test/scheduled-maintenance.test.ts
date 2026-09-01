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
