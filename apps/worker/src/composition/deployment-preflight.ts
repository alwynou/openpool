import type { DeploymentReadinessIssueCode } from '@openpool/contracts';

import { D1AuthRepository } from '../adapters/d1';
import type { Env } from '../env';

const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CANONICAL_32_BYTE_BASE64 = /^[A-Za-z0-9+/]{43}=$/u;
const MIN_BOOTSTRAP_TOKEN_BYTES = 32;
const MAX_BOOTSTRAP_TOKEN_BYTES = 512;

function isCanonical32ByteBase64(value: string): boolean {
  if (!CANONICAL_32_BYTE_BASE64.test(value)) return false;
  try {
    const decoded = atob(value);
    return decoded.length === 32 && btoa(decoded) === value;
  } catch {
    return false;
  }
}

function validBootstrapToken(value: string): boolean {
  const bytes = new TextEncoder().encode(value);
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  return (
    value.trim() === value &&
    bytes.byteLength >= MIN_BOOTSTRAP_TOKEN_BYTES &&
    bytes.byteLength <= MAX_BOOTSTRAP_TOKEN_BYTES &&
    !hasControlCharacter
  );
}

function hasRateLimiter(value: RateLimit | undefined): value is RateLimit {
  return value !== undefined && typeof value.limit === 'function';
}

/** Checks values that do not require a D1 read and can gate every API request. */
export function inspectStaticDeploymentConfiguration(
  env: Env,
): readonly DeploymentReadinessIssueCode[] {
  const issues: DeploymentReadinessIssueCode[] = [];
  const masterKey = env.CREDENTIAL_MASTER_KEY;
  const pepper = env.API_KEY_PEPPER;

  if (!masterKey) issues.push('CREDENTIAL_MASTER_KEY_MISSING');
  else if (!isCanonical32ByteBase64(masterKey)) {
    issues.push('CREDENTIAL_MASTER_KEY_INVALID');
  }

  if (!SAFE_KEY_ID.test(env.CREDENTIAL_MASTER_KEY_ID ?? 'primary-v1')) {
    issues.push('CREDENTIAL_MASTER_KEY_ID_INVALID');
  }

  if (!pepper) issues.push('API_KEY_PEPPER_MISSING');
  else if (!isCanonical32ByteBase64(pepper)) {
    issues.push('API_KEY_PEPPER_INVALID');
  }

  if (
    masterKey !== undefined &&
    pepper !== undefined &&
    isCanonical32ByteBase64(masterKey) &&
    isCanonical32ByteBase64(pepper) &&
    masterKey === pepper
  ) {
    issues.push('CRYPTO_SECRET_REUSE_DETECTED');
  }

  if (
    !hasRateLimiter(env.AUTH_GLOBAL_RATE_LIMITER) ||
    !hasRateLimiter(env.AUTH_IDENTITY_RATE_LIMITER)
  ) {
    issues.push('AUTH_RATE_LIMITERS_MISSING');
  }

  return issues;
}

/** Adds D1-dependent bootstrap lifecycle checks for the public readiness probe. */
export async function checkDeploymentReadiness(
  env: Env,
): Promise<readonly DeploymentReadinessIssueCode[]> {
  const issues = [...inspectStaticDeploymentConfiguration(env)];
  let initialized: boolean;
  try {
    initialized = await new D1AuthRepository(env.DB).isInitialized();
  } catch {
    issues.push('DATABASE_UNAVAILABLE');
    return issues;
  }

  const bootstrapToken = env.ADMIN_BOOTSTRAP_TOKEN;
  if (!initialized) {
    if (!bootstrapToken) issues.push('ADMIN_BOOTSTRAP_TOKEN_MISSING');
    else if (!validBootstrapToken(bootstrapToken)) {
      issues.push('ADMIN_BOOTSTRAP_TOKEN_INVALID');
    }
  } else if (env.APP_ENV !== 'development' && bootstrapToken) {
    issues.push('ADMIN_BOOTSTRAP_TOKEN_UNEXPECTED');
  }

  return issues;
}
