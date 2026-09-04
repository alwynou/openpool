import {
  CREDENTIAL_ENVELOPE_ALGORITHM,
  CREDENTIAL_ENVELOPE_VERSION,
} from '@openpool/application';
import type {
  CredentialEnvelope,
  CredentialPayload,
  CredentialVault,
  JsonValue,
} from '@openpool/application';

const IV_BYTES = 12;
const MASTER_KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;
const AUTH_TAG_BITS = AUTH_TAG_BYTES * 8;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type CredentialVaultErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_MASTER_KEY'
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_ALGORITHM'
  | 'KEY_ID_MISMATCH'
  | 'INVALID_PAYLOAD'
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED';

/** Errors intentionally contain no credential, key, or provider data. */
export class CredentialVaultError extends Error {
  readonly code: CredentialVaultErrorCode;

  constructor(code: CredentialVaultErrorCode) {
    super(`Credential vault error: ${code}`);
    this.name = 'CredentialVaultError';
    this.code = code;
  }
}

export interface WebCryptoCredentialVaultOptions {
  /** A raw 32-byte AES key, or a base64/base64url-encoded 32-byte key. */
  readonly masterKey: Uint8Array | ArrayBuffer | string;
  readonly keyId: string;
  readonly crypto?: Pick<Crypto, 'subtle' | 'getRandomValues'>;
}

/** Web Crypto AES-256-GCM implementation of the application credential vault port. */
export class WebCryptoCredentialVault implements CredentialVault {
  private readonly masterKey: Uint8Array;
  private readonly keyId: string;
  private readonly cryptoApi: Pick<Crypto, 'subtle' | 'getRandomValues'>;

  constructor(options: WebCryptoCredentialVaultOptions) {
    if (typeof options.keyId !== 'string' || !SAFE_KEY_ID.test(options.keyId)) {
      throw new CredentialVaultError('INVALID_CONFIGURATION');
    }

    let masterKey: Uint8Array;
    try {
      masterKey =
        typeof options.masterKey === 'string'
          ? decodeBase64(options.masterKey)
          : new Uint8Array(options.masterKey);
    } catch {
      throw new CredentialVaultError('INVALID_MASTER_KEY');
    }

    if (masterKey.byteLength !== MASTER_KEY_BYTES) {
      throw new CredentialVaultError('INVALID_MASTER_KEY');
    }

    this.masterKey = new Uint8Array(masterKey);
    this.keyId = options.keyId;
    this.cryptoApi = options.crypto ?? crypto;
  }

  async encrypt(payload: CredentialPayload): Promise<CredentialEnvelope> {
    const serialized = serializePayload(payload);
    const iv = this.cryptoApi.getRandomValues(new Uint8Array(IV_BYTES));

    try {
      const key = await this.importMasterKey();
      const ciphertext = await this.cryptoApi.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: this.authenticatedMetadata(),
          tagLength: AUTH_TAG_BITS,
        },
        key,
        textEncoder.encode(serialized),
      );

      return {
        version: CREDENTIAL_ENVELOPE_VERSION,
        algorithm: CREDENTIAL_ENVELOPE_ALGORITHM,
        keyId: this.keyId,
        iv: encodeBase64Url(iv),
        ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
      };
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError('ENCRYPTION_FAILED');
    }
  }

  async decrypt(envelope: CredentialEnvelope): Promise<CredentialPayload> {
    const parsed = validateEnvelope(envelope, this.keyId);

    let plaintext: ArrayBuffer;
    try {
      const key = await this.importMasterKey();
      plaintext = await this.cryptoApi.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: parsed.iv,
          additionalData: this.authenticatedMetadata(),
          tagLength: AUTH_TAG_BITS,
        },
        key,
        parsed.ciphertext,
      );
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError('DECRYPTION_FAILED');
    }

    let value: unknown;
    try {
      value = JSON.parse(textDecoder.decode(plaintext));
    } catch {
      throw new CredentialVaultError('INVALID_PAYLOAD');
    }
    if (!isCredentialPayload(value)) {
      throw new CredentialVaultError('INVALID_PAYLOAD');
    }
    return value;
  }

  private async importMasterKey(): Promise<CryptoKey> {
    return this.cryptoApi.subtle.importKey(
      'raw',
      this.masterKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  private authenticatedMetadata(): Uint8Array {
    return textEncoder.encode(
      `${CREDENTIAL_ENVELOPE_VERSION}:${CREDENTIAL_ENVELOPE_ALGORITHM}:${this.keyId}`,
    );
  }
}

function serializePayload(payload: CredentialPayload): string {
  try {
    if (!isCredentialPayload(payload)) {
      throw new CredentialVaultError('INVALID_PAYLOAD');
    }
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error('not JSON');
    return serialized;
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error;
    throw new CredentialVaultError('INVALID_PAYLOAD');
  }
}

function validateEnvelope(
  envelope: CredentialEnvelope,
  expectedKeyId: string,
): { readonly iv: Uint8Array; readonly ciphertext: Uint8Array } {
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    Array.isArray(envelope)
  ) {
    throw new CredentialVaultError('INVALID_ENVELOPE');
  }

  const candidate = envelope as unknown as Record<string, unknown>;
  if (candidate.version !== CREDENTIAL_ENVELOPE_VERSION) {
    throw new CredentialVaultError('UNSUPPORTED_VERSION');
  }
  if (candidate.algorithm !== CREDENTIAL_ENVELOPE_ALGORITHM) {
    throw new CredentialVaultError('UNSUPPORTED_ALGORITHM');
  }
  if (candidate.keyId !== expectedKeyId) {
    throw new CredentialVaultError('KEY_ID_MISMATCH');
  }
  if (
    typeof candidate.iv !== 'string' ||
    typeof candidate.ciphertext !== 'string'
  ) {
    throw new CredentialVaultError('INVALID_ENVELOPE');
  }

  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = decodeBase64Url(candidate.iv);
    ciphertext = decodeBase64Url(candidate.ciphertext);
  } catch {
    throw new CredentialVaultError('INVALID_ENVELOPE');
  }
  if (iv.byteLength !== IV_BYTES || ciphertext.byteLength < AUTH_TAG_BYTES) {
    throw new CredentialVaultError('INVALID_ENVELOPE');
  }
  return { iv, ciphertext };
}

function isCredentialPayload(value: unknown): value is CredentialPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return isJsonObject(value, new Set<object>());
}

function isJsonObject(value: object, seen: Set<object>): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return false;
  }
  try {
    const record = value as Record<string, unknown>;
    return Object.keys(record).every((key) => isJsonValue(record[key], seen));
  } finally {
    seen.delete(value);
  }
}

function isJsonValue(value: unknown, seen: Set<object>): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    try {
      return value.every((item) => isJsonValue(item, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === 'object') return isJsonObject(value, seen);
  return false;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeBase64(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9+/_-]*={0,2}$/u.test(value)) {
    throw new Error('invalid base64');
  }
  const paddingIndex = value.indexOf('=');
  const unpadded = paddingIndex < 0 ? value : value.slice(0, paddingIndex);
  if (paddingIndex >= 0 && !/^=+$/u.test(value.slice(paddingIndex))) {
    throw new Error('invalid base64');
  }
  if (unpadded.length % 4 === 1) throw new Error('invalid base64');
  const normalized = unpadded.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return decodeBase64Bytes(padded);
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error('invalid base64url');
  }
  return decodeBase64Bytes(
    value.replaceAll('-', '+').replaceAll('_', '/') +
      '='.repeat((4 - (value.length % 4)) % 4),
  );
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
