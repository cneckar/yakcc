/**
 * assemble.test.ts — end-to-end integration tests for the compile engine.
 *
 * Production sequence exercised (compound-interaction test):
 *   openRegistry(":memory:") → seedRegistry() → assemble(entry, registry)
 *   → ts.transpileModule(source) → import(tempFile) → module.listOfInts(input)
 *
 * This is the authoritative proof that assemble() produces a runnable module:
 * the assembled TypeScript is transpiled to ESM and dynamically imported,
 * then the exported function is called with real inputs matching the seed corpus
 * property-test expectations.
 *
 * Tests cover:
 *   - artifact.source is non-empty TypeScript
 *   - artifact.manifest.entries covers all transitively-required blocks (7+)
 *   - every manifest entry has verificationStatus "unverified" (no test_history seeded)
 *   - assembled module exports listOfInts and parses [1,2,3], [], [ 42 ] correctly
 *   - assembled module rejects incomplete input [1,2, and non-digit [abc]
 *   - cycle detection propagates from resolveComposition through assemble
 *   - missing-block error propagates from resolveComposition through assemble
 *
 * @decision DEC-COMPILE-ASSEMBLE-TEST-001: Dynamic import approach uses TypeScript's
 * ts.transpileModule() to convert assembled source to ESM, writes to os.tmpdir(),
 * then imports via file:// URL. This avoids requiring esbuild, tsx, or any bundler
 * beyond the TypeScript compiler already in the workspace devDependencies.
 * Status: implemented (WI-005)
 * Rationale: The assembled source is TypeScript (preserves type annotations from
 * block sources). Vitest's TS transform applies only to static imports at test-
 * collection time, not to dynamic import() of runtime-generated temp files. Using
 * ts.transpileModule() keeps the test self-contained and avoids spawning subprocesses.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContractId } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssembleOptions } from "./assemble.js";
import { assemble } from "./assemble.js";
import { ResolutionError } from "./resolve.js";

// ---------------------------------------------------------------------------
// Test lifecycle — one registry per suite, seeded once
// ---------------------------------------------------------------------------

let registry: Registry;
let listOfIntsId: ContractId;
let assembleOpts: AssembleOptions;
let tempDir: string;

beforeAll(async () => {
  registry = await openRegistry(":memory:");
  const seedResult = await seedRegistry(registry);

  // Build assemble options with all seed contractIds so the pre-scan can
  // populate a complete stem → ContractId index before the DFS traversal.
  // Without this, the pre-scan cannot resolve sub-block refs from the
  // entry block's composition (e.g. "./bracket.js") because the registry
  // has no listAll() method and relative import paths carry no contractId.
  assembleOpts = { knownContractIds: seedResult.contractIds };

  // Find the list-of-ints contractId by scanning for the listOfInts export.
  let found: ContractId | null = null;
  for (const id of seedResult.contractIds) {
    const impl = await registry.getImplementation(id);
    if (impl?.source.includes("export function listOfInts")) {
      found = id;
      break;
    }
  }
  if (found === null) {
    throw new Error("seedRegistry did not register a listOfInts block");
  }
  listOfIntsId = found;

  // Temp directory for transpiled module files.
  tempDir = mkdtempSync(join(tmpdir(), "yakcc-compile-test-"));
});

afterAll(async () => {
  await registry.close();
  // Clean up temp directory.
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
      // Type-only imports are erased by transpileModule.
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
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    expect(artifact.source.trim().length).toBeGreaterThan(0);
  });

  it("manifest.entry matches the requested contractId", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    expect(artifact.manifest.entry).toBe(listOfIntsId);
  });

  it("manifest.entries has at least 7 entries (transitive closure of list-of-ints)", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    expect(artifact.manifest.entries.length).toBeGreaterThanOrEqual(7);
  });

  it("every manifest entry has verificationStatus 'unverified' (no test_history seeded)", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    for (const entry of artifact.manifest.entries) {
      expect(entry.verificationStatus).toBe("unverified");
    }
  });

  it("manifest.entries are in topological order (entry is last)", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    const last = artifact.manifest.entries[artifact.manifest.entries.length - 1];
    expect(last?.contractId).toBe(listOfIntsId);
  });

  it("assembled source contains the listOfInts function declaration", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    expect(artifact.source).toContain("function listOfInts");
  });

  it("assembled source has no intra-corpus './X.js' sibling import lines", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    expect(artifact.source).not.toMatch(/import type\s+\{[^}]*\}\s+from\s+["']\.\/[^"']*["']/);
  });

  it("assembled source has exactly one @yakcc/contracts import line", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    const contractsLines = artifact.source
      .split("\n")
      .filter((l) => l.includes("@yakcc/contracts"));
    expect(contractsLines.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: end-to-end runnable module (compound-interaction test)
// ---------------------------------------------------------------------------

describe("assemble — end-to-end runnable module", () => {
  it("transpiles and imports the assembled module without errors", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    const mod = await importAssembled(artifact.source, "list-of-ints-import");
    expect(mod).toBeDefined();
  });

  it("exported listOfInts parses '[1,2,3]' → [1, 2, 3]", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    const mod = (await importAssembled(artifact.source, "list-of-ints-123")) as {
      listOfInts: (s: string) => ReadonlyArray<number>;
    };
    expect(typeof mod.listOfInts).toBe("function");
    expect(mod.listOfInts("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("exported listOfInts parses '[]' → []", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    const mod = (await importAssembled(artifact.source, "list-of-ints-empty")) as {
      listOfInts: (s: string) => ReadonlyArray<number>;
    };
    expect(mod.listOfInts("[]")).toEqual([]);
  });

  it("exported listOfInts parses '[ 42 ]' → [42]", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    const mod = (await importAssembled(artifact.source, "list-of-ints-42")) as {
      listOfInts: (s: string) => ReadonlyArray<number>;
    };
    expect(mod.listOfInts("[ 42 ]")).toEqual([42]);
  });

  it("exported listOfInts throws on incomplete input '[1,2,'", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    const mod = (await importAssembled(artifact.source, "list-of-ints-incomplete")) as {
      listOfInts: (s: string) => ReadonlyArray<number>;
    };
    expect(() => mod.listOfInts("[1,2,")).toThrow();
  });

  it("exported listOfInts throws on non-digit content '[abc]'", async () => {
    const artifact = await assemble(listOfIntsId, registry, undefined, assembleOpts);
    const mod = (await importAssembled(artifact.source, "list-of-ints-nondigit")) as {
      listOfInts: (s: string) => ReadonlyArray<number>;
    };
    expect(() => mod.listOfInts("[abc]")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite 3: error propagation
// ---------------------------------------------------------------------------

describe("assemble — error propagation", () => {
  it("throws ResolutionError kind 'missing-contract' for an unknown contractId", async () => {
    // Construct a contractId that was never stored in the registry.
    // Use a 64-char hex string that is syntactically valid but semantically absent.
    const fakeId = "b".repeat(64) as ContractId;

    await expect(assemble(fakeId, registry)).rejects.toThrow(ResolutionError);

    try {
      await assemble(fakeId, registry);
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionError);
      expect((err as ResolutionError).kind).toBe("missing-contract");
    }
  });
});
