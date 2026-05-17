// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/harness/aggregate.mjs
//
// @decision DEC-BENCH-B4-V3-AGGREGATE-001
// @title B4-v3 dossier aggregator: produce DEC-BENCH-B4-V3-001 verdict summary
// @status accepted
// @rationale
//   Reads Phase 1 and Phase 2 results from the results/ directory and produces
//   a structured dossier (results/dossier-<runId>.json) containing:
//     - Per-task verdict table (HC-1..HC-4) from classify.mjs
//     - Headline comparisons: A vs F, E vs F, B vs D vs F, A vs (E × N)
//     - Quality-lift events (where E fails + F passes)
//     - Amortization breakeven: N runs of F equal one A run
//     - Aggregate hypothesis_validated boolean
//   Fulfills the dossier acceptance criteria from issue #653.
//
// Usage:
//   node bench/B4-tokens-v3/harness/aggregate.mjs --phase1=<path> --phase2=<path>
//   node bench/B4-tokens-v3/harness/aggregate.mjs  (auto-discovers latest results)

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, '..');
const RESULTS_DIR = join(BENCH_ROOT, 'results');

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'phase1': { type: 'string' },
    'phase2': { type: 'string' },
    'out':    { type: 'string' },
  },
  strict: false,
});

const { classifyHypothesis } = await import(
  new URL('file://' + join(__dirname, 'classify.mjs')).href
);

function findLatestResult(prefix) {
  if (!existsSync(RESULTS_DIR)) return null;
  const files = readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? join(RESULTS_DIR, files[0]) : null;
}

function loadResult(flagPath, prefix, label) {
  const path = flagPath ?? findLatestResult(prefix);
  if (!path) {
    console.error(`ERROR: No ${label} results found in ${RESULTS_DIR}`);
    console.error(`  Run phase${prefix.replace('phase', '')}.mjs first, or pass --${prefix}=<path>`);
    process.exit(1);
  }
  if (!existsSync(path)) {
    console.error(`ERROR: ${label} results file not found: ${path}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function cellSummary(taskResult, cellId) {
  const cell = taskResult.cells?.find((c) => c.cell_id === cellId);
  if (!cell || !cell.reps || cell.reps.length === 0) {
    return { oracle_pass_rate: 0, mean_cost_usd: 0, any_oracle_pass: false, n_reps: 0 };
  }
  const reps = cell.reps.filter((r) => !r.error);
  const passCount = reps.filter((r) => r.oracle_passed).length;
  const totalCost = reps.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  return {
    oracle_pass_rate: reps.length > 0 ? passCount / reps.length : 0,
    mean_cost_usd: reps.length > 0 ? totalCost / reps.length : 0,
    any_oracle_pass: passCount > 0,
    n_reps: reps.length,
  };
}

async function main() {
  const phase1 = loadResult(flags['phase1'], 'phase1', 'Phase 1');
  const phase2 = loadResult(flags['phase2'], 'phase2', 'Phase 2');

  console.log(`B4-v3 Dossier Aggregator`);
  console.log(`Phase 1: ${phase1.run_id} | ${phase1.n_tasks} tasks × N=${phase1.n_reps}`);
  console.log(`Phase 2: ${phase2.run_id} | ${phase2.n_tasks} tasks × ${phase2.n_cells} cells × N=${phase2.n_reps}`);
  console.log('');

  // Hypothesis verdict via classify.mjs (DEC-B4-V3-CLASSIFY-SHAPE-001)
  const verdict = classifyHypothesis(phase2);

  // Headline comparisons
  const headlineRows = [];
  for (const taskResult of phase2.tasks) {
    const A = cellSummary(taskResult, 'A');
    const E = cellSummary(taskResult, 'E');
    const F = cellSummary(taskResult, 'F');
    const B = cellSummary(taskResult, 'B');
    const D = cellSummary(taskResult, 'D');

    const costRatioFOverA = A.mean_cost_usd > 0 ? F.mean_cost_usd / A.mean_cost_usd : null;
    const amortBreakeven = F.mean_cost_usd > 0 ? A.mean_cost_usd / F.mean_cost_usd : null;
    const qualityLift = !E.any_oracle_pass && F.any_oracle_pass;

    headlineRows.push({
      task_id: taskResult.task_id,
      'A_oracle_rate': A.oracle_pass_rate,
      'E_oracle_rate': E.oracle_pass_rate,
      'F_oracle_rate': F.oracle_pass_rate,
      'A_mean_cost': A.mean_cost_usd,
      'E_mean_cost': E.mean_cost_usd,
      'F_mean_cost': F.mean_cost_usd,
      'B_mean_cost': B.mean_cost_usd,
      'D_mean_cost': D.mean_cost_usd,
      'cost_ratio_F_over_A': costRatioFOverA,
      'amortization_breakeven_N': amortBreakeven,
      'quality_lift_event': qualityLift,
    });
  }

  // Quality-lift events
  const qualityLiftEvents = headlineRows.filter((r) => r.quality_lift_event);

  // Print table
  console.log('Per-task verdict (HC-1..HC-4):');
  console.log('─'.repeat(80));
  for (const v of verdict.task_verdicts) {
    const hc = `HC1=${v.HC1 ? '✓' : '✗'} HC2=${v.HC2 ? '✓' : '✗'} HC3=${v.HC3 ? '✓' : '✗'} HC4=${v.HC4 ? '✓' : '✗'}`;
    console.log(`  ${v.task_id.padEnd(30)} ${hc}  → ${v.validated ? 'VALIDATED' : 'not validated'}`);
  }
  console.log('─'.repeat(80));
  console.log(
    `Hypothesis: ${verdict.hypothesis_validated ? '✓ VALIDATED' : '✗ NOT VALIDATED'} ` +
    `(${verdict.validated_task_count}/${verdict.total_task_count} tasks, ` +
    `${(verdict.validated_fraction * 100).toFixed(0)}% ≥ 50% threshold)`
  );
  console.log('');

  if (qualityLiftEvents.length > 0) {
    console.log(`Quality-lift events (E fails + F passes): ${qualityLiftEvents.length} task(s)`);
    for (const e of qualityLiftEvents) {
      console.log(`  ${e.task_id}: E pass_rate=${e.E_oracle_rate.toFixed(2)} → F pass_rate=${e.F_oracle_rate.toFixed(2)}`);
    }
    console.log('');
  }

  const dossier = {
    _decision: {
      id: 'DEC-BENCH-B4-V3-001',
      title: 'B4-v3 hypothesis-matrix measurement dossier',
      status: 'recorded',
      rationale: 'Observed values verbatim per honesty clause (issue #653). No softening.',
    },
    produced_at: new Date().toISOString(),
    phase1_run_id: phase1.run_id,
    phase2_run_id: phase2.run_id,
    phase1_total_cost_usd: phase1.total_cost_usd,
    phase2_total_cost_usd: phase2.total_cost_usd,
    hypothesis_verdict: verdict,
    headline_comparisons: headlineRows,
    quality_lift_events: qualityLiftEvents,
  };

  const outPath = flags['out'] ?? join(RESULTS_DIR, `dossier-${phase2.run_id}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(dossier, null, 2), 'utf8');
  console.log(`Dossier written: ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
