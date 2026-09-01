import type { ProviderRegistry, StorageProvider } from '@openpool/application';
import { ProviderError, type StorageAccount } from '@openpool/domain';

import {
  S3CompatibleProvider,
  type S3CompatibleProviderOptions,
} from './s3-compatible/provider';
import { B2StorageProvider, type B2ProviderOptions } from './b2/provider';
import { R2StorageProvider, type R2ProviderOptions } from './r2/provider';

export * from './b2';
export * from './s3-compatible';
export * from './s3-compatible/provider';
export * from './r2';

export interface WorkerProviderRegistryOptions {
  readonly s3?: S3CompatibleProviderOptions;
  readonly r2?: R2ProviderOptions;
  readonly b2?: B2ProviderOptions;
}

/**
 * Composition adapter for provider kinds. Provider instances contain only
 * runtime dependencies; credentials are supplied to each port operation.
 */
export class StorageProviderRegistry implements ProviderRegistry {
  private readonly s3: S3CompatibleProvider;
  private readonly r2: R2StorageProvider;
  private readonly b2: B2StorageProvider;

  constructor(options: WorkerProviderRegistryOptions = {}) {
    this.s3 = new S3CompatibleProvider(options.s3);
    this.r2 = new R2StorageProvider(options.r2);
    this.b2 = new B2StorageProvider(options.b2);
  }

  forAccount(account: StorageAccount): StorageProvider {
    if (account.provider === 'r2') return this.r2;
    if (account.provider === 'b2') return this.b2;
    if (account.provider === 's3') return this.s3;
    throw new ProviderError('UNSUPPORTED_CAPABILITY');
  }
}

export const ProviderRegistryAdapter = StorageProviderRegistry;

export function createStorageProviderRegistry(
  options: WorkerProviderRegistryOptions = {},
): ProviderRegistry {
  return new StorageProviderRegistry(options);
}
