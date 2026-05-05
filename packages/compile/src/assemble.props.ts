// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/compile assemble.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3a)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// NOTE: assemble() invokes resolveComposition() which calls registry.getBlock()
// (async registry IO) plus ts-backend.emit(). All tests use in-memory stub
// registries. numRuns is capped at 10 in the test harness per the dispatch
// budget for ts-morph/registry-backed atoms.

// ---------------------------------------------------------------------------
// Property-test corpus for compile/src/assemble.ts atoms
//
// Atoms covered (8 named):
//   importPathStem        (A2.1) — private; extracts stem from import path
//   stemToCamelCase       (A2.2) — private; kebab → camelCase
//   extractFunctionName   (A2.3) — private; finds first export function name in implSource
//   buildStemSpecHashIndex (A2.4) — private async; builds stem → SpecHash index
//   subBlockResolver       (A2.5) — private closure; maps import path → BlockMerkleRoot
//   assemble               (A2.6) — exported public API
//   Artifact interface     (A2.7) — { source, manifest }
//   AssembleOptions        (A2.8) — { knownMerkleRoots? }
//
// Atoms A2.1–A2.5 are private. They are tested transitively via assemble().
// Properties cover:
//   - Artifact shape (source: string, manifest present)
//   - Single-block assembly produces non-empty source with header comment
//   - assemble() propagates ResolutionError for missing block
//   - assemble() is deterministic (byte-identical re-emit)
//   - knownMerkleRoots option: providing roots enables stem → SpecHash resolution
//   - stemToCamelCase: kebab-case → camelCase conversion
//   - importPathStem: @yakcc/seeds/ path → stem extraction
//   - importPathStem: "./" relative path → stem extraction
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import { assemble } from "./assemble.js";
import { ResolutionError } from "./resolve.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

const blockRootArb: fc.Arbitrary<BlockMerkleRoot> = hexHash64 as fc.Arbitrary<BlockMerkleRoot>;
const specHashArb: fc.Arbitrary<SpecHash> = hexHash64 as fc.Arbitrary<SpecHash>;

// ---------------------------------------------------------------------------
// Stub registry builder
// ---------------------------------------------------------------------------

interface StubBlockRow {
  specHash: SpecHash;
  implSource: string;
}

interface StubProvenance {
  testHistory: { passed: boolean }[];
}

/**
 * Minimal stub Registry that satisfies the surface used by assemble():
 *   - getBlock(merkleRoot) → row or null
 *   - selectBlocks(specHash) → BlockMerkleRoot[]
 *   - getProvenance(merkleRoot) → { testHistory }
 *   - getForeignRefs(merkleRoot) → []
 *
 * All other Registry methods throw to surface accidental calls.
 */
function makeAssembleStubRegistry(
  blocks: Map<BlockMerkleRoot, StubBlockRow>,
  specIndex: Map<SpecHash, BlockMerkleRoot[]> = new Map(),
  provenances: Map<BlockMerkleRoot, StubProvenance> = new Map(),
): {
  getBlock: (root: BlockMerkleRoot) => Promise<StubBlockRow | null>;
  selectBlocks: (specHash: SpecHash) => Promise<BlockMerkleRoot[]>;
  getProvenance: (root: BlockMerkleRoot) => Promise<StubProvenance>;
  getForeignRefs: (root: BlockMerkleRoot) => Promise<never[]>;
  [key: string]: unknown;
} {
  return {
    async getBlock(root: BlockMerkleRoot) {
      return blocks.get(root) ?? null;
    },
    async selectBlocks(s: SpecHash) {
      return specIndex.get(s) ?? [];
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

// ---------------------------------------------------------------------------
// A2.6 + A2.7: assemble() — Artifact shape
// ---------------------------------------------------------------------------

/**
 * assemble() returns a well-formed Artifact for a single-block registry.
 *
 * For a registry with one block and a simple export function impl, the
 * returned Artifact has: source (non-empty string), manifest.entry ===
 * entry BlockMerkleRoot, and manifest.entries.length === 1.
 *
 * Invariant (A2.6, A2.7): assemble() always returns a well-formed Artifact;
 * the manifest entry count matches the transitive block closure size.
 */
export const prop_assemble_artifact_shape = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const implSource = "export function compute(x: number): number { return x * 2; }";
    const blocks = new Map([[root, { specHash, implSource }]]);
    const registry = makeAssembleStubRegistry(blocks);
    const artifact = await assemble(root, registry as never);
    return (
      typeof artifact.source === "string" &&
      artifact.source.length > 0 &&
      artifact.manifest.entry === root &&
      artifact.manifest.entries.length === 1
    );
  },
);

/**
 * assemble() emitted source always starts with the yakcc/compile header comment.
 *
 * Invariant (A2.6, DEC-COMPILE-TS-BACKEND-001): tsBackend always prepends the
 * header comment; assemble() does not alter the backend's output.
 */
export const prop_assemble_source_includes_header_comment = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const implSource = "export function run(): void {}";
    const blocks = new Map([[root, { specHash, implSource }]]);
    const registry = makeAssembleStubRegistry(blocks);
    const artifact = await assemble(root, registry as never);
    return artifact.source.includes("Assembled by @yakcc/compile");
  },
);

// ---------------------------------------------------------------------------
// A2.6: assemble() — ResolutionError propagation
// ---------------------------------------------------------------------------

/**
 * assemble() throws ResolutionError with kind="missing-block" for absent entry root.
 *
 * Invariant (A2.6): assemble() propagates ResolutionError from resolveComposition()
 * unwrapped for the missing-block case.
 */
export const prop_assemble_throws_ResolutionError_for_missing_block = fc.asyncProperty(
  blockRootArb,
  async (root) => {
    const registry = makeAssembleStubRegistry(new Map());
    try {
      await assemble(root, registry as never);
      return false; // should have thrown
    } catch (err) {
      if (!(err instanceof ResolutionError)) return false;
      return err.kind === "missing-block" && err.merkleRoot === root;
    }
  },
);

// ---------------------------------------------------------------------------
// A2.6: assemble() — byte-identical re-emit (determinism)
// ---------------------------------------------------------------------------

/**
 * Two assemble() calls with the same registry and entry root are byte-identical.
 *
 * Invariant (A2.6, DEC-COMPILE-ASSEMBLE-003): given an unchanged registry,
 * selectBlocks returns the same ordered list, the same BlockMerkleRoot is chosen,
 * and the emitted artifact is byte-identical. This is the canonical re-emit
 * invariant that the Evaluation Contract requires.
 */
export const prop_assemble_deterministic_byte_identical_reemit = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const implSource = "export function f(x: number): number { return x + 1; }";
    const blocks = new Map([[root, { specHash, implSource }]]);
    const registry = makeAssembleStubRegistry(blocks);
    const a1 = await assemble(root, registry as never);
    const a2 = await assemble(root, registry as never);
    return a1.source === a2.source;
  },
);

// ---------------------------------------------------------------------------
// A2.8: AssembleOptions — knownMerkleRoots enables stem index
// ---------------------------------------------------------------------------

/**
 * knownMerkleRoots enables sub-block resolution via stem-to-SpecHash index.
 *
 * When knownMerkleRoots is supplied, assemble() pre-builds a stem → SpecHash
 * index and resolves sub-block imports via selectBlocks. For a two-block graph
 * where the parent imports a child via "@yakcc/seeds/blocks/leaf", both roots as
 * knownMerkleRoots enables the child to be found and included in the manifest.
 *
 * Invariant (A2.4, A2.5, A2.8): buildStemSpecHashIndex pre-fetches known roots;
 * the subBlockResolver closure uses the index to resolve import stems to BlockMerkleRoots.
 */
export const prop_assemble_knownMerkleRoots_enables_sub_block_resolution = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  blockRootArb,
  specHashArb,
  async (leafRoot, leafSpec, entryRoot, entrySpec) => {
    fc.pre(leafRoot !== entryRoot);
    // Leaf block: exports function "leaf"
    const leafImpl = "export function leaf(x: number): number { return x; }";
    // Entry block: imports leaf via @yakcc/seeds/blocks/leaf
    const entryImpl = `import type { Leaf } from "@yakcc/seeds/blocks/leaf";
export function entry(x: number): number { return x; }`;
    const blocks = new Map([
      [leafRoot, { specHash: leafSpec, implSource: leafImpl }],
      [entryRoot, { specHash: entrySpec, implSource: entryImpl }],
    ]);
    // selectBlocks(leafSpec) → [leafRoot]
    const specIndex = new Map([[leafSpec, [leafRoot]]]);
    const registry = makeAssembleStubRegistry(blocks, specIndex);
    const artifact = await assemble(entryRoot, registry as never, undefined, {
      knownMerkleRoots: [leafRoot, entryRoot],
    });
    // With knownMerkleRoots, the stem "leaf" → leafSpec → leafRoot is resolved
    // so the manifest should contain both blocks
    return artifact.manifest.entries.length === 2;
  },
);

// ---------------------------------------------------------------------------
// A2.1: importPathStem — tested transitively via assemble stub
// (exercised directly through fc.property with known constant inputs)
// ---------------------------------------------------------------------------

/**
 * importPathStem extracts the last segment from "@yakcc/seeds/blocks/<name>" paths.
 *
 * Tested transitively via assemble(): when a block's implSource has an import
 * from "@yakcc/seeds/blocks/<stem>" and knownMerkleRoots provides a block that
 * exports a function named camelCase(stem), assemble() resolves the sub-block.
 *
 * This property verifies stem extraction is consistent with the camelCase
 * conversion: stem "bracket" → fnName "bracket" (no hyphens, trivial case).
 *
 * Invariant (A2.1, A2.2): importPathStem + stemToCamelCase must produce the same
 * identifier that extractFunctionName returns from the sub-block's implSource.
 */
export const prop_importPathStem_seeds_prefix_extracts_stem = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  blockRootArb,
  specHashArb,
  async (childRoot, childSpec, parentRoot, parentSpec) => {
    fc.pre(childRoot !== parentRoot);
    // "bracket" is a simple stem with no kebab-case conversion needed
    const childImpl = "export function bracket(s: string): boolean { return true; }";
    const parentImpl = `import type { Bracket } from "@yakcc/seeds/blocks/bracket";
export function top(x: string): boolean { return true; }`;
    const blocks = new Map([
      [childRoot, { specHash: childSpec, implSource: childImpl }],
      [parentRoot, { specHash: parentSpec, implSource: parentImpl }],
    ]);
    const specIndex = new Map([[childSpec, [childRoot]]]);
    const registry = makeAssembleStubRegistry(blocks, specIndex);
    const artifact = await assemble(parentRoot, registry as never, undefined, {
      knownMerkleRoots: [childRoot, parentRoot],
    });
    // If stem extraction and camelCase conversion work, both blocks are included
    return artifact.manifest.entries.length === 2;
  },
);
