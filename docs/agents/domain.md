# Domain Docs

This repository uses a single-context domain-documentation layout.

## Before exploring, read

- `CONTEXT.md` at the repository root.
- ADRs under `docs/adr/` that affect the area being changed.

If these files do not exist, proceed silently. Domain-modeling skills create
them lazily when terminology or architectural decisions are resolved.

## File structure

```text
/
├── CONTEXT.md
└── docs/adr/
```

## Use the glossary vocabulary

Use terms defined in `CONTEXT.md` in issues, proposals, tests, and code. Avoid
synonyms the glossary explicitly rejects.

If a required concept is absent, reconsider the terminology or record the gap
for domain modeling.

## Flag ADR conflicts

Surface any conflict with an existing ADR explicitly instead of silently
overriding it.
