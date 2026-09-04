import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthResponse, ObjectMetadataResponse, OpenPoolClient, UploadSessionResponse } from '@openpool/sdk';

import { runSmoke } from '../src/smoke/run.js';
import type { Command, CommandResult } from '../src/smoke/child.js';
import type { Observation } from '../src/smoke/observer.js';
import type { SmokeOptions } from '../src/smoke/options.js';

const token = 'opk_smoke_flow_secret';
const options: SmokeOptions = {
  baseUrl: 'https://staging.example', apiKey: token, bucketId: 'bucket-smoke', prefix: 'cli-smoke/', sizeBytes: 1_000_000,
};

const health: HealthResponse = { name: 'openpool', status: 'ok', version: 'test', environment: 'staging' };

function value(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const result = args[index + 1];
  if (index < 0 || result === undefined) throw new Error(`Missing fake argument ${name}`);
  return result;
}

function measurements(name: string, code: number, extra: Observation[] = []): Observation[] {
  const counts = name === 'upload' ? [code === 130 ? 1 : 2, 1, 0] : name === 'retry' ? [3, 1, 0] :
    name === 'download' ? code === 1 ? [0, 0, 0] : [2, 0, 1] : [1, 0, 0];
  return [...extra, {
    type: 'measurement', startRssBytes: 10, peakRssBytes: 20,
    controlRequests: counts[0] ?? 0, maxControlBodyBytes: 128, puts: counts[1] ?? 0, gets: counts[2] ?? 0,
  }];
}

function metadata(id: string, key: string, sizeBytes: number, status: ObjectMetadataResponse['status'] = 'READY'): ObjectMetadataResponse {
  return {
    id, logicalBucketId: options.bucketId, logicalKey: key, sizeBytes,
    contentType: 'application/octet-stream', checksum: null, status,
    createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
  };
}

function result(
  name: string, output: unknown = null, code = 0, events: unknown[] = [], extra: Observation[] = [],
): CommandResult {
  return { code, output, events, observations: measurements(name, code, extra), elapsedMs: 1 };
}

interface FakeWorld {
  readonly objects: Map<string, ObjectMetadataResponse>;
  readonly sessions: Map<string, UploadSessionResponse>;
  readonly uploadSessions: string[];
  readonly retryArguments: string[][];
  readonly deleteCalls: string[];
}

function fakeRuntime(failAt?: string): {
  world: FakeWorld;
  client: Pick<OpenPoolClient, 'health' | 'listObjects' | 'getUpload' | 'deleteObject'>;
  command: (onReceipt: (receipt: unknown) => void) => Command;
} {
  const world: FakeWorld = {
    objects: new Map(), sessions: new Map(), uploadSessions: [], retryArguments: [], deleteCalls: [],
  };
  let nextObject = 1;
  let nextSession = 1;
  const bytes = new Map<string, Uint8Array>();
  const client = {
    health: async (): Promise<HealthResponse> => health,
    listObjects: async (_bucketId: string, query: { prefix?: string }): Promise<readonly ObjectMetadataResponse[]> =>
      [...world.objects.values()].filter((object) => query.prefix === undefined || object.logicalKey.startsWith(query.prefix)),
    getUpload: async (objectId: string): Promise<UploadSessionResponse> => {
      const session = world.sessions.get(objectId);
      if (session === undefined) throw new Error('Unknown fake upload session');
      return session;
    },
    deleteObject: async (objectId: string): Promise<ObjectMetadataResponse> => {
      world.deleteCalls.push(objectId);
      const object = world.objects.get(objectId);
      if (object === undefined) throw new Error('Fake cleanup escaped owned objects');
      const deleted = { ...object, status: 'DELETED' as const };
      world.objects.set(objectId, deleted);
      return deleted;
    },
  };

  const command = (onReceipt: (receipt: unknown) => void): Command => async (args, fault = 'none') => {
    const name = args[0];
    const respond = (output: unknown = null, code = 0, events: unknown[] = [], extra: Observation[] = []) =>
      result(name ?? '', output, code, events, extra);
    const key = args.includes('--key') ? value(args, '--key') : undefined;
    if (name === 'upload' || name === 'retry') {
      const input = value(args, '--file');
      const content = new Uint8Array(await readFile(input));
      const objectId = name === 'retry' ? value(args, '--object') : `object-${nextObject++}`;
      const session = name === 'retry' ? `session-retry-${nextSession++}` : `session-${nextSession++}`;
      if (name === 'retry') world.retryArguments.push([...args]);
      if (name === 'upload') world.uploadSessions.push(session);
      const object = metadata(objectId, key ?? '', content.length, fault === 'upload-interrupt' ? 'PENDING' : 'READY');
      world.objects.set(objectId, object);
      world.sessions.set(objectId, {
        objectId, uploadSessionId: session,
        status: fault === 'upload-interrupt' ? 'PENDING' : 'COMPLETED',
        expiresAt: '2026-09-03T00:15:00.000Z',
      });
      bytes.set(objectId, content);
      onReceipt({ event: 'upload-reserved', bucketId: options.bucketId, logicalKey: key, objectId, uploadSessionId: session });
      if (fault === 'upload-interrupt') {
        return respond(null, 130, [{ error: { code: 'INTERRUPTED' } }], [{
          type: 'interruption', direction: 'upload', bytes: Math.floor(content.length / 2), totalBytes: content.length,
        }]);
      }
      if (failAt === `${name}-upload`) return respond(null, 1, [{ error: { code: 'FAKE_FAILURE' } }]);
      return respond({ data: { object, uploadSessionId: session, alreadyCompleted: false } });
    }
    if (name === 'download') {
      const objectId = value(args, '--object');
      const output = value(args, '--output');
      if (failAt === 'download' && world.objects.get(objectId)?.status === 'READY') return respond(null, 1, [{ error: { code: 'FAKE_FAILURE' } }]);
      if (fault === 'download-interrupt') {
        await writeFile(output, new Uint8Array([1, 2, 3]));
        await rm(output, { force: true });
        return respond(null, 130, [{ error: { code: 'INTERRUPTED' } }], [{
          type: 'interruption', direction: 'download', bytes: 500_000, totalBytes: options.sizeBytes,
        }]);
      }
      try { await stat(output); return respond(null, 1, [{ error: { code: 'OUTPUT_EXISTS' } }]); } catch { /* New fake output. */ }
      const content = bytes.get(objectId);
      if (content === undefined) throw new Error('Unknown fake download object');
      await writeFile(output, content, { mode: 0o600 });
      return respond({ data: {
        objectId, output, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'),
      } });
    }
    if (name === 'upload-status') {
      const objectId = value(args, '--object');
      const session = world.sessions.get(objectId);
      if (session === undefined) throw new Error('Unknown fake status object');
      return respond({ data: session });
    }
    if (name === 'retry') throw new Error('Retry handled above');
    if (name === 'complete') return respond({ data: { alreadyCompleted: true } });
    if (name === 'delete') {
      const objectId = value(args, '--object');
      const object = world.objects.get(objectId);
      if (object === undefined) throw new Error('Unknown fake delete object');
      world.objects.set(objectId, { ...object, status: 'DELETED' });
      return respond({ data: world.objects.get(objectId) });
    }
    throw new Error(`Unexpected fake command ${String(name)}`);
  };
  return { world, client, command };
}

async function readReport(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

describe('runSmoke injected orchestration', () => {
  const reportPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(reportPaths.splice(0).map((reportPath) => rm(dirname(reportPath), { recursive: true, force: true })));
  });

  it('completes the bounded full flow, cleans three objects, and records one historical pending attempt', async () => {
    const runtime = fakeRuntime();
    const progress: unknown[] = [];
    const { report, reportPath } = await runSmoke(options, {
      client: runtime.client,
      command: runtime.command,
      progress: (event) => progress.push(event),
    });
    reportPaths.push(reportPath);
    const reportText = await readReport(reportPath);

    expect(report.status).toBe('PASSED');
    expect(report.objects).toHaveLength(3);
    expect(report.objects.every((object) => object.deleted)).toBe(true);
    expect([...runtime.world.objects.values()].every((object) => object.status === 'DELETED')).toBe(true);
    expect(report.pendingCleanup).toHaveLength(1);
    const oldSession = report.pendingCleanup[0]?.uploadSessionId;
    const currentSession = report.objects.find((object) => object.logicalKey.endsWith('retry.bin'))?.uploadSessionId;
    expect(oldSession).toBeDefined();
    expect(currentSession).toBeDefined();
    expect(currentSession).not.toBe(oldSession);
    expect(runtime.world.retryArguments).toHaveLength(1);
    expect(runtime.world.retryArguments[0]).toContain(oldSession);
    expect(runtime.world.retryArguments[0]).not.toContain(currentSession);
    expect(report.localDataRemoved).toBe(true);
    expect(await readdir(dirname(reportPath))).toEqual(['report.json']);
    expect(progress.filter((event) => typeof event === 'object' && event !== null).length).toBeGreaterThan(0);
    expect(reportText).not.toContain(token);
    expect(reportText).not.toMatch(/https?:\/\//u);
  });

  it('reconciles and deletes only its READY object after a mid-flow failure', async () => {
    const runtime = fakeRuntime('download');
    const { report, reportPath } = await runSmoke({ ...options, sizeBytes: 1_000_000 }, {
      client: runtime.client, command: runtime.command,
    });
    reportPaths.push(reportPath);
    const reportText = await readReport(reportPath);

    expect(report.status).toBe('FAILED');
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.objects).toHaveLength(1);
    expect(report.objects[0]?.deleted).toBe(true);
    expect(runtime.world.deleteCalls).toEqual([report.objects[0]?.objectId]);
    expect(runtime.world.objects.get(report.objects[0]?.objectId ?? '')?.status).toBe('DELETED');
    expect(report.localDataRemoved).toBe(true);
    expect(await readdir(dirname(reportPath))).toEqual(['report.json']);
    expect(reportText).not.toContain(token);
  });
});
