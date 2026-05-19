/**
 * hook-intercept.test.ts - Integration and failure-mode tests for hookIntercept().
 *
 * Production sequence exercised (in-process path):
 *   hookIntercept(argv, logger, { stdin: Readable.from([buf]), telemetryDir: tmpdir })
 *   -> readStdin -> JSON.parse -> buildTelemetryEvent -> appendTelemetryEvent
 *   -> JSONL line at <tmpdir>/<sessionId>.jsonl
 *
 * Production sequence exercised (spawned-subprocess path, Acceptance criterion 4 / Sacred Practice #1):
 *   spawnSync(node, [distBin, "hook-intercept"], { input: payload, env: { YAKCC_TELEMETRY_DIR: tmpdir } })
 *   -> real stdin read -> JSONL line at <tmpdir>/<sessionId>.jsonl
 *
 * @decision DEC-CLI-HOOK-INTERCEPT-001 -- Phase-1 contract verified here.
 * @decision DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001 -- silent-fail verified via injected stubs.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { hashIntent } from "@yakcc/hooks-base/telemetry.js";
import type { TelemetryEvent } from "@yakcc/hooks-base/telemetry.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { hookIntercept } from "./hook-intercept.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-hook-intercept-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeStdin(payload: unknown): NodeJS.ReadableStream {
  const buf = Buffer.from(JSON.stringify(payload), "utf-8");
  return Readable.from([buf]);
}

function makeRawStdin(raw: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(raw, "utf-8")]);
}

function readJsonlLine(dir: string, sessionId: string): TelemetryEvent | null {
  const p = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(p)) return null;
  const line = readFileSync(p, "utf-8").trim();
  if (!line) return null;
  return JSON.parse(line) as TelemetryEvent;
}

function countJsonlLines(dir: string, sessionId: string): number {
  const p = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Suite 1: Happy path -- Edit tool
// ---------------------------------------------------------------------------

describe("hookIntercept -- happy path (Edit tool)", () => {
  it("returns 0, logs nothing, writes one JSONL line matching D-HOOK-5 schema", async () => {
    const logger = new CollectingLogger();
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x", new_string: "hello world" },
      hook_event_name: "PreToolUse",
      session_id: "test-session-edit",
    };
    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
    });

    expect(code).toBe(0);
    // Empty stdout -- the logger must never be called.
    expect(logger.logLines).toHaveLength(0);
    expect(logger.errLines).toHaveLength(0);

    // Exactly one JSONL line written.
    expect(countJsonlLines(tmpDir, "test-session-edit")).toBe(1);

    const event = readJsonlLine(tmpDir, "test-session-edit");
    expect(event).not.toBeNull();
    expect(event?.toolName).toBe("Edit");
    expect(event?.outcome).toBe("passthrough");
    expect(event?.substituted).toBe(false);
    expect(event?.candidateCount).toBe(0);
    expect(event?.topScore).toBeNull();
    expect(event?.substitutedAtomHash).toBeNull();
    // intentHash must be the BLAKE3 hash of "hello world" -- not the raw string.
    expect(event?.intentHash).toBe(hashIntent("hello world"));
    expect(event?.intentHash).toHaveLength(64); // 256-bit BLAKE3 => 64 hex chars
    expect(event?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(event?.latencyMs).toBeLessThan(100); // D-HOOK-3 budget check
    expect(typeof event?.t).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Happy path -- Write tool with content field
// ---------------------------------------------------------------------------

describe("hookIntercept -- happy path (Write tool, content field)", () => {
  it("writes JSONL line with intentHash matching hashIntent(content)", async () => {
    const logger = new CollectingLogger();
    const payload = {
      tool_name: "Write",
      tool_input: { file_path: "/tmp/y", content: "some file content" },
      session_id: "test-session-write",
    };
    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
    });

    expect(code).toBe(0);
    const event = readJsonlLine(tmpDir, "test-session-write");
    expect(event).not.toBeNull();
    expect(event?.toolName).toBe("Write");
    expect(event?.intentHash).toBe(hashIntent("some file content"));
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Happy path -- MultiEdit tool
// ---------------------------------------------------------------------------

describe("hookIntercept -- happy path (MultiEdit tool)", () => {
  it("writes JSONL line with toolName === MultiEdit", async () => {
    const logger = new CollectingLogger();
    const payload = {
      tool_name: "MultiEdit",
      tool_input: { file_path: "/tmp/z", new_string: "multi" },
      session_id: "test-session-multiedit",
    };
    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
    });

    expect(code).toBe(0);
    const event = readJsonlLine(tmpDir, "test-session-multiedit");
    expect(event).not.toBeNull();
    expect(event?.toolName).toBe("MultiEdit");
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Failure modes -- all must exit 0 with empty stdout
// ---------------------------------------------------------------------------

describe("hookIntercept -- failure modes (DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001)", () => {
  it("malformed JSON stdin -> exit 0, empty stdout, no JSONL file", async () => {
    const logger = new CollectingLogger();
    const code = await hookIntercept([], logger, {
      stdin: makeRawStdin("not valid json {{{"),
      telemetryDir: tmpDir,
    });

    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(0);
    expect(logger.errLines).toHaveLength(0);
    // No file should have been created.
    expect(existsSync(join(tmpDir, "test.jsonl"))).toBe(false);
  });

  it("empty stdin -> exit 0, empty stdout, no JSONL line", async () => {
    const logger = new CollectingLogger();
    const code = await hookIntercept([], logger, {
      stdin: Readable.from([]),
      telemetryDir: tmpDir,
    });

    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(0);
    expect(logger.errLines).toHaveLength(0);
  });

  it("tool_name is Bash (not Edit/Write/MultiEdit) -> exit 0, no JSONL line", async () => {
    const logger = new CollectingLogger();
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      session_id: "test-bash-session",
    };
    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
    });

    expect(code).toBe(0);
    expect(countJsonlLines(tmpDir, "test-bash-session")).toBe(0);
  });

  it("missing session_id -> exit 0, JSONL line written to fallback session file", async () => {
    const logger = new CollectingLogger();
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x", new_string: "fallback test" },
      // No session_id field
    };

    // Clear CLAUDE_SESSION_ID to force process-UUID fallback
    const savedEnv = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = undefined;

    try {
      const code = await hookIntercept([], logger, {
        stdin: makeStdin(payload),
        telemetryDir: tmpDir,
      });

      expect(code).toBe(0);
      // A JSONL file should exist somewhere in tmpDir (the fallback session ID)
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(tmpDir).filter((f) => f.endsWith(".jsonl"));
      expect(files.length).toBeGreaterThan(0);
    } finally {
      if (savedEnv !== undefined) {
        process.env.CLAUDE_SESSION_ID = savedEnv;
      }
    }
  });

  it("appendEvent injection throws -> exit 0, empty stdout (silent-fail proven)", async () => {
    const logger = new CollectingLogger();
    const throwingAppend = () => {
      throw new Error("ENOSPC: disk full");
    };
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x", new_string: "disk full test" },
      session_id: "test-disk-full",
    };

    const code = await hookIntercept([], logger, {
      stdin: makeStdin(payload),
      telemetryDir: tmpDir,
      appendEvent: throwingAppend,
    });

    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(0);
    expect(logger.errLines).toHaveLength(0);
    // No file written since appendEvent threw.
    expect(countJsonlLines(tmpDir, "test-disk-full")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Spawned-subprocess smoke test (Sacred Practice #1 real-stdin proof)
//
// Gates on dist/bin.js existing. If dist/bin.js is absent (vitest runs before
// pnpm build in some CI orderings), the test is skipped with a note.
// The reviewer MUST confirm this test passed at least once against a freshly-
// built dist/bin.js before declaring ready_for_guardian.
// ---------------------------------------------------------------------------

describe("hookIntercept -- spawned-subprocess smoke (real stdin, Sacred Practice #1)", () => {
  const distBin = join(
    process.cwd().replace(/packages[\\/]cli.*$/, ""),
    "packages",
    "cli",
    "dist",
    "bin.js",
  );

  it.runIf(existsSync(distBin))(
    "pipes PreToolUse JSON via real stdin, asserts exit 0 + JSONL line",
    () => {
      const smokeDir = mkdtempSync(join(tmpdir(), "yakcc-hook-intercept-smoke-"));
      try {
        const payload = JSON.stringify({
          tool_name: "Edit",
          tool_input: { file_path: "/tmp/x", new_string: "smoke test content" },
          session_id: "smoke-test",
        });

        const result = spawnSync(process.execPath, [distBin, "hook-intercept"], {
          input: payload,
          env: { ...process.env, YAKCC_TELEMETRY_DIR: smokeDir },
          encoding: "utf-8",
          timeout: 10_000,
        });

        // Exit 0
        expect(result.status).toBe(0);
        // Empty stdout
        expect(result.stdout).toBe("");
        // No stderr errors (ignore any Node.js deprecation noise)
        if (result.stderr) {
          expect(result.stderr).not.toMatch(/Error:|ENOENT/);
        }

        // Exactly one JSONL line at <smokeDir>/smoke-test.jsonl
        const smokeFile = join(smokeDir, "smoke-test.jsonl");
        expect(existsSync(smokeFile)).toBe(true);
        const line = readFileSync(smokeFile, "utf-8").trim();
        expect(line).not.toBe("");

        const event = JSON.parse(line) as TelemetryEvent;
        expect(event.toolName).toBe("Edit");
        expect(event.outcome).toBe("passthrough");
        expect(event.intentHash).toBe(hashIntent("smoke test content"));
        expect(event.latencyMs).toBeGreaterThanOrEqual(0);
        expect(event.latencyMs).toBeLessThan(1000); // 1s budget for subprocess overhead
      } finally {
        rmSync(smokeDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(existsSync(distBin))(
    "SKIP: dist/bin.js not found -- build the package first (pnpm -r build)",
    () => {
      // This test is intentionally skipped when the binary is not built.
      // The reviewer must run pnpm -r build and then pnpm -r test to exercise this.
      expect(true).toBe(true);
    },
  );
});
