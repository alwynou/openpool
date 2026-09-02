import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AuditLogEntry, CredentialEnvelope } from '@openpool/application';
import type { StorageAccount } from '@openpool/domain';

import {
  D1AuditOutboxRepository,
  ManagedD1StorageAccountRepository,
} from '../src/adapters/d1';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;
const outbox = new D1AuditOutboxRepository(testEnv.DB);
const repository = new ManagedD1StorageAccountRepository(testEnv.DB, outbox);

const envelope: CredentialEnvelope = {
  version: 1,
  algorithm: 'AES-256-GCM',
  keyId: 'key-1',
  iv: 'aXY=',
  ciphertext: 'c2VjcmV0',
};

const replacementEnvelope: CredentialEnvelope = {
  ...envelope,
  keyId: 'key-2',
  ciphertext: 'bmV3LXNlY3JldA==',
};

function account(overrides: Partial<StorageAccount> = {}): StorageAccount {
  return {
    id: 'account-1',
    name: 'Primary',
    provider: 's3',
    status: 'VERIFYING',
    priority: 0,
    writeEnabled: false,
    capacityBytes: 1000,
    usedBytes: 100,
    healthStatus: 'UNKNOWN',
    capacityAccuracy: 'CONFIGURED',
    providerConfig: { endpoint: 'https://objects.example.test', region: 'auto' },
    capabilities: {
      presignedUpload: false,
      presignedDownload: false,
      headObject: false,
      deleteObject: false,
      bucketProbe: false,
      usageProbe: false,
    },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastHealthCheckedAt: null,
    ...overrides,
  };
}

function audit(
  value: StorageAccount,
  action:
    | 'STORAGE_ACCOUNT_CREATED'
    | 'STORAGE_ACCOUNT_CONFIGURATION_UPDATED'
    | 'STORAGE_ACCOUNT_STATUS_CHANGED',
): AuditLogEntry {
  return {
    actorType: 'ADMIN',
    actorId: 'admin-1',
    action,
    resourceType: 'STORAGE_ACCOUNT',
    resourceId: value.id,
    createdAt: value.updatedAt,
  };
}

function createAccount(
  value: StorageAccount,
  credentialEnvelope: CredentialEnvelope,
): Promise<boolean> {
  return repository.create(
    value,
    credentialEnvelope,
    audit(value, 'STORAGE_ACCOUNT_CREATED'),
  );
}

function updateAccount(
  value: StorageAccount,
  expectedStatus: StorageAccount['status'],
  expectedUpdatedAt: string,
): Promise<boolean> {
  return repository.update(
    value,
    expectedStatus,
    expectedUpdatedAt,
    audit(value, 'STORAGE_ACCOUNT_STATUS_CHANGED'),
  );
}

function updateConfiguration(
  value: StorageAccount,
  credentialEnvelope: CredentialEnvelope,
  expectedUpdatedAt: string,
): Promise<boolean> {
  return repository.updateVerifyingConfiguration(
    value,
    credentialEnvelope,
    expectedUpdatedAt,
    audit(value, 'STORAGE_ACCOUNT_CONFIGURATION_UPDATED'),
  );
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

describe('managed storage account D1 repository', () => {
  it('round-trips all metadata and retains the encrypted envelope', async () => {
    const original = account();
    expect(await createAccount(original, envelope)).toBe(true);

    const found = await repository.findById(original.id);
    expect(found).toEqual({ ...original, credentialEnvelope: envelope });
    expect(JSON.stringify(found)).not.toContain('secret payload');

    await testEnv.DB.prepare(
      'UPDATE storage_accounts SET last_health_status = NULL WHERE id = ?',
    )
      .bind(original.id)
      .run();
    expect((await repository.findById(original.id))?.healthStatus).toBe('UNKNOWN');
  });

  it('returns false for an atomic duplicate name create', async () => {
    expect(await createAccount(account(), envelope)).toBe(true);
    expect(
      await createAccount(
        account({ id: 'account-2', name: 'Primary' }),
        { ...envelope, keyId: 'key-2' },
      ),
    ).toBe(false);
    expect((await repository.list()).map(({ id }) => id)).toEqual(['account-1']);
    expect(
      await testEnv.DB.prepare(
        'SELECT COUNT(*) AS count FROM audit_outbox',
      ).first(),
    ).toEqual({ count: 1 });
  });

  it('rolls back the account when the outbox append fails', async () => {
    const fixedOutbox = new D1AuditOutboxRepository(testEnv.DB, {
      idGenerator: () => 'event-fixed',
    });
    const conflicting = new ManagedD1StorageAccountRepository(
      testEnv.DB,
      fixedOutbox,
    );
    const first = account();
    const second = account({ id: 'account-2', name: 'Secondary' });

    await expect(
      conflicting.create(
        first,
        envelope,
        audit(first, 'STORAGE_ACCOUNT_CREATED'),
      ),
    ).resolves.toBe(true);
    await expect(
      conflicting.create(
        second,
        replacementEnvelope,
        audit(second, 'STORAGE_ACCOUNT_CREATED'),
      ),
    ).rejects.toThrow();
    await expect(conflicting.findById(second.id)).resolves.toBeUndefined();
  });

  it('fails closed when a mutation repository has no outbox', async () => {
    const unconfigured = new ManagedD1StorageAccountRepository(testEnv.DB);
    const value = account();

    await expect(
      unconfigured.create(
        value,
        envelope,
        audit(value, 'STORAGE_ACCOUNT_CREATED'),
      ),
    ).rejects.toThrow('requires an audit outbox');
    await expect(unconfigured.findById(value.id)).resolves.toBeUndefined();
  });

  it('updates only when the expected status still matches', async () => {
    const original = account({ status: 'ACTIVE', writeEnabled: true });
    expect(await createAccount(original, envelope)).toBe(true);
    const changed = account({
      status: 'DRAINING',
      writeEnabled: false,
      updatedAt: '2026-09-01T01:00:00.000Z',
      providerConfig: { endpoint: 'https://new.example.test' },
    });
    expect(
      await updateAccount(changed, 'ACTIVE', original.updatedAt),
    ).toBe(true);
    expect(
      await updateAccount(
        account({ status: 'READ_ONLY' }),
        'ACTIVE',
        original.updatedAt,
      ),
    ).toBe(false);
    expect((await repository.findById(original.id))?.credentialEnvelope).toEqual(envelope);
    expect((await repository.findById(original.id))?.providerConfig).toEqual({
      endpoint: 'https://new.example.test',
    });
  });

  it('does not overwrite capacity changed after a stale read', async () => {
    const original = account({
      status: 'ACTIVE',
      writeEnabled: true,
      healthStatus: 'HEALTHY',
    });
    expect(await createAccount(original, envelope)).toBe(true);
    await testEnv.DB.prepare(
      `UPDATE storage_accounts
       SET used_bytes = 125, updated_at = '2026-09-01T00:30:00.000Z'
       WHERE id = ?`,
    )
      .bind(original.id)
      .run();

    const stale = account({
      status: 'DRAINING',
      writeEnabled: false,
      updatedAt: '2026-09-01T01:00:00.000Z',
    });
    expect(
      await updateAccount(stale, 'ACTIVE', original.updatedAt),
    ).toBe(false);
    expect(await repository.findById(original.id)).toMatchObject({
      status: 'ACTIVE',
      usedBytes: 125,
      updatedAt: '2026-09-01T00:30:00.000Z',
    });
  });

  it('atomically corrects configuration and credentials only while verifying', async () => {
    const original = account({
      healthStatus: 'DEGRADED',
      lastHealthCheckedAt: '2026-09-01T00:10:00.000Z',
    });
    expect(await createAccount(original, envelope)).toBe(true);
    const corrected = account({
      providerConfig: {
        endpoint: 'https://corrected.example.test',
        region: 'auto',
      },
      updatedAt: '2026-09-01T00:00:00.001Z',
    });

    expect(
      await updateConfiguration(
        corrected,
        replacementEnvelope,
        original.updatedAt,
      ),
    ).toBe(true);
    expect(await repository.findById(original.id)).toMatchObject({
      providerConfig: {
        endpoint: 'https://corrected.example.test',
        region: 'auto',
      },
      credentialEnvelope: replacementEnvelope,
      healthStatus: 'UNKNOWN',
      lastHealthCheckedAt: null,
      updatedAt: '2026-09-01T00:00:00.001Z',
    });

    expect(
      await updateConfiguration(
        account({
          providerConfig: { endpoint: 'https://stale.example.test' },
          updatedAt: '2026-09-01T00:00:00.002Z',
        }),
        envelope,
        original.updatedAt,
      ),
    ).toBe(false);
    expect(await repository.findById(original.id)).toMatchObject({
      providerConfig: {
        endpoint: 'https://corrected.example.test',
        region: 'auto',
      },
      credentialEnvelope: replacementEnvelope,
    });
  });

  it('filters writable accounts using lifecycle, health, write, and accuracy rules', async () => {
    const writable = account({
      id: 'writable',
      name: 'Writable',
      status: 'ACTIVE',
      writeEnabled: true,
      healthStatus: 'HEALTHY',
      capacityAccuracy: 'EXACT',
    });
    const cases = [
      account({ id: 'inactive', name: 'Inactive', status: 'DRAINING', writeEnabled: false, healthStatus: 'HEALTHY' }),
      account({ id: 'no-write', name: 'No write', status: 'ACTIVE', writeEnabled: false, healthStatus: 'HEALTHY' }),
      account({ id: 'unhealthy', name: 'Unhealthy', status: 'ACTIVE', writeEnabled: true, healthStatus: 'DEGRADED' }),
      account({ id: 'unknown-capacity', name: 'Unknown capacity', status: 'ACTIVE', writeEnabled: true, healthStatus: 'HEALTHY', capacityAccuracy: 'UNKNOWN' }),
    ];
    expect(await createAccount(writable, envelope)).toBe(true);
    for (const candidate of cases) {
      expect(await createAccount(candidate, envelope)).toBe(true);
    }
    expect((await repository.listWritable()).map(({ id }) => id)).toEqual(['writable']);
  });

  it('fails closed when persisted JSON is malformed', async () => {
    const original = account();
    expect(await createAccount(original, envelope)).toBe(true);
    await testEnv.DB.prepare(
      "UPDATE storage_accounts SET provider_config = '[1]' WHERE id = ?",
    )
      .bind(original.id)
      .run();
    await expect(repository.findById(original.id)).rejects.toThrow(
      'Invalid storage account provider_config',
    );
  });

  it('detects live shard and object references that block removal', async () => {
    expect(
      await createAccount(account({ usedBytes: 0 }), envelope),
    ).toBe(true);
    await expect(repository.hasBlockingReferences('account-1')).resolves.toBe(
      false,
    );
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO logical_buckets
         (id, name, description, created_at, updated_at)
         VALUES ('bucket-1', 'documents', NULL, ?, ?)`,
      ).bind(account().createdAt, account().updatedAt),
      testEnv.DB.prepare(
        `INSERT INTO storage_shards
         (id, logical_bucket_id, storage_account_id, physical_bucket, status,
          capacity_bytes, used_bytes, created_at, updated_at)
         VALUES ('shard-1', 'bucket-1', 'account-1', 'physical-one', 'ACTIVE',
                 1000, 0, ?, ?)`,
      ).bind(account().createdAt, account().updatedAt),
    ]);
    await expect(repository.hasBlockingReferences('account-1')).resolves.toBe(
      true,
    );
    await testEnv.DB.prepare(
      "UPDATE storage_shards SET status = 'RETIRED' WHERE id = 'shard-1'",
    ).run();
    await expect(repository.hasBlockingReferences('account-1')).resolves.toBe(
      false,
    );

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO objects
         (id, logical_bucket_id, logical_key, size_bytes, content_type,
          checksum, status, created_at, updated_at)
         VALUES ('object-1', 'bucket-1', 'retained', 0,
                 'application/octet-stream', NULL, 'PENDING', ?, ?)`,
      ).bind(account().createdAt, account().updatedAt),
      testEnv.DB.prepare(
        `INSERT INTO object_locations
         (id, object_id, storage_account_id, storage_shard_id,
          physical_bucket, physical_key, etag, is_primary, created_at,
          updated_at)
         VALUES ('location-1', 'object-1', 'account-1', 'shard-1',
                 'physical-one', 'objects/retained', NULL, 0, ?, ?)`,
      ).bind(account().createdAt, account().updatedAt),
    ]);
    await expect(repository.hasBlockingReferences('account-1')).resolves.toBe(
      true,
    );
    await testEnv.DB.prepare(
      "UPDATE objects SET status = 'DELETED' WHERE id = 'object-1'",
    ).run();
    await expect(repository.hasBlockingReferences('account-1')).resolves.toBe(
      false,
    );
  });
});
