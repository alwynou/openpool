import { ApiKeyApplicationError } from '@openpool/application';
import type { Administrator, ApiKey } from '@openpool/domain';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import {
  registerApiKeyRoutes,
  type ApiKeyRouteDependencies,
  type ApiKeyUseCases,
} from '../src/adapters/http/api-key-routes';
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

const apiKey: ApiKey = {
  id: 'key-1',
  name: 'automation',
  keyPrefix: 'op_live_1234',
  scopes: ['objects:list', 'objects:read'],
  logicalBucketId: 'bucket-1',
  pathPrefix: 'reports/',
  expiresAt: '2027-01-01T00:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const rawToken = 'op_live_1234567890abcdefghijklmnopqrstuvwxyz';
const env = {
  APP_ENV: 'test',
  APP_VERSION: 'test',
  DB: {},
} as unknown as Env;

interface TestOverrides {
  readonly authenticate?: ApiKeyRouteDependencies['authenticate'];
  readonly useCases?: Partial<ApiKeyUseCases>;
}

function createTestApp(overrides: TestOverrides = {}) {
  const createApiKey = vi.fn(async () => ({
    apiKey: { ...apiKey, keyHash: 'must-not-leak' },
    token: rawToken,
    persistedHash: 'must-not-leak',
  }));
  const listApiKeys = vi.fn(async () => [
    {
      ...apiKey,
      keyHash: 'must-not-leak',
      rawToken: 'must-not-leak',
      token: 'must-not-leak',
    },
  ]);
  const revokeApiKey = vi.fn(async () => ({
    ...apiKey,
    revokedAt: '2026-02-01T00:00:00.000Z',
    keyHash: 'must-not-leak',
    rawToken: 'must-not-leak',
    token: 'must-not-leak',
  }));
  const useCases: ApiKeyUseCases = {
    createApiKey: { execute: createApiKey },
    listApiKeys: { execute: listApiKeys },
    revokeApiKey: { execute: revokeApiKey },
    ...overrides.useCases,
  };
  const dependencies: ApiKeyRouteDependencies = {
    authenticate:
      overrides.authenticate ??
      vi.fn(async (_env, _requestId, token) =>
        token === 'valid-session' ? administrator : undefined,
      ),
    createApiKeyUseCases: vi.fn(() => useCases),
  };
  const app = new Hono<AppEnvironment>();
  app.use('/api/*', async (context, next) => {
    context.set(
      'requestId',
      context.req.header('x-request-id') ?? 'request-1',
    );
    await next();
  });
  registerApiKeyRoutes(app, dependencies);
  app.onError((_error, context) =>
    context.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
        },
        requestId: context.get('requestId'),
      },
      500,
    ),
  );
  return {
    app,
    dependencies,
    createApiKey,
    listApiKeys,
    revokeApiKey,
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

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'openpool_session=valid-session',
    },
    body: JSON.stringify(body),
  };
}

describe('API key management HTTP adapter', () => {
  it('requires an administrator session on every route', async () => {
    const { app, dependencies } = createTestApp();
    const routes = [
      ['/api/v1/api-keys', 'POST'],
      ['/api/v1/api-keys', 'GET'],
      ['/api/v1/api-keys/key-1', 'DELETE'],
    ] as const;

    for (const [path, method] of routes) {
      const response = await request(app, path, { method });
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error: {
          code: 'API_KEY_UNAUTHORIZED',
          message: 'Administrator authentication is required.',
        },
        requestId: 'request-1',
      });
    }

    expect(dependencies.createApiKeyUseCases).not.toHaveBeenCalled();
  });

  it('returns the raw token only in the creation response', async () => {
    const { app, createApiKey, listApiKeys, revokeApiKey } = createTestApp();
    const input = {
      name: 'automation',
      scopes: ['objects:list', 'objects:read'],
      logicalBucketId: 'bucket-1',
      pathPrefix: 'reports/',
      expiresAt: '2027-01-01T00:00:00.000Z',
    };
    const created = await request(app, '/api/v1/api-keys', jsonInit(input));
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const createdBody = await created.json();
    expect(createdBody).toEqual({
      data: { apiKey, token: rawToken },
      requestId: 'request-1',
    });
    expect(JSON.stringify(createdBody)).not.toContain('must-not-leak');
    expect(createApiKey).toHaveBeenCalledWith({
      actorId: administrator.id,
      ...input,
    });

    const listed = await request(
      app,
      '/api/v1/api-keys',
      authenticatedInit(),
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    const listedBody = await listed.json();
    expect(listedBody).toEqual({ data: [apiKey], requestId: 'request-1' });
    expect(JSON.stringify(listedBody)).not.toContain(rawToken);
    expect(JSON.stringify(listedBody)).not.toContain('must-not-leak');
    expect(listApiKeys).toHaveBeenCalledOnce();

    const revoked = await request(
      app,
      `/api/v1/api-keys/${apiKey.id}`,
      authenticatedInit('DELETE'),
    );
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get('cache-control')).toBe('no-store');
    const revokedBody = await revoked.json();
    expect(revokedBody).toEqual({
      data: { ...apiKey, revokedAt: '2026-02-01T00:00:00.000Z' },
      requestId: 'request-1',
    });
    expect(JSON.stringify(revokedBody)).not.toContain(rawToken);
    expect(JSON.stringify(revokedBody)).not.toContain('must-not-leak');
    expect(revokeApiKey).toHaveBeenCalledWith({
      actorId: administrator.id,
      id: apiKey.id,
    });
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { name: 'automation', scopes: ['objects:list'], unexpected: true },
    { name: 42, scopes: ['objects:list'] },
    { name: 'automation', scopes: 'objects:list' },
    { name: 'automation', scopes: [] },
    { name: 'automation', scopes: ['objects:admin'] },
    { name: 'automation', scopes: ['objects:list', 'objects:list'] },
    { name: 'automation', scopes: ['objects:list'], logicalBucketId: 42 },
    { name: 'automation', scopes: ['objects:list'], pathPrefix: false },
    { name: 'automation', scopes: ['objects:list'], expiresAt: 42 },
  ])('strictly rejects invalid creation JSON %#', async (body) => {
    const { app, createApiKey } = createTestApp();
    const init =
      body === undefined
        ? {
            method: 'POST',
            headers: { cookie: 'openpool_session=valid-session' },
            body: '{',
          }
        : jsonInit(body);
    const response = await request(app, '/api/v1/api-keys', init);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      error: { code: 'API_KEY_INVALID' },
    });
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it('accepts explicit null optional restrictions', async () => {
    const { app, createApiKey } = createTestApp();
    const response = await request(
      app,
      '/api/v1/api-keys',
      jsonInit({
        name: 'automation',
        scopes: ['objects:upload'],
        logicalBucketId: null,
        pathPrefix: null,
        expiresAt: null,
      }),
    );
    expect(response.status).toBe(201);
    expect(createApiKey).toHaveBeenCalledWith({
      actorId: administrator.id,
      name: 'automation',
      scopes: ['objects:upload'],
      logicalBucketId: null,
      pathPrefix: null,
      expiresAt: null,
    });
  });

  it.each([
    ['API_KEY_INVALID_INPUT', 400, 'API_KEY_INVALID'],
    ['API_KEY_CONFLICT', 409, 'API_KEY_CONFLICT'],
    ['API_KEY_BUCKET_NOT_FOUND', 404, 'API_KEY_BUCKET_NOT_FOUND'],
    ['API_KEY_GENERATION_FAILED', 503, 'API_KEY_GENERATION_FAILED'],
  ] as const)(
    'maps creation error %s without exposing internal details',
    async (applicationCode, status, publicCode) => {
      const app = createTestApp({
        useCases: {
          createApiKey: {
            execute: vi.fn(async () => {
              throw new ApiKeyApplicationError(
                applicationCode,
                'internal persistence or entropy details',
              );
            }),
          },
        },
      }).app;
      const response = await request(
        app,
        '/api/v1/api-keys',
        jsonInit({ name: 'automation', scopes: ['objects:list'] }),
      );
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: publicCode } });
      expect(JSON.stringify(body)).not.toContain('internal persistence');
    },
  );

  it.each([
    ['API_KEY_NOT_FOUND', 404, 'API_KEY_NOT_FOUND'],
    ['API_KEY_CONFLICT', 409, 'API_KEY_CONFLICT'],
  ] as const)(
    'maps revoke error %s to stable metadata-safe output',
    async (applicationCode, status, publicCode) => {
      const app = createTestApp({
        useCases: {
          revokeApiKey: {
            execute: vi.fn(async () => {
              throw new ApiKeyApplicationError(
                applicationCode,
                'internal revoke details',
              );
            }),
          },
        },
      }).app;
      const response = await request(
        app,
        '/api/v1/api-keys/key-1',
        authenticatedInit('DELETE'),
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: publicCode } });
      expect(JSON.stringify(body)).not.toContain('internal revoke details');
    },
  );

  it('leaves authentication infrastructure failures to the global handler', async () => {
    const { app, dependencies } = createTestApp({
      authenticate: vi.fn(async () => {
        throw new Error('database connection secret');
      }),
    });
    const response = await request(
      app,
      '/api/v1/api-keys',
      authenticatedInit(),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
      requestId: 'request-1',
    });
    expect(dependencies.createApiKeyUseCases).not.toHaveBeenCalled();
  });

  it('leaves unexpected use-case failures to the global handler', async () => {
    const app = createTestApp({
      useCases: {
        listApiKeys: {
          execute: vi.fn(async () => {
            throw new Error('raw database details');
          }),
        },
      },
    }).app;
    const response = await request(
      app,
      '/api/v1/api-keys',
      authenticatedInit(),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });
  });
});
