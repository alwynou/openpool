import { describe, expect, it } from 'vitest';

import {
  validateLogicalBucketDescription,
  validateLogicalBucketName,
} from './logical-bucket';

describe('logical bucket validation', () => {
  it('accepts provider-independent names and descriptions', () => {
    expect(() => validateLogicalBucketName('用户文件')).not.toThrow();
    expect(() => validateLogicalBucketDescription('my files')).not.toThrow();
    expect(() => validateLogicalBucketDescription(null)).not.toThrow();
  });

  it('rejects empty, oversized, and control-character values', () => {
    expect(() => validateLogicalBucketName('')).toThrow(RangeError);
    expect(() => validateLogicalBucketName('a'.repeat(129))).toThrow(RangeError);
    expect(() => validateLogicalBucketName('bucket\nname')).toThrow(RangeError);
    expect(() => validateLogicalBucketDescription('a'.repeat(513))).toThrow(
      RangeError,
    );
  });
});
