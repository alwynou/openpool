import { describe, expect, it, vi } from 'vitest';

import type { CredentialPayload } from '@openpool/application';
import { ProviderError } from '@openpool/domain';

import {
  B2StorageProvider,
  StorageProviderRegistry,
  buildB2Endpoint,
  parseB2Config,
} from '../src/adapters/providers';

const credentials: CredentialPayload = {
  accessKeyId: 'b2-application-key-id',
  secretAccessKey: 'b2-application-key-must-not-leak',
};

const config = {
  region: 'us-west-004',
  validationBucket: 'validation-bucket',
} as const;

describe('B2StorageProvider', () => {
  it('constructs the documented regional HTTPS endpoint', () => {
    expect(buildB2Endpoint('us-east-005')).toBe(
      'https://s3.us-east-005.backblazeb2.com',
    );
    expect(parseB2Config(config)).toEqual({
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      region: 'us-west-004',
      addressingStyle: 'path',
      validationBucket: 'validation-bucket',
    });
  });

  it('validates through a signed HEAD Bucket request', async () => {
    let request: Request | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input);
      return new Response(null, { status: 204 });
    });
    const provider = new B2StorageProvider({
      fetch,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });

    await provider.validate(credentials, config);

    expect(request?.method).toBe('HEAD');
    expect(request?.url).toMatch(
      /^https:\/\/s3\.us-west-004\.backblazeb2\.com\/validation-bucket\?/u,
    );
    expect(request?.url).toContain(
      'X-Amz-Credential=b2-application-key-id%2F20260102%2Fus-west-004%2Fs3%2Faws4_request',
    );
    expect(request?.url).not.toContain(credentials.secretAccessKey as string);
  });

  it('supports virtual-hosted object URLs through the shared adapter', async () => {
    const provider = new B2StorageProvider({
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });
    const result = await provider.createDownloadUrl({
      account: {
        providerConfig: { ...config, addressingStyle: 'virtual' },
      } as never,
      credentials,
      bucket: 'objects-bucket',
      key: 'folder/object.txt',
      expiresInSeconds: 300,
    });

    expect(result.url).toMatch(
      /^https:\/\/objects-bucket\.s3\.us-west-004\.backblazeb2\.com\/folder\/object\.txt\?/u,
    );
  });

  it('rejects unknown, unsafe, or endpoint override configuration', () => {
    for (const candidate of [
      { region: 'US west', validationBucket: 'bucket' },
      { region: '.us-west-004', validationBucket: 'bucket' },
      { region: 'us-west-004', validationBucket: 'bad/bucket' },
      {
        region: 'us-west-004',
        validationBucket: 'bucket',
        endpoint: 'https://attacker.example',
      },
    ]) {
      expect(() => parseB2Config(candidate)).toThrowError(ProviderError);
    }
  });

  it('registers the b2 provider kind', () => {
    const registry = new StorageProviderRegistry();
    const selected = registry.forAccount({ provider: 'b2' } as never);

    expect(selected).toBeInstanceOf(B2StorageProvider);
    expect(selected.capabilities).toMatchObject({
      presignedUpload: true,
      presignedDownload: true,
      headObject: true,
      deleteObject: true,
    });
  });
});
