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
// Test 3: not-applicable — inapplicable class inputs are excluded from scoring
// Per DEC-B9-APPLICABILITY-001: fix for #515 false-positive shape_escapes
// ---------------------------------------------------------------------------

test("axis2: not-applicable — inapplicable class inputs excluded from shape_escapes", async (t) => {
  mkdirSync(SCRATCH_DIR, { recursive: true });

  // Emit that accepts EVERYTHING (would normally cause shape-escapes)
  const emitPath = join(SCRATCH_DIR, "emit-accepts-all.mjs");
  writeSyntheticMjs(emitPath, `
// Synthetic emit that accepts all inputs (no refusal) — simulates csv-row-narrow
// accepting JSON-array payloads because its grammar doesn't match JSON-arrays
export function parseCsvRow(input) {
  // Just return something — always accepts
  return ["field1", "field2", "field3"];
}
export default parseCsvRow;
`.trim());

  // Two attack classes: one applicable, one not
  const attackDir = join(SCRATCH_DIR, "attack-classes-applicability");
  mkdirSync(attackDir, { recursive: true });
  // applicable class — this should produce shape_escape since emit accepts everything
  writeAttackClassFixture(attackDir, "size-attack", [
    {
      label: "very-long-string",
      payload: "a".repeat(1000),
      expected_outcome: "REFUSED-EARLY",
      rationale: "Large input should be refused by a size-checking emit",
    },
  ]);
  // not-applicable class — JSON-array attack inapplicable to csv grammar
  writeAttackClassFixture(attackDir, "json-array-attack", [
    {
      label: "circular-ref-array",
      payload: "[1,[2,[3]]]",
      expected_outcome: "REFUSED-EARLY",
      rationale: "JSON-array attack inapplicable to CSV string grammar",
    },
    {
      label: "prototype-pollution-array",
      payload: '["__proto__","constructor"]',
      expected_outcome: "REFUSED-EARLY",
      rationale: "JSON-array prototype attack inapplicable to CSV string grammar",
    },
  ]);

  // Run with applicable-classes restricting to size-attack only
  const result = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "measure-axis2.mjs"),
    "--emit", emitPath,
    "--attack-classes", attackDir,
    "--entry", "parseCsvRow",
    "--applicable-classes", "size-attack",
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

  // json-array-attack is NOT applicable — all inputs should be not-applicable
  const jsonArrayResult = output.by_class["json-array-attack"];
  ok(jsonArrayResult !== undefined, "json-array-attack class should be in by_class for transparency");
  strictEqual(jsonArrayResult.applicable, false, "json-array-attack.applicable should be false");
  strictEqual(jsonArrayResult.not_applicable, 2, `json-array-attack should have 2 not-applicable inputs, got ${jsonArrayResult.not_applicable}`);
  strictEqual(jsonArrayResult.shape_escapes, 0, `json-array-attack should contribute 0 shape_escapes (not scored), got ${jsonArrayResult.shape_escapes}`);
  for (const inp of jsonArrayResult.inputs) {
    strictEqual(inp.classification, "not-applicable", `json-array-attack input '${inp.label}' should be classified not-applicable`);
  }

  // size-attack IS applicable — emit accepts it, so it's a shape-escape
  const sizeResult = output.by_class["size-attack"];
  ok(sizeResult !== undefined, "size-attack class should be in results");
  strictEqual(sizeResult.applicable, true, "size-attack.applicable should be true");
  strictEqual(sizeResult.shape_escapes, 1, `size-attack should produce 1 shape_escape (emit accepts when should refuse), got ${sizeResult.shape_escapes}`);

  // Summary: shape_escapes = 1 (only from applicable size-attack), not 3
  strictEqual(output.summary.shape_escapes, 1, `summary.shape_escapes should be 1 (not 3), got ${output.summary.shape_escapes}`);
  strictEqual(output.summary.not_applicable, 2, `summary.not_applicable should be 2, got ${output.summary.not_applicable}`);

  console.log(`  not-applicable test: summary.shape_escapes=${output.summary.shape_escapes} (expected 1) not_applicable=${output.summary.not_applicable} (expected 2)`);
});

// ---------------------------------------------------------------------------
// Test 4: compound production sequence — applicability filter + correct scoring end-to-end
// This is the compound-interaction test required by the implementer constitution.
// It exercises: corpus-spec applicable_attack_classes -> CLI --applicable-classes
// -> measureAxis2 applicableSet -> not-applicable classification -> summary exclusion
// ---------------------------------------------------------------------------

test("axis2: compound — applicable filter preserves genuine shape_escapes while excluding inapplicable", async (t) => {
  mkdirSync(SCRATCH_DIR, { recursive: true });

  // Emit that correctly refuses size attacks but silently accepts JSON-array attacks
  // (mirrors csv-row-narrow: refuses large strings, accepts JSON arrays it shouldn't)
  const emitPath = join(SCRATCH_DIR, "emit-csv-like.mjs");
  writeSyntheticMjs(emitPath, `
export function parseCsvRow(input) {
  if (typeof input !== 'string') throw new TypeError('Expected string');
  if (input.length > 100) throw new RangeError('Input too large');
  const parts = input.split(',');
  if (parts.length !== 3) throw new SyntaxError('Expected exactly 3 fields');
  return parts.map(p => p.trim());
}
export default parseCsvRow;
`.trim());

  const attackDir = join(SCRATCH_DIR, "attack-classes-compound");
  mkdirSync(attackDir, { recursive: true });

  // Applicable: size attack — large input should be refused, emit DOES refuse it -> refused-early
  writeAttackClassFixture(attackDir, "large-string-dos", [
    {
      label: "too-large-input",
      payload: "a".repeat(200) + "," + "b".repeat(200) + "," + "c".repeat(200),
      expected_outcome: "REFUSED-EARLY",
      rationale: "String exceeds 100 chars — should throw RangeError",
    },
  ]);

  // Not-applicable: circular-reference (JSON-array shaped) — emit incorrectly accepts
  // these (they split on comma producing wrong field count, but won't throw for valid ones)
  writeAttackClassFixture(attackDir, "circular-reference", [
    {
      label: "array-notation",
      payload: "[1,2,3]",
      expected_outcome: "REFUSED-EARLY",
      rationale: "JSON-array — inapplicable to CSV grammar; emit splits on commas and gets 3 fields",
    },
  ]);

  // Run with only large-string-dos as applicable
  const resultApplicable = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "measure-axis2.mjs"),
    "--emit", emitPath,
    "--attack-classes", attackDir,
    "--entry", "parseCsvRow",
    "--applicable-classes", "large-string-dos",
    "--json",
  ], { encoding: "utf8", timeout: 30_000, env: process.env });

  if (resultApplicable.error) throw resultApplicable.error;
  if (resultApplicable.status !== 0) {
    throw new Error(`measure-axis2 exited ${resultApplicable.status}: ${resultApplicable.stderr?.slice(0, 500)}`);
  }

  const withFilter = JSON.parse(resultApplicable.stdout.trim());

  // With filter: circular-reference is not-applicable, large-string is refused-early
  strictEqual(withFilter.by_class["circular-reference"].applicable, false, "circular-reference should be not-applicable");
  strictEqual(withFilter.by_class["circular-reference"].not_applicable, 1, "circular-reference should have 1 not-applicable input");
  strictEqual(withFilter.by_class["large-string-dos"].applicable, true, "large-string-dos should be applicable");
  strictEqual(withFilter.by_class["large-string-dos"].refused_early, 1, "large-string-dos input should be refused-early");
  strictEqual(withFilter.summary.shape_escapes, 0, `With filter: shape_escapes should be 0, got ${withFilter.summary.shape_escapes}`);
  strictEqual(withFilter.summary.refused_early, 1, `With filter: refused_early should be 1, got ${withFilter.summary.refused_early}`);

  // Run WITHOUT filter (all classes applicable) — should see shape_escape from circular-reference
  const resultNoFilter = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "measure-axis2.mjs"),
    "--emit", emitPath,
    "--attack-classes", attackDir,
    "--entry", "parseCsvRow",
    "--json",
  ], { encoding: "utf8", timeout: 30_000, env: process.env });

  if (resultNoFilter.error) throw resultNoFilter.error;
  if (resultNoFilter.status !== 0) {
    throw new Error(`measure-axis2 (no filter) exited ${resultNoFilter.status}: ${resultNoFilter.stderr?.slice(0, 500)}`);
  }

  const withoutFilter = JSON.parse(resultNoFilter.stdout.trim());

  // Without filter: circular-reference "[1,2,3]" is accepted by parseCsvRow (splits to 3 fields)
  // -> expected REFUSED-EARLY but no throw -> shape-escape
  strictEqual(withoutFilter.by_class["circular-reference"].applicable, true, "Without filter: circular-reference applicable=true");
  strictEqual(withoutFilter.by_class["circular-reference"].shape_escapes, 1, `Without filter: circular-reference should have 1 shape_escape`);
  strictEqual(withoutFilter.summary.shape_escapes, 1, `Without filter: summary.shape_escapes=1`);
  strictEqual(withoutFilter.summary.not_applicable, 0, `Without filter: not_applicable=0`);

  console.log(`  compound test: with-filter shape_escapes=${withFilter.summary.shape_escapes} (expected 0), without-filter shape_escapes=${withoutFilter.summary.shape_escapes} (expected 1)`);
});

// ---------------------------------------------------------------------------
// Test 5: backwards-compat — absent applicable_attack_classes = all classes scored
// ---------------------------------------------------------------------------

test("axis2: backwards-compat — absent applicable_attack_classes applies all classes", async (t) => {
  mkdirSync(SCRATCH_DIR, { recursive: true });

  const emitPath = join(SCRATCH_DIR, "emit-refuses-all-syntax.mjs");
  writeSyntheticMjs(emitPath, `
export function listOfInts(input) {
  if (!input.startsWith('[')) throw new SyntaxError('Expected [');
  return [];
}
export default listOfInts;
`.trim());

  const attackDir = join(SCRATCH_DIR, "attack-classes-compat");
  mkdirSync(attackDir, { recursive: true });
  writeAttackClassFixture(attackDir, "class-a", [
    { label: "non-list", payload: "not-a-list", expected_outcome: "REFUSED-EARLY", rationale: "No bracket" },
  ]);
  writeAttackClassFixture(attackDir, "class-b", [
    { label: "another", payload: "{\"x\":1}", expected_outcome: "REFUSED-EARLY", rationale: "Object shape" },
  ]);

  // No --applicable-classes flag — all classes should be scored
  const result = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "measure-axis2.mjs"),
    "--emit", emitPath,
    "--attack-classes", attackDir,
    "--entry", "listOfInts",
    "--json",
  ], { encoding: "utf8", timeout: 30_000, env: process.env });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`measure-axis2 exited ${result.status}: ${result.stderr?.slice(0, 500)}`);

  const output = JSON.parse(result.stdout.trim());

  // Both classes should be applicable (default = all)
  strictEqual(output.by_class["class-a"].applicable, true, "class-a should be applicable by default");
  strictEqual(output.by_class["class-b"].applicable, true, "class-b should be applicable by default");
  strictEqual(output.summary.not_applicable, 0, "no not-applicable inputs when no filter");
  strictEqual(output.summary.refused_early, 2, "both inputs should be refused-early");

  console.log(`  backwards-compat test: not_applicable=${output.summary.not_applicable} (expected 0) refused_early=${output.summary.refused_early} (expected 2)`);
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
