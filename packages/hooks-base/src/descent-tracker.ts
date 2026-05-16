// SPDX-License-Identifier: MIT
//
// @decision DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001
// title: Layer 4 per-session in-memory descent-depth tracker keyed by makeBindingKey
// status: decided (wi-592-s4-layer4)
// rationale:
//   Layer 4 tracks the number of miss/hit transitions for each (packageName, binding) pair
//   within a single session. The depth is the miss count at the time of substitution.
//   When depth < minDepth and the intent does not match any shallowAllowPattern, an advisory
//   DescentBypassWarning is attached to the SubstitutionResult (non-blocking).
//
//   Design choices:
//   (A) PER-SESSION IN-MEMORY MAP — state is never persisted to disk. Each session starts
//       fresh. This is intentional: descent depth is a per-session signal (how many times
//       has the current LLM agent tried and missed this binding before hitting?). Cross-
//       session accumulation would conflate independent usage patterns. Persistence is
//       explicitly forbidden by the Layer 4 spec (wi-592 acceptance notes).
//
//   (B) BINDING KEY — reuses makeBindingKey("packageName", "binding") = "packageName::binding"
//       from shave-on-miss-state.ts (DEC-WI508-S3-KEY-FORMAT-001). Same key format ensures
//       consistent binding identity across all hook subsystems.
//
//   (C) ADVISORY ONLY — Layer 4 never rejects a substitution. It attaches a warning and
//       returns the warning shape to substitute.ts, which decides whether to emit telemetry.
//       The substitution still proceeds regardless of the warning.
//
//   (D) SHALLOW-ALLOW BYPASS — bindings whose name matches any pattern in
//       config.shallowAllowPatterns (case-insensitive regex) are never warned regardless
//       of depth. Primitives like "add", "sub" are inherently unambiguous.
//
//   Cross-reference: plans/wi-579-s4-layer4-descent-tracker.md §5.5,
//   DEC-HOOK-ENF-LAYER4-MIN-DEPTH-001, DEC-HOOK-ENF-LAYER4-SHALLOW-ALLOW-001

import type { DescentBypassWarning } from "./enforcement-types.js";
import type { Layer4Config } from "./enforcement-config.js";
import { makeBindingKey } from "./shave-on-miss-state.js";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/**
 * Per-binding descent tracking record for one session.
 *
 * misses: number of miss events observed (binding not found in registry).
 *   This is the primary "descent depth" signal: higher miss count = deeper descent.
 * hits:   number of hit events observed (binding found in registry).
 */
export interface DescentRecord {
  /** Number of registry misses observed for this binding in the current session. */
  misses: number;
  /** Number of registry hits observed for this binding in the current session. */
  hits: number;
}

/**
 * Module-scoped per-session descent tracking map.
 * Key: makeBindingKey(packageName, binding) — "packageName::binding"
 * Value: DescentRecord
 *
 * Reset via resetSession() between tests (and conceptually at session start).
 */
const _sessionMap: Map<string, DescentRecord> = new Map();

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Reset the per-session descent tracking map.
 *
 * Called between tests to provide isolation.
 * In production, this module is loaded once per process (= one session).
 * Never persists state across sessions (DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001 §A).
 */
export function resetSession(): void {
  _sessionMap.clear();
}

// ---------------------------------------------------------------------------
// Record events
// ---------------------------------------------------------------------------

/**
 * Record a registry miss for a (packageName, binding) pair.
 *
 * Called from import-intercept when yakccResolve returns no confident match
 * (status "no_match" or "weak_only"). Increments the miss count for the binding.
 *
 * Failures are swallowed to preserve the observe-don't-mutate principle:
 * descent tracking failure must never block the hook path.
 *
 * @param packageName - NPM package name (e.g. "validator").
 * @param binding     - Named binding (e.g. "isEmail").
 */
export function recordMiss(packageName: string, binding: string): void {
  try {
    const key = makeBindingKey(packageName, binding);
    const existing = _sessionMap.get(key);
    if (existing !== undefined) {
      existing.misses += 1;
    } else {
      _sessionMap.set(key, { misses: 1, hits: 0 });
    }
  } catch {
    // Tracking failure must not affect the hook path.
  }
}

/**
 * Record a registry hit for a (packageName, binding) pair.
 *
 * Called from import-intercept when yakccResolve returns a confident match
 * (status "matched"). Increments the hit count for the binding.
 *
 * Failures are swallowed to preserve the observe-don't-mutate principle.
 *
 * @param packageName - NPM package name (e.g. "validator").
 * @param binding     - Named binding (e.g. "isEmail").
 */
export function recordHit(packageName: string, binding: string): void {
  try {
    const key = makeBindingKey(packageName, binding);
    const existing = _sessionMap.get(key);
    if (existing !== undefined) {
      existing.hits += 1;
    } else {
      _sessionMap.set(key, { misses: 0, hits: 1 });
    }
  } catch {
    // Tracking failure must not affect the hook path.
  }
}

// ---------------------------------------------------------------------------
// Depth query
// ---------------------------------------------------------------------------

/**
 * Return the descent depth (miss count) for a (packageName, binding) pair.
 *
 * Depth is defined as the number of recorded misses in the current session.
 * A depth of 0 means the binding has never been missed (immediate hit or first attempt).
 *
 * @param packageName - NPM package name.
 * @param binding     - Named binding.
 * @returns Miss count for this binding in the current session (0 if never seen).
 */
export function getDescentDepth(packageName: string, binding: string): number {
  const key = makeBindingKey(packageName, binding);
  return _sessionMap.get(key)?.misses ?? 0;
}

/**
 * Return the full DescentRecord for a binding, or null if never tracked.
 *
 * Useful for testing and telemetry; not used in the hot path.
 *
 * @param packageName - NPM package name.
 * @param binding     - Named binding.
 */
export function getDescentRecord(packageName: string, binding: string): DescentRecord | null {
  const key = makeBindingKey(packageName, binding);
  return _sessionMap.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// Shallow-allow check
// ---------------------------------------------------------------------------

/**
 * Check whether a binding intent matches any shallow-allow pattern.
 *
 * When a match is found, Layer 4 will NOT emit a warning regardless of depth.
 * Patterns are matched case-insensitively against the binding name.
 *
 * @param binding  - Named binding (e.g. "add", "isEmail").
 * @param patterns - Array of regex pattern strings from Layer4Config.shallowAllowPatterns.
 * @returns true when any pattern matches the binding name.
 */
export function isShallowAllowed(binding: string, patterns: readonly string[]): boolean {
  const lower = binding.toLowerCase();
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, "i").test(lower)) return true;
    } catch {
      // Invalid regex — skip silently. Operators are responsible for valid patterns.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Warning decision
// ---------------------------------------------------------------------------

/**
 * Determine whether to emit a DescentBypassWarning for a substitution attempt.
 *
 * Returns true when ALL of the following hold:
 *   1. disableTracking is false in config.
 *   2. Observed descent depth (miss count) < config.minDepth.
 *   3. The binding name does NOT match any shallowAllowPattern.
 *
 * @param packageName - NPM package name.
 * @param binding     - Named binding.
 * @param config      - Layer4Config (from getEnforcementConfig().layer4).
 * @returns true when an advisory warning should be attached.
 */
export function shouldWarn(
  packageName: string,
  binding: string,
  config: Layer4Config,
): boolean {
  if (config.disableTracking) return false;
  const depth = getDescentDepth(packageName, binding);
  if (depth >= config.minDepth) return false;
  if (isShallowAllowed(binding, config.shallowAllowPatterns)) return false;
  return true;
}

/**
 * Build a DescentBypassWarning for a substitution attempt, or return null.
 *
 * This is the primary entry point called from substitute.ts.
 * Returns null when no warning is warranted (depth sufficient, shallow-allowed,
 * or tracking disabled).
 *
 * @param packageName - NPM package name.
 * @param binding     - Named binding.
 * @param intent      - The intent string for this substitution (for telemetry and suggestion).
 * @param config      - Layer4Config (from getEnforcementConfig().layer4).
 * @returns DescentBypassWarning when advisory warning should be attached; null otherwise.
 */
export function getAdvisoryWarning(
  packageName: string,
  binding: string,
  intent: string,
  config: Layer4Config,
): DescentBypassWarning | null {
  if (!shouldWarn(packageName, binding, config)) return null;

  const bindingKey = makeBindingKey(packageName, binding);
  const observedDepth = getDescentDepth(packageName, binding);

  return {
    layer: 4,
    status: "descent-bypass-warning",
    bindingKey,
    observedDepth,
    minDepth: config.minDepth,
    intent,
    suggestion:
      `Layer 4 advisory: "${bindingKey}" was substituted at descent depth ${observedDepth} ` +
      `(minDepth=${config.minDepth}). Consider descending further before substituting — ` +
      `see docs/system-prompts/yakcc-discovery.md for the descent-and-compose discipline.`,
  };
}
