import type {
  AuditActorType,
  AuditLogPage,
  AuditLogQuery,
  AuditLogRecord,
  AuditQueryRepository,
} from '@openpool/application';

interface AuditLogRow {
  readonly id: unknown;
  readonly actor_type: unknown;
  readonly actor_id: unknown;
  readonly action: unknown;
  readonly resource_type: unknown;
  readonly resource_id: unknown;
  readonly request_id: unknown;
  readonly metadata: unknown;
  readonly created_at: unknown;
}

const ACTOR_TYPES = new Set<AuditActorType>([
  'ADMIN',
  'API_KEY',
  'SYSTEM',
]);

export class D1AuditQueryDataError extends Error {
  constructor() {
    super('D1 returned an invalid audit log row');
    this.name = 'D1AuditQueryDataError';
  }
}

function dataError(): never {
  throw new D1AuditQueryDataError();
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) dataError();
  return value;
}

function canonicalTimestamp(value: unknown): string {
  const encoded = requiredString(value);
  const timestamp = Date.parse(encoded);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== encoded) {
    dataError();
  }
  return encoded;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function actorType(value: unknown): AuditActorType {
  if (typeof value !== 'string' || !ACTOR_TYPES.has(value as AuditActorType)) {
    dataError();
  }
  return value as AuditActorType;
}

function metadata(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'string') dataError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    dataError();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype ||
    Object.values(parsed).some((entry) => typeof entry !== 'string')
  ) {
    dataError();
  }
  return { ...(parsed as Record<string, string>) };
}

function auditLog(row: AuditLogRow): AuditLogRecord {
  return {
    id: requiredString(row.id),
    actorType: actorType(row.actor_type),
    actorId: nullableString(row.actor_id),
    action: requiredString(row.action),
    resourceType: requiredString(row.resource_type),
    resourceId: nullableString(row.resource_id),
    requestId: nullableString(row.request_id),
    metadata: metadata(row.metadata),
    createdAt: canonicalTimestamp(row.created_at),
  };
}

export class D1AuditQueryRepository implements AuditQueryRepository {
  constructor(private readonly db: D1Database) {}

  async list(query: AuditLogQuery): Promise<AuditLogPage> {
    const conditions: string[] = [];
    const bindings: Array<string | number> = [];

    if (query.actorType !== undefined) {
      conditions.push('actor_type = ?');
      bindings.push(query.actorType);
    }
    if (query.action !== undefined) {
      conditions.push('action = ?');
      bindings.push(query.action);
    }
    if (query.resourceType !== undefined) {
      conditions.push('resource_type = ?');
      bindings.push(query.resourceType);
    }
    if (query.resourceId !== undefined) {
      conditions.push('resource_id = ?');
      bindings.push(query.resourceId);
    }
    if (query.afterCreatedAt !== undefined && query.afterId !== undefined) {
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
      bindings.push(query.afterCreatedAt, query.afterCreatedAt, query.afterId);
    }

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const result = await this.db
      .prepare(
        `SELECT id, actor_type, actor_id, action, resource_type, resource_id,
                request_id, metadata, created_at
         FROM (
           SELECT id, actor_type, actor_id, action, resource_type, resource_id,
                  request_id, metadata, created_at
           FROM audit_logs
           UNION ALL
           SELECT id, actor_type, actor_id, action, resource_type, resource_id,
                  request_id, metadata, created_at
           FROM audit_outbox
           WHERE status <> 'DELIVERED'
             AND NOT EXISTS (
               SELECT 1
               FROM audit_logs
               WHERE audit_logs.event_id = audit_outbox.id
             )
         ) AS visible_audit_events
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...bindings, query.limit + 1)
      .all<AuditLogRow>();
    const records = result.results.map(auditLog);
    const items = records.slice(0, query.limit);
    const lastItem = items.at(-1);

    return {
      items,
      nextCursor:
        records.length > query.limit && lastItem
          ? { afterCreatedAt: lastItem.createdAt, afterId: lastItem.id }
          : null,
    };
  }
}
