// SPDX-License-Identifier: MIT
/**
 * graph-sources.test.ts — compiling from the stored graphs (#1279, DEC-COMPILE-GRAPH-SOURCE-001).
 *
 * Production sequence: openRegistry → storeBlock(row) → storeDucImplementation(packGraph(lift))
 *   → assemble(entry, withGraphSources(registry)) → transpile → import → call.
 * The module assembled from the graphs computes what the one assembled from the stored text does,
 * and its code is the emitter's, not the stored text.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type BlockMerkleRoot,
  type LocalTriplet,
  type SpecYak,
  blockMerkleRoot,
  canonicalAstHash,
  createOfflineEmbeddingProvider,
  specHash,
} from "@yakcc/contracts";
import { liftAtom, packGraph } from "@yakcc/duc";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow, Registry } from "@yakcc/registry";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assemble } from "./assemble.js";
import { graphSourceOf, withGraphSources } from "./graph-sources.js";

const MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

function makeBlockRow(
  name: string,
  inputs: string[],
  output: string,
  implSource: string,
): { row: BlockTripletRow; root: BlockMerkleRoot } {
  const spec: SpecYak = {
    name,
    inputs: inputs.map((type, i) => ({ name: `a${i}`, type })),
    outputs: [{ name: "result", type: output }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior: `the ${name} block`,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  };
  const artifacts = new Map<string, Uint8Array>([
    ["tests.fast-check.ts", new TextEncoder().encode(implSource)],
  ]);
  const root = blockMerkleRoot({
    spec,
    implSource,
    manifest: JSON.parse(MANIFEST_JSON) as LocalTriplet["manifest"],
    artifacts,
  });
  return {
    root,
    row: {
      blockMerkleRoot: root,
      specHash: specHash(spec),
      specCanonicalBytes: new TextEncoder().encode(JSON.stringify(spec)),
      implSource,
      proofManifestJson: MANIFEST_JSON,
      level: "L0",
      createdAt: Date.now(),
      canonicalAstHash: canonicalAstHash(implSource),
      artifacts,
    },
  };
}

const DOUBLE = "export function double(n: number): number { return n * 2; }\n";
const CLAMP =
  "export function clamp(x: number, lo: number, hi: number): number { if (x < lo) return lo; if (x > hi) return hi; return x; }\n";
const COMPUTE = `import type { double } from "@yakcc/blocks/double";
import type { clamp } from "@yakcc/blocks/clamp";
type _D = typeof double;
type _C = typeof clamp;
export function compute(input: string): number {
  const n = parseInt(input, 10);
  let total = 0;
  for (let i = 0; i < n; i++) total += i % 3 === 0 ? i * 2 : i;
  return total > 50 ? 50 : total;
}
`;

let registry: Registry;
let tempDir: string;
let roots: BlockMerkleRoot[];
let computeRoot: BlockMerkleRoot;

async function importModule(source: string, label: string): Promise<Record<string, unknown>> {
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const file = join(tempDir, `${label}.mjs`);
  writeFileSync(file, out.outputText, "utf-8");
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

beforeAll(async () => {
  registry = await openRegistry(":memory:", { embeddings: createOfflineEmbeddingProvider() });
  tempDir = mkdtempSync(join(tmpdir(), "yakcc-graph-sources-"));
  const blocks = [
    makeBlockRow("double", ["number"], "number", DOUBLE),
    makeBlockRow("clamp", ["number", "number", "number"], "number", CLAMP),
    makeBlockRow("compute", ["string"], "number", COMPUTE),
  ];
  roots = blocks.map((b) => b.root);
  computeRoot = blocks[2]?.root as BlockMerkleRoot;
  for (const { row } of blocks) {
    await registry.storeBlock(row);
    const packed = packGraph(liftAtom(row.implSource));
    await registry.storeDucImplementation({
      specHash: row.specHash,
      graphIdentity: packed.identity,
      graphRoot: packed.root,
      formatVersion: packed.formatVersion,
      lifterVersion: packed.lifterVersion,
      structure: packed.structure,
      links: packed.links,
      annotations: packed.annotations ?? null,
      blockMerkleRoot: row.blockMerkleRoot,
      tsCache: null,
    });
  }
});

afterAll(async () => {
  await registry.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("compiling from the stored graphs (#1279)", () => {
  it("a block's code is generated from its graph, its name and imports kept", async () => {
    const row = (await registry.getBlock(computeRoot)) as BlockTripletRow;
    const source = (await graphSourceOf(registry, row)) as string;
    expect(source).toContain('import type { double } from "@yakcc/blocks/double";');
    expect(source).toContain("export function compute($v0: string): number {");
    expect(source).not.toContain("total");
  });

  it("the module assembled from the graphs computes what the stored text computes", async () => {
    const opts = { knownMerkleRoots: roots };
    const fromText = await assemble(computeRoot, registry, undefined, opts);
    const fromGraph = await assemble(computeRoot, withGraphSources(registry), undefined, opts);
    expect(fromGraph.source).not.toBe(fromText.source);
    expect(fromGraph.manifest.entries.map((e) => e.blockMerkleRoot)).toEqual(
      fromText.manifest.entries.map((e) => e.blockMerkleRoot),
    );
    const a = await importModule(fromText.source, "text");
    const b = await importModule(fromGraph.source, "graph");
    for (const input of ["0", "3", "7", "12", "40"]) {
      expect((b.compute as (s: string) => number)(input)).toBe(
        (a.compute as (s: string) => number)(input),
      );
    }
  });

  it("a block with no stored graph is served as stored", async () => {
    const { row } = makeBlockRow(
      "lone",
      ["number"],
      "number",
      "export function lone(x: number): number { return -x; }\n",
    );
    await registry.storeBlock(row);
    expect(await graphSourceOf(registry, row)).toBeUndefined();
    expect((await withGraphSources(registry).getBlock(row.blockMerkleRoot))?.implSource).toBe(
      row.implSource,
    );
  });
});
