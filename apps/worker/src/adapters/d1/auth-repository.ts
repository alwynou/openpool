import type {
  AdministratorRepository,
  AuditLog,
  AuditLogEntry,
  AuthSessionRepository,
} from '@openpool/application';
import type { Administrator, AuthSession } from '@openpool/domain';

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

  constructor(
    private readonly db: D1Database,
    options: D1AuthRepositoryOptions = {},
  ) {
    this.requestId = options.requestId ?? null;
    this.auditIdGenerator =
      options.auditIdGenerator ?? (() => crypto.randomUUID());
  }

  async createIfAbsent(administrator: Administrator): Promise<boolean> {
    const result = await this.db
      .prepare(
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
      )
      .run();
    return result.meta.changes === 1;
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

  async create(session: AuthSession): Promise<void> {
    await this.db
      .prepare(
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
      )
      .run();
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

  async revokeByTokenHash(tokenHash: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .run();
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
