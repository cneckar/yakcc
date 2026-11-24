// SPDX-License-Identifier: Apache-2.0
// `yakcc build --native` (#1333): a two-module program built into an executable and run.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../index.js";

const work = mkdtempSync(join(tmpdir(), "yakcc-build-native-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const has = (tool: string): boolean => spawnSync(tool, ["--version"]).status === 0;
const tools =
  has("llc") && has("clang") && has("cc") && process.platform === "linux" && process.arch === "x64";

describe.skipIf(!tools)("yakcc build --native", () => {
  it("builds a program and its imports into an executable: argv in, stdout and the exit code out", async () => {
    writeFileSync(
      join(work, "greet.ts"),
      "export function greet(name: string): string { return `hello, ${name}`; }\n",
    );
    writeFileSync(
      join(work, "main.ts"),
      'import { greet } from "./greet.js";\nconst args = process.argv.slice(2);\nfor (const a of args) console.log(greet(a));\nprocess.exitCode = args.length;\n',
    );
    const out: string[] = [];
    const logger = { log: (m: string) => out.push(m), error: (m: string) => out.push(`E ${m}`) };
    const code = await runCli(
      ["build", "--native", join(work, "main.ts"), "-o", join(work, "main"), "--root", work],
      logger,
    );
    expect([code, out[0]]).toEqual([
      0,
      expect.stringMatching(/^built .*main from 2 modules \(x86_64-linux\)$/),
    ]);
    const run = spawnSync(join(work, "main"), ["ada", "lovelace"]);
    expect([run.status, run.stdout.toString()]).toEqual([2, "hello, ada\nhello, lovelace\n"]);
  }, 300_000);

  it("refuses without an entry, with the reason", async () => {
    const out: string[] = [];
    const code = await runCli(["build", "--native"], {
      log: (m) => out.push(m),
      error: (m) => out.push(m),
    });
    expect([code, out[0]]).toEqual([1, expect.stringMatching(/needs an entry module/)]);
  });
});
