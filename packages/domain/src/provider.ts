/** Provider features are capabilities, not assumptions about an SDK or protocol. */
export interface ProviderCapabilities {
  readonly presignedUpload: boolean;
  readonly presignedDownload: boolean;
  readonly headObject: boolean;
  readonly deleteObject: boolean;
  readonly bucketProbe: boolean;
  readonly usageProbe: boolean;
}

export const emptyProviderCapabilities: ProviderCapabilities = Object.freeze({
  presignedUpload: false,
  presignedDownload: false,
  headObject: false,
  deleteObject: false,
  bucketProbe: false,
  usageProbe: false,
});

/** The capabilities required before an account can accept object writes. */
export function hasWriteCapabilities(
  capabilities: ProviderCapabilities,
): boolean {
  return (
    capabilities.presignedUpload &&
    capabilities.presignedDownload &&
    capabilities.headObject &&
    capabilities.deleteObject &&
    capabilities.bucketProbe
  );
}

export const providerErrorCodes = [
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'NOT_FOUND',
  'UNSUPPORTED_CAPABILITY',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'TIMEOUT',
  'TEMPORARY_FAILURE',
  'PROTOCOL_ERROR',
] as const;

export type ProviderErrorCode = (typeof providerErrorCodes)[number];

const retryableCodes: ReadonlySet<ProviderErrorCode> = new Set([
  'RATE_LIMITED',
  'TIMEOUT',
  'TEMPORARY_FAILURE',
]);

/** Stable, provider-neutral error that adapters can safely map to API errors. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message = 'Provider operation failed') {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryableCodes.has(code);
  }
}

export function isRetryableProviderError(code: ProviderErrorCode): boolean {
  return retryableCodes.has(code);
}
