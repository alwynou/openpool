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
  if (!command.actorId.trim() || !command.bucketId.trim()) {
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
        shard.usedBytes,
        command.sizeBytes,
      ) ||
      !hasPreflightCapacity(
        account.capacityBytes,
        account.usedBytes,
        command.sizeBytes,
      )
    ) {
      throw objectError(
        'OBJECT_CAPACITY_UNAVAILABLE',
        'The active shard has insufficient writable capacity',
      );
    }

    const objectId = this.dependencies.ids.next();
    const locationId = this.dependencies.ids.next();
    const uploadSessionId = this.dependencies.ids.next();
    const physicalKey = `objects/${objectId.slice(0, 2)}/${objectId}`;
    const now = this.dependencies.clock.now().toISOString();
    const object: StoredObject = {
      id: objectId,
      logicalBucketId: command.bucketId,
      logicalKey: command.logicalKey,
      sizeBytes: command.sizeBytes,
      contentType,
      checksum: null,
      status: 'PENDING',
      createdAt: now,
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
        action: 'OBJECT_UPLOAD_RESERVED',
        resourceType: 'OBJECT',
        resourceId: objectId,
        createdAt: now,
        metadata: {
          logicalBucketId: command.bucketId,
          storageShardId: shard.id,
          sizeBytes: String(command.sizeBytes),
        },
      },
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
