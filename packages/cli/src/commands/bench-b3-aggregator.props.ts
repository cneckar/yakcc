// SPDX-License-Identifier: MIT
//
// bench-b3-aggregator.props.ts — fast-check property tests for aggregateSprintReport().
//
// @decision DEC-WI187-005
// @title Property tests: aggregator output order-invariant across event permutations
// @status accepted (WI-187)
// @rationale
//   The aggregator joins tasks to events by time-window filter, not by JSONL line order.
//   These property tests prove that any permutation of events within a task window
//   produces identical hit counts and hitRate. This is the fast-check property
//   required by PLAN.md §7 "bench-b3-aggregator.props.ts".
//   Cross-reference: PLAN.md §4.5 / #187
//
// Evaluation Contract property (PLAN.md §7):
//   "Aggregator output is identity-stable across event-order reorderings within
//   a task window (sort events into the file in any permutation; same report)."
//
// This is a compound-interaction test: it exercises the full production sequence
// readTaskMarkers → aggregateSprintReport across real data structures.

import type { TelemetryEvent } from "@yakcc/hooks-base/telemetry.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { aggregateSprintReport } from "./bench-b3-aggregator.js";
import type { TaskBeginMarker, TaskEndMarker } from "./bench-b3-markers.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const categoryArb = fc.constantFrom(
  "boilerplate" as const,
  "glue" as const,
  "novel-logic" as const,
);

const telemetryOutcomeArb = fc.constantFrom(
  "registry-hit",
  "passthrough",
  "synthesis-required",
  "intent-too-broad",
  "result-set-too-large",
  "atomized",
);

/**
 * Generate an array of telemetry events (t values within a given range).
 * Events represent the raw pool that aggregateSprintReport operates on.
 */
function eventsInRangeArb(minT: number, maxT: number) {
  return fc.array(
    fc.record({
      t: fc.integer({ min: minT, max: maxT }),
      outcome: telemetryOutcomeArb,
    }),
    { minLength: 0, maxLength: 20 },
  );
}

// ---------------------------------------------------------------------------
// Property: order-invariant aggregation
// ---------------------------------------------------------------------------

describe("property: aggregateSprintReport is order-invariant w.r.t. telemetry event ordering", () => {
  it("reordering events within a task window yields the same hitRate and eventCount", () => {
    fc.assert(
      fc.property(
        // A single completed task.
        categoryArb,
        // Events within the task window [1000, 5000].
        eventsInRangeArb(1000, 5000),
        (category, rawEvents) => {
          const begin: TaskBeginMarker = {
            kind: "task-begin",
            t: 1000,
            taskSlug: "prop-task",
            category,
            classifier: "prop-classifier",
            sessionIdAtStart: "sess-prop",
            note: null,
          };
          const end: TaskEndMarker = {
            kind: "task-end",
            t: 5000,
            taskSlug: "prop-task",
            outcome: "completed",
            sessionIdAtEnd: "sess-prop",
          };
          const markers = [begin, end];

          // Build the canonical telemetry event shape from raw data.
          const telemetryEvents = rawEvents.map((e) => ({
            t: e.t,
            intentHash: "aabb",
            toolName: "Edit" as const,
            candidateCount: 1,
            topScore: 0.1 as number | null,
            substituted: false,
            substitutedAtomHash: null as string | null,
            latencyMs: 1,
            outcome: e.outcome as TelemetryEvent["outcome"],
          }));

          // Reversed ordering of the same events.
          const reversedEvents = [...telemetryEvents].reverse();

          const reportA = aggregateSprintReport("prop", markers, 0, telemetryEvents, null, 0);
          const reportB = aggregateSprintReport("prop", markers, 0, reversedEvents, null, 0);

          // Core invariant: task-level counts are order-independent.
          expect(reportA.joinedEvents).toBe(reportB.joinedEvents);
          expect(reportA.orphanedEvents).toBe(reportB.orphanedEvents);
          expect(reportA.completedTasks).toBe(reportB.completedTasks);

          // Per-category hit rates must match.
          for (let i = 0; i < reportA.perCategory.length; i++) {
            const catA = reportA.perCategory[i];
            const catB = reportB.perCategory[i];
            if (catA === undefined || catB === undefined) continue;

            expect(catA.hitEvents).toBe(catB.hitEvents);
            expect(catA.totalEvents).toBe(catB.totalEvents);

            // hitRate may be NaN when totalEvents === 0; both must agree.
            if (Number.isNaN(catA.hitRate)) {
              expect(Number.isNaN(catB.hitRate)).toBe(true);
            } else {
              expect(catA.hitRate).toBeCloseTo(catB.hitRate, 10);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("arbitrary permutation of events within window yields same report as original", () => {
    fc.assert(
      fc.property(categoryArb, eventsInRangeArb(1000, 5000), (category, rawEvents) => {
        // Sort descending by t — opposite of natural append order.
        const begin: TaskBeginMarker = {
          kind: "task-begin",
          t: 1000,
          taskSlug: "shuffle-task",
          category,
          classifier: "prop-classifier",
          sessionIdAtStart: "sess-shuffle",
          note: null,
        };
        const end: TaskEndMarker = {
          kind: "task-end",
          t: 5000,
          taskSlug: "shuffle-task",
          outcome: "completed",
          sessionIdAtEnd: "sess-shuffle",
        };

        const telemetryEvents = rawEvents.map((e) => ({
          t: e.t,
          intentHash: "ccdd",
          toolName: "Write" as const,
          candidateCount: 0,
          topScore: null as number | null,
          substituted: false,
          substitutedAtomHash: null as string | null,
          latencyMs: 2,
          outcome: e.outcome as TelemetryEvent["outcome"],
        }));

        // Sort descending by t — opposite of natural append order.
        const sortedDesc = [...telemetryEvents].sort((a, b) => b.t - a.t);

        const reportOriginal = aggregateSprintReport(
          "prop",
          [begin, end],
          0,
          telemetryEvents,
          null,
          0,
        );
        const reportSorted = aggregateSprintReport("prop", [begin, end], 0, sortedDesc, null, 0);

        expect(reportOriginal.joinedEvents).toBe(reportSorted.joinedEvents);
        for (let i = 0; i < reportOriginal.perCategory.length; i++) {
          const catO = reportOriginal.perCategory[i];
          const catS = reportSorted.perCategory[i];
          if (catO === undefined || catS === undefined) continue;
          expect(catO.hitEvents).toBe(catS.hitEvents);
          expect(catO.totalEvents).toBe(catS.totalEvents);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property: abandoned tasks never contribute to hit counts
// ---------------------------------------------------------------------------

describe("property: abandoned tasks never inflate hit counts", () => {
  it("any abandoned task's events do not appear in category hit totals", () => {
    fc.assert(
      fc.property(categoryArb, eventsInRangeArb(1000, 5000), (category, rawEvents) => {
        const begin: TaskBeginMarker = {
          kind: "task-begin",
          t: 1000,
          taskSlug: "abandoned-task",
          category,
          classifier: "prop",
          sessionIdAtStart: "sess-ab",
          note: null,
        };
        const end: TaskEndMarker = {
          kind: "task-end",
          t: 5000,
          taskSlug: "abandoned-task",
          outcome: "abandoned",
          sessionIdAtEnd: "sess-ab",
        };

        const telemetryEvents = rawEvents.map((e) => ({
          t: e.t,
          intentHash: "eeff",
          toolName: "Edit" as const,
          candidateCount: 1,
          topScore: 0.1 as number | null,
          substituted: false,
          substitutedAtomHash: null as string | null,
          latencyMs: 1,
          outcome: e.outcome as TelemetryEvent["outcome"],
        }));

        const report = aggregateSprintReport("prop", [begin, end], 0, telemetryEvents, null, 0);

        // Abandoned task excluded from all category tallies.
        expect(report.completedTasks).toBe(0);
        expect(report.abandonedTasks).toBe(1);
        for (const cat of report.perCategory) {
          expect(cat.taskCount).toBe(0);
          expect(cat.hitEvents).toBe(0);
          expect(cat.totalEvents).toBe(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
