import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { D1AuditQueryRepository } from '../src/adapters/d1/audit-query-repository';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

interface AuditFixture {
  readonly id: string;
  readonly actorType?: 'ADMIN' | 'API_KEY' | 'SYSTEM';
  readonly actorId?: string | null;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string | null;
  readonly requestId?: string | null;
  readonly metadata?: string;
  readonly createdAt: string;
}

const testEnv = env as unknown as TestEnv;
const repository = new D1AuditQueryRepository(testEnv.DB);

async function insertAudit(fixture: AuditFixture): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO audit_logs
     (id, actor_type, actor_id, action, resource_type, resource_id,
      request_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      fixture.id,
      fixture.actorType ?? 'ADMIN',
      fixture.actorId === undefined ? 'admin-1' : fixture.actorId,
      fixture.action ?? 'OBJECT_VIEWED',
      fixture.resourceType ?? 'OBJECT',
      fixture.resourceId === undefined ? 'object-1' : fixture.resourceId,
      fixture.requestId === undefined ? 'request-1' : fixture.requestId,
      fixture.metadata ?? '{"source":"test"}',
      fixture.createdAt,
    )
    .run();
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.prepare('DELETE FROM audit_logs').run();
});

describe('D1AuditQueryRepository', () => {
  it('uses stable descending keyset pagination for equal timestamps', async () => {
    await insertAudit({
      id: 'audit-old',
      createdAt: '2026-09-01T01:00:00.000Z',
    });
    await insertAudit({
      id: 'audit-a',
      createdAt: '2026-09-01T02:00:00.000Z',
    });
    await insertAudit({
      id: 'audit-b',
      createdAt: '2026-09-01T02:00:00.000Z',
    });
    await insertAudit({
      id: 'audit-new',
      createdAt: '2026-09-01T03:00:00.000Z',
    });

    const first = await repository.list({ limit: 2 });
    expect(first.items.map(({ id }) => id)).toEqual(['audit-new', 'audit-b']);
    expect(first.nextCursor).toEqual({
      afterCreatedAt: '2026-09-01T02:00:00.000Z',
      afterId: 'audit-b',
    });

    const second = await repository.list({
      limit: 2,
      afterCreatedAt: '2026-09-01T02:00:00.000Z',
      afterId: 'audit-b',
    });
    expect(second.items.map(({ id }) => id)).toEqual(['audit-a', 'audit-old']);
    expect(second.nextCursor).toBeNull();
  });

  it('combines actor, action, resource type, and resource id filters', async () => {
    await insertAudit({
      id: 'match',
      actorType: 'API_KEY',
      actorId: 'key-1',
      action: 'OBJECT_DOWNLOADED',
      resourceType: 'OBJECT',
      resourceId: 'object-7',
      requestId: null,
      metadata: '{"path":"reports/q3.pdf"}',
      createdAt: '2026-09-01T03:00:00.000Z',
    });
    await insertAudit({
      id: 'wrong-actor',
      action: 'OBJECT_DOWNLOADED',
      resourceType: 'OBJECT',
      resourceId: 'object-7',
      createdAt: '2026-09-01T02:00:00.000Z',
    });
    await insertAudit({
      id: 'wrong-resource',
      actorType: 'API_KEY',
      actorId: 'key-2',
      action: 'OBJECT_DOWNLOADED',
      resourceType: 'OBJECT',
      resourceId: 'object-8',
      createdAt: '2026-09-01T01:00:00.000Z',
    });

    const page = await repository.list({
      limit: 20,
      actorType: 'API_KEY',
      action: 'OBJECT_DOWNLOADED',
      resourceType: 'OBJECT',
      resourceId: 'object-7',
    });
    expect(page).toEqual({
      items: [
        {
          id: 'match',
          actorType: 'API_KEY',
          actorId: 'key-1',
          action: 'OBJECT_DOWNLOADED',
          resourceType: 'OBJECT',
          resourceId: 'object-7',
          requestId: null,
          metadata: { path: 'reports/q3.pdf' },
          createdAt: '2026-09-01T03:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
  });

  it.each(['not-json', '{"count":1}', '[]'])(
    'fails closed for invalid metadata JSON: %s',
    async (metadata) => {
      await insertAudit({
        id: 'corrupt',
        metadata,
        createdAt: '2026-09-01T01:00:00.000Z',
      });

      await expect(repository.list({ limit: 20 })).rejects.toMatchObject({
        name: 'D1AuditQueryDataError',
      });
    },
  );

  it('fails closed for an unknown actor type stored outside the schema contract', async () => {
    await insertAudit({
      id: 'valid',
      createdAt: '2026-09-01T01:00:00.000Z',
    });
    await testEnv.DB.prepare('PRAGMA ignore_check_constraints = ON').run();
    try {
      await testEnv.DB.prepare(
        `UPDATE audit_logs SET actor_type = 'USER' WHERE id = 'valid'`,
      ).run();
    } finally {
      await testEnv.DB.prepare('PRAGMA ignore_check_constraints = OFF').run();
    }

    await expect(repository.list({ limit: 20 })).rejects.toMatchObject({
      name: 'D1AuditQueryDataError',
    });
  });

  it('fails closed for a non-canonical created timestamp', async () => {
    await insertAudit({
      id: 'bad-time',
      createdAt: '2026-09-01 01:00:00',
    });

    await expect(repository.list({ limit: 20 })).rejects.toMatchObject({
      name: 'D1AuditQueryDataError',
    });
  });
});
