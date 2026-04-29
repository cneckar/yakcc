/**
 * resolve.test.ts — composition-graph traversal tests.
 *
 * Production sequence exercised:
 *   openRegistry(":memory:") → seedRegistry() → resolveComposition(entry, registry, resolver)
 *
 * Tests cover:
 *   - Single-block resolution (no sub-blocks)
 *   - Two-deep composition (leaf appears before parent in order)
 *   - Full list-of-ints corpus (transitive closure)
 *   - Cycle detection (synthetic two-contract cycle)
 *   - Missing block (contract not in registry)
 */

import { type Contract, type ContractId, type ContractSpec, contractId } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { Implementation, Registry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResolutionError, resolveComposition } from "./resolve.js";
import type { SubBlockResolver } from "./resolve.js";

// ---------------------------------------------------------------------------
// Deterministic mock embedding provider (avoids ONNX model loading in tests)
// ---------------------------------------------------------------------------

function mockEmbeddingProvider() {
  return {
    dimension: 384,
    modelId: "mock/test-provider",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        vec[i] = text.charCodeAt(i % text.length) / 128 + i * 0.001;
      }
      let norm = 0;
      for (const v of vec) norm += v * v;
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
      for (let i = 0; i < vec.length; i++) {
        const val = vec[i];
        if (val !== undefined) vec[i] = val * scale;
      }
      return vec;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSpec(behavior: string): ContractSpec {
  return {
    inputs: [{ name: "input", type: "string" }],
    outputs: [{ name: "result", type: "number" }],
    behavior,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  };
}

function makeContract(spec: ContractSpec): Contract {
  return { id: contractId(spec), spec, evidence: { testHistory: [] } };
}

function makeImpl(contract: Contract, source: string): Implementation {
  const bytes = new TextEncoder().encode(source);
  // Simple blockId: hex of first 8 bytes of XOR-folded source
  let hash = 0;
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash << 5) - hash + (bytes[i] ?? 0)) | 0;
  }
  return {
    source,
    blockId: Math.abs(hash).toString(16).padStart(16, "0").repeat(4),
    contractId: contract.id,
  };
}

/** Resolver that never resolves any import path (used for single-block tests). */
const nullResolver: SubBlockResolver = async () => null;

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;

beforeEach(async () => {
  registry = await openRegistry(":memory:", { embeddings: mockEmbeddingProvider() });
});

afterEach(async () => {
  await registry.close();
});

// ---------------------------------------------------------------------------
// Single-block resolution
// ---------------------------------------------------------------------------

describe("resolveComposition — single block", () => {
  it("resolves a single block with no sub-blocks", async () => {
    const spec = makeSpec("Return the integer 42");
    const contract = makeContract(spec);
    const source = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(spec)};
export function answer(): number { return 42; }
`;
    const impl = makeImpl(contract, source);
    await registry.store(contract, impl);

    const result = await resolveComposition(contract.id, registry, nullResolver);

    expect(result.entry).toBe(contract.id);
    expect(result.blocks.size).toBe(1);
    expect(result.order).toHaveLength(1);
    expect(result.order[0]).toBe(contract.id);
    expect(result.blocks.get(contract.id)?.source).toBe(source);
    expect(result.blocks.get(contract.id)?.subBlocks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Two-deep composition
// ---------------------------------------------------------------------------

describe("resolveComposition — two-deep composition", () => {
  it("resolves leaf first, parent last", async () => {
    const leafSpec = makeSpec("Return character at position");
    const leafContract = makeContract(leafSpec);
    const leafSource = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(leafSpec)};
export function charAt(s: string, i: number): string { return s[i] ?? ""; }
`;
    await registry.store(leafContract, makeImpl(leafContract, leafSource));

    // Parent block references leaf via "@yakcc/blocks/char-at" import path.
    const parentSpec = makeSpec("Check bracket character");
    const parentContract = makeContract(parentSpec);
    const parentSource = `import type { ContractSpec } from "@yakcc/contracts";
import type { charAt } from "@yakcc/blocks/char-at";
type _CharAt = typeof charAt;
export const CONTRACT: ContractSpec = ${JSON.stringify(parentSpec)};
export function checkBracket(s: string, i: number): boolean { return s[i] === "["; }
`;
    await registry.store(parentContract, makeImpl(parentContract, parentSource));

    // Resolver: "@yakcc/blocks/char-at" → leafContract.id
    const resolver: SubBlockResolver = async (importedFrom) => {
      if (importedFrom === "@yakcc/blocks/char-at") return leafContract.id;
      return null;
    };

    const result = await resolveComposition(parentContract.id, registry, resolver);

    expect(result.entry).toBe(parentContract.id);
    expect(result.blocks.size).toBe(2);
    expect(result.order).toHaveLength(2);
    // Topological order: leaf first, parent last.
    expect(result.order[0]).toBe(leafContract.id);
    expect(result.order[1]).toBe(parentContract.id);
  });
});

// ---------------------------------------------------------------------------
// Full list-of-ints corpus via seedRegistry
// ---------------------------------------------------------------------------

describe("resolveComposition — full list-of-ints corpus", () => {
  it("resolves the transitive closure of the list-of-ints corpus", async () => {
    const seedResult = await seedRegistry(registry);

    // Find the list-of-ints contractId — it is the last block in the seed list.
    // seedRegistry stores blocks in BLOCK_FILES order; list-of-ints.ts is in the list.
    // We find it by looking for a block whose exported function is "listOfInts".
    let listOfIntsId: ContractId | null = null;
    for (const id of seedResult.contractIds) {
      const impl = await registry.getImplementation(id);
      if (impl?.source.includes("export function listOfInts")) {
        listOfIntsId = id;
        break;
      }
    }
    expect(listOfIntsId).not.toBeNull();

    // Build a stem → contractId index for the resolver.
    const stemIndex = new Map<string, ContractId>();
    for (const id of seedResult.contractIds) {
      const impl = await registry.getImplementation(id);
      if (impl === null) continue;
      const match = impl.source.match(/^export\s+(?:async\s+)?function\s+(\w+)\s*[(<]/m);
      if (match?.[1]) stemIndex.set(match[1], id);
    }

    function stemToCamel(stem: string): string {
      return stem.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    }

    const resolver: SubBlockResolver = async (importedFrom) => {
      const lastSlash = importedFrom.lastIndexOf("/");
      const base = lastSlash >= 0 ? importedFrom.slice(lastSlash + 1) : importedFrom;
      const stem = base.endsWith(".js") ? base.slice(0, -3) : base;
      const camel = stemToCamel(stem);
      return stemIndex.get(camel) ?? stemIndex.get(stem) ?? null;
    };

    // biome-ignore lint/style/noNonNullAssertion: checked above
    const result = await resolveComposition(listOfIntsId!, registry, resolver);

    expect(result.blocks.size).toBeGreaterThanOrEqual(7);
    expect(result.order.length).toBeGreaterThanOrEqual(7);
    // Entry is last in topological order.
    expect(result.order[result.order.length - 1]).toBe(listOfIntsId);
    // All entries are ContractIds from the seed corpus.
    for (const id of result.order) {
      expect(seedResult.contractIds).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

describe("resolveComposition — cycle detection", () => {
  it("throws ResolutionError with kind 'cycle' on a two-contract cycle", async () => {
    const specA = makeSpec("Block A (composes B)");
    const specB = makeSpec("Block B (composes A)");
    const contractA = makeContract(specA);
    const contractB = makeContract(specB);

    // Source for A declares a sub-block import pointing to B.
    const sourceA = `import type { ContractSpec } from "@yakcc/contracts";
import type { blockB } from "@yakcc/blocks/block-b";
type _BlockB = typeof blockB;
export const CONTRACT: ContractSpec = ${JSON.stringify(specA)};
export function blockA(): string { return "A"; }
`;
    // Source for B declares a sub-block import pointing to A.
    const sourceB = `import type { ContractSpec } from "@yakcc/contracts";
import type { blockA } from "@yakcc/blocks/block-a";
type _BlockA = typeof blockA;
export const CONTRACT: ContractSpec = ${JSON.stringify(specB)};
export function blockB(): string { return "B"; }
`;

    await registry.store(contractA, makeImpl(contractA, sourceA));
    await registry.store(contractB, makeImpl(contractB, sourceB));

    const resolver: SubBlockResolver = async (importedFrom) => {
      if (importedFrom === "@yakcc/blocks/block-b") return contractB.id;
      if (importedFrom === "@yakcc/blocks/block-a") return contractA.id;
      return null;
    };

    await expect(resolveComposition(contractA.id, registry, resolver)).rejects.toThrow(
      ResolutionError,
    );

    try {
      await resolveComposition(contractA.id, registry, resolver);
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionError);
      expect((err as ResolutionError).kind).toBe("cycle");
    }
  });
});

// ---------------------------------------------------------------------------
// Missing contract
// ---------------------------------------------------------------------------

describe("resolveComposition — missing contract", () => {
  it("throws ResolutionError with kind 'missing-contract' for unknown contractId", async () => {
    // Derive a contractId that was never stored.
    const spec = makeSpec("This contract was never stored in the registry");
    const id = contractId(spec) as ContractId;

    await expect(resolveComposition(id, registry, nullResolver)).rejects.toThrow(ResolutionError);

    try {
      await resolveComposition(id, registry, nullResolver);
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionError);
      expect((err as ResolutionError).kind).toBe("missing-contract");
      expect((err as ResolutionError).contractId).toBe(id);
    }
  });
});
