import { env } from 'cloudflare:workers';
import {
  applyD1Migrations,
  createExecutionContext,
  type D1Migration,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CredentialPayload,
  StorageProvider,
} from '@openpool/application';

import { WebCryptoPasswordHasher } from '../src/adapters/auth';
import { WebCryptoCredentialVault } from '../src/adapters/crypto';
import { createWorker } from '../src/composition/root';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

const capabilities = {
  presignedUpload: true,
  presignedDownload: true,
  headObject: true,
  deleteObject: true,
  bucketProbe: true,
  usageProbe: false,
} as const;

const validate = vi.fn(
  async (_credentials: CredentialPayload): Promise<{ capabilities: typeof capabilities }> => {
    return { capabilities };
  },
);

const provider: StorageProvider = {
  capabilities,
  createUploadUrl: vi.fn(async () => ({
    url: 'https://provider.test/upload',
    expiresAt: '2026-09-01T00:15:00.000Z',
  })),
  validate,
  probe: vi.fn(async () => ({
    healthStatus: 'HEALTHY',
    capacityBytes: null,
    usedBytes: null,
    capacityAccuracy: 'UNKNOWN',
  })),
};

const testEnv = env as unknown as TestEnv;
const worker = createWorker({
  passwordHasher: new WebCryptoPasswordHasher({ iterations: 1_000 }),
  credentialVault: new WebCryptoCredentialVault({
    masterKey: new Uint8Array(32).fill(7),
    keyId: 'test-key',
  }),
  providerRegistry: { forAccount: () => provider },
});

async function dispatch(path: string, init?: RequestInit): Promise<Response> {
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
  method: 'POST' | 'PATCH',
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return dispatch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

async function administratorCookie(): Promise<string> {
  const setup = await dispatch('/api/v1/setup', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-openpool-bootstrap-token': 'test-bootstrap-token',
    },
    body: JSON.stringify({
      username: 'administrator',
      password: 'correct horse battery staple',
    }),
  });
  expect(setup.status).toBe(201);

  const login = await jsonRequest('/api/v1/auth/login', 'POST', {
    username: 'administrator',
    password: 'correct horse battery staple',
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Login did not return a session cookie');
  return cookie;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM audit_logs'),
    testEnv.DB.prepare('DELETE FROM auth_sessions'),
    testEnv.DB.prepare('DELETE FROM administrators'),
    testEnv.DB.prepare('DELETE FROM storage_accounts'),
  ]);
});

describe('storage account composition', () => {
  it('encrypts credentials, verifies an R2 account, lists it, and transitions it', async () => {
    const cookie = await administratorCookie();
    const created = await jsonRequest(
      '/api/v1/storage-accounts',
      'POST',
      {
        name: 'Primary R2',
        provider: 'r2',
        providerConfig: {
          accountId: 'account-123',
          validationBucket: 'validation-bucket',
        },
        credentials: {
          accessKeyId: 'r2-access-key',
          secretAccessKey: 'r2-secret-key',
        },
        capacityBytes: 1_000,
      },
      cookie,
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<{
      data: { id: string; status: string };
    }>();
    expect(createdBody.data.status).toBe('VERIFYING');
    expect(JSON.stringify(createdBody)).not.toContain('r2-secret-key');
    expect(JSON.stringify(createdBody)).not.toContain('credentialEnvelope');

    const stored = await testEnv.DB.prepare(
      'SELECT credential_envelope FROM storage_accounts WHERE id = ?',
    )
      .bind(createdBody.data.id)
      .first<{ credential_envelope: string }>();
    expect(stored?.credential_envelope).toContain('AES-256-GCM');
    expect(stored?.credential_envelope).not.toContain('r2-secret-key');

    const verified = await dispatch(
      `/api/v1/storage-accounts/${createdBody.data.id}/verify`,
      { method: 'POST', headers: { cookie } },
    );
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      data: {
        status: 'ACTIVE',
        writeEnabled: true,
        healthStatus: 'HEALTHY',
        capacityBytes: 1_000,
        capacityAccuracy: 'CONFIGURED',
        capabilities,
      },
    });
    expect(validate).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledWith(
      {
        accessKeyId: 'r2-access-key',
        secretAccessKey: 'r2-secret-key',
      },
      {
        accountId: 'account-123',
        validationBucket: 'validation-bucket',
      },
    );

    const listed = await dispatch('/api/v1/storage-accounts', {
      headers: { cookie },
    });
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).toContain('Primary R2');
    expect(listedText).not.toContain('r2-secret-key');
    expect(listedText).not.toContain('credentialEnvelope');

    const draining = await jsonRequest(
      `/api/v1/storage-accounts/${createdBody.data.id}/status`,
      'PATCH',
      { status: 'DRAINING' },
      cookie,
    );
    expect(draining.status).toBe(200);
    expect(await draining.json()).toMatchObject({
      data: { status: 'DRAINING', writeEnabled: false },
    });

    const audits = await testEnv.DB.prepare(
      `SELECT action FROM audit_logs
       WHERE resource_type = 'STORAGE_ACCOUNT'
       ORDER BY created_at, rowid`,
    ).all<{ action: string }>();
    expect(audits.results.map(({ action }) => action)).toEqual([
      'STORAGE_ACCOUNT_CREATED',
      'STORAGE_ACCOUNT_VERIFIED',
      'STORAGE_ACCOUNT_STATUS_CHANGED',
    ]);
  });

  it('corrects encrypted credentials and provider configuration before verification', async () => {
    const cookie = await administratorCookie();
    const created = await jsonRequest(
      '/api/v1/storage-accounts',
      'POST',
      {
        name: 'Correctable R2',
        provider: 'r2',
        providerConfig: {
          accountId: 'wrong-account',
          validationBucket: 'wrong-bucket',
        },
        credentials: {
          accessKeyId: 'wrong-access-key',
          secretAccessKey: 'wrong-secret-key',
        },
        capacityBytes: 1_000,
      },
      cookie,
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<{
      data: { id: string; updatedAt: string };
    }>();

    const corrected = await jsonRequest(
      `/api/v1/storage-accounts/${createdBody.data.id}/configuration`,
      'PATCH',
      {
        providerConfig: {
          accountId: 'correct-account',
          validationBucket: 'correct-bucket',
        },
        credentials: {
          accessKeyId: 'correct-access-key',
          secretAccessKey: 'correct-secret-key',
        },
        expectedUpdatedAt: createdBody.data.updatedAt,
      },
      cookie,
    );
    expect(corrected.status).toBe(200);
    const correctedBody = await corrected.json<{
      data: { updatedAt: string; providerConfig: Record<string, string> };
    }>();
    expect(correctedBody.data.providerConfig).toEqual({
      accountId: 'correct-account',
      validationBucket: 'correct-bucket',
    });
    expect(correctedBody.data.updatedAt).not.toBe(createdBody.data.updatedAt);
    expect(JSON.stringify(correctedBody)).not.toContain('correct-secret-key');

    const stored = await testEnv.DB.prepare(
      'SELECT credential_envelope FROM storage_accounts WHERE id = ?',
    )
      .bind(createdBody.data.id)
      .first<{ credential_envelope: string }>();
    expect(stored?.credential_envelope).not.toContain('wrong-secret-key');
    expect(stored?.credential_envelope).not.toContain('correct-secret-key');

    const stale = await jsonRequest(
      `/api/v1/storage-accounts/${createdBody.data.id}/configuration`,
      'PATCH',
      {
        providerConfig: { validationBucket: 'stale-bucket' },
        expectedUpdatedAt: createdBody.data.updatedAt,
      },
      cookie,
    );
    expect(stale.status).toBe(409);

    const verified = await dispatch(
      `/api/v1/storage-accounts/${createdBody.data.id}/verify`,
      { method: 'POST', headers: { cookie } },
    );
    expect(verified.status).toBe(200);
    expect(validate).toHaveBeenCalledWith(
      {
        accessKeyId: 'correct-access-key',
        secretAccessKey: 'correct-secret-key',
      },
      {
        accountId: 'correct-account',
        validationBucket: 'correct-bucket',
      },
    );

    const audits = await testEnv.DB.prepare(
      `SELECT action FROM audit_logs
       WHERE resource_type = 'STORAGE_ACCOUNT'
       ORDER BY created_at, rowid`,
    ).all<{ action: string }>();
    expect(audits.results.map(({ action }) => action)).toEqual([
      'STORAGE_ACCOUNT_CREATED',
      'STORAGE_ACCOUNT_CONFIGURATION_UPDATED',
      'STORAGE_ACCOUNT_VERIFIED',
    ]);
  });
});
