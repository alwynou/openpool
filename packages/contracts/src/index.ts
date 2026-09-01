export interface ApiEnvelope<T> {
  readonly data: T;
  readonly requestId: string;
}

export interface ApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
  readonly requestId: string;
}

export interface HealthResponse {
  readonly name: 'openpool';
  readonly status: 'ok';
  readonly version: string;
  readonly environment: string;
}

export interface CreateUploadRequest {
  readonly bucketId: string;
  readonly key: string;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface CreateUploadResponse {
  readonly objectId: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}
