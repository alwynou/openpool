import { readFile, mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ObjectMetadataResponse } from '@openpool/sdk';
import { describe, expect, it } from 'vitest';
import { fixture, digest, reconcile, runSmoke, type SmokeReport } from '../src/smoke/run.js';
import type { CommandResult } from '../src/smoke/child.js';

const options = { baseUrl: 'https://control.example', apiKey: 'opk_fake-smoke-secret', bucketId: 'bucket-1', prefix: 'cli-smoke/', sizeBytes: 1_000_000 };
const object = (key: string, status: ObjectMetadataResponse['status'] = 'READY'): ObjectMetadataResponse => ({
  id: 'object-1', logicalBucketId: 'bucket-1', logicalKey: key, sizeBytes: 100, contentType: 'application/octet-stream', checksum: null,
  status, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
});
const report = (): SmokeReport => ({ runId: 'unique-run', prefix: 'cli-smoke/unique-run/', sizeBytes: 1_000_000,
  startedAt: '2026-09-03T00:00:00.000Z', status: 'RUNNING', checks: [], objects: [], commands: [], pendingCleanup: [], failures: [], localDataRemoved: false });

describe('reusable smoke safety and reconciliation', () => {
  it('generates a private, exact-size random fixture incrementally and hashes it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openpool-smoke-fixture-test-'));
    try {
      const file = join(directory, 'source.bin');
      const sha256 = await fixture(file, 1_000_017);
      expect(await digest(file)).toEqual({ bytes: 1_000_017, sha256 });
      expect(createHash('sha256').update(await readFile(file)).digest('hex')).toBe(sha256);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await expect(fixture(file, 5)).rejects.toThrow();
      expect((await stat(file)).size).toBe(1_000_017);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['READY', 'DELETING', 'DELETED'] as const)('reconciles a lost receipt in state %s without touching any other namespace', async (status) => {
    const current = report(); const entry = object(current.prefix + 'file.bin', status); const deleted: string[] = [];
    await reconcile({
      async listObjects(bucket, query) { expect(bucket).toBe('bucket-1'); expect(query?.prefix).toBe(current.prefix); return [entry]; },
      async deleteObject(id) { deleted.push(id); return { ...entry, status: 'DELETED' }; },
      async getUpload() { throw new Error('Not needed'); },
    }, 'bucket-1', current);
    expect(deleted).toEqual(status === 'DELETED' ? [] : ['object-1']);
    expect(current.objects).toEqual([{ objectId: 'object-1', logicalKey: entry.logicalKey, deleted: true }]);
  });

  it('records a pending upload for Cron without creating, completing, retrying or deleting it', async () => {
    const current = report();
    await reconcile({
      async listObjects() { return [object(current.prefix + 'pending.bin', 'PENDING')]; },
      async getUpload() { return { objectId: 'object-1', uploadSessionId: 'session-1', status: 'PENDING', expiresAt: '2026-09-03T00:15:00.000Z' }; },
      async deleteObject() { throw new Error('Must not delete pending'); },
    }, 'bucket-1', current);
    expect(current.objects[0]?.deleted).toBe(false);
    expect(current.pendingCleanup).toEqual([{ objectId: 'object-1', uploadSessionId: 'session-1', status: 'PENDING', expiresAt: '2026-09-03T00:15:00.000Z' }]);
  });

  it.each(['cli-smoke/other-run/file', 'cli-smoke/unique-run-else/file'])('rejects foreign cleanup result %s', async (key) => {
    let deleted = false;
    await expect(reconcile({
      async listObjects() { return [object(key)]; },
      async getUpload() { throw new Error(); },
      async deleteObject() { deleted = true; return object(key, 'DELETED'); },
    }, 'bucket-1', report())).rejects.toThrow('Cleanup escaped');
    expect(deleted).toBe(false);
  });

  it('does not claim a missing reserved object was cleaned', async () => {
    const current = report(); current.objects.push({ objectId: 'missing', logicalKey: current.prefix + 'file', deleted: false });
    await expect(reconcile({ async listObjects() { return []; }, async getUpload() { throw new Error(); }, async deleteObject() { throw new Error(); } }, 'bucket-1', current)).rejects.toThrow('missing');
  });

  it('refuses production before running any child or remote mutation, retaining only a safe report', async () => {
    let commands = 0;
    const result = await runSmoke(options, { command: () => async () => { commands++; throw new Error(); }, client: {
      async health() { return { name: 'openpool', status: 'ok', version: '0.1.0', environment: 'production' }; },
      async listObjects() { throw new Error('Not reached'); }, async getUpload() { throw new Error('Not reached'); }, async deleteObject() { throw new Error('Not reached'); },
    } });
    try {
      expect(commands).toBe(0); expect(result.report.status).toBe('FAILED'); expect(result.report.localDataRemoved).toBe(true);
      expect(result.report.failures).toEqual(['Only an explicitly identified staging environment may be tested.']);
      expect(await readdir(dirname(result.reportPath))).toEqual(['report.json']);
      expect((await stat(result.reportPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(result.reportPath, 'utf8')).not.toContain(options.apiKey);
    } finally { await rm(dirname(result.reportPath), { recursive: true, force: true }); }
  });

  it('reconciles a reservation whose response is lost and reports incomplete cleanup without leaking the exception', async () => {
    let reserved: ObjectMetadataResponse | undefined;
    const result = await runSmoke(options, { command: () => async (args) => {
      reserved = object(args[args.indexOf('--key') + 1] ?? '', 'PENDING');
      throw new Error('https://provider.example?X-Amz-Signature=secret ' + options.apiKey);
    }, client: {
      async health() { return { name: 'openpool', status: 'ok', version: '0.1.0', environment: 'staging' }; },
      async listObjects() { return reserved ? [reserved] : []; },
      async getUpload() { return { objectId: 'object-1', uploadSessionId: 'lost-session', status: 'PENDING', expiresAt: '2026-09-03T00:15:00.000Z' }; },
      async deleteObject() { throw new Error('Must not delete pending'); },
    } });
    try {
      expect(result.report.status).toBe('FAILED'); expect(result.report.localDataRemoved).toBe(true);
      expect(result.report.objects).toHaveLength(1); expect(result.report.pendingCleanup).toHaveLength(1);
      expect(result.report.pendingCleanup[0]?.uploadSessionId).toBe('lost-session');
      expect(await readFile(result.reportPath, 'utf8')).not.toMatch(/X-Amz-|opk_fake|https:/u);
    } finally { await rm(dirname(result.reportPath), { recursive: true, force: true }); }
  });

  it('each rerun gets a new namespace and never replays a prior failed upload', async () => {
    const prefixes: string[] = [];
    for (let run = 0; run < 2; run++) {
      const result = await runSmoke(options, { command: () => async (): Promise<CommandResult> => { throw new Error('offline'); }, client: {
        async health() { return { name: 'openpool', status: 'ok', version: '0.1.0', environment: 'staging' }; },
        async listObjects(_bucket, query) { prefixes.push(query?.prefix ?? ''); return []; },
        async getUpload() { throw new Error(); }, async deleteObject() { throw new Error(); },
      } });
      await rm(dirname(result.reportPath), { recursive: true, force: true });
    }
    expect(new Set(prefixes).size).toBe(2);
  });
});
