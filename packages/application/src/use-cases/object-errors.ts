export type ObjectApplicationErrorCode =
  | 'OBJECT_INVALID_INPUT'
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
  | 'OBJECT_PROVIDER_RESPONSE_INVALID';

export class ObjectApplicationError extends Error {
  constructor(
    readonly code: ObjectApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ObjectApplicationError';
  }
}

export function objectError(
  code: ObjectApplicationErrorCode,
  message: string,
): ObjectApplicationError {
  return new ObjectApplicationError(code, message);
}
