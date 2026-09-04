import {
  authorizesApiKey,
  isApiKeyActive,
  validateApiKeyExpiration,
  validateApiKeyName,
  validateApiKeyRestrictions,
  validateApiKeyScopes,
  type ApiKey,
  type ApiKeyAuthorization,
  type ApiKeyScope,
} from '@openpool/domain';

import type {
  ApiKeyGenerator,
  ApiKeyHasher,
  ApiKeyRecord,
  ApiKeyRepository,
} from '../ports/api-key';
import type { AuditLog } from '../ports/auth';
import type {
  Clock,
  IdGenerator,
  LogicalBucketRepository,
} from '../ports/storage';

export type ApiKeyApplicationErrorCode =
  | 'API_KEY_INVALID_INPUT'
  | 'API_KEY_CONFLICT'
  | 'API_KEY_NOT_FOUND'
  | 'API_KEY_BUCKET_NOT_FOUND'
  | 'API_KEY_AUTHENTICATION_FAILED'
  | 'API_KEY_FORBIDDEN'
  | 'API_KEY_GENERATION_FAILED';

export class ApiKeyApplicationError extends Error {
  constructor(
    readonly code: ApiKeyApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiKeyApplicationError';
  }
}

function apiKeyError(
  code: ApiKeyApplicationErrorCode,
  message: string,
): ApiKeyApplicationError {
  return new ApiKeyApplicationError(code, message);
}

function invalidInput(): ApiKeyApplicationError {
  return apiKeyError('API_KEY_INVALID_INPUT', 'API key input is invalid');
}

function authenticationFailed(): ApiKeyApplicationError {
  return apiKeyError(
    'API_KEY_AUTHENTICATION_FAILED',
    'API key authentication failed',
  );
}

function toSafeApiKey(record: ApiKeyRecord): ApiKey {
  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    scopes: [...record.scopes],
    logicalBucketId: record.logicalBucketId,
    pathPrefix: record.pathPrefix,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    createdAt: record.createdAt,
  };
}

function isValidIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  );
}

function isValidGeneratedToken(rawToken: string, keyPrefix: string): boolean {
  return (
    rawToken.length >= 32 &&
    rawToken.length <= 512 &&
    /^[!-~]+$/u.test(rawToken) &&
    keyPrefix.length >= 4 &&
    keyPrefix.length <= 32 &&
    /^[A-Za-z0-9_-]+$/u.test(keyPrefix)
  );
}

function isValidHash(keyHash: string): boolean {
  return (
    keyHash.length >= 32 &&
    keyHash.length <= 512 &&
    /^[!-~]+$/u.test(keyHash)
  );
}

export interface CreateApiKeyCommand {
  readonly actorId: string;
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly logicalBucketId?: string | null;
  readonly pathPrefix?: string | null;
  readonly expiresAt?: string | null;
}

export interface CreateApiKeyDependencies {
  readonly apiKeys: ApiKeyRepository;
  readonly generator: ApiKeyGenerator;
  readonly hasher: ApiKeyHasher;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly buckets: Pick<LogicalBucketRepository, 'findById'>;
}

export interface CreateApiKeyResult {
  readonly apiKey: ApiKey;
  /** The only application result that contains the raw token. */
  readonly token: string;
}

export class CreateApiKey {
  constructor(private readonly dependencies: CreateApiKeyDependencies) {}

  async execute(command: CreateApiKeyCommand): Promise<CreateApiKeyResult> {
    const now = this.dependencies.clock.now();
    const name = command.name.trim();
    const logicalBucketId = command.logicalBucketId ?? null;
    const pathPrefix = command.pathPrefix ?? null;
    const expiresAt = command.expiresAt ?? null;

    try {
      if (!isValidIdentifier(command.actorId)) {
        throw new RangeError('Invalid actor');
      }
      validateApiKeyName(name);
      validateApiKeyScopes(command.scopes);
      validateApiKeyRestrictions(logicalBucketId, pathPrefix);
      validateApiKeyExpiration(expiresAt, now);
    } catch {
      throw invalidInput();
    }

    if (
      logicalBucketId !== null &&
      !(await this.dependencies.buckets.findById(logicalBucketId))
    ) {
      throw apiKeyError(
        'API_KEY_BUCKET_NOT_FOUND',
        'Logical bucket was not found',
      );
    }

    let generated: ReturnType<ApiKeyGenerator['generate']>;
    try {
      generated = this.dependencies.generator.generate();
    } catch {
      throw apiKeyError(
        'API_KEY_GENERATION_FAILED',
        'API key generation failed',
      );
    }
    if (!isValidGeneratedToken(generated.rawToken, generated.keyPrefix)) {
      throw apiKeyError(
        'API_KEY_GENERATION_FAILED',
        'API key generation failed',
      );
    }

    let keyHash: string;
    try {
      keyHash = await this.dependencies.hasher.hash(generated.rawToken);
    } catch {
      throw apiKeyError(
        'API_KEY_GENERATION_FAILED',
        'API key generation failed',
      );
    }
    if (!isValidHash(keyHash)) {
      throw apiKeyError(
        'API_KEY_GENERATION_FAILED',
        'API key generation failed',
      );
    }

    const record: ApiKeyRecord = {
      id: this.dependencies.ids.next(),
      name,
      keyPrefix: generated.keyPrefix,
      keyHash,
      scopes: [...command.scopes],
      logicalBucketId,
      pathPrefix,
      expiresAt,
      revokedAt: null,
      createdAt: now.toISOString(),
    };

    const auditEntry = {
      actorType: 'ADMIN' as const,
      actorId: command.actorId,
      action: 'API_KEY_CREATED' as const,
      resourceType: 'API_KEY' as const,
      resourceId: record.id,
      createdAt: record.createdAt,
      metadata: { keyPrefix: record.keyPrefix },
    };
    if (!(await this.dependencies.apiKeys.create(record, auditEntry))) {
      throw apiKeyError('API_KEY_CONFLICT', 'API key could not be created');
    }

    return {
      apiKey: toSafeApiKey(record),
      token: generated.rawToken,
    };
  }
}

export class ListApiKeys {
  constructor(
    private readonly apiKeys: Pick<ApiKeyRepository, 'list'>,
  ) {}

  async execute(): Promise<readonly ApiKey[]> {
    return (await this.apiKeys.list()).map(toSafeApiKey);
  }
}

export interface RevokeApiKeyCommand {
  readonly actorId: string;
  readonly id: string;
}

export interface RevokeApiKeyDependencies {
  readonly apiKeys: Pick<ApiKeyRepository, 'findById' | 'revoke'>;
  readonly clock: Clock;
}

export class RevokeApiKey {
  constructor(private readonly dependencies: RevokeApiKeyDependencies) {}

  async execute(command: RevokeApiKeyCommand): Promise<ApiKey> {
    if (
      !isValidIdentifier(command.actorId) ||
      !isValidIdentifier(command.id)
    ) {
      throw invalidInput();
    }

    const current = await this.dependencies.apiKeys.findById(command.id);
    if (!current) {
      throw apiKeyError('API_KEY_NOT_FOUND', 'API key was not found');
    }
    if (current.revokedAt !== null) {
      return toSafeApiKey(current);
    }

    const revokedAt = this.dependencies.clock.now().toISOString();
    const auditEntry = {
      actorType: 'ADMIN' as const,
      actorId: command.actorId,
      action: 'API_KEY_REVOKED' as const,
      resourceType: 'API_KEY' as const,
      resourceId: current.id,
      createdAt: revokedAt,
    };
    if (
      !(await this.dependencies.apiKeys.revoke(
        command.id,
        revokedAt,
        auditEntry,
      ))
    ) {
      const concurrent = await this.dependencies.apiKeys.findById(command.id);
      if (concurrent && concurrent.revokedAt !== null) {
        return toSafeApiKey(concurrent);
      }
      if (!concurrent) {
        throw apiKeyError('API_KEY_NOT_FOUND', 'API key was not found');
      }
      throw apiKeyError('API_KEY_CONFLICT', 'API key could not be revoked');
    }

    const revoked = { ...current, revokedAt };
    return toSafeApiKey(revoked);
  }
}

export interface AuthenticateApiKeyDependencies {
  readonly apiKeys: Pick<ApiKeyRepository, 'findByKeyHash'>;
  readonly hasher: ApiKeyHasher;
  readonly clock: Clock;
}

function parseBearerCredential(authorization: string): string | undefined {
  const match = /^Bearer ([!-~]+)$/iu.exec(authorization);
  if (!match || match[1] === undefined) {
    return undefined;
  }
  const rawToken = match[1];
  return rawToken.length >= 32 && rawToken.length <= 512
    ? rawToken
    : undefined;
}

function hasValidStoredMetadata(apiKey: ApiKey, now: Date): boolean {
  try {
    validateApiKeyName(apiKey.name);
    validateApiKeyScopes(apiKey.scopes);
    validateApiKeyRestrictions(apiKey.logicalBucketId, apiKey.pathPrefix);
    validateApiKeyExpiration(apiKey.expiresAt, now);
    return true;
  } catch {
    return false;
  }
}

export class AuthenticateApiKey {
  constructor(private readonly dependencies: AuthenticateApiKeyDependencies) {}

  async execute(authorization: string): Promise<ApiKey> {
    const rawToken = parseBearerCredential(authorization);
    if (!rawToken) {
      throw authenticationFailed();
    }

    let keyHash: string;
    try {
      keyHash = await this.dependencies.hasher.hash(rawToken);
    } catch {
      throw authenticationFailed();
    }

    if (!isValidHash(keyHash)) {
      throw authenticationFailed();
    }

    let record: ApiKeyRecord | undefined;
    try {
      record = await this.dependencies.apiKeys.findByKeyHash(keyHash);
    } catch {
      throw authenticationFailed();
    }
    const now = this.dependencies.clock.now();
    if (
      !record ||
      !isApiKeyActive(record, now) ||
      !hasValidStoredMetadata(record, now)
    ) {
      throw authenticationFailed();
    }

    return toSafeApiKey(record);
  }
}

export interface AuthorizeApiKeyDependencies {
  readonly clock: Clock;
  readonly audit: AuditLog;
}

export class AuthorizeApiKey {
  constructor(private readonly dependencies: AuthorizeApiKeyDependencies) {}

  async execute(
    apiKey: ApiKey,
    authorization: ApiKeyAuthorization,
  ): Promise<void> {
    const now = this.dependencies.clock.now();
    if (!authorizesApiKey(apiKey, authorization, now)) {
      throw apiKeyError('API_KEY_FORBIDDEN', 'API key is not authorized');
    }

    await this.dependencies.audit.record({
      actorType: 'API_KEY',
      actorId: apiKey.id,
      action: 'API_KEY_AUTHORIZED',
      resourceType: 'LOGICAL_BUCKET',
      resourceId: authorization.logicalBucketId,
      createdAt: now.toISOString(),
      metadata: { scope: authorization.action },
    });
  }
}
