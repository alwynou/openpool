import type { ApiKey } from '@openpool/domain';

export interface GeneratedApiKey {
  /** High-entropy bearer credential. It must only be returned at creation. */
  readonly rawToken: string;
  /** Non-secret display prefix used to help an administrator identify a key. */
  readonly keyPrefix: string;
}

export interface ApiKeyGenerator {
  generate(): GeneratedApiKey;
}

export interface ApiKeyHasher {
  /** Hashes a raw token with an adapter-owned server-side pepper. */
  hash(rawToken: string): Promise<string>;
}

/** Persistence-only representation. Never expose this type over an API. */
export interface ApiKeyRecord extends ApiKey {
  readonly keyHash: string;
}

export interface ApiKeyRepository {
  create(apiKey: ApiKeyRecord): Promise<boolean>;
  list(): Promise<readonly ApiKeyRecord[]>;
  findById(id: string): Promise<ApiKeyRecord | undefined>;
  findByKeyHash(keyHash: string): Promise<ApiKeyRecord | undefined>;
  /** Atomically sets revokedAt only when the key exists and is not revoked. */
  revoke(id: string, revokedAt: string): Promise<boolean>;
}
