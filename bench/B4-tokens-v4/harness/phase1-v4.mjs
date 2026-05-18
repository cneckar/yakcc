// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v4/harness/phase1-v4.mjs
//
// @decision DEC-BENCH-B4-V4-PHASE1-001
// @title B4-v4 Phase 1 — dual-shave corpus build (fine-grained L0 + whole-impl coarse)
// @status accepted
// @rationale
//   Extends B4-v3 phase1.mjs with the DEC-B4-V4-CORPUS-COMPOSITE-001 dual-shave:
//   after each Opus emission, run BOTH fine-grained shave (default, L0 atoms) AND
//   coarse shave (maxControlFlowBoundaries=999, whole-impl atom). The registry
//   receives both sets of atoms for every rep. This corrects the B4-v3 null finding
//   where all 194 atoms were L0 leaf-level and the hook could not find a
//   task-scale candidate for rescue (DEC-BENCH-B4-V3-001 §5).
//
//   Invocation:
//     node bench/B4-tokens-v4/harness/phase1-v4.mjs --dry-run
//     node bench/B4-tokens-v4/harness/phase1-v4.mjs  (requires ANTHROPIC_API_KEY)
//
//   Output:
//     bench/B4-tokens-v4/results/phase1-<date>.json
//     bench/B4-tokens-v4/results/phase1-<date>.jsonl

import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, '..');
const REPO_ROOT = process.env['YAKCC_REPO_ROOT'] ?? resolve(__dirname, '../../..');
const RESULTS_DIR = join(BENCH_ROOT, 'results');
const TMP_ROOT = join(REPO_ROOT, 'tmp', 'B4-tokens-v4');

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'dry-run': { type: 'boolean', default: false },
    'n-reps':  { type: 'string',  default: '3' },
    'task':    { type: 'string',  default: 'all' },
  },
  strict: false,
});

const DRY_RUN = flags['dry-run'];
const N_REPS  = parseInt(flags['n-reps'] ?? '3', 10);
const TASK_ID = flags['task'] ?? 'all';

// Phase 1 budget: $25 of $75 total (inherited from DEC-V0-B4-SLICE2-COST-CEILING-004)
const PHASE1_CAP_USD = 25;

const { syncAtoms, syncWholeImpl } = await import(
  new URL('file://' + join(__dirname, 'atom-sync-v4.mjs')).href
);
const { verifyTaskManifest } = await import(
  new URL('file://' + join(__dirname, 'verify-v4.mjs')).href
);

async function main() {
  console.log('B4-tokens-v4 Phase 1 — Dual-shave Corpus Build (Opus, empty registry)');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'REAL RUN'}`);
  console.log(`N_REPS: ${N_REPS}, Task filter: ${TASK_ID}`);
  console.log(`Budget cap: $${PHASE1_CAP_USD} USD`);
  console.log('');

  const manifest = JSON.parse(readFileSync(join(BENCH_ROOT, 'tasks.json'), 'utf8'));
  const tasks = manifest.tasks.filter(
    (t) => TASK_ID === 'all' || t.id === TASK_ID,
  );

  if (tasks.length === 0) {
    console.error(`No tasks matched filter '${TASK_ID}'`);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would run Phase 1 on ${tasks.length} tasks × N=${N_REPS} reps`);
    console.log(`[DRY RUN] Tasks: ${tasks.map((t) => t.id).join(', ')}`);
    console.log(`[DRY RUN] Driver: claude-opus-4-7 (unhooked, empty corpus)`);
    console.log(`[DRY RUN] Dual-shave: fine-grained (maxCF=1) + coarse (maxCF=999)`);
    console.log('');
    console.log('Phase 1 dry run complete. No API calls made.');
    return;
  }

  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('ERROR: ANTHROPIC_API_KEY is required for real Phase 1 runs.');
    console.error('Use --dry-run for a no-API-call test.');
    process.exit(1);
  }

  verifyTaskManifest(manifest, BENCH_ROOT);

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

  mkdirSync(RESULTS_DIR, { recursive: true });

  const runId = `phase1-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const resultsFile = join(RESULTS_DIR, `${runId}.json`);

  const registryDir = join(TMP_ROOT, runId);
  const registryPath = join(registryDir, 'registry.sqlite');
  mkdirSync(registryDir, { recursive: true });
  process.env['YAKCC_REGISTRY_PATH'] = registryPath;

  const implScratchDir = join(registryDir, 'impl-scratch');
  mkdirSync(implScratchDir, { recursive: true });

  let totalCostUsd = 0;
  const billingLines = [];
  const taskResults = [];

  for (const task of tasks) {
    const promptText = readFileSync(join(BENCH_ROOT, task.prompt_file), 'utf8');
    const reps = [];

    for (let rep = 1; rep <= N_REPS; rep++) {
      console.log(`[Phase 1] Task=${task.id} Rep=${rep}/${N_REPS} Driver=opus (unhooked)`);

      if (totalCostUsd >= PHASE1_CAP_USD) {
        console.error(`[BUDGET] Phase 1 cap $${PHASE1_CAP_USD} reached. Stopping.`);
        writeResults();
        process.exit(0);
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
      const costUsd = estimateCost('claude-opus-4-7', inputTokens, outputTokens);
      totalCostUsd += costUsd;

      const generatedText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const generatedCode = extractCode(generatedText);

      let fineRoots = [];
      let coarseRoots = [];
      if (generatedCode.trim()) {
        const implHash = createHash('sha256').update(generatedCode).digest('hex').slice(0, 12);
        const implFile = join(implScratchDir, `${task.id}-rep${rep}-${implHash}.ts`);
        writeFileSync(implFile, generatedCode, 'utf8');

        // Pass 1: fine-grained atoms (L0 leaves, same as B4-v3)
        fineRoots = await syncAtoms({ implFile, registryPath, repoRoot: REPO_ROOT });
        // Pass 2: coarse whole-impl atom (DEC-B4-V4-CORPUS-COMPOSITE-001)
        coarseRoots = await syncWholeImpl({ implFile, registryPath, repoRoot: REPO_ROOT });

        try { rmSync(implFile); } catch (_) {}
      }

      console.log(
        `  in=${inputTokens} out=${outputTokens} | $${costUsd.toFixed(4)} | ` +
        `atoms_fine=${fineRoots.length} atoms_coarse=${coarseRoots.length}`,
      );

      const entry = {
        run_id: runId, phase: 1, task_id: task.id, rep,
        driver: 'opus', arm: 'unhooked', model_id: 'claude-opus-4-7',
        input_tokens: inputTokens, output_tokens: outputTokens,
        cost_usd: costUsd, cumulative_cost_usd: totalCostUsd,
        wall_ms: wallMs, ts: new Date().toISOString(),
        atom_merkle_roots_fine: fineRoots,
        atom_merkle_roots_coarse: coarseRoots,
      };
      billingLines.push(entry);

      reps.push({
        rep,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        wall_ms: wallMs,
        atom_merkle_roots_fine: fineRoots,
        atom_merkle_roots_coarse: coarseRoots,
      });
    }

    taskResults.push({ task_id: task.id, reps });
  }

  writeResults();

  function writeResults() {
    const billingFile = join(RESULTS_DIR, `${runId}.jsonl`);
    writeFileSync(billingFile, billingLines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

    const summary = {
      run_id: runId, phase: 1,
      n_tasks: tasks.length, n_reps: N_REPS,
      total_cost_usd: totalCostUsd,
      cap_usd: PHASE1_CAP_USD,
      registry_path: registryPath,
      completed_at: new Date().toISOString(),
      tasks: taskResults,
    };
    writeFileSync(resultsFile, JSON.stringify(summary, null, 2), 'utf8');
    console.log('');
    console.log(`Phase 1 complete. Total cost: $${totalCostUsd.toFixed(4)}`);
    console.log(`Results: ${resultsFile}`);
    console.log(`Registry: ${registryPath}`);
    console.log('');
    console.log('Next step: set YAKCC_REGISTRY_PATH, then run phase2-v4.mjs:');
    console.log(`  export YAKCC_REGISTRY_PATH='${registryPath}'`);
  }
}

function extractCode(text) {
  const tsMatch = text.match(/```(?:typescript|ts)\n([\s\S]*?)```/);
  if (tsMatch) return tsMatch[1].trim();
  const plainMatch = text.match(/```\n([\s\S]*?)```/);
  if (plainMatch) return plainMatch[1].trim();
  return text;
}

function estimateCost(modelId, inputTokens, outputTokens) {
  const pricing = {
    'claude-opus-4-7':            { in: 15.00 / 1e6, out: 75.00 / 1e6 },
    'claude-sonnet-4-6':          { in:  3.00 / 1e6, out: 15.00 / 1e6 },
    'claude-haiku-4-5-20251001':  { in:  0.80 / 1e6, out:  4.00 / 1e6 },
  };
  const p = pricing[modelId] ?? { in: 0, out: 0 };
  return inputTokens * p.in + outputTokens * p.out;
}

main().catch((err) => { console.error(err); process.exit(1); });
