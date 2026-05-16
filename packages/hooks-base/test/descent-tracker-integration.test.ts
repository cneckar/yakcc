// SPDX-License-Identifier: MIT
/**
 * descent-tracker-integration.test.ts — Integration tests for Layer 4 through the
 * substitute.ts pipeline.
 *
 * @decision DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001 (cross-reference)
 *
 * Production trigger:
 *   In production, the sequence is:
 *     1. import-intercept runs per binding in emitted code.
 *        - If yakccResolve returns "matched" → recordHit(pkg, binding)
 *        - If yakccResolve returns "no_match" / "weak_only" → recordMiss(pkg, binding)
 *     2. executeSubstitution runs on D2 auto-accept candidate list.
 *        - getAdvisoryWarning(pkg, binding, intent, l4cfg) reads accumulated depth.
 *        - If depth < minDepth and not shallow-allowed → descentBypassWarning attached.
 *        - If depth >= minDepth → descentBypassWarning = null.
 *     3. Substitution proceeds regardless of the warning (advisory, non-blocking).
 *
 * These integration tests exercise that real production sequence using
 * the actual Layer 4 module functions (no mocks for internal state).
 *
 * Compound-interaction requirement:
 *   Each test crosses recordMiss/recordHit (import-intercept side) →
 *   getAdvisoryWarning (substitute side), verifying the in-memory session Map
 *   correctly bridges the two pipeline stages.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordMiss,
  recordHit,
  getDescentDepth,
  getAdvisoryWarning,
  shouldWarn,
  resetSession,
} from "../src/descent-tracker.js";
import {
  getDefaults,
  setConfigOverride,
  resetConfigOverride,
} from "../src/enforcement-config.js";
import type { Layer4Config } from "../src/enforcement-config.js";
import type { EnforcementConfig } from "../src/enforcement-config.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeL4Config(overrides?: Partial<Layer4Config>): Layer4Config {
  return {
    minDepth: 2,
    shallowAllowPatterns: [
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
    ],
    disableTracking: false,
    ...overrides,
  };
}

/**
 * Inject a Layer 4 config into the enforcement config override so
 * getEnforcementConfig().layer4 picks it up in substitute.ts.
 */
function withL4Config(l4cfg: Layer4Config): void {
  const defaults = getDefaults();
  const override: EnforcementConfig = { ...defaults, layer4: l4cfg };
  setConfigOverride(override);
}

// ---------------------------------------------------------------------------
// Session + config isolation
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetSession();
  resetConfigOverride();
});

afterEach(() => {
  resetSession();
  resetConfigOverride();
});

// ---------------------------------------------------------------------------
// Flow 1: Zero-miss path → warning emitted (depth below minDepth)
//
// Production sequence:
//   - No prior import-intercept events for this binding.
//   - Binding never appeared in the session → depth = 0.
//   - substitute.ts calls getAdvisoryWarning → depth 0 < minDepth 2 → warn.
// ---------------------------------------------------------------------------

describe("Flow 1: zero-miss path — warning emitted", () => {
  it("emits a DescentBypassWarning when no misses have been recorded for a binding", () => {
    const cfg = makeL4Config({ minDepth: 2 });
    withL4Config(cfg);

    // No recordMiss / recordHit called (simulating first-time substitution attempt)
    const warning = getAdvisoryWarning("validator", "isEmail", "validate RFC 5321 email address", cfg);

    expect(warning).not.toBeNull();
    expect(warning?.layer).toBe(4);
    expect(warning?.status).toBe("descent-bypass-warning");
    expect(warning?.bindingKey).toBe("isEmail::isEmail"); // canonical atom-key (WI-600)
    expect(warning?.observedDepth).toBe(0);
    expect(warning?.minDepth).toBe(2);
    expect(warning?.intent).toBe("validate RFC 5321 email address");
    expect(typeof warning?.suggestion).toBe("string");
    expect(warning!.suggestion.length).toBeGreaterThan(0);
  });

  it("warning suggestion text references the canonical binding key and depth values", () => {
    const cfg = makeL4Config({ minDepth: 3 });
    const warning = getAdvisoryWarning("zod", "parseAsync", "parse async input schema with zod", cfg);

    // bindingKey is canonical: "parseAsync::parseAsync" (WI-600 — packageName ignored in key)
    expect(warning?.suggestion).toContain("parseAsync::parseAsync");
    expect(warning?.suggestion).toContain("0"); // observedDepth
    expect(warning?.suggestion).toContain("3"); // minDepth
  });
});

// ---------------------------------------------------------------------------
// Flow 2: Sufficient-miss path → no warning (depth reached minDepth)
//
// Production sequence:
//   - Two import-intercept events recorded misses for "isEmail" from "validator".
//   - Binding now has depth = 2 = minDepth.
//   - substitute.ts calls getAdvisoryWarning → depth 2 >= minDepth 2 → no warn.
// ---------------------------------------------------------------------------

describe("Flow 2: sufficient-miss path — no warning", () => {
  it("emits no warning when recorded misses equal minDepth", () => {
    const cfg = makeL4Config({ minDepth: 2 });
    withL4Config(cfg);

    // Simulate two import-intercept miss events
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");

    // Now depth = 2 >= minDepth = 2
    expect(getDescentDepth("validator", "isEmail")).toBe(2);

    const warning = getAdvisoryWarning("validator", "isEmail", "validate RFC 5321 email address", cfg);
    expect(warning).toBeNull();
  });

  it("emits no warning when recorded misses exceed minDepth", () => {
    const cfg = makeL4Config({ minDepth: 2 });
    withL4Config(cfg);

    recordMiss("validator", "isURL");
    recordMiss("validator", "isURL");
    recordMiss("validator", "isURL"); // depth = 3 > minDepth = 2

    const warning = getAdvisoryWarning("validator", "isURL", "validate a URL with scheme validation", cfg);
    expect(warning).toBeNull();
  });

  it("tracks each binding independently — one binding's depth does not affect another", () => {
    const cfg = makeL4Config({ minDepth: 2 });
    withL4Config(cfg);

    // isEmail: 2 misses — no warning
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");

    // isIP: 0 misses — warning expected
    const warnForIsEmail = getAdvisoryWarning("validator", "isEmail", "validate email format", cfg);
    const warnForIsIP = getAdvisoryWarning("validator", "isIP", "validate IP address format", cfg);

    expect(warnForIsEmail).toBeNull();
    expect(warnForIsIP).not.toBeNull();
    expect(warnForIsIP?.bindingKey).toBe("isIP::isIP"); // canonical atom-key (WI-600)
  });
});

// ---------------------------------------------------------------------------
// Flow 3: Shallow-allow bypass path → no warning regardless of depth
//
// Production sequence:
//   - Primitive binding (e.g. "add") is attempted at depth 0.
//   - shallowAllowPatterns = ["^add$", ...] matches "add".
//   - substitute.ts calls getAdvisoryWarning → shallow-allowed → no warn.
// ---------------------------------------------------------------------------

describe("Flow 3: shallow-allow bypass — no warning for primitives", () => {
  it("emits no warning for an arithmetic primitive at depth 0 (depth below minDepth)", () => {
    const cfg = makeL4Config({ minDepth: 2 });
    withL4Config(cfg);

    // No misses recorded — depth = 0
    const warning = getAdvisoryWarning("math-utils", "add", "add two integers without overflow", cfg);
    expect(warning).toBeNull();
  });

  it("emits no warning for all default shallow-allow primitives at depth 0", () => {
    const cfg = makeL4Config({ minDepth: 2 });
    withL4Config(cfg);

    const primitives = ["add", "sub", "mul", "div", "mod", "abs", "min", "max", "clamp", "lerp"];
    for (const prim of primitives) {
      const warning = getAdvisoryWarning("math-utils", prim, `${prim} two numbers`, cfg);
      expect(warning, `${prim} should be shallow-allowed at depth 0`).toBeNull();
    }
  });

  it("emits no warning for a shallow-allowed binding even after one miss", () => {
    const cfg = makeL4Config({ minDepth: 2 });
    withL4Config(cfg);

    recordMiss("math-utils", "add"); // depth = 1

    const warning = getAdvisoryWarning("math-utils", "add", "add two numbers", cfg);
    expect(warning).toBeNull();
  });

  it("emits warning for a non-primitive binding at same depth where primitive would be safe", () => {
    const cfg = makeL4Config({ minDepth: 2 });
    withL4Config(cfg);

    // "isEmail" is not shallow-allowed, even at depth 0
    const warning = getAdvisoryWarning("validator", "isEmail", "validate RFC 5321 email format", cfg);
    expect(warning).not.toBeNull();
    expect(warning?.bindingKey).toBe("isEmail::isEmail"); // canonical atom-key (WI-600)
  });
});

// ---------------------------------------------------------------------------
// Compound interaction: import-intercept miss/hit transitions → substitute reads
//
// This test exercises the real production state-transition sequence:
//   recordMiss (import-intercept "miss" branch) × N
//   getAdvisoryWarning (substitute.ts Layer 4 check)
// Both accessing the same in-memory session Map.
// ---------------------------------------------------------------------------

describe("Compound: import-intercept transitions → substitute advisory", () => {
  it("hit after miss does not increment depth — warning still applies until depth reaches minDepth", () => {
    const cfg = makeL4Config({ minDepth: 2 });
    withL4Config(cfg);

    // One miss + one hit: depth is still 1 (hits do NOT count toward depth)
    recordMiss("validator", "isEmail");
    recordHit("validator", "isEmail");

    expect(getDescentDepth("validator", "isEmail")).toBe(1); // Only misses count

    const warning = getAdvisoryWarning("validator", "isEmail", "validate RFC email", cfg);
    // depth 1 < minDepth 2 → still warn
    expect(warning).not.toBeNull();
    expect(warning?.observedDepth).toBe(1);
  });

  it("two misses then one hit: depth=2 meets minDepth=2 → no warning", () => {
    const cfg = makeL4Config({ minDepth: 2 });
    withL4Config(cfg);

    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");
    recordHit("validator", "isEmail"); // hit recorded but does NOT affect depth

    expect(getDescentDepth("validator", "isEmail")).toBe(2);

    const warning = getAdvisoryWarning("validator", "isEmail", "validate RFC email", cfg);
    expect(warning).toBeNull();
  });

  it("disableTracking=true prevents any warning regardless of depth=0", () => {
    const cfg = makeL4Config({ disableTracking: true });
    withL4Config(cfg);

    // No misses — would normally warn at depth 0
    const warning = getAdvisoryWarning("validator", "isEmail", "validate RFC email", cfg);
    expect(warning).toBeNull();
  });

  it("different packages for same binding name share the same canonical descent record (WI-600 atom-keying)", () => {
    // After WI-600: canonicalKey ignores packageName and keys on atomName only.
    // Two source imports of the same atomName from different packages merge into one record.
    // This is the intended Layer 4 semantic: descent depth is per-atom, not per-import-path.
    // See DEC-HOOK-ENF-LAYER4-KEY-CANONICAL-001 and plan §2 / §4 case 3.
    const cfg = makeL4Config({ minDepth: 2 });
    withL4Config(cfg);

    // Both misses go to the same canonical key "isEmail::isEmail"
    recordMiss("validator", "isEmail");
    recordMiss("my-validator", "isEmail");

    // Depth is 2 (merged) — both call sites agree the atom has been missed twice
    expect(getDescentDepth("validator", "isEmail")).toBe(2);
    expect(getDescentDepth("my-validator", "isEmail")).toBe(2); // same canonical key

    // No warning from either call site: depth 2 >= minDepth 2
    const warnValidator = getAdvisoryWarning("validator", "isEmail", "validate RFC email address", cfg);
    const warnMyValidator = getAdvisoryWarning("my-validator", "isEmail", "validate email RFC format", cfg);

    expect(warnValidator).toBeNull();
    expect(warnMyValidator).toBeNull();
  });

  it("shouldWarn mirrors getAdvisoryWarning null/non-null across the minDepth boundary", () => {
    const cfg = makeL4Config({ minDepth: 2 });

    // At depth 0
    expect(shouldWarn("pkg", "isURL", cfg)).toBe(true);
    expect(getAdvisoryWarning("pkg", "isURL", "validate URL format with scheme", cfg)).not.toBeNull();

    recordMiss("pkg", "isURL"); // depth = 1
    expect(shouldWarn("pkg", "isURL", cfg)).toBe(true);
    expect(getAdvisoryWarning("pkg", "isURL", "validate URL format with scheme", cfg)).not.toBeNull();

    recordMiss("pkg", "isURL"); // depth = 2 (= minDepth)
    expect(shouldWarn("pkg", "isURL", cfg)).toBe(false);
    expect(getAdvisoryWarning("pkg", "isURL", "validate URL format with scheme", cfg)).toBeNull();
  });

  it("session reset clears all tracked state — warning re-fires after reset", () => {
    const cfg = makeL4Config({ minDepth: 2 });
    withL4Config(cfg);

    // Accumulate 2 misses — no warning
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");
    const warnBefore = getAdvisoryWarning("validator", "isEmail", "validate RFC email", cfg);
    expect(warnBefore).toBeNull();

    // Session reset (between test runs / sessions)
    resetSession();

    // After reset: depth = 0 again → warning fires
    const warnAfter = getAdvisoryWarning("validator", "isEmail", "validate RFC email", cfg);
    expect(warnAfter).not.toBeNull();
    expect(warnAfter?.observedDepth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Config-driven: enforcement-config.ts is the sole source of minDepth
// ---------------------------------------------------------------------------

describe("Layer 4 reads thresholds from enforcement-config (not hardcoded)", () => {
  it("custom minDepth=1 from config: single miss is sufficient → no warning", () => {
    const cfg = makeL4Config({ minDepth: 1 });
    withL4Config(cfg);

    recordMiss("validator", "isEmail");
    // depth = 1 >= minDepth = 1 → no warning

    const warning = getAdvisoryWarning("validator", "isEmail", "validate RFC email format", cfg);
    expect(warning).toBeNull();
  });

  it("custom minDepth=5 from config: four misses still insufficient → warning", () => {
    const cfg = makeL4Config({ minDepth: 5 });
    withL4Config(cfg);

    for (let i = 0; i < 4; i++) {
      recordMiss("validator", "isEmail");
    }
    // depth = 4 < minDepth = 5 → warning expected

    const warning = getAdvisoryWarning("validator", "isEmail", "validate RFC email format", cfg);
    expect(warning).not.toBeNull();
    expect(warning?.observedDepth).toBe(4);
    expect(warning?.minDepth).toBe(5);
  });

  it("custom shallowAllowPatterns from config: isEmail allowed → no warning at depth 0", () => {
    const cfg = makeL4Config({
      minDepth: 3,
      shallowAllowPatterns: ["^isEmail$"],
    });
    withL4Config(cfg);

    // Normally would warn at depth 0 with minDepth=3
    // But isEmail is now shallow-allowed via custom pattern
    const warning = getAdvisoryWarning("validator", "isEmail", "validate RFC email address format", cfg);
    expect(warning).toBeNull();
  });

  it("defaults from getDefaults() include layer4 keys with minDepth=2 and non-empty shallowAllowPatterns", () => {
    const defaults = getDefaults();
    expect(defaults.layer4).toBeDefined();
    expect(defaults.layer4.minDepth).toBe(2);
    expect(Array.isArray(defaults.layer4.shallowAllowPatterns)).toBe(true);
    expect(defaults.layer4.shallowAllowPatterns.length).toBeGreaterThan(0);
    expect(defaults.layer4.disableTracking).toBe(false);
  });
});
