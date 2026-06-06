// SPDX-License-Identifier: MIT
//
// bench/proof-requirement/harness.mjs
//
// @decision DEC-BENCH-PROOF-REQ-HARNESS-001
// @title proof-requirement benchmark harness — simulation scaffold for four proof_requirement modes
// @status accepted
// @rationale
//   wi-1089-bench: B4-style measurement scaffold for the proof_requirement parameter (#1088).
//   Design goals:
//   (1) SCAFFOLD-FIRST: runs without ANTHROPIC_API_KEY (--dry-run / simulation mode).
//       Real LLM API calls are gated behind ANTHROPIC_API_KEY presence. The full
//       pipeline — mode injection, envelope simulation, metric collection, JSONL output —
//       is exercisable without spending budget.
//   (2) FOUR MODES: exercises required / preferred / ignored / per_block for every task.
//       Mode injection is simulated via the resolver stub; the live path passes
//       proof_requirement in the IntentCard to yakcc_resolve.
//   (3) METRIC COLLECTION: captures substitution_rate, token_cost_delta, per_block_adoption,
//       output_token_reduction per mode. Derived from per-rep records in results/*.jsonl.
//   (4) B4-v5 ANCESTRY: mirrors B4-v5 patterns (JSONL trace, BillingLog, BudgetTracker,
//       dry-run cost projection, --smoke shortcut). Adds proof_requirement dimension.
//
//   Cross-references:
//     bench/B4-tokens-v5/harness/phase2-v5.mjs     -- B4-v5 ancestor harness
//     bench/B4-tokens-v5/harness/billing.mjs        -- BillingLog / pricing
//     packages/mcp-registry/src/tools/resolve.ts    -- production yakcc_resolve (proof_requirement G.4)
//     docs/system-prompts/yakcc-discovery.md         -- discovery system prompt
//     gh issue #1088                                 -- proof_requirement spec (G.2 modes)
//     gh issue #1089                                 -- this benchmark
//     METHODOLOGY.md                                 -- measurement methodology authority
//
// Invocation:
//   node harness.mjs --dry-run
//   node harness.mjs --dry-run --mode=required
//   node harness.mjs --smoke
//   node harness.mjs --task=crc32c --mode=preferred
//   ANTHROPIC_API_KEY=sk-... node harness.mjs                  # live run (all modes)
//   ANTHROPIC_API_KEY=sk-... node harness.mjs --mode=ignored   # single-mode live

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = __dirname;
const RESULTS_DIR = join(BENCH_ROOT, "results");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

// parseArgs does not accept null as a string default (Node.js v22 TypeError).
// Use empty string as the sentinel for "not set".
const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    smoke: { type: "boolean", default: false },
    mode: { type: "string", default: "" },
    task: { type: "string", default: "" },
    "cap-usd": { type: "string", default: "30" },
  },
  strict: false,
});

const DRY_RUN = args["dry-run"] || !process.env.ANTHROPIC_API_KEY;
const SMOKE = args["smoke"] ?? false;
const MODE_FILTER = args["mode"] || null;
const TASK_FILTER = args["task"] || null;
const CAP_USD = parseFloat(args["cap-usd"] || "30");

// ---------------------------------------------------------------------------
// Proof requirement modes (#1088 G.2)
// ---------------------------------------------------------------------------

/**
 * @decision DEC-BENCH-PROOF-REQ-MODES-001
 * @title Four proof_requirement modes from #1088 G.2
 * @status accepted
 * @rationale
 *   Mirrors the four-mode spec from #1088:
 *   - required:  hard filter; no proven atom => no_candidates with reason:no_proven_atoms_match
 *   - preferred: score boost (+PROOF_BONUS) for proven atoms; no filtering
 *   - ignored:   proof status does not affect ranking
 *   - per_block: per-dimension mode lookup for compound intents
 *
 *   In simulation mode (DRY_RUN) the resolver stub simulates these effects
 *   without a real registry. In live mode the IntentCard passed to yakcc_resolve
 *   carries proof_requirement: <mode>, and the production resolve.ts applies
 *   the actual scoring logic.
 */
export const MODES = ["required", "preferred", "ignored", "per_block"];

const PROOF_BONUS = parseFloat(process.env.YAKCC_PROOF_BONUS ?? "0.10");
const RETRACTION_PENALTY = parseFloat(process.env.YAKCC_RETRACTION_PENALTY ?? "0.20");

// ---------------------------------------------------------------------------
// Task corpus
// ---------------------------------------------------------------------------

const TASKS_JSON_PATH = join(BENCH_ROOT, "tasks.json");
const tasksManifest = JSON.parse(readFileSync(TASKS_JSON_PATH, "utf8"));
const ALL_TASKS = tasksManifest.tasks;

function getActiveTasks() {
  let tasks = ALL_TASKS;
  if (TASK_FILTER) {
    tasks = tasks.filter((t) => t.id === TASK_FILTER);
    if (tasks.length === 0) {
      throw new Error(`--task=${TASK_FILTER} not found in tasks.json`);
    }
  }
  if (SMOKE) {
    const seen = new Set();
    tasks = tasks.filter((t) => {
      if (seen.has(t.complexity_domain)) return false;
      seen.add(t.complexity_domain);
      return true;
    });
  }
  return tasks;
}

function getActiveModes() {
  if (MODE_FILTER) {
    if (!MODES.includes(MODE_FILTER)) {
      throw new Error(`--mode=${MODE_FILTER} must be one of: ${MODES.join(", ")}`);
    }
    return [MODE_FILTER];
  }
  return MODES;
}

// ---------------------------------------------------------------------------
// Billing (adapted from B4-v5; no @anthropic-ai/sdk dep for dry-run)
// ---------------------------------------------------------------------------

const PRICING = {
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.00 },
  "claude-sonnet-4-6": { input: 3.00, output: 15.00 },
  "claude-opus-4-7": { input: 15.00, output: 75.00 },
};
const DEFAULT_MODEL = "claude-sonnet-4-6";

function estimateCostUsd({ model_id, input_tokens, output_tokens }) {
  const p = PRICING[model_id] ?? PRICING[DEFAULT_MODEL];
  return (input_tokens * p.input + output_tokens * p.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Budget tracker
// ---------------------------------------------------------------------------

class BudgetTracker {
  constructor(capUsd) {
    this.cap = capUsd;
    this.spent = 0;
  }
  add(costUsd) {
    this.spent += costUsd;
    if (this.spent > this.cap) {
      throw new Error(
        `Budget cap $${this.cap.toFixed(2)} exceeded (spent $${this.spent.toFixed(4)})`
      );
    }
  }
  summary() {
    return `$${this.spent.toFixed(4)} of $${this.cap.toFixed(2)} cap`;
  }
}

// ---------------------------------------------------------------------------
// Simulation resolver stub (DRY_RUN path)
// ---------------------------------------------------------------------------

/**
 * simulateResolve() -- offline simulation of yakcc_resolve with proof_requirement modes.
 *
 * Tasks with seeding_target=true get a simulated L3 proof so that 'required' mode
 * returns a hit. Tasks with seeding_target=false simulate no proven atoms, so
 * 'required' returns no_candidates (real-world state pre-seeding).
 *
 * Production: replace with real yakcc_resolve calls via spawned @yakcc/mcp-registry
 * server (same wiring as B4-v5 phase2-v5.mjs DEC-BENCH-B4-V5-RESOLVE-SERVER-001).
 */
function simulateResolve(taskId, mode, task) {
  const BASE_SCORE = task.reuses_b4v5 ? 0.91 : 0.74;
  const HAS_PROVEN_ATOM = task.seeding_target;

  let effectiveScore = BASE_SCORE;
  let reason = null;
  const proofStatus = HAS_PROVEN_ATOM ? "accepted" : "none";
  const verificationLevel = HAS_PROVEN_ATOM ? "L3" : "L0";

  if (mode === "required") {
    if (!HAS_PROVEN_ATOM) {
      return {
        confidence_tier: "no_candidates",
        reason: "no_proven_atoms_match",
        candidates: [],
        proof_requirement: mode,
        _simulated: true,
      };
    }
  } else if (mode === "preferred") {
    if (HAS_PROVEN_ATOM) {
      effectiveScore = Math.min(1.0, effectiveScore + PROOF_BONUS);
    }
  } else if (mode === "ignored") {
    // no adjustment
  } else if (mode === "per_block") {
    if (task.per_block_dims) {
      const dimModes = Object.values(task.per_block_dims);
      if (dimModes.includes("required") && !HAS_PROVEN_ATOM) {
        return {
          confidence_tier: "no_candidates",
          reason: "no_proven_atoms_match",
          candidates: [],
          proof_requirement: mode,
          per_block_dims: task.per_block_dims,
          _simulated: true,
        };
      }
      if (HAS_PROVEN_ATOM) {
        effectiveScore = Math.min(1.0, effectiveScore + PROOF_BONUS);
      }
    } else {
      if (HAS_PROVEN_ATOM) {
        effectiveScore = Math.min(1.0, effectiveScore + PROOF_BONUS);
      }
    }
  }

  // DEC-1009-THRESHOLD-RETUNE-001: auto_accept when score > 0.85 AND gap > 0.05
  const GAP_SIMULATED = 0.08;
  let tier;
  if (effectiveScore > 0.85 && GAP_SIMULATED > 0.05) {
    tier = "auto_accept";
  } else if (effectiveScore >= 0.50) {
    tier = "candidate_list";
  } else {
    tier = "no_candidates";
    reason = "below_threshold";
  }

  const candidate = {
    atom_id: `${taskId}-v1-sim`,
    score: effectiveScore,
    summary: `[simulated] ${task.description}`,
    source: "local",
    evidence: [],
    verification_level: verificationLevel,
    proof_status: proofStatus,
    accepted_proofs: HAS_PROVEN_ATOM
      ? [
          {
            theorem_statement_hash: `sha256:sim-${taskId}`,
            accepted_at: "2026-05-01T00:00:00Z",
            retraction_window_closes_at: "2026-06-01T00:00:00Z",
            checker: "fast-check",
            attestation_count: 3,
          },
        ]
      : [],
  };

  return {
    confidence_tier: tier,
    reason,
    candidates: [candidate],
    proof_requirement: mode,
    per_block_dims: task.per_block_dims ?? null,
    _simulated: true,
  };
}

// ---------------------------------------------------------------------------
// Token estimation helpers (simulation)
// ---------------------------------------------------------------------------

const AUTHORED_TOKENS = {
  checksum_algorithm: 1800,
  encoding_codec: 900,
  stateful_fsm: 1200,
  range_algebra: 1500,
  data_structure: 1100,
  parsing: 1000,
  validation: 1400,
  compound: 2000,
};

function simulateTokenCounts(task, resolveEnvelope) {
  const baseOutputTokens = AUTHORED_TOKENS[task.complexity_domain] ?? 1200;
  const isSubstituted = resolveEnvelope.confidence_tier === "auto_accept";
  const output_tokens = isSubstituted ? 14 : baseOutputTokens;
  const input_tokens = isSubstituted ? 3500 : 3200;
  return { input_tokens, output_tokens, substituted: isSubstituted };
}

// ---------------------------------------------------------------------------
// Per-rep record
// ---------------------------------------------------------------------------

async function runRep({ task, mode, rep, runId, budget }) {
  const resolveEnvelope = DRY_RUN
    ? simulateResolve(task.id, mode, task)
    : await liveResolve(task, mode);

  const { input_tokens, output_tokens, substituted } = DRY_RUN
    ? simulateTokenCounts(task, resolveEnvelope)
    : { input_tokens: 0, output_tokens: 0, substituted: false };

  const cost_usd = estimateCostUsd({
    model_id: DEFAULT_MODEL,
    input_tokens,
    output_tokens,
  });

  if (!DRY_RUN) budget.add(cost_usd);

  let flow_class;
  if (resolveEnvelope.confidence_tier === "auto_accept" && substituted) {
    flow_class = "hot_hit";
  } else if (resolveEnvelope.confidence_tier === "candidate_list") {
    flow_class = "warm_candidate_list";
  } else if (
    resolveEnvelope.confidence_tier === "no_candidates" &&
    resolveEnvelope.reason === "no_proven_atoms_match"
  ) {
    flow_class = "required_no_match";
  } else {
    flow_class = "cold_miss";
  }

  return {
    run_id: runId,
    task_id: task.id,
    mode,
    rep,
    ts: new Date().toISOString(),
    dry_run: DRY_RUN,
    proof_requirement: mode,
    per_block_dims: task.per_block_dims ?? null,
    confidence_tier: resolveEnvelope.confidence_tier,
    reason: resolveEnvelope.reason ?? null,
    top_candidate: resolveEnvelope.candidates[0] ?? null,
    input_tokens,
    output_tokens,
    cost_usd,
    substituted,
    flow_class,
    task_proof_sensitivity: task.proof_sensitivity,
    task_seeding_target: task.seeding_target,
    oracle_passed: DRY_RUN ? null : false,
    triplet_wellformed: DRY_RUN ? null : null,
  };
}

// ---------------------------------------------------------------------------
// Live resolve stub (requires production wiring before ANTHROPIC_API_KEY runs)
// ---------------------------------------------------------------------------

async function liveResolve(_task, _mode) {
  throw new Error(
    "liveResolve() is not yet wired. See METHODOLOGY.md section 'Live Run' for " +
      "production wiring instructions. Use --dry-run for the scaffold simulation."
  );
}

// ---------------------------------------------------------------------------
// Results writing
// ---------------------------------------------------------------------------

function openResultsWriter(runId) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const traceFile = join(RESULTS_DIR, `${runId}.jsonl`);
  return {
    write(record) {
      appendFileSync(traceFile, JSON.stringify(record) + "\n", "utf8");
    },
    path: traceFile,
  };
}

// ---------------------------------------------------------------------------
// Metric aggregation
// ---------------------------------------------------------------------------

function aggregateMetrics(records) {
  const byMode = {};
  for (const r of records) {
    if (!byMode[r.mode]) byMode[r.mode] = [];
    byMode[r.mode].push(r);
  }

  const ignoredReps = byMode["ignored"] ?? [];
  const ignoredAvgOutput =
    ignoredReps.length > 0
      ? ignoredReps.reduce((s, r) => s + r.output_tokens, 0) / ignoredReps.length
      : null;

  const summary = {};
  for (const [mode, reps] of Object.entries(byMode)) {
    const n = reps.length;
    const substitution_rate = reps.filter((r) => r.substituted).length / n;
    const avg_output_tokens = reps.reduce((s, r) => s + r.output_tokens, 0) / n;
    const avg_cost_usd = reps.reduce((s, r) => s + r.cost_usd, 0) / n;

    const per_block_reps = reps.filter((r) => r.mode === "per_block");
    const per_block_adoption =
      per_block_reps.length > 0
        ? per_block_reps.filter(
            (r) =>
              r.flow_class === "hot_hit" || r.flow_class === "warm_candidate_list"
          ).length / per_block_reps.length
        : null;

    const output_token_reduction_vs_ignored =
      ignoredAvgOutput != null && ignoredAvgOutput > 0
        ? ((ignoredAvgOutput - avg_output_tokens) / ignoredAvgOutput) * 100
        : null;

    summary[mode] = {
      n_reps: n,
      substitution_rate,
      avg_output_tokens,
      avg_cost_usd,
      per_block_adoption,
      output_token_reduction_vs_ignored,
      flow_class_counts: Object.fromEntries(
        ["hot_hit", "warm_candidate_list", "cold_miss", "required_no_match"].map(
          (fc) => [fc, reps.filter((r) => r.flow_class === fc).length]
        )
      ),
    };
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Dry-run cost projection
// ---------------------------------------------------------------------------

function printCostProjection(tasks, modes) {
  const REP_COUNT = 3;
  let total = 0;
  console.log("\n--- Projected cost table (per mode, per task, 3 reps) ---");
  console.log(
    "Mode         Task                             Est out tok        Est cost/rep   Total"
  );
  for (const mode of modes) {
    for (const task of tasks) {
      const envelope = simulateResolve(task.id, mode, task);
      const { output_tokens } = simulateTokenCounts(task, envelope);
      const cost = estimateCostUsd({
        model_id: DEFAULT_MODEL,
        input_tokens: 3500,
        output_tokens,
      });
      const rowTotal = cost * REP_COUNT;
      total += rowTotal;
      console.log(
        `${mode.padEnd(13)}${task.id.padEnd(33)}${String(output_tokens).padEnd(19)}$${cost.toFixed(4).padEnd(15)}$${rowTotal.toFixed(4)}`
      );
    }
  }
  console.log(
    `\nProjected grand total: $${total.toFixed(4)} (${tasks.length} tasks x ${modes.length} modes x ${REP_COUNT} reps)`
  );
  console.log(`Budget cap: $${CAP_USD}\n`);
  return total;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const tasks = getActiveTasks();
  const modes = getActiveModes();
  const REP_COUNT = SMOKE ? 1 : 3;

  const runId = `proof-req-${DRY_RUN ? "dry" : "live"}-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}`;
  const writer = openResultsWriter(runId);
  const budget = new BudgetTracker(CAP_USD);

  console.log("\n=== proof-requirement benchmark ===");
  console.log(`run_id:    ${runId}`);
  console.log(`dry_run:   ${DRY_RUN}`);
  console.log(`tasks:     ${tasks.length}  modes: ${modes.length}  reps: ${REP_COUNT}`);
  console.log(`cap:       $${CAP_USD}`);
  console.log(`results:   ${writer.path}\n`);

  if (DRY_RUN) {
    const projected = printCostProjection(tasks, modes);
    if (projected > CAP_USD) {
      console.warn(
        `WARNING: projected cost $${projected.toFixed(4)} exceeds cap $${CAP_USD}.`
      );
    }
  }

  const allRecords = [];

  for (const mode of modes) {
    for (const task of tasks) {
      for (let rep = 1; rep <= REP_COUNT; rep++) {
        const record = await runRep({ task, mode, rep, runId, budget });
        writer.write(record);
        allRecords.push(record);

        const tier = record.confidence_tier;
        const sub = record.substituted ? "SUB" : "   ";
        console.log(
          `  [${mode.padEnd(9)}] ${task.id.padEnd(32)} rep=${rep}  tier=${tier.padEnd(14)} ${sub}  out_tok=${record.output_tokens}`
        );
      }
    }
  }

  const metrics = aggregateMetrics(allRecords);
  const summaryPath = join(RESULTS_DIR, `${runId}.summary.json`);
  writeFileSync(
    summaryPath,
    JSON.stringify({ run_id: runId, dry_run: DRY_RUN, metrics }, null, 2),
    "utf8"
  );

  console.log("\n=== Metrics summary by mode ===");
  for (const [mode, m] of Object.entries(metrics)) {
    console.log(`\n[${mode}]`);
    console.log(`  substitution_rate:              ${(m.substitution_rate * 100).toFixed(1)}%`);
    console.log(`  avg_output_tokens:              ${m.avg_output_tokens.toFixed(1)}`);
    console.log(`  avg_cost_usd:                   $${m.avg_cost_usd.toFixed(6)}`);
    if (m.per_block_adoption != null) {
      console.log(`  per_block_adoption:             ${(m.per_block_adoption * 100).toFixed(1)}%`);
    }
    if (m.output_token_reduction_vs_ignored != null) {
      console.log(
        `  output_token_reduction(vs ignored): ${m.output_token_reduction_vs_ignored.toFixed(1)}%`
      );
    }
    console.log(`  flow_class_counts:              ${JSON.stringify(m.flow_class_counts)}`);
  }

  console.log(`\nSummary: ${summaryPath}`);
  console.log(`Trace:   ${writer.path}`);
  if (!DRY_RUN) {
    console.log(`Budget:  ${budget.summary()}`);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
