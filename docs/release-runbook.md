# Lenso release runbook for operators and agents

This is the authoritative operational guide for coordinated releases across the
Lenso framework repositories. Use it before editing versions, creating a release
plan, dispatching a publisher, changing release infrastructure, or diagnosing a
stalled release.

The workflow files and schemas remain executable truth. If this document and the
code disagree, stop, report the mismatch, and update this document in the same
change as the code. Do not silently infer a new procedure.

## Safety rules

- Treat registry publication, immutable tags, GitHub Releases, channel promotion,
  and release-mode changes as production writes that require explicit approval.
- Repository write access is not production authority.
- Keep `LENSO_RELEASE_MODE=shadow` until a complete shadow release has passed and
  production activation has been approved explicitly.
- Never add long-lived npm, crates.io, personal access, or GitHub App credentials
  to a repository. Production publishers use short-lived OIDC or installation
  credentials.
- Never enable a legacy direct-publish workflow as a normal release path.
- Never weaken plan, digest, exact-ref, nonce, preflight, receipt, or attestation
  checks to make a release pass.
- Never claim success from a workflow alone. Verify the registry or release API and
  the coordinator receipt.

## Responsibilities

| System | Responsibility |
| --- | --- |
| Tegami | Records release intent and proposes deterministic version and changelog changes. It does not publish. |
| Component repository | Builds and tests exact artifacts, owns registry OIDC, publishes, and emits a signed receipt. |
| `lenso-release` | Validates intent and GitHub facts, coordinates exact refs, consumes one-use proofs, and reconciles receipts. It has no registry credential. |
| GitHub App | Creates release PRs and exact execution refs and dispatches narrowly scoped repository workflows. |
| Shadow Gateway | Emulates npm, Cargo, GitHub Release/tag, and attestation APIs using isolated R2 and D1 state. It never forwards an artifact to production. |
| Catalog worker | Mirrors immutable release records and moves reviewed channel pointers. |

The participating component repositories are `lenso`, `lenso-cli`,
`lenso-runtime-console`, `lenso-auth-module`, `lenso-audit-log-module`, and
`lenso-organization-module`.

## Normal reviewed release

1. Add or update reviewed intent under `.tegami/` in the component repository and
   merge it to `main`. The intent must name only the packages meant to change.
2. A change to `.tegami/**`, `.lenso-release/**`, or package manifests triggers
   `.github/workflows/release-plan.yml`.
3. If no merged plan exists, the repository-local runtime drafts and applies the
   Tegami changes, writes the canonical plan, and creates or updates the single
   `release/<repository>` pull request.
4. Review the PR's versions, dependency order, changelogs, exact source and release
   commits, package set, generated lock, plan digest, and CI evidence. A changed
   plan invalidates prior approval.
5. Merge the reviewed release PR. The plan workflow emits an authenticated ready
   event to the coordinator.
6. The coordinator re-reads GitHub facts, validates the plan and component catalog,
   consumes a one-use nonce, creates the protected exact execution ref, and
   dispatches the component's `.github/workflows/publish.yml` with the exact plan
   ID, digest, commit, package set, and nonce.
7. The component publisher checks its mode and endpoints, checks out the exact
   release commit, rebuilds the artifacts, completes fail-closed preflight, consumes
   the proof atomically, then publishes only the packages in the plan.
8. The publisher verifies remote artifacts and submits a signed receipt and
   attestation. The coordinator advances state only after verifying that evidence.
9. Completed component receipts form an immutable system candidate. Promotion to a
   system release and movement of `stable` or `next` are separate reviewed actions.

Do not manually dispatch `publish.yml`. Its inputs are coordinator-issued evidence,
not operator-authored release parameters.

## Shadow mode

Shadow mode is the default until production activation is approved. Each component
repository must have:

```text
LENSO_RELEASE_MODE=shadow
LENSO_SHADOW_NPM_REGISTRY_URL=https://lenso-release-shadow-gateway.lenso.workers.dev/npm
LENSO_SHADOW_CRATES_API_URL=https://lenso-release-shadow-gateway.lenso.workers.dev/cargo
LENSO_SHADOW_CRATES_UPLOAD_URL=https://lenso-release-shadow-gateway.lenso.workers.dev/cargo/api/v1/crates/new
LENSO_SHADOW_GITHUB_API_URL=https://lenso-release-shadow-gateway.lenso.workers.dev/github
LENSO_SHADOW_ATTESTATION_URL=https://lenso-release-shadow-gateway.lenso.workers.dev/attestations
```

`LENSO_SHADOW_NPM_TOKEN` and `LENSO_SHADOW_CARGO_TOKEN` are repository secrets.
Agents may check that a secret name exists but must never print or retrieve its
value. A successful shadow release must prove exact npm and Cargo bytes, GitHub
release assets or annotated tags where applicable, attestation retrieval, receipt
acceptance, and idempotent retry behavior.

The Shadow Gateway health endpoint is:

```text
https://lenso-release-shadow-gateway.lenso.workers.dev/health
```

## Coordinator configuration

The reviewed flow is not operational until every participating component has the
app identity, shadow endpoints, and these five coordinator values (four URLs and one
authority public key):

```text
LENSO_COORDINATOR_READY_URL
LENSO_COORDINATOR_PREFLIGHT_URL
LENSO_COORDINATOR_PREFLIGHT_CONSUME_URL
LENSO_COORDINATOR_RECEIPT_URL
LENSO_PREFLIGHT_AUTHORITY_PUBLIC_KEY
```

The coordinator repository needs its GitHub App ID, installation ID, private key,
actor, and production facts adapter. Absence of any required endpoint or authority
key is a configuration blocker, not permission to bypass preflight.

Before starting a release, inspect current configuration rather than trusting this
document's last-known state:

```sh
gh variable list --repo LioRael/<repository>
gh secret list --repo LioRael/<repository>
gh workflow list --repo LioRael/<repository> --all
```

Secret listings expose names only. Do not print values.

## Production activation

Production activation requires all of the following:

1. A complete shadow release for the same publisher revision and package shapes.
2. Configured and reachable coordinator endpoints and authority public key.
3. Registry trusted publishers or crates.io trusted publishing configured for every
   package in the plan.
4. Exact remote verification and receipt recovery tested without a long-lived token.
5. Explicit approval to change the named repositories to
   `LENSO_RELEASE_MODE=production` and publish the named versions.

Change release mode only in the repositories named by the approval. Verify the
variables after the change. Production mode uses public npm, crates.io, GitHub, and
attestation endpoints; it must not receive shadow tokens.

## First publication of a new npm package

npm trusted publishing may require a package to exist before its trusted publisher
can be configured. For a genuinely new package:

1. Run the same package-readiness, build, pack, and dry-run gates used by the
   repository publisher.
2. Confirm the npm scope, package name, version, public access, tarball contents,
   and integrity.
3. Obtain explicit approval for the one-time production publication.
4. Authenticate through npm's official web login. The human operator completes
   passwords, passkeys, security keys, or 2FA; agents must not request or handle
   them.
5. Publish only the reviewed tarball with `--access public`.
6. Verify the version and `dist.integrity` from the public npm registry.
7. Configure the package's repository/workflow trusted publisher before its next
   release, then return to the normal reviewed flow.

Registry metadata can lag. A successful CLI response is not sufficient evidence;
wait until unauthenticated public metadata and installation both succeed.

## Receipts, retries, and recovery

Publishing and receipt delivery are separate states. Do not republish an immutable
version because receipt delivery failed.

- Component publishing is idempotent against the exact plan and artifact digest.
- `lenso-release/.github/workflows/recover-receipts.yml` runs hourly and may also be
  dispatched manually.
- Recovery re-reads remote registry or GitHub state, matches exact digests, and
  submits the missing receipt. It never invents evidence or overwrites a version.
- If remote bytes differ from the plan, stop and treat it as a supply-chain incident.
- If a release partially published, record exactly which immutable artifacts exist
  before deciding whether recovery can continue.

## Break-glass publishing

Break-glass publishing is an exception, not an alternate workflow. Use it only when
the user explicitly approves the named production packages and the reviewed control
plane cannot perform the release.

1. Record the coordinator blocker and confirm package versions do not already exist.
2. Run the repository's complete readiness and dry-run gates from the exact commit.
3. Prefer the existing trusted-publisher workflow. Enable a disabled legacy workflow
   only for the bounded operation and disable it immediately afterward.
4. Never add a token fallback to repository code or secrets.
5. Verify every artifact through its public API and fresh installation or download.
6. Reconcile lockfile integrity against the published tarball where consumers pin it.
7. Record the exception and return the repository to its prior workflow and release
   mode state.

## Agent completion checklist

An agent may report a release complete only when all applicable items are true:

- the approved package set and versions match the plan;
- release-plan and publisher checks passed at the exact commits;
- remote npm, crates.io, or GitHub metadata exists publicly;
- downloaded bytes or registry integrity match the reviewed artifacts;
- receipt and attestation were accepted or recovery is explicitly pending;
- temporary workflow or mode changes were restored;
- consumer lockfiles use the actual immutable registry integrity;
- downstream integration CI passed;
- the release PR and any required consumer PR are merged.

If one item is false, report the release as partial and name the blocker.

## Implementation references

- [`README.md`](../README.md): control-plane boundaries and release model.
- [`docs/github-app.md`](github-app.md): App permissions, protected execution refs,
  OIDC, event authentication, and replay protection.
- [`config/components.yaml`](../config/components.yaml): participating component
  catalog and dependency order.
- [`schemas/`](../schemas/): event, plan, state, receipt, reconciliation, candidate,
  channel, and release contracts.
- [`.github/workflows/plan-ready.yml`](../.github/workflows/plan-ready.yml): ready
  event receiver.
- [`.github/workflows/publish-receipt.yml`](../.github/workflows/publish-receipt.yml):
  receipt receiver.
- [`.github/workflows/recover-receipts.yml`](../.github/workflows/recover-receipts.yml):
  scheduled recovery.
- [`shadow-gateway/`](../shadow-gateway/): isolated registry, release, and
  attestation emulator.
