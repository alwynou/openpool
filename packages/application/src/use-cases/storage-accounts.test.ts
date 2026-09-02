import type { ProviderCapabilities, StorageAccount } from '@openpool/domain';
import { describe, expect, it } from 'vitest';

import type { AuditLog, AuditLogEntry } from '../ports/auth';
import type {
  CredentialEnvelope,
  CredentialPayload,
  CredentialVault,
} from '../ports/credential-vault';
import type {
  ManagedStorageAccountRepository,
  ProviderProbeResult,
  ProviderRegistry,
  SignedUpload,
  StorageAccountRecord,
  StorageProvider,
  UploadUrlRequest,
  Clock,
} from '../ports/storage';
import {
  CreateStorageAccount,
  ListStorageAccounts,
  RefreshStorageAccountHealth,
  StorageAccountApplicationError,
  TransitionStorageAccount,
  UpdateStorageAccountConfiguration,
  VerifyStorageAccount,
} from './storage-accounts';

const envelope: CredentialEnvelope = {
  version: 1,
  algorithm: 'AES-256-GCM',
  keyId: 'key-1',
  iv: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'encrypted',
};

class FakeVault implements CredentialVault {
  encrypted?: CredentialPayload;
  decryptCalls = 0;
  decrypted: CredentialPayload = { accessKeyId: 'access-key' };

  async encrypt(payload: CredentialPayload): Promise<CredentialEnvelope> {
    this.encrypted = payload;
    return envelope;
  }

  async decrypt(): Promise<CredentialPayload> {
    this.decryptCalls += 1;
    return this.decrypted;
  }
}

class FakeProvider implements StorageProvider {
  readonly validations: CredentialPayload[] = [];
  readonly configs: Record<string, unknown>[] = [];
  probeResult: ProviderProbeResult = {
    healthStatus: 'HEALTHY',
    capacityBytes: 10_000,
    usedBytes: 2_000,
    capacityAccuracy: 'EXACT',
  };

  async createUploadUrl(_request: UploadUrlRequest): Promise<SignedUpload> {
    return { url: 'https://provider/upload', expiresAt: '2026-01-01T00:15:00.000Z' };
  }

  async createDownloadUrl() {
    return { url: 'https://provider/download', expiresAt: '2026-01-01T00:15:00.000Z' };
  }

  async headObject() {
    return { sizeBytes: 0, etag: null, checksum: null };
  }

  async deleteObject(): Promise<void> {}

  readonly capabilities = {
    presignedUpload: true,
    presignedDownload: true,
    headObject: true,
    deleteObject: true,
    bucketProbe: true,
    usageProbe: true,
  };

  async validate(credentials: CredentialPayload, config: StorageAccount['providerConfig']): Promise<{ capabilities: ProviderCapabilities }> {
    this.validations.push(credentials);
    this.configs.push(config);
    return { capabilities: this.capabilities };
  }

  async probe(): Promise<ProviderProbeResult> {
    return this.probeResult;
  }
}

class FakeAccounts implements ManagedStorageAccountRepository {
  readonly records = new Map<string, StorageAccountRecord>();
  audit?: AuditLog;
  forceConflict = false;
  blockingReferences = false;
  updates = 0;

  async create(
    account: StorageAccount,
    credentialEnvelope: CredentialEnvelope,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    if (
      [...this.records.values()].some(({ name }) => name === account.name)
    ) {
      return false;
    }
    this.records.set(account.id, { ...account, credentialEnvelope });
    await this.audit?.record(audit);
    return true;
  }

  async findById(id: string): Promise<StorageAccountRecord | undefined> {
    return this.records.get(id);
  }

  async list(): Promise<readonly StorageAccountRecord[]> {
    return [...this.records.values()];
  }

  async update(
    account: StorageAccount,
    expectedStatus: StorageAccount['status'],
    _expectedUpdatedAt: string,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    this.updates += 1;
    if (this.forceConflict) return false;
    const record = this.records.get(account.id);
    if (!record || record.status !== expectedStatus) return false;
    this.records.set(account.id, {
      ...account,
      credentialEnvelope: record.credentialEnvelope,
    });
    await this.audit?.record(audit);
    return true;
  }

  async updateVerifyingConfiguration(
    account: StorageAccount,
    credentialEnvelope: CredentialEnvelope,
    expectedUpdatedAt: string,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    this.updates += 1;
    if (this.forceConflict) return false;
    const record = this.records.get(account.id);
    if (
      !record ||
      record.status !== 'VERIFYING' ||
      record.updatedAt !== expectedUpdatedAt
    ) {
      return false;
    }
    this.records.set(account.id, { ...account, credentialEnvelope });
    await this.audit?.record(audit);
    return true;
  }

  async listWritable(): Promise<readonly StorageAccountRecord[]> {
    return [...this.records.values()].filter((account) => account.writeEnabled);
  }

  async hasBlockingReferences(): Promise<boolean> {
    return this.blockingReferences;
  }
}

class FakeAudit implements AuditLog {
  readonly actions: string[] = [];

  async record(entry: { action: string }): Promise<void> {
    this.actions.push(entry.action);
  }
}

class FakeClock implements Clock {
  now(): Date {
    return new Date('2026-01-01T00:00:00.000Z');
  }
}

function dependencies() {
  const accounts = new FakeAccounts();
  const vault = new FakeVault();
  const provider = new FakeProvider();
  const audit = new FakeAudit();
  accounts.audit = audit;
  const providers: ProviderRegistry = {
    forAccount: () => provider,
  };
  return { accounts, vault, provider, audit, providers, clock: new FakeClock() };
}

function create(deps: ReturnType<typeof dependencies>) {
  return new CreateStorageAccount({
    ...deps,
    ids: { next: () => 'account-1' },
  });
}

describe('storage account use cases', () => {
  it('encrypts credentials before persisting a VERIFYING account', async () => {
    const deps = dependencies();
    const credentials = { accessKeyId: 'access-key', secretAccessKey: 'secret' };
    const result = await create(deps).execute({
      actorId: 'admin-1',
      name: '  R2 primary  ',
      provider: 'r2',
      providerConfig: { endpoint: 'https://r2.example', accountId: 'acc-1' },
      credentials,
      capacityBytes: 1_000,
    });

    expect(result.account).toMatchObject({
      name: 'R2 primary',
      status: 'VERIFYING',
      writeEnabled: false,
      healthStatus: 'UNKNOWN',
      capacityAccuracy: 'CONFIGURED',
    });
    expect(deps.vault.encrypted).toEqual(credentials);
    expect((await deps.accounts.findById('account-1'))?.credentialEnvelope).toBe(
      envelope,
    );
    expect(deps.audit.actions).toEqual(['STORAGE_ACCOUNT_CREATED']);
  });

  it('reports duplicate account names without writing a second audit entry', async () => {
    const deps = dependencies();
    const command = {
      actorId: 'admin-1',
      name: 'R2 primary',
      provider: 'r2' as const,
      providerConfig: {},
      credentials: {},
    };
    await create(deps).execute(command);

    await expect(create(deps).execute(command)).rejects.toMatchObject({
      code: 'STORAGE_ACCOUNT_ALREADY_EXISTS',
    });
    expect(deps.accounts.records).toHaveLength(1);
    expect(deps.audit.actions).toEqual(['STORAGE_ACCOUNT_CREATED']);
  });

  it('updates verifying provider configuration while retaining credentials', async () => {
    const deps = dependencies();
    await create(deps).execute({
      actorId: 'admin-1',
      name: 'R2 primary',
      provider: 'r2',
      providerConfig: { validationBucket: 'old-bucket' },
      credentials: { accessKeyId: 'old-access', secretAccessKey: 'old-secret' },
    });
    delete deps.vault.encrypted;

    const result = await new UpdateStorageAccountConfiguration(deps).execute({
      actorId: 'admin-1',
      accountId: 'account-1',
      providerConfig: { validationBucket: 'new-bucket' },
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(result.account).toMatchObject({
      status: 'VERIFYING',
      writeEnabled: false,
      providerConfig: { validationBucket: 'new-bucket' },
      healthStatus: 'UNKNOWN',
      lastHealthCheckedAt: null,
      updatedAt: '2026-01-01T00:00:00.001Z',
    });
    expect(deps.vault.encrypted).toBeUndefined();
    expect(deps.accounts.records.get('account-1')?.credentialEnvelope).toBe(
      envelope,
    );
    expect(deps.audit.actions).toEqual([
      'STORAGE_ACCOUNT_CREATED',
      'STORAGE_ACCOUNT_CONFIGURATION_UPDATED',
    ]);
  });

  it('replaces verifying credentials while retaining provider configuration', async () => {
    const deps = dependencies();
    await create(deps).execute({
      actorId: 'admin-1',
      name: 'R2 primary',
      provider: 'r2',
      providerConfig: { validationBucket: 'unchanged' },
      credentials: { accessKeyId: 'old-access', secretAccessKey: 'old-secret' },
    });
    const credentials = {
      accessKeyId: 'new-access',
      secretAccessKey: 'new-secret',
    };

    const result = await new UpdateStorageAccountConfiguration(deps).execute({
      actorId: 'admin-1',
      accountId: 'account-1',
      credentials,
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(result.account.providerConfig).toEqual({
      validationBucket: 'unchanged',
    });
    expect(deps.vault.encrypted).toEqual(credentials);
    expect(JSON.stringify(result)).not.toContain('new-secret');
  });

  it('rejects stale or active configuration updates before encrypting', async () => {
    const deps = dependencies();
    await create(deps).execute({
      actorId: 'admin-1',
      name: 'R2 primary',
      provider: 'r2',
      providerConfig: {},
      credentials: {},
    });
    delete deps.vault.encrypted;
    const update = new UpdateStorageAccountConfiguration(deps);

    await expect(
      update.execute({
        actorId: 'admin-1',
        accountId: 'account-1',
        credentials: { accessKeyId: 'new', secretAccessKey: 'secret' },
        expectedUpdatedAt: '2025-12-31T23:59:59.000Z',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_CONFLICT' });
    expect(deps.vault.encrypted).toBeUndefined();

    const record = deps.accounts.records.get('account-1');
    if (!record) throw new Error('Missing account fixture');
    deps.accounts.records.set('account-1', {
      ...record,
      status: 'ACTIVE',
      writeEnabled: true,
    });
    await expect(
      update.execute({
        actorId: 'admin-1',
        accountId: 'account-1',
        providerConfig: {},
        expectedUpdatedAt: record.updatedAt,
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_NOT_VERIFYING' });
    expect(deps.vault.encrypted).toBeUndefined();
    expect(deps.audit.actions).toEqual(['STORAGE_ACCOUNT_CREATED']);
  });

  it('does not audit a configuration update that loses its atomic write', async () => {
    const deps = dependencies();
    await create(deps).execute({
      actorId: 'admin-1',
      name: 'R2 primary',
      provider: 'r2',
      providerConfig: {},
      credentials: {},
    });
    deps.accounts.forceConflict = true;

    await expect(
      new UpdateStorageAccountConfiguration(deps).execute({
        actorId: 'admin-1',
        accountId: 'account-1',
        providerConfig: { validationBucket: 'new-bucket' },
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_CONFLICT' });
    expect(deps.audit.actions).toEqual(['STORAGE_ACCOUNT_CREATED']);
  });

  it('requires configuration or credentials before reading an account', async () => {
    const deps = dependencies();

    await expect(
      new UpdateStorageAccountConfiguration(deps).execute({
        actorId: 'admin-1',
        accountId: 'missing',
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STORAGE_ACCOUNT_INPUT' });
    expect(deps.accounts.updates).toBe(0);
    expect(deps.audit.actions).toEqual([]);
  });

  it('validates credentials and activates only after provider validation', async () => {
    const deps = dependencies();
    await create(deps).execute({
      actorId: 'admin-1',
      name: 'R2 primary',
      provider: 'r2',
      providerConfig: { endpoint: 'https://r2.example' },
      credentials: { accessKeyId: 'access-key' },
    });

    const result = await new VerifyStorageAccount(deps).execute({
      actorId: 'admin-1',
      accountId: 'account-1',
    });
    expect(result.account.status).toBe('ACTIVE');
    expect(result.account.writeEnabled).toBe(true);
    expect(deps.provider.validations).toHaveLength(1);
    expect(deps.provider.configs).toEqual([{ endpoint: 'https://r2.example' }]);
    expect(deps.audit.actions).toEqual([
      'STORAGE_ACCOUNT_CREATED',
      'STORAGE_ACCOUNT_VERIFIED',
    ]);
  });

  it('does not update or activate when provider verification is unhealthy', async () => {
    const deps = dependencies();
    await create(deps).execute({
      actorId: 'admin-1',
      name: 'A',
      provider: 'r2',
      providerConfig: {},
      credentials: {},
    });
    deps.provider.probeResult = {
      healthStatus: 'DEGRADED',
      capacityBytes: 10_000,
      usedBytes: 2_000,
      capacityAccuracy: 'EXACT',
    };
    await expect(
      new VerifyStorageAccount(deps).execute({
        actorId: 'admin-1',
        accountId: 'account-1',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_VALIDATION_FAILED' });
    expect(deps.accounts.updates).toBe(0);
    expect(deps.audit.actions).toEqual(['STORAGE_ACCOUNT_CREATED']);
  });

  it('does not audit verification when the account changed concurrently', async () => {
    const deps = dependencies();
    await create(deps).execute({
      actorId: 'admin-1',
      name: 'R2 primary',
      provider: 'r2',
      providerConfig: {},
      credentials: {},
    });
    deps.accounts.forceConflict = true;

    await expect(
      new VerifyStorageAccount(deps).execute({
        actorId: 'admin-1',
        accountId: 'account-1',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_CONFLICT' });
    expect(deps.audit.actions).toEqual(['STORAGE_ACCOUNT_CREATED']);
  });

  it('uses explicitly configured capacity when the provider cannot report usage', async () => {
    const deps = dependencies();
    await create(deps).execute({
      actorId: 'admin-1',
      name: 'R2 configured capacity',
      provider: 'r2',
      providerConfig: {},
      credentials: {},
      capacityBytes: 25_000,
    });
    deps.provider.probeResult = {
      healthStatus: 'HEALTHY',
      capacityBytes: null,
      usedBytes: null,
      capacityAccuracy: 'UNKNOWN',
    };

    const verified = await new VerifyStorageAccount(deps).execute({
      actorId: 'admin-1',
      accountId: 'account-1',
    });

    expect(verified.account).toMatchObject({
      status: 'ACTIVE',
      capacityBytes: 25_000,
      usedBytes: 0,
      capacityAccuracy: 'CONFIGURED',
    });
  });

  it('supports explicit verify-on-create while retaining the verification boundary', async () => {
    const deps = dependencies();
    const result = await create(deps).execute({
      actorId: 'admin-1',
      name: 'R2 primary',
      provider: 'r2',
      providerConfig: {},
      credentials: {},
      verifyImmediately: true,
    });
    expect(result.account.status).toBe('ACTIVE');
    expect(deps.audit.actions).toEqual([
      'STORAGE_ACCOUNT_CREATED',
      'STORAGE_ACCOUNT_VERIFIED',
    ]);
  });

  it('lists accounts, requires verification, and audits lifecycle mutations', async () => {
    const deps = dependencies();
    await create(deps).execute({ actorId: 'admin-1', name: 'A', provider: 'r2', providerConfig: {}, credentials: {} });
    const list = await new ListStorageAccounts(deps.accounts).execute();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('credentialEnvelope');

    await expect(new TransitionStorageAccount(deps).execute({
      actorId: 'admin-1',
      accountId: 'account-1',
      status: 'ACTIVE',
    })).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_REQUIRES_VERIFICATION' });
    await new VerifyStorageAccount(deps).execute({ actorId: 'admin-1', accountId: 'account-1' });
    const changed = await new TransitionStorageAccount(deps).execute({
      actorId: 'admin-1',
      accountId: 'account-1',
      status: 'DRAINING',
    });
    expect(changed.writeEnabled).toBe(false);
    expect(deps.audit.actions).toEqual([
      'STORAGE_ACCOUNT_CREATED',
      'STORAGE_ACCOUNT_VERIFIED',
      'STORAGE_ACCOUNT_STATUS_CHANGED',
    ]);
    await expect(
      new VerifyStorageAccount(deps).execute({
        actorId: 'admin-1',
        accountId: 'account-1',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_NOT_VERIFYING' });
  });

  it('refreshes provider health and capacity without exposing credentials', async () => {
    const deps = dependencies();
    await create(deps).execute({ actorId: 'admin-1', name: 'A', provider: 'r2', providerConfig: {}, credentials: {} });
    const refreshed = await new RefreshStorageAccountHealth(deps).execute({
      actorId: 'admin-1',
      accountId: 'account-1',
    });
    expect(refreshed).toMatchObject({
      healthStatus: 'HEALTHY',
      capacityBytes: 10_000,
      usedBytes: 2_000,
      capacityAccuracy: 'EXACT',
    });
    expect(JSON.stringify(deps.audit.actions)).not.toContain('secret');
  });

  it('does not finish draining or remove while live references remain', async () => {
    const deps = dependencies();
    await create(deps).execute({
      actorId: 'admin-1',
      name: 'A',
      provider: 'r2',
      providerConfig: {},
      credentials: {},
      verifyImmediately: true,
    });
    const transition = new TransitionStorageAccount(deps);
    await transition.execute({
      actorId: 'admin-1',
      accountId: 'account-1',
      status: 'DRAINING',
    });
    deps.accounts.blockingReferences = true;
    await expect(
      transition.execute({
        actorId: 'admin-1',
        accountId: 'account-1',
        status: 'READ_ONLY',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_HAS_REFERENCES' });
    const draining = deps.accounts.records.get('account-1');
    if (!draining) throw new Error('Missing account fixture');
    deps.accounts.records.set('account-1', { ...draining, usedBytes: 0 });
    deps.accounts.blockingReferences = false;
    await transition.execute({
      actorId: 'admin-1',
      accountId: 'account-1',
      status: 'READ_ONLY',
    });
    deps.accounts.blockingReferences = true;

    await expect(
      transition.execute({
        actorId: 'admin-1',
        accountId: 'account-1',
        status: 'REMOVED',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_HAS_REFERENCES' });
    expect(deps.accounts.records.get('account-1')?.status).toBe('READ_ONLY');
  });

  it('reports insufficient provider capabilities as stable application errors', async () => {
    const deps = dependencies();
    await create(deps).execute({ actorId: 'admin-1', name: 'A', provider: 'r2', providerConfig: {}, credentials: {} });
    const provider: StorageProvider = {
      capabilities: {
        presignedUpload: false,
        presignedDownload: false,
        headObject: false,
        deleteObject: false,
        bucketProbe: false,
        usageProbe: false,
      },
      createUploadUrl: async () => ({
        url: 'https://provider/upload',
        expiresAt: '2026-01-01T00:15:00.000Z',
      }),
      createDownloadUrl: async () => ({
        url: 'https://provider/download',
        expiresAt: '2026-01-01T00:15:00.000Z',
      }),
      headObject: async () => ({ sizeBytes: 0, etag: null, checksum: null }),
      deleteObject: async () => {},
      validate: async () => ({ capabilities: {
        presignedUpload: false,
        presignedDownload: false,
        headObject: false,
        deleteObject: false,
        bucketProbe: false,
        usageProbe: false,
      } }),
      probe: async () => ({ healthStatus: 'UNHEALTHY', capacityBytes: null, usedBytes: null, capacityAccuracy: 'UNKNOWN' }),
    };
    deps.providers.forAccount = () => provider;
    await expect(
      new VerifyStorageAccount(deps).execute({ actorId: 'admin-1', accountId: 'account-1' }),
    ).rejects.toBeInstanceOf(StorageAccountApplicationError);
  });

  it('fails for a missing account before decrypting credentials', async () => {
    const deps = dependencies();
    await expect(
      new VerifyStorageAccount(deps).execute({ actorId: 'admin-1', accountId: 'missing' }),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCOUNT_NOT_FOUND' });
    expect(deps.vault.decryptCalls).toBe(0);
  });
});
