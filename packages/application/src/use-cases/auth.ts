import type { Administrator, AuthSession } from '@openpool/domain';

import type {
  AdministratorRepository,
  AuthClock,
  AuthIdGenerator,
  AuthSessionRepository,
  BootstrapAuthorizer,
  PasswordHasher,
  TokenGenerator,
  TokenHasher,
} from '../ports/auth';

export type AuthErrorCode =
  | 'ADMINISTRATOR_ALREADY_INITIALIZED'
  | 'AUTHENTICATION_FAILED'
  | 'BOOTSTRAP_UNAUTHORIZED'
  | 'VALIDATION_FAILED'
  | 'SESSION_INVALID';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 8;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 64;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;

function alreadyInitialized(): AuthError {
  return new AuthError(
    'ADMINISTRATOR_ALREADY_INITIALIZED',
    'Administrator has already been initialized',
  );
}

function authenticationFailed(): AuthError {
  return new AuthError(
    'AUTHENTICATION_FAILED',
    'Invalid username or password',
  );
}

function bootstrapUnauthorized(): AuthError {
  return new AuthError(
    'BOOTSTRAP_UNAUTHORIZED',
    'Administrator bootstrap is not authorized',
  );
}

function validationFailed(): AuthError {
  return new AuthError(
    'VALIDATION_FAILED',
    'Username or password does not meet the required format',
  );
}

function sessionInvalid(): AuthError {
  return new AuthError('SESSION_INVALID', 'Session is invalid or expired');
}

function normalizeUsername(username: string): string {
  return username.trim();
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function validateInitialCredentials(username: string, password: string): void {
  if (
    username.length < USERNAME_MIN_LENGTH ||
    username.length > USERNAME_MAX_LENGTH ||
    containsControlCharacter(username) ||
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    throw validationFailed();
  }
}

export interface InitializeAdministratorCommand {
  readonly username: string;
  readonly password: string;
  readonly bootstrapToken: string;
}

export interface InitializeAdministratorDependencies {
  readonly administrators: AdministratorRepository;
  readonly bootstrap: BootstrapAuthorizer;
  readonly passwords: PasswordHasher;
  readonly ids: AuthIdGenerator;
  readonly clock: AuthClock;
}

export interface InitializeAdministratorResult {
  readonly administrator: Administrator;
}

export class InitializeAdministrator {
  constructor(
    private readonly dependencies: InitializeAdministratorDependencies,
  ) {}

  async execute(
    command: InitializeAdministratorCommand,
  ): Promise<InitializeAdministratorResult> {
    if (await this.dependencies.administrators.isInitialized()) {
      throw alreadyInitialized();
    }

    if (!(await this.dependencies.bootstrap.verify(command.bootstrapToken))) {
      throw bootstrapUnauthorized();
    }

    const username = normalizeUsername(command.username);
    validateInitialCredentials(username, command.password);

    const now = this.dependencies.clock.now().toISOString();
    const administrator: Administrator = {
      id: this.dependencies.ids.next(),
      username,
      passwordHash: await this.dependencies.passwords.hash(command.password),
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };

    if (
      !(await this.dependencies.administrators.createIfAbsent(administrator, {
        actorType: 'ADMIN',
        actorId: administrator.id,
        action: 'ADMINISTRATOR_INITIALIZED',
        resourceType: 'ADMINISTRATOR',
        resourceId: administrator.id,
        createdAt: now,
      }))
    ) {
      throw alreadyInitialized();
    }

    return { administrator };
  }
}

export interface SetupStatus {
  readonly initialized: boolean;
}

export class GetSetupStatus {
  constructor(
    private readonly administrators: Pick<
      AdministratorRepository,
      'isInitialized'
    >,
  ) {}

  async execute(): Promise<SetupStatus> {
    return { initialized: await this.administrators.isInitialized() };
  }
}

export interface LoginCommand {
  readonly username: string;
  readonly password: string;
  readonly sessionTtlSeconds?: number;
}

export interface LoginDependencies {
  readonly administrators: AdministratorRepository;
  readonly sessions: AuthSessionRepository;
  readonly passwords: PasswordHasher;
  readonly tokens: TokenGenerator;
  readonly tokenHashes: TokenHasher;
  readonly ids: AuthIdGenerator;
  readonly clock: AuthClock;
}

export interface LoginResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly administrator: Administrator;
}

export class Login {
  constructor(private readonly dependencies: LoginDependencies) {}

  async execute(command: LoginCommand): Promise<LoginResult> {
    const username = normalizeUsername(command.username);
    const administrator =
      await this.dependencies.administrators.findByUsername(username);

    if (!administrator || administrator.status !== 'ACTIVE') {
      await this.dependencies.passwords.verifyDummy?.(command.password);
      throw authenticationFailed();
    }

    if (
      !(await this.dependencies.passwords.verify(
        command.password,
        administrator.passwordHash,
      ))
    ) {
      throw authenticationFailed();
    }

    const sessionTtlSeconds =
      command.sessionTtlSeconds ?? ADMIN_SESSION_TTL_SECONDS;
    if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
      throw new RangeError(
        'sessionTtlSeconds must be a positive safe integer',
      );
    }

    const now = this.dependencies.clock.now();
    const token = this.dependencies.tokens.generate();
    const session: AuthSession = {
      id: this.dependencies.ids.next(),
      administratorId: administrator.id,
      tokenHash: await this.dependencies.tokenHashes.hash(token),
      expiresAt: new Date(
        now.getTime() + sessionTtlSeconds * 1000,
      ).toISOString(),
      createdAt: now.toISOString(),
    };

    await this.dependencies.sessions.create(session, {
      actorType: 'ADMIN',
      actorId: administrator.id,
      action: 'LOGIN',
      resourceType: 'AUTH_SESSION',
      resourceId: session.id,
      createdAt: now.toISOString(),
    });

    return {
      token,
      expiresAt: session.expiresAt,
      administrator,
    };
  }
}

export interface AuthenticateSessionDependencies {
  readonly sessions: AuthSessionRepository;
  readonly administrators: AdministratorRepository;
  readonly tokenHashes: TokenHasher;
  readonly clock: AuthClock;
}

export interface AuthenticatedSession {
  readonly administrator: Administrator;
  readonly expiresAt: string;
}

export class AuthenticateSession {
  constructor(
    private readonly dependencies: AuthenticateSessionDependencies,
  ) {}

  async execute(token: string): Promise<AuthenticatedSession> {
    const tokenHash = await this.dependencies.tokenHashes.hash(token);
    const session =
      await this.dependencies.sessions.findByTokenHash(tokenHash);
    const expiresAt = session ? Date.parse(session.expiresAt) : Number.NaN;

    if (
      !session ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.dependencies.clock.now().getTime()
    ) {
      throw sessionInvalid();
    }

    const administrator = await this.dependencies.administrators.findById(
      session.administratorId,
    );
    if (!administrator || administrator.status !== 'ACTIVE') {
      throw sessionInvalid();
    }

    return { administrator, expiresAt: session.expiresAt };
  }
}

export interface LogoutDependencies {
  readonly sessions: AuthSessionRepository;
  readonly tokenHashes: TokenHasher;
  readonly clock: AuthClock;
}

export class Logout {
  constructor(private readonly dependencies: LogoutDependencies) {}

  async execute(token: string): Promise<void> {
    const tokenHash = await this.dependencies.tokenHashes.hash(token);
    const session =
      await this.dependencies.sessions.findByTokenHash(tokenHash);

    if (session) {
      await this.dependencies.sessions.revokeByTokenHash(tokenHash, {
        actorType: 'ADMIN',
        actorId: session.administratorId,
        action: 'LOGOUT',
        resourceType: 'AUTH_SESSION',
        resourceId: session.id,
        createdAt: this.dependencies.clock.now().toISOString(),
      });
    }
  }
}
