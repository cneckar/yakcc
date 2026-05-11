#!/usr/bin/env node
/**
 * run.mjs — B8-SYNTHETIC Slice 1 orchestrator.
 *
 * @decision DEC-BENCH-B8-SYNTHETIC-SLICE1-001
 * @title Synthetic hit-rate simulation via findCandidatesByQuery
 * @status accepted
 * @rationale
 *   Per #167 DQ-2: synthetic harness simulates BEST-CASE hook behavior — perfect
 *   interception, zero overhead. Production B8 numbers can only be worse than synthetic.
 *   Synthetic is a CONSERVATIVE CEILING, not a misleading projection.
 *
 *   Hit rule uses CONFIDENT_THRESHOLD (0.70) from @yakcc/hooks-base, matching the
 *   production substitution-decision threshold. This keeps synthetic numbers aligned
 *   with what the real hook would actually substitute.
 *
 *   D1 gate context: D1 was decided NOT-shipping per #150's closing comments.
 *   The benchmark uses the shipped single-vector schema (the registry's actual current
 *   state). Scaling characteristics are independent of whether D1 ships.
 *
 * Slice 1 scope: f=1.0 only (full corpus). Slice 2 adds the full f-sweep.
 *
 * Usage:
 *   node bench/B8-synthetic/run.mjs [--registry <path>]
 *
 * Emits:
 *   tmp/B8-synthetic/slice1-<ISO-timestamp>.json
 *
 * Cross-reference:
 *   #192 (WI-BENCHMARK-B8-SYNTHETIC) — parent issue
 *   #167 (WI-BENCHMARK-SUITE) — parent suite with DQ-2, DQ-5, DQ-6, DQ-7, DQ-9
 *   bench/B8-synthetic/RUBRIC.md — pass/kill bars verbatim
 *   bench/B8-synthetic/hit-rate-simulator.mjs — core simulation logic
 *   bench/B8-synthetic/token-savings.mjs — heuristic savings estimator
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openBootstrapRegistry, simulateTask } from './hit-rate-simulator.mjs';
import { checkPassBars, computeAggregateSavings } from './token-savings.mjs';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    registry: { type: 'string', short: 'r' },
    // Override for dev environments where packages/registry/dist lives in a different root
    // (e.g. running from a git worktree against the main repo's built packages).
    // Not needed when running via `pnpm bench:curve-synthetic:slice1` from main repo root.
    'packages-root': { type: 'string' },
  },
  strict: false,
});

// Resolve paths relative to the repo root (two levels up from bench/B8-synthetic/)
const repoRoot = resolve(import.meta.dirname, '..', '..');
const packagesRoot = values['packages-root'] ? resolve(values['packages-root']) : undefined;
const registryPath = resolve(values.registry ?? join(repoRoot, 'bootstrap', 'yakcc.registry.sqlite'));
const benchDir = resolve(import.meta.dirname);
const transcriptsDir = join(benchDir, 'transcripts');
const corpusSpecPath = join(transcriptsDir, 'corpus-spec.json');

// ---------------------------------------------------------------------------
// Step 1: Verify corpus SHA-256 matches corpus-spec.json
// ---------------------------------------------------------------------------

console.log('Step 1: Verifying corpus integrity...');

const corpusSpec = JSON.parse(readFileSync(corpusSpecPath, 'utf-8'));
const transcriptFiles = corpusSpec.files.map(f => join(repoRoot, f));
const combinedBytes = Buffer.concat(transcriptFiles.map(f => readFileSync(f)));
const actualSha = createHash('sha256').update(combinedBytes).digest('hex');

if (actualSha !== corpusSpec.sha256) {
  console.error(`FATAL: Corpus SHA-256 mismatch!`);
  console.error(`  Expected: ${corpusSpec.sha256}`);
  console.error(`  Actual:   ${actualSha}`);
  console.error('Transcript files have been modified. Recompute corpus-spec.json sha256.');
  process.exit(1);
}
console.log(`  Corpus SHA-256: ${actualSha} (OK)`);
console.log(`  N=${corpusSpec.n} tasks across tiers: substrate=${corpusSpec.tiers.substrate}, glue=${corpusSpec.tiers.glue}, application=${corpusSpec.tiers.application}`);

// ---------------------------------------------------------------------------
// Step 2: Open bootstrap registry (read-only — we never call storeBlock)
// ---------------------------------------------------------------------------

console.log('\nStep 2: Opening bootstrap registry...');
console.log(`  Path: ${registryPath}`);

let registry;
try {
  registry = await openBootstrapRegistry(registryPath, packagesRoot);
} catch (err) {
  console.error(`FATAL: Cannot open registry at ${registryPath}`);
  console.error(err.message);
  process.exit(1);
}
console.log('  Registry opened (read-only).');

// ---------------------------------------------------------------------------
// Step 3: Load all transcript tasks
// ---------------------------------------------------------------------------

console.log('\nStep 3: Loading transcript fixtures...');
const allTasks = [];
for (const filePath of transcriptFiles) {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(l => l.trim());
  for (const line of lines) {
    allTasks.push(JSON.parse(line));
  }
}
console.log(`  Loaded ${allTasks.length} tasks.`);

// ---------------------------------------------------------------------------
// Step 4: Run hit-rate simulator (f=1.0 — full corpus)
// ---------------------------------------------------------------------------

console.log('\nStep 4: Running hit-rate simulation (f=1.0)...');
const taskResults = [];
for (const task of allTasks) {
  process.stdout.write(`  [${task.tier}] ${task.task_id}...`);
  const result = await simulateTask(task, registry);
  const hitsStr = result.blocks.filter(b => b.hit).length + '/' + result.blocks.length;
  process.stdout.write(` hits=${hitsStr} hit_rate=${(result.task_hit_rate * 100).toFixed(0)}%\n`);
  taskResults.push(result);
}

// ---------------------------------------------------------------------------
// Step 5: Compute token savings aggregates
// ---------------------------------------------------------------------------

console.log('\nStep 5: Computing token savings aggregates...');
const aggregates = computeAggregateSavings(taskResults);

// ---------------------------------------------------------------------------
// Step 6: Emit result artifact
// ---------------------------------------------------------------------------

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const outDir = join(repoRoot, 'tmp', 'B8-synthetic');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `slice1-${timestamp}.json`);

const passBarResult = checkPassBars(aggregates);

const artifact = {
  _meta: {
    benchmark: 'B8-SYNTHETIC',
    slice: 1,
    fraction_f: 1.0,
    timestamp: new Date().toISOString(),
    corpus_sha256: corpusSpec.sha256,
    corpus_n: corpusSpec.n,
    registry_path: registryPath,
    decision: 'DEC-BENCH-B8-SYNTHETIC-SLICE1-001',
    note: 'Slice 1 f=1.0 ceiling point only. Slice 2 fills in the f-sweep curve.',
  },
  // Per-task block-level results
  per_task: taskResults,
  // Per-tier aggregates
  per_tier: aggregates.per_tier,
  // Corpus-wide aggregates
  aggregate: {
    all_tasks: aggregates.all_tasks,
    tasks_with_coverage: aggregates.tasks_with_coverage,
  },
  // Curve points (one point per DQ-9 curve at f=1.0)
  curve_points: [
    {
      f: 1.0,
      curve: 'all_tasks',
      hit_rate: aggregates.all_tasks.mean_hit_rate,
      mean_savings_pct: aggregates.all_tasks.mean_savings_pct,
      total_savings_pct: aggregates.all_tasks.total_savings_pct,
    },
    {
      f: 1.0,
      curve: 'tasks_with_coverage',
      hit_rate: aggregates.tasks_with_coverage.mean_hit_rate,
      mean_savings_pct: aggregates.tasks_with_coverage.mean_savings_pct,
      total_savings_pct: aggregates.tasks_with_coverage.total_savings_pct,
      n_tasks: aggregates.tasks_with_coverage.n,
    },
  ],
  // Pass/KILL bar verdict at f=1.0
  verdict: passBarResult,
};

writeFileSync(outFile, JSON.stringify(artifact, null, 2));
console.log(`\n  Artifact written: ${outFile}`);

// ---------------------------------------------------------------------------
// Step 7: Close registry
// ---------------------------------------------------------------------------

await registry.close();

// ---------------------------------------------------------------------------
// Step 8: Print Markdown verdict table
// ---------------------------------------------------------------------------

const pct = v => `${(v * 100).toFixed(1)}%`;

const verdictEmoji = passBarResult.verdict === 'PASS' ? 'PASS'
  : passBarResult.verdict === 'KILL' ? 'KILL'
  : 'WARN';

console.log('\n' + '='.repeat(72));
console.log('B8-SYNTHETIC Slice 1 — Verdict Table (f=1.0 ceiling)');
console.log('='.repeat(72));
console.log('');
console.log('## Aggregate Results\n');
console.log('| Metric                           | All Tasks | With Coverage |');
console.log('|----------------------------------|-----------|---------------|');
console.log(`| Tasks (N)                        | ${String(aggregates.all_tasks.n).padStart(9)} | ${String(aggregates.tasks_with_coverage.n).padStart(13)} |`);
console.log(`| Mean hit rate                    | ${pct(aggregates.all_tasks.mean_hit_rate).padStart(9)} | ${pct(aggregates.tasks_with_coverage.mean_hit_rate).padStart(13)} |`);
console.log(`| Mean savings % (per-task avg)    | ${pct(aggregates.all_tasks.mean_savings_pct).padStart(9)} | ${pct(aggregates.tasks_with_coverage.mean_savings_pct).padStart(13)} |`);
console.log(`| Total savings % (corpus-level)   | ${pct(aggregates.all_tasks.total_savings_pct).padStart(9)} | ${pct(aggregates.tasks_with_coverage.total_savings_pct).padStart(13)} |`);
console.log(`| Total raw tokens                 | ${String(aggregates.all_tasks.total_raw_tokens).padStart(9)} | ${String(aggregates.tasks_with_coverage.total_raw_tokens).padStart(13)} |`);
console.log(`| Total hook tokens                | ${String(aggregates.all_tasks.total_hook_tokens).padStart(9)} | ${String(aggregates.tasks_with_coverage.total_hook_tokens).padStart(13)} |`);
console.log('');
console.log('## Per-Tier Breakdown\n');
console.log('| Tier        | N | Mean hit rate | Mean savings % |');
console.log('|-------------|---|---------------|----------------|');
for (const [tier, stats] of Object.entries(aggregates.per_tier)) {
  console.log(`| ${tier.padEnd(11)} | ${stats.n} | ${pct(stats.mean_hit_rate).padStart(13)} | ${pct(stats.mean_savings_pct).padStart(14)} |`);
}
console.log('');
console.log('## Per-Task Hit Rates\n');
console.log('| Task ID                               | Tier        | Hit rate | Savings % |');
console.log('|---------------------------------------|-------------|----------|-----------|');
for (const t of aggregates.per_task) {
  console.log(`| ${t.task_id.padEnd(37)} | ${t.tier.padEnd(11)} | ${pct(t.hit_rate).padStart(8)} | ${pct(t.savings_pct).padStart(9)} |`);
}
console.log('');
console.log('## Pass/KILL Bar Verdict\n');
console.log(`| Bar                | Target    | Actual    | Status     |`);
console.log(`|--------------------|-----------|-----------|------------|`);
console.log(`| Asymptote >= 80%   | >= 80%    | ${pct(aggregates.all_tasks.mean_savings_pct).padStart(9)} | ${verdictEmoji.padStart(10)} |`);
console.log(`| KILL < 50%         | < 50%     | ${pct(aggregates.all_tasks.mean_savings_pct).padStart(9)} | ${aggregates.all_tasks.mean_savings_pct < 0.50 ? 'KILL' : 'OK'}         |`);
console.log('');
console.log(`**Verdict: ${verdictEmoji}** — ${passBarResult.reason}`);
console.log('');
console.log(`NOTE: This is the f=1.0 ceiling point only. Slice 2 adds the f-sweep curve.`);
console.log(`Artifact: ${outFile}`);
console.log('='.repeat(72));
