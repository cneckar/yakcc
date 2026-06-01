# ADR: ProjectManifest — Project-Level Content-Address Registry for Compose-by-Reference

**ID:** DEC-COMPOSE-BY-REF-MANIFEST-001
**Status:** ACCEPTED
**Date:** 2026-05-31
**Author:** implementer (wi-1044)
**Closes:** #1044
**Related:** DEC-V3-DISCOVERY-D4-001, #1043 (epic), #1045, #1046, #1047

---

## Context

DEC-V3-DISCOVERY-D4-001 established the compose-by-reference primitive: instead of
writing an atom's full implementation (~100–500 tokens) the model emits a ~10-token
import line that references the atom by its content address. For this to work at scale
the project needs a stable, committed file that:

1. Pins the full 64-char `BlockMerkleRoot` (BLAKE3-256 content address) for every
   referenced atom, so the build system can fetch and materialize exactly the right
   implementation.
2. Associates each root with a short project-unique alias used in in-source imports,
   keeping the token footprint minimal.
3. Stores the registry ID and optional version for air-gap and reproducibility.

No such file existed before #1044. This ADR records the design choices that were made.

---

## Decision

### Schema (version 1)

The project manifest is a JSON file committed at `.yakcc/manifest.json`
(`PROJECT_MANIFEST_PATH`). Its schema:

```json
{
  "version": 1,
  "references": [
    {
      "root":       "<64-char lowercase hex BLAKE3-256 BlockMerkleRoot>",
      "symbol":     "<export name the source file imports>",
      "alias":      "<project-unique prefix of root, min 12 chars>",
      "importPath": ".yakcc/atoms/<alias>",
      "registry":   "<registry id, default 'local'>",
      "version":    "<semver string or null>"
    }
  ]
}
```

`version` is the literal integer `1`. A future incompatible schema increment uses `2`.
Parsing rejects any non-1 value immediately — no silent defaults.

### The alias field: why a prefix, not the full root

The `alias` is the only token-bearing part of an atom reference that appears in source
code. It is a prefix of `root` (default: first 12 hex characters, ~48 bits of
content-address space). The full 64-char root appears exactly once, in `manifest.json`.

This asymmetry is the key token trade-off:
- **In source**: `import { crc32c } from ".yakcc/atoms/0009c5df8b58"` — 10 tokens.
- **Without this design**: writing the full implementation inline — 100–500 tokens.
- **Alias uniqueness guarantee**: `addReference()` starts at 12 chars and extends by
  one character at a time until the prefix is unique within the project manifest. With
  12 chars the probability of a 12-char collision across any two BLAKE3 outputs is
  negligible for realistic project sizes; the extension rule is a safety net, not a
  routine path.

`importPath` is derived from `alias` as `.yakcc/atoms/<alias>` and recorded in the
manifest so there is ONE authority for the module specifier. `parseProjectManifest`
validates that `importPath === ".yakcc/atoms/" + alias` and throws on inconsistency.

### In-source reference format

The canonical import line is:

```typescript
import { <symbol> } from ".yakcc/atoms/<alias>";
```

`referenceImportLine(ref)` is the single authority for producing this string. #1047
(the `yakcc_reference` MCP tool) returns `referenceImportLine(ref)` to the model.

### ProjectManifest vs. ProvenanceManifest

These are intentionally different artefacts with different lifecycles:

| Concern | ProjectManifest | ProvenanceManifest |
|---|---|---|
| Location | `.yakcc/manifest.json` (committed) | per-assembly in-memory / output |
| Purpose | pin referenced atoms for the build | audit trail for an `assemble()` run |
| Authority | `packages/compile/src/project-manifest.ts` | `packages/compile/src/manifest.ts` |
| Consumers | #1045, #1046, #1047 | verification / CI audit |
| Mutated by | `addReference()` | `buildManifest()` / `assemble()` |

Conflating them would mean the build audit trail pollutes the project-level reference
registry, or vice versa. They must remain separate.

### Fail-loudly parsing

`parseProjectManifest(text)` throws `ProjectManifestError` (never returns a partial
default) on:
- non-object root
- `version !== 1`
- `references` not an array
- any reference where `root` is not exactly 64 lowercase hex chars
- empty `symbol`
- `alias` not a prefix of `root`
- `importPath` inconsistent with `alias`
- duplicate `alias` within the manifest

Silent defaults at this layer would allow a corrupt manifest to silently produce
wrong materializations in the build step (#1045), corrupting the project state.

### Immutability / no-mutation contract

`addReference()` does not mutate its input. It returns a new `ProjectManifest` with
the reference appended. Callers (the MCP tool, build scripts) must persist the returned
manifest to disk. This makes the function pure and testable without filesystem mocks.

---

## Downstream consumers

- **#1045 (build-inline)**: reads `manifest.json` via `parseProjectManifest`, iterates
  `references`, and materializes `.yakcc/atoms/<alias>.ts` from the registry for each
  root.
- **#1046 (.d.ts stubs)**: materializes `.yakcc/atoms/<alias>.d.ts` so that the in-source
  import typechecks before a full build. Uses `materializedDtsPath(alias)`.
- **#1047 (yakcc_reference MCP tool)**: calls `addReference()` on the current manifest
  and returns `referenceImportLine(ref)` to the model as the in-source import string.

---

## Alignment with DEC-V3-DISCOVERY-D4-001

DEC-V3-DISCOVERY-D4-001 established that the model should emit a reference to a
content-addressed atom rather than writing the implementation. This ADR provides the
data layer that makes that principle mechanically enforceable:

- The manifest is the single authority for which atoms are referenced in the project.
- The alias is the stable in-source identifier; the root is the cryptographic pin.
- The build (#1045) and type stubs (#1046) close the loop so the model's reference
  import becomes a first-class, typechecked, reproducible identifier.

---

## Consequences

**Positive:**
- Token footprint of an atom reference drops from ~100–500 to ~10.
- The manifest is a human-readable, diffable, committed file: reference history is
  visible in git.
- Round-trips deterministically: `parse(serialize(m)) == m` is enforced by tests and
  by the stable key-order serializer.
- `addReference` is idempotent: the MCP tool can call it safely without checking first.

**Negative / constraints:**
- Consumers (#1045, #1046, #1047) must be implemented before the full compose-by-reference
  flow is end-to-end usable.
- The alias is opaque in source (`0009c5df8b58`), not human-readable. This is intentional
  (the symbol provides readability; the alias is the stable machine identity).

---

## Rollback boundary

This ADR covers `project-manifest.ts`, its barrel export from `packages/compile/src/index.ts`,
the fixture at `packages/compile/src/__fixtures__/project-manifest/`, and this ADR file.
No changes to `assemble.ts` or `manifest.ts` (ProvenanceManifest) are part of this decision.
Reverting #1044 removes the compose-by-reference data layer and blocks #1045–#1047.
