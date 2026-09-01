import { describe, expect, it, vi } from 'vitest';

import {
  migrate,
  parseCliArguments,
  streamTransfer,
  type TransferObject,
} from '../src/migrate.js';

const transfer = (id: string): TransferObject => ({
  taskId: `task-${id}`,
  objectId: `object-${id}`,
  sizeBytes: 3,
  contentType: 'text/plain',
  downloadUrl: `https://source.example/${id}`,
  uploadUrl: `https://target.example/${id}`,
  expiresAt: '2026-01-01T00:15:00.000Z',
  leaseToken: `secret-${id}`,
});

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(code: string, message = 'secret error detail'): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status: 409,
    headers: { 'content-type': 'application/json' },
  });
}

describe('openpool migrator', () => {
  it('requires only the documented CLI arguments', () => {
    expect(parseCliArguments(['--base-url', 'https://openpool.example/', '--migration-id', 'm-1'])).toEqual({
      baseUrl: 'https://openpool.example',
      migrationId: 'm-1',
    });
    expect(() => parseCliArguments(['--base-url', 'https://example.test', '--cookie', 'secret'])).toThrow();
    expect(() => parseCliArguments(['--base-url', 'https://example.test'])).toThrow();
    expect(() =>
      parseCliArguments([
        '--base-url',
        'http://openpool.example',
        '--migration-id',
        'm-1',
      ]),
    ).toThrow('HTTPS');
  });

  it('claims, transfers, and completes multiple objects without logging secrets', async () => {
    const first = transfer('1');
    const second = transfer('2');
    const responses = [
      envelope(first),
      envelope({ taskId: first.taskId, status: 'COMPLETED', migrationCompleted: false }),
      envelope(second),
      envelope({ taskId: second.taskId, status: 'COMPLETED', migrationCompleted: true }),
    ];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/transfers') || url.includes('/complete')) {
        return responses.shift() ?? new Response('{}', { status: 500 });
      }
      return new Response('{}', { status: 500 });
    });
    const transferImpl = vi.fn(async (_item: TransferObject) => undefined);
    const completed: string[] = [];
    await migrate({
      baseUrl: 'https://openpool.example',
      migrationId: 'migration-1',
      sessionCookie: 'openpool_session=secret-cookie',
      fetchImpl,
      transferImpl,
      onObjectCompleted: (id) => completed.push(id),
    });
    expect(transferImpl).toHaveBeenCalledTimes(2);
    expect(completed).toEqual(['object-1', 'object-2']);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).not.toContain('secret');
      expect(JSON.stringify(call[1])).toContain('openpool_session=secret-cookie');
    }
  });

  it('reads status after no transfer and reports a blocked migration', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/transfers')
        ? errorResponse('SHARD_MIGRATION_NO_TRANSFER_AVAILABLE')
        : envelope({ status: 'RUNNING', progress: { blocking: 1 } }),
    );
    await expect(
      migrate({
        baseUrl: 'https://openpool.example',
        migrationId: 'migration-1',
        sessionCookie: 'openpool_session=cookie',
        fetchImpl,
      }),
    ).rejects.toThrow('blocked or failed');
  });

  it('finishes when no transfer reports an already completed migration', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/transfers')
        ? errorResponse('SHARD_MIGRATION_NO_TRANSFER_AVAILABLE')
        : envelope({ status: 'COMPLETED', progress: { blocking: 0 } }),
    );
    await migrate({
      baseUrl: 'https://openpool.example',
      migrationId: 'migration-1',
      sessionCookie: 'openpool_session=cookie',
      fetchImpl,
    });
  });

  it('waits and retries while another runner owns the available transfer', async () => {
    const item = transfer('retry');
    const responses = [
      errorResponse('SHARD_MIGRATION_NO_TRANSFER_AVAILABLE'),
      envelope({ status: 'RUNNING', progress: { blocking: 0 } }),
      envelope(item),
      envelope({ migrationCompleted: true }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() ?? new Response('{}'));
    const waitImpl = vi.fn(async () => undefined);
    await migrate({
      baseUrl: 'https://openpool.example',
      migrationId: 'migration-1',
      sessionCookie: 'openpool_session=cookie',
      fetchImpl,
      transferImpl: vi.fn(async () => undefined),
      waitImpl,
    });
    expect(waitImpl).toHaveBeenCalledWith(1_000);
  });

  it('fails without exposing API error messages or secrets', async () => {
    const fetchImpl = vi.fn(async () => errorResponse('PROVIDER_FORBIDDEN', 'provider-secret-url'));
    await expect(
      migrate({
        baseUrl: 'https://openpool.example',
        migrationId: 'migration-1',
        sessionCookie: 'openpool_session=cookie',
        fetchImpl,
      }),
    ).rejects.toThrow('HTTP 409');
    await expect(
      migrate({
        baseUrl: 'https://openpool.example',
        migrationId: 'migration-1',
        sessionCookie: '',
        fetchImpl,
      }),
    ).rejects.toThrow('OPENPOOL_SESSION_COOKIE');
  });

  it('streams source body and sets exact target headers', async () => {
    const item = transfer('stream');
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === item.downloadUrl) {
        return new Response(new Blob(['abc'], { type: item.contentType }), {
          status: 200,
          headers: { 'content-length': String(item.sizeBytes) },
        });
      }
      expect(init?.method).toBe('PUT');
      expect(new Headers(init?.headers).get('content-length')).toBe(String(item.sizeBytes));
      expect(new Headers(init?.headers).get('content-type')).toBe(item.contentType);
      expect(init?.body).toBeDefined();
      return new Response(null, { status: 200 });
    });
    await streamTransfer(item, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
