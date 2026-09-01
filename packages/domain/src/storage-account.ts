export const storageAccountStatuses = [
  'VERIFYING',
  'ACTIVE',
  'DRAINING',
  'READ_ONLY',
  'REMOVED',
] as const;

export type StorageAccountStatus = (typeof storageAccountStatuses)[number];

export const providerKinds = ['r2', 'b2', 's3'] as const;

export type ProviderKind = (typeof providerKinds)[number];

export interface StorageAccount {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderKind;
  readonly status: StorageAccountStatus;
  readonly priority: number;
  readonly writeEnabled: boolean;
  readonly capacityBytes: number;
  readonly usedBytes: number;
}

export function availableBytes(account: StorageAccount): number {
  return Math.max(0, account.capacityBytes - account.usedBytes);
}
