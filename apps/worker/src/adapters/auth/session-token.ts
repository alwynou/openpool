import type { TokenGenerator, TokenHasher } from '@openpool/application';

import { encodeBase64Url } from './encoding';

export interface SessionTokenGeneratorOptions {
  readonly byteLength?: number;
  readonly crypto?: Pick<Crypto, 'getRandomValues'>;
}

export class WebCryptoSessionTokenGenerator implements TokenGenerator {
  private readonly byteLength: number;
  private readonly cryptoApi: Pick<Crypto, 'getRandomValues'>;

  constructor(options: SessionTokenGeneratorOptions = {}) {
    this.byteLength = options.byteLength ?? 32;
    if (!Number.isInteger(this.byteLength) || this.byteLength < 32) {
      throw new Error('Session token must contain at least 256 bits');
    }
    this.cryptoApi = options.crypto ?? crypto;
  }

  generate(): string {
    return encodeBase64Url(
      this.cryptoApi.getRandomValues(new Uint8Array(this.byteLength)),
    );
  }
}

export class WebCryptoTokenHasher implements TokenHasher {
  constructor(
    private readonly cryptoApi: Pick<Crypto, 'subtle'> = crypto,
  ) {}

  async hash(token: string): Promise<string> {
    const digest = await this.cryptoApi.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(token),
    );
    return encodeBase64Url(new Uint8Array(digest));
  }
}
