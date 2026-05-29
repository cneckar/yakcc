// SPDX-License-Identifier: MIT
// @mock-exempt: @yakcc/compile-python and @yakcc/registry are external package boundaries.
// The compile-python adapter uses ts-morph under the hood; the registry uses SQLite.
// Mocking at the public-API surface is explicitly required by DEC-WI877-007 so tests
// run without a real registry file on disk or real IR compilation.
// Real integration is covered by compile-python.smoke.test.ts (gated on YAKCC_SKIP_PYTHON_SMOKE).
//
// compile-python.test.ts — unit tests for runCompilePython.
//
// @decision DEC-WI877-007
// @title Test seam: mock adapter packages at the public-API boundary; gated smoke
// @status accepted (WI-877)
// @rationale
//   Mock @yakcc/compile-python + @yakcc/registry + @yakcc/seeds at the public-API
//   boundary for fast, isolated tests.  The real subprocess/SQLite integration is
//   covered by the gated smoke suite.
//   Cross-reference: PLAN.md §3.4 / #877

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectingLogger } from "../index.js";
import type { CompilePythonCallArgs } from "./compile-python.js";
import { runCompilePython } from "./compile-python.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock compile-python package
vi.mock("@yakcc/compile-python", () => ({
  compileToPython: vi.fn(),
}));

// Mock registry
vi.mock("@yakcc/registry", () => ({
  openRegistry: vi.fn(),
}));

// Mock seeds (seedRegistry is a no-op in tests)
vi.mock("@yakcc/seeds", () => ({
  seedRegistry: vi.fn().mockResolvedValue({ merkleRoots: [] }),
}));

import * as compilePythonMod from "@yakcc/compile-python";
import * as registryMod from "@yakcc/registry";

const mockCompileToPython = vi.mocked(compilePythonMod.compileToPython);
const mockOpenRegistry = vi.mocked(registryMod.openRegistry);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock registry instance. */
function makeMockRegistry(getBlockResult: Record<string, unknown> | null = null) {
  return {
    getBlock: vi.fn().mockResolvedValue(getBlockResult),
    selectBlocks: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    // minimal shape — compile-python only uses getBlock + selectBlocks + close
  };
}

/** A valid 64-hex BlockMerkleRoot stub. */
const STUB_ROOT = "a".repeat(64);

/** Default CompilePythonCallArgs. */
function callArgs(overrides?: Partial<CompilePythonCallArgs>): CompilePythonCallArgs {
  return {
    entryArg: STUB_ROOT,
    registryPath: ".yakcc/registry.sqlite",
    ...overrides,
  };
}

/** Minimal BlockTripletRow stub — only fields compileToPython reads. */
function stubRow() {
  return {
    implSource: "export function double(x: number): number {\n  return (x + x);\n}",
    artifacts: new Map<string, Uint8Array>(),
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "compile-python-test-"));
  vi.clearAllMocks();
  // Default: openRegistry succeeds
  mockOpenRegistry.mockResolvedValue(makeMockRegistry(stubRow()) as unknown as Awaited<ReturnType<typeof registryMod.openRegistry>>);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runCompilePython — happy path: BlockMerkleRoot → module.py + manifest.json", () => {
  it("writes module.py + manifest.json with target=python, returns 0", async () => {
    const outDir = join(tempDir, "out");
    mockCompileToPython.mockReturnValue({
      source: "def double(x):\n    return x + x\n",
      testSource: "",
      warnings: [],
    });

    const logger = new CollectingLogger();
    const code = await runCompilePython(callArgs({ outDir }), logger);

    expect(code).toBe(0);
    const moduleSrc = readFileSync(join(outDir, "module.py"), "utf-8");
    expect(moduleSrc).toContain("def double");

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf-8"));
    expect(manifest.target).toBe("python");
    expect(manifest.entryRoot).toBe(STUB_ROOT);
    expect(Array.isArray(manifest.warnings)).toBe(true);
  });
});

describe("runCompilePython — testSource non-empty → writes test_module.py", () => {
  it("writes test_module.py when testSource is non-empty", async () => {
    const outDir = join(tempDir, "out-test");
    mockCompileToPython.mockReturnValue({
      source: "def double(x):\n    return x + x\n",
      testSource: "from hypothesis import given\n@given(...)\ndef test_double(x):\n    pass\n",
      warnings: [],
    });

    const logger = new CollectingLogger();
    const code = await runCompilePython(callArgs({ outDir }), logger);

    expect(code).toBe(0);
    const testSrc = readFileSync(join(outDir, "test_module.py"), "utf-8");
    expect(testSrc).toContain("hypothesis");
  });
});

describe("runCompilePython — testSource empty → no test_module.py", () => {
  it("does not write test_module.py when testSource is empty string", async () => {
    const outDir = join(tempDir, "out-notest");
    mockCompileToPython.mockReturnValue({
      source: "def double(x):\n    return x + x\n",
      testSource: "",
      warnings: [],
    });

    const logger = new CollectingLogger();
    const code = await runCompilePython(callArgs({ outDir }), logger);

    expect(code).toBe(0);
    // test_module.py must NOT exist
    let threw = false;
    try {
      readFileSync(join(outDir, "test_module.py"), "utf-8");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("runCompilePython — registry miss → exit 1 with structured error", () => {
  it("returns 1 when getBlock returns null", async () => {
    mockOpenRegistry.mockResolvedValue(
      makeMockRegistry(null) as unknown as Awaited<ReturnType<typeof registryMod.openRegistry>>,
    );

    const logger = new CollectingLogger();
    const code = await runCompilePython(callArgs(), logger);

    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("no atom with root");
  });
});

describe("runCompilePython — --function <name> forwarded to compileToPython", () => {
  it("passes fnName option to compileToPython", async () => {
    const outDir = join(tempDir, "out-fn");
    mockCompileToPython.mockReturnValue({ source: "pass\n", testSource: "", warnings: [] });

    const logger = new CollectingLogger();
    await runCompilePython(callArgs({ outDir, fnName: "myFunc" }), logger);

    expect(mockCompileToPython).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fnName: "myFunc" }),
    );
  });
});

describe("runCompilePython — spec file path (non-hex entry)", () => {
  it("reads spec.yak from a directory entry, resolves first matching root", async () => {
    // Create a spec.yak file in temp dir.
    const specDir = join(tempDir, "myspec");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(specDir, { recursive: true });
    const specContent = JSON.stringify({
      name: "double",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
    });
    writeFileSync(join(specDir, "spec.yak"), specContent, "utf-8");

    // Mock registry to return a root for selectBlocks.
    const mockReg = makeMockRegistry(stubRow());
    mockReg.selectBlocks = vi.fn().mockResolvedValue([STUB_ROOT]);
    mockOpenRegistry.mockResolvedValue(
      mockReg as unknown as Awaited<ReturnType<typeof registryMod.openRegistry>>,
    );
    mockCompileToPython.mockReturnValue({ source: "pass\n", testSource: "", warnings: [] });

    const logger = new CollectingLogger();
    const code = await runCompilePython(
      callArgs({ entryArg: specDir, outDir: join(tempDir, "spec-out") }),
      logger,
    );

    expect(code).toBe(0);
    // --out defaults to <dir>/dist when entry is a directory
    expect(mockReg.selectBlocks).toHaveBeenCalled();
  });
});

describe("runCompilePython — warnings surfaced to stderr", () => {
  it("emits each warning via logger.error", async () => {
    const outDir = join(tempDir, "out-warn");
    mockCompileToPython.mockReturnValue({
      source: "pass\n",
      testSource: "",
      warnings: [
        { kind: "unsupported-construct", message: "Array.reduce is not yet supported" },
      ],
    });

    const logger = new CollectingLogger();
    const code = await runCompilePython(callArgs({ outDir }), logger);

    expect(code).toBe(0);
    expect(logger.errLines.join("\n")).toContain("Array.reduce");
  });
});
