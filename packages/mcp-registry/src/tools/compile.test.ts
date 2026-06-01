// @mock-exempt: seedRegistry opens real block dirs + filesystem; openRegistry opens SQLite;
// assemble traverses the registry. All are external boundaries relative to the MCP tool under test.
/**
 * Tests for yakcc_compile tool.
 *
 * @decision DEC-1028-COMPILE-FULL-ROOTS-001
 * @title yakcc_compile — full-registry root enumeration for id-resolution and assembly
 * @status decided (wi-1028)
 * @rationale
 *   WI-1028 fix: short-id resolution now uses the FULL registry block root set
 *   (enumerateSpecs → selectBlocks) instead of seedRegistry().merkleRoots.
 *   This makes non-seed atoms (the common case from yakcc_resolve) resolvable.
 *
 *   Test cases:
 *   (1) Full 64-char root → correct assembled source/implSource
 *   (2) 8-char short id (seed root) → the SAME correct source
 *   (2c) 8-char short id of a NON-SEED root (present in full registry but NOT
 *        in seed corpus) → resolves correctly and returns assembled source.
 *        This is the WI-1028 regression test: MUST FAIL on old logic (seedRegistry
 *        roots only), MUST PASS with new logic (full enumeration).
 *   (3) Ambiguous short prefix → ambiguous_short_id structured content
 *   (4) Unknown id → not_found structured content
 *   (5) Bad/missing input → structured error, handler does not throw
 *   (6) Registry open failure → registry_unavailable structured content, no throw
 *   (7) assemble() failure → assembly_failed structured content, no throw
 *   (8) Lazy registry open: factory called once even across multiple calls
 *
 * Mock strategy:
 *   - seedRegistry from @yakcc/seeds is vi.mock()'d — no real filesystem walk.
 *     Its return value is now irrelevant (discarded by handler); mock returns void stub.
 *   - assemble from @yakcc/compile is vi.mock()'d — no real assembly.
 *   - openRegistry from @yakcc/registry is vi.mock()'d — no real SQLite.
 *   - createOfflineEmbeddingProvider from @yakcc/contracts is vi.mock()'d.
 *   - The tool is created with a stub openRegistry factory. The stub Registry has
 *     enumerateSpecs() and selectBlocks() returning controlled roots — this is the
 *     full-registry enumeration surface that the new handler calls.
 *
 * Compound-Interaction Test Requirement (CLAUDE.md):
 *   Case (2c) exercises the full production sequence for the WI-1028 fix:
 *   createCompileTool() → handler → getRegistryAndFullRoots() →
 *   seedRegistry() [idempotent] → enumerateSpecs() → selectBlocks() →
 *   resolveAtomId(shortId, fullRoots) → assemble(fullRoot, registry, ...) →
 *   structured source response.
 *   The non-seed short-id test proves the resolution path crosses the
 *   enumerateSpecs/selectBlocks boundary correctly end-to-end.
 *
 * Implements: yakcc#1007, yakcc#1028
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../http-client.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@yakcc/seeds", () => ({
  seedRegistry: vi.fn(),
}));

vi.mock("@yakcc/compile", () => ({
  assemble: vi.fn(),
}));

vi.mock("@yakcc/registry", () => ({
  openRegistry: vi.fn(),
}));

vi.mock("@yakcc/contracts", () => ({
  createOfflineEmbeddingProvider: vi.fn().mockReturnValue({}),
}));

import { assemble } from "@yakcc/compile";
import type { Artifact } from "@yakcc/compile";
import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import { compileTool, createCompileTool } from "./compile.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A realistic-looking 64-char hex BlockMerkleRoot for the "primary" atom (seed-like). */
const ROOT_A = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" as BlockMerkleRoot;
/** Short id for ROOT_A (first 8 chars). */
const SHORT_A = ROOT_A.slice(0, 8); // "a1b2c3d4"

/**
 * A NON-SEED root — present in the full registry enumeration but NOT in the
 * seed corpus (i.e. NOT among seedRegistry().merkleRoots). This is the WI-1028
 * regression fixture: old code returned not_found; new code must resolve it.
 */
const ROOT_NON_SEED = "beef1234cafe5678beef1234cafe5678beef1234cafe5678beef1234cafe5678ab" as BlockMerkleRoot;
const SHORT_NON_SEED = ROOT_NON_SEED.slice(0, 8); // "beef1234"

/** A second root — used to create an ambiguous prefix scenario. Shares "a1b2c3d4" prefix with ROOT_A. */
const ROOT_B = ("a1b2c3d4" + "1".repeat(56)) as BlockMerkleRoot;

/** A root whose short id does NOT appear in any known root — for not_found tests. */
const ROOT_UNKNOWN_SHORT = "deadbeef";

/** Fake SpecHash values (64 hex chars, branded). */
const SPEC_HASH_A = "aaaa0000000000000000000000000000000000000000000000000000000000000000" as SpecHash;
const SPEC_HASH_NON_SEED = "bbbb0000000000000000000000000000000000000000000000000000000000000000" as SpecHash;
const SPEC_HASH_B = "cccc0000000000000000000000000000000000000000000000000000000000000000" as SpecHash;

/** The assembled TS source the mock returns for ROOT_A. */
const ASSEMBLED_SOURCE = `export function asciiChar(code: number): string { return String.fromCharCode(code); }`;
/** The assembled TS source the mock returns for ROOT_NON_SEED. */
const ASSEMBLED_SOURCE_NON_SEED = `export function nonSeedFn(x: number): number { return x * 2; }`;

/** A mock Artifact returned by the mocked assemble() for ROOT_A. */
function makeArtifact(): Artifact {
  return {
    source: ASSEMBLED_SOURCE,
    manifest: {
      entries: [
        {
          root: ROOT_A,
          specHash: SPEC_HASH_A,
          behavior: "converts ASCII code point to character",
          signature: "(code: number) => string",
          guarantees: ["pure", "deterministic"],
          sourceOffset: 0,
          sourceLength: ASSEMBLED_SOURCE.length,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

/** A mock Artifact returned by assemble() for ROOT_NON_SEED. */
function makeNonSeedArtifact(): Artifact {
  return {
    source: ASSEMBLED_SOURCE_NON_SEED,
    manifest: {
      entries: [
        {
          root: ROOT_NON_SEED,
          specHash: SPEC_HASH_NON_SEED,
          behavior: "doubles a number",
          signature: "(x: number) => number",
          guarantees: ["pure", "deterministic"],
          sourceOffset: 0,
          sourceLength: ASSEMBLED_SOURCE_NON_SEED.length,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

/**
 * Build a stub Registry with controlled enumerateSpecs / selectBlocks responses.
 *
 * `specToRoots` maps SpecHash → BlockMerkleRoot[]. The stub's enumerateSpecs()
 * returns the map's keys; selectBlocks(sh) returns the corresponding roots.
 *
 * This replaces the old `STUB_REGISTRY = {}` approach: the new handler calls
 * enumerateSpecs + selectBlocks to build fullRoots, so the stub must implement them.
 */
function makeRegistryStub(specToRoots: ReadonlyMap<SpecHash, BlockMerkleRoot[]>): Registry {
  return {
    enumerateSpecs: vi.fn().mockResolvedValue([...specToRoots.keys()]),
    selectBlocks: vi.fn().mockImplementation(async (sh: SpecHash) => specToRoots.get(sh) ?? []),
  } as unknown as Registry;
}

/**
 * Build a specToRoots map containing only ROOT_A (single, non-ambiguous).
 * ROOT_A is reachable via SHORT_A. seedRegistry is mocked to return void.
 */
function makeSpecMapOne(): ReadonlyMap<SpecHash, BlockMerkleRoot[]> {
  return new Map([[SPEC_HASH_A, [ROOT_A]]]);
}

/**
 * Build a specToRoots map with ROOT_A + ROOT_NON_SEED (two distinct prefixes).
 * ROOT_NON_SEED is NOT in seedRegistry().merkleRoots — proves the WI-1028 fix.
 */
function makeSpecMapWithNonSeed(): ReadonlyMap<SpecHash, BlockMerkleRoot[]> {
  return new Map([
    [SPEC_HASH_A, [ROOT_A]],
    [SPEC_HASH_NON_SEED, [ROOT_NON_SEED]],
  ]);
}

/**
 * Build a specToRoots map with ROOT_A + ROOT_B (both share "a1b2c3d4" prefix).
 * Used to trigger ambiguous_short_id.
 */
function makeSpecMapAmbiguous(): ReadonlyMap<SpecHash, BlockMerkleRoot[]> {
  return new Map([
    [SPEC_HASH_A, [ROOT_A]],
    [SPEC_HASH_B, [ROOT_B]],
  ]);
}

/** A minimal stub HttpClient (compile handler never uses it — but the interface requires it). */
const STUB_HTTP: HttpClient = {
  get: vi.fn(),
  post: vi.fn(),
} as unknown as HttpClient;

/**
 * Helper: create a tool instance backed by a controlled registry stub.
 * seedRegistry mock is set up to resolve (void — result discarded by handler).
 */
function makeTool(registry?: Registry): ReturnType<typeof createCompileTool> {
  const reg = registry ?? makeRegistryStub(makeSpecMapOne());
  return createCompileTool({ openRegistry: async () => reg });
}

// ---------------------------------------------------------------------------
// Case (1) + (2): Full root and short id → same assembled source
// (Compound-Interaction Test — proves the full production sequence end-to-end)
// ---------------------------------------------------------------------------

describe("yakcc_compile — full root and short id produce identical source (compound)", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as any);
    vi.mocked(assemble).mockResolvedValue(makeArtifact());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(1) full 64-char root → assembled source returned in content", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as {
      atom_id: string;
      root: string;
      source: string;
      block_count: number;
    };
    expect(parsed.source).toBe(ASSEMBLED_SOURCE);
    expect(parsed.root).toBe(ROOT_A);
    expect(parsed.block_count).toBe(1);
    // assemble was called with the full root and fullRoots from registry enumeration
    expect(vi.mocked(assemble)).toHaveBeenCalledWith(
      ROOT_A,
      expect.anything(),
      undefined,
      expect.objectContaining({ knownMerkleRoots: [ROOT_A] }),
    );
  });

  it("(2) 8-char short id → resolves to ROOT_A and returns the SAME assembled source", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: SHORT_A }, STUB_HTTP);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as {
      atom_id: string;
      root: string;
      source: string;
    };
    // Short id resolves to the full root
    expect(parsed.root).toBe(ROOT_A);
    // Source is identical to the full-root case — the same assemble() was called
    expect(parsed.source).toBe(ASSEMBLED_SOURCE);
    // assemble was called with the resolved full root (not the short id)
    expect(vi.mocked(assemble)).toHaveBeenCalledWith(
      ROOT_A,
      expect.anything(),
      undefined,
      expect.objectContaining({ knownMerkleRoots: [ROOT_A] }),
    );
  });

  it("(2b) short id in different case → still resolves (case-insensitive prefix)", async () => {
    const tool = makeTool();
    // ROOT_A starts with "a1b2c3d4" — try uppercase
    const upperShort = SHORT_A.toUpperCase();
    const result = await tool.handler({ atom_id: upperShort }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { source?: string; error?: string };
    // Should resolve (not not_found), because resolveAtomId lowercases the prefix
    expect(parsed.error).toBeUndefined();
    expect(parsed.source).toBe(ASSEMBLED_SOURCE);
  });
});

// ---------------------------------------------------------------------------
// Case (2c): WI-1028 regression — non-seed atom resolves via full registry
//
// This is the primary regression test for yakcc#1028.
// Old code: prefix-matched against seedRegistry().merkleRoots → not_found
// New code: prefix-matched against fullRoots (enumerateSpecs → selectBlocks) → resolved
//
// Setup: registry contains ROOT_NON_SEED (via SPEC_HASH_NON_SEED) but seedRegistry
// returns merkleRoots=[] (simulating a non-seed atom not in the seed corpus).
// The handler must still resolve SHORT_NON_SEED to ROOT_NON_SEED and return assembled source.
// ---------------------------------------------------------------------------

describe("yakcc_compile — WI-1028: non-seed atom resolves via full registry enumeration", () => {
  beforeEach(() => {
    // seedRegistry returns an empty merkleRoots list (no seed atoms) to prove
    // that resolution does NOT rely on seed roots for non-seed atoms.
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(2c) non-seed short id → full registry enumeration resolves it → real assembled source (regression)", async () => {
    // Registry contains ONLY the non-seed root. seedRegistry returns empty roots.
    // Old logic: resolveAtomId(SHORT_NON_SEED, []) → not_found
    // New logic: resolveAtomId(SHORT_NON_SEED, [ROOT_NON_SEED]) → full root → assemble
    const registry = makeRegistryStub(
      new Map([[SPEC_HASH_NON_SEED, [ROOT_NON_SEED]]]),
    );
    vi.mocked(assemble).mockResolvedValue(makeNonSeedArtifact());

    const tool = createCompileTool({ openRegistry: async () => registry });
    const result = await tool.handler({ atom_id: SHORT_NON_SEED }, STUB_HTTP);

    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as {
      atom_id: string;
      root: string;
      source: string;
      block_count: number;
      error?: string;
    };

    // Must NOT be not_found — this was the bug before WI-1028.
    expect(parsed.error).toBeUndefined();
    // Must resolve to the non-seed root.
    expect(parsed.root).toBe(ROOT_NON_SEED);
    // Must return the assembled source for the non-seed atom.
    expect(parsed.source).toBe(ASSEMBLED_SOURCE_NON_SEED);
    expect(parsed.block_count).toBe(1);

    // assemble called with the resolved non-seed root
    expect(vi.mocked(assemble)).toHaveBeenCalledWith(
      ROOT_NON_SEED,
      registry,
      undefined,
      expect.objectContaining({ knownMerkleRoots: [ROOT_NON_SEED] }),
    );

    // enumerateSpecs and selectBlocks must have been called — proves full enumeration
    expect(vi.mocked(registry.enumerateSpecs as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registry.selectBlocks as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(SPEC_HASH_NON_SEED);
  });

  it("(2c-full) non-seed full 64-char root → passes straight through to assemble without enumeration lookup", async () => {
    // Full 64-char root bypasses prefix matching (straight through).
    // Even without any roots in the registry, a full root can be assembled.
    const registry = makeRegistryStub(new Map([[SPEC_HASH_NON_SEED, [ROOT_NON_SEED]]]));
    vi.mocked(assemble).mockResolvedValue(makeNonSeedArtifact());

    const tool = createCompileTool({ openRegistry: async () => registry });
    const result = await tool.handler({ atom_id: ROOT_NON_SEED }, STUB_HTTP);

    const parsed = JSON.parse(result[0]!.text) as { root: string; source: string; error?: string };
    expect(parsed.error).toBeUndefined();
    expect(parsed.root).toBe(ROOT_NON_SEED);
    expect(parsed.source).toBe(ASSEMBLED_SOURCE_NON_SEED);
  });
});

// ---------------------------------------------------------------------------
// Case (3): Ambiguous short prefix
// ---------------------------------------------------------------------------

describe("yakcc_compile — ambiguous short id", () => {
  beforeEach(() => {
    // Both ROOT_A and ROOT_B share "a1b2c3d4" prefix — in full registry
    const registry = makeRegistryStub(makeSpecMapAmbiguous());
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as any);
    vi.mocked(assemble).mockResolvedValue(makeArtifact());
    // Override tool for this suite via beforeEach closure — tests create their own tools
    void registry; // used inline in each test
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(3) ambiguous_short_id → structured content, assemble NOT called", async () => {
    const registry = makeRegistryStub(makeSpecMapAmbiguous());
    const tool = createCompileTool({ openRegistry: async () => registry });
    // Both ROOT_A and ROOT_B start with "a1b2c3d4"
    const result = await tool.handler({ atom_id: SHORT_A }, STUB_HTTP);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as {
      error: string;
      message: string;
      atom_id: string;
      matches: string[];
    };
    expect(parsed.error).toBe("ambiguous_short_id");
    expect(parsed.atom_id).toBe(SHORT_A);
    expect(Array.isArray(parsed.matches)).toBe(true);
    expect(parsed.matches.length).toBeGreaterThanOrEqual(2);
    // matches must be full 64-char roots — the caller can pass one straight back to yakcc_compile
    expect(parsed.matches).toContain(ROOT_A);
    expect(parsed.matches).toContain(ROOT_B);
    expect(parsed.matches.every((m: string) => m.length === 64)).toBe(true);
    // message must tell the caller to retry with a full root
    expect(parsed.message).toContain("full root");
    // assemble should NOT have been called (structured error returned before assembly)
    expect(vi.mocked(assemble)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case (4): Unknown id → not_found
// ---------------------------------------------------------------------------

describe("yakcc_compile — not_found", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as any);
    vi.mocked(assemble).mockResolvedValue(makeArtifact());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(4) short id with no matching prefix → not_found structured content", async () => {
    const tool = makeTool(); // registry only has ROOT_A
    const result = await tool.handler({ atom_id: ROOT_UNKNOWN_SHORT }, STUB_HTTP);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as {
      error: string;
      message: string;
      atom_id: string;
    };
    expect(parsed.error).toBe("not_found");
    expect(parsed.atom_id).toBe(ROOT_UNKNOWN_SHORT);
    expect(vi.mocked(assemble)).not.toHaveBeenCalled();
  });

  it("(4b) full 64-char root not in registry → assembly_failed (passes straight through to assemble)", async () => {
    // A full root that is syntactically valid but not in the registry.
    // resolveAtomId accepts full 64-char roots directly (no prefix match needed),
    // so it returns { kind: "full", root } — then assemble() is called.
    // If the registry doesn't have it, assemble() throws → assembly_failed content.
    const unknownFullRoot =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as BlockMerkleRoot;
    const tool = makeTool();
    vi.mocked(assemble).mockRejectedValueOnce(new Error("block not found in registry"));
    const result = await tool.handler({ atom_id: unknownFullRoot }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("assembly_failed");
  });
});

// ---------------------------------------------------------------------------
// Case (5): Bad/missing input → structured error, handler does not throw
// ---------------------------------------------------------------------------

describe("yakcc_compile — input validation (handler never throws)", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as any);
    vi.mocked(assemble).mockResolvedValue(makeArtifact());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(5a) null args → invalid_input, does not throw", async () => {
    const tool = makeTool();
    const result = await tool.handler(null, STUB_HTTP);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("(5b) missing atom_id → invalid_input, does not throw", async () => {
    const tool = makeTool();
    const result = await tool.handler({}, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("(5c) atom_id is empty string → invalid_input, does not throw", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: "" }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("(5d) atom_id is a number → invalid_input, does not throw", async () => {
    const tool = makeTool();
    const result = await tool.handler({ atom_id: 12345 }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("(5e) args is an array → invalid_input, does not throw", async () => {
    const tool = makeTool();
    const result = await tool.handler(["a1b2c3d4"], STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// Registry open failure → registry_unavailable, no throw
// ---------------------------------------------------------------------------

describe("yakcc_compile — registry open failure", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registry open throws → registry_unavailable structured content, no throw", async () => {
    const failingTool = createCompileTool({
      openRegistry: async () => {
        throw new Error("SQLite open failed — no registry at path");
      },
    });
    const result = await failingTool.handler({ atom_id: SHORT_A }, STUB_HTTP);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as { error: string; message: string };
    expect(parsed.error).toBe("registry_unavailable");
    expect(parsed.message).toContain("SQLite open failed");
  });

  it("seedRegistry throws after registry open → registry_unavailable, no throw", async () => {
    vi.mocked(seedRegistry).mockRejectedValueOnce(new Error("seed step failed"));
    const tool = makeTool();
    const result = await tool.handler({ atom_id: SHORT_A }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("registry_unavailable");
  });

  it("enumerateSpecs throws → registry_unavailable, no throw", async () => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as any);
    const badRegistry = {
      enumerateSpecs: vi.fn().mockRejectedValue(new Error("DB corrupted")),
      selectBlocks: vi.fn(),
    } as unknown as Registry;
    const tool = createCompileTool({ openRegistry: async () => badRegistry });
    const result = await tool.handler({ atom_id: SHORT_A }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("registry_unavailable");
  });
});

// ---------------------------------------------------------------------------
// assemble() failure → assembly_failed, no throw
// ---------------------------------------------------------------------------

describe("yakcc_compile — assembly failure", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("assemble throws → assembly_failed structured content, no throw", async () => {
    vi.mocked(assemble).mockRejectedValueOnce(new Error("cyclic dependency detected"));
    const tool = makeTool();
    const result = await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as { error: string; message: string };
    expect(parsed.error).toBe("assembly_failed");
    expect(parsed.message).toContain("cyclic dependency detected");
  });
});

// ---------------------------------------------------------------------------
// Lazy registry open: factory called once across multiple calls
// ---------------------------------------------------------------------------

describe("yakcc_compile — lazy registry open (factory called once)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("openRegistry factory called exactly once even after multiple handler calls", async () => {
    vi.mocked(seedRegistry).mockResolvedValue({ stored: 0, merkleRoots: [] } as any);
    vi.mocked(assemble).mockResolvedValue(makeArtifact());

    const registry = makeRegistryStub(makeSpecMapOne());
    const openFn = vi.fn().mockResolvedValue(registry);
    const tool = createCompileTool({ openRegistry: openFn });

    await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);
    await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);

    // Registry opened once and cached
    expect(openFn).toHaveBeenCalledTimes(1);
    // seedRegistry also called only once (cached alongside registry)
    expect(vi.mocked(seedRegistry)).toHaveBeenCalledTimes(1);
    // enumerateSpecs called only once (roots cached)
    expect(vi.mocked(registry.enumerateSpecs as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tool shape (module-level)
// ---------------------------------------------------------------------------

describe("yakcc_compile tool shape", () => {
  it("has name=yakcc_compile", () => {
    expect(compileTool.name).toBe("yakcc_compile");
  });

  it("has a non-empty description", () => {
    expect(compileTool.description.length).toBeGreaterThan(50);
  });

  it("inputSchema has type=object, required=[atom_id]", () => {
    expect(compileTool.inputSchema.type).toBe("object");
    expect(compileTool.inputSchema.required).toContain("atom_id");
    expect(compileTool.inputSchema.properties).toHaveProperty("atom_id");
  });
});
