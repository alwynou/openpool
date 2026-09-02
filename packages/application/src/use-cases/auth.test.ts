import type { Administrator, AuthSession } from '@openpool/domain';
import { describe, expect, it } from 'vitest';

import type {
  AdministratorRepository,
  AuditLog,
  AuditLogEntry,
  AuthClock,
  AuthSessionRepository,
  PasswordHasher,
  TokenHasher,
} from '../ports/auth';
import {
  AuthenticateSession,
  type AuthError,
  GetSetupStatus,
  InitializeAdministrator,
  Login,
  Logout,
} from './auth';

class FakeClock implements AuthClock {
  constructor(public date = new Date('2026-01-01T00:00:00.000Z')) {}

  now(): Date {
    return new Date(this.date);
  }
}

class FakePasswords implements PasswordHasher {
  dummyVerifications = 0;

  async hash(value: string): Promise<string> {
    return `hash:${value}`;
  }

  async verify(value: string, hash: string): Promise<boolean> {
    return `hash:${value}` === hash;
  }

  async verifyDummy(): Promise<boolean> {
    this.dummyVerifications += 1;
    return false;
  }
}

class FakeTokenHashes implements TokenHasher {
  async hash(value: string): Promise<string> {
    return `token:${value}`;
  }
}

class FakeAdministratorRepository implements AdministratorRepository {
  administrator?: Administrator;
  audit?: FakeAudit;

  async isInitialized(): Promise<boolean> {
    return this.administrator !== undefined;
  }

  async createIfAbsent(
    value: Administrator,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    if (this.administrator) return false;
    this.administrator = value;
    await this.audit?.record(audit);
    return true;
  }

  async findByUsername(username: string): Promise<Administrator | undefined> {
    return this.administrator?.username === username
      ? this.administrator
      : undefined;
  }

  async findById(id: string): Promise<Administrator | undefined> {
    return this.administrator?.id === id
      ? this.administrator
      : undefined;
  }
}

class FakeSessions implements AuthSessionRepository {
  readonly sessions = new Map<string, AuthSession>();
  audit?: FakeAudit;

  async create(value: AuthSession, audit: AuditLogEntry): Promise<void> {
    this.sessions.set(value.tokenHash, value);
    await this.audit?.record(audit);
  }

  async findByTokenHash(hash: string): Promise<AuthSession | undefined> {
    return this.sessions.get(hash);
  }

  async revokeByTokenHash(
    hash: string,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    const changed = this.sessions.delete(hash);
    if (changed) await this.audit?.record(audit);
    return changed;
  }
}

class FakeAudit implements AuditLog {
  readonly actions: string[] = [];

  async record(entry: { action: string }): Promise<void> {
    this.actions.push(entry.action);
  }
}

function ids(prefix: string) {
  let counter = 0;
  return { next: () => `${prefix}-${++counter}` };
}

const validCredentials = {
  username: 'administrator',
  password: 'correct horse battery staple',
  bootstrapToken: 'valid-bootstrap-token',
};

const bootstrap = {
  verify: async (token: string) => token === validCredentials.bootstrapToken,
};

describe('authentication use cases', () => {
  it('validates initial administrator credentials', async () => {
    const dependencies = {
      administrators: new FakeAdministratorRepository(),
      bootstrap,
      passwords: new FakePasswords(),
      ids: ids('admin'),
      clock: new FakeClock(),
    };

    await expect(
      new InitializeAdministrator(dependencies).execute({
        username: 'ab',
        password: 'too short',
        bootstrapToken: validCredentials.bootstrapToken,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('initializes only once using create-first semantics', async () => {
    const administrators = new FakeAdministratorRepository();
    const setupStatus = new GetSetupStatus(administrators);
    expect(await setupStatus.execute()).toEqual({ initialized: false });

    const audit = new FakeAudit();
    administrators.audit = audit;
    const initialize = new InitializeAdministrator({
      administrators,
      bootstrap,
      passwords: new FakePasswords(),
      ids: ids('admin'),
      clock: new FakeClock(),
    });
    const result = await initialize.execute({
      ...validCredentials,
      username: ` ${validCredentials.username} `,
    });

    expect(result.administrator.id).toBe('admin-1');
    expect(result.administrator.username).toBe(validCredentials.username);
    expect(await setupStatus.execute()).toEqual({ initialized: true });
    await expect(initialize.execute(validCredentials)).rejects.toMatchObject({
      code: 'ADMINISTRATOR_ALREADY_INITIALIZED',
    });
    expect(audit.actions).toEqual(['ADMINISTRATOR_INITIALIZED']);
  });

  it('does not reveal whether a username exists or a password is wrong', async () => {
    const administrators = new FakeAdministratorRepository();
    const clock = new FakeClock();
    const passwords = new FakePasswords();
    await new InitializeAdministrator({
      administrators,
      bootstrap,
      passwords,
      ids: ids('admin'),
      clock,
    }).execute(validCredentials);

    const login = new Login({
      administrators,
      sessions: new FakeSessions(),
      passwords,
      tokens: { generate: () => 'raw-token' },
      tokenHashes: new FakeTokenHashes(),
      ids: ids('session'),
      clock,
    });
    const rejected = async (username: string): Promise<AuthError> => {
      try {
        await login.execute({ username, password: 'wrong password' });
      } catch (error) {
        return error as AuthError;
      }
      throw new Error('Expected login to fail');
    };

    const wrong = await rejected(validCredentials.username);
    const absent = await rejected('nobody');
    expect(wrong.code).toBe('AUTHENTICATION_FAILED');
    expect(absent.code).toBe(wrong.code);
    expect(absent.message).toBe(wrong.message);
    expect(passwords.dummyVerifications).toBe(1);
  });

  it('authenticates active sessions, rejects expiry, and logs out idempotently', async () => {
    const administrators = new FakeAdministratorRepository();
    const clock = new FakeClock();
    const audit = new FakeAudit();
    const sessions = new FakeSessions();
    administrators.audit = audit;
    sessions.audit = audit;
    const passwords = new FakePasswords();
    const tokenHashes = new FakeTokenHashes();

    await new InitializeAdministrator({
      administrators,
      bootstrap,
      passwords,
      ids: ids('admin'),
      clock,
    }).execute(validCredentials);

    const login = await new Login({
      administrators,
      sessions,
      passwords,
      tokens: { generate: () => 'raw-token' },
      tokenHashes,
      ids: ids('session'),
      clock,
    }).execute({
      username: validCredentials.username,
      password: validCredentials.password,
      sessionTtlSeconds: 1,
    });

    const authenticate = new AuthenticateSession({
      sessions,
      administrators,
      tokenHashes,
      clock,
    });
    expect((await authenticate.execute(login.token)).administrator.id).toBe(
      'admin-1',
    );

    clock.date = new Date('2026-01-01T00:00:01.000Z');
    await expect(authenticate.execute(login.token)).rejects.toMatchObject({
      code: 'SESSION_INVALID',
    });

    const logout = new Logout({ sessions, tokenHashes, clock });
    await logout.execute(login.token);
    await expect(logout.execute(login.token)).resolves.toBeUndefined();
    expect(audit.actions).toEqual([
      'ADMINISTRATOR_INITIALIZED',
      'LOGIN',
      'LOGOUT',
    ]);
  });
});
