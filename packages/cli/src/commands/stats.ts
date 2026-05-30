// SPDX-License-Identifier: MIT
//
// stats.ts — handler for `yakcc stats [--since <iso-date>] [--json]`
//
// @decision DEC-CLI-STATS-SCOPE-001
// @title `yakcc stats` (WI-764) ships Tier 1 only — telemetry-only metrics
// @status superseded for Tier-2/3 by DEC-CLI-STATS-TIER-2-001 (WI-768, 2026-05-29)
// @rationale
//   Tier-2 headline metrics ("most-reused atoms", "LoC matched-to-atom") need
//   registry-hit telemetry events with atom hashes. At WI-764 time the production hook
//   (hook-intercept.ts) hard-coded every event as outcome: "passthrough" with
//   null atom hash — Phase-2 substitution was not yet wired. Additionally, the
//   registry package exposed no public "list all blocks with createdAt" API.
//   Tier 1 alone answered the operator's central question ("is the hook finding
//   hits / no-oping?") at lowest cost, zero new registry coupling, and zero
//   telemetry-schema change. Tier 2/3/4 were tracked as separate follow-up issues.
//   WI-831 (PR 2026-05-28) unblocked Tier-2 by wiring Phase-2 substitution telemetry.
//   WI-792 Slice F shipped Registry.getBlock(). Tier-2+3 now ship here (WI-768).
//   Tier-4 (registry coverage via listCatalogPage) remains deferred.
//   See DEC-CLI-STATS-TIER-2-001 in MASTER_PLAN.md for the full Tier-2/3 record.
//
// @decision DEC-CLI-STATS-COMMAND-001
// @title `yakcc stats` command shape: --since + --json, parseArgs, injected Logger
// @status accepted (WI-764); additive-forward contract exercised by Tier-2 (WI-768)
// @rationale
//   Mirrors the established telemetry.ts command pattern (DEC-CLI-TELEMETRY-COMMAND-001)
//   for consistency and testability via CollectingLogger. Additive-forward --json schema:
//   top-level keys are designed so Tier-2 fields ("atoms": {...}) can be appended without
//   breaking existing consumers. --since uses Date.parse() with the inclusive t >= sinceMs
//   semantics documented below. Non-interactive: never reads stdin.
//
// @decision DEC-CLI-STATS-READER-SEAM-001 (see @yakcc/hooks-base/telemetry.ts)
//   All telemetry reads go through readTelemetrySessions() from @yakcc/hooks-base.
//   stats.ts contains NO second JSONL reader, no JSON.parse over telemetry lines,
//   no readFileSync line-splitting — only aggregation and formatting.
//   Tier-2 aggregation (collectAtomReuse in stats-atoms.ts) is a SECOND pure reducer
//   over TelemetryEvent[] produced by that seam — no new JSONL reader introduced.
//
// @decision DEC-CLI-STATS-TIER-2-001
// @title Tier-2 atom-reuse + Tier-3 LoC-saved fold-in wired here (WI-768)
// @status accepted (2026-05-29)
// @rationale
//   collectAtomReuse() is called after aggregate() with the same totalEvents slice.
//   Registry path defaults to DEFAULT_REGISTRY_PATH; injectable via YAKCC_REGISTRY_PATH
//   for test isolation. Registry is opened at most once per invocation (I-C invariant)
//   inside collectAtomReuse. See stats-atoms.ts for the full decision record.
//
// --json schema (v1, additive-forward):
//   Top-level keys: version, generatedAt, window, summary, outcomeBreakdown,
//   perToolBreakdown, matchQuality, sessions, atoms (new in WI-768).
//   Consumers must tolerate unknown top-level keys (additive-forward contract).

import { parseArgs } from "node:util";
import {
  type TelemetryEvent,
  readTelemetrySessions,
  resolveTelemetryDir,
} from "@yakcc/hooks-base/telemetry.js";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";
import { type AtomStats, collectAtomReuse } from "./stats-atoms.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** JSON schema version — bump when the shape changes incompatibly. */
const JSON_SCHEMA_VERSION = 1;

/**
 * Known outcome values for three-way breakdown.
 * Any outcome outside this set is grouped under "other".
 * "drift-alert" events are excluded entirely (sentinel events, not real intercepts).
 */
const KNOWN_OUTCOMES = new Set([
  "registry-hit",
  "synthesis-required",
  "passthrough",
  "atomized",
  "shave-on-miss-enqueued",
  "shave-on-miss-completed",
  "shave-on-miss-error",
  "intent-too-broad",
  "result-set-too-large",
  "atom-size-too-large",
  "descent-bypass-warning",
]);

/** Cosine-distance bucket boundaries for match-quality histogram. */
const BUCKET_BOUNDARIES = [0.1, 0.2, 0.3] as const;
const BUCKET_LABELS = [
  "< 0.10 (excellent)",
  "0.10–0.20 (good)",
  "0.20–0.30 (acceptable)",
  "≥ 0.30 (borderline)",
] as const;

// ---------------------------------------------------------------------------
// Aggregation types (internal)
// ---------------------------------------------------------------------------

interface OutcomeCounts {
  "registry-hit": number;
  "synthesis-required": number;
  passthrough: number;
  other: number;
}

interface PerToolStats {
  total: number;
  hits: number;
}

interface MatchQualityStats {
  buckets: [number, number, number, number]; // excellent, good, acceptable, borderline
  scores: number[]; // raw scores for median computation
}

interface AggregatedStats {
  totalEvents: number;
  outcomeCounts: OutcomeCounts;
  perTool: Record<"Edit" | "Write" | "MultiEdit", PerToolStats>;
  matchQuality: MatchQualityStats;
  sessionCount: number;
  daysActive: Set<string>; // ISO date strings YYYY-MM-DD
  firstEventTs: number | null;
  lastEventTs: number | null;
  totalSkippedLines: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true when the event is a drift-alert sentinel.
 * Drift-alert events carry candidateCount === -1 (DEC-HOOK-ENF-LAYER5-TELEMETRY-001)
 * and must be excluded from intercept counts and per-tool tallies.
 */
function isDriftAlert(event: TelemetryEvent): boolean {
  return event.outcome === "drift-alert" || event.candidateCount === -1;
}

/** Convert a Unix-ms timestamp to a YYYY-MM-DD date string (UTC). */
function toDateKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

/** Compute the median of an array of numbers. Returns null for empty input. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }
  return sorted[mid] as number;
}

/** Format a number as a percentage string with one decimal place. */
function pct(count: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((count / total) * 100).toFixed(1)}%`;
}

/** Format a Unix-ms timestamp as a readable local date/time string. */
function fmtTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

/**
 * Assign a cosine-distance score to a bucket index (0..3).
 * Bucket boundaries: <0.10 / 0.10–0.20 / 0.20–0.30 / ≥0.30.
 */
function scoreBucket(score: number): 0 | 1 | 2 | 3 {
  if (score < BUCKET_BOUNDARIES[0]) return 0;
  if (score < BUCKET_BOUNDARIES[1]) return 1;
  if (score < BUCKET_BOUNDARIES[2]) return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate a flat list of TelemetryEvent objects into summary statistics.
 * Events are already filtered by --since before being passed here.
 * Drift-alert sentinel events are excluded from all tallies.
 */
function aggregate(
  events: readonly TelemetryEvent[],
  sessionCount: number,
  skippedLines: number,
): AggregatedStats {
  const stats: AggregatedStats = {
    totalEvents: 0,
    outcomeCounts: { "registry-hit": 0, "synthesis-required": 0, passthrough: 0, other: 0 },
    perTool: {
      Edit: { total: 0, hits: 0 },
      Write: { total: 0, hits: 0 },
      MultiEdit: { total: 0, hits: 0 },
    },
    matchQuality: { buckets: [0, 0, 0, 0], scores: [] },
    sessionCount,
    daysActive: new Set(),
    firstEventTs: null,
    lastEventTs: null,
    totalSkippedLines: skippedLines,
  };

  for (const event of events) {
    // Exclude drift-alert sentinels from all tallies.
    if (isDriftAlert(event)) continue;

    stats.totalEvents++;

    // Timestamp tracking
    if (stats.firstEventTs === null || event.t < stats.firstEventTs) stats.firstEventTs = event.t;
    if (stats.lastEventTs === null || event.t > stats.lastEventTs) stats.lastEventTs = event.t;
    stats.daysActive.add(toDateKey(event.t));

    // Outcome counts
    const outcome = event.outcome;
    if (outcome === "registry-hit") {
      stats.outcomeCounts["registry-hit"]++;
    } else if (outcome === "synthesis-required") {
      stats.outcomeCounts["synthesis-required"]++;
    } else if (outcome === "passthrough") {
      stats.outcomeCounts.passthrough++;
    } else if (KNOWN_OUTCOMES.has(outcome)) {
      // Other known outcomes (enforcement-layer, shave-on-miss-*) → "other"
      stats.outcomeCounts.other++;
    } else {
      // Unknown/future outcomes → "other" (T-10: resilient to schema additions)
      stats.outcomeCounts.other++;
    }

    // Per-tool counts
    const tool = event.toolName;
    if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
      stats.perTool[tool].total++;
      if (outcome === "registry-hit") {
        stats.perTool[tool].hits++;
      }
    }

    // Match quality: topScore (cosine distance)
    if (event.topScore !== null && event.topScore !== undefined) {
      const idx = scoreBucket(event.topScore);
      stats.matchQuality.buckets[idx]++;
      stats.matchQuality.scores.push(event.topScore);
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

/** Print the human-readable Tier-1 + Tier-2 overview table. */
function printHumanOutput(stats: AggregatedStats, atomStats: AtomStats, logger: Logger): void {
  const {
    totalEvents,
    outcomeCounts,
    perTool,
    matchQuality,
    sessionCount,
    daysActive,
    firstEventTs,
    lastEventTs,
    totalSkippedLines,
  } = stats;
  const totalOutcome = totalEvents;

  logger.log("=== yakcc stats (Tier-1 telemetry overview) ===");
  logger.log("");

  // --- Intercept summary ---
  logger.log("TOOL-CALL INTERCEPTS");
  logger.log(`  Total events:          ${totalEvents}`);
  logger.log(`  Sessions:              ${sessionCount}`);
  logger.log(`  Days active:           ${daysActive.size}`);

  if (firstEventTs !== null && lastEventTs !== null) {
    logger.log(`  First event:           ${fmtTimestamp(firstEventTs)}`);
    logger.log(`  Last event:            ${fmtTimestamp(lastEventTs)}`);
  }
  logger.log("");

  // --- Outcome breakdown ---
  logger.log("OUTCOME BREAKDOWN");
  logger.log(
    `  registry-hit:          ${outcomeCounts["registry-hit"].toString().padStart(6)}  (${pct(outcomeCounts["registry-hit"], totalOutcome)})`,
  );
  logger.log(
    `  synthesis-required:    ${outcomeCounts["synthesis-required"].toString().padStart(6)}  (${pct(outcomeCounts["synthesis-required"], totalOutcome)})`,
  );
  logger.log(
    `  passthrough:           ${outcomeCounts.passthrough.toString().padStart(6)}  (${pct(outcomeCounts.passthrough, totalOutcome)})`,
  );
  if (outcomeCounts.other > 0) {
    logger.log(
      `  other:                 ${outcomeCounts.other.toString().padStart(6)}  (${pct(outcomeCounts.other, totalOutcome)})`,
    );
  }
  logger.log("");

  // --- Per-tool breakdown ---
  logger.log("PER-TOOL BREAKDOWN");
  for (const tool of ["Edit", "Write", "MultiEdit"] as const) {
    const t = perTool[tool];
    const hitRate = t.total > 0 ? pct(t.hits, t.total) : "n/a";
    logger.log(
      `  ${tool.padEnd(12)} total: ${t.total.toString().padStart(5)}  registry-hit: ${t.hits.toString().padStart(5)}  (${hitRate})`,
    );
  }
  logger.log("");

  // --- Match quality ---
  logger.log("MATCH QUALITY (cosine distance — lower is better)");
  const scoredTotal = matchQuality.buckets.reduce((a, b) => a + b, 0);
  if (scoredTotal === 0) {
    logger.log("  No scored events yet.");
    logger.log(
      "  (topScore is null in Phase-1 passthrough events — scores appear when registry-hit events are recorded)",
    );
  } else {
    for (let i = 0; i < BUCKET_LABELS.length; i++) {
      const count = matchQuality.buckets[i] as number;
      logger.log(
        `  ${(BUCKET_LABELS[i] as string).padEnd(26)} ${count.toString().padStart(5)}  (${pct(count, scoredTotal)})`,
      );
    }
    const med = median(matchQuality.scores);
    if (med !== null) {
      logger.log(`  Median topScore: ${med.toFixed(4)}`);
    }
  }
  logger.log("");

  // --- Skipped lines ---
  if (totalSkippedLines > 0) {
    logger.log(`  (${totalSkippedLines} malformed line(s) skipped across all session files)`);
    logger.log("");
  }

  // --- Atom reuse (Tier-2 + Tier-3) ---
  logger.log("ATOM REUSE");
  if (atomStats.degraded) {
    logger.log(`  (registry unavailable: ${atomStats.degradedReason ?? "unknown"})`);
    logger.log("  Run `yakcc init` to set up the local registry.");
  } else if (atomStats.top.length === 0) {
    logger.log("  (no atom-reuse data yet)");
    logger.log("  Atom-reuse metrics appear once Phase-2 registry-hit events are recorded.");
  } else {
    const locTotal = atomStats.locSaved?.total ?? 0;
    logger.log(`  LoC saved (total):     ${locTotal.toString().padStart(6)}`);
    if (atomStats.hitRateP50 !== null) {
      logger.log(`  Hit-rate P50:          ${atomStats.hitRateP50.toString().padStart(6)}`);
    }
    if (atomStats.hitRateP90 !== null) {
      logger.log(`  Hit-rate P90:          ${atomStats.hitRateP90.toString().padStart(6)}`);
    }
    logger.log("  Top atoms by reuse:");
    for (const entry of atomStats.top.slice(0, 5)) {
      const grain = entry.level ?? "?";
      const lines = entry.lines !== null ? `${entry.lines} lines` : "?";
      logger.log(
        `    ${entry.atomHash.slice(0, 12)}…  hits: ${entry.hits.toString().padStart(4)}  grain: ${grain}  impl: ${lines}`,
      );
    }
  }
  logger.log("");

  // --- Footer ---
  logger.log("For raw telemetry: yakcc telemetry --tail 100");
}

/** Emit the machine-readable --json one-liner. Schema is additive-forward (DEC-CLI-STATS-COMMAND-001). */
function printJsonOutput(
  stats: AggregatedStats,
  atomStats: AtomStats,
  windowSinceMs: number | null,
  logger: Logger,
): void {
  const {
    totalEvents,
    outcomeCounts,
    perTool,
    matchQuality,
    sessionCount,
    daysActive,
    firstEventTs,
    lastEventTs,
    totalSkippedLines,
  } = stats;
  const scoredTotal = matchQuality.buckets.reduce((a, b) => a + b, 0);
  const med = median(matchQuality.scores);

  const output = {
    version: JSON_SCHEMA_VERSION,
    generatedAt: Date.now(),
    window: windowSinceMs !== null ? { sinceMs: windowSinceMs } : { sinceMs: null },
    summary: {
      totalEvents,
      sessionCount,
      daysActive: daysActive.size,
      firstEventMs: firstEventTs,
      lastEventMs: lastEventTs,
      skippedLines: totalSkippedLines,
    },
    outcomeBreakdown: {
      registryHit: outcomeCounts["registry-hit"],
      synthesisRequired: outcomeCounts["synthesis-required"],
      passthrough: outcomeCounts.passthrough,
      other: outcomeCounts.other,
    },
    perToolBreakdown: {
      Edit: { total: perTool.Edit.total, registryHits: perTool.Edit.hits },
      Write: { total: perTool.Write.total, registryHits: perTool.Write.hits },
      MultiEdit: { total: perTool.MultiEdit.total, registryHits: perTool.MultiEdit.hits },
    },
    matchQuality: {
      scoredEvents: scoredTotal,
      buckets: {
        excellent: matchQuality.buckets[0],
        good: matchQuality.buckets[1],
        acceptable: matchQuality.buckets[2],
        borderline: matchQuality.buckets[3],
      },
      medianTopScore: med,
    },
    sessions: Array.from(daysActive).sort(),
    // Tier-2 + Tier-3: atom-reuse block (additive — DEC-CLI-STATS-TIER-2-001).
    // Consumers must tolerate unknown top-level keys (additive-forward contract,
    // DEC-CLI-STATS-COMMAND-001).
    atoms: atomStats,
  };

  logger.log(JSON.stringify(output));
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc stats [--since <iso-date>] [--json]`.
 *
 * Reads every *.jsonl file under resolveTelemetryDir() via readTelemetrySessions()
 * from @yakcc/hooks-base (DEC-CLI-STATS-READER-SEAM-001 — single reader authority).
 * Computes Tier-1 metrics (§2.6 of the plan) and prints either a human-readable
 * table or a machine-readable JSON object.
 *
 * Empty telemetry states (dir missing / no files / zero events) → graceful
 * "no telemetry yet" message, exit 0 (AC-5 / T-1..T-3).
 *
 * --since <iso-date>: window to events with t >= Date.parse(<iso-date>).
 *   Invalid date → exit 1 with a usage hint naming ISO-8601.
 *
 * --json: emit one line of valid JSON (additive-forward top-level keys).
 *
 * NG6 non-interactive: never reads stdin.
 *
 * @param argv   - Remaining argv after `stats` has been consumed.
 * @param logger - Output sink (CollectingLogger in tests, CONSOLE_LOGGER in production).
 * @returns Process exit code (0 = success, 1 = usage or runtime error).
 */
export async function stats(argv: readonly string[], logger: Logger): Promise<number> {
  // --- Argument parsing ---
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        since: { type: "string" };
        json: { type: "boolean" };
      };
    }>
  >;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        since: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error("Usage: yakcc stats [--since <iso-date>] [--json]");
    return 1;
  }

  // --- Validate --since (T-8: invalid date → exit 1) ---
  let sinceMs: number | null = null;
  const sinceRaw = parsed.values.since;
  if (sinceRaw !== undefined) {
    const parsed_ms = Date.parse(sinceRaw);
    if (Number.isNaN(parsed_ms)) {
      logger.error(`error: --since value is not a valid date: "${sinceRaw}"`);
      logger.error(
        "  Hint: use an ISO-8601 date, e.g. --since 2025-01-01 or --since 2025-01-01T00:00:00Z",
      );
      return 1;
    }
    sinceMs = parsed_ms;
  }

  const useJson = parsed.values.json === true;

  // --- Read telemetry (single reader authority via @yakcc/hooks-base) ---
  // The path is derived exclusively from resolveTelemetryDir() — no hard-coded
  // ~/.yakcc/telemetry/ literal anywhere in this file (AC-9).
  const dir = resolveTelemetryDir();
  const sessions = readTelemetrySessions(dir);

  // --- Collect events (apply --since window) ---
  const totalEvents: TelemetryEvent[] = [];
  let totalSkippedLines = 0;

  for (const session of sessions) {
    totalSkippedLines += session.skippedLines;
    for (const event of session.events) {
      if (sinceMs !== null && event.t < sinceMs) continue;
      totalEvents.push(event);
    }
  }

  // --- Empty-state detection (T-1 / T-2 / T-3 / AC-5) ---
  const noData = totalEvents.length === 0;

  // --- Tier-2 + Tier-3 atom-reuse aggregation (DEC-CLI-STATS-TIER-2-001) ---
  // Runs unconditionally so the atoms block is always present in --json output
  // (including the zero-shaped empty-state, per the additive-forward invariant).
  // Registry path: YAKCC_REGISTRY_PATH env var overrides DEFAULT_REGISTRY_PATH
  // for test isolation; production uses DEFAULT_REGISTRY_PATH relative to cwd.
  const registryPath = process.env.YAKCC_REGISTRY_PATH ?? DEFAULT_REGISTRY_PATH;
  const atomStats = await collectAtomReuse(totalEvents, { registryPath });

  if (useJson) {
    if (noData) {
      // Zero-state --json: well-formed object with all-zero counts.
      const zeroStats = aggregate([], sessions.length, totalSkippedLines);
      printJsonOutput(zeroStats, atomStats, sinceMs, logger);
      return 0;
    }
    const aggStats = aggregate(totalEvents, sessions.length, totalSkippedLines);
    printJsonOutput(aggStats, atomStats, sinceMs, logger);
    return 0;
  }

  // Human output
  if (noData) {
    if (sessions.length === 0) {
      logger.log("No telemetry data yet.");
      logger.log("");
      logger.log(
        "Run Claude Code with the yakcc hook installed for a while, then run `yakcc stats` again.",
      );
      logger.log("To check the hook is wired: yakcc hooks claude-code install --target <project>");
      logger.log("To inspect raw telemetry: yakcc telemetry");
    } else if (sinceMs !== null) {
      logger.log(`No events found after ${new Date(sinceMs).toISOString()}.`);
      logger.log(
        "Try a wider window or run `yakcc stats` (no --since) for the full lifetime view.",
      );
    } else {
      logger.log("No telemetry events found in any session file.");
      logger.log("");
      logger.log(
        "Run Claude Code with the yakcc hook installed for a while, then run `yakcc stats` again.",
      );
      logger.log("To inspect raw telemetry: yakcc telemetry");
    }
    return 0;
  }

  const aggStats = aggregate(totalEvents, sessions.length, totalSkippedLines);
  printHumanOutput(aggStats, atomStats, logger);
  return 0;
}
