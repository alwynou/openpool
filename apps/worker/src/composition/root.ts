import { createHttpApp } from '../adapters/http/app';

/**
 * The only composition root. Cloudflare adapters and application use cases are
 * wired here so domain/application packages never import platform code.
 */
export function createWorker() {
  return createHttpApp();
}
