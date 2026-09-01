import {
  AuditQueryApplicationError,
  type AuditLogPage,
} from '@openpool/application';
import type { Administrator } from '@openpool/domain';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import {
  registerAuditRoutes,
  type AuditRouteDependencies,
  type AuditUseCases,
} from '../src/adapters/http/audit-routes';
import type { AppEnvironment } from '../src/adapters/http/types';
import type { Env } from '../src/env';

const administrator: Administrator = {
  id: 'admin-1',
  username: 'administrator',
  passwordHash: 'not-returned',
  status: 'ACTIVE',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const repositoryRecord = {
  id: 'audit-2',
  actorType: 'ADMIN' as const,
  actorId: 'admin-1',
  action: 'STORAGE_ACCOUNT_CREATED',
  resourceType: 'STORAGE_ACCOUNT',
  resourceId: 'account-1',
  requestId: 'request-original',
  metadata: { provider: 'R2' },
  createdAt: '2026-09-01T02:00:00.000Z',
  repositorySecret: 'must-not-leak',
};

const page: AuditLogPage = {
  items: [repositoryRecord],
  nextCursor: {
    afterCreatedAt: '2026-09-01T02:00:00.000Z',
    afterId: 'audit-2',
  },
};

const env = {
  APP_ENV: 'test',
  APP_VERSION: 'test',
  DB: {},
} as unknown as Env;

interface TestOverrides {
  readonly authenticate?: AuditRouteDependencies['authenticate'];
  readonly listAuditLogs?: AuditUseCases['listAuditLogs']['execute'];
}

function createTestApp(overrides: TestOverrides = {}) {
  const listAuditLogs = vi.fn(overrides.listAuditLogs ?? (async () => page));
  const dependencies: AuditRouteDependencies = {
    authenticate:
      overrides.authenticate ??
      vi.fn(async (_env, _requestId, token) =>
        token === 'valid-session' ? administrator : undefined,
      ),
    createAuditUseCases: vi.fn(() => ({
      listAuditLogs: { execute: listAuditLogs },
    })),
  };
  const app = new Hono<AppEnvironment>();
  app.use('/api/*', async (context, next) => {
    context.set(
      'requestId',
      context.req.header('x-request-id') ?? 'request-1',
    );
    await next();
  });
  app.onError((error) => {
    throw error;
  });
  registerAuditRoutes(app, dependencies);
  return { app, dependencies, listAuditLogs };
}

function request(
  app: Hono<AppEnvironment>,
  path: string,
  authenticated = true,
): Promise<Response> {
  return app.fetch(
    new Request(`https://openpool.test${path}`, {
      headers: authenticated
        ? { cookie: 'openpool_session=valid-session' }
        : {},
    }),
    env,
  );
}

describe('audit log HTTP adapter', () => {
  it('requires an administrator without constructing the query use case', async () => {
    const { app, dependencies } = createTestApp();
    const missing = await request(app, '/api/v1/audit-logs', false);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    expect(await missing.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Administrator authentication is required.',
      },
      requestId: 'request-1',
    });
    expect(dependencies.createAuditUseCases).not.toHaveBeenCalled();

    const expired = createTestApp({ authenticate: async () => undefined });
    const invalid = await request(expired.app, '/api/v1/audit-logs');
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('cache-control')).toBe('no-store');
    expect(expired.dependencies.createAuditUseCases).not.toHaveBeenCalled();
  });

  it('returns an explicitly mapped page with no-store caching', async () => {
    const { app, listAuditLogs } = createTestApp();
    const response = await request(
      app,
      '/api/v1/audit-logs?limit=20&actorType=ADMIN&action=STORAGE_ACCOUNT_CREATED&resourceType=STORAGE_ACCOUNT&resourceId=account-1&afterCreatedAt=2026-09-01T03%3A00%3A00.000Z&afterId=audit-3',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(listAuditLogs).toHaveBeenCalledWith({
      limit: 20,
      actorType: 'ADMIN',
      action: 'STORAGE_ACCOUNT_CREATED',
      resourceType: 'STORAGE_ACCOUNT',
      resourceId: 'account-1',
      afterCreatedAt: '2026-09-01T03:00:00.000Z',
      afterId: 'audit-3',
    });
    const body = await response.json();
    expect(body).toEqual({
      data: {
        items: [
          {
            id: 'audit-2',
            actorType: 'ADMIN',
            actorId: 'admin-1',
            action: 'STORAGE_ACCOUNT_CREATED',
            resourceType: 'STORAGE_ACCOUNT',
            resourceId: 'account-1',
            requestId: 'request-original',
            metadata: { provider: 'R2' },
            createdAt: '2026-09-01T02:00:00.000Z',
          },
        ],
        nextCursor: {
          afterCreatedAt: '2026-09-01T02:00:00.000Z',
          afterId: 'audit-2',
        },
      },
      requestId: 'request-1',
    });
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
  });

  it.each([
    '?unknown=true',
    '?limit=20&limit=30',
    '?limit=0',
    '?limit=201',
    '?limit=01',
    '?actorType=USER',
    '?action=',
    '?afterCreatedAt=2026-09-01T03%3A00%3A00.000Z',
    '?afterId=audit-3',
    '?afterCreatedAt=invalid&afterId=audit-3',
  ])('strictly rejects invalid query %s', async (query) => {
    const { app, listAuditLogs } = createTestApp();
    const response = await request(app, `/api/v1/audit-logs${query}`);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      error: { code: 'AUDIT_QUERY_INVALID' },
      requestId: 'request-1',
    });
    expect(listAuditLogs).not.toHaveBeenCalled();
  });

  it('maps application validation errors but propagates infrastructure errors', async () => {
    const invalid = createTestApp({
      listAuditLogs: async () => {
        throw new AuditQueryApplicationError();
      },
    });
    const invalidResponse = await request(invalid.app, '/api/v1/audit-logs');
    expect(invalidResponse.status).toBe(400);
    expect(invalidResponse.headers.get('cache-control')).toBe('no-store');

    const failure = new Error('D1 unavailable');
    const infrastructure = createTestApp({
      listAuditLogs: async () => {
        throw failure;
      },
    });
    await expect(request(infrastructure.app, '/api/v1/audit-logs')).rejects.toBe(
      failure,
    );
  });

  it('propagates authentication infrastructure errors', async () => {
    const failure = new Error('auth store unavailable');
    const { app } = createTestApp({
      authenticate: async () => {
        throw failure;
      },
    });
    await expect(request(app, '/api/v1/audit-logs')).rejects.toBe(failure);
  });
});
