// SPDX-License-Identifier: MIT
//
// @decision DEC-HOOK-ENF-LAYER5-DRIFT-DETECTION-001
// title: Layer 5 drift detector — rolling-window aggregation of L1–L4 signals
// status: decided (wi-593-s5-layer5)
// rationale:
//   Layer 5 wraps captureTelemetry non-invasively. It maintains a per-session
//   in-memory circular buffer (EventRing) of the last N telemetry events, where N
//   is configurable via enforcement-config.ts layer5.rollingWindow (default 20).
//
//   On each new event, the detector:
//     1. Appends the event to the session's ring buffer (O(1) amortized).
//     2. Computes derived metrics over the current window.
//     3. If any threshold is crossed and disableDetection is false, returns a
//        DriftAlertEnvelope which the captureTelemetry wrapper uses to emit an
//        additional "drift-alert" telemetry event.
//
//   The rolling window is NEVER persisted. It lives only in process memory and
//   is discarded when the process exits. resetSession() clears a specific session
//   for test isolation.
//
//   Per-session isolation: all state is keyed by sessionId (string). Multiple
//   concurrent sessions (e.g. multiple Claude Code windows) each maintain their
//   own independent buffer without interference.
//
//   Five threshold dimensions (all read from Layer5Config — NEVER hardcoded):
//     1. specificityFloor   — mean L1 score < floor → specificity_floor alert
//     2. descentBypassMax   — bypass-warning fraction > max → descent_bypass_rate alert
//     3. resultSetMedianMax — median candidateCount > max → result_set_median alert
//     4. ratioMedianMax     — median atom ratio > max → ratio_median alert
//
//   Check order is canonical (1→2→3→4). All triggered dimensions are reported;
//   the first is the primary driftMetric discriminant.
//
//   Performance contract: record() is O(1) amortized (circular buffer overwrite).
//   getDriftMetrics() is O(N) where N = rollingWindow (typically 20). The p99
//   overhead target is < 1ms per captureTelemetry call per the acceptance criteria.
//
//   Cross-reference:
//     enforcement-config.ts (Layer5Config)
//     enforcement-types.ts  (DriftResult, DriftMetric, DriftWindowMetrics)
//     telemetry.ts          (wraps captureTelemetry; calls recordTelemetryEvent + checkDrift)
//     plans/wi-579-s5-layer5-drift-detection.md §5.6

import type { Layer5Config } from "./enforcement-config.js";
import type {
  DriftAcceptEnvelope,
  DriftAlertEnvelope,
  DriftMetric,
  DriftResult,
  DriftWindowMetrics,
} from "./enforcement-types.js";

// ---------------------------------------------------------------------------
// EventSnapshot — the per-event record stored in the ring buffer
// ---------------------------------------------------------------------------

/**
 * A compact snapshot of one telemetry event, holding only the fields that
 * Layer 5 needs for its metric computations. Full TelemetryEvent is NOT stored
 * to keep the ring buffer lean.
 *
 * @internal
 */
export interface EventSnapshot {
  /** Outcome of the telemetry event. Drives descentBypassRate computation. */
  readonly outcome: string;
  /**
   * L1 specificity score for this event (present when outcome was produced by
   * the intent-specificity gate). Absent (undefined) for all other outcomes.
   */
  readonly specificityScore?: number;
  /**
   * Number of candidates returned by the registry query for this event.
   * Used for medianResultSetSize computation.
   */
  readonly candidateCount: number;
  /**
   * Atom/need complexity ratio at substitution time (Layer 3 events).
   * Absent (undefined) when no substitution ratio is available.
   */
  readonly atomRatio?: number;
}

// ---------------------------------------------------------------------------
// EventRing — O(1) amortized circular buffer
// ---------------------------------------------------------------------------

/**
 * Circular buffer storing the last `capacity` EventSnapshots.
 *
 * @decision DEC-HOOK-ENF-LAYER5-DRIFT-DETECTION-001
 * Circular buffer chosen over a plain array + shift() because:
 *   - append() is O(1): write head advances mod capacity.
 *   - toArray() is O(capacity): one pass regardless of order.
 *   - Memory footprint is bounded at allocation time.
 *
 * @internal
 */
class EventRing {
  private readonly buf: (EventSnapshot | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array<EventSnapshot | undefined>(capacity).fill(undefined);
  }

  /** Append one snapshot, overwriting the oldest entry when full. O(1). */
  append(snap: EventSnapshot): void {
    this.buf[this.head] = snap;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Number of valid entries currently in the ring (0..capacity). */
  size(): number {
    return this.count;
  }

  /**
   * Return all valid entries in insertion order (oldest first).
   * O(count) — safe to call on every captureTelemetry invocation since
   * capacity is bounded by rollingWindow (default 20).
   */
  toArray(): readonly EventSnapshot[] {
    if (this.count === 0) return [];
    const result: EventSnapshot[] = [];
    // Start from the oldest entry: (head - count + capacity) % capacity.
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const snap = this.buf[(start + i) % this.capacity];
      if (snap !== undefined) result.push(snap);
    }
    return result;
  }

  /** Reset to empty state (used by resetSession). */
  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

/** Map from sessionId → EventRing. In-memory; never persisted. */
const _sessionRings = new Map<string, EventRing>();

/**
 * Get or create the EventRing for a session.
 * When the session already has a ring with a different capacity (e.g. config
 * changed mid-session in tests), the existing ring is reused — capacity is
 * set at creation time per session.
 *
 * @internal
 */
function getOrCreateRing(sessionId: string, capacity: number): EventRing {
  let ring = _sessionRings.get(sessionId);
  if (ring === undefined) {
    ring = new EventRing(capacity);
    _sessionRings.set(sessionId, ring);
  }
  return ring;
}

// ---------------------------------------------------------------------------
// Public API — record + check
// ---------------------------------------------------------------------------

/**
 * Record a telemetry event in the session's rolling window.
 *
 * Called by the captureTelemetry wrapper in telemetry.ts immediately before
 * (or after) the original captureTelemetry call. Does NOT block the caller.
 *
 * @param sessionId     - The resolved session ID (from resolveSessionId()).
 * @param snap          - Compact snapshot of the event being captured.
 * @param rollingWindow - Window capacity from Layer5Config (determines ring size).
 *
 * @decision DEC-HOOK-ENF-LAYER5-DRIFT-DETECTION-001
 */
export function recordTelemetryEvent(
  sessionId: string,
  snap: EventSnapshot,
  rollingWindow: number,
): void {
  const ring = getOrCreateRing(sessionId, rollingWindow);
  ring.append(snap);
}

// ---------------------------------------------------------------------------
// Metric computation helpers
// ---------------------------------------------------------------------------

/**
 * Compute the arithmetic mean of an array of numbers.
 * Returns NaN for empty arrays (caller must guard before comparing to threshold).
 *
 * @internal
 */
function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Compute the median of an array of numbers.
 * Returns NaN for empty arrays.
 * Sorts a copy — does not mutate the input.
 *
 * @internal
 */
function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    // mid is always a valid index here (length >= 1).
    return sorted[mid] as number;
  }
  // Even length: average of the two middle elements (both always present).
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Compute DriftWindowMetrics from a snapshot array and Layer5Config.
 *
 * All five metrics are computed in a single O(N) pass over the snapshots.
 * The triggeredDimensions list is populated in canonical check order:
 *   1. specificity_floor
 *   2. descent_bypass_rate
 *   3. result_set_median
 *   4. ratio_median
 *
 * @internal
 */
function computeMetrics(
  snapshots: readonly EventSnapshot[],
  cfg: Layer5Config,
): DriftWindowMetrics {
  const windowSize = snapshots.length;

  // Accumulators
  const specificityScores: number[] = [];
  let descentBypassCount = 0;
  const resultSetSizes: number[] = [];
  const atomRatios: number[] = [];

  for (const snap of snapshots) {
    if (snap.specificityScore !== undefined) {
      specificityScores.push(snap.specificityScore);
    }
    if (snap.outcome === "descent-bypass-warning") {
      descentBypassCount++;
    }
    resultSetSizes.push(snap.candidateCount);
    if (snap.atomRatio !== undefined) {
      atomRatios.push(snap.atomRatio);
    }
  }

  const meanSpecificityScore = mean(specificityScores);
  const descentBypassRate = windowSize > 0 ? descentBypassCount / windowSize : 0;
  const medianResultSetSize = median(resultSetSizes);
  const medianAtomRatio = median(atomRatios);

  // Check thresholds in canonical order
  const triggeredDimensions: DriftMetric[] = [];

  if (!Number.isNaN(meanSpecificityScore) && meanSpecificityScore < cfg.specificityFloor) {
    triggeredDimensions.push("specificity_floor");
  }
  if (descentBypassRate > cfg.descentBypassMax) {
    triggeredDimensions.push("descent_bypass_rate");
  }
  if (!Number.isNaN(medianResultSetSize) && medianResultSetSize > cfg.resultSetMedianMax) {
    triggeredDimensions.push("result_set_median");
  }
  if (!Number.isNaN(medianAtomRatio) && medianAtomRatio > cfg.ratioMedianMax) {
    triggeredDimensions.push("ratio_median");
  }

  return {
    windowSize,
    meanSpecificityScore,
    descentBypassRate,
    medianResultSetSize,
    medianAtomRatio,
    triggeredDimensions,
  };
}

// ---------------------------------------------------------------------------
// Public API — checkDrift
// ---------------------------------------------------------------------------

/**
 * Check the current rolling window for drift and return a DriftResult.
 *
 * Returns DriftAcceptEnvelope when all metrics are within thresholds.
 * Returns DriftAlertEnvelope when one or more thresholds are crossed.
 *
 * When disableDetection is true, always returns DriftAcceptEnvelope regardless
 * of metric values (detection is disabled globally via config or env var).
 *
 * @param sessionId - The resolved session ID.
 * @param cfg       - The active Layer5Config (from getEnforcementConfig().layer5).
 *
 * @decision DEC-HOOK-ENF-LAYER5-DRIFT-DETECTION-001
 */
export function checkDrift(sessionId: string, cfg: Layer5Config): DriftResult {
  if (cfg.disableDetection) {
    const emptyMetrics: DriftWindowMetrics = {
      windowSize: 0,
      meanSpecificityScore: Number.NaN,
      descentBypassRate: 0,
      medianResultSetSize: Number.NaN,
      medianAtomRatio: Number.NaN,
      triggeredDimensions: [],
    };
    const accept: DriftAcceptEnvelope = { layer: 5, status: "ok", metrics: emptyMetrics };
    return accept;
  }

  const ring = _sessionRings.get(sessionId);
  const snapshots = ring !== undefined ? ring.toArray() : [];
  const metrics = computeMetrics(snapshots, cfg);

  if (metrics.triggeredDimensions.length === 0) {
    const accept: DriftAcceptEnvelope = { layer: 5, status: "ok", metrics };
    return accept;
  }

  // Build suggestion text from the primary triggered dimension.
  // triggeredDimensions is non-empty here (length > 0 checked above).
  const primary = metrics.triggeredDimensions[0] as DriftMetric;
  const suggestion = buildSuggestion(primary, metrics, cfg);

  const alert: DriftAlertEnvelope = {
    layer: 5,
    status: "drift_alert",
    driftMetric: primary,
    metrics,
    suggestion,
  };
  return alert;
}

/**
 * Build a human-readable suggestion string for the primary triggered dimension.
 *
 * @internal
 */
function buildSuggestion(
  primary: DriftMetric,
  metrics: DriftWindowMetrics,
  cfg: Layer5Config,
): string {
  const w = metrics.windowSize;
  switch (primary) {
    case "specificity_floor":
      return (
        `Layer 5 drift alert: mean specificity score ${metrics.meanSpecificityScore.toFixed(3)} ` +
        `is below floor ${cfg.specificityFloor} over a ${w}-event window. ` +
        `The LLM is producing consistently vague intents. ` +
        `Follow the descent-and-compose discipline to produce more specific queries.`
      );
    case "descent_bypass_rate":
      return (
        `Layer 5 drift alert: descent-bypass-warning rate ${(metrics.descentBypassRate * 100).toFixed(1)}% ` +
        `exceeds max ${(cfg.descentBypassMax * 100).toFixed(1)}% over a ${w}-event window. ` +
        `The LLM is skipping the required descent path before substitution. ` +
        `Record enough import-intercept misses before calling substitute.`
      );
    case "result_set_median":
      return (
        `Layer 5 drift alert: median result-set size ${metrics.medianResultSetSize} ` +
        `exceeds max ${cfg.resultSetMedianMax} over a ${w}-event window. ` +
        `Registry queries are persistently too broad. ` +
        `Decompose or narrow the intent before querying.`
      );
    case "ratio_median":
      return (
        `Layer 5 drift alert: median atom/need ratio ${metrics.medianAtomRatio.toFixed(2)} ` +
        `exceeds max ${cfg.ratioMedianMax} over a ${w}-event window. ` +
        `The LLM is consistently over-substituting large atoms for small call sites. ` +
        `Prefer atoms whose complexity is closer to the call-site need.`
      );
  }
}

// ---------------------------------------------------------------------------
// Public API — getDriftMetrics (for tests and telemetry export)
// ---------------------------------------------------------------------------

/**
 * Return the current DriftWindowMetrics for a session without performing a
 * threshold check. Useful for tests and offline analysis.
 *
 * @param sessionId - The resolved session ID.
 * @param cfg       - The active Layer5Config.
 */
export function getDriftMetrics(sessionId: string, cfg: Layer5Config): DriftWindowMetrics {
  const ring = _sessionRings.get(sessionId);
  const snapshots = ring !== undefined ? ring.toArray() : [];
  return computeMetrics(snapshots, cfg);
}

// ---------------------------------------------------------------------------
// Public API — resetSession (for tests)
// ---------------------------------------------------------------------------

/**
 * Clear the rolling window for a specific session.
 *
 * Used by tests to reset per-session state between test cases.
 * The captureTelemetry wrapper NEVER calls this — the window is per-process-
 * session and persists until process exit.
 *
 * @param sessionId - The session to reset. Pass undefined to reset ALL sessions.
 */
export function resetDriftSession(sessionId?: string): void {
  if (sessionId === undefined) {
    _sessionRings.clear();
    return;
  }
  const ring = _sessionRings.get(sessionId);
  if (ring !== undefined) {
    ring.clear();
  }
}
