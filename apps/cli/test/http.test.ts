import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpenPoolFetch } from '@openpool/sdk';

import { runCli } from '../src/run.js';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data, requestId: 'local-request' }));
}

function reject(response: ServerResponse, code: string, status: number): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code, message: 'safe fake error' }, requestId: 'local-request' }));
}

describe('CLI with real loopback HTTP and native file-backed Fetch', () => {
  let directory: string;
  let control: Server;
  let provider: Server;
  let baseUrl: string;
  let providerUrl: string;
  let session: string;
  let attempt: number;
  let stored: Buffer | undefined;
  let failPut: boolean;
  let loseCompletion: boolean;
  let uploadOnly: boolean;
  let controlBodySizes: number[];
  let puts: number;
  let providerHeadersSafe: boolean;
  let contentLengthCorrect: boolean;
  let metadata: { id: string; logicalBucketId: string; logicalKey: string; sizeBytes: number; contentType: string;
    status: string; checksum: null; createdAt: string; updatedAt: string };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openpool-cli-http-'));
    attempt = 0; session = ''; stored = undefined; failPut = false; loseCompletion = false; uploadOnly = false;
    controlBodySizes = []; puts = 0; providerHeadersSafe = true; contentLengthCorrect = true;
    metadata = { id: 'object-1', logicalBucketId: 'bucket-1', logicalKey: '', sizeBytes: 0, contentType: '',
      status: 'PENDING', checksum: null, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' };
    control = createServer((request, response) => {
      void (async () => {
        if (request.headers.authorization !== 'Bearer opk_local-test' || request.headers.cookie !== undefined) {
          reject(response, 'UNAUTHORIZED', 401); return;
        }
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (uploadOnly && !path.startsWith('/api/v1/uploads')) { reject(response, 'FORBIDDEN', 403); return; }
        const bytes = await body(request);
        controlBodySizes.push(bytes.length);
        const input = bytes.length === 0 ? {} : JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        if (path === '/api/v1/uploads' && request.method === 'POST') {
          if (attempt > 0 && input.retryUploadSessionId !== session) { reject(response, 'OBJECT_CONFLICT', 409); return; }
          session = `session-${++attempt}`;
          metadata = { ...metadata, logicalKey: String(input.logicalKey), sizeBytes: Number(input.sizeBytes), contentType: String(input.contentType), status: 'PENDING' };
          send(response, { objectId: metadata.id, uploadSessionId: session, uploadUrl: `https://provider.example/${session}?signature=fake`, expiresAt: '2026-09-03T00:15:00.000Z' }, 201);
        } else if (path === '/api/v1/uploads/object-1/complete') {
          if (input.uploadSessionId !== session) { reject(response, 'OBJECT_UPLOAD_NOT_FOUND', 404); return; }
          if (stored?.length !== metadata.sizeBytes) { reject(response, 'OBJECT_SIZE_MISMATCH', 422); return; }
          const alreadyCompleted = metadata.status === 'READY';
          metadata.status = 'READY';
          if (loseCompletion) { loseCompletion = false; request.socket.destroy(); return; }
          send(response, { object: metadata, uploadSessionId: session, alreadyCompleted });
        } else if (path === '/api/v1/uploads/object-1') {
          send(response, { objectId: metadata.id, uploadSessionId: session, status: metadata.status === 'READY' ? 'COMPLETED' : 'PENDING', expiresAt: '2026-09-03T00:15:00.000Z' });
        } else if (path === '/api/v1/objects/object-1/download') {
          send(response, { objectId: metadata.id, downloadUrl: `https://provider.example/${session}?signature=fake`, expiresAt: '2026-09-03T00:15:00.000Z' });
        } else if (path === '/api/v1/objects/object-1') {
          if (request.method === 'DELETE') { metadata.status = 'DELETED'; stored = undefined; }
          send(response, metadata);
        } else if (path === '/api/v1/buckets/bucket-1/objects') {
          send(response, [metadata]);
        } else reject(response, 'NOT_FOUND', 404);
      })().catch(() => reject(response, 'FAKE_SERVER_ERROR', 500));
    });
    provider = createServer((request, response) => {
      void (async () => {
        providerHeadersSafe &&= request.headers.authorization === undefined && request.headers.cookie === undefined && request.headers.referer === undefined;
        if (request.method === 'PUT') {
          puts++;
          const bytes = await body(request);
          contentLengthCorrect &&= Number(request.headers['content-length']) === metadata.sizeBytes && bytes.length === metadata.sizeBytes && request.headers['content-type'] === metadata.contentType;
          if (failPut) { failPut = false; response.writeHead(503); response.end('fake provider failure'); return; }
          stored = bytes;
          response.writeHead(200); response.end();
        } else if (stored === undefined) {
          response.writeHead(404); response.end();
        } else {
          response.writeHead(200, { 'content-length': stored.length, 'content-type': metadata.contentType });
          response.end(stored);
        }
      })().catch(() => { response.writeHead(500); response.end(); });
    });
    baseUrl = await listen(control);
    providerUrl = await listen(provider);
  });

  afterEach(async () => {
    await Promise.all([stop(control), stop(provider)]);
    await rm(directory, { recursive: true, force: true });
  });

  async function command(argv: string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetch: OpenPoolFetch = (input, init) => {
      const url = new URL(String(input));
      // Test-only routing: production still requires HTTPS signed provider URLs.
      return globalThis.fetch(url.origin === 'https://provider.example' ? new URL(`${url.pathname}${url.search}`, providerUrl) : url, init);
    };
    const code = await runCli(argv, { fetch, env: { OPENPOOL_BASE_URL: baseUrl, OPENPOOL_API_KEY: 'opk_local-test' },
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    expect(stdout.join('') + stderr.join('')).not.toMatch(/signature=|opk_local-test|fake provider failure/u);
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  }

  it('recovers a dropped completion response, downloads identical binary bytes, lists and deletes', async () => {
    const bytes = randomBytes(1024 * 1024 + 17);
    const input = join(directory, 'input.bin');
    const output = join(directory, 'download.bin');
    await writeFile(input, bytes);
    loseCompletion = true;
    const uploaded = await command(['upload', '--bucket', 'bucket-1', '--key', 'a binary file.bin ', '--file', input]);
    expect(uploaded.code).toBe(1);
    expect(uploaded.stderr).toContain('COMPLETE');
    expect(metadata.status).toBe('READY');
    expect((await command(['upload-status', '--object', 'object-1'])).stdout).toContain('COMPLETED');
    const completed = await command(['complete', '--object', 'object-1', '--session', session]);
    expect(completed.code).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({ data: { alreadyCompleted: true } });
    expect(puts).toBe(1);
    expect((await command(['list', '--bucket', 'bucket-1', '--limit', '1'])).stdout).toContain('a binary file.bin ');
    expect((await command(['stat', '--object', 'object-1'])).code).toBe(0);
    expect((await command(['download', '--object', 'object-1', '--output', output])).code).toBe(0);
    expect(await readFile(output)).toEqual(bytes);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    for (let repeat = 0; repeat < 2; repeat++) expect((await command(['delete', '--object', 'object-1'])).code).toBe(0);
    expect(stored).toBeUndefined();
    expect(providerHeadersSafe).toBe(true);
    expect(contentLengthCorrect).toBe(true);
    expect(controlBodySizes.every((size) => size < 1024)).toBe(true);
  });

  it('retries a failed native PUT with only upload scope, preserving identity and replacing the session', async () => {
    uploadOnly = true;
    failPut = true;
    const input = join(directory, 'input.bin');
    await writeFile(input, 'first payload');
    const first = await command(['upload', '--bucket', 'bucket-1', '--key', 'same-path', '--file', input]);
    expect(first.code).toBe(1);
    const previous = session;
    await writeFile(input, randomBytes(256 * 1024 + 5));
    const retry = await command(['retry', '--object', 'object-1', '--session', previous, '--bucket', 'bucket-1',
      '--key', 'same-path', '--file', input, '--content-type', 'application/x-openpool-test']);
    expect(retry.code).toBe(0);
    expect(session).not.toBe(previous);
    expect(metadata.id).toBe('object-1');
    expect(metadata.logicalKey).toBe('same-path');
    expect(stored).toEqual(await readFile(input));
    const obsolete = await command(['complete', '--object', 'object-1', '--session', previous]);
    expect(obsolete.code).toBe(1);
    expect(obsolete.stderr).toContain('OBJECT_UPLOAD_NOT_FOUND');
    expect(puts).toBe(2);
    expect(providerHeadersSafe).toBe(true);
    expect(contentLengthCorrect).toBe(true);
  });
});
