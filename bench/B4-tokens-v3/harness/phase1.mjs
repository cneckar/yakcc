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
//     bench/B4-tokens-v3/results/phase1-<date>.jsonl — billing log
//
//   Cost ceiling: $75 USD shared with Phase 2 (DEC-V0-B4-SLICE2-COST-CEILING-004).
//   Phase 1 alone uses roughly $5–15 (5 tasks × Opus × N=3 = 15 runs).

import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, '..');
const REPO_ROOT = process.env['YAKCC_REPO_ROOT'] ?? resolve(__dirname, '../../..');
const RESULTS_DIR = join(BENCH_ROOT, 'results');
const TMP_ROOT = join(REPO_ROOT, 'tmp', 'B4-tokens-v3');

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

// Import harness modules
const { extractCode, runOracle } = await import(
  new URL('file://' + join(__dirname, 'oracle-runner.mjs')).href
);
const { BillingLog, estimateCostUsd } = await import(
  new URL('file://' + join(__dirname, 'billing.mjs')).href
);
const { BudgetTracker, BudgetExceededError } = await import(
  new URL('file://' + join(__dirname, 'budget.mjs')).href
);
const { verifyTaskManifest } = await import(
  new URL('file://' + join(__dirname, 'verify.mjs')).href
);
const { syncAtoms } = await import(
  new URL('file://' + join(__dirname, 'atom-sync.mjs')).href
);

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
    console.log(`[DRY RUN] Tasks: ${tasks.map((t) => t.id).join(', ')}`);
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

  // Verify task prompts match their SHA-256 hashes before any API spend
  verifyTaskManifest(manifest, BENCH_ROOT);

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

  mkdirSync(RESULTS_DIR, { recursive: true });

  const runId = `phase1-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const resultsFile = join(RESULTS_DIR, `${runId}.json`);

  // B1 fix: per-run registry isolated to this run (no fallback to prod registry).
  // Set YAKCC_REGISTRY_PATH so Phase 2 can locate it by env var.
  const registryDir = join(TMP_ROOT, runId);
  const registryPath = join(registryDir, 'registry.sqlite');
  mkdirSync(registryDir, { recursive: true });
  process.env['YAKCC_REGISTRY_PATH'] = registryPath;
  const implScratchDir = join(registryDir, 'impl-scratch');
  mkdirSync(implScratchDir, { recursive: true });

  const budget = new BudgetTracker({ cap_usd: PHASE1_CAP_USD });
  const billingLog = new BillingLog({ dir: RESULTS_DIR, runId });

  const taskResults = [];

  for (const task of tasks) {
    const promptText = readFileSync(join(BENCH_ROOT, task.prompt_file), 'utf8');
    const reps = [];

    for (let rep = 1; rep <= N_REPS; rep++) {
      console.log(`[Phase 1] Task=${task.id} Rep=${rep}/${N_REPS} Driver=opus (unhooked)`);

      // Pre-call budget check (conservative estimate: 2000in + 1000out tokens for Opus)
      const estCost = estimateCostUsd({
        model_id: 'claude-opus-4-7',
        input_tokens: 2000,
        output_tokens: 1000,
      });
      try {
        budget.checkBeforeCall(estCost);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          console.error(`[BUDGET] ${err.message}`);
          writeResults();
          process.exit(0);
        }
        throw err;
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
      const costUsd = estimateCostUsd({
        model_id: 'claude-opus-4-7',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      });

      budget.addSpend(costUsd);
      budget.logRollingSpend({ phase: 1, taskId: task.id, rep, callCost: costUsd });

      // Extract generated code and run oracle to capture Q_p1
      const generatedText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const generatedCode = extractCode(generatedText);
      const oracle = await runOracle(task.id, generatedCode);

      // B1 fix: write generated code to a temp .ts file and extract atoms into
      // the per-run registry. BlockMerkleRoots are captured in the billing artifact
      // so the dossier can trace which atoms came from which Phase 1 rep.
      const implHash = createHash('sha256').update(generatedCode).digest('hex').slice(0, 12);
      const implFile = join(implScratchDir, `${task.id}-rep${rep}-${implHash}.ts`);
      let atomMerkleRoots = [];
      if (generatedCode.trim()) {
        writeFileSync(implFile, generatedCode, 'utf8');
        atomMerkleRoots = await syncAtoms({ implFile, registryPath, repoRoot: REPO_ROOT });
        try { rmSync(implFile); } catch (_) {}
      }

      console.log(
        `  Oracle: ${oracle.oracle_passed ? 'PASS' : 'FAIL'} ` +
        `(${oracle.oracle_pass_count}/${oracle.oracle_total}) | ` +
        `in=${inputTokens} out=${outputTokens} | $${costUsd.toFixed(4)} | ` +
        `atoms=${atomMerkleRoots.length}`
      );

      billingLog.append({
        run_id: runId, phase: 1, task_id: task.id, rep,
        driver: 'opus', arm: 'unhooked',
        model_id: 'claude-opus-4-7',
        input_tokens: inputTokens, output_tokens: outputTokens,
        cost_usd: costUsd, cumulative_cost_usd: budget.cumulativeUsd,
        wall_ms: wallMs, ts: new Date().toISOString(),
        atom_merkle_roots: atomMerkleRoots,
      });

      reps.push({
        rep,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        wall_ms: wallMs,
        oracle_passed: oracle.oracle_passed,
        oracle_pass_count: oracle.oracle_pass_count,
        oracle_total: oracle.oracle_total,
        oracle_failures: oracle.oracle_failures,
        atom_merkle_roots: atomMerkleRoots,
      });
    }

    taskResults.push({ task_id: task.id, reps });
  }

  writeResults();

  function writeResults() {
    const summary = {
      run_id: runId, phase: 1,
      n_tasks: tasks.length, n_reps: N_REPS,
      total_cost_usd: budget.cumulativeUsd,
      cap_usd: PHASE1_CAP_USD,
      registry_path: registryPath,
      completed_at: new Date().toISOString(),
      tasks: taskResults,
    };
    writeFileSync(resultsFile, JSON.stringify(summary, null, 2), 'utf8');
    console.log('');
    console.log(`Phase 1 complete. Total cost: $${budget.cumulativeUsd.toFixed(4)}`);
    console.log(`Results: ${resultsFile}`);
    console.log(`Billing: ${billingLog.path}`);
    console.log(`Registry: ${registryPath}`);
    console.log('');
    console.log('Next step: set YAKCC_REGISTRY_PATH to the registry above, then run phase2.mjs.');
    console.log(`  export YAKCC_REGISTRY_PATH='${registryPath}'`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
