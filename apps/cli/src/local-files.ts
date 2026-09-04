import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { link, lstat, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { CliFailure } from './errors.js';

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function uploadFile(path: string, contentType: string): Promise<Blob> {
  try {
    if (!(await stat(path)).isFile()) throw new Error('Not a regular file');
    // File-backed Blob streams on demand; Node detects changes while it is read.
    const file = await openAsBlob(path, { type: contentType });
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid size');
    return file;
  } catch {
    throw new CliFailure('INPUT_FILE_UNAVAILABLE', 'The input must be a readable regular file with a safe byte size.');
  }
}

export async function checkOutput(path: string): Promise<string> {
  const output = resolve(path);
  try {
    await lstat(output);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return output;
    throw new CliFailure('OUTPUT_UNAVAILABLE', 'Cannot access the requested output location.');
  }
  throw new CliFailure('OUTPUT_EXISTS', 'The output already exists. Choose a new path; existing files are never overwritten.');
}

export async function downloadFile(
  output: string,
  expectedBytes: number,
  getResponse: () => Promise<Response>,
  signal: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
  await checkOutput(output);
  let directory: string;
  try {
    directory = await mkdtemp(join(dirname(output), '.openpool-download-'));
  } catch {
    throw new CliFailure('OUTPUT_UNAVAILABLE', 'The output parent directory must exist and be writable.');
  }
  const partial = join(directory, 'content');
  try {
    const response = await getResponse();
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      throw new CliFailure('INVALID_DOWNLOAD_RESPONSE', 'Expected a complete provider response, not a partial download.');
    }
    const reader = response.body?.getReader();
    const cancel = () => { void reader?.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    let file;
    let bytes = 0;
    const hash = createHash('sha256');
    try {
      signal.throwIfAborted();
      file = await open(partial, 'wx', 0o600);
      if (reader !== undefined) {
        while (true) {
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > expectedBytes) throw new CliFailure('DOWNLOAD_SIZE_MISMATCH', 'Downloaded bytes do not match the reserved object size.');
          hash.update(chunk.value);
          let offset = 0;
          while (offset < chunk.value.byteLength) {
            const result = await file.write(chunk.value, offset, chunk.value.byteLength - offset);
            if (result.bytesWritten === 0) throw new CliFailure('OUTPUT_UNAVAILABLE', 'Unable to write the downloaded file.');
            offset += result.bytesWritten;
          }
        }
      }
      if (bytes !== expectedBytes) throw new CliFailure('DOWNLOAD_SIZE_MISMATCH', 'Downloaded bytes do not match the reserved object size.');
      signal.throwIfAborted();
      await file.sync();
    } finally {
      signal.removeEventListener('abort', cancel);
      cancel();
      await file?.close();
    }
    signal.throwIfAborted();
    try {
      // Same-filesystem hard link atomically publishes without replacing even a
      // concurrently created file, directory or symlink at the destination.
      await link(partial, output);
    } catch (error) {
      if (hasCode(error, 'EEXIST')) throw new CliFailure('OUTPUT_EXISTS', 'The output was created concurrently; it has not been overwritten.');
      throw new CliFailure('OUTPUT_UNAVAILABLE', 'Unable to publish the downloaded file without overwriting.');
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    // This directory was created by this invocation, never supplied by the user.
    await rm(directory, { recursive: true, force: true });
  }
}
