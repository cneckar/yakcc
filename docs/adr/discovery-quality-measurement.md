# DEC-V3-DISCOVERY-D5-001 — Quality measurement methodology for v3 discovery

**Status:** Accepted (D5 design phase; implementation deferred to follow-up WIs)
**Date:** 2026-05-10
**Issue:** https://github.com/cneckar/yakcc/issues/155
**Initiative:** WI-V3-DISCOVERY-SYSTEM (D5 of 6)

---

## Context

D1 (`docs/adr/discovery-multi-dim-embeddings.md`, `DEC-V3-DISCOVERY-D1-001`) established the
multi-dimensional storage schema: 5 `FLOAT[384]` columns in a `sqlite-vec` `vec0` virtual table
(`contract_embeddings`), one per SpecYak semantic axis (`embedding_behavior`,
`embedding_guarantees`, `embedding_error_conditions`, `embedding_non_functional`,
`embedding_property_tests`). D1 committed the absent-dimension rule: a missing SpecYak source
field yields a zero vector; query-time must skip zero-vector dimensions.

D2 (`docs/adr/discovery-query-language.md`, `DEC-V3-DISCOVERY-D2-001`) established the
LLM-facing query surface: `QueryIntentCard` with freeform per-dimension texts, per-dimension
`weights`, and `topK` (default 10). D2 committed the `Candidate` result type carrying
`perDimensionScores: PerDimensionScores` and `combinedScore: number` in [0, 1], the auto-accept
threshold (top-1 `combinedScore > 0.85` AND gap-to-top-2 > 0.15), and the programmatic API
(`Registry.findCandidatesByQuery`). The auto-accept gate is D2's authority; D5 only measures
calibration against it.

D3 (`docs/adr/discovery-ranking.md`, `DEC-V3-DISCOVERY-D3-001`) established the ranking
algorithm: per-dimension weighted cosine renormalized over the surviving non-null dimension set,
a 5-stage pipeline (vector KNN → structural filter → strictness filter → reserved Stage 4 →
final ranking + tiebreaker), the tiebreaker hierarchy (property-test depth → usage history →
test history → atom age → lex `BlockMerkleRoot`; ε = 0.02), and the `CandidateNearMiss` shape
(`failedAtLayer: 'structural' | 'strictness' | 'property_test' | 'min_score'`). D3 committed the
score bands (≥ 0.85 strong, 0.70–0.85 confident, 0.50–0.70 weak, < 0.50 poor).

D4 (`docs/adr/discovery-llm-interaction.md`, `DEC-V3-DISCOVERY-D4-001`) established the LLM
interaction design: single `yakcc_resolve` tool, the evidence rendering contract, the 4-band
protocol, the verbatim system-prompt text, the caller-side `ConfidenceMode` enum (default
`"hybrid"` with a 0.92 stricter auto-accept threshold), and three pinned failure-mode shapes.
D4 also named the calibration knobs D5 is responsible for measuring. The hybrid auto-accept
threshold 0.92 is D4's authority; D5 measures against it.

**D5's authority domain is HOW WE MEASURE the system works.** D5 does not reopen the scoring
formula (D3), the API surface (D2), the storage schema (D1), or the LLM interaction contract
(D4). D5's job is to define the metrics, corpus structure, evaluation harness shape, calibration
methodology, pending-gap log, CI gate semantics, and the feedback loop by which D5 measurements
drive amendments to the D3 calibration knobs.

**The 4 D3/D4 calibration knobs D5 owns measurement of:**

1. **Auto-accept threshold** (D3 §Q5 default 0.85) — D5 measures per-band Brier to determine
   if this cutoff should shift.
2. **Hybrid mode threshold** (D4 §Q5 default 0.92) — D5 measures false-accept rate on the
   synthetic-tasks corpus.
3. **Tie window ε** (D3 §Q4 default 0.02) — D5 measures median candidates per tie window.
4. **K' multiplier** (D3 §Q3 Stage 1 default `max(K × 5, 50)`) — D5 measures pipeline-stage
   drop rate to detect insufficient initial candidate pool.

The score band boundaries (0.85 / 0.70 / 0.50) are also measurable by D5 via per-band Brier
(M5) and feed the D3 amendment process described in Q7.

---

## Boundary with D1 + D2 + D3 + D4

| Domain | Authority | ADR |
|---|---|---|
| Storage schema (5 columns, model, zero-vector rule, migration 7) | D1 | `docs/adr/discovery-multi-dim-embeddings.md` |
| Query surface (QueryIntentCard, Candidate shape, CLI flags, auto-accept thresholds, cross-provider invariant) | D2 | `docs/adr/discovery-query-language.md` |
| Ranking formula, aggregation strategy, pipeline, tiebreakers, score normalization, negative-space behavior | D3 | `docs/adr/discovery-ranking.md` |
| Tool call shape, evidence rendering contract, 4-band protocol, system-prompt text, confidence calibration, failure-mode shapes | D4 | `docs/adr/discovery-llm-interaction.md` |
| Quality measurement methodology (metrics, corpus structure, harness shape, calibration, pending log, CI gate, D3 knob feedback loop) | D5 (this ADR) | `docs/adr/discovery-quality-measurement.md` |

None of D1, D2, D3, or D4 is modified by D5. If a future WI touches more than one of these
authority domains, all owning ADRs must be revised.

---

## Decision

### Q1: Metrics — 5 metrics locked for v3.0

**Decision:** Pin 5 metrics from issue #155's table, with 4 explicit modifications driven by D3's
score band semantics:

| # | Metric | Definition (locked) | Target | D3-aligned threshold |
|---|---|---|---|---|
| M1 | **Hit rate** | % of queries where top-1 `combinedScore ≥ 0.50` (the D3 "weak" band entry) | **≥ 80 %** | `combinedScore ≥ 0.50` |
| M2 | **Precision@1** | % of queries where top-1 candidate's `BlockMerkleRoot` equals `expectedAtom` | **≥ 70 %** | hash match |
| M3 | **Recall@10** | % of queries where `expectedAtom` is in top-10 candidates | **≥ 90 %** | `K = 10` (D2 default) |
| M4 | **MRR** (Mean Reciprocal Rank) | mean of 1/rank where rank is the position of `expectedAtom` in the result list, or 0 if absent | **≥ 0.7** | rank within `topK` |
| M5 | **Score calibration error** | Brier score over the {strong, confident, weak, poor} bands measuring (P(correct \| band) − band-midpoint)² | **< 0.10** | per-band Brier |

**Rationale for each metric target:**

- **M1 hit-rate threshold = D3 0.50 band entry**, not an arbitrary threshold. The "weak" band is
  the lowest band where D3 says the LLM should consider the candidate at all; below that is "poor"
  and maps to `no_match`. M1 == "did the registry surface anything the LLM would actually
  consider?"
- **M2 = hash equality on top-1 only**; not "expectedAtom in top-3." Precision@1 is the
  auto-accept reliability metric and must be exact — auto-accept fires on top-1, and the question
  is whether top-1 is the right atom.
- **M3 K = 10** matches `QueryIntentCard.topK` default (D2 §Q1). A different K would measure a
  different retrieval setting than what ships.
- **M4 MRR** uses `1/rank` (rank ∈ {1, 2, ..., topK}); rank = ∞ → reciprocal = 0. Average over
  all corpus entries. MRR captures ranking quality jointly with M2 and M3.
- **M5 Brier per band** rather than one global Brier value. D3 explicitly bands `combinedScore`
  into 4 ranges; calibration error must be reported per band so the implementer can identify which
  band is miscalibrated. The < 0.10 target applies to each individual band's squared deviation.

**M5 per-band Brier formula (explicit):**

```
For each band b ∈ {strong, confident, weak, poor}:
  N_b   = number of queries whose top-1 combinedScore falls in band b
  C_b   = number of those queries that are also "correct" (top-1 hash match or in acceptableAtoms)
  P_b   = C_b / N_b                              // observed precision in band b
  m_b   = midpoint of band b
            strong:    0.925  (midpoint of [0.85, 1.00])
            confident: 0.775  (midpoint of [0.70, 0.85])
            weak:      0.60   (midpoint of [0.50, 0.70])
            poor:      0.25   (midpoint of [0.00, 0.50])
  err_b = (P_b − m_b)²                           // squared deviation from band midpoint

M5 target: each err_b < 0.10
```

**Precision@5 (rejected for v3.0):** Precision@1 + Recall@10 + MRR jointly pin ranking quality.
Adding Precision@5 introduces an in-between metric without a distinct decision use. If D5
implementation reveals that Precision@1 and Recall@10 diverge wildly (strong top-1 but
collectively poor top-5), file a D5 amendment to add Precision@5 as a diagnostic metric.

**Above-threshold semantics (revisit hook):** If D5 implementation surfaces that the 0.50 cutoff
is too lenient (too many `combinedScore = 0.51` "hits" that are not actually correct), tune the
M1 threshold up to the "confident" band entry (0.70) via a D5 amendment. Document the change with
the M5 calibration data that motivated it.

---

### Q2: Benchmark corpus sources — lock 2 of 3 for v3.0

**Decision:** Ship sources (1) **seed-derived** + (2) **synthetic tasks** in v3.0. Defer source
(3) **captured LLM sessions** to v3.1, behind a documented named trigger.

**Canonical paths (corpus schema D5 owns; corpus data is owned by the follow-up
`WI-V3-DISCOVERY-D5-CORPUS-SEED` WI — no corpus JSON files are modified by this ADR):**

| Source | Canonical path | Owner |
|---|---|---|
| (1) Seed-derived | `packages/registry/test/discovery-benchmark/seed-derived.json` | Authored from seed-block IntentCards |
| (2) Synthetic tasks | `packages/registry/test/discovery-benchmark/synthetic-tasks.json` | Hand-authored realistic LLM coding tasks |
| (3) Captured LLM sessions | (deferred) `packages/registry/test/discovery-benchmark/captured-sessions.json` | v3.1 — requires session-capture harness |
| Pending log | `packages/registry/test/discovery-benchmark/pending.json` | Committed in-tree; lifecycle per Q5 |

**Target counts (for `WI-V3-DISCOVERY-D5-CORPUS-SEED` to meet; D5 fixes the targets, not the
authoring):**

- Seed-derived: ≥ 30 query/answer pairs. Coverage rule: at least one query per seed block under
  `packages/seeds/src/blocks/` (20 blocks today → 30 queries = ~1.5 queries per block on average;
  some blocks get 2 queries with different phrasing to test paraphrase robustness).
- Synthetic tasks: ≥ 20 hand-authored pairs. Coverage rules: ≥ 10 must populate multiple
  `QueryIntentCard` dimensions (multi-dim coverage); ≥ 5 must intentionally have no matching atom
  (negative-space coverage to verify `no_match` / `weak_only` status emission per D4 §Q3).

**Why (1) + (2) and not (3) for v3.0:**

Source (1) is automatable from the registry itself (each block has an IntentCard the corpus
authoring tool can paraphrase) and gives coverage proportional to the registry size. Source (2)
gives realistic LLM-style queries that test the system at the use-case level. Together they cover
"self-consistency" (the registry can find its own atoms) and "task-realism" (the registry responds
usefully to natural-language task descriptions). Source (3) requires a session-capture harness
that does not exist in v3.0. Issue #155 names this explicitly as deferred to v3.1.

**Trigger to add captured-sessions corpus (v3.1):**

- An MCP session-capture mechanism lands; OR
- Hit rate on synthetic-tasks corpus > 95% AND Precision@1 < 50% (suggests synthetic tasks are
  too easy and only realistic captured sessions will surface the gap).

**Schema (locked here; implementation deferred to corpus-seed WI):**

```typescript
// packages/registry/test/discovery-benchmark/types.ts
// Corpus schema — D5 fixes this verbatim; implementation in WI-V3-DISCOVERY-D5-CORPUS-SEED.

interface BenchmarkEntry {
  /** Stable identifier; must be unique within the file. */
  readonly id: string;                  // e.g. "seed-ascii-char-validate-001"

  /** Source label; must match the file name (e.g. "seed-derived"). */
  readonly source: "seed-derived" | "synthetic-tasks" | "captured-sessions";

  /** The QueryIntentCard the LLM (or harness) would issue. */
  readonly query: QueryIntentCard;      // imported from @yakcc/registry

  /**
   * The expected top-1 atom by BlockMerkleRoot.
   * `null` is a valid value for negative-space queries (no atom is correct;
   * the system is expected to emit `no_match` or `weak_only`).
   */
  readonly expectedAtom: BlockMerkleRoot | null;

  /**
   * Optional: a list of acceptable alternates for Recall@K.
   * If omitted, only `expectedAtom` counts as correct.
   * Used when multiple atoms genuinely satisfy the query (e.g. several email
   * validators differ only in implementation detail).
   */
  readonly acceptableAtoms?: readonly BlockMerkleRoot[];

  /** Free-form note describing why this entry exists. */
  readonly rationale: string;
}

interface BenchmarkFile {
  /** Schema version; bump on incompatible schema changes. */
  readonly version: 1;

  /** Source label (matches BenchmarkEntry.source for all entries). */
  readonly source: BenchmarkEntry["source"];

  /** Date the file was last edited (YYYY-MM-DD). */
  readonly lastUpdated: string;

  /** All entries in this file. */
  readonly entries: readonly BenchmarkEntry[];
}
```

**Worked example (single inline entry demonstrating the schema; full corpus data lives in
`WI-V3-DISCOVERY-D5-CORPUS-SEED`):**

```json
{
  "version": 1,
  "source": "synthetic-tasks",
  "lastUpdated": "2026-05-10",
  "entries": [
    {
      "id": "synth-clamp-001",
      "source": "synthetic-tasks",
      "query": {
        "behavior": "clamp a number between a lower bound and upper bound",
        "signature": {
          "inputs": [
            { "name": "x", "type": "number" },
            { "name": "lo", "type": "number" },
            { "name": "hi", "type": "number" }
          ],
          "outputs": [{ "type": "number" }]
        }
      },
      "expectedAtom": "TBD-corpus-seed-WI-fills-this-hash",
      "rationale": "Textbook trivial operation; tests strong+auto-accept band path"
    }
  ]
}
```

This entry demonstrates:
- A two-dimension query (behavior + signature) — exercises multi-dim weighting.
- A non-null `expectedAtom` — tests the M2/Precision@1 path.
- A deliberately simple query whose top-1 should fall in the "strong" band — validates auto-accept
  calibration (M5 `strong` band).

---

### Q3: Evaluation harness shape — vitest test colocated with registry

**Decision:** Pin the harness as a vitest test file colocated with the existing registry tests:

- **Location:** `packages/registry/src/discovery-eval.test.ts` (NOT a new package; NOT a script;
  NOT a separate `test/` directory).
- **Runner:** `vitest` — invoked via the existing `pnpm --filter @yakcc/registry test` command.
  D5 does not introduce a new test command.
- **Pattern:** one `describe("discovery quality", () => { ... })` block per source corpus
  (`seed-derived`, `synthetic-tasks`); one `it(...)` per metric (M1-M5).

**Why this location, not alternatives:**

- All existing registry tests live under `packages/registry/src/` (confirmed: `select.test.ts`,
  `search.test.ts`, `storage.test.ts`, `vector-search.test.ts`, `storage.props.test.ts`,
  `storage.benchmark.test.ts`). The convention is colocation with source. D5 follows this
  existing convention — adding a `test/` directory would create a parallel-authority directory the
  codebase does not have.
- A new `@yakcc/discovery-eval` package would create a circular-dep risk (it would import
  `@yakcc/registry` and `@yakcc/seeds` to read the corpus). D2 §Q3 already rejected creating a
  new `@yakcc/discovery` package on the same circular-dep grounds (cite `DEC-VECTOR-RETRIEVAL-004`
  from `packages/registry/src/index.ts`). D5 follows the same precedent.
- A standalone script under `packages/registry/scripts/` would skip vitest's reporting,
  parallelism, and CI integration. D5 needs a real test for the CI gate (Q6 below).

**Helper module:** `packages/registry/src/discovery-eval-helpers.ts`. This module contains pure
functions for metric computation — `discovery-eval.test.ts` reads the corpus, runs queries via
`Registry.findCandidatesByQuery`, calls helpers. Helpers are unit-tested in
`packages/registry/src/discovery-eval-helpers.test.ts`.

**Harness structure (semantic sketch; exact code is implementation WI work in
`WI-V3-DISCOVERY-D5-HARNESS`):**

```typescript
// packages/registry/src/discovery-eval.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { Registry } from "./index.js";
import {
  loadBenchmarkCorpus,
  computeHitRate, computePrecisionAt1, computeRecallAtK, computeMRR,
  computeBrierPerBand
} from "./discovery-eval-helpers.js";

let registry: Registry;
beforeAll(async () => {
  registry = await openTestRegistry({ withSeedBlocks: true });
});

describe("discovery quality (seed-derived corpus)", () => {
  const corpus = loadBenchmarkCorpus("seed-derived");

  it("M1 hit rate >= 0.80 (top-1 combinedScore >= 0.50)", () => {
    const rate = computeHitRate(registry, corpus);
    expect(rate).toBeGreaterThanOrEqual(0.80);
  });

  it("M2 precision@1 >= 0.70 (top-1 hash matches expectedAtom)", () => {
    const rate = computePrecisionAt1(registry, corpus);
    expect(rate).toBeGreaterThanOrEqual(0.70);
  });

  it("M3 recall@10 >= 0.90 (expectedAtom in top-10)", () => {
    const rate = computeRecallAtK(registry, corpus, 10);
    expect(rate).toBeGreaterThanOrEqual(0.90);
  });

  it("M4 MRR >= 0.70", () => {
    const mrr = computeMRR(registry, corpus);
    expect(mrr).toBeGreaterThanOrEqual(0.70);
  });

  it("M5 score calibration error < 0.10 per band", () => {
    const errors = computeBrierPerBand(registry, corpus);
    expect(errors.strong).toBeLessThan(0.10);
    expect(errors.confident).toBeLessThan(0.10);
    expect(errors.weak).toBeLessThan(0.10);
    expect(errors.poor).toBeLessThan(0.10);
  });
});

describe("discovery quality (synthetic-tasks corpus)", () => { /* same 5 its */ });
```

**Implementation WI:** `WI-V3-DISCOVERY-D5-HARNESS` (separate from corpus-seed WI; harness can
ship with a tiny inline-stubbed corpus first, then corpus-seed fills the real entries).

---

### Q4: Score calibration measurement — per-band Brier + reliability diagram

**Decision:** Calibration is measured per D3 band using two complementary artifacts:
(a) a numeric per-band Brier component fed back into M5, AND (b) a JSON reliability-diagram
artifact written to `tmp/discovery-eval/` when the harness runs in `--report` mode.

**"Correct" definition for calibration:** A query result is "correct" iff the top-1 candidate's
`BlockMerkleRoot` equals `expectedAtom` (or is in `acceptableAtoms`). This matches M2
(Precision@1) — calibration measures "when the score said 0.85, was the top-1 actually correct?",
which is the same correctness predicate.

**Per-band Brier component formula:**

```
For each band b ∈ {strong, confident, weak, poor}:
  N_b   = number of queries whose top-1 combinedScore falls in band b
  C_b   = number of those queries that are also "correct" (top-1 hash match or in acceptableAtoms)
  P_b   = C_b / N_b                              // observed precision in band b
  m_b   = midpoint of band b
            strong:    0.925  (midpoint of [0.85, 1.00])
            confident: 0.775  (midpoint of [0.70, 0.85])
            weak:      0.60   (midpoint of [0.50, 0.70])
            poor:      0.25   (midpoint of [0.00, 0.50])
  err_b = (P_b − m_b)²                           // squared deviation from band midpoint
```

**Empty-band handling:** If `N_b = 0` for any band on a given corpus, that band contributes 0 to
the calibration error and is reported as "no data." The harness MUST log a warning so corpus
authors know to add coverage for that band. A corpus with no candidates in the "poor" band cannot
validate the `no_match` path — the warning is actionable.

**Reliability-diagram artifact** (written when harness runs with `DISCOVERY_EVAL_REPORT=1`):

- Location: `tmp/discovery-eval/reliability-{source}.json`
- This file is `.gitignored` (it is a runtime artifact for human inspection, not committed corpus
  data).
- Format:
  ```json
  {
    "corpus": "seed-derived",
    "head_sha": "<git head>",
    "generated_at": "2026-05-10T...",
    "bands": {
      "strong":    { "N": 18, "correct": 16, "P": 0.889, "midpoint": 0.925, "brier": 0.00130 },
      "confident": { "N": 24, "correct": 18, "P": 0.750, "midpoint": 0.775, "brier": 0.00063 },
      "weak":      { "N":  9, "correct":  4, "P": 0.444, "midpoint": 0.600, "brier": 0.02426 },
      "poor":      { "N":  3, "correct":  0, "P": 0.000, "midpoint": 0.250, "brier": 0.06250 }
    }
  }
  ```

**Tuning loop with D3:** When calibration shows `P_b > m_b` consistently (scores under-predict
correctness), D3's band boundaries should shift down (more candidates classified as "strong" /
auto-accepted). When `P_b < m_b` (scores over-predict correctness), band boundaries should shift
up (fewer auto-accepts). The mechanism for this loop is the Q7 amendment process.

**Why per-band, not a single global Brier:** D3 explicitly bands the score; miscalibration in the
"strong" band has different operational consequences (false auto-accept) than miscalibration in
the "weak" band (user shown a false candidate). Reporting them together would hide which band is
broken.

---

### Q5: `discovery-pending.json` — location, schema, and lifecycle

**Decision:** Pin the file as a **committed in-tree corpus file** (NOT `tmp/`-local, NOT
`.gitignored`). Location: `packages/registry/test/discovery-benchmark/pending.json`.

**Why committed in-tree, not `tmp/`-local:**

- `pending.json` is the negative-space registry coverage gap log — it is the list of queries the
  registry should support but does not. Losing it on every cleanup defeats the purpose.
- Committed in-tree means PRs that change discovery behavior can show diffs in `pending.json`
  (queries that newly hit, queries that newly miss). This is the PR-diff visibility mechanism.
- Mirrors the existing pattern in `closer-parity.test.ts` / `pending-atoms.json` (referenced in
  issue #155 as the architectural inspiration). The same precedent governs the committed-in-tree
  decision here.
- The `tmp/` directory is per-session working state; `pending.json` is durable cross-session state
  that must survive reboots, branch switches, and contributor handoffs.

**Schema (locked):**

```typescript
// packages/registry/test/discovery-benchmark/pending.json follows BenchmarkFile envelope.
// Entries describe failed queries; PendingEntry is the entry type.

interface PendingEntry {
  /** Stable identifier (e.g. "pending-haversine-001"). */
  readonly id: string;

  /** The QueryIntentCard that did not produce a satisfactory result. */
  readonly query: QueryIntentCard;

  /**
   * The top-K candidates the system DID return, with their scores and
   * the bands they fell in. Captured at the time the entry was added.
   */
  readonly returnedCandidates: readonly {
    readonly blockMerkleRoot: BlockMerkleRoot;
    readonly combinedScore: number;
    readonly band: "strong" | "confident" | "weak" | "poor";
    readonly perDimensionScores?: PerDimensionScores;
  }[];

  /**
   * The CandidateNearMiss array (D3 §Q6) at the time of capture; explains
   * why no candidate passed all filter stages.
   */
  readonly nearMisses: readonly {
    readonly blockMerkleRoot: BlockMerkleRoot;
    readonly failedAtLayer: "structural" | "strictness" | "property_test" | "min_score";
    readonly failureReason: string;
  }[];

  /**
   * Why this entry was added (registry gap? scoring miscalibration?
   * IntentCard-side richness gap?). One-line human note.
   */
  readonly diagnosis: string;

  /**
   * The action that would close this entry (D6 migration? new atom?
   * D1 dimension addition? IntentCard enrichment?). One-line.
   */
  readonly proposedAction: string;

  /** Date added (YYYY-MM-DD). */
  readonly addedAt: string;

  /**
   * If the entry was retired (the gap was closed), the SHA + date when
   * the closing change landed. `null` while still pending.
   */
  readonly retiredAt: string | null;
  readonly retiredBy: string | null;     // commit SHA or PR number
}
```

**Lifecycle (locked):**

1. **Add** — When the harness runs and a query in any corpus produces a below-threshold result
   that was not expected (i.e. `expectedAtom !== null` AND status === `"no_match"`), and the gap
   is judged real (not a corpus error), the corpus author adds a `PendingEntry` to `pending.json`.
   Mechanism: manual, by corpus-seed WI authors and ongoing contributors.

2. **Retire** — When a future change (new atom, dimension addition, scoring tweak) makes the
   previously-pending query produce a satisfactory result, the harness's `--retire-resolved` mode
   finds entries whose query now passes M1 + M2 and proposes retirement (sets `retiredAt`,
   `retiredBy`). **Retired entries are KEPT in the file** — do NOT delete them. The entry's
   existence plus the `retiredAt` SHA is the audit trail showing when and why the gap was closed.

3. **Audit** — `pending.json` diff in PRs surfaces both new pending entries (regressions: a query
   that previously hit now misses) and newly retired entries (improvements). The CI gate (Q6)
   keys off these diffs.

**Implementation note:** Retirement-detection logic ships in
`packages/registry/src/discovery-eval-helpers.ts` (same module as the metric helpers, owned by
`WI-V3-DISCOVERY-D5-HARNESS`).

---

### Q6: Continuous evaluation in CI — dual-gate (regression + threshold)

**Decision:** CI runs `pnpm --filter @yakcc/registry test discovery-eval` on every PR. The gate
fires under **either** condition:

1. **Regression gate** — A query that previously hit now misses. Specifically: the diff of
   `pending.json` shows a new `PendingEntry` whose `id` was not present on the base branch.
   (New retirements are fine; new pendings are not.)

2. **Absolute-threshold gate** — Any of M1–M5 falls below its target on any corpus. The vitest
   `expect(...).toBeGreaterThanOrEqual(target)` calls in the harness produce a non-zero exit,
   which fails the CI step.

Both gates must be green. Either failure blocks merge.

**Threshold-gate failure UX:** When an `expect()` fails, the test output must show:

- The metric name (e.g. "M2 precision@1")
- The corpus (e.g. "synthetic-tasks")
- The observed value vs. target (e.g. "observed 0.62, target >= 0.70")
- Top-3 queries that contributed most to the gap (the queries with the worst per-query metric
  contribution; aids debugging without requiring a separate report run)

**Regression-gate UX:** The CI step prints the new `pending.json` entries with their `diagnosis`
field, so the PR author sees exactly what regressed.

**CI wiring location (intent only — NOT modified by D5):** The actual CI job lives under
`.github/workflows/` which is on D5's FORBIDDEN scope list. D5's ADR specifies the intent —
"discovery-eval runs on every PR; both gates must be green" — and names the follow-up WI
`WI-V3-DISCOVERY-D5-CI-GATE` that owns the actual workflow YAML edit. Architecture preservation:
`.github/**` is the CI wiring authority; D5 publishes the contract, the CI WI conforms to it.

**Why split the CI wiring out:** D5 owns the methodology + the harness shape + the gate
semantics. The `.github/workflows/` edit is mechanical (add a step, set the threshold, trigger
on PR) and belongs to whoever is touching CI wiring. D5 cannot mandate the exact CI YAML
structure without entering the CI authority's domain, which would create dual authority over CI
configuration.

---

### Q7: D3 calibration knob feedback loop — the D5 → D3 amendment process

**Decision:** Document explicitly the mechanism by which D5 measurements become D3 ADR
amendments. This is a process commitment, not a code change.

**The D3/D4 calibration knobs D5 owns measurement of:**

| D3/D4 knob | Location | Default | D5 measurement that drives revision |
|---|---|---|---|
| Auto-accept threshold | D3 §Q5 (strong band entry) | 0.85 | M5 calibration: `P_strong > 0.95` → tighten to 0.90; `P_strong < 0.80` → loosen to 0.80 |
| Hybrid mode threshold | D4 §Q5 (`ConfidenceMode: "hybrid"`) | 0.92 | False-accept rate on synthetic-tasks corpus > 5% → raise to 0.95 |
| Tie window ε | D3 §Q4 | 0.02 | Median tie-window size: > 5 candidates per tie → tighten to 0.01; < 0.5 candidates per tie → loosen to 0.05 |
| K' multiplier | D3 §Q3 Stage 1 | `max(K × 5, 50)` | Pipeline-stage drop-rate: Stage 2/3 reduces survivors to < `topK` in > 20% of queries → raise multiplier |
| Score band boundaries | D3 §Q5 | 0.85 / 0.70 / 0.50 | Per-band Brier from M5 — any band whose `err_b > 0.10` requires boundary shift |

**Cross-authority note:** D2 owns the auto-accept gate (top-1 `combinedScore > 0.85` AND gap >
0.15) even though D3 sets the 0.85 threshold. A D3 threshold amendment must be coordinated with
D2. D4 owns the hybrid mode threshold (0.92) even though D3 documents the score band that gate
sits in. A D4 hybrid threshold amendment must coordinate with D4, not merely D3.

**The 5-step amendment process (locked):**

1. **D5 measurement reveals miscalibration** — either a CI run, a manual `--report` run, or a
   quarterly review of `pending.json` trends surfaces a knob that is out of calibration.

2. **The D5 evaluator files a D3-revision WI** (e.g. `WI-V3-DISCOVERY-D3-REVISION-001`)
   referencing:
   - the specific D3 knob being tuned;
   - the M5 measurement that justifies the change;
   - the proposed new value;
   - the `head_sha` the measurement was taken at.

3. **Planner adjudicates** — confirms the measurement is well-formed, confirms the D3 knob
   revision does not conflict with D2 (auto-accept gate is owned by D2 even if the threshold is
   set by D3) or D4 (hybrid mode threshold is owned by D4 even though D3 documents it).

4. **Implementation WI lands** — updates the D3 ADR (NOT a new ADR; same `DEC-V3-DISCOVERY-D3-001`
   row gets an amendment paragraph with the measurement + new value), updates the runtime code,
   re-runs the harness to confirm the new value is calibrated.

5. **Audit trail** — the D3 ADR amendment paragraph cites the M5 measurement it was derived from,
   and `pending.json` retirements show the before/after queries that motivated the change.

**Why this matters:** Without an explicit process, the D3–D5 dependency becomes folklore ("D3
said tune from D5 data, but nobody knows how"). The process pinned here makes the calibration loop
reproducible and auditable.

**Process-failure trigger:** If D5 measurements happen quarterly but D3 amendments lag by > 6
months, the process is broken; file a meta-WI to redesign the loop (e.g. automated CI-driven
amendment proposals).

---

## Worked measurement examples

These examples illustrate D5's measurement methodology end-to-end: how M1–M5 are computed, how
calibration data maps to D3 knob recommendations, and how `pending.json` entries are generated.

### Example 1: Strong-band calibration — M5 measurement drives a D3 knob recommendation

**Scenario:** After `WI-V3-DISCOVERY-D5-CORPUS-SEED` authors a 50-entry corpus (30 seed-derived +
20 synthetic), the harness runs in `--report` mode against the seed-derived corpus.

**Observed calibration data (reliability diagram for seed-derived):**

```json
{
  "corpus": "seed-derived",
  "head_sha": "a264af5",
  "generated_at": "2026-05-10T14:30:00Z",
  "bands": {
    "strong":    { "N": 20, "correct": 20, "P": 1.000, "midpoint": 0.925, "brier": 0.00563 },
    "confident": { "N":  6, "correct":  4, "P": 0.667, "midpoint": 0.775, "brier": 0.01172 },
    "weak":      { "N":  4, "correct":  1, "P": 0.250, "midpoint": 0.600, "brier": 0.12250 },
    "poor":      { "N":  0, "correct":  0, "P": null,  "midpoint": 0.250, "brier": null }
  }
}
```

**M5 result:**
- `err_strong = (1.000 − 0.925)² = 0.00563` → passes (< 0.10)
- `err_confident = (0.667 − 0.775)² = 0.01166` → passes (< 0.10)
- `err_weak = (0.250 − 0.600)² = 0.12250` → **FAILS** (≥ 0.10)
- `err_poor`: empty band → 0, warning logged: "poor band has N=0; add negative-space entries"

**CI outcome:** M5 fails on the seed-derived corpus. The harness reports:
```
FAIL  M5 score calibration error < 0.10 per band (seed-derived corpus)
  Expected err_weak < 0.10, observed 0.12250
  weak-band queries with highest calibration error:
    1. "seed-ascii-char-validate-001": P_top1=0.23 (expected 0.60); near-miss at structural
    2. "seed-email-validate-002": P_top1=0.31 (expected 0.60); near-miss at min_score
    3. "seed-url-parse-001": P_top1=0.19 (expected 0.60); near-miss at strictness
```

**Resulting action (Q7 step 2):** The D5 evaluator files `WI-V3-DISCOVERY-D3-REVISION-001`:
"weak-band Brier 0.12 > 0.10 at head a264af5; the weak band (0.50–0.70) over-predicts correctness.
Propose shifting the weak-band lower boundary from 0.50 to 0.55."

---

### Example 2: Precision@1 failure + pending.json entry generation

**Scenario:** Synthetic-tasks corpus query for a negative-space entry (no correct atom exists).

**`BenchmarkEntry`:**

```json
{
  "id": "synth-haversine-negative-001",
  "source": "synthetic-tasks",
  "query": {
    "behavior": "compute Haversine distance between two GPS coordinates with sub-meter precision",
    "guarantees": ["result accurate to sub-meter precision", "handles antimeridian crossing"],
    "signature": {
      "inputs": [
        { "name": "lat1", "type": "number" }, { "name": "lon1", "type": "number" },
        { "name": "lat2", "type": "number" }, { "name": "lon2", "type": "number" }
      ],
      "outputs": [{ "name": "distanceMeters", "type": "number" }]
    }
  },
  "expectedAtom": null,
  "rationale": "Negative-space: no atom satisfies sub-meter + flat-signature; validates no_match path"
}
```

**Harness evaluation:**
- M1 (hit rate): `combinedScore` of top-1 = 0.44 (< 0.50) → **miss** for M1 (expected, since
  `expectedAtom = null` means no correct atom)
- M2 (precision@1): `expectedAtom = null` → skip M2 for this entry (negative-space entries
  contribute to M1 and M3 only)
- `QueryResult.status = "no_match"` — confirmed correct

**No `pending.json` entry generated:** The query produced `no_match` as expected for a
negative-space entry. Pending entries are only generated when an unexpectedly-failing query (one
where `expectedAtom !== null`) returns `no_match`.

**Contrast — unexpected failure generating a `pending.json` entry:**

If the atom exists but the registry fails to surface it (e.g. due to structural filter
misconfiguration), the harness adds:

```json
{
  "id": "pending-haversine-missing-001",
  "query": { "behavior": "compute Haversine distance..." },
  "returnedCandidates": [
    {
      "blockMerkleRoot": "f1d4b2e9a5c80736",
      "combinedScore": 0.79,
      "band": "confident"
    }
  ],
  "nearMisses": [
    {
      "blockMerkleRoot": "f1d4b2e9a5c80736",
      "failedAtLayer": "structural",
      "failureReason": "expected inputs: [number×4]; stored signature: [{lat, lon}×2]"
    }
  ],
  "diagnosis": "Structural filter rejected closest match due to flat-vs-object signature mismatch",
  "proposedAction": "Normalize signature representation in IntentCard or add an alternate atom with flat signature",
  "addedAt": "2026-05-10",
  "retiredAt": null,
  "retiredBy": null
}
```

---

## Alternatives considered

| Alternative | Status | Rejection rationale |
|---|---|---|
| Precision@5 as v3.0 metric | Rejected (Q1) | Precision@1 + Recall@10 + MRR jointly pin ranking quality without Precision@5. Adding it introduces an in-between metric without a distinct decision use case. Revisit trigger: if Precision@1 and Recall@10 diverge wildly in implementation data, add as a diagnostic metric via D5 amendment. |
| Corpus authoring inside D5 (option (a) — all-in-one) | Rejected in favor of option (b) — split to `WI-V3-DISCOVERY-D5-CORPUS-SEED` | Risk profile separation: D5's design ADR is docs-only; authoring ≥30 seed-derived + ≥20 synthetic pairs requires per-atom verification against the 20 currently-shipping seed blocks, which is implementation-time work. D1, D2, D3, D4 all named follow-up implementation WIs. Landability: D5's ADR can ship today as a pure design artifact; corpus seed becomes its own validated slice. Schema-without-data is the correct shape for a methodology ADR. |
| `tmp/`-local pending.json (not committed in-tree) | Rejected (Q5) | Durability: `tmp/` is per-session working state. Losing `pending.json` on cleanup defeats the gap-tracking purpose. No PR-diff visibility. No cross-contributor handoff. The `closer-parity.test.ts` / `pending-atoms.json` precedent already established the committed-in-tree pattern for negative-space gap tracking. |
| New `@yakcc/discovery-eval` package for the harness | Rejected (Q3) | Creates circular-dep risk (`@yakcc/discovery-eval` → `@yakcc/registry` + `@yakcc/seeds`). Cite `DEC-VECTOR-RETRIEVAL-004`: D2 already rejected a new `@yakcc/discovery` package on the same grounds. All existing registry tests are colocated in `packages/registry/src/`. D5 follows the same convention. |
| D5 owning `.github/workflows/` edits directly | Rejected (Q6) | Architecture preservation: `D5` commits the CI gate *contract*; `.github/**` is the CI wiring authority. A single ADR owning both the methodology and the wiring would create dual authority over CI configuration. The CI wiring belongs to `WI-V3-DISCOVERY-D5-CI-GATE`. |
| Global single Brier vs per-band Brier (M5) | Rejected (Q1/Q4) | A single global Brier value would hide which band is broken. Miscalibration in the "strong" band has different operational consequences (false auto-accept) than miscalibration in the "weak" band (user shown a false candidate). D3 explicitly bands the score; D5 must report calibration at the same granularity. |
| Captured LLM sessions corpus in v3.0 | Deferred to v3.1 (Q2) | Requires a session-capture harness that does not exist in v3.0. Issue #155 names this explicitly as deferred. Named triggers: MCP session-capture mechanism lands; OR hit-rate > 95% AND precision@1 < 50% (synthetic tasks too easy). |

---

## When to revisit

| Trigger | Action |
|---|---|
| M1 0.50 cutoff produces too many false hits (e.g. > 20% of "hits" have `expectedAtom` not in top-10) | Tune M1 threshold up to 0.70 (confident band entry) via D5 amendment; cite the calibration data |
| Synthetic-tasks hit-rate > 95% AND Precision@1 < 50% | Add captured-sessions corpus per Q2 named trigger; file `WI-V3-DISCOVERY-D5-CORPUS-SEED-V2` |
| Any per-band Brier err_b > 0.10 | File D3-revision WI per Q7 amendment process |
| `pending.json` grows monotonically without retirements over 2 quarters | Corpus or methodology problem; review whether the corpus entries are valid and whether D3's structural filter is over-rejecting |
| Evaluation-process lag > 6 months between measurement and D3 amendment | File meta-WI to redesign Q7 loop (e.g. automated CI-driven amendment proposals) |

---

## Implementation phase boundary

D5 commits the design only. No source files are modified by this ADR. The
`packages/registry/test/discovery-benchmark/` directory does not exist yet; it will be created
by the corpus-seed WI, not by D5.

**Follow-up WIs (all deferred; D5 ADR is their shared specification):**

1. **`WI-V3-DISCOVERY-D5-CORPUS-SEED`** — Owns the ≥ 30 seed-derived + ≥ 20 synthetic JSON
   entries under `packages/registry/test/discovery-benchmark/`. The `BenchmarkEntry`/`BenchmarkFile`
   schema is locked here; the corpus data is authored there. Also commits the initial `pending.json`
   with `retiredAt: null` entries for known gaps at corpus-seed time.

2. **`WI-V3-DISCOVERY-D5-HARNESS`** — Owns `packages/registry/src/discovery-eval.test.ts` +
   `packages/registry/src/discovery-eval-helpers.ts` (+ helpers' own `.test.ts`). Can ship with
   a tiny inline-stubbed corpus first (the `synth-clamp-001` example from Q2 above), then
   `WI-V3-DISCOVERY-D5-CORPUS-SEED` fills the real entries. The retirement-detection
   (`--retire-resolved`) logic is part of this WI's scope.

3. **`WI-V3-DISCOVERY-D5-CI-GATE`** — Owns `.github/workflows/` wiring. Depends on
   `WI-V3-DISCOVERY-D5-HARNESS` (the harness must exist for the CI step to call). Does NOT
   depend on corpus-seed being complete (CI gate can run against a stub corpus and still exercise
   the gate mechanism).

**Ordering note:** HARNESS can ship before CORPUS-SEED (stub corpus → real corpus). CI-GATE
depends on HARNESS. CORPUS-SEED can ship before or after HARNESS, but CI-GATE + HARNESS must both
be in place before the dual-gate semantics are enforced in PRs.

---

## References

- Issue #155 (D5 — V3-DISCOVERY-D5, this work item)
- Issue #154 (D4 — V3-DISCOVERY-D4)
- Issue #153 (D3 — V3-DISCOVERY-D3)
- Issue #152 (D2 — V3-DISCOVERY-D2)
- Issue #151 (D1 — V3-DISCOVERY-D1)
- Issue #150 (parent initiative — WI-V3-DISCOVERY-SYSTEM)
- `DEC-V3-DISCOVERY-D5-001` (`MASTER_PLAN.md`) — This decision log entry
- `DEC-V3-DISCOVERY-D4-001` (`MASTER_PLAN.md`) — LLM interaction design (D4), `docs/adr/discovery-llm-interaction.md`
- `DEC-V3-DISCOVERY-D3-001` (`MASTER_PLAN.md`) — Ranking + scoring algorithm (D3), `docs/adr/discovery-ranking.md`
- `DEC-V3-DISCOVERY-D2-001` (`MASTER_PLAN.md`) — Query language / API surface (D2), `docs/adr/discovery-query-language.md`
- `DEC-V3-DISCOVERY-D1-001` (`MASTER_PLAN.md`) — Multi-dimensional embedding schema (D1), `docs/adr/discovery-multi-dim-embeddings.md`
- `DEC-VECTOR-RETRIEVAL-004` (`packages/registry/src/index.ts`) — `IntentQuery` is a local structural type (circular-dep avoidance; harness location rationale Q3)
- `DEC-EMBED-010` (`MASTER_PLAN.md`) — Local embeddings via `transformers.js`, provider interface (cross-provider invariant from D2)
- `DEC-CI-OFFLINE-001` (`MASTER_PLAN.md`) — Single canonical offline-embedding-provider authority
- `DEC-VERIFY-010` (`VERIFICATION.md`) — L1+ behavioral embedding via sandbox execution (Stage 4 trigger from D3; future calibration domain)
- `packages/seeds/src/blocks/*` — Seed-derived corpus source (20 blocks today; seed-derived corpus target ≥ 30 queries across these)
- `packages/registry/src/index.ts` — Registry interface, `findCandidatesByQuery` target API (lines 254–464)
- `closer-parity.test.ts` + `pending-atoms.json` — Architectural precedent for committed in-tree pending file (Q5 rationale)
