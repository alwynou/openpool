import { ObjectApplicationError } from '@openpool/application';
import { ProviderError, type Administrator, type StoredObject } from '@openpool/domain';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { CredentialVaultError } from '../src/adapters/crypto';
import {
  registerObjectRoutes,
  type ObjectRouteDependencies,
  type ObjectUseCases,
} from '../src/adapters/http/object-routes';
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

const object: StoredObject = {
  id: 'object-1',
  logicalBucketId: 'bucket-1',
  logicalKey: 'reports/annual.pdf',
  sizeBytes: 42,
  contentType: 'application/pdf',
  checksum: 'sha256:public-metadata',
  status: 'READY',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
};

const publicObject = { ...object };
const expiresAt = '2026-01-01T00:15:00.000Z';
const env = {
  APP_ENV: 'test',
  APP_VERSION: 'test',
  DB: {},
} as unknown as Env;

interface TestOverrides {
  readonly authenticateObject?: ObjectRouteDependencies['authenticateObject'];
  readonly authorizeObject?: ObjectRouteDependencies['authorizeObject'];
  readonly useCases?: Partial<ObjectUseCases>;
}

function createTestApp(overrides: TestOverrides = {}) {
  const createUpload = vi.fn(async () => ({
    objectId: object.id,
    uploadSessionId: 'upload-1',
    uploadUrl: 'https://provider.invalid/upload?signature=secret',
    expiresAt,
    credentialEnvelope: 'must-not-leak',
  }));
  const completeUpload = vi.fn(async () => ({
    object: {
      ...object,
      physicalBucket: 'must-not-leak',
      physicalKey: 'must-not-leak',
    },
    session: {
      id: 'upload-1',
      objectId: object.id,
      status: 'COMPLETED' as const,
      expiresAt,
      createdAt: object.createdAt,
      completedAt: object.updatedAt,
      credentialEnvelope: 'must-not-leak',
    },
    alreadyCompleted: true,
  }));
  const listObjects = vi.fn(async () => [
    { ...object, storageAccountId: 'must-not-leak' },
  ]);
  const getObject = vi.fn(async () => ({
    ...object,
    location: { physicalBucket: 'must-not-leak' },
    uploadUrl: 'must-not-leak',
  }));
  const createDownload = vi.fn(async () => ({
    objectId: object.id,
    downloadUrl: 'https://provider.invalid/download?signature=secret',
    expiresAt,
    physicalKey: 'must-not-leak',
  }));
  const deleteObject = vi.fn(async () => ({
    ...object,
    status: 'DELETED' as const,
    credentialEnvelope: 'must-not-leak',
    downloadUrl: 'must-not-leak',
  }));
  const getUpload = vi.fn(async () => ({
    id: 'upload-1',
    objectId: object.id,
    status: 'PENDING' as const,
    expiresAt,
    createdAt: object.createdAt,
    completedAt: null,
    physicalKey: 'must-not-leak',
    credentialEnvelope: 'must-not-leak',
  }));
  const useCases: ObjectUseCases = {
    createUpload: { execute: createUpload },
    completeUpload: { execute: completeUpload },
    listObjects: { execute: listObjects },
    getObject: { execute: getObject },
    getUpload: { execute: getUpload },
    createDownload: { execute: createDownload },
    deleteObject: { execute: deleteObject },
    ...overrides.useCases,
  };
  const dependencies: ObjectRouteDependencies = {
    authenticateObject:
      overrides.authenticateObject ??
      vi.fn(async (_env, _requestId, credentials) =>
        credentials.sessionToken === 'valid-session'
          ? {
              actorType: 'ADMIN' as const,
              actorId: administrator.id,
              pathPrefix: null,
            }
          : undefined,
      ),
    authorizeObject: overrides.authorizeObject ?? vi.fn(async () => true),
    createObjectUseCases: vi.fn(() => useCases),
  };
  const app = new Hono<AppEnvironment>();
  app.use('/api/*', async (context, next) => {
    context.set(
      'requestId',
      context.req.header('x-request-id') ?? 'request-1',
    );
    await next();
  });
  registerObjectRoutes(app, dependencies);
  app.onError((error, context) =>
    context.json(
      {
        error: { code: 'INTERNAL_ERROR', message: error.name },
        requestId: context.get('requestId'),
      },
      500,
    ),
  );
  return {
    app,
    dependencies,
    createUpload,
    completeUpload,
    listObjects,
    getObject,
    createDownload,
    deleteObject,
    getUpload,
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

describe('object HTTP adapter', () => {
  it('requires an administrator session or API key on every object route', async () => {
    const { app, dependencies } = createTestApp();
    const routes = [
      ['/api/v1/uploads', 'POST'],
      ['/api/v1/uploads/object-1', 'GET'],
      ['/api/v1/uploads/object-1/complete', 'POST'],
      ['/api/v1/buckets/bucket-1/objects', 'GET'],
      ['/api/v1/objects/object-1', 'GET'],
      ['/api/v1/objects/object-1/download', 'POST'],
      ['/api/v1/objects/object-1', 'DELETE'],
    ] as const;

    for (const [path, method] of routes) {
      const response = await request(app, path, { method });
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Administrator session or API key authentication is required.',
        },
        requestId: 'request-1',
      });
    }
    expect(dependencies.createObjectUseCases).not.toHaveBeenCalled();
  });

  it('creates a direct upload using logicalKey and exposes only transfer fields', async () => {
    const { app, createUpload } = createTestApp();
    const response = await request(
      app,
      '/api/v1/uploads',
      jsonInit('POST', {
        bucketId: 'bucket-1',
        logicalKey: 'reports/annual.pdf',
        sizeBytes: 42,
        contentType: 'application/pdf',
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({
      data: {
        objectId: object.id,
        uploadSessionId: 'upload-1',
        uploadUrl: 'https://provider.invalid/upload?signature=secret',
        expiresAt,
      },
      requestId: 'request-1',
    });
    expect(JSON.stringify(body)).not.toContain('credentialEnvelope');
    expect(createUpload).toHaveBeenCalledWith({
      actorId: administrator.id,
      actorType: 'ADMIN',
      bucketId: 'bucket-1',
      logicalKey: 'reports/annual.pdf',
      sizeBytes: 42,
      contentType: 'application/pdf',
    });
  });

  it('forwards an explicit retry session and exposes only current upload fields', async () => {
    const { app, createUpload, getUpload } = createTestApp();
    const retry = await request(
      app,
      '/api/v1/uploads',
      jsonInit('POST', {
        bucketId: 'bucket-1',
        logicalKey: 'reports/annual.pdf',
        sizeBytes: 42,
        contentType: 'application/pdf',
        retryUploadSessionId: 'previous-upload-1',
      }),
    );

    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual({
      data: {
        objectId: object.id,
        uploadSessionId: 'upload-1',
        uploadUrl: 'https://provider.invalid/upload?signature=secret',
        expiresAt,
      },
      requestId: 'request-1',
    });
    expect(createUpload).toHaveBeenCalledWith({
      actorId: administrator.id,
      actorType: 'ADMIN',
      bucketId: 'bucket-1',
      logicalKey: 'reports/annual.pdf',
      sizeBytes: 42,
      contentType: 'application/pdf',
      retryUploadSessionId: 'previous-upload-1',
    });

    const response = await request(
      app,
      `/api/v1/uploads/${object.id}`,
      authenticatedInit(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      data: {
        objectId: object.id,
        uploadSessionId: 'upload-1',
        status: 'PENDING',
        expiresAt,
      },
      requestId: 'request-1',
    });
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
    expect(JSON.stringify(body)).not.toContain('createdAt');
    expect(JSON.stringify(body)).not.toContain('completedAt');
    expect(getUpload).toHaveBeenCalledWith({ objectId: object.id });
  });

  it('denies retry and upload-session reads when objects:upload is not authorized', async () => {
    const authorizeObject = vi.fn(async () => false);
    const fixture = createTestApp({ authorizeObject });

    const retry = await request(
      fixture.app,
      '/api/v1/uploads',
      jsonInit('POST', {
        bucketId: 'bucket-1',
        logicalKey: 'reports/annual.pdf',
        sizeBytes: 42,
        contentType: 'application/pdf',
        retryUploadSessionId: 'previous-upload-1',
      }),
    );
    expect(retry.status).toBe(403);

    const getUpload = await request(
      fixture.app,
      `/api/v1/uploads/${object.id}`,
      authenticatedInit(),
    );
    expect(getUpload.status).toBe(403);
    expect(fixture.createUpload).not.toHaveBeenCalled();
    expect(fixture.getUpload).not.toHaveBeenCalled();
    expect(authorizeObject).toHaveBeenCalledTimes(2);
    expect(authorizeObject).toHaveBeenNthCalledWith(
      1,
      env,
      'request-1',
      expect.objectContaining({ actorId: administrator.id }),
      {
        action: 'objects:upload',
        logicalBucketId: 'bucket-1',
        logicalKey: 'reports/annual.pdf',
      },
    );
  });

  it('completes uploads idempotently without exposing session or placement internals', async () => {
    const { app, completeUpload } = createTestApp();
    const response = await request(
      app,
      `/api/v1/uploads/${object.id}/complete`,
      jsonInit('POST', { uploadSessionId: 'upload-1' }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      data: {
        object: publicObject,
        uploadSessionId: 'upload-1',
        alreadyCompleted: true,
      },
      requestId: 'request-1',
    });
    expect(JSON.stringify(body)).not.toContain('physicalBucket');
    expect(JSON.stringify(body)).not.toContain('credentialEnvelope');
    expect(completeUpload).toHaveBeenCalledWith({
      actorId: administrator.id,
      actorType: 'ADMIN',
      objectId: object.id,
      uploadSessionId: 'upload-1',
    });
  });

  it('strictly parses list filters and returns only logical metadata', async () => {
    const { app, listObjects } = createTestApp();
    const response = await request(
      app,
      '/api/v1/buckets/bucket-1/objects?status=READY&prefix=reports%2F&afterKey=reports%2Fa&limit=25',
      authenticatedInit(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [publicObject],
      requestId: 'request-1',
    });
    expect(listObjects).toHaveBeenCalledWith({
      logicalBucketId: 'bucket-1',
      status: 'READY',
      prefix: 'reports/',
      afterKey: 'reports/a',
      limit: 25,
    });
  });

  it('gets metadata, creates downloads, and returns idempotent deletion metadata', async () => {
    const { app, getObject, createDownload, deleteObject } = createTestApp();

    const fetched = await request(
      app,
      `/api/v1/objects/${object.id}`,
      authenticatedInit(),
    );
    expect(fetched.status).toBe(200);
    const fetchedBody = await fetched.json();
    expect(fetchedBody).toEqual({ data: publicObject, requestId: 'request-1' });
    expect(JSON.stringify(fetchedBody)).not.toContain('uploadUrl');
    expect(JSON.stringify(fetchedBody)).not.toContain('location');
    expect(getObject).toHaveBeenCalledWith({ objectId: object.id });

    const downloaded = await request(
      app,
      `/api/v1/objects/${object.id}/download`,
      authenticatedInit('POST'),
    );
    expect(downloaded.status).toBe(200);
    const downloadBody = await downloaded.json();
    expect(downloadBody).toEqual({
      data: {
        objectId: object.id,
        downloadUrl: 'https://provider.invalid/download?signature=secret',
        expiresAt,
      },
      requestId: 'request-1',
    });
    expect(JSON.stringify(downloadBody)).not.toContain('physicalKey');
    expect(createDownload).toHaveBeenCalledWith({
      actorId: administrator.id,
      actorType: 'ADMIN',
      objectId: object.id,
    });

    const deleted = await request(
      app,
      `/api/v1/objects/${object.id}`,
      authenticatedInit('DELETE'),
    );
    expect(deleted.status).toBe(200);
    const deletedBody = await deleted.json();
    expect(deletedBody).toEqual({
      data: { ...publicObject, status: 'DELETED' },
      requestId: 'request-1',
    });
    expect(JSON.stringify(deletedBody)).not.toContain('must-not-leak');
    expect(deleteObject).toHaveBeenCalledWith({
      actorId: administrator.id,
      actorType: 'ADMIN',
      objectId: object.id,
    });
  });

  it('enforces API key scope and path restrictions and preserves the actor type', async () => {
    const authorizeObject = vi.fn(
      async (
        _env: Env,
        _requestId: string,
        _principal: {
          readonly actorType: 'ADMIN' | 'API_KEY';
          readonly actorId: string;
          readonly pathPrefix: string | null;
        },
        authorization: {
          readonly action: string;
          readonly logicalBucketId: string;
          readonly logicalKey?: string;
        },
      ) =>
        authorization.logicalBucketId === 'bucket-1' &&
        authorization.logicalKey?.startsWith('reports/') === true,
    );
    const fixture = createTestApp({
      authenticateObject: vi.fn(async (_env, _requestId, credentials) =>
        credentials.authorization === 'Bearer valid-api-key'
          ? {
              actorType: 'API_KEY' as const,
              actorId: 'api-key-1',
              pathPrefix: 'reports/',
            }
          : undefined,
      ),
      authorizeObject,
    });
    const bearer = {
      authorization: 'Bearer valid-api-key',
      'content-type': 'application/json',
    };

    const upload = await request(fixture.app, '/api/v1/uploads', {
      method: 'POST',
      headers: bearer,
      body: JSON.stringify({
        bucketId: 'bucket-1',
        logicalKey: 'reports/annual.pdf',
        sizeBytes: 42,
        contentType: 'application/pdf',
      }),
    });
    expect(upload.status).toBe(201);
    expect(fixture.createUpload).toHaveBeenCalledWith({
      actorId: 'api-key-1',
      actorType: 'API_KEY',
      bucketId: 'bucket-1',
      logicalKey: 'reports/annual.pdf',
      sizeBytes: 42,
      contentType: 'application/pdf',
    });

    const list = await request(
      fixture.app,
      '/api/v1/buckets/bucket-1/objects',
      { headers: { authorization: 'Bearer valid-api-key' } },
    );
    expect(list.status).toBe(200);
    expect(fixture.listObjects).toHaveBeenCalledWith({
      logicalBucketId: 'bucket-1',
      prefix: 'reports/',
    });

    const denied = await request(
      fixture.app,
      '/api/v1/buckets/bucket-2/objects',
      { headers: { authorization: 'Bearer valid-api-key' } },
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(authorizeObject).toHaveBeenCalled();
  });

  it('rejects unknown, legacy, malformed, and duplicate JSON/query fields', async () => {
    const { app, createUpload, completeUpload, listObjects, getObject } =
      createTestApp();
    const legacyUpload = await request(
      app,
      '/api/v1/uploads',
      jsonInit('POST', {
        bucketId: 'bucket-1',
        key: 'legacy-key',
        sizeBytes: 42,
        contentType: 'application/pdf',
        unexpected: true,
      }),
    );
    expect(legacyUpload.status).toBe(400);

    const malformedCompletion = await request(
      app,
      `/api/v1/uploads/${object.id}/complete`,
      jsonInit('POST', { uploadSessionId: 'upload-1', extra: true }),
    );
    expect(malformedCompletion.status).toBe(400);

    for (const retryUploadSessionId of [123, null, '']) {
      const malformedRetry = await request(
        app,
        '/api/v1/uploads',
        jsonInit('POST', {
          bucketId: 'bucket-1',
          logicalKey: 'reports/annual.pdf',
          sizeBytes: 42,
          contentType: 'application/pdf',
          retryUploadSessionId,
        }),
      );
      expect(malformedRetry.status).toBe(400);
    }

    for (const query of [
      'unknown=value',
      'status=UNKNOWN',
      'limit=0',
      'limit=1001',
      'limit=1.5',
      'limit=10&limit=20',
    ]) {
      const response = await request(
        app,
        `/api/v1/buckets/bucket-1/objects?${query}`,
        authenticatedInit(),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'OBJECT_INVALID' },
      });
    }

    const metadataQuery = await request(
      app,
      `/api/v1/objects/${object.id}?extra=true`,
      authenticatedInit(),
    );
    expect(metadataQuery.status).toBe(400);
    expect(createUpload).not.toHaveBeenCalled();
    expect(completeUpload).not.toHaveBeenCalled();
    expect(listObjects).not.toHaveBeenCalled();
    expect(getObject).not.toHaveBeenCalled();
  });

  it.each([
    ['OBJECT_INVALID_INPUT', 400, 'OBJECT_INVALID'],
    ['OBJECT_NO_ACTIVE_SHARD', 409, 'OBJECT_NO_ACTIVE_SHARD'],
    [
      'OBJECT_STORAGE_ACCOUNT_NOT_FOUND',
      409,
      'OBJECT_STORAGE_ACCOUNT_NOT_FOUND',
    ],
    [
      'OBJECT_STORAGE_ACCOUNT_UNAVAILABLE',
      409,
      'OBJECT_STORAGE_ACCOUNT_UNAVAILABLE',
    ],
    ['OBJECT_ALREADY_EXISTS', 409, 'OBJECT_ALREADY_EXISTS'],
    ['OBJECT_CAPACITY_UNAVAILABLE', 409, 'OBJECT_CAPACITY_UNAVAILABLE'],
    ['OBJECT_NOT_FOUND', 404, 'OBJECT_NOT_FOUND'],
    ['OBJECT_UPLOAD_NOT_FOUND', 404, 'OBJECT_UPLOAD_NOT_FOUND'],
    ['OBJECT_UPLOAD_EXPIRED', 410, 'OBJECT_UPLOAD_EXPIRED'],
    ['OBJECT_INVALID_STATE', 409, 'OBJECT_INVALID_STATE'],
    ['OBJECT_SIZE_MISMATCH', 422, 'OBJECT_SIZE_MISMATCH'],
    ['OBJECT_CONFLICT', 409, 'OBJECT_CONFLICT'],
    [
      'OBJECT_PROVIDER_RESPONSE_INVALID',
      502,
      'OBJECT_PROVIDER_RESPONSE_INVALID',
    ],
  ] as const)(
    'maps application error %s to a safe stable response',
    async (applicationCode, status, publicCode) => {
      const app = createTestApp({
        useCases: {
          getObject: {
            execute: vi.fn(async () => {
              throw new ObjectApplicationError(
                applicationCode,
                'internal location and credential details',
              );
            }),
          },
        },
      }).app;
      const response = await request(
        app,
        `/api/v1/objects/${object.id}`,
        authenticatedInit(),
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: publicCode } });
      expect(JSON.stringify(body)).not.toContain('internal location');
    },
  );

  it.each([
    ['INVALID_CREDENTIALS', 422, 'PROVIDER_INVALID_CREDENTIALS'],
    ['FORBIDDEN', 403, 'PROVIDER_FORBIDDEN'],
    ['NOT_FOUND', 404, 'PROVIDER_NOT_FOUND'],
    ['UNSUPPORTED_CAPABILITY', 422, 'PROVIDER_UNSUPPORTED'],
    ['QUOTA_EXCEEDED', 409, 'PROVIDER_QUOTA_EXCEEDED'],
    ['RATE_LIMITED', 429, 'PROVIDER_RATE_LIMITED'],
    ['TIMEOUT', 504, 'PROVIDER_TIMEOUT'],
    ['TEMPORARY_FAILURE', 503, 'PROVIDER_UNAVAILABLE'],
    ['PROTOCOL_ERROR', 502, 'PROVIDER_PROTOCOL_ERROR'],
  ] as const)(
    'maps provider error %s without leaking its message',
    async (providerCode, status, publicCode) => {
      const app = createTestApp({
        useCases: {
          createDownload: {
            execute: vi.fn(async () => {
              throw new ProviderError(providerCode, 'signed-url-or-secret');
            }),
          },
        },
      }).app;
      const response = await request(
        app,
        `/api/v1/objects/${object.id}/download`,
        authenticatedInit('POST'),
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: publicCode } });
      expect(JSON.stringify(body)).not.toContain('signed-url-or-secret');
    },
  );

  it('maps credential vault failures but lets authentication infrastructure errors escape', async () => {
    const vaultApp = createTestApp({
      useCases: {
        createDownload: {
          execute: vi.fn(async () => {
            throw new CredentialVaultError('DECRYPTION_FAILED');
          }),
        },
      },
    }).app;
    const vaultResponse = await request(
      vaultApp,
      `/api/v1/objects/${object.id}/download`,
      authenticatedInit('POST'),
    );
    expect(vaultResponse.status).toBe(503);
    expect(await vaultResponse.json()).toMatchObject({
      error: { code: 'CREDENTIAL_VAULT_UNAVAILABLE' },
    });

    const authApp = createTestApp({
      authenticateObject: vi.fn(async () => {
        throw new Error('authentication infrastructure failed');
      }),
    });
    const infrastructureResponse = await request(
      authApp.app,
      `/api/v1/objects/${object.id}`,
      authenticatedInit(),
    );
    expect(infrastructureResponse.status).toBe(500);
    expect(authApp.dependencies.createObjectUseCases).not.toHaveBeenCalled();
  });
});
