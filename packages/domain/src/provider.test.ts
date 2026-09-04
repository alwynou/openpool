import { describe, expect, it } from 'vitest';

import { ProviderError } from './provider';

describe('ProviderError', () => {
  it('keeps stable categories and retry semantics', () => {
    expect(new ProviderError('INVALID_CREDENTIALS').retryable).toBe(false);
    expect(new ProviderError('RATE_LIMITED').retryable).toBe(true);
    expect(new ProviderError('TIMEOUT').code).toBe('TIMEOUT');
    expect(new ProviderError('TEMPORARY_FAILURE').retryable).toBe(true);
  });
});
