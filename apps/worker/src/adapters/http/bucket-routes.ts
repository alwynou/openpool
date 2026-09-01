import {
  LogicalBucketApplicationError,
  StorageShardApplicationError,
  type CreateLogicalBucket,
  type CreateStorageShard,
  type GetLogicalBucket,
  type ListLogicalBuckets,
  type ListStorageShards,
  type TransitionStorageShard,
} from '@openpool/application';
import type {
  ApiEnvelope,
  ApiError,
  BucketErrorCode,
  CreateLogicalBucketRequest,
  CreateStorageShardRequest,
  LogicalBucketResponse,
  StorageShardResponse,
  StorageShardStatus,
  UpdateStorageShardStatusRequest,
} from '@openpool/contracts';
import type {
  Administrator,
  LogicalBucket,
  StorageShard,
} from '@openpool/domain';
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';

import type { Env } from '../../env';
import { readJsonBody } from './json-body';
import type { AppEnvironment } from './types';

const SESSION_COOKIE = 'openpool_session';
const SHARD_STATUSES = new Set<StorageShardStatus>([
  'STANDBY',
  'ACTIVE',
  'READ_ONLY',
  'MIGRATING',
  'RETIRED',
]);
const CREATE_SHARD_STATUSES = new Set<
  NonNullable<CreateStorageShardRequest['status']>
>(['STANDBY', 'ACTIVE']);

export interface BucketUseCases {
  readonly createBucket: Pick<CreateLogicalBucket, 'execute'>;
  readonly listBuckets: Pick<ListLogicalBuckets, 'execute'>;
  readonly getBucket: Pick<GetLogicalBucket, 'execute'>;
  readonly createShard: Pick<CreateStorageShard, 'execute'>;
  readonly listShards: Pick<ListStorageShards, 'execute'>;
  readonly transitionShard: Pick<TransitionStorageShard, 'execute'>;
}

/** Dependencies are factories so route tests never require a real D1 or provider. */
export interface BucketRouteDependencies {
  readonly authenticate: (
    env: Env,
    requestId: string,
    sessionToken: string,
  ) => Administrator | undefined | Promise<Administrator | undefined>;
  readonly createUseCases: (env: Env, requestId: string) => BucketUseCases;
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
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function parseCreateBucketRequest(
  value: unknown,
): CreateLogicalBucketRequest | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['name'], ['description']) ||
    typeof value.name !== 'string'
  ) {
    return undefined;
  }
  if (
    Object.hasOwn(value, 'description') &&
    typeof value.description !== 'string' &&
    value.description !== null
  ) {
    return undefined;
  }
  const description = value.description;
  return {
    name: value.name,
    ...(typeof description === 'string' || description === null
      ? { description }
      : {}),
  };
}

function isShardStatus(value: unknown): value is StorageShardStatus {
  return typeof value === 'string' && SHARD_STATUSES.has(value as StorageShardStatus);
}

function isCreateShardStatus(
  value: unknown,
): value is NonNullable<CreateStorageShardRequest['status']> {
  return (
    typeof value === 'string' &&
    CREATE_SHARD_STATUSES.has(
      value as NonNullable<CreateStorageShardRequest['status']>,
    )
  );
}

function parseCreateShardRequest(
  value: unknown,
): CreateStorageShardRequest | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(
      value,
      ['storageAccountId', 'physicalBucket'],
      ['status', 'capacityBytes', 'usedBytes'],
    ) ||
    typeof value.storageAccountId !== 'string' ||
    typeof value.physicalBucket !== 'string'
  ) {
    return undefined;
  }
  if (Object.hasOwn(value, 'status') && !isCreateShardStatus(value.status)) {
    return undefined;
  }
  if (
    Object.hasOwn(value, 'capacityBytes') &&
    !isSafeNonNegativeInteger(value.capacityBytes)
  ) {
    return undefined;
  }
  if (
    Object.hasOwn(value, 'usedBytes') &&
    !isSafeNonNegativeInteger(value.usedBytes)
  ) {
    return undefined;
  }
  if (
    typeof value.capacityBytes === 'number' &&
    typeof value.usedBytes === 'number' &&
    value.usedBytes > value.capacityBytes
  ) {
    return undefined;
  }
  return {
    storageAccountId: value.storageAccountId,
    physicalBucket: value.physicalBucket,
    ...(isCreateShardStatus(value.status) ? { status: value.status } : {}),
    ...(typeof value.capacityBytes === 'number'
      ? { capacityBytes: value.capacityBytes }
      : {}),
    ...(typeof value.usedBytes === 'number'
      ? { usedBytes: value.usedBytes }
      : {}),
  };
}

function parseShardStatusRequest(
  value: unknown,
): UpdateStorageShardStatusRequest | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['status']) ||
    !isShardStatus(value.status)
  ) {
    return undefined;
  }
  return { status: value.status };
}

function logicalBucketResponse(bucket: LogicalBucket): LogicalBucketResponse {
  return {
    id: bucket.id,
    name: bucket.name,
    description: bucket.description,
    createdAt: bucket.createdAt,
    updatedAt: bucket.updatedAt,
  };
}

function storageShardResponse(shard: StorageShard): StorageShardResponse {
  return {
    id: shard.id,
    logicalBucketId: shard.logicalBucketId,
    storageAccountId: shard.storageAccountId,
    physicalBucket: shard.physicalBucket,
    status: shard.status,
    capacityBytes: shard.capacityBytes,
    usedBytes: shard.usedBytes,
    createdAt: shard.createdAt,
    updatedAt: shard.updatedAt,
  };
}

function responseError(
  requestId: string,
  code: BucketErrorCode,
  message: string,
): ApiError<BucketErrorCode> {
  return { error: { code, message }, requestId };
}

type ErrorStatus = 400 | 401 | 404 | 409;

function jsonError(
  context: Context<AppEnvironment>,
  requestId: string,
  code: BucketErrorCode,
  message: string,
  status: ErrorStatus,
): Response {
  context.header('cache-control', 'no-store');
  return context.json(responseError(requestId, code, message), status);
}

function errorDetails(error: unknown): {
  readonly code: BucketErrorCode;
  readonly status: Exclude<ErrorStatus, 401>;
  readonly message: string;
} | undefined {
  if (error instanceof LogicalBucketApplicationError) {
    switch (error.code) {
      case 'LOGICAL_BUCKET_INVALID_INPUT':
        return {
          code: 'LOGICAL_BUCKET_INVALID',
          status: 400,
          message: 'The logical bucket request is invalid.',
        };
      case 'LOGICAL_BUCKET_NOT_FOUND':
        return {
          code: 'LOGICAL_BUCKET_NOT_FOUND',
          status: 404,
          message: 'Logical bucket was not found.',
        };
      case 'LOGICAL_BUCKET_ALREADY_EXISTS':
        return {
          code: 'LOGICAL_BUCKET_ALREADY_EXISTS',
          status: 409,
          message: 'A logical bucket with this name already exists.',
        };
    }
  }
  if (error instanceof StorageShardApplicationError) {
    switch (error.code) {
      case 'STORAGE_SHARD_INVALID_INPUT':
        return {
          code: 'STORAGE_SHARD_INVALID',
          status: 400,
          message: 'The storage shard request is invalid.',
        };
      case 'STORAGE_SHARD_NOT_FOUND':
        return {
          code: 'STORAGE_SHARD_NOT_FOUND',
          status: 404,
          message: 'Storage shard was not found.',
        };
      case 'STORAGE_SHARD_BUCKET_NOT_FOUND':
        return {
          code: 'STORAGE_SHARD_BUCKET_NOT_FOUND',
          status: 404,
          message: 'Logical bucket was not found.',
        };
      case 'STORAGE_SHARD_ACCOUNT_NOT_FOUND':
        return {
          code: 'STORAGE_SHARD_ACCOUNT_NOT_FOUND',
          status: 404,
          message: 'Storage account was not found.',
        };
      case 'STORAGE_SHARD_ACCOUNT_UNAVAILABLE':
        return {
          code: 'STORAGE_SHARD_ACCOUNT_UNAVAILABLE',
          status: 409,
          message: 'Storage account cannot host a new shard.',
        };
      case 'STORAGE_SHARD_ACTIVE_CONFLICT':
        return {
          code: 'STORAGE_SHARD_ACTIVE_CONFLICT',
          status: 409,
          message: 'A logical bucket can have only one active storage shard.',
        };
      case 'STORAGE_SHARD_ALREADY_EXISTS':
        return {
          code: 'STORAGE_SHARD_ALREADY_EXISTS',
          status: 409,
          message: 'The storage shard already exists.',
        };
      case 'STORAGE_SHARD_CONFLICT':
        return {
          code: 'STORAGE_SHARD_CONFLICT',
          status: 409,
          message: 'Storage shard changed while the operation was in progress.',
        };
      case 'STORAGE_SHARD_INVALID_STATE_TRANSITION':
        return {
          code: 'STORAGE_SHARD_INVALID_STATE_TRANSITION',
          status: 409,
          message: 'The requested storage shard status transition is not allowed.',
        };
    }
  }
  return undefined;
}

async function requireAdministrator(
  context: Context<AppEnvironment>,
  dependencies: BucketRouteDependencies,
  requestId: string,
): Promise<Administrator | Response> {
  const sessionToken = getCookie(context, SESSION_COOKIE);
  if (!sessionToken) {
    return jsonError(
      context,
      requestId,
      'UNAUTHORIZED',
      'Administrator authentication is required.',
      401,
    );
  }
  const administrator = await dependencies.authenticate(
    context.env,
    requestId,
    sessionToken,
  );
  if (!administrator) {
    return jsonError(
      context,
      requestId,
      'UNAUTHORIZED',
      'Administrator authentication is required.',
      401,
    );
  }
  return administrator;
}

function noStoreRoutes(app: Hono<AppEnvironment>): void {
  app.use('/api/v1/buckets', async (context, next) => {
    context.header('cache-control', 'no-store');
    await next();
  });
  app.use('/api/v1/buckets/*', async (context, next) => {
    context.header('cache-control', 'no-store');
    await next();
  });
  app.use('/api/v1/shards/*', async (context, next) => {
    context.header('cache-control', 'no-store');
    await next();
  });
}

export function registerBucketRoutes(
  app: Hono<AppEnvironment>,
  dependencies: BucketRouteDependencies,
): void {
  noStoreRoutes(app);

  app.get('/api/v1/buckets', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;
    const buckets = await dependencies
      .createUseCases(context.env, requestId)
      .listBuckets.execute();
    const response: ApiEnvelope<readonly LogicalBucketResponse[]> = {
      data: buckets.map(logicalBucketResponse),
      requestId,
    };
    return context.json(response);
  });

  app.post('/api/v1/buckets', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;
    const input = parseCreateBucketRequest(await readJsonBody(context.req.raw));
    if (!input) {
      return jsonError(
        context,
        requestId,
        'LOGICAL_BUCKET_INVALID',
        'The logical bucket request is invalid.',
        400,
      );
    }
    try {
      const bucket = await dependencies
        .createUseCases(context.env, requestId)
        .createBucket.execute({ ...input, actorId: administrator.id });
      const response: ApiEnvelope<LogicalBucketResponse> = {
        data: logicalBucketResponse(bucket),
        requestId,
      };
      return context.json(response, 201);
    } catch (error) {
      return mappedErrorOrThrow(context, requestId, error);
    }
  });

  app.get('/api/v1/buckets/:id', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;
    try {
      const bucket = await dependencies
        .createUseCases(context.env, requestId)
        .getBucket.execute(context.req.param('id'));
      const response: ApiEnvelope<LogicalBucketResponse> = {
        data: logicalBucketResponse(bucket),
        requestId,
      };
      return context.json(response);
    } catch (error) {
      return mappedErrorOrThrow(context, requestId, error);
    }
  });

  app.get('/api/v1/buckets/:id/shards', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;
    const useCases = dependencies.createUseCases(context.env, requestId);
    const logicalBucketId = context.req.param('id');
    try {
      await useCases.getBucket.execute(logicalBucketId);
      const shards = await useCases.listShards.execute(logicalBucketId);
      const response: ApiEnvelope<readonly StorageShardResponse[]> = {
        data: shards.map(storageShardResponse),
        requestId,
      };
      return context.json(response);
    } catch (error) {
      return mappedErrorOrThrow(context, requestId, error);
    }
  });

  app.post('/api/v1/buckets/:id/shards', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;
    const input = parseCreateShardRequest(await readJsonBody(context.req.raw));
    if (!input) {
      return jsonError(
        context,
        requestId,
        'STORAGE_SHARD_INVALID',
        'The storage shard request is invalid.',
        400,
      );
    }
    try {
      const shard = await dependencies
        .createUseCases(context.env, requestId)
        .createShard.execute({
          ...input,
          actorId: administrator.id,
          logicalBucketId: context.req.param('id'),
        });
      const response: ApiEnvelope<StorageShardResponse> = {
        data: storageShardResponse(shard),
        requestId,
      };
      return context.json(response, 201);
    } catch (error) {
      return mappedErrorOrThrow(context, requestId, error);
    }
  });

  app.patch('/api/v1/shards/:id/status', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;
    const input = parseShardStatusRequest(await readJsonBody(context.req.raw));
    if (!input) {
      return jsonError(
        context,
        requestId,
        'STORAGE_SHARD_INVALID',
        'The storage shard status request is invalid.',
        400,
      );
    }
    try {
      const shard = await dependencies
        .createUseCases(context.env, requestId)
        .transitionShard.execute({
          actorId: administrator.id,
          shardId: context.req.param('id'),
          status: input.status,
        });
      const response: ApiEnvelope<StorageShardResponse> = {
        data: storageShardResponse(shard),
        requestId,
      };
      return context.json(response);
    } catch (error) {
      return mappedErrorOrThrow(context, requestId, error);
    }
  });
}

function mappedErrorOrThrow(
  context: Context<AppEnvironment>,
  requestId: string,
  error: unknown,
): Response {
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
