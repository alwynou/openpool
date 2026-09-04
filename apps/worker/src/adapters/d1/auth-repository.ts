import type {
  AdministratorRepository,
  AuditLog,
  AuditLogEntry,
  AuthSessionRepository,
} from '@openpool/application';
import type { Administrator, AuthSession } from '@openpool/domain';
import type { D1AuditOutboxRepository } from './audit-outbox-repository';

interface AdministratorRow {
  readonly id: string;
  readonly username: string;
  readonly password_hash: string;
  readonly status: Administrator['status'];
  readonly created_at: string;
  readonly updated_at: string;
}

interface SessionRow {
  readonly id: string;
  readonly administrator_id: string;
  readonly token_hash: string;
  readonly expires_at: string;
  readonly created_at: string;
}

export interface D1AuthRepositoryOptions {
  readonly requestId?: string;
  readonly auditIdGenerator?: () => string;
  readonly auditOutbox?: Pick<
    D1AuditOutboxRepository,
    'statement' | 'assertPreviousChanges'
  >;
}

function mapAdministrator(row: AdministratorRow): Administrator {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSession(row: SessionRow): AuthSession {
  return {
    id: row.id,
    administratorId: row.administrator_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/** Outbound D1 implementation of the authentication application ports. */
export class D1AuthRepository
  implements AdministratorRepository, AuthSessionRepository, AuditLog
{
  private readonly requestId: string | null;
  private readonly auditIdGenerator: () => string;
  private readonly auditOutbox:
    | Pick<
        D1AuditOutboxRepository,
        'statement' | 'assertPreviousChanges'
      >
    | undefined;

  constructor(
    private readonly db: D1Database,
    options: D1AuthRepositoryOptions = {},
  ) {
    this.requestId = options.requestId ?? null;
    this.auditIdGenerator =
      options.auditIdGenerator ?? (() => crypto.randomUUID());
    this.auditOutbox = options.auditOutbox;
  }

  private transactionalAuditOutbox(): Pick<
    D1AuditOutboxRepository,
    'statement' | 'assertPreviousChanges'
  > {
    if (!this.auditOutbox) {
      throw new Error('Authentication mutation requires an audit outbox');
    }
    return this.auditOutbox;
  }

  async createIfAbsent(
    administrator: Administrator,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    const outbox = this.transactionalAuditOutbox();
    const insert = this.db.prepare(
        `INSERT INTO administrators
         (id, username, password_hash, status, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM administrators)`,
      )
      .bind(
        administrator.id,
        administrator.username,
        administrator.passwordHash,
        administrator.status,
        administrator.createdAt,
        administrator.updatedAt,
      );
    try {
      const results = await this.db.batch([
        insert,
        outbox.assertPreviousChanges(),
        outbox.statement(audit),
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

  async isInitialized(): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS present FROM administrators LIMIT 1')
      .first<{ present: number }>();
    return row !== null;
  }

  async findByUsername(
    username: string,
  ): Promise<Administrator | undefined> {
    const row = await this.db
      .prepare(
        `SELECT id, username, password_hash, status, created_at, updated_at
         FROM administrators
         WHERE username = ?
         LIMIT 1`,
      )
      .bind(username)
      .first<AdministratorRow>();
    return row ? mapAdministrator(row) : undefined;
  }

  async findById(id: string): Promise<Administrator | undefined> {
    const row = await this.db
      .prepare(
        `SELECT id, username, password_hash, status, created_at, updated_at
         FROM administrators
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(id)
      .first<AdministratorRow>();
    return row ? mapAdministrator(row) : undefined;
  }

  async create(session: AuthSession, audit: AuditLogEntry): Promise<void> {
    const outbox = this.transactionalAuditOutbox();
    const insert = this.db.prepare(
        `INSERT INTO auth_sessions
         (id, administrator_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        session.id,
        session.administratorId,
        session.tokenHash,
        session.expiresAt,
        session.createdAt,
      );
    await this.db.batch([insert, outbox.statement(audit)]);
  }

  async findByTokenHash(tokenHash: string): Promise<AuthSession | undefined> {
    const row = await this.db
      .prepare(
        `SELECT id, administrator_id, token_hash, expires_at, created_at
         FROM auth_sessions
         WHERE token_hash = ?
         LIMIT 1`,
      )
      .bind(tokenHash)
      .first<SessionRow>();
    return row ? mapSession(row) : undefined;
  }

  async revokeByTokenHash(
    tokenHash: string,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    const outbox = this.transactionalAuditOutbox();
    const remove = this.db
      .prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
      .bind(tokenHash);
    try {
      const results = await this.db.batch([
        remove,
        outbox.assertPreviousChanges(),
        outbox.statement(audit),
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

  async record(entry: AuditLogEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO audit_logs
         (id, actor_type, actor_id, action, resource_type, resource_id,
          request_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        this.auditIdGenerator(),
        entry.actorType,
        entry.actorId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        this.requestId,
        JSON.stringify(entry.metadata ?? {}),
        entry.createdAt,
      )
      .run();
  }
}
