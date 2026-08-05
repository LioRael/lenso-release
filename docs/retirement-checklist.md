# Release Control Plane Retirement Checklist

This checklist freezes `LioRael/lenso-release` after the final component
repository migration. It is an operator handoff, not a new release workflow.
The repository and its historical schemas remain available for audit; no new
release intent, plan, dispatch, publication, receipt, or recovery operation is
permitted.

## Scope

The migrated component repositories are:

- `LioRael/lenso-audit-log-module`
- `LioRael/lenso`
- `LioRael/lenso-auth-module`
- `LioRael/lenso-organization-module`
- `LioRael/lenso-cli`
- `LioRael/lenso-console`

Each repository owns its versioning, build, registry publication, provenance,
and compatibility checks. The Console installer trusts the repository-owned
`LioRael/lenso-console/.github/workflows/release-oci.yml` workflow. No component
may depend on this repository for a release decision or receipt.

## Freeze gate

Record the following in the archive PR or release notes before archiving:

1. Verify the six repositories' `main` branches contain their local Release-plz
   or Changesets workflow and no central publisher or integration-set checkout.
2. Verify no release run is queued or in progress:

   ```sh
   gh run list --repo LioRael/lenso-release --limit 100 \
     --json databaseId,status,conclusion,workflowName,headBranch
   ```

   Capture completed run IDs and any plan IDs needed for the static history
   export. Do not dispatch a replacement run.
3. Export a credential-free, content-addressed index of historical plans,
   versions, source commits, artifact digests, receipt and attestation
   locations, final states, and export checksums. Do not include secrets,
   tokens, nonces, private keys, or reusable authorization material.
4. Set D1, R2, and the Shadow Gateway state to read-only. Record the state
   snapshot identifiers and checksums in the archive evidence.
5. Revoke the coordinator GitHub App installation, repository variables and
   secrets, and any recovery or dispatch permissions. Secret listings may be
   checked by name only; never print secret values.
6. Merge the retirement change that removes the operational coordinator and
   recovery workflows, then make the GitHub repository read-only and archived.

The archive operation itself is an external GitHub and Cloudflare action. This
checkout must not perform it implicitly.

## 90-day retention

Set these dates in the archive record when the freeze gate is complete:

```text
RETIREMENT_EFFECTIVE_DATE=YYYY-MM-DD
RETENTION_END_DATE=RETIREMENT_EFFECTIVE_DATE+90 days
```

During the retention window:

- D1, R2, and Shadow Gateway state are read-only; no reconciliation, recovery,
  or cleanup write is allowed.
- The static export is checked against the retained state at least once.
- The repository remains archived and no workflow is re-enabled.

After `RETENTION_END_DATE`, recheck the static export and its checksums, then
delete the remaining D1/R2/Shadow Gateway state and associated secrets through
the approved operator procedure. Keep the credential-free static index and Git
history permanently.

## Evidence

The final archive record should contain only:

- the effective and end dates;
- the six migrated repository commits and release-workflow paths;
- the last completed coordinator workflow and plan/run identifiers;
- static export checksums and storage locations;
- confirmation that permissions, variables, secrets, and workflows were
  disabled or revoked; and
- the post-retention deletion receipt.

Do not use the former [`release-runbook.md`](release-runbook.md) to resume the
coordinator. A future release must be implemented in the owning repository.
