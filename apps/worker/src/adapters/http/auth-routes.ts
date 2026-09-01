import type {
  AuthenticateSession,
  GetSetupStatus,
  InitializeAdministrator,
  Login,
  Logout,
} from '@openpool/application';
import { AuthError } from '@openpool/application';
import type {
  AdministratorResponse,
  ApiEnvelope,
  ApiError,
  AuthErrorCode,
  InitializeAdminRequest,
  LoginRequest,
  LoginResponse,
  SessionResponse,
  SetupStatusResponse,
} from '@openpool/contracts';
import type { Administrator } from '@openpool/domain';
import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { Env } from '../../env';
import { readJsonBody } from './json-body';
import type { AppEnvironment } from './types';

const SESSION_COOKIE = 'openpool_session';

export interface AuthUseCases {
  readonly getSetupStatus: Pick<GetSetupStatus, 'execute'>;
  readonly initializeAdministrator: Pick<InitializeAdministrator, 'execute'>;
  readonly login: Pick<Login, 'execute'>;
  readonly authenticateSession: Pick<AuthenticateSession, 'execute'>;
  readonly logout: Pick<Logout, 'execute'>;
}

export interface AuthRouteDependencies {
  readonly createAuthUseCases: (
    env: Env,
    requestId: string,
  ) => AuthUseCases;
}

function administratorResponse(
  administrator: Administrator,
): AdministratorResponse {
  return {
    id: administrator.id,
    username: administrator.username,
    status: administrator.status,
    createdAt: administrator.createdAt,
    updatedAt: administrator.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parseCredentials(
  request: Request,
): Promise<InitializeAdminRequest | LoginRequest | undefined> {
  const value = await readJsonBody(request);
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'username') ||
    !Object.hasOwn(value, 'password') ||
    typeof value.username !== 'string' ||
    typeof value.password !== 'string'
  ) {
    return undefined;
  }
  return { username: value.username, password: value.password };
}

function authError(
  requestId: string,
  code: AuthErrorCode,
  message: string,
): ApiError<AuthErrorCode> {
  return { error: { code, message }, requestId };
}

function setSessionCookie(
  appEnvironment: Env,
  context: Parameters<typeof setCookie>[0],
  token: string,
  expiresAt: string,
): void {
  setCookie(context, SESSION_COOKIE, token, {
    expires: new Date(expiresAt),
    httpOnly: true,
    path: '/',
    priority: 'High',
    sameSite: 'Strict',
    secure: appEnvironment.APP_ENV !== 'development',
  });
}

function clearSessionCookie(
  appEnvironment: Env,
  context: Parameters<typeof deleteCookie>[0],
): void {
  deleteCookie(context, SESSION_COOKIE, {
    httpOnly: true,
    path: '/',
    sameSite: 'Strict',
    secure: appEnvironment.APP_ENV !== 'development',
  });
}

export function registerAuthRoutes(
  app: Hono<AppEnvironment>,
  dependencies: AuthRouteDependencies,
): void {
  app.use('/api/v1/setup/*', async (context, next) => {
    await next();
    context.header('cache-control', 'no-store');
  });
  app.use('/api/v1/auth/*', async (context, next) => {
    await next();
    context.header('cache-control', 'no-store');
  });

  app.get('/api/v1/setup/status', async (context) => {
    const requestId = context.get('requestId');
    const auth = dependencies.createAuthUseCases(context.env, requestId);
    const status = await auth.getSetupStatus.execute();
    const response: ApiEnvelope<SetupStatusResponse> = {
      data: status,
      requestId,
    };
    return context.json(response);
  });

  app.post('/api/v1/setup', async (context) => {
    const requestId = context.get('requestId');
    const credentials = await parseCredentials(context.req.raw);
    if (!credentials) {
      return context.json(
        authError(
          requestId,
          'VALIDATION_ERROR',
          'A username and password are required.',
        ),
        400,
      );
    }

    const auth = dependencies.createAuthUseCases(context.env, requestId);
    try {
      const result = await auth.initializeAdministrator.execute({
        ...credentials,
        bootstrapToken:
          context.req.header('x-openpool-bootstrap-token') ?? '',
      });
      const response: ApiEnvelope<AdministratorResponse> = {
        data: administratorResponse(result.administrator),
        requestId,
      };
      return context.json(response, 201);
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.code === 'BOOTSTRAP_UNAUTHORIZED') {
          return context.json(
            authError(
              requestId,
              'INVALID_BOOTSTRAP_TOKEN',
              'The bootstrap token is invalid.',
            ),
            403,
          );
        }
        if (error.code === 'ADMINISTRATOR_ALREADY_INITIALIZED') {
          return context.json(
            authError(
              requestId,
              'ALREADY_INITIALIZED',
              'OpenPool has already been initialized.',
            ),
            409,
          );
        }
        if (error.code === 'VALIDATION_FAILED') {
          return context.json(
            authError(
              requestId,
              'VALIDATION_ERROR',
              'Username must be 3-64 characters and password must be 12-256 characters.',
            ),
            400,
          );
        }
      }
      throw error;
    }
  });

  app.post('/api/v1/auth/login', async (context) => {
    const requestId = context.get('requestId');
    const credentials = await parseCredentials(context.req.raw);
    if (!credentials) {
      return context.json(
        authError(
          requestId,
          'INVALID_CREDENTIALS',
          'The username or password is invalid.',
        ),
        401,
      );
    }

    const auth = dependencies.createAuthUseCases(context.env, requestId);
    try {
      const result = await auth.login.execute(credentials);
      setSessionCookie(
        context.env,
        context,
        result.token,
        result.expiresAt,
      );
      const data: LoginResponse = {
        administrator: administratorResponse(result.administrator),
        expiresAt: result.expiresAt,
      };
      const response: ApiEnvelope<LoginResponse> = { data, requestId };
      return context.json(response);
    } catch (error) {
      if (
        error instanceof AuthError &&
        error.code === 'AUTHENTICATION_FAILED'
      ) {
        return context.json(
          authError(
            requestId,
            'INVALID_CREDENTIALS',
            'The username or password is invalid.',
          ),
          401,
        );
      }
      throw error;
    }
  });

  app.get('/api/v1/auth/session', async (context) => {
    const requestId = context.get('requestId');
    const token = getCookie(context, SESSION_COOKIE);
    const unauthenticated: ApiEnvelope<SessionResponse> = {
      data: {
        authenticated: false,
        administrator: null,
        expiresAt: null,
      },
      requestId,
    };

    if (!token) return context.json(unauthenticated);

    const auth = dependencies.createAuthUseCases(context.env, requestId);
    try {
      const result = await auth.authenticateSession.execute(token);
      const response: ApiEnvelope<SessionResponse> = {
        data: {
          authenticated: true,
          administrator: administratorResponse(result.administrator),
          expiresAt: result.expiresAt,
        },
        requestId,
      };
      return context.json(response);
    } catch (error) {
      if (error instanceof AuthError && error.code === 'SESSION_INVALID') {
        clearSessionCookie(context.env, context);
        return context.json(unauthenticated);
      }
      throw error;
    }
  });

  app.delete('/api/v1/auth/session', async (context) => {
    const requestId = context.get('requestId');
    const token = getCookie(context, SESSION_COOKIE);
    if (token) {
      const auth = dependencies.createAuthUseCases(context.env, requestId);
      await auth.logout.execute(token);
    }
    clearSessionCookie(context.env, context);
    return context.body(null, 204);
  });
}
