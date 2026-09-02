import type {
  CapacityAccuracy,
  ObjectLocation,
  ProviderConfig,
  ProviderCapabilities,
  ShardMigration,
  ShardMigrationObject,
  StorageAccount,
  StorageHealthStatus,
  StoredObject,
  LogicalBucket,
  StorageShard,
  UploadSession,
  ObjectStatus,
} from '@openpool/domain';

import type {
  CredentialEnvelope,
  CredentialPayload,
} from './credential-vault';
import type { AuditLogEntry } from './auth';

export interface StorageAccountRepository {
  listWritable(): Promise<readonly StorageAccountRecord[]>;
}

/** D1 (or another outer adapter) persistence shape for a managed account. */
export interface StorageAccountRecord extends StorageAccount {
  readonly credentialEnvelope: CredentialEnvelope;
}

export interface ManagedStorageAccountRepository
  extends StorageAccountRepository {
  create(
    account: StorageAccount,
    credentialEnvelope: CredentialEnvelope,
    audit: AuditLogEntry,
  ): Promise<boolean>;
  findById(id: string): Promise<StorageAccountRecord | undefined>;
  list(): Promise<readonly StorageAccountRecord[]>;
  update(
    account: StorageAccount,
    expectedStatus: StorageAccount['status'],
    expectedUpdatedAt: string,
    audit: AuditLogEntry,
  ): Promise<boolean>;
}

/** Atomic write boundary for correcting an account before verification. */
export interface StorageAccountConfigurationRepository {
  updateVerifyingConfiguration(
    account: StorageAccount,
    credentialEnvelope: CredentialEnvelope,
    expectedUpdatedAt: string,
    audit: AuditLogEntry,
  ): Promise<boolean>;
}

export interface StorageAccountReferenceRepository {
  /** True while removal would strand a live shard or non-deleted object. */
  hasBlockingReferences(storageAccountId: string): Promise<boolean>;
}

export interface LogicalBucketRepository {
  /** Returns false when the unique bucket name (or id) already exists. */
  create(bucket: LogicalBucket, audit: AuditLogEntry): Promise<boolean>;
  findById(id: string): Promise<LogicalBucket | undefined>;
  list(): Promise<readonly LogicalBucket[]>;
}

export interface StorageShardRepository {
  /** Returns false for a duplicate or an active-shard uniqueness conflict. */
  create(shard: StorageShard, audit: AuditLogEntry): Promise<boolean>;
  findById(id: string): Promise<StorageShard | undefined>;
  findActiveByLogicalBucketId(
    logicalBucketId: string,
  ): Promise<StorageShard | undefined>;
  list(): Promise<readonly StorageShard[]>;
  listByLogicalBucketId(
    logicalBucketId: string,
  ): Promise<readonly StorageShard[]>;
  /** expectedStatus must be checked atomically by the adapter. */
  update(
    shard: StorageShard,
    expectedStatus: StorageShard['status'],
    expectedUpdatedAt: string,
    audit: AuditLogEntry,
  ): Promise<boolean>;
}

export interface ShardMigrationRepository {
  createAndCutover(
    migration: ShardMigration,
    expectedSourceUpdatedAt: string,
    expectedTargetUpdatedAt: string,
  ): Promise<CreateShardMigrationPersistenceResult>;
  findById(id: string): Promise<ShardMigration | undefined>;
  listByLogicalBucketId(
    logicalBucketId: string,
  ): Promise<readonly ShardMigration[]>;
  progress(id: string): Promise<ShardMigrationProgress | undefined>;
  claimTransfer(
    input: ClaimShardMigrationTransferInput,
  ): Promise<ClaimShardMigrationTransferPersistenceResult>;
  findTransfer(
    taskId: string,
    leaseToken: string,
  ): Promise<ShardMigrationTransferAggregate | undefined>;
  /** Bounded tasks whose primary switched but source provider cleanup remains. */
  listSourceCleanupCandidates(
    limit: number,
  ): Promise<readonly ShardMigrationTransferAggregate[]>;
  switchPrimary(
    taskId: string,
    leaseToken: string,
    etag: string | null,
    updatedAt: string,
  ): Promise<SwitchShardMigrationPrimaryResult>;
  finishSourceCleanup(
    taskId: string,
    updatedAt: string,
  ): Promise<FinishShardMigrationCleanupResult>;
  completeIfReady(
    migrationId: string,
    completedAt: string,
  ): Promise<CompleteShardMigrationResult>;
}

export type CreateShardMigrationPersistenceResult =
  | 'CREATED'
  | 'ALREADY_RUNNING'
  | 'CONFLICT';

export interface ShardMigrationProgress {
  readonly reserved: number;
  readonly switched: number;
  readonly completed: number;
  readonly failed: number;
  readonly remainingReady: number;
  readonly blocking: number;
}

export interface ClaimShardMigrationTransferInput {
  readonly migrationId: string;
  readonly taskId: string;
  readonly targetLocationId: string;
  readonly targetPhysicalKeyPrefix: string;
  readonly leaseToken: string;
  readonly leasedAt: string;
  readonly leaseExpiresAt: string;
}

export type ClaimShardMigrationTransferPersistenceResult =
  | { readonly outcome: 'CLAIMED'; readonly transfer: ShardMigrationTransferAggregate }
  | { readonly outcome: 'NONE' }
  | { readonly outcome: 'CAPACITY_UNAVAILABLE' }
  | { readonly outcome: 'CONFLICT' };

export interface ShardMigrationTransferAggregate {
  readonly migration: ShardMigration;
  readonly task: ShardMigrationObject;
  readonly object: StoredObject;
  readonly sourceLocation: ObjectLocation | null;
  readonly targetLocation: ObjectLocation;
}

export type SwitchShardMigrationPrimaryResult =
  | 'SWITCHED'
  | 'ALREADY_SWITCHED'
  | 'ALREADY_COMPLETED'
  | 'NOT_FOUND'
  | 'CONFLICT';

export type FinishShardMigrationCleanupResult =
  | 'COMPLETED'
  | 'ALREADY_COMPLETED'
  | 'NOT_FOUND'
  | 'CONFLICT';

export type CompleteShardMigrationResult =
  | 'COMPLETED'
  | 'ALREADY_COMPLETED'
  | 'BLOCKED'
  | 'NOT_FOUND'
  | 'CONFLICT';

export interface ObjectRepository {
  /**
   * Atomically inserts all upload records and reserves sizeBytes against both
   * the shard and account. The adapter must enforce namespace and capacity
   * constraints inside the same transaction.
   */
  reserveUploadAndCapacity(
    object: StoredObject,
    location: ObjectLocation,
    session: UploadSession,
  ): Promise<ObjectReservationResult>;
  findById(id: string): Promise<ObjectAggregate | undefined>;
  findByLogicalKey(
    logicalBucketId: string,
    logicalKey: string,
  ): Promise<ObjectAggregate | undefined>;
  list(query: ObjectListQuery): Promise<readonly StoredObject[]>;
  /** Returns a bounded, stable batch of still-pending sessions at/before expiry. */
  listExpiredPendingUploads(
    expiredAtOrBefore: string,
    limit: number,
  ): Promise<readonly ExpiredUploadCandidate[]>;
  /** Returns expired sessions whose provider object still needs cleanup. */
  listExpiredUploadsAwaitingCleanup(
    limit: number,
  ): Promise<readonly ExpiredUploadCandidate[]>;
  /** Atomically transitions PENDING/READY and PENDING/COMPLETED. */
  completeUpload(
    objectId: string,
    uploadSessionId: string,
    completedAt: string,
    etag: string | null,
    checksum: string | null,
  ): Promise<CompleteUploadPersistenceResult>;
  /**
   * Atomically applies PENDING -> EXPIRED to the upload session and releases
   * the account and shard reservation. Repeated expiry must not double-release.
   */
  expireUploadAndReleaseCapacity(
    objectId: string,
    uploadSessionId: string,
    expiredAt: string,
  ): Promise<ExpireUploadPersistenceResult>;
  /** Marks provider cleanup complete without releasing capacity again. */
  finishExpiredUploadCleanup(
    objectId: string,
    uploadSessionId: string,
  ): Promise<FinishExpiredUploadCleanupPersistenceResult>;
  /** Atomically applies READY -> DELETING using a conditional update. */
  beginDelete(
    objectId: string,
    updatedAt: string,
  ): Promise<BeginDeletePersistenceResult>;
  /** Atomically applies DELETING -> DELETED and releases reserved capacity. */
  finishDeleteAndReleaseCapacity(
    objectId: string,
    updatedAt: string,
  ): Promise<FinishDeletePersistenceResult>;
}

export type ObjectReservationResult =
  | 'RESERVED'
  | 'OBJECT_CONFLICT'
  | 'CAPACITY_UNAVAILABLE'
  | 'SHARD_UNAVAILABLE'
  | 'CONFLICT';

export type CompleteUploadPersistenceResult =
  | 'COMPLETED'
  | 'ALREADY_COMPLETED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'CONFLICT';

export type ExpireUploadPersistenceResult =
  | 'EXPIRED'
  | 'ALREADY_EXPIRED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'CONFLICT';

export type FinishExpiredUploadCleanupPersistenceResult =
  | 'CLEANED'
  | 'ALREADY_CLEANED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'CONFLICT';

export type BeginDeletePersistenceResult =
  | 'STARTED'
  | 'ALREADY_DELETING'
  | 'ALREADY_DELETED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'CONFLICT';

export type FinishDeletePersistenceResult =
  | 'DELETED'
  | 'ALREADY_DELETED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'CONFLICT';

export interface ObjectAggregate {
  readonly object: StoredObject;
  readonly primaryLocation: ObjectLocation;
  readonly uploadSession: UploadSession | null;
}

export interface ObjectListQuery {
  readonly logicalBucketId: string;
  readonly status?: ObjectStatus;
  readonly prefix?: string;
  readonly afterKey?: string;
  readonly limit: number;
}

export interface ExpiredUploadCandidate {
  readonly objectId: string;
  readonly uploadSessionId: string;
}

export interface UploadUrlRequest {
  readonly account: StorageAccount;
  readonly credentials: CredentialPayload;
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly expiresInSeconds: number;
}

export interface SignedUpload {
  readonly url: string;
  readonly expiresAt: string;
}

export interface DownloadUrlRequest {
  readonly account: StorageAccount;
  readonly credentials: CredentialPayload;
  readonly bucket: string;
  readonly key: string;
  readonly expiresInSeconds: number;
}

export interface SignedDownload {
  readonly url: string;
  readonly expiresAt: string;
}

export interface ObjectProviderRequest {
  readonly account: StorageAccount;
  readonly credentials: CredentialPayload;
  readonly bucket: string;
  readonly key: string;
}

export interface ProviderObjectMetadata {
  readonly sizeBytes: number;
  readonly etag: string | null;
  readonly checksum: string | null;
}

export interface StorageProvider {
  /** Exposes support without leaking an SDK type into application code. */
  readonly capabilities: ProviderCapabilities;
  createUploadUrl(request: UploadUrlRequest): Promise<SignedUpload>;
  createDownloadUrl(request: DownloadUrlRequest): Promise<SignedDownload>;
  headObject(request: ObjectProviderRequest): Promise<ProviderObjectMetadata>;
  deleteObject(request: ObjectProviderRequest): Promise<void>;
  validate(
    credentials: CredentialPayload,
    config: ProviderConfig,
  ): Promise<ProviderValidationResult>;
  probe(
    credentials: CredentialPayload,
    config: ProviderConfig,
  ): Promise<ProviderProbeResult>;
}

export interface ProviderValidationResult {
  readonly capabilities: ProviderCapabilities;
}

export interface ProviderProbeResult {
  readonly healthStatus: StorageHealthStatus;
  /** null explicitly means the provider cannot observe this value. */
  readonly capacityBytes: number | null;
  readonly usedBytes: number | null;
  readonly capacityAccuracy: CapacityAccuracy;
}

export interface ProviderRegistry {
  forAccount(account: StorageAccount): StorageProvider;
}

export interface IdGenerator {
  next(): string;
}

export interface Clock {
  now(): Date;
}
