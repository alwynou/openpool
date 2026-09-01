# OpenPool agent guide

## Start here

1. Read `README.md` and `docs/development/workflow.md`.
2. Read only the task-specific documents below before changing code.

| Task                       | Read next                                                          |
| -------------------------- | ------------------------------------------------------------------ |
| Domain, placement, uploads | `docs/architecture/overview.md`, `docs/architecture/boundaries.md` |
| D1 schema or repositories  | `docs/architecture/data-model.md`, `database/README.md`            |
| Provider integration       | `docs/providers/README.md`, `docs/architecture/security.md`        |
| Worker, assets, deploy     | `docs/operations/cloudflare.md`                                    |
| Scope or sequencing        | `docs/roadmap.md`, relevant ADR in `docs/architecture/decisions/`  |

## Non-negotiable invariants

- Object bytes never proxy through the Worker; use direct signed transfers.
- `packages/domain` imports no framework, platform, database, or provider SDK.
- Dependencies point inward: adapters → application → domain.
- Provider credentials are encrypted at rest; API keys and session tokens are hashed.
- Public API changes update `packages/contracts`, tests, and docs together.
- Published migrations are immutable; schema changes use a new migration.

## Commands

```bash
npm run dev
npm run test
npm run typecheck
npm run verify
```

Run the narrowest relevant check while iterating and `npm run verify` before handoff.
Do not deploy or run remote D1 migrations unless the user explicitly asks.
