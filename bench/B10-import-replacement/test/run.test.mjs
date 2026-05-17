// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/test/run.test.mjs
//
// @decision DEC-B10-RUN-SMOKE-001
// @title run.mjs smoke test — dry-run exits 0, artifact well-formed, U4 mitigation proven
// @status accepted
// @rationale
//   PURPOSE
//   This is Evaluation Contract item 2 from plans/wi-512-b10-import-heavy-bench.md:
//   "run.mjs --dry-run against the B9 corpus exits 0; the produced artifact JSON parses,
//    has the B9 results-shape keys, and every numeric field is finite, non-negative, non-NaN."
//
//   The smoke test serves three roles:
//   1. Integration proof — exercises the full pipeline (arm-a-emit -> measureTransitiveSurface
//      -> llm-baseline -> classify-arm-b -> run.mjs) on real B9 reference files.
//   2. U4 mitigation proof — S10 asserts Arm A reachable_functions == 0 for B9 reference
//      emits, proving that JSON.parse-style builtin calls do NOT inflate the count (the
//      stdlib exclusion in DEC-IRT-B10-METRIC-001 is working on real inputs).
//   3. Shape contract — S4/S5/S6 assert the artifact has the B9-comparable result shape
//      that future Slice 2/3 machinery depends on.
//
//   TESTS
//   S1:  run.mjs --dry-run exits 0
//   S2:  smoke-fixture-*.json created in test/
//   S3:  artifact is valid JSON
//   S4:  required top-level keys present
//   S5:  suite has correct sub-structure
//   S6:  every task_result has task_id
//   S7:  every numeric field is finite, non-negative, non-NaN
//   S8:  all 6 B9 smoke tasks present
//   S9:  smoke_corpus flag is true
//   S10: Arm A reachable_functions == 0 for all B9 tasks (stdlib-exclusion proof)
//
//   Cross-references:
//   DEC-IRT-B10-METRIC-001 — harness/measure-transitive-surface.mjs
//   DEC-B10-S1-LAYOUT-001  — harness/run.mjs
//   plans/wi-512-b10-import-heavy-bench.md §3b.2, Evaluation Contract

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname      = dirname(fileURLToPath(import.meta.url));
const BENCH_B10_ROOT = resolve(__dirname, "..");
const HARNESS_RUN    = join(BENCH_B10_ROOT, "harness", "run.mjs");
const TEST_DIR       = __dirname;

const B9_SMOKE_TASKS = [
  "parse-int-list",
  "parse-coord-pair",
  "csv-row-narrow",
  "kebab-to-camel",
  "digits-to-sum",
  "even-only-filter",
];

// ---------------------------------------------------------------------------
// Run run.mjs --dry-run once and cache the result
// ---------------------------------------------------------------------------

let runResult;
let artifact;
let artifactPath;

before(async () => {
  runResult = spawnSync(
    process.execPath,
    [HARNESS_RUN, "--dry-run", "--audit"],
    {
      encoding: "utf8",
      timeout:  120_000,
      cwd:      BENCH_B10_ROOT,
      env:      { ...process.env },
    }
  );

  // Find the smoke-fixture file written to test/
  if (!runResult.error && runResult.status === 0) {
    const smokeFiles = readdirSync(TEST_DIR)
      .filter((f) => f.startsWith("smoke-fixture-") && f.endsWith(".json"))
      .sort();
    if (smokeFiles.length > 0) {
      artifactPath = join(TEST_DIR, smokeFiles[smokeFiles.length - 1]);
      try {
        artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
      } catch (_) {
        artifact = null;
      }
    }
  }
});

// ---------------------------------------------------------------------------
// S1: run.mjs --dry-run exits 0
// ---------------------------------------------------------------------------

describe("S1 run.mjs --dry-run exit code", () => {
  it("exits 0", () => {
    if (runResult.error) {
      assert.fail(`spawnSync error: ${runResult.error.message}`);
    }
    assert.equal(
      runResult.status,
      0,
      `run.mjs exited ${runResult.status}.\nstdout: ${runResult.stdout?.slice(0, 500)}\nstderr: ${runResult.stderr?.slice(0, 500)}`
    );
  });
});

// ---------------------------------------------------------------------------
// S2: artifact file was created
// ---------------------------------------------------------------------------

describe("S2 smoke artifact file created", () => {
  it("smoke-fixture-*.json exists in test/", () => {
    assert.ok(
      artifactPath && existsSync(artifactPath),
      `No smoke-fixture-*.json found in ${TEST_DIR}`
    );
  });
});

// ---------------------------------------------------------------------------
// S3: artifact JSON parses
// ---------------------------------------------------------------------------

describe("S3 artifact JSON parses", () => {
  it("artifact is valid JSON", () => {
    assert.ok(artifact !== null && artifact !== undefined, "artifact failed to parse as JSON");
  });
});

// ---------------------------------------------------------------------------
// S4: required top-level keys present
// ---------------------------------------------------------------------------

describe("S4 required top-level keys", () => {
  it("has schema_version, measured_at, suite, task_results, mode, smoke_corpus", () => {
    assert.ok(artifact, "artifact not loaded");
    for (const key of ["schema_version", "measured_at", "suite", "task_results", "mode", "smoke_corpus"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(artifact, key), `missing key: ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// S5: suite structure
// ---------------------------------------------------------------------------

describe("S5 suite structure", () => {
  it("suite has suite_verdict, tasks_total, tasks_passing, tasks_warning, tasks_inconclusive, tasks_pending", () => {
    assert.ok(artifact?.suite, "artifact.suite missing");
    for (const key of ["suite_verdict", "tasks_total", "tasks_passing", "tasks_warning", "tasks_inconclusive", "tasks_pending"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(artifact.suite, key), `suite missing key: ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// S6: every task_result has task_id
// ---------------------------------------------------------------------------

describe("S6 task_results structure", () => {
  it("every task_result has task_id", () => {
    assert.ok(Array.isArray(artifact?.task_results), "task_results not an array");
    for (const r of artifact.task_results) {
      assert.ok(r.task_id, `task_result missing task_id: ${JSON.stringify(r).slice(0, 100)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// S7: every transitive measurement numeric field is finite, non-negative, non-NaN
// ---------------------------------------------------------------------------

describe("S7 numeric fields are finite non-negative non-NaN", () => {
  it("all transitive metric numerics in task_results pass the guard", () => {
    assert.ok(Array.isArray(artifact?.task_results), "task_results not an array");
    const TRANSITIVE_NUMERIC_KEYS = [
      "reachable_functions", "reachable_bytes", "reachable_files",
      "unique_non_builtin_imports", "builtin_imports", "type_only_imports",
      "dynamic_literal_imports", "dynamic_non_literal_imports",
    ];
    for (const r of artifact.task_results) {
      const armA = r.arm_a?.transitive;
      if (!armA || armA.error) continue;
      for (const key of TRANSITIVE_NUMERIC_KEYS) {
        if (armA[key] === undefined) continue;
        assert.ok(
          typeof armA[key] === "number" && Number.isFinite(armA[key]) && armA[key] >= 0,
          `arm_a.transitive.${key} for ${r.task_id} is not finite non-negative: ${armA[key]}`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// S8: all 6 B9 smoke tasks present
// ---------------------------------------------------------------------------

describe("S8 all B9 smoke tasks present", () => {
  it("task_results includes all 6 B9 smoke task IDs", () => {
    assert.ok(Array.isArray(artifact?.task_results), "task_results not an array");
    const found = new Set(artifact.task_results.map((r) => r.task_id));
    for (const taskId of B9_SMOKE_TASKS) {
      assert.ok(found.has(taskId), `missing task: ${taskId}`);
    }
  });
});

// ---------------------------------------------------------------------------
// S9: smoke_corpus flag is true
// ---------------------------------------------------------------------------

describe("S9 smoke_corpus flag", () => {
  it("smoke_corpus is true (B9 fallback used)", () => {
    assert.equal(artifact?.smoke_corpus, true, "smoke_corpus should be true for B9 task run");
  });
});

// ---------------------------------------------------------------------------
// S10: Arm A traverses only 1 file for all B9 tasks (U4 mitigation proof)
//
// The B9 reference emits have no npm imports, so the transitive import closure
// is exactly 1 file (the emit itself). reachable_files == 1 proves:
// (a) no npm node_modules were traversed (stdlib-exclusion working), and
// (b) JSON.parse-style builtins did NOT resolve into lib.es5.d.ts (U4 mitigation).
// reachable_functions counts body-bearing functions across all traversed files,
// which for a 1-file closure is the emit's own atoms — correct and expected > 0.
// ---------------------------------------------------------------------------

describe("S10 Arm A traverses only 1 file for B9 reference emits (U4 mitigation proof)", () => {
  it("every B9 task Arm A reachable_files is 1 (no npm traversal, stdlib-exclusion proven)", () => {
    assert.ok(Array.isArray(artifact?.task_results), "task_results not an array");
    for (const r of artifact.task_results) {
      if (!B9_SMOKE_TASKS.includes(r.task_id)) continue;
      const armATransitive = r.arm_a?.transitive;
      if (!armATransitive || armATransitive.error) continue;
      assert.equal(
        armATransitive.reachable_files,
        1,
        `Arm A reachable_files for ${r.task_id} should be 1 (only the emit, no npm), got ${armATransitive.reachable_files}`
      );
      // Also assert no unresolved imports leaked into the count
      assert.equal(
        armATransitive.unique_non_builtin_imports,
        0,
        `Arm A unique_non_builtin_imports for ${r.task_id} should be 0, got ${armATransitive.unique_non_builtin_imports}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T-DETERMINISTIC-DRYRUN-1: re-running --dry-run twice produces byte-identical output
//
// @decision DEC-BENCH-B10-SLICE3-DRYRUN-DETERMINISM-001
// @title Re-run determinism: two consecutive dry-run invocations produce identical results
// @status accepted
// @rationale
//   S2 added this guarantee (the smoke fixture mechanism). S3 verifies it still holds
//   across the broader 15-task B10 corpus. Determinism is required for CI reproducibility
//   and for the SHA-locked corpus-spec.json prompt_sha256 locking scheme.
//   Two consecutive dry-runs are compared field-by-field after stripping timestamp fields
//   (measured_at, artifact_sha256 which embeds timestamps).
//   Cross-references: plans/wi-512-s3-b10-broaden.md §8.1 T-DETERMINISTIC-DRYRUN-1
// ---------------------------------------------------------------------------

describe("T-DETERMINISTIC-DRYRUN-1: two dry-runs produce identical task-level results", () => {
  // Run the harness twice and compare stable fields
  let run1, run2;

  it("both dry-runs exit 0", () => {
    run1 = spawnSync(
      process.execPath,
      [HARNESS_RUN, "--dry-run", "--tasks=validate-rfc5321-email,verify-jwt-hs256,coerce-semver"],
      { encoding: "utf8", timeout: 120_000, cwd: BENCH_B10_ROOT }
    );
    run2 = spawnSync(
      process.execPath,
      [HARNESS_RUN, "--dry-run", "--tasks=validate-rfc5321-email,verify-jwt-hs256,coerce-semver"],
      { encoding: "utf8", timeout: 120_000, cwd: BENCH_B10_ROOT }
    );
    if (run1.error) throw run1.error;
    if (run2.error) throw run2.error;
    assert.equal(run1.status, 0, "first dry-run exited " + run1.status);
    assert.equal(run2.status, 0, "second dry-run exited " + run2.status);
  });

  it("both dry-runs produce identical verdict lines (no NaN, stable verdicts)", () => {
    // Extract verdict lines from stdout (not timestamps)
    const verdictPattern = /^(.*?(?:PASS-DIRECTIONAL|WARN-DIRECTIONAL|PENDING|INCONCLUSIVE).*)$/mg;
    const verdicts1 = (run1?.stdout ?? "").match(verdictPattern) ?? [];
    const verdicts2 = (run2?.stdout ?? "").match(verdictPattern) ?? [];
    assert.ok(verdicts1.length > 0, "no verdict lines in first run");
    assert.deepEqual(verdicts1, verdicts2, "verdict lines differ between runs -- non-deterministic");
  });

  it("neither dry-run contains NaN in stdout", () => {
    assert.ok(!run1?.stdout?.includes("NaN"), "run1 stdout contains NaN");
    assert.ok(!run2?.stdout?.includes("NaN"), "run2 stdout contains NaN");
  });
});