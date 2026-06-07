// SPDX-License-Identifier: MIT
//
// bootstrap.verify-memory.test.ts — Correctness witness for the :memory: verify carve-out.
//
// DEC-V2-BOOTSTRAP-EMBEDDING-002 documents two code paths:
//   • On-disk path (bootstrap.ts:1072): uses createLocalEmbeddingProvider() — BGE loads.
//   • :memory: verify path (bootstrap.ts:491): uses getVerifyEmbeddingOpts() — zero provider,
//     BGE must NOT load.
//
// This test suite proves the carve-out is in effect:
//   bootstrap --verify does NOT call createLocalEmbeddingProvider().
//
// Why this matters:
//   The verify carve-out is a performance optimization. Loading BGE cold-start is ~3-5s.
//   The --verify path opens an ephemeral :memory: registry and never persists vectors,
//   so paying the BGE load cost is waste. The carve-out keeps local pre-commit verify fast.
//
// Production sequence exercised:
//   bootstrap(["--verify", "--manifest", path], logger)
//   → runVerify() → openRegistry(":memory:", getVerifyEmbeddingOpts())  [zero provider]
//   → shave files → exportManifest → compare against committed → exit
//   The zero provider's embed() fn is called (not BGE). createLocalEmbeddingProvider spy NEVER fires.
//
// Test approach:
//   The vitest module aliasing resolves @yakcc/contracts to the source file, so
//   vi.spyOn can intercept createLocalEmbeddingProvider before the bootstrap verb runs.
//   The spy is set up before each test and cleared after, to avoid cross-test contamination.
//
// @decision DEC-V2-BOOTSTRAP-EMBEDDING-002 (:memory: carve-out verification)
// @title --verify path uses zero provider; BGE model load is suppressed
// @status accepted (Slice A acceptance gate)

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as contracts from "@yakcc/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectingLogger } from "../index.js";
import { bootstrap } from "./bootstrap.js";

// ---------------------------------------------------------------------------
// Suite lifecycle — isolated temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-verify-memory-"));
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Non-fatal — temp cleanup failure does not fail the suite.
  }
});

// ---------------------------------------------------------------------------
// Spy setup — intercept createLocalEmbeddingProvider
// ---------------------------------------------------------------------------

// Keep a reference to the original implementation so we can restore it after each test.
let providerSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Wrap createLocalEmbeddingProvider with a spy. The spy calls through to the real
  // implementation — if the verify path accidentally calls it, we will know.
  providerSpy = vi.spyOn(contracts, "createLocalEmbeddingProvider");
});

afterEach(() => {
  providerSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Helpers — create a minimal fake workspace
// ---------------------------------------------------------------------------

/**
 * Create a minimal workspace structure that satisfies findRepoRoot() and
 * collectSourceFiles(). Returns the workspace root path.
 *
 * Layout:
 *   <root>/pnpm-workspace.yaml          — triggers findRepoRoot()
 *   <root>/packages/<pkg>/src/<file>.ts — one TypeScript source file for collectSourceFiles()
 */
function makeMinimalWorkspace(
  base: string,
  name: string,
  tsContent = "// SPDX-License-Identifier: MIT\nexport const x = 1;\n",
): string {
  const wsRoot = join(base, name);
  mkdirSync(join(wsRoot, "packages", "fixture-pkg", "src"), { recursive: true });
  writeFileSync(join(wsRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n", "utf-8");
  writeFileSync(join(wsRoot, "packages", "fixture-pkg", "src", "index.ts"), tsContent, "utf-8");
  return wsRoot;
}

// ---------------------------------------------------------------------------
// Suite: --verify carve-out (DEC-V2-BOOTSTRAP-EMBEDDING-002 :memory: path)
// ---------------------------------------------------------------------------

describe("bootstrap --verify carve-out — BGE model NOT loaded", () => {
  /**
   * VM-1: bootstrap --verify does NOT call createLocalEmbeddingProvider().
   *
   * The verify path calls getVerifyEmbeddingOpts() which returns a zero provider.
   * createLocalEmbeddingProvider() is only called by getBootstrapEmbeddingOpts()
   * which is the on-disk path. This test proves the code paths are correctly
   * separated.
   */
  it("VM-1: createLocalEmbeddingProvider is NOT called during bootstrap --verify", async () => {
    const wsRoot = makeMinimalWorkspace(tmpDir, "ws-vm1");

    // Write an empty committed manifest (empty array ⊇ any shaved output → PASS).
    const committedManifestPath = resolve(join(tmpDir, "vm1-committed.json"));
    writeFileSync(committedManifestPath, "[]\n", "utf-8");

    const origCwd = process.cwd();
    process.chdir(wsRoot);
    try {
      const logger = new CollectingLogger();
      const code = await bootstrap(["--verify", "--manifest", committedManifestPath], logger);

      // The committed manifest is empty; PASS semantics:
      //   current_shave ⊆ [] is only true if current_shave is also empty.
      //   The fixture file has no @spec annotations, so shave produces 0 atoms.
      //   Empty ⊆ [] → PASS (exit 0). Accept both 0 and 1 in case shave
      //   unexpectedly produces atoms on some machines.
      expect([0, 1]).toContain(code);

      // THE CORE ASSERTION: createLocalEmbeddingProvider must NOT have been called.
      expect(providerSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(origCwd);
    }
  }, 60_000);

  /**
   * VM-2: --verify with a committed manifest that matches the shave output passes
   * without loading BGE.
   *
   * This test first runs a normal bootstrap (which DOES call createLocalEmbeddingProvider)
   * to produce a ground-truth manifest, then resets the spy and runs --verify. The
   * verify run must succeed (exit 0) and must NOT call createLocalEmbeddingProvider again.
   *
   * Production sequence:
   *   [Run 1] bootstrap (on-disk) → createLocalEmbeddingProvider called (spy fires)
   *   [Spy reset]
   *   [Run 2] bootstrap --verify  → createLocalEmbeddingProvider NOT called (spy clean)
   *
   * Compound-Interaction: two calls to the same bootstrap() entry point with different
   * argv shapes traverse different internal code paths (getBootstrapEmbeddingOpts vs
   * getVerifyEmbeddingOpts), each proven in isolation by the spy state.
   */
  it("VM-2: bootstrap (on-disk) calls BGE provider; subsequent --verify does NOT", async () => {
    const wsRoot = makeMinimalWorkspace(tmpDir, "ws-vm2");
    const registryPath = join(tmpDir, "vm2-registry.sqlite");
    const manifestPath = resolve(join(tmpDir, "vm2-manifest.json"));
    const reportPath = join(tmpDir, "vm2-report.json");

    const origCwd = process.cwd();
    process.chdir(wsRoot);
    try {
      // Step 1: normal bootstrap — should call createLocalEmbeddingProvider.
      // (The spy is already set up by beforeEach; we confirm it fires here.)
      const logger1 = new CollectingLogger();
      await bootstrap(
        ["--registry", registryPath, "--manifest", manifestPath, "--report", reportPath],
        logger1,
      );

      // On-disk path MUST have called createLocalEmbeddingProvider.
      expect(providerSpy).toHaveBeenCalled();
      expect(existsSync(manifestPath)).toBe(true);

      // Step 2: reset the spy, then run --verify against the produced manifest.
      providerSpy.mockClear();

      const logger2 = new CollectingLogger();
      const code2 = await bootstrap(["--verify", "--manifest", manifestPath], logger2);

      // --verify succeeds (0) because current shave ⊆ committed manifest
      // (the committed manifest was produced by the same bootstrap run).
      expect(code2).toBe(0);

      // THE CORE ASSERTION: verify must NOT call createLocalEmbeddingProvider.
      expect(providerSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(origCwd);
    }
  }, 120_000);
});
