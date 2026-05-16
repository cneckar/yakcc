// SPDX-License-Identifier: MIT
// shave-on-miss-state.ts -- Persistent hot-set state for WI-508 Slice 3 skip-shave tuning.
//
// @decision DEC-WI508-S3-STATE-PERSIST-001
// title: Hot-set persisted to ~/.yakcc/shave-on-miss-state.json (env-var override)
// status: decided (WI-508 Slice 3)
// rationale:
//   Follows the YAKCC_TELEMETRY_DIR / YAKCC_SHAVE_ON_MISS_CORPUS_DIR env-var pattern.
//   Single JSON file: readable, auditable, reset-able by deleting the file.
//   Multi-process write race is accepted (per DEC-WI508-S2-IN-PROC-BACKGROUND-001: "storeBlock
//   idempotence makes cross-process duplicates safe"). State writes are synchronous (writeFileSync)
//   matching the telemetry append pattern (appendFileSync in telemetry.ts).
//
// @decision DEC-WI508-S3-KEY-FORMAT-001
// title: State keys use "${packageName}::${binding}" not entryPath
// status: decided (WI-508 Slice 3)
// rationale:
//   Binding keys are stable across corpusDir locations (different node_modules roots).
//   Hit recording from the import-intercept path knows (packageName, binding) not entryPath,
//   so a binding-level key avoids a corpusDir lookup at hit-recording time.
//
// @decision DEC-WI508-S3-SKIP-HIT-THRESHOLD-001
// title: Default SKIP_SHAVE_HIT_THRESHOLD=2; configurable via YAKCC_SKIP_SHAVE_HIT_THRESHOLD
// status: decided (WI-508 Slice 3)
// rationale:
//   N=2 means "if we've seen this binding in the registry at least twice, it is stable --
//   skip the re-shave on the next miss." The threshold is intentionally low because:
//   (a) The B4/B9 benchmarks will calibrate the exact value once sweep data is available
//       (DEC-WI508-S3-THRESHOLD-CALIBRATION-PENDING-001).
//   (b) An env-var override lets operators tune without a code change.
//   Consecutive-vs-total hit counting is an acceptable simplification for the v1 hot-set:
//   the hit count is a lower bound on "how stable is this atom in the registry." Calibration
//   may shift to a sliding window in a future slice.
//
// @decision DEC-WI508-S3-PREEMPTIVE-MISS-THRESHOLD-001
// title: Default PREEMPTIVE_SHAVE_MISS_THRESHOLD=3; configurable via YAKCC_PREEMPTIVE_SHAVE_MISS_THRESHOLD
// status: decided (WI-508 Slice 3)
// rationale:
//   N=3 means "if we've seen 3 distinct binding misses from the same package, proactively scan
//   and shave the package's entire lib/ directory." The rationale: 3 independent misses signal
//   that the package is completely absent from the registry and a whole-package shave is cheaper
//   than waiting for each binding to miss individually. The threshold is calibration-pending
//   (DEC-WI508-S3-THRESHOLD-CALIBRATION-PENDING-001). env-var override provided.
//
// @decision DEC-WI508-S3-THRESHOLD-CALIBRATION-PENDING-001
// title: SKIP_SHAVE_HIT_THRESHOLD and PREEMPTIVE_SHAVE_MISS_THRESHOLD have provisional defaults
// status: decided (WI-508 Slice 3)
// rationale:
//   Both defaults (2, 3) are provisional. The B4 token-cost sweep (#188, WI-B4-MATRIX-HARNESS-V2)
//   and B9 attack-surface benchmark (#446) are the planned data sources for calibration.
//   Once sweep data is available, a future planner pass amends these defaults and annotates
//   the calibration decision with a DEC-WI508-S3-THRESHOLD-CALIBRATION-FINAL-001.
//
// @decision DEC-WI508-S3-PREEMPTIVE-SCAN-001
// title: Preemptive shave scans corpusDir lib/ via readdirSync; dedup handled by existing queue
// status: decided (WI-508 Slice 3)
// rationale:
//   When preemptive shave fires, listPackageBindings() scans the corpus lib/ directory for
//   .js files and returns binding names (filename minus extension). applyShaveOnMiss() is then
//   called for each -- dedup (in-memory queue + completedBindings check) prevents re-shaving
//   already-completed bindings. No new dedup mechanism is needed.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, normalize } from "node:path";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

/**
 * Persistent hot-set state for skip-shave tuning (WI-508 Slice 3).
 *
 * completedBindings: set of "${packageName}::${binding}" keys that have been
 *   successfully shaved in a prior process run. On next miss for the same key,
 *   the enqueue is skipped (atom is already in the registry from a prior run).
 *
 * hitCounts: number of registry-hit events observed per binding key.
 *   When hitCounts[key] >= SKIP_SHAVE_HIT_THRESHOLD, the enqueue is skipped
 *   because the atom is demonstrably stable in the registry.
 *
 * missCounts: number of miss events observed per package name.
 *   When missCounts[packageName] >= PREEMPTIVE_SHAVE_MISS_THRESHOLD, a whole-
 *   package preemptive shave is triggered.
 */
export interface ShaveOnMissState {
  readonly version: 1;
  readonly completedBindings: readonly string[];
  readonly hitCounts: Readonly<Record<string, number>>;
  readonly missCounts: Readonly<Record<string, number>>;
}

// Mutable working copy used internally.
type MutableState = {
  version: 1;
  completedBindings: string[];
  hitCounts: Record<string, number>;
  missCounts: Record<string, number>;
};

// ---------------------------------------------------------------------------
// State path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path for the persistent shave-on-miss state file.
 * DEC-WI508-S3-STATE-PERSIST-001.
 */
export function resolveStatePath(): string {
  return (
    process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH ??
    join(homedir(), ".yakcc", "shave-on-miss-state.json")
  );
}

// ---------------------------------------------------------------------------
// Threshold resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the skip-shave hit threshold.
 * DEC-WI508-S3-SKIP-HIT-THRESHOLD-001: default 2.
 */
export function resolveSkipShaveHitThreshold(): number {
  const raw = process.env.YAKCC_SKIP_SHAVE_HIT_THRESHOLD;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 2;
}

/**
 * Resolve the preemptive shave miss threshold.
 * DEC-WI508-S3-PREEMPTIVE-MISS-THRESHOLD-001: default 3.
 */
export function resolvePreemptiveMissThreshold(): number {
  const raw = process.env.YAKCC_PREEMPTIVE_SHAVE_MISS_THRESHOLD;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 3;
}

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

function emptyState(): MutableState {
  return { version: 1, completedBindings: [], hitCounts: {}, missCounts: {} };
}

/**
 * Load the persistent state from disk.
 * Returns an empty state on any read/parse error (fail-safe: missing file is normal).
 */
export function loadShaveOnMissState(statePath?: string): ShaveOnMissState {
  const path = statePath ?? resolveStatePath();
  try {
    if (!existsSync(path)) return emptyState();
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<MutableState>;
    return {
      version: 1,
      completedBindings: Array.isArray(parsed.completedBindings) ? parsed.completedBindings : [],
      hitCounts:
        parsed.hitCounts !== null && typeof parsed.hitCounts === "object" ? parsed.hitCounts : {},
      missCounts:
        parsed.missCounts !== null && typeof parsed.missCounts === "object"
          ? parsed.missCounts
          : {},
    };
  } catch {
    return emptyState();
  }
}

/**
 * Save the persistent state to disk.
 * Creates the parent directory if needed (idempotent). Errors are swallowed to prevent
 * state persistence failures from blocking the hook path.
 * DEC-WI508-S3-STATE-PERSIST-001.
 */
export function saveShaveOnMissState(state: ShaveOnMissState, statePath?: string): void {
  const path = statePath ?? resolveStatePath();
  try {
    const dir = path.substring(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
    if (dir.length > 0 && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // State persistence failure must not block the hook path.
  }
}

// ---------------------------------------------------------------------------
// State mutation helpers
// ---------------------------------------------------------------------------

/**
 * Return a new state with the binding key added to completedBindings.
 * Key format: "${packageName}::${binding}" per DEC-WI508-S3-KEY-FORMAT-001.
 */
export function withCompletion(state: ShaveOnMissState, key: string): ShaveOnMissState {
  if (state.completedBindings.includes(key)) return state;
  return {
    ...state,
    completedBindings: [...state.completedBindings, key],
  };
}

/**
 * Return a new state with the hit count for the binding key incremented.
 */
export function withHitIncrement(state: ShaveOnMissState, key: string): ShaveOnMissState {
  const prev = state.hitCounts[key] ?? 0;
  return {
    ...state,
    hitCounts: { ...state.hitCounts, [key]: prev + 1 },
  };
}

/**
 * Return a new state with the miss count for the package incremented.
 */
export function withMissIncrement(
  state: ShaveOnMissState,
  packageName: string,
): ShaveOnMissState {
  const prev = state.missCounts[packageName] ?? 0;
  return {
    ...state,
    missCounts: { ...state.missCounts, [packageName]: prev + 1 },
  };
}

// ---------------------------------------------------------------------------
// Binding key construction
// ---------------------------------------------------------------------------

/**
 * Build the binding key for a (packageName, binding) pair.
 * DEC-WI508-S3-KEY-FORMAT-001.
 */
export function makeBindingKey(packageName: string, binding: string): string {
  return `${packageName}::${binding}`;
}

// ---------------------------------------------------------------------------
// Module-scope state cache
// ---------------------------------------------------------------------------

// Lazy-loaded once per process. Reset by _resetShaveOnMissState() in tests.
let _cachedState: ShaveOnMissState | undefined;

/**
 * Get the current in-memory state, loading from disk on first call.
 */
export function getState(): ShaveOnMissState {
  if (_cachedState === undefined) {
    _cachedState = loadShaveOnMissState();
  }
  return _cachedState;
}

/**
 * Update the in-memory state and persist to disk.
 */
export function updateState(newState: ShaveOnMissState): void {
  _cachedState = newState;
  saveShaveOnMissState(newState);
}

/** Reset the in-memory state cache. Test-only. */
export function _resetShaveOnMissState(): void {
  _cachedState = undefined;
}

// ---------------------------------------------------------------------------
// Hit recording (called from import-intercept on registry-hit)
// ---------------------------------------------------------------------------

/**
 * Record a registry hit for a (packageName, binding) pair.
 *
 * Called from applyImportIntercept() when intercepted=true for a binding.
 * Increments hitCounts[key] in the persistent state, enabling the skip-shave
 * heuristic on subsequent misses.
 *
 * DEC-WI508-S3-SKIP-HIT-THRESHOLD-001.
 *
 * @param packageName - NPM package name (e.g. "validator").
 * @param binding     - Named binding (e.g. "isEmail").
 */
export function recordImportHit(packageName: string, binding: string): void {
  try {
    const key = makeBindingKey(packageName, binding);
    const updated = withHitIncrement(getState(), key);
    updateState(updated);
  } catch {
    // Hit recording failure must not affect the hook path (observe-don't-mutate).
  }
}

// ---------------------------------------------------------------------------
// Package corpus scanning (used by preemptive shave)
// ---------------------------------------------------------------------------

/**
 * List all binding names (*.js basename without extension) in a package's corpus lib/ dir.
 *
 * Resolution order mirrors resolveEntryPath():
 *   1. {corpusDir}/{packageName}/lib/*.js  (standard node_modules layout)
 *   2. {corpusDir}/{packageName}-VERSION/lib/*.js  (versioned fixture layout; first sorted match)
 *
 * Returns an empty array when the corpus dir or lib/ is not found.
 * DEC-WI508-S3-PREEMPTIVE-SCAN-001.
 *
 * @param packageName - NPM package name.
 * @param corpusDir   - Root of the corpus (node_modules or fixture dir).
 */
export function listPackageBindings(packageName: string, corpusDir: string): string[] {
  // Attempt 1: standard layout.
  const standardLib = join(corpusDir, packageName, "lib");
  if (existsSync(standardLib)) {
    return _listJsBasenames(standardLib);
  }

  // Attempt 2: versioned fixture layout.
  let entries: string[];
  try {
    entries = readdirSync(corpusDir);
  } catch {
    return [];
  }

  const prefix = `${packageName}-`;
  const versionedDirs = entries.filter((e) => e.startsWith(prefix)).sort();

  for (const dir of versionedDirs) {
    const libDir = join(corpusDir, dir, "lib");
    if (existsSync(libDir)) {
      return _listJsBasenames(libDir);
    }
  }

  return [];
}

function _listJsBasenames(libDir: string): string[] {
  try {
    const files = readdirSync(libDir);
    return files
      .filter((f) => f.endsWith(".js") && !f.endsWith(".min.js"))
      .map((f) => basename(normalize(f), ".js"));
  } catch {
    return [];
  }
}
