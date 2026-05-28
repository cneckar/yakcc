// SPDX-License-Identifier: MIT
//
// bench-b3-markers.ts — Sidecar task-marker JSONL writer for the B3 cache-hit harness.
//
// @decision DEC-WI187-001
// @title Task-boundary mechanism: CLI markers, not session-id inference
// @status accepted (WI-187)
// @rationale
//   Session IDs are too coarse and too fine for per-task B3 measurement.
//   Explicit CLI task-begin / task-end markers are IDE-agnostic, require
//   zero hook-layer changes, and produce a small auditable log.
//   Cross-reference: PLAN.md §4.1 / #187
//
// @decision DEC-WI187-002
// @title Sidecar JSONL marker schema — fields and discriminator
// @status accepted (WI-187)
// @rationale
//   Two record kinds per task: task-begin (slug, category, classifier,
//   sessionIdAtStart, note) and task-end (slug, outcome, sessionIdAtEnd).
//   JSONL format mirrors the existing telemetry discipline (DEC-HOOK-PHASE-1-001).
//   The `kind` discriminator allows safe schema evolution without breaking readers.
//   Cross-reference: PLAN.md §4.2 / #187
//
// @decision DEC-WI187-003
// @title One file per sprint under bench-b3/ sub-directory
// @status accepted (WI-187)
// @rationale
//   One append-only JSONL per sprint avoids N≥30 per-task files, eliminates
//   directory-scan overhead in the aggregator, and keeps the marker file next
//   to the telemetry event stream under YAKCC_TELEMETRY_DIR.
//   Default sprint ID is the literal "default" — no magic most-recent fallback.
//   Cross-reference: PLAN.md §4.3 / #187
//
// @decision DEC-WI187-004
// @title Zero hook-layer modifications — sidecar only
// @status accepted (WI-187)
// @rationale
//   The harness does not import, monkey-patch, or wrap captureTelemetry or any
//   file under packages/hooks-base/src/. The hook emits session-tagged events;
//   the harness joins them to tasks at report time via readTelemetrySessions().
//   Sacred Practice #12: one cache-event authority (telemetry.ts) + one sidecar
//   authority here.
//   Cross-reference: PLAN.md §4.4 / #187

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveSessionId, resolveTelemetryDir } from "@yakcc/hooks-base/telemetry.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Valid task categories per #187 stratification requirement. */
export type TaskCategory = "boilerplate" | "glue" | "novel-logic";

/** Task outcome values for task-end markers. */
export type TaskOutcome = "completed" | "abandoned" | "blocked";

/**
 * A task-begin marker record (DEC-WI187-002).
 *
 * Written by `yakcc bench b3 task-begin` at the start of each engineering task.
 * The category is pinned at this point — no post-hoc reclassification possible
 * (DEC-WI187-006, DEC-WI187-008 clause 3).
 */
export interface TaskBeginMarker {
  readonly kind: "task-begin";
  /** Unix millisecond timestamp at command run. */
  readonly t: number;
  /** Engineer-provided kebab-case task slug (primary key for joins). */
  readonly taskSlug: string;
  /** Task category, pinned at begin time (DEC-WI187-006). */
  readonly category: TaskCategory;
  /** Independent reviewer identity (classifier ≠ sprinter, per DEC-WI187-008 clause 2). */
  readonly classifier: string;
  /** Session ID from resolveSessionId() at the moment task-begin was called. */
  readonly sessionIdAtStart: string;
  /** Optional free-text annotation. */
  readonly note: string | null;
}

/**
 * A task-end marker record (DEC-WI187-002).
 *
 * Written by `yakcc bench b3 task-end` at the end of each engineering task.
 * Abandoned tasks are excluded from N≥30 count and hit-rate computation
 * (DEC-WI187-008 clause 4).
 */
export interface TaskEndMarker {
  readonly kind: "task-end";
  /** Unix millisecond timestamp at command run. */
  readonly t: number;
  /** Must match the taskSlug from the corresponding task-begin marker. */
  readonly taskSlug: string;
  /** How the task ended. Abandoned → excluded from analysis. */
  readonly outcome: TaskOutcome;
  /** Session ID from resolveSessionId() at the moment task-end was called. */
  readonly sessionIdAtEnd: string;
}

/** Discriminated union of all task marker types. */
export type TaskMarker = TaskBeginMarker | TaskEndMarker;

// ---------------------------------------------------------------------------
// Storage path resolver (DEC-WI187-003)
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the sprint marker JSONL file.
 *
 * Path: `$YAKCC_TELEMETRY_DIR/bench-b3/<sprintId>.jsonl`
 * Default sprint ID: `"default"` (never inferred from state — PLAN.md §7).
 *
 * @param sprintId - Sprint identifier slug (default: "default").
 */
export function resolveMarkerFilePath(sprintId = "default"): string {
  const baseDir = resolveTelemetryDir();
  return join(baseDir, "bench-b3", `${sprintId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Validation helpers (used by CLI layer in bench-b3.ts)
// ---------------------------------------------------------------------------

const VALID_CATEGORIES: ReadonlySet<string> = new Set(["boilerplate", "glue", "novel-logic"]);
const VALID_OUTCOMES: ReadonlySet<string> = new Set(["completed", "abandoned", "blocked"]);

/** Returns true iff the string is a valid TaskCategory. */
export function isValidCategory(value: string): value is TaskCategory {
  return VALID_CATEGORIES.has(value);
}

/** Returns true iff the string is a valid TaskOutcome. */
export function isValidOutcome(value: string): value is TaskOutcome {
  return VALID_OUTCOMES.has(value);
}

/**
 * Validate a task slug. Returns an error message or null if valid.
 *
 * Rules: non-empty, no whitespace, kebab-case (a-z0-9 and hyphens).
 */
export function validateTaskSlug(slug: string): string | null {
  if (slug.length === 0) return "task slug must not be empty";
  if (/\s/.test(slug)) return "task slug must not contain whitespace";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return "task slug must be kebab-case (a-z, 0-9, hyphens; must start with a letter or digit)";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Structural type guard for deserialized markers
// ---------------------------------------------------------------------------

/** Returns true iff an unknown value looks like a TaskBeginMarker. */
function isTaskBeginMarker(v: unknown): v is TaskBeginMarker {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.kind === "task-begin" &&
    typeof r.t === "number" &&
    typeof r.taskSlug === "string" &&
    typeof r.category === "string" &&
    typeof r.classifier === "string" &&
    typeof r.sessionIdAtStart === "string"
  );
}

/** Returns true iff an unknown value looks like a TaskEndMarker. */
function isTaskEndMarker(v: unknown): v is TaskEndMarker {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.kind === "task-end" &&
    typeof r.t === "number" &&
    typeof r.taskSlug === "string" &&
    typeof r.outcome === "string" &&
    typeof r.sessionIdAtEnd === "string"
  );
}

/** Returns true iff an unknown value looks like any valid TaskMarker. */
function isValidMarker(v: unknown): v is TaskMarker {
  return isTaskBeginMarker(v) || isTaskEndMarker(v);
}

// ---------------------------------------------------------------------------
// Low-level I/O
// ---------------------------------------------------------------------------

/**
 * Append a marker record to the sprint JSONL file.
 *
 * Creates the parent directory if it does not exist.
 * Append-only — never truncates. This is the single write authority for
 * task markers (Sacred Practice #12). Mirrors appendTelemetryEvent() semantics.
 *
 * @param marker   - The marker to append.
 * @param sprintId - Sprint identifier (default: "default").
 */
export function appendMarker(marker: TaskMarker, sprintId = "default"): void {
  const filePath = resolveMarkerFilePath(sprintId);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(filePath, `${JSON.stringify(marker)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// High-level write helpers (used by CLI commands)
// ---------------------------------------------------------------------------

/**
 * Build and append a task-begin marker.
 *
 * The session ID is captured at call time via resolveSessionId().
 * Both `category` and `classifier` are required — no silent defaults
 * (DEC-WI187-006, PLAN.md §7 "no silent default").
 *
 * @param taskSlug   - Kebab-case slug for the task.
 * @param category   - Task category (pre-validated by caller).
 * @param classifier - Independent reviewer identity.
 * @param sprintId   - Sprint identifier (default: "default").
 * @param note       - Optional annotation.
 * @param now        - Timestamp override for deterministic tests.
 * @returns The written marker record.
 */
export function writeTaskBegin(
  taskSlug: string,
  category: TaskCategory,
  classifier: string,
  sprintId = "default",
  note: string | null = null,
  now = Date.now(),
): TaskBeginMarker {
  const marker: TaskBeginMarker = {
    kind: "task-begin",
    t: now,
    taskSlug,
    category,
    classifier,
    sessionIdAtStart: resolveSessionId(),
    note,
  };
  appendMarker(marker, sprintId);
  return marker;
}

/**
 * Build and append a task-end marker.
 *
 * @param taskSlug - Must match the corresponding task-begin slug.
 * @param outcome  - How the task ended (pre-validated by caller).
 * @param sprintId - Sprint identifier (default: "default").
 * @param now      - Timestamp override for deterministic tests.
 * @returns The written marker record.
 */
export function writeTaskEnd(
  taskSlug: string,
  outcome: TaskOutcome,
  sprintId = "default",
  now = Date.now(),
): TaskEndMarker {
  const marker: TaskEndMarker = {
    kind: "task-end",
    t: now,
    taskSlug,
    outcome,
    sessionIdAtEnd: resolveSessionId(),
  };
  appendMarker(marker, sprintId);
  return marker;
}

// ---------------------------------------------------------------------------
// Marker file reader (consumed exclusively by bench-b3-aggregator.ts)
// ---------------------------------------------------------------------------

/**
 * Read and parse all task markers from a sprint marker file.
 *
 * - Returns empty when the file does not exist (fresh sprint, no tasks yet).
 * - Corrupt or structurally-invalid lines are counted as skipped.
 * - Lines are returned in file order (append-order = chronological).
 *
 * This is the single read authority for task markers. The aggregator calls
 * this; nothing else should read the marker file directly (Sacred Practice #12).
 *
 * @param sprintId - Sprint identifier (default: "default").
 */
export function readTaskMarkers(sprintId = "default"): {
  readonly markers: readonly TaskMarker[];
  readonly skippedLines: number;
} {
  const filePath = resolveMarkerFilePath(sprintId);
  if (!existsSync(filePath)) {
    return { markers: [], skippedLines: 0 };
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { markers: [], skippedLines: 0 };
  }

  const markers: TaskMarker[] = [];
  let skippedLines = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skippedLines++;
      continue;
    }

    if (isValidMarker(parsed)) {
      markers.push(parsed);
    } else {
      skippedLines++;
    }
  }

  return { markers, skippedLines };
}
