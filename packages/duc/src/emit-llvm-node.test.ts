// SPDX-License-Identifier: Apache-2.0
/**
 * Node's own library run natively (#1331, #1361 P2): a program record of the entry and the builtin
 * modules it requires (per_context/primordials, internal/errors, internal/util, …, read from the
 * vendored v22.23.5 lib), built and run; its output is Node's.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { canRun } from "./__fixtures__/native-harness.js";
import { buildRecord } from "./build.js";
import {
  NODE_BINDINGS,
  NODE_ENV,
  nodeBootProgram,
  nodeLibraryProgram,
  programRecord,
} from "./program.js";

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, "../../node-platform/vendor/node-v22.23.5/lib");
const env = { id: NODE_ENV, source: readFileSync(join(here, "__fixtures__/node/env.js"), "utf8") };
const bindings = {
  id: NODE_BINDINGS,
  source: readFileSync(join(here, "__fixtures__/node/bindings.js"), "utf8"),
};
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

  it("a module's own binding of a platform name, and a top-level return ending the module (#1331)", () => {
    const source = [
      "let queueMicrotask = (f) => f();",
      "const out = [];",
      "queueMicrotask(() => out.push('own'));",
      "queueMicrotask = (f) => { out.push('reassigned'); f(); };",
      "queueMicrotask(() => out.push('ran'));",
      "if (out.length === 3) { console.log(out.join(',') + '|returned'); return; }",
      "console.log('not reached');",
    ].join("\n");
    const record = nodeLibraryProgram(lib, { id: "main", source }, [env]);
    const exe = join(work, "top-return");
    buildRecord(record, exe);
    const r = spawnSync(exe, [], { encoding: "utf8" });
    expect([r.status, r.stderr]).toEqual([0, ""]);
    const file = join(work, "top-return.cjs");
    writeFileSync(file, source);
    const want = spawnSync(process.execPath, [file], { encoding: "utf8" });
    expect(r.stdout).toBe(want.stdout);
    expect(r.stdout).toBe("own,reassigned,ran|returned\n");
  }, 600_000);

  // Node booted as Node boots: the per-context scripts, realm, then main through realm's require.
  it("booted through realm.js: util.format and util.inspect, path, console, events, a library error", () => {
    const record = nodeBootProgram(
      lib,
      { id: "main", source: BOOT_PROGRAM },
      {
        bindings,
        include: ["internal/util/comparisons", "internal/v8/startup_snapshot"],
        // Repeated local runs may reuse lifted modules (unset in CI).
        ...(process.env.YAKCC_LIFT_CACHE !== undefined
          ? { liftCache: process.env.YAKCC_LIFT_CACHE }
          : {}),
      },
    );
    const ids = record.modules.map((m) => m.id);
    expect(ids).toContain("internal/bootstrap/realm");
    expect(ids).toContain("internal/util/inspect");
    const exe = join(work, "boot");
    buildRecord(record, exe);
    const r = spawnSync(exe, [], { encoding: "utf8" });
    const want = spawnSync(process.execPath, ["-e", BOOT_PROGRAM], { encoding: "utf8" });
    expect(r.stderr).toBe(want.stderr);
    expect(r.stdout).toBe(want.stdout);
    expect(r.status).toBe(0);
  }, 1_200_000);
});

const BOOT_PROGRAM = `const util = require("util");
const path = require("path");
console.log(path.join("/a/b", "../c"), path.relative("/x/y", "/x/z/w"));
console.log(util.format("%s=%d %i %f %j %o %%", "k", 42, "7.9", "1.5", { z: [1] }, [2]));
console.log(util.inspect({ a: [1, "x", null, undefined], n: -0, b: 10n, s: Symbol("q"), f() {} }));
console.log(util.inspect(new Map([[1, { b: 2 }], ["k", [3]]])), util.inspect(new Set(["s", 3])));
console.log(util.inspect("str"), util.inspect([1, [2, [3, [4, [5]]]]], { depth: 1 }));
console.log(util.inspect({ nested: { deeper: { deepest: { gone: 1 } } } }));
class Point { constructor(x, y) { this.x = x; this.y = y; } }
console.log(util.inspect(new Point(1, 2)), util.inspect(Promise.resolve(4)), util.inspect(new Error("boom").message));
console.log(util.isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] }), util.types.isMap(new Map()));
try { path.join(1); } catch (e) { console.log(e.code, e.name, e.message); }
console.log({ a: 1, b: [2, { c: 3 }] }, new Map([[1, "x"]]), [undefined, null], "%s!", "fmt");
console.log(typeof Buffer, Buffer.isBuffer(new Uint8Array(1)), Buffer.isEncoding("hex"), Buffer.isEncoding("nope"));
console.error("to stderr %d", 5);
const EventEmitter = require("events");
const em = new EventEmitter();
const heard = [];
em.on("x", (a) => heard.push(a));
em.once("x", (a) => heard.push("once " + a));
em.prependListener("x", (a) => heard.push("first " + a));
em.emit("x", 1);
em.emit("x", 2);
console.log(heard, em.listenerCount("x"), em.eventNames(), em.emit("none"));
try { em.emit("error", new Error("unhandled")); } catch (e) { console.log(e.message); }
console.dir({ deep: { er: { est: { x: 1 } } } }, { depth: 0 });
`;

describe.skipIf(!canRun("x86_64-linux"))("a user program over Node's library (#1361 P2)", () => {
  it("its requires of Node's modules are the library's, its own module its own", () => {
    const entry = join(here, "__fixtures__/program/node-user/entry.cjs");
    const user = programRecord(entry, join(here, ".."));
    const record = nodeBootProgram(
      lib,
      { id: "main", source: "" },
      {
        bindings,
        user,
        include: ["internal/util/comparisons", "internal/v8/startup_snapshot"],
        ...(process.env.YAKCC_LIFT_CACHE !== undefined
          ? { liftCache: process.env.YAKCC_LIFT_CACHE }
          : {}),
      },
    );
    const ids = record.modules.map((m) => m.id);
    for (const id of ["path", "events", "util", "querystring", user.entry])
      expect(ids).toContain(id);
    const exe = join(work, "node-user");
    buildRecord(record, exe);
    const r = spawnSync(exe, [], { encoding: "utf8" });
    const want = spawnSync(process.execPath, [entry], { encoding: "utf8" });
    expect(r.stderr).toBe(want.stderr);
    expect(r.stdout).toBe(want.stdout);
    expect(r.status).toBe(0);
  }, 1_200_000);
});

const TICK_PROGRAM = `const out = [];
const log = (...a) => out.push(a.join(" "));
process.nextTick(() => log("tick 1"));
Promise.resolve().then(() => {
  log("promise 1");
  process.nextTick(() => log("tick from a promise job"));
});
queueMicrotask(() => log("microtask 1"));
process.nextTick((a, b) => {
  log("tick 2", a, b);
  Promise.resolve().then(() => log("promise from a tick"));
  process.nextTick(() => log("tick from a tick"));
}, "x", 7);
log("sync");
const ah = require("async_hooks");
log("ids", ah.executionAsyncId(), ah.triggerAsyncId());
const res = new ah.AsyncResource("THING");
res.runInAsyncScope(() => log("in scope", ah.executionAsyncId() === res.asyncId(), ah.triggerAsyncId() === res.triggerAsyncId()));
log("after scope", ah.executionAsyncId());
const sys = require("sys");
log("sys", typeof sys.format);
process.on("exit", () => console.log(out.join("|")));
`;

describe.skipIf(!canRun("x86_64-linux"))(
  "process.nextTick and async hooks, natively (#1361 P2)",
  () => {
    it("ticks run before promise jobs, again after them; async ids and scopes as Node's", () => {
      const record = nodeBootProgram(
        lib,
        { id: "main", source: TICK_PROGRAM },
        {
          bindings,
          include: [
            "internal/util/comparisons",
            "internal/v8/startup_snapshot",
            "async_hooks",
            "sys",
          ],
          ...(process.env.YAKCC_LIFT_CACHE !== undefined
            ? { liftCache: process.env.YAKCC_LIFT_CACHE }
            : {}),
        },
      );
      const exe = join(work, "ticks");
      buildRecord(record, exe);
      const r = spawnSync(exe, [], { encoding: "utf8" });
      const want = spawnSync(process.execPath, ["-e", TICK_PROGRAM], { encoding: "utf8" });
      // A warning names the process's id and the program it was run as (node, or this executable).
      const same = (t: string): string =>
        t
          .replace(/\(node:\d+\)/g, "(node:PID)")
          .replace(/`(node|ticks) --trace/g, "`PROGRAM --trace");
      expect(same(r.stderr)).toBe(same(want.stderr));
      expect(r.stdout).toBe(want.stdout);
      expect(r.status).toBe(0);
    }, 1_200_000);
  },
);
