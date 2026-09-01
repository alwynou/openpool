import type { StorageProviderKind } from '@openpool/contracts';
import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { ApiClientError } from '../api';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';
}

export function errorRequestId(error: unknown): string | null {
  return error instanceof ApiClientError ? error.requestId : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function relativeDate(value: string | null): string {
  if (!value) return 'Not checked';
  const difference = new Date(value).getTime() - Date.now();
  const absolute = Math.abs(difference);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (absolute < 60_000) return formatter.format(Math.round(difference / 1000), 'second');
  if (absolute < 3_600_000) return formatter.format(Math.round(difference / 60_000), 'minute');
  if (absolute < 86_400_000) return formatter.format(Math.round(difference / 3_600_000), 'hour');
  return formatter.format(Math.round(difference / 86_400_000), 'day');
}

export function capacityPercent(usedBytes: number, capacityBytes: number): number {
  if (capacityBytes <= 0) return 0;
  return Math.min(100, Math.max(0, (usedBytes / capacityBytes) * 100));
}

export function providerLabel(provider: StorageProviderKind): string {
  if (provider === 'r2') return 'Cloudflare R2';
  if (provider === 'b2') return 'Backblaze B2';
  return 'S3 Compatible';
}

export type StatusTone = 'neutral' | 'warning' | 'danger';

export function statusTone(value: string): StatusTone {
  if (/VERIFYING|STANDBY|UNKNOWN|ESTIMATED|DEGRADED/u.test(value)) return 'warning';
  if (/UNHEALTHY|REMOVED|REVOKED|EXPIRED|DELETED/u.test(value)) return 'danger';
  return 'neutral';
}
