import { describe, expect, it } from 'vitest';

import {
  CredentialVaultError,
  WebCryptoCredentialVault,
} from '../src/adapters/crypto';

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const payload = {
  accessKeyId: 'access-key-id',
  secretAccessKey: 'secret-access-key',
  endpoint: 'https://example.test',
  options: { region: 'auto', pathStyle: false },
};

function vault(
  masterKey: Uint8Array | string = key,
  keyId = 'master-v1',
): WebCryptoCredentialVault {
  return new WebCryptoCredentialVault({ masterKey, keyId });
}

function flipBase64UrlByte(value: string): string {
  const normalized =
    value.replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(normalized), (character) =>
    character.charCodeAt(0),
  );
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

describe('credential vault', () => {
  it('round-trips a JSON credential payload in a versioned envelope', async () => {
    const encrypted = await vault().encrypt(payload);

    expect(encrypted).toMatchObject({
      version: 1,
      algorithm: 'AES-256-GCM',
      keyId: 'master-v1',
    });
    expect(encrypted.iv).toMatch(/^[A-Za-z0-9_-]{16}$/u);
    expect(encrypted.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encrypted.ciphertext).not.toContain('secret-access-key');
    await expect(vault().decrypt(encrypted)).resolves.toEqual(payload);
  });

  it('uses a fresh random 96-bit IV for every encryption', async () => {
    const first = await vault().encrypt(payload);
    const second = await vault().encrypt(payload);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('rejects tampered ciphertext and IV without exposing plaintext', async () => {
    const encrypted = await vault().encrypt(payload);
    const tamperedCiphertext = {
      ...encrypted,
      ciphertext: flipBase64UrlByte(encrypted.ciphertext),
    };
    const tamperedIv = { ...encrypted, iv: flipBase64UrlByte(encrypted.iv) };

    await expect(vault().decrypt(tamperedCiphertext)).rejects.toMatchObject({
      code: 'DECRYPTION_FAILED',
    });
    await expect(vault().decrypt(tamperedIv)).rejects.toMatchObject({
      code: 'DECRYPTION_FAILED',
    });
    await expect(vault().decrypt(tamperedCiphertext)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes('secret-access-key'),
    );
  });

  it('rejects a wrong master key', async () => {
    const encrypted = await vault().encrypt(payload);
    const wrongKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

    await expect(vault(wrongKey).decrypt(encrypted)).rejects.toMatchObject({
      code: 'DECRYPTION_FAILED',
    });
  });

  it('accepts a base64-encoded master key and rejects invalid key lengths', async () => {
    let binary = '';
    for (const byte of key) binary += String.fromCharCode(byte);
    const encodedKey = btoa(binary);
    const encrypted = await vault(encodedKey).encrypt(payload);
    await expect(vault(encodedKey).decrypt(encrypted)).resolves.toEqual(payload);

    for (const invalidKey of [
      new Uint8Array(0),
      new Uint8Array(16),
      new Uint8Array(31),
      new Uint8Array(33),
      'not-base64',
    ]) {
      expect(
        () =>
          new WebCryptoCredentialVault({
            masterKey: invalidKey,
            keyId: 'master-v1',
          }),
      ).toThrowError(new CredentialVaultError('INVALID_MASTER_KEY'));
    }
  });

  it('rejects unsafe key IDs and non-JSON credential payloads', async () => {
    for (const keyId of ['', ' leading-space', 'path/value', 'a'.repeat(129)]) {
      expect(
        () => new WebCryptoCredentialVault({ masterKey: key, keyId }),
      ).toThrowError(new CredentialVaultError('INVALID_CONFIGURATION'));
    }

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const invalidPayload of [
      [],
      { value: Number.NaN },
      { value: undefined },
      cyclic,
    ]) {
      await expect(vault().encrypt(invalidPayload as never)).rejects.toMatchObject(
        { code: 'INVALID_PAYLOAD' },
      );
    }
  });

  it('rejects unknown versions, algorithms, and mismatched key IDs before decrypting', async () => {
    const encrypted = await vault().encrypt(payload);

    await expect(
      vault().decrypt({ ...encrypted, version: 2 } as never),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
    await expect(
      vault().decrypt({ ...encrypted, algorithm: 'AES-128-GCM' } as never),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ALGORITHM' });
    await expect(
      vault().decrypt({ ...encrypted, keyId: 'master-v2' }),
    ).rejects.toMatchObject({ code: 'KEY_ID_MISMATCH' });

    await expect(
      vault(key, 'master-v2').decrypt({
        ...encrypted,
        keyId: 'master-v2',
      }),
    ).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });
  });

  it('rejects malformed envelope fields', async () => {
    const encrypted = await vault().encrypt(payload);

    await expect(
      vault().decrypt({ ...encrypted, iv: 'bad!' }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    await expect(
      vault().decrypt({ ...encrypted, ciphertext: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
  });
});
