import {
  ApiKeyApplicationError,
  AuthenticateSession,
  AuthenticateApiKey,
  AuthError,
  AuthorizeApiKey,
  CompleteUpload,
  CreateApiKey,
  CreateLogicalBucket,
  CreateDownload,
  CreateStorageAccount,
  CreateStorageShard,
  CreateUpload,
  DeleteObject,
  DrainAuditOutbox,
  type AuthClock,
  type AuthIdGenerator,
  type CredentialPayload,
  type CredentialVault,
  GetSetupStatus,
  GetLogicalBucket,
  GetObjectMetadata,
  GetUploadSession,
  InitializeAdministrator,
  ListStorageAccounts,
  ListApiKeys,
  ListAuditLogs,
  ListLogicalBuckets,
  ListObjectMetadata,
  ListStorageShards,
  Login,
  Logout,
  type PasswordHasher,
  type ApiKeyGenerator,
  type ApiKeyHasher,
  RefreshStorageAccountHealth,
  RevokeApiKey,
  ClaimShardMigrationTransfer,
  CompleteShardMigrationTransfer,
  GetShardMigration,
  ListShardMigrations,
  StartShardMigration,
  SweepShardMigrationCleanup,
  SweepExpiredUploads,
  type ProviderRegistry,
  type TokenGenerator,
  type TokenHasher,
  TransitionStorageAccount,
  TransitionStorageShard,
  UpdateStorageAccountConfiguration,
  VerifyStorageAccount,
} from '@openpool/application';

import {
  EnvironmentBootstrapAuthorizer,
  WebCryptoApiKeyGenerator,
  WebCryptoApiKeyHasher,
  WebCryptoPasswordHasher,
  WebCryptoSessionTokenGenerator,
  WebCryptoTokenHasher,
} from '../adapters/auth';
import { WebCryptoCredentialVault } from '../adapters/crypto';
import {
  D1AuthRepository,
  D1ApiKeyRepository,
  D1AuditQueryRepository,
  D1AuditOutboxRepository,
  D1LogicalBucketRepository,
  D1ObjectRepository,
  D1ShardMigrationRepository,
  D1StorageAccountRepository,
  D1StorageShardRepository,
} from '../adapters/d1';
import { createHttpApp } from '../adapters/http/app';
import {
  CloudflareAuthAttemptRateLimiter,
  type AuthAttemptRateLimiter,
} from '../adapters/http/auth-rate-limiter';
import type { AuthUseCases } from '../adapters/http/auth-routes';
import { createStorageProviderRegistry } from '../adapters/providers';
import type { Env } from '../env';
import {
  checkDeploymentReadiness,
  inspectStaticDeploymentConfiguration,
} from './deployment-preflight';

export interface WorkerCompositionOverrides {
  readonly passwordHasher?: PasswordHasher;
  readonly tokenGenerator?: TokenGenerator;
  readonly tokenHasher?: TokenHasher;
  readonly idGenerator?: AuthIdGenerator;
  readonly clock?: AuthClock;
  readonly credentialVault?: CredentialVault;
  readonly providerRegistry?: ProviderRegistry;
  readonly apiKeyGenerator?: ApiKeyGenerator;
  readonly apiKeyHasher?: ApiKeyHasher;
  readonly authAttemptRateLimiter?: AuthAttemptRateLimiter;
}

const defaultIdGenerator: AuthIdGenerator = {
  next: () => crypto.randomUUID(),
};

const defaultClock: AuthClock = {
  now: () => new Date(),
};

function credentialVaultFor(
  env: Env,
  override?: CredentialVault,
): CredentialVault {
  if (override) return override;
  const options = {
    masterKey: env.CREDENTIAL_MASTER_KEY ?? '',
    keyId: env.CREDENTIAL_MASTER_KEY_ID ?? 'primary-v1',
  };
  return {
    encrypt: (payload: CredentialPayload) =>
      new WebCryptoCredentialVault(options).encrypt(payload),
    decrypt: (envelope) =>
      new WebCryptoCredentialVault(options).decrypt(envelope),
  };
}

/** The only composition root. Platform adapters enter application use cases here. */
export function createWorker(overrides: WorkerCompositionOverrides = {}) {
  const passwords = overrides.passwordHasher ?? new WebCryptoPasswordHasher();
  const tokens =
    overrides.tokenGenerator ?? new WebCryptoSessionTokenGenerator();
  const tokenHashes = overrides.tokenHasher ?? new WebCryptoTokenHasher();
  const ids = overrides.idGenerator ?? defaultIdGenerator;
  const clock = overrides.clock ?? defaultClock;
  const providers =
    overrides.providerRegistry ?? createStorageProviderRegistry();
  const apiKeyGenerator =
    overrides.apiKeyGenerator ?? new WebCryptoApiKeyGenerator();

  const createAuthAttemptRateLimiter = (env: Env): AuthAttemptRateLimiter => {
    if (overrides.authAttemptRateLimiter) {
      return overrides.authAttemptRateLimiter;
    }
    if (!env.AUTH_GLOBAL_RATE_LIMITER || !env.AUTH_IDENTITY_RATE_LIMITER) {
      throw new Error('Authentication rate limiter bindings are unavailable');
    }
    return new CloudflareAuthAttemptRateLimiter(
      env.AUTH_GLOBAL_RATE_LIMITER,
      env.AUTH_IDENTITY_RATE_LIMITER,
    );
  };

  const createAuthUseCases = (
    env: Env,
    requestId: string,
  ): AuthUseCases => {
    const auditOutbox = new D1AuditOutboxRepository(env.DB, {
      requestId,
      idGenerator: () => ids.next(),
    });
    const repository = new D1AuthRepository(env.DB, {
      requestId,
      auditIdGenerator: () => ids.next(),
      auditOutbox,
    });
    const common = {
      administrators: repository,
      sessions: repository,
      passwords,
      tokens,
      tokenHashes,
      ids,
      clock,
    };

    return {
      getSetupStatus: new GetSetupStatus(repository),
      initializeAdministrator: new InitializeAdministrator({
        administrators: repository,
        bootstrap: new EnvironmentBootstrapAuthorizer(
          env.ADMIN_BOOTSTRAP_TOKEN,
        ),
        passwords,
        ids,
        clock,
      }),
      login: new Login(common),
      authenticateSession: new AuthenticateSession(common),
      logout: new Logout(common),
    };
  };

  const createUseCases = (env: Env, requestId: string) => {
    const auditOutbox = new D1AuditOutboxRepository(env.DB, {
      requestId,
      idGenerator: () => ids.next(),
    });
    const accounts = new D1StorageAccountRepository(env.DB, auditOutbox);
    const buckets = new D1LogicalBucketRepository(env.DB, auditOutbox);
    const shards = new D1StorageShardRepository(env.DB, auditOutbox);
    const vault = credentialVaultFor(env, overrides.credentialVault);
    const common = { accounts, vault, providers, clock };

    const shardDependencies = {
      buckets,
      accounts,
      shards,
      ids,
      clock,
    };

    return {
      create: new CreateStorageAccount({ ...common, ids }),
      updateConfiguration: new UpdateStorageAccountConfiguration({
        accounts,
        vault,
        clock,
      }),
      list: new ListStorageAccounts(accounts),
      verify: new VerifyStorageAccount(common),
      transition: new TransitionStorageAccount({ accounts, clock }),
      refresh: new RefreshStorageAccountHealth(common),
      createBucket: new CreateLogicalBucket({ buckets, ids, clock }),
      listBuckets: new ListLogicalBuckets(buckets),
      getBucket: new GetLogicalBucket(buckets),
      createShard: new CreateStorageShard(shardDependencies),
      listShards: new ListStorageShards(shards),
      transitionShard: new TransitionStorageShard(shardDependencies),
    };
  };

  const createObjectUseCases = (env: Env, requestId: string) => {
    const auditOutbox = new D1AuditOutboxRepository(env.DB, {
      requestId,
      idGenerator: () => ids.next(),
    });
    const accounts = new D1StorageAccountRepository(env.DB);
    const shards = new D1StorageShardRepository(env.DB);
    const objects = new D1ObjectRepository(env.DB, auditOutbox);
    const common = {
      accounts,
      objects,
      providers,
      vault: credentialVaultFor(env, overrides.credentialVault),
      clock,
    };

    return {
      createUpload: new CreateUpload({ ...common, shards, ids }),
      completeUpload: new CompleteUpload(common),
      listObjects: new ListObjectMetadata(objects),
      getObject: new GetObjectMetadata(objects),
      getUpload: new GetUploadSession(objects),
      createDownload: new CreateDownload({ ...common, audit: auditOutbox }),
      deleteObject: new DeleteObject(common),
    };
  };

  const createMigrationUseCases = (env: Env, requestId: string) => {
    const auditOutbox = new D1AuditOutboxRepository(env.DB, {
      requestId,
      idGenerator: () => ids.next(),
    });
    const accounts = new D1StorageAccountRepository(env.DB);
    const buckets = new D1LogicalBucketRepository(env.DB, auditOutbox);
    const shards = new D1StorageShardRepository(env.DB);
    const migrations = new D1ShardMigrationRepository(env.DB, auditOutbox);
    const transferDependencies = {
      migrations,
      accounts,
      providers,
      vault: credentialVaultFor(env, overrides.credentialVault),
      ids,
      clock,
    };

    return {
      startMigration: new StartShardMigration({
        migrations,
        shards,
        accounts,
        ids,
        clock,
      }),
      getMigration: new GetShardMigration(migrations),
      listMigrations: new ListShardMigrations(buckets, migrations),
      claimMigrationTransfer: new ClaimShardMigrationTransfer(
        transferDependencies,
      ),
      completeMigrationTransfer: new CompleteShardMigrationTransfer(
        transferDependencies,
      ),
    };
  };

  const createApiKeyHasher = (env: Env): ApiKeyHasher =>
    overrides.apiKeyHasher ?? {
      hash: (rawToken) =>
        new WebCryptoApiKeyHasher({
          pepper: env.API_KEY_PEPPER ?? '',
        }).hash(rawToken),
    };

  const createApiKeyUseCases = (env: Env, requestId: string) => {
    const auditOutbox = new D1AuditOutboxRepository(env.DB, {
      requestId,
      idGenerator: () => ids.next(),
    });
    const apiKeys = new D1ApiKeyRepository(env.DB, auditOutbox);
    const buckets = new D1LogicalBucketRepository(env.DB, auditOutbox);
    const hasher = createApiKeyHasher(env);
    return {
      createApiKey: new CreateApiKey({
        apiKeys,
        generator: apiKeyGenerator,
        hasher,
        ids,
        clock,
        buckets,
      }),
      listApiKeys: new ListApiKeys(apiKeys),
      revokeApiKey: new RevokeApiKey({ apiKeys, clock }),
      authenticateApiKey: new AuthenticateApiKey({ apiKeys, hasher, clock }),
      authorizeApiKey: new AuthorizeApiKey({ clock, audit: auditOutbox }),
    };
  };

  const createAuditUseCases = (env: Env) => ({
    listAuditLogs: new ListAuditLogs(new D1AuditQueryRepository(env.DB)),
  });

  const authenticateAdministrator = async (
    env: Env,
    requestId: string,
    sessionToken: string,
  ) => {
    try {
      return (
        await createAuthUseCases(
          env,
          requestId,
        ).authenticateSession.execute(sessionToken)
      ).administrator;
    } catch (error) {
      if (error instanceof AuthError && error.code === 'SESSION_INVALID') {
        return undefined;
      }
      throw error;
    }
  };

  return createHttpApp({
    createAuthUseCases,
    createAuthAttemptRateLimiter,
    inspectDeploymentConfiguration: inspectStaticDeploymentConfiguration,
    checkDeploymentReadiness,
    authenticate: authenticateAdministrator,
    createApiKeyUseCases,
    createAuditUseCases,
    authenticateObject: async (env, requestId, credentials) => {
      if (credentials.sessionToken) {
        const administrator = await authenticateAdministrator(
          env,
          requestId,
          credentials.sessionToken,
        );
        if (administrator) {
          return {
            actorType: 'ADMIN' as const,
            actorId: administrator.id,
            pathPrefix: null,
          };
        }
      }
      if (!credentials.authorization) return undefined;
      try {
        const apiKey = await createApiKeyUseCases(
          env,
          requestId,
        ).authenticateApiKey.execute(credentials.authorization);
        return {
          actorType: 'API_KEY' as const,
          actorId: apiKey.id,
          pathPrefix: apiKey.pathPrefix,
          apiKey,
        };
      } catch (error) {
        if (
          error instanceof ApiKeyApplicationError &&
          error.code === 'API_KEY_AUTHENTICATION_FAILED'
        ) {
          return undefined;
        }
        throw error;
      }
    },
    authorizeObject: async (env, requestId, principal, authorization) => {
      if (principal.actorType === 'ADMIN') return true;
      if (!principal.apiKey) return false;
      try {
        await createApiKeyUseCases(
          env,
          requestId,
        ).authorizeApiKey.execute(principal.apiKey, authorization);
        return true;
      } catch (error) {
        if (
          error instanceof ApiKeyApplicationError &&
          error.code === 'API_KEY_FORBIDDEN'
        ) {
          return false;
        }
        throw error;
      }
    },
    createUseCases,
    createObjectUseCases,
    createMigrationUseCases,
  });
}

export async function runScheduledMaintenance(
  env: Env,
  overrides: WorkerCompositionOverrides = {},
) {
  const configurationIssues = inspectStaticDeploymentConfiguration(env);
  if (configurationIssues.length > 0) {
    throw new Error(
      `Deployment preflight failed: ${configurationIssues.join(',')}`,
    );
  }
  const ids = overrides.idGenerator ?? defaultIdGenerator;
  const clock = overrides.clock ?? defaultClock;
  const requestId = `scheduled:${ids.next()}`;
  const auditOutbox = new D1AuditOutboxRepository(env.DB, {
    requestId,
    idGenerator: () => ids.next(),
  });
  const objects = new D1ObjectRepository(env.DB, auditOutbox);
  const accounts = new D1StorageAccountRepository(env.DB);
  const providers =
    overrides.providerRegistry ?? createStorageProviderRegistry();
  const vault = credentialVaultFor(env, overrides.credentialVault);
  const uploadCleanup = await new SweepExpiredUploads({
    accounts,
    objects,
    providers,
    vault,
    clock,
  }).execute();
  const migrationCleanup = await new SweepShardMigrationCleanup({
    migrations: new D1ShardMigrationRepository(env.DB, auditOutbox),
    accounts,
    providers,
    vault,
    clock,
  }).execute();
  const auditDelivery = await new DrainAuditOutbox({
    outbox: auditOutbox,
    ids,
    clock,
  }).execute();
  return {
    ...uploadCleanup,
    migrationCleanupCandidates: migrationCleanup.candidates,
    migrationsCleaned: migrationCleanup.cleaned,
    migrationsCompleted: migrationCleanup.completedMigrations,
    migrationCleanupFailed: migrationCleanup.failed,
    auditOutboxClaimed: auditDelivery.claimed,
    auditOutboxDelivered: auditDelivery.delivered,
    auditOutboxRetried: auditDelivery.retried,
    auditOutboxFailed: auditDelivery.failed,
  };
}
