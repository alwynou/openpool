import { ArrowClockwiseIcon, ListChecksIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import type { AuditActorType } from '@openpool/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../api';
import { useI18n } from '../i18n';
import { errorRequestId, errorText, formatDate } from '../lib/utils';
import { queryKeys } from '../queries';
import { Button, EmptyState, ErrorNotice, Input, LoadingState, PageHeader, selectClassName, StatusBadge } from '../components/ui';

export function AuditPage() {
  const { locale, t } = useI18n();
  const [actorType, setActorType] = useState<'all' | AuditActorType>('all');
  const [search, setSearch] = useState('');
  const auditQuery = useQuery({ queryKey: queryKeys.audit(actorType), queryFn: () => api.listAuditLogs({ limit: 100, ...(actorType === 'all' ? {} : { actorType }) }) });
  const items = (auditQuery.data?.items ?? []).filter((item) => {
    const term = search.trim().toLowerCase();
    return !term || `${item.action} ${item.resourceType} ${item.resourceId ?? ''}`.toLowerCase().includes(term);
  });

  return (
    <div className="space-y-8">
      <PageHeader title={t('Audit log')} detail={t('Review recent control-plane actions from administrators, API keys, and maintenance jobs.')} action={<Button type="button" variant="secondary" busy={auditQuery.isFetching} onClick={() => void auditQuery.refetch()}><ArrowClockwiseIcon className="size-4" aria-hidden />{t('Refresh')}</Button>} />
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <label className="relative"><span className="sr-only">{t('Search audit events')}</span><MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" aria-hidden /><Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('Search actions or resources…')} /></label>
        <label><span className="sr-only">{t('Actor type')}</span><select className={selectClassName} value={actorType} onChange={(event) => setActorType(event.target.value as 'all' | AuditActorType)}><option value="all">{t('All actors')}</option><option value="ADMIN">{t('Administrators')}</option><option value="API_KEY">{t('API keys')}</option><option value="SYSTEM">{t('System')}</option></select></label>
      </div>
      {auditQuery.error ? <ErrorNotice error={errorText(auditQuery.error)} requestId={errorRequestId(auditQuery.error)} onRetry={() => void auditQuery.refetch()} /> : null}
      {auditQuery.isLoading ? <LoadingState rows={6} /> : null}
      {!auditQuery.isLoading && items.length === 0 ? <EmptyState title={t('No audit events')} detail={t('Actions will appear here as the control plane is used.')} /> : null}
      {items.length ? (
        <div className="overflow-x-auto rounded-lg border border-zinc-200">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead className="bg-zinc-50/70"><tr className="border-b border-zinc-200 text-[11px] font-semibold tracking-[0.08em] text-zinc-500 uppercase"><th className="px-5 py-3.5">{t('Action')}</th><th className="px-5 py-3.5">{t('Actor')}</th><th className="px-5 py-3.5">{t('Resource')}</th><th className="px-5 py-3.5">{t('Request')}</th><th className="px-5 py-3.5">{t('When')}</th></tr></thead>
            <tbody>{items.map((item) => <tr className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60" key={item.id}><td className="px-5 py-4"><div className="flex items-center gap-3"><span className="grid size-8 place-items-center rounded-md border border-zinc-200"><ListChecksIcon className="size-4" aria-hidden /></span><span className="text-sm font-medium text-zinc-900">{item.action}</span></div></td><td className="px-5 py-4"><StatusBadge value={item.actorType} /></td><td className="px-5 py-4"><p className="text-sm text-zinc-700">{item.resourceType}</p><p className="mt-1 max-w-56 truncate font-mono text-[11px] text-zinc-500">{item.resourceId ?? '—'}</p></td><td className="px-5 py-4 font-mono text-[11px] text-zinc-500">{item.requestId ?? '—'}</td><td className="px-5 py-4 text-sm text-zinc-500">{formatDate(item.createdAt, locale)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
