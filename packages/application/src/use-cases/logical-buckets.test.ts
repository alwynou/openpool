import { describe, expect, it } from 'vitest';

import type { AuditLogEntry } from '../ports/auth';
import type { LogicalBucket } from '@openpool/domain';
import type {
  Clock,
  IdGenerator,
  LogicalBucketRepository,
} from '../ports/storage';
import {
  CreateLogicalBucket,
  ListLogicalBuckets,
  LogicalBucketApplicationError,
} from './logical-buckets';

class FakeBuckets implements LogicalBucketRepository {
  readonly values = new Map<string, LogicalBucket>();
  readonly auditEntries: AuditLogEntry[] = [];

  async create(bucket: LogicalBucket, audit: AuditLogEntry): Promise<boolean> {
    if ([...this.values.values()].some((value) => value.name === bucket.name)) {
      return false;
    }
    this.values.set(bucket.id, bucket);
    this.auditEntries.push(audit);
    return true;
  }

  async findById(id: string): Promise<LogicalBucket | undefined> {
    return this.values.get(id);
  }

  async list(): Promise<readonly LogicalBucket[]> {
    return [...this.values.values()];
  }
}

const clock: Clock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
};

function setup() {
  const buckets = new FakeBuckets();
  let nextId = 0;
  const ids: IdGenerator = { next: () => `bucket-${++nextId}` };
  const create = new CreateLogicalBucket({ buckets, clock, ids });
  return { buckets, create };
}

describe('logical bucket use cases', () => {
  it('creates a trimmed logical bucket and audits the mutation', async () => {
    const { create, buckets } = setup();
    await expect(
      create.execute({
        actorId: 'admin-1',
        name: '  documents  ',
        description: '  user files  ',
      }),
    ).resolves.toMatchObject({
      id: 'bucket-1',
      name: 'documents',
      description: 'user files',
    });
    expect(buckets.auditEntries).toEqual([
      expect.objectContaining({
        action: 'LOGICAL_BUCKET_CREATED',
        resourceId: 'bucket-1',
      }),
    ]);
  });

  it('reports duplicate names and does not add another audit entry', async () => {
    const { create, buckets } = setup();
    const command = { actorId: 'admin-1', name: 'documents' };
    await create.execute(command);
    await expect(create.execute(command)).rejects.toMatchObject({
      code: 'LOGICAL_BUCKET_ALREADY_EXISTS',
    });
    expect(buckets.values).toHaveLength(1);
    expect(buckets.auditEntries).toHaveLength(1);
  });

  it('validates names and lists without writing an audit record', async () => {
    const { create, buckets } = setup();
    await expect(create.execute({ actorId: 'admin-1', name: '   ' })).rejects.toBeInstanceOf(
      LogicalBucketApplicationError,
    );
    await create.execute({ actorId: 'admin-1', name: 'documents' });
    await expect(new ListLogicalBuckets(buckets).execute()).resolves.toHaveLength(1);
    expect(buckets.auditEntries.map(({ action }) => action)).toEqual([
      'LOGICAL_BUCKET_CREATED',
    ]);
  });
});
