import { describe, expect, it } from 'vitest';

import {
  authorizesApiKey,
  isApiKeyActive,
  validateApiKeyExpiration,
  validateApiKeyName,
  validateApiKeyRestrictions,
  validateApiKeyScopes,
  type ApiKey,
  type ApiKeyScope,
} from './api-key';

const now = new Date('2026-09-01T00:00:00.000Z');

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'api-key-1',
    name: 'automation',
    keyPrefix: 'opk_test',
    scopes: ['objects:list', 'objects:read'],
    logicalBucketId: null,
    pathPrefix: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: now.toISOString(),
    ...overrides,
  };
}

describe('API key validation', () => {
  it('accepts the supported V1 object scopes', () => {
    expect(() =>
      validateApiKeyScopes([
        'objects:list',
        'objects:read',
        'objects:upload',
        'objects:delete',
      ]),
    ).not.toThrow();
  });

  it('rejects empty, duplicate, and unknown scopes', () => {
    expect(() => validateApiKeyScopes([])).toThrow(RangeError);
    expect(() =>
      validateApiKeyScopes(['objects:read', 'objects:read']),
    ).toThrow(RangeError);
    expect(() =>
      validateApiKeyScopes(['objects:admin' as ApiKeyScope]),
    ).toThrow(RangeError);
  });

  it('rejects invalid names and restrictions', () => {
    expect(() => validateApiKeyName('')).toThrow(RangeError);
    expect(() => validateApiKeyName('bad\nname')).toThrow(RangeError);
    expect(() => validateApiKeyRestrictions('', null)).toThrow(RangeError);
    expect(() => validateApiKeyRestrictions(null, '')).toThrow(RangeError);
    expect(() => validateApiKeyRestrictions(null, 'bad\0prefix')).toThrow(
      RangeError,
    );
  });

  it('requires a canonical future expiration', () => {
    expect(() =>
      validateApiKeyExpiration('2026-09-02T00:00:00.000Z', now),
    ).not.toThrow();
    expect(() => validateApiKeyExpiration(now.toISOString(), now)).toThrow(
      RangeError,
    );
    expect(() =>
      validateApiKeyExpiration('2026-09-02T00:00:00Z', now),
    ).toThrow(RangeError);
    expect(() => validateApiKeyExpiration('not-a-date', now)).toThrow(
      RangeError,
    );
  });
});

describe('API key authorization', () => {
  it('requires the requested scope', () => {
    expect(
      authorizesApiKey(
        apiKey(),
        { action: 'objects:read', logicalBucketId: 'bucket-1' },
        now,
      ),
    ).toBe(true);
    expect(
      authorizesApiKey(
        apiKey(),
        { action: 'objects:delete', logicalBucketId: 'bucket-1' },
        now,
      ),
    ).toBe(false);
  });

  it('enforces logical bucket and literal path prefix boundaries', () => {
    const restricted = apiKey({
      logicalBucketId: 'bucket-1',
      pathPrefix: 'tenants/alwyn/',
    });

    expect(
      authorizesApiKey(
        restricted,
        {
          action: 'objects:read',
          logicalBucketId: 'bucket-1',
          logicalKey: 'tenants/alwyn/photo.jpg',
        },
        now,
      ),
    ).toBe(true);
    expect(
      authorizesApiKey(
        restricted,
        {
          action: 'objects:read',
          logicalBucketId: 'bucket-2',
          logicalKey: 'tenants/alwyn/photo.jpg',
        },
        now,
      ),
    ).toBe(false);
    expect(
      authorizesApiKey(
        restricted,
        {
          action: 'objects:read',
          logicalBucketId: 'bucket-1',
          logicalKey: 'tenants/alwyn2/photo.jpg',
        },
        now,
      ),
    ).toBe(false);
    expect(
      authorizesApiKey(
        restricted,
        { action: 'objects:list', logicalBucketId: 'bucket-1' },
        now,
      ),
    ).toBe(false);
  });

  it('applies a path-only restriction across logical buckets', () => {
    const restricted = apiKey({ pathPrefix: 'public/' });

    for (const logicalBucketId of ['bucket-1', 'bucket-2']) {
      expect(
        authorizesApiKey(
          restricted,
          {
            action: 'objects:read',
            logicalBucketId,
            logicalKey: 'public/file.txt',
          },
          now,
        ),
      ).toBe(true);
    }
  });

  it('fails closed for revoked, expired, and malformed expiration values', () => {
    expect(isApiKeyActive(apiKey({ revokedAt: now.toISOString() }), now)).toBe(
      false,
    );
    expect(isApiKeyActive(apiKey({ expiresAt: now.toISOString() }), now)).toBe(
      false,
    );
    expect(isApiKeyActive(apiKey({ expiresAt: 'invalid' }), now)).toBe(false);
    expect(
      isApiKeyActive(apiKey({ expiresAt: '2026-09-02T00:00:00Z' }), now),
    ).toBe(false);
  });
});
