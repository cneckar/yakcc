# WI-703 — Execute B2-bloat harness + publish DEC-BENCH-B2-001 verdict

**Issue:** [#703](https://github.com/cneckar/yakcc/issues/703) — Execute B2-bloat harness and publish DEC-BENCH-B2-001 verdict
**Labels:** `serenity`, `benchmarks`, `ready`
**Parent issue:** [#186](https://github.com/cneckar/yakcc/issues/186) — WI-BENCHMARK-B2: Bloat reduction reality check (harness landed in PR #640)
**Workflow id:** `wi-703-b2-bloat-verdict`
**Goal id:** `g-wi-703-b2-bloat-verdict`
**Worktree:** `.worktrees/feature-wi-703-b2-bloat-verdict` (off `main` HEAD `8e6ed5a`)
**Branch:** `feature/wi-703-b2-bloat-verdict`
**Status:** planned — measurement-only run; no source-of-truth code changes.
**Cost-bearing:** NO. Local byte-weight + cold-start measurement; zero LLM API calls.

---

## Problem

`bench/B2-bloat/` shipped its harness in PR #640 (closes #186 substrate work)
but the harness has **never been executed against live bundle measurements**.
`DEC-BENCH-B2-001` is annotated in `bench/B2-bloat/harness/run.mjs` lines
8–37 in `@status pending-tester` shape with placeholder fields
(`yakcc_raw_bytes: <fill>`, …) waiting for a real run.

Without an executed run, the B2 bloat reality-check claim in MASTER_PLAN
DEC-BENCHMARK-SUITE-001 / DEC-BENCH-SUITE-DEFERRAL-001 has no observed
verdict — only the substrate that *would* produce one. That is exactly the
"docs are claims, not proof" failure mode Architecture Preservation calls
out: a harness that has never run is rationale, not evidence.

This WI executes the harness, captures the per-metric numbers, commits the
results JSON to the repo as the authoritative artifact, and annotates
`DEC-BENCH-B2-001` with the observed values **verbatim** (honesty clause:
the verdict is recorded whether it lands at PASS-DIRECTIONAL,
WARN-DIRECTIONAL, or below either of the cold-corpus targets).

---

## Goals

1. Execute `pnpm bench:bloat` (live mode, not `--dry-run`) end-to-end on the
   current worktree.
2. Commit `bench/B2-bloat/results-2026-05-18.json` containing the per-metric
   data emitted by the harness.
3. Annotate `DEC-BENCH-B2-001` in `MASTER_PLAN.md` Decision Log with the
   observed numbers verbatim; promote status `pending-tester` → `decided`.
4. Land via PR (`closes #703`); do NOT Guardian-merge per standing rule.

## Non-goals (explicit exclusions)

- **No edits to `examples/json-schema-validator/src/validator.ts`.** Source
  is under measurement; mutating it to hit pass bars defeats the honesty
  clause. If the validator fails test-suite parity, that is part of the
  observed result.
- **No edits to `bench/B2-bloat/harness/run.mjs` or `fixtures/`.** Harness +
  fixtures are the measurement instrument; changing them invalidates the
  comparison.
- **No swap of comparator from ajv@8.x to anything else.** Per #186 DQ-1
  (DEC-BENCHMARK-SUITE-001), ajv@8.x is the locked comparator.
- **No B2 Slice 2 (medium granularity) or Slice 3 (fine granularity) work.**
  Those are future WIs per `bench/B2-bloat/README.md` § Sweep Dimensions.
- **No registry corpus changes** to "improve" reduction headline. The
  cold-corpus framing in `bench/B2-bloat/README.md` § Cold-Corpus Caveat is
  the explicit baseline; later WIs grow corpus depth and re-run B2.
- **No B3 (cache-hit) execution.** B3 is separately deferred per
  DEC-BENCH-SUITE-DEFERRAL-001 (blocked on hook-layer v0.5+ maturity).

---

## Context summary (harness already verified)

Verified at plan-time against the worktree's actual files:

- `bench/B2-bloat/package.json` declares `"run": "node harness/run.mjs"`
  and `"run:dry": "node harness/run.mjs --dry-run"`. Bench-local deps:
  `ajv@^8.17.1`, `ajv-formats@^3.0.1`, `esbuild@^0.25.4`. NOT in the pnpm
  workspace (per the package.json `notes` field).
- Root `package.json` declares `"bench:bloat": "node bench/B2-bloat/harness/run.mjs"`
  and `"bench:bloat:dry": "node bench/B2-bloat/harness/run.mjs --dry-run"`.
- `bench/B2-bloat/harness/run.mjs` (461 lines) implements both arms:
  - **Arm A** (`measureYakccValidator`): reads `examples/json-schema-validator/src/validator.ts`,
    builds via `pnpm --filter @yakcc/example-json-schema-validator build`
    (writes to `examples/json-schema-validator/dist/validator.js`), bundles
    with esbuild minified ESM into `tmp/B2-bloat/yakcc-validator.mjs`,
    measures raw + gzip.
  - **Arm B** (`measureAjv`): writes a one-line ajv entry into
    `tmp/B2-bloat/ajv-entry.mjs`, bundles with esbuild minified ESM
    (browser platform) into `tmp/B2-bloat/ajv-bundle.mjs` using
    `nodePaths: [bench/B2-bloat/node_modules]` per
    `DEC-FIX-706-NODEPATHS-001`, measures raw + gzip.
  - **Test suite** (`runTestSuite`): loads `fixtures/test-cases.json`
    (156 cases / 45 groups), imports the compiled validator, runs every
    case, reports pass/fail.
  - **Results JSON**: written to
    `tmp/B2-bloat/results-b2-<ISO-timestamp>.json` with shape:
    `{ run_id, started_at, platform, granularity: "coarse", arms: { yakcc, ajv }, test_results: { total, passed, failed, pass_rate } }`.
- `examples/json-schema-validator/src/validator.ts` (911 lines) is the
  real implementation — no `any`, no `eval`, no banned imports per
  DEC-BENCH-B2-VALIDATOR-001. Builds with `tsc -p .` to `dist/`.
- `examples/json-schema-validator/package.json` has **no** `@yakcc/*`
  workspace deps (only `@types/node` + `typescript` devDeps), so
  `pnpm --filter @yakcc/example-json-schema-validator build` triggers
  only one `tsc` invocation — no cross-package `^build` cascade, in
  particular **no `assemblyscript` cold compile**.

## Risk note: AS-WASM cold-compile cascade

Per WI-485 / WI-531 / DEC-AS-COMPILE-CACHE-001 history, building from a
fresh worktree can in some configurations cascade through `pnpm -r build`
or `turbo run build` and trigger AssemblyScript cold compile (60+ min
per #485 evidence).

**This WI is not exposed to that risk** because:

1. The harness invokes `pnpm --filter @yakcc/example-json-schema-validator build`
   — a single-package filter, not `-r` and not via `turbo run`.
2. `examples/json-schema-validator/package.json` declares zero `@yakcc/*`
   dependencies, so `^build` in turbo terms is an empty set.
3. `pnpm install -w` at the worktree root does not invoke any package's
   `postinstall` (verified by `grep postinstall packages/*/package.json` —
   no matches).

The implementer **must not** run `pnpm -r build` or `pnpm -w build`
during this WI. Lint + typecheck gates use `pnpm -w lint` /
`pnpm -w typecheck` (full-workspace per memory `feedback_eval_contract_match_ci_checks.md`),
which do not trigger asc.

---

## Approach (per-commit boundaries)

This is a **3-commit slice** (plan → run → annotate). Each commit is
independently inspectable and rollback-safe.

### C1 — Plan + scope + MASTER_PLAN row

Lands the planning artifacts. Pure docs.

**Files touched:**
- `plans/wi-703-b2-bloat-verdict.md` (this file, new)
- `tmp/scope-wi-703-b2-bloat-verdict.json` (new)
- `MASTER_PLAN.md` (append new initiative section)

**Commit message:**
`docs(plan): WI-703 — B2-bloat harness verdict plan + scope (refs #703)`

### C2 — Execute harness + commit results JSON

Runs the harness in live mode, copies the timestamped output JSON from
`tmp/B2-bloat/` to a stable committed path under `bench/B2-bloat/`.

**Run plan (exact commands, in order, from worktree root):**

```bash
# 1. Install root + bench deps. Root install is needed so tsc/turbo can find typescript;
#    bench install pulls ajv + ajv-formats + esbuild into bench/B2-bloat/node_modules.
pnpm install -w
pnpm --dir bench/B2-bloat install

# 2. Sanity check: dry-run first to confirm the harness wiring.
pnpm bench:bloat:dry

# 3. Live run. Writes timestamped JSON to tmp/B2-bloat/results-b2-<ISO>.json
#    AND prints the per-arm + comparison table to stdout. Capture stdout.
pnpm bench:bloat 2>&1 | tee tmp/wi-703-bench-stdout.log

# 4. Promote the timestamped result to the committed canonical filename.
cp "$(ls -t tmp/B2-bloat/results-b2-*.json | head -1)" bench/B2-bloat/results-2026-05-18.json

# 5. Verify the JSON parses and has all expected keys.
node -e 'const r = require("./bench/B2-bloat/results-2026-05-18.json"); const need = ["run_id","started_at","platform","granularity","arms","test_results"]; for (const k of need) if (!(k in r)) { console.error("MISSING:", k); process.exit(1); } console.log("OK:", Object.keys(r).join(","));'
```

**Files touched:**
- `bench/B2-bloat/results-2026-05-18.json` (new — committed)

NOT committed (excluded by `.gitignore` already): `tmp/B2-bloat/**`,
`tmp/wi-703-bench-stdout.log`, `examples/json-schema-validator/dist/**`,
`node_modules/**`, `bench/B2-bloat/node_modules/**`.

**Commit message:**
`feat(bench/B2): #703 — execute B2-bloat harness, commit Slice 1 results JSON (refs #703)`

### C3 — Annotate DEC-BENCH-B2-001 in MASTER_PLAN

Reads observed values from `bench/B2-bloat/results-2026-05-18.json` and the
captured stdout, then appends a `DEC-BENCH-B2-001` row to the MASTER_PLAN
Decision Log table. The row records the verbatim observed numbers and the
verdict (PASS-DIRECTIONAL / WARN-DIRECTIONAL) per the honesty clause.

**Verdict mapping** (per harness lines 19–24):
- All five directional targets met → `verdict: PASS-DIRECTIONAL`
- Any axis below directional target (cold-corpus expected) → `verdict: WARN-DIRECTIONAL`
- Per harness line 25 + #186 reframe: there is **no hard PASS/FAIL** at
  Slice 1 — every observation is a valid characterisation point.

**Files touched:**
- `MASTER_PLAN.md` (append `DEC-BENCH-B2-001` row to Decision Log)

The harness file's `@status pending-tester` block at lines 8–37 is updated
in the **same commit** to `@status decided` with the observed values
inlined into the TESTER NOTE section (so the in-source DEC and the
MASTER_PLAN DEC stay in sync — Sacred Practice #7 "Code is Truth").

**Commit message:**
`docs(plan): WI-703 — annotate DEC-BENCH-B2-001 with observed Slice 1 verdict (closes #703)`

---

## Files touched (full diff inventory)

| File | C1 | C2 | C3 |
|------|----|----|----|
| `plans/wi-703-b2-bloat-verdict.md` | new | — | — |
| `tmp/scope-wi-703-b2-bloat-verdict.json` | new | — | — |
| `MASTER_PLAN.md` | append initiative | — | append DEC row |
| `bench/B2-bloat/results-2026-05-18.json` | — | new | — |
| `bench/B2-bloat/harness/run.mjs` | — | — | update lines 8–37 (status + TESTER NOTE) |

Total diff at end of slice: ~3 new files, 2 edits to existing files. No
production code (`packages/**`, `examples/**/src/**`) changed.

---

## Verification

Per memory `feedback_eval_contract_match_ci_checks.md`, use full-workspace
gates, not package-scoped:

1. `pnpm -w lint` — full workspace green.
2. `pnpm -w typecheck` — full workspace green.
3. `node -e 'JSON.parse(require("fs").readFileSync("bench/B2-bloat/results-2026-05-18.json","utf8"))'` — results JSON parses.
4. `pnpm bench:bloat:dry` re-runs cleanly post-commit (harness still works).
5. `grep -c "DEC-BENCH-B2-001" MASTER_PLAN.md` returns ≥ 1 (decision row appended).
6. `grep "@status decided" bench/B2-bloat/harness/run.mjs` matches (status promoted from `pending-tester`).
7. `git diff --stat HEAD~3 HEAD` shows only files in the table above — no production-source diffs.

No reviewer dispatch should run `pnpm -r build` or invoke any benchmark
that triggers asc cold compile.

---

## Evaluation Contract

This work item is guardian-bound. The contract below is the exact
acceptance target the implementer is building toward and the reviewer is
verifying against.

- **required_tests:**
  - `pnpm -w lint` green (full workspace).
  - `pnpm -w typecheck` green (full workspace).
  - `bench/B2-bloat/results-2026-05-18.json` exists, is valid JSON, and
    contains all six top-level keys (`run_id`, `started_at`, `platform`,
    `granularity`, `arms`, `test_results`).
  - The `arms.yakcc.bundleSize` and `arms.ajv.bundleSize` fields are
    non-null numbers (proof that both arms produced real bundle
    measurements, not the dry-run skip path).
  - The `test_results.total` field equals 156 (fixture-count parity check).
  - `pnpm bench:bloat:dry` exits 0 post-commit (harness still works).
- **required_real_path_checks:**
  - Implementer must show the actual stdout from `pnpm bench:bloat`
    (captured in `tmp/wi-703-bench-stdout.log`) in the PR body or
    reviewer-handoff message, including the "Results: B2 Bloat Reduction"
    section that lists per-arm raw + gzip sizes and the reduction
    percentages.
  - The committed `results-2026-05-18.json` must derive from that exact
    run (matching `run_id` between the stdout-mentioned JSON path and the
    committed file).
- **required_authority_invariants:**
  - `bench/B2-bloat/` remains the sole canonical authority for B2 results
    (no parallel results emitted under `tmp/` left as the authoritative
    output).
  - `DEC-BENCH-B2-001` exists at exactly one location in `MASTER_PLAN.md`
    (no duplicate rows from a botched edit).
  - In-source `@decision DEC-BENCH-B2-001` annotation in
    `bench/B2-bloat/harness/run.mjs` matches the MASTER_PLAN row's
    observed values (Sacred Practice #7 — Code is Truth).
- **required_integration_points:**
  - The MASTER_PLAN row references issue #703 and #186, so future planners
    can trace the verdict back to its source ticket and the parent
    benchmark spec.
  - The committed results JSON shape matches the
    `DEC-BENCH-SUITE-AGGREGATE-SCHEMA-001` field-name conventions where
    overlap exists (`run_id`, `started_at`, `platform`) so a future
    `bench/run-all.mjs` integration can consume it without re-shaping.
- **forbidden_shortcuts:**
  - Editing `examples/json-schema-validator/src/validator.ts` to "fix" a
    failed test case so the pass rate hits 100%. The pass rate IS an
    observed value; if it's below 100%, the failures are reported
    verbatim and the verdict reflects that.
  - Editing `bench/B2-bloat/harness/run.mjs` (other than the
    `@status pending-tester` → `decided` + TESTER NOTE fill in C3) to
    change measurement logic, comparator, or pass-bar thresholds.
  - Editing `bench/B2-bloat/fixtures/test-cases.json` to drop failing
    cases.
  - Swapping ajv@8.x for a different comparator.
  - Using `pnpm -r build` or `turbo run build` — these may trigger AS-WASM
    cold compile (60+ min per #485) and are not needed for the bench.
  - Manufacturing or hand-editing the results JSON. The committed file
    MUST be a copy of an actually-emitted `tmp/B2-bloat/results-b2-*.json`.
- **rollback_boundary:** three-commit slice, each independently revertible.
  C1 revert removes the plan + MASTER_PLAN row. C2 revert removes the
  results JSON. C3 revert restores the DEC row to its pending-tester shape
  and restores the in-source `@status pending-tester` block.
- **ready_for_guardian:** all `required_tests` pass on the current HEAD;
  PR body includes the stdout snippet showing per-arm numbers + reduction
  percentages + pass rate; reviewer issues
  `REVIEW_VERDICT=ready_for_guardian`; commit message on C3 includes
  `closes #703`.

## Scope Manifest

Mirrored to `tmp/scope-wi-703-b2-bloat-verdict.json` (canonical 5-key
shape: `allowed_paths`, `required_paths`, `forbidden_paths`,
`state_domains`, `authority_domains`).

- **allowed_paths:**
  - `plans/wi-703-b2-bloat-verdict.md`
  - `tmp/scope-wi-703-b2-bloat-verdict.json`
  - `MASTER_PLAN.md`
  - `bench/B2-bloat/results-2026-05-18.json`
  - `bench/B2-bloat/harness/run.mjs` (only lines 8–37 TESTER NOTE + status block; full re-write forbidden)
  - `tmp/B2-bloat/**` (transient harness output; not committed)
  - `tmp/wi-703-*/**` (transient implementer scratch)
- **required_paths:**
  - `plans/wi-703-b2-bloat-verdict.md`
  - `tmp/scope-wi-703-b2-bloat-verdict.json`
  - `MASTER_PLAN.md`
  - `bench/B2-bloat/results-2026-05-18.json`
- **forbidden_paths:**
  - `examples/json-schema-validator/src/**` (source under measurement)
  - `examples/json-schema-validator/spec.yak` (specification under measurement)
  - `examples/json-schema-validator/tsconfig.json` (build config under measurement)
  - `examples/json-schema-validator/package.json` (dep closure under measurement)
  - `bench/B2-bloat/fixtures/**` (test-suite under measurement)
  - `bench/B2-bloat/README.md` (unless results section needs a pointer)
  - `bench/B2-bloat/package.json` (no new bench deps)
  - `bench/B2-bloat/harness/run.mjs` (no measurement-logic edits — only the
    TESTER NOTE + status block in C3)
  - `bench/B1-latency/**`, `bench/B4-tokens/**`, `bench/B5-coherence/**`,
    `bench/B6-airgap/**`, `bench/B7-commit/**`, `bench/B8-synthetic/**`,
    `bench/B9-min-surface/**`, `bench/B10-import-replacement/**`,
    `bench/B4-tokens-v3/**`, `bench/B4-tokens-v4/**`,
    `bench/v0-release-smoke/**` (other benchmarks are out of scope)
  - `packages/**` (no production-code edits)
  - `docs/**` (no doc updates this WI)
  - `.github/**`, `.claude/**`, `scripts/**` (orchestration / CI surfaces)
- **state_domains:** `["b2-bloat-bench-results"]`
- **authority_domains:** `["bench-b2-bloat-verdict"]`

---

## Decision Log (this WI)

- `DEC-WI703-NO-VALIDATOR-EDIT-001` — The validator source is the subject
  of measurement; editing it to improve the verdict is precisely the
  failure mode the honesty clause guards against. If the test-suite pass
  rate is below 100% on this run, the failures are reported verbatim and
  filed as separate follow-up issues, not patched-then-rerun.
- `DEC-WI703-CHARACTERISATION-FRAMING-001` — Per #186 reframe
  (2026-05-13 comment 4442627848) and existing DEC-BENCH-SUITE-DEFERRAL-001,
  every Slice 1 observation is a valid characterisation point — including
  below-target ones, which validate the cold-corpus framing. There is no
  project-level KILL on this WI; the only WI-level failure modes are
  (a) harness crash, (b) inability to produce a results JSON, or
  (c) verdict not annotated. The numbers themselves cannot fail.
- `DEC-WI703-COMMITTED-RESULTS-PATH-001` — Results live at
  `bench/B2-bloat/results-2026-05-18.json` (date-stamped, stable). Future
  Slice 2 / Slice 3 runs produce sibling files
  (`results-<YYYY-MM-DD>.json`); the date suffix gives an append-only log
  without overwriting prior runs. Rationale: the harness's own
  `tmp/B2-bloat/results-b2-<ISO>.json` output is gitignored and transient;
  a committed stable filename is what downstream tooling and audits can
  cite.

---

## Next-step / follow-up

After landing:

- If the headline reduction is **above** the directional ≥90% target —
  unlikely at cold-corpus, but flag explicitly and document the surprise
  in the PR body.
- If the test-suite pass rate is below 100% — file a follow-up issue
  per failure cluster (one issue per `group.description`) referencing the
  observed `results-2026-05-18.json`. Do NOT patch the validator in this
  WI.
- B2 Slice 2 (medium granularity, one atom per keyword category) and
  Slice 3 (fine granularity, one atom per keyword) remain future WIs
  blocked on application-layer corpus depth per
  DEC-BENCH-SUITE-DEFERRAL-001 — no change here.
- The MASTER_PLAN initiative section opened for WI-703 closes at the same
  PR (single-WI initiative).
