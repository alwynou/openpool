import {
  ArrowRightIcon,
  CheckCircleIcon,
  DatabaseIcon,
  FolderSimpleIcon,
  HardDrivesIcon,
  KeyIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react';
import { Link } from 'react-router-dom';

import { capacityPercent, formatBytes } from '../lib/utils';
import { useI18n } from '../i18n';
import { useAccounts, useApiKeys, useBuckets } from '../queries';
import { ErrorNotice, LoadingState, PageHeader, StatusBadge } from '../components/ui';

export function OverviewPage() {
  const { t } = useI18n();
  const accountsQuery = useAccounts();
  const bucketsQuery = useBuckets();
  const keysQuery = useApiKeys();
  const accounts = accountsQuery.data ?? [];
  const buckets = bucketsQuery.data ?? [];
  const keys = keysQuery.data ?? [];
  const used = accounts.reduce((sum, item) => sum + item.usedBytes, 0);
  const capacity = accounts.reduce((sum, item) => sum + item.capacityBytes, 0);
  const healthy = accounts.filter((item) => item.healthStatus === 'HEALTHY').length;
  const activeKeys = keys.filter((key) => !key.revokedAt && (!key.expiresAt || new Date(key.expiresAt) > new Date())).length;

  if (accountsQuery.isLoading || bucketsQuery.isLoading || keysQuery.isLoading) return <LoadingState rows={5} />;

  return (
    <div className="space-y-8">
      <PageHeader title={t('Overview')} detail={t('A focused view of storage capacity, namespaces, and control-plane access.')} />
      {accountsQuery.error ? <ErrorNotice error={accountsQuery.error.message} onRetry={() => void accountsQuery.refetch()} /> : null}

      <section className="grid divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
        <Metric icon={HardDrivesIcon} label={t('Storage accounts')} value={String(accounts.length)} detail={t('{{count}} healthy', { count: healthy })} />
        <Metric icon={DatabaseIcon} label={t('Available capacity')} value={formatBytes(Math.max(0, capacity - used))} detail={t('{{size}} used', { size: formatBytes(used) })} />
        <Metric icon={FolderSimpleIcon} label={t('Logical buckets')} value={String(buckets.length)} detail={t('Stable namespaces')} />
        <Metric icon={KeyIcon} label={t('Active API keys')} value={String(activeKeys)} detail={t('{{count}} total', { count: keys.length })} />
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <section className="rounded-lg border border-zinc-200">
          <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
            <div><h2 className="text-sm font-semibold text-zinc-950">{t('Storage pool')}</h2><p className="mt-1 text-xs text-zinc-500">{t('Current provider health and utilization')}</p></div>
            <Link to="/accounts" className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-950">{t('Manage accounts')}<ArrowRightIcon className="size-3.5" aria-hidden /></Link>
          </div>
          {accounts.length ? (
            <div className="divide-y divide-zinc-100">
              {accounts.slice(0, 5).map((account) => {
                const percent = capacityPercent(account.usedBytes, account.capacityBytes);
                return (
                  <div className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto_180px] sm:items-center" key={account.id}>
                    <div><p className="text-sm font-medium text-zinc-900">{account.name}</p><p className="mt-1 text-xs text-zinc-500">{account.provider.toUpperCase()} · {t('priority {{priority}}', { priority: account.priority })}</p></div>
                    <div className="flex gap-2"><StatusBadge value={account.status} /><StatusBadge value={account.healthStatus} /></div>
                    <div><div className="flex justify-between text-xs text-zinc-500"><span>{formatBytes(account.usedBytes)}</span><span>{Math.round(percent)}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100"><span className="block h-full rounded-full bg-zinc-950" style={{ width: `${percent}%` }} /></div></div>
                  </div>
                );
              })}
            </div>
          ) : <p className="px-5 py-12 text-center text-sm text-zinc-500">{t('No storage accounts connected.')}</p>}
        </section>

        <section className="rounded-lg border border-zinc-200 p-5">
          <span className="grid size-9 place-items-center rounded-md border border-zinc-200"><ShieldCheckIcon className="size-5" aria-hidden /></span>
          <h2 className="mt-5 text-sm font-semibold text-zinc-950">{t('Direct transfers enforced')}</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-500">{t('OpenPool handles metadata, placement, and signing. Object bytes move directly between clients and storage providers.')}</p>
          <div className="mt-6 flex items-center gap-2 text-xs font-medium text-zinc-700"><CheckCircleIcon className="size-4" weight="fill" aria-hidden />{t('Worker data path stays clear')}</div>
        </section>
      </div>
    </div>
  );
}

function Metric({ icon: Icon, label, value, detail }: { readonly icon: typeof HardDrivesIcon; readonly label: string; readonly value: string; readonly detail: string }) {
  return <div className="p-5"><Icon className="size-5 text-zinc-500" aria-hidden /><p className="mt-5 text-xs font-medium text-zinc-500">{label}</p><strong className="mt-1.5 block text-2xl font-semibold tracking-tight text-zinc-950">{value}</strong><p className="mt-1 text-xs text-zinc-500">{detail}</p></div>;
}
