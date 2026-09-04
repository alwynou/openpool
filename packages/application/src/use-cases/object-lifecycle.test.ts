import { describe, expect, it } from 'vitest';

import type {
  ObjectLocation,
  ProviderCapabilities,
  StorageShard,
  StoredObject,
  UploadSession,
} from '@openpool/domain';
import type { AuditLog, AuditLogEntry } from '../ports/auth';
import type {
  CredentialEnvelope,
  CredentialPayload,
  CredentialVault,
} from '../ports/credential-vault';
import type {
  BeginDeletePersistenceResult,
  Clock,
  CompleteUploadPersistenceResult,
  DownloadUrlRequest,
  ExpireUploadPersistenceResult,
  FinishDeletePersistenceResult,
  ManagedStorageAccountRepository,
  ObjectAggregate,
  ObjectListQuery,
  ObjectProviderRequest,
  ObjectRepository,
  ObjectReservationResult,
  ProviderRegistry,
  SignedDownload,
  SignedUpload,
  StorageAccountRecord,
  StorageProvider,
  StorageShardRepository,
  UploadUrlRequest,
} from '../ports/storage';
import { CreateUpload } from './create-upload';
import {
  CompleteUpload,
  CreateDownload,
  DeleteObject,
  GetObjectMetadata,
  GetUploadSession,
  ListObjectMetadata,
  SweepExpiredUploads,
} from './object-lifecycle';

const capabilities: ProviderCapabilities = {
  presignedUpload: true,
  presignedDownload: true,
  headObject: true,
  deleteObject: true,
  bucketProbe: true,
  usageProbe: false,
};

const envelope: CredentialEnvelope = {
  version: 1,
  algorithm: 'AES-256-GCM',
  keyId: 'key-1',
  iv: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'encrypted',
};

const account: StorageAccountRecord = {
  id: 'account-1',
  name: 'primary',
  provider: 'r2',
  providerConfig: {},
  status: 'ACTIVE',
  priority: 0,
  writeEnabled: true,
  capacityBytes: 10_000,
  usedBytes: 100,
  healthStatus: 'HEALTHY',
  capacityAccuracy: 'CONFIGURED',
  capabilities,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastHealthCheckedAt: '2026-01-01T00:00:00.000Z',
  credentialEnvelope: envelope,
};

const shard: StorageShard = {
  id: 'shard-1',
  logicalBucketId: 'bucket-1',
  storageAccountId: account.id,
  physicalBucket: 'tenant-physical-bucket',
  status: 'ACTIVE',
  capacityBytes: 10_000,
  usedBytes: 100,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
};

class FakeAccounts implements ManagedStorageAccountRepository {
  async create(): Promise<boolean> {
    return true;
  }
  async findById(id: string) {
    return id === account.id ? account : undefined;
  }
  async list() {
    return [account];
  }
  async listWritable() {
    return [account];
  }
  async update(): Promise<boolean> {
    return true;
  }
}

class FakeShards implements StorageShardRepository {
  async create(): Promise<boolean> {
    return true;
  }
  async findById(id: string) {
    return id === shard.id ? shard : undefined;
  }
  async findActiveByLogicalBucketId(id: string) {
    return id === shard.logicalBucketId ? shard : undefined;
  }
  async list() {
    return [shard];
  }
  async listByLogicalBucketId() {
    return [shard];
  }
  async update(): Promise<boolean> {
    return true;
  }
}

class FakeObjects implements ObjectRepository {
  readonly records = new Map<string, ObjectAggregate>();
  readonly history = new Map<string, ObjectAggregate>();
  audit?: AuditLog;
  reservationResult: ObjectReservationResult = 'RESERVED';
  completionResult?: CompleteUploadPersistenceResult;
  beginResult?: BeginDeletePersistenceResult;
  finishResult?: FinishDeletePersistenceResult;
  expiryResult?: ExpireUploadPersistenceResult;
  releasedCapacity = 0;
  events: string[] = [];

  async reserveUploadAndCapacity(
    object: StoredObject,
    primaryLocation: ObjectLocation,
    uploadSession: UploadSession,
    audit: AuditLogEntry,
    retryUploadSessionId?: string,
  ): Promise<ObjectReservationResult> {
    this.events.push('reserve');
    if (this.reservationResult !== 'RESERVED') return this.reservationResult;
    if (retryUploadSessionId !== undefined) {
      const previous = this.records.get(object.id);
      if (!previous || previous.uploadSession?.id !== retryUploadSessionId ||
        previous.object.status !== 'PENDING') return 'CONFLICT';
      if (previous.uploadSession.status === 'PENDING') {
        this.releasedCapacity += previous.object.sizeBytes;
      }
      this.history.set(retryUploadSessionId, { ...previous,
        primaryLocation: { ...previous.primaryLocation, isPrimary: false },
        uploadSession: { ...previous.uploadSession,
          status: previous.uploadSession.status === 'ABORTED' ? 'ABORTED' : 'EXPIRED' } });
    }
    this.records.set(object.id, { object, primaryLocation, uploadSession });
    await this.audit?.record(audit);
    return 'RESERVED';
  }

  async findById(id: string) {
    return this.records.get(id);
  }

  async findByLogicalKey(logicalBucketId: string, logicalKey: string) {
    return [...this.records.values()].find(
      ({ object }) =>
        object.logicalBucketId === logicalBucketId &&
        object.logicalKey === logicalKey,
    );
  }

  async list(query: ObjectListQuery) {
    return [...this.records.values()]
      .map(({ object }) => object)
      .filter(
        (object) =>
          object.logicalBucketId === query.logicalBucketId &&
          (query.status === undefined || object.status === query.status) &&
          (query.prefix === undefined ||
            object.logicalKey.startsWith(query.prefix)) &&
          (query.afterKey === undefined || object.logicalKey > query.afterKey),
      )
      .sort((left, right) => left.logicalKey.localeCompare(right.logicalKey))
      .slice(0, query.limit);
  }

  async listExpiredPendingUploads(expiredAtOrBefore: string, limit: number) {
    return [...this.records.values()]
      .filter(
        ({ object, uploadSession }) =>
          object.status === 'PENDING' &&
          uploadSession?.status === 'PENDING' &&
          uploadSession.expiresAt <= expiredAtOrBefore,
      )
      .sort((left, right) =>
        (left.uploadSession?.expiresAt ?? '').localeCompare(
          right.uploadSession?.expiresAt ?? '',
        ),
      )
      .slice(0, limit)
      .map(({ object, uploadSession }) => ({
        objectId: object.id,
        uploadSessionId: uploadSession?.id ?? '',
      }));
  }

  async listExpiredUploadsAwaitingCleanup(limit: number, cutoff: string) {
    return [...this.records.values(), ...this.history.values()]
      .filter(
        ({ uploadSession }) =>
          uploadSession?.status === 'EXPIRED' &&
          uploadSession.expiresAt <= cutoff,
      )
      .slice(0, limit)
      .map(({ object, uploadSession }) => ({
        objectId: object.id,
        uploadSessionId: uploadSession?.id ?? '',
      }));
  }

  async findUploadCleanupTarget(objectId: string, uploadSessionId: string) {
    const aggregate = this.history.get(uploadSessionId) ?? this.records.get(objectId);
    if (aggregate?.uploadSession?.id !== uploadSessionId) return undefined;
    return { location: aggregate.primaryLocation, session: aggregate.uploadSession };
  }

  async completeUpload(
    objectId: string,
    uploadSessionId: string,
    completedAt: string,
    etag: string | null,
    checksum: string | null,
    audit: AuditLogEntry,
  ): Promise<CompleteUploadPersistenceResult> {
    if (this.completionResult !== undefined) {
      if (this.completionResult === 'COMPLETED') await this.audit?.record(audit);
      return this.completionResult;
    }
    const aggregate = this.records.get(objectId);
    if (!aggregate || aggregate.uploadSession?.id !== uploadSessionId) {
      return 'NOT_FOUND';
    }
    if (
      aggregate.object.status === 'READY' &&
      aggregate.uploadSession.status === 'COMPLETED'
    ) {
      return 'ALREADY_COMPLETED';
    }
    if (
      aggregate.object.status !== 'PENDING' ||
      aggregate.uploadSession.status !== 'PENDING'
    ) {
      return 'INVALID_STATE';
    }
    this.records.set(objectId, {
      object: {
        ...aggregate.object,
        status: 'READY',
        checksum,
        updatedAt: completedAt,
      },
      primaryLocation: {
        ...aggregate.primaryLocation,
        etag,
        updatedAt: completedAt,
      },
      uploadSession: {
        ...aggregate.uploadSession,
        status: 'COMPLETED',
        completedAt,
      },
    });
    await this.audit?.record(audit);
    return 'COMPLETED';
  }

  async expireUploadAndReleaseCapacity(
    objectId: string,
    uploadSessionId: string,
    _expiredAt: string,
    audit: AuditLogEntry,
  ): Promise<ExpireUploadPersistenceResult> {
    if (this.expiryResult !== undefined) {
      if (this.expiryResult === 'EXPIRED') await this.audit?.record(audit);
      return this.expiryResult;
    }
    const aggregate = this.records.get(objectId);
    if (!aggregate || aggregate.uploadSession?.id !== uploadSessionId) {
      return 'NOT_FOUND';
    }
    if (aggregate.uploadSession.status === 'EXPIRED') return 'ALREADY_EXPIRED';
    if (
      aggregate.object.status !== 'PENDING' ||
      aggregate.uploadSession.status !== 'PENDING'
    ) {
      return 'INVALID_STATE';
    }
    this.releasedCapacity += aggregate.object.sizeBytes;
    this.records.set(objectId, {
      ...aggregate,
      uploadSession: { ...aggregate.uploadSession, status: 'EXPIRED' },
    });
    await this.audit?.record(audit);
    return 'EXPIRED';
  }

  async finishExpiredUploadCleanup(
    objectId: string,
    uploadSessionId: string,
    audit: AuditLogEntry,
  ) {
    const aggregate = this.history.get(uploadSessionId) ?? this.records.get(objectId);
    if (!aggregate || aggregate.uploadSession?.id !== uploadSessionId) {
      return 'NOT_FOUND' as const;
    }
    if (aggregate.uploadSession.status === 'ABORTED') {
      return 'ALREADY_CLEANED' as const;
    }
    if (aggregate.uploadSession.status !== 'EXPIRED') {
      return 'INVALID_STATE' as const;
    }
    const target = this.history.has(uploadSessionId) ? this.history : this.records;
    target.set(this.history.has(uploadSessionId) ? uploadSessionId : objectId, {
      ...aggregate,
      uploadSession: { ...aggregate.uploadSession, status: 'ABORTED' },
    });
    await this.audit?.record(audit);
    return 'CLEANED' as const;
  }

  async beginDelete(
    objectId: string,
    updatedAt: string,
    audit: AuditLogEntry,
  ): Promise<BeginDeletePersistenceResult> {
    if (this.beginResult !== undefined) {
      if (this.beginResult === 'STARTED') await this.audit?.record(audit);
      return this.beginResult;
    }
    const aggregate = this.records.get(objectId);
    if (!aggregate) return 'NOT_FOUND';
    if (aggregate.object.status === 'DELETING') return 'ALREADY_DELETING';
    if (aggregate.object.status === 'DELETED') return 'ALREADY_DELETED';
    if (aggregate.object.status !== 'READY') return 'INVALID_STATE';
    this.records.set(objectId, {
      ...aggregate,
      object: { ...aggregate.object, status: 'DELETING', updatedAt },
    });
    await this.audit?.record(audit);
    return 'STARTED';
  }

  async finishDeleteAndReleaseCapacity(
    objectId: string,
    updatedAt: string,
    audit: AuditLogEntry,
  ): Promise<FinishDeletePersistenceResult> {
    if (this.finishResult !== undefined) {
      if (this.finishResult === 'DELETED') await this.audit?.record(audit);
      return this.finishResult;
    }
    const aggregate = this.records.get(objectId);
    if (!aggregate) return 'NOT_FOUND';
    if (aggregate.object.status === 'DELETED') return 'ALREADY_DELETED';
    if (aggregate.object.status !== 'DELETING') return 'INVALID_STATE';
    this.releasedCapacity += aggregate.object.sizeBytes;
    this.records.set(objectId, {
      ...aggregate,
      object: { ...aggregate.object, status: 'DELETED', updatedAt },
    });
    await this.audit?.record(audit);
    return 'DELETED';
  }
}

class FakeProvider implements StorageProvider {
  readonly capabilities = capabilities;
  events: string[] = [];
  headSize = 128;
  headCalls = 0;
  deleteCalls = 0;
  failDelete = false;
  lastUpload?: UploadUrlRequest;

  async createUploadUrl(request: UploadUrlRequest): Promise<SignedUpload> {
    this.events.push('sign');
    this.lastUpload = request;
    return {
      url: 'https://storage.example/upload?signature=private',
      expiresAt: '2026-01-01T00:15:00.000Z',
    };
  }

  async createDownloadUrl(
    _request: DownloadUrlRequest,
  ): Promise<SignedDownload> {
    return {
      url: 'https://storage.example/download?signature=private',
      expiresAt: '2026-01-01T00:15:00.000Z',
    };
  }

  async headObject(_request: ObjectProviderRequest) {
    this.headCalls += 1;
    return { sizeBytes: this.headSize, etag: 'etag-1', checksum: 'sum-1' };
  }

  async deleteObject(_request: ObjectProviderRequest): Promise<void> {
    this.deleteCalls += 1;
    if (this.failDelete) throw new Error('temporary provider failure');
  }

  async validate() {
    return { capabilities };
  }

  async probe() {
    return {
      healthStatus: 'HEALTHY' as const,
      capacityBytes: 10_000,
      usedBytes: 100,
      capacityAccuracy: 'CONFIGURED' as const,
    };
  }
}

class FakeVault implements CredentialVault {
  decryptCalls = 0;
  events: string[] = [];
  async encrypt(_payload: CredentialPayload) {
    return envelope;
  }
  async decrypt() {
    this.decryptCalls += 1;
    this.events.push('decrypt');
    return { accessKeyId: 'key', secretAccessKey: 'secret' };
  }
}

class FakeAudit implements AuditLog {
  readonly actions: string[] = [];
  async record(entry: AuditLogEntry): Promise<void> {
    this.actions.push(entry.action);
  }
}

function setup() {
  const objects = new FakeObjects();
  const provider = new FakeProvider();
  const vault = new FakeVault();
  const audit = new FakeAudit();
  objects.audit = audit;
  const clock: Clock = {
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  };
  let id = 0;
  const dependencies = {
    accounts: new FakeAccounts(),
    shards: new FakeShards(),
    objects,
    providers: { forAccount: () => provider } satisfies ProviderRegistry,
    vault,
    audit,
    clock,
    ids: { next: () => ['object-1', 'location-1', 'session-1'][id++] ?? `retry-${id}` },
    provider,
  };
  return dependencies;
}

async function reserve(dependencies: ReturnType<typeof setup>) {
  return new CreateUpload(dependencies).execute({
    actorId: 'admin-1',
    bucketId: 'bucket-1',
    logicalKey: 'folder/file.bin',
    sizeBytes: 128,
    contentType: 'application/octet-stream',
  });
}

describe('object lifecycle use cases', () => {
  it('retries a pending upload with a new session/key while preserving the namespace', async () => {
    const dependencies = setup();
    const first = await reserve(dependencies);
    const oldKey = dependencies.provider.lastUpload?.key;
    dependencies.accounts.findById = async () => ({ ...account, usedBytes: 228 });
    dependencies.shards.findActiveByLogicalBucketId = async () => ({ ...shard, usedBytes: 228 });
    const result = await new CreateUpload(dependencies).execute({
      actorId: 'admin-1', bucketId: 'bucket-1', logicalKey: 'folder/file.bin',
      sizeBytes: 64, contentType: 'text/plain', retryUploadSessionId: first.uploadSessionId,
    });
    expect(result.objectId).toBe(first.objectId);
    expect(result.uploadSessionId).not.toBe(first.uploadSessionId);
    expect(dependencies.provider.lastUpload?.key).not.toBe(oldKey);
    expect(dependencies.objects.releasedCapacity).toBe(128);
    expect(dependencies.audit.actions).toEqual(['OBJECT_UPLOAD_RESERVED', 'OBJECT_UPLOAD_RETRIED']);
    await expect(new CompleteUpload(dependencies).execute({ actorId: 'admin-1',
      objectId: first.objectId, uploadSessionId: first.uploadSessionId }))
      .rejects.toMatchObject({ code: 'OBJECT_UPLOAD_NOT_FOUND' });
    expect(dependencies.provider.headCalls).toBe(0);
    await expect(new GetUploadSession(dependencies.objects).execute({ objectId: first.objectId }))
      .resolves.toMatchObject({ id: result.uploadSessionId, status: 'PENDING' });
  });

  it.each(['READY', 'DELETING', 'DELETED'] as const)('never retries a %s object', async (status) => {
    const dependencies = setup();
    const first = await reserve(dependencies);
    const aggregate = dependencies.objects.records.get(first.objectId)!;
    dependencies.objects.records.set(first.objectId, { ...aggregate,
      object: { ...aggregate.object, status } });
    await expect(new CreateUpload(dependencies).execute({ actorId: 'admin-1',
      bucketId: 'bucket-1', logicalKey: 'folder/file.bin', sizeBytes: 128,
      contentType: 'text/plain', retryUploadSessionId: first.uploadSessionId }))
      .rejects.toMatchObject({ code: 'OBJECT_INVALID_STATE' });
    expect(dependencies.vault.decryptCalls).toBe(1);
  });

  it('rejects stale retry sessions before signing or releasing capacity', async () => {
    const dependencies = setup();
    await reserve(dependencies);
    await expect(new CreateUpload(dependencies).execute({ actorId: 'admin-1',
      bucketId: 'bucket-1', logicalKey: 'folder/file.bin', sizeBytes: 128,
      contentType: 'text/plain', retryUploadSessionId: 'stale-session' }))
      .rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
    expect(dependencies.vault.decryptCalls).toBe(1);
    expect(dependencies.objects.releasedCapacity).toBe(0);
  });

  it('credits the old pending reservation when retrying at the soft capacity limit', async () => {
    const dependencies = setup();
    const first = await reserve(dependencies);
    dependencies.accounts.findById = async () => ({ ...account, usedBytes: 9000 });
    dependencies.shards.findActiveByLogicalBucketId = async () => ({ ...shard, usedBytes: 9000 });
    await expect(new CreateUpload(dependencies).execute({ actorId: 'admin-1',
      bucketId: 'bucket-1', logicalKey: 'folder/file.bin', sizeBytes: 128,
      contentType: 'text/plain', retryUploadSessionId: first.uploadSessionId }))
      .resolves.toMatchObject({ objectId: first.objectId });
  });

  it('defers superseded cleanup until the old signature grace ends and preserves new READY bytes', async () => {
    const dependencies = setup();
    const first = await reserve(dependencies);
    const oldKey = dependencies.provider.lastUpload?.key;
    dependencies.accounts.findById = async () => ({ ...account, usedBytes: 228 });
    dependencies.shards.findActiveByLogicalBucketId = async () => ({ ...shard, usedBytes: 228 });
    const retried = await new CreateUpload(dependencies).execute({ actorId: 'admin-1',
      bucketId: 'bucket-1', logicalKey: 'folder/file.bin', sizeBytes: 128,
      contentType: 'text/plain', retryUploadSessionId: first.uploadSessionId });
    await new CompleteUpload(dependencies).execute({ actorId: 'admin-1', objectId: first.objectId,
      uploadSessionId: retried.uploadSessionId });
    const sweep = new SweepExpiredUploads(dependencies);
    dependencies.clock.now = () => new Date('2026-01-01T00:19:59.999Z');
    expect((await sweep.execute()).cleanupCandidates).toBe(0);
    dependencies.clock.now = () => new Date('2026-01-01T00:20:00.000Z');
    const deletedKeys: string[] = [];
    dependencies.provider.deleteObject = async (request) => { deletedKeys.push(request.key); };
    expect((await sweep.execute()).cleaned).toBe(1);
    expect(deletedKeys).toEqual([oldKey]);
    expect(dependencies.objects.records.get(first.objectId)).toMatchObject({
      object: { status: 'READY' }, uploadSession: { id: retried.uploadSessionId, status: 'COMPLETED' },
    });
    expect(dependencies.objects.releasedCapacity).toBe(128);
    expect((await sweep.execute()).cleaned).toBe(0);
  });

  it('resolves the physical target only through the active shard and reserves atomically after signing', async () => {
    const dependencies = setup();
    dependencies.provider.events = dependencies.objects.events;
    const result = await reserve(dependencies);
    expect(result).toMatchObject({
      objectId: 'object-1',
      uploadSessionId: 'session-1',
    });
    expect(dependencies.provider.lastUpload).toMatchObject({
      bucket: 'tenant-physical-bucket',
      account: { id: 'account-1' },
    });
    expect(dependencies.objects.events).toEqual(['sign', 'reserve']);
    expect(dependencies.vault.decryptCalls).toBe(1);
    expect(dependencies.audit.actions).toEqual(['OBJECT_UPLOAD_RESERVED']);
    expect(dependencies.objects.records.get('object-1')).toMatchObject({
      primaryLocation: {
        storageShardId: 'shard-1',
        physicalBucket: 'tenant-physical-bucket',
        isPrimary: true,
      },
    });
  });

  it('does not return a generated URL after a reservation conflict', async () => {
    const dependencies = setup();
    dependencies.objects.reservationResult = 'OBJECT_CONFLICT';
    await expect(reserve(dependencies)).rejects.toMatchObject({
      code: 'OBJECT_ALREADY_EXISTS',
    });
    expect(dependencies.provider.lastUpload?.bucket).toBe(
      'tenant-physical-bucket',
    );
    expect(dependencies.audit.actions).toEqual([]);
  });

  it('validates before decrypting or signing', async () => {
    const dependencies = setup();
    await expect(
      new CreateUpload(dependencies).execute({
        actorId: 'admin-1',
        bucketId: 'bucket-1',
        logicalKey: '',
        sizeBytes: -1,
        contentType: 'text/plain',
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_INVALID_INPUT' });
    expect(dependencies.vault.decryptCalls).toBe(0);
    expect(dependencies.provider.lastUpload).toBeUndefined();
  });

  it('heads the provider, completes atomically, and makes repeat completion idempotent', async () => {
    const dependencies = setup();
    await reserve(dependencies);
    const complete = new CompleteUpload(dependencies);
    await expect(
      complete.execute({
        actorId: 'admin-1',
        objectId: 'object-1',
        uploadSessionId: 'session-1',
      }),
    ).resolves.toMatchObject({
      object: { status: 'READY', checksum: 'sum-1' },
      session: { status: 'COMPLETED' },
      alreadyCompleted: false,
    });
    await expect(
      complete.execute({
        actorId: 'admin-1',
        objectId: 'object-1',
        uploadSessionId: 'session-1',
      }),
    ).resolves.toMatchObject({ alreadyCompleted: true });
    expect(dependencies.provider.headCalls).toBe(1);
    expect(dependencies.audit.actions).toEqual([
      'OBJECT_UPLOAD_RESERVED',
      'OBJECT_UPLOAD_COMPLETED',
    ]);
  });

  it('keeps a pending upload unchanged on HEAD size mismatch or a conditional conflict', async () => {
    const mismatch = setup();
    await reserve(mismatch);
    mismatch.provider.headSize = 127;
    await expect(
      new CompleteUpload(mismatch).execute({
        actorId: 'admin-1',
        objectId: 'object-1',
        uploadSessionId: 'session-1',
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_SIZE_MISMATCH' });
    expect(mismatch.objects.records.get('object-1')?.object.status).toBe(
      'PENDING',
    );

    const conflict = setup();
    await reserve(conflict);
    conflict.objects.completionResult = 'CONFLICT';
    await expect(
      new CompleteUpload(conflict).execute({
        actorId: 'admin-1',
        objectId: 'object-1',
        uploadSessionId: 'session-1',
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
  });

  it('expires stale sessions and atomically releases their reservation before HEAD', async () => {
    const dependencies = setup();
    await reserve(dependencies);
    dependencies.clock.now = () => new Date('2026-01-01T00:15:00.000Z');
    await expect(
      new CompleteUpload(dependencies).execute({
        actorId: 'admin-1',
        objectId: 'object-1',
        uploadSessionId: 'session-1',
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_UPLOAD_EXPIRED' });
    expect(dependencies.provider.headCalls).toBe(0);
    expect(
      dependencies.objects.records.get('object-1')?.uploadSession?.status,
    ).toBe('EXPIRED');
    expect(dependencies.objects.releasedCapacity).toBe(128);
    expect(dependencies.audit.actions).toContain('OBJECT_UPLOAD_EXPIRED');
  });

  it('sweeps abandoned uploads after a grace period and retries provider cleanup', async () => {
    const dependencies = setup();
    await reserve(dependencies);
    dependencies.clock.now = () => new Date('2026-01-01T00:16:00.000Z');
    const sweep = new SweepExpiredUploads(dependencies);

    await expect(sweep.execute()).resolves.toEqual({
      pendingCandidates: 0,
      expired: 0,
      cleanupCandidates: 0,
      cleaned: 0,
      failed: 0,
    });

    dependencies.clock.now = () => new Date('2026-01-01T00:20:00.000Z');
    dependencies.provider.failDelete = true;
    await expect(sweep.execute()).resolves.toMatchObject({
      pendingCandidates: 1,
      expired: 1,
      cleanupCandidates: 1,
      cleaned: 0,
      failed: 1,
    });
    expect(dependencies.objects.releasedCapacity).toBe(128);
    expect(
      dependencies.objects.records.get('object-1')?.uploadSession?.status,
    ).toBe('EXPIRED');

    dependencies.provider.failDelete = false;
    await expect(sweep.execute()).resolves.toMatchObject({
      pendingCandidates: 0,
      expired: 0,
      cleanupCandidates: 1,
      cleaned: 1,
      failed: 0,
    });
    expect(
      dependencies.objects.records.get('object-1')?.uploadSession?.status,
    ).toBe('ABORTED');
    expect(dependencies.objects.releasedCapacity).toBe(128);
    expect(dependencies.provider.deleteCalls).toBe(2);
    expect(dependencies.audit.actions).toEqual([
      'OBJECT_UPLOAD_RESERVED',
      'OBJECT_UPLOAD_EXPIRED',
      'OBJECT_UPLOAD_ABORTED',
    ]);

    await sweep.execute();
    expect(dependencies.provider.deleteCalls).toBe(2);
  });

  it('creates downloads only for READY objects', async () => {
    const dependencies = setup();
    await reserve(dependencies);
    const download = new CreateDownload(dependencies);
    await expect(
      download.execute({ actorId: 'admin-1', objectId: 'object-1' }),
    ).rejects.toMatchObject({
      code: 'OBJECT_INVALID_STATE',
    });
    await new CompleteUpload(dependencies).execute({
      actorId: 'admin-1',
      objectId: 'object-1',
      uploadSessionId: 'session-1',
    });
    await expect(
      download.execute({ actorId: 'admin-1', objectId: 'object-1' }),
    ).resolves.toMatchObject({
      objectId: 'object-1',
      downloadUrl: 'https://storage.example/download?signature=private',
    });
    expect(dependencies.audit.actions).toContain('OBJECT_DOWNLOAD_SIGNED');
  });

  it('persists DELETING before provider deletion and safely retries it', async () => {
    const dependencies = setup();
    await reserve(dependencies);
    await new CompleteUpload(dependencies).execute({
      actorId: 'admin-1',
      objectId: 'object-1',
      uploadSessionId: 'session-1',
    });
    const deletion = new DeleteObject(dependencies);
    dependencies.provider.failDelete = true;
    await expect(
      deletion.execute({ actorId: 'admin-1', objectId: 'object-1' }),
    ).rejects.toThrow('temporary provider failure');
    expect(dependencies.objects.records.get('object-1')?.object.status).toBe(
      'DELETING',
    );
    dependencies.provider.failDelete = false;
    await expect(
      deletion.execute({ actorId: 'admin-1', objectId: 'object-1' }),
    ).resolves.toMatchObject({ status: 'DELETED' });
    expect(dependencies.provider.deleteCalls).toBe(2);
    expect(dependencies.objects.releasedCapacity).toBe(128);
    await deletion.execute({ actorId: 'admin-1', objectId: 'object-1' });
    expect(dependencies.provider.deleteCalls).toBe(2);
    expect(dependencies.audit.actions).toContain('OBJECT_DELETE_STARTED');
    expect(dependencies.audit.actions).toContain('OBJECT_DELETED');
  });

  it('gets and lists metadata from the repository mapping', async () => {
    const dependencies = setup();
    await reserve(dependencies);
    await expect(
      new GetObjectMetadata(dependencies.objects).execute({
        logicalBucketId: 'bucket-1',
        logicalKey: 'folder/file.bin',
      }),
    ).resolves.toMatchObject({ id: 'object-1' });
    await expect(
      new ListObjectMetadata(dependencies.objects).execute({
        logicalBucketId: 'bucket-1',
        prefix: 'folder/',
      }),
    ).resolves.toHaveLength(1);
    expect(dependencies.provider.headCalls).toBe(0);
  });
});
