import {
  AuthenticateSession,
  type AuthClock,
  type AuthIdGenerator,
  GetSetupStatus,
  InitializeAdministrator,
  Login,
  Logout,
  type PasswordHasher,
  type TokenGenerator,
  type TokenHasher,
} from '@openpool/application';

import {
  EnvironmentBootstrapAuthorizer,
  WebCryptoPasswordHasher,
  WebCryptoSessionTokenGenerator,
  WebCryptoTokenHasher,
} from '../adapters/auth';
import { D1AuthRepository } from '../adapters/d1';
import { createHttpApp } from '../adapters/http/app';
import type { AuthUseCases } from '../adapters/http/auth-routes';
import type { Env } from '../env';

export interface WorkerCompositionOverrides {
  readonly passwordHasher?: PasswordHasher;
  readonly tokenGenerator?: TokenGenerator;
  readonly tokenHasher?: TokenHasher;
  readonly idGenerator?: AuthIdGenerator;
  readonly clock?: AuthClock;
}

const defaultIdGenerator: AuthIdGenerator = {
  next: () => crypto.randomUUID(),
};

const defaultClock: AuthClock = {
  now: () => new Date(),
};

/** The only composition root. Platform adapters enter application use cases here. */
export function createWorker(overrides: WorkerCompositionOverrides = {}) {
  const passwords = overrides.passwordHasher ?? new WebCryptoPasswordHasher();
  const tokens =
    overrides.tokenGenerator ?? new WebCryptoSessionTokenGenerator();
  const tokenHashes = overrides.tokenHasher ?? new WebCryptoTokenHasher();
  const ids = overrides.idGenerator ?? defaultIdGenerator;
  const clock = overrides.clock ?? defaultClock;

  const createAuthUseCases = (
    env: Env,
    requestId: string,
  ): AuthUseCases => {
    const repository = new D1AuthRepository(env.DB, {
      requestId,
      auditIdGenerator: () => ids.next(),
    });
    const common = {
      administrators: repository,
      sessions: repository,
      passwords,
      tokens,
      tokenHashes,
      ids,
      clock,
      audit: repository,
    };

    return {
      getSetupStatus: new GetSetupStatus(repository),
      initializeAdministrator: new InitializeAdministrator({
        administrators: repository,
        bootstrap: new EnvironmentBootstrapAuthorizer(
          env.ADMIN_BOOTSTRAP_TOKEN,
        ),
        passwords,
        ids,
        clock,
        audit: repository,
      }),
      login: new Login(common),
      authenticateSession: new AuthenticateSession(common),
      logout: new Logout(common),
    };
  };

  return createHttpApp({ createAuthUseCases });
}
