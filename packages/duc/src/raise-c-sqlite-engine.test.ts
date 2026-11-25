// SPDX-License-Identifier: Apache-2.0
// SQLite's whole engine, shaved (#1368's C part): the amalgamation yakcc runs on (3.53.0, through
// better-sqlite3) with a minimal operating-system layer of its own (an in-memory database, a fixed
// clock and randomness: __fixtures__/c/sqlite-run.c), its C library musl's, shaved too, down to the
// leaves. SQL scripts run on the shaved engine and on the same sources compiled natively; each
// script's rows, result code and message must be the same.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, link } from "./__fixtures__/c-link.js";
import { shaveMusl, withMuslInit } from "./__fixtures__/c-musl.js";
import { createCMemory, createCSystem, shaveCUnit } from "./raise-c.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const SQLITE_DIR = (() => {
  try {
    const req = createRequire(join(repo, "packages/registry/package.json"));
    return join(dirname(req.resolve("better-sqlite3/package.json")), "deps/sqlite3");
  } catch {
    return undefined;
  }
})();
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/sqlite-run.c", import.meta.url));
const ARGS = [
  "-std=c11",
  "-DSQLITE_OS_OTHER=1",
  "-DSQLITE_THREADSAFE=0",
  "-DSQLITE_OMIT_LOAD_EXTENSION",
  "-DSQLITE_DISABLE_INTRINSIC",
  "-DSQLITE_TEMP_STORE=3",
  "-DSQLITE_DEFAULT_MEMSTATUS=0",
  "-DSQLITE_OMIT_LOCALTIME",
  `-I${SQLITE_DIR}`,
];

const hasClang = (() => {
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
    return SQLITE_DIR !== undefined;
  } catch {
    return false;
  }
})();

const SCRIPTS = [
  "SELECT 1, 'two', 3.5, NULL, x'00ff', 1 + 2 * 3, 7 / 2, 7.0 / 2, -5 % 3, 1 << 40",
  "CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT, c REAL); INSERT INTO t(b, c) VALUES ('x', 1.5), ('y', NULL), ('z', -2.25); SELECT * FROM t ORDER BY a DESC",
  "CREATE TABLE t(k, v); INSERT INTO t VALUES (1, 'a'), (2, 'b'), (1, 'c'), (3, NULL); SELECT k, count(*), group_concat(v, '+'), max(v) FROM t GROUP BY k ORDER BY k",
  "CREATE TABLE p(id, name); CREATE TABLE q(pid, qty); INSERT INTO p VALUES (1, 'apple'), (2, 'pear'), (3, 'fig'); INSERT INTO q VALUES (1, 5), (1, 7), (3, 2); SELECT name, sum(qty) FROM p LEFT JOIN q ON q.pid = p.id GROUP BY name ORDER BY name",
  "SELECT upper('hello'), lower('MiXeD'), length('héllo'), substr('abcdef', 2, 3), replace('a-b-c', '-', '+'), trim('  x  '), instr('hello', 'll'), hex('AZ'), quote('it''s')",
  "SELECT printf('%d|%5.2f|%s|%x|%e', 42, 3.14159, 'str', 255, 12345.678), round(2.5), round(-2.5), abs(-7), typeof(1.0), typeof('1'), coalesce(NULL, NULL, 9)",
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 20) SELECT sum(x), avg(x), min(x), max(x), total(x) FROM c",
  "CREATE TABLE t(a, b); CREATE INDEX ti ON t(b); INSERT INTO t VALUES (3, 'c'), (1, 'a'), (2, 'b'); SELECT a FROM t WHERE b > 'a' ORDER BY b; UPDATE t SET a = a * 10 WHERE b = 'b'; DELETE FROM t WHERE a = 3; SELECT * FROM t ORDER BY a",
  "SELECT CASE WHEN 1 > 2 THEN 'no' WHEN 2 > 1 THEN 'yes' END, 5 BETWEEN 1 AND 10, 'b' IN ('a', 'b'), 'abc' LIKE 'a%', 'abc' GLOB '*c', NULL IS NULL, 1 = 1.0",
  "SELECT 1 +",
  "CREATE TABLE t(a UNIQUE); INSERT INTO t VALUES (1); INSERT INTO t VALUES (1)",
  "SELECT 9223372036854775807 + 1, -9223372036854775808, 1e308 * 10, 0.1 + 0.2, cast('12abc' AS INTEGER), cast(3.9 AS INTEGER)",
  "CREATE TABLE t(x); INSERT INTO t VALUES (3), (1), (4), (1), (5), (9), (2), (6); SELECT x, row_number() OVER (ORDER BY x), sum(x) OVER (ORDER BY x ROWS 1 PRECEDING) FROM t ORDER BY x",
  "SELECT json_object('a', 1, 'b', json_array(2, 3)), json_extract('{\"x\":[1,{\"y\":2}]}', '$.x[1].y'), date('2000-02-28', '+1 day'), datetime(0, 'unixepoch')",
];

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-sqlite-engine-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("SQLite's whole engine, shaved, runs SQL as compiled natively", () => {
  const unit = shaveCUnit(FIXTURE, ["yk_sqlite_run"], ARGS, "clang", "sqlite-run.c");
  const externals = [...new Set([...unit.atoms.values()].flatMap((a) => a.externals))].filter(
    (x) => !unit.atoms.has(x),
  );
  const musl = withMuslInit(shaveMusl(externals));

  it("the engine shaves with no refusal, and its C library down to the leaves", () => {
    expect([...unit.refused]).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
    expect(unit.atoms.size).toBeGreaterThan(2000);
  });

  const native = (): string[] => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
int yk_sqlite_run(const char *sql, char *buf, int cap);
int main(void) {
  static char sql[1 << 16], buf[1 << 16];
  while (fgets(sql, sizeof sql, stdin)) {
    yk_sqlite_run(sql, buf, sizeof buf);
    for (char *p = buf; *p; p++) putchar(*p == '\\n' ? '\\\\' : *p);
    putchar('\\n');
  }
  return 0;
}
`,
    );
    const obj = join(work, "sqlite-run.o");
    execFileSync("clang", [...ARGS, "-O1", "-c", FIXTURE, "-o", obj], { maxBuffer: 1 << 26 });
    const exe = join(work, "sqlite");
    execFileSync("clang", [driver, obj, "-lm", "-o", exe]);
    return execFileSync(exe, { input: `${SCRIPTS.join("\n")}\n`, encoding: "utf8" })
      .split("\n")
      .slice(0, SCRIPTS.length);
  };

  it("each script's rows, code and message equal the native engine's (as raised)", () => {
    const want = native();
    const memory = createCMemory();
    const system = createCSystem(memory);
    const env = link(
      new Map([...musl.atoms, ...unit.atoms]),
      false,
      memory,
      [...musl.units, unit],
      system.leaves as unknown as Record<string, Fn>,
    );
    env.yk_musl_init?.();
    const L = memory.leaves;
    const buf = L.__ykAlloc(1 << 16, 16);
    const got = SCRIPTS.map((sql) => {
      const s = memory.put([...Buffer.from(sql, "utf8"), 0]);
      const n = (env.yk_sqlite_run as Fn)(s, buf, 1 << 16) as number;
      return Buffer.from(memory.get(buf, n)).toString("utf8").replaceAll("\n", "\\");
    });
    const bad = got.flatMap((g, i) =>
      g === want[i] ? [] : [`${SCRIPTS[i]}\n  shaved ${g}\n  C      ${want[i]}`],
    );
    expect(bad).toEqual([]);
  }, 900_000);
});
