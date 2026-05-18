// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/test/arm-a-emit.test.mjs
//
// Unit tests for harness/arm-a-emit.mjs
//
// Tests:
// 1. ARM_A_STRATEGIES constant is correct
// 2. TASK_ENTRY_FUNCTIONS has all 6 tasks
// 3. resolveArmAEmit returns valid paths for all tasks/strategies
//    (source enum extended: also accepts "bench-reference-stale-fallback")
// 4. resolveArmAEmit throws for unknown strategy
// 5. resolveArmAEmit throws for unknown taskId
// 6. listAllArmAEmits returns 18 entries (6 tasks x 3 strategies) with no errors
// 7. All A-fine emit files importable and have entry function
// 8. CLI --list produces output for all 18 emits
// 9. CLI --task + --strategy produces JSON with correct fields
// 10. freshness guard: falls back to bench reference when dist mtime older than fallback
// 11. freshness guard: returns yakcc-compile when dist mtime newer than fallback
// 12. freshness guard: --force-gold-standard bypasses guard even when dist is stale
// 13. freshness guard: stderr warning emitted via CLI when guard fires (subprocess)

import { strictEqual, ok, deepEqual } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  resolveArmAEmit,
  listAllArmAEmits,
  ARM_A_STRATEGIES,
  TASK_ENTRY_FUNCTIONS,
} from "../harness/arm-a-emit.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B9_ROOT = resolve(__dirname, "..");
const WORKTREE_ROOT = resolve(BENCH_B9_ROOT, "..", "..");

// ---------------------------------------------------------------------------
// Test 1: ARM_A_STRATEGIES constant is correct
// ---------------------------------------------------------------------------

test("arm-a-emit: ARM_A_STRATEGIES constant", () => {
  deepEqual(ARM_A_STRATEGIES, ["A-fine", "A-medium", "A-coarse"]);
});

// ---------------------------------------------------------------------------
// Test 2: TASK_ENTRY_FUNCTIONS has all 6 tasks
// ---------------------------------------------------------------------------

test("arm-a-emit: TASK_ENTRY_FUNCTIONS has all 6 tasks", () => {
  const tasks = Object.keys(TASK_ENTRY_FUNCTIONS);
  strictEqual(tasks.length, 6, `expected 6 tasks, got ${tasks.length}: ${tasks.join(", ")}`);
  ok(tasks.includes("parse-int-list"), "missing parse-int-list");
  ok(tasks.includes("parse-coord-pair"), "missing parse-coord-pair");
  ok(tasks.includes("csv-row-narrow"), "missing csv-row-narrow");
  ok(tasks.includes("kebab-to-camel"), "missing kebab-to-camel");
  ok(tasks.includes("digits-to-sum"), "missing digits-to-sum");
  ok(tasks.includes("even-only-filter"), "missing even-only-filter");
});

// ---------------------------------------------------------------------------
// Test 3: resolveArmAEmit returns valid paths for all tasks/strategies
// NOTE: source enum extended -- now also accepts "bench-reference-stale-fallback"
//       (DEC-B9-EMIT-FRESHNESS-GUARD-001: the guard may fire against the real dist
//        file if it is stale relative to the bench fallback at the time tests run)
// ---------------------------------------------------------------------------

test("arm-a-emit: resolveArmAEmit -- all (task, strategy) pairs resolve", () => {
  const taskIds = Object.keys(TASK_ENTRY_FUNCTIONS);
  for (const taskId of taskIds) {
    for (const strategy of ARM_A_STRATEGIES) {
      const { emitPath, source } = resolveArmAEmit(WORKTREE_ROOT, taskId, strategy);
      ok(emitPath, `emitPath should be non-empty for ${taskId}/${strategy}`);
      ok(
        existsSync(emitPath),
        `emit file should exist for ${taskId}/${strategy}: ${emitPath}`
      );
      ok(
        source === "bench-reference" || source === "yakcc-compile" || source === "bench-reference-stale-fallback",
        `source should be bench-reference, yakcc-compile, or bench-reference-stale-fallback for ${taskId}/${strategy}, got: ${source}`
      );
      console.log(`  [OK] ${taskId}/${strategy} -> ${source}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Test 4: resolveArmAEmit throws for unknown strategy
// ---------------------------------------------------------------------------

test("arm-a-emit: resolveArmAEmit -- throws for unknown strategy", () => {
  let threw = false;
  try {
    resolveArmAEmit(WORKTREE_ROOT, "parse-int-list", "A-nonexistent");
  } catch (err) {
    threw = true;
    ok(err.message.includes("Unknown strategy"), `error message should mention 'Unknown strategy', got: ${err.message}`);
  }
  ok(threw, "should have thrown for unknown strategy");
});

// ---------------------------------------------------------------------------
// Test 5: resolveArmAEmit throws for unknown taskId
// ---------------------------------------------------------------------------

test("arm-a-emit: resolveArmAEmit -- throws for unknown taskId", () => {
  let threw = false;
  try {
    resolveArmAEmit(WORKTREE_ROOT, "nonexistent-task", "A-fine");
  } catch (err) {
    threw = true;
    ok(err.message.includes("not found") || err.message.includes("Unknown"),
      `error should mention not-found or Unknown, got: ${err.message}`);
  }
  ok(threw, "should have thrown for unknown task");
});

// ---------------------------------------------------------------------------
// Test 6: listAllArmAEmits returns 18 entries, all resolved, no errors
// ---------------------------------------------------------------------------

test("arm-a-emit: listAllArmAEmits -- 18 entries, all present", () => {
  const taskIds = Object.keys(TASK_ENTRY_FUNCTIONS);
  const emits = listAllArmAEmits(WORKTREE_ROOT, taskIds);

  strictEqual(emits.length, 18, `expected 18 emits (6 tasks x 3 strategies), got ${emits.length}`);

  const missing = emits.filter(e => e.error);
  if (missing.length > 0) {
    console.error("  MISSING emits:");
    for (const m of missing) console.error(`    ${m.taskId}/${m.strategy}: ${m.error}`);
  }
  strictEqual(missing.length, 0, `all emits should resolve without error; ${missing.length} missing`);

  for (const e of emits) {
    ok(e.emitPath, `emitPath should be non-empty for ${e.taskId}/${e.strategy}`);
    ok(e.entryFunction, `entryFunction should be set for ${e.taskId}/${e.strategy}`);
  }
});

// ---------------------------------------------------------------------------
// Test 7: listAllArmAEmits -- each emit file is actually loadable as a module
//         (basic syntax/export check via dynamic import of the .mjs path)
// ---------------------------------------------------------------------------

test("arm-a-emit: all emit files importable and have entry function", async (t) => {
  const taskIds = Object.keys(TASK_ENTRY_FUNCTIONS);
  const emits = listAllArmAEmits(WORKTREE_ROOT, taskIds);

  // Test a sample of emits: fine strategy for each task (not all 18 to keep test fast)
  const fineEmits = emits.filter(e => e.strategy === "A-fine");
  strictEqual(fineEmits.length, 6, `expected 6 A-fine emits, got ${fineEmits.length}`);

  for (const emit of fineEmits) {
    const { pathToFileURL } = await import("node:url");
    let mod;
    try {
      mod = await import(pathToFileURL(emit.emitPath).href);
    } catch (err) {
      throw new Error(`Failed to import ${emit.taskId}/A-fine (${emit.emitPath}): ${err.message}`);
    }

    const entryFn = mod[emit.entryFunction] ?? mod.default?.[emit.entryFunction] ?? mod.default;
    ok(
      typeof entryFn === "function",
      `Entry function '${emit.entryFunction}' should be exported from ${emit.taskId}/A-fine. Exports: ${Object.keys(mod).join(", ")}`
    );
    console.log(`  [OK] ${emit.taskId}/A-fine exports '${emit.entryFunction}'`);
  }
});

// ---------------------------------------------------------------------------
// Test 8: CLI --list produces output for all 18 emits (subprocess test)
// ---------------------------------------------------------------------------

test("arm-a-emit: CLI --list output", () => {
  const result = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "arm-a-emit.mjs"),
    "--list",
  ], {
    encoding: "utf8",
    timeout: 15_000,
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`arm-a-emit --list exited ${result.status}: ${result.stderr?.slice(0, 500)}`);
  }

  const lines = result.stdout.trim().split("\n").filter(l => l.trim());
  const okLines = lines.filter(l => l.includes("[OK]"));
  const missingLines = lines.filter(l => l.includes("[MISSING]"));

  strictEqual(okLines.length, 18, `expected 18 [OK] lines, got ${okLines.length}`);
  strictEqual(missingLines.length, 0, `expected 0 [MISSING] lines, got ${missingLines.length}: ${missingLines.join("; ")}`);

  console.log(`  CLI --list: ${okLines.length} [OK], ${missingLines.length} [MISSING]`);
});

// ---------------------------------------------------------------------------
// Test 9: CLI --task + --strategy --json produces valid JSON
// ---------------------------------------------------------------------------

test("arm-a-emit: CLI --task --strategy --json output", () => {
  const result = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "arm-a-emit.mjs"),
    "--task", "digits-to-sum",
    "--strategy", "A-medium",
    "--json",
  ], {
    encoding: "utf8",
    timeout: 15_000,
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`arm-a-emit CLI exited ${result.status}: ${result.stderr?.slice(0, 500)}`);
  }

  let output;
  try {
    output = JSON.parse(result.stdout.trim());
  } catch (err) {
    throw new Error(`CLI output is not valid JSON: ${result.stdout.slice(0, 200)}`);
  }

  strictEqual(output.task_id, "digits-to-sum");
  strictEqual(output.strategy, "A-medium");
  ok(output.emit_path, "emit_path should be set");
  strictEqual(output.entry_function, "digitsToSum");
  ok(existsSync(output.emit_path), `emit_path should exist: ${output.emit_path}`);

  console.log(`  CLI --task digits-to-sum --strategy A-medium -> emit_path exists, entry_function=${output.entry_function}`);
});

// ---------------------------------------------------------------------------
// Freshness guard tests (Tests 10-13)
// ---------------------------------------------------------------------------
// Helper: build a minimal fixture repo tree under a temp directory.
// Structure mirrors the real repo layout the guard expects:
//   <fixtureRoot>/
//     examples/parse-int-list/dist/module.mjs   (stub compiled dist)
//     bench/B9-min-surface/tasks/parse-int-list/arm-a/fine.mjs  (stub bench fallback)
//
// IMPORTANT: we point repoRoot at fixtureRoot but BENCH_B9_ROOT inside the
// imported resolveArmAEmit is hardcoded to the real bench directory. The
// function computes benchPath as:
//   join(BENCH_B9_ROOT, "tasks", taskId, "arm-a", `${strategyDir}.mjs`)
// where BENCH_B9_ROOT is the module-level constant pointing at the real
// bench/B9-min-surface tree. That means for mtime comparison, the real bench
// fallback file is used -- which is what we want: the guard must compare the
// fixture's dist mtime against the REAL bench fallback mtime.
//
// To simulate "dist is older than bench fallback", we backdate the fixture
// dist file to a Unix epoch (Jan 1, 1970) -- well before any real bench file.
// To simulate "dist is newer", we set the fixture dist mtime to far future.
// ---------------------------------------------------------------------------

/**
 * Create a minimal fixture repo root with stub dist/module.mjs.
 * Returns { fixtureRoot, distPath, realBenchPath } so caller can manipulate mtimes.
 */
function buildFixture(label) {
  const fixtureRoot = mkdtempSync(join(WORKTREE_ROOT, "tmp", `wi-fix-698-fixtures-${label}-`));
  const distDir = join(fixtureRoot, "examples", "parse-int-list", "dist");
  mkdirSync(distDir, { recursive: true });
  const distPath = join(distDir, "module.mjs");
  // Minimal stub module -- just needs to exist, content doesn't matter for mtime test
  writeFileSync(distPath, "export function listOfInts(s) { return []; }\n", "utf8");

  const realBenchPath = join(BENCH_B9_ROOT, "tasks", "parse-int-list", "arm-a", "fine.mjs");
  return { fixtureRoot, distPath, realBenchPath };
}

// ---------------------------------------------------------------------------
// Test 10: freshness guard -- falls back to bench reference when dist is stale
//   GIVEN dist mtime older than bench fallback mtime (backdated to epoch)
//   AND options.forceGoldStandard !== true
//   THEN returns { source: "bench-reference-stale-fallback", emitPath: <bench fallback path> }
// ---------------------------------------------------------------------------

test("arm-a-emit: freshness guard -- falls back to bench reference when dist mtime older than fallback", async () => {
  const { fixtureRoot, distPath, realBenchPath } = buildFixture("stale");
  try {
    // Backdate dist to Unix epoch (well before any real bench file)
    const epoch = new Date(0);
    utimesSync(distPath, epoch, epoch);
    console.log(`  fixture dist mtime: ${new Date(0).toISOString()} (epoch)`);
    console.log(`  real bench fallback: ${realBenchPath}`);

    // Capture stderr to verify the warning is emitted
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrLines.push(String(chunk));
      return origWrite(chunk, ...rest);
    };

    let result;
    try {
      result = resolveArmAEmit(fixtureRoot, "parse-int-list", "A-fine");
    } finally {
      process.stderr.write = origWrite;
    }

    strictEqual(
      result.source,
      "bench-reference-stale-fallback",
      `expected source="bench-reference-stale-fallback", got: ${result.source}`
    );
    strictEqual(
      result.emitPath,
      realBenchPath,
      `expected emitPath to be the real bench fallback path`
    );

    const warnText = stderrLines.join("");
    ok(warnText.includes("WARN"), `stderr should contain "WARN", got: ${warnText.slice(0, 200)}`);
    ok(warnText.includes("mtime"), `stderr should contain "mtime", got: ${warnText.slice(0, 200)}`);
    ok(warnText.includes(realBenchPath) || warnText.includes("fine.mjs"),
      `stderr should reference bench fallback path, got: ${warnText.slice(0, 300)}`);

    console.log(`  [OK] source=${result.source}, emitPath=<bench fallback>`);
    console.log(`  [OK] stderr WARN: ${warnText.trim().slice(0, 120)}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 11: freshness guard -- returns yakcc-compile when dist mtime newer than fallback
//   GIVEN dist mtime in the far future (newer than bench fallback)
//   THEN returns { source: "yakcc-compile", emitPath: <dist path> }
//   AND no warning is written to stderr
// ---------------------------------------------------------------------------

test("arm-a-emit: freshness guard -- returns yakcc-compile when dist mtime newer than fallback", async () => {
  const { fixtureRoot, distPath, realBenchPath } = buildFixture("fresh");
  try {
    // Forward-date dist to far future (year 2099) -- definitely newer than any bench file
    const future = new Date("2099-01-01T00:00:00.000Z");
    utimesSync(distPath, future, future);
    console.log(`  fixture dist mtime: ${future.toISOString()} (future)`);

    // Capture stderr to verify NO warning is emitted
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrLines.push(String(chunk));
      return origWrite(chunk, ...rest);
    };

    let result;
    try {
      result = resolveArmAEmit(fixtureRoot, "parse-int-list", "A-fine");
    } finally {
      process.stderr.write = origWrite;
    }

    strictEqual(
      result.source,
      "yakcc-compile",
      `expected source="yakcc-compile", got: ${result.source}`
    );
    strictEqual(
      result.emitPath,
      distPath,
      `expected emitPath to be the fixture dist path`
    );

    const warnText = stderrLines.join("");
    strictEqual(warnText, "", `stderr should be empty when dist is fresh, got: ${warnText.slice(0, 200)}`);

    console.log(`  [OK] source=${result.source}, emitPath=<dist path>`);
    console.log(`  [OK] stderr empty (guard did not fire)`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 12: freshness guard -- force-gold-standard bypasses guard even when dist is stale
//   GIVEN dist mtime older than bench fallback (backdated to epoch)
//   AND options.forceGoldStandard === true
//   THEN returns { source: "yakcc-compile", emitPath: <dist path> }
//   AND no warning is written to stderr
// ---------------------------------------------------------------------------

test("arm-a-emit: freshness guard -- force-gold-standard bypasses guard even when dist is stale", async () => {
  const { fixtureRoot, distPath, realBenchPath } = buildFixture("force-override");
  try {
    // Backdate dist to epoch -- would normally trigger the guard
    const epoch = new Date(0);
    utimesSync(distPath, epoch, epoch);
    console.log(`  fixture dist mtime: ${new Date(0).toISOString()} (epoch, would be stale)`);

    // Capture stderr to verify NO warning is emitted when forceGoldStandard=true
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrLines.push(String(chunk));
      return origWrite(chunk, ...rest);
    };

    let result;
    try {
      result = resolveArmAEmit(fixtureRoot, "parse-int-list", "A-fine", { forceGoldStandard: true });
    } finally {
      process.stderr.write = origWrite;
    }

    strictEqual(
      result.source,
      "yakcc-compile",
      `expected source="yakcc-compile" with forceGoldStandard, got: ${result.source}`
    );
    strictEqual(
      result.emitPath,
      distPath,
      `expected emitPath to be the fixture dist path (override active)`
    );

    const warnText = stderrLines.join("");
    strictEqual(warnText, "", `stderr should be empty with forceGoldStandard, got: ${warnText.slice(0, 200)}`);

    console.log(`  [OK] source=${result.source} (override active, no warning)`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 13: freshness guard -- CLI emits stderr WARN when guard fires (subprocess)
//   Uses the real dist file (stale if #697 not yet landed) OR a fixture via --repo-root.
//   Builds a fixture with a backdated dist, invokes the CLI with --repo-root pointing
//   at it, and asserts the WARN appears in stderr.
// ---------------------------------------------------------------------------

test("arm-a-emit: freshness guard -- CLI emits WARN to stderr when guard fires", () => {
  const { fixtureRoot, distPath, realBenchPath } = buildFixture("cli-warn");
  try {
    // Backdate dist to epoch so guard fires
    const epoch = new Date(0);
    utimesSync(distPath, epoch, epoch);

    const result = spawnSync(process.execPath, [
      join(BENCH_B9_ROOT, "harness", "arm-a-emit.mjs"),
      "--task", "parse-int-list",
      "--strategy", "A-fine",
      "--json",
      "--repo-root", fixtureRoot,
    ], {
      encoding: "utf8",
      timeout: 15_000,
      env: process.env,
    });

    if (result.error) throw result.error;
    // CLI should still exit 0 -- it returns a result even when the guard fires
    if (result.status !== 0) {
      throw new Error(`arm-a-emit CLI exited ${result.status}: ${result.stderr?.slice(0, 500)}`);
    }

    // stderr must contain the WARN
    const stderr = result.stderr ?? "";
    ok(stderr.includes("WARN"), `stderr should contain "WARN", got: ${stderr.slice(0, 300)}`);
    ok(stderr.includes("mtime"), `stderr should contain "mtime", got: ${stderr.slice(0, 300)}`);

    // stdout JSON should show source = bench-reference-stale-fallback
    let output;
    try {
      output = JSON.parse(result.stdout.trim());
    } catch (err) {
      throw new Error(`CLI output is not valid JSON: ${result.stdout.slice(0, 200)}`);
    }
    strictEqual(output.source, "bench-reference-stale-fallback",
      `expected source="bench-reference-stale-fallback" in JSON output, got: ${output.source}`);

    console.log(`  [OK] CLI WARN in stderr: ${stderr.trim().slice(0, 120)}`);
    console.log(`  [OK] CLI JSON source=${output.source}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});