# WI-V2-GLUE-AWARE-IMPL: Full Implementation Audit (L5)

**Date:** 2026-05-04
**Author:** FuckGoblin (claude-sonnet-4-6)
**Issue:** #95 — Full glue-aware shave implementation (5 layers)
**Parent planning:** DEC-V2-GLUE-AWARE-SHAVE-001, tmp/wi-v2-glue-aware-shave-audit.md

---

## Purpose

This document records the state of the 5-layer glue-aware shave implementation
landed by issue #95, and re-specs the V2 PoC chain acceptance criteria under the
glue-emit framing. It supersedes the "WI-V2-WAVE-3-LOWERING-GLUE-INTEGRATION"
and "WI-V2-PoC-COMPRESSION-AUDIT" placeholders from the follow-up list in
MASTER_PLAN.md §Initiative.

---

## Layer Status

### L1 — GlueLeafEntry contract (LANDED, PR #104)

**What shipped:**
- `GlueLeafEntry` type in `packages/shave/src/universalize/types.ts`
  (fields: `kind:"glue"`, `source:string`, `canonicalAstHash:string`, `reason:string`)
- `SlicePlanEntry` union extended: `PointerEntry | NovelGlueEntry | ForeignLeafEntry | GlueLeafEntry`
- `SlicePlan.sourceBytesByKind.glue` bucket added (zero until L2 emits entries)
- `shave()` skips `GlueLeafEntry` in `ShavedAtomStub` construction (same as `ForeignLeafEntry`)

**Authority invariant:** `GlueLeafEntry` is defined exclusively in
`packages/shave/src/universalize/types.ts`. Import from `@yakcc/shave`.

---

### L2 — Slicer search algorithm (LANDED, this PR)

**What shipped:**
- `SliceOptions` interface with `shaveMode?: "strict" | "glue-aware"` in
  `packages/shave/src/universalize/slicer.ts`
- `walkNodeGlueAware()` DFS walker: registry match → `PointerEntry`; foreign import →
  `ForeignLeafEntry`; `validateStrictSubset` passes → `NovelGlueEntry`; fails on atom →
  `GlueLeafEntry`; fails on branch → recurse into children
- `slice()` updated to accept `SliceOptions` and dispatch to the appropriate walker

**Architecture:** the slicer is now a search algorithm (find maximal shaveable
subgraphs) rather than a gate (whole-file must comply or fail). The IR
strict-subset rules survive unchanged as the predicate applied per-subgraph.

---

### L3 — Compile pipeline glue-aware consumer (LANDED, PR #104)

**What shipped:**
- `compileToTypeScript(plan)` emits glue verbatim with comment boundaries:
  ```typescript
  // --- glue: <8-char-hash> (not in registry) ---
  <verbatim source>
  // --- end glue ---
  ```
- `assertNoGlueLeaf(plan)` + `GlueLeafInWasmModeError` reject glue in WASM mode
  (consistent with DEC-V2-GLUE-LEAF-WASM-001 option a: fail loudly)

---

### L4 — Wave-3 lowering glue integration (LANDED, this PR)

**What shipped:** Two LoweringError guards that turn semantically-incorrect lowering
paths into `unsupported-node` throws, enabling the glue-aware slicer to emit
`GlueLeafEntry` rather than generating corrupt WASM:

**L4-#68 (LOWER-06, record string field equality):**
- Guard in `lowerExpressionRecord()` BinaryExpression handler
- Detects `===`/`==`/`!==`/`!=` comparisons where either operand is a string field
  of a record param
- Throws `LoweringError("unsupported-node")` with message referencing
  `DEC-V2-GLUE-AWARE-SHAVE-001 L4-#68`
- Rationale: `emitFieldLoad` for string fields loads only the PTR. Pointer
  comparison ≠ value equality; generating buggy WASM is worse than refusing to lower.
- Test: `record-06` in `packages/compile/test/wasm-lowering/records.test.ts`

**L4-#57 (LOWER-03, cross-domain comparison):**
- Guard in `lowerExpression()` BinaryExpression handler
- Detects comparison operators (`===`, `==`, `!==`, `!=`, `<`, `<=`, `>`, `>=`)
  where left and right Identifier operands have different symbol-table domains
  (e.g. i64 bigint vs i32 number)
- Throws `LoweringError("unsupported-node")` with message referencing
  `DEC-V2-GLUE-AWARE-SHAVE-001 L4-#57`
- Rationale: mixed i64/i32 operands produce invalid WASM (type mismatch);
  silently coercing to f64 changes comparison semantics.
- Test: `LOWER-03` describe block in `packages/compile/test/wasm-lowering/bigint.test.ts`

**Decision references:** both guards annotated `@decision DEC-V2-GLUE-AWARE-SHAVE-001`
in visitor.ts per the `@decision`-annotate requirement from issue #95 L4 spec.

---

### L5 — V2 PoC re-spec audit (THIS DOCUMENT)

Covered below in §V2 PoC Chain Re-spec.

---

## V2 PoC Chain Re-spec

### WI-V2-05/06 — IR refactor + corpus normalization

**Old framing:** every yakcc source construct MUST pass the IR strict-subset
predicate before the first shave pass (WI-V2-07). Constructs that don't pass
require refactor loops in WI-V2-05 until they do. This creates a hard dependency:
WI-V2-07 cannot start until WI-V2-05 is complete.

**New framing (glue-aware):** WI-V2-05/06 normalization is still valuable for
maximizing `local` atom yield. But it is NO LONGER a blocker for WI-V2-07. The
first shave pass can run against un-normalized source; constructs that don't pass
`validateStrictSubset` become `GlueLeafEntry` rather than hard failures.

**Revised acceptance criteria for WI-V2-05/06:**
- **Before:** "all yakcc source passes strict-subset predicate" (binary: pass/fail)
- **After:** "increase local atom yield; document remaining glue boundaries;
  no strict 100% requirement" (continuous: maximize yield, document residual)

**Timeline impact:** WI-V2-07 can now be parallelized with WI-V2-05/06 rather
than waiting for full normalization. Estimated 2-3 week compression.

---

### WI-V2-07 — First shave pass (Phase F)

**Old framing:** iterate failures as bugs requiring WI-V2-05 fixup loops.
First pass cannot complete until all failures are resolved.

**New framing:** the slicer's `glue-aware` mode handles all failures at the
leaf level by emitting `GlueLeafEntry`. The first pass ALWAYS completes
(no hard failure exits for non-conforming constructs). Residual failures
(DidNotReachAtomError, RecursionDepthExceededError) are genuine bugs in the
slicer itself, not in the source.

**Revised acceptance criteria:**
- **Before:** "all constructs shave; no DidNotReachAtomError in production mode"
- **After:** "slicer completes on all yakcc source files without exceptions;
  reports local atom yield + glue byte count; slicer exceptions (not LoweringErrors)
  are bugs requiring fixes"

The glue yield metric (`sourceBytesByKind.glue`) is the new quality indicator.
Target: glue < 30% of total source bytes across the yakcc codebase.

---

### WI-V2-08 — Compile self-equivalence (Phase G)

**Old framing (per tmp/wi-v2-glue-aware-shave-audit.md):** constructs that fail
to shave are blocker bugs.

**New framing:** already documented in parent audit. The glue-aware compile
pipeline (`compileToTypeScript` handling `GlueLeafEntry` verbatim) means the
recomposed yakcc includes glue regions verbatim. The acceptance gate is unchanged:
`pnpm test` must pass against the recomposed yakcc.

**Addition for this PR:** L3's `compileToTypeScript` is now live. The pipeline can
handle `GlueLeafEntry` records in the slice plan without manual intervention.
WI-V2-08 dispatchers can use `compileToTypeScript(plan)` directly; glue regions
appear verbatim in the TypeScript output with comment markers.

---

### WI-V2-09 — Two-pass bootstrap equivalence (Phase H)

Per the parent audit, the byte-identity assertion separates into:
- `local` atoms: must be byte-identical across passes (non-determinism guard)
- `glue` regions: byte-identical by construction (verbatim preservation)

**New addition:** the `canonicalAstHash` field on `GlueLeafEntry` enables
glue-region deduplication across the two passes. If a source construct appears
in both passes as glue, their `canonicalAstHash` values must match (same AST
hash for the same source). This is a lightweight identity check that doesn't
require a full registry lookup.

---

### #59 / #61 — Bundled V2 PoC tickets

These represent the "provenance manifest" and "compile pipeline V2 wiring"
work respectively. Under the glue-aware framing:

**#59 (provenance manifest):** The manifest now has three entry kinds:
`local` (registry-keyed, content-addressed), `foreign` (package dep, opaque),
`glue` (verbatim, project-local). The `GlueLeafEntry.canonicalAstHash` field
provides the identity key for glue entries in the manifest without requiring
registry storage.

**#61 (compile pipeline V2 wiring):** L3 (`compileToTypeScript` with glue support
and `assertNoGlueLeaf`/`GlueLeafInWasmModeError` for WASM mode) is live. The
"wiring" gap for TypeScript output is closed. WASM mode explicitly rejects glue
with a structured error (`GlueLeafInWasmModeError`) that includes the offending
entry for diagnostics.

**Acceptance criteria delta for both:** no structural change to acceptance gates;
the glue-aware pipeline is a superset of the strict-subset pipeline. Any test
written for the strict-subset behavior still passes (glue mode with no glue entries
is equivalent to strict mode).

---

### #86 / #87 — V2 self-shave PoC run tickets

These tickets depend on the full pipeline being live. Under the glue-aware framing:

**#86 (shave run against yakcc itself):** No longer requires pre-normalization of
all yakcc source. The slicer in `glue-aware` mode runs to completion, producing a
mixture of `local`, `foreign`, and `glue` entries. The yield metric is the KPI.

**#87 (two-pass equivalence run):** Requires the registry to be populated from #86.
Under glue-aware mode, the two-pass check has a simpler invariant: the `local` atom
set must be byte-identical. Glue regions don't enter the registry and thus don't
contribute to the two-pass divergence space.

---

## Remaining Gaps (Not in This PR)

1. **`universalize()` does not yet pass `shaveMode: "glue-aware"` to `slice()`.**
   The slicer supports `glue-aware` mode; the universalize() top-level pipeline
   still calls `slice(tree, registry)` without options. A one-line change in
   `packages/shave/src/index.ts` at line ~485 wires this up. Deferred to a
   follow-up ticket to keep this PR focused.

2. **`sourceBytesByKind.glue` is always zero in the current universalize() output.**
   Follows from gap 1. Once universalize() passes `shaveMode: "glue-aware"`, the
   walker will populate glue entries and the byte count will reflect reality.

3. **WASM mode glue rejection is only in `assertNoGlueLeaf()` (opt-in).**
   The `compileToWasm()` function does not call `assertNoGlueLeaf()` automatically.
   This is intentional per L3's design (the caller chooses the policy). The CLI
   should call `assertNoGlueLeaf()` before any WASM compilation in production mode.

4. **`validateStrictSubset` integration with the IR package.**
   L2 uses `validateStrictSubset` from `@yakcc/ir`. This import is correct per the
   package structure; the IR package must be built before the shave package tests
   run. CI must build in dependency order.

5. **L4 guards are `LoweringError` throws, not direct `GlueLeafEntry` emission.**
   The lowering visitor throws; the slicer catches and emits `GlueLeafEntry`.
   This is the correct two-level design (lowering knows nothing about slice plans).
   The pathway is: LoweringVisitor throws "unsupported-node" → validateStrictSubset
   catches it → atom classified as glue by walkNodeGlueAware. End-to-end wiring
   depends on gap 1 (universalize passing glue-aware mode).

---

## Metrics and Quality Gates for V2 PoC

| Metric | Target | Measurement |
|--------|--------|-------------|
| `local` atom yield | > 60% of source bytes | `SlicePlan.sourceBytesByKind.pointer + novelGlue` / total |
| `glue` byte fraction | < 40% of source bytes | `SlicePlan.sourceBytesByKind.glue` / total |
| Slicer hard failures | 0 (no exceptions from glue-aware slicer) | slicer run log |
| Two-pass local atoms | byte-identical across passes | sha256 of sorted BlockMerkleRoot set |
| `pnpm test` | passes against recomposed yakcc | CI |

The 60/40 split is a starting target; actual numbers from the first #86 run will
calibrate these. The key invariant is that `glue` decreases monotonically as
normalization (WI-V2-05/06) progresses.

---

## Decision Log Additions (this PR)

The following `@decision` annotations were added to visitor.ts as part of L4:

- `DEC-V2-GLUE-AWARE-SHAVE-001 (L4-#68)` — record string field equality cannot
  be safely lowered to WASM; glue-aware slicer emits GlueLeafEntry.
- `DEC-V2-GLUE-AWARE-SHAVE-001 (L4-#57)` — cross-domain comparison (bigint vs
  number) cannot be safely lowered to WASM; glue-aware slicer emits GlueLeafEntry.

These are sub-decisions of DEC-V2-GLUE-AWARE-SHAVE-001, not new top-level DEC
entries. They extend the decision's scope to specific lowering-layer guards.
