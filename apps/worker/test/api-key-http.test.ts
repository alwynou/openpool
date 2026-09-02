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
  DownloadUrlRequest,
  ObjectProviderRequest,
  ProviderRegistry,
  StorageProvider,
  UploadUrlRequest,
} from '@openpool/application';

import {
  encodeBase64Url,
  WebCryptoApiKeyGenerator,
  WebCryptoApiKeyHasher,
  WebCryptoPasswordHasher,
} from '../src/adapters/auth';
import { WebCryptoCredentialVault } from '../src/adapters/crypto';
import { createWorker } from '../src/composition/root';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;
const now = new Date('2026-09-01T00:00:00.000Z');
const pepper = encodeBase64Url(new Uint8Array(32).fill(71));
const expectedCredentials = {
  accessKeyId: 'api-key-object-access',
  secretAccessKey: 'api-key-object-secret',
} as const;
const providerConfig = {
  accountId: 'offline-api-key-account',
  validationBucket: 'offline-api-key-validation',
} as const;
const capabilities = {
  presignedUpload: true,
  presignedDownload: true,
  headObject: true,
  deleteObject: true,
  bucketProbe: true,
  usageProbe: false,
} as const;
const uploadUrl = 'https://provider.test/api-key-upload?signature=only-once';
const downloadUrl =
  'https://provider.test/api-key-download?signature=only-once';

const validate = vi.fn(
  async (
    credentials: CredentialPayload,
    config: Readonly<Record<string, string | number | boolean | null>>,
  ) => {
    expect(credentials).toEqual(expectedCredentials);
    expect(config).toEqual(providerConfig);
    return { capabilities };
  },
);
const probe = vi.fn(
  async (
    credentials: CredentialPayload,
    config: Readonly<Record<string, string | number | boolean | null>>,
  ) => {
    expect(credentials).toEqual(expectedCredentials);
    expect(config).toEqual(providerConfig);
    return {
      healthStatus: 'HEALTHY' as const,
      capacityBytes: null,
      usedBytes: null,
      capacityAccuracy: 'UNKNOWN' as const,
    };
  },
);
const createUploadUrl = vi.fn(async (request: UploadUrlRequest) => {
  expect(request.credentials).toEqual(expectedCredentials);
  expect(request.account.providerConfig).toEqual(providerConfig);
  expect(request.expiresInSeconds).toBe(900);
  expect(request.bucket).toMatch(/^api-key-physical-/u);
  expect(request.key).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f-]+$/u);
  return {
    url: uploadUrl,
    expiresAt: '2026-09-01T00:15:00.000Z',
  };
});
const createDownloadUrl = vi.fn(async (request: DownloadUrlRequest) => {
  expect(request.credentials).toEqual(expectedCredentials);
  expect(request.expiresInSeconds).toBe(900);
  expect(request.bucket).toMatch(/^api-key-physical-/u);
  expect(request.key).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f-]+$/u);
  return {
    url: downloadUrl,
    expiresAt: '2026-09-01T00:15:00.000Z',
  };
});
const headObject = vi.fn(async (request: ObjectProviderRequest) => {
  expect(request.credentials).toEqual(expectedCredentials);
  expect(request.bucket).toMatch(/^api-key-physical-/u);
  expect(request.key).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f-]+$/u);
  return {
    sizeBytes: 128,
    etag: 'etag-api-key-128',
    checksum: 'sha256:api-key-128',
  };
});
const deleteObject = vi.fn(async (request: ObjectProviderRequest) => {
  expect(request.credentials).toEqual(expectedCredentials);
  expect(request.bucket).toMatch(/^api-key-physical-/u);
  expect(request.key).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f-]+$/u);
});

const provider: StorageProvider = {
  capabilities,
  createUploadUrl,
  createDownloadUrl,
  headObject,
  deleteObject,
  validate,
  probe,
};
const providers: ProviderRegistry = { forAccount: () => provider };

const worker = createWorker({
  passwordHasher: new WebCryptoPasswordHasher({ iterations: 1_000 }),
  credentialVault: new WebCryptoCredentialVault({
    masterKey: new Uint8Array(32).fill(79),
    keyId: 'api-key-http-test-key',
  }),
  providerRegistry: providers,
  apiKeyGenerator: new WebCryptoApiKeyGenerator(),
  apiKeyHasher: new WebCryptoApiKeyHasher({ pepper }),
  clock: { now: () => new Date(now) },
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
  method: 'POST' | 'DELETE',
  body: unknown,
  cookie?: string,
  authorization?: string,
  extraHeaders: HeadersInit = {},
): Promise<Response> {
  return dispatch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
      ...(authorization === undefined ? {} : { authorization }),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function administratorCookie(): Promise<string> {
  const setup = await jsonRequest(
    '/api/v1/setup',
    'POST',
    {
      username: 'administrator',
      password: 'correct horse battery staple',
    },
    undefined,
    undefined,
    { 'x-openpool-bootstrap-token': 'test-bootstrap-token' },
  );
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

interface ProvisionedStorage {
  readonly cookie: string;
  readonly accountId: string;
  readonly bucketId: string;
  readonly otherBucketId: string;
}

async function provisionStorage(): Promise<ProvisionedStorage> {
  const cookie = await administratorCookie();
  const accountResponse = await jsonRequest(
    '/api/v1/storage-accounts',
    'POST',
    {
      name: 'API key offline storage',
      provider: 'r2',
      providerConfig,
      credentials: expectedCredentials,
      capacityBytes: 100_000,
    },
    cookie,
  );
  expect(accountResponse.status).toBe(201);
  const account = (await accountResponse.json()) as { data: { id: string } };
  const verified = await dispatch(
    `/api/v1/storage-accounts/${account.data.id}/verify`,
    { method: 'POST', headers: { cookie } },
  );
  expect(verified.status).toBe(200);

  const bucketResponse = await jsonRequest(
    '/api/v1/buckets',
    'POST',
    { name: 'API key namespace' },
    cookie,
  );
  expect(bucketResponse.status).toBe(201);
  const bucket = (await bucketResponse.json()) as { data: { id: string } };
  const otherBucketResponse = await jsonRequest(
    '/api/v1/buckets',
    'POST',
    { name: 'API key other namespace' },
    cookie,
  );
  expect(otherBucketResponse.status).toBe(201);
  const otherBucket = (await otherBucketResponse.json()) as {
    data: { id: string };
  };

  for (const [bucketId, physicalBucket] of [
    [bucket.data.id, 'api-key-physical-primary'],
    [otherBucket.data.id, 'api-key-physical-other'],
  ] as const) {
    const shardResponse = await jsonRequest(
      `/api/v1/buckets/${bucketId}/shards`,
      'POST',
      {
        storageAccountId: account.data.id,
        physicalBucket,
        status: 'ACTIVE',
        capacityBytes: 90_000,
        usedBytes: 0,
      },
      cookie,
    );
    expect(shardResponse.status).toBe(201);
  }

  return {
    cookie,
    accountId: account.data.id,
    bucketId: bucket.data.id,
    otherBucketId: otherBucket.data.id,
  };
}

interface CreatedKey {
  readonly id: string;
  readonly token: string;
  readonly keyPrefix: string;
}

async function createApiKey(
  cookie: string,
  input: Record<string, unknown>,
): Promise<CreatedKey> {
  const response = await jsonRequest('/api/v1/api-keys', 'POST', input, cookie);
  expect(response.status).toBe(201);
  const text = await response.text();
  const body = JSON.parse(text) as {
    data: { apiKey: { id: string; keyPrefix: string }; token: string };
  };
  expect(body.data.token).toMatch(/^opk_[A-Za-z0-9_-]{43}$/u);
  expect(body.data.apiKey.keyPrefix).toBe(
    body.data.token.slice(0, body.data.apiKey.keyPrefix.length),
  );
  return {
    id: body.data.apiKey.id,
    token: body.data.token,
    keyPrefix: body.data.apiKey.keyPrefix,
  };
}

async function createAdminObject(
  storage: ProvisionedStorage,
  logicalKey: string,
): Promise<string> {
  const reserved = await jsonRequest(
    '/api/v1/uploads',
    'POST',
    {
      bucketId: storage.bucketId,
      logicalKey,
      sizeBytes: 128,
      contentType: 'application/octet-stream',
    },
    storage.cookie,
  );
  expect(reserved.status).toBe(201);
  const reservation = (await reserved.json()) as {
    data: { objectId: string; uploadSessionId: string };
  };
  const completed = await jsonRequest(
    `/api/v1/uploads/${reservation.data.objectId}/complete`,
    'POST',
    { uploadSessionId: reservation.data.uploadSessionId },
    storage.cookie,
  );
  expect(completed.status).toBe(200);
  return reservation.data.objectId;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM api_keys'),
    testEnv.DB.prepare('DELETE FROM upload_sessions'),
    testEnv.DB.prepare('DELETE FROM object_locations'),
    testEnv.DB.prepare('DELETE FROM objects'),
    testEnv.DB.prepare('DELETE FROM storage_shards'),
    testEnv.DB.prepare('DELETE FROM logical_buckets'),
    testEnv.DB.prepare('DELETE FROM storage_accounts'),
    testEnv.DB.prepare('DELETE FROM audit_outbox'),
    testEnv.DB.prepare('DELETE FROM audit_logs'),
    testEnv.DB.prepare('DELETE FROM auth_sessions'),
    testEnv.DB.prepare('DELETE FROM administrators'),
  ]);
});

describe('API key Worker composition', () => {
  it('creates hashed keys and runs a restricted Bearer object lifecycle', async () => {
    const storage = await provisionStorage();
    const outsidePathObjectId = await createAdminObject(
      storage,
      'public/readme.txt',
    );
    expect(outsidePathObjectId).toBeTruthy();

    const fullKey = await createApiKey(storage.cookie, {
      name: 'reports automation',
      scopes: [
        'objects:list',
        'objects:read',
        'objects:upload',
        'objects:delete',
      ],
      logicalBucketId: storage.bucketId,
      pathPrefix: 'reports/',
    });
    const readKey = await createApiKey(storage.cookie, {
      name: 'reports reader',
      scopes: ['objects:list', 'objects:read'],
      logicalBucketId: storage.bucketId,
      pathPrefix: 'reports/',
    });

    const persisted = await testEnv.DB.prepare(
      'SELECT key_prefix, key_hash, scopes, logical_bucket_id, path_prefix FROM api_keys WHERE id = ?',
    )
      .bind(fullKey.id)
      .first<{
        key_prefix: string;
        key_hash: string;
        scopes: string;
        logical_bucket_id: string;
        path_prefix: string;
      }>();
    expect(persisted).toEqual({
      key_prefix: fullKey.keyPrefix,
      key_hash: expect.stringMatching(/^hmac-sha256\$v=1\$[A-Za-z0-9_-]{43}$/u),
      scopes: JSON.stringify([
        'objects:list',
        'objects:read',
        'objects:upload',
        'objects:delete',
      ]),
      logical_bucket_id: storage.bucketId,
      path_prefix: 'reports/',
    });
    expect(persisted?.key_hash).not.toContain(fullKey.token);
    expect(persisted?.key_hash).not.toContain('opk_');

    const reserved = await jsonRequest(
      '/api/v1/uploads',
      'POST',
      {
        bucketId: storage.bucketId,
        logicalKey: 'reports/quarterly.bin',
        sizeBytes: 128,
        contentType: 'application/octet-stream',
      },
      undefined,
      `Bearer ${fullKey.token}`,
    );
    expect(reserved.status).toBe(201);
    const reservation = (await reserved.json()) as {
      data: { objectId: string; uploadSessionId: string; uploadUrl: string };
    };
    expect(reservation.data.uploadUrl).toBe(uploadUrl);

    const completed = await jsonRequest(
      `/api/v1/uploads/${reservation.data.objectId}/complete`,
      'POST',
      { uploadSessionId: reservation.data.uploadSessionId },
      undefined,
      `Bearer ${fullKey.token}`,
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      data: {
        object: {
          id: reservation.data.objectId,
          logicalBucketId: storage.bucketId,
          logicalKey: 'reports/quarterly.bin',
          status: 'READY',
        },
      },
    });

    const listed = await dispatch(
      `/api/v1/buckets/${storage.bucketId}/objects`,
      { headers: { authorization: `Bearer ${fullKey.token}` } },
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      data: Array<{ logicalKey: string }>;
    };
    expect(listedBody.data.map(({ logicalKey }) => logicalKey)).toEqual([
      'reports/quarterly.bin',
    ]);
    expect(JSON.stringify(listedBody)).not.toContain('public/readme.txt');

    const fetched = await dispatch(
      `/api/v1/objects/${reservation.data.objectId}`,
      { headers: { authorization: `Bearer ${fullKey.token}` } },
    );
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({
      data: { logicalKey: 'reports/quarterly.bin', status: 'READY' },
    });

    const download = await dispatch(
      `/api/v1/objects/${reservation.data.objectId}/download`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${fullKey.token}` },
      },
    );
    expect(download.status).toBe(200);
    expect(await download.json()).toMatchObject({
      data: {
        objectId: reservation.data.objectId,
        downloadUrl,
      },
    });

    const deleted = await dispatch(
      `/api/v1/objects/${reservation.data.objectId}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${fullKey.token}` },
      },
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({
      data: { id: reservation.data.objectId, status: 'DELETED' },
    });

    const retainedObjectId = await createAdminObject(
      storage,
      'reports/retained.bin',
    );
    const providerCallsBeforeForbidden = {
      upload: createUploadUrl.mock.calls.length,
      head: headObject.mock.calls.length,
      download: createDownloadUrl.mock.calls.length,
      delete: deleteObject.mock.calls.length,
    };

    const pathForbidden = await jsonRequest(
      '/api/v1/uploads',
      'POST',
      {
        bucketId: storage.bucketId,
        logicalKey: 'private/no-access.bin',
        sizeBytes: 128,
        contentType: 'application/octet-stream',
      },
      undefined,
      `Bearer ${fullKey.token}`,
    );
    expect(pathForbidden.status).toBe(403);
    expect(await pathForbidden.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });

    const bucketForbidden = await dispatch(
      `/api/v1/buckets/${storage.otherBucketId}/objects`,
      { headers: { authorization: `Bearer ${fullKey.token}` } },
    );
    expect(bucketForbidden.status).toBe(403);

    const explicitOutsidePrefix = await dispatch(
      `/api/v1/buckets/${storage.bucketId}/objects?prefix=public%2F`,
      { headers: { authorization: `Bearer ${fullKey.token}` } },
    );
    expect(explicitOutsidePrefix.status).toBe(403);

    const scopeForbidden = await dispatch(
      `/api/v1/objects/${retainedObjectId}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${readKey.token}` },
      },
    );
    expect(scopeForbidden.status).toBe(403);
    expect(await scopeForbidden.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(createUploadUrl.mock.calls.length).toBe(
      providerCallsBeforeForbidden.upload,
    );
    expect(headObject.mock.calls.length).toBe(providerCallsBeforeForbidden.head);
    expect(createDownloadUrl.mock.calls.length).toBe(
      providerCallsBeforeForbidden.download,
    );
    expect(deleteObject.mock.calls.length).toBe(
      providerCallsBeforeForbidden.delete,
    );

    const listedKeys = await dispatch('/api/v1/api-keys', {
      headers: { cookie: storage.cookie },
    });
    expect(listedKeys.status).toBe(200);
    const listedKeysText = await listedKeys.text();
    expect(listedKeysText).not.toContain(fullKey.token);
    expect(listedKeysText).not.toContain(readKey.token);
    expect(listedKeysText).toContain(fullKey.keyPrefix);

    const revoked = await dispatch(`/api/v1/api-keys/${fullKey.id}`, {
      method: 'DELETE',
      headers: { cookie: storage.cookie },
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.text()).not.toContain(fullKey.token);

    const revokedUse = await dispatch(
      `/api/v1/buckets/${storage.bucketId}/objects`,
      { headers: { authorization: `Bearer ${fullKey.token}` } },
    );
    expect(revokedUse.status).toBe(401);
    expect(await revokedUse.json()).toMatchObject({
      error: { code: 'UNAUTHORIZED' },
    });

    const audits = await testEnv.DB.prepare(
      `SELECT actor_type, actor_id, action, resource_type
       FROM (
         SELECT id, actor_type, actor_id, action, resource_type, created_at
         FROM audit_logs
         UNION ALL
         SELECT id, actor_type, actor_id, action, resource_type, created_at
         FROM audit_outbox
         WHERE status <> 'DELIVERED'
           AND NOT EXISTS (
             SELECT 1
             FROM audit_logs
             WHERE audit_logs.event_id = audit_outbox.id
           )
       ) AS visible_audit_events
       WHERE actor_type = 'API_KEY'
       ORDER BY created_at, id`,
    ).all<{
      actor_type: string;
      actor_id: string;
      action: string;
      resource_type: string;
    }>();
    expect(audits.results.length).toBeGreaterThanOrEqual(6);
    expect(audits.results.every(({ actor_type }) => actor_type === 'API_KEY')).toBe(
      true,
    );
    expect(audits.results.some(({ actor_id }) => actor_id === fullKey.id)).toBe(
      true,
    );
    expect(
      audits.results.map(({ action }) => action),
    ).toEqual(expect.arrayContaining([
      'OBJECT_UPLOAD_RESERVED',
      'OBJECT_UPLOAD_COMPLETED',
      'OBJECT_DOWNLOAD_SIGNED',
      'OBJECT_DELETE_STARTED',
      'OBJECT_DELETED',
    ]));
    const objectAudits = audits.results.filter(
      ({ resource_type }) => resource_type === 'OBJECT',
    );
    expect(objectAudits.length).toBeGreaterThanOrEqual(5);
  });
});
