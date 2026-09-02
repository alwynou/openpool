import type {
  CompleteUploadResponse,
  CreateUploadResponse,
  ObjectMetadataResponse,
  UploadSessionResponse,
} from '@openpool/contracts';

export interface UploadInputSnapshot {
  readonly bucketId: string;
  readonly logicalKey: string;
  readonly file: File;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface UploadRetryTarget {
  readonly objectId: string;
  readonly bucketId: string;
  readonly logicalKey: string;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface UploadAttempt {
  readonly target: UploadRetryTarget;
  readonly uploadSessionId: string;
  readonly step: 'upload' | 'complete';
}

export interface UploadWorkflowInput {
  readonly snapshot: UploadInputSnapshot;
  readonly mode: 'new' | 'retry' | 'complete';
  readonly target?: UploadRetryTarget;
  readonly attempt?: UploadAttempt;
}

export interface UploadWorkflowPort {
  readonly createUpload: (bucketId: string, logicalKey: string, file: File, retryUploadSessionId?: string) => Promise<CreateUploadResponse>;
  readonly getUpload: (objectId: string) => Promise<UploadSessionResponse>;
  readonly uploadDirect: (uploadUrl: string, file: File, contentType: string) => Promise<void>;
  readonly completeUpload: (objectId: string, uploadSessionId: string) => Promise<CompleteUploadResponse>;
}

export class UploadStepError extends Error {
  override readonly cause: unknown;
  readonly attempt: UploadAttempt | undefined;
  readonly step: UploadFailureStep;

  constructor(cause: unknown, attempt: UploadAttempt | undefined, step: UploadFailureStep) {
    super(cause instanceof Error ? cause.message : 'The upload could not be completed.');
    this.name = 'UploadStepError';
    this.cause = cause;
    this.attempt = attempt;
    this.step = step;
  }
}

export function captureUploadInput(
  bucketId: string,
  logicalKey: string,
  file: File,
  options: { readonly preserveLogicalKey?: boolean } = {},
): UploadInputSnapshot {
  return {
    bucketId,
    logicalKey: options.preserveLogicalKey ? logicalKey : logicalKey.trim() || file.name,
    file,
    sizeBytes: file.size,
    contentType: file.type || 'application/octet-stream',
  };
}

export function retryTargetFromObject(
  bucketId: string,
  object: ObjectMetadataResponse,
): UploadRetryTarget {
  return {
    objectId: object.id,
    bucketId,
    logicalKey: object.logicalKey,
    sizeBytes: object.sizeBytes,
    contentType: object.contentType,
  };
}

export function canRetryObject(object: ObjectMetadataResponse): boolean {
  return object.status === 'PENDING';
}

export type UploadFailureStep = 'create' | 'upload' | 'complete';

const COMPLETION_REUPLOAD_CODES = new Set([
  'OBJECT_INVALID_STATE',
  'OBJECT_UPLOAD_NOT_FOUND',
  'PROVIDER_NOT_FOUND',
  'OBJECT_SIZE_MISMATCH',
]);

export function uploadFailureCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** User-facing copy for the failure boundary, including uncertain completion. */
export function uploadFailureGuidance(
  error: unknown,
  step: UploadFailureStep,
): string {
  const code = uploadFailureCode(error);
  if (code === 'OBJECT_UPLOAD_EXPIRED') {
    return 'The upload session expired. Select the file to use and retry this pending upload.';
  }
  if (code === 'OBJECT_CONFLICT' || code === 'OBJECT_ALREADY_EXISTS') {
    return 'This logical path changed while uploading. Refresh the file list and resolve the conflict before retrying.';
  }
  if (step === 'complete' && (code === 'OBJECT_UPLOAD_EXPIRED' || COMPLETION_REUPLOAD_CODES.has(code ?? ''))) {
    return 'This upload can no longer be confirmed. Retry the pending upload to obtain a fresh signed transfer.';
  }
  if (step === 'complete') {
    return 'The provider upload may have finished, but confirmation was interrupted. Retry confirmation; the existing bytes will not be uploaded again.';
  }
  if (step === 'upload') {
    return 'The upload could not be confirmed by the provider. Retry the pending upload to obtain a fresh signed transfer.';
  }
  return 'Upload setup may have reserved this path. Refresh the file list before trying again so you do not create a duplicate reservation.';
}

export function retryStepAfterFailure(
  error: unknown,
  step: UploadFailureStep,
): UploadFailureStep {
  const code = uploadFailureCode(error);
  return step === 'complete' && (code === 'OBJECT_UPLOAD_EXPIRED' || COMPLETION_REUPLOAD_CODES.has(code ?? ''))
    ? 'upload'
    : step;
}

export async function runUploadWorkflow(
  port: UploadWorkflowPort,
  input: UploadWorkflowInput,
  onAttempt?: (attempt: UploadAttempt) => void,
): Promise<CompleteUploadResponse> {
  if (input.mode === 'complete') {
    if (!input.attempt) throw new Error('No upload confirmation is available to retry.');
    try {
      return await port.completeUpload(input.attempt.target.objectId, input.attempt.uploadSessionId);
    } catch (error) {
      throw new UploadStepError(error, input.attempt, 'complete');
    }
  }

  if (input.mode === 'retry' && !input.target) {
    throw new Error('Choose a pending upload before retrying.');
  }
  const existingSession = input.mode === 'retry'
    ? await port.getUpload(input.target?.objectId ?? '')
    : undefined;
  if (existingSession?.status === 'COMPLETED' && input.target) {
    const completionAttempt: UploadAttempt = {
      target: input.target,
      uploadSessionId: existingSession.uploadSessionId,
      step: 'complete',
    };
    onAttempt?.(completionAttempt);
    try {
      return await port.completeUpload(input.target.objectId, existingSession.uploadSessionId);
    } catch (error) {
      throw new UploadStepError(error, completionAttempt, 'complete');
    }
  }

  const targetBucketId = input.mode === 'retry' && input.target ? input.target.bucketId : input.snapshot.bucketId;
  const targetLogicalKey = input.mode === 'retry' && input.target ? input.target.logicalKey : input.snapshot.logicalKey;
  let signed: CreateUploadResponse;
  try {
    signed = await port.createUpload(
      targetBucketId,
      targetLogicalKey,
      input.snapshot.file,
      input.mode === 'retry' ? existingSession?.uploadSessionId : undefined,
    );
  } catch (error) {
    throw new UploadStepError(error, undefined, 'create');
  }
  const attempt: UploadAttempt = {
    target: {
      objectId: signed.objectId,
      bucketId: targetBucketId,
      logicalKey: targetLogicalKey,
      sizeBytes: input.snapshot.sizeBytes,
      contentType: input.snapshot.contentType,
    },
    uploadSessionId: signed.uploadSessionId,
    step: 'upload',
  };
  onAttempt?.(attempt);
  try {
    await port.uploadDirect(signed.uploadUrl, input.snapshot.file, input.snapshot.contentType);
  } catch (error) {
    throw new UploadStepError(error, attempt, 'upload');
  }
  const completionAttempt = { ...attempt, step: 'complete' as const };
  onAttempt?.(completionAttempt);
  try {
    return await port.completeUpload(signed.objectId, signed.uploadSessionId);
  } catch (error) {
    throw new UploadStepError(error, completionAttempt, 'complete');
  }
}

export function uploadFailureCause(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const cause = (error as { readonly cause?: unknown }).cause;
  return cause ?? error;
}
