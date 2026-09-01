import { availableBytes, type StorageAccount } from './storage-account';

export interface PlacementOptions {
  readonly softLimitRatio?: number;
}

function softLimitBytes(capacityBytes: number, ratio: number): number {
  if (ratio === 0.9) {
    // Avoid binary floating-point rounding at the default 90% boundary.
    return capacityBytes - Math.ceil(capacityBytes / 10);
  }
  return Math.floor(capacityBytes * ratio);
}

/**
 * V1 placement policy: prefer higher priority, then more remaining capacity.
 * Accounts at the soft limit, non-healthy accounts, unknown capacity, and read-only
 * accounts are excluded.
 */
export function selectStorageAccount<TAccount extends StorageAccount>(
  accounts: readonly TAccount[],
  objectSizeBytes: number,
  options: PlacementOptions = {},
): TAccount | undefined {
  if (!Number.isSafeInteger(objectSizeBytes) || objectSizeBytes < 0) {
    throw new RangeError('objectSizeBytes must be a non-negative safe integer');
  }

  const softLimitRatio = options.softLimitRatio ?? 0.9;
  if (
    !Number.isFinite(softLimitRatio) ||
    softLimitRatio <= 0 ||
    softLimitRatio > 1
  ) {
    throw new RangeError('softLimitRatio must be greater than 0 and at most 1');
  }

  return accounts
    .filter((account) => {
      // Check operands before adding: an unsafe intermediate sum must never
      // accidentally pass a floating-point comparison.
      const projectedUsage =
        Number.isSafeInteger(account.usedBytes) &&
        Number.isSafeInteger(objectSizeBytes) &&
        account.usedBytes <= Number.MAX_SAFE_INTEGER - objectSizeBytes
          ? account.usedBytes + objectSizeBytes
          : Number.NaN;
      const healthy = account.healthStatus === 'HEALTHY';
      const capacityKnown = account.capacityAccuracy !== 'UNKNOWN';
      const limit = Number.isSafeInteger(account.capacityBytes)
        ? softLimitBytes(account.capacityBytes, softLimitRatio)
        : Number.NaN;
      return (
        account.status === 'ACTIVE' &&
        account.writeEnabled &&
        healthy &&
        capacityKnown &&
        account.capacityBytes >= 0 &&
        account.usedBytes >= 0 &&
        Number.isSafeInteger(account.capacityBytes) &&
        Number.isSafeInteger(account.usedBytes) &&
        Number.isSafeInteger(projectedUsage) &&
        Number.isSafeInteger(limit) &&
        projectedUsage <= limit
      );
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }

      return availableBytes(right) - availableBytes(left);
    })[0];
}
