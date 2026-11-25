// SPDX-License-Identifier: Apache-2.0
/**
 * Node's own library run natively (#1331, #1361 P2): a program record of the entry and the builtin
 * modules it requires (per_context/primordials, internal/errors, internal/util, …, read from the
 * vendored v22.23.5 lib), built and run; its output is Node's.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { canRun } from "./__fixtures__/native-harness.js";
import { buildRecord } from "./build.js";
import { NODE_ENV, nodeLibraryProgram } from "./program.js";

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, "../../node-platform/vendor/node-v22.23.5/lib");
const env = { id: NODE_ENV, source: readFileSync(join(here, "__fixtures__/node/env.js"), "utf8") };
const work = mkdtempSync(join(tmpdir(), "yakcc-node-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const PATH_PROGRAM = `const path = require("path");
const cases = [
  path.join("/a/b", "../c", "d.txt"), path.join("a", "", "./b/", ".."), path.normalize("/x//y/../z/."),
  path.resolve("/root", "a/../b", "c"), path.relative("/a/b/c", "/a/d"), path.relative("/same", "/same"),
  path.dirname("/home/u/f.txt"), path.basename("/home/u/f.txt", ".txt"), path.extname("x.tar.gz"),
  path.extname(".bashrc"), path.isAbsolute("a/b"), path.sep, path.delimiter,
  JSON.stringify(path.parse("/home/u/f.txt")), path.format({ dir: "/d", name: "n", ext: ".e" }),
  path.posix === path, path.win32.join("C:\\\\a", "..", "b"), path.toNamespacedPath("/p"),
];
console.log(cases.join("|"));
`;

describe.skipIf(!canRun("x86_64-linux"))("Node's library, natively (#1331)", () => {
  it("path: its posix and win32 functions", () => {
    const record = nodeLibraryProgram(lib, { id: "main", source: PATH_PROGRAM }, [env]);
    expect(record.modules.map((m) => m.id)).toContain("internal/per_context/primordials");
    const exe = join(work, "path");
    buildRecord(record, exe);
    const r = spawnSync(exe, [], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    const want = spawnSync(process.execPath, ["-e", PATH_PROGRAM], { encoding: "utf8" });
    expect(r.stdout).toBe(want.stdout);
    expect(r.status).toBe(0);
  }, 600_000);
});
