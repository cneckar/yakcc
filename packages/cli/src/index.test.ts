// SPDX-License-Identifier: MIT
// index.test.ts — T4: additive tests confirming compile-self wiring in runCli.
//
// T4 (Evaluation Contract): The `compile-self` command is dispatched by runCli
// and is listed in printUsage() output. No existing test cases are modified —
// this file is additive only.
//
// Verifies:
//   - `compile-self` is reachable via runCli dispatch (DEC-CLI-INDEX-001)
//   - printUsage() output (via --help) lists "compile-self"
//   - No collision with the `compile` arm — `compile` still behaves independently
//
// Uses CollectingLogger — no mocks (Sacred Practice #5, DEC-CLI-LOGGER-001).

import { describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "./index.js";

describe("T4: compile-self dispatch wiring in runCli (DEC-CLI-INDEX-001)", () => {
  it("runCli(['compile-self']) returns exit code 2 (DEC-V2-COMPILE-SELF-EXIT-CODE-001)", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["compile-self"], logger);
    expect(code).toBe(2);
  });

  it("runCli(['compile-self', '--some-flag']) returns exit code 2 — stub ignores all args", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["compile-self", "--some-flag", "value"], logger);
    expect(code).toBe(2);
  });

  it("printUsage lists 'compile-self' in --help output", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["--help"], logger);
    expect(code).toBe(0);
    const allOutput = logger.logLines.join("\n");
    expect(allOutput).toContain("compile-self");
  });

  it("printUsage lists 'compile-self' in -h output (alias)", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["-h"], logger);
    expect(code).toBe(0);
    const allOutput = logger.logLines.join("\n");
    expect(allOutput).toContain("compile-self");
  });

  it("'compile' command is NOT broken by the new 'compile-self' arm (no dispatch collision)", async () => {
    // compile without a required entry arg must still exit 1 (usage error),
    // proving the compile arm is distinct from compile-self.
    const logger = new CollectingLogger();
    const code = await runCli(["compile"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("compile requires"))).toBe(true);
  });

  it("'compile' with a real-looking BlockMerkleRoot is routed to compile, not compile-self", async () => {
    // A fake 64-hex root will hit the compile arm and fail because the
    // registry doesn't contain it — NOT exit code 2 (which would mean it
    // was routed to compile-self instead).
    const fakeRoot = "a".repeat(64);
    const logger = new CollectingLogger();
    const code = await runCli(["compile", fakeRoot], logger);
    // Must be 0 or 1 (compile path) — never 2 (compile-self stub).
    expect(code).not.toBe(2);
  });
});
