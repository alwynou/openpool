import { ProviderError, type ProviderConfig } from '@openpool/domain';

import {
  S3CompatibleProvider,
  type ParsedS3CompatibleConfig,
  type S3CompatibleProviderOptions,
} from '../s3-compatible/provider';
import type { S3AddressingStyle } from '../s3-compatible/signer';

export interface ParsedB2Config extends ParsedS3CompatibleConfig {
  readonly region: string;
}

export interface B2ProviderOptions
  extends Pick<S3CompatibleProviderOptions, 'fetch' | 'timeoutMs' | 'now'> {
  readonly config?: ProviderConfig;
  readonly region?: string;
  readonly addressingStyle?: S3AddressingStyle;
  readonly validationBucket?: string;
}

const B2_CONFIG_KEYS = new Set([
  'region',
  'addressingStyle',
  'validationBucket',
]);

function invalidB2Configuration(): never {
  throw new ProviderError('PROTOCOL_ERROR');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRegion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)
  ) {
    return invalidB2Configuration();
  }
  return value;
}

function parseBucket(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\s/\\]/u.test(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return invalidB2Configuration();
  }
  return value;
}

function parseAddressingStyle(value: unknown): S3AddressingStyle {
  if (value === undefined) return 'path';
  if (value !== 'path' && value !== 'virtual') {
    return invalidB2Configuration();
  }
  return value;
}

/** Build Backblaze's documented S3-compatible endpoint for an account region. */
export function buildB2Endpoint(region: string): string {
  return `https://s3.${parseRegion(region)}.backblazeb2.com`;
}

/** Strictly parse B2's non-secret provider configuration. */
export function parseB2Config(config: ProviderConfig): ParsedB2Config {
  if (!isRecord(config)) return invalidB2Configuration();
  if (Object.keys(config).some((key) => !B2_CONFIG_KEYS.has(key))) {
    return invalidB2Configuration();
  }
  const region = parseRegion(config.region);
  return {
    endpoint: buildB2Endpoint(region),
    region,
    addressingStyle: parseAddressingStyle(config.addressingStyle),
    validationBucket: parseBucket(config.validationBucket),
  };
}

/** Backblaze B2 implementation over the shared S3-compatible adapter. */
export class B2StorageProvider extends S3CompatibleProvider {
  private readonly b2Config: ProviderConfig | undefined;

  constructor(options: B2ProviderOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      return invalidB2Configuration();
    }
    super({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    const generatedConfig: ProviderConfig | undefined =
      options.region === undefined
        ? undefined
        : {
            region: options.region,
            ...(options.addressingStyle === undefined
              ? {}
              : { addressingStyle: options.addressingStyle }),
            ...(options.validationBucket === undefined
              ? {}
              : { validationBucket: options.validationBucket }),
          };
    this.b2Config = options.config ?? generatedConfig;
    if (this.b2Config !== undefined) parseB2Config(this.b2Config);
  }

  protected override parseConfig(config: ProviderConfig): ParsedB2Config {
    return parseB2Config(config);
  }

  protected override resolveConfig(
    config: ProviderConfig | undefined,
  ): ParsedB2Config {
    const selected = config ?? this.b2Config;
    if (selected === undefined) return invalidB2Configuration();
    return parseB2Config(selected);
  }
}

export const BackblazeB2Provider = B2StorageProvider;
export const B2Provider = B2StorageProvider;

export function createB2Provider(
  options: B2ProviderOptions = {},
): B2StorageProvider {
  return new B2StorageProvider(options);
}
