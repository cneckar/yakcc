/**
 * token-savings.mjs — Heuristic token-savings estimator for B8-SYNTHETIC.
 *
 * Per emission_block:
 *   - raw_tokens = block.estimated_raw_tokens (authored in fixture)
 *   - hook_tokens (if hit):
 *       The substituted output per @yakcc/hooks-base.renderSubstitution:
 *       contract comment + import + binding
 *       Estimate: ~30 + ~10 + ~5 = ~45 tokens per hit atom
 *   - hook_tokens (if miss): raw_tokens (no substitution, fallthrough)
 *
 * Per task:
 *   - task_tokens_saved = sum(raw_tokens_hit) - sum(hook_tokens_hit_substituted)
 *   - task_savings_pct = task_tokens_saved / task_total_raw_tokens
 *
 * Aggregate across all tasks:
 *   - mean_savings_pct (synthetic ceiling)
 *   - mean_savings_pct_with_coverage (excluding 0%-hit tasks per #167 DQ-9)
 *   - hit_rate_aggregate
 *
 * The 45-token hook substitution estimate is based on:
 *   "// @atom <name> (<sig>; <key-guarantee>) — yakcc:<hash[:8]>" ~30 tokens
 *   "import { <name> } from '@yakcc/<pkg>';" ~10 tokens
 *   "const result = <name>(args);" ~5 tokens
 * This is conservative — real substitution output may be slightly longer or shorter
 * depending on atom name length and signature complexity.
 */

/**
 * Token cost of one hook substitution (contract comment + import + binding).
 * Source: D-HOOK-4 inline contract comment format (DEC-HOOK-LAYER-001).
 */
export const HOOK_TOKENS_PER_HIT = 45;

/**
 * Compute aggregate token savings across all task results.
 *
 * @param {Array<{
 *   task_id: string;
 *   tier: string;
 *   blocks: Array<{ hit: boolean; raw_tokens: number }>;
 *   task_hit_rate: number;
 *   task_has_coverage: boolean;
 *   task_total_raw_tokens: number;
 *   task_estimated_hook_tokens: number;
 * }>} taskResults
 * @returns {{
 *   all_tasks: {
 *     mean_hit_rate: number;
 *     mean_savings_pct: number;
 *     total_raw_tokens: number;
 *     total_hook_tokens: number;
 *     total_savings_pct: number;
 *   };
 *   tasks_with_coverage: {
 *     n: number;
 *     mean_hit_rate: number;
 *     mean_savings_pct: number;
 *     total_raw_tokens: number;
 *     total_hook_tokens: number;
 *     total_savings_pct: number;
 *   };
 *   per_tier: Record<string, {
 *     n: number;
 *     mean_hit_rate: number;
 *     mean_savings_pct: number;
 *   }>;
 * }}
 */
export function computeAggregateSavings(taskResults) {
  // Per-task savings
  const tasksWithSavings = taskResults.map(task => {
    const rawTokens = task.task_total_raw_tokens;
    const hookTokens = task.task_estimated_hook_tokens;
    const saved = rawTokens - hookTokens;
    const savingsPct = rawTokens > 0 ? saved / rawTokens : 0;
    return {
      task_id: task.task_id,
      tier: task.tier,
      hit_rate: task.task_hit_rate,
      has_coverage: task.task_has_coverage,
      raw_tokens: rawTokens,
      hook_tokens: hookTokens,
      tokens_saved: saved,
      savings_pct: savingsPct,
    };
  });

  // All-tasks aggregate
  const allN = tasksWithSavings.length;
  const allRaw = tasksWithSavings.reduce((s, t) => s + t.raw_tokens, 0);
  const allHook = tasksWithSavings.reduce((s, t) => s + t.hook_tokens, 0);
  const allSaved = allRaw - allHook;
  const allSavedPct = allRaw > 0 ? allSaved / allRaw : 0;
  const meanHitRateAll = allN > 0
    ? tasksWithSavings.reduce((s, t) => s + t.hit_rate, 0) / allN
    : 0;
  const meanSavingsPctAll = allN > 0
    ? tasksWithSavings.reduce((s, t) => s + t.savings_pct, 0) / allN
    : 0;

  // Tasks-with-coverage aggregate (per #167 DQ-9: exclude 0%-hit tasks)
  const coveredTasks = tasksWithSavings.filter(t => t.has_coverage);
  const covN = coveredTasks.length;
  const covRaw = coveredTasks.reduce((s, t) => s + t.raw_tokens, 0);
  const covHook = coveredTasks.reduce((s, t) => s + t.hook_tokens, 0);
  const covSaved = covRaw - covHook;
  const covSavedPct = covRaw > 0 ? covSaved / covRaw : 0;
  const meanHitRateCov = covN > 0
    ? coveredTasks.reduce((s, t) => s + t.hit_rate, 0) / covN
    : 0;
  const meanSavingsPctCov = covN > 0
    ? coveredTasks.reduce((s, t) => s + t.savings_pct, 0) / covN
    : 0;

  // Per-tier aggregates
  const tiers = [...new Set(tasksWithSavings.map(t => t.tier))];
  const perTier = {};
  for (const tier of tiers) {
    const tierTasks = tasksWithSavings.filter(t => t.tier === tier);
    const n = tierTasks.length;
    const meanHr = n > 0 ? tierTasks.reduce((s, t) => s + t.hit_rate, 0) / n : 0;
    const meanSp = n > 0 ? tierTasks.reduce((s, t) => s + t.savings_pct, 0) / n : 0;
    perTier[tier] = { n, mean_hit_rate: meanHr, mean_savings_pct: meanSp };
  }

  return {
    all_tasks: {
      n: allN,
      mean_hit_rate: meanHitRateAll,
      mean_savings_pct: meanSavingsPctAll,
      total_raw_tokens: allRaw,
      total_hook_tokens: allHook,
      total_savings_pct: allSavedPct,
    },
    tasks_with_coverage: {
      n: covN,
      mean_hit_rate: meanHitRateCov,
      mean_savings_pct: meanSavingsPctCov,
      total_raw_tokens: covRaw,
      total_hook_tokens: covHook,
      total_savings_pct: covSavedPct,
    },
    per_tier: perTier,
    per_task: tasksWithSavings,
  };
}

/**
 * Check pass/KILL bars at f=1.0 (Slice 1 single-point).
 *
 * Pass bars (per #192 + #167 DQ-5):
 *   - Asymptote >= 80% savings (all-tasks mean at f=1.0)
 *
 * KILL bars (per #192 + #167 DQ-5):
 *   - Asymptote < 50% savings at f=1.0 => architecture fundamentally limited
 *
 * Note: monotonic-curve check is a Slice 2 concern (requires multi-f data).
 *
 * @param {{ all_tasks: { mean_savings_pct: number } }} aggregates
 * @returns {{ verdict: 'PASS' | 'WARN' | 'KILL'; reason: string }}
 */
export function checkPassBars(aggregates) {
  const savingsPct = aggregates.all_tasks.mean_savings_pct;

  if (savingsPct >= 0.80) {
    return { verdict: 'PASS', reason: `mean savings ${(savingsPct * 100).toFixed(1)}% >= 80% pass bar` };
  }
  if (savingsPct < 0.50) {
    return {
      verdict: 'KILL',
      reason: `mean savings ${(savingsPct * 100).toFixed(1)}% < 50% KILL bar — architecture fundamentally limited; production cannot exceed this ceiling`,
    };
  }
  return {
    verdict: 'WARN',
    reason: `mean savings ${(savingsPct * 100).toFixed(1)}% in warn zone [50%, 80%) — below pass bar but above KILL bar; expand corpus in Slice 2`,
  };
}
