# ADR: Hook Enforcement Architecture — 6-Layer Defense-in-Depth

**ID:** DEC-HOOK-ENF-ARCHITECTURE-001
**Status:** ACCEPTED
**Date:** 2026-05-15
**Author:** wi-594-s6-closer implementer
**Closes:** #579
**Related:** #578 (Layer 0 prompt), #590 (S2), #591 (S3), #592 (S4), #593 (S5), #594 (S6)

---

## Context

The yakcc value proposition rests on a single behavioral primitive: when an LLM
needs a generic operation, it must descend to the most specific intent,
discover (or compose) the corresponding atom, and substitute. Loose intents
collapse this primitive — they return oversized atoms, pollute the registry,
short-circuit the descent loop, and invalidate every downstream benchmark
(B1/B4/B5/B9/B10).

PR #583 (#578) shipped the prompt-level defense: an imperative
descent-and-compose discipline in `docs/system-prompts/yakcc-discovery.md`.
Prompts alone are insufficient. LLMs ignore prompts when convenient; without
mechanical enforcement, the next regression silently degrades the system back
to lazy lookups and the bench numbers measure noise.

#579 specified a six-layer mechanical defense. Each layer is independently
testable and independently failable; together they form a defense-in-depth net
that no single failure mode can fully bypass. Layer 6 is the regression gate
that proves Layers 1-5 still enforce.

**Why six and not one monolithic check:** a single monolithic enforcement is a
single point of failure. Six independent gates with overlapping coverage mean
a regression in one (heuristic drift, threshold miscalibration, telemetry
silence) is caught by at least one of the others before it ships.

---

## Decision

Implement six enforcement layers in `packages/hooks-base`, each owning a distinct
defense dimension, all wired through `EnforcementConfig` (DEC-HOOK-ENF-CONFIG-001)
as the sole authority for every tunable threshold.

The layers are:

- **Layer 0** — Prompt imperative (shipped in #578)
- **Layer 1** — Intent-specificity gate (shipped in S1)
- **Layer 2** — Result-set size enforcement (shipped in S2)
- **Layer 3** — Atom-size ratio gate at substitution (shipped in S3)
- **Layer 4** — Descent-depth tracker, advisory (shipped in S4)
- **Layer 5** — Telemetry-driven rolling drift detection (shipped in S5)
- **Layer 6** — Eval corpus + CI gate (shipped in S1 skeleton, closed in S6)

---

## Layer Summaries and Decision IDs

### Layer 0 — Prompt Imperative

**File:** `docs/system-prompts/yakcc-discovery.md`
**Issue:** #578 / PR #583
**Character:** preventive; LLM instruction.

Layer 0 is not in `packages/hooks-base` — it is the system-prompt text that
instructs the LLM to follow the descent-and-compose discipline before any
mechanical enforcement can fire. It is Layer 0 because it is the first line of
defense (cheapest to enforce, zero latency) but the weakest (LLMs can ignore
prompts). Layers 1-5 are the mechanical backstop when Layer 0 is violated.

### Layer 1 — Intent-Specificity Gate

**File:** `packages/hooks-base/src/intent-specificity.ts`
**Config:** `EnforcementConfig.layer1` (DEC-HOOK-ENF-CONFIG-001)
**Character:** blocking; runs before any registry query.

Layer 1 inspects the raw intent string and rejects vague intents before a
registry query is even issued. Rejection is immediate and synchronous.

Relevant decision IDs:
- **DEC-HOOK-ENF-LAYER1-INTENT-SPECIFICITY-001** — Layer 1 design: intent string
  scored before registry query; rejection is blocking with no fallback.
- **DEC-HOOK-ENF-LAYER1-SINGLE-WORD-001** — Single-word intents are rejected
  immediately (no further scoring needed).
- **DEC-HOOK-ENF-LAYER1-MIN-WORDS-001** — Minimum word count (default 4) enforced
  as the first length check; intents shorter than minWords are always too broad.
- **DEC-HOOK-ENF-LAYER1-MAX-WORDS-001** — Maximum word count (default 20) prevents
  overly verbose intents that obscure specificity.
- **DEC-HOOK-ENF-LAYER1-STOP-WORDS-001** — Canonical stop-words list (things, stuff,
  utility, helper, manager, handler, service, system, processor, worker) signal
  generic intent framing.
- **DEC-HOOK-ENF-LAYER1-META-WORDS-001** — Canonical meta-words list (various,
  general, common, some, any, several, misc, generic) signal catch-all intent
  framing.
- **DEC-HOOK-ENF-LAYER1-ACTION-VERBS-001** — An accept requires at least one
  recognized action verb or a predicate-prefix pattern (is/has/can prefix).
- **DEC-HOOK-ENF-LAYER1-PREDICATE-PREFIX-001** — isX/hasX/canX prefixed identifiers
  are treated as implicit action verbs (isEmail, hasPrefix, canEncode).
- **DEC-HOOK-ENF-LAYER1-IO-HINT-001** — Intents with explicit I/O specifics
  (type pairs, format names, protocol tokens) score higher specificity.
- **DEC-HOOK-ENF-LAYER1-ESCAPE-HATCH-001** — YAKCC_HOOK_DISABLE_INTENT_GATE=1
  bypasses Layer 1 entirely for bench/test environments.
- **DEC-HOOK-ENF-LAYER1-CONSTANTS-RETROFIT-001** — S2 retrofitted all Layer 1
  constants into enforcement-config.ts so they are config-driven; no layer module
  hardcodes a threshold.
- **DEC-HOOK-ENF-LAYER1-TELEMETRY-001** — Layer 1 result is captured as a
  telemetry event (outcome + specificity score) for Layer 5 aggregation.

### Layer 2 — Result-Set Size Enforcement

**File:** `packages/hooks-base/src/result-set-size.ts`
**Config:** `EnforcementConfig.layer2` (DEC-HOOK-ENF-CONFIG-001)
**Character:** blocking; runs after registry query, before substitution.

Layer 2 inspects the candidate list returned by the registry and rejects when
there are too many high-confidence matches (indicating an overly broad query) or
too many candidates overall.

Relevant decision IDs:
- **DEC-HOOK-ENF-LAYER2-RESULT-SET-SIZE-001** — Layer 2 design: candidate list
  inspected post-query; blocking when confidenceCount > maxConfident or total > maxOverall.
- **DEC-HOOK-ENF-LAYER2-SCORE-FORMULA-001** — combinedScore = 1 - (cosineDistance^2 / 4);
  candidates with combinedScore >= confidentThreshold (default 0.70) counted as confident.
- **DEC-HOOK-ENF-LAYER2-TELEMETRY-001** — Layer 2 result (candidateCount, confidentCount)
  captured for Layer 5 aggregation.

Env overrides: `YAKCC_RESULT_SET_MAX` (maxConfident), `YAKCC_RESULT_SET_MAX_OVERALL`
(maxOverall), `YAKCC_RESULT_CONFIDENT_THRESHOLD` (confidentThreshold).

### Layer 3 — Atom-Size Ratio Gate

**File:** `packages/hooks-base/src/atom-size-ratio.ts`
**Config:** `EnforcementConfig.layer3` (DEC-HOOK-ENF-CONFIG-001)
**Character:** blocking; runs at substitution time.

Layer 3 computes the ratio of atomComplexity to needComplexity. If the ratio
exceeds ratioThreshold (default 10), the atom is considered oversized for the
call site and substitution is rejected. Atoms below minFloor (default 20
complexity points) skip the ratio check entirely to avoid false positives on
micro-atoms.

The "10x" ratio default is taken directly from the #579 issue body specification.

Relevant decision IDs:
- **DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001** — Layer 3 design: ratio check at
  substitution time; blocking when ratio > ratioThreshold and atomComplexity >= minFloor.
- **DEC-HOOK-ENF-LAYER3-RATIO-THRESHOLD-001** — ratioThreshold default 10 matches
  the #579 issue body "10x" specification.
- **DEC-HOOK-ENF-LAYER3-MIN-FLOOR-001** — minFloor default 20 prevents false
  positives on micro-atoms (a 3-line function has atomComplexity ≈ 3).
- **DEC-HOOK-ENF-LAYER3-TELEMETRY-001** — Layer 3 result (atomComplexity, ratio)
  captured for Layer 5 aggregation.

Env override: `YAKCC_ATOM_OVERSIZED_RATIO` (ratioThreshold), `YAKCC_HOOK_DISABLE_ATOM_SIZE_GATE=1`.

### Layer 4 — Descent-Depth Tracker

**File:** `packages/hooks-base/src/descent-tracker.ts`
**Config:** `EnforcementConfig.layer4` (DEC-HOOK-ENF-CONFIG-001)
**Character:** advisory; non-blocking. Warning attached to SubstitutionResult.

Layer 4 tracks how many times a (packageName, bindingName) pair has been
missed by the import-intercept hook before a registry hit. When a substitution
is attempted with fewer than minDepth (default 2) prior misses, and the binding
does not match any shallowAllowPattern, a DescentBypassWarning is attached to
the SubstitutionResult. The substitution still proceeds — Layer 4 is advisory
only, providing metadata for the caller and for Layer 5 aggregation.

Relevant decision IDs:
- **DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001** — Layer 4 design: advisory-only
  descent depth tracker; warning metadata attached, substitution not blocked.
- **DEC-HOOK-ENF-LAYER4-MIN-DEPTH-001** — minDepth default 2 requires at least
  2 prior import-intercept misses before substitution is considered "warmed up".
  Calibration-pending on B4/B9 sweep data.
- **DEC-HOOK-ENF-LAYER4-SHALLOW-ALLOW-001** — shallowAllowPatterns bootstrap with
  arithmetic primitives (add, sub, mul, div, mod, abs, min, max, clamp, lerp);
  these are always safe to substitute at depth 0.
- **DEC-HOOK-ENF-LAYER4-TELEMETRY-001** — Bypass warning outcome captured for
  Layer 5 aggregation.

Env override: `YAKCC_DESCENT_MIN_DEPTH` (minDepth), `YAKCC_HOOK_DISABLE_DESCENT_TRACKING=1`.

### Layer 5 — Drift Detection

**File:** `packages/hooks-base/src/drift-detector.ts`
**Config:** `EnforcementConfig.layer5` (DEC-HOOK-ENF-CONFIG-001)
**Character:** advisory at event time; drift alert is a telemetry emission.

Layer 5 wraps the telemetry path non-invasively and maintains a per-session
in-memory rolling window of the last N events. When aggregated metrics across
the window cross any configured threshold, a "drift_alert" event is emitted.
The window covers four dimensions:

1. **Specificity floor** — mean Layer 1 score below floor (default 0.55) indicates
   the LLM is drifting toward vague intents.
2. **Descent bypass rate** — fraction of events that were descent-bypass warnings
   above max (default 0.40) indicates the LLM is skipping the descent discipline.
3. **Result-set median max** — median candidateCount above max (default 5) indicates
   queries are persistently too broad.
4. **Ratio median max** — median atom/need ratio above max (default 4) indicates
   the LLM is over-substituting large atoms for simple call sites.

Relevant decision IDs:
- **DEC-HOOK-ENF-LAYER5-DRIFT-DETECTION-001** — Layer 5 design: rolling-window
  aggregation of L1-L4 signals across four threshold dimensions.
- **DEC-HOOK-ENF-LAYER5-WINDOW-001** — rollingWindow default 20; large enough to
  smooth single-event noise, reactive enough for session-level drift.
- **DEC-HOOK-ENF-LAYER5-SPECIFICITY-FLOOR-001** — specificityFloor default 0.55;
  calibrated to the midpoint of accept-zone specificity scores from L1 corpus.
- **DEC-HOOK-ENF-LAYER5-DESCENT-MAX-001** — descentBypassMax default 0.40; above
  40% bypass rate the LLM is systematically skipping the descent discipline.
- **DEC-HOOK-ENF-LAYER5-RESULT-MAX-001** — resultSetMedianMax default 5; above
  median 5 candidates the query patterns are persistently too broad.
- **DEC-HOOK-ENF-LAYER5-RATIO-MAX-001** — ratioMedianMax default 4; above median
  ratio 4 the LLM is consistently choosing atoms larger than the call site needs.
- **DEC-HOOK-ENF-LAYER5-TELEMETRY-001** — Drift alert emitted as a telemetry event
  additively; existing telemetry callers are not affected.

Env overrides: `YAKCC_DRIFT_ROLLING_WINDOW`, `YAKCC_DRIFT_SPECIFICITY_FLOOR`,
`YAKCC_DRIFT_DESCENT_BYPASS_MAX`, `YAKCC_DRIFT_RESULT_SET_MEDIAN_MAX`,
`YAKCC_DRIFT_RATIO_MEDIAN_MAX`, `YAKCC_HOOK_DISABLE_DRIFT_DETECTION=1`.

### Layer 6 — Eval Corpus and CI Gate

**Files:** `packages/hooks-base/test/enforcement-eval-corpus.json`,
`packages/hooks-base/test/enforcement-eval-corpus.test.ts`
**Character:** regression gate; CI enforcement.

Layer 6 is a CI-enforced eval corpus that proves Layers 1-5 still enforce after
any change. The corpus is a JSON table of (intent, inputs, expectedOutcome) rows
exercised against the live enforcement layer functions. No mocks — the corpus
tests call the real production functions.

Decision IDs:
- **DEC-HOOK-ENF-LAYER6-EVAL-CORPUS-001** — Layer 6 design: table-driven corpus
  exercises live enforcement layers; no carve-outs to skip individual layers.

Corpus growth schedule:
- S1: 7 L1 rows
- S2: +5 L2 rows (total 12)
- S3: +5 L3 rows (total 17)
- S4: +3 L4 rows (total 20)
- S5: +3 L5 rows (total 23)
- S6 (closer): +27 rows to reach 50 total (10 per layer × 5 layers)

---

## Configuration Authority

**DEC-HOOK-ENF-CONFIG-001** — Central enforcement config module is the sole
authority for all layer thresholds. No layer module may hardcode a threshold.
All layer modules import from `enforcement-config.ts` only.

Config sources (highest precedence first):
1. `setConfigOverride()` (test hook)
2. Env vars (see per-layer listings above)
3. `.yakcc/enforcement.json` config file (optional)
4. `getDefaults()` (built-in defaults)

Env override summary table:

| Env Var | Layer | Config Field |
|---|---|---|
| YAKCC_HOOK_DISABLE_INTENT_GATE=1 | 1 | layer1.disableGate |
| YAKCC_L1_MIN_WORDS | 1 | layer1.minWords |
| YAKCC_L1_MAX_WORDS | 1 | layer1.maxWords |
| YAKCC_RESULT_SET_MAX | 2 | layer2.maxConfident |
| YAKCC_RESULT_SET_MAX_OVERALL | 2 | layer2.maxOverall |
| YAKCC_RESULT_CONFIDENT_THRESHOLD | 2 | layer2.confidentThreshold |
| YAKCC_ATOM_OVERSIZED_RATIO | 3 | layer3.ratioThreshold |
| YAKCC_HOOK_DISABLE_ATOM_SIZE_GATE=1 | 3 | layer3.disableGate |
| YAKCC_DESCENT_MIN_DEPTH | 4 | layer4.minDepth |
| YAKCC_HOOK_DISABLE_DESCENT_TRACKING=1 | 4 | layer4.disableTracking |
| YAKCC_DRIFT_ROLLING_WINDOW | 5 | layer5.rollingWindow |
| YAKCC_DRIFT_SPECIFICITY_FLOOR | 5 | layer5.specificityFloor |
| YAKCC_DRIFT_DESCENT_BYPASS_MAX | 5 | layer5.descentBypassMax |
| YAKCC_DRIFT_RESULT_SET_MEDIAN_MAX | 5 | layer5.resultSetMedianMax |
| YAKCC_DRIFT_RATIO_MEDIAN_MAX | 5 | layer5.ratioMedianMax |
| YAKCC_HOOK_DISABLE_DRIFT_DETECTION=1 | 5 | layer5.disableDetection |

---

## Envelope Types

**DEC-HOOK-ENF-ENVELOPES-001** — All layer result shapes are discriminated unions
with `layer: number` and `status: string` discriminants. This ensures callers
can always determine which layer produced a result and what the verdict was.

---

## Consequences

**Accepted tradeoffs:**

1. **Config-driven thresholds are tunable but not self-calibrating.** Default
   values are based on corpus analysis and issue-body specifications. Calibration
   to real registry data requires a separate bench-run workflow (B4/B9).

2. **Layer 4 is advisory-only.** A substitution proceeds even with a descent-bypass
   warning. The advisory is meaningful only if callers log it or if Layer 5
   aggregation escalates a pattern of bypasses into a drift alert.

3. **Layer 5 is session-scoped, in-memory.** Drift detection does not persist
   across process restarts. A single cold-start substitution never triggers drift
   detection. The rolling window requires enough events to fill before any
   dimension's aggregation is statistically meaningful.

4. **No retroactive correction.** Layer 5 reports drift; it does not rewrite the
   registry or correct past substitutions. Follow-up remediation is a caller
   responsibility.

5. **Bench numbers deferred.** Post-#579 bench baselines (B1/B4/B5/B9/B10) are
   placeholder JSON files. Full bench runs are heavy compute and are deferred to
   a separate bench-run workflow per #594 acceptance.

**Benefits realized:**

- Every layer is independently tested; a regression in one layer appears in CI
  before merge, isolated to that layer's corpus rows and unit tests.
- Config-driven thresholds mean threshold tuning does not require code changes —
  env vars or a `.yakcc/enforcement.json` file is sufficient.
- The six-layer architecture ensures that a single layer failure (heuristic drift,
  threshold miscalibration, telemetry silence) does not produce an undetected
  regression. Multiple independent dimensions must simultaneously fail.

---

## Files Involved

| Layer | Source File | Test File |
|---|---|---|
| 0 | docs/system-prompts/yakcc-discovery.md | (prompt; no unit test) |
| 1 | packages/hooks-base/src/intent-specificity.ts | test/intent-specificity-integration.test.ts |
| 2 | packages/hooks-base/src/result-set-size.ts | test/result-set-size-integration.test.ts |
| 3 | packages/hooks-base/src/atom-size-ratio.ts | test/atom-size-ratio-integration.test.ts |
| 4 | packages/hooks-base/src/descent-tracker.ts | test/descent-tracker-integration.test.ts |
| 5 | packages/hooks-base/src/drift-detector.ts | test/drift-detector-integration.test.ts |
| 6 | test/enforcement-eval-corpus.json | test/enforcement-eval-corpus.test.ts |
| config | packages/hooks-base/src/enforcement-config.ts | src/enforcement-config.test.ts |
| types | packages/hooks-base/src/enforcement-types.ts | (shared envelopes) |
| e2e | — | test/enforcement-e2e.test.ts |

---

## Plan Cross-References

- `plans/wi-579-hook-enforcement-architecture.md` — parent plan (S1-S6 spec)
- `plans/wi-579-s6-closer.md` — S6 closer plan (this ADR + corpus + bench)
- `docs/enforcement-config.md` — enforcement-config.ts user guide
- `docs/adr/hook-layer-architecture.md` — hook layer architecture ADR (broader context)
