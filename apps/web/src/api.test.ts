import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from './api';

interface FetchCall {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
}

function responseWithBody(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const calls: FetchCall[] = [];
const fetchMock = vi.fn<
  (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
>();
let webApi: typeof ApiModule;

describe('web API adapter', () => {
  beforeAll(async () => {
    vi.stubGlobal('location', { origin: 'https://web.example' });
    vi.stubGlobal('fetch', fetchMock);
    webApi = await import('./api');
  });

  beforeEach(() => {
    calls.length = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input, init) => {
      calls.push({ input, init });
      return responseWithBody({ data: [], requestId: 'request-1' });
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('uses the SDK for management requests with the origin, method, JSON body, and credentials', async () => {
    const input = { name: 'documents', description: null };
    const bucket = {
      id: 'bucket-1',
      name: 'documents',
      description: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    fetchMock.mockImplementationOnce(async (input, init) => {
      calls.push({ input, init });
      return responseWithBody({ data: bucket, requestId: 'request-create' }, 201);
    });

    await expect(webApi.api.createBucket(input)).resolves.toEqual(bucket);

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe('https://web.example/api/v1/buckets');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.body).toBe(JSON.stringify(input));
    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe(
      'application/json',
    );
  });

  it('maps an SDK API error envelope to ApiClientError with code and request ID', async () => {
    fetchMock.mockResolvedValueOnce(
      responseWithBody(
        {
          error: {
            code: 'LOGICAL_BUCKET_NOT_FOUND',
            message: 'Logical bucket was not found.',
          },
          requestId: 'request-error',
        },
        404,
      ),
    );

    let error: unknown;
    try {
      await webApi.api.listAccounts();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(webApi.ApiClientError);
    expect(error).toMatchObject({
      name: 'ApiClientError',
      message: 'Logical bucket was not found.',
      code: 'LOGICAL_BUCKET_NOT_FOUND',
      requestId: 'request-error',
    });
  });

  it('uploads directly to the provider URL without session credentials', async () => {
    const file = new File(['object bytes'], 'notes.txt', { type: 'text/plain' });
    const providerUrl = 'https://provider.example/object-1?signature=upload';
    fetchMock.mockImplementationOnce(async (input, init) => {
      calls.push({ input, init });
      return new Response(null, { status: 200 });
    });

    await expect(webApi.api.uploadDirect(providerUrl, file, file.type)).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe(providerUrl);
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.init?.credentials).toBe('omit');
    expect(calls[0]?.init?.body).toBe(file);
    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('text/plain');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBeNull();
  });
});
