// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/harness/oracle-runner.mjs
//
// @decision DEC-BENCH-B4-V3-ORACLE-RUNNER-001
// @title B4-v3 oracle runner — extract generated code and run oracle tests
// @status accepted
// @rationale
//   Adapted from bench/B4-tokens/harness/oracle-runner.mjs for the v3 task suite.
//   Key differences: BENCH_B4_ROOT points to bench/B4-tokens-v3/, scratchDir
//   defaults to tmp/B4-tokens-v3/, findVitestBin() searches v3 node_modules first
//   then falls back to packages/shave (same binary, different search order).
//
//   Oracle runner bridges LLM response text and vitest oracle tests.
//   Extracts TypeScript code from a fenced code block in the LLM response,
//   writes it to a temp file, and runs the task's oracle test via vitest subprocess.
//   The oracle test loads code under test via IMPL_PATH env var.
//
// Exports:
//   extractCode(responseText) -> string
//   runOracle(taskId, generatedCode, options?) -> Promise<OracleResult>

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B4_ROOT = resolve(__dirname, '..');
const REPO_ROOT = process.env['YAKCC_REPO_ROOT'] ?? resolve(__dirname, '../../..');

/**
 * Find the vitest binary. Searches v3 local node_modules first, then known workspace
 * package locations. vitest may be installed locally in bench/B4-tokens-v3/node_modules
 * or globally in packages/shave/node_modules.
 */
function findVitestBin() {
  const isWin = process.platform === 'win32';
  const names = isWin ? ['vitest.CMD', 'vitest'] : ['vitest'];

  // Primary: v3 local node_modules (if pnpm installed them locally)
  const v3Bin = join(BENCH_B4_ROOT, 'node_modules', '.bin');
  for (const name of names) {
    const candidate = join(v3Bin, name);
    if (existsSync(candidate)) return candidate;
  }

  // Secondary: packages/shave is where vitest is installed in this workspace
  const shaveBin = join(REPO_ROOT, 'packages', 'shave', 'node_modules', '.bin');
  for (const name of names) {
    const candidate = join(shaveBin, name);
    if (existsSync(candidate)) return candidate;
  }

  // Fallback: check other workspace packages
  const candidatePackages = ['registry', 'hooks-base', 'contracts', 'ir', 'compile'];
  for (const pkg of candidatePackages) {
    const binDir = join(REPO_ROOT, 'packages', pkg, 'node_modules', '.bin');
    for (const name of names) {
      const candidate = join(binDir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return isWin ? 'vitest.CMD' : 'vitest';
}

/**
 * Extract TypeScript code from an LLM response text.
 * Tries TypeScript-fenced blocks first, then generic blocks, then raw text.
 *
 * @param {string} responseText - Full LLM response text
 * @returns {string} Extracted code (may be empty string if nothing found)
 */
export function extractCode(responseText) {
  const tsBlockMatch = responseText.match(/```(?:typescript|ts)\r?\n([\s\S]*?)```/);
  if (tsBlockMatch && tsBlockMatch[1]) {
    return tsBlockMatch[1].trim();
  }

  const genericBlockMatch = responseText.match(/```\r?\n([\s\S]*?)```/);
  if (genericBlockMatch && genericBlockMatch[1]) {
    return genericBlockMatch[1].trim();
  }

  return responseText.trim();
}

/**
 * @typedef {Object} OracleResult
 * @property {boolean} oracle_passed - true iff all oracle tests passed
 * @property {number} oracle_pass_count - number of passing tests
 * @property {number} oracle_total - total tests run
 * @property {string[]} oracle_failures - names of failed tests (for diagnostic)
 * @property {string} stdout - truncated vitest stdout
 * @property {string} stderr - truncated vitest stderr
 * @property {number|null} exitCode - vitest process exit code
 * @property {string} [error] - error message if oracle could not run
 */

/**
 * Run the oracle test for a task against generated code.
 *
 * @param {string} taskId - Task slug (e.g. "json5-parser")
 * @param {string} generatedCode - TypeScript code to test
 * @param {{ scratchDir?: string, cleanup?: boolean }} [options]
 * @returns {Promise<OracleResult>}
 */
export async function runOracle(taskId, generatedCode, options = {}) {
  const scratchDir = options.scratchDir
    ?? join(REPO_ROOT, 'tmp', 'B4-tokens-v3', 'oracle-scratch');
  const cleanup = options.cleanup !== false;

  mkdirSync(scratchDir, { recursive: true });

  const codeHash = createHash('sha256').update(generatedCode).digest('hex').slice(0, 12);
  const implFile = join(scratchDir, `${taskId}-${codeHash}.ts`);
  writeFileSync(implFile, generatedCode, 'utf8');

  const oracleTestFile = join(BENCH_B4_ROOT, 'tasks', taskId, 'oracle.test.ts');
  if (!existsSync(oracleTestFile)) {
    return {
      oracle_passed: false,
      oracle_pass_count: 0,
      oracle_total: 0,
      oracle_failures: [`Oracle test not found: ${oracleTestFile}`],
      stdout: '',
      stderr: '',
      exitCode: null,
      error: `Oracle test not found: ${oracleTestFile}`,
    };
  }

  const vitestBin = findVitestBin();
  const configFile = join(BENCH_B4_ROOT, 'vitest.config.mjs');

  // Run vitest in subprocess with IMPL_PATH pointing to the generated code file.
  // CWD is set to packages/shave so vitest resolves its own node_modules correctly
  // (same pattern as bench/B4-tokens/harness/oracle-runner.mjs).
  const isWin = process.platform === 'win32';
  const vitestResult = spawnSync(
    vitestBin,
    ['run', '--config', configFile, oracleTestFile],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
      shell: isWin,
      env: {
        ...process.env,
        IMPL_PATH: implFile,
        NODE_ENV: 'test',
      },
      cwd: join(REPO_ROOT, 'packages', 'shave'),
    }
  );

  if (cleanup && existsSync(implFile)) {
    try { rmSync(implFile); } catch (_) {}
  }

  if (vitestResult.error) {
    return {
      oracle_passed: false,
      oracle_pass_count: 0,
      oracle_total: 0,
      oracle_failures: [`Subprocess spawn error: ${vitestResult.error.message}`],
      stdout: '',
      stderr: vitestResult.stderr ?? '',
      exitCode: null,
      error: `Subprocess spawn error: ${vitestResult.error.message}`,
    };
  }

  const stdout = vitestResult.stdout ?? '';
  const stderr = vitestResult.stderr ?? '';

  // Parse test counts from vitest verbose output
  let passed = 0;
  let failed = 0;

  const failedSummary = stdout.match(/Tests\s+(\d+) failed \| (\d+) passed/);
  const passedSummary = stdout.match(/Tests\s+(\d+) passed/);

  if (failedSummary) {
    failed = parseInt(failedSummary[1] ?? '0', 10);
    passed = parseInt(failedSummary[2] ?? '0', 10);
  } else if (passedSummary) {
    passed = parseInt(passedSummary[1] ?? '0', 10);
    failed = 0;
  } else {
    passed = (stdout.match(/ ✓ /g) ?? []).length;
    failed = (stdout.match(/ × /g) ?? []).length;
  }

  // Extract names of failed tests for diagnostics
  const oracle_failures = [];
  if (failed > 0) {
    const failureMatches = stdout.matchAll(/ × (.+)/g);
    for (const m of failureMatches) {
      oracle_failures.push(m[1].trim());
    }
  }

  const oracle_passed = vitestResult.status === 0 && failed === 0;

  return {
    oracle_passed,
    oracle_pass_count: passed,
    oracle_total: passed + failed,
    oracle_failures,
    stdout: stdout.slice(0, 3000),
    stderr: stderr.slice(0, 1000),
    exitCode: vitestResult.status,
  };
}
