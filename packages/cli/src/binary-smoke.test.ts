/**
 * binary-smoke.test.ts — Three mandatory smoke tests for the yakcc pkg SEA binary.
 *
 * @decision DEC-DIST-PACKAGING-003
 * @title Binary smoke tests: --help, registry init, query in subprocess
 * @status accepted
 * @rationale
 *   The pkg SEA binary (`dist/yakcc-bin`) embeds the full runtime and native
 *   addons. It can silently differ from the source build in ways that only
 *   manifest at runtime: symlink resolution failures, missing native addons,
 *   snapshot path mismatches, or sharp stub omissions. These tests exercise
 *   the real binary in a child_process.execFileSync() call — the exact path
 *   a real user takes — and assert on exit codes and stdout, not internal
 *   module structure.
 *
 * Production sequence exercised (compound-interaction):
 *   1. Binary entry → patchSqliteDatabase() → runCli(["--help"]) → stdout
 *   2. Binary entry → patchSqliteDatabase() → runCli(["registry", "init"])
 *      → BetterSqlite3 opens db → loadExtension(vec0.so) via snapshot extract
 *   3. Binary entry → patchSqliteDatabase() → runCli(["query", "test"])
 *      → @xenova/transformers (sharp stub activated) → onnxruntime inference
 *      → sqlite-vec vector search → "no results found" (empty registry)
 *
 * Skip behaviour:
 *   Tests are skipped (not failed) when the binary has not been built. This
 *   allows `pnpm test` on source-only CI to pass without requiring a full
 *   pkg build. The binary is built by `pnpm --filter @yakcc/cli build:binary`
 *   which is a separate CI job (DEC-DIST-PACKAGING-001).
 *
 * Exit codes:
 *   0 — success (or "no results found" for query)
 *   Any non-zero exit causes execFileSync to throw; test fails with the error.
 *
 * Stderr:
 *   @xenova/transformers logs cache-write warnings to stderr when the model
 *   cache directory is not writable. These are non-fatal and suppressed in
 *   the test environment via { stdio: ["pipe", "pipe", "pipe"] }.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve the binary relative to the test file location.
// src/ → dist/yakcc-bin (packages/cli/dist/yakcc-bin)
const BINARY_PATH = resolve(__dirname, "..", "dist", "yakcc-bin");

// Track temp dirs for cleanup even on test failure.
const tempDirs: string[] = [];

afterEach(() => {
  // Clean up any temp dirs created in this test.
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (!d) break;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // non-fatal: temp cleanup is best-effort
    }
  }
});

/**
 * Returns a fresh temp dir and registers it for cleanup.
 */
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "yakcc-smoke-"));
  tempDirs.push(d);
  return d;
}

/**
 * Runs the binary with the given args and returns stdout as a string.
 * Throws (and fails the test) if the binary exits with a non-zero code.
 * Stderr is captured but not returned (only used for diagnostics on failure).
 */
function runBinary(args: string[]): string {
  const result = execFileSync(BINARY_PATH, args, {
    encoding: "utf8",
    timeout: 90_000, // model download can take up to 90s on cold cache
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result;
}

// Check at describe() time so vitest's skip propagates correctly.
const binaryExists = existsSync(BINARY_PATH);

describe.skipIf(!binaryExists)("yakcc pkg SEA binary smoke tests (DEC-DIST-PACKAGING-003)", () => {
  beforeAll(() => {
    // Log the resolved path for CI diagnostics.
    console.log(`[binary-smoke] binary path: ${BINARY_PATH}`);
  });

  it("--help exits 0 and prints usage header", () => {
    const stdout = runBinary(["--help"]);
    // The usage header is the canonical first line of output.
    expect(stdout).toContain("yakcc — content-addressed basic-block registry");
    // Verify at least the primary commands are listed.
    expect(stdout).toContain("registry init");
    expect(stdout).toContain("query");
    expect(stdout).toContain("seed");
  });

  it("registry init exits 0 and creates the SQLite file", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "registry.sqlite");
    const stdout = runBinary(["registry", "init", "--path", dbPath]);
    expect(stdout.trim()).toContain("registry initialized at");
    expect(existsSync(dbPath)).toBe(true);
  });

  it(
    'query "test" exits 0 against an empty registry (sharp stub + onnxruntime path)',
    { timeout: 120_000 }, // model download on cold cache
    () => {
      // This is the compound-interaction test. It exercises:
      //   binary startup → patchSqliteDatabase (vec0.so extraction)
      //   → @xenova/transformers load (sharp vfsLoadHook stub fires)
      //   → onnxruntime-node inference → sqlite-vec vector search
      // All of these cross internal component boundaries and validate that the
      // full SEA packaging works for the query command's production path.
      const dir = makeTempDir();
      const dbPath = join(dir, "registry.sqlite");
      // First init so the registry file exists (query requires it).
      runBinary(["registry", "init", "--path", dbPath]);
      const stdout = runBinary(["query", "test", "--registry", dbPath]);
      // An empty registry returns "no results found" — this is the expected
      // output for a query against a fresh, unseeded registry.
      expect(stdout.trim()).toContain("no results found");
    },
  );
});

// If the binary doesn't exist, emit a clear message rather than a silent skip.
if (!binaryExists) {
  console.warn(
    `[binary-smoke] SKIP: binary not found at ${BINARY_PATH}. Run \`pnpm --filter @yakcc/cli build:binary\` to build it.`,
  );
}
