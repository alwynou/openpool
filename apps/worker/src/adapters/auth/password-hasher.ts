import type { PasswordHasher } from '@openpool/application';

import {
  constantTimeEqual,
  decodeBase64Url,
  encodeBase64Url,
} from './encoding';

export interface PasswordHasherOptions {
  readonly iterations?: number;
  readonly saltBytes?: number;
  readonly crypto?: Pick<Crypto, 'subtle' | 'getRandomValues'>;
}

const FORMAT = 'pbkdf2-sha256';
const VERSION = 'v=1';
// Cloudflare Workers rejects PBKDF2 operations above 100,000 iterations.
// Keep generated administrator passwords high entropy and fail closed on
// encoded hashes this runtime cannot verify.
const DEFAULT_ITERATIONS = 100_000;
const MAX_ACCEPTED_ITERATIONS = 100_000;
const DERIVED_BITS = 256;
const DUMMY_SALT = new TextEncoder().encode('openpool-auth-v1');

/** WebCrypto PBKDF2 password hashing. Encoded values are safe to persist in D1. */
export class WebCryptoPasswordHasher implements PasswordHasher {
  private readonly iterations: number;
  private readonly saltBytes: number;
  private readonly cryptoApi: Pick<Crypto, 'subtle' | 'getRandomValues'>;

  constructor(options: PasswordHasherOptions = {}) {
    this.iterations = options.iterations ?? DEFAULT_ITERATIONS;
    this.saltBytes = options.saltBytes ?? 16;
    if (
      !Number.isInteger(this.iterations) ||
      this.iterations < 1 ||
      this.iterations > MAX_ACCEPTED_ITERATIONS
    ) {
      throw new Error('Invalid PBKDF2 iterations');
    }
    if (!Number.isInteger(this.saltBytes) || this.saltBytes < 16) {
      throw new Error('Invalid PBKDF2 salt length');
    }
    this.cryptoApi = options.crypto ?? crypto;
  }

  async hash(password: string): Promise<string> {
    const salt = this.cryptoApi.getRandomValues(
      new Uint8Array(this.saltBytes),
    );
    const derived = await this.derive(password, salt, this.iterations);
    return [
      FORMAT,
      VERSION,
      `i=${this.iterations}`,
      encodeBase64Url(salt),
      encodeBase64Url(derived),
    ].join('$');
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    try {
      const parts = encoded.split('$');
      if (
        parts.length !== 5 ||
        parts[0] !== FORMAT ||
        parts[1] !== VERSION ||
        !parts[2]?.startsWith('i=') ||
        !parts[3] ||
        !parts[4]
      ) {
        return false;
      }

      const iterations = Number(parts[2].slice(2));
      if (
        !Number.isSafeInteger(iterations) ||
        iterations < 1 ||
        iterations > MAX_ACCEPTED_ITERATIONS
      ) {
        return false;
      }

      const salt = decodeBase64Url(parts[3]);
      const expected = decodeBase64Url(parts[4]);
      const actual = await this.derive(password, salt, iterations);
      return constantTimeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  async verifyDummy(password: string): Promise<boolean> {
    await this.derive(password, DUMMY_SALT, this.iterations);
    return false;
  }

  private async derive(
    password: string,
    salt: Uint8Array,
    iterations: number,
  ): Promise<Uint8Array> {
    const key = await this.cryptoApi.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await this.cryptoApi.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      key,
      DERIVED_BITS,
    );
    return new Uint8Array(bits);
  }
}
