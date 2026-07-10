# GitHub App and publisher trust boundary

The release control plane uses a dedicated GitHub App installed only on repositories
that participate in Lenso releases. Installation is explicit per repository; it is not
an organization-wide automation identity.

## Permissions and credentials

The App has `Metadata: read`, `Contents: write`, `Pull requests: write`, and
`Checks: write`. `Actions: write` is granted only on publishable package repositories,
where it is required to dispatch the repository-local `publish.yml`. A token is minted
for one target repository and one dispatch, pull request, check, or ref operation. The
installation token is short-lived and is discarded after that operation.

The App private key is isolated in a restricted organization secret available only to
approved coordinator environments. Package repositories never receive the private key.
Their workflows receive, at most, a short-lived single-repository installation token.
No npm, crates.io, personal-access, or App-token fallback is permitted. Break-glass
credentials remain offline and require a separate incident procedure.

## Protected execution ref

For an approved plan `sha256:<64 lowercase hex>`, the App creates
`release-execution/<64 lowercase hex>` at the exact release commit. The App is the only
identity allowed to create or delete this branch. Branch or ruleset protection denies
updates and force pushes to everyone, including normal maintainers and workflows. The
dispatch selects this exact ref, and the publisher verifies both its name and current
tip. The branch is deleted only after verification completes, or after explicit
cancellation before any upload. It is never reused, advanced, or treated as a version
branch. The default branch must retain the corresponding workflow path while a plan is
active because GitHub requires a workflow-dispatch workflow to exist there.

Required protections also cover release-plan branches, immutable package tags, the
default branch, and promotion branches: required checks and review rules apply, direct
push is denied, and only narrowly scoped App operations may create release refs.

## Publisher ordering and OIDC

The repository-local publisher first re-reads GitHub metadata and validates the exact
repository, workflow path and workflow SHA-256, shared publisher revision and bundle
SHA-256, protected execution ref and tip, `github.sha`, release commit, runner, exact
Node, npm, and Rust versions, plan ID, source commit, and ordered package IDs and
versions. The plan's `sourceCommit` is the pre-version main commit. The execution ref,
`github.sha`, event `releaseCommit`, and raw plan URL use the distinct post-merge Release
PR commit; both commits must belong to the package repository and the release commit
must contain the source commit.
It then runs the full release gate, clean build and pack, digest comparison, and
registry preflight. Only after all those checks succeed may the named protected
environment approve the job and `id-token: write` be used to request OIDC. The OIDC
identity is bound to the package repository, local workflow, ref, and environment.

npm publishing uses a GitHub-hosted runner and the exact Node.js and npm versions
pinned by the approved plan (currently Node.js `24.0.0` and npm `11.7.0`).
crates.io authentication uses the reviewed, full-commit-pinned
`rust-lang/crates-io-auth-action`; its short-lived token is exposed only to the single
matching `cargo publish` command and its post step revokes it. There is no automatic
long-lived-token fallback.

## Event authentication and replay protection

Receivers first apply the versioned `lenso.release-event.v1` validator. They then
compare the expected App ID and actor with GitHub-observed delivery metadata and compare
repository, commit, ref, and workflow identities with values freshly re-read from
GitHub. Event body fields are never accepted as proof of GitHub facts. The canonical
event ID, strict UTC RFC 3339 issuance time, freshness window, source repository, plan
URL host/path/commit, plan digest, release-commit ownership, and exact ordered package
selection must all match the approved plan.

Only after every pure check succeeds does the receiver atomically consume the one-use
nonce. The replay store operation is insert-if-absent keyed by nonce and records the
event ID in the same atomic operation; one concurrent caller succeeds and all others
fail closed. Validation does not perform network calls. Callers must obtain observed
GitHub metadata before invoking it, which keeps retries deterministic and prevents a
payload from authenticating itself.
