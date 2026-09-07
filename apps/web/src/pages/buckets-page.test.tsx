// @vitest-environment jsdom

import type { LogicalBucketResponse } from '@openpool/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import type * as ApiModule from '../api';
import { BucketsPage } from './buckets-page';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return {
    ...original,
    api: Object.fromEntries(
      Object.keys(original.api).map((name) => [
        name,
        vi.fn(async () => {
          throw new Error('Unexpected API call in bucket page test');
        }),
      ]),
    ),
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mock = vi.mocked(api);
const now = '2026-09-03T00:00:00.000Z';
let buckets: LogicalBucketResponse[];
let client: QueryClient | undefined;
const unexpectedFetch = vi.fn(() => {
  throw new Error('Network is disabled in bucket page tests');
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', unexpectedFetch);
  buckets = [
    {
      id: 'bucket-1',
      name: 'Photos',
      description: null,
      publicAccessEnabled: false,
      createdAt: now,
      updatedAt: now,
    },
  ];
  for (const operation of Object.values(mock)) {
    operation.mockRejectedValue(new Error('Unexpected API call in bucket page test'));
  }
  mock.listBuckets.mockImplementation(async () => buckets);
  mock.listAccounts.mockResolvedValue([]);
  mock.listShards.mockResolvedValue([]);
  mock.listShardMigrations.mockResolvedValue([]);
  mock.updateBucketPublicAccess.mockImplementation(async (id, input) => {
    const current = buckets.find((bucket) => bucket.id === id);
    if (!current) throw new Error('Unknown fake bucket');
    const updated = {
      ...current,
      publicAccessEnabled: input.enabled,
      updatedAt: '2026-09-03T00:01:00.000Z',
    };
    buckets = [updated];
    return updated;
  });
});

afterEach(() => {
  cleanup();
  client?.clear();
  client = undefined;
  expect(unexpectedFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('Buckets page public access', () => {
  it('confirms the bucket-wide impact before enabling inherited public links', async () => {
    const user = userEvent.setup();
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    });
    render(
      <StrictMode>
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <BucketsPage />
          </QueryClientProvider>
        </MemoryRouter>
      </StrictMode>,
    );

    const toggle = await screen.findByRole('button', { name: 'Make public' });
    await user.click(toggle);
    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog).getByText(/All current and future ready files/u),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Make public' }));

    await waitFor(() =>
      expect(mock.updateBucketPublicAccess).toHaveBeenCalledWith('bucket-1', {
        enabled: true,
        expectedUpdatedAt: now,
      }),
    );
    await screen.findByRole('button', { name: 'Make private' });
  });
});
