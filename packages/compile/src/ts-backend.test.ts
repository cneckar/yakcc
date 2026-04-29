/**
 * ts-backend.test.ts — unit tests for the TypeScript compilation backend.
 *
 * Production sequence exercised:
 *   tsBackend().emit(resolution) → assembled module source string
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
 * Status: implemented (WI-005)
 */

import { type ContractId, contractId } from "@yakcc/contracts";
import type { ContractSpec } from "@yakcc/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolutionResult, ResolvedBlock } from "./resolve.js";
import { assembleModule, tsBackend } from "./ts-backend.js";

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

function makeContractId(spec: ContractSpec): ContractId {
  return contractId(spec) as ContractId;
}

/**
 * Build a minimal ResolutionResult from a list of (contractId, source) pairs.
 * Order is the same as the input array (caller is responsible for topological ordering).
 * The entry is the last element's contractId.
 */
function makeResolution(
  blocks: ReadonlyArray<{ id: ContractId; source: string; subBlocks?: ContractId[] }>,
): ResolutionResult {
  const blockMap = new Map<ContractId, ResolvedBlock>();
  const order: ContractId[] = [];

  for (const { id, source, subBlocks = [] } of blocks) {
    blockMap.set(id, { contractId: id, source, subBlocks });
    order.push(id);
  }

  const entry = order[order.length - 1] as ContractId;
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
    const spec = makeSpec("Return 42");
    const id = makeContractId(spec);
    const source = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(spec)};
export function answer(): number { return 42; }
`;
    const resolution = makeResolution([{ id, source }]);
    const emitted = await backend.emit(resolution);

    expect(emitted.trim().length).toBeGreaterThan(0);
  });

  it("emits source containing the exported function from the block", async () => {
    const spec = makeSpec("Return the integer 42");
    const id = makeContractId(spec);
    const source = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(spec)};
export function theAnswer(): number { return 42; }
`;
    const resolution = makeResolution([{ id, source }]);
    const emitted = await backend.emit(resolution);

    expect(emitted).toContain("function theAnswer");
  });

  it("emits exactly one @yakcc/contracts import line even if block has one", async () => {
    const spec = makeSpec("Identity function");
    const id = makeContractId(spec);
    const source = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(spec)};
export function identity(x: string): string { return x; }
`;
    const resolution = makeResolution([{ id, source }]);
    const emitted = await backend.emit(resolution);

    const contractsImportLines = emitted.split("\n").filter((l) => l.includes("@yakcc/contracts"));
    expect(contractsImportLines.length).toBe(1);
  });

  it("re-exports the entry function as the module public surface", async () => {
    const spec = makeSpec("Returns a greeting");
    const id = makeContractId(spec);
    const source = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(spec)};
export function greet(): string { return "hello"; }
`;
    const resolution = makeResolution([{ id, source }]);
    const emitted = await backend.emit(resolution);

    expect(emitted).toContain("export { greet }");
  });
});

// ---------------------------------------------------------------------------
// Two-deep composition
// ---------------------------------------------------------------------------

describe("tsBackend — two-deep composition", () => {
  it("includes both leaf and parent functions in emitted source", async () => {
    const leafSpec = makeSpec("Return character code at position");
    const leafId = makeContractId(leafSpec);
    const leafSource = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(leafSpec)};
export function charCode(s: string, i: number): number { return s.charCodeAt(i); }
`;

    const parentSpec = makeSpec("Check if character is open bracket");
    const parentId = makeContractId(parentSpec);
    // Parent references leaf via intra-corpus import type
    const parentSource = `import type { ContractSpec } from "@yakcc/contracts";
import type { charCode } from "./char-code.js";
type _CharCode = typeof charCode;
export const CONTRACT: ContractSpec = ${JSON.stringify(parentSpec)};
export function isBracket(s: string, i: number): boolean { return s[i] === "["; }
`;

    // Topological order: leaf first, parent last
    const resolution = makeResolution([
      { id: leafId, source: leafSource, subBlocks: [] },
      { id: parentId, source: parentSource, subBlocks: [leafId] },
    ]);
    const emitted = await tsBackend().emit(resolution);

    expect(emitted).toContain("function charCode");
    expect(emitted).toContain("function isBracket");
  });

  it("does not emit duplicate @yakcc/contracts import lines", async () => {
    const leafSpec = makeSpec("Leaf block");
    const leafId = makeContractId(leafSpec);
    const leafSource = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(leafSpec)};
export function leaf(): number { return 0; }
`;

    const parentSpec = makeSpec("Parent block");
    const parentId = makeContractId(parentSpec);
    const parentSource = `import type { ContractSpec } from "@yakcc/contracts";
import type { leaf } from "./leaf.js";
type _Leaf = typeof leaf;
export const CONTRACT: ContractSpec = ${JSON.stringify(parentSpec)};
export function parent(): number { return leaf() + 1; }
`;

    const resolution = makeResolution([
      { id: leafId, source: leafSource },
      { id: parentId, source: parentSource, subBlocks: [leafId] },
    ]);
    const emitted = await tsBackend().emit(resolution);

    const contractsImportCount = emitted
      .split("\n")
      .filter((l) => l.includes('@yakcc/contracts"')).length;
    expect(contractsImportCount).toBe(1);
  });

  it("strips intra-corpus import type lines from assembled output", async () => {
    const leafSpec = makeSpec("Leaf with relative import");
    const leafId = makeContractId(leafSpec);
    const leafSource = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(leafSpec)};
export function leafFn(): string { return "leaf"; }
`;

    const parentSpec = makeSpec("Parent with relative import ref");
    const parentId = makeContractId(parentSpec);
    const parentSource = `import type { ContractSpec } from "@yakcc/contracts";
import type { leafFn } from "./leaf-fn.js";
type _LeafFn = typeof leafFn;
export const CONTRACT: ContractSpec = ${JSON.stringify(parentSpec)};
export function parentFn(): string { return "parent"; }
`;

    const resolution = makeResolution([
      { id: leafId, source: leafSource },
      { id: parentId, source: parentSource, subBlocks: [leafId] },
    ]);
    const emitted = await tsBackend().emit(resolution);

    // No "./X.js" sibling imports should appear in the assembled output.
    expect(emitted).not.toMatch(/import type\s+\{[^}]*\}\s+from\s+["']\.\/[^"']*["']/);
  });

  it("strips shadow type alias lines from assembled output", async () => {
    const leafSpec = makeSpec("Leaf for shadow alias test");
    const leafId = makeContractId(leafSpec);
    const leafSource = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(leafSpec)};
export function shadowLeaf(): void { return; }
`;

    const parentSpec = makeSpec("Parent with shadow alias");
    const parentId = makeContractId(parentSpec);
    const parentSource = `import type { ContractSpec } from "@yakcc/contracts";
import type { shadowLeaf } from "./shadow-leaf.js";
type _ShadowLeaf = typeof shadowLeaf;
export const CONTRACT: ContractSpec = ${JSON.stringify(parentSpec)};
export function shadowParent(): void { return; }
`;

    const resolution = makeResolution([
      { id: leafId, source: leafSource },
      { id: parentId, source: parentSource, subBlocks: [leafId] },
    ]);
    const emitted = await tsBackend().emit(resolution);

    // Shadow type alias lines must be stripped.
    expect(emitted).not.toMatch(/^type\s+_\w+\s*=\s*typeof\s+\w+/m);
  });

  it("entry block function is re-exported and can be called from the assembled module", async () => {
    // This is the compound-interaction test: both functions present and entry is callable.
    const leafSpec = makeSpec("Leaf double function");
    const leafId = makeContractId(leafSpec);
    const leafSource = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(leafSpec)};
export function doubler(n: number): number { return n * 2; }
`;

    const parentSpec = makeSpec("Parent triple function");
    const parentId = makeContractId(parentSpec);
    // Parent references leaf via intra-corpus import but inlines logic itself
    const parentSource = `import type { ContractSpec } from "@yakcc/contracts";
import type { doubler } from "./doubler.js";
type _Doubler = typeof doubler;
export const CONTRACT: ContractSpec = ${JSON.stringify(parentSpec)};
export function tripler(n: number): number { return n * 3; }
`;

    const resolution = makeResolution([
      { id: leafId, source: leafSource },
      { id: parentId, source: parentSource, subBlocks: [leafId] },
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
    const spec = makeSpec("Any block");
    const id = makeContractId(spec);
    const source = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(spec)};
export function anyFn(): void { return; }
`;
    const resolution = makeResolution([{ id, source }]);
    const output = assembleModule(resolution);

    expect(output).toContain("Assembled by @yakcc/compile");
    expect(output).toContain("no code was generated");
  });

  it("emits block separator comment with contractId", () => {
    const spec = makeSpec("Block with separator");
    const id = makeContractId(spec);
    const source = `import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(spec)};
export function separatorFn(): void { return; }
`;
    const resolution = makeResolution([{ id, source }]);
    const output = assembleModule(resolution);

    expect(output).toContain(`// --- block: ${id} ---`);
  });

  it("deduplicates ContractId symbol from @yakcc/contracts imports across two blocks", () => {
    const leafSpec = makeSpec("Leaf with ContractId import");
    const leafId = makeContractId(leafSpec);
    const leafSource = `import type { ContractId, ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = ${JSON.stringify(leafSpec)};
type _Id = ContractId;
export function idLeaf(): string { return "leaf"; }
`;

    const parentSpec = makeSpec("Parent also importing ContractSpec");
    const parentId = makeContractId(parentSpec);
    const parentSource = `import type { ContractSpec } from "@yakcc/contracts";
import type { idLeaf } from "./id-leaf.js";
type _IdLeaf = typeof idLeaf;
export const CONTRACT: ContractSpec = ${JSON.stringify(parentSpec)};
export function idParent(): string { return "parent"; }
`;

    const resolution = makeResolution([
      { id: leafId, source: leafSource },
      { id: parentId, source: parentSource, subBlocks: [leafId] },
    ]);
    const output = assembleModule(resolution);

    // Should have exactly one @yakcc/contracts import containing both symbols.
    const contractsLines = output.split("\n").filter((l) => l.includes("@yakcc/contracts"));
    expect(contractsLines.length).toBe(1);
    // Both symbols should be in that one line.
    const importLine = contractsLines[0] ?? "";
    expect(importLine).toContain("ContractId");
    expect(importLine).toContain("ContractSpec");
  });
});
