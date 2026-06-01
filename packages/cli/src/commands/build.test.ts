// SPDX-License-Identifier: MIT
//
// build.test.ts — integration tests for `yakcc build` (#1045, epic #1043 [2/6])
//
// Evaluation Contract requirements covered:
//   EC-1: fixture project with .yakcc/manifest.json referencing a real seed atom
//         materializes .yakcc/atoms/<alias>.ts containing the assembled source.
//   EC-2: Oracle check — the materialized module is runnable and CORRECT.
//         Import/execute the assembled asciiChar and assert known property-test vectors
//         (from packages/seeds/src/blocks/ascii-char/proof/tests.fast-check.ts):
//           asciiChar('abc', 0) === 'a'
//           asciiChar('abc', 1) === 'b'
//           asciiChar('abc', 3) throws RangeError
//   EC-3: Determinism/idempotency — running build twice yields byte-identical output.
//   EC-4: Missing manifest → returns non-zero with a clear error message.
//   EC-5: Compound-interaction test: the full production sequence crosses
//         openRegistry → seedRegistry → assemble → writeFile → dynamic import.
//
// Root derivation: the ascii-char BlockMerkleRoot is derived at suite init via
// parseBlockTriplet() on the canonical seed block directory, NOT hardcoded.
// This makes the test drift-proof: the root in the manifest always matches what
// seedRegistry() stores, so assemble() can always resolve it.
//
// @decision DEC-COMPOSE-BY-REF-BUILD-001
// @title build.test.ts exercises the real production sequence end-to-end
// @status accepted (#1045)
// @rationale
//   Sacred Practice #5: real execution over mocks. The test opens a live registry,
//   seeds it, runs build(), reads the written file, dynamically imports it via tsx,
//   and asserts correct oracle output. This is the same sequence a real project runs.
//   The root is derived via parseBlockTriplet() — identical to what seedRegistry() stores
//   — so assemble() can always resolve it without hardcoded constants that drift.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  addReference,
  emptyManifest,
  materializedModulePath,
  serializeProjectManifest,
} from "@yakcc/compile";
import type { BlockMerkleRoot } from "@yakcc/compile";
import { createOfflineEmbeddingProvider } from "@yakcc/contracts";
import { parseBlockTriplet } from "@yakcc/ir";
import { openRegistry } from "@yakcc/registry";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { build } from "./build.js";

// ---------------------------------------------------------------------------
// Offline embedding provider — prevents any network call in tests.
// ---------------------------------------------------------------------------

const offlineEmbeddings = createOfflineEmbeddingProvider();

// ---------------------------------------------------------------------------
// Derive the real ascii-char BlockMerkleRoot from the seed block directory.
//
// parseBlockTriplet() is synchronous and reads the same triplet files that
// seedRegistry() stores. This root IS resolvable by assemble() after seeding.
// We must NOT hardcode the root: bootstrap/expected-roots.json is a large
// bootstrap corpus that is NOT what seedRegistry() loads.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path: packages/cli/src/commands/ → up 4 levels to worktree root → packages/seeds/src/blocks/ascii-char
const ASCII_CHAR_BLOCK_DIR = join(__dirname, "../../../../packages/seeds/src/blocks/ascii-char");

const asciiCharTriplet = parseBlockTriplet(ASCII_CHAR_BLOCK_DIR);
const ASCII_CHAR_ROOT: BlockMerkleRoot = asciiCharTriplet.merkleRoot;
// Alias is the 12-char prefix of the root (DEFAULT_ALIAS_LENGTH from project-manifest.ts).
const ASCII_CHAR_ALIAS = ASCII_CHAR_ROOT.slice(0, 12);

// ---------------------------------------------------------------------------
// Suite lifecycle — temp project dir per test.
// ---------------------------------------------------------------------------

let suiteDir: string;
let projectRoot: string;
let registryPath: string;

beforeEach(async () => {
  const tmpBase = join(__dirname, "../../../../tmp");
  mkdirSync(tmpBase, { recursive: true });
  suiteDir = mkdtempSync(
    join(
      // Use project-local tmp/ to avoid /tmp litter (Sacred Practice #3).
      // Four ../ from packages/cli/src/commands reaches the worktree root.
      tmpBase,
      "yakcc-build-test-",
    ),
  );
  projectRoot = join(suiteDir, "project");
  registryPath = join(suiteDir, "registry.sqlite");

  // Create the project structure with a valid manifest built from the
  // dynamically derived root (never hardcoded, always drift-proof).
  await mkdir(join(projectRoot, ".yakcc"), { recursive: true });

  const { manifest } = addReference(emptyManifest(), {
    root: ASCII_CHAR_ROOT,
    symbol: "asciiChar",
  });
  writeFileSync(
    join(projectRoot, ".yakcc", "manifest.json"),
    serializeProjectManifest(manifest),
    "utf-8",
  );

  // Initialize the registry so openRegistry inside build() can find it.
  const reg = await openRegistry(registryPath, { embeddings: offlineEmbeddings });
  await reg.close();
});

afterEach(() => {
  try {
    rmSync(suiteDir, { recursive: true, force: true });
  } catch {
    // Non-fatal cleanup failure.
  }
});

// ---------------------------------------------------------------------------
// EC-4: Missing manifest → non-zero with clear error.
// ---------------------------------------------------------------------------

describe("build — EC-4: missing manifest", () => {
  it("returns exit code 1 when manifest is missing", async () => {
    const logger = new CollectingLogger();
    const emptyProjectRoot = join(suiteDir, "empty-project");
    await mkdir(emptyProjectRoot, { recursive: true });

    const code = await build(["--registry", registryPath, emptyProjectRoot], logger, {
      embeddings: offlineEmbeddings,
    });

    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("manifest not found");
  });

  it("returns exit code 1 when manifest JSON is invalid", async () => {
    const badProjectRoot = join(suiteDir, "bad-manifest-project");
    await mkdir(join(badProjectRoot, ".yakcc"), { recursive: true });
    writeFileSync(join(badProjectRoot, ".yakcc", "manifest.json"), "{ bad json }", "utf-8");

    const logger = new CollectingLogger();
    const code = await build(["--registry", registryPath, badProjectRoot], logger, {
      embeddings: offlineEmbeddings,
    });

    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("invalid manifest");
  });
});

// ---------------------------------------------------------------------------
// EC-1 + EC-3 + EC-4: materialization + idempotency.
// These run only when the seed corpus is present (registry can be seeded).
// ---------------------------------------------------------------------------

describe("build — EC-1/EC-3: materialize + idempotency", () => {
  it("materializes .yakcc/atoms/<alias>.ts for each manifest reference", async () => {
    const logger = new CollectingLogger();
    const code = await build(["--registry", registryPath, projectRoot], logger, {
      embeddings: offlineEmbeddings,
    });

    expect(code).toBe(0);

    const expectedPath = join(projectRoot, materializedModulePath(ASCII_CHAR_ALIAS));
    expect(existsSync(expectedPath)).toBe(true);

    const source = readFileSync(expectedPath, "utf-8");
    expect(source.length).toBeGreaterThan(0);
    // The assembled source must contain the exported function.
    expect(source).toContain("export");
    expect(source).toContain("function");

    // Log line must announce materialization.
    const logOut = logger.logLines.join("\n");
    expect(logOut).toContain("materialized");
    expect(logOut).toContain(".yakcc/atoms/");
  }, 60_000);

  it("idempotent: running build twice yields byte-identical .yakcc/atoms/<alias>.ts", async () => {
    const logger1 = new CollectingLogger();
    const code1 = await build(["--registry", registryPath, projectRoot], logger1, {
      embeddings: offlineEmbeddings,
    });
    expect(code1).toBe(0);

    const atomPath = join(projectRoot, materializedModulePath(ASCII_CHAR_ALIAS));
    const firstRun = readFileSync(atomPath, "utf-8");

    const logger2 = new CollectingLogger();
    const code2 = await build(["--registry", registryPath, projectRoot], logger2, {
      embeddings: offlineEmbeddings,
    });
    expect(code2).toBe(0);

    const secondRun = readFileSync(atomPath, "utf-8");
    expect(secondRun).toBe(firstRun);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// EC-2: Oracle check — materialized module executes correctly.
//
// The atom at ASCII_CHAR_ROOT is the ascii-char block (asciiChar function).
// We verify known property-test vectors from the block's proof/:
//   ascii-char-first:   asciiChar('abc', 0) === 'a'
//   ascii-char-middle:  asciiChar('abc', 1) === 'b'
//   ascii-char-oob:     asciiChar('abc', 3) throws RangeError
//
// Strategy: assemble() → compiled TypeScript source → transpile to JS via
// typescript.transpileModule() → write to temp file → dynamic import.
// This is the same pattern used by assemble.test.ts (Sacred Practice #5).
// ---------------------------------------------------------------------------

describe("build — EC-2: oracle check (materialized module executes correctly)", () => {
  it("materialized asciiChar passes known property-test vectors from ascii-char spec", async () => {
    // Run build to materialize the atom.
    const logger = new CollectingLogger();
    const code = await build(["--registry", registryPath, projectRoot], logger, {
      embeddings: offlineEmbeddings,
    });
    expect(code).toBe(0);

    // Read the materialized TypeScript source.
    const atomPath = join(projectRoot, materializedModulePath(ASCII_CHAR_ALIAS));
    const tsSource = readFileSync(atomPath, "utf-8");
    expect(tsSource.length).toBeGreaterThan(0);

    // Transpile TypeScript → JavaScript using the compiler API (no tsc binary needed).
    // This is the canonical runtime-validation approach used by assemble.test.ts.
    const jsResult = ts.transpileModule(tsSource, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
      },
    });
    const jsSource = jsResult.outputText;

    // Write JS to a temp file and dynamically import it.
    const jsPath = join(suiteDir, "oracle-module.mjs");
    writeFileSync(jsPath, jsSource, "utf-8");
    const mod = await import(pathToFileURL(jsPath).toString());

    // The assembled module must export the asciiChar function.
    // The export name is what assemble() produces from the seed block.
    const fn = mod.asciiChar as ((input: string, position: number) => string) | undefined;
    expect(typeof fn).toBe("function");

    // Oracle vectors from packages/seeds/src/blocks/ascii-char/proof/tests.fast-check.ts
    // Property ID ascii-char-first: asciiChar('abc', 0) === 'a'
    // Rationale: block spec guarantee "length-1" + first character of 'abc' is 'a'.
    expect(fn?.("abc", 0)).toBe("a");

    // Property ID ascii-char-middle: asciiChar('abc', 1) === 'b'
    expect(fn?.("abc", 1)).toBe("b");

    // Property ID ascii-char-oob: asciiChar('abc', 3) throws RangeError
    // (position 3 is out of bounds for a 3-char string)
    expect(() => fn?.("abc", 3)).toThrow(RangeError);
  }, 60_000);

  it("materialized source text equals direct assemble() output (source-level oracle)", async () => {
    // Complementary oracle: the file content must equal what assemble() produces
    // directly, independent of the file system write path.
    // This verifies the build command does not transform or corrupt the source.
    const { assemble } = await import("@yakcc/compile");
    const { seedRegistry } = await import("@yakcc/seeds");

    const reg = await openRegistry(registryPath, { embeddings: offlineEmbeddings });
    let directSource: string;
    try {
      const seedResult = await seedRegistry(reg);
      const artifact = await assemble(ASCII_CHAR_ROOT, reg, undefined, {
        knownMerkleRoots: seedResult.merkleRoots,
      });
      directSource = artifact.source;
    } finally {
      await reg.close();
    }

    // Now run build and compare.
    const logger = new CollectingLogger();
    const code = await build(["--registry", registryPath, projectRoot], logger, {
      embeddings: offlineEmbeddings,
    });
    expect(code).toBe(0);

    const atomPath = join(projectRoot, materializedModulePath(ASCII_CHAR_ALIAS));
    const materializedSource = readFileSync(atomPath, "utf-8");
    expect(materializedSource).toBe(directSource);
  }, 60_000);
});
