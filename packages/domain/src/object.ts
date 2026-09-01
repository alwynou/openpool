export const objectStatuses = [
  'PENDING',
  'READY',
  'DELETING',
  'DELETED',
] as const;

export type ObjectStatus = (typeof objectStatuses)[number];

export const uploadSessionStatuses = [
  'PENDING',
  'COMPLETED',
  'EXPIRED',
  'ABORTED',
] as const;

export type UploadSessionStatus = (typeof uploadSessionStatuses)[number];

export interface StoredObject {
  readonly id: string;
  readonly logicalBucketId: string;
  readonly logicalKey: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly checksum: string | null;
  readonly status: ObjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ObjectLocation {
  readonly id: string;
  readonly objectId: string;
  readonly storageAccountId: string;
  readonly storageShardId: string;
  readonly physicalBucket: string;
  readonly physicalKey: string;
  readonly etag: string | null;
  readonly isPrimary: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UploadSession {
  readonly id: string;
  readonly objectId: string;
  readonly status: UploadSessionStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

const objectTransitions: Readonly<
  Record<ObjectStatus, readonly ObjectStatus[]>
> = {
  PENDING: ['READY'],
  READY: ['DELETING'],
  DELETING: ['DELETED'],
  DELETED: [],
};

const uploadSessionTransitions: Readonly<
  Record<UploadSessionStatus, readonly UploadSessionStatus[]>
> = {
  PENDING: ['COMPLETED', 'EXPIRED', 'ABORTED'],
  COMPLETED: [],
  /** Cleanup turns an expired reservation into a terminal aborted upload. */
  EXPIRED: ['ABORTED'],
  ABORTED: [],
};

export class ObjectStateError extends Error {
  readonly code = 'INVALID_OBJECT_STATE_TRANSITION' as const;

  constructor(
    readonly from: ObjectStatus,
    readonly to: ObjectStatus,
  ) {
    super(`Cannot transition object from ${from} to ${to}`);
    this.name = 'ObjectStateError';
  }
}

export class UploadSessionStateError extends Error {
  readonly code = 'INVALID_UPLOAD_SESSION_STATE_TRANSITION' as const;

  constructor(
    readonly from: UploadSessionStatus,
    readonly to: UploadSessionStatus,
  ) {
    super(`Cannot transition upload session from ${from} to ${to}`);
    this.name = 'UploadSessionStateError';
  }
}

export function transitionObjectStatus(
  object: StoredObject,
  status: ObjectStatus,
  updatedAt: string,
): StoredObject {
  if (!objectTransitions[object.status].includes(status)) {
    throw new ObjectStateError(object.status, status);
  }
  return { ...object, status, updatedAt };
}

export function transitionUploadSessionStatus(
  session: UploadSession,
  status: UploadSessionStatus,
  completedAt: string | null,
): UploadSession {
  if (!uploadSessionTransitions[session.status].includes(status)) {
    throw new UploadSessionStateError(session.status, status);
  }
  if (status === 'COMPLETED' && completedAt === null) {
    throw new RangeError('A completed upload session needs a completion time');
  }
  if (status !== 'COMPLETED' && completedAt !== null) {
    throw new RangeError('Only a completed upload session has a completion time');
  }
  return { ...session, status, completedAt };
}

export function validateObjectInput(
  logicalKey: string,
  sizeBytes: number,
  contentType: string,
): void {
  if (
    logicalKey.length === 0 ||
    logicalKey.length > 1_024 ||
    [...logicalKey].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw new RangeError('Logical object key is invalid');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new RangeError('Object size must be a non-negative safe integer');
  }
  if (
    contentType.length === 0 ||
    contentType.length > 255 ||
    /[\r\n\0]/u.test(contentType)
  ) {
    throw new RangeError('Object content type is invalid');
  }
}
