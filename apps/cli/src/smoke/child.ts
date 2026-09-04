import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliFailure } from '../errors.js';
import type { Fault } from './observer.js';
import { parseObservation, type Observation } from './observations.js';
import type { SmokeOptions } from './options.js';

export interface CommandResult { code: number | null; output: unknown; events: unknown[]; observations: Observation[]; elapsedMs: number; }
export type Command = (args: readonly string[], fault?: Fault, signal?: AbortSignal) => Promise<CommandResult>;

export function commandFor(options: SmokeOptions, onReceipt: (receipt: unknown) => void): Command {
  return (args, fault = 'none', signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CliFailure('SMOKE_INTERRUPTED', 'Smoke was interrupted.', 130)); return; }
    const started = performance.now();
    const child = fork(fileURLToPath(new URL('./cli.js', import.meta.url)), [...args], {
      execArgv: ['--import', fileURLToPath(new URL('./smoke-observer.js', import.meta.url))],
      env: { OPENPOOL_BASE_URL: options.baseUrl, OPENPOOL_API_KEY: options.apiKey,
        OPENPOOL_SMOKE_OBSERVER: '1', OPENPOOL_SMOKE_FAULT: fault },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '', stderr = '', pending = '';
    const observations: Observation[] = [];
    let overflow = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill('SIGINT');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    const deadline = setTimeout(abort, 310000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length + chunk.length > 1024 * 1024) { overflow = true; abort(); return; }
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length + chunk.length > 1024 * 1024) { overflow = true; abort(); return; }
      stderr += chunk; pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) {
        try { const data: unknown = JSON.parse(line); onReceipt(data); } catch { /* Validate final output below. */ }
      }
    });
    child.on('message', (message: unknown) => {
      try {
        const observation = parseObservation(message);
        if (observations.length < 32) observations.push(observation);
        else { overflow = true; abort(); }
      } catch {
        // Never retain or expose invalid IPC data; stop the child and reject it safely on close.
        overflow = true; abort();
      }
    });
    const dispose = () => { clearTimeout(deadline); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.on('error', () => { dispose(); reject(new CliFailure('SMOKE_CHILD_FAILED', 'Unable to run the built CLI. Build the workspace first.')); });
    child.on('close', (code) => {
      dispose();
      try {
        const text = stdout + stderr;
        if (overflow || text.includes(options.apiKey) || /X-Amz-|https:\/\/|openpool_session=|Bearer /iu.test(text)) throw new Error();
        resolve({ code, output: stdout.trim() ? JSON.parse(stdout) as unknown : null,
          events: stderr.trim() ? stderr.trim().split('\n').map((line) => JSON.parse(line) as unknown) : [], observations,
          elapsedMs: Math.round(performance.now() - started) });
      } catch { reject(new CliFailure('SMOKE_UNSAFE_OUTPUT', 'CLI output was invalid, too large, or contained sensitive data; raw output was discarded.')); }
    });
  });
}
