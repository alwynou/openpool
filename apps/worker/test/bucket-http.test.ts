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

import { WebCryptoPasswordHasher } from '../src/adapters/auth';
import { WebCryptoCredentialVault } from '../src/adapters/crypto';
import { createWorker } from '../src/composition/root';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

const capabilities = {
  presignedUpload: true,
  presignedDownload: true,
  headObject: true,
  deleteObject: true,
  bucketProbe: true,
  usageProbe: false,
} as const;

const expectedCredentials = {
  accessKeyId: 'offline-access-key',
  secretAccessKey: 'offline-secret-key',
} as const;

const validate = vi.fn(
  async (
    credentials: CredentialPayload,
    config: Readonly<Record<string, string | number | boolean | null>>,
  ) => {
    expect(credentials).toEqual(expectedCredentials);
    expect(config).toEqual({
      accountId: 'offline-account',
      validationBucket: 'provider-validation',
    });
    return { capabilities };
  },
);

const probe = vi.fn(async (credentials: CredentialPayload) => {
  expect(credentials).toEqual(expectedCredentials);
  return {
    healthStatus: 'HEALTHY' as const,
    capacityBytes: null,
    usedBytes: null,
    capacityAccuracy: 'UNKNOWN' as const,
  };
});

const provider: StorageProvider = {
  capabilities,
  createUploadUrl: vi.fn(async () => ({
    url: 'https://provider.invalid/upload',
    expiresAt: '2026-09-01T00:15:00.000Z',
  })),
  createDownloadUrl: vi.fn(async () => ({
    url: 'https://provider.invalid/download',
    expiresAt: '2026-09-01T00:15:00.000Z',
  })),
  headObject: vi.fn(async () => ({
    sizeBytes: 0,
    etag: null,
    checksum: null,
  })),
  deleteObject: vi.fn(async () => undefined),
  validate,
  probe,
};

const providerRegistry: ProviderRegistry = {
  forAccount: vi.fn(() => provider),
};

const testEnv = env as unknown as TestEnv;
const worker = createWorker({
  passwordHasher: new WebCryptoPasswordHasher({ iterations: 1_000 }),
  credentialVault: new WebCryptoCredentialVault({
    masterKey: new Uint8Array(32).fill(19),
    keyId: 'offline-test-key',
  }),
  providerRegistry,
});

async function dispatch(path: string, init: RequestInit = {}): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://openpool.test${path}`, init),
    testEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function jsonRequest(
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return dispatch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

function expectSafeNoStore(response: Response, text: string): void {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(text).not.toContain(expectedCredentials.accessKeyId);
  expect(text).not.toContain(expectedCredentials.secretAccessKey);
  expect(text.toLowerCase()).not.toContain('credential');
  expect(text.toLowerCase()).not.toContain('envelope');
}

async function administratorCookie(): Promise<string> {
  const setup = await dispatch('/api/v1/setup', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-openpool-bootstrap-token': 'test-bootstrap-token',
    },
    body: JSON.stringify({
      username: 'administrator',
      password: 'correct horse battery staple',
    }),
  });
  expect(setup.status).toBe(201);

  const login = await jsonRequest('/api/v1/auth/login', 'POST', {
    username: 'administrator',
    password: 'correct horse battery staple',
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Login did not return a session cookie');
  return cookie;
}

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
    testEnv.DB.prepare('DELETE FROM auth_sessions'),
    testEnv.DB.prepare('DELETE FROM administrators'),
  ]);
});

describe('bucket composition', () => {
  it('runs the authenticated storage-account, bucket, and shard flow offline', async () => {
    const cookie = await administratorCookie();
    const createdAccount = await jsonRequest(
      '/api/v1/storage-accounts',
      'POST',
      {
        name: 'Offline R2',
        provider: 'r2',
        providerConfig: {
          accountId: 'offline-account',
          validationBucket: 'provider-validation',
        },
        credentials: expectedCredentials,
        capacityBytes: 10_000,
      },
      cookie,
    );
    expect(createdAccount.status).toBe(201);
    const createdAccountText = await createdAccount.text();
    expectSafeNoStore(createdAccount, createdAccountText);
    const account = JSON.parse(createdAccountText) as {
      data: { id: string; status: string };
    };
    expect(account.data.status).toBe('VERIFYING');

    const storedAccount = await testEnv.DB.prepare(
      `SELECT credential_envelope, status
       FROM storage_accounts
       WHERE id = ?`,
    )
      .bind(account.data.id)
      .first<{ credential_envelope: string; status: string }>();
    expect(storedAccount?.status).toBe('VERIFYING');
    expect(storedAccount?.credential_envelope).toContain('AES-256-GCM');
    expect(storedAccount?.credential_envelope).not.toContain(
      expectedCredentials.secretAccessKey,
    );

    const verifiedAccount = await dispatch(
      `/api/v1/storage-accounts/${account.data.id}/verify`,
      { method: 'POST', headers: { cookie } },
    );
    expect(verifiedAccount.status).toBe(200);
    const verifiedAccountText = await verifiedAccount.text();
    expectSafeNoStore(verifiedAccount, verifiedAccountText);
    expect(JSON.parse(verifiedAccountText)).toMatchObject({
      data: {
        id: account.data.id,
        status: 'ACTIVE',
        writeEnabled: true,
        healthStatus: 'HEALTHY',
        capacityBytes: 10_000,
        capacityAccuracy: 'CONFIGURED',
        capabilities,
      },
    });
    expect(validate).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();

    const createdBucket = await jsonRequest(
      '/api/v1/buckets',
      'POST',
      { name: 'Documents', description: 'Offline integration bucket' },
      cookie,
    );
    expect(createdBucket.status).toBe(201);
    const createdBucketText = await createdBucket.text();
    expectSafeNoStore(createdBucket, createdBucketText);
    const bucket = JSON.parse(createdBucketText) as {
      data: { id: string; name: string };
    };
    expect(bucket.data.name).toBe('Documents');

    const createdShard = await jsonRequest(
      `/api/v1/buckets/${bucket.data.id}/shards`,
      'POST',
      {
        storageAccountId: account.data.id,
        physicalBucket: 'openpool-documents-primary',
        status: 'ACTIVE',
        capacityBytes: 9_000,
        usedBytes: 100,
      },
      cookie,
    );
    expect(createdShard.status).toBe(201);
    const createdShardText = await createdShard.text();
    expectSafeNoStore(createdShard, createdShardText);
    const shard = JSON.parse(createdShardText) as {
      data: { id: string; status: string };
    };
    expect(shard.data.status).toBe('ACTIVE');

    const bucketList = await dispatch('/api/v1/buckets', {
      headers: { cookie },
    });
    expect(bucketList.status).toBe(200);
    const bucketListText = await bucketList.text();
    expectSafeNoStore(bucketList, bucketListText);
    expect(JSON.parse(bucketListText)).toMatchObject({
      data: [{ id: bucket.data.id, name: 'Documents' }],
    });

    const bucketDetail = await dispatch(
      `/api/v1/buckets/${bucket.data.id}`,
      { headers: { cookie } },
    );
    expect(bucketDetail.status).toBe(200);
    const bucketDetailText = await bucketDetail.text();
    expectSafeNoStore(bucketDetail, bucketDetailText);
    expect(JSON.parse(bucketDetailText)).toMatchObject({
      data: { id: bucket.data.id, name: 'Documents' },
    });

    const shardList = await dispatch(
      `/api/v1/buckets/${bucket.data.id}/shards`,
      { headers: { cookie } },
    );
    expect(shardList.status).toBe(200);
    const shardListText = await shardList.text();
    expectSafeNoStore(shardList, shardListText);
    expect(JSON.parse(shardListText)).toMatchObject({
      data: [
        {
          id: shard.data.id,
          logicalBucketId: bucket.data.id,
          storageAccountId: account.data.id,
          physicalBucket: 'openpool-documents-primary',
          status: 'ACTIVE',
        },
      ],
    });

    const secondActiveShard = await jsonRequest(
      `/api/v1/buckets/${bucket.data.id}/shards`,
      'POST',
      {
        storageAccountId: account.data.id,
        physicalBucket: 'openpool-documents-secondary',
        status: 'ACTIVE',
        capacityBytes: 9_000,
      },
      cookie,
    );
    expect(secondActiveShard.status).toBe(409);
    const secondActiveText = await secondActiveShard.text();
    expectSafeNoStore(secondActiveShard, secondActiveText);
    expect(JSON.parse(secondActiveText)).toMatchObject({
      error: { code: 'STORAGE_SHARD_ACTIVE_CONFLICT' },
    });

    const invalidTransition = await jsonRequest(
      `/api/v1/shards/${shard.data.id}/status`,
      'PATCH',
      { status: 'RETIRED' },
      cookie,
    );
    expect(invalidTransition.status).toBe(409);
    const invalidTransitionText = await invalidTransition.text();
    expectSafeNoStore(invalidTransition, invalidTransitionText);
    expect(JSON.parse(invalidTransitionText)).toMatchObject({
      error: { code: 'STORAGE_SHARD_INVALID_STATE_TRANSITION' },
    });

    const shardRows = await testEnv.DB.prepare(
      `SELECT id, status
       FROM storage_shards
       WHERE logical_bucket_id = ?
       ORDER BY id`,
    )
      .bind(bucket.data.id)
      .all<{ id: string; status: string }>();
    expect(shardRows.results).toEqual([
      { id: shard.data.id, status: 'ACTIVE' },
    ]);

    const persisted = await testEnv.DB.prepare(
      `SELECT
         (SELECT status FROM storage_accounts WHERE id = ?) AS account_status,
         (SELECT COUNT(*) FROM logical_buckets WHERE id = ?) AS bucket_count,
         (SELECT COUNT(*) FROM storage_shards
          WHERE logical_bucket_id = ? AND status = 'ACTIVE') AS active_shards`,
    )
      .bind(account.data.id, bucket.data.id, bucket.data.id)
      .first<{
        account_status: string;
        bucket_count: number;
        active_shards: number;
      }>();
    expect(persisted).toEqual({
      account_status: 'ACTIVE',
      bucket_count: 1,
      active_shards: 1,
    });

    const administrator = await testEnv.DB.prepare(
      'SELECT id FROM administrators LIMIT 1',
    ).first<{ id: string }>();
    const audits = await testEnv.DB.prepare(
      `SELECT actor_id, action, resource_type, resource_id, request_id
       FROM (
         SELECT actor_id, action, resource_type, resource_id, request_id
         FROM audit_logs
         UNION ALL
         SELECT actor_id, action, resource_type, resource_id, request_id
         FROM audit_outbox
         WHERE status <> 'DELIVERED'
       ) AS visible_audit_events
       WHERE action IN (
         'STORAGE_ACCOUNT_CREATED',
         'STORAGE_ACCOUNT_VERIFIED',
         'LOGICAL_BUCKET_CREATED',
         'STORAGE_SHARD_CREATED'
       )`,
    ).all<{
      actor_id: string;
      action: string;
      resource_type: string;
      resource_id: string;
      request_id: string;
    }>();
    expect(audits.results.map(({ action }) => action).sort()).toEqual([
      'LOGICAL_BUCKET_CREATED',
      'STORAGE_ACCOUNT_CREATED',
      'STORAGE_ACCOUNT_VERIFIED',
      'STORAGE_SHARD_CREATED',
    ].sort());
    expect(
      Object.fromEntries(
        audits.results.map(({ action, resource_type }) => [
          action,
          resource_type,
        ]),
      ),
    ).toEqual({
      STORAGE_ACCOUNT_CREATED: 'STORAGE_ACCOUNT',
      STORAGE_ACCOUNT_VERIFIED: 'STORAGE_ACCOUNT',
      LOGICAL_BUCKET_CREATED: 'LOGICAL_BUCKET',
      STORAGE_SHARD_CREATED: 'STORAGE_SHARD',
    });
    expect(audits.results.every(({ actor_id }) => actor_id === administrator?.id))
      .toBe(true);
    expect(audits.results.every(({ request_id }) => request_id.length > 0))
      .toBe(true);
    expect(
      Object.fromEntries(
        audits.results.map(({ action, resource_id }) => [action, resource_id]),
      ),
    ).toEqual({
      STORAGE_ACCOUNT_CREATED: account.data.id,
      STORAGE_ACCOUNT_VERIFIED: account.data.id,
      LOGICAL_BUCKET_CREATED: bucket.data.id,
      STORAGE_SHARD_CREATED: shard.data.id,
    });
  });
});
