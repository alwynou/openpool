import {
  ObjectApplicationError,
  type CompleteUpload,
  type CreateDownload,
  type CreateUpload,
  type DeleteObject,
  type GetObjectMetadata,
  type GetUploadSession,
  type ListObjectMetadata,
} from '@openpool/application';
import type {
  ApiEnvelope,
  ApiError,
  CompleteUploadRequest,
  CompleteUploadResponse,
  CreateDownloadResponse,
  CreateUploadRequest,
  CreateUploadResponse,
  ListObjectsQuery,
  ObjectErrorCode,
  ObjectMetadataResponse,
  ObjectStatus,
  UploadSessionResponse,
} from '@openpool/contracts';
import {
  ProviderError,
  type ApiKey,
  type ApiKeyAuthorization,
  type StoredObject,
} from '@openpool/domain';
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';

import type { Env } from '../../env';
import { CredentialVaultError } from '../crypto';
import { readJsonBody } from './json-body';
import type { AppEnvironment } from './types';

const SESSION_COOKIE = 'openpool_session';
const OBJECT_STATUSES = new Set<ObjectStatus>([
  'PENDING',
  'READY',
  'DELETING',
  'DELETED',
]);
const LIST_QUERY_KEYS = new Set(['status', 'prefix', 'afterKey', 'limit']);

export interface ObjectUseCases {
  readonly createUpload: Pick<CreateUpload, 'execute'>;
  readonly completeUpload: Pick<CompleteUpload, 'execute'>;
  readonly listObjects: Pick<ListObjectMetadata, 'execute'>;
  readonly getObject: Pick<GetObjectMetadata, 'execute'>;
  readonly getUpload: Pick<GetUploadSession, 'execute'>;
  readonly createDownload: Pick<CreateDownload, 'execute'>;
  readonly deleteObject: Pick<DeleteObject, 'execute'>;
}

export interface ObjectPrincipal {
  readonly actorType: 'ADMIN' | 'API_KEY';
  readonly actorId: string;
  /** Present only for API keys, so list requests can be narrowed safely. */
  readonly pathPrefix: string | null;
  /** Kept server-side so the application authorization policy remains central. */
  readonly apiKey?: ApiKey;
}

/** Factories keep HTTP parsing and authentication independently testable. */
export interface ObjectRouteDependencies {
  readonly authenticateObject: (
    env: Env,
    requestId: string,
    credentials: {
      readonly sessionToken?: string;
      readonly authorization?: string;
    },
  ) => ObjectPrincipal | undefined | Promise<ObjectPrincipal | undefined>;
  readonly authorizeObject: (
    env: Env,
    requestId: string,
    principal: ObjectPrincipal,
    authorization: ApiKeyAuthorization,
  ) => boolean | Promise<boolean>;
  readonly createObjectUseCases: (
    env: Env,
    requestId: string,
  ) => ObjectUseCases;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const expected = new Set(required);
  return (
    Object.keys(value).length === required.length &&
    Object.keys(value).every((key) => expected.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function parseCreateUploadRequest(
  value: unknown,
): CreateUploadRequest | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'bucketId',
      'logicalKey',
      'sizeBytes',
      'contentType',
      ...(Object.hasOwn(value, 'retryUploadSessionId') ? ['retryUploadSessionId'] : []),
    ]) ||
    typeof value.bucketId !== 'string' ||
    typeof value.logicalKey !== 'string' ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    typeof value.contentType !== 'string' ||
    (Object.hasOwn(value, 'retryUploadSessionId') &&
      (typeof value.retryUploadSessionId !== 'string' || !value.retryUploadSessionId.trim()))
  ) {
    return undefined;
  }
  return {
    bucketId: value.bucketId,
    logicalKey: value.logicalKey,
    sizeBytes: value.sizeBytes,
    contentType: value.contentType,
    ...(typeof value.retryUploadSessionId === 'string'
      ? { retryUploadSessionId: value.retryUploadSessionId } : {}),
  };
}

function parseCompleteUploadRequest(
  value: unknown,
): CompleteUploadRequest | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['uploadSessionId']) ||
    typeof value.uploadSessionId !== 'string'
  ) {
    return undefined;
  }
  return { uploadSessionId: value.uploadSessionId };
}

function parseListQuery(request: Request): ListObjectsQuery | undefined {
  const searchParams = new URL(request.url).searchParams;
  const seen = new Set<string>();
  for (const [key] of searchParams) {
    if (!LIST_QUERY_KEYS.has(key) || seen.has(key)) return undefined;
    seen.add(key);
  }

  const status = searchParams.get('status');
  if (status !== null && !OBJECT_STATUSES.has(status as ObjectStatus)) {
    return undefined;
  }
  const rawLimit = searchParams.get('limit');
  if (rawLimit !== null && !/^[1-9]\d{0,3}$/u.test(rawLimit)) {
    return undefined;
  }
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && limit > 1_000) return undefined;

  const prefix = searchParams.get('prefix');
  const afterKey = searchParams.get('afterKey');
  return {
    ...(status === null ? {} : { status: status as ObjectStatus }),
    ...(prefix === null ? {} : { prefix }),
    ...(afterKey === null ? {} : { afterKey }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function hasNoQuery(request: Request): boolean {
  return new URL(request.url).search.length === 0;
}

function objectMetadataResponse(object: StoredObject): ObjectMetadataResponse {
  return {
    id: object.id,
    logicalBucketId: object.logicalBucketId,
    logicalKey: object.logicalKey,
    sizeBytes: object.sizeBytes,
    contentType: object.contentType,
    checksum: object.checksum,
    status: object.status,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
  };
}

function responseError(
  requestId: string,
  code: ObjectErrorCode,
  message: string,
): ApiError<ObjectErrorCode> {
  return { error: { code, message }, requestId };
}

type ErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 410
  | 422
  | 429
  | 502
  | 503
  | 504;

function jsonError(
  context: Context<AppEnvironment>,
  requestId: string,
  code: ObjectErrorCode,
  message: string,
  status: ErrorStatus,
): Response {
  context.header('cache-control', 'no-store');
  return context.json(responseError(requestId, code, message), status);
}

function invalidRequest(
  context: Context<AppEnvironment>,
  requestId: string,
): Response {
  return jsonError(
    context,
    requestId,
    'OBJECT_INVALID',
    'The object request is invalid.',
    400,
  );
}

function objectErrorDetails(error: ObjectApplicationError): {
  readonly code: ObjectErrorCode;
  readonly status: ErrorStatus;
  readonly message: string;
} {
  switch (error.code) {
    case 'OBJECT_INVALID_INPUT':
      return {
        code: 'OBJECT_INVALID',
        status: 400,
        message: 'The object request is invalid.',
      };
    case 'OBJECT_NO_ACTIVE_SHARD':
      return {
        code: error.code,
        status: 409,
        message: 'No active storage shard is available.',
      };
    case 'OBJECT_STORAGE_ACCOUNT_NOT_FOUND':
      return {
        code: error.code,
        status: 409,
        message: 'The object storage account is unavailable.',
      };
    case 'OBJECT_STORAGE_ACCOUNT_UNAVAILABLE':
      return {
        code: error.code,
        status: 409,
        message: 'The object storage account cannot perform this operation.',
      };
    case 'OBJECT_ALREADY_EXISTS':
      return {
        code: error.code,
        status: 409,
        message: 'An object with this logical key already exists.',
      };
    case 'OBJECT_CAPACITY_UNAVAILABLE':
      return {
        code: error.code,
        status: 409,
        message: 'Writable storage capacity is unavailable.',
      };
    case 'OBJECT_NOT_FOUND':
      return {
        code: error.code,
        status: 404,
        message: 'Object was not found.',
      };
    case 'OBJECT_UPLOAD_NOT_FOUND':
      return {
        code: error.code,
        status: 404,
        message: 'Upload session was not found.',
      };
    case 'OBJECT_UPLOAD_EXPIRED':
      return {
        code: error.code,
        status: 410,
        message: 'Upload session has expired.',
      };
    case 'OBJECT_INVALID_STATE':
      return {
        code: error.code,
        status: 409,
        message: 'The object is not in a valid state for this operation.',
      };
    case 'OBJECT_SIZE_MISMATCH':
      return {
        code: error.code,
        status: 422,
        message: 'Uploaded object size does not match the reservation.',
      };
    case 'OBJECT_CONFLICT':
      return {
        code: error.code,
        status: 409,
        message: 'The object changed while the operation was in progress.',
      };
    case 'OBJECT_PROVIDER_RESPONSE_INVALID':
      return {
        code: error.code,
        status: 502,
        message: 'The storage provider returned an invalid response.',
      };
  }
}

function providerErrorDetails(error: ProviderError): {
  readonly code: ObjectErrorCode;
  readonly status: ErrorStatus;
  readonly message: string;
} {
  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      return {
        code: 'PROVIDER_INVALID_CREDENTIALS',
        status: 422,
        message: 'The provider credentials are invalid.',
      };
    case 'FORBIDDEN':
      return {
        code: 'PROVIDER_FORBIDDEN',
        status: 403,
        message: 'The provider denied this operation.',
      };
    case 'NOT_FOUND':
      return {
        code: 'PROVIDER_NOT_FOUND',
        status: 404,
        message: 'The provider object was not found.',
      };
    case 'UNSUPPORTED_CAPABILITY':
      return {
        code: 'PROVIDER_UNSUPPORTED',
        status: 422,
        message: 'The provider does not support this operation.',
      };
    case 'QUOTA_EXCEEDED':
      return {
        code: 'PROVIDER_QUOTA_EXCEEDED',
        status: 409,
        message: 'The provider quota has been exceeded.',
      };
    case 'RATE_LIMITED':
      return {
        code: 'PROVIDER_RATE_LIMITED',
        status: 429,
        message: 'The provider rate limit was reached.',
      };
    case 'TIMEOUT':
      return {
        code: 'PROVIDER_TIMEOUT',
        status: 504,
        message: 'The provider did not respond in time.',
      };
    case 'TEMPORARY_FAILURE':
      return {
        code: 'PROVIDER_UNAVAILABLE',
        status: 503,
        message: 'The provider is temporarily unavailable.',
      };
    case 'PROTOCOL_ERROR':
      return {
        code: 'PROVIDER_PROTOCOL_ERROR',
        status: 502,
        message: 'The provider returned an invalid response.',
      };
  }
}

function errorDetails(error: unknown): {
  readonly code: ObjectErrorCode;
  readonly status: ErrorStatus;
  readonly message: string;
} | undefined {
  if (error instanceof ObjectApplicationError) {
    return objectErrorDetails(error);
  }
  if (error instanceof ProviderError) return providerErrorDetails(error);
  if (error instanceof CredentialVaultError) {
    return {
      code: 'CREDENTIAL_VAULT_UNAVAILABLE',
      status: 503,
      message: 'Credential storage is temporarily unavailable.',
    };
  }
  return undefined;
}

async function requirePrincipal(
  context: Context<AppEnvironment>,
  dependencies: ObjectRouteDependencies,
  requestId: string,
): Promise<ObjectPrincipal | Response> {
  const sessionToken = getCookie(context, SESSION_COOKIE);
  const authorization = context.req.header('authorization');
  const principal = await dependencies.authenticateObject(
    context.env,
    requestId,
    {
      ...(sessionToken === undefined ? {} : { sessionToken }),
      ...(authorization === undefined ? {} : { authorization }),
    },
  );
  if (!principal) {
    return jsonError(
      context,
      requestId,
      'UNAUTHORIZED',
      'Administrator session or API key authentication is required.',
      401,
    );
  }
  return principal;
}

async function requireAuthorization(
  context: Context<AppEnvironment>,
  dependencies: ObjectRouteDependencies,
  requestId: string,
  principal: ObjectPrincipal,
  authorization: ApiKeyAuthorization,
): Promise<Response | undefined> {
  if (
    await dependencies.authorizeObject(
      context.env,
      requestId,
      principal,
      authorization,
    )
  ) {
    return undefined;
  }
  return jsonError(
    context,
    requestId,
    'FORBIDDEN',
    'The authenticated principal is not authorized for this object.',
    403,
  );
}

async function loadObject(
  context: Context<AppEnvironment>,
  requestId: string,
  useCases: ObjectUseCases,
  objectId: string,
): Promise<StoredObject | Response> {
  try {
    return await useCases.getObject.execute({ objectId });
  } catch (error) {
    const details = errorDetails(error);
    if (!details) throw error;
    return jsonError(
      context,
      requestId,
      details.code,
      details.message,
      details.status,
    );
  }
}

async function runObjectOperation<T>(
  context: Context<AppEnvironment>,
  requestId: string,
  execute: () => Promise<T>,
  respond: (result: T) => Response,
): Promise<Response> {
  try {
    return respond(await execute());
  } catch (error) {
    const details = errorDetails(error);
    if (!details) throw error;
    return jsonError(
      context,
      requestId,
      details.code,
      details.message,
      details.status,
    );
  }
}

function addNoStoreMiddleware(app: Hono<AppEnvironment>): void {
  const noStore = async (
    context: Context<AppEnvironment>,
    next: () => Promise<void>,
  ) => {
    context.header('cache-control', 'no-store');
    await next();
  };
  app.use('/api/v1/uploads', noStore);
  app.use('/api/v1/uploads/*', noStore);
  app.use('/api/v1/objects/*', noStore);
  app.use('/api/v1/buckets/*', noStore);
}

export function registerObjectRoutes(
  app: Hono<AppEnvironment>,
  dependencies: ObjectRouteDependencies,
): void {
  addNoStoreMiddleware(app);

  app.post('/api/v1/uploads', async (context) => {
    const requestId = context.get('requestId');
    const principal = await requirePrincipal(
      context,
      dependencies,
      requestId,
    );
    if (principal instanceof Response) return principal;
    if (!hasNoQuery(context.req.raw)) return invalidRequest(context, requestId);
    const input = parseCreateUploadRequest(
      await readJsonBody(context.req.raw),
    );
    if (!input) return invalidRequest(context, requestId);
    const forbidden = await requireAuthorization(
      context,
      dependencies,
      requestId,
      principal,
      {
        action: 'objects:upload',
        logicalBucketId: input.bucketId,
        logicalKey: input.logicalKey,
      },
    );
    if (forbidden) return forbidden;

    return runObjectOperation(
      context,
      requestId,
      () =>
        dependencies.createObjectUseCases(context.env, requestId).createUpload.execute({
          actorId: principal.actorId,
          actorType: principal.actorType,
          ...input,
        }),
      (result) => {
        const data: CreateUploadResponse = {
          objectId: result.objectId,
          uploadSessionId: result.uploadSessionId,
          uploadUrl: result.uploadUrl,
          expiresAt: result.expiresAt,
        };
        const response: ApiEnvelope<CreateUploadResponse> = {
          data,
          requestId,
        };
        return context.json(response, 201);
      },
    );
  });

  app.get('/api/v1/uploads/:objectId', async (context) => {
    const requestId = context.get('requestId');
    const principal = await requirePrincipal(context, dependencies, requestId);
    if (principal instanceof Response) return principal;
    if (!hasNoQuery(context.req.raw)) return invalidRequest(context, requestId);
    const useCases = dependencies.createObjectUseCases(context.env, requestId);
    const objectId = context.req.param('objectId');
    const object = await loadObject(context, requestId, useCases, objectId);
    if (object instanceof Response) return object;
    const forbidden = await requireAuthorization(context, dependencies, requestId, principal, {
      action: 'objects:upload', logicalBucketId: object.logicalBucketId, logicalKey: object.logicalKey,
    });
    if (forbidden) return forbidden;
    return runObjectOperation(context, requestId, () => useCases.getUpload.execute({ objectId }),
      (session) => {
        const data: UploadSessionResponse = { objectId: session.objectId,
          uploadSessionId: session.id, status: session.status, expiresAt: session.expiresAt };
        return context.json({ data, requestId } satisfies ApiEnvelope<UploadSessionResponse>);
      });
  });

  app.post('/api/v1/uploads/:objectId/complete', async (context) => {
    const requestId = context.get('requestId');
    const principal = await requirePrincipal(
      context,
      dependencies,
      requestId,
    );
    if (principal instanceof Response) return principal;
    if (!hasNoQuery(context.req.raw)) return invalidRequest(context, requestId);
    const input = parseCompleteUploadRequest(
      await readJsonBody(context.req.raw),
    );
    if (!input) return invalidRequest(context, requestId);
    const useCases = dependencies.createObjectUseCases(context.env, requestId);
    const object = await loadObject(
      context,
      requestId,
      useCases,
      context.req.param('objectId') ?? '',
    );
    if (object instanceof Response) return object;
    const forbidden = await requireAuthorization(
      context,
      dependencies,
      requestId,
      principal,
      {
        action: 'objects:upload',
        logicalBucketId: object.logicalBucketId,
        logicalKey: object.logicalKey,
      },
    );
    if (forbidden) return forbidden;

    return runObjectOperation(
      context,
      requestId,
      () =>
        useCases.completeUpload.execute({
          actorId: principal.actorId,
          actorType: principal.actorType,
          objectId: context.req.param('objectId') ?? '',
          uploadSessionId: input.uploadSessionId,
        }),
      (result) => {
        const data: CompleteUploadResponse = {
          object: objectMetadataResponse(result.object),
          uploadSessionId: result.session.id,
          alreadyCompleted: result.alreadyCompleted,
        };
        const response: ApiEnvelope<CompleteUploadResponse> = {
          data,
          requestId,
        };
        return context.json(response);
      },
    );
  });

  app.get('/api/v1/buckets/:bucketId/objects', async (context) => {
    const requestId = context.get('requestId');
    const principal = await requirePrincipal(
      context,
      dependencies,
      requestId,
    );
    if (principal instanceof Response) return principal;
    const parsedQuery = parseListQuery(context.req.raw);
    if (!parsedQuery) return invalidRequest(context, requestId);
    const query =
      principal.actorType === 'API_KEY' &&
      principal.pathPrefix !== null &&
      parsedQuery.prefix === undefined
        ? { ...parsedQuery, prefix: principal.pathPrefix }
        : parsedQuery;
    const bucketId = context.req.param('bucketId') ?? '';
    const forbidden = await requireAuthorization(
      context,
      dependencies,
      requestId,
      principal,
      {
        action: 'objects:list',
        logicalBucketId: bucketId,
        ...(query.prefix === undefined ? {} : { logicalKey: query.prefix }),
      },
    );
    if (forbidden) return forbidden;

    return runObjectOperation(
      context,
      requestId,
      () =>
        dependencies.createObjectUseCases(context.env, requestId).listObjects.execute({
          logicalBucketId: bucketId,
          ...query,
        }),
      (objects) => {
        const response: ApiEnvelope<readonly ObjectMetadataResponse[]> = {
          data: objects.map(objectMetadataResponse),
          requestId,
        };
        return context.json(response);
      },
    );
  });

  app.get('/api/v1/objects/:id', async (context) => {
    const requestId = context.get('requestId');
    const principal = await requirePrincipal(
      context,
      dependencies,
      requestId,
    );
    if (principal instanceof Response) return principal;
    if (!hasNoQuery(context.req.raw)) return invalidRequest(context, requestId);
    const useCases = dependencies.createObjectUseCases(context.env, requestId);
    const object = await loadObject(
      context,
      requestId,
      useCases,
      context.req.param('id') ?? '',
    );
    if (object instanceof Response) return object;
    const forbidden = await requireAuthorization(
      context,
      dependencies,
      requestId,
      principal,
      {
        action: 'objects:read',
        logicalBucketId: object.logicalBucketId,
        logicalKey: object.logicalKey,
      },
    );
    if (forbidden) return forbidden;
    const response: ApiEnvelope<ObjectMetadataResponse> = {
      data: objectMetadataResponse(object),
      requestId,
    };
    return context.json(response);
  });

  app.post('/api/v1/objects/:id/download', async (context) => {
    const requestId = context.get('requestId');
    const principal = await requirePrincipal(
      context,
      dependencies,
      requestId,
    );
    if (principal instanceof Response) return principal;
    if (!hasNoQuery(context.req.raw)) return invalidRequest(context, requestId);
    const useCases = dependencies.createObjectUseCases(context.env, requestId);
    const object = await loadObject(
      context,
      requestId,
      useCases,
      context.req.param('id') ?? '',
    );
    if (object instanceof Response) return object;
    const forbidden = await requireAuthorization(
      context,
      dependencies,
      requestId,
      principal,
      {
        action: 'objects:read',
        logicalBucketId: object.logicalBucketId,
        logicalKey: object.logicalKey,
      },
    );
    if (forbidden) return forbidden;

    return runObjectOperation(
      context,
      requestId,
      () =>
        useCases.createDownload.execute({
          actorId: principal.actorId,
          actorType: principal.actorType,
          objectId: context.req.param('id') ?? '',
        }),
      (result) => {
        const data: CreateDownloadResponse = {
          objectId: result.objectId,
          downloadUrl: result.downloadUrl,
          expiresAt: result.expiresAt,
        };
        const response: ApiEnvelope<CreateDownloadResponse> = {
          data,
          requestId,
        };
        return context.json(response);
      },
    );
  });

  app.delete('/api/v1/objects/:id', async (context) => {
    const requestId = context.get('requestId');
    const principal = await requirePrincipal(
      context,
      dependencies,
      requestId,
    );
    if (principal instanceof Response) return principal;
    if (!hasNoQuery(context.req.raw)) return invalidRequest(context, requestId);
    const useCases = dependencies.createObjectUseCases(context.env, requestId);
    const object = await loadObject(
      context,
      requestId,
      useCases,
      context.req.param('id') ?? '',
    );
    if (object instanceof Response) return object;
    const forbidden = await requireAuthorization(
      context,
      dependencies,
      requestId,
      principal,
      {
        action: 'objects:delete',
        logicalBucketId: object.logicalBucketId,
        logicalKey: object.logicalKey,
      },
    );
    if (forbidden) return forbidden;

    return runObjectOperation(
      context,
      requestId,
      () =>
        useCases.deleteObject.execute({
          actorId: principal.actorId,
          actorType: principal.actorType,
          objectId: context.req.param('id') ?? '',
        }),
      (object) => {
        const response: ApiEnvelope<ObjectMetadataResponse> = {
          data: objectMetadataResponse(object),
          requestId,
        };
        return context.json(response);
      },
    );
  });
}
