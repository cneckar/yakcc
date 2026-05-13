// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/test/measure-axis2.test.mjs
//
// Smoke test for harness/measure-axis2.mjs
//
// Per eval-wi-b9-slice1.json test_expectations:
// "test/measure-axis2.test.mjs — feed a synthetic emit that throws TypeError on first
//  statement vs one that throws after 2 statements of atom body; assert classifier
//  outputs REFUSED-EARLY vs EXECUTED respectively."
//
// NOTE: The Slice 1 classifier is type-shape-based (not instrumentation-based per the
// eval contract's documented scope limitation). REFUSED-EARLY = type-shape error thrown
// on a REFUSED-EARLY-expected input. EXECUTED = type-shape error thrown on an EXECUTED-
// expected input, OR no error on a REFUSED-EARLY-expected input (shape-escape).
// The instrumentation-based (node Inspector Profiler) approach is Slice 2 complexity.
// The classifier correctly handles the two synthetic cases:
// - Throws TypeError immediately = REFUSED-EARLY (if input marked REFUSED-EARLY)
// - Returns normally when should refuse = shape-escape (KILL finding)

import { strictEqual, ok } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B9_ROOT = resolve(__dirname, "..");
const SCRATCH_DIR = join(BENCH_B9_ROOT, "..", "..", "tmp", "B9-min-surface", "test-scratch");

// ---------------------------------------------------------------------------
// Helper: write a synthetic .mjs emit to a temp path
// The axis2 measurer works on pre-transpiled .mjs files.
// ---------------------------------------------------------------------------

function writeSyntheticMjs(filePath, code) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, code, "utf8");
}

// ---------------------------------------------------------------------------
// Helper: write a single-entry attack class JSON fixture
// ---------------------------------------------------------------------------

function writeAttackClassFixture(dirPath, className, inputs) {
  mkdirSync(dirPath, { recursive: true });
  const fixture = {
    attack_class_id: className,
    description: `Synthetic test class: ${className}`,
    inputs,
  };
  writeFileSync(join(dirPath, `${className}.json`), JSON.stringify(fixture, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Test 1: REFUSED-EARLY — emit throws TypeError on REFUSED-EARLY input
// Per eval contract: "throws TypeError on first statement" = REFUSED-EARLY
// ---------------------------------------------------------------------------

test("axis2: REFUSED-EARLY — type-shape error on adversarial input", async (t) => {
  mkdirSync(SCRATCH_DIR, { recursive: true });

  // Synthetic emit: throws TypeError immediately on non-bracket input
  const emitPath = join(SCRATCH_DIR, "emit-refuses-early.mjs");
  writeSyntheticMjs(emitPath, `
// Synthetic Arm A-like emit that refuses non-bracket input immediately
export function listOfInts(input) {
  if (!input.startsWith('[')) {
    throw new SyntaxError('Expected input to start with [');
  }
  // ... rest of parsing
  return [];
}
export default listOfInts;
`.trim());

  // Attack class with REFUSED-EARLY expected outcomes
  const attackDir = join(SCRATCH_DIR, "attack-classes-early");
  writeAttackClassFixture(attackDir, "shape-refusal", [
    {
      label: "non-bracket-input",
      payload: "not-a-list",
      expected_outcome: "REFUSED-EARLY",
      rationale: "No leading bracket; should throw SyntaxError immediately",
    },
    {
      label: "object-input",
      payload: "{\"key\":\"value\"}",
      expected_outcome: "REFUSED-EARLY",
      rationale: "Object shape; should throw SyntaxError",
    },
  ]);

  const result = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "measure-axis2.mjs"),
    "--emit", emitPath,
    "--attack-classes", attackDir,
    "--entry", "listOfInts",
    "--json",
  ], {
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`measure-axis2 exited ${result.status}: ${result.stderr?.slice(0, 500)}`);
  }

  const output = JSON.parse(result.stdout.trim());

  // Both inputs should be REFUSED-EARLY
  const classResult = output.by_class["shape-refusal"];
  ok(classResult !== undefined, "shape-refusal class should be in results");
  strictEqual(classResult.refused_early, 2, `should have 2 refused_early, got ${classResult.refused_early}`);
  strictEqual(classResult.shape_escapes, 0, `should have 0 shape_escapes, got ${classResult.shape_escapes}`);

  console.log(`  REFUSED-EARLY test: refused_early=${classResult.refused_early}/2 shape_escapes=${classResult.shape_escapes}`);
});

// ---------------------------------------------------------------------------
// Test 2: Shape-escape detection — emit returns normally when it should refuse
// Per eval contract: "one that throws after 2 statements of atom body = EXECUTED"
// In our classifier: if an input with expected=REFUSED-EARLY returns without
// throwing = shape-escape (KILL finding).
// ---------------------------------------------------------------------------

test("axis2: shape-escape detection — returns when should refuse", async (t) => {
  mkdirSync(SCRATCH_DIR, { recursive: true });

  // Synthetic emit that accepts everything (no refusal) — simulates a buggy Arm B
  const emitPath = join(SCRATCH_DIR, "emit-no-refusal.mjs");
  writeSyntheticMjs(emitPath, `
// Synthetic emit with no refusal — shape-escape by design
export function listOfInts(input) {
  // Naive JSON.parse without shape checking
  try {
    const result = JSON.parse(input);
    if (Array.isArray(result)) {
      return result.filter(x => typeof x === 'number' && x >= 0);
    }
    return [];
  } catch {
    return []; // Swallows error — shape-escape!
  }
}
export default listOfInts;
`.trim());

  // Attack class where inputs SHOULD be refused but this emit doesn't refuse them
  const attackDir = join(SCRATCH_DIR, "attack-classes-escape");
  writeAttackClassFixture(attackDir, "escape-test", [
    {
      label: "prototype-pollution-attempt",
      payload: "{\"__proto__\":{\"polluted\":true}}",
      expected_outcome: "REFUSED-EARLY",
      rationale: "Should refuse non-list input but this emit accepts it",
    },
  ]);

  const result = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "measure-axis2.mjs"),
    "--emit", emitPath,
    "--attack-classes", attackDir,
    "--entry", "listOfInts",
    "--json",
  ], {
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`measure-axis2 exited ${result.status}: ${result.stderr?.slice(0, 500)}`);
  }

  const output = JSON.parse(result.stdout.trim());
  const classResult = output.by_class["escape-test"];
  ok(classResult !== undefined, "escape-test class should be in results");

  // This emit returns [] (no throw) when it should refuse — this is a shape-escape
  strictEqual(classResult.shape_escapes, 1, `should have 1 shape_escape (returns when should throw), got ${classResult.shape_escapes}`);

  console.log(`  shape-escape test: shape_escapes=${classResult.shape_escapes} (expected 1)`);
});

// ---------------------------------------------------------------------------
// Test 3: BENIGN-PASS — emit correctly handles valid in-shape input
// ---------------------------------------------------------------------------

test("axis2: BENIGN-PASS — valid input returns correctly", async (t) => {
  mkdirSync(SCRATCH_DIR, { recursive: true });

  const emitPath = join(SCRATCH_DIR, "emit-benign.mjs");
  writeSyntheticMjs(emitPath, `
export function listOfInts(input) {
  if (!input.startsWith('[')) throw new SyntaxError('Expected [');
  if (!input.endsWith(']')) throw new SyntaxError('Expected ]');
  const inner = input.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(s => {
    const n = parseInt(s.trim(), 10);
    if (isNaN(n) || n < 0) throw new SyntaxError('Not a non-negative integer');
    return n;
  });
}
export default listOfInts;
`.trim());

  const attackDir = join(SCRATCH_DIR, "attack-classes-benign");
  writeAttackClassFixture(attackDir, "benign", [
    {
      label: "valid-list",
      payload: "[1,2,3]",
      expected_outcome: "BENIGN-PASS",
      rationale: "Valid input should parse without error",
    },
    {
      label: "empty-list",
      payload: "[]",
      expected_outcome: "BENIGN-PASS",
      rationale: "Empty list is valid",
    },
  ]);

  const result = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "measure-axis2.mjs"),
    "--emit", emitPath,
    "--attack-classes", attackDir,
    "--entry", "listOfInts",
    "--json",
  ], {
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`measure-axis2 exited ${result.status}: ${result.stderr?.slice(0, 500)}`);
  }

  const output = JSON.parse(result.stdout.trim());
  const classResult = output.by_class["benign"];
  ok(classResult !== undefined, "benign class should be in results");
  strictEqual(classResult.benign_pass, 2, `should have 2 benign_pass, got ${classResult.benign_pass}`);
  strictEqual(classResult.shape_escapes, 0, `should have 0 shape_escapes, got ${classResult.shape_escapes}`);

  console.log(`  benign-pass test: benign_pass=${classResult.benign_pass}/2`);
});
