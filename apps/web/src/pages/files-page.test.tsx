// @vitest-environment jsdom

import type { LogicalBucketResponse, ObjectMetadataResponse } from '@openpool/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiClientError } from '../api';
import type * as ApiModule from '../api';
import { FilesPage } from './files-page';

// Keep the real page, controls, query cache and upload workflow. Only I/O is fake;
// every API method is fail-closed unless this test explicitly configures it.
vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, api: Object.fromEntries(Object.keys(original.api).map((name) =>
    [name, vi.fn(async () => { throw new Error('Unexpected API call in page test'); })])) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mock = vi.mocked(api);
const now = '2026-09-03T00:00:00.000Z';
const buckets: LogicalBucketResponse[] = ['documents', 'photos'].map((name, index) => ({
  id: `bucket-${index + 1}`, name, description: null, createdAt: now, updatedAt: now,
}));
const pendingObject = (id = 'pending-1', key = 'reports/pending.txt'): ObjectMetadataResponse => ({
  id, logicalBucketId: 'bucket-1', logicalKey: key, sizeBytes: 5, contentType: 'text/plain',
  checksum: null, status: 'PENDING', createdAt: now, updatedAt: now,
});
const file = (name = 'source.txt') => new File(['hello'], name, { type: 'text/plain' });
const fileInput = () => screen.getByLabelText<HTMLInputElement>('File', { exact: true });
const keyInput = () => screen.getByLabelText<HTMLInputElement>('Logical key');
const bucketInput = () => screen.getByLabelText<HTMLSelectElement>('Logical bucket');
const uploadButton = (name = 'Upload') => screen.getByRole<HTMLButtonElement>('button', { name });
const rowRetry = (key: string) => within(screen.getByRole('row', { name: (name) => name.includes(key) }))
  .getByRole<HTMLButtonElement>('button', { name: 'Retry' });
function dropFile(value: File) {
  const section = screen.getByRole('heading', { name: 'Upload a file' }).closest('section');
  if (!section) throw new Error('Upload section missing');
  fireEvent.drop(section, { dataTransfer: { files: [value] } });
}

let objects: ObjectMetadataResponse[];
let client: QueryClient | undefined;
let sessions: Map<string, string>;
const unexpectedFetch = vi.fn(() => { throw new Error('Network is disabled in page tests'); });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', unexpectedFetch);
  objects = [];
  sessions = new Map();
  let sequence = 0;
  for (const operation of Object.values(mock)) operation.mockRejectedValue(new Error('Unexpected API call in page test'));
  mock.listBuckets.mockResolvedValue(buckets);
  mock.listObjects.mockImplementation(async (bucketId) => objects.filter((object) => object.logicalBucketId === bucketId));
  mock.createUpload.mockImplementation(async (bucketId, key, source) => {
    const object = objects.find((item) => item.logicalBucketId === bucketId && item.logicalKey === key) ?? pendingObject(`object-${++sequence}`, key);
    const updated = { ...object, logicalBucketId: bucketId, sizeBytes: source.size, contentType: source.type, status: 'PENDING' as const };
    objects = [...objects.filter((item) => item.id !== object.id), updated];
    const session = `session-${++sequence}`;
    sessions.set(object.id, session);
    return { objectId: object.id, uploadSessionId: session, uploadUrl: `https://provider.example/${object.id}/${session}`, expiresAt: now };
  });
  mock.getUpload.mockImplementation(async (objectId) => ({
    objectId, uploadSessionId: sessions.get(objectId) ?? 'previous-session',
    status: objects.find((object) => object.id === objectId)?.status === 'READY' ? 'COMPLETED' : 'PENDING', expiresAt: now,
  }));
  mock.uploadDirect.mockResolvedValue(undefined);
  mock.completeUpload.mockImplementation(async (objectId, uploadSessionId) => {
    const found = objects.find((object) => object.id === objectId);
    if (!found) throw new Error('Unknown fake object');
    const object = { ...found, status: 'READY' as const };
    objects = objects.map((item) => item.id === objectId ? object : item);
    return { object, uploadSessionId, alreadyCompleted: found.status === 'READY' };
  });
});

afterEach(() => {
  cleanup();
  client?.clear();
  client = undefined;
  expect(unexpectedFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function setup() {
  const user = userEvent.setup();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  render(<StrictMode><MemoryRouter initialEntries={['/files?bucket=bucket-1']}><QueryClientProvider client={client}><FilesPage /></QueryClientProvider></MemoryRouter></StrictMode>);
  await screen.findByLabelText('Logical key');
  await waitFor(() => expect(mock.listObjects).toHaveBeenCalledWith('bucket-1'));
  await waitFor(() => expect(screen.queryByLabelText('Loading')).toBeNull());
  return user;
}

async function expectReset() {
  await waitFor(() => expect(bucketInput().disabled).toBe(false));
  expect(keyInput().value).toBe('');
  expect(fileInput().value).toBe('');
  expect(fileInput().files).toHaveLength(0);
  expect(uploadButton().disabled).toBe(true);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Choose a new upload' })).toBeNull();
}

async function failConfirmation(user: ReturnType<typeof userEvent.setup>) {
  const source = file();
  mock.completeUpload.mockRejectedValueOnce(new ApiClientError('Confirmation response lost.', 'REQUEST_FAILED', 'request-confirm'));
  await user.upload(fileInput(), source);
  await user.click(uploadButton());
  await waitFor(() => expect(uploadButton('Retry confirmation').disabled).toBe(false));
  return source;
}

describe('Files page upload recovery interactions', () => {
  it('uploads directly, refreshes READY metadata and resets the complete form', async () => {
    const user = await setup();
    const source = file();
    await user.type(keyInput(), 'reports/source.txt');
    await user.upload(fileInput(), source);
    await user.click(uploadButton());
    await screen.findByText('READY', { exact: true });
    expect(mock.createUpload).toHaveBeenCalledExactlyOnceWith('bucket-1', 'reports/source.txt', source, undefined);
    expect(mock.uploadDirect).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^https:\/\/provider\.example\//u), source, 'text/plain');
    expect(mock.completeUpload).toHaveBeenCalledTimes(1);
    expect(mock.listObjects.mock.calls.length).toBeGreaterThan(1);
    expect(rowRetry('reports/source.txt').disabled).toBe(true);
    await expectReset();
  });

  it('keeps a failed PUT target and permits an explicit replacement file without creating a second object', async () => {
    const user = await setup();
    mock.uploadDirect.mockRejectedValueOnce(new ApiClientError('Transfer interrupted.'));
    await user.type(keyInput(), 'reports/source.txt');
    await user.upload(fileInput(), file());
    await user.click(uploadButton());
    await waitFor(() => expect(uploadButton('Retry upload').disabled).toBe(false));
    expect(mock.completeUpload).not.toHaveBeenCalled();
    expect(bucketInput().disabled).toBe(true);
    expect(keyInput().disabled).toBe(true);
    expect(keyInput().value).toBe('reports/source.txt');
    const replacement = file('replacement.txt');
    await user.upload(fileInput(), replacement);
    await user.click(rowRetry('reports/source.txt'));
    expect(fileInput().files?.[0]).toBe(replacement);
    await user.click(uploadButton('Retry upload'));
    await screen.findByText('READY', { exact: true });
    expect(mock.getUpload).toHaveBeenCalledExactlyOnceWith('object-1');
    expect(mock.createUpload).toHaveBeenNthCalledWith(2, 'bucket-1', 'reports/source.txt', replacement, 'session-2');
    expect(mock.uploadDirect.mock.calls[1]?.[1]).toBe(replacement);
    expect(objects).toHaveLength(1);
    await expectReset();
  });

  it('retries an uncertain confirmation on the same session without another reservation or PUT', async () => {
    const user = await setup();
    await failConfirmation(user);
    expect(screen.getByRole('alert').textContent).toContain('request-confirm');
    expect(screen.getByRole('alert').textContent).toContain('will not be uploaded again');
    await user.click(uploadButton('Retry confirmation'));
    await screen.findByText('READY', { exact: true });
    expect(mock.createUpload).toHaveBeenCalledTimes(1);
    expect(mock.uploadDirect).toHaveBeenCalledTimes(1);
    expect(mock.getUpload).not.toHaveBeenCalled();
    expect(mock.completeUpload.mock.calls).toEqual([['object-1', 'session-2'], ['object-1', 'session-2']]);
    await expectReset();
  });

  it('preserves confirmation-only recovery when Retry is clicked on the same row', async () => {
    const user = await setup();
    await failConfirmation(user);
    await user.click(rowRetry('source.txt'));
    await user.click(uploadButton('Retry confirmation'));
    await screen.findByText('READY', { exact: true });
    expect(mock.createUpload).toHaveBeenCalledTimes(1);
    expect(mock.uploadDirect).toHaveBeenCalledTimes(1);
    expect(mock.getUpload).not.toHaveBeenCalled();
    expect(mock.completeUpload).toHaveBeenCalledTimes(2);
  });

  it('locks file selection while only the transferred file confirmation is being retried', async () => {
    const user = await setup();
    const source = await failConfirmation(user);
    expect(fileInput().disabled).toBe(true);
    await user.upload(fileInput(), file('different.txt'));
    expect(fileInput().files?.[0]).toBe(source);
    await user.click(uploadButton('Retry confirmation'));
    await screen.findByText('READY', { exact: true });
    expect(mock.uploadDirect).toHaveBeenCalledTimes(1);
  });

  it('ignores drops during confirmation recovery and re-enables selection after a terminal error', async () => {
    const user = await setup();
    const source = await failConfirmation(user);
    dropFile(file('unintended.txt'));
    mock.completeUpload.mockRejectedValueOnce(new ApiClientError('Session expired.', 'OBJECT_UPLOAD_EXPIRED'));
    await user.click(uploadButton('Retry confirmation'));
    await waitFor(() => expect(uploadButton('Retry upload').disabled).toBe(false));
    expect(fileInput().disabled).toBe(false);
    await user.click(uploadButton('Retry upload'));
    await screen.findByText('READY', { exact: true });
    expect(mock.createUpload.mock.calls[1]?.[2]).toBe(source);
    expect(mock.uploadDirect.mock.calls[1]?.[1]).toBe(source);
  });

  it('blocks repeated clicks and edits while an upload request is still in flight', async () => {
    const user = await setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mock.uploadDirect.mockReturnValueOnce(gate);
    const source = file();
    await user.upload(fileInput(), source);
    try {
      await user.dblClick(uploadButton());
      await waitFor(() => expect(mock.uploadDirect).toHaveBeenCalledTimes(1));
      expect(uploadButton().disabled).toBe(true);
      expect(fileInput().disabled).toBe(true);
      expect(keyInput().disabled).toBe(true);
      expect(bucketInput().disabled).toBe(true);
      dropFile(file('ignored.txt'));
      await user.click(uploadButton());
      expect(mock.createUpload).toHaveBeenCalledTimes(1);
      expect(mock.completeUpload).not.toHaveBeenCalled();
    } finally { await act(async () => { release(); }); }
    await screen.findByText('READY', { exact: true });
    expect(mock.uploadDirect.mock.calls[0]?.[1]).toBe(source);
    await expectReset();
  });

  it('requires a file after reloading a pending row and clears it when another target is chosen', async () => {
    objects = [pendingObject(), pendingObject('pending-2', 'reports/other.txt')];
    const user = await setup();
    await user.click(rowRetry('reports/pending.txt'));
    expect(uploadButton('Retry upload').disabled).toBe(true);
    expect(screen.getByText(/Browsers cannot restore a file after a reload/u)).toBeTruthy();
    await user.upload(fileInput(), file());
    await user.click(rowRetry('reports/other.txt'));
    expect(keyInput().value).toBe('reports/other.txt');
    expect(fileInput().files).toHaveLength(0);
    expect(uploadButton('Retry upload').disabled).toBe(true);
    await user.upload(fileInput(), file('other.txt'));
    await user.click(uploadButton('Retry upload'));
    await screen.findByText('READY', { exact: true });
    expect(mock.getUpload).toHaveBeenCalledExactlyOnceWith('pending-2');
    expect(mock.createUpload).toHaveBeenCalledExactlyOnceWith('bucket-1', 'reports/other.txt', expect.any(File), 'previous-session');
  });

  it('resets the old path and file when choosing a new upload instead of retrying', async () => {
    objects = [pendingObject()];
    const user = await setup();
    await user.click(rowRetry('reports/pending.txt'));
    await user.upload(fileInput(), file());
    await user.click(screen.getByRole('button', { name: 'Choose a new upload' }));
    await expectReset();
    const next = file('fresh.txt');
    await user.upload(fileInput(), next);
    await user.click(uploadButton());
    await screen.findByText('READY', { exact: true });
    expect(mock.createUpload).toHaveBeenCalledExactlyOnceWith('bucket-1', 'fresh.txt', next, undefined);
    expect(mock.getUpload).not.toHaveBeenCalled();
  });

  it('retains a retry target on a session conflict and waits for an explicit next attempt', async () => {
    objects = [pendingObject()];
    const user = await setup();
    await user.click(rowRetry('reports/pending.txt'));
    await user.upload(fileInput(), file());
    mock.createUpload.mockRejectedValueOnce(new ApiClientError('Upload changed.', 'OBJECT_CONFLICT', 'request-conflict'));
    await user.click(uploadButton('Retry upload'));
    await waitFor(() => expect(uploadButton('Retry upload').disabled).toBe(false));
    expect(screen.getByRole('alert').textContent).toContain('resolve the conflict');
    expect(mock.createUpload).toHaveBeenCalledTimes(1);
    expect(mock.uploadDirect).not.toHaveBeenCalled();
    expect(mock.completeUpload).not.toHaveBeenCalled();
    expect(keyInput().disabled).toBe(true);
    sessions.set('pending-1', 'concurrent-session');
    await user.click(uploadButton('Retry upload'));
    await screen.findByText('READY', { exact: true });
    expect(mock.createUpload.mock.calls[1]?.[3]).toBe('concurrent-session');
  });

  it('explains a failed session lookup without implying a new reservation was created', async () => {
    objects = [pendingObject()];
    const user = await setup();
    await user.click(rowRetry('reports/pending.txt'));
    await user.upload(fileInput(), file());
    mock.getUpload.mockRejectedValueOnce(new ApiClientError('Session lookup unavailable.', 'REQUEST_FAILED', 'request-lookup'));
    await user.click(uploadButton('Retry upload'));
    await waitFor(() => expect(uploadButton('Retry upload').disabled).toBe(false));
    expect(screen.getByRole('alert').textContent).toContain('No new upload was started');
    expect(screen.getByRole('alert').textContent).toContain('request-lookup');
    expect(mock.createUpload).not.toHaveBeenCalled();
    expect(mock.uploadDirect).not.toHaveBeenCalled();
    expect(mock.completeUpload).not.toHaveBeenCalled();
    await user.click(uploadButton('Retry upload'));
    await screen.findByText('READY', { exact: true });
    expect(mock.getUpload).toHaveBeenCalledTimes(2);
    expect(mock.createUpload).toHaveBeenCalledTimes(1);
  });

  it.each(['READY', 'DELETING', 'DELETED'] as const)('never enables retry for a %s object', async (status) => {
    objects = [{ ...pendingObject(), status }];
    const user = await setup();
    const retry = rowRetry('reports/pending.txt');
    expect(retry.disabled).toBe(true);
    await user.click(retry);
    expect(keyInput().disabled).toBe(false);
    expect(uploadButton().disabled).toBe(true);
    expect(mock.getUpload).not.toHaveBeenCalled();
    expect(mock.createUpload).not.toHaveBeenCalled();
  });
});
