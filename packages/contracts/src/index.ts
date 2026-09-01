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
  | 'VALIDATION_ERROR';

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
