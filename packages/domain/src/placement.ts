import { availableBytes, type StorageAccount } from './storage-account';

export interface PlacementOptions {
  readonly softLimitRatio?: number;
}

/**
 * V1 placement policy: prefer higher priority, then more remaining capacity.
 * Accounts at the soft limit, unhealthy accounts, and read-only accounts are excluded.
 */
export function selectStorageAccount(
  accounts: readonly StorageAccount[],
  objectSizeBytes: number,
  options: PlacementOptions = {},
): StorageAccount | undefined {
  if (!Number.isSafeInteger(objectSizeBytes) || objectSizeBytes < 0) {
    throw new RangeError('objectSizeBytes must be a non-negative safe integer');
  }

  const softLimitRatio = options.softLimitRatio ?? 0.9;
  if (softLimitRatio <= 0 || softLimitRatio > 1) {
    throw new RangeError('softLimitRatio must be greater than 0 and at most 1');
  }

  return accounts
    .filter((account) => {
      const projectedUsage = account.usedBytes + objectSizeBytes;
      return (
        account.status === 'ACTIVE' &&
        account.writeEnabled &&
        projectedUsage <= account.capacityBytes * softLimitRatio
      );
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }

      return availableBytes(right) - availableBytes(left);
    })[0];
}
