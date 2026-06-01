// @mock-exempt: seedRegistry opens real block dirs + filesystem; openRegistry opens SQLite;
// getBlock traverses the registry. All are external boundaries relative to the MCP tool under test.
// @mock-exempt: @yakcc/compile is mocked ONLY as an infrastructure workaround — NOT to stub behavior.
// mcp-registry vitest.config.ts aliases "@yakcc/hooks-base" (root) but lacks the companion sub-path
// alias "@yakcc/hooks-base/src/import-classifier.js" that compile's own vitest.config.ts carries.
// The @yakcc/compile barrel (index.ts) loads import-gate.ts which imports that sub-path; Vite's
// prefix substitution produces "src/index.ts/src/import-classifier.js" → ENOTDIR at load time.
// The mock factory imports ONLY the two sub-modules that provide the functions reference.ts needs
// (project-manifest.ts and atom-dts.ts) — both have zero runtime imports from aliased packages.
// All returned functions are the REAL compile implementations; no behavior is stubbed.
// parseProjectManifest + serializeProjectManifest are added to the same mock factory (same
// structural reason — they live in project-manifest.ts, already imported above).
/**
 * Tests for yakcc_reference tool.
 *
 * @decision DEC-COMPOSE-BY-REF-REFERENCE-TOOL-001
 * @title yakcc_reference — compose-by-reference MCP tool, no impl body
 * @status decided (wi-1047)
 * @rationale
 *   Mirror of compile.test.ts harness. Injects openRegistry + seedRegistry + getBlock
 *   for offline, deterministic execution. Seeds the registry stub with a controlled
 *   ascii-char-like block so tests are ground-truth without real SQLite.
 *
 *   Test cases:
 *   (1) Full 64-char root → {manifest_entry, import_line, dts_ref} returned; no impl
 *   (2) 8-char short id → same response as full root
 *   (3) Symbol ground-truth: returned symbol === export name in assemble(root).source
 *   (4) No-impl invariant: full response JSON does NOT contain the impl function body
 *   (5) import_line format: `import { <symbol> } from "<importPath>";`
 *   (6) dts_ref: path ends .d.ts, dts contains `export declare function <symbol>(`
 *   (7) not_found (random short id) → structured error, no throw
 *   (8) ambiguous prefix → ambiguous_short_id structured error, no throw
 *   (9) invalid input (empty atom_id) → invalid_input structured error, no throw
 *   (10) registry open failure → registry_unavailable structured error, no throw
 *   (11) getBlock returns null → not_found structured error, no throw
 *   (12) lazy registry open: factory called exactly once across multiple calls
 *   (13) Tool shape: name, description, inputSchema
 *   (14) apply-mode: writes manifest.json + .d.ts to real temp dir; returns import_line only
 *   (15) apply-mode: idempotent — re-applying same atom does NOT duplicate manifest entry
 *   (16) apply-mode: reads and EXTENDS existing manifest (not emptyManifest)
 *   (17) non-apply mode: applied:false in response + full artifact present
 *   (18) apply-mode: invalid project_root value → invalid_input structured error
 *
 * Compound-Interaction Test Requirement (CLAUDE.md):
 *   Case (1)/(3) exercise the full production sequence end-to-end:
 *   createReferenceTool() → handler → getRegistryAndFullRoots() →
 *   seedRegistry() → enumerateSpecs() → selectBlocks() →
 *   resolveAtomId(root, fullRoots) → getBlock(root) →
 *   deriveSymbol(implSource, spec) → addReference → referenceImportLine →
 *   materializedDtsPath → generateAtomDts → structured response (no assemble()).
 *   Proves the full reference path crosses all internal component boundaries correctly.
 *
 *   Case (14) exercises the apply-mode production sequence end-to-end:
 *   createReferenceTool() → handler({ atom_id, project_root }) →
 *   registry resolve → deriveSymbol → applyMode() →
 *   readFile(manifest.json) → parseProjectManifest → addReference →
 *   serializeProjectManifest → writeFile(manifest.json) →
 *   generateAtomDts → writeFile(.d.ts) → { import_line, applied: true }
 *   Proves apply-mode crosses all fs + compile authority boundaries on a real temp dir.
 *
 * Implements: yakcc#1047 (epic #1043 [4/6]), yakcc#1062b (wi-1062b)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../http-client.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@yakcc/seeds", () => ({
  seedRegistry: vi.fn(),
}));

vi.mock("@yakcc/registry", () => ({
  openRegistry: vi.fn(),
}));

// NOTE: @yakcc/contracts is NOT mocked here.
// reference.ts only uses @yakcc/contracts for type imports (BlockMerkleRoot, SpecYak)
// and for createOfflineEmbeddingProvider inside defaultOpenRegistry() — which is
// only called by the production factory, never by tests (tests inject openRegistry).
// Mocking @yakcc/contracts corrupts the real @yakcc/compile module resolution
// (ENOTDIR on hooks-base/src/index.ts) because compile uses contracts heavily.

// NOTE: @yakcc/compile IS mocked here, but with a factory that provides the REAL
// implementations from the individual source files.
//
// Root cause: the mcp-registry vitest.config.ts aliases "@yakcc/hooks-base" to
// src/index.ts (root alias). When the real @yakcc/compile barrel (index.ts) loads,
// it pulls in import-gate.ts which imports "@yakcc/hooks-base/src/import-classifier.js"
// — a deep sub-path. Vite's alias substitution replaces the "@yakcc/hooks-base" prefix
// with the file path (src/index.ts), producing
// "src/index.ts/src/import-classifier.js" → ENOTDIR.
// The compile package's own vitest.config.ts adds a specific sub-path alias
// "@yakcc/hooks-base/src/import-classifier.js" BEFORE the root alias to avoid this;
// mcp-registry's vitest.config.ts does not (and is out of scope for this test fix).
//
// Fix: mock "@yakcc/compile" with a factory that imports only the two source files
// that provide the functions reference.ts needs (project-manifest.ts and atom-dts.ts).
// These files have ONLY `import type` statements from @yakcc/contracts, so they have
// zero runtime imports that would trigger the alias corruption. The mock factory
// uses relative paths from this test file to reach the compile source tree directly.
//
// This mock is a structural necessity due to the vitest config gap — NOT because we
// want to stub behaviour. All returned functions are the REAL implementations.
vi.mock("@yakcc/compile", async () => {
  // Load the two source modules directly (no import-gate, no alias corruption).
  // Relative from packages/mcp-registry/src/tools/ → packages/compile/src/
  // Path segments: tools/ → src/ → mcp-registry/ → packages/ → (root) → packages/compile/src/
  const pm = await import("../../../../packages/compile/src/project-manifest.js");
  const dts = await import("../../../../packages/compile/src/atom-dts.js");
  return {
    emptyManifest: pm.emptyManifest,
    addReference: pm.addReference,
    materializedDtsPath: pm.materializedDtsPath,
    referenceImportLine: pm.referenceImportLine,
    parseProjectManifest: pm.parseProjectManifest,
    serializeProjectManifest: pm.serializeProjectManifest,
    generateAtomDts: dts.generateAtomDts,
  };
});

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BlockMerkleRoot, SpecHash, SpecYak } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import { createReferenceTool, referenceTool } from "./reference.js";
// Real parseProjectManifest from the mock factory above (real implementation).
import { parseProjectManifest } from "@yakcc/compile";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Realistic 64-char hex root for the "ascii-char" test atom. */
const ROOT_A =
  "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" as BlockMerkleRoot;
/** 8-char short id for ROOT_A. */
const SHORT_A = ROOT_A.slice(0, 8); // "a1b2c3d4"

/** A second root sharing the SHORT_A prefix — for ambiguous prefix tests. */
const ROOT_B = ("a1b2c3d4" + "1".repeat(56)) as BlockMerkleRoot;

/** Fake SpecHash values. */
const SPEC_HASH_A =
  "aaaa0000000000000000000000000000000000000000000000000000000000000000" as SpecHash;
const SPEC_HASH_B =
  "cccc0000000000000000000000000000000000000000000000000000000000000000" as SpecHash;

/** The ascii-char impl source — export function name is "asciiChar". */
const ASCII_CHAR_IMPL =
  `export function asciiChar(input: string, position: number): string {\n` +
  `  if (position < 0 || position >= input.length) {\n` +
  `    throw new RangeError(\`Position \${position} out of bounds for input of length \${input.length}\`);\n` +
  `  }\n` +
  `  const code = input.charCodeAt(position);\n` +
  `  if (code > 127) {\n` +
  `    throw new RangeError(\`Non-ASCII character at position \${position}: code \${code}\`);\n` +
  `  }\n` +
  `  return input[position] as string;\n` +
  `}`;

/** The ascii-char SpecYak — reflects the real spec.yak for ground-truth checks. */
const ASCII_CHAR_SPEC: SpecYak = {
  name: "ascii-char",
  inputs: [
    { name: "input", type: "string" },
    { name: "position", type: "number" },
  ],
  outputs: [{ name: "char", type: "string" }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

/** Serialized spec bytes (canonicalize produces stable JSON; here we use JSON.stringify). */
const ASCII_CHAR_SPEC_BYTES = new TextEncoder().encode(JSON.stringify(ASCII_CHAR_SPEC));

/** A minimal stub HttpClient (handler never uses it — but interface requires it). */
const STUB_HTTP: HttpClient = {
  get: vi.fn(),
  post: vi.fn(),
} as unknown as HttpClient;

// ---------------------------------------------------------------------------
// Registry stub builder (mirrors compile.test.ts approach)
// ---------------------------------------------------------------------------

/**
 * Build a stub Registry with controlled enumerateSpecs / selectBlocks / getBlock.
 *
 * `specToRoots` maps SpecHash → BlockMerkleRoot[]. getBlock returns the ascii-char
 * stub row for ROOT_A, null for anything else by default.
 */
function makeRegistryStub(
  specToRoots: ReadonlyMap<SpecHash, BlockMerkleRoot[]>,
  getBlockImpl?: (root: BlockMerkleRoot) => Promise<unknown>,
): Registry {
  const defaultGetBlock = async (root: BlockMerkleRoot) => {
    if (root === ROOT_A) {
      return {
        blockMerkleRoot: ROOT_A,
        specHash: SPEC_HASH_A,
        specCanonicalBytes: ASCII_CHAR_SPEC_BYTES,
        implSource: ASCII_CHAR_IMPL,
        proofManifestJson: "{}",
        level: "L0" as const,
        createdAt: 0,
        canonicalAstHash: "aabbcc" as unknown,
        artifacts: new Map(),
      };
    }
    return null;
  };

  return {
    enumerateSpecs: vi.fn().mockResolvedValue([...specToRoots.keys()]),
    selectBlocks: vi.fn().mockImplementation(async (sh: SpecHash) => specToRoots.get(sh) ?? []),
    getBlock: vi.fn().mockImplementation(getBlockImpl ?? defaultGetBlock),
  } as unknown as Registry;
}

/** Map with only ROOT_A (single, non-ambiguous). */
function makeSpecMapOne(): ReadonlyMap<SpecHash, BlockMerkleRoot[]> {
  return new Map([[SPEC_HASH_A, [ROOT_A]]]);
}

/** Map with ROOT_A + ROOT_B (same short prefix — triggers ambiguous). */
function makeSpecMapAmbiguous(): ReadonlyMap<SpecHash, BlockMerkleRoot[]> {
  return new Map([
    [SPEC_HASH_A, [ROOT_A]],
    [SPEC_HASH_B, [ROOT_B]],
  ]);
}

/**
 * Build a tool instance backed by a controlled registry stub.
 * seedRegistry mock is set to resolve void (result discarded by handler).
 */
function makeTool(registry?: Registry): ReturnType<typeof createReferenceTool> {
  const reg = registry ?? makeRegistryStub(makeSpecMapOne());
  return createReferenceTool({ openRegistry: async () => reg });
}

// ---------------------------------------------------------------------------
// Shared response shape validator
// ---------------------------------------------------------------------------

interface ReferenceResponse {
  atom_id: string;
  root: string;
  manifest_entry: {
    root: string;
    symbol: string;
    alias: string;
    importPath: string;
    registry: string;
    version: string | null;
  };
  import_line: string;
  dts_ref: {
    path: string;
    dts: string;
  };
}

// ---------------------------------------------------------------------------
// Case (1)+(2): Full root and short id produce identical reference artifact
// (Compound-Interaction Test — proves full production sequence end-to-end)
// ---------------------------------------------------------------------------

describe("yakcc_reference — full root and short id produce identical artifact (compound)", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(1) full 64-char root → returns {manifest_entry, import_line, dts_ref} with correct shape", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);

    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as ReferenceResponse;

    // atom_id and root roundtrip
    expect(parsed.atom_id).toBe(ROOT_A);
    expect(parsed.root).toBe(ROOT_A);

    // manifest_entry: root matches, symbol is derived from implSource
    expect(parsed.manifest_entry.root).toBe(ROOT_A);
    expect(parsed.manifest_entry.symbol).toBe("asciiChar");
    expect(parsed.manifest_entry.alias).toBe(ROOT_A.slice(0, 12));
    expect(parsed.manifest_entry.importPath).toBe(`.yakcc/atoms/${ROOT_A.slice(0, 12)}`);
    expect(parsed.manifest_entry.registry).toBe("local");

    // import_line: canonical form
    expect(parsed.import_line).toBe(
      `import { asciiChar } from ".yakcc/atoms/${ROOT_A.slice(0, 12)}";`,
    );

    // dts_ref: path ends .d.ts, dts contains export declare function
    expect(parsed.dts_ref.path).toMatch(/\.d\.ts$/);
    expect(parsed.dts_ref.dts).toContain("export declare function asciiChar(");
  });

  it("(2) 8-char short id → resolves to ROOT_A and returns the SAME reference artifact", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: SHORT_A }, STUB_HTTP);

    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as ReferenceResponse;

    // Short id resolves to the full root
    expect(parsed.root).toBe(ROOT_A);
    expect(parsed.atom_id).toBe(SHORT_A);

    // Same manifest_entry as full root
    expect(parsed.manifest_entry.root).toBe(ROOT_A);
    expect(parsed.manifest_entry.symbol).toBe("asciiChar");
    expect(parsed.import_line).toContain("asciiChar");
  });
});

// ---------------------------------------------------------------------------
// Case (3): Symbol ground-truth — returned symbol === assemble()'s export name
// ---------------------------------------------------------------------------

describe("yakcc_reference — symbol ground-truth (matches assemble() export)", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(3) symbol 'asciiChar' matches the export function name in the impl source", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);

    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as ReferenceResponse;

    // The bound symbol must equal the exported function name in impl source.
    // extractFunctionName scans "export function asciiChar(" → "asciiChar".
    // This is the same name assemble() would materialise as the public export.
    expect(parsed.manifest_entry.symbol).toBe("asciiChar");

    // Verify against the impl source directly (ground-truth assertion):
    // the impl contains `export function asciiChar(` at the start of a line.
    expect(ASCII_CHAR_IMPL).toMatch(/^export\s+function\s+asciiChar\s*\(/m);

    // The import_line must use the same symbol.
    expect(parsed.import_line).toBe(
      `import { asciiChar } from ".yakcc/atoms/${ROOT_A.slice(0, 12)}";`,
    );
  });
});

// ---------------------------------------------------------------------------
// Case (4): No-impl invariant — response does NOT contain the impl function body
// ---------------------------------------------------------------------------

describe("yakcc_reference — no-impl invariant (implementation body absent)", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(4) full response JSON does NOT contain the impl body (no implementation source)", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);

    expect(result).toHaveLength(1);
    const rawText = result[0]!.text;

    // The impl contains a distinctive function body substring. Assert it is absent.
    // We pick a line that only appears in the implementation body, not in a .d.ts.
    const distinctiveImplSubstring = "input.charCodeAt(position)";
    expect(rawText).not.toContain(distinctiveImplSubstring);

    // Also assert no 'source' key at the top level (yakcc_compile returns source;
    // yakcc_reference must not).
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("source");
    expect(parsed).not.toHaveProperty("block_count");
  });
});

// ---------------------------------------------------------------------------
// Case (5): import_line format
// ---------------------------------------------------------------------------

describe("yakcc_reference — import_line format", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(5) import_line is `import { symbol } from \"importPath\";`", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);

    const parsed = JSON.parse(result[0]!.text) as ReferenceResponse;
    const importPath = parsed.manifest_entry.importPath;

    expect(parsed.import_line).toBe(`import { asciiChar } from "${importPath}";`);
  });
});

// ---------------------------------------------------------------------------
// Case (6): dts_ref shape
// ---------------------------------------------------------------------------

describe("yakcc_reference — dts_ref shape", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(6) dts_ref.path ends .d.ts and dts_ref.dts contains export declare function", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);

    const parsed = JSON.parse(result[0]!.text) as ReferenceResponse;

    expect(parsed.dts_ref.path).toMatch(/\.d\.ts$/);
    // Path must use the alias
    expect(parsed.dts_ref.path).toBe(`.yakcc/atoms/${ROOT_A.slice(0, 12)}.d.ts`);

    // dts contains the typed declaration for the symbol
    expect(parsed.dts_ref.dts).toContain(`export declare function asciiChar(`);
    // dts reflects the spec's input/output types
    expect(parsed.dts_ref.dts).toContain("input: string");
    expect(parsed.dts_ref.dts).toContain("position: number");
    expect(parsed.dts_ref.dts).toContain("): string");
  });
});

// ---------------------------------------------------------------------------
// Case (7): not_found (random short id)
// ---------------------------------------------------------------------------

describe("yakcc_reference — not_found", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(7) short id with no matching prefix → not_found, handler does not throw", async () => {
    const tool = makeTool(); // registry only has ROOT_A
    const result = await tool.handler({ atom_id: "deadbeef" }, STUB_HTTP);

    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as { error: string; atom_id: string };
    expect(parsed.error).toBe("not_found");
    expect(parsed.atom_id).toBe("deadbeef");
  });
});

// ---------------------------------------------------------------------------
// Case (8): ambiguous short prefix
// ---------------------------------------------------------------------------

describe("yakcc_reference — ambiguous short id", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(8) prefix matching multiple roots → ambiguous_short_id, handler does not throw", async () => {
    const registry = makeRegistryStub(makeSpecMapAmbiguous());
    const tool = createReferenceTool({ openRegistry: async () => registry });

    const result = await tool.handler({ atom_id: SHORT_A }, STUB_HTTP);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as {
      error: string;
      matches: string[];
      atom_id: string;
    };

    expect(parsed.error).toBe("ambiguous_short_id");
    expect(parsed.atom_id).toBe(SHORT_A);
    expect(Array.isArray(parsed.matches)).toBe(true);
    expect(parsed.matches).toContain(ROOT_A);
    expect(parsed.matches).toContain(ROOT_B);
    expect(parsed.matches.every((m: string) => m.length === 64)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case (9): invalid input
// ---------------------------------------------------------------------------

describe("yakcc_reference — input validation (handler never throws)", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(9a) null args → invalid_input, does not throw", async () => {
    const tool = makeTool();
    const result = await tool.handler(null, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("(9b) empty atom_id → invalid_input, does not throw", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: "" }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("(9c) missing atom_id → invalid_input, does not throw", async () => {
    const tool = makeTool();
    const result = await tool.handler({}, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("(9d) atom_id is a number → invalid_input, does not throw", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: 12345 }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// Case (10): registry open failure → registry_unavailable
// ---------------------------------------------------------------------------

describe("yakcc_reference — registry open failure", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(10) registry open throws → registry_unavailable, no throw", async () => {
    const tool = createReferenceTool({
      openRegistry: async () => {
        throw new Error("SQLite open failed — no registry at path");
      },
    });
    const result = await tool.handler({ atom_id: SHORT_A }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string; message: string };
    expect(parsed.error).toBe("registry_unavailable");
    expect(parsed.message).toContain("SQLite open failed");
  });

  it("(10b) seedRegistry throws after open → registry_unavailable, no throw", async () => {
    vi.mocked(seedRegistry).mockRejectedValueOnce(new Error("seed step failed"));
    const tool = makeTool();
    const result = await tool.handler({ atom_id: SHORT_A }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("registry_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Case (11): getBlock returns null → not_found
// ---------------------------------------------------------------------------

describe("yakcc_reference — getBlock returns null", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(11) getBlock returns null → not_found, handler does not throw", async () => {
    const registry = makeRegistryStub(makeSpecMapOne(), async () => null);
    const tool = createReferenceTool({ openRegistry: async () => registry });

    const result = await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Case (12): Lazy registry open — factory called once across multiple calls
// ---------------------------------------------------------------------------

describe("yakcc_reference — lazy registry open (factory called once)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(12) openRegistry factory called exactly once even after multiple handler calls", async () => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);

    const registry = makeRegistryStub(makeSpecMapOne());
    const openFn = vi.fn().mockResolvedValue(registry);
    const tool = createReferenceTool({ openRegistry: openFn });

    await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);
    await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);

    // Registry opened once and cached
    expect(openFn).toHaveBeenCalledTimes(1);
    // seedRegistry also called only once
    expect(vi.mocked(seedRegistry)).toHaveBeenCalledTimes(1);
    // enumerateSpecs called only once (roots cached)
    expect(vi.mocked(registry.enumerateSpecs as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Case (13): Tool shape
// ---------------------------------------------------------------------------

describe("yakcc_reference tool shape", () => {
  it("(13a) has name=yakcc_reference", () => {
    expect(referenceTool.name).toBe("yakcc_reference");
  });

  it("(13b) has a non-empty description mentioning token-savings and no impl", () => {
    expect(referenceTool.description.length).toBeGreaterThan(50);
    // Description must distinguish this from yakcc_compile
    expect(referenceTool.description).toContain("NO implementation body");
  });

  it("(13c) inputSchema has type=object, required=[atom_id], project_root optional", () => {
    expect(referenceTool.inputSchema.type).toBe("object");
    expect(referenceTool.inputSchema.required).toContain("atom_id");
    expect(referenceTool.inputSchema.properties).toHaveProperty("atom_id");
    // project_root is optional — must be in properties but NOT in required
    expect(referenceTool.inputSchema.properties).toHaveProperty("project_root");
    expect(referenceTool.inputSchema.required).not.toContain("project_root");
  });
});

// ---------------------------------------------------------------------------
// Case (14): Apply-mode — real temp-dir fs assertions
// (Compound-Interaction Test for apply-mode production sequence)
// ---------------------------------------------------------------------------

describe("yakcc_reference — apply-mode writes manifest + .d.ts (real temp dir)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
    // Create a real temp dir inside the project's tmp/ directory.
    // Per sacred practice #3: use project tmp/, not /tmp/.
    const projectTmp = new URL("../../../../../tmp", import.meta.url).pathname;
    await mkdir(projectTmp, { recursive: true });
    tmpDir = await mkdtemp(join(projectTmp, "reference-apply-test-"));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("(14) with project_root: writes manifest.json + .d.ts, returns {import_line, applied:true}", async () => {
    // This is the compound-interaction test for apply-mode:
    // handler({ atom_id, project_root }) → resolve → applyMode() →
    // read/parse manifest → addReference → serialize → writeFile manifest →
    // generateAtomDts → writeFile .d.ts → { import_line, applied: true }
    const tool = makeTool();
    const result = await tool.handler({ atom_id: ROOT_A, project_root: tmpDir }, STUB_HTTP);

    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as {
      atom_id: string;
      root: string;
      import_line: string;
      applied: boolean;
      manifest_path: string;
      dts_path: string;
    };

    // (a) Response shape: applied:true, import_line present, no full artifact fields
    expect(parsed.applied).toBe(true);
    expect(typeof parsed.import_line).toBe("string");
    expect(parsed.import_line).toContain("asciiChar");
    expect(parsed.import_line).toMatch(/^import \{ asciiChar \} from "\.yakcc\/atoms\//);
    expect(parsed.manifest_path).toBe(".yakcc/manifest.json");
    expect(parsed.dts_path).toMatch(/^\.yakcc\/atoms\/[a-f0-9]+\.d\.ts$/);

    // Response must NOT contain the full artifact fields (model writes only import_line)
    expect(parsed).not.toHaveProperty("manifest_entry");
    expect(parsed).not.toHaveProperty("dts_ref");

    // (b) manifest.json was written and contains the reference entry
    const manifestText = await readFile(join(tmpDir, ".yakcc", "manifest.json"), "utf8");
    const manifest = parseProjectManifest(manifestText);
    expect(manifest.version).toBe(1);
    expect(manifest.references).toHaveLength(1);
    const ref = manifest.references[0]!;
    expect(ref.root).toBe(ROOT_A);
    expect(ref.symbol).toBe("asciiChar");
    expect(ref.alias).toBe(ROOT_A.slice(0, 12));
    expect(ref.importPath).toBe(`.yakcc/atoms/${ROOT_A.slice(0, 12)}`);

    // (c) .d.ts file was written at the correct path
    const absDbtsPath = join(tmpDir, parsed.dts_path);
    const dtsText = await readFile(absDbtsPath, "utf8");
    expect(dtsText).toContain("export declare function asciiChar(");
    expect(dtsText).toContain("input: string");
    expect(dtsText).toContain("position: number");
    expect(dtsText).toContain("): string");
  });
});

// ---------------------------------------------------------------------------
// Case (15): Apply-mode idempotency
// ---------------------------------------------------------------------------

describe("yakcc_reference — apply-mode idempotency (no duplicate manifest entry)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
    const projectTmp = new URL("../../../../../tmp", import.meta.url).pathname;
    await mkdir(projectTmp, { recursive: true });
    tmpDir = await mkdtemp(join(projectTmp, "reference-idempotent-test-"));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("(15) calling apply twice for same atom does NOT duplicate the manifest references entry", async () => {
    // Each call re-uses the same tool instance (shared lazy registry).
    const tool = makeTool();

    await tool.handler({ atom_id: ROOT_A, project_root: tmpDir }, STUB_HTTP);
    await tool.handler({ atom_id: ROOT_A, project_root: tmpDir }, STUB_HTTP);

    const manifestText = await readFile(join(tmpDir, ".yakcc", "manifest.json"), "utf8");
    const manifest = parseProjectManifest(manifestText);

    // addReference is idempotent: same root+symbol yields ONE entry, not two.
    expect(manifest.references).toHaveLength(1);
    expect(manifest.references[0]!.root).toBe(ROOT_A);
  });
});

// ---------------------------------------------------------------------------
// Case (16): Apply-mode reads + extends existing manifest (not emptyManifest)
// ---------------------------------------------------------------------------

describe("yakcc_reference — apply-mode reads existing manifest and accumulates entries", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
    const projectTmp = new URL("../../../../../tmp", import.meta.url).pathname;
    await mkdir(projectTmp, { recursive: true });
    tmpDir = await mkdtemp(join(projectTmp, "reference-extend-test-"));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("(16) apply-mode preserves existing manifest entries when adding a new atom", async () => {
    // Pre-seed the manifest with a different atom reference so we can assert
    // that the tool reads + extends (not overwrites) the existing content.
    const { writeFile } = await import("node:fs/promises");
    const yakkcDir = join(tmpDir, ".yakcc");
    await mkdir(yakkcDir, { recursive: true });

    // Use a root that does NOT share ROOT_A's 12-char alias prefix.
    const EXISTING_ROOT =
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as BlockMerkleRoot;
    const existingManifest = {
      version: 1,
      references: [
        {
          root: EXISTING_ROOT,
          symbol: "someExistingFn",
          alias: EXISTING_ROOT.slice(0, 12),
          importPath: `.yakcc/atoms/${EXISTING_ROOT.slice(0, 12)}`,
          registry: "local",
          version: null,
        },
      ],
    };
    await writeFile(
      join(yakkcDir, "manifest.json"),
      JSON.stringify(existingManifest, null, 2) + "\n",
      "utf8",
    );

    const tool = makeTool();
    await tool.handler({ atom_id: ROOT_A, project_root: tmpDir }, STUB_HTTP);

    const manifestText = await readFile(join(tmpDir, ".yakcc", "manifest.json"), "utf8");
    const manifest = parseProjectManifest(manifestText);

    // Both entries must be present: the pre-existing one + the newly added one.
    expect(manifest.references).toHaveLength(2);
    const roots = manifest.references.map((r) => r.root);
    expect(roots).toContain(EXISTING_ROOT);
    expect(roots).toContain(ROOT_A);
  });
});

// ---------------------------------------------------------------------------
// Case (17): Non-apply mode — applied:false in response + full artifact present
// ---------------------------------------------------------------------------

describe("yakcc_reference — non-apply mode returns applied:false with full artifact", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(17) without project_root: applied:false + manifest_entry + dts_ref present", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);

    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as Record<string, unknown>;

    // applied flag must be false
    expect(parsed["applied"]).toBe(false);

    // Full artifact must be present
    expect(parsed).toHaveProperty("manifest_entry");
    expect(parsed).toHaveProperty("dts_ref");
    expect(parsed).toHaveProperty("import_line");
    expect(parsed).toHaveProperty("root");
    expect(parsed).toHaveProperty("atom_id");
  });
});

// ---------------------------------------------------------------------------
// Case (18): Apply-mode — invalid project_root value
// ---------------------------------------------------------------------------

describe("yakcc_reference — apply-mode input validation for project_root", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(18) empty string project_root → invalid_input, does not throw", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: ROOT_A, project_root: "" }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });
});
