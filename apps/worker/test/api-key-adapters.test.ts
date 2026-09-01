import { describe, expect, it } from 'vitest';

import {
  encodeBase64Url,
  WebCryptoApiKeyGenerator,
  WebCryptoApiKeyHasher,
} from '../src/adapters/auth';

function pepper(fill: number): string {
  return encodeBase64Url(new Uint8Array(32).fill(fill));
}

describe('API key crypto adapters', () => {
  it('generates a deterministic opk_ format from exactly 32 random bytes', () => {
    const fakeCrypto: Pick<Crypto, 'getRandomValues'> = {
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        if (!(array instanceof Uint8Array)) {
          throw new Error('Unexpected random buffer');
        }
        array.forEach((_, index) => {
          array[index] = index;
        });
        return array as T;
      },
    };
    const generated = new WebCryptoApiKeyGenerator({
      crypto: fakeCrypto,
    }).generate();

    expect(generated).toEqual({
      rawToken:
        'opk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      keyPrefix: 'opk_AAECAwQF',
    });
    expect(generated.rawToken.startsWith(generated.keyPrefix)).toBe(true);
  });

  it('uses fresh CSPRNG output for each 256-bit credential', () => {
    const generator = new WebCryptoApiKeyGenerator();
    const tokens = Array.from({ length: 64 }, () => generator.generate());
    expect(new Set(tokens.map(({ rawToken }) => rawToken))).toHaveLength(64);
    for (const { rawToken, keyPrefix } of tokens) {
      expect(rawToken).toMatch(/^opk_[A-Za-z0-9_-]{43}$/u);
      expect(keyPrefix).toMatch(/^opk_[A-Za-z0-9_-]{8}$/u);
    }
  });

  it('produces deterministic, versioned HMACs separated by pepper', async () => {
    const token = 'opk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const first = new WebCryptoApiKeyHasher({ pepper: pepper(1) });
    const samePepper = new WebCryptoApiKeyHasher({ pepper: pepper(1) });
    const otherPepper = new WebCryptoApiKeyHasher({ pepper: pepper(2) });

    const firstHash = await first.hash(token);
    expect(firstHash).toMatch(
      /^hmac-sha256\$v=1\$[A-Za-z0-9_-]{43}$/u,
    );
    expect(await samePepper.hash(token)).toBe(firstHash);
    expect(await otherPepper.hash(token)).not.toBe(firstHash);
    expect(firstHash).not.toContain(token);
  });

  it('accepts canonical padded standard base64 pepper', async () => {
    const standard = `${pepper(255).replaceAll('-', '+').replaceAll('_', '/')}=`;
    const hash = await new WebCryptoApiKeyHasher({ pepper: standard }).hash(
      'opk_test-token',
    );
    expect(hash).toMatch(/^hmac-sha256\$v=1\$/u);
  });

  it('fails closed without exposing invalid pepper configuration', () => {
    const configuredSecret = 'not-a-valid-pepper';
    let error: unknown;
    try {
      new WebCryptoApiKeyHasher({ pepper: configuredSecret });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('Error: Invalid API key pepper configuration');
    expect(String(error)).not.toContain(configuredSecret);
  });

  it('does not expose the raw token when Web Crypto fails', async () => {
    const rawToken = 'opk_this-value-must-never-appear-in-errors';
    const failingCrypto = {
      subtle: {
        importKey: async (): Promise<CryptoKey> => {
          throw new Error(`failed for ${rawToken}`);
        },
      } as unknown as SubtleCrypto,
    };
    const hasher = new WebCryptoApiKeyHasher({
      pepper: pepper(3),
      crypto: failingCrypto,
    });

    let error: unknown;
    try {
      await hasher.hash(rawToken);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toBe('Error: API key hashing failed');
    expect(String(error)).not.toContain(rawToken);
    expect(String(error)).not.toContain(pepper(3));
  });
});
