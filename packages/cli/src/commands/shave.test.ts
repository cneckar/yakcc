/**
 * shave.test.ts — unit tests for `yakcc shave` command argument parsing, error paths,
 * and L5 foreign-policy gate e2e behavior.
 *
 * Production sequence exercised:
 *   shave(argv, logger) → parseArgs → openRegistry → shaveImpl → ShaveResult output
 *
 * Suites 1–6: argument parsing and error paths (no live pipeline needed).
 * Suite 7 (L5 e2e): foreign-policy gate behavior against real on-disk fixture files.
 *   - The shave pipeline runs with default strategy="static" (no ANTHROPIC_API_KEY needed).
 *   - Fixture files live in packages/shave/src/__fixtures__/ per L5-I1.
 *   - Real on-disk fixture files are required (NOT inline strings) per L5 real-path check.
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
 *  L5.1. reject vs fixture A: exit 1 + stderr contains 'node:fs' and 'readFileSync'
 *  L5.2. tag vs fixture A: exit 0 + stdout 'node:fs#readFileSync' line
 *  L5.3. allow vs fixture A: exit 0 + no foreign-deps summary line
 *  L5.4. Default (omitted) = tag vs fixture A
 *  L5.5. tag vs fixture B: stdout lists 'sqlite-vec#load'
 *  L5.6. tag vs fixture C: stdout lists 'ts-morph#Project'
 *  L5.7. Negative fixture: no foreign-deps summary under any policy
 *  L5.8. Combined fixture (two deps): both in source-declaration order
 *
 * CLI smoke test note (Required real-path check): all tests invoke the actual
 * shaveCommand entry point (shave()) with real argv arrays. No argv parser is mocked.
 *
 * @decision DEC-CLI-SHAVE-TEST-001: Tests focus on argument parsing and registry-open
 * error paths. No real shave pipeline execution is required here — that would need
 * ANTHROPIC_API_KEY and a real TS file. Sacred Practice #5: mocks only for external
 * boundaries; the registry open failure is a natural error boundary exercised by
 * pointing at a nonexistent directory.
 * Status: updated (WI-V2-04 L5: foreign-policy gate e2e tests added)
 *
 * @decision DEC-CLI-SHAVE-TEST-L5-001
 * title: L5 e2e tests run full shave pipeline with strategy="static" (no API key)
 * status: decided (WI-V2-04 L5)
 * rationale:
 *   The shave pipeline's default intentStrategy is "static" (DEC-INTENT-STRATEGY-001),
 *   which uses the TypeScript Compiler API and JSDoc parser — no ANTHROPIC_API_KEY
 *   required. This lets L5 tests exercise the complete production sequence
 *   (parse → license gate → extractIntent → decompose → slice → policy gate)
 *   against real fixture files without external dependencies.
 *
 *   The fixture files are the canonical on-disk sources per L5-I1. Tests pass
 *   the absolute fixture path directly to the CLI so the test validates the
 *   real production sequence, not a mock or inline string.
 *
 *   Registry: a fresh SQLite registry is created in a temp dir for the L5 suite.
 *   This matches the production path (openRegistry → shaveImpl → result).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FOREIGN_POLICY_DEFAULT } from "@yakcc/shave";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { shave } from "./shave.js";

// ---------------------------------------------------------------------------
// Fixture directory — real on-disk .ts files (L5-I1)
// ---------------------------------------------------------------------------

// Navigate from packages/cli/src/commands/ to packages/shave/src/__fixtures__/
// HERE = packages/cli/src/commands/
// Four levels up lands at the repo root (worktree root).
// Then descend into packages/shave/src/__fixtures__/.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "..", "..", "..", "packages", "shave", "src", "__fixtures__");

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
      logger.errLines.some((l) => l.includes("allow") || l.includes("reject") || l.includes("tag")),
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

// ---------------------------------------------------------------------------
// Suite 7 (L5 e2e): foreign-policy gate behavior against real on-disk fixtures
//
// @decision DEC-CLI-SHAVE-TEST-L5-001 (see module header above)
// Each test below runs the full shave pipeline (strategy="static") against a
// real on-disk fixture .ts file.  A per-test SQLite registry is created in
// suiteDir so test isolation is guaranteed.
//
// FIXTURE_DIR is computed at module load from __filename → packages/shave/src/__fixtures__/
// (L5-I1).  Absolute paths are passed directly to the CLI; no relative paths.
//
// Required real-path checks (per workflow_contract):
//   - Tests invoke the actual shave() CLI entry point (not inline strings).
//   - Fixture C uses real ts-morph (Project is resolved via the installed package).
//   - Registry is a fresh SQLite file per test.
// ---------------------------------------------------------------------------

describe("L5 foreign-policy gate e2e", () => {
  /**
   * L5.1 — reject vs fixture A (node:fs#readFileSync)
   * Contract: exit code 1, stderr line contains both 'node:fs' and 'readFileSync'.
   * (L5-I3: reject throws ForeignPolicyRejectError; CLI formats to stderr and exits 1)
   */
  it("L5.1: --foreign-policy reject against fixture A exits 1 and stderr names node:fs and readFileSync", async () => {
    const registryPath = join(suiteDir, "l5-1-registry.sqlite");
    const fixturePath = join(FIXTURE_DIR, "foreign-node-fs.ts");
    const logger = new CollectingLogger();

    const code = await shave(
      [fixturePath, "--registry", registryPath, "--foreign-policy", "reject"],
      logger,
    );

    expect(code).toBe(1);
    // Stderr must contain both the package and the export name (L5-I3).
    const stderrAll = logger.errLines.join("\n");
    expect(stderrAll).toContain("node:fs");
    expect(stderrAll).toContain("readFileSync");
  });

  /**
   * L5.2 — tag vs fixture A (node:fs#readFileSync)
   * Contract: exit code 0, stdout contains a line with 'node:fs#readFileSync'.
   * (L5-I4: tag policy emits "foreign deps: pkg#export[, ...]" to stdout)
   */
  it("L5.2: --foreign-policy tag against fixture A exits 0 and stdout lists node:fs#readFileSync", async () => {
    const registryPath = join(suiteDir, "l5-2-registry.sqlite");
    const fixturePath = join(FIXTURE_DIR, "foreign-node-fs.ts");
    const logger = new CollectingLogger();

    const code = await shave(
      [fixturePath, "--registry", registryPath, "--foreign-policy", "tag"],
      logger,
    );

    expect(code).toBe(0);
    // stdout must include the foreign deps summary token (L5-I4).
    const stdoutAll = logger.logLines.join("\n");
    expect(stdoutAll).toContain("node:fs#readFileSync");
  });

  /**
   * L5.3 — allow vs fixture A (node:fs#readFileSync)
   * Contract: exit code 0, NO "foreign deps:" summary line in any output.
   * (L5-I5: allow policy silently accepts; no summary emitted)
   */
  it("L5.3: --foreign-policy allow against fixture A exits 0 with no foreign-deps summary", async () => {
    const registryPath = join(suiteDir, "l5-3-registry.sqlite");
    const fixturePath = join(FIXTURE_DIR, "foreign-node-fs.ts");
    const logger = new CollectingLogger();

    const code = await shave(
      [fixturePath, "--registry", registryPath, "--foreign-policy", "allow"],
      logger,
    );

    expect(code).toBe(0);
    // Neither stdout nor stderr should contain a foreign-deps summary (L5-I5).
    const allOutput = [...logger.logLines, ...logger.errLines].join("\n");
    expect(allOutput).not.toContain("foreign deps:");
  });

  /**
   * L5.4 — Default (flag omitted) against fixture A behaves identically to tag.
   * Contract: exit code 0, stdout lists 'node:fs#readFileSync'.
   * (I-X3: FOREIGN_POLICY_DEFAULT is 'tag'; omitting the flag must use that default)
   */
  it("L5.4: default (no --foreign-policy) against fixture A behaves like tag", async () => {
    const registryPath = join(suiteDir, "l5-4-registry.sqlite");
    const fixturePath = join(FIXTURE_DIR, "foreign-node-fs.ts");
    const logger = new CollectingLogger();

    // No --foreign-policy flag; FOREIGN_POLICY_DEFAULT ('tag') must be used.
    const code = await shave([fixturePath, "--registry", registryPath], logger);

    expect(code).toBe(0);
    const stdoutAll = logger.logLines.join("\n");
    expect(stdoutAll).toContain("node:fs#readFileSync");
  });

  /**
   * L5.5 — tag vs fixture B (sqlite-vec#load aliased as loadVec)
   * Contract: exit code 0, stdout lists 'sqlite-vec#load'.
   * (L5-I4: the aliased export is classified by the original name, not the local alias)
   */
  it("L5.5: --foreign-policy tag against fixture B exits 0 and lists sqlite-vec#load", async () => {
    const registryPath = join(suiteDir, "l5-5-registry.sqlite");
    const fixturePath = join(FIXTURE_DIR, "foreign-sqlite-vec.ts");
    const logger = new CollectingLogger();

    const code = await shave(
      [fixturePath, "--registry", registryPath, "--foreign-policy", "tag"],
      logger,
    );

    expect(code).toBe(0);
    const stdoutAll = logger.logLines.join("\n");
    expect(stdoutAll).toContain("sqlite-vec#load");
  });

  /**
   * L5.6 — tag vs fixture C (ts-morph#Project)
   * Contract: exit code 0, stdout lists 'ts-morph#Project'.
   * Real-path check: ts-morph is the actual installed package; no mocking.
   */
  it("L5.6: --foreign-policy tag against fixture C exits 0 and lists ts-morph#Project", async () => {
    const registryPath = join(suiteDir, "l5-6-registry.sqlite");
    const fixturePath = join(FIXTURE_DIR, "foreign-ts-morph.ts");
    const logger = new CollectingLogger();

    const code = await shave(
      [fixturePath, "--registry", registryPath, "--foreign-policy", "tag"],
      logger,
    );

    expect(code).toBe(0);
    const stdoutAll = logger.logLines.join("\n");
    expect(stdoutAll).toContain("ts-morph#Project");
  });

  /**
   * L5.7 — Negative fixture under all three policies: no foreign-deps summary.
   * The negative fixture has only `import type` (erased), relative imports, and
   * workspace imports — none are foreign (L5-I1 / negative case).
   * Contract: under allow, reject, and tag — no foreign-deps summary and no
   * ForeignPolicyRejectError (exit 0 for all three policies).
   */
  it.each([
    ["allow", "l5-7a-registry.sqlite"],
    ["reject", "l5-7b-registry.sqlite"],
    ["tag", "l5-7c-registry.sqlite"],
  ] as const)(
    "L5.7: --foreign-policy %s against negative fixture produces no foreign-deps entries",
    async (policy, registryFile) => {
      const registryPath = join(suiteDir, registryFile);
      const fixturePath = join(FIXTURE_DIR, "foreign-negative.ts");
      const logger = new CollectingLogger();

      const code = await shave(
        [fixturePath, "--registry", registryPath, "--foreign-policy", policy],
        logger,
      );

      // No foreign deps → no rejection error and no summary line.
      expect(code).toBe(0);
      const allOutput = [...logger.logLines, ...logger.errLines].join("\n");
      expect(allOutput).not.toContain("foreign deps:");
    },
  );

  /**
   * L5.8 — tag vs combined fixture (node:fs#readFileSync + ts-morph#Project)
   * Contract: exit code 0, stdout lists both tokens in source-declaration order.
   * (L5-I4: "foreign deps: node:fs#readFileSync, ts-morph#Project")
   */
  it("L5.8: --foreign-policy tag against combined fixture lists both deps in source order", async () => {
    const registryPath = join(suiteDir, "l5-8-registry.sqlite");
    const fixturePath = join(FIXTURE_DIR, "foreign-combined.ts");
    const logger = new CollectingLogger();

    const code = await shave(
      [fixturePath, "--registry", registryPath, "--foreign-policy", "tag"],
      logger,
    );

    expect(code).toBe(0);
    const stdoutAll = logger.logLines.join("\n");
    // Both tokens must be present (L5-I4).
    expect(stdoutAll).toContain("node:fs#readFileSync");
    expect(stdoutAll).toContain("ts-morph#Project");
    // Source-declaration order: node:fs appears before ts-morph (L5-I4).
    expect(stdoutAll.indexOf("node:fs#readFileSync")).toBeLessThan(
      stdoutAll.indexOf("ts-morph#Project"),
    );
  });
});
