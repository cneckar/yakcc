// SPDX-License-Identifier: MIT
/**
 * atom-size-ratio.test.ts — Unit tests for Layer 3 atom-size ratio enforcement.
 *
 * @decision DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001
 * title: Layer 3 unit tests — parameterized over (atomComplexity, needComplexity) pairs
 * status: decided (wi-591-s3-layer3)
 * rationale:
 *   Tests exercise the real production sequence:
 *     1. computeAtomComplexity(atom) — spec-based proxy computation
 *     2. computeNeedComplexity(callSite) — call-site proxy computation
 *     3. enforceAtomSizeRatio(atom, callSite, config) — gate verdict
 *   All thresholds injected via Layer3Config parameter (not env vars or files).
 *   Covers: boundary conditions, minFloor bypass, config injection, edge cases.
 *
 * Production trigger: vitest default suite for @yakcc/hooks-base.
 * Every PR touching packages/hooks-base/src/** will exercise it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeAtomComplexity,
  computeNeedComplexity,
  enforceAtomSizeRatio,
  isAtomSizeOk,
  type AtomLike,
  type CallSiteAnalysis,
} from "./atom-size-ratio.js";
import type { Layer3Config } from "./enforcement-config.js";
import { resetConfigOverride, setConfigOverride, getDefaults } from "./enforcement-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default Layer3Config matching getDefaults().layer3 */
const DEFAULT_L3_CFG: Layer3Config = {
  ratioThreshold: 10,
  minFloor: 20,
  disableGate: false,
};

/**
 * Build a minimal AtomLike with direct complexity control.
 *
 * @param inputs    - spec.inputs count (part of transitiveNodes proxy)
 * @param outputs   - spec.outputs count (part of transitiveNodes proxy + exportedSurface)
 * @param guarantees - spec.guarantees count (part of transitiveNodes proxy)
 * @param transitiveDeps - transitive dependency count
 */
function makeAtom(opts: {
  inputs?: number;
  outputs?: number;
  guarantees?: number;
  transitiveDeps?: number;
}): AtomLike {
  const inputs = opts.inputs ?? 0;
  const outputs = opts.outputs ?? 0;
  const guarantees = opts.guarantees ?? 0;
  const transitiveDeps = opts.transitiveDeps ?? 0;

  // exportedSurface = outputs.length (v1 proxy)
  return {
    spec: {
      behavior: "stub",
      inputs: Array.from({ length: inputs }, (_, i) => ({ name: `in${i}`, type: "string" })),
      outputs: Array.from({ length: outputs }, (_, i) => ({ name: `out${i}`, type: "string" })),
      guarantees: Array.from({ length: guarantees }, (_, i) => ({ description: `g${i}` })),
      errorConditions: [],
      nonFunctional: { purity: "pure", threadSafety: "safe" },
      propertyTests: [],
    } as unknown as import("@yakcc/contracts").SpecYak,
    exportedSurface: outputs,
    transitiveDeps,
  };
}

function makeCallSite(bindingsUsed: number, statementCount: number): CallSiteAnalysis {
  return { bindingsUsed, statementCount };
}

// ---------------------------------------------------------------------------
// computeAtomComplexity
// ---------------------------------------------------------------------------

describe("computeAtomComplexity", () => {
  it("returns 0 for a zero-spec atom with no deps", () => {
    const atom = makeAtom({});
    expect(computeAtomComplexity(atom)).toBe(0);
  });

  it("counts transitiveNodes = inputs + outputs + guarantees", () => {
    // inputs=2, outputs=3, guarantees=1 → transitiveNodes=6, exportedSurface=3, deps=0
    // atomComplexity = 6 + 5*3 + 2*0 = 6 + 15 = 21
    const atom = makeAtom({ inputs: 2, outputs: 3, guarantees: 1 });
    expect(computeAtomComplexity(atom)).toBe(21);
  });

  it("applies 5x weight to exportedSurface", () => {
    // outputs=4 → transitiveNodes=4, exportedSurface=4
    // atomComplexity = 4 + 5*4 = 24
    const atom = makeAtom({ outputs: 4 });
    expect(computeAtomComplexity(atom)).toBe(24);
  });

  it("applies 2x weight to transitiveDeps", () => {
    // transitiveDeps=10 → atomComplexity = 0 + 0 + 2*10 = 20
    const atom = makeAtom({ transitiveDeps: 10 });
    expect(computeAtomComplexity(atom)).toBe(20);
  });

  it("combines all three terms correctly (lodash-shaped atom proxy)", () => {
    // inputs=5, outputs=10, guarantees=5, deps=20
    // transitiveNodes = 20, exportedSurface = 10
    // atomComplexity = 20 + 5*10 + 2*20 = 20 + 50 + 40 = 110
    const atom = makeAtom({ inputs: 5, outputs: 10, guarantees: 5, transitiveDeps: 20 });
    expect(computeAtomComplexity(atom)).toBe(110);
  });
});

// ---------------------------------------------------------------------------
// computeNeedComplexity
// ---------------------------------------------------------------------------

describe("computeNeedComplexity", () => {
  it("returns 1 for zero-zero call site (floor prevents 0)", () => {
    expect(computeNeedComplexity({ bindingsUsed: 0, statementCount: 0 })).toBe(1);
  });

  it("returns max(1, product) for normal inputs", () => {
    expect(computeNeedComplexity({ bindingsUsed: 2, statementCount: 3 })).toBe(6);
    expect(computeNeedComplexity({ bindingsUsed: 1, statementCount: 5 })).toBe(5);
  });

  it("applies floor when product is 0 (one factor is 0)", () => {
    expect(computeNeedComplexity({ bindingsUsed: 0, statementCount: 10 })).toBe(1);
    expect(computeNeedComplexity({ bindingsUsed: 5, statementCount: 0 })).toBe(1);
  });

  it("returns 1 for bindingsUsed=1, statementCount=1", () => {
    expect(computeNeedComplexity({ bindingsUsed: 1, statementCount: 1 })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// enforceAtomSizeRatio — accept cases
// ---------------------------------------------------------------------------

describe("enforceAtomSizeRatio — accept (ok)", () => {
  it("accepts when ratio is well below threshold", () => {
    // atomComplexity=10, needComplexity=2 → ratio=5 < 10
    const atom = makeAtom({ inputs: 2, outputs: 0, guarantees: 0, transitiveDeps: 4 });
    // transitiveNodes=2, exportedSurface=0, deps=4 → 2 + 0 + 8 = 10
    const callSite = makeCallSite(2, 1); // needComplexity = max(1, 2*1) = 2
    const result = enforceAtomSizeRatio(atom, callSite, DEFAULT_L3_CFG);
    expect(result.status).toBe("ok");
    expect(result.layer).toBe(3);
    if (result.status === "ok") {
      expect(result.bypassed).toBe(false);
      expect(result.ratio).toBe(5);
    }
  });

  it("accepts when ratio is exactly at threshold (boundary: reject is STRICTLY greater)", () => {
    // We need atomComplexity / needComplexity == 10 exactly
    // Let atomComplexity = 20, needComplexity = 2 → ratio = 10 (NOT > 10, so accept)
    // makeAtom: transitiveDeps=10 → atomComplexity = 0 + 0 + 20 = 20 ≥ minFloor=20, so bypass is false
    const atom = makeAtom({ transitiveDeps: 10 }); // atomComplexity = 20
    const callSite = makeCallSite(2, 1); // needComplexity = 2
    const result = enforceAtomSizeRatio(atom, callSite, DEFAULT_L3_CFG);
    // ratio = 20/2 = 10; 10 > 10 is false → accept
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.ratio).toBe(10);
      expect(result.bypassed).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// enforceAtomSizeRatio — reject cases
// ---------------------------------------------------------------------------

describe("enforceAtomSizeRatio — reject (atom-size-too-large)", () => {
  it("rejects when ratio is 10.something > ratioThreshold=10", () => {
    // atomComplexity=21, needComplexity=2 → ratio=10.5 > 10 → reject
    // makeAtom: inputs=2, outputs=3, guarantees=1 → transitiveNodes=6, exportedSurface=3
    // atomComplexity = 6 + 5*3 + 0 = 21 ≥ minFloor=20, no bypass
    const atom = makeAtom({ inputs: 2, outputs: 3, guarantees: 1 });
    const callSite = makeCallSite(2, 1); // needComplexity = 2
    const result = enforceAtomSizeRatio(atom, callSite, DEFAULT_L3_CFG);
    // ratio = 21/2 = 10.5 > 10 → reject
    expect(result.status).toBe("atom-size-too-large");
    expect(result.layer).toBe(3);
    if (result.status === "atom-size-too-large") {
      expect(result.atomComplexity).toBe(21);
      expect(result.needComplexity).toBe(2);
      expect(result.ratio).toBeCloseTo(10.5);
      expect(result.ratioThreshold).toBe(10);
      expect(result.suggestion).toContain("ATOM_OVERSIZED");
      expect(result.suggestion).toContain("Decompose");
    }
  });

  it("rejects a lodash-shaped atom (high complexity vs minimal need)", () => {
    // lodash-shaped: inputs=5, outputs=10, guarantees=5, transitiveDeps=20
    // atomComplexity = 110, needComplexity = max(1, 1*1) = 1 → ratio = 110 >> 10
    const atom = makeAtom({ inputs: 5, outputs: 10, guarantees: 5, transitiveDeps: 20 });
    const callSite = makeCallSite(1, 1);
    const result = enforceAtomSizeRatio(atom, callSite, DEFAULT_L3_CFG);
    expect(result.status).toBe("atom-size-too-large");
    if (result.status === "atom-size-too-large") {
      expect(result.ratio).toBe(110);
    }
  });
});

// ---------------------------------------------------------------------------
// enforceAtomSizeRatio — minFloor bypass
// ---------------------------------------------------------------------------

describe("enforceAtomSizeRatio — minFloor bypass", () => {
  it("bypasses ratio check when atomComplexity < minFloor (even if ratio would be huge)", () => {
    // atomComplexity = 5 (< minFloor=20) → bypass always, even ratio=infinity
    const atom = makeAtom({ inputs: 1, outputs: 1, guarantees: 0, transitiveDeps: 0 });
    // transitiveNodes=2, exportedSurface=1 → atomComplexity = 2 + 5*1 + 0 = 7 < 20
    const callSite = makeCallSite(1, 1); // needComplexity = 1
    // If the gate ran: ratio = 7/1 = 7 < 10 → would accept anyway. Use ratio threshold=1 to force rejection.
    const customCfg: Layer3Config = { ratioThreshold: 1, minFloor: 20, disableGate: false };
    const result = enforceAtomSizeRatio(atom, callSite, customCfg);
    // atomComplexity=7 < minFloor=20 → bypass, status=ok
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.bypassed).toBe(true);
    }
  });

  it("does NOT bypass when atomComplexity equals minFloor", () => {
    // atomComplexity = 20 (= minFloor=20) → NOT < minFloor, gate runs
    // transitiveDeps=10 → atomComplexity = 0 + 0 + 20 = 20 (not < 20 → no bypass)
    const atom = makeAtom({ transitiveDeps: 10 }); // atomComplexity = 20
    const callSite = makeCallSite(1, 1); // needComplexity = 1
    // ratio = 20/1 = 20 > ratioThreshold=10 → reject
    const result = enforceAtomSizeRatio(atom, callSite, DEFAULT_L3_CFG);
    expect(result.status).toBe("atom-size-too-large");
    if (result.status === "atom-size-too-large") {
      expect(result.ratio).toBe(20);
    }
  });

  it("bypass occurs when atomComplexity is strictly below minFloor (boundary -1)", () => {
    // atomComplexity = 19 (< minFloor=20) → bypass
    // Need: transitiveNodes + 5*exportedSurface + 2*deps = 19
    // inputs=4, outputs=3, guarantees=0, deps=0 → transitiveNodes=7, exportedSurface=3
    // atomComplexity = 7 + 15 + 0 = 22 — too high. Try: inputs=1, outputs=0, deps=9
    // transitiveNodes=1, exportedSurface=0, deps=9 → 1 + 0 + 18 = 19 < 20 → bypass
    const atom = makeAtom({ inputs: 1, outputs: 0, guarantees: 0, transitiveDeps: 9 });
    const callSite = makeCallSite(1, 1);
    // With ratioThreshold=1 to force rejection if gate ran
    const customCfg: Layer3Config = { ratioThreshold: 1, minFloor: 20, disableGate: false };
    const result = enforceAtomSizeRatio(atom, callSite, customCfg);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.bypassed).toBe(true);
      expect(result.atomComplexity).toBe(19);
    }
  });
});

// ---------------------------------------------------------------------------
// enforceAtomSizeRatio — custom config injection
// ---------------------------------------------------------------------------

describe("enforceAtomSizeRatio — config injection", () => {
  it("respects custom ratioThreshold (lower → rejects earlier)", () => {
    // atomComplexity=21, needComplexity=2 → ratio=10.5
    // Default threshold=10: reject. Custom threshold=11: accept.
    const atom = makeAtom({ inputs: 2, outputs: 3, guarantees: 1 }); // atomComplexity=21
    const callSite = makeCallSite(2, 1); // needComplexity=2
    const laxCfg: Layer3Config = { ratioThreshold: 11, minFloor: 20, disableGate: false };
    expect(enforceAtomSizeRatio(atom, callSite, laxCfg).status).toBe("ok");
    const strictCfg: Layer3Config = { ratioThreshold: 5, minFloor: 20, disableGate: false };
    expect(enforceAtomSizeRatio(atom, callSite, strictCfg).status).toBe("atom-size-too-large");
  });

  it("respects custom minFloor (higher → more atoms bypass)", () => {
    // atomComplexity=21 ≥ default minFloor=20 → gate runs, may reject.
    // With minFloor=25: 21 < 25 → bypass → always accept.
    const atom = makeAtom({ inputs: 2, outputs: 3, guarantees: 1 }); // atomComplexity=21
    const callSite = makeCallSite(1, 1); // needComplexity=1 → ratio=21 > threshold=10 → would reject
    const highFloorCfg: Layer3Config = { ratioThreshold: 10, minFloor: 25, disableGate: false };
    const result = enforceAtomSizeRatio(atom, callSite, highFloorCfg);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.bypassed).toBe(true);
    }
  });

  it("uses global config when no config param is passed", () => {
    // Set a config override via setConfigOverride and verify enforceAtomSizeRatio picks it up.
    const defaults = getDefaults();
    setConfigOverride({
      ...defaults,
      layer3: { ratioThreshold: 1000, minFloor: 0, disableGate: false },
    });
    // ratio=110 < 1000 → accept with global config
    const atom = makeAtom({ inputs: 5, outputs: 10, guarantees: 5, transitiveDeps: 20 }); // atomComplexity=110
    const callSite = makeCallSite(1, 1);
    // No config param — will read from getEnforcementConfig().layer3 (our override)
    const result = enforceAtomSizeRatio(atom, callSite);
    expect(result.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// isAtomSizeOk convenience predicate
// ---------------------------------------------------------------------------

describe("isAtomSizeOk", () => {
  it("returns true when enforceAtomSizeRatio returns ok", () => {
    const atom = makeAtom({ transitiveDeps: 10 }); // atomComplexity=20, ratio=10 with needComplexity=2
    const callSite = makeCallSite(2, 1);
    expect(isAtomSizeOk(atom, callSite, DEFAULT_L3_CFG)).toBe(true);
  });

  it("returns false when enforceAtomSizeRatio returns atom-size-too-large", () => {
    const atom = makeAtom({ inputs: 5, outputs: 10, guarantees: 5, transitiveDeps: 20 }); // atomComplexity=110
    const callSite = makeCallSite(1, 1);
    expect(isAtomSizeOk(atom, callSite, DEFAULT_L3_CFG)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("enforceAtomSizeRatio — edge cases", () => {
  it("zero-complexity atom with minFloor=0 and ratio > threshold → reject", () => {
    // atomComplexity=0, needComplexity=1 → ratio=0 — never > any positive threshold
    const atom = makeAtom({});
    const callSite = makeCallSite(1, 1);
    const zeroFloorCfg: Layer3Config = { ratioThreshold: 10, minFloor: 0, disableGate: false };
    // ratio=0 < 10 → accept
    const result = enforceAtomSizeRatio(atom, callSite, zeroFloorCfg);
    expect(result.status).toBe("ok");
  });

  it("very large needComplexity reduces ratio to safe zone", () => {
    // atomComplexity=110, needComplexity=50 → ratio=2.2 < 10 → accept
    const atom = makeAtom({ inputs: 5, outputs: 10, guarantees: 5, transitiveDeps: 20 }); // 110
    const callSite = makeCallSite(10, 5); // needComplexity = max(1, 50) = 50
    const result = enforceAtomSizeRatio(atom, callSite, DEFAULT_L3_CFG);
    expect(result.status).toBe("ok");
  });

  it("rejection carries ratioThreshold in envelope for telemetry", () => {
    const atom = makeAtom({ inputs: 5, outputs: 10, guarantees: 5, transitiveDeps: 20 }); // 110
    const callSite = makeCallSite(1, 1);
    const result = enforceAtomSizeRatio(atom, callSite, DEFAULT_L3_CFG);
    expect(result.status).toBe("atom-size-too-large");
    if (result.status === "atom-size-too-large") {
      expect(result.ratioThreshold).toBe(10);
      expect(typeof result.suggestion).toBe("string");
      expect(result.suggestion.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Config reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetConfigOverride();
});

afterEach(() => {
  resetConfigOverride();
});
