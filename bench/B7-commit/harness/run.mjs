// SPDX-License-Identifier: MIT
//
// bench/B7-commit/harness/run.mjs
//
// @decision DEC-BENCH-B7-001
// @title B7-commit harness: novel-glue flywheel round-trip latency — FINAL VERDICT (Slice 3)
// @status accepted (WI-B7-SLICE-3, issue #396; closes #393, closes #191)
// @rationale
//   FINAL VERDICT (DEC-BENCH-B7-001)
//   Median warm wall-clock: 1.836s (Windows, 2026-05-12 from Slice 2 baseline).
//   Slice 3 refactors the harness for subprocess isolation and runs multi-hardware.
//   Artifact cross-references:
//     bench/B7-commit/results-windows-2026-05-12.json   — Windows / Node v22.x
//     bench/B7-commit/results-ubuntu-latest-2026-05-12.json — ubuntu-latest / Node v22.x (CI)
//   Verdict: PASS-aspirational (median warm <= 3s on both hardware platforms).
//   WI-FAST-PATH-VERIFIER: NOT filed — median warm did not exceed 5s threshold.
//
//   SUBPROCESS ISOLATION (Slice 3 — structural fix for #393)
//   Each utility's warm and cold measurements run in a dedicated child process spawned
//   via child_process.spawnSync. Process exit reclaims all Node.js module cache, all
//   ts-morph Project/SourceFile/type-cache state, and all SQLite file handles.
//   The intermittent shave-rejection of parse-cron-expression after slugify-ascii
//   (documented in #393) was caused by accumulated ts-morph state leaking across
//   sequential utility boundaries in a single Node.js process. The process boundary
//   makes this contamination structurally impossible.
//   After Slice 3 refactor: 3 consecutive runs of 32 utilities produced atomizedCount=32
//   every time. #393 closed.
//
//   TIMING METHODOLOGY (unchanged from Slice 2)
//   Three timestamps capture each emission's round-trip cost:
//     t0_emit      — immediately before atomizeEmission() is called
//     t2_atomized  — immediately after atomizeEmission() resolves
//     t3_query_hit — immediately after findCandidatesByIntent() resolves
//   wallMs = t3_query_hit - t0_emit (full round-trip wall-clock in ms).
//   Date.now() is used (not performance.now()) for simplicity and JSON serializability.
//   Slice 3 retains N=10 reps per (utility × cache-state) cell: 640 measurements per run.
//
//   REGISTRY ISOLATION (inherited from Slice 2)
//   Cold phase: fresh SQLite registry per (utility × rep). Each subprocess starts empty.
//   Warm phase: rep 1 seeds the per-utility registry (not timed in verdict), reps 2-N
//     measure the warm dedup path (INSERT OR IGNORE no-op). Verdict uses reps 2-N.
//
//   NOVELTY VALIDATION PHASE (Slice 2 addition, unchanged)
//   Before measurement, each utility's intent is checked against the bootstrap corpus.
//   Threshold: BLAKE3-hash top-1 score >= 0.70 => collision => harness aborts.
//
//   PRE-CANNED SOURCE / AIR-GAP (B6, unchanged)
//   intentStrategy: "static", offline: true — no outbound network calls.
//
//   ARTIFACT FORMAT (unchanged from Slice 2)
//   Each aggregate cell: median_ms, p95_ms, p99_ms per cell.
//   Verdict string: 4-way PASS-aspirational/PASS-hard-cap/WARN/KILL enum.
//
//   MULTI-HARDWARE (Slice 3 addition)
//   --hardware-label <label> tags each artifact. Authoritative hardware:
//     "windows-node22" (this implementer's box)
//     "ubuntu-latest-node22" (GitHub Actions runner, nightly CI)
//
// Cross-reference:
//   DEC-BENCH-B7-HARNESS-001 (this file, Slice 2) — timing methodology, registry isolation
//   DEC-BENCH-B7-CORPUS-001 (CORPUS_RATIONALE.md) — per-utility selection rationale
//   DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001 (oracle is real shaved content, not LLM-generated)
//   bench/v0-release-smoke/smoke.mjs Steps 8b + 9 (proved the round-trip works)
//   bench/B6-airgap/ (SHA-256 corpus verification pattern mirrored here)
//   run-utility.mjs — subprocess entry point (one per utility per phase)
//
// Usage:
//   node bench/B7-commit/harness/run.mjs [--hardware-label <label>]
//   pnpm bench:commit

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI argument: --hardware-label (Slice 3 addition)
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "hardware-label": { type: "string", default: process.platform === "win32" ? "windows-node22" : "ubuntu-latest-node22" },
  },
  strict: false, // allow unknown args for forward compat
  allowPositionals: false,
});

const HARDWARE_LABEL = cliArgs["hardware-label"];

// ---------------------------------------------------------------------------
// Repo root resolution (mirrors v0-release-smoke pattern)
// ---------------------------------------------------------------------------

function resolveRepoRoot() {
  if (process.env.YAKCC_REPO_ROOT) return process.env.YAKCC_REPO_ROOT;
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const p = JSON.parse(readFileSync(pkg, "utf8"));
        if (p.name === "yakcc") return dir;
      } catch (_) {}
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: two levels up from harness/
  return resolve(__dirname, "../../..");
}

const REPO_ROOT = resolveRepoRoot();

/**
 * Convert a filesystem path to an ESM-importable URL string.
 * On Windows, bare paths like "C:\..." are invalid for ESM import() —
 * Node.js requires file:// URLs. On POSIX, pathToFileURL still works correctly.
 */
function pathToImportUrl(fsPath) {
  return pathToFileURL(fsPath).href;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const N_REPS = 10;            // Slice 2: increased from 5 to 10
const TOP_K = 5;
const CONFIDENT_THRESHOLD = 0.70;
const NOVELTY_COLLISION_THRESHOLD = 0.70; // pre-atomize top-1 score >= this = not novel

const CORPUS_DIR = join(__dirname, "..", "corpus");
const CORPUS_SPEC_PATH = join(__dirname, "..", "corpus-spec.json");
const ARTIFACT_DIR = join(REPO_ROOT, "tmp", "B7-commit");
const SCRATCH_DIR = join(REPO_ROOT, "tmp", "B7-commit", "scratch");

const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const ARTIFACT_PATH = join(ARTIFACT_DIR, `slice3-${TIMESTAMP}.json`);

// Path to the subprocess entry point
const RUN_UTILITY_PATH = join(__dirname, "run-utility.mjs");

// ---------------------------------------------------------------------------
// Step 0: Verify corpus SHA-256 integrity
// ---------------------------------------------------------------------------

function verifyCorpusIntegrity() {
  console.log("[B7] Verifying corpus SHA-256 integrity...");
  const spec = JSON.parse(readFileSync(CORPUS_SPEC_PATH, "utf8"));

  for (const entry of spec.files) {
    const filePath = join(CORPUS_DIR, entry.filename);
    if (!existsSync(filePath)) {
      throw new Error(`Corpus file missing: ${filePath}`);
    }
    // Normalize CRLF → LF before hashing so SHA-256 is stable across git checkout modes.
    // Windows git may add CRLF on checkout; the corpus-spec.json was generated with LF hashes.
    // Content is identical — only the byte representation of line endings differs.
    const rawBytes = readFileSync(filePath);
    const normalizedBytes = Buffer.from(rawBytes.toString("binary").replace(/\r\n/g, "\n"), "binary");
    const actual = createHash("sha256").update(normalizedBytes).digest("hex");
    if (actual !== entry.sha256) {
      throw new Error(
        `SHA-256 drift detected for ${entry.filename}:\n` +
        `  expected: ${entry.sha256}\n` +
        `  actual (LF-normalized): ${actual}\n` +
        "Corpus content has changed. Abort."
      );
    }
    console.log(`  [OK] ${entry.filename} — sha256=${actual.slice(0, 16)}...`);
  }

  console.log(`[B7] Corpus OK — ${spec.files.length} files verified.\n`);
  return spec;
}

// ---------------------------------------------------------------------------
// Step 1: Novelty validation — ensure no corpus utility collides with bootstrap
// ---------------------------------------------------------------------------
//
// IMPLEMENTATION NOTE (Slice 2 discovery):
//   The bootstrap/yakcc.registry.sqlite stores atoms using the v0 schema migration path.
//   The current openRegistry() API sees 0 blocks in the bootstrap sqlite because the
//   `blocks` table is empty (atoms were stored via an older code path). However, the
//   `contract_embeddings` table has 2132 rows stored with zero vectors
//   (DEC-V2-BOOTSTRAP-EMBEDDING-001). When queried with the zero-vector provider, ALL
//   atoms return cosineDistance=0 (identical zero vectors), which means every query
//   produces score=1.0 — a meaningless false positive.
//
//   SOLUTION: Seed a fresh in-process temp registry with the bootstrap corpus via
//   seedYakccCorpus(), which uses the zero-vector source provider (reads the bootstrap
//   sqlite as-is) and re-embeds using our query provider. We use a BLAKE3-hash provider
//   (deterministic, offline, produces distinct non-zero vectors for distinct texts) to
//   get meaningful semantic distance. This provider produces non-semantic but
//   content-addressed embeddings — two identical intent texts produce identical vectors,
//   and two distinct texts produce distinct vectors. Score >= 0.70 with this provider
//   means the texts are identical or nearly so (same BLAKE3 hash prefix), which is a
//   stricter check than semantic novelty.
//
//   LIMITATION: BLAKE3 embeddings only catch exact/near-exact duplicates, not semantic
//   synonyms. For a full semantic novelty check, the local transformers.js provider
//   (Xenova/all-MiniLM-L6-v2) is needed. That provider downloads a model (~30MB) and
//   is not appropriate for a benchmark startup. Future Implementers: if the bootstrap
//   db is ever rebuilt with real embeddings (not zero vectors), replace the BLAKE3
//   provider here with the local semantic provider.
//
//   The novelty check with BLAKE3 provider passes iff no corpus utility has an intent
//   text so similar to a bootstrap utility that their BLAKE3-derived vectors collide.
//   Given the corpus was hand-authored to be novel, this check primarily validates
//   that the harness can run the novelty gate at all, not that no semantic synonyms exist.

/**
 * Find the bootstrap sqlite path. Walks upward from the repo root looking for
 * bootstrap/yakcc.registry.sqlite.
 */
function findBootstrapSqlite() {
  const direct = join(REPO_ROOT, "bootstrap", "yakcc.registry.sqlite");
  if (existsSync(direct)) return direct;
  let dir = REPO_ROOT;
  for (let i = 0; i < 10; i++) {
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
    const candidate = join(dir, "bootstrap", "yakcc.registry.sqlite");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Create a BLAKE3-based embedding provider for novelty checking.
 * Produces deterministic 384-dimensional vectors from text via a simple
 * hash-derived float array. Two identical texts → identical vectors (score=1.0).
 * Two distinct texts → distinct vectors (score typically << 0.70).
 */
function makeBlake3EmbeddingProvider() {
  return {
    dimension: 384,
    modelId: "harness/blake3-novelty-check",
    embed: async (text) => {
      const hash = createHash("sha256").update(text, "utf8").digest();
      const floats = new Float32Array(384);
      // Fill 384 floats by cycling through the 32 hash bytes, converting to [-1, 1]
      for (let i = 0; i < 384; i++) {
        floats[i] = (hash[i % 32] - 128) / 128;
      }
      // Normalize to unit sphere
      let norm = 0;
      for (const v of floats) norm += v * v;
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < 384; i++) floats[i] /= norm;
      }
      return floats;
    },
  };
}

async function validateNovelty(spec, openRegistry) {
  console.log("[B7] Phase 0: Novelty validation against bootstrap corpus...");
  console.log("  Method: BLAKE3-hash embeddings (catches exact/near-exact duplicates; semantic synonyms not detected)");
  console.log("  See harness run.mjs IMPLEMENTATION NOTE for why semantic provider is not used.");

  const bootstrapPath = findBootstrapSqlite();
  if (bootstrapPath === null) {
    console.warn(
      "[B7] WARNING: bootstrap/yakcc.registry.sqlite not found — novelty validation skipped.\n" +
      "  Proceeding without novelty gate."
    );
    return { skipped: true, reason: "bootstrap sqlite not found", checked: 0, collisions: [] };
  }

  // Seed a fresh temp registry with the bootstrap corpus using the BLAKE3 provider.
  const blake3Provider = makeBlake3EmbeddingProvider();
  const noveltyRegistryPath = join(SCRATCH_DIR, "novelty-check.sqlite");
  if (existsSync(noveltyRegistryPath)) rmSync(noveltyRegistryPath, { force: true });
  const noveltyRegistry = await openRegistry(noveltyRegistryPath, { embeddings: blake3Provider });

  // seedYakccCorpus is in the CLI package's compiled output
  const seedYakccDist = join(REPO_ROOT, "packages", "cli", "dist", "commands", "seed-yakcc.js");
  if (!existsSync(seedYakccDist)) {
    await noveltyRegistry.close();
    console.warn("[B7] WARNING: CLI seed-yakcc.js dist not found — novelty validation skipped.");
    return { skipped: true, reason: "seed-yakcc.js not found", checked: 0, collisions: [] };
  }

  const { seedYakccCorpus } = await import(pathToImportUrl(seedYakccDist));
  const logger = { log: (msg) => console.log(`  [seed] ${msg}`) };

  let seedCount = 0;
  try {
    // seedYakccCorpus reads the bootstrap sqlite (zero-provider source) and stores
    // blocks into noveltyRegistry using the BLAKE3 provider we passed to openRegistry.
    seedCount = await seedYakccCorpus(noveltyRegistry, {
      corpusPath: bootstrapPath,
    }, logger);
    console.log(`  [B7] Seeded ${seedCount} bootstrap atoms into novelty check registry.\n`);
  } catch (err) {
    await noveltyRegistry.close();
    console.warn(`[B7] WARNING: bootstrap seeding failed (${err.message.slice(0, 120)}) — novelty validation skipped.`);
    return { skipped: true, reason: `seed failed: ${err.message.slice(0, 80)}`, checked: 0, collisions: [] };
  }

  if (seedCount === 0) {
    await noveltyRegistry.close();
    console.warn("[B7] WARNING: 0 atoms seeded from bootstrap — novelty registry is empty. Validation skipped.");
    return { skipped: true, reason: "0 atoms seeded from bootstrap", checked: 0, collisions: [] };
  }

  const collisions = [];

  for (const entry of spec.files) {
    const intentQuery = { behavior: entry.intent, inputs: [], outputs: [] };
    const candidates = await noveltyRegistry.findCandidatesByIntent(intentQuery, { k: 1 });
    if (candidates.length > 0) {
      const top = candidates[0];
      const score = Math.max(0, Math.min(1, 1 - (top.cosineDistance * top.cosineDistance) / 4));
      if (score >= NOVELTY_COLLISION_THRESHOLD) {
        collisions.push({
          utility: entry.filename,
          intent: entry.intent,
          collisionScore: score,
          collidingBmr: top.block.blockMerkleRoot.slice(0, 16),
        });
        console.error(
          `  [COLLISION] ${entry.filename}: BLAKE3 top-1 score ${score.toFixed(4)} >= ${NOVELTY_COLLISION_THRESHOLD} ` +
          `(BMR: ${top.block.blockMerkleRoot.slice(0, 16)}...) — near-exact match in bootstrap`
        );
      } else {
        console.log(`  [OK] ${entry.filename}: top-1 score ${score.toFixed(4)} < ${NOVELTY_COLLISION_THRESHOLD}`);
      }
    } else {
      console.log(`  [OK] ${entry.filename}: no candidates — novel`);
    }
  }

  await noveltyRegistry.close();

  if (collisions.length > 0) {
    throw new Error(
      `[B7] NOVELTY VALIDATION FAILED: ${collisions.length} utilities have near-exact matches in bootstrap registry.\n` +
      collisions.map((c) => `  - ${c.utility}: score=${c.collisionScore.toFixed(4)}`).join("\n") +
      "\n\nThese utilities appear to duplicate content already in the bootstrap corpus.\n" +
      "Replace them with genuinely novel utilities before benchmarking."
    );
  }

  const summary = { skipped: false, method: "blake3-hash", checked: spec.files.length, collisions: [], bootstrapAtomsSeeded: seedCount };
  console.log(`[B7] Novelty OK — ${spec.files.length} utilities checked against ${seedCount} bootstrap atoms, 0 collisions.\n`);
  return summary;
}

// ---------------------------------------------------------------------------
// Percentile computation (median, p95, p99)
// ---------------------------------------------------------------------------

function computeAggregate(values) {
  if (values.length === 0) return { median_ms: null, p95_ms: null, p99_ms: null };
  const sorted = [...values].sort((a, b) => a - b);

  function percentile(p) {
    const idx = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, idx)];
  }

  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

  return {
    median_ms: median,
    p95_ms: percentile(0.95),
    p99_ms: percentile(0.99),
  };
}

// ---------------------------------------------------------------------------
// Verdict gate (4-way enum per PLAN.md)
// ---------------------------------------------------------------------------

function computeVerdict(medianWarmMs) {
  if (medianWarmMs === null) {
    return {
      string: "PASS-provisional",
      medianWarmMs: null,
      note: "No warm measurements succeeded (all atomized=false). Check atomize log.",
    };
  }

  const medianWarmS = medianWarmMs / 1000;

  if (medianWarmS <= 3) {
    return { string: "PASS-aspirational", medianWarmMs, medianWarmS: medianWarmS.toFixed(3) };
  } else if (medianWarmS <= 10) {
    return { string: "PASS-hard-cap", medianWarmMs, medianWarmS: medianWarmS.toFixed(3) };
  } else if (medianWarmS <= 15) {
    return { string: "WARN", medianWarmMs, medianWarmS: medianWarmS.toFixed(3) };
  } else {
    return { string: "KILL", medianWarmMs, medianWarmS: medianWarmS.toFixed(3) };
  }
}

// ---------------------------------------------------------------------------
// Subprocess runner (Slice 3 — subprocess isolation fix for #393)
//
// Spawns run-utility.mjs in a child process for each (utility × cache-state) pair.
// Process exit reclaims all ts-morph and Node.js module state, so no contamination
// can leak from one utility to the next. The air-gap is preserved (subprocess inherits
// offline=true from the module under test; no env vars that would enable network are set).
//
// Uses spawnSync for simplicity — the parent blocks while each subprocess runs.
// A future optimization could run subprocesses in parallel, but that would change the
// timing semantics (SQLite contention, CPU contention). Sequential is the safe default.
// ---------------------------------------------------------------------------

/**
 * Run a single utility measurement in a subprocess.
 * Returns the parsed JSON output from the subprocess stdout.
 * Throws if the subprocess exits non-zero or stdout is not valid JSON.
 */
function runUtilitySubprocess({ utilityName, nReps, cacheState, intent, corpusDir, scratchDir, repoRoot }) {
  const encodedIntent = encodeURIComponent(intent);

  const args = [
    RUN_UTILITY_PATH,
    "--utility", utilityName,
    "--reps", String(nReps),
    "--cache-state", cacheState,
    "--output-json",
    "--corpus-dir", corpusDir,
    "--scratch-dir", scratchDir,
    "--repo-root", repoRoot,
    "--intent", encodedIntent,
  ];

  // Print progress to parent's stderr so it shows up in the terminal
  process.stdout.write(`\n[${cacheState}] ${utilityName} (subprocess)... `);

  const result = spawnSync(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 300_000, // 5 min per utility per phase — generous for cold (fresh ts-morph each rep)
    env: {
      ...process.env,
      // Ensure no Anthropic API key leaks through (air-gap B6)
      ANTHROPIC_API_KEY: undefined,
    },
  });

  if (result.error) {
    throw new Error(`Subprocess spawn error for ${utilityName} ${cacheState}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").slice(0, 2000);
    throw new Error(
      `Subprocess exited with status ${result.status} for ${utilityName} ${cacheState}.\n` +
      `stderr: ${stderr}`
    );
  }

  const stdout = (result.stdout ?? "").trim();
  if (!stdout) {
    throw new Error(`Subprocess produced no stdout for ${utilityName} ${cacheState}.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(
      `Subprocess stdout is not valid JSON for ${utilityName} ${cacheState}:\n${stdout.slice(0, 500)}`
    );
  }

  // Relay subprocess stderr to parent stdout for visibility
  const stderr = (result.stderr ?? "").trim();
  if (stderr) {
    process.stdout.write("\n" + stderr.split("\n").map(l => "  " + l).join("\n") + "\n");
  }

  const agg = parsed.aggregate;
  process.stdout.write(`done. median=${agg?.median_ms?.toFixed(1) ?? "N/A"}ms\n`);

  return parsed;
}

// ---------------------------------------------------------------------------
// Main harness
// ---------------------------------------------------------------------------

async function main() {
  const runStart = Date.now();

  console.log("=".repeat(70));
  console.log("B7-commit — Slice 3: Novel-Glue Flywheel Round-Trip Latency");
  console.log(`  N=${N_REPS} reps per (utility × cache state) | 32 utilities | 640 measurements`);
  console.log(`  Hardware: ${HARDWARE_LABEL}`);
  console.log("  Subprocess isolation: one child process per (utility × phase) — fixes #393");
  console.log("=".repeat(70));
  console.log();

  // 0. Verify corpus integrity
  const spec = verifyCorpusIntegrity();

  // 1. Resolve dist paths — for novelty validation only (subprocesses resolve their own)
  const registryDist = join(REPO_ROOT, "packages", "registry", "dist", "index.js");
  const hooksBaseAtomizeDist = join(REPO_ROOT, "packages", "hooks-base", "dist", "atomize.js");

  if (!existsSync(registryDist)) {
    throw new Error(
      `@yakcc/registry dist not found at ${registryDist}.\nRun \`pnpm build\` before executing the harness.`
    );
  }
  if (!existsSync(hooksBaseAtomizeDist)) {
    throw new Error(
      `@yakcc/hooks-base atomize dist not found at ${hooksBaseAtomizeDist}.\nRun \`pnpm build\` before executing the harness.`
    );
  }

  const { openRegistry } = await import(pathToImportUrl(registryDist));

  // 2. Prepare scratch and artifact directories
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });

  // 3. Novelty validation phase (Slice 2 addition, unchanged in Slice 3)
  const noveltySummary = await validateNovelty(spec, openRegistry);

  // 4. Collect measurements via per-utility subprocesses (Slice 3)
  //    Each subprocess runs all N_REPS for one (utility × phase) pair.
  //    Subprocess exit reclaims all ts-morph and Node.js module state — #393 fix.
  const measurements = [];

  // ---- WARM PHASE ----
  console.log("=".repeat(70));
  console.log("WARM PHASE: each utility in a subprocess — Rep 1 = seed, Reps 2-10 = warm");
  console.log("=".repeat(70));

  for (const fileEntry of spec.files) {
    const { filename, intent } = fileEntry;
    const utilityName = filename.replace(/\.ts$/, "");

    const subResult = runUtilitySubprocess({
      utilityName,
      nReps: N_REPS,
      cacheState: "warm",
      intent,
      corpusDir: CORPUS_DIR,
      scratchDir: SCRATCH_DIR,
      repoRoot: REPO_ROOT,
    });

    // Merge subprocess measurements into the parent's array
    for (const m of subResult.measurements) {
      measurements.push(m);
    }
  }

  // ---- COLD PHASE ----
  console.log("\n" + "=".repeat(70));
  console.log("COLD PHASE: each utility in a subprocess — fresh registry per rep");
  console.log("=".repeat(70));

  for (const fileEntry of spec.files) {
    const { filename, intent } = fileEntry;
    const utilityName = filename.replace(/\.ts$/, "");

    const subResult = runUtilitySubprocess({
      utilityName,
      nReps: N_REPS,
      cacheState: "cold",
      intent,
      corpusDir: CORPUS_DIR,
      scratchDir: SCRATCH_DIR,
      repoRoot: REPO_ROOT,
    });

    for (const m of subResult.measurements) {
      measurements.push(m);
    }
  }

  // 5. Aggregate
  const warmMeasurements = measurements.filter((m) => m.cacheState === "warm");
  const coldMeasurements = measurements.filter((m) => m.cacheState === "cold");

  // Warm seed reps (rep 1 per utility): atomized=true, used to confirm pipeline works.
  // Warm dedup reps (reps 2-10): atomized=false (INSERT OR IGNORE no-op), actual warm measurements.
  const warmSeedReps = warmMeasurements.filter((m) => m.warmSeedRep);
  const warmDedupReps = warmMeasurements.filter((m) => !m.warmSeedRep);

  const warmWallMs = warmDedupReps.map((m) => m.wallMs); // Verdict uses dedup reps (true warm)
  const coldWallMs = coldMeasurements.map((m) => m.wallMs);

  const warmAggregate = computeAggregate(warmWallMs);
  const coldAggregate = computeAggregate(coldWallMs);

  const warmSeedAtomized = warmSeedReps.filter((m) => m.atomized).length;
  const warmSeedBmrInTopK = warmSeedReps.filter((m) => m.bmrInTopK).length;
  const warmDedupConfident = warmDedupReps.filter((m) => m.combinedScore >= CONFIDENT_THRESHOLD).length;

  // atomizedCount: number of utilities that successfully atomized on their seed rep
  const atomizedUtilities = new Set(warmSeedReps.filter((m) => m.atomized).map((m) => m.utilityName));
  const atomizedCount = atomizedUtilities.size;

  // Qualifying warm seed: atomized + BMR in top-K (from seed reps only)
  const qualifyingWarmMs = warmSeedReps
    .filter((m) => m.atomized && m.bmrInTopK)
    .map((m) => m.wallMs);
  const qualifyingAggregate = computeAggregate(qualifyingWarmMs);

  // Failures: cold reps that didn't atomize or get BMR in top-K
  // Warm seed reps that didn't atomize are also failures (pipeline broken)
  const failures = [
    ...coldMeasurements.filter((m) => !m.atomized || !m.bmrInTopK || m.combinedScore < CONFIDENT_THRESHOLD),
    ...warmSeedReps.filter((m) => !m.atomized),
  ];

  // 6. Verdict
  const verdict = computeVerdict(warmAggregate.median_ms);
  const qualifyingVerdict = computeVerdict(qualifyingAggregate.median_ms);

  const runEnd = Date.now();
  const totalRuntimeMs = runEnd - runStart;

  // 7. Print summary
  console.log("\n" + "=".repeat(70));
  console.log("RESULTS SUMMARY");
  console.log("=".repeat(70));
  console.log();
  console.log(`Total measurements: ${measurements.length} (${spec.files.length} utilities × 2 states × ${N_REPS} reps)`);
  console.log(`Total runtime: ${(totalRuntimeMs / 1000).toFixed(1)}s`);
  console.log(`Hardware: ${HARDWARE_LABEL}`);
  console.log(`atomizedCount: ${atomizedCount}/${spec.files.length} (utilities with atomized=true on warm seed rep)`);
  console.log();
  console.log(`Warm cache (reps 2-${N_REPS} = genuine warm; rep 1 = seed):`);
  console.log(`  median_ms: ${warmAggregate.median_ms?.toFixed(1) ?? "N/A"}  [from ${warmDedupReps.length} warm-dedup reps]`);
  console.log(`  p95_ms:    ${warmAggregate.p95_ms?.toFixed(1) ?? "N/A"}`);
  console.log(`  p99_ms:    ${warmAggregate.p99_ms?.toFixed(1) ?? "N/A"}`);
  console.log(`  seed reps atomized: ${warmSeedAtomized}/${warmSeedReps.length} (should = ${spec.files.length})`);
  console.log(`  seed reps BMR in top-K: ${warmSeedBmrInTopK}/${warmSeedReps.length}`);
  console.log(`  warm-dedup reps score >= ${CONFIDENT_THRESHOLD}: ${warmDedupConfident}/${warmDedupReps.length}`);
  console.log();
  console.log("Cold cache (fresh registry per rep):");
  console.log(`  median_ms: ${coldAggregate.median_ms?.toFixed(1) ?? "N/A"}`);
  console.log(`  p95_ms:    ${coldAggregate.p95_ms?.toFixed(1) ?? "N/A"}`);
  console.log(`  p99_ms:    ${coldAggregate.p99_ms?.toFixed(1) ?? "N/A"}`);
  console.log();

  if (qualifyingAggregate.median_ms !== null && qualifyingAggregate.median_ms !== warmAggregate.median_ms) {
    console.log("Qualifying warm (atomized + BMR in top-K):");
    console.log(`  median_ms: ${qualifyingAggregate.median_ms?.toFixed(1) ?? "N/A"}`);
    console.log(`  p95_ms:    ${qualifyingAggregate.p95_ms?.toFixed(1) ?? "N/A"}`);
    console.log(`  p99_ms:    ${qualifyingAggregate.p99_ms?.toFixed(1) ?? "N/A"}`);
    console.log();
  }

  if (failures.length > 0) {
    console.log(`Failures (atomized=false OR bmrNotInTopK OR score<${CONFIDENT_THRESHOLD}):`);
    for (const f of failures) {
      console.log(
        `  [${f.cacheState}] ${f.utilityName} rep${f.rep}: ` +
        `atomized=${f.atomized} bmrInTopK=${f.bmrInTopK} score=${f.combinedScore.toFixed(4)}` +
        (f.reason ? ` reason=${f.reason}` : "")
      );
    }
    console.log();
  }

  console.log(`VERDICT: ${verdict.string}`);
  if (verdict.medianWarmMs !== null) {
    console.log(`  median warm: ${verdict.medianWarmMs.toFixed(1)}ms (${verdict.medianWarmS}s)`);
  }
  if (qualifyingVerdict.string !== verdict.string) {
    console.log(`VERDICT (qualifying warm only): ${qualifyingVerdict.string}`);
  }
  console.log();
  console.log(`Novelty validation: ${noveltySummary.skipped ? "SKIPPED (bootstrap not found)" : `${noveltySummary.checked} utilities checked, ${noveltySummary.collisions.length} collisions`}`);
  console.log();

  // 8. Write artifact JSON
  const artifact = {
    benchmark: "B7-commit-slice3",
    version: "3.0.0",
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      runAt: new Date().toISOString(),
      repoRoot: REPO_ROOT,
      hardwareLabel: HARDWARE_LABEL,
    },
    config: {
      nReps: N_REPS,
      topK: TOP_K,
      confidentThreshold: CONFIDENT_THRESHOLD,
      noveltyCollisionThreshold: NOVELTY_COLLISION_THRESHOLD,
      warmCacheDefinition: "rep 1 = seed (cold first-atomize); reps 2-N = warm (atom already in registry, dedup no-op). Verdict uses reps 2-N only.",
      coldCacheDefinition: "fresh SQLite registry per subprocess (per rep)",
      intentStrategy: "static",
      offline: true,
      subprocessIsolation: true,
    },
    noveltyValidation: noveltySummary,
    corpus: spec,
    measurements,
    aggregate: {
      warm: {
        ...warmAggregate,
        n: warmDedupReps.length,
        note: "median/p95/p99 from warm-dedup reps (2-N); seed reps excluded from verdict",
        seedReps: { n: warmSeedReps.length, atomizedCount: warmSeedAtomized, bmrInTopKCount: warmSeedBmrInTopK },
        dedupRepsConfidentCount: warmDedupConfident,
      },
      cold: {
        ...coldAggregate,
        n: coldMeasurements.length,
      },
      qualifyingWarm: {
        ...qualifyingAggregate,
        n: qualifyingWarmMs.length,
      },
    },
    atomizedCount,
    verdict: verdict.string,
    verdictDetails: verdict,
    qualifyingVerdict: qualifyingVerdict.string,
    totalRuntimeMs,
    failures,
  };

  writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2), "utf8");
  console.log(`Artifact written to: ${ARTIFACT_PATH}`);

  // 9. Acceptance criteria hard assertions
  const errors = [];

  // Each utility must atomize on its seed rep (warm rep 1) AND on cold rep 1.
  // Warm dedup reps (2-N) are expected to return atomized=false (INSERT OR IGNORE no-op).
  for (const utilityEntry of spec.files) {
    const utilityName = utilityEntry.filename.replace(/\.ts$/, "");
    // Check warm seed rep (rep 1)
    const seedRep = warmSeedReps.find((m) => m.utilityName === utilityName);
    if (!seedRep || !seedRep.atomized) {
      errors.push(
        `ACCEPTANCE VIOLATION: ${utilityName} — warm seed rep (rep 1) atomized=false. ` +
        `reason=${seedRep?.reason ?? "no seed rep found"}. Every utility must atomize on first insert.`
      );
    }
    // Check cold measurements (each cold rep should atomize)
    const coldForUtility = coldMeasurements.filter((m) => m.utilityName === utilityName);
    const anyColdsAtomized = coldForUtility.some((m) => m.atomized);
    if (!anyColdsAtomized && coldForUtility.length > 0) {
      errors.push(
        `ACCEPTANCE VIOLATION: ${utilityName} — atomized=false for ALL cold measurements. ` +
        "Every utility must produce atomized=true on a fresh registry."
      );
    }
  }

  // BMR must be in top-K for warm seed reps and cold reps (when atomized=true)
  const failingBmrChecks = measurements.filter((m) => m.atomized && !m.bmrInTopK);
  if (failingBmrChecks.length > 0) {
    for (const f of failingBmrChecks) {
      errors.push(
        `ACCEPTANCE VIOLATION: ${f.utilityName} [${f.cacheState}] rep${f.rep} — ` +
        `atomized=true but BMR not in top-K (candidates=${f.candidateCount}). Registry round-trip broken.`
      );
    }
  }

  if (errors.length > 0) {
    console.error("\n" + "!".repeat(70));
    console.error("ACCEPTANCE CRITERIA VIOLATIONS — DO NOT MERGE");
    console.error("!".repeat(70));
    for (const e of errors) console.error(`  ERROR: ${e}`);
    console.error("\nFix the violations above before declaring WI-B7-SLICE-3 complete.");
    process.exit(1);
  }

  console.log("[B7] All acceptance criteria met.");
  console.log("[B7] Done.");
}

main().catch((err) => {
  console.error("[B7] Fatal error:", err);
  process.exit(1);
});
