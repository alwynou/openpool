import { describe, expect, it } from 'vitest';

import { CliFailure } from '../src/errors.js';
import { SMOKE_HELP, smokeOptions } from '../src/smoke/options.js';

const baseEnv = {
  OPENPOOL_BASE_URL: 'https://staging.example',
  OPENPOOL_API_KEY: 'opk_smoke_test_key',
};

function parse(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = baseEnv) {
  return smokeOptions(argv, env);
}

function expectRejected(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = baseEnv, label = argv.join(' ')): void {
  let caught: unknown;
  try { parse(argv, env); } catch (error) { caught = error; }
  expect(caught, label).toBeInstanceOf(CliFailure);
  expect(caught, label).toMatchObject({ code: 'SMOKE_CONFIGURATION_ERROR', exitCode: 2 });
}

describe('smokeOptions', () => {
  it.each([{ argv: [] }, { argv: ['help'] }, { argv: ['--help'] }, { argv: ['-h'] }])('returns help for $argv without credentials', ({ argv }) => {
    expect(parse(argv, {})).toBeUndefined();
  });

  it('documents the explicit opt-in, 50 MB decimal default and safe cleanup boundary', () => {
    expect(SMOKE_HELP).toContain('--allow-remote-writes');
    expect(SMOKE_HELP).toContain('50 MB = 50,000,000 bytes');
    expect(SMOKE_HELP).toContain('never stores secrets');
    expect(SMOKE_HELP).toContain('Pending attempts require normal server cleanup');
  });

  it('requires the write opt-in, environment-only key and bucket', () => {
    expectRejected(['--bucket', 'bucket-1']);
    expectRejected(['--allow-remote-writes']);
    expectRejected(['--allow-remote-writes', '--bucket', 'bucket-1', '--api-key', 'secret']);
    expectRejected(['--allow-remote-writes', '--bucket', 'bucket-1'], {
      OPENPOOL_BASE_URL: baseEnv.OPENPOOL_BASE_URL,
    });
    expectRejected(['--allow-remote-writes', '--bucket', 'bucket-1'], {
      OPENPOOL_BASE_URL: baseEnv.OPENPOOL_BASE_URL,
      OPENPOOL_API_KEY: ' padded ',
    });
    expectRejected(['--allow-remote-writes', '--bucket', 'bucket-1'], {
      OPENPOOL_BASE_URL: baseEnv.OPENPOOL_BASE_URL,
      OPENPOOL_API_KEY: 'line\nbreak',
    });
  });

  it('uses an explicit root URL and preserves the environment key without putting it in argv', () => {
    const result = parse([
      '--allow-remote-writes', '--base-url', 'https://staging-two.example', '--bucket', 'bucket-1',
      '--prefix', 'cli-smoke/run-1/', '--size-mb', '1',
    ]);
    expect(result).toEqual({
      baseUrl: 'https://staging-two.example', apiKey: baseEnv.OPENPOOL_API_KEY,
      bucketId: 'bucket-1', prefix: 'cli-smoke/run-1/', sizeBytes: 1_000_000,
    });
  });

  it('accepts only the inclusive 1..50 MB range and converts decimal megabytes exactly', () => {
    expect(parse(['--allow-remote-writes', '--bucket', 'bucket-1', '--size-mb', '1'])?.sizeBytes).toBe(1_000_000);
    expect(parse(['--allow-remote-writes', '--bucket', 'bucket-1', '--size-mb', '50'])?.sizeBytes).toBe(50_000_000);
    expect(parse(['--allow-remote-writes', '--bucket', 'bucket-1'])?.sizeBytes).toBe(50_000_000);
    for (const size of ['0', '51', '00', '01', '1.0', '-1', '50000000', '']) {
      expectRejected(['--allow-remote-writes', '--bucket', 'bucket-1', '--size-mb', size]);
    }
  });

  it('rejects malformed and duplicate options', () => {
    expectRejected(['--allow-remote-writes', '--bucket', 'bucket-1', '--bucket', 'bucket-2']);
    expectRejected(['--allow-remote-writes', '--bucket', 'bucket-1', '--size-mb', '1', '--size-mb', '2']);
    expectRejected(['--allow-remote-writes', '--bucket', 'bucket-1', 'unexpected']);
    expectRejected(['--allow-remote-writes', '--bucket', 'bucket-1', '--unknown', 'value']);
    expectRejected(['--allow-remote-writes=false', '--bucket', 'bucket-1']);
  });

  it('accepts bounded bucket IDs and rejects whitespace, controls and overlong values', () => {
    expect(parse(['--allow-remote-writes', '--bucket', 'bucket/one'])).toMatchObject({ bucketId: 'bucket/one' });
    expectRejected(['--allow-remote-writes', '--bucket', ' bucket-1']);
    expectRejected(['--allow-remote-writes', '--bucket', 'bucket-1 ']);
    expectRejected(['--allow-remote-writes', '--bucket', 'bucket\u0000one']);
    expectRejected(['--allow-remote-writes', '--bucket', 'x'.repeat(129)]);
  });

  it('requires a directory-like prefix with no traversal components', () => {
    for (const prefix of [
      '', '/', '../', 'cli-smoke', '/cli-smoke/', 'cli-smoke/../run/', 'cli-smoke/./run/',
      ' cli-smoke/', 'cli-smoke/ ', 'cli-smoke/\u0000/', 'cli-smoke/?query/',
    ]) {
      expectRejected(['--allow-remote-writes', '--bucket', 'bucket-1', '--prefix', prefix], baseEnv, `prefix=${JSON.stringify(prefix)}`);
    }
    expect(parse(['--allow-remote-writes', '--bucket', 'bucket-1', '--prefix', 'A0._-9/run/'])).toMatchObject({
      prefix: 'A0._-9/run/',
    });
    expectRejected(['--allow-remote-writes', '--bucket', 'bucket-1', '--prefix', `a${'b'.repeat(255)}/`]);
  });

  it('accepts loopback HTTP only and rejects non-root or credential-bearing control URLs', () => {
    expect(parse([
      '--allow-remote-writes', '--base-url', 'http://127.0.0.1:8787', '--bucket', 'bucket-1',
    ])).toMatchObject({ baseUrl: 'http://127.0.0.1:8787' });
    for (const url of [
      'http://remote.example', 'http://127.0.0.1:8787/api', 'https://staging.example/api',
      'https://user:secret@staging.example', 'https://staging.example/?token=secret',
      'https://staging.example/#secret', 'not-a-url',
    ]) {
      expectRejected(['--allow-remote-writes', '--base-url', url, '--bucket', 'bucket-1']);
    }
  });
});
