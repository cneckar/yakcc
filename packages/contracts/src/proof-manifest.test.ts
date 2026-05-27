// SPDX-License-Identifier: MIT
// Unit tests for proof-manifest.ts — specifically the property_spec sibling
// allowance and proof_spec_status field (DEC-POLYGLOT-PROOF-IR-001 / #781).

import { describe, expect, it } from "vitest";
import { validateProofManifestL0 } from "./proof-manifest.js";

describe("validateProofManifestL0 — property_spec sibling (DEC-POLYGLOT-PROOF-IR-001)", () => {
  it("accepts a manifest with one property_tests and one property_spec", () => {
    const m = {
      artifacts: [
        { kind: "property_tests", path: "tests.fast-check.ts" },
        { kind: "property_spec", path: "properties.json", generator: "fast-check-v3" },
      ],
    };
    const validated = validateProofManifestL0(m);
    expect(validated.artifacts).toHaveLength(2);
    expect(validated.artifacts[0]?.kind).toBe("property_tests");
    expect(validated.artifacts[1]?.kind).toBe("property_spec");
  });

  it("rejects a manifest with only property_spec (still requires one property_tests)", () => {
    expect(() =>
      validateProofManifestL0({
        artifacts: [
          { kind: "property_spec", path: "properties.json" },
        ],
      }),
    ).toThrow(/exactly one "property_tests"/);
  });

  it("accepts multiple property_spec artifacts (no L0 count limit)", () => {
    const m = {
      artifacts: [
        { kind: "property_tests", path: "tests.fast-check.ts" },
        { kind: "property_spec", path: "a.json" },
        { kind: "property_spec", path: "b.json" },
      ],
    };
    expect(() => validateProofManifestL0(m)).not.toThrow();
  });

  it("still rejects unknown artifact kinds at L0", () => {
    expect(() =>
      validateProofManifestL0({
        artifacts: [
          { kind: "property_tests", path: "tests.fast-check.ts" },
          { kind: "lean_proof", path: "proof.lean" },
        ],
      }),
    ).toThrow(/only "property_tests" and "property_spec" are allowed at L0/);
  });

  it("accepts a manifest with proof_spec_status annotation", () => {
    const m = {
      artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
      proof_spec_status: "manual-required",
    };
    expect(() => validateProofManifestL0(m)).not.toThrow();
  });
});
