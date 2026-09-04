import { channel } from 'node:diagnostics_channel';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { OpenPoolFetch } from '@openpool/sdk';

export type Fault = 'none' | 'upload-interrupt' | 'download-interrupt' | 'complete-loss';
export interface Measurement {
  type: 'measurement'; startRssBytes: number; peakRssBytes: number;
  controlRequests: number; maxControlBodyBytes: number; puts: number; gets: number;
}
export interface Interruption { type: 'interruption'; direction: 'upload' | 'download'; bytes: number; totalBytes: number; }
export type Observation = Measurement | Interruption | { type: 'complete-loss' };

/** Observes CLI fetches; only fault modes pace/intercept a transfer. Never emits URLs/headers. */
export function observe(fetch: OpenPoolFetch, baseUrl: string, apiKey: string, fault: Fault,
  emit: (event: Observation) => void, interrupt: () => void): { fetch: OpenPoolFetch; stop: () => void } {
  const origin = new URL(baseUrl).origin;
  const startRssBytes = process.memoryUsage.rss();
  const measurements: Measurement = { type: 'measurement', startRssBytes, peakRssBytes: startRssBytes, controlRequests: 0, maxControlBodyBytes: 0, puts: 0, gets: 0 };
  const sample = () => { measurements.peakRssBytes = Math.max(measurements.peakRssBytes, process.memoryUsage.rss()); };
  const sampler = setInterval(sample, 25); sampler.unref();
  let fired = false;
  let uploadSize = 0;
  let requestRef: unknown;
  let fullySent = false;
  let socketPoll: ReturnType<typeof setInterval> | undefined;
  const trigger = (direction: 'upload' | 'download', bytes: number, totalBytes: number) => {
    if (!fired && bytes >= Math.min(1_000_000, Math.floor(totalBytes / 4)) && bytes < totalBytes) {
      fired = true; emit({ type: 'interruption', direction, bytes, totalBytes }); interrupt();
    }
  };
  const onHeaders = (message: unknown) => {
    // Undici diagnostic callbacks must never throw. Metadata is retained only in this closure.
    try {
      const { request, headers, socket } = message as { request: { method: string; origin: string }; headers: string; socket: Socket };
      if (fault !== 'upload-interrupt' || uploadSize === 0 || request.method !== 'PUT' || new URL(request.origin).origin === origin) return;
      requestRef = request;
      const initial = socket.bytesWritten;
      const headerBytes = Buffer.byteLength(headers);
      socketPoll = setInterval(() => {
        if (!fullySent && !socket.destroyed) trigger('upload', Math.max(0, socket.bytesWritten - initial - headerBytes), uploadSize);
      }, 2);
      socketPoll.unref();
    } catch { /* A missing diagnostic prevents an interruption pass; never invent evidence. */ }
  };
  const onBodySent = (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'request' in message && message.request === requestRef) fullySent = true;
  };
  channel('undici:client:sendHeaders').subscribe(onHeaders);
  channel('undici:request:bodySent').subscribe(onBodySent);
  const checkedFetch: OpenPoolFetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const check = (condition: boolean) => { if (!condition) throw new Error('Smoke transport boundary failed'); };
    check(init?.redirect === 'error');
    if (url.origin === origin) {
      check(headers.get('authorization') === `Bearer ${apiKey}` && !headers.has('cookie'));
      check(init?.body === undefined || (typeof init.body === 'string' && Buffer.byteLength(init.body) <= 65536));
      measurements.controlRequests++;
      measurements.maxControlBodyBytes = Math.max(measurements.maxControlBodyBytes, typeof init?.body === 'string' ? Buffer.byteLength(init.body) : 0);
      const response = await fetch(input, init);
      if (fault === 'complete-loss' && !fired && method === 'POST' && url.pathname.endsWith('/complete') && response.ok) {
        fired = true; await response.arrayBuffer(); emit({ type: 'complete-loss' }); throw new Error('Smoke completion response loss');
      }
      return response;
    }
    check(url.protocol === 'https:' && !headers.has('authorization') && !headers.has('cookie') && init?.credentials === 'omit' && init.referrerPolicy === 'no-referrer');
    if (method === 'PUT') {
      measurements.puts++;
      if (fault === 'upload-interrupt' && init?.body instanceof Blob) {
        const blob = init.body;
        uploadSize = blob.size;
        const stream = blob.stream.bind(blob);
        // Keep the original file-backed Blob and signed size. Pacing only this fault
        // lets a real partial socket write be observed before SIGINT, even on LANs.
        Object.defineProperty(blob, 'stream', { value: () => {
          const reader = stream().getReader();
          return new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                await delay(10, undefined, { ...(init.signal ? { signal: init.signal } : {}) });
                const chunk = await reader.read();
                if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
              } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
            },
            cancel: (reason) => reader.cancel(reason),
          });
        } });
      }
    } else if (method === 'GET') measurements.gets++;
    const response = await fetch(input, init);
    if (method !== 'GET' || fault !== 'download-interrupt' || !response.ok || response.body === null) return response;
    const reader = response.body.getReader();
    const total = Number(response.headers.get('content-length'));
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else { bytes += chunk.value.byteLength; controller.enqueue(chunk.value); trigger('download', bytes, total); }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  return { fetch: checkedFetch, stop() {
    clearInterval(sampler); clearInterval(socketPoll); sample();
    channel('undici:client:sendHeaders').unsubscribe(onHeaders);
    channel('undici:request:bodySent').unsubscribe(onBodySent);
    emit(measurements);
  } };
}

if (process.env.OPENPOOL_SMOKE_OBSERVER === '1' && process.send !== undefined) {
  const fault = process.env.OPENPOOL_SMOKE_FAULT as Fault;
  if (['none', 'upload-interrupt', 'download-interrupt', 'complete-loss'].includes(fault)) {
    const observer = observe(globalThis.fetch.bind(globalThis), process.env.OPENPOOL_BASE_URL ?? '', process.env.OPENPOOL_API_KEY ?? '', fault,
      (event) => {
        if (process.connected) {
          try { process.send?.(event, () => undefined); } catch { /* Closed IPC fails evidence checks in the parent. */ }
        }
      }, () => { process.kill(process.pid, 'SIGINT'); });
    globalThis.fetch = observer.fetch;
    process.once('beforeExit', () => observer.stop());
  }
}
