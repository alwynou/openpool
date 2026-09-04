import type { AuditLogEntry } from './auth';

export interface AuditOutboxClaim {
  readonly id: string;
  readonly attemptCount: number;
}

export interface ClaimAuditOutboxInput {
  readonly leaseToken: string;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
}

export type DeliverAuditOutboxResult =
  | 'DELIVERED'
  | 'ALREADY_DELIVERED'
  | 'CONFLICT';

/**
 * Durable audit delivery port. Business repositories append AuditLogEntry in
 * their own transaction; this port claims and projects those events later.
 */
export interface AuditOutboxRepository {
  claim(input: ClaimAuditOutboxInput): Promise<AuditOutboxClaim | undefined>;
  deliver(
    id: string,
    leaseToken: string,
    deliveredAt: string,
  ): Promise<DeliverAuditOutboxResult>;
  retry(
    id: string,
    leaseToken: string,
    availableAt: string,
    errorCode: string,
    updatedAt: string,
  ): Promise<boolean>;
}

/** Adapter-facing transaction payload; it intentionally excludes request ID. */
export type TransactionalAuditEntry = AuditLogEntry;
