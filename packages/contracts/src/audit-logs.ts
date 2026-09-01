export type AuditActorType = 'ADMIN' | 'API_KEY' | 'SYSTEM';

export interface AuditLogResponse {
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

export interface ListAuditLogsQuery extends Partial<AuditLogCursor> {
  readonly limit?: number;
  readonly actorType?: AuditActorType;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
}

export interface ListAuditLogsResponse {
  readonly items: readonly AuditLogResponse[];
  readonly nextCursor: AuditLogCursor | null;
}

export type AuditLogErrorCode = 'AUDIT_QUERY_INVALID' | 'UNAUTHORIZED';
