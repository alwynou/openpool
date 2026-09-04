// @vitest-environment jsdom

import type { ApiKeyResponse, CreatedApiKeyResponse, LogicalBucketResponse } from '@openpool/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiClientError } from '../api';
import type * as ApiModule from '../api';
import { queryKeys } from '../queries';
import { ApiKeysPage } from './api-keys-page';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, api: Object.fromEntries(Object.keys(original.api).map((name) =>
    [name, vi.fn(async () => { throw new Error('Unexpected API call in API key tests'); })])) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mock = vi.mocked(api);
const token = 'opk_fake-token-never-cache-this';
const now = '2026-09-03T00:00:00.000Z';
const bucket: LogicalBucketResponse = { id: 'bucket-1', name: 'Reports', description: null, createdAt: now, updatedAt: now };
const metadata: ApiKeyResponse = { id: 'key-1', name: 'Backup client', keyPrefix: 'opk_AbCd1234', scopes: ['objects:list', 'objects:read'], logicalBucketId: null, pathPrefix: null, expiresAt: null, revokedAt: null, createdAt: now };
const created: CreatedApiKeyResponse = { apiKey: metadata, token };

let client: QueryClient;
const unexpectedFetch = vi.fn(() => { throw new Error('Network is disabled in API key tests'); });
let clipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', unexpectedFetch);
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  vi.stubGlobal('PointerEvent', MouseEvent);
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    if (selector === ':fullscreen') return false;
    return matches.call(this, selector);
  });
  for (const operation of Object.values(mock)) operation.mockRejectedValue(new Error('Unexpected API call in API key tests'));
  mock.listApiKeys.mockResolvedValue([]);
  mock.listBuckets.mockResolvedValue([bucket]);
});

afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  try { expect(unexpectedFetch).not.toHaveBeenCalled(); } finally {
    vi.unstubAllGlobals();
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

function renderPage() {
  return render(<StrictMode><MemoryRouter><QueryClientProvider client={client}><ApiKeysPage /></QueryClientProvider></MemoryRouter></StrictMode>);
}

async function setup({ mutationRetry = true }: { mutationRetry?: boolean } = {}) {
  const user = userEvent.setup();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false }, mutations: { retry: mutationRetry, gcTime: Infinity } } });
  renderPage();
  await screen.findByText('No API keys');
  return user;
}

const createDialog = () => screen.getByRole('dialog', { name: 'Create API key' });
const revealDialog = () => screen.getByRole('dialog', { name: 'Your API key is ready' });
const field = (label: string) => within(createDialog()).getByLabelText<HTMLInputElement>(new RegExp(`^${label}`, 'u'));
const scope = (name: string) => within(createDialog()).getByRole<HTMLInputElement>('checkbox', { name });
const generate = () => within(createDialog()).getByRole<HTMLButtonElement>('button', { name: 'Generate key' });

async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole('button', { name: 'Create key' })[0]!);
  await screen.findByRole('dialog', { name: 'Create API key' });
}

function cacheText() {
  return JSON.stringify({ queries: client.getQueryCache().getAll().map((query) => query.state), mutations: client.getMutationCache().getAll().map((mutation) => mutation.state) });
}

function expectSafeCache() {
  expect(cacheText()).not.toContain(token);
  expect(JSON.stringify(vi.mocked(toast.success).mock.calls)).not.toContain(token);
  expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain(token);
}

describe('API key issuance and reveal', () => {
  it('sends the exact default payload', async () => {
    const user = await setup();
    await openCreate(user);
    await user.type(field('Key name'), 'Backup client');
    mock.createApiKey.mockResolvedValueOnce(created);
    await user.click(generate());
    await waitFor(() => expect(mock.createApiKey).toHaveBeenCalledTimes(1));
    expect(mock.createApiKey.mock.calls[0]?.[0]).toEqual({ name: 'Backup client', scopes: ['objects:list', 'objects:read'] });
    await screen.findByText(token);
  });

  it('requires at least one scope and allows correction without a stuck submit lock', async () => {
    const user = await setup();
    await openCreate(user);
    await user.click(scope('objects:list'));
    await user.click(scope('objects:read'));
    await user.type(field('Key name'), 'No scope');
    await user.click(generate());
    expect(mock.createApiKey).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Choose at least one scope.');
    mock.createApiKey.mockResolvedValueOnce(created);
    await user.click(scope('objects:upload'));
    await user.click(generate());
    await screen.findByText(token);
    expect(mock.createApiKey).toHaveBeenCalledTimes(1);
    expect(mock.createApiKey.mock.calls[0]?.[0]).toEqual({ name: 'No scope', scopes: ['objects:upload'] });
  });

  it('maps restrictions, locks pending inputs, and ignores synchronous duplicate submits and dismissal', async () => {
    const user = await setup();
    await openCreate(user);
    await user.type(field('Key name'), 'Restricted');
    await user.selectOptions(within(createDialog()).getByRole('combobox', { name: /Bucket restriction/u }), bucket.id);
    await user.type(field('Path prefix'), 'reports/2026/');
    fireEvent.change(field('Expires'), { target: { value: '2026-12-31' } });
    await user.click(scope('objects:upload'));
    await user.click(scope('objects:read'));
    let release: (value: CreatedApiKeyResponse) => void = () => undefined;
    const gate = new Promise<CreatedApiKeyResponse>((resolve) => { release = resolve; });
    mock.createApiKey.mockImplementationOnce(async () => { await gate; return created; });
    const form = generate().closest('form');
    if (!form) throw new Error('Missing API key form');
    try {
      act(() => { fireEvent.submit(form); fireEvent.submit(form); fireEvent.click(within(createDialog()).getByRole('button', { name: 'Close dialog' })); });
      await waitFor(() => expect(mock.createApiKey).toHaveBeenCalledTimes(1));
    expect(mock.createApiKey.mock.calls[0]?.[0]).toEqual({ name: 'Restricted', scopes: ['objects:list', 'objects:upload'], logicalBucketId: bucket.id, pathPrefix: 'reports/2026/', expiresAt: '2026-12-31T00:00:00.000Z' });
      expect(generate().matches(':disabled')).toBe(true);
      for (const input of createDialog().querySelectorAll('input, select')) expect(input.matches(':disabled')).toBe(true);
      expect(within(createDialog()).getByRole('button', { name: 'Cancel' }).matches(':disabled')).toBe(true);
      await user.click(within(createDialog()).getByRole('button', { name: 'Cancel' }));
      await user.keyboard('{Escape}');
      expect(createDialog()).toBeTruthy();
    } finally {
      await act(async () => { release(created); });
    }
    await waitFor(() => expect(revealDialog()).toBeTruthy());
  });

  it('overrides automatic mutation retries and allows an edited explicit retry', async () => {
    const user = await setup();
    await openCreate(user);
    await user.type(field('Key name'), 'Retry me');
    await user.click(scope('objects:upload'));
    mock.createApiKey.mockRejectedValueOnce(new ApiClientError('Could not issue the key.', 'API_KEY_INVALID', 'request-key'));
    await user.click(generate());
    await within(createDialog()).findByRole('alert');
    expect(mock.createApiKey).toHaveBeenCalledTimes(1);
    expect(field('Key name').value).toBe('Retry me');
    expect(scope('objects:upload').checked).toBe(true);
    expect(within(createDialog()).getByText(/request-key/u)).toBeTruthy();
    await user.clear(field('Key name'));
    await user.type(field('Key name'), 'Edited retry');
    mock.createApiKey.mockResolvedValueOnce(created);
    await user.click(generate());
    await screen.findByText(token);
    expect(mock.createApiKey).toHaveBeenCalledTimes(2);
    expect(mock.createApiKey.mock.calls.at(-1)?.[0]).toEqual({ name: 'Edited retry', scopes: ['objects:list', 'objects:read', 'objects:upload'] });
  });

  it.each(['Cancel', 'Close dialog', 'Escape'])('clears a failed form and its error after %s', async (dismiss) => {
    // Isolate form reset from the separate regression for inherited retries.
    const user = await setup({ mutationRetry: false });
    await openCreate(user);
    await user.type(field('Key name'), 'Discard this');
    await user.selectOptions(within(createDialog()).getByRole('combobox'), bucket.id);
    await user.type(field('Path prefix'), 'discard/');
    fireEvent.change(field('Expires'), { target: { value: '2026-12-31' } });
    await user.click(scope('objects:upload'));
    await user.click(scope('objects:read'));
    mock.createApiKey.mockRejectedValueOnce(new ApiClientError('Discard this error.', 'API_KEY_INVALID'));
    await user.click(generate());
    await within(createDialog()).findByRole('alert');
    if (dismiss === 'Escape') await user.keyboard('{Escape}');
    else await user.click(within(createDialog()).getByRole('button', { name: dismiss }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create API key' })).toBeNull());
    await openCreate(user);
    expect(field('Key name').value).toBe('');
    expect(field('Bucket restriction').value).toBe('');
    expect(field('Path prefix').value).toBe('');
    expect(field('Expires').value).toBe('');
    expect(scope('objects:list').checked).toBe(true);
    expect(scope('objects:read').checked).toBe(true);
    expect(scope('objects:upload').checked).toBe(false);
    expect(scope('objects:delete').checked).toBe(false);
    expect(within(createDialog()).queryByRole('alert')).toBeNull();
    expect(mock.createApiKey).toHaveBeenCalledTimes(1);
  });

  it('never caches token during list refresh, dismissal, or unmount and blocks another creation until refresh settles', async () => {
    const user = await setup();
    let releaseList: (value: readonly ApiKeyResponse[]) => void = () => undefined;
    const listGate = new Promise<readonly ApiKeyResponse[]>((resolve) => { releaseList = resolve; });
    mock.createApiKey.mockResolvedValue(created);
    mock.listApiKeys.mockImplementationOnce(async () => listGate);
    const cacheStates: string[] = [];
    const unsubscribe = client.getMutationCache().subscribe(() => { cacheStates.push(cacheText()); });
    try {
      await openCreate(user);
      await user.type(field('Key name'), 'Safe token');
      await user.click(generate());
      await screen.findByText(token);
      await waitFor(() => expect(mock.listApiKeys).toHaveBeenCalledTimes(2));
      expect(client.getQueryState(queryKeys.apiKeys)?.fetchStatus).toBe('fetching');
      expectSafeCache();
      await user.click(within(revealDialog()).getByRole('button', { name: 'I’ve saved the token' }));
      expect(screen.queryByText(token)).toBeNull();
      const buttons = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Create key' });
      for (const button of buttons) expect(button.disabled).toBe(true);
      await user.click(buttons[0]!);
      expect(mock.createApiKey).toHaveBeenCalledTimes(1);
      expectSafeCache();
      await act(async () => { releaseList([metadata]); });
      await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create key' }).disabled).toBe(false));
      expect(client.getQueryData(queryKeys.apiKeys)).toEqual([metadata]);
      expectSafeCache();
      cleanup();
      expectSafeCache();
      expect(cacheStates.length).toBeGreaterThan(0);
      expect(cacheStates.join('\n')).not.toContain(token);
    } finally {
      await act(async () => { releaseList([metadata]); });
      unsubscribe();
    }
  });

  it('forgets a visible token on page unmount without relying on cache collection', async () => {
    const user = await setup();
    mock.createApiKey.mockResolvedValue(created);
    await openCreate(user);
    await user.type(field('Key name'), 'Leave page');
    await user.click(generate());
    await screen.findByText(token);
    await waitFor(() => expect(client.getMutationCache().getAll().some((mutation) => mutation.state.status === 'success')).toBe(true));
    cleanup();
    expect(screen.queryByText(token)).toBeNull();
    expectSafeCache();
    renderPage();
    await screen.findByText('No API keys');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(token)).toBeNull();
    expect(mock.createApiKey).toHaveBeenCalledTimes(1);
    expectSafeCache();
  });

  it('keeps the revealed token visible when list invalidation fails', async () => {
    const user = await setup();
    mock.createApiKey.mockResolvedValue(created);
    mock.listApiKeys.mockRejectedValueOnce(new Error('list unavailable'));
    await openCreate(user);
    await user.type(field('Key name'), 'Refresh failure');
    await user.click(generate());
    await screen.findByText(token);
    await waitFor(() => expect(client.getQueryState(queryKeys.apiKeys)?.status).toBe('error'));
    expect(client.getQueryState(queryKeys.apiKeys)?.fetchStatus).toBe('idle');
    expect(revealDialog()).toBeTruthy();
    expect(screen.getByText(token)).toBeTruthy();
    expectSafeCache();
    await user.keyboard('{Escape}');
    expect(screen.queryByText(token)).toBeNull();
    expect(screen.getByText('list unavailable')).toBeTruthy();
    mock.listApiKeys.mockResolvedValue([metadata]);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(client.getQueryState(queryKeys.apiKeys)?.status).toBe('success'));
    expect(mock.createApiKey).toHaveBeenCalledTimes(1);
  });
});

describe('API key token copying', () => {
  it('blocks duplicate copy clicks and waits for clipboard success before announcing copy', async () => {
    const user = await setup();
    mock.createApiKey.mockResolvedValue(created);
    await openCreate(user);
    await user.type(field('Key name'), 'Copy key');
    await user.click(generate());
    await screen.findByText(token);
    const copy = () => within(revealDialog()).getByRole('button', { name: 'Copy' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writeText = vi.fn().mockReturnValue(gate);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const button = copy();
      act(() => { fireEvent.click(button); fireEvent.click(button); });
      expect(writeText).toHaveBeenCalledExactlyOnceWith(token);
      expect(button.matches(':disabled')).toBe(true);
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
      await act(async () => { release(); });
      expect(vi.mocked(toast.success)).toHaveBeenCalledExactlyOnceWith('Token copied');
      expect(button.matches(':disabled')).toBe(false);
      expectSafeCache();
    } finally {
      await act(async () => { release(); });
    }
  });

  it.each(['unavailable', 'rejected'])('handles %s clipboard without reporting success or leaking its error', async (failure) => {
    const user = await setup();
    mock.createApiKey.mockResolvedValue(created);
    await openCreate(user);
    await user.type(field('Key name'), 'Copy failure');
    await user.click(generate());
    await screen.findByText(token);
    const writeText = vi.fn().mockRejectedValue(new Error(`Clipboard denied ${token}`));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: failure === 'unavailable' ? undefined : { writeText } });
    await user.click(within(revealDialog()).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledExactlyOnceWith(failure === 'unavailable'
      ? 'Clipboard access is unavailable. Select the token and copy it manually.'
      : 'Could not copy the token. Select it and copy it manually.'));
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(screen.getByText(token)).toBeTruthy();
    expectSafeCache();
  });

  it('does not show a stale copy toast after the reveal closes while copy is pending', async () => {
    const user = await setup();
    mock.createApiKey.mockResolvedValue(created);
    await openCreate(user);
    await user.type(field('Key name'), 'Pending copy');
    await user.click(generate());
    await screen.findByText(token);
    let release: (value: void) => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writeText = vi.fn().mockReturnValue(gate);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      await user.click(within(revealDialog()).getByRole('button', { name: 'Copy' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(token));
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
      await user.click(within(revealDialog()).getByRole('button', { name: 'Close dialog' }));
      expect(screen.queryByText(token)).toBeNull();
      await act(async () => { release(); });
      await Promise.resolve();
      expect(vi.mocked(toast.success)).not.toHaveBeenCalledWith('Token copied');
      expectSafeCache();
    } finally {
      await act(async () => { release(); });
    }
  });
});
