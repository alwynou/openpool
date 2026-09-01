import { describe, expect, it } from 'vitest';

import {
  ShardMigrationObjectStateError,
  ShardMigrationStateError,
  transitionShardMigrationObjectStatus,
  transitionShardMigrationStatus,
  validateShardMigrationEndpoints,
  type ShardMigration,
  type ShardMigrationObject,
} from './shard-migration';

const migration: ShardMigration = {
  id: 'migration-1',
  sourceShardId: 'source',
  targetShardId: 'target',
  status: 'RUNNING',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  completedAt: null,
};

const task: ShardMigrationObject = {
  id: 'task-1',
  migrationId: migration.id,
  objectId: 'object-1',
  sourceLocationId: 'location-source',
  targetLocationId: 'location-target',
  targetPhysicalKey: 'objects/ob/object-1',
  status: 'RESERVED',
  leaseToken: 'lease-1',
  leaseExpiresAt: '2026-09-01T00:15:00.000Z',
  attemptCount: 1,
  lastErrorCode: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  completedAt: null,
};

describe('shard migration domain', () => {
  it('completes a migration with an explicit completion timestamp', () => {
    expect(
      transitionShardMigrationStatus(
        migration,
        'COMPLETED',
        '2026-09-01T01:00:00.000Z',
      ),
    ).toMatchObject({
      status: 'COMPLETED',
      completedAt: '2026-09-01T01:00:00.000Z',
    });
  });

  it('allows failed migrations to resume but not completed migrations', () => {
    const failed = transitionShardMigrationStatus(
      migration,
      'FAILED',
      '2026-09-01T00:10:00.000Z',
    );
    expect(
      transitionShardMigrationStatus(
        failed,
        'RUNNING',
        '2026-09-01T00:20:00.000Z',
      ).status,
    ).toBe('RUNNING');
    expect(() =>
      transitionShardMigrationStatus(
        { ...migration, status: 'COMPLETED' },
        'RUNNING',
        '2026-09-01T00:20:00.000Z',
      ),
    ).toThrow(ShardMigrationStateError);
  });

  it('moves object tasks through verified switch and cleanup', () => {
    const switched = transitionShardMigrationObjectStatus(
      task,
      'SWITCHED',
      '2026-09-01T00:10:00.000Z',
    );
    expect(
      transitionShardMigrationObjectStatus(
        switched,
        'COMPLETED',
        '2026-09-01T00:20:00.000Z',
      ),
    ).toMatchObject({
      status: 'COMPLETED',
      completedAt: '2026-09-01T00:20:00.000Z',
    });
    expect(() =>
      transitionShardMigrationObjectStatus(
        task,
        'COMPLETED',
        '2026-09-01T00:20:00.000Z',
      ),
    ).toThrow(ShardMigrationObjectStateError);
  });

  it('requires distinct non-empty shard endpoints', () => {
    expect(() => validateShardMigrationEndpoints('source', 'target')).not.toThrow();
    expect(() => validateShardMigrationEndpoints('', 'target')).toThrow(
      RangeError,
    );
    expect(() => validateShardMigrationEndpoints('same', 'same')).toThrow(
      RangeError,
    );
  });
});
