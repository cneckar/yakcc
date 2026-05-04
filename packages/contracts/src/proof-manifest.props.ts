// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/contracts atoms. Two-file pattern: this file (.props.ts) is vitest-free
// and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-06 L1)
// Rationale: See tmp/wi-v2-06-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Property-test corpus for proof-manifest.ts atoms.
// Atoms covered: validateProofManifestL0 (A1.15)

import * as fc from "fast-check";
import { validateProofManifestL0 } from "./proof-manifest.js";
import type { ProofManifest } from "./proof-manifest.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary for a valid L0 ProofManifest (exactly one property_tests artifact).
 * L0 accepts exactly one artifact whose kind is "property_tests".
 */
const validProofManifestArb: fc.Arbitrary<ProofManifest> = fc
  .record({
    path: fc.string({ minLength: 1, maxLength: 64 }),
  })
  .map(({ path }) => ({
    artifacts: [{ kind: "property_tests" as const, path }],
  }));

/**
 * Arbitrary for garbage values that are definitely not valid ProofManifests.
 * Includes primitives, null, arrays, and objects without the required fields.
 */
const garbageArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.boolean(),
  fc.string(),
  fc.constant([]),
  fc.constant({}),
  fc.constant({ artifacts: null }),
  fc.constant({ artifacts: "not-an-array" }),
  fc.constant({ artifacts: [] }), // empty array — L0 requires at least one
  fc.constant({ artifacts: [{ kind: "smt_cert", path: "proof.smt" }] }), // non-L0 kind
  fc.constant({ artifacts: [{ kind: "lean_proof", path: "proof.lean" }] }),
  fc.constant({ artifacts: [{ kind: "property_tests", path: "" }] }), // empty path
  fc.constant({
    artifacts: [
      { kind: "property_tests", path: "a.ts" },
      { kind: "property_tests", path: "b.ts" },
    ],
  }), // two property_tests — L0 requires exactly one
);

// ---------------------------------------------------------------------------
// A1.15: validateProofManifestL0 properties
// ---------------------------------------------------------------------------

/**
 * prop_validateProofManifestL0_round_trip
 *
 * For every valid ProofManifest, serializing to JSON and back preserves the
 * structure: validateProofManifestL0(JSON.parse(JSON.stringify(m))) deep-equals m.
 * Invariant: the validator accepts its own outputs after JSON round-trip.
 */
export const prop_validateProofManifestL0_round_trip = fc.property(
  validProofManifestArb,
  (manifest) => {
    const serialized = JSON.parse(JSON.stringify(manifest)) as unknown;
    try {
      const result = validateProofManifestL0(serialized);
      // Deep-equal check: same number of artifacts, same kind/path on each.
      if (result.artifacts.length !== manifest.artifacts.length) return false;
      for (let i = 0; i < result.artifacts.length; i++) {
        const ra = result.artifacts[i];
        const ma = manifest.artifacts[i];
        if (!ra || !ma) return false;
        if (ra.kind !== ma.kind || ra.path !== ma.path) return false;
      }
      return true;
    } catch {
      return false;
    }
  },
);

/**
 * prop_validateProofManifestL0_rejects_garbage
 *
 * For every garbage value, validateProofManifestL0 throws (never returns).
 * Invariant: the validator rejects all non-conforming inputs.
 */
export const prop_validateProofManifestL0_rejects_garbage = fc.property(garbageArb, (value) => {
  try {
    validateProofManifestL0(value);
    return false; // returned without throwing — property violated
  } catch {
    return true; // threw as expected
  }
});

/**
 * prop_validateProofManifestL0_idempotent
 *
 * validateProofManifestL0(validateProofManifestL0(x)) equals validateProofManifestL0(x)
 * for all valid inputs: re-validating an already-valid manifest succeeds and produces
 * the same structure.
 * Invariant: the validator is a normalizer — applying it twice is the same as once.
 */
export const prop_validateProofManifestL0_idempotent = fc.property(
  validProofManifestArb,
  (manifest) => {
    const first = validateProofManifestL0(manifest);
    const second = validateProofManifestL0(first);
    if (first.artifacts.length !== second.artifacts.length) return false;
    for (let i = 0; i < first.artifacts.length; i++) {
      const fa = first.artifacts[i];
      const sa = second.artifacts[i];
      if (!fa || !sa) return false;
      if (fa.kind !== sa.kind || fa.path !== sa.path) return false;
    }
    return true;
  },
);
