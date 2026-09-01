import type {
  AuditLog,
  AuditLogEntry,
  AuditOutboxClaim,
  AuditOutboxRepository,
  ClaimAuditOutboxInput,
  DeliverAuditOutboxResult,
} from '@openpool/application';

export interface D1AuditOutboxRepositoryOptions {
  readonly requestId?: string;
  readonly idGenerator?: () => string;
}

interface ClaimRow {
  readonly id: unknown;
  readonly attempt_count: unknown;
}

interface StatusRow {
  readonly status: unknown;
}

const actorTypes = new Set<AuditLogEntry['actorType']>([
  'ADMIN',
  'API_KEY',
  'SYSTEM',
]);

function identifier(value: string, field: string): string {
  if (
    value.length < 1 ||
    value.length > 128 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw new TypeError(`Invalid audit outbox ${field}`);
  }
  return value;
}

function optionalIdentifier(
  value: string | null,
  field: string,
): string | null {
  return value === null ? null : identifier(value, field);
}

function canonicalTimestamp(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new TypeError(`Invalid audit outbox ${field}`);
  }
  return value;
}

function encodeMetadata(entry: AuditLogEntry): string {
  const value = entry.metadata ?? {};
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.values(value).some((item) => typeof item !== 'string')
  ) {
    throw new TypeError('Invalid audit outbox metadata');
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > 8_192) {
    throw new TypeError('Invalid audit outbox metadata');
  }
  return encoded;
}

function validateEntry(entry: AuditLogEntry): void {
  if (!actorTypes.has(entry.actorType)) {
    throw new TypeError('Invalid audit outbox actor type');
  }
  if (entry.actorType === 'SYSTEM') {
    if (entry.actorId !== null) {
      throw new TypeError('Invalid audit outbox actor');
    }
  } else {
    optionalIdentifier(entry.actorId, 'actor id');
    if (entry.actorId === null) {
      throw new TypeError('Invalid audit outbox actor');
    }
  }
  identifier(entry.action, 'action');
  identifier(entry.resourceType, 'resource type');
  optionalIdentifier(entry.resourceId, 'resource id');
  canonicalTimestamp(entry.createdAt, 'created at');
  encodeMetadata(entry);
}

function stringRow(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid audit outbox ${field}`);
  }
  return value;
}

function attemptCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('Invalid audit outbox attempt count');
  }
  return value as number;
}

function validateRequestId(value: string | undefined): string | null {
  return value === undefined ? null : identifier(value, 'request id');
}

/** D1 append, claim, and idempotent projection of audit outbox events. */
export class D1AuditOutboxRepository
  implements AuditLog, AuditOutboxRepository
{
  private readonly requestId: string | null;
  private readonly idGenerator: () => string;

  constructor(
    private readonly db: D1Database,
    options: D1AuditOutboxRepositoryOptions = {},
  ) {
    this.requestId = validateRequestId(options.requestId);
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  statement(entry: AuditLogEntry): D1PreparedStatement {
    validateEntry(entry);
    const id = identifier(this.idGenerator(), 'event id');
    return this.db
      .prepare(
        `INSERT INTO audit_outbox
         (id, actor_type, actor_id, action, resource_type, resource_id,
          request_id, metadata, status, attempt_count, available_at,
          lease_token, lease_expires_at, delivered_at, last_error_code,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?,
                 NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .bind(
        id,
        entry.actorType,
        entry.actorId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        this.requestId,
        encodeMetadata(entry),
        entry.createdAt,
        entry.createdAt,
        entry.createdAt,
      );
  }

  assertPreviousChanges(): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO audit_outbox_assertions (ok)
       VALUES (changes())`,
    );
  }

  async record(entry: AuditLogEntry): Promise<void> {
    await this.statement(entry).run();
  }

  async claim(
    input: ClaimAuditOutboxInput,
  ): Promise<AuditOutboxClaim | undefined> {
    const leaseToken = identifier(input.leaseToken, 'lease token');
    const claimedAt = canonicalTimestamp(input.claimedAt, 'claimed at');
    const leaseExpiresAt = canonicalTimestamp(
      input.leaseExpiresAt,
      'lease expires at',
    );
    if (Date.parse(leaseExpiresAt) <= Date.parse(claimedAt)) {
      throw new TypeError('Invalid audit outbox lease');
    }

    const row = await this.db
      .prepare(
        `UPDATE audit_outbox
         SET status = 'PROCESSING', lease_token = ?, lease_expires_at = ?,
             attempt_count = attempt_count + 1, updated_at = ?
         WHERE id = (
           SELECT id
           FROM audit_outbox
           WHERE (status = 'PENDING' AND available_at <= ?)
              OR (status = 'PROCESSING' AND lease_expires_at <= ?)
           ORDER BY available_at ASC, created_at ASC, id ASC
           LIMIT 1
         )
         AND ((status = 'PENDING' AND available_at <= ?)
           OR (status = 'PROCESSING' AND lease_expires_at <= ?))
         RETURNING id, attempt_count`,
      )
      .bind(
        leaseToken,
        leaseExpiresAt,
        claimedAt,
        claimedAt,
        claimedAt,
        claimedAt,
        claimedAt,
      )
      .first<ClaimRow>();
    return row === null
      ? undefined
      : {
          id: stringRow(row.id, 'id'),
          attemptCount: attemptCount(row.attempt_count),
        };
  }

  async deliver(
    id: string,
    leaseToken: string,
    deliveredAt: string,
  ): Promise<DeliverAuditOutboxResult> {
    identifier(id, 'id');
    identifier(leaseToken, 'lease token');
    canonicalTimestamp(deliveredAt, 'delivered at');

    const current = await this.db
      .prepare('SELECT status FROM audit_outbox WHERE id = ? LIMIT 1')
      .bind(id)
      .first<StatusRow>();
    if (current?.status === 'DELIVERED') return 'ALREADY_DELIVERED';

    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO audit_logs
             (id, event_id, actor_type, actor_id, action, resource_type,
              resource_id, request_id, metadata, created_at)
             SELECT id, id, actor_type, actor_id, action, resource_type,
                    resource_id, request_id, metadata, created_at
             FROM audit_outbox
             WHERE id = ? AND status = 'PROCESSING' AND lease_token = ?
               AND lease_expires_at > ?`,
          )
          .bind(id, leaseToken, deliveredAt),
        this.assertPreviousChanges(),
        this.db
          .prepare(
            `UPDATE audit_outbox
             SET status = 'DELIVERED', lease_token = NULL,
                 lease_expires_at = NULL, delivered_at = ?,
                 last_error_code = NULL, updated_at = ?
             WHERE id = ? AND status = 'PROCESSING' AND lease_token = ?
               AND lease_expires_at > ?`,
          )
          .bind(deliveredAt, deliveredAt, id, leaseToken, deliveredAt),
        this.assertPreviousChanges(),
      ]);
      return 'DELIVERED';
    } catch (error) {
      const row = await this.db
        .prepare('SELECT status FROM audit_outbox WHERE id = ? LIMIT 1')
        .bind(id)
        .first<StatusRow>();
      if (row?.status === 'DELIVERED') return 'ALREADY_DELIVERED';
      if (
        error instanceof Error &&
        (error.message.includes('openpool_audit_outbox_conflict') ||
          error.message.toLowerCase().includes('unique'))
      ) {
        return 'CONFLICT';
      }
      throw error;
    }
  }

  async retry(
    id: string,
    leaseToken: string,
    availableAt: string,
    errorCode: string,
    updatedAt: string,
  ): Promise<boolean> {
    identifier(id, 'id');
    identifier(leaseToken, 'lease token');
    canonicalTimestamp(availableAt, 'available at');
    identifier(errorCode, 'error code');
    canonicalTimestamp(updatedAt, 'updated at');
    if (Date.parse(availableAt) < Date.parse(updatedAt)) {
      throw new TypeError('Invalid audit outbox retry time');
    }
    const result = await this.db
      .prepare(
        `UPDATE audit_outbox
         SET status = 'PENDING', lease_token = NULL, lease_expires_at = NULL,
             available_at = ?, last_error_code = ?, updated_at = ?
         WHERE id = ? AND status = 'PROCESSING' AND lease_token = ?`,
      )
      .bind(availableAt, errorCode, updatedAt, id, leaseToken)
      .run();
    return result.meta.changes === 1;
  }
}
