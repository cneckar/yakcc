// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/oracle-runner.mjs
//
// @decision DEC-BENCH-B4-HARNESS-001
// @title B4 harness: oracle runner — extract generated code and run oracle tests
// @status accepted
// @rationale
//   The oracle runner bridges LLM response text and vitest oracle tests.
//   It extracts TypeScript code from a fenced code block in the LLM response,
//   writes it to a temp file under tmp/B4-tokens/, and runs the task's oracle
//   test against it via vitest subprocess. The oracle test loads the code under
//   test via IMPL_PATH env var (file:// URL for Windows compat).
//
//   Why subprocess for vitest? vitest has global state (timers, module cache) that
//   must be isolated between oracle runs. A subprocess boundary makes contamination
//   impossible — same rationale as B7-commit's subprocess isolation (#393 fix).
//
//   Why no mocking? Per benchmark contract: oracles must execute real generated code.
//   A mocked oracle would prove nothing about the generated implementation's correctness.
//
//   Code extraction heuristic: extract the first TypeScript fenced block (`typescript
//   or `ts). If none found, try generic ` blocks. If no code block, treat entire
//   response text as the implementation (some models omit fences).
//
// Exports:
//   extractCode(responseText) -> string
//   runOracle(taskId, generatedCode, options?) -> Promise<OracleResult>

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B4_ROOT = resolve(__dirname, "..");

// Static resolution: oracle-runner.mjs is at bench/B4-tokens/harness/oracle-runner.mjs
// So repo root is three levels up from harness/.
const REPO_ROOT = process.env["YAKCC_REPO_ROOT"] ?? resolve(__dirname, "../../..");

/**
 * Find the vitest binary. Searches known workspace package locations.
 * vitest is not at the workspace root — it lives in specific package node_modules.
 *
 * On Windows, spawnSync cannot execute bare symlinks from .bin/ — it needs the .CMD
 * wrapper. We check for vitest.CMD first on win32, then fall back to the bare name.
 */
function findVitestBin() {
  const isWin = process.platform === "win32";
  const names = isWin ? ["vitest.CMD", "vitest"] : ["vitest"];

  // Primary: packages/shave is where vitest is installed in this workspace
  const shaveBin = join(REPO_ROOT, "packages", "shave", "node_modules", ".bin");
  for (const name of names) {
    const candidate = join(shaveBin, name);
    if (existsSync(candidate)) return candidate;
  }

  // Fallback: check other workspace packages
  const candidatePackages = ["registry", "hooks-base", "contracts", "ir"];
  for (const pkg of candidatePackages) {
    const binDir = join(REPO_ROOT, "packages", pkg, "node_modules", ".bin");
    for (const name of names) {
      const candidate = join(binDir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  // Last resort: assume vitest (or vitest.CMD on Windows) is on PATH
  return isWin ? "vitest.CMD" : "vitest";
}

/**
 * Extract TypeScript code from an LLM response text.
 * Tries TypeScript-fenced blocks first, then generic blocks, then raw text.
 *
 * @param {string} responseText - Full LLM response text
 * @returns {string} Extracted code (may be empty string if nothing found)
 */
export function extractCode(responseText) {
  // Try ```typescript or ```ts fenced blocks
  const tsBlockMatch = responseText.match(/```(?:typescript|ts)\r?\n([\s\S]*?)```/);
  if (tsBlockMatch && tsBlockMatch[1]) {
    return tsBlockMatch[1].trim();
  }

  // Try generic ``` blocks
  const genericBlockMatch = responseText.match(/```\r?\n([\s\S]*?)```/);
  if (genericBlockMatch && genericBlockMatch[1]) {
    return genericBlockMatch[1].trim();
  }

  // No fences — use raw text (some models omit fences)
  return responseText.trim();
}

/**
 * @typedef {Object} OracleResult
 * @property {boolean} semantic_equivalent - true iff all oracle tests passed
 * @property {number} passed - number of passing tests
 * @property {number} failed - number of failing tests
 * @property {number} total - total tests run
 * @property {string} stdout - truncated vitest stdout
 * @property {string} stderr - truncated vitest stderr
 * @property {number|null} exitCode - vitest process exit code
 * @property {string} [error] - error message if oracle could not run
 */

/**
 * Run the oracle test for a task against generated code.
 *
 * @param {string} taskId - Task slug (e.g. "lru-cache-with-ttl")
 * @param {string} generatedCode - TypeScript code to test
 * @param {{ scratchDir?: string, cleanup?: boolean }} [options]
 * @returns {Promise<OracleResult>}
 */
export async function runOracle(taskId, generatedCode, options = {}) {
  const scratchDir = options.scratchDir ?? join(REPO_ROOT, "tmp", "B4-tokens", "oracle-scratch");
  const cleanup = options.cleanup !== false;

  mkdirSync(scratchDir, { recursive: true });

  // Write generated code to a uniquely-named temp .ts file
  const codeHash = createHash("sha256").update(generatedCode).digest("hex").slice(0, 12);
  const implFile = join(scratchDir, `${taskId}-${codeHash}.ts`);
  writeFileSync(implFile, generatedCode, "utf8");

  const oracleTestFile = join(BENCH_B4_ROOT, "tasks", taskId, "oracle.test.ts");
  if (!existsSync(oracleTestFile)) {
    return {
      semantic_equivalent: false,
      passed: 0,
      failed: 0,
      total: 0,
      stdout: "",
      stderr: "",
      exitCode: null,
      error: `Oracle test not found: ${oracleTestFile}`,
    };
  }

  const vitestBin = findVitestBin();
  const configFile = join(BENCH_B4_ROOT, "vitest.config.mjs");

  // Run vitest in a subprocess with IMPL_PATH pointing to the generated code file.
  // CWD is set to packages/shave so vitest resolves its own node_modules correctly.
  //
  // Windows note: .CMD files cannot be directly spawned via spawnSync — they require
  // shell: true. We use shell: true on win32 for all invocations; on POSIX the bare
  // binary works directly. shell: true adds ~10ms overhead but is always safe.
  const isWin = process.platform === "win32";
  const vitestResult = spawnSync(
    vitestBin,
    ["run", "--config", configFile, oracleTestFile],
    {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 30_000,
      shell: isWin, // required on Windows for .CMD files
      env: {
        ...process.env,
        IMPL_PATH: implFile,
        NODE_ENV: "test",
      },
      cwd: join(REPO_ROOT, "packages", "shave"),
    }
  );

  // Cleanup temp file
  if (cleanup && existsSync(implFile)) {
    try { rmSync(implFile); } catch (_) {}
  }

  if (vitestResult.error) {
    return {
      semantic_equivalent: false,
      passed: 0,
      failed: 0,
      total: 0,
      stdout: "",
      stderr: vitestResult.stderr ?? "",
      exitCode: null,
      error: `Subprocess spawn error: ${vitestResult.error.message}`,
    };
  }

  const stdout = vitestResult.stdout ?? "";
  const stderr = vitestResult.stderr ?? "";

  // Parse test counts from vitest verbose output
  // Summary line: "Tests  N passed (N)" or "Tests  N failed | N passed (N)"
  let passed = 0;
  let failed = 0;

  const failedSummary = stdout.match(/Tests\s+(\d+) failed \| (\d+) passed/);
  const passedSummary = stdout.match(/Tests\s+(\d+) passed/);

  if (failedSummary) {
    failed = parseInt(failedSummary[1] ?? "0", 10);
    passed = parseInt(failedSummary[2] ?? "0", 10);
  } else if (passedSummary) {
    passed = parseInt(passedSummary[1] ?? "0", 10);
    failed = 0;
  } else {
    // Fallback: count check marks and x marks in verbose output
    passed = (stdout.match(/ ✓ /g) ?? []).length;
    failed = (stdout.match(/ × /g) ?? []).length;
  }

  const semantic_equivalent = vitestResult.status === 0 && failed === 0;

  return {
    semantic_equivalent,
    passed,
    failed,
    total: passed + failed,
    stdout: stdout.slice(0, 3000),
    stderr: stderr.slice(0, 1000),
    exitCode: vitestResult.status,
  };
}
