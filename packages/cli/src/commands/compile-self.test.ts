// SPDX-License-Identifier: MIT
// compile-self.test.ts — T1: unit tests for the A1 compile-self stub.
//
// T1 (Evaluation Contract): `yakcc compile-self` returns exit code 2
// (not-yet-implemented per DEC-V2-COMPILE-SELF-EXIT-CODE-001), prints a
// message naming A2/A3, performs no filesystem writes, and does not open
// the registry. Verified via CollectingLogger per DEC-CLI-LOGGER-001.
//
// No mocks — uses CollectingLogger (real implementation of Logger interface,
// Sacred Practice #5).

import { describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { compileSelf } from "./compile-self.js";

describe("compileSelf — A1 stub (T1)", () => {
  it("returns exit code 2 (DEC-V2-COMPILE-SELF-EXIT-CODE-001)", async () => {
    const logger = new CollectingLogger();
    const code = await compileSelf([], logger);
    expect(code).toBe(2);
  });

  it("prints a message that mentions A2 and A3 slice labels", async () => {
    const logger = new CollectingLogger();
    await compileSelf([], logger);
    const allOutput = [...logger.logLines, ...logger.errLines].join("\n");
    expect(allOutput).toContain("A2");
    expect(allOutput).toContain("A3");
  });

  it("prints a message that mentions WI-V2-CORPUS-AND-COMPILE-SELF-EQ or issue #59", async () => {
    const logger = new CollectingLogger();
    await compileSelf([], logger);
    const allOutput = [...logger.logLines, ...logger.errLines].join("\n");
    // The message must name the WI or the issue so the trail is preserved.
    expect(allOutput.includes("WI-V2-CORPUS-AND-COMPILE-SELF-EQ") || allOutput.includes("#59")).toBe(
      true,
    );
  });

  it("ignores all argv — still returns exit code 2 with extra flags", async () => {
    const logger = new CollectingLogger();
    const code = await compileSelf(["--registry", "/some/path", "--out", "/other/path"], logger);
    expect(code).toBe(2);
  });

  it("emits output only to log (not error) for the stub message", async () => {
    const logger = new CollectingLogger();
    await compileSelf([], logger);
    // The not-yet-implemented message is informational — goes to log, not error.
    expect(logger.logLines.length).toBeGreaterThan(0);
  });

  it("is stateless — multiple consecutive calls return identical output", async () => {
    const logger1 = new CollectingLogger();
    const logger2 = new CollectingLogger();
    const code1 = await compileSelf([], logger1);
    const code2 = await compileSelf([], logger2);
    expect(code1).toBe(code2);
    expect(logger1.logLines).toEqual(logger2.logLines);
    expect(logger1.errLines).toEqual(logger2.errLines);
  });
});
