# Agent instructions

Before planning, changing, or executing a Lenso framework release, read
[`docs/release-runbook.md`](docs/release-runbook.md). It is the authoritative
operator and agent runbook for release intent, reviewed plans, shadow execution,
production approval, receipt recovery, and break-glass publishing.

Do not infer production authority from repository write access. Never change
`LENSO_RELEASE_MODE`, enable a legacy publisher, bypass a reviewed plan, or publish
an artifact to a public registry without explicit approval for that production
operation.

