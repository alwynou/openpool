import type {
  ApiEnvelope,
  ApiError,
  HealthResponse,
} from '@openpool/contracts';
import { Hono } from 'hono';

import {
  registerAuthRoutes,
  type AuthRouteDependencies,
} from './auth-routes';
import type { AppEnvironment } from './types';

export function createHttpApp(
  dependencies: AuthRouteDependencies,
): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();

  app.use('/api/*', async (context, next) => {
    const requestId = context.req.header('x-request-id') ?? crypto.randomUUID();
    context.set('requestId', requestId);
    await next();
    context.header('x-request-id', requestId);
  });

  app.get('/api/v1/health', (context) => {
    const health: HealthResponse = {
      name: 'openpool',
      status: 'ok',
      version: context.env.APP_VERSION,
      environment: context.env.APP_ENV,
    };
    const response: ApiEnvelope<HealthResponse> = {
      data: health,
      requestId: context.get('requestId'),
    };

    return context.json(response);
  });

  registerAuthRoutes(app, dependencies);

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
