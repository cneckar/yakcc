// SPDX-License-Identifier: MIT
//
// bench-b3.ts — CLI handler for `yakcc bench b3 <subcommand>`.
//
// @decision DEC-WI187-005
// @title Reporter shape: yakcc bench b3 — CLI subcommand in packages/cli
// @status accepted (WI-187)
// @rationale
//   The existing yakcc stats and yakcc telemetry commands are the operator's
//   mental model. Adding yakcc bench b3 … is consistent; the engineer needs
//   only one install path. The aggregator is a sibling module (bench-b3-aggregator.ts)
//   so it is unit-testable in isolation. No new package is added to bench/B3-cache-hit/.
//   Cross-reference: PLAN.md §4.5 / #187
//
// @decision DEC-WI187-006
// @title Classification required at task-begin time — no silent default
// @status accepted (WI-187)
// @rationale
//   Both --category and --classifier are required at task-begin time.
//   The CLI exits 1 when either is missing. This prevents the two failure
//   modes documented in PLAN.md §4.6: (a) mid-task reclassification to
//   favour results; (b) forgotten classification producing unusable data.
//   Cross-reference: PLAN.md §4.6 / #187
//
// @decision DEC-WI187-008
// @title Five selection-bias protocol clauses
// @status accepted (WI-187)
// @rationale
//   The CLI enforces: classifier required at task-begin (clause 2),
//   category frozen at task-begin (clause 3), abandoned tasks require
//   explicit --outcome abandoned (clause 4), pre-sprint task list checked
//   when --tasks is provided (clause 5). Clause 1 (task list locked pre-sprint)
//   is enforced by protocol doc, not by this CLI.
//   Cross-reference: PLAN.md §4.8 / #187

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readTelemetrySessions, resolveTelemetryDir } from "@yakcc/hooks-base/telemetry.js";
import type { Logger } from "../index.js";
import { aggregateSprintReport } from "./bench-b3-aggregator.js";
import type { SprintReport } from "./bench-b3-aggregator.js";
import {
  isValidCategory,
  isValidOutcome,
  readTaskMarkers,
  validateTaskSlug,
  writeTaskBegin,
  writeTaskEnd,
} from "./bench-b3-markers.js";

// ---------------------------------------------------------------------------
// JSON schema version (--json output)
// ---------------------------------------------------------------------------

const JSON_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// task-begin handler
// ---------------------------------------------------------------------------

async function handleTaskBegin(argv: readonly string[], logger: Logger): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        category: { type: "string" };
        classifier: { type: "string" };
        sprint: { type: "string" };
        note: { type: "string" };
      };
      allowPositionals: true;
    }>
  >;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        category: { type: "string" },
        classifier: { type: "string" },
        sprint: { type: "string" },
        note: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error(
      "Usage: yakcc bench b3 task-begin <slug> --category <boilerplate|glue|novel-logic> --classifier <name> [--sprint <id>] [--note <text>]",
    );
    return 1;
  }

  const [slug] = parsed.positionals;
  if (!slug) {
    logger.error("error: task-begin requires a task slug as the first positional argument");
    logger.error(
      "Usage: yakcc bench b3 task-begin <slug> --category <boilerplate|glue|novel-logic> --classifier <name>",
    );
    return 1;
  }

  const slugErr = validateTaskSlug(slug);
  if (slugErr !== null) {
    logger.error(`error: invalid task slug: ${slugErr}`);
    return 1;
  }

  const categoryRaw = parsed.values.category;
  if (categoryRaw === undefined) {
    logger.error("error: --category is required (boilerplate | glue | novel-logic)");
    return 1;
  }
  if (!isValidCategory(categoryRaw)) {
    logger.error(
      `error: unknown category "${categoryRaw}". Valid values: boilerplate, glue, novel-logic`,
    );
    return 1;
  }

  const classifierRaw = parsed.values.classifier;
  if (classifierRaw === undefined || classifierRaw.trim().length === 0) {
    logger.error("error: --classifier is required (independent reviewer identity)");
    return 1;
  }

  const sprintId = parsed.values.sprint ?? "default";
  const note = parsed.values.note ?? null;

  const marker = writeTaskBegin(slug, categoryRaw, classifierRaw, sprintId, note);
  logger.log(
    `task-begin recorded: slug="${marker.taskSlug}" category=${marker.category} sprint=${sprintId}`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// task-end handler
// ---------------------------------------------------------------------------

async function handleTaskEnd(argv: readonly string[], logger: Logger): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        outcome: { type: "string" };
        sprint: { type: "string" };
      };
      allowPositionals: true;
    }>
  >;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        outcome: { type: "string" },
        sprint: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error(
      "Usage: yakcc bench b3 task-end <slug> [--outcome completed|abandoned|blocked] [--sprint <id>]",
    );
    return 1;
  }

  const [slug] = parsed.positionals;
  if (!slug) {
    logger.error("error: task-end requires a task slug as the first positional argument");
    logger.error("Usage: yakcc bench b3 task-end <slug> [--outcome completed|abandoned|blocked]");
    return 1;
  }

  const slugErr = validateTaskSlug(slug);
  if (slugErr !== null) {
    logger.error(`error: invalid task slug: ${slugErr}`);
    return 1;
  }

  const outcomeRaw = parsed.values.outcome ?? "completed";
  if (!isValidOutcome(outcomeRaw)) {
    logger.error(
      `error: unknown outcome "${outcomeRaw}". Valid values: completed, abandoned, blocked`,
    );
    return 1;
  }

  const sprintId = parsed.values.sprint ?? "default";

  const marker = writeTaskEnd(slug, outcomeRaw, sprintId);
  logger.log(
    `task-end recorded: slug="${marker.taskSlug}" outcome=${marker.outcome} sprint=${sprintId}`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// report handler
// ---------------------------------------------------------------------------

/** Format a hit rate as a percentage string with one decimal place. */
function fmtPct(rate: number): string {
  if (!Number.isFinite(rate)) return "  n/a ";
  return `${(rate * 100).toFixed(1)}%`;
}

/** Format the human-readable report. */
function printHumanReport(report: SprintReport, logger: Logger): void {
  const {
    sprintId,
    declaredTasks,
    completedTasks,
    abandonedTasks,
    joinedEvents,
    orphanedEvents,
    sessionCrossoverCount,
    perCategory,
    verdict,
    killTriggered,
  } = report;

  logger.log(`B3 cache-hit report — sprint: ${sprintId}`);
  logger.log("=".repeat(50));
  logger.log(`Tasks declared:    ${String(declaredTasks).padStart(4)}`);
  logger.log(
    `Tasks completed:   ${String(completedTasks).padStart(4)}    (abandoned: ${abandonedTasks})`,
  );
  logger.log(`Events joined:     ${String(joinedEvents).padStart(4)}`);
  logger.log(
    `Events orphaned:   ${String(orphanedEvents).padStart(4)}    (outside any task window)`,
  );
  if (sessionCrossoverCount > 0) {
    logger.log(`Session crossover: ${sessionCrossoverCount} task(s)`);
  }
  if (report.openTaskSlugs.length > 0) {
    logger.log(`Open (no task-end): ${report.openTaskSlugs.join(", ")}`);
  }
  if (report.unlistedTaskSlugs.length > 0) {
    logger.log(`Unlisted tasks (not in pre-sprint CSV): ${report.unlistedTaskSlugs.join(", ")}`);
  }
  if (report.markerSkippedLines > 0) {
    logger.log(`Marker lines skipped (malformed): ${report.markerSkippedLines}`);
  }
  logger.log("");
  logger.log("Per category:");

  const barMap: Record<string, string> = {
    boilerplate: "≥60.0%",
    glue: "≥30.0%",
    "novel-logic": "≥10.0%",
  };

  for (const cat of perCategory) {
    const pctStr = fmtPct(cat.hitRate).padEnd(7);
    const bar = barMap[cat.category] ?? "?";
    const passStr = cat.taskCount === 0 ? "no tasks" : cat.pass ? "PASS" : "FAIL";
    logger.log(
      `  ${cat.category.padEnd(12)} (n=${String(cat.taskCount).padStart(2)})  hit rate: ${pctStr}  bar: ${bar}  ${passStr}`,
    );
  }

  logger.log("");
  logger.log(`Overall verdict vs #187 bars: ${verdict}`);
  logger.log(`KILL criterion (<30% boilerplate): ${killTriggered ? "TRIGGERED" : "not triggered"}`);
}

async function handleReport(argv: readonly string[], logger: Logger): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        sprint: { type: "string" };
        json: { type: "boolean" };
        tasks: { type: "string" };
      };
    }>
  >;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        sprint: { type: "string" },
        json: { type: "boolean" },
        tasks: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error("Usage: yakcc bench b3 report [--sprint <id>] [--json] [--tasks <path>]");
    return 1;
  }

  const sprintId = parsed.values.sprint ?? "default";
  const useJson = parsed.values.json === true;
  const tasksPath = parsed.values.tasks;

  // Load pre-sprint task list if provided (DEC-WI187-008 clause 5).
  let preSprintSlugs: Set<string> | null = null;
  if (tasksPath !== undefined) {
    if (!existsSync(tasksPath)) {
      logger.error(`error: --tasks file not found: ${tasksPath}`);
      return 1;
    }
    try {
      const csv = readFileSync(tasksPath, "utf-8");
      preSprintSlugs = new Set(
        csv
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith("#"))
          .map((l) => l.split(",")[0]?.trim() ?? "")
          .filter((s) => s.length > 0),
      );
    } catch (err) {
      logger.error(`error: cannot read --tasks file: ${String(err)}`);
      return 1;
    }
  }

  // Read markers (DEC-WI187-003 — single read authority).
  const { markers, skippedLines } = readTaskMarkers(sprintId);

  // Read telemetry via the canonical seam (DEC-CLI-STATS-READER-SEAM-001).
  // Only read the top-level telemetry dir — bench-b3/ sub-dir contains markers, not session events.
  const telemetryDir = resolveTelemetryDir();
  const sessions = readTelemetrySessions(telemetryDir);
  const allEvents = sessions.flatMap((s) => s.events);

  const report = aggregateSprintReport(sprintId, markers, skippedLines, allEvents, preSprintSlugs);

  if (useJson) {
    const jsonOut = {
      version: JSON_SCHEMA_VERSION,
      generatedAt: report.generatedAt,
      sprint: report.sprintId,
      summary: {
        declaredTasks: report.declaredTasks,
        completedTasks: report.completedTasks,
        abandonedTasks: report.abandonedTasks,
        blockedTasks: report.blockedTasks,
        joinedEvents: report.joinedEvents,
        orphanedEvents: report.orphanedEvents,
        sessionCrossoverCount: report.sessionCrossoverCount,
        markerSkippedLines: report.markerSkippedLines,
        openTaskSlugs: report.openTaskSlugs,
        unlistedTaskSlugs: report.unlistedTaskSlugs,
      },
      perCategory: report.perCategory.map((c) => ({
        category: c.category,
        taskCount: c.taskCount,
        totalEvents: c.totalEvents,
        hitEvents: c.hitEvents,
        hitRate: Number.isFinite(c.hitRate) ? c.hitRate : null,
        targetBar: c.targetBar,
        pass: c.pass,
      })),
      tasks: report.tasks.map((t) => ({
        taskSlug: t.begin.taskSlug,
        category: t.begin.category,
        classifier: t.begin.classifier,
        outcome: t.end.outcome,
        beginT: t.begin.t,
        endT: t.end.t,
        sessionCrossover: t.sessionCrossover,
        eventCount: t.events.length,
        hitCount: t.events.filter((e) => e.outcome === "registry-hit").length,
        hitRate:
          t.events.length > 0
            ? t.events.filter((e) => e.outcome === "registry-hit").length / t.events.length
            : null,
        note: t.begin.note,
      })),
      verdict: report.verdict,
      kill_triggered: report.killTriggered,
    };
    logger.log(JSON.stringify(jsonOut));
    return 0;
  }

  if (markers.length === 0) {
    logger.log(`No task markers found for sprint "${sprintId}".`);
    logger.log(
      `Run 'yakcc bench b3 task-begin <slug> --category <cat> --classifier <name>' to start recording tasks.`,
    );
    return 0;
  }

  printHumanReport(report, logger);
  return 0;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printBenchB3Help(logger: Logger): void {
  logger.log(`yakcc bench b3 — B3 cache-hit telemetry harness (#187)

SUBCOMMANDS
  task-begin <slug> --category <cat> --classifier <name>
                    [--sprint <id>]  [--note <text>]
      Record the start of an engineering task. <slug> must be kebab-case.
      --category: boilerplate | glue | novel-logic  (required, frozen at begin)
      --classifier: independent reviewer identity   (required, distinct from sprinter)
      --sprint: sprint identifier slug (default: "default")

  task-end <slug> [--outcome completed|abandoned|blocked]
                  [--sprint <id>]
      Record the end of an engineering task.
      --outcome: defaults to "completed". Abandoned tasks are excluded from N and hit rate.

  report [--sprint <id>] [--json] [--tasks <path>]
      Aggregate and display the sprint cache-hit report.
      --sprint: sprint identifier (default: "default")
      --json:   emit machine-readable JSON (schema v1)
      --tasks:  path to pre-sprint task CSV for unlisted-task detection

WORKFLOW
  1. Before sprint: prepare tasks.csv with slug,category,classifier columns.
  2. For each task: yakcc bench b3 task-begin <slug> --category <cat> --classifier <name>
     ... run IDE with yakcc hooks installed ...
  3. After each task: yakcc bench b3 task-end <slug>
  4. After sprint: yakcc bench b3 report --sprint <id>

  See bench/B3-cache-hit/PROTOCOL.md for the full sprint procedure.

EXIT CODES
  0  success
  1  usage or runtime error
`);
}

// ---------------------------------------------------------------------------
// Top-level bench b3 dispatcher
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc bench b3 <subcommand> [args]`.
 *
 * Dispatches to task-begin / task-end / report based on the first positional.
 * Relies on the marker writer (bench-b3-markers.ts) and aggregator
 * (bench-b3-aggregator.ts) as sibling modules.
 *
 * @param argv   - Args after "bench b3" have been consumed from process.argv.
 * @param logger - Output sink.
 */
export async function benchB3(argv: readonly string[], logger: Logger): Promise<number> {
  const [subcommand, ...rest] = argv;

  if (subcommand === "--help" || subcommand === "-h" || subcommand === undefined) {
    printBenchB3Help(logger);
    return 0;
  }

  switch (subcommand) {
    case "task-begin":
      return handleTaskBegin(rest, logger);
    case "task-end":
      return handleTaskEnd(rest, logger);
    case "report":
      return handleReport(rest, logger);
    default:
      logger.error(
        `error: unknown bench b3 subcommand: "${subcommand}". Valid subcommands: task-begin, task-end, report`,
      );
      logger.error("Run 'yakcc bench b3 --help' for usage.");
      return 1;
  }
}
