import { env } from 'cloudflare:workers';
import {
  applyD1Migrations,
  createExecutionContext,
  type D1Migration,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { WebCryptoPasswordHasher } from '../src/adapters/auth';
import { createWorker } from '../src/composition/root';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;
const worker = createWorker({
  passwordHasher: new WebCryptoPasswordHasher({ iterations: 1_000 }),
});

async function dispatch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://openpool.test${path}`, init),
    testEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function jsonRequest(
  path: string,
  body: unknown,
  headers: HeadersInit = {},
): Promise<Response> {
  return dispatch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function initializeAdministrator(): Promise<Response> {
  return jsonRequest(
    '/api/v1/setup',
    {
      username: 'administrator',
      password: 'correct horse battery staple',
    },
    { 'x-openpool-bootstrap-token': 'test-bootstrap-token' },
  );
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM auth_sessions'),
    testEnv.DB.prepare('DELETE FROM audit_logs'),
    testEnv.DB.prepare('DELETE FROM administrators'),
  ]);
});

describe('authentication HTTP API', () => {
  it('accepts only bounded safe client request IDs', async () => {
    const accepted = await dispatch('/api/v1/health', {
      headers: { 'x-request-id': 'client.trace-1:attempt_2' },
    });
    expect(accepted.headers.get('x-request-id')).toBe(
      'client.trace-1:attempt_2',
    );

    const rejected = await dispatch('/api/v1/health', {
      headers: { 'x-request-id': 'x'.repeat(129) },
    });
    const generated = rejected.headers.get('x-request-id');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/u);
    expect(generated).not.toBe('x'.repeat(129));
  });

  it('rejects non-JSON, oversized, and extra authentication fields', async () => {
    const nonJson = await dispatch('/api/v1/setup', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-openpool-bootstrap-token': 'test-bootstrap-token',
      },
      body: JSON.stringify({
        username: 'administrator',
        password: 'correct horse battery staple',
      }),
    });
    expect(nonJson.status).toBe(400);

    const oversized = await jsonRequest(
      '/api/v1/setup',
      {
        username: 'administrator',
        password: 'x'.repeat(64 * 1024),
      },
      { 'x-openpool-bootstrap-token': 'test-bootstrap-token' },
    );
    expect(oversized.status).toBe(400);

    const extra = await jsonRequest(
      '/api/v1/setup',
      {
        username: 'administrator',
        password: 'correct horse battery staple',
        role: 'superuser',
      },
      { 'x-openpool-bootstrap-token': 'test-bootstrap-token' },
    );
    expect(extra.status).toBe(400);
  });

  it('reports setup state and protects one-time initialization', async () => {
    const initialStatus = await dispatch('/api/v1/setup/status');
    expect(initialStatus.status).toBe(200);
    expect(initialStatus.headers.get('cache-control')).toBe('no-store');
    expect(await initialStatus.json()).toMatchObject({
      data: { initialized: false },
    });

    const unauthorized = await jsonRequest(
      '/api/v1/setup',
      {
        username: 'administrator',
        password: 'correct horse battery staple',
      },
      { 'x-openpool-bootstrap-token': 'wrong-token' },
    );
    expect(unauthorized.status).toBe(403);
    expect(await unauthorized.json()).toMatchObject({
      error: { code: 'INVALID_BOOTSTRAP_TOKEN' },
    });

    const initialized = await initializeAdministrator();
    expect(initialized.status).toBe(201);
    const initializedBody = await initialized.json();
    expect(initializedBody).toMatchObject({
      data: { username: 'administrator', status: 'ACTIVE' },
    });
    expect(JSON.stringify(initializedBody)).not.toContain('passwordHash');
    expect(JSON.stringify(initializedBody)).not.toContain(
      'correct horse battery staple',
    );

    const stored = await testEnv.DB.prepare(
      'SELECT password_hash FROM administrators LIMIT 1',
    ).first<{ password_hash: string }>();
    expect(stored?.password_hash).toMatch(/^pbkdf2-sha256\$v=1\$/u);

    const duplicate = await initializeAdministrator();
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: { code: 'ALREADY_INITIALIZED' },
    });
  });

  it('allows only one concurrent administrator initialization', async () => {
    const responses = await Promise.all([
      initializeAdministrator(),
      initializeAdministrator(),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    const count = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS count FROM administrators',
    ).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it('creates only hashed server sessions and revokes them on logout', async () => {
    await initializeAdministrator();

    const invalid = await jsonRequest('/api/v1/auth/login', {
      username: 'administrator',
      password: 'incorrect password',
    });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toMatchObject({
      error: { code: 'INVALID_CREDENTIALS' },
    });

    const login = await jsonRequest('/api/v1/auth/login', {
      username: 'administrator',
      password: 'correct horse battery staple',
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toContain('openpool_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(JSON.stringify(await login.json())).not.toContain(
      'correct horse battery staple',
    );

    const token = cookie?.match(/openpool_session=([^;]+)/u)?.[1];
    expect(token).toBeTruthy();
    const storedSession = await testEnv.DB.prepare(
      'SELECT token_hash FROM auth_sessions LIMIT 1',
    ).first<{ token_hash: string }>();
    expect(storedSession?.token_hash).not.toBe(token);

    const session = await dispatch('/api/v1/auth/session', {
      headers: { cookie: `openpool_session=${token}` },
    });
    expect(await session.json()).toMatchObject({
      data: {
        authenticated: true,
        administrator: { username: 'administrator' },
      },
    });

    const logout = await dispatch('/api/v1/auth/session', {
      method: 'DELETE',
      headers: { cookie: `openpool_session=${token}` },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');

    const revoked = await dispatch('/api/v1/auth/session', {
      headers: { cookie: `openpool_session=${token}` },
    });
    expect(await revoked.json()).toMatchObject({
      data: { authenticated: false, administrator: null },
    });

    const audits = await testEnv.DB.prepare(
      'SELECT action, request_id FROM audit_logs ORDER BY created_at',
    ).all<{ action: string; request_id: string | null }>();
    expect(audits.results.map(({ action }) => action)).toEqual([
      'ADMINISTRATOR_INITIALIZED',
      'LOGIN',
      'LOGOUT',
    ]);
    expect(audits.results.every(({ request_id }) => request_id)).toBe(true);
  });
});
