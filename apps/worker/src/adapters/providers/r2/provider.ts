import {
  ProviderError,
  type ProviderConfig,
  type ProviderCapabilities,
} from '@openpool/domain';

import {
  S3CompatibleProvider,
  type ParsedS3CompatibleConfig,
  type S3CompatibleProviderOptions,
} from '../s3-compatible/provider';
import type { S3AddressingStyle } from '../s3-compatible/signer';

export type R2Jurisdiction = 'eu' | 'fedramp';

export interface ParsedR2Config extends ParsedS3CompatibleConfig {
  readonly accountId: string;
  readonly jurisdiction?: R2Jurisdiction;
}

export interface R2ProviderOptions
  extends Pick<S3CompatibleProviderOptions, 'fetch' | 'timeoutMs' | 'now'> {
  readonly config?: ProviderConfig;
  readonly accountId?: string;
  readonly jurisdiction?: R2Jurisdiction;
  readonly region?: 'auto';
  readonly addressingStyle?: S3AddressingStyle;
  readonly validationBucket?: string;
}

const R2_CONFIG_KEYS = new Set([
  'accountId',
  'jurisdiction',
  'region',
  'addressingStyle',
  'validationBucket',
]);

function invalidR2Configuration(): never {
  throw new ProviderError('PROTOCOL_ERROR');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeHostLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)
  );
}

function parseBucket(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /\s/u.test(value) ||
    value.includes('/') ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return invalidR2Configuration();
  }
  return value;
}

function parseAddressingStyle(value: unknown): S3AddressingStyle {
  if (value === undefined) return 'path';
  if (value !== 'path' && value !== 'virtual') {
    return invalidR2Configuration();
  }
  return value;
}

/** Build the official Cloudflare R2 S3 endpoint for an account. */
export function buildR2Endpoint(
  accountId: string,
  jurisdiction?: R2Jurisdiction,
): string {
  if (!safeHostLabel(accountId)) return invalidR2Configuration();
  return `https://${accountId}.${jurisdiction === undefined ? '' : `${jurisdiction}.`}r2.cloudflarestorage.com`;
}

/** Strictly parse R2's non-secret provider configuration. */
export function parseR2Config(config: ProviderConfig): ParsedR2Config {
  if (!isRecord(config)) return invalidR2Configuration();
  if (Object.keys(config).some((key) => !R2_CONFIG_KEYS.has(key))) {
    return invalidR2Configuration();
  }

  const accountId = config.accountId;
  if (!safeHostLabel(accountId)) return invalidR2Configuration();

  const jurisdictionValue = config.jurisdiction;
  let jurisdiction: R2Jurisdiction | undefined;
  if (jurisdictionValue !== undefined) {
    if (jurisdictionValue !== 'eu' && jurisdictionValue !== 'fedramp') {
      return invalidR2Configuration();
    }
    jurisdiction = jurisdictionValue;
  }

  // R2 signs requests for the fixed SigV4 region "auto". An explicitly
  // supplied region is accepted only when it agrees with that invariant.
  if (config.region !== undefined && config.region !== 'auto') {
    return invalidR2Configuration();
  }

  const validationBucket = parseBucket(config.validationBucket);
  const addressingStyle = parseAddressingStyle(config.addressingStyle);
  const endpoint = buildR2Endpoint(accountId, jurisdiction);
  return {
    accountId,
    ...(jurisdiction === undefined ? {} : { jurisdiction }),
    endpoint,
    region: 'auto',
    addressingStyle,
    validationBucket,
  };
}

/** Cloudflare R2 implementation over the generic S3-compatible adapter. */
export class R2StorageProvider extends S3CompatibleProvider {
  private readonly r2Config: ProviderConfig | undefined;

  constructor(options: R2ProviderOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      return invalidR2Configuration();
    }
    super({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    const generatedConfig: ProviderConfig | undefined =
      options.accountId === undefined
        ? undefined
        : {
            accountId: options.accountId,
            ...(options.jurisdiction === undefined
              ? {}
              : { jurisdiction: options.jurisdiction }),
            ...(options.region === undefined ? {} : { region: options.region }),
            ...(options.addressingStyle === undefined
              ? {}
              : { addressingStyle: options.addressingStyle }),
            ...(options.validationBucket === undefined
              ? {}
              : { validationBucket: options.validationBucket }),
          };
    const staticConfig: ProviderConfig | undefined =
      options.config ??
      generatedConfig;
    this.r2Config = staticConfig;
    if (this.r2Config !== undefined) parseR2Config(this.r2Config);
  }

  protected override parseConfig(config: ProviderConfig): ParsedR2Config {
    return parseR2Config(config);
  }

  protected override resolveConfig(
    config: ProviderConfig | undefined,
  ): ParsedR2Config {
    const selected = config ?? this.r2Config;
    if (selected === undefined) return invalidR2Configuration();
    return parseR2Config(selected);
  }
}

export const R2Provider = R2StorageProvider;
export const CloudflareR2Provider = R2StorageProvider;
export const parseCloudflareR2Config = parseR2Config;

export type R2ProviderCapabilities = ProviderCapabilities;

export function createR2Provider(
  options: R2ProviderOptions = {},
): R2StorageProvider {
  return new R2StorageProvider(options);
}
