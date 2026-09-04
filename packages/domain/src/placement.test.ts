import { describe, expect, it } from 'vitest';

import { selectStorageAccount } from './placement';
import type { StorageAccount } from './storage-account';

const account = (
  overrides: Partial<StorageAccount> & Pick<StorageAccount, 'id'>,
): StorageAccount => {
  const { id, ...rest } = overrides;

  return {
    id,
    name: id,
    provider: 'r2',
    status: 'ACTIVE',
    priority: 0,
    writeEnabled: true,
    capacityBytes: 1_000,
    usedBytes: 0,
    healthStatus: 'HEALTHY',
    capacityAccuracy: 'EXACT',
    providerConfig: {},
    capabilities: {
      presignedUpload: true,
      presignedDownload: true,
      headObject: true,
      deleteObject: true,
      bucketProbe: true,
      usageProbe: true,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastHealthCheckedAt: null,
    ...rest,
  };
};

describe('selectStorageAccount', () => {
  it('prefers priority before remaining capacity', () => {
    const selected = selectStorageAccount(
      [
        account({ id: 'roomy', priority: 1, usedBytes: 100 }),
        account({ id: 'preferred', priority: 10, usedBytes: 700 }),
      ],
      100,
    );

    expect(selected?.id).toBe('preferred');
  });

  it('excludes accounts that would cross the soft limit', () => {
    const selected = selectStorageAccount(
      [
        account({ id: 'almost-full', priority: 10, usedBytes: 850 }),
        account({ id: 'available', priority: 1, usedBytes: 200 }),
      ],
      100,
    );

    expect(selected?.id).toBe('available');
  });

  it('excludes non-active and read-only accounts', () => {
    const selected = selectStorageAccount(
      [
        account({ id: 'draining', status: 'DRAINING' }),
        account({ id: 'read-only', writeEnabled: false }),
      ],
      1,
    );

    expect(selected).toBeUndefined();
  });

  it('excludes non-healthy and unknown-capacity accounts', () => {
    const selected = selectStorageAccount(
      [
        account({ id: 'degraded', healthStatus: 'DEGRADED' }),
        account({ id: 'unknown', capacityAccuracy: 'UNKNOWN' }),
      ],
      1,
    );

    expect(selected).toBeUndefined();
  });

  it('rejects unsafe projected usage instead of overflowing', () => {
    const selected = selectStorageAccount(
      [
        account({
          id: 'overflow',
          capacityBytes: Number.MAX_SAFE_INTEGER,
          usedBytes: Number.MAX_SAFE_INTEGER,
        }),
      ],
      1,
    );

    expect(selected).toBeUndefined();
  });
});
