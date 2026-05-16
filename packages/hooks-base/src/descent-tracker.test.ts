// SPDX-License-Identifier: MIT
/**
 * descent-tracker.test.ts — Unit tests for Layer 4 descent-depth tracker.
 *
 * Production trigger: runs in the default Vitest suite for @yakcc/hooks-base.
 * Every PR touching packages/hooks-base/src/** will exercise it.
 *
 * Test coverage:
 *   - recordMiss / recordHit increment per binding key
 *   - getDescentDepth returns miss count
 *   - shouldWarn boundary conditions (depth=0, depth=1, depth=2)
 *   - isShallowAllowed with default and custom patterns
 *   - getAdvisoryWarning shape and null return conditions
 *   - Config injection (custom minDepth, custom patterns)
 *   - disableTracking=true short-circuits all warnings
 *   - Session reset isolation
 *
 * @decision DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001 (cross-reference)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordMiss,
  recordHit,
  getDescentDepth,
  getDescentRecord,
  isShallowAllowed,
  shouldWarn,
  getAdvisoryWarning,
  resetSession,
} from "./descent-tracker.js";
import type { Layer4Config } from "./enforcement-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<Layer4Config>): Layer4Config {
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

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetSession();
});

afterEach(() => {
  resetSession();
});

// ---------------------------------------------------------------------------
// recordMiss / recordHit / getDescentDepth
// ---------------------------------------------------------------------------

describe("recordMiss and recordHit", () => {
  it("starts at depth 0 for an unseen binding", () => {
    expect(getDescentDepth("validator", "isEmail")).toBe(0);
  });

  it("increments miss count on each recordMiss", () => {
    recordMiss("validator", "isEmail");
    expect(getDescentDepth("validator", "isEmail")).toBe(1);
    recordMiss("validator", "isEmail");
    expect(getDescentDepth("validator", "isEmail")).toBe(2);
    recordMiss("validator", "isEmail");
    expect(getDescentDepth("validator", "isEmail")).toBe(3);
  });

  it("recordHit increments hit count but does not increment miss count", () => {
    recordHit("validator", "isEmail");
    expect(getDescentDepth("validator", "isEmail")).toBe(0);
    const rec = getDescentRecord("validator", "isEmail");
    expect(rec?.hits).toBe(1);
    expect(rec?.misses).toBe(0);
  });

  it("tracks miss and hit counts independently per binding key", () => {
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");
    recordHit("validator", "isURL");
    recordHit("validator", "isURL");
    recordHit("validator", "isURL");

    expect(getDescentDepth("validator", "isEmail")).toBe(2);
    expect(getDescentDepth("validator", "isURL")).toBe(0);
    expect(getDescentRecord("validator", "isEmail")?.hits).toBe(0);
    expect(getDescentRecord("validator", "isURL")?.hits).toBe(3);
  });

  it("tracks different packages independently", () => {
    recordMiss("validator", "isEmail");
    recordMiss("lodash", "isEmail");
    recordMiss("lodash", "isEmail");

    expect(getDescentDepth("validator", "isEmail")).toBe(1);
    expect(getDescentDepth("lodash", "isEmail")).toBe(2);
  });

  it("getDescentRecord returns null for an unseen binding", () => {
    expect(getDescentRecord("never-seen", "binding")).toBeNull();
  });

  it("mixed miss then hit pattern accumulates correctly", () => {
    recordMiss("pkg", "fn");
    recordMiss("pkg", "fn");
    recordHit("pkg", "fn");
    const rec = getDescentRecord("pkg", "fn");
    expect(rec?.misses).toBe(2);
    expect(rec?.hits).toBe(1);
    expect(getDescentDepth("pkg", "fn")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// isShallowAllowed
// ---------------------------------------------------------------------------

describe("isShallowAllowed", () => {
  const defaultPatterns = makeConfig().shallowAllowPatterns;

  it("returns true for exact arithmetic primitive names", () => {
    for (const name of ["add", "sub", "mul", "div", "mod", "abs", "min", "max", "clamp", "lerp"]) {
      expect(isShallowAllowed(name, defaultPatterns), `${name} should be shallow-allowed`).toBe(true);
    }
  });

  it("returns false for non-primitive binding names", () => {
    for (const name of ["isEmail", "validate", "parse", "someAddHelper"]) {
      expect(isShallowAllowed(name, defaultPatterns), `${name} should NOT be shallow-allowed`).toBe(false);
    }
  });

  it("is case-insensitive", () => {
    expect(isShallowAllowed("ADD", defaultPatterns)).toBe(true);
    expect(isShallowAllowed("Add", defaultPatterns)).toBe(true);
    expect(isShallowAllowed("SUB", defaultPatterns)).toBe(true);
  });

  it("uses ^ and $ anchors — partial matches do not qualify", () => {
    // "someAdd" does not match "^add$"
    expect(isShallowAllowed("someAdd", defaultPatterns)).toBe(false);
    expect(isShallowAllowed("addSome", defaultPatterns)).toBe(false);
  });

  it("returns false with an empty pattern list", () => {
    expect(isShallowAllowed("add", [])).toBe(false);
  });

  it("handles custom patterns", () => {
    const custom = ["^isEmail$", "^isURL$"];
    expect(isShallowAllowed("isEmail", custom)).toBe(true);
    expect(isShallowAllowed("isURL", custom)).toBe(true);
    expect(isShallowAllowed("add", custom)).toBe(false);
  });

  it("silently skips invalid regex patterns", () => {
    // An invalid regex should not throw — just be skipped.
    const withInvalid = ["[invalid", "^add$"];
    expect(() => isShallowAllowed("add", withInvalid)).not.toThrow();
    expect(isShallowAllowed("add", withInvalid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldWarn
// ---------------------------------------------------------------------------

describe("shouldWarn", () => {
  it("returns true at depth=0 (no prior misses) for a non-shallow-allowed binding", () => {
    const cfg = makeConfig({ minDepth: 2 });
    expect(shouldWarn("validator", "isEmail", cfg)).toBe(true);
  });

  it("returns true at depth=1 (one prior miss) when minDepth=2", () => {
    recordMiss("validator", "isEmail");
    const cfg = makeConfig({ minDepth: 2 });
    expect(shouldWarn("validator", "isEmail", cfg)).toBe(true);
  });

  it("returns false at depth=2 (exactly minDepth=2)", () => {
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");
    const cfg = makeConfig({ minDepth: 2 });
    expect(shouldWarn("validator", "isEmail", cfg)).toBe(false);
  });

  it("returns false at depth > minDepth", () => {
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");
    const cfg = makeConfig({ minDepth: 2 });
    expect(shouldWarn("validator", "isEmail", cfg)).toBe(false);
  });

  it("returns false when binding matches shallow-allow pattern (depth=0)", () => {
    const cfg = makeConfig({ minDepth: 2 });
    // "add" matches "^add$" — no warning even at depth 0
    expect(shouldWarn("math-pkg", "add", cfg)).toBe(false);
  });

  it("returns false when binding matches shallow-allow pattern (depth=1)", () => {
    recordMiss("math-pkg", "sub");
    const cfg = makeConfig({ minDepth: 2 });
    expect(shouldWarn("math-pkg", "sub", cfg)).toBe(false);
  });

  it("returns false when disableTracking=true regardless of depth", () => {
    const cfg = makeConfig({ disableTracking: true });
    // No misses recorded — depth=0, would normally warn.
    expect(shouldWarn("validator", "isEmail", cfg)).toBe(false);
  });

  it("respects custom minDepth=0 — never warns (depth always >= 0)", () => {
    const cfg = makeConfig({ minDepth: 0 });
    expect(shouldWarn("validator", "isEmail", cfg)).toBe(false);
  });

  it("respects custom minDepth=5", () => {
    recordMiss("pkg", "fn");
    recordMiss("pkg", "fn");
    recordMiss("pkg", "fn");
    recordMiss("pkg", "fn");
    const cfg = makeConfig({ minDepth: 5 });
    // 4 misses < 5 → warn
    expect(shouldWarn("pkg", "fn", cfg)).toBe(true);
    recordMiss("pkg", "fn");
    // 5 misses >= 5 → no warn
    expect(shouldWarn("pkg", "fn", cfg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAdvisoryWarning
// ---------------------------------------------------------------------------

describe("getAdvisoryWarning", () => {
  it("returns null when depth >= minDepth", () => {
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");
    const cfg = makeConfig({ minDepth: 2 });
    const result = getAdvisoryWarning("validator", "isEmail", "some intent", cfg);
    expect(result).toBeNull();
  });

  it("returns null for shallow-allowed binding at depth=0", () => {
    const cfg = makeConfig({ minDepth: 2 });
    const result = getAdvisoryWarning("math", "add", "add two numbers", cfg);
    expect(result).toBeNull();
  });

  it("returns null when disableTracking=true", () => {
    const cfg = makeConfig({ disableTracking: true });
    const result = getAdvisoryWarning("validator", "isEmail", "validate email", cfg);
    expect(result).toBeNull();
  });

  it("returns a DescentBypassWarning at depth=0 for a non-shallow binding", () => {
    const cfg = makeConfig({ minDepth: 2 });
    const result = getAdvisoryWarning("validator", "isEmail", "validate email RFC 5321", cfg);
    expect(result).not.toBeNull();
    expect(result?.layer).toBe(4);
    expect(result?.status).toBe("descent-bypass-warning");
    expect(result?.bindingKey).toBe("validator::isEmail");
    expect(result?.observedDepth).toBe(0);
    expect(result?.minDepth).toBe(2);
    expect(result?.intent).toBe("validate email RFC 5321");
    expect(typeof result?.suggestion).toBe("string");
    expect(result?.suggestion.length).toBeGreaterThan(0);
  });

  it("returns a DescentBypassWarning at depth=1", () => {
    recordMiss("validator", "isEmail");
    const cfg = makeConfig({ minDepth: 2 });
    const result = getAdvisoryWarning("validator", "isEmail", "validate RFC 5321 email", cfg);
    expect(result).not.toBeNull();
    expect(result?.observedDepth).toBe(1);
    expect(result?.bindingKey).toBe("validator::isEmail");
  });

  it("suggestion text references the binding key and depths", () => {
    const cfg = makeConfig({ minDepth: 3 });
    const result = getAdvisoryWarning("validator", "isIP", "check IP address format", cfg);
    expect(result?.suggestion).toContain("validator::isIP");
    expect(result?.suggestion).toContain("0");   // observedDepth
    expect(result?.suggestion).toContain("3");   // minDepth
  });

  it("custom shallowAllowPatterns override: binding now allowed → null", () => {
    const cfg = makeConfig({ shallowAllowPatterns: ["^isEmail$"] });
    const result = getAdvisoryWarning("validator", "isEmail", "validate email", cfg);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session reset
// ---------------------------------------------------------------------------

describe("resetSession", () => {
  it("clears all tracked bindings", () => {
    recordMiss("validator", "isEmail");
    recordMiss("validator", "isEmail");
    recordHit("validator", "isURL");
    resetSession();
    expect(getDescentDepth("validator", "isEmail")).toBe(0);
    expect(getDescentRecord("validator", "isURL")).toBeNull();
  });

  it("allows fresh tracking after reset", () => {
    recordMiss("validator", "isEmail");
    resetSession();
    recordMiss("validator", "isEmail");
    expect(getDescentDepth("validator", "isEmail")).toBe(1);
  });
});
