import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { Env } from '../src/env';

const testEnv = env as unknown as Env & { readonly TEST_MIGRATIONS: D1Migration[] };

it('upgrades existing upload states without changing object identity, capacity, or session status', async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS.slice(0, 5));
  const now = '2026-09-01T00:00:00.000Z';
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO storage_accounts
      (id, name, provider, status, write_enabled, capacity_bytes, used_bytes,
       provider_config, credential_envelope, last_health_status, capacity_accuracy, created_at, updated_at)
      VALUES ('account', 'test', 'r2', 'ACTIVE', 1, 1000, 0, '{}', '{}', 'HEALTHY', 'CONFIGURED', ?, ?)`)
      .bind(now, now),
    testEnv.DB.prepare(`INSERT INTO logical_buckets (id, name, created_at, updated_at)
      VALUES ('bucket', 'test', ?, ?)`).bind(now, now),
    testEnv.DB.prepare(`INSERT INTO storage_shards
      (id, logical_bucket_id, storage_account_id, physical_bucket, status, capacity_bytes, used_bytes, created_at, updated_at)
      VALUES ('shard', 'bucket', 'account', 'test-bucket', 'ACTIVE', 1000, 0, ?, ?)`)
      .bind(now, now),
  ]);
  const statuses = ['PENDING', 'EXPIRED', 'ABORTED', 'COMPLETED'];
  for (const status of statuses) {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`INSERT INTO objects
        (id, logical_bucket_id, logical_key, size_bytes, content_type, status, created_at, updated_at)
        VALUES (?, 'bucket', ?, 1, 'text/plain', 'PENDING', ?, ?)`)
        .bind(status, status, now, now),
      testEnv.DB.prepare(`INSERT INTO object_locations
        (id, object_id, storage_account_id, storage_shard_id, physical_bucket, physical_key, is_primary, created_at, updated_at)
        VALUES (?, ?, 'account', 'shard', 'test-bucket', ?, 1, ?, ?)`)
        .bind(`location-${status}`, status, status, now, now),
      testEnv.DB.prepare(`INSERT INTO upload_sessions
        (id, object_id, status, expires_at, created_at) VALUES (?, ?, 'PENDING', ?, ?)`)
        .bind(`session-${status}`, status, now, now),
    ]);
    if (status === 'EXPIRED' || status === 'ABORTED') {
      await testEnv.DB.prepare("UPDATE upload_sessions SET status = 'EXPIRED' WHERE object_id = ?")
        .bind(status).run();
      if (status === 'ABORTED') await testEnv.DB.prepare("UPDATE upload_sessions SET status = 'ABORTED' WHERE object_id = ?")
        .bind(status).run();
    } else if (status === 'COMPLETED') {
      await testEnv.DB.batch([
        testEnv.DB.prepare("UPDATE upload_sessions SET status = 'COMPLETED', completed_at = ? WHERE object_id = ?")
          .bind(now, status),
        testEnv.DB.prepare("UPDATE objects SET status = 'READY' WHERE id = ?").bind(status),
      ]);
    }
  }
  const before = await testEnv.DB.prepare('SELECT * FROM objects ORDER BY id').all();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  expect((await testEnv.DB.prepare('SELECT * FROM objects ORDER BY id').all()).results).toEqual(before.results);
  expect((await testEnv.DB.prepare('SELECT used_bytes FROM storage_accounts').first())?.used_bytes).toBe(2);
  const sessions = await testEnv.DB.prepare('SELECT object_id, status, is_current, location_id FROM upload_sessions ORDER BY object_id')
    .all<{ object_id: string; status: string; is_current: number; location_id: string }>();
  expect(sessions.results).toHaveLength(4);
  for (const session of sessions.results) {
    expect(session).toEqual({ object_id: session.status, status: session.status,
      is_current: 1, location_id: `location-${session.status}` });
  }
});
