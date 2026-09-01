export const apiKeyScopes = [
  'objects:list',
  'objects:read',
  'objects:upload',
  'objects:delete',
] as const;

export type ApiKeyScope = (typeof apiKeyScopes)[number];
export type ApiKeyAction = ApiKeyScope;

/** Safe API key metadata. Raw tokens and hashes never belong in the domain model. */
export interface ApiKey {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly logicalBucketId: string | null;
  /** When bucket is null, this prefix restriction applies across all buckets. */
  readonly pathPrefix: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface ApiKeyAuthorization {
  readonly action: ApiKeyAction;
  readonly logicalBucketId: string;
  /** Required when the API key has a path restriction. */
  readonly logicalKey?: string;
}

const API_KEY_NAME_MAX_LENGTH = 128;
const LOGICAL_BUCKET_ID_MAX_LENGTH = 128;
const PATH_PREFIX_MAX_LENGTH = 1_024;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function validateApiKeyName(name: string): void {
  if (
    name.length === 0 ||
    name.length > API_KEY_NAME_MAX_LENGTH ||
    containsControlCharacter(name)
  ) {
    throw new RangeError('API key name is invalid');
  }
}

export function validateApiKeyScopes(
  scopes: readonly ApiKeyScope[],
): void {
  if (
    scopes.length === 0 ||
    scopes.length > apiKeyScopes.length ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !apiKeyScopes.includes(scope))
  ) {
    throw new RangeError('API key scopes are invalid');
  }
}

export function validateApiKeyRestrictions(
  logicalBucketId: string | null,
  pathPrefix: string | null,
): void {
  if (
    logicalBucketId !== null &&
    (logicalBucketId.length === 0 ||
      logicalBucketId.length > LOGICAL_BUCKET_ID_MAX_LENGTH ||
      containsControlCharacter(logicalBucketId))
  ) {
    throw new RangeError('API key logical bucket restriction is invalid');
  }

  if (
    pathPrefix !== null &&
    (pathPrefix.length === 0 ||
      pathPrefix.length > PATH_PREFIX_MAX_LENGTH ||
      containsControlCharacter(pathPrefix))
  ) {
    throw new RangeError('API key path restriction is invalid');
  }
}

export function validateApiKeyExpiration(
  expiresAt: string | null,
  now: Date,
): void {
  if (
    expiresAt !== null &&
    (!isCanonicalTimestamp(expiresAt) ||
      Date.parse(expiresAt) <= now.getTime())
  ) {
    throw new RangeError('API key expiration is invalid');
  }
}

export function isApiKeyActive(apiKey: ApiKey, now: Date): boolean {
  if (apiKey.revokedAt !== null) {
    return false;
  }

  if (apiKey.expiresAt === null) {
    return true;
  }

  const expiresAt = Date.parse(apiKey.expiresAt);
  return (
    isCanonicalTimestamp(apiKey.expiresAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > now.getTime()
  );
}

/**
 * Checks an already authenticated API key against a requested logical object
 * operation. A configured path is a literal object-key prefix.
 */
export function authorizesApiKey(
  apiKey: ApiKey,
  authorization: ApiKeyAuthorization,
  now: Date,
): boolean {
  try {
    validateApiKeyRestrictions(
      authorization.logicalBucketId,
      authorization.logicalKey ?? null,
    );
  } catch {
    return false;
  }

  if (
    !isApiKeyActive(apiKey, now) ||
    !apiKey.scopes.includes(authorization.action) ||
    authorization.logicalBucketId.length === 0 ||
    (apiKey.logicalBucketId !== null &&
      apiKey.logicalBucketId !== authorization.logicalBucketId)
  ) {
    return false;
  }

  if (apiKey.pathPrefix === null) {
    return true;
  }

  return (
    authorization.logicalKey !== undefined &&
    authorization.logicalKey.startsWith(apiKey.pathPrefix)
  );
}
