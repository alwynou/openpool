import { env } from 'cloudflare:workers';
import {
  applyD1Migrations,
  createExecutionContext,
  type D1Migration,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import worker from '../src';
import { inspectStaticDeploymentConfiguration } from '../src/composition/deployment-preflight';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;

async function dispatch(
  requestEnv: Env = testEnv,
  path = '/api/v1/health',
): Promise<Response> {
  const request = new Request(`https://openpool.test${path}`);
  const executionContext = createExecutionContext();
  const response = await worker.fetch(request, requestEnv, executionContext);
  await waitOnExecutionContext(executionContext);
  return response;
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.prepare('DELETE FROM administrators').run();
});

describe('health endpoint', () => {
  it('detects secret reuse, unsafe key IDs, and missing rate-limit bindings', () => {
    expect(
      inspectStaticDeploymentConfiguration({
        ...testEnv,
        API_KEY_PEPPER: testEnv.CREDENTIAL_MASTER_KEY,
        CREDENTIAL_MASTER_KEY_ID: 'unsafe key id',
        AUTH_IDENTITY_RATE_LIMITER: undefined,
      }),
    ).toEqual([
      'CREDENTIAL_MASTER_KEY_ID_INVALID',
      'CRYPTO_SECRET_REUSE_DETECTED',
      'AUTH_RATE_LIMITERS_MISSING',
    ]);
  });

  it('reports the Worker as healthy', async () => {
    const response = await dispatch();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { name: 'openpool', status: 'ok' },
    });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('reports safe issue codes and no secret values when configuration is invalid', async () => {
    const invalidEnv: Env = {
      ...testEnv,
      CREDENTIAL_MASTER_KEY: 'invalid-master-key',
      API_KEY_PEPPER: undefined,
    };
    const response = await dispatch(invalidEnv);

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: 'DEPLOYMENT_NOT_READY',
        issues: [
          'CREDENTIAL_MASTER_KEY_INVALID',
          'API_KEY_PEPPER_MISSING',
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain('invalid-master-key');

    const gated = await dispatch(invalidEnv, '/api/v1/setup/status');
    expect(gated.status).toBe(503);
    expect(await gated.json()).toMatchObject({
      error: { code: 'DEPLOYMENT_NOT_READY' },
    });
  });

  it('requires bootstrap only before initialization and rejects it afterward outside development', async () => {
    const missing = await dispatch({
      ...testEnv,
      ADMIN_BOOTSTRAP_TOKEN: undefined,
    });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({
      error: { issues: ['ADMIN_BOOTSTRAP_TOKEN_MISSING'] },
    });

    await testEnv.DB.prepare(
      `INSERT INTO administrators (
        id, username, password_hash, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    )
      .bind(
        'admin-1',
        'administrator',
        'not-used-by-readiness',
        '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z',
      )
      .run();

    const unexpected = await dispatch({ ...testEnv, APP_ENV: 'staging' });
    expect(unexpected.status).toBe(503);
    expect(await unexpected.json()).toMatchObject({
      error: { issues: ['ADMIN_BOOTSTRAP_TOKEN_UNEXPECTED'] },
    });

    const ready = await dispatch({
      ...testEnv,
      APP_ENV: 'staging',
      ADMIN_BOOTSTRAP_TOKEN: undefined,
    });
    expect(ready.status).toBe(200);
  });
});
