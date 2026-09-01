import type { Administrator, AuthSession } from '@openpool/domain';

export interface AdministratorRepository {
  /** Must be implemented as one atomic insert-if-empty operation. */
  createIfAbsent(administrator: Administrator): Promise<boolean>;
  isInitialized(): Promise<boolean>;
  findByUsername(username: string): Promise<Administrator | undefined>;
  findById(id: string): Promise<Administrator | undefined>;
}

export interface AuthSessionRepository {
  create(session: AuthSession): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<AuthSession | undefined>;
  revokeByTokenHash(tokenHash: string): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, passwordHash: string): Promise<boolean>;
  /** Optional constant-cost verification against an adapter-managed dummy hash. */
  verifyDummy?(password: string): Promise<boolean>;
}

export interface BootstrapAuthorizer {
  verify(token: string): Promise<boolean>;
}

export interface TokenGenerator {
  generate(): string;
}

export interface TokenHasher {
  hash(token: string): Promise<string>;
}

export interface AuditLogEntry {
  readonly actorType: 'ADMIN' | 'SYSTEM';
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly createdAt: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface AuditLog {
  record(entry: AuditLogEntry): Promise<void>;
}

export interface AuthClock {
  now(): Date;
}

export interface AuthIdGenerator {
  next(): string;
}
