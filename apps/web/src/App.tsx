import type {
  AdministratorResponse,
  ApiEnvelope,
  HealthResponse,
  InitializeAdminRequest,
  LoginRequest,
  LoginResponse,
  SessionResponse,
  SetupStatusResponse,
} from '@openpool/contracts';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

type HealthState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly health: HealthResponse }
  | { readonly status: 'error' };

type AuthView =
  | 'loading'
  | 'setup'
  | 'login'
  | 'authenticated'
  | 'unavailable';

const fetchOptions = {
  credentials: 'same-origin' as const,
};

async function errorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'object' &&
      body.error !== null &&
      'message' in body.error &&
      typeof body.error.message === 'string' &&
      body.error.message.trim()
    ) {
      return body.error.message;
    }
  } catch {
    // Non-JSON error responses use the safe generic message below.
  }
  return 'Something went wrong. Please try again.';
}

async function loadSession(signal: AbortSignal): Promise<SessionResponse> {
  const response = await fetch('/api/v1/auth/session', {
    ...fetchOptions,
    signal,
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  const envelope = (await response.json()) as ApiEnvelope<SessionResponse>;
  return envelope.data;
}

export function App() {
  const [healthState, setHealthState] = useState<HealthState>({
    status: 'loading',
  });
  const [authView, setAuthView] = useState<AuthView>('loading');
  const [administrator, setAdministrator] =
    useState<AdministratorResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void fetch('/api/v1/health', {
      ...fetchOptions,
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Health check failed');
        return (await response.json()) as ApiEnvelope<HealthResponse>;
      })
      .then(({ data }) => setHealthState({ status: 'ready', health: data }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setHealthState({ status: 'error' });
        }
      });

    void fetch('/api/v1/setup/status', {
      ...fetchOptions,
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorMessage(response));
        return (await response.json()) as ApiEnvelope<SetupStatusResponse>;
      })
      .then(async ({ data }) => {
        if (!data.initialized) {
          setAuthView('setup');
          return;
        }

        const session = await loadSession(controller.signal);
        if (session.authenticated && session.administrator) {
          setAdministrator(session.administrator);
          setAuthView('authenticated');
        } else {
          setAuthView('login');
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setAuthView('unavailable');
        setMessage(
          error instanceof Error
            ? error.message
            : 'Unable to connect to OpenPool. Please try again.',
        );
      });

    return () => controller.abort();
  }, []);

  async function initialize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload: InitializeAdminRequest = {
      username: String(form.get('username') ?? ''),
      password: String(form.get('password') ?? ''),
    };
    const bootstrapToken = String(form.get('bootstrapToken') ?? '');

    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/v1/setup', {
        ...fetchOptions,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openpool-bootstrap-token': bootstrapToken,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      formElement.reset();
      setAuthView('login');
      setMessage('Setup complete. Sign in to continue.');
    } catch (error: unknown) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Setup failed. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload: LoginRequest = {
      username: String(form.get('username') ?? ''),
      password: String(form.get('password') ?? ''),
    };

    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/v1/auth/login', {
        ...fetchOptions,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const result = (await response.json()) as ApiEnvelope<LoginResponse>;
      formElement.reset();
      setAdministrator(result.data.administrator);
      setAuthView('authenticated');
    } catch (error: unknown) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Sign in failed. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/v1/auth/session', {
        ...fetchOptions,
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setAdministrator(null);
      setAuthView('login');
      setMessage('You have been signed out.');
    } catch (error: unknown) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Sign out failed. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const healthText =
    healthState.status === 'ready'
      ? `Control plane ${healthState.health.status}`
      : healthState.status === 'loading'
        ? 'Connecting…'
        : 'Control plane unavailable';

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="OpenPool home">
          <span className="brand-mark" aria-hidden="true">
            O
          </span>
          OpenPool
        </a>
        <span className={`health health--${healthState.status}`}>
          {healthText}
        </span>
      </header>

      <section className="hero">
        <p className="eyebrow">Cloudflare-native · Self-hosted</p>
        <h1>One namespace for every object store.</h1>
        <p className="lede">
          Connect R2, B2, and S3-compatible accounts to one storage pool while
          data moves directly between clients and providers.
        </p>
      </section>

      <section className="auth-card" aria-live="polite">
        {authView === 'loading' ? (
          <p className="auth-status">Checking access…</p>
        ) : authView === 'unavailable' ? (
          <div>
            <p className="card-label">Control plane</p>
            <h2>OpenPool is unavailable</h2>
          </div>
        ) : authView === 'setup' ? (
          <form onSubmit={(event) => void initialize(event)}>
            <p className="card-label">First-time setup</p>
            <h2>Create your administrator account</h2>
            <p className="form-help">
              The bootstrap token is used once and never stored in the browser.
            </p>
            <label>
              Username
              <input
                name="username"
                autoComplete="username"
                minLength={3}
                maxLength={64}
                required
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                required
              />
            </label>
            <label>
              Bootstrap token
              <input
                name="bootstrapToken"
                type="password"
                autoComplete="off"
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? 'Setting up…' : 'Initialize OpenPool'}
            </button>
          </form>
        ) : authView === 'login' ? (
          <form onSubmit={(event) => void login(event)}>
            <p className="card-label">Administrator access</p>
            <h2>Sign in to OpenPool</h2>
            <label>
              Username
              <input name="username" autoComplete="username" required />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        ) : (
          <div className="account">
            <div>
              <p className="card-label">Administrator</p>
              <h2>Welcome back, {administrator?.username}</h2>
              <p className="form-help">Your control plane is ready.</p>
            </div>
            <button
              type="button"
              className="button-secondary"
              onClick={() => void logout()}
              disabled={busy}
            >
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        )}

        {message ? (
          <p className="form-message" role="status">
            {message}
          </p>
        ) : null}
      </section>
    </main>
  );
}
