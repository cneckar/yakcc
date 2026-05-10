// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/compile resolve.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3a)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.

// ---------------------------------------------------------------------------
// Property-test corpus for compile/src/resolve.ts atoms
//
// Atoms covered (8 named):
//   extractSubBlockImports   (A5.1) — private; scans implSource for sub-block refs
//   visitBlock               (A5.2) — private; DFS node visitor (cycle detection, fetch)
//   resolveComposition       (A5.3) — exported public API
//   ResolutionError          (A5.4) — error class; kind + merkleRoot fields
//   ResolvedBlock            (A5.5) — output shape (merkleRoot, specHash, source, subBlocks)
//   ResolutionResult         (A5.6) — result shape (entry, blocks, order)
//   SubBlockResolver         (A5.7) — callback type; null-return skips ref
//   SUB_BLOCK_IMPORT_RE      (A5.8) — regex constant; private; tested transitively
//
// All tests use in-memory stub registries — no SQLite, no disk IO.
// Properties cover:
//   - Topological ordering (leaves before entry)
//   - Cycle detection (kind="cycle" error)
//   - Missing block (kind="missing-block" error)
//   - Determinism (same inputs → same outputs)
//   - Skip (resolver returning null omits that sub-block)
//   - ResolutionError field invariants
//   - Single-block trivial case
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import { ResolutionError, resolveComposition } from "./resolve.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary for 64-char lowercase hex strings representing BlockMerkleRoot/SpecHash.
 */
const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

const blockRootArb: fc.Arbitrary<BlockMerkleRoot> = hexHash64 as fc.Arbitrary<BlockMerkleRoot>;
const specHashArb: fc.Arbitrary<SpecHash> = hexHash64 as fc.Arbitrary<SpecHash>;

// ---------------------------------------------------------------------------
// Stub registry builder
// ---------------------------------------------------------------------------

/**
 * Minimal BlockTripletRow stub shape needed by resolveComposition.
 */
interface StubRow {
  specHash: SpecHash;
  implSource: string;
}

/**
 * Build a stub Registry from a map of merkleRoot → StubRow.
 * All other Registry methods throw "not_implemented" to surface accidental calls.
 */
function makeStubRegistry(rows: Map<BlockMerkleRoot, StubRow>): {
  getBlock: (root: BlockMerkleRoot) => Promise<{ specHash: SpecHash; implSource: string } | null>;
  selectBlocks: (specHash: SpecHash) => Promise<BlockMerkleRoot[]>;
  [key: string]: unknown;
} {
  return {
    async getBlock(root: BlockMerkleRoot) {
      return rows.get(root) ?? null;
    },
    async selectBlocks(_: SpecHash) {
      return [];
    },
    storeBlock() {
      throw new Error("stub: storeBlock not implemented");
    },
    findByCanonicalAstHash() {
      throw new Error("stub: findByCanonicalAstHash not implemented");
    },
    getProvenance() {
      throw new Error("stub: getProvenance not implemented");
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
    getForeignRefs() {
      throw new Error("stub: getForeignRefs not implemented");
    },
    async close() {},
  };
}

/** A SubBlockResolver that always returns null (skips all sub-block refs). */
async function nullResolver(_importedFrom: string): Promise<BlockMerkleRoot | null> {
  return null;
}

// ---------------------------------------------------------------------------
// A5.3 + A5.6: resolveComposition result shape — single block
// ---------------------------------------------------------------------------

/**
 * resolveComposition() returns a well-formed single-block ResolutionResult.
 *
 * For a registry with one block (no sub-block imports): entry === merkleRoot,
 * blocks.size === 1, order.length === 1 and order[0] === entry.
 *
 * Invariant: the trivial no-composition case always produces a well-formed
 * ResolutionResult with the entry as the sole block.
 */
export const prop_resolveComposition_single_block_result_shape = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const rows = new Map<BlockMerkleRoot, StubRow>([[root, { specHash, implSource: "" }]]);
    const registry = makeStubRegistry(rows);
    const result = await resolveComposition(root, registry as never, nullResolver);
    return (
      result.entry === root &&
      result.blocks.size === 1 &&
      result.blocks.has(root) &&
      result.order.length === 1 &&
      result.order[0] === root
    );
  },
);

/**
 * resolveComposition() ResolvedBlock has correct merkleRoot, specHash, source, subBlocks.
 *
 * Invariant (A5.5): visitBlock populates all four ResolvedBlock fields from the
 * registry row; no field is left undefined or mismatched.
 */
export const prop_resolveComposition_resolved_block_fields = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  fc.string({ minLength: 0, maxLength: 40 }),
  async (root, specHash, source) => {
    const rows = new Map<BlockMerkleRoot, StubRow>([[root, { specHash, implSource: source }]]);
    const registry = makeStubRegistry(rows);
    const result = await resolveComposition(root, registry as never, nullResolver);
    const block = result.blocks.get(root);
    return (
      block !== undefined &&
      block.merkleRoot === root &&
      block.specHash === specHash &&
      block.source === source &&
      Array.isArray(block.subBlocks) &&
      block.subBlocks.length === 0
    );
  },
);

// ---------------------------------------------------------------------------
// A5.3: resolveComposition — determinism
// ---------------------------------------------------------------------------

/**
 * resolveComposition() is deterministic: same registry + entry → same order and blocks.
 *
 * Invariant: resolveComposition is a pure function with no observable
 * side effects between calls on the same registry state.
 */
export const prop_resolveComposition_deterministic = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const rows = new Map<BlockMerkleRoot, StubRow>([[root, { specHash, implSource: "" }]]);
    const registry = makeStubRegistry(rows);
    const r1 = await resolveComposition(root, registry as never, nullResolver);
    const r2 = await resolveComposition(root, registry as never, nullResolver);
    if (r1.entry !== r2.entry) return false;
    if (r1.order.length !== r2.order.length) return false;
    for (let i = 0; i < r1.order.length; i++) {
      if (r1.order[i] !== r2.order[i]) return false;
    }
    return r1.blocks.size === r2.blocks.size;
  },
);

// ---------------------------------------------------------------------------
// A5.4: ResolutionError — missing block
// ---------------------------------------------------------------------------

/**
 * resolveComposition() throws ResolutionError kind="missing-block" for absent entry.
 *
 * Invariant (A5.4): ResolutionError always carries kind and merkleRoot; kind is
 * one of "missing-block" | "cycle" | "invalid-block".
 */
export const prop_ResolutionError_missing_block_kind_and_root = fc.asyncProperty(
  blockRootArb,
  async (root) => {
    const registry = makeStubRegistry(new Map());
    try {
      await resolveComposition(root, registry as never, nullResolver);
      return false; // should have thrown
    } catch (err) {
      if (!(err instanceof ResolutionError)) return false;
      return err.kind === "missing-block" && err.merkleRoot === root;
    }
  },
);

/**
 * ResolutionError is an instanceof Error with a non-empty message string.
 *
 * Invariant: ResolutionError extends Error correctly so callers can use both
 * catch clauses and explicit instanceof guards interchangeably.
 */
export const prop_ResolutionError_is_instanceof_Error = fc.asyncProperty(
  blockRootArb,
  async (root) => {
    const registry = makeStubRegistry(new Map());
    try {
      await resolveComposition(root, registry as never, nullResolver);
      return false;
    } catch (err) {
      return (
        err instanceof Error &&
        err instanceof ResolutionError &&
        typeof err.message === "string" &&
        err.message.length > 0
      );
    }
  },
);

// ---------------------------------------------------------------------------
// A5.4: ResolutionError — cycle detection
// ---------------------------------------------------------------------------

/**
 * resolveComposition() throws ResolutionError kind="cycle" for a self-cyclic graph.
 *
 * Invariant: visitBlock's path Set detects the cycle before recursing infinitely;
 * the error is thrown with kind="cycle" and the offending merkleRoot.
 */
export const prop_ResolutionError_cycle_detected = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    // Self-referential block: import from "@yakcc/seeds/blocks/self" where
    // the stem "self" is camelCase "self". We use a resolver that always maps
    // any import to the same root — creating a direct self-cycle.
    const rows = new Map<BlockMerkleRoot, StubRow>([
      [root, { specHash, implSource: `import type { Self } from "@yakcc/seeds/blocks/self";` }],
    ]);
    const registry = makeStubRegistry(rows);
    const selfResolver = async (_importedFrom: string): Promise<BlockMerkleRoot | null> => root;
    try {
      await resolveComposition(root, registry as never, selfResolver);
      return false; // should have thrown
    } catch (err) {
      if (!(err instanceof ResolutionError)) return false;
      return err.kind === "cycle";
    }
  },
);

// ---------------------------------------------------------------------------
// A5.7: SubBlockResolver — null return skips ref
// ---------------------------------------------------------------------------

/**
 * SubBlockResolver returning null silently skips the sub-block import.
 *
 * Invariant: visitBlock treats null from the resolver as "skip this import" —
 * it neither errors nor adds the null to subBlocks.
 */
export const prop_SubBlockResolver_null_skips_sub_block = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const implSource = `import type { Dep } from "@yakcc/seeds/blocks/dep";`;
    const rows = new Map<BlockMerkleRoot, StubRow>([[root, { specHash, implSource }]]);
    const registry = makeStubRegistry(rows);
    // Resolver always returns null → dep is skipped
    const result = await resolveComposition(root, registry as never, nullResolver);
    const block = result.blocks.get(root);
    return (
      block !== undefined &&
      Array.isArray(block.subBlocks) &&
      block.subBlocks.length === 0 &&
      result.order.length === 1
    );
  },
);

// ---------------------------------------------------------------------------
// A5.1: extractSubBlockImports — regex covers expected import styles
// (tested transitively through resolveComposition)
// ---------------------------------------------------------------------------

/**
 * extractSubBlockImports resolves "@yakcc/seeds/blocks/x" imports via the resolver.
 *
 * Invariant (A5.1): SUB_BLOCK_IMPORT_RE matches the @yakcc/seeds/ prefix;
 * extractSubBlockImports correctly extracts the full specifier.
 */
export const prop_extractSubBlockImports_seeds_prefix_resolved = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  blockRootArb,
  specHashArb,
  async (parentRoot, parentSpec, childRoot, childSpec) => {
    fc.pre(parentRoot !== childRoot);
    const parentImpl = `import type { Child } from "@yakcc/seeds/blocks/child";`;
    const rows = new Map<BlockMerkleRoot, StubRow>([
      [parentRoot, { specHash: parentSpec, implSource: parentImpl }],
      [childRoot, { specHash: childSpec, implSource: "" }],
    ]);
    const registry = makeStubRegistry(rows);
    const resolver = async (importedFrom: string): Promise<BlockMerkleRoot | null> => {
      if (importedFrom.endsWith("/child")) return childRoot;
      return null;
    };
    const result = await resolveComposition(parentRoot, registry as never, resolver);
    const block = result.blocks.get(parentRoot);
    return (
      block !== undefined &&
      block.subBlocks.length === 1 &&
      block.subBlocks[0] === childRoot &&
      result.order.length === 2 &&
      result.order[0] === childRoot && // child (leaf) comes first
      result.order[1] === parentRoot // parent (entry) comes last
    );
  },
);

/**
 * extractSubBlockImports also resolves "./" relative imports via the resolver.
 *
 * Invariant (A5.1): SUB_BLOCK_IMPORT_RE covers the "./" prefix in addition
 * to "@yakcc/seeds/" and "@yakcc/blocks/".
 */
export const prop_extractSubBlockImports_dot_slash_prefix_resolved = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  blockRootArb,
  specHashArb,
  async (parentRoot, parentSpec, childRoot, childSpec) => {
    fc.pre(parentRoot !== childRoot);
    const parentImpl = `import type { Child } from "./child.js";`;
    const rows = new Map<BlockMerkleRoot, StubRow>([
      [parentRoot, { specHash: parentSpec, implSource: parentImpl }],
      [childRoot, { specHash: childSpec, implSource: "" }],
    ]);
    const registry = makeStubRegistry(rows);
    const resolver = async (importedFrom: string): Promise<BlockMerkleRoot | null> => {
      if (importedFrom.startsWith("./")) return childRoot;
      return null;
    };
    const result = await resolveComposition(parentRoot, registry as never, resolver);
    const block = result.blocks.get(parentRoot);
    return block !== undefined && block.subBlocks.length === 1 && block.subBlocks[0] === childRoot;
  },
);

// ---------------------------------------------------------------------------
// A5.6: ResolutionResult — order is topological (leaves before entry)
// ---------------------------------------------------------------------------

/**
 * resolveComposition() order is topological: grandchild first, child, parent last.
 *
 * Invariant: post-order DFS in visitBlock guarantees topological order —
 * every dependency appears before its dependent in result.order.
 */
export const prop_resolveComposition_topological_order_two_depth = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  blockRootArb,
  specHashArb,
  blockRootArb,
  specHashArb,
  async (grandchild, gcSpec, child, childSpec, parent, parentSpec) => {
    fc.pre(grandchild !== child && child !== parent && grandchild !== parent);
    const rows = new Map<BlockMerkleRoot, StubRow>([
      [grandchild, { specHash: gcSpec, implSource: "" }],
      [
        child,
        { specHash: childSpec, implSource: `import type { A } from "@yakcc/seeds/blocks/a";` },
      ],
      [
        parent,
        { specHash: parentSpec, implSource: `import type { B } from "@yakcc/seeds/blocks/b";` },
      ],
    ]);
    const registry = makeStubRegistry(rows);
    const resolver = async (importedFrom: string): Promise<BlockMerkleRoot | null> => {
      if (importedFrom.endsWith("/a")) return grandchild;
      if (importedFrom.endsWith("/b")) return child;
      return null;
    };
    const result = await resolveComposition(parent, registry as never, resolver);
    if (result.order.length !== 3) return false;
    const gcIdx = result.order.indexOf(grandchild);
    const childIdx = result.order.indexOf(child);
    const parentIdx = result.order.indexOf(parent);
    return gcIdx < childIdx && childIdx < parentIdx;
  },
);
