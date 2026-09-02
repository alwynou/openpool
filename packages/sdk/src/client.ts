import type {
  ApiError,
  CompleteUploadRequest,
  CompleteUploadResponse,
  CreateDownloadResponse,
  CreateUploadRequest,
  CreateUploadResponse,
  HealthResponse,
  ListObjectsQuery,
  LogicalBucketResponse,
  ObjectMetadataResponse,
  SetupStatusResponse,
} from '@openpool/contracts';

import {
  OpenPoolApiError,
  OpenPoolProtocolError,
  OpenPoolTransferError,
} from './errors';

export type OpenPoolFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenPoolClientOptions {
  readonly baseUrl: string | URL;
  readonly apiKey?: string;
  readonly fetch?: OpenPoolFetch;
  /** Browser session cookies are sent only when the caller opts in. */
  readonly credentials?: RequestCredentials;
}

export interface OpenPoolRequestOptions {
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string | URL): URL {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        (url.hostname === 'localhost' ||
          url.hostname === '127.0.0.1' ||
          url.hostname === '[::1]')
      )) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new TypeError('Invalid OpenPool control-plane base URL');
  }
  url.pathname = '/';
  return url;
}

function validateApiKey(value: string | undefined): string | undefined {
  if (
    value !== undefined &&
    (value.length === 0 || value.trim() !== value || /[\r\n]/u.test(value))
  ) {
    throw new TypeError('Invalid OpenPool API key');
  }
  return value;
}

function directTransferUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new OpenPoolProtocolError(
      'The control plane returned an invalid signed transfer URL.',
      200,
    );
  }
  return url.toString();
}

function signalInit(options: OpenPoolRequestOptions): Pick<RequestInit, 'signal'> {
  return options.signal === undefined ? {} : { signal: options.signal };
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new OpenPoolProtocolError(
      'The control plane returned an unreadable response.',
      response.status,
    );
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok && response.status === 204) return undefined as T;

  const body = await jsonBody(response);
  if (!response.ok) {
    if (!isRecord(body) || !isRecord(body.error)) {
      throw new OpenPoolProtocolError(
        'The control plane returned an invalid error response.',
        response.status,
      );
    }
    const error = body as Partial<ApiError>;
    if (
      typeof error.error?.code !== 'string' ||
      error.error.code.length === 0 ||
      typeof error.error.message !== 'string' ||
      error.error.message.length === 0
    ) {
      throw new OpenPoolProtocolError(
        'The control plane returned an invalid error response.',
        response.status,
      );
    }
    throw new OpenPoolApiError(
      error.error.message,
      response.status,
      error.error.code,
      typeof error.requestId === 'string' ? error.requestId : null,
    );
  }

  if (
    !isRecord(body) ||
    !Object.hasOwn(body, 'data') ||
    typeof body.requestId !== 'string' ||
    body.requestId.length === 0
  ) {
    throw new OpenPoolProtocolError(
      'The control plane returned an invalid response envelope.',
      response.status,
    );
  }
  return body.data as T;
}

function objectListPath(bucketId: string, query: ListObjectsQuery): string {
  const parameters = new URLSearchParams();
  if (query.status !== undefined) parameters.set('status', query.status);
  if (query.prefix !== undefined) parameters.set('prefix', query.prefix);
  if (query.afterKey !== undefined) parameters.set('afterKey', query.afterKey);
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const encoded = parameters.toString();
  const path = `/api/v1/buckets/${encodeURIComponent(bucketId)}/objects`;
  return encoded.length === 0 ? path : `${path}?${encoded}`;
}

/** Fetch client for the existing OpenPool object control API. */
export class OpenPoolClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string | undefined;
  private readonly fetch: OpenPoolFetch;
  private readonly credentials: RequestCredentials;

  constructor(options: OpenPoolClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = validateApiKey(options.apiKey);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.credentials = options.credentials ?? 'omit';
  }

  health(options: OpenPoolRequestOptions = {}): Promise<HealthResponse> {
    return this.request('/api/v1/health', 'GET', undefined, options);
  }

  setupStatus(
    options: OpenPoolRequestOptions = {},
  ): Promise<SetupStatusResponse> {
    return this.request('/api/v1/setup/status', 'GET', undefined, options);
  }

  listBuckets(
    options: OpenPoolRequestOptions = {},
  ): Promise<readonly LogicalBucketResponse[]> {
    return this.request('/api/v1/buckets', 'GET', undefined, options);
  }

  listObjects(
    bucketId: string,
    query: ListObjectsQuery = {},
    options: OpenPoolRequestOptions = {},
  ): Promise<readonly ObjectMetadataResponse[]> {
    return this.request(objectListPath(bucketId, query), 'GET', undefined, options);
  }

  getObject(
    objectId: string,
    options: OpenPoolRequestOptions = {},
  ): Promise<ObjectMetadataResponse> {
    return this.request(
      `/api/v1/objects/${encodeURIComponent(objectId)}`,
      'GET',
      undefined,
      options,
    );
  }

  createUpload(
    input: CreateUploadRequest,
    options: OpenPoolRequestOptions = {},
  ): Promise<CreateUploadResponse> {
    return this.request('/api/v1/uploads', 'POST', input, options);
  }

  completeUpload(
    objectId: string,
    input: CompleteUploadRequest,
    options: OpenPoolRequestOptions = {},
  ): Promise<CompleteUploadResponse> {
    return this.request(
      `/api/v1/uploads/${encodeURIComponent(objectId)}/complete`,
      'POST',
      input,
      options,
    );
  }

  createDownload(
    objectId: string,
    options: OpenPoolRequestOptions = {},
  ): Promise<CreateDownloadResponse> {
    return this.request(
      `/api/v1/objects/${encodeURIComponent(objectId)}/download`,
      'POST',
      undefined,
      options,
    );
  }

  deleteObject(
    objectId: string,
    options: OpenPoolRequestOptions = {},
  ): Promise<ObjectMetadataResponse> {
    return this.request(
      `/api/v1/objects/${encodeURIComponent(objectId)}`,
      'DELETE',
      undefined,
      options,
    );
  }

  async uploadDirect(
    uploadUrl: string,
    body: BodyInit,
    contentType: string,
    options: OpenPoolRequestOptions = {},
  ): Promise<void> {
    const response = await this.fetch(directTransferUrl(uploadUrl), {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      ...signalInit(options),
    });
    if (!response.ok) throw new OpenPoolTransferError('UPLOAD', response.status);
  }

  async uploadObject(
    input: CreateUploadRequest,
    body: BodyInit,
    options: OpenPoolRequestOptions = {},
  ): Promise<CompleteUploadResponse> {
    const reservation = await this.createUpload(input, options);
    await this.uploadDirect(
      reservation.uploadUrl,
      body,
      input.contentType,
      options,
    );
    return this.completeUpload(
      reservation.objectId,
      { uploadSessionId: reservation.uploadSessionId },
      options,
    );
  }

  async downloadDirect(
    downloadUrl: string,
    options: OpenPoolRequestOptions = {},
  ): Promise<Response> {
    const response = await this.fetch(directTransferUrl(downloadUrl), {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      ...signalInit(options),
    });
    if (!response.ok) {
      throw new OpenPoolTransferError('DOWNLOAD', response.status);
    }
    return response;
  }

  async downloadObject(
    objectId: string,
    options: OpenPoolRequestOptions = {},
  ): Promise<Response> {
    const instructions = await this.createDownload(objectId, options);
    return this.downloadDirect(instructions.downloadUrl, options);
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body: object | undefined,
    options: OpenPoolRequestOptions,
  ): Promise<T> {
    const headers = new Headers({ accept: 'application/json' });
    if (this.apiKey !== undefined) {
      headers.set('authorization', `Bearer ${this.apiKey}`);
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await this.fetch(new URL(path, this.baseUrl), {
      method,
      headers,
      credentials: this.credentials,
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...signalInit(options),
    });
    return parseResponse<T>(response);
  }
}
