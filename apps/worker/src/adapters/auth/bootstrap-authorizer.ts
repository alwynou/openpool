import type { BootstrapAuthorizer } from '@openpool/application';

import { constantTimeEqual } from './encoding';

/** Verifies the one-time administrator bootstrap token without persisting it. */
export class EnvironmentBootstrapAuthorizer implements BootstrapAuthorizer {
  private readonly expected: Uint8Array;

  constructor(expectedToken: string | undefined) {
    this.expected = new TextEncoder().encode(expectedToken ?? '');
  }

  async verify(token: string): Promise<boolean> {
    if (this.expected.length === 0) return false;
    return constantTimeEqual(this.expected, new TextEncoder().encode(token));
  }
}
