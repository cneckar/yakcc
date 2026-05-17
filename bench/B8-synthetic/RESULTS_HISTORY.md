<!--
@decision DEC-BENCH-B8-REVALIDATION-MASTER-001
@title B8-synthetic re-validation against current architecture (WI-611)
@status accepted
@rationale
  Re-validate the 2026-05-14 B8-synthetic KILL verdict against the current architecture.
  Two-slice approach: Slice 1 = cheap-and-immediate run against the local .yakcc/registry.sqlite
  (2026-05-12, predates all WI-510 and WI-579 slices); Slice 2 = post-cascade run against
  operator-supplied current bootstrap registry. Slice 1 surfaces the 2026-05-14 artifact anomaly
  (all 38 blocks hit '00cacace' at ~0.75 — a registry-degeneracy signal) which is the primary
  structural reason the 2026-05-14 KILL verdict cannot be treated as definitive.
  Decision DEC-BENCH-B8-REVAL-TWO-SLICE-001, DEC-BENCH-B8-REVAL-LOCAL-REGISTRY-001,
  DEC-BENCH-B8-REVAL-ARTIFACT-LOC-001, DEC-BENCH-B8-REVAL-METHODOLOGY-LOCKED-001 documented
  in the same frontmatter below.

@decision DEC-BENCH-B8-REVAL-TWO-SLICE-001
@title Two-slice decomposition — Slice 1 cheap-and-immediate; Slice 2 operator-gated
@status accepted
@rationale
  Slice 1 ships in 30-45 min and captures ~75% of the headline question. Slice 2 ships when
  operator provides current bootstrap-registry snapshot (30-60 min cold per CI evidence —
  bootstrap.yml 90-min timeout). Bundling Slice 2 into Slice 1 would tie land time to a
  60-90 min cold build path not within a single implementer's bounded slice budget.

@decision DEC-BENCH-B8-REVAL-LOCAL-REGISTRY-001
@title Slice 1 uses .yakcc/registry.sqlite (2026-05-12) as the registry input
@status accepted
@rationale
  Limitation acknowledged: this registry predates all WI-510 (8 slices, #526-#616) and
  WI-579 (6 slices, #589-#613) atoms. Slice 1's information value: (a) confirms or refutes
  the 2026-05-14 anomaly on a known-non-degenerate registry, (b) provides an apples-to-apples
  comparison (both baselines predate the cascade), (c) isolates registry-degeneracy from
  corpus-coverage as separate effects for Slice 2 to disentangle.

@decision DEC-BENCH-B8-REVAL-ARTIFACT-LOC-001
@title Result file location and naming convention
@status accepted
@rationale
  New results live at bench/B8-synthetic/results-<platform>-<date>-revalidation-slice<N>.json
  (sibling to the existing 2026-05-14 file, NOT in tmp/). Two-file separation: README.md stays
  a "what is this bench" doc; RESULTS_HISTORY.md is the append-only run interpretation log.

@decision DEC-BENCH-B8-REVAL-METHODOLOGY-LOCKED-001
@title Simulator, savings heuristic, threshold, and corpus are immutable for WI-611 slices
@status accepted
@rationale
  Per DEC-BENCH-B8-SYNTHETIC-SLICE1-001: CONFIDENT_THRESHOLD=0.70, HOOK_TOKENS_PER_HIT=45,
  corpus SHA-256=40788cc0... are locked. The only lever Slice 1/2 pull is --registry <path>.
  Any bug found in the simulator is filed as a separate WI per #167 Principle 6.
-->

# B8-synthetic RESULTS HISTORY

This file is the per-run interpretation log for the B8-SYNTHETIC benchmark. It documents
each result, the registry state at run time, anomaly findings, and verdict reconciliations.

**What this file is not:** a README or how-to-run guide. See `bench/B8-synthetic/README.md`
for benchmark description and `bench/B8-synthetic/RUBRIC.md` for pass/KILL bars.

---

## Section 0 — Pre-history: the 2026-05-14 anomaly

**File:** `bench/B8-synthetic/results-darwin-2026-05-14-slice1.json`
**Platform:** darwin (macOS)
**Registry:** `bootstrap/yakcc.registry.sqlite` at path `/Users/cris/src/yakcc/bootstrap/yakcc.registry.sqlite`
**Run date:** 2026-05-14T04:48:49Z
**Verdict reported:** KILL — `"mean savings 9.2% < 50% KILL bar — architecture fundamentally limited; production cannot exceed this ceiling"`

### The anomaly — verbatim JSON evidence

Every single block in every single task hit the same atom (`"00cacace"`) at a score band of
`[0.7499998212..., 0.7500000894]` — effectively 0.75 ± 3e-7:

```json
// substrate-001-sort-integers, b1
{ "hit": true, "match_atom": "00cacace", "top1_score": 0.7500000298023215 }
// substrate-001-sort-integers, b2
{ "hit": true, "match_atom": "00cacace", "top1_score": 0.7500000298023215 }
// substrate-001-sort-integers, b3
{ "hit": true, "match_atom": "00cacace", "top1_score": 0.7500000596046412 }
// substrate-002-parse-int, b1
{ "hit": true, "match_atom": "00cacace", "top1_score": 0.75 }
// ... (all 38 blocks identical pattern — unique atom count: 1, score range: 0.7499998 to 0.7500001)
```

Aggregate: `mean_hit_rate: 1.0` (100%), distinct atoms across all 38 hit blocks: **1**.

**This is a registry-degeneracy signature.** Real registry behavior cannot return the same atom
at effectively the same score for every distinct query across every tier (substrate, glue,
application). Three independent signals confirm:

1. **Score uniformity:** 0.75 ± 3e-7 across 38 diverse queries. BGE embeddings for different
   descriptions produce different cosine similarities; the near-identity means every query was
   matched to the same zero-or-near-zero embedding (or a single embedding dominated the full
   candidate pool at a constant cosine bias).
2. **Single-atom degeneracy:** `00cacace` is the first 8 hex chars of some `blockMerkleRoot`
   in the registry. 100% hit rate to a single atom across all tier descriptions (sort integers,
   parse int, hash map, http router, error mapper, crud endpoint, event emitter...) is
   architecturally impossible in a healthy corpus.
3. **Live smoke probe (2026-05-17):** `behavior="sort integers ascending"` against the local
   `.yakcc/registry.sqlite` (2026-05-12) returned 10 candidates, `top1=0.56`, `top atom=97e39d34`.
   Different atom, different score, below CONFIDENT_THRESHOLD — confirming normal registry behavior.

**Probable cause:** The `bootstrap/yakcc.registry.sqlite` used for the 2026-05-14 run was either
empty (only one bootstrapped atom), or in a degenerate state where the single-vector schema had
a single near-zero embedding row that scored at the BGE model's cosine offset (~0.75) for any
input. The KILL verdict was computed from the 9.2% savings figure, which was itself produced by
the 100% hit-rate-on-one-atom shape (all blocks "substituted" at HOOK_TOKENS_PER_HIT=45 tokens,
yielding the savings heuristic's output). The verdict text ("architecture fundamentally limited;
production cannot exceed this ceiling") was inferred from the savings %, not from a real
architectural measurement.

**Conclusion:** The 2026-05-14 KILL verdict is **artifact-driven** (degenerate registry state
at run time), not architecture-driven. It cannot be treated as a load-bearing finding.

---

## Section 1 — 2026-05-17 Slice 1 revalidation against local registry

**File:** `bench/B8-synthetic/results-linux-2026-05-17-revalidation-slice1.json`
**Platform:** linux x86_64
**Registry:** `.yakcc/registry.sqlite` — born 2026-05-12T03:13:35 UTC, 1,867,776 bytes
**Run date:** 2026-05-17T00:40:05Z
**Command:** `node bench/B8-synthetic/run.mjs --registry .yakcc/registry.sqlite --packages-root <repo_root>`
**Raw harness output SHA-256:** `453f5c6de0de790d723419dba359e920ea728e365b38aa9705c38499dd46b718`
**Methodology:** Unmodified (DEC-BENCH-B8-REVAL-METHODOLOGY-LOCKED-001 — harness, simulator, threshold, corpus all locked)

### Verdict (verbatim from result file)

```json
{
  "verdict": "KILL",
  "reason": "mean savings 0.0% < 50% KILL bar — architecture fundamentally limited; production cannot exceed this ceiling"
}
```

### Aggregate results

| Metric                         | All Tasks | With Coverage |
|-------------------------------|-----------|---------------|
| Tasks (N)                     |        10 |             0 |
| Mean hit rate                 |      0.0% |          0.0% |
| Mean savings % (per-task avg) |      0.0% |          0.0% |
| Total savings % (corpus)      |      0.0% |          0.0% |
| Total raw tokens              |      2089 |             0 |
| Total hook tokens             |      2089 |             0 |

### Per-tier breakdown

| Tier        | N | Mean hit rate | Mean savings % |
|-------------|---|---------------|----------------|
| substrate   | 4 |          0.0% |           0.0% |
| glue        | 3 |          0.0% |           0.0% |
| application | 3 |          0.0% |           0.0% |

No tier shows net-positive savings. Unlike hypothesis 1 below (size-floor effect would show
substrate net-negative with glue/app net-positive), all three tiers show exactly 0% — because
there are no hits at all. The per-tier shape does not differentiate between hypotheses 2 and 3
(see analysis below).

### Distinct-atom sanity check

```
jq '[.per_task[].blocks[] | select(.hit) | .match_atom] | unique | length'
bench/B8-synthetic/results-linux-2026-05-17-revalidation-slice1.json
→ 0
```

Result: **0 distinct atoms among hit blocks** (because there are 0 hit blocks). This is NOT the
degenerate all-same-atom case from 2026-05-14. It is a coverage-gap case: the registry has no
atoms that score above CONFIDENT_THRESHOLD (0.70) for any of the corpus block descriptions.

### Score distribution

All 38 blocks across 10 tasks returned top1 scores below the 0.70 threshold:

| Statistic | Value |
|-----------|-------|
| Min top1  | 0.5471 |
| Median top1 | 0.5824 |
| Max top1  | 0.6126 |

The scores are **diverse** (not uniform) — this registry is non-degenerate. The problem is
coverage: the registry doesn't contain atoms whose embeddings are similar enough to the corpus
block descriptions to cross the 0.70 confidence gate.

### Registry state summary

| Field | Value |
|-------|-------|
| Registry file | `.yakcc/registry.sqlite` |
| Birth date | 2026-05-12T03:13:35 UTC |
| Age at run date | 4 days |
| Size | 1,867,776 bytes (1.8 MB) |

**Known missing initiatives** (landed after registry birth):

- `#526` (WI-510 Slice 1 — dependency-following shave engine, 2026-05-14)
- `#544` (WI-510 Slice 2 — four validator headline bindings, 2026-05-15)
- `#570/#571` (WI-510 Slice 3 — semver@7.8.0, 2026-05-15)
- `#573` (WI-510 Slice 4 — uuid@11.1.1 + nanoid@3.3.12, 2026-05-15)
- `#584` (WI-510 Slice 5 — date-fns@4.1.0, 2026-05-16)
- `#586` (WI-510 Slice 6 — jsonwebtoken@9.0.2 + bcryptjs@2.4.3, 2026-05-16)
- `#598` (WI-510 Slice 7 — lodash@4.17.21, 2026-05-16)
- `#616` (WI-510 Slice 8 — zod@3.25.76, 2026-05-17)
- `#589` (WI-579 Slice 1 — Layer 1 intent-specificity gate, 2026-05-15)
- `#597` (WI-579 Slice 2 — Layer 2 result-set size enforcement, 2026-05-15)
- `#599` (WI-579 Slice 3 — Layer 3 atom-size ratio enforcement, 2026-05-15)
- `#602` (WI-579 Slice 4 — Layer 4 descent-depth tracker, 2026-05-15)
- `#603` (WI-579 Slice 5 — Layer 5 telemetry-driven drift detection, 2026-05-16)
- `#606` (WI-579 Slice 6 — 6-layer enforcement complete, 2026-05-16)
- `#613` (WI-579 fix — Layer 4 descent-tracker key parity, 2026-05-17)

**This registry predates all WI-510 and WI-579 work.** The atoms those slices added are absent
from the corpus used for this measurement.

### Causal hypothesis analysis

The plan (WI-611 §3 D8) requires walking three hypotheses for any KILL result. All three remain
live because Slice 2 has not yet run.

**Hypothesis 1 — Methodology truth (size-floor effect)**

The simulator's `HOOK_TOKENS_PER_HIT = 45` means a substitution is net-positive only when the
block's `raw_tokens` exceed ~45 tokens (the hook overhead). Substrate blocks in this corpus are
small (median ~30 tokens). If the registry had full coverage, substrate blocks would be net-negative
while glue and application blocks (median 90-170 tokens) would be net-positive. This per-tier
asymmetry is the "size-floor effect" documented in `DEC-BENCH-B8-SYNTHETIC-SLICE1-001`.

**This hypothesis is not testable from Slice 1 data alone** because there are zero hits in any
tier — the per-tier savings are uniformly zero regardless of block size. Hypothesis 1 would
only become visible in a run with nonzero hit rate (Slice 2, or a direct query-coverage probe).
The Slice 1 data is consistent with Hypothesis 1 but does not confirm it.

**Hypothesis 2 — Registry coverage gap**

The local registry (2026-05-12) contains atoms for the corpus shaved as of that date. The B8
transcript corpus was authored to describe general programming tasks (sort integers, parse int,
http router, etc.) — not the specific npm library atoms added by WI-510 (validator, semver,
uuid, date-fns, jsonwebtoken, lodash, zod). The Slice 1 result is fully consistent with
Hypothesis 2: the registry has atoms, but they don't semantically match the corpus descriptions
at the 0.70 confidence threshold.

**Slice 1 scores (0.55–0.61) being consistently below 0.70 but not near zero** supports this
hypothesis: the registry can return plausible candidates (non-zero cosine similarity) but lacks
the specific atoms the corpus is asking for. A registry with WI-510 atoms would be expected to
score higher on some queries — but only Slice 2 can verify that.

**Hypothesis 3 — Architecture limit**

Even with full corpus coverage and post-WI-510 atoms, the substitution-token-cost model might
genuinely cap savings below 50%. This would mean the KILL claim survives even on a healthy
post-cascade registry. Slice 1 cannot rule this out.

**Current classification:** The 2026-05-14 KILL is **artifact-driven** (confirmed by Section 0 —
all-same-atom degeneracy). The Slice 1 KILL is **coverage-gap-consistent** (Hypothesis 2) but
does not rule out Hypothesis 3. Neither Slice 1 KILL validates the 2026-05-14 verdict, because
they have different root causes: the 2026-05-14 registry was degenerate (100% fake hits at 0.75),
the 2026-05-17 registry is non-degenerate but lacks matching atoms (0% real hits at 0.55–0.61).

### What this datapoint tells us

1. **The 2026-05-14 KILL verdict is artifact-driven, not architecture-driven.** The Slice 1
   run against a confirmed-non-degenerate registry returns a completely different result shape
   (0 hits vs 100% uniform hits). The 2026-05-14 claim "architecture fundamentally limited;
   production cannot exceed this ceiling" was derived from garbage registry data. That verdict
   should not be used as a data point in any architectural decision.

2. **The Slice 1 KILL is a valid measurement, but against a stale registry.** The 0% hit rate
   reflects the registry at 2026-05-12, before 8 WI-510 slices added headline-binding atoms
   for the exact npm libraries the hook layer targets. This is an expected-low baseline, not
   evidence of an architecture ceiling.

3. **The #193 B8-CURVE gating question is unchanged.** Slice 1 is not the datapoint that can
   answer whether the post-WI-510 architecture reaches the asymptote bar (≥80% savings) or
   stays below the KILL bar (<50%). Per the plan (DEC-BENCH-B8-REVAL-TWO-SLICE-001), that
   determination belongs to Slice 2.

### What Slice 2 would prove or disprove

Slice 2 re-runs B8-synthetic against a current bootstrap registry that includes all WI-510
(Slices 1–8) and WI-579 atoms. If Slice 2 shows a nonzero hit rate with diverse atoms and the
savings exceed 50%, Hypothesis 3 (architecture limit) is ruled out and the project can close
the KILL verdict as stale. If Slice 2 still produces KILL even with full corpus coverage, then
Hypothesis 1 (size-floor effect of HOOK_TOKENS_PER_HIT=45) and Hypothesis 3 (genuine
architecture ceiling) must be disambiguated — likely by examining per-tier savings and
considering corpus expansion (larger representative blocks).

**Operator prerequisite for Slice 2:** Run `pnpm -r build && node packages/cli/dist/bin.js bootstrap`
on a host with current `main` HEAD (30-60 min cold per CI evidence). Copy the resulting
`bootstrap/yakcc.registry.sqlite` to a path the implementer can read. File a follow-up dispatch
citing the artifact path.

---

*This file is append-only. Each new B8-synthetic run adds a new section.*
*Authored by Wrath (implementer, WI-611 Slice 1). Decision DEC-BENCH-B8-REVALIDATION-MASTER-001.*
