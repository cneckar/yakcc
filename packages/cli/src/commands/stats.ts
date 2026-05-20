// SPDX-License-Identifier: MIT
//
// stats.ts — handler for `yakcc stats [subcommand] [flags]`
//
// @decision DEC-CLI-STATS-COMMAND-001
// title: `yakcc stats` surfaces hit rate, atom inventory, and LoC-saved deltas
// status: accepted (WI-764)
// rationale:
//   Alpha testers need a coherent story about whether yakcc is working. Raw telemetry
//   JSONL is unreadable without custom jq pipelines. This command reads all session
//   jsonls under ~/.yakcc/telemetry/ (or YAKCC_TELEMETRY_DIR), optionally joins
//   against <cwd>/.yakcc/registry.sqlite for Tier-2 registry metrics, and presents
//   a human-readable overview. --json emits a structured object for piping. Zero
//   network I/O; pure local reads (B6 air-gap compliance).
//
//   Tier-1 (telemetry-only): intercept count, outcome breakdown, per-tool rates,
//   cosine-distance buckets, session count + days active.
//   Tier-2 (telemetry × registry): atom inventory, bootstrap/user split, recently
//   added, LoC matched-to-atom estimate (hit-count × median atom LoC).
//   Tier-3 (counterfactual per-hit): deferred — requires Phase-2 substitution or
//   extended telemetry schema (WI-HOOK-PHASE-2-SUBSTITUTION).
//   Tier-4 (cost/token deltas): out of scope, blocked on B4 statistical significance.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveTelemetryDir } from "@yakcc/hooks-base/telemetry.js";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

// ---------------------------------------------------------------------------
// TelemetryEvent subset (Tier-1 parsing only — no import from hooks-base to
// avoid pulling in the full hook stack at CLI read time)
// ---------------------------------------------------------------------------

interface ParsedEvent {
  readonly t: number;
  readonly toolName: "Edit" | "Write" | "MultiEdit" | string;
  readonly outcome: string;
  readonly candidateCount: number;
  readonly topScore: number | null;
  readonly substituted: boolean;
  readonly substitutedAtomHash: string | null;
  readonly atomsCreated?: readonly string[];
  readonly sessionId: string; // derived from filename
}

// ---------------------------------------------------------------------------
// Registry stats (Tier-2) — read-only SQLite query without the full Registry
// interface stack. Uses better-sqlite3 directly since @yakcc/cli already
// depends on it.
// ---------------------------------------------------------------------------

interface AtomStat {
  readonly blockMerkleRoot: string;
  readonly createdAt: number;
  readonly implSourceLines: number;
}

interface RegistryStats {
  readonly total: number;
  readonly bootstrapCount: number;
  readonly userAddedCount: number;
  readonly medianImplSourceLines: number;
  readonly recentlyAdded: readonly AtomStat[];
  readonly allRoots: readonly string[];
}

async function readRegistryStats(registryPath: string): Promise<RegistryStats | null> {
  if (!existsSync(registryPath)) return null;
  try {
    // Dynamic import so better-sqlite3's native addon loads only when stats runs.
    const { default: Database } = await import("better-sqlite3");
    // biome-ignore lint/suspicious/noExplicitAny: better-sqlite3 constructor typing varies
    const db = new (Database as any)(registryPath, { readonly: true });
    try {
      type BlockRow = { block_merkle_root: string; created_at: number; impl_source: string };
      const rows = db
        .prepare(
          "SELECT block_merkle_root, created_at, impl_source FROM blocks ORDER BY created_at ASC",
        )
        .all() as BlockRow[];

      if (rows.length === 0) {
        return {
          total: 0,
          bootstrapCount: 0,
          userAddedCount: 0,
          medianImplSourceLines: 0,
          recentlyAdded: [],
          allRoots: [],
        };
      }

      const withLines = rows.map((r) => ({
        ...r,
        lines: r.impl_source.split("\n").length,
      }));

      const sortedLines = [...withLines.map((r) => r.lines)].sort((a, b) => a - b);
      const mid = Math.floor(sortedLines.length / 2);
      const median =
        sortedLines.length % 2 === 0
          ? Math.floor((sortedLines[mid - 1]! + sortedLines[mid]!) / 2)
          : sortedLines[mid]!;

      const bootstrapCount = withLines.filter((r) => r.created_at === 0).length;
      const recentlyAdded = [...withLines]
        .filter((r) => r.created_at > 0)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 20)
        .map((r) => ({
          blockMerkleRoot: r.block_merkle_root,
          createdAt: r.created_at,
          implSourceLines: r.lines,
        }));

      return {
        total: rows.length,
        bootstrapCount,
        userAddedCount: rows.length - bootstrapCount,
        medianImplSourceLines: median,
        recentlyAdded,
        allRoots: rows.map((r) => r.block_merkle_root),
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Telemetry reader
// ---------------------------------------------------------------------------

/** Read all JSONL events from the telemetry directory, skipping corrupt lines. */
function readAllEvents(dir: string, sinceMs: number | null): ParsedEvent[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }

  const events: ParsedEvent[] = [];
  for (const filePath of files) {
    const sessionId = filePath.split("/").pop()?.replace(".jsonl", "") ?? "unknown";
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as Record<string, unknown>;
        const t = typeof raw.t === "number" ? raw.t : 0;
        if (sinceMs !== null && t < sinceMs) continue;
        // Skip sentinel drift-alert events (candidateCount === -1)
        if (raw.candidateCount === -1) continue;
        events.push({
          t,
          toolName: typeof raw.toolName === "string" ? raw.toolName : "unknown",
          outcome: typeof raw.outcome === "string" ? raw.outcome : "unknown",
          candidateCount: typeof raw.candidateCount === "number" ? raw.candidateCount : 0,
          topScore: typeof raw.topScore === "number" ? raw.topScore : null,
          substituted: raw.substituted === true,
          substitutedAtomHash:
            typeof raw.substitutedAtomHash === "string" ? raw.substitutedAtomHash : null,
          ...(Array.isArray(raw.atomsCreated)
            ? { atomsCreated: raw.atomsCreated as readonly string[] }
            : {}),
          sessionId,
        });
      } catch {
        // Skip corrupt lines
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

type ToolName = "Edit" | "Write" | "MultiEdit";
const TOOL_NAMES: ToolName[] = ["Edit", "Write", "MultiEdit"];

interface Tier1Stats {
  readonly totalEvents: number;
  readonly hitCount: number;
  readonly synthesisCount: number;
  readonly passthroughCount: number;
  readonly otherCount: number;
  readonly perTool: Record<ToolName, { hits: number; total: number }>;
  readonly cosineBuckets: { lt010: number; lt020: number; lt030: number; ge030: number };
  readonly medianCosine: number | null;
  readonly sessionCount: number;
  readonly daysActive: number;
}

function computeTier1(events: ParsedEvent[]): Tier1Stats {
  const totalEvents = events.length;
  let hitCount = 0;
  let synthesisCount = 0;
  let passthroughCount = 0;
  let otherCount = 0;

  const perTool: Record<ToolName, { hits: number; total: number }> = {
    Edit: { hits: 0, total: 0 },
    Write: { hits: 0, total: 0 },
    MultiEdit: { hits: 0, total: 0 },
  };

  const cosineBuckets = { lt010: 0, lt020: 0, lt030: 0, ge030: 0 };
  const cosineScores: number[] = [];
  const sessionIds = new Set<string>();
  const daySet = new Set<string>();

  for (const ev of events) {
    if (ev.outcome === "registry-hit") hitCount++;
    else if (ev.outcome === "synthesis-required") synthesisCount++;
    else if (ev.outcome === "passthrough") passthroughCount++;
    else otherCount++;

    const tool = ev.toolName as ToolName;
    if (TOOL_NAMES.includes(tool)) {
      perTool[tool].total++;
      if (ev.outcome === "registry-hit") perTool[tool].hits++;
    }

    if (ev.topScore !== null && ev.outcome === "registry-hit") {
      const d = ev.topScore;
      if (d < 0.1) cosineBuckets.lt010++;
      else if (d < 0.2) cosineBuckets.lt020++;
      else if (d < 0.3) cosineBuckets.lt030++;
      else cosineBuckets.ge030++;
      cosineScores.push(d);
    }

    sessionIds.add(ev.sessionId);
    if (ev.t > 0) {
      daySet.add(new Date(ev.t).toISOString().slice(0, 10));
    }
  }

  let medianCosine: number | null = null;
  if (cosineScores.length > 0) {
    const sorted = [...cosineScores].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianCosine =
      sorted.length % 2 === 0
        ? (sorted[mid - 1]! + sorted[mid]!) / 2
        : sorted[mid]!;
  }

  return {
    totalEvents,
    hitCount,
    synthesisCount,
    passthroughCount,
    otherCount,
    perTool,
    cosineBuckets,
    medianCosine,
    sessionCount: sessionIds.size,
    daysActive: daySet.size,
  };
}

/** Compute most-reused atoms from events where substitutedAtomHash is present. */
function computeAtomHitCounts(events: ParsedEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (ev.substitutedAtomHash !== null) {
      counts.set(ev.substitutedAtomHash, (counts.get(ev.substitutedAtomHash) ?? 0) + 1);
    }
    if (ev.atomsCreated !== undefined) {
      for (const root of ev.atomsCreated) {
        const prefix = root.slice(0, 8);
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Pareto helper — how many atoms account for 80% of hits?
// ---------------------------------------------------------------------------

function paretoCount(atomHitCounts: Map<string, number>): number | null {
  if (atomHitCounts.size === 0) return null;
  const sorted = [...atomHitCounts.values()].sort((a, b) => b - a);
  const total = sorted.reduce((s, v) => s + v, 0);
  const threshold = Math.ceil(total * 0.8);
  let running = 0;
  for (let i = 0; i < sorted.length; i++) {
    running += sorted[i]!;
    if (running >= threshold) return i + 1;
  }
  return sorted.length;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function pct(num: number, denom: number): string {
  if (denom === 0) return "  0.0%";
  return `${((num / denom) * 100).toFixed(1).padStart(5)}%`;
}

function relativeDate(ms: number): string {
  const diffMs = Date.now() - ms;
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
}

// ---------------------------------------------------------------------------
// Output renderers
// ---------------------------------------------------------------------------

function printOverview(
  logger: Logger,
  tier1: Tier1Stats,
  reg: RegistryStats | null,
  atomHits: Map<string, number>,
  windowLabel: string,
): void {
  logger.log(`yakcc stats — local registry, ${windowLabel}`);
  logger.log("");

  // --- Atoms ---
  if (reg !== null) {
    logger.log("Atoms:");
    logger.log(`  in registry              ${String(reg.total).padStart(6)}`);
    logger.log(`  bootstrap (shipped)      ${String(reg.bootstrapCount).padStart(6)}`);
    const mostRecentLabel =
      reg.recentlyAdded.length > 0 && reg.recentlyAdded[0] !== undefined
        ? `  (most recent: ${relativeDate(reg.recentlyAdded[0].createdAt)})`
        : "";
    logger.log(`  added by you             ${String(reg.userAddedCount).padStart(6)}${mostRecentLabel}`);
    logger.log("");
  }

  // --- Discovery ---
  logger.log("Discovery (tool-call intercepts):");
  logger.log(`  total events             ${String(tier1.totalEvents).padStart(6)}`);
  logger.log(
    `  registry-hit             ${String(tier1.hitCount).padStart(6)}    (${pct(tier1.hitCount, tier1.totalEvents)})`,
  );
  logger.log(
    `  synthesis-required       ${String(tier1.synthesisCount).padStart(6)}   (${pct(tier1.synthesisCount, tier1.totalEvents)})`,
  );
  logger.log(
    `  passthrough              ${String(tier1.passthroughCount).padStart(6)}   (${pct(tier1.passthroughCount, tier1.totalEvents)})`,
  );
  if (tier1.otherCount > 0) {
    logger.log(
      `  other                    ${String(tier1.otherCount).padStart(6)}   (${pct(tier1.otherCount, tier1.totalEvents)})`,
    );
  }
  logger.log("");
  logger.log("  by tool:");
  for (const tool of TOOL_NAMES) {
    const { hits, total } = tier1.perTool[tool];
    if (total > 0) {
      logger.log(
        `    ${tool.padEnd(12)}${String(hits).padStart(4)} / ${String(total).padStart(4)}    (${pct(hits, total)} hit)`,
      );
    }
  }
  logger.log("");

  // --- Match quality ---
  if (tier1.hitCount > 0) {
    logger.log("Match quality (registry-hit cosine distance):");
    logger.log(`  <0.10 (excellent)         ${String(tier1.cosineBuckets.lt010).padStart(4)}`);
    logger.log(`  0.10-0.20 (good)          ${String(tier1.cosineBuckets.lt020).padStart(4)}`);
    logger.log(`  0.20-0.30 (acceptable)    ${String(tier1.cosineBuckets.lt030).padStart(4)}`);
    if (tier1.cosineBuckets.ge030 > 0) {
      logger.log(`  ≥0.30 (weak)              ${String(tier1.cosineBuckets.ge030).padStart(4)}`);
    }
    if (tier1.medianCosine !== null) {
      logger.log(`  median: ${tier1.medianCosine.toFixed(2)}`);
    }
    logger.log("");
  }

  // --- Most-reused atoms ---
  if (atomHits.size > 0) {
    logger.log("Most-reused atoms:");
    const sorted = [...atomHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [root, count] of sorted) {
      logger.log(`  ${root.padEnd(24)}  ${count} hit${count === 1 ? "" : "s"}`);
    }
    const pareto = paretoCount(atomHits);
    if (pareto !== null) {
      logger.log("");
      logger.log(
        `Atoms-carrying-weight: ${pareto} atom${pareto === 1 ? "" : "s"} account for 80% of hits (out of ${atomHits.size} atoms hit ever).`,
      );
    }
    logger.log("");
  }

  // --- Tier-2 counterfactual ---
  if (reg !== null && tier1.hitCount > 0) {
    const totalLocEstimate = tier1.hitCount * reg.medianImplSourceLines;
    logger.log("Matched-to-atom (Tier-2 counterfactual):");
    logger.log(`  emissions matched        ${String(tier1.hitCount).padStart(6)}`);
    logger.log(`  median atom size         ${String(reg.medianImplSourceLines).padStart(6)} LoC`);
    logger.log(
      `  total LoC matched-to-atom  ~${totalLocEstimate.toLocaleString()} lines that the registry served`,
    );
    logger.log("");
  }

  // --- Session info ---
  logger.log(
    `Sessions: ${tier1.sessionCount} session${tier1.sessionCount === 1 ? "" : "s"} across ${tier1.daysActive} day${tier1.daysActive === 1 ? "" : "s"} active.`,
  );
  logger.log("");
  logger.log("For raw telemetry: yakcc telemetry --tail 100   (see #760)");
}

function printHits(logger: Logger, events: ParsedEvent[], windowLabel: string): void {
  const hitEvents = events.filter((e) => e.outcome === "registry-hit");
  logger.log(`yakcc stats hits — ${windowLabel}`);
  logger.log("");
  logger.log(`Total registry-hits: ${hitEvents.length}`);
  logger.log("");

  const atomHits = computeAtomHitCounts(events);
  if (atomHits.size > 0) {
    logger.log("Per-atom hit counts:");
    const sorted = [...atomHits.entries()].sort((a, b) => b[1] - a[1]);
    for (const [root, count] of sorted) {
      logger.log(`  ${root}  ${count} hit${count === 1 ? "" : "s"}`);
    }
    logger.log("");
    const pareto = paretoCount(atomHits);
    if (pareto !== null) {
      logger.log(`Pareto: ${pareto} atom${pareto === 1 ? "" : "s"} account for 80% of all hits.`);
    }
  } else {
    logger.log(
      "(no per-atom data — atom hash requires Phase-2 substitution or atomized events)",
    );
  }

  logger.log("");
  logger.log("Per-tool breakdown:");
  for (const tool of TOOL_NAMES) {
    const toolHits = hitEvents.filter((e) => e.toolName === tool);
    const toolTotal = events.filter((e) => e.toolName === tool).length;
    if (toolTotal > 0) {
      logger.log(
        `  ${tool.padEnd(12)} ${toolHits.length} hits / ${toolTotal} total (${pct(toolHits.length, toolTotal)} hit)`,
      );
    }
  }

  if (hitEvents.length > 0) {
    const scores = hitEvents.map((e) => e.topScore).filter((s): s is number => s !== null);
    if (scores.length > 0) {
      const sorted = [...scores].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 0
          ? (sorted[mid - 1]! + sorted[mid]!) / 2
          : sorted[mid]!;
      logger.log("");
      logger.log(`Cosine distance distribution (${scores.length} hits with scores):`);
      logger.log(`  <0.10: ${scores.filter((s) => s < 0.1).length}   0.10-0.20: ${scores.filter((s) => s >= 0.1 && s < 0.2).length}   0.20-0.30: ${scores.filter((s) => s >= 0.2 && s < 0.3).length}   ≥0.30: ${scores.filter((s) => s >= 0.3).length}`);
      logger.log(`  median: ${median.toFixed(2)}`);
    }
  }
}

function printAtoms(logger: Logger, reg: RegistryStats | null, windowLabel: string): void {
  logger.log(`yakcc stats atoms — ${windowLabel}`);
  logger.log("");

  if (reg === null) {
    logger.log("(no registry found — run from a project with yakcc initialized, or use --registry)");
    return;
  }

  logger.log(`Atom inventory:`);
  logger.log(`  total in registry        ${String(reg.total).padStart(6)}`);
  logger.log(`  bootstrap (shipped)      ${String(reg.bootstrapCount).padStart(6)}`);
  logger.log(`  added by you             ${String(reg.userAddedCount).padStart(6)}`);
  logger.log(`  median LoC per atom      ${String(reg.medianImplSourceLines).padStart(6)}`);
  logger.log("");

  if (reg.recentlyAdded.length > 0) {
    logger.log("Recently added atoms (by you):");
    for (const atom of reg.recentlyAdded.slice(0, 10)) {
      logger.log(
        `  ${atom.blockMerkleRoot.slice(0, 16)}  ${atom.implSourceLines} LoC  ${relativeDate(atom.createdAt)}`,
      );
    }
  } else {
    logger.log("(no user-added atoms yet — all atoms are from the bootstrap corpus)");
  }
}

function printSessions(
  logger: Logger,
  events: ParsedEvent[],
  windowLabel: string,
  topN: number,
): void {
  logger.log(`yakcc stats sessions — ${windowLabel}`);
  logger.log("");

  const bySession = new Map<string, ParsedEvent[]>();
  for (const ev of events) {
    const list = bySession.get(ev.sessionId) ?? [];
    list.push(ev);
    bySession.set(ev.sessionId, list);
  }

  const rows = [...bySession.entries()]
    .map(([id, evs]) => {
      const hits = evs.filter((e) => e.outcome === "registry-hit").length;
      const total = evs.length;
      const timestamps = evs.map((e) => e.t).filter((t) => t > 0);
      const first = timestamps.length > 0 ? Math.min(...timestamps) : 0;
      const last = timestamps.length > 0 ? Math.max(...timestamps) : 0;
      return { id, hits, total, first, last };
    })
    .sort((a, b) => b.hits - a.hits)
    .slice(0, topN);

  if (rows.length === 0) {
    logger.log("(no session data)");
    return;
  }

  logger.log(`${"Session".padEnd(40)}  Events  Hits  HitRate`);
  logger.log("-".repeat(70));
  for (const row of rows) {
    const label = row.id.length > 38 ? `${row.id.slice(0, 36)}..` : row.id;
    logger.log(
      `${label.padEnd(40)}  ${String(row.total).padStart(6)}  ${String(row.hits).padStart(4)}  ${pct(row.hits, row.total)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

function buildJsonPayload(
  tier1: Tier1Stats,
  reg: RegistryStats | null,
  atomHits: Map<string, number>,
  windowLabel: string,
): object {
  return {
    window: windowLabel,
    discovery: {
      totalEvents: tier1.totalEvents,
      registryHit: tier1.hitCount,
      synthesisRequired: tier1.synthesisCount,
      passthrough: tier1.passthroughCount,
      other: tier1.otherCount,
      hitRatePct: tier1.totalEvents === 0 ? 0 : (tier1.hitCount / tier1.totalEvents) * 100,
      perTool: Object.fromEntries(
        TOOL_NAMES.map((t) => [
          t,
          {
            hits: tier1.perTool[t].hits,
            total: tier1.perTool[t].total,
            hitRatePct:
              tier1.perTool[t].total === 0
                ? 0
                : (tier1.perTool[t].hits / tier1.perTool[t].total) * 100,
          },
        ]),
      ),
      cosineBuckets: tier1.cosineBuckets,
      medianCosine: tier1.medianCosine,
    },
    sessions: {
      count: tier1.sessionCount,
      daysActive: tier1.daysActive,
    },
    atoms:
      reg !== null
        ? {
            total: reg.total,
            bootstrapCount: reg.bootstrapCount,
            userAddedCount: reg.userAddedCount,
            medianImplSourceLines: reg.medianImplSourceLines,
          }
        : null,
    counterfactual:
      reg !== null
        ? {
            emissionsMatched: tier1.hitCount,
            medianAtomLoC: reg.medianImplSourceLines,
            totalLoCEstimate: tier1.hitCount * reg.medianImplSourceLines,
          }
        : null,
    mostReusedAtoms: [...atomHits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([root, count]) => ({ root, count })),
  };
}

// ---------------------------------------------------------------------------
// Exported command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc stats [subcommand] [flags]`.
 *
 * Subcommands: (default overview), hits, atoms, sessions
 * Flags: --since <iso-date>, --json, --registry <path>, --top <N>
 *
 * @param argv   - Remaining argv after `stats` has been consumed.
 * @param logger - Output sink.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function stats(argv: readonly string[], logger: Logger): Promise<number> {
  // Detect subcommand first
  const positionals = argv.filter((a) => !a.startsWith("-"));
  const subcommand =
    positionals[0] === "hits" ||
    positionals[0] === "atoms" ||
    positionals[0] === "sessions"
      ? positionals[0]
      : undefined;

  const flagArgv = subcommand !== undefined ? argv.filter((a) => a !== subcommand) : argv;

  let parsed: {
    values: {
      since?: string;
      json?: boolean;
      registry?: string;
      top?: string;
      watch?: boolean;
    };
  };

  try {
    parsed = parseArgs({
      args: [...flagArgv],
      options: {
        since: { type: "string" },
        json: { type: "boolean" },
        registry: { type: "string" },
        top: { type: "string" },
        watch: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error("Usage: yakcc stats [hits|atoms|sessions] [--since <date>] [--json] [--registry <path>]");
    return 1;
  }

  // --since validation
  let sinceMs: number | null = null;
  if (parsed.values.since !== undefined) {
    const d = Date.parse(parsed.values.since);
    if (Number.isNaN(d)) {
      logger.error(`error: --since requires a valid ISO date, got: ${parsed.values.since}`);
      return 1;
    }
    sinceMs = d;
  }

  // --top validation
  let topN = 20;
  if (parsed.values.top !== undefined) {
    const n = Number.parseInt(parsed.values.top, 10);
    if (Number.isNaN(n) || n < 1) {
      logger.error(`error: --top requires a positive integer, got: ${parsed.values.top}`);
      return 1;
    }
    topN = n;
  }

  const telemetryDir = resolveTelemetryDir();
  const registryPath = parsed.values.registry ?? DEFAULT_REGISTRY_PATH;

  // Read telemetry
  const events = readAllEvents(telemetryDir, sinceMs);

  // Empty-state UX
  if (events.length === 0) {
    if (subcommand === undefined || subcommand === "sessions") {
      logger.log("No hits yet — your registry is fresh; use Claude Code for a while and run yakcc stats again.");
      logger.log(`(telemetry dir: ${telemetryDir})`);
    } else {
      logger.log(`No ${subcommand} data yet.`);
      logger.log(`(telemetry dir: ${telemetryDir})`);
    }
    return 0;
  }

  const windowLabel =
    sinceMs !== null
      ? `since ${new Date(sinceMs).toISOString().slice(0, 10)}`
      : "lifetime";

  // Registry join (Tier-2) — gracefully omitted if registry not found
  const reg = await readRegistryStats(registryPath);
  const tier1 = computeTier1(events);
  const atomHits = computeAtomHitCounts(events);

  // --json: emit structured JSON and exit
  if (parsed.values.json === true) {
    logger.log(JSON.stringify(buildJsonPayload(tier1, reg, atomHits, windowLabel), null, 2));
    return 0;
  }

  // Subcommand dispatch
  switch (subcommand) {
    case "hits":
      printHits(logger, events, windowLabel);
      break;
    case "atoms":
      printAtoms(logger, reg, windowLabel);
      break;
    case "sessions":
      printSessions(logger, events, windowLabel, topN);
      break;
    default:
      printOverview(logger, tier1, reg, atomHits, windowLabel);
  }

  return 0;
}
