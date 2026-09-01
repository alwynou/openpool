import type {
  ObjectLocation,
  StorageAccount,
  StoredObject,
} from '@openpool/domain';

export interface StorageAccountRepository {
  listWritable(): Promise<readonly StorageAccount[]>;
}

export interface ObjectRepository {
  reserve(object: StoredObject, location: ObjectLocation): Promise<void>;
}

export interface UploadUrlRequest {
  readonly account: StorageAccount;
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

export interface StorageProvider {
  createUploadUrl(request: UploadUrlRequest): Promise<SignedUpload>;
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
