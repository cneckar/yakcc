// SPDX-License-Identifier: MIT
// bench/B4-tokens-v5/harness/oracle-runner.mjs
// Forked from v4/oracle-runner.mjs. Updated BENCH_B4_ROOT + scratchDir path.
// v5 addition: runOracleOnFile() for substitution oracle (run oracle on a file path directly).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B4_ROOT = resolve(__dirname, '..');
const REPO_ROOT = process.env['YAKCC_REPO_ROOT'] ?? resolve(__dirname, '../../..');

function findVitestBin() {
  const isWin = process.platform === 'win32';
  const names = isWin ? ['vitest.CMD', 'vitest'] : ['vitest'];
  const localBin = join(BENCH_B4_ROOT, 'node_modules', '.bin');
  for (const name of names) {
    const candidate = join(localBin, name);
    if (existsSync(candidate)) return candidate;
  }
  const shaveBin = join(REPO_ROOT, 'packages', 'shave', 'node_modules', '.bin');
  for (const name of names) {
    const candidate = join(shaveBin, name);
    if (existsSync(candidate)) return candidate;
  }
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

export function extractCode(responseText) {
  const tsBlockMatch = responseText.match(/```(?:typescript|ts)\r?\n([\s\S]*?)```/);
  if (tsBlockMatch?.[1]) return tsBlockMatch[1].trim();
  const genericBlockMatch = responseText.match(/```\r?\n([\s\S]*?)```/);
  if (genericBlockMatch?.[1]) return genericBlockMatch[1].trim();
  return responseText.trim();
}

function runVitestOnFile(taskId, implFile) {
  const oracleTestFile = join(BENCH_B4_ROOT, 'tasks', taskId, 'oracle.test.ts');
  if (!existsSync(oracleTestFile)) {
    return {
      oracle_passed: false, oracle_pass_count: 0, oracle_total: 0,
      oracle_failures: [`Oracle test not found: ${oracleTestFile}`],
      stdout: '', stderr: '', exitCode: null,
      error: `Oracle test not found: ${oracleTestFile}`,
    };
  }
  const vitestBin = findVitestBin();
  const configFile = join(BENCH_B4_ROOT, 'vitest.config.mjs');
  const isWin = process.platform === 'win32';
  const vitestResult = spawnSync(
    vitestBin,
    ['run', '--config', configFile, oracleTestFile],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
      shell: isWin,
      env: { ...process.env, IMPL_PATH: implFile, NODE_ENV: 'test' },
      cwd: join(REPO_ROOT, 'packages', 'shave'),
    }
  );
  if (vitestResult.error) {
    return {
      oracle_passed: false, oracle_pass_count: 0, oracle_total: 0,
      oracle_failures: [`Subprocess spawn error: ${vitestResult.error.message}`],
      stdout: '', stderr: vitestResult.stderr ?? '', exitCode: null,
      error: `Subprocess spawn error: ${vitestResult.error.message}`,
    };
  }
  const stdout = vitestResult.stdout ?? '';
  const stderr = vitestResult.stderr ?? '';
  let passed = 0, failed = 0;
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
  const oracle_failures = [];
  if (failed > 0) {
    for (const m of stdout.matchAll(/ × (.+)/g)) oracle_failures.push(m[1].trim());
  }
  return {
    oracle_passed: vitestResult.status === 0 && failed === 0,
    oracle_pass_count: passed, oracle_total: passed + failed,
    oracle_failures,
    stdout: stdout.slice(0, 3000), stderr: stderr.slice(0, 1000),
    exitCode: vitestResult.status,
  };
}

export async function runOracle(taskId, generatedCode, options = {}) {
  const scratchDir = options.scratchDir ?? join(REPO_ROOT, 'tmp', 'B4-tokens-v5', 'oracle-scratch');
  const cleanup = options.cleanup !== false;
  mkdirSync(scratchDir, { recursive: true });
  const codeHash = createHash('sha256').update(generatedCode).digest('hex').slice(0, 12);
  const implFile = join(scratchDir, `${taskId}-${codeHash}.ts`);
  writeFileSync(implFile, generatedCode, 'utf8');
  const result = runVitestOnFile(taskId, implFile);
  if (cleanup && existsSync(implFile)) { try { rmSync(implFile); } catch (_) {} }
  return result;
}

// v5 addition: honest substitution oracle — run oracle on a pre-written file
// (used when model emits yakcc compile <atom_id> and harness fetches+writes the substituted code)
export async function runOracleOnFile(taskId, implFilePath) {
  return runVitestOnFile(taskId, implFilePath);
}
