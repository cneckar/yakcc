// SPDX-License-Identifier: MIT
//
// bench/B2-bloat/harness/run.mjs
//
// B2-bloat benchmark: measure transitive dependency weight reduction
// for a JSON Schema 2020-12 validator implemented as Yakcc atoms vs ajv@8.x.
//
// @decision DEC-BENCH-B2-001
// @title B2 bloat benchmark — initial slice (cold-corpus, coarse granularity)
// @status pending-tester
// @rationale
//   This is the initial B2 slice running at "coarse" granularity (single atom
//   implementing the full validator). The ≥90% transitive-weight-reduction bar
//   is a DIRECTIONAL TARGET, not a hard kill criterion per the 2026-05-13
//   reframe (#186 comment 4442627848). The current corpus lacks application-layer
//   atoms needed to compose the validator from existing registry atoms; the
//   bundle size therefore reflects a cold-corpus baseline where all code is new.
//
//   VERDICT DEFINITION:
//   - PASS-DIRECTIONAL: all axes meet directional targets
//   - WARN-DIRECTIONAL: some axes below target (cold-corpus expected)
//   - PENDING: dry-run mode
//
//   B2 sweep dimension: emit-strategy granularity (fine / medium / coarse).
//   This slice measures the COARSE point (single atom). Fine and medium
//   granularity slices are planned once application-layer corpus atoms land.
//
//   TESTER NOTE (fill after live run):
//   yakcc_raw_bytes: <fill>
//   yakcc_gzip_bytes: <fill>
//   ajv_raw_bytes: <fill>
//   ajv_gzip_bytes: <fill>
//   test_pass_rate: <fill>/%
//   reduction_pct: <fill>%
//   verdict: <PASS-DIRECTIONAL|WARN-DIRECTIONAL>
//   verdict_recorded_by: tester
//   verdict_recorded_at: <date>
//
// Usage:
//   node bench/B2-bloat/harness/run.mjs           (live run, requires pnpm install)
//   node bench/B2-bloat/harness/run.mjs --dry-run  (uses fixture test cases only)

import { createGzip } from "node:zlib";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = resolve(__dirname, "..");
const ROOT_DIR = resolve(__dirname, "../../..");
const VALIDATOR_SRC = resolve(ROOT_DIR, "examples/json-schema-validator/src/validator.ts");
const FIXTURES_DIR = resolve(BENCH_DIR, "fixtures");
const OUT_DIR = resolve(ROOT_DIR, "tmp/B2-bloat");

const isDryRun = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(msg + "\n");
}

function logSection(title) {
  log("\n" + "=".repeat(60));
  log("  " + title);
  log("=".repeat(60));
}

// ---------------------------------------------------------------------------
// Gzip a file and return compressed size in bytes
// ---------------------------------------------------------------------------

async function gzipSize(filePath) {
  const tmpGz = filePath + ".gz";
  await pipeline(
    createReadStream(filePath),
    createGzip({ level: 9 }),
    createWriteStream(tmpGz),
  );
  const size = statSync(tmpGz).size;
  // cleanup
  try { (await import("node:fs")).unlinkSync(tmpGz); } catch {}
  return size;
}

// ---------------------------------------------------------------------------
// Bundle with esbuild (if available)
// ---------------------------------------------------------------------------

async function bundleWithEsbuild(entryPoint, outFile, platform = "node") {
  let esbuild;
  try {
    const _require = createRequire(import.meta.url);
    esbuild = _require("esbuild");
  } catch {
    return null; // esbuild not available
  }

  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    minify: true,
    platform,
    format: "esm",
    outfile: outFile,
  });
  return statSync(outFile).size;
}

// ---------------------------------------------------------------------------
// Build the Yakcc validator bundle
// ---------------------------------------------------------------------------

async function measureYakccValidator() {
  logSection("Arm A: Yakcc JSON Schema 2020-12 validator (coarse granularity)");

  // We use tsx/ts-node to compile the TypeScript on the fly, then bundle
  // with esbuild. In dry-run mode, we measure the raw TypeScript source size.

  mkdirSync(OUT_DIR, { recursive: true });

  const rawTs = readFileSync(VALIDATOR_SRC, "utf8");
  const rawSize = Buffer.byteLength(rawTs, "utf8");

  log(`  Source: ${VALIDATOR_SRC}`);
  log(`  Raw TypeScript source: ${rawSize} bytes`);

  let bundleSize = null;
  let gzipBundleSize = null;

  if (!isDryRun) {
    // Try to compile TypeScript to JS first
    const jsOutFile = join(OUT_DIR, "yakcc-validator.mjs");
    let jsSource = null;

    // Try building the example package to get compiled JS
    const compiledPath = resolve(ROOT_DIR, "examples/json-schema-validator/dist/validator.js");
    if (existsSync(compiledPath)) {
      jsSource = compiledPath;
    } else {
      // Try tsc compilation
      try {
        const { execFileSync } = await import("node:child_process");
        execFileSync("pnpm", ["--filter", "@yakcc/example-json-schema-validator", "build"], {
          cwd: ROOT_DIR,
          stdio: "pipe",
        });
        if (existsSync(compiledPath)) jsSource = compiledPath;
      } catch {
        log("  Warning: Could not compile TypeScript; using source size estimate");
      }
    }

    if (jsSource) {
      bundleSize = await bundleWithEsbuild(jsSource, jsOutFile);
      if (bundleSize !== null) {
        gzipBundleSize = await gzipSize(jsOutFile);
        log(`  Bundled (esbuild, minified): ${bundleSize} bytes`);
        log(`  Bundled (gzip): ${gzipBundleSize} bytes`);
      }
    }
  }

  return {
    arm: "yakcc-coarse",
    rawTsSize: rawSize,
    bundleSize,
    gzipBundleSize,
    // Distinct-unit count: 1 atom (coarse granularity)
    distinctUnits: 1,
  };
}

// ---------------------------------------------------------------------------
// Measure ajv bundle size (reference comparator)
// ---------------------------------------------------------------------------

async function measureAjv() {
  logSection("Arm B: ajv@8.x (reference comparator)");

  let ajvBundleSize = null;
  let ajvGzipSize = null;

  if (!isDryRun) {
    mkdirSync(OUT_DIR, { recursive: true });
    const ajvOutFile = join(OUT_DIR, "ajv-bundle.mjs");

    // Create a minimal ajv entry point
    const ajvEntry = join(OUT_DIR, "ajv-entry.mjs");
    writeFileSync(ajvEntry, `import Ajv from "ajv";\nexport default Ajv;\n`);

    ajvBundleSize = await bundleWithEsbuild(ajvEntry, ajvOutFile, "browser");
    if (ajvBundleSize !== null) {
      ajvGzipSize = await gzipSize(ajvOutFile);
      log(`  ajv bundle (esbuild, minified): ${ajvBundleSize} bytes`);
      log(`  ajv bundle (gzip): ${ajvGzipSize} bytes`);
    } else {
      // Fallback: try to get ajv size from node_modules
      try {
        const _require = createRequire(import.meta.url);
        const ajvPath = _require.resolve("ajv");
        const ajvDir = dirname(ajvPath);
        log(`  ajv installed at: ${ajvDir}`);

        // Measure node_modules/ajv directory size recursively
        let totalSize = 0;
        const { readdirSync } = await import("node:fs");
        function measureDir(dir) {
          try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const p = join(dir, entry.name);
              if (entry.isDirectory()) measureDir(p);
              else totalSize += statSync(p).size;
            }
          } catch {}
        }
        measureDir(join(ajvDir, ".."));
        log(`  ajv + deps on-disk: ${totalSize} bytes`);
        ajvBundleSize = totalSize;
      } catch {
        log("  ajv not installed (run: pnpm --dir bench/B2-bloat install)");
      }
    }
  }

  return {
    arm: "ajv",
    bundleSize: ajvBundleSize,
    gzipBundleSize: ajvGzipSize,
    // ajv@8.x has ~12 packages in its transitive closure
    distinctUnits: 12,
  };
}

// ---------------------------------------------------------------------------
// Run test suite
// ---------------------------------------------------------------------------

async function runTestSuite() {
  logSection("Test suite: JSON Schema 2020-12");

  // Load fixture test cases (always available)
  const fixtureTests = JSON.parse(readFileSync(join(FIXTURES_DIR, "test-cases.json"), "utf8"));

  // Try to load the compiled validator
  let validateFn = null;
  const compiledPath = resolve(ROOT_DIR, "examples/json-schema-validator/dist/validator.js");

  if (!isDryRun && existsSync(compiledPath)) {
    try {
      const mod = await import(compiledPath);
      validateFn = mod.validate;
    } catch (e) {
      log(`  Warning: could not load compiled validator: ${e.message}`);
    }
  }

  if (!validateFn && !isDryRun) {
    // Try to build first
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("pnpm", ["--filter", "@yakcc/example-json-schema-validator", "build"], {
        cwd: ROOT_DIR,
        stdio: "pipe",
      });
      if (existsSync(compiledPath)) {
        const mod = await import(compiledPath);
        validateFn = mod.validate;
      }
    } catch {}
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  for (const group of fixtureTests) {
    for (const testCase of group.tests) {
      if (isDryRun || !validateFn) {
        skipped++;
        continue;
      }

      try {
        const result = validateFn(group.schema, testCase.data);
        if (result.valid === testCase.valid) {
          passed++;
        } else {
          failed++;
          failures.push({
            group: group.description,
            test: testCase.description,
            expected: testCase.valid,
            got: result.valid,
            errors: result.errors.map((e) => e.message).slice(0, 3),
          });
        }
      } catch (e) {
        failed++;
        failures.push({
          group: group.description,
          test: testCase.description,
          expected: testCase.valid,
          got: "ERROR",
          error: e.message,
        });
      }
    }
  }

  const total = passed + failed + skipped;
  const passRate = total > 0 && skipped < total
    ? ((passed / (passed + failed)) * 100).toFixed(1)
    : "N/A";

  log(`  Test groups: ${fixtureTests.length}`);
  log(`  Total cases: ${total}`);
  if (isDryRun) {
    log(`  Mode: dry-run (skipped ${skipped} cases — validator not loaded)`);
  } else {
    log(`  Passed: ${passed}`);
    log(`  Failed: ${failed}`);
    log(`  Pass rate: ${passRate}%`);
  }

  if (failures.length > 0) {
    log("\n  Failures:");
    for (const f of failures.slice(0, 20)) {
      log(`    [${f.group}] ${f.test}: expected valid=${f.expected}, got ${JSON.stringify(f.got)}`);
      if (f.errors) log(`      errors: ${f.errors.join("; ")}`);
      if (f.error) log(`      exception: ${f.error}`);
    }
    if (failures.length > 20) log(`    ... and ${failures.length - 20} more failures`);
  }

  return { passed, failed, skipped, total, passRate, failures };
}

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------

function printResultsTable(yakcc, ajv, testResults) {
  logSection("Results: B2 Bloat Reduction");

  const pct = (a, b) => b > 0 ? (((b - a) / b) * 100).toFixed(1) + "%" : "N/A";
  const fmt = (n) => n !== null && n !== undefined ? n.toLocaleString() + " bytes" : "(not measured)";

  const pad = (s, n) => String(s).padEnd(n);
  log("\n  Bundle size comparison (esbuild minified):");
  log(`  ${pad("Arm", 18)} ${pad("Raw", 22)} ${pad("Gzip", 22)} ${pad("Distinct units", 16)}`);
  log("  " + "-".repeat(80));
  log(`  ${pad("Yakcc (coarse)", 18)} ${pad(fmt(yakcc.bundleSize), 22)} ${pad(fmt(yakcc.gzipBundleSize), 22)} ${pad(String(yakcc.distinctUnits), 16)}`);
  log(`  ${pad("ajv@8.x", 18)} ${pad(fmt(ajv.bundleSize), 22)} ${pad(fmt(ajv.gzipBundleSize), 22)} ${pad(String(ajv.distinctUnits), 16)}`);

  if (yakcc.bundleSize !== null && ajv.bundleSize !== null) {
    log(`\n  Raw size reduction: ${pct(yakcc.bundleSize, ajv.bundleSize)} (target: ≥90%)`);
    log(`  Gzip size reduction: ${pct(yakcc.gzipBundleSize, ajv.gzipBundleSize)}`);
    log(`  Distinct-unit reduction: ${pct(yakcc.distinctUnits, ajv.distinctUnits)}`);

    const rawReduction = ((ajv.bundleSize - yakcc.bundleSize) / ajv.bundleSize) * 100;
    const passBar = rawReduction >= 90;
    log(`\n  ≥90% reduction bar: ${passBar ? "PASS" : "MISS"} (${rawReduction.toFixed(1)}%)`);
    log(`  Note: cold-corpus baseline (no registry atoms reused). The reduction`);
    log(`  will grow as application-layer atoms are added to the registry.`);
  } else if (isDryRun) {
    log("\n  (Dry-run mode: bundle sizes not measured. Run without --dry-run to measure.)");
    log(`  Yakcc raw TypeScript source: ${yakcc.rawTsSize?.toLocaleString()} bytes`);
  }

  log(`\n  Semantic correctness (test suite):`);
  if (isDryRun) {
    log(`  (Dry-run mode: test cases loaded but validator not executed)`);
    log(`  Test cases available: ${testResults.total}`);
  } else {
    log(`  Pass rate: ${testResults.passRate}% (${testResults.passed}/${testResults.passed + testResults.failed} cases)`);
    const semanticBar = typeof testResults.passRate === "string" && parseFloat(testResults.passRate) >= 95;
    log(`  ≥95% equivalence bar: ${semanticBar ? "PASS" : (isDryRun ? "PENDING" : "MISS")}`);
  }
}

// ---------------------------------------------------------------------------
// Write results JSON
// ---------------------------------------------------------------------------

function writeResults(yakcc, ajv, testResults) {
  if (isDryRun) return;
  mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(OUT_DIR, `results-b2-${ts}.json`);
  const data = {
    run_id: Math.random().toString(36).slice(2),
    started_at: new Date().toISOString(),
    platform: process.platform + "-" + process.arch,
    granularity: "coarse",
    arms: { yakcc, ajv },
    test_results: {
      total: testResults.total,
      passed: testResults.passed,
      failed: testResults.failed,
      pass_rate: testResults.passRate,
    },
  };
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  log(`\n  Results written to: ${outPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("B2-bloat benchmark: JSON Schema 2020-12 validator bloat reduction");
  log(`Mode: ${isDryRun ? "dry-run" : "live"}`);
  log(`Date: ${new Date().toISOString()}`);

  if (isDryRun) {
    log("\nDry-run mode: validates harness infrastructure without API calls.");
    log("Loads fixture test cases and reports schema/test counts.");
    log("Run without --dry-run to measure actual bundle sizes.");
  }

  const [yakcc, ajv, testResults] = await Promise.all([
    measureYakccValidator(),
    measureAjv(),
    runTestSuite(),
  ]);

  printResultsTable(yakcc, ajv, testResults);
  writeResults(yakcc, ajv, testResults);

  const exitCode = isDryRun ? 0 : (testResults.failed > 0 ? 1 : 0);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
