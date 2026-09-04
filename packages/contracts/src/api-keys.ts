export const apiKeyScopes = [
  'objects:list',
  'objects:read',
  'objects:upload',
  'objects:delete',
] as const;

export type ApiKeyScope = (typeof apiKeyScopes)[number];

export interface CreateApiKeyRequest {
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly logicalBucketId?: string | null;
  readonly pathPrefix?: string | null;
  readonly expiresAt?: string | null;
}

/** Safe public metadata. Raw tokens and persistence hashes are omitted. */
export interface ApiKeyResponse {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly logicalBucketId: string | null;
  readonly pathPrefix: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

/** Returned only once, immediately after an API key is created. */
export interface CreatedApiKeyResponse {
  readonly apiKey: ApiKeyResponse;
  readonly token: string;
}

/** Stable errors exposed by administrator API key management endpoints. */
export type ApiKeyErrorCode =
  | 'API_KEY_UNAUTHORIZED'
  | 'API_KEY_INVALID'
  | 'API_KEY_CONFLICT'
  | 'API_KEY_NOT_FOUND'
  | 'API_KEY_BUCKET_NOT_FOUND'
  | 'API_KEY_FORBIDDEN'
  | 'API_KEY_GENERATION_FAILED';
