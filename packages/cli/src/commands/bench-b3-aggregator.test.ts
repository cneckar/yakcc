// SPDX-License-Identifier: MIT
//
// bench-b3-aggregator.test.ts — Unit tests for aggregateSprintReport() pure functions.
//
// Evaluation Contract tests (PLAN.md §7):
//   - per-category hit-rate math correct for: zero events, one task, multi-task
//   - abandoned task excluded from N and hit-rate computation
//   - session crossover detection
//   - intent-too-broad / result-set-too-large treated as misses (not hits)
//   - verdict computation for PASS / FAIL / YELLOW / INSUFFICIENT_DATA
//   - KILL criterion triggered when boilerplate < 30%
//   - orphaned events counted correctly
//   - open tasks (begin without end) identified
//   - unlisted task detection when preSprintSlugs provided
//
// No I/O — all data is constructed inline (pure function tests).

import type { TelemetryEvent } from "@yakcc/hooks-base/telemetry.js";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_PASS_BARS,
  KILL_THRESHOLD,
  MIN_TASKS,
  aggregateSprintReport,
} from "./bench-b3-aggregator.js";
import type { TaskBeginMarker, TaskEndMarker } from "./bench-b3-markers.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBegin(
  slug: string,
  category: "boilerplate" | "glue" | "novel-logic",
  t = 1000,
  classifier = "alice",
): TaskBeginMarker {
  return {
    kind: "task-begin",
    t,
    taskSlug: slug,
    category,
    classifier,
    sessionIdAtStart: "sess-1",
    note: null,
  };
}

function makeEnd(
  slug: string,
  t = 2000,
  outcome: "completed" | "abandoned" | "blocked" = "completed",
): TaskEndMarker {
  return {
    kind: "task-end",
    t,
    taskSlug: slug,
    outcome,
    sessionIdAtEnd: "sess-1",
  };
}

function makeTelemetryEvent(t: number, outcome: string): TelemetryEvent {
  return {
    t,
    intentHash: "aabb1234",
    toolName: "Edit",
    candidateCount: 1,
    topScore: 0.1,
    substituted: false,
    substitutedAtomHash: null,
    latencyMs: 5,
    outcome: outcome as TelemetryEvent["outcome"],
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("pass bars match #187 requirements", () => {
    expect(CATEGORY_PASS_BARS.boilerplate).toBe(0.6);
    expect(CATEGORY_PASS_BARS.glue).toBe(0.3);
    expect(CATEGORY_PASS_BARS["novel-logic"]).toBe(0.1);
  });

  it("KILL_THRESHOLD is 0.3 (30%)", () => {
    expect(KILL_THRESHOLD).toBe(0.3);
  });

  it("MIN_TASKS is 30", () => {
    expect(MIN_TASKS).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Zero events
// ---------------------------------------------------------------------------

describe("zero events", () => {
  it("report with no markers and no events is well-formed", () => {
    const report = aggregateSprintReport("default", [], 0, [], null, 9999);
    expect(report.sprintId).toBe("default");
    expect(report.declaredTasks).toBe(0);
    expect(report.completedTasks).toBe(0);
    expect(report.joinedEvents).toBe(0);
    expect(report.orphanedEvents).toBe(0);
    expect(report.verdict).toBe("INSUFFICIENT_DATA");
    expect(report.killTriggered).toBe(false);
    // All categories have zero tasks.
    for (const cat of report.perCategory) {
      expect(cat.taskCount).toBe(0);
      expect(cat.totalEvents).toBe(0);
      expect(cat.hitEvents).toBe(0);
      expect(Number.isNaN(cat.hitRate)).toBe(true);
      expect(cat.pass).toBe(false);
    }
  });

  it("a single task with no telemetry events produces NaN hitRate", () => {
    const markers = [makeBegin("task-a", "boilerplate", 1000), makeEnd("task-a", 2000)];
    const report = aggregateSprintReport("default", markers, 0, [], null, 9999);
    expect(report.completedTasks).toBe(1);
    const bp = report.perCategory.find((c) => c.category === "boilerplate");
    expect(bp?.taskCount).toBe(1);
    expect(bp?.totalEvents).toBe(0);
    expect(Number.isNaN(bp?.hitRate)).toBe(true);
    expect(bp?.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Single task hit-rate math
// ---------------------------------------------------------------------------

describe("single task hit-rate math", () => {
  it("3 hits out of 5 events = 60% for boilerplate → PASS", () => {
    const markers = [makeBegin("task-a", "boilerplate", 1000), makeEnd("task-a", 5000)];
    // 3 registry-hit + 2 passthrough in [1000, 5000]
    const events = [
      makeTelemetryEvent(1500, "registry-hit"),
      makeTelemetryEvent(2000, "passthrough"),
      makeTelemetryEvent(2500, "registry-hit"),
      makeTelemetryEvent(3000, "passthrough"),
      makeTelemetryEvent(3500, "registry-hit"),
    ];
    const report = aggregateSprintReport("default", markers, 0, events, null, 9999);
    const bp = report.perCategory.find((c) => c.category === "boilerplate");
    expect(bp?.taskCount).toBe(1);
    expect(bp?.hitEvents).toBe(3);
    expect(bp?.totalEvents).toBe(5);
    expect(bp?.hitRate).toBeCloseTo(0.6, 5);
    expect(bp?.pass).toBe(true); // exactly at bar
  });

  it("2 hits out of 5 events = 40% for boilerplate → FAIL (below 60% bar)", () => {
    const markers = [makeBegin("task-a", "boilerplate", 1000), makeEnd("task-a", 5000)];
    const events = [
      makeTelemetryEvent(1500, "registry-hit"),
      makeTelemetryEvent(2000, "passthrough"),
      makeTelemetryEvent(2500, "registry-hit"),
      makeTelemetryEvent(3000, "passthrough"),
      makeTelemetryEvent(3500, "passthrough"),
    ];
    const report = aggregateSprintReport("default", markers, 0, events, null, 9999);
    const bp = report.perCategory.find((c) => c.category === "boilerplate");
    expect(bp?.pass).toBe(false);
    expect(bp?.hitRate).toBeCloseTo(0.4, 5);
  });
});

// ---------------------------------------------------------------------------
// Multi-task aggregation
// ---------------------------------------------------------------------------

describe("multi-task aggregation", () => {
  it("events outside task windows are counted as orphaned", () => {
    const markers = [makeBegin("task-a", "boilerplate", 1000), makeEnd("task-a", 2000)];
    const events = [
      makeTelemetryEvent(1500, "registry-hit"), // inside task-a window
      makeTelemetryEvent(3000, "passthrough"), // outside all windows → orphaned
    ];
    const report = aggregateSprintReport("default", markers, 0, events, null, 9999);
    expect(report.joinedEvents).toBe(1);
    expect(report.orphanedEvents).toBe(1);
  });

  it("multiple tasks across categories are aggregated independently", () => {
    const markers = [
      makeBegin("task-bp", "boilerplate", 1000),
      makeEnd("task-bp", 2000),
      makeBegin("task-gl", "glue", 3000),
      makeEnd("task-gl", 4000),
    ];
    const events = [
      // boilerplate window: 1 hit, 1 miss → 50%
      makeTelemetryEvent(1500, "registry-hit"),
      makeTelemetryEvent(1800, "passthrough"),
      // glue window: 2 hits, 0 misses → 100%
      makeTelemetryEvent(3200, "registry-hit"),
      makeTelemetryEvent(3500, "registry-hit"),
    ];
    const report = aggregateSprintReport("default", markers, 0, events, null, 9999);
    const bp = report.perCategory.find((c) => c.category === "boilerplate");
    const gl = report.perCategory.find((c) => c.category === "glue");
    expect(bp?.hitRate).toBeCloseTo(0.5, 5);
    expect(gl?.hitRate).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// Abandoned tasks excluded (DEC-WI187-008 clause 4)
// ---------------------------------------------------------------------------

describe("abandoned task exclusion", () => {
  it("abandoned task is not counted in taskCount or hitRate", () => {
    const markers = [
      makeBegin("task-done", "boilerplate", 1000),
      makeEnd("task-done", 2000, "completed"),
      makeBegin("task-abandoned", "boilerplate", 3000),
      makeEnd("task-abandoned", 4000, "abandoned"),
    ];
    const events = [
      makeTelemetryEvent(1500, "registry-hit"),
      makeTelemetryEvent(3500, "registry-hit"), // in abandoned task window — not counted
    ];
    const report = aggregateSprintReport("default", markers, 0, events, null, 9999);
    expect(report.completedTasks).toBe(1);
    expect(report.abandonedTasks).toBe(1);
    const bp = report.perCategory.find((c) => c.category === "boilerplate");
    // Only the completed task is counted.
    expect(bp?.taskCount).toBe(1);
    expect(bp?.hitEvents).toBe(1);
    expect(bp?.totalEvents).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// intent-too-broad / result-set-too-large = misses (DEC-WI187-006)
// ---------------------------------------------------------------------------

describe("miss semantics — intent-too-broad and result-set-too-large", () => {
  it("intent-too-broad is a miss, not a hit", () => {
    const markers = [makeBegin("task-a", "glue", 1000), makeEnd("task-a", 5000)];
    const events = [
      makeTelemetryEvent(1500, "intent-too-broad"), // miss
      makeTelemetryEvent(2000, "result-set-too-large"), // miss
      makeTelemetryEvent(2500, "registry-hit"), // hit
    ];
    const report = aggregateSprintReport("default", markers, 0, events, null, 9999);
    const gl = report.perCategory.find((c) => c.category === "glue");
    // 1 hit out of 3 events = 33.3% → above 30% bar → PASS
    expect(gl?.hitEvents).toBe(1);
    expect(gl?.totalEvents).toBe(3);
    expect(gl?.hitRate).toBeCloseTo(1 / 3, 3);
    expect(gl?.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Session crossover detection (DEC-WI187-002)
// ---------------------------------------------------------------------------

describe("session crossover detection", () => {
  it("session crossover is flagged when sessionIdAtStart !== sessionIdAtEnd", () => {
    const begin: TaskBeginMarker = {
      kind: "task-begin",
      t: 1000,
      taskSlug: "cross-task",
      category: "boilerplate",
      classifier: "alice",
      sessionIdAtStart: "sess-A",
      note: null,
    };
    const end: TaskEndMarker = {
      kind: "task-end",
      t: 2000,
      taskSlug: "cross-task",
      outcome: "completed",
      sessionIdAtEnd: "sess-B", // different session
    };
    const report = aggregateSprintReport("default", [begin, end], 0, [], null, 9999);
    expect(report.sessionCrossoverCount).toBe(1);
    expect(report.tasks[0]?.sessionCrossover).toBe(true);
  });

  it("no crossover when sessions match", () => {
    const markers = [makeBegin("task-a", "boilerplate", 1000), makeEnd("task-a", 2000)];
    const report = aggregateSprintReport("default", markers, 0, [], null, 9999);
    expect(report.sessionCrossoverCount).toBe(0);
    expect(report.tasks[0]?.sessionCrossover).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Open tasks (begin without end)
// ---------------------------------------------------------------------------

describe("open tasks", () => {
  it("task-begin without task-end is reported in openTaskSlugs", () => {
    const markers = [
      makeBegin("task-open", "boilerplate", 1000),
      // No matching task-end
      makeBegin("task-closed", "glue", 2000),
      makeEnd("task-closed", 3000),
    ];
    const report = aggregateSprintReport("default", markers, 0, [], null, 9999);
    expect(report.openTaskSlugs).toContain("task-open");
    expect(report.openTaskSlugs).not.toContain("task-closed");
  });
});

// ---------------------------------------------------------------------------
// Unlisted task detection (DEC-WI187-008 clause 5)
// ---------------------------------------------------------------------------

describe("unlisted task detection", () => {
  it("tasks not in pre-sprint list are flagged in unlistedTaskSlugs", () => {
    const markers = [
      makeBegin("listed-task", "boilerplate", 1000),
      makeEnd("listed-task", 2000),
      makeBegin("unlisted-task", "glue", 3000),
      makeEnd("unlisted-task", 4000),
    ];
    const preSprintSlugs = new Set(["listed-task"]);
    const report = aggregateSprintReport("default", markers, 0, [], preSprintSlugs, 9999);
    expect(report.unlistedTaskSlugs).toContain("unlisted-task");
    expect(report.unlistedTaskSlugs).not.toContain("listed-task");
  });

  it("no unlisted tasks when preSprintSlugs is null", () => {
    const markers = [makeBegin("any-task", "boilerplate", 1000), makeEnd("any-task", 2000)];
    const report = aggregateSprintReport("default", markers, 0, [], null, 9999);
    expect(report.unlistedTaskSlugs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Verdict computation
// ---------------------------------------------------------------------------

describe("verdict computation", () => {
  it("INSUFFICIENT_DATA when fewer than 30 completed tasks", () => {
    const markers = [makeBegin("task-a", "boilerplate", 1000), makeEnd("task-a", 2000)];
    const report = aggregateSprintReport("default", markers, 0, [], null, 9999);
    expect(report.completedTasks).toBe(1);
    expect(report.verdict).toBe("INSUFFICIENT_DATA");
  });

  it("PASS when all categories with tasks meet their bars", () => {
    // Build 30 completed boilerplate tasks each with 60% hit rate.
    const markers: (TaskBeginMarker | TaskEndMarker)[] = [];
    const events: ReturnType<typeof makeTelemetryEvent>[] = [];

    for (let i = 0; i < 30; i++) {
      const baseT = i * 100;
      markers.push(makeBegin(`task-${i}`, "boilerplate", baseT));
      markers.push(makeEnd(`task-${i}`, baseT + 50));
      // 3 hits + 2 misses = 60% for each task
      events.push(makeTelemetryEvent(baseT + 10, "registry-hit"));
      events.push(makeTelemetryEvent(baseT + 20, "registry-hit"));
      events.push(makeTelemetryEvent(baseT + 30, "registry-hit"));
      events.push(makeTelemetryEvent(baseT + 40, "passthrough"));
      events.push(makeTelemetryEvent(baseT + 45, "passthrough"));
    }

    const report = aggregateSprintReport("default", markers, 0, events, null, 9999);
    expect(report.completedTasks).toBe(30);
    // Only boilerplate has tasks, and it passes.
    expect(report.verdict).toBe("PASS");
  });

  it("FAIL when the only category with tasks fails its bar", () => {
    const markers: (TaskBeginMarker | TaskEndMarker)[] = [];
    const events: ReturnType<typeof makeTelemetryEvent>[] = [];

    for (let i = 0; i < 30; i++) {
      const baseT = i * 100;
      markers.push(makeBegin(`task-${i}`, "boilerplate", baseT));
      markers.push(makeEnd(`task-${i}`, baseT + 50));
      // 1 hit + 4 misses = 20% (below 60% bar)
      events.push(makeTelemetryEvent(baseT + 10, "registry-hit"));
      events.push(makeTelemetryEvent(baseT + 20, "passthrough"));
      events.push(makeTelemetryEvent(baseT + 30, "passthrough"));
      events.push(makeTelemetryEvent(baseT + 40, "passthrough"));
      events.push(makeTelemetryEvent(baseT + 45, "passthrough"));
    }

    const report = aggregateSprintReport("default", markers, 0, events, null, 9999);
    expect(report.verdict).toBe("FAIL");
  });

  it("YELLOW when some categories pass and others fail", () => {
    const markers: (TaskBeginMarker | TaskEndMarker)[] = [];
    const events: ReturnType<typeof makeTelemetryEvent>[] = [];

    // 15 boilerplate tasks with 80% hit (pass)
    for (let i = 0; i < 15; i++) {
      const baseT = i * 100;
      markers.push(makeBegin(`bp-${i}`, "boilerplate", baseT));
      markers.push(makeEnd(`bp-${i}`, baseT + 50));
      events.push(makeTelemetryEvent(baseT + 10, "registry-hit"));
      events.push(makeTelemetryEvent(baseT + 20, "registry-hit"));
      events.push(makeTelemetryEvent(baseT + 30, "registry-hit"));
      events.push(makeTelemetryEvent(baseT + 40, "registry-hit"));
      events.push(makeTelemetryEvent(baseT + 45, "passthrough"));
    }

    // 15 glue tasks with 0% hit (fail — below 30% bar)
    for (let i = 0; i < 15; i++) {
      const baseT = 10000 + i * 100;
      markers.push(makeBegin(`gl-${i}`, "glue", baseT));
      markers.push(makeEnd(`gl-${i}`, baseT + 50));
      events.push(makeTelemetryEvent(baseT + 10, "passthrough"));
    }

    const report = aggregateSprintReport("default", markers, 0, events, null, 9999);
    expect(report.completedTasks).toBe(30);
    expect(report.verdict).toBe("YELLOW");
  });
});

// ---------------------------------------------------------------------------
// KILL criterion (DEC-WI187-008 implicit — boilerplate < 30%)
// ---------------------------------------------------------------------------

describe("KILL criterion", () => {
  it("killTriggered is true when boilerplate hit rate < 30%", () => {
    const markers = [makeBegin("task-a", "boilerplate", 1000), makeEnd("task-a", 5000)];
    const events = [
      // 1 hit out of 5 = 20% (below kill threshold 30%)
      makeTelemetryEvent(1500, "registry-hit"),
      makeTelemetryEvent(2000, "passthrough"),
      makeTelemetryEvent(2500, "passthrough"),
      makeTelemetryEvent(3000, "passthrough"),
      makeTelemetryEvent(3500, "passthrough"),
    ];
    const report = aggregateSprintReport("default", markers, 0, events, null, 9999);
    expect(report.killTriggered).toBe(true);
  });

  it("killTriggered is false when boilerplate hit rate >= 30%", () => {
    const markers = [makeBegin("task-a", "boilerplate", 1000), makeEnd("task-a", 5000)];
    const events = [
      // 2 hits out of 5 = 40% (above kill threshold)
      makeTelemetryEvent(1500, "registry-hit"),
      makeTelemetryEvent(2000, "registry-hit"),
      makeTelemetryEvent(2500, "passthrough"),
      makeTelemetryEvent(3000, "passthrough"),
      makeTelemetryEvent(3500, "passthrough"),
    ];
    const report = aggregateSprintReport("default", markers, 0, events, null, 9999);
    expect(report.killTriggered).toBe(false);
  });

  it("killTriggered is false when boilerplate has no tasks", () => {
    const markers = [makeBegin("task-a", "glue", 1000), makeEnd("task-a", 2000)];
    const report = aggregateSprintReport("default", markers, 0, [], null, 9999);
    expect(report.killTriggered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// markerSkippedLines forwarded to report
// ---------------------------------------------------------------------------

describe("markerSkippedLines", () => {
  it("skipped marker lines are surfaced in the report", () => {
    const report = aggregateSprintReport("default", [], 7, [], null, 9999);
    expect(report.markerSkippedLines).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// generatedAt timestamp
// ---------------------------------------------------------------------------

describe("generatedAt", () => {
  it("uses the now parameter for deterministic output", () => {
    const report = aggregateSprintReport("default", [], 0, [], null, 42000);
    expect(report.generatedAt).toBe(42000);
  });
});
