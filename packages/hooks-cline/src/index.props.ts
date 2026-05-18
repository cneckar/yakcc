// SPDX-License-Identifier: MIT
// @decision DEC-HOOKS-CLINE-PROPTEST-INDEX-001: hand-authored property-test corpus
// for @yakcc/hooks-cline index.ts pure-logic atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts is the
// vitest harness.
// Status: accepted (wi-687-s2-cline)
// Rationale: The adapter's pure-logic surface consists of: (a) the CLINE_COMMAND_MARKER_FILENAME
// constant, (b) the re-exported DEFAULT_REGISTRY_HIT_THRESHOLD constant, and (c) the createHook
// factory — which constructs a plain object at call time (pure) and defers all I/O to the
// returned methods. Properties verify constant invariants, factory shape (method keys present),
// option-merging defaults, and the re-export contract. The impure paths
// (registerCommand FS write, onCodeEmissionIntent async/registry) are NOT tested here.
//
// NOT covered here (impure / async / FS):
//   registerCommand()        — FS side-effect
//   onCodeEmissionIntent()   — async + Registry dependency

// ---------------------------------------------------------------------------
// Property-test corpus for hooks-cline index.ts
//
// Constants/exports covered (3):
//   CLINE_COMMAND_MARKER_FILENAME    — constant invariant
//   DEFAULT_REGISTRY_HIT_THRESHOLD   — re-exported constant invariant
//   createHook                        — factory: object shape, option defaults
//
// Behaviors exercised:
//   M1 — CLINE_COMMAND_MARKER_FILENAME is exactly "yakcc-cline-command.json"
//   M2 — CLINE_COMMAND_MARKER_FILENAME ends with ".json"
//   M3 — CLINE_COMMAND_MARKER_FILENAME starts with "yakcc-"
//   M4 — CLINE_COMMAND_MARKER_FILENAME contains "cline" (Cline-specific namespacing)
//   T1 — DEFAULT_REGISTRY_HIT_THRESHOLD re-export is exactly 0.30
//   T2 — DEFAULT_REGISTRY_HIT_THRESHOLD re-export is in valid range (0, 2)
//   T3 — DEFAULT_REGISTRY_HIT_THRESHOLD re-export is a number
//   F1 — createHook totality: never throws for any valid threshold/markerDir combination
//   F2 — createHook returns an object with a registerCommand method
//   F3 — createHook returns an object with an onCodeEmissionIntent method
//   F4 — createHook with undefined options still returns a valid hook object
//   F5 — createHook with custom threshold still returns a valid hook object
//   F6 — createHook with custom markerDir still returns a valid hook object
// ---------------------------------------------------------------------------

import type { Registry } from "@yakcc/registry";
import {
  CLINE_COMMAND_MARKER_FILENAME,
  DEFAULT_REGISTRY_HIT_THRESHOLD,
  createHook,
} from "./index.js";

// ---------------------------------------------------------------------------
// Stub registry — satisfies the Registry type without any real I/O.
// Properties only test factory construction, not registry calls.
// ---------------------------------------------------------------------------

/** Minimal Registry stub for factory construction tests. */
function makeStubRegistry(): Registry {
  return {
    findCandidatesByIntent: async () => [],
    // Cast to satisfy the full Registry interface; only findCandidatesByIntent
    // is exercised by the property tests (and only at the type level here).
  } as unknown as Registry;
}

/** Threshold values representing the full valid range and edge cases. */
const THRESHOLD_VALUES = [0.01, 0.1, 0.2, 0.3, 0.5, 0.8, 1.0, 1.5, 1.99];

/** MarkerDir paths for option-merging tests. */
const MARKER_DIRS = ["/tmp/test-marker", "/home/user/.config/cline", "/custom/dir", "relative/dir"];

// ---------------------------------------------------------------------------
// M1 — CLINE_COMMAND_MARKER_FILENAME: exact value
// ---------------------------------------------------------------------------

/**
 * prop_clineCommandMarkerFilename_exact_value
 *
 * CLINE_COMMAND_MARKER_FILENAME is exactly "yakcc-cline-command.json".
 *
 * Invariant: the marker file name is load-bearing — it is the well-known
 * path that the Cline extension harness discovers for command registration
 * (DEC-HOOK-CLINE-001). Any change here breaks the registration contract.
 */
export function prop_clineCommandMarkerFilename_exact_value(): boolean {
  return CLINE_COMMAND_MARKER_FILENAME === "yakcc-cline-command.json";
}

// ---------------------------------------------------------------------------
// M2 — CLINE_COMMAND_MARKER_FILENAME: ends with ".json"
// ---------------------------------------------------------------------------

/**
 * prop_clineCommandMarkerFilename_ends_with_json
 *
 * CLINE_COMMAND_MARKER_FILENAME always ends with ".json".
 *
 * Invariant: the marker file must be JSON-parseable by the harness.
 */
export function prop_clineCommandMarkerFilename_ends_with_json(): boolean {
  return CLINE_COMMAND_MARKER_FILENAME.endsWith(".json");
}

// ---------------------------------------------------------------------------
// M3 — CLINE_COMMAND_MARKER_FILENAME: starts with "yakcc-"
// ---------------------------------------------------------------------------

/**
 * prop_clineCommandMarkerFilename_starts_with_yakcc
 *
 * CLINE_COMMAND_MARKER_FILENAME starts with "yakcc-" to namespace it within
 * the ~/.config/cline directory alongside other Cline extension settings files.
 *
 * Invariant: namespacing prevents collision with other Cline marker files.
 */
export function prop_clineCommandMarkerFilename_starts_with_yakcc(): boolean {
  return CLINE_COMMAND_MARKER_FILENAME.startsWith("yakcc-");
}

// ---------------------------------------------------------------------------
// M4 — CLINE_COMMAND_MARKER_FILENAME: contains "cline"
// ---------------------------------------------------------------------------

/**
 * prop_clineCommandMarkerFilename_contains_cline
 *
 * CLINE_COMMAND_MARKER_FILENAME contains "cline" to distinguish it from the
 * hooks-claude-code and hooks-cursor marker files.
 *
 * Invariant: each IDE adapter must produce a distinct marker filename so
 * multiple hooks can coexist in the same settings directory without collision
 * (DEC-HOOK-CLINE-001-b). The "cline" token is the distinguishing segment.
 */
export function prop_clineCommandMarkerFilename_contains_cline(): boolean {
  return CLINE_COMMAND_MARKER_FILENAME.includes("cline");
}

// ---------------------------------------------------------------------------
// T1 — DEFAULT_REGISTRY_HIT_THRESHOLD: exact value
// ---------------------------------------------------------------------------

/**
 * prop_reexported_threshold_is_0_30
 *
 * The re-exported DEFAULT_REGISTRY_HIT_THRESHOLD is exactly 0.30.
 *
 * Invariant: cross-IDE threshold consistency — all adapters must share 0.30
 * to avoid surprising registry-hit divergence (DEC-HOOK-CLINE-001-c).
 */
export function prop_reexported_threshold_is_0_30(): boolean {
  return DEFAULT_REGISTRY_HIT_THRESHOLD === 0.3;
}

// ---------------------------------------------------------------------------
// T2 — DEFAULT_REGISTRY_HIT_THRESHOLD: valid cosine-distance range
// ---------------------------------------------------------------------------

/**
 * prop_reexported_threshold_in_valid_range
 *
 * The re-exported DEFAULT_REGISTRY_HIT_THRESHOLD is strictly between 0 and 2.
 */
export function prop_reexported_threshold_in_valid_range(): boolean {
  return DEFAULT_REGISTRY_HIT_THRESHOLD > 0 && DEFAULT_REGISTRY_HIT_THRESHOLD < 2;
}

// ---------------------------------------------------------------------------
// T3 — DEFAULT_REGISTRY_HIT_THRESHOLD: is a number
// ---------------------------------------------------------------------------

/**
 * prop_reexported_threshold_is_a_number
 *
 * The re-exported DEFAULT_REGISTRY_HIT_THRESHOLD is a number.
 */
export function prop_reexported_threshold_is_a_number(): boolean {
  return typeof DEFAULT_REGISTRY_HIT_THRESHOLD === "number";
}

// ---------------------------------------------------------------------------
// F1 — createHook: totality across threshold and markerDir combinations
// ---------------------------------------------------------------------------

/**
 * prop_createHook_total
 *
 * createHook never throws for any valid combination of Registry, threshold,
 * and markerDir options.
 */
export function prop_createHook_total(): boolean {
  const registry = makeStubRegistry();
  for (const threshold of THRESHOLD_VALUES) {
    for (const markerDir of MARKER_DIRS) {
      try {
        createHook(registry, { threshold, markerDir });
      } catch {
        return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// F2 — createHook: returned object has registerCommand method
// ---------------------------------------------------------------------------

/**
 * prop_createHook_has_registerCommand
 *
 * The object returned by createHook always has a registerCommand method.
 */
export function prop_createHook_has_registerCommand(): boolean {
  const hook = createHook(makeStubRegistry());
  return typeof hook.registerCommand === "function";
}

// ---------------------------------------------------------------------------
// F3 — createHook: returned object has onCodeEmissionIntent method
// ---------------------------------------------------------------------------

/**
 * prop_createHook_has_onCodeEmissionIntent
 *
 * The object returned by createHook always has an onCodeEmissionIntent method.
 */
export function prop_createHook_has_onCodeEmissionIntent(): boolean {
  const hook = createHook(makeStubRegistry());
  return typeof hook.onCodeEmissionIntent === "function";
}

// ---------------------------------------------------------------------------
// F4 — createHook: undefined options returns a valid hook
// ---------------------------------------------------------------------------

/**
 * prop_createHook_no_options_returns_valid_hook
 *
 * createHook(registry) with no options applies DEFAULT_REGISTRY_HIT_THRESHOLD
 * and ~/.config/cline markerDir defaults and returns a valid hook.
 */
export function prop_createHook_no_options_returns_valid_hook(): boolean {
  const hook = createHook(makeStubRegistry());
  return (
    typeof hook.registerCommand === "function" && typeof hook.onCodeEmissionIntent === "function"
  );
}

// ---------------------------------------------------------------------------
// F5 — createHook: custom threshold accepted without error
// ---------------------------------------------------------------------------

/**
 * prop_createHook_custom_threshold_accepted
 *
 * createHook with every threshold value in the valid range returns a hook
 * object without error.
 */
export function prop_createHook_custom_threshold_accepted(): boolean {
  const registry = makeStubRegistry();
  for (const threshold of THRESHOLD_VALUES) {
    try {
      const hook = createHook(registry, { threshold });
      if (typeof hook.registerCommand !== "function") return false;
      if (typeof hook.onCodeEmissionIntent !== "function") return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// F6 — createHook: custom markerDir accepted without error
// ---------------------------------------------------------------------------

/**
 * prop_createHook_custom_markerDir_accepted
 *
 * createHook with every marker directory path returns a hook object without
 * error — no directory existence validation happens at construction time.
 */
export function prop_createHook_custom_markerDir_accepted(): boolean {
  const registry = makeStubRegistry();
  for (const markerDir of MARKER_DIRS) {
    try {
      const hook = createHook(registry, { markerDir });
      if (typeof hook.registerCommand !== "function") return false;
    } catch {
      return false;
    }
  }
  return true;
}
