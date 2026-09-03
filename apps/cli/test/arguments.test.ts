import { describe, expect, it } from 'vitest';

import { parseArguments } from '../src/arguments.js';

const BASE_URL = 'https://openpool.example';
const COMMON = ['--base-url', BASE_URL, '--timeout-ms', '60000'] as const;

type Environment = Readonly<Record<string, string | undefined>>;

function parse(argv: readonly string[], env: Environment = {}) {
  return parseArguments(argv, env);
}

function expectRejected(
  argv: readonly string[],
  env: Environment = {},
): void {
  let thrown: unknown;
  try {
    parse(argv, env);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
}

describe('parseArguments', () => {
  describe('help', () => {
    it('returns help without requiring a control-plane URL', () => {
      expect(parse([])).toEqual({ command: 'help' });
      expect(parse(['--help'])).toEqual({ command: 'help' });
      expect(parse(['help'])).toEqual({ command: 'help' });
    });
  });

  describe('common options', () => {
    it('uses the environment URL and the default timeout', () => {
      expect(parse(['stat', '--object', 'object-1'], {
        OPENPOOL_BASE_URL: BASE_URL,
      })).toEqual({
        command: 'stat',
        baseUrl: BASE_URL,
        timeoutMs: 300_000,
        objectId: 'object-1',
      });
    });

    it('gives an explicit URL precedence over the environment', () => {
      expect(parse([
        'stat', '--base-url', 'http://control.example', '--object', 'object-1',
      ], { OPENPOOL_BASE_URL: 'https://environment.example' })).toMatchObject({
        baseUrl: 'http://control.example',
      });
    });

    it('does not apply HTTPS validation in the parser', () => {
      expect(parse([
        'stat', '--base-url', 'http://control.example', '--object', 'object-1',
      ])).toMatchObject({ baseUrl: 'http://control.example' });
    });

    it.each(['0', '-1', '86400001', '1.5', 'not-a-number'])(
      'rejects an invalid timeout: %s',
      (timeoutMs) => {
        expectRejected([
          'stat', ...COMMON.slice(0, 2), '--timeout-ms', timeoutMs,
          '--object', 'object-1',
        ]);
      },
    );

    it('accepts the inclusive timeout bounds', () => {
      expect(parse([
        'stat', '--base-url', BASE_URL, '--timeout-ms', '1', '--object', 'object-1',
      ])).toMatchObject({ timeoutMs: 1 });
      expect(parse([
        'stat', '--base-url', BASE_URL, '--timeout-ms', '86400000', '--object', 'object-1',
      ])).toMatchObject({ timeoutMs: 86_400_000 });
    });
  });

  describe('list', () => {
    it('parses the bucket and all list query fields', () => {
      expect(parse([
        'list',
        ...COMMON,
        '--bucket', 'bucket/one',
        '--limit', '25',
        '--status', 'READY',
        '--prefix', 'reports/',
        '--after-key', 'reports/previous',
      ])).toEqual({
        command: 'list',
        baseUrl: BASE_URL,
        timeoutMs: 60_000,
        bucketId: 'bucket/one',
        query: {
          limit: 25,
          status: 'READY',
          prefix: 'reports/',
          afterKey: 'reports/previous',
        },
      });
    });

    it('uses the default limit and preserves an empty prefix', () => {
      expect(parse([
        'list', ...COMMON, '--bucket', 'bucket-1', '--prefix', '',
      ])).toEqual({
        command: 'list',
        baseUrl: BASE_URL,
        timeoutMs: 60_000,
        bucketId: 'bucket-1',
        query: { limit: 100, prefix: '' },
      });
    });

    it.each(['PENDING', 'READY', 'DELETING', 'DELETED'])(
      'accepts object status %s',
      (status) => {
        expect(parse([
          'list', ...COMMON, '--bucket', 'bucket-1', '--status', status,
        ])).toMatchObject({ query: { status } });
      },
    );

    it('rejects an invalid status or limit', () => {
      expectRejected([
        'list', ...COMMON, '--bucket', 'bucket-1', '--status', 'BROKEN',
      ]);
      expectRejected([
        'list', ...COMMON, '--bucket', 'bucket-1', '--limit', '0',
      ]);
      expectRejected([
        'list', ...COMMON, '--bucket', 'bucket-1', '--limit', '1001',
      ]);
    });
  });

  describe('object status and deletion', () => {
    it.each(['stat', 'delete', 'upload-status'] as const)(
      'parses %s with an object ID',
      (command) => {
        expect(parse([command, ...COMMON, '--object', 'object/one'])).toEqual({
          command,
          baseUrl: BASE_URL,
          timeoutMs: 60_000,
          objectId: 'object/one',
        });
      },
    );
  });

  describe('complete', () => {
    it('parses the object and upload session IDs', () => {
      expect(parse([
        'complete', ...COMMON, '--object', 'object-1', '--session', 'session-1',
      ])).toEqual({
        command: 'complete',
        baseUrl: BASE_URL,
        timeoutMs: 60_000,
        objectId: 'object-1',
        uploadSessionId: 'session-1',
      });
    });
  });

  describe('upload and retry', () => {
    it('parses upload fields, keeps key whitespace, and defaults content type', () => {
      expect(parse([
        'upload', ...COMMON,
        '--bucket', 'bucket-1',
        '--key', '  reports/annual.pdf  ',
        '--file', '/tmp/annual.pdf',
      ])).toEqual({
        command: 'upload',
        baseUrl: BASE_URL,
        timeoutMs: 60_000,
        bucketId: 'bucket-1',
        logicalKey: '  reports/annual.pdf  ',
        file: '/tmp/annual.pdf',
        contentType: 'application/octet-stream',
      });
    });

    it('parses an explicit content type', () => {
      expect(parse([
        'upload', ...COMMON,
        '--bucket', 'bucket-1',
        '--key', 'reports/annual.pdf',
        '--file', '/tmp/annual.pdf',
        '--content-type', 'application/pdf',
      ])).toMatchObject({ contentType: 'application/pdf' });
    });

    it('parses retry fields including the expected current session', () => {
      expect(parse([
        'retry', ...COMMON,
        '--object', 'object-1',
        '--session', 'session-1',
        '--bucket', 'bucket-1',
        '--key', 'reports/annual.pdf',
        '--file', '/tmp/annual.pdf',
        '--content-type', 'application/pdf',
      ])).toEqual({
        command: 'retry',
        baseUrl: BASE_URL,
        timeoutMs: 60_000,
        objectId: 'object-1',
        uploadSessionId: 'session-1',
        bucketId: 'bucket-1',
        logicalKey: 'reports/annual.pdf',
        file: '/tmp/annual.pdf',
        contentType: 'application/pdf',
      });
    });

    it.each(['', '   ', '\n', 'file\nname', 'file\0name', 'file\u007fname'])('rejects an invalid logical key: %j', (logicalKey) => {
      expectRejected([
        'upload', ...COMMON,
        '--bucket', 'bucket-1', '--key', logicalKey, '--file', '/tmp/file',
      ]);
    });

    it.each(['', '   ', '\n', ' text/plain', 'text/plain '])('rejects an invalid content type: %j', (contentType) => {
      expectRejected([
        'upload', ...COMMON,
        '--bucket', 'bucket-1', '--key', 'file', '--file', '/tmp/file',
        '--content-type', contentType,
      ]);
    });
  });

  describe('validation and command isolation', () => {
    it('requires a base URL for non-help commands', () => {
      expectRejected(['stat', '--object', 'object-1']);
      expectRejected(['stat', '--object', 'object-1'], { OPENPOOL_BASE_URL: '' });
    });

    it.each([
      ['list', ['--bucket', 'bucket-1']],
      ['stat', ['--object', 'object-1']],
      ['delete', ['--object', 'object-1']],
      ['upload-status', ['--object', 'object-1']],
      ['complete', ['--object', 'object-1', '--session', 'session-1']],
      ['upload', ['--bucket', 'bucket-1', '--key', 'file', '--file', '/tmp/file']],
      ['retry', [
        '--object', 'object-1', '--session', 'session-1', '--bucket', 'bucket-1',
        '--key', 'file', '--file', '/tmp/file',
      ]],
    ] as const)('requires command-specific flags for %s', (command, flags) => {
      expectRejected([command, '--base-url', BASE_URL, ...flags.slice(0, -1)]);
    });

    it('rejects unknown, duplicate, cross-command, and positional arguments', () => {
      expectRejected(['unknown-command', ...COMMON]);
      expectRejected(['stat', ...COMMON, '--object', 'object-1', 'extra']);
      expectRejected(['stat', ...COMMON, '--object', 'object-1', '--unknown', 'x']);
      expectRejected(['stat', ...COMMON, '--object', 'object-1', '--object', 'object-2']);
      expectRejected(['stat', ...COMMON, '--base-url', 'https://other.example', '--object', 'object-1']);
      expectRejected(['stat', ...COMMON, '--object', 'object-1', '--bucket', 'bucket-1']);
      expectRejected(['list', ...COMMON, '--bucket', 'bucket-1', '--limit', '10', '--limit', '20']);
      expectRejected(['upload', ...COMMON, '--bucket', 'bucket-1', '--key', 'file', '--file', '/tmp/file', '--object', 'object-1']);
    });

    it.each([
      ['--api-key', 'api-secret-should-not-echo'],
      ['--cookie', 'openpool_session=session-secret-should-not-echo'],
    ] as const)('rejects unsupported sensitive option %s without echoing its value', (flag, secret) => {
      let thrown: unknown;
      try {
        parse(['stat', ...COMMON, '--object', 'object-1', flag, secret]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : '';
      expect(message).not.toContain(secret);
    });

    it('rejects a missing option value without echoing the preceding secret-like token', () => {
      let thrown: unknown;
      try {
        parse(['stat', ...COMMON, '--object', 'object-1', '--api-key']);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown instanceof Error ? thrown.message : '').not.toContain('api-key');
    });
  });
});
