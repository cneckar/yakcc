// SPDX-License-Identifier: MIT
//
// bench-b3.test.ts — CLI-level integration tests for `yakcc bench b3`.
//
// @decision DEC-WI187-005
// @title CLI tests: task-begin / task-end exit codes, --category validation, report
// @status accepted (WI-187)
// @rationale
//   Tests verify: task-begin / task-end exit codes, --category validation (rejects
//   unknown values), missing required-arg errors, report against a fixture sprint
//   file. Uses real tempdir fs + CollectingLogger (Sacred Practice #5).
//   Cross-reference: PLAN.md §4.5 / #187
//
// Evaluation Contract tests (PLAN.md §7 "bench-b3.test.ts"):
//   - task-begin exit codes
//   - --category validation rejects unknown values
//   - missing required-arg errors (--category, --classifier)
//   - task-end exit codes, --outcome validation
//   - report against a fixture sprint file
//   - report --json produces parseable output
//   - report empty sprint → graceful no-data message
//   - unknown subcommand exits non-zero

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { writeTaskBegin, writeTaskEnd } from "./bench-b3-markers.js";
import { benchB3 } from "./bench-b3.js";

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

let tmpDir: string;
let origEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-b3-cli-test-"));
  origEnv = process.env.YAKCC_TELEMETRY_DIR;
  process.env.YAKCC_TELEMETRY_DIR = tmpDir;
});

afterEach(() => {
  if (origEnv === undefined) {
    Reflect.deleteProperty(process.env, "YAKCC_TELEMETRY_DIR");
  } else {
    process.env.YAKCC_TELEMETRY_DIR = origEnv;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Help / unknown subcommand
// ---------------------------------------------------------------------------

describe("help + unknown subcommand", () => {
  it("bench b3 --help exits 0 with usage text listing all three subcommands", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(["--help"], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("task-begin");
    expect(out).toContain("task-end");
    expect(out).toContain("report");
  });

  it("bench b3 (no args) exits 0 and prints help", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3([], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("task-begin");
  });

  it("bench b3 unknown exits 1 with error message", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(["unknown-cmd"], logger);
    expect(code).toBe(1);
    const errOut = logger.errLines.join("\n");
    expect(errOut).toContain("unknown bench b3 subcommand");
    expect(errOut).toContain("unknown-cmd");
  });
});

// ---------------------------------------------------------------------------
// task-begin
// ---------------------------------------------------------------------------

describe("task-begin", () => {
  it("exits 0 with a valid slug, category, and classifier", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(
      ["task-begin", "implement-auth", "--category", "boilerplate", "--classifier", "alice"],
      logger,
    );
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("task-begin recorded");
    expect(out).toContain("implement-auth");
    expect(out).toContain("boilerplate");
  });

  it("exits 1 when --category is missing", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(["task-begin", "my-task", "--classifier", "alice"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("--category is required");
  });

  it("exits 1 when --classifier is missing", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(["task-begin", "my-task", "--category", "glue"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("--classifier is required");
  });

  it("exits 1 when --category is an unknown value", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(
      ["task-begin", "my-task", "--category", "unknown-cat", "--classifier", "alice"],
      logger,
    );
    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("unknown category");
    expect(logger.errLines.join("\n")).toContain("unknown-cat");
  });

  it("exits 1 when slug is missing", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(
      ["task-begin", "--category", "boilerplate", "--classifier", "alice"],
      logger,
    );
    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("task slug");
  });

  it("exits 1 when slug fails validation (uppercase letters)", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(
      ["task-begin", "MyTask", "--category", "boilerplate", "--classifier", "alice"],
      logger,
    );
    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("invalid task slug");
  });

  it("accepts all three valid categories", async () => {
    for (const category of ["boilerplate", "glue", "novel-logic"]) {
      const logger = new CollectingLogger();
      const code = await benchB3(
        [
          "task-begin",
          "my-task",
          "--category",
          category,
          "--classifier",
          "alice",
          "--sprint",
          `sprint-${category}`,
        ],
        logger,
      );
      expect(code).toBe(0);
    }
  });

  it("accepts --sprint option for non-default sprint IDs", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(
      [
        "task-begin",
        "my-task",
        "--category",
        "boilerplate",
        "--classifier",
        "alice",
        "--sprint",
        "b3-on",
      ],
      logger,
    );
    expect(code).toBe(0);
    expect(logger.logLines.join("\n")).toContain("sprint=b3-on");
  });

  it("accepts --note option", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(
      [
        "task-begin",
        "my-task",
        "--category",
        "novel-logic",
        "--classifier",
        "alice",
        "--note",
        "edge case",
      ],
      logger,
    );
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// task-end
// ---------------------------------------------------------------------------

describe("task-end", () => {
  it("exits 0 with a valid slug (default outcome = completed)", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(["task-end", "my-task"], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("task-end recorded");
    expect(out).toContain("my-task");
    expect(out).toContain("completed");
  });

  it("exits 0 with --outcome abandoned", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(["task-end", "my-task", "--outcome", "abandoned"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.join("\n")).toContain("abandoned");
  });

  it("exits 1 when --outcome is unknown", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(["task-end", "my-task", "--outcome", "done"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("unknown outcome");
    expect(logger.errLines.join("\n")).toContain("done");
  });

  it("exits 1 when slug is missing", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(["task-end"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("task slug");
  });
});

// ---------------------------------------------------------------------------
// report — empty sprint
// ---------------------------------------------------------------------------

describe("report — empty sprint", () => {
  it("exits 0 with graceful no-data message when sprint has no markers", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(["report", "--sprint", "nonexistent-sprint"], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("No task markers found");
  });

  it("--json on empty sprint exits 0 and emits parseable JSON with zero counts", async () => {
    const logger = new CollectingLogger();
    const code = await benchB3(["report", "--sprint", "empty-sprint", "--json"], logger);
    expect(code).toBe(0);
    const raw = logger.logLines.join("\n").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(parsed.sprint).toBe("empty-sprint");
    const summary = parsed.summary as Record<string, unknown>;
    expect(summary.completedTasks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// report — against a fixture sprint (end-to-end: write markers then report)
// ---------------------------------------------------------------------------

describe("report — fixture sprint (end-to-end)", () => {
  it("produces a text report with pass/fail lines after task-begin + task-end", async () => {
    const sprintId = "fixture-sprint";

    // Write markers using the marker API directly (simulates real CLI invocations).
    writeTaskBegin("setup-db", "boilerplate", "alice", sprintId, null, 1000);
    writeTaskEnd("setup-db", "completed", sprintId, 2000);
    writeTaskBegin("wire-api", "glue", "alice", sprintId, null, 3000);
    writeTaskEnd("wire-api", "completed", sprintId, 4000);

    const logger = new CollectingLogger();
    const code = await benchB3(["report", "--sprint", sprintId], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("B3 cache-hit report");
    expect(out).toContain("boilerplate");
    expect(out).toContain("glue");
    expect(out).toContain("Overall verdict");
    expect(out).toContain("KILL criterion");
  });

  it("--json produces a parseable payload with expected top-level keys", async () => {
    const sprintId = "fixture-json";

    writeTaskBegin("task-a", "boilerplate", "bob", sprintId, null, 1000);
    writeTaskEnd("task-a", "completed", sprintId, 2000);

    const logger = new CollectingLogger();
    const code = await benchB3(["report", "--sprint", sprintId, "--json"], logger);
    expect(code).toBe(0);
    const raw = logger.logLines.join("\n").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(parsed.sprint).toBe(sprintId);
    expect(parsed).toHaveProperty("perCategory");
    expect(parsed).toHaveProperty("verdict");
    expect(parsed).toHaveProperty("kill_triggered");
    expect(parsed).toHaveProperty("tasks");
    const summary = parsed.summary as Record<string, unknown>;
    expect(summary.completedTasks).toBe(1);
    expect(summary.declaredTasks).toBe(1);
  });

  it("shows INSUFFICIENT_DATA verdict when completed tasks < 30", async () => {
    const sprintId = "small-sprint";
    writeTaskBegin("only-task", "boilerplate", "carol", sprintId, null, 1000);
    writeTaskEnd("only-task", "completed", sprintId, 2000);

    const logger = new CollectingLogger();
    const code = await benchB3(["report", "--sprint", sprintId, "--json"], logger);
    expect(code).toBe(0);
    const parsed = JSON.parse(logger.logLines.join("\n").trim()) as Record<string, unknown>;
    expect(parsed.verdict).toBe("INSUFFICIENT_DATA");
  });

  it("report flags open tasks in output", async () => {
    const sprintId = "open-tasks-sprint";
    writeTaskBegin("started-never-ended", "novel-logic", "alice", sprintId, null, 1000);
    // No task-end written.

    const logger = new CollectingLogger();
    const code = await benchB3(["report", "--sprint", sprintId], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("started-never-ended");
  });
});
