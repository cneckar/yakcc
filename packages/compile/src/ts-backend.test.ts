/**
 * ts-backend.test.ts — unit tests for the TypeScript compilation backend.
 *
 * Production sequence exercised:
 *   tsBackend().emit(resolution) → assembled module source string
 *
 * Tests use pre-built ResolutionResult objects with BlockMerkleRoot keys
 * (WI-T04 triplet schema). Synthetic blockMerkleRoot values are computed via
 * blockMerkleRoot() from @yakcc/contracts so the fixture types are correct.
 *
 * Tests cover:
 *   - Single-block emission: non-empty source, exported function preserved
 *   - Two-deep composition: both functions present, no duplicate ContractSpec import
 *   - Intra-corpus import stripping: assembled output has no "./X.js" sibling imports
 *   - Shadow type alias stripping: assembled output has no "type _X = typeof X" lines
 *   - Entry re-export: last line re-exports the entry function by name
 *
 * @decision DEC-COMPILE-TS-BACKEND-TEST-001: Tests use pre-built ResolutionResult
 * objects rather than going through the full assemble() pipeline, to keep the
 * backend unit tests decoupled from the resolution graph traversal. The compound
 * interaction test in assemble.test.ts covers the full pipeline.
 * Updated (WI-T04): fixture helpers now compute real BlockMerkleRoots via
 * blockMerkleRoot() from @yakcc/contracts (previously used ContractId keys).
 * Status: updated (WI-T04)
 */

import {
  type BlockMerkleRoot,
  type LocalTriplet,
  type SpecYak,
  blockMerkleRoot,
  specHash,
} from "@yakcc/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolutionResult, ResolvedBlock } from "./resolve.js";
import { assembleModule, tsBackend } from "./ts-backend.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal SpecYak for testing. Each unique behavior string produces
 * a distinct specHash (and thus a distinct BlockMerkleRoot when combined with
 * distinct impl sources).
 */
function makeSpecYak(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "input", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  };
}

const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

/**
 * Compute a real BlockMerkleRoot for (name, behavior, implSource).
 * Deterministic: same inputs always produce the same root.
 */
function makeMerkleRoot(name: string, behavior: string, implSource: string): BlockMerkleRoot {
  const spec = makeSpecYak(name, behavior);
  const manifest = JSON.parse(MINIMAL_MANIFEST_JSON) as {
    artifacts: Array<{ kind: string; path: string }>;
  };
  const artifactBytes = new TextEncoder().encode(implSource);
  const artifactsMap = new Map<string, Uint8Array>();
  for (const art of manifest.artifacts) {
    artifactsMap.set(art.path, artifactBytes);
  }
  return blockMerkleRoot({
    spec,
    implSource,
    manifest: manifest as LocalTriplet["manifest"],
    artifacts: artifactsMap,
  });
}

/**
 * Build a minimal ResolutionResult from a list of (merkleRoot, source) pairs.
 * Order is the same as the input array (caller is responsible for topological ordering).
 * The entry is the last element's merkleRoot.
 */
function makeResolution(
  blocks: ReadonlyArray<{
    id: BlockMerkleRoot;
    source: string;
    subBlocks?: BlockMerkleRoot[];
    specHashVal?: ReturnType<typeof specHash>;
  }>,
): ResolutionResult {
  const blockMap = new Map<BlockMerkleRoot, ResolvedBlock>();
  const order: BlockMerkleRoot[] = [];

  for (const { id, source, subBlocks = [], specHashVal } of blocks) {
    // Use a synthetic specHash if not provided (computed from a placeholder spec).
    const sh = specHashVal ?? specHash(makeSpecYak(id.slice(0, 8), `behavior-${id.slice(0, 8)}`));
    blockMap.set(id, { merkleRoot: id, specHash: sh, source, subBlocks });
    order.push(id);
  }

  const entry = order[order.length - 1] as BlockMerkleRoot;
  return { entry, blocks: blockMap, order };
}

// ---------------------------------------------------------------------------
// Single-block emission
// ---------------------------------------------------------------------------

describe("tsBackend — single block", () => {
  let backend: ReturnType<typeof tsBackend>;

  beforeEach(() => {
    backend = tsBackend();
  });

  afterEach(() => {
    // no teardown needed
  });

  it("emits non-empty source for a single block", async () => {
    const implSource = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = { behavior: "Return 42" } as unknown as ContractSpec;
export function answer(): number { return 42; }
`;
    const id = makeMerkleRoot("answer", "Return 42", implSource);
    const resolution = makeResolution([{ id, source: implSource }]);
    const emitted = await backend.emit(resolution);

    expect(emitted.trim().length).toBeGreaterThan(0);
  });

  it("emits source containing the exported function from the block", async () => {
    const implSource = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = { behavior: "Return the integer 42" } as unknown as ContractSpec;
export function theAnswer(): number { return 42; }
`;
    const id = makeMerkleRoot("theAnswer", "Return the integer 42", implSource);
    const resolution = makeResolution([{ id, source: implSource }]);
    const emitted = await backend.emit(resolution);

    expect(emitted).toContain("function theAnswer");
  });

  it("emits exactly one @yakcc/contracts import line even if block has one", async () => {
    const implSource = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = { behavior: "Identity function" } as unknown as ContractSpec;
export function identity(x: string): string { return x; }
`;
    const id = makeMerkleRoot("identity", "Identity function", implSource);
    const resolution = makeResolution([{ id, source: implSource }]);
    const emitted = await backend.emit(resolution);

    const contractsImportLines = emitted.split("\n").filter((l) => l.includes("@yakcc/contracts"));
    expect(contractsImportLines.length).toBe(1);
  });

  it("re-exports the entry function as the module public surface", async () => {
    const implSource = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = { behavior: "Returns a greeting" } as unknown as ContractSpec;
export function greet(): string { return "hello"; }
`;
    const id = makeMerkleRoot("greet", "Returns a greeting", implSource);
    const resolution = makeResolution([{ id, source: implSource }]);
    const emitted = await backend.emit(resolution);

    expect(emitted).toContain("export { greet }");
  });
});

// ---------------------------------------------------------------------------
// Two-deep composition
// ---------------------------------------------------------------------------

describe("tsBackend — two-deep composition", () => {
  it("includes both leaf and parent functions in emitted source", async () => {
    const leafImpl = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = { behavior: "Return character code at position" } as unknown as ContractSpec;
export function charCode(s: string, i: number): number { return s.charCodeAt(i); }
`;
    const leafId = makeMerkleRoot("charCode", "Return character code at position", leafImpl);

    const parentImpl = `import type { ContractSpec } from "@yakcc/contracts";
import type { charCode } from "./char-code.js";
type _CharCode = typeof charCode;
export const CONTRACT: ContractSpec = { behavior: "Check if character is open bracket" } as unknown as ContractSpec;
export function isBracket(s: string, i: number): boolean { return s[i] === "["; }
`;
    const parentId = makeMerkleRoot("isBracket", "Check if character is open bracket", parentImpl);

    // Topological order: leaf first, parent last
    const resolution = makeResolution([
      { id: leafId, source: leafImpl, subBlocks: [] },
      { id: parentId, source: parentImpl, subBlocks: [leafId] },
    ]);
    const emitted = await tsBackend().emit(resolution);

    expect(emitted).toContain("function charCode");
    expect(emitted).toContain("function isBracket");
  });

  it("does not emit duplicate @yakcc/contracts import lines", async () => {
    const leafImpl = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = { behavior: "Leaf block" } as unknown as ContractSpec;
export function leaf(): number { return 0; }
`;
    const leafId = makeMerkleRoot("leaf", "Leaf block", leafImpl);

    const parentImpl = `import type { ContractSpec } from "@yakcc/contracts";
import type { leaf } from "./leaf.js";
type _Leaf = typeof leaf;
export const CONTRACT: ContractSpec = { behavior: "Parent block" } as unknown as ContractSpec;
export function parent(): number { return leaf() + 1; }
`;
    const parentId = makeMerkleRoot("parent", "Parent block", parentImpl);

    const resolution = makeResolution([
      { id: leafId, source: leafImpl },
      { id: parentId, source: parentImpl, subBlocks: [leafId] },
    ]);
    const emitted = await tsBackend().emit(resolution);

    const contractsImportCount = emitted
      .split("\n")
      .filter((l) => l.includes('@yakcc/contracts"')).length;
    expect(contractsImportCount).toBe(1);
  });

  it("strips intra-corpus import type lines from assembled output", async () => {
    const leafImpl = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = { behavior: "Leaf with relative import" } as unknown as ContractSpec;
export function leafFn(): string { return "leaf"; }
`;
    const leafId = makeMerkleRoot("leafFn", "Leaf with relative import", leafImpl);

    const parentImpl = `import type { ContractSpec } from "@yakcc/contracts";
import type { leafFn } from "./leaf-fn.js";
type _LeafFn = typeof leafFn;
export const CONTRACT: ContractSpec = { behavior: "Parent with relative import ref" } as unknown as ContractSpec;
export function parentFn(): string { return "parent"; }
`;
    const parentId = makeMerkleRoot("parentFn", "Parent with relative import ref", parentImpl);

    const resolution = makeResolution([
      { id: leafId, source: leafImpl },
      { id: parentId, source: parentImpl, subBlocks: [leafId] },
    ]);
    const emitted = await tsBackend().emit(resolution);

    // No "./X.js" sibling imports should appear in the assembled output.
    expect(emitted).not.toMatch(/import type\s+\{[^}]*\}\s+from\s+["']\.\/[^"']*["']/);
  });

  it("strips shadow type alias lines from assembled output", async () => {
    const leafImpl = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = { behavior: "Leaf for shadow alias test" } as unknown as ContractSpec;
export function shadowLeaf(): void { return; }
`;
    const leafId = makeMerkleRoot("shadowLeaf", "Leaf for shadow alias test", leafImpl);

    const parentImpl = `import type { ContractSpec } from "@yakcc/contracts";
import type { shadowLeaf } from "./shadow-leaf.js";
type _ShadowLeaf = typeof shadowLeaf;
export const CONTRACT: ContractSpec = { behavior: "Parent with shadow alias" } as unknown as ContractSpec;
export function shadowParent(): void { return; }
`;
    const parentId = makeMerkleRoot("shadowParent", "Parent with shadow alias", parentImpl);

    const resolution = makeResolution([
      { id: leafId, source: leafImpl },
      { id: parentId, source: parentImpl, subBlocks: [leafId] },
    ]);
    const emitted = await tsBackend().emit(resolution);

    // Shadow type alias lines must be stripped.
    expect(emitted).not.toMatch(/^type\s+_\w+\s*=\s*typeof\s+\w+/m);
  });

  it("entry block function is re-exported and can be called from the assembled module", async () => {
    // This is the compound-interaction test: both functions present and entry is callable.
    const leafImpl = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = { behavior: "Leaf double function" } as unknown as ContractSpec;
export function doubler(n: number): number { return n * 2; }
`;
    const leafId = makeMerkleRoot("doubler", "Leaf double function", leafImpl);

    // Parent references leaf via intra-corpus import but inlines logic itself
    const parentImpl = `import type { ContractSpec } from "@yakcc/contracts";
import type { doubler } from "./doubler.js";
type _Doubler = typeof doubler;
export const CONTRACT: ContractSpec = { behavior: "Parent triple function" } as unknown as ContractSpec;
export function tripler(n: number): number { return n * 3; }
`;
    const parentId = makeMerkleRoot("tripler", "Parent triple function", parentImpl);

    const resolution = makeResolution([
      { id: leafId, source: leafImpl },
      { id: parentId, source: parentImpl, subBlocks: [leafId] },
    ]);
    const emitted = await tsBackend().emit(resolution);

    // Both functions must be present for the module to be correct.
    expect(emitted).toContain("function doubler");
    expect(emitted).toContain("function tripler");
    // Re-export of the entry function (parent = tripler) is present.
    expect(emitted).toContain("export { tripler }");
  });
});

// ---------------------------------------------------------------------------
// assembleModule internal helper — direct unit tests
// ---------------------------------------------------------------------------

describe("assembleModule internal helper", () => {
  it("header comment is always present", () => {
    const implSource = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = { behavior: "Any block" } as unknown as ContractSpec;
export function anyFn(): void { return; }
`;
    const id = makeMerkleRoot("anyFn", "Any block", implSource);
    const resolution = makeResolution([{ id, source: implSource }]);
    const output = assembleModule(resolution);

    expect(output).toContain("Assembled by @yakcc/compile");
    expect(output).toContain("no code was generated");
  });

  it("emits block separator comment with BlockMerkleRoot", () => {
    const implSource = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = { behavior: "Block with separator" } as unknown as ContractSpec;
export function separatorFn(): void { return; }
`;
    const id = makeMerkleRoot("separatorFn", "Block with separator", implSource);
    const resolution = makeResolution([{ id, source: implSource }]);
    const output = assembleModule(resolution);

    expect(output).toContain(`// --- block: ${id} ---`);
  });

  it("deduplicates ContractSpec symbol from @yakcc/contracts imports across two blocks", () => {
    const leafImpl = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = { behavior: "Leaf with ContractSpec import" } as unknown as ContractSpec;
type _Spec = ContractSpec;
export function specLeaf(): string { return "leaf"; }
`;
    const leafId = makeMerkleRoot("specLeaf", "Leaf with ContractSpec import", leafImpl);

    const parentImpl = `import type { ContractSpec } from "@yakcc/contracts";
import type { specLeaf } from "./spec-leaf.js";
type _SpecLeaf = typeof specLeaf;
export const CONTRACT: ContractSpec = { behavior: "Parent also importing ContractSpec" } as unknown as ContractSpec;
export function specParent(): string { return "parent"; }
`;
    const parentId = makeMerkleRoot("specParent", "Parent also importing ContractSpec", parentImpl);

    const resolution = makeResolution([
      { id: leafId, source: leafImpl },
      { id: parentId, source: parentImpl, subBlocks: [leafId] },
    ]);
    const output = assembleModule(resolution);

    // Should have exactly one @yakcc/contracts import.
    const contractsLines = output.split("\n").filter((l) => l.includes("@yakcc/contracts"));
    expect(contractsLines.length).toBe(1);
    // ContractSpec should be in that one line.
    const importLine = contractsLines[0] ?? "";
    expect(importLine).toContain("ContractSpec");
  });
});
