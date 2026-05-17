# WI-638: B1-latency spawn timeout — yakcc-as variants exceed 30-min budget on darwin/M1 Pro

- Workflow: `fix-638-b1-spawn-timeout`
- Goal: `g-638-b1-timeout`
- Work item: `wi-638-b1-timeout`
- Branch / worktree: `feature/638-b1-spawn-timeout` @ `/Users/cris/src/yakcc/.worktrees/feature-638-b1-spawn-timeout`
- Tracking issue: #638

## 1. Problem (verbatim from issue body)

On darwin/M1 Pro the B1-latency orchestrators hit `spawnSync` 30-min ETIMEDOUT before the yakcc-as comparator finishes:

- `bench/B1-latency/integer-math/run.mjs`: rust-accelerated PASS (324 ms p50, 276 MB/s); rust-software ETIMEDOUT; ts-node + yakcc-as never reached.
- `bench/B1-latency/json-transformer/run.mjs`: rust-accelerated + rust-software PASS (~80 ms p50, 863-1032 MB/s); ts-node ETIMEDOUT; yakcc-as ETIMEDOUT.
- `bench/B1-latency/http-routing/run.mjs`: all 4 PASS — yakcc-as 9.66 ms p50 beats rust-software.

Result: 2 of 3 B1 sub-benches cannot compute their PASS/KILL verdict locally. Only http-routing currently has a complete measurement.

A separately filed kernel bug — `spawnSync` did not actually kill the rust-software child on its ETIMEDOUT and it kept running ~72 min past — is **out of scope** here (process-management fix, separate WI).

## 2. Empirical cost model (from existing artifacts and code)

Code findings:

- All three orchestrators (`integer-math/run.mjs`, `json-transformer/run.mjs`, `http-routing/run.mjs`) wrap every comparator in a single `spawnSync(..., { timeout: 1800000 })` — 30 min, same ceiling for rust-accelerated, rust-software, ts-node, and yakcc-as. There is no per-comparator override today.
- The iteration count (100 warm-up + 1000 measured = 1100 total) is **hard-coded inside each comparator subprocess**:
  - `bench/B1-latency/integer-math/{rust-baseline/src/main.rs,rust-baseline/src/main-software.rs,ts-baseline/run.ts,yakcc-as/run.mjs}` all set `WARMUP=100, MEASURED=1000`.
  - `bench/B1-latency/json-transformer/{rust-baseline/src/main.rs,rust-baseline/src/main-software.rs,ts-baseline/run.ts,yakcc-as/run.mjs}` likewise.
  - `bench/B1-latency/http-routing/yakcc-as/run.mjs` likewise.
  - No env / CLI flag override exists.
- The `yakcc-as` runners already perform all known cold-start work **outside** the timing loop: asc.js compile → wasm bytes → `WebAssembly.Module` + `Instance` → corpus copy into linear memory. The timing loop is a pure `sha256(...)` / `sumNumericLeaves(...)` / `match(...)` call. There is no remaining cold-start to hoist.

Latest archived artifact (`tmp/B1-latency/integer-math-2026-05-11_17-26-42.json`):

```
rust-accelerated mean_ms=37.99
rust-software    mean_ms=173.43
ts-node          mean_ms=38.15
yakcc-as         mean_ms=267.96  → 1100 iter ≈ 295 s ≈ 4.9 min
```

That CI run produced a valid (KILL) verdict in ~5 min for yakcc-as. The darwin local symptom is that yakcc-as per-iteration cost is materially higher there (Node WASM JIT on M1 vs ubuntu-latest). To exceed 30 min × 60 s = 1800 s wall-clock at 1100 iterations, per-iter cost must reach ≥ ~1.64 s — i.e. ≥ ~6.1× the archived ubuntu-latest number. That is consistent with the reported symptom and the per-platform variance documented in `DEC-BENCH-B1-CI-TIMEOUT-001`.

`http-routing` succeeds locally because its yakcc-as mean is ~6 ms → 1100 iter ≈ 6.6 s end-to-end. No risk under any plausible per-platform multiplier.

## 3. Options considered (from issue body) and decision

| # | Option | Verdict |
|---|---|---|
| 1 | Raise orchestrator `spawnSync` timeout (1800000 → 3600000 or 7200000) | **Adopt as defensive ceiling** — cheap, preserves behavior, gives 1-hr headroom on slow platforms. Worst-case CI wall-clock unchanged in practice (no run currently approaches the cap on ubuntu-latest). |
| 2 | Reduce iteration count for yakcc-as only (1100 → e.g. 300 total) | **Adopt as opt-in** via env override. Verdict statistic (`mean_ms`, `throughput_mb_per_sec`) is per-iteration, so the gate `(yakcc_mean - rust_software_mean) / rust_software_mean` remains valid even when yakcc-as runs fewer samples. Higher variance on yakcc-as p99 is acceptable for local diagnostic runs (current darwin KILL margin is ~54%, far above noise floor). |
| 3 | Pre-warm the AS module load | **Reject — already done.** Compile, instantiate, and corpus copy are already outside the timing loop in all three `yakcc-as/run.mjs` files. There is no remaining cold-start to hoist. |
| 4 | Smaller corpus on darwin local | **Reject — out of scope.** Forbidden by Scope Manifest (`bench/B1-latency/*/corpus/**`). Also changes the work being measured and would require regenerating `corpus-spec.json`. |

### Chosen plan: (1) + (2)

1. **Raise the `spawnSync` per-comparator ceiling from 30 min to 60 min** in all three orchestrators (`integer-math/run.mjs`, `json-transformer/run.mjs`, `http-routing/run.mjs`). 60 min preserves the existing CI invariant that the workflow-level 60-min job timeout still bounds runaway processes (the orchestrator runs comparators sequentially; the ceiling bounds a single slow comparator, not the whole run). Annotate the constant and amend `DEC-BENCH-B1-CI-TIMEOUT-001` rationale comments accordingly.
2. **Add an opt-in iteration override for the yakcc-as comparator only**: each `yakcc-as/run.mjs` reads `process.env.YAKCC_AS_MEASURED_ITERS` and `process.env.YAKCC_AS_WARMUP_ITERS`. Defaults stay `1000` and `100` — so CI and every existing invocation continue with the apples-to-apples 1100-iter run. Darwin developers needing a local PASS/KILL verdict can `YAKCC_AS_MEASURED_ITERS=200 YAKCC_AS_WARMUP_ITERS=40 node bench/B1-latency/integer-math/run.mjs`.
3. **Emit the actual iteration count used into the yakcc-as JSON result** (already present as `iterations: MEASURED` — the override flows through automatically since `MEASURED` is reassigned to the resolved value). The orchestrator's existing artifact format and dashboard parser keep working without change.
4. **README note**: document the env var in `bench/B1-latency/README.md` so the next developer hitting an ETIMEDOUT on darwin sees the escape hatch.

### Why this is the right pick

- **Test integrity preserved.** CI behavior is byte-identical (no env vars set, no behavior change). The yakcc-as-vs-rust-software gate keeps using mean_ms which is iteration-count-invariant. Reduced-iter runs are explicitly marked in the JSON (`iterations` field) so any dashboard can flag them as "diagnostic only" vs canonical.
- **CI cost unchanged.** Timeout ceiling is raised but actual CI run time is governed by the workload, not the ceiling. No new minutes are spent unless something is already on fire.
- **Diagnostic value retained.** A 200-measured yakcc-as run will still produce p50/mean within ~5% of the 1000-measured run for the workloads in scope. The KILL verdict (~54% degradation) has enormous signal-to-noise headroom.
- **Scope compliance.** Only the three orchestrator `run.mjs` files, the three `yakcc-as/run.mjs` files, and the README are touched. Rust baselines, ts baselines, corpus, and other benches are forbidden by the workflow scope and remain untouched.

## 4. Exact diff sketch

### 4.1 Orchestrators — raise per-comparator `spawnSync` timeout

File: `bench/B1-latency/integer-math/run.mjs`

```diff
-    timeout: 1800000, // 30 min — covers ubuntu-latest ~2.2× slowdown vs Windows
+    timeout: 3600000, // 60 min — covers ubuntu-latest ~2.2× slowdown and darwin yakcc-as M1 JIT cost
```

Apply at line 154 (`runComparator` opts). Update the `DEC-BENCH-B1-CI-TIMEOUT-001` rationale comment block at lines 146-153 to add: "Bumped from 30→60 min for #638 (darwin/M1 Pro yakcc-as wall-clock); see also YAKCC_AS_MEASURED_ITERS opt-in below."

File: `bench/B1-latency/json-transformer/run.mjs`

Same diff at lines 182 and 273 (`runComparatorOnce` and `runComparator`), with the same comment update at lines 174-181.

File: `bench/B1-latency/http-routing/run.mjs`

Same diff at line 150 (`runComparator` `timeoutMs` default), with the same comment update at lines 142-149.

### 4.2 yakcc-as runners — env-gated iteration override

File: `bench/B1-latency/integer-math/yakcc-as/run.mjs`

Replace lines 45-46:

```diff
-const WARMUP = 100;
-const MEASURED = 1000;
+// Iteration counts default to the canonical apples-to-apples 100/1000 cadence
+// (matching ts-baseline, rust-baseline-accelerated, rust-baseline-software).
+// They are opt-in overridable via env vars to support local PASS/KILL verdicts
+// on platforms where yakcc-as per-iter cost exceeds the orchestrator's 60-min
+// ceiling — primarily darwin/M1 Pro (#638). Reduced-iter runs are marked in
+// the JSON output via the `iterations` field and the `iterations_override`
+// flag; canonical CI runs leave both env vars unset and emit 1000 measured.
+function parsePositiveInt(envVal, fallback, name) {
+  if (envVal === undefined || envVal === "") return fallback;
+  const n = Number.parseInt(envVal, 10);
+  if (!Number.isFinite(n) || n <= 0) {
+    process.stderr.write(`WARN: ignoring invalid ${name}=${envVal} (need positive integer); using default ${fallback}\n`);
+    return fallback;
+  }
+  return n;
+}
+const WARMUP = parsePositiveInt(process.env.YAKCC_AS_WARMUP_ITERS, 100, "YAKCC_AS_WARMUP_ITERS");
+const MEASURED = parsePositiveInt(process.env.YAKCC_AS_MEASURED_ITERS, 1000, "YAKCC_AS_MEASURED_ITERS");
+const ITERATIONS_OVERRIDE = (WARMUP !== 100 || MEASURED !== 1000);
```

Extend the JSON result object near lines 189-197 to include the override marker:

```diff
 const result = {
   comparator: "yakcc-as",
   p50_ms: p50,
   ...
   iterations: MEASURED,
+  warmup_iterations: WARMUP,
+  iterations_override: ITERATIONS_OVERRIDE,
 };
```

File: `bench/B1-latency/json-transformer/yakcc-as/run.mjs`

Identical pattern at lines 37-38 and at the result object near lines 270-279.

File: `bench/B1-latency/http-routing/yakcc-as/run.mjs`

Identical pattern at lines 47-48 and at the result object near line 386.

### 4.3 README note

File: `bench/B1-latency/README.md`

Append a short subsection (placement adjacent to the existing "100 warm-up + 1000 measured" methodology blurb around line 176) documenting:

- The orchestrator `spawnSync` ceiling is 60 min per comparator (rationale: ubuntu-latest slowdown + darwin/M1 Pro yakcc-as JIT cost).
- For local PASS/KILL verdict runs on slower platforms, `YAKCC_AS_WARMUP_ITERS` and `YAKCC_AS_MEASURED_ITERS` override the yakcc-as comparator's iteration counts only. Defaults preserve canonical 100/1000 cadence. Reduced-iter runs are flagged in the JSON via `iterations_override: true`.
- These env vars must be left unset for CI runs and any artifact intended as the verdict-of-record.

## 5. Test plan

Heavy compute is explicitly out of scope for landing — a full 1000-iter rerun is a follow-up CI task. The verification target is: **prove the spawn timeout no longer fires for yakcc-as on the integer-math and json-transformer benches under a tight-loop quick run, and prove the canonical default path still produces the same numbers**.

### 5.1 Required quick checks (implementer must execute and paste output)

1. **integer-math yakcc-as quick verification** — confirm the override flows end-to-end and stays within the per-comparator ceiling:
   ```bash
   YAKCC_AS_WARMUP_ITERS=5 YAKCC_AS_MEASURED_ITERS=10 \
     node bench/B1-latency/integer-math/yakcc-as/run.mjs \
       bench/B1-latency/integer-math/corpus/input-100MB.bin
   ```
   Expected: JSON on stdout with `"iterations": 10, "warmup_iterations": 5, "iterations_override": true`, single-digit minutes wall-clock. Exit 0.

2. **json-transformer yakcc-as quick verification**:
   ```bash
   YAKCC_AS_WARMUP_ITERS=5 YAKCC_AS_MEASURED_ITERS=10 \
     node bench/B1-latency/json-transformer/yakcc-as/run.mjs \
       bench/B1-latency/json-transformer/corpus/input-100MB.json
   ```
   Expected: JSON on stdout with the override flags set and a sane `checksum`.

3. **http-routing yakcc-as quick verification** (regression guard — this comparator already PASSes locally):
   ```bash
   YAKCC_AS_WARMUP_ITERS=5 YAKCC_AS_MEASURED_ITERS=10 \
     node bench/B1-latency/http-routing/yakcc-as/run.mjs \
       bench/B1-latency/http-routing/corpus/routing-table-10k.json \
       bench/B1-latency/http-routing/corpus/query-set-100k.json
   ```
   Expected: JSON on stdout with override flags set and `matched_count`/`total_captures` matching the canonical correctness gate.

4. **Default path regression check** — confirm CI behavior is byte-identical when env vars are unset:
   ```bash
   env -u YAKCC_AS_MEASURED_ITERS -u YAKCC_AS_WARMUP_ITERS \
     node bench/B1-latency/http-routing/yakcc-as/run.mjs \
       bench/B1-latency/http-routing/corpus/routing-table-10k.json \
       bench/B1-latency/http-routing/corpus/query-set-100k.json
   ```
   Expected: `"iterations": 1000, "warmup_iterations": 100, "iterations_override": false`. http-routing chosen for this check because its wall-clock at the canonical 1100 iter is ~7 seconds — fast enough to actually run during review.

5. **Invalid override handling** — confirm bad input falls back to default with a WARN to stderr:
   ```bash
   YAKCC_AS_MEASURED_ITERS=garbage node bench/B1-latency/http-routing/yakcc-as/run.mjs ...
   ```
   Expected: stderr contains `WARN: ignoring invalid YAKCC_AS_MEASURED_ITERS=garbage`; stdout still has `"iterations": 1000, "iterations_override": false`.

### 5.2 Out of scope for this WI

- A full 1100-iter darwin yakcc-as integer-math run to produce a canonical PASS/KILL verdict artifact. That is a separate manual run / follow-up CI task once the gate works.
- The `spawnSync` did-not-kill-child kernel bug — separate WI.
- Any change to ubuntu-latest CI behavior (none expected; ceiling raise is unobservable when no run approaches it).

## 6. Scope Manifest

Matches the workflow contract verbatim.

**Allowed paths** (this WI may modify):
- `bench/B1-latency/integer-math/run.mjs`
- `bench/B1-latency/json-transformer/run.mjs`
- `bench/B1-latency/http-routing/run.mjs`
- `bench/B1-latency/integer-math/yakcc-as/**`
- `bench/B1-latency/json-transformer/yakcc-as/**`
- `bench/B1-latency/http-routing/yakcc-as/**`
- `bench/B1-latency/README.md`
- `plans/wi-638-b1-spawn-timeout.md`
- `tmp/wi-638-*/**`

**Required paths** (must be present at the end):
- `plans/wi-638-b1-spawn-timeout.md`

**Forbidden paths** (must not be touched — enforced by hook):
- `bench/B1-latency/*/rust-baseline/**` (verdict gate — apples-to-apples iter count must not drift)
- `bench/B1-latency/*/ts-baseline/**` (second reference — same reason)
- `bench/B1-latency/*/corpus/**` (would change the work being measured)
- All other `bench/` packages, `.github/**`, `.claude/**`, `MASTER_PLAN.md`, `docs/**`, `scripts/**`, `packages/**`.

**Authority domains touched**:
- `b1-spawn-timeout` (the per-WI runtime domain — only this WI writes here).

## 7. Evaluation Contract

The contract below is wired into runtime via `cc-policy workflow work-item-set ... --evaluation-json '...'`.

- **required_tests**:
  - Short verification run (~10 measured iter) of integer-math yakcc-as completes within the per-comparator ceiling without ETIMEDOUT.
  - Short verification run (~10 measured iter) of json-transformer yakcc-as completes within the per-comparator ceiling without ETIMEDOUT.
  - http-routing yakcc-as canonical (default, no env vars) run still completes and still produces matching correctness numbers (regression guard).
  - Invalid env override falls back to default 100/1000 with a WARN on stderr.
- **required_evidence**:
  - All file changes scoped to allowed_paths only — confirmed by `cc-policy workflow scope-check`.
  - `plans/wi-638-b1-spawn-timeout.md` committed and present in the diff.
  - Test output evidence pasted in the implementer / reviewer trail showing successful short-run completions with `iterations_override: true` and successful default-path run with `iterations_override: false`.
- **required_real_path_checks**:
  - `bench/B1-latency/integer-math/run.mjs` present and uses `spawnSync` ceiling 3600000.
  - `bench/B1-latency/json-transformer/run.mjs` present and uses `spawnSync` ceiling 3600000 in both `runComparatorOnce` and `runComparator`.
  - `bench/B1-latency/http-routing/run.mjs` present and uses ceiling 3600000 default in `runComparator`.
  - All three `yakcc-as/run.mjs` honor `YAKCC_AS_WARMUP_ITERS` and `YAKCC_AS_MEASURED_ITERS` with default 100/1000.
- **required_authority_invariants**:
  - Rust baseline runners (`rust-baseline/src/*.rs`) untouched.
  - TS baseline runners (`ts-baseline/run.ts`) untouched.
  - Corpus files (`*/corpus/**`) untouched.
  - Other bench packages (B4, B5, B6, B7, B8, B9, B10, v0-release-smoke) untouched.
  - PASS/KILL verdict thresholds preserved: integer-math + json-transformer keep 15/40, http-routing keeps 25/40.
  - Verdict computation still uses `mean_ms` (per-iteration) so iteration-count divergence between yakcc-as and the rust/ts comparators remains valid for the gate.
- **required_integration_points**:
  - Result artifact JSON shape preserved (all existing fields still present); new fields `warmup_iterations` and `iterations_override` are additive only.
  - Dashboards / `post-nightly-comment.mjs` continue to parse the existing fields without change. The new fields are optional and can be ignored by older parsers.
- **forbidden_shortcuts**:
  - Removing yakcc-as variant entirely — no, we need its number.
  - Hardcoding "skip on darwin" with no CI escape hatch — no, CI must remain canonical.
  - Changing rust/ts baseline iteration counts — explicitly out of scope.
  - Changing corpus size or content — out of scope.
  - Lowering the default `MEASURED` from 1000 — would break apples-to-apples and silently change every existing CI artifact.
  - Skipping pre-push hygiene (rebase + lint + typecheck) — non-negotiable.
- **rollback_boundary**: `git revert <single landing commit>` restores the prior 30-min ceiling and removes the env-var hooks. No data migration. No corpus regeneration. No cross-repo impact.
- **acceptance_notes**: The 4 options listed in #638 were evaluated; planner picked (1)+(2). Full 1100-iter darwin re-run is a follow-up bench task, not gating for this WI. The separately observed `spawnSync` did-not-kill-child kernel issue is a separate WI.
- **ready_for_guardian_definition**: All `required_tests` pasted with output in the worktree, scope-check green, `plans/wi-638-b1-spawn-timeout.md` committed, PR opened with `Closes #638`, pre-push hygiene (rebase against `origin/main`, lint, typecheck) green.

## 8. Wave decomposition

Single wave — small, self-contained, no internal dependencies.

| W-ID | Description | Weight | Gate | Deps | Integration |
|---|---|---|---|---|---|
| W1 | Apply diffs from §4.1 + §4.2 + §4.3 in a single commit | S | review (reviewer + guardian) | — | Three orchestrator runners, three yakcc-as runners, README, plan file |

Critical path: planner → guardian (provision) → implementer → reviewer → guardian (land).

## 9. Decision log entry

- `DEC-WI-638-001` — Adopt options (1) raise per-comparator `spawnSync` ceiling 30→60 min and (2) add opt-in `YAKCC_AS_{WARMUP,MEASURED}_ITERS` env override. Rationale: preserves apples-to-apples CI behavior (no env vars → no change), gives darwin local an escape hatch without modifying baselines or corpus, keeps the verdict-of-record canonical. Rejects (3) pre-warm (no remaining cold-start to hoist) and (4) smaller corpus (out of scope). Reference: issue #638, this plan §3.
