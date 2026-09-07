## Summary

<!-- Explain the problem and the outcome of this change. -->

## Changes

<!-- List the important implementation, contract, schema, UI, or documentation changes. -->

## Validation

<!-- List the exact checks you ran and any validation intentionally deferred. -->

## Checklist

- [ ] The branch is based on the latest `main`.
- [ ] Object bytes still transfer directly between clients and providers.
- [ ] Dependency direction remains adapters → application → domain.
- [ ] Relevant tests and documentation are included.
- [ ] Public API changes update `packages/contracts`, tests, and docs together.
- [ ] Schema changes use a new migration; published migrations are unchanged.
- [ ] No credentials, tokens, signed URLs, account IDs, private data, or local D1 state are included.
- [ ] Remote migrations, deployments, and real-provider tests are documented as separate authorized operations.

