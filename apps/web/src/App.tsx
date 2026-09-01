import type { ApiEnvelope, HealthResponse } from '@openpool/contracts';
import { useEffect, useState } from 'react';

type HealthState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly health: HealthResponse }
  | { readonly status: 'error' };

export function App() {
  const [healthState, setHealthState] = useState<HealthState>({
    status: 'loading',
  });

  useEffect(() => {
    const controller = new AbortController();

    void fetch('/api/v1/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Health check failed: ${response.status}`);
        }

        return (await response.json()) as ApiEnvelope<HealthResponse>;
      })
      .then(({ data }) => setHealthState({ status: 'ready', health: data }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setHealthState({ status: 'error' });
      });

    return () => controller.abort();
  }, []);

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
          {healthState.status === 'ready'
            ? `Control plane ${healthState.health.status}`
            : healthState.status === 'loading'
              ? 'Connecting…'
              : 'Control plane unavailable'}
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

      <section className="grid" aria-label="OpenPool architecture summary">
        <article className="card card--primary">
          <p className="card-label">Storage pool</p>
          <strong>Ready for providers</strong>
          <span>The control-plane foundation is running.</span>
        </article>
        <article className="card">
          <p className="card-label">Control plane</p>
          <strong>Worker + D1</strong>
          <span>Metadata, policy, API keys, and audit history.</span>
        </article>
        <article className="card">
          <p className="card-label">Data plane</p>
          <strong>Direct transfer</strong>
          <span>Presigned URLs keep object bytes out of the Worker.</span>
        </article>
      </section>
    </main>
  );
}
