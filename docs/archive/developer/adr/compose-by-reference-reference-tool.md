# ADR: yakcc_reference MCP Tool — Return a Reference, Not the Source

**ID:** DEC-COMPOSE-BY-REF-REFERENCE-TOOL-001
**Status:** ACCEPTED
**Date:** 2026-06-01
**Author:** Serenity (wi-1047)
**Closes:** #1047
**Related:** DEC-COMPOSE-BY-REF-MANIFEST-001, DEC-COMPOSE-BY-REF-BUILD-001, DEC-COMPOSE-BY-REF-DTS-001, DEC-1028-COMPILE-FULL-ROOTS-001, DEC-MCP-TOOLS-REGISTRY-020, DEC-MCP-ERROR-AS-CONTENT-004, DEC-V3-DISCOVERY-D4-001, #1043 (epic), #1044, #1045, #1046, #1048

---

## Context

The existing `yakcc_compile` MCP tool (#1007) returns an atom's **full assembled
implementation source**. The discovery prompt (#1030) then directs the model to write
that source verbatim. The B4-v5 rerun (#1041) proved this is *token-negative*: writing
~370+ tokens of impl ≈ authoring it, so output tokens do not shrink. It is a reliability
mechanism, not a token one.

The D4 ADR (DEC-V3-DISCOVERY-D4-001) specified the token-saving design: on a strong match,
the model should record a **reference** (~10 tokens) and a build step materializes the
atom. #1044 (manifest), #1045 (`yakcc build`), and #1046 (`.d.ts`) built that substrate.
This issue adds the LLM-facing tool that returns the reference artifact instead of the
impl — the mechanism that actually collapses model output.

---

## Decision

### A new tool `yakcc_reference({ atom_id })` returns the reference artifact, not the impl

Registered in the canonical `TOOLS` array (`packages/mcp-registry/src/tools/index.ts`,
DEC-MCP-TOOLS-REGISTRY-020). The handler resolves `atom_id` to a `BlockMerkleRoot` and
returns a single JSON content struct:

```json
{
  "atom_id": "<as given>",
  "root": "<64-char BlockMerkleRoot>",
  "manifest_entry": { "root": "...", "symbol": "asciiChar", "alias": "...",
                      "importPath": ".yakcc/atoms/<alias>", "registry": "local", "version": null },
  "import_line": "import { asciiChar } from \".yakcc/atoms/<alias>\";",
  "dts_ref": { "path": ".yakcc/atoms/<alias>.d.ts",
               "dts": "export declare function asciiChar(input: string, position: number): string;" }
}
```

The model writes the ~10-token `import_line`, records the `manifest_entry` in
`.yakcc/manifest.json`, and (optionally) drops `dts_ref.dts` so the import typechecks
pre-build. It does **not** emit the implementation body. `yakcc build` (#1045) inlines the
impl later.

### Short-id resolution mirrors yakcc_compile (single authority, no fork)

The tool reuses the `yakcc_compile` resolution pattern verbatim (DEC-1028-COMPILE-FULL-ROOTS-001):
lazily open + seed the registry once, enumerate the **full** registry root set
(`enumerateSpecs` → `selectBlocks`), and resolve a possibly-short `atom_id` by 64-hex
passthrough or unique-prefix match (`not_found` / `ambiguous_short_id` otherwise). This is
the same `resolveAtomId` logic; no parallel short-id resolver is introduced (Sacred
Practice #12).

### The reference artifact is built only from the @yakcc/compile authorities

- `manifest_entry` ← `addReference(emptyManifest(), { root, symbol })` (DEC-COMPOSE-BY-REF-MANIFEST-001)
- `import_line` ← `referenceImportLine(reference)`
- `dts_ref.path` ← `materializedDtsPath(reference.alias)`
- `dts_ref.dts` ← `generateAtomDts(spec, symbol)` (DEC-COMPOSE-BY-REF-DTS-001)

No reference/alias/path/declaration logic is re-implemented in the MCP tool.

### The bound symbol is the atom's real entry export name

`symbol` must equal the export that `assemble()` / `yakcc build` materializes, or the
import line would not resolve after build. It is derived from the block's `implSource` by
extracting the first `export [async] function <name>` (the primary path), falling back to
the camelCase of `spec.name` (e.g. `ascii-char` → `asciiChar`) when no top-level export
function declaration is found. Both helpers are private to the tool file — there is no
cross-package "symbol authority"; the derivation is anchored by a test asserting the
derived symbol equals the export in `assemble(root)`'s output.

### Errors are content, never thrown

Per DEC-MCP-ERROR-AS-CONTENT-004 the handler never throws: `invalid_input`,
`registry_unavailable`, `not_found`, and `ambiguous_short_id` are returned as structured
JSON content. The model can react without an MCP transport error.

---

## Alternatives considered

### A `mode: "reference"` flag on yakcc_compile

Folding this into `yakcc_compile` would overload one tool with two contradictory contracts
(returns-impl vs returns-reference) and make the discovery prompt's branching harder to
reason about. A distinct tool keeps each contract single-purpose and lets #1048 route to
it explicitly. The verbatim path (#1030) stays as the reliability fallback.

### Return only the import line

Returning just `import_line` would force the model (or a follow-up call) to reconstruct the
manifest entry and the `.d.ts`. Returning all three in one call is what makes the
reference handoff a single, cheap round-trip.

### Derive the symbol from spec.name only

`spec.name` is the canonical atom name (`ascii-char`), not necessarily the export symbol
(`asciiChar`). Anchoring on the real `implSource` export name (with camelCase fallback)
keeps the import line resolvable against the materialized module.

---

## Downstream consumers

- **Discovery prompt revision (#1048)**: directs the model to call `yakcc_reference` on a
  strong/auto_accept match and emit the reference instead of writing the impl.
- **Token experiment (#1041)**: measures the output collapse of the reference path vs the
  verbatim path on large/hard atoms (#1049).

---

## Consequences

**Positive:**
- Model output for a substituted atom collapses from ~impl-size to ~10 tokens.
- Reuses the entire #1044–#1046 substrate and the #1028 resolution path — no new authority.
- Unit-tested via the production handler (resolve → artifact), including a symbol
  ground-truth check and a no-impl invariant (the response contains no implementation body).

**Constraints:**
- `yakcc_reference` is only useful once `yakcc build` is part of the project's build (the
  reference is not self-contained TS until built). The verbatim `yakcc_compile` path
  remains for projects without the build step (the reliability fallback, #1030).
- The symbol derivation assumes the atom's entry is an `export function` or has a
  camelCase-of-spec-name export. Atoms with unusual export shapes need the heuristic
  extended; the ground-truth test guards regressions.

---

## Rollback boundary

This ADR covers:
- `packages/mcp-registry/src/tools/reference.ts` — the tool + handler
- `packages/mcp-registry/src/tools/reference.test.ts` — production-handler tests
- `packages/mcp-registry/src/tools/index.ts` — `TOOLS` registration + re-export
- This ADR file

`compile.ts`, `assemble.ts`, `project-manifest.ts`, and `atom-dts.ts` are untouched.
Reverting #1047 removes the tool; the verbatim `yakcc_compile` path is unaffected.
