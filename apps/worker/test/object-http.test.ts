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
  accessKeyId: 'object-access-key',
  secretAccessKey: 'object-secret-key',
} as const;
const providerConfig = {
  accountId: 'offline-object-account',
  validationBucket: 'offline-validation',
} as const;
const now = new Date('2026-09-01T00:00:00.000Z');
const uploadExpiresAt = '2026-09-01T00:15:00.000Z';
const downloadExpiresAt = '2026-09-01T00:15:00.000Z';
const uploadUrl = 'https://provider.test/direct-upload?signature=upload-only';
const downloadUrl =
  'https://provider.test/direct-download?signature=download-only';

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
  expect(request.bucket).toBe('openpool-object-primary');
  expect(request.key).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f-]+$/u);
  expect(request.expiresInSeconds).toBe(900);
  return { url: uploadUrl, expiresAt: uploadExpiresAt };
});

const createDownloadUrl = vi.fn(async (request: DownloadUrlRequest) => {
  expect(request.credentials).toEqual(expectedCredentials);
  expect(request.bucket).toBe('openpool-object-primary');
  expect(request.key).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f-]+$/u);
  expect(request.expiresInSeconds).toBe(900);
  return { url: downloadUrl, expiresAt: downloadExpiresAt };
});

const headObject = vi.fn(async (request: ObjectProviderRequest) => {
  expect(request.credentials).toEqual(expectedCredentials);
  expect(request.bucket).toBe('openpool-object-primary');
  expect(request.key).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f-]+$/u);
  return {
    sizeBytes: 512,
    etag: 'etag-object-512',
    checksum: 'sha256:object-512',
  };
});

const deleteObject = vi.fn(async (request: ObjectProviderRequest) => {
  expect(request.credentials).toEqual(expectedCredentials);
  expect(request.bucket).toBe('openpool-object-primary');
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

const testEnv = env as unknown as TestEnv;
const worker = createWorker({
  passwordHasher: new WebCryptoPasswordHasher({ iterations: 1_000 }),
  credentialVault: new WebCryptoCredentialVault({
    masterKey: new Uint8Array(32).fill(23),
    keyId: 'object-http-test-key',
  }),
  providerRegistry: providers,
  clock: { now: () => new Date(now) },
});

interface ProvisionedStorage {
  readonly cookie: string;
  readonly accountId: string;
  readonly bucketId: string;
  readonly shardId: string;
}

interface UploadResponse {
  readonly data: {
    readonly objectId: string;
    readonly uploadSessionId: string;
    readonly uploadUrl: string;
    readonly expiresAt: string;
  };
  readonly requestId: string;
}

async function dispatch(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://openpool.test${path}`, init),
    testEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

function jsonRequest(
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

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(expectedCredentials.accessKeyId);
  expect(text).not.toContain(expectedCredentials.secretAccessKey);
  expect(text.toLowerCase()).not.toContain('credential');
  expect(text.toLowerCase()).not.toContain('envelope');
}

function expectSafeObjectResponse(response: Response, text: string): void {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expectNoSecrets(text);
  expect(text).not.toContain('physicalBucket');
  expect(text).not.toContain('physicalKey');
  expect(text).not.toContain('storageAccountId');
  expect(text).not.toContain('storageShardId');
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

async function provisionStorage(
  initialShardUsedBytes = 100,
): Promise<ProvisionedStorage> {
  const cookie = await administratorCookie();
  const createdAccount = await jsonRequest(
    '/api/v1/storage-accounts',
    'POST',
    {
      name: 'Object lifecycle R2',
      provider: 'r2',
      providerConfig,
      credentials: expectedCredentials,
      capacityBytes: 10_000,
    },
    cookie,
  );
  expect(createdAccount.status).toBe(201);
  const createdAccountText = await createdAccount.text();
  expect(createdAccount.headers.get('cache-control')).toBe('no-store');
  expectNoSecrets(createdAccountText);
  const account = JSON.parse(createdAccountText) as {
    data: { id: string; status: string };
  };
  expect(account.data.status).toBe('VERIFYING');

  const encrypted = await testEnv.DB.prepare(
    'SELECT credential_envelope FROM storage_accounts WHERE id = ?',
  )
    .bind(account.data.id)
    .first<{ credential_envelope: string }>();
  expect(encrypted?.credential_envelope).toContain('AES-256-GCM');
  expect(encrypted?.credential_envelope).not.toContain(
    expectedCredentials.secretAccessKey,
  );

  const verifiedAccount = await dispatch(
    `/api/v1/storage-accounts/${account.data.id}/verify`,
    { method: 'POST', headers: { cookie } },
  );
  expect(verifiedAccount.status).toBe(200);
  expect(verifiedAccount.headers.get('cache-control')).toBe('no-store');
  expectNoSecrets(await verifiedAccount.text());

  const createdBucket = await jsonRequest(
    '/api/v1/buckets',
    'POST',
    { name: 'Object namespace', description: 'Offline object test' },
    cookie,
  );
  expect(createdBucket.status).toBe(201);
  const bucket = (await createdBucket.json()) as { data: { id: string } };

  const createdShard = await jsonRequest(
    `/api/v1/buckets/${bucket.data.id}/shards`,
    'POST',
    {
      storageAccountId: account.data.id,
      physicalBucket: 'openpool-object-primary',
      status: 'ACTIVE',
      capacityBytes: 9_000,
      usedBytes: initialShardUsedBytes,
    },
    cookie,
  );
  expect(createdShard.status).toBe(201);
  const shard = (await createdShard.json()) as { data: { id: string } };

  return {
    cookie,
    accountId: account.data.id,
    bucketId: bucket.data.id,
    shardId: shard.data.id,
  };
}

async function createUpload(
  storage: ProvisionedStorage,
  logicalKey: string,
  sizeBytes = 512,
): Promise<{ readonly response: Response; readonly body: UploadResponse }> {
  const response = await jsonRequest(
    '/api/v1/uploads',
    'POST',
    {
      bucketId: storage.bucketId,
      logicalKey,
      sizeBytes,
      contentType: 'application/octet-stream',
    },
    storage.cookie,
  );
  const text = await response.text();
  expectSafeObjectResponse(response, text);
  return { response, body: JSON.parse(text) as UploadResponse };
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
    testEnv.DB.prepare('DELETE FROM audit_outbox'),
    testEnv.DB.prepare('DELETE FROM audit_logs'),
    testEnv.DB.prepare('DELETE FROM auth_sessions'),
    testEnv.DB.prepare('DELETE FROM administrators'),
  ]);
});

describe('object HTTP composition', () => {
  it('runs the direct-transfer object lifecycle and releases capacity once', async () => {
    const storage = await provisionStorage();
    const upload = await createUpload(storage, 'reports/annual.bin');

    expect(upload.response.status).toBe(201);
    expect(upload.body.data).toEqual({
      objectId: upload.body.data.objectId,
      uploadSessionId: upload.body.data.uploadSessionId,
      uploadUrl,
      expiresAt: uploadExpiresAt,
    });
    expect(Object.keys(upload.body.data).sort()).toEqual([
      'expiresAt',
      'objectId',
      'uploadSessionId',
      'uploadUrl',
    ]);
    expect(createUploadUrl).toHaveBeenCalledOnce();

    const reserved = await testEnv.DB.prepare(
      `SELECT
         object.logical_bucket_id,
         object.logical_key,
         object.size_bytes,
         object.status AS object_status,
         location.storage_account_id,
         location.storage_shard_id,
         location.physical_bucket,
         location.physical_key,
         session.id AS upload_session_id,
         session.status AS upload_status,
         account.used_bytes AS account_used_bytes,
         shard.used_bytes AS shard_used_bytes
       FROM objects AS object
       JOIN object_locations AS location ON location.object_id = object.id
       JOIN upload_sessions AS session ON session.object_id = object.id
       JOIN storage_accounts AS account
         ON account.id = location.storage_account_id
       JOIN storage_shards AS shard ON shard.id = location.storage_shard_id
       WHERE object.id = ?`,
    )
      .bind(upload.body.data.objectId)
      .first<{
        logical_bucket_id: string;
        logical_key: string;
        size_bytes: number;
        object_status: string;
        storage_account_id: string;
        storage_shard_id: string;
        physical_bucket: string;
        physical_key: string;
        upload_session_id: string;
        upload_status: string;
        account_used_bytes: number;
        shard_used_bytes: number;
      }>();
    expect(reserved).toEqual({
      logical_bucket_id: storage.bucketId,
      logical_key: 'reports/annual.bin',
      size_bytes: 512,
      object_status: 'PENDING',
      storage_account_id: storage.accountId,
      storage_shard_id: storage.shardId,
      physical_bucket: 'openpool-object-primary',
      physical_key: expect.stringMatching(/^objects\/[0-9a-f]{2}\/[0-9a-f-]+$/u),
      upload_session_id: upload.body.data.uploadSessionId,
      upload_status: 'PENDING',
      account_used_bytes: 512,
      shard_used_bytes: 612,
    });

    const completed = await jsonRequest(
      `/api/v1/uploads/${upload.body.data.objectId}/complete`,
      'POST',
      { uploadSessionId: upload.body.data.uploadSessionId },
      storage.cookie,
    );
    expect(completed.status).toBe(200);
    const completedText = await completed.text();
    expectSafeObjectResponse(completed, completedText);
    expect(JSON.parse(completedText)).toMatchObject({
      data: {
        object: {
          id: upload.body.data.objectId,
          logicalBucketId: storage.bucketId,
          logicalKey: 'reports/annual.bin',
          sizeBytes: 512,
          checksum: 'sha256:object-512',
          status: 'READY',
        },
        uploadSessionId: upload.body.data.uploadSessionId,
        alreadyCompleted: false,
      },
    });
    expect(headObject).toHaveBeenCalledOnce();

    const completedRows = await testEnv.DB.prepare(
      `SELECT object.status AS object_status,
              object.checksum,
              location.etag,
              session.status AS upload_status,
              session.completed_at
       FROM objects AS object
       JOIN object_locations AS location ON location.object_id = object.id
       JOIN upload_sessions AS session ON session.object_id = object.id
       WHERE object.id = ?`,
    )
      .bind(upload.body.data.objectId)
      .first<{
        object_status: string;
        checksum: string;
        etag: string;
        upload_status: string;
        completed_at: string;
      }>();
    expect(completedRows).toEqual({
      object_status: 'READY',
      checksum: 'sha256:object-512',
      etag: 'etag-object-512',
      upload_status: 'COMPLETED',
      completed_at: now.toISOString(),
    });

    const listed = await dispatch(
      `/api/v1/buckets/${storage.bucketId}/objects?status=READY&prefix=reports%2F`,
      { headers: { cookie: storage.cookie } },
    );
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expectSafeObjectResponse(listed, listedText);
    expect(JSON.parse(listedText)).toMatchObject({
      data: [
        {
          id: upload.body.data.objectId,
          logicalBucketId: storage.bucketId,
          logicalKey: 'reports/annual.bin',
          status: 'READY',
        },
      ],
    });

    const fetched = await dispatch(
      `/api/v1/objects/${upload.body.data.objectId}`,
      { headers: { cookie: storage.cookie } },
    );
    expect(fetched.status).toBe(200);
    const fetchedText = await fetched.text();
    expectSafeObjectResponse(fetched, fetchedText);
    expect(JSON.parse(fetchedText)).toMatchObject({
      data: {
        id: upload.body.data.objectId,
        logicalBucketId: storage.bucketId,
        logicalKey: 'reports/annual.bin',
        status: 'READY',
      },
    });

    const download = await dispatch(
      `/api/v1/objects/${upload.body.data.objectId}/download`,
      { method: 'POST', headers: { cookie: storage.cookie } },
    );
    expect(download.status).toBe(200);
    const downloadText = await download.text();
    expectSafeObjectResponse(download, downloadText);
    expect(JSON.parse(downloadText)).toMatchObject({
      data: {
        objectId: upload.body.data.objectId,
        downloadUrl,
        expiresAt: downloadExpiresAt,
      },
    });
    expect(createDownloadUrl).toHaveBeenCalledOnce();

    const deleted = await dispatch(
      `/api/v1/objects/${upload.body.data.objectId}`,
      { method: 'DELETE', headers: { cookie: storage.cookie } },
    );
    expect(deleted.status).toBe(200);
    const deletedText = await deleted.text();
    expectSafeObjectResponse(deleted, deletedText);
    expect(JSON.parse(deletedText)).toMatchObject({
      data: { id: upload.body.data.objectId, status: 'DELETED' },
    });
    expect(deleteObject).toHaveBeenCalledOnce();

    const released = await testEnv.DB.prepare(
      `SELECT object.status,
              account.used_bytes AS account_used_bytes,
              shard.used_bytes AS shard_used_bytes
       FROM objects AS object
       JOIN object_locations AS location ON location.object_id = object.id
       JOIN storage_accounts AS account
         ON account.id = location.storage_account_id
       JOIN storage_shards AS shard ON shard.id = location.storage_shard_id
       WHERE object.id = ?`,
    )
      .bind(upload.body.data.objectId)
      .first<{
        status: string;
        account_used_bytes: number;
        shard_used_bytes: number;
      }>();
    expect(released).toEqual({
      status: 'DELETED',
      account_used_bytes: 0,
      shard_used_bytes: 100,
    });

    const repeatedDelete = await dispatch(
      `/api/v1/objects/${upload.body.data.objectId}`,
      { method: 'DELETE', headers: { cookie: storage.cookie } },
    );
    expect(repeatedDelete.status).toBe(200);
    const repeatedDeleteText = await repeatedDelete.text();
    expectSafeObjectResponse(repeatedDelete, repeatedDeleteText);
    expect(JSON.parse(repeatedDeleteText)).toMatchObject({
      data: { id: upload.body.data.objectId, status: 'DELETED' },
    });
    expect(deleteObject).toHaveBeenCalledOnce();

    const countersAfterRetry = await testEnv.DB.prepare(
      `SELECT account.used_bytes AS account_used_bytes,
              shard.used_bytes AS shard_used_bytes
       FROM storage_accounts AS account
       JOIN storage_shards AS shard ON shard.storage_account_id = account.id
       WHERE account.id = ? AND shard.id = ?`,
    )
      .bind(storage.accountId, storage.shardId)
      .first<{ account_used_bytes: number; shard_used_bytes: number }>();
    expect(countersAfterRetry).toEqual({
      account_used_bytes: 0,
      shard_used_bytes: 100,
    });

    const audits = await testEnv.DB.prepare(
      `SELECT action, resource_id, request_id
       FROM audit_logs
       WHERE resource_type = 'OBJECT'
       ORDER BY rowid`,
    ).all<{
      action: string;
      resource_id: string;
      request_id: string;
    }>();
    expect(audits.results.map(({ action }) => action)).toEqual([
      'OBJECT_UPLOAD_RESERVED',
      'OBJECT_UPLOAD_COMPLETED',
      'OBJECT_DOWNLOAD_SIGNED',
      'OBJECT_DELETE_STARTED',
      'OBJECT_DELETED',
    ]);
    expect(
      audits.results.every(
        ({ resource_id }) => resource_id === upload.body.data.objectId,
      ),
    ).toBe(true);
    expect(audits.results.every(({ request_id }) => request_id.length > 0)).toBe(
      true,
    );
  });

  it('rolls back every row and counter when the logical namespace conflicts', async () => {
    const storage = await provisionStorage(0);
    const first = await createUpload(storage, 'same-key.bin');
    expect(first.response.status).toBe(201);

    const beforeConflict = await testEnv.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM objects) AS object_count,
         (SELECT COUNT(*) FROM object_locations) AS location_count,
         (SELECT COUNT(*) FROM upload_sessions) AS session_count,
         (SELECT used_bytes FROM storage_accounts WHERE id = ?) AS account_used,
         (SELECT used_bytes FROM storage_shards WHERE id = ?) AS shard_used`,
    )
      .bind(storage.accountId, storage.shardId)
      .first<{
        object_count: number;
        location_count: number;
        session_count: number;
        account_used: number;
        shard_used: number;
      }>();
    expect(beforeConflict).toEqual({
      object_count: 1,
      location_count: 1,
      session_count: 1,
      account_used: 512,
      shard_used: 512,
    });

    const conflict = await createUpload(storage, 'same-key.bin');
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: { code: 'OBJECT_ALREADY_EXISTS' },
    });

    const afterConflict = await testEnv.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM objects) AS object_count,
         (SELECT COUNT(*) FROM object_locations) AS location_count,
         (SELECT COUNT(*) FROM upload_sessions) AS session_count,
         (SELECT used_bytes FROM storage_accounts WHERE id = ?) AS account_used,
         (SELECT used_bytes FROM storage_shards WHERE id = ?) AS shard_used`,
    )
      .bind(storage.accountId, storage.shardId)
      .first<{
        object_count: number;
        location_count: number;
        session_count: number;
        account_used: number;
        shard_used: number;
      }>();
    expect(afterConflict).toEqual(beforeConflict);
    expect(createUploadUrl).toHaveBeenCalledTimes(2);

    const reservedAudits = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM audit_logs
       WHERE action = 'OBJECT_UPLOAD_RESERVED'`,
    ).first<{ count: number }>();
    expect(reservedAudits?.count).toBe(1);
  });
});
