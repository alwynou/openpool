import type { LogicalBucketRepository } from '@openpool/application';
import {
  validateLogicalBucketDescription,
  validateLogicalBucketName,
  type LogicalBucket,
} from '@openpool/domain';

interface LogicalBucketRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly description: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

const selectColumns = `
  SELECT id, name, description, created_at, updated_at
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

function validateBucket(bucket: LogicalBucket): void {
  text(bucket.id, 'id');
  text(bucket.createdAt, 'created_at');
  text(bucket.updatedAt, 'updated_at');

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
    createdAt: text(row.created_at, 'created_at'),
    updatedAt: text(row.updated_at, 'updated_at'),
  };
  validateBucket(bucket);
  return bucket;
}

/** D1 adapter for logical namespaces, independent of physical providers. */
export class D1LogicalBucketRepository implements LogicalBucketRepository {
  constructor(private readonly db: D1Database) {}

  async create(bucket: LogicalBucket): Promise<boolean> {
    validateBucket(bucket);
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO logical_buckets
         (id, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        bucket.id,
        bucket.name,
        bucket.description,
        bucket.createdAt,
        bucket.updatedAt,
      )
      .run();
    return result.meta.changes === 1;
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
}
