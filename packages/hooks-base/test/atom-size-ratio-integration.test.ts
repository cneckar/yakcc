// SPDX-License-Identifier: MIT
// @mock-exempt: Registry is an external service boundary (@yakcc/registry wraps sqlite-vec).
// Using plain in-memory stub objects (no vi.fn()) following the makeRegistryStub()
// pattern from result-set-size-integration.test.ts.
/**
 * atom-size-ratio-integration.test.ts — Layer 3 integration tests.
 *
 * @decision DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001
 * title: Layer 3 integration — atom-size ratio gate through substitute.ts pipeline
 * status: decided (wi-591-s3-layer3)
 * rationale:
 *   Unit tests in atom-size-ratio.test.ts verify enforceAtomSizeRatio() in isolation.
 *   These integration tests verify Layer 3 is correctly wired inside
 *   executeSubstitution() — the substitution pipeline entry point in substitute.ts.
 *
 *   Production sequence exercised:
 *     1. executeSubstitution(candidates, originalCode)
 *     2. D2 auto-accept gate runs (candidates must pass — we use a high-score candidate)
 *     3. Layer 3 gate runs: enforceAtomSizeRatio(atomLike, callSite, l3cfg)
 *     4a. Oversized atom (high complexity) → substituted=false, reason="atom-size-too-large"
 *     4b. Small atom (below minFloor) → bypass → substituted proceeds (binding-extract-failed
 *         is expected here since no real AST is provided, but the Layer 3 gate did NOT block)
 *
 *   Compound-interaction requirement satisfied: exercises D2 auto-accept gate →
 *   Layer 3 atom-size ratio gate → substitute result in one production sequence.
 *
 *   Registry stubs produce controlled specCanonicalBytes so Layer 3 can parse
 *   a real SpecYak from the winning candidate's block. When spec bytes are empty,
 *   the implementation uses zero-complexity defaults (bypass path).
 *
 *   Single plug point: Layer 3 runs ONLY in executeSubstitution (substitute.ts),
 *   between the D2 gate and renderSubstitution.
 *
 * Production trigger: pnpm --filter @yakcc/hooks-base test
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CandidateMatch } from "@yakcc/registry";
import {
  resetConfigOverride,
  setConfigOverride,
  getDefaults,
} from "../src/enforcement-config.js";
import { executeSubstitution } from "../src/substitute.js";

// ---------------------------------------------------------------------------
// CandidateMatch stub helpers
// ---------------------------------------------------------------------------

/**
 * Build a valid SpecYak JSON blob with controlled complexity proxy inputs.
 *
 * The SpecYak blob is what Layer 3 decodes from specCanonicalBytes via validateSpecYak().
 * The real SpecYak required fields are: name, inputs, outputs, preconditions,
 * postconditions, invariants, effects, level.
 *
 * Controlling inputs/outputs counts drives atomComplexity:
 *   atomComplexity = (inputs.length + outputs.length + guarantees.length)
 *                    + 5 * exportedSurface   (= 5 * outputs.length in v1)
 *                    + 2 * transitiveDeps    (= 0 in v1, not in spec)
 * substitute.ts reads exportedSurface = specForL3.outputs.length.
 */
function makeSpecBytes(opts: {
  inputs?: number;
  outputs?: number;
}): Uint8Array {
  const spec = {
    name: "integration-stub",
    level: "L0",
    inputs: Array.from({ length: opts.inputs ?? 0 }, (_, i) => ({
      name: `in${i}`,
      type: "string",
      description: `input parameter ${i}`,
    })),
    outputs: Array.from({ length: opts.outputs ?? 0 }, (_, i) => ({
      name: `out${i}`,
      type: "string",
      description: `output parameter ${i}`,
    })),
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
  };
  return new TextEncoder().encode(JSON.stringify(spec));
}

/**
 * Build a CandidateMatch stub that passes D2 auto-accept:
 *   cosineDistance=0.10 → combinedScore = 1 - 0.01/4 = 0.9975 >> 0.85 threshold.
 *   Single candidate so gap = top1Score - 0 = 0.9975 >> 0.15 gap threshold.
 *
 * The block.specCanonicalBytes is set via opts so Layer 3 can parse the SpecYak
 * via validateSpecYak. The spec JSON must pass validateSpecYak validation; use
 * makeSpecBytes() to produce valid bytes.
 *
 * atomComplexity formula (v1 proxy, substitute.ts):
 *   transitiveNodes = spec.inputs.length + spec.outputs.length (+ guarantees=0, not in new schema)
 *   exportedSurface = spec.outputs.length
 *   transitiveDeps  = 0 (not exposed by registry in v1)
 *   atomComplexity  = transitiveNodes + 5 * exportedSurface + 2 * transitiveDeps
 *                   = (inputs + outputs) + 5 * outputs
 *                   = inputs + 6 * outputs
 */
function makeAutoAcceptCandidate(opts: {
  inputs?: number;
  outputs?: number;
  specBytes?: Uint8Array;
}): CandidateMatch {
  const specBytes =
    opts.specBytes ??
    makeSpecBytes({
      ...(opts.inputs !== undefined ? { inputs: opts.inputs } : {}),
      ...(opts.outputs !== undefined ? { outputs: opts.outputs } : {}),
    });
  return {
    cosineDistance: 0.10,
    block: {
      blockMerkleRoot: "a".repeat(64),
      specCanonicalBytes: specBytes,
    },
  } as unknown as CandidateMatch;
}

// ---------------------------------------------------------------------------
// Setup/teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetConfigOverride();
  // Ensure YAKCC_HOOK_DISABLE_SUBSTITUTE is NOT set so the substitute path runs.
  delete process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE;
  delete process.env.YAKCC_HOOK_DISABLE_ATOM_SIZE_GATE;
});

afterEach(() => {
  resetConfigOverride();
  delete process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE;
  delete process.env.YAKCC_HOOK_DISABLE_ATOM_SIZE_GATE;
});

// ---------------------------------------------------------------------------
// Integration: Layer 3 rejects oversized atom
//
// Compound-interaction test: D2 auto-accept gate → Layer 3 gate → result.
// ---------------------------------------------------------------------------

describe("Layer 3 integration — oversized atom rejected by executeSubstitution", () => {
  it("returns substituted=false, reason=atom-size-too-large when atom is lodash-shaped", async () => {
    // substitute.ts formula: atomComplexity = inputs + 6 * outputs (no guarantees in real SpecYak)
    // inputs=2, outputs=20 → atomComplexity = 2 + 6*20 = 122
    // minFloor=20, ratioThreshold=2 → ratio=122/1=122 >> 2 → reject
    setConfigOverride({
      ...getDefaults(),
      layer3: { ratioThreshold: 2, minFloor: 20, disableGate: false },
    });

    const candidate = makeAutoAcceptCandidate({ inputs: 2, outputs: 20 });
    const originalCode = "const result = fn();"; // 1 semicolon → statementCount=1, needComplexity=1

    const result = await executeSubstitution([candidate], originalCode);

    expect(result.substituted).toBe(false);
    if (!result.substituted) {
      expect(result.reason).toBe("atom-size-too-large");
    }
  });

  it("returns atom-size-too-large with default config when atomComplexity >> 10x need", async () => {
    // Default ratioThreshold=10, minFloor=20.
    // inputs=0, outputs=30 → atomComplexity = 0 + 6*30 = 180 >= minFloor=20
    // 1 semicolon in originalCode → statementCount=1, bindingsUsed=1 → needComplexity=1
    // ratio=180/1=180 >> 10 → reject
    const candidate = makeAutoAcceptCandidate({ inputs: 0, outputs: 30 });
    const originalCode = "const x = fn();";

    const result = await executeSubstitution([candidate], originalCode);

    expect(result.substituted).toBe(false);
    if (!result.substituted) {
      expect(result.reason).toBe("atom-size-too-large");
    }
  });

  it("does NOT substitute when atom spec bytes parse to large complexity", async () => {
    // inputs=5, outputs=20 → atomComplexity = 5 + 6*20 = 125 >= minFloor=20
    // 1 semicolon → needComplexity=1; ratio=125 >> ratioThreshold=10 → reject
    const specBytes = makeSpecBytes({ inputs: 5, outputs: 20 });
    const candidate = makeAutoAcceptCandidate({ specBytes });
    const originalCode = "const r = transform();";

    const result = await executeSubstitution([candidate], originalCode);

    expect(result.substituted, "Layer 3 must block substitution of oversized atom").toBe(false);
    if (!result.substituted) {
      expect(result.reason).toBe("atom-size-too-large");
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: Layer 3 does NOT block micro-atom (below minFloor)
// ---------------------------------------------------------------------------

describe("Layer 3 integration — micro-atom bypasses ratio check", () => {
  it("does not return atom-size-too-large when spec is empty (zero complexity = bypass)", async () => {
    // Empty spec → atomComplexity = 0 < minFloor=20 → bypass → gate passes.
    // Layer 3 result: ok (bypassed). Pipeline continues to binding extraction.
    // Since no real AST parsing context is available, result is binding-extract-failed —
    // but the key assertion is that Layer 3 did NOT block (reason != atom-size-too-large).
    const candidate = makeAutoAcceptCandidate({ specBytes: new Uint8Array(0) });
    const originalCode = "const x = compute();";

    const result = await executeSubstitution([candidate], originalCode);

    // Layer 3 bypassed (empty spec → atomComplexity=0 < minFloor=20).
    // Subsequent stages may fail (binding-extract), but NOT atom-size-too-large.
    if (!result.substituted) {
      expect(result.reason, "Layer 3 must not block empty-spec (zero complexity) atom").not.toBe(
        "atom-size-too-large",
      );
    }
  });

  it("does not block atom with small spec (atomComplexity < minFloor=20)", async () => {
    // inputs=1, outputs=2 → atomComplexity = 1 + 6*2 = 13 < minFloor=20 → bypass
    // Even with a very strict threshold=1, bypass protects micro-atoms.
    setConfigOverride({
      ...getDefaults(),
      layer3: { ratioThreshold: 1, minFloor: 20, disableGate: false },
    });

    const candidate = makeAutoAcceptCandidate({ inputs: 1, outputs: 2 });
    const originalCode = "const x = compute();";

    const result = await executeSubstitution([candidate], originalCode);

    if (!result.substituted) {
      expect(result.reason, "Layer 3 must bypass micro-atom (atomComplexity < minFloor)").not.toBe(
        "atom-size-too-large",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: YAKCC_HOOK_DISABLE_ATOM_SIZE_GATE=1 escape hatch
// (checked via disableGate config; layer3.disableGate=true bypasses Layer 3)
// ---------------------------------------------------------------------------

describe("Layer 3 integration — disableGate escape hatch", () => {
  it("does not block oversized atom when layer3.disableGate=true", async () => {
    // inputs=0, outputs=30 → atomComplexity=180. Without disableGate → reject.
    // With disableGate=true: skip Layer 3 → result is NOT atom-size-too-large.
    setConfigOverride({
      ...getDefaults(),
      layer3: { ratioThreshold: 10, minFloor: 20, disableGate: true },
    });

    const candidate = makeAutoAcceptCandidate({ inputs: 0, outputs: 30 });
    const originalCode = "const x = fn();";

    const result = await executeSubstitution([candidate], originalCode);

    if (!result.substituted) {
      expect(result.reason, "Layer 3 must be skipped when disableGate=true").not.toBe(
        "atom-size-too-large",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: config-driven threshold (no hardcoded values)
//
// @decision DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001
// Verifies thresholds come from enforcement-config, NOT hardcoded in substitute.ts.
// ---------------------------------------------------------------------------

describe("Layer 3 integration — config-driven thresholds (no hardcoded values)", () => {
  it("uses ratioThreshold from config: raised threshold allows previously-rejected atom", async () => {
    // inputs=2, outputs=20 → atomComplexity = 2 + 6*20 = 122
    // Default ratioThreshold=10: 122 >> 10 → reject.
    // With ratioThreshold=200: 122 < 200 → Layer 3 passes.
    // Layer 3 passes → pipeline continues → binding-extract-failed (no real AST) or substituted.
    setConfigOverride({
      ...getDefaults(),
      layer3: { ratioThreshold: 200, minFloor: 20, disableGate: false },
    });

    const candidate = makeAutoAcceptCandidate({ inputs: 2, outputs: 20 });
    const originalCode = "const result = fn();";

    const result = await executeSubstitution([candidate], originalCode);

    // Layer 3 must NOT be the blocker. Result may be binding-extract-failed or substituted.
    if (!result.substituted) {
      expect(result.reason, "raised ratioThreshold=200 must not block this atom").not.toBe(
        "atom-size-too-large",
      );
    }
  });

  it("uses ratioThreshold from config: lowered threshold rejects previously-accepted atom", async () => {
    // inputs=1, outputs=2 → atomComplexity = 1 + 6*2 = 13
    // Default config: 13 < minFloor=20 → bypass → passes.
    // With minFloor=0, ratioThreshold=2: gate runs. ratio=13/1=13 > 2 → reject.
    setConfigOverride({
      ...getDefaults(),
      layer3: { ratioThreshold: 2, minFloor: 0, disableGate: false },
    });

    const candidate = makeAutoAcceptCandidate({ inputs: 1, outputs: 2 });
    const originalCode = "const r = fn();";

    const result = await executeSubstitution([candidate], originalCode);

    expect(result.substituted).toBe(false);
    if (!result.substituted) {
      expect(result.reason, "lowered ratioThreshold=2 + minFloor=0 must reject this atom").toBe(
        "atom-size-too-large",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: YAKCC_HOOK_DISABLE_SUBSTITUTE=1 escape hatch takes priority
// ---------------------------------------------------------------------------

describe("Layer 3 integration — YAKCC_HOOK_DISABLE_SUBSTITUTE escape hatch", () => {
  it("returns disabled reason when YAKCC_HOOK_DISABLE_SUBSTITUTE=1, not atom-size-too-large", async () => {
    process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE = "1";

    const candidate = makeAutoAcceptCandidate({ inputs: 0, outputs: 30 });
    const originalCode = "const x = fn();";

    const result = await executeSubstitution([candidate], originalCode);

    expect(result.substituted).toBe(false);
    if (!result.substituted) {
      expect(result.reason).toBe("disabled");
    }
  });
});
