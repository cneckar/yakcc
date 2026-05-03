# Salvage notes — orphan WIP from feature/wi-v1w2-wasm-02 worktree

Discovered 2026-05-03 by Wrath while cleaning up local branches. A prior
implementer session staged ~1,800 lines of WIP across `packages/compile/src/`
on branch `feature/wi-v1w2-wasm-02` (worktree at
`.worktrees/feature-wi-v1w2-wasm-02`) but never committed — the work was
abandoned when a different (simpler) implementation of `WI-V1W2-WASM-02`
won the merge race to main as commit `e6ad398`.

The orphan WIP took a more elaborate architectural path than what shipped.
Several components are reusable for v1 wave-3 work even though the
overall structure is wave-2-shaped (single monolithic backend, pre-scaffold
ABI). **Do not port line-for-line — port the ideas + the test corpora.**

## Files in this archive

- `wi-v1w2-wasm-02-orphan-staged.patch` — full staged diff captured from the
  worktree's index. Apply against the base commit shown in `source-base-commit.txt`
  if you want to reconstruct the WIP backend tree for direct inspection.
- `source-base-commit.txt` — the base commit the WIP was staged on top of
  (`b1a8965`, "Merge WI-V1W2-HOOKS-BASE: extract @yakcc/hooks-base shared types").

## What's reusable, mapped to wave-3 issues

### bigint → i64 lowering — issue #29 (Wrath, WI-V1W3-WASM-LOWER-04)

**Highest-value salvage.** The orphan WIP already implements the bigint→i64
lowering that #29 describes:

- Test surface `P1c — bigint→bigint i64: cross-backend parity (compound)`
  with 5 i64 corpus cases that validate `tsBackend` and `wasmBackend`
  produce equal outputs.
- Specific case: `i64 add with value exceeding i32 max returns correct bigint`
  — exercises the i64 boundary directly.
- `WASM module for i64 substrate passes WebAssembly.validate()` — binary-level
  sanity check for the i64 module.

These tests target the wave-2 monolithic ABI (function name `add`, not
`__wasm_export_add`). When porting to wave-3, drop the test scaffolding into
the wave-3 lowering visitor harness instead of reusing the backend wiring.
The corpus values and the boundary-case shape (`I64_MAX + 1 → I64_MIN` under
the v1 wrap-on-overflow simplification) are directly reusable.

### typeHint inference for numerics — issue #27 (FuckGoblin, WI-V1W3-WASM-LOWER-02)

The WIP established the `typeHint` policy for the wave-2 backend in
`@decision DEC-V1-WAVE-2-WASM-LOWERING-001`:

- Numeric domain inference when `typeHint` is absent → defaults to f64 (with
  downgrade warning) in the WIP's design; landed implementation defaults to
  i32 (`DEC-V1-WAVE-2-WASM-TYPE-LOWERING-001`).
- Test surface `N1 — i32 typeHint selects i32 (not f64)` and `N2 — absent
  typeHint → f64 default + downgrade warning` exercises the policy edges.

Wave-3's number→i32/i64/f64 inference (`DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001`)
will need to revisit this default. The orphan WIP carries the warning-emission
mechanism intact — useful pattern even if the chosen default differs.

### WasmLoweringError + diagnostic surface — issue #26 (FuckGoblin, WI-V1W3-WASM-LOWER-01) + general

The WIP introduces:

- `WasmLoweringError` — a dedicated error class for unsupported types and
  lowering failures, with structured fields for the failing node + reason.
- `WasmLoweringResult` — a result wrapper that returns both `bytes` and
  `diagnostics` (warnings, downgrades, etc.) instead of just bytes.
- `compileToWasmWithDiagnostics` — a parallel API surface that returns the
  rich result type; `compileToWasm` is preserved as the simple "just bytes"
  surface.

The landed implementation dropped the diagnostic surface entirely. Wave-3
lowering (8+ slices, every one of which can encounter unsupported source
constructs) will benefit from re-introducing this pattern. Sacred Practice #5
("fail loudly"): the diagnostic surface is the natural mechanism for surfacing
"this construct will not lower under v1 wave-3 simplifications" without
swallowing it.

### Cross-backend parity test pattern — issue #36 (Wrath, WI-V1W3-WASM-LOWER-11)

The WIP organizes parity tests as numbered slices (`P1a/P1b/P1c/P2/P3/P4/P5`)
each describing one substrate kind:

| Slice | Substrate                            | Maps to wave-3 issue          |
|-------|--------------------------------------|-------------------------------|
| P1a   | number → number i32                  | #27 (LOWER-02 numerics)       |
| P1b   | number → number f64                  | #27                           |
| P1c   | bigint → bigint i64                  | #29 (LOWER-04 bigint)         |
| P2    | string → number (strlen)             | #30 (LOWER-05 strings)        |
| P3    | number → string (numToStr)           | #30                           |
| P4    | record<{a,b}> → number               | #31 (LOWER-06 records)        |
| P5    | Array<number> → number               | #32 (LOWER-07 arrays)         |

The wave-3 closer (#36) parity harness over the yakcc-self-shave corpus can
adopt the same `P*` numbering convention — gives reviewers a clean way to
trace each test back to the slice that introduced it.

### WebAssembly.validate sanity check — issue #36 (closer)

The WIP includes `compileToWasm — module binary validity (WebAssembly.validate)`
which iterates over every produced module and asserts it passes
`WebAssembly.validate()`. The landed test suite has substrate-specific
validity assertions but no across-the-board sweep. Worth promoting into the
wave-3 closer as a foundation-level invariant.

## What's NOT reusable

- The `add` / `stringLen` / `formatI32` / `sumRecord` / `sumArray` function
  names (the WIP omits the `__wasm_export_` prefix the landed code adopted).
  Wave-3 lowering will assign its own names per the scaffold.
- The single-file monolithic structure of `wasm-backend.ts` (1,261 lines in
  the WIP). Wave-3 (#26 LOWER-01) replaces this with a visitor + symbol
  table, so the lowering logic gets distributed across multiple modules.
- The `@wasmType` JSDoc-annotation extraction approach for typeHints. Wave-3
  uses the ts-morph typechecker contextual-type read (different mechanism).

## Why this archive exists

The full patch is preserved here so that a wave-3 implementer who wants to
inspect the original test cases (e.g. exact i64 corpus values) can do so
without resurrecting the orphan worktree. The archive is meant to be
read-only reference; the actual wave-3 implementation work happens fresh in
the wave-3 lowering tree under `DEC-V1-WAVE-3-*` decisions.
