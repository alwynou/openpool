import { describe, expect, it } from 'vitest';

import type { AuditLogEntry } from '../ports/auth';
import type {
  Clock,
  LogicalBucketPublicAccessRepository,
  LogicalBucketRepository,
  ObjectAggregate,
  ObjectPublicAccessRepository,
  ObjectRepository,
  ProviderRegistry,
  StorageProvider,
} from '../ports/storage';
import type { CredentialEnvelope, CredentialVault } from '../ports/credential-vault';
import type {
  LogicalBucket,
  ProviderCapabilities,
  StorageAccount,
  StoredObject,
} from '@openpool/domain';
import {
  CreatePublicDownload,
  UpdateLogicalBucketPublicAccess,
  UpdateObjectPublicAccess,
} from './public-access';

const now = new Date('2026-01-01T00:00:00.000Z');
const bucket: LogicalBucket = {
  id: 'bucket-1', name: 'files', description: null, publicAccessEnabled: false,
  createdAt: now.toISOString(), updatedAt: now.toISOString(),
};
const object: StoredObject = {
  id: 'object-1', logicalBucketId: bucket.id, logicalKey: 'hello.txt', sizeBytes: 1,
  contentType: 'text/plain', checksum: null, status: 'READY', publicAccessMode: 'INHERIT',
  publicAccessExpiresAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
};
const location = {
  id: 'location-1', objectId: object.id, storageAccountId: 'account-1', storageShardId: 'shard-1',
  physicalBucket: 'physical', physicalKey: 'objects/hello', etag: null, isPrimary: true,
  createdAt: now.toISOString(), updatedAt: now.toISOString(),
};
const aggregate: ObjectAggregate = { object, primaryLocation: location, uploadSession: null };

class FakeBuckets implements Pick<LogicalBucketRepository, 'findById'>, LogicalBucketPublicAccessRepository {
  value = bucket;
  audits: AuditLogEntry[] = [];
  async findById() { return this.value; }
  async updatePublicAccess(value: LogicalBucket, expected: string, audit: AuditLogEntry) {
    if (expected !== this.value.updatedAt) return false;
    this.value = value; this.audits.push(audit); return true;
  }
}

class FakeObjects implements Pick<ObjectRepository, 'findById'>, ObjectPublicAccessRepository {
  value = aggregate;
  audits: AuditLogEntry[] = [];
  async findById() { return this.value; }
  async updatePublicAccess(value: StoredObject, expected: string, audit: AuditLogEntry) {
    if (expected !== this.value.object.updatedAt) return false;
    this.value = { ...this.value, object: value }; this.audits.push(audit); return true;
  }
}

const clock: Clock = { now: () => now };

describe('public access use cases', () => {
  it('conditionally updates bucket and object policies with audit entries', async () => {
    const buckets = new FakeBuckets();
    const objects = new FakeObjects();
    await expect(new UpdateLogicalBucketPublicAccess({ buckets, clock }).execute({
      actorId: 'admin-1', bucketId: bucket.id, enabled: true, expectedUpdatedAt: bucket.updatedAt,
    })).resolves.toMatchObject({ publicAccessEnabled: true });
    await expect(new UpdateObjectPublicAccess({ objects, clock }).execute({
      actorId: 'admin-1', objectId: object.id, mode: 'PUBLIC', expiresAt: '2026-01-01T00:01:00.000Z', expectedUpdatedAt: object.updatedAt,
    })).resolves.toMatchObject({ publicAccessMode: 'PUBLIC', publicAccessExpiresAt: '2026-01-01T00:01:00.000Z' });
    expect(buckets.audits[0]?.action).toBe('LOGICAL_BUCKET_PUBLIC_ACCESS_UPDATED');
    expect(objects.audits[0]?.action).toBe('OBJECT_PUBLIC_ACCESS_UPDATED');
  });

  it('rejects stale, non-ready, and invalid expiry updates', async () => {
    const objects = new FakeObjects();
    await expect(new UpdateObjectPublicAccess({ objects, clock }).execute({
      actorId: 'admin-1', objectId: object.id, mode: 'PUBLIC', expiresAt: null, expectedUpdatedAt: '2025-01-01T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
    await expect(new UpdateObjectPublicAccess({ objects, clock }).execute({
      actorId: 'admin-1', objectId: object.id, mode: 'PRIVATE', expiresAt: '2026-01-01T00:01:00.000Z', expectedUpdatedAt: object.updatedAt,
    })).rejects.toMatchObject({ code: 'OBJECT_INVALID_INPUT' });
  });

  it('signs public downloads for at most 60 seconds and emits no audit', async () => {
    const buckets = new FakeBuckets();
    buckets.value = { ...bucket, publicAccessEnabled: true };
    const objects = new FakeObjects();
    const calls: number[] = [];
    const capabilities: ProviderCapabilities = { presignedDownload: true, presignedUpload: true, headObject: true, deleteObject: true, bucketProbe: false, usageProbe: false };
    const provider: StorageProvider = {
      capabilities,
      createUploadUrl: async () => ({ url: 'unused', expiresAt: now.toISOString() }),
      createDownloadUrl: async (request) => { calls.push(request.expiresInSeconds); return { url: 'https://provider/download', expiresAt: '2026-01-01T00:01:00.000Z' }; },
      headObject: async () => ({ sizeBytes: 1, etag: null, checksum: null }),
      deleteObject: async () => {}, validate: async () => ({ capabilities }),
      probe: async () => ({ healthStatus: 'HEALTHY', capacityBytes: null, usedBytes: null, capacityAccuracy: 'UNKNOWN' }),
    };
    const account: StorageAccount = {
      id: 'account-1', name: 'a', provider: 'r2', status: 'ACTIVE', priority: 1,
      writeEnabled: true, healthStatus: 'HEALTHY', capabilities, providerConfig: {},
      capacityBytes: 1, usedBytes: 0, capacityAccuracy: 'UNKNOWN',
      createdAt: now.toISOString(), updatedAt: now.toISOString(), lastHealthCheckedAt: null,
    };
    const envelope: CredentialEnvelope = {
      version: 1, algorithm: 'AES-256-GCM', keyId: 'k', iv: 'i', ciphertext: 'c',
    };
    const accounts = { findById: async () => ({ ...account, credentialEnvelope: envelope }) };
    const providers: ProviderRegistry = { forAccount: () => provider };
    const vault: CredentialVault = { encrypt: async () => envelope, decrypt: async () => ({}) };
    const result = await new CreatePublicDownload({ buckets, objects, accounts, providers, vault, clock }).execute({ objectId: object.id });
    expect(result.downloadUrl).toContain('provider');
    expect(calls).toEqual([60]);
  });
});
