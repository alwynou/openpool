import {
  StorageAccountApplicationError,
  type CreateStorageAccount,
  type ListStorageAccounts,
  type RefreshStorageAccountHealth,
  type TransitionStorageAccount,
  type VerifyStorageAccount,
} from '@openpool/application';
import type {
  ApiEnvelope,
  ApiError,
  CreateStorageAccountRequest,
  ProviderConfigRequest,
  StorageAccountErrorCode,
  StorageAccountResponse,
  StorageCredentialsRequest,
  UpdateStorageAccountStatusRequest,
} from '@openpool/contracts';
import {
  ProviderError,
  StorageAccountStateError,
  availableBytes,
  type Administrator,
  type StorageAccount,
  type StorageAccountStatus,
} from '@openpool/domain';
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';

import { CredentialVaultError } from '../crypto';
import type { Env } from '../../env';
import { readJsonBody } from './json-body';
import type { AppEnvironment } from './types';

const SESSION_COOKIE = 'openpool_session';
const PROVIDERS = new Set(['r2', 'b2', 's3']);
const TRANSITION_STATUSES = new Set(['DRAINING', 'READ_ONLY', 'REMOVED']);
const STATUS_KEYS = ['status'] as const;

type StorageAccountUseCases = {
  readonly create: Pick<CreateStorageAccount, 'execute'>;
  readonly list: Pick<ListStorageAccounts, 'execute'>;
  readonly verify: Pick<VerifyStorageAccount, 'execute'>;
  readonly transition: Pick<TransitionStorageAccount, 'execute'>;
  readonly refresh: Pick<RefreshStorageAccountHealth, 'execute'>;
};

/** Dependencies are deliberately functions so tests can replace auth and every use case. */
export interface StorageAccountRouteDependencies {
  readonly authenticate: (
    env: Env,
    requestId: string,
    sessionToken: string,
  ) => Administrator | undefined | Promise<Administrator | undefined>;
  readonly createUseCases: (
    env: Env,
    requestId: string,
  ) => StorageAccountUseCases;
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
  expected: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...expected, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key)) &&
    expected.every((key) => Object.hasOwn(value, key));
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function parseProviderConfig(value: unknown): ProviderConfigRequest | undefined {
  if (!isPlainObject(value)) return undefined;
  const config: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item !== 'string' &&
      typeof item !== 'number' &&
      typeof item !== 'boolean' &&
      item !== null
    ) {
      return undefined;
    }
    if (typeof item === 'number' && !Number.isFinite(item)) return undefined;
    // Avoid assigning a user-controlled __proto__ onto a normal object.
    Object.defineProperty(config, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return config;
}

function parseCredentials(value: unknown): StorageCredentialsRequest | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ['accessKeyId', 'secretAccessKey'], ['sessionToken'])) {
    return undefined;
  }
  if (
    typeof value.accessKeyId !== 'string' ||
    typeof value.secretAccessKey !== 'string' ||
    value.accessKeyId.length === 0 ||
    value.secretAccessKey.length === 0
  ) {
    return undefined;
  }
  if (Object.hasOwn(value, 'sessionToken') && typeof value.sessionToken !== 'string') {
    return undefined;
  }
  const sessionToken = value.sessionToken;
  return {
    accessKeyId: value.accessKeyId,
    secretAccessKey: value.secretAccessKey,
    ...(typeof sessionToken === 'string' ? { sessionToken } : {}),
  };
}

function parseCreateRequest(value: unknown): CreateStorageAccountRequest | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ['name', 'provider', 'providerConfig', 'credentials'], ['priority', 'capacityBytes'])) {
    return undefined;
  }
  const providerConfig = parseProviderConfig(value.providerConfig);
  const credentials = parseCredentials(value.credentials);
  if (
    typeof value.name !== 'string' ||
    typeof value.provider !== 'string' ||
    !PROVIDERS.has(value.provider) ||
    providerConfig === undefined ||
    credentials === undefined
  ) {
    return undefined;
  }
  if (Object.hasOwn(value, 'priority') && !isSafeInteger(value.priority)) {
    return undefined;
  }
  if (
    Object.hasOwn(value, 'capacityBytes') &&
    (!isSafeInteger(value.capacityBytes) || value.capacityBytes < 0)
  ) {
    return undefined;
  }
  const priority = value.priority;
  const capacityBytes = value.capacityBytes;
  return {
    name: value.name,
    provider: value.provider as CreateStorageAccountRequest['provider'],
    providerConfig,
    credentials,
    ...(typeof priority === 'number' ? { priority } : {}),
    ...(typeof capacityBytes === 'number' ? { capacityBytes } : {}),
  };
}

function parseStatusRequest(value: unknown): UpdateStorageAccountStatusRequest | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, STATUS_KEYS) ||
    typeof value.status !== 'string' ||
    !TRANSITION_STATUSES.has(value.status)
  ) {
    return undefined;
  }
  return { status: value.status as UpdateStorageAccountStatusRequest['status'] };
}

function storageAccountResponse(account: StorageAccount): StorageAccountResponse {
  return {
    id: account.id,
    name: account.name,
    provider: account.provider,
    providerConfig: account.providerConfig,
    status: account.status,
    priority: account.priority,
    writeEnabled: account.writeEnabled,
    capacityBytes: account.capacityBytes,
    usedBytes: account.usedBytes,
    availableBytes: availableBytes(account),
    healthStatus: account.healthStatus,
    capacityAccuracy: account.capacityAccuracy,
    capabilities: account.capabilities,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastHealthCheckedAt: account.lastHealthCheckedAt,
  };
}

function responseError(
  requestId: string,
  code: StorageAccountErrorCode,
  message: string,
): ApiError<StorageAccountErrorCode> {
  return { error: { code, message }, requestId };
}

function jsonError(
  context: Context<AppEnvironment>,
  requestId: string,
  code: StorageAccountErrorCode,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503 | 504,
) {
  context.header('cache-control', 'no-store');
  return context.json(responseError(requestId, code, message), status);
}

function errorDetails(error: unknown): {
  readonly code: StorageAccountErrorCode;
  readonly status: 400 | 403 | 404 | 409 | 422 | 429 | 502 | 503 | 504;
  readonly message: string;
} | undefined {
  if (error instanceof StorageAccountApplicationError) {
    switch (error.code) {
      case 'STORAGE_ACCOUNT_NOT_FOUND':
        return { code: 'STORAGE_ACCOUNT_NOT_FOUND', status: 404, message: 'Storage account was not found.' };
      case 'STORAGE_ACCOUNT_ALREADY_EXISTS':
        return { code: 'STORAGE_ACCOUNT_ALREADY_EXISTS', status: 409, message: 'A storage account with this name already exists.' };
      case 'STORAGE_ACCOUNT_REQUIRES_VERIFICATION':
        return { code: 'STORAGE_ACCOUNT_REQUIRES_VERIFICATION', status: 409, message: 'Storage account requires verification before activation.' };
      case 'STORAGE_ACCOUNT_NOT_VERIFYING':
        return { code: 'STORAGE_ACCOUNT_NOT_VERIFYING', status: 409, message: 'Storage account is not awaiting verification.' };
      case 'STORAGE_ACCOUNT_CONFLICT':
        return { code: 'STORAGE_ACCOUNT_CONFLICT', status: 409, message: 'Storage account changed while the operation was in progress.' };
      case 'STORAGE_ACCOUNT_HAS_REFERENCES':
        return { code: 'STORAGE_ACCOUNT_HAS_REFERENCES', status: 409, message: 'Storage account still has live shards or objects.' };
      case 'STORAGE_ACCOUNT_VALIDATION_FAILED':
      case 'INVALID_STORAGE_ACCOUNT_INPUT':
        return { code: 'STORAGE_ACCOUNT_INVALID', status: 400, message: 'The storage account configuration is invalid.' };
    }
  }

  if (error instanceof StorageAccountStateError) {
    return { code: 'STORAGE_ACCOUNT_CONFLICT', status: 409, message: 'The requested storage account status transition is not allowed.' };
  }

  if (error instanceof ProviderError) {
    switch (error.code) {
      case 'INVALID_CREDENTIALS':
        return { code: 'PROVIDER_INVALID_CREDENTIALS', status: 422, message: 'The provider credentials are invalid.' };
      case 'FORBIDDEN':
        return { code: 'PROVIDER_FORBIDDEN', status: 403, message: 'The provider denied this operation.' };
      case 'NOT_FOUND':
        return { code: 'PROVIDER_NOT_FOUND', status: 404, message: 'The provider resource was not found.' };
      case 'RATE_LIMITED':
        return { code: 'PROVIDER_RATE_LIMITED', status: 429, message: 'The provider rate limit was reached.' };
      case 'TIMEOUT':
        return { code: 'PROVIDER_TIMEOUT', status: 504, message: 'The provider did not respond in time.' };
      case 'TEMPORARY_FAILURE':
        return { code: 'PROVIDER_UNAVAILABLE', status: 503, message: 'The provider is temporarily unavailable.' };
      case 'UNSUPPORTED_CAPABILITY':
        return { code: 'PROVIDER_UNSUPPORTED', status: 422, message: 'The provider does not support this operation.' };
      case 'QUOTA_EXCEEDED':
        return { code: 'PROVIDER_QUOTA_EXCEEDED', status: 409, message: 'The provider quota has been exceeded.' };
      case 'PROTOCOL_ERROR':
        return { code: 'PROVIDER_PROTOCOL_ERROR', status: 502, message: 'The provider returned an invalid response.' };
    }
  }

  if (error instanceof CredentialVaultError) {
    return { code: 'CREDENTIAL_VAULT_UNAVAILABLE', status: 503, message: 'Credential storage is temporarily unavailable.' };
  }
  return undefined;
}

async function requireAdministrator(
  context: Context<AppEnvironment>,
  dependencies: StorageAccountRouteDependencies,
  requestId: string,
): Promise<Administrator | Response> {
  const token = getCookie(context, SESSION_COOKIE);
  if (!token) {
    return jsonError(context, requestId, 'UNAUTHORIZED', 'Administrator authentication is required.', 401);
  }
  const administrator = await dependencies.authenticate(
    context.env,
    requestId,
    token,
  );
  if (!administrator) {
    return jsonError(context, requestId, 'UNAUTHORIZED', 'Administrator authentication is required.', 401);
  }
  return administrator;
}

export function registerStorageAccountRoutes(
  app: Hono<AppEnvironment>,
  dependencies: StorageAccountRouteDependencies,
): void {
  app.use('/api/v1/storage-accounts', async (context, next) => {
    context.header('cache-control', 'no-store');
    await next();
  });
  app.use('/api/v1/storage-accounts/*', async (context, next) => {
    context.header('cache-control', 'no-store');
    await next();
  });

  app.get('/api/v1/storage-accounts', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(context, dependencies, requestId);
    if (administrator instanceof Response) return administrator;
    try {
      const accounts = await dependencies.createUseCases(context.env, requestId).list.execute();
      const response: ApiEnvelope<readonly StorageAccountResponse[]> = {
        data: accounts.map(storageAccountResponse),
        requestId,
      };
      return context.json(response);
    } catch (error) {
      const details = errorDetails(error);
      if (!details) throw error;
      return jsonError(context, requestId, details.code, details.message, details.status);
    }
  });

  app.post('/api/v1/storage-accounts', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(context, dependencies, requestId);
    if (administrator instanceof Response) return administrator;
    const input = parseCreateRequest(await readJsonBody(context.req.raw));
    if (!input) return jsonError(context, requestId, 'STORAGE_ACCOUNT_INVALID', 'The storage account request is invalid.', 400);
    try {
      const result = await dependencies.createUseCases(context.env, requestId).create.execute({
        ...input,
        actorId: administrator.id,
      });
      const response: ApiEnvelope<StorageAccountResponse> = {
        data: storageAccountResponse(result.account),
        requestId,
      };
      return context.json(response, 201);
    } catch (error) {
      const details = errorDetails(error);
      if (!details) throw error;
      return jsonError(context, requestId, details.code, details.message, details.status);
    }
  });

  app.post('/api/v1/storage-accounts/:id/verify', async (context) => {
    return runAccountMutation(context, dependencies, async (useCases, administrator, id) => {
      const result = await useCases.verify.execute({ actorId: administrator.id, accountId: id });
      return result.account;
    });
  });

  app.post('/api/v1/storage-accounts/:id/health', async (context) => {
    return runAccountMutation(context, dependencies, async (useCases, administrator, id) =>
      useCases.refresh.execute({ actorId: administrator.id, accountId: id }),
    );
  });

  app.patch('/api/v1/storage-accounts/:id/status', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(context, dependencies, requestId);
    if (administrator instanceof Response) return administrator;
    const input = parseStatusRequest(await readJsonBody(context.req.raw));
    if (!input) return jsonError(context, requestId, 'STORAGE_ACCOUNT_INVALID', 'The storage account status request is invalid.', 400);
    try {
      const account = await dependencies.createUseCases(context.env, requestId).transition.execute({
        actorId: administrator.id,
        accountId: context.req.param('id') ?? '',
        status: input.status as StorageAccountStatus,
      });
      const response: ApiEnvelope<StorageAccountResponse> = { data: storageAccountResponse(account), requestId };
      return context.json(response);
    } catch (error) {
      const details = errorDetails(error);
      if (!details) throw error;
      return jsonError(context, requestId, details.code, details.message, details.status);
    }
  });
}

async function runAccountMutation(
  context: Context<AppEnvironment>,
  dependencies: StorageAccountRouteDependencies,
  execute: (
    useCases: StorageAccountUseCases,
    administrator: Administrator,
    id: string,
  ) => Promise<StorageAccount>,
): Promise<Response> {
  const requestId = context.get('requestId');
  const administrator = await requireAdministrator(context, dependencies, requestId);
  if (administrator instanceof Response) return administrator;
  try {
    const account = await execute(
      dependencies.createUseCases(context.env, requestId),
      administrator,
      context.req.param('id') ?? '',
    );
    const response: ApiEnvelope<StorageAccountResponse> = {
      data: storageAccountResponse(account),
      requestId,
    };
    return context.json(response);
  } catch (error) {
    const details = errorDetails(error);
    if (!details) throw error;
    return jsonError(context, requestId, details.code, details.message, details.status);
  }
}
