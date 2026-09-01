import type { ProviderCapabilities } from './provider';

export const storageAccountStatuses = [
  'VERIFYING',
  'ACTIVE',
  'DRAINING',
  'READ_ONLY',
  'REMOVED',
] as const;

export type StorageAccountStatus = (typeof storageAccountStatuses)[number];

export const storageHealthStatuses = [
  'UNKNOWN',
  'HEALTHY',
  'DEGRADED',
  'UNHEALTHY',
] as const;

export type StorageHealthStatus = (typeof storageHealthStatuses)[number];

export const capacityAccuracies = [
  'EXACT',
  'ESTIMATED',
  'CONFIGURED',
  'UNKNOWN',
] as const;

export type CapacityAccuracy = (typeof capacityAccuracies)[number];

export const providerKinds = ['r2', 'b2', 's3'] as const;

export type ProviderKind = (typeof providerKinds)[number];

export type ProviderConfigValue = string | number | boolean | null;
export type ProviderConfig = Readonly<Record<string, ProviderConfigValue>>;

export interface StorageAccount {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderKind;
  readonly status: StorageAccountStatus;
  readonly priority: number;
  readonly writeEnabled: boolean;
  readonly capacityBytes: number;
  readonly usedBytes: number;
  readonly healthStatus: StorageHealthStatus;
  /** How trustworthy capacityBytes/usedBytes are. */
  readonly capacityAccuracy: CapacityAccuracy;
  /** Non-secret provider settings such as endpoint, account ID, or region. */
  readonly providerConfig: ProviderConfig;
  /** Provider feature set discovered during verification. */
  readonly capabilities: ProviderCapabilities;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastHealthCheckedAt: string | null;
}

export function availableBytes(account: StorageAccount): number {
  return Math.max(0, account.capacityBytes - account.usedBytes);
}

const allowedTransitions: Readonly<
  Record<StorageAccountStatus, readonly StorageAccountStatus[]>
> = {
  VERIFYING: ['ACTIVE'],
  ACTIVE: ['DRAINING'],
  DRAINING: ['READ_ONLY'],
  READ_ONLY: ['REMOVED'],
  REMOVED: [],
};

export class StorageAccountStateError extends Error {
  readonly code = 'INVALID_STORAGE_ACCOUNT_STATE_TRANSITION' as const;

  constructor(
    readonly from: StorageAccountStatus,
    readonly to: StorageAccountStatus,
  ) {
    super(`Cannot transition storage account from ${from} to ${to}`);
    this.name = 'StorageAccountStateError';
  }
}

/** Apply the only legal lifecycle transition and derive write access from state. */
export function transitionStorageAccountStatus(
  account: StorageAccount,
  nextStatus: StorageAccountStatus,
): StorageAccount {
  if (!allowedTransitions[account.status].includes(nextStatus)) {
    throw new StorageAccountStateError(account.status, nextStatus);
  }

  return {
    ...account,
    status: nextStatus,
    writeEnabled: nextStatus === 'ACTIVE',
  };
}

export const transitionStorageAccount = transitionStorageAccountStatus;

/** The lifecycle is intentionally conservative: only ACTIVE accepts new writes. */
export function writeEnabledForStatus(status: StorageAccountStatus): boolean {
  return status === 'ACTIVE';
}

export function updateStorageAccountHealth(
  account: StorageAccount,
  healthStatus: StorageHealthStatus,
  capacity: Pick<StorageAccount, 'capacityBytes' | 'usedBytes'> & {
    capacityAccuracy: CapacityAccuracy;
  },
  lastHealthCheckedAt: string,
): StorageAccount {
  if (
    !Number.isSafeInteger(capacity.capacityBytes) ||
    capacity.capacityBytes < 0 ||
    !Number.isSafeInteger(capacity.usedBytes) ||
    capacity.usedBytes < 0 ||
    capacity.usedBytes > capacity.capacityBytes
  ) {
    throw new RangeError(
      'Provider capacity must be safe, non-negative, and consistent',
    );
  }

  return {
    ...account,
    healthStatus,
    capacityBytes: capacity.capacityBytes,
    usedBytes: capacity.usedBytes,
    capacityAccuracy: capacity.capacityAccuracy,
    lastHealthCheckedAt,
  };
}
