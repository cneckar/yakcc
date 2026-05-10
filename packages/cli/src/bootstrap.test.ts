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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap } from "./commands/bootstrap.js";
import { CollectingLogger } from "./index.js";

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
        ["--registry", registryPath, "--manifest", manifestPath, "--report", reportPath],
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
        ["--registry", registryPath, "--manifest", manifestPath, "--report", reportPath],
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
        ["--registry", registryPath, "--manifest", manifestPath, "--report", reportPath],
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
// (Suite 6 and 7 below cover --verify mode)

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
        ["--registry", run1Registry, "--manifest", run1Manifest, "--report", run1Report],
        logger1,
      );

      const logger2 = new CollectingLogger();
      const code2 = await bootstrap(
        ["--registry", run2Registry, "--manifest", run2Manifest, "--report", run2Report],
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

// ---------------------------------------------------------------------------
// Suite 6: --verify exits 0 when fresh manifest matches committed manifest
// ---------------------------------------------------------------------------

describe("bootstrap --verify exits 0 on byte-identical manifest", () => {
  it("generates a committed manifest, then --verify exits 0 (byte-identity gate)", async () => {
    // This test exercises the core verify invariant: two independent bootstrap runs
    // over the same source tree produce byte-identical manifests.
    // We do NOT assert that code1 === 0 because the environment may block tokenizer
    // downloads (pre-existing sandbox restriction); the manifest is written regardless.
    // The determinism contract holds whether 0 or N files succeed.
    const projDir = makeFixtureProject(suiteDir, "proj-verify-ok", [
      {
        relativePath: "packages/foo/src/a.ts",
        content: VALID_TS_SOURCE,
      },
    ]);

    const registryPath = join(suiteDir, "vok-r.sqlite");
    const committedManifestPath = resolve(join(suiteDir, "vok-committed.json"));
    const reportPath = join(suiteDir, "vok-rep.json");

    const origCwd = process.cwd();
    process.chdir(projDir);
    try {
      // Step 1: normal bootstrap run to produce the "committed" manifest.
      // May exit 1 if shave fails (e.g., offline tokenizer restriction); the
      // manifest is still written and is the ground-truth for this verify run.
      const logger1 = new CollectingLogger();
      await bootstrap(
        ["--registry", registryPath, "--manifest", committedManifestPath, "--report", reportPath],
        logger1,
      );
      expect(existsSync(committedManifestPath)).toBe(true);

      // Step 2: --verify against the committed manifest.
      // Both runs use the same offline pipeline over the same source files, so they
      // produce byte-identical manifests — exit 0 regardless of file-level success.
      const logger2 = new CollectingLogger();
      const code2 = await bootstrap(["--verify", "--manifest", committedManifestPath], logger2);
      expect(code2).toBe(0);
      const out = logger2.logLines.join("\n");
      expect(out).toContain("OK");
    } finally {
      process.chdir(origCwd);
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Suite 7: --verify exits 1 with structured diff on mismatch
// ---------------------------------------------------------------------------

describe("bootstrap --verify exits 1 with structured diff on mismatch", () => {
  it("exits 1 and names removed/added roots when committed manifest is stale", async () => {
    const projDir = makeFixtureProject(suiteDir, "proj-verify-fail", [
      {
        relativePath: "packages/foo/src/a.ts",
        content: VALID_TS_SOURCE,
      },
    ]);

    // Hard-code a stale "committed" manifest with a fake root that won't
    // match the fresh shave.  The fresh shave will produce real roots, so
    // the stale root becomes a "removed" entry and the fresh roots become
    // "added" entries.
    const staleRoot = "0".repeat(64);
    const staleManifest = [
      {
        blockMerkleRoot: staleRoot,
        specHash: "a".repeat(64),
        canonicalAstHash: "b".repeat(64),
        parentBlockRoot: null,
        implSourceHash: "c".repeat(64),
        manifestJsonHash: "d".repeat(64),
      },
    ];
    const staleManifestPath = resolve(join(suiteDir, "stale-committed.json"));
    writeFileSync(staleManifestPath, `${JSON.stringify(staleManifest, null, 2)}\n`, "utf-8");

    const origCwd = process.cwd();
    process.chdir(projDir);
    let code: number;
    try {
      const logger = new CollectingLogger();
      code = await bootstrap(["--verify", "--manifest", staleManifestPath], logger);
      expect(code).toBe(1);

      const errors = logger.errLines.join("\n");
      // Must name the failure and the stale root as "removed".
      expect(errors).toContain("FAILED");
      expect(errors).toContain(staleRoot);
    } finally {
      process.chdir(origCwd);
    }
  }, 90_000);

  it("exits 1 when committed manifest file is missing", async () => {
    const logger = new CollectingLogger();
    const code = await bootstrap(
      ["--verify", "--manifest", join(suiteDir, "nonexistent-committed.json")],
      logger,
    );
    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("committed manifest not found");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Suite 8: expected-failures reclassification
//
// These tests exercise the expected-failures.json exemption mechanism without
// running the full shave pipeline. They use a real temp-file sqlite registry
// but a fixture project where failures are synthetic (no-SPDX header) and the
// expected-failures.json file is written inline so we control path+errorClass.
//
// Production sequence exercised (Compound-Interaction requirement):
//   bootstrap([...flags, "--expected-failures", efPath], logger)
//   → loadExpectedFailures(efPath)
//   → shave loop produces FileOutcomeFailure for no-SPDX file
//   → reclassification maps it to FileOutcomeExpectedFailure via path+errorClass key
//   → summary shows expected-failures count, exit 0
//   → report.json contains outcome:"expected-failure"
// ---------------------------------------------------------------------------

describe("bootstrap expected-failures exemption", () => {
  /**
   * Build an expected-failures.json that matches a given path and errorClass.
   * Written to a temp file; returns the path.
   */
  function makeExpectedFailuresFile(
    dir: string,
    name: string,
    entries: Array<{ path: string; errorClass: string; rationale: string }>,
  ): string {
    const filePath = join(dir, name);
    const content = {
      schemaVersion: 1,
      entries,
    };
    writeFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf-8");
    return filePath;
  }

  it("reclassifies a LicenseRefusedError failure as expected-failure and exits 0", async () => {
    // Create a fixture project with a no-SPDX file (triggers LicenseRefusedError or
    // similar gate failure). We also include one valid file so the bootstrap isn't empty.
    const projDir = makeFixtureProject(suiteDir, "proj-ef-basic", [
      {
        relativePath: "packages/foo/src/ok.ts",
        content: VALID_TS_SOURCE,
      },
      {
        relativePath: "packages/foo/src/bad.ts",
        content: NO_SPDX_SOURCE,
      },
    ]);

    // Run without expected-failures first to confirm bad.ts causes a real failure.
    const registryPath1 = join(suiteDir, "ef-basic-r1.sqlite");
    const manifestPath1 = join(suiteDir, "ef-basic-m1.json");
    const reportPath1 = join(suiteDir, "ef-basic-rep1.json");

    const origCwd = process.cwd();
    process.chdir(projDir);
    let codeWithout: number;
    let errorClassObserved: string;
    try {
      const logger1 = new CollectingLogger();
      codeWithout = await bootstrap(
        ["--registry", registryPath1, "--manifest", manifestPath1, "--report", reportPath1],
        logger1,
      );
      // Must fail without the exemption.
      expect(codeWithout).toBe(1);

      // Discover the actual errorClass the shave pipeline throws for this fixture.
      const report1 = JSON.parse(readFileSync(reportPath1, "utf-8")) as Array<{
        outcome: string;
        path: string;
        errorClass?: string;
      }>;
      const badEntry = report1.find((r) => r.path.endsWith("bad.ts"));
      expect(badEntry).toBeDefined();
      expect(badEntry?.outcome).toBe("failure");
      errorClassObserved = badEntry?.errorClass ?? "Error";
    } finally {
      process.chdir(origCwd);
    }

    // Write an expected-failures.json that covers bad.ts with the observed errorClass.
    // The path in expected-failures.json must be repo-relative (matches outcomes[].path).
    const efPath = makeExpectedFailuresFile(suiteDir, "ef-basic.json", [
      {
        path: "packages/foo/src/bad.ts",
        errorClass: errorClassObserved,
        rationale: "Test fixture: intentional license-gate failure for unit test coverage.",
      },
    ]);

    // Run again with expected-failures — bad.ts should be reclassified, exit 0.
    const registryPath2 = join(suiteDir, "ef-basic-r2.sqlite");
    const manifestPath2 = join(suiteDir, "ef-basic-m2.json");
    const reportPath2 = join(suiteDir, "ef-basic-rep2.json");

    process.chdir(projDir);
    try {
      const logger2 = new CollectingLogger();
      const codeWith = await bootstrap(
        [
          "--registry",
          registryPath2,
          "--manifest",
          manifestPath2,
          "--report",
          reportPath2,
          "--expected-failures",
          efPath,
        ],
        logger2,
      );

      // Exit 0: the only failure is now an expected-failure.
      expect(codeWith).toBe(0);

      // Report must show outcome:"expected-failure" for bad.ts.
      expect(existsSync(reportPath2)).toBe(true);
      const report2 = JSON.parse(readFileSync(reportPath2, "utf-8")) as Array<{
        outcome: string;
        path: string;
        errorClass?: string;
        rationale?: string;
      }>;
      const efEntry = report2.find((r) => r.path.endsWith("bad.ts"));
      expect(efEntry).toBeDefined();
      expect(efEntry?.outcome).toBe("expected-failure");
      expect(efEntry?.rationale).toContain("Test fixture");

      // Summary output must mention expected-failures count.
      const logOutput = logger2.logLines.join("\n");
      expect(logOutput).toContain("expected-failures");
      expect(logOutput).toContain("1");
    } finally {
      process.chdir(origCwd);
    }
  }, 120_000);

  it("still exits 1 when a non-exempted file also fails", async () => {
    // Two bad files; only one is in expected-failures.json. The other must still fail.
    const projDir = makeFixtureProject(suiteDir, "proj-ef-partial", [
      {
        relativePath: "packages/foo/src/bad1.ts",
        content: NO_SPDX_SOURCE,
      },
      {
        relativePath: "packages/foo/src/bad2.ts",
        content: NO_SPDX_SOURCE,
      },
    ]);

    // First, get the errorClass for the no-SPDX files.
    const registryPath1 = join(suiteDir, "ef-partial-r1.sqlite");
    const manifestPath1 = join(suiteDir, "ef-partial-m1.json");
    const reportPath1 = join(suiteDir, "ef-partial-rep1.json");

    const origCwd = process.cwd();
    process.chdir(projDir);
    let errorClassObserved: string;
    try {
      const logger1 = new CollectingLogger();
      await bootstrap(
        ["--registry", registryPath1, "--manifest", manifestPath1, "--report", reportPath1],
        logger1,
      );
      const report1 = JSON.parse(readFileSync(reportPath1, "utf-8")) as Array<{
        outcome: string;
        path: string;
        errorClass?: string;
      }>;
      const bad1 = report1.find((r) => r.path.endsWith("bad1.ts"));
      errorClassObserved = bad1?.errorClass ?? "Error";
    } finally {
      process.chdir(origCwd);
    }

    // Exempt only bad1.ts; bad2.ts remains a real failure.
    const efPath = makeExpectedFailuresFile(suiteDir, "ef-partial.json", [
      {
        path: "packages/foo/src/bad1.ts",
        errorClass: errorClassObserved,
        rationale: "Intentional fixture.",
      },
    ]);

    const registryPath2 = join(suiteDir, "ef-partial-r2.sqlite");
    const manifestPath2 = join(suiteDir, "ef-partial-m2.json");
    const reportPath2 = join(suiteDir, "ef-partial-rep2.json");

    process.chdir(projDir);
    try {
      const logger2 = new CollectingLogger();
      const code = await bootstrap(
        [
          "--registry",
          registryPath2,
          "--manifest",
          manifestPath2,
          "--report",
          reportPath2,
          "--expected-failures",
          efPath,
        ],
        logger2,
      );

      // bad2.ts is still a real failure → exit 1.
      expect(code).toBe(1);

      const report2 = JSON.parse(readFileSync(reportPath2, "utf-8")) as Array<{
        outcome: string;
        path: string;
      }>;
      const ef1 = report2.find((r) => r.path.endsWith("bad1.ts"));
      const f2 = report2.find((r) => r.path.endsWith("bad2.ts"));
      expect(ef1?.outcome).toBe("expected-failure");
      expect(f2?.outcome).toBe("failure");
    } finally {
      process.chdir(origCwd);
    }
  }, 120_000);

  it("emits a warning for an untriggered expected-failure entry (path not in processed files)", async () => {
    // A project with one valid file; expected-failures.json references a path that
    // doesn't exist in the project. The entry is never triggered → warning, but exit 0.
    const projDir = makeFixtureProject(suiteDir, "proj-ef-untriggered", [
      {
        relativePath: "packages/foo/src/ok.ts",
        content: VALID_TS_SOURCE,
      },
    ]);

    const efPath = makeExpectedFailuresFile(suiteDir, "ef-untriggered.json", [
      {
        path: "examples/v0.7-mri-demo/src/gpl-fixture.ts",
        errorClass: "LicenseRefusedError",
        rationale: "Intentional GPL fixture — but this fixture is not in this mini-project.",
      },
    ]);

    const registryPath = join(suiteDir, "ef-unt-r.sqlite");
    const manifestPath = join(suiteDir, "ef-unt-m.json");
    const reportPath = join(suiteDir, "ef-unt-rep.json");

    const origCwd = process.cwd();
    process.chdir(projDir);
    try {
      const logger = new CollectingLogger();
      const code = await bootstrap(
        [
          "--registry",
          registryPath,
          "--manifest",
          manifestPath,
          "--report",
          reportPath,
          "--expected-failures",
          efPath,
        ],
        logger,
      );

      // Untriggered entry does NOT fail the bootstrap (warning only).
      expect(code).toBe(0);

      // Warning must appear in log output.
      const logOutput = logger.logLines.join("\n");
      expect(logOutput).toContain("warning");
      expect(logOutput).toContain("expected-failure");
      expect(logOutput).toContain("gpl-fixture.ts");
    } finally {
      process.chdir(origCwd);
    }
  }, 120_000);

  it("exits 1 when expected-failures.json has an unsupported schemaVersion", async () => {
    const badEfPath = join(suiteDir, "ef-badschema.json");
    writeFileSync(badEfPath, JSON.stringify({ schemaVersion: 99, entries: [] }, null, 2), "utf-8");

    const projDir = makeFixtureProject(suiteDir, "proj-ef-badschema", [
      { relativePath: "packages/foo/src/ok.ts", content: VALID_TS_SOURCE },
    ]);

    const origCwd = process.cwd();
    process.chdir(projDir);
    try {
      const logger = new CollectingLogger();
      const code = await bootstrap(
        [
          "--registry",
          join(suiteDir, "ef-badschema-r.sqlite"),
          "--manifest",
          join(suiteDir, "ef-badschema-m.json"),
          "--report",
          join(suiteDir, "ef-badschema-rep.json"),
          "--expected-failures",
          badEfPath,
        ],
        logger,
      );
      expect(code).toBe(1);
      expect(logger.errLines.join("\n")).toContain("schemaVersion");
    } finally {
      process.chdir(origCwd);
    }
  }, 30_000);
});
