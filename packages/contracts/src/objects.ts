export type ObjectStatus = 'PENDING' | 'READY' | 'DELETING' | 'DELETED';

export interface CreateUploadRequest {
  readonly bucketId: string;
  readonly logicalKey: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  /** Explicitly replace this current unfinished session; never overwrite READY. */
  readonly retryUploadSessionId?: string;
}

export interface UploadSessionResponse {
  readonly objectId: string;
  readonly uploadSessionId: string;
  readonly status: 'PENDING' | 'COMPLETED' | 'EXPIRED' | 'ABORTED';
  readonly expiresAt: string;
}

/** A signed URL is returned only for the direct provider upload. */
export interface CreateUploadResponse {
  readonly objectId: string;
  readonly uploadSessionId: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}

export interface CompleteUploadRequest {
  readonly uploadSessionId: string;
}

/** Public logical object metadata; physical placement is deliberately omitted. */
export interface ObjectMetadataResponse {
  readonly id: string;
  readonly logicalBucketId: string;
  readonly logicalKey: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly checksum: string | null;
  readonly status: ObjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CompleteUploadResponse {
  readonly object: ObjectMetadataResponse;
  readonly uploadSessionId: string;
  /** True when this upload had already reached the same completed state. */
  readonly alreadyCompleted: boolean;
}

export interface CreateDownloadResponse {
  readonly objectId: string;
  readonly downloadUrl: string;
  readonly expiresAt: string;
}

export interface ListObjectsQuery {
  readonly status?: ObjectStatus;
  readonly prefix?: string;
  readonly afterKey?: string;
  readonly limit?: number;
}

/** Stable errors shared by object metadata and signed transfer endpoints. */
export type ObjectErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'OBJECT_INVALID'
  | 'OBJECT_NO_ACTIVE_SHARD'
  | 'OBJECT_STORAGE_ACCOUNT_NOT_FOUND'
  | 'OBJECT_STORAGE_ACCOUNT_UNAVAILABLE'
  | 'OBJECT_ALREADY_EXISTS'
  | 'OBJECT_CAPACITY_UNAVAILABLE'
  | 'OBJECT_NOT_FOUND'
  | 'OBJECT_UPLOAD_NOT_FOUND'
  | 'OBJECT_UPLOAD_EXPIRED'
  | 'OBJECT_INVALID_STATE'
  | 'OBJECT_SIZE_MISMATCH'
  | 'OBJECT_CONFLICT'
  | 'OBJECT_PROVIDER_RESPONSE_INVALID'
  | 'PROVIDER_INVALID_CREDENTIALS'
  | 'PROVIDER_FORBIDDEN'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_UNSUPPORTED'
  | 'PROVIDER_QUOTA_EXCEEDED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_PROTOCOL_ERROR'
  | 'CREDENTIAL_VAULT_UNAVAILABLE';
