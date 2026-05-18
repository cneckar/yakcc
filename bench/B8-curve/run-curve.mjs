#!/usr/bin/env node
/**
 * run-curve.mjs — B8-CURVE S1 CLI entry point.
 *
 * @decision DEC-BENCH-B8-CURVE-SLICE1-001
 * @title B8-CURVE S1 uses cached-truth-table sampling over a committed B8-SYNTHETIC artifact.
 * @status accepted
 * @rationale
 *   Zero LLM cost is a hard constraint; this worktree does not have a built
 *   packages/registry/dist/ or bootstrap/yakcc.registry.sqlite. The B8-SYNTHETIC
 *   committed results carry per-block `hit` truth from a prior real run with
 *   documented corpus_sha256 and registry_path. Sampling that truth table at
 *   fraction f is mathematically equivalent to re-running the simulator on a
 *   deterministic subset of the corpus (because the simulator is deterministic
 *   given fixed registry state). Provenance is preserved in the output
 *   _meta.source_artifact block.
 *
 *   Source artifact precedence: when multiple bench/B8-synthetic/results-*.json
 *   files are present, we take the lexicographic maximum (lex-max) filename.
 *   This means the linux revalidation (results-linux-2026-05-17-revalidation-slice1.json)
 *   is preferred over the darwin slice (results-darwin-2026-05-14-slice1.json) for
 *   the current corpus. Use --source to override.
 *
 * Usage:
 *   node bench/B8-curve/run-curve.mjs [--seed N] [--source <path>] [--fractions f,...] [--out <path>]
 *
 * Defaults:
 *   --seed 42
 *   --source  lex-max of bench/B8-synthetic/results-*.json
 *   --fractions 0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0
 *   --out bench/B8-curve/results/curve-N10-YYYY-MM-DD.json
 *
 * Emits:
 *   JSON artifact at --out path
 *   Stdout: markdown curve tables + ASCII plot + decision-point footer
 *
 * Cross-reference: #193, #167, #192, DEC-BENCH-SUITE-CHARACTERISATION-001,
 *                  DEC-BENCH-B8-SYNTHETIC-SLICE1-001
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { COMPARATORS, runPerFLoop } from './per-f-loop.mjs';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    seed:      { type: 'string',  default: '42' },
    source:    { type: 'string' },
    fractions: { type: 'string' },
    out:       { type: 'string' },
  },
  strict: false,
});

const seed = parseInt(args.seed, 10);
if (!Number.isInteger(seed) || seed < 0) {
  console.error(`FATAL: --seed must be a non-negative integer; got "${args.seed}"`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Resolve source artifact path
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const syntheticDir = join(repoRoot, 'bench', 'B8-synthetic');

let sourcePath;
if (args.source) {
  sourcePath = resolve(args.source);
} else {
  // Lex-max of bench/B8-synthetic/results-*.json
  let candidates;
  try {
    candidates = readdirSync(syntheticDir)
      .filter(f => f.startsWith('results-') && f.endsWith('.json'))
      .sort();
  } catch (e) {
    console.error(`FATAL: Cannot read bench/B8-synthetic/ directory: ${e.message}`);
    process.exit(1);
  }
  if (candidates.length === 0) {
    console.error('FATAL: No results-*.json files found in bench/B8-synthetic/');
    process.exit(1);
  }
  sourcePath = join(syntheticDir, candidates[candidates.length - 1]);
}

// ---------------------------------------------------------------------------
// Load and validate source artifact
// ---------------------------------------------------------------------------

console.log(`Loading source artifact: ${sourcePath}`);

let sourceArtifact;
try {
  sourceArtifact = JSON.parse(readFileSync(sourcePath, 'utf-8'));
} catch (e) {
  console.error(`FATAL: Cannot read/parse source artifact at "${sourcePath}": ${e.message}`);
  process.exit(1);
}

// Loud validation — Sacred Practice #5
if (sourceArtifact?._meta?.benchmark !== 'B8-SYNTHETIC') {
  console.error(
    `FATAL: Source artifact _meta.benchmark must be "B8-SYNTHETIC"; ` +
    `got "${sourceArtifact?._meta?.benchmark}". Pass --source to specify the correct file.`
  );
  process.exit(1);
}
if (sourceArtifact._meta.corpus_n !== 10) {
  console.error(
    `FATAL: Source artifact _meta.corpus_n must be 10; got ${sourceArtifact._meta.corpus_n}.`
  );
  process.exit(1);
}
const perTask = sourceArtifact.per_task;
if (!Array.isArray(perTask) || perTask.length === 0) {
  console.error('FATAL: Source artifact per_task must be a non-empty array.');
  process.exit(1);
}
// Verify each task has a blocks array with hit + raw_tokens
for (const task of perTask) {
  if (!Array.isArray(task.blocks)) {
    console.error(`FATAL: Task "${task.task_id}" is missing blocks[]. Schema drift?`);
    process.exit(1);
  }
  for (const block of task.blocks) {
    if (typeof block.hit !== 'boolean') {
      console.error(
        `FATAL: Task "${task.task_id}" block "${block.block_id}" missing boolean .hit`
      );
      process.exit(1);
    }
    if (typeof block.raw_tokens !== 'number') {
      console.error(
        `FATAL: Task "${task.task_id}" block "${block.block_id}" missing numeric .raw_tokens`
      );
      process.exit(1);
    }
  }
}

// Compute source artifact SHA-256 for provenance
const sourceBytes = readFileSync(sourcePath);
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
console.log(`Source artifact SHA-256: ${sourceSha256}`);
console.log(`Corpus N: ${sourceArtifact._meta.corpus_n}, corpus SHA-256: ${sourceArtifact._meta.corpus_sha256}`);

// ---------------------------------------------------------------------------
// Parse fractions
// ---------------------------------------------------------------------------

let fractions;
if (args.fractions) {
  fractions = args.fractions.split(',').map(s => {
    const f = parseFloat(s.trim());
    if (Number.isNaN(f) || f < 0 || f > 1) {
      console.error(`FATAL: Invalid fraction value "${s.trim()}". Must be in [0,1].`);
      process.exit(1);
    }
    return f;
  });
  // Sort ascending for stable output
  fractions.sort((a, b) => a - b);
} else {
  fractions = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
}

// ---------------------------------------------------------------------------
// Resolve output path
// ---------------------------------------------------------------------------

const todayUtc = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const defaultOutPath = join(
  repoRoot, 'bench', 'B8-curve', 'results',
  `curve-N${sourceArtifact._meta.corpus_n}-${todayUtc}.json`
);
const outPath = args.out ? resolve(args.out) : defaultOutPath;

// ---------------------------------------------------------------------------
// Run the per-f loop
// ---------------------------------------------------------------------------

console.log(`\nRunning per-f loop: seed=${seed}, fractions=[${fractions.join(', ')}]`);
const startMs = Date.now();

const rows = runPerFLoop({
  tasks: perTask,
  fractions,
  seed,
  comparators: COMPARATORS,
});

const elapsedMs = Date.now() - startMs;
console.log(`Per-f loop complete in ${elapsedMs}ms (${rows.length} rows)\n`);

// ---------------------------------------------------------------------------
// Monotonicity assertion — hooked × all_tasks mean_hit_rate must be
// non-decreasing in f for fixed seed (DEC-BENCH-B8-CURVE-MONOTONE-SAMPLING-001)
// ---------------------------------------------------------------------------

const hookedAllRows = rows
  .filter(r => r.comparator === 'hooked' && r.curve === 'all_tasks' && r.mean_hit_rate !== null)
  .sort((a, b) => a.f - b.f);

let prevHitRate = -Infinity;
for (const row of hookedAllRows) {
  if (row.mean_hit_rate < prevHitRate - 1e-9) {
    console.error(
      `FATAL: Monotonicity violation in hooked×all_tasks mean_hit_rate at f=${row.f}: ` +
      `${row.mean_hit_rate} < ${prevHitRate}. ` +
      `This should never happen with monotone-stable sampling.`
    );
    process.exit(1);
  }
  prevHitRate = row.mean_hit_rate;
}

// ---------------------------------------------------------------------------
// Build artifact
// ---------------------------------------------------------------------------

const asciiPlot = buildAsciiPlot(rows, fractions);

const artifact = {
  _meta: {
    benchmark: 'B8-CURVE',
    slice: 1,
    decision: 'DEC-BENCH-B8-CURVE-SLICE1-001',
    generated_at: new Date().toISOString(),
    seed,
    fractions,
    source_artifact: {
      path: sourcePath,
      sha256: sourceSha256,
      corpus_n: sourceArtifact._meta.corpus_n,
      corpus_sha256: sourceArtifact._meta.corpus_sha256,
    },
    comparators: Object.keys(COMPARATORS),
    curves: ['all_tasks', 'tasks_with_coverage'],
    note: 'S1 cached-truth-table sampling. See bench/B8-curve/README.md for semantics.',
  },
  rows,
  ascii_plot: asciiPlot,
};

// ---------------------------------------------------------------------------
// Write artifact
// ---------------------------------------------------------------------------

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}\n`);

// ---------------------------------------------------------------------------
// Print curve tables to stdout
// ---------------------------------------------------------------------------

printCurveTable(rows, 'hooked', 'all_tasks', 'Hooked × All Tasks');
printCurveTable(rows, 'hooked', 'tasks_with_coverage', 'Hooked × Tasks With Coverage');
printCurveTable(rows, 'naive', 'all_tasks', 'Naive × All Tasks (floor; should be 0% everywhere)');

// ASCII plot
console.log(asciiPlot);

// Decision-point footer
printDecisionFooter(rows, fractions);

// ---------------------------------------------------------------------------
// Helpers — output formatting
// ---------------------------------------------------------------------------

/**
 * Print a markdown table for one (comparator, curve) slice.
 */
function printCurveTable(rows, comparator, curve, title) {
  const slice = rows
    .filter(r => r.comparator === comparator && r.curve === curve)
    .sort((a, b) => a.f - b.f);

  console.log(`### ${title}\n`);
  console.log('| f    | n_tasks | mean_hit_rate | mean_savings_pct | total_savings_pct |');
  console.log('|------|---------|---------------|------------------|-------------------|');
  for (const row of slice) {
    const n    = row.n_tasks_sampled;
    const hr   = row.mean_hit_rate   !== null ? (row.mean_hit_rate   * 100).toFixed(1).padStart(6) + '%' : '   null';
    const ms   = row.mean_savings_pct !== null ? (row.mean_savings_pct * 100).toFixed(1).padStart(6) + '%' : '   null';
    const ts   = row.total_savings_pct !== null ? (row.total_savings_pct * 100).toFixed(1).padStart(6) + '%' : '   null';
    console.log(`| ${row.f.toFixed(1)} | ${String(n).padStart(7)} | ${hr.padStart(13)} | ${ms.padStart(16)} | ${ts.padStart(17)} |`);
  }
  console.log('');
}

/**
 * Build a 60-column ASCII plot of mean_savings_pct for hooked×all_tasks
 * and hooked×tasks_with_coverage, x-axis = f, y-axis = mean_savings_pct.
 *
 * Returns the multi-line string (also printed separately).
 */
function buildAsciiPlot(rows, fractions) {
  const PLOT_WIDTH  = 60;
  const PLOT_HEIGHT = 20;

  const allSeries = rows
    .filter(r => r.comparator === 'hooked' && r.curve === 'all_tasks')
    .sort((a, b) => a.f - b.f)
    .map(r => r.mean_savings_pct);

  const covSeries = rows
    .filter(r => r.comparator === 'hooked' && r.curve === 'tasks_with_coverage')
    .sort((a, b) => a.f - b.f)
    .map(r => r.mean_savings_pct);

  // Determine y range across both series (exclude nulls)
  const allValues = [...allSeries, ...covSeries].filter(v => v !== null);
  if (allValues.length === 0) {
    return '(no data to plot)\n';
  }
  const yMin = Math.min(0, ...allValues);
  const yMax = Math.max(0, ...allValues);
  const yRange = yMax - yMin || 0.01; // avoid /0

  // Build grid: PLOT_HEIGHT rows × PLOT_WIDTH cols
  const grid = Array.from({ length: PLOT_HEIGHT }, () => Array(PLOT_WIDTH).fill(' '));

  function plotSeries(series, marker) {
    const n = fractions.length;
    for (let i = 0; i < n; i++) {
      const v = series[i];
      if (v === null || v === undefined) continue;
      const col = Math.round((i / Math.max(n - 1, 1)) * (PLOT_WIDTH - 1));
      const row = Math.round(((yMax - v) / yRange) * (PLOT_HEIGHT - 1));
      const r = Math.max(0, Math.min(PLOT_HEIGHT - 1, row));
      const c = Math.max(0, Math.min(PLOT_WIDTH - 1, col));
      grid[r][c] = marker;
    }
  }

  plotSeries(allSeries, 'A'); // A = all_tasks
  plotSeries(covSeries, 'C'); // C = tasks_with_coverage (may overlap A → X)

  // Overlay overlap marker
  for (let r = 0; r < PLOT_HEIGHT; r++) {
    for (let c = 0; c < PLOT_WIDTH; c++) {
      // Already handled: each series writes its own marker; overlaps show last writer.
      // Re-check: if both would plot here, mark X.
    }
  }

  // Detect overlaps by replaying with a second pass
  const gridA = Array.from({ length: PLOT_HEIGHT }, () => Array(PLOT_WIDTH).fill(false));
  const gridC = Array.from({ length: PLOT_HEIGHT }, () => Array(PLOT_WIDTH).fill(false));
  const n = fractions.length;
  for (let i = 0; i < n; i++) {
    const vA = allSeries[i];
    const vC = covSeries[i];
    const col = Math.round((i / Math.max(n - 1, 1)) * (PLOT_WIDTH - 1));
    if (vA !== null && vA !== undefined) {
      const row = Math.round(((yMax - vA) / yRange) * (PLOT_HEIGHT - 1));
      gridA[Math.max(0, Math.min(PLOT_HEIGHT - 1, row))][Math.max(0, Math.min(PLOT_WIDTH - 1, col))] = true;
    }
    if (vC !== null && vC !== undefined) {
      const row = Math.round(((yMax - vC) / yRange) * (PLOT_HEIGHT - 1));
      gridC[Math.max(0, Math.min(PLOT_HEIGHT - 1, row))][Math.max(0, Math.min(PLOT_WIDTH - 1, col))] = true;
    }
  }
  for (let r = 0; r < PLOT_HEIGHT; r++) {
    for (let c = 0; c < PLOT_WIDTH; c++) {
      if (gridA[r][c] && gridC[r][c]) {
        grid[r][c] = 'X';
      } else if (gridA[r][c]) {
        grid[r][c] = 'A';
      } else if (gridC[r][c]) {
        grid[r][c] = 'C';
      }
    }
  }

  // Add zero-line
  const zeroRow = Math.round(((yMax - 0) / yRange) * (PLOT_HEIGHT - 1));
  const zr = Math.max(0, Math.min(PLOT_HEIGHT - 1, zeroRow));
  for (let c = 0; c < PLOT_WIDTH; c++) {
    if (grid[zr][c] === ' ') grid[zr][c] = '-';
  }

  const lines = [];
  lines.push('');
  lines.push('ASCII Plot — mean_savings_pct vs fraction f');
  lines.push(`  y-axis: ${(yMin * 100).toFixed(1)}% to ${(yMax * 100).toFixed(1)}%`);
  lines.push('  A = hooked×all_tasks, C = hooked×tasks_with_coverage, X = overlap');
  lines.push('  - = zero savings line');
  lines.push('');
  lines.push(`  ${(yMax * 100).toFixed(1).padStart(6)}% |`);
  for (let r = 0; r < PLOT_HEIGHT; r++) {
    const yVal = yMax - (r / (PLOT_HEIGHT - 1)) * yRange;
    const label = (yVal * 100).toFixed(1).padStart(7) + '% |';
    if (r % 4 === 0) {
      lines.push(`  ${label}${grid[r].join('')}`);
    } else {
      lines.push(`           |${grid[r].join('')}`);
    }
  }
  lines.push(`           +${'-'.repeat(PLOT_WIDTH)}`);
  // x-axis labels: f=0.0 at left, f=1.0 at right
  const xLabel = '  f:        0.0' + ' '.repeat(PLOT_WIDTH - 15) + '1.0';
  lines.push(xLabel);
  lines.push('');

  return lines.join('\n');
}

/**
 * Print the decision-point footer block (S2 corpus expansion trigger conditions).
 */
function printDecisionFooter(rows, fractions) {
  const hookedAll = rows
    .filter(r => r.comparator === 'hooked' && r.curve === 'all_tasks')
    .sort((a, b) => a.f - b.f);

  const atF1 = hookedAll.find(r => Math.abs(r.f - 1.0) < 1e-9);
  const atF06 = hookedAll.find(r => Math.abs(r.f - 0.6) < 1e-9);
  const atF03 = hookedAll.find(r => Math.abs(r.f - 0.3) < 1e-9);

  // Compute slope between f=0.6 and f=1.0 to assess whether curve is still climbing
  let slopeObservation = '(insufficient fractions to assess)';
  if (atF06 && atF1 && atF06.mean_savings_pct !== null && atF1.mean_savings_pct !== null) {
    const delta = (atF1.mean_savings_pct - atF06.mean_savings_pct) * 100;
    if (Math.abs(delta) < 0.5) {
      slopeObservation = `flat (Δ=${delta.toFixed(2)}pp from f=0.6 to f=1.0) → curve has asymptoted`;
    } else if (delta > 0) {
      slopeObservation = `still climbing (Δ=+${delta.toFixed(2)}pp from f=0.6 to f=1.0) → N=10 may be insufficient`;
    } else {
      slopeObservation = `declining (Δ=${delta.toFixed(2)}pp from f=0.6 to f=1.0) → unexpected; inspect data`;
    }
  }

  console.log('---');
  console.log('## Decision Point: Is S2 Corpus Expansion Warranted?\n');
  console.log(`Curve slope (f=0.6 → f=1.0): ${slopeObservation}\n`);
  console.log('Three observable conditions determine whether to proceed to S2:\n');
  console.log(
    '  1. Curve asymptotes cleanly by f≈0.6\n' +
    '     → N=10 is sufficient resolution; S2 likely not needed.\n' +
    '     → Close #193, defer S2 indefinitely with documented rationale.\n'
  );
  console.log(
    '  2. Curve still climbing steeply at f=1.0\n' +
    '     → N=10 is too small; S2 expansion warranted.\n' +
    '     → File S2 corpus-expansion work item with target N (e.g. 30 or 100).\n'
  );
  console.log(
    '  3. High variance run-to-run at fixed f (verify by re-running with different seeds)\n' +
    '     → N=10 is too small; S2 expansion warranted.\n' +
    '     → File S2 corpus-expansion work item with seed-variance evidence.\n'
  );
  console.log(
    'Re-run with a different seed to check variance:\n' +
    '  node bench/B8-curve/run-curve.mjs --seed 123\n' +
    '  node bench/B8-curve/run-curve.mjs --seed 999\n'
  );
  console.log('---\n');
}
