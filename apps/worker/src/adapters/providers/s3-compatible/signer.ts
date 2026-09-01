import { formatUrl } from '@aws-sdk/core/util';
import { S3RequestPresigner } from '@aws-sdk/s3-request-presigner';
// @aws-sdk/checksums/sha exposes this class only from its browser condition;
// @smithy/core is the portable export used by the Worker type/runtime build.
import { Sha256WebCrypto } from '@smithy/core/checksum';
import { HttpRequest } from '@smithy/core/protocols';

export const DEFAULT_S3_PRESIGN_EXPIRY_SECONDS = 900;
export const MAX_S3_PRESIGN_EXPIRY_SECONDS = 604_800;

export type S3AddressingStyle = 'path' | 'virtual';
export type S3ObjectMethod = 'GET' | 'HEAD' | 'PUT' | 'DELETE';

/** Credentials are deliberately a local shape rather than an SDK type. */
export interface S3CompatibleCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface S3CompatibleSignerOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly addressingStyle: S3AddressingStyle;
  readonly credentials: S3CompatibleCredentials;
}

export interface S3ObjectPresignRequest {
  readonly method: S3ObjectMethod;
  readonly bucket: string;
  readonly key: string;
  readonly expiresIn?: number;
  readonly signingDate?: Date;
  /** When supplied for PUT, this header is signed by default. */
  readonly contentType?: string;
  /** Required for PUT so the provider rejects a body larger than reserved. */
  readonly contentLength?: number;
  readonly signContentType?: boolean;
}

export interface S3BucketPresignRequest {
  readonly bucket: string;
  readonly expiresIn?: number;
  readonly signingDate?: Date;
}

export interface SignedS3ObjectUrl {
  readonly url: string;
  readonly expiresAt: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export type S3CompatibleSignerErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST';

/** Error messages intentionally contain no endpoint, key, or credential data. */
export class S3CompatibleSignerError extends Error {
  readonly code: S3CompatibleSignerErrorCode;

  constructor(code: S3CompatibleSignerErrorCode) {
    super(`S3-compatible signer error: ${code}`);
    this.name = 'S3CompatibleSignerError';
    this.code = code;
  }
}

interface ParsedEndpoint {
  readonly protocol: string;
  readonly hostname: string;
  readonly port?: number;
  readonly basePath: string;
}

interface SigningCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

function invalidConfiguration(): never {
  throw new S3CompatibleSignerError('INVALID_CONFIGURATION');
}

function invalidRequest(): never {
  throw new S3CompatibleSignerError('INVALID_REQUEST');
}

function parseEndpoint(endpoint: string): ParsedEndpoint {
  if (
    typeof endpoint !== 'string' ||
    endpoint.length === 0 ||
    endpoint.includes('?') ||
    endpoint.includes('#')
  ) {
    return invalidConfiguration();
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return invalidConfiguration();
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return invalidConfiguration();
  }

  const port = parsed.port.length > 0 ? Number(parsed.port) : undefined;
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    return invalidConfiguration();
  }

  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    ...(port === undefined ? {} : { port }),
    // URL.pathname is already URI encoded. It is kept separate from the key
    // so formatUrl never gets an opportunity to normalize path segments.
    basePath: parsed.pathname === '/' ? '' : parsed.pathname,
  };
}

function validateCredentials(
  credentials: S3CompatibleCredentials,
): SigningCredentials {
  if (credentials === null || typeof credentials !== 'object') {
    return invalidConfiguration();
  }

  const { accessKeyId, secretAccessKey, sessionToken } = credentials;
  if (
    typeof accessKeyId !== 'string' ||
    accessKeyId.length === 0 ||
    /\s/u.test(accessKeyId) ||
    typeof secretAccessKey !== 'string' ||
    secretAccessKey.length === 0 ||
    (sessionToken !== undefined &&
      (typeof sessionToken !== 'string' || sessionToken.length === 0))
  ) {
    return invalidConfiguration();
  }

  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}

function encodePathSegment(value: string): string {
  try {
    const encoded = encodeURIComponent(value).replace(
      /[!'()*]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return encoded;
  } catch {
    return invalidRequest();
  }
}

function encodeObjectKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) return invalidRequest();
  const segments = key.split('/');
  // WHATWG URL parsing normalizes even percent-encoded dot segments. A URL
  // that changes the key after signing is worse than a rejected key.
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return invalidRequest();
  }
  return segments.map(encodePathSegment).join('/');
}

function encodeBucket(bucket: string, style: S3AddressingStyle): string {
  if (typeof bucket !== 'string' || bucket.length === 0 || bucket.includes('/')) {
    return invalidRequest();
  }

  if (style === 'virtual') {
    // This is the S3 DNS-compatible bucket subset. In particular, do not
    // allow an IP address or labels that would create an invalid host name.
    const dnsSafe =
      bucket.length >= 3 &&
      bucket.length <= 63 &&
      /^(?!\d+(?:\.\d+){3}$)(?!-)(?!.*-$)(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(
        bucket,
      );
    if (!dnsSafe) return invalidRequest();
    return bucket;
  }

  if (
    [...bucket].some((character) => {
      const code = character.charCodeAt(0);
      return (
        character === '/' ||
        character === '\\' ||
        code < 0x20 ||
        code === 0x7f
      );
    })
  ) {
    return invalidRequest();
  }
  return encodePathSegment(bucket);
}

function appendPath(basePath: string, suffix: string): string {
  if (basePath.length === 0) return `/${suffix}`;
  return basePath.endsWith('/') ? `${basePath}${suffix}` : `${basePath}/${suffix}`;
}

function normalizeSigningDate(input: Date | undefined): Date {
  if (input !== undefined && !(input instanceof Date)) return invalidRequest();
  const date = input === undefined ? new Date() : new Date(input.getTime());
  if (!Number.isFinite(date.getTime())) return invalidRequest();
  return date;
}

function validateExpiry(expiresIn: number | undefined): number {
  const value = expiresIn ?? DEFAULT_S3_PRESIGN_EXPIRY_SECONDS;
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_S3_PRESIGN_EXPIRY_SECONDS
  ) {
    return invalidRequest();
  }
  return value;
}

function validateContentType(contentType: unknown): asserts contentType is string {
  if (
    typeof contentType !== 'string' ||
    contentType.length === 0 ||
    contentType !== contentType.trim() ||
    [...contentType].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    invalidRequest();
  }
}

/** Low-level, network-free SigV4 presigner for S3-compatible object stores. */
export class S3CompatibleSigner {
  private readonly endpoint: ParsedEndpoint;
  private readonly addressingStyle: S3AddressingStyle;
  private readonly presigner: S3RequestPresigner;

  constructor(options: S3CompatibleSignerOptions) {
    if (options === null || typeof options !== 'object') {
      invalidConfiguration();
    }
    if (
      options.addressingStyle !== 'path' &&
      options.addressingStyle !== 'virtual'
    ) {
      invalidConfiguration();
    }
    if (
      typeof options.region !== 'string' ||
      options.region.length === 0 ||
      /\s/u.test(options.region)
    ) {
      invalidConfiguration();
    }

    this.endpoint = parseEndpoint(options.endpoint);
    this.addressingStyle = options.addressingStyle;
    const credentials = validateCredentials(options.credentials);
    this.presigner = new S3RequestPresigner({
      credentials,
      region: options.region,
      service: 's3',
      sha256: Sha256WebCrypto,
      // S3 canonical paths retain slash hierarchy. We encode each key segment
      // ourselves and must not let the SDK escape the path a second time.
      uriEscapePath: false,
      applyChecksum: false,
    });
  }

  async presign(request: S3ObjectPresignRequest): Promise<SignedS3ObjectUrl> {
    if (request === null || typeof request !== 'object') return invalidRequest();
    const method =
      typeof request.method === 'string'
        ? request.method.toUpperCase()
        : undefined;
    if (
      method === undefined ||
      (method !== 'GET' &&
        method !== 'HEAD' &&
        method !== 'PUT' &&
        method !== 'DELETE')
    ) {
      return invalidRequest();
    }

    const bucket = encodeBucket(request.bucket, this.addressingStyle);
    const key = encodeObjectKey(request.key);
    const expiresIn = validateExpiry(request.expiresIn);
    const signingDate = normalizeSigningDate(request.signingDate);

    if (request.contentType !== undefined && method !== 'PUT') {
      return invalidRequest();
    }
    if (
      (method === 'PUT' &&
        (!Number.isSafeInteger(request.contentLength) ||
          request.contentLength === undefined ||
          request.contentLength < 0)) ||
      (method !== 'PUT' && request.contentLength !== undefined)
    ) {
      return invalidRequest();
    }
    if (request.contentType !== undefined) {
      validateContentType(request.contentType);
    }
    if (
      request.signContentType !== undefined &&
      typeof request.signContentType !== 'boolean'
    ) {
      return invalidRequest();
    }
    if (request.signContentType === true && request.contentType === undefined) {
      return invalidRequest();
    }
    const shouldSignContentType =
      request.contentType !== undefined && request.signContentType !== false;

    const hostname =
      this.addressingStyle === 'virtual'
        ? `${bucket}.${this.endpoint.hostname}`
        : this.endpoint.hostname;
    const path = appendPath(
      this.endpoint.basePath,
      this.addressingStyle === 'path' ? `${bucket}/${key}` : key,
    );
    const requiredHeaders: Record<string, string> = {};
    if (request.contentType !== undefined) {
      requiredHeaders['content-type'] = request.contentType;
    }
    if (request.contentLength !== undefined) {
      requiredHeaders['content-length'] = String(request.contentLength);
    }
    const unsignedRequest = new HttpRequest({
      protocol: this.endpoint.protocol,
      hostname,
      ...(this.endpoint.port === undefined ? {} : { port: this.endpoint.port }),
      path,
      method,
      headers: { ...requiredHeaders },
    });

    const signedRequest = await this.presigner.presign(unsignedRequest, {
      expiresIn,
      signingDate,
      ...(method === 'PUT'
        ? {
            signableHeaders: new Set([
              'content-length',
              ...(shouldSignContentType ? ['content-type'] : []),
            ]),
          }
        : {}),
    });

    return {
      url: formatUrl(signedRequest),
      expiresAt: new Date(
        signingDate.getTime() + expiresIn * 1_000,
      ).toISOString(),
      requiredHeaders,
    };
  }

  /** Presign a HEAD Bucket request used for credential and bucket probes. */
  async presignBucket(
    request: S3BucketPresignRequest,
  ): Promise<SignedS3ObjectUrl> {
    if (request === null || typeof request !== 'object') {
      return invalidRequest();
    }
    const bucket = encodeBucket(request.bucket, this.addressingStyle);
    const expiresIn = validateExpiry(request.expiresIn);
    const signingDate = normalizeSigningDate(request.signingDate);
    const hostname =
      this.addressingStyle === 'virtual'
        ? `${bucket}.${this.endpoint.hostname}`
        : this.endpoint.hostname;
    const suffix = this.addressingStyle === 'path' ? bucket : '';
    const path =
      suffix.length === 0
        ? this.endpoint.basePath || '/'
        : appendPath(this.endpoint.basePath, suffix);
    const unsignedRequest = new HttpRequest({
      protocol: this.endpoint.protocol,
      hostname,
      ...(this.endpoint.port === undefined ? {} : { port: this.endpoint.port }),
      path,
      method: 'HEAD',
      headers: {},
    });
    const signedRequest = await this.presigner.presign(unsignedRequest, {
      expiresIn,
      signingDate,
    });

    return {
      url: formatUrl(signedRequest),
      expiresAt: new Date(
        signingDate.getTime() + expiresIn * 1_000,
      ).toISOString(),
      requiredHeaders: {},
    };
  }
}

export function createS3CompatibleSigner(
  options: S3CompatibleSignerOptions,
): S3CompatibleSigner {
  return new S3CompatibleSigner(options);
}
