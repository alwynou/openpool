import { describe, expect, it } from 'vitest';

import { readJsonBody } from '../src/adapters/http/json-body';

function request(body: string, headers: HeadersInit = {}): Request {
  return new Request('https://openpool.test/api/v1/example', {
    method: 'POST',
    headers,
    body,
  });
}

describe('readJsonBody', () => {
  it('accepts bounded UTF-8 application/json bodies', async () => {
    await expect(
      readJsonBody(
        request('{"name":"bucket"}', {
          'content-type': 'application/json; charset=utf-8',
        }),
      ),
    ).resolves.toEqual({ name: 'bucket' });
  });

  it.each([
    ['missing content type', {}],
    ['unsupported content type', { 'content-type': 'text/plain' }],
    [
      'compressed body',
      { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    ],
  ])('rejects %s', async (_name, headers) => {
    await expect(readJsonBody(request('{}', headers))).resolves.toBeUndefined();
  });

  it('rejects bodies larger than 64 KiB even without Content-Length', async () => {
    const body = JSON.stringify({ value: 'x'.repeat(64 * 1024) });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const oversized = new Request('https://openpool.test/api/v1/example', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: source,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(readJsonBody(oversized)).resolves.toBeUndefined();
  });

  it('rejects an invalid declared length before reading the body', async () => {
    await expect(
      readJsonBody(
        request('{}', {
          'content-type': 'application/json',
          'content-length': '65537',
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
