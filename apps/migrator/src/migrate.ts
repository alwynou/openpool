import { Readable } from 'node:stream';

const SESSION_COOKIE_ENV = 'OPENPOOL_SESSION_COOKIE';
const DEFAULT_TRANSFER_HEADERS = { accept: 'application/json' };

interface ApiEnvelope<T> {
  readonly data: T;
}

interface ApiFailure {
  readonly error?: { readonly code?: unknown };
}

export interface CliArguments {
  readonly baseUrl: string;
  readonly migrationId: string;
}

export interface TransferObject {
  readonly taskId: string;
  readonly objectId: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly downloadUrl: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
  readonly leaseToken: string;
}

interface MigrationProgress {
  readonly blocking: number;
}

interface MigrationState {
  readonly status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  readonly progress: MigrationProgress;
}

interface CompleteResult {
  readonly migrationCompleted: boolean;
}

export interface MigratorOptions {
  readonly baseUrl: string;
  readonly migrationId: string;
  readonly sessionCookie: string;
  readonly fetchImpl?: typeof fetch;
  readonly transferImpl?: (transfer: TransferObject) => Promise<void>;
  readonly waitImpl?: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly onObjectCompleted?: (objectId: string) => void;
}

export function parseCliArguments(argv: readonly string[]): CliArguments {
  let baseUrl: string | undefined;
  let migrationId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base-url') {
      baseUrl = argv[++index];
    } else if (argument === '--migration-id') {
      migrationId = argv[++index];
    } else if (argument === '--help') {
      throw new Error('Usage: openpool-migrator --base-url URL --migration-id ID');
    } else {
      throw new Error('Unknown or incomplete CLI argument.');
    }
  }
  if (!baseUrl || !migrationId) {
    throw new Error('Both --base-url and --migration-id are required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('The base URL is invalid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The base URL must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('The base URL must not contain credentials, query, or fragment.');
  }
  const localHttp =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new Error('Remote control-plane URLs must use HTTPS.');
  }
  return { baseUrl: parsed.toString().replace(/\/$/u, ''), migrationId };
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

function assertResponse(response: Response, operation: string): void {
  if (response.ok) return;
  throw new Error(`${operation} failed with HTTP ${response.status}.`);
}

async function json<T>(response: Response, operation: string): Promise<T> {
  assertResponse(response, operation);
  try {
    const payload = (await response.json()) as ApiEnvelope<T>;
    if (!payload || typeof payload !== 'object' || !('data' in payload)) {
      throw new Error('invalid response');
    }
    return payload.data;
  } catch {
    throw new Error(`${operation} returned an invalid response.`);
  }
}

async function apiErrorCode(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as ApiFailure;
    const code = payload.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

async function callJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  cookie: string,
  init: RequestInit,
  operation: string,
): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      ...DEFAULT_TRANSFER_HEADERS,
      cookie,
      ...init.headers,
    },
  });
  return json<T>(response, operation);
}

async function claim(
  options: Required<Pick<MigratorOptions, 'baseUrl' | 'migrationId' | 'sessionCookie'>> & {
    readonly fetchImpl: typeof fetch;
  },
): Promise<TransferObject | undefined> {
  const response = await options.fetchImpl(
    apiUrl(options.baseUrl, `/api/v1/shard-migrations/${encodeURIComponent(options.migrationId)}/transfers`),
    {
      method: 'POST',
      headers: { accept: 'application/json', cookie: options.sessionCookie },
    },
  );
  if (response.ok) return json<TransferObject>(response, 'Transfer claim');
  const code = await apiErrorCode(response);
  if (code === 'SHARD_MIGRATION_NO_TRANSFER_AVAILABLE') return undefined;
  throw new Error(`Transfer claim failed with HTTP ${response.status}.`);
}

async function migrationState(options: MigratorOptions, fetchImpl: typeof fetch): Promise<MigrationState> {
  return callJson<MigrationState>(
    fetchImpl,
    apiUrl(options.baseUrl, `/api/v1/shard-migrations/${encodeURIComponent(options.migrationId)}`),
    options.sessionCookie,
    { method: 'GET' },
    'Migration status',
  );
}

async function complete(
  options: MigratorOptions,
  transfer: TransferObject,
  fetchImpl: typeof fetch,
): Promise<CompleteResult> {
  return callJson<CompleteResult>(
    fetchImpl,
    apiUrl(options.baseUrl, `/api/v1/shard-migration-transfers/${encodeURIComponent(transfer.taskId)}/complete`),
    options.sessionCookie,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: transfer.leaseToken }),
    },
    'Transfer completion',
  );
}

/** Streams source GET into target PUT from the migrator process, never buffering object bytes. */
export async function streamTransfer(transfer: TransferObject, fetchImpl: typeof fetch = fetch): Promise<void> {
  const source = await fetchImpl(transfer.downloadUrl, { method: 'GET' });
  assertResponse(source, 'Source download');
  if (!source.body) throw new Error('Source download returned no body.');
  if (source.headers.has('content-length')) {
    const length = Number(source.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length !== transfer.sizeBytes) {
      throw new Error('Source download length did not match the migration metadata.');
    }
  }
  const body = Readable.fromWeb(
    source.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  );
  const target = await fetchImpl(transfer.uploadUrl, {
    method: 'PUT',
    headers: {
      'content-length': String(transfer.sizeBytes),
      'content-type': transfer.contentType,
    },
    // Node fetch requires duplex for a streaming request body; no object bytes are buffered.
    body,
    duplex: 'half',
  } as unknown as RequestInit & { duplex: 'half' });
  assertResponse(target, 'Target upload');
}

export async function migrate(options: MigratorOptions): Promise<void> {
  if (!/^openpool_session=[^;\s]+$/u.test(options.sessionCookie)) {
    throw new Error(
      `${SESSION_COOKIE_ENV} must contain only the openpool_session cookie pair.`,
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const transferImpl = options.transferImpl ?? ((item: TransferObject) => streamTransfer(item, fetchImpl));
  const waitImpl =
    options.waitImpl ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
    throw new Error('Migration poll interval must be at least 100 milliseconds.');
  }
  for (;;) {
    const item = await claim({
      baseUrl: options.baseUrl,
      migrationId: options.migrationId,
      sessionCookie: options.sessionCookie,
      fetchImpl,
    });
    if (!item) {
      const state = await migrationState(options, fetchImpl);
      if (state.status === 'COMPLETED') return;
      if (state.status === 'FAILED' || state.progress.blocking > 0) {
        throw new Error('Migration is blocked or failed.');
      }
      await waitImpl(pollIntervalMs);
      continue;
    }
    await transferImpl(item);
    const result = await complete(options, item, fetchImpl);
    options.onObjectCompleted?.(item.objectId);
    if (result.migrationCompleted) return;
  }
}

export async function runCli(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const arguments_ = parseCliArguments(argv);
  const sessionCookie = environment[SESSION_COOKIE_ENV];
  if (!sessionCookie) throw new Error(`${SESSION_COOKIE_ENV} is required.`);
  await migrate({ ...arguments_, sessionCookie });
}
