# Agent instructions

This repository is in retirement preparation and is no longer an operational
release coordinator. Read [`docs/retirement-checklist.md`](docs/retirement-checklist.md)
before touching it. Do not create release intent, plans, dispatches, shadow
publication, receipt recovery, or break-glass runs from this repository.

The old [`docs/release-runbook.md`](docs/release-runbook.md) is retained only as
historical evidence. It must not be used to restore the retired coordinator or
to infer production authority from repository write access.

Do not change `LENSO_RELEASE_MODE`, add a publisher credential, or publish an
artifact to a public registry. Any archive, cloud-state deletion, or GitHub
permission change requires an explicit operator action outside this checkout.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in the central `LioRael/lenso` GitHub repository. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical labels in the central tracker. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a single-context layout. See `docs/agents/domain.md`.
