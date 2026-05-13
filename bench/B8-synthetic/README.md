# B8-SYNTHETIC — Pre-hook Scaling-Curve Prototype via Transcript Replay

<!--
@decision DEC-V0-BENCH-SLICE3-RELABEL-001
@title B8-synthetic pass-bars are directional targets only pre-characterisation-data
@status accepted
@rationale Per WI-BENCHMARK-SUITE-CHARACTERISATION-PASS, pass-bars are directional targets only pre-characterisation-data.
-->

> **Note (WI-BENCHMARK-SUITE-CHARACTERISATION-PASS / PR #448):** This bench is part of the `WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` initiative (PR #448). Pass-bars are directional targets only; no measurement triggers a project-level KILL pre-data. Pass-bar revision happens after the characterisation distributions are in.

**Parent issue:** [#192](https://github.com/cneckar/yakcc/issues/192)  
**Parent suite:** [#167](https://github.com/cneckar/yakcc/issues/167) (WI-BENCHMARK-SUITE)  
**Decision:** `DEC-BENCH-B8-SYNTHETIC-SLICE1-001`  
**Status:** Slice 1 complete

---

## What This Is

B8-SYNTHETIC produces a preliminary token-savings scaling curve by replaying
curated LLM transcript fixtures through a **simulated** hook layer. It provides
defensible scaling-curve data before the production hook layer ships.

Per #167 DQ-2: synthetic harness simulates **best-case** hook behavior (perfect
interception, zero overhead). Production B8 numbers can only be *worse*, not better
— synthetic is therefore a **conservative ceiling**, not a misleading projection.

---

## D1 Gate Clarification

Issue #192 says "gated only on D1". D1 was decided NOT-shipping per #150's closing
comments — single-vector + BGE + D3 strictness fix meets all quality targets. This
benchmark uses the **shipped single-vector schema** (the registry's actual current
state). The benchmark measures the hook's scaling characteristics, which is independent
of whether D1 ships.

---

## Methodology

For each emission block in each transcript:

1. Construct a `QueryIntentCard` from `block.description` (behavior text)
2. Call `registry.findCandidatesByQuery()` against the bootstrap registry
3. Apply `CONFIDENT_THRESHOLD = 0.70` (from `@yakcc/hooks-base`)
4. Record: `hit` (top-1 combinedScore ≥ 0.70), `match_atom`, `top1_score`

Token savings heuristic (per hit block):
- Raw: `block.estimated_raw_tokens` (authored in fixture)
- Hook substitution cost: ~45 tokens (contract comment ~30 + import ~10 + binding ~5)
- Miss: raw_tokens (passthrough, no substitution)

### Falsifiability

The benchmark has explicit directional criteria (see `RUBRIC.md`; no KILL pre-data):
- **Asymptote < 50%** → architecture fundamentally limited; would trigger replanning post-characterisation
- **Non-monotonic curve** (Slice 2) → simulation bug; not publishable

---

## 3-Slice Plan

| Slice | Scope | Status |
|-------|-------|--------|
| **Slice 1** | Foundation: transcript fixtures + simulator + f=1.0 run | **Complete** |
| **Slice 2** | Full f-sweep {0.1…1.0} + stratified sampling + per-f confidence bands | Deferred |
| **Slice 3** | Production reconciliation: compare synthetic ceiling vs B8-CURVE actual | Deferred (requires production hook) |

---

## Transcript Corpus

**N=10 tasks**, stratified across 3 tiers:

| Tier | N | Description |
|------|---|-------------|
| substrate | 4 | Numeric kernels: sort, parseInt, hash-map, string-ops |
| glue | 3 | API routing, error-mapping, config-loading |
| application | 3 | Full features: CRUD endpoint, CLI subcommand, event emitter |

Content-addressed in `transcripts/corpus-spec.json`.

---

## Running

```bash
# From repo root
pnpm bench:curve-synthetic:slice1

# Or directly
node bench/B8-synthetic/run.mjs

# With custom registry path
node bench/B8-synthetic/run.mjs --registry /path/to/yakcc.registry.sqlite
```

Emits: `tmp/B8-synthetic/slice1-<ISO-timestamp>.json`

---

## Reproducibility

The transcript corpus is committed and content-addressed. The benchmark is
fully offline (no API calls required). Given the same registry state, the
same corpus SHA-256 produces the same results.

To verify corpus integrity manually:
```bash
node -e "
const {createHash}=require('crypto'),{readFileSync}=require('fs');
const files=['bench/B8-synthetic/transcripts/substrate-001.jsonl','bench/B8-synthetic/transcripts/glue-001.jsonl','bench/B8-synthetic/transcripts/application-001.jsonl'];
console.log(createHash('sha256').update(Buffer.concat(files.map(f=>readFileSync(f)))).digest('hex'));
"
```
Expected: `40788cc0403036ea7b562eccfa1c2be73bc812ac8dffb0fbe5c8fb355a4477a3`

---

## File Layout

```
bench/B8-synthetic/
├── README.md                    # this file
├── RUBRIC.md                    # pass/directional-target bars verbatim from #192 + #167 DQ-5/6/7/9
├── transcripts/
│   ├── corpus-spec.json         # SHA-256 of the transcript set
│   ├── substrate-001.jsonl      # substrate-heavy task transcripts (4 fixtures)
│   ├── glue-001.jsonl           # glue-heavy task transcripts (3 fixtures)
│   └── application-001.jsonl    # application-layer task transcripts (3 fixtures)
├── hit-rate-simulator.mjs       # @decision DEC-BENCH-B8-SYNTHETIC-SLICE1-001
├── token-savings.mjs            # heuristic token savings estimator
└── run.mjs                      # Slice 1 orchestrator
```

Artifacts are emitted to `tmp/B8-synthetic/` (force-added to git).
