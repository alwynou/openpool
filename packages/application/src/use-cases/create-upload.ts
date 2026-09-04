import {
  hasWriteCapabilities,
  validateObjectInput,
  type ObjectLocation,
  type StoredObject,
  type UploadSession,
} from '@openpool/domain';

import type { CredentialVault } from '../ports/credential-vault';
import type {
  Clock,
  IdGenerator,
  ManagedStorageAccountRepository,
  ObjectRepository,
  ProviderRegistry,
  StorageShardRepository,
} from '../ports/storage';
import { ObjectApplicationError, objectError } from './object-errors';

const UPLOAD_URL_TTL_SECONDS = 900;

export interface CreateUploadCommand {
  readonly actorId: string;
  readonly actorType?: 'ADMIN' | 'API_KEY';
  readonly bucketId: string;
  readonly logicalKey: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly retryUploadSessionId?: string;
}

export interface CreateUploadResult {
  readonly objectId: string;
  readonly uploadSessionId: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}

export interface CreateUploadDependencies {
  readonly accounts: Pick<ManagedStorageAccountRepository, 'findById'>;
  readonly shards: Pick<
    StorageShardRepository,
    'findActiveByLogicalBucketId'
  >;
  readonly objects: ObjectRepository;
  readonly providers: ProviderRegistry;
  readonly vault: CredentialVault;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** @deprecated Use ObjectApplicationError and its stable code. */
export class NoStorageAvailableError extends ObjectApplicationError {
  constructor() {
    super('OBJECT_NO_ACTIVE_SHARD', 'No active storage shard is available');
    this.name = 'NoStorageAvailableError';
  }
}

function assertCommand(command: CreateUploadCommand): string {
  const contentType = command.contentType.trim();
  if (!command.actorId.trim() || !command.bucketId.trim() ||
    (command.retryUploadSessionId !== undefined && !command.retryUploadSessionId.trim())) {
    throw objectError('OBJECT_INVALID_INPUT', 'Actor and logical bucket are required');
  }
  try {
    validateObjectInput(command.logicalKey, command.sizeBytes, contentType);
  } catch {
    throw objectError('OBJECT_INVALID_INPUT', 'Object upload input is invalid');
  }
  return contentType;
}

function hasPreflightCapacity(
  capacityBytes: number,
  usedBytes: number,
  requestedBytes: number,
): boolean {
  if (
    !Number.isSafeInteger(capacityBytes) ||
    !Number.isSafeInteger(usedBytes) ||
    capacityBytes < 0 ||
    usedBytes < 0 ||
    requestedBytes > capacityBytes
  ) {
    return false;
  }
  const softLimit = capacityBytes - Math.ceil(capacityBytes / 10);
  return usedBytes <= softLimit - requestedBytes;
}

export class CreateUpload {
  constructor(private readonly dependencies: CreateUploadDependencies) {}

  async execute(command: CreateUploadCommand): Promise<CreateUploadResult> {
    const contentType = assertCommand(command);
    const previous = command.retryUploadSessionId === undefined
      ? undefined
      : await this.dependencies.objects.findByLogicalKey(command.bucketId, command.logicalKey);
    if (command.retryUploadSessionId !== undefined) {
      if (!previous) throw objectError('OBJECT_NOT_FOUND', 'Object was not found');
      if (previous.object.status !== 'PENDING') {
        throw objectError('OBJECT_INVALID_STATE', 'Only unfinished uploads can be retried');
      }
      if (previous.uploadSession?.id !== command.retryUploadSessionId) {
        throw objectError('OBJECT_CONFLICT', 'The upload session has changed');
      }
    }
    const shard = await this.dependencies.shards.findActiveByLogicalBucketId(
      command.bucketId,
    );
    if (!shard || shard.status !== 'ACTIVE') {
      throw new NoStorageAvailableError();
    }
    const account = await this.dependencies.accounts.findById(
      shard.storageAccountId,
    );
    if (!account) {
      throw objectError(
        'OBJECT_STORAGE_ACCOUNT_NOT_FOUND',
        'The active shard storage account was not found',
      );
    }
    if (
      account.status !== 'ACTIVE' ||
      !account.writeEnabled ||
      account.healthStatus !== 'HEALTHY' ||
      !hasWriteCapabilities(account.capabilities)
    ) {
      throw objectError(
        'OBJECT_STORAGE_ACCOUNT_UNAVAILABLE',
        'The active shard storage account cannot accept uploads',
      );
    }
    if (
      !hasPreflightCapacity(
        shard.capacityBytes,
        shard.usedBytes - (previous?.uploadSession?.status === 'PENDING' &&
          previous.primaryLocation.storageShardId === shard.id ? previous.object.sizeBytes : 0),
        command.sizeBytes,
      ) ||
      !hasPreflightCapacity(
        account.capacityBytes,
        account.usedBytes - (previous?.uploadSession?.status === 'PENDING' &&
          previous.primaryLocation.storageAccountId === account.id ? previous.object.sizeBytes : 0),
        command.sizeBytes,
      )
    ) {
      throw objectError(
        'OBJECT_CAPACITY_UNAVAILABLE',
        'The active shard has insufficient writable capacity',
      );
    }

    const objectId = previous?.object.id ?? this.dependencies.ids.next();
    const locationId = this.dependencies.ids.next();
    const uploadSessionId = this.dependencies.ids.next();
    const physicalId = previous ? locationId : objectId;
    const physicalKey = `objects/${physicalId.slice(0, 2)}/${physicalId}`;
    const now = this.dependencies.clock.now().toISOString();
    const object: StoredObject = {
      id: objectId,
      logicalBucketId: command.bucketId,
      logicalKey: command.logicalKey,
      sizeBytes: command.sizeBytes,
      contentType,
      checksum: null,
      status: 'PENDING',
      createdAt: previous?.object.createdAt ?? now,
      updatedAt: now,
    };
    const location: ObjectLocation = {
      id: locationId,
      objectId,
      storageAccountId: account.id,
      storageShardId: shard.id,
      physicalBucket: shard.physicalBucket,
      physicalKey,
      etag: null,
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    };

    const provider = this.dependencies.providers.forAccount(account);
    const signedUpload = await provider.createUploadUrl({
      account,
      credentials: await this.dependencies.vault.decrypt(
        account.credentialEnvelope,
      ),
      bucket: shard.physicalBucket,
      key: physicalKey,
      contentType,
      sizeBytes: command.sizeBytes,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    const signedExpiry = Date.parse(signedUpload.expiresAt);
    if (
      !signedUpload.url ||
      !Number.isFinite(signedExpiry) ||
      signedExpiry <= Date.parse(now) ||
      signedExpiry >
        Date.parse(now) + (UPLOAD_URL_TTL_SECONDS + 5) * 1_000
    ) {
      throw objectError(
        'OBJECT_PROVIDER_RESPONSE_INVALID',
        'Provider returned an invalid signed upload response',
      );
    }
    const session: UploadSession = {
      id: uploadSessionId,
      objectId,
      status: 'PENDING',
      expiresAt: signedUpload.expiresAt,
      createdAt: now,
      completedAt: null,
    };
    const reservation = await this.dependencies.objects.reserveUploadAndCapacity(
      object,
      location,
      session,
      {
        actorType: command.actorType ?? 'ADMIN',
        actorId: command.actorId,
        action: previous ? 'OBJECT_UPLOAD_RETRIED' : 'OBJECT_UPLOAD_RESERVED',
        resourceType: 'OBJECT',
        resourceId: objectId,
        createdAt: now,
        metadata: {
          logicalBucketId: command.bucketId,
          storageShardId: shard.id,
          sizeBytes: String(command.sizeBytes),
          uploadSessionId,
          ...(command.retryUploadSessionId === undefined ? {} :
            { previousUploadSessionId: command.retryUploadSessionId }),
        },
      },
      command.retryUploadSessionId,
    );
    if (reservation !== 'RESERVED') {
      if (reservation === 'OBJECT_CONFLICT') {
        throw objectError(
          'OBJECT_ALREADY_EXISTS',
          'An object with this logical key already exists',
        );
      }
      if (
        reservation === 'CAPACITY_UNAVAILABLE' ||
        reservation === 'SHARD_UNAVAILABLE'
      ) {
        throw objectError(
          'OBJECT_CAPACITY_UNAVAILABLE',
          'Capacity changed before the upload could be reserved',
        );
      }
      throw objectError(
        'OBJECT_CONFLICT',
        'Object reservation conflicted with another operation',
      );
    }

    return {
      objectId,
      uploadSessionId,
      uploadUrl: signedUpload.url,
      expiresAt: signedUpload.expiresAt,
    };
  }
}
