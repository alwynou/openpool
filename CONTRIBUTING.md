# Contributing to OpenPool

Thank you for helping improve OpenPool. The project is currently an early release candidate, so small, focused changes with clear tests and documentation are the easiest to review safely.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Open an issue before starting a substantial feature, provider integration, public API change, schema change, or architectural change.
- Small bug fixes, tests, and documentation corrections can go directly to a pull request.
- Never include credentials, API keys, session cookies, signed URLs, account IDs, private object names, or database exports in an issue, pull request, test fixture, screenshot, or log.

Security vulnerabilities follow a separate private process. Read [SECURITY.md](SECURITY.md) before reporting one.

## Development setup

OpenPool requires Node.js 22 or newer.

```bash
git clone https://github.com/alwynou/openpool.git
cd openpool
npm install
npm run dev:secrets
npm run db:migrate:local
npm run dev
```

The Web console runs at `http://localhost:5173`, and the Worker API runs at `http://localhost:8787`. Local secrets and Wrangler D1 state are ignored by Git. See the [local development guide](docs/development/getting-started.md) for initialization details.

## Architecture rules

Please preserve these project invariants:

- Object bytes never proxy through the Worker; clients use direct signed transfers.
- `packages/domain` imports no framework, platform, database, or provider SDK.
- Dependencies point inward: adapters → application → domain.
- Provider credentials are encrypted at rest; API keys and session tokens are hashed.
- Public API changes update `packages/contracts`, tests, and documentation together.
- Published D1 migrations are immutable; schema changes add a new migration.

Start with the [documentation index](docs/README.md). Changes involving architecture, providers, data storage, or deployment should also follow the relevant guide and accepted ADRs.

## Making a change

1. Create a non-`main` branch from the latest `main`.
2. Keep the change focused and avoid unrelated formatting or refactoring.
3. Add or update the narrowest relevant tests while iterating.
4. Update documentation when behavior, configuration, contracts, or operational requirements change.
5. Run the complete verification suite before handoff:

   ```bash
   npm run verify
   ```

Use Conventional Commits for commit messages, for example:

```text
feat: add provider health retry classification
fix: preserve upload retry capacity accounting
docs: clarify local D1 setup
```

## Pull requests

All changes reach `main` through a pull request. In the pull request description:

- explain the problem and the chosen solution;
- identify affected layers and public contracts;
- list the checks you ran;
- call out migrations, configuration changes, external dependencies, and deferred validation;
- include screenshots for visible Web changes when they materially help review.

The branch must be up to date with `main`, and the required `CI / Verify` check must pass before merge. Do not bypass or weaken branch protection.

## Database and deployment safety

Local development and tests must not rely on production or shared staging resources. Do not deploy, apply remote D1 migrations, rotate credentials, or run real-provider smoke tests as part of a pull request. Those operations require separate owner authorization and the applicable operations runbook.

When a schema change is necessary, add a new numbered migration and update the data model, tests, and deployment documentation. Never rewrite a migration that may already have been applied.

