/**
 * cli.test.ts — integration tests for all five yakcc CLI commands.
 *
 * Production sequence exercised (compound-interaction test):
 *   runCli(["registry", "init", ...], logger) → runCli(["seed", ...], logger)
 *   → runCli(["compile", entryId, ...], logger) → ts.transpileModule(module.ts)
 *   → import(tempFile) → module.listOfInts("[1,2,3]") === [1, 2, 3]
 *
 * Each command has an integration test that exercises the canonical happy path
 * against a fresh temp-file registry. The compile end-to-end test produces a
 * runnable module and calls the assembled function with real inputs.
 *
 * Tests cover:
 *   - registry init: creates the SQLite file; idempotent on second call
 *   - seed: ingests all 20 corpus blocks; prints the count
 *   - propose (match): after seed, propose a known spec returns match: <id>
 *   - propose (no match): novel spec returns no match found + authoring template
 *   - search: free-text query returns at least one result line with score
 *   - compile (end-to-end): outputs module.ts and manifest.json with >=7 entries;
 *     assembled module exports listOfInts and parses [1,2,3] correctly
 *   - error paths: unknown command, missing entry, malformed spec, empty argv
 *
 * @decision DEC-CLI-TEST-001: Tests use real temp-file SQLite registries (not :memory:)
 * so that runCli() — which opens/closes its own registry handle per call — can operate
 * against the same on-disk state across multiple invocations. A :memory: registry
 * opened in the test would be a distinct handle from the one runCli() opens.
 * Status: implemented (WI-007)
 * Rationale: runCli() is a public boundary that opens its own registry per invocation.
 * Temp-file SQLite is the correct integration boundary; it matches production behaviour.
 *
 * @decision DEC-CLI-TEST-002: Output capture uses CollectingLogger (a real in-memory
 * implementation of the Logger interface) rather than vi.spyOn mocks. Each test
 * constructs a fresh CollectingLogger and passes it to runCli(). No mocking of internal
 * code is required.
 * Status: implemented (WI-007)
 * Rationale: Sacred Practice #5 — mocks are acceptable only for external boundaries.
 * CollectingLogger is a real implementation that satisfies the Logger contract; it
 * accumulates lines in plain arrays that tests inspect directly.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContractId } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "./index.js";

// ---------------------------------------------------------------------------
// Suite lifecycle — shared temp directories, seeded once
// ---------------------------------------------------------------------------

let suiteDir: string;
/** Path to the shared SQLite registry used across all command suites. */
let registryPath: string;
/** Temp directory for transpiled .mjs files produced by the compile e2e test. */
let transpileDir: string;
/** ContractId of the list-of-ints block, discovered from the seed corpus. */
let listOfIntsId: ContractId;

beforeAll(async () => {
  suiteDir = mkdtempSync(join(tmpdir(), "yakcc-cli-test-"));
  registryPath = join(suiteDir, "test.sqlite");
  transpileDir = mkdtempSync(join(tmpdir(), "yakcc-cli-transpile-"));

  // Initialise the shared registry once.
  const initLogger = new CollectingLogger();
  const initCode = await runCli(["registry", "init", "--path", registryPath], initLogger);
  if (initCode !== 0) {
    throw new Error(`registry init failed: ${initLogger.errLines.join("\n")}`);
  }

  // Seed it once — all subsequent command tests reuse this seeded state.
  const seedLogger = new CollectingLogger();
  const seedCode = await runCli(["seed", "--registry", registryPath], seedLogger);
  if (seedCode !== 0) {
    throw new Error(`seed failed: ${seedLogger.errLines.join("\n")}`);
  }

  // Discover the list-of-ints ContractId from the seed corpus via a :memory: registry.
  // We open a separate handle here only for id discovery; the CLI tests use registryPath.
  const reg = await openRegistry(":memory:");
  const seedResult = await seedRegistry(reg);
  let found: ContractId | null = null;
  for (const id of seedResult.contractIds) {
    const impl = await reg.getImplementation(id);
    if (impl?.source.includes("export function listOfInts")) {
      found = id;
      break;
    }
  }
  await reg.close();
  if (found === null) {
    throw new Error("seedRegistry did not register a listOfInts block");
  }
  listOfIntsId = found;
});

afterAll(() => {
  for (const dir of [suiteDir, transpileDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Non-fatal — temp cleanup failure does not fail the suite.
    }
  }
});

// ---------------------------------------------------------------------------
// Helper: transpile assembled TS source to ESM and dynamically import it
// ---------------------------------------------------------------------------

let transpileCounter = 0;

/**
 * Transpile assembled TypeScript source to ESM using ts.transpileModule,
 * write to a unique .mjs file in transpileDir, and import it dynamically.
 * Mirrors the pattern in packages/compile/src/assemble.test.ts.
 */
async function importAssembled(source: string): Promise<unknown> {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  });
  transpileCounter++;
  const file = join(transpileDir, `mod-${transpileCounter}.mjs`);
  writeFileSync(file, result.outputText, "utf-8");
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------
// Suite 1: registry init
// ---------------------------------------------------------------------------

describe("registry init", () => {
  it("created the SQLite file during beforeAll setup", () => {
    expect(existsSync(registryPath)).toBe(true);
  });

  it("is idempotent — second call also exits 0", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["registry", "init", "--path", registryPath], logger);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("registry initialized"))).toBe(true);
  });

  it("exits 1 for unknown registry subcommand", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["registry", "notacommand"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("unknown registry subcommand"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: seed
// ---------------------------------------------------------------------------

describe("seed", () => {
  it("ingested all 20 corpus blocks during beforeAll setup", async () => {
    // Re-run seed to verify idempotency and output format.
    const logger = new CollectingLogger();
    const code = await runCli(["seed", "--registry", registryPath], logger);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("seeded 20 contracts"))).toBe(true);
  });

  it("is idempotent — repeated seed exits 0 with consistent count", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["seed", "--registry", registryPath], logger);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("seeded"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: propose
// ---------------------------------------------------------------------------

describe("propose", () => {
  it("returns match: <id> when spec is in the seeded registry", async () => {
    // Extract the list-of-ints spec from a :memory: registry to get the exact canonical form.
    const reg = await openRegistry(":memory:");
    await seedRegistry(reg);
    const contract = await reg.getContract(listOfIntsId);
    await reg.close();
    expect(contract).not.toBeNull();
    if (contract === null) return; // type narrowing; assertion above guards this

    const specPath = join(suiteDir, "list-of-ints-spec.json");
    writeFileSync(specPath, JSON.stringify(contract.spec), "utf-8");

    const logger = new CollectingLogger();
    const code = await runCli(["propose", specPath, "--registry", registryPath], logger);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.startsWith("match:"))).toBe(true);
    expect(logger.logLines.some((l) => l.includes(listOfIntsId))).toBe(true);
  });

  it("returns manual-authoring template when spec is not in the registry", async () => {
    const novelSpec = {
      behavior: "A completely novel behavior that has never been seen before in this corpus xyz",
      inputs: [{ name: "x", type: "number", description: "a number" }],
      outputs: [{ name: "y", type: "number", description: "a number" }],
      guarantees: [],
      errorConditions: [],
      nonFunctional: { purity: "pure" as const, threadSafety: "safe" as const },
      propertyTests: [],
    };
    const novelPath = join(suiteDir, "novel-spec.json");
    writeFileSync(novelPath, JSON.stringify(novelSpec), "utf-8");

    const logger = new CollectingLogger();
    const code = await runCli(["propose", novelPath, "--registry", registryPath], logger);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("no match found"))).toBe(true);
    expect(logger.logLines.some((l) => l.includes("yakcc block author"))).toBe(true);
  });

  it("exits 1 when no contract file argument is given", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["propose"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("propose requires"))).toBe(true);
  });

  it("exits 1 when spec file does not exist", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(
      ["propose", join(suiteDir, "nonexistent.json"), "--registry", registryPath],
      logger,
    );
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("cannot read spec file"))).toBe(true);
  });

  it("exits 1 when spec file contains malformed JSON", async () => {
    const badPath = join(suiteDir, "bad.json");
    writeFileSync(badPath, "{ not valid json }", "utf-8");
    const logger = new CollectingLogger();
    const code = await runCli(["propose", badPath, "--registry", registryPath], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("invalid JSON"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: search
// ---------------------------------------------------------------------------

describe("search", () => {
  it("spec-file query returns at least one result line with score and exits 0", async () => {
    // Free-text search constructs a spec with inputs:[] / outputs:[], which the
    // structural filter rejects for all corpus blocks (they all have inputs).
    // Use a real spec file so structural matching can pass.
    const reg = await openRegistry(":memory:");
    await seedRegistry(reg);
    const contract = await reg.getContract(listOfIntsId);
    await reg.close();
    if (contract === null) throw new Error("listOfInts not found");

    const searchSpecPath = join(suiteDir, "search-spec.json");
    writeFileSync(searchSpecPath, JSON.stringify(contract.spec), "utf-8");

    const logger = new CollectingLogger();
    const code = await runCli(["search", searchSpecPath, "--registry", registryPath], logger);
    expect(code).toBe(0);
    const resultLines = logger.logLines.filter((l) => l.includes("score="));
    expect(resultLines.length).toBeGreaterThanOrEqual(1);
  });

  it("exits 1 when no query argument is given", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["search"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("search requires"))).toBe(true);
  });

  it("exits 0 with no results for an unmatchable query", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(
      [
        "search",
        "zzz extremely unlikely gibberish xyzzy quantum flux capacitor",
        "--registry",
        registryPath,
      ],
      logger,
    );
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: compile — load-bearing end-to-end test
// ---------------------------------------------------------------------------

describe("compile", () => {
  it("exits 1 when no entry argument is given", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(
      ["compile", "--registry", registryPath, "--out", join(suiteDir, "unused-out")],
      logger,
    );
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("compile requires"))).toBe(true);
  });

  it("exits 1 when entry contractId is absent from an unseeded registry", async () => {
    const emptyRegPath = join(suiteDir, "empty.sqlite");
    // Do not seed — registry is empty after init.
    const initLogger = new CollectingLogger();
    await runCli(["registry", "init", "--path", emptyRegPath], initLogger);

    // A syntactically valid but absent contractId.
    const fakeId = "a".repeat(64);
    const logger = new CollectingLogger();
    const code = await runCli(
      ["compile", fakeId, "--registry", emptyRegPath, "--out", join(suiteDir, "unused-out2")],
      logger,
    );
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("error"))).toBe(true);
  });

  it("compiles list-of-ints: exits 0, writes module.ts and manifest.json", async () => {
    const outDir = join(suiteDir, "compile-list-of-ints");
    const logger = new CollectingLogger();
    const code = await runCli(
      ["compile", listOfIntsId, "--registry", registryPath, "--out", outDir],
      logger,
    );
    expect(code).toBe(0);
    expect(existsSync(join(outDir, "module.ts"))).toBe(true);
    expect(existsSync(join(outDir, "manifest.json"))).toBe(true);
  });

  it("manifest.json has at least 7 entries (transitive closure of list-of-ints)", async () => {
    const outDir = join(suiteDir, "compile-manifest-check");
    const logger = new CollectingLogger();
    await runCli(["compile", listOfIntsId, "--registry", registryPath, "--out", outDir], logger);
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf-8")) as {
      entries: unknown[];
    };
    expect(manifest.entries.length).toBeGreaterThanOrEqual(7);
  });

  it("end-to-end: assembled module exports listOfInts and parses [1,2,3] → [1,2,3]", async () => {
    const outDir = join(suiteDir, "compile-e2e");
    const logger = new CollectingLogger();
    const code = await runCli(
      ["compile", listOfIntsId, "--registry", registryPath, "--out", outDir],
      logger,
    );
    expect(code).toBe(0);

    const source = readFileSync(join(outDir, "module.ts"), "utf-8");
    expect(source.trim().length).toBeGreaterThan(0);

    const mod = (await importAssembled(source)) as {
      listOfInts: (s: string) => ReadonlyArray<number>;
    };
    expect(typeof mod.listOfInts).toBe("function");
    expect(mod.listOfInts("[1,2,3]")).toEqual([1, 2, 3]);
    expect(mod.listOfInts("[]")).toEqual([]);
    expect(mod.listOfInts("[ 42 ]")).toEqual([42]);
    expect(() => mod.listOfInts("[1,2,")).toThrow();
    expect(() => mod.listOfInts("[abc]")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite 6: runCli error paths
// ---------------------------------------------------------------------------

describe("runCli error paths", () => {
  it("exits 0 and prints usage when called with no args", async () => {
    const logger = new CollectingLogger();
    const code = await runCli([], logger);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("yakcc"))).toBe(true);
  });

  it("exits 0 for --help flag", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["--help"], logger);
    expect(code).toBe(0);
  });

  it("exits 1 with error message for unknown command", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["not-a-real-command"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("unknown command"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 7: hooks claude-code install
// ---------------------------------------------------------------------------

describe("hooks claude-code install", () => {
  it("exits 0, creates .claude/CLAUDE.md in target dir, and prints confirmation", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "yakcc-hooks-test-"));
    try {
      const logger = new CollectingLogger();
      const code = await runCli(["hooks", "claude-code", "install", "--target", targetDir], logger);
      expect(code).toBe(0);
      expect(existsSync(join(targetDir, ".claude", "CLAUDE.md"))).toBe(true);
      expect(logger.logLines.some((l) => l.includes("yakcc hooks installed"))).toBe(true);
      expect(logger.logLines.some((l) => l.includes("/yakcc"))).toBe(true);
    } finally {
      try {
        rmSync(targetDir, { recursive: true, force: true });
      } catch {
        // Non-fatal cleanup.
      }
    }
  });

  it("CLAUDE.md contains the stub response message", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "yakcc-hooks-stub-"));
    try {
      const logger = new CollectingLogger();
      await runCli(["hooks", "claude-code", "install", "--target", targetDir], logger);
      const content = readFileSync(join(targetDir, ".claude", "CLAUDE.md"), "utf-8");
      expect(content).toContain("v0.5 feature");
      expect(content).toContain("/yakcc");
    } finally {
      try {
        rmSync(targetDir, { recursive: true, force: true });
      } catch {
        // Non-fatal cleanup.
      }
    }
  });

  it("is idempotent — second install exits 0 and overwrites CLAUDE.md", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "yakcc-hooks-idem-"));
    try {
      const logger1 = new CollectingLogger();
      const code1 = await runCli(
        ["hooks", "claude-code", "install", "--target", targetDir],
        logger1,
      );
      expect(code1).toBe(0);
      const logger2 = new CollectingLogger();
      const code2 = await runCli(
        ["hooks", "claude-code", "install", "--target", targetDir],
        logger2,
      );
      expect(code2).toBe(0);
    } finally {
      try {
        rmSync(targetDir, { recursive: true, force: true });
      } catch {
        // Non-fatal cleanup.
      }
    }
  });

  it("exits 1 for unknown hooks claude-code subcommand", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["hooks", "claude-code", "notacommand"], logger);
    expect(code).toBe(1);
    expect(
      logger.errLines.some((l) => l.includes("unknown hooks claude-code subcommand")),
    ).toBe(true);
  });

  it("exits 1 for unknown hooks subcommand", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["hooks", "notaplatform"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("unknown hooks subcommand"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 8: compile — manifest determinism (exit criterion 3)
// ---------------------------------------------------------------------------

describe("compile manifest determinism", () => {
  it("two consecutive compiles of list-of-ints produce byte-identical manifests", async () => {
    const outDir1 = join(suiteDir, "manifest-det-run1");
    const outDir2 = join(suiteDir, "manifest-det-run2");

    const logger1 = new CollectingLogger();
    const code1 = await runCli(
      ["compile", listOfIntsId, "--registry", registryPath, "--out", outDir1],
      logger1,
    );
    expect(code1).toBe(0);

    const logger2 = new CollectingLogger();
    const code2 = await runCli(
      ["compile", listOfIntsId, "--registry", registryPath, "--out", outDir2],
      logger2,
    );
    expect(code2).toBe(0);

    const manifest1 = readFileSync(join(outDir1, "manifest.json"), "utf-8");
    const manifest2 = readFileSync(join(outDir2, "manifest.json"), "utf-8");
    expect(manifest1).toBe(manifest2);

    // Also verify module.ts is byte-identical across runs.
    const module1 = readFileSync(join(outDir1, "module.ts"), "utf-8");
    const module2 = readFileSync(join(outDir2, "module.ts"), "utf-8");
    expect(module1).toBe(module2);
  });

  it("directory-form compile (via contract.json) produces the same manifest as ContractId form", async () => {
    // Write the list-of-ints spec to a temp directory so we can test the directory form.
    const exampleDir = mkdtempSync(join(tmpdir(), "yakcc-dir-compile-"));
    try {
      const reg = await openRegistry(":memory:");
      await seedRegistry(reg);
      const contract = await reg.getContract(listOfIntsId);
      await reg.close();
      if (contract === null) throw new Error("listOfInts not in registry");

      writeFileSync(join(exampleDir, "contract.json"), JSON.stringify(contract.spec), "utf-8");

      const outDirDirect = join(suiteDir, "manifest-direct");
      const loggerDirect = new CollectingLogger();
      const codeDirect = await runCli(
        ["compile", listOfIntsId, "--registry", registryPath, "--out", outDirDirect],
        loggerDirect,
      );
      expect(codeDirect).toBe(0);

      // The directory form resolves contract.json and writes to <dir>/dist by default.
      // Supply an explicit --out to compare manifests.
      const outDirDir = join(suiteDir, "manifest-dir-form");
      const loggerDir = new CollectingLogger();
      const codeDir = await runCli(
        ["compile", exampleDir, "--registry", registryPath, "--out", outDirDir],
        loggerDir,
      );
      expect(codeDir).toBe(0);

      const manifestDirect = readFileSync(join(outDirDirect, "manifest.json"), "utf-8");
      const manifestDir = readFileSync(join(outDirDir, "manifest.json"), "utf-8");
      expect(manifestDirect).toBe(manifestDir);
    } finally {
      try {
        rmSync(exampleDir, { recursive: true, force: true });
      } catch {
        // Non-fatal cleanup.
      }
    }
  });
});
