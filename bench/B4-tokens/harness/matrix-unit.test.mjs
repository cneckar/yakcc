// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/matrix-unit.test.mjs
//
// Unit tests for the WI-473 matrix harness promotion.
// Covers: matrix iteration, quality-lift calc, billing-log formatter, cost ceiling.
//
// Run:
//   node --test bench/B4-tokens/harness/matrix-unit.test.mjs
//   (uses Node.js built-in test runner)

import { strict as assert } from "node:assert";
import { describe, it, before } from "node:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = __dirname;
const MATRIX_PATH = join(HARNESS_DIR, "matrix.mjs");
const BILLING_PATH = join(HARNESS_DIR, "billing.mjs");
const BUDGET_PATH = join(HARNESS_DIR, "budget.mjs");

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

let buildCellSpace, DRIVERS, SWEEP_POSITIONS, TIER_SHAPE;
let BillingLog;
let BudgetTracker, BudgetExceededError;

before(async () => {
  const matrix = await import(new URL(`file://${MATRIX_PATH}`).href);
  buildCellSpace = matrix.buildCellSpace;
  DRIVERS = matrix.DRIVERS;
  SWEEP_POSITIONS = matrix.SWEEP_POSITIONS;
  TIER_SHAPE = matrix.TIER_SHAPE;

  const billing = await import(new URL(`file://${BILLING_PATH}`).href);
  BillingLog = billing.BillingLog;

  const budget = await import(new URL(`file://${BUDGET_PATH}`).href);
  BudgetTracker = budget.BudgetTracker;
  BudgetExceededError = budget.BudgetExceededError;
});

// ---------------------------------------------------------------------------
// matrix.mjs — driver enumeration
// ---------------------------------------------------------------------------

describe("DRIVERS constant", () => {
  it("contains exactly 3 drivers with verbatim model IDs per DEC-V0-B4-SLICE2-MATRIX-002", () => {
    assert.equal(DRIVERS.length, 3);
    const ids = DRIVERS.map((d) => d.model_id);
    assert.ok(ids.includes("claude-haiku-4-5-20251001"), "haiku model ID must match exactly");
    assert.ok(ids.includes("claude-sonnet-4-6"), "sonnet model ID must match exactly");
    assert.ok(ids.includes("claude-opus-4-7"), "opus model ID must match exactly");
  });

  it("each driver has a short_name (haiku|sonnet|opus)", () => {
    const names = DRIVERS.map((d) => d.short_name);
    assert.ok(names.includes("haiku"), "haiku short_name required");
    assert.ok(names.includes("sonnet"), "sonnet short_name required");
    assert.ok(names.includes("opus"), "opus short_name required");
  });
});

// ---------------------------------------------------------------------------
// matrix.mjs — SWEEP_POSITIONS
// ---------------------------------------------------------------------------

describe("SWEEP_POSITIONS constant", () => {
  it("contains exactly 3 positions: conservative, default, aggressive", () => {
    const positions = SWEEP_POSITIONS.map((p) => p.name);
    assert.deepEqual(positions, ["conservative", "default", "aggressive"]);
  });

  it("each position has a confidence_threshold and substitution_aggressiveness", () => {
    for (const pos of SWEEP_POSITIONS) {
      assert.ok(typeof pos.confidence_threshold === "number", `${pos.name} must have numeric confidence_threshold`);
      assert.ok(typeof pos.substitution_aggressiveness === "string", `${pos.name} must have substitution_aggressiveness`);
    }
  });

  it("conservative threshold > default threshold > aggressive threshold (monotonic)", () => {
    const [conservative, def, aggressive] = SWEEP_POSITIONS;
    assert.ok(conservative.confidence_threshold > def.confidence_threshold,
      "conservative must have higher threshold than default");
    assert.ok(def.confidence_threshold > aggressive.confidence_threshold,
      "default must have higher threshold than aggressive");
  });
});

// ---------------------------------------------------------------------------
// matrix.mjs — buildCellSpace
// ---------------------------------------------------------------------------

describe("buildCellSpace — min tier", () => {
  it("produces 6 cells per task (3 drivers × 2 arms: unhooked + hooked-default)", () => {
    const cells = buildCellSpace({ tier: "min" });
    // 3 drivers × 2 arms = 6 cells per task
    assert.equal(cells.length, 6);
  });

  it("each min-tier cell has driver, arm, and sweep_position fields", () => {
    const cells = buildCellSpace({ tier: "min" });
    for (const cell of cells) {
      assert.ok(typeof cell.driver === "string", "cell.driver required");
      assert.ok(typeof cell.arm === "string", "cell.arm required");
      assert.ok(typeof cell.sweep_position === "string", "cell.sweep_position required");
      assert.ok(typeof cell.cell_id === "string", "cell.cell_id required");
    }
  });

  it("min tier hooked arm uses only 'default' sweep position", () => {
    const cells = buildCellSpace({ tier: "min" });
    const hookedCells = cells.filter((c) => c.arm === "hooked");
    for (const cell of hookedCells) {
      assert.equal(cell.sweep_position, "default", "min tier hooked must use default sweep position");
    }
  });

  it("min tier has exactly 1 unhooked + 1 hooked cell per driver", () => {
    const cells = buildCellSpace({ tier: "min" });
    for (const driver of DRIVERS) {
      const driverCells = cells.filter((c) => c.driver === driver.short_name);
      assert.equal(driverCells.length, 2, `driver ${driver.short_name} should have 2 cells in min tier`);
      const arms = driverCells.map((c) => c.arm);
      assert.ok(arms.includes("unhooked"), "unhooked arm required");
      assert.ok(arms.includes("hooked"), "hooked arm required");
    }
  });

  it("total min-tier cells × 8 tasks × 3 reps = 144 (per spec)", () => {
    const cells = buildCellSpace({ tier: "min" });
    // 6 cells per task × 8 tasks × 3 reps = 144
    assert.equal(cells.length * 8 * 3, 144);
  });
});

describe("buildCellSpace — full tier", () => {
  it("produces 12 cells per task (3 drivers × 4 arms: unhooked + 3 sweep positions)", () => {
    const cells = buildCellSpace({ tier: "full" });
    assert.equal(cells.length, 12);
  });

  it("full tier has 1 unhooked + 3 hooked cells per driver", () => {
    const cells = buildCellSpace({ tier: "full" });
    for (const driver of DRIVERS) {
      const driverCells = cells.filter((c) => c.driver === driver.short_name);
      assert.equal(driverCells.length, 4, `driver ${driver.short_name} should have 4 cells in full tier`);
      const hookedCells = driverCells.filter((c) => c.arm === "hooked");
      assert.equal(hookedCells.length, 3, "3 hooked sweep positions per driver");
      const sweepPositions = hookedCells.map((c) => c.sweep_position).sort();
      assert.deepEqual(sweepPositions, ["aggressive", "conservative", "default"]);
    }
  });

  it("total full-tier cells × 8 tasks × 3 reps = 288 (per spec)", () => {
    const cells = buildCellSpace({ tier: "full" });
    assert.equal(cells.length * 8 * 3, 288);
  });
});

describe("buildCellSpace — driver filter", () => {
  it("--driver=haiku produces only haiku cells", () => {
    const cells = buildCellSpace({ tier: "min", driverFilter: "haiku" });
    for (const cell of cells) {
      assert.equal(cell.driver, "haiku");
    }
    assert.equal(cells.length, 2); // 2 arms for haiku in min tier
  });

  it("--driver=all produces all 3 drivers (same as no filter)", () => {
    const allCells = buildCellSpace({ tier: "min", driverFilter: "all" });
    const noFilterCells = buildCellSpace({ tier: "min" });
    assert.equal(allCells.length, noFilterCells.length);
  });

  it("unknown driver filter throws TypeError", () => {
    assert.throws(
      () => buildCellSpace({ tier: "min", driverFilter: "gpt4o" }),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.ok(err.message.includes("gpt4o"), "error must name the unknown driver");
        return true;
      }
    );
  });
});

describe("buildCellSpace — cell_id uniqueness", () => {
  it("all cell_ids in min tier are unique", () => {
    const cells = buildCellSpace({ tier: "min" });
    const ids = new Set(cells.map((c) => c.cell_id));
    assert.equal(ids.size, cells.length, "all cell IDs must be unique");
  });

  it("all cell_ids in full tier are unique", () => {
    const cells = buildCellSpace({ tier: "full" });
    const ids = new Set(cells.map((c) => c.cell_id));
    assert.equal(ids.size, cells.length, "all cell IDs must be unique");
  });
});

// ---------------------------------------------------------------------------
// billing.mjs — log format and file naming
// ---------------------------------------------------------------------------

describe("BillingLog — file naming and schema", () => {
  let tmpDir;

  before(() => {
    tmpDir = join(tmpdir(), `b4-billing-test-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  it("creates a billing log at the configured path", () => {
    const log = new BillingLog({ dir: tmpDir, runId: "test-run-001" });
    const expectedPath = join(tmpDir, "billing-test-run-001.jsonl");
    // File created on first write
    log.append({
      run_id: "test-run-001",
      cell_id: "haiku:unhooked:default",
      task_id: "lru-cache-with-ttl",
      task_repetition: 1,
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      model_id_requested: "claude-haiku-4-5-20251001",
      model_id_actual: "claude-haiku-4-5-20251001",
      cost_usd_estimated: 0.0015,
      wall_time_ms: 1200,
      started_at_iso: "2026-05-13T00:00:00.000Z",
      finished_at_iso: "2026-05-13T00:00:01.200Z",
    });
    assert.ok(existsSync(expectedPath), `billing log must be created at ${expectedPath}`);
  });

  it("billing log entries are valid JSONL (one JSON object per line)", () => {
    const runId = `test-run-${randomBytes(4).toString("hex")}`;
    const log = new BillingLog({ dir: tmpDir, runId });
    const entry = {
      run_id: runId,
      cell_id: "sonnet:hooked:default",
      task_id: "csv-parser-quoted",
      task_repetition: 2,
      input_tokens: 1500,
      output_tokens: 800,
      cache_read_tokens: 100,
      cache_write_tokens: 0,
      model_id_requested: "claude-sonnet-4-6",
      model_id_actual: "claude-sonnet-4-6",
      cost_usd_estimated: 0.003,
      wall_time_ms: 2500,
      started_at_iso: "2026-05-13T00:00:00.000Z",
      finished_at_iso: "2026-05-13T00:00:02.500Z",
    };
    log.append(entry);
    log.append({ ...entry, task_repetition: 3 });

    const logPath = join(tmpDir, `billing-${runId}.jsonl`);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "2 entries = 2 lines");
    for (const line of lines) {
      const parsed = JSON.parse(line); // throws if not valid JSON
      assert.equal(parsed.run_id, runId);
      assert.ok(typeof parsed.cost_usd_estimated === "number");
    }
  });

  it("billing log entry contains all required schema fields", () => {
    const runId = `test-schema-${randomBytes(4).toString("hex")}`;
    const log = new BillingLog({ dir: tmpDir, runId });
    const requiredFields = [
      "run_id", "cell_id", "task_id", "task_repetition",
      "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
      "model_id_requested", "model_id_actual",
      "cost_usd_estimated", "wall_time_ms",
      "started_at_iso", "finished_at_iso",
    ];
    log.append({
      run_id: runId,
      cell_id: "opus:hooked:aggressive",
      task_id: "debounce-with-cancel",
      task_repetition: 1,
      input_tokens: 2000,
      output_tokens: 400,
      cache_read_tokens: 500,
      cache_write_tokens: 200,
      model_id_requested: "claude-opus-4-7",
      model_id_actual: "claude-opus-4-7",
      cost_usd_estimated: 0.025,
      wall_time_ms: 5000,
      started_at_iso: "2026-05-13T00:00:00.000Z",
      finished_at_iso: "2026-05-13T00:00:05.000Z",
    });
    const logPath = join(tmpDir, `billing-${runId}.jsonl`);
    const parsed = JSON.parse(readFileSync(logPath, "utf8").trim());
    for (const field of requiredFields) {
      assert.ok(field in parsed, `required field '${field}' missing from billing entry`);
    }
  });

  it("model drift detection: logs both requested and actual model IDs", () => {
    const runId = `test-drift-${randomBytes(4).toString("hex")}`;
    const log = new BillingLog({ dir: tmpDir, runId });
    log.append({
      run_id: runId,
      cell_id: "haiku:unhooked:default",
      task_id: "lru-cache-with-ttl",
      task_repetition: 1,
      input_tokens: 1000,
      output_tokens: 300,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      // Simulated SDK substitution: requested haiku but got sonnet
      model_id_requested: "claude-haiku-4-5-20251001",
      model_id_actual: "claude-sonnet-4-6",
      cost_usd_estimated: 0.002,
      wall_time_ms: 1500,
      started_at_iso: "2026-05-13T00:00:00.000Z",
      finished_at_iso: "2026-05-13T00:00:01.500Z",
    });
    const logPath = join(tmpDir, `billing-${runId}.jsonl`);
    const parsed = JSON.parse(readFileSync(logPath, "utf8").trim());
    assert.notEqual(parsed.model_id_requested, parsed.model_id_actual,
      "both fields recorded — drift is detectable");
  });
});

// ---------------------------------------------------------------------------
// budget.mjs — cost ceiling enforcement
// ---------------------------------------------------------------------------

describe("BudgetTracker — cost ceiling $75 USD", () => {
  it("BudgetExceededError is a distinct error class", () => {
    const err = new BudgetExceededError({ cumulative_usd_at_throw: 75.01, cap_usd: 75 });
    assert.ok(err instanceof Error);
    assert.ok(err instanceof BudgetExceededError);
    assert.equal(err.name, "BudgetExceededError");
    assert.ok(typeof err.cumulative_usd_at_throw === "number");
    assert.ok(typeof err.cap_usd === "number");
  });

  it("does not throw while spend is below cap", () => {
    const tracker = new BudgetTracker({ cap_usd: 75 });
    // Multiple adds below the cap
    tracker.addSpend(10.0);
    tracker.addSpend(20.0);
    tracker.addSpend(30.0);
    assert.equal(tracker.cumulativeUsd, 60.0);
    // Should NOT throw (60 < 75)
    tracker.checkBeforeCall(0.01);
  });

  it("throws BudgetExceededError when cumulative spend would reach cap", () => {
    const tracker = new BudgetTracker({ cap_usd: 5.0 });
    tracker.addSpend(4.9);
    // This next call would bring us to 5.0 + 0.15 = 5.05 which >= cap
    assert.throws(
      () => tracker.checkBeforeCall(0.15),
      (err) => {
        assert.ok(err instanceof BudgetExceededError, "must be BudgetExceededError");
        assert.ok(err.cumulative_usd_at_throw >= 5.0, "cumulative_usd_at_throw must be >= cap");
        assert.equal(err.cap_usd, 5.0, "cap_usd must be the configured cap");
        return true;
      }
    );
  });

  it("throws BudgetExceededError when cumulative spend already exceeds cap (direct add)", () => {
    const tracker = new BudgetTracker({ cap_usd: 5.0 });
    tracker.addSpend(5.01);
    assert.throws(
      () => tracker.checkBeforeCall(0),
      (err) => {
        assert.ok(err instanceof BudgetExceededError);
        return true;
      }
    );
  });

  it("default cap is $75 USD (DEC-V0-B4-SLICE2-COST-CEILING-004)", () => {
    const tracker = new BudgetTracker();
    // No cap override — default must be $75
    assert.equal(tracker.cap_usd, 75);
  });

  it("no env-var bypass path exists (cap is hardcoded from DEC)", () => {
    // The forbidden bypass pattern: B4_NO_BUDGET_CAP=1 should NOT affect BudgetTracker
    // We can't test env-var at runtime (it's a design contract, not a runtime condition),
    // but we verify the constructor accepts no bypass parameter
    const tracker = new BudgetTracker({ cap_usd: 5.0 });
    // Even if env var is set, the tracker uses the configured cap
    process.env["B4_NO_BUDGET_CAP"] = "1";
    tracker.addSpend(5.01);
    assert.throws(
      () => tracker.checkBeforeCall(0),
      BudgetExceededError,
      "env-var bypass must not work"
    );
    delete process.env["B4_NO_BUDGET_CAP"];
  });

  it("cumulative spend is tracked correctly across multiple addSpend calls", () => {
    const tracker = new BudgetTracker({ cap_usd: 100 });
    tracker.addSpend(10.5);
    tracker.addSpend(20.25);
    tracker.addSpend(5.75);
    assert.ok(Math.abs(tracker.cumulativeUsd - 36.5) < 0.001, "cumulative spend must sum correctly");
  });
});

// ---------------------------------------------------------------------------
// Quality-lift calculation (inline — no separate module needed for formula)
// ---------------------------------------------------------------------------

describe("Quality-lift calculation logic", () => {
  // These tests verify the quality-lift aggregation formula:
  // lift_rate = fraction of tasks where hooked-pass AND unhooked-fail (same driver row)

  function computeQualityLift(results, driver) {
    // results: array of { task_id, arm: "unhooked"|"hooked", oracle_pass: boolean, driver }
    const tasks = [...new Set(results.map((r) => r.task_id))];
    let liftCount = 0;
    for (const taskId of tasks) {
      const driverRows = results.filter((r) => r.task_id === taskId && r.driver === driver);
      const unhooked = driverRows.filter((r) => r.arm === "unhooked");
      const hooked = driverRows.filter((r) => r.arm === "hooked");
      const unhookedPass = unhooked.some((r) => r.oracle_pass);
      const hookedPass = hooked.some((r) => r.oracle_pass);
      if (!unhookedPass && hookedPass) liftCount++;
    }
    return tasks.length > 0 ? liftCount / tasks.length : 0;
  }

  it("returns 0 when hooked fails and unhooked also fails", () => {
    const results = [
      { task_id: "task-1", driver: "haiku", arm: "unhooked", oracle_pass: false },
      { task_id: "task-1", driver: "haiku", arm: "hooked", oracle_pass: false },
    ];
    assert.equal(computeQualityLift(results, "haiku"), 0);
  });

  it("returns 0 when both hooked and unhooked pass (no lift)", () => {
    const results = [
      { task_id: "task-1", driver: "haiku", arm: "unhooked", oracle_pass: true },
      { task_id: "task-1", driver: "haiku", arm: "hooked", oracle_pass: true },
    ];
    assert.equal(computeQualityLift(results, "haiku"), 0);
  });

  it("returns 1.0 when hooked passes and unhooked fails (1/1 tasks lifted)", () => {
    const results = [
      { task_id: "task-1", driver: "haiku", arm: "unhooked", oracle_pass: false },
      { task_id: "task-1", driver: "haiku", arm: "hooked", oracle_pass: true },
    ];
    assert.equal(computeQualityLift(results, "haiku"), 1.0);
  });

  it("returns 0.5 when 1/2 tasks show lift", () => {
    const results = [
      { task_id: "task-1", driver: "haiku", arm: "unhooked", oracle_pass: false },
      { task_id: "task-1", driver: "haiku", arm: "hooked", oracle_pass: true },
      { task_id: "task-2", driver: "haiku", arm: "unhooked", oracle_pass: false },
      { task_id: "task-2", driver: "haiku", arm: "hooked", oracle_pass: false },
    ];
    assert.equal(computeQualityLift(results, "haiku"), 0.5);
  });

  it("does not count tasks where unhooked passes (lift only counts unhooked-fail + hooked-pass)", () => {
    const results = [
      { task_id: "task-1", driver: "haiku", arm: "unhooked", oracle_pass: true },
      { task_id: "task-1", driver: "haiku", arm: "hooked", oracle_pass: true },
      { task_id: "task-2", driver: "haiku", arm: "unhooked", oracle_pass: false },
      { task_id: "task-2", driver: "haiku", arm: "hooked", oracle_pass: true },
    ];
    // task-1: both pass → no lift; task-2: unhooked-fail + hooked-pass → lift
    assert.equal(computeQualityLift(results, "haiku"), 0.5);
  });

  it("is computed independently per driver", () => {
    const results = [
      // haiku: task-1 lifted
      { task_id: "task-1", driver: "haiku", arm: "unhooked", oracle_pass: false },
      { task_id: "task-1", driver: "haiku", arm: "hooked", oracle_pass: true },
      // sonnet: task-1 not lifted (both fail)
      { task_id: "task-1", driver: "sonnet", arm: "unhooked", oracle_pass: false },
      { task_id: "task-1", driver: "sonnet", arm: "hooked", oracle_pass: false },
    ];
    assert.equal(computeQualityLift(results, "haiku"), 1.0);
    assert.equal(computeQualityLift(results, "sonnet"), 0.0);
  });
});

// ---------------------------------------------------------------------------
// Results table format verification
// ---------------------------------------------------------------------------

describe("Results table shape", () => {
  // This verifies the shape contract for the final results JSON.
  // The actual formatting is tested through the dry-run output in the CLI.

  function buildResultsTable(perTaskSummaries, drivers) {
    // Build a 3×2 table (min tier): driver rows × {unhooked, hooked} columns
    const table = {
      headers: ["driver", "unhooked", "hooked"],
      rows: [],
    };
    for (const driver of drivers) {
      const driverSummaries = perTaskSummaries.filter((s) => s.driver === driver.short_name);
      const unhookedSummaries = driverSummaries.filter((s) => s.arm === "unhooked");
      const hookedSummaries = driverSummaries.filter((s) => s.arm === "hooked");

      const unhookedMeanTokens = unhookedSummaries.length > 0
        ? unhookedSummaries.reduce((a, b) => a + b.mean_output_tokens, 0) / unhookedSummaries.length
        : 0;
      const hookedMeanTokens = hookedSummaries.length > 0
        ? hookedSummaries.reduce((a, b) => a + b.mean_output_tokens, 0) / hookedSummaries.length
        : 0;

      table.rows.push({
        driver: driver.short_name,
        unhooked: { mean_output_tokens: unhookedMeanTokens, n: unhookedSummaries.length },
        hooked: { mean_output_tokens: hookedMeanTokens, n: hookedSummaries.length },
      });
    }
    return table;
  }

  it("min-tier table has 3 rows (one per driver)", () => {
    const drivers = [
      { short_name: "haiku" },
      { short_name: "sonnet" },
      { short_name: "opus" },
    ];
    const summaries = [
      { driver: "haiku", arm: "unhooked", mean_output_tokens: 800 },
      { driver: "haiku", arm: "hooked", mean_output_tokens: 300 },
      { driver: "sonnet", arm: "unhooked", mean_output_tokens: 1000 },
      { driver: "sonnet", arm: "hooked", mean_output_tokens: 400 },
      { driver: "opus", arm: "unhooked", mean_output_tokens: 1200 },
      { driver: "opus", arm: "hooked", mean_output_tokens: 350 },
    ];
    const table = buildResultsTable(summaries, drivers);
    assert.equal(table.rows.length, 3, "3 rows in min-tier table");
  });

  it("min-tier table row has unhooked and hooked columns", () => {
    const drivers = [{ short_name: "haiku" }];
    const summaries = [
      { driver: "haiku", arm: "unhooked", mean_output_tokens: 800 },
      { driver: "haiku", arm: "hooked", mean_output_tokens: 300 },
    ];
    const table = buildResultsTable(summaries, drivers);
    const row = table.rows[0];
    assert.ok("unhooked" in row, "unhooked column required");
    assert.ok("hooked" in row, "hooked column required");
  });
});

console.log("\nAll B4 matrix unit tests loaded.\n");
