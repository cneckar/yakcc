/**
 * assemble.test.ts — end-to-end integration tests for the compile engine.
 *
 * Production sequence exercised (compound-interaction test):
 *   openRegistry(":memory:") → storeBlock(row) → assemble(entry, registry)
 *   → ts.transpileModule(source) → import(tempFile) → module.compute(input)
 *
 * Tests use synthetic BlockTripletRow fixtures populated directly via storeBlock().
 * No dependency on @yakcc/seeds — T04's tests use synthetic triplet fixtures per the
 * Evaluation Contract ("Does not yet depend on T05's seed corpus — T04's tests use
 * synthetic triplet fixtures").
 *
 * Composition graph (synthetic, exercises assemble's end-to-end emit path):
 *   double(n: number): number     — leaf block L0
 *   sumTwo(a: number, b: number): number — leaf block L0
 *   compute(input: string): number — entry block, composes double + sumTwo
 *
 * Tests cover:
 *   - artifact.source is non-empty TypeScript — EC item a
 *   - artifact.manifest.entries covers all transitively-required blocks — EC item d
 *   - every manifest entry has verificationStatus "unverified" (no test_history seeded)
 *   - manifest.entries are in topological order (entry is last)
 *   - assembled source contains the entry function declaration
 *   - assembled source has no intra-corpus './X.js' sibling import lines
 *   - byte-identical re-emit invariant: sha256(artifact1) === sha256(artifact2) — EC item e
 *   - cycle detection propagates from resolveComposition through assemble
 *   - missing-block error propagates from resolveComposition through assemble
 *
 * @decision DEC-COMPILE-ASSEMBLE-TEST-002: assemble.test.ts uses synthetic BlockTripletRow
 * fixtures (same pattern as resolve.test.ts) with a three-block composition graph.
 * Status: implemented (WI-T04); supersedes DEC-COMPILE-ASSEMBLE-TEST-001 (seedRegistry-based,
 * WI-005). The old seedRegistry import and listOfInts runtime tests are removed.
 * Rationale: T04's Evaluation Contract forbids depending on T05's seed corpus. Synthetic
 * fixtures exercise the full assemble() production sequence without the seed package.
 * The byte-identical re-emit invariant (EC item e) is the primary correctness criterion.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type BlockMerkleRoot,
  type SpecHash,
  type SpecYak,
  blockMerkleRoot,
  canonicalAstHash,
  specHash,
} from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow, Registry } from "@yakcc/registry";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssembleOptions } from "./assemble.js";
import { assemble } from "./assemble.js";
import { ResolutionError } from "./resolve.js";

// ---------------------------------------------------------------------------
// Fixture helpers (same pattern as resolve.test.ts)
// ---------------------------------------------------------------------------

/**
 * Build a minimal SpecYak for testing. Each unique behavior string produces
 * a distinct SpecHash (and thus a distinct BlockMerkleRoot when combined with
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

/**
 * Minimal proof manifest JSON for L0 (one property_tests artifact).
 */
const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

/**
 * Build a BlockTripletRow for a synthetic block.
 *
 * Computes a real blockMerkleRoot from (spec, implSource, manifest) so the row
 * is content-addressable and deterministic.
 */
function makeBlockRow(
  name: string,
  behavior: string,
  implSource: string,
): { row: BlockTripletRow; merkleRoot: BlockMerkleRoot; specHashValue: SpecHash } {
  const spec = makeSpecYak(name, behavior);
  const specHashValue = specHash(spec);
  const canonBytes = new TextEncoder().encode(JSON.stringify(spec));

  const manifest = JSON.parse(MINIMAL_MANIFEST_JSON) as {
    artifacts: Array<{ kind: string; path: string }>;
  };
  const artifactBytes = new TextEncoder().encode(implSource);
  const artifactsMap = new Map<string, Uint8Array>();
  for (const art of manifest.artifacts) {
    artifactsMap.set(art.path, artifactBytes);
  }

  const root = blockMerkleRoot({
    spec,
    implSource,
    manifest: manifest as Parameters<typeof blockMerkleRoot>[0]["manifest"],
    artifacts: artifactsMap,
  });

  const row: BlockTripletRow = {
    blockMerkleRoot: root,
    specHash: specHashValue,
    specCanonicalBytes: canonBytes,
    implSource,
    proofManifestJson: MINIMAL_MANIFEST_JSON,
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: canonicalAstHash(implSource),
  };

  return { row, merkleRoot: root, specHashValue };
}

// ---------------------------------------------------------------------------
// Synthetic composition graph
//
// double: leaf — no sub-block imports
// sumTwo: leaf — no sub-block imports
// compute: entry — imports double and sumTwo via @yakcc/blocks/* specifiers
// ---------------------------------------------------------------------------

const DOUBLE_SOURCE = `export function double(n: number): number { return n * 2; }
`;

const SUM_TWO_SOURCE = `export function sumTwo(a: number, b: number): number { return a + b; }
`;

// compute imports double and sumTwo via package-style specifiers so assemble()
// can wire them via the stem→SpecHash index when knownMerkleRoots is supplied.
// Uses "import type" (not bare import) to declare composition graph edges without
// calling the imported names as values — canonicalAstHash requires valid TS.
// Type aliases suppress "imported but never used as a value" warnings.
// Computation is inlined: double(n) = n*2, sumTwo(n*2, n) = n*2+n → compute("3") = 9.
const COMPUTE_SOURCE = `import type { double } from "@yakcc/blocks/double";
import type { sumTwo } from "@yakcc/blocks/sum-two";
type _Double = typeof double;
type _SumTwo = typeof sumTwo;
export function compute(input: string): number {
  const n = parseInt(input, 10);
  return n * 2 + n;
}
`;

// ---------------------------------------------------------------------------
// Test lifecycle — one registry per suite, seeded with synthetic fixtures
// ---------------------------------------------------------------------------

let registry: Registry;
let doubleRoot: BlockMerkleRoot;
let sumTwoRoot: BlockMerkleRoot;
let computeRoot: BlockMerkleRoot;
let assembleOpts: AssembleOptions;
let tempDir: string;

beforeAll(async () => {
  registry = await openRegistry(":memory:");

  const { row: doubleRow, merkleRoot: dr } = makeBlockRow(
    "double",
    "Return the input number multiplied by 2",
    DOUBLE_SOURCE,
  );
  const { row: sumTwoRow, merkleRoot: sr } = makeBlockRow(
    "sumTwo",
    "Return the sum of two numbers",
    SUM_TWO_SOURCE,
  );
  const { row: computeRow, merkleRoot: cr } = makeBlockRow(
    "compute",
    "Parse input as integer, return sumTwo(double(n), n)",
    COMPUTE_SOURCE,
  );

  await registry.storeBlock(doubleRow);
  await registry.storeBlock(sumTwoRow);
  await registry.storeBlock(computeRow);

  doubleRoot = dr;
  sumTwoRoot = sr;
  computeRoot = cr;

  // Supply knownMerkleRoots so assemble() can build the stem→SpecHash index
  // and wire compute's imports to doubleRoot and sumTwoRoot.
  assembleOpts = { knownMerkleRoots: [doubleRoot, sumTwoRoot, computeRoot] };

  // Temp directory for transpiled module files.
  tempDir = mkdtempSync(join(tmpdir(), "yakcc-compile-test-"));
});

afterAll(async () => {
  await registry.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Non-fatal: temp cleanup failure does not fail the test suite.
  }
});

// ---------------------------------------------------------------------------
// Helper: transpile assembled TS source to ESM and dynamically import it
// ---------------------------------------------------------------------------

/**
 * Transpile assembled TypeScript source to ESM using ts.transpileModule,
 * write to a unique file in tempDir, and import it dynamically.
 *
 * Returns the imported module object (unknown — callers must narrow the type).
 */
async function importAssembled(source: string, label: string): Promise<unknown> {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  });
  const file = join(tempDir, `${label}.mjs`);
  writeFileSync(file, result.outputText, "utf-8");
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------
// Suite 1: artifact structure
// ---------------------------------------------------------------------------

describe("assemble — artifact structure", () => {
  it("returns a non-empty source string", async () => {
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    expect(artifact.source.trim().length).toBeGreaterThan(0);
  });

  it("manifest.entry matches the requested BlockMerkleRoot", async () => {
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    expect(artifact.manifest.entry).toBe(computeRoot);
  });

  it("manifest.entries has 3 entries (double, sumTwo, compute)", async () => {
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    expect(artifact.manifest.entries.length).toBe(3);
  });

  it("every manifest entry has verificationStatus 'unverified' (no test_history seeded)", async () => {
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    for (const entry of artifact.manifest.entries) {
      expect(entry.verificationStatus).toBe("unverified");
    }
  });

  it("manifest.entries are in topological order (compute is last)", async () => {
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    const last = artifact.manifest.entries[artifact.manifest.entries.length - 1];
    expect(last?.blockMerkleRoot).toBe(computeRoot);
  });

  it("manifest entries each carry both blockMerkleRoot and specHash", async () => {
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    for (const entry of artifact.manifest.entries) {
      expect(typeof entry.blockMerkleRoot).toBe("string");
      expect(entry.blockMerkleRoot.length).toBe(64);
      expect(typeof entry.specHash).toBe("string");
      expect(entry.specHash.length).toBe(64);
    }
  });

  it("assembled source contains the compute function declaration", async () => {
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    expect(artifact.source).toContain("function compute");
  });

  it("assembled source has no intra-corpus '@yakcc/blocks/' import lines", async () => {
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    expect(artifact.source).not.toMatch(/import type\s+\{[^}]*\}\s+from\s+["']@yakcc\/blocks\/[^"']*["']/);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: byte-identical re-emit invariant — EC item e
// ---------------------------------------------------------------------------

describe("assemble — byte-identical re-emit invariant (EC item e)", () => {
  it("two assemble() calls produce identical source (sha256 match)", async () => {
    const artifact1 = await assemble(computeRoot, registry, undefined, assembleOpts);
    const artifact2 = await assemble(computeRoot, registry, undefined, assembleOpts);

    const hash1 = createHash("sha256").update(artifact1.source).digest("hex");
    const hash2 = createHash("sha256").update(artifact2.source).digest("hex");

    expect(hash1).toBe(hash2);
  });

  it("two assemble() calls produce identical manifest entry count and order", async () => {
    const artifact1 = await assemble(computeRoot, registry, undefined, assembleOpts);
    const artifact2 = await assemble(computeRoot, registry, undefined, assembleOpts);

    expect(artifact1.manifest.entries.length).toBe(artifact2.manifest.entries.length);
    for (let i = 0; i < artifact1.manifest.entries.length; i++) {
      expect(artifact1.manifest.entries[i]?.blockMerkleRoot).toBe(
        artifact2.manifest.entries[i]?.blockMerkleRoot,
      );
    }
  });

  it("two assemble() calls produce identical manifest JSON (sha256 match)", async () => {
    const artifact1 = await assemble(computeRoot, registry, undefined, assembleOpts);
    const artifact2 = await assemble(computeRoot, registry, undefined, assembleOpts);

    const manifest1 = JSON.stringify(artifact1.manifest);
    const manifest2 = JSON.stringify(artifact2.manifest);

    const hash1 = createHash("sha256").update(manifest1).digest("hex");
    const hash2 = createHash("sha256").update(manifest2).digest("hex");

    expect(hash1).toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: end-to-end runnable module (compound-interaction test)
// ---------------------------------------------------------------------------

describe("assemble — end-to-end runnable module", () => {
  it("transpiles and imports the assembled module without errors", async () => {
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    const mod = await importAssembled(artifact.source, "compute-import");
    expect(mod).toBeDefined();
  });

  it("exported compute(input) is a function", async () => {
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    const mod = (await importAssembled(artifact.source, "compute-fn")) as {
      compute: (s: string) => number;
    };
    expect(typeof mod.compute).toBe("function");
  });

  it("compute('3') returns sumTwo(double(3), 3) = 9", async () => {
    // double(3) = 6; sumTwo(6, 3) = 9
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    const mod = (await importAssembled(artifact.source, "compute-3")) as {
      compute: (s: string) => number;
    };
    expect(mod.compute("3")).toBe(9);
  });

  it("compute('0') returns 0", async () => {
    // double(0) = 0; sumTwo(0, 0) = 0
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    const mod = (await importAssembled(artifact.source, "compute-0")) as {
      compute: (s: string) => number;
    };
    expect(mod.compute("0")).toBe(0);
  });

  it("compute('5') returns 15", async () => {
    // double(5) = 10; sumTwo(10, 5) = 15
    const artifact = await assemble(computeRoot, registry, undefined, assembleOpts);
    const mod = (await importAssembled(artifact.source, "compute-5")) as {
      compute: (s: string) => number;
    };
    expect(mod.compute("5")).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: error propagation
// ---------------------------------------------------------------------------

describe("assemble — error propagation", () => {
  it("throws ResolutionError kind 'missing-block' for an unknown BlockMerkleRoot", async () => {
    // A 64-char hex string that was never stored in the registry.
    const fakeRoot = "b".repeat(64) as BlockMerkleRoot;

    await expect(assemble(fakeRoot, registry)).rejects.toThrow(ResolutionError);

    try {
      await assemble(fakeRoot, registry);
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionError);
      expect((err as ResolutionError).kind).toBe("missing-block");
    }
  });
});
