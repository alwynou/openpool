import type {
  AuditActorType,
  AuditLogPage,
  AuditLogQuery,
  AuditQueryRepository,
} from '../ports/audit-query';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const ACTOR_TYPES = new Set<AuditActorType>([
  'ADMIN',
  'API_KEY',
  'SYSTEM',
]);

export interface ListAuditLogsQuery {
  readonly limit?: number;
  readonly actorType?: AuditActorType;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly afterCreatedAt?: string;
  readonly afterId?: string;
}

export class AuditQueryApplicationError extends Error {
  readonly code = 'AUDIT_QUERY_INVALID_INPUT' as const;

  constructor() {
    super('Audit log query is invalid');
    this.name = 'AuditQueryApplicationError';
  }
}

function invalidQuery(): never {
  throw new AuditQueryApplicationError();
}

function isValidFilter(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  );
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function validateQuery(input: ListAuditLogsQuery): AuditLogQuery {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    invalidQuery();
  }

  if (
    input.actorType !== undefined &&
    !ACTOR_TYPES.has(input.actorType)
  ) {
    invalidQuery();
  }

  for (const value of [input.action, input.resourceType, input.resourceId]) {
    if (value !== undefined && !isValidFilter(value)) invalidQuery();
  }

  const hasCreatedAt = input.afterCreatedAt !== undefined;
  const hasId = input.afterId !== undefined;
  if (hasCreatedAt !== hasId) invalidQuery();
  if (
    input.afterCreatedAt !== undefined &&
    (!isCanonicalTimestamp(input.afterCreatedAt) ||
      input.afterId === undefined ||
      !isValidFilter(input.afterId))
  ) {
    invalidQuery();
  }

  return {
    limit,
    ...(input.actorType === undefined ? {} : { actorType: input.actorType }),
    ...(input.action === undefined ? {} : { action: input.action }),
    ...(input.resourceType === undefined
      ? {}
      : { resourceType: input.resourceType }),
    ...(input.resourceId === undefined
      ? {}
      : { resourceId: input.resourceId }),
    ...(input.afterCreatedAt === undefined
      ? {}
      : {
          afterCreatedAt: input.afterCreatedAt,
          afterId: input.afterId,
        }),
  };
}

export class ListAuditLogs {
  constructor(private readonly repository: AuditQueryRepository) {}

  async execute(query: ListAuditLogsQuery = {}): Promise<AuditLogPage> {
    return this.repository.list(validateQuery(query));
  }
}
