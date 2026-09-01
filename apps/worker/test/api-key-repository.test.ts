import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApiKeyRecord } from '@openpool/application';
import { D1ApiKeyRepository } from '../src/adapters/d1';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;
const repository = new D1ApiKeyRepository(testEnv.DB);

function apiKey(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'api-key-1',
    name: 'Automation',
    keyPrefix: 'opk_ABCDEFGH',
    keyHash: `hmac-sha256$v=1$${'A'.repeat(43)}`,
    scopes: ['objects:list', 'objects:read'],
    logicalBucketId: null,
    pathPrefix: 'documents/',
    expiresAt: '2027-09-01T00:00:00.000Z',
    revokedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.prepare('DELETE FROM api_keys').run();
});

describe('API key D1 repository', () => {
  it('round-trips strict metadata and finds by id or hash', async () => {
    const original = apiKey();
    expect(await repository.create(original)).toBe(true);
    expect(await repository.findById(original.id)).toEqual(original);
    expect(await repository.findByKeyHash(original.keyHash)).toEqual(original);
    expect(await repository.findById('missing')).toBeUndefined();
    expect(await repository.findByKeyHash(`hmac-sha256$v=1$${'Z'.repeat(43)}`))
      .toBeUndefined();
  });

  it('returns false for duplicate ids or hashes', async () => {
    expect(await repository.create(apiKey())).toBe(true);
    expect(
      await repository.create(
        apiKey({
          name: 'Duplicate id',
          keyHash: `hmac-sha256$v=1$${'B'.repeat(43)}`,
        }),
      ),
    ).toBe(false);
    expect(
      await repository.create(
        apiKey({ id: 'api-key-2', name: 'Duplicate hash' }),
      ),
    ).toBe(false);
    expect(await repository.list()).toHaveLength(1);
  });

  it('lists by creation time and id for stable pagination order', async () => {
    const later = apiKey({
      id: 'api-key-z',
      name: 'Later',
      keyPrefix: 'opk_ZZZZZZZZ',
      keyHash: `hmac-sha256$v=1$${'Z'.repeat(43)}`,
      createdAt: '2026-09-02T00:00:00.000Z',
    });
    const sameTimeB = apiKey({
      id: 'api-key-b',
      name: 'Second',
      keyPrefix: 'opk_BBBBBBBB',
      keyHash: `hmac-sha256$v=1$${'B'.repeat(43)}`,
    });
    const sameTimeA = apiKey({
      id: 'api-key-a',
      name: 'First',
      keyPrefix: 'opk_CCCCCCCC',
      keyHash: `hmac-sha256$v=1$${'C'.repeat(43)}`,
    });
    expect(await repository.create(later)).toBe(true);
    expect(await repository.create(sameTimeB)).toBe(true);
    expect(await repository.create(sameTimeA)).toBe(true);

    expect((await repository.list()).map(({ id }) => id)).toEqual([
      'api-key-a',
      'api-key-b',
      'api-key-z',
    ]);
  });

  it('conditionally revokes once and preserves the first timestamp', async () => {
    expect(await repository.create(apiKey())).toBe(true);
    const firstRevocation = '2026-09-01T01:00:00.000Z';
    expect(await repository.revoke('api-key-1', firstRevocation)).toBe(true);
    expect(
      await repository.revoke('api-key-1', '2026-09-01T02:00:00.000Z'),
    ).toBe(false);
    expect((await repository.findById('api-key-1'))?.revokedAt).toBe(
      firstRevocation,
    );
    expect(await repository.revoke('missing', firstRevocation)).toBe(false);
  });

  it('fails closed for malformed or unsupported persisted scopes', async () => {
    expect(await repository.create(apiKey())).toBe(true);
    await testEnv.DB.prepare("UPDATE api_keys SET scopes = '{' WHERE id = ?")
      .bind('api-key-1')
      .run();
    await expect(repository.findById('api-key-1')).rejects.toThrow(
      'Invalid API key scopes',
    );

    await testEnv.DB.prepare(
      `UPDATE api_keys SET scopes = '["objects:admin"]' WHERE id = ?`,
    )
      .bind('api-key-1')
      .run();
    await expect(repository.findById('api-key-1')).rejects.toThrow(
      'Invalid API key scopes',
    );
  });

  it('persists only the display prefix and hash, never a raw token', async () => {
    const rawToken = `opk_${'s'.repeat(43)}`;
    expect(await repository.create(apiKey())).toBe(true);
    const persisted = await testEnv.DB.prepare(
      `SELECT id, name, key_prefix, key_hash, scopes, logical_bucket_id,
              path_prefix, expires_at, revoked_at, created_at
       FROM api_keys WHERE id = ?`,
    )
      .bind('api-key-1')
      .first<Record<string, unknown>>();
    expect(JSON.stringify(persisted)).not.toContain(rawToken);
    expect(persisted).toMatchObject({
      key_prefix: 'opk_ABCDEFGH',
      key_hash: `hmac-sha256$v=1$${'A'.repeat(43)}`,
    });
  });
});
