import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AuditLogEntry } from '@openpool/application';
import type { Administrator, AuthSession } from '@openpool/domain';

import {
  D1AuditOutboxRepository,
  D1AuthRepository,
} from '../src/adapters/d1';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;
const createdAt = '2026-09-02T00:00:00.000Z';

const administrator: Administrator = {
  id: 'admin-1',
  username: 'administrator',
  passwordHash: 'password-hash',
  status: 'ACTIVE',
  createdAt,
  updatedAt: createdAt,
};

const session: AuthSession = {
  id: 'session-1',
  administratorId: administrator.id,
  tokenHash: 'token-hash',
  expiresAt: '2026-09-02T08:00:00.000Z',
  createdAt,
};

function audit(action: string, resourceId: string): AuditLogEntry {
  return {
    actorType: 'ADMIN',
    actorId: administrator.id,
    action,
    resourceType: action === 'ADMINISTRATOR_INITIALIZED'
      ? 'ADMINISTRATOR'
      : 'AUTH_SESSION',
    resourceId,
    createdAt,
  };
}

function repository(ids: string[]) {
  const outbox = new D1AuditOutboxRepository(testEnv.DB, {
    requestId: 'request-1',
    idGenerator: () => {
      const id = ids.shift();
      if (!id) throw new Error('No test ID remains');
      return id;
    },
  });
  return {
    outbox,
    auth: new D1AuthRepository(testEnv.DB, { auditOutbox: outbox }),
  };
}

async function seedAdministrator(): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO administrators
     (id, username, password_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      administrator.id,
      administrator.username,
      administrator.passwordHash,
      administrator.status,
      administrator.createdAt,
      administrator.updatedAt,
    )
    .run();
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM auth_sessions'),
    testEnv.DB.prepare('DELETE FROM administrators'),
    testEnv.DB.prepare('DELETE FROM audit_outbox'),
    testEnv.DB.prepare('DELETE FROM audit_logs'),
  ]);
});

describe('D1AuthRepository transactional audit outbox', () => {
  it('creates the administrator and event atomically only once', async () => {
    const { auth } = repository(['event-1', 'event-2']);

    await expect(
      auth.createIfAbsent(
        administrator,
        audit('ADMINISTRATOR_INITIALIZED', administrator.id),
      ),
    ).resolves.toBe(true);
    await expect(
      auth.createIfAbsent(
        { ...administrator, id: 'admin-2', username: 'second' },
        audit('ADMINISTRATOR_INITIALIZED', 'admin-2'),
      ),
    ).resolves.toBe(false);

    expect(
      await testEnv.DB.prepare(
        'SELECT COUNT(*) AS count FROM administrators',
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await testEnv.DB.prepare(
        `SELECT id, action, resource_id, request_id
         FROM audit_outbox`,
      ).all(),
    ).toMatchObject({
      results: [
        {
          id: 'event-1',
          action: 'ADMINISTRATOR_INITIALIZED',
          resource_id: administrator.id,
          request_id: 'request-1',
        },
      ],
    });
  });

  it('creates and revokes a session with one event per state change', async () => {
    await seedAdministrator();
    const { auth } = repository(['event-login', 'event-logout', 'unused']);

    await auth.create(session, audit('LOGIN', session.id));
    await expect(
      auth.revokeByTokenHash(
        session.tokenHash,
        audit('LOGOUT', session.id),
      ),
    ).resolves.toBe(true);
    await expect(
      auth.revokeByTokenHash(
        session.tokenHash,
        audit('LOGOUT', session.id),
      ),
    ).resolves.toBe(false);

    expect(
      await testEnv.DB.prepare(
        'SELECT COUNT(*) AS count FROM auth_sessions',
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await testEnv.DB.prepare(
        'SELECT action FROM audit_outbox ORDER BY created_at, id',
      ).all(),
    ).toMatchObject({ results: [{ action: 'LOGIN' }, { action: 'LOGOUT' }] });
  });

  it('rolls back the session when the outbox append fails', async () => {
    await seedAdministrator();
    const { auth, outbox } = repository(['duplicate-event', 'duplicate-event']);
    await outbox.record(audit('LOGIN', 'existing-session'));

    await expect(
      auth.create(session, audit('LOGIN', session.id)),
    ).rejects.toThrow();
    expect(
      await testEnv.DB.prepare(
        'SELECT COUNT(*) AS count FROM auth_sessions',
      ).first(),
    ).toEqual({ count: 0 });
  });

  it('fails closed when a mutation repository has no outbox', async () => {
    const auth = new D1AuthRepository(testEnv.DB);

    await expect(
      auth.createIfAbsent(
        administrator,
        audit('ADMINISTRATOR_INITIALIZED', administrator.id),
      ),
    ).rejects.toThrow('requires an audit outbox');
    expect(
      await testEnv.DB.prepare(
        'SELECT COUNT(*) AS count FROM administrators',
      ).first(),
    ).toEqual({ count: 0 });
  });
});
