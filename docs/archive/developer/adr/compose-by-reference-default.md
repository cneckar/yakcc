# ADR: compose-by-reference as the default for new yakcc projects

**ID:** DEC-COMPOSE-BY-REF-DEFAULT-001
**Status:** ACCEPTED
**Date:** 2026-06-01
**Author:** implementer (wi-compose-ref-init-default)
**Closes:** compose-ref-init-default workflow
**Related:** DEC-COMPOSE-BY-REF-MANIFEST-001 (#1044), #1045 (build-inline), #1047 (yakcc_reference MCP tool), #1048 (discovery prompt reference-emit gate)

---

## Context

The compose-by-reference design (DEC-COMPOSE-BY-REF-MANIFEST-001) lets the model emit a
~10-token `import` reference to an atom instead of writing its full implementation
(~100–500 tokens). The discovery prompt (#1048) gates this reference-emit path on the
**presence** of `.yakcc/manifest.json` in the project root: if the file exists the
reference path fires; if absent the prompt falls back to verbatim emit.

Before this ADR, `yakcc init` created `.yakcc/` and wrote `.yakccrc.json` and the SQLite
registry, but did **not** create `.yakcc/manifest.json`. Every new project therefore
silently landed on the verbatim fallback — writing full implementations even when an
atom was available in the registry. Compose-by-reference was effectively opt-in via a
manual `yakcc_reference` call or by hand-writing the manifest.

The goal of this ADR is to make compose-by-reference **the standard for new projects**
without any additional user action.

---

## Decision

`yakcc init` scaffolds `.yakcc/manifest.json` as part of its standard initialization
sequence, immediately after creating the `.yakcc/` directory.

### What is written

An empty, valid `ProjectManifest` — version 1, zero references:

```json
{
  "version": 1,
  "references": []
}
```

The manifest is produced **exclusively** via `@yakcc/compile` authorities:
`serializeProjectManifest(emptyManifest())`. It is never hand-rolled. This means
`parseProjectManifest` accepts it unconditionally and the single-authority invariant
(DEC-COMPOSE-BY-REF-MANIFEST-001) is preserved.

### Idempotency

If `.yakcc/manifest.json` already exists — for example on a re-init of an active project
that already has atom references — the write is skipped. The existing manifest is
**never clobbered**. This preserves the project's compose-by-reference registry across
re-inits.

### User-facing signal

`yakcc init` adds one summary line:

```
Compose-by-reference: .yakcc/manifest.json scaffolded — run `yakcc build` to materialize referenced atoms.
```

This signals the user that reference-emit is active and points at the next step
(`yakcc build`).

### Verbatim fallback preserved

Projects that do **not** run `yakcc init` — or that delete `.yakcc/manifest.json` — retain
the verbatim fallback. This is the correct behavior for non-build projects (scripts,
one-off tooling) where there is no build step to materialize referenced atoms.

---

## Rationale

### Why the discovery prompt gates on file presence

The discovery prompt's reference-emit branch requires `.yakcc/manifest.json` to exist
because without it `addReference()` has nowhere to write, and `yakcc build` (#1045)
has nothing to read. A missing manifest is a definitive signal that the project is not
set up for compose-by-reference. Gating on presence avoids false positives.

### Why init is the right place to scaffold the manifest

`yakcc init` is the canonical first-touch command. Every project that uses yakcc runs it.
Placing the scaffold here means every new project is reference-ready without a separate
step, a separate flag, or manual file creation. The alternative — requiring `yakcc_reference`
to create the manifest lazily on first call — was rejected because it would leave the
discovery prompt on the verbatim path until the user happened to call `yakcc_reference`,
which is circular.

### Why @yakcc/compile, not hand-rolled JSON

`packages/compile/src/project-manifest.ts` is the single authority for the
`ProjectManifest` schema (DEC-COMPOSE-BY-REF-MANIFEST-001). `parseProjectManifest`
validates strict invariants (version, hex-64 roots, alias-prefix relationship,
importPath consistency). Hand-rolling the JSON would introduce a second definition of
`{ version: 1, references: [] }` that could drift silently. Using `emptyManifest()` +
`serializeProjectManifest()` means any future schema change is automatically reflected
in what `yakcc init` writes.

---

## Integration points

| Consumer | How it uses the manifest |
|---|---|
| Discovery prompt (#1048) | Checks `.yakcc/manifest.json` exists → fires reference-emit branch |
| `yakcc_reference` MCP tool (#1047) | Calls `addReference()` on the manifest to record a new atom reference |
| `yakcc build` (#1045) | Reads `references[]`, materializes `.yakcc/atoms/<alias>.ts` for each root |
| `.d.ts` stubs (#1046) | Reads `references[]`, generates `.yakcc/atoms/<alias>.d.ts` for typecheck |

---

## Consequences

**Positive:**
- Every new project scaffolded by `yakcc init` is reference-emit-ready without extra steps.
- The discovery prompt's reference path fires by default — compose-by-reference is the
  standard, not an advanced option.
- The empty manifest is a valid, parseable file from day one; `yakcc build` runs without
  errors on an empty references list.

**Negative / constraints:**
- The summary line adds one non-empty line to init output (G6 line count updated from 8 to 9).
- Projects that re-init after adding references must not have their manifest clobbered —
  the idempotency check (`existsSync`) guards this.
- Non-build projects that never intend to use `yakcc build` will have an unused
  `.yakcc/manifest.json`. This is harmless: the discovery prompt only fires reference-emit
  if atoms are found in the registry; for an empty project the fallback is verbatim anyway.

---

## Rollback boundary

`packages/cli/src/commands/init.ts` (manifest scaffold + summary line),
`packages/cli/src/commands/init.test.ts` (Suite 28 assertions), and this ADR.

No changes to:
- `docs/system-prompts/yakcc-discovery.md` (discovery prompt — separate WI)
- `packages/compile/src/project-manifest.ts` (forbidden by scope manifest)
- Any federation, seed, or hook-install logic in `init.ts`

Reverting removes the compose-by-reference default; new projects fall back to verbatim
emit until `.yakcc/manifest.json` is created manually or by a future init run.
