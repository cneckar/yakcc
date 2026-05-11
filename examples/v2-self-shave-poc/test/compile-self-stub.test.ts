// SPDX-License-Identifier: MIT
// compile-self-stub.test.ts — T3: compile-self stub smoke test.
//
// T3 (Evaluation Contract): Spawns the `compile-self` command via runCli
// in-process (not a subprocess), asserts exit code is 2 (not-yet-implemented),
// and asserts the printed help mentions both "A2" and "A3" slice labels.
//
// Per DEC-V2-COMPILE-SELF-EXIT-CODE-001: exit code 2 = recognized command,
// feature not yet implemented. The stub prints no filesystem output.
//
// Uses CollectingLogger from @yakcc/cli — no mocks (Sacred Practice #5).

import { CollectingLogger, runCli } from "@yakcc/cli";
import { describe, expect, it } from "vitest";

describe("yakcc compile-self — A1 stub (T3)", () => {
  it("exits with code 2 (DEC-V2-COMPILE-SELF-EXIT-CODE-001)", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["compile-self"], logger);
    expect(code).toBe(2);
  });

  it("prints a message that mentions A2 and A3 slice labels", async () => {
    const logger = new CollectingLogger();
    await runCli(["compile-self"], logger);
    // The help/status message must name both A2 and A3 so the trail
    // back to WI-V2-CORPUS-AND-COMPILE-SELF-EQ is preserved.
    const allOutput = [...logger.logLines, ...logger.errLines].join("\n");
    expect(allOutput).toContain("A2");
    expect(allOutput).toContain("A3");
  });

  it("performs no filesystem writes (no side effects)", async () => {
    // We can verify this by checking that no files are written to a temp dir
    // if we pass --out (compile-self A1 ignores all args and exits immediately).
    // The command receives the full argv but the stub exits before any I/O.
    const logger = new CollectingLogger();
    const code = await runCli(["compile-self", "--out", "/tmp/should-not-exist"], logger);
    expect(code).toBe(2);
    // No files should have been written.
    const { existsSync } = await import("node:fs");
    expect(existsSync("/tmp/should-not-exist")).toBe(false);
  });

  it("does not open the registry (DEC-V2-COMPILE-SELF-EXIT-CODE-001: zero side effects)", async () => {
    // The stub exits before any registry operation. Passing a nonexistent
    // registry path must not cause an error — it's never opened.
    const logger = new CollectingLogger();
    const code = await runCli(
      ["compile-self", "--registry", "/nonexistent/path/registry.sqlite"],
      logger,
    );
    expect(code).toBe(2);
    // No error about registry opening should appear.
    const errorOutput = logger.errLines.join("\n");
    expect(errorOutput).not.toContain("failed to open registry");
  });
});
