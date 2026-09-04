import { describe, expect, it } from 'vitest';

import type {
  AuditOutboxClaim,
  AuditOutboxRepository,
  ClaimAuditOutboxInput,
  DeliverAuditOutboxResult,
} from '../ports/audit-outbox';
import { DrainAuditOutbox } from './audit-outbox';

class FakeOutbox implements AuditOutboxRepository {
  readonly claims: AuditOutboxClaim[] = [];
  readonly retried: string[] = [];
  deliveryFailures = new Set<string>();
  deliveryConflicts = new Set<string>();
  retryFails = new Set<string>();

  async claim(_input: ClaimAuditOutboxInput) {
    return this.claims.shift();
  }

  async deliver(
    id: string,
    _leaseToken: string,
    _deliveredAt: string,
  ): Promise<DeliverAuditOutboxResult> {
    if (this.deliveryFailures.has(id)) throw new Error('database detail');
    return this.deliveryConflicts.has(id) ? 'CONFLICT' : 'DELIVERED';
  }

  async retry(
    id: string,
    _leaseToken: string,
    _availableAt: string,
    errorCode: string,
    _updatedAt: string,
  ) {
    expect(errorCode).toBe('AUDIT_DELIVERY_FAILED');
    if (this.retryFails.has(id)) throw new Error('database detail');
    this.retried.push(id);
    return true;
  }
}

function setup() {
  const outbox = new FakeOutbox();
  let nextId = 0;
  const useCase = new DrainAuditOutbox({
    outbox,
    ids: { next: () => `lease-${nextId += 1}` },
    clock: { now: () => new Date('2026-09-01T00:00:00.000Z') },
  });
  return { outbox, useCase };
}

describe('DrainAuditOutbox', () => {
  it('delivers a bounded sequence and stops when no event remains', async () => {
    const { outbox, useCase } = setup();
    outbox.claims.push(
      { id: 'event-1', attemptCount: 1 },
      { id: 'event-2', attemptCount: 1 },
    );

    await expect(useCase.execute()).resolves.toEqual({
      claimed: 2,
      delivered: 2,
      retried: 0,
      failed: 0,
    });
  });

  it('releases delivery errors and conflicts with a stable retry code', async () => {
    const { outbox, useCase } = setup();
    outbox.claims.push(
      { id: 'throws', attemptCount: 1 },
      { id: 'conflicts', attemptCount: 2 },
    );
    outbox.deliveryFailures.add('throws');
    outbox.deliveryConflicts.add('conflicts');

    await expect(useCase.execute()).resolves.toEqual({
      claimed: 2,
      delivered: 0,
      retried: 2,
      failed: 0,
    });
    expect(outbox.retried).toEqual(['throws', 'conflicts']);
  });

  it('counts a retry persistence failure without leaking the adapter error', async () => {
    const { outbox, useCase } = setup();
    outbox.claims.push({ id: 'event-1', attemptCount: 1 });
    outbox.deliveryFailures.add('event-1');
    outbox.retryFails.add('event-1');

    await expect(useCase.execute()).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      retried: 0,
      failed: 1,
    });
  });
});
