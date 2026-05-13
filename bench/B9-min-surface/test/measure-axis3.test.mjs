// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/test/measure-axis3.test.mjs
//
// Smoke test for harness/measure-axis3.mjs
//
// Per eval-wi-b9-slice1.json test_expectations:
// "test/measure-axis3.test.mjs — feed two emits that produce byte-identical output
//  on '[1,2,3]'; assert byte-equivalence pass. Feed a divergent pair; assert fail."

import { strictEqual, ok } from "node:assert";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B9_ROOT = resolve(__dirname, "..");
const SCRATCH_DIR = join(BENCH_B9_ROOT, "..", "..", "tmp", "B9-min-surface", "test-scratch");

// ---------------------------------------------------------------------------
// Helper: write synthetic .mjs emit
// ---------------------------------------------------------------------------

function writeSyntheticMjs(filePath, code) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, code, "utf8");
}

// ---------------------------------------------------------------------------
// Test 1: byte-identical pair → equivalence PASS
// ---------------------------------------------------------------------------

test("axis3: byte-equivalence PASS on identical emits", async (t) => {
  mkdirSync(SCRATCH_DIR, { recursive: true });

  // Two identical implementations
  const impl = `
export function listOfInts(input) {
  if (!input.startsWith('[')) throw new SyntaxError('Expected [');
  if (!input.endsWith(']')) throw new SyntaxError('Expected ]');
  const inner = input.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(s => {
    const n = parseInt(s.trim(), 10);
    if (isNaN(n) || n < 0) throw new SyntaxError('Not a non-negative integer: ' + s);
    return n;
  });
}
export default listOfInts;
`.trim();

  const emitAPath = join(SCRATCH_DIR, "emit-a-identical.mjs");
  const emitBPath = join(SCRATCH_DIR, "emit-b-identical.mjs");
  writeSyntheticMjs(emitAPath, impl);
  writeSyntheticMjs(emitBPath, impl);

  const result = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "measure-axis3.mjs"),
    "--emit-a", emitAPath,
    "--emit-b", emitBPath,
    "--entry", "listOfInts",
    "--count", "25",
    "--seed", "42",
    "--json",
  ], {
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`measure-axis3 exited ${result.status}: ${result.stderr?.slice(0, 500)}`);
  }

  const output = JSON.parse(result.stdout.trim());

  strictEqual(output.divergent, 0, `should have 0 divergent, got ${output.divergent}`);
  strictEqual(output.equivalence_rate, 100, `equivalence_rate should be 100%, got ${output.equivalence_rate}`);
  ok(output.pass === true, "pass should be true for identical emits");
  ok(output.total >= 20, `corpus_size should be >= 20, got ${output.total}`);

  console.log(`  equivalence PASS: ${output.equivalent}/${output.total} (${output.equivalence_rate}%) pass=${output.pass}`);
});

// ---------------------------------------------------------------------------
// Test 2: divergent pair → equivalence FAIL
// Per eval contract: "Feed a divergent pair; assert fail."
// The divergent pair returns different results for valid inputs.
// ---------------------------------------------------------------------------

test("axis3: divergence FAIL on divergent emits", async (t) => {
  mkdirSync(SCRATCH_DIR, { recursive: true });

  // Arm A: correct implementation — returns number[]
  const implA = `
export function listOfInts(input) {
  if (!input.startsWith('[')) throw new SyntaxError('Expected [');
  if (!input.endsWith(']')) throw new SyntaxError('Expected ]');
  const inner = input.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(s => {
    const n = parseInt(s.trim(), 10);
    if (isNaN(n) || n < 0) throw new SyntaxError('Not a non-negative integer: ' + s);
    return n;
  });
}
export default listOfInts;
`.trim();

  // Arm B: different implementation — doubles each number (deliberately wrong)
  const implB = `
export function listOfInts(input) {
  if (!input.startsWith('[')) throw new SyntaxError('Expected [');
  if (!input.endsWith(']')) throw new SyntaxError('Expected ]');
  const inner = input.slice(1, -1).trim();
  if (!inner) return [];
  // BUG: doubles each number — produces different output
  return inner.split(',').map(s => {
    const n = parseInt(s.trim(), 10);
    if (isNaN(n) || n < 0) throw new SyntaxError('Not a non-negative integer: ' + s);
    return n * 2; // DIVERGES FROM SPEC
  });
}
export default listOfInts;
`.trim();

  const emitAPath = join(SCRATCH_DIR, "emit-a-divergent.mjs");
  const emitBPath = join(SCRATCH_DIR, "emit-b-divergent.mjs");
  writeSyntheticMjs(emitAPath, implA);
  writeSyntheticMjs(emitBPath, implB);

  const result = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "measure-axis3.mjs"),
    "--emit-a", emitAPath,
    "--emit-b", emitBPath,
    "--entry", "listOfInts",
    "--count", "25",
    "--seed", "42",
    "--json",
  ], {
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`measure-axis3 exited ${result.status}: ${result.stderr?.slice(0, 500)}`);
  }

  const output = JSON.parse(result.stdout.trim());

  // For non-empty lists, the doubled implementation diverges
  // Empty list [] is an edge case where both return [] — but non-empty lists diverge
  ok(output.divergent > 0, `should have > 0 divergent cases for doubled implementation, got ${output.divergent}`);
  ok(output.pass === false, `pass should be false for divergent emits`);
  ok(output.equivalence_rate < 100, `equivalence_rate should be < 100%, got ${output.equivalence_rate}`);

  console.log(`  divergent FAIL: divergent=${output.divergent}/${output.total} equivalence_rate=${output.equivalence_rate.toFixed(1)}% pass=${output.pass}`);
});

// ---------------------------------------------------------------------------
// Test 3: corpus spec sha256 is verifiable
// ---------------------------------------------------------------------------

test("axis3: corpus-spec.json sha256 is parseable and fingerprints are present", async (t) => {
  const specPath = join(BENCH_B9_ROOT, "corpus-spec.json");
  const { existsSync, readFileSync } = await import("node:fs");

  ok(existsSync(specPath), `corpus-spec.json should exist at ${specPath}`);

  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  ok(Array.isArray(spec.tasks), "spec.tasks should be an array");
  ok(spec.tasks.length > 0, "spec.tasks should have at least one task");

  const task = spec.tasks[0];
  ok(typeof task.spec_sha256_lf === "string" && task.spec_sha256_lf.length === 64, "spec_sha256_lf should be 64-char hex string");
  ok(typeof task.arm_b_prompt.prompt_sha256 === "string" && task.arm_b_prompt.prompt_sha256.length === 64, "prompt_sha256 should be 64-char hex string");

  console.log(`  corpus-spec: task=${task.id} spec_sha256=${task.spec_sha256_lf.slice(0, 16)}... prompt_sha256=${task.arm_b_prompt.prompt_sha256.slice(0, 16)}...`);
});
