# B7 — Time-to-Commit for Novel Glue — 3-Slice Plan

**Issue:** [#191](https://github.com/cneckar/yakcc/issues/191)
**Parent:** WI-BENCHMARK-SUITE ([#167](https://github.com/cneckar/yakcc/issues/167))
**Track:** B7 of 8 (B1, B5, B6, B8 already shipped — same harness family)
**Status:** Plan only — no implementation files exist under `bench/B7-commit/` other than this document.

---

## Purpose (verbatim from #191)

> Measure wall-clock time from "AI agent emits a novel ~20-line utility function" to "atom committed to local registry, available for next turn."

The metric is the **flywheel round-trip**: a novel-glue emission must atomize into the local registry and become discoverable via `registry.findCandidatesByIntent()` on the next session. The path is already validated structurally by `bench/v0-release-smoke/smoke.mjs` Step 8b → Step 9 (the `arrayMedian` fixture); B7 instruments and scales the same path with timing.

## Pass / KILL bars (from #191 + #167 DQ-5)

| Result | Warm cache | Cold cache | Verdict |
|--------|------------|------------|---------|
| Median wall-clock | ≤3 s | ≤30 s | **PASS — aspirational** (current infra likely cannot hit this without fast-path verifier) |
| Median wall-clock | ≤10 s | ≤30 s | **PASS — hard cap** |
| Median wall-clock | 10–15 s | — | **WARN — measure-and-publish-honestly per DQ-3** |
| Median wall-clock | >15 s | — | **KILL** — spawns `WI-FAST-PATH-VERIFIER` as mandatory follow-up |

Per DQ-3 resolution in the issue body: **B7 publishes whatever current infra produces.** The ≤3 s aspirational bar tightens once a fast-path verifier lands. Measure-and-publish-honestly is more valuable than waiting.

## Forbidden shortcuts (verbatim from issue #191)

> **Adversarial framing**: novel utilities chosen to genuinely require verification (real properties, not trivial passthroughs).
>
> **Honest measurement**: publish what current infra produces; gap to aspirational bar is itself signal.

Per #167 cornerstones and the 2026-05-12 routing comment on #191:

- **Never-synthetic cornerstone** (`DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001`): corpus and oracle must be real-shaved content. The "next session re-queries for same behavior" oracle must come from a real shaved atom's IntentCard, not LLM-generated phrasing.
- **No mocked verification path.** The harness MUST invoke `atomizeEmission` from `@yakcc/hooks-base` and `registry.findCandidatesByIntent` from `@yakcc/registry` against a real SQLite registry — no stubs, no fakes.
- **Air-gap preserved (B6)**: harness MUST NOT initiate outbound network calls. Use `intentStrategy: "static"`, `offline: true` (already the atomize.ts default). No Anthropic API in B7 unless gated on `ANTHROPIC_API_KEY` AND clearly labeled as the networked-mode variant (deferred — out of scope for Slices 1–3).
- **Content-addressed corpus**: the utility-suite source files MUST be committed under `bench/B7-commit/corpus/` with a `corpus-spec.json` recording each file's SHA-256, mirroring B5's `corpus-spec.json` discipline.
- **Hardware lock disclosure**: every measurement run records `{ platform, arch, cpu, node, yakcc_head }` in the artifact (mirrors B1's `environment` block). Cross-architecture verdicts are informational only.

## What B7 measures vs. what already exists

The bidirectional hook (atomize-on-emission) **already exists** — shipped in PR #368, `packages/hooks-base/src/atomize.ts`, closes #362. The round-trip is already verified end-to-end by `bench/v0-release-smoke/smoke.mjs` Steps 8b–9 with the `arrayMedian` fixture. **B7 does not invent the path; B7 times it across a corpus.**

The instrumentation surface (timestamps) per emission:

| Timestamp | Capture point | Provided by |
|-----------|---------------|-------------|
| `t0_emit` | Just before `atomizeEmission()` call (simulates LLM emission landing) | Harness |
| `t1_shape_pass` | After shape filter accepts the emission | Inline timing in harness (atomize is opaque) |
| `t2_atomized` | After `atomizeEmission()` returns with `atomized=true` | Harness reads `Date.now()` after await |
| `t3_query_hit` | After `registry.findCandidatesByIntent()` returns the just-stored BMR in top-K | Harness |

Primary metric: `t3_query_hit - t0_emit` (full flywheel round-trip).
Secondary: `t2_atomized - t0_emit` (atomization only — isolates the verification cost).
Tertiary: `t3_query_hit - t2_atomized` (registry query cost — should be ~ms; useful for sanity).

---

## Slice 1 — Harness MVP + 3-5 fixtures + KILL-gate decision

**This is the smallest valuable slice that ships in a single implementer PR.**

### Scope

Build a runnable harness that measures the novel-glue flywheel round-trip on 3–5 hand-authored utilities and produces an initial verdict against the `>15s warm = KILL` gate. Publish honest median + p95 wall-clock with explicit "small-N" caveats.

### Why this is the right Slice 1

The KILL gate decision (`>15s warm → spawn WI-FAST-PATH-VERIFIER`) is the most operationally valuable signal in the whole B7 effort: it determines whether the fast-path verifier needs to start in parallel with Slice 2. We do not need ≥30 utilities or multi-hardware coverage to make that call — 3–5 representative utilities on the implementer's local machine produce a defensible point estimate. The KILL gate is binary; we either hit it or we don't.

By contrast, Slice 2 (corpus scale-up) and Slice 3 (multi-hardware) refine the precision of the median estimate but do not change the KILL-gate verdict if Slice 1's N=3–5 produces wall-clocks an order of magnitude away from 15 s. If Slice 1 lands at 1 s warm, we know KILL is not triggered without measuring 30 more utilities. If Slice 1 lands at 25 s warm, KILL fires immediately and the fast-path verifier WI files before Slice 2 starts.

### Files to create (under `bench/B7-commit/`)

| File | Role |
|------|------|
| `README.md` | User-facing run instructions (mirror B6-airgap shape) |
| `corpus/` | Directory containing 3–5 `*.ts` utility source files |
| `corpus-spec.json` | SHA-256 of each corpus file + N=3–5 declaration |
| `harness/run.mjs` | Orchestrator: warm + cold runs, writes artifact JSON, prints verdict |
| `package.json` | bench-local manifest (B5 pattern) — declares no deps beyond root |
| `.gitignore` | Excludes `tmp/` and any per-run sqlite scratch files |

Also: add `"bench:commit": "node bench/B7-commit/harness/run.mjs"` to root `package.json` `scripts`.

### Architectural shape (constraints — implementer chooses details)

The harness, per emission:

1. Open a fresh SQLite registry at a temp path (cold-cache case) OR reuse a registry warmed by a prior "shape-similar" atomize (warm-cache case — see "Open Question 2" for the warm-cache definition).
2. Read the utility source file from `bench/B7-commit/corpus/<name>.ts`.
3. Capture `t0_emit = Date.now()`.
4. Invoke `atomizeEmission({ emittedCode, toolName: "Write", registry })` from `@yakcc/hooks-base`.
5. Capture `t2_atomized = Date.now()`. Record `atomized` outcome and `atomsCreated[0].blockMerkleRoot`.
6. Query `registry.findCandidatesByIntent({ behavior: <JSDoc-derived intent> }, { k: 5 })`.
7. Capture `t3_query_hit = Date.now()`. Verify the just-stored BMR is in top-K and combined score ≥ 0.70.
8. Close the registry. Repeat for the next utility / cache state.

Repetition: each utility runs **N=5 times per cache state** to capture variance (median + p95). Slice 2 scales to N=10+ as part of the methodology decision; Slice 1 fixes N=5 for the implementer (no per-rep blowups: 5 utilities × 2 cache states × 5 reps = 50 measurements per slice-1 run, ≤30 minutes on a single machine).

### Artifact format (Slice 1)

`tmp/B7-commit/slice1-<timestamp>.json`:

```json
{
  "slice": "1",
  "timestamp": "...",
  "environment": { "platform": "...", "arch": "...", "cpu": "...", "node": "...", "yakcc_head": "..." },
  "corpus": { "n_utilities": 5, "spec_sha256": "...", "utilities": [...] },
  "measurements": [
    {
      "utility": "iso-duration-to-seconds",
      "cache_state": "warm",
      "rep": 1,
      "t0_emit_ms": 0,
      "t2_atomized_ms": 1234,
      "t3_query_hit_ms": 1267,
      "atomized": true,
      "bmr_short": "a1b2c3d4",
      "round_trip_ms": 1267,
      "query_hit_top_k": true,
      "top_1_combined_score": 0.91
    }
  ],
  "aggregate": {
    "warm": { "median_round_trip_ms": ..., "p95_round_trip_ms": ..., "n": 25 },
    "cold": { "median_round_trip_ms": ..., "p95_round_trip_ms": ..., "n": 25 }
  },
  "verdict": {
    "warm_median_ms": ...,
    "warm_vs_kill_15s": "below" | "above",
    "warm_vs_hard_cap_10s": "below" | "above",
    "warm_vs_aspirational_3s": "below" | "above",
    "slice_1_call_to_action": "KILL — file WI-FAST-PATH-VERIFIER immediately" | "WARN — proceed to Slice 2" | "PASS-provisional — N=5 too small for final verdict; proceed to Slice 2"
  }
}
```

### Acceptance criteria (Slice 1)

- [ ] `pnpm bench:commit` runs from a clean clone (after `pnpm install` + `pnpm build`) without manual setup beyond what `bench/B6-airgap` requires (Anthropic key NOT required — static/offline path only).
- [ ] 3–5 utility source files live under `bench/B7-commit/corpus/` with matching `corpus-spec.json` SHA-256 entries; harness verifies SHA-256 on startup and aborts on drift (mirrors B1's corpus-spec discipline).
- [ ] Harness invokes the real `atomizeEmission` from `@yakcc/hooks-base` and real `registry.findCandidatesByIntent` from `@yakcc/registry` — no stubs.
- [ ] Each utility produces at least one atom (`atomized=true`) AND a top-K hit for its own BMR with combined score ≥ 0.70 (the v0-smoke Step 9 oracle).
- [ ] Artifact JSON written to `tmp/B7-commit/slice1-<timestamp>.json` with the format above; verdict string in `slice_1_call_to_action` is one of the three enumerated values.
- [ ] `README.md` documents how to run, the small-N caveat ("N=5 utilities, single hardware — Slice 1 verdict is provisional"), and links to #191.
- [ ] `@decision DEC-BENCH-B7-HARNESS-001` header comment in `harness/run.mjs` documents the timing methodology (capture points, registry isolation per measurement, warm-vs-cold definition, why no LLM call).
- [ ] Implementer runs the harness on their local machine and posts the resulting verdict as a comment on issue #191. If verdict is KILL: implementer also files `WI-FAST-PATH-VERIFIER` per #191's acceptance clause; this WI-FAST-PATH-VERIFIER filing is part of Slice 1's acceptance.

### Estimated implementer time

**1.0–1.5 days.** This is a constrained harness against an existing, fully-implemented production path. The atomize path is shipped (#368), the round-trip oracle is shipped (v0-smoke Steps 8b–9), and B6/B5/B1 give three independent harness shapes to mirror. The implementer's actual work is:

- Author 3–5 utilities + JSDoc (~3 hours)
- Wire the harness (~4 hours, mostly cribbed from v0-smoke Step 8b)
- Run + iterate on the warm-cache definition (~2 hours)
- Artifact format + verdict string (~1 hour)
- README + DEC annotation + posting verdict comment (~1 hour)

If the warm-cache definition (Open Question 2 below) turns out to require a non-trivial registry-priming step, add a half-day buffer.

### Dependencies that must land before Slice 1 dispatch

- ✅ `atomizeEmission` exported from `@yakcc/hooks-base` — shipped in PR #368.
- ✅ `registry.findCandidatesByIntent` on `@yakcc/registry` — shipped, exercised by v0-smoke Step 9.
- ✅ `novel-glue-flywheel.ts` reference fixture pattern — shipped in 853edc7 (#360 gap fix).
- ⚠️ Open Question 1 below (corpus selection) — resolve before dispatch.
- ⚠️ Open Question 2 below (warm-cache definition) — resolve before dispatch.

### What Slice 1 explicitly defers

- Corpus scale-up to ≥30 utilities (Slice 2).
- Cold-cache vs. warm-cache full split with median + p95 + p99 (Slice 2 expands rep count; Slice 1 captures both states but with low N).
- Multi-hardware coverage (M-series Mac + mid-tier Linux) (Slice 3).
- The final `DEC-BENCH-B7-001` annotation against the issue's published pass bar (Slice 3).
- Nightly CI integration (`.github/workflows/bench-b7-commit.yml`) (Slice 3).
- LLM-driven emission (current scope uses pre-canned source files; live-LLM emission would change the methodology and is out of scope per the issue's "AI agent emits TS source" simulation latitude — pre-canned source matches the published methodology when the emission step itself is not the metric being timed).

---

## Slice 2 — Corpus scale-up to ≥30 + cache-state split

### Scope

Expand the corpus from 3–5 utilities to ≥30. Run warm and cold cache as two distinct cells with N ≥ 10 reps each. Publish median + p95 + p99 per cell. The slice produces the published methodology that Slice 3 then reports against multiple hardware.

### Files to create / modify

| File | Action |
|------|--------|
| `bench/B7-commit/corpus/*.ts` | Add ≥25 more utility files (total ≥30) |
| `bench/B7-commit/corpus-spec.json` | Update with all SHA-256 entries; bump `n_utilities` to ≥30 |
| `bench/B7-commit/harness/run.mjs` | Increase rep count to ≥10; split warm/cold into separate "phases" with cleaner registry isolation |
| `bench/B7-commit/README.md` | Update with Slice 2 methodology, link to corpus authoring rationale |
| `bench/B7-commit/CORPUS_RATIONALE.md` | New — document why each utility was selected (adversarial framing: real properties, not trivial passthroughs) |

### Acceptance criteria (Slice 2)

- [ ] ≥30 utility files under `bench/B7-commit/corpus/`, each with substantive JSDoc and a body of ≥3 statements (passes atomize.ts `TRIVIAL_BODY_THRESHOLD`).
- [ ] Every utility's intent text in JSDoc is novel relative to the bootstrap registry (no top-K hit ≥ 0.70 in a fresh registry pre-atomize) — verified by a corpus-validation step in the harness.
- [ ] `CORPUS_RATIONALE.md` documents per-utility selection rationale; passes the "adversarial framing" forbidden-shortcut cornerstone — explicit per-utility note on why this requires real verification.
- [ ] Artifact format extends Slice 1 with `median_ms`, `p95_ms`, `p99_ms` per cell (warm/cold).
- [ ] Total runtime ≤ 90 minutes on a developer laptop (30 × 2 × 10 = 600 measurements at <10 s each).
- [ ] `@decision DEC-BENCH-B7-CORPUS-001` annotation in `corpus-spec.json` header comment OR `CORPUS_RATIONALE.md` frontmatter — locks the corpus content (cornerstone: no-versioning of measurement inputs).
- [ ] Implementer posts the Slice 2 verdict table as a comment on #191.

### Estimated implementer time

**3–4 days.** Corpus authoring is the dominant cost (≥25 hand-written utilities + JSDoc + selection rationale per utility ≈ 1 hour each = 25 hours, plus the harness updates ≈ 4 hours, plus the validation step ≈ 4 hours). The "real properties, not trivial passthroughs" cornerstone is what makes this expensive — utilities like "valid IPv4 detector" and "ISO duration parser" have non-trivial property spaces.

### Dependencies that must land before Slice 2 dispatch

- ✅ Slice 1 must be merged (gives the harness shape, the artifact format, and either the KILL-gate decision or a green light).
- ⚠️ If Slice 1 verdict is KILL: `WI-FAST-PATH-VERIFIER` should be dispatched in parallel — Slice 2 still proceeds with current infra (the issue body explicitly says "measure-and-publish-honestly is more valuable than waiting"), and re-runs once the fast-path verifier lands.

---

## Slice 3 — Multi-hardware + final acceptance + DEC-BENCH-B7-001

### Scope

Execute the Slice 2 corpus on the two reference hardware platforms (M-series Mac, mid-tier Linux). Compile the full results table (30 utilities × 2 cache states × 2 hardware × N=10 reps ≥ 1200 measurements). Render the final acceptance verdict. Annotate `@decision DEC-BENCH-B7-001`. Optionally wire a nightly CI on `ubuntu-latest` mirroring B1.

### Files to create / modify

| File | Action |
|------|--------|
| `bench/B7-commit/results-<hardware>-<date>.json` | One per hardware, committed to the PR |
| `bench/B7-commit/README.md` | Final results table with all four cells |
| `bench/B7-commit/harness/run.mjs` | Add `--hardware-label` arg to tag artifacts; minor; no structural changes |
| `.github/workflows/bench-b7-commit.yml` | Nightly CI for `ubuntu-latest` (mirrors `bench-b1-latency.yml` shape exactly) — optional but recommended |
| `bench/B7-commit/post-nightly-comment.mjs` | Posts verdict to #191 nightly — only if CI workflow lands |

### Acceptance criteria (Slice 3)

- [ ] Results JSON committed for both reference hardware platforms (M-series Mac + mid-tier Linux). If implementer cannot access one of the platforms, document the gap and leave a stub artifact with `"status": "hardware-not-available"`.
- [ ] Final table in `README.md` with median + p95 + p99 per `(cache_state × hardware)` cell.
- [ ] `@decision DEC-BENCH-B7-001` annotated in `harness/run.mjs` header — captures the verdict (PASS-aspirational / PASS-hard-cap / WARN / KILL) and references the underlying numerical evidence.
- [ ] If the verdict is KILL on warm cache: `WI-FAST-PATH-VERIFIER` is filed (if not already filed in Slice 1) with the Slice 3 measurements as the empirical baseline.
- [ ] If wall-clock >5 s warm but ≤15 s warm: `WI-FAST-PATH-VERIFIER` is filed as documented in the issue acceptance clause ("If wall-clock >5s warm: WI-FAST-PATH-VERIFIER sub-ticket filed with empirical baseline"). This obligation persists regardless of KILL status.
- [ ] Nightly CI workflow lands (or is explicitly deferred as a follow-up WI with rationale).
- [ ] Issue #191 closed with the final verdict comment.

### Estimated implementer time

**2–3 days.** Mostly orchestration: running on two hardware platforms (or accepting one), aggregating, writing the final report, annotating the decision. The CI workflow is ~3 hours by direct analogy to `bench-b1-latency.yml`.

### Dependencies that must land before Slice 3 dispatch

- ✅ Slice 2 must be merged (gives the corpus, the methodology, and the single-hardware reference numbers).
- ⚠️ Hardware access. If the implementer is Windows-only (the orchestrator's known environment), Slice 3 may require dispatching to a remote runner or accepting `ubuntu-latest` GHA as the substitute for "mid-tier Linux." Document the substitution in the verdict.

---

## Decision IDs to mint

The three decision IDs span the slice cascade:

| Decision ID | Minted in | Captures |
|-------------|-----------|----------|
| `DEC-BENCH-B7-HARNESS-001` | Slice 1 (`harness/run.mjs` header) | Timing methodology: capture points, registry isolation per measurement, warm-vs-cold definition, choice of pre-canned source over live LLM emission |
| `DEC-BENCH-B7-CORPUS-001` | Slice 2 (`corpus-spec.json` header OR `CORPUS_RATIONALE.md`) | Per-utility selection rationale + adversarial-framing discipline; locks corpus content (no-versioning cornerstone) |
| `DEC-BENCH-B7-001` | Slice 3 (`harness/run.mjs` header, replaces or augments `DEC-BENCH-B7-HARNESS-001`) | Final pass/KILL verdict vs. issue #191's bars + cross-reference to underlying measurement evidence |

---

## Open architectural questions (resolve before Slice 1 dispatch)

The orchestrator/user makes these calls; the planner does not unilaterally pick them.

### Open Question 1 — Which 3–5 utilities seed the Slice 1 corpus?

Recommended seed set (covers four shape classes that exercise different parts of the verification path):

| Utility | Shape class | Why |
|---------|-------------|-----|
| `iso-duration-to-seconds` | String parsing → numeric | Real properties (associativity of parse + round-trip), genuinely novel |
| `is-valid-ipv4` | String predicate (boolean output) | Real properties (boundary cases on each octet), uses regex + numeric checks |
| `hamming-distance` | Two-string scalar | Real properties (symmetry, identity-of-indiscernibles, triangle inequality), uses string indexing |
| `camel-to-snake-preserving-acronyms` | String transform | Real properties (idempotence on already-snake input, length monotonicity), uses Unicode-aware iteration |
| `array-median` | Numeric array → scalar | Already the `arrayMedian` fixture in v0-smoke — confirms the harness reproduces existing baseline |

Note: `array-median` is **deliberately the same fixture as v0-smoke Step 8b** for cross-harness consistency — the B7 timing for this utility should match v0-smoke's "step8bDurationMs" within noise. This validates the harness before trusting the other four numbers.

The implementer drafts the actual utility bodies; this list is the orchestrator-approved seed list.

### Open Question 2 — How is "warm cache" defined?

The issue body says "previous similar utility verified in this session (registry knows the shape)" — this is ambiguous. Three options:

| Option | "Warm" means | Pro | Con |
|--------|--------------|-----|-----|
| (a) **Same atom, second insert** | Re-atomize the same source code; second call hits `INSERT OR IGNORE` no-op | Cleanest measurement; isolates registry write cost | Doesn't test the "shape-similar" caching the issue describes |
| (b) **Pre-warmed registry with 100 unrelated atoms** | Run atomize against a registry that already has 100 atoms from `bench/v0-release-smoke` corpus | Tests realistic registry load | Variance from which 100 atoms are loaded |
| (c) **Same shape, different content** | Atomize utility A, then atomize utility B that shares signature shape (`number[] → number`) | Closest to issue's "registry knows the shape" language | Hardest to control; shave's static strategy may not have cross-utility caching to exercise |

**Recommendation: (b)** — pre-warmed registry with a known-fixed set of 100 atoms drawn from `bench/v0-release-smoke/fixtures/known-match.ts` and the bootstrap corpus, hashed and committed. This best models the developer-flow scenario the issue describes and is deterministic.

**Cold cache** is unambiguous: a fresh empty SQLite registry per measurement.

### Open Question 3 — Is the "AI agent emits" step a real LLM call or pre-canned source?

The issue body says "AI agent emits TS source" but does not specify whether the emission itself is timed. The post-#368 path treats the LLM call as out-of-band: the hook intercepts a Tool emission and the wall-clock starts at the intercept point, not at the LLM token-generation point.

**Recommendation: pre-canned source files** under `bench/B7-commit/corpus/`. The metric is "time-to-commit for a novel utility" — the LLM token-generation latency is a separate metric (covered by B4 token-expenditure work, not yet started). Pre-canned source isolates B7's metric to the verify-and-register path that #167's DQ-3 calls out specifically. A live-LLM variant could be filed as a follow-up benchmark (e.g., B7b) but is **explicitly out of scope for Slices 1–3 here.**

Document this in `DEC-BENCH-B7-HARNESS-001` so the methodology is explicit and reviewable.

### Open Question 4 — Does the harness need a packet-capture sidecar like B6?

B6 enforces zero-outbound via `network-interceptor.cjs`. The atomize path is already documented in `atomize.ts` as B6-safe (uses `intentStrategy: "static"`, `offline: true`, no Anthropic API). B7 does not need to re-prove the air-gap claim — that is B6's job — but the harness MUST NOT introduce new outbound calls accidentally.

**Recommendation: skip the interceptor in Slice 1.** If Slice 3's CI integration warrants it, optionally add a single B6-style assertion ("outboundCount === 0") as a gate. Not a Slice 1 obligation.

---

## Forward motion after this plan is approved

Slice 1 is filed as a separate GitHub issue (titled `[FuckGoblin] WI-B7-SLICE-1: Harness MVP + initial measurement (parent #191)`) with the scoped acceptance criteria from this document. The orchestrator dispatches the implementer against that issue. Slices 2 and 3 are filed only after Slice 1 lands and its verdict is known — explicitly because the Slice 1 verdict (KILL vs. WARN vs. PASS-provisional) directly conditions Slice 2's framing.

---

## Summary table

| Slice | Scope | Files | Time | Dispatchable now? |
|-------|-------|-------|------|-------------------|
| 1 | Harness MVP + 3–5 fixtures + KILL-gate decision | ~6 files under `bench/B7-commit/` + 1 line in root `package.json` | 1.0–1.5 days | **Yes** — after Open Questions 1+2 resolved |
| 2 | Corpus scale-up to ≥30 + cache-state split | ~30 corpus files + harness rep-count bump + `CORPUS_RATIONALE.md` | 3–4 days | No — waits on Slice 1 verdict |
| 3 | Multi-hardware + DEC-BENCH-B7-001 + optional CI | 2 results JSONs + CI workflow + final README | 2–3 days | No — waits on Slice 2 |

**Total estimated implementer time across the cascade: 6–8.5 days.** This matches the issue body's "~1.5 weeks" estimate.

---

_Plan authored 2026-05-11 by orchestrator/planner. No implementation under `bench/B7-commit/` other than this document. The companion GitHub issue for Slice 1 is filed separately and is the source of truth for dispatch._
