import { CaretDownIcon, FolderSimpleIcon, PlusIcon, SquaresFourIcon } from '@phosphor-icons/react';
import type { LogicalBucketResponse, StorageAccountResponse, StorageShardResponse } from '@openpool/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { api } from '../api';
import { Dialog } from '../components/dialogs';
import { errorRequestId, errorText, formatBytes } from '../lib/utils';
import { queryKeys, useAccounts, useBuckets } from '../queries';
import { Button, EmptyState, ErrorNotice, Field, Input, LoadingState, PageHeader, selectClassName, StatusBadge } from '../components/ui';

const shardTransitions: Record<StorageShardResponse['status'], StorageShardResponse['status'][]> = {
  STANDBY: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['READ_ONLY', 'MIGRATING', 'RETIRED'],
  READ_ONLY: ['RETIRED'],
  MIGRATING: ['ACTIVE', 'READ_ONLY', 'RETIRED'],
  RETIRED: [],
};

export function BucketsPage() {
  const bucketsQuery = useBuckets();
  const accountsQuery = useAccounts();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const createMutation = useMutation({
    mutationFn: ({ name, description }: { name: string; description: string }) => api.createBucket({ name, description: description || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.buckets });
      setCreateOpen(false);
      toast.success('Logical bucket created');
    },
  });
  const buckets = bucketsQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];

  return (
    <div className="space-y-8">
      <PageHeader title="Buckets & shards" detail="Map stable logical namespaces to physical provider buckets." action={<Button type="button" onClick={() => setCreateOpen(true)}><PlusIcon className="size-4" aria-hidden />Create bucket</Button>} />
      {bucketsQuery.error ? <ErrorNotice error={errorText(bucketsQuery.error)} requestId={errorRequestId(bucketsQuery.error)} onRetry={() => void bucketsQuery.refetch()} /> : null}
      {accountsQuery.error ? <ErrorNotice error={errorText(accountsQuery.error)} requestId={errorRequestId(accountsQuery.error)} onRetry={() => void accountsQuery.refetch()} /> : null}
      {bucketsQuery.isLoading || accountsQuery.isLoading ? <LoadingState rows={4} /> : null}
      {!bucketsQuery.isLoading && buckets.length === 0 ? <EmptyState title="No logical buckets yet" detail="Create a stable namespace, then attach an active provider shard." action={<Button type="button" onClick={() => setCreateOpen(true)}>Create bucket</Button>} /> : null}
      <div className="grid gap-5">{buckets.map((bucket) => <BucketPanel bucket={bucket} accounts={accounts} key={bucket.id} />)}</div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen} title="Create logical bucket" description="Logical bucket names remain stable even when physical storage changes.">
        <form className="grid gap-4" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          createMutation.mutate({ name: String(form.get('name') ?? '').trim(), description: String(form.get('description') ?? '').trim() });
        }}>
          {createMutation.error ? <ErrorNotice error={errorText(createMutation.error)} requestId={errorRequestId(createMutation.error)} /> : null}
          <Field label="Bucket name"><Input name="name" placeholder="documents" required /></Field>
          <Field label="Description" hint="Optional context for administrators."><Input name="description" placeholder="Team documents" /></Field>
          <div className="flex justify-end gap-2 border-t border-zinc-100 pt-5"><Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" busy={createMutation.isPending}>Create bucket</Button></div>
        </form>
      </Dialog>
    </div>
  );
}

function BucketPanel({ bucket, accounts }: { readonly bucket: LogicalBucketResponse; readonly accounts: StorageAccountResponse[] }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const shardsQuery = useQuery({ queryKey: queryKeys.shards(bucket.id), queryFn: async () => [...await api.listShards(bucket.id)] });
  const createMutation = useMutation({
    mutationFn: (input: { storageAccountId: string; physicalBucket: string; status: 'STANDBY' | 'ACTIVE'; capacityBytes?: number }) => api.createShard(bucket.id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.shards(bucket.id) });
      setAddOpen(false);
      toast.success('Storage shard added');
    },
  });
  const transitionMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: StorageShardResponse['status'] }) => api.updateShardStatus(id, { status }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.shards(bucket.id) });
      toast.success('Shard status updated');
    },
  });
  const shards = shardsQuery.data ?? [];
  const activeAccounts = accounts.filter((account) => account.status === 'ACTIVE');

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200">
      <div className="flex flex-col gap-4 border-b border-zinc-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-md border border-zinc-200"><FolderSimpleIcon className="size-5" aria-hidden /></span><div className="min-w-0"><h2 className="truncate text-sm font-semibold text-zinc-950">{bucket.name}</h2><p className="mt-1 truncate text-xs text-zinc-500">{bucket.description || 'No description'}</p></div></div>
        <div className="flex items-center gap-3"><span className="text-xs text-zinc-500">{shards.length} shard{shards.length === 1 ? '' : 's'}</span><Button type="button" size="compact" variant="secondary" onClick={() => setAddOpen((value) => !value)}><PlusIcon className="size-3.5" aria-hidden />Add shard</Button></div>
      </div>
      {shardsQuery.error ? <div className="p-4"><ErrorNotice error={errorText(shardsQuery.error)} requestId={errorRequestId(shardsQuery.error)} onRetry={() => void shardsQuery.refetch()} /></div> : null}
      {shardsQuery.isLoading ? <div className="p-4"><LoadingState rows={2} /></div> : null}
      {!shardsQuery.isLoading && shards.length === 0 ? <p className="px-5 py-10 text-center text-sm text-zinc-500">No shards configured for this namespace.</p> : null}
      {shards.length ? <div className="divide-y divide-zinc-100">{shards.map((shard) => {
        const account = accounts.find((item) => item.id === shard.storageAccountId);
        return <div className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_auto_auto] md:items-center" key={shard.id}><div className="flex min-w-0 items-center gap-3"><SquaresFourIcon className="size-5 shrink-0 text-zinc-400" aria-hidden /><div className="min-w-0"><p className="truncate text-sm font-medium text-zinc-900">{shard.physicalBucket}</p><p className="mt-1 truncate text-xs text-zinc-500">{account?.name ?? 'Unknown account'} · {formatBytes(shard.usedBytes)} / {formatBytes(shard.capacityBytes)}</p></div></div><StatusBadge value={shard.status} /><label className="relative"><span className="sr-only">Transition {shard.physicalBucket}</span><select className={`${selectClassName} min-w-40 text-xs`} value="" disabled={transitionMutation.isPending || shardTransitions[shard.status].length === 0} onChange={(event) => { if (event.target.value) transitionMutation.mutate({ id: shard.id, status: event.target.value as StorageShardResponse['status'] }); }}><option value="">Transition…</option>{shardTransitions[shard.status].map((status) => <option value={status} key={status}>{status.replaceAll('_', ' ')}</option>)}</select><CaretDownIcon className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-zinc-400" aria-hidden /></label></div>;
      })}</div> : null}
      {addOpen ? (
        <form className="grid gap-4 border-t border-zinc-200 bg-zinc-50/60 p-5 md:grid-cols-2 xl:grid-cols-5 xl:items-end" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const capacity = String(form.get('capacityBytes') ?? '');
          createMutation.mutate({ storageAccountId: String(form.get('storageAccountId') ?? ''), physicalBucket: String(form.get('physicalBucket') ?? ''), status: String(form.get('status') ?? 'STANDBY') as 'STANDBY' | 'ACTIVE', ...(capacity ? { capacityBytes: Number(capacity) } : {}) });
        }}>
          <Field label="Storage account"><select className={selectClassName} name="storageAccountId" required><option value="">Choose account…</option>{activeAccounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field>
          <Field label="Physical bucket"><Input name="physicalBucket" placeholder="physical-bucket" required /></Field>
          <Field label="Initial state"><select className={selectClassName} name="status" defaultValue="STANDBY"><option value="STANDBY">Standby</option><option value="ACTIVE">Active</option></select></Field>
          <Field label="Capacity in bytes"><Input name="capacityBytes" inputMode="numeric" /></Field>
          <Button type="submit" busy={createMutation.isPending} disabled={!activeAccounts.length}>Add shard</Button>
          {createMutation.error ? <div className="md:col-span-2 xl:col-span-5"><ErrorNotice error={errorText(createMutation.error)} requestId={errorRequestId(createMutation.error)} /></div> : null}
        </form>
      ) : null}
    </section>
  );
}
