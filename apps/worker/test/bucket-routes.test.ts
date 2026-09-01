import {
  LogicalBucketApplicationError,
  StorageShardApplicationError,
} from '@openpool/application';
import type {
  LogicalBucket,
  StorageShard,
  Administrator,
} from '@openpool/domain';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import {
  registerBucketRoutes,
  type BucketRouteDependencies,
  type BucketUseCases,
} from '../src/adapters/http/bucket-routes';
import type { AppEnvironment } from '../src/adapters/http/types';
import type { Env } from '../src/env';

const administrator: Administrator = {
  id: 'admin-1',
  username: 'administrator',
  passwordHash: 'not-returned',
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const bucket: LogicalBucket = {
  id: 'bucket-1',
  name: 'Documents',
  description: 'Logical documents',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const shard: StorageShard = {
  id: 'shard-1',
  logicalBucketId: bucket.id,
  storageAccountId: 'account-1',
  physicalBucket: 'openpool-documents',
  status: 'STANDBY',
  capacityBytes: 1_000,
  usedBytes: 100,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const env = {
  APP_ENV: 'test',
  APP_VERSION: 'test',
  DB: {},
} as unknown as Env;

interface TestOverrides {
  readonly authenticate?: BucketRouteDependencies['authenticate'];
  readonly useCases?: Partial<BucketUseCases>;
}

function createTestApp(overrides: TestOverrides = {}) {
  const createBucket = vi.fn(async () => ({
    ...bucket,
    credentialEnvelope: 'must-not-leak',
  }));
  const listBuckets = vi.fn(async () => [
    { ...bucket, providerCredentials: 'must-not-leak' },
  ]);
  const getBucket = vi.fn(async () => ({ ...bucket, secret: 'must-not-leak' }));
  const createShard = vi.fn(async () => ({
    ...shard,
    credentialEnvelope: 'must-not-leak',
  }));
  const listShards = vi.fn(async () => [
    { ...shard, providerCredentials: 'must-not-leak' },
  ]);
  const transitionShard = vi.fn(async () => ({
    ...shard,
    status: 'ACTIVE' as const,
    secretAccessKey: 'must-not-leak',
  }));
  const useCases: BucketUseCases = {
    createBucket: { execute: createBucket },
    listBuckets: { execute: listBuckets },
    getBucket: { execute: getBucket },
    createShard: { execute: createShard },
    listShards: { execute: listShards },
    transitionShard: { execute: transitionShard },
    ...overrides.useCases,
  };
  const dependencies: BucketRouteDependencies = {
    authenticate:
      overrides.authenticate ??
      vi.fn(async (_env, _requestId, token) =>
        token === 'valid-session' ? administrator : undefined,
      ),
    createUseCases: vi.fn(() => useCases),
  };
  const app = new Hono<AppEnvironment>();
  app.use('/api/*', async (context, next) => {
    context.set(
      'requestId',
      context.req.header('x-request-id') ?? 'request-1',
    );
    await next();
  });
  registerBucketRoutes(app, dependencies);
  return {
    app,
    dependencies,
    createBucket,
    listBuckets,
    getBucket,
    createShard,
    listShards,
    transitionShard,
  };
}

function request(
  app: Hono<AppEnvironment>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return app.fetch(new Request(`https://openpool.test${path}`, init), env);
}

function authenticatedInit(method = 'GET'): RequestInit {
  return {
    method,
    headers: { cookie: 'openpool_session=valid-session' },
  };
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: 'openpool_session=valid-session',
    },
    body: JSON.stringify(body),
  };
}

describe('logical bucket and storage shard HTTP adapter', () => {
  it('requires an administrator session and does not construct use cases', async () => {
    const { app, dependencies } = createTestApp();
    const routes = [
      ['/api/v1/buckets', 'GET'],
      ['/api/v1/buckets', 'POST'],
      ['/api/v1/buckets/bucket-1', 'GET'],
      ['/api/v1/buckets/bucket-1/shards', 'GET'],
      ['/api/v1/buckets/bucket-1/shards', 'POST'],
      ['/api/v1/shards/shard-1/status', 'PATCH'],
    ] as const;
    for (const [path, method] of routes) {
      const response = await request(app, path, { method });
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Administrator authentication is required.',
        },
        requestId: 'request-1',
      });
    }
    expect(dependencies.createUseCases).not.toHaveBeenCalled();
  });

  it('creates, lists, and gets logical buckets with safe responses', async () => {
    const { app, createBucket, listBuckets, getBucket } = createTestApp();
    const created = await request(
      app,
      '/api/v1/buckets',
      jsonInit('POST', { name: 'Documents', description: null }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(await created.json()).toEqual({ data: bucket, requestId: 'request-1' });
    expect(createBucket).toHaveBeenCalledWith({
      actorId: administrator.id,
      name: 'Documents',
      description: null,
    });

    const listed = await request(app, '/api/v1/buckets', authenticatedInit());
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ data: [bucket], requestId: 'request-1' });
    expect(listBuckets).toHaveBeenCalledOnce();

    const fetched = await request(
      app,
      `/api/v1/buckets/${bucket.id}`,
      authenticatedInit(),
    );
    expect(fetched.status).toBe(200);
    const fetchedBody = await fetched.json();
    expect(fetchedBody).toEqual({ data: bucket, requestId: 'request-1' });
    expect(JSON.stringify(fetchedBody)).not.toContain('must-not-leak');
    expect(getBucket).toHaveBeenCalledWith(bucket.id);
  });

  it('strictly validates logical bucket JSON before calling the use case', async () => {
    const { app, createBucket } = createTestApp();
    const malformed = await request(
      app,
      '/api/v1/buckets',
      jsonInit('POST', { name: 'Documents', unexpected: true }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: 'LOGICAL_BUCKET_INVALID' },
    });

    const wrongDescription = await request(
      app,
      '/api/v1/buckets',
      jsonInit('POST', { name: 'Documents', description: 42 }),
    );
    expect(wrongDescription.status).toBe(400);
    expect(createBucket).not.toHaveBeenCalled();
  });

  it('creates and lists shards using the bucket path and strips extra fields', async () => {
    const { app, createShard, listShards, getBucket } = createTestApp();
    const input = {
      storageAccountId: 'account-1',
      physicalBucket: 'openpool-documents',
      status: 'STANDBY',
      capacityBytes: 1_000,
      usedBytes: 100,
    };
    const created = await request(
      app,
      `/api/v1/buckets/${bucket.id}/shards`,
      jsonInit('POST', input),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ data: shard, requestId: 'request-1' });
    expect(createShard).toHaveBeenCalledWith({
      actorId: administrator.id,
      logicalBucketId: bucket.id,
      ...input,
    });

    const listed = await request(
      app,
      `/api/v1/buckets/${bucket.id}/shards`,
      authenticatedInit(),
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    const listedBody = await listed.json();
    expect(listedBody).toEqual({ data: [shard], requestId: 'request-1' });
    expect(JSON.stringify(listedBody)).not.toContain('must-not-leak');
    expect(getBucket).toHaveBeenCalledWith(bucket.id);
    expect(listShards).toHaveBeenCalledWith(bucket.id);
  });

  it('transitions shard status through a strictly validated request', async () => {
    const { app, transitionShard } = createTestApp();
    const response = await request(
      app,
      `/api/v1/shards/${shard.id}/status`,
      jsonInit('PATCH', { status: 'ACTIVE' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({
      data: { ...shard, status: 'ACTIVE' },
      requestId: 'request-1',
    });
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
    expect(transitionShard).toHaveBeenCalledWith({
      actorId: administrator.id,
      shardId: shard.id,
      status: 'ACTIVE',
    });
  });

  it('rejects malformed shard requests before invoking use cases', async () => {
    const { app, createShard, transitionShard } = createTestApp();
    const createResponse = await request(
      app,
      `/api/v1/buckets/${bucket.id}/shards`,
      jsonInit('POST', {
        storageAccountId: 'account-1',
        physicalBucket: 'openpool-documents',
        capacityBytes: 10,
        usedBytes: 11,
      }),
    );
    expect(createResponse.status).toBe(400);

    const invalidInitialStatus = await request(
      app,
      `/api/v1/buckets/${bucket.id}/shards`,
      jsonInit('POST', {
        storageAccountId: 'account-1',
        physicalBucket: 'openpool-documents',
        status: 'READ_ONLY',
      }),
    );
    expect(invalidInitialStatus.status).toBe(400);

    const transitionResponse = await request(
      app,
      `/api/v1/shards/${shard.id}/status`,
      jsonInit('PATCH', { status: 'BROKEN', unexpected: true }),
    );
    expect(transitionResponse.status).toBe(400);
    const migrationBypass = await request(
      app,
      `/api/v1/shards/${shard.id}/status`,
      jsonInit('PATCH', { status: 'MIGRATING' }),
    );
    expect(migrationBypass.status).toBe(400);
    expect(createShard).not.toHaveBeenCalled();
    expect(transitionShard).not.toHaveBeenCalled();
  });

  it.each([
    ['LOGICAL_BUCKET_INVALID_INPUT', 400, 'LOGICAL_BUCKET_INVALID'],
    ['LOGICAL_BUCKET_NOT_FOUND', 404, 'LOGICAL_BUCKET_NOT_FOUND'],
    ['LOGICAL_BUCKET_ALREADY_EXISTS', 409, 'LOGICAL_BUCKET_ALREADY_EXISTS'],
  ] as const)(
    'maps logical bucket error %s to a stable response',
    async (applicationCode, status, publicCode) => {
      const app = createTestApp({
        useCases: {
          createBucket: {
            execute: vi.fn(async () => {
              throw new LogicalBucketApplicationError(
                applicationCode,
                'internal database details',
              );
            }),
          },
        },
      }).app;
      const response = await request(
        app,
        '/api/v1/buckets',
        jsonInit('POST', { name: 'Documents' }),
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: publicCode } });
      expect(JSON.stringify(body)).not.toContain('internal database details');
    },
  );

  it.each([
    ['STORAGE_SHARD_INVALID_INPUT', 400, 'STORAGE_SHARD_INVALID'],
    ['STORAGE_SHARD_NOT_FOUND', 404, 'STORAGE_SHARD_NOT_FOUND'],
    ['STORAGE_SHARD_BUCKET_NOT_FOUND', 404, 'STORAGE_SHARD_BUCKET_NOT_FOUND'],
    ['STORAGE_SHARD_ACCOUNT_NOT_FOUND', 404, 'STORAGE_SHARD_ACCOUNT_NOT_FOUND'],
    ['STORAGE_SHARD_ACCOUNT_UNAVAILABLE', 409, 'STORAGE_SHARD_ACCOUNT_UNAVAILABLE'],
    ['STORAGE_SHARD_ACTIVE_CONFLICT', 409, 'STORAGE_SHARD_ACTIVE_CONFLICT'],
    ['STORAGE_SHARD_ALREADY_EXISTS', 409, 'STORAGE_SHARD_ALREADY_EXISTS'],
    ['STORAGE_SHARD_CONFLICT', 409, 'STORAGE_SHARD_CONFLICT'],
    [
      'STORAGE_SHARD_INVALID_STATE_TRANSITION',
      409,
      'STORAGE_SHARD_INVALID_STATE_TRANSITION',
    ],
  ] as const)(
    'maps storage shard error %s to a stable response',
    async (applicationCode, status, publicCode) => {
      const app = createTestApp({
        useCases: {
          createShard: {
            execute: vi.fn(async () => {
              throw new StorageShardApplicationError(
                applicationCode,
                'internal provider details',
              );
            }),
          },
        },
      }).app;
      const response = await request(
        app,
        `/api/v1/buckets/${bucket.id}/shards`,
        jsonInit('POST', {
          storageAccountId: 'account-1',
          physicalBucket: 'openpool-documents',
        }),
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: publicCode } });
      expect(JSON.stringify(body)).not.toContain('internal provider details');
    },
  );
});
