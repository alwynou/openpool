import { describe, expect, it } from 'vitest';

import type { ApiKey, ApiKeyScope } from '@openpool/domain';

import type {
  ApiKeyGenerator,
  ApiKeyHasher,
  ApiKeyRecord,
  ApiKeyRepository,
} from '../ports/api-key';
import type { AuditLog, AuditLogEntry } from '../ports/auth';
import type {
  Clock,
  IdGenerator,
  LogicalBucketRepository,
} from '../ports/storage';
import {
  ApiKeyApplicationError,
  AuthenticateApiKey,
  AuthorizeApiKey,
  CreateApiKey,
  ListApiKeys,
  RevokeApiKey,
} from './api-keys';

const now = new Date('2026-09-01T00:00:00.000Z');
const rawToken = 'opk_1234567890abcdefghijklmnopqrstuvwxyzABCD';

class FakeClock implements Clock {
  current = now;

  now(): Date {
    return new Date(this.current);
  }
}

class FakeIds implements IdGenerator {
  next(): string {
    return 'api-key-1';
  }
}

class FakeGenerator implements ApiKeyGenerator {
  generated = { rawToken, keyPrefix: 'opk_1234' };
  calls = 0;

  generate() {
    this.calls += 1;
    return this.generated;
  }
}

class FakeBuckets implements Pick<LogicalBucketRepository, 'findById'> {
  existing = new Set(['bucket-1']);

  async findById(id: string) {
    return this.existing.has(id)
      ? {
          id,
          name: id,
          description: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }
      : undefined;
  }
}

class FakeHasher implements ApiKeyHasher {
  readonly inputs: string[] = [];

  async hash(token: string): Promise<string> {
    this.inputs.push(token);
    return `peppered-hash-${token}`;
  }
}

class FakeApiKeys implements ApiKeyRepository {
  readonly values = new Map<string, ApiKeyRecord>();
  rejectCreate = false;
  rejectRevoke = false;

  async create(apiKey: ApiKeyRecord): Promise<boolean> {
    if (this.rejectCreate) {
      return false;
    }
    this.values.set(apiKey.id, apiKey);
    return true;
  }

  async list(): Promise<readonly ApiKeyRecord[]> {
    return [...this.values.values()];
  }

  async findById(id: string): Promise<ApiKeyRecord | undefined> {
    return this.values.get(id);
  }

  async findByKeyHash(keyHash: string): Promise<ApiKeyRecord | undefined> {
    return [...this.values.values()].find(
      (apiKey) => apiKey.keyHash === keyHash,
    );
  }

  async revoke(id: string, revokedAt: string): Promise<boolean> {
    const current = this.values.get(id);
    if (!current || current.revokedAt !== null || this.rejectRevoke) {
      return false;
    }
    this.values.set(id, { ...current, revokedAt });
    return true;
  }
}

class FakeAudit implements AuditLog {
  readonly entries: AuditLogEntry[] = [];

  async record(entry: AuditLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'api-key-1',
    name: 'automation',
    keyPrefix: 'opk_1234',
    keyHash: `peppered-hash-${rawToken}`,
    scopes: ['objects:list', 'objects:read'],
    logicalBucketId: null,
    pathPrefix: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: now.toISOString(),
    ...overrides,
  };
}

function createFixture() {
  const apiKeys = new FakeApiKeys();
  const generator = new FakeGenerator();
  const hasher = new FakeHasher();
  const clock = new FakeClock();
  const audit = new FakeAudit();
  const buckets = new FakeBuckets();
  const create = new CreateApiKey({
    apiKeys,
    generator,
    hasher,
    ids: new FakeIds(),
    clock,
    audit,
    buckets,
  });
  return { apiKeys, generator, hasher, clock, audit, buckets, create };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ApiKeyApplicationError);
  expect((error as ApiKeyApplicationError).code).toBe(code);
}

describe('CreateApiKey', () => {
  it('returns the raw token once and persists only prefix plus hash', async () => {
    const fixture = createFixture();
    const result = await fixture.create.execute({
      actorId: 'admin-1',
      name: '  upload automation  ',
      scopes: ['objects:upload'],
      logicalBucketId: 'bucket-1',
      pathPrefix: 'incoming/',
      expiresAt: '2026-09-02T00:00:00.000Z',
    });

    expect(result.token).toBe(rawToken);
    expect(result.apiKey).toEqual({
      id: 'api-key-1',
      name: 'upload automation',
      keyPrefix: 'opk_1234',
      scopes: ['objects:upload'],
      logicalBucketId: 'bucket-1',
      pathPrefix: 'incoming/',
      expiresAt: '2026-09-02T00:00:00.000Z',
      revokedAt: null,
      createdAt: now.toISOString(),
    });
    expect(result.apiKey).not.toHaveProperty('keyHash');
    expect(fixture.hasher.inputs).toEqual([rawToken]);
    expect(fixture.apiKeys.values.get('api-key-1')).toMatchObject({
      keyPrefix: 'opk_1234',
      keyHash: `peppered-hash-${rawToken}`,
    });
    expect(fixture.apiKeys.values.get('api-key-1')).not.toHaveProperty(
      'rawToken',
    );
    expect(fixture.audit.entries).toEqual([
      expect.objectContaining({
        actorType: 'ADMIN',
        actorId: 'admin-1',
        action: 'API_KEY_CREATED',
        resourceId: 'api-key-1',
      }),
    ]);
  });

  it.each([
    { name: '', scopes: ['objects:read'] as readonly ApiKeyScope[] },
    { name: 'bad\nname', scopes: ['objects:read'] as readonly ApiKeyScope[] },
    { name: 'read', scopes: [] as readonly ApiKeyScope[] },
    {
      name: 'read',
      scopes: ['objects:read', 'objects:read'] as readonly ApiKeyScope[],
    },
    {
      name: 'read',
      scopes: ['objects:unknown' as ApiKeyScope],
    },
  ])('rejects invalid name or scopes %#', async ({ name, scopes }) => {
    const fixture = createFixture();
    await expect(
      fixture.create.execute({ actorId: 'admin-1', name, scopes }),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'API_KEY_INVALID_INPUT');
      return true;
    });
    expect(fixture.apiKeys.values.size).toBe(0);
  });

  it('rejects empty restrictions and non-future expiration', async () => {
    const fixture = createFixture();
    for (const command of [
      { logicalBucketId: '' },
      { pathPrefix: '' },
      { expiresAt: now.toISOString() },
      { expiresAt: 'invalid' },
    ]) {
      await expect(
        fixture.create.execute({
          actorId: 'admin-1',
          name: 'read',
          scopes: ['objects:read'],
          ...command,
        }),
      ).rejects.toMatchObject({ code: 'API_KEY_INVALID_INPUT' });
    }
  });

  it('checks a bucket restriction before generating or hashing a token', async () => {
    const fixture = createFixture();

    await expect(
      fixture.create.execute({
        actorId: 'admin-1',
        name: 'read',
        scopes: ['objects:read'],
        logicalBucketId: 'missing-bucket',
      }),
    ).rejects.toMatchObject({ code: 'API_KEY_BUCKET_NOT_FOUND' });
    expect(fixture.generator.calls).toBe(0);
    expect(fixture.hasher.inputs).toEqual([]);
    expect(fixture.apiKeys.values.size).toBe(0);
  });

  it('uses a stable generic error that does not leak a generated token', async () => {
    const fixture = createFixture();
    fixture.apiKeys.rejectCreate = true;

    const error = await fixture.create
      .execute({
        actorId: 'admin-1',
        name: 'read',
        scopes: ['objects:read'],
      })
      .catch((caught: unknown) => caught);

    expectCode(error, 'API_KEY_CONFLICT');
    expect(String(error)).not.toContain(rawToken);
  });
});

describe('ListApiKeys', () => {
  it('never exposes hashes or raw tokens', async () => {
    const apiKeys = new FakeApiKeys();
    apiKeys.values.set('api-key-1', record());

    const result = await new ListApiKeys(apiKeys).execute();

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('keyHash');
    expect(result[0]).not.toHaveProperty('rawToken');
    expect(JSON.stringify(result)).not.toContain(rawToken);
  });
});

describe('RevokeApiKey', () => {
  it('revokes once, audits as the administrator, and is idempotent', async () => {
    const apiKeys = new FakeApiKeys();
    apiKeys.values.set('api-key-1', record());
    const clock = new FakeClock();
    const audit = new FakeAudit();
    const revoke = new RevokeApiKey({ apiKeys, clock, audit });

    const first = await revoke.execute({ actorId: 'admin-1', id: 'api-key-1' });
    const second = await revoke.execute({ actorId: 'admin-1', id: 'api-key-1' });

    expect(first.revokedAt).toBe(now.toISOString());
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty('keyHash');
    expect(audit.entries).toEqual([
      expect.objectContaining({
        actorType: 'ADMIN',
        actorId: 'admin-1',
        action: 'API_KEY_REVOKED',
      }),
    ]);
  });

  it('returns a stable not-found error', async () => {
    const revoke = new RevokeApiKey({
      apiKeys: new FakeApiKeys(),
      clock: new FakeClock(),
      audit: new FakeAudit(),
    });

    await expect(
      revoke.execute({ actorId: 'admin-1', id: 'missing' }),
    ).rejects.toMatchObject({ code: 'API_KEY_NOT_FOUND' });
  });
});

describe('AuthenticateApiKey', () => {
  function authenticator(apiKeys: FakeApiKeys, clock = new FakeClock()) {
    return new AuthenticateApiKey({
      apiKeys,
      hasher: new FakeHasher(),
      clock,
    });
  }

  it('accepts a Bearer token and returns only safe metadata', async () => {
    const apiKeys = new FakeApiKeys();
    apiKeys.values.set('api-key-1', record());

    const result = await authenticator(apiKeys).execute(`Bearer ${rawToken}`);

    expect(result.id).toBe('api-key-1');
    expect(result).not.toHaveProperty('keyHash');
    expect(result).not.toHaveProperty('rawToken');
  });

  it.each([
    ['bad bearer format', undefined],
    [`Bearer ${'x'.repeat(31)}`, undefined],
    [`Bearer ${rawToken}`, { revokedAt: now.toISOString() }],
    [`Bearer ${rawToken}`, { expiresAt: now.toISOString() }],
    [`Bearer ${rawToken}`, { expiresAt: 'malformed' }],
  ])('fails closed without leaking credentials: %s', async (authorization, override) => {
    const apiKeys = new FakeApiKeys();
    if (override) {
      apiKeys.values.set('api-key-1', record(override));
    }

    const error = await authenticator(apiKeys)
      .execute(authorization)
      .catch((caught: unknown) => caught);

    expectCode(error, 'API_KEY_AUTHENTICATION_FAILED');
    expect(String(error)).not.toContain(rawToken);
  });
});

describe('AuthorizeApiKey', () => {
  function safeKey(overrides: Partial<ApiKey> = {}): ApiKey {
    const { keyHash: _keyHash, ...safe } = record(overrides);
    return safe;
  }

  it('enforces scope, bucket, and path and audits the API key actor', async () => {
    const audit = new FakeAudit();
    const authorize = new AuthorizeApiKey({ clock: new FakeClock(), audit });
    const apiKey = safeKey({
      scopes: ['objects:read'],
      logicalBucketId: 'bucket-1',
      pathPrefix: 'public/',
    });

    await authorize.execute(apiKey, {
      action: 'objects:read',
      logicalBucketId: 'bucket-1',
      logicalKey: 'public/file.txt',
    });

    expect(audit.entries).toEqual([
      expect.objectContaining({
        actorType: 'API_KEY',
        actorId: 'api-key-1',
        action: 'API_KEY_AUTHORIZED',
        resourceId: 'bucket-1',
        metadata: { scope: 'objects:read' },
      }),
    ]);

    for (const authorization of [
      {
        action: 'objects:delete' as const,
        logicalBucketId: 'bucket-1',
        logicalKey: 'public/file.txt',
      },
      {
        action: 'objects:read' as const,
        logicalBucketId: 'bucket-2',
        logicalKey: 'public/file.txt',
      },
      {
        action: 'objects:read' as const,
        logicalBucketId: 'bucket-1',
        logicalKey: 'private/file.txt',
      },
    ]) {
      await expect(
        authorize.execute(apiKey, authorization),
      ).rejects.toMatchObject({ code: 'API_KEY_FORBIDDEN' });
    }
  });

  it('fails closed when a key is revoked or expires between authentication and use', async () => {
    const authorize = new AuthorizeApiKey({
      clock: new FakeClock(),
      audit: new FakeAudit(),
    });

    for (const apiKey of [
      safeKey({ revokedAt: now.toISOString() }),
      safeKey({ expiresAt: now.toISOString() }),
    ]) {
      await expect(
        authorize.execute(apiKey, {
          action: 'objects:read',
          logicalBucketId: 'bucket-1',
        }),
      ).rejects.toMatchObject({ code: 'API_KEY_FORBIDDEN' });
    }
  });
});
