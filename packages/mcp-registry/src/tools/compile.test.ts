// @mock-exempt: seedRegistry opens real block dirs + filesystem; openRegistry opens SQLite;
// assemble traverses the registry. All are external boundaries relative to the MCP tool under test.
/**
 * Tests for yakcc_compile tool.
 *
 * @decision DEC-MCP-COMPILE-EXEC-1007-001
 * @title yakcc_compile — local-registry atom materialization
 * @status decided (wi-1007)
 * @rationale
 *   Five required cases per dispatch spec:
 *   (1) Full 64-char root → correct assembled source/implSource
 *   (2) 8-char short id → the SAME correct source (proves short→full resolution)
 *   (3) Ambiguous short prefix → ambiguous_short_id structured content
 *   (4) Unknown id → not_found structured content
 *   (5) Bad/missing input → structured error, handler does not throw
 *
 *   Plus:
 *   (6) Registry open failure → registry_unavailable structured content, no throw
 *   (7) assemble() failure → assembly_failed structured content, no throw
 *   (8) Lazy registry open: factory called once even across multiple calls
 *
 * Mock strategy:
 *   - seedRegistry from @yakcc/seeds is vi.mock()'d — no real filesystem walk.
 *   - assemble from @yakcc/compile is vi.mock()'d — no real assembly.
 *   - openRegistry from @yakcc/registry is vi.mock()'d — no real SQLite.
 *   - createOfflineEmbeddingProvider from @yakcc/contracts is vi.mock()'d.
 *   - The tool is created with a stub openRegistry factory for deterministic control.
 *   - HttpClient is injected (unused by compile handler — compile is local-only).
 *
 * Compound-Interaction Test Requirement (CLAUDE.md):
 *   Case (1) + (2) together exercise the full production sequence:
 *   createCompileTool() → handler → getRegistryAndSeed() → seedRegistry() →
 *   resolveAtomId() → assemble() → structured response.
 *   The short-id test (case 2) proves the resolution path is wired to the same
 *   assembled output as the full-root path (case 1).
 *
 * Implements: yakcc#1007
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
import type { BlockMerkleRoot } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import type { SeedResult } from "@yakcc/seeds";
import { compileTool, createCompileTool } from "./compile.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A realistic-looking 64-char hex BlockMerkleRoot for the "primary" seed atom. */
const ROOT_A = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" as BlockMerkleRoot;
/** Short id for ROOT_A (first 8 chars). */
const SHORT_A = ROOT_A.slice(0, 8); // "a1b2c3d4"

/** A second root — used to create an ambiguous prefix scenario. Exactly 64 hex chars, shares "a1b2c3d4" prefix with ROOT_A. */
const ROOT_B = ("a1b2c3d4" + "1".repeat(56)) as BlockMerkleRoot;

/** A root whose short id does NOT appear in any known root — for not_found tests. */
const ROOT_UNKNOWN_SHORT = "deadbeef";

/** The assembled TS source the mock returns for ROOT_A. */
const ASSEMBLED_SOURCE = `export function asciiChar(code: number): string { return String.fromCharCode(code); }`;

/** A mock Artifact returned by the mocked assemble(). */
function makeArtifact(): Artifact {
  return {
    source: ASSEMBLED_SOURCE,
    manifest: {
      entries: [
        {
          root: ROOT_A,
          specHash: "spechashhex00000000000000000000000000000000000000000000000000000000" as import("@yakcc/contracts").SpecHash,
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

/** A stub Registry object (content irrelevant — assemble is mocked). */
const STUB_REGISTRY = {} as unknown as Registry;

/** A SeedResult with a single known root: ROOT_A. */
function makeSeedResultOne(): SeedResult {
  return { stored: 1, merkleRoots: [ROOT_A] };
}

/** A SeedResult with two roots that share the same 8-char prefix: ROOT_A and ROOT_B. */
function makeSeedResultAmbiguous(): SeedResult {
  return { stored: 2, merkleRoots: [ROOT_A, ROOT_B] };
}

/** A minimal stub HttpClient (compile handler never uses it — but the interface requires it). */
const STUB_HTTP: HttpClient = {
  get: vi.fn(),
  post: vi.fn(),
} as unknown as HttpClient;

/** Helper: create a tool instance with mocked seedRegistry + controlled registry. */
function makeTool(openRegistryFn?: () => Promise<Registry>): ReturnType<typeof createCompileTool> {
  return createCompileTool({
    openRegistry: openRegistryFn ?? (async () => STUB_REGISTRY),
  });
}

// ---------------------------------------------------------------------------
// Case (1) + (2): Full root and short id → same assembled source
// (Compound-Interaction Test — proves the full production sequence end-to-end)
// ---------------------------------------------------------------------------

describe("yakcc_compile — full root and short id produce identical source (compound)", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue(makeSeedResultOne());
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
    // assemble was called with the full root
    expect(vi.mocked(assemble)).toHaveBeenCalledWith(
      ROOT_A,
      STUB_REGISTRY,
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
      STUB_REGISTRY,
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
// Case (3): Ambiguous short prefix
// ---------------------------------------------------------------------------

describe("yakcc_compile — ambiguous short id", () => {
  beforeEach(() => {
    // Two roots share the "a1b2c3d4" prefix
    vi.mocked(seedRegistry).mockResolvedValue(makeSeedResultAmbiguous());
    vi.mocked(assemble).mockResolvedValue(makeArtifact());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(3) ambiguous_short_id → structured content, assemble NOT called", async () => {
    const tool = makeTool();
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
    vi.mocked(seedRegistry).mockResolvedValue(makeSeedResultOne());
    vi.mocked(assemble).mockResolvedValue(makeArtifact());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(4) short id with no matching prefix → not_found structured content", async () => {
    const tool = makeTool();
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

  it("(4b) full 64-char root not in seed set → assembly_failed (passes straight through to assemble)", async () => {
    // A full root that is syntactically valid but not in knownRoots.
    // resolveAtomId accepts full 64-char roots directly (no prefix match needed),
    // so it returns { kind: "full", root } — then assemble() is called.
    // If the registry doesn't have it, assemble() throws → assembly_failed content.
    const unknownFullRoot =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as BlockMerkleRoot;
    const tool4b = makeTool();
    vi.mocked(assemble).mockRejectedValueOnce(new Error("block not found in registry"));
    const result = await tool4b.handler({ atom_id: unknownFullRoot }, STUB_HTTP);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("assembly_failed");
  });
});

// ---------------------------------------------------------------------------
// Case (5): Bad/missing input → structured error, handler does not throw
// ---------------------------------------------------------------------------

describe("yakcc_compile — input validation (handler never throws)", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue(makeSeedResultOne());
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
});

// ---------------------------------------------------------------------------
// assemble() failure → assembly_failed, no throw
// ---------------------------------------------------------------------------

describe("yakcc_compile — assembly failure", () => {
  beforeEach(() => {
    vi.mocked(seedRegistry).mockResolvedValue(makeSeedResultOne());
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
    vi.mocked(seedRegistry).mockResolvedValue(makeSeedResultOne());
    vi.mocked(assemble).mockResolvedValue(makeArtifact());

    const openFn = vi.fn().mockResolvedValue(STUB_REGISTRY);
    const tool = createCompileTool({ openRegistry: openFn });

    await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);
    await tool.handler({ atom_id: ROOT_A }, STUB_HTTP);

    // Registry opened once and cached
    expect(openFn).toHaveBeenCalledTimes(1);
    // seedRegistry also called only once (cached alongside registry)
    expect(vi.mocked(seedRegistry)).toHaveBeenCalledTimes(1);
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
