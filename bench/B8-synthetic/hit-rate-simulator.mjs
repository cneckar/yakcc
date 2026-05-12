/**
 * hit-rate-simulator.mjs — Synthetic hit-rate simulation for B8-SYNTHETIC.
 *
 * For each emission_block in each transcript:
 *   1. Construct a QueryIntentCard from block.description (treat description as behavior text)
 *   2. Call registry.findCandidatesByQuery() against the bootstrap registry
 *   3. Apply CONFIDENT_THRESHOLD (0.70) from @yakcc/hooks-base
 *   4. Record:
 *      - hit: top-1 combinedScore >= CONFIDENT_THRESHOLD
 *      - match_atom: blockMerkleRoot[:8] of top-1 candidate (or null)
 *      - top1_score: the actual combinedScore
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
 *   state). This is independent of whether D1 ships — the benchmark measures scaling
 *   characteristics of the hook layer as built.
 *
 * Cross-reference:
 *   #192 (WI-BENCHMARK-B8-SYNTHETIC) — parent issue
 *   #167 (WI-BENCHMARK-SUITE) — parent suite with DQ-2, DQ-5, DQ-6, DQ-7, DQ-9
 *   DEC-BENCHMARK-SUITE-001 in MASTER_PLAN.md
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve repo root: bench/B8-synthetic/ → bench/ → repo root
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Dynamically import @yakcc/registry from the built dist.
 * Fails loudly if dist is absent (Sacred Practice #5).
 *
 * @param {string} [packagesRoot] - Override root directory containing packages/. Defaults to REPO_ROOT.
 * @returns {Promise<{ openRegistry: Function }>}
 */
export async function loadRegistry(packagesRoot) {
  const root = packagesRoot ?? REPO_ROOT;
  const distPath = join(root, 'packages', 'registry', 'dist', 'index.js');
  if (!existsSync(distPath)) {
    throw new Error(
      `@yakcc/registry not built. Run 'pnpm build' first. Missing: ${distPath}`
    );
  }
  return import(pathToFileURL(distPath).href);
}

let _openRegistry = null;
let _openRegistryRoot = null;

async function getOpenRegistry(packagesRoot) {
  if (!_openRegistry || _openRegistryRoot !== (packagesRoot ?? null)) {
    const mod = await loadRegistry(packagesRoot);
    _openRegistry = mod.openRegistry;
    _openRegistryRoot = packagesRoot ?? null;
  }
  return _openRegistry;
}

/**
 * CONFIDENT_THRESHOLD mirrors the value in @yakcc/hooks-base/src/yakcc-resolve.ts.
 * D3 ADR §Q4 "confident" band: combinedScore >= 0.70 => "matched" status.
 * Production hook substitutes when this threshold is met.
 */
export const CONFIDENT_THRESHOLD = 0.70;

/**
 * One block result shape.
 * @typedef {Object} BlockResult
 * @property {string} block_id
 * @property {boolean} hit
 * @property {string|null} match_atom - blockMerkleRoot[:8] of top-1 (null if no hit)
 * @property {number|null} top1_score - combinedScore of top-1 candidate (null if no candidates)
 * @property {number} raw_tokens
 */

/**
 * One task result shape.
 * @typedef {Object} TaskResult
 * @property {string} task_id
 * @property {string} tier
 * @property {BlockResult[]} blocks
 * @property {number} task_hit_rate - fraction of blocks that are hits
 * @property {boolean} task_has_coverage - true if at least one block is a hit
 * @property {number} task_total_raw_tokens
 * @property {number} task_estimated_hook_tokens
 */

/**
 * Simulate the hook hit-rate for a single task transcript.
 *
 * @param {Object} task - A single task from the JSONL fixture
 * @param {import('../../packages/registry/dist/index.js').Registry} registry
 * @returns {Promise<Object>} TaskResult
 */
export async function simulateTask(task, registry) {
  const blockResults = [];

  for (const block of task.emission_blocks) {
    // Construct a minimal QueryIntentCard from the block description.
    // D2 ADR: behavior field drives the embedding query.
    // inputs/outputs are omitted — synthetic harness doesn't have full type signatures.
    const queryCard = { behavior: block.description };

    let hit = false;
    let matchAtom = null;
    let top1Score = null;

    try {
      const result = await registry.findCandidatesByQuery(queryCard);
      const top = result.candidates[0];
      if (top !== undefined) {
        top1Score = top.combinedScore;
        if (top1Score >= CONFIDENT_THRESHOLD) {
          hit = true;
          matchAtom = top.block.blockMerkleRoot.slice(0, 8);
        }
      } else if (result.nearMisses.length > 0) {
        // No candidates survived pipeline stages — record top near-miss score
        const topMiss = result.nearMisses[0];
        top1Score = topMiss?.combinedScore ?? null;
      }
    } catch (err) {
      // Registry error: record as miss (consistent with production passthrough behavior)
      top1Score = null;
    }

    blockResults.push({
      block_id: block.block_id,
      hit,
      match_atom: matchAtom,
      top1_score: top1Score,
      raw_tokens: block.estimated_raw_tokens,
    });
  }

  const hitCount = blockResults.filter(b => b.hit).length;
  const taskHitRate = blockResults.length > 0 ? hitCount / blockResults.length : 0;
  const taskHasCoverage = hitCount > 0;
  const taskTotalRawTokens = blockResults.reduce((s, b) => s + b.raw_tokens, 0);

  // Estimate hook tokens: for hit blocks, the substituted output is:
  //   contract comment ~30 tokens + import line ~10 tokens + binding ~5 tokens = ~45 tokens
  // For miss blocks: raw_tokens (fallthrough, no substitution).
  const HOOK_TOKENS_PER_HIT = 45;
  const taskEstimatedHookTokens = blockResults.reduce((s, b) => {
    return s + (b.hit ? HOOK_TOKENS_PER_HIT : b.raw_tokens);
  }, 0);

  return {
    task_id: task.task_id,
    tier: task.tier,
    blocks: blockResults,
    task_hit_rate: taskHitRate,
    task_has_coverage: taskHasCoverage,
    task_total_raw_tokens: taskTotalRawTokens,
    task_estimated_hook_tokens: taskEstimatedHookTokens,
  };
}

/**
 * Open the bootstrap registry in read-only mode.
 * Returns a Registry instance. Caller must call registry.close() when done.
 *
 * @param {string} registryPath - Absolute path to the sqlite registry file
 * @returns {Promise<import('../../packages/registry/dist/index.js').Registry>}
 */
/**
 * Open the bootstrap registry in read-only mode.
 * Returns a Registry instance. Caller must call registry.close() when done.
 *
 * @param {string} registryPath - Absolute path to the sqlite registry file
 * @param {string} [packagesRoot] - Override root dir containing packages/. Defaults to 2 levels up from bench/B8-synthetic/.
 * @returns {Promise<import('./types.js').Registry>}
 */
export async function openBootstrapRegistry(registryPath, packagesRoot) {
  // Open read-only: openRegistry reads from the file, we never call storeBlock.
  // No embedding provider override needed: the registry has its own stored embedding model.
  const openRegistry = await getOpenRegistry(packagesRoot);
  return openRegistry(registryPath);
}
