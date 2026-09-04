import type { CompleteUploadResponse, CreateUploadResponse, ObjectMetadataResponse, UploadSessionResponse } from '@openpool/sdk';
import { CliFailure } from './errors.js';

export function protocol(): never {
  throw new CliFailure('PROTOCOL_ERROR', 'OpenPool returned inconsistent or invalid public metadata.');
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) protocol();
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) protocol();
  return value;
}

export function metadata(value: unknown): ObjectMetadataResponse {
  const object = record(value);
  const status = object.status;
  if (status !== 'PENDING' && status !== 'READY' && status !== 'DELETING' && status !== 'DELETED') protocol();
  if (typeof object.sizeBytes !== 'number' || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 0) protocol();
  if (object.checksum !== null && typeof object.checksum !== 'string') protocol();
  // Select public fields rather than printing an unchecked SDK response.
  return {
    id: string(object.id), logicalBucketId: string(object.logicalBucketId), logicalKey: string(object.logicalKey),
    sizeBytes: object.sizeBytes, contentType: string(object.contentType), checksum: object.checksum,
    status, createdAt: string(object.createdAt), updatedAt: string(object.updatedAt),
  };
}

export function uploadSummary(value: unknown, objectId: string): UploadSessionResponse {
  const session = record(value);
  const status = session.status;
  if (session.objectId !== objectId || (status !== 'PENDING' && status !== 'COMPLETED' && status !== 'EXPIRED' && status !== 'ABORTED')) protocol();
  return { objectId, uploadSessionId: string(session.uploadSessionId), status, expiresAt: string(session.expiresAt) };
}

export function reservation(value: unknown): CreateUploadResponse {
  const upload = record(value);
  return { objectId: string(upload.objectId), uploadSessionId: string(upload.uploadSessionId),
    uploadUrl: string(upload.uploadUrl), expiresAt: string(upload.expiresAt) };
}

export function completion(value: unknown, objectId: string, sessionId: string): CompleteUploadResponse {
  const response = record(value);
  const object = metadata(response.object);
  if (object.id !== objectId || object.status !== 'READY' || response.uploadSessionId !== sessionId || typeof response.alreadyCompleted !== 'boolean') protocol();
  return { object, uploadSessionId: sessionId, alreadyCompleted: response.alreadyCompleted };
}
