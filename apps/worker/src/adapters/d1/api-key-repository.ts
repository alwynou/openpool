import type {
  ApiKeyRecord,
  ApiKeyRepository,
  AuditLogEntry,
} from '@openpool/application';
import {
  apiKeyScopes,
  validateApiKeyName,
  validateApiKeyRestrictions,
  validateApiKeyScopes,
  type ApiKeyScope,
} from '@openpool/domain';
import type { D1AuditOutboxRepository } from './audit-outbox-repository';

interface ApiKeyRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly key_prefix: unknown;
  readonly key_hash: unknown;
  readonly scopes: unknown;
  readonly logical_bucket_id: unknown;
  readonly path_prefix: unknown;
  readonly expires_at: unknown;
  readonly revoked_at: unknown;
  readonly created_at: unknown;
}

const selectColumns = `
  SELECT id, name, key_prefix, key_hash, scopes, logical_bucket_id,
         path_prefix, expires_at, revoked_at, created_at
  FROM api_keys`;

const scopeSet = new Set<string>(apiKeyScopes);
const prefixPattern = /^opk_[A-Za-z0-9_-]{8}$/u;
const hashPattern = /^hmac-sha256\$v=1\$[A-Za-z0-9_-]{43}$/u;

function failClosed(field: string): never {
  throw new Error(`Invalid API key ${field}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) failClosed(field);
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') failClosed(field);
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

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}

function parseScopes(value: unknown): readonly ApiKeyScope[] {
  if (typeof value !== 'string') failClosed('scopes');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    failClosed('scopes');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((scope) => typeof scope !== 'string' || !scopeSet.has(scope))
  ) {
    failClosed('scopes');
  }
  try {
    validateApiKeyScopes(parsed as readonly ApiKeyScope[]);
  } catch {
    failClosed('scopes');
  }
  return [...(parsed as readonly ApiKeyScope[])];
}

function validateRecord(record: ApiKeyRecord): void {
  text(record.id, 'id');
  if (!prefixPattern.test(record.keyPrefix)) failClosed('key_prefix');
  if (!hashPattern.test(record.keyHash)) failClosed('key_hash');
  timestamp(record.createdAt, 'created_at');
  nullableTimestamp(record.expiresAt, 'expires_at');
  nullableTimestamp(record.revokedAt, 'revoked_at');
  try {
    validateApiKeyName(record.name);
    validateApiKeyScopes(record.scopes);
    validateApiKeyRestrictions(record.logicalBucketId, record.pathPrefix);
  } catch {
    failClosed('state');
  }
}

function mapApiKey(row: ApiKeyRow): ApiKeyRecord {
  const keyPrefix = text(row.key_prefix, 'key_prefix');
  const keyHash = text(row.key_hash, 'key_hash');
  if (!prefixPattern.test(keyPrefix)) failClosed('key_prefix');
  if (!hashPattern.test(keyHash)) failClosed('key_hash');

  const record: ApiKeyRecord = {
    id: text(row.id, 'id'),
    name: text(row.name, 'name'),
    keyPrefix,
    keyHash,
    scopes: parseScopes(row.scopes),
    logicalBucketId: nullableText(row.logical_bucket_id, 'logical_bucket_id'),
    pathPrefix: nullableText(row.path_prefix, 'path_prefix'),
    expiresAt: nullableTimestamp(row.expires_at, 'expires_at'),
    revokedAt: nullableTimestamp(row.revoked_at, 'revoked_at'),
    createdAt: timestamp(row.created_at, 'created_at'),
  };
  validateRecord(record);
  return record;
}

/** D1 persistence for API key metadata; it never accepts or stores raw tokens. */
export class D1ApiKeyRepository implements ApiKeyRepository {
  constructor(
    private readonly db: D1Database,
    private readonly auditOutbox?: Pick<
      D1AuditOutboxRepository,
      'statement' | 'assertPreviousChanges'
    >,
  ) {}

  private async write(
    statement: D1PreparedStatement,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    if (!this.auditOutbox) {
      throw new Error('API key mutation requires an audit outbox');
    }
    try {
      const results = await this.db.batch([
        statement,
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

  async create(apiKey: ApiKeyRecord, audit: AuditLogEntry): Promise<boolean> {
    validateRecord(apiKey);
    const insert = this.db
      .prepare(
        `INSERT OR IGNORE INTO api_keys
         (id, name, key_prefix, key_hash, scopes, logical_bucket_id,
          path_prefix, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        apiKey.id,
        apiKey.name,
        apiKey.keyPrefix,
        apiKey.keyHash,
        JSON.stringify(apiKey.scopes),
        apiKey.logicalBucketId,
        apiKey.pathPrefix,
        apiKey.expiresAt,
        apiKey.revokedAt,
        apiKey.createdAt,
      );
    return this.write(insert, audit);
  }

  async list(): Promise<readonly ApiKeyRecord[]> {
    const result = await this.db
      .prepare(`${selectColumns} ORDER BY created_at ASC, id ASC`)
      .all<ApiKeyRow>();
    return result.results.map(mapApiKey);
  }

  async findById(id: string): Promise<ApiKeyRecord | undefined> {
    const row = await this.db
      .prepare(`${selectColumns} WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<ApiKeyRow>();
    return row === null ? undefined : mapApiKey(row);
  }

  async findByKeyHash(keyHash: string): Promise<ApiKeyRecord | undefined> {
    const row = await this.db
      .prepare(`${selectColumns} WHERE key_hash = ? LIMIT 1`)
      .bind(keyHash)
      .first<ApiKeyRow>();
    return row === null ? undefined : mapApiKey(row);
  }

  async revoke(
    id: string,
    revokedAt: string,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    timestamp(revokedAt, 'revoked_at');
    const update = this.db
      .prepare(
        `UPDATE api_keys
         SET revoked_at = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .bind(revokedAt, id);
    return this.write(update, audit);
  }
}
