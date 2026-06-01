// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/reference-emit/paid-experiment.mjs
//
// @decision DEC-BENCH-B4-REFEMIT-PAID-001
// @title Paid behavioral experiment: verbatim-write vs reference-emit output tokens
// @status accepted (refemit-paid workflow, wi-rep)
// @rationale
//   measure.mjs (#1041) proved the OUTPUT collapse OFFLINE via char/token estimation.
//   This experiment proves it LIVE: does a real model (Haiku, Sonnet) actually emit
//   ~10 tokens in reference mode vs hundreds in verbatim mode when driven by the
//   real discovery system prompt?
//
//   Design:
//   - system  = real docs/system-prompts/yakcc-discovery.md (prompt-cached)
//   - verbatim condition: simulate state after yakcc_compile (Section B of the prompt)
//   - reference condition: simulate state after yakcc_reference (Section A of the prompt)
//   - Reference artifacts built by real @yakcc/compile builders (same as measure.mjs)
//   - One real Anthropic call per (atom, model, condition, rep)
//   - Records usage.output_tokens + behavioral correctness flags
//   - --dry (default): NO API calls; prints plan + per-cell messages + cost estimate
//   - --real: requires ANTHROPIC_API_KEY; enforces --max-usd cap
//
//   Scope: OUTPUT token measurement only. Input amortization, cache economics, and
//   multi-turn narration are measured by the v5 harness (phase2-v5.mjs).
//
// Usage:
//   node bench/B4-tokens-v5/reference-emit/paid-experiment.mjs [--dry] [--real]
//        [--atoms crc32c,lru-ttl-cache,avl-tree,dijkstra-heap]
//        [--models claude-haiku-4-5-20251001,claude-sonnet-4-6]
//        [--reps 2] [--max-usd 5.00]
//
// Exports (for paid-experiment.test.mjs):
//   buildPlan(opts)              → ExperimentPlan
//   buildVerbatimMessage(atom)   → string   (the user message for verbatim condition)
//   buildReferenceMessage(atom)  → string   (the user message for reference condition)
//   estimatePlanCostUsd(plan)    → { totalUsd, perCell }
//   EXPERIMENT_DEFAULTS          → object

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(__dirname, "../../..");
const RESULTS_DIR = join(__dirname, "results");

// ---------------------------------------------------------------------------
// @yakcc/compile imports — real production reference-artifact builders
// Same approach as measure.mjs: dynamic import of the compiled dist.
// ---------------------------------------------------------------------------

const { addReference, emptyManifest, referenceImportLine, generateAtomDts } =
  await import(
    `file://${join(REPO_ROOT, "packages", "compile", "dist", "index.js")}`
  );

// ---------------------------------------------------------------------------
// Billing — reuse the billing.mjs authority from bench/B4-tokens-v5/harness/
// ---------------------------------------------------------------------------

const { PRICING, estimateCostUsd } = await import(
  `file://${join(BENCH_ROOT, "harness", "billing.mjs")}`
);

// ---------------------------------------------------------------------------
// Constants and defaults
// ---------------------------------------------------------------------------

/**
 * @decision DEC-BENCH-B4-REFEMIT-PAID-001 continued
 *
 * Default experiment parameters. These are exported so tests can assert
 * against them without re-parsing the CLI.
 */
export const EXPERIMENT_DEFAULTS = {
  atoms: ["crc32c", "lru-ttl-cache", "avl-tree", "dijkstra-heap"],
  models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"],
  conditions: ["verbatim", "reference"],
  reps: 2,
  maxUsd: 5.00,
  // Assumed output token budget for cost estimation in dry mode.
  // verbatim: ~400 tokens (conservative estimate for a real implementation body).
  // reference: ~15 tokens (import line + brief confirmation).
  estimatedOutputTokens: {
    verbatim: 400,
    reference: 15,
  },
  // max_tokens to request from Anthropic — must capture each mode's FULL natural output.
  // verbatim: raised to 3000 to accommodate large impls (~2009 tokens in dijkstra-heap/avl-tree)
  //   plus any narration the model prepends; first run showed 800 truncated all verbatim cells.
  // reference: raised to 800 to capture the complete Section A write — the model records the
  //   manifest entry, writes the import line, AND generates the .d.ts stub before finishing;
  //   60 tokens truncated every reference response before the import line was complete,
  //   producing false behavioral_pass=false and understating the real reference output size.
  // The cost gate ($5 cap) still bounds total spend; measured avg reference output is ~150-300
  //   tokens, not the idealized ~14-token import-line-only figure.
  maxTokensVerbatim: 3000,
  maxTokensReference: 800,
};

// ---------------------------------------------------------------------------
// System prompt — real discovery prompt, read once at startup
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_PATH = join(REPO_ROOT, "docs", "system-prompts", "yakcc-discovery.md");
if (!existsSync(SYSTEM_PROMPT_PATH)) {
  throw new Error(`Discovery system prompt not found: ${SYSTEM_PROMPT_PATH}`);
}
export const SYSTEM_PROMPT = readFileSync(SYSTEM_PROMPT_PATH, "utf8");

if (!SYSTEM_PROMPT.includes("yakcc_reference")) {
  throw new Error(
    `System prompt at ${SYSTEM_PROMPT_PATH} does not contain 'yakcc_reference' — ` +
    `file may be wrong or stale`,
  );
}

// ---------------------------------------------------------------------------
// Task corpus loader — reads from both tasks.json (small) and tasks-hard.json (large)
// ---------------------------------------------------------------------------

const TASKS_JSON = JSON.parse(readFileSync(join(BENCH_ROOT, "tasks.json"), "utf8"));
const TASKS_HARD_JSON = JSON.parse(readFileSync(join(BENCH_ROOT, "tasks-hard.json"), "utf8"));

/** Map from atom id → task record (merged from both manifests) */
const ALL_TASKS_BY_ID = new Map(
  [...TASKS_JSON.tasks, ...TASKS_HARD_JSON.tasks].map((t) => [t.id, t]),
);

// ---------------------------------------------------------------------------
// Helpers shared with measure.mjs (duplicated here to stay self-contained;
// measure.mjs is governed and must not be modified)
// ---------------------------------------------------------------------------

function symbolFromExpectedExport(expectedExport) {
  if (typeof expectedExport === "string" && expectedExport.startsWith("named:")) {
    return expectedExport.slice("named:".length);
  }
  return expectedExport ?? "UnknownSymbol";
}

function syntheticRoot(implSource) {
  return createHash("sha256").update(implSource, "utf8").digest("hex");
}

/**
 * Load and compute all artifacts for one atom needed by both conditions.
 *
 * @param {string} atomId
 * @returns {AtomArtifacts}
 */
function loadAtomArtifacts(atomId) {
  const task = ALL_TASKS_BY_ID.get(atomId);
  if (!task) {
    throw new Error(
      `Atom '${atomId}' not found in tasks.json or tasks-hard.json. ` +
      `Available: ${[...ALL_TASKS_BY_ID.keys()].join(", ")}`,
    );
  }

  const implPath = join(BENCH_ROOT, task.reference_impl);
  if (!existsSync(implPath)) {
    throw new Error(`reference-impl not found: ${implPath}`);
  }

  const implSource = readFileSync(implPath, "utf8");
  const symbol = symbolFromExpectedExport(task.expected_export);
  const root = syntheticRoot(implSource);

  // Build reference artifacts via real @yakcc/compile (same as measure.mjs)
  const { reference } = addReference(emptyManifest(), { root, symbol });
  const importLine = referenceImportLine(reference);

  // Minimal synthetic spec for DTS (see measure.mjs notes on class-vs-function)
  const spec = { name: task.id, inputs: [], outputs: [], preconditions: [], postconditions: [], invariants: [], effects: [], level: 0 };
  const dtsContent = generateAtomDts(spec, symbol);
  const dtsPath = reference.alias
    ? `.yakcc/atoms/${reference.alias}.d.ts`
    : `.yakcc/atoms/${root.slice(0, 12)}.d.ts`;

  return {
    atomId,
    task,
    implSource,
    symbol,
    root,
    importLine,
    dtsContent,
    dtsPath,
    manifestEntry: reference,
  };
}

// ---------------------------------------------------------------------------
// Message builders — the critical wiring that determines which prompt section fires
//
// @decision DEC-BENCH-B4-REFEMIT-PAID-001 continued
//
// Verbatim condition: omit any mention of .yakcc/manifest.json → Section B fires.
// Reference condition: explicitly state manifest is present + provide yakcc_reference
//   tool result JSON → Section A fires.
// ---------------------------------------------------------------------------

/**
 * Build the user message for the VERBATIM condition.
 *
 * Simulates: yakcc_resolve returned auto_accept, yakcc_compile returned source.
 * The system prompt Section B instructs: write this source verbatim, stop.
 * Expected model output: the full impl (hundreds of tokens).
 *
 * @param {AtomArtifacts} artifacts
 * @returns {string}
 */
export function buildVerbatimMessage(artifacts) {
  const { task, implSource, symbol } = artifacts;
  const description = task.description ?? task.id;
  return (
    `You called yakcc_resolve for «${description}» and got confidence_tier auto_accept. ` +
    `You then called yakcc_compile and received this source:\n\n` +
    `\`\`\`typescript\n${implSource}\n\`\`\`\n\n` +
    `Complete the task now.`
  );
}

/**
 * Build the user message for the REFERENCE condition.
 *
 * Simulates: .yakcc/manifest.json is present + yakcc_reference returned artifacts.
 * The system prompt Section A instructs: write only the import line, append manifest
 * entry, write dts — do NOT write the implementation body.
 * Expected model output: import line + brief notes (~10–15 tokens of real content).
 *
 * @param {AtomArtifacts} artifacts
 * @returns {string}
 */
export function buildReferenceMessage(artifacts) {
  const { task, importLine, dtsContent, dtsPath, manifestEntry } = artifacts;
  const description = task.description ?? task.id;
  const referenceToolResult = JSON.stringify({
    manifest_entry: manifestEntry,
    import_line: importLine,
    dts_ref: { path: dtsPath, dts: dtsContent },
  }, null, 2);
  return (
    `This project is configured for compose-by-reference (\`.yakcc/manifest.json\` is present). ` +
    `You called yakcc_resolve for «${description}» and got confidence_tier auto_accept. ` +
    `You then called yakcc_reference and received:\n\n` +
    `${referenceToolResult}\n\n` +
    `Complete the task now.`
  );
}

// ---------------------------------------------------------------------------
// Cost estimation (dry-mode: uses assumed output token budgets)
// ---------------------------------------------------------------------------

/**
 * Estimate tokens for a string using the standard heuristic (chars / 4).
 * Used for input token estimation in dry mode.
 */
function estimateInputTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate cost of one (atom, model, condition, rep) cell.
 *
 * In dry mode we don't know actual output tokens, so we use the
 * EXPERIMENT_DEFAULTS estimated budgets. System prompt tokens are estimated
 * the same way (one call = one system prompt, but cache_creation on first,
 * cache_read on subsequent — we conservatively assume full input for simplicity).
 *
 * @param {object} opts
 * @returns {number} USD
 */
function estimateCellCostUsd({ model, condition, systemTokens, userTokens }) {
  const assumedOutputTokens = EXPERIMENT_DEFAULTS.estimatedOutputTokens[condition];
  // Conservative: no cache credit in estimate (overestimates, safe side)
  return estimateCostUsd({
    model_id: model,
    input_tokens: systemTokens + userTokens,
    output_tokens: assumedOutputTokens,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ExperimentCell
 * @property {string} atomId
 * @property {string} model
 * @property {string} condition
 * @property {number} rep
 * @property {AtomArtifacts} artifacts
 * @property {string} userMessage
 * @property {number} estimatedInputTokens
 * @property {number} estimatedOutputTokens
 * @property {number} estimatedCostUsd
 */

/**
 * @typedef {object} ExperimentPlan
 * @property {ExperimentCell[]} cells
 * @property {string[]} atoms
 * @property {string[]} models
 * @property {string[]} conditions
 * @property {number} reps
 * @property {number} maxUsd
 * @property {number} systemPromptTokens
 * @property {number} totalEstimatedCostUsd
 * @property {Map<string, AtomArtifacts>} artifactsByAtomId
 */

/**
 * Build the full experiment plan. Pure, no API calls.
 *
 * This is exported so tests can inspect plan structure without triggering any I/O.
 *
 * @param {object} opts
 * @param {string[]} [opts.atoms]
 * @param {string[]} [opts.models]
 * @param {number}   [opts.reps]
 * @param {number}   [opts.maxUsd]
 * @returns {ExperimentPlan}
 */
export function buildPlan(opts = {}) {
  const atoms = opts.atoms ?? EXPERIMENT_DEFAULTS.atoms;
  const models = opts.models ?? EXPERIMENT_DEFAULTS.models;
  const conditions = EXPERIMENT_DEFAULTS.conditions;
  const reps = opts.reps ?? EXPERIMENT_DEFAULTS.reps;
  const maxUsd = opts.maxUsd ?? EXPERIMENT_DEFAULTS.maxUsd;

  const systemPromptTokens = estimateInputTokens(SYSTEM_PROMPT);

  // Load artifacts for all atoms
  const artifactsByAtomId = new Map();
  for (const atomId of atoms) {
    artifactsByAtomId.set(atomId, loadAtomArtifacts(atomId));
  }

  const cells = [];
  for (const atomId of atoms) {
    const artifacts = artifactsByAtomId.get(atomId);
    for (const model of models) {
      for (const condition of conditions) {
        for (let rep = 0; rep < reps; rep++) {
          const userMessage =
            condition === "verbatim"
              ? buildVerbatimMessage(artifacts)
              : buildReferenceMessage(artifacts);
          const userTokens = estimateInputTokens(userMessage);
          const estimatedInputTokens = systemPromptTokens + userTokens;
          const estimatedOutputTokens = EXPERIMENT_DEFAULTS.estimatedOutputTokens[condition];
          const estimatedCostUsd = estimateCellCostUsd({
            model,
            condition,
            systemTokens: systemPromptTokens,
            userTokens,
          });
          cells.push({
            atomId,
            model,
            condition,
            rep,
            artifacts,
            userMessage,
            estimatedInputTokens,
            estimatedOutputTokens,
            estimatedCostUsd,
          });
        }
      }
    }
  }

  const totalEstimatedCostUsd = cells.reduce((s, c) => s + c.estimatedCostUsd, 0);

  return {
    cells,
    atoms,
    models,
    conditions,
    reps,
    maxUsd,
    systemPromptTokens,
    totalEstimatedCostUsd,
    artifactsByAtomId,
  };
}

/**
 * Estimate the total plan cost. Convenience wrapper used in tests.
 *
 * @param {ExperimentPlan} plan
 * @returns {{ totalUsd: number, perCell: Array<{atomId, model, condition, rep, usd}> }}
 */
export function estimatePlanCostUsd(plan) {
  return {
    totalUsd: plan.totalEstimatedCostUsd,
    perCell: plan.cells.map((c) => ({
      atomId: c.atomId,
      model: c.model,
      condition: c.condition,
      rep: c.rep,
      usd: c.estimatedCostUsd,
    })),
  };
}

// ---------------------------------------------------------------------------
// Dry-mode output
// ---------------------------------------------------------------------------

function printDryRun(plan) {
  const { cells, atoms, models, conditions, reps, systemPromptTokens, totalEstimatedCostUsd, maxUsd } = plan;

  console.log("=".repeat(80));
  console.log("PAID EXPERIMENT DRY RUN — no API calls made");
  console.log("=".repeat(80));
  console.log();
  console.log("Plan summary:");
  console.log(`  atoms:       ${atoms.join(", ")}`);
  console.log(`  models:      ${models.join(", ")}`);
  console.log(`  conditions:  ${conditions.join(", ")}`);
  console.log(`  reps:        ${reps}`);
  console.log(`  total cells: ${cells.length}`);
  console.log(`  system prompt: ${SYSTEM_PROMPT_PATH}`);
  console.log(`  system prompt tokens (est): ${systemPromptTokens}`);
  console.log();

  // Cost estimate
  console.log("Cost estimate (conservative — no cache credit, assumed output tokens):");
  console.log(`  Assumed output tokens — verbatim: ~${EXPERIMENT_DEFAULTS.estimatedOutputTokens.verbatim}`);
  console.log(`  Assumed output tokens — reference: ~${EXPERIMENT_DEFAULTS.estimatedOutputTokens.reference}`);
  console.log();

  // Per-model summary
  for (const model of models) {
    const modelCells = cells.filter((c) => c.model === model);
    const modelTotal = modelCells.reduce((s, c) => s + c.estimatedCostUsd, 0);
    console.log(`  ${model}: $${modelTotal.toFixed(4)}`);
  }
  console.log(`  TOTAL: $${totalEstimatedCostUsd.toFixed(4)}  (cap: $${maxUsd.toFixed(2)})`);
  console.log();

  if (totalEstimatedCostUsd > maxUsd) {
    console.log(`  ⚠  WARNING: estimated cost $${totalEstimatedCostUsd.toFixed(4)} EXCEEDS cap $${maxUsd.toFixed(2)}`);
    console.log(`     Real run would abort. Reduce --atoms or --reps, or raise --max-usd.`);
  } else {
    console.log(`  Cost gate: PASS (estimate under cap)`);
  }
  console.log();

  // Per-cell messages (truncated for readability)
  const MAX_MSG_PREVIEW = 300;
  console.log("-".repeat(80));
  console.log("Per-cell user messages (truncated to first 300 chars):");
  console.log("-".repeat(80));
  for (const cell of cells) {
    const preview = cell.userMessage.slice(0, MAX_MSG_PREVIEW).replace(/\n/g, "\\n");
    const ellipsis = cell.userMessage.length > MAX_MSG_PREVIEW ? "..." : "";
    console.log();
    console.log(`[${cell.atomId}] model=${cell.model} condition=${cell.condition} rep=${cell.rep}`);
    console.log(`  est input_tokens=${cell.estimatedInputTokens}  est output_tokens=${cell.estimatedOutputTokens}  est_usd=$${cell.estimatedCostUsd.toFixed(6)}`);
    console.log(`  user: ${preview}${ellipsis}`);
  }

  console.log();
  console.log("=".repeat(80));
  console.log("To run real experiment (requires ANTHROPIC_API_KEY):");
  console.log("  ANTHROPIC_API_KEY=sk-ant-... node bench/B4-tokens-v5/reference-emit/paid-experiment.mjs --real");
  console.log("=".repeat(80));
}

// ---------------------------------------------------------------------------
// Real-mode: actual Anthropic API calls
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CellResult
 * @property {string} atomId
 * @property {string} model
 * @property {string} condition
 * @property {number} rep
 * @property {number} output_tokens
 * @property {number} input_tokens
 * @property {number} cache_read_input_tokens
 * @property {number} cache_creation_input_tokens
 * @property {number} actualCostUsd
 * @property {boolean} behavioralPass  — reference: contains import line, not impl body
 * @property {string}  responseText
 * @property {string}  timestamp
 */

/**
 * Run one cell against the real Anthropic API.
 *
 * @param {object} opts
 * @param {object} opts.client        — Anthropic client instance
 * @param {ExperimentCell} opts.cell
 * @returns {Promise<CellResult>}
 */
async function runCell({ client, cell }) {
  const { atomId, model, condition, rep, artifacts, userMessage } = cell;
  const maxTokens = condition === "verbatim"
    ? EXPERIMENT_DEFAULTS.maxTokensVerbatim
    : EXPERIMENT_DEFAULTS.maxTokensReference;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  });

  const usage = response.usage;
  const outputTokens = usage.output_tokens;
  const inputTokens = usage.input_tokens;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;

  const actualCostUsd = estimateCostUsd({
    model_id: model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  });

  const responseText = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // Behavioral correctness check
  let behavioralPass = false;
  if (condition === "reference") {
    // Reference condition: output MUST contain the import line and MUST NOT
    // contain a distinctive impl substring (the first 40 chars of the impl body
    // past the license header, skipping blank lines and comments).
    const implLines = artifacts.implSource.split("\n").filter(
      (l) => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"),
    );
    const implDistinctiveSnippet = implLines.slice(0, 3).join(" ").slice(0, 80);
    const containsImportLine = responseText.includes(artifacts.importLine);
    const containsImplBody = implDistinctiveSnippet.length > 10
      ? responseText.includes(implDistinctiveSnippet)
      : false;
    behavioralPass = containsImportLine && !containsImplBody;
  } else {
    // Verbatim condition: output should contain a substantial impl block.
    // We just check it is non-trivially long.
    behavioralPass = outputTokens > 50;
  }

  return {
    atomId,
    model,
    condition,
    rep,
    output_tokens: outputTokens,
    input_tokens: inputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    actualCostUsd,
    behavioralPass,
    responseText,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Run all cells for the plan against the real API.
 * Enforces rolling spend cap; aborts if exceeded.
 *
 * @param {ExperimentPlan} plan
 * @returns {Promise<CellResult[]>}
 */
async function runRealExperiment(plan) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "ERROR: ANTHROPIC_API_KEY is not set in the environment.\n" +
      "       Export it before running --real:\n" +
      "         export ANTHROPIC_API_KEY=sk-ant-...\n" +
      "         node ... --real",
    );
    process.exit(1);
  }

  // Cost gate: refuse if estimated cost exceeds cap
  if (plan.totalEstimatedCostUsd > plan.maxUsd) {
    console.error(
      `ERROR: Estimated cost $${plan.totalEstimatedCostUsd.toFixed(4)} exceeds ` +
      `--max-usd cap $${plan.maxUsd.toFixed(2)}.\n` +
      `       Reduce --atoms or --reps, or raise --max-usd, then retry.`,
    );
    process.exit(1);
  }

  // Dynamic import of @anthropic-ai/sdk — only in real mode.
  // The bench/B4-tokens-v5 package.json lists it as a dependency.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  console.log("=".repeat(80));
  console.log("PAID EXPERIMENT — REAL MODE");
  console.log(`  ${plan.cells.length} cells, models: ${plan.models.join(", ")}`);
  console.log(`  Estimated cost: $${plan.totalEstimatedCostUsd.toFixed(4)} / cap: $${plan.maxUsd.toFixed(2)}`);
  console.log("=".repeat(80));
  console.log();

  const results = [];
  let rollingSpend = 0;

  for (const cell of plan.cells) {
    const label = `[${cell.atomId}] model=${cell.model} condition=${cell.condition} rep=${cell.rep}`;
    console.log(`Running ${label} ...`);

    const result = await runCell({ client, cell });
    results.push(result);

    rollingSpend += result.actualCostUsd;
    console.log(
      `  output_tokens=${result.output_tokens}  input_tokens=${result.input_tokens}` +
      `  cache_read=${result.cache_read_input_tokens}  cache_creation=${result.cache_creation_input_tokens}` +
      `  actual_usd=$${result.actualCostUsd.toFixed(6)}` +
      `  behavioral_pass=${result.behavioralPass}` +
      `  rolling_spend=$${rollingSpend.toFixed(4)}`,
    );

    // Hard rolling spend check
    if (rollingSpend > plan.maxUsd) {
      console.error(
        `\nABORTED: rolling spend $${rollingSpend.toFixed(4)} exceeded cap $${plan.maxUsd.toFixed(2)}.\n` +
        `Partial results written.`,
      );
      break;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Results aggregation and reporting
// ---------------------------------------------------------------------------

/**
 * Aggregate per (atom, model) for headline numbers.
 */
function aggregateResults(results) {
  // Group by atomId + model
  const groups = new Map();
  for (const r of results) {
    const key = `${r.atomId}|${r.model}`;
    if (!groups.has(key)) {
      groups.set(key, { verbatim: [], reference: [] });
    }
    groups.get(key)[r.condition].push(r);
  }

  const rows = [];
  for (const [key, { verbatim, reference }] of groups.entries()) {
    const [atomId, model] = key.split("|");
    const avgVerbatimOut = verbatim.length
      ? verbatim.reduce((s, r) => s + r.output_tokens, 0) / verbatim.length
      : null;
    const avgReferenceOut = reference.length
      ? reference.reduce((s, r) => s + r.output_tokens, 0) / reference.length
      : null;
    const ratio = avgVerbatimOut != null && avgReferenceOut != null && avgReferenceOut > 0
      ? avgVerbatimOut / avgReferenceOut
      : null;
    const behavioralPassRate = reference.length
      ? reference.filter((r) => r.behavioralPass).length / reference.length
      : null;
    rows.push({ atomId, model, avgVerbatimOut, avgReferenceOut, ratio, behavioralPassRate });
  }

  return rows;
}

function buildResultsMarkdown(results, plan, aggregated) {
  const lines = [];
  lines.push("# Reference-Emit Paid Experiment Results");
  lines.push("");
  lines.push(`*Run at: ${new Date().toISOString()}*`);
  lines.push(`*atoms: ${plan.atoms.join(", ")}*`);
  lines.push(`*models: ${plan.models.join(", ")}*`);
  lines.push(`*reps: ${plan.reps}*`);
  lines.push(`*total cells run: ${results.length} / ${plan.cells.length}*`);
  lines.push("");
  lines.push("## Headline: avg output_tokens per (atom, model)");
  lines.push("");
  lines.push("| atom | model | verbatim_out_tok | reference_out_tok | ratio | ref_behavioral_pass |");
  lines.push("|------|-------|-----------------|------------------|-------|---------------------|");
  for (const row of aggregated) {
    const vStr = row.avgVerbatimOut != null ? row.avgVerbatimOut.toFixed(1) : "n/a";
    const rStr = row.avgReferenceOut != null ? row.avgReferenceOut.toFixed(1) : "n/a";
    const ratioStr = row.ratio != null ? `${row.ratio.toFixed(1)}x` : "n/a";
    const passStr = row.behavioralPassRate != null ? `${(row.behavioralPassRate * 100).toFixed(0)}%` : "n/a";
    lines.push(`| ${row.atomId} | ${row.model} | ${vStr} | ${rStr} | ${ratioStr} | ${passStr} |`);
  }
  lines.push("");
  lines.push("## Raw cell results");
  lines.push("");
  lines.push("| atom | model | condition | rep | output_tok | input_tok | cache_read | cache_create | actual_usd | behavioral_pass |");
  lines.push("|------|-------|-----------|-----|-----------|----------|-----------|-------------|-----------|-----------------|");
  for (const r of results) {
    lines.push(
      `| ${r.atomId} | ${r.model} | ${r.condition} | ${r.rep} | ${r.output_tokens} | ${r.input_tokens} | ${r.cache_read_input_tokens} | ${r.cache_creation_input_tokens} | $${r.actualCostUsd.toFixed(6)} | ${r.behavioralPass} |`,
    );
  }
  lines.push("");
  lines.push("## Total spend");
  const totalSpend = results.reduce((s, r) => s + r.actualCostUsd, 0);
  lines.push(`$${totalSpend.toFixed(4)} across ${results.length} cells`);
  return lines.join("\n");
}

function printRealSummary(results, plan) {
  const aggregated = aggregateResults(results);
  console.log();
  console.log("=".repeat(80));
  console.log("RESULTS SUMMARY");
  console.log("=".repeat(80));
  console.log();
  console.log("avg output_tokens per (atom, model):");
  console.log();
  console.log("  atom                 model                         verbatim  reference  ratio  pass%");
  console.log("  " + "-".repeat(85));
  for (const row of aggregated) {
    const vStr = row.avgVerbatimOut != null ? row.avgVerbatimOut.toFixed(0).padStart(8) : "     n/a";
    const rStr = row.avgReferenceOut != null ? row.avgReferenceOut.toFixed(0).padStart(9) : "      n/a";
    const ratioStr = row.ratio != null ? `${row.ratio.toFixed(1)}x`.padStart(6) : "   n/a";
    const passStr = row.behavioralPassRate != null ? `${(row.behavioralPassRate * 100).toFixed(0)}%`.padStart(5) : "  n/a";
    console.log(`  ${row.atomId.padEnd(20)} ${row.model.padEnd(30)} ${vStr} ${rStr} ${ratioStr} ${passStr}`);
  }
  console.log();
  const totalSpend = results.reduce((s, r) => s + r.actualCostUsd, 0);
  console.log(`  Total actual spend: $${totalSpend.toFixed(4)}`);

  // Write results
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }
  const jsonPath = join(RESULTS_DIR, "paid-experiment.json");
  const mdPath = join(RESULTS_DIR, "paid-experiment.md");
  const resultPayload = {
    experiment: "refemit-paid",
    runAt: new Date().toISOString(),
    plan: {
      atoms: plan.atoms, models: plan.models, reps: plan.reps,
      cells: plan.cells.length, estimatedCostUsd: plan.totalEstimatedCostUsd,
    },
    results,
    aggregated,
    totalActualSpendUsd: totalSpend,
  };
  writeFileSync(jsonPath, JSON.stringify(resultPayload, null, 2) + "\n");
  writeFileSync(mdPath, buildResultsMarkdown(results, plan, aggregated) + "\n");
  console.log();
  console.log(`Results written to:`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${mdPath}`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    dry:      { type: "boolean", default: true },
    real:     { type: "boolean", default: false },
    atoms:    { type: "string"  },
    models:   { type: "string"  },
    reps:     { type: "string"  },
    "max-usd": { type: "string" },
  },
  strict: false,
});

// --real overrides --dry; --dry is the safe default
const isDry = !flags.real;

const planOpts = {
  atoms:  flags.atoms  ? flags.atoms.split(",").map((s) => s.trim())  : undefined,
  models: flags.models ? flags.models.split(",").map((s) => s.trim()) : undefined,
  reps:   flags.reps   ? parseInt(flags.reps, 10)                     : undefined,
  maxUsd: flags["max-usd"] ? parseFloat(flags["max-usd"])             : undefined,
};

const plan = buildPlan(planOpts);

if (isDry) {
  printDryRun(plan);
} else {
  const results = await runRealExperiment(plan);
  printRealSummary(results, plan);
}
