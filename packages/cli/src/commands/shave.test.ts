/**
 * shave.test.ts — unit tests for `yakcc shave` command argument parsing and error paths.
 *
 * Production sequence exercised:
 *   shave(argv, logger) → parseArgs → openRegistry → shaveImpl → ShaveResult output
 *
 * These tests cover argument parsing and error paths without requiring a live
 * shave pipeline (which needs ANTHROPIC_API_KEY and a real source file). The
 * full happy path is covered by @yakcc/shave's own test suite.
 *
 * Tests:
 *   1. --help flag: returns 0 and logs usage text
 *   2. -h short flag: returns 0 and logs usage text
 *   3. Missing path: returns 1 and errors mention "missing source path"
 *   4. Unknown flag: returns 1 and emits an error
 *   5. Nonexistent source path: returns 1 with an error message
 *   6. Invalid registry path: returns 1 and error mentions "registry"
 *
 * @decision DEC-CLI-SHAVE-TEST-001: Tests focus on argument parsing and registry-open
 * error paths. No real shave pipeline execution is required here — that would need
 * ANTHROPIC_API_KEY and a real TS file. Sacred Practice #5: mocks only for external
 * boundaries; the registry open failure is a natural error boundary exercised by
 * pointing at a nonexistent directory.
 * Status: implemented (WI-014-02)
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { shave } from "./shave.js";

// ---------------------------------------------------------------------------
// Suite lifecycle — temp directory for test fixtures
// ---------------------------------------------------------------------------

let suiteDir: string;

beforeAll(() => {
  suiteDir = mkdtempSync(join(tmpdir(), "yakcc-shave-cmd-test-"));
});

afterAll(() => {
  try {
    rmSync(suiteDir, { recursive: true, force: true });
  } catch {
    // Non-fatal — temp cleanup failure does not fail the suite.
  }
});

// ---------------------------------------------------------------------------
// Suite 1: --help / -h flag
// ---------------------------------------------------------------------------

describe("shave --help", () => {
  it("returns 0 and logs usage text for --help", async () => {
    const logger = new CollectingLogger();
    const code = await shave(["--help"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("Usage"))).toBe(true);
    expect(logger.logLines.some((l) => l.includes("shave"))).toBe(true);
    expect(logger.errLines).toHaveLength(0);
  });

  it("returns 0 and logs usage text for -h shorthand", async () => {
    const logger = new CollectingLogger();
    const code = await shave(["-h"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("Usage"))).toBe(true);
    expect(logger.errLines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: missing source path
// ---------------------------------------------------------------------------

describe("shave missing path", () => {
  it("returns 1 and error mentions 'missing source path' when no path given", async () => {
    const logger = new CollectingLogger();
    const code = await shave([], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("missing source path"))).toBe(true);
    expect(logger.logLines).toHaveLength(0);
  });

  it("returns 1 and error mentions 'missing source path' with only flags", async () => {
    const logger = new CollectingLogger();
    const code = await shave(["--offline"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("missing source path"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: unknown flag
// ---------------------------------------------------------------------------

describe("shave unknown flag", () => {
  it("returns 1 and emits an error for an unrecognised flag", async () => {
    const logger = new CollectingLogger();
    const code = await shave(["--not-a-real-flag"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: nonexistent source path → registry open fails first
// ---------------------------------------------------------------------------

describe("shave invalid registry path", () => {
  it("returns 1 and error mentions 'registry' when registry dir does not exist", async () => {
    // Write a real (empty) TS file so we get past the path check.
    const tsFile = join(suiteDir, "dummy.ts");
    writeFileSync(tsFile, "export const x = 1;\n", "utf-8");

    const logger = new CollectingLogger();
    const code = await shave([tsFile, "--registry", "/no/such/dir/registry.sqlite"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("registry"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: nonexistent source path with a valid registry path
// ---------------------------------------------------------------------------

describe("shave nonexistent source path", () => {
  it("returns 1 and emits an error when source file does not exist", async () => {
    // Use a valid temp-dir for the registry path so openRegistry might succeed,
    // but the source file path is guaranteed nonexistent.
    const registryPath = join(suiteDir, "test-registry.sqlite");
    const logger = new CollectingLogger();
    const code = await shave(["/nonexistent/file.ts", "--registry", registryPath], logger);
    expect(code).toBe(1);
    expect(logger.errLines.length).toBeGreaterThan(0);
  });
});
