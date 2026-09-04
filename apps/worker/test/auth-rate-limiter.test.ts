import { describe, expect, it, vi } from 'vitest';

import { CloudflareAuthAttemptRateLimiter } from '../src/adapters/http/auth-rate-limiter';

function binding(success = true): RateLimit & {
  readonly limit: ReturnType<typeof vi.fn>;
} {
  return {
    limit: vi.fn(async () => ({ success })),
  };
}

describe('Cloudflare authentication rate limiter', () => {
  it('checks the route ceiling before a hashed identity key', async () => {
    const global = binding();
    const identity = binding();
    const limiter = new CloudflareAuthAttemptRateLimiter(global, identity);

    await expect(
      limiter.allow({ kind: 'login', username: ' administrator ' }),
    ).resolves.toBe(true);

    expect(global.limit).toHaveBeenCalledWith({ key: 'auth:login:global' });
    const identityKey = identity.limit.mock.calls[0]?.[0]?.key as string;
    expect(identityKey).toMatch(/^auth:login:identity:[a-f0-9]{64}$/u);
    expect(identityKey).not.toContain('administrator');
  });

  it('does not consume the identity limit after the route ceiling rejects', async () => {
    const global = binding(false);
    const identity = binding();
    const limiter = new CloudflareAuthAttemptRateLimiter(global, identity);

    await expect(
      limiter.allow({ kind: 'setup', username: 'administrator' }),
    ).resolves.toBe(false);
    expect(identity.limit).not.toHaveBeenCalled();
  });

  it('fails closed when either binding throws', async () => {
    const global = binding();
    global.limit.mockRejectedValueOnce(new Error('binding unavailable'));
    const limiter = new CloudflareAuthAttemptRateLimiter(global, binding());

    await expect(
      limiter.allow({ kind: 'login', username: 'administrator' }),
    ).rejects.toMatchObject({
      name: 'AuthRateLimiterUnavailableError',
      message: 'Authentication rate limiter is unavailable',
    });
  });
});
