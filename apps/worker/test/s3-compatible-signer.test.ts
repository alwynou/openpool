import { describe, expect, it } from 'vitest';

import {
  DEFAULT_S3_PRESIGN_EXPIRY_SECONDS,
  S3CompatibleSigner,
  S3CompatibleSignerError,
} from '../src/adapters/providers/s3-compatible';

const signingDate = new Date('2026-01-02T03:04:05.000Z');

function signer(
  addressingStyle: 'path' | 'virtual' = 'path',
  extra: Record<string, unknown> = {},
) {
  return new S3CompatibleSigner({
    endpoint: 'https://objects.example.test/storage',
    region: 'us-east-1',
    addressingStyle,
    credentials: {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret-not-in-url',
      ...(extra as object),
    },
  });
}

describe('S3CompatibleSigner', () => {
  it.each(['GET', 'HEAD', 'PUT', 'DELETE'] as const)(
    'presigns %s without using fetch',
    async (method) => {
      const result = await signer().presign({
        method,
        bucket: 'bucket',
        key: 'folder/object.txt',
        ...(method === 'PUT' ? { contentLength: 12 } : {}),
        signingDate,
      });

      expect(result.url).toMatch(
        /^https:\/\/objects\.example\.test\/storage\/bucket\/folder\/object\.txt\?/u,
      );
      expect(result.url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
      expect(result.url).toContain('X-Amz-Expires=900');
      expect(result.url).not.toContain('secret-not-in-url');
      expect(result.expiresAt).toBe('2026-01-02T03:19:05.000Z');
      expect(result.requiredHeaders).toEqual(
        method === 'PUT' ? { 'content-length': '12' } : {},
      );
    },
  );

  it('uses virtual-host addressing and preserves endpoint path', async () => {
    const result = await signer('virtual').presign({
      method: 'GET',
      bucket: 'my-bucket',
      key: 'a b/中文//report',
      signingDate,
    });

    expect(result.url).toMatch(
      /^https:\/\/my-bucket\.objects\.example\.test\/storage\/a%20b\/%E4%B8%AD%E6%96%87\/\/report\?/u,
    );
    expect(result.url).toContain(
      'X-Amz-Credential=AKIDEXAMPLE%2F20260102%2Fus-east-1%2Fs3%2Faws4_request',
    );
  });

  it('matches the fixed SigV4 fixture', async () => {
    const result = await signer().presign({
      method: 'GET',
      bucket: 'bucket',
      key: 'folder/object.txt',
      signingDate,
    });

    expect(new URL(result.url).searchParams.get('X-Amz-Signature')).toBe(
      'e202b900627668f14495c086b67019fa1b1d5f5d06a706b190ba9cf5bf76a66a',
    );
  });

  it('retains repeated key slashes without URL normalization', async () => {
    const result = await signer().presign({
      method: 'GET',
      bucket: 'bucket',
      key: 'one//two',
      signingDate,
    });

    expect(result.url).toMatch(/\/storage\/bucket\/one\/\/two\?/u);
    expect(new URL(result.url).pathname).toBe('/storage/bucket/one//two');
  });

  it('rejects dot-only path segments that URL parsers normalize', async () => {
    await expect(
      signer().presign({
        method: 'GET',
        bucket: 'bucket',
        key: 'one/../two',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('keeps a configured endpoint port in the signed host', async () => {
    const result = await new S3CompatibleSigner({
      endpoint: 'https://objects.example.test:9443/prefix/',
      region: 'auto',
      addressingStyle: 'path',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret-not-in-url',
      },
    }).presign({
      method: 'GET',
      bucket: 'bucket',
      key: 'object',
      signingDate,
    });

    expect(result.url).toMatch(
      /^https:\/\/objects\.example\.test:9443\/prefix\/bucket\/object\?/u,
    );
    expect(result.url).toContain(
      'X-Amz-Credential=AKIDEXAMPLE%2F20260102%2Fauto%2Fs3%2Faws4_request',
    );
  });

  it('presigns path-style and virtual-hosted bucket probes', async () => {
    const path = await signer().presignBucket({
      bucket: 'probe-bucket',
      signingDate,
    });
    const virtual = await signer('virtual').presignBucket({
      bucket: 'probe-bucket',
      signingDate,
    });

    expect(new URL(path.url).pathname).toBe('/storage/probe-bucket');
    expect(new URL(virtual.url).hostname).toBe(
      'probe-bucket.objects.example.test',
    );
    expect(new URL(virtual.url).pathname).toBe('/storage');
    expect(path.requiredHeaders).toEqual({});
  });

  it('signs PUT content type and returns the required header', async () => {
    const result = await signer().presign({
      method: 'PUT',
      bucket: 'bucket',
      key: 'object',
      contentType: 'text/plain; charset=utf-8',
      contentLength: 12,
      signingDate,
    });

    expect(result.url).toContain(
      'X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost',
    );
    expect(result.requiredHeaders).toEqual({
      'content-length': '12',
      'content-type': 'text/plain; charset=utf-8',
    });
  });

  it.each([' text/plain', 'text/plain ', 'text/\nplain', 'text/\rplain'])(
    'rejects unsafe content type %j',
    async (contentType) => {
      await expect(
        signer().presign({
          method: 'PUT',
          bucket: 'bucket',
          key: 'object',
          contentType,
          contentLength: 12,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    },
  );

  it.each([undefined, -1, 1.5])(
    'rejects unsafe PUT content length %j',
    async (contentLength) => {
      await expect(
        signer().presign({
          method: 'PUT',
          bucket: 'bucket',
          key: 'object',
          ...(contentLength === undefined ? {} : { contentLength }),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    },
  );

  it('supports session credentials and custom expiry', async () => {
    const result = await signer('path', {
      sessionToken: 'session-token-value',
    }).presign({
      method: 'GET',
      bucket: 'bucket',
      key: 'object',
      expiresIn: 1,
      signingDate,
    });

    expect(result.url).toContain('X-Amz-Security-Token=session-token-value');
    expect(result.url).toContain('X-Amz-Expires=1');
    expect(result.expiresAt).toBe('2026-01-02T03:04:06.000Z');
  });

  it('defaults expiry to 15 minutes', async () => {
    const result = await signer().presign({
      method: 'GET',
      bucket: 'bucket',
      key: 'object',
      signingDate,
    });

    expect(result.url).toContain(
      `X-Amz-Expires=${DEFAULT_S3_PRESIGN_EXPIRY_SECONDS}`,
    );
  });

  it.each([
    { expiresIn: 0 },
    { expiresIn: 604_801 },
    { expiresIn: 1.5 },
  ])('rejects invalid expiry %#', async (request) => {
    await expect(
      signer().presign({
        method: 'GET',
        bucket: 'bucket',
        key: 'object',
        ...request,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects unsafe configuration and request values without exposing secrets', async () => {
    expect(
      () =>
        new S3CompatibleSigner({
          endpoint: 'https://user:secret@example.test',
          region: 'us-east-1',
          addressingStyle: 'path',
          credentials: {
            accessKeyId: 'AKID',
            secretAccessKey: 'secret-not-in-url',
          },
        }),
    ).toThrow(S3CompatibleSignerError);

    await expect(
      signer('virtual').presign({
        method: 'GET',
        bucket: 'Not DNS Safe',
        key: 'object',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      signer().presign({
        method: 'PATCH' as 'GET',
        bucket: 'bucket',
        key: '',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
