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

// Exercise real forms, validation, menus, dialogs and queries, with fail-closed I/O.
vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, api: Object.fromEntries(Object.keys(original.api).map((name) =>
    [name, vi.fn(async () => { throw new Error('Unexpected API call in account test'); })])) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mock = vi.mocked(api);
const now = '2026-09-03T00:00:00.000Z';
const credentials = { accessKeyId: 'test-replacement-id', secretAccessKey: 'test-replacement-secret', sessionToken: 'test-replacement-token' };
const accountFixture = (provider: StorageProviderKind = 'r2'): StorageAccountResponse => ({
  id: 'account-1', name: 'Repair account', provider,
  providerConfig: {
    validationBucket: 'original-bucket',
    ...(provider === 'r2' ? { accountId: 'test-cloudflare-account', jurisdiction: 'eu' }
      : provider === 'b2' ? { region: 'us-west-004', addressingStyle: 'path' }
        : { endpoint: 'https://storage.example', region: 'test-region', addressingStyle: 'virtual-hosted' }),
  },
  status: 'VERIFYING', priority: 100, writeEnabled: false,
  capacityBytes: 1000000000, usedBytes: 0, availableBytes: 1000000000,
  healthStatus: 'UNKNOWN', capacityAccuracy: 'CONFIGURED',
  capabilities: { presignedUpload: false, presignedDownload: false, headObject: false, deleteObject: false, bucketProbe: false, usageProbe: false },
  createdAt: now, updatedAt: now, lastHealthCheckedAt: null,
});
const dialog = () => screen.getByRole('dialog', { name: 'Edit Repair account' });
const field = (label: RegExp) => within(dialog()).getByLabelText<HTMLInputElement>(label);
const save = () => within(dialog()).getByRole<HTMLButtonElement>('button', { name: 'Save and retry verification' });
const verificationError = () => new ApiClientError('Provider rejected these credentials.', 'PROVIDER_INVALID_CREDENTIALS', 'request-verify');

let account: StorageAccountResponse;
let client: QueryClient;
const unexpectedFetch = vi.fn(() => { throw new Error('Network is disabled in account tests'); });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', unexpectedFetch);
  // jsdom lacks PointerEvent; Radix's trigger needs MouseEvent button/ctrlKey fields.
  vi.stubGlobal('PointerEvent', MouseEvent);
  // jsdom has no fullscreen API. nwsapi's native :fullscreen fallback recursively
  // calls Element.matches; Floating UI probes it when placing the real menu.
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    if (selector === ':fullscreen') return false;
    return matches.call(this, selector);
  });
  account = accountFixture();
  for (const operation of Object.values(mock)) operation.mockRejectedValue(new Error('Unexpected API call in account test'));
  mock.listAccounts.mockImplementation(async () => [account]);
  mock.updateAccountConfiguration.mockImplementation(async (id, input) => {
    if (id !== account.id) throw new Error('Wrong account target');
    if (account.status !== 'VERIFYING') throw new ApiClientError('Account is no longer verifying.', 'STORAGE_ACCOUNT_NOT_VERIFYING');
    if (input.expectedUpdatedAt !== account.updatedAt) throw new ApiClientError('Account changed.', 'STORAGE_ACCOUNT_CONFLICT', 'request-conflict');
    account = { ...account, providerConfig: input.providerConfig ?? account.providerConfig, updatedAt: new Date(Date.parse(account.updatedAt) + 1).toISOString() };
    return account;
  });
  mock.verifyAccount.mockImplementation(async (id) => {
    if (id !== account.id) throw new Error('Wrong verification target');
    account = { ...account, status: 'ACTIVE', healthStatus: 'HEALTHY', writeEnabled: true, updatedAt: new Date(Date.parse(account.updatedAt) + 1).toISOString() };
    return account;
  });
});

afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  try { expect(unexpectedFetch).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); }
});

async function setup() {
  const user = userEvent.setup();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  render(<StrictMode><MemoryRouter><QueryClientProvider client={client}><AccountsPage /></QueryClientProvider></MemoryRouter></StrictMode>);
  await screen.findByRole('button', { name: 'Actions for Repair account' });
  return user;
}

async function menu(user: ReturnType<typeof userEvent.setup>, item: string) {
  await user.click(screen.getByRole('button', { name: 'Actions for Repair account' }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

async function edit(user: ReturnType<typeof userEvent.setup>) {
  await menu(user, 'Edit configuration');
  await screen.findByRole('dialog', { name: 'Edit Repair account' });
}

async function replaceCredentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(field(/^(Access key ID|Key ID)/u), credentials.accessKeyId);
  await user.type(field(/^(Secret access key|Application key)/u), credentials.secretAccessKey);
  await user.type(field(/^Session token/u), credentials.sessionToken);
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

describe('Storage account configuration recovery', () => {
  it.each(['r2', 'b2', 's3'] as const)('repairs a failed %s account in place and retains credentials when fields are blank', async (provider) => {
    account = accountFixture(provider);
    const original = account;
    const user = await setup();
    mock.verifyAccount.mockRejectedValueOnce(verificationError());
    await menu(user, 'Verify account');
    await user.click(await screen.findByRole('button', { name: 'Edit & retry' }));
    expect(field(/^(Access key ID|Key ID)/u).value).toBe('');
    expect(field(/^(Secret access key|Application key)/u).value).toBe('');
    expect(field(/^Provider/u).disabled).toBe(true);
    await user.clear(field(/^Validation bucket/u));
    await user.type(field(/^Validation bucket/u), 'corrected-bucket');
    await user.click(save());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.updateAccountConfiguration).toHaveBeenCalledExactlyOnceWith('account-1', {
      expectedUpdatedAt: original.updatedAt, providerConfig: { ...original.providerConfig, validationBucket: 'corrected-bucket' },
    });
    expect(mock.verifyAccount.mock.calls).toEqual([['account-1'], ['account-1']]);
    expect(mock.createAccount).not.toHaveBeenCalled();
    expect(screen.getByText('ACTIVE', { exact: true })).toBeTruthy();
    expect(screen.queryByText('Provider rejected these credentials.')).toBeNull();
  });

  it('sends the complete replacement once, then clears accepted secrets even if verification fails', async () => {
    const user = await setup();
    await edit(user);
    await replaceCredentials(user);
    mock.verifyAccount.mockRejectedValueOnce(verificationError());
    await user.click(save());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain('request-verify'));
    expect(mock.updateAccountConfiguration.mock.calls[0]?.[1].credentials).toEqual(credentials);
    expect(field(/^Access key ID/u).value).toBe('');
    expect(field(/^Secret access key/u).value).toBe('');
    expect(field(/^Session token/u).value).toBe('');
    expect(within(dialog()).getByText(/Configuration saved, but verification failed/u)).toBeTruthy();
    const savedVersion = account.updatedAt;
    await user.click(save());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.updateAccountConfiguration.mock.calls[1]?.[1]).toEqual({ expectedUpdatedAt: savedVersion, providerConfig: account.providerConfig });
    expectNoCachedCredentials();
  });

  it('does not retain replacement credentials in query or mutation state after success', async () => {
    const user = await setup();
    await edit(user);
    await replaceCredentials(user);
    await user.click(save());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expectNoCachedCredentials();
  });

  it.each([
    ['Access key ID', 'Enter the replacement secret access key.'],
    ['Secret access key', 'Enter the replacement access key ID.'],
    ['Session token', 'Enter the replacement access key ID.'],
  ])('rejects a partial replacement containing only %s without sending a request', async (label, message) => {
    const user = await setup();
    await edit(user);
    await user.type(field(new RegExp(`^${label}`, 'u')), 'test-partial-value');
    await user.click(save());
    expect(await within(dialog()).findByText(message)).toBeTruthy();
    expect(mock.updateAccountConfiguration).not.toHaveBeenCalled();
    expect(mock.verifyAccount).not.toHaveBeenCalled();
  });

  it('omits the optional session token when replacing the other credentials and removes an empty jurisdiction', async () => {
    const user = await setup();
    await edit(user);
    await user.type(field(/^Access key ID/u), credentials.accessKeyId);
    await user.type(field(/^Secret access key/u), credentials.secretAccessKey);
    await user.selectOptions(within(dialog()).getByLabelText('Jurisdiction'), '');
    await user.click(save());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.updateAccountConfiguration.mock.calls[0]?.[1]).toEqual({
      expectedUpdatedAt: now,
      providerConfig: { accountId: 'test-cloudflare-account', validationBucket: 'original-bucket' },
      credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey },
    });
  });

  it('keeps unsaved values on a save failure and never starts verification', async () => {
    const user = await setup();
    await edit(user);
    await replaceCredentials(user);
    mock.updateAccountConfiguration.mockRejectedValueOnce(new ApiClientError('Save unavailable.', 'REQUEST_FAILED', 'request-save'));
    await user.click(save());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain('request-save'));
    expect(field(/^Secret access key/u).value).toBe(credentials.secretAccessKey);
    expect(mock.verifyAccount).not.toHaveBeenCalled();
    expectNoCachedCredentials();
    await user.click(save());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.updateAccountConfiguration.mock.calls[1]?.[1].expectedUpdatedAt).toBe(now);
  });

  it('blocks duplicate submits, input edits and dismissal until saving and verification finish', async () => {
    const user = await setup();
    await edit(user);
    await replaceCredentials(user);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const update = mock.updateAccountConfiguration.getMockImplementation();
    if (!update) throw new Error('Missing fake update');
    mock.updateAccountConfiguration.mockImplementationOnce(async (...args) => { await gate; return update(...args); });
    try {
      await user.dblClick(save());
      await waitFor(() => expect(mock.updateAccountConfiguration).toHaveBeenCalledTimes(1));
      expect(save().disabled).toBe(true);
      expect(field(/^Validation bucket/u).matches(':disabled')).toBe(true);
      expect(field(/^Secret access key/u).matches(':disabled')).toBe(true);
      expectNoCachedCredentials();
      // Native submit events must also be ignored while the first request is pending.
      const form = save().closest('form');
      if (!form) throw new Error('Missing form');
      fireEvent.submit(form);
      await user.keyboard('{Escape}');
      await user.click(within(dialog()).getByRole('button', { name: 'Close dialog' }));
      expect(dialog()).toBeTruthy();
      expect(mock.updateAccountConfiguration).toHaveBeenCalledTimes(1);
      expect(mock.verifyAccount).not.toHaveBeenCalled();
    } finally { await act(async () => { release(); }); }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.verifyAccount).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit reload after a concurrent edit instead of resubmitting a stale version', async () => {
    const user = await setup();
    await edit(user);
    await replaceCredentials(user);
    account = { ...account, updatedAt: '2026-09-03T00:01:00.000Z', providerConfig: { ...account.providerConfig, validationBucket: 'concurrent-bucket' } };
    await user.click(save());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain('request-conflict'));
    expect(mock.verifyAccount).not.toHaveBeenCalled();
    expect(save().disabled).toBe(true);
    expect(field(/^Validation bucket/u).value).toBe('original-bucket');
    await user.click(within(dialog()).getByRole('button', { name: 'Reload latest configuration' }));
    await waitFor(() => expect(field(/^Validation bucket/u).value).toBe('concurrent-bucket'));
    expect(field(/^Secret access key/u).value).toBe('');
    expect(within(dialog()).queryByRole('alert')).toBeNull();
    await user.click(save());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.updateAccountConfiguration.mock.calls[1]?.[1]).toEqual({
      providerConfig: account.providerConfig, expectedUpdatedAt: '2026-09-03T00:01:00.000Z',
    });
  });

  it('keeps the editor locked after saving while verification is still pending', async () => {
    const user = await setup();
    await edit(user);
    await replaceCredentials(user);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mock.verifyAccount.mockImplementationOnce(async () => { await gate; throw verificationError(); });
    try {
      await user.click(save());
      await waitFor(() => expect(mock.verifyAccount).toHaveBeenCalledTimes(1));
      expect(field(/^Secret access key/u).value).toBe('');
      expect(field(/^Validation bucket/u).matches(':disabled')).toBe(true);
      expect(save().disabled).toBe(true);
      expectNoCachedCredentials();
      await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
      await user.keyboard('{Escape}');
      expect(dialog()).toBeTruthy();
      expect(mock.updateAccountConfiguration).toHaveBeenCalledTimes(1);
    } finally { await act(async () => { release(); }); }
    await waitFor(() => expect(save().disabled).toBe(false));
    expect(within(dialog()).getByText(/Configuration saved, but verification failed/u)).toBeTruthy();
  });

  it('retains the stale-version lock and shows errors if reloading fails', async () => {
    const user = await setup();
    await edit(user);
    account = { ...account, updatedAt: '2026-09-03T00:01:00.000Z' };
    await user.click(save());
    const reloadButton = await within(dialog()).findByRole('button', { name: 'Reload latest configuration' });
    mock.listAccounts.mockRejectedValueOnce(new ApiClientError('Reload unavailable.', 'REQUEST_FAILED', 'request-reload'));
    await user.click(reloadButton);
    expect(await within(dialog()).findByText('Reload unavailable.')).toBeTruthy();
    expect(within(dialog()).getByText(/request-reload/u)).toBeTruthy();
    expect(save().disabled).toBe(true);
    expect(mock.updateAccountConfiguration).toHaveBeenCalledTimes(1);
    expect(mock.verifyAccount).not.toHaveBeenCalled();
    await user.click(reloadButton);
    await waitFor(() => expect(save().disabled).toBe(false));
    expect(within(dialog()).queryByRole('alert')).toBeNull();
  });

  it('prevents opening an editor while a row verification retry is pending', async () => {
    const user = await setup();
    mock.verifyAccount.mockRejectedValueOnce(verificationError());
    await menu(user, 'Verify account');
    const editButton = await screen.findByRole<HTMLButtonElement>('button', { name: 'Edit & retry' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const verify = mock.verifyAccount.getMockImplementation();
    if (!verify) throw new Error('Missing fake verification');
    mock.verifyAccount.mockImplementationOnce(async (id) => { await gate; return verify(id); });
    try {
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(mock.verifyAccount).toHaveBeenCalledTimes(2));
      expect(editButton.disabled).toBe(true);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Actions for Repair account' }).disabled).toBe(true);
      await user.click(editButton);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(mock.updateAccountConfiguration).not.toHaveBeenCalled();
    } finally { await act(async () => { release(); }); }
    await screen.findByText('ACTIVE', { exact: true });
    expect(screen.queryByRole('button', { name: 'Edit & retry' })).toBeNull();
  });

  it('opens the recovery editor through keyboard menu navigation', async () => {
    const user = await setup();
    act(() => screen.getByRole('button', { name: 'Actions for Repair account' }).focus());
    await user.keyboard('{Enter}{ArrowDown}{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Edit Repair account' })).toBeTruthy();
    expect(field(/^Secret access key/u).value).toBe('');
    expect(mock.verifyAccount).not.toHaveBeenCalled();
  });

  it('closes the recovery editor when a fresh reload shows another operation activated the account', async () => {
    const user = await setup();
    await edit(user);
    account = { ...account, status: 'ACTIVE' };
    await user.click(save());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain('no longer verifying'));
    expect(save().disabled).toBe(true);
    await user.click(within(dialog()).getByRole('button', { name: 'Reload latest configuration' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('ACTIVE', { exact: true })).toBeTruthy();
    expect(mock.verifyAccount).not.toHaveBeenCalled();
    expect(mock.updateAccountConfiguration).toHaveBeenCalledTimes(1);
  });

  it('discards unsaved credentials on cancel and does not carry them into another edit', async () => {
    const user = await setup();
    await edit(user);
    await replaceCredentials(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await edit(user);
    expect(field(/^Access key ID/u).value).toBe('');
    expect(field(/^Secret access key/u).value).toBe('');
    expect(field(/^Session token/u).value).toBe('');
    expect(mock.updateAccountConfiguration).not.toHaveBeenCalled();
    expect(mock.verifyAccount).not.toHaveBeenCalled();
  });

  it.each(['ACTIVE', 'DRAINING', 'READ_ONLY', 'REMOVED'] as const)('does not offer configuration repair or verification for %s accounts', async (status) => {
    account = { ...account, status };
    const user = await setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Repair account' }));
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Edit configuration' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Verify account' })).toBeNull();
  });
});
