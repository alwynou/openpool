import {
  ArrowRightIcon,
  CaretDownIcon,
  FolderSimpleIcon,
  PlusIcon,
  SquaresFourIcon,
} from '@phosphor-icons/react';
import type {
  LogicalBucketResponse,
  ShardMigrationResponse,
  StorageAccountResponse,
  StorageShardResponse,
  UpdateStorageShardStatusRequest,
} from '@openpool/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { api } from '../api';
import { Dialog } from '../components/dialogs';
import {
  Button,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  LoadingState,
  PageHeader,
  selectClassName,
  StatusBadge,
} from '../components/ui';
import { errorRequestId, errorText, formatBytes } from '../lib/utils';
import { useI18n } from '../i18n';
import { eligibleMigrationTargets } from '../lib/shard-migrations';
import { queryKeys, useAccounts, useBuckets } from '../queries';

const shardTransitions: Record<
  StorageShardResponse['status'],
  readonly UpdateStorageShardStatusRequest['status'][]
> = {
  STANDBY: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['READ_ONLY'],
  READ_ONLY: ['RETIRED'],
  MIGRATING: [],
  RETIRED: [],
};

export function BucketsPage() {
  const { t } = useI18n();
  const bucketsQuery = useBuckets();
  const accountsQuery = useAccounts();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const createMutation = useMutation({
    mutationFn: ({
      name,
      description,
    }: {
      name: string;
      description: string;
    }) => api.createBucket({ name, description: description || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.buckets });
      setCreateOpen(false);
      toast.success(t('Logical bucket created'));
    },
  });
  const buckets = bucketsQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('Buckets & shards')}
        detail={t('Map stable logical namespaces to physical provider buckets.')}
        action={
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4" aria-hidden />
            {t('Create bucket')}
          </Button>
        }
      />
      {bucketsQuery.error ? (
        <ErrorNotice
          error={errorText(bucketsQuery.error)}
          requestId={errorRequestId(bucketsQuery.error)}
          onRetry={() => void bucketsQuery.refetch()}
        />
      ) : null}
      {accountsQuery.error ? (
        <ErrorNotice
          error={errorText(accountsQuery.error)}
          requestId={errorRequestId(accountsQuery.error)}
          onRetry={() => void accountsQuery.refetch()}
        />
      ) : null}
      {bucketsQuery.isLoading || accountsQuery.isLoading ? (
        <LoadingState rows={4} />
      ) : null}
      {!bucketsQuery.isLoading && buckets.length === 0 ? (
        <EmptyState
          title={t('No logical buckets yet')}
          detail={t('Create a stable namespace, then attach an active provider shard.')}
          action={
            <Button type="button" onClick={() => setCreateOpen(true)}>
              {t('Create bucket')}
            </Button>
          }
        />
      ) : null}
      <div className="grid gap-5">
        {buckets.map((bucket) => (
          <BucketPanel bucket={bucket} accounts={accounts} key={bucket.id} />
        ))}
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t('Create logical bucket')}
        description={t('Logical bucket names remain stable even when physical storage changes.')}
      >
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            createMutation.mutate({
              name: String(form.get('name') ?? '').trim(),
              description: String(form.get('description') ?? '').trim(),
            });
          }}
        >
          {createMutation.error ? (
            <ErrorNotice
              error={errorText(createMutation.error)}
              requestId={errorRequestId(createMutation.error)}
            />
          ) : null}
          <Field label={t('Bucket name')}>
            <Input name="name" placeholder="documents" required />
          </Field>
          <Field label={t('Description')} hint={t('Optional context for administrators.')}>
            <Input name="description" placeholder={t('Team documents')} />
          </Field>
          <div className="flex justify-end gap-2 border-t border-zinc-100 pt-5">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreateOpen(false)}
            >
              {t('Cancel')}
            </Button>
            <Button type="submit" busy={createMutation.isPending}>
              {t('Create bucket')}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

interface MigrationSelection {
  readonly source: StorageShardResponse;
  readonly targets: readonly StorageShardResponse[];
}

function BucketPanel({
  bucket,
  accounts,
}: {
  readonly bucket: LogicalBucketResponse;
  readonly accounts: readonly StorageAccountResponse[];
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [migrationSelection, setMigrationSelection] =
    useState<MigrationSelection | null>(null);
  const shardsQuery = useQuery({
    queryKey: queryKeys.shards(bucket.id),
    queryFn: async () => [...(await api.listShards(bucket.id))],
  });
  const migrationsQuery = useQuery({
    queryKey: queryKeys.migrations(bucket.id),
    queryFn: async () => [...(await api.listShardMigrations(bucket.id))],
    refetchInterval: (query) =>
      query.state.data?.some((migration) => migration.status === 'RUNNING')
        ? 3_000
        : false,
  });
  const createMutation = useMutation({
    mutationFn: (input: {
      storageAccountId: string;
      physicalBucket: string;
      status: 'STANDBY' | 'ACTIVE';
      capacityBytes?: number;
    }) => api.createShard(bucket.id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.shards(bucket.id),
      });
      setAddOpen(false);
      toast.success(t('Storage shard added'));
    },
  });
  const transitionMutation = useMutation({
    mutationFn: ({
      id,
      status,
    }: {
      id: string;
      status: UpdateStorageShardStatusRequest['status'];
    }) => api.updateShardStatus(id, { status }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.shards(bucket.id),
      });
      toast.success(t('Shard status updated'));
    },
  });
  const startMigrationMutation = useMutation({
    mutationFn: ({
      source,
      target,
    }: {
      source: StorageShardResponse;
      target: StorageShardResponse;
    }) =>
      api.startShardMigration({
        sourceShardId: source.id,
        targetShardId: target.id,
        expectedSourceUpdatedAt: source.updatedAt,
        expectedTargetUpdatedAt: target.updatedAt,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.shards(bucket.id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.migrations(bucket.id),
        }),
      ]);
      setMigrationSelection(null);
      toast.success(t('Shard migration started'));
    },
  });
  const shards = shardsQuery.data ?? [];
  const migrations = migrationsQuery.data ?? [];
  const completedMigrations = migrations.filter(
    (migration) => migration.status === 'COMPLETED',
  ).length;

  useEffect(() => {
    if (completedMigrations > 0) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.shards(bucket.id),
      });
    }
  }, [bucket.id, completedMigrations, queryClient]);

  const activeAccounts = accounts.filter(
    (account) => account.status === 'ACTIVE',
  );

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200">
      <div className="flex flex-col gap-4 border-b border-zinc-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-zinc-200">
            <FolderSimpleIcon className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-zinc-950">
              {bucket.name}
            </h2>
            <p className="mt-1 truncate text-xs text-zinc-500">
              {bucket.description || t('No description')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">
            {t('{{count}} shards', { count: shards.length })}
          </span>
          <Button
            type="button"
            size="compact"
            variant="secondary"
            onClick={() => setAddOpen((value) => !value)}
          >
            <PlusIcon className="size-3.5" aria-hidden />
            {t('Add shard')}
          </Button>
        </div>
      </div>
      {shardsQuery.error ? (
        <div className="p-4">
          <ErrorNotice
            error={errorText(shardsQuery.error)}
            requestId={errorRequestId(shardsQuery.error)}
            onRetry={() => void shardsQuery.refetch()}
          />
        </div>
      ) : null}
      {migrationsQuery.error ? (
        <div className="p-4">
          <ErrorNotice
            error={errorText(migrationsQuery.error)}
            requestId={errorRequestId(migrationsQuery.error)}
            onRetry={() => void migrationsQuery.refetch()}
          />
        </div>
      ) : null}
      {transitionMutation.error ? (
        <div className="p-4">
          <ErrorNotice
            error={errorText(transitionMutation.error)}
            requestId={errorRequestId(transitionMutation.error)}
          />
        </div>
      ) : null}
      {shardsQuery.isLoading ? (
        <div className="p-4">
          <LoadingState rows={2} />
        </div>
      ) : null}
      {!shardsQuery.isLoading && shards.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-zinc-500">
          {t('No shards configured for this namespace.')}
        </p>
      ) : null}
      {shards.length ? (
        <div className="divide-y divide-zinc-100">
          {shards.map((shard) => {
            const account = accounts.find(
              (item) => item.id === shard.storageAccountId,
            );
            const targets = eligibleMigrationTargets(shard, shards, accounts);
            const drainingSource =
              shard.status === 'ACTIVE' && account?.status === 'DRAINING';
            const availableTransitions = drainingSource
              ? []
              : shardTransitions[shard.status];
            return (
              <div
                className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_auto_minmax(16rem,auto)] md:items-center"
                key={shard.id}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <SquaresFourIcon
                    className="size-5 shrink-0 text-zinc-400"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-900">
                      {shard.physicalBucket}
                    </p>
                    <p className="mt-1 truncate text-xs text-zinc-500">
                      {account?.name ?? t('Unknown account')} ·{' '}
                      {formatBytes(shard.usedBytes)} /{' '}
                      {formatBytes(shard.capacityBytes)}
                    </p>
                  </div>
                </div>
                <StatusBadge value={shard.status} />
                <div className="flex items-center justify-end gap-2">
                  {drainingSource ? (
                    <Button
                      type="button"
                      size="compact"
                      variant="secondary"
                      disabled={targets.length === 0}
                      title={
                        targets.length === 0
                          ? t('Add a healthy standby shard with enough capacity first.')
                          : undefined
                      }
                      onClick={() =>
                        setMigrationSelection({ source: shard, targets })
                      }
                    >
                      <ArrowRightIcon className="size-3.5" aria-hidden />
                      {t(targets.length === 0 ? 'No migration target' : 'Migrate')}
                    </Button>
                  ) : null}
                  <label className="relative min-w-40">
                    <span className="sr-only">
                      {t('Transition {{bucket}}', { bucket: shard.physicalBucket })}
                    </span>
                    <select
                      className={`${selectClassName} text-xs`}
                      value=""
                      disabled={
                        transitionMutation.isPending ||
                        availableTransitions.length === 0
                      }
                      onChange={(event) => {
                        if (event.target.value) {
                          transitionMutation.mutate({
                            id: shard.id,
                            status: event.target
                              .value as UpdateStorageShardStatusRequest['status'],
                          });
                        }
                      }}
                    >
                      <option value="">{t('Transition…')}</option>
                      {availableTransitions.map((status) => (
                        <option value={status} key={status}>
                          {t(status.replaceAll('_', ' '))}
                        </option>
                      ))}
                    </select>
                    <CaretDownIcon
                      className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-zinc-400"
                      aria-hidden
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {migrations.length ? (
        <MigrationActivity migrations={migrations} shards={shards} />
      ) : null}
      {addOpen ? (
        <form
          className="grid gap-4 border-t border-zinc-200 bg-zinc-50/60 p-5 md:grid-cols-2 xl:grid-cols-5 xl:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const capacity = String(form.get('capacityBytes') ?? '');
            createMutation.mutate({
              storageAccountId: String(form.get('storageAccountId') ?? ''),
              physicalBucket: String(form.get('physicalBucket') ?? ''),
              status: String(
                form.get('status') ?? 'STANDBY',
              ) as 'STANDBY' | 'ACTIVE',
              ...(capacity ? { capacityBytes: Number(capacity) } : {}),
            });
          }}
        >
          <Field label={t('Storage account')}>
            <select className={selectClassName} name="storageAccountId" required>
              <option value="">{t('Choose account…')}</option>
              {activeAccounts.map((account) => (
                <option value={account.id} key={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Physical bucket')}>
            <Input name="physicalBucket" placeholder="physical-bucket" required />
          </Field>
          <Field label={t('Initial state')}>
            <select
              className={selectClassName}
              name="status"
              defaultValue="STANDBY"
            >
              <option value="STANDBY">{t('Standby')}</option>
              <option value="ACTIVE">{t('Active')}</option>
            </select>
          </Field>
          <Field label={t('Capacity in bytes')}>
            <Input name="capacityBytes" inputMode="numeric" />
          </Field>
          <Button
            type="submit"
            busy={createMutation.isPending}
            disabled={!activeAccounts.length}
          >
            {t('Add shard')}
          </Button>
          {createMutation.error ? (
            <div className="md:col-span-2 xl:col-span-5">
              <ErrorNotice
                error={errorText(createMutation.error)}
                requestId={errorRequestId(createMutation.error)}
              />
            </div>
          ) : null}
        </form>
      ) : null}

      <Dialog
        open={migrationSelection !== null}
        onOpenChange={(open) => {
          if (!open) setMigrationSelection(null);
        }}
        title={t('Start shard migration')}
        description={t('New writes cut over to the target immediately. A migration runner then streams object bytes directly between providers; the Worker never proxies them.')}
      >
        {migrationSelection ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const target = migrationSelection.targets.find(
                (candidate) => candidate.id === form.get('targetShardId'),
              );
              if (target) {
                startMigrationMutation.mutate({
                  source: migrationSelection.source,
                  target,
                });
              }
            }}
          >
            {startMigrationMutation.error ? (
              <ErrorNotice
                error={errorText(startMigrationMutation.error)}
                requestId={errorRequestId(startMigrationMutation.error)}
              />
            ) : null}
            <Field label={t('Source shard')}>
              <Input
                value={migrationSelection.source.physicalBucket}
                disabled
                readOnly
              />
            </Field>
            <Field
              label={t('Target shard')}
              hint={t('Only healthy standby shards with enough 10% headroom are shown.')}
            >
              <select
                className={selectClassName}
                name="targetShardId"
                defaultValue={migrationSelection.targets[0]?.id}
                required
              >
                {migrationSelection.targets.map((target) => {
                  const account = accounts.find(
                    (candidate) => candidate.id === target.storageAccountId,
                  );
                  return (
                    <option value={target.id} key={target.id}>
                      {target.physicalBucket} · {account?.name ?? t('Unknown account')}
                    </option>
                  );
                })}
              </select>
            </Field>
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
              {t('Do not retire or manually transition either shard while migration is running. Pending or deleting objects can block final retirement and will be shown in progress.')}
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-100 pt-5">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setMigrationSelection(null)}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" busy={startMigrationMutation.isPending}>
                {t('Start migration')}
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </section>
  );
}

function MigrationActivity({
  migrations,
  shards,
}: {
  readonly migrations: readonly ShardMigrationResponse[];
  readonly shards: readonly StorageShardResponse[];
}) {
  const { t } = useI18n();
  return (
    <div className="border-t border-zinc-200 bg-zinc-50/60 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold tracking-wide text-zinc-700 uppercase">
          {t('Migration activity')}
        </h3>
        <span className="text-xs text-zinc-500">
          {t('Running migrations refresh every 3 seconds')}
        </span>
      </div>
      <div className="grid gap-3">
        {migrations.map((migration) => {
          const source = shards.find(
            (shard) => shard.id === migration.sourceShardId,
          );
          const target = shards.find(
            (shard) => shard.id === migration.targetShardId,
          );
          const progress = migration.progress;
          return (
            <div
              className="rounded-md border border-zinc-200 bg-white p-4"
              key={migration.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-zinc-900">
                  <span className="truncate">
                    {source?.physicalBucket ?? migration.sourceShardId}
                  </span>
                  <ArrowRightIcon
                    className="size-3.5 shrink-0 text-zinc-400"
                    aria-hidden
                  />
                  <span className="truncate">
                    {target?.physicalBucket ?? migration.targetShardId}
                  </span>
                </div>
                <StatusBadge value={migration.status} />
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
                <ProgressMetric label={t('Remaining')} value={progress.remainingReady} />
                <ProgressMetric label={t('Reserved')} value={progress.reserved} />
                <ProgressMetric label={t('Switched')} value={progress.switched} />
                <ProgressMetric label={t('Completed')} value={progress.completed} />
                <ProgressMetric label={t('Failed')} value={progress.failed} />
                <ProgressMetric label={t('Blocking')} value={progress.blocking} />
              </dl>
              <p className="mt-3 font-mono text-[11px] text-zinc-400">
                {migration.id}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProgressMetric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number;
}) {
  return (
    <div>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-zinc-900">{value}</dd>
    </div>
  );
}
