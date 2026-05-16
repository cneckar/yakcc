# WI-579-S5: Layer 5 — Telemetry-Driven Drift Detection

**Issue:** #593 | **Slice:** S5 of 6 | **Status:** complete (wi-593-s5-layer5)

## Problem

Layers 1–4 enforce per-event gates: each individual hook call either passes or
fails a threshold. But per-event enforcement cannot detect **session-level drift**
— systematic degradation of LLM query quality over a rolling window of events.

For example, an LLM may pass every individual L1 specificity check marginally
(score = 0.56 each time, just above the 0.55 floor) while the *mean* over 20
events drifts below 0.55, indicating a consistent low-quality intent pattern that
per-event enforcement cannot surface.

There was no mechanism to aggregate and signal this cross-event drift.

## Decision

Layer 5 is a **non-invasive, non-blocking** observability layer. It wraps
`captureTelemetry` in `telemetry.ts` to maintain a per-session in-memory rolling
window of the last N events and compute four aggregate drift metrics. When any
metric crosses its configured threshold, an additive `"drift-alert"` telemetry
event is emitted. The original event is never modified or delayed.

The rolling window is **never persisted**. It lives in process memory only and is
discarded when the process exits. Multiple concurrent sessions (e.g. multiple IDE
windows) each maintain their own independent ring buffer.

## §5.6 Spec Compliance

| Parameter | Default | Config key | Env var |
|-----------|---------|-----------|---------|
| `rollingWindow` | 20 | `layer5.rollingWindow` | `YAKCC_DRIFT_ROLLING_WINDOW` |
| `specificityFloor` | 0.55 | `layer5.specificityFloor` | `YAKCC_DRIFT_SPECIFICITY_FLOOR` |
| `descentBypassMax` | 0.40 | `layer5.descentBypassMax` | `YAKCC_DRIFT_DESCENT_BYPASS_MAX` |
| `resultSetMedianMax` | 5 | `layer5.resultSetMedianMax` | `YAKCC_DRIFT_RESULT_SET_MEDIAN_MAX` |
| `ratioMedianMax` | 4 | `layer5.ratioMedianMax` | `YAKCC_DRIFT_RATIO_MEDIAN_MAX` |
| `disableDetection` | false | `layer5.disableDetection` | `YAKCC_HOOK_DISABLE_DRIFT_DETECTION=1` |

All thresholds are read from `getEnforcementConfig().layer5` at call time per
DEC-HOOK-ENF-CONFIG-001. Nothing is hardcoded in `drift-detector.ts`.

## Architecture

**EventRing:** A circular buffer of capacity `rollingWindow` storing compact
`EventSnapshot` records (outcome, candidateCount, specificityScore?, atomRatio?).
`append()` is O(1); `toArray()` is O(N). Bounded memory at allocation time.

**Per-session isolation:** All state is keyed by `sessionId` in a module-level
`Map<string, EventRing>`. Multiple concurrent sessions are independent.

**Four threshold dimensions (canonical check order):**

1. `specificity_floor` — mean L1 specificity score below `specificityFloor`
2. `descent_bypass_rate` — fraction of `descent-bypass-warning` events above `descentBypassMax`
3. `result_set_median` — median `candidateCount` above `resultSetMedianMax`
4. `ratio_median` — median atom/need ratio above `ratioMedianMax`

All triggered dimensions are reported; the first is the primary `driftMetric`
discriminant on the `DriftAlertEnvelope`.

**Non-invasive wrap contract:**
- Primary telemetry event is written first (before drift detection runs).
- Drift detection errors are caught and swallowed — never propagated to callers.
- The `"drift-alert"` outcome is emitted as a second event (additive only).
- `captureTelemetry` callers are never blocked by drift detection work.

**Performance:** `record()` is O(1). `checkDrift()` is O(N) where N ≤ 20.
Measured p99 < 1ms per `captureTelemetry` call (100-call suite < 100ms total).

## Key Decisions

| ID | Title |
|----|-------|
| DEC-HOOK-ENF-LAYER5-DRIFT-DETECTION-001 | Rolling-window aggregation of L1–L4 signals; circular buffer; per-session in-memory; non-invasive wrap |
| DEC-HOOK-ENF-LAYER5-WINDOW-001 | rollingWindow default 20 — last 20 events is the analysis unit |
| DEC-HOOK-ENF-LAYER5-SPECIFICITY-FLOOR-001 | specificityFloor default 0.55 — midpoint of accept-zone L1 corpus scores |
| DEC-HOOK-ENF-LAYER5-DESCENT-MAX-001 | descentBypassMax default 0.40 — above 40% is systematic bypass |
| DEC-HOOK-ENF-LAYER5-RESULT-MAX-001 | resultSetMedianMax default 5 — above median 5 is persistently over-broad |
| DEC-HOOK-ENF-LAYER5-RATIO-MAX-001 | ratioMedianMax default 4 — above median 4 is systematic over-substitution |
| DEC-HOOK-ENF-LAYER5-TELEMETRY-001 | "drift-alert" additive outcome — candidateCount=-1 sentinel; intentHash encodes metric+sessionId[:8] |

## Files Changed

| File | Role |
|------|------|
| `src/drift-detector.ts` | Layer 5 module — `EventSnapshot`, `EventRing`, `recordTelemetryEvent`, `checkDrift`, `getDriftMetrics`, `resetDriftSession` |
| `src/enforcement-config.ts` | `Layer5Config` interface + `layer5` defaults + env var overrides + file config support |
| `src/enforcement-types.ts` | `DriftMetric`, `DriftWindowMetrics`, `DriftAcceptEnvelope`, `DriftAlertEnvelope`, `DriftResult` (additive) |
| `src/telemetry.ts` | Layer 5 wrap in `captureTelemetry`; `"drift-alert"` outcome (additive) |
| `src/drift-detector.test.ts` | Unit tests — 8 describe blocks, 30+ cases covering all dimensions, rollover, config injection, suggestion text |
| `test/drift-detector-integration.test.ts` | Integration tests — IT-L5-A/B/C flows + PERF assertion (100 calls < 100ms) |
| `test/enforcement-eval-corpus.json` | +3 L5-* rows (20 → 23 total) |
| `test/enforcement-eval-corpus.test.ts` | L5 helper + structural invariants + eval gate (S5 additive, wi-593-s5-layer5) |

## Rollback

`git revert` the commit that introduces `drift-detector.ts` + the `captureTelemetry`
wrap in `telemetry.ts`. The baseline behaviour is restored: `captureTelemetry`
writes exactly one event per call, no rolling window is maintained, no drift-alert
events are emitted. S1–S4 behaviour is unaffected.
