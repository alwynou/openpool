import {
  AuditQueryApplicationError,
  type AuditLogPage,
  type AuditLogRecord,
  type ListAuditLogs,
  type ListAuditLogsQuery as ApplicationListAuditLogsQuery,
} from '@openpool/application';
import {
  type ApiEnvelope,
  type ApiError,
  type AuditActorType,
  type AuditLogErrorCode,
  type AuditLogResponse,
  type ListAuditLogsResponse,
} from '@openpool/contracts';
import type { Administrator } from '@openpool/domain';
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';

import type { Env } from '../../env';
import type { AppEnvironment } from './types';

const SESSION_COOKIE = 'openpool_session';
const QUERY_KEYS = new Set([
  'limit',
  'actorType',
  'action',
  'resourceType',
  'resourceId',
  'afterCreatedAt',
  'afterId',
]);
const ACTOR_TYPES = new Set<AuditActorType>([
  'ADMIN',
  'API_KEY',
  'SYSTEM',
]);

export interface AuditUseCases {
  readonly listAuditLogs: Pick<ListAuditLogs, 'execute'>;
}

export interface AuditRouteDependencies {
  readonly authenticate: (
    env: Env,
    requestId: string,
    sessionToken: string,
  ) => Administrator | undefined | Promise<Administrator | undefined>;
  readonly createAuditUseCases: (env: Env, requestId: string) => AuditUseCases;
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isValidFilter(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  );
}

function parseQuery(request: Request): ApplicationListAuditLogsQuery | undefined {
  const searchParams = new URL(request.url).searchParams;
  const seen = new Set<string>();
  for (const [key] of searchParams) {
    if (!QUERY_KEYS.has(key) || seen.has(key)) return undefined;
    seen.add(key);
  }

  const rawLimit = searchParams.get('limit');
  if (rawLimit !== null && !/^[1-9]\d{0,2}$/u.test(rawLimit)) return undefined;
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && limit > 200) return undefined;

  const rawActorType = searchParams.get('actorType');
  if (
    rawActorType !== null &&
    !ACTOR_TYPES.has(rawActorType as AuditActorType)
  ) {
    return undefined;
  }

  const action = searchParams.get('action');
  const resourceType = searchParams.get('resourceType');
  const resourceId = searchParams.get('resourceId');
  for (const value of [action, resourceType, resourceId]) {
    if (value !== null && !isValidFilter(value)) return undefined;
  }

  const afterCreatedAt = searchParams.get('afterCreatedAt');
  const afterId = searchParams.get('afterId');
  if ((afterCreatedAt === null) !== (afterId === null)) return undefined;
  if (
    afterCreatedAt !== null &&
    (!isCanonicalTimestamp(afterCreatedAt) ||
      afterId === null ||
      !isValidFilter(afterId))
  ) {
    return undefined;
  }

  return {
    ...(limit === undefined ? {} : { limit }),
    ...(rawActorType === null
      ? {}
      : { actorType: rawActorType as AuditActorType }),
    ...(action === null ? {} : { action }),
    ...(resourceType === null ? {} : { resourceType }),
    ...(resourceId === null ? {} : { resourceId }),
    ...(afterCreatedAt === null
      ? {}
      : { afterCreatedAt, afterId: afterId as string }),
  };
}

function auditLogResponse(record: AuditLogRecord): AuditLogResponse {
  return {
    id: record.id,
    actorType: record.actorType,
    actorId: record.actorId,
    action: record.action,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    requestId: record.requestId,
    metadata: { ...record.metadata },
    createdAt: record.createdAt,
  };
}

function listResponse(page: AuditLogPage): ListAuditLogsResponse {
  return {
    items: page.items.map(auditLogResponse),
    nextCursor:
      page.nextCursor === null
        ? null
        : {
            afterCreatedAt: page.nextCursor.afterCreatedAt,
            afterId: page.nextCursor.afterId,
          },
  };
}

function errorResponse(
  requestId: string,
  code: AuditLogErrorCode,
  message: string,
): ApiError<AuditLogErrorCode> {
  return { error: { code, message }, requestId };
}

function jsonError(
  context: Context<AppEnvironment>,
  requestId: string,
  code: AuditLogErrorCode,
  message: string,
  status: 400 | 401,
): Response {
  context.header('cache-control', 'no-store');
  return context.json(errorResponse(requestId, code, message), status);
}

function invalidQuery(
  context: Context<AppEnvironment>,
  requestId: string,
): Response {
  return jsonError(
    context,
    requestId,
    'AUDIT_QUERY_INVALID',
    'The audit log query is invalid.',
    400,
  );
}

export function registerAuditRoutes(
  app: Hono<AppEnvironment>,
  dependencies: AuditRouteDependencies,
): void {
  app.use('/api/v1/audit-logs', async (context, next) => {
    context.header('cache-control', 'no-store');
    await next();
  });

  app.get('/api/v1/audit-logs', async (context) => {
    const requestId = context.get('requestId');
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

    const query = parseQuery(context.req.raw);
    if (!query) return invalidQuery(context, requestId);

    try {
      const page = await dependencies
        .createAuditUseCases(context.env, requestId)
        .listAuditLogs.execute(query);
      const response: ApiEnvelope<ListAuditLogsResponse> = {
        data: listResponse(page),
        requestId,
      };
      return context.json(response);
    } catch (error) {
      if (error instanceof AuditQueryApplicationError) {
        return invalidQuery(context, requestId);
      }
      throw error;
    }
  });
}
