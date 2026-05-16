// SPDX-License-Identifier: MIT
//
// @decision DEC-HOOK-ENF-CONFIG-001
// title: Central enforcement config module — sole authority for all layer thresholds
// status: decided (wi-590-s2-layer2; extended wi-591-s3-layer3)
// rationale:
//   User directive (#590): "make the levels for rejection etc configurable via config.
//   We want to be able to tune this to the right levels without having to rewrite code
//   each time."
//
//   This module is the SOLE source of truth for every tunable threshold across all
//   enforcement layers (L1–L6 and beyond). No layer module may hardcode a threshold.
//   All layer modules import getter(s) from this file instead.
//
//   Loading precedence (highest wins): env var → config file → defaults.
//
//   Env var mapping:
//     YAKCC_HOOK_DISABLE_INTENT_GATE="1"  → layer1.disableGate = true
//     YAKCC_ENFORCEMENT_CONFIG_PATH       → absolute path to a JSON config file
//     YAKCC_RESULT_SET_MAX                → layer2.maxConfident (integer)
//     YAKCC_RESULT_SET_MAX_OVERALL        → layer2.maxOverall (integer)
//     YAKCC_RESULT_CONFIDENT_THRESHOLD    → layer2.confidentThreshold (float)
//     YAKCC_L1_MIN_WORDS                  → layer1.minWords (integer)
//     YAKCC_L1_MAX_WORDS                  → layer1.maxWords (integer)
//     YAKCC_ATOM_OVERSIZED_RATIO          → layer3.ratioThreshold (float; matches #579 issue body naming)
//     YAKCC_HOOK_DISABLE_ATOM_SIZE_GATE   → layer3.disableGate = true
//
//   Config file: optional .yakcc/enforcement.json relative to the repo root,
//   or the path pointed to by YAKCC_ENFORCEMENT_CONFIG_PATH.
//   Invalid JSON or schema violations throw with a clear message.
//
//   Memoization: the loaded config is cached after the first call.
//   Tests can reset via setConfigOverride() / resetConfigOverride().
//
//   S4-S6 append their layer4/layer5/layer6 keys here following the same pattern.
//
//   Cross-reference: docs/enforcement-config.md, plans/wi-579-s2-layer2-result-set-size.md,
//   plans/wi-579-s3-layer3-atom-size-ratio.md

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

/**
 * Configuration for Layer 1 (intent-specificity gate).
 * Defaults match the prior hardcoded constants in intent-specificity.ts exactly
 * so S1 behavior is preserved with zero semantic change when no config is present.
 */
export interface Layer1Config {
  /** Minimum number of whitespace-tokenized words an intent must have. Default: 4. */
  readonly minWords: number;
  /** Maximum number of whitespace-tokenized words an intent may have. Default: 20. */
  readonly maxWords: number;
  /**
   * Stop-words that signal a generic, non-specific intent.
   * Default: the 10 canonical words from #579.
   */
  readonly stopWords: readonly string[];
  /**
   * Meta-words that signal vague, catch-all intent framing.
   * Default: the 8 canonical words from #579.
   */
  readonly metaWords: readonly string[];
  /**
   * Curated set of action verbs. An intent must contain at least one token
   * matching an entry here (case-insensitive after lowercasing) to pass the
   * action-verb check.
   * Default: the full verb list from intent-specificity.ts.
   */
  readonly actionVerbs: readonly string[];
  /**
   * When true, the Layer 1 intent-specificity gate is disabled entirely.
   * Equivalent to setting YAKCC_HOOK_DISABLE_INTENT_GATE=1.
   * Default: false.
   */
  readonly disableGate: boolean;
}

/**
 * Configuration for Layer 3 (atom-size ratio enforcement at substitution time).
 *
 * @decision DEC-HOOK-ENF-LAYER3-RATIO-THRESHOLD-001
 * title: ratioThreshold default 10 matches #579 issue body "10x" spec
 * status: decided (wi-591-s3-layer3)
 * rationale:
 *   The parent issue body explicitly calls out "10x" as the target ratio above which
 *   an atom is considered oversized for an immediate need. Setting the default to 10
 *   reproduces the spec intent without any file config present.
 *
 * @decision DEC-HOOK-ENF-LAYER3-MIN-FLOOR-001
 * title: minFloor default 20 — small atoms skip ratio check entirely
 * status: decided (wi-591-s3-layer3)
 * rationale:
 *   An atom with fewer than 20 complexity points is so small that any ratio check
 *   would produce false positives (a pure 3-line function has atomComplexity ≈ 3;
 *   ratio vs needComplexity=1 is always 3 — clearly not "oversized"). The floor
 *   prevents spurious rejections on micro-atoms while keeping the gate meaningful
 *   for substantial library-scale atoms (lodash-shaped, joi-shaped, etc.).
 */
export interface Layer3Config {
  /**
   * Maximum allowed ratio of atomComplexity / needComplexity before the gate fires.
   * Default: 10 (DEC-HOOK-ENF-LAYER3-RATIO-THRESHOLD-001).
   * Env: YAKCC_ATOM_OVERSIZED_RATIO
   */
  readonly ratioThreshold: number;
  /**
   * Atoms with atomComplexity strictly below this floor skip the ratio check entirely.
   * Default: 20 (DEC-HOOK-ENF-LAYER3-MIN-FLOOR-001).
   */
  readonly minFloor: number;
  /**
   * When true, the Layer 3 atom-size ratio gate is disabled entirely.
   * Equivalent to YAKCC_HOOK_DISABLE_ATOM_SIZE_GATE=1.
   * Default: false.
   */
  readonly disableGate: boolean;
}

/**
 * Configuration for Layer 2 (result-set size enforcement).
 */
export interface Layer2Config {
  /**
   * Maximum number of confident candidates (combinedScore >= confidentThreshold)
   * allowed in a result set before the gate fires.
   * Default: 3.
   */
  readonly maxConfident: number;
  /**
   * Maximum total candidates allowed regardless of score.
   * Default: 10.
   */
  readonly maxOverall: number;
  /**
   * Score band cutoff: candidates with combinedScore >= this value are counted
   * as "confident" for the maxConfident check.
   * Default: 0.70 (matches CONFIDENT_THRESHOLD from yakcc-resolve.ts).
   */
  readonly confidentThreshold: number;
}

/**
 * Configuration for Layer 5 (telemetry-driven drift detection — per-session rolling window).
 *
 * Layer 5 wraps captureTelemetry non-invasively and maintains an in-memory rolling
 * window of the last N telemetry events per session. When aggregated metrics cross
 * any configured threshold, a "drift-alert" telemetry event is emitted additively.
 * The wrapping is transparent to existing callers — no blocking, no semantic change.
 *
 * @decision DEC-HOOK-ENF-LAYER5-DRIFT-DETECTION-001
 * title: Layer 5 drift detector — rolling-window aggregation of L1-L4 signals
 * status: decided (wi-593-s5-layer5)
 * rationale:
 *   Five threshold dimensions aggregate the per-event signals from Layers 1-4:
 *   (1) specificityFloor: mean L1 specificity score below floor → LLM is drifting
 *       toward vague intents over the window. Default 0.55.
 *   (2) descentBypassMax: fraction of events that were descent-bypass warnings above
 *       max → LLM is skipping the required descent discipline. Default 0.40 (40%).
 *   (3) resultSetMedianMax: median result-set size above max → LLM is using queries
 *       too broad to produce focused results. Default 5.
 *   (4) ratioMedianMax: median atom/need ratio above max → LLM is over-substituting
 *       large atoms for simple call sites. Default 4.
 *   All five keys are mandatory in EnforcementConfig.layer5. No threshold may be
 *   hardcoded in drift-detector.ts — config is the sole authority per DEC-HOOK-ENF-CONFIG-001.
 *
 *   Env var mapping:
 *     YAKCC_DRIFT_ROLLING_WINDOW       → layer5.rollingWindow (integer)
 *     YAKCC_DRIFT_SPECIFICITY_FLOOR    → layer5.specificityFloor (float)
 *     YAKCC_DRIFT_DESCENT_BYPASS_MAX   → layer5.descentBypassMax (float)
 *     YAKCC_DRIFT_RESULT_SET_MEDIAN_MAX → layer5.resultSetMedianMax (integer)
 *     YAKCC_DRIFT_RATIO_MEDIAN_MAX     → layer5.ratioMedianMax (float)
 *     YAKCC_HOOK_DISABLE_DRIFT_DETECTION=1 → layer5.disableDetection = true
 *
 * @decision DEC-HOOK-ENF-LAYER5-WINDOW-001
 * title: rollingWindow default 20 — last 20 events is the analysis unit
 * status: decided (wi-593-s5-layer5)
 * rationale:
 *   20 events is large enough to smooth single-event noise but small enough to
 *   remain reactive to genuine session-level drift. Matches the bench corpus size
 *   and the B5-coherence benchmark sweep unit from #579 acceptance criteria.
 *
 * @decision DEC-HOOK-ENF-LAYER5-SPECIFICITY-FLOOR-001
 * title: specificityFloor default 0.55 — below this mean score indicates L1 drift
 * status: decided (wi-593-s5-layer5)
 * rationale:
 *   0.55 is calibrated to the midpoint of the accept-zone specificity scores from
 *   the L1 corpus (L1-004..L1-007 have scores in [0.6, 0.9]). A window mean below
 *   0.55 indicates the LLM is consistently producing marginal-quality intents.
 *
 * @decision DEC-HOOK-ENF-LAYER5-DESCENT-MAX-001
 * title: descentBypassMax default 0.40 — above 40% descent-bypass rate triggers alert
 * status: decided (wi-593-s5-layer5)
 * rationale:
 *   40% is derived from the Layer 4 design: if more than 2 in 5 substitutions in the
 *   window carry descent-bypass warnings, the LLM is systematically skipping the
 *   descent-and-compose discipline. Below 40% the warnings are incidental.
 *
 * @decision DEC-HOOK-ENF-LAYER5-RESULT-MAX-001
 * title: resultSetMedianMax default 5 — above median 5 candidates indicates over-broad queries
 * status: decided (wi-593-s5-layer5)
 * rationale:
 *   The Layer 2 gate rejects at confidentCount > 3 (default). A median result-set size
 *   of 5 over the window means the LLM is consistently reaching the gate boundary.
 *   Above 5 the query patterns are persistently too broad.
 *
 * @decision DEC-HOOK-ENF-LAYER5-RATIO-MAX-001
 * title: ratioMedianMax default 4 — above median ratio 4 indicates over-substitution pattern
 * status: decided (wi-593-s5-layer5)
 * rationale:
 *   The Layer 3 hard reject is at ratio > 10 (default ratioThreshold). A median ratio
 *   of 4 over the window is well below the hard reject but above "tightly matched"
 *   (ratio ~1). Above 4 the LLM is consistently choosing atoms that are larger than
 *   the call-site needs, even when individual substitutions pass the hard gate.
 */
export interface Layer5Config {
  /**
   * Number of events in the per-session rolling window.
   * Default: 20 (DEC-HOOK-ENF-LAYER5-WINDOW-001).
   * Env: YAKCC_DRIFT_ROLLING_WINDOW
   */
  readonly rollingWindow: number;
  /**
   * Mean Layer 1 specificity score floor across the window.
   * When the mean falls below this value a drift-alert is emitted.
   * Default: 0.55 (DEC-HOOK-ENF-LAYER5-SPECIFICITY-FLOOR-001).
   * Env: YAKCC_DRIFT_SPECIFICITY_FLOOR
   */
  readonly specificityFloor: number;
  /**
   * Maximum fraction of events that may carry a descent-bypass-warning outcome
   * before an alert fires. Range [0, 1].
   * Default: 0.40 (DEC-HOOK-ENF-LAYER5-DESCENT-MAX-001).
   * Env: YAKCC_DRIFT_DESCENT_BYPASS_MAX
   */
  readonly descentBypassMax: number;
  /**
   * Maximum median result-set size (candidateCount) over the window.
   * Default: 5 (DEC-HOOK-ENF-LAYER5-RESULT-MAX-001).
   * Env: YAKCC_DRIFT_RESULT_SET_MEDIAN_MAX
   */
  readonly resultSetMedianMax: number;
  /**
   * Maximum median atom/need ratio over the window.
   * Only events that carry a ratio (Layer 3 events) contribute.
   * Default: 4 (DEC-HOOK-ENF-LAYER5-RATIO-MAX-001).
   * Env: YAKCC_DRIFT_RATIO_MEDIAN_MAX
   */
  readonly ratioMedianMax: number;
  /**
   * When true, drift detection is disabled entirely. No alerts are emitted.
   * Default: false.
   * Env: YAKCC_HOOK_DISABLE_DRIFT_DETECTION=1
   */
  readonly disableDetection: boolean;
}

/**
 * Configuration for Layer 4 (descent-depth tracker — advisory, non-blocking).
 *
 * Layer 4 tracks how many times a (packageName, binding) pair has been missed
 * before a hit. When a substitution is attempted with fewer than minDepth prior
 * misses AND the intent does not match any shallow-allow pattern, a
 * DescentBypassWarning is attached to the SubstitutionResult. The substitution
 * still proceeds — Layer 4 is advisory only (DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001).
 *
 * @decision DEC-HOOK-ENF-LAYER4-MIN-DEPTH-001
 * title: minDepth default 2 — at least 2 misses required before substitution is "warm"
 * status: decided (wi-592-s4-layer4)
 * rationale:
 *   Two prior misses signal that the LLM tried the binding at least twice and the
 *   registry could not satisfy it. A substitution at depth 0 or 1 means the agent
 *   jumped straight to compose/substitute without adequately exploring the descent
 *   path. minDepth=2 is the minimum "warm" threshold — calibration-pending on B4/B9
 *   sweep data exactly as per the shave-on-miss thresholds in DEC-WI508-S3-THRESHOLD-CALIBRATION-PENDING-001.
 *   Env: YAKCC_DESCENT_MIN_DEPTH
 *
 * @decision DEC-HOOK-ENF-LAYER4-SHALLOW-ALLOW-001
 * title: shallowAllowPatterns bootstrap with arithmetic primitives
 * status: decided (wi-592-s4-layer4)
 * rationale:
 *   Primitive operations (add, sub, mul, div, mod, abs, min, max, clamp, lerp) are
 *   so small and unambiguous that no descent exploration is needed before substituting.
 *   These are the canonical "depth-0 is fine" cases. The list is intentionally short;
 *   future slices can expand it as the registry matures.
 *   Env: (no env override; config file only for list control)
 */
export interface Layer4Config {
  /**
   * Minimum number of prior misses for a binding before substitution is considered
   * "warmed-up". When descent depth (miss count) < minDepth and the intent does not
   * match any shallowAllowPattern, a DescentBypassWarning is attached.
   * Default: 2 (DEC-HOOK-ENF-LAYER4-MIN-DEPTH-001).
   * Env: YAKCC_DESCENT_MIN_DEPTH
   */
  readonly minDepth: number;
  /**
   * Regex patterns (case-insensitive) matching binding names that are allowed to
   * substitute at any depth without a warning. Primitives like "add", "sub", etc.
   * Default: ["^add$", "^sub$", "^mul$", "^div$", "^mod$", "^abs$", "^min$", "^max$", "^clamp$", "^lerp$"]
   * (DEC-HOOK-ENF-LAYER4-SHALLOW-ALLOW-001).
   */
  readonly shallowAllowPatterns: readonly string[];
  /**
   * When true, descent tracking is disabled entirely (no warnings emitted).
   * Equivalent to YAKCC_HOOK_DISABLE_DESCENT_TRACKING=1.
   * Default: false.
   */
  readonly disableTracking: boolean;
}

/**
 * Central enforcement configuration shape.
 *
 * S6 implementers: append layer6 key here following the same pattern.
 * Do NOT add thresholds to layer modules directly.
 *
 * @decision DEC-HOOK-ENF-CONFIG-001
 */
export interface EnforcementConfig {
  readonly layer1: Layer1Config;
  readonly layer2: Layer2Config;
  readonly layer3: Layer3Config;
  readonly layer4: Layer4Config;
  readonly layer5: Layer5Config;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default stop-words (matches the prior hardcoded set in intent-specificity.ts exactly).
 * Preserving this list here ensures S1 defaults are reproduced correctly.
 */
const DEFAULT_STOP_WORDS: readonly string[] = [
  "things",
  "stuff",
  "utility",
  "helper",
  "manager",
  "handler",
  "service",
  "system",
  "processor",
  "worker",
];

/**
 * Default meta-words (matches the prior hardcoded set in intent-specificity.ts exactly).
 */
const DEFAULT_META_WORDS: readonly string[] = [
  "various",
  "general",
  "common",
  "some",
  "any",
  "several",
  "misc",
  "generic",
];

/**
 * Default action verbs (matches the prior hardcoded set in intent-specificity.ts exactly).
 */
const DEFAULT_ACTION_VERBS: readonly string[] = [
  "parse",
  "validate",
  "encode",
  "decode",
  "hash",
  "compare",
  "split",
  "join",
  "filter",
  "map",
  "reduce",
  "sort",
  "find",
  "match",
  "extract",
  "convert",
  "serialize",
  "deserialize",
  "normalize",
  "sanitize",
  "format",
  "render",
  "build",
  "emit",
  "read",
  "write",
  "append",
  "prepend",
  "trim",
  "pad",
  "slice",
  "chunk",
  "flatten",
  "merge",
  "diff",
  "patch",
  "compress",
  "decompress",
  "encrypt",
  "decrypt",
  "sign",
  "verify",
  "generate",
  "create",
  "delete",
  "update",
  "insert",
  "select",
  "query",
  "scan",
  "index",
  "tokenize",
  "lex",
  "compile",
  "transpile",
  "transform",
  "project",
  "fold",
  "unfold",
  "group",
  "partition",
  "zip",
  "unzip",
  "pack",
  "unpack",
  "escape",
  "unescape",
  "quote",
  "unquote",
  "wrap",
  "unwrap",
  "resolve",
  "reject",
  "retry",
  "throttle",
  "debounce",
  "batch",
  "stream",
  "pipe",
  "fork",
  "collect",
  "drain",
  "flush",
  "reset",
  "clamp",
  "lerp",
  "round",
  "truncate",
  "abs",
  "sum",
  "count",
  "measure",
];

/**
 * Return the canonical default EnforcementConfig.
 *
 * Defaults reproduce the prior hardcoded constants from intent-specificity.ts
 * exactly so there is zero semantic change when no config file or env vars are
 * present.
 *
 * @decision DEC-HOOK-ENF-CONFIG-001
 */
/**
 * Default shallow-allow patterns (DEC-HOOK-ENF-LAYER4-SHALLOW-ALLOW-001).
 * Primitives that are always safe to substitute at depth 0 — no descent needed.
 */
const DEFAULT_SHALLOW_ALLOW_PATTERNS: readonly string[] = [
  "^add$",
  "^sub$",
  "^mul$",
  "^div$",
  "^mod$",
  "^abs$",
  "^min$",
  "^max$",
  "^clamp$",
  "^lerp$",
];

export function getDefaults(): EnforcementConfig {
  return {
    layer1: {
      minWords: 4,
      maxWords: 20,
      stopWords: DEFAULT_STOP_WORDS,
      metaWords: DEFAULT_META_WORDS,
      actionVerbs: DEFAULT_ACTION_VERBS,
      disableGate: false,
    },
    layer2: {
      maxConfident: 3,
      maxOverall: 10,
      confidentThreshold: 0.7,
    },
    layer3: {
      ratioThreshold: 10,
      minFloor: 20,
      disableGate: false,
    },
    layer4: {
      minDepth: 2,
      shallowAllowPatterns: DEFAULT_SHALLOW_ALLOW_PATTERNS,
      disableTracking: false,
    },
    layer5: {
      rollingWindow: 20,
      specificityFloor: 0.55,
      descentBypassMax: 0.40,
      resultSetMedianMax: 5,
      ratioMedianMax: 4,
      disableDetection: false,
    },
  };
}

// ---------------------------------------------------------------------------
// File-based config loading
// ---------------------------------------------------------------------------

/**
 * Partial config shape accepted in the JSON config file.
 * Both layer1 and layer2 sub-objects are optional; unset fields fall back to
 * the corresponding default value. This allows tuning a single threshold without
 * having to specify the entire schema.
 */
interface PartialEnforcementConfigFile {
  layer1?: Partial<{
    minWords: number;
    maxWords: number;
    stopWords: string[];
    metaWords: string[];
    actionVerbs: string[];
    disableGate: boolean;
  }>;
  layer2?: Partial<{
    maxConfident: number;
    maxOverall: number;
    confidentThreshold: number;
  }>;
  layer3?: Partial<{
    ratioThreshold: number;
    minFloor: number;
    disableGate: boolean;
  }>;
  layer4?: Partial<{
    minDepth: number;
    shallowAllowPatterns: string[];
    disableTracking: boolean;
  }>;
  layer5?: Partial<{
    rollingWindow: number;
    specificityFloor: number;
    descentBypassMax: number;
    resultSetMedianMax: number;
    ratioMedianMax: number;
    disableDetection: boolean;
  }>;
}

/**
 * Validate that a parsed config file object has acceptable types for all
 * provided fields. Throws TypeError with a descriptive message on any violation.
 *
 * @internal
 */
function validateConfigFile(raw: unknown, filePath: string): PartialEnforcementConfigFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(
      `enforcement-config: "${filePath}" must be a JSON object, got ${Array.isArray(raw) ? "array" : typeof raw}`,
    );
  }
  const obj = raw as Record<string, unknown>;

  // Validate layer1 block
  if ("layer1" in obj && obj.layer1 !== undefined) {
    const l1 = obj.layer1;
    if (typeof l1 !== "object" || l1 === null || Array.isArray(l1)) {
      throw new TypeError(`enforcement-config: "${filePath}" layer1 must be an object`);
    }
    const l1obj = l1 as Record<string, unknown>;
    for (const key of ["minWords", "maxWords"] as const) {
      if (key in l1obj && typeof l1obj[key] !== "number") {
        throw new TypeError(`enforcement-config: "${filePath}" layer1.${key} must be a number`);
      }
      if (key in l1obj && !Number.isInteger(l1obj[key])) {
        throw new TypeError(`enforcement-config: "${filePath}" layer1.${key} must be an integer`);
      }
    }
    for (const key of ["stopWords", "metaWords", "actionVerbs"] as const) {
      if (key in l1obj) {
        if (!Array.isArray(l1obj[key])) {
          throw new TypeError(
            `enforcement-config: "${filePath}" layer1.${key} must be an array of strings`,
          );
        }
        for (const item of l1obj[key] as unknown[]) {
          if (typeof item !== "string") {
            throw new TypeError(
              `enforcement-config: "${filePath}" layer1.${key} must contain only strings`,
            );
          }
        }
      }
    }
    if ("disableGate" in l1obj && typeof l1obj.disableGate !== "boolean") {
      throw new TypeError(`enforcement-config: "${filePath}" layer1.disableGate must be a boolean`);
    }
  }

  // Validate layer2 block
  if ("layer2" in obj && obj.layer2 !== undefined) {
    const l2 = obj.layer2;
    if (typeof l2 !== "object" || l2 === null || Array.isArray(l2)) {
      throw new TypeError(`enforcement-config: "${filePath}" layer2 must be an object`);
    }
    const l2obj = l2 as Record<string, unknown>;
    for (const key of ["maxConfident", "maxOverall"] as const) {
      if (key in l2obj) {
        if (typeof l2obj[key] !== "number") {
          throw new TypeError(`enforcement-config: "${filePath}" layer2.${key} must be a number`);
        }
        if (!Number.isInteger(l2obj[key])) {
          throw new TypeError(`enforcement-config: "${filePath}" layer2.${key} must be an integer`);
        }
      }
    }
    if ("confidentThreshold" in l2obj) {
      if (typeof l2obj.confidentThreshold !== "number") {
        throw new TypeError(
          `enforcement-config: "${filePath}" layer2.confidentThreshold must be a number`,
        );
      }
      if ((l2obj.confidentThreshold as number) < 0 || (l2obj.confidentThreshold as number) > 1) {
        throw new TypeError(
          `enforcement-config: "${filePath}" layer2.confidentThreshold must be in [0, 1]`,
        );
      }
    }
  }

  // Validate layer3 block
  if ("layer3" in obj && obj.layer3 !== undefined) {
    const l3 = obj.layer3;
    if (typeof l3 !== "object" || l3 === null || Array.isArray(l3)) {
      throw new TypeError(`enforcement-config: "${filePath}" layer3 must be an object`);
    }
    const l3obj = l3 as Record<string, unknown>;
    for (const key of ["ratioThreshold", "minFloor"] as const) {
      if (key in l3obj && typeof l3obj[key] !== "number") {
        throw new TypeError(`enforcement-config: "${filePath}" layer3.${key} must be a number`);
      }
      if (key in l3obj && (l3obj[key] as number) <= 0) {
        throw new TypeError(`enforcement-config: "${filePath}" layer3.${key} must be positive`);
      }
    }
    if ("disableGate" in l3obj && typeof l3obj.disableGate !== "boolean") {
      throw new TypeError(`enforcement-config: "${filePath}" layer3.disableGate must be a boolean`);
    }
  }

  // Validate layer4 block
  if ("layer4" in obj && obj.layer4 !== undefined) {
    const l4 = obj.layer4;
    if (typeof l4 !== "object" || l4 === null || Array.isArray(l4)) {
      throw new TypeError(`enforcement-config: "${filePath}" layer4 must be an object`);
    }
    const l4obj = l4 as Record<string, unknown>;
    if ("minDepth" in l4obj) {
      if (typeof l4obj.minDepth !== "number") {
        throw new TypeError(`enforcement-config: "${filePath}" layer4.minDepth must be a number`);
      }
      if (!Number.isInteger(l4obj.minDepth)) {
        throw new TypeError(`enforcement-config: "${filePath}" layer4.minDepth must be an integer`);
      }
      if ((l4obj.minDepth as number) < 0) {
        throw new TypeError(`enforcement-config: "${filePath}" layer4.minDepth must be >= 0`);
      }
    }
    if ("shallowAllowPatterns" in l4obj) {
      if (!Array.isArray(l4obj.shallowAllowPatterns)) {
        throw new TypeError(
          `enforcement-config: "${filePath}" layer4.shallowAllowPatterns must be an array of strings`,
        );
      }
      for (const item of l4obj.shallowAllowPatterns as unknown[]) {
        if (typeof item !== "string") {
          throw new TypeError(
            `enforcement-config: "${filePath}" layer4.shallowAllowPatterns must contain only strings`,
          );
        }
      }
    }
    if ("disableTracking" in l4obj && typeof l4obj.disableTracking !== "boolean") {
      throw new TypeError(
        `enforcement-config: "${filePath}" layer4.disableTracking must be a boolean`,
      );
    }
  }

  // Validate layer5 block
  if ("layer5" in obj && obj.layer5 !== undefined) {
    const l5 = obj.layer5;
    if (typeof l5 !== "object" || l5 === null || Array.isArray(l5)) {
      throw new TypeError(`enforcement-config: "${filePath}" layer5 must be an object`);
    }
    const l5obj = l5 as Record<string, unknown>;
    if ("rollingWindow" in l5obj) {
      if (typeof l5obj.rollingWindow !== "number") {
        throw new TypeError(`enforcement-config: "${filePath}" layer5.rollingWindow must be a number`);
      }
      if (!Number.isInteger(l5obj.rollingWindow)) {
        throw new TypeError(`enforcement-config: "${filePath}" layer5.rollingWindow must be an integer`);
      }
      if ((l5obj.rollingWindow as number) < 1) {
        throw new TypeError(`enforcement-config: "${filePath}" layer5.rollingWindow must be >= 1`);
      }
    }
    for (const key of ["specificityFloor", "descentBypassMax", "ratioMedianMax"] as const) {
      if (key in l5obj) {
        if (typeof l5obj[key] !== "number") {
          throw new TypeError(`enforcement-config: "${filePath}" layer5.${key} must be a number`);
        }
        if ((l5obj[key] as number) < 0) {
          throw new TypeError(`enforcement-config: "${filePath}" layer5.${key} must be >= 0`);
        }
      }
    }
    if ("resultSetMedianMax" in l5obj) {
      if (typeof l5obj.resultSetMedianMax !== "number") {
        throw new TypeError(`enforcement-config: "${filePath}" layer5.resultSetMedianMax must be a number`);
      }
      if (!Number.isInteger(l5obj.resultSetMedianMax)) {
        throw new TypeError(`enforcement-config: "${filePath}" layer5.resultSetMedianMax must be an integer`);
      }
      if ((l5obj.resultSetMedianMax as number) < 1) {
        throw new TypeError(`enforcement-config: "${filePath}" layer5.resultSetMedianMax must be >= 1`);
      }
    }
    if ("disableDetection" in l5obj && typeof l5obj.disableDetection !== "boolean") {
      throw new TypeError(
        `enforcement-config: "${filePath}" layer5.disableDetection must be a boolean`,
      );
    }
  }

  return raw as PartialEnforcementConfigFile;
}

/**
 * Load config from a JSON file at the given path and merge into defaults.
 * Throws on invalid JSON or schema violations.
 *
 * @internal
 */
function loadFromFile(filePath: string, defaults: EnforcementConfig): EnforcementConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File does not exist — use defaults silently.
      return defaults;
    }
    throw new Error(`enforcement-config: failed to parse "${filePath}": ${(err as Error).message}`);
  }

  const partial = validateConfigFile(raw, filePath);

  return {
    layer1: {
      ...defaults.layer1,
      ...partial.layer1,
    },
    layer2: {
      ...defaults.layer2,
      ...partial.layer2,
    },
    layer3: {
      ...defaults.layer3,
      ...partial.layer3,
    },
    layer4: {
      ...defaults.layer4,
      ...partial.layer4,
    },
    layer5: {
      ...defaults.layer5,
      ...partial.layer5,
    },
  };
}

// ---------------------------------------------------------------------------
// Env-var overrides
// ---------------------------------------------------------------------------

/**
 * Apply env-var overrides on top of a merged config.
 * Env vars have the highest precedence (above file, above defaults).
 *
 * Mapping:
 *   YAKCC_HOOK_DISABLE_INTENT_GATE=1   → layer1.disableGate = true
 *   YAKCC_L1_MIN_WORDS=<int>           → layer1.minWords
 *   YAKCC_L1_MAX_WORDS=<int>           → layer1.maxWords
 *   YAKCC_RESULT_SET_MAX=<int>         → layer2.maxConfident
 *   YAKCC_RESULT_SET_MAX_OVERALL=<int> → layer2.maxOverall
 *   YAKCC_RESULT_CONFIDENT_THRESHOLD=<float> → layer2.confidentThreshold
 *   YAKCC_DESCENT_MIN_DEPTH=<int>      → layer4.minDepth
 *   YAKCC_HOOK_DISABLE_DESCENT_TRACKING=1 → layer4.disableTracking = true
 *
 * @internal
 */
function applyEnvOverrides(config: EnforcementConfig, env: NodeJS.ProcessEnv): EnforcementConfig {
  let layer1 = { ...config.layer1 };
  let layer2 = { ...config.layer2 };
  let layer3 = { ...config.layer3 };
  let layer4 = { ...config.layer4 };
  let layer5 = { ...config.layer5 };
  let l1Changed = false;
  let l2Changed = false;
  let l3Changed = false;
  let l4Changed = false;
  let l5Changed = false;

  // layer1 overrides
  if (env.YAKCC_HOOK_DISABLE_INTENT_GATE === "1") {
    layer1 = { ...layer1, disableGate: true };
    l1Changed = true;
  }
  if (env.YAKCC_L1_MIN_WORDS !== undefined) {
    const v = Number.parseInt(env.YAKCC_L1_MIN_WORDS, 10);
    if (!Number.isNaN(v)) {
      layer1 = { ...layer1, minWords: v };
      l1Changed = true;
    }
  }
  if (env.YAKCC_L1_MAX_WORDS !== undefined) {
    const v = Number.parseInt(env.YAKCC_L1_MAX_WORDS, 10);
    if (!Number.isNaN(v)) {
      layer1 = { ...layer1, maxWords: v };
      l1Changed = true;
    }
  }

  // layer2 overrides
  if (env.YAKCC_RESULT_SET_MAX !== undefined) {
    const v = Number.parseInt(env.YAKCC_RESULT_SET_MAX, 10);
    if (!Number.isNaN(v)) {
      layer2 = { ...layer2, maxConfident: v };
      l2Changed = true;
    }
  }
  if (env.YAKCC_RESULT_SET_MAX_OVERALL !== undefined) {
    const v = Number.parseInt(env.YAKCC_RESULT_SET_MAX_OVERALL, 10);
    if (!Number.isNaN(v)) {
      layer2 = { ...layer2, maxOverall: v };
      l2Changed = true;
    }
  }
  if (env.YAKCC_RESULT_CONFIDENT_THRESHOLD !== undefined) {
    const v = Number.parseFloat(env.YAKCC_RESULT_CONFIDENT_THRESHOLD);
    if (!Number.isNaN(v) && v >= 0 && v <= 1) {
      layer2 = { ...layer2, confidentThreshold: v };
      l2Changed = true;
    }
  }

  // layer3 overrides
  if (env.YAKCC_ATOM_OVERSIZED_RATIO !== undefined) {
    const v = Number.parseFloat(env.YAKCC_ATOM_OVERSIZED_RATIO);
    if (!Number.isNaN(v) && v > 0) {
      layer3 = { ...layer3, ratioThreshold: v };
      l3Changed = true;
    }
  }
  if (env.YAKCC_HOOK_DISABLE_ATOM_SIZE_GATE === "1") {
    layer3 = { ...layer3, disableGate: true };
    l3Changed = true;
  }

  // layer4 overrides
  if (env.YAKCC_DESCENT_MIN_DEPTH !== undefined) {
    const v = Number.parseInt(env.YAKCC_DESCENT_MIN_DEPTH, 10);
    if (!Number.isNaN(v) && v >= 0) {
      layer4 = { ...layer4, minDepth: v };
      l4Changed = true;
    }
  }
  if (env.YAKCC_HOOK_DISABLE_DESCENT_TRACKING === "1") {
    layer4 = { ...layer4, disableTracking: true };
    l4Changed = true;
  }

  // layer5 overrides
  if (env.YAKCC_DRIFT_ROLLING_WINDOW !== undefined) {
    const v = Number.parseInt(env.YAKCC_DRIFT_ROLLING_WINDOW, 10);
    if (!Number.isNaN(v) && v >= 1) {
      layer5 = { ...layer5, rollingWindow: v };
      l5Changed = true;
    }
  }
  if (env.YAKCC_DRIFT_SPECIFICITY_FLOOR !== undefined) {
    const v = Number.parseFloat(env.YAKCC_DRIFT_SPECIFICITY_FLOOR);
    if (!Number.isNaN(v) && v >= 0) {
      layer5 = { ...layer5, specificityFloor: v };
      l5Changed = true;
    }
  }
  if (env.YAKCC_DRIFT_DESCENT_BYPASS_MAX !== undefined) {
    const v = Number.parseFloat(env.YAKCC_DRIFT_DESCENT_BYPASS_MAX);
    if (!Number.isNaN(v) && v >= 0 && v <= 1) {
      layer5 = { ...layer5, descentBypassMax: v };
      l5Changed = true;
    }
  }
  if (env.YAKCC_DRIFT_RESULT_SET_MEDIAN_MAX !== undefined) {
    const v = Number.parseInt(env.YAKCC_DRIFT_RESULT_SET_MEDIAN_MAX, 10);
    if (!Number.isNaN(v) && v >= 1) {
      layer5 = { ...layer5, resultSetMedianMax: v };
      l5Changed = true;
    }
  }
  if (env.YAKCC_DRIFT_RATIO_MEDIAN_MAX !== undefined) {
    const v = Number.parseFloat(env.YAKCC_DRIFT_RATIO_MEDIAN_MAX);
    if (!Number.isNaN(v) && v >= 0) {
      layer5 = { ...layer5, ratioMedianMax: v };
      l5Changed = true;
    }
  }
  if (env.YAKCC_HOOK_DISABLE_DRIFT_DETECTION === "1") {
    layer5 = { ...layer5, disableDetection: true };
    l5Changed = true;
  }

  if (!l1Changed && !l2Changed && !l3Changed && !l4Changed && !l5Changed) return config;

  return {
    layer1: l1Changed ? layer1 : config.layer1,
    layer2: l2Changed ? layer2 : config.layer2,
    layer3: l3Changed ? layer3 : config.layer3,
    layer4: l4Changed ? layer4 : config.layer4,
    layer5: l5Changed ? layer5 : config.layer5,
  };
}

// ---------------------------------------------------------------------------
// Config file path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the enforcement config file path.
 *
 * Priority:
 * 1. YAKCC_ENFORCEMENT_CONFIG_PATH env var (absolute path)
 * 2. .yakcc/enforcement.json relative to process.cwd()
 *
 * Returns null when neither exists. Does NOT throw for missing files.
 *
 * @internal
 */
function resolveConfigFilePath(env: NodeJS.ProcessEnv): string | null {
  if (env.YAKCC_ENFORCEMENT_CONFIG_PATH !== undefined) {
    return env.YAKCC_ENFORCEMENT_CONFIG_PATH;
  }
  const candidate = join(process.cwd(), ".yakcc", "enforcement.json");
  if (existsSync(candidate)) {
    return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Memoization + override mechanism for tests
// ---------------------------------------------------------------------------

/** Cached config after first successful load. Null = not yet loaded. */
let _cachedConfig: EnforcementConfig | null = null;

/** Explicit override (test hook). When set, overrides the cached config. */
let _configOverride: EnforcementConfig | null = null;

/**
 * Override the enforcement config for the current process.
 * Used by tests to inject controlled configs without env/file gymnastics.
 *
 * Call resetConfigOverride() in afterEach to restore normal loading.
 *
 * @example
 * setConfigOverride({ ...getDefaults(), layer2: { maxConfident: 1, maxOverall: 3, confidentThreshold: 0.70 } });
 */
export function setConfigOverride(config: EnforcementConfig): void {
  _configOverride = config;
}

/**
 * Clear the config override set by setConfigOverride().
 * Also clears the memo cache so the next loadEnforcementConfig() call re-reads.
 */
export function resetConfigOverride(): void {
  _configOverride = null;
  _cachedConfig = null;
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

/**
 * Load and return the active EnforcementConfig.
 *
 * Loading order (highest wins):
 *   1. setConfigOverride() value (test hook)
 *   2. Env var overrides (YAKCC_RESULT_SET_MAX, YAKCC_HOOK_DISABLE_INTENT_GATE, …)
 *   3. Config file (.yakcc/enforcement.json or YAKCC_ENFORCEMENT_CONFIG_PATH)
 *   4. Default values (getDefaults())
 *
 * The result is memoized after the first call. Call resetConfigOverride() to
 * invalidate the memo (e.g., between tests).
 *
 * @param opts.filePath - Override the config file path (skips the env lookup).
 * @param opts.env      - Override process.env (useful for testing env-var logic).
 *
 * @throws Error when the config file exists but contains invalid JSON.
 * @throws TypeError when the config file contains incorrect field types.
 *
 * @decision DEC-HOOK-ENF-CONFIG-001
 */
export function loadEnforcementConfig(opts?: {
  filePath?: string;
  env?: NodeJS.ProcessEnv;
}): EnforcementConfig {
  if (_configOverride !== null) {
    return _configOverride;
  }

  if (_cachedConfig !== null) {
    // Re-apply env overrides even on cached config so test env manipulation
    // is picked up without requiring a resetConfigOverride call.
    // (The file-load result is cached; env overrides are re-evaluated each call.)
    return applyEnvOverrides(_cachedConfig, opts?.env ?? process.env);
  }

  const env = opts?.env ?? process.env;
  const defaults = getDefaults();

  // Load from file if available.
  const filePath = opts?.filePath ?? resolveConfigFilePath(env);
  const fileConfig = filePath !== null ? loadFromFile(filePath, defaults) : defaults;

  // Cache the file-merged config (before env overrides).
  _cachedConfig = fileConfig;

  // Apply env overrides on top (not cached).
  return applyEnvOverrides(fileConfig, env);
}

/**
 * Convenience getter: returns the active enforcement config.
 *
 * This is the function layer modules should import and call.
 * Equivalent to loadEnforcementConfig() with no options.
 *
 * @decision DEC-HOOK-ENF-CONFIG-001
 */
export function getEnforcementConfig(): EnforcementConfig {
  return loadEnforcementConfig();
}
