// SPDX-License-Identifier: MIT
// @decision DEC-HOOKS-CLAUDE-CODE-PROPTEST-INDEX-001: hand-authored property-test corpus
// for @yakcc/hooks-claude-code index.ts pure-logic atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts is the
// vitest harness.
// Status: accepted (issue-87-fill-hook-adapters)
// Rationale: The adapter's pure-logic surface consists of: (a) the SLASH_COMMAND_MARKER_FILENAME
// constant, (b) the re-exported DEFAULT_REGISTRY_HIT_THRESHOLD constant, and (c) the createHook
// factory — which constructs a plain object at call time (pure) and defers all I/O to the
// returned methods. Properties verify constant invariants, factory shape (method keys present),
// option-merging defaults, and the re-export contract. The impure paths
// (registerSlashCommand FS write, onCodeEmissionIntent async/registry) are covered by
// index.test.ts integration tests and are NOT re-tested here.
//
// NOT covered here (impure / async / FS):
//   registerSlashCommand() — FS side-effect, covered in index.test.ts
//   onCodeEmissionIntent() — async + Registry dependency, covered in index.test.ts

// ---------------------------------------------------------------------------
// Property-test corpus for hooks-claude-code index.ts
//
// Constants/exports covered (3):
//   SLASH_COMMAND_MARKER_FILENAME   — constant invariant
//   DEFAULT_REGISTRY_HIT_THRESHOLD  — re-exported constant invariant
//   createHook                       — factory: object shape, option defaults
//   ClaudeCodeHookOptions            — interface: sessionId/telemetryDir optional fields
//
// Behaviors exercised:
//   M1 — SLASH_COMMAND_MARKER_FILENAME is exactly "yakcc-slash-command.json"
//   M2 — SLASH_COMMAND_MARKER_FILENAME ends with ".json"
//   M3 — SLASH_COMMAND_MARKER_FILENAME starts with "yakcc-"
//   T1 — DEFAULT_REGISTRY_HIT_THRESHOLD re-export is exactly 0.30
//   T2 — DEFAULT_REGISTRY_HIT_THRESHOLD re-export is in valid range (0, 2)
//   F1 — createHook totality: never throws for any valid threshold/markerDir combination
//   F2 — createHook returns an object with a registerSlashCommand method
//   F3 — createHook returns an object with an onCodeEmissionIntent method
//   F4 — createHook with undefined options still returns a valid hook object
//   F5 — createHook with custom threshold still returns a valid hook object
//   F6 — createHook with custom markerDir still returns a valid hook object
//   F7 — createHook with all ClaudeCodeHookOptions fields returns a valid hook object
//   E1 — Re-export: DEFAULT_REGISTRY_HIT_THRESHOLD is a number (not undefined)
// ---------------------------------------------------------------------------

import type { Registry } from "@yakcc/registry";
import {
  DEFAULT_REGISTRY_HIT_THRESHOLD,
  SLASH_COMMAND_MARKER_FILENAME,
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
const MARKER_DIRS = ["/tmp/test-marker", "/home/user/.claude", "/custom/dir", "relative/dir"];

// ---------------------------------------------------------------------------
// M1 — SLASH_COMMAND_MARKER_FILENAME: exact value
// ---------------------------------------------------------------------------

/**
 * prop_slashCommandMarkerFilename_exact_value
 *
 * SLASH_COMMAND_MARKER_FILENAME is exactly "yakcc-slash-command.json".
 *
 * Invariant: the marker file name is load-bearing — it is the well-known
 * path that Claude Code's harness discovers for slash-command registration
 * (DEC-HOOK-CLAUDE-CODE-PROD-001). Any change here breaks the registration
 * contract.
 */
export function prop_slashCommandMarkerFilename_exact_value(): boolean {
  return SLASH_COMMAND_MARKER_FILENAME === "yakcc-slash-command.json";
}

// ---------------------------------------------------------------------------
// M2 — SLASH_COMMAND_MARKER_FILENAME: ends with ".json"
// ---------------------------------------------------------------------------

/**
 * prop_slashCommandMarkerFilename_ends_with_json
 *
 * SLASH_COMMAND_MARKER_FILENAME always ends with ".json".
 *
 * Invariant: the marker file must be JSON-parseable by the harness. A non-JSON
 * extension would cause the harness to reject or ignore it.
 */
export function prop_slashCommandMarkerFilename_ends_with_json(): boolean {
  return SLASH_COMMAND_MARKER_FILENAME.endsWith(".json");
}

// ---------------------------------------------------------------------------
// M3 — SLASH_COMMAND_MARKER_FILENAME: starts with "yakcc-"
// ---------------------------------------------------------------------------

/**
 * prop_slashCommandMarkerFilename_starts_with_yakcc
 *
 * SLASH_COMMAND_MARKER_FILENAME starts with "yakcc-" to namespace it within
 * the ~/.claude directory alongside other Claude Code settings files.
 *
 * Invariant: namespacing prevents collision with other Claude Code marker files.
 */
export function prop_slashCommandMarkerFilename_starts_with_yakcc(): boolean {
  return SLASH_COMMAND_MARKER_FILENAME.startsWith("yakcc-");
}

// ---------------------------------------------------------------------------
// T1 — DEFAULT_REGISTRY_HIT_THRESHOLD: exact value
// ---------------------------------------------------------------------------

/**
 * prop_reexported_threshold_is_0_30
 *
 * The re-exported DEFAULT_REGISTRY_HIT_THRESHOLD is exactly 0.30.
 *
 * Invariant: this package re-exports the threshold from @yakcc/hooks-base so
 * callers can reference the same constant without importing hooks-base directly.
 * If the re-export is broken, callers using the Claude Code package would see
 * undefined or a wrong value.
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
 * The re-exported DEFAULT_REGISTRY_HIT_THRESHOLD is strictly between 0 and 2
 * (the valid sqlite-vec cosine distance range for unit-norm vectors).
 *
 * Invariant: a threshold of 0 would reject all candidates; ≥ 2 would accept all.
 * The cross-IDE default must be in the useful working range (0, 2).
 */
export function prop_reexported_threshold_in_valid_range(): boolean {
  return DEFAULT_REGISTRY_HIT_THRESHOLD > 0 && DEFAULT_REGISTRY_HIT_THRESHOLD < 2;
}

// ---------------------------------------------------------------------------
// F1 — createHook: totality across threshold and markerDir combinations
// ---------------------------------------------------------------------------

/**
 * prop_createHook_total
 *
 * createHook never throws for any valid combination of Registry, threshold,
 * and markerDir options.
 *
 * Invariant: the factory only constructs a plain object — no I/O, no validation,
 * no error path in the factory itself. All option values are valid; only the
 * returned methods trigger I/O on call.
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
// F2 — createHook: returned object has registerSlashCommand method
// ---------------------------------------------------------------------------

/**
 * prop_createHook_has_registerSlashCommand
 *
 * The object returned by createHook always has a registerSlashCommand method.
 *
 * Invariant: ClaudeCodeHook interface contract — registerSlashCommand is the
 * public API for wiring the hook into the Claude Code harness.
 */
export function prop_createHook_has_registerSlashCommand(): boolean {
  const hook = createHook(makeStubRegistry());
  return typeof hook.registerSlashCommand === "function";
}

// ---------------------------------------------------------------------------
// F3 — createHook: returned object has onCodeEmissionIntent method
// ---------------------------------------------------------------------------

/**
 * prop_createHook_has_onCodeEmissionIntent
 *
 * The object returned by createHook always has an onCodeEmissionIntent method.
 *
 * Invariant: ClaudeCodeHook interface contract — onCodeEmissionIntent is the
 * primary hook callback invoked on every code emission event.
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
 * createHook(registry) with no options argument returns a hook with both
 * required methods, applying the DEFAULT_REGISTRY_HIT_THRESHOLD and ~/.claude
 * markerDir defaults.
 *
 * Invariant: callers in production typically omit the options argument.
 * Passing undefined must not produce a broken hook.
 */
export function prop_createHook_no_options_returns_valid_hook(): boolean {
  const hook = createHook(makeStubRegistry());
  return (
    typeof hook.registerSlashCommand === "function" &&
    typeof hook.onCodeEmissionIntent === "function"
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
 *
 * Invariant: the threshold option is advisory — the factory stores it internally
 * for use in onCodeEmissionIntent(). No validation at construction time.
 */
export function prop_createHook_custom_threshold_accepted(): boolean {
  const registry = makeStubRegistry();
  for (const threshold of THRESHOLD_VALUES) {
    try {
      const hook = createHook(registry, { threshold });
      if (typeof hook.registerSlashCommand !== "function") return false;
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
 *
 * Invariant: markerDir creation is deferred to registerSlashCommand() via
 * writeMarkerCommand(). The factory itself performs no FS access.
 */
export function prop_createHook_custom_markerDir_accepted(): boolean {
  const registry = makeStubRegistry();
  for (const markerDir of MARKER_DIRS) {
    try {
      const hook = createHook(registry, { markerDir });
      if (typeof hook.registerSlashCommand !== "function") return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// F7 — createHook: all ClaudeCodeHookOptions fields accepted
// ---------------------------------------------------------------------------

/**
 * prop_createHook_all_claudeCodeHookOptions_accepted
 *
 * createHook with all ClaudeCodeHookOptions fields (threshold, markerDir,
 * sessionId, telemetryDir) returns a valid hook object without error.
 *
 * Invariant: ClaudeCodeHookOptions extends HookOptions with sessionId and
 * telemetryDir. All fields are optional; providing all at once must not cause
 * a construction error.
 */
export function prop_createHook_all_claudeCodeHookOptions_accepted(): boolean {
  const registry = makeStubRegistry();
  const allOptions = {
    threshold: 0.25,
    markerDir: "/tmp/test-marker",
    sessionId: "test-session-id",
    telemetryDir: "/tmp/test-telemetry",
  };
  try {
    const hook = createHook(registry, allOptions);
    return (
      typeof hook.registerSlashCommand === "function" &&
      typeof hook.onCodeEmissionIntent === "function"
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// E1 — Re-export: DEFAULT_REGISTRY_HIT_THRESHOLD is a number
// ---------------------------------------------------------------------------

/**
 * prop_reexported_threshold_is_a_number
 *
 * The re-exported DEFAULT_REGISTRY_HIT_THRESHOLD is a number, not undefined
 * or any other type.
 *
 * Invariant: the re-export chain (@yakcc/hooks-base → @yakcc/hooks-claude-code)
 * must preserve the constant as a numeric value. A broken re-export would
 * produce undefined at runtime.
 */
export function prop_reexported_threshold_is_a_number(): boolean {
  return typeof DEFAULT_REGISTRY_HIT_THRESHOLD === "number";
}
