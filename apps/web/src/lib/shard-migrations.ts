import type {
  StorageAccountResponse,
  StorageShardResponse,
} from '@openpool/contracts';

function softAvailable(capacityBytes: number, usedBytes: number): number {
  return capacityBytes - Math.ceil(capacityBytes / 10) - usedBytes;
}

function hasMigrationCapabilities(account: StorageAccountResponse): boolean {
  const capabilities = account.capabilities;
  return (
    capabilities.presignedUpload &&
    capabilities.presignedDownload &&
    capabilities.headObject &&
    capabilities.deleteObject &&
    capabilities.bucketProbe
  );
}

/** Mirrors the server's fail-closed target preflight; the server remains authoritative. */
export function eligibleMigrationTargets(
  source: StorageShardResponse,
  shards: readonly StorageShardResponse[],
  accounts: readonly StorageAccountResponse[],
): readonly StorageShardResponse[] {
  const sourceAccount = accounts.find(
    (account) => account.id === source.storageAccountId,
  );
  if (source.status !== 'ACTIVE' || sourceAccount?.status !== 'DRAINING') {
    return [];
  }
  return shards.filter((target) => {
    const account = accounts.find(
      (candidate) => candidate.id === target.storageAccountId,
    );
    return (
      target.id !== source.id &&
      target.status === 'STANDBY' &&
      account?.status === 'ACTIVE' &&
      account.writeEnabled &&
      account.healthStatus === 'HEALTHY' &&
      account.capacityAccuracy !== 'UNKNOWN' &&
      hasMigrationCapabilities(account) &&
      softAvailable(target.capacityBytes, target.usedBytes) >= source.usedBytes &&
      softAvailable(account.capacityBytes, account.usedBytes) >= source.usedBytes
    );
  });
}
