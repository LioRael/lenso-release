# Lenso Release Control Plane

This repository is the public, non-privileged control plane for coordinated Lenso releases. It validates release intent, computes deterministic dependency-aware plans, records state, and verifies component receipts. It does not publish production artifacts directly and it contains no production credentials.

## Tool boundaries

- **Tegami 1.2.5** captures release intent, proposes package versions and changelog entries, and contributes to the tracked release lock. It never publishes production artifacts.
- **This control plane** validates public contracts, builds canonical plans, coordinates exact-ref component workflows, reconciles receipts, and produces immutable system-candidate/release records.
- **Component repositories** own builds, tests, provenance, registry publishing, and signed release receipts.
- **The catalog worker** mirrors immutable release records and maintains the mutable `stable` and `next` channel pointers.

Production authentication belongs to component repositories and uses short-lived OIDC credentials. Do not add registry tokens, GitHub App private keys, or other production secrets to this repository.

## Local development

Prerequisites:

- Node.js 24
- Corepack
- pnpm 11.7.0 (pinned by `packageManager`)

```sh
corepack enable
corepack pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Useful commands:

```sh
pnpm test
pnpm typecheck
pnpm reconcile -- --help
```

Generated build output is written to `dist/` and is not committed.

## Release model

1. A repository's release intent describes the requested package change.
2. The coordinator validates that intent against the public schemas and component catalog.
3. A canonical release plan fixes component versions, exact source refs, dependency order, policy, and a plan digest.
4. Plan state advances only from authenticated ready events and verified publication receipts.
5. Completed component receipts form an immutable system candidate. A reviewed promotion produces an immutable system release; the mutable `stable` pointer moves last using compare-and-swap semantics.

The schemas in [`schemas/`](schemas/) are the public wire contracts for release events, plans, state, receipts, reconciliation, framework locks, candidates, channels, and releases. [`config/components.yaml`](config/components.yaml) is the reviewed component catalog.

## Security

See [SECURITY.md](SECURITY.md). Never report a vulnerability or paste credentials into a public issue.
