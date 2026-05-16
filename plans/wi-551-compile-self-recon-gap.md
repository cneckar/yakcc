# WI-551 — Compile-self reconstruction gap: 82 divergent roots

**Status:** planning (planner stage of `wi-551-compile-self-recon-gap`)
**Issue:** [#551](https://github.com/cneckar/yakcc/issues/551)
**Branch the runtime expected:** `feature/551-compile-self-recon-gap` (not yet created — see §10)
**Cross-refs:** #494 (original two-pass), #520 (seed-triplet fix), #545 (props-files class, CLOSED), #543 (import-intercept CanonicalAstParseError)

---

## 1. Problem statement

After #545 closed the props-files axis (45-46 roots) and #543 isolated the
`import-intercept.ts` CanonicalAstParseError (1057 gap rows), the two-pass
T3 byte-identity test still fails with **82 divergent atom roots across 10
source files**. Divergent here means: an atom's `blockMerkleRoot` produced
by pass-1 shave (fresh canonical source) differs from the `blockMerkleRoot`
produced by pass-2 shave (source reconstructed by `yakcc compile-self`).

The 10 files all shave successfully on both passes — unlike
`import-intercept.ts` (#543) which fails to shave at all on pass 2. They
produce *different* atoms because the reconstructed source differs from the
canonical source in ways that perturb at least one atom's `implSource`
bytes per file.

| File | Roots |
|---|---:|
| packages/registry/src/index.ts | 29 |
| packages/registry/src/storage.ts | 17 |
| packages/shave/src/intent/static-extract.ts | 13 |
| packages/shave/src/errors.ts | 6 |
| packages/contracts/src/source-extract.ts | 6 |
| packages/shave/src/universalize/slicer.ts | 5 |
| packages/cli/src/commands/bootstrap.ts | 2 |
| 3 more files | 1 each |
| **Total** | **82** |

T3 byte-identity for the whole corpus cannot reach `divergent=0` until this
class is addressed.

## 2. Investigation evidence (read-only)

Captured in `tmp/wi-551-investigation/`:

- `algorithm-analysis.md` — How the compile-self reconstruction algorithm
  can produce sources that re-shave to different atom merkle roots.
  Enumerates five mechanisms (M1–M5) and ranks them.
- `file-profile.md` — Feature profile of the 10 hot files; rules out two
  hypotheses from the issue body (re-export aggregation, type-system
  reformatting) by direct inspection.

No fresh `compile-self` run was executed (heavy compute, out of planner
scope). The on-disk `dist-recompiled/` directories are stale (empty top-level
or pre-P2 hash-keyed layout in `tmp/two-pass/`). The implementer slice
defined in §6 carries the reproduction step.

## 3. Hypothesis and categorization

The cluster pattern strongly supports a single root mechanism with a long
tail:

### Primary mechanism: **M3 — atom dedupe across files with whitespace divergence**

`bootstrap.ts` Pass A persists atoms via `INSERT OR IGNORE` keyed by
`blockMerkleRoot`. `blocks.implSource` is set the **first time** the atom
is observed in the corpus and is never overwritten. `block_occurrences`
records the atom's position per file and is refreshed atomically per file
on every bootstrap (`DEC-STORAGE-IDEMPOTENT-001`).

Consequence: when the same canonical-AST appears in multiple files with
slightly different surrounding bytes (different indentation, different
whitespace at the slice boundary), all occurrences are deduped to the
first-observed `blockMerkleRoot`. `compile-self` reconstruction emits the
**first-observed bytes** at every occurrence in every file. Pass-2 shave
then re-extracts the atom from the recompiled source, computes a
`blockMerkleRoot` over the **current file's bytes**, and gets a different
result → counted as divergent.

This explains:

- **Interface/class density correlation.** `registry/src/index.ts`
  (21 interfaces) and `errors.ts` (6 classes) score highest in
  small-declaration density. Small declarations have stable
  canonical-AST shapes and are statistically more likely to collide at
  `canonicalAstHash` than large function bodies.
- **The ~2.4% rate** (82 of ~3452 atoms). M3 is not catastrophic — only
  atoms whose dedupe target has bytewise-different surrounding context
  diverge.
- **The 1-root tail files.** These have a single declaration whose
  canonical-AST matches another file's atom with different bytes.

### Long-tail mechanism: **M2 — atom-end trivia attribution edge cases**

For some `Node.getEnd()` cases (ASI / no-semicolon / trailing-comment
boundaries) ts-morph can return a position that includes or excludes
trailing trivia inconsistently. If pass-1 and pass-2 disagree on the end
boundary, `implSource` shifts by a few bytes → new merkle root. Likely
accounts for a small fraction of the 82.

### Rejected hypotheses

- **Re-export aggregation flattening** — no file uses `export *` (verified
  by grep across all 10 named files).
- **Type-system reformatting (conditional types, mapped types, template
  literal types)** — no file uses `infer ` or `extends ... ?` (verified
  by grep).
- **`@decision` annotation stripping** — `@decision` blocks live in glue
  (they're leading trivia for declarations and `getStart()` skips trivia
  by default). Glue is captured verbatim by `captureSourceFileGlue` and
  re-emitted verbatim by `compile-self`. They cannot directly cause
  atom-byte drift, though they're abundant in the cluster.

### Estimated bucket distribution (best-effort, no live diff)

| Bucket | Mechanism | Estimated roots |
|---|---|---:|
| A | M3: atom dedupe across files with byte-different context | ~65 |
| B | M2: atom-end trivia attribution edge cases | ~15 |
| C | Other (unclassified until live diff) | ≤5 |

§6's first slice carries the diff that will sharpen these estimates.

## 4. Fix-locus decision

The issue body lists four options. Recommendation:

**Primary: (a) Fix `compile-self` to preserve more source fidelity.**

Rationale:

- **The bug is in the registry's atom-dedupe model, not in shave.** Shave
  computes correct atoms on both passes; both atoms have the same
  canonical-AST. The registry conflates them at `blockMerkleRoot` because
  `INSERT OR IGNORE` accepts whichever was observed first.
- **The two-pass test asserts byte-identity is the gate** for T3. Carving
  out files (option c) defers the architectural fix instead of resolving
  it — and the divergent set will silently grow as new files matching the
  same canonical-AST collide.
- **The fix is localized.** The dedupe model can be extended to record
  per-occurrence `implSource` bytes when they differ from the
  first-observed bytes, OR `compile-self` can reconstruct per-occurrence
  bytes by reading the original source-text slice from the canonical
  source (which means `compile-self` would need to know what the source
  used to look like — see §6 design tradeoff).

Rejected:

- **(b) Make shave tolerant** — perturbs the shave invariant that
  `implSource` is verbatim source text. Breaks proof-system assumptions
  downstream.
- **(c) Accept divergence + carve out** — silently grows; loses the T3
  bar permanently for new files entering the cluster.
- **(d) Hybrid (a)+(c)** — could be a fallback if (a) turns out to be
  prohibitively expensive in registry storage, but should not be the
  starting point.

## 5. State-authority map (affected surfaces)

| Domain | Canonical authority | Touched by fix? |
|---|---|---|
| Atom storage (blocks table) | `packages/registry/src/storage.ts` `storeBlock` | Yes if extending dedupe |
| Atom occurrence (per-file position) | `block_occurrences` table; `getAtomRangesBySourceFile` | Read-only; already accurate |
| Glue blob (per-file) | `source_file_glue` table; `captureSourceFileGlue` | Likely read-only |
| Reconstruction | `compile-self._runPipeline` | Yes — emits the wrong bytes today |
| Atom extraction | `packages/shave/src/universalize/recursion.ts` | Read-only |
| Canonical-AST hash | `packages/contracts/src/canonical-ast.ts` | Read-only |

**The fix bundle MUST land registry + compile-self + invariant test
together.** No parallel authorities (Sacred Practice #12).

## 6. First implementation slice (WI-551-S1)

### Title
Reproduce + confirm M3 on `packages/registry/src/index.ts` (29 roots).

### Scope (bounded — 1 PR, 1 day)

1. **Reproduction harness** (read-only):
   - Run `yakcc compile-self --output tmp/wi-551-recompiled` against the
     committed `bootstrap/yakcc.registry.sqlite`. Capture stdout +
     manifest.json.
   - Diff `tmp/wi-551-recompiled/packages/registry/src/index.ts` against
     `packages/registry/src/index.ts`. Capture as
     `tmp/wi-551-investigation/registry-index-diff.{txt,md}`.
   - For each diff hunk, locate the affected atom's `blockMerkleRoot` via
     `manifest.json`, query `blocks.implSource` for that root, and
     identify the **first-observed file** that supplied those bytes.
   - Tabulate: `(merkleRoot, current-file-bytes, first-observed-file,
     first-observed-bytes, byte-delta-character-class)`.
   - Confirms M3 if at least 24 of the 29 roots (~80%) are dedupes from
     a different file with byte-different bytes.

2. **Categorization deliverable**: `tmp/wi-551-investigation/m3-evidence.md`
   tabulating the 29 roots and their dedupe sources. No fix code in this
   slice.

3. **Decide between two implementation options for the next slice (S2)**:
   - **S2-Option-A**: Extend the `blocks` table with a per-occurrence
     `implSource` override column, populated when dedupe finds
     byte-different bytes. `compile-self` prefers the override when
     present. Pros: minimal storage change. Cons: requires migration.
   - **S2-Option-B**: `compile-self` reconstructs `implSource` per
     occurrence by re-slicing from a per-file "atom-byte-overrides" blob
     stored alongside the glue blob. Pros: localized to compile-self +
     bootstrap. Cons: doubles per-file storage in worst case.
   - Record the decision in `plans/wi-551-s1.md` as DEC-WI-551-S1-IMPL.

### Acceptance (S1 only)

- `tmp/wi-551-investigation/registry-index-diff.md` exists and shows the
  29-root diff hunks against canonical source.
- `tmp/wi-551-investigation/m3-evidence.md` tabulates each of the 29
  roots with `first-observed-file` and `byte-delta` columns.
- A DEC-WI-551-S1-IMPL row is appended to `plans/wi-551-s1.md` naming
  the chosen S2 path (A or B) with rationale.
- No source files edited under `packages/**`.

### Out of scope (S1)

- Building the fix itself (S2's job).
- Reproducing for all 10 files (S1 covers the 29-root canary; if M3 is
  confirmed there, it's confirmed for the cluster).
- Touching the other 9 hot files' atom-extraction code.

### Pre-push hygiene (S1 acceptance evidence)

Per global memory `feedback_branch_must_track_origin_main`:

- `git fetch origin && git diff --stat origin/main..HEAD` shows ONLY the
  S1 investigation artifacts under `tmp/wi-551-investigation/` and
  `plans/wi-551-s1.md`.
- `pnpm -w lint` and `pnpm -w typecheck` pass (no source edits, so these
  should be near-instant — but they still run in CI).
- No `packages/**` files in the diff.

## 7. Evaluation Contract (WI-551-S1)

| Field | Value |
|---|---|
| Required tests | None (read-only investigation). Existing `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts` must still be skipped/red as before — S1 does not flip it. |
| Required real-path checks | (a) `yakcc compile-self` executes against current registry without error. (b) `manifest.json` parses as the expected shape `Array<{outputPath, blockMerkleRoot, sourcePkg, sourceFile, sourceOffset}>`. (c) Output diff against canonical `registry/src/index.ts` is non-empty (proves the divergence is reproducible). |
| Required authority invariants | `block_occurrences` and `blocks.implSource` are read-only during S1. No writes to the SQLite registry. |
| Required integration points | None changed. S1 reads from `bootstrap/yakcc.registry.sqlite` and writes to `tmp/wi-551-investigation/`. |
| Forbidden shortcuts | (1) NEVER edit any file under `packages/**` in S1. (2) NEVER write a fix that "looks plausible" without the diff evidence. (3) NEVER carve out the 10 files from the two-pass test as a stopgap — that's option (c) above and was explicitly rejected. (4) NEVER claim S1 done if the diff is empty (would mean reproduction failed; investigate why instead). |
| Ready-for-guardian when | All three S1 acceptance artifacts (registry-index-diff.md, m3-evidence.md, DEC-WI-551-S1-IMPL row) exist, the diff is non-empty, the m3-evidence table covers all 29 roots, pre-push hygiene passes, and the implementer/reviewer agree on the S2 implementation choice. |

## 8. Scope Manifest (WI-551-S1)

| Field | Value |
|---|---|
| Allowed paths | `tmp/wi-551-investigation/**`, `tmp/wi-551-recompiled/**` (compile-self output), `plans/wi-551-s1.md` |
| Required paths | `tmp/wi-551-investigation/registry-index-diff.md`, `tmp/wi-551-investigation/m3-evidence.md`, `plans/wi-551-s1.md` |
| Forbidden touch points | `packages/**`, `src/**`, `.github/**`, `.claude/**`, `MASTER_PLAN.md`, `bootstrap/yakcc.registry.sqlite` (read-only — do NOT regenerate during S1) |
| Expected state authorities touched | None (read-only on registry; writes only to tmp + plans) |

## 9. Risks

1. **False-negative reproduction.** If the registry on `main` has been
   regenerated since #545 landed, the divergent set may have shifted.
   Mitigation: S1 captures the actual current divergent count from
   `compile-self` output and notes any delta from the issue body's 82.
2. **M3 not confirmed.** If the diff evidence does not show cross-file
   dedupe, the primary mechanism is wrong and S2 needs re-planning. S1
   acceptance includes "the m3-evidence table shows the dedupe pattern"
   — if it doesn't, S1 returns to planner with a revised hypothesis,
   not to S2.
3. **Compile-self fix breaks other invariants.** The S2 fix touches the
   registry's dedupe authority. Risk: existing federation / corpus
   distribution invariants assume single-`implSource`-per-merkle-root.
   Mitigation: S2 plan must include an invariant audit before any code.
4. **Storage bloat (S2-Option-A).** Per-occurrence implSource overrides
   could in the worst case double atom storage. Probably not — the 82
   divergent roots are a tiny fraction — but the S2 plan must measure
   actual delta on the yakcc corpus before committing.

## 10. Runtime/branch state note

The ClauDEX dispatch contract names `feature/551-compile-self-recon-gap`
as the workflow branch with worktree `.worktrees/feature-551-compile-self-recon-gap`.
**Neither exists** on the current host at planner-stage start. This planner
ran against the main checkout, producing only governance artifacts (this
plan + `tmp/wi-551-investigation/`). Source edits remain forbidden on main.

Before S1 implementer dispatch, Guardian provisioning must:

1. Create the worktree at the runtime-named path.
2. Set up the branch to track `origin/main` (per memory
   `feedback_branch_must_track_origin_main`).
3. Sync the Scope Manifest in §8 via
   `cc-policy workflow scope-sync wi-551-compile-self-recon-gap --work-item-id wi-551-s1 --scope-file <file>`.

## 11. #551 final state

Multi-mechanism (M3 primary, M2 tail, possibly others). **#551 becomes the
meta-issue.** The first slice (WI-551-S1 above) is its actionable child. The
issue body should be updated to reflect:

- Mechanism categorization from this plan
- Link to plans/wi-551-compile-self-recon-gap.md
- Link to the S1 child issue (to be filed by the orchestrator)
- #551 stays OPEN until divergent count hits 0 (covers S1 confirming
  reproduction + S2 implementing fix + S3 verifying the other 9 files)

## 12. Decision log entries (this plan)

| DEC-ID | Decision | Rationale |
|---|---|---|
| DEC-WI-551-FIX-LOCUS-001 | Primary fix locus is `compile-self` + registry dedupe model (option a), not shave tolerance or carve-out | §4 |
| DEC-WI-551-REJECT-CARVEOUT-001 | Carving the 10 files out of T3 byte-identity is rejected | §4 — silently grows the divergent set; loses the T3 bar permanently |
| DEC-WI-551-S2-OPTIONS-001 | S2 has two viable implementation paths (per-occurrence override column OR per-file override blob); pick in S1 based on diff evidence | §6 — need actual byte-delta data before committing to either storage shape |
