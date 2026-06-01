// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/reference-emit/measure.mjs
//
// @decision DEC-BENCH-B4-REFEMIT-MEASURE-001
// @title Offline output-collapse measurement: verbatim-write vs reference-emit
// @status accepted (#1041, epic #1043)
// @rationale
//   The verbatim-write flow (#1030) directs the model to write assemble()'s returned
//   source VERBATIM as its output token budget. The reference-emit flow (#1047/#1048)
//   directs the model to write a single import line (~10 tokens) returned by
//   yakcc_reference. Both are DETERMINISTIC registry operations — no model API calls
//   needed. Therefore the output-token collapse is computable entirely offline.
//
//   Measurement scope (what this script proves):
//     OUTPUT collapse only — verbatim impl tokens vs import-line tokens.
//   Out of scope (operator-gated — requires ANTHROPIC_API_KEY + paid model runs):
//     Full multi-turn economics: input tokens, system prompt amortization,
//     narration costs, prompt cache on/off. See the OPERATOR-GATED section in README.md.
//
//   Token estimation: no tokenizer is bundled. We use the standard rough heuristic
//   tokens ≈ ceil(chars / 4). This is documented in every output table. The collapse
//   RATIO is robust to tokenizer choice (the same divisor cancels out), so the ratio
//   is the headline number.
//
//   What "verbatim impl" means: the reference-impl.ts files in bench/B4-tokens-v5/tasks/
//   ARE the ground-truth implementations these atoms would produce. Under the verbatim
//   flow, the model writes exactly this source as its response. Reading these files
//   directly is equivalent to calling assemble(root, registry).source for each atom,
//   without requiring the B4 task atoms to be loaded into a live registry (they are not
//   seed atoms; they are the BENCHMARK TARGET — written by the model during the live run).
//
//   What "reference output" means: the one-line import statement that the model writes
//   under the reference-emit flow. Computed via referenceImportLine(addReference(...))
//   from @yakcc/compile — the same authority used by yakcc_reference MCP tool (#1047).
//   The BlockMerkleRoot used for alias computation is a SHA-256 of the impl source
//   (deterministic synthetic root), satisfying the 64-char hex requirement.
//
//   What ".d.ts one-time cost" means: generateAtomDts(spec, symbol) produces the
//   TypeScript declaration that the model also writes once when first referencing an atom.
//   It is NOT repeated in subsequent uses of the same atom. For class-based atoms like
//   the B4 corpus, the real .d.ts would declare the class body; here we use a minimal
//   synthetic SpecYak (function signature) so generateAtomDts is called through the real
//   production code path. The chars/tokens are reported separately and labelled "one-time".
//
//   Usage:
//     node bench/B4-tokens-v5/reference-emit/measure.mjs
//     node bench/B4-tokens-v5/reference-emit/measure.mjs --json
//
// Exports (for measure.test.mjs):
//   runMeasurement()  → Promise<MeasurementResult>

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
// @yakcc/compile imports (real production path, not mocks)
// ---------------------------------------------------------------------------

// Dynamic import to resolve via the built dist. These are ESM imports of the
// compiled @yakcc/compile package — the production reference artifact builders.
const { addReference, emptyManifest, referenceImportLine, materializedDtsPath, generateAtomDts } =
  await import(
    `file://${join(REPO_ROOT, "packages", "compile", "dist", "index.js")}`
  );

// ---------------------------------------------------------------------------
// Token estimation — documented heuristic
// ---------------------------------------------------------------------------

/**
 * Estimate token count using the standard rough heuristic: tokens ≈ ceil(chars / 4).
 *
 * This heuristic is standard for quick estimation: most LLM tokenizers (GPT-3/4, Claude)
 * produce ~3.5–4 characters per token for English/code text. ceil(chars/4) errs
 * slightly conservative (overestimates tokens, underestimates compression).
 *
 * The collapse RATIO is robust to tokenizer choice: since both sides use the same
 * heuristic, the divisor (4) cancels out, and ratio = impl_chars / import_chars.
 * This makes the ratio the headline number.
 *
 * Callers that need exact token counts should run the actual tokenizer (tiktoken,
 * @anthropic-ai/tokenizer) — out of scope for this offline measurement.
 */
function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// Task corpus — from bench/B4-tokens-v5/tasks.json
// ---------------------------------------------------------------------------

const TASKS_JSON_PATH = join(BENCH_ROOT, "tasks.json");
const tasksManifest = JSON.parse(readFileSync(TASKS_JSON_PATH, "utf8"));

/**
 * Symbol derivation: extract the export class/function name from expected_export.
 *
 * tasks.json uses: "named:CRC32C", "named:Utf8Codec", etc.
 * Strip the "named:" prefix to get the symbol.
 */
function symbolFromExpectedExport(expectedExport) {
  if (typeof expectedExport === "string" && expectedExport.startsWith("named:")) {
    return expectedExport.slice("named:".length);
  }
  // Fallback: use the whole string
  return expectedExport ?? "UnknownSymbol";
}

// ---------------------------------------------------------------------------
// Deterministic synthetic BlockMerkleRoot
//
// The B4 task atoms (CRC32C, Utf8Codec, etc.) are not seed atoms — they are the
// benchmark target tasks the model writes during a live run. They exist in the v4
// Opus-built corpus registry, but NOT in the seeds package. To compute the reference
// artifact without that registry, we use a deterministic synthetic root:
// SHA-256 of the impl source, zero-padded to 64 hex chars. This satisfies the
// 64-char hex requirement of BlockMerkleRoot and is fully deterministic (same source
// → same root → same alias → same import line).
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic 64-char hex synthetic BlockMerkleRoot from the impl source.
 * Uses SHA-256 (available in Node without external deps).
 *
 * This is a measurement artifact, not a real BLAKE3 content address. It is used
 * solely to compute the alias and import path for the reference import line.
 */
function syntheticRoot(implSource) {
  return createHash("sha256").update(implSource, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Minimal SpecYak for generateAtomDts
//
// The B4 tasks export classes; generateAtomDts generates function declarations.
// For the .d.ts one-time cost measurement, we synthesize a minimal SpecYak with
// the class name as spec.name, no inputs, and no outputs (→ void return type).
// This exercises the real production code path (generateAtomDts) while producing
// the minimal possible .d.ts header (~4 lines, ~120 chars).
//
// NOTE: The REAL .d.ts for a class-based atom would declare the class body and be
// substantially longer (200–400+ chars). This measurement UNDERESTIMATES the one-time
// .d.ts cost for class atoms. The verbatim vs import-line ratio is unaffected.
// ---------------------------------------------------------------------------

/**
 * Synthesize a minimal SpecYak sufficient for generateAtomDts.
 *
 * Required fields per SpecYak: name, inputs, outputs, preconditions,
 * postconditions, invariants, effects, level.
 */
function syntheticSpec(symbol, taskId) {
  return {
    name: taskId,
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: 0,
  };
}

// ---------------------------------------------------------------------------
// Per-atom measurement
// ---------------------------------------------------------------------------

/**
 * Measure one atom: verbatim output chars/tokens vs reference import line chars/tokens.
 *
 * @param {object} task - One entry from tasks.json
 * @returns {AtomMeasurement}
 */
async function measureAtom(task) {
  const { id: atomId, reference_impl: referenceImplRelPath, expected_export } = task;

  // Read the verbatim implementation source (what the model writes under #1030).
  const implPath = join(BENCH_ROOT, referenceImplRelPath);
  if (!existsSync(implPath)) {
    throw new Error(`reference-impl not found: ${implPath}`);
  }
  const implSource = readFileSync(implPath, "utf8");

  const symbol = symbolFromExpectedExport(expected_export);

  // Verbatim output = full impl source
  const verbatimChars = implSource.length;
  const verbatimTokens = estimateTokens(verbatimChars);

  // Compute a deterministic synthetic BlockMerkleRoot from the impl source.
  const root = syntheticRoot(implSource);

  // Build the reference artifact using the REAL @yakcc/compile production functions.
  // addReference: computes alias (12-char prefix of root), importPath (.yakcc/atoms/<alias>)
  // referenceImportLine: `import { ${symbol} } from ".yakcc/atoms/${alias}";`
  const { reference } = addReference(emptyManifest(), { root, symbol });
  const importLine = referenceImportLine(reference);

  const importLineChars = importLine.length;
  const importLineTokens = estimateTokens(importLineChars);

  // DTS one-time cost: generateAtomDts via real production function.
  // Uses a minimal synthetic SpecYak (see note above about class vs function).
  const spec = syntheticSpec(symbol, atomId);
  const dtsContent = generateAtomDts(spec, symbol);
  const dtsPath = materializedDtsPath(reference.alias);

  const dtsChars = dtsContent.length;
  const dtsTokens = estimateTokens(dtsChars);

  // Collapse ratio: how many times more tokens the verbatim flow uses vs reference.
  const collapseRatio = verbatimTokens / importLineTokens;

  return {
    atomId,
    symbol,
    root,
    importLine,
    dtsPath,
    verbatim: { chars: verbatimChars, tokens: verbatimTokens },
    reference: { chars: importLineChars, tokens: importLineTokens },
    dts: { chars: dtsChars, tokens: dtsTokens, path: dtsPath },
    collapseRatio,
  };
}

// ---------------------------------------------------------------------------
// Aggregate statistics
// ---------------------------------------------------------------------------

function computeAggregate(atoms) {
  const totalVerbatimTokens = atoms.reduce((s, a) => s + a.verbatim.tokens, 0);
  const totalReferenceTokens = atoms.reduce((s, a) => s + a.reference.tokens, 0);
  const totalVerbatimChars = atoms.reduce((s, a) => s + a.verbatim.chars, 0);
  const totalReferenceChars = atoms.reduce((s, a) => s + a.reference.chars, 0);
  const ratios = atoms.map((a) => a.collapseRatio);
  const meanRatio = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  const sortedRatios = [...ratios].sort((a, b) => a - b);
  const midIdx = Math.floor(sortedRatios.length / 2);
  const medianRatio =
    sortedRatios.length % 2 === 0
      ? (sortedRatios[midIdx - 1] + sortedRatios[midIdx]) / 2
      : sortedRatios[midIdx];
  const minRatio = Math.min(...ratios);
  const maxRatio = Math.max(...ratios);
  const corpusCollapseRatio = totalVerbatimTokens / totalReferenceTokens;
  return {
    totalVerbatimChars,
    totalReferenceChars,
    totalVerbatimTokens,
    totalReferenceTokens,
    corpusCollapseRatio,
    meanRatio,
    medianRatio,
    minRatio,
    maxRatio,
    n: atoms.length,
  };
}

// ---------------------------------------------------------------------------
// Main measurement entry point (also exported for tests)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AtomMeasurement
 * @property {string} atomId
 * @property {string} symbol
 * @property {string} root
 * @property {string} importLine
 * @property {string} dtsPath
 * @property {{ chars: number, tokens: number }} verbatim
 * @property {{ chars: number, tokens: number }} reference
 * @property {{ chars: number, tokens: number, path: string }} dts
 * @property {number} collapseRatio
 */

/**
 * @typedef {object} MeasurementResult
 * @property {AtomMeasurement[]} atoms
 * @property {object} aggregate
 * @property {string} tokenHeuristic
 * @property {string} measuredAt
 */

/**
 * Run the full offline measurement across all B4-v5 task atoms.
 *
 * Deterministic: given the same reference-impl.ts files, produces the same numbers.
 * No API calls, no network, no registry needed.
 *
 * @returns {Promise<MeasurementResult>}
 */
export async function runMeasurement() {
  const atoms = [];
  for (const task of tasksManifest.tasks) {
    const measurement = await measureAtom(task);
    atoms.push(measurement);
  }
  const aggregate = computeAggregate(atoms);
  return {
    atoms,
    aggregate,
    tokenHeuristic: "tokens = ceil(chars / 4) — standard rough heuristic; ratio is robust to tokenizer choice",
    measuredAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatTable(result) {
  const { atoms, aggregate } = result;

  const lines = [];
  lines.push("# B4-v5 Reference-Emit Output-Collapse Measurement");
  lines.push("# Token heuristic: tokens ≈ ceil(chars/4). Ratio = verbatim_tokens / import_line_tokens.");
  lines.push("# Scope: OUTPUT collapse only (what the model writes). Input/narration economics are operator-gated.");
  lines.push("");

  // Header
  const header = [
    "atom".padEnd(20),
    "impl_chars".padStart(12),
    "impl_tok".padStart(10),
    "import_chars".padStart(13),
    "import_tok".padStart(11),
    "dts_chars(1x)".padStart(14),
    "dts_tok(1x)".padStart(12),
    "collapse_ratio".padStart(15),
  ].join("  ");
  lines.push(header);
  lines.push("-".repeat(header.length));

  for (const a of atoms) {
    const row = [
      a.atomId.padEnd(20),
      String(a.verbatim.chars).padStart(12),
      String(a.verbatim.tokens).padStart(10),
      String(a.reference.chars).padStart(13),
      String(a.reference.tokens).padStart(11),
      String(a.dts.chars).padStart(14),
      String(a.dts.tokens).padStart(12),
      a.collapseRatio.toFixed(1).padStart(15),
    ].join("  ");
    lines.push(row);
  }

  lines.push("-".repeat(header.length));

  const agg = aggregate;
  const aggRow = [
    "TOTAL/AGGREGATE".padEnd(20),
    String(agg.totalVerbatimChars).padStart(12),
    String(agg.totalVerbatimTokens).padStart(10),
    String(agg.totalReferenceChars).padStart(13),
    String(agg.totalReferenceTokens).padStart(11),
    "".padStart(14),
    "".padStart(12),
    agg.corpusCollapseRatio.toFixed(1).padStart(15),
  ].join("  ");
  lines.push(aggRow);

  lines.push("");
  lines.push("## Aggregate Statistics");
  lines.push(`  n_atoms:               ${agg.n}`);
  lines.push(`  corpus_collapse_ratio: ${agg.corpusCollapseRatio.toFixed(2)}x  (total verbatim / total import)`);
  lines.push(`  mean_ratio:            ${agg.meanRatio.toFixed(2)}x`);
  lines.push(`  median_ratio:          ${agg.medianRatio.toFixed(2)}x`);
  lines.push(`  min_ratio:             ${agg.minRatio.toFixed(2)}x  (most conservative atom)`);
  lines.push(`  max_ratio:             ${agg.maxRatio.toFixed(2)}x  (most compressible atom)`);
  lines.push("");
  lines.push("## Import lines written by the model (reference-emit flow)");
  for (const a of atoms) {
    lines.push(`  ${a.atomId}: ${a.importLine}`);
  }
  lines.push("");
  lines.push("## OPERATOR-GATED (requires ANTHROPIC_API_KEY + paid model runs)");
  lines.push("  The numbers above measure OUTPUT collapse only: the characters/tokens");
  lines.push("  the model writes as its response under verbatim vs reference-emit flow.");
  lines.push("  Full multi-turn economics (total cost per task) also depend on:");
  lines.push("    - Input tokens: ~12.5KB discovery system prompt per turn");
  lines.push("    - Prompt cache efficiency: cache_on vs cache_off sub-conditions");
  lines.push("    - Model narration: per-turn thinking/reasoning tokens");
  lines.push("    - Multi-turn overhead: resolve + reference vs compile turns");
  lines.push("  Run bench/B4-tokens-v5 (pnpm bench:tokens with ANTHROPIC_API_KEY)");
  lines.push("  to measure total economics. NOT done here: no API key in this environment.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Dossier markdown
// ---------------------------------------------------------------------------

function buildDossier(result) {
  const { atoms, aggregate } = result;

  const lines = [];
  lines.push("# Reference-Emit Output-Collapse Dossier — B4-v5 Corpus");
  lines.push("");
  lines.push(`*Measured at: ${result.measuredAt}*`);
  lines.push(`*Token heuristic: ${result.tokenHeuristic}*`);
  lines.push("");
  lines.push("## What This Measures");
  lines.push("");
  lines.push("The **verbatim-write flow** (#1030) directs the model to write the full");
  lines.push("atom implementation as its output (the `assemble()` source verbatim).");
  lines.push("The **reference-emit flow** (#1047/#1048) directs the model to write a");
  lines.push("single import line (~10 tokens) returned by `yakcc_reference`.");
  lines.push("");
  lines.push("This dossier reports the **real measured OUTPUT collapse** across the 6");
  lines.push("atoms in the B4-v5 benchmark corpus (crc32c, utf8-codec, base32-rfc4648,");
  lines.push("lru-ttl-cache, semver-range, ring-buffer).");
  lines.push("");
  lines.push("## Per-Atom Results");
  lines.push("");
  lines.push("| atom | impl chars | impl tok | import chars | import tok | dts chars (1x) | dts tok (1x) | collapse |");
  lines.push("|------|-----------|---------|-------------|-----------|---------------|-------------|---------|");

  for (const a of atoms) {
    lines.push(
      `| ${a.atomId} | ${a.verbatim.chars} | ${a.verbatim.tokens} | ${a.reference.chars} | ${a.reference.tokens} | ${a.dts.chars} | ${a.dts.tokens} | **${a.collapseRatio.toFixed(1)}x** |`,
    );
  }

  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push(`| metric | value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| corpus (6 atoms) verbatim tokens | ${aggregate.totalVerbatimTokens} |`);
  lines.push(`| corpus (6 atoms) import tokens | ${aggregate.totalReferenceTokens} |`);
  lines.push(`| corpus collapse ratio | **${aggregate.corpusCollapseRatio.toFixed(2)}x** |`);
  lines.push(`| mean per-atom ratio | ${aggregate.meanRatio.toFixed(2)}x |`);
  lines.push(`| median per-atom ratio | ${aggregate.medianRatio.toFixed(2)}x |`);
  lines.push(`| min ratio (most conservative) | ${aggregate.minRatio.toFixed(2)}x |`);
  lines.push(`| max ratio (most compressible) | ${aggregate.maxRatio.toFixed(2)}x |`);
  lines.push("");
  lines.push("## Import Lines (reference-emit output)");
  lines.push("");
  for (const a of atoms) {
    lines.push(`- \`${a.atomId}\`: \`${a.importLine}\``);
  }
  lines.push("");
  lines.push("## Methodology Notes");
  lines.push("");
  lines.push("- **Verbatim source**: `bench/B4-tokens-v5/tasks/<id>/reference-impl.ts`");
  lines.push("  These files are the ground-truth implementations. Under the verbatim flow,");
  lines.push("  the model writes exactly this source as its response.");
  lines.push("- **Synthetic BlockMerkleRoot**: SHA-256 of impl source (deterministic 64-char hex).");
  lines.push("  Used to compute the alias prefix for the import path. Not a real BLAKE3 root.");
  lines.push("- **Token heuristic**: `tokens = ceil(chars / 4)`. Standard rough estimate.");
  lines.push("  The ratio is robust to tokenizer choice (divisor cancels out).");
  lines.push("- **DTS one-time cost**: `generateAtomDts(syntheticSpec, symbol)` via real");
  lines.push("  production function. B4 atoms export classes; the synthetic spec uses empty");
  lines.push("  inputs/outputs (→ `void`), so DTS chars are a LOWER BOUND on actual cost.");
  lines.push("- **Reference functions**: real `@yakcc/compile` production code: `addReference`,");
  lines.push("  `referenceImportLine`, `generateAtomDts` (same as yakcc_reference MCP tool).");
  lines.push("");
  lines.push("## OPERATOR-GATED: Full Multi-Turn Economics");
  lines.push("");
  lines.push("The numbers above confirm the **OUTPUT collapse** the #1041 analysis predicted.");
  lines.push("The full cost-per-task economics also depend on inputs and narration:");
  lines.push("");
  lines.push("- **~12.5KB discovery system prompt** amortized across all turns");
  lines.push("- **Prompt cache efficiency**: cache_on vs cache_off (measured by v5 harness)");
  lines.push("- **Model narration**: per-turn thinking/explanation tokens");
  lines.push("- **Multi-turn overhead**: resolve + reference vs single compile turn");
  lines.push("");
  lines.push("These require **paid model runs** via the v5 harness:");
  lines.push("```");
  lines.push("ANTHROPIC_API_KEY=... YAKCC_REGISTRY_PATH=... pnpm bench:tokens");
  lines.push("```");
  lines.push("**NOT measured here**: no API key is available in this environment.");
  lines.push("The operator-gated paid run is Epic #1043 Phase 2.");

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

const result = await runMeasurement();

// Write results files
if (!existsSync(RESULTS_DIR)) {
  mkdirSync(RESULTS_DIR, { recursive: true });
}

const jsonPath = join(RESULTS_DIR, "reference-emit-collapse.json");
const mdPath = join(RESULTS_DIR, "reference-emit-collapse.md");

writeFileSync(jsonPath, JSON.stringify(result, null, 2) + "\n");
writeFileSync(mdPath, buildDossier(result) + "\n");

if (flags.json) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  process.stdout.write(formatTable(result) + "\n");
  process.stdout.write(`\n[Results written to ${jsonPath}]\n`);
  process.stdout.write(`[Dossier written to ${mdPath}]\n`);
}
