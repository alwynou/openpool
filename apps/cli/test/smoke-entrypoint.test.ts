import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const sourceDirectory = join(process.cwd(), 'src');
const token = 'opk_entrypoint_test_secret';
const bucket = 'bucket-entrypoint';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected loopback listener.');
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

function json(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data, requestId: 'entrypoint-request' }));
}

function apiError(response: ServerResponse, code: string, status: number): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code, message: 'safe fake failure' }, requestId: 'entrypoint-request' }));
}

function run(executable: string, args: string[], baseUrl?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child: ChildProcess = spawn(process.execPath, [executable, ...args], {
    env: {
      ...(baseUrl === undefined ? {} : { OPENPOOL_BASE_URL: baseUrl }),
      ...(baseUrl === undefined ? {} : { OPENPOOL_API_KEY: token }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('built smoke CLI entrypoint', () => {
  let buildDirectory: string;
  let executable: string;
  let server: Server;
  let baseUrl: string;
  const requests: { method: string; path: string; authorization: string | undefined }[] = [];
  let environment: 'production' | 'staging';
  let reserveFailure: boolean;

  beforeAll(async () => {
    buildDirectory = await mkdtemp(join(tmpdir(), 'openpool-smoke-entrypoint-'));
    await build({
      entryPoints: {
        cli: join(sourceDirectory, 'cli.ts'),
        'smoke-cli': join(sourceDirectory, 'smoke/cli.ts'),
        'smoke-observer': join(sourceDirectory, 'smoke/observer.ts'),
      },
      outdir: buildDirectory, bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true,
    });
    executable = join(buildDirectory, 'smoke-cli.js');
  });

  beforeEach(async () => {
    requests.length = 0;
    environment = 'staging';
    reserveFailure = false;
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://loopback').pathname;
      requests.push({ method: request.method ?? '', path: request.url ?? '/', authorization: request.headers.authorization });
      request.resume();
      if (path === '/api/v1/health') {
        json(response, { name: 'openpool', status: 'ok', version: 'entrypoint-test', environment });
      } else if (path === `/api/v1/buckets/${encodeURIComponent(bucket)}/objects`) {
        json(response, []);
      } else if (path === '/api/v1/uploads' && reserveFailure) {
        apiError(response, 'PROVIDER_UNAVAILABLE', 503);
      } else {
        apiError(response, 'NOT_FOUND', 404);
      }
    });
    baseUrl = await listen(server);
  });

  afterEach(async () => { await stop(server); });
  afterAll(async () => { await rm(buildDirectory, { recursive: true, force: true }); });

  it('runs help without credentials or network access', async () => {
    const result = await run(executable, ['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OpenPool opt-in staging CLI smoke');
    expect(result.stderr).toBe('');
    expect(requests).toEqual([]);
  });

  it('rejects remote writes without the explicit opt-in', async () => {
    const result = await run(executable, ['--bucket', bucket], baseUrl);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'SMOKE_CONFIGURATION_ERROR' } });
    expect(requests).toEqual([]);
  });

  it('fails safely on production health without spawning a child or writing objects', async () => {
    environment = 'production';
    const result = await run(executable, ['--allow-remote-writes', '--bucket', bucket, '--size-mb', '1'], baseUrl);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    const output = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const final = output.at(-1);
    expect(final).toMatchObject({ event: 'smoke-result', status: 'FAILED', objects: 0 });
    expect(requests.map((request) => `${request.method} ${new URL(request.path, 'http://loopback').pathname}`)).toEqual(['GET /api/v1/health']);
    expect(requests[0]?.authorization).toBe(`Bearer ${token}`);
    const reportPath = final?.reportPath;
    expect(typeof reportPath).toBe('string');
    if (typeof reportPath !== 'string') throw new Error('Missing report path.');
    expect(await readdir(dirname(reportPath))).toEqual(['report.json']);
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    const report = await readFile(reportPath, 'utf8');
    expect(report).not.toContain(token);
    await rm(dirname(reportPath), { recursive: true, force: true });
  });

  it('retains a child measurement and reconciles only the generated UUID prefix after reserve failure', async () => {
    reserveFailure = true;
    const result = await run(executable, [
      '--allow-remote-writes', '--bucket', bucket, '--prefix', 'entrypoint-smoke/', '--size-mb', '1',
    ], baseUrl);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    const output = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const final = output.at(-1);
    expect(final).toMatchObject({ event: 'smoke-result', status: 'FAILED', objects: 0 });
    const reportPath = final?.reportPath;
    expect(typeof reportPath).toBe('string');
    if (typeof reportPath !== 'string') throw new Error('Missing report path.');
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      prefix: string; localDataRemoved: boolean; commands: { label: string; observations: { type: string }[] }[];
    };
    expect(report.prefix).toMatch(/^entrypoint-smoke\/[0-9a-f-]{36}\/$/u);
    expect(report.localDataRemoved).toBe(true);
    expect(report.commands[0]?.label).toBe('baseline upload');
    expect(report.commands[0]?.observations).toHaveLength(1);
    expect(report.commands[0]?.observations[0]).toMatchObject({ type: 'measurement' });
    expect(requests.some((request) => request.method === 'POST' && request.path === '/api/v1/uploads')).toBe(true);
    const listRequests = requests.filter((request) => new URL(request.path, 'http://loopback').pathname === `/api/v1/buckets/${encodeURIComponent(bucket)}/objects`);
    expect(listRequests).toHaveLength(2);
    const listPrefixes = listRequests.map((request) => new URL(request.path, 'http://loopback').searchParams.get('prefix'));
    expect(listPrefixes.every((prefix) => prefix !== null && /^entrypoint-smoke\/[0-9a-f-]{36}\/$/u.test(prefix))).toBe(true);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
    expect(await readdir(dirname(reportPath))).toEqual(['report.json']);
    await rm(dirname(reportPath), { recursive: true, force: true });
  });
});
