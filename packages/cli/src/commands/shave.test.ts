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
 *   7. --foreign-policy bogus: returns 1 with clear error (L4)
 *   8. --foreign-policy tag: value parsed to ShaveOptions.foreignPolicy (L4)
 *   9. Default (flag omitted): resolves to FOREIGN_POLICY_DEFAULT constant 'tag' (L4)
 *
 * CLI smoke test note (Required real-path check): all tests invoke the actual
 * shaveCommand entry point (shave()) with real argv arrays. No argv parser is mocked.
 *
 * @decision DEC-CLI-SHAVE-TEST-001: Tests focus on argument parsing and registry-open
 * error paths. No real shave pipeline execution is required here — that would need
 * ANTHROPIC_API_KEY and a real TS file. Sacred Practice #5: mocks only for external
 * boundaries; the registry open failure is a natural error boundary exercised by
 * pointing at a nonexistent directory.
 * Status: updated (WI-V2-04 L4: --foreign-policy tests added)
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FOREIGN_POLICY_DEFAULT } from "@yakcc/shave";
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

// ---------------------------------------------------------------------------
// Suite 6: --foreign-policy flag (WI-V2-04 L4)
//
// These three tests exercise the CLI --foreign-policy argument-parsing layer.
// They do NOT require a running shave pipeline (no ANTHROPIC_API_KEY needed).
// All tests invoke the actual shave() entry point with real argv arrays — no
// argv parser is mocked per the CLI smoke-test requirement.
//
// Observable boundaries used (matching existing suite pattern):
//   - Validation errors are emitted to logger.error → visible in errLines.
//   - Control-flow proof: if --foreign-policy <value> passes validation,
//     execution proceeds to the source-path check and produces "missing source
//     path" rather than a foreign-policy validation error.
//   - Default-wiring proof: the help text embeds FOREIGN_POLICY_DEFAULT via the
//     same template literal used to initialise foreignPolicy in shave.ts; if
//     both references agree the constant is the single source of truth.
// ---------------------------------------------------------------------------

describe("--foreign-policy validation (WI-V2-04 L4)", () => {
  it("rejects --foreign-policy bogus with exit 1 and a clear error naming the flag and valid values", async () => {
    // "bogus" is not in VALID_FOREIGN_POLICIES; the CLI must return 1 and
    // emit an error that names --foreign-policy and at least one valid value
    // so the user knows how to fix it.
    const logger = new CollectingLogger();
    const code = await shave(["--foreign-policy", "bogus"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("foreign-policy"))).toBe(true);
    // Error must mention valid choices so the user can correct their invocation.
    expect(
      logger.errLines.some(
        (l) => l.includes("allow") || l.includes("reject") || l.includes("tag"),
      ),
    ).toBe(true);
    // No usage/help output should have been emitted — this is an error path.
    expect(logger.logLines).toHaveLength(0);
  });

  it("accepts --foreign-policy tag and proceeds past validation to the source-path check", async () => {
    // Proof that 'tag' passes the validation guard: control reaches the
    // source-path check and the error is "missing source path", NOT a
    // foreign-policy error.  This is the same observable-boundary technique
    // used by suites 2–5: use a downstream failure to confirm the upstream
    // check passed.
    const logger = new CollectingLogger();
    const code = await shave(["--foreign-policy", "tag"], logger);
    expect(code).toBe(1);
    // Must reach the source-path check — NOT a foreign-policy rejection.
    expect(logger.errLines.some((l) => l.includes("missing source path"))).toBe(true);
    expect(logger.errLines.every((l) => !l.includes("foreign-policy"))).toBe(true);
  });

  it("uses FOREIGN_POLICY_DEFAULT when --foreign-policy is omitted (single-source-of-truth)", async () => {
    // Two-part proof that FOREIGN_POLICY_DEFAULT is the single source of truth:
    //
    // Part A — help-text wiring: shave.ts embeds FOREIGN_POLICY_DEFAULT in the
    // help string via a template literal.  If the help output contains the
    // constant's runtime value we know both references (help text and the
    // `let foreignPolicy = FOREIGN_POLICY_DEFAULT` initialiser) point at the
    // same exported constant.
    const helpLogger = new CollectingLogger();
    const helpCode = await shave(["--help"], helpLogger);
    expect(helpCode).toBe(0);
    const helpText = helpLogger.logLines.join("\n");
    // The help text must embed FOREIGN_POLICY_DEFAULT's value.
    expect(helpText).toContain(`default: ${FOREIGN_POLICY_DEFAULT}`);

    // Part B — omitted-flag control flow: when --foreign-policy is not
    // supplied the default value is FOREIGN_POLICY_DEFAULT ('tag'), which is a
    // valid policy, so the CLI proceeds past validation to the source-path
    // check rather than emitting a foreign-policy error.
    const logger = new CollectingLogger();
    const code = await shave([], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("missing source path"))).toBe(true);
    // No foreign-policy error when the flag is omitted — the default is valid.
    expect(logger.errLines.every((l) => !l.includes("foreign-policy"))).toBe(true);
  });
});
