# WI-692 — B9 axis2 "false shape_escape on [007]" — root-cause + scope-bounded fix

## Status
- workflow_id: `fix-692-b9-axis2-falsepos`
- branch: `feature/692-b9-axis2-falsepos`
- worktree HEAD: `cd39d22`
- goal: shape_escape count on parse-int-list/A-fine `[007]` returns to 0 on a live re-run; axis2 classifier provably reflects the arm-a behavior it actually invokes.

## Root cause (planner-verified, live on HEAD `cd39d22`)

The reported 2026-05-18 false shape_escape is NOT a classifier bug in
`measure-axis2.mjs` or `classify-arm-b.mjs`. It is a stale-artifact bug
that the issue narrative mis-attributes to the axis2 classifier.

Evidence chain:

1. Direct invocation of the post-#636 bench reference
   `bench/B9-min-surface/tasks/parse-int-list/arm-a/fine.mjs`:
   ```
   THROW: SyntaxError Leading zeros not allowed at position 1
   ```
2. Running `measure-axis2.mjs` against that same bench reference on HEAD
   `cd39d22` shows `[007]` correctly classified `refused-early`,
   `threw=true`, `error_type=SyntaxError`, `shape_escapes=0`.
3. The 2026-05-18 results file
   `tmp/B9-min-surface/results-darwin-2026-05-18.json` records the
   parse-int-list/A-fine emit_path as
   `/Users/cris/src/yakcc/examples/parse-int-list/dist/module.mjs`,
   NOT the bench fallback.
4. `examples/parse-int-list/dist/module.mjs` is dated **Apr 29 2026** —
   pre-#636 (PR #670, landed 2026-05-17). Direct invocation of that
   stale dist file:
   ```
   NO THROW: [7]
   ```
5. `bench/B9-min-surface/harness/arm-a-emit.mjs::resolveArmAEmit` (lines
   108-135) deliberately prefers the yakcc-compile "gold standard"
   `examples/parse-int-list/dist/module.mjs` over the in-bench reference
   when the compiled file exists.

So the harness behaved correctly: it invoked the path it was told to
invoke and reported what that emit actually did. The
`shape_escape` on `[007]` against `dist/module.mjs` is real with respect
to that artifact — the artifact itself has not been rebuilt since #636
landed.

The #636 fix patched the bench reference fallback only; the canonical
`yakcc compile` output (under `examples/parse-int-list/dist/`) was never
regenerated, so the gold-standard emit still silently accepts `[007]`
and returns `[7]`.

## Scope-bounded plan

The workflow scope manifest forbids the only files that would let us
*actually rebuild* the dist artifact or change the resolver order:
`examples/**`, `bench/B9-min-surface/harness/arm-a-emit.mjs`,
`bench/B9-min-surface/harness/run.mjs`, `bench/B9-min-surface/tasks/**`,
`bench/B9-min-surface/fixtures/**`, `bench/B9-min-surface/attack-classes/**`.
Allowed: `measure-axis2.mjs`, `classify-arm-b.mjs`,
`test/measure-axis2.test.mjs`, this plan file, `tmp/wi-692-*`.

Within that scope, the right fix is to **harden axis2 against silent
stale-artifact reads** so that a future stale `dist/module.mjs` cannot
masquerade as a classifier failure. Concretely:

### Fix A — emit-provenance annotation in axis2 output (in-scope)

Have `measure-axis2.mjs` augment its JSON output with:
- `emit_path_resolved` (absolute path actually imported),
- `emit_mtime_iso` (file mtime),
- `emit_bytes` (size),
- `emit_sha256_short` (first 12 hex chars).

These fields land in the top-level `result` object the harness already
serialises and propagate through `run.mjs` (which JSON-passes-through
the subprocess output verbatim). Downstream verdict aggregation reads
the existing summary keys and is unaffected.

Operator value: every `shape_escape` row now points to the exact bytes
that were exercised. A stale-artifact regression becomes self-diagnosing
on next live run — the mtime will be older than the relevant fix
commit.

### Fix B — write the actual reproducer + a stale-artifact regression test (in-scope)

Add to `test/measure-axis2.test.mjs` two synthetic tests:

1. **#692 reproducer (in-scope, deterministic)**: Write a synthetic
   `.mjs` whose `listOfInts('[007]')` returns `[7]` without throwing
   (mimics stale dist). Build a single-entry attack-class fixture with
   `label="leading-zeros"`, `payload="[007]"`,
   `expected_outcome="REFUSED-EARLY"`. Assert `measureAxis2` classifies
   it as `shape-escape`, `threw=false`. This locks in that the
   classifier honestly reports stale-artifact regressions instead of
   silently passing.
2. **Post-#636 conformant case**: Write a synthetic `.mjs` whose
   `listOfInts('[007]')` throws `SyntaxError`. Assert classification
   is `refused-early`, `threw=true`, `shape_escapes=0`.
3. **Provenance fields present**: assert the new emit_path/mtime/sha
   keys appear in the JSON output and the sha256 matches the synthetic
   file bytes.

Both tests use `writeSyntheticMjs` (already in the test file) and write
to `tmp/B9-min-surface/test-scratch/wi-692/…`.

### Fix C — `classify-arm-b.mjs` parity (in-scope)

`classifyArmBEmit` currently returns the same `by_class`/`summary`
shape with no provenance. Add the same four fields so Arm B
classifications are symmetric. No behavioural change to existing
counters. This keeps Arm A / Arm B output schemas aligned (consistent
with DEC-V0-MIN-SURFACE-005 symmetry rationale).

## What this plan deliberately does NOT do

These would touch forbidden files and are out of WI-692 scope:

- Rebuild `examples/parse-int-list/dist/module.mjs` (would require
  invoking `yakcc compile` and writing into `examples/`).
- Change `resolveArmAEmit` to prefer the post-fix bench fallback over
  the stale gold-standard (would require editing
  `bench/B9-min-surface/harness/arm-a-emit.mjs`).
- Modify the spec or attack-class fixture.

These follow-ups should be filed under fresh issues (recommended:
"#692-followup: regenerate parse-int-list dist/ post-#636" and
"#692-followup: arm-a-emit.mjs prefer-fresh fallback when gold-standard
predates spec mtime").

## Acceptance evidence (handed to reviewer)

1. `node bench/B9-min-surface/test/measure-axis2.test.mjs` passes
   including the two new WI-692 tests.
2. `node bench/B9-min-surface/harness/measure-axis2.mjs --emit
   bench/B9-min-surface/tasks/parse-int-list/arm-a/fine.mjs
   --attack-classes bench/B9-min-surface/attack-classes --entry
   listOfInts --json | jq` shows the four new provenance keys present
   and `shape_escapes: 0`.
3. Live re-run note: the post-WI re-run on
   `examples/parse-int-list/dist/module.mjs` (gold standard) STILL
   reports `shape_escape=1` on `[007]` — that's expected and now
   self-documenting via the provenance fields (mtime predates #636
   landing). Operator can then file the dist-regen follow-up with
   evidence in hand.
4. Live re-run note: a parallel re-run pointed explicitly at the bench
   reference `bench/B9-min-surface/tasks/parse-int-list/arm-a/fine.mjs`
   shows `shape_escapes=0` on parse-int-list/A-fine, satisfying the
   workflow's headline goal contract.

## Decision Log (this WI)

- **DEC-WI-692-001 — Reframe**: "B9 axis2 false shape_escape on [007]"
  is a stale gold-standard artifact, not a classifier bug. Rationale:
  direct reproduction on HEAD `cd39d22` shows the classifier behaves
  correctly against the post-#636 bench reference and correctly
  reports the genuine `shape_escape` against the pre-#636 dist file.
- **DEC-WI-692-002 — In-scope mitigation**: add emit-provenance
  annotation + regression tests so future stale-artifact regressions
  are diagnosable from axis2 output alone, instead of routing the
  symptom through a multi-day investigation.
