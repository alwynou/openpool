import {
  CheckCircleIcon,
  CloudIcon,
  CopyIcon,
  DotsThreeVerticalIcon,
  FireIcon,
  HardDrivesIcon,
  HeartbeatIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ProhibitIcon,
  ShieldWarningIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { zodResolver } from '@hookform/resolvers/zod';
import type { CreateStorageAccountRequest, StorageAccountResponse, StorageProviderKind } from '@openpool/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { api } from '../api';
import {
  capacityPercent,
  cn,
  errorRequestId,
  errorText,
  formatBytes,
  formatDate,
  providerLabel,
  relativeDate,
} from '../lib/utils';
import { queryKeys, useAccounts } from '../queries';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  LoadingState,
  PageHeader,
  selectClassName,
  StatusBadge,
} from '../components/ui';

const accountSchema = z.object({
  name: z.string().trim().min(1, 'Enter a display name.').max(100),
  provider: z.enum(['r2', 'b2', 's3']),
  accountId: z.string(),
  region: z.string(),
  endpoint: z.string(),
  jurisdiction: z.string(),
  validationBucket: z.string().trim().min(1, 'Enter the existing physical bucket name.'),
  accessKeyId: z.string().trim().min(1, 'Enter the access key ID.'),
  secretAccessKey: z.string().min(1, 'Enter the secret access key.'),
  sessionToken: z.string(),
  priority: z.string().regex(/^\d+$/u, 'Priority must be a non-negative integer.'),
  capacityBytes: z.string().refine((value) => value === '' || /^\d+$/u.test(value), 'Capacity must be a non-negative integer.'),
}).superRefine((value, context) => {
  if (value.provider === 'r2' && !value.accountId.trim()) {
    context.addIssue({ code: 'custom', path: ['accountId'], message: 'Enter the Cloudflare account ID.' });
  }
  if (value.provider !== 'r2' && !value.region.trim()) {
    context.addIssue({ code: 'custom', path: ['region'], message: 'Enter the provider region.' });
  }
  if (value.provider === 's3') {
    try {
      const endpoint = new URL(value.endpoint);
      if (endpoint.protocol !== 'https:') throw new Error('not HTTPS');
    } catch {
      context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Enter a valid HTTPS endpoint.' });
    }
  }
  if (value.provider === 'r2' && !value.capacityBytes) {
    context.addIssue({ code: 'custom', path: ['capacityBytes'], message: 'R2 requires a configured capacity.' });
  }
});

type AccountFormValues = z.input<typeof accountSchema>;

const defaultAccountValues: AccountFormValues = {
  name: '',
  provider: 'r2',
  accountId: '',
  region: '',
  endpoint: '',
  jurisdiction: '',
  validationBucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
  priority: '100',
  capacityBytes: '',
};

interface PendingTransition {
  readonly account: StorageAccountResponse;
  readonly status: 'DRAINING' | 'READ_ONLY' | 'REMOVED';
}

export function AccountsPage() {
  const accountsQuery = useAccounts();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState<'all' | StorageProviderKind>('all');
  const [status, setStatus] = useState('all');
  const [health, setHealth] = useState('all');
  const [actionFailure, setActionFailure] = useState<{ accountId: string; error: unknown } | null>(null);
  const [pendingTransition, setPendingTransition] = useState<PendingTransition | null>(null);

  const refresh = async () => queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
  const actionMutation = useMutation({
    mutationFn: async ({ account, action }: { account: StorageAccountResponse; action: 'verify' | 'health' }) => {
      if (action === 'verify') return api.verifyAccount(account.id);
      return api.healthAccount(account.id);
    },
    onSuccess: async (_, variables) => {
      setActionFailure(null);
      await refresh();
      toast.success(variables.action === 'verify' ? 'Account verified' : 'Health check completed');
    },
    onError: (error, variables) => setActionFailure({ accountId: variables.account.id, error }),
  });
  const transitionMutation = useMutation({
    mutationFn: async ({ account, status: nextStatus }: PendingTransition) => api.updateAccountStatus(account.id, { status: nextStatus }),
    onSuccess: async (_, variables) => {
      setPendingTransition(null);
      await refresh();
      toast.success(`${variables.account.name} is now ${variables.status.replaceAll('_', ' ').toLowerCase()}`);
    },
    onError: (error, variables) => setActionFailure({ accountId: variables.account.id, error }),
  });

  const accounts = accountsQuery.data ?? [];
  const term = search.trim().toLowerCase();
  const filtered = accounts.filter((account) => {
    if (term && !`${account.name} ${account.provider}`.toLowerCase().includes(term)) return false;
    if (provider !== 'all' && account.provider !== provider) return false;
    if (status !== 'all' && account.status !== status) return false;
    return health === 'all' || account.healthStatus === health;
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Storage accounts"
        detail="Connect and manage the object storage providers that make up your pool."
        action={<Button type="button" onClick={() => setCreateOpen(true)}><PlusIcon className="size-4" aria-hidden />Add account</Button>}
      />

      <div className="grid gap-3 xl:grid-cols-[minmax(260px,1fr)_180px_180px_180px_auto]">
        <label className="relative">
          <span className="sr-only">Search accounts</span>
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
          <Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search accounts by name or provider…" />
        </label>
        <FilterSelect label="Provider" value={provider} onChange={setProvider} options={[['all', 'All providers'], ['r2', 'Cloudflare R2'], ['b2', 'Backblaze B2'], ['s3', 'S3 Compatible']]} />
        <FilterSelect label="Status" value={status} onChange={setStatus} options={[['all', 'All statuses'], ['VERIFYING', 'Verifying'], ['ACTIVE', 'Active'], ['DRAINING', 'Draining'], ['READ_ONLY', 'Read only'], ['REMOVED', 'Removed']]} />
        <FilterSelect label="Health" value={health} onChange={setHealth} options={[['all', 'All health'], ['UNKNOWN', 'Unknown'], ['HEALTHY', 'Healthy'], ['DEGRADED', 'Degraded'], ['UNHEALTHY', 'Unhealthy']]} />
        <Button type="button" variant="secondary" onClick={() => void accountsQuery.refetch()} busy={accountsQuery.isFetching}>Refresh</Button>
      </div>

      {accountsQuery.error ? <ErrorNotice error={errorText(accountsQuery.error)} requestId={errorRequestId(accountsQuery.error)} onRetry={() => void accountsQuery.refetch()} /> : null}
      {accountsQuery.isLoading ? <LoadingState rows={3} /> : null}
      {!accountsQuery.isLoading && accounts.length === 0 ? (
        <EmptyState title="No storage accounts yet" detail="Connect an R2, Backblaze B2, or S3-compatible provider to start building the pool." action={<Button type="button" onClick={() => setCreateOpen(true)}>Add account</Button>} />
      ) : null}
      {!accountsQuery.isLoading && accounts.length > 0 ? (
        <AccountsTable
          accounts={filtered}
          total={accounts.length}
          actionFailure={actionFailure}
          actionMutation={actionMutation}
          onTransition={setPendingTransition}
        />
      ) : null}

      <CreateAccountDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={refresh} />
      <ConfirmDialog
        open={pendingTransition !== null}
        onOpenChange={(open) => { if (!open) setPendingTransition(null); }}
        title={pendingTransition ? `${transitionLabel(pendingTransition.status)} ${pendingTransition.account.name}?` : 'Change account state?'}
        description={pendingTransition ? transitionDescription(pendingTransition.status) : ''}
        confirmLabel={pendingTransition ? transitionLabel(pendingTransition.status) : 'Continue'}
        busy={transitionMutation.isPending}
        onConfirm={() => { if (pendingTransition) transitionMutation.mutate(pendingTransition); }}
      />
    </div>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  readonly label: string;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: ReadonlyArray<readonly [T, string]>;
}) {
  return (
    <label>
      <span className="sr-only">{label}</span>
      <select className={selectClassName} value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map(([optionValue, optionLabel]) => <option value={optionValue} key={optionValue}>{optionLabel}</option>)}
      </select>
    </label>
  );
}

function AccountsTable({
  accounts,
  total,
  actionFailure,
  actionMutation,
  onTransition,
}: {
  readonly accounts: StorageAccountResponse[];
  readonly total: number;
  readonly actionFailure: { accountId: string; error: unknown } | null;
  readonly actionMutation: ReturnType<typeof useMutation<StorageAccountResponse, Error, { account: StorageAccountResponse; action: 'verify' | 'health' }>>;
  readonly onTransition: (transition: PendingTransition) => void;
}) {
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-zinc-200">
        <table className="w-full min-w-[940px] border-collapse text-left">
          <thead className="bg-zinc-50/70">
            <tr className="border-b border-zinc-200 text-[11px] font-semibold tracking-[0.08em] text-zinc-500 uppercase">
              <th className="px-5 py-3.5">Account</th>
              <th className="px-5 py-3.5">Provider</th>
              <th className="px-5 py-3.5">Status</th>
              <th className="px-5 py-3.5">Health</th>
              <th className="px-5 py-3.5">Capacity</th>
              <th className="px-5 py-3.5">Last check</th>
              <th className="w-16 px-5 py-3.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <AccountRows
                key={account.id}
                account={account}
                failure={actionFailure?.accountId === account.id ? actionFailure.error : null}
                actionMutation={actionMutation}
                onTransition={onTransition}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-zinc-500">Showing {accounts.length} of {total} accounts</p>
    </div>
  );
}

function AccountRows({
  account,
  failure,
  actionMutation,
  onTransition,
}: {
  readonly account: StorageAccountResponse;
  readonly failure: unknown;
  readonly actionMutation: ReturnType<typeof useMutation<StorageAccountResponse, Error, { account: StorageAccountResponse; action: 'verify' | 'health' }>>;
  readonly onTransition: (transition: PendingTransition) => void;
}) {
  const percentage = capacityPercent(account.usedBytes, account.capacityBytes);
  const ProviderIcon = account.provider === 'r2' ? CloudIcon : account.provider === 'b2' ? FireIcon : HardDrivesIcon;
  return (
    <>
      <tr className="border-b border-zinc-100 align-middle transition-colors hover:bg-zinc-50/60">
        <td className="px-5 py-5">
          <p className="font-medium text-zinc-950">{account.name}</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
            {account.provider} · priority {account.priority}
            <button type="button" className="rounded p-0.5 hover:bg-zinc-100" aria-label={`Copy ${account.name} account ID`} onClick={() => void navigator.clipboard?.writeText(account.id)}>
              <CopyIcon className="size-3" aria-hidden />
            </button>
          </p>
        </td>
        <td className="px-5 py-5">
          <span className="inline-flex items-center gap-2 text-sm text-zinc-700"><ProviderIcon className="size-5" aria-hidden />{providerLabel(account.provider)}</span>
        </td>
        <td className="px-5 py-5"><StatusBadge value={account.status} /><p className="mt-1.5 text-xs text-zinc-500">{account.writeEnabled ? 'Read / Write' : 'Read only'}</p></td>
        <td className="px-5 py-5"><StatusBadge value={account.healthStatus} /><p className="mt-1.5 text-xs text-zinc-500">{account.healthStatus === 'HEALTHY' ? 'All systems normal' : account.healthStatus === 'UNKNOWN' ? 'Not checked' : 'Attention required'}</p></td>
        <td className="min-w-44 px-5 py-5">
          <p className="text-sm text-zinc-800">{formatBytes(account.usedBytes)} / {formatBytes(account.capacityBytes)}</p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100"><span className="block h-full rounded-full bg-zinc-950" style={{ width: `${percentage}%` }} /></div>
          <p className="mt-1.5 text-xs text-zinc-500">{Math.round(percentage)}% used · {account.capacityAccuracy.toLowerCase()}</p>
        </td>
        <td className="px-5 py-5"><p className="text-sm text-zinc-800">{relativeDate(account.lastHealthCheckedAt)}</p><p className="mt-1.5 text-xs text-zinc-500">{formatDate(account.lastHealthCheckedAt)}</p></td>
        <td className="px-5 py-5"><AccountMenu account={account} actionMutation={actionMutation} onTransition={onTransition} /></td>
      </tr>
      {failure ? (
        <tr className="border-b border-zinc-100">
          <td colSpan={7} className="px-4 py-3">
            <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <ShieldWarningIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1"><p>{errorText(failure)}</p>{errorRequestId(failure) ? <p className="mt-1 font-mono text-[11px] text-amber-700">Request ID: {errorRequestId(failure)}</p> : null}</div>
              <Button type="button" size="compact" variant="secondary" busy={actionMutation.isPending} onClick={() => actionMutation.mutate({ account, action: account.status === 'VERIFYING' ? 'verify' : 'health' })}>Retry</Button>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function AccountMenu({
  account,
  actionMutation,
  onTransition,
}: {
  readonly account: StorageAccountResponse;
  readonly actionMutation: ReturnType<typeof useMutation<StorageAccountResponse, Error, { account: StorageAccountResponse; action: 'verify' | 'health' }>>;
  readonly onTransition: (transition: PendingTransition) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={`Actions for ${account.name}`}><DotsThreeVerticalIcon className="size-5" weight="bold" aria-hidden /></Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-48 rounded-md border border-zinc-200 bg-white p-1 shadow-lg outline-none data-[state=open]:animate-enter">
          {account.status === 'VERIFYING' ? <MenuItem icon={CheckCircleIcon} onSelect={() => actionMutation.mutate({ account, action: 'verify' })}>Verify account</MenuItem> : null}
          {account.status !== 'REMOVED' ? <MenuItem icon={HeartbeatIcon} onSelect={() => actionMutation.mutate({ account, action: 'health' })}>Run health check</MenuItem> : null}
          {account.status === 'ACTIVE' ? <MenuItem icon={ProhibitIcon} danger onSelect={() => onTransition({ account, status: 'DRAINING' })}>Begin draining</MenuItem> : null}
          {account.status === 'DRAINING' ? <MenuItem icon={ProhibitIcon} danger onSelect={() => onTransition({ account, status: 'READ_ONLY' })}>Make read only</MenuItem> : null}
          {account.status === 'READ_ONLY' ? <MenuItem icon={TrashIcon} danger onSelect={() => onTransition({ account, status: 'REMOVED' })}>Remove account</MenuItem> : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MenuItem({ icon: Icon, danger = false, onSelect, children }: { readonly icon: typeof CheckCircleIcon; readonly danger?: boolean; readonly onSelect: () => void; readonly children: string }) {
  return <DropdownMenu.Item onSelect={onSelect} className={cn('flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm text-zinc-700 outline-none focus:bg-zinc-100', danger && 'text-red-600 focus:bg-red-50')}><Icon className="size-4" aria-hidden />{children}</DropdownMenu.Item>;
}

function CreateAccountDialog({ open, onOpenChange, onCreated }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly onCreated: () => Promise<unknown> }) {
  const form = useForm<AccountFormValues>({ resolver: zodResolver(accountSchema), defaultValues: defaultAccountValues });
  const provider = useWatch({ control: form.control, name: 'provider' });
  const mutation = useMutation({
    mutationFn: (input: CreateStorageAccountRequest) => api.createAccount(input),
    onSuccess: async () => {
      form.reset(defaultAccountValues);
      await onCreated();
      onOpenChange(false);
      toast.success('Storage account created', { description: 'Verify the account before using it for placement.' });
    },
  });

  const submit = form.handleSubmit((values) => {
    const providerConfig: Record<string, string> = { validationBucket: values.validationBucket.trim() };
    if (values.provider === 'r2') {
      providerConfig.accountId = values.accountId.trim();
      if (values.jurisdiction) providerConfig.jurisdiction = values.jurisdiction;
    }
    if (values.provider === 'b2') providerConfig.region = values.region.trim();
    if (values.provider === 's3') {
      providerConfig.endpoint = values.endpoint.trim();
      providerConfig.region = values.region.trim();
    }
    mutation.mutate({
      name: values.name.trim(),
      provider: values.provider,
      providerConfig,
      credentials: {
        accessKeyId: values.accessKeyId.trim(),
        secretAccessKey: values.secretAccessKey,
        ...(values.sessionToken ? { sessionToken: values.sessionToken } : {}),
      },
      priority: Number(values.priority),
      ...(values.capacityBytes ? { capacityBytes: Number(values.capacityBytes) } : {}),
    });
  });

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!mutation.isPending) onOpenChange(nextOpen); }} title="Add storage account" description="Credentials are encrypted before they are persisted and never returned by the API.">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
        {mutation.error ? <div className="sm:col-span-2"><ErrorNotice error={errorText(mutation.error)} requestId={errorRequestId(mutation.error)} /></div> : null}
        <Field label="Display name" error={form.formState.errors.name?.message}><Input placeholder="Archive B2" {...form.register('name')} /></Field>
        <Field label="Provider" error={form.formState.errors.provider?.message}>
          <select className={selectClassName} {...form.register('provider')}><option value="r2">Cloudflare R2</option><option value="b2">Backblaze B2</option><option value="s3">Generic S3-compatible</option></select>
        </Field>
        {provider === 'r2' ? <Field label="Cloudflare account ID" error={form.formState.errors.accountId?.message}><Input autoComplete="off" {...form.register('accountId')} /></Field> : null}
        {provider === 's3' ? <Field label="HTTPS endpoint" error={form.formState.errors.endpoint?.message}><Input type="url" placeholder="https://s3.example.com" {...form.register('endpoint')} /></Field> : null}
        {provider !== 'r2' ? <Field label="Region" error={form.formState.errors.region?.message}><Input placeholder={provider === 'b2' ? 'us-west-004' : 'auto'} {...form.register('region')} /></Field> : (
          <Field label="Jurisdiction"><select className={selectClassName} {...form.register('jurisdiction')}><option value="">Default</option><option value="eu">EU</option><option value="fedramp">FedRAMP</option></select></Field>
        )}
        <Field label="Validation bucket" hint="An existing physical bucket this key can access." error={form.formState.errors.validationBucket?.message}><Input placeholder="openpool-smoke" {...form.register('validationBucket')} /></Field>
        <Field label={provider === 'b2' ? 'Key ID' : 'Access key ID'} error={form.formState.errors.accessKeyId?.message}><Input autoComplete="off" {...form.register('accessKeyId')} /></Field>
        <Field label={provider === 'b2' ? 'Application key' : 'Secret access key'} error={form.formState.errors.secretAccessKey?.message}><Input type="password" autoComplete="new-password" {...form.register('secretAccessKey')} /></Field>
        <Field label="Session token" hint="Optional for temporary S3 credentials."><Input type="password" autoComplete="off" {...form.register('sessionToken')} /></Field>
        <Field label="Priority" error={form.formState.errors.priority?.message}><Input inputMode="numeric" {...form.register('priority')} /></Field>
        <Field label="Capacity in bytes" hint={provider === 'r2' ? 'Required for R2 placement.' : 'Optional when usage is observable.'} error={form.formState.errors.capacityBytes?.message}><Input inputMode="numeric" placeholder="10737418240" {...form.register('capacityBytes')} /></Field>
        <div className="mt-2 flex justify-end gap-2 border-t border-zinc-100 pt-5 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>Cancel</Button>
          <Button type="submit" busy={mutation.isPending}>Create account</Button>
        </div>
      </form>
    </Dialog>
  );
}

function transitionLabel(status: PendingTransition['status']): string {
  if (status === 'DRAINING') return 'Begin draining';
  if (status === 'READ_ONLY') return 'Make read only';
  return 'Remove account';
}

function transitionDescription(status: PendingTransition['status']): string {
  if (status === 'DRAINING') return 'New placements will stop while existing objects remain available.';
  if (status === 'READ_ONLY') return 'The account will remain readable, but OpenPool will not write new objects to it.';
  return 'Removal succeeds only after all live shards, object locations, and reserved capacity are cleared.';
}
