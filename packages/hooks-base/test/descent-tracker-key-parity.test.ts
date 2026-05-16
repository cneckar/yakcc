// SPDX-License-Identifier: MIT
/**
 * descent-tracker-key-parity.test.ts — End-to-end key parity proof for WI-600.
 *
 * @decision DEC-HOOK-ENF-LAYER4-KEY-CANONICAL-001 (implementation proof)
 *
 * Problem being proven:
 *   Before WI-600, substitute.ts called getAdvisoryWarning("isEmail", "isEmail", ...)
 *   (atomName used as packageName proxy → key "isEmail::isEmail") while import-intercept.ts
 *   called recordMiss("validator", "isEmail") (real moduleSpecifier → key "validator::isEmail").
 *   The two keys never matched, so Layer 4 warnings fired for ~100% of non-shallow-allowed
 *   bindings regardless of recorded descent depth.
 *
 * Fix being proven:
 *   descent-tracker.ts now derives all storage keys via canonicalKey(_packageName, binding)
 *   which returns makeBindingKey(binding, binding) = "binding::binding". The packageName
 *   argument is ignored. Both call sites (with different packageName values) converge on
 *   the same canonical key.
 *
 * Production trigger:
 *   1. import-intercept resolves an import binding → recordMiss(moduleSpecifier, bindingName)
 *      or recordHit(moduleSpecifier, bindingName).
 *   2. substitute.ts executes substitution → getAdvisoryWarning(atomName, atomName, intent, cfg).
 *   3. Layer 4 reads the depth accumulated by step 1 from the same map location as step 2.
 *
 * These tests exercise the real production crossover: record on one side, read on the other.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordMiss,
  recordHit,
  getDescentDepth,
  getAdvisoryWarning,
  resetSession,
} from "../src/descent-tracker.js";
import type { Layer4Config } from "../src/enforcement-config.js";

// ---------------------------------------------------------------------------
// Test helper — minimal Layer4Config factory
// ---------------------------------------------------------------------------

function makeL4Config(overrides?: Partial<Layer4Config>): Layer4Config {
  return {
    minDepth: 2,
    shallowAllowPatterns: ["^add$", "^sub$", "^mul$", "^div$"],
    disableTracking: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Session isolation
// ---------------------------------------------------------------------------

beforeEach(() => resetSession());
afterEach(() => resetSession());

// ---------------------------------------------------------------------------
// Case 1: Production crossover — import-intercept records, substitute reads
//
// Simulates: import-intercept records 3 misses for "isEmail" from "validator"
//            (the real moduleSpecifier path).
//            substitute.ts then calls getAdvisoryWarning("isEmail", "isEmail", ...)
//            (the atomName-proxy path — packageName === atomName).
//
// Before WI-600: keys diverge ("validator::isEmail" vs "isEmail::isEmail") → depth = 0 → always warns.
// After WI-600:  both resolve to "isEmail::isEmail" → depth = 3 → no warning.
// ---------------------------------------------------------------------------

describe("Case 1: import-intercept miss path → substitute advisory path convergence", () => {
  it("recordMiss(moduleSpecifier, binding) and getAdvisoryWarning(atomName, binding) share one descent record", () => {
    const cfg = makeL4Config({ minDepth: 2 });

    // Simulate import-intercept recording 3 misses with the real moduleSpecifier
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");

    // Simulate substitute.ts reading with atomName as packageName proxy
    // (the v1 call shape: packageName = binding.atomName, binding = binding.atomName)
    const warning = getAdvisoryWarning("isEmail", "isEmail", "const foo = isEmail(x);", cfg);

    // Keys converged: depth = 3 >= minDepth = 2 → no warning (the bug is fixed)
    expect(warning).toBeNull();
  });

  it("observedDepth in warning equals the miss count recorded by import-intercept path", () => {
    const cfg = makeL4Config({ minDepth: 5 }); // set high so we can observe depth < minDepth

    // 3 misses from import-intercept side
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");

    // substitute.ts reads via atomName proxy
    const warning = getAdvisoryWarning("isEmail", "isEmail", "const foo = isEmail(x);", cfg);

    // depth = 3 < minDepth = 5 → warning fires; observedDepth must reflect the 3 misses
    expect(warning).not.toBeNull();
    expect(warning?.observedDepth).toBe(3);
    expect(warning?.bindingKey).toBe("isEmail::isEmail"); // canonical atom-key
  });
});

// ---------------------------------------------------------------------------
// Case 2: Layer 4 warning fires ONLY when descent < minDepth
//
// This is the core "advisory warning suppression" proof from the acceptance contract.
// Warning threshold is minDepth; exactly reaching minDepth suppresses the warning.
// ---------------------------------------------------------------------------

describe("Case 2: warning suppression at minDepth boundary", () => {
  it("1 miss with minDepth=2 → warning fires (depth 1 < 2)", () => {
    const cfg = makeL4Config({ minDepth: 2 });

    recordMiss("validator", "isEmail");

    const warning = getAdvisoryWarning("isEmail", "isEmail", "const foo = isEmail(x);", cfg);

    expect(warning).not.toBeNull();
    expect(warning?.observedDepth).toBe(1);
    expect(warning?.minDepth).toBe(2);
    expect(warning?.bindingKey).toBe("isEmail::isEmail");
  });

  it("2 misses with minDepth=2 → warning suppressed (depth 2 >= 2)", () => {
    const cfg = makeL4Config({ minDepth: 2 });

    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");

    const warning = getAdvisoryWarning("isEmail", "isEmail", "const foo = isEmail(x);", cfg);

    expect(warning).toBeNull();
  });

  it("0 misses with minDepth=2 → warning fires (depth 0 < 2)", () => {
    const cfg = makeL4Config({ minDepth: 2 });

    // No prior recordMiss calls at all
    const warning = getAdvisoryWarning("isEmail", "isEmail", "const foo = isEmail(x);", cfg);

    expect(warning).not.toBeNull();
    expect(warning?.observedDepth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 3: Cross-import atom-collision (canonical merging — positive test)
//
// Proves the intended semantic: two source imports with the same atomName but
// different moduleSpecifiers share one descent record. This is the WI-600 trade-off
// documented in DEC-HOOK-ENF-LAYER4-KEY-CANONICAL-001.
// ---------------------------------------------------------------------------

describe("Case 3: cross-package same-atom descent merging", () => {
  it("recordMiss from two different packages for the same binding name contribute to one depth count", () => {
    const cfg = makeL4Config({ minDepth: 2 });

    // Two different source imports of the same logical atom "isEmail"
    recordMiss("validator", "isEmail");          // "validator" package
    recordMiss("is-email-validator", "isEmail"); // different package, same atomName

    // Both contribute to the same canonical record
    expect(getDescentDepth("validator", "isEmail")).toBe(2);
    expect(getDescentDepth("is-email-validator", "isEmail")).toBe(2); // same canonical key

    // depth = 2 >= minDepth = 2 → no warning from either call site
    const warn1 = getAdvisoryWarning("isEmail", "isEmail", "check RFC email", cfg);
    expect(warn1).toBeNull();
  });

  it("getDescentDepth returns the same count regardless of which packageName is passed", () => {
    recordMiss("validator", "isEmail");
    recordMiss("my-validator", "isEmail");
    recordMiss("another-lib", "isEmail");

    // All three read from the same canonical record
    expect(getDescentDepth("validator", "isEmail")).toBe(3);
    expect(getDescentDepth("my-validator", "isEmail")).toBe(3);
    expect(getDescentDepth("another-lib", "isEmail")).toBe(3);
    expect(getDescentDepth("isEmail", "isEmail")).toBe(3); // atomName-proxy form
  });
});

// ---------------------------------------------------------------------------
// Case 4: Shallow-allow bypass still suppresses warnings independent of key shape
//
// Proves that the shallowAllowPatterns gate is unaffected by the canonical-key change.
// ---------------------------------------------------------------------------

describe("Case 4: shallow-allow bypass independent of canonical key", () => {
  it("shallowAllowPatterns matching binding name suppresses warning at depth 0", () => {
    const cfg = makeL4Config({ minDepth: 3, shallowAllowPatterns: ["^isEmail$"] });

    // No misses at all — would normally fire at depth 0 with minDepth=3
    // But "isEmail" matches the shallow-allow pattern
    const warning = getAdvisoryWarning("isEmail", "isEmail", "check RFC email", cfg);

    expect(warning).toBeNull();
  });

  it("shallowAllowPatterns bypass holds even after misses accumulate", () => {
    const cfg = makeL4Config({ minDepth: 3, shallowAllowPatterns: ["^isEmail$"] });

    recordMiss("validator", "isEmail"); // still shallow-allowed

    const warning = getAdvisoryWarning("isEmail", "isEmail", "check RFC email", cfg);
    expect(warning).toBeNull();
  });

  it("non-shallow-allowed binding still fires warning when depth < minDepth after canonical fix", () => {
    const cfg = makeL4Config({ minDepth: 3, shallowAllowPatterns: ["^add$"] });

    // "isEmail" is not in shallowAllowPatterns, 1 miss, minDepth=3 → warning
    recordMiss("validator", "isEmail");

    const warning = getAdvisoryWarning("isEmail", "isEmail", "check RFC email", cfg);
    expect(warning).not.toBeNull();
    expect(warning?.bindingKey).toBe("isEmail::isEmail");
  });
});

// ---------------------------------------------------------------------------
// Compound interaction: full production sequence end-to-end
//
// Exercises: recordMiss (import-intercept path, real moduleSpecifier)
//            × N calls across multiple bindings
//          → getAdvisoryWarning (substitute path, atomName proxy)
//          → session reset → repeat
//
// This is the required compound-interaction test per implementer constitution.
// ---------------------------------------------------------------------------

describe("Compound: full production sequence with session lifecycle", () => {
  it("production crossover: import-intercept misses accumulate, substitute reads depth, reset clears", () => {
    const cfg = makeL4Config({ minDepth: 2 });

    // Phase 1: import-intercept records misses (real moduleSpecifier path)
    recordMiss("validator", "isEmail");   // depth for "isEmail" → 1
    recordMiss("lodash", "cloneDeep");    // depth for "cloneDeep" → 1
    recordMiss("validator", "isEmail");   // depth for "isEmail" → 2

    // Phase 2: substitute.ts reads via atomName proxy
    // "isEmail": depth=2 >= minDepth=2 → no warning
    const warnIsEmail = getAdvisoryWarning("isEmail", "isEmail", "validate email", cfg);
    expect(warnIsEmail).toBeNull();

    // "cloneDeep": depth=1 < minDepth=2 → warning fires
    const warnCloneDeep = getAdvisoryWarning("cloneDeep", "cloneDeep", "deep clone object", cfg);
    expect(warnCloneDeep).not.toBeNull();
    expect(warnCloneDeep?.observedDepth).toBe(1);
    expect(warnCloneDeep?.bindingKey).toBe("cloneDeep::cloneDeep");

    // Phase 3: session reset (simulating new session / test isolation)
    resetSession();

    // After reset: all depths = 0 → warnings fire again
    const warnIsEmailAfterReset = getAdvisoryWarning("isEmail", "isEmail", "validate email", cfg);
    expect(warnIsEmailAfterReset).not.toBeNull();
    expect(warnIsEmailAfterReset?.observedDepth).toBe(0);
  });

  it("recordHit does not increment depth — warning still fires until misses reach minDepth", () => {
    const cfg = makeL4Config({ minDepth: 2 });

    // One miss + one hit: depth = 1 (hits do NOT count toward depth)
    recordMiss("validator", "isEmail");
    recordHit("validator", "isEmail");

    const warning = getAdvisoryWarning("isEmail", "isEmail", "validate email", cfg);

    // depth = 1 < minDepth = 2 → warning fires (hit did not satisfy the descent requirement)
    expect(warning).not.toBeNull();
    expect(warning?.observedDepth).toBe(1);
  });
});
