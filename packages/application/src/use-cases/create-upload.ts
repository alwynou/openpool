import {
  selectStorageAccount,
  type ObjectLocation,
  type StoredObject,
} from '@openpool/domain';

import type {
  Clock,
  IdGenerator,
  ObjectRepository,
  ProviderRegistry,
  StorageAccountRepository,
} from '../ports/storage';

export interface CreateUploadCommand {
  readonly bucketId: string;
  readonly physicalBucket: string;
  readonly logicalKey: string;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface CreateUploadResult {
  readonly objectId: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}

export interface CreateUploadDependencies {
  readonly accounts: StorageAccountRepository;
  readonly objects: ObjectRepository;
  readonly providers: ProviderRegistry;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export class NoStorageAvailableError extends Error {
  constructor() {
    super('No writable storage account has enough capacity');
    this.name = 'NoStorageAvailableError';
  }
}

export class CreateUpload {
  constructor(private readonly dependencies: CreateUploadDependencies) {}

  async execute(command: CreateUploadCommand): Promise<CreateUploadResult> {
    const account = selectStorageAccount(
      await this.dependencies.accounts.listWritable(),
      command.sizeBytes,
    );
    if (!account) {
      throw new NoStorageAvailableError();
    }

    const objectId = this.dependencies.ids.next();
    const physicalKey = `objects/${objectId.slice(0, 2)}/${objectId}`;
    const now = this.dependencies.clock.now();
    const object: StoredObject = {
      id: objectId,
      logicalBucketId: command.bucketId,
      logicalKey: command.logicalKey,
      sizeBytes: command.sizeBytes,
      contentType: command.contentType,
      checksum: null,
      status: 'PENDING',
      createdAt: now.toISOString(),
    };
    const location: ObjectLocation = {
      objectId,
      storageAccountId: account.id,
      physicalBucket: command.physicalBucket,
      physicalKey,
      etag: null,
    };

    const signedUpload = await this.dependencies.providers
      .forAccount(account)
      .createUploadUrl({
        account,
        bucket: command.physicalBucket,
        key: physicalKey,
        contentType: command.contentType,
        sizeBytes: command.sizeBytes,
        expiresInSeconds: 900,
      });

    await this.dependencies.objects.reserve(object, location);

    return {
      objectId,
      uploadUrl: signedUpload.url,
      expiresAt: signedUpload.expiresAt,
    };
  }
}
