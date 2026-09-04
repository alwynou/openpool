import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenPoolFetch } from '@openpool/sdk';

import { runCli, type CliRuntime } from '../src/run.js';

const apiKey = 'opk_fake-cli-test-key';
const env = { OPENPOOL_BASE_URL: 'https://control.example', OPENPOOL_API_KEY: apiKey,
  OPENPOOL_SESSION_COOKIE: 'openpool_session=must-never-be-sent' };
const object = { id: 'object-1', logicalBucketId: 'bucket-1', logicalKey: 'folder/file.bin ', sizeBytes: 3,
  contentType: 'application/octet-stream', checksum: null, status: 'READY',
  createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' };
const reserved = { objectId: object.id, uploadSessionId: 'new-session',
  uploadUrl: 'https://provider.example/upload?signature=never-print-this', expiresAt: '2026-09-03T00:15:00.000Z' };
const completed = { object, uploadSessionId: reserved.uploadSessionId, alreadyCompleted: false };
const current = { objectId: object.id, uploadSessionId: 'old-session', status: 'EXPIRED', expiresAt: reserved.expiresAt };
const download = { objectId: object.id, downloadUrl: 'https://provider.example/download?signature=never-print-this', expiresAt: reserved.expiresAt };

function envelope(data: unknown, status = 200): Response {
  return Response.json({ data, requestId: 'request-1' }, { status });
}

function sequence(...responses: (Response | Error)[]) {
  return vi.fn<OpenPoolFetch>(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('Unexpected request');
    return next;
  });
}

async function invoke(args: string[], fetch: OpenPoolFetch, overrides: CliRuntime = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(args, { env, fetch, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), ...overrides });
  return { code, stdout: stdout.join(''), stderr: stderr.join(''), events: stderr.map((line) => JSON.parse(line) as unknown) };
}

describe('object CLI', () => {
  let directory: string;
  let input: string;
  let output: string;
  const uploadArgs = () => ['upload', '--bucket', object.logicalBucketId, '--key', object.logicalKey, '--file', input];
  const retryArgs = () => ['retry', '--object', object.id, '--session', current.uploadSessionId,
    '--bucket', object.logicalBucketId, '--key', object.logicalKey, '--file', input];
  const downloadArgs = () => ['download', '--object', object.id, '--output', output];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openpool-cli-test-'));
    input = join(directory, 'input.bin');
    output = join(directory, 'output.bin');
    await writeFile(input, 'abc');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('prints help without credentials or network access', async () => {
    const fetch = sequence();
    const result = await invoke(['--help'], fetch, { env: {} });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('upload-status');
    expect(result.stderr).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, '', ' padded-key ', 'line\nbreak'])(
    'rejects missing or invalid credentials before network access: %j', async (key) => {
      const fetch = sequence();
      const result = await invoke(['stat', '--object', object.id], fetch, { env: { OPENPOOL_BASE_URL: env.OPENPOOL_BASE_URL, OPENPOOL_API_KEY: key } });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('CONFIGURATION_ERROR');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['http://remote.example', 'https://user:secret@control.example', 'https://control.example/api',
    'https://control.example/?secret=token', 'https://control.example/#secret', 'invalid-url'])(
    'rejects unsafe control URLs without echoing them: %s', async (baseUrl) => {
      const fetch = sequence();
      const result = await invoke(['stat', '--object', object.id, '--base-url', baseUrl], fetch);
      expect(result.code).toBe(2);
      expect(result.stderr).not.toContain(baseUrl);
      expect(result.stderr).not.toContain('secret');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('lists a bounded page with an exact cursor, encoded paths and restricted bearer auth', async () => {
    const item = { ...object, logicalBucketId: 'bucket/one' };
    const fetch = sequence(envelope([item]));
    const result = await invoke(['list', '--bucket', item.logicalBucketId, '--prefix', 'folder/', '--after-key', 'folder/a ', '--limit', '1'], fetch);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ data: [item], nextAfterKey: object.logicalKey });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toContain('/buckets/bucket%2Fone/objects?prefix=folder%2F&afterKey=folder%2Fa+&limit=1');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns a null continuation hint for an empty page', async () => {
    const result = await invoke(['list', '--bucket', 'bucket-1'], sequence(envelope([])));
    expect(JSON.parse(result.stdout)).toEqual({ data: [], nextAfterKey: null });
  });

  it('prints only public object fields and rejects inconsistent metadata', async () => {
    const result = await invoke(['stat', '--object', object.id], sequence(envelope({ ...object, credentialEnvelope: 'never-print-this', uploadUrl: reserved.uploadUrl })));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ data: object });
    expect(result.stdout).not.toContain('never-print-this');
    const invalid = await invoke(['stat', '--object', 'other-id'], sequence(envelope(object)));
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('PROTOCOL_ERROR');
  });

  it('deletes exactly one requested object, including an explicit repeat', async () => {
    const fetch = sequence(envelope({ ...object, status: 'DELETED' }), envelope({ ...object, status: 'DELETED' }));
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await invoke(['delete', '--object', object.id], fetch)).code).toBe(0);
    }
    expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(['DELETE', 'DELETE']);
  });

  it('uploads a file-backed Blob using reserve, direct PUT and complete without exposing URLs', async () => {
    const fetch = sequence(envelope(reserved, 201), new Response(null), envelope(completed));
    const result = await invoke(uploadArgs(), fetch);
    expect(result.code).toBe(0);
    expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'PUT', 'POST']);
    const controlBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(controlBody).toEqual({ bucketId: object.logicalBucketId, logicalKey: object.logicalKey, sizeBytes: 3, contentType: object.contentType });
    const put = fetch.mock.calls[1]?.[1];
    const body = put?.body;
    expect(body).toBeInstanceOf(Blob);
    if (!(body instanceof Blob)) throw new Error('Expected a file-backed Blob');
    expect(await body.text()).toBe('abc');
    expect(new Headers(put?.headers).get('content-type')).toBe(object.contentType);
    expect(new Headers(put?.headers).has('authorization')).toBe(false);
    expect(new Headers(put?.headers).has('cookie')).toBe(false);
    expect(put).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(result.stdout)).toEqual({ data: completed });
    expect(result.events).toEqual([{ event: 'upload-reserved', objectId: object.id, uploadSessionId: reserved.uploadSessionId,
      bucketId: object.logicalBucketId, logicalKey: object.logicalKey }]);
    expect(result.stdout + result.stderr).not.toMatch(/signature=|never-print-this|opk_fake|openpool_session/u);
  });

  it('rejects a missing file or directory before creating a reservation', async () => {
    for (const file of [directory, join(directory, 'missing')]) {
      const fetch = sequence();
      const result = await invoke(['upload', '--bucket', 'bucket-1', '--key', 'key', '--file', file], fetch);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('INPUT_FILE_UNAVAILABLE');
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it.each(['PENDING', 'EXPIRED', 'ABORTED'])('explicitly replaces a matching %s session using upload scope only', async (status) => {
    const fetch = sequence(envelope({ ...current, status }), envelope(reserved, 201), new Response(null), envelope(completed));
    const result = await invoke(retryArgs(), fetch);
    expect(result.code).toBe(0);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(`/uploads/${object.id}`);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ retryUploadSessionId: current.uploadSessionId, logicalKey: object.logicalKey });
    expect(fetch.mock.calls).toHaveLength(4);
    expect(fetch.mock.calls.filter((call) => String(call[0]).includes('/objects/'))).toHaveLength(0);
  });

  it.each([{ ...current, uploadSessionId: 'someone-elses-session' }, { ...current, status: 'COMPLETED' }])(
    'does not replace a changed or completed session', async (session) => {
      const fetch = sequence(envelope(session));
      const result = await invoke(retryArgs(), fetch);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('surfaces a concurrent retry conflict without trying again', async () => {
    const conflict = Response.json({ error: { code: 'OBJECT_CONFLICT', message: 'upstream secret' }, requestId: 'request-1' }, { status: 409 });
    const fetch = sequence(envelope(current), conflict);
    const result = await invoke(retryArgs(), fetch);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('OBJECT_CONFLICT');
    expect(result.stderr).not.toContain('upstream secret');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps safe recovery IDs on failed PUT and never automatically completes or retries', async () => {
    const fetch = sequence(envelope(reserved), new Response('provider body containing credentials', { status: 503 }));
    const result = await invoke(uploadArgs(), fetch);
    expect(result.code).toBe(1);
    expect(result.events[1]).toMatchObject({ error: { code: 'TRANSFER_FAILED', status: 503 }, upload: {
      phase: 'PUT', objectId: object.id, uploadSessionId: reserved.uploadSessionId,
    } });
    expect(result.stderr).not.toMatch(/signature=|provider body|credentials|opk_fake/u);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('recovers a lost completion response using complete only', async () => {
    const first = sequence(envelope(reserved), new Response(null), new Error(`${reserved.uploadUrl} ${apiKey}`));
    const failed = await invoke(uploadArgs(), first);
    expect(failed.code).toBe(1);
    expect(failed.events[1]).toMatchObject({ upload: { phase: 'COMPLETE', uploadSessionId: reserved.uploadSessionId } });
    expect(failed.stderr).not.toContain(reserved.uploadUrl);
    const next = sequence(envelope({ ...completed, alreadyCompleted: true }));
    const recovered = await invoke(['complete', '--object', object.id, '--session', reserved.uploadSessionId], next);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({ data: { alreadyCompleted: true } });
    expect(next).toHaveBeenCalledTimes(1);
    expect(String(next.mock.calls[0]?.[0])).toContain('/complete');
  });

  it('warns about an uncertain reservation without repeating it or logging a fetch error', async () => {
    const fetch = sequence(new Error(`https://secret.example/?token=${apiKey}`));
    const result = await invoke(uploadArgs(), fetch);
    expect(result.code).toBe(1);
    expect(result.events[0]).toMatchObject({ upload: { phase: 'RESERVE', bucketId: object.logicalBucketId, logicalKey: object.logicalKey } });
    expect(result.stderr).not.toMatch(/https:|opk_fake/u);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the upload-only status endpoint and excludes unexpected fields', async () => {
    const result = await invoke(['upload-status', '--object', object.id], sequence(envelope({ ...current, uploadUrl: reserved.uploadUrl })));
    expect(JSON.parse(result.stdout)).toEqual({ data: current });
  });

  it('redacts a raw key even in otherwise valid upstream request IDs', async () => {
    const fetch = sequence(Response.json({ error: { code: 'FORBIDDEN', message: `cookie or secret ${apiKey}` }, requestId: apiKey }, { status: 403 }));
    const result = await invoke(['stat', '--object', object.id], fetch);
    expect(result.stderr).toContain('FORBIDDEN');
    expect(result.stderr).not.toMatch(/opk_fake|cookie or secret/u);
  });

  it('blocks an invalid signed URL before sending file data', async () => {
    const fetch = sequence(envelope({ ...reserved, uploadUrl: 'http://provider.example/?secret=invalid' }));
    const result = await invoke(uploadArgs(), fetch);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain('secret=invalid');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never sends object bytes to the control-plane origin', async () => {
    const fetch = sequence(envelope({ ...reserved, uploadUrl: `${env.OPENPOOL_BASE_URL}/unexpected-upload` }));
    const result = await invoke(uploadArgs(), fetch);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PROTOCOL_ERROR');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cancels the unused direct PUT response body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const result = await invoke(uploadArgs(), sequence(envelope(reserved), response, envelope(completed)));
    expect(result.code).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('refuses to complete if the source file changes after reservation', async () => {
    const fetch = vi.fn<OpenPoolFetch>(async (_url, init) => {
      if (init?.method !== 'PUT') return envelope(reserved);
      await writeFile(input, 'changed content');
      await (init.body as Blob).arrayBuffer();
      return new Response(null);
    });
    const result = await invoke(uploadArgs(), fetch);
    expect(result.code).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.events[1]).toMatchObject({ upload: { phase: 'PUT' } });
  });

  it('streams a download to a private new file with matching length and SHA-256', async () => {
    const fetch = sequence(envelope(object), envelope(download), new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([97])); controller.enqueue(new Uint8Array([98, 99])); controller.close(); },
    })));
    const result = await invoke(downloadArgs(), fetch);
    expect(result.code).toBe(0);
    expect(await readFile(output, 'utf8')).toBe('abc');
    expect(JSON.parse(result.stdout)).toEqual({ data: { objectId: object.id, output, bytes: 3, sha256: createHash('sha256').update('abc').digest('hex') } });
    expect((await readdir(directory)).sort()).toEqual(['input.bin', 'output.bin']);
    const direct = fetch.mock.calls[2]?.[1];
    expect(direct).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(new Headers(direct?.headers).has('authorization')).toBe(false);
  });

  it.each(['existing-file', 'dangling-symlink'])('refuses %s output before network access', async (kind) => {
    if (kind === 'existing-file') await writeFile(output, 'keep');
    else await symlink(join(directory, 'missing'), output);
    const fetch = sequence();
    const result = await invoke(downloadArgs(), fetch);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('OUTPUT_EXISTS');
    expect(fetch).not.toHaveBeenCalled();
    if (kind === 'existing-file') expect(await readFile(output, 'utf8')).toBe('keep');
  });

  it('does not overwrite a destination created while downloading', async () => {
    let calls = 0;
    const fetch: OpenPoolFetch = async () => {
      if (calls++ === 0) return envelope(object);
      if (calls === 2) return envelope(download);
      await writeFile(output, 'created-concurrently');
      return new Response('abc');
    };
    const result = await invoke(downloadArgs(), fetch);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('OUTPUT_EXISTS');
    expect(await readFile(output, 'utf8')).toBe('created-concurrently');
    expect((await readdir(directory)).sort()).toEqual(['input.bin', 'output.bin']);
  });

  it.each(['ab', 'abcd'])('removes a partial download when the length mismatches: %s', async (bytes) => {
    const result = await invoke(downloadArgs(), sequence(envelope(object), envelope(download), new Response(bytes)));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DOWNLOAD_SIZE_MISMATCH');
    expect(await readdir(directory)).toEqual(['input.bin']);
  });

  it('handles empty objects without requiring a response body', async () => {
    const result = await invoke(downloadArgs(), sequence(envelope({ ...object, sizeBytes: 0 }), envelope(download), new Response(null)));
    expect(result.code).toBe(0);
    expect((await readFile(output)).length).toBe(0);
  });

  it('cleans temporary files after a provider rejection or broken stream', async () => {
    for (const response of [new Response('never print provider body', { status: 403 }), new Response(new ReadableStream({
      start(controller) { controller.error(new Error(`${apiKey} ${download.downloadUrl}`)); },
    }))]) {
      const result = await invoke(downloadArgs(), sequence(envelope(object), envelope(download), response));
      expect(result.code).toBe(1);
      expect(result.stderr).not.toMatch(/opk_fake|signature=|never print/u);
      expect(await readdir(directory)).toEqual(['input.bin']);
    }
  });

  it('rejects partial HTTP responses instead of publishing a truncated file', async () => {
    const result = await invoke(downloadArgs(), sequence(envelope(object), envelope(download), new Response('abc', { status: 206 })));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('INVALID_DOWNLOAD_RESPONSE');
    expect(await readdir(directory)).toEqual(['input.bin']);
  });

  it('times out a stalled request with a stable exit code and no retries', async () => {
    const fetch = vi.fn<OpenPoolFetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(`network secret ${apiKey}`)), { once: true });
    }));
    const result = await invoke(['stat', '--object', object.id, '--timeout-ms', '20'], fetch);
    expect(result.code).toBe(124);
    expect(result.stderr).toContain('TIMEOUT');
    expect(result.stderr).not.toContain(apiKey);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not start network activity when already interrupted', async () => {
    const fetch = sequence();
    const result = await invoke(['stat', '--object', object.id], fetch, { signal: AbortSignal.abort(new Error('private reason')) });
    expect(result.code).toBe(130);
    expect(result.stderr).not.toContain('private reason');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels a stalled response body on interruption and removes temporary files', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull() { controller.abort(new Error('private reason')); }, cancel,
    }, { highWaterMark: 0 });
    const result = await invoke(downloadArgs(), sequence(envelope(object), envelope(download), new Response(body)), { signal: controller.signal });
    expect(result.code).toBe(130);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual(['input.bin']);
  });
});
