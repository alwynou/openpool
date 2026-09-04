import type { AuditOutboxRepository } from '../ports/audit-outbox';
import type { Clock, IdGenerator } from '../ports/storage';

const DELIVERY_BATCH_LIMIT = 100;
const LEASE_TTL_MILLISECONDS = 60_000;
const RETRY_BASE_MILLISECONDS = 5_000;
const RETRY_MAX_MILLISECONDS = 60 * 60 * 1_000;

export interface DrainAuditOutboxResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly failed: number;
}

export interface DrainAuditOutboxDependencies {
  readonly outbox: AuditOutboxRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

function retryDelay(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 10);
  return Math.min(
    RETRY_BASE_MILLISECONDS * 2 ** exponent,
    RETRY_MAX_MILLISECONDS,
  );
}

/** Bounded, retryable projection of durable audit outbox events. */
export class DrainAuditOutbox {
  constructor(private readonly dependencies: DrainAuditOutboxDependencies) {}

  async execute(): Promise<DrainAuditOutboxResult> {
    let claimed = 0;
    let delivered = 0;
    let retried = 0;
    let failed = 0;

    for (let index = 0; index < DELIVERY_BATCH_LIMIT; index += 1) {
      const claimedAt = this.dependencies.clock.now();
      const leaseToken = this.dependencies.ids.next();
      const event = await this.dependencies.outbox.claim({
        leaseToken,
        claimedAt: claimedAt.toISOString(),
        leaseExpiresAt: new Date(
          claimedAt.getTime() + LEASE_TTL_MILLISECONDS,
        ).toISOString(),
      });
      if (!event) break;
      claimed += 1;

      try {
        const result = await this.dependencies.outbox.deliver(
          event.id,
          leaseToken,
          this.dependencies.clock.now().toISOString(),
        );
        if (result === 'DELIVERED' || result === 'ALREADY_DELIVERED') {
          delivered += 1;
          continue;
        }
      } catch {
        // Adapter details are intentionally replaced by the stable retry code.
      }

      const retryAt = this.dependencies.clock.now();
      try {
        const released = await this.dependencies.outbox.retry(
          event.id,
          leaseToken,
          new Date(
            retryAt.getTime() + retryDelay(event.attemptCount),
          ).toISOString(),
          'AUDIT_DELIVERY_FAILED',
          retryAt.toISOString(),
        );
        if (released) {
          retried += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }

    return { claimed, delivered, retried, failed };
  }
}
