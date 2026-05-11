// SPDX-License-Identifier: MIT
// index.test.ts — T5: compile-self dispatch wiring in runCli (A2 update).
//
// T5 (Evaluation Contract): The `compile-self` help text now reflects the A2
// capability (no longer 'A1 scaffold stub, exit 2'). The reviewer must confirm no
// existing dispatch arm was modified other than the updated help-line text.
//
// This file replaces the A1 T4 tests that asserted exit code 2 (stub semantics).
// A2 retires exit-code-2 (DEC-V2-COMPILE-SELF-EXIT-CODE-001 updated).
//
// Verifies:
//   - `compile-self` is reachable via runCli dispatch (DEC-CLI-INDEX-001)
//   - printUsage() output (via --help) lists "compile-self" with updated A2 wording
//   - printUsage() does NOT mention "A1 stub, exit 2" (stub semantics retired)
//   - No collision with the `compile` arm — `compile` still behaves independently
//   - Exit code is NOT 2 for any compile-self invocation (A2 retires the stub)
//
// Uses CollectingLogger — no mocks (Sacred Practice #5, DEC-CLI-LOGGER-001).

import { describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "./index.js";

describe("T5: compile-self dispatch wiring in runCli — A2 (DEC-CLI-INDEX-001)", () => {
  it("runCli(['compile-self']) no longer returns exit code 2 — A1 stub retired", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["compile-self"], logger);
    // A2 replaces the stub: exit 0 (success) or 1 (registry missing) are valid.
    // Exit code 2 ('not yet implemented') is retired in A2.
    expect(code).not.toBe(2);
  });

  it("runCli(['compile-self', '--help']) returns exit code 0 with usage text", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["compile-self", "--help"], logger);
    expect(code).toBe(0);
    const output = logger.logLines.join("\n");
    expect(output).toContain("compile-self");
    expect(output).toContain("--output");
    expect(output).toContain("--registry");
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
    // Must be 0 or 1 (compile path) — never 2 (compile-self stub, retired in A2).
    expect(code).not.toBe(2);
  });

  it("printUsage help text does NOT contain 'A1 scaffold stub, exit 2' (A2 wording updated)", async () => {
    // The A1 help text said 'A1 scaffold stub, exit 2'. A2 must update it.
    const logger = new CollectingLogger();
    await runCli(["--help"], logger);
    const allOutput = logger.logLines.join("\n");
    // The stale stub wording must be gone.
    expect(allOutput).not.toContain("A1 scaffold stub, exit 2");
  });
});

// ---------------------------------------------------------------------------
// DEC-EMBED-MODEL-MIGRATION-001: registry rebuild help-text discoverability
// ---------------------------------------------------------------------------

describe("registry rebuild discoverability — help text (DEC-EMBED-MODEL-MIGRATION-001)", () => {
  /**
   * `registry rebuild` must appear alongside `registry init` in the usage output
   * so users can discover the migration path without reading docs.
   * (Evaluation contract: CLI help-text test asserting the new line is present.)
   */
  it("printUsage includes 'registry rebuild' line alongside 'registry init'", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["--help"], logger);
    expect(code).toBe(0);
    const allOutput = logger.logLines.join("\n");
    expect(allOutput).toContain("registry init");
    expect(allOutput).toContain("registry rebuild");
  });

  it("printUsage includes 'registry rebuild' in -h alias output", async () => {
    const logger = new CollectingLogger();
    await runCli(["-h"], logger);
    const allOutput = logger.logLines.join("\n");
    expect(allOutput).toContain("registry rebuild");
  });
});
