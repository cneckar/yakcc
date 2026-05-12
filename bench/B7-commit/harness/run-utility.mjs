// SPDX-License-Identifier: MIT
//
// bench/B7-commit/harness/run-utility.mjs
//
// @decision DEC-BENCH-B7-001 (partial — subprocess isolation rationale)
// @title B7-commit subprocess entry point: isolated per-utility measurement
// @status accepted (WI-B7-SLICE-3, issue #396; closes #393)
// @rationale
//   SUBPROCESS ISOLATION (Slice 3 — structural fix for #393)
//   Each utility's measurements now run in a dedicated child process. Process exit
//   reclaims all Node.js and ts-morph in-process state unconditionally, so
//   ts-morph Project/SourceFile/type-cache state from utility N cannot contaminate
//   utility N+1. This is the structural fix for the intermittent shave-rejection
//   observed in #393 (parse-cron-expression rejected when run sequentially after
//   slugify-ascii due to accumulated ts-morph state).
//
//   PROCESS BOUNDARY PROPERTIES
//   - All Node.js module caches (require.cache, ESM live-binding tables) are private
//     to each child. ts-morph Projects and SourceFile caches are never shared.
//   - SQLite registry files are opened/closed within each child; no file locks leak
//     between utilities even on Windows.
//   - The air-gap (B6, offline: true) is preserved — no outbound network calls.
//   - atomizeEmission and openRegistry are real implementations, not stubs.
//
//   CLI INTERFACE
//   --utility <name>        : corpus filename without .ts extension
//   --reps <N>              : number of measurement repetitions (default 10)
//   --cache-state <warm|cold> : which phase to run
//   --output-json           : write JSON to stdout (single line, no console interleaving)
//   --corpus-dir <path>     : absolute path to corpus directory
//   --scratch-dir <path>    : absolute path to scratch directory for SQLite files
//   --repo-root <path>      : absolute path to repo root (used to locate dist packages)
//   --intent <text>         : URL-encoded intent string for this utility
//
//   EXIT CODES
//   0  : success — JSON printed to stdout
//   1  : hard error (missing file, bad arg, uncaught exception)
//
// Usage (invoked by run.mjs, not directly by users):
//   node bench/B7-commit/harness/run-utility.mjs \
//     --utility parse-cron-expression \
//     --reps 10 \
//     --cache-state cold \
//     --output-json \
//     --corpus-dir /abs/path/bench/B7-commit/corpus \
//     --scratch-dir /abs/path/tmp/B7-commit/scratch \
//     --repo-root /abs/path \
//     --intent "Parse+a+standard+5-field+cron+expression..."

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    utility:      { type: "string" },
    reps:         { type: "string", default: "10" },
    "cache-state":{ type: "string" },
    "output-json":{ type: "boolean", default: false },
    "corpus-dir": { type: "string" },
    "scratch-dir":{ type: "string" },
    "repo-root":  { type: "string" },
    intent:       { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const UTILITY_NAME  = args["utility"];
const N_REPS        = parseInt(args["reps"] ?? "10", 10);
const CACHE_STATE   = args["cache-state"];
const OUTPUT_JSON   = args["output-json"] ?? false;
const CORPUS_DIR    = args["corpus-dir"];
const SCRATCH_DIR   = args["scratch-dir"];
const REPO_ROOT     = args["repo-root"];
const INTENT_ENCODED = args["intent"];

if (!UTILITY_NAME || !CACHE_STATE || !CORPUS_DIR || !SCRATCH_DIR || !REPO_ROOT || !INTENT_ENCODED) {
  process.stderr.write(
    "[run-utility] Missing required args: --utility, --cache-state, --corpus-dir, --scratch-dir, --repo-root, --intent\n"
  );
  process.exit(1);
}

if (CACHE_STATE !== "warm" && CACHE_STATE !== "cold") {
  process.stderr.write(`[run-utility] --cache-state must be "warm" or "cold", got: ${CACHE_STATE}\n`);
  process.exit(1);
}

if (isNaN(N_REPS) || N_REPS < 1) {
  process.stderr.write(`[run-utility] --reps must be a positive integer, got: ${args["reps"]}\n`);
  process.exit(1);
}

const INTENT = decodeURIComponent(INTENT_ENCODED);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOP_K = 5;
const CONFIDENT_THRESHOLD = 0.70;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pathToImportUrl(fsPath) {
  return pathToFileURL(fsPath).href;
}

function percentile(sorted, p) {
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)];
}

function computeAggregate(values) {
  if (values.length === 0) return { median_ms: null, p95_ms: null, p99_ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  return {
    median_ms: median,
    p95_ms: percentile(sorted, 0.95),
    p99_ms: percentile(sorted, 0.99),
  };
}

// ---------------------------------------------------------------------------
// Core measurement: one (utility × rep) observation
// ---------------------------------------------------------------------------

async function measureOneRep({ emittedCode, intent, registry, atomizeEmission }) {
  const t0_emit = Date.now();

  const atomizeResult = await atomizeEmission({
    emittedCode,
    toolName: "Write",
    registry,
  });

  const t2_atomized = Date.now();

  const atomized = atomizeResult.atomized === true;
  const bmr =
    atomized && atomizeResult.atomsCreated.length > 0
      ? atomizeResult.atomsCreated[0].blockMerkleRoot
      : null;

  const intentQuery = { behavior: intent, inputs: [], outputs: [] };
  const candidates = await registry.findCandidatesByIntent(intentQuery, { k: TOP_K });

  const t3_query_hit = Date.now();

  let bmrInTopK = false;
  let combinedScore = 0;

  if (candidates.length > 0) {
    const returnedBmrs = candidates.map((c) => c.block.blockMerkleRoot);
    bmrInTopK = bmr !== null && returnedBmrs.some((b) => b === bmr);
    const top = candidates[0];
    combinedScore = Math.max(0, Math.min(1, 1 - (top.cosineDistance * top.cosineDistance) / 4));
  }

  const wallMs = t3_query_hit - t0_emit;

  return {
    wallMs,
    t0_emit,
    t2_atomized,
    t3_query_hit,
    atomized,
    bmr: bmr ? bmr.slice(0, 16) : null,
    bmrInTopK,
    combinedScore,
    candidateCount: candidates.length,
    reason: atomized ? undefined : (atomizeResult.reason ?? "unknown"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Ensure scratch dir exists
  mkdirSync(SCRATCH_DIR, { recursive: true });

  // Load dist modules — fresh import per subprocess (key to isolation)
  const registryDist = join(REPO_ROOT, "packages", "registry", "dist", "index.js");
  const hooksBaseAtomizeDist = join(REPO_ROOT, "packages", "hooks-base", "dist", "atomize.js");

  if (!existsSync(registryDist)) {
    process.stderr.write(`[run-utility] @yakcc/registry dist not found at ${registryDist}\n`);
    process.exit(1);
  }
  if (!existsSync(hooksBaseAtomizeDist)) {
    process.stderr.write(`[run-utility] @yakcc/hooks-base atomize dist not found at ${hooksBaseAtomizeDist}\n`);
    process.exit(1);
  }

  const { openRegistry } = await import(pathToImportUrl(registryDist));
  const { atomizeEmission } = await import(pathToImportUrl(hooksBaseAtomizeDist));

  // Read corpus file
  const corpusPath = join(CORPUS_DIR, `${UTILITY_NAME}.ts`);
  if (!existsSync(corpusPath)) {
    process.stderr.write(`[run-utility] Corpus file not found: ${corpusPath}\n`);
    process.exit(1);
  }
  const emittedCode = readFileSync(corpusPath, "utf8");

  const measurements = [];

  if (CACHE_STATE === "warm") {
    // WARM PHASE
    // Rep 1 = seed (cold insert, timed), reps 2-N = warm dedup reps (INSERT OR IGNORE no-op).
    // This matches Slice 2's warm definition exactly.
    const warmRegistryPath = join(SCRATCH_DIR, `warm-${UTILITY_NAME}.sqlite`);
    if (existsSync(warmRegistryPath)) rmSync(warmRegistryPath, { force: true });
    const warmRegistry = await openRegistry(warmRegistryPath);

    let seededBmr = null;

    for (let rep = 1; rep <= N_REPS; rep++) {
      const isSeedRep = rep === 1;
      const obs = await measureOneRep({
        emittedCode,
        intent: INTENT,
        registry: warmRegistry,
        atomizeEmission,
      });

      if (!OUTPUT_JSON) {
        process.stderr.write(
          `  [warm] ${UTILITY_NAME} rep ${rep}/${N_REPS}${isSeedRep ? " [seed]" : ""}: ` +
          `${obs.wallMs}ms atomized=${obs.atomized}\n`
        );
      }

      if (isSeedRep && obs.atomized && obs.bmr) {
        seededBmr = obs.bmr;
      }

      if (!isSeedRep && !obs.atomized && seededBmr !== null && obs.candidateCount > 0) {
        obs.warmDedupRep = true;
        obs.seededBmrAvailable = true;
      }

      measurements.push({
        cacheState: "warm",
        warmSeedRep: isSeedRep,
        utilityName: UTILITY_NAME,
        rep,
        ...obs,
      });
    }

    await warmRegistry.close();

  } else {
    // COLD PHASE
    // Fresh registry per rep — guarantees zero state bleed between reps.
    for (let rep = 1; rep <= N_REPS; rep++) {
      const coldRegistryPath = join(SCRATCH_DIR, `cold-${UTILITY_NAME}-rep${rep}.sqlite`);
      if (existsSync(coldRegistryPath)) rmSync(coldRegistryPath, { force: true });
      const coldRegistry = await openRegistry(coldRegistryPath);

      const obs = await measureOneRep({
        emittedCode,
        intent: INTENT,
        registry: coldRegistry,
        atomizeEmission,
      });

      if (!OUTPUT_JSON) {
        process.stderr.write(
          `  [cold] ${UTILITY_NAME} rep ${rep}/${N_REPS}: ` +
          `${obs.wallMs}ms atomized=${obs.atomized}\n`
        );
      }

      await coldRegistry.close();

      measurements.push({
        cacheState: "cold",
        utilityName: UTILITY_NAME,
        rep,
        ...obs,
      });
    }
  }

  // Build aggregate for this utility + cache state
  const successWallMs = measurements
    .filter((m) => m.cacheState === "warm" ? !m.warmSeedRep : true)
    .map((m) => m.wallMs);

  const aggregate = computeAggregate(successWallMs);

  const result = {
    utilityName: UTILITY_NAME,
    cacheState: CACHE_STATE,
    nReps: N_REPS,
    measurements,
    aggregate,
  };

  if (OUTPUT_JSON) {
    // Single-line JSON to stdout — parent parses this
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stderr.write(`[run-utility] ${UTILITY_NAME} ${CACHE_STATE}: median=${aggregate.median_ms?.toFixed(1)}ms\n`);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[run-utility] Fatal error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
