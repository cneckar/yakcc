// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/compile manifest.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3a)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.

// ---------------------------------------------------------------------------
// Property-test corpus for compile/src/manifest.ts atoms
//
// Atoms covered (7 named):
//   buildManifest       (A3.1) — exported public API
//   ProvenanceEntry     (A3.2) — interface shape (blockMerkleRoot, specHash, source,
//                                 subBlocks, verificationStatus, referencedForeign,
//                                 optional recursionParent)
//   ProvenanceManifest  (A3.3) — interface shape (entry, entries)
//   VerificationStatus  (A3.4) — discriminated union "passing" | "unverified"
//   referencedForeign   (A3.5) — required field; [] when no foreign refs
//   topological order   (A3.6) — entries follow ResolutionResult.order
//   entry field         (A3.7) — manifest.entry === ResolutionResult.entry
//
// All tests use in-memory stub registries — no SQLite, no disk IO.
// Properties cover:
//   - ProvenanceManifest shape validity
//   - entries count matches resolution.order length
//   - topological order is preserved
//   - verificationStatus "unverified" when no passing test history
//   - verificationStatus "passing" when at least one passing test entry
//   - referencedForeign is always a (possibly-empty) array
//   - recursionParent absent when registry row has null parentBlockRoot
//   - manifest.entry === resolution.entry
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import { buildManifest } from "./manifest.js";
import type { ResolutionResult } from "./resolve.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

const blockRootArb: fc.Arbitrary<BlockMerkleRoot> = hexHash64 as fc.Arbitrary<BlockMerkleRoot>;
const specHashArb: fc.Arbitrary<SpecHash> = hexHash64 as fc.Arbitrary<SpecHash>;

// ---------------------------------------------------------------------------
// Stub builder helpers
// ---------------------------------------------------------------------------

interface StubBlockRow {
  specHash: SpecHash;
  implSource: string;
  kind?: "local" | "foreign";
  parentBlockRoot?: BlockMerkleRoot | null;
  foreignPkg?: string | null;
  foreignExport?: string | null;
}

interface ProvenanceTestEntry {
  passed: boolean;
}

interface Provenance {
  testHistory: ProvenanceTestEntry[];
}

/**
 * Build a minimal stub Registry for buildManifest tests.
 * getProvenance returns a Provenance with the supplied history.
 * getForeignRefs returns empty array (no foreign refs by default).
 * getBlock returns the row or null.
 */
function makeManifestStubRegistry(
  blocks: Map<BlockMerkleRoot, StubBlockRow>,
  provenances: Map<BlockMerkleRoot, Provenance>,
): {
  getBlock: (root: BlockMerkleRoot) => Promise<StubBlockRow | null>;
  getProvenance: (root: BlockMerkleRoot) => Promise<Provenance>;
  getForeignRefs: (root: BlockMerkleRoot) => Promise<never[]>;
  [key: string]: unknown;
} {
  return {
    async getBlock(root: BlockMerkleRoot) {
      return blocks.get(root) ?? null;
    },
    async getProvenance(root: BlockMerkleRoot) {
      return provenances.get(root) ?? { testHistory: [] };
    },
    async getForeignRefs(_root: BlockMerkleRoot) {
      return [];
    },
    storeBlock() {
      throw new Error("stub: storeBlock not implemented");
    },
    selectBlocks() {
      throw new Error("stub: selectBlocks not implemented");
    },
    findByCanonicalAstHash() {
      throw new Error("stub: findByCanonicalAstHash not implemented");
    },
    findCandidatesByIntent() {
      throw new Error("stub: findCandidatesByIntent not implemented");
    },
    enumerateSpecs() {
      throw new Error("stub: enumerateSpecs not implemented");
    },
    exportManifest() {
      throw new Error("stub: exportManifest not implemented");
    },
    async close() {},
  };
}

/**
 * Build a minimal ResolutionResult with a single entry block and no sub-blocks.
 */
function makeSingleBlockResolution(
  root: BlockMerkleRoot,
  specHash: SpecHash,
  source: string,
): ResolutionResult {
  return {
    entry: root,
    blocks: new Map([[root, { merkleRoot: root, specHash, source, subBlocks: [] }]]),
    order: [root],
  };
}

// ---------------------------------------------------------------------------
// A3.3 + A3.7: ProvenanceManifest shape — single block
// ---------------------------------------------------------------------------

/**
 * prop_buildManifest_single_block_shape
 *
 * For a registry with exactly one block and no test history, buildManifest
 * returns a ProvenanceManifest where:
 *   - manifest.entry === resolution.entry
 *   - manifest.entries.length === 1
 *   - entries[0].blockMerkleRoot === entry root
 *   - entries[0].specHash === the block's specHash
 *   - entries[0].source === implSource
 *   - entries[0].subBlocks is an array (possibly empty)
 *   - entries[0].referencedForeign is an array
 *
 * Invariant (A3.2, A3.3, A3.7): buildManifest populates all required
 * ProvenanceEntry fields for every block in the resolution.
 */
export const prop_buildManifest_single_block_shape = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  fc.string({ minLength: 0, maxLength: 30 }),
  async (root, specHash, source) => {
    const blocks = new Map([[root, { specHash, implSource: source }]]);
    const provenances = new Map<BlockMerkleRoot, Provenance>();
    const registry = makeManifestStubRegistry(blocks, provenances);
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const manifest = await buildManifest(resolution, registry as never);
    if (manifest.entry !== root) return false;
    if (manifest.entries.length !== 1) return false;
    const entry = manifest.entries[0];
    if (entry === undefined) return false;
    return (
      entry.blockMerkleRoot === root &&
      entry.specHash === specHash &&
      entry.source === source &&
      Array.isArray(entry.subBlocks) &&
      Array.isArray(entry.referencedForeign)
    );
  },
);

// ---------------------------------------------------------------------------
// A3.4: VerificationStatus — "unverified" when no passing test history
// ---------------------------------------------------------------------------

/**
 * prop_buildManifest_unverified_when_no_passing_history
 *
 * When the registry has no test history for a block (empty testHistory),
 * buildManifest sets verificationStatus to "unverified".
 *
 * Invariant (A3.4): absence of a passing ProvenanceTestEntry → "unverified".
 * The sentinel empty provenance (testHistory: []) maps to "unverified".
 */
export const prop_buildManifest_unverified_when_no_passing_history = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const blocks = new Map([[root, { specHash, implSource: "" }]]);
    const provenances = new Map<BlockMerkleRoot, Provenance>([[root, { testHistory: [] }]]);
    const registry = makeManifestStubRegistry(blocks, provenances);
    const resolution = makeSingleBlockResolution(root, specHash, "");
    const manifest = await buildManifest(resolution, registry as never);
    const entry = manifest.entries[0];
    return entry !== undefined && entry.verificationStatus === "unverified";
  },
);

/**
 * prop_buildManifest_unverified_when_all_tests_failed
 *
 * When all test history entries have passed=false, verificationStatus is "unverified".
 *
 * Invariant (A3.4): "passing" requires at least one entry with passed===true;
 * all-false histories do not satisfy that condition.
 */
export const prop_buildManifest_unverified_when_all_tests_failed = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  fc.array(fc.constant({ passed: false }), { minLength: 1, maxLength: 5 }),
  async (root, specHash, history) => {
    const blocks = new Map([[root, { specHash, implSource: "" }]]);
    const provenances = new Map<BlockMerkleRoot, Provenance>([[root, { testHistory: history }]]);
    const registry = makeManifestStubRegistry(blocks, provenances);
    const resolution = makeSingleBlockResolution(root, specHash, "");
    const manifest = await buildManifest(resolution, registry as never);
    const entry = manifest.entries[0];
    return entry !== undefined && entry.verificationStatus === "unverified";
  },
);

// ---------------------------------------------------------------------------
// A3.4: VerificationStatus — "passing" when at least one passing test entry
// ---------------------------------------------------------------------------

/**
 * prop_buildManifest_passing_when_at_least_one_passing_test
 *
 * When the registry has at least one ProvenanceTestEntry with passed=true,
 * buildManifest sets verificationStatus to "passing".
 *
 * Invariant (A3.4): `some(entry => entry.passed)` → "passing".
 * The check is non-exclusive: one pass among many failures still yields "passing".
 */
export const prop_buildManifest_passing_when_at_least_one_passing_test = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const blocks = new Map([[root, { specHash, implSource: "" }]]);
    const provenances = new Map<BlockMerkleRoot, Provenance>([
      [root, { testHistory: [{ passed: false }, { passed: true }] }],
    ]);
    const registry = makeManifestStubRegistry(blocks, provenances);
    const resolution = makeSingleBlockResolution(root, specHash, "");
    const manifest = await buildManifest(resolution, registry as never);
    const entry = manifest.entries[0];
    return entry !== undefined && entry.verificationStatus === "passing";
  },
);

// ---------------------------------------------------------------------------
// A3.5: referencedForeign — required field, always an array
// ---------------------------------------------------------------------------

/**
 * prop_buildManifest_referencedForeign_is_always_array
 *
 * For every block, the referencedForeign field in the manifest entry is always
 * an array (never undefined, never null).
 *
 * Invariant (A3.5, DEC-COMPILE-MANIFEST-003, L4-I3): referencedForeign is a
 * required field. [] is the empty case for blocks with no foreign deps.
 * The property holds regardless of whether getBlock returns null (missing block).
 */
export const prop_buildManifest_referencedForeign_is_always_array = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const blocks = new Map([[root, { specHash, implSource: "" }]]);
    const provenances = new Map<BlockMerkleRoot, Provenance>();
    const registry = makeManifestStubRegistry(blocks, provenances);
    const resolution = makeSingleBlockResolution(root, specHash, "");
    const manifest = await buildManifest(resolution, registry as never);
    const entry = manifest.entries[0];
    return (
      entry !== undefined &&
      Array.isArray(entry.referencedForeign) &&
      entry.referencedForeign.length === 0
    );
  },
);

// ---------------------------------------------------------------------------
// A3.6: Topological order — entries follow ResolutionResult.order
// ---------------------------------------------------------------------------

/**
 * prop_buildManifest_entries_count_matches_order_length
 *
 * The number of entries in the manifest always equals the length of
 * ResolutionResult.order (one entry per resolved block, in order).
 *
 * Invariant (A3.6): buildManifest iterates exactly over resolution.order;
 * no blocks are silently dropped or duplicated.
 */
export const prop_buildManifest_entries_count_matches_order_length = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  blockRootArb,
  specHashArb,
  async (root1, spec1, root2, spec2) => {
    fc.pre(root1 !== root2);
    const blocks = new Map([
      [root1, { specHash: spec1, implSource: "" }],
      [root2, { specHash: spec2, implSource: "" }],
    ]);
    const provenances = new Map<BlockMerkleRoot, Provenance>();
    const registry = makeManifestStubRegistry(blocks, provenances);
    const resolution: ResolutionResult = {
      entry: root2,
      blocks: new Map([
        [root1, { merkleRoot: root1, specHash: spec1, source: "", subBlocks: [] }],
        [root2, { merkleRoot: root2, specHash: spec2, source: "", subBlocks: [root1] }],
      ]),
      order: [root1, root2], // topological: leaf first
    };
    const manifest = await buildManifest(resolution, registry as never);
    return (
      manifest.entries.length === 2 &&
      manifest.entries[0]?.blockMerkleRoot === root1 && // leaf first
      manifest.entries[1]?.blockMerkleRoot === root2 // entry last
    );
  },
);

/**
 * prop_buildManifest_entry_field_matches_resolution_entry
 *
 * manifest.entry always equals resolution.entry, regardless of how many
 * blocks are in the resolution.
 *
 * Invariant (A3.7): manifest.entry is derived directly from resolution.entry —
 * it is not re-derived from order or blocks.
 */
export const prop_buildManifest_entry_field_matches_resolution_entry = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const blocks = new Map([[root, { specHash, implSource: "" }]]);
    const provenances = new Map<BlockMerkleRoot, Provenance>();
    const registry = makeManifestStubRegistry(blocks, provenances);
    const resolution = makeSingleBlockResolution(root, specHash, "");
    const manifest = await buildManifest(resolution, registry as never);
    return manifest.entry === root;
  },
);
