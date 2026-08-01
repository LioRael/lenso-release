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
- Never add long-lived npm, personal access, or GitHub App credentials to a
  repository. Production publishers use short-lived OIDC or installation
  credentials. A crates.io API token is permitted only for the initial publish of
  an exact package/version listed in the reviewed release commit's
  `.lenso-release/cargo-bootstrap.json`; remove that entry and the token after
  Trusted Publishing is configured.
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
| Shadow Gateway | Emulates npm, Cargo, OCI Distribution, GitHub Release/tag, and attestation APIs using isolated R2 and D1 state. It never forwards an artifact to production. |
| Catalog worker | Mirrors immutable release records and moves reviewed channel pointers. |

The participating component repositories are `lenso`, `lenso-cli`,
`lenso-console`, `lenso-auth-module`, `lenso-audit-log-module`, and
`lenso-organization-module`.

## Normal reviewed release

1. Add or update reviewed intent under `.tegami/` in the component repository and
   merge it to `main`. The intent must name only the packages meant to change.
2. A change to `.tegami/**`, `.lenso-release/**`, or package manifests triggers
   `.github/workflows/release-plan.yml`.
3. When reviewed intent exists, the repository-local runtime drafts and applies
   the Tegami changes, writes the canonical plan, and creates or updates the single
   `release/<repository>` pull request. Fresh intent takes precedence over a
   retained plan from an earlier release; the new plan replaces it atomically in
   the release PR. A merged plan emits a ready event only when no newer intent
   remains.
4. Review the PR's versions, dependency order, changelogs, exact source and release
   commits, package set, generated lock, plan digest, and CI evidence. A changed
   plan invalidates prior approval.
5. Merge the reviewed release PR. The plan workflow emits an authenticated ready
   event to the coordinator. The event binds the reviewed repository release mode;
   the coordinator rejects it unless that mode exactly matches its own environment.
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

### First Cargo publication

crates.io requires an API token for a crate's initial publication because Trusted
Publishing can only be configured after the crate exists. The bootstrap exception
remains inside the normal reviewed release:

1. Add only the new package and exact version to
   `.lenso-release/cargo-bootstrap.json` in the component release commit.
   A zero-write recovery of an older immutable release commit instead uses
   `.lenso-release/cargo-bootstrap-recovery.json` from the reviewed recovery
   workflow commit, bound to that exact plan ID and release commit.
2. Keep the API token in the existing `CARGO_REGISTRY_TOKEN` repository secret.
   The publisher exposes it only to the receipt-confirming publish step and selects
   it only for an exact policy match; all other Cargo packages use the OIDC token.
3. Publish through the coordinator-issued exact execution ref. Never dispatch the
   repository publisher directly.
4. Configure Trusted Publishing for the newly created crate, verify an OIDC
   publication or recovery path, then remove the policy entry and repository
   secret. A retained bootstrap exception blocks release closure.

For OCI components, the coordinator also persists the reviewed `registryPath` in
the immutable package state. Repository preflight must match its local OCI
configuration to that path, and proof consumption must reject any artifact whose
registry destination differs. This comparison happens before registry upload;
receipt-time observation is not a substitute for destination authorization.

## Shadow mode

Shadow mode is the default until production activation is approved. Each component
repository must have:

```text
LENSO_RELEASE_MODE=shadow
LENSO_SHADOW_NPM_REGISTRY_URL=https://lenso-release-shadow-gateway.lenso.workers.dev/npm
LENSO_SHADOW_CRATES_API_URL=https://lenso-release-shadow-gateway.lenso.workers.dev/cargo
LENSO_SHADOW_CRATES_UPLOAD_URL=https://lenso-release-shadow-gateway.lenso.workers.dev/cargo/api/v1/crates/new
LENSO_SHADOW_GITHUB_API_URL=https://lenso-release-shadow-gateway.lenso.workers.dev/github
LENSO_SHADOW_OCI_REGISTRY_URL=https://lenso-release-shadow-gateway.lenso.workers.dev/oci
LENSO_SHADOW_ATTESTATION_URL=https://lenso-release-shadow-gateway.lenso.workers.dev/attestations
```

`LENSO_SHADOW_NPM_TOKEN`, `LENSO_SHADOW_CARGO_TOKEN`, and
`LENSO_SHADOW_OCI_TOKEN` are repository secrets.
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

After both modes are verified as `production`, rerun the repository's normal
reviewed plan builder for the exact release commit. The coordinator promotes the
verified shadow plan into a fresh production dispatch while retaining its shadow
receipt and workflow evidence. Do not regenerate versions or manually dispatch the
publisher to work around an already verified shadow plan.

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

When an explicitly approved production break-glass run published every planned
Cargo artifact but the normal publisher emitted no receipt, use the reviewed
`recover-break-glass-plan` workflow. It is not a publisher retry:

1. Supply the exact component repository, reviewed plan ID, and successful
   break-glass run ID.
2. The coordinator requires the original reviewed publisher to be conclusively
   failed, verifies the successful legacy run at the protected execution ref and
   release commit, re-downloads every planned Cargo archive, matches its crates.io
   checksum, and verifies the exact GitHub Release.
3. The coordinator records a content-addressed recovery authorization in the
   atomic release-state outbox and dispatches the reviewed component `publish.yml`
   from the current default-branch commit.
4. Only the `recover` job may run on the default branch; the registry-writing
   `publish` job is skipped. The recovery job reads its exact run URL and inputs
   back from authoritative release-state before doing any work.
5. The recovery job checks out the reviewed release commit separately, reruns its
   package and generated-file gates, rebuilds every selected archive, rejects any
   registry-byte mismatch, creates GitHub attestations and immutable receipt tags,
   and submits authenticated receipts. It never requests npm or crates.io
   credentials and never uploads a package.
6. Verify that the plan is `verified`, all packages are `received`, every receipt
   binds the exact plan and release commit, and both the workflow state and release
   mode remain unchanged.

Do not use this path for a partial publication, a plan with accepted receipts, a
non-Cargo package set, a different component repository, or an unreviewed
break-glass workflow.

For a production plan that failed after publishing one or more artifacts of an
atomic mixed package set without emitting receipts, use the reviewed
`recover-failed-production-partial-plan` workflow:

1. The coordinator requires the original publisher and every prior partial
   recovery to be conclusively failed or cancelled, requires no accepted
   receipts, and independently observes a non-empty set of the planned versions
   in public registries. The set may contain every planned version when registry
   propagation completed after the publisher's visibility window expired.
2. A missing Cargo version is allowed only when the crate itself already exists.
   The component recovery obtains a short-lived crates.io OIDC credential and
   publishes only that reviewed missing version. A first Cargo publication still
   fails closed and must use the reviewed bootstrap policy through zero-write
   recovery.
3. The coordinator records a one-use recovery authorization and dispatches the
   component's reviewed `publish.yml` from the current default-branch commit.
   The normal `publish` job remains restricted to the protected execution ref;
   the recovery job runs only on the default branch. Replaying the authorization
   workflow resumes an already recorded pending or in-flight outbox entry instead
   of minting a new authorization; this covers temporary release-state
   read-after-write lag.
4. The component resolves the authoritative failed publisher, re-downloads its
   release artifacts where required, and checks out the reviewed release commit.
   It rebuilds packages whose archive is the registry payload and matches those
   bytes exactly. For an already-published OCI image, it instead validates the
   reviewed draft install manifest, its release-commit anchor, the public image
   manifest digest, and the image config revision; a later container rebuild is
   not accepted as evidence for the immutable image. It then creates an official
   GitHub provenance attestation over the verified recovery subjects.
5. The component publishes only versions still absent from the registry and
   submits receipts for both the pre-existing and newly published artifacts. If
   every version already exists, recovery performs byte verification and receipt
   submission without requesting a registry credential or uploading a package.
   It requests a short-lived Cargo OIDC credential only when the selected set
   contains Cargo packages and never overwrites an immutable version.
   If publication succeeds but registry propagation exceeds the workflow's
   visibility window, do not republish. After the failed run is conclusive, the
   coordinator may supersede it only after independently observing that the
   previously published set did not regress and that the new immutable version
   appeared. The replacement authorization records the expanded published set;
   the component then verifies every registry byte and submits receipts without
   a registry upload.
6. Verify public registry bytes and a fresh install independently, then verify
   that the coordinator marks every package `received` and the plan `verified`.

If a production publisher consumed its one-use proof but failed during registry
authentication before writing any selected version, use the reviewed
`recover-failed-production-zero-write-plan` workflow. First run the component's
reviewed `verify-production-zero-write-failure` workflow against the exact plan,
release commit, event, and failed run. The proof must show successful preflight
and proof consumption, the exact registry-authentication failure, no accepted
receipt, and authenticated absence of every selected production version. The
coordinator accepts only a successful proof from the component's current
default-branch head, requires the exact original publisher to be conclusively
failed, and records a distinct `production-zero-write` authorization. The
component then rebuilds every selected artifact, proves every version remains
absent, publishes only those missing versions through its short-lived OIDC,
reviewed first-publish bootstrap, or GitHub credential, and submits normal
immutable receipts. This path is not a
publisher retry: the original proof and dispatch remain consumed and immutable.
It rejects any accepted receipt, any observed published version, any in-flight
dispatch, and any failure that did not reach proof consumption.

If a production publisher fails before preflight, proof consumption, registry
OIDC, and publication, do not use partial recovery. First run the component's
reviewed prepublish-failure proof against the exact plan, release commit, event,
and failed run. The proof must verify the failed workflow step, require every
registry-writing step to be skipped, and prove every selected production version
absent using authenticated registry reads where required. Only then may the
reviewed `retire-failed-production-prepublish-plan` workflow release occupancy.
The coordinator accepts only a successful proof from the component's current
default-branch head and preserves the failed dispatch and proof URL as immutable
evidence. This path rejects accepted receipts, partial publication, successful or
in-flight publisher runs, and any plan not labelled production.

Do not manually dispatch either the component `publish.yml` or the legacy
`recover-partial-production.yml`; only the coordinator-issued binding is valid.

If a shadow publisher fails, the reviewed `retire-failed-shadow-plan` workflow may
release the stale coordinator occupancy. It fails closed unless every dispatched
workflow is complete, no dispatch is in flight, every received package still exists
in the shadow registry, and every unreceived selected version is absent. Successful
dispatches require complete matching shadow receipts; partial receipt evidence is
rejected. Existing receipts and execution history remain immutable. This path is
unavailable in production mode.

If a shadow publisher fails after writing only part of an atomic package set, do
not retire the plan or manually rerun the consumed workflow proof. The reviewed
`retry-failed-shadow-plan` workflow may create one fresh dispatch binding for the
same plan and package set. It is shadow-only, requires the previous workflow to be
conclusively failed or cancelled, forbids pending or in-flight dispatches, preserves
the previous outbox entry, and may be accepted only once per plan. During the new
proof consumption, the Shadow Gateway re-reads every already-present package and
requires its exact SHA-256 digest to match the newly sealed artifact before it signs
publication authorization. Any missing bytes or digest mismatch stops recovery.

If an older runtime emitted a ready event without binding the repository release
mode and a successful shadow publisher was consequently recorded as production,
use `recover-shadow-mode-mismatch-plan` only for that historical state. First run
the component's reviewed `verify-production-oci-absence` workflow with the exact
plan, commit, package, version, and registry path. It uses the component-scoped
`GITHUB_TOKEN` with read-only package permission and succeeds only on an authenticated
`404 MANIFEST_UNKNOWN`. Then supply the exact repository, plan ID, successful
publisher run ID, and absence-proof run ID. The recovery workflow requires
an untouched production-labelled publishing plan with no receipts, one original
dispatch covering the complete package set, a successful exact execution-ref run,
every selected npm/OCI version present in shadow, and every selected version absent
from production. It changes only the stored environment and appends recovery
evidence; plan, commit, execution ref, dispatch, nonce, packages, and occupancy stay
unchanged. After it succeeds, set `LENSO_COORDINATOR_MODE` to `shadow` and run
`recover-receipts`; full byte, provenance, tag, workflow, and receipt verification
must make the plan `verified` before any production promotion. Never use this path
to reinterpret a run that wrote any production registry.

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
8. If the reviewed receipt recovery cannot see the break-glass workflow, complete
   the exact `recover-break-glass-plan` procedure above; do not edit release-state
   directly or republish immutable versions.

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
- [`.github/workflows/recover-shadow-mode-mismatch-plan.yml`](../.github/workflows/recover-shadow-mode-mismatch-plan.yml):
  fail-closed repair for a historical production-labelled shadow run.
- [`.github/workflows/recover-break-glass-plan.yml`](../.github/workflows/recover-break-glass-plan.yml):
  exact, production-only recovery authorization for a fully published Cargo plan.
- [`shadow-gateway/`](../shadow-gateway/): isolated registry, release, and
  attestation emulator.
