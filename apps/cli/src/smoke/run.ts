import { createReadStream } from 'node:fs';
import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomFillSync, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenPoolClient } from '@openpool/sdk';
import { CliFailure } from '../errors.js';
import { metadata, uploadSummary } from '../responses.js';
import { commandFor, type Command, type CommandResult } from './child.js';
import type { Fault } from './observer.js';
import { parseObservation } from './observations.js';
import type { SmokeOptions } from './options.js';

export interface OwnedObject { objectId: string; logicalKey: string; uploadSessionId?: string; deleted: boolean; }
export interface SmokeReport {
  runId: string; prefix: string; sizeBytes: number; startedAt: string; finishedAt?: string;
  status: 'RUNNING' | 'PASSED' | 'FAILED'; checks: string[]; objects: OwnedObject[];
  commands: { label: string; code: number | null; elapsedMs: number; observations: CommandResult['observations'] }[];
  pendingCleanup: { objectId: string; status: string; uploadSessionId?: string; expiresAt?: string }[];
  failures: string[]; localDataRemoved: boolean;
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new CliFailure('SMOKE_CHECK_FAILED', message);
}
function record(value: unknown): Record<string, unknown> {
  check(typeof value === 'object' && value !== null && !Array.isArray(value), 'Invalid CLI JSON.');
  return value as Record<string, unknown>;
}
function data(result: CommandResult): unknown {
  check(result.code === 0, 'CLI command did not succeed.');
  return record(result.output).data;
}
function errorCode(result: CommandResult): unknown {
  for (const value of result.events) { const item = record(value); if (item.error) return record(item.error).code; }
  return undefined;
}

export function checkedObservations(result: CommandResult, command: string, fault: Fault): CommandResult['observations'] {
  const observations = result.observations.map(parseObservation);
  const measurements = observations.filter((event) => event.type === 'measurement');
  check(measurements.length === 1, 'Child resource/transport observations are missing.');
  const expected: Record<string, readonly [number, number, number]> = {
    upload: [2, 1, 0], retry: [3, 1, 0], download: [2, 0, 1],
    'upload-status': [1, 0, 0], complete: [1, 0, 0], delete: [1, 0, 0],
  };
  const counts = fault === 'upload-interrupt' ? [1, 1, 0] :
    command === 'download' && result.code === 1 && errorCode(result) === 'OUTPUT_EXISTS' ? [0, 0, 0] : expected[command];
  const measurement = measurements[0];
  check(counts && measurement && measurement.controlRequests === counts[0] && measurement.puts === counts[1] && measurement.gets === counts[2],
    'Child control/direct request counts differ from the expected flow.');
  return observations;
}

export async function fixture(path: string, sizeBytes: number): Promise<string> {
  const file = await open(path, 'wx', 0o600);
  const block = Buffer.alloc(65536);
  const hash = createHash('sha256');
  try {
    for (let written = 0; written < sizeBytes;) {
      const chunk = block.subarray(0, Math.min(block.length, sizeBytes - written));
      randomFillSync(chunk); hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const part = await file.write(chunk, offset, chunk.length - offset);
        check(part.bytesWritten > 0, 'Unable to write fixture.'); offset += part.bytesWritten;
      }
      written += chunk.length;
    }
    return hash.digest('hex');
  } finally { await file.close(); }
}

export async function digest(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { const buffer = chunk as Buffer; hash.update(buffer); bytes += buffer.length; }
  return { bytes, sha256: hash.digest('hex') };
}

/** Reconciles only the cryptographically unique run namespace; never recreates/retries an upload. */
export async function reconcile(client: Pick<OpenPoolClient, 'listObjects' | 'getUpload' | 'deleteObject'>,
  bucketId: string, report: SmokeReport): Promise<void> {
  const listed = await client.listObjects(bucketId, { prefix: report.prefix, limit: 100 }, { signal: AbortSignal.timeout(30000) });
  check(listed.length < 100, 'Cleanup listing was truncated.');
  for (const raw of listed) {
    const object = metadata(raw);
    check(object.logicalBucketId === bucketId && object.logicalKey.startsWith(report.prefix), 'Cleanup escaped this run namespace.');
    let owned = report.objects.find((item) => item.objectId === object.id);
    if (!owned) { owned = { objectId: object.id, logicalKey: object.logicalKey, deleted: false }; report.objects.push(owned); }
    if (object.status === 'READY' || object.status === 'DELETING') {
      const deleted = metadata(await client.deleteObject(object.id, { signal: AbortSignal.timeout(30000) }));
      check(deleted.id === object.id && deleted.status === 'DELETED', 'Cleanup deletion was not confirmed.'); owned.deleted = true;
    } else if (object.status === 'DELETED') owned.deleted = true;
    else {
      const current = uploadSummary(await client.getUpload(object.id, { signal: AbortSignal.timeout(30000) }), object.id);
      owned.uploadSessionId = current.uploadSessionId;
      report.pendingCleanup.push({ objectId: object.id, status: current.status, uploadSessionId: current.uploadSessionId, expiresAt: current.expiresAt });
    }
  }
  // A receipt that cannot be reconciled is ambiguous, never silently declared deleted.
  for (const object of report.objects) check(listed.some((item) => item.id === object.objectId), 'A reserved object is missing from cleanup listing.');
}

export async function runSmoke(options: SmokeOptions, runtime: {
  signal?: AbortSignal; progress?: (value: unknown) => void;
  command?: (onReceipt: (receipt: unknown) => void) => Command;
  client?: Pick<OpenPoolClient, 'health' | 'listObjects' | 'getUpload' | 'deleteObject'>;
} = {}): Promise<{ report: SmokeReport; reportPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'openpool-cli-smoke-'));
  const files = await mkdtemp(join(directory, 'files-'));
  const reportPath = join(directory, 'report.json');
  const runId = randomUUID();
  const report: SmokeReport = { runId, prefix: `${options.prefix}${runId}/`, sizeBytes: options.sizeBytes,
    startedAt: new Date().toISOString(), status: 'RUNNING', checks: [], objects: [], commands: [], pendingCleanup: [], failures: [], localDataRemoved: false };
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2)
    .replaceAll(JSON.stringify(options.apiKey).slice(1, -1), '[REDACTED]'), { mode: 0o600 });
  const client = runtime.client ?? new OpenPoolClient({ baseUrl: options.baseUrl, apiKey: options.apiKey,
    fetch: (input, init) => globalThis.fetch(input, { ...init, redirect: 'error' }) });
  let mayHaveReserved = false;
  const receipt = (value: unknown) => {
    const item = record(value);
    if (item.event !== 'upload-reserved') return;
    check(item.bucketId === options.bucketId && typeof item.logicalKey === 'string' && item.logicalKey.startsWith(report.prefix) &&
      typeof item.objectId === 'string' && typeof item.uploadSessionId === 'string', 'Invalid upload receipt.');
    const existing = report.objects.find((object) => object.objectId === item.objectId);
    if (existing) existing.uploadSessionId = item.uploadSessionId;
    else report.objects.push({ objectId: item.objectId, logicalKey: item.logicalKey, uploadSessionId: item.uploadSessionId, deleted: false });
  };
  const command = runtime.command?.(receipt) ?? commandFor(options, receipt);
  const call = async (label: string, args: string[], fault: Fault = 'none') => {
    runtime.signal?.throwIfAborted();
    if (args[0] === 'upload' || args[0] === 'retry') mayHaveReserved = true;
    const result = await command(args, fault, runtime.signal);
    // Parse before persisting: raw IPC data must never become report fields.
    const observations = result.observations.map(parseObservation);
    report.commands.push({ label, code: result.code, elapsedMs: result.elapsedMs, observations });
    await save();
    checkedObservations(result, args[0] ?? '', fault);
    runtime.progress?.({ event: 'smoke-step', label, exitCode: result.code });
    return result;
  };
  const passed = (label: string) => { report.checks.push(label); };
  const verifyDownload = async (id: string, output: string, bytes: number, sha256: string, label: string) => {
    const result = record(data(await call(label, ['download', '--object', id, '--output', output])));
    const local = await digest(output);
    check(result.bytes === bytes && result.sha256 === sha256 && local.bytes === bytes && local.sha256 === sha256, 'Downloaded size or SHA-256 differs.');
  };
  try {
    await save();
    const health = await client.health({ signal: AbortSignal.timeout(30000) });
    check(health.environment === 'staging', 'Only an explicitly identified staging environment may be tested.');
    check((await client.listObjects(options.bucketId, { prefix: report.prefix, limit: 1 }, { signal: AbortSignal.timeout(30000) })).length === 0, 'Run prefix is not empty.');
    passed('staging and empty isolated namespace');
    const small = join(files, 'baseline.bin'), large = join(files, 'large.bin');
    const smallHash = await fixture(small, 1_000_000), largeHash = await fixture(large, options.sizeBytes);
    for (const [label, input, bytes, sha256] of [['baseline', small, 1_000_000, smallHash], ['large', large, options.sizeBytes, largeHash]] as const) {
      const key = `${report.prefix}${label}.bin`;
      const result = record(data(await call(`${label} upload`, ['upload', '--bucket', options.bucketId, '--key', key, '--file', input])));
      const object = metadata(result.object);
      check(object.logicalKey === key && object.status === 'READY' && object.sizeBytes === bytes, 'Uploaded metadata differs.');
      const output = join(files, `${label}-download.bin`);
      await verifyDownload(object.id, output, bytes, sha256, `${label} download`);
      if (label === 'large') {
        const conflict = await call('download refuses overwrite', ['download', '--object', object.id, '--output', output]);
        check(conflict.code === 1 && errorCode(conflict) === 'OUTPUT_EXISTS' && (await digest(output)).sha256 === sha256, 'Download overwrote an existing file.');
        const interruptedOutput = join(files, 'interrupted-download.bin');
        const interrupted = await call('interrupt download', ['download', '--object', object.id, '--output', interruptedOutput], 'download-interrupt');
        check(interrupted.code === 130 && interrupted.observations.some((event) => event.type === 'interruption' && event.direction === 'download' && event.bytes > 0 && event.bytes < bytes), 'Download interruption was not demonstrated.');
        const remaining = await readdir(files);
        check(!remaining.includes('interrupted-download.bin') && !remaining.some((name) => name.startsWith('.openpool-download-')), 'Partial download files remain.');
        await verifyDownload(object.id, interruptedOutput, bytes, sha256, 'download after interruption');
        passed('partial GET SIGINT cleanup and explicit fresh download');
      }
      check(metadata(data(await call(`${label} delete`, ['delete', '--object', object.id]))).status === 'DELETED', 'Delete did not complete.');
      passed(`${label} binary round trip and deletion`);
    }

    const key = `${report.prefix}retry.bin`;
    const interrupted = await call('interrupt upload', ['upload', '--bucket', options.bucketId, '--key', key, '--file', large], 'upload-interrupt');
    check(interrupted.code === 130 && interrupted.observations.some((event) => event.type === 'interruption' && event.direction === 'upload' && event.bytes > 0 && event.bytes < options.sizeBytes), 'Partial upload interruption was not demonstrated.');
    const own = report.objects.find((object) => object.logicalKey === key);
    check(own?.uploadSessionId, 'Interrupted upload receipt is missing.');
    const previous = own.uploadSessionId;
    const current = uploadSummary(data(await call('interrupted upload status', ['upload-status', '--object', own.objectId])), own.objectId);
    check(current.uploadSessionId === previous && current.status !== 'COMPLETED', 'Interrupted upload completed unexpectedly.');
    report.pendingCleanup.push({ objectId: own.objectId, status: 'OLD_ATTEMPT_AWAITS_CRON', uploadSessionId: previous, expiresAt: current.expiresAt });
    const retried = record(data(await call('explicit upload retry', ['retry', '--bucket', options.bucketId, '--key', key,
      '--file', large, '--object', own.objectId, '--session', previous])));
    check(metadata(retried.object).id === own.objectId && retried.uploadSessionId !== previous, 'Retry did not isolate the session.');
    await verifyDownload(own.objectId, join(files, 'retried-download.bin'), options.sizeBytes, largeHash, 'retried download');
    check(record(data(await call('repeat completion', ['complete', '--object', own.objectId, '--session', String(retried.uploadSessionId)]))).alreadyCompleted === true, 'Completion is not idempotent.');
    passed('partial PUT SIGINT and explicit same-object/new-session retry');
    check(metadata(data(await call('retry object delete', ['delete', '--object', own.objectId]))).status === 'DELETED', 'Retried object was not deleted.');
    check(metadata(data(await call('repeat deletion', ['delete', '--object', own.objectId]))).status === 'DELETED', 'Deletion is not idempotent.');
    passed('idempotent complete and delete');
  } catch (error) {
    report.failures.push(error instanceof CliFailure ? error.message : 'Smoke stopped because an operation failed or was interrupted.');
  } finally {
    if (mayHaveReserved) {
      try { await reconcile(client, options.bucketId, report); }
      catch { report.failures.push('Remote reconciliation incomplete; inspect only the recorded run prefix.'); }
    }
    try { await rm(files, { recursive: true, force: true }); report.localDataRemoved = true; }
    catch { report.failures.push('Unable to remove the owned local fixture directory.'); }
    if (report.objects.some((object) => !object.deleted)) report.failures.push('Current pending uploads remain for normal expiry cleanup.');
    report.status = report.failures.length === 0 ? 'PASSED' : 'FAILED';
    report.finishedAt = new Date().toISOString();
    await save();
  }
  return { report, reportPath };
}
