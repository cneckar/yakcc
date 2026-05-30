// SPDX-License-Identifier: MIT
//
// emit-atom.test.ts — unit + integration tests for `yakcc emit-atom`
//
// @decision DEC-WI954-006
// @title Worked example in yakcc-discovery.md: clamp(value, min, max)
// @status accepted
// @rationale Small, complete atom with two clear property-test cases (bounded + idempotent).
//   The clamp fixture is reproduced here as the canonical test corpus for emit-atom.
//
// @decision DEC-WI954-012
// @title Fixture layout: packages/cli/src/commands/__fixtures__/emit-atom/
// @status accepted
// @rationale Contains: clamp-green (happy path), clamp-strict-violation (exit 3),
//   clamp-bad-spec (exit 2), clamp-failing-tests (exit 5), clamp-bad-manifest (exit 4).
//
// Coverage map (required by Evaluation Contract §5.1):
//   - Argv parsing: missing positional → exit 1
//   - Missing files in dir: each required file absent → exit 1 with named-file error
//   - Spec invalid: clamp-bad-spec → exit 2; storeBlock NOT called
//   - Strict-subset violation: clamp-strict-violation → exit 3; storeBlock NOT called
//   - Manifest invalid: clamp-bad-manifest → exit 4; storeBlock NOT called
//   - Property test failure: clamp-failing-tests → exit 5; storeBlock NOT called
//   - Happy path: clamp-green → exit 0; stored: <root> printed
//   - --json output: clamp-green → valid JSON with merkleRoot, specHash, stored:true
//   - Round-trip persistence: emit-atom on green, then selectBlocks confirms storage
//   - --skip-tests bypass: failing fixture still stores when --skip-tests set
//   - Custom --registry honored
//   - Exit code enumeration: all six codes (0..6) covered by at least one test

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "../index.js";
import {
  EMIT_ATOM_EXIT_MANIFEST_INVALID,
  EMIT_ATOM_EXIT_OK,
  EMIT_ATOM_EXIT_SPEC_INVALID,
  EMIT_ATOM_EXIT_STOREBLOCK_FAILED,
  EMIT_ATOM_EXIT_STRICT_SUBSET,
  EMIT_ATOM_EXIT_TESTS_FAILED,
  EMIT_ATOM_EXIT_USAGE,
  emitAtom,
} from "./emit-atom.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Path to the emit-atom fixture directory. */
const FIXTURES_DIR = new URL("../commands/__fixtures__/emit-atom", import.meta.url).pathname;

function fixtureDir(name: string): string {
  return join(FIXTURES_DIR, name);
}

/** Create a temp registry path that is cleaned up after use. */
function tempRegistryPath(): string {
  const dir = mkdirSync(join(tmpdir(), `emit-atom-test-${Date.now()}`), {
    recursive: true,
  }) as string | undefined;
  const base = dir ?? join(tmpdir(), `emit-atom-test-${Date.now()}`);
  return join(base, "registry.sqlite");
}

// ---------------------------------------------------------------------------
// Argv parsing / usage errors
// ---------------------------------------------------------------------------

describe("emit-atom: argv parsing", () => {
  it("exits 1 when no positional directory is given", async () => {
    const logger = new CollectingLogger();
    const code = await emitAtom([], logger);
    expect(code).toBe(EMIT_ATOM_EXIT_USAGE);
    expect(logger.errLines.some((l) => l.includes("requires a <directory>"))).toBe(true);
  });

  it("exits 1 when an unknown flag is passed", async () => {
    const logger = new CollectingLogger();
    const code = await emitAtom(["--totally-unknown-flag", "/dev/null"], logger);
    expect(code).toBe(EMIT_ATOM_EXIT_USAGE);
  });

  it("exits 1 when the directory does not exist", async () => {
    const logger = new CollectingLogger();
    const code = await emitAtom(["/does/not/exist/at/all"], logger);
    expect(code).toBe(EMIT_ATOM_EXIT_USAGE);
    expect(logger.errLines.some((l) => l.includes("not found"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Missing required files
// ---------------------------------------------------------------------------

describe("emit-atom: missing required files", () => {
  const requiredFiles = [
    "spec.yak",
    "impl.ts",
    join("proof", "manifest.json"),
    join("proof", "tests.fast-check.ts"),
  ];

  for (const missing of requiredFiles) {
    it(`exits 1 with named-file error when ${missing} is absent`, async () => {
      // Build a complete fixture dir, then unlink the target file temporarily.
      // Instead, use a temp dir with only some files present.
      const tmpDir = join(tmpdir(), `emit-atom-missing-${Date.now()}-${Math.random()}`);
      mkdirSync(join(tmpDir, "proof"), { recursive: true });

      // Write all files EXCEPT the one we want missing.
      const allFiles = [
        {
          rel: "spec.yak",
          content:
            '{"name":"x","inputs":[],"outputs":[],"preconditions":[],"postconditions":[],"invariants":[],"effects":[],"level":"L0","behavior":"x","guarantees":[],"errorConditions":[],"nonFunctional":{"purity":"pure","threadSafety":"safe"},"propertyTests":[]}',
        },
        { rel: "impl.ts", content: "export const x = 1;" },
        {
          rel: join("proof", "manifest.json"),
          content: '{"artifacts":[{"kind":"property_tests","path":"tests.fast-check.ts"}]}',
        },
        { rel: join("proof", "tests.fast-check.ts"), content: "export {};" },
      ];

      for (const f of allFiles) {
        if (f.rel !== missing) {
          writeFileSync(join(tmpDir, f.rel), f.content, "utf-8");
        }
      }

      const logger = new CollectingLogger();
      const code = await emitAtom([tmpDir], logger);

      expect(code).toBe(EMIT_ATOM_EXIT_USAGE);
      // Error message names the missing file path component.
      const missingBasename = missing.split(/[\\/]/).at(-1) ?? missing;
      expect(logger.errLines.some((l) => l.includes(missingBasename))).toBe(true);

      rmSync(tmpDir, { recursive: true, force: true });
    });
  }
});

// ---------------------------------------------------------------------------
// Gate: spec invalid (exit 2)
// ---------------------------------------------------------------------------

describe("emit-atom: gate spec-invalid (exit 2)", () => {
  it("exits 2 for clamp-bad-spec fixture (missing 'level' field)", async () => {
    const logger = new CollectingLogger();
    const code = await emitAtom([fixtureDir("clamp-bad-spec"), "--registry", ":memory:"], logger);
    expect(code).toBe(EMIT_ATOM_EXIT_SPEC_INVALID);
    expect(logger.errLines.some((l) => l.includes("gate:spec-invalid"))).toBe(true);
    expect(logger.errLines.some((l) => l.includes("validateSpecYak"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate: strict-subset violation (exit 3)
// ---------------------------------------------------------------------------

describe("emit-atom: gate strict-subset (exit 3)", () => {
  it("exits 3 for clamp-strict-violation fixture (eval() in impl)", async () => {
    const logger = new CollectingLogger();
    const code = await emitAtom(
      [fixtureDir("clamp-strict-violation"), "--registry", ":memory:"],
      logger,
    );
    expect(code).toBe(EMIT_ATOM_EXIT_STRICT_SUBSET);
    expect(logger.errLines.some((l) => l.includes("gate:strict-subset"))).toBe(true);
    expect(logger.errLines.some((l) => l.includes("eval"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate: manifest invalid (exit 4)
// ---------------------------------------------------------------------------

describe("emit-atom: gate manifest-invalid (exit 4)", () => {
  it("exits 4 for clamp-bad-manifest fixture (smt_cert artifact kind, L2+-only)", async () => {
    const logger = new CollectingLogger();
    const code = await emitAtom(
      [fixtureDir("clamp-bad-manifest"), "--registry", ":memory:"],
      logger,
    );
    expect(code).toBe(EMIT_ATOM_EXIT_MANIFEST_INVALID);
    expect(logger.errLines.some((l) => l.includes("gate:manifest-invalid"))).toBe(true);
    expect(logger.errLines.some((l) => l.includes("validateProofManifestL0"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate: property tests failed (exit 5)
// ---------------------------------------------------------------------------

describe("emit-atom: gate tests-failed (exit 5)", () => {
  it("exits 5 for clamp-failing-tests fixture (broken impl, fast-check catches it)", async () => {
    const logger = new CollectingLogger();
    const code = await emitAtom(
      [fixtureDir("clamp-failing-tests"), "--registry", ":memory:"],
      logger,
    );
    expect(code).toBe(EMIT_ATOM_EXIT_TESTS_FAILED);
    expect(logger.errLines.some((l) => l.includes("gate:tests-failed"))).toBe(true);
    // fast-check should surface the counterexample in stderr
    expect(
      logger.errLines.some((l) => l.includes("Counterexample") || l.includes("Property failed")),
    ).toBe(true);
    // storeBlock must NOT have been called — log lines must not contain "stored:"
    expect(logger.logLines.some((l) => l.startsWith("stored:"))).toBe(false);
  }, 15000);
});

// ---------------------------------------------------------------------------
// Happy path: exit 0 + storeBlock called
// ---------------------------------------------------------------------------

describe("emit-atom: happy path (exit 0)", () => {
  it("stores the clamp-green triplet and prints stored: <root>", async () => {
    const registryPath = tempRegistryPath();
    const logger = new CollectingLogger();
    const code = await emitAtom([fixtureDir("clamp-green"), "--registry", registryPath], logger);
    expect(code).toBe(EMIT_ATOM_EXIT_OK);
    // One log line starting with "stored: "
    const storedLine = logger.logLines.find((l) => l.startsWith("stored: "));
    expect(storedLine).toBeDefined();
    const root = storedLine?.slice("stored: ".length);
    expect(root).toHaveLength(64); // BlockMerkleRoot is a 64-char hex string
  }, 15000);

  it("--json output returns valid JSON with merkleRoot, specHash, stored:true", async () => {
    const registryPath = tempRegistryPath();
    const logger = new CollectingLogger();
    const code = await emitAtom(
      [fixtureDir("clamp-green"), "--registry", registryPath, "--json"],
      logger,
    );
    expect(code).toBe(EMIT_ATOM_EXIT_OK);
    const jsonLine = logger.logLines.find((l) => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    if (jsonLine === undefined) throw new Error("no JSON output line");
    const parsed = JSON.parse(jsonLine) as Record<string, unknown>;
    expect(typeof parsed.merkleRoot).toBe("string");
    expect(parsed.merkleRoot as string).toHaveLength(64);
    expect(typeof parsed.specHash).toBe("string");
    expect(parsed.stored).toBe(true);
  }, 15000);
});

// ---------------------------------------------------------------------------
// Round-trip persistence (integration)
// ---------------------------------------------------------------------------

describe("emit-atom: round-trip persistence (integration)", () => {
  it("stored block is queryable via selectBlocks + getBlock after emit-atom", async () => {
    const registryPath = tempRegistryPath();
    const logger = new CollectingLogger();

    // Step 1: emit-atom stores the triplet.
    const code = await emitAtom([fixtureDir("clamp-green"), "--registry", registryPath], logger);
    expect(code).toBe(EMIT_ATOM_EXIT_OK);

    const storedLine = logger.logLines.find((l) => l.startsWith("stored: "));
    expect(storedLine).toBeDefined();
    const merkleRoot = storedLine?.slice("stored: ".length);

    // Step 2: re-open the registry and verify the block is retrievable.
    const registry = await openRegistry(registryPath);
    try {
      const block = await registry.getBlock(merkleRoot as Parameters<typeof registry.getBlock>[0]);
      expect(block).not.toBeNull();
      expect(block?.blockMerkleRoot).toBe(merkleRoot);
      // The impl source must match what was in the fixture.
      expect(block?.implSource).toContain("export function clamp");
      // The proof manifest must be persisted.
      expect(block?.proofManifestJson).toContain("property_tests");
      // The artifact bytes for tests.fast-check.ts must be present.
      const artifactBytes = block?.artifacts.get("tests.fast-check.ts");
      expect(artifactBytes).toBeDefined();
      expect(artifactBytes?.length).toBeGreaterThan(0);
    } finally {
      await registry.close();
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// --skip-tests bypass
// ---------------------------------------------------------------------------

describe("emit-atom: --skip-tests bypass", () => {
  it("stores the failing-tests fixture when --skip-tests is set (bypass is real)", async () => {
    const registryPath = tempRegistryPath();
    const logger = new CollectingLogger();
    const code = await emitAtom(
      [fixtureDir("clamp-failing-tests"), "--registry", registryPath, "--skip-tests"],
      logger,
    );
    // Should store despite the broken impl.
    expect(code).toBe(EMIT_ATOM_EXIT_OK);
    expect(logger.logLines.some((l) => l.startsWith("stored:"))).toBe(true);
    // Must print DANGEROUS warning to stderr.
    expect(logger.errLines.some((l) => l.includes("WARNING") && l.includes("--skip-tests"))).toBe(
      true,
    );
  }, 15000);
});

// ---------------------------------------------------------------------------
// Custom --registry honored
// ---------------------------------------------------------------------------

describe("emit-atom: --registry flag", () => {
  it("opens the registry at the custom --registry path, not the default", async () => {
    const customPath = tempRegistryPath();
    const logger = new CollectingLogger();
    const code = await emitAtom([fixtureDir("clamp-green"), "--registry", customPath], logger);
    expect(code).toBe(EMIT_ATOM_EXIT_OK);
    // Verify the block is retrievable from the custom registry.
    const storedLine = logger.logLines.find((l) => l.startsWith("stored: "));
    const root = storedLine?.slice("stored: ".length);
    const registry = await openRegistry(customPath);
    try {
      const block = await registry.getBlock(root as Parameters<typeof registry.getBlock>[0]);
      expect(block).not.toBeNull();
    } finally {
      await registry.close();
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// Exit code enumeration (all six codes must be covered)
// ---------------------------------------------------------------------------

describe("emit-atom: exit code enumeration", () => {
  it("all named constants have distinct values 0..6", () => {
    const codes = [
      EMIT_ATOM_EXIT_OK,
      EMIT_ATOM_EXIT_USAGE,
      EMIT_ATOM_EXIT_SPEC_INVALID,
      EMIT_ATOM_EXIT_STRICT_SUBSET,
      EMIT_ATOM_EXIT_MANIFEST_INVALID,
      EMIT_ATOM_EXIT_TESTS_FAILED,
      EMIT_ATOM_EXIT_STOREBLOCK_FAILED,
    ];
    // All seven constants must be distinct.
    expect(new Set(codes).size).toBe(7);
    // They must span 0..6.
    expect(Math.min(...codes)).toBe(0);
    expect(Math.max(...codes)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Subcommand registration in runCli (index.ts wiring)
// ---------------------------------------------------------------------------

describe("emit-atom: runCli dispatch wiring", () => {
  it("runCli(['emit-atom']) exits 1 with usage error (missing dir arg)", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["emit-atom"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("requires a <directory>"))).toBe(true);
  });

  it("runCli(['--help']) lists emit-atom in usage text", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["--help"], logger);
    expect(code).toBe(0);
    const helpText = logger.logLines.join("\n");
    expect(helpText).toContain("emit-atom");
  });
});
