import type {
  AuditLogEntry,
  LogicalBucketRepository,
} from '@openpool/application';
import {
  validateLogicalBucketDescription,
  validateLogicalBucketName,
  type LogicalBucket,
} from '@openpool/domain';

import type { D1AuditOutboxRepository } from './audit-outbox-repository';

interface LogicalBucketRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly description: unknown;
  readonly public_access_enabled: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

const selectColumns = `
  SELECT id, name, description, public_access_enabled, created_at, updated_at
  FROM logical_buckets`;

function failClosed(field: string): never {
  throw new Error(`Invalid logical bucket ${field}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) failClosed(field);
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') failClosed(field);
  return value;
}

function flag(value: unknown, field: string): boolean {
  if (value !== 0 && value !== 1) failClosed(field);
  return value === 1;
}

function validateBucket(bucket: LogicalBucket): void {
  text(bucket.id, 'id');
  text(bucket.createdAt, 'created_at');
  text(bucket.updatedAt, 'updated_at');
  if (typeof bucket.publicAccessEnabled !== 'boolean') {
    failClosed('public_access_enabled');
  }

  try {
    validateLogicalBucketName(bucket.name);
    validateLogicalBucketDescription(bucket.description);
  } catch {
    failClosed('state');
  }
}

function mapLogicalBucket(row: LogicalBucketRow): LogicalBucket {
  const bucket: LogicalBucket = {
    id: text(row.id, 'id'),
    name: text(row.name, 'name'),
    description: nullableText(row.description, 'description'),
    publicAccessEnabled: flag(
      row.public_access_enabled,
      'public_access_enabled',
    ),
    createdAt: text(row.created_at, 'created_at'),
    updatedAt: text(row.updated_at, 'updated_at'),
  };
  validateBucket(bucket);
  return bucket;
}

/** D1 adapter for logical namespaces, independent of physical providers. */
export class D1LogicalBucketRepository implements LogicalBucketRepository {
  constructor(
    private readonly db: D1Database,
    private readonly auditOutbox: Pick<
      D1AuditOutboxRepository,
      'statement' | 'assertPreviousChanges'
    >,
  ) {}

  async create(
    bucket: LogicalBucket,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    validateBucket(bucket);
    try {
      const results = await this.db.batch([
        this.db
          .prepare(
          `INSERT OR IGNORE INTO logical_buckets
             (id, name, description, public_access_enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            bucket.id,
            bucket.name,
            bucket.description,
            bucket.publicAccessEnabled ? 1 : 0,
            bucket.createdAt,
            bucket.updatedAt,
          ),
        this.auditOutbox.assertPreviousChanges(),
        this.auditOutbox.statement(audit),
      ]);
      return results[0]?.meta.changes === 1;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('openpool_audit_outbox_conflict')
      ) {
        return false;
      }
      throw error;
    }
  }

  async findById(id: string): Promise<LogicalBucket | undefined> {
    const row = await this.db
      .prepare(`${selectColumns} WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<LogicalBucketRow>();
    return row === null ? undefined : mapLogicalBucket(row);
  }

  async list(): Promise<readonly LogicalBucket[]> {
    const result = await this.db
      .prepare(`${selectColumns} ORDER BY created_at ASC, id ASC`)
      .all<LogicalBucketRow>();
    return result.results.map(mapLogicalBucket);
  }

  async updatePublicAccess(
    bucket: LogicalBucket,
    expectedUpdatedAt: string,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    validateBucket(bucket);
    text(expectedUpdatedAt, 'expected_updated_at');
    try {
      const results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE logical_buckets
             SET public_access_enabled = ?, updated_at = ?
             WHERE id = ? AND updated_at = ?`,
          )
          .bind(
            bucket.publicAccessEnabled ? 1 : 0,
            bucket.updatedAt,
            bucket.id,
            expectedUpdatedAt,
          ),
        this.auditOutbox.assertPreviousChanges(),
        this.auditOutbox.statement(audit),
      ]);
      return results[0]?.meta.changes === 1;
    } catch (error) {
      // The assertion is deliberately in the same batch as the conditional
      // update. A stale or missing row aborts the batch and is a normal false
      // result; all other audit failures must propagate and roll back.
      if (
        error instanceof Error &&
        error.message.includes('openpool_audit_outbox_conflict')
      ) {
        return false;
      }
      throw error;
    }
  }
}
