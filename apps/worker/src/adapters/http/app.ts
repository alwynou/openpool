import type {
  ApiEnvelope,
  ApiError,
  DeploymentReadinessError,
  DeploymentReadinessIssueCode,
  HealthResponse,
} from '@openpool/contracts';
import { Hono } from 'hono';

import {
  registerAuthRoutes,
  type AuthRouteDependencies,
} from './auth-routes';
import {
  registerAuditRoutes,
  type AuditRouteDependencies,
} from './audit-routes';
import {
  registerApiKeyRoutes,
  type ApiKeyRouteDependencies,
} from './api-key-routes';
import {
  registerBucketRoutes,
  type BucketRouteDependencies,
} from './bucket-routes';
import {
  registerObjectRoutes,
  type ObjectRouteDependencies,
} from './object-routes';
import {
  registerStorageAccountRoutes,
  type StorageAccountRouteDependencies,
} from './storage-account-routes';
import {
  registerShardMigrationRoutes,
  type ShardMigrationRouteDependencies,
} from './shard-migration-routes';
import type { AppEnvironment } from './types';

const CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function requestIdFor(request: Request): string {
  const provided = request.headers.get('x-request-id');
  return provided !== null && CLIENT_REQUEST_ID.test(provided)
    ? provided
    : crypto.randomUUID();
}

export type HttpAppDependencies = AuthRouteDependencies &
  ApiKeyRouteDependencies &
  AuditRouteDependencies &
  StorageAccountRouteDependencies &
  BucketRouteDependencies &
  ObjectRouteDependencies &
  ShardMigrationRouteDependencies & {
    readonly inspectDeploymentConfiguration: (
      env: AppEnvironment['Bindings'],
    ) => readonly DeploymentReadinessIssueCode[];
    readonly checkDeploymentReadiness: (
      env: AppEnvironment['Bindings'],
    ) => Promise<readonly DeploymentReadinessIssueCode[]>;
  };

function deploymentNotReady(
  requestId: string,
  issues: readonly DeploymentReadinessIssueCode[],
): DeploymentReadinessError {
  return {
    error: {
      code: 'DEPLOYMENT_NOT_READY',
      message: 'OpenPool deployment configuration is not ready.',
      issues,
    },
    requestId,
  };
}

export function createHttpApp(
  dependencies: HttpAppDependencies,
): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();

  app.use('/api/*', async (context, next) => {
    const requestId = requestIdFor(context.req.raw);
    context.set('requestId', requestId);
    await next();
    context.header('x-request-id', requestId);
  });

  app.use('/api/*', async (context, next) => {
    if (context.req.path === '/api/v1/health') return next();
    const issues = dependencies.inspectDeploymentConfiguration(context.env);
    if (issues.length > 0) {
      return context.json(
        deploymentNotReady(context.get('requestId'), issues),
        503,
      );
    }
    return next();
  });

  app.get('/api/v1/health', async (context) => {
    const requestId = context.get('requestId');
    const issues = await dependencies.checkDeploymentReadiness(context.env);
    if (issues.length > 0) {
      return context.json(deploymentNotReady(requestId, issues), 503);
    }
    const health: HealthResponse = {
      name: 'openpool',
      status: 'ok',
      version: context.env.APP_VERSION,
      environment: context.env.APP_ENV,
    };
    const response: ApiEnvelope<HealthResponse> = {
      data: health,
      requestId,
    };

    return context.json(response);
  });

  registerAuthRoutes(app, dependencies);
  registerApiKeyRoutes(app, dependencies);
  registerAuditRoutes(app, dependencies);
  registerStorageAccountRoutes(app, dependencies);
  registerBucketRoutes(app, dependencies);
  registerObjectRoutes(app, dependencies);
  registerShardMigrationRoutes(app, dependencies);

  app.notFound((context) => {
    const response: ApiError = {
      error: {
        code: 'NOT_FOUND',
        message: 'The requested API route does not exist.',
      },
      requestId: context.get('requestId') ?? crypto.randomUUID(),
    };

    return context.json(response, 404);
  });

  app.onError((error, context) => {
    console.error('Unhandled request error', {
      requestId: context.get('requestId'),
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });

    const response: ApiError = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
      requestId: context.get('requestId') ?? crypto.randomUUID(),
    };

    return context.json(response, 500);
  });

  return app;
}
