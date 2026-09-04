import { OpenPoolClient, type OpenPoolFetch } from '@openpool/sdk';

import { HELP, parseArguments, type CliArguments } from './arguments.js';
import { CliFailure, safeError } from './errors.js';
import { checkOutput, downloadFile, uploadFile } from './local-files.js';
import { completion, metadata, protocol, reservation, uploadSummary } from './responses.js';

export interface CliRuntime {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly fetch?: OpenPoolFetch;
  readonly signal?: AbortSignal;
}

interface UploadContext {
  readonly phase: 'INSPECT' | 'RESERVE' | 'PUT' | 'COMPLETE';
  readonly bucketId?: string;
  readonly logicalKey?: string;
  readonly objectId?: string;
  readonly uploadSessionId?: string;
}

function recovery(phase: UploadContext['phase']): string {
  if (phase === 'RESERVE') return 'A reservation may exist. Inspect the logical key with list before repeating upload/retry.';
  if (phase === 'PUT') return 'Inspect upload-status. If PUT may have succeeded, try complete with this session first; otherwise explicitly retry.';
  if (phase === 'COMPLETE') return 'Retry complete with the same object/session before creating a replacement upload.';
  return 'Inspect the current upload session before attempting a replacement.';
}

export async function runCli(argv: readonly string[], runtime: CliRuntime = {}): Promise<number> {
  const env = runtime.env ?? process.env;
  const stdout = runtime.stdout ?? ((line: string) => { process.stdout.write(line); });
  const stderr = runtime.stderr ?? ((line: string) => { process.stderr.write(line); });
  const apiKey = env.OPENPOOL_API_KEY;
  const write = (target: (text: string) => void, value: unknown) => {
    let serialized = JSON.stringify(value);
    if (apiKey !== undefined && apiKey.length > 0) {
      serialized = serialized.replaceAll(JSON.stringify(apiKey).slice(1, -1), '[REDACTED]');
    }
    target(`${serialized}\n`);
  };
  let upload: UploadContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let signal: AbortSignal | undefined;
  try {
    const args = parseArguments(argv, env);
    if (args.command === 'help') { stdout(HELP); return 0; }
    if (apiKey === undefined || apiKey.length === 0) {
      throw new CliFailure('CONFIGURATION_ERROR', 'Set OPENPOOL_API_KEY to a restricted OpenPool API key.', 2);
    }
    const timeout = new AbortController();
    timer = setTimeout(() => timeout.abort(new CliFailure('TIMEOUT', 'The command timed out. Inspect upload state before retrying.', 124)), args.timeoutMs);
    signal = runtime.signal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, runtime.signal]);
    signal.throwIfAborted();
    let client: OpenPoolClient;
    try {
      const fetchImpl = runtime.fetch ?? globalThis.fetch.bind(globalThis);
      const controlOrigin = new URL(args.baseUrl).origin;
      client = new OpenPoolClient({ baseUrl: args.baseUrl, apiKey,
        // Reject control redirects too: never forward a credential through a redirect.
        fetch: async (input, init) => {
          const direct = init?.referrerPolicy === 'no-referrer';
          if (direct && new URL(String(input)).origin === controlOrigin) {
            throw new CliFailure('PROTOCOL_ERROR', 'A signed transfer must not target the control plane.');
          }
          const response = await fetchImpl(input, { ...init, redirect: 'error' });
          if (direct && (init?.method === 'PUT' || !response.ok)) {
            void response.body?.cancel().catch(() => undefined);
          }
          return response;
        },
      });
    } catch {
      throw new CliFailure('CONFIGURATION_ERROR', 'Use a root HTTPS base URL (loopback HTTP only) and a nonblank, unpadded API key.', 2);
    }
    const options = { signal };
    if (args.command === 'list') {
      const response = await client.listObjects(args.bucketId, args.query, options);
      if (!Array.isArray(response) || response.length > args.query.limit) protocol();
      const objects = response.map(metadata);
      if (objects.some((object) => object.logicalBucketId !== args.bucketId)) protocol();
      write(stdout, { data: objects, nextAfterKey: objects.length === args.query.limit ? objects.at(-1)?.logicalKey ?? null : null });
    } else if (args.command === 'stat' || args.command === 'delete') {
      const response = args.command === 'stat' ? await client.getObject(args.objectId, options) : await client.deleteObject(args.objectId, options);
      const object = metadata(response);
      if (object.id !== args.objectId || (args.command === 'delete' && object.status !== 'DELETED')) protocol();
      write(stdout, { data: object });
    } else if (args.command === 'upload-status') {
      write(stdout, { data: uploadSummary(await client.getUpload(args.objectId, options), args.objectId) });
    } else if (args.command === 'complete') {
      upload = { phase: 'COMPLETE', objectId: args.objectId, uploadSessionId: args.uploadSessionId };
      const result = completion(await client.completeUpload(args.objectId, { uploadSessionId: args.uploadSessionId }, options), args.objectId, args.uploadSessionId);
      write(stdout, { data: result });
    } else if (args.command === 'download') {
      const output = await checkOutput(args.output);
      const object = metadata(await client.getObject(args.objectId, options));
      if (object.id !== args.objectId) protocol();
      if (object.status !== 'READY') throw new CliFailure('OBJECT_INVALID_STATE', 'Only READY objects can be downloaded.');
      const result = await downloadFile(output, object.sizeBytes, async () => {
        const instruction = await client.createDownload(args.objectId, options);
        if (instruction?.objectId !== args.objectId || typeof instruction.downloadUrl !== 'string') protocol();
        return client.downloadDirect(instruction.downloadUrl, options);
      }, signal);
      write(stdout, { data: { objectId: object.id, output, ...result } });
    } else {
      await transferUpload(args, client, signal, (context) => { upload = context; },
        (value) => write(stderr, value), (value) => write(stdout, value));
    }
    return 0;
  } catch (caught) {
    const error = signal?.aborted
      ? signal.reason instanceof CliFailure ? signal.reason : new CliFailure('INTERRUPTED', 'The command was interrupted. Inspect upload state before retrying.', 130)
      : caught;
    write(stderr, { error: safeError(error), ...(upload === undefined ? {} : { upload, recovery: recovery(upload.phase) }) });
    return error instanceof CliFailure ? error.exitCode : 1;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function transferUpload(
  args: Extract<CliArguments, { command: 'upload' | 'retry' }>,
  client: OpenPoolClient,
  signal: AbortSignal,
  context: (value: UploadContext) => void,
  receipt: (value: unknown) => void,
  result: (value: unknown) => void,
): Promise<void> {
  const file = await uploadFile(args.file, args.contentType);
  signal.throwIfAborted();
  const options = { signal };
  const identity = { bucketId: args.bucketId, logicalKey: args.logicalKey };
  if (args.command === 'retry') {
    context({ ...identity, phase: 'INSPECT', objectId: args.objectId, uploadSessionId: args.uploadSessionId });
    const current = uploadSummary(await client.getUpload(args.objectId, options), args.objectId);
    if (current.uploadSessionId !== args.uploadSessionId) {
      throw new CliFailure('OBJECT_CONFLICT', 'The current session changed. Inspect upload-status; do not replace it blindly.');
    }
    if (current.status === 'COMPLETED') throw new CliFailure('OBJECT_INVALID_STATE', 'The current upload is already complete; it will not be replaced.');
  }
  context({ ...identity, phase: 'RESERVE', ...(args.command === 'retry' ? { objectId: args.objectId, uploadSessionId: args.uploadSessionId } : {}) });
  const instructions = reservation(await client.createUpload({
    ...identity, sizeBytes: file.size, contentType: args.contentType,
    ...(args.command === 'retry' ? { retryUploadSessionId: args.uploadSessionId } : {}),
  }, options));
  const saved = { ...identity, objectId: instructions.objectId, uploadSessionId: instructions.uploadSessionId };
  context({ ...saved, phase: 'PUT' });
  receipt({ event: 'upload-reserved', ...saved });
  if (args.command === 'retry' && (instructions.objectId !== args.objectId || instructions.uploadSessionId === args.uploadSessionId)) protocol();
  await client.uploadDirect(instructions.uploadUrl, file, args.contentType, options);
  context({ ...saved, phase: 'COMPLETE' });
  const completed = completion(await client.completeUpload(instructions.objectId, {
    uploadSessionId: instructions.uploadSessionId,
  }, options), instructions.objectId, instructions.uploadSessionId);
  if (completed.object.logicalBucketId !== args.bucketId || completed.object.logicalKey !== args.logicalKey ||
    completed.object.sizeBytes !== file.size || completed.object.contentType !== args.contentType) protocol();
  result({ data: completed });
}
