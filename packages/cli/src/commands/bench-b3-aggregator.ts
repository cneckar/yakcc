// SPDX-License-Identifier: MIT
//
// bench-b3-aggregator.ts — Pure aggregation logic for the B3 cache-hit harness.
//
// @decision DEC-WI187-005
// @title Reporter shape: yakcc bench b3 report — CLI subcommand in packages/cli
// @status accepted (WI-187)
// @rationale
//   Aggregator logic lives in this sibling module so it is unit-testable in
//   isolation from CLI argv plumbing. The report subcommand (bench-b3.ts) calls
//   aggregateSprintReport() with already-loaded data. No I/O lives in this module.
//   Cross-reference: PLAN.md §4.5 / #187
//
// @decision DEC-WI187-006
// @title Classification captured at task-begin time as a required argument
// @status accepted (WI-187)
// @rationale
//   The aggregator refuses to count tasks missing category or classifier (both
//   required fields). Abandoned tasks are excluded from N and hit-rate computation.
//   intent-too-broad and result-set-too-large events are treated as misses per
//   #187 semantics (not hits). Cross-reference: PLAN.md §4.6 / #187
//
// @decision DEC-WI187-007
// @title Comparator arm: same schema + distinct sprint id, hooks uninstalled
// @status accepted (WI-187)
// @rationale
//   The comparator arm reuses the same marker schema and the same aggregator.
//   The two arms MUST use distinct sprint IDs (e.g. b3-on / b3-off).
//   The aggregator does not distinguish arm type — that is a protocol concern.
//   Cross-reference: PLAN.md §4.7 / #187
//
// AUTHORITY NOTE (DEC-CLI-STATS-READER-SEAM-001):
//   This module does NOT contain any JSON.parse loop over telemetry JSONL files.
//   All telemetry reads are performed by the caller (bench-b3.ts) via
//   readTelemetrySessions() from @yakcc/hooks-base/telemetry.js. The results
//   are passed here as plain TypeScript values. Sacred Practice #12.

import type { TelemetryEvent } from "@yakcc/hooks-base/telemetry.js";
import type {
  TaskBeginMarker,
  TaskCategory,
  TaskEndMarker,
  TaskMarker,
} from "./bench-b3-markers.js";

// ---------------------------------------------------------------------------
// Public input / output types
// ---------------------------------------------------------------------------

/**
 * A resolved task: a task-begin + task-end pair with the telemetry events
 * that fall within the task's time window.
 */
export interface ResolvedTask {
  readonly begin: TaskBeginMarker;
  readonly end: TaskEndMarker;
  /** All telemetry events whose t is in [begin.t, end.t] (inclusive). */
  readonly events: readonly TelemetryEvent[];
  /** True when begin.sessionIdAtStart !== end.sessionIdAtEnd. */
  readonly sessionCrossover: boolean;
}

/** Per-category aggregated statistics. */
export interface CategoryStats {
  readonly category: TaskCategory;
  /** Number of completed tasks in this category (abandoned excluded). */
  readonly taskCount: number;
  /** Total telemetry events (all outcomes) across tasks in this category. */
  readonly totalEvents: number;
  /** Events with outcome "registry-hit". */
  readonly hitEvents: number;
  /** Hit rate as a fraction [0, 1]. NaN when totalEvents === 0. */
  readonly hitRate: number;
  /** Target pass bar per #187. */
  readonly targetBar: number;
  /** Whether hitRate >= targetBar (false when totalEvents === 0). */
  readonly pass: boolean;
}

/**
 * Full sprint report produced by aggregateSprintReport().
 *
 * This is the canonical output shape. The report CLI formats this for display.
 * --json emits a serialised version of this (schemaVersion = 1).
 */
export interface SprintReport {
  /** Sprint identifier passed to resolveMarkerFilePath(). */
  readonly sprintId: string;
  /** Timestamp when the report was generated. */
  readonly generatedAt: number;
  /** Total marker records parsed (includes orphans). */
  readonly declaredTasks: number;
  /** Tasks with a matching begin+end pair with outcome "completed". */
  readonly completedTasks: number;
  /** Tasks with outcome "abandoned". */
  readonly abandonedTasks: number;
  /** Tasks with outcome "blocked". */
  readonly blockedTasks: number;
  /** Total telemetry events matched to any task window. */
  readonly joinedEvents: number;
  /** Telemetry events not matched to any task window. */
  readonly orphanedEvents: number;
  /** Tasks where sessionIdAtStart !== sessionIdAtEnd. */
  readonly sessionCrossoverCount: number;
  /** Per-category breakdowns. */
  readonly perCategory: readonly CategoryStats[];
  /**
   * Overall verdict:
   * - "PASS": all three category bars met (or no categories with tasks)
   * - "FAIL": at least one category bar not met
   * - "YELLOW": mixed (at least one PASS, at least one FAIL)
   * - "INSUFFICIENT_DATA": fewer than 30 completed tasks
   */
  readonly verdict: "PASS" | "FAIL" | "YELLOW" | "INSUFFICIENT_DATA";
  /** True when boilerplate hit rate < 30% (hard KILL criterion per #187). */
  readonly killTriggered: boolean;
  /**
   * Per-task detail rows (all resolved tasks, including abandoned).
   * Useful for --json consumers and the evidence artifact.
   */
  readonly tasks: readonly ResolvedTask[];
  /** Count of marker lines that could not be parsed. */
  readonly markerSkippedLines: number;
  /** Tasks that have a task-begin but no matching task-end. */
  readonly openTaskSlugs: readonly string[];
  /**
   * Tasks where task-begin slug is not in the pre-sprint task list.
   * Empty when no --tasks CSV was provided.
   */
  readonly unlistedTaskSlugs: readonly string[];
}

// ---------------------------------------------------------------------------
// Pass bars per #187 acceptance criteria
// ---------------------------------------------------------------------------

/** The minimum hit rate required for each category per #187. */
export const CATEGORY_PASS_BARS: Readonly<Record<TaskCategory, number>> = {
  boilerplate: 0.6,
  glue: 0.3,
  "novel-logic": 0.1,
};

/** The KILL criterion: boilerplate hit rate below this threshold. */
export const KILL_THRESHOLD = 0.3;

/** Minimum completed tasks for a valid sprint (N ≥ 30 per #187). */
export const MIN_TASKS = 30;

// ---------------------------------------------------------------------------
// Hit-outcome set (DEC-WI187-006)
// ---------------------------------------------------------------------------

/**
 * Outcomes that count as a cache HIT per #187 semantics.
 * "registry-hit" only. intent-too-broad and result-set-too-large are misses.
 */
const HIT_OUTCOMES: ReadonlySet<string> = new Set(["registry-hit"]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return true iff an event is a cache hit per #187. */
function isHit(event: TelemetryEvent): boolean {
  return HIT_OUTCOMES.has(event.outcome);
}

// ---------------------------------------------------------------------------
// Core join: pair markers + associate events
// ---------------------------------------------------------------------------

/**
 * Join task markers to telemetry events by time window.
 *
 * Algorithm:
 * 1. Collect all begin markers keyed by taskSlug.
 * 2. For each end marker, find its matching begin marker.
 * 3. Assign events whose t falls in [begin.t, end.t] (inclusive).
 *
 * Tasks without a matching end marker are returned as open task slugs.
 * Events outside any task window are counted as orphaned.
 *
 * NOTE: Order-invariant within a task window — events are filtered by
 * timestamp range, not by position in the JSONL file. This satisfies the
 * fast-check property test in bench-b3-aggregator.props.ts.
 *
 * @param markers        - All task markers for the sprint (begin + end).
 * @param allEvents      - All telemetry events (from readTelemetrySessions).
 * @param preSprintSlugs - Optional set of pre-sprint task slugs (DEC-WI187-008 clause 5).
 */
function joinTasksToEvents(
  markers: readonly TaskMarker[],
  allEvents: readonly TelemetryEvent[],
  preSprintSlugs: ReadonlySet<string> | null,
): {
  resolvedTasks: ResolvedTask[];
  orphanedEvents: number;
  openTaskSlugs: string[];
  unlistedTaskSlugs: string[];
} {
  // Index begins by slug (last-write-wins for duplicate slugs — protocol violation).
  const begins = new Map<string, TaskBeginMarker>();
  const ends = new Map<string, TaskEndMarker>();

  for (const marker of markers) {
    if (marker.kind === "task-begin") {
      begins.set(marker.taskSlug, marker);
    } else {
      ends.set(marker.taskSlug, marker);
    }
  }

  // Resolved tasks: slugs that have both begin and end.
  const resolvedTasks: ResolvedTask[] = [];
  const unlistedTaskSlugs: string[] = [];

  for (const [slug, end] of ends) {
    const begin = begins.get(slug);
    if (begin === undefined) continue; // orphan end — no matching begin

    // Assign events within [begin.t, end.t] (inclusive, order-invariant).
    const taskEvents = allEvents.filter((e) => e.t >= begin.t && e.t <= end.t);

    resolvedTasks.push({
      begin,
      end,
      events: taskEvents,
      sessionCrossover: begin.sessionIdAtStart !== end.sessionIdAtEnd,
    });

    // DEC-WI187-008 clause 5: warn on unlisted tasks.
    if (preSprintSlugs !== null && !preSprintSlugs.has(slug)) {
      unlistedTaskSlugs.push(slug);
    }
  }

  // Open tasks: slugs with begin but no end.
  const openTaskSlugs = Array.from(begins.keys()).filter((slug) => !ends.has(slug));

  // Count orphaned events: events not inside any resolved task window.
  const coveredEventTs = new Set<number>();
  for (const task of resolvedTasks) {
    for (const e of task.events) {
      coveredEventTs.add(e.t);
    }
  }
  const orphanedEvents = allEvents.filter((e) => !coveredEventTs.has(e.t)).length;

  return { resolvedTasks, orphanedEvents, openTaskSlugs, unlistedTaskSlugs };
}

// ---------------------------------------------------------------------------
// Per-category aggregation
// ---------------------------------------------------------------------------

/**
 * Compute per-category statistics from resolved tasks.
 *
 * Only completed tasks are counted. Abandoned and blocked tasks are excluded
 * from task count and hit-rate computation (DEC-WI187-008 clause 4).
 */
function aggregatePerCategory(resolvedTasks: readonly ResolvedTask[]): readonly CategoryStats[] {
  const categories: TaskCategory[] = ["boilerplate", "glue", "novel-logic"];
  return categories.map((category) => {
    const categoryTasks = resolvedTasks.filter(
      (t) => t.begin.category === category && t.end.outcome === "completed",
    );
    const taskCount = categoryTasks.length;
    const totalEvents = categoryTasks.reduce((sum, t) => sum + t.events.length, 0);
    const hitEvents = categoryTasks.reduce((sum, t) => sum + t.events.filter(isHit).length, 0);
    const hitRate = totalEvents === 0 ? Number.NaN : hitEvents / totalEvents;
    const targetBar = CATEGORY_PASS_BARS[category];
    // Pass iff hitRate >= targetBar. NaN fails.
    const pass = Number.isFinite(hitRate) && hitRate >= targetBar;

    return {
      category,
      taskCount,
      totalEvents,
      hitEvents,
      hitRate,
      targetBar,
      pass,
    };
  });
}

// ---------------------------------------------------------------------------
// Verdict computation
// ---------------------------------------------------------------------------

function computeVerdict(
  completedTasks: number,
  perCategory: readonly CategoryStats[],
): SprintReport["verdict"] {
  if (completedTasks < MIN_TASKS) return "INSUFFICIENT_DATA";

  const categoriesWithTasks = perCategory.filter((c) => c.taskCount > 0);
  if (categoriesWithTasks.length === 0) return "INSUFFICIENT_DATA";

  const passingCategories = categoriesWithTasks.filter((c) => c.pass);
  const failingCategories = categoriesWithTasks.filter((c) => !c.pass);

  if (failingCategories.length === 0) return "PASS";
  if (passingCategories.length === 0) return "FAIL";
  return "YELLOW";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Aggregate a full sprint report from markers and telemetry events.
 *
 * This function is pure (no I/O). The caller provides data already loaded
 * from disk via readTaskMarkers() and readTelemetrySessions().
 *
 * The aggregator joins tasks to events by time window (order-invariant).
 * Abandoned and blocked tasks are excluded from hit-rate computation.
 * intent-too-broad / result-set-too-large are treated as misses (not hits).
 *
 * @param sprintId       - Sprint identifier (for display).
 * @param markers        - All task markers from readTaskMarkers().
 * @param markerSkipped  - Count of skipped lines from readTaskMarkers().
 * @param allEvents      - Flat list of all telemetry events from readTelemetrySessions().
 * @param preSprintSlugs - Optional set of pre-sprint task slugs for unlisted-task detection.
 * @param now            - Timestamp override for deterministic tests.
 */
export function aggregateSprintReport(
  sprintId: string,
  markers: readonly TaskMarker[],
  markerSkipped: number,
  allEvents: readonly TelemetryEvent[],
  preSprintSlugs: ReadonlySet<string> | null = null,
  now = Date.now(),
): SprintReport {
  const { resolvedTasks, orphanedEvents, openTaskSlugs, unlistedTaskSlugs } = joinTasksToEvents(
    markers,
    allEvents,
    preSprintSlugs,
  );

  const completedTasks = resolvedTasks.filter((t) => t.end.outcome === "completed").length;
  const abandonedTasks = resolvedTasks.filter((t) => t.end.outcome === "abandoned").length;
  const blockedTasks = resolvedTasks.filter((t) => t.end.outcome === "blocked").length;

  const joinedEvents = resolvedTasks.reduce((sum, t) => sum + t.events.length, 0);
  const sessionCrossoverCount = resolvedTasks.filter((t) => t.sessionCrossover).length;

  const perCategory = aggregatePerCategory(resolvedTasks);

  const boilerplateCat = perCategory.find((c) => c.category === "boilerplate");
  const killTriggered =
    boilerplateCat !== undefined &&
    boilerplateCat.taskCount > 0 &&
    Number.isFinite(boilerplateCat.hitRate) &&
    boilerplateCat.hitRate < KILL_THRESHOLD;

  const verdict = computeVerdict(completedTasks, perCategory);

  // Declare count: unique slugs seen in any begin marker.
  const seenSlugs = new Set(markers.filter((m) => m.kind === "task-begin").map((m) => m.taskSlug));

  return {
    sprintId,
    generatedAt: now,
    declaredTasks: seenSlugs.size,
    completedTasks,
    abandonedTasks,
    blockedTasks,
    joinedEvents,
    orphanedEvents,
    sessionCrossoverCount,
    perCategory,
    verdict,
    killTriggered,
    tasks: resolvedTasks,
    markerSkippedLines: markerSkipped,
    openTaskSlugs,
    unlistedTaskSlugs,
  };
}
