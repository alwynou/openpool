// @vitest-environment jsdom

import type { StorageAccountResponse, StorageProviderKind } from '@openpool/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiClientError } from '../api';
import type * as ApiModule from '../api';
import { AccountsPage } from './accounts-page';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, api: Object.fromEntries(Object.keys(original.api).map((name) =>
    [name, vi.fn(async () => { throw new Error('Unexpected API call in account create test'); })])) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mock = vi.mocked(api);
const now = '2026-09-03T00:00:00.000Z';
const credentials = { accessKeyId: 'fake-access-id', secretAccessKey: 'fake-secret', sessionToken: 'fake-session' };
const created = (provider: StorageProviderKind = 'r2'): StorageAccountResponse => ({
  id: 'account-created', name: 'New account', provider,
  providerConfig: provider === 'r2'
    ? { accountId: 'fake-cloudflare-account', validationBucket: 'fake-bucket', jurisdiction: 'eu' }
    : provider === 'b2'
      ? { region: 'us-west-004', validationBucket: 'fake-bucket' }
      : { endpoint: 'https://s3.example.test', region: 'us-east-1', validationBucket: 'fake-bucket' },
  status: 'VERIFYING', priority: 7, writeEnabled: false, capacityBytes: 1000, usedBytes: 0,
  availableBytes: 1000, healthStatus: 'UNKNOWN', capacityAccuracy: 'CONFIGURED',
  capabilities: { presignedUpload: false, presignedDownload: false, headObject: false, deleteObject: false, bucketProbe: false, usageProbe: false },
  createdAt: now, updatedAt: now, lastHealthCheckedAt: null,
});

let client: QueryClient;
let accounts: StorageAccountResponse[];
const unexpectedFetch = vi.fn(() => { throw new Error('Network is disabled in account create tests'); });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', unexpectedFetch);
  vi.stubGlobal('PointerEvent', MouseEvent);
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    if (selector === ':fullscreen') return false;
    return matches.call(this, selector);
  });
  accounts = [];
  for (const operation of Object.values(mock)) operation.mockRejectedValue(new Error('Unexpected API call in account create test'));
  mock.listAccounts.mockImplementation(async () => accounts);
  mock.createAccount.mockImplementation(async (input) => {
    const result = created(input.provider);
    accounts = [result];
    return result;
  });
});

afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  try { expect(unexpectedFetch).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); }
});

async function setup({ mutationRetry = true }: { mutationRetry?: boolean } = {}) {
  const user = userEvent.setup();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false }, mutations: { retry: mutationRetry, gcTime: Infinity } } });
  render(<StrictMode><MemoryRouter><QueryClientProvider client={client}><AccountsPage /></QueryClientProvider></MemoryRouter></StrictMode>);
  await screen.findByText('No storage accounts yet');
  return user;
}

const dialog = () => screen.getByRole('dialog', { name: 'Add storage account' });
const field = (label: RegExp | string) => within(dialog()).getByLabelText<HTMLInputElement>(typeof label === 'string' ? new RegExp(`^${label}`, 'u') : label);
const create = () => within(dialog()).getByRole<HTMLButtonElement>('button', { name: 'Create account' });

async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole('button', { name: 'Add account' })[0]!);
  await screen.findByRole('dialog', { name: 'Add storage account' });
}

async function fillR2(user: ReturnType<typeof userEvent.setup>) {
  await user.type(field('Display name'), ' New account ');
  await user.type(field('Cloudflare account ID'), ' fake-cloudflare-account ');
  await user.type(field('Validation bucket'), ' fake-bucket ');
  await user.type(field('Access key ID'), ` ${credentials.accessKeyId} `);
  await user.type(field('Secret access key'), credentials.secretAccessKey);
  await user.type(field('Session token'), credentials.sessionToken);
  await user.clear(field('Priority'));
  await user.type(field('Priority'), '7');
  await user.type(field('Capacity in bytes'), '1000');
  await user.selectOptions(field('Jurisdiction'), 'eu');
}

function expectNoCachedCredentials() {
  const cache = JSON.stringify({ queries: client.getQueryCache().getAll().map((query) => query.state), mutations: client.getMutationCache().getAll().map((mutation) => mutation.state) });
  for (const value of Object.values(credentials)) {
    expect(cache).not.toContain(value);
    expect(JSON.stringify(vi.mocked(toast.success).mock.calls)).not.toContain(value);
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain(value);
    expect(document.body.textContent).not.toContain(value);
  }
}

describe('Storage account creation', () => {
  it.each(['r2', 'b2', 's3'] as const)('maps %s fields and does not automatically verify', async (provider) => {
    const user = await setup();
    await openCreate(user);
    if (provider !== 'r2') await user.selectOptions(field('Provider'), provider);
    if (provider === 'r2') await fillR2(user);
    if (provider === 'b2') {
      await user.type(field('Display name'), 'B2 account');
      await user.type(field('Region'), 'us-west-004');
      await user.type(field('Validation bucket'), 'fake-bucket');
      await user.type(field('Key ID'), credentials.accessKeyId);
      await user.type(field('Application key'), credentials.secretAccessKey);
    }
    if (provider === 's3') {
      await user.type(field('Display name'), 'S3 account');
      await user.type(field('HTTPS endpoint'), 'https://s3.example.test');
      await user.type(field('Region'), 'us-east-1');
      await user.type(field('Validation bucket'), 'fake-bucket');
      await user.type(field('Access key ID'), credentials.accessKeyId);
      await user.type(field('Secret access key'), credentials.secretAccessKey);
    }
    await user.click(create());
    await waitFor(() => expect(mock.createAccount).toHaveBeenCalledTimes(1));
    const input = mock.createAccount.mock.calls[0]?.[0];
    if (!input) throw new Error('Missing create payload');
    expect(input.provider).toBe(provider);
    expect(input.name).toMatch(/account/);
    expect(input.providerConfig.validationBucket).toBe('fake-bucket');
    expect(mock.verifyAccount).not.toHaveBeenCalled();
    if (provider === 'r2') expect(input).toEqual({ name: 'New account', provider: 'r2', providerConfig: { accountId: 'fake-cloudflare-account', jurisdiction: 'eu', validationBucket: 'fake-bucket' }, credentials, priority: 7, capacityBytes: 1000 });
    if (provider === 'b2') expect(input).toEqual({ name: 'B2 account', provider: 'b2', providerConfig: { region: 'us-west-004', validationBucket: 'fake-bucket' }, credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey }, priority: 100 });
    if (provider === 's3') expect(input).toEqual({ name: 'S3 account', provider: 's3', providerConfig: { endpoint: 'https://s3.example.test', region: 'us-east-1', validationBucket: 'fake-bucket' }, credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey }, priority: 100 });
  });

  it('rejects missing required credentials without sending a request', async () => {
    const user = await setup();
    await openCreate(user);
    await user.type(field('Display name'), 'Missing credentials');
    await user.type(field('Cloudflare account ID'), 'fake-cloudflare-account');
    await user.type(field('Validation bucket'), 'fake-bucket');
    await user.type(field('Capacity in bytes'), '1000');
    await user.click(create());
    expect(await within(dialog()).findByText('Enter the access key ID.')).toBeTruthy();
    expect(await within(dialog()).findByText('Enter the secret access key.')).toBeTruthy();
    expect(mock.createAccount).not.toHaveBeenCalled();
    await user.type(field('Access key ID'), credentials.accessKeyId);
    await user.type(field('Secret access key'), credentials.secretAccessKey);
    await user.click(create());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.createAccount).toHaveBeenCalledTimes(1);
  });

  it('does not retain credentials in query or mutation state while pending or after success', async () => {
    const user = await setup();
    await openCreate(user);
    await fillR2(user);
    let release: (value: StorageAccountResponse) => void = () => undefined;
    const gate = new Promise<StorageAccountResponse>((resolve) => { release = resolve; });
    mock.createAccount.mockImplementationOnce(async () => { await gate; return created(); });
    try {
      await user.click(create());
      await waitFor(() => expect(mock.createAccount).toHaveBeenCalledTimes(1));
      expectNoCachedCredentials();
    } finally {
      await act(async () => { release(created()); });
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expectNoCachedCredentials();
  });

  it('preserves editable values on failure and allows one explicit retry without mutation retries', async () => {
    const user = await setup();
    await openCreate(user);
    await fillR2(user);
    mock.createAccount.mockRejectedValue(new ApiClientError('Create unavailable.', 'REQUEST_FAILED', 'request-create'));
    await user.click(create());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain('request-create'));
    expect(field('Display name').value).toBe(' New account ');
    expect(field('Secret access key').value).toBe(credentials.secretAccessKey);
    expect(mock.createAccount).toHaveBeenCalledTimes(1);
    expectNoCachedCredentials();
    mock.createAccount.mockImplementationOnce(async () => created());
    await user.click(create());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.createAccount).toHaveBeenCalledTimes(2);
  });

  it('locks fields and blocks duplicate native submit, cancel, close, and Escape while pending', async () => {
    const user = await setup();
    await openCreate(user);
    await fillR2(user);
    let release: (value: StorageAccountResponse) => void = () => undefined;
    const gate = new Promise<StorageAccountResponse>((resolve) => { release = resolve; });
    mock.createAccount.mockImplementationOnce(async () => { await gate; return created(); });
    const form = create().closest('form');
    if (!form) throw new Error('Missing create form');
    try {
      // Both submits and dismissal happen before the async resolver completes.
      act(() => {
        fireEvent.submit(form);
        fireEvent.submit(form);
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Close dialog' }));
      });
      await waitFor(() => expect(mock.createAccount).toHaveBeenCalledTimes(1));
      expect(create().disabled).toBe(true);
      expect(field('Display name').matches(':disabled')).toBe(true);
      expect(field('Provider').matches(':disabled')).toBe(true);
      expect(field('Secret access key').matches(':disabled')).toBe(true);
      fireEvent.submit(form);
      await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
      await user.click(within(dialog()).getByRole('button', { name: 'Close dialog' }));
      await user.keyboard('{Escape}');
      expect(dialog()).toBeTruthy();
      expect(mock.createAccount).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { release(created()); });
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('cancel, close, and Escape each reset the form before reopening', async () => {
    const user = await setup({ mutationRetry: false });
    for (const dismissal of ['Cancel', 'Close dialog', 'Escape'] as const) {
      await openCreate(user);
      await fillR2(user);
      mock.createAccount.mockRejectedValueOnce(new ApiClientError('Create unavailable.', 'REQUEST_FAILED', 'request-create'));
      await user.click(create());
      await within(dialog()).findByRole('alert');
      await user.selectOptions(field('Provider'), 'b2');
      await user.type(field('Region'), 'discarded-region');
      if (dismissal === 'Escape') await user.keyboard('{Escape}');
      else await user.click(within(dialog()).getByRole('button', { name: dismissal }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await openCreate(user);
      expect(field('Display name').value).toBe('');
      expect(field('Access key ID').value).toBe('');
      expect(field('Secret access key').value).toBe('');
      expect(field('Session token').value).toBe('');
      expect(field('Provider').value).toBe('r2');
      expect(field('Cloudflare account ID').value).toBe('');
      expect(field('Jurisdiction').value).toBe('');
      expect(field('Priority').value).toBe('100');
      expect(field('Capacity in bytes').value).toBe('');
      expect(within(dialog()).queryByRole('alert')).toBeNull();
      expectNoCachedCredentials();
      await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    }
  });

  it('resets after success and leaves the created account in VERIFYING state', async () => {
    const user = await setup();
    await openCreate(user);
    await fillR2(user);
    await user.click(create());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('VERIFYING', { exact: true })).toBeTruthy();
    await openCreate(user);
    expect(field('Display name').value).toBe('');
    expect(field('Access key ID').value).toBe('');
    expect(mock.verifyAccount).not.toHaveBeenCalled();
  });

  it('clears accepted credentials before waiting for the refreshed account list', async () => {
    const user = await setup();
    await openCreate(user);
    await fillR2(user);
    let release: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => { release = resolve; });
    const initialListCalls = mock.listAccounts.mock.calls.length;
    mock.listAccounts.mockImplementationOnce(async () => { await refreshGate; return accounts; });
    try {
      await user.click(create());
      await waitFor(() => expect(mock.createAccount).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(mock.listAccounts).toHaveBeenCalledTimes(initialListCalls + 1));
      await waitFor(() => expect(field('Secret access key').value).toBe(''));
      expect(field('Access key ID').value).toBe('');
      expect(field('Session token').value).toBe('');
      expect(create().disabled).toBe(true);
      expect(field('Provider').matches(':disabled')).toBe(true);
      const form = create().closest('form');
      if (!form) throw new Error('Missing create form');
      fireEvent.submit(form);
      await user.click(create());
      await user.click(within(dialog()).getByRole('button', { name: 'Close dialog' }));
      expectNoCachedCredentials();
      expect(dialog()).toBeTruthy();
      expect(mock.createAccount).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { release(); });
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
