// SPDX-License-Identifier: MIT
//
// stats.test.ts — integration tests for `yakcc stats`
//
// Tests:
//   1. Empty-state UX: no telemetry → friendly message.
//   2. Overview: Tier-1 metrics from synthetic JSONL.
//   3. --json: structured object with expected fields.
//   4. --since: filters events before the cutoff.
//   5. Corrupt JSONL lines are silently skipped.
//   6. `yakcc stats hits` subcommand.
//   7. `yakcc stats atoms` subcommand — no registry → graceful message.
//   8. `yakcc stats sessions` subcommand.
//   9. Unknown flag exits 1.
//  10. Dispatch via runCli().

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "../index.js";
import { stats } from "./stats.js";

let tmpDir: string;
let telemetryDir: string;
let origTelEnv: string | undefined;

function makeEvent(overrides: Record<string, unknown> = {}): string {
  const base = {
    t: Date.now(),
    intentHash: "abc123",
    toolName: "Edit",
    candidateCount: 3,
    topScore: 0.12,
    substituted: false,
    substitutedAtomHash: null,
    latencyMs: 45,
    outcome: "registry-hit",
  };
  return JSON.stringify({ ...base, ...overrides });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-stats-test-"));
  telemetryDir = join(tmpDir, "telemetry");
  origTelEnv = process.env.YAKCC_TELEMETRY_DIR;
  process.env.YAKCC_TELEMETRY_DIR = telemetryDir;
});

afterEach(() => {
  if (origTelEnv === undefined) {
    Reflect.deleteProperty(process.env, "YAKCC_TELEMETRY_DIR");
  } else {
    process.env.YAKCC_TELEMETRY_DIR = origTelEnv;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSession(name: string, lines: string[]): void {
  mkdirSync(telemetryDir, { recursive: true });
  writeFileSync(join(telemetryDir, `${name}.jsonl`), `${lines.join("\n")}\n`, "utf-8");
}

describe("stats command", () => {
  it("empty-state: no telemetry → friendly message", async () => {
    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toMatch(/no hits yet|fresh/i);
  });

  it("overview: Tier-1 metrics from synthetic JSONL", async () => {
    writeSession("session-a", [
      makeEvent({ outcome: "registry-hit", toolName: "Edit", topScore: 0.08 }),
      makeEvent({ outcome: "registry-hit", toolName: "Edit", topScore: 0.15 }),
      makeEvent({ outcome: "synthesis-required", toolName: "Write", topScore: null }),
      makeEvent({ outcome: "passthrough", toolName: "MultiEdit", topScore: null }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("total events");
    expect(out).toContain("registry-hit");
    expect(out).toContain("synthesis-required");
    expect(out).toContain("passthrough");
    expect(out).toContain("lifetime");
  });

  it("overview: correct hit count and percentages", async () => {
    writeSession("session-b", [
      makeEvent({ outcome: "registry-hit" }),
      makeEvent({ outcome: "registry-hit" }),
      makeEvent({ outcome: "passthrough" }),
      makeEvent({ outcome: "passthrough" }),
      makeEvent({ outcome: "passthrough" }),
      makeEvent({ outcome: "passthrough" }),
      makeEvent({ outcome: "passthrough" }),
      makeEvent({ outcome: "passthrough" }),
      makeEvent({ outcome: "passthrough" }),
      makeEvent({ outcome: "passthrough" }),
    ]);
    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    // 2/10 = 20.0%
    expect(out).toContain("20.0%");
  });

  it("--json: emits structured JSON with expected fields", async () => {
    writeSession("session-c", [
      makeEvent({ outcome: "registry-hit", toolName: "Edit" }),
      makeEvent({ outcome: "passthrough", toolName: "Write" }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    const raw = logger.logLines.join("\n");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    expect(obj).toHaveProperty("discovery");
    expect(obj).toHaveProperty("sessions");
    const discovery = obj.discovery as Record<string, unknown>;
    expect(discovery.totalEvents).toBe(2);
    expect(discovery.registryHit).toBe(1);
  });

  it("--since: filters events before the cutoff", async () => {
    const oldTime = new Date("2020-01-01").getTime();
    const newTime = Date.now();
    writeSession("session-d", [
      makeEvent({ outcome: "registry-hit", t: oldTime }),
      makeEvent({ outcome: "passthrough", t: newTime }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats(["--since", "2024-01-01"], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    // Only 1 event (the new one) should be counted
    expect(out).toContain("total events");
    // The old event should be filtered out; passthrough=1, hit=0
    expect(out).not.toMatch(/registry-hit\s+\d+.*[1-9]\d*\s/);
  });

  it("--since: invalid date exits 1 with error", async () => {
    const logger = new CollectingLogger();
    const code = await stats(["--since", "not-a-date"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.join("")).toContain("ISO date");
  });

  it("corrupt JSONL lines are skipped without crashing", async () => {
    writeSession("session-e", [
      makeEvent({ outcome: "registry-hit" }),
      "this is not json {{{",
      makeEvent({ outcome: "passthrough" }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats([], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("total events");
  });

  it("drift-alert sentinel events (candidateCount=-1) are excluded", async () => {
    writeSession("session-f", [
      makeEvent({ outcome: "registry-hit", candidateCount: 3 }),
      makeEvent({ outcome: "drift-alert", candidateCount: -1 }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats(["--json"], logger);
    expect(code).toBe(0);
    const obj = JSON.parse(logger.logLines.join("\n")) as { discovery: { totalEvents: number } };
    // Only the real event should be counted
    expect(obj.discovery.totalEvents).toBe(1);
  });

  it("stats hits: shows per-tool breakdown", async () => {
    writeSession("session-g", [
      makeEvent({ outcome: "registry-hit", toolName: "Edit" }),
      makeEvent({ outcome: "registry-hit", toolName: "Edit" }),
      makeEvent({ outcome: "passthrough", toolName: "Write" }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats(["hits"], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("hits");
    expect(out).toContain("Edit");
  });

  it("stats hits: per-atom counts when substitutedAtomHash present", async () => {
    writeSession("session-h", [
      makeEvent({ outcome: "registry-hit", substitutedAtomHash: "deadbeef" }),
      makeEvent({ outcome: "registry-hit", substitutedAtomHash: "deadbeef" }),
      makeEvent({ outcome: "registry-hit", substitutedAtomHash: "cafebabe" }),
    ]);

    const logger = new CollectingLogger();
    const code = await stats(["hits"], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("deadbeef");
    expect(out).toContain("2 hits");
  });

  it("stats atoms: no registry → graceful message", async () => {
    writeSession("session-i", [makeEvent()]);

    const logger = new CollectingLogger();
    const code = await stats(["atoms", "--registry", "/nonexistent/path/registry.sqlite"], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toMatch(/no registry found/i);
  });

  it("stats sessions: shows session table", async () => {
    writeSession("session-j", [
      makeEvent({ outcome: "registry-hit" }),
      makeEvent({ outcome: "passthrough" }),
    ]);
    writeSession("session-k", [makeEvent({ outcome: "registry-hit" })]);

    const logger = new CollectingLogger();
    const code = await stats(["sessions"], logger);
    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("session-j");
    expect(out).toContain("session-k");
  });

  it("unknown flag exits 1 with error message", async () => {
    const logger = new CollectingLogger();
    const code = await stats(["--unknown-flag-xyz"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.length).toBeGreaterThan(0);
  });

  it("dispatches via runCli(['stats'])", async () => {
    // No telemetry → empty-state message, exit 0
    const logger = new CollectingLogger();
    const code = await runCli(["stats"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.join("")).toMatch(/no hits yet|fresh/i);
  });

  it("dispatches via runCli(['stats', 'hits'])", async () => {
    writeSession("session-l", [makeEvent({ outcome: "registry-hit" })]);
    const logger = new CollectingLogger();
    const code = await runCli(["stats", "hits"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.join("")).toContain("hits");
  });
});
