# Changelog

All notable changes to OpenPool are documented in this file.

The project follows [Semantic Versioning](https://semver.org/). Until `1.0.0`, minor releases may contain breaking changes when they are clearly documented in release notes.

## [Unreleased]

### Added

- An isolated Cloudflare production environment with explicit D1 migration, Worker deployment, and production dry-run commands.

## [0.1.0] - 2026-09-07

### Added

- Public contribution guidance, structured issue forms, and a pull request template.
- A private vulnerability reporting path, GitHub secret scanning with push protection, and Dependabot security updates.
- An English security policy and project code of conduct.

### Changed

- Declared Cloudflare R2 and Backblaze B2 as the supported provider set for the first stable release.
- Kept the locally tested Generic S3 adapter as an unsupported experimental preview and removed it from the Web account creation flow.

### Validation

- Required pull-request CI passed linting, type checks, 726 tests, and all production builds.
- Real staging acceptance covers R2 and B2 browser transfers, CLI transfers up to 50 MB, upload recovery, scheduled maintenance, and cross-provider migration.
- The release check found no Dependabot alerts, secret-scanning alerts, or production dependency vulnerabilities.

## [0.1.0-rc.1] - 2026-09-04

### Added

- A Cloudflare Worker control plane and React administration console backed by D1.
- Single-administrator setup, password authentication, secure sessions, scoped API keys, authentication rate limiting, and deployment readiness checks.
- AES-256-GCM encrypted provider credentials with versioned envelopes.
- Cloudflare R2, Backblaze B2, and generic S3-compatible provider validation and SigV4 signed transfers.
- Logical buckets, storage shards, capacity-aware placement, provider health checks, and storage account lifecycle management.
- Direct object upload, completion, download, deletion, expiration cleanup, and explicit upload retry workflows.
- Transactional audit outbox processing and searchable audit logs.
- Account drain and client-mediated shard migration with streaming transfer and scheduled source cleanup.
- A workspace-private TypeScript SDK, object CLI, and shard migration CLI.
- English and Simplified Chinese administration console localization.

### Security

- Object bytes transfer directly between clients and providers and never proxy through the Worker.
- Provider credentials are encrypted at rest; API keys and session tokens are stored only as hashes.
- Control-plane request validation, stable error codes, safe request identifiers, and sensitive-response cache controls.

### Validation

- Local linting, type checks, tests, and builds passed through `npm run verify`.
- Real staging acceptance completed for Cloudflare R2 and Backblaze B2, including browser transfers, CLI transfers up to 50 MB, upload recovery, scheduled maintenance, and cross-provider migration.
- Generic S3 behavior was covered locally but did not receive an external-provider compatibility smoke test.

[Unreleased]: https://github.com/alwynou/openpool/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alwynou/openpool/compare/v0.1.0-rc.1...v0.1.0
[0.1.0-rc.1]: https://github.com/alwynou/openpool/releases/tag/v0.1.0-rc.1
