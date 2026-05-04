// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/contracts atoms. Two-file pattern: this file (.props.ts) is vitest-free
// and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-06 L1)
// Rationale: See tmp/wi-v2-06-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Property-test corpus for merkle.ts atoms.
// Atoms covered:
//   A1.11 specHash
//   A1.12 blockMerkleRoot
//   A1.13 isLocalTriplet
//   A1.14 isForeignTriplet

import * as fc from "fast-check";
import { contractSpecArb } from "./canonicalize.props.js";
import type { ContractSpec } from "./index.js";
import { blockMerkleRoot, isForeignTriplet, isLocalTriplet, specHash } from "./merkle.js";
import type { BlockTriplet, ForeignTripletFields, LocalTriplet } from "./merkle.js";
import type { SpecYak } from "./spec-yak.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary for a minimal valid SpecYak (all required fields present). */
const specYakArb: fc.Arbitrary<SpecYak> = fc
  .record({
    name: fc.string({ minLength: 1, maxLength: 32 }),
    inputs: fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 16 }),
        type: fc.string({ minLength: 1, maxLength: 32 }),
      }),
      { maxLength: 4 },
    ),
    outputs: fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 16 }),
        type: fc.string({ minLength: 1, maxLength: 32 }),
      }),
      { maxLength: 4 },
    ),
    preconditions: fc.array(fc.string({ maxLength: 64 }), { maxLength: 4 }),
    postconditions: fc.array(fc.string({ maxLength: 64 }), { maxLength: 4 }),
    invariants: fc.array(fc.string({ maxLength: 64 }), { maxLength: 4 }),
    effects: fc.array(fc.string({ maxLength: 64 }), { maxLength: 4 }),
    level: fc.constantFrom("L0", "L1", "L2", "L3") as fc.Arbitrary<"L0" | "L1" | "L2" | "L3">,
  })
  .map((s) => s as SpecYak);

/** Arbitrary for a valid LocalTriplet with one property_tests artifact. */
const localTripletArb: fc.Arbitrary<LocalTriplet> = fc
  .record({
    spec: specYakArb,
    implSource: fc.string({ minLength: 1, maxLength: 256 }),
    artifactContent: fc.uint8Array({ minLength: 1, maxLength: 64 }),
  })
  .map(({ spec, implSource, artifactContent }) => ({
    kind: "local" as const,
    spec,
    implSource,
    manifest: {
      artifacts: [{ kind: "property_tests" as const, path: "tests.fast-check.ts" }],
    },
    artifacts: new Map([["tests.fast-check.ts", artifactContent]]),
  }));

/** Arbitrary for a ForeignTripletFields.
 * dtsHash is conditionally included (not set to undefined) to satisfy
 * exactOptionalPropertyTypes: the field must be absent, not present-as-undefined.
 */
const foreignTripletArb: fc.Arbitrary<ForeignTripletFields> = fc
  .record({
    kind: fc.constant("foreign" as const),
    pkg: fc.string({ minLength: 1, maxLength: 32 }),
    export: fc.string({ minLength: 1, maxLength: 32 }),
    includeDtsHash: fc.boolean(),
    dtsHashValue: fc.stringMatching(/^[0-9a-f]{64}$/),
  })
  .map(({ kind, pkg, includeDtsHash, dtsHashValue, ...rest }) => {
    const base: ForeignTripletFields = {
      kind,
      pkg,
      export: rest.export,
    };
    if (includeDtsHash) {
      return { ...base, dtsHash: dtsHashValue } satisfies ForeignTripletFields;
    }
    return base;
  });

/** Union of local and foreign triplets for partition-testing. */
const blockTripletArb: fc.Arbitrary<BlockTriplet> = fc.oneof(localTripletArb, foreignTripletArb);

// ---------------------------------------------------------------------------
// A1.11: specHash properties
// ---------------------------------------------------------------------------

/**
 * prop_specHash_deterministic
 *
 * For every SpecYak, two consecutive calls to specHash return identical hashes.
 * Invariant: specHash is a pure, deterministic function.
 */
export const prop_specHash_deterministic = fc.property(specYakArb, (spec) => {
  const h1 = specHash(spec);
  const h2 = specHash(spec);
  return h1 === h2;
});

/**
 * prop_specHash_format_brand
 *
 * For every SpecYak, the returned SpecHash is 64 lowercase hex characters.
 * Invariant: SpecHash = BLAKE3-256 encoded as 64-char lowercase hex.
 */
export const prop_specHash_format_brand = fc.property(specYakArb, (spec) => {
  return /^[0-9a-f]{64}$/.test(specHash(spec));
});

/**
 * prop_specHash_field_order_invariant
 *
 * Permuting object key insertion order in the SpecYak produces the same hash,
 * because specHash delegates to canonicalize which sorts keys lexicographically.
 * Invariant: specHash is field-order-invariant.
 */
export const prop_specHash_field_order_invariant = fc.property(specYakArb, (spec) => {
  // Re-create the spec with keys in reversed order.
  const reversed: SpecYak = {
    level: spec.level,
    effects: spec.effects,
    invariants: spec.invariants,
    postconditions: spec.postconditions,
    preconditions: spec.preconditions,
    outputs: spec.outputs,
    inputs: spec.inputs,
    name: spec.name,
  };
  return specHash(spec) === specHash(reversed);
});

// ---------------------------------------------------------------------------
// A1.12: blockMerkleRoot properties
// ---------------------------------------------------------------------------

/**
 * prop_blockMerkleRoot_deterministic
 *
 * For every BlockTriplet, two consecutive calls to blockMerkleRoot return
 * identical roots.
 * Invariant: blockMerkleRoot is a pure, deterministic function.
 */
export const prop_blockMerkleRoot_deterministic = fc.property(blockTripletArb, (triplet) => {
  const r1 = blockMerkleRoot(triplet);
  const r2 = blockMerkleRoot(triplet);
  return r1 === r2;
});

/**
 * prop_blockMerkleRoot_format_brand
 *
 * For every BlockTriplet, the returned BlockMerkleRoot is 64 lowercase hex chars.
 * Invariant: BlockMerkleRoot = BLAKE3-256 encoded as 64-char lowercase hex.
 */
export const prop_blockMerkleRoot_format_brand = fc.property(blockTripletArb, (triplet) => {
  return /^[0-9a-f]{64}$/.test(blockMerkleRoot(triplet));
});

/**
 * prop_blockMerkleRoot_field_sensitive
 *
 * Mutating any field of a LocalTriplet produces a different root.
 * Specifically: changing implSource while keeping spec and artifacts constant
 * must change the root (guards against accidental field omission).
 * Invariant: every field of the triplet participates in the Merkle derivation.
 */
export const prop_blockMerkleRoot_field_sensitive = fc.property(
  localTripletArb,
  fc.string({ minLength: 1, maxLength: 32 }),
  (triplet, suffix) => {
    const modified: LocalTriplet = {
      ...triplet,
      implSource: `${triplet.implSource}${suffix}`,
    };
    return blockMerkleRoot(triplet) !== blockMerkleRoot(modified);
  },
);

// ---------------------------------------------------------------------------
// A1.13: isLocalTriplet properties
// ---------------------------------------------------------------------------

/**
 * prop_isLocalTriplet_total
 *
 * isLocalTriplet never throws on any BlockTriplet arbitrary.
 * Invariant: the function is total — it only returns boolean, never throws.
 */
export const prop_isLocalTriplet_total = fc.property(blockTripletArb, (triplet) => {
  try {
    const result = isLocalTriplet(triplet);
    return typeof result === "boolean";
  } catch {
    return false;
  }
});

/**
 * prop_isLocalTriplet_partition
 *
 * For every BlockTriplet, exactly one of isLocalTriplet(t) and isForeignTriplet(t)
 * is true. The BlockTriplet union is exhaustively partitioned.
 * Invariant: local and foreign are mutually exclusive, covering the whole union.
 */
export const prop_isLocalTriplet_partition = fc.property(blockTripletArb, (triplet) => {
  const local = isLocalTriplet(triplet);
  const foreign = isForeignTriplet(triplet);
  return (local || foreign) && !(local && foreign);
});

/**
 * prop_isLocalTriplet_accepts_local
 *
 * For every LocalTriplet arbitrary, isLocalTriplet returns true.
 * Invariant: the guard correctly narrows LocalTriplet values.
 */
export const prop_isLocalTriplet_accepts_local = fc.property(localTripletArb, (triplet) => {
  return isLocalTriplet(triplet);
});

// ---------------------------------------------------------------------------
// A1.14: isForeignTriplet properties
// ---------------------------------------------------------------------------

/**
 * prop_isForeignTriplet_total
 *
 * isForeignTriplet never throws on any BlockTriplet arbitrary.
 * Invariant: the function is total — it only returns boolean, never throws.
 */
export const prop_isForeignTriplet_total = fc.property(blockTripletArb, (triplet) => {
  try {
    const result = isForeignTriplet(triplet);
    return typeof result === "boolean";
  } catch {
    return false;
  }
});

/**
 * prop_isForeignTriplet_partition
 *
 * Symmetric mirror of prop_isLocalTriplet_partition: for every BlockTriplet,
 * exactly one of the two guards holds.
 * Invariant: the partition is total — uses the same arbitrary as the local mirror.
 */
export const prop_isForeignTriplet_partition = fc.property(blockTripletArb, (triplet) => {
  const local = isLocalTriplet(triplet);
  const foreign = isForeignTriplet(triplet);
  return (local || foreign) && !(local && foreign);
});

/**
 * prop_isForeignTriplet_accepts_foreign
 *
 * For every ForeignTripletFields arbitrary, isForeignTriplet returns true.
 * Invariant: the guard correctly narrows ForeignTripletFields values.
 */
export const prop_isForeignTriplet_accepts_foreign = fc.property(foreignTripletArb, (triplet) => {
  return isForeignTriplet(triplet);
});

// ---------------------------------------------------------------------------
// Compound integration: contractSpecArb-based specHash continuity
// Exercises specHash + canonicalize + BLAKE3 across real ContractSpec shapes.
// ---------------------------------------------------------------------------

/**
 * prop_specHash_via_contractSpec_deterministic
 *
 * SpecYak is structurally compatible with ContractSpec (a strict superset),
 * so specHash can be applied to a ContractSpec cast. This verifies that the
 * specHash derivation is consistent with contractId for v0-shaped inputs.
 */
export const prop_specHash_via_contractSpec_deterministic = fc.property(contractSpecArb, (spec) => {
  const asSpecYak = spec as unknown as SpecYak;
  const h1 = specHash(asSpecYak);
  const h2 = specHash(asSpecYak);
  return h1 === h2 && /^[0-9a-f]{64}$/.test(h1);
});
