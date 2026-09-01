import {
  emptyProviderCapabilities,
  hasWriteCapabilities,
  transitionStorageAccountStatus,
  updateStorageAccountHealth,
  type ProviderKind,
  type StorageAccount,
  type StorageAccountStatus,
} from '@openpool/domain';

import type { AuditLog } from '../ports/auth';
import type {
  Clock,
  IdGenerator,
  ManagedStorageAccountRepository,
  ProviderRegistry,
  ProviderValidationResult,
  StorageAccountConfigurationRepository,
  StorageAccountRecord,
  StorageAccountReferenceRepository,
} from '../ports/storage';
import type { CredentialPayload, CredentialVault } from '../ports/credential-vault';

export type StorageAccountMutationErrorCode =
  | 'STORAGE_ACCOUNT_NOT_FOUND'
  | 'STORAGE_ACCOUNT_VALIDATION_FAILED'
  | 'INVALID_STORAGE_ACCOUNT_INPUT'
  | 'STORAGE_ACCOUNT_REQUIRES_VERIFICATION'
  | 'STORAGE_ACCOUNT_NOT_VERIFYING'
  | 'STORAGE_ACCOUNT_ALREADY_EXISTS'
  | 'STORAGE_ACCOUNT_HAS_REFERENCES'
  | 'STORAGE_ACCOUNT_CONFLICT';

export class StorageAccountApplicationError extends Error {
  constructor(
    readonly code: StorageAccountMutationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StorageAccountApplicationError';
  }
}

export interface CreateStorageAccountCommand {
  readonly actorId: string;
  readonly name: string;
  readonly provider: ProviderKind;
  readonly providerConfig: StorageAccount['providerConfig'];
  readonly credentials: CredentialPayload;
  readonly priority?: number;
  readonly capacityBytes?: number;
  readonly verifyImmediately?: boolean;
}

export interface CreateStorageAccountDependencies {
  readonly accounts: ManagedStorageAccountRepository;
  readonly vault: CredentialVault;
  readonly providers: ProviderRegistry;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly audit: AuditLog;
}

function validateAccountInput(command: CreateStorageAccountCommand): void {
  const name = command.name.trim();
  if (
    !name ||
    name.length > 128 ||
    [...name].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new StorageAccountApplicationError(
      'INVALID_STORAGE_ACCOUNT_INPUT',
      'Storage account name is invalid',
    );
  }
  const priority = command.priority ?? 0;
  const capacity = command.capacityBytes ?? 0;
  if (
    !Number.isSafeInteger(priority) ||
    !Number.isSafeInteger(capacity) ||
    capacity < 0
  ) {
    throw new StorageAccountApplicationError(
      'INVALID_STORAGE_ACCOUNT_INPUT',
      'Storage account priority and capacity must be safe integers',
    );
  }
}

export interface StorageAccountResult {
  readonly account: StorageAccount;
}

export class CreateStorageAccount {
  constructor(private readonly dependencies: CreateStorageAccountDependencies) {}

  async execute(
    command: CreateStorageAccountCommand,
  ): Promise<StorageAccountResult> {
    validateAccountInput(command);
    const now = this.dependencies.clock.now().toISOString();
    const account: StorageAccount = {
      id: this.dependencies.ids.next(),
      name: command.name.trim(),
      provider: command.provider,
      providerConfig: command.providerConfig,
      status: 'VERIFYING',
      priority: command.priority ?? 0,
      writeEnabled: false,
      capacityBytes: command.capacityBytes ?? 0,
      usedBytes: 0,
      healthStatus: 'UNKNOWN',
      capacityAccuracy:
        command.capacityBytes === undefined ? 'UNKNOWN' : 'CONFIGURED',
      capabilities: emptyProviderCapabilities,
      createdAt: now,
      updatedAt: now,
      lastHealthCheckedAt: null,
    };
    const credentialEnvelope = await this.dependencies.vault.encrypt(
      command.credentials,
    );
    if (
      !(await this.dependencies.accounts.create(account, credentialEnvelope))
    ) {
      throw new StorageAccountApplicationError(
        'STORAGE_ACCOUNT_ALREADY_EXISTS',
        'A storage account with this name already exists',
      );
    }
    await this.dependencies.audit.record({
      actorType: 'ADMIN',
      actorId: command.actorId,
      action: 'STORAGE_ACCOUNT_CREATED',
      resourceType: 'STORAGE_ACCOUNT',
      resourceId: account.id,
      createdAt: now,
    });
    if (command.verifyImmediately) {
      return new VerifyStorageAccount(this.dependencies).execute({
        actorId: command.actorId,
        accountId: account.id,
      });
    }
    return { account };
  }
}

export interface UpdateStorageAccountConfigurationCommand {
  readonly actorId: string;
  readonly accountId: string;
  readonly providerConfig?: StorageAccount['providerConfig'];
  readonly credentials?: CredentialPayload;
  readonly expectedUpdatedAt: string;
}

export interface UpdateStorageAccountConfigurationDependencies {
  readonly accounts: ManagedStorageAccountRepository &
    StorageAccountConfigurationRepository;
  readonly vault: CredentialVault;
  readonly clock: Clock;
  readonly audit: AuditLog;
}

function nextUpdatedAt(current: string, now: Date): string {
  const currentMilliseconds = Date.parse(current);
  if (Number.isNaN(currentMilliseconds)) return now.toISOString();
  return new Date(
    Math.max(now.getTime(), currentMilliseconds + 1),
  ).toISOString();
}

export class UpdateStorageAccountConfiguration {
  constructor(
    private readonly dependencies: UpdateStorageAccountConfigurationDependencies,
  ) {}

  async execute(
    command: UpdateStorageAccountConfigurationCommand,
  ): Promise<StorageAccountResult> {
    if (command.providerConfig === undefined && command.credentials === undefined) {
      throw new StorageAccountApplicationError(
        'INVALID_STORAGE_ACCOUNT_INPUT',
        'Provider configuration or credentials must be supplied',
      );
    }
    const record = await this.dependencies.accounts.findById(command.accountId);
    if (!record) throw accountNotFound();
    if (record.status !== 'VERIFYING') {
      throw new StorageAccountApplicationError(
        'STORAGE_ACCOUNT_NOT_VERIFYING',
        'Only a verifying storage account can be corrected',
      );
    }
    if (record.updatedAt !== command.expectedUpdatedAt) {
      throw new StorageAccountApplicationError(
        'STORAGE_ACCOUNT_CONFLICT',
        'Storage account changed while the operation was in progress',
      );
    }

    const credentialEnvelope = command.credentials
      ? await this.dependencies.vault.encrypt(command.credentials)
      : record.credentialEnvelope;
    const changedAt = nextUpdatedAt(
      record.updatedAt,
      this.dependencies.clock.now(),
    );
    const { credentialEnvelope: _credentialEnvelope, ...safeRecord } = record;
    const account: StorageAccount = {
      ...safeRecord,
      providerConfig: command.providerConfig ?? record.providerConfig,
      writeEnabled: false,
      healthStatus: 'UNKNOWN',
      capabilities: emptyProviderCapabilities,
      lastHealthCheckedAt: null,
      updatedAt: changedAt,
    };
    if (
      !(await this.dependencies.accounts.updateVerifyingConfiguration(
        account,
        credentialEnvelope,
        command.expectedUpdatedAt,
      ))
    ) {
      throw new StorageAccountApplicationError(
        'STORAGE_ACCOUNT_CONFLICT',
        'Storage account changed while the operation was in progress',
      );
    }
    await this.dependencies.audit.record({
      actorType: 'ADMIN',
      actorId: command.actorId,
      action: 'STORAGE_ACCOUNT_CONFIGURATION_UPDATED',
      resourceType: 'STORAGE_ACCOUNT',
      resourceId: account.id,
      createdAt: changedAt,
      metadata: {
        providerConfigChanged: String(command.providerConfig !== undefined),
        credentialsChanged: String(command.credentials !== undefined),
      },
    });
    return { account };
  }
}

export interface VerifyStorageAccountDependencies {
  readonly accounts: ManagedStorageAccountRepository;
  readonly vault: CredentialVault;
  readonly providers: ProviderRegistry;
  readonly clock: Clock;
  readonly audit: AuditLog;
}

function verificationFailed(message: string): StorageAccountApplicationError {
  return new StorageAccountApplicationError(
    'STORAGE_ACCOUNT_VALIDATION_FAILED',
    message,
  );
}

function hasUsableCapacity(
  capacityBytes: number | null,
  usedBytes: number | null,
  accuracy: StorageAccount['capacityAccuracy'],
): capacityBytes is number {
  return (
    accuracy !== 'UNKNOWN' &&
    capacityBytes !== null &&
    usedBytes !== null &&
    Number.isSafeInteger(capacityBytes) &&
    capacityBytes >= 0 &&
    Number.isSafeInteger(usedBytes) &&
    usedBytes >= 0 &&
    usedBytes <= capacityBytes
  );
}

function mergeCapacityObservation(
  record: StorageAccountRecord,
  probe: {
    readonly healthStatus: StorageAccount['healthStatus'];
    readonly capacityBytes: number | null;
    readonly usedBytes: number | null;
    readonly capacityAccuracy: StorageAccount['capacityAccuracy'];
  },
): Pick<StorageAccount, 'capacityBytes' | 'usedBytes' | 'capacityAccuracy'> {
  if (probe.capacityAccuracy === 'UNKNOWN') {
    return {
      capacityBytes: record.capacityBytes,
      usedBytes: record.usedBytes,
      capacityAccuracy: record.capacityAccuracy,
    };
  }

  if (probe.capacityBytes === null || probe.usedBytes === null) {
    throw verificationFailed(
      'Provider returned incomplete capacity information',
    );
  }

  return {
    capacityBytes: probe.capacityBytes,
    usedBytes: probe.usedBytes,
    capacityAccuracy: probe.capacityAccuracy,
  };
}

function accountWithVerification(
  record: StorageAccountRecord,
  validation: ProviderValidationResult,
  probe: {
    readonly healthStatus: StorageAccount['healthStatus'];
    readonly capacityBytes: number | null;
    readonly usedBytes: number | null;
    readonly capacityAccuracy: StorageAccount['capacityAccuracy'];
  },
  checkedAt: string,
): StorageAccount {
  const capacity = mergeCapacityObservation(record, probe);
  if (
    probe.healthStatus !== 'HEALTHY' ||
    !hasUsableCapacity(
      capacity.capacityBytes,
      capacity.usedBytes,
      capacity.capacityAccuracy,
    ) ||
    !hasWriteCapabilities(validation.capabilities)
  ) {
    throw verificationFailed(
      'Provider verification did not report required capabilities, healthy status, and usable capacity',
    );
  }
  const verified = updateStorageAccountHealth(
    { ...record, capabilities: validation.capabilities },
    probe.healthStatus,
    capacity,
    checkedAt,
  );
  return {
    ...transitionStorageAccountStatus(verified, 'ACTIVE'),
    updatedAt: checkedAt,
  };
}

export class VerifyStorageAccount {
  constructor(private readonly dependencies: VerifyStorageAccountDependencies) {}

  async execute(command: {
    readonly actorId: string;
    readonly accountId: string;
  }): Promise<StorageAccountResult> {
    const record = await this.dependencies.accounts.findById(command.accountId);
    if (!record) throw accountNotFound();
    if (record.status !== 'VERIFYING') {
      throw new StorageAccountApplicationError(
        'STORAGE_ACCOUNT_NOT_VERIFYING',
        'Only a verifying storage account can be verified',
      );
    }
    const credentials = await this.dependencies.vault.decrypt(
      record.credentialEnvelope,
    );
    const provider = this.dependencies.providers.forAccount(record);
    const validation = await provider.validate(
      credentials,
      record.providerConfig,
    );
    const probe = await provider.probe(credentials, record.providerConfig);
    const checkedAt = this.dependencies.clock.now().toISOString();
    const account = accountWithVerification(record, validation, probe, checkedAt);
    await updateAccountOrThrow(
      this.dependencies.accounts,
      account,
      record.status,
      record.updatedAt,
    );
    await this.dependencies.audit.record({
      actorType: 'ADMIN',
      actorId: command.actorId,
      action: 'STORAGE_ACCOUNT_VERIFIED',
      resourceType: 'STORAGE_ACCOUNT',
      resourceId: account.id,
      createdAt: checkedAt,
    });
    return { account };
  }
}

export class ListStorageAccounts {
  constructor(
    private readonly accounts: Pick<ManagedStorageAccountRepository, 'list'>,
  ) {}

  async execute(): Promise<readonly StorageAccount[]> {
    return (await this.accounts.list()).map(
      ({ credentialEnvelope: _credentialEnvelope, ...account }) => account,
    );
  }
}

export interface TransitionStorageAccountDependencies {
  readonly accounts: ManagedStorageAccountRepository &
    StorageAccountReferenceRepository;
  readonly clock: Clock;
  readonly audit: AuditLog;
}

export class TransitionStorageAccount {
  constructor(
    private readonly dependencies: TransitionStorageAccountDependencies,
  ) {}

  async execute(command: {
    readonly actorId: string;
    readonly accountId: string;
    readonly status: StorageAccountStatus;
  }): Promise<StorageAccount> {
    const record = await this.dependencies.accounts.findById(command.accountId);
    if (!record) throw accountNotFound();
    if (record.status === 'VERIFYING' && command.status === 'ACTIVE') {
      throw new StorageAccountApplicationError(
        'STORAGE_ACCOUNT_REQUIRES_VERIFICATION',
        'Storage account must pass provider verification before activation',
      );
    }
    if (
      command.status === 'REMOVED' &&
      (record.usedBytes !== 0 ||
        (await this.dependencies.accounts.hasBlockingReferences(record.id)))
    ) {
      throw new StorageAccountApplicationError(
        'STORAGE_ACCOUNT_HAS_REFERENCES',
        'Storage account still has live shards or objects',
      );
    }
    const now = this.dependencies.clock.now().toISOString();
    const account = {
      ...transitionStorageAccountStatus(record, command.status),
      updatedAt: now,
    };
    await updateAccountOrThrow(
      this.dependencies.accounts,
      account,
      record.status,
      record.updatedAt,
    );
    await this.dependencies.audit.record({
      actorType: 'ADMIN',
      actorId: command.actorId,
      action: 'STORAGE_ACCOUNT_STATUS_CHANGED',
      resourceType: 'STORAGE_ACCOUNT',
      resourceId: account.id,
      createdAt: now,
      metadata: { from: record.status, to: account.status },
    });
    return account;
  }
}

export interface RefreshStorageAccountHealthDependencies {
  readonly accounts: ManagedStorageAccountRepository;
  readonly vault: CredentialVault;
  readonly providers: ProviderRegistry;
  readonly clock: Clock;
  readonly audit: AuditLog;
}

export class RefreshStorageAccountHealth {
  constructor(
    private readonly dependencies: RefreshStorageAccountHealthDependencies,
  ) {}

  async execute(command: {
    readonly actorId: string;
    readonly accountId: string;
  }): Promise<StorageAccount> {
    const record = await this.dependencies.accounts.findById(command.accountId);
    if (!record) throw accountNotFound();
    const credentials = await this.dependencies.vault.decrypt(
      record.credentialEnvelope,
    );
    const provider = this.dependencies.providers.forAccount(record);
    const probe = await provider.probe(credentials, record.providerConfig);
    const checkedAt = this.dependencies.clock.now().toISOString();
    const account = {
      ...updateStorageAccountHealth(
        record,
        probe.healthStatus,
        mergeCapacityObservation(record, probe),
        checkedAt,
      ),
      updatedAt: checkedAt,
    };
    await updateAccountOrThrow(
      this.dependencies.accounts,
      account,
      record.status,
      record.updatedAt,
    );
    await this.dependencies.audit.record({
      actorType: 'ADMIN',
      actorId: command.actorId,
      action: 'STORAGE_ACCOUNT_HEALTH_REFRESHED',
      resourceType: 'STORAGE_ACCOUNT',
      resourceId: account.id,
      createdAt: checkedAt,
      metadata: {
        healthStatus: account.healthStatus,
        capacityAccuracy: account.capacityAccuracy,
      },
    });
    return account;
  }
}

function accountNotFound(): StorageAccountApplicationError {
  return new StorageAccountApplicationError(
    'STORAGE_ACCOUNT_NOT_FOUND',
    'Storage account was not found',
  );
}

async function updateAccountOrThrow(
  accounts: ManagedStorageAccountRepository,
  account: StorageAccount,
  expectedStatus: StorageAccountStatus,
  expectedUpdatedAt: string,
): Promise<void> {
  if (!(await accounts.update(account, expectedStatus, expectedUpdatedAt))) {
    throw new StorageAccountApplicationError(
      'STORAGE_ACCOUNT_CONFLICT',
      'Storage account changed while the operation was in progress',
    );
  }
}
