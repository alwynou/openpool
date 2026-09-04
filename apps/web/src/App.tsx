import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { CircleNotchIcon } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { CloudCheckIcon } from '@phosphor-icons/react/dist/csr/CloudCheck';
import { LockKeyIcon } from '@phosphor-icons/react/dist/csr/LockKey';
import type { AdministratorResponse, HealthResponse, SessionResponse, SetupStatusResponse } from '@openpool/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { toast } from 'sonner';

import { api } from './api';
import { AppShell, Brand } from './components/app-shell';
import { LanguageSelect } from './components/language-select';
import { Button, Field, Input } from './components/ui';
import { useI18n } from './i18n';
import { errorText } from './lib/utils';
import { queryKeys } from './queries';

const AccountsPage = lazy(() => import('./pages/accounts-page').then((module) => ({ default: module.AccountsPage })));
const ApiKeysPage = lazy(() => import('./pages/api-keys-page').then((module) => ({ default: module.ApiKeysPage })));
const AuditPage = lazy(() => import('./pages/audit-page').then((module) => ({ default: module.AuditPage })));
const BucketsPage = lazy(() => import('./pages/buckets-page').then((module) => ({ default: module.BucketsPage })));
const FilesPage = lazy(() => import('./pages/files-page').then((module) => ({ default: module.FilesPage })));
const OverviewPage = lazy(() => import('./pages/overview-page').then((module) => ({ default: module.OverviewPage })));

type AccessState =
  | { readonly view: 'setup' }
  | { readonly view: 'login' }
  | { readonly view: 'authenticated'; readonly administrator: AdministratorResponse };

async function loadAccess(): Promise<AccessState> {
  const setup: SetupStatusResponse = await api.setupStatus();
  if (!setup.initialized) return { view: 'setup' };
  const session: SessionResponse = await api.session();
  if (session.authenticated && session.administrator) {
    return { view: 'authenticated', administrator: session.administrator };
  }
  return { view: 'login' };
}

export function App() {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [message, setMessage] = useState<string | null>(null);
  const healthQuery = useQuery<HealthResponse>({ queryKey: queryKeys.health, queryFn: api.health, retry: false });
  const accessQuery = useQuery<AccessState>({ queryKey: queryKeys.access, queryFn: loadAccess, retry: false });
  const setupMutation = useMutation({
    mutationFn: ({ username, password, token }: { username: string; password: string; token: string }) => api.setup(username, password, token),
    onSuccess: () => {
      queryClient.setQueryData<AccessState>(queryKeys.access, { view: 'login' });
      setMessage('Setup complete. Sign in to continue.');
    },
    onError: (error) => setMessage(errorText(error)),
  });
  const loginMutation = useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) => api.login(username, password),
    onSuccess: (result) => {
      const nextAccess: AccessState = { view: 'authenticated', administrator: result.administrator };
      queryClient.setQueryData<AccessState>(queryKeys.access, nextAccess);
      setMessage(null);
    },
    onError: (error) => setMessage(errorText(error)),
  });
  const logoutMutation = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData<AccessState>(queryKeys.access, { view: 'login' });
      setMessage('You have been signed out.');
    },
    onError: (error) => toast.error(t('Sign out failed'), { description: errorText(error) }),
  });

  if (accessQuery.isLoading) return <AccessLoading health={healthQuery.data ?? null} />;
  if (accessQuery.error) return <AuthScreen health={healthQuery.data ?? null} unavailableMessage={errorText(accessQuery.error)} />;
  const access = accessQuery.data;
  if (!access || access.view !== 'authenticated') {
    return (
      <AuthScreen
        health={healthQuery.data ?? null}
        view={access?.view ?? 'login'}
        message={message}
        busy={setupMutation.isPending || loginMutation.isPending}
        onSetup={(username, password, token) => setupMutation.mutate({ username, password, token })}
        onLogin={(username, password) => loginMutation.mutate({ username, password })}
      />
    );
  }

  return (
    <AppShell administrator={access.administrator} health={healthQuery.data ?? null} onLogout={() => logoutMutation.mutate()} logoutBusy={logoutMutation.isPending}>
      <Suspense fallback={<div className="grid min-h-80 place-items-center"><CircleNotchIcon className="size-5 animate-spin text-zinc-400" aria-label={t('Loading page')} /></div>}>
        <Routes>
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/buckets" element={<BucketsPage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/api-keys" element={<ApiKeysPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

function AccessLoading({ health }: { readonly health: HealthResponse | null }) {
  const { t } = useI18n();
  return (
    <div className="min-h-screen bg-white">
      <AuthHeader health={health} />
      <div className="grid min-h-[calc(100vh-70px)] place-items-center px-5"><div className="text-center"><CircleNotchIcon className="mx-auto size-6 animate-spin text-zinc-500" aria-hidden /><p className="mt-3 text-sm text-zinc-500">{t('Checking access…')}</p></div></div>
    </div>
  );
}

function AuthScreen({
  health,
  view = 'login',
  message,
  unavailableMessage,
  busy = false,
  onSetup,
  onLogin,
}: {
  readonly health: HealthResponse | null;
  readonly view?: 'setup' | 'login';
  readonly message?: string | null;
  readonly unavailableMessage?: string;
  readonly busy?: boolean;
  readonly onSetup?: ((username: string, password: string, token: string) => void) | undefined;
  readonly onLogin?: ((username: string, password: string) => void) | undefined;
}) {
  const { t } = useI18n();
  return (
    <div className="min-h-screen bg-zinc-50/50">
      <AuthHeader health={health} />
      <main className="mx-auto grid min-h-[calc(100vh-70px)] max-w-6xl items-center gap-12 px-5 py-12 lg:grid-cols-[1fr_460px] lg:px-8">
        <section className="max-w-xl">
          <span className="inline-flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-600"><CloudCheckIcon className="size-4" aria-hidden />{t('Cloudflare-native · Self-hosted')}</span>
          <h1 className="mt-7 text-5xl font-semibold tracking-[-0.055em] text-zinc-950 sm:text-6xl">{t('One namespace for every object store.')}</h1>
          <p className="mt-6 max-w-lg text-base leading-7 text-zinc-500">{t('Connect R2, B2, and S3-compatible storage to one control plane while object bytes move directly between clients and providers.')}</p>
        </section>
        {unavailableMessage ? (
          <section className="rounded-lg border border-zinc-200 bg-white p-7 shadow-sm"><LockKeyIcon className="size-6 text-zinc-500" aria-hidden /><h2 className="mt-5 text-xl font-semibold text-zinc-950">{t('OpenPool is unavailable')}</h2><p className="mt-2 text-sm leading-6 text-zinc-500">{t(unavailableMessage)}</p></section>
        ) : (
          <AuthCard view={view} busy={busy} message={message ?? null} onSetup={onSetup} onLogin={onLogin} />
        )}
      </main>
    </div>
  );
}

function AuthHeader({ health }: { readonly health: HealthResponse | null }) {
  const { t } = useI18n();
  return <header className="flex h-[70px] items-center justify-between border-b border-zinc-200 bg-white px-5 sm:px-8"><Brand /><div className="flex items-center gap-3"><LanguageSelect compact /><span className="hidden items-center gap-2 text-xs font-medium text-zinc-500 sm:inline-flex"><span className={`size-2 rounded-full ${health ? 'bg-zinc-950' : 'bg-zinc-300'}`} />{health ? t('Control plane {{status}}', { status: health.status }) : t('Control plane unavailable')}</span></div></header>;
}

function AuthCard({
  view,
  busy,
  message,
  onSetup,
  onLogin,
}: {
  readonly view: 'setup' | 'login';
  readonly busy: boolean;
  readonly message: string | null;
  readonly onSetup?: ((username: string, password: string, token: string) => void) | undefined;
  readonly onLogin?: ((username: string, password: string) => void) | undefined;
}) {
  const { t } = useI18n();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username') ?? '');
    const password = String(form.get('password') ?? '');
    if (view === 'setup') onSetup?.(username, password, String(form.get('bootstrapToken') ?? ''));
    else onLogin?.(username, password);
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-7 shadow-sm">
      <p className="text-xs font-semibold tracking-[0.08em] text-zinc-500 uppercase">{t(view === 'setup' ? 'First-time setup' : 'Administrator access')}</p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-950">{t(view === 'setup' ? 'Create your administrator' : 'Sign in to OpenPool')}</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-500">{t(view === 'setup' ? 'The bootstrap token is read once and never stored in the browser.' : 'Use the administrator credentials configured for this control plane.')}</p>
      <form className="mt-6 grid gap-4" onSubmit={submit}>
        <Field label={t('Username')}><Input name="username" autoComplete="username" minLength={view === 'setup' ? 3 : undefined} required /></Field>
        <Field label={t('Password')}><Input name="password" type="password" autoComplete={view === 'setup' ? 'new-password' : 'current-password'} minLength={view === 'setup' ? 12 : undefined} maxLength={256} required /></Field>
        {view === 'setup' ? <Field label={t('Bootstrap token')}><Input name="bootstrapToken" type="password" autoComplete="off" required /></Field> : null}
        {message ? <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs leading-5 text-zinc-700" role="status">{t(message)}</p> : null}
        <Button type="submit" className="mt-1 w-full" busy={busy}>{t(view === 'setup' ? 'Initialize OpenPool' : 'Sign in')}<ArrowRightIcon className="size-4" aria-hidden /></Button>
      </form>
    </section>
  );
}
