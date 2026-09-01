import { describe, expect, it, vi } from 'vitest';

import type { CredentialPayload } from '@openpool/application';
import { ProviderError } from '@openpool/domain';

import {
  R2StorageProvider,
  parseR2Config,
} from '../src/adapters/providers/r2';

const credentials: CredentialPayload = {
  accessKeyId: 'r2-access-key',
  secretAccessKey: 'r2-secret-must-not-leak',
  sessionToken: 'r2-session-token',
};

const config = {
  accountId: 'account-123',
  jurisdiction: 'eu',
  addressingStyle: 'path',
  validationBucket: 'validation-bucket',
} as const;

function provider(
  fetch: typeof globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })),
  timeoutMs = 10_000,
) {
  return new R2StorageProvider({
    fetch,
    timeoutMs,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });
}

describe('R2StorageProvider', () => {
  it('builds the jurisdiction endpoint and sends a signed HEAD Bucket request', async () => {
    let request: Request | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input);
      return new Response(null, { status: 204 });
    });

    const result = await provider(fetch).validate(credentials, config);

    expect(result.capabilities).toEqual({
      presignedUpload: true,
      presignedDownload: true,
      headObject: true,
      deleteObject: true,
      bucketProbe: true,
      usageProbe: false,
    });
    expect(request?.method).toBe('HEAD');
    expect(request?.url).toMatch(
      /^https:\/\/account-123\.eu\.r2\.cloudflarestorage\.com\/validation-bucket\?/u,
    );
    expect(request?.url).toContain('X-Amz-Credential=r2-access-key');
    expect(request?.url).not.toContain(credentials.secretAccessKey);
  });

  it.each([
    [401, 'INVALID_CREDENTIALS'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [503, 'TEMPORARY_FAILURE'],
    [400, 'PROTOCOL_ERROR'],
  ] as const)('maps status %i to %s', async (status, code) => {
    const error = await provider(
      vi.fn(async () => new Response(null, { status })),
    )
      .probe(credentials, config)
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code });
  });

  it('maps an aborted request to TIMEOUT without exposing response details', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new DOMException('secret response body', 'AbortError'));
        });
      });
    });

    const error = await provider(fetch, 5).probe(credentials, config).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'TIMEOUT' });
    expect(error).not.toHaveProperty('message', expect.stringContaining(credentials.secretAccessKey));
    expect(String(error)).not.toContain('secret response body');
  });

  it('presigns PUT uploads from account config and returns only the port fields', async () => {
    const result = await provider().createUploadUrl({
      account: { providerConfig: config } as never,
      credentials,
      bucket: 'objects',
      key: 'objects/id/file.txt',
      contentType: 'text/plain',
      sizeBytes: 12,
      expiresInSeconds: 300,
    });

    expect(result).toHaveProperty('url');
    expect(result).toHaveProperty('expiresAt');
    expect(result).not.toHaveProperty('requiredHeaders');
    expect(result.url).toMatch(
      /^https:\/\/account-123\.eu\.r2\.cloudflarestorage\.com\/objects\/objects\/id\/file\.txt\?/u,
    );
    expect(result.url).toContain(
      'X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost',
    );
    expect(result.url).not.toContain(credentials.secretAccessKey);
  });

  it('uses the R2 endpoint for inherited GET, HEAD, and DELETE operations', async () => {
    const methods: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      methods.push(request.method);
      expect(request.url).toMatch(
        /^https:\/\/account-123\.eu\.r2\.cloudflarestorage\.com\/objects\/objects\/id\/file\.txt\?/u,
      );
      return request.method === 'HEAD'
        ? new Response(null, {
            status: 200,
            headers: {
              'content-length': '12',
              etag: '"etag-value"',
            },
          })
        : new Response(null, { status: 204 });
    });
    const r2 = provider(fetch);
    const account = { providerConfig: config } as never;

    const download = await r2.createDownloadUrl({
      account,
      credentials,
      bucket: 'objects',
      key: 'objects/id/file.txt',
      expiresInSeconds: 300,
    });
    const metadata = await r2.headObject({
      account,
      credentials,
      bucket: 'objects',
      key: 'objects/id/file.txt',
    });
    await r2.deleteObject({
      account,
      credentials,
      bucket: 'objects',
      key: 'objects/id/file.txt',
    });

    expect(download.url).toContain('X-Amz-Signature=');
    expect(metadata).toEqual({
      sizeBytes: 12,
      etag: '"etag-value"',
      checksum: null,
    });
    expect(methods).toEqual(['HEAD', 'DELETE']);
  });

  it('rejects malformed R2 configuration', () => {
    expect(() =>
      parseR2Config({
        accountId: 'account-123',
        region: 'us-east-1',
        validationBucket: 'bucket',
      }),
    ).toThrowError(ProviderError);
    expect(() =>
      parseR2Config({
        accountId: 'account 123',
        validationBucket: 'bucket',
      }),
    ).toThrowError(ProviderError);
  });
});
