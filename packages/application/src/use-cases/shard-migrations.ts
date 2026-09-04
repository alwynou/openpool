import {
  hasWriteCapabilities,
  ProviderError,
  validateShardMigrationEndpoints,
  type ShardMigration,
  type StorageAccount,
} from '@openpool/domain';

import type { CredentialVault } from '../ports/credential-vault';
import type {
  Clock,
  IdGenerator,
  LogicalBucketRepository,
  ManagedStorageAccountRepository,
  ProviderRegistry,
  ShardMigrationProgress,
  ShardMigrationRepository,
  ShardMigrationTransferAggregate,
  StorageShardRepository,
} from '../ports/storage';

const TRANSFER_TTL_SECONDS = 900;
const CLEANUP_BATCH_LIMIT = 100;

export type ShardMigrationApplicationErrorCode =
  | 'SHARD_MIGRATION_INVALID_INPUT'
  | 'SHARD_MIGRATION_BUCKET_NOT_FOUND'
  | 'SHARD_MIGRATION_NOT_FOUND'
  | 'SHARD_MIGRATION_SOURCE_NOT_FOUND'
  | 'SHARD_MIGRATION_TARGET_NOT_FOUND'
  | 'SHARD_MIGRATION_ACCOUNT_NOT_FOUND'
  | 'SHARD_MIGRATION_SOURCE_NOT_DRAINING'
  | 'SHARD_MIGRATION_TARGET_UNAVAILABLE'
  | 'SHARD_MIGRATION_ALREADY_RUNNING'
  | 'SHARD_MIGRATION_CONFLICT'
  | 'SHARD_MIGRATION_CAPACITY_UNAVAILABLE'
  | 'SHARD_MIGRATION_NO_TRANSFER_AVAILABLE'
  | 'SHARD_MIGRATION_TRANSFER_NOT_FOUND'
  | 'SHARD_MIGRATION_TRANSFER_EXPIRED'
  | 'SHARD_MIGRATION_TARGET_MISMATCH'
  | 'SHARD_MIGRATION_BLOCKED';

export class ShardMigrationApplicationError extends Error {
  constructor(
    readonly code: ShardMigrationApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShardMigrationApplicationError';
  }
}

export interface ShardMigrationResult {
  readonly migration: ShardMigration;
  readonly progress: ShardMigrationProgress;
}

export interface StartShardMigrationDependencies {
  readonly migrations: ShardMigrationRepository;
  readonly shards: Pick<StorageShardRepository, 'findById'>;
  readonly accounts: Pick<ManagedStorageAccountRepository, 'findById'>;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

function targetCanHostMigration(account: StorageAccount): boolean {
  return (
    account.status === 'ACTIVE' &&
    account.writeEnabled &&
    account.healthStatus === 'HEALTHY' &&
    account.capacityAccuracy !== 'UNKNOWN' &&
    hasWriteCapabilities(account.capabilities)
  );
}

function migrationSoftAvailable(
  capacityBytes: number,
  usedBytes: number,
): number {
  return capacityBytes - Math.ceil(capacityBytes / 10) - usedBytes;
}

function invalidInput(message: string): ShardMigrationApplicationError {
  return new ShardMigrationApplicationError(
    'SHARD_MIGRATION_INVALID_INPUT',
    message,
  );
}

export class StartShardMigration {
  constructor(private readonly dependencies: StartShardMigrationDependencies) {}

  async execute(command: {
    readonly actorId: string;
    readonly sourceShardId: string;
    readonly targetShardId: string;
    readonly expectedSourceUpdatedAt: string;
    readonly expectedTargetUpdatedAt: string;
  }): Promise<ShardMigrationResult> {
    try {
      validateShardMigrationEndpoints(
        command.sourceShardId,
        command.targetShardId,
      );
    } catch {
      throw invalidInput('Source and target shards are invalid');
    }
    const source = await this.dependencies.shards.findById(
      command.sourceShardId,
    );
    if (!source) {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_SOURCE_NOT_FOUND',
        'Source shard was not found',
      );
    }
    const target = await this.dependencies.shards.findById(
      command.targetShardId,
    );
    if (!target) {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_TARGET_NOT_FOUND',
        'Target shard was not found',
      );
    }
    if (
      source.logicalBucketId !== target.logicalBucketId ||
      source.status !== 'ACTIVE' ||
      target.status !== 'STANDBY'
    ) {
      throw invalidInput(
        'Migration requires an active source and standby target in the same logical bucket',
      );
    }
    const sourceAccount = await this.dependencies.accounts.findById(
      source.storageAccountId,
    );
    const targetAccount = await this.dependencies.accounts.findById(
      target.storageAccountId,
    );
    if (!sourceAccount || !targetAccount) {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_ACCOUNT_NOT_FOUND',
        'A migration storage account was not found',
      );
    }
    if (sourceAccount.status !== 'DRAINING') {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_SOURCE_NOT_DRAINING',
        'Source storage account must be draining',
      );
    }
    if (
      !targetCanHostMigration(targetAccount) ||
      migrationSoftAvailable(target.capacityBytes, target.usedBytes) <
        source.usedBytes ||
      migrationSoftAvailable(
        targetAccount.capacityBytes,
        targetAccount.usedBytes,
      ) < source.usedBytes
    ) {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_TARGET_UNAVAILABLE',
        'Target shard or account cannot hold the source reservation',
      );
    }

    const now = this.dependencies.clock.now().toISOString();
    const migration: ShardMigration = {
      id: this.dependencies.ids.next(),
      sourceShardId: source.id,
      targetShardId: target.id,
      status: 'RUNNING',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const created = await this.dependencies.migrations.createAndCutover(
      migration,
      command.expectedSourceUpdatedAt,
      command.expectedTargetUpdatedAt,
      {
        actorType: 'ADMIN',
        actorId: command.actorId,
        action: 'SHARD_MIGRATION_STARTED',
        resourceType: 'SHARD_MIGRATION',
        resourceId: migration.id,
        createdAt: now,
        metadata: {
          sourceShardId: source.id,
          targetShardId: target.id,
        },
      },
    );
    if (created === 'ALREADY_RUNNING') {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_ALREADY_RUNNING',
        'Source shard already has a running migration',
      );
    }
    if (created !== 'CREATED') {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_CONFLICT',
        'Shard state changed while migration was starting',
      );
    }
    return {
      migration,
      progress: await requireProgress(this.dependencies.migrations, migration.id),
    };
  }
}

export class GetShardMigration {
  constructor(private readonly migrations: ShardMigrationRepository) {}

  async execute(id: string): Promise<ShardMigrationResult> {
    const migration = await this.migrations.findById(id);
    if (!migration) throw migrationNotFound();
    return {
      migration,
      progress: await requireProgress(this.migrations, id),
    };
  }
}

export class ListShardMigrations {
  constructor(
    private readonly buckets: Pick<LogicalBucketRepository, 'findById'>,
    private readonly migrations: ShardMigrationRepository,
  ) {}

  async execute(logicalBucketId: string): Promise<readonly ShardMigrationResult[]> {
    if (!(await this.buckets.findById(logicalBucketId))) {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_BUCKET_NOT_FOUND',
        'Logical bucket was not found',
      );
    }
    const migrations = await this.migrations.listByLogicalBucketId(
      logicalBucketId,
    );
    return Promise.all(
      migrations.map(async (migration) => ({
        migration,
        progress: await requireProgress(this.migrations, migration.id),
      })),
    );
  }
}

export interface TransferShardMigrationDependencies {
  readonly migrations: ShardMigrationRepository;
  readonly accounts: Pick<ManagedStorageAccountRepository, 'findById'>;
  readonly providers: ProviderRegistry;
  readonly vault: CredentialVault;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface ShardMigrationTransferResult {
  readonly taskId: string;
  readonly objectId: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly downloadUrl: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
  readonly leaseToken: string;
}

function validateSignedTransfer(
  signed: { readonly url: string; readonly expiresAt: string },
  now: number,
): number {
  const expiresAt = Date.parse(signed.expiresAt);
  if (
    !signed.url ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + (TRANSFER_TTL_SECONDS + 5) * 1_000
  ) {
    throw new ShardMigrationApplicationError(
      'SHARD_MIGRATION_CONFLICT',
      'Provider returned invalid migration transfer instructions',
    );
  }
  return expiresAt;
}

async function requireTransferAccounts(
  dependencies: Pick<TransferShardMigrationDependencies, 'accounts'>,
  transfer: ShardMigrationTransferAggregate,
) {
  const sourceLocation = transfer.sourceLocation;
  if (!sourceLocation) {
    throw new ShardMigrationApplicationError(
      'SHARD_MIGRATION_CONFLICT',
      'Migration source location is no longer available',
    );
  }
  const source = await dependencies.accounts.findById(
    sourceLocation.storageAccountId,
  );
  const target = await dependencies.accounts.findById(
    transfer.targetLocation.storageAccountId,
  );
  if (!source || !target) {
    throw new ShardMigrationApplicationError(
      'SHARD_MIGRATION_ACCOUNT_NOT_FOUND',
      'A migration storage account was not found',
    );
  }
  return { source, sourceLocation, target };
}

export class ClaimShardMigrationTransfer {
  constructor(
    private readonly dependencies: TransferShardMigrationDependencies,
  ) {}

  async execute(command: {
    readonly actorId: string;
    readonly migrationId: string;
  }): Promise<ShardMigrationTransferResult> {
    const migration = await this.dependencies.migrations.findById(
      command.migrationId,
    );
    if (!migration) throw migrationNotFound();
    if (migration.status !== 'RUNNING') {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_BLOCKED',
        'Migration is not running',
      );
    }
    const now = this.dependencies.clock.now();
    const leasedAt = now.toISOString();
    const leaseExpiresAt = new Date(
      now.getTime() + TRANSFER_TTL_SECONDS * 1_000,
    ).toISOString();
    const taskId = this.dependencies.ids.next();
    const claim = await this.dependencies.migrations.claimTransfer(
      {
        migrationId: migration.id,
        taskId,
        targetLocationId: this.dependencies.ids.next(),
        targetPhysicalKeyPrefix: 'objects/',
        leaseToken: this.dependencies.ids.next(),
        leasedAt,
        leaseExpiresAt,
      },
      {
        actorType: 'ADMIN',
        actorId: command.actorId,
        action: 'SHARD_MIGRATION_TRANSFER_CLAIMED',
        resourceType: 'SHARD_MIGRATION',
        resourceId: migration.id,
        createdAt: leasedAt,
        metadata: { taskId },
      },
    );
    if (claim.outcome === 'CAPACITY_UNAVAILABLE') {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_CAPACITY_UNAVAILABLE',
        'Target migration capacity is unavailable',
      );
    }
    if (claim.outcome === 'CONFLICT') {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_CONFLICT',
        'Migration changed while transfer was being claimed',
      );
    }
    if (claim.outcome === 'NONE') {
      const completed = await this.dependencies.migrations.completeIfReady(
        migration.id,
        leasedAt,
        {
          actorType: 'ADMIN',
          actorId: command.actorId,
          action: 'SHARD_MIGRATION_COMPLETED',
          resourceType: 'SHARD_MIGRATION',
          resourceId: migration.id,
          createdAt: leasedAt,
        },
      );
      throw new ShardMigrationApplicationError(
        completed === 'BLOCKED'
          ? 'SHARD_MIGRATION_BLOCKED'
          : 'SHARD_MIGRATION_NO_TRANSFER_AVAILABLE',
        completed === 'BLOCKED'
          ? 'Migration is blocked by unfinished object state'
          : 'No migration transfer is available',
      );
    }

    const transfer = claim.transfer;
    const { source, sourceLocation, target } = await requireTransferAccounts(
      this.dependencies,
      transfer,
    );
    const sourceProvider = this.dependencies.providers.forAccount(source);
    const targetProvider = this.dependencies.providers.forAccount(target);
    if (
      !source.capabilities.presignedDownload ||
      !sourceProvider.capabilities.presignedDownload ||
      !target.capabilities.presignedUpload ||
      !targetProvider.capabilities.presignedUpload
    ) {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_TARGET_UNAVAILABLE',
        'Migration accounts do not support direct signed transfer',
      );
    }
    const [sourceCredentials, targetCredentials] = await Promise.all([
      this.dependencies.vault.decrypt(source.credentialEnvelope),
      this.dependencies.vault.decrypt(target.credentialEnvelope),
    ]);
    const [download, upload] = await Promise.all([
      sourceProvider.createDownloadUrl({
        account: source,
        credentials: sourceCredentials,
        bucket: sourceLocation.physicalBucket,
        key: sourceLocation.physicalKey,
        expiresInSeconds: TRANSFER_TTL_SECONDS,
      }),
      targetProvider.createUploadUrl({
        account: target,
        credentials: targetCredentials,
        bucket: transfer.targetLocation.physicalBucket,
        key: transfer.targetLocation.physicalKey,
        contentType: transfer.object.contentType,
        sizeBytes: transfer.object.sizeBytes,
        expiresInSeconds: TRANSFER_TTL_SECONDS,
      }),
    ]);
    const expiresAt = new Date(
      Math.min(
        validateSignedTransfer(download, now.getTime()),
        validateSignedTransfer(upload, now.getTime()),
      ),
    ).toISOString();
    return {
      taskId: transfer.task.id,
      objectId: transfer.object.id,
      sizeBytes: transfer.object.sizeBytes,
      contentType: transfer.object.contentType,
      downloadUrl: download.url,
      uploadUrl: upload.url,
      expiresAt,
      leaseToken: transfer.task.leaseToken,
    };
  }
}

export interface CompleteShardMigrationTransferResult {
  readonly taskId: string;
  readonly status: 'SWITCHED' | 'COMPLETED';
  readonly migrationCompleted: boolean;
}

export class CompleteShardMigrationTransfer {
  constructor(
    private readonly dependencies: TransferShardMigrationDependencies,
  ) {}

  async execute(command: {
    readonly actorId: string;
    readonly taskId: string;
    readonly leaseToken: string;
  }): Promise<CompleteShardMigrationTransferResult> {
    let transfer = await this.dependencies.migrations.findTransfer(
      command.taskId,
      command.leaseToken,
    );
    if (!transfer) {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_TRANSFER_NOT_FOUND',
        'Migration transfer was not found',
      );
    }
    if (
      transfer.task.status === 'FAILED' ||
      (transfer.task.status !== 'COMPLETED' &&
        transfer.migration.status !== 'RUNNING')
    ) {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_CONFLICT',
        'Migration transfer is not in a completable state',
      );
    }
    let now = this.dependencies.clock.now();
    if (
      transfer.task.status === 'RESERVED' &&
      now.getTime() >= Date.parse(transfer.task.leaseExpiresAt)
    ) {
      throw new ShardMigrationApplicationError(
        'SHARD_MIGRATION_TRANSFER_EXPIRED',
        'Migration transfer lease has expired',
      );
    }
    if (transfer.task.status === 'RESERVED') {
      const target = await this.dependencies.accounts.findById(
        transfer.targetLocation.storageAccountId,
      );
      if (!target) {
        throw new ShardMigrationApplicationError(
          'SHARD_MIGRATION_ACCOUNT_NOT_FOUND',
          'Target migration account was not found',
        );
      }
      const targetProvider = this.dependencies.providers.forAccount(target);
      const metadata = await targetProvider.headObject({
        account: target,
        credentials: await this.dependencies.vault.decrypt(
          target.credentialEnvelope,
        ),
        bucket: transfer.targetLocation.physicalBucket,
        key: transfer.targetLocation.physicalKey,
      });
      if (
        metadata.sizeBytes !== transfer.object.sizeBytes ||
        (transfer.object.checksum !== null &&
          metadata.checksum !== null &&
          transfer.object.checksum !== metadata.checksum)
      ) {
        throw new ShardMigrationApplicationError(
          'SHARD_MIGRATION_TARGET_MISMATCH',
          'Migration target does not match source object metadata',
        );
      }
      const switchedAt = now.toISOString();
      const switched = await this.dependencies.migrations.switchPrimary(
        transfer.task.id,
        command.leaseToken,
        metadata.etag,
        switchedAt,
        {
          actorType: 'ADMIN',
          actorId: command.actorId,
          action: 'SHARD_MIGRATION_OBJECT_SWITCHED',
          resourceType: 'OBJECT',
          resourceId: transfer.object.id,
          createdAt: switchedAt,
          metadata: { migrationId: transfer.migration.id },
        },
      );
      if (
        switched !== 'SWITCHED' &&
        switched !== 'ALREADY_SWITCHED' &&
        switched !== 'ALREADY_COMPLETED'
      ) {
        throw new ShardMigrationApplicationError(
          'SHARD_MIGRATION_CONFLICT',
          'Object changed while migration primary was switching',
        );
      }
      transfer =
        (await this.dependencies.migrations.findTransfer(
          command.taskId,
          command.leaseToken,
        )) ?? transfer;
    }

    if (transfer.task.status !== 'COMPLETED') {
      await deleteMigrationSource(this.dependencies, transfer);
      now = this.dependencies.clock.now();
      const cleaned = await this.dependencies.migrations.finishSourceCleanup(
        transfer.task.id,
        now.toISOString(),
        {
          actorType: 'ADMIN',
          actorId: command.actorId,
          action: 'SHARD_MIGRATION_OBJECT_COMPLETED',
          resourceType: 'OBJECT',
          resourceId: transfer.object.id,
          createdAt: now.toISOString(),
          metadata: { migrationId: transfer.migration.id },
        },
      );
      if (cleaned !== 'COMPLETED' && cleaned !== 'ALREADY_COMPLETED') {
        throw new ShardMigrationApplicationError(
          'SHARD_MIGRATION_CONFLICT',
          'Migration source changed while cleanup was completing',
        );
      }
    }

    const completedAt = this.dependencies.clock.now().toISOString();
    const migrationCompletion =
      await this.dependencies.migrations.completeIfReady(
        transfer.migration.id,
        completedAt,
        {
          actorType: 'ADMIN',
          actorId: command.actorId,
          action: 'SHARD_MIGRATION_COMPLETED',
          resourceType: 'SHARD_MIGRATION',
          resourceId: transfer.migration.id,
          createdAt: completedAt,
        },
      );
    const migrationCompleted =
      migrationCompletion === 'COMPLETED' ||
      migrationCompletion === 'ALREADY_COMPLETED';
    return {
      taskId: transfer.task.id,
      status: 'COMPLETED',
      migrationCompleted,
    };
  }
}

async function deleteMigrationSource(
  dependencies: Pick<
    TransferShardMigrationDependencies,
    'accounts' | 'providers' | 'vault'
  >,
  transfer: ShardMigrationTransferAggregate,
): Promise<void> {
  const { source, sourceLocation } = await requireTransferAccounts(
    dependencies,
    transfer,
  );
  const sourceProvider = dependencies.providers.forAccount(source);
  try {
    await sourceProvider.deleteObject({
      account: source,
      credentials: await dependencies.vault.decrypt(
        source.credentialEnvelope,
      ),
      bucket: sourceLocation.physicalBucket,
      key: sourceLocation.physicalKey,
    });
  } catch (error) {
    if (!(error instanceof ProviderError) || error.code !== 'NOT_FOUND') {
      throw error;
    }
  }
}

export interface SweepShardMigrationCleanupResult {
  readonly candidates: number;
  readonly cleaned: number;
  readonly completedMigrations: number;
  readonly failed: number;
}

/** Recovers tasks that switched primary before source deletion completed. */
export class SweepShardMigrationCleanup {
  constructor(
    private readonly dependencies: Pick<
      TransferShardMigrationDependencies,
      'migrations' | 'accounts' | 'providers' | 'vault' | 'clock'
    >,
  ) {}

  async execute(): Promise<SweepShardMigrationCleanupResult> {
    const candidates =
      await this.dependencies.migrations.listSourceCleanupCandidates(
        CLEANUP_BATCH_LIMIT,
      );
    let cleaned = 0;
    let completedMigrations = 0;
    let failed = 0;

    for (const transfer of candidates) {
      try {
        await deleteMigrationSource(this.dependencies, transfer);
        const now = this.dependencies.clock.now().toISOString();
        const cleanup =
          await this.dependencies.migrations.finishSourceCleanup(
            transfer.task.id,
            now,
            {
              actorType: 'SYSTEM',
              actorId: null,
              action: 'SHARD_MIGRATION_OBJECT_COMPLETED',
              resourceType: 'OBJECT',
              resourceId: transfer.object.id,
              createdAt: now,
              metadata: { migrationId: transfer.migration.id },
            },
          );
        if (cleanup !== 'COMPLETED' && cleanup !== 'ALREADY_COMPLETED') {
          throw new Error('Shard migration cleanup state changed');
        }
        if (cleanup === 'COMPLETED') {
          cleaned += 1;
        }
        const completion =
          await this.dependencies.migrations.completeIfReady(
            transfer.migration.id,
            now,
            {
              actorType: 'SYSTEM',
              actorId: null,
              action: 'SHARD_MIGRATION_COMPLETED',
              resourceType: 'SHARD_MIGRATION',
              resourceId: transfer.migration.id,
              createdAt: now,
            },
          );
        if (completion === 'COMPLETED') {
          completedMigrations += 1;
        }
      } catch {
        failed += 1;
      }
    }

    return {
      candidates: candidates.length,
      cleaned,
      completedMigrations,
      failed,
    };
  }
}

function migrationNotFound(): ShardMigrationApplicationError {
  return new ShardMigrationApplicationError(
    'SHARD_MIGRATION_NOT_FOUND',
    'Shard migration was not found',
  );
}

async function requireProgress(
  migrations: ShardMigrationRepository,
  id: string,
): Promise<ShardMigrationProgress> {
  const progress = await migrations.progress(id);
  if (!progress) throw migrationNotFound();
  return progress;
}
