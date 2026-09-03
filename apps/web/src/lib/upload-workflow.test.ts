import { describe, expect, it } from 'vitest';
import type { ObjectMetadataResponse } from '@openpool/contracts';

import {
  canRetryObject,
  captureUploadInput,
  retryTargetFromObject,
  retryStepAfterFailure,
  runUploadWorkflow,
  UploadStepError,
  uploadFailureGuidance,
} from './upload-workflow';

const pendingObject: ObjectMetadataResponse = {
  id: 'object-1',
  logicalBucketId: 'bucket-1',
  logicalKey: 'reports/2026.pdf',
  sizeBytes: 12,
  contentType: 'application/pdf',
  checksum: null,
  status: 'PENDING',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('upload workflow', () => {
  it('captures immutable form inputs and falls back to the file name', () => {
    const file = new File(['bytes'], 'notes.txt', { type: 'text/plain' });
    const input = captureUploadInput('bucket-1', '  ', file);

    expect(input).toMatchObject({
      bucketId: 'bucket-1',
      logicalKey: 'notes.txt',
      sizeBytes: 5,
      contentType: 'text/plain',
      file,
    });
    expect(captureUploadInput('bucket-1', '  exact/key  ', file, { preserveLogicalKey: true }).logicalKey).toBe('  exact/key  ');
  });

  it('only exposes pending objects as retryable and preserves their logical target', () => {
    expect(canRetryObject(pendingObject)).toBe(true);
    expect(canRetryObject({ ...pendingObject, status: 'READY' })).toBe(false);
    expect(retryTargetFromObject('bucket-1', pendingObject)).toEqual({
      objectId: 'object-1',
      bucketId: 'bucket-1',
      logicalKey: 'reports/2026.pdf',
      sizeBytes: 12,
      contentType: 'application/pdf',
    });
  });

  it('gives specific guidance for expiry, conflict, and uncertain completion', () => {
    expect(uploadFailureGuidance({ code: 'OBJECT_UPLOAD_EXPIRED' }, 'upload')).toContain('expired');
    expect(uploadFailureGuidance({ code: 'OBJECT_CONFLICT' }, 'create')).toContain('conflict');
    expect(uploadFailureGuidance(new Error('network'), 'complete')).toContain('will not be uploaded again');
  });

  it.each(['EXPIRED', 'ABORTED'] as const)('replaces a %s session using its current session ID', async (status) => {
    const calls: string[] = [];
    const file = new File(['replacement'], 'replacement.bin', { type: 'application/octet-stream' });
    const port = {
      getUpload: async () => { calls.push('get'); return { ...sessionResponse, status }; },
      createUpload: async (_bucketId: string, logicalKey: string, _file: File, retrySessionId?: string) => {
        calls.push(`create:${logicalKey}:${retrySessionId}`);
        return reservation;
      },
      uploadDirect: async () => { calls.push('put'); },
      completeUpload: async () => { calls.push('complete'); return completion; },
    };

    await runUploadWorkflow(port, {
      mode: 'retry',
      target: retryTargetFromObject('bucket-1', pendingObject),
      snapshot: captureUploadInput('bucket-1', 'replacement.bin', file),
    });
    expect(calls).toEqual(['get', 'create:reports/2026.pdf:upload-session-1', 'put', 'complete']);
  });

  it('stops after a reservation failure without transferring bytes', async () => {
    const calls: string[] = [];
    const port = {
      createUpload: async () => { calls.push('create'); throw new Error('capacity'); },
      getUpload: async () => { calls.push('get'); return sessionResponse; },
      uploadDirect: async () => { calls.push('put'); },
      completeUpload: async () => { calls.push('complete'); return completion; },
    };

    await expect(runUploadWorkflow(port, {
      mode: 'new',
      snapshot: captureUploadInput('bucket-1', 'new.bin', new File(['new'], 'new.bin')),
    })).rejects.toMatchObject({ step: 'create' });
    expect(calls).toEqual(['create']);
  });

  it('retains the upload attempt after PUT failure and does not call complete', async () => {
    const calls: string[] = [];
    const port = {
      createUpload: async () => { calls.push('create'); return reservation; },
      getUpload: async () => { calls.push('get'); return sessionResponse; },
      uploadDirect: async () => { calls.push('put'); throw new Error('transfer uncertain'); },
      completeUpload: async () => { calls.push('complete'); return completion; },
    };

    const failure = runUploadWorkflow(port, {
      mode: 'new',
      snapshot: captureUploadInput('bucket-1', 'new.bin', new File(['new'], 'new.bin')),
    });
    await expect(failure).rejects.toBeInstanceOf(UploadStepError);
    await expect(failure).rejects.toMatchObject({ step: 'upload', attempt: { uploadSessionId: 'upload-session-2' } });
    expect(calls).toEqual(['create', 'put']);
  });

  it('retries uncertain completion without uploading bytes again', async () => {
    const calls: string[] = [];
    const port = {
      createUpload: async () => { calls.push('create'); return reservation; },
      getUpload: async () => { calls.push('get'); return sessionResponse; },
      uploadDirect: async () => { calls.push('put'); },
      completeUpload: async () => { calls.push('complete'); throw new Error('network'); },
    };
    const attempts: string[] = [];
    const input = { mode: 'new' as const, snapshot: captureUploadInput('bucket-1', 'new.bin', new File(['new'], 'new.bin')) };
    let failedAttempt: UploadStepError['attempt'];
    try {
      await runUploadWorkflow(port, input, (attempt) => attempts.push(attempt.step));
      throw new Error('Expected completion failure');
    } catch (error) {
      if (!(error instanceof UploadStepError) || !error.attempt) throw error;
      failedAttempt = error.attempt;
    }
    expect(attempts).toEqual(['upload', 'complete']);
    expect(calls).toEqual(['create', 'put', 'complete']);
    if (!failedAttempt) throw new Error('Expected an upload attempt');

    const retryPort = {
      ...port,
      completeUpload: async () => { calls.push('complete-retry'); return completion; },
    };
    await runUploadWorkflow(retryPort, {
      mode: 'complete',
      attempt: failedAttempt,
      snapshot: input.snapshot,
    });
    expect(calls).toEqual(['create', 'put', 'complete', 'complete-retry']);
  });

  it('reconciles a completed lookup by confirming only, without creating or uploading', async () => {
    const calls: string[] = [];
    const port = {
      getUpload: async () => { calls.push('get'); return { ...sessionResponse, status: 'COMPLETED' as const }; },
      createUpload: async () => { calls.push('create'); return reservation; },
      uploadDirect: async () => { calls.push('put'); },
      completeUpload: async () => { calls.push('complete'); return completion; },
    };
    await runUploadWorkflow(port, {
      mode: 'retry',
      target: retryTargetFromObject('bucket-1', pendingObject),
      snapshot: captureUploadInput('bucket-1', 'replacement.bin', new File(['replacement'], 'replacement.bin')),
    });
    expect(calls).toEqual(['get', 'complete']);
  });

  it('surfaces lookup failures without starting a new upload', async () => {
    const calls: string[] = [];
    const lookupError = Object.assign(new Error('upload session unavailable'), { code: 'OBJECT_UPLOAD_NOT_FOUND' });
    const port = {
      getUpload: async () => { calls.push('get'); throw lookupError; },
      createUpload: async () => { calls.push('create'); return reservation; },
      uploadDirect: async () => { calls.push('put'); },
      completeUpload: async () => { calls.push('complete'); return completion; },
    };

    await expect(runUploadWorkflow(port, {
      mode: 'retry',
      target: retryTargetFromObject('bucket-1', pendingObject),
      snapshot: captureUploadInput('bucket-1', 'replacement.bin', new File(['replacement'], 'replacement.bin')),
    })).rejects.toMatchObject({
      name: 'UploadStepError',
      step: 'lookup',
      cause: lookupError,
    });
    expect(calls).toEqual(['get']);
    expect(uploadFailureGuidance(lookupError, 'lookup')).toContain('No new upload was started');
  });

  it.each([
    'OBJECT_INVALID_STATE',
    'OBJECT_UPLOAD_NOT_FOUND',
    'PROVIDER_NOT_FOUND',
    'OBJECT_SIZE_MISMATCH',
  ])('falls back to reupload after terminal completion error %s', (code) => {
    expect(retryStepAfterFailure({ code }, 'complete')).toBe('upload');
  });
});

const sessionResponse = {
  objectId: 'object-1',
  uploadSessionId: 'upload-session-1',
  status: 'PENDING' as const,
  expiresAt: '2026-09-01T00:10:00.000Z',
};

const reservation = {
  objectId: 'object-1',
  uploadSessionId: 'upload-session-2',
  uploadUrl: 'https://provider.example/object-1?signature=retry',
  expiresAt: '2026-09-01T00:10:00.000Z',
};

const completion = {
  object: { ...pendingObject, status: 'READY' as const },
  uploadSessionId: 'upload-session-2',
  alreadyCompleted: false,
};
