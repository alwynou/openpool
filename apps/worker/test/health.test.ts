import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import worker from '../src';
import type { Env } from '../src/env';

describe('health endpoint', () => {
  it('reports the Worker as healthy', async () => {
    const request = new Request('https://openpool.test/api/v1/health');
    const executionContext = createExecutionContext();
    const response = await worker.fetch(
      request,
      env as unknown as Env,
      executionContext,
    );
    await waitOnExecutionContext(executionContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { name: 'openpool', status: 'ok' },
    });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});
