// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/engagement-unit.test.mjs
//
// Unit tests for the WI-479 engagement instrumentation module.
// Covers: classifyEngagement, aggregateEngagement, computeEngagementDelta.
//
// Pattern: follows matrix-unit.test.mjs from PR #478.
//
// Run:
//   node --test bench/B4-tokens/harness/engagement-unit.test.mjs
//   (uses Node.js built-in test runner)

import { strict as assert } from "node:assert";
import { describe, it, before } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGAGEMENT_PATH = join(__dirname, "engagement.mjs");

// ---------------------------------------------------------------------------
// Module import
// ---------------------------------------------------------------------------

let classifyEngagement, aggregateEngagement, computeEngagementDelta;
let ENGAGEMENT_CLASSIFICATIONS, MAX_TOOL_CYCLES;

before(async () => {
  const eng = await import(new URL(`file://${ENGAGEMENT_PATH}`).href);
  classifyEngagement       = eng.classifyEngagement;
  aggregateEngagement      = eng.aggregateEngagement;
  computeEngagementDelta   = eng.computeEngagementDelta;
  ENGAGEMENT_CLASSIFICATIONS = eng.ENGAGEMENT_CLASSIFICATIONS;
  MAX_TOOL_CYCLES          = eng.MAX_TOOL_CYCLES;
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeHookedMeasurement({
  tool_cycle_count = 0,
  substitution_events = [],
  hook_non_engaged = false,
  driver = "haiku",
  task_id = "lru-cache-with-ttl",
  oracle_pass = false,
  output_tokens = 500,
} = {}) {
  return {
    arm: "hooked",
    driver,
    task_id,
    tool_cycle_count,
    hook_non_engaged,
    substitution_events,
    oracle_pass,
    output_tokens,
  };
}

function makeUnhookedMeasurement({ driver = "haiku", task_id = "lru-cache-with-ttl" } = {}) {
  return {
    arm: "unhooked",
    driver,
    task_id,
    output_tokens: 400,
    oracle_pass: false,
  };
}

function makeSubEvent({ intent = "test intent", atoms_proposed = 0, cycle = 1 } = {}) {
  return { intent, atoms_proposed, cycle };
}

// ---------------------------------------------------------------------------
// classifyEngagement — unhooked arm
// ---------------------------------------------------------------------------

describe("classifyEngagement — unhooked arm", () => {
  it("classifies unhooked measurement as 'unhooked'", () => {
    const m = makeUnhookedMeasurement();
    const result = classifyEngagement(m);
    assert.equal(result.classification, ENGAGEMENT_CLASSIFICATIONS.UNHOOKED);
  });

  it("unhooked classification has atoms_returned_total = 0", () => {
    const m = makeUnhookedMeasurement();
    const result = classifyEngagement(m);
    assert.equal(result.atoms_returned_total, 0);
  });

  it("unhooked classification has distinct_intents = 0", () => {
    const m = makeUnhookedMeasurement();
    const result = classifyEngagement(m);
    assert.equal(result.distinct_intents, 0);
  });
});

// ---------------------------------------------------------------------------
// classifyEngagement — non-engaged (0 cycles)
// ---------------------------------------------------------------------------

describe("classifyEngagement — non-engaged (0 cycles)", () => {
  it("classifies hooked measurement with 0 cycles as 'non-engaged'", () => {
    const m = makeHookedMeasurement({ tool_cycle_count: 0, substitution_events: [] });
    const result = classifyEngagement(m);
    assert.equal(result.classification, ENGAGEMENT_CLASSIFICATIONS.NON_ENGAGED);
  });

  it("non-engaged has atoms_returned_total = 0", () => {
    const m = makeHookedMeasurement({ tool_cycle_count: 0 });
    const result = classifyEngagement(m);
    assert.equal(result.atoms_returned_total, 0);
  });

  it("non-engaged has distinct_intents = 0", () => {
    const m = makeHookedMeasurement({ tool_cycle_count: 0 });
    const result = classifyEngagement(m);
    assert.equal(result.distinct_intents, 0);
  });
});

// ---------------------------------------------------------------------------
// classifyEngagement — empty-results (cycles > 0, atoms = 0)
// ---------------------------------------------------------------------------

describe("classifyEngagement — empty-results", () => {
  it("classifies hooked measurement with 1 cycle returning 0 atoms as 'empty-results'", () => {
    const m = makeHookedMeasurement({
      tool_cycle_count: 1,
      substitution_events: [makeSubEvent({ atoms_proposed: 0 })],
    });
    const result = classifyEngagement(m);
    assert.equal(result.classification, ENGAGEMENT_CLASSIFICATIONS.EMPTY_RESULTS);
  });

  it("classifies multiple cycles all returning 0 atoms as 'empty-results'", () => {
    const m = makeHookedMeasurement({
      tool_cycle_count: 3,
      substitution_events: [
        makeSubEvent({ atoms_proposed: 0, cycle: 1 }),
        makeSubEvent({ atoms_proposed: 0, cycle: 2 }),
        makeSubEvent({ atoms_proposed: 0, cycle: 3 }),
      ],
    });
    const result = classifyEngagement(m);
    assert.equal(result.classification, ENGAGEMENT_CLASSIFICATIONS.EMPTY_RESULTS);
  });

  it("empty-results counts distinct intents correctly", () => {
    const m = makeHookedMeasurement({
      tool_cycle_count: 2,
      substitution_events: [
        makeSubEvent({ intent: "LRU cache eviction", atoms_proposed: 0 }),
        makeSubEvent({ intent: "TTL expiry tracking", atoms_proposed: 0 }),
      ],
    });
    const result = classifyEngagement(m);
    assert.equal(result.distinct_intents, 2);
  });

  it("empty-results deduplicates identical intents", () => {
    const m = makeHookedMeasurement({
      tool_cycle_count: 2,
      substitution_events: [
        makeSubEvent({ intent: "same intent", atoms_proposed: 0 }),
        makeSubEvent({ intent: "same intent", atoms_proposed: 0 }),
      ],
    });
    const result = classifyEngagement(m);
    assert.equal(result.distinct_intents, 1);
  });

  it("empty-results is case-insensitive for intent dedup", () => {
    const m = makeHookedMeasurement({
      tool_cycle_count: 2,
      substitution_events: [
        makeSubEvent({ intent: "LRU Cache", atoms_proposed: 0 }),
        makeSubEvent({ intent: "lru cache", atoms_proposed: 0 }),
      ],
    });
    const result = classifyEngagement(m);
    assert.equal(result.distinct_intents, 1);
  });
});

// ---------------------------------------------------------------------------
// classifyEngagement — active (cycles > 0, atoms > 0)
// ---------------------------------------------------------------------------

describe("classifyEngagement — active", () => {
  it("classifies hooked measurement with 1 cycle returning 3 atoms as 'active'", () => {
    const m = makeHookedMeasurement({
      tool_cycle_count: 1,
      substitution_events: [makeSubEvent({ atoms_proposed: 3 })],
    });
    const result = classifyEngagement(m);
    assert.equal(result.classification, ENGAGEMENT_CLASSIFICATIONS.ACTIVE);
  });

  it("classifies as 'active' when at least 1 cycle returns atoms even if others return 0", () => {
    const m = makeHookedMeasurement({
      tool_cycle_count: 2,
      substitution_events: [
        makeSubEvent({ atoms_proposed: 0, cycle: 1 }),
        makeSubEvent({ atoms_proposed: 2, cycle: 2 }),
      ],
    });
    const result = classifyEngagement(m);
    assert.equal(result.classification, ENGAGEMENT_CLASSIFICATIONS.ACTIVE);
  });

  it("active sums atoms_returned_total across all cycles", () => {
    const m = makeHookedMeasurement({
      tool_cycle_count: 3,
      substitution_events: [
        makeSubEvent({ atoms_proposed: 1 }),
        makeSubEvent({ atoms_proposed: 2 }),
        makeSubEvent({ atoms_proposed: 3 }),
      ],
    });
    const result = classifyEngagement(m);
    assert.equal(result.atoms_returned_total, 6);
  });
});

// ---------------------------------------------------------------------------
// classifyEngagement — looped (cycle count >= MAX_TOOL_CYCLES)
// ---------------------------------------------------------------------------

describe("classifyEngagement — looped", () => {
  it("classifies hooked measurement hitting MAX_TOOL_CYCLES as 'looped'", () => {
    const events = Array.from({ length: MAX_TOOL_CYCLES }, (_, i) =>
      makeSubEvent({ atoms_proposed: 0, cycle: i + 1 })
    );
    const m = makeHookedMeasurement({
      tool_cycle_count: MAX_TOOL_CYCLES,
      substitution_events: events,
    });
    const result = classifyEngagement(m);
    assert.equal(result.classification, ENGAGEMENT_CLASSIFICATIONS.LOOPED);
  });

  it("looped still counts atoms_returned_total", () => {
    const events = Array.from({ length: MAX_TOOL_CYCLES }, (_, i) =>
      makeSubEvent({ atoms_proposed: 1, cycle: i + 1 })
    );
    const m = makeHookedMeasurement({
      tool_cycle_count: MAX_TOOL_CYCLES,
      substitution_events: events,
    });
    const result = classifyEngagement(m);
    assert.equal(result.atoms_returned_total, MAX_TOOL_CYCLES);
  });
});

// ---------------------------------------------------------------------------
// aggregateEngagement — basic shape
// ---------------------------------------------------------------------------

describe("aggregateEngagement — basic shape", () => {
  it("returns empty report for empty measurements array", () => {
    const report = aggregateEngagement([]);
    assert.equal(report.hooked_measurement_count, 0);
    assert.deepEqual(report.findings, ["No measurements provided"]);
  });

  it("returns empty report for null/undefined input", () => {
    const report1 = aggregateEngagement(null);
    const report2 = aggregateEngagement(undefined);
    assert.equal(report1.hooked_measurement_count, 0);
    assert.equal(report2.hooked_measurement_count, 0);
  });

  it("report has all required top-level keys", () => {
    const report = aggregateEngagement([makeUnhookedMeasurement()]);
    assert.ok("overall" in report, "overall required");
    assert.ok("by_driver" in report, "by_driver required");
    assert.ok("by_task" in report, "by_task required");
    assert.ok("by_arm" in report, "by_arm required");
    assert.ok("hooked_measurement_count" in report, "hooked_measurement_count required");
    assert.ok("root_cause_hypothesis" in report, "root_cause_hypothesis required");
    assert.ok("findings" in report, "findings required");
  });

  it("overall stats has all required fields", () => {
    const report = aggregateEngagement([makeHookedMeasurement()]);
    const stats = report.overall;
    const requiredFields = [
      "n", "total_tool_cycles", "mean_tool_cycles",
      "cells_non_engaged", "cells_empty_results", "cells_active", "cells_looped",
      "engagement_rate", "tool_invocation_rate", "atoms_returned_total",
      "mean_atoms_per_cycle", "cycle_distribution",
    ];
    for (const field of requiredFields) {
      assert.ok(field in stats, `stats.${field} required`);
    }
  });
});

// ---------------------------------------------------------------------------
// aggregateEngagement — matrix-1 baseline scenario (all empty results)
// ---------------------------------------------------------------------------

describe("aggregateEngagement — matrix-1 baseline: all empty-results", () => {
  // Replicate the WI-479 finding: 72 hooked cells, all calling tool but getting 0 atoms
  function makeMatrix1Measurements() {
    const measurements = [];
    const drivers = ["haiku", "sonnet", "opus"];
    const tasks = ["lru-cache-with-ttl", "csv-parser-quoted", "debounce-with-cancel", "semver-range-satisfies"];
    for (const driver of drivers) {
      for (const task_id of tasks) {
        // 3 reps per (task × driver) for hooked arm
        for (let rep = 0; rep < 3; rep++) {
          measurements.push(makeHookedMeasurement({
            driver,
            task_id,
            tool_cycle_count: 1,
            substitution_events: [makeSubEvent({ atoms_proposed: 0 })],
          }));
          // Unhooked counterpart
          measurements.push(makeUnhookedMeasurement({ driver, task_id }));
        }
      }
    }
    return measurements;
  }

  it("identifies 100% empty-results rate when all tool calls return 0 atoms", () => {
    const measurements = makeMatrix1Measurements();
    const report = aggregateEngagement(measurements);
    const hookedStats = report.by_arm["hooked"];
    assert.equal(hookedStats.cells_active, 0, "no active cells expected");
    assert.equal(hookedStats.cells_non_engaged, 0, "no non-engaged cells expected");
    assert.equal(hookedStats.cells_empty_results, hookedStats.n, "all cells should be empty-results");
  });

  it("engagement_rate is 0 when no atoms are returned", () => {
    const measurements = makeMatrix1Measurements();
    const report = aggregateEngagement(measurements);
    assert.equal(report.overall.engagement_rate, 0);
  });

  it("tool_invocation_rate is 1.0 when all hooked cells called the tool", () => {
    const measurements = makeMatrix1Measurements();
    const report = aggregateEngagement(measurements);
    const hookedStats = report.by_arm["hooked"];
    assert.equal(hookedStats.tool_invocation_rate, 1.0);
  });

  it("root_cause_hypothesis identifies H4 when all cells are empty-results", () => {
    const measurements = makeMatrix1Measurements();
    const report = aggregateEngagement(measurements);
    assert.ok(
      report.root_cause_hypothesis.includes("H4"),
      "root cause must mention H4 for all-empty-results scenario"
    );
  });

  it("findings includes CRITICAL note about token overhead with zero benefit", () => {
    const measurements = makeMatrix1Measurements();
    const report = aggregateEngagement(measurements);
    const criticalFinding = report.findings.find((f) => f.includes("CRITICAL"));
    assert.ok(criticalFinding, "CRITICAL finding required for all-zero-atom scenario");
  });

  it("tool cycles are counted correctly across all measurements", () => {
    const measurements = makeMatrix1Measurements();
    const report = aggregateEngagement(measurements);
    // 36 hooked cells × 1 cycle = 36 total cycles
    assert.equal(report.overall.total_tool_cycles, 36);
  });
});

// ---------------------------------------------------------------------------
// aggregateEngagement — by_driver breakdown
// ---------------------------------------------------------------------------

describe("aggregateEngagement — by_driver breakdown", () => {
  it("separates stats by driver correctly", () => {
    const measurements = [
      makeHookedMeasurement({ driver: "haiku", tool_cycle_count: 1, substitution_events: [makeSubEvent({ atoms_proposed: 0 })] }),
      makeHookedMeasurement({ driver: "haiku", tool_cycle_count: 1, substitution_events: [makeSubEvent({ atoms_proposed: 2 })] }),
      makeHookedMeasurement({ driver: "sonnet", tool_cycle_count: 0, substitution_events: [] }),
    ];
    const report = aggregateEngagement(measurements);
    assert.ok("haiku" in report.by_driver, "haiku driver stats required");
    assert.ok("sonnet" in report.by_driver, "sonnet driver stats required");

    const haikuStats = report.by_driver["haiku"];
    assert.equal(haikuStats.n, 2);
    assert.equal(haikuStats.cells_active, 1); // one with atoms_proposed=2
    assert.equal(haikuStats.cells_empty_results, 1);

    const sonnetStats = report.by_driver["sonnet"];
    assert.equal(sonnetStats.n, 1);
    assert.equal(sonnetStats.cells_non_engaged, 1);
  });
});

// ---------------------------------------------------------------------------
// aggregateEngagement — by_task breakdown
// ---------------------------------------------------------------------------

describe("aggregateEngagement — by_task breakdown", () => {
  it("separates stats by task correctly", () => {
    const measurements = [
      makeHookedMeasurement({ task_id: "lru-cache-with-ttl", tool_cycle_count: 1, substitution_events: [makeSubEvent({ atoms_proposed: 1 })] }),
      makeHookedMeasurement({ task_id: "debounce-with-cancel", tool_cycle_count: 0, substitution_events: [] }),
    ];
    const report = aggregateEngagement(measurements);
    assert.ok("lru-cache-with-ttl" in report.by_task);
    assert.ok("debounce-with-cancel" in report.by_task);
    assert.equal(report.by_task["lru-cache-with-ttl"].cells_active, 1);
    assert.equal(report.by_task["debounce-with-cancel"].cells_non_engaged, 1);
  });
});

// ---------------------------------------------------------------------------
// aggregateEngagement — cycle_distribution
// ---------------------------------------------------------------------------

describe("aggregateEngagement — cycle_distribution", () => {
  it("records cycle distribution correctly", () => {
    const measurements = [
      makeHookedMeasurement({ tool_cycle_count: 1, substitution_events: [makeSubEvent()] }),
      makeHookedMeasurement({ tool_cycle_count: 1, substitution_events: [makeSubEvent()] }),
      makeHookedMeasurement({ tool_cycle_count: 2, substitution_events: [makeSubEvent(), makeSubEvent()] }),
      makeHookedMeasurement({ tool_cycle_count: 0, substitution_events: [] }),
    ];
    const report = aggregateEngagement(measurements);
    const dist = report.overall.cycle_distribution;
    assert.equal(dist["0"], 1, "1 cell with 0 cycles");
    assert.equal(dist["1"], 2, "2 cells with 1 cycle");
    assert.equal(dist["2"], 1, "1 cell with 2 cycles");
  });

  it("does not include unhooked cells in cycle distribution", () => {
    const measurements = [
      makeHookedMeasurement({ tool_cycle_count: 1, substitution_events: [makeSubEvent()] }),
      makeUnhookedMeasurement(),
      makeUnhookedMeasurement(),
    ];
    const report = aggregateEngagement(measurements);
    const totalInDist = Object.values(report.overall.cycle_distribution).reduce((a, b) => a + b, 0);
    assert.equal(totalInDist, 1, "only 1 hooked cell in cycle distribution");
  });
});

// ---------------------------------------------------------------------------
// computeEngagementDelta
// ---------------------------------------------------------------------------

describe("computeEngagementDelta", () => {
  function makeStats(overrides = {}) {
    return {
      n: 10,
      total_tool_cycles: 10,
      mean_tool_cycles: 1.0,
      cells_non_engaged: 0,
      cells_empty_results: 10,
      cells_active: 0,
      cells_looped: 0,
      engagement_rate: 0.0,
      tool_invocation_rate: 1.0,
      atoms_returned_total: 0,
      mean_atoms_per_cycle: 0,
      cycle_distribution: { "1": 10 },
      ...overrides,
    };
  }

  it("returns 'improved' verdict when variant has higher engagement_rate", () => {
    const baseline = makeStats({ engagement_rate: 0.0 });
    const variant  = makeStats({ engagement_rate: 0.6 });
    const delta = computeEngagementDelta(baseline, variant);
    assert.equal(delta.verdict, "improved");
    assert.ok(delta.engagement_rate_delta > 0);
  });

  it("returns 'degraded' verdict when variant has lower engagement_rate", () => {
    const baseline = makeStats({ engagement_rate: 0.7 });
    const variant  = makeStats({ engagement_rate: 0.3 });
    const delta = computeEngagementDelta(baseline, variant);
    assert.equal(delta.verdict, "degraded");
  });

  it("returns 'neutral' verdict when difference is within 5%", () => {
    const baseline = makeStats({ engagement_rate: 0.5 });
    const variant  = makeStats({ engagement_rate: 0.52 });
    const delta = computeEngagementDelta(baseline, variant);
    assert.equal(delta.verdict, "neutral");
  });

  it("computes engagement_rate_delta correctly", () => {
    const baseline = makeStats({ engagement_rate: 0.2 });
    const variant  = makeStats({ engagement_rate: 0.8 });
    const delta = computeEngagementDelta(baseline, variant);
    assert.ok(Math.abs(delta.engagement_rate_delta - 0.6) < 0.0001);
  });

  it("computes atoms_returned_total_delta correctly", () => {
    const baseline = makeStats({ atoms_returned_total: 0 });
    const variant  = makeStats({ atoms_returned_total: 15 });
    const delta = computeEngagementDelta(baseline, variant);
    assert.equal(delta.atoms_returned_total_delta, 15);
  });

  it("returns required delta fields", () => {
    const delta = computeEngagementDelta(makeStats(), makeStats());
    assert.ok("engagement_rate_delta" in delta);
    assert.ok("tool_invocation_rate_delta" in delta);
    assert.ok("mean_tool_cycles_delta" in delta);
    assert.ok("atoms_returned_total_delta" in delta);
    assert.ok("verdict" in delta);
  });
});

// ---------------------------------------------------------------------------
// ENGAGEMENT_CLASSIFICATIONS constant
// ---------------------------------------------------------------------------

describe("ENGAGEMENT_CLASSIFICATIONS constant", () => {
  it("contains all 5 required classification strings", () => {
    assert.ok("NON_ENGAGED" in ENGAGEMENT_CLASSIFICATIONS);
    assert.ok("EMPTY_RESULTS" in ENGAGEMENT_CLASSIFICATIONS);
    assert.ok("ACTIVE" in ENGAGEMENT_CLASSIFICATIONS);
    assert.ok("LOOPED" in ENGAGEMENT_CLASSIFICATIONS);
    assert.ok("UNHOOKED" in ENGAGEMENT_CLASSIFICATIONS);
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(ENGAGEMENT_CLASSIFICATIONS));
  });
});

// ---------------------------------------------------------------------------
// MAX_TOOL_CYCLES constant
// ---------------------------------------------------------------------------

describe("MAX_TOOL_CYCLES constant", () => {
  it("is a positive integer matching run.mjs MAX_TOOL_CYCLES = 5", () => {
    assert.equal(typeof MAX_TOOL_CYCLES, "number");
    assert.ok(Number.isInteger(MAX_TOOL_CYCLES));
    assert.ok(MAX_TOOL_CYCLES > 0);
    // Per run.mjs: MAX_TOOL_CYCLES = 5
    assert.equal(MAX_TOOL_CYCLES, 5);
  });
});

console.log("\nAll B4 engagement unit tests loaded.\n");
