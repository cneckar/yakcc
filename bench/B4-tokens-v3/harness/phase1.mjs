// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/harness/phase1.mjs
//
// @decision DEC-BENCH-B4-V3-PHASE1-001
// @title B4-v3 Phase 1 runner — Opus corpus-build (empty registry)
// @status accepted
// @rationale
//   Phase 1 is the investment phase. For each task, Opus runs against an empty
//   corpus (no atoms pre-seeded). The solution is captured and the shave
//   pipeline extracts atoms into the registry. Phase 1 establishes the atom
//   baseline that Phase 2 exploits.
//
//   Phase 1 is intentionally NOT run automatically. It requires:
//     1. A valid ANTHROPIC_API_KEY with Opus access
//     2. A running registry with the shave pipeline (#368 flywheel)
//     3. Operator review of the phase1 output before Phase 2 runs
//
//   Invocation:
//     node bench/B4-tokens-v3/harness/phase1.mjs --dry-run
//     node bench/B4-tokens-v3/harness/phase1.mjs  (requires ANTHROPIC_API_KEY)
//
//   Output:
//     bench/B4-tokens-v3/results/phase1-<date>.json  — per-task cost + oracle
//     bench/B4-tokens-v3/results/phase1-<date>.jsonl — JSONL billing log
//
//   Cost ceiling: $75 USD shared with Phase 2 (DEC-V0-B4-SLICE2-COST-CEILING-004).
//   Phase 1 alone uses roughly $5–15 (5 tasks × Opus × N=3 = 15 runs).

import { createHash } from 'node:crypto';
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
    'dry-run': { type: 'boolean', default: false },
    'n-reps':  { type: 'string',  default: '3' },
    'task':    { type: 'string',  default: 'all' },
  },
  strict: false,
});

const DRY_RUN  = flags['dry-run'];
const N_REPS   = parseInt(flags['n-reps'] ?? '3', 10);
const TASK_ID  = flags['task'] ?? 'all';

// @decision DEC-BENCH-B4-V3-PHASE1-BUDGET-001
// Phase 1 is allowed up to $25 of the $75 total budget. Phase 2 gets $50.
const PHASE1_CAP_USD = 25;

async function main() {
  console.log('B4-tokens-v3 Phase 1 — Corpus Build (Opus, empty registry)');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'REAL RUN'}`);
  console.log(`N_REPS: ${N_REPS}, Task filter: ${TASK_ID}`);
  console.log(`Budget cap: $${PHASE1_CAP_USD} USD`);
  console.log('');

  const manifest = JSON.parse(readFileSync(join(BENCH_ROOT, 'tasks.json'), 'utf8'));
  const tasks = manifest.tasks.filter(
    (t) => TASK_ID === 'all' || t.id === TASK_ID
  );

  if (tasks.length === 0) {
    console.error(`No tasks matched filter '${TASK_ID}'`);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would run Phase 1 on ${tasks.length} tasks × N=${N_REPS} reps`);
    console.log(`[DRY RUN] Tasks: ${tasks.map(t => t.id).join(', ')}`);
    console.log(`[DRY RUN] Driver: claude-opus-4-7 (unhooked, empty corpus)`);
    console.log('');
    console.log('Phase 1 dry run complete. No API calls made.');
    return;
  }

  // Real run requires ANTHROPIC_API_KEY
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('ERROR: ANTHROPIC_API_KEY is required for real Phase 1 runs.');
    console.error('Use --dry-run for a no-API-call test.');
    process.exit(1);
  }

  // Import SDK lazily (not needed in dry-run mode)
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

  mkdirSync(RESULTS_DIR, { recursive: true });

  const runId = `phase1-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const resultsFile = join(RESULTS_DIR, `${runId}.json`);
  const billingFile = join(RESULTS_DIR, `${runId}.jsonl`);

  let totalCostUsd = 0;
  const taskResults = [];

  for (const task of tasks) {
    const promptText = readFileSync(join(BENCH_ROOT, task.prompt_file), 'utf8');
    const reps = [];

    for (let rep = 1; rep <= N_REPS; rep++) {
      console.log(`[Phase 1] Task=${task.id} Rep=${rep}/${N_REPS} Driver=opus (unhooked)`);

      if (totalCostUsd >= PHASE1_CAP_USD) {
        console.error(`Budget cap $${PHASE1_CAP_USD} exceeded at task=${task.id} rep=${rep}. Stopping.`);
        break;
      }

      const startMs = Date.now();
      let response;
      try {
        response = await client.messages.create({
          model: 'claude-opus-4-7',
          max_tokens: 4096,
          messages: [{ role: 'user', content: promptText }],
        });
      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
        reps.push({ rep, error: err.message });
        continue;
      }
      const wallMs = Date.now() - startMs;

      const inputTokens  = response.usage?.input_tokens  ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      // Opus 4.7 pricing (approximate): $15/1M input, $75/1M output
      const costUsd = (inputTokens * 15 + outputTokens * 75) / 1_000_000;
      totalCostUsd += costUsd;

      const generatedText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      const billingRow = {
        run_id: runId, phase: 1, task: task.id, rep, driver: 'opus',
        arm: 'unhooked', input_tokens: inputTokens, output_tokens: outputTokens,
        cost_usd: costUsd, total_cost_usd: totalCostUsd, wall_ms: wallMs,
        ts: new Date().toISOString(),
      };
      writeFileSync(billingFile, JSON.stringify(billingRow) + '\n', { flag: 'a' });

      reps.push({
        rep, input_tokens: inputTokens, output_tokens: outputTokens,
        cost_usd: costUsd, wall_ms: wallMs,
        response_length: generatedText.length,
      });

      console.log(`  Tokens: ${inputTokens}in / ${outputTokens}out | Cost: $${costUsd.toFixed(4)} | Total: $${totalCostUsd.toFixed(4)}`);
    }

    taskResults.push({ task_id: task.id, reps });
  }

  const summary = {
    run_id: runId, phase: 1, n_tasks: tasks.length, n_reps: N_REPS,
    total_cost_usd: totalCostUsd, cap_usd: PHASE1_CAP_USD,
    completed_at: new Date().toISOString(),
    tasks: taskResults,
  };
  writeFileSync(resultsFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log('');
  console.log(`Phase 1 complete. Total cost: $${totalCostUsd.toFixed(4)}`);
  console.log(`Results: ${resultsFile}`);
  console.log(`Billing: ${billingFile}`);
  console.log('');
  console.log('Next step: review phase1 output, verify atom extraction, then run phase2.mjs.');
}

main().catch(err => { console.error(err); process.exit(1); });
