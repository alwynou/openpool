import type {
  ApiEnvelope,
  ApiError,
  ApiKeyResponse,
  CreateDownloadResponse,
  CreateStorageAccountRequest,
  CreateUploadResponse,
  CreatedApiKeyResponse,
  CreateLogicalBucketRequest,
  CreateStorageShardRequest,
  HealthResponse,
  LoginResponse,
  LogicalBucketResponse,
  ObjectMetadataResponse,
  SessionResponse,
  SetupStatusResponse,
  StorageAccountResponse,
  StorageShardResponse,
  UpdateStorageAccountStatusRequest,
  UpdateStorageShardStatusRequest,
} from '@openpool/contracts';

export class ApiClientError extends Error {
  readonly code: string;
  readonly requestId: string | null;

  constructor(message: string, code = 'REQUEST_FAILED', requestId: string | null = null) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.requestId = requestId;
  }
}

const requestOptions = { credentials: 'same-origin' as const };

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok && response.status === 204) {
    return undefined as T;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiClientError('The control plane returned an unreadable response.');
  }

  if (!response.ok) {
    const error = body as Partial<ApiError>;
    const details = error.error;
    throw new ApiClientError(
      details && typeof details.message === 'string'
        ? details.message
        : 'The request could not be completed.',
      details && typeof details.code === 'string' ? details.code : undefined,
      typeof error.requestId === 'string' ? error.requestId : null,
    );
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('data' in body)
  ) {
    throw new ApiClientError('The control plane returned an invalid response.');
  }
  return (body as ApiEnvelope<T>).data;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...requestOptions, ...init });
  return parseResponse<T>(response);
}

const jsonHeaders = { 'content-type': 'application/json' };

export const api = {
  health: () => request<HealthResponse>('/api/v1/health'),
  setupStatus: () => request<SetupStatusResponse>('/api/v1/setup/status'),
  session: () => request<SessionResponse>('/api/v1/auth/session'),
  setup: (username: string, password: string, bootstrapToken: string) =>
    request<unknown>('/api/v1/setup', {
      method: 'POST',
      headers: { ...jsonHeaders, 'x-openpool-bootstrap-token': bootstrapToken },
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<LoginResponse>(
      '/api/v1/auth/login',
      { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username, password }) },
    ),
  logout: () => request<unknown>('/api/v1/auth/session', { method: 'DELETE' }),

  listAccounts: () => request<readonly StorageAccountResponse[]>('/api/v1/storage-accounts'),
  createAccount: (input: CreateStorageAccountRequest) =>
    request<StorageAccountResponse>('/api/v1/storage-accounts', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify(input),
    }),
  verifyAccount: (id: string) => request<StorageAccountResponse>(`/api/v1/storage-accounts/${encodeURIComponent(id)}/verify`, { method: 'POST' }),
  healthAccount: (id: string) => request<StorageAccountResponse>(`/api/v1/storage-accounts/${encodeURIComponent(id)}/health`, { method: 'POST' }),
  updateAccountStatus: (id: string, input: UpdateStorageAccountStatusRequest) =>
    request<StorageAccountResponse>(`/api/v1/storage-accounts/${encodeURIComponent(id)}/status`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(input) }),

  listBuckets: () => request<readonly LogicalBucketResponse[]>('/api/v1/buckets'),
  createBucket: (input: CreateLogicalBucketRequest) => request<LogicalBucketResponse>('/api/v1/buckets', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) }),
  listShards: (bucketId: string) => request<readonly StorageShardResponse[]>(`/api/v1/buckets/${encodeURIComponent(bucketId)}/shards`),
  createShard: (bucketId: string, input: CreateStorageShardRequest) => request<StorageShardResponse>(`/api/v1/buckets/${encodeURIComponent(bucketId)}/shards`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) }),
  updateShardStatus: (id: string, input: UpdateStorageShardStatusRequest) => request<StorageShardResponse>(`/api/v1/shards/${encodeURIComponent(id)}/status`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(input) }),

  listObjects: (bucketId: string) => request<readonly ObjectMetadataResponse[]>(`/api/v1/buckets/${encodeURIComponent(bucketId)}/objects?limit=1000`),
  createUpload: (bucketId: string, logicalKey: string, file: File) => request<CreateUploadResponse>('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ bucketId, logicalKey, sizeBytes: file.size, contentType: file.type || 'application/octet-stream' }) }),
  uploadDirect: async (uploadUrl: string, file: File, contentType: string): Promise<void> => {
    const response = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: file });
    if (!response.ok) throw new ApiClientError('The provider rejected the direct upload.');
  },
  completeUpload: (objectId: string, uploadSessionId: string) => request<{ object: ObjectMetadataResponse; uploadSessionId: string; alreadyCompleted: boolean }>(`/api/v1/uploads/${encodeURIComponent(objectId)}/complete`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ uploadSessionId }) }),
  downloadObject: (id: string) => request<CreateDownloadResponse>(`/api/v1/objects/${encodeURIComponent(id)}/download`, { method: 'POST' }),
  deleteObject: (id: string) => request<ObjectMetadataResponse>(`/api/v1/objects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listApiKeys: () => request<readonly ApiKeyResponse[]>('/api/v1/api-keys'),
  createApiKey: (input: { name: string; scopes: readonly string[]; logicalBucketId?: string | null; pathPrefix?: string | null; expiresAt?: string | null }) => request<CreatedApiKeyResponse>('/api/v1/api-keys', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) }),
  revokeApiKey: (id: string) => request<ApiKeyResponse>(`/api/v1/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listAuditLogs: () => request<{ readonly items: readonly { readonly id: string; readonly actorType: string; readonly action: string; readonly resourceType: string; readonly createdAt: string }[]; readonly nextCursor: unknown }>('/api/v1/audit-logs?limit=100'),
};

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiClientError && (error.code === 'UNAUTHORIZED' || error.code === 'API_KEY_UNAUTHORIZED');
}
