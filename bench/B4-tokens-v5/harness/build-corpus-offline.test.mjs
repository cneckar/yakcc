// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/harness/build-corpus-offline.test.mjs
//
// Tests for the offline corpus build script.
// These tests verify the real production sequence:
//   1. build-corpus-offline.mjs runs offline (no API) and produces a registry
//   2. The registry contains one atom per task with behavior-bearing SpecYak
//   3. probe-v5 against the registry resolves tasks to auto_accept
//
// Tests run against the COMMITTED registry when available, or rebuild it.
// They do NOT require ANTHROPIC_API_KEY.
//
// Compound-interaction test: exercises the full build → probe pipeline crossing:
//   - tasks.json manifest parsing
//   - reference-impl file reading
//   - contracts (blockMerkleRoot, canonicalize, specHash, validateSpecYak)
//   - registry.storeBlock() + findCandidatesByQuery()
//   - production mcp-registry yakcc_resolve (via probe-v5 MCP server spawn)

import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, '..');
const CORPUS_DIR = join(BENCH_ROOT, 'corpus');
const REGISTRY_PATH = join(CORPUS_DIR, 'registry.sqlite');
const BUILD_SCRIPT = join(__dirname, 'build-corpus-offline.mjs');
const PROBE_SCRIPT = join(__dirname, 'probe-v5.mjs');
const TASKS_JSON = join(BENCH_ROOT, 'tasks.json');

// Production MCP server path (must be built before running tests)
function findRepoRoot() {
  let candidate = resolve(__dirname, '../../..');
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(candidate, 'packages', 'mcp-registry', 'dist', 'index.js'))) return candidate;
    candidate = resolve(candidate, '..');
  }
  return resolve(__dirname, '../../..');
}
const REPO_ROOT = findRepoRoot();
const MCP_DIST = join(REPO_ROOT, 'packages', 'mcp-registry', 'dist', 'index.js');

// ──────────────────────────────────────────────────────────────────────────────
// Test 1: build script exists and has the right structure
// ──────────────────────────────────────────────────────────────────────────────

console.log('Test 1: build script exists and is valid ESM');
assert.ok(existsSync(BUILD_SCRIPT), `build-corpus-offline.mjs not found at ${BUILD_SCRIPT}`);
const buildSource = readFileSync(BUILD_SCRIPT, 'utf8');
assert.ok(buildSource.includes('ZERO Anthropic API calls made'), 'build script must assert no API calls');
assert.ok(buildSource.includes('storeBlock'), 'build script must use storeBlock');
assert.ok(buildSource.includes('behavior'), 'build script must include behavior in SpecYak');
assert.ok(!buildSource.includes('ANTHROPIC_API_KEY') || buildSource.includes('will NOT be used'),
  'build script must not use ANTHROPIC_API_KEY (only informational check)');
console.log('  PASS\n');

// ──────────────────────────────────────────────────────────────────────────────
// Test 2: tasks.json has 6 tasks with reference-impl files
// ──────────────────────────────────────────────────────────────────────────────

console.log('Test 2: tasks.json has 6 tasks with valid reference-impl paths');
const manifest = JSON.parse(readFileSync(TASKS_JSON, 'utf8'));
assert.equal(manifest.tasks.length, 6, 'must have 6 tasks');
const EXPECTED_TASK_IDS = ['crc32c', 'utf8-codec', 'base32-rfc4648', 'lru-ttl-cache', 'semver-range', 'ring-buffer'];
for (const task of manifest.tasks) {
  assert.ok(EXPECTED_TASK_IDS.includes(task.id), `unexpected task id: ${task.id}`);
  const implFile = resolve(BENCH_ROOT, task.reference_impl);
  assert.ok(existsSync(implFile), `reference-impl not found for ${task.id}: ${implFile}`);
  assert.ok(task.description?.length > 10, `task ${task.id} must have non-trivial description`);
}
console.log('  PASS\n');

// ──────────────────────────────────────────────────────────────────────────────
// Test 3: Production MCP server dist exists (required for probe)
// ──────────────────────────────────────────────────────────────────────────────

console.log('Test 3: production mcp-registry dist exists');
assert.ok(existsSync(MCP_DIST),
  `mcp-registry dist not found at ${MCP_DIST}. Run: pnpm -r build`);
console.log('  PASS\n');

// ──────────────────────────────────────────────────────────────────────────────
// Test 4: COMPOUND INTEGRATION — build → probe → auto_accept for all 6 tasks
//
// This is the production sequence:
//   node build-corpus-offline.mjs → creates registry.sqlite
//   YAKCC_REGISTRY_PATH=... node probe-v5.mjs → resolves tasks
//   Each task tier must be auto_accept
// ──────────────────────────────────────────────────────────────────────────────

console.log('Test 4 (compound integration): build corpus offline → probe → auto_accept');
console.log('  Running build-corpus-offline.mjs (no API key)...');

// Run the build script
async function runScript(scriptPath, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [scriptPath], {
      cwd: BENCH_ROOT,
      env: { ...process.env, ...env },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`Script exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
    proc.on('error', reject);
  });
}

// Build: delete existing registry first for a clean test
if (existsSync(REGISTRY_PATH)) unlinkSync(REGISTRY_PATH);

let buildResult;
try {
  buildResult = await runScript(BUILD_SCRIPT, { ANTHROPIC_API_KEY: undefined });
} catch (err) {
  console.error('  BUILD FAILED:', err.message);
  process.exit(1);
}

assert.ok(existsSync(REGISTRY_PATH), 'registry.sqlite must exist after build');
assert.ok(buildResult.stdout.includes('ZERO Anthropic API calls made'),
  'build output must confirm no API calls');
assert.ok(buildResult.stdout.includes('Atoms stored : 6'),
  'build must store exactly 6 atoms');
console.log('  Build: PASS (6 atoms stored, no API calls)');

// Probe: run probe-v5 against the new registry
console.log('  Running probe-v5.mjs against new registry...');

let probeResult;
try {
  probeResult = await runScript(PROBE_SCRIPT, {
    YAKCC_REGISTRY_PATH: REGISTRY_PATH,
    YAKCC_AIRGAPPED: '1',
  });
} catch (err) {
  console.error('  PROBE FAILED:', err.message);
  process.exit(1);
}

// Parse probe results from JSONL output file
// The probe writes a results file; parse it for verification.
// Also check stdout for auto_accept markers.
const stdout = probeResult.stdout;
assert.ok(stdout.includes('ZERO Anthropic API calls made'),
  'probe must confirm no API calls');

// Count auto_accept results
const autoAcceptCount = (stdout.match(/tier=auto_accept/g) || []).length;
const candidateListCount = (stdout.match(/tier=candidate_list/g) || []).length;
const noCandsCount = (stdout.match(/tier=no_candidates/g) || []).length;

console.log(`  Probe results: auto_accept=${autoAcceptCount}, candidate_list=${candidateListCount}, no_candidates=${noCandsCount}`);

// All 6 tasks must resolve to auto_accept
assert.equal(autoAcceptCount, 6,
  `all 6 tasks must be auto_accept, got: auto_accept=${autoAcceptCount}, candidate_list=${candidateListCount}, no_candidates=${noCandsCount}\n${stdout}`);

console.log('  Probe: PASS (all 6 tasks auto_accept)\n');
console.log('Test 4 (compound integration): PASS\n');

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────

console.log('=== All tests PASSED ===');
console.log(`Registry: ${REGISTRY_PATH}`);
console.log('Build: runs with NO API key, stores 6 atoms with behavior-bearing SpecYak');
console.log('Probe: all 6 v5 tasks resolve to auto_accept tier');
