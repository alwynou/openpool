import {
  ApiKeyApplicationError,
  type CreateApiKey,
  type ListApiKeys,
  type RevokeApiKey,
} from '@openpool/application';
import {
  apiKeyScopes,
  type ApiEnvelope,
  type ApiError,
  type ApiKeyErrorCode,
  type ApiKeyResponse,
  type ApiKeyScope,
  type CreateApiKeyRequest,
  type CreatedApiKeyResponse,
} from '@openpool/contracts';
import type { Administrator, ApiKey } from '@openpool/domain';
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';

import type { Env } from '../../env';
import { readJsonBody } from './json-body';
import type { AppEnvironment } from './types';

const SESSION_COOKIE = 'openpool_session';
const API_KEY_SCOPES = new Set<string>(apiKeyScopes);

export interface ApiKeyUseCases {
  readonly createApiKey: Pick<CreateApiKey, 'execute'>;
  readonly listApiKeys: Pick<ListApiKeys, 'execute'>;
  readonly revokeApiKey: Pick<RevokeApiKey, 'execute'>;
}

/** Factories keep administrator authentication and persistence out of HTTP parsing. */
export interface ApiKeyRouteDependencies {
  readonly authenticate: (
    env: Env,
    requestId: string,
    sessionToken: string,
  ) => Administrator | undefined | Promise<Administrator | undefined>;
  readonly createApiKeyUseCases: (
    env: Env,
    requestId: string,
  ) => ApiKeyUseCases;
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

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && API_KEY_SCOPES.has(value);
}

function parseCreateApiKeyRequest(
  value: unknown,
): CreateApiKeyRequest | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['name', 'scopes'], [
      'logicalBucketId',
      'pathPrefix',
      'expiresAt',
    ]) ||
    typeof value.name !== 'string' ||
    !Array.isArray(value.scopes) ||
    value.scopes.length === 0 ||
    value.scopes.some((scope) => !isApiKeyScope(scope)) ||
    new Set(value.scopes).size !== value.scopes.length
  ) {
    return undefined;
  }

  for (const key of ['logicalBucketId', 'pathPrefix', 'expiresAt'] as const) {
    if (Object.hasOwn(value, key) && !isNullableString(value[key])) {
      return undefined;
    }
  }

  return {
    name: value.name,
    scopes: value.scopes,
    ...(Object.hasOwn(value, 'logicalBucketId')
      ? { logicalBucketId: value.logicalBucketId as string | null }
      : {}),
    ...(Object.hasOwn(value, 'pathPrefix')
      ? { pathPrefix: value.pathPrefix as string | null }
      : {}),
    ...(Object.hasOwn(value, 'expiresAt')
      ? { expiresAt: value.expiresAt as string | null }
      : {}),
  };
}

function apiKeyResponse(apiKey: ApiKey): ApiKeyResponse {
  return {
    id: apiKey.id,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    scopes: [...apiKey.scopes],
    logicalBucketId: apiKey.logicalBucketId,
    pathPrefix: apiKey.pathPrefix,
    expiresAt: apiKey.expiresAt,
    revokedAt: apiKey.revokedAt,
    createdAt: apiKey.createdAt,
  };
}

function responseError(
  requestId: string,
  code: ApiKeyErrorCode,
  message: string,
): ApiError<ApiKeyErrorCode> {
  return { error: { code, message }, requestId };
}

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 503;

function jsonError(
  context: Context<AppEnvironment>,
  requestId: string,
  code: ApiKeyErrorCode,
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
    'API_KEY_INVALID',
    'The API key request is invalid.',
    400,
  );
}

function errorDetails(error: ApiKeyApplicationError): {
  readonly code: ApiKeyErrorCode;
  readonly status: ErrorStatus;
  readonly message: string;
} {
  switch (error.code) {
    case 'API_KEY_INVALID_INPUT':
      return {
        code: 'API_KEY_INVALID',
        status: 400,
        message: 'The API key request is invalid.',
      };
    case 'API_KEY_CONFLICT':
      return {
        code: 'API_KEY_CONFLICT',
        status: 409,
        message: 'The API key changed while the operation was in progress.',
      };
    case 'API_KEY_NOT_FOUND':
      return {
        code: 'API_KEY_NOT_FOUND',
        status: 404,
        message: 'API key was not found.',
      };
    case 'API_KEY_BUCKET_NOT_FOUND':
      return {
        code: 'API_KEY_BUCKET_NOT_FOUND',
        status: 404,
        message: 'Logical bucket was not found.',
      };
    case 'API_KEY_AUTHENTICATION_FAILED':
      return {
        code: 'API_KEY_UNAUTHORIZED',
        status: 401,
        message: 'API key authentication failed.',
      };
    case 'API_KEY_FORBIDDEN':
      return {
        code: 'API_KEY_FORBIDDEN',
        status: 403,
        message: 'API key is not authorized for this operation.',
      };
    case 'API_KEY_GENERATION_FAILED':
      return {
        code: 'API_KEY_GENERATION_FAILED',
        status: 503,
        message: 'API key generation is temporarily unavailable.',
      };
  }
}

async function requireAdministrator(
  context: Context<AppEnvironment>,
  dependencies: ApiKeyRouteDependencies,
  requestId: string,
): Promise<Administrator | Response> {
  const sessionToken = getCookie(context, SESSION_COOKIE);
  if (!sessionToken) {
    return jsonError(
      context,
      requestId,
      'API_KEY_UNAUTHORIZED',
      'Administrator authentication is required.',
      401,
    );
  }

  // Authentication infrastructure failures intentionally reach the global handler.
  const administrator = await dependencies.authenticate(
    context.env,
    requestId,
    sessionToken,
  );
  if (!administrator) {
    return jsonError(
      context,
      requestId,
      'API_KEY_UNAUTHORIZED',
      'Administrator authentication is required.',
      401,
    );
  }
  return administrator;
}

function mappedErrorOrThrow(
  context: Context<AppEnvironment>,
  requestId: string,
  error: unknown,
): Response {
  if (!(error instanceof ApiKeyApplicationError)) throw error;
  const details = errorDetails(error);
  return jsonError(
    context,
    requestId,
    details.code,
    details.message,
    details.status,
  );
}

export function registerApiKeyRoutes(
  app: Hono<AppEnvironment>,
  dependencies: ApiKeyRouteDependencies,
): void {
  app.use('/api/v1/api-keys', async (context, next) => {
    context.header('cache-control', 'no-store');
    await next();
  });
  app.use('/api/v1/api-keys/*', async (context, next) => {
    context.header('cache-control', 'no-store');
    await next();
  });

  app.post('/api/v1/api-keys', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;

    const input = parseCreateApiKeyRequest(await readJsonBody(context.req.raw));
    if (!input) return invalidRequest(context, requestId);

    try {
      const created = await dependencies
        .createApiKeyUseCases(context.env, requestId)
        .createApiKey.execute({ ...input, actorId: administrator.id });
      const data: CreatedApiKeyResponse = {
        apiKey: apiKeyResponse(created.apiKey),
        token: created.token,
      };
      const response: ApiEnvelope<CreatedApiKeyResponse> = { data, requestId };
      return context.json(response, 201);
    } catch (error) {
      return mappedErrorOrThrow(context, requestId, error);
    }
  });

  app.get('/api/v1/api-keys', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;

    try {
      const apiKeys = await dependencies
        .createApiKeyUseCases(context.env, requestId)
        .listApiKeys.execute();
      const response: ApiEnvelope<readonly ApiKeyResponse[]> = {
        data: apiKeys.map(apiKeyResponse),
        requestId,
      };
      return context.json(response);
    } catch (error) {
      return mappedErrorOrThrow(context, requestId, error);
    }
  });

  app.delete('/api/v1/api-keys/:id', async (context) => {
    const requestId = context.get('requestId');
    const administrator = await requireAdministrator(
      context,
      dependencies,
      requestId,
    );
    if (administrator instanceof Response) return administrator;

    try {
      const revoked = await dependencies
        .createApiKeyUseCases(context.env, requestId)
        .revokeApiKey.execute({
          actorId: administrator.id,
          id: context.req.param('id'),
        });
      const response: ApiEnvelope<ApiKeyResponse> = {
        data: apiKeyResponse(revoked),
        requestId,
      };
      return context.json(response);
    } catch (error) {
      return mappedErrorOrThrow(context, requestId, error);
    }
  });
}
