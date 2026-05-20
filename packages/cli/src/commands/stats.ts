// SPDX-License-Identifier: MIT
//
// stats.ts — handler for `yakcc stats [subcommand] [--since <date>] [--json] [--top <n>] [--registry <path>]`
//
// @decision DEC-CLI-STATS-COMMAND-001
// title: `yakcc stats` surfaces Tier-1 telemetry metrics and Tier-2 registry join for alpha testers
// status: accepted (WI-764)
// rationale:
//   Alpha testers can't tell if yakcc is working without numbers. This command reads
//   local telemetry JSONL files (D-HOOK-5 schema) and optionally joins against
//   registry.sqlite to answer "is yakcc working for me?" — zero network I/O, B6 air-gap
//   compliant. Uses better-sqlite3 directly for registry reads rather than openRegistry()
//   to avoid loading sqlite-vec + embedding infrastructure for a pure-read stats query.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { resolveTelemetryDir } from "@yakcc/hooks-base/telemetry.js";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedEvent {
  readonly t: number;
  readonly sessionId: string;
  readonly toolName: string;
  readonly outcome: string;
  readonly topScore: number | null;
  readonly candidateCount: number;
  readonly substituted: boolean;
  readonly substitutedAtomHash: string | null;
}

interface SessionData {
  readonly sessionId: string;
  readonly events: ParsedEvent[];
  readonly firstAt: number;
  readonly lastAt: number;
}

interface Tier1Stats {
  readonly totalEvents: number;
  readonly sessionCount: number;
  readonly firstEventAt: number;
  readonly lastEventAt: number;
  readonly outcomeCounts: Record<string, number>;
  readonly toolTotals: Record<string, number>;
  readonly toolHits: Record<string, number>;
  readonly cosineDistances: number[];
  readonly atomHashHits: Map<string, number>; // prefix → hit count
}

interface BlockRow {
  readonly block_merkle_root: string;
  readonly impl_source: string;
  readonly created_at: number;
  readonly spec_canonical_bytes: Buffer;
}

interface RegistryStats {
  readonly totalAtoms: number;
  readonly bootstrapAtoms: number;
  readonly userAddedAtoms: number;
  readonly recentlyAdded: Array<{ readonly prefix: string; readonly name: string; readonly createdAt: number }>;
  readonly atomImplSources: Map<string, string>; // prefix → implSource
  readonly atomNames: Map<string, string>;        // prefix → name
}

interface StatsOutput {
  readonly tier1: Tier1Stats;
  readonly registry: RegistryStats | null;
  readonly sessions: SessionData[];
}

// ---------------------------------------------------------------------------
// Telemetry parsing
// ---------------------------------------------------------------------------

/**
 * Parse all JSONL telemetry files from a directory, returning one ParsedEvent per valid line.
 * Skips corrupt lines and entire files that cannot be read (graceful degradation per WI-764).
 */
function parseTelemetryDir(dir: string, sinceMs?: number): SessionData[] {
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }

  const sessions: SessionData[] = [];
  for (const filePath of files) {
    const sessionId = filePath.split("/").pop()?.replace(".jsonl", "") ?? filePath;
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue; // skip unreadable files
    }

    const events: ParsedEvent[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // skip corrupt lines
      }
      if (typeof obj !== "object" || obj === null) continue;
      const ev = obj as Record<string, unknown>;
      const t = typeof ev.t === "number" ? ev.t : 0;
      if (sinceMs !== undefined && t < sinceMs) continue;

      // Skip drift-alert sentinel events (candidateCount = -1)
      const candidateCount = typeof ev.candidateCount === "number" ? ev.candidateCount : 0;
      if (candidateCount === -1) continue;

      events.push({
        t,
        sessionId,
        toolName: typeof ev.toolName === "string" ? ev.toolName : "unknown",
        outcome: typeof ev.outcome === "string" ? ev.outcome : "unknown",
        topScore: typeof ev.topScore === "number" ? ev.topScore : null,
        candidateCount,
        substituted: ev.substituted === true,
        substitutedAtomHash:
          typeof ev.substitutedAtomHash === "string" ? ev.substitutedAtomHash : null,
      });
    }

    if (events.length === 0) continue;
    const timestamps = events.map((e) => e.t);
    sessions.push({
      sessionId,
      events,
      firstAt: Math.min(...timestamps),
      lastAt: Math.max(...timestamps),
    });
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// Tier-1 metric computation
// ---------------------------------------------------------------------------

function computeTier1(sessions: SessionData[]): Tier1Stats {
  let totalEvents = 0;
  let firstEventAt = Number.MAX_SAFE_INTEGER;
  let lastEventAt = 0;
  const outcomeCounts: Record<string, number> = {};
  const toolTotals: Record<string, number> = {};
  const toolHits: Record<string, number> = {};
  const cosineDistances: number[] = [];
  const atomHashHits = new Map<string, number>();

  for (const session of sessions) {
    for (const ev of session.events) {
      totalEvents++;
      if (ev.t < firstEventAt) firstEventAt = ev.t;
      if (ev.t > lastEventAt) lastEventAt = ev.t;

      outcomeCounts[ev.outcome] = (outcomeCounts[ev.outcome] ?? 0) + 1;
      toolTotals[ev.toolName] = (toolTotals[ev.toolName] ?? 0) + 1;

      if (ev.outcome === "registry-hit") {
        toolHits[ev.toolName] = (toolHits[ev.toolName] ?? 0) + 1;
        if (ev.topScore !== null) cosineDistances.push(ev.topScore);
        if (ev.substitutedAtomHash !== null) {
          const prior = atomHashHits.get(ev.substitutedAtomHash) ?? 0;
          atomHashHits.set(ev.substitutedAtomHash, prior + 1);
        }
      }
    }
  }

  if (totalEvents === 0) {
    firstEventAt = 0;
    lastEventAt = 0;
  }

  return {
    totalEvents,
    sessionCount: sessions.length,
    firstEventAt,
    lastEventAt,
    outcomeCounts,
    toolTotals,
    toolHits,
    cosineDistances,
    atomHashHits,
  };
}

// ---------------------------------------------------------------------------
// Tier-2 registry stats
// ---------------------------------------------------------------------------

/**
 * Open the registry SQLite in read-only mode and extract block statistics.
 *
 * @decision DEC-CLI-STATS-REGISTRY-ACCESS-001
 * title: Stats command uses better-sqlite3 directly rather than openRegistry()
 * status: accepted (WI-764)
 * rationale:
 *   openRegistry() loads sqlite-vec (a native extension) and an embedding provider
 *   (potentially downloading a local ML model). Neither is needed for the read-only
 *   count + implSource queries that stats requires. Direct DB access is faster,
 *   has no side effects, and cannot trigger model downloads.
 *
 * @decision DEC-CLI-STATS-BOOTSTRAP-DISCRIMINATOR-001
 * title: Bootstrap atom discriminator uses `created_at = 0` in the DB, falling back to `source_pkg IS NULL`
 * status: accepted (WI-764)
 * rationale:
 *   The issue specifies "bootstrap atoms have createdAt=0 per DEC-STORAGE-IDEMPOTENT-001".
 *   If the shipped registry was built with explicit `created_at = 0` rows, that
 *   discriminator works precisely. If not (all atoms have real timestamps), we fall back to
 *   `source_pkg IS NULL` (seed/federation atoms have no source context; user-shaved atoms do).
 *   We try the createdAt=0 count first and use source_pkg fallback when that count == 0.
 */
function openRegistryReadOnly(dbPath: string): RegistryStats | null {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }

  try {
    // Count total atoms.
    const totalAtoms = (
      db.prepare("SELECT COUNT(*) AS n FROM blocks").get() as { n: number }
    ).n;

    // Bootstrap discriminator: try created_at = 0 first (per WI-764 spec).
    const byCreatedAtZero = (
      db.prepare("SELECT COUNT(*) AS n FROM blocks WHERE created_at = 0").get() as { n: number }
    ).n;

    let bootstrapAtoms: number;
    let userAddedAtoms: number;
    if (byCreatedAtZero > 0) {
      bootstrapAtoms = byCreatedAtZero;
      userAddedAtoms = totalAtoms - bootstrapAtoms;
    } else {
      // Fallback: atoms without source_pkg context are seed/federation atoms.
      const withoutSourcePkg = (
        db.prepare("SELECT COUNT(*) AS n FROM blocks WHERE source_pkg IS NULL").get() as {
          n: number;
        }
      ).n;
      bootstrapAtoms = withoutSourcePkg;
      userAddedAtoms = totalAtoms - bootstrapAtoms;
    }

    // Recently added user atoms: atoms with source_pkg NOT NULL or created_at > 0,
    // ordered by created_at DESC, limited to top 20 for the overview.
    let recentRows: Array<{ block_merkle_root: string; impl_source: string; created_at: number; spec_canonical_bytes: Buffer }>;
    try {
      if (byCreatedAtZero > 0) {
        recentRows = db
          .prepare(
            "SELECT block_merkle_root, impl_source, created_at, spec_canonical_bytes FROM blocks WHERE created_at > 0 ORDER BY created_at DESC LIMIT 20",
          )
          .all() as typeof recentRows;
      } else {
        recentRows = db
          .prepare(
            "SELECT block_merkle_root, impl_source, created_at, spec_canonical_bytes FROM blocks WHERE source_pkg IS NOT NULL ORDER BY created_at DESC LIMIT 20",
          )
          .all() as typeof recentRows;
      }
    } catch {
      recentRows = [];
    }

    // Build atom name + implSource maps.
    const atomImplSources = new Map<string, string>();
    const atomNames = new Map<string, string>();
    const recentlyAdded: RegistryStats["recentlyAdded"] = [];

    for (const row of recentRows) {
      const prefix = row.block_merkle_root.slice(0, 8);
      atomImplSources.set(prefix, row.impl_source);
      const name = extractSpecName(row.spec_canonical_bytes);
      atomNames.set(prefix, name);
      recentlyAdded.push({ prefix, name, createdAt: row.created_at });
    }

    // Also fetch implSource for any atoms referenced in telemetry hit events (for LoC).
    // Done lazily: callers supply hashes from Tier-1 and we look them up in a second pass.

    db.close();
    return { totalAtoms, bootstrapAtoms, userAddedAtoms, recentlyAdded, atomImplSources, atomNames };
  } catch {
    try { db.close(); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Look up implSource for a list of 8-char BMR prefixes from the registry.
 * Returns a map of prefix → implSource for found atoms.
 */
function lookupAtomSources(dbPath: string, prefixes: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (prefixes.length === 0) return result;

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return result;
  }
  try {
    const stmt = db.prepare(
      "SELECT block_merkle_root, impl_source FROM blocks WHERE block_merkle_root LIKE ? || '%' LIMIT 1",
    );
    for (const prefix of prefixes) {
      const row = stmt.get(prefix) as { block_merkle_root: string; impl_source: string } | undefined;
      if (row !== undefined) {
        result.set(prefix, row.impl_source);
      }
    }
  } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  return result;
}

/**
 * Extract the contract/function name from the spec canonical bytes.
 * Spec bytes are UTF-8 JSON; the name field is at top level.
 */
function extractSpecName(specBytes: Buffer | null | undefined): string {
  if (!specBytes || specBytes.length === 0) return "(unknown)";
  try {
    const obj = JSON.parse(specBytes.toString("utf-8")) as Record<string, unknown>;
    if (typeof obj.name === "string" && obj.name.length > 0) return obj.name;
    if (typeof obj.behavior === "string") {
      // Fallback: take first 40 chars of behavior as a readable label.
      return obj.behavior.slice(0, 40);
    }
  } catch { /* ignore */ }
  return "(unknown)";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(n: number, total: number): string {
  if (total === 0) return " 0.0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function relativeDate(ms: number): string {
  if (ms === 0) return "never";
  const diffMs = Date.now() - ms;
  const days = Math.floor(diffMs / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function formatDate(ms: number): string {
  if (ms === 0) return "never";
  return new Date(ms).toISOString().slice(0, 10);
}

function medianOf(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

function locCount(src: string): number {
  return src.split("\n").length;
}

/** How many top atoms account for at least 80% of total hits (Pareto threshold). */
function paretoCount(hitCounts: number[]): number {
  if (hitCounts.length === 0) return 0;
  const total = hitCounts.reduce((a, b) => a + b, 0);
  const threshold = total * 0.8;
  const sorted = [...hitCounts].sort((a, b) => b - a);
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i] as number;
    if (acc >= threshold) return i + 1;
  }
  return sorted.length;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderOverview(
  tier1: Tier1Stats,
  registry: RegistryStats | null,
  sessions: SessionData[],
  atomSources: Map<string, string>,
  opts: { since: number | undefined; topN: number },
  logger: Logger,
): void {
  const sinceLabel = opts.since
    ? `since ${formatDate(opts.since)}`
    : "lifetime";
  logger.log(`yakcc stats — ${sinceLabel}`);
  logger.log("");

  // ---- Atoms (Tier 2) -----
  if (registry !== null) {
    logger.log("Atoms:");
    logger.log(`  in registry          ${fmt(registry.totalAtoms).padStart(8)}`);
    logger.log(
      `  bootstrap (shipped)  ${fmt(registry.bootstrapAtoms).padStart(8)}`,
    );
    const recentMost = registry.recentlyAdded[0];
    const addedNote =
      registry.userAddedAtoms > 0 && recentMost !== undefined
        ? `  (most recent: ${relativeDate(recentMost.createdAt)})`
        : "";
    logger.log(
      `  added by you         ${fmt(registry.userAddedAtoms).padStart(8)}${addedNote}`,
    );
    logger.log("");
  }

  // ---- Discovery (Tier 1) ----
  const hitCount = tier1.outcomeCounts["registry-hit"] ?? 0;
  const synthCount = tier1.outcomeCounts["synthesis-required"] ?? 0;
  const passthroughCount = tier1.outcomeCounts["passthrough"] ?? 0;

  if (tier1.totalEvents === 0) {
    logger.log(
      "No hits yet — your registry is fresh; use Claude Code for a while and run yakcc stats again.",
    );
    logger.log("");
    logger.log("For raw telemetry: yakcc telemetry --tail 100");
    return;
  }

  logger.log("Discovery (tool-call intercepts):");
  logger.log(`  total events         ${fmt(tier1.totalEvents).padStart(8)}`);
  logger.log(
    `  registry-hit         ${fmt(hitCount).padStart(8)}    (${pct(hitCount, tier1.totalEvents)})`,
  );
  logger.log(
    `  synthesis-required   ${fmt(synthCount).padStart(8)}   (${pct(synthCount, tier1.totalEvents)})`,
  );
  logger.log(
    `  passthrough          ${fmt(passthroughCount).padStart(8)}   (${pct(passthroughCount, tier1.totalEvents)})`,
  );

  const tools = ["Edit", "Write", "MultiEdit"];
  const toolHeader = tools.some((t) => (tier1.toolTotals[t] ?? 0) > 0);
  if (toolHeader) {
    logger.log("");
    logger.log("  by tool:");
    for (const tool of tools) {
      const total = tier1.toolTotals[tool] ?? 0;
      const hits = tier1.toolHits[tool] ?? 0;
      if (total === 0) continue;
      logger.log(
        `    ${tool.padEnd(12)} ${fmt(hits).padStart(5)} / ${fmt(total).padStart(6)}    (${pct(hits, total).padStart(6)} hit)`,
      );
    }
  }
  logger.log("");

  // ---- Match quality ----
  if (tier1.cosineDistances.length > 0) {
    const dists = tier1.cosineDistances;
    const lt10 = dists.filter((d) => d < 0.1).length;
    const lt20 = dists.filter((d) => d >= 0.1 && d < 0.2).length;
    const lt30 = dists.filter((d) => d >= 0.2 && d < 0.3).length;
    const ge30 = dists.filter((d) => d >= 0.3).length;
    const med = medianOf(dists);

    logger.log("Match quality (registry-hit cosine distance):");
    logger.log(`  <0.10  (excellent)   ${fmt(lt10).padStart(8)}`);
    logger.log(`  0.10–0.20 (good)     ${fmt(lt20).padStart(8)}`);
    logger.log(`  0.20–0.30 (accept.)  ${fmt(lt30).padStart(8)}`);
    logger.log(`  ≥0.30  (borderline)  ${fmt(ge30).padStart(8)}`);
    logger.log(`  median: ${med !== null ? med.toFixed(3) : "—"}`);
    logger.log("");
  }

  // ---- Most-reused atoms (Phase 2 only) ----
  if (tier1.atomHashHits.size > 0) {
    const sortedHits = [...tier1.atomHashHits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.topN);
    logger.log("Most-reused atoms:");
    for (const [prefix, count] of sortedHits) {
      const name = registry?.atomNames.get(prefix) ?? atomSources.get(prefix) ?? prefix;
      logger.log(`  ${name.padEnd(36)} ${fmt(count).padStart(4)} hits`);
    }
    const allHitCounts = [...tier1.atomHashHits.values()];
    const pareto = paretoCount(allHitCounts);
    logger.log(
      `\nAtoms-carrying-weight: ${pareto} atom${pareto !== 1 ? "s" : ""} account for 80% of hits (out of ${tier1.atomHashHits.size} atoms hit ever).`,
    );
    logger.log("");
  }

  // ---- Tier-2 LoC counterfactual ----
  if (tier1.atomHashHits.size > 0 && atomSources.size > 0) {
    let totalLoC = 0;
    const locs: number[] = [];
    for (const [prefix] of tier1.atomHashHits.entries()) {
      const src = atomSources.get(prefix);
      if (src !== undefined) {
        const loc = locCount(src);
        totalLoC += loc * (tier1.atomHashHits.get(prefix) ?? 0);
        locs.push(loc);
      }
    }
    if (totalLoC > 0) {
      const medianLoC = medianOf(locs);
      logger.log("Matched-to-atom (Tier-2 counterfactual):");
      logger.log(`  emissions matched    ${fmt(tier1.atomHashHits.size).padStart(8)}`);
      logger.log(`  median atom size     ${medianLoC !== null ? fmt(Math.round(medianLoC)) : "—"} LoC`);
      logger.log(
        `  total LoC matched    ~${fmt(totalLoC)} lines that the registry served`,
      );
      logger.log("");
    }
  } else if (hitCount > 0 && tier1.atomHashHits.size === 0) {
    logger.log("Matched-to-atom: not available (Phase 1 mode — atom identity not captured in telemetry).");
    logger.log("");
  }

  logger.log(`Sessions: ${fmt(tier1.sessionCount)}  ·  Active: ${formatDate(tier1.firstEventAt)} – ${formatDate(tier1.lastEventAt)}`);
  logger.log("");
  logger.log("For raw telemetry: yakcc telemetry --tail 100");
}

function renderHits(
  tier1: Tier1Stats,
  atomSources: Map<string, string>,
  topN: number,
  logger: Logger,
): void {
  logger.log("yakcc stats hits — per-tool and per-atom breakdown");
  logger.log("");

  const hitCount = tier1.outcomeCounts["registry-hit"] ?? 0;
  if (hitCount === 0) {
    logger.log("No registry-hits recorded yet.");
    return;
  }

  logger.log("By tool:");
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    const total = tier1.toolTotals[tool] ?? 0;
    const hits = tier1.toolHits[tool] ?? 0;
    if (total === 0) continue;
    logger.log(`  ${tool.padEnd(12)} ${fmt(hits).padStart(5)} / ${fmt(total).padStart(6)}  (${pct(hits, total).padStart(6)} hit)`);
  }
  logger.log("");

  // Cosine distance distribution
  if (tier1.cosineDistances.length > 0) {
    const dists = tier1.cosineDistances;
    const lt10 = dists.filter((d) => d < 0.1).length;
    const lt20 = dists.filter((d) => d >= 0.1 && d < 0.2).length;
    const lt30 = dists.filter((d) => d >= 0.2 && d < 0.3).length;
    const ge30 = dists.filter((d) => d >= 0.3).length;
    const med = medianOf(dists);

    logger.log("Cosine distance distribution (registry-hits):");
    logger.log(`  <0.10  (excellent)   ${fmt(lt10).padStart(8)}  (${pct(lt10, dists.length)})`);
    logger.log(`  0.10–0.20 (good)     ${fmt(lt20).padStart(8)}  (${pct(lt20, dists.length)})`);
    logger.log(`  0.20–0.30 (accept.)  ${fmt(lt30).padStart(8)}  (${pct(lt30, dists.length)})`);
    logger.log(`  ≥0.30  (borderline)  ${fmt(ge30).padStart(8)}  (${pct(ge30, dists.length)})`);
    logger.log(`  median: ${med !== null ? med.toFixed(3) : "—"}`);
    logger.log("");
  }

  // Per-atom breakdown (Phase 2 only)
  if (tier1.atomHashHits.size > 0) {
    const sorted = [...tier1.atomHashHits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN);
    logger.log(`Top atoms by hit count (top ${topN}):`);
    for (const [prefix, count] of sorted) {
      const src = atomSources.get(prefix);
      const loc = src !== undefined ? ` (${locCount(src)} LoC)` : "";
      logger.log(`  ${prefix.padEnd(10)} ${fmt(count).padStart(5)} hits${loc}`);
    }
    logger.log("");
  } else {
    logger.log("Per-atom breakdown: not available (Phase 1 mode — atom identity not captured in telemetry).");
    logger.log("Run with hooks-base Phase 2 adapters (Cursor, Cline, etc.) to see per-atom stats.");
  }
}

function renderAtoms(registry: RegistryStats, topN: number, logger: Logger): void {
  logger.log("yakcc stats atoms — atom inventory");
  logger.log("");
  logger.log(`  in registry          ${fmt(registry.totalAtoms).padStart(8)}`);
  logger.log(`  bootstrap (shipped)  ${fmt(registry.bootstrapAtoms).padStart(8)}`);
  logger.log(`  added by you         ${fmt(registry.userAddedAtoms).padStart(8)}`);
  logger.log("");

  if (registry.recentlyAdded.length === 0) {
    logger.log("No user-added atoms yet — shave some code with `yakcc shave` to add atoms.");
    return;
  }

  logger.log(`Recently added (up to ${topN}):`);
  for (const atom of registry.recentlyAdded.slice(0, topN)) {
    const loc = registry.atomImplSources.get(atom.prefix);
    const locStr = loc !== undefined ? ` (${locCount(loc)} LoC)` : "";
    logger.log(`  ${atom.prefix}  ${atom.name.padEnd(36)}  ${relativeDate(atom.createdAt)}${locStr}`);
  }
}

function renderSessions(sessions: SessionData[], topN: number, logger: Logger): void {
  logger.log("yakcc stats sessions — per-session breakdown");
  logger.log("");

  if (sessions.length === 0) {
    logger.log("No session data found.");
    return;
  }

  // Sort sessions by most hits first, then by most events.
  const sorted = [...sessions]
    .map((s) => {
      const hits = s.events.filter((e) => e.outcome === "registry-hit").length;
      return { s, hits };
    })
    .sort((a, b) => b.hits - a.hits || b.s.events.length - a.s.events.length)
    .slice(0, topN);

  logger.log("  session-id (first 8)  events  hits  hit-rate  span");
  logger.log("  ─────────────────────────────────────────────────────");
  for (const { s, hits } of sorted) {
    const events = s.events.length;
    const rate = pct(hits, events);
    const spanMs = s.lastAt - s.firstAt;
    const spanStr = spanMs < 60_000
      ? `${Math.floor(spanMs / 1000)}s`
      : spanMs < 3_600_000
        ? `${Math.floor(spanMs / 60_000)}m`
        : `${Math.floor(spanMs / 3_600_000)}h`;
    const shortId = s.sessionId.slice(0, 8);
    logger.log(
      `  ${shortId.padEnd(22)} ${fmt(events).padStart(6)}  ${fmt(hits).padStart(4)}  ${rate.padStart(8)}  ${spanStr}`,
    );
  }
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

function buildJsonOutput(
  tier1: Tier1Stats,
  registry: RegistryStats | null,
  sessions: SessionData[],
  atomSources: Map<string, string>,
): unknown {
  const hitCount = tier1.outcomeCounts["registry-hit"] ?? 0;
  const totalLoC =
    tier1.atomHashHits.size > 0
      ? [...tier1.atomHashHits.entries()].reduce((acc, [prefix, count]) => {
          const src = atomSources.get(prefix);
          return acc + (src !== undefined ? locCount(src) * count : 0);
        }, 0)
      : null;

  return {
    telemetry: {
      sessions: tier1.sessionCount,
      totalEvents: tier1.totalEvents,
      firstEventAt: tier1.firstEventAt || null,
      lastEventAt: tier1.lastEventAt || null,
      outcomes: tier1.outcomeCounts,
      hitRate: tier1.totalEvents > 0 ? hitCount / tier1.totalEvents : 0,
      byTool: Object.fromEntries(
        Object.entries(tier1.toolTotals).map(([tool, total]) => [
          tool,
          { total, hits: tier1.toolHits[tool] ?? 0 },
        ]),
      ),
      cosineDistanceMedian: medianOf(tier1.cosineDistances),
    },
    registry: registry
      ? {
          totalAtoms: registry.totalAtoms,
          bootstrapAtoms: registry.bootstrapAtoms,
          userAddedAtoms: registry.userAddedAtoms,
        }
      : null,
    counterfactual: {
      atomsHit: tier1.atomHashHits.size,
      totalLocMatchedToAtom: totalLoC,
    },
    sessionBreakdown: sessions.map((s) => ({
      sessionId: s.sessionId,
      events: s.events.length,
      hits: s.events.filter((e) => e.outcome === "registry-hit").length,
      firstAt: s.firstAt,
      lastAt: s.lastAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc stats [subcommand] [--since <date>] [--json] [--top <n>] [--registry <path>]`.
 *
 * @param argv   - Remaining argv after `stats` has been consumed.
 * @param logger - Output sink.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function stats(argv: readonly string[], logger: Logger): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        since: { type: "string" };
        json: { type: "boolean" };
        top: { type: "string" };
        registry: { type: "string" };
      };
      allowPositionals: true;
    }>
  >;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        since: { type: "string" },
        json: { type: "boolean" },
        top: { type: "string" },
        registry: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error("Usage: yakcc stats [hits|atoms|sessions] [--since <iso-date>] [--json] [--top <n>] [--registry <path>]");
    return 1;
  }

  // Validate --since
  let sinceMs: number | undefined;
  if (parsed.values.since !== undefined) {
    const ms = Date.parse(parsed.values.since);
    if (Number.isNaN(ms)) {
      logger.error(`error: --since requires a valid ISO date, got: ${parsed.values.since}`);
      return 1;
    }
    sinceMs = ms;
  }

  // Validate --top
  let topN = 10;
  if (parsed.values.top !== undefined) {
    const n = Number.parseInt(parsed.values.top, 10);
    if (Number.isNaN(n) || n < 1) {
      logger.error(`error: --top requires a positive integer, got: ${parsed.values.top}`);
      return 1;
    }
    topN = n;
  }

  const subcommand = parsed.positionals[0];
  const asJson = parsed.values.json === true;
  const registryPath = resolve(parsed.values.registry ?? ".yakcc/registry.sqlite");
  const telemetryDir = resolveTelemetryDir();

  // Parse telemetry
  const sessions = parseTelemetryDir(telemetryDir, sinceMs);
  const tier1 = computeTier1(sessions);

  // Open registry (optional — graceful null if not present)
  const registry = existsSync(registryPath) ? openRegistryReadOnly(registryPath) : null;

  // Look up implSource for atoms referenced in telemetry hits
  const atomPrefixes = [...tier1.atomHashHits.keys()];
  const atomSources: Map<string, string> =
    atomPrefixes.length > 0 && existsSync(registryPath)
      ? lookupAtomSources(registryPath, atomPrefixes)
      : new Map();

  // Merge atom names from registry into atomSources for display
  if (registry !== null) {
    for (const [prefix, name] of registry.atomNames.entries()) {
      if (!atomSources.has(prefix)) {
        // Add implSource from recentlyAdded if available
        const src = registry.atomImplSources.get(prefix);
        if (src !== undefined) atomSources.set(prefix, src);
      }
    }
  }

  // JSON output shortcut
  if (asJson) {
    logger.log(JSON.stringify(buildJsonOutput(tier1, registry, sessions, atomSources), null, 2));
    return 0;
  }

  // Dispatch subcommand
  switch (subcommand) {
    case "hits": {
      renderHits(tier1, atomSources, topN, logger);
      return 0;
    }

    case "atoms": {
      if (registry === null) {
        logger.log(`Registry not found at ${registryPath}.`);
        logger.log("Run `yakcc registry init` then `yakcc seed` to initialize the registry.");
        return 0;
      }
      renderAtoms(registry, topN, logger);
      return 0;
    }

    case "sessions": {
      renderSessions(sessions, topN, logger);
      return 0;
    }

    case undefined: {
      renderOverview(tier1, registry, sessions, atomSources, { since: sinceMs, topN }, logger);
      return 0;
    }

    default: {
      logger.error(`error: unknown stats subcommand: ${subcommand}`);
      logger.error("Valid subcommands: hits, atoms, sessions");
      return 1;
    }
  }
}
