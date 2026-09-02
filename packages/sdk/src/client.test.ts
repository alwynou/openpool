import { describe, expect, it, vi } from 'vitest';

import type {
  CompleteUploadResponse,
  CreateDownloadResponse,
  CreateUploadRequest,
  CreateUploadResponse,
  HealthResponse,
  ObjectMetadataResponse,
} from '@openpool/contracts';

import type { OpenPoolFetch } from './client';
import { OpenPoolClient } from './client';
import {
  OpenPoolApiError,
  OpenPoolProtocolError,
  OpenPoolTransferError,
} from './errors';

interface FetchCall {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
}

function responseWithBody(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function envelope<T>(data: T, requestId = 'request-1'): Response {
  return responseWithBody({ data, requestId });
}

function controlFetch(...responses: Response[]) {
  const calls: FetchCall[] = [];
  const fetch = vi.fn<OpenPoolFetch>(async (input, init) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error('Unexpected fetch call');
    }
    return response;
  });
  return { calls, fetch };
}

function requestHeaders(call: FetchCall): Headers {
  return new Headers(call.init?.headers);
}

function callAt(calls: readonly FetchCall[], index: number): FetchCall {
  const call = calls[index];
  if (call === undefined) throw new Error(`Missing fetch call ${index}`);
  return call;
}

const objectMetadata: ObjectMetadataResponse = {
  id: 'object-1',
  logicalBucketId: 'bucket-1',
  logicalKey: 'notes.txt',
  sizeBytes: 12,
  contentType: 'text/plain',
  checksum: null,
  status: 'READY',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const uploadInput: CreateUploadRequest = {
  bucketId: 'bucket-1',
  logicalKey: 'notes.txt',
  sizeBytes: 12,
  contentType: 'text/plain',
};

const uploadReservation: CreateUploadResponse = {
  objectId: 'object-1',
  uploadSessionId: 'upload-session-1',
  uploadUrl: 'https://provider.example/upload/object-1?signature=upload',
  expiresAt: '2026-01-01T00:10:00.000Z',
};

const uploadCompletion: CompleteUploadResponse = {
  object: objectMetadata,
  uploadSessionId: 'upload-session-1',
  alreadyCompleted: false,
};

describe('OpenPoolClient', () => {
  it('queries the current upload and forwards an explicit retry session without automatic retry', async () => {
    const session = { objectId: 'object/1', uploadSessionId: 'previous-session',
      status: 'ABORTED', expiresAt: uploadReservation.expiresAt };
    const { fetch, calls } = controlFetch(envelope(session), envelope(uploadReservation));
    const client = new OpenPoolClient({ baseUrl: 'https://control.example', apiKey: 'test-key', fetch });
    expect(await client.getUpload('object/1')).toEqual(session);
    expect(await client.createUpload({ ...uploadInput, retryUploadSessionId: session.uploadSessionId }))
      .toEqual(uploadReservation);
    expect(String(callAt(calls, 0).input)).toBe('https://control.example/api/v1/uploads/object%2F1');
    expect(callAt(calls, 0).init?.method).toBe('GET');
    expect(callAt(calls, 1).init?.body).toBe(JSON.stringify({
      ...uploadInput, retryUploadSessionId: session.uploadSessionId,
    }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  describe('constructor validation', () => {
    it('accepts a root control-plane URL and localhost HTTP', () => {
      expect(
        () => new OpenPoolClient({ baseUrl: 'https://control.example/' }),
      ).not.toThrow();
      expect(
        () => new OpenPoolClient({ baseUrl: 'http://localhost:8787' }),
      ).not.toThrow();
    });

    it.each([
      'http://control.example',
      'https://control.example/api',
      'https://control.example/?tenant=one',
      'https://user:password@control.example',
    ])('rejects an unsafe or non-root base URL: %s', (baseUrl) => {
      expect(() => new OpenPoolClient({ baseUrl })).toThrow(
        'Invalid OpenPool control-plane base URL',
      );
    });

    it.each(['', ' key', 'key ', 'key\nvalue', 'key\rvalue'])(
      'rejects an invalid API key: %j',
      (apiKey) => {
        expect(
          () => new OpenPoolClient({ baseUrl: 'https://control.example', apiKey }),
        ).toThrow('Invalid OpenPool API key');
      },
    );
  });

  it('builds control requests with encoded paths, query, JSON body, API auth, credentials, and signal', async () => {
    const createResponse: CreateUploadResponse = uploadReservation;
    const { fetch, calls } = controlFetch(envelope([]), envelope(createResponse));
    const signal = new AbortController().signal;
    const client = new OpenPoolClient({
      baseUrl: 'https://control.example/',
      apiKey: 'api-key-1',
      credentials: 'include',
      fetch,
    });

    await expect(
      client.listObjects(
        'bucket/one',
        {
          status: 'READY',
          prefix: 'folder/a b',
          afterKey: 'last/item',
          limit: 25,
        },
        { signal },
      ),
    ).resolves.toEqual([]);
    await expect(client.createUpload(uploadInput)).resolves.toEqual(
      createResponse,
    );

    expect(calls).toHaveLength(2);
    expect(String(callAt(calls, 0).input)).toBe(
      'https://control.example/api/v1/buckets/bucket%2Fone/objects?status=READY&prefix=folder%2Fa+b&afterKey=last%2Fitem&limit=25',
    );
    expect(callAt(calls, 0).init?.method).toBe('GET');
    expect(callAt(calls, 0).init?.body).toBeUndefined();
    expect(callAt(calls, 0).init?.credentials).toBe('include');
    expect(callAt(calls, 0).init?.cache).toBe('no-store');
    expect(callAt(calls, 0).init?.signal).toBe(signal);
    expect(requestHeaders(callAt(calls, 0)).get('accept')).toBe('application/json');
    expect(requestHeaders(callAt(calls, 0)).get('authorization')).toBe(
      'Bearer api-key-1',
    );

    expect(String(callAt(calls, 1).input)).toBe('https://control.example/api/v1/uploads');
    expect(callAt(calls, 1).init?.method).toBe('POST');
    expect(callAt(calls, 1).init?.body).toBe(JSON.stringify(uploadInput));
    expect(callAt(calls, 1).init?.credentials).toBe('include');
    expect(requestHeaders(callAt(calls, 1)).get('accept')).toBe('application/json');
    expect(requestHeaders(callAt(calls, 1)).get('authorization')).toBe(
      'Bearer api-key-1',
    );
    expect(requestHeaders(callAt(calls, 1)).get('content-type')).toBe(
      'application/json',
    );
  });

  it('returns data from a valid success envelope', async () => {
    const health: HealthResponse = {
      name: 'openpool',
      status: 'ok',
      version: '1.0.0',
      environment: 'test',
    };
    const { fetch } = controlFetch(envelope(health, 'request-health'));

    await expect(
      new OpenPoolClient({ baseUrl: 'https://control.example', fetch }).health(),
    ).resolves.toEqual(health);
  });

  it('maps an API error envelope to OpenPoolApiError', async () => {
    const { fetch } = controlFetch(
      responseWithBody(
        {
          error: { code: 'OBJECT_NOT_FOUND', message: 'Object not found' },
          requestId: 'request-error',
        },
        404,
      ),
    );

    const request = new OpenPoolClient({
      baseUrl: 'https://control.example',
      fetch,
    }).getObject('object-1');
    await expect(request).rejects.toBeInstanceOf(OpenPoolApiError);
    await expect(request).rejects.toMatchObject({
      name: 'OpenPoolApiError',
      message: 'Object not found',
      status: 404,
      code: 'OBJECT_NOT_FOUND',
      requestId: 'request-error',
    });
  });

  it.each([
    {
      name: 'malformed success envelope',
      response: responseWithBody({ data: { initialized: true } }),
    },
    {
      name: 'malformed error envelope',
      response: responseWithBody({ error: { code: 'BROKEN' } }, 400),
    },
    {
      name: 'unreadable JSON',
      response: new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    },
  ])('rejects a $name with OpenPoolProtocolError', async ({ response }) => {
    const { fetch } = controlFetch(response);

    const request = new OpenPoolClient({
      baseUrl: 'https://control.example',
      fetch,
    }).health();
    await expect(request).rejects.toBeInstanceOf(OpenPoolProtocolError);
    await expect(request).rejects.toMatchObject({
      name: 'OpenPoolProtocolError',
      status: response.status,
    });
  });

  it('uploads through reserve, signed provider PUT, then complete in order', async () => {
    const body = 'object bytes';
    const signal = new AbortController().signal;
    const { fetch, calls } = controlFetch(
      envelope(uploadReservation, 'reserve-request'),
      new Response(null, { status: 200 }),
      envelope(uploadCompletion, 'complete-request'),
    );
    const client = new OpenPoolClient({
      baseUrl: 'https://control.example',
      apiKey: 'api-key-1',
      credentials: 'include',
      fetch,
    });

    await expect(client.uploadObject(uploadInput, body, { signal })).resolves.toEqual(
      uploadCompletion,
    );

    expect(calls).toHaveLength(3);
    expect(String(callAt(calls, 0).input)).toBe('https://control.example/api/v1/uploads');
    expect(callAt(calls, 0).init?.method).toBe('POST');
    expect(callAt(calls, 0).init?.body).toBe(JSON.stringify(uploadInput));
    expect(callAt(calls, 0).init?.credentials).toBe('include');

    expect(String(callAt(calls, 1).input)).toBe(uploadReservation.uploadUrl);
    expect(callAt(calls, 1).init?.method).toBe('PUT');
    expect(callAt(calls, 1).init?.body).toBe(body);
    expect(callAt(calls, 1).init?.redirect).toBe('error');
    expect(callAt(calls, 1).init?.signal).toBe(signal);
    expect(callAt(calls, 1).init?.credentials).toBe('omit');
    expect(callAt(calls, 1).init?.referrerPolicy).toBe('no-referrer');
    expect(requestHeaders(callAt(calls, 1)).get('content-type')).toBe(
      'text/plain',
    );
    expect(requestHeaders(callAt(calls, 1)).get('authorization')).toBeNull();

    expect(String(callAt(calls, 2).input)).toBe(
      'https://control.example/api/v1/uploads/object-1/complete',
    );
    expect(callAt(calls, 2).init?.method).toBe('POST');
    expect(callAt(calls, 2).init?.body).toBe(
      JSON.stringify({ uploadSessionId: uploadReservation.uploadSessionId }),
    );
    expect(callAt(calls, 2).init?.credentials).toBe('include');
  });

  it('does not complete an upload when the provider PUT fails', async () => {
    const { fetch, calls } = controlFetch(
      envelope(uploadReservation),
      new Response(null, { status: 503 }),
    );
    const client = new OpenPoolClient({
      baseUrl: 'https://control.example',
      fetch,
    });

    const request = client.uploadObject(uploadInput, 'object bytes');
    await expect(request).rejects.toBeInstanceOf(OpenPoolTransferError);
    await expect(request).rejects.toMatchObject({
      name: 'OpenPoolTransferError',
      operation: 'UPLOAD',
      status: 503,
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => String(call.input).endsWith('/complete'))).toBe(false);
  });

  it('downloads by obtaining a signed URL first and GETing the provider directly', async () => {
    const download: CreateDownloadResponse = {
      objectId: 'object/1',
      downloadUrl: 'https://provider.example/download/object-1?signature=download',
      expiresAt: '2026-01-01T00:10:00.000Z',
    };
    const providerResponse = new Response('object bytes', { status: 200 });
    const signal = new AbortController().signal;
    const { fetch, calls } = controlFetch(envelope(download), providerResponse);
    const client = new OpenPoolClient({
      baseUrl: 'https://control.example',
      apiKey: 'api-key-1',
      credentials: 'include',
      fetch,
    });

    await expect(client.downloadObject('object/1', { signal })).resolves.toBe(
      providerResponse,
    );

    expect(calls).toHaveLength(2);
    expect(String(callAt(calls, 0).input)).toBe(
      'https://control.example/api/v1/objects/object%2F1/download',
    );
    expect(callAt(calls, 0).init?.method).toBe('POST');
    expect(callAt(calls, 0).init?.body).toBeUndefined();
    expect(callAt(calls, 0).init?.credentials).toBe('include');
    expect(requestHeaders(callAt(calls, 0)).get('authorization')).toBe(
      'Bearer api-key-1',
    );

    expect(String(callAt(calls, 1).input)).toBe(download.downloadUrl);
    expect(callAt(calls, 1).init?.method).toBe('GET');
    expect(callAt(calls, 1).init?.redirect).toBe('error');
    expect(callAt(calls, 1).init?.signal).toBe(signal);
    expect(callAt(calls, 1).init?.credentials).toBe('omit');
    expect(callAt(calls, 1).init?.referrerPolicy).toBe('no-referrer');
    expect(callAt(calls, 1).init?.headers).toBeUndefined();
  });
});
