// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/test/classify-arm-b.test.mjs
//
// T-CLASSIFIER-1: Verify classify-arm-b.mjs handles both dry-run cases correctly.
//
// @decision DEC-BENCH-B10-SLICE2-CLASSIFIER-DRYRUN-001
// @title Classifier unit tests proving both PENDING and PASS-DIRECTIONAL dry-run behaviors
// @status accepted
// @rationale
//   Tests that:
//   1. Zero-import dry-run (B9 smoke corpus behavior) still returns PENDING -- unchanged.
//   2. Import-heavy dry-run (B10 Slice 2 validate-rfc5321-email) returns PASS-DIRECTIONAL
//      when the measured reduction meets the 90% threshold.
//   These two assertions together prove DEC-BENCH-B10-SLICE2-CLASSIFIER-DRYRUN-001 is
//   correctly implemented without regressing the B9 smoke path.
//   Cross-references: plans/wi-512-s2-b10-demo-task.md S5.3, S6.1 T-CLASSIFIER-1

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname      = dirname(fileURLToPath(import.meta.url));
const BENCH_B10_ROOT = resolve(__dirname, "..");

async function loadClassifier() {
  const p = join(BENCH_B10_ROOT, "harness", "classify-arm-b.mjs");
  return import(pathToFileURL(p).href);
}

// ---------------------------------------------------------------------------
// T-CLASSIFIER-1a: Zero-import dry-run returns PENDING (B9 smoke corpus behavior)
// ---------------------------------------------------------------------------

describe("T-CLASSIFIER-1a: dry-run with zero Arm B import surface returns PENDING", async () => {
  const { classifyArmB } = await loadClassifier();

  const armAResult = { reachable_functions: 5, reachable_bytes: 400, reachable_files: 1 };
  const armBReps   = [{ reachable_functions: 0, reachable_bytes: 0, reachable_files: 1 }];

  const result = classifyArmB({
    taskId:     "parse-int-list",
    armAResult,
    armBReps,
    dryRun:     true,
  });

  it("verdict is PENDING for zero-import dry-run", () => {
    assert.strictEqual(
      result.verdict,
      "PENDING",
      `Expected PENDING for zero-import dry-run, got: ${result.verdict} (reason: ${result.reason})`
    );
  });

  it("dry_run flag is true in result", () => {
    assert.strictEqual(result.dry_run, true);
  });

  it("reason mentions dry-run and zero import surface", () => {
    assert.ok(
      result.reason.toLowerCase().includes("dry-run"),
      `Expected reason to mention 'dry-run', got: ${result.reason}`
    );
  });
});

// ---------------------------------------------------------------------------
// T-CLASSIFIER-1b: Import-heavy dry-run returns PASS-DIRECTIONAL when >= 90% reduction
// ---------------------------------------------------------------------------

describe("T-CLASSIFIER-1b: dry-run with import-heavy fixture returns PASS-DIRECTIONAL", async () => {
  const { classifyArmB } = await loadClassifier();

  // Arm A: zero npm imports (atom-composed yakcc reference)
  const armAResult = { reachable_functions: 8, reachable_bytes: 3000, reachable_files: 1 };
  // Arm B: validator transitive closure (simulated ~200 fns, ~80000 bytes)
  const armBReps   = [{ reachable_functions: 200, reachable_bytes: 80000, reachable_files: 10 }];

  const result = classifyArmB({
    taskId:     "validate-rfc5321-email",
    armAResult,
    armBReps,
    dryRun:     true,
  });

  it("verdict is PASS-DIRECTIONAL for import-heavy dry-run with >= 90% reduction", () => {
    assert.strictEqual(
      result.verdict,
      "PASS-DIRECTIONAL",
      `Expected PASS-DIRECTIONAL, got: ${result.verdict} (reason: ${result.reason})`
    );
  });

  it("dry_run flag is true in result (mode visible to reviewer)", () => {
    assert.strictEqual(result.dry_run, true);
  });

  it("reason contains a percentage >= 90.0", () => {
    const pctMatch = result.reason.match(/(\d+\.?\d*)%/);
    assert.ok(pctMatch, `Expected percentage in reason, got: ${result.reason}`);
    const pct = parseFloat(pctMatch[1]);
    assert.ok(pct >= 90.0, `Expected >= 90%, got ${pct}% in reason: ${result.reason}`);
  });

  it("arm_b.median_reachable_functions is 200 (sanity)", () => {
    assert.strictEqual(result.arm_b.median_reachable_functions, 200);
  });

  it("reduction_threshold is 0.90", () => {
    assert.strictEqual(result.reduction_threshold, 0.90);
  });
});

// ---------------------------------------------------------------------------
// T-CLASSIFIER-1c: Import-heavy dry-run with WARN-level reduction
// ---------------------------------------------------------------------------

describe("T-CLASSIFIER-1c: dry-run with import-heavy fixture and < 90% reduction returns WARN", async () => {
  const { classifyArmB } = await loadClassifier();

  // Arm A: 50 fns (20% smaller than Arm B -- below threshold)
  const armAResult = { reachable_functions: 80, reachable_bytes: 30000, reachable_files: 1 };
  const armBReps   = [{ reachable_functions: 100, reachable_bytes: 40000, reachable_files: 5 }];

  const result = classifyArmB({
    taskId:     "validate-rfc5321-email",
    armAResult,
    armBReps,
    dryRun:     true,
  });

  it("verdict is WARN-DIRECTIONAL when reduction < 90%", () => {
    assert.strictEqual(
      result.verdict,
      "WARN-DIRECTIONAL",
      `Expected WARN-DIRECTIONAL, got: ${result.verdict} (reason: ${result.reason})`
    );
  });

  it("dry_run is still true", () => {
    assert.strictEqual(result.dry_run, true);
  });
});

// ---------------------------------------------------------------------------
// T-CLASSIFIER-1d: INCONCLUSIVE when both arms have 0 (non-import-heavy, non-dry-run)
// ---------------------------------------------------------------------------

describe("T-CLASSIFIER-1d: INCONCLUSIVE when both arms are zero (non-dry-run)", async () => {
  const { classifyArmB } = await loadClassifier();

  const armAResult = { reachable_functions: 0, reachable_bytes: 0, reachable_files: 1 };
  const armBReps   = [{ reachable_functions: 0, reachable_bytes: 0, reachable_files: 1 }];

  const result = classifyArmB({
    taskId:     "parse-int-list",
    armAResult,
    armBReps,
    dryRun:     false,
  });

  it("verdict is INCONCLUSIVE when both arms are zero (live mode)", () => {
    assert.strictEqual(
      result.verdict,
      "INCONCLUSIVE",
      `Expected INCONCLUSIVE, got: ${result.verdict}`
    );
  });
});
