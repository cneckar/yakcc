// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/matrix.mjs
//
// @decision DEC-V0-B4-MATRIX-RUNNER-001
// @title B4 Slice 2: 3-driver × 8-task × N=3 matrix cell-space definition
// @status accepted
// @rationale
//   WI-473 promotes the B4 harness from a single-driver/2-arm Slice 1 run to a
//   locked 3-driver × 8-task × N=3 matrix per DEC-V0-B4-SLICE2-MATRIX-002.
//
//   DRIVER ENUMERATION
//   Three drivers are defined verbatim as required by DEC-V0-B4-SLICE2-MATRIX-002.
//   Model IDs must NOT be changed without a DEC amendment. The short_name is used
//   as a CLI selector and as the primary key in result rows.
//
//   TIER SHAPE
//   - min: 3 drivers × 2 arms (unhooked + hooked-default) = 6 cells/task
//     → 6 × 8 tasks × 3 reps = 144 total runs
//   - full: 3 drivers × 4 arms (unhooked + 3 sweep positions) = 12 cells/task
//     → 12 × 8 tasks × 3 reps = 288 total runs
//
//   SWEEP POSITIONS
//   Sweep positions are canonicalized per DEC-V0-B4-SLICE2-MATRIX-002:
//   - conservative: confidence_threshold=0.95, substitution_aggressiveness="conservative"
//   - default:      confidence_threshold=0.70, substitution_aggressiveness="default"
//   - aggressive:   confidence_threshold=0.00, substitution_aggressiveness="aggressive"
//   In min tier, only the "default" sweep position is used for the hooked arm.
//   In full tier, all three sweep positions produce three separate hooked cells.
//
//   CELL SPACE CONTRACT
//   buildCellSpace() returns a flat array of cell descriptors. Each cell represents
//   one (driver × arm × sweep_position) combination. The harness iterates cells ×
//   tasks × reps — completing all reps for one (task × cell) before moving to the next
//   cell (forbidden shortcuts §3: no round-robin across drivers within a task rep).
//
//   CELL ID FORMAT
//   "<driver_short>:<arm>:<sweep_position>"
//   Examples: "haiku:unhooked:default", "sonnet:hooked:conservative"
//   The sweep_position for unhooked cells is always "default" (no sweep applies).
//
// Exports:
//   DRIVERS          — frozen array of driver descriptors
//   SWEEP_POSITIONS  — frozen array of sweep position configs
//   TIER_SHAPE       — object mapping tier names to cell counts
//   buildCellSpace({ tier, driverFilter? }) → Cell[]
//
// Authority: DEC-V0-B4-SLICE2-MATRIX-002 (locked). No inline amendments.

/**
 * @typedef {Object} Driver
 * @property {string} short_name - CLI alias: haiku | sonnet | opus
 * @property {string} model_id   - Exact Anthropic model identifier (verbatim per DEC-V0-B4-SLICE2-MATRIX-002)
 */

/**
 * @typedef {Object} SweepPosition
 * @property {string} name                       - canonical name: conservative | default | aggressive
 * @property {number} confidence_threshold        - MCP confidence filter threshold
 * @property {string} substitution_aggressiveness - passed to atom-lookup tool input
 */

/**
 * @typedef {Object} Cell
 * @property {string} driver         - short_name of the driver
 * @property {string} model_id       - verbatim model ID for Anthropic API
 * @property {string} arm            - "unhooked" | "hooked"
 * @property {string} sweep_position - canonical sweep position name
 * @property {number} confidence_threshold      - numeric threshold for MCP
 * @property {string} substitution_aggressiveness - aggressiveness string for MCP tool
 * @property {string} cell_id        - unique identifier: "<driver>:<arm>:<sweep_position>"
 */

// ---------------------------------------------------------------------------
// DEC-V0-B4-SLICE2-MATRIX-002: locked driver registry
// Model IDs are verbatim strings — any change requires a DEC amendment.
// ---------------------------------------------------------------------------

/** @type {Readonly<Driver[]>} */
export const DRIVERS = Object.freeze([
  { short_name: "haiku",  model_id: "claude-haiku-4-5-20251001" },
  { short_name: "sonnet", model_id: "claude-sonnet-4-6" },
  { short_name: "opus",   model_id: "claude-opus-4-7" },
]);

// ---------------------------------------------------------------------------
// DEC-V0-B4-SLICE2-MATRIX-002: locked sweep position configs
// confidence_threshold values:
//   conservative: 0.95  (only high-confidence atom substitutions)
//   default:      0.70  (standard threshold matching Slice 1 behavior)
//   aggressive:   0.00  (all atoms regardless of confidence; maximum substitution)
// ---------------------------------------------------------------------------

/** @type {Readonly<SweepPosition[]>} */
export const SWEEP_POSITIONS = Object.freeze([
  { name: "conservative", confidence_threshold: 0.95, substitution_aggressiveness: "conservative" },
  { name: "default",      confidence_threshold: 0.70, substitution_aggressiveness: "default" },
  { name: "aggressive",   confidence_threshold: 0.00, substitution_aggressiveness: "aggressive" },
]);

// ---------------------------------------------------------------------------
// Tier shape summary (cells per task × tier)
// ---------------------------------------------------------------------------

/** @type {Readonly<Record<string, number>>} */
export const TIER_SHAPE = Object.freeze({
  min:  6,   // 3 drivers × 2 arms (unhooked + hooked-default)
  full: 12,  // 3 drivers × 4 arms (unhooked + 3 sweep positions)
});

// ---------------------------------------------------------------------------
// buildCellSpace
// ---------------------------------------------------------------------------

/**
 * Build the flat cell space for a given tier and optional driver filter.
 *
 * @param {{ tier: "min"|"full", driverFilter?: "haiku"|"sonnet"|"opus"|"all" }} opts
 * @returns {Cell[]}
 * @throws {TypeError} if driverFilter is unknown
 * @throws {TypeError} if tier is unknown
 */
export function buildCellSpace({ tier, driverFilter } = {}) {
  const resolvedTier = tier ?? "min";
  if (resolvedTier !== "min" && resolvedTier !== "full") {
    throw new TypeError(`Unknown tier: "${resolvedTier}". Must be "min" or "full".`);
  }

  // Validate and resolve driver filter
  const resolved_filter = driverFilter ?? "all";
  if (resolved_filter !== "all") {
    const known = DRIVERS.map((d) => d.short_name);
    if (!known.includes(resolved_filter)) {
      throw new TypeError(
        `Unknown driver filter: "${resolved_filter}". ` +
        `Valid values: ${known.join(", ")}, all. ` +
        `Driver IDs are locked by DEC-V0-B4-SLICE2-MATRIX-002.`
      );
    }
  }

  const activeDrivers = resolved_filter === "all"
    ? DRIVERS
    : DRIVERS.filter((d) => d.short_name === resolved_filter);

  // Default sweep position (used in min tier and for unhooked arm)
  const defaultSweep = SWEEP_POSITIONS.find((p) => p.name === "default");

  /** @type {Cell[]} */
  const cells = [];

  for (const driver of activeDrivers) {
    // Unhooked arm: always present in both tiers.
    // sweep_position is "default" as a label (no sweep applies — no MCP integration).
    cells.push({
      driver: driver.short_name,
      model_id: driver.model_id,
      arm: "unhooked",
      sweep_position: "default",
      confidence_threshold: defaultSweep.confidence_threshold,
      substitution_aggressiveness: defaultSweep.substitution_aggressiveness,
      cell_id: `${driver.short_name}:unhooked:default`,
    });

    if (resolvedTier === "min") {
      // Min tier: hooked arm with default sweep position only.
      cells.push({
        driver: driver.short_name,
        model_id: driver.model_id,
        arm: "hooked",
        sweep_position: "default",
        confidence_threshold: defaultSweep.confidence_threshold,
        substitution_aggressiveness: defaultSweep.substitution_aggressiveness,
        cell_id: `${driver.short_name}:hooked:default`,
      });
    } else {
      // Full tier: hooked arm for each sweep position.
      for (const sweep of SWEEP_POSITIONS) {
        cells.push({
          driver: driver.short_name,
          model_id: driver.model_id,
          arm: "hooked",
          sweep_position: sweep.name,
          confidence_threshold: sweep.confidence_threshold,
          substitution_aggressiveness: sweep.substitution_aggressiveness,
          cell_id: `${driver.short_name}:hooked:${sweep.name}`,
        });
      }
    }
  }

  return cells;
}
