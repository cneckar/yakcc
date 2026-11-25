// SPDX-License-Identifier: Apache-2.0
// Node's SQLite (#1368: vendor/node/deps/sqlite, 3.54.1, the engine of node:sqlite), shaved whole
// as Node builds it (sqlite.gyp's defines: FTS3/4/5, R*Tree, Geopoly, sessions, math functions,
// dbstat, column metadata, the preupdate hook; threadsafe; the unix VFS) over musl shaved to the
// leaves, and opened as Node's DatabaseSync opens a database. Against Node itself: each statement
// of each script gives the same rows, every value of the same type and the same bytes (a REAL's
// bits), or the same error code and message.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, hex, link } from "./__fixtures__/c-link.js";
import { shaveMusl, withMuslInit } from "./__fixtures__/c-musl.js";
import { createCMemory, createCSystem, shaveCUnit } from "./raise-c.js";

const hasClang = (() => {
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const SQLITE = fileURLToPath(new URL("../vendor/node/deps/sqlite/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-sqlite.c", import.meta.url));
/** Node's sqlite.gyp (GNU C, as Node's build compiles it). */
const ARGS = [
  "-std=gnu11",
  "-DSQLITE_DEFAULT_MEMSTATUS=0",
  "-DSQLITE_ENABLE_COLUMN_METADATA",
  "-DSQLITE_ENABLE_DBSTAT_VTAB",
  "-DSQLITE_ENABLE_FTS3",
  "-DSQLITE_ENABLE_FTS3_PARENTHESIS",
  "-DSQLITE_ENABLE_FTS5",
  "-DSQLITE_ENABLE_GEOPOLY",
  "-DSQLITE_ENABLE_MATH_FUNCTIONS",
  "-DSQLITE_ENABLE_PREUPDATE_HOOK",
  "-DSQLITE_ENABLE_RBU",
  "-DSQLITE_ENABLE_RTREE",
  "-DSQLITE_ENABLE_SESSION",
  `-I${SQLITE}`,
];

/** Scripts: each a fresh database, its statements in turn. (Columns are named, and distinctly.) */
const SCRIPTS: readonly (readonly string[])[] = [
  [
    "select 1 + 2 as a, 7 / 2 as b, 7.0 / 2 as c, 7 % 3 as d, -7 / 2 as e, 1 / 0 as f",
    "select 9223372036854775807 + 1 as a, -9223372036854775808 - 1 as b, 2 * 4611686018427387904 as c",
    "select 0.1 + 0.2 as a, 1e308 * 10 as b, -0.0 as c, 3.0 as d, 1e-320 as e, 123456789012345678 as f",
    "select abs(-5) as a, round(2.5) as b, round(-2.5) as c, round(1.005, 2) as d, max(1, 2.0, '3') as e, min(1, null) as f",
    "select typeof(1) as a, typeof(1.0) as b, typeof('x') as c, typeof(x'00') as d, typeof(null) as e",
    "select cast('12abc' as integer) as a, cast('1e3' as real) as b, cast(3.99 as integer) as c, cast(x'414243' as text) as d",
    "select '9' > 10 as a, 9 < '10' as b, 'abc' < 'abd' as c, null = null as d, null is null as e",
  ],
  [
    "select printf('%d|%5.2f|%-6s|%x|%e|%g|%q|%Q', 42, 3.14159, 'ab', 255, 12345.678, 0.0001, 'it''s', null) as a",
    "select printf('%.20f', 0.1) as a, printf('%!.17g', 1.0/3) as b, printf('%,d', 1234567) as c, printf('%c%c', 'x', 'yz') as d",
    "select 1.0/3 as a, 2.0/3 * 3 as b, 100.0 as c, 1e100 as d, 123.456e-7 as e",
    "select cast(1.0/3 as text) as a, cast(1e100 as text) as b, cast(0.1 as text) as c, cast(-1.5e-10 as text) as d",
    "select upper('straße é') as a, lower('ÀBC') as b, length('héllo') as c, length(x'0102') as d, octet_length('héllo') as e",
    "select substr('hello world', 3, 5) as a, substr('hello', -3) as b, instr('banana', 'na') as c, replace('aaa', 'a', 'bb') as d",
    "select trim('  x  ') as a, ltrim('xxyx', 'x') as b, hex('héllo') as c, unhex('48656c6c6f') as d, quote('a''b') as e, char(72, 105, 0x1F600) as f",
    "select unicode('€') as a, zeroblob(3) as b, 'abc' like 'A%' as c, 'abc' glob 'a*' as d, 'x' || 1 || 2.5 as e",
  ],
  [
    "create table t(id integer primary key, name text not null, score real, tag text default 'none', unique(name))",
    "insert into t(name, score) values ('ann', 90.5), ('bob', 72), ('cat', null), ('dan', 88.25)",
    "insert into t(name, score) values ('ann', 1)",
    "insert into t(name, score) values ('ann', 1) on conflict(name) do update set score = score + excluded.score",
    "select id, name, score, tag from t order by score desc nulls last",
    "select count(*) as n, avg(score) as m, sum(score) as s, total(score) as u, group_concat(name, '/') as g from t",
    "select tag, count(*) as n from t group by tag having n > 1",
    "update t set tag = 'top' where score > 85 returning id, tag",
    "delete from t where score is null returning name",
    "select * from t where name in ('ann', 'zed') or score between 70 and 80 order by id",
  ],
  [
    "with recursive n(i) as (select 1 union all select i + 1 from n where i < 20) select group_concat(i, ',') as a, sum(i * i) as b from n",
    "with recursive fib(a, b, k) as (select 0, 1, 0 union all select b, a + b, k + 1 from fib where k < 90) select a as v from fib where k in (10, 50, 90)",
    "create table s(g text, v integer)",
    "insert into s values ('a', 3), ('a', 1), ('b', 4), ('a', 1), ('b', 5), ('c', 9), ('b', 2)",
    "select g, v, row_number() over (partition by g order by v) as rn, rank() over (order by v) as rk, sum(v) over (partition by g) as tot, lag(v) over (order by v, g) as pv from s order by g, v",
    "select g, v, ntile(3) over (order by v, g) as t, percent_rank() over (order by v) as pr, cume_dist() over (order by v) as cd from s order by v, g",
    "select g, avg(v) over (order by v rows between 1 preceding and 1 following) as m from s order by v, g",
  ],
  [
    "select json_object('a', 1, 'b', json_array(1, 2.5, 'x', null), 'c', json('{\"d\":true}')) as a",
    "select json_extract('{\"a\":{\"b\":[10,20,30]}}', '$.a.b[1]') as a, '{\"x\":1}' -> '$.x' as b, '{\"x\":\"y\"}' ->> '$.x' as c",
    'select key, value, type from json_each(\'[1, "two", 3.5, {"k": false}]\')',
    "select json_set('{\"a\":1}', '$.b', 2) as a, json_remove('[1,2,3]', '$[1]') as b, json_patch('{\"a\":1,\"b\":2}', '{\"b\":null,\"c\":3}') as c",
    "select json_valid('{bad') as a, json_type('[1]') as b, json_group_array(v) as c from (select 1 as v union all select 2)",
    "select jsonb('{\"a\":[1,2]}') as a, json(jsonb('{\"a\":[1,2]}')) as b",
    "select json('{\"a\" : 1e400}') as a",
  ],
  [
    "select sqrt(2) as a, pow(2, 0.5) as b, exp(1) as c, ln(10) as d, log10(1000) as e, log(2, 1024) as f",
    "select sin(1) as a, cos(1) as b, tan(1) as c, atan2(1, 2) as d, pi() as e, degrees(pi()) as f",
    "select ceil(-1.5) as a, floor(-1.5) as b, trunc(-1.5) as c, mod(7.5, 2) as d, sign(-3) as e, acosh(2) as f",
  ],
  [
    "select date('2024-02-28', '+1 day') as a, date('2023-02-28', '+1 day') as b, datetime('2024-01-31 10:00', '+1 month') as c",
    "select strftime('%Y-%m-%d %H:%M:%S %j %w %W', '2024-12-31 23:59:59') as a, julianday('2000-01-01') as b, unixepoch('2024-01-01') as c",
    "select time('12:34:56.789') as a, datetime(1700000000, 'unixepoch') as b, date('2024-03-15', 'start of month', '-1 day') as c",
    "select timediff('2024-03-01', '2024-01-15') as a, strftime('%s', '1970-01-02') as b, date('2024-01-01', 'weekday 0') as c",
  ],
  [
    "create table p(id integer primary key, name text)",
    "create table c(id integer primary key, pid integer references p(id) on delete cascade, v text)",
    "insert into p values (1, 'one'), (2, 'two')",
    "insert into c values (10, 1, 'a'), (11, 1, 'b'), (12, 2, 'c')",
    "insert into c values (13, 3, 'bad')",
    "delete from p where id = 1",
    "select id, pid, v from c",
    'select "name" from p',
    'select "nope" from p',
    "create view vw as select p.name as pn, count(c.id) as k from p left join c on c.pid = p.id group by p.id",
    "select pn, k from vw",
  ],
  [
    "create table g(a integer, b integer, s integer generated always as (a + b) stored, v text as (a || '-' || b))",
    "insert into g(a, b) values (1, 2), (10, 20)",
    "select a, b, s, v from g",
    "create table st(i integer, t text) strict",
    "insert into st values ('12', 'x')",
    "insert into st values ('x', 'y')",
    "create table log(m text)",
    "create trigger tr after insert on g begin insert into log values ('added ' || new.s); end",
    "insert into g(a, b) values (5, 5)",
    "select m from log",
    "select a, b from g except select 1, 2 order by a",
  ],
  [
    "create virtual table docs using fts5(title, body)",
    "insert into docs values ('Rust and C', 'Systems languages with manual or checked memory'), ('Node streams', 'Readable and writable streams in node'), ('SQLite FTS', 'Full text search with ranking'), ('Streams again', 'more on streams and memory')",
    "select title from docs where docs match 'streams' order by rank",
    "select title, snippet(docs, 1, '[', ']', '...', 4) as s from docs where docs match 'memory' order by rank",
    "select highlight(docs, 0, '<', '>') as h from docs where docs match 'title:sqlite'",
    "select title, round(bm25(docs), 6) as r from docs where docs match 'streams OR memory' order by r",
    "select count(*) as n from docs where docs match 'NEAR(manual memory, 3)'",
  ],
  [
    "create virtual table f3 using fts4(content)",
    "insert into f3 values ('the quick brown fox'), ('jumped over the lazy dog'), ('the fox again')",
    "select rowid, content from f3 where f3 match 'fox' order by rowid",
    "select hex(matchinfo(f3)) as m from f3 where f3 match 'the fox' order by rowid",
    "select offsets(f3) as o from f3 where f3 match 'fox' order by rowid",
  ],
  [
    "create virtual table rt using rtree(id, minx, maxx, miny, maxy)",
    "insert into rt values (1, 0, 10, 0, 10), (2, 5, 15, 5, 15), (3, 20, 30, 20, 30), (4, -5, 1, -5, 1)",
    "select id from rt where minx <= 6 and maxx >= 6 and miny <= 6 and maxy >= 6 order by id",
    "select id from rt where maxx < 12 order by id",
    "select geopoly_area(geopoly_regular(0, 0, 1, 6)) as a, geopoly_json(geopoly_bbox('[[0,0],[2,0],[1,3],[0,0]]')) as b",
    "select geopoly_contains_point('[[0,0],[4,0],[4,4],[0,4],[0,0]]', 2, 2) as a, geopoly_within('[[1,1],[2,1],[2,2],[1,1]]', '[[0,0],[4,0],[4,4],[0,4],[0,0]]') as b",
  ],
  [
    "create table big(k integer primary key, v text)",
    "with recursive n(i) as (select 1 union all select i + 1 from n where i < 3000) insert into big select i, printf('%08d-%s', i * 7919 % 10007, hex(i)) from n",
    "create index big_v on big(v)",
    "select count(*) as n, min(v) as a, max(v) as b, sum(length(v)) as l from big",
    "select k, v from big where v between '00005000' and '00005100' order by v limit 5",
    "select k % 7 as m, count(*) as n from big group by m order by m",
    "select name, pageno is not null as p from dbstat where name = 'big_v' limit 1",
    "pragma integrity_check",
    "select a.k as x, b.k as y from big a join big b on a.k = b.k * 1000 order by x",
  ],
  [
    "select * from nope",
    "select 1 from",
    "create table x(a)",
    "create table x(a)",
    "insert into x values (1, 2)",
    "select abs(-9223372036854775808) as a",
    "select json('[1,') as a",
    "select 'a' collate nocase = 'A' as a, 'b' collate rtrim = 'b  ' as b",
    "select sqlite_version() as v, sqlite_source_id() is not null as s",
    "select compile_options as o from pragma_compile_options where compile_options not like 'COMPILER=%'",
  ],
];

describe.skipIf(!hasClang)("Node's SQLite, shaved from C, against node:sqlite", () => {
  const unit = shaveCUnit(FIXTURE, ["yk_node_sqlite"], ARGS, "clang", "node-sqlite.c");
  // (The C library's functions the engine calls, and those its tables name: the unix VFS's
  // system calls, the math functions.)
  const externals = [
    ...new Set([
      ...[...unit.atoms.values()].flatMap((a) => a.externals),
      ...[...unit.statics.values()].flatMap((d) =>
        d.init.flatMap((i) => ("fn" in i ? [i.fn] : [])),
      ),
    ]),
  ].filter((x) => !unit.atoms.has(x));
  const musl = withMuslInit(shaveMusl(externals));

  it("the engine shaves with no refusal, its C library down to the leaves", () => {
    expect([...unit.refused]).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  /** Node's DatabaseSync, as the fixture writes it: a line per statement. */
  const node = (script: readonly string[]): string[] => {
    const db = new DatabaseSync(":memory:");
    const value = (v: unknown): string => {
      if (v === null) return "N";
      if (typeof v === "bigint") return `I${v}`;
      if (typeof v === "number") {
        const b = Buffer.alloc(8);
        b.writeDoubleBE(v);
        return `R${b.toString("hex")}`;
      }
      if (typeof v === "string") return `T${Buffer.from(v, "utf8").toString("hex")}`;
      return `B${Buffer.from(v as Uint8Array).toString("hex")}`;
    };
    const out = script.map((sql) => {
      try {
        const st = db.prepare(sql);
        st.setReadBigInts(true);
        const rows = st.all() as Record<string, unknown>[];
        return `S${rows.map((r) => ` [${Object.values(r).map(value).join(",")}]`).join("")}`;
      } catch (e) {
        const err = e as { errcode?: number; message: string };
        return `E ${err.errcode} ${err.message}`;
      }
    });
    db.close();
    return out;
  };

  const work = mkdtempSync(join(tmpdir(), "yakcc-node-sqlite-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("the same sources compiled natively equal node:sqlite (the fixture runs SQLite as Node does)", () => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
long yk_node_sqlite(const char *, long, char *, long);
int main(void) {
  static char in[1 << 20], out[1 << 20];
  long n = (long)fread(in, 1, sizeof in, stdin);
  fwrite(out, 1, (size_t)yk_node_sqlite(in, n, out, sizeof out), stdout);
  return 0;
}
`,
    );
    const exe = join(work, "sqlite");
    execFileSync("clang", [...ARGS, "-O1", FIXTURE, driver, "-lm", "-o", exe], {
      maxBuffer: 1 << 26,
    });
    const bad: string[] = [];
    for (const script of SCRIPTS) {
      const want = node(script);
      const got = execFileSync(exe, { input: Buffer.from(`${script.join("\0")}\0`, "utf8") })
        .toString("utf8")
        .split("\n");
      script.forEach((sql, i) => {
        if (got[i] !== want[i])
          bad.push(`${sql}\n  native ${got[i]?.slice(0, 300)}\n  Node   ${want[i]?.slice(0, 300)}`);
      });
    }
    expect(bad.slice(0, 8)).toEqual([]);
  }, 600_000);

  it("each statement's rows (each value's type and bytes) or error equal node:sqlite's (as raised)", () => {
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
    const cap = 1 << 20;
    const out = memory.leaves.__ykAlloc(cap, 16);
    const bad: string[] = [];
    for (const script of SCRIPTS) {
      const want = node(script);
      const bytes = [...Buffer.from(`${script.join("\0")}\0`, "utf8")];
      let got: string[];
      try {
        const p = memory.put(bytes);
        const n = Number((env.yk_node_sqlite as Fn)(p, BigInt(bytes.length), out, BigInt(cap)));
        got = Buffer.from(memory.get(out, n)).toString("utf8").split("\n").slice(0, script.length);
      } catch (e) {
        got = script.map(() => `trap: ${(e as Error).message}`);
      }
      script.forEach((sql, i) => {
        if (got[i] !== want[i])
          bad.push(`${sql}\n  shaved ${got[i]?.slice(0, 300)}\n  Node   ${want[i]?.slice(0, 300)}`);
      });
    }
    expect(bad.slice(0, 8)).toEqual([]);
  }, 3_600_000);
});
