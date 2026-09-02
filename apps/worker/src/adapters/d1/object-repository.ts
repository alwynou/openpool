import type {
  AuditLogEntry,
  BeginDeletePersistenceResult,
  CompleteUploadPersistenceResult,
  ExpireUploadPersistenceResult,
  ExpiredUploadCandidate,
  FinishExpiredUploadCleanupPersistenceResult,
  FinishDeletePersistenceResult,
  ObjectAggregate,
  ObjectListQuery,
  ObjectRepository,
  ObjectReservationResult,
} from '@openpool/application';
import {
  objectStatuses,
  uploadSessionStatuses,
  validateObjectInput,
  validatePhysicalBucketName,
  type ObjectLocation,
  type ObjectStatus,
  type StoredObject,
  type UploadSession,
  type UploadSessionStatus,
} from '@openpool/domain';
import type { D1AuditOutboxRepository } from './audit-outbox-repository';

type DatabaseRow = Record<string, unknown>;

const objectStatusSet = new Set<ObjectStatus>(objectStatuses);
const uploadStatusSet = new Set<UploadSessionStatus>(uploadSessionStatuses);

const objectColumns = `
  object.id,
  object.logical_bucket_id,
  object.logical_key,
  object.size_bytes,
  object.content_type,
  object.checksum,
  object.status,
  object.created_at,
  object.updated_at`;

const locationColumns = `
  location.id,
  location.object_id,
  location.storage_account_id,
  location.storage_shard_id,
  location.physical_bucket,
  location.physical_key,
  location.etag,
  location.is_primary,
  location.created_at,
  location.updated_at`;

const sessionColumns = `
  session.id,
  session.object_id,
  session.status,
  session.expires_at,
  session.created_at,
  session.completed_at`;

function failClosed(field: string): never {
  throw new Error(`Invalid object aggregate ${field}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) failClosed(field);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const encoded = text(value, field);
  const parsed = Date.parse(encoded);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== encoded) {
    failClosed(field);
  }
  return encoded;
}

function nullableText(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') failClosed(field);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failClosed(field);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  field: string,
): T {
  if (typeof value !== 'string' || !values.has(value as T)) {
    failClosed(field);
  }
  return value as T;
}

function mapObject(row: DatabaseRow): StoredObject {
  const object: StoredObject = {
    id: text(row.id, 'object.id'),
    logicalBucketId: text(
      row.logical_bucket_id,
      'object.logical_bucket_id',
    ),
    logicalKey: text(row.logical_key, 'object.logical_key'),
    sizeBytes: nonNegativeInteger(row.size_bytes, 'object.size_bytes'),
    contentType: text(row.content_type, 'object.content_type'),
    checksum: nullableText(row.checksum, 'object.checksum'),
    status: oneOf(row.status, objectStatusSet, 'object.status'),
    createdAt: text(row.created_at, 'object.created_at'),
    updatedAt: text(row.updated_at, 'object.updated_at'),
  };

  try {
    validateObjectInput(
      object.logicalKey,
      object.sizeBytes,
      object.contentType,
    );
  } catch {
    failClosed('object.state');
  }
  return object;
}

function mapLocation(row: DatabaseRow): ObjectLocation {
  if (row.is_primary !== 1) failClosed('location.is_primary');
  const location: ObjectLocation = {
    id: text(row.id, 'location.id'),
    objectId: text(row.object_id, 'location.object_id'),
    storageAccountId: text(
      row.storage_account_id,
      'location.storage_account_id',
    ),
    storageShardId: text(row.storage_shard_id, 'location.storage_shard_id'),
    physicalBucket: text(row.physical_bucket, 'location.physical_bucket'),
    physicalKey: text(row.physical_key, 'location.physical_key'),
    etag: nullableText(row.etag, 'location.etag'),
    isPrimary: true,
    createdAt: text(row.created_at, 'location.created_at'),
    updatedAt: text(row.updated_at, 'location.updated_at'),
  };

  try {
    validatePhysicalBucketName(location.physicalBucket);
  } catch {
    failClosed('location.physical_bucket');
  }
  return location;
}

function mapSession(row: DatabaseRow): UploadSession {
  const session: UploadSession = {
    id: text(row.id, 'session.id'),
    objectId: text(row.object_id, 'session.object_id'),
    status: oneOf(row.status, uploadStatusSet, 'session.status'),
    expiresAt: text(row.expires_at, 'session.expires_at'),
    createdAt: text(row.created_at, 'session.created_at'),
    completedAt: nullableText(row.completed_at, 'session.completed_at'),
  };
  if (
    (session.status === 'COMPLETED') !== (session.completedAt !== null)
  ) {
    failClosed('session.state');
  }
  return session;
}

function aggregateFromRows(
  objectRows: readonly DatabaseRow[],
  locationRows: readonly DatabaseRow[],
  sessionRows: readonly DatabaseRow[],
): ObjectAggregate | undefined {
  if (objectRows.length === 0) {
    if (locationRows.length !== 0 || sessionRows.length !== 0) {
      failClosed('orphaned_rows');
    }
    return undefined;
  }
  if (objectRows.length !== 1) failClosed('object.count');
  if (locationRows.length !== 1) failClosed('primary_location.count');
  if (sessionRows.length > 1) failClosed('upload_session.count');

  const objectRow = objectRows.at(0);
  const locationRow = locationRows.at(0);
  if (objectRow === undefined || locationRow === undefined) {
    failClosed('required_rows');
  }
  const object = mapObject(objectRow);
  const primaryLocation = mapLocation(locationRow);
  const sessionRow = sessionRows.at(0);
  const uploadSession =
    sessionRow === undefined ? null : mapSession(sessionRow);
  if (
    primaryLocation.objectId !== object.id ||
    (uploadSession !== null && uploadSession.objectId !== object.id)
  ) {
    failClosed('relationship');
  }
  if (
    object.status !== 'PENDING' &&
    uploadSession?.status !== 'COMPLETED'
  ) {
    failClosed('lifecycle');
  }
  if (
    object.status === 'PENDING' &&
    uploadSession?.status === 'COMPLETED'
  ) {
    failClosed('lifecycle');
  }
  return { object, primaryLocation, uploadSession };
}

function validateReservation(
  object: StoredObject,
  location: ObjectLocation,
  session: UploadSession,
): void {
  mapObject({
    id: object.id,
    logical_bucket_id: object.logicalBucketId,
    logical_key: object.logicalKey,
    size_bytes: object.sizeBytes,
    content_type: object.contentType,
    checksum: object.checksum,
    status: object.status,
    created_at: object.createdAt,
    updated_at: object.updatedAt,
  });
  mapLocation({
    id: location.id,
    object_id: location.objectId,
    storage_account_id: location.storageAccountId,
    storage_shard_id: location.storageShardId,
    physical_bucket: location.physicalBucket,
    physical_key: location.physicalKey,
    etag: location.etag,
    is_primary: location.isPrimary ? 1 : 0,
    created_at: location.createdAt,
    updated_at: location.updatedAt,
  });
  mapSession({
    id: session.id,
    object_id: session.objectId,
    status: session.status,
    expires_at: session.expiresAt,
    created_at: session.createdAt,
    completed_at: session.completedAt,
  });
  if (
    object.status !== 'PENDING' ||
    object.checksum !== null ||
    location.objectId !== object.id ||
    !location.isPrimary ||
    location.etag !== null ||
    session.objectId !== object.id ||
    session.status !== 'PENDING' ||
    session.completedAt !== null
  ) {
    failClosed('reservation.state');
  }
}

function isExpectedConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('openpool_object_') ||
    message.includes('SQLITE_CONSTRAINT') ||
    message.toLowerCase().includes('constraint failed')
  );
}

function isAuditOutboxFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('audit_outbox');
}

function softLimit(capacityBytes: number): number {
  return capacityBytes - Math.ceil(capacityBytes / 10);
}

interface OperationState {
  readonly objectStatus: ObjectStatus;
  readonly sessionStatus: UploadSessionStatus | null;
}

/** D1 authority for logical-object aggregates and their capacity reservations. */
export class D1ObjectRepository implements ObjectRepository {
  constructor(
    private readonly db: D1Database,
    private readonly auditOutbox?: Pick<D1AuditOutboxRepository, 'statement'>,
  ) {}

  private auditStatement(audit: AuditLogEntry): D1PreparedStatement {
    if (this.auditOutbox === undefined) {
      throw new Error('Object mutation requires audit outbox');
    }
    return this.auditOutbox.statement(audit);
  }

  private mutationAssertion(): D1PreparedStatement {
    return this.db.prepare(
      'INSERT INTO object_repository_assertions (ok) VALUES (changes())',
    );
  }

  async reserveUploadAndCapacity(
    object: StoredObject,
    location: ObjectLocation,
    session: UploadSession,
    audit: AuditLogEntry,
  ): Promise<ObjectReservationResult> {
    validateReservation(object, location, session);
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO objects
             (id, logical_bucket_id, logical_key, size_bytes, content_type,
              checksum, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            object.id,
            object.logicalBucketId,
            object.logicalKey,
            object.sizeBytes,
            object.contentType,
            object.checksum,
            object.status,
            object.createdAt,
            object.updatedAt,
          ),
        this.db
          .prepare(
            `INSERT INTO object_locations
             (id, object_id, storage_account_id, storage_shard_id,
              physical_bucket, physical_key, etag, is_primary, created_at,
              updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            location.id,
            location.objectId,
            location.storageAccountId,
            location.storageShardId,
            location.physicalBucket,
            location.physicalKey,
            location.etag,
            1,
            location.createdAt,
            location.updatedAt,
          ),
        this.db
          .prepare(
            `INSERT INTO upload_sessions
             (id, object_id, status, expires_at, created_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            session.id,
            session.objectId,
            session.status,
            session.expiresAt,
            session.createdAt,
            session.completedAt,
          ),
        this.auditStatement(audit),
      ]);
      return 'RESERVED';
    } catch (error) {
      if (isAuditOutboxFailure(error)) throw error;
      if (!isExpectedConstraint(error)) throw error;
      return this.classifyReservationFailure(object, location);
    }
  }

  findById(id: string): Promise<ObjectAggregate | undefined> {
    text(id, 'lookup.id');
    return this.findAggregate('object.id = ?', [id]);
  }

  findByLogicalKey(
    logicalBucketId: string,
    logicalKey: string,
  ): Promise<ObjectAggregate | undefined> {
    text(logicalBucketId, 'lookup.logical_bucket_id');
    text(logicalKey, 'lookup.logical_key');
    return this.findAggregate(
      'object.logical_bucket_id = ? AND object.logical_key = ?',
      [logicalBucketId, logicalKey],
    );
  }

  async list(query: ObjectListQuery): Promise<readonly StoredObject[]> {
    text(query.logicalBucketId, 'list.logical_bucket_id');
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 1_000
    ) {
      failClosed('list.limit');
    }
    if (query.status !== undefined && !objectStatusSet.has(query.status)) {
      failClosed('list.status');
    }

    const predicates = ['object.logical_bucket_id = ?'];
    const bindings: unknown[] = [query.logicalBucketId];
    if (query.status !== undefined) {
      predicates.push('object.status = ?');
      bindings.push(query.status);
    }
    if (query.prefix !== undefined) {
      predicates.push('substr(object.logical_key, 1, length(?)) = ?');
      bindings.push(query.prefix, query.prefix);
    }
    if (query.afterKey !== undefined) {
      predicates.push('object.logical_key > ?');
      bindings.push(query.afterKey);
    }
    bindings.push(query.limit);

    const result = await this.db
      .prepare(
        `SELECT ${objectColumns}
         FROM objects AS object
         WHERE ${predicates.join(' AND ')}
         ORDER BY object.logical_key ASC, object.id ASC
         LIMIT ?`,
      )
      .bind(...bindings)
      .all<DatabaseRow>();
    return result.results.map(mapObject);
  }

  async listExpiredPendingUploads(
    expiredAtOrBefore: string,
    limit: number,
  ): Promise<readonly ExpiredUploadCandidate[]> {
    timestamp(expiredAtOrBefore, 'expired_uploads.cutoff');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      failClosed('expired_uploads.limit');
    }
    const result = await this.db
      .prepare(
        `SELECT session.object_id, session.id AS upload_session_id
         FROM upload_sessions AS session
         JOIN objects AS object ON object.id = session.object_id
         WHERE session.status = 'PENDING'
           AND object.status = 'PENDING'
           AND session.expires_at <= ?
         ORDER BY session.expires_at ASC, session.id ASC
         LIMIT ?`,
      )
      .bind(expiredAtOrBefore, limit)
      .all<DatabaseRow>();
    return result.results.map((row) => ({
      objectId: text(row.object_id, 'expired_uploads.object_id'),
      uploadSessionId: text(
        row.upload_session_id,
        'expired_uploads.upload_session_id',
      ),
    }));
  }

  async listExpiredUploadsAwaitingCleanup(
    limit: number,
  ): Promise<readonly ExpiredUploadCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      failClosed('expired_cleanup.limit');
    }
    const result = await this.db
      .prepare(
        `SELECT session.object_id, session.id AS upload_session_id
         FROM upload_sessions AS session
         JOIN objects AS object ON object.id = session.object_id
         WHERE session.status = 'EXPIRED'
           AND object.status = 'PENDING'
         ORDER BY session.expires_at ASC, session.id ASC
         LIMIT ?`,
      )
      .bind(limit)
      .all<DatabaseRow>();
    return result.results.map((row) => ({
      objectId: text(row.object_id, 'expired_cleanup.object_id'),
      uploadSessionId: text(
        row.upload_session_id,
        'expired_cleanup.upload_session_id',
      ),
    }));
  }

  async completeUpload(
    objectId: string,
    uploadSessionId: string,
    completedAt: string,
    etag: string | null,
    checksum: string | null,
    audit: AuditLogEntry,
  ): Promise<CompleteUploadPersistenceResult> {
    text(objectId, 'complete.object_id');
    text(uploadSessionId, 'complete.upload_session_id');
    text(completedAt, 'complete.completed_at');
    nullableText(etag, 'complete.etag');
    nullableText(checksum, 'complete.checksum');

    const before = await this.operationState(objectId, uploadSessionId);
    const classified = this.classifyCompleteState(before);
    if (classified !== 'CONFLICT') return classified;

    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE objects
             SET status = 'READY', checksum = ?, updated_at = ?
             WHERE id = ? AND status = 'PENDING'
               AND EXISTS (
                 SELECT 1 FROM upload_sessions
                 WHERE id = ? AND object_id = ? AND status = 'PENDING'
               )`,
          )
          .bind(
            checksum,
            completedAt,
            objectId,
            uploadSessionId,
            objectId,
          ),
        this.db.prepare(
          'INSERT INTO object_repository_assertions (ok) VALUES (changes())',
        ),
        this.db
          .prepare(
            `UPDATE object_locations
             SET etag = ?, updated_at = ?
             WHERE object_id = ? AND is_primary = 1
               AND EXISTS (
                 SELECT 1 FROM objects
                 WHERE id = ? AND status = 'READY' AND checksum IS ?
               )
               AND EXISTS (
                 SELECT 1 FROM upload_sessions
                 WHERE id = ? AND object_id = ? AND status = 'PENDING'
               )`,
          )
          .bind(
            etag,
            completedAt,
            objectId,
            objectId,
            checksum,
            uploadSessionId,
            objectId,
          ),
        this.db.prepare(
          'INSERT INTO object_repository_assertions (ok) VALUES (changes())',
        ),
        this.db
          .prepare(
            `UPDATE upload_sessions
             SET status = 'COMPLETED', completed_at = ?
             WHERE id = ? AND object_id = ? AND status = 'PENDING'
               AND EXISTS (
                 SELECT 1 FROM objects
                 WHERE id = ? AND status = 'READY' AND checksum IS ?
               )`,
          )
          .bind(
            completedAt,
            uploadSessionId,
            objectId,
            objectId,
            checksum,
          ),
        this.db.prepare(
          'INSERT INTO object_repository_assertions (ok) VALUES (changes())',
        ),
        this.auditStatement(audit),
      ]);
      return 'COMPLETED';
    } catch (error) {
      if (isAuditOutboxFailure(error)) throw error;
      if (!isExpectedConstraint(error)) throw error;
      const after = await this.operationState(objectId, uploadSessionId);
      const afterClassification = this.classifyCompleteState(after);
      return afterClassification === 'CONFLICT'
        ? 'CONFLICT'
        : afterClassification;
    }
  }

  async expireUploadAndReleaseCapacity(
    objectId: string,
    uploadSessionId: string,
    expiredAt: string,
    audit: AuditLogEntry,
  ): Promise<ExpireUploadPersistenceResult> {
    text(objectId, 'expire.object_id');
    text(uploadSessionId, 'expire.upload_session_id');
    text(expiredAt, 'expire.expired_at');
    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE objects
             SET updated_at = ?
             WHERE id = ? AND status = 'PENDING'
               AND EXISTS (
                 SELECT 1 FROM upload_sessions
                 WHERE id = ? AND object_id = ? AND status = 'PENDING'
               )`,
          )
          .bind(expiredAt, objectId, uploadSessionId, objectId),
        this.db.prepare(
          'INSERT INTO object_repository_assertions (ok) VALUES (changes())',
        ),
        this.db
          .prepare(
            `UPDATE upload_sessions
             SET status = 'EXPIRED', completed_at = NULL
             WHERE id = ? AND object_id = ? AND status = 'PENDING'
               AND EXISTS (
                 SELECT 1 FROM objects
                 WHERE id = ? AND status = 'PENDING' AND updated_at = ?
               )`,
          )
          .bind(uploadSessionId, objectId, objectId, expiredAt),
        this.db.prepare(
          'INSERT INTO object_repository_assertions (ok) VALUES (changes())',
        ),
        this.auditStatement(audit),
      ]);
      return 'EXPIRED';
    } catch (error) {
      if (isAuditOutboxFailure(error)) throw error;
      if (!isExpectedConstraint(error)) throw error;
      const state = await this.operationState(objectId, uploadSessionId);
      const classification = this.classifyExpireState(state);
      return classification === 'CONFLICT' ? 'CONFLICT' : classification;
    }
  }

  async finishExpiredUploadCleanup(
    objectId: string,
    uploadSessionId: string,
    audit: AuditLogEntry,
  ): Promise<FinishExpiredUploadCleanupPersistenceResult> {
    text(objectId, 'expired_cleanup.object_id');
    text(uploadSessionId, 'expired_cleanup.upload_session_id');
    const before = await this.operationState(objectId, uploadSessionId);
    if (before === null) return 'NOT_FOUND';
    if (before.sessionStatus !== 'EXPIRED') {
      return before.sessionStatus === 'ABORTED'
        ? 'ALREADY_CLEANED'
        : 'INVALID_STATE';
    }
    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE upload_sessions
             SET status = 'ABORTED'
             WHERE id = ? AND object_id = ? AND status = 'EXPIRED'`,
          )
          .bind(uploadSessionId, objectId),
        this.mutationAssertion(),
        this.auditStatement(audit),
      ]);
      return 'CLEANED';
    } catch (error) {
      if (isAuditOutboxFailure(error)) throw error;
      if (!isExpectedConstraint(error)) throw error;
    }
    const state = await this.operationState(objectId, uploadSessionId);
    if (state === null) return 'NOT_FOUND';
    if (state.sessionStatus === 'ABORTED') return 'ALREADY_CLEANED';
    return 'INVALID_STATE';
  }

  async beginDelete(
    objectId: string,
    updatedAt: string,
    audit: AuditLogEntry,
  ): Promise<BeginDeletePersistenceResult> {
    text(objectId, 'delete.object_id');
    text(updatedAt, 'delete.updated_at');
    const currentStatus = await this.objectStatus(objectId);
    if (currentStatus === null) return 'NOT_FOUND';
    if (currentStatus !== 'READY') {
      if (currentStatus === 'DELETING') return 'ALREADY_DELETING';
      if (currentStatus === 'DELETED') return 'ALREADY_DELETED';
      return 'INVALID_STATE';
    }
    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE objects
             SET status = 'DELETING', updated_at = ?
             WHERE id = ? AND status = 'READY'
               AND NOT EXISTS (
                 SELECT 1 FROM shard_migration_objects AS migration_task
                 WHERE migration_task.object_id = objects.id
                   AND migration_task.status IN ('RESERVED', 'SWITCHED')
               )`,
          )
          .bind(updatedAt, objectId),
        this.mutationAssertion(),
        this.auditStatement(audit),
      ]);
      return 'STARTED';
    } catch (error) {
      if (isAuditOutboxFailure(error)) throw error;
      if (!isExpectedConstraint(error)) throw error;
    }
    const status = await this.objectStatus(objectId);
    if (status === null) return 'NOT_FOUND';
    if (status === 'DELETING') return 'ALREADY_DELETING';
    if (status === 'DELETED') return 'ALREADY_DELETED';
    if (status === 'READY') return 'CONFLICT';
    return 'INVALID_STATE';
  }

  async finishDeleteAndReleaseCapacity(
    objectId: string,
    updatedAt: string,
    audit: AuditLogEntry,
  ): Promise<FinishDeletePersistenceResult> {
    text(objectId, 'finish_delete.object_id');
    text(updatedAt, 'finish_delete.updated_at');
    const currentStatus = await this.objectStatus(objectId);
    if (currentStatus === null) return 'NOT_FOUND';
    if (currentStatus !== 'DELETING') {
      return currentStatus === 'DELETED' ? 'ALREADY_DELETED' : 'INVALID_STATE';
    }
    try {
      await this.db.batch([
        this.db.prepare(
          `UPDATE objects
           SET status = 'DELETED', updated_at = ?
           WHERE id = ? AND status = 'DELETING'
           RETURNING id`,
        ).bind(updatedAt, objectId),
        this.mutationAssertion(),
        this.auditStatement(audit),
      ]);
      return 'DELETED';
    } catch (error) {
      if (isAuditOutboxFailure(error)) throw error;
      if (!isExpectedConstraint(error)) throw error;
    }
    const status = await this.objectStatus(objectId);
    if (status === null) return 'NOT_FOUND';
    if (status === 'DELETED') return 'ALREADY_DELETED';
    return 'INVALID_STATE';
  }

  private async findAggregate(
    objectPredicate: string,
    bindings: readonly unknown[],
  ): Promise<ObjectAggregate | undefined> {
    const results = await this.db.batch<DatabaseRow>([
      this.db
        .prepare(
          `SELECT ${objectColumns}
           FROM objects AS object
           WHERE ${objectPredicate}`,
        )
        .bind(...bindings),
      this.db
        .prepare(
          `SELECT ${locationColumns}
           FROM object_locations AS location
           JOIN objects AS object ON object.id = location.object_id
           WHERE ${objectPredicate} AND location.is_primary = 1
           ORDER BY location.id ASC`,
        )
        .bind(...bindings),
      this.db
        .prepare(
          `SELECT ${sessionColumns}
           FROM upload_sessions AS session
           JOIN objects AS object ON object.id = session.object_id
           WHERE ${objectPredicate}
           ORDER BY session.created_at ASC, session.id ASC`,
        )
        .bind(...bindings),
    ]);
    return aggregateFromRows(
      results[0]?.results ?? [],
      results[1]?.results ?? [],
      results[2]?.results ?? [],
    );
  }

  private async classifyReservationFailure(
    object: StoredObject,
    location: ObjectLocation,
  ): Promise<ObjectReservationResult> {
    const namespace = await this.db
      .prepare(
        `SELECT id FROM objects
         WHERE logical_bucket_id = ? AND logical_key = ?
         LIMIT 1`,
      )
      .bind(object.logicalBucketId, object.logicalKey)
      .first<DatabaseRow>();
    if (namespace !== null) return 'OBJECT_CONFLICT';

    const row = await this.db
      .prepare(
        `SELECT
           shard.logical_bucket_id,
           shard.storage_account_id,
           shard.physical_bucket,
           shard.status AS shard_status,
           shard.capacity_bytes AS shard_capacity_bytes,
           shard.used_bytes AS shard_used_bytes,
           account.status AS account_status,
           account.write_enabled,
           account.last_health_status,
           account.capacity_accuracy,
           account.capacity_bytes AS account_capacity_bytes,
           account.used_bytes AS account_used_bytes
         FROM storage_shards AS shard
         JOIN storage_accounts AS account
           ON account.id = shard.storage_account_id
         WHERE shard.id = ? AND account.id = ?
         LIMIT 1`,
      )
      .bind(location.storageShardId, location.storageAccountId)
      .first<DatabaseRow>();
    if (
      row === null ||
      row.logical_bucket_id !== object.logicalBucketId ||
      row.storage_account_id !== location.storageAccountId ||
      row.physical_bucket !== location.physicalBucket ||
      row.shard_status !== 'ACTIVE' ||
      row.account_status !== 'ACTIVE' ||
      row.write_enabled !== 1 ||
      row.last_health_status !== 'HEALTHY' ||
      row.capacity_accuracy === 'UNKNOWN'
    ) {
      return 'SHARD_UNAVAILABLE';
    }

    const shardCapacity = nonNegativeInteger(
      row.shard_capacity_bytes,
      'reservation.shard_capacity_bytes',
    );
    const shardUsed = nonNegativeInteger(
      row.shard_used_bytes,
      'reservation.shard_used_bytes',
    );
    const accountCapacity = nonNegativeInteger(
      row.account_capacity_bytes,
      'reservation.account_capacity_bytes',
    );
    const accountUsed = nonNegativeInteger(
      row.account_used_bytes,
      'reservation.account_used_bytes',
    );
    if (
      object.sizeBytes > softLimit(shardCapacity) - shardUsed ||
      object.sizeBytes > softLimit(accountCapacity) - accountUsed
    ) {
      return 'CAPACITY_UNAVAILABLE';
    }
    return 'CONFLICT';
  }

  private async operationState(
    objectId: string,
    uploadSessionId: string,
  ): Promise<OperationState | null> {
    const row = await this.db
      .prepare(
        `SELECT object.status AS object_status,
                session.status AS session_status
         FROM objects AS object
         LEFT JOIN upload_sessions AS session
           ON session.object_id = object.id AND session.id = ?
         WHERE object.id = ?
         LIMIT 1`,
      )
      .bind(uploadSessionId, objectId)
      .first<DatabaseRow>();
    if (row === null) return null;
    return {
      objectStatus: oneOf(
        row.object_status,
        objectStatusSet,
        'operation.object_status',
      ),
      sessionStatus:
        row.session_status === null
          ? null
          : oneOf(
              row.session_status,
              uploadStatusSet,
              'operation.session_status',
            ),
    };
  }

  private classifyCompleteState(
    state: OperationState | null,
  ): CompleteUploadPersistenceResult {
    if (state === null || state.sessionStatus === null) return 'NOT_FOUND';
    if (
      state.objectStatus === 'READY' &&
      state.sessionStatus === 'COMPLETED'
    ) {
      return 'ALREADY_COMPLETED';
    }
    if (
      state.objectStatus !== 'PENDING' ||
      state.sessionStatus !== 'PENDING'
    ) {
      return 'INVALID_STATE';
    }
    return 'CONFLICT';
  }

  private classifyExpireState(
    state: OperationState | null,
  ): ExpireUploadPersistenceResult {
    if (state === null || state.sessionStatus === null) return 'NOT_FOUND';
    if (state.sessionStatus === 'EXPIRED') return 'ALREADY_EXPIRED';
    if (
      state.objectStatus !== 'PENDING' ||
      state.sessionStatus !== 'PENDING'
    ) {
      return 'INVALID_STATE';
    }
    return 'CONFLICT';
  }

  private async objectStatus(objectId: string): Promise<ObjectStatus | null> {
    const row = await this.db
      .prepare('SELECT status FROM objects WHERE id = ? LIMIT 1')
      .bind(objectId)
      .first<DatabaseRow>();
    return row === null
      ? null
      : oneOf(row.status, objectStatusSet, 'operation.object_status');
  }
}
