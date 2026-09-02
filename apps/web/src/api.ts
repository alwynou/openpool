import type {
  ApiEnvelope,
  ApiError,
  CreateApiKeyRequest,
  CreateStorageAccountRequest,
  CreateLogicalBucketRequest,
  CreateStorageShardRequest,
  ListAuditLogsQuery,
  LoginResponse,
  SessionResponse,
  ShardMigrationResponse,
  StartShardMigrationRequest,
  UpdateStorageAccountConfigurationRequest,
  UpdateStorageAccountStatusRequest,
  UpdateStorageShardStatusRequest,
} from '@openpool/contracts';
import {
  OpenPoolApiError,
  OpenPoolClient,
  OpenPoolProtocolError,
  OpenPoolTransferError,
} from '@openpool/sdk';

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
const client = new OpenPoolClient({
  baseUrl: globalThis.location?.origin ?? 'http://localhost',
  credentials: requestOptions.credentials,
});

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

async function sdkRequest<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof OpenPoolApiError) {
      throw new ApiClientError(error.message, error.code, error.requestId);
    }
    if (
      error instanceof OpenPoolProtocolError ||
      error instanceof OpenPoolTransferError
    ) {
      throw new ApiClientError(error.message);
    }
    throw error;
  }
}

const jsonHeaders = { 'content-type': 'application/json' };

export const api = {
  health: () => sdkRequest(client.health()),
  setupStatus: () => sdkRequest(client.setupStatus()),
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

  listAccounts: () => sdkRequest(client.listAccounts()),
  createAccount: (input: CreateStorageAccountRequest) =>
    sdkRequest(client.createAccount(input)),
  updateAccountConfiguration: (
    id: string,
    input: UpdateStorageAccountConfigurationRequest,
  ) =>
    sdkRequest(client.updateAccountConfiguration(id, input)),
  verifyAccount: (id: string) => sdkRequest(client.verifyAccount(id)),
  healthAccount: (id: string) => sdkRequest(client.healthAccount(id)),
  updateAccountStatus: (id: string, input: UpdateStorageAccountStatusRequest) =>
    sdkRequest(client.updateAccountStatus(id, input)),

  listBuckets: () => sdkRequest(client.listBuckets()),
  createBucket: (input: CreateLogicalBucketRequest) =>
    sdkRequest(client.createBucket(input)),
  listShards: (bucketId: string) => sdkRequest(client.listShards(bucketId)),
  createShard: (bucketId: string, input: CreateStorageShardRequest) =>
    sdkRequest(client.createShard(bucketId, input)),
  updateShardStatus: (id: string, input: UpdateStorageShardStatusRequest) =>
    sdkRequest(client.updateShardStatus(id, input)),
  listShardMigrations: (bucketId: string) => request<readonly ShardMigrationResponse[]>(`/api/v1/buckets/${encodeURIComponent(bucketId)}/shard-migrations`),
  startShardMigration: (input: StartShardMigrationRequest) => request<ShardMigrationResponse>('/api/v1/shard-migrations', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) }),
  getShardMigration: (id: string) => request<ShardMigrationResponse>(`/api/v1/shard-migrations/${encodeURIComponent(id)}`),

  listObjects: (bucketId: string) =>
    sdkRequest(client.listObjects(bucketId, { limit: 1000 })),
  createUpload: (bucketId: string, logicalKey: string, file: File) =>
    sdkRequest(client.createUpload({
      bucketId,
      logicalKey,
      sizeBytes: file.size,
      contentType: file.type || 'application/octet-stream',
    })),
  uploadDirect: (uploadUrl: string, file: File, contentType: string) =>
    sdkRequest(client.uploadDirect(uploadUrl, file, contentType)),
  completeUpload: (objectId: string, uploadSessionId: string) =>
    sdkRequest(client.completeUpload(objectId, { uploadSessionId })),
  downloadObject: (id: string) => sdkRequest(client.createDownload(id)),
  deleteObject: (id: string) => sdkRequest(client.deleteObject(id)),

  listApiKeys: () => sdkRequest(client.listApiKeys()),
  createApiKey: (input: CreateApiKeyRequest) =>
    sdkRequest(client.createApiKey(input)),
  revokeApiKey: (id: string) => sdkRequest(client.revokeApiKey(id)),
  listAuditLogs: (query: ListAuditLogsQuery = { limit: 100 }) =>
    sdkRequest(client.listAuditLogs(query)),
};

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiClientError && (error.code === 'UNAUTHORIZED' || error.code === 'API_KEY_UNAUTHORIZED');
}
