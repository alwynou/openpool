import { parseArgs } from 'node:util';
import type { ListObjectsQuery } from '@openpool/sdk';

import { CliFailure } from './errors.js';

interface CommonArguments {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}
interface UploadArguments {
  readonly bucketId: string;
  readonly logicalKey: string;
  readonly file: string;
  readonly contentType: string;
}
export type CliArguments = { readonly command: 'help' } | (CommonArguments & (
  | { readonly command: 'list'; readonly bucketId: string; readonly query: ListObjectsQuery & { limit: number } }
  | { readonly command: 'stat'; readonly objectId: string }
  | { readonly command: 'delete'; readonly objectId: string }
  | { readonly command: 'upload-status'; readonly objectId: string }
  | { readonly command: 'complete'; readonly objectId: string; readonly uploadSessionId: string }
  | { readonly command: 'download'; readonly objectId: string; readonly output: string }
  | ({ readonly command: 'upload' } & UploadArguments)
  | ({ readonly command: 'retry'; readonly objectId: string; readonly uploadSessionId: string } & UploadArguments)
));

export const HELP = `OpenPool object CLI (workspace-private, Node.js 22+)

Usage: openpool <command> [options]

  list          --bucket ID [--prefix KEY] [--after-key KEY] [--limit 1..1000] [--status STATUS]
  stat          --object ID
  upload        --bucket ID --key KEY --file PATH [--content-type TYPE]
  upload-status --object ID
  complete      --object ID --session ID
  retry         --object ID --session ID --bucket ID --key KEY --file PATH [--content-type TYPE]
  download      --object ID --output PATH
  delete        --object ID

Common: --base-url URL (or OPENPOOL_BASE_URL), --timeout-ms MS (default 300000), --help
Authentication: OPENPOOL_API_KEY environment variable only. Never pass secrets as arguments.
Results: JSON on stdout; errors and upload reservation receipts: JSON on stderr.
List returns one page (default 100); nextAfterKey is a continuation hint, not a snapshot.
No automatic retries, remote overwrite, local overwrite, admin login or credential storage.
Use complete with the same session if PUT succeeded but its completion response was lost.
retry requires the expected current session and creates a new physical upload attempt.
Exit codes: 0 success, 1 operation failed, 2 usage/configuration, 124 timeout, 130/143 signal.
`;

const commandOptions = {
  list: ['bucket', 'prefix', 'after-key', 'limit', 'status'],
  stat: ['object'],
  delete: ['object'],
  'upload-status': ['object'],
  complete: ['object', 'session'],
  download: ['object', 'output'],
  upload: ['bucket', 'key', 'file', 'content-type'],
  retry: ['object', 'session', 'bucket', 'key', 'file', 'content-type'],
} as const;

function usage(message: string): never {
  throw new CliFailure('USAGE_ERROR', message, 2);
}

function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function parseArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): CliArguments {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv], allowPositionals: true, strict: true, tokens: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        'base-url': { type: 'string' }, 'timeout-ms': { type: 'string' },
        bucket: { type: 'string' }, object: { type: 'string' }, session: { type: 'string' },
        key: { type: 'string' }, file: { type: 'string' }, output: { type: 'string' },
        'content-type': { type: 'string' }, prefix: { type: 'string' },
        'after-key': { type: 'string' }, limit: { type: 'string' }, status: { type: 'string' },
      },
    });
  } catch {
    usage('Invalid arguments. Run openpool --help. Secrets are accepted only through the environment.');
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) usage('Duplicate options are not allowed.');
    seen.add(token.name);
  }
  if (parsed.positionals.length > 1) usage('Only one command is allowed; use named options for its arguments.');
  if (argv.length === 0 || parsed.values.help || parsed.positionals[0] === 'help') return { command: 'help' };
  const command = parsed.positionals[0];
  if (command === undefined || !Object.hasOwn(commandOptions, command)) usage('Unknown or missing command. Run openpool --help.');
  const allowed: readonly string[] = commandOptions[command as keyof typeof commandOptions];
  for (const key of seen) {
    if (!['base-url', 'timeout-ms'].includes(key) && !allowed.includes(key)) usage('An option does not apply to this command.');
  }
  const values = parsed.values;
  const required = (name: keyof typeof values): string => {
    const value = values[name];
    if (typeof value !== 'string' || value.length === 0) usage('A required option is missing or empty. Run openpool --help.');
    return value;
  };
  const identity = (name: 'bucket' | 'object' | 'session'): string => {
    const value = required(name);
    if (value.trim() !== value || value.length > 128 || containsControlCharacters(value)) usage('Invalid resource identifier.');
    return value;
  };
  const number = (value: string | undefined, fallback: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!/^\d+$/u.test(value)) usage('Numeric options must be positive decimal integers.');
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1 || result > max) usage('Numeric option is out of range.');
    return result;
  };
  const baseUrl = values['base-url'] ?? env.OPENPOOL_BASE_URL;
  if (baseUrl === undefined || baseUrl.length === 0) usage('Set OPENPOOL_BASE_URL or provide --base-url.');
  const common = { baseUrl, timeoutMs: number(values['timeout-ms'], 300_000, 86_400_000) };
  if (command === 'list') {
    const query: ListObjectsQuery & { limit: number } = { limit: number(values.limit, 100, 1000) };
    if (values.status !== undefined) {
      if (!['PENDING', 'READY', 'DELETING', 'DELETED'].includes(values.status)) usage('Invalid object status.');
    }
    for (const value of [values.prefix, values['after-key']]) {
      if (value !== undefined && value.length > 1024) usage('Prefix or cursor is too long.');
    }
    return { ...common, command, bucketId: identity('bucket'), query: {
      ...query,
      ...(values.status === undefined ? {} : { status: values.status as ListObjectsQuery['status'] & string }),
      ...(values.prefix === undefined ? {} : { prefix: values.prefix }),
      ...(values['after-key'] === undefined ? {} : { afterKey: values['after-key'] }),
    } };
  }
  if (command === 'stat' || command === 'delete' || command === 'upload-status') {
    return { ...common, command, objectId: identity('object') };
  }
  if (command === 'complete') return { ...common, command, objectId: identity('object'), uploadSessionId: identity('session') };
  if (command === 'download') return { ...common, command, objectId: identity('object'), output: required('output') };
  const logicalKey = required('key');
  if (logicalKey.trim().length === 0 || logicalKey.length > 1024 || containsControlCharacters(logicalKey)) usage('Invalid logical key.');
  const contentType = values['content-type'] ?? 'application/octet-stream';
  if (contentType.length === 0 || contentType.trim() !== contentType || contentType.length > 255 || /[^\x20-\x7e]/u.test(contentType)) usage('Invalid content type.');
  const upload = { ...common, bucketId: identity('bucket'), logicalKey, file: required('file'), contentType };
  if (command === 'upload') return { ...upload, command };
  return { ...upload, command: 'retry', objectId: identity('object'), uploadSessionId: identity('session') };
}
