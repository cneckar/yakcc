// SPDX-License-Identifier: MIT
// Unit tests for validateProofManifestL2 and validateProofManifestForLevel (DEC-PROOF-L2-VALIDATOR-001, #1421).
import { describe, expect, it } from "vitest";
import { validateProofManifestForLevel, validateProofManifestL2 } from "./proof-manifest.js";

const TESTS = { kind: "property_tests", path: "tests.fast-check.ts" };
const CERT = {
  kind: "smt_cert",
  path: "l2.json",
  checker: "verify-l2/3 z3 4.15.4",
  theory: ["QF_FPBV"],
};

describe("validateProofManifestL2", () => {
  it("accepts property tests with an smt_cert", () => {
    const m = validateProofManifestL2({ artifacts: [TESTS, CERT] });
    expect(m.artifacts.map((a) => a.kind)).toEqual(["property_tests", "smt_cert"]);
  });

  it("accepts property_spec and fuzz_bounds_witness beside them", () => {
    expect(() =>
      validateProofManifestL2({
        artifacts: [
          TESTS,
          { kind: "property_spec", path: "spec.props.json" },
          CERT,
          { kind: "fuzz_bounds_witness", path: "fuzz.json" },
        ],
      }),
    ).not.toThrow();
  });

  it("keeps the L0 floor: property tests are required", () => {
    expect(() => validateProofManifestL2({ artifacts: [CERT] })).toThrow(/L0 floor/);
  });

  it("requires an smt_cert", () => {
    expect(() => validateProofManifestL2({ artifacts: [TESTS] })).toThrow(/smt_cert/);
  });

  it("requires the cert's checker and theory", () => {
    const { checker: _c, ...noChecker } = CERT;
    const { theory: _t, ...noTheory } = CERT;
    expect(() => validateProofManifestL2({ artifacts: [TESTS, noChecker] })).toThrow(/checker/);
    expect(() => validateProofManifestL2({ artifacts: [TESTS, noTheory] })).toThrow(/theory/);
    expect(() => validateProofManifestL2({ artifacts: [TESTS, { ...CERT, theory: [] }] })).toThrow(
      /theory/,
    );
  });

  it("refuses L3 kinds, unknown kinds and paths outside proof/", () => {
    expect(() =>
      validateProofManifestL2({
        artifacts: [TESTS, CERT, { kind: "lean_proof", path: "r.lean", checker: "lean4@4.7.0" }],
      }),
    ).toThrow(/L3 kind/);
    expect(() =>
      validateProofManifestL2({ artifacts: [TESTS, CERT, { kind: "x", path: "x" }] }),
    ).toThrow(/unrecognized/);
    expect(() =>
      validateProofManifestL2({ artifacts: [TESTS, { ...CERT, path: "../l2.json" }] }),
    ).toThrow(/traversal/);
  });

  it("refuses malformed input", () => {
    expect(() => validateProofManifestL2(null)).toThrow(TypeError);
    expect(() => validateProofManifestL2({ artifacts: [] })).toThrow(/at least one/);
  });
});

describe("validateProofManifestForLevel", () => {
  it("validates L2 blocks as L2, and every other level as L0", () => {
    expect(() => validateProofManifestForLevel("L2", { artifacts: [TESTS, CERT] })).not.toThrow();
    expect(() => validateProofManifestForLevel("L2", { artifacts: [TESTS] })).toThrow(
      /validateProofManifestL2/,
    );
    expect(() => validateProofManifestForLevel("L0", { artifacts: [TESTS] })).not.toThrow();
    expect(() => validateProofManifestForLevel("L0", { artifacts: [TESTS, CERT] })).toThrow(
      /validateProofManifestL0/,
    );
  });
});
