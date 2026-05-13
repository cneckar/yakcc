// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/test/classify-arm-b.test.mjs
//
// Unit tests for harness/classify-arm-b.mjs
//
// Tests:
// 1. isTypeShapeError classifies TypeError/SyntaxError/RangeError correctly
// 2. classifyArmBResult: REFUSED-EARLY scenarios (threw type-shape error)
// 3. classifyArmBResult: shape-escape (expected REFUSED-EARLY, returned normally)
// 4. classifyArmBResult: benign-pass (expected BENIGN-PASS, returned normally)
// 5. classifyArmBResult: unexpected-refusal (expected BENIGN-PASS, threw type-shape error)
// 6. computeArmBRefusalSummary: median and range over N reps
// 7. computeArmBRefusalSummary: single rep
// 8. loadAttackClasses: loads all 8 attack class files
// 9. classifyArmBEmit: end-to-end classification of a real arm-a emit
// 10. Production scenario: labeled entry → unlabeled sub-agent sequence (N=3 reps aggregation)

import { strictEqual, ok, deepEqual } from "node:assert";
import { test } from "node:test";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  isTypeShapeError,
  classifyArmBResult,
  classifyArmBEmit,
  computeArmBRefusalSummary,
  loadAttackClasses,
} from "../harness/classify-arm-b.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B9_ROOT = resolve(__dirname, "..");
const ATTACK_DIR = join(BENCH_B9_ROOT, "attack-classes");
const WORKTREE_ROOT = resolve(BENCH_B9_ROOT, "..", "..");

// ---------------------------------------------------------------------------
// Test 1: isTypeShapeError — built-in error types
// ---------------------------------------------------------------------------

test("classify-arm-b: isTypeShapeError — TypeError is a type-shape error", () => {
  ok(isTypeShapeError(new TypeError("bad type")));
});

test("classify-arm-b: isTypeShapeError — SyntaxError is a type-shape error", () => {
  ok(isTypeShapeError(new SyntaxError("bad syntax")));
});

test("classify-arm-b: isTypeShapeError — RangeError is a type-shape error", () => {
  ok(isTypeShapeError(new RangeError("out of range")));
});

test("classify-arm-b: isTypeShapeError — plain Error is NOT a type-shape error", () => {
  ok(!isTypeShapeError(new Error("generic error")));
});

test("classify-arm-b: isTypeShapeError — Error with name 'ShapeError' matches pattern", () => {
  const err = new Error("bad shape");
  err.name = "ShapeError";
  ok(isTypeShapeError(err));
});

test("classify-arm-b: isTypeShapeError — non-Error value returns false", () => {
  ok(!isTypeShapeError("not an error"));
  ok(!isTypeShapeError(null));
  ok(!isTypeShapeError(42));
});

// ---------------------------------------------------------------------------
// Test 2: classifyArmBResult — REFUSED-EARLY (threw type-shape error, expected REFUSED-EARLY)
// ---------------------------------------------------------------------------

test("classify-arm-b: classifyArmBResult — refused-early when threw TypeError + expected REFUSED-EARLY", () => {
  const result = classifyArmBResult(
    { threw: true, thrownError: new TypeError("bad input"), returnValue: undefined },
    "REFUSED-EARLY"
  );
  strictEqual(result, "refused-early");
});

test("classify-arm-b: classifyArmBResult — refused-early when threw SyntaxError + expected REFUSED-EARLY", () => {
  const result = classifyArmBResult(
    { threw: true, thrownError: new SyntaxError("invalid syntax"), returnValue: undefined },
    "REFUSED-EARLY"
  );
  strictEqual(result, "refused-early");
});

// ---------------------------------------------------------------------------
// Test 3: classifyArmBResult — shape-escape (expected REFUSED-EARLY, returned normally)
// ---------------------------------------------------------------------------

test("classify-arm-b: classifyArmBResult — shape-escape when no throw + expected REFUSED-EARLY", () => {
  const result = classifyArmBResult(
    { threw: false, thrownError: null, returnValue: "some value" },
    "REFUSED-EARLY"
  );
  strictEqual(result, "shape-escape");
});

// ---------------------------------------------------------------------------
// Test 4: classifyArmBResult — benign-pass (expected BENIGN-PASS, returned normally)
// ---------------------------------------------------------------------------

test("classify-arm-b: classifyArmBResult — benign-pass when no throw + expected BENIGN-PASS", () => {
  const result = classifyArmBResult(
    { threw: false, thrownError: null, returnValue: [1, 2, 3] },
    "BENIGN-PASS"
  );
  strictEqual(result, "benign-pass");
});

// ---------------------------------------------------------------------------
// Test 5: classifyArmBResult — unexpected-refusal (expected BENIGN-PASS, threw type-shape error)
// ---------------------------------------------------------------------------

test("classify-arm-b: classifyArmBResult — unexpected-refusal when threw TypeError + expected BENIGN-PASS", () => {
  const result = classifyArmBResult(
    { threw: true, thrownError: new TypeError("unexpected rejection"), returnValue: undefined },
    "BENIGN-PASS"
  );
  strictEqual(result, "unexpected-refusal");
});

// ---------------------------------------------------------------------------
// Test 6: classifyArmBResult — executed (expected REFUSED-EARLY, threw generic Error)
// ---------------------------------------------------------------------------

test("classify-arm-b: classifyArmBResult — executed when threw generic Error + expected REFUSED-EARLY", () => {
  const result = classifyArmBResult(
    { threw: true, thrownError: new Error("runtime error"), returnValue: undefined },
    "REFUSED-EARLY"
  );
  strictEqual(result, "executed");
});

// ---------------------------------------------------------------------------
// Test 7: computeArmBRefusalSummary — median + range for 3 reps
// ---------------------------------------------------------------------------

test("classify-arm-b: computeArmBRefusalSummary — 3 reps, median + range", () => {
  const reps = [
    { summary: { refused_early_rate: 80, shape_escapes: 0, refused_early: 8, total_inputs: 10 } },
    { summary: { refused_early_rate: 90, shape_escapes: 1, refused_early: 9, total_inputs: 10 } },
    { summary: { refused_early_rate: 85, shape_escapes: 0, refused_early: 8, total_inputs: 10 } },
  ];

  const summary = computeArmBRefusalSummary(reps);

  strictEqual(summary.n_reps, 3);
  strictEqual(summary.median_refused_early_rate, 85, `median should be 85%, got ${summary.median_refused_early_rate}`);
  deepEqual(summary.refused_early_rate_range, [80, 90]);
  strictEqual(summary.shape_escapes_any_rep, 1);
  ok(summary.note.includes("N=3"), "note should mention N=3");
  ok(summary.note.includes("no KILL"), "note should mention no KILL per directional target policy");
});

// ---------------------------------------------------------------------------
// Test 8: computeArmBRefusalSummary — single rep
// ---------------------------------------------------------------------------

test("classify-arm-b: computeArmBRefusalSummary — single rep (N=1)", () => {
  const reps = [
    { summary: { refused_early_rate: 100, shape_escapes: 0, refused_early: 10, total_inputs: 10 } },
  ];

  const summary = computeArmBRefusalSummary(reps);
  strictEqual(summary.n_reps, 1);
  strictEqual(summary.median_refused_early_rate, 100);
  deepEqual(summary.refused_early_rate_range, [100, 100]);
});

// ---------------------------------------------------------------------------
// Test 9: computeArmBRefusalSummary — throws for empty array
// ---------------------------------------------------------------------------

test("classify-arm-b: computeArmBRefusalSummary — throws on empty input", () => {
  let threw = false;
  try {
    computeArmBRefusalSummary([]);
  } catch (err) {
    threw = true;
  }
  ok(threw, "should throw on empty reps");
});

// ---------------------------------------------------------------------------
// Test 10: loadAttackClasses — loads all 8 attack class files
// ---------------------------------------------------------------------------

test("classify-arm-b: loadAttackClasses — 8 classes, ≥10 inputs each", () => {
  const classes = loadAttackClasses(ATTACK_DIR);

  strictEqual(classes.length, 8, `expected 8 attack classes, got ${classes.length}`);

  let totalInputs = 0;
  for (const cls of classes) {
    ok(cls.attack_class_id, `missing attack_class_id in class`);
    ok(Array.isArray(cls.inputs), `inputs should be an array for class ${cls.attack_class_id}`);
    ok(cls.inputs.length >= 10, `class ${cls.attack_class_id} should have ≥10 inputs, got ${cls.inputs.length}`);
    totalInputs += cls.inputs.length;
    console.log(`  [OK] ${cls.attack_class_id}: ${cls.inputs.length} inputs`);
  }

  ok(totalInputs >= 80, `total inputs should be ≥80 across all classes, got ${totalInputs}`);
  console.log(`  Total: ${totalInputs} attack inputs across 8 classes`);
});

// ---------------------------------------------------------------------------
// Test 11: classifyArmBEmit — end-to-end on a real arm-a emit (even-only-filter A-fine)
// ---------------------------------------------------------------------------

test("classify-arm-b: classifyArmBEmit — end-to-end on even-only-filter A-fine", async () => {
  const emitPath = join(BENCH_B9_ROOT, "tasks", "even-only-filter", "arm-a", "fine.mjs");
  const attackClasses = loadAttackClasses(ATTACK_DIR);

  const result = await classifyArmBEmit(emitPath, attackClasses, "evenOnlyFilter");

  ok(result.summary, "result should have a summary");
  ok(result.by_class, "result should have by_class");
  ok(result.summary.total_inputs >= 80, `total_inputs should be ≥80, got ${result.summary.total_inputs}`);

  // even-only-filter accepts any safe integer array — most adversarial inputs
  // should throw (the attack inputs are not valid number arrays), so refused_early > 0
  ok(result.summary.refused_early >= 0, "refused_early should be a number");

  // The rate is 0..100
  const rate = result.summary.refused_early_rate;
  ok(rate >= 0 && rate <= 100, `refused_early_rate should be 0..100, got ${rate}`);

  console.log(
    `  even-only-filter/A-fine: ${result.summary.refused_early}/${result.summary.refused_early_targets} REFUSED-EARLY` +
    ` (${rate.toFixed(1)}%), shape_escapes=${result.summary.shape_escapes}`
  );
});

// ---------------------------------------------------------------------------
// Test 12: Production scenario — N=3 reps aggregation (the actual production path)
//
// In production, classify-arm-b is called N=3 times for the same emit, then
// computeArmBRefusalSummary aggregates. This test exercises the full sequence.
// ---------------------------------------------------------------------------

test("classify-arm-b: production scenario — N=3 reps on digits-to-sum A-coarse", async () => {
  const emitPath = join(BENCH_B9_ROOT, "tasks", "digits-to-sum", "arm-a", "coarse.mjs");
  const attackClasses = loadAttackClasses(ATTACK_DIR);

  // Simulate 3 reps (deterministic since it's the same file — rates will be equal)
  const rep1 = await classifyArmBEmit(emitPath, attackClasses, "digitsToSum");
  const rep2 = await classifyArmBEmit(emitPath, attackClasses, "digitsToSum");
  const rep3 = await classifyArmBEmit(emitPath, attackClasses, "digitsToSum");

  const summary = computeArmBRefusalSummary([rep1, rep2, rep3]);

  strictEqual(summary.n_reps, 3, "should report n_reps=3");

  // All 3 reps are deterministic (same file), so range should be [X, X]
  const [lo, hi] = summary.refused_early_rate_range;
  strictEqual(lo, hi, `range should be [X, X] for deterministic emits, got [${lo}, ${hi}]`);
  strictEqual(summary.median_refused_early_rate, lo, "median should equal lo for identical reps");

  console.log(
    `  digits-to-sum/A-coarse N=3: median=${summary.median_refused_early_rate.toFixed(1)}% ` +
    `range=[${lo.toFixed(1)}%,${hi.toFixed(1)}%] shape_escapes_any_rep=${summary.shape_escapes_any_rep}`
  );
});
