# WI-624 — Populate cat1-bcryptjs-* corpus expectedAtomName

**Issue:** #624 (bcryptjs corpus expectedAtomName placeholder)
**Workflow:** fix-624-bcryptjs-corpus
**Worktree:** `.worktrees/feature-624-bcryptjs-corpus` (HEAD `5b13d3c`)
**Branch:** `feature/624-bcryptjs-corpus`
**Status:** planned — small data-only update; no probe run required.

## Problem

`packages/registry/test/discovery-benchmark/corpus.json` contains two rows
that still carry the placeholder `expectedAtom: null` shape from before
#585 closed the bcryptjs UMD-IIFE engine gap:

- `cat1-bcryptjs-hash-001` (line 930)
- `cat1-bcryptjs-verify-001` (line 940)

Both rows are odd-one-out: every other WI-510 single-module-package row
(lodash Slice 7, etc.) carries both `expectedAtom: null` AND
`expectedAtomName: "<package>-<function>"`. The missing field blocks the
B9-min-surface combinedScore signal and the §F headline-binding gates,
because downstream tooling distinguishes "explicitly unresolved" from
"declared unmeasured".

## Root-cause / convention check

`expectedAtomName` is **not** extracted from a live shave run. It is a
human-authored descriptive label on the corpus row, following the
`<package>-<function>` convention established across all lodash rows:

```text
cat1-lodash-cloneDeep-001 → expectedAtomName: "lodash-cloneDeep"
cat1-lodash-debounce-001  → expectedAtomName: "lodash-debounce"
cat1-lodash-throttle-001  → expectedAtomName: "lodash-throttle"
…
```

(Confirmed by `grep "expectedAtomName" corpus.json` across all 23
occurrences — every populated row uses the row-id stem after `cat1-`.)

No package code reads `expectedAtomName` as input today; it is corpus
metadata consumed only by downstream eval/scoring harnesses and the
benchmark harness which expects a non-null label per row. No probe run
of the shave engine is required; this is a pure data field update.

## Approach

Edit two rows in `packages/registry/test/discovery-benchmark/corpus.json`
to add `expectedAtomName` following the lodash convention. Keep
`expectedAtom: null` (the merkle root is intentionally null on
synthetic-tasks rows; see lodash rows for precedent). Do not touch the
`rationale` text, query, source, category, or id fields.

### Exact JSON edit

For `cat1-bcryptjs-hash-001` (line 930-938), insert one field between
`expectedAtom` and `rationale`:

```diff
       "expectedAtom": null,
+      "expectedAtomName": "bcryptjs-hash",
       "rationale": "WI-510 Slice 6: bcryptjs@2.4.3 fixture entry. hash behavior …"
```

For `cat1-bcryptjs-verify-001` (line 940-948), insert one field
between `expectedAtom` and `rationale`:

```diff
       "expectedAtom": null,
+      "expectedAtomName": "bcryptjs-verify",
       "rationale": "WI-510 Slice 6: bcryptjs@2.4.3 fixture entry. verify (constant-time compare) behavior …"
```

### Naming rationale

- Distinct names per row (matching the row-id stem) — consistent with
  lodash convention.
- The shared-underlying-atom truth is already captured in both
  `rationale` fields ("Same atom as cat1-bcryptjs-verify-001; both
  corpus rows point at the same merkle root") and in
  `DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001`.
- `expectedAtomName` describes the *behavior query target*, not the
  underlying merkle root; distinct queries get distinct labels even
  when they retrieve the same atom.

## Out of scope (explicit non-goals)

- jsonwebtoken Slice 6 rows (`cat1-jsonwebtoken-{verify,decode-base64url,parse-jose-header}-001`) still carry `expectedAtom: null` with no `expectedAtomName`. These are siblings of #624 but are explicitly outside this workflow's scope; file a follow-up issue if not already tracked.
- Changes to the bcryptjs test file (`bcryptjs-headline-bindings.test.ts`) — no probe run needed.
- §F gate enforcement / re-running the bcryptjs test (out of scope; §F runs only with `DISCOVERY_EVAL_PROVIDER=local` per existing skip-if).
- No `expectedAtom` (merkle root) population. That requires a curated
  test capture and is the *next* WI in the bcryptjs sequence (B9 §F).

## Files touched

| File | Change |
|------|--------|
| `packages/registry/test/discovery-benchmark/corpus.json` | +2 lines (one `expectedAtomName` per row) |
| `plans/wi-624-bcryptjs-corpus.md` | this plan (new) |

Total diff: ~2 lines of production data + plan.

## Verification

1. `jq . packages/registry/test/discovery-benchmark/corpus.json > /dev/null` — JSON remains valid.
2. `jq '.queries[] | select(.id | startswith("cat1-bcryptjs-")) | {id, expectedAtomName}' packages/registry/test/discovery-benchmark/corpus.json` — both rows show non-null `expectedAtomName` matching the table.
3. `git diff --stat HEAD` — only `corpus.json` and the plan are modified; no shave-engine or registry-src changes.
4. `pnpm --filter @yakcc/registry test discovery-benchmark` (if a fast schema test exists) — passes; otherwise, schema is implicit via consumers and no test currently asserts on it.

No bcryptjs test re-run required (data-only change; no behavioral
contract under test references this field; pre-existing 10.8-min run
from #625 stands as the engine baseline).

## Evaluation Contract (mirrored from cc-policy)

- **required_tests:** both corpus rows have non-null `expectedAtomName`; JSON remains valid; no other corpus rows mutated.
- **required_evidence:** the two-line diff in `corpus.json`; `jq` round-trip output cited above; `git diff --stat` showing only the two files.
- **required_real_path_checks:** `packages/registry/test/discovery-benchmark/corpus.json` exists and parses; `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts` exists (read-only reference; not edited).
- **required_authority_invariants:**
  - `packages/shave/src/universalize/recursion.ts` untouched (engine fix preserved).
  - `bcryptjs-headline-bindings.test.ts` untouched (no probe console.log; no skip change).
  - No other corpus rows mutated.
  - No `packages/registry/src/**` files touched.
- **required_integration_points:** B9-min-surface harness should now compute non-degenerate signal for the bcryptjs task pair (verified in §F follow-up, not this WI).
- **forbidden_shortcuts:**
  - Hardcoding a different label scheme that breaks lodash convention.
  - Editing rows beyond the two named bcryptjs rows.
  - Removing the `expectedAtom: null` field (the field is load-bearing for the discriminator that distinguishes "unresolved merkle root" from "merkle root present").
- **rollback_boundary:** single-commit `git revert`; rows return to placeholder shape.
- **ready_for_guardian:** worktree shows only the corpus and plan diff; `jq` validates; reviewer issues `REVIEW_VERDICT=ready_for_guardian`; commit message includes `Closes #624`.

## Scope Manifest

- **Allowed:**
  - `packages/registry/test/discovery-benchmark/corpus.json`
  - `plans/wi-624-bcryptjs-corpus.md`
  - `tmp/wi-624-*/**`
- **Required:**
  - `plans/wi-624-bcryptjs-corpus.md`
  - `packages/registry/test/discovery-benchmark/corpus.json`
- **Forbidden (representative; full list owned by workflow scope):**
  - `packages/shave/src/**` (no engine edits)
  - `packages/registry/src/**` (no production-code edits)
  - `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts` (test must not be edited)
  - `packages/shave/src/universalize/recursion.ts`
  - `MASTER_PLAN.md`, `bench/**`, `docs/**`, `.github/**`, `.claude/**`
- **Authority domains touched:** `bcryptjs-corpus-row` only.

## Decision Log

- `DEC-WI624-EXPECTED-ATOM-NAME-CONVENTION-001` — Follow lodash naming convention (`<package>-<function>`) with distinct labels per row, even when rows share an underlying merkle root. Rationale: `expectedAtomName` describes the query target, not the atom identity; the shared-atom fact is already canonicalized in the `rationale` text and the existing `DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001`.
- `DEC-WI624-NO-PROBE-RUN-001` — Do not run the bcryptjs test as a probe. The field is human-authored corpus metadata, not an engine-extracted value. The naming convention is determined by precedent (lodash rows), so no live atom-name capture is needed. Rationale: avoids a 10.8-min test run for zero added correctness signal.

## Next-step / follow-up

After landing:
- File or surface follow-up for jsonwebtoken Slice 6 rows (same placeholder problem; out of #624 scope).
- B9-min-surface §F enforcement is the next gate; tracked separately.
