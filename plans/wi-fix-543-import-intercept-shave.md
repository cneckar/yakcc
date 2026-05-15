# WI-FIX-543-IMPORT-INTERCEPT-SHAVE — `compile-self` strips UTF-8 BOM on glue-blob round-trip, breaking pass-2 shave of `import-intercept.ts`

**Status:** plan v1
**Issue:** #543
**Branch:** `feature/wi-fix-543-import-intercept-shave` (worktree `.worktrees/wi-fix-543-import-intercept-shave`)
**Class:** Same family as #494 / #545 (two-pass equivalence regressions surfaced inside `compile-self`'s reconstruction).
**Locus:** `compile-self` (option a from dispatch prompt). One-line fix in `packages/cli/src/commands/compile-self.ts`. Distinct from #551 (subtle output drift across 82 other atoms — different mechanism, see §6).

---

## 0. TL;DR

Bootstrap pass 2 fails on `packages/hooks-base/src/import-intercept.ts` because **`compile-self` strips a UTF-8 BOM during glue-blob decode**, shifting every subsequent character offset by one and producing invalid TypeScript (`Declaration or statement expected`).

The bug is a single line in `packages/cli/src/commands/compile-self.ts` (currently L615):

```ts
const glueString = new TextDecoder().decode(glueEntry.contentBlob);
```

Per the WHATWG Encoding spec, `new TextDecoder()` defaults to `ignoreBOM: false`, which **silently strips a leading UTF-8 BOM** from the decoded string. `import-intercept.ts` starts with a U+FEFF BOM (`EF BB BF` in UTF-8). Bootstrap stores the glue blob with the BOM bytes preserved (correct). Reconstruction decodes them, drops the BOM character, and the `glueString` is now one UTF-16 code unit shorter than the atom-range arithmetic assumes. The recomposed file is exactly 1 char shorter than the original, and the first cross-atom glue slice yanks chars from the wrong region of the glue string — the visible "spurious `;`" pattern in §1.

**Fix (one line):**

```ts
const glueString = new TextDecoder("utf-8", { ignoreBOM: true }).decode(glueEntry.contentBlob);
```

Reproduced and verified with an in-memory shave + reconstruct script (`tmp/wi-fix-543-import-intercept-shave/repro.mjs`):

- Pre-fix recon length 18619 vs orig 18620; first divergence at offset 5176 (BOM-stripped offset); recon fails `canonicalAstHash` with "Declaration or statement expected" matching the CI failure exactly.
- Post-fix recon length 18620 = orig 18620, **`IDENTICAL`** byte-for-byte; recon parses cleanly.

`import-intercept.ts` is the ONLY non-skipped `.ts` file in the corpus with a BOM (the other 5 BOM files are tests / `*.props.ts` skipped by `bootstrap.shouldSkip`). The fix is fully backward compatible — files without a BOM round-trip identically under both decoder configurations.

---

## 1. Reproduction (already executed; this section captures evidence)

### 1.1 Setup

`pnpm install --frozen-lockfile && pnpm -r build` (all packages green on this branch off `origin/main 376240e`).

### 1.2 Repro script

`tmp/wi-fix-543-import-intercept-shave/repro.mjs` (scratchlane). The script:

1. Opens a `:memory:` registry with zero-vector embeddings.
2. Calls `@yakcc/shave`'s `shave()` directly on `packages/hooks-base/src/import-intercept.ts`, mirroring `bootstrap.ts`'s flow (per-file occurrence accumulator, pointer-pass resolution, dedup-by-offset).
3. Calls `replaceSourceFileOccurrences` + `computeGlueBlob` (from `@yakcc/cli/bootstrap.ts`) + `storeSourceFileGlue` exactly as bootstrap does.
4. Runs `compile-self`'s reconstruction algorithm in-memory (`listOccurrencesBySourceFile`, `getSourceFileGlue`, `TextDecoder().decode()`, merged-interval walk, glue+atom interleave).
5. Compares the reconstruction to the original character-by-character, then runs `canonicalAstHash()` (the same parser path `bootstrap` pass 2 uses) on the result.

### 1.3 Pre-fix output (BUG)

```
source UTF-16: 18620 UTF-8: 18623
BOM: true
atoms: 47
occurrences: 47 glue bytes: 12100
first 5 ranges: [{"start":5177,"end":5233},{"start":5234,"end":5282}, ...]
recon length: 18619 orig: 18620
FIRST DIFF at offset: 0
  ORIG  : "﻿// SPDX-License-Identifier: MIT\n// @decision DEC-WI508-INTERCEPT-001\n..."
  RECON : "// SPDX-License-Identifier: MIT\n// @decision DEC-WI508-INTERCEPT-001\n..."

parse recon:
  ERROR: TypeScript syntax error(s) in source: Declaration or statement expected.
  diag: ["Declaration or statement expected.","Property or signature expected.","Expression expected.","Expression expected.","Declaration or statement expected."]
parse orig:
  OK
```

The recon is **1 UTF-16 code unit shorter than the original**. The BOM at orig[0] is missing. Re-checking the diff against a BOM-stripped original locates the second-order divergence at offset 5176 (in BOM-stripped coords):

```
ORIG  (BOM-stripped):  "...telemetry.\n\nimport type { QueryIntentCard } from \"@yakcc/contracts\";\nimpor"
RECON               :  "...telemetry.\n;\nimport type { QueryIntentCard } from \"@yakcc/contracts\";\nimpo"
```

The reconstruction emits `\n;\n` where the original has `\n\nimport type ...;`. The `;` was pulled out of the glue span between atom 0 (`...\nimport type { QueryIntentCard } from "@yakcc/contracts"`) and atom 1, and inserted one slot earlier — directly because `gluePosCursor` (which is incremented by original-coord deltas) walked past the actual end of `glueString` (BOM-stripped, one shorter).

### 1.4 Post-fix output (clean)

Patching the single line `const glueStr = new TextDecoder().decode(...)` → `new TextDecoder("utf-8", { ignoreBOM: true }).decode(...)`:

```
source UTF-16: 18620 UTF-8: 18623
BOM: true
atoms: 47
occurrences: 47 glue bytes: 12100
recon length: 18620 orig: 18620
IDENTICAL

parse recon:
  OK
parse orig:
  OK
```

Recon is byte-identical to original. `canonicalAstHash` succeeds — pass 2 would shave it cleanly.

### 1.5 BOM-bearing files in the corpus

Of the 469 `.ts` files in `packages/` + `examples/`, exactly **6 carry a leading UTF-8 BOM (U+FEFF)**:

| File | Skipped by `bootstrap.shouldSkip`? | Reason |
|---|---|---|
| `packages/hooks-base/src/import-intercept.ts` | **No (atom-source)** | the failing file |
| `packages/compile/src/import-gate.test.ts` | Yes | `*.test.ts` |
| `packages/hooks-base/test/atomize-delegates.test.ts` | Yes | `*.test.ts` |
| `packages/hooks-base/test/import-intercept-integration.test.ts` | Yes | `*.test.ts` |
| `packages/hooks-base/test/import-intercept.test.ts` | Yes | `*.test.ts` |
| `packages/shave/src/corpus/documented-usage.props.ts` | Yes | `*.props.ts` |

**`import-intercept.ts` is the only atom-source file with a BOM in the entire corpus.** This is why the bug surfaced specifically here when #539 landed it — the other BOM-carriers never reach the shave/reconstruct path, so the BOM-strip latent defect didn't have a victim until now.

The BOMs are an artifact of `#539`'s editing pipeline (likely a Windows editor / PowerShell `Out-File` step that defaults to UTF-8-with-BOM, which Node + TS happily accept on read).

### 1.6 Mechanism (formal explanation)

The reconstruction algorithm assumes `glueString.charAt(i)` corresponds to original-source character at position `i + cumulative_atom_widths_before_i`. Concretely:

```ts
let prevMergedEnd = 0;        // walks in ORIGINAL-FILE coordinates
let gluePosCursor = 0;        // walks in glueString coordinates
for (const interval of mergedIntervals) {
  const glueBetween = interval.start - prevMergedEnd;
  parts.push(glueString.slice(gluePosCursor, gluePosCursor + glueBetween));
  gluePosCursor += glueBetween;
  ...
  prevMergedEnd = interval.end;
}
```

This is correct **iff `glueString.length` equals the total of all glue spans in original coordinates**. With `TextDecoder()` defaults (`ignoreBOM: false`), a leading BOM in the encoded blob is silently dropped on decode, making `glueString.length` exactly `original_total_glue - 1` (assuming exactly one BOM at the very start of the first glue region).

After one BOM-strip, the cursor drifts ahead of glueString by 1 char permanently. The first cross-atom glue slice past the BOM region yanks bytes from one region too far, producing visible content corruption — in this case, the `;` from glue span 2 (`[5233..5234)`) bleeds into the prefix slice for atom 0, and span 3's first char takes its place between atoms 0 and 1.

The downstream effect happens to be a TS parse error in this file because the corruption injects a bare `;` between the comment-block trailer and the first `import type` statement (well-formed TS at that position is `\n\nimport ...`, the corrupted form is `\n;\nimport ...`). A bare `;` is technically a valid empty statement in TS, but the parser actually fails on a deeper cascade — likely because the cumulative drift produces a further malformed construct downstream. Regardless of the exact parser cascade, the byte-level evidence is unambiguous: **recon ≠ orig, drift = 1 char, BOM is gone**. The fix is mechanical.

---

## 2. Locus decision (a / b / c)

The dispatch prompt asked for one of three loci:
- (a) `compile-self` bug
- (b) refactor `import-intercept.ts` to avoid the trigger construct
- (c) both — narrow workaround + deeper fix

**Recommendation: (a). One-line fix in `compile-self.ts`.**

Rationale:

1. **The defect is structurally in `compile-self`.** `bootstrap` encodes the glue blob with the BOM bytes preserved (correctness held). The decode side strips them. This is a quiet violation of the round-trip invariant that the reconstruction algorithm depends on.
2. **The fix is mechanical and one line.** No new authority, no schema change, no expected-roots regen impact beyond the file in question. The decoder option is the standard documented way to preserve a BOM.
3. **The fix is fully backward compatible.** Files without a BOM round-trip identically under `ignoreBOM: true` (the BOM-strip only fires when bytes 0-2 of the input are `EF BB BF`). All 463 BOM-free files in the corpus are unaffected.
4. **Option (b) leaves a latent foot-gun.** Editing the BOM out of `import-intercept.ts` solves the symptom but the next Windows-authored file with a BOM (or the next `Out-File` from a PowerShell session) reintroduces the exact same failure. With `compile-self` as the single authority for source-file reconstruction (Sacred Practice #12), the fix belongs there.
5. **Option (c) is unnecessary.** Once (a) is in, (b) is moot. We can opportunistically normalise `import-intercept.ts` to strip the BOM (it adds zero semantic value), but it must not be the load-bearing fix — it would mask the underlying defect.

This is the same architectural pattern as #545: the bug surfaced inside `compile-self`'s reconstruction; the fix is in `compile-self` / its bootstrap-side capture, not in the atom-source. The #545 fix added `*.props.ts` to `PLUMBING_INCLUDE_GLOBS`; here the fix tightens `TextDecoder` semantics. Both close a specific class of pass-1-vs-pass-2 drift introduced by a leak in the reconstruction round-trip.

### 2.1 Optional housekeeping (recommended, not load-bearing)

After the canonical fix lands, normalise `packages/hooks-base/src/import-intercept.ts` to strip its leading BOM. This is **purely cosmetic** — it has no semantic effect on TS and reduces noise in editors that surface BOMs. It is **NOT a substitute for the `compile-self` fix** and must not be done alone; the bug class would resurface immediately. Track as a small follow-up commit inside the same PR if convenient, or as a separate hygiene WI later.

---

## 3. The fix

### 3.1 Primary change — `packages/cli/src/commands/compile-self.ts`

Line ~615, inside `_runPipeline`'s reconstruction step, the glue decode:

**Before:**

```ts
const glueString = new TextDecoder().decode(glueEntry.contentBlob);
```

**After:**

```ts
// @decision DEC-V2-COMPILE-SELF-GLUE-DECODE-IGNOREBOM-001
// @title compile-self glue decode preserves UTF-8 BOM bytes
// @status decided (WI-FIX-543, issue #543)
// @rationale
//   `new TextDecoder()` defaults to `ignoreBOM: false`, which silently strips
//   a leading UTF-8 BOM (U+FEFF) from the decoded string. That breaks the
//   round-trip invariant the reconstruction algorithm depends on: glueString
//   length must equal the sum of all glue-span lengths in original-source
//   coordinates. A BOM-carrying source file would otherwise produce a
//   reconstructed string one UTF-16 code unit shorter than the original,
//   shifting every cross-atom glue slice by one position past the BOM region
//   and yielding invalid TypeScript. `ignoreBOM: true` preserves the BOM as a
//   U+FEFF code unit in the decoded string, exactly mirroring the bytes
//   `bootstrap.captureSourceFileGlue` stored. Files without a BOM are
//   unaffected. Validates: issue #543, packages/hooks-base/src/import-intercept.ts.
const glueString = new TextDecoder("utf-8", { ignoreBOM: true }).decode(glueEntry.contentBlob);
```

That is the only source-code change required to close #543.

### 3.2 Regression test — `examples/v2-self-shave-poc/test/compile-self-integration.test.ts` (or equivalent)

Add a focused unit test that exercises the BOM round-trip without requiring a full two-pass cycle. Suggested shape:

```ts
it("compile-self glue decode preserves leading UTF-8 BOM (issue #543, DEC-V2-COMPILE-SELF-GLUE-DECODE-IGNOREBOM-001)", async () => {
  // Use an :memory: registry. Shave a synthetic file whose source text starts
  // with U+FEFF and contains at least one atom and one glue region. Run the
  // compile-pipeline against the in-memory registry and assert the recompiled
  // file is byte-identical to the source.
  ...
});
```

The test must hard-fail loudly if the recon differs from the source by even one character, and must not rely on the real bootstrap workspace (so it runs in seconds, not minutes). This guards against any future regression that re-introduces a default `TextDecoder()` on a glue blob.

### 3.3 (Optional housekeeping) — strip the BOM from `import-intercept.ts`

Outside the load-bearing fix, but recommended in the same PR as a hygiene cleanup. Removes editor noise and the only currently-shaved BOM source in the corpus. Must be done **after** §3.1 lands so the test infrastructure has at least one real BOM-carrying file in history that proved the fix works.

### 3.4 (Out of scope) — `compile-pipeline.ts` (under `examples/v2-self-shave-poc/src/`)

`examples/v2-self-shave-poc/src/compile-pipeline.ts` is the canonical testable module for the compile-self pipeline (see comment in `compile-self.ts:317-319`). If it contains a similar `new TextDecoder().decode(...)` of a glue blob, it must receive the **same** fix as §3.1, because the example pipeline can drift from the CLI implementation and the test infrastructure references it. Implementer to grep for `new TextDecoder().decode` inside `examples/v2-self-shave-poc/src/` during implementation and apply the same edit if found. This is a parity sweep, not a separate concern; it belongs in the same PR. (Tracked as required real-path check 5 in §5.)

---

## 4. Scope Manifest

### Allowed (implementer may modify)

- `packages/cli/src/commands/compile-self.ts` — the one-line decoder change + `@decision` annotation block.
- `examples/v2-self-shave-poc/src/compile-pipeline.ts` — same decoder change if the parallel call site exists (parity sweep per §3.4).
- One new or amended unit test, preferably in `examples/v2-self-shave-poc/test/compile-self-integration.test.ts` (existing file) — the focused BOM round-trip guard from §3.2.
- `packages/hooks-base/src/import-intercept.ts` — **only** to strip the leading BOM (§3.3, optional). No semantic edits to this file.
- `plans/wi-fix-543-import-intercept-shave.md` — this file; implementer may append an "Implementation notes" appendix.
- `bootstrap/expected-roots.json`, `bootstrap/CORPUS_STATS.md`, `bootstrap/expected-failures.json` — regeneration as needed if the test infrastructure determines a regen is required (see §5).

### Required (must be modified for the fix to land)

- `packages/cli/src/commands/compile-self.ts`
- One regression test guarding the BOM round-trip (location flexible; see §3.2).

### Forbidden (must not be touched)

- Anything inside `packages/shave/` — the shave-side offset arithmetic is correct; do not touch ranges, the slicer, the universalize loop, or corpus extractors.
- Anything inside `packages/registry/` except as required by the test infrastructure for openRegistry calls — the storage layer is correct; the BOM bytes round-trip cleanly through `storeSourceFileGlue` / `getSourceFileGlue`.
- `packages/cli/src/commands/bootstrap.ts` — `captureSourceFileGlue` / `computeGlueBlob` are correct; the bug is exclusively on the decode side in `compile-self.ts`.
- `packages/cli/src/commands/plumbing-globs.ts` — irrelevant to this defect; do not touch.
- Anything inside `packages/contracts/`, `packages/compile/`, `packages/federation/`, `packages/variance/`, `packages/ir/`, `packages/hooks-*` (except the BOM strip in §3.3), `packages/seeds/`.
- The 5 other BOM-carrying files (4 test files + 1 props file) — they are not shaved; touching them adds noise without value.
- `MASTER_PLAN.md` — governance file; not part of this fix. Amendment, if any, is deferred to a separate planner pass per the WI-545 precedent (see §8).

### State authorities touched

- **Source-file glue decode authority** (`packages/cli/src/commands/compile-self.ts` `_runPipeline`) — a single decoder construction call gains the `{ ignoreBOM: true }` option. Same authority surface; no new module, no new mechanism. `DEC-V2-COMPILE-SELF-GLUE-INTERLEAVING-001` is **amended** by `DEC-V2-COMPILE-SELF-GLUE-DECODE-IGNOREBOM-001` (the latter narrows the decode contract; the merge-interval algorithm is unchanged).
- **Bootstrap reproducibility authority** (`bootstrap/expected-roots.json`) — may not need a regen if no atom's `block_merkle_root` changes. If post-fix two-pass produces zero divergent atoms involving `import-intercept.ts` or any other file affected by the round-trip, no regen is required. Implementer reports the observed state in the Evaluation Contract.
- **Two-pass invariant authority** — strengthened: pass 2 now succeeds on `import-intercept.ts`, restoring the `T1`/`T3` shave-equivalence property for that file.

### Decisions emitted by this plan

- `DEC-V2-COMPILE-SELF-GLUE-DECODE-IGNOREBOM-001` — `compile-self`'s `TextDecoder` for glue blobs must use `ignoreBOM: true`. Amends `DEC-V2-COMPILE-SELF-GLUE-INTERLEAVING-001`.

---

## 5. Evaluation Contract

### Required tests (must pass)

1. **TOP ITEM (load-bearing gate)** — Bootstrap pass 2 successfully shaves `packages/hooks-base/src/import-intercept.ts` and the T3 byte-identity comparison step in `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts` runs to completion on this branch. The `CanonicalAstParseError — TypeScript syntax error(s) in source: Declaration or statement expected` failure on this file must be gone from the pass-2 log.

2. **Focused BOM round-trip unit test passes** (the test added in §3.2). This test must:
   - Construct a synthetic source string that starts with U+FEFF and contains at least one atom + one glue region.
   - Run a full shave → store-occurrences → store-glue → list-occurrences → get-glue → reconstruct cycle in-memory.
   - Assert the reconstructed string is **strictly byte-identical** (UTF-16 code-unit-identical) to the source.
   - Run as a default unit test (no `YAKCC_TWO_PASS` gate) so the guard runs on every `pnpm -r test`.
   - Loud failure naming the first divergent character offset.

3. **Default test suite stays green:** `pnpm -r test` passes with no new failures or skips.

4. **`packages/cli` builds clean:** `pnpm --filter @yakcc/cli build` succeeds; `packages/cli/dist/commands/compile-self.js` contains the `ignoreBOM: true` option literal.

5. **Two-pass T3 advances** — `YAKCC_TWO_PASS=1 pnpm --filter @yakcc/v2-self-shave-poc test` runs all the way to the T3 comparison step (does not exit before assertion). Whether T3 itself passes or surfaces residual divergences is informational — those residuals are #551 territory (see §6). The bar for this WI is **T3 reaches its assertion, the `import-intercept.ts` parse error is gone, and `import-intercept.ts`'s `block_merkle_root` matches between passes**. If the residual #551 count drops because of this fix (some divergences may have been caused by the BOM mechanism on other BOM-bearing files that are now correctly excluded by skip rules), record it; if not, the #551 count being unchanged is acceptable.

### Required real-path checks (production-sequence verifications)

1. **Repro replication first.** Before editing source, the implementer should run `node tmp/wi-fix-543-import-intercept-shave/repro.mjs` and confirm:
   - Pre-fix: `recon length: 18619 orig: 18620`, `FIRST DIFF at offset: 0`, parse error on recon matches CI.
   - Then apply the fix (§3.1) to `packages/cli/dist/commands/compile-self.js` directly (or via a rebuilt CLI) and re-run the repro — it must report `IDENTICAL` and `parse recon: OK`.

   This confirms the fix is on the right line before the implementer touches the source. The repro script is purely diagnostic; do not commit it.

2. **Build artefact check.** After `pnpm --filter @yakcc/cli build`, grep `packages/cli/dist/commands/compile-self.js` for the literal `ignoreBOM` — if absent, the build is stale. This is the same trap WI-545 named as FS-4.

3. **`import-intercept.ts` byte-identity in `dist-recompiled/`.** After the fix, running `yakcc compile-self` against a bootstrap registry that contains `import-intercept.ts` atoms must produce a `dist-recompiled/packages/hooks-base/src/import-intercept.ts` that is byte-identical to the original (modulo the optional BOM strip per §3.3). The implementer reports `diff <(xxd packages/hooks-base/src/import-intercept.ts) <(xxd dist-recompiled/packages/hooks-base/src/import-intercept.ts)` output (must be empty if the BOM is not stripped; differs only on the first 3 bytes if §3.3 is also applied).

4. **`block_merkle_root` for `import-intercept.ts` atoms is consistent across two-pass passes** after the fix. Implementer reports the count of `import-intercept.ts` atoms in both pass-1 and pass-2 registries and confirms zero divergent block_merkle_roots for this file in particular.

5. **`compile-pipeline.ts` parity sweep.** Grep `examples/v2-self-shave-poc/src/compile-pipeline.ts` for `new TextDecoder().decode`. If a parallel call decodes a glue blob there, apply the same fix to that site in the same PR. Report the result of the grep (zero matches → no parity-site edit; one or more → fix each and report counts).

### Required authority invariants

- `DEC-V2-COMPILE-SELF-GLUE-INTERLEAVING-001`'s merged-interval algorithm is preserved (not weakened). Only the decoder construction call is modified.
- `DEC-V2-GLUE-CAPTURE-AUTHORITY-001` (bootstrap-side glue capture) is unchanged — the stored bytes are correct; the bug was on the read side only.
- `DEC-V2-HARNESS-STRICT-EQUALITY-001`'s byte-identity invariant is preserved and **strengthened** in the BOM case — the recon now round-trips correctly.
- Sacred Practice #12 (Single Source of Truth) — `compile-self` is and remains the single authority for source-file reconstruction; no parallel path is introduced.

### Required integration points

- `getSourceFileGlue` (`packages/registry/src/storage.ts`) → returns `contentBlob: Uint8Array`. **Unchanged**; bytes already preserved correctly.
- `TextDecoder("utf-8", { ignoreBOM: true })` → produces a JS string that preserves U+FEFF code units. **Used in** `compile-self.ts:615` only.
- `getSourceFileContentHash` (cache check at bootstrap pass 2 start) → still uses `blake3(TEXT_ENCODER.encode(sourceText))` over the on-disk file. **Unchanged**; the file content is read with BOM preserved, so the cache identity is unchanged.
- `canonicalAstHash` (`packages/contracts/src/canonical-ast.ts`) → ts-morph parser sees BOM as the same `0xFEFF` code unit it always did. **Unchanged**.

### Forbidden shortcuts

- **FS-1.** NEVER replace the `TextDecoder()` call with manual byte-stripping logic or a custom decoder. The fix is the documented `ignoreBOM: true` option; reinventing it adds risk without value.
- **FS-2.** NEVER "just strip the BOM from `import-intercept.ts`" as the sole fix. That option (b) leaves the underlying defect to bite the next BOM-bearing file. The atom-source edit is **only** optional housekeeping per §3.3, and only after §3.1 has landed.
- **FS-3.** NEVER touch `bootstrap.captureSourceFileGlue` or `computeGlueBlob`. The bug is on the decode side; the encode side is correct. A "fix" on the encode side would change every glue blob in the registry and force a full regen for no reason.
- **FS-4.** NEVER skip the `pnpm --filter @yakcc/cli build` before re-running `compile-self` against a registry. Stale `dist/` will not pick up the source change (same trap as WI-545 FS-4).
- **FS-5.** NEVER skip the focused unit test from §3.2 even if the two-pass T3 is green. The two-pass is a 60+ minute test; a fast unit guard belongs in the default suite so regressions surface immediately.
- **FS-6.** NEVER claim the fix is complete based only on `import-intercept.ts` parsing in pass 2. The `block_merkle_root` for this file's atoms must also match between passes (Required real-path check 4).
- **FS-7.** NEVER expand the scope to fix #551's residual divergences in this PR. #551 is a distinct mechanism (subtle output drift, not parse failure) and has its own planner cycle. A net reduction in the #551 count is a happy side-effect; an unchanged count is acceptable.
- **FS-8.** NEVER bundle unrelated changes (e.g., a `bootstrap.ts` cleanup, a refactor of `_runPipeline`, an alternative slicer). The Scope Manifest in §4 is binding.

### Ready-for-Guardian checklist (numbered)

Reviewer may declare `REVIEW_VERDICT=ready_for_guardian` only when ALL of the following are demonstrably true. Item 1 is the top-line gate the user named.

1. **`packages/hooks-base/src/import-intercept.ts` shaves successfully in two-pass pass 2.** The `CanonicalAstParseError — TypeScript syntax error(s) in source: Declaration or statement expected` failure is gone from the pass-2 log; T3 reaches its assertion. PR description shows the relevant log lines.
2. **Focused BOM round-trip unit test (§3.2) is added and passes** in the default `pnpm -r test` run. PR description includes the test output.
3. **`packages/cli` builds clean** and `packages/cli/dist/commands/compile-self.js` contains the literal `ignoreBOM`.
4. **`pnpm -r test` is green** with no new failures and no new skips.
5. **`block_merkle_root` for `import-intercept.ts` atoms matches between two-pass pass 1 and pass 2.** Implementer reports the count of `import-intercept.ts`-sourced atoms in both registries and a one-line confirmation that all roots match.
6. **`dist-recompiled/packages/hooks-base/src/import-intercept.ts` is byte-identical to the canonical source** (modulo the optional BOM strip from §3.3 if applied). Implementer reports the `cmp` or `xxd diff` result.
7. **`@decision DEC-V2-COMPILE-SELF-GLUE-DECODE-IGNOREBOM-001`** is in place on the modified call site in `compile-self.ts` with full rationale.
8. **Parity sweep complete:** `examples/v2-self-shave-poc/src/compile-pipeline.ts` was grepped and either contains no parallel `new TextDecoder().decode` of a glue blob, or any such site received the same fix in this PR. Implementer reports the result.
9. **Scope Manifest compliance** verified by reviewer — no forbidden file modified.
10. **#551 count snapshot:** the residual divergent-roots count from a clean two-pass on this branch is reported in the PR description, pre-fix and post-fix. The fix's effect on #551 (whether net-reducing, unchanged, or net-increasing) is documented as informational; if net-increasing, halt and escalate (the fix should never make things worse).

---

## 6. Relationship to #551

**#551** tracks 82 divergent `block_merkle_root` values from "imperfect compile-self reconstruction" — i.e., the recomposed source differs subtly from the canonical source on files OTHER than `import-intercept.ts`. The hypothesis at #551 filing time was that the divergences arise from glue-interleave edge cases (multi-offset atoms, overlapping atoms, glue regions on whitespace-only boundaries).

**The #543 mechanism is distinct.** The BOM round-trip defect affects ONLY files with a leading UTF-8 BOM. After the §1.5 enumeration, only `import-intercept.ts` is in this class among shaved files. So the BOM fix:

- closes #543 (the parse-failure on `import-intercept.ts`),
- reduces divergent count by 1 (the `import-intercept.ts` atoms),
- but does **not** touch the 82 other divergences that #551 tracks (those have a different cause and live in non-BOM files).

The expected outcome of this WI: the divergent-root count goes from `(82 + the import-intercept.ts atom count)` to `82`. If the count drops by more than the `import-intercept.ts` atoms, that is unexpected and worth noting in the PR description, but it doesn't change the bar for this WI.

**#551 stays open as its own planner cycle.** Conflating it with #543 would muddy diagnosis and likely produce a too-broad PR with unclear before/after.

---

## 7. Risks / rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| `ignoreBOM: true` changes recon for a file we didn't expect (regression on a BOM-free file) | None — the option only affects files with a leading BOM, and the corpus has been enumerated (§1.5) | §1.5 enumeration covers all 469 files in `packages/` + `examples/`. Future files acquire a BOM only via Windows editors / `Out-File`; the focused unit test (§3.2) catches any new regression. |
| `block_merkle_root` for `import-intercept.ts`'s atoms changes (forcing a `bootstrap/expected-roots.json` regen) | None | The fix changes the recon string (now byte-identical to canonical source), not the atoms themselves. Atoms are unchanged because `shave()` reads the on-disk source with BOM preserved and offsets are unchanged. The `block_merkle_root` (= BLAKE3 of spec_hash || impl_hash || proof_root) depends only on the atom's `implSource`, the spec, and the proof manifest — none of which the fix touches. |
| Test infrastructure changes are larger than one focused unit test | Low | The unit test is small (synthetic source, in-memory registry, no two-pass dependency). If the implementer judges that a different test location is more appropriate (e.g., directly inside `packages/cli/src/commands/compile-self.test.ts`), that's fine — the Scope Manifest allows either location. |
| `compile-pipeline.ts` parity site missed | Low — Real-path check 5 mandates the grep | Implementer must report the grep result. If a parity site exists and isn't fixed, the example two-pass infrastructure will diverge from the CLI behavior and #543 could resurface in the test path. |
| The defect's root cause turns out to be elsewhere despite the repro (hypothesis is wrong) | Very low — the repro is unambiguous (§1) | The repro is a deterministic, in-memory cycle that exercises the exact reconstruction code path. It produces `IDENTICAL` after the fix and the documented parse error before. The hypothesis is not at risk. |
| Fix breaks Windows-only behavior (e.g., line-ending conversions) | None | The fix changes only BOM handling. CRLF normalization is a separate concern (handled — or not — by `fs.readFileSync` and the underlying file system), and the BOM and CRLF are orthogonal. |

### Rollback boundary

Revert the single-line decoder option in `compile-self.ts`, revert the unit test, revert any parity-site edit in `compile-pipeline.ts`, and (if applied) restore the BOM in `import-intercept.ts`. The fix is purely additive on the decode path; nothing else in the codebase depends on the BOM-strip side effect.

If the optional BOM strip from §3.3 is also reverted, the file returns to its current state and the pre-fix bug returns. (This is why §3.3 is independent of §3.1.)

---

## 8. Open questions for implementer

- **Q1 (resolved).** Is the cause a `compile-self` defect or an `import-intercept.ts` defect? **`compile-self`** — `TextDecoder()` strips a UTF-8 BOM by default. The atom-source file is innocent.
- **Q2 (resolved by §1.4).** Does the `{ ignoreBOM: true }` fix produce byte-identical reconstruction? **Yes** — repro confirms.
- **Q3 (real-path-check 5).** Does `examples/v2-self-shave-poc/src/compile-pipeline.ts` carry the same defect? Grep + report at implementer time.
- **Q4 (informational).** What does the post-fix #551 count look like? Report in PR.

---

## 9. MASTER_PLAN.md amendment (deferred; governance-write-gated)

Following the WI-545 precedent: governance-markdown writes are gated to a writer identity the planner does not satisfy. The amendment is captured here for the next planner pass (or for a reviewer/guardian landing-time merge).

### Amendment 9.1 — append row to `Slice 2.5 work items` table

A new row after WI-FIX-545-TWOPASS-VALIDATOR:

```
| WI-FIX-543-IMPORT-INTERCEPT-SHAVE | Two-pass bootstrap fails on `packages/hooks-base/src/import-intercept.ts` with `CanonicalAstParseError — TypeScript syntax error(s) in source: Declaration or statement expected` (issue #543). Locus: `compile-self`. Mechanism (`plans/wi-fix-543-import-intercept-shave.md` §1): `compile-self`'s `new TextDecoder().decode(glueEntry.contentBlob)` defaults to `ignoreBOM: false`, silently stripping a leading UTF-8 BOM from the decoded glueString. `import-intercept.ts` (added in #539) starts with U+FEFF and is the only non-skipped atom-source file in the corpus that carries a BOM (the other 5 BOM-bearing files are tests or props files, skipped by `bootstrap.shouldSkip`). The BOM-strip drifts the glue cursor by 1 char permanently, corrupting every cross-atom slice past the BOM region and producing invalid TS. Fix: one-line decoder option `new TextDecoder("utf-8", { ignoreBOM: true })`. Backward compatible (files without BOM round-trip identically). Emits DEC-V2-COMPILE-SELF-GLUE-DECODE-IGNOREBOM-001. | S | (none — independent of WI-FIX-545) | review | 2 |
```

### Amendment 9.2 — Decision Log addition

Append to `## Decision Log`:

```
| DEC-V2-COMPILE-SELF-GLUE-DECODE-IGNOREBOM-001 | `compile-self`'s glue-blob decode in `_runPipeline` must use `new TextDecoder("utf-8", { ignoreBOM: true })`, not the default `new TextDecoder()`. Amends DEC-V2-COMPILE-SELF-GLUE-INTERLEAVING-001 (the merged-interval algorithm is unchanged; only the decoder construction call is modified). | Per the WHATWG Encoding spec, `new TextDecoder()` defaults to `ignoreBOM: false`, which silently strips a leading UTF-8 BOM (U+FEFF) from the decoded string. That breaks the round-trip invariant the reconstruction algorithm depends on: glueString length must equal the sum of all glue-span lengths in original-source coordinates. A BOM-carrying source file would otherwise produce a reconstructed string one UTF-16 code unit shorter than the original, shifting every cross-atom glue slice by one position past the BOM region and yielding invalid TypeScript. Validates: issue #543 (`packages/hooks-base/src/import-intercept.ts` fails pass-2 shave with `CanonicalAstParseError — Declaration or statement expected`). `ignoreBOM: true` preserves the BOM as a U+FEFF code unit in the decoded string, exactly mirroring the bytes `bootstrap.captureSourceFileGlue` stored. Backward compatibility: files without a BOM are unaffected — `ignoreBOM` only changes behavior when the first 3 bytes of the input are `EF BB BF`. |
```

### Amendment 9.3 — Slice 2.5 directional-outcomes footnote (when this WI lands)

`MASTER_PLAN.md`'s Slice 2.5 outcomes block can record `WI-FIX-543` as the entry that closes the `import-intercept.ts` axis. The byte-identity invariant footnote may carry forward to track #551 separately.

---

## 10. Cross-references

- `plans/wi-fix-494-twopass-nondeterm.md` — original two-pass-determinism plan; same family of bug.
- `plans/wi-fix-545-twopass-validator.md` — landed `*.props.ts` plumbing fix; the most recent two-pass equivalence WI. This WI follows its scope-discipline pattern.
- PR #539 (`5f660c4`) — introduced `import-intercept.ts` with the BOM that triggered the latent `compile-self` defect.
- PR #552 (`376240e`) — landed Fix E (props files); the parent commit of this WI's branch.
- Issue #543 — the issue this plan closes.
- Issue #551 — distinct two-pass divergence (82 roots) — informational counter pre/post-fix; not closed by this WI.
- `packages/cli/src/commands/compile-self.ts:615` — the call site of the fix.
- `tmp/wi-fix-543-import-intercept-shave/repro.mjs` — the in-memory repro script. Reproduces the bug pre-fix and verifies the fix in seconds without a 60-minute two-pass cycle. Scratch-only; not committed.
