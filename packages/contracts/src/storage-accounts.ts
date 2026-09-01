export type StorageProviderKind = 'r2' | 'b2' | 's3';

export type StorageAccountStatus =
  | 'VERIFYING'
  | 'ACTIVE'
  | 'DRAINING'
  | 'READ_ONLY'
  | 'REMOVED';

export type StorageHealthStatus =
  | 'UNKNOWN'
  | 'HEALTHY'
  | 'DEGRADED'
  | 'UNHEALTHY';

export type CapacityAccuracy =
  | 'EXACT'
  | 'ESTIMATED'
  | 'CONFIGURED'
  | 'UNKNOWN';

export type ProviderConfigValue = string | number | boolean | null;
export type ProviderConfigRequest = Readonly<
  Record<string, ProviderConfigValue>
>;

/** Write-only S3-compatible credentials. They never appear in a response. */
export interface StorageCredentialsRequest {
  readonly [key: string]: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface CreateStorageAccountRequest {
  readonly name: string;
  readonly provider: StorageProviderKind;
  readonly providerConfig: ProviderConfigRequest;
  readonly credentials: StorageCredentialsRequest;
  readonly priority?: number;
  readonly capacityBytes?: number;
}

export interface ProviderCapabilitiesResponse {
  readonly presignedUpload: boolean;
  readonly presignedDownload: boolean;
  readonly headObject: boolean;
  readonly deleteObject: boolean;
  readonly bucketProbe: boolean;
  readonly usageProbe: boolean;
}

/** Safe public representation; credentials and encrypted envelopes are omitted. */
export interface StorageAccountResponse {
  readonly id: string;
  readonly name: string;
  readonly provider: StorageProviderKind;
  readonly providerConfig: ProviderConfigRequest;
  readonly status: StorageAccountStatus;
  readonly priority: number;
  readonly writeEnabled: boolean;
  readonly capacityBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly healthStatus: StorageHealthStatus;
  readonly capacityAccuracy: CapacityAccuracy;
  readonly capabilities: ProviderCapabilitiesResponse;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastHealthCheckedAt: string | null;
}

export interface UpdateStorageAccountStatusRequest {
  readonly status: 'DRAINING' | 'READ_ONLY' | 'REMOVED';
}

export type StorageAccountErrorCode =
  | 'UNAUTHORIZED'
  | 'STORAGE_ACCOUNT_INVALID'
  | 'STORAGE_ACCOUNT_NOT_FOUND'
  | 'STORAGE_ACCOUNT_ALREADY_EXISTS'
  | 'STORAGE_ACCOUNT_CONFLICT'
  | 'STORAGE_ACCOUNT_REQUIRES_VERIFICATION'
  | 'STORAGE_ACCOUNT_NOT_VERIFYING'
  | 'STORAGE_ACCOUNT_HAS_REFERENCES'
  | 'PROVIDER_INVALID_CREDENTIALS'
  | 'PROVIDER_FORBIDDEN'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_UNSUPPORTED'
  | 'PROVIDER_QUOTA_EXCEEDED'
  | 'PROVIDER_PROTOCOL_ERROR'
  | 'CREDENTIAL_VAULT_UNAVAILABLE';
