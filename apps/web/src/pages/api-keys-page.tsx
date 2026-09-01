import { CopyIcon, KeyIcon, PlusIcon, ShieldCheckIcon, TrashIcon } from '@phosphor-icons/react';
import type { ApiKeyResponse, ApiKeyScope } from '@openpool/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { api } from '../api';
import { errorRequestId, errorText, formatDate } from '../lib/utils';
import { queryKeys, useApiKeys, useBuckets } from '../queries';
import { Button, ConfirmDialog, Dialog, EmptyState, ErrorNotice, Field, Input, LoadingState, PageHeader, selectClassName, StatusBadge } from '../components/ui';

const scopes: ApiKeyScope[] = ['objects:list', 'objects:read', 'objects:upload', 'objects:delete'];

export function ApiKeysPage() {
  const keysQuery = useApiKeys();
  const bucketsQuery = useBuckets();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ApiKeyResponse | null>(null);
  const createMutation = useMutation({
    mutationFn: api.createApiKey,
    onSuccess: async (created) => {
      setCreateOpen(false);
      setRawToken(created.token);
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (key: ApiKeyResponse) => api.revokeApiKey(key.id),
    onSuccess: async () => {
      setPendingRevoke(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
      toast.success('API key revoked');
    },
  });
  const keys = keysQuery.data ?? [];
  const buckets = bucketsQuery.data ?? [];

  return (
    <div className="space-y-8">
      <PageHeader title="API keys" detail="Issue narrowly scoped access for integrations. Raw tokens are shown exactly once." action={<Button type="button" onClick={() => setCreateOpen(true)}><PlusIcon className="size-4" aria-hidden />Create key</Button>} />
      {keysQuery.error ? <ErrorNotice error={errorText(keysQuery.error)} requestId={errorRequestId(keysQuery.error)} onRetry={() => void keysQuery.refetch()} /> : null}
      {keysQuery.isLoading ? <LoadingState rows={4} /> : null}
      {!keysQuery.isLoading && keys.length === 0 ? <EmptyState title="No API keys" detail="Create a scoped key when an external integration needs object access." action={<Button type="button" onClick={() => setCreateOpen(true)}>Create key</Button>} /> : null}
      {keys.length ? (
        <div className="overflow-x-auto rounded-lg border border-zinc-200">
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead className="bg-zinc-50/70"><tr className="border-b border-zinc-200 text-[11px] font-semibold tracking-[0.08em] text-zinc-500 uppercase"><th className="px-5 py-3.5">Name</th><th className="px-5 py-3.5">Scopes</th><th className="px-5 py-3.5">Restriction</th><th className="px-5 py-3.5">Status</th><th className="px-5 py-3.5">Created</th><th className="px-5 py-3.5"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{keys.map((key) => {
              const expired = key.expiresAt ? new Date(key.expiresAt) < new Date() : false;
              return <tr className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60" key={key.id}><td className="px-5 py-4"><div className="flex items-center gap-3"><span className="grid size-8 place-items-center rounded-md border border-zinc-200"><KeyIcon className="size-4" aria-hidden /></span><div><p className="text-sm font-medium text-zinc-900">{key.name}</p><p className="mt-1 font-mono text-xs text-zinc-500">{key.keyPrefix}…</p></div></div></td><td className="px-5 py-4"><div className="flex max-w-72 flex-wrap gap-1.5">{key.scopes.map((scope) => <span className="rounded border border-zinc-200 px-1.5 py-1 font-mono text-[10px] text-zinc-600" key={scope}>{scope}</span>)}</div></td><td className="px-5 py-4"><p className="text-sm text-zinc-700">{key.logicalBucketId ? buckets.find((bucket) => bucket.id === key.logicalBucketId)?.name ?? 'Specific bucket' : 'All buckets'}</p><p className="mt-1 text-xs text-zinc-500">{key.pathPrefix || 'All paths'}</p></td><td className="px-5 py-4"><StatusBadge value={key.revokedAt ? 'REVOKED' : expired ? 'EXPIRED' : 'ACTIVE'} /></td><td className="px-5 py-4 text-sm text-zinc-500">{formatDate(key.createdAt)}</td><td className="px-5 py-4"><Button type="button" variant="ghost" size="icon" className="text-red-600 hover:bg-red-50" aria-label={`Revoke ${key.name}`} disabled={Boolean(key.revokedAt)} onClick={() => setPendingRevoke(key)}><TrashIcon className="size-4" aria-hidden /></Button></td></tr>;
            })}</tbody>
          </table>
        </div>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen} title="Create API key" description="Restrict the key to the minimum bucket, path, scopes, and lifetime the integration needs.">
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const selectedScopes = scopes.filter((scope) => form.get(`scope-${scope}`) === 'on');
          if (!selectedScopes.length) { toast.error('Choose at least one scope.'); return; }
          const bucketId = String(form.get('logicalBucketId') ?? '');
          const pathPrefix = String(form.get('pathPrefix') ?? '');
          const expiresAt = String(form.get('expiresAt') ?? '');
          createMutation.mutate({ name: String(form.get('name') ?? ''), scopes: selectedScopes, ...(bucketId ? { logicalBucketId: bucketId } : {}), ...(pathPrefix ? { pathPrefix } : {}), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) });
        }}>
          {createMutation.error ? <div className="sm:col-span-2"><ErrorNotice error={errorText(createMutation.error)} requestId={errorRequestId(createMutation.error)} /></div> : null}
          <Field label="Key name"><Input name="name" placeholder="CI upload key" required /></Field>
          <Field label="Bucket restriction"><select className={selectClassName} name="logicalBucketId"><option value="">All buckets</option>{buckets.map((bucket) => <option value={bucket.id} key={bucket.id}>{bucket.name}</option>)}</select></Field>
          <Field label="Path prefix" hint="Optional literal prefix such as reports/2026/."><Input name="pathPrefix" placeholder="reports/" /></Field>
          <Field label="Expires"><Input name="expiresAt" type="date" /></Field>
          <fieldset className="rounded-md border border-zinc-200 p-4 sm:col-span-2"><legend className="px-1 text-sm font-medium text-zinc-800">Scopes</legend><div className="mt-1 grid gap-3 sm:grid-cols-2">{scopes.map((scope) => <label className="flex items-center gap-2 text-sm text-zinc-700" key={scope}><input className="size-4 accent-zinc-950" name={`scope-${scope}`} type="checkbox" defaultChecked={scope === 'objects:list' || scope === 'objects:read'} /><span className="font-mono text-xs">{scope}</span></label>)}</div></fieldset>
          <div className="mt-2 flex justify-end gap-2 border-t border-zinc-100 pt-5 sm:col-span-2"><Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" busy={createMutation.isPending}>Generate key</Button></div>
        </form>
      </Dialog>

      <Dialog open={rawToken !== null} onOpenChange={(open) => { if (!open) setRawToken(null); }} title="Your API key is ready" description="This raw token will not be shown again. Save it in a password manager before closing.">
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4"><div className="flex items-start gap-3"><ShieldCheckIcon className="mt-0.5 size-5 shrink-0" aria-hidden /><code className="min-w-0 flex-1 break-all font-mono text-xs leading-6 text-zinc-800">{rawToken}</code><Button type="button" variant="secondary" size="compact" onClick={() => { if (rawToken) { void navigator.clipboard?.writeText(rawToken); toast.success('Token copied'); } }}><CopyIcon className="size-3.5" aria-hidden />Copy</Button></div></div>
        <div className="mt-5 flex justify-end"><Button type="button" onClick={() => setRawToken(null)}>I’ve saved the token</Button></div>
      </Dialog>

      <ConfirmDialog open={pendingRevoke !== null} onOpenChange={(open) => { if (!open) setPendingRevoke(null); }} title={pendingRevoke ? `Revoke ${pendingRevoke.name}?` : 'Revoke API key?'} description="Existing integrations using this key will immediately lose access. Revocation is idempotent and cannot be undone." confirmLabel="Revoke key" busy={revokeMutation.isPending} onConfirm={() => { if (pendingRevoke) revokeMutation.mutate(pendingRevoke); }} />
    </div>
  );
}
