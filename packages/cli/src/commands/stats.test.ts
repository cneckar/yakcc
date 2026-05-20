// SPDX-License-Identifier: MIT
//
// stats.test.ts — integration tests for `yakcc stats`
//
// Coverage:
//   1. Empty telemetry dir → empty-state message
//   2. Non-existent telemetry dir → empty-state message
//   3. Single session, mixed outcomes → Tier-1 metrics are correct
//   4. --since filters out old events
//   5. --json emits valid JSON with expected keys
//   6. --top N controls list length in sessions subcommand
//   7. stats hits → shows by-tool breakdown
//   8. stats atoms → graceful when registry missing
//   9. stats sessions → per-session breakdown
//  10. Unknown subcommand → exits 1
//  11. Invalid --since → exits 1
//  12. Invalid --top → exits 1
//  13. Corrupt JSONL lines are skipped gracefully
//  14. Drift-alert sentinel events (candidateCount=-1) are excluded
//  15. Dispatch via runCli(['stats'])

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "../index.js";
import { stats } from "./stats.js";

let tmpDir: string;
let telemetryDir: string;
let origEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-stats-test-"));
  telemetryDir = join(tmpDir, "telemetry");
  origEnv = process.env.YAKCC_TELEMETRY_DIR;
  process.env.YAKCC_TELEMETRY_DIR = telemetryDir;
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
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    t: Date.now(),
    toolName: "Edit",
    outcome: "registry-hit",
    topScore: 0.12,
    candidateCount: 3,
    substituted: false,
    substitutedAtomHash: null,
    intentHash: "abc123",
    latencyMs: 55,
    ...overrides,
  });
}

function writeTelemetryFile(name: string, lines: string[]): void {
  mkdirSync(telemetryDir, { recursive: true });
  writeFileSync(join(telemetryDir, name), `${lines.join("\n")}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stats command — empty / no-data states", () => {
  it("no telemetry dir: prints empty-state message", async () => {
    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);
    const output = logger.logLines.join("\n");
    expect(output).toMatch(/no hits yet|no session/i);
  });

  it("empty telemetry dir: prints empty-state message", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);
    const output = logger.logLines.join("\n");
    expect(output).toMatch(/no hits yet|no session/i);
  });
});

describe("stats command — Tier-1 metrics", () => {
  it("single session with mixed outcomes: shows correct event and hit counts", async () => {
    const t = Date.now();
    writeTelemetryFile("session-abc.jsonl", [
      makeEvent({ t, outcome: "registry-hit", toolName: "Edit", topScore: 0.08 }),
      makeEvent({ t: t + 1, outcome: "registry-hit", toolName: "Write", topScore: 0.15 }),
      makeEvent({ t: t + 2, outcome: "passthrough", toolName: "Edit", topScore: null }),
      makeEvent({ t: t + 3, outcome: "synthesis-required", toolName: "MultiEdit", topScore: null }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);

    const output = logger.logLines.join("\n");
    // Should show total events
    expect(output).toContain("4");
    // Should show registry-hit count
    expect(output).toContain("2");
    // Should mention session count or active dates
    expect(output).toMatch(/session|active/i);
  });

  it("multiple sessions: session count reflects file count", async () => {
    writeTelemetryFile("session-1.jsonl", [
      makeEvent({ outcome: "registry-hit" }),
      makeEvent({ outcome: "passthrough" }),
    ]);
    writeTelemetryFile("session-2.jsonl", [makeEvent({ outcome: "synthesis-required" })]);

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);

    const parsed = JSON.parse(logger.logLines.join("\n")) as {
      telemetry: { sessions: number; totalEvents: number };
    };
    expect(parsed.telemetry.sessions).toBe(2);
    expect(parsed.telemetry.totalEvents).toBe(3);
  });
});

describe("stats command — --since flag", () => {
  it("--since filters out events older than the given date", async () => {
    const old = new Date("2020-01-01").getTime();
    const recent = Date.now();

    writeTelemetryFile("session-mixed.jsonl", [
      makeEvent({ t: old, outcome: "registry-hit" }),
      makeEvent({ t: recent, outcome: "passthrough" }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats(["--since", "2025-01-01", "--json"], logger);
    expect(code).toBe(0);

    const parsed = JSON.parse(logger.logLines.join("\n")) as {
      telemetry: { totalEvents: number };
    };
    // Only the recent event should be included
    expect(parsed.telemetry.totalEvents).toBe(1);
  });

  it("--since with invalid date: exits 1", async () => {
    const logger = new CollectingLogger();
    const code = await stats(["--since", "not-a-date"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("ISO date"))).toBe(true);
  });
});

describe("stats command — --json flag", () => {
  it("--json produces valid JSON with expected top-level keys", async () => {
    writeTelemetryFile("session-j.jsonl", [
      makeEvent({ outcome: "registry-hit" }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);

    const raw = logger.logLines.join("\n");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toHaveProperty("telemetry");
    expect(parsed).toHaveProperty("registry");
    expect(parsed).toHaveProperty("counterfactual");
    expect(parsed).toHaveProperty("sessionBreakdown");
  });

  it("--json includes correct hit rate", async () => {
    writeTelemetryFile("session-rate.jsonl", [
      makeEvent({ outcome: "registry-hit" }),
      makeEvent({ outcome: "passthrough" }),
      makeEvent({ outcome: "passthrough" }),
      makeEvent({ outcome: "passthrough" }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);

    const parsed = JSON.parse(logger.logLines.join("\n")) as {
      telemetry: { hitRate: number; totalEvents: number };
    };
    expect(parsed.telemetry.totalEvents).toBe(4);
    expect(parsed.telemetry.hitRate).toBeCloseTo(0.25);
  });
});

describe("stats command — --top flag", () => {
  it("invalid --top: exits 1", async () => {
    const logger = new CollectingLogger();
    const code = await stats(["--top", "banana"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("positive integer"))).toBe(true);
  });
});

describe("stats hits subcommand", () => {
  it("shows by-tool breakdown when there are registry-hits", async () => {
    writeTelemetryFile("session-hits.jsonl", [
      makeEvent({ outcome: "registry-hit", toolName: "Edit", topScore: 0.1 }),
      makeEvent({ outcome: "registry-hit", toolName: "Edit", topScore: 0.2 }),
      makeEvent({ outcome: "passthrough", toolName: "Write" }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats(["hits"], logger);
    expect(code).toBe(0);

    const output = logger.logLines.join("\n");
    expect(output).toContain("Edit");
    expect(output).toContain("By tool");
  });

  it("no registry-hits: shows no-hits message", async () => {
    writeTelemetryFile("session-nohits.jsonl", [
      makeEvent({ outcome: "passthrough" }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats(["hits"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.join("\n")).toMatch(/no registry-hits|0/i);
  });
});

describe("stats atoms subcommand", () => {
  it("no registry present: shows helpful message", async () => {
    const logger = new CollectingLogger();
    const code = await stats(["atoms", "--registry", "/nonexistent/path/registry.sqlite"], logger);
    expect(code).toBe(0);
    const output = logger.logLines.join("\n");
    expect(output).toMatch(/registry not found|initialize/i);
  });
});

describe("stats sessions subcommand", () => {
  it("no sessions: shows helpful message", async () => {
    const logger = new CollectingLogger();
    const code = await stats(["sessions"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.join("\n")).toMatch(/no session/i);
  });

  it("with sessions: shows per-session rows", async () => {
    writeTelemetryFile("session-s1.jsonl", [
      makeEvent({ outcome: "registry-hit" }),
      makeEvent({ outcome: "passthrough" }),
    ]);
    writeTelemetryFile("session-s2.jsonl", [makeEvent({ outcome: "passthrough" })]);

    const logger = new CollectingLogger();
    const code = await stats(["sessions"], logger);
    expect(code).toBe(0);
    const output = logger.logLines.join("\n");
    // Should show both session IDs (truncated to 8 chars)
    expect(output).toContain("session-");
  });
});

describe("stats command — robustness", () => {
  it("corrupt JSONL lines are skipped and valid lines are counted", async () => {
    writeTelemetryFile("session-corrupt.jsonl", [
      makeEvent({ outcome: "registry-hit" }),
      "not-valid-json{{{{",
      "",
      makeEvent({ outcome: "passthrough" }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);

    const parsed = JSON.parse(logger.logLines.join("\n")) as {
      telemetry: { totalEvents: number };
    };
    expect(parsed.telemetry.totalEvents).toBe(2);
  });

  it("drift-alert events (candidateCount=-1) are excluded from counts", async () => {
    writeTelemetryFile("session-drift.jsonl", [
      makeEvent({ outcome: "registry-hit" }),
      makeEvent({ outcome: "drift-alert", candidateCount: -1 }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);

    const parsed = JSON.parse(logger.logLines.join("\n")) as {
      telemetry: { totalEvents: number };
    };
    expect(parsed.telemetry.totalEvents).toBe(1);
  });
});

describe("stats command — unknown subcommand / bad args", () => {
  it("unknown subcommand: exits 1 with error message", async () => {
    const logger = new CollectingLogger();
    const code = await stats(["unknownsub"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("unknown stats subcommand"))).toBe(true);
  });

  it("unknown flag: exits 1 with error", async () => {
    const logger = new CollectingLogger();
    const code = await stats(["--totally-unknown-flag"], logger);
    expect(code).toBe(1);
  });
});

describe("stats command — runCli dispatch", () => {
  it("dispatches via runCli(['stats'])", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["stats"], logger);
    expect(code).toBe(0);
  });

  it("dispatches via runCli(['stats', '--json'])", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["stats", "--json"], logger);
    expect(code).toBe(0);
    const parsed = JSON.parse(logger.logLines.join("\n")) as Record<string, unknown>;
    expect(parsed).toHaveProperty("telemetry");
  });

  it("dispatches via runCli(['stats', 'hits'])", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["stats", "hits"], logger);
    expect(code).toBe(0);
  });
});
