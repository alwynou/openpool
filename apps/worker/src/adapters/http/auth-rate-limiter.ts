export type AuthAttemptKind = 'login' | 'setup';

export interface AuthAttemptRateLimiter {
  allow(input: {
    readonly kind: AuthAttemptKind;
    readonly username: string;
  }): Promise<boolean>;
}

export class AuthRateLimiterUnavailableError extends Error {
  constructor() {
    super('Authentication rate limiter is unavailable');
    this.name = 'AuthRateLimiterUnavailableError';
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Applies both a per-location route ceiling and a per-identity ceiling.
 * Binding keys contain neither the submitted password nor the raw username.
 */
export class CloudflareAuthAttemptRateLimiter
  implements AuthAttemptRateLimiter
{
  constructor(
    private readonly globalLimiter: RateLimit,
    private readonly identityLimiter: RateLimit,
    private readonly cryptoApi: Pick<Crypto, 'subtle'> = crypto,
  ) {}

  async allow(input: {
    readonly kind: AuthAttemptKind;
    readonly username: string;
  }): Promise<boolean> {
    try {
      const global = await this.globalLimiter.limit({
        key: `auth:${input.kind}:global`,
      });
      if (!global.success) return false;

      const identity = new TextEncoder().encode(
        `${input.kind}:${input.username.trim()}`,
      );
      const digest = new Uint8Array(
        await this.cryptoApi.subtle.digest('SHA-256', identity),
      );
      const scoped = await this.identityLimiter.limit({
        key: `auth:${input.kind}:identity:${hex(digest)}`,
      });
      return scoped.success;
    } catch {
      throw new AuthRateLimiterUnavailableError();
    }
  }
}
