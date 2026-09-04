import { channel } from 'node:diagnostics_channel';
import { describe, expect, it, vi } from 'vitest';
import type { OpenPoolFetch } from '@openpool/sdk';

import { observe, type Observation } from '../src/smoke/observer.js';

const baseUrl = 'https://control.example';
const apiKey = 'opk_observer_test_key';
const controlHeaders = { authorization: `Bearer ${apiKey}` };
const directInit = {
  method: 'PUT', headers: { 'content-type': 'application/octet-stream' },
  credentials: 'omit' as const, referrerPolicy: 'no-referrer' as const, redirect: 'error' as const,
};

function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() - started >= timeoutMs) { reject(new Error('Timed out waiting for smoke observation.')); return; }
      setTimeout(poll, 2);
    };
    poll();
  });
}

function bodyBytes(body: Blob): Promise<Uint8Array> {
  return body.arrayBuffer().then((value) => new Uint8Array(value));
}

describe('smoke observer', () => {
  it('checks control/direct transport boundaries and emits no secrets or URLs', async () => {
    const emit = vi.fn<(event: Observation) => void>();
    const fetch = vi.fn<OpenPoolFetch>(async () => new Response(null));
    const wrapped = observe(fetch, baseUrl, apiKey, 'none', emit, vi.fn());
    const secretUrl = 'https://provider.example/upload?X-Amz-Signature=secret-value';
    await wrapped.fetch(`${baseUrl}/api/v1/health`, {
      method: 'POST', headers: controlHeaders, body: JSON.stringify({ safe: true }), redirect: 'error',
    });
    await wrapped.fetch(secretUrl, { ...directInit, body: new Blob(['abc']) });
    wrapped.stop();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'measurement', controlRequests: 1, puts: 1 }));
    const output = JSON.stringify(emit.mock.calls.map(([event]) => event));
    expect(output).not.toContain(secretUrl);
    expect(output).not.toContain('secret-value');
    expect(output).not.toContain(apiKey);
  });

  it('rejects missing credentials on control requests and auth/referrer on direct transfers', async () => {
    const fetch = vi.fn<OpenPoolFetch>(async () => new Response(null));
    const wrapped = observe(fetch, baseUrl, apiKey, 'none', vi.fn(), vi.fn());
    await expect(wrapped.fetch(`${baseUrl}/api/v1/health`, { method: 'GET', redirect: 'error' })).rejects.toThrow('Smoke transport boundary failed');
    await expect(wrapped.fetch('https://provider.example/object', {
      method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
      headers: { cookie: 'openpool_session=secret' },
    })).rejects.toThrow('Smoke transport boundary failed');
    wrapped.stop();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns a successful complete response into a safe completion-loss observation', async () => {
    const emit = vi.fn<(event: Observation) => void>();
    const interrupt = vi.fn();
    const fetch = vi.fn<OpenPoolFetch>(async () => new Response('provider response contains secret-value', { status: 200 }));
    const wrapped = observe(fetch, baseUrl, apiKey, 'complete-loss', emit, interrupt);
    await expect(wrapped.fetch(`${baseUrl}/api/v1/uploads/object-1/complete`, {
      method: 'POST', headers: controlHeaders, body: '{}', redirect: 'error',
    })).rejects.toThrow('Smoke completion response loss');
    wrapped.stop();

    expect(emit).toHaveBeenCalledWith({ type: 'complete-loss' });
    expect(interrupt).not.toHaveBeenCalled();
    expect(JSON.stringify(emit.mock.calls.map(([event]) => event))).not.toContain('secret-value');
  });

  it('paces only the fault upload while keeping the original Blob and exact bytes', async () => {
    const source = new Uint8Array(4097);
    for (let index = 0; index < source.length; index++) source[index] = index % 251;
    let sent: Uint8Array | undefined;
    let originalBody: Blob | undefined;
    const fetch = vi.fn<OpenPoolFetch>(async (_input, init) => {
      originalBody = init?.body as Blob;
      const reader = originalBody.stream().getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
      sent = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { sent.set(chunk, offset); offset += chunk.byteLength; }
      return new Response(null);
    });
    const wrapped = observe(fetch, baseUrl, apiKey, 'upload-interrupt', vi.fn(), vi.fn());
    const body = new Blob([source]);
    await wrapped.fetch('https://provider.example/upload', { ...directInit, body });
    wrapped.stop();

    expect(originalBody).toBe(body);
    expect(originalBody).toBeInstanceOf(Blob);
    expect(sent).toEqual(source);
    expect(await bodyBytes(body)).toEqual(source);
  });

  it('interrupts after positive diagnostic socket progress and before bodySent', async () => {
    const emit = vi.fn<(event: Observation) => void>();
    const interrupt = vi.fn();
    const request = { method: 'PUT', origin: 'https://provider.example' };
    const headers = 'PUT /upload HTTP/1.1\r\ncontent-length: 8000000\r\n';
    const socket = { bytesWritten: 0, destroyed: false };
    const fetch = vi.fn<OpenPoolFetch>(async () => {
      channel('undici:client:sendHeaders').publish({ request, headers, socket });
      setTimeout(() => { socket.bytesWritten = Buffer.byteLength(headers) + 1_200_000; }, 8);
      return new Response(null);
    });
    const wrapped = observe(fetch, baseUrl, apiKey, 'upload-interrupt', emit, interrupt);
    await wrapped.fetch('https://provider.example/upload', {
      ...directInit, body: new Blob([new Uint8Array(8_000_000)]),
    });
    await waitFor(() => interrupt.mock.calls.length === 1);
    wrapped.stop();

    expect(emit).toHaveBeenCalledWith({ type: 'interruption', direction: 'upload', bytes: 1_200_000, totalBytes: 8_000_000 });
    expect(emit.mock.calls.some(([event]) => event.type === 'interruption' && event.bytes > 0 && event.bytes < event.totalBytes)).toBe(true);
  });

  it('does not claim an interruption after the bodySent diagnostic', async () => {
    const emit = vi.fn<(event: Observation) => void>();
    const interrupt = vi.fn();
    const request = { method: 'PUT', origin: 'https://provider.example' };
    const headers = 'PUT /upload HTTP/1.1\r\ncontent-length: 8000000\r\n';
    const socket = { bytesWritten: 0, destroyed: false };
    const fetch = vi.fn<OpenPoolFetch>(async (_input, _init) => {
      channel('undici:client:sendHeaders').publish({ request, headers, socket });
      channel('undici:request:bodySent').publish({ request });
      socket.bytesWritten = Buffer.byteLength(headers) + 1_200_000;
      return new Response(null);
    });
    const wrapped = observe(fetch, baseUrl, apiKey, 'upload-interrupt', emit, interrupt);
    await wrapped.fetch('https://provider.example/upload', {
      ...directInit, body: new Blob([new Uint8Array(8_000_000)]),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    wrapped.stop();

    expect(interrupt).not.toHaveBeenCalled();
    expect(emit.mock.calls.some(([event]) => event.type === 'interruption')).toBe(false);
  });

  it('reports a short received download body and interrupts only after bytes arrive', async () => {
    const emit = vi.fn<(event: Observation) => void>();
    const interrupt = vi.fn();
    const partial = new Uint8Array(2_000_000);
    const fetch = vi.fn<OpenPoolFetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(partial); controller.close(); },
    }), { status: 200, headers: { 'content-length': '8000000' } }));
    const wrapped = observe(fetch, baseUrl, apiKey, 'download-interrupt', emit, interrupt);
    const response = await wrapped.fetch('https://provider.example/download', {
      method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    await waitFor(() => interrupt.mock.calls.length === 1);
    await reader?.cancel();
    wrapped.stop();

    expect(first?.value?.byteLength).toBe(2_000_000);
    expect(emit).toHaveBeenCalledWith({ type: 'interruption', direction: 'download', bytes: 2_000_000, totalBytes: 8_000_000 });
  });

  it('unsubscribes diagnostics and stops sampling after stop', async () => {
    const emit = vi.fn<(event: Observation) => void>();
    const interrupt = vi.fn();
    const wrapped = observe(vi.fn<OpenPoolFetch>(async () => new Response(null)), baseUrl, apiKey, 'upload-interrupt', emit, interrupt);
    wrapped.stop();
    const request = { method: 'PUT', origin: 'https://provider.example' };
    const socket = { bytesWritten: 2_000_000, destroyed: false };
    channel('undici:client:sendHeaders').publish({ request, headers: 'PUT / HTTP/1.1\r\n', socket });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupt).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ type: 'measurement' });
  });
});
