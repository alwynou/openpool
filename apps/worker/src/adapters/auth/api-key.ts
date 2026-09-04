import type {
  ApiKeyGenerator,
  ApiKeyHasher,
  GeneratedApiKey,
} from '@openpool/application';

import { encodeBase64Url } from './encoding';

const RAW_TOKEN_PREFIX = 'opk_';
const TOKEN_BYTES = 32;
const DISPLAY_CHARACTERS = 8;
const HASH_FORMAT = 'hmac-sha256$v=1';

export interface ApiKeyGeneratorOptions {
  readonly crypto?: Pick<Crypto, 'getRandomValues'>;
}

/** Generates a 256-bit bearer credential and a deliberately non-secret label. */
export class WebCryptoApiKeyGenerator implements ApiKeyGenerator {
  private readonly cryptoApi: Pick<Crypto, 'getRandomValues'>;

  constructor(options: ApiKeyGeneratorOptions = {}) {
    this.cryptoApi = options.crypto ?? crypto;
  }

  generate(): GeneratedApiKey {
    const encoded = encodeBase64Url(
      this.cryptoApi.getRandomValues(new Uint8Array(TOKEN_BYTES)),
    );
    return {
      rawToken: `${RAW_TOKEN_PREFIX}${encoded}`,
      keyPrefix: `${RAW_TOKEN_PREFIX}${encoded.slice(0, DISPLAY_CHARACTERS)}`,
    };
  }
}

export interface ApiKeyHasherOptions {
  /** Canonical base64 or base64url encoding of exactly 32 random bytes. */
  readonly pepper: string;
  readonly crypto?: Pick<Crypto, 'subtle'>;
}

function invalidPepper(): never {
  throw new Error('Invalid API key pepper configuration');
}

function decodePepper(value: string): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) &&
      !/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) ||
    (value.includes('=') && value.length % 4 !== 0) ||
    value.replace(/=+$/u, '').length % 4 === 1
  ) {
    invalidPepper();
  }

  const unpadded = value.replace(/=+$/u, '');
  const normalized = unpadded.replaceAll('-', '+').replaceAll('_', '/');
  let binary: string;
  try {
    binary = atob(
      normalized + '='.repeat((4 - (normalized.length % 4)) % 4),
    );
  } catch {
    invalidPepper();
  }

  const bytes = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (
    bytes.length !== TOKEN_BYTES ||
    encodeBase64Url(bytes) !==
      unpadded.replaceAll('+', '-').replaceAll('/', '_')
  ) {
    invalidPepper();
  }
  return bytes;
}

/** HMAC-SHA256 hashing with an adapter-owned pepper; raw tokens are never encoded. */
export class WebCryptoApiKeyHasher implements ApiKeyHasher {
  private readonly cryptoApi: Pick<Crypto, 'subtle'>;
  private readonly pepper: Uint8Array;
  private keyPromise: Promise<CryptoKey> | undefined;

  constructor(options: ApiKeyHasherOptions) {
    this.cryptoApi = options.crypto ?? crypto;
    this.pepper = decodePepper(options.pepper);
  }

  async hash(rawToken: string): Promise<string> {
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      throw new Error('API key hashing failed');
    }

    try {
      const signature = await this.cryptoApi.subtle.sign(
        'HMAC',
        await this.getKey(),
        new TextEncoder().encode(rawToken),
      );
      return `${HASH_FORMAT}$${encodeBase64Url(new Uint8Array(signature))}`;
    } catch {
      throw new Error('API key hashing failed');
    }
  }

  private getKey(): Promise<CryptoKey> {
    this.keyPromise ??= this.cryptoApi.subtle.importKey(
      'raw',
      this.pepper,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return this.keyPromise;
  }
}
