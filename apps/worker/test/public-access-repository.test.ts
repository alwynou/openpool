import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AuditLogEntry } from '@openpool/application';
import type { LogicalBucket, StoredObject } from '@openpool/domain';
import {
  D1AuditOutboxRepository,
  D1LogicalBucketRepository,
  D1ObjectRepository,
} from '../src/adapters/d1';
import type { Env } from '../src/env';

interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;
const now = '2026-09-01T00:00:00.000Z';
const later = '2026-09-01T00:01:00.000Z';

function audit(resourceType: 'LOGICAL_BUCKET' | 'OBJECT', resourceId: string): AuditLogEntry {
  return {
    actorType: 'ADMIN',
    actorId: 'admin-1',
    action: `${resourceType}_PUBLIC_ACCESS_UPDATED`,
    resourceType,
    resourceId,
    createdAt: later,
  };
}

function bucket(enabled = false): LogicalBucket {
  return {
    id: 'bucket-1',
    name: 'documents',
    description: null,
    publicAccessEnabled: enabled,
    createdAt: now,
    updatedAt: now,
  };
}

function object(mode: StoredObject['publicAccessMode'] = 'INHERIT'): StoredObject {
  return {
    id: 'object-1',
    logicalBucketId: 'bucket-1',
    logicalKey: 'hello.txt',
    sizeBytes: 10,
    contentType: 'text/plain',
    checksum: null,
    status: 'READY',
    publicAccessMode: mode,
    publicAccessExpiresAt: mode === 'PUBLIC' ? '2026-09-02T00:00:00.000Z' : null,
    createdAt: now,
    updatedAt: later,
  };
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM object_locations'),
    testEnv.DB.prepare('DELETE FROM objects'),
    testEnv.DB.prepare('DELETE FROM logical_buckets'),
    testEnv.DB.prepare('DELETE FROM audit_outbox'),
    testEnv.DB.prepare('DELETE FROM audit_logs'),
  ]);
});

describe('public-access migration constraints', () => {
  it('adds safe defaults and rejects expiry for non-public objects', async () => {
    await testEnv.DB.prepare(
      `INSERT INTO logical_buckets (id, name, description, created_at, updated_at)
       VALUES ('bucket-1', 'documents', NULL, ?, ?)`,
    ).bind(now, now).run();
    await testEnv.DB.prepare(
      `INSERT INTO objects
       (id, logical_bucket_id, logical_key, size_bytes, content_type,
        checksum, status, created_at, updated_at)
       VALUES ('object-1', 'bucket-1', 'hello.txt', 1, 'text/plain',
               NULL, 'READY', ?, ?)`,
    ).bind(now, now).run();

    await expect(testEnv.DB.prepare(
      `SELECT public_access_enabled FROM logical_buckets WHERE id = 'bucket-1'`,
    ).first()).resolves.toEqual({ public_access_enabled: 0 });
    await expect(testEnv.DB.prepare(
      `SELECT public_access_mode, public_access_expires_at
       FROM objects WHERE id = 'object-1'`,
    ).first()).resolves.toEqual({
      public_access_mode: 'INHERIT',
      public_access_expires_at: null,
    });

    await expect(testEnv.DB.prepare(
      `INSERT INTO objects
       (id, logical_bucket_id, logical_key, size_bytes, content_type,
        checksum, status, public_access_mode, public_access_expires_at,
        created_at, updated_at)
       VALUES ('object-2', 'bucket-1', 'other.txt', 1, 'text/plain',
               NULL, 'READY', 'PRIVATE', ?, ?, ?)`,
    ).bind(later, now, now).run()).rejects.toThrow(
      'openpool_object_public_access_expiry_conflict',
    );

    await expect(testEnv.DB.prepare(
      `UPDATE objects
       SET public_access_mode = 'PRIVATE', public_access_expires_at = ?
       WHERE id = 'object-1'`,
    ).bind(later).run()).rejects.toThrow(
      'openpool_object_public_access_expiry_conflict',
    );
  });
});

describe('public-access D1 repository mutations', () => {
  it('conditionally updates bucket access and audits in one batch', async () => {
    const outbox = new D1AuditOutboxRepository(testEnv.DB);
    const repository = new D1LogicalBucketRepository(testEnv.DB, outbox);
    const initial = bucket();
    expect(await repository.create(initial, {
      ...audit('LOGICAL_BUCKET', initial.id),
      action: 'LOGICAL_BUCKET_CREATED',
      createdAt: now,
    })).toBe(true);

    const updated = { ...initial, publicAccessEnabled: true, updatedAt: later };
    expect(await repository.updatePublicAccess(updated, initial.updatedAt, audit('LOGICAL_BUCKET', initial.id))).toBe(true);
    await expect(repository.findById(initial.id)).resolves.toEqual(updated);
    await expect(testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_outbox
       WHERE action = 'LOGICAL_BUCKET_PUBLIC_ACCESS_UPDATED'`,
    ).first()).resolves.toEqual({ count: 1 });

    expect(await repository.updatePublicAccess(
      { ...updated, publicAccessEnabled: false, updatedAt: '2026-09-01T00:02:00.000Z' },
      initial.updatedAt,
      audit('LOGICAL_BUCKET', initial.id),
    )).toBe(false);
  });

  it('conditionally updates object access and audits in one batch', async () => {
    await testEnv.DB.prepare(
      `INSERT INTO logical_buckets (id, name, description, created_at, updated_at)
       VALUES ('bucket-1', 'documents', NULL, ?, ?)`,
    ).bind(now, now).run();
    await testEnv.DB.prepare(
      `INSERT INTO objects
       (id, logical_bucket_id, logical_key, size_bytes, content_type,
        checksum, status, created_at, updated_at)
       VALUES ('object-1', 'bucket-1', 'hello.txt', 10, 'text/plain',
               NULL, 'READY', ?, ?)`,
    ).bind(now, later).run();
    const outbox = new D1AuditOutboxRepository(testEnv.DB);
    const repository = new D1ObjectRepository(testEnv.DB, outbox);
    const updated = object('PUBLIC');

    expect(await repository.updatePublicAccess(updated, later, audit('OBJECT', updated.id))).toBe(true);
    await expect(testEnv.DB.prepare(
      `SELECT public_access_mode, public_access_expires_at, updated_at
       FROM objects WHERE id = 'object-1'`,
    ).first()).resolves.toEqual({
      public_access_mode: 'PUBLIC',
      public_access_expires_at: '2026-09-02T00:00:00.000Z',
      updated_at: later,
    });
    expect(await repository.updatePublicAccess(
      { ...updated, publicAccessMode: 'PRIVATE', publicAccessExpiresAt: null, updatedAt: '2026-09-01T00:02:00.000Z' },
      now,
      audit('OBJECT', updated.id),
    )).toBe(false);
  });

  it('does not update public access after an object leaves READY', async () => {
    await testEnv.DB.prepare(
      `INSERT INTO logical_buckets (id, name, description, created_at, updated_at)
       VALUES ('bucket-1', 'documents', NULL, ?, ?)`,
    ).bind(now, now).run();
    await testEnv.DB.prepare(
      `INSERT INTO objects
       (id, logical_bucket_id, logical_key, size_bytes, content_type,
        checksum, status, created_at, updated_at)
       VALUES ('object-1', 'bucket-1', 'hello.txt', 10, 'text/plain',
               NULL, 'DELETING', ?, ?)`,
    ).bind(now, later).run();
    const outbox = new D1AuditOutboxRepository(testEnv.DB);
    const repository = new D1ObjectRepository(testEnv.DB, outbox);

    expect(
      await repository.updatePublicAccess(
        object('PUBLIC'),
        later,
        audit('OBJECT', 'object-1'),
      ),
    ).toBe(false);
    await expect(
      testEnv.DB.prepare(
        `SELECT public_access_mode, public_access_expires_at
         FROM objects WHERE id = 'object-1'`,
      ).first(),
    ).resolves.toEqual({
      public_access_mode: 'INHERIT',
      public_access_expires_at: null,
    });
  });

  it('rolls back a policy update when audit append fails', async () => {
    const fixed = new D1AuditOutboxRepository(testEnv.DB, {
      idGenerator: () => 'event-fixed',
    });
    const repository = new D1LogicalBucketRepository(testEnv.DB, fixed);
    const initial = bucket();
    await repository.create(initial, {
      ...audit('LOGICAL_BUCKET', initial.id),
      action: 'LOGICAL_BUCKET_CREATED',
      createdAt: now,
    });
    await expect(repository.updatePublicAccess(
      { ...initial, publicAccessEnabled: true, updatedAt: later },
      initial.updatedAt,
      audit('LOGICAL_BUCKET', initial.id),
    )).rejects.toThrow();
    await expect(repository.findById(initial.id)).resolves.toEqual(initial);
  });

  it('fails closed and rolls back an object policy when audit append fails', async () => {
    await testEnv.DB.prepare(
      `INSERT INTO logical_buckets (id, name, description, created_at, updated_at)
       VALUES ('bucket-1', 'documents', NULL, ?, ?)`,
    ).bind(now, now).run();
    await testEnv.DB.prepare(
      `INSERT INTO objects
       (id, logical_bucket_id, logical_key, size_bytes, content_type,
        checksum, status, created_at, updated_at)
       VALUES ('object-1', 'bucket-1', 'hello.txt', 10, 'text/plain',
               NULL, 'READY', ?, ?)`,
    ).bind(now, later).run();
    const fixed = new D1AuditOutboxRepository(testEnv.DB, {
      idGenerator: () => 'event-fixed',
    });
    const repository = new D1ObjectRepository(testEnv.DB, fixed);
    const initialAudit = audit('OBJECT', 'object-1');
    await fixed.record({
      ...initialAudit,
      action: 'OBJECT_CREATED',
      createdAt: now,
    });
    await expect(repository.updatePublicAccess(
      object('PUBLIC'),
      later,
      initialAudit,
    )).rejects.toThrow();
    await expect(testEnv.DB.prepare(
      `SELECT public_access_mode, public_access_expires_at, updated_at
       FROM objects WHERE id = 'object-1'`,
    ).first()).resolves.toEqual({
      public_access_mode: 'INHERIT',
      public_access_expires_at: null,
      updated_at: later,
    });
  });
});
