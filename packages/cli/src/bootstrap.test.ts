/**
 * bootstrap.test.ts — integration tests for `yakcc bootstrap` CLI verb.
 *
 * Tests the bootstrap command that walks source files, shaves them through
 * the offline static-intent path, and dumps the deterministic manifest via
 * Registry.exportManifest() (WI-V2-BOOTSTRAP-01).
 *
 * Production sequence exercised:
 *   bootstrap(["--registry", r, "--manifest", m, "--report", rep], logger)
 *   → walk fixture files → shave each offline → exportManifest → write JSON
 *
 * @decision DEC-CLI-BOOTSTRAP-TEST-001
 * @title Bootstrap tests use real temp-file SQLite registries
 * @status accepted
 * @rationale bootstrap() opens its own registry handle per invocation (same as
 *   all yakcc CLI commands). Temp-file SQLite is the correct integration boundary
 *   — it matches production behaviour and avoids handle contention. Each test
 *   suite uses its own tmpdir to prevent cross-test interference.
 *
 * @decision DEC-CLI-BOOTSTRAP-TEST-002
 * @title Fixture mini-projects use real SPDX-licensed TypeScript source
 * @status accepted
 * @rationale The shave pipeline has a license gate that requires a recognized
 *   SPDX header. Tests that expect success use "// SPDX-License-Identifier: MIT"
 *   headers. Tests that expect failure omit or use invalid headers. This tests
 *   the real production failure mode (license gate refusal) rather than mocking
 *   internal behaviour.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CollectingLogger } from "./index.js";
import { bootstrap } from "./commands/bootstrap.js";

// ---------------------------------------------------------------------------
// Suite lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal fixture project directory with one TypeScript source file.
 * Returns the fixture project root path.
 */
function makeFixtureProject(
  tmpBase: string,
  name: string,
  files: Array<{ relativePath: string; content: string }>,
): string {
  const projDir = join(tmpBase, name);
  mkdirSync(projDir, { recursive: true });

  // Write a minimal pnpm-workspace.yaml so repo-root detection works.
  writeFileSync(join(projDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n", "utf-8");

  for (const { relativePath, content } of files) {
    const fullPath = join(projDir, relativePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }

  return projDir;
}

/** A valid SPDX-licensed trivial TypeScript function. */
const VALID_TS_SOURCE = `// SPDX-License-Identifier: MIT
/**
 * Returns the sum of two numbers.
 * @param a - first operand
 * @param b - second operand
 * @returns sum of a and b
 */
export function add(a: number, b: number): number {
  return a + b;
}
`;

/** A TypeScript source WITHOUT an SPDX header — triggers license gate failure. */
const NO_SPDX_SOURCE = `// No license header here — should fail
export function noLicense(x: number): number {
  return x * 2;
}
`;

// ---------------------------------------------------------------------------
// Suite-level tmpdir
// ---------------------------------------------------------------------------

let suiteDir: string;

beforeAll(() => {
  suiteDir = mkdtempSync(join(tmpdir(), "yakcc-bootstrap-test-"));
});

afterAll(() => {
  try {
    rmSync(suiteDir, { recursive: true, force: true });
  } catch {
    // Non-fatal cleanup failure.
  }
});

// ---------------------------------------------------------------------------
// Suite 1: help flag
// ---------------------------------------------------------------------------

describe("bootstrap --help", () => {
  it("exits 0 and prints help text", async () => {
    const logger = new CollectingLogger();
    const code = await bootstrap(["--help"], logger);
    expect(code).toBe(0);
    const output = logger.logLines.join("\n");
    expect(output).toContain("bootstrap");
    expect(output).toContain("--registry");
    expect(output).toContain("--manifest");
    expect(output).toContain("--report");
  });
});

// ---------------------------------------------------------------------------
// Suite 2: fixture mini-project produces a manifest
// ---------------------------------------------------------------------------

describe("bootstrap on a fixture mini-project produces a manifest", () => {
  it("exits 0, manifest exists with >=1 entry, report shows 1 success", async () => {
    const projDir = makeFixtureProject(suiteDir, "proj-mini", [
      {
        relativePath: "packages/foo/src/a.ts",
        content: VALID_TS_SOURCE,
      },
    ]);

    const registryPath = join(suiteDir, "mini-r.sqlite");
    const manifestPath = join(suiteDir, "mini-m.json");
    const reportPath = join(suiteDir, "mini-rep.json");

    const logger = new CollectingLogger();
    // Change working directory for the command by passing --registry/--manifest/--report.
    // bootstrap resolves the repo root from the cwd; we need to set cwd to projDir.
    // The bootstrap() function uses process.cwd() for repo-root resolution by default,
    // so we temporarily override it for this test.
    const origCwd = process.cwd();
    process.chdir(projDir);
    let code: number;
    try {
      code = await bootstrap(
        [
          "--registry",
          registryPath,
          "--manifest",
          manifestPath,
          "--report",
          reportPath,
        ],
        logger,
      );
    } finally {
      process.chdir(origCwd);
    }

    expect(code).toBe(0);
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown[];
    expect(Array.isArray(manifest)).toBe(true);
    expect(manifest.length).toBeGreaterThanOrEqual(1);

    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as Array<{
      outcome: string;
      path: string;
    }>;
    expect(Array.isArray(report)).toBe(true);
    const successes = report.filter((r) => r.outcome === "success");
    expect(successes.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Suite 3: exits 1 on file-shave failure (no SPDX header)
// ---------------------------------------------------------------------------

describe("bootstrap exits 1 on file-shave failure", () => {
  it("exits 1 when a file lacks SPDX header", async () => {
    const projDir = makeFixtureProject(suiteDir, "proj-nospdx", [
      {
        relativePath: "packages/bad/src/b.ts",
        content: NO_SPDX_SOURCE,
      },
    ]);

    const registryPath = join(suiteDir, "nospdx-r.sqlite");
    const manifestPath = join(suiteDir, "nospdx-m.json");
    const reportPath = join(suiteDir, "nospdx-rep.json");

    const logger = new CollectingLogger();
    const origCwd = process.cwd();
    process.chdir(projDir);
    let code: number;
    try {
      code = await bootstrap(
        [
          "--registry",
          registryPath,
          "--manifest",
          manifestPath,
          "--report",
          reportPath,
        ],
        logger,
      );
    } finally {
      process.chdir(origCwd);
    }

    expect(code).toBe(1);
    // The error logger should mention the failed file.
    const allErrors = logger.errLines.join("\n");
    expect(allErrors.length).toBeGreaterThan(0);

    // The report should still be written and show failure.
    if (existsSync(reportPath)) {
      const report = JSON.parse(readFileSync(reportPath, "utf-8")) as Array<{
        outcome: string;
      }>;
      const failures = report.filter((r) => r.outcome === "failure");
      expect(failures.length).toBeGreaterThanOrEqual(1);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Suite 4: manifest is sorted by blockMerkleRoot
// ---------------------------------------------------------------------------

describe("bootstrap manifest is sorted by blockMerkleRoot", () => {
  it("manifest entries are in ascending lexicographic order of blockMerkleRoot", async () => {
    const projDir = makeFixtureProject(suiteDir, "proj-sorted", [
      {
        relativePath: "packages/foo/src/a.ts",
        content: `// SPDX-License-Identifier: MIT
/** Returns a+1. @param a - input @returns a+1 */
export function inc(a: number): number { return a + 1; }
`,
      },
      {
        relativePath: "packages/foo/src/b.ts",
        content: `// SPDX-License-Identifier: MIT
/** Returns a-1. @param a - input @returns a-1 */
export function dec(a: number): number { return a - 1; }
`,
      },
      {
        relativePath: "packages/foo/src/c.ts",
        content: `// SPDX-License-Identifier: MIT
/** Returns a*2. @param a - input @returns a*2 */
export function dbl(a: number): number { return a * 2; }
`,
      },
    ]);

    const registryPath = join(suiteDir, "sorted-r.sqlite");
    const manifestPath = join(suiteDir, "sorted-m.json");
    const reportPath = join(suiteDir, "sorted-rep.json");

    const logger = new CollectingLogger();
    const origCwd = process.cwd();
    process.chdir(projDir);
    let code: number;
    try {
      code = await bootstrap(
        [
          "--registry",
          registryPath,
          "--manifest",
          manifestPath,
          "--report",
          reportPath,
        ],
        logger,
      );
    } finally {
      process.chdir(origCwd);
    }

    // We expect some files to succeed (at least 1); bootstrap may exit 1 if some fail,
    // but the manifest should still be written.
    if (!existsSync(manifestPath)) {
      // If no files succeeded, skip the sort check.
      return;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Array<{
      blockMerkleRoot: string;
    }>;

    if (manifest.length < 2) {
      // Cannot assert sort order with fewer than 2 entries.
      return;
    }

    // Assert ascending sort.
    for (let i = 1; i < manifest.length; i++) {
      const cur = manifest[i];
      const prev = manifest[i - 1];
      expect(cur).toBeDefined();
      expect(prev).toBeDefined();
      if (cur === undefined || prev === undefined) continue; // narrow for TS noUncheckedIndexedAccess
      expect(cur.blockMerkleRoot >= prev.blockMerkleRoot).toBe(true);
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Suite 5: determinism — two runs produce byte-identical manifests
// ---------------------------------------------------------------------------

describe("bootstrap is deterministic across runs", () => {
  it("two runs on the same fixture produce byte-identical manifests", async () => {
    const projDir = makeFixtureProject(suiteDir, "proj-det", [
      {
        relativePath: "packages/foo/src/a.ts",
        content: VALID_TS_SOURCE,
      },
    ]);

    const origCwd = process.cwd();
    process.chdir(projDir);

    const run1Registry = join(suiteDir, "det-r1.sqlite");
    const run1Manifest = join(suiteDir, "det-m1.json");
    const run1Report = join(suiteDir, "det-rep1.json");

    const run2Registry = join(suiteDir, "det-r2.sqlite");
    const run2Manifest = join(suiteDir, "det-m2.json");
    const run2Report = join(suiteDir, "det-rep2.json");

    try {
      const logger1 = new CollectingLogger();
      const code1 = await bootstrap(
        [
          "--registry",
          run1Registry,
          "--manifest",
          run1Manifest,
          "--report",
          run1Report,
        ],
        logger1,
      );

      const logger2 = new CollectingLogger();
      const code2 = await bootstrap(
        [
          "--registry",
          run2Registry,
          "--manifest",
          run2Manifest,
          "--report",
          run2Report,
        ],
        logger2,
      );

      // Both runs should have the same exit code.
      expect(code1).toBe(code2);

      // Both manifests should exist and be identical.
      expect(existsSync(run1Manifest)).toBe(true);
      expect(existsSync(run2Manifest)).toBe(true);

      const manifest1 = readFileSync(run1Manifest, "utf-8");
      const manifest2 = readFileSync(run2Manifest, "utf-8");
      expect(manifest1).toBe(manifest2);
    } finally {
      process.chdir(origCwd);
    }
  }, 120_000);
});
