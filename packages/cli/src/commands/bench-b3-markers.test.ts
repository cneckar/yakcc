// SPDX-License-Identifier: MIT
//
// bench-b3-markers.test.ts — Unit tests for the B3 task-marker sidecar JSONL writer.
//
// Evaluation Contract tests (PLAN.md §7):
//   - marker JSONL roundtrip (write then read back)
//   - append-only guarantee (multiple writes accumulate correctly)
//   - rejection of malformed input (slug validation, category validation)
//   - readTaskMarkers tolerates corrupt lines (skippedLines count)
//   - resolveMarkerFilePath honours YAKCC_TELEMETRY_DIR
//
// All tests use mkdtempSync + real JSONL files. No fs mocks (Sacred Practice #5).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendMarker,
  isValidCategory,
  isValidOutcome,
  readTaskMarkers,
  resolveMarkerFilePath,
  validateTaskSlug,
  writeTaskBegin,
  writeTaskEnd,
} from "./bench-b3-markers.js";

// ---------------------------------------------------------------------------
// Test environment: redirect YAKCC_TELEMETRY_DIR to a fresh temp dir per test
// ---------------------------------------------------------------------------

let tmpDir: string;
let origEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-b3-markers-test-"));
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
// resolveMarkerFilePath
// ---------------------------------------------------------------------------

describe("resolveMarkerFilePath", () => {
  it("default sprint id produces <telemetryDir>/bench-b3/default.jsonl", () => {
    const p = resolveMarkerFilePath();
    expect(p).toBe(join(tmpDir, "bench-b3", "default.jsonl"));
  });

  it("custom sprint id is used verbatim", () => {
    const p = resolveMarkerFilePath("my-sprint");
    expect(p).toBe(join(tmpDir, "bench-b3", "my-sprint.jsonl"));
  });
});

// ---------------------------------------------------------------------------
// isValidCategory / isValidOutcome / validateTaskSlug
// ---------------------------------------------------------------------------

describe("isValidCategory", () => {
  it("accepts all three valid categories", () => {
    expect(isValidCategory("boilerplate")).toBe(true);
    expect(isValidCategory("glue")).toBe(true);
    expect(isValidCategory("novel-logic")).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isValidCategory("unknown")).toBe(false);
    expect(isValidCategory("")).toBe(false);
    expect(isValidCategory("BOILERPLATE")).toBe(false);
  });
});

describe("isValidOutcome", () => {
  it("accepts all three valid outcomes", () => {
    expect(isValidOutcome("completed")).toBe(true);
    expect(isValidOutcome("abandoned")).toBe(true);
    expect(isValidOutcome("blocked")).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isValidOutcome("done")).toBe(false);
    expect(isValidOutcome("")).toBe(false);
  });
});

describe("validateTaskSlug", () => {
  it("accepts valid kebab-case slugs", () => {
    expect(validateTaskSlug("implement-user-creation")).toBeNull();
    expect(validateTaskSlug("task1")).toBeNull();
    expect(validateTaskSlug("a")).toBeNull();
    expect(validateTaskSlug("setup-db-migration")).toBeNull();
  });

  it("rejects empty slug", () => {
    expect(validateTaskSlug("")).not.toBeNull();
  });

  it("rejects slugs with whitespace", () => {
    expect(validateTaskSlug("my task")).not.toBeNull();
    expect(validateTaskSlug("my\ttask")).not.toBeNull();
  });

  it("rejects slugs with uppercase letters", () => {
    expect(validateTaskSlug("MyTask")).not.toBeNull();
  });

  it("rejects slugs starting with a hyphen", () => {
    expect(validateTaskSlug("-bad")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// appendMarker / writeTaskBegin / writeTaskEnd
// ---------------------------------------------------------------------------

describe("writeTaskBegin + writeTaskEnd roundtrip", () => {
  it("writes a begin marker and reads it back", () => {
    const marker = writeTaskBegin("implement-auth", "boilerplate", "alice", "default", null, 1000);

    const { markers, skippedLines } = readTaskMarkers("default");
    expect(skippedLines).toBe(0);
    expect(markers).toHaveLength(1);
    const m = markers[0];
    expect(m?.kind).toBe("task-begin");
    if (m?.kind === "task-begin") {
      expect(m.taskSlug).toBe("implement-auth");
      expect(m.category).toBe("boilerplate");
      expect(m.classifier).toBe("alice");
      expect(m.t).toBe(1000);
      expect(m.note).toBeNull();
    }

    // Return value matches what was written
    expect(marker.taskSlug).toBe("implement-auth");
    expect(marker.category).toBe("boilerplate");
  });

  it("writes begin + end pair and both are readable", () => {
    writeTaskBegin("refactor-query", "glue", "bob", "default", null, 2000);
    writeTaskEnd("refactor-query", "completed", "default", 2500);

    const { markers, skippedLines } = readTaskMarkers("default");
    expect(skippedLines).toBe(0);
    expect(markers).toHaveLength(2);

    const begin = markers[0];
    const end = markers[1];
    expect(begin?.kind).toBe("task-begin");
    expect(end?.kind).toBe("task-end");
    if (end?.kind === "task-end") {
      expect(end.taskSlug).toBe("refactor-query");
      expect(end.outcome).toBe("completed");
      expect(end.t).toBe(2500);
    }
  });

  it("append-only: multiple tasks accumulate in one file", () => {
    writeTaskBegin("task-a", "boilerplate", "alice", "sprint1", null, 1000);
    writeTaskEnd("task-a", "completed", "sprint1", 1100);
    writeTaskBegin("task-b", "glue", "alice", "sprint1", null, 2000);
    writeTaskEnd("task-b", "abandoned", "sprint1", 2100);

    const { markers, skippedLines } = readTaskMarkers("sprint1");
    expect(skippedLines).toBe(0);
    expect(markers).toHaveLength(4);
    expect(markers.map((m) => m.taskSlug)).toEqual(["task-a", "task-a", "task-b", "task-b"]);
  });

  it("writes with a note when provided", () => {
    writeTaskBegin("add-logging", "novel-logic", "carol", "default", "tricky edge case", 3000);
    const { markers } = readTaskMarkers("default");
    const m = markers[0];
    if (m?.kind === "task-begin") {
      expect(m.note).toBe("tricky edge case");
    }
  });

  it("records abandoned outcome correctly", () => {
    writeTaskBegin("spike-auth", "novel-logic", "dave", "default", null, 4000);
    writeTaskEnd("spike-auth", "abandoned", "default", 4500);

    const { markers } = readTaskMarkers("default");
    const end = markers.find((m) => m.kind === "task-end");
    if (end?.kind === "task-end") {
      expect(end.outcome).toBe("abandoned");
    }
  });

  it("uses different sprint IDs for different files", () => {
    writeTaskBegin("task-on", "boilerplate", "alice", "b3-on", null, 1000);
    writeTaskBegin("task-off", "boilerplate", "alice", "b3-off", null, 2000);

    const { markers: onMarkers } = readTaskMarkers("b3-on");
    const { markers: offMarkers } = readTaskMarkers("b3-off");

    expect(onMarkers).toHaveLength(1);
    expect(offMarkers).toHaveLength(1);
    expect(onMarkers[0]?.taskSlug).toBe("task-on");
    expect(offMarkers[0]?.taskSlug).toBe("task-off");
  });
});

// ---------------------------------------------------------------------------
// readTaskMarkers — empty and corrupt cases
// ---------------------------------------------------------------------------

describe("readTaskMarkers — empty state", () => {
  it("returns empty markers when sprint file does not exist", () => {
    const { markers, skippedLines } = readTaskMarkers("nonexistent-sprint");
    expect(markers).toHaveLength(0);
    expect(skippedLines).toBe(0);
  });
});

describe("readTaskMarkers — corrupt / malformed lines", () => {
  it("counts corrupt JSON lines as skipped and continues", () => {
    // Write a valid marker file with one corrupt line interspersed.
    const filePath = resolveMarkerFilePath("corrupt-test");
    // Manually create the directory and file with a mix of valid + corrupt lines.
    // mkdirSync is imported at the top of the file
    mkdirSync(filePath.substring(0, filePath.lastIndexOf("/")), { recursive: true });

    const validBegin = JSON.stringify({
      kind: "task-begin",
      t: 1000,
      taskSlug: "my-task",
      category: "boilerplate",
      classifier: "alice",
      sessionIdAtStart: "sess-1",
      note: null,
    });
    const corruptLine = "NOT VALID JSON {{{";
    const validEnd = JSON.stringify({
      kind: "task-end",
      t: 2000,
      taskSlug: "my-task",
      outcome: "completed",
      sessionIdAtEnd: "sess-1",
    });

    writeFileSync(filePath, `${validBegin}\n${corruptLine}\n${validEnd}\n`, "utf-8");

    const { markers, skippedLines } = readTaskMarkers("corrupt-test");
    expect(skippedLines).toBe(1);
    expect(markers).toHaveLength(2);
  });

  it("skips structurally invalid JSON objects (missing required fields)", () => {
    const filePath = resolveMarkerFilePath("invalid-struct");
    // mkdirSync is imported at the top of the file
    mkdirSync(filePath.substring(0, filePath.lastIndexOf("/")), { recursive: true });

    // Object that parses but lacks required marker fields.
    const invalidObj = JSON.stringify({ kind: "unknown-kind", foo: "bar" });
    const validBegin = JSON.stringify({
      kind: "task-begin",
      t: 1000,
      taskSlug: "my-task",
      category: "glue",
      classifier: "bob",
      sessionIdAtStart: "sess-2",
      note: null,
    });

    writeFileSync(filePath, `${invalidObj}\n${validBegin}\n`, "utf-8");

    const { markers, skippedLines } = readTaskMarkers("invalid-struct");
    expect(skippedLines).toBe(1);
    expect(markers).toHaveLength(1);
  });

  it("ignores blank lines without incrementing skippedLines", () => {
    const filePath = resolveMarkerFilePath("blank-lines");
    // mkdirSync is imported at the top of the file
    mkdirSync(filePath.substring(0, filePath.lastIndexOf("/")), { recursive: true });

    const validBegin = JSON.stringify({
      kind: "task-begin",
      t: 1000,
      taskSlug: "my-task",
      category: "novel-logic",
      classifier: "carol",
      sessionIdAtStart: "sess-3",
      note: null,
    });

    // Trailing blank line + empty lines between records.
    writeFileSync(filePath, `\n${validBegin}\n\n`, "utf-8");

    const { markers, skippedLines } = readTaskMarkers("blank-lines");
    expect(skippedLines).toBe(0);
    expect(markers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// appendMarker directly
// ---------------------------------------------------------------------------

describe("appendMarker", () => {
  it("creates parent directory if it does not exist", () => {
    // The bench-b3/ subdir should not exist yet.
    appendMarker(
      {
        kind: "task-begin",
        t: 5000,
        taskSlug: "direct-write",
        category: "boilerplate",
        classifier: "frank",
        sessionIdAtStart: "sess-direct",
        note: null,
      },
      "direct-sprint",
    );

    const { markers } = readTaskMarkers("direct-sprint");
    expect(markers).toHaveLength(1);
  });
});
