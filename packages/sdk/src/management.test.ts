import { describe, expect, it, vi } from 'vitest';

import type {
  ApiKeyResponse,
  CreateApiKeyRequest,
  CreateLogicalBucketRequest,
  CreateStorageAccountRequest,
  CreateStorageShardRequest,
  ListAuditLogsQuery,
  ListAuditLogsResponse,
  LogicalBucketResponse,
  StorageAccountResponse,
  StorageShardResponse,
  UpdateStorageAccountConfigurationRequest,
  UpdateStorageAccountStatusRequest,
  UpdateStorageShardStatusRequest,
} from '@openpool/contracts';

import type { OpenPoolFetch } from './client';
import { OpenPoolClient } from './client';

interface FetchCall {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
}

function responseWithBody(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function envelope<T>(data: T, requestId = 'request-1'): Response {
  return responseWithBody({ data, requestId });
}

function controlFetch(...responses: Response[]) {
  const calls: FetchCall[] = [];
  const fetch = vi.fn<OpenPoolFetch>(async (input, init) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (response === undefined) throw new Error('Unexpected fetch call');
    return response;
  });
  return { calls, fetch };
}

function callAt(calls: readonly FetchCall[], index: number): FetchCall {
  const call = calls[index];
  if (call === undefined) throw new Error(`Missing fetch call ${index}`);
  return call;
}

function requestHeaders(call: FetchCall): Headers {
  return new Headers(call.init?.headers);
}

function expectControlRequest(
  call: FetchCall,
  url: string,
  method: string,
  body?: object,
): void {
  expect(String(call.input)).toBe(url);
  expect(call.init?.method).toBe(method);
  expect(call.init?.credentials).toBe('include');
  expect(call.init?.cache).toBe('no-store');
  expect(requestHeaders(call).get('accept')).toBe('application/json');
  expect(requestHeaders(call).get('authorization')).toBe('Bearer admin-key');
  if (body === undefined) {
    expect(call.init?.body).toBeUndefined();
    expect(requestHeaders(call).get('content-type')).toBeNull();
  } else {
    expect(call.init?.body).toBe(JSON.stringify(body));
    expect(requestHeaders(call).get('content-type')).toBe('application/json');
  }
}

const storageAccount: StorageAccountResponse = {
  id: 'account/1',
  name: 'Primary R2',
  provider: 'r2',
  providerConfig: { accountId: 'account-id', validationBucket: 'validation' },
  status: 'ACTIVE',
  priority: 100,
  writeEnabled: true,
  capacityBytes: 1000,
  usedBytes: 100,
  availableBytes: 900,
  healthStatus: 'HEALTHY',
  capacityAccuracy: 'CONFIGURED',
  capabilities: {
    presignedUpload: true,
    presignedDownload: true,
    headObject: true,
    deleteObject: true,
    bucketProbe: true,
    usageProbe: false,
  },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T01:00:00.000Z',
  lastHealthCheckedAt: '2026-09-01T01:00:00.000Z',
};

const createStorageAccountInput: CreateStorageAccountRequest = {
  name: 'Primary R2',
  provider: 'r2',
  providerConfig: {
    accountId: 'account-id',
    validationBucket: 'validation bucket',
    jurisdiction: 'eu',
  },
  credentials: {
    accessKeyId: 'write-only-access-key',
    secretAccessKey: 'write-only-secret',
    sessionToken: 'write-only-session',
  },
  priority: 100,
  capacityBytes: 1000,
};

describe('OpenPoolClient management API', () => {
  it('calls all storage-account management endpoints with safe paths and credentials', async () => {
    const configuration: UpdateStorageAccountConfigurationRequest = {
      providerConfig: { validationBucket: 'replacement bucket' },
      credentials: {
        accessKeyId: 'replacement-access-key',
        secretAccessKey: 'replacement-secret',
      },
      expectedUpdatedAt: storageAccount.updatedAt,
    };
    const status: UpdateStorageAccountStatusRequest = { status: 'DRAINING' };
    const { fetch, calls } = controlFetch(
      envelope([storageAccount]),
      envelope(storageAccount, 'create-account'),
      envelope(storageAccount, 'update-account'),
      envelope(storageAccount, 'verify-account'),
      envelope(storageAccount, 'health-account'),
      envelope(storageAccount, 'status-account'),
    );
    const client = new OpenPoolClient({
      baseUrl: 'https://control.example',
      apiKey: 'admin-key',
      credentials: 'include',
      fetch,
    });

    await expect(client.listAccounts()).resolves.toEqual([storageAccount]);
    await expect(client.createAccount(createStorageAccountInput)).resolves.toEqual(
      storageAccount,
    );
    await expect(
      client.updateAccountConfiguration('account/one', configuration),
    ).resolves.toEqual(storageAccount);
    await expect(client.verifyAccount('account/one')).resolves.toEqual(storageAccount);
    await expect(client.healthAccount('account/one')).resolves.toEqual(storageAccount);
    await expect(client.updateAccountStatus('account/one', status)).resolves.toEqual(
      storageAccount,
    );

    expect(calls).toHaveLength(6);
    expectControlRequest(
      callAt(calls, 0),
      'https://control.example/api/v1/storage-accounts',
      'GET',
    );
    expectControlRequest(
      callAt(calls, 1),
      'https://control.example/api/v1/storage-accounts',
      'POST',
      createStorageAccountInput,
    );
    expectControlRequest(
      callAt(calls, 2),
      'https://control.example/api/v1/storage-accounts/account%2Fone/configuration',
      'PATCH',
      configuration,
    );
    expectControlRequest(
      callAt(calls, 3),
      'https://control.example/api/v1/storage-accounts/account%2Fone/verify',
      'POST',
    );
    expectControlRequest(
      callAt(calls, 4),
      'https://control.example/api/v1/storage-accounts/account%2Fone/health',
      'POST',
    );
    expectControlRequest(
      callAt(calls, 5),
      'https://control.example/api/v1/storage-accounts/account%2Fone/status',
      'PATCH',
      status,
    );
  });

  it('gets and creates logical buckets, encoding bucket IDs and sending JSON', async () => {
    const bucket: LogicalBucketResponse = {
      id: 'bucket/1',
      name: 'documents',
      description: 'A bucket',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const input: CreateLogicalBucketRequest = {
      name: 'documents',
      description: 'A bucket',
    };
    const { fetch, calls } = controlFetch(envelope(bucket), envelope(bucket));
    const client = new OpenPoolClient({
      baseUrl: 'https://control.example',
      apiKey: 'admin-key',
      credentials: 'include',
      fetch,
    });

    await expect(client.getBucket('bucket/one')).resolves.toEqual(bucket);
    await expect(client.createBucket(input)).resolves.toEqual(bucket);

    expect(calls).toHaveLength(2);
    expectControlRequest(
      callAt(calls, 0),
      'https://control.example/api/v1/buckets/bucket%2Fone',
      'GET',
    );
    expectControlRequest(
      callAt(calls, 1),
      'https://control.example/api/v1/buckets',
      'POST',
      input,
    );
  });

  it('lists, creates, and transitions storage shards', async () => {
    const shard: StorageShardResponse = {
      id: 'shard/1',
      logicalBucketId: 'bucket/1',
      storageAccountId: 'account/1',
      physicalBucket: 'physical-bucket',
      status: 'ACTIVE',
      capacityBytes: 1000,
      usedBytes: 100,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const createInput: CreateStorageShardRequest = {
      storageAccountId: 'account/1',
      physicalBucket: 'physical-bucket',
      status: 'ACTIVE',
      capacityBytes: 1000,
      usedBytes: 100,
    };
    const status: UpdateStorageShardStatusRequest = { status: 'READ_ONLY' };
    const { fetch, calls } = controlFetch(envelope([shard]), envelope(shard), envelope(shard));
    const client = new OpenPoolClient({
      baseUrl: 'https://control.example',
      apiKey: 'admin-key',
      credentials: 'include',
      fetch,
    });

    await expect(client.listShards('bucket/one')).resolves.toEqual([shard]);
    await expect(client.createShard('bucket/one', createInput)).resolves.toEqual(shard);
    await expect(client.updateShardStatus('shard/one', status)).resolves.toEqual(shard);

    expect(calls).toHaveLength(3);
    expectControlRequest(
      callAt(calls, 0),
      'https://control.example/api/v1/buckets/bucket%2Fone/shards',
      'GET',
    );
    expectControlRequest(
      callAt(calls, 1),
      'https://control.example/api/v1/buckets/bucket%2Fone/shards',
      'POST',
      createInput,
    );
    expectControlRequest(
      callAt(calls, 2),
      'https://control.example/api/v1/shards/shard%2Fone/status',
      'PATCH',
      status,
    );
  });

  it('lists, creates, and revokes API keys', async () => {
    const apiKey: ApiKeyResponse = {
      id: 'key/1',
      name: 'backup client',
      keyPrefix: 'opk_A1b2C3d4',
      scopes: ['objects:list', 'objects:read'],
      logicalBucketId: 'bucket/1',
      pathPrefix: 'reports/',
      expiresAt: '2026-12-31T00:00:00.000Z',
      revokedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    const input: CreateApiKeyRequest = {
      name: 'backup client',
      scopes: ['objects:list', 'objects:read'],
      logicalBucketId: 'bucket/1',
      pathPrefix: 'reports/',
      expiresAt: '2026-12-31T00:00:00.000Z',
    };
    const created = { apiKey, token: 'opk_shown_once' };
    const { fetch, calls } = controlFetch(
      envelope([apiKey]),
      envelope(created, 'create-key'),
      envelope(apiKey, 'revoke-key'),
    );
    const client = new OpenPoolClient({
      baseUrl: 'https://control.example',
      apiKey: 'admin-key',
      credentials: 'include',
      fetch,
    });

    await expect(client.listApiKeys()).resolves.toEqual([apiKey]);
    await expect(client.createApiKey(input)).resolves.toEqual(created);
    await expect(client.revokeApiKey('key/one')).resolves.toEqual(apiKey);

    expect(calls).toHaveLength(3);
    expectControlRequest(
      callAt(calls, 0),
      'https://control.example/api/v1/api-keys',
      'GET',
    );
    expectControlRequest(
      callAt(calls, 1),
      'https://control.example/api/v1/api-keys',
      'POST',
      input,
    );
    expectControlRequest(
      callAt(calls, 2),
      'https://control.example/api/v1/api-keys/key%2Fone',
      'DELETE',
    );
  });

  it('serializes every audit-log filter and URL-encodes the cursor', async () => {
    const audit: ListAuditLogsResponse = {
      items: [],
      nextCursor: null,
    };
    const query: ListAuditLogsQuery = {
      limit: 200,
      actorType: 'API_KEY',
      action: 'OBJECT_UPLOAD_COMPLETED',
      resourceType: 'OBJECT',
      resourceId: 'object/one',
      afterCreatedAt: '2026-09-01T00:00:00.000Z',
      afterId: 'audit/id?next',
    };
    const { fetch, calls } = controlFetch(envelope(audit));
    const client = new OpenPoolClient({
      baseUrl: 'https://control.example',
      apiKey: 'admin-key',
      credentials: 'include',
      fetch,
    });

    await expect(client.listAuditLogs(query)).resolves.toEqual(audit);

    expect(calls).toHaveLength(1);
    expectControlRequest(
      callAt(calls, 0),
      'https://control.example/api/v1/audit-logs?limit=200&actorType=API_KEY&action=OBJECT_UPLOAD_COMPLETED&resourceType=OBJECT&resourceId=object%2Fone&afterCreatedAt=2026-09-01T00%3A00%3A00.000Z&afterId=audit%2Fid%3Fnext',
      'GET',
    );
  });
});
