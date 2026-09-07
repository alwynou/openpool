<p align="center">
  <img src="apps/web/public/openpool-logo.png" alt="OpenPool logo" width="144" />
</p>

<h1 align="center">OpenPool</h1>

<p align="center">
  A self-hosted, Cloudflare-native control plane for object storage.
</p>

<p align="center">
  <a href="https://github.com/alwynou/openpool/actions/workflows/ci.yml"><img src="https://github.com/alwynou/openpool/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://github.com/alwynou/openpool/releases"><img src="https://img.shields.io/github/v/release/alwynou/openpool?include_prereleases" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/alwynou/openpool" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22 or newer" />
</p>

OpenPool combines Cloudflare R2 and Backblaze B2 storage accounts that you already own into one logical object pool. It provides a unified namespace, placement decisions, credential management, an administration console, and an API.

OpenPool is a control plane, not an object proxy. Clients upload and download bytes directly from the selected provider through short-lived signed URLs, so object payloads never pass through the Worker.

## Features

- Cloudflare Worker API and React administration console, served as one deployment
- Cloudflare D1 metadata store with append-only schema migrations
- Cloudflare R2 and Backblaze B2 provider adapters built on a shared SigV4 foundation
- Logical buckets, storage shards, capacity-aware placement, and provider health checks
- Direct signed uploads and downloads with explicit reservation, completion, retry, and cleanup states
- AES-256-GCM encryption for provider credentials at rest
- Single-administrator authentication, scoped API keys, rate limiting, and deployment readiness checks
- Transactional audit outbox with searchable audit logs
- Account drain and client-mediated shard migration between providers
- English and Simplified Chinese administration UI
- TypeScript SDK and object CLI for API-key-authenticated workflows

## Architecture

```text
Browser / SDK / CLI ── control API ──> Cloudflare Worker ──> D1
         │                                  │
         └────── object bytes ──────────────┴────> R2 / B2
```

The codebase follows ports and adapters. Dependencies point inward:

```text
adapters  →  application  →  domain
```

The domain package has no framework, platform, database, or provider SDK dependencies. Public API shapes live in `packages/contracts`; database rows and provider SDK types do not cross that boundary. See the [architecture overview](docs/architecture/overview.md) and [dependency boundaries](docs/architecture/boundaries.md) for details.

## Project status

OpenPool `v0.1.0` is the first stable project release. See the [release notes](docs/releases/v0.1.0.md) and [GitHub Release](https://github.com/alwynou/openpool/releases/tag/v0.1.0).

The core V1 control plane has passed local verification and staging acceptance against real R2 and B2 resources, including browser-direct transfers, API keys, auditing, scheduled cleanup, upload recovery, and cross-provider shard migration. An isolated production control plane is deployed at `openpool.alwynou.com` and has passed database, readiness, bootstrap, administrator-session, and real browser-direct R2/B2 transfer acceptance. Automated deployment remains an operator-managed follow-up.

For the exact completion state and remaining work, see the [roadmap](docs/roadmap.md) and [V1 acceptance checklist](docs/development/v1-acceptance.md).

Notable project changes are recorded in the [changelog](CHANGELOG.md).

## Quick start

### Prerequisites

- Node.js 22 or newer
- npm

### Run locally

```bash
git clone https://github.com/alwynou/openpool.git
cd openpool
npm install
npm run dev:secrets
npm run db:migrate:local
npm run dev
```

Open the administration console at [http://localhost:5173](http://localhost:5173). The Worker API runs at [http://localhost:8787](http://localhost:8787), and Vite proxies local `/api` requests to it.

Local development uses an ignored Wrangler D1 database and an ignored `apps/worker/.dev.vars` file. Read the [local development guide](docs/development/getting-started.md) before initializing the administrator or adding a provider.

## Repository layout

```text
apps/worker/          Cloudflare Worker, HTTP adapters, and composition root
apps/web/             React administration console
apps/migrator/        Streaming shard migration CLI
apps/cli/             API-key-authenticated object CLI
packages/domain/      Pure domain model and placement rules
packages/application/ Use cases and ports
packages/contracts/   Shared public API contracts
packages/sdk/         TypeScript API client (private preview)
database/migrations/  Append-only D1 migrations
docs/                 Architecture, development, provider, and operations guides
```

Start with the [documentation index](docs/README.md).

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the Worker and Web console locally |
| `npm run test:web` | Run the Web test suite |
| `npm run test` | Run all test suites |
| `npm run lint` | Run Oxlint |
| `npm run typecheck` | Type-check every workspace |
| `npm run build` | Build the Web app, Worker, migrator, and CLI |
| `npm run verify` | Run linting, type checks, tests, and builds |

Run `npm run verify` before handing off a change. The GitHub Actions workflow runs the same command on pull requests and can also be started manually. It has read-only repository access, receives no Cloudflare secrets, and never deploys or applies database migrations.

Changes reach the protected `main` branch through pull requests with an up-to-date, successful `CI / Verify` check. See the [development workflow](docs/development/workflow.md) before contributing.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, architecture boundaries, testing expectations, commit conventions, and the pull request process. Please use the repository's issue forms for reproducible bugs and focused feature proposals.

Security vulnerabilities must be reported privately according to [SECURITY.md](SECURITY.md), never through a public issue.

## Deployment

OpenPool runs as a Cloudflare Worker with Static Assets and D1. Provider credentials and application secrets must be configured separately for each environment.

The repository includes isolated `staging` and `production` Wrangler environments. Remote D1 migrations and deployments remain explicit operations: use `npm run db:migrate:production` and `npm run deploy:production` only after checking the Cloudflare account, database, secrets, backup requirements, and maintenance window. Follow the [Cloudflare operations runbook](docs/operations/cloudflare.md) for the complete procedure and rollback guidance.

## Security

- Object bytes transfer directly between the client and storage provider.
- Provider credentials are encrypted at rest and are never returned by the API.
- API keys and session tokens are stored only as hashes.
- Signed URLs, raw credentials, authorization headers, and session cookies must not enter logs or audit metadata.
- Provider credentials should be limited to the intended bucket and minimum required operations.

OpenPool is designed for a trusted, single-administrator deployment. Review the complete [security model](docs/architecture/security.md) before exposing an instance or supplying provider credentials.

Please report security issues privately to the maintainer instead of opening a public issue with credentials, signed URLs, or other sensitive data.

## Current limitations

Generic S3 adapter code remains an experimental preview and is not part of the `v0.1.0` supported provider set or Web account creation flow. OpenPool also does not yet provide a full S3-compatible gateway, multipart resumable uploads, automatic replication or repair, multi-user tenancy, billing, or fine-grained RBAC. The TypeScript SDK and object CLI are workspace-private previews and are not published npm packages.

## Documentation

- [Documentation index](docs/README.md)
- [Changelog](CHANGELOG.md)
- [`v0.1.0` release notes](docs/releases/v0.1.0.md)
- [Architecture overview](docs/architecture/overview.md)
- [Local development](docs/development/getting-started.md)
- [Provider integration](docs/providers/README.md)
- [Object CLI](docs/cli/objects.md)
- [TypeScript SDK](docs/sdk/typescript.md)
- [Cloudflare operations](docs/operations/cloudflare.md)
- [Roadmap](docs/roadmap.md)
- [V1 acceptance checklist](docs/development/v1-acceptance.md)

## License

OpenPool is available under the [MIT License](LICENSE).
