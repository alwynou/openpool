import { describe, expect, it } from 'vitest';

import {
  ObjectStateError,
  UploadSessionStateError,
  transitionObjectStatus,
  transitionUploadSessionStatus,
  validateObjectInput,
  type StoredObject,
  type UploadSession,
} from './object';

const object: StoredObject = {
  id: 'object-1',
  logicalBucketId: 'bucket-1',
  logicalKey: 'folder/file.txt',
  sizeBytes: 12,
  contentType: 'text/plain',
  checksum: null,
  status: 'PENDING',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const session: UploadSession = {
  id: 'session-1',
  objectId: object.id,
  status: 'PENDING',
  expiresAt: '2026-01-01T00:15:00.000Z',
  createdAt: object.createdAt,
  completedAt: null,
};

describe('object lifecycle', () => {
  it('allows only the explicit object state sequence', () => {
    const ready = transitionObjectStatus(
      object,
      'READY',
      '2026-01-01T00:01:00.000Z',
    );
    const deleting = transitionObjectStatus(
      ready,
      'DELETING',
      '2026-01-01T00:02:00.000Z',
    );
    expect(
      transitionObjectStatus(
        deleting,
        'DELETED',
        '2026-01-01T00:03:00.000Z',
      ).status,
    ).toBe('DELETED');
    expect(() =>
      transitionObjectStatus(object, 'DELETING', object.updatedAt),
    ).toThrow(ObjectStateError);
  });

  it('requires a completion timestamp for completed sessions', () => {
    expect(
      transitionUploadSessionStatus(
        session,
        'COMPLETED',
        '2026-01-01T00:01:00.000Z',
      ),
    ).toMatchObject({ status: 'COMPLETED' });
    expect(() =>
      transitionUploadSessionStatus(session, 'COMPLETED', null),
    ).toThrow(RangeError);
    expect(() =>
      transitionUploadSessionStatus(
        { ...session, status: 'ABORTED' },
        'COMPLETED',
        object.updatedAt,
      ),
    ).toThrow(UploadSessionStateError);

    const expired = transitionUploadSessionStatus(session, 'EXPIRED', null);
    expect(
      transitionUploadSessionStatus(expired, 'ABORTED', null),
    ).toMatchObject({ status: 'ABORTED' });
  });

  it('validates keys, sizes, and content types', () => {
    expect(() =>
      validateObjectInput('a/b', 0, 'application/octet-stream'),
    ).not.toThrow();
    expect(() => validateObjectInput('', 1, 'text/plain')).toThrow(RangeError);
    expect(() => validateObjectInput('key', -1, 'text/plain')).toThrow(
      RangeError,
    );
    expect(() => validateObjectInput('key', 1, 'text/plain\r\nX: y')).toThrow(
      RangeError,
    );
  });
});
