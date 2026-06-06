// SPDX-License-Identifier: MIT
// Unit tests for validateProofManifestL3 (DEC-PROOF-L3-VALIDATOR-001 / #1080).
//
// Production sequence covered:
//   A contributor bundles a lean_proof or coq_proof artifact in proof/ alongside
//   (optionally) property_tests. The registry's verifier calls validateProofManifestL3
//   on the parsed manifest.json before invoking the Lean/Coq checker. The validator
//   must reject manifests that would let a checker run against a malformed or
//   ambiguous artifact declaration.

import { describe, expect, it } from "vitest";
import { validateProofManifestL3 } from "./proof-manifest.js";

// ---------------------------------------------------------------------------
// Happy-path: bare L3 manifests
// ---------------------------------------------------------------------------

describe("validateProofManifestL3 — bare L3 manifests", () => {
  it("accepts a manifest with a single lean_proof artifact", () => {
    const m = {
      artifacts: [
        { kind: "lean_proof", path: "refinement.lean", checker: "lean4@4.7.0" },
      ],
    };
    const result = validateProofManifestL3(m);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.kind).toBe("lean_proof");
    expect(result.artifacts[0]?.checker).toBe("lean4@4.7.0");
  });

  it("accepts a manifest with a single coq_proof artifact", () => {
    const m = {
      artifacts: [
        { kind: "coq_proof", path: "refinement.v", checker: "coq@8.20" },
      ],
    };
    const result = validateProofManifestL3(m);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.kind).toBe("coq_proof");
    expect(result.artifacts[0]?.checker).toBe("coq@8.20");
  });

  it("accepts a manifest with both lean_proof and coq_proof artifacts", () => {
    const m = {
      artifacts: [
        { kind: "lean_proof", path: "proof/lean/refinement.lean", checker: "lean4@4.7.0" },
        { kind: "coq_proof", path: "proof/coq/refinement.v", checker: "coq@8.20" },
      ],
    };
    const result = validateProofManifestL3(m);
    expect(result.artifacts).toHaveLength(2);
  });

  it("accepts a path with proof/ prefix", () => {
    const m = {
      artifacts: [
        { kind: "lean_proof", path: "proof/refinement.lean", checker: "lean4@4.7.0" },
      ],
    };
    expect(() => validateProofManifestL3(m)).not.toThrow();
  });

  it("accepts an optional proof_spec_status annotation", () => {
    const m = {
      artifacts: [
        { kind: "lean_proof", path: "refinement.lean", checker: "lean4@4.7.0" },
      ],
      proof_spec_status: "auto-generated",
    };
    expect(() => validateProofManifestL3(m)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy-path: mixed L0 + L3 manifests
// ---------------------------------------------------------------------------

describe("validateProofManifestL3 — mixed L0 + L3", () => {
  it("accepts property_tests alongside lean_proof (L0+L3 coexistence)", () => {
    const m = {
      artifacts: [
        { kind: "property_tests", path: "tests.fast-check.ts" },
        { kind: "lean_proof", path: "refinement.lean", checker: "lean4@4.7.0" },
      ],
    };
    const result = validateProofManifestL3(m);
    expect(result.artifacts).toHaveLength(2);
  });

  it("accepts property_spec alongside lean_proof", () => {
    const m = {
      artifacts: [
        { kind: "property_spec", path: "properties.json" },
        { kind: "lean_proof", path: "refinement.lean", checker: "lean4@4.7.0" },
      ],
    };
    expect(() => validateProofManifestL3(m)).not.toThrow();
  });

  it("accepts property_tests + property_spec + lean_proof + coq_proof together", () => {
    // Production sequence: a maximally-attested block with L0 and L3 artifacts.
    const m = {
      artifacts: [
        { kind: "property_tests", path: "tests.fast-check.ts" },
        { kind: "property_spec", path: "properties.json" },
        { kind: "lean_proof", path: "proof/lean/refinement.lean", checker: "lean4@4.7.0" },
        { kind: "coq_proof", path: "proof/coq/refinement.v", checker: "coq@8.20" },
      ],
    };
    const result = validateProofManifestL3(m);
    expect(result.artifacts).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Rejection: missing checker field
// ---------------------------------------------------------------------------

describe("validateProofManifestL3 — checker field required", () => {
  it("rejects a lean_proof artifact with no checker field", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [{ kind: "lean_proof", path: "refinement.lean" }],
      }),
    ).toThrow(/missing the required "checker" field/);
  });

  it("rejects a coq_proof artifact with no checker field", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [{ kind: "coq_proof", path: "refinement.v" }],
      }),
    ).toThrow(/missing the required "checker" field/);
  });

  it("rejects a lean_proof artifact with an empty checker string", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [{ kind: "lean_proof", path: "refinement.lean", checker: "" }],
      }),
    ).toThrow(/checker must be a non-empty string/);
  });

  it("rejects when only the second of two lean_proofs has no checker", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [
          { kind: "lean_proof", path: "a.lean", checker: "lean4@4.7.0" },
          { kind: "lean_proof", path: "b.lean" }, // missing checker
        ],
      }),
    ).toThrow(/missing the required "checker" field/);
  });

  it("does not require checker on property_tests (L0 kind in mixed manifest)", () => {
    // property_tests sits alongside lean_proof; checker is not required on it.
    const m = {
      artifacts: [
        { kind: "property_tests", path: "tests.fast-check.ts" },
        { kind: "lean_proof", path: "refinement.lean", checker: "lean4@4.7.0" },
      ],
    };
    expect(() => validateProofManifestL3(m)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rejection: path traversal
// ---------------------------------------------------------------------------

describe("validateProofManifestL3 — path traversal rejection", () => {
  it("rejects a path with .. traversal", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [
          { kind: "lean_proof", path: "../secrets/id_rsa", checker: "lean4@4.7.0" },
        ],
      }),
    ).toThrow(/contains ".." traversal/);
  });

  it("rejects a path with embedded .. segment", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [
          { kind: "lean_proof", path: "proof/../etc/passwd", checker: "lean4@4.7.0" },
        ],
      }),
    ).toThrow(/contains ".." traversal/);
  });

  it("rejects a deeply-nested .. traversal", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [
          {
            kind: "coq_proof",
            path: "proof/sub/../../outside",
            checker: "coq@8.20",
          },
        ],
      }),
    ).toThrow(/contains ".." traversal/);
  });
});

// ---------------------------------------------------------------------------
// Rejection: path outside proof/
// ---------------------------------------------------------------------------

describe("validateProofManifestL3 — path must resolve under proof/", () => {
  it("rejects a path with a directory prefix other than proof/", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [
          { kind: "lean_proof", path: "src/refinement.lean", checker: "lean4@4.7.0" },
        ],
      }),
    ).toThrow(/must resolve under proof\//);
  });

  it("rejects an absolute path", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [
          { kind: "lean_proof", path: "/tmp/refinement.lean", checker: "lean4@4.7.0" },
        ],
      }),
    ).toThrow(/must be relative/);
  });

  it("accepts a bare filename (no directory separator)", () => {
    // bare filename resolves under proof/ by convention — manifest lives there.
    expect(() =>
      validateProofManifestL3({
        artifacts: [
          { kind: "lean_proof", path: "refinement.lean", checker: "lean4@4.7.0" },
        ],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rejection: L1/L2 kinds in a L3 manifest
// ---------------------------------------------------------------------------

describe("validateProofManifestL3 — L1/L2 kinds rejected", () => {
  it("rejects smt_cert in the manifest (L2 kind)", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [
          { kind: "smt_cert", path: "refinement.smt2", theory: ["bv8"] },
        ],
      }),
    ).toThrow(/smt_cert.*L2 kinds/);
  });

  it("rejects fuzz_bounds_witness in the manifest (L2 kind)", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [
          { kind: "fuzz_bounds_witness", path: "bounds.json" },
        ],
      }),
    ).toThrow(/fuzz_bounds_witness.*L2 kinds/);
  });

  it("rejects smt_cert mixed with lean_proof", () => {
    // Mixed L2+L3 is explicitly rejected — L3 validator owns only lean/coq artifacts.
    expect(() =>
      validateProofManifestL3({
        artifacts: [
          { kind: "lean_proof", path: "refinement.lean", checker: "lean4@4.7.0" },
          { kind: "smt_cert", path: "refinement.smt2", theory: ["bv8"] },
        ],
      }),
    ).toThrow(/smt_cert.*L2 kinds/);
  });
});

// ---------------------------------------------------------------------------
// Rejection: no L3 artifacts at all
// ---------------------------------------------------------------------------

describe("validateProofManifestL3 — must contain at least one formal artifact", () => {
  it("rejects a manifest with only property_tests (no L3 artifact)", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
      }),
    ).toThrow(/at least one lean_proof or coq_proof artifact/);
  });

  it("rejects an empty artifacts array", () => {
    expect(() =>
      validateProofManifestL3({ artifacts: [] }),
    ).toThrow(/at least one artifact/);
  });
});

// ---------------------------------------------------------------------------
// Structural rejection: malformed input
// ---------------------------------------------------------------------------

describe("validateProofManifestL3 — malformed input rejection", () => {
  it("rejects null", () => {
    expect(() => validateProofManifestL3(null)).toThrow(/expected a non-null object/);
  });

  it("rejects a bare array", () => {
    expect(() => validateProofManifestL3([])).toThrow(/expected a non-null object/);
  });

  it("rejects a primitive", () => {
    expect(() => validateProofManifestL3(42)).toThrow(/expected a non-null object/);
  });

  it("rejects an object missing the artifacts field", () => {
    expect(() => validateProofManifestL3({})).toThrow(/missing required field "artifacts"/);
  });

  it("rejects an artifact entry with a missing kind field", () => {
    expect(() =>
      validateProofManifestL3({ artifacts: [{ path: "refinement.lean" }] }),
    ).toThrow(/missing required field "kind"/);
  });

  it("rejects an artifact entry with a missing path field", () => {
    expect(() =>
      validateProofManifestL3({
        artifacts: [{ kind: "lean_proof", checker: "lean4@4.7.0" }],
      }),
    ).toThrow(/missing required field "path"/);
  });
});

// ---------------------------------------------------------------------------
// Compound-interaction: production sequence end-to-end
// ---------------------------------------------------------------------------

describe("validateProofManifestL3 — compound production sequence", () => {
  // Models the full registry ingestion path: a contributor submits a block at
  // L3 with both an L0 property-test corpus and a Lean proof. The validator
  // must accept it and return a properly-typed ProofManifest whose fields the
  // Merkle-root computation and checker invocation both read.
  it("round-trips through JSON serialization (production ingest path)", () => {
    const original = {
      artifacts: [
        { kind: "property_tests", path: "tests.fast-check.ts" },
        { kind: "property_spec", path: "properties.json", generator: "fast-check-v3" },
        {
          kind: "lean_proof",
          path: "proof/refinement.lean",
          checker: "lean4@4.7.0",
        },
      ],
      proof_spec_status: "auto-generated" as const,
    };

    // Simulate JSON round-trip (manifest.json is parsed from disk).
    const parsed = JSON.parse(JSON.stringify(original)) as unknown;
    const result = validateProofManifestL3(parsed);

    // Merkle-root computation reads artifacts in order.
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts[0]?.kind).toBe("property_tests");
    expect(result.artifacts[1]?.kind).toBe("property_spec");
    expect(result.artifacts[2]?.kind).toBe("lean_proof");

    // Checker invocation reads the checker field.
    expect(result.artifacts[2]?.checker).toBe("lean4@4.7.0");

    // Optional top-level annotation survives.
    expect(result.proof_spec_status).toBe("auto-generated");
  });
});
