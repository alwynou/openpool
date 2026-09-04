/** The only envelope version currently supported by the credential vault. */
export const CREDENTIAL_ENVELOPE_VERSION = 1 as const;

/** The wire-level algorithm identifier used by the AES-GCM adapter. */
export const CREDENTIAL_ENVELOPE_ALGORITHM = 'AES-256-GCM' as const;

export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** JSON object containing provider credentials, without any platform types. */
export type CredentialPayload = JsonObject;

/** Persisted, versioned representation of encrypted provider credentials. */
export interface CredentialEnvelope {
  readonly version: typeof CREDENTIAL_ENVELOPE_VERSION;
  readonly algorithm: typeof CREDENTIAL_ENVELOPE_ALGORITHM;
  readonly keyId: string;
  /** Base64url encoded 96-bit AES-GCM IV. */
  readonly iv: string;
  /** Base64url encoded ciphertext, including the AES-GCM authentication tag. */
  readonly ciphertext: string;
}

/** Port implemented by an outer adapter that protects JSON provider credentials. */
export interface CredentialVault {
  encrypt(payload: CredentialPayload): Promise<CredentialEnvelope>;
  decrypt(envelope: CredentialEnvelope): Promise<CredentialPayload>;
}
