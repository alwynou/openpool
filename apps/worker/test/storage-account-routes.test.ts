import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import type { StorageAccountRouteDependencies } from '../src/adapters/http/storage-account-routes';
import { registerStorageAccountRoutes } from '../src/adapters/http/storage-account-routes';
import type { Env } from '../src/env';
import type { AppEnvironment } from '../src/adapters/http/types';
import type { Administrator, StorageAccount } from '@openpool/domain';
import { ProviderError, StorageAccountStateError } from '@openpool/domain';
import { StorageAccountApplicationError } from '@openpool/application';

const administrator: Administrator = {
  id: 'admin-1',
  username: 'administrator',
  passwordHash: 'not-returned',
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const account: StorageAccount = {
  id: 'account-1',
  name: 'Primary R2',
  provider: 'r2',
  providerConfig: { accountId: 'account', validationBucket: 'check' },
  status: 'VERIFYING',
  priority: 10,
  writeEnabled: false,
  capacityBytes: 1000,
  usedBytes: 250,
  healthStatus: 'UNKNOWN',
  capacityAccuracy: 'CONFIGURED',
  capabilities: {
    presignedUpload: false,
    presignedDownload: false,
    headObject: false,
    deleteObject: false,
    bucketProbe: false,
    usageProbe: false,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastHealthCheckedAt: null,
};

const env = {
  APP_ENV: 'test',
  APP_VERSION: 'test',
  DB: {},
} as unknown as Env;

function createTestApp(
  overrides: Partial<StorageAccountRouteDependencies> = {},
) {
  const create = vi.fn(async () => ({ account }));
  const updateConfiguration = vi.fn(async () => ({ account }));
  const list = vi.fn(async () => [account]);
  const verify = vi.fn(async () => ({ account: { ...account, status: 'ACTIVE' as const } }));
  const transition = vi.fn(async () => ({ ...account, status: 'DRAINING' as const }));
  const refresh = vi.fn(async () => account);
  const dependencies: StorageAccountRouteDependencies = {
    authenticate: vi.fn(async (_env, _requestId, token) =>
      token === 'valid-session' ? administrator : undefined,
    ),
    createUseCases: vi.fn(() => ({
      create: { execute: create },
      updateConfiguration: { execute: updateConfiguration },
      list: { execute: list },
      verify: { execute: verify },
      transition: { execute: transition },
      refresh: { execute: refresh },
    })),
    ...overrides,
  };
  const app = new Hono<AppEnvironment>();
  app.use('/api/*', async (context, next) => {
    context.set('requestId', context.req.header('x-request-id') ?? 'request-1');
    await next();
  });
  registerStorageAccountRoutes(app, dependencies);
  return {
    app,
    dependencies,
    create,
    updateConfiguration,
    list,
    verify,
    transition,
    refresh,
  };
}

async function request(
  app: Hono<AppEnvironment>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return app.fetch(new Request(`https://openpool.test${path}`, init), env);
}

function jsonInit(method: string, body: unknown, token = 'valid-session'): RequestInit {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: `openpool_session=${token}`,
    },
    body: JSON.stringify(body),
  };
}

describe('storage account HTTP adapter', () => {
  it('requires an administrator session with a safe error envelope', async () => {
    const { app } = createTestApp();
    const response = await request(app, '/api/v1/storage-accounts');
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Administrator authentication is required.' },
      requestId: 'request-1',
    });
  });

  it('creates and lists accounts without returning credentials', async () => {
    const { app, create, list } = createTestApp();
    const body = {
      name: 'Primary R2',
      provider: 'r2',
      providerConfig: { accountId: 'account', validationBucket: 'check' },
      credentials: { accessKeyId: 'access-key', secretAccessKey: 'super-secret' },
      priority: 10,
      capacityBytes: 1000,
    };
    const created = await request(app, '/api/v1/storage-accounts', jsonInit('POST', body));
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({ requestId: 'request-1', data: { availableBytes: 750 } });
    expect(JSON.stringify(createdBody)).not.toContain('super-secret');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ actorId: administrator.id, credentials: body.credentials }));

    const listed = await request(app, '/api/v1/storage-accounts', {
      headers: { cookie: 'openpool_session=valid-session', 'x-request-id': 'list-request' },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ data: [{ id: 'account-1', availableBytes: 750 }] });
    expect(list).toHaveBeenCalledOnce();
  });

  it('updates a verifying account without returning write-only credentials', async () => {
    const { app, updateConfiguration } = createTestApp();
    const body = {
      providerConfig: { accountId: 'corrected', validationBucket: 'check' },
      credentials: {
        accessKeyId: 'new-access',
        secretAccessKey: 'new-super-secret',
      },
      expectedUpdatedAt: account.updatedAt,
    };

    const response = await request(
      app,
      '/api/v1/storage-accounts/account-1/configuration',
      jsonInit('PATCH', body),
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      requestId: 'request-1',
      data: { id: account.id, availableBytes: 750 },
    });
    expect(JSON.stringify(responseBody)).not.toContain('new-super-secret');
    expect(updateConfiguration).toHaveBeenCalledWith({
      ...body,
      actorId: administrator.id,
      accountId: account.id,
    });
  });

  it('rejects incomplete or unknown configuration updates', async () => {
    const { app, updateConfiguration } = createTestApp();
    const path = '/api/v1/storage-accounts/account-1/configuration';

    expect(
      (await request(app, path, jsonInit('PATCH', {
        expectedUpdatedAt: account.updatedAt,
      }))).status,
    ).toBe(400);
    expect(
      (await request(app, path, jsonInit('PATCH', {
        credentials: { accessKeyId: 'only-one-field' },
        expectedUpdatedAt: account.updatedAt,
      }))).status,
    ).toBe(400);
    expect(
      (await request(app, path, jsonInit('PATCH', {
        providerConfig: {},
        expectedUpdatedAt: account.updatedAt,
        unexpected: true,
      }))).status,
    ).toBe(400);
    expect(updateConfiguration).not.toHaveBeenCalled();
  });

  it('maps concurrent configuration updates to a stable conflict', async () => {
    const fixture = createTestApp({
      createUseCases: () => ({
        create: { execute: vi.fn(async () => ({ account })) },
        updateConfiguration: {
          execute: vi.fn(async () => {
            throw new StorageAccountApplicationError(
              'STORAGE_ACCOUNT_CONFLICT',
              'internal conflict details',
            );
          }),
        },
        list: { execute: vi.fn(async () => []) },
        verify: { execute: vi.fn(async () => ({ account })) },
        transition: { execute: vi.fn(async () => account) },
        refresh: { execute: vi.fn(async () => account) },
      }),
    });

    const response = await request(
      fixture.app,
      '/api/v1/storage-accounts/account-1/configuration',
      jsonInit('PATCH', {
        providerConfig: {},
        expectedUpdatedAt: account.updatedAt,
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'STORAGE_ACCOUNT_CONFLICT' },
    });
  });

  it('maps duplicate creation to a conflict without exposing internal text', async () => {
    const app = createTestApp({
      createUseCases: () => ({
        create: { execute: vi.fn(async () => { throw new StorageAccountApplicationError('STORAGE_ACCOUNT_ALREADY_EXISTS', 'database details'); }) },
        updateConfiguration: { execute: vi.fn(async () => ({ account })) },
        list: { execute: vi.fn(async () => []) },
        verify: { execute: vi.fn(async () => ({ account })) },
        transition: { execute: vi.fn(async () => account) },
        refresh: { execute: vi.fn(async () => account) },
      }),
    });
    const response = await request(app.app, '/api/v1/storage-accounts', jsonInit('POST', {
      name: 'Primary R2', provider: 'r2', providerConfig: {},
      credentials: { accessKeyId: 'a', secretAccessKey: 'super-secret' },
    }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'STORAGE_ACCOUNT_ALREADY_EXISTS' }, requestId: 'request-1' });
    expect(JSON.stringify(body)).not.toContain('database details');
    expect(JSON.stringify(body)).not.toContain('super-secret');
  });

  it('rejects malformed and unknown JSON fields before invoking use cases', async () => {
    const { app, create } = createTestApp();
    const response = await request(
      app,
      '/api/v1/storage-accounts',
      jsonInit('POST', {
        name: 'x',
        provider: 'r2',
        providerConfig: { endpoint: { nested: true } },
        credentials: { accessKeyId: 'a', secretAccessKey: 's' },
        unexpected: true,
      }),
    );
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('maps provider, state, and application errors to stable responses', async () => {
    const provider = createTestApp({
      createUseCases: () => ({
        create: { execute: vi.fn(async () => { throw new ProviderError('INVALID_CREDENTIALS', 'secret'); }) },
        updateConfiguration: { execute: vi.fn(async () => ({ account })) },
        list: { execute: vi.fn(async () => []) },
        verify: { execute: vi.fn(async () => { throw new StorageAccountStateError('ACTIVE', 'ACTIVE'); }) },
        transition: { execute: vi.fn(async () => { throw new StorageAccountApplicationError('STORAGE_ACCOUNT_NOT_FOUND', 'internal'); }) },
        refresh: { execute: vi.fn(async () => account) },
      }),
    });
    const created = await request(
      provider.app,
      '/api/v1/storage-accounts',
      jsonInit('POST', {
        name: 'Primary R2', provider: 'r2', providerConfig: {},
        credentials: { accessKeyId: 'a', secretAccessKey: 's' },
      }),
    );
    expect(created.status).toBe(422);
    expect(await created.json()).toMatchObject({ error: { code: 'PROVIDER_INVALID_CREDENTIALS' } });
    const stateError = await request(provider.app, '/api/v1/storage-accounts/account-1/verify', { method: 'POST', headers: { cookie: 'openpool_session=valid-session' } });
    expect(stateError.status).toBe(409);
    expect(JSON.stringify(await stateError.json())).not.toContain('internal');
    const missing = await request(provider.app, '/api/v1/storage-accounts/account-1/status', jsonInit('PATCH', { status: 'DRAINING' }));
    expect(missing.status).toBe(404);

    const blocked = createTestApp({
      createUseCases: () => ({
        create: { execute: vi.fn(async () => ({ account })) },
        updateConfiguration: { execute: vi.fn(async () => ({ account })) },
        list: { execute: vi.fn(async () => []) },
        verify: { execute: vi.fn(async () => ({ account })) },
        transition: {
          execute: vi.fn(async () => {
            throw new StorageAccountApplicationError(
              'STORAGE_ACCOUNT_HAS_REFERENCES',
              'internal object identifiers',
            );
          }),
        },
        refresh: { execute: vi.fn(async () => account) },
      }),
    });
    const referenced = await request(
      blocked.app,
      '/api/v1/storage-accounts/account-1/status',
      jsonInit('PATCH', { status: 'REMOVED' }),
    );
    expect(referenced.status).toBe(409);
    expect(await referenced.json()).toMatchObject({
      error: { code: 'STORAGE_ACCOUNT_HAS_REFERENCES' },
    });
  });

  it('routes verify, health, and allowed status transitions', async () => {
    const { app, verify, refresh, transition } = createTestApp();
    expect((await request(app, '/api/v1/storage-accounts/account-1/verify', { method: 'POST', headers: { cookie: 'openpool_session=valid-session' } })).status).toBe(200);
    expect((await request(app, '/api/v1/storage-accounts/account-1/health', { method: 'POST', headers: { cookie: 'openpool_session=valid-session' } })).status).toBe(200);
    expect((await request(app, '/api/v1/storage-accounts/account-1/status', jsonInit('PATCH', { status: 'REMOVED' }))).status).toBe(200);
    expect(verify).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ status: 'REMOVED', actorId: administrator.id }));
  });
});
