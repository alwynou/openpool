import { describe, expect, it } from 'vitest';

import {
  capacityPercent,
  formatBytes,
  providerLabel,
  statusTone,
} from './utils';

describe('web display utilities', () => {
  it('formats storage sizes without overstating precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
  });

  it('clamps capacity percentages to a safe visual range', () => {
    expect(capacityPercent(50, 100)).toBe(50);
    expect(capacityPercent(1, 0)).toBe(0);
    expect(capacityPercent(120, 100)).toBe(100);
  });

  it('maps provider kinds to administrator-facing names', () => {
    expect(providerLabel('r2')).toBe('Cloudflare R2');
    expect(providerLabel('b2')).toBe('Backblaze B2');
    expect(providerLabel('s3')).toBe('S3 Compatible');
  });

  it('uses color only for semantic warning and danger states', () => {
    expect(statusTone('ACTIVE')).toBe('neutral');
    expect(statusTone('VERIFYING')).toBe('warning');
    expect(statusTone('UNHEALTHY')).toBe('danger');
  });
});
