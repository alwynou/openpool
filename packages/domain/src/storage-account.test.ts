import { describe, expect, it } from 'vitest';

import {
  StorageAccountStateError,
  transitionStorageAccountStatus,
  updateStorageAccountHealth,
  type StorageAccount,
} from './storage-account';

const account: StorageAccount = {
  id: 'account-1',
  name: 'Primary',
  provider: 's3',
  status: 'VERIFYING',
  priority: 2,
  writeEnabled: false,
  capacityBytes: 1_000,
  usedBytes: 100,
  healthStatus: 'UNKNOWN',
  capacityAccuracy: 'CONFIGURED',
  providerConfig: { endpoint: 'https://example.test', region: 'auto' },
  capabilities: {
    presignedUpload: false,
    presignedDownload: false,
    headObject: false,
    deleteObject: false,
    bucketProbe: false,
    usageProbe: false,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastHealthCheckedAt: null,
};

describe('storage account lifecycle', () => {
  it('allows only the ordered lifecycle and derives write access', () => {
    const active = transitionStorageAccountStatus(account, 'ACTIVE');
    expect(active).toMatchObject({ status: 'ACTIVE', writeEnabled: true });

    const draining = transitionStorageAccountStatus(active, 'DRAINING');
    expect(draining).toMatchObject({ status: 'DRAINING', writeEnabled: false });
    expect(transitionStorageAccountStatus(draining, 'READ_ONLY')).toMatchObject({
      status: 'READ_ONLY',
      writeEnabled: false,
    });
  });

  it('rejects skipped, repeated, and backwards transitions', () => {
    expect(() => transitionStorageAccountStatus(account, 'DRAINING')).toThrow(
      StorageAccountStateError,
    );
    expect(() =>
      transitionStorageAccountStatus({ ...account, status: 'ACTIVE' }, 'ACTIVE'),
    ).toThrow(StorageAccountStateError);
    expect(() =>
      transitionStorageAccountStatus({ ...account, status: 'REMOVED' }, 'ACTIVE'),
    ).toThrow(StorageAccountStateError);
  });

  it('updates health and capacity metadata without changing lifecycle', () => {
    const updated = updateStorageAccountHealth(account, 'HEALTHY', {
      capacityBytes: 2_000,
      usedBytes: 200,
      capacityAccuracy: 'ESTIMATED',
    }, '2026-01-01T00:01:00.000Z');
    expect(updated).toMatchObject({
      status: 'VERIFYING',
      healthStatus: 'HEALTHY',
      capacityBytes: 2_000,
      usedBytes: 200,
      capacityAccuracy: 'ESTIMATED',
      lastHealthCheckedAt: '2026-01-01T00:01:00.000Z',
    });
  });

  it('rejects invalid capacity observations', () => {
    expect(() =>
      updateStorageAccountHealth(
        account,
        'HEALTHY',
        { capacityBytes: 10, usedBytes: 11, capacityAccuracy: 'EXACT' },
        '2026-01-01T00:01:00.000Z',
      ),
    ).toThrow(RangeError);
  });
});
