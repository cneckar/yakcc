#!/usr/bin/env node
// scripts/build-as-cache-seed.mjs — Checked-in wasm seed generator (WI-631 Stage B)
//
// @decision DEC-AS-WASM-SEED-002
// Title: Seed generator lives at scripts/build-as-cache-seed.mjs; invoked manually, not in CI
// Status: accepted
// Rationale:
//   The seed is regenerated out of band, not on every CI run. A CI step that
//   compiles 4119 atoms to refresh the seed defeats the entire point of Stage B
//   (we'd be paying the cost we wanted to amortize). Manual operator invocation
//   matches the existing `yakcc bootstrap` pattern: data files in bootstrap/ are
//   produced by an operator tool, committed, and re-run when the operator chooses
//   (e.g. after an asc version bump in pnpm-lock.yaml).
//
// Usage:
//   node --experimental-strip-types scripts/build-as-cache-seed.mjs [options]
//   pnpm node --experimental-strip-types scripts/build-as-cache-seed.mjs
//
// Options:
//   --help                Print usage and exit
//   --sample N            Process only N atoms (default: all)
//   --max-bytes N         Option B: cap total seed size to N bytes (default: none)
//   --dry-run             Measure only; do not write to bootstrap/as-cache-seed/
//   --out-dir PATH        Override output directory (default: bootstrap/as-cache-seed)
//   --from-cache PATH     Fast Phase 0 path: read atoms from a shave-cache.json file
//                         instead of running the full regenerateCorpus() shave walk.
//                         Use this for quick size measurements. Omit for the full seed.
//
// Fast Phase 0 (measurement only — no shave walk):
//   node scripts/build-as-cache-seed.mjs \
//     --from-cache examples/v1-wave-3-wasm-lower-demo/test/shave-cache.json \
//     --sample 20 --dry-run
//
// Full seed generation (all atoms, requires --experimental-strip-types):
//   node --experimental-strip-types scripts/build-as-cache-seed.mjs
//
// Prerequisites:
//   - pnpm install && pnpm -r build (compile package must be built)
//   - Node.js >=22.6 (for --experimental-strip-types to import corpus-loader.ts)
//
// Output:
//   - Writes <repoRoot>/bootstrap/as-cache-seed/<key[0..3]>/<key>.wasm for each atom
//   - Prints Phase 0 measurements: total atoms, total bytes, min/p50/p95/max shard size
//   - Returns exit code 0 on success, 1 on budget exceeded (>50MB or >1MB per shard)

// ---------------------------------------------------------------------------
// --help fast path — BEFORE any dynamic TypeScript imports.
// This ensures `node scripts/build-as-cache-seed.mjs --help` works without
// the --experimental-strip-types flag. (EC-9)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: node --experimental-strip-types scripts/build-as-cache-seed.mjs [options]
       pnpm node --experimental-strip-types scripts/build-as-cache-seed.mjs [options]

Options:
  --help              Print this message and exit
  --sample N          Process only N atoms (Phase 0 measurement; default: all)
  --max-bytes N       Option B: cap total seed size to N bytes (overrides auto-tier)
  --dry-run           Measure only; do not copy to bootstrap/as-cache-seed/
  --out-dir PATH      Override output directory (default: bootstrap/as-cache-seed)
  --from-cache PATH   Fast path: read atoms from shave-cache.json (no shave walk)
  --inline-sample     Fastest Phase 0: compile 10 hardcoded representative atoms

Examples:
  # Phase 0: fastest measurement (no --experimental-strip-types, <5 seconds)
  node scripts/build-as-cache-seed.mjs --inline-sample --dry-run

  # Phase 0: measure from shave cache (no --experimental-strip-types needed)
  node scripts/build-as-cache-seed.mjs \\
    --from-cache examples/v1-wave-3-wasm-lower-demo/test/shave-cache.json \\
    --sample 20 --dry-run

  # Full Option A seed (all atoms; requires experimental flag; ~60 min cold)
  node --experimental-strip-types scripts/build-as-cache-seed.mjs

  # Option B: cap at 20 MB
  node --experimental-strip-types scripts/build-as-cache-seed.mjs --max-bytes 20971520

Prerequisites:
  pnpm install && pnpm -r build
`.trim());
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------

function parseFlag(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

const SAMPLE_N = parseFlag("--sample") !== null ? parseInt(parseFlag("--sample"), 10) : null;
const MAX_BYTES = parseFlag("--max-bytes") !== null ? parseInt(parseFlag("--max-bytes"), 10) : null;
const DRY_RUN = args.includes("--dry-run");
const OUT_DIR_OVERRIDE = parseFlag("--out-dir");
const FROM_CACHE_PATH = parseFlag("--from-cache");
// --inline-sample: compile a small set of hardcoded atoms for rapid Phase 0 measurement.
// No shave walk, no corpus-loader. Returns immediately with size statistics.
// These atoms are representative real-world AS patterns (same flags, same pipeline).
const INLINE_SAMPLE = args.includes("--inline-sample");

// ---------------------------------------------------------------------------
// Static imports — node:* builtins only; no TypeScript required.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// Resolve key directories
const STAGING_DIR = join(REPO_ROOT, "tmp", "wi-631-stage-b", "staging-cache");
const OUT_DIR = OUT_DIR_OVERRIDE
  ? resolve(OUT_DIR_OVERRIDE)
  : join(REPO_ROOT, "bootstrap", "as-cache-seed");

// ---------------------------------------------------------------------------
// Import compiled packages (from dist — no TypeScript flag needed for these)
// ---------------------------------------------------------------------------

const { assemblyScriptBackend } = await import(
  join(REPO_ROOT, "packages", "compile", "dist", "as-backend.js")
);
const { cachedAsEmit, deriveCacheKey, ASC_VERSION } = await import(
  join(REPO_ROOT, "packages", "compile", "dist", "as-compile-cache.js")
);
const { blockMerkleRoot, specHash } = await import(
  join(REPO_ROOT, "packages", "contracts", "dist", "index.js")
);

// ---------------------------------------------------------------------------
// Helpers — mirror makeSingleBlockResolution from closer-parity-as.test.ts
// (Sacred Practice #12: same logic, no code shared because this is a script)
// ---------------------------------------------------------------------------

function makeSpecYak(name, behavior) {
  return {
    name,
    inputs: [{ name: "a", type: "number" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  };
}

const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

function makeMerkleRoot(name, behavior, implSource) {
  const spec = makeSpecYak(name, behavior);
  const manifest = JSON.parse(MINIMAL_MANIFEST_JSON);
  const artifactBytes = new TextEncoder().encode(implSource);
  const artifactsMap = new Map();
  for (const art of manifest.artifacts) {
    artifactsMap.set(art.path, artifactBytes);
  }
  return blockMerkleRoot({ spec, implSource, manifest, artifacts: artifactsMap });
}

function makeResolution(blocks) {
  const blockMap = new Map();
  const order = [];
  for (const { id, source } of blocks) {
    const sh = specHash(makeSpecYak(id.slice(0, 8), `behavior-${id.slice(0, 8)}`));
    blockMap.set(id, { merkleRoot: id, specHash: sh, source, subBlocks: [] });
    order.push(id);
  }
  const entry = order[order.length - 1];
  return { entry, blocks: blockMap, order };
}

function makeSingleBlockResolution(fnSource) {
  const fnName = fnSource.match(/export\s+function\s+(\w+)/)?.[1] ?? "fn";
  const id = makeMerkleRoot(fnName, `${fnName} substrate`, fnSource);
  return makeResolution([{ id, source: fnSource }]);
}

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ---------------------------------------------------------------------------
// Directory size helper
// ---------------------------------------------------------------------------

function dirSizeBytes(dirPath) {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  function walk(p) {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  }
  walk(dirPath);
  return total;
}

// ---------------------------------------------------------------------------
// Fast corpus path: read atoms directly from shave-cache.json.
//
// @decision DEC-AS-WASM-SEED-004
// @title Fast Phase 0 reads atoms from shave-cache.json (--from-cache flag)
// @status accepted
// @rationale
//   The full regenerateCorpus() shave walk calls shave() on every uncached
//   TypeScript file via ts-morph. With 681+ cold files, this takes 50+ minutes.
//   For Phase 0 size measurement (which only needs representative atom sources),
//   reading from the committed shave-cache.json is a valid fast path:
//   - The shave-cache contains real production atoms (same implSource values
//     as what regenerateCorpus() would produce for cached files).
//   - Phase 0 only needs size samples, not the full corpus.
//   - Full seed generation still uses regenerateCorpus() (the slow path) to
//     ensure all current atoms are included in the seed.
//   This avoids the 50+ minute wait for Phase 0 measurement runs.
// ---------------------------------------------------------------------------

function atomsFromCache(cacheFilePath) {
  const raw = JSON.parse(readFileSync(cacheFilePath, "utf-8"));
  const atoms = new Map();
  const entries = raw.entries ?? {};
  for (const [, cacheEntries] of Object.entries(entries)) {
    for (const entry of cacheEntries) {
      if (entry.implSource && entry.blockMerkleRoot) {
        atoms.set(entry.blockMerkleRoot, {
          implSource: entry.implSource,
          atomHash: entry.blockMerkleRoot,
        });
      }
    }
  }
  return atoms;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Suppress unhandled rejection noise from as-compile-cache.ts's inFlight promise
// when asc compilation fails. The compilePromise stored in inFlight is rejected
// (via rejectBytes) before the outer cachedAsEmit throw reaches our try/catch,
// causing Node.js to report an unhandled rejection for the inFlight entry.
// We catch compile errors explicitly in the loop; suppress the noise here.
// See: packages/compile/src/as-compile-cache.ts cachedAsEmit() catch block.
process.on("unhandledRejection", (reason) => {
  // Only suppress asc compile errors (which we handle explicitly in the loop).
  // Rethrow anything else.
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes("asc compilation failed") || msg.includes("compile error")) return;
  throw reason;
});

console.log(`[seed-gen] build-as-cache-seed.mjs starting`);
console.log(`[seed-gen] asc version: ${ASC_VERSION}`);
console.log(`[seed-gen] repo root:   ${REPO_ROOT}`);
console.log(`[seed-gen] staging dir: ${STAGING_DIR}`);
console.log(`[seed-gen] output dir:  ${OUT_DIR}`);
if (SAMPLE_N !== null) console.log(`[seed-gen] sample mode: N=${SAMPLE_N}`);
if (MAX_BYTES !== null) console.log(`[seed-gen] max-bytes cap: ${MAX_BYTES}`);
if (DRY_RUN) console.log(`[seed-gen] dry-run: no files will be written to output dir`);
if (FROM_CACHE_PATH) console.log(`[seed-gen] fast path: reading atoms from ${FROM_CACHE_PATH}`);
if (INLINE_SAMPLE) console.log(`[seed-gen] inline-sample: using hardcoded representative atoms`);

// Step 1: build atom list
const startMs = Date.now();
process.env.YAKCC_AS_CACHE_DIR = STAGING_DIR;
mkdirSync(STAGING_DIR, { recursive: true });

let atomEntries;

if (INLINE_SAMPLE) {
  // Fastest Phase 0 path: compile a set of representative hardcoded atoms.
  //
  // @decision DEC-AS-WASM-SEED-004 (inline variant)
  // These are real AssemblyScript patterns that represent the range of atom
  // shapes in the production corpus: simple i32 ops, string ops, conditionals,
  // arithmetic with f64. They exercise the same asc pipeline with the same
  // CANONICAL_ASC_FLAGS as production. The sizes are representative of the
  // 200-2000 byte range documented in the plan.
  //
  // Source: actual atom patterns from packages/compile/src/as-compile-cache.test.ts
  // and from the AS-backend parity corpus (wave-3 atoms confirmed compilable).
  console.log(`\n[seed-gen] Step 1: using inline representative atom set...`);
  const INLINE_ATOMS = [
    // Minimal arithmetic — smallest possible valid atom
    "export function add(a: i32, b: i32): i32 { return a + b; }",
    // Identity function
    "export function id(x: i32): i32 { return x; }",
    // Floating point
    "export function scale(x: f64, factor: f64): f64 { return x * factor; }",
    // Conditional
    "export function clamp(x: f64, lo: f64, hi: f64): f64 { if (x < lo) return lo; if (x > hi) return hi; return x; }",
    // Boolean logic
    "export function isPositive(x: f64): bool { return x > 0.0; }",
    // String length (string atoms are the heaviest — tests the upper bound)
    "export function strLen(s: string): i32 { return s.length; }",
    // Multi-return, more complex
    "export function divmod(a: i32, b: i32): i32 { const q = a / b; const r = a - q * b; return r; }",
    // Loop
    "export function sumN(n: i32): i32 { let s: i32 = 0; for (let i: i32 = 0; i < n; i++) s += i; return s; }",
    // Nested condition
    "export function abs(x: f64): f64 { return x < 0.0 ? -x : x; }",
    // Comparison
    "export function max(a: i32, b: i32): i32 { return a > b ? a : b; }",
  ];
  atomEntries = INLINE_ATOMS.map((src, i) => {
    const id = createHash("sha256").update(`inline-atom-${i}:${src}`).digest("hex");
    return [id, { implSource: src, atomHash: id }];
  });
  console.log(`[seed-gen] inline atoms: ${atomEntries.length}`);
} else if (FROM_CACHE_PATH) {
  // Fast path: read atoms from shave-cache.json (no shave walk)
  console.log(`\n[seed-gen] Step 1: loading atoms from cache file...`);
  const resolvedCachePath = resolve(FROM_CACHE_PATH);
  if (!existsSync(resolvedCachePath)) {
    console.error(`[seed-gen] ERROR: --from-cache file not found: ${resolvedCachePath}`);
    process.exit(1);
  }
  const cacheAtoms = atomsFromCache(resolvedCachePath);
  atomEntries = [...cacheAtoms.entries()].map(([atomHash, atom]) => [atomHash, atom]);
  console.log(`[seed-gen] loaded ${atomEntries.length} atoms from shave-cache`);
} else {
  // Full path: regenerate corpus via shave walk (slow — needed for full seed)
  console.log(`\n[seed-gen] Step 1: regenerating corpus (full shave walk)...`);
  console.log(`[seed-gen] NOTE: this may take 30-60 minutes on a cold shave-cache.`);
  console.log(`[seed-gen]       For Phase 0 measurement only, use --from-cache instead.`);

  const { regenerateCorpus } = await import(
    join(REPO_ROOT, "examples", "v1-wave-3-wasm-lower-demo", "test", "corpus-loader.ts")
  );

  const corpus = await regenerateCorpus();
  console.log(`[seed-gen] corpus: ${corpus.size} unique atoms from ${corpus.filesWalked} files`);
  if (corpus.shaveFailures > 0) {
    console.warn(`[seed-gen] WARNING: ${corpus.shaveFailures} shave failures`);
  }
  atomEntries = [...corpus.atoms.entries()];
}

// Step 2: select atoms
if (SAMPLE_N !== null) {
  atomEntries = atomEntries.slice(0, SAMPLE_N);
  console.log(`[seed-gen] sample mode: processing first ${atomEntries.length} atoms`);
}

// Step 3: compile each atom via cachedAsEmit (serial for determinism)
const backend = assemblyScriptBackend();
let hits = 0;
let misses = 0;
let errors = 0;
const shardSizes = [];
let totalBytes = 0;
let maxShard = 0;

console.log(`\n[seed-gen] Step 2: compiling ${atomEntries.length} atoms...`);

for (let i = 0; i < atomEntries.length; i++) {
  const [atomHash, atom] = atomEntries[i];
  if ((i + 1) % 10 === 0 || i === atomEntries.length - 1) {
    process.stdout.write(
      `\r[seed-gen]   ${i + 1}/${atomEntries.length} (hits=${hits} misses=${misses} errors=${errors})`
    );
  }
  try {
    const resolution = makeSingleBlockResolution(atom.implSource);
    const { cacheStatus } = await cachedAsEmit(backend, resolution, atomHash, {
      cacheDir: STAGING_DIR,
    });
    if (cacheStatus === "hit") hits++;
    else misses++;

    // Measure the shard file
    const key = deriveCacheKey(atomHash);
    const shardPath = join(STAGING_DIR, key.slice(0, 3), `${key}.wasm`);
    if (existsSync(shardPath)) {
      const sz = statSync(shardPath).size;
      shardSizes.push(sz);
      totalBytes += sz;
      if (sz > maxShard) maxShard = sz;

      // Check per-shard hard limit (>1MB = STOP)
      if (sz > 1_048_576) {
        console.error(
          `\n[seed-gen] BLOCKED: shard ${shardPath} is ${sz} bytes (>1MB hard limit)`
        );
        console.error(`[seed-gen] PLAN_VERDICT: blocked_by_plan`);
        process.exit(1);
      }
    }

    // Check max-bytes cap (Option B)
    if (MAX_BYTES !== null && totalBytes > MAX_BYTES) {
      console.log(`\n[seed-gen] max-bytes cap reached at atom ${i + 1}/${atomEntries.length}`);
      atomEntries = atomEntries.slice(0, i + 1);
      break;
    }
  } catch (err) {
    errors++;
    // Compile error is expected for some atoms — skip silently (mirrors test behavior)
  }
}
process.stdout.write("\n");

const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);

// ---------------------------------------------------------------------------
// Phase 0 measurement output
// ---------------------------------------------------------------------------

const sorted = [...shardSizes].sort((a, b) => a - b);
const p50 = percentile(sorted, 50);
const p95 = percentile(sorted, 95);
const minShard = sorted[0] ?? 0;
const totalMB = (totalBytes / (1024 * 1024)).toFixed(3);

console.log(`\n[seed-gen] ===== Phase 0 measurements =====`);
console.log(`[seed-gen] atoms processed:   ${atomEntries.length}`);
console.log(`[seed-gen] compile hits:       ${hits}`);
console.log(`[seed-gen] compile misses:     ${misses}`);
console.log(`[seed-gen] compile errors:     ${errors}`);
console.log(`[seed-gen] shards on disk:     ${shardSizes.length}`);
console.log(`[seed-gen] shard sizes (bytes):`);
console.log(`[seed-gen]   min:              ${minShard}`);
console.log(`[seed-gen]   p50:              ${p50}`);
console.log(`[seed-gen]   p95:              ${p95}`);
console.log(`[seed-gen]   max:              ${maxShard}`);
console.log(`[seed-gen] total seed size:    ${totalBytes} bytes (${totalMB} MB)`);
console.log(`[seed-gen] asc version:        ${ASC_VERSION}`);
console.log(`[seed-gen] elapsed:            ${elapsedSec}s`);

// Budget tier decision
const BUDGET_20MB = 20_971_520;
const BUDGET_50MB = 52_428_800;

if (totalBytes > BUDGET_50MB) {
  console.error(`[seed-gen] BLOCKED: total size ${totalBytes} bytes > 50MB hard ceiling`);
  console.error(`[seed-gen] PLAN_VERDICT: blocked_by_plan`);
  process.exit(1);
}

if (totalBytes > BUDGET_20MB) {
  console.warn(`[seed-gen] WARNING: total ${totalMB}MB > 20MB — Option B (--max-bytes) recommended`);
} else if (totalBytes > 5_242_880) {
  console.log(`[seed-gen] Budget tier: 5-20MB — Option A with .gitattributes binary marker`);
} else {
  console.log(`[seed-gen] Budget tier: <=5MB — Option A (full seed)`);
}

// ---------------------------------------------------------------------------
// Copy staging → output (unless dry-run)
// ---------------------------------------------------------------------------

if (DRY_RUN) {
  console.log(`\n[seed-gen] Dry-run: skipping copy to ${OUT_DIR}`);
  console.log(`[seed-gen] Done.`);
  process.exit(0);
}

console.log(`\n[seed-gen] Step 3: copying staging → ${OUT_DIR}`);
mkdirSync(OUT_DIR, { recursive: true });

// cpSync with recursive + force (we own the output directory)
cpSync(STAGING_DIR, OUT_DIR, { recursive: true });

const finalSize = dirSizeBytes(OUT_DIR);
const finalMB = (finalSize / (1024 * 1024)).toFixed(3);
console.log(`[seed-gen] Output directory: ${finalSize} bytes (${finalMB} MB)`);

// Count shards
const wasmCount = execSync(
  `find "${OUT_DIR}" -name "*.wasm" | wc -l`,
  { encoding: "utf8" }
).trim();
console.log(`[seed-gen] Wasm shards written: ${wasmCount}`);
console.log(`\n[seed-gen] Done. Seed ready at: ${OUT_DIR}`);
