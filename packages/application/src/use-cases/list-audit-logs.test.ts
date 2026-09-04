import { describe, expect, it, vi } from 'vitest';

import type {
  AuditLogPage,
  AuditLogQuery,
  AuditQueryRepository,
} from '../ports/audit-query';
import {
  AuditQueryApplicationError,
  ListAuditLogs,
} from './list-audit-logs';

const emptyPage: AuditLogPage = { items: [], nextCursor: null };

class FakeAuditQueryRepository implements AuditQueryRepository {
  readonly list = vi.fn(async (_query: AuditLogQuery) => emptyPage);
}

describe('ListAuditLogs', () => {
  it('applies a bounded default and passes valid filters and cursor through', async () => {
    const repository = new FakeAuditQueryRepository();
    const useCase = new ListAuditLogs(repository);

    await expect(useCase.execute()).resolves.toBe(emptyPage);
    expect(repository.list).toHaveBeenNthCalledWith(1, { limit: 50 });

    const query = {
      limit: 200,
      actorType: 'API_KEY' as const,
      action: 'OBJECT_DOWNLOADED',
      resourceType: 'OBJECT',
      resourceId: 'object-1',
      afterCreatedAt: '2026-09-01T12:30:00.000Z',
      afterId: 'audit-9',
    };
    await useCase.execute(query);
    expect(repository.list).toHaveBeenNthCalledWith(2, query);
  });

  it.each([
    { limit: 0 },
    { limit: 201 },
    { limit: 1.5 },
    { actorType: 'USER' },
    { action: '' },
    { resourceType: ' OBJECT' },
    { resourceId: 'object\n1' },
    { afterCreatedAt: '2026-09-01T12:30:00.000Z' },
    { afterId: 'audit-9' },
    { afterCreatedAt: 'not-a-date', afterId: 'audit-9' },
    { afterCreatedAt: '2026-09-01T12:30:00Z', afterId: 'audit-9' },
    { afterCreatedAt: '2026-09-01T12:30:00.000Z', afterId: '' },
  ])('rejects an invalid query before reading the repository: %o', async (query) => {
    const repository = new FakeAuditQueryRepository();
    const useCase = new ListAuditLogs(repository);

    await expect(
      useCase.execute(query as never),
    ).rejects.toBeInstanceOf(AuditQueryApplicationError);
    expect(repository.list).not.toHaveBeenCalled();
  });
});
