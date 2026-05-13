// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/harness/measure-axis3.mjs
//
// Axis 3 — In-shape byte-equivalence measurement.
// Both arms must produce byte-identical output on every valid input in the
// in-shape corpus. A failure here means the atomic decomposition is too
// restrictive (or Arm B doesn't match the spec). 100% equivalence = PASS.
//
// CORPUS GENERATION:
// Uses fast-check's integer() and array() arbitraries to generate the in-shape
// grammar: `[i1,i2,...,iN]` where each element is a non-negative integer.
// We use a fixed seed for reproducibility (seed=42, same across runs).
// The corpus is generated fresh each run (fast-check is fast).
//
// EQUIVALENCE DEFINITION:
// For each valid input, call both Arm A and Arm B's entry function.
// Serialize both outputs via JSON.stringify (stable for ReadonlyArray<number>).
// Compare byte-by-byte. Any difference = NOT equivalent.
//
// Cross-references:
//   DEC-V0-MIN-SURFACE-001 (REFUSED-EARLY) — harness/measure-axis2.mjs
//   DEC-V0-MIN-SURFACE-002 (reachability) — harness/measure-axis1.mjs
//   DEC-V0-MIN-SURFACE-003 (Arm B prompt) — harness/llm-baseline.mjs
//   DEC-BENCH-B9-SLICE1-001 (verdict) — harness/run.mjs
//
// Usage (standalone):
//   node bench/B9-min-surface/harness/measure-axis3.mjs \
//     --emit-a <path-to-arm-a-mjs> \
//     --emit-b <path-to-arm-b-mjs> \
//     [--entry <funcName>] \
//     [--count <n>] \
//     [--seed <n>] \
//     [--json]
//
// Output: JSON {
//   total: N, equivalent: N, divergent: N, equivalence_rate: 100.0,
//   divergent_cases: [...],
//   pass: true
// }

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B9_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "emit-a": { type: "string" },
    "emit-b": { type: "string" },
    entry: { type: "string", default: "listOfInts" },
    count: { type: "string", default: "25" },
    seed: { type: "string", default: "42" },
    json: { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: false,
});

const EMIT_A_PATH = cliArgs["emit-a"];
const EMIT_B_PATH = cliArgs["emit-b"];
const ENTRY_FUNCTION = cliArgs["entry"] ?? "listOfInts";
const CORPUS_COUNT = parseInt(cliArgs["count"] ?? "25", 10);
const SEED = parseInt(cliArgs["seed"] ?? "42", 10);
const JSON_ONLY = cliArgs["json"] === true;

if (!EMIT_A_PATH || !EMIT_B_PATH) {
  console.error(
    "Usage: node measure-axis3.mjs --emit-a <path> --emit-b <path> [--entry <funcName>] [--count <n>] [--seed <n>] [--json]"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// fast-check lazy loader
// ---------------------------------------------------------------------------

async function loadFastCheck() {
  const localPath = resolve(BENCH_B9_ROOT, "node_modules", "fast-check", "lib", "esm", "fast-check-default.js");
  if (existsSync(localPath)) {
    const mod = await import(pathToFileURL(localPath).href);
    return mod.default ?? mod;
  }
  const workspacePaths = [
    resolve(BENCH_B9_ROOT, "..", "..", "node_modules", "fast-check", "lib", "esm", "fast-check-default.js"),
  ];
  for (const p of workspacePaths) {
    if (existsSync(p)) {
      const mod = await import(pathToFileURL(p).href);
      return mod.default ?? mod;
    }
  }
  try {
    const mod = await import("fast-check");
    return mod.default ?? mod;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fallback deterministic corpus when fast-check is unavailable
// Generates 25+ valid in-shape inputs using a simple LCG.
// ---------------------------------------------------------------------------

function generateFallbackCorpus(seed, count) {
  const corpus = [];
  let rng = seed;

  function nextInt(max) {
    rng = (rng * 1664525 + 1013904223) & 0x7fffffff;
    return rng % max;
  }

  // Fixed cases first
  corpus.push("[]");
  corpus.push("[0]");
  corpus.push("[1]");
  corpus.push("[1,2,3]");
  corpus.push("[ 42 ]");
  corpus.push("[0,0,0]");
  corpus.push("[10,200,3000]");

  // Generated cases
  while (corpus.length < count) {
    const len = nextInt(8); // 0..7 elements
    if (len === 0) {
      corpus.push("[]");
      continue;
    }
    const elems = [];
    for (let i = 0; i < len; i++) {
      elems.push(String(nextInt(10000)));
    }
    corpus.push("[" + elems.join(",") + "]");
  }

  return corpus;
}

// ---------------------------------------------------------------------------
// Generate in-shape corpus via fast-check
// Grammar: "[" (ws? integer ws? ("," ws? integer ws?)*)? "]"
// where integer = non-negative decimal integer.
// ---------------------------------------------------------------------------

async function generateCorpus(fc, count, seed) {
  if (!fc) {
    return generateFallbackCorpus(seed, count);
  }

  const intArb = fc.nat({ max: 999999 });
  const wsArb = fc.stringOf(
    fc.constantFrom(" ", "\t", ""),
    { minLength: 0, maxLength: 2 }
  );

  // Generate a list of non-negative integers and format as the spec's grammar
  const listArb = fc.array(fc.tuple(wsArb, intArb, wsArb), {
    minLength: 0,
    maxLength: 8,
  }).map((elems) => {
    if (elems.length === 0) return "[]";
    const inner = elems.map(([wsBefore, n, wsAfter]) => `${wsBefore}${n}${wsAfter}`).join(",");
    return "[" + inner + "]";
  });

  const samples = fc.sample(listArb, {
    numRuns: count,
    seed,
    path: "",
  });

  // Ensure we have the minimum required distinct cases
  const corpus = new Set(samples);
  // Add fixed baseline cases
  corpus.add("[]");
  corpus.add("[0]");
  corpus.add("[1]");
  corpus.add("[1,2,3]");
  corpus.add("[ 42 ]");
  corpus.add("[0,0,0]");
  corpus.add("[10,200,3000]");
  corpus.add("[99999,0,1,2,3,4,5,6,7,8,9]");
  corpus.add("[   1   ,   2   ,   3   ]");
  corpus.add("[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19]");

  return [...corpus].slice(0, Math.max(count, 20));
}

// ---------------------------------------------------------------------------
// Load emit function
// ---------------------------------------------------------------------------

async function loadEmitFn(emitPath, entryFuncName) {
  let loadPath = emitPath;
  if (emitPath.endsWith(".ts")) {
    const mjsPath = emitPath.replace(/\.ts$/, ".mjs");
    const jsPath = emitPath.replace(/\.ts$/, ".js");
    if (existsSync(mjsPath)) loadPath = mjsPath;
    else if (existsSync(jsPath)) loadPath = jsPath;
    else throw new Error(`No .mjs/.js transpilation found for ${emitPath}`);
  }

  const mod = await import(pathToFileURL(loadPath).href);
  const fn = mod[entryFuncName] ?? mod.default?.[entryFuncName];

  if (typeof fn !== "function") {
    throw new Error(
      `Entry function '${entryFuncName}' not found in ${loadPath}. ` +
      `Available: ${Object.keys(mod).join(", ")}`
    );
  }
  return fn;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function measureAxis3({ emitAPath, emitBPath, entryFuncName, count, seed } = {}) {
  const _emitAPath = emitAPath ?? resolve(EMIT_A_PATH);
  const _emitBPath = emitBPath ?? resolve(EMIT_B_PATH);
  const _entryFuncName = entryFuncName ?? ENTRY_FUNCTION;
  const _count = count ?? CORPUS_COUNT;
  const _seed = seed ?? SEED;

  const [fnA, fnB, fc] = await Promise.all([
    loadEmitFn(_emitAPath, _entryFuncName),
    loadEmitFn(_emitBPath, _entryFuncName),
    loadFastCheck(),
  ]);

  const corpus = await generateCorpus(fc, _count, _seed);

  const divergentCases = [];
  let equivalent = 0;
  let divergent = 0;
  let errorCases = 0;

  for (const input of corpus) {
    let resultA, resultB, errorA = null, errorB = null;

    try {
      resultA = fnA(input);
    } catch (err) {
      errorA = { type: err.constructor?.name ?? "Error", message: err.message?.slice(0, 200) };
    }

    try {
      resultB = fnB(input);
    } catch (err) {
      errorB = { type: err.constructor?.name ?? "Error", message: err.message?.slice(0, 200) };
    }

    // If both throw, check same error type
    if (errorA && errorB) {
      // Both threw — check if same error type (equivalent behavior on this input)
      if (errorA.type === errorB.type) {
        equivalent++;
      } else {
        divergent++;
        divergentCases.push({
          input: input.slice(0, 100),
          arm_a: { threw: true, error: errorA },
          arm_b: { threw: true, error: errorB },
          reason: "both-threw-different-error-types",
        });
      }
      continue;
    }

    // If one throws and the other doesn't — divergent
    if (errorA && !errorB) {
      divergent++;
      divergentCases.push({
        input: input.slice(0, 100),
        arm_a: { threw: true, error: errorA },
        arm_b: { threw: false, result: JSON.stringify(resultB) },
        reason: "arm-a-threw-arm-b-returned",
      });
      continue;
    }

    if (!errorA && errorB) {
      divergent++;
      divergentCases.push({
        input: input.slice(0, 100),
        arm_a: { threw: false, result: JSON.stringify(resultA) },
        arm_b: { threw: true, error: errorB },
        reason: "arm-b-threw-arm-a-returned",
      });
      continue;
    }

    // Both returned — compare serialized output
    const serialA = JSON.stringify(resultA);
    const serialB = JSON.stringify(resultB);

    if (serialA === serialB) {
      equivalent++;
    } else {
      divergent++;
      divergentCases.push({
        input: input.slice(0, 100),
        arm_a: { threw: false, result: serialA },
        arm_b: { threw: false, result: serialB },
        reason: "output-mismatch",
      });
    }
  }

  const total = corpus.length;
  const equivalenceRate = total > 0 ? (equivalent / total) * 100 : 0;

  return {
    total,
    equivalent,
    divergent,
    error_cases: errorCases,
    equivalence_rate: equivalenceRate,
    corpus_size_ok: total >= 20,
    pass: equivalenceRate === 100 && total >= 20,
    pass_bar: { equivalence_pct: 100, min_corpus_size: 20 },
    divergent_cases: divergentCases,
    seed: _seed,
    fast_check_available: fc !== null,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const result = await measureAxis3();

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result;
  }

  console.log("=== Axis 3: In-Shape Byte-Equivalence ===");
  console.log(`  emit-a: ${EMIT_A_PATH}`);
  console.log(`  emit-b: ${EMIT_B_PATH}`);
  console.log(`  corpus: ${result.total} inputs (seed=${result.seed})`);
  console.log(`  fast-check: ${result.fast_check_available ? "available" : "fallback generator"}`);
  console.log();
  console.log(`  equivalent: ${result.equivalent}/${result.total} (${result.equivalence_rate.toFixed(1)}%)`);
  console.log(`  divergent:  ${result.divergent}/${result.total}`);

  if (result.divergent_cases.length > 0) {
    console.log(`  DIVERGENT CASES:`);
    for (const dc of result.divergent_cases) {
      console.log(`    input: ${dc.input}`);
      console.log(`    arm-a: ${JSON.stringify(dc.arm_a)}`);
      console.log(`    arm-b: ${JSON.stringify(dc.arm_b)}`);
      console.log(`    reason: ${dc.reason}`);
    }
  }

  console.log();
  console.log(`  RESULT: ${result.pass ? "PASS" : "FAIL"}`);
  console.log(`    equivalence_rate ${result.equivalence_rate.toFixed(1)}% (bar: 100%)`);
  console.log(`    corpus_size ${result.total} (bar: ≥20)`);
  console.log();

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result;
}

// Export for use by run.mjs
export { measureAxis3 };

// Run standalone if executed directly
const isMain = process.argv[1] &&
  (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
   process.argv[1].endsWith("measure-axis3.mjs"));
if (isMain) {
  main().catch((err) => {
    console.error("[axis3] Fatal:", err.message);
    process.exit(1);
  });
}
