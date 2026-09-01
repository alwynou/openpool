import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AuditLogEntry } from '@openpool/application';
import { D1AuditOutboxRepository } from '../src/adapters/d1/audit-outbox-repository';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

interface OutboxRow {
  readonly id: string;
  readonly status: string;
  readonly request_id: string | null;
  readonly metadata: string;
  readonly attempt_count: number;
  readonly available_at: string;
  readonly lease_token: string | null;
  readonly delivered_at: string | null;
  readonly last_error_code: string | null;
}

const testEnv = env as unknown as TestEnv;
const createdAt = '2026-09-01T00:00:00.000Z';

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    actorType: 'ADMIN',
    actorId: 'admin-1',
    action: 'LOGICAL_BUCKET_CREATED',
    resourceType: 'LOGICAL_BUCKET',
    resourceId: 'bucket-1',
    createdAt,
    metadata: { name: 'Documents' },
    ...overrides,
  };
}

function repository(ids: string[] = ['event-1']) {
  return new D1AuditOutboxRepository(testEnv.DB, {
    requestId: 'request-1',
    idGenerator: () => {
      const id = ids.shift();
      if (!id) throw new Error('No test ID remains');
      return id;
    },
  });
}

async function outboxRow(id: string): Promise<OutboxRow | null> {
  return testEnv.DB.prepare(
    `SELECT id, status, request_id, metadata, attempt_count, available_at,
            lease_token, delivered_at, last_error_code
     FROM audit_outbox
     WHERE id = ?`,
  )
    .bind(id)
    .first<OutboxRow>();
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM audit_outbox'),
    testEnv.DB.prepare('DELETE FROM audit_logs'),
    testEnv.DB.prepare('DELETE FROM logical_buckets'),
  ]);
});

describe('D1AuditOutboxRepository', () => {
  it('appends a validated pending event with request context', async () => {
    await repository().record(entry());

    expect(await outboxRow('event-1')).toEqual({
      id: 'event-1',
      status: 'PENDING',
      request_id: 'request-1',
      metadata: '{"name":"Documents"}',
      attempt_count: 0,
      available_at: createdAt,
      lease_token: null,
      delivered_at: null,
      last_error_code: null,
    });
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM audit_logs').first<{
        count: number;
      }>(),
    ).toEqual({ count: 0 });
  });

  it('rejects invalid actor, metadata, and timestamps before D1 writes', async () => {
    const outbox = repository(['event-1', 'event-2', 'event-3']);
    await expect(
      outbox.record(entry({ actorType: 'SYSTEM', actorId: 'admin-1' })),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      outbox.record(entry({ metadata: { count: 1 } as unknown as Record<string, string> })),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      outbox.record(entry({ createdAt: '2026-09-01 00:00:00' })),
    ).rejects.toBeInstanceOf(TypeError);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM audit_outbox').first<{
        count: number;
      }>(),
    ).toEqual({ count: 0 });
  });

  it('claims one event atomically and reclaims an expired lease', async () => {
    const outbox = repository(['event-1']);
    await outbox.record(entry());

    const first = await outbox.claim({
      leaseToken: 'lease-1',
      claimedAt: createdAt,
      leaseExpiresAt: '2026-09-01T00:01:00.000Z',
    });
    expect(first).toEqual({ id: 'event-1', attemptCount: 1 });
    await expect(
      outbox.claim({
        leaseToken: 'lease-2',
        claimedAt: '2026-09-01T00:00:59.999Z',
        leaseExpiresAt: '2026-09-01T00:01:59.999Z',
      }),
    ).resolves.toBeUndefined();
    await expect(
      outbox.claim({
        leaseToken: 'lease-2',
        claimedAt: '2026-09-01T00:01:00.000Z',
        leaseExpiresAt: '2026-09-01T00:02:00.000Z',
      }),
    ).resolves.toEqual({ id: 'event-1', attemptCount: 2 });
  });

  it('allows only one concurrent claim for an event', async () => {
    const outbox = repository(['event-1']);
    await outbox.record(entry());

    const claims = await Promise.all([
      outbox.claim({
        leaseToken: 'lease-1',
        claimedAt: createdAt,
        leaseExpiresAt: '2026-09-01T00:01:00.000Z',
      }),
      outbox.claim({
        leaseToken: 'lease-2',
        claimedAt: createdAt,
        leaseExpiresAt: '2026-09-01T00:01:00.000Z',
      }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('projects a claimed event once and treats repeated delivery as idempotent', async () => {
    const outbox = repository(['event-1']);
    await outbox.record(entry());
    await outbox.claim({
      leaseToken: 'lease-1',
      claimedAt: createdAt,
      leaseExpiresAt: '2026-09-01T00:01:00.000Z',
    });

    await expect(
      outbox.deliver('event-1', 'lease-1', '2026-09-01T00:00:30.000Z'),
    ).resolves.toBe('DELIVERED');
    await expect(
      outbox.deliver('event-1', 'lease-1', '2026-09-01T00:00:31.000Z'),
    ).resolves.toBe('ALREADY_DELIVERED');
    expect(await outboxRow('event-1')).toMatchObject({
      status: 'DELIVERED',
      attempt_count: 1,
      lease_token: null,
      delivered_at: '2026-09-01T00:00:30.000Z',
    });
    expect(
      await testEnv.DB.prepare(
        `SELECT id, event_id, action, request_id
         FROM audit_logs
         WHERE event_id = 'event-1'`,
      ).first(),
    ).toEqual({
      id: 'event-1',
      event_id: 'event-1',
      action: 'LOGICAL_BUCKET_CREATED',
      request_id: 'request-1',
    });
  });

  it('rejects delivery after lease expiry without writing an audit log', async () => {
    const outbox = repository(['event-1']);
    await outbox.record(entry());
    await outbox.claim({
      leaseToken: 'lease-1',
      claimedAt: createdAt,
      leaseExpiresAt: '2026-09-01T00:01:00.000Z',
    });

    await expect(
      outbox.deliver('event-1', 'lease-1', '2026-09-01T00:01:00.000Z'),
    ).resolves.toBe('CONFLICT');
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM audit_logs').first<{
        count: number;
      }>(),
    ).toEqual({ count: 0 });
  });

  it('releases a failed claim with backoff and preserves its attempt history', async () => {
    const outbox = repository(['event-1']);
    await outbox.record(entry());
    await outbox.claim({
      leaseToken: 'lease-1',
      claimedAt: createdAt,
      leaseExpiresAt: '2026-09-01T00:01:00.000Z',
    });

    await expect(
      outbox.retry(
        'event-1',
        'lease-1',
        '2026-09-01T00:00:05.000Z',
        'AUDIT_DELIVERY_FAILED',
        createdAt,
      ),
    ).resolves.toBe(true);
    expect(await outboxRow('event-1')).toMatchObject({
      status: 'PENDING',
      attempt_count: 1,
      available_at: '2026-09-01T00:00:05.000Z',
      last_error_code: 'AUDIT_DELIVERY_FAILED',
    });
    await expect(
      outbox.claim({
        leaseToken: 'lease-2',
        claimedAt: '2026-09-01T00:00:04.999Z',
        leaseExpiresAt: '2026-09-01T00:01:04.999Z',
      }),
    ).resolves.toBeUndefined();
    await expect(
      outbox.claim({
        leaseToken: 'lease-2',
        claimedAt: '2026-09-01T00:00:05.000Z',
        leaseExpiresAt: '2026-09-01T00:01:05.000Z',
      }),
    ).resolves.toEqual({ id: 'event-1', attemptCount: 2 });
  });

  it('rolls back a business write when the outbox append fails', async () => {
    const outbox = repository(['event-1', 'event-1']);
    await outbox.record(entry());

    await expect(
      testEnv.DB.batch([
        testEnv.DB
          .prepare(
            `INSERT INTO logical_buckets
             (id, name, description, created_at, updated_at)
             VALUES ('bucket-1', 'Documents', NULL, ?, ?)`,
          )
          .bind(createdAt, createdAt),
        outbox.assertPreviousChanges(),
        outbox.statement(entry()),
      ]),
    ).rejects.toThrow();
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM logical_buckets
         WHERE id = 'bucket-1'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it('prevents mutation of immutable event payload fields', async () => {
    const outbox = repository(['event-1']);
    await outbox.record(entry());

    await expect(
      testEnv.DB.prepare(
        `UPDATE audit_outbox
         SET action = 'TAMPERED'
         WHERE id = 'event-1'`,
      ).run(),
    ).rejects.toThrow(/openpool_audit_outbox_immutable/u);
  });
});
