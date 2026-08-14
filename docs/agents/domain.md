# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **single-context** repo: one `CONTEXT.md` and one `docs/adr/` at the root, covering the whole system. Open Relic is one bounded context — a Git service — not several.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary and ubiquitous language.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   │   ├── 0001-durable-object-per-repository.md
│   │   └── 0002-effect-as-the-service-boundary.md
│   └── agents/
└── apps/api/
```

If this repo ever splits into genuinely separate contexts, the multi-context layout is a root `CONTEXT-MAP.md` pointing at one `CONTEXT.md` per context, with context-scoped `docs/adr/` alongside each. Switch by re-running `/setup-matt-pocock-skills` or editing this file.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0002 (Effect as the service boundary) — but worth reopening because…_
