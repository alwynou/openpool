export type AuditActorType = 'ADMIN' | 'API_KEY' | 'SYSTEM';

export interface AuditLogRecord {
  readonly id: string;
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly requestId: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export interface AuditLogCursor {
  readonly afterCreatedAt: string;
  readonly afterId: string;
}

interface AuditLogQueryFilters {
  readonly limit: number;
  readonly actorType?: AuditActorType;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
}

export type AuditLogQuery = AuditLogQueryFilters &
  (
    | AuditLogCursor
    | {
        readonly afterCreatedAt?: never;
        readonly afterId?: never;
      }
  );

export interface AuditLogPage {
  readonly items: readonly AuditLogRecord[];
  readonly nextCursor: AuditLogCursor | null;
}

/** Read-only audit query port. Mutating use cases continue to use AuditLog. */
export interface AuditQueryRepository {
  list(query: AuditLogQuery): Promise<AuditLogPage>;
}
