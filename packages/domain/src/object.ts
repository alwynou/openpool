export const objectStatuses = [
  'PENDING',
  'READY',
  'DELETING',
  'DELETED',
] as const;

export type ObjectStatus = (typeof objectStatuses)[number];

export interface StoredObject {
  readonly id: string;
  readonly logicalBucketId: string;
  readonly logicalKey: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly checksum: string | null;
  readonly status: ObjectStatus;
  readonly createdAt: string;
}

export interface ObjectLocation {
  readonly objectId: string;
  readonly storageAccountId: string;
  readonly physicalBucket: string;
  readonly physicalKey: string;
  readonly etag: string | null;
}
