// SPDX-License-Identifier: MIT
//
// telemetry.test.ts — integration tests for `yakcc telemetry`
//
// Tests:
//   1. --path prints the resolved telemetry directory (honouring YAKCC_TELEMETRY_DIR).
//   2. Default listing when no sessions exist: prints dir + empty state message.
//   3. Default listing with session files: prints file names, event counts, timestamps.
//   4. --tail N: prints last N events from the newest session file.
//   5. --tail with invalid value: exits 1 with error.
//   6. Unknown flag: exits 1 with error.
//   7. Dispatch via runCli().

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "../index.js";
import { telemetry } from "./telemetry.js";

let tmpDir: string;
let telemetryDir: string;
let origEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-telemetry-test-"));
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

describe("telemetry command", () => {
  it("--path prints the resolved telemetry directory", async () => {
    const logger = new CollectingLogger();
    const code = await telemetry(["--path"], logger);
    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(1);
    expect(logger.logLines[0]).toBe(telemetryDir);
  });

  it("default listing when directory does not exist: prints dir + empty message", async () => {
    const logger = new CollectingLogger();
    const code = await telemetry([], logger);
    expect(code).toBe(0);
    expect(logger.logLines.join("\n")).toContain(telemetryDir);
    expect(logger.logLines.join("\n")).toContain("no sessions yet");
  });

  it("default listing when directory exists but is empty: prints dir + empty message", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    const logger = new CollectingLogger();
    const code = await telemetry([], logger);
    expect(code).toBe(0);
    expect(logger.logLines.join("\n")).toContain("no session files yet");
  });

  it("default listing with session files: shows file names and event counts", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    const sessionFile = join(telemetryDir, "session-abc.jsonl");
    const events = `${[
      '{"t":1000,"outcome":"passthrough","toolName":"Edit"}',
      '{"t":2000,"outcome":"registry-hit","toolName":"Write"}',
    ].join("\n")}\n`;
    writeFileSync(sessionFile, events, "utf-8");

    const logger = new CollectingLogger();
    const code = await telemetry([], logger);
    expect(code).toBe(0);
    const output = logger.logLines.join("\n");
    expect(output).toContain("session-abc.jsonl");
    expect(output).toContain("2 events");
    expect(output).toContain("yakcc telemetry --tail");
  });

  it("--tail N: prints last N lines from newest session", async () => {
    mkdirSync(telemetryDir, { recursive: true });
    const lines = [
      '{"t":1,"outcome":"passthrough"}',
      '{"t":2,"outcome":"registry-hit"}',
      '{"t":3,"outcome":"synthesis-required"}',
    ];
    writeFileSync(join(telemetryDir, "session-xyz.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const logger = new CollectingLogger();
    const code = await telemetry(["--tail", "2"], logger);
    expect(code).toBe(0);
    expect(logger.logLines).toHaveLength(2);
    expect(logger.logLines[0]).toBe(lines[1]);
    expect(logger.logLines[1]).toBe(lines[2]);
  });

  it("--tail with invalid value: exits 1 with error message", async () => {
    const logger = new CollectingLogger();
    const code = await telemetry(["--tail", "banana"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("positive integer"))).toBe(true);
  });

  it("unknown flag: exits 1 with error message", async () => {
    const logger = new CollectingLogger();
    const code = await telemetry(["--unknown-flag"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.length).toBeGreaterThan(0);
  });

  it("dispatches via runCli(['telemetry', '--path'])", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["telemetry", "--path"], logger);
    expect(code).toBe(0);
    expect(logger.logLines[0]).toBe(telemetryDir);
  });
});
