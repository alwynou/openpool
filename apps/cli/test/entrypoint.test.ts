import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const directory = fileURLToPath(new URL('../', import.meta.url));
const executable = fileURLToPath(new URL('../bin/openpool.mjs', import.meta.url));

describe('built Node CLI entrypoint', () => {
  let server: Server;
  let baseUrl: string;
  let mode: 'redirect' | 'stall';
  let redirected: boolean;

  beforeAll(() => { execFileSync(process.execPath, ['build.mjs'], { cwd: directory }); });
  beforeEach(async () => {
    mode = 'stall'; redirected = false;
    server = createServer((request, response) => {
      if (request.url === '/unexpected') { redirected = true; response.end('unexpected'); }
      else if (mode === 'redirect') { response.writeHead(302, { location: `${baseUrl}/unexpected` }); response.end(); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    const close = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await close;
  });

  function child(args: string[], key: string | undefined = 'opk_fake-entrypoint') {
    const process = spawn(globalThis.process.execPath, [executable, ...args], {
      env: { OPENPOOL_BASE_URL: baseUrl, OPENPOOL_API_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    process.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    process.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const finished = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      process.on('error', reject);
      process.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    return { process, finished };
  }

  it('runs the bundled workspace SDK without a TS runtime or browser dependencies', async () => {
    const result = await child(['--help'], '').finished;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OpenPool object CLI');
    expect(result.stderr).toBe('');
  });

  it('reports invalid credentials as JSON with exit code 2', async () => {
    const result = await child(['stat', '--object', 'object-1'], '').finished;
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'CONFIGURATION_ERROR' } });
  });

  it('handles a closed output pipe without printing an unhandled exception', async () => {
    const running = child(['--help']);
    running.process.stdout.destroy();
    const result = await running.finished;
    expect(result.code).toBe(1);
    expect(result.stderr).not.toMatch(/Unhandled|EPIPE|node:events|stack/u);
  });

  it('does not follow a control-plane redirect', async () => {
    mode = 'redirect';
    const result = await child(['stat', '--object', 'object-1']).finished;
    expect(result.code).toBe(1);
    expect(redirected).toBe(false);
    expect(result.stderr).not.toMatch(/opk_fake-entrypoint|http:|TypeError|stack/u);
  });

  it('terminates a stalled native fetch on timeout', async () => {
    const result = await child(['stat', '--object', 'object-1', '--timeout-ms', '30']).finished;
    expect(result.code).toBe(124);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'TIMEOUT' } });
  });

  it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('handles %s with a stable exit code', async (signal, code) => {
    const received = once(server, 'request');
    const running = child(['stat', '--object', 'object-1']);
    await received;
    running.process.kill(signal);
    const result = await running.finished;
    expect(result.code).toBe(code);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'INTERRUPTED' } });
  });
});
