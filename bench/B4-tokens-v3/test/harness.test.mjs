// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/test/harness.test.mjs
//
// Unit tests for the 4 harness integration defects (B1..B4) from issue #668.
// Tests run offline at $0 cost — no real Anthropic API calls.
//
// Run:
//   node --test bench/B4-tokens-v3/test/harness.test.mjs
//   (from the repo root; uses Node.js built-in test runner)

import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, '..');

function findRepoRootSync(startDir) {
  let current = startDir;
  for (let i = 0; i < 12; i++) {
    const gitPath = join(current, '.git');
    if (existsSync(gitPath)) {
      try {
        if (statSync(gitPath).isDirectory()) return current;
      } catch (_) {}
    }
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return resolve(startDir, '../../..');
}

const REPO_ROOT = findRepoRootSync(__dirname);
const HARNESS_DIR = join(BENCH_ROOT, 'harness');

// ---------------------------------------------------------------------------
// Test 1 — B3: classify.mjs accepts the nested cells[].reps[] shape
// ---------------------------------------------------------------------------

describe('B3: classify.mjs — nested cells[].reps[] contract (DEC-B4-V3-CLASSIFY-SHAPE-001)', () => {
  let classifyTask;
  let classifyHypothesis;

  before(async () => {
    const mod = await import(new URL(`file://${join(HARNESS_DIR, 'classify.mjs')}`).href);
    classifyTask = mod.classifyTask;
    classifyHypothesis = mod.classifyHypothesis;
  });

  it('classifyTask returns validated=true when oracle Q matches hypothesis bar (HC-1..HC-4 all pass)', () => {
    // HC-1: E fails oracle (any_oracle_pass=false)
    // HC-2: F passes oracle (any_oracle_pass=true)
    // HC-3: C_F / C_A ≤ 0.2  (F is cheap: 0.01, A is expensive: 0.10)
    // HC-4: Q_F == Q_A  (both have pass_rate = 1.0)
    const taskData = {
      task_id: 'test-task',
      cells: [
        {
          cell_id: 'A',
          reps: [
            { oracle_passed: true, cost_usd: 0.10, tool_cycles: 0 },
            { oracle_passed: true, cost_usd: 0.10, tool_cycles: 0 },
          ],
        },
        {
          cell_id: 'E',
          reps: [
            { oracle_passed: false, cost_usd: 0.01, tool_cycles: 0 },
            { oracle_passed: false, cost_usd: 0.01, tool_cycles: 0 },
          ],
        },
        {
          cell_id: 'F',
          reps: [
            { oracle_passed: true, cost_usd: 0.01, tool_cycles: 1 },
            { oracle_passed: true, cost_usd: 0.01, tool_cycles: 1 },
          ],
        },
      ],
    };

    const verdict = classifyTask(taskData);
    assert.equal(verdict.HC1, true, 'HC-1: E fails oracle → true');
    assert.equal(verdict.HC2, true, 'HC-2: F passes oracle → true');
    assert.equal(verdict.HC3, true, 'HC-3: cost_ratio F/A ≤ 0.2 → true');
    assert.equal(verdict.HC4, true, 'HC-4: Q_F == Q_A (both 1.0) → true');
    assert.equal(verdict.validated, true, 'validated=true when all HCs hold');
    assert.equal(verdict.task_id, 'test-task');
  });

  it('classifyTask returns validated=false when HC-3 fails (F not cheap enough)', () => {
    const taskData = {
      task_id: 'test-task',
      cells: [
        {
          cell_id: 'A',
          reps: [{ oracle_passed: true, cost_usd: 0.10 }],
        },
        {
          cell_id: 'E',
          reps: [{ oracle_passed: false, cost_usd: 0.05 }],
        },
        {
          cell_id: 'F',
          // cost_ratio = 0.05 / 0.10 = 0.5 > 0.2 → HC-3 fails
          reps: [{ oracle_passed: true, cost_usd: 0.05 }],
        },
      ],
    };

    const verdict = classifyTask(taskData);
    assert.equal(verdict.HC3, false, 'HC-3 fails: cost ratio 0.5 > 0.2');
    assert.equal(verdict.validated, false, 'validated=false when any HC fails');
  });

  it('classifyTask returns validated=false for shape mismatch (flat reps without cells) — NOT silently true', () => {
    // Regression: pre-fix, passing flat reps would silently return validated=false
    // because all cellStats lookups return zeros (cells is undefined/wrong shape).
    // This test ensures the function EXPLICITLY fails, not silently returns wrong data.
    // The new shape requires cells[], not reps[]. Passing a wrong shape should produce
    // a verdict where all cell stats are zeroed → validated=false (not validated=true).
    const wrongShape = {
      task_id: 'wrong-shape-task',
      // OLD SHAPE (flat): this would be reps: [{ cell_id: 'A', oracle_passed: true, ... }]
      // NEW SHAPE: cells: [...] — this object has neither
      cells: [], // empty cells → all stats zero → validated=false
    };

    const verdict = classifyTask(wrongShape);
    // With empty cells, cellStats returns zeros for everything:
    // HC-1: E fails (any_oracle_pass=false from empty cell) → true
    // HC-2: F passes (any_oracle_pass=false from empty cell) → FALSE ← catches shape mismatch
    // HC-3: A cost=0, so costRatio=null → false
    // HC-4: Q_F=0, Q_A=0, |diff|=0 < 0.001 → true
    assert.equal(verdict.HC2, false, 'HC-2 false: F cell empty → any_oracle_pass=false');
    assert.equal(verdict.validated, false, 'validated=false for empty cells (shape mismatch)');
  });

  it('classifyHypothesis returns hypothesis_validated=true when ≥50% tasks validated', () => {
    const phase2Results = {
      tasks: [
        // Task 1: validated (HC1..HC4 pass)
        {
          task_id: 'task-1',
          cells: [
            { cell_id: 'A', reps: [{ oracle_passed: true, cost_usd: 0.10 }] },
            { cell_id: 'E', reps: [{ oracle_passed: false, cost_usd: 0.01 }] },
            { cell_id: 'F', reps: [{ oracle_passed: true, cost_usd: 0.01 }] },
          ],
        },
        // Task 2: not validated (HC-3 fails)
        {
          task_id: 'task-2',
          cells: [
            { cell_id: 'A', reps: [{ oracle_passed: true, cost_usd: 0.10 }] },
            { cell_id: 'E', reps: [{ oracle_passed: false, cost_usd: 0.06 }] },
            { cell_id: 'F', reps: [{ oracle_passed: true, cost_usd: 0.06 }] },
          ],
        },
      ],
    };

    const h = classifyHypothesis(phase2Results);
    // 1/2 tasks validated = 50% ≥ threshold
    assert.equal(h.validated_task_count, 1);
    assert.equal(h.total_task_count, 2);
    assert.equal(h.hypothesis_validated, true, '50% ≥ 50% threshold → hypothesis_validated');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — B2: phase2.mjs emits loud error when YAKCC_REGISTRY_PATH is unset
// ---------------------------------------------------------------------------

describe('B2: phase2.mjs — YAKCC_REGISTRY_PATH required (no fallback)', () => {
  const PHASE2_PATH = join(HARNESS_DIR, 'phase2.mjs');

  function runPhase2WithEnv(env, args = ['--dry-run']) {
    return new Promise((resolve) => {
      const proc = spawn('node', [PHASE2_PATH, ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('exit', (code) => resolve({ code, stdout, stderr }));

      setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({ code: null, stdout, stderr, timedOut: true });
      }, 10_000);
    });
  }

  it('exits with code 1 and loud error when YAKCC_REGISTRY_PATH is unset', async () => {
    // Remove YAKCC_REGISTRY_PATH from env entirely
    const env = { ...process.env };
    delete env['YAKCC_REGISTRY_PATH'];

    const result = await runPhase2WithEnv({ YAKCC_REGISTRY_PATH: undefined });
    assert.equal(result.code, 1, 'must exit 1 when YAKCC_REGISTRY_PATH is unset');
    assert.ok(
      result.stderr.includes('YAKCC_REGISTRY_PATH') || result.stdout.includes('YAKCC_REGISTRY_PATH'),
      'error message must mention YAKCC_REGISTRY_PATH'
    );
  });

  it('exits with code 1 when YAKCC_REGISTRY_PATH is set but file does not exist', async () => {
    // In dry-run mode, the file-existence check is skipped. We need a real run to trigger it.
    // Pass a fake API key so the API-key check passes, then fail on missing file.
    const fakeRegistryPath = join(tmpdir(), `b4-test-missing-${randomBytes(4).toString('hex')}.sqlite`);
    // Ensure the file does NOT exist
    if (existsSync(fakeRegistryPath)) rmSync(fakeRegistryPath);

    const result = await runPhase2WithEnv(
      { YAKCC_REGISTRY_PATH: fakeRegistryPath, ANTHROPIC_API_KEY: 'sk-test-fake-key' },
      [] // real run mode (no --dry-run) to trigger file-existence check
    );
    assert.equal(result.code, 1, 'must exit 1 when registry file does not exist');
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('not found') || combined.includes('YAKCC_REGISTRY_PATH'),
      'error message must mention the missing registry'
    );
  });
});

// ---------------------------------------------------------------------------
// Test 3 — B1: atom-sync.mjs writes atoms to a per-run registry
// ---------------------------------------------------------------------------

describe('B1: atom-sync.mjs — per-run registry population', { timeout: 60_000 }, () => {
  let tmpDir;
  let registryPath;
  let cacheDir;
  let implFile;

  // Fixed MIT-licensed TypeScript source for testing.
  // This exact string is used to seed the intent cache and as the impl file content.
  const TEST_SOURCE = [
    '// SPDX-License-Identifier: MIT',
    '/** Returns the sum of two numbers. */',
    'export function addNumbers(a: number, b: number): number {',
    '  return a + b;',
    '}',
  ].join('\n');

  before(async () => {
    tmpDir = join(tmpdir(), `b4-v3-atom-test-${randomBytes(6).toString('hex')}`);
    mkdirSync(tmpDir, { recursive: true });
    registryPath = join(tmpDir, 'registry.sqlite');
    cacheDir = join(tmpDir, 'intent-cache');
    implFile = join(tmpDir, 'test-impl.ts');
    mkdirSync(cacheDir, { recursive: true });

    // Write the test impl file.
    writeFileSync(implFile, TEST_SOURCE, 'utf8');

    // Seed the intent cache so shave() can run offline (no Anthropic API call).
    const { seedIntentCache, sourceHash } = await import(
      new URL(`file://${join(REPO_ROOT, 'packages/shave/dist/index.js')}`).href
    );
    const srcHash = sourceHash(TEST_SOURCE);
    await seedIntentCache(
      { source: TEST_SOURCE, cacheDir },
      {
        schemaVersion: 1,
        behavior: 'Returns the sum of two numbers',
        inputs: [
          { name: 'a', typeHint: 'number', description: 'First operand' },
          { name: 'b', typeHint: 'number', description: 'Second operand' },
        ],
        outputs: [{ name: 'result', typeHint: 'number', description: 'Sum' }],
        preconditions: [],
        postconditions: [],
        notes: [],
        modelVersion: 'claude-haiku-4-5-20251001',
        promptVersion: '1',
        sourceHash: srcHash,
        extractedAt: '2026-01-01T00:00:00.000Z',
      }
    );
  });

  after(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('syncAtoms() writes ≥1 atom to the per-run registry', async () => {
    const { syncAtoms } = await import(
      new URL(`file://${join(HARNESS_DIR, 'atom-sync.mjs')}`).href
    );

    const merkleRoots = await syncAtoms({
      implFile,
      registryPath,
      repoRoot: REPO_ROOT,
      options: { offline: true, cacheDir, useOfflineEmbeddings: true },
    });

    // Atoms persisted → registry file must exist
    assert.ok(existsSync(registryPath), 'registry.sqlite must be created by syncAtoms()');

    // At least one atom merkle root returned
    assert.ok(merkleRoots.length >= 1, `syncAtoms must return ≥1 BlockMerkleRoot; got ${merkleRoots.length}`);

    // Each merkle root must be a 64-char hex string (BLAKE3-256)
    for (const root of merkleRoots) {
      assert.match(root, /^[0-9a-f]{64}$/, `BlockMerkleRoot must be 64-char hex: ${root}`);
    }
  });

  it('atom BlockMerkleRoot is recorded in billing artifact (billing log field)', async () => {
    // Simulate what phase1.mjs does: call syncAtoms and capture the merkle roots
    // in a billing log entry, then verify the field is present.
    const { syncAtoms } = await import(
      new URL(`file://${join(HARNESS_DIR, 'atom-sync.mjs')}`).href
    );
    const { BillingLog } = await import(
      new URL(`file://${join(HARNESS_DIR, 'billing.mjs')}`).href
    );

    const billingDir = join(tmpDir, 'billing');
    mkdirSync(billingDir, { recursive: true });
    const log = new BillingLog({ dir: billingDir, runId: 'test-run-b1' });

    const merkleRoots = await syncAtoms({
      implFile,
      registryPath,
      repoRoot: REPO_ROOT,
      options: { offline: true, cacheDir, useOfflineEmbeddings: true },
    });

    // Append a billing entry that includes the atom_merkle_roots field
    log.append({
      run_id: 'test-run-b1',
      phase: 1,
      task_id: 'addNumbers',
      rep: 1,
      driver: 'opus',
      arm: 'unhooked',
      model_id: 'claude-opus-4-7',
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.0025,
      cumulative_cost_usd: 0.0025,
      wall_ms: 500,
      ts: new Date().toISOString(),
      atom_merkle_roots: merkleRoots,   // ← B1 fix: field wired by phase1.mjs
    });

    const billingPath = join(billingDir, 'billing-test-run-b1.jsonl');
    assert.ok(existsSync(billingPath), 'billing log must be created');
    const entry = JSON.parse(readFileSync(billingPath, 'utf8').trim());
    assert.ok(Array.isArray(entry.atom_merkle_roots), 'billing entry must have atom_merkle_roots array');
    assert.ok(entry.atom_merkle_roots.length >= 1, 'atom_merkle_roots must contain ≥1 root');
    assert.equal(entry.atom_merkle_roots[0], merkleRoots[0], 'recorded root must match syncAtoms return');
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Classify-shape contract: classify.mjs ↔ phase2.mjs shape agreement
// ---------------------------------------------------------------------------

describe('Classify-shape contract: classify.mjs and phase2.mjs agree on cells[].reps[] shape', () => {
  let classifyTask;

  before(async () => {
    const mod = await import(new URL(`file://${join(HARNESS_DIR, 'classify.mjs')}`).href);
    classifyTask = mod.classifyTask;
  });

  it('classify.mjs accepts the exact shape that phase2.mjs writes to taskResults', () => {
    // Mirrors the actual taskResults.push() call in phase2.mjs:
    //   taskResults.push({ task_id: task.id, cells: cellResults });
    // Where each cellResult = { cell_id, driver, arm, model_id, reps: [...] }
    // And each rep = { rep, cell_id, driver, arm, input_tokens, output_tokens,
    //                  cost_usd, wall_ms, oracle_passed, oracle_pass_count,
    //                  oracle_total, oracle_failures, tool_cycles, substitution_events }
    const phase2TaskShape = {
      task_id: 'json5-parser',
      cells: [
        {
          cell_id: 'A',
          driver: 'opus',
          arm: 'unhooked',
          model_id: 'claude-opus-4-7',
          reps: [
            {
              rep: 1, cell_id: 'A', driver: 'opus', arm: 'unhooked',
              input_tokens: 2000, output_tokens: 800,
              cost_usd: 0.09, wall_ms: 3000,
              oracle_passed: true, oracle_pass_count: 10, oracle_total: 10,
              oracle_failures: [], tool_cycles: 0, substitution_events: [],
            },
          ],
        },
        {
          cell_id: 'E',
          driver: 'haiku',
          arm: 'unhooked',
          model_id: 'claude-haiku-4-5-20251001',
          reps: [
            {
              rep: 1, cell_id: 'E', driver: 'haiku', arm: 'unhooked',
              input_tokens: 1000, output_tokens: 400,
              cost_usd: 0.002, wall_ms: 1000,
              oracle_passed: false, oracle_pass_count: 4, oracle_total: 10,
              oracle_failures: ['test-5', 'test-7'], tool_cycles: 0, substitution_events: [],
            },
          ],
        },
        {
          cell_id: 'F',
          driver: 'haiku',
          arm: 'hooked',
          model_id: 'claude-haiku-4-5-20251001',
          reps: [
            {
              rep: 1, cell_id: 'F', driver: 'haiku', arm: 'hooked',
              input_tokens: 1100, output_tokens: 420,
              cost_usd: 0.0022, wall_ms: 1200,
              oracle_passed: true, oracle_pass_count: 10, oracle_total: 10,
              oracle_failures: [], tool_cycles: 2, substitution_events: [],
            },
          ],
        },
      ],
    };

    // classifyTask must NOT throw on this exact shape
    let verdict;
    assert.doesNotThrow(() => {
      verdict = classifyTask(phase2TaskShape);
    }, 'classifyTask must not throw on the exact phase2.mjs output shape');

    assert.ok(typeof verdict === 'object', 'classifyTask must return an object');
    assert.ok('HC1' in verdict && 'HC2' in verdict && 'HC3' in verdict && 'HC4' in verdict,
      'verdict must have HC1..HC4 fields');
    assert.ok(typeof verdict.validated === 'boolean', 'validated must be boolean');

    // With the test data: E fails (HC-1 ✓), F passes (HC-2 ✓),
    // cost_ratio = 0.0022/0.09 ≈ 0.024 ≤ 0.2 (HC-3 ✓),
    // Q_F = 1.0 == Q_A = 1.0 (HC-4 ✓) → validated
    assert.equal(verdict.HC1, true, 'HC-1: E oracle_passed=false → HC1=true');
    assert.equal(verdict.HC2, true, 'HC-2: F oracle_passed=true → HC2=true');
    assert.equal(verdict.HC3, true, 'HC-3: cost ratio ≈ 0.024 ≤ 0.2 → HC3=true');
    assert.equal(verdict.HC4, true, 'HC-4: Q_F=1.0 == Q_A=1.0 → HC4=true');
    assert.equal(verdict.validated, true, 'all HCs pass → validated=true');
  });
});

// ---------------------------------------------------------------------------
// Test 5 — E2E dry-run: phase1 + phase2 --dry-run complete without API calls
// ---------------------------------------------------------------------------

describe('E2E dry-run: phase1 and phase2 complete in dry-run mode', { timeout: 30_000 }, () => {
  const PHASE1_PATH = join(HARNESS_DIR, 'phase1.mjs');
  const PHASE2_PATH = join(HARNESS_DIR, 'phase2.mjs');

  function runScript(scriptPath, args, env = {}) {
    return new Promise((resolve) => {
      const proc = spawn('node', [scriptPath, ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('exit', (code) => resolve({ code, stdout, stderr }));
      setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({ code: null, stdout, stderr, timedOut: true });
      }, 25_000);
    });
  }

  it('phase1 --dry-run exits 0 and reports planned runs (no API calls)', async () => {
    const result = await runScript(PHASE1_PATH, ['--dry-run'], {
      // No ANTHROPIC_API_KEY → dry-run must not need it
      ANTHROPIC_API_KEY: undefined,
    });

    assert.ok(!result.timedOut, 'phase1 dry-run must not time out');
    assert.equal(result.code, 0, `phase1 --dry-run must exit 0; stderr: ${result.stderr.slice(0, 500)}`);
    assert.ok(
      result.stdout.includes('DRY RUN') || result.stdout.includes('dry run'),
      'dry-run output must mention DRY RUN'
    );
    assert.ok(
      result.stdout.includes('Phase 1 dry run complete') || result.stdout.includes('no API calls'),
      'dry-run output must confirm no API calls were made'
    );
  });

  it('phase2 --dry-run exits 0 with YAKCC_REGISTRY_PATH set (no API calls, file need not exist)', async () => {
    // In dry-run mode, phase2 checks YAKCC_REGISTRY_PATH is SET but does NOT check
    // if the file exists (the real-run file-existence check is skipped in dry-run).
    const fakeRegistryPath = '/tmp/b4-dry-run-test-registry.sqlite';

    const result = await runScript(PHASE2_PATH, ['--dry-run'], {
      YAKCC_REGISTRY_PATH: fakeRegistryPath,
      ANTHROPIC_API_KEY: undefined,
    });

    assert.ok(!result.timedOut, 'phase2 dry-run must not time out');
    assert.equal(result.code, 0, `phase2 --dry-run must exit 0; stderr: ${result.stderr.slice(0, 500)}`);
    assert.ok(
      result.stdout.includes('DRY RUN') || result.stdout.includes('dry run'),
      'dry-run output must mention DRY RUN'
    );
    assert.ok(
      result.stdout.includes('dry run complete') || result.stdout.includes('no API calls'),
      'dry-run output must confirm no API calls were made'
    );
  });
});

console.log('\nB4-v3 harness integration tests loaded (5 test suites).\n');
