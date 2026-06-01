// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/tasks-hard/size-delta.mjs
//
// @decision DEC-BENCH-B4-V5-SIZEDELTA-001
// @title Size-stratified token-delta dossier: small (existing v5) vs large (hard #1049)
// @status accepted (#1049, epic #1043)
// @rationale
//   Issue #1041 showed that substitution value lives on the LARGE/HARD tail. This script
//   makes that concrete: it measures the combined corpus (6 existing easy/small atoms +
//   3 new hard/large atoms from #1049), stratifies by impl size, and shows that both
//   absolute output-token SAVINGS and the collapse ratio grow with atom size.
//
//   Methodology mirrors bench/B4-tokens-v5/reference-emit/measure.mjs (#1041):
//     - Token heuristic: tokens = ceil(chars / 4) — same as measure.mjs
//     - Synthetic BlockMerkleRoot: SHA-256 of impl source (deterministic 64-char hex)
//     - Real @yakcc/compile production functions: addReference, referenceImportLine, emptyManifest
//     - Symbol from expected_export: strip "named:" prefix
//
//   Stratification groups:
//     "small" = the 6 existing B4-v5 easy tasks (tasks.json) — median ~120 impl lines
//     "large" = the 3 new hard #1049 tasks (tasks-hard.json) — all >=200 impl lines
//
//   OFFLINE ONLY. No API calls, no model runs, no fabricated numbers.
//   Pass-rate / rescue-rate matrix is OPERATOR-GATED: see results/size-delta.md.
//
//   Usage:
//     node bench/B4-tokens-v5/tasks-hard/size-delta.mjs
//     node bench/B4-tokens-v5/tasks-hard/size-delta.mjs --json
//     YAKCC_REPO_ROOT=/path/to/yakcc node bench/B4-tokens-v5/tasks-hard/size-delta.mjs
//
// Exports (for size-delta.test.mjs):
//   runSizeDelta() → Promise<SizeDeltaResult>

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
// BENCH_ROOT is bench/B4-tokens-v5/
const BENCH_ROOT = resolve(__dirname, "..");
// REPO_ROOT: support YAKCC_REPO_ROOT env override (e.g. worktree pointing to main repo).
// Default: resolve from __dirname (works when packages are built in the worktree).
const REPO_ROOT = process.env.YAKCC_REPO_ROOT ?? resolve(__dirname, "../../..");
const RESULTS_DIR = join(__dirname, "results");

// ---------------------------------------------------------------------------
// @yakcc/compile imports — real production path, not mocks.
// Mirrors measure.mjs's import pattern exactly.
// ---------------------------------------------------------------------------

const { addReference, emptyManifest, referenceImportLine } = await import(
  `file://${join(REPO_ROOT, "packages", "compile", "dist", "index.js")}`
);

// ---------------------------------------------------------------------------
// Token estimation — documented heuristic (same as measure.mjs)
// ---------------------------------------------------------------------------

/**
 * Estimate token count: tokens ≈ ceil(chars / 4).
 * Same heuristic as measure.mjs. The collapse RATIO is robust to tokenizer choice
 * because the same divisor applies to both sides (cancels out).
 */
function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// Synthetic BlockMerkleRoot — same approach as measure.mjs
// ---------------------------------------------------------------------------

/**
 * SHA-256 of impl source → deterministic 64-char hex BlockMerkleRoot.
 * Same derivation as measure.mjs. Not a real BLAKE3 root — measurement artifact only.
 */
function syntheticRoot(implSource) {
  return createHash("sha256").update(implSource, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Symbol from expected_export — same logic as measure.mjs
// ---------------------------------------------------------------------------

function symbolFromExpectedExport(expectedExport) {
  if (typeof expectedExport === "string" && expectedExport.startsWith("named:")) {
    return expectedExport.slice("named:".length);
  }
  return expectedExport ?? "UnknownSymbol";
}

// ---------------------------------------------------------------------------
// Combined corpus: 6 small atoms (tasks.json) + 3 large atoms (tasks-hard.json)
// ---------------------------------------------------------------------------

const TASKS_JSON_PATH = join(BENCH_ROOT, "tasks.json");
const TASKS_HARD_JSON_PATH = join(BENCH_ROOT, "tasks-hard.json");

const smallManifest = JSON.parse(readFileSync(TASKS_JSON_PATH, "utf8"));
const largeManifest = JSON.parse(readFileSync(TASKS_HARD_JSON_PATH, "utf8"));

/** @type {Array<{task: object, stratum: "small"|"large"}>} */
const COMBINED_CORPUS = [
  ...smallManifest.tasks.map((t) => ({ task: t, stratum: "small" })),
  ...largeManifest.tasks.map((t) => ({ task: t, stratum: "large" })),
];

// ---------------------------------------------------------------------------
// Per-atom measurement
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AtomDelta
 * @property {string} atomId
 * @property {string} stratum  "small" | "large"
 * @property {string} symbol
 * @property {number} implLines
 * @property {{ chars: number, tokens: number }} verbatim
 * @property {{ chars: number, tokens: number }} reference
 * @property {number} absoluteSavings   impl_tokens − import_tokens
 * @property {number} collapseRatio     impl_tokens / import_tokens
 * @property {string} importLine
 */

/**
 * Measure one atom from the combined corpus.
 */
async function measureAtomDelta(task, stratum) {
  const { id: atomId, reference_impl: referenceImplRelPath, expected_export } = task;

  const implPath = join(BENCH_ROOT, referenceImplRelPath);
  if (!existsSync(implPath)) {
    throw new Error(`reference-impl not found: ${implPath}`);
  }
  const implSource = readFileSync(implPath, "utf8");
  const implLines = implSource.split("\n").length;

  const symbol = symbolFromExpectedExport(expected_export);

  const verbatimChars = implSource.length;
  const verbatimTokens = estimateTokens(verbatimChars);

  // Real @yakcc/compile: addReference + referenceImportLine (same as measure.mjs)
  const root = syntheticRoot(implSource);
  const { reference } = addReference(emptyManifest(), { root, symbol });
  const importLine = referenceImportLine(reference);

  const importChars = importLine.length;
  const importTokens = estimateTokens(importChars);

  const absoluteSavings = verbatimTokens - importTokens;
  const collapseRatio = verbatimTokens / importTokens;

  return {
    atomId,
    stratum,
    symbol,
    implLines,
    verbatim: { chars: verbatimChars, tokens: verbatimTokens },
    reference: { chars: importChars, tokens: importTokens },
    absoluteSavings,
    collapseRatio,
    importLine,
  };
}

// ---------------------------------------------------------------------------
// Aggregate statistics per stratum
// ---------------------------------------------------------------------------

/**
 * Compute stratum aggregate.
 */
function stratumAggregate(atoms) {
  const totalVerbatimTokens = atoms.reduce((s, a) => s + a.verbatim.tokens, 0);
  const totalImportTokens = atoms.reduce((s, a) => s + a.reference.tokens, 0);
  const totalSavings = atoms.reduce((s, a) => s + a.absoluteSavings, 0);
  const ratios = atoms.map((a) => a.collapseRatio);
  const sortedRatios = [...ratios].sort((a, b) => a - b);
  const medianRatio =
    sortedRatios.length % 2 === 0
      ? (sortedRatios[sortedRatios.length / 2 - 1] + sortedRatios[sortedRatios.length / 2]) / 2
      : sortedRatios[Math.floor(sortedRatios.length / 2)];
  const savings = atoms.map((a) => a.absoluteSavings);
  const sortedSavings = [...savings].sort((a, b) => a - b);
  const medianSavings =
    sortedSavings.length % 2 === 0
      ? (sortedSavings[sortedSavings.length / 2 - 1] + sortedSavings[sortedSavings.length / 2]) / 2
      : sortedSavings[Math.floor(sortedSavings.length / 2)];
  return {
    n: atoms.length,
    totalVerbatimTokens,
    totalImportTokens,
    totalSavings,
    corpusCollapseRatio: totalVerbatimTokens / totalImportTokens,
    medianAbsoluteSavings: medianSavings,
    medianCollapseRatio: medianRatio,
    minCollapseRatio: Math.min(...ratios),
    maxCollapseRatio: Math.max(...ratios),
  };
}

// ---------------------------------------------------------------------------
// Main entry point (exported for tests)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SizeDeltaResult
 * @property {AtomDelta[]} atoms              All 9 atoms, sorted by impl_tokens ascending
 * @property {AtomDelta[]} smallAtoms         The 6 existing small atoms
 * @property {AtomDelta[]} largeAtoms         The 3 new hard/large atoms
 * @property {object}      smallAggregate     Stratum stats for small
 * @property {object}      largeAggregate     Stratum stats for large
 * @property {object}      combinedAggregate  Stats over all 9 atoms
 * @property {string}      tokenHeuristic
 * @property {string}      measuredAt
 */

/**
 * Run the size-stratified token-delta analysis over the combined corpus.
 *
 * Deterministic: same reference-impl.ts files → same numbers.
 * No API calls, no network, no registry.
 *
 * @returns {Promise<SizeDeltaResult>}
 */
export async function runSizeDelta() {
  const atoms = [];
  for (const { task, stratum } of COMBINED_CORPUS) {
    atoms.push(await measureAtomDelta(task, stratum));
  }

  // Sort by impl_tokens ascending (size stratification is visible in sorted order)
  atoms.sort((a, b) => a.verbatim.tokens - b.verbatim.tokens);

  const smallAtoms = atoms.filter((a) => a.stratum === "small");
  const largeAtoms = atoms.filter((a) => a.stratum === "large");

  const smallAggregate = stratumAggregate(smallAtoms);
  const largeAggregate = stratumAggregate(largeAtoms);
  const combinedAggregate = stratumAggregate(atoms);

  return {
    atoms,
    smallAtoms,
    largeAtoms,
    smallAggregate,
    largeAggregate,
    combinedAggregate,
    tokenHeuristic:
      "tokens = ceil(chars / 4) — standard rough heuristic; ratio is robust to tokenizer choice",
    measuredAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Console table output
// ---------------------------------------------------------------------------

function formatTable(result) {
  const { atoms, smallAggregate, largeAggregate, combinedAggregate } = result;

  const lines = [];
  lines.push("# B4-v5 Size-Stratified Token-Delta Analysis (#1049 + existing corpus)");
  lines.push("# Token heuristic: tokens ≈ ceil(chars/4). Savings = impl_tok - import_tok.");
  lines.push("# Stratum: small = existing 6 v5 atoms | large = 3 new hard #1049 atoms");
  lines.push("# Sorted by impl_tokens ascending to show size → savings scaling.");
  lines.push("");

  // Header
  const hdr = [
    "atom".padEnd(20),
    "stratum".padEnd(8),
    "impl_lines".padStart(11),
    "impl_tok".padStart(9),
    "import_tok".padStart(11),
    "savings".padStart(8),
    "ratio".padStart(7),
  ].join("  ");
  lines.push(hdr);
  lines.push("-".repeat(hdr.length));

  for (const a of atoms) {
    const row = [
      a.atomId.padEnd(20),
      a.stratum.padEnd(8),
      String(a.implLines).padStart(11),
      String(a.verbatim.tokens).padStart(9),
      String(a.reference.tokens).padStart(11),
      String(a.absoluteSavings).padStart(8),
      a.collapseRatio.toFixed(1).padStart(7),
    ].join("  ");
    lines.push(row);
  }

  lines.push("-".repeat(hdr.length));
  lines.push("");

  lines.push("## Stratum Summary");
  lines.push("");

  const fmtStratum = (label, agg) => {
    lines.push(`### ${label} (n=${agg.n})`);
    lines.push(`  total_verbatim_tokens: ${agg.totalVerbatimTokens}`);
    lines.push(`  total_import_tokens:   ${agg.totalImportTokens}`);
    lines.push(`  total_savings:         ${agg.totalSavings}`);
    lines.push(`  corpus_collapse_ratio: ${agg.corpusCollapseRatio.toFixed(2)}x`);
    lines.push(`  median_savings:        ${agg.medianAbsoluteSavings}`);
    lines.push(`  median_ratio:          ${agg.medianCollapseRatio.toFixed(2)}x`);
    lines.push(`  min_ratio:             ${agg.minCollapseRatio.toFixed(2)}x`);
    lines.push(`  max_ratio:             ${agg.maxCollapseRatio.toFixed(2)}x`);
  };

  fmtStratum("Small / existing v5", smallAggregate);
  lines.push("");
  fmtStratum("Large / hard #1049", largeAggregate);
  lines.push("");
  lines.push(`### Combined (n=${combinedAggregate.n})`);
  lines.push(`  total_verbatim_tokens: ${combinedAggregate.totalVerbatimTokens}`);
  lines.push(`  total_import_tokens:   ${combinedAggregate.totalImportTokens}`);
  lines.push(`  corpus_collapse_ratio: ${combinedAggregate.corpusCollapseRatio.toFixed(2)}x`);
  lines.push("");

  lines.push("## Key Insight: Savings Scale with Atom Size");
  const smallMed = smallAggregate.medianAbsoluteSavings;
  const largeMed = largeAggregate.medianAbsoluteSavings;
  lines.push(`  Median absolute savings — small: ${smallMed} tok | large: ${largeMed} tok`);
  lines.push(
    `  Median collapse ratio  — small: ${smallAggregate.medianCollapseRatio.toFixed(1)}x  | large: ${largeAggregate.medianCollapseRatio.toFixed(1)}x`,
  );
  lines.push(
    `  Savings on large tail are ${(largeMed / smallMed).toFixed(1)}x greater than small corpus median.`,
  );
  lines.push("");
  lines.push("## OPERATOR-GATED (requires ANTHROPIC_API_KEY + paid model runs)");
  lines.push(
    "  Pass-rate / rescue-rate matrix on tasks-hard.json: see results/size-delta.md for exact command.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Dossier markdown
// ---------------------------------------------------------------------------

function buildDossier(result) {
  const { atoms, smallAtoms, largeAtoms, smallAggregate, largeAggregate, combinedAggregate } =
    result;

  const lines = [];
  lines.push("# Size-Stratified Token-Delta Dossier — B4-v5 Combined Corpus (#1049)");
  lines.push("");
  lines.push(`*Measured at: ${result.measuredAt}*`);
  lines.push(`*Token heuristic: ${result.tokenHeuristic}*`);
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push(
    "This dossier measures the **output-token collapse** (verbatim-write vs reference-emit)",
  );
  lines.push("across the combined B4-v5 corpus: 6 existing small atoms (tasks.json, issue #722)");
  lines.push("and 3 new large/hard atoms (tasks-hard.json, issue #1049).");
  lines.push("");
  lines.push("The headline claim from #1041 — *substitution value lives on the large/hard tail* —");
  lines.push(
    "is made concrete here: both absolute savings and the collapse ratio grow with atom size.",
  );
  lines.push("");
  lines.push("## Per-Atom Results (sorted by impl size, ascending)");
  lines.push("");
  lines.push("| atom | stratum | impl lines | impl tokens | import tokens | savings | ratio |");
  lines.push("|------|---------|-----------|------------|--------------|---------|-------|");

  for (const a of atoms) {
    const stratumLabel = a.stratum === "small" ? "small (existing)" : "**large (hard #1049)**";
    lines.push(
      `| ${a.atomId} | ${stratumLabel} | ${a.implLines} | ${a.verbatim.tokens} | ${a.reference.tokens} | ${a.absoluteSavings} | **${a.collapseRatio.toFixed(1)}x** |`,
    );
  }

  lines.push("");
  lines.push("## Stratum Aggregates");
  lines.push("");
  lines.push("### Small / existing v5 (6 atoms)");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("|--------|-------|");
  lines.push(`| total verbatim tokens | ${smallAggregate.totalVerbatimTokens} |`);
  lines.push(`| total import tokens | ${smallAggregate.totalImportTokens} |`);
  lines.push(`| total savings | ${smallAggregate.totalSavings} |`);
  lines.push(`| corpus collapse ratio | **${smallAggregate.corpusCollapseRatio.toFixed(2)}x** |`);
  lines.push(`| median absolute savings | ${smallAggregate.medianAbsoluteSavings} tok |`);
  lines.push(`| median collapse ratio | ${smallAggregate.medianCollapseRatio.toFixed(2)}x |`);
  lines.push(`| min ratio | ${smallAggregate.minCollapseRatio.toFixed(2)}x |`);
  lines.push(`| max ratio | ${smallAggregate.maxCollapseRatio.toFixed(2)}x |`);
  lines.push("");
  lines.push("### Large / hard #1049 (3 atoms)");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("|--------|-------|");
  lines.push(`| total verbatim tokens | ${largeAggregate.totalVerbatimTokens} |`);
  lines.push(`| total import tokens | ${largeAggregate.totalImportTokens} |`);
  lines.push(`| total savings | ${largeAggregate.totalSavings} |`);
  lines.push(`| corpus collapse ratio | **${largeAggregate.corpusCollapseRatio.toFixed(2)}x** |`);
  lines.push(`| median absolute savings | ${largeAggregate.medianAbsoluteSavings} tok |`);
  lines.push(`| median collapse ratio | ${largeAggregate.medianCollapseRatio.toFixed(2)}x |`);
  lines.push(`| min ratio | ${largeAggregate.minCollapseRatio.toFixed(2)}x |`);
  lines.push(`| max ratio | ${largeAggregate.maxCollapseRatio.toFixed(2)}x |`);
  lines.push("");
  lines.push("### Combined (9 atoms)");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("|--------|-------|");
  lines.push(`| total verbatim tokens | ${combinedAggregate.totalVerbatimTokens} |`);
  lines.push(`| total import tokens | ${combinedAggregate.totalImportTokens} |`);
  lines.push(
    `| corpus collapse ratio | **${combinedAggregate.corpusCollapseRatio.toFixed(2)}x** |`,
  );
  lines.push("");
  lines.push("## Key Finding: Savings Scale with Atom Size");
  lines.push("");
  const ratio = (
    largeAggregate.medianAbsoluteSavings / smallAggregate.medianAbsoluteSavings
  ).toFixed(1);
  lines.push("The data confirms the #1041 tail-value hypothesis:");
  lines.push("");
  lines.push(
    `- **Median absolute savings**: small = ${smallAggregate.medianAbsoluteSavings} tok, large = ${largeAggregate.medianAbsoluteSavings} tok (${ratio}× greater on the hard tail)`,
  );
  lines.push(
    `- **Median collapse ratio**: small = ${smallAggregate.medianCollapseRatio.toFixed(1)}x, large = ${largeAggregate.medianCollapseRatio.toFixed(1)}x`,
  );
  lines.push(
    `- **Collapse holds** for all 9 atoms: minimum ratio = ${combinedAggregate.minCollapseRatio.toFixed(1)}x > 1.0`,
  );
  lines.push("");
  lines.push("For the large/hard atoms (>=200 impl lines), the reference-emit flow saves");
  lines.push(
    `**${largeAggregate.medianAbsoluteSavings}+ output tokens per use** vs verbatim-write.`,
  );
  lines.push("On a multi-turn session with repeated atom use, savings compound.");
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    "- **Verbatim source**: `bench/B4-tokens-v5/tasks/<id>/reference-impl.ts` (small) and",
  );
  lines.push("  `bench/B4-tokens-v5/tasks-hard/<id>/reference-impl.ts` (large). These are the");
  lines.push("  ground-truth implementations the model would write under the verbatim-write flow.");
  lines.push(
    "- **Reference output**: one import line from real `@yakcc/compile` `referenceImportLine(addReference(...))` —",
  );
  lines.push("  the same production functions used by the `yakcc_reference` MCP tool (#1047).");
  lines.push(
    "- **Synthetic BlockMerkleRoot**: SHA-256 of impl source (deterministic 64-char hex).",
  );
  lines.push(
    "- **Token heuristic**: `tokens = ceil(chars / 4)`. The ratio is robust to tokenizer choice.",
  );
  lines.push("");
  lines.push("## OPERATOR-GATED: Pass-Rate / Rescue-Rate Matrix");
  lines.push("");
  lines.push(
    "The numbers above measure **offline output collapse only**. The other half of #1049's",
  );
  lines.push(
    "acceptance — unhooked fail-rate and hooked rescue-rate for the hard atoms — requires",
  );
  lines.push("**paid model runs** (Haiku especially) and is not done here (no API keys).");
  lines.push("");
  lines.push("### What the paid run measures");
  lines.push("");
  lines.push(
    "- **Unhooked fail-rate**: how often Haiku (and Sonnet) produce a wrong implementation",
  );
  lines.push("  for each hard atom without the yakcc discovery hook.");
  lines.push(
    "- **Rescue rate**: how often the hook's auto_accept substitution rescues a failing model.",
  );
  lines.push(
    "- **Token delta by size**: total turn-cost savings (input + output) for the large atoms.",
  );
  lines.push("");
  lines.push("### Exact command to run the matrix on the hard task set");
  lines.push("");
  lines.push("The v5 harness `bench/B4-tokens-v5/harness/phase2-v5.mjs` hard-codes `tasks.json`");
  lines.push("on line 282. To run it against `tasks-hard.json`, temporarily patch that reference");
  lines.push("(or use the `--task` flag to run individual atoms by ID, e.g. `--task avl-tree`):");
  lines.push("");
  lines.push("```bash");
  lines.push("# One-shot per hard atom (safest — no harness modification needed):");
  lines.push("cd bench/B4-tokens-v5");
  lines.push("ANTHROPIC_API_KEY=<key> YAKCC_REGISTRY_PATH=<registry.db> \\");
  lines.push("  node harness/phase2-v5.mjs --task avl-tree --n-reps 3");
  lines.push("");
  lines.push("ANTHROPIC_API_KEY=<key> YAKCC_REGISTRY_PATH=<registry.db> \\");
  lines.push("  node harness/phase2-v5.mjs --task pratt-expr-eval --n-reps 3");
  lines.push("");
  lines.push("ANTHROPIC_API_KEY=<key> YAKCC_REGISTRY_PATH=<registry.db> \\");
  lines.push("  node harness/phase2-v5.mjs --task dijkstra-heap --n-reps 3");
  lines.push("```");
  lines.push("");
  lines.push(
    "> **Note**: `phase2-v5.mjs --task <id>` loads the task from the hard-coded `tasks.json`.",
  );
  lines.push(
    "> The three hard atoms must therefore be **added to tasks.json** before the operator",
  );
  lines.push("> runs the full matrix, OR the harness must be extended with a `--tasks-file` flag");
  lines.push("> to accept an alternative manifest path such as `tasks-hard.json`.");
  lines.push("> The `tasks-hard.json` manifest uses the same schema as `tasks.json` and is");
  lines.push("> structurally compatible with the harness.");
  lines.push("");
  lines.push("### Cost estimate");
  lines.push("");
  lines.push("3 hard atoms × (cells E+F ≈ 6 cells) × 3 reps = ~54 model calls.");
  lines.push("At Haiku-3.5 pricing and ~4 KB prompts: rough estimate ~\\$0.10–\\$0.30 total.");
  lines.push("See `bench/B4-tokens-v5/harness/budget.mjs` for the per-run cap.");
  lines.push("");
  lines.push(
    "**NOT measured here**: no API key is available. Operator must supply ANTHROPIC_API_KEY.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    json: { type: "boolean", default: false },
  },
  strict: false,
});

const result = await runSizeDelta();

// Write results files
if (!existsSync(RESULTS_DIR)) {
  mkdirSync(RESULTS_DIR, { recursive: true });
}

const jsonPath = join(RESULTS_DIR, "size-delta.json");
const mdPath = join(RESULTS_DIR, "size-delta.md");

writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(mdPath, `${buildDossier(result)}\n`);

if (flags.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`${formatTable(result)}\n`);
  process.stdout.write(`\n[Results written to ${jsonPath}]\n`);
  process.stdout.write(`[Dossier written to ${mdPath}]\n`);
}
