export interface ApiEnvelope<T> {
  readonly data: T;
  readonly requestId: string;
}

export * from './api-keys';
export * from './audit-logs';
export * from './buckets';
export * from './objects';
export * from './shard-migrations';
export * from './storage-accounts';

export interface ApiError<TCode extends string = string> {
  readonly error: {
    readonly code: TCode;
    readonly message: string;
  };
  readonly requestId: string;
}

/** Stable error codes exposed by the authentication and setup endpoints. */
export type AuthErrorCode =
  | 'ALREADY_INITIALIZED'
  | 'INVALID_BOOTSTRAP_TOKEN'
  | 'INVALID_CREDENTIALS'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'VALIDATION_ERROR';

/** Safe configuration findings exposed by the readiness failure response. */
export type DeploymentReadinessIssueCode =
  | 'API_KEY_PEPPER_INVALID'
  | 'API_KEY_PEPPER_MISSING'
  | 'ADMIN_BOOTSTRAP_TOKEN_INVALID'
  | 'ADMIN_BOOTSTRAP_TOKEN_MISSING'
  | 'ADMIN_BOOTSTRAP_TOKEN_UNEXPECTED'
  | 'AUTH_RATE_LIMITERS_MISSING'
  | 'CREDENTIAL_MASTER_KEY_ID_INVALID'
  | 'CREDENTIAL_MASTER_KEY_INVALID'
  | 'CREDENTIAL_MASTER_KEY_MISSING'
  | 'CRYPTO_SECRET_REUSE_DETECTED'
  | 'DATABASE_UNAVAILABLE';

/** A non-ready deployment reports only issue codes, never binding values. */
export interface DeploymentReadinessError {
  readonly error: {
    readonly code: 'DEPLOYMENT_NOT_READY';
    readonly message: string;
    readonly issues: readonly DeploymentReadinessIssueCode[];
  };
  readonly requestId: string;
}

export interface SetupStatusResponse {
  readonly initialized: boolean;
}

export interface InitializeAdminRequest {
  readonly username: string;
  readonly password: string;
}

/** Public administrator representation; credentials and password hashes are never returned. */
export interface AdministratorResponse {
  readonly id: string;
  readonly username: string;
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LoginRequest {
  readonly username: string;
  readonly password: string;
}

export interface LoginResponse {
  readonly administrator: AdministratorResponse;
  readonly expiresAt: string;
}

export interface SessionResponse {
  readonly authenticated: boolean;
  readonly administrator: AdministratorResponse | null;
  readonly expiresAt: string | null;
}

export interface HealthResponse {
  readonly name: 'openpool';
  readonly status: 'ok';
  readonly version: string;
  readonly environment: string;
}
