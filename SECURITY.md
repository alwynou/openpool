# Security policy

## Supported versions

OpenPool is currently an early release candidate. Security fixes are applied to the latest release candidate and the current `main` branch. Older snapshots and prereleases are not maintained separately.

| Version | Supported |
| --- | --- |
| Latest release candidate | Yes |
| Current `main` branch | Yes |
| Older versions | No |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Do not publish provider credentials, OpenPool API keys, session cookies, signed URLs, Cloudflare account IDs, private object names, database exports, or logs containing real object metadata.

If GitHub shows a **Report a vulnerability** button on the repository's Security page, use it to submit a private report. If that option is unavailable, use the contact information on the [maintainer's GitHub profile](https://github.com/alwynou) to request a private reporting channel without including sensitive details in the initial message.

Once a private channel is established, include:

- the affected version or commit;
- the affected component and deployment context;
- reproduction steps or a minimal proof of concept;
- the expected and observed security impact;
- any suggested mitigation, if known.

Reports are handled on a best-effort basis. The maintainer will validate the issue, coordinate a fix and disclosure plan when appropriate, and credit the reporter unless anonymity is requested.

## Security scope

OpenPool is designed for a trusted, single-administrator deployment. Object bytes transfer directly between clients and storage providers; they must never be proxied through the Worker. Provider credentials must be bucket-scoped where possible and are encrypted at rest, while API keys and session tokens are stored only as hashes.

The project has not completed an independent security audit. Do not use it for critical or irreplaceable data without performing your own risk assessment, access review, backup planning, and recovery testing. See the [security model](docs/architecture/security.md) for the complete trust and credential boundaries.
