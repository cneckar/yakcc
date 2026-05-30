// SPDX-License-Identifier: MIT
//
// stats-atoms.ts — Tier-2 + Tier-3 atom-reuse aggregation for `yakcc stats`
//
// @decision DEC-CLI-STATS-TIER-2-001
// @title `yakcc stats` Tier-2 atom-reuse + Tier-3 LoC-saved fold-in (WI-768)
// @status accepted (WI-CLI-STATS-TIER-2-IMPL, 2026-05-29)
// @rationale
//   Tier-2 (atom-reuse headline metrics) and Tier-3 (LoC-saved) are implemented
//   as a SECOND pure reducer over TelemetryEvent[], produced by the existing
//   readTelemetrySessions() seam in @yakcc/hooks-base (DEC-CLI-STATS-READER-SEAM-001).
//   The reducer is intentionally separated from Tier-1's aggregate() so the
//   additive-forward invariant is mechanical: the existing reducer is untouched.
//
//   Hit definition (narrow): outcome === "registry-hit" && substituted === true
//   && substitutedAtomHash !== null. All other outcomes — passthrough,
//   synthesis-required, intent-too-broad, result-set-too-large, atom-size-too-large,
//   shave-on-miss-*, atomized, drift-alert — are excluded.
//
//   Registry reads go through Registry.getBlock(merkleRoot) only — no direct
//   SQLite reads, no second reader, no new JSONL parser. The registry is opened
//   exactly once per invocation (lazy — only when ≥1 hit event exists) and
//   closed before returning (I-C).
//
//   Tier-3 fold-in is mechanically free: BlockTripletRow.implSource.split("\n")
//   .length × hitCount while the block row is already in hand from the getBlock
//   call needed for grain enrichment.
//
//   Degraded mode: if the registry SQLite is absent (ENOENT from openRegistry),
//   atoms.degraded = true, atoms.degradedReason = "registry-not-found", grain
//   fields absent/unknown, locSaved absent, exit 0 (no crash). This mirrors the
//   Tier-1 graceful-empty-state philosophy.
//
//   Percentile method: nearest-rank (lower interpolation) over the sorted
//   per-atom hit-count array. Empty → null. The method is intentionally simple
//   and documented here so it can be audited against T-TIER2-2.
//
//   Tie-break on top-N: descending hit count, then ascending atomHash lexicographic.
//   This gives stable ordering across invocations even when multiple atoms share
//   the same hit count.
//
//   See DEC-CLI-STATS-TIER-2-001 in MASTER_PLAN.md for full decision record.

import type { TelemetryEvent } from "@yakcc/hooks-base/telemetry.js";
import {
  type BlockMerkleRoot,
  type BlockTripletRow,
  type Registry,
  openRegistry,
} from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Public shape — the `atoms` block in --json output
// ---------------------------------------------------------------------------

/** A single atom entry in atoms.top, sorted by descending hits then asc atomHash. */
export interface AtomTopEntry {
  readonly atomHash: string;
  readonly hits: number;
  /** Registry level L0–L3, or null when registry is unavailable or hash not found. */
  readonly level: "L0" | "L1" | "L2" | "L3" | null;
  /** Line count of implSource. null when registry unavailable or hash not found. */
  readonly lines: number | null;
}

/** Entry in atoms.locSaved.byAtom — sorted descending by saved LOC. */
export interface LocSavedEntry {
  readonly atomHash: string;
  readonly lines: number;
  readonly hits: number;
  readonly saved: number;
}

/** The full atoms block emitted as atoms.locSaved in --json output. */
export interface LocSavedStats {
  readonly total: number;
  readonly byAtom: readonly LocSavedEntry[];
}

/**
 * The `atoms` key in `yakcc stats --json`.
 *
 * When degraded === true, the registry was unavailable; grain enrichment and
 * locSaved are absent. top is still populated (without grain/lines) from
 * telemetry alone.
 */
export interface AtomStats {
  readonly degraded: boolean;
  readonly degradedReason?: string;
  /** Top-N atoms by hit count (default 10), tie-broken by asc atomHash. */
  readonly top: readonly AtomTopEntry[];
  /** P50 over per-atom hit counts (nearest-rank). null when no hits. */
  readonly hitRateP50: number | null;
  /** P90 over per-atom hit counts (nearest-rank). null when no hits. */
  readonly hitRateP90: number | null;
  /** Distribution of atoms by registry level. Absent when degraded. */
  readonly grainHistogram?: {
    readonly L0: number;
    readonly L1: number;
    readonly L2: number;
    readonly L3: number;
    readonly unknown: number;
  };
  /** Tier-3 LoC-saved. Absent when degraded. */
  readonly locSaved?: LocSavedStats;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CollectAtomReuseOptions {
  /** Absolute path to the registry SQLite file (defaults to DEFAULT_REGISTRY_PATH). */
  readonly registryPath: string;
  /** Maximum entries in atoms.top (default 10). */
  readonly topN?: number;
}

// ---------------------------------------------------------------------------
// Percentile helper (nearest-rank, lower interpolation)
// ---------------------------------------------------------------------------

/**
 * Compute the p-th percentile (0–100) of an already-sorted ascending number array.
 * Uses nearest-rank (lower bound): index = ceil(p/100 * n) - 1.
 * Returns null for empty array.
 *
 * @decision DEC-CLI-STATS-TIER-2-001 (percentile method: nearest-rank documented here)
 */
function percentileNearest(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? null;
}

// ---------------------------------------------------------------------------
// Core Tier-2 + Tier-3 reducer
// ---------------------------------------------------------------------------

/**
 * Aggregate atom-reuse (Tier-2) and LoC-saved (Tier-3) metrics from a flat
 * list of TelemetryEvent objects.
 *
 * This is a SECOND pure reducer over TelemetryEvent[] (the same slice produced
 * by readTelemetrySessions()). It does NOT re-parse JSONL, does NOT read files,
 * and does NOT mutate the input events.
 *
 * Registry is opened lazily (only when ≥1 hit event exists) and closed before
 * returning (I-C invariant). The registry path can be injected for test
 * isolation via opts.registryPath.
 *
 * @param events   - Flat list of telemetry events (already filtered by --since).
 * @param opts     - Registry path + topN limit.
 * @returns Atom statistics block suitable for the --json atoms key.
 */
export async function collectAtomReuse(
  events: readonly TelemetryEvent[],
  opts: CollectAtomReuseOptions,
): Promise<AtomStats> {
  const topN = opts.topN ?? 10;

  // --- Step 1: filter to qualifying hit events (narrow hit definition) ---
  // Exclude: drift-alert (outcome === "drift-alert" OR candidateCount === -1),
  // passthrough, synthesis-required, intent-too-broad, result-set-too-large,
  // atom-size-too-large, shave-on-miss-*, atomized.
  // Include: outcome === "registry-hit" && substituted === true && substitutedAtomHash !== null.
  const hitEvents = events.filter(
    (e) =>
      e.outcome === "registry-hit" &&
      e.substituted === true &&
      e.substitutedAtomHash !== null &&
      // Belt-and-suspenders: also exclude drift-alert sentinel shape
      e.candidateCount !== -1,
  );

  if (hitEvents.length === 0) {
    // No qualifying hits — return zero-shaped atoms block (empty-state contract).
    return {
      degraded: false,
      top: [],
      hitRateP50: null,
      hitRateP90: null,
      grainHistogram: { L0: 0, L1: 0, L2: 0, L3: 0, unknown: 0 },
      locSaved: { total: 0, byAtom: [] },
    };
  }

  // --- Step 2: accumulate hit counts per distinct atomHash ---
  const hitMap = new Map<string, number>();
  for (const e of hitEvents) {
    const hash = e.substitutedAtomHash as string;
    hitMap.set(hash, (hitMap.get(hash) ?? 0) + 1);
  }

  // --- Step 3: build sorted hit-count array for percentile computation ---
  const hitCounts = Array.from(hitMap.values()).sort((a, b) => a - b);
  const p50 = percentileNearest(hitCounts, 50);
  const p90 = percentileNearest(hitCounts, 90);

  // --- Step 4: open registry (lazy, exactly once) ---
  let registry: Registry | null = null;
  let registryDegraded = false;
  let degradedReason: string | undefined;

  try {
    registry = await openRegistry(opts.registryPath, {
      // No embeddings needed for getBlock — pass undefined to skip embedding init.
      embeddings: undefined,
    });
  } catch (err) {
    registryDegraded = true;
    const errStr = String(err);
    // Distinguish "not found" from other errors for the degradedReason field.
    // Covers ENOENT (POSIX), "no such file" (better-sqlite3), and
    // "directory does not exist" (openRegistry pre-flight guard).
    if (
      errStr.includes("ENOENT") ||
      errStr.includes("no such file") ||
      errStr.includes("directory does not exist") ||
      errStr.includes("does not exist")
    ) {
      degradedReason = "registry-not-found";
    } else {
      degradedReason = `registry-open-error: ${errStr.slice(0, 120)}`;
    }
  }

  // --- Step 5: enrich each distinct atom with grain + LoC from registry ---
  interface EnrichedAtom {
    atomHash: string;
    hits: number;
    level: "L0" | "L1" | "L2" | "L3" | null;
    lines: number | null;
  }

  const enriched: EnrichedAtom[] = [];
  const grainHistogram = { L0: 0, L1: 0, L2: 0, L3: 0, unknown: 0 };
  let locSavedTotal = 0;
  const locSavedByAtom: LocSavedEntry[] = [];

  for (const [atomHash, hits] of hitMap) {
    let block: BlockTripletRow | null = null;

    if (registry !== null) {
      try {
        // Cast atomHash to the branded BlockMerkleRoot type. The value comes
        // from the telemetry event's substitutedAtomHash field, which is
        // written by hook-intercept.ts from the real BlockMerkleRoot at
        // substitution time — the cast is safe by construction.
        block = await registry.getBlock(atomHash as BlockMerkleRoot);
      } catch {
        // Non-fatal: treat as not found.
        block = null;
      }
    }

    const level = block?.level ?? null;
    const rawLines = block !== null ? block.implSource.split("\n").length : null;

    // Grain histogram (only when registry is available and block was found)
    if (registry !== null) {
      if (level === "L0") grainHistogram.L0++;
      else if (level === "L1") grainHistogram.L1++;
      else if (level === "L2") grainHistogram.L2++;
      else if (level === "L3") grainHistogram.L3++;
      else grainHistogram.unknown++;
    }

    // LoC-saved (Tier-3)
    if (rawLines !== null) {
      const saved = rawLines * hits;
      locSavedTotal += saved;
      locSavedByAtom.push({ atomHash, lines: rawLines, hits, saved });
    }

    enriched.push({ atomHash, hits, level, lines: rawLines });
  }

  // Close registry as soon as enrichment is done (I-C: close before returning).
  if (registry !== null) {
    try {
      await registry.close();
    } catch {
      // Non-fatal: best-effort close.
    }
  }

  // --- Step 6: produce top-N sorted by desc hits, asc atomHash tiebreak ---
  const sortedTop = enriched
    .slice()
    .sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return a.atomHash.localeCompare(b.atomHash, undefined, { sensitivity: "variant" });
    })
    .slice(0, topN)
    .map((e) => ({
      atomHash: e.atomHash,
      hits: e.hits,
      level: e.level,
      lines: e.lines,
    }));

  // Sort locSaved.byAtom descending by saved (largest savings first).
  locSavedByAtom.sort((a, b) => b.saved - a.saved);

  // --- Step 7: assemble result ---
  if (registryDegraded) {
    // Degraded: emit top without grain/lines, omit grainHistogram and locSaved.
    // exactOptionalPropertyTypes: spread degradedReason conditionally so the key
    // is absent (not present-as-undefined) when degradedReason is undefined.
    return {
      degraded: true,
      ...(degradedReason !== undefined ? { degradedReason } : {}),
      top: sortedTop.map((e) => ({ atomHash: e.atomHash, hits: e.hits, level: null, lines: null })),
      hitRateP50: p50,
      hitRateP90: p90,
    };
  }

  return {
    degraded: false,
    top: sortedTop,
    hitRateP50: p50,
    hitRateP90: p90,
    grainHistogram,
    locSaved: { total: locSavedTotal, byAtom: locSavedByAtom.slice(0, topN) },
  };
}
