import {
  objectStatuses,
  transitionObjectStatus,
  transitionUploadSessionStatus,
  type StoredObject,
  type UploadSession,
} from '@openpool/domain';

import type { AuditLog } from '../ports/auth';
import type { CredentialVault } from '../ports/credential-vault';
import type {
  Clock,
  ManagedStorageAccountRepository,
  ObjectAggregate,
  ObjectListQuery,
  ObjectRepository,
  ProviderRegistry,
} from '../ports/storage';
import { objectError } from './object-errors';

const DOWNLOAD_URL_TTL_SECONDS = 900;
const EXPIRY_SWEEP_BATCH_LIMIT = 100;
const EXPIRY_SWEEP_GRACE_MILLISECONDS = 5 * 60 * 1_000;

interface ObjectProviderDependencies {
  readonly accounts: Pick<ManagedStorageAccountRepository, 'findById'>;
  readonly objects: ObjectRepository;
  readonly providers: ProviderRegistry;
  readonly vault: CredentialVault;
  readonly clock: Clock;
}

function assertIdentifier(value: string, label: string): void {
  if (!value.trim()) {
    throw objectError('OBJECT_INVALID_INPUT', `${label} is required`);
  }
}

function requireUploadSession(
  aggregate: ObjectAggregate,
  uploadSessionId: string,
): UploadSession {
  const session = aggregate.uploadSession;
  if (!session || session.id !== uploadSessionId) {
    throw objectError('OBJECT_UPLOAD_NOT_FOUND', 'Upload session was not found');
  }
  return session;
}

async function requireAggregate(
  objects: Pick<ObjectRepository, 'findById'>,
  objectId: string,
): Promise<ObjectAggregate> {
  const aggregate = await objects.findById(objectId);
  if (!aggregate) {
    throw objectError('OBJECT_NOT_FOUND', 'Object was not found');
  }
  return aggregate;
}

async function requireProviderContext(
  dependencies: Pick<
    ObjectProviderDependencies,
    'accounts' | 'providers'
  >,
  aggregate: ObjectAggregate,
  capability: 'presignedDownload' | 'headObject' | 'deleteObject',
) {
  const account = await dependencies.accounts.findById(
    aggregate.primaryLocation.storageAccountId,
  );
  if (!account) {
    throw objectError(
      'OBJECT_STORAGE_ACCOUNT_NOT_FOUND',
      'Object storage account was not found',
    );
  }
  const provider = dependencies.providers.forAccount(account);
  if (
    account.status === 'REMOVED' ||
    !account.capabilities[capability] ||
    !provider.capabilities[capability]
  ) {
    throw objectError(
      'OBJECT_STORAGE_ACCOUNT_UNAVAILABLE',
      'Object storage account cannot perform this operation',
    );
  }
  return { account, provider };
}

export interface CompleteUploadCommand {
  readonly actorId: string;
  readonly actorType?: 'ADMIN' | 'API_KEY';
  readonly objectId: string;
  readonly uploadSessionId: string;
}

export interface CompleteUploadResult {
  readonly object: StoredObject;
  readonly session: UploadSession;
  readonly alreadyCompleted: boolean;
}

export class CompleteUpload {
  constructor(private readonly dependencies: ObjectProviderDependencies) {}

  async execute(command: CompleteUploadCommand): Promise<CompleteUploadResult> {
    assertIdentifier(command.actorId, 'Actor');
    assertIdentifier(command.objectId, 'Object');
    assertIdentifier(command.uploadSessionId, 'Upload session');
    const aggregate = await requireAggregate(
      this.dependencies.objects,
      command.objectId,
    );
    const session = requireUploadSession(aggregate, command.uploadSessionId);
    if (
      aggregate.object.status === 'READY' &&
      session.status === 'COMPLETED'
    ) {
      return { object: aggregate.object, session, alreadyCompleted: true };
    }
    if (
      aggregate.object.status !== 'PENDING' ||
      session.status !== 'PENDING'
    ) {
      throw objectError(
        'OBJECT_INVALID_STATE',
        'Only a pending upload can be completed',
      );
    }
    const now = this.dependencies.clock.now();
    const expiresAt = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw objectError(
        'OBJECT_PROVIDER_RESPONSE_INVALID',
        'Upload session has an invalid expiry',
      );
    }
    if (now.getTime() >= expiresAt) {
      const expiry =
        await this.dependencies.objects.expireUploadAndReleaseCapacity(
          aggregate.object.id,
          session.id,
          now.toISOString(),
          {
            actorType: command.actorType ?? 'ADMIN',
            actorId: command.actorId,
            action: 'OBJECT_UPLOAD_EXPIRED',
            resourceType: 'OBJECT',
            resourceId: aggregate.object.id,
            createdAt: now.toISOString(),
          },
        );
      if (expiry === 'EXPIRED' || expiry === 'ALREADY_EXPIRED') {
        throw objectError('OBJECT_UPLOAD_EXPIRED', 'Upload session has expired');
      }
      throw objectError(
        expiry === 'NOT_FOUND'
          ? 'OBJECT_UPLOAD_NOT_FOUND'
          : expiry === 'INVALID_STATE'
            ? 'OBJECT_INVALID_STATE'
            : 'OBJECT_CONFLICT',
        'Upload changed while expiry was being recorded',
      );
    }
    const { account, provider } = await requireProviderContext(
      this.dependencies,
      aggregate,
      'headObject',
    );
    const metadata = await provider.headObject({
      account,
      credentials: await this.dependencies.vault.decrypt(
        account.credentialEnvelope,
      ),
      bucket: aggregate.primaryLocation.physicalBucket,
      key: aggregate.primaryLocation.physicalKey,
    });
    if (
      !Number.isSafeInteger(metadata.sizeBytes) ||
      metadata.sizeBytes < 0
    ) {
      throw objectError(
        'OBJECT_PROVIDER_RESPONSE_INVALID',
        'Provider returned invalid object metadata',
      );
    }
    if (metadata.sizeBytes !== aggregate.object.sizeBytes) {
      throw objectError(
        'OBJECT_SIZE_MISMATCH',
        'Uploaded object size does not match the reservation',
      );
    }

    const completedAt = now.toISOString();
    const persisted = await this.dependencies.objects.completeUpload(
      aggregate.object.id,
      session.id,
      completedAt,
      metadata.etag,
      metadata.checksum,
      {
        actorType: command.actorType ?? 'ADMIN',
        actorId: command.actorId,
        action: 'OBJECT_UPLOAD_COMPLETED',
        resourceType: 'OBJECT',
        resourceId: aggregate.object.id,
        createdAt: completedAt,
        metadata: { sizeBytes: String(aggregate.object.sizeBytes) },
      },
    );
    if (persisted === 'ALREADY_COMPLETED') {
      const current = await requireAggregate(
        this.dependencies.objects,
        aggregate.object.id,
      );
      return {
        object: current.object,
        session: requireUploadSession(current, session.id),
        alreadyCompleted: true,
      };
    }
    if (persisted !== 'COMPLETED') {
      throw objectError(
        persisted === 'NOT_FOUND'
          ? 'OBJECT_NOT_FOUND'
          : persisted === 'INVALID_STATE'
            ? 'OBJECT_INVALID_STATE'
            : 'OBJECT_CONFLICT',
        'Upload changed while completion was in progress',
      );
    }
    const object = {
      ...transitionObjectStatus(aggregate.object, 'READY', completedAt),
      checksum: metadata.checksum,
    };
    const completedSession = transitionUploadSessionStatus(
      session,
      'COMPLETED',
      completedAt,
    );
    return { object, session: completedSession, alreadyCompleted: false };
  }
}

export interface SweepExpiredUploadsResult {
  readonly pendingCandidates: number;
  readonly expired: number;
  readonly cleanupCandidates: number;
  readonly cleaned: number;
  readonly failed: number;
}

/**
 * Scheduled maintenance for abandoned direct uploads. Expiry releases the
 * reservation first; provider deletion is then retried until the session is
 * marked ABORTED, so a transient provider failure never loses the cleanup job.
 */
export class SweepExpiredUploads {
  constructor(private readonly dependencies: ObjectProviderDependencies) {}

  async execute(): Promise<SweepExpiredUploadsResult> {
    const now = this.dependencies.clock.now();
    const expiredAt = now.toISOString();
    const cutoff = new Date(
      now.getTime() - EXPIRY_SWEEP_GRACE_MILLISECONDS,
    ).toISOString();
    const pending =
      await this.dependencies.objects.listExpiredPendingUploads(
        cutoff,
        EXPIRY_SWEEP_BATCH_LIMIT,
      );
    let expired = 0;
    let cleaned = 0;
    let failed = 0;

    for (const candidate of pending) {
      try {
        const result =
          await this.dependencies.objects.expireUploadAndReleaseCapacity(
            candidate.objectId,
            candidate.uploadSessionId,
            expiredAt,
            {
              actorType: 'SYSTEM',
              actorId: null,
              action: 'OBJECT_UPLOAD_EXPIRED',
              resourceType: 'OBJECT',
              resourceId: candidate.objectId,
              createdAt: expiredAt,
              metadata: { uploadSessionId: candidate.uploadSessionId },
            },
          );
        if (result === 'EXPIRED') {
          expired += 1;
        }
      } catch {
        failed += 1;
      }
    }

    const cleanup =
      await this.dependencies.objects.listExpiredUploadsAwaitingCleanup(
        EXPIRY_SWEEP_BATCH_LIMIT,
      );
    for (const candidate of cleanup) {
      try {
        const aggregate = await requireAggregate(
          this.dependencies.objects,
          candidate.objectId,
        );
        const session = requireUploadSession(
          aggregate,
          candidate.uploadSessionId,
        );
        if (session.status !== 'EXPIRED') continue;
        const { account, provider } = await requireProviderContext(
          this.dependencies,
          aggregate,
          'deleteObject',
        );
        await provider.deleteObject({
          account,
          credentials: await this.dependencies.vault.decrypt(
            account.credentialEnvelope,
          ),
          bucket: aggregate.primaryLocation.physicalBucket,
          key: aggregate.primaryLocation.physicalKey,
        });
        const result =
          await this.dependencies.objects.finishExpiredUploadCleanup(
            candidate.objectId,
            candidate.uploadSessionId,
            {
              actorType: 'SYSTEM',
              actorId: null,
              action: 'OBJECT_UPLOAD_ABORTED',
              resourceType: 'OBJECT',
              resourceId: candidate.objectId,
              createdAt: expiredAt,
              metadata: { uploadSessionId: candidate.uploadSessionId },
            },
          );
        if (result === 'CLEANED') {
          cleaned += 1;
        }
      } catch {
        failed += 1;
      }
    }

    return {
      pendingCandidates: pending.length,
      expired,
      cleanupCandidates: cleanup.length,
      cleaned,
      failed,
    };
  }
}

export interface CreateDownloadResult {
  readonly objectId: string;
  readonly downloadUrl: string;
  readonly expiresAt: string;
}

export class CreateDownload {
  constructor(
    private readonly dependencies: Pick<
      ObjectProviderDependencies,
      'accounts' | 'objects' | 'providers' | 'vault' | 'clock'
    > & { readonly audit: AuditLog },
  ) {}

  async execute(command: {
    readonly actorId: string;
    readonly actorType?: 'ADMIN' | 'API_KEY';
    readonly objectId: string;
  }): Promise<CreateDownloadResult> {
    assertIdentifier(command.actorId, 'Actor');
    assertIdentifier(command.objectId, 'Object');
    const aggregate = await requireAggregate(
      this.dependencies.objects,
      command.objectId,
    );
    if (aggregate.object.status !== 'READY') {
      throw objectError(
        'OBJECT_INVALID_STATE',
        'Only a ready object can be downloaded',
      );
    }
    const { account, provider } = await requireProviderContext(
      this.dependencies,
      aggregate,
      'presignedDownload',
    );
    const signed = await provider.createDownloadUrl({
      account,
      credentials: await this.dependencies.vault.decrypt(
        account.credentialEnvelope,
      ),
      bucket: aggregate.primaryLocation.physicalBucket,
      key: aggregate.primaryLocation.physicalKey,
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
    });
    const now = this.dependencies.clock.now().getTime();
    const signedExpiry = Date.parse(signed.expiresAt);
    if (
      !signed.url ||
      !Number.isFinite(signedExpiry) ||
      signedExpiry <= now ||
      signedExpiry > now + (DOWNLOAD_URL_TTL_SECONDS + 5) * 1_000
    ) {
      throw objectError(
        'OBJECT_PROVIDER_RESPONSE_INVALID',
        'Provider returned an invalid signed download response',
      );
    }
    await this.dependencies.audit.record({
      actorType: command.actorType ?? 'ADMIN',
      actorId: command.actorId,
      action: 'OBJECT_DOWNLOAD_SIGNED',
      resourceType: 'OBJECT',
      resourceId: aggregate.object.id,
      createdAt: this.dependencies.clock.now().toISOString(),
    });
    return {
      objectId: aggregate.object.id,
      downloadUrl: signed.url,
      expiresAt: signed.expiresAt,
    };
  }
}

export class DeleteObject {
  constructor(private readonly dependencies: ObjectProviderDependencies) {}

  async execute(command: {
    readonly actorId: string;
    readonly actorType?: 'ADMIN' | 'API_KEY';
    readonly objectId: string;
  }): Promise<StoredObject> {
    assertIdentifier(command.actorId, 'Actor');
    assertIdentifier(command.objectId, 'Object');
    let aggregate = await requireAggregate(
      this.dependencies.objects,
      command.objectId,
    );
    if (aggregate.object.status === 'DELETED') return aggregate.object;
    if (
      aggregate.object.status !== 'READY' &&
      aggregate.object.status !== 'DELETING'
    ) {
      throw objectError(
        'OBJECT_INVALID_STATE',
        'Only a ready or deleting object can be deleted',
      );
    }

    const startedAt = this.dependencies.clock.now().toISOString();
    if (aggregate.object.status === 'READY') {
      const begun = await this.dependencies.objects.beginDelete(
        aggregate.object.id,
        startedAt,
        {
          actorType: command.actorType ?? 'ADMIN',
          actorId: command.actorId,
          action: 'OBJECT_DELETE_STARTED',
          resourceType: 'OBJECT',
          resourceId: aggregate.object.id,
          createdAt: startedAt,
        },
      );
      if (begun === 'ALREADY_DELETED') {
        return (await requireAggregate(this.dependencies.objects, command.objectId))
          .object;
      }
      if (begun !== 'STARTED' && begun !== 'ALREADY_DELETING') {
        throw objectError(
          begun === 'NOT_FOUND'
            ? 'OBJECT_NOT_FOUND'
            : begun === 'INVALID_STATE'
              ? 'OBJECT_INVALID_STATE'
              : 'OBJECT_CONFLICT',
          'Object changed while deletion was starting',
        );
      }
      if (begun === 'STARTED') {
        aggregate = {
          ...aggregate,
          object: transitionObjectStatus(
            aggregate.object,
            'DELETING',
            startedAt,
          ),
        };
      } else {
        aggregate = await requireAggregate(
          this.dependencies.objects,
          command.objectId,
        );
      }
    }

    const { account, provider } = await requireProviderContext(
      this.dependencies,
      aggregate,
      'deleteObject',
    );
    await provider.deleteObject({
      account,
      credentials: await this.dependencies.vault.decrypt(
        account.credentialEnvelope,
      ),
      bucket: aggregate.primaryLocation.physicalBucket,
      key: aggregate.primaryLocation.physicalKey,
    });

    const deletedAt = this.dependencies.clock.now().toISOString();
    const finished =
      await this.dependencies.objects.finishDeleteAndReleaseCapacity(
        aggregate.object.id,
        deletedAt,
        {
          actorType: command.actorType ?? 'ADMIN',
          actorId: command.actorId,
          action: 'OBJECT_DELETED',
          resourceType: 'OBJECT',
          resourceId: aggregate.object.id,
          createdAt: deletedAt,
        },
      );
    if (finished === 'ALREADY_DELETED') {
      return (await requireAggregate(this.dependencies.objects, command.objectId))
        .object;
    }
    if (finished !== 'DELETED') {
      throw objectError(
        finished === 'NOT_FOUND'
          ? 'OBJECT_NOT_FOUND'
          : finished === 'INVALID_STATE'
            ? 'OBJECT_INVALID_STATE'
            : 'OBJECT_CONFLICT',
        'Object changed while deletion was finishing',
      );
    }
    const deleted = transitionObjectStatus(
      aggregate.object,
      'DELETED',
      deletedAt,
    );
    return deleted;
  }
}

export class GetObjectMetadata {
  constructor(
    private readonly objects: Pick<
      ObjectRepository,
      'findById' | 'findByLogicalKey'
    >,
  ) {}

  async execute(query: {
    readonly objectId?: string;
    readonly logicalBucketId?: string;
    readonly logicalKey?: string;
  }): Promise<StoredObject> {
    let aggregate: ObjectAggregate | undefined;
    if (query.objectId !== undefined) {
      assertIdentifier(query.objectId, 'Object');
      aggregate = await this.objects.findById(query.objectId);
    } else if (
      query.logicalBucketId !== undefined &&
      query.logicalKey !== undefined
    ) {
      assertIdentifier(query.logicalBucketId, 'Logical bucket');
      if (!query.logicalKey) {
        throw objectError('OBJECT_INVALID_INPUT', 'Logical key is required');
      }
      aggregate = await this.objects.findByLogicalKey(
        query.logicalBucketId,
        query.logicalKey,
      );
    } else {
      throw objectError(
        'OBJECT_INVALID_INPUT',
        'Object id or logical bucket and key are required',
      );
    }
    if (!aggregate) throw objectError('OBJECT_NOT_FOUND', 'Object was not found');
    return aggregate.object;
  }
}

export class ListObjectMetadata {
  constructor(
    private readonly objects: Pick<ObjectRepository, 'list'>,
  ) {}

  execute(query: Partial<ObjectListQuery> & {
    readonly logicalBucketId: string;
  }): Promise<readonly StoredObject[]> {
    assertIdentifier(query.logicalBucketId, 'Logical bucket');
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw objectError('OBJECT_INVALID_INPUT', 'List limit must be 1-1000');
    }
    if (
      query.status !== undefined &&
      !objectStatuses.some((status) => status === query.status)
    ) {
      throw objectError('OBJECT_INVALID_INPUT', 'Object status is invalid');
    }
    return this.objects.list({
      logicalBucketId: query.logicalBucketId,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.prefix === undefined ? {} : { prefix: query.prefix }),
      ...(query.afterKey === undefined ? {} : { afterKey: query.afterKey }),
      limit,
    });
  }
}
