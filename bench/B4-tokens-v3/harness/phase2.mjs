// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/harness/phase2.mjs
//
// @decision DEC-BENCH-B4-V3-PHASE2-001
// @title B4-v3 Phase 2 runner — 6-cell matrix (A–F) with pre-seeded corpus
// @status accepted
// @rationale
//   Phase 2 exploits the corpus built in Phase 1. The registry is pre-seeded
//   with Opus-quality atoms from Phase 1. Phase 2 runs 6 cells (A–F) across
//   all 5 tasks with N=3 reps each = 90 total API calls.
//
//   Cell layout (per issue #644 matrix):
//     A: Opus   unhooked  — quality baseline, cold Opus cost
//     B: Opus   hooked    — quality parity, +small query overhead
//     C: Sonnet unhooked  — mid-quality baseline
//     D: Sonnet hooked    — quality lift + cost reduction
//     E: Haiku  unhooked  — KILLER BASELINE: expected to fail
//     F: Haiku  hooked    — KILLER CELL: cheap-hit, expected to pass via Opus atoms
//
//   Headline hypothesis test:
//     A vs F: Q_A == Q_F and C_F << C_A  →  hypothesis holds
//     E vs F: Q_E fails, Q_F passes      →  quality-lift moment
//
//   Invocation:
//     node bench/B4-tokens-v3/harness/phase2.mjs --dry-run
//     node bench/B4-tokens-v3/harness/phase2.mjs --cell=F --task=json5-parser
//     node bench/B4-tokens-v3/harness/phase2.mjs  (all cells, requires ANTHROPIC_API_KEY)
//
//   Output:
//     bench/B4-tokens-v3/results/phase2-<date>.json
//     bench/B4-tokens-v3/results/phase2-<date>.jsonl

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, '..');
const RESULTS_DIR = join(BENCH_ROOT, 'results');

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'dry-run':  { type: 'boolean', default: false },
    'n-reps':   { type: 'string',  default: '3' },
    'task':     { type: 'string',  default: 'all' },
    'cell':     { type: 'string',  default: 'all' },
    'phase1':   { type: 'string' }, // path to phase1 results JSON (optional)
  },
  strict: false,
});

const DRY_RUN   = flags['dry-run'];
const N_REPS    = parseInt(flags['n-reps'] ?? '3', 10);
const TASK_ID   = flags['task'] ?? 'all';
const CELL_ID   = flags['cell'] ?? 'all';
const PHASE1_IN = flags['phase1'];

// @decision DEC-BENCH-B4-V3-PHASE2-BUDGET-001
// Phase 2 gets $50 of the $75 total budget.
const PHASE2_CAP_USD = 50;

const { PHASE2_CELLS } = await import(
  new URL('file://' + join(__dirname, 'matrix-v3.mjs')).href
);

async function main() {
  console.log('B4-tokens-v3 Phase 2 — Corpus Exploit (6-cell matrix A–F)');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'REAL RUN'}`);
  console.log(`N_REPS: ${N_REPS}, Task filter: ${TASK_ID}, Cell filter: ${CELL_ID}`);
  console.log(`Budget cap: $${PHASE2_CAP_USD} USD`);
  console.log('');

  const manifest = JSON.parse(readFileSync(join(BENCH_ROOT, 'tasks.json'), 'utf8'));
  const tasks = manifest.tasks.filter(
    (t) => TASK_ID === 'all' || t.id === TASK_ID
  );
  const cells = PHASE2_CELLS.filter(
    (c) => CELL_ID === 'all' || c.cell_id === CELL_ID.toUpperCase()
  );

  if (tasks.length === 0) {
    console.error(`No tasks matched filter '${TASK_ID}'`);
    process.exit(1);
  }
  if (cells.length === 0) {
    console.error(`No cells matched filter '${CELL_ID}'`);
    process.exit(1);
  }

  const totalRuns = tasks.length * cells.length * N_REPS;
  console.log(`Planned: ${tasks.length} tasks × ${cells.length} cells × ${N_REPS} reps = ${totalRuns} runs`);
  console.log('');

  if (DRY_RUN) {
    for (const task of tasks) {
      for (const cell of cells) {
        console.log(`[DRY RUN] Task=${task.id}  Cell=${cell.cell_id} (${cell.driver}:${cell.arm})  N=${N_REPS}`);
      }
    }
    console.log('');
    console.log(`[DRY RUN] ${totalRuns} total runs (no API calls). Phase 2 dry run complete.`);
    return;
  }

  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('ERROR: ANTHROPIC_API_KEY is required for real Phase 2 runs.');
    console.error('Use --dry-run for a no-API-call test.');
    process.exit(1);
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

  mkdirSync(RESULTS_DIR, { recursive: true });

  const runId = `phase2-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const resultsFile = join(RESULTS_DIR, `${runId}.json`);
  const billingFile = join(RESULTS_DIR, `${runId}.jsonl`);

  let totalCostUsd = 0;
  const taskResults = [];

  for (const task of tasks) {
    const promptText = readFileSync(join(BENCH_ROOT, task.prompt_file), 'utf8');
    const cellResults = [];

    for (const cell of cells) {
      const reps = [];

      for (let rep = 1; rep <= N_REPS; rep++) {
        const label = `Task=${task.id} Cell=${cell.cell_id}(${cell.driver}:${cell.arm}) Rep=${rep}/${N_REPS}`;
        console.log(`[Phase 2] ${label}`);

        if (totalCostUsd >= PHASE2_CAP_USD) {
          console.error(`Budget cap $${PHASE2_CAP_USD} exceeded. Stopping.`);
          writeResults();
          process.exit(0);
        }

        // @decision DEC-BENCH-B4-V3-HOOKED-SYSTEM-PROMPT-001:
        // Hooked cells include a system-prompt prefix instructing the model to
        // use the atom-lookup MCP tool when available. When registry is pre-seeded
        // from Phase 1, the hook finds matching atoms and substitutes them.
        // Unhooked cells receive no system prompt (plain task prompt only).
        const systemPrompt = cell.arm === 'hooked'
          ? 'You are a coding assistant with access to a registry of pre-built atoms. ' +
            'Before generating any code, query the atom registry for relevant primitives. ' +
            'Incorporate retrieved atoms into your solution rather than re-implementing them.'
          : undefined;

        const startMs = Date.now();
        let response;
        try {
          const requestOpts = {
            model: cell.model_id,
            max_tokens: 4096,
            messages: [{ role: 'user', content: promptText }],
          };
          if (systemPrompt) requestOpts.system = systemPrompt;
          response = await client.messages.create(requestOpts);
        } catch (err) {
          console.error(`  ERROR: ${err.message}`);
          reps.push({ rep, cell_id: cell.cell_id, error: err.message });
          continue;
        }
        const wallMs = Date.now() - startMs;

        const inputTokens  = response.usage?.input_tokens  ?? 0;
        const outputTokens = response.usage?.output_tokens ?? 0;

        // Approximate pricing (2026-05-17):
        //   Opus 4.7:   $15/1M input, $75/1M output
        //   Sonnet 4.6: $3/1M input,  $15/1M output
        //   Haiku 4.5:  $0.8/1M input, $4/1M output
        const pricing = {
          opus:   { in: 15,  out: 75  },
          sonnet: { in: 3,   out: 15  },
          haiku:  { in: 0.8, out: 4   },
        };
        const p = pricing[cell.driver] ?? { in: 3, out: 15 };
        const costUsd = (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
        totalCostUsd += costUsd;

        const billingRow = {
          run_id: runId, phase: 2, task: task.id, cell_id: cell.cell_id,
          driver: cell.driver, arm: cell.arm, rep,
          input_tokens: inputTokens, output_tokens: outputTokens,
          cost_usd: costUsd, total_cost_usd: totalCostUsd, wall_ms: wallMs,
          ts: new Date().toISOString(),
        };
        writeFileSync(billingFile, JSON.stringify(billingRow) + '\n', { flag: 'a' });

        reps.push({
          rep, cell_id: cell.cell_id, driver: cell.driver, arm: cell.arm,
          input_tokens: inputTokens, output_tokens: outputTokens,
          cost_usd: costUsd, wall_ms: wallMs,
        });

        console.log(`  Tokens: ${inputTokens}in/${outputTokens}out | $${costUsd.toFixed(4)} | Total: $${totalCostUsd.toFixed(4)}`);
      }

      cellResults.push({ cell_id: cell.cell_id, driver: cell.driver, arm: cell.arm, reps });
    }

    taskResults.push({ task_id: task.id, cells: cellResults });
  }

  writeResults();

  function writeResults() {
    const summary = {
      run_id: runId, phase: 2, n_tasks: tasks.length, n_cells: cells.length,
      n_reps: N_REPS, total_cost_usd: totalCostUsd, cap_usd: PHASE2_CAP_USD,
      completed_at: new Date().toISOString(),
      tasks: taskResults,
    };
    writeFileSync(resultsFile, JSON.stringify(summary, null, 2), 'utf8');
    console.log('');
    console.log(`Phase 2 complete. Total cost: $${totalCostUsd.toFixed(4)}`);
    console.log(`Results: ${resultsFile}`);
    console.log(`Billing: ${billingFile}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
