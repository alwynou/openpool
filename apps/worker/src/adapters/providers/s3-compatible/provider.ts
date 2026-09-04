import {
  ProviderError,
  type ProviderConfig,
  type ProviderCapabilities,
} from '@openpool/domain';
import type {
  CredentialPayload,
  DownloadUrlRequest,
  ObjectProviderRequest,
  ProviderObjectMetadata,
  StorageProvider,
  SignedDownload,
  SignedUpload,
  UploadUrlRequest,
  ProviderProbeResult,
  ProviderValidationResult,
} from '@openpool/application';

import {
  S3CompatibleSigner,
  S3CompatibleSignerError,
  type S3AddressingStyle,
  type S3CompatibleCredentials,
  type S3ObjectMethod,
  type SignedS3ObjectUrl,
} from './signer';

/** The S3-compatible capabilities exposed by the wrapper. */
export const s3CompatibleCapabilities: ProviderCapabilities = Object.freeze({
  presignedUpload: true,
  presignedDownload: true,
  headObject: true,
  deleteObject: true,
  bucketProbe: true,
  usageProbe: false,
});

export const S3_COMPATIBLE_VALIDATION_EXPIRY_SECONDS = 60;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;

type Fetcher = typeof fetch;
type Clock = () => Date;

export interface ProviderRuntimeOptions {
  /** Injected fetch keeps provider tests network-free. */
  readonly fetch?: Fetcher;
  readonly timeoutMs?: number;
  /** Used for deterministic signatures in tests. */
  readonly now?: Clock;
}

export interface S3CompatibleProviderOptions extends ProviderRuntimeOptions {
  /** Optional static configuration for callers that construct one provider per account. */
  readonly config?: ProviderConfig;
  readonly endpoint?: string;
  readonly region?: string;
  readonly addressingStyle?: S3AddressingStyle;
  readonly validationBucket?: string;
}

export interface ParsedS3CompatibleConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly addressingStyle: S3AddressingStyle;
  readonly validationBucket: string;
}

const GENERIC_CONFIG_KEYS = new Set([
  'endpoint',
  'region',
  'addressingStyle',
  'validationBucket',
]);

function providerError(
  code: ConstructorParameters<typeof ProviderError>[0],
): ProviderError {
  // Keep this message deliberately generic: it must not include endpoint,
  // bucket, response body, authorization material, or any other input.
  return new ProviderError(code);
}

function invalidConfiguration(): never {
  throw providerError('PROTOCOL_ERROR');
}

function invalidCredentials(): never {
  throw providerError('INVALID_CREDENTIALS');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, allowWhitespace = false): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    (allowWhitespace || !/\s/u.test(value)) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

/** Parse the application JSON credential payload into the signer-local shape. */
export function parseS3CompatibleCredentials(
  payload: CredentialPayload,
): S3CompatibleCredentials {
  if (!isRecord(payload)) return invalidCredentials();
  const keys = Object.keys(payload);
  if (
    keys.some(
      (key) =>
        key !== 'accessKeyId' &&
        key !== 'secretAccessKey' &&
        key !== 'sessionToken',
    )
  ) {
    return invalidCredentials();
  }

  const accessKeyId = payload.accessKeyId;
  const secretAccessKey = payload.secretAccessKey;
  const sessionToken = payload.sessionToken;
  if (!safeString(accessKeyId) || !safeString(secretAccessKey, true)) {
    return invalidCredentials();
  }
  if (sessionToken !== undefined && !safeString(sessionToken, true)) {
    return invalidCredentials();
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}

function parseEndpoint(value: unknown): string {
  if (!safeString(value)) return invalidConfiguration();
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return invalidConfiguration();
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    return invalidConfiguration();
  }
  return value;
}

function parseAddressingStyle(value: unknown): S3AddressingStyle {
  if (value === undefined) return 'path';
  if (value !== 'path' && value !== 'virtual') return invalidConfiguration();
  return value;
}

function parseValidationBucket(value: unknown): string {
  if (!safeString(value) || value.includes('/')) {
    return invalidConfiguration();
  }
  return value;
}

function parseRegion(value: unknown): string {
  if (!safeString(value)) return invalidConfiguration();
  return value;
}

/** Strictly parse the non-secret Generic S3 provider configuration. */
export function parseS3CompatibleConfig(
  config: ProviderConfig,
): ParsedS3CompatibleConfig {
  if (!isRecord(config)) return invalidConfiguration();
  if (Object.keys(config).some((key) => !GENERIC_CONFIG_KEYS.has(key))) {
    return invalidConfiguration();
  }
  return {
    endpoint: parseEndpoint(config.endpoint),
    region: parseRegion(config.region),
    addressingStyle: parseAddressingStyle(config.addressingStyle),
    validationBucket: parseValidationBucket(config.validationBucket),
  };
}

function statusError(status: number): ProviderError | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 401) return providerError('INVALID_CREDENTIALS');
  if (status === 403) return providerError('FORBIDDEN');
  if (status === 404) return providerError('NOT_FOUND');
  if (status === 429) return providerError('RATE_LIMITED');
  if (status === 408 || status === 504) return providerError('TIMEOUT');
  if (status >= 500 && status <= 599) {
    return providerError('TEMPORARY_FAILURE');
  }
  return providerError('PROTOCOL_ERROR');
}

function validateObjectRequest(
  request: ObjectProviderRequest | DownloadUrlRequest,
): void {
  if (
    !isRecord(request) ||
    !isRecord(request.account) ||
    !safeString(request.bucket, true) ||
    !safeString(request.key, true)
  ) {
    throw providerError('PROTOCOL_ERROR');
  }
}

function parseContentLength(headers: Headers): number {
  const value = headers.get('content-length');
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw providerError('PROTOCOL_ERROR');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw providerError('PROTOCOL_ERROR');
  }
  return parsed;
}

function parseEtag(headers: Headers): string | null {
  const value = headers.get('etag');
  if (value === null) return null;
  // S3 ETags are quoted opaque tags. Reject control characters, weak tags,
  // and malformed quoting instead of persisting ambiguous provider data.
  if (!/^"(?:!|[#-~])+"$/u.test(value)) {
    throw providerError('PROTOCOL_ERROR');
  }
  return value;
}

const CHECKSUM_HEADERS = [
  'x-amz-checksum-sha256',
  'x-amz-checksum-sha1',
  'x-amz-checksum-crc64nvme',
  'x-amz-checksum-crc32c',
  'x-amz-checksum-crc32',
] as const;

function parseChecksum(headers: Headers): string | null {
  const values = CHECKSUM_HEADERS.flatMap((name) => {
    const value = headers.get(name);
    return value === null ? [] : [value];
  });
  if (values.length === 0) return null;
  if (values.length !== 1) throw providerError('PROTOCOL_ERROR');
  const [value] = values;
  if (value === undefined) throw providerError('PROTOCOL_ERROR');
  if (
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw providerError('PROTOCOL_ERROR');
  }
  return value;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (isRecord(error) && error.name === 'AbortError');
}

function parseTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) {
    return invalidConfiguration();
  }
  return timeout;
}

/**
 * Generic S3-compatible StorageProvider adapter.
 *
 * This class deliberately stores only non-secret runtime dependencies. A
 * signer is created inside each operation and is allowed to go out of scope
 * as soon as the operation completes.
 */
export class S3CompatibleProvider implements StorageProvider {
  readonly capabilities = s3CompatibleCapabilities;

  private readonly fetcher!: Fetcher;
  private readonly timeoutMs!: number;
  private readonly now!: Clock;
  private readonly staticConfig: ProviderConfig | undefined;

  constructor(options: S3CompatibleProviderOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      return invalidConfiguration();
    }
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (typeof this.fetcher !== 'function') return invalidConfiguration();
    this.timeoutMs = parseTimeout(options.timeoutMs);
    this.now = options.now ?? (() => new Date());
    if (typeof this.now !== 'function') return invalidConfiguration();

    const generatedConfig: ProviderConfig | undefined =
      options.endpoint === undefined &&
      options.region === undefined &&
      options.addressingStyle === undefined &&
      options.validationBucket === undefined
        ? undefined
        : {
            ...(options.endpoint === undefined
              ? {}
              : { endpoint: options.endpoint }),
            ...(options.region === undefined ? {} : { region: options.region }),
            ...(options.addressingStyle === undefined
              ? {}
              : { addressingStyle: options.addressingStyle }),
            ...(options.validationBucket === undefined
              ? {}
              : { validationBucket: options.validationBucket }),
          };
    const optionConfig: ProviderConfig | undefined =
      options.config ??
      generatedConfig;
    this.staticConfig = optionConfig;
    if (this.staticConfig !== undefined) parseS3CompatibleConfig(this.staticConfig);
  }

  protected parseConfig(config: ProviderConfig): ParsedS3CompatibleConfig {
    return parseS3CompatibleConfig(config);
  }

  protected resolveConfig(config: ProviderConfig | undefined): ParsedS3CompatibleConfig {
    const selected = config ?? this.staticConfig;
    if (selected === undefined) return invalidConfiguration();
    return this.parseConfig(selected);
  }

  protected signer(
    credentials: CredentialPayload,
    config: ParsedS3CompatibleConfig,
  ): S3CompatibleSigner {
    return new S3CompatibleSigner({
      endpoint: config.endpoint,
      region: config.region,
      addressingStyle: config.addressingStyle,
      credentials: parseS3CompatibleCredentials(credentials),
    });
  }

  protected async headBucket(
    credentials: CredentialPayload,
    config: ParsedS3CompatibleConfig,
  ): Promise<void> {
    let signed;
    try {
      signed = await this.signer(credentials, config).presignBucket({
        bucket: config.validationBucket,
        expiresIn: S3_COMPATIBLE_VALIDATION_EXPIRY_SECONDS,
        signingDate: this.now(),
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof S3CompatibleSignerError) {
        throw providerError('PROTOCOL_ERROR');
      }
      throw providerError('PROTOCOL_ERROR');
    }

    await this.sendSignedRequest(signed, 'HEAD');
  }

  private async sendSignedRequest(
    signed: SignedS3ObjectUrl,
    method: S3ObjectMethod,
    options: { readonly allowNotFound?: boolean } = {},
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(providerError('TIMEOUT'));
      }, this.timeoutMs);
    });

    try {
      const request = new Request(signed.url, {
        method,
        signal: controller.signal,
      });
      const response = await Promise.race([this.fetcher(request), timeout]);
      if (timedOut) throw providerError('TIMEOUT');
      if (!response || typeof response.status !== 'number') {
        throw providerError('PROTOCOL_ERROR');
      }
      if (options.allowNotFound === true && response.status === 404) {
        return response;
      }
      const error = statusError(response.status);
      if (error) throw error;
      if (!(response.headers instanceof Headers)) {
        throw providerError('PROTOCOL_ERROR');
      }
      return response;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (timedOut || isAbortError(error)) throw providerError('TIMEOUT');
      // A transport failure is retryable; protocol/status failures above are
      // represented by ProviderError before reaching this branch.
      throw providerError('TEMPORARY_FAILURE');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async validate(
    credentials: CredentialPayload,
    config: ProviderConfig,
  ): Promise<ProviderValidationResult> {
    const parsed = this.resolveConfig(config);
    await this.headBucket(credentials, parsed);
    return { capabilities: this.capabilities };
  }

  async probe(
    credentials: CredentialPayload,
    config: ProviderConfig,
  ): Promise<ProviderProbeResult> {
    const parsed = this.resolveConfig(config);
    await this.headBucket(credentials, parsed);
    return {
      healthStatus: 'HEALTHY',
      capacityBytes: null,
      usedBytes: null,
      capacityAccuracy: 'UNKNOWN',
    };
  }

  async createUploadUrl(request: UploadUrlRequest): Promise<SignedUpload> {
    if (!isRecord(request) || !isRecord(request.account)) {
      throw providerError('PROTOCOL_ERROR');
    }
    const config = this.resolveConfig(request.account.providerConfig);
    if (
      !safeString(request.bucket, true) ||
      !safeString(request.key, true) ||
      !safeString(request.contentType, true) ||
      !Number.isSafeInteger(request.sizeBytes) ||
      request.sizeBytes < 0
    ) {
      throw providerError('PROTOCOL_ERROR');
    }

    try {
      // Credentials are parsed and consumed only within this call. Do not
      // retain them on the provider or in a reusable signer instance.
      const signed = await this.signer(request.credentials, config).presign({
        method: 'PUT',
        bucket: request.bucket,
        key: request.key,
        contentType: request.contentType,
        contentLength: request.sizeBytes,
        expiresIn: request.expiresInSeconds,
        signingDate: this.now(),
      });
      return { url: signed.url, expiresAt: signed.expiresAt };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw providerError('PROTOCOL_ERROR');
    }
  }

  async createDownloadUrl(
    request: DownloadUrlRequest,
  ): Promise<SignedDownload> {
    validateObjectRequest(request);
    const config = this.resolveConfig(request.account.providerConfig);
    try {
      const signed = await this.signer(request.credentials, config).presign({
        method: 'GET',
        bucket: request.bucket,
        key: request.key,
        expiresIn: request.expiresInSeconds,
        signingDate: this.now(),
      });
      return { url: signed.url, expiresAt: signed.expiresAt };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw providerError('PROTOCOL_ERROR');
    }
  }

  async headObject(
    request: ObjectProviderRequest,
  ): Promise<ProviderObjectMetadata> {
    validateObjectRequest(request);
    const config = this.resolveConfig(request.account.providerConfig);
    let signed: SignedS3ObjectUrl;
    try {
      signed = await this.signer(request.credentials, config).presign({
        method: 'HEAD',
        bucket: request.bucket,
        key: request.key,
        expiresIn: S3_COMPATIBLE_VALIDATION_EXPIRY_SECONDS,
        signingDate: this.now(),
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw providerError('PROTOCOL_ERROR');
    }
    const response = await this.sendSignedRequest(signed, 'HEAD');
    return {
      sizeBytes: parseContentLength(response.headers),
      etag: parseEtag(response.headers),
      checksum: parseChecksum(response.headers),
    };
  }

  async deleteObject(request: ObjectProviderRequest): Promise<void> {
    validateObjectRequest(request);
    const config = this.resolveConfig(request.account.providerConfig);
    let signed: SignedS3ObjectUrl;
    try {
      signed = await this.signer(request.credentials, config).presign({
        method: 'DELETE',
        bucket: request.bucket,
        key: request.key,
        expiresIn: S3_COMPATIBLE_VALIDATION_EXPIRY_SECONDS,
        signingDate: this.now(),
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw providerError('PROTOCOL_ERROR');
    }
    // DELETE is retried after a D1 completion conflict. A missing remote key
    // therefore represents the desired end state and is idempotent success.
    await this.sendSignedRequest(signed, 'DELETE', { allowNotFound: true });
  }
}

export const GenericS3CompatibleProvider = S3CompatibleProvider;
export const S3CompatibleStorageProvider = S3CompatibleProvider;
export const GenericS3Provider = S3CompatibleProvider;
export const parseGenericS3CompatibleConfig = parseS3CompatibleConfig;

export function createS3CompatibleProvider(
  options: S3CompatibleProviderOptions = {},
): S3CompatibleProvider {
  return new S3CompatibleProvider(options);
}
