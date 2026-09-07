import {
  isObjectPubliclyAccessible,
  publicAccessModes,
  type LogicalBucket,
  type PublicAccessMode,
  type StoredObject,
} from '@openpool/domain';

import type { AuditLogEntry } from '../ports/auth';
import type { CredentialVault } from '../ports/credential-vault';
import type {
  Clock,
  LogicalBucketPublicAccessRepository,
  LogicalBucketRepository,
  ManagedStorageAccountRepository,
  ObjectAggregate,
  ObjectPublicAccessRepository,
  ObjectRepository,
  ProviderRegistry,
} from '../ports/storage';
import { LogicalBucketApplicationError } from './logical-buckets';
import { objectError } from './object-errors';
import type { ObjectApplicationError } from './object-errors';

const PUBLIC_DOWNLOAD_TTL_SECONDS = 60;

function canonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validIdentifier(value: string): boolean {
  return value.trim().length > 0;
}

function invalidBucketInput(): LogicalBucketApplicationError {
  return new LogicalBucketApplicationError(
    'LOGICAL_BUCKET_INVALID_INPUT',
    'Public access update input is invalid',
  );
}

function bucketConflict(): LogicalBucketApplicationError {
  return new LogicalBucketApplicationError(
    'LOGICAL_BUCKET_CONFLICT',
    'The logical bucket changed while public access was being updated',
  );
}

function publicAccessUpdate(
  repository: LogicalBucketPublicAccessRepository,
  bucket: LogicalBucket,
  expectedUpdatedAt: string,
  audit: AuditLogEntry,
): Promise<boolean> {
  return repository.updatePublicAccess(bucket, expectedUpdatedAt, audit);
}

export interface UpdateLogicalBucketPublicAccessCommand {
  readonly actorId: string;
  readonly bucketId: string;
  readonly enabled: boolean;
  readonly expectedUpdatedAt: string;
}

export interface UpdateLogicalBucketPublicAccessDependencies {
  readonly buckets: Pick<LogicalBucketRepository, 'findById'> &
    LogicalBucketPublicAccessRepository;
  readonly clock: Clock;
}

export class UpdateLogicalBucketPublicAccess {
  constructor(
    private readonly dependencies: UpdateLogicalBucketPublicAccessDependencies,
  ) {}

  async execute(
    command: UpdateLogicalBucketPublicAccessCommand,
  ): Promise<LogicalBucket> {
    if (
      !validIdentifier(command.actorId) ||
      !validIdentifier(command.bucketId) ||
      typeof command.enabled !== 'boolean' ||
      !canonicalTimestamp(command.expectedUpdatedAt)
    ) {
      throw invalidBucketInput();
    }
    const current = await this.dependencies.buckets.findById(command.bucketId);
    if (!current) {
      throw new LogicalBucketApplicationError(
        'LOGICAL_BUCKET_NOT_FOUND',
        'Logical bucket was not found',
      );
    }
    const now = this.dependencies.clock.now().toISOString();
    const bucket: LogicalBucket = {
      ...current,
      publicAccessEnabled: command.enabled,
      updatedAt: now,
    };
    const audit: AuditLogEntry = {
      actorType: 'ADMIN',
      actorId: command.actorId,
      action: 'LOGICAL_BUCKET_PUBLIC_ACCESS_UPDATED',
      resourceType: 'LOGICAL_BUCKET',
      resourceId: bucket.id,
      createdAt: now,
      metadata: { enabled: String(command.enabled) },
    };
    if (
      !(await publicAccessUpdate(
        this.dependencies.buckets,
        bucket,
        command.expectedUpdatedAt,
        audit,
      ))
    ) {
      throw bucketConflict();
    }
    return bucket;
  }
}

function invalidObjectPublicAccessInput(): ObjectApplicationError {
  return objectError(
    'OBJECT_INVALID_INPUT',
    'Public access update input is invalid',
  );
}

function validateObjectPolicy(
  mode: PublicAccessMode,
  expiresAt: string | null,
  now: Date,
): void {
  if (!publicAccessModes.includes(mode)) throw invalidObjectPublicAccessInput();
  if (mode !== 'PUBLIC' && expiresAt !== null) {
    throw invalidObjectPublicAccessInput();
  }
  if (
    expiresAt !== null &&
    (!canonicalTimestamp(expiresAt) || Date.parse(expiresAt) <= now.getTime())
  ) {
    throw invalidObjectPublicAccessInput();
  }
}

export interface UpdateObjectPublicAccessCommand {
  readonly actorId: string;
  readonly objectId: string;
  readonly mode: PublicAccessMode;
  readonly expiresAt: string | null;
  readonly expectedUpdatedAt: string;
}

export interface UpdateObjectPublicAccessDependencies {
  readonly objects: Pick<ObjectRepository, 'findById'> &
    ObjectPublicAccessRepository;
  readonly clock: Clock;
}

export class UpdateObjectPublicAccess {
  constructor(
    private readonly dependencies: UpdateObjectPublicAccessDependencies,
  ) {}

  async execute(command: UpdateObjectPublicAccessCommand): Promise<StoredObject> {
    if (
      !validIdentifier(command.actorId) ||
      !validIdentifier(command.objectId) ||
      !canonicalTimestamp(command.expectedUpdatedAt)
    ) {
      throw invalidObjectPublicAccessInput();
    }
    const now = this.dependencies.clock.now();
    validateObjectPolicy(command.mode, command.expiresAt, now);
    const aggregate = await this.dependencies.objects.findById(command.objectId);
    if (!aggregate) throw objectError('OBJECT_NOT_FOUND', 'Object was not found');
    if (aggregate.object.status !== 'READY') {
      throw objectError(
        'OBJECT_INVALID_STATE',
        'Only a ready object can have public access updated',
      );
    }
    const updatedAt = now.toISOString();
    const object: StoredObject = {
      ...aggregate.object,
      publicAccessMode: command.mode,
      publicAccessExpiresAt: command.expiresAt,
      updatedAt,
    };
    const audit: AuditLogEntry = {
      actorType: 'ADMIN',
      actorId: command.actorId,
      action: 'OBJECT_PUBLIC_ACCESS_UPDATED',
      resourceType: 'OBJECT',
      resourceId: object.id,
      createdAt: updatedAt,
      metadata: {
        mode: command.mode,
        expiresAt: command.expiresAt ?? 'null',
      },
    };
    if (
      !(await this.dependencies.objects.updatePublicAccess(
        object,
        command.expectedUpdatedAt,
        audit,
      ))
    ) {
      throw objectError(
        'OBJECT_CONFLICT',
        'The object changed while public access was being updated',
      );
    }
    return object;
  }
}

interface PublicDownloadDependencies {
  readonly buckets: Pick<LogicalBucketRepository, 'findById'>;
  readonly accounts: Pick<ManagedStorageAccountRepository, 'findById'>;
  readonly objects: Pick<ObjectRepository, 'findById'>;
  readonly providers: ProviderRegistry;
  readonly vault: CredentialVault;
  readonly clock: Clock;
}

export interface CreatePublicDownloadResult {
  readonly objectId: string;
  readonly downloadUrl: string;
  readonly expiresAt: string;
}

function publicObjectNotFound(): ObjectApplicationError {
  return objectError('OBJECT_NOT_FOUND', 'Object was not found');
}

async function publicAggregate(
  dependencies: PublicDownloadDependencies,
  objectId: string,
  now: Date,
): Promise<ObjectAggregate> {
  if (!validIdentifier(objectId)) throw publicObjectNotFound();
  const aggregate = await dependencies.objects.findById(objectId);
  if (!aggregate) throw publicObjectNotFound();
  const bucket = await dependencies.buckets.findById(aggregate.object.logicalBucketId);
  if (
    !bucket ||
    !isObjectPubliclyAccessible(aggregate.object, bucket, now)
  ) {
    throw publicObjectNotFound();
  }
  return aggregate;
}

/** Anonymous direct-download signer. It deliberately does not write an audit event. */
export class CreatePublicDownload {
  constructor(private readonly dependencies: PublicDownloadDependencies) {}

  async execute(command: { readonly objectId: string }): Promise<CreatePublicDownloadResult> {
    const now = this.dependencies.clock.now();
    const aggregate = await publicAggregate(this.dependencies, command.objectId, now);
    const account = await this.dependencies.accounts.findById(
      aggregate.primaryLocation.storageAccountId,
    );
    if (!account) {
      throw objectError('OBJECT_STORAGE_ACCOUNT_NOT_FOUND', 'Object storage account was not found');
    }
    const provider = this.dependencies.providers.forAccount(account);
    if (
      account.status === 'REMOVED' ||
      !account.capabilities.presignedDownload ||
      !provider.capabilities.presignedDownload
    ) {
      throw objectError(
        'OBJECT_STORAGE_ACCOUNT_UNAVAILABLE',
        'Object storage account cannot perform this operation',
      );
    }
    const policyExpiry = aggregate.object.publicAccessExpiresAt ?? null;
    const policyExpiryMs = policyExpiry === null ? Number.POSITIVE_INFINITY : Date.parse(policyExpiry);
    const remainingSeconds = Number.isFinite(policyExpiryMs)
      ? Math.floor((policyExpiryMs - now.getTime()) / 1_000)
      : PUBLIC_DOWNLOAD_TTL_SECONDS;
    if (remainingSeconds < 1) throw publicObjectNotFound();
    const ttl = Math.min(PUBLIC_DOWNLOAD_TTL_SECONDS, remainingSeconds);
    const signed = await provider.createDownloadUrl({
      account,
      credentials: await this.dependencies.vault.decrypt(account.credentialEnvelope),
      bucket: aggregate.primaryLocation.physicalBucket,
      key: aggregate.primaryLocation.physicalKey,
      expiresInSeconds: ttl,
    });
    const signedExpiry = Date.parse(signed.expiresAt);
    if (
      !signed.url ||
      !Number.isFinite(signedExpiry) ||
      signedExpiry <= now.getTime() ||
      signedExpiry > now.getTime() + PUBLIC_DOWNLOAD_TTL_SECONDS * 1_000 ||
      signedExpiry > policyExpiryMs
    ) {
      throw objectError(
        'OBJECT_PROVIDER_RESPONSE_INVALID',
        'Provider returned an invalid signed download response',
      );
    }
    return {
      objectId: aggregate.object.id,
      downloadUrl: signed.url,
      expiresAt: signed.expiresAt,
    };
  }
}
