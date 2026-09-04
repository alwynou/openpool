import { parseArgs } from 'node:util';
import { OpenPoolClient } from '@openpool/sdk';
import { CliFailure } from '../errors.js';

export const SMOKE_HELP = `OpenPool opt-in staging CLI smoke (Node.js 22+)
Usage: npm run smoke:cli -- --allow-remote-writes --bucket ID [--base-url URL]
       [--prefix cli-smoke/] [--size-mb 1..50]
Requires OPENPOOL_BASE_URL and OPENPOOL_API_KEY (list/read/upload/delete scopes).
Only staging is accepted. Default size: 50 MB = 50,000,000 bytes.
Creates isolated test objects, interrupts transfers, explicitly retries, and deletes
only this run's completed objects. Pending attempts require normal server cleanup.
Provider historical versions and API key revocation remain the operator's job.
JSON report is retained in a new private temporary directory; never stores secrets.
No deployment, migrations, admin login, credentials files or automatic reruns.
`;

export interface SmokeOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly bucketId: string;
  readonly prefix: string;
  readonly sizeBytes: number;
}

export function smokeOptions(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): SmokeOptions | undefined {
  if (argv.length === 0 || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0] ?? ''))) return undefined;
  try {
    const parsed = parseArgs({ args: [...argv], strict: true, allowPositionals: false, tokens: true, options: {
      'allow-remote-writes': { type: 'boolean' }, 'base-url': { type: 'string' }, bucket: { type: 'string' },
      prefix: { type: 'string' }, 'size-mb': { type: 'string' },
    } });
    const names = parsed.tokens.filter((token) => token.kind === 'option').map((token) => token.name);
    if (new Set(names).size !== names.length || parsed.values['allow-remote-writes'] !== true) throw new Error();
    const baseUrl = parsed.values['base-url'] ?? env.OPENPOOL_BASE_URL;
    const apiKey = env.OPENPOOL_API_KEY;
    const bucketId = parsed.values.bucket;
    const prefix = parsed.values.prefix ?? 'cli-smoke/';
    const size = parsed.values['size-mb'] ?? '50';
    if (!baseUrl || !apiKey || !bucketId || bucketId.length > 128 || bucketId.trim() !== bucketId ||
      [...bucketId].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}\/$/u.test(prefix) || prefix.split('/').some((part) => part === '.' || part === '..')) throw new Error();
    if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(size)) throw new Error();
    if ([baseUrl, bucketId, prefix].some((value) => value.includes(apiKey))) throw new Error();
    new OpenPoolClient({ baseUrl, apiKey });
    return { baseUrl, apiKey, bucketId, prefix, sizeBytes: Number(size) * 1_000_000 };
  } catch {
    throw new CliFailure('SMOKE_CONFIGURATION_ERROR', 'Explicit write opt-in, a root HTTPS URL (loopback HTTP only), environment API key, bucket, safe directory prefix and size 1..50 MB are required.', 2);
  }
}
