# WI-V2-GLUE-AWARE-SHAVE Re-audit

**Date:** 2026-05-04  
**Author:** FuckGoblin (claude-sonnet-4-6)  
**Issue:** #78 — Shift from strict-subset-or-fail to shave-what-shaves + glue  
**Framing decisions:** DEC-V2-GLUE-AWARE-SHAVE-001, DEC-V2-FRONTEND-TOOL-REUSE-001

---

## Purpose

This document audits all active work items whose assumptions change under the
glue-aware framing, identifies which already-landed decisions need revisiting,
and notes which follow-up tickets may be resolved by glue-emit rather than
feature-extension.

---

## 1. Active WIs whose acceptance criteria change

### WI-V2-08 — Compile self-equivalence (Phase G)

**Old assumption:** every yakcc source construct successfully shaves; compile
recomposition then proves functional equivalence. Constructs that fail to shave
are blocker bugs requiring fixup loops through WI-V2-05.

**New assumption:** constructs that don't shave cleanly become `GlueLeafEntry`.
The recomposed yakcc includes glue regions verbatim. Functional equivalence
(`pnpm test` passing) remains the acceptance gate; the recomposed binary is
"glue + local atoms + foreign atoms" rather than "100% atoms."

**Acceptance criteria delta:** No change to the gate itself (`pnpm test` must
pass). The "byte-identical source" qualifier was already disclaimed; the glue
framing makes this even more explicit. Test pass count is the arbiter, not
source fidelity.

**Timeline impact:** ~30-40% compression. Fixup loops that were previously
"WI-V2-05 refactor → re-shave → repeat" become "emit GlueLeaf → accept →
move on."

---

### WI-V2-09 — Two-pass bootstrap equivalence (Phase H)

**Old assumption:** both shave passes produce byte-identical `BlockMerkleRoot`
sets; any divergence is a non-determinism bug. The full yakcc source shaves
cleanly in both passes.

**New assumption:** byte-identity assertion applies separately to `local` atoms
(must be identical across passes — this remains the load-bearing invariant) and
`glue` regions (verbatim-preserved by construction; byte-identical trivially
because they are not canonicalized).

**Acceptance criteria delta:** The pre-assigned decision DEC-V2-BOOTSTRAP-EQUIV-001
must clarify at WI dispatch: does the CI gate compare the set of `local`
BlockMerkleRoots only, or also the set of glue-region source bytes? Recommended:
gate on `local` atoms (the non-determinism risk lives there); glue regions are
their own byte-identity check by a simpler invariant (same source file →
same verbatim bytes).

**Timeline impact:** glue boundaries reduce the scope of non-determinism risk.
Fewer atoms to verify → smaller search space for divergence bugs.

---

### WI-V2-10 — v2 demo + CI (Phase I)

**Old assumption:** demo claim is "the compiler shaves itself, recomposes
itself, and the result is byte-identical." This implies 100% shave coverage of
yakcc's own source.

**New assumption (per framing shift):** demo claim sharpens to "yakcc shaves
the meaningfully-reusable parts of arbitrary TS source, including itself —
glue regions are preserved verbatim and are byte-identical by construction."

**Acceptance criteria delta:** The `docs/V2_SELF_HOSTING_DEMO.md` must
document: (a) which yakcc constructs shaved into `local` atoms, (b) which
stayed as `glue` and why, (c) that the two-pass equivalence holds for both
sets. The external-facing claim should NOT say "100% shaved" — it should say
"meaningfully-reusable parts shaved." This is more honest and more defensible.

**Timeline impact:** demo script simplifies — no need to hide or explain
residual shave failures; they are glue, documented as such.

---

### WI-V2-07 — First shave pass (Phase F)

**Old assumption:** iterate failures as "did-not-reach-atom" bugs; each is
either a Phase B/D gap (IR not handling the construct) or a real slicer bug.
Failure loop back to WI-V2-05 refactoring.

**New assumption:** failures that correspond to "project-specific glue code"
emit `GlueLeafEntry` rather than throwing. Only failures that represent bugs
in the slicer's handling of shaveable constructs remain as bugs.

**No acceptance criteria change at the WI row level** — WI-V2-07 is still
gated on WI-V2-06 and produces a populated registry. But the iteration loop
is compressed: the slicer's output set grows (more atoms recognized as local)
and the residual failure set shrinks (glue absorbs the rest).

---

### WI-V1W3-* (v1 wave-3 lowering chain)

Wave-3 lowering WIs (WASM-LOWER-01 through WASM-LOWER-09) lower IR
strict-subset constructs to WASM. **Unchanged at the lowering level** — every
construct those WIs target is shaveable by definition (it's in the IR strict
subset). Glue code never reaches WASM lowering; it stays in its source language
and lowers via that language's normal toolchain.

**One material change:** wave-3 currently throws `LoweringError`
("unsupported-node") for AST kinds the visitor doesn't handle. Under the new
framing, those paths should emit `GlueLeafEntry` rather than throw (once
WI-V2-WAVE-3-LOWERING-GLUE-INTEGRATION lands as a follow-up). This is a
non-trivial improvement: it means a yakcc source file with mixed
shaveable+unshaveable constructs can partially shave rather than hard-failing.

**No current wave-3 WI acceptance criteria change** — the integration is a
follow-up (WI-V2-WAVE-3-LOWERING-GLUE-INTEGRATION), not a wave-3 re-spec.

---

## 2. Already-landed decisions that need revisiting

### DEC-SLICER-LOOP-CONTROL-FLOW-001

This decision documented the "atomic slicing on unsupported constructs" pattern
as the workaround for the strict-subset gate: when the slicer encounters a
control-flow construct it can't lower atomically, it loops at a coarser
granularity rather than failing.

**Under the new framing:** that loop was a workaround for the strict-subset
gate. Under shave-what-shaves, unsupported constructs simply become glue. The
loop pattern may still be appropriate for constructs that are shaveable but
require coarser slicing, but it is no longer the only option. WI-V2-SLICER-
SEARCH-ALG (follow-up ticket) will re-evaluate the loop pattern at
implementation time.

**Status:** DEC-SLICER-LOOP-CONTROL-FLOW-001 is superseded for the
"unsupported constructs" case by DEC-V2-GLUE-AWARE-SHAVE-001. The atomic-
slicing loop pattern survives for shaveable-but-coarse constructs until
WI-V2-SLICER-SEARCH-ALG makes a dispatch-time decision.

---

### DEC-RECURSION-005 — DidNotReachAtomError is a hard throw

This decision established that `decompose()` throws `DidNotReachAtomError`
rather than returning a partial tree.

**Under the new framing:** the correct behavior for an unsupported leaf is
`GlueLeafEntry`, not `DidNotReachAtomError`. The `DidNotReachAtomError` path
is still correct for cases where the recursion genuinely cannot bottom out
(e.g. infinite recursion, depth exceeded). But for "unsupported AST kind"
specifically, `GlueLeafEntry` is the right response.

**Status:** DEC-RECURSION-005 remains correct for its original motivation
(infinite recursion / depth exceeded). Its application to "unsupported-node"
cases is superseded by DEC-V2-GLUE-AWARE-SHAVE-001. WI-V2-SLICER-SEARCH-ALG
will implement the predicate-vs-throw split.

---

## 3. Follow-up tickets that may be resolved by glue-emit

### Issue #68 — record-equality with string fields

This issue was originally filed as a wave-3 lowering gap: the WASM lowering for
record equality with string fields required non-trivial implementation. Under
the glue-aware framing, record equality with string fields can emit a
`GlueLeafEntry` and be handled by the source-language toolchain (TS/JS string
equality is correct and well-defined). The explicit WASM-lowering extension for
this case may no longer be needed.

**Recommended action:** when WI-V2-WAVE-3-LOWERING-GLUE-INTEGRATION lands,
re-evaluate issue #68 against the glue-emit path. If glue-emit covers the
use case, close #68 as superseded.

---

## 4. Follow-up implementation tickets to file

These tickets are NOT in scope for this planning WI; they are filed after merge.

| Ticket | Description | Depends on |
|--------|-------------|-----------|
| WI-V2-GLUE-LEAF-CONTRACT | Add `GlueLeafEntry` to SlicePlan union; registry schema extension (glue not stored); compile pipeline slice-plan consumer update | DEC-V2-GLUE-AWARE-SHAVE-001 landed |
| WI-V2-SLICER-SEARCH-ALG | Rewrite slicer from "recurse-and-throw-on-unknown" to "find-maximal-shaveable-subgraphs" | WI-V2-GLUE-LEAF-CONTRACT |
| WI-V2-COMPILE-GLUE-AWARE | Extend `compileToTypeScript` and `compileToWasm` to handle GlueLeaf references | WI-V2-GLUE-LEAF-CONTRACT |
| WI-V2-WAVE-3-LOWERING-GLUE-INTEGRATION | Adjust wave-3 `LoweringError` paths to emit `GlueLeaf` where appropriate | WI-V2-SLICER-SEARCH-ALG |
| WI-V2-PoC-COMPRESSION-AUDIT | Re-spec WI-V2-08/09/10 under new framing; revised acceptance criteria reflecting glue-aware self-shave | WI-V2-WAVE-3-LOWERING-GLUE-INTEGRATION |

---

## 5. Cornerstones preserved

- **Glue stays per-project.** Sacred Practice #6 (monotonic registry: add, never
  delete) is preserved — glue is NOT in the registry. Glue identity is
  project-local; only `local` atoms are content-addressed.
- **IR strict-subset survives** as the per-subgraph predicate. Same rules,
  different scope of application.
- **Tool-reuse is non-negotiable** for new language frontends
  (DEC-V2-FRONTEND-TOOL-REUSE-001). Reimplementing a parser from scratch when
  tree-sitter-* exists violates Sacred Practice #5 at the META level.
- **No ownership.** GlueLeafEntry carries no author/email/signer metadata;
  DEC-NO-OWNERSHIP-011 holds.
