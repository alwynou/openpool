import {
  ShardMigrationApplicationError,
  type ShardMigrationResult,
} from '@openpool/application';
import { ProviderError, type Administrator } from '@openpool/domain';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import {
  registerShardMigrationRoutes,
  type ShardMigrationRouteDependencies,
  type ShardMigrationUseCases,
} from '../src/adapters/http/shard-migration-routes';
import { CredentialVaultError } from '../src/adapters/crypto';
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

const migrationResult: ShardMigrationResult = {
  migration: {
    id: 'migration-1',
    sourceShardId: 'shard-source',
    targetShardId: 'shard-target',
    status: 'RUNNING',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
  },
  progress: {
    reserved: 1,
    switched: 2,
    completed: 3,
    failed: 0,
    remainingReady: 4,
    blocking: 0,
  },
};

const transfer = {
  taskId: 'task-1',
  objectId: 'object-1',
  sizeBytes: 12,
  contentType: 'text/plain',
  downloadUrl: 'https://source.example/signed-get',
  uploadUrl: 'https://target.example/signed-put',
  expiresAt: '2026-01-01T00:15:00.000Z',
  leaseToken: 'lease-secret',
};

const env = {
  APP_ENV: 'test',
  APP_VERSION: 'test',
  DB: {},
} as unknown as Env;

interface TestOverrides {
  readonly authenticate?: ShardMigrationRouteDependencies['authenticate'];
  readonly useCases?: Partial<ShardMigrationUseCases>;
}

function createTestApp(overrides: TestOverrides = {}) {
  const startMigration = vi.fn(async () => migrationResult);
  const getMigration = vi.fn(async () => migrationResult);
  const listMigrations = vi.fn(async () => [migrationResult]);
  const claimMigrationTransfer = vi.fn(async () => transfer);
  const completeMigrationTransfer = vi.fn(async () => ({
    taskId: transfer.taskId,
    status: 'COMPLETED' as const,
    migrationCompleted: true,
  }));
  const useCases: ShardMigrationUseCases = {
    startMigration: { execute: startMigration },
    getMigration: { execute: getMigration },
    listMigrations: { execute: listMigrations },
    claimMigrationTransfer: { execute: claimMigrationTransfer },
    completeMigrationTransfer: { execute: completeMigrationTransfer },
    ...overrides.useCases,
  };
  const dependencies: ShardMigrationRouteDependencies = {
    authenticate:
      overrides.authenticate ??
      vi.fn(async (_env, _requestId, token) =>
        token === 'valid-session' ? administrator : undefined,
      ),
    createMigrationUseCases: vi.fn(() => useCases),
  };
  const app = new Hono<AppEnvironment>();
  app.use('/api/*', async (context, next) => {
    context.set('requestId', context.req.header('x-request-id') ?? 'request-1');
    await next();
  });
  registerShardMigrationRoutes(app, dependencies);
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
    startMigration,
    getMigration,
    listMigrations,
    claimMigrationTransfer,
    completeMigrationTransfer,
  };
}

function request(
  app: Hono<AppEnvironment>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return app.fetch(new Request(`https://openpool.test${path}`, init), env);
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: 'openpool_session=valid-session',
    },
    body: JSON.stringify(body),
  };
}

function authenticatedRequest(method = 'GET'): RequestInit {
  return {
    method,
    headers: { cookie: 'openpool_session=valid-session' },
  };
}

const startBody = {
  sourceShardId: 'shard-source',
  targetShardId: 'shard-target',
  expectedSourceUpdatedAt: '2026-01-01T00:00:00.000Z',
  expectedTargetUpdatedAt: '2026-01-01T00:00:00.000Z',
};

describe('shard migration HTTP adapter', () => {
  it('requires an administrator session on every route', async () => {
    const { app, dependencies } = createTestApp();
    const routes = [
      ['/api/v1/shard-migrations', 'POST'],
      ['/api/v1/buckets/bucket-1/shard-migrations', 'GET'],
      ['/api/v1/shard-migrations/migration-1', 'GET'],
      ['/api/v1/shard-migrations/migration-1/transfers', 'POST'],
      ['/api/v1/shard-migration-transfers/task-1/complete', 'POST'],
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
    expect(dependencies.createMigrationUseCases).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { ...startBody, extra: true },
    { ...startBody, expectedSourceUpdatedAt: '2026-01-01' },
    { ...startBody, expectedTargetUpdatedAt: 42 },
    { ...startBody, sourceShardId: 42 },
  ])('strictly rejects invalid start JSON %#', async (body) => {
    const { app, startMigration } = createTestApp();
    const init =
      body === undefined
        ? {
            method: 'POST',
            headers: { cookie: 'openpool_session=valid-session' },
            body: '{',
          }
        : jsonRequest('POST', body);
    const response = await request(app, '/api/v1/shard-migrations', init);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      error: { code: 'SHARD_MIGRATION_INVALID' },
    });
    expect(startMigration).not.toHaveBeenCalled();
  });

  it('rejects query strings and forwards start CAS timestamps', async () => {
    const { app, startMigration } = createTestApp();
    const response = await request(
      app,
      '/api/v1/shard-migrations?retry=1',
      jsonRequest('POST', startBody),
    );
    expect(response.status).toBe(400);
    expect(startMigration).not.toHaveBeenCalled();

    const created = await request(
      app,
      '/api/v1/shard-migrations',
      jsonRequest('POST', startBody),
    );
    expect(created.status).toBe(202);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(startMigration).toHaveBeenCalledWith({
      actorId: administrator.id,
      ...startBody,
    });
  });

  it('returns migration progress from GET', async () => {
    const { app, getMigration } = createTestApp();
    const response = await request(
      app,
      '/api/v1/shard-migrations/migration-1',
      authenticatedRequest(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      data: {
        ...migrationResult.migration,
        progress: migrationResult.progress,
      },
      requestId: 'request-1',
    });
    expect(getMigration).toHaveBeenCalledWith('migration-1');
  });

  it('lists durable migration progress for a logical bucket', async () => {
    const { app, listMigrations } = createTestApp();
    const response = await request(
      app,
      '/api/v1/buckets/bucket-1/shard-migrations',
      authenticatedRequest(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      data: [
        {
          ...migrationResult.migration,
          progress: migrationResult.progress,
        },
      ],
      requestId: 'request-1',
    });
    expect(listMigrations).toHaveBeenCalledWith('bucket-1');
  });

  it('returns one-time direct transfer instructions without leaking extras', async () => {
    const { app, claimMigrationTransfer } = createTestApp();
    const response = await request(
      app,
      '/api/v1/shard-migrations/migration-1/transfers',
      authenticatedRequest('POST'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ data: transfer, requestId: 'request-1' });
    expect(claimMigrationTransfer).toHaveBeenCalledWith({
      actorId: administrator.id,
      migrationId: 'migration-1',
    });

    const withQuery = await request(
      app,
      '/api/v1/shard-migrations/migration-1/transfers?cache=1',
      authenticatedRequest('POST'),
    );
    expect(withQuery.status).toBe(400);
  });

  it('strictly validates complete body and forwards only lease token', async () => {
    const { app, completeMigrationTransfer } = createTestApp();
    for (const body of [
      undefined,
      null,
      {},
      { leaseToken: '' },
      { leaseToken: 'lease-secret', extra: true },
      { leaseToken: 42 },
    ]) {
      const init =
        body === undefined
          ? {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                cookie: 'openpool_session=valid-session',
              },
              body: '{',
            }
          : jsonRequest('POST', body);
      const invalid = await request(
        app,
        '/api/v1/shard-migration-transfers/task-1/complete',
        init,
      );
      expect(invalid.status).toBe(400);
    }
    expect(completeMigrationTransfer).not.toHaveBeenCalled();

    const response = await request(
      app,
      '/api/v1/shard-migration-transfers/task-1/complete',
      jsonRequest('POST', { leaseToken: 'lease-secret' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      data: {
        taskId: 'task-1',
        status: 'COMPLETED',
        migrationCompleted: true,
      },
      requestId: 'request-1',
    });
    expect(completeMigrationTransfer).toHaveBeenCalledWith({
      actorId: administrator.id,
      taskId: 'task-1',
      leaseToken: 'lease-secret',
    });
  });

  it.each([
    ['SHARD_MIGRATION_NOT_FOUND', 404],
    ['SHARD_MIGRATION_SOURCE_NOT_DRAINING', 409],
    ['SHARD_MIGRATION_TRANSFER_EXPIRED', 410],
    ['SHARD_MIGRATION_TARGET_MISMATCH', 422],
  ] as const)('maps application error %s', async (code, status) => {
    const { app } = createTestApp({
      useCases: {
        getMigration: {
          execute: vi.fn(async () => {
            throw new ShardMigrationApplicationError(code, 'internal detail');
          }),
        },
      },
    });
    const response = await request(
      app,
      '/api/v1/shard-migrations/migration-1',
      authenticatedRequest(),
    );
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual({
      error: expect.objectContaining({ code }),
      requestId: 'request-1',
    });
    expect(JSON.stringify(body)).not.toContain('internal detail');
  });

  it.each([
    ['INVALID_CREDENTIALS', 'PROVIDER_INVALID_CREDENTIALS', 422],
    ['FORBIDDEN', 'PROVIDER_FORBIDDEN', 403],
    ['NOT_FOUND', 'PROVIDER_NOT_FOUND', 404],
    ['UNSUPPORTED_CAPABILITY', 'PROVIDER_UNSUPPORTED', 422],
    ['QUOTA_EXCEEDED', 'PROVIDER_QUOTA_EXCEEDED', 409],
    ['RATE_LIMITED', 'PROVIDER_RATE_LIMITED', 429],
    ['TIMEOUT', 'PROVIDER_TIMEOUT', 504],
    ['TEMPORARY_FAILURE', 'PROVIDER_UNAVAILABLE', 503],
    ['PROTOCOL_ERROR', 'PROVIDER_PROTOCOL_ERROR', 502],
  ] as const)('maps provider error %s', async (providerCode, code, status) => {
    const { app } = createTestApp({
      useCases: {
        claimMigrationTransfer: {
          execute: vi.fn(async () => {
            throw new ProviderError(providerCode, 'provider secret detail');
          }),
        },
      },
    });
    const response = await request(
      app,
      '/api/v1/shard-migrations/migration-1/transfers',
      authenticatedRequest('POST'),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      error: { code },
      requestId: 'request-1',
    });
  });

  it('maps credential vault failures and never exposes the error message', async () => {
    const { app } = createTestApp({
      useCases: {
        claimMigrationTransfer: {
          execute: vi.fn(async () => {
            throw new CredentialVaultError('vault secret detail');
          }),
        },
      },
    });
    const response = await request(
      app,
      '/api/v1/shard-migrations/migration-1/transfers',
      authenticatedRequest('POST'),
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: 'CREDENTIAL_VAULT_UNAVAILABLE',
        message: 'Credential storage is temporarily unavailable.',
      },
    });
    expect(JSON.stringify(body)).not.toContain('vault secret detail');
  });
});
