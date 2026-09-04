import { describe, expect, it, vi } from 'vitest';

import type { CredentialPayload } from '@openpool/application';
import { ProviderError } from '@openpool/domain';

import { S3CompatibleProvider } from '../src/adapters/providers/s3-compatible';

const credentials: CredentialPayload = {
  accessKeyId: 'generic-access-key',
  secretAccessKey: 'generic-secret-must-not-leak',
};

const config = {
  endpoint: 'https://objects.example.test',
  region: 'us-east-1',
  addressingStyle: 'path',
  validationBucket: 'validation-bucket',
} as const;

const account = { providerConfig: config } as never;

function provider(
  fetch: typeof globalThis.fetch = vi.fn(
    async () => new Response(null, { status: 204 }),
  ),
  timeoutMs = 10_000,
) {
  return new S3CompatibleProvider({
    fetch,
    timeoutMs,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });
}

describe('S3CompatibleProvider object operations', () => {
  it('creates a GET download URL and returns only the application port fields', async () => {
    const result = await provider().createDownloadUrl({
      account,
      credentials,
      bucket: 'objects',
      key: 'folder/object.txt',
      expiresInSeconds: 300,
    });

    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'url']);
    expect(result.url).toMatch(
      /^https:\/\/objects\.example\.test\/objects\/folder\/object\.txt\?/u,
    );
    expect(result.url).toContain('X-Amz-Expires=300');
    expect(result.url).not.toContain(credentials.secretAccessKey as string);
  });

  it('sends a signed HEAD and strictly maps object metadata', async () => {
    let request: Request | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input);
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': '123',
          etag: '"d41d8cd98f00b204e9800998ecf8427e"',
          'x-amz-checksum-sha256': 'YWJjZA==',
        },
      });
    });

    const result = await provider(fetch).headObject({
      account,
      credentials,
      bucket: 'objects',
      key: 'folder/object.txt',
    });

    expect(request?.method).toBe('HEAD');
    expect(request?.url).toContain('X-Amz-Signature=');
    expect(request?.url).not.toContain(credentials.secretAccessKey as string);
    expect(result).toEqual({
      sizeBytes: 123,
      etag: '"d41d8cd98f00b204e9800998ecf8427e"',
      checksum: 'YWJjZA==',
    });
  });

  it('allows absent optional ETag and checksum metadata', async () => {
    const result = await provider(
      vi.fn(
        async () =>
          new Response(null, {
            status: 200,
            headers: { 'content-length': '0' },
          }),
      ),
    ).headObject({
      account,
      credentials,
      bucket: 'objects',
      key: 'empty',
    });

    expect(result).toEqual({ sizeBytes: 0, etag: null, checksum: null });
  });

  it.each([
    [{ etag: 'not-quoted', 'content-length': '1' }, 'invalid ETag'],
    [{ 'content-length': '-1' }, 'negative content length'],
    [{ 'content-length': '01' }, 'non-canonical content length'],
    [{ 'content-length': '9007199254740992' }, 'unsafe content length'],
    [
      { 'content-length': '1', 'x-amz-checksum-sha256': 'not base64!' },
      'invalid checksum',
    ],
    [
      {
        'content-length': '1',
        'x-amz-checksum-sha256': 'YWJjZA==',
        'x-amz-checksum-sha1': 'YWJjZA==',
      },
      'ambiguous checksum',
    ],
  ])('rejects %s metadata', async (headers) => {
    const error = await provider(
      vi.fn(async () => new Response(null, { status: 200, headers })),
    )
      .headObject({
        account,
        credentials,
        bucket: 'objects',
        key: 'object',
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('sends DELETE and accepts both 204 and missing-object 404 as success', async () => {
    for (const status of [204, 404]) {
      let request: Request | undefined;
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        request = input instanceof Request ? input : new Request(input);
        return new Response(null, { status });
      });

      await provider(fetch).deleteObject({
        account,
        credentials,
        bucket: 'objects',
        key: 'folder/object.txt',
      });

      expect(request?.method).toBe('DELETE');
      expect(request?.url).toContain('X-Amz-Signature=');
    }
  });

  it('keeps non-delete 404 mapped to NOT_FOUND', async () => {
    const error = await provider(
      vi.fn(async () => new Response(null, { status: 404 })),
    )
      .headObject({
        account,
        credentials,
        bucket: 'objects',
        key: 'missing',
      })
      .catch((value: unknown) => value);

    expect(error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps object transport failure and timeout without leaking details', async () => {
    const transportError = await provider(
      vi.fn(async () => {
        throw new Error('signed-url-and-secret-response');
      }),
    )
      .deleteObject({
        account,
        credentials,
        bucket: 'objects',
        key: 'object',
      })
      .catch((value: unknown) => value);
    expect(transportError).toMatchObject({ code: 'TEMPORARY_FAILURE' });
    expect(String(transportError)).not.toContain('signed-url-and-secret-response');

    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new DOMException('secret response', 'AbortError'));
        });
      });
    });
    const timeoutError = await provider(fetch, 5)
      .headObject({
        account,
        credentials,
        bucket: 'objects',
        key: 'object',
      })
      .catch((value: unknown) => value);
    expect(timeoutError).toMatchObject({ code: 'TIMEOUT' });
    expect(String(timeoutError)).not.toContain('secret response');
  });
});
