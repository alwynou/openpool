import {
  ShardMigrationApplicationError,
  type ClaimShardMigrationTransfer,
  type CompleteShardMigrationTransfer,
  type GetShardMigration,
  type ListShardMigrations,
  type ShardMigrationResult,
  type StartShardMigration,
} from '@openpool/application';
import type {
  ApiEnvelope,
  ApiError,
  CompleteShardMigrationTransferRequest,
  CompleteShardMigrationTransferResponse,
  ShardMigrationErrorCode,
  ShardMigrationResponse,
  ShardMigrationTransferResponse,
  StartShardMigrationRequest,
} from '@openpool/contracts';
import { ProviderError, type Administrator } from '@openpool/domain';
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';

import { CredentialVaultError } from '../crypto';
import type { Env } from '../../env';
import { readJsonBody } from './json-body';
import type { AppEnvironment } from './types';

const SESSION_COOKIE = 'openpool_session';

export interface ShardMigrationUseCases {
  readonly startMigration: Pick<StartShardMigration, 'execute'>;
  readonly getMigration: Pick<GetShardMigration, 'execute'>;
  readonly listMigrations: Pick<ListShardMigrations, 'execute'>;
  readonly claimMigrationTransfer: Pick<ClaimShardMigrationTransfer, 'execute'>;
  readonly completeMigrationTransfer: Pick<
    CompleteShardMigrationTransfer,
    'execute'
  >;
}

export interface ShardMigrationRouteDependencies {
  readonly authenticate: (
    env: Env,
    requestId: string,
    sessionToken: string,
  ) => Administrator | undefined | Promise<Administrator | undefined>;
  readonly createMigrationUseCases: (
    env: Env,
    requestId: string,
  ) => ShardMigrationUseCases;
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

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function parseStartRequest(
  value: unknown,
): StartShardMigrationRequest | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'sourceShardId',
      'targetShardId',
      'expectedSourceUpdatedAt',
      'expectedTargetUpdatedAt',
    ]) ||
    typeof value.sourceShardId !== 'string' ||
    typeof value.targetShardId !== 'string' ||
    !isCanonicalTimestamp(value.expectedSourceUpdatedAt) ||
    !isCanonicalTimestamp(value.expectedTargetUpdatedAt)
  ) {
    return undefined;
  }
  return {
    sourceShardId: value.sourceShardId,
    targetShardId: value.targetShardId,
    expectedSourceUpdatedAt: value.expectedSourceUpdatedAt,
    expectedTargetUpdatedAt: value.expectedTargetUpdatedAt,
  };
}

function parseCompleteRequest(
  value: unknown,
): CompleteShardMigrationTransferRequest | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['leaseToken']) ||
    typeof value.leaseToken !== 'string' ||
    value.leaseToken.length === 0
  ) {
    return undefined;
  }
  return { leaseToken: value.leaseToken };
}

function hasNoQuery(request: Request): boolean {
  return new URL(request.url).search.length === 0;
}

async function hasEmptyBody(request: Request): Promise<boolean> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && declaredLength !== '0') return false;
  if (request.body === null) return true;

  // Worker ingress can represent a zero-byte POST as a non-null stream.
  // Check actual bytes as well; a zero Content-Length alone is not sufficient.
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (value.byteLength > 0) {
        await reader.cancel();
        return false;
      }
    }
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

function migrationResponse(result: ShardMigrationResult): ShardMigrationResponse {
  return {
    id: result.migration.id,
    sourceShardId: result.migration.sourceShardId,
    targetShardId: result.migration.targetShardId,
    status: result.migration.status,
    progress: {
      reserved: result.progress.reserved,
      switched: result.progress.switched,
      completed: result.progress.completed,
      failed: result.progress.failed,
      remainingReady: result.progress.remainingReady,
      blocking: result.progress.blocking,
    },
    createdAt: result.migration.createdAt,
    updatedAt: result.migration.updatedAt,
    completedAt: result.migration.completedAt,
  };
}

function responseError(
  requestId: string,
  code: ShardMigrationErrorCode,
  message: string,
): ApiError<ShardMigrationErrorCode> {
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
  code: ShardMigrationErrorCode,
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
    'SHARD_MIGRATION_INVALID',
    'The shard migration request is invalid.',
    400,
  );
}

function applicationErrorDetails(error: ShardMigrationApplicationError): {
  readonly code: ShardMigrationErrorCode;
  readonly status: ErrorStatus;
  readonly message: string;
} {
  switch (error.code) {
    case 'SHARD_MIGRATION_INVALID_INPUT':
      return {
        code: 'SHARD_MIGRATION_INVALID',
        status: 400,
        message: 'The shard migration request is invalid.',
      };
    case 'SHARD_MIGRATION_NOT_FOUND':
      return {
        code: error.code,
        status: 404,
        message: 'Shard migration was not found.',
      };
    case 'SHARD_MIGRATION_BUCKET_NOT_FOUND':
      return {
        code: error.code,
        status: 404,
        message: 'Logical bucket was not found.',
      };
    case 'SHARD_MIGRATION_SOURCE_NOT_FOUND':
      return {
        code: error.code,
        status: 404,
        message: 'Source storage shard was not found.',
      };
    case 'SHARD_MIGRATION_TARGET_NOT_FOUND':
      return {
        code: error.code,
        status: 404,
        message: 'Target storage shard was not found.',
      };
    case 'SHARD_MIGRATION_ACCOUNT_NOT_FOUND':
      return {
        code: error.code,
        status: 404,
        message: 'A migration storage account was not found.',
      };
    case 'SHARD_MIGRATION_SOURCE_NOT_DRAINING':
      return {
        code: error.code,
        status: 409,
        message: 'The source storage account must be draining.',
      };
    case 'SHARD_MIGRATION_TARGET_UNAVAILABLE':
      return {
        code: error.code,
        status: 409,
        message: 'The target storage shard cannot receive this migration.',
      };
    case 'SHARD_MIGRATION_ALREADY_RUNNING':
      return {
        code: error.code,
        status: 409,
        message: 'The source shard already has a running migration.',
      };
    case 'SHARD_MIGRATION_CONFLICT':
      return {
        code: error.code,
        status: 409,
        message: 'The migration changed while the operation was in progress.',
      };
    case 'SHARD_MIGRATION_CAPACITY_UNAVAILABLE':
      return {
        code: error.code,
        status: 409,
        message: 'Target migration capacity is unavailable.',
      };
    case 'SHARD_MIGRATION_NO_TRANSFER_AVAILABLE':
      return {
        code: error.code,
        status: 409,
        message: 'No migration transfer is currently available.',
      };
    case 'SHARD_MIGRATION_TRANSFER_NOT_FOUND':
      return {
        code: error.code,
        status: 404,
        message: 'Migration transfer was not found.',
      };
    case 'SHARD_MIGRATION_TRANSFER_EXPIRED':
      return {
        code: error.code,
        status: 410,
        message: 'The migration transfer lease has expired.',
      };
    case 'SHARD_MIGRATION_TARGET_MISMATCH':
      return {
        code: error.code,
        status: 422,
        message: 'The target object does not match the migration reservation.',
      };
    case 'SHARD_MIGRATION_BLOCKED':
      return {
        code: error.code,
        status: 409,
        message: 'The migration is blocked by unfinished object state.',
      };
  }
}

function providerErrorDetails(error: ProviderError): {
  readonly code: ShardMigrationErrorCode;
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
  readonly code: ShardMigrationErrorCode;
  readonly status: ErrorStatus;
  readonly message: string;
} | undefined {
  if (error instanceof ShardMigrationApplicationError) {
    return applicationErrorDetails(error);
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

async function requireAdministrator(
  context: Context<AppEnvironment>,
  dependencies: ShardMigrationRouteDependencies,
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

async function runOperation<T>(
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
  app.use('/api/v1/shard-migrations', noStore);
  app.use('/api/v1/shard-migrations/*', noStore);
  app.use('/api/v1/shard-migration-transfers/*', noStore);
  app.use('/api/v1/buckets/:bucketId/shard-migrations', noStore);
}

export function registerShardMigrationRoutes(
  app: Hono<AppEnvironment>,
  dependencies: ShardMigrationRouteDependencies,
): void {
  addNoStoreMiddleware(app);

  app.post('/api/v1/shard-migrations', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;
    if (!hasNoQuery(context.req.raw)) return invalidRequest(context, requestId);
    const input = parseStartRequest(await readJsonBody(context.req.raw));
    if (!input) return invalidRequest(context, requestId);
    return runOperation(
      context,
      requestId,
      () =>
        dependencies
          .createMigrationUseCases(context.env, requestId)
          .startMigration.execute({ actorId: administrator.id, ...input }),
      (result) => {
        const response: ApiEnvelope<ShardMigrationResponse> = {
          data: migrationResponse(result),
          requestId,
        };
        return context.json(response, 202);
      },
    );
  });

  app.get('/api/v1/buckets/:bucketId/shard-migrations', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;
    if (!hasNoQuery(context.req.raw)) return invalidRequest(context, requestId);
    return runOperation(
      context,
      requestId,
      () =>
        dependencies
          .createMigrationUseCases(context.env, requestId)
          .listMigrations.execute(context.req.param('bucketId') ?? ''),
      (results) => {
        const response: ApiEnvelope<readonly ShardMigrationResponse[]> = {
          data: results.map(migrationResponse),
          requestId,
        };
        return context.json(response);
      },
    );
  });

  app.get('/api/v1/shard-migrations/:id', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;
    if (!hasNoQuery(context.req.raw)) return invalidRequest(context, requestId);
    return runOperation(
      context,
      requestId,
      () =>
        dependencies
          .createMigrationUseCases(context.env, requestId)
          .getMigration.execute(context.req.param('id') ?? ''),
      (result) => {
        const response: ApiEnvelope<ShardMigrationResponse> = {
          data: migrationResponse(result),
          requestId,
        };
        return context.json(response);
      },
    );
  });

  app.post('/api/v1/shard-migrations/:id/transfers', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;
    if (!hasNoQuery(context.req.raw) || !(await hasEmptyBody(context.req.raw))) {
      return invalidRequest(context, requestId);
    }
    return runOperation(
      context,
      requestId,
      () =>
        dependencies
          .createMigrationUseCases(context.env, requestId)
          .claimMigrationTransfer.execute({
            actorId: administrator.id,
            migrationId: context.req.param('id') ?? '',
          }),
      (result) => {
        const data: ShardMigrationTransferResponse = {
          taskId: result.taskId,
          objectId: result.objectId,
          sizeBytes: result.sizeBytes,
          contentType: result.contentType,
          downloadUrl: result.downloadUrl,
          uploadUrl: result.uploadUrl,
          expiresAt: result.expiresAt,
          leaseToken: result.leaseToken,
        };
        const response: ApiEnvelope<ShardMigrationTransferResponse> = {
          data,
          requestId,
        };
        return context.json(response);
      },
    );
  });

  app.post('/api/v1/shard-migration-transfers/:taskId/complete', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;
    if (!hasNoQuery(context.req.raw)) return invalidRequest(context, requestId);
    const input = parseCompleteRequest(await readJsonBody(context.req.raw));
    if (!input) return invalidRequest(context, requestId);
    return runOperation(
      context,
      requestId,
      () =>
        dependencies
          .createMigrationUseCases(context.env, requestId)
          .completeMigrationTransfer.execute({
            actorId: administrator.id,
            taskId: context.req.param('taskId') ?? '',
            leaseToken: input.leaseToken,
          }),
      (result) => {
        const data: CompleteShardMigrationTransferResponse = {
          taskId: result.taskId,
          status: result.status,
          migrationCompleted: result.migrationCompleted,
        };
        const response: ApiEnvelope<CompleteShardMigrationTransferResponse> = {
          data,
          requestId,
        };
        return context.json(response);
      },
    );
  });
}
