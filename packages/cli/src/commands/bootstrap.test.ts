// SPDX-License-Identifier: MIT
//
// Tests for packages/cli/src/commands/bootstrap.ts.
//
// Test strategy:
//   - collectSourceFiles: unit-tested against the bootstrap-mini fixture, which
//     has a proper packages/mini/src/ subtree and various should-skip paths.
//   - bootstrap() (CLI entry): integration-tested against the same fixture via
//     --root, --registry, --report, --manifest argv. This exercises the real
//     production sequence: walk → openRegistry → shave → write artifacts.
//
// The shave pass may produce "failed" outcomes on the simple fixture functions
// (e.g. IntentCardSchemaError), which is a shave-layer concern, not a CLI
// concern. Tests assert on artifact existence and report shape, not on
// shaved > 0 specifically.
//
// @decision DEC-V2-BOOT-TEST-001
// title: Test bootstrap CLI surface via bootstrap() entry point, not runBootstrapPass directly
// status: accepted (WI-V2-BOOTSTRAP-02)
// rationale:
//   runBootstrapPass takes an open Registry, not a path. Testing it directly
//   would require re-implementing the registry lifecycle that bootstrap() owns.
//   Testing via bootstrap() with --root/--registry/--report/--manifest argv
//   exercises the true production sequence (walk → openRegistry → shave →
//   write) and exercises the same code path that bin.ts invokes.

import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSourceFiles, bootstrap } from "./bootstrap.js";
import type { BootstrapReport } from "./bootstrap.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// bootstrap-mini is a self-contained project fixture rooted at:
//   packages/cli/src/__fixtures__/bootstrap-mini/
// It contains packages/mini/src/{add.ts, greet.ts, add.test.ts} and various
// should-skip paths at root level (src/__fixtures__, src/__tests__, src/*.test.ts).
const FIXTURE_ROOT = join(HERE, "..", "__fixtures__", "bootstrap-mini");

// Null logger — silences bootstrap progress output during tests.
const NULL_LOGGER = { log: () => {}, error: () => {} };

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yakcc-boot-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// collectSourceFiles — file-walker unit tests
// ---------------------------------------------------------------------------

describe("collectSourceFiles", () => {
  it("includes shaveable .ts files under packages/*/src and excludes test/fixture/skipped paths", async () => {
    const files = await collectSourceFiles(FIXTURE_ROOT);
    const basenames = files.map((f) => f.split("/").pop()!).sort();

    // bootstrap-mini/packages/mini/src/add.ts and greet.ts must be included.
    expect(basenames).toContain("add.ts");
    expect(basenames).toContain("greet.ts");

    // add.test.ts must be excluded (matches .test.ts suffix).
    expect(basenames).not.toContain("add.test.ts");

    // dummy.ts files under __tests__ or __fixtures__ must be excluded
    // (SKIP_DIR_SEGMENTS blocks those directory names anywhere in the tree).
    expect(basenames.filter((b) => b === "dummy.ts")).toHaveLength(0);
  });

  it("returns files in lex-sorted absolute-path order", async () => {
    const files = await collectSourceFiles(FIXTURE_ROOT);
    const sorted = [...files].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "variant" }),
    );
    expect(files).toEqual(sorted);
  });

  it("returns an empty array for a root with no packages/ or examples/ directories", async () => {
    // Use HERE (the commands/ directory) — it has no packages/ sub-directory.
    const files = await collectSourceFiles(HERE);
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// bootstrap() — CLI integration tests (real production sequence)
// ---------------------------------------------------------------------------

describe("bootstrap() — happy path", () => {
  it("writes report.json and manifest.json and returns exit code 0 or 1", async () => {
    const tempDir = makeTempDir();
    const registryPath = join(tempDir, "registry.sqlite");
    const reportPath = join(tempDir, "report.json");
    const manifestPath = join(tempDir, "manifest.json");

    const exitCode = await bootstrap(
      [
        "--root",
        FIXTURE_ROOT,
        "--registry",
        registryPath,
        "--report",
        reportPath,
        "--manifest",
        manifestPath,
      ],
      NULL_LOGGER,
    );

    // Exit code is 0 when all files shaved, 1 if any failed.
    // Both are valid — CLI surface is correct either way.
    expect([0, 1]).toContain(exitCode);

    // Both artifact files must exist regardless of per-file shave outcome.
    expect(existsSync(reportPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("report.json has valid BootstrapReport shape with totalFiles > 0", async () => {
    const tempDir = makeTempDir();
    const reportPath = join(tempDir, "report.json");

    await bootstrap(
      [
        "--root",
        FIXTURE_ROOT,
        "--registry",
        join(tempDir, "r.sqlite"),
        "--report",
        reportPath,
        "--manifest",
        join(tempDir, "m.json"),
      ],
      NULL_LOGGER,
    );

    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as BootstrapReport;

    // Summary fields must be present and internally consistent.
    expect(report.summary.totalFiles).toBeGreaterThan(0);
    expect(report.summary.totalFiles).toBe(
      report.summary.shaved + report.summary.skipped + report.summary.failed,
    );

    // files array must have one entry per totalFiles.
    expect(report.files).toHaveLength(report.summary.totalFiles);
    for (const f of report.files) {
      expect(["shaved", "skipped", "failed"]).toContain(f.status);
      expect(typeof f.filePath).toBe("string");
      expect(Array.isArray(f.merkleRoots)).toBe(true);
    }
  });

  it("respects custom --manifest path and does NOT write the default name", async () => {
    const tempDir = makeTempDir();
    const customManifest = join(tempDir, "custom-name.json");

    await bootstrap(
      [
        "--root",
        FIXTURE_ROOT,
        "--registry",
        join(tempDir, "r.sqlite"),
        "--report",
        join(tempDir, "report.json"),
        "--manifest",
        customManifest,
      ],
      NULL_LOGGER,
    );

    expect(existsSync(customManifest)).toBe(true);
    // Default manifest name must NOT appear in the temp dir (custom path was used).
    expect(existsSync(join(tempDir, "expected-roots.json"))).toBe(false);
  });

  it("returns exit code 0 for --help without touching the filesystem", async () => {
    const exitCode = await bootstrap(["--help"], NULL_LOGGER);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// bootstrap() — determinism (compound-interaction: walk → shave → serialize)
// ---------------------------------------------------------------------------

describe("bootstrap() — determinism", () => {
  it("two independent passes against the same source produce byte-identical manifests", async () => {
    const tempA = makeTempDir();
    const tempB = makeTempDir();

    await bootstrap(
      [
        "--root",
        FIXTURE_ROOT,
        "--registry",
        join(tempA, "r.sqlite"),
        "--report",
        join(tempA, "report.json"),
        "--manifest",
        join(tempA, "manifest.json"),
      ],
      NULL_LOGGER,
    );

    await bootstrap(
      [
        "--root",
        FIXTURE_ROOT,
        "--registry",
        join(tempB, "r.sqlite"),
        "--report",
        join(tempB, "report.json"),
        "--manifest",
        join(tempB, "manifest.json"),
      ],
      NULL_LOGGER,
    );

    const manifestA = readFileSync(join(tempA, "manifest.json"), "utf-8");
    const manifestB = readFileSync(join(tempB, "manifest.json"), "utf-8");

    // Byte-identical manifests prove determinism across the full
    // walk → openRegistry → shave → serialize pipeline.
    expect(manifestA).toBe(manifestB);
  });
});
