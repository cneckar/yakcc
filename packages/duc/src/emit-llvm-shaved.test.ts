// SPDX-License-Identifier: Apache-2.0
/**
 * Shaved C, natively (#1361 P0, DEC-DUC-OPERATIONS-AS-ATOMS-001): the atoms `raise-c` shaves are
 * lifted, linked as one module (each a function declaration; a call to another is a reference to its
 * binding), lowered with NaN-boxed values and the fixed-width and float64-bits leaves, linked with
 * the runtime, and run. Two programs:
 * - V8's Math, shaved from its own `ieee754.cc` (and musl's `scalbn`): every function, natively,
 *   equals Node's `Math` bit for bit;
 * - the C-semantics fixture: every function, natively, equals its raised source run in Node with
 *   the leaves' JavaScript definitions (which `raise-c.test.ts` shows equals the C compiled natively).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import fc from "fast-check";
import { ts } from "ts-morph";
import { afterAll, describe, expect, it } from "vitest";
import { ADA_CASES } from "./__fixtures__/ada-cases.js";
import { shaveCFiles } from "./__fixtures__/c-files.js";
import { shaveMusl, withMuslInit } from "./__fixtures__/c-musl.js";
import { canRun, decode, encode, same } from "./__fixtures__/native-harness.js";
import { V8_BIGINT_METHODS, shaveV8BigInt } from "./atoms/shave-v8.js";
import { emitNativeModules } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";
import { withStatics } from "./native-statics.js";
import { compileObject, compileRuntime } from "./native.js";
import {
  C_LEAVES_JS,
  type ShavedUnit,
  type StaticDef,
  createCMemory,
  recordLayouts,
  shaveCUnit,
} from "./raise-c.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const V8 = here("../vendor/v8/");
const MUSL = here("../vendor/musl/");
const FIXTURE = here("./__fixtures__/c/semantics.c");

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const work = mkdtempSync(join(tmpdir(), "yakcc-shaved-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const HARNESS = `#include <stdio.h>
#include <stdint.h>
#include <string.h>
typedef uint64_t yk;
yk yk_read(FILE *); void yk_write(FILE *, yk);
yk yk_call_method(yk, const char *, uint64_t, uint64_t, const yk *);
extern yk ENTRY(void);
int main(void) {
  yk exports = ENTRY();
  char member[128]; unsigned argc;
  while (scanf("%127s %u", member, &argc) == 2) {
    yk argv[8];
    for (unsigned i = 0; i < argc; i++) argv[i] = yk_read(stdin);
    yk_write(stdout, yk_call_method(exports, member, strlen(member), argc, argv));
    fputc('\\n', stdout); fflush(stdout);
  }
  return 0;
}
`;

/**
 * A shaved unit as one native module: each atom a function declaration of its name, the exports an
 * object of them all. Returns a runner of (name, arguments) calls.
 */
function nativeUnit(
  name: string,
  atoms: ReadonlyMap<string, { readonly source: string }>,
): (calls: readonly [string, unknown[]][]) => unknown[] {
  return nativeUnitWith(name, atoms, []);
}
function nativeUnitWith(
  name: string,
  atoms: ReadonlyMap<string, { readonly source: string }>,
  extra: readonly [string, string][],
  statics: ReadonlyMap<string, StaticDef> = new Map(),
): (calls: readonly [string, unknown[]][]) => unknown[] {
  const names = [...atoms.keys(), ...extra.map(([n]) => n)];
  const sources = new Map([...[...atoms].map(([n, a]) => [n, a.source] as const), ...extra]);
  const statements = [
    ...names.map((n) => ({
      kind: "function" as const,
      declares: [n],
      graph: liftAtom(sources.get(n) as string),
    })),
    {
      kind: "statement" as const,
      declares: [],
      graph: liftAtom(`module.exports = { ${names.join(", ")} };`),
    },
  ];
  const { ir, symbols } = emitNativeModules(
    withStatics([{ id: `${name}.js`, statements }], statics),
  );
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "m.ll"), ir);
  writeFileSync(join(dir, "m.o"), compileObject({ ir, symbol: "", params: [], result: "i64" }));
  writeFileSync(join(dir, "yk.o"), compileRuntime());
  writeFileSync(join(dir, "h.c"), HARNESS);
  const cc = spawnSync(
    "cc",
    [`-DENTRY=${symbols[`${name}.js`]}`, "h.c", "m.o", "yk.o", "-lm", "-o", "run"],
    { cwd: dir },
  );
  if (cc.status !== 0) throw new Error(cc.stderr.toString());
  return (calls) => {
    const input = calls.map(([m, a]) => `${m} ${a.length} ${a.map(encode).join(" ")}`).join("\n");
    const run = spawnSync(join(dir, "run"), [], { input: `${input}\n`, maxBuffer: 1 << 26 });
    const got = run.stdout
      .toString()
      .split("\n")
      .filter((l) => l !== "")
      .map(decode);
    if (got.length !== calls.length)
      throw new Error(`ran ${got.length} of ${calls.length}: ${run.stderr.toString()}`);
    return got;
  };
}

/** Doubles: the edges of each function's ranges, and generated ones (raw bit patterns too). */
const doubleOf = (b: bigint): number => {
  const v = new DataView(new ArrayBuffer(8));
  v.setBigUint64(0, b);
  return v.getFloat64(0);
};
const DOUBLES = [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  2,
  10,
  100,
  1e-10,
  1e-300,
  5e-324,
  1e300,
  -1e300,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Math.PI,
  Math.PI / 2,
  Math.PI / 4,
  709.78,
  709.79,
  -745.13,
  1e10,
  1e22,
  2 ** 52,
  3 * 2 ** 1020,
  ...fc.sample(
    fc.oneof(
      fc.double(),
      fc.double({ min: -10, max: 10 }),
      fc.double({ min: -1e6, max: 1e6 }),
      fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }).map(doubleOf),
    ),
    { numRuns: 400, seed: 1361 },
  ),
];

describe.skipIf(!hasClang || !canRun("x86_64-linux"))("shaved C, natively (#1361)", () => {
  it("Node's zlib crc32 and adler32, shaved from C over musl, natively equal Node's", () => {
    const ZLIB = here("../vendor/node/deps/zlib/");
    const ARGS = ["-std=c11", "-DHAVE_HIDDEN", `-I${ZLIB}`, "-DCPU_NO_SIMD"];
    const fixture = shaveCUnit(
      here("./__fixtures__/c/node-zlib.c"),
      ["yk_node_crc32", "yk_node_adler32"],
      ARGS,
      "clang",
      "node-zlib.c",
    );
    const roots = [...new Set([...fixture.atoms.values()].flatMap((a) => a.externals))];
    const files = ["adler32.c", "crc32.c", "cpu_features.c", "zutil.c"].map((f) => `${ZLIB}${f}`);
    const z = shaveCFiles(files, roots, ARGS);
    const libc = [...new Set(z.externals)].filter((x) => !fixture.atoms.has(x));
    const musl = withMuslInit(shaveMusl(libc));
    expect([...fixture.refused, ...z.refused, ...musl.refused, ...musl.missing]).toEqual([]);
    const atoms = new Map([...musl.atoms, ...z.atoms, ...fixture.atoms]);
    const PUT =
      "export function f(bytes: number[]): number { const a = __ykAlloc(Math.max(bytes.length, 1), 16); for (let i = 0; i < bytes.length; i++) __ykStore8(a + i, bytes[i] as number); return a; }";
    const run = nativeUnitWith("zlib-checksums", atoms, [
      ["put", PUT],
      [
        "tCrc",
        "export function f(bytes: number[], init: number): number { return Number(yk_node_crc32(put(bytes), BigInt(bytes.length), BigInt(init))); }",
      ],
      [
        "tAdler",
        "export function f(bytes: number[]): number { return Number(yk_node_adler32(put(bytes), BigInt(bytes.length))); }",
      ],
    ]);
    const inputs: number[][] = [
      [],
      [0],
      [255],
      [...Buffer.from("The quick brown fox jumps over the lazy dog")],
      Array(5552).fill(255),
      Array(70_000).fill(7),
      ...fc.sample(
        fc.uint8Array({ maxLength: 3000 }).map((b) => [...b]),
        { numRuns: 40, seed: 1516 },
      ),
    ];
    const inits = [0, 1, 0xffffffff, 0x12345678];
    const calls: [string, unknown[]][] = [];
    inputs.forEach((b, i) => {
      calls.push(["tCrc", [b, inits[i % inits.length] as number]]);
      calls.push(["tAdler", [b]]);
    });
    const got = run(calls);
    const adler = (b: readonly number[]): number => {
      let a = 1;
      let c = 0;
      for (const x of b) {
        a = (a + x) % 65521;
        c = (c + a) % 65521;
      }
      return (c * 65536 + a) >>> 0;
    };
    const bad: string[] = [];
    calls.forEach(([f, a], i) => {
      const b = a[0] as number[];
      const want = f === "tCrc" ? zlib.crc32(Buffer.from(b), a[1] as number) : adler(b);
      if (got[i] !== want && bad.length < 10)
        bad.push(
          `${f}(${b.length} bytes${f === "tCrc" ? `, ${a[1]}` : ""}) = ${got[i]}, want ${want}`,
        );
    });
    expect(bad).toEqual([]);
  }, 900_000);

  it("C's statics natively: globals, a static local, function pointers, strings, a static's address in another", () => {
    const unit = shaveCUnit(
      here("./__fixtures__/c/statics.c"),
      ["statics_sum"],
      ["-std=c11"],
      "clang",
    );
    expect([...unit.refused]).toEqual([]);
    const run = nativeUnitWith(
      "statics",
      unit.atoms,
      [
        [
          "tS",
          "export function f(i: number, k: number): number { return Number(statics_sum(i, k)); }",
        ],
      ],
      unit.statics,
    );
    const calls: [string, unknown[]][] = Array.from({ length: 12 }, (_, j) => [
      "tS",
      [j * 7 + 1, j % 3],
    ]);
    const got = run(calls);
    // The same calls, in order, of the C compiled natively.
    const dir = join(work, "statics-c");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "main.c"),
      `#include <stdio.h>\nlong long statics_sum(int i, int k);\nint main(void) { for (int j = 0; j < 12; j++) printf("%lld\\n", statics_sum(j * 7 + 1, j % 3)); return 0; }\n`,
    );
    execFileSync("clang", [
      "-std=c11",
      "-O0",
      join(dir, "main.c"),
      here("./__fixtures__/c/statics.c"),
      "-o",
      join(dir, "run"),
    ]);
    const want = execFileSync(join(dir, "run"), { encoding: "utf8" })
      .trim()
      .split("\n")
      .map(Number);
    expect(got).toEqual(want);
  }, 600_000);

  // About 20 minutes (833 atoms, ~300 MB of IR): run with YAKCC_NATIVE_SLOW=1.
  it.skipIf(process.env.YAKCC_NATIVE_SLOW !== "1")(
    "ada (Node's URL parser), shaved from C++ over musl, natively equals the C++ compiled by clang",
    () => {
      const ADA = here("../vendor/ada/");
      const FIXTURE = here("./__fixtures__/c/ada-run.cpp");
      const ARGS = ["-std=c++17", "-DNDEBUG", "-D_GLIBCXX_ASSERTIONS", `-I${ADA}`];
      const unit = shaveCUnit(FIXTURE, ["yk_url"], ARGS, "clang++", "ada-run.cpp");
      const externals = [...new Set([...unit.atoms.values()].flatMap((a) => a.externals))].filter(
        (x) => !unit.atoms.has(x),
      );
      const musl = withMuslInit(shaveMusl(externals));
      const statics = new Map([...musl.units, unit].flatMap((u) => [...u.statics]));
      // The drivers' names are no C or C++ function's (ada's has a `put`).
      const run = nativeUnitWith(
        "ada",
        new Map([...musl.atoms, ...unit.atoms]),
        [
          [
            "yk$put",
            "export function f(bytes: number[]): number { const a = __ykAlloc(bytes.length + 1, 16); for (let i = 0; i < bytes.length; i++) __ykStore8(a + i, bytes[i] as number); __ykStore8(a + bytes.length, 0); return a; }",
          ],
          [
            "yk$url",
            "export function f(u: number[], b: number[], hasBase: boolean): unknown { const pu = yk$put(u); const pb = yk$put(b); const cap = 65536; const out = __ykAlloc(cap, 16); const r = yk_url(pu, u.length, pb, hasBase ? b.length : -1, out, cap) as number; const o: number[] = []; for (let i = 0; i < r; i++) o.push(__ykLoad8(out + i)); return [r, o]; }",
          ],
          ["yk$init", "export function f(): number { yk_musl_init(); return 0; }"],
        ],
        statics,
      );
      const got = run([
        ["yk$init", []],
        ...ADA_CASES.map(([u, b]): [string, unknown[]] => [
          "yk$url",
          [
            [...Buffer.from(u, "utf8")],
            b === undefined ? [] : [...Buffer.from(b, "utf8")],
            b !== undefined,
          ],
        ]),
      ]).slice(1);
      const dir = join(work, "ada-c");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "driver.c"),
        `#include <stdio.h>
#include <string.h>
int yk_url(const char *in, int n, const char *base, int bn, char *out, int cap);
static int unhex(const char *h, char *out) { int n = 0; unsigned v; for (; h[0] && h[0] != ' ' && h[0] != '\\n'; h += 2) { sscanf(h, "%2x", &v); out[n++] = (char)v; } return n; }
int main(void) { static char line[1 << 16], in[1 << 14], base[1 << 14], out[1 << 16];
  while (fgets(line, sizeof line, stdin)) { char *sp = strchr(line, ' '); int n = unhex(line + 1, in); int bn = line[0] == 'b' ? unhex(sp + 1, base) : -1;
    int r = yk_url(in, n, base, bn, out, sizeof out); printf("%d:", r); for (int i = 0; i < r; i++) printf("%02x", (unsigned char)out[i]); putchar('\\n'); } return 0; }
`,
      );
      execFileSync("clang++", [...ARGS, "-O2", "-c", FIXTURE, "-o", join(dir, "ada-run.o")], {
        maxBuffer: 1 << 26,
      });
      execFileSync("clang++", [
        "-x",
        "c",
        join(dir, "driver.c"),
        "-x",
        "none",
        join(dir, "ada-run.o"),
        "-o",
        join(dir, "ref"),
      ]);
      const hexOf = (x: string): string => Buffer.from(x, "utf8").toString("hex");
      const want = execFileSync(join(dir, "ref"), {
        input: `${ADA_CASES.map(([u, b]) => (b === undefined ? `u${hexOf(u)} -` : `b${hexOf(u)} ${hexOf(b)}`)).join("\n")}\n`,
        encoding: "utf8",
      }).split("\n");
      const bad = got.flatMap((g, i) => {
        const [r, o] = g as [number, number[]];
        const text = `${r}:${Buffer.from(o).toString("hex")}`;
        return text === want[i]
          ? []
          : [`${JSON.stringify(ADA_CASES[i])}\n  native ${text}\n  clang  ${want[i]}`];
      });
      expect(bad).toEqual([]);
    },
    7_200_000,
  );

  it("V8's Math, shaved from ieee754.cc, natively equals Node's Math bit for bit", () => {
    const v8: ShavedUnit = shaveCUnit(
      `${V8}src/base/ieee754.cc`,
      ["ieee754::", "__kernel", "__ieee754"],
      ["-std=c++20", `-I${V8}`, `-I${V8}include`],
    );
    const musl = shaveCUnit(`${MUSL}src/math/scalbn.c`, ["scalbn"], ["-std=c11"], "clang");
    const run = nativeUnit("ieee754", new Map([...v8.atoms, ...musl.atoms]));
    const ONE = [
      "acos",
      "acosh",
      "asin",
      "asinh",
      "atan",
      "atanh",
      "cos",
      "exp",
      "log",
      "log1p",
      "log2",
      "log10",
      "expm1",
      "cbrt",
      "sin",
      "tan",
      "cosh",
      "sinh",
      "tanh",
    ];
    const calls: [string, number[]][] = [];
    for (const f of ONE) for (const x of DOUBLES) calls.push([f, [x]]);
    for (const f of ["atan2", "pow"])
      DOUBLES.forEach((x, i) => {
        calls.push([f, [x, DOUBLES[(i * 7 + 3) % DOUBLES.length] as number]]);
        calls.push([f, [x, DOUBLES[(i * 13 + 11) % DOUBLES.length] as number]]);
      });
    const got = run(calls);
    const bad: string[] = [];
    calls.forEach(([f, a], i) => {
      const want = (Math as unknown as Record<string, (...x: number[]) => number>)[f]?.(...a);
      if (!same(got[i], want) && bad.length < 10)
        bad.push(`${f}(${a.join(", ")}) = ${got[i]}, Node ${want}`);
    });
    expect(bad).toEqual([]);
  }, 900_000);

  it("the C-semantics fixture natively equals its raised source (wrapping, 64-bit, unions, goto)", () => {
    const SIGS: [string, string][] = [
      ["wrap_add", "ii"],
      ["wrap_mul", "ii"],
      ["u_sub_shift", "uu"],
      ["s_shift", "ii"],
      ["trunc_div", "ii"],
      ["trunc_rem", "ii"],
      ["truth", "ii"],
      ["mixed", "iu"],
      ["to_double", "iu"],
      ["from_double", "d"],
      ["wide", "Ui"],
      ["wide_signed", "II"],
      ["words", "d"],
      ["from_words", "uu"],
      ["compound", "ii"],
      ["incdec", "i"],
      ["fallthrough", "i"],
      ["collatz", "i"],
      ["table", "id"],
      ["loops", "i"],
    ];
    const unit = shaveCUnit(
      FIXTURE,
      SIGS.map(([n]) => n),
      ["-std=c11"],
      "clang",
    );
    expect([...unit.refused]).toEqual([]);
    const run = nativeUnit("semantics", unit.atoms);
    // The raised sources run in Node, each function by its name, with the leaves.
    const js = [...unit.atoms]
      .map(
        ([n, a]) =>
          ts.transpileModule(a.source.replace(/^export function f\(/, `function ${n}(`), {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
          }).outputText,
      )
      .join("\n");
    const leaves = Object.entries(C_LEAVES_JS)
      .map(([k, f]) => `const ${k} = ${f.toString()};`)
      .join("\n");
    const ref = new Function(
      `${leaves}\n${js}\nreturn { ${SIGS.map(([n]) => n).join(", ")} };`,
    )() as Record<string, (...a: unknown[]) => unknown>;
    const arb: Record<string, fc.Arbitrary<unknown>> = {
      i: fc.oneof(
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }),
      ),
      u: fc.oneof(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 2 ** 32 - 1 })),
      d: fc.oneof(
        fc.double(),
        fc.double({ min: -1e9, max: 1e9 }),
        fc.constantFrom(0, -0, 0.5, -1.5, 2 ** 31, -(2 ** 31)),
      ),
      U: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
      I: fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
    };
    const calls: [string, unknown[]][] = [];
    for (const [n, ps] of SIGS)
      for (const args of fc.sample(
        fc.tuple(...[...ps].map((p) => arb[p] as fc.Arbitrary<unknown>)),
        {
          numRuns: 150,
          seed: 1361,
        },
      ))
        calls.push([n, args]);
    // An input the C leaves undefined (a division by zero, an out-of-range conversion) throws in
    // the reference: the native run must throw the same, so such inputs are left out of both.
    const kept: [string, unknown[], unknown][] = [];
    for (const [n, a] of calls) {
      try {
        kept.push([n, a, ref[n]?.(...a)]);
      } catch {}
    }
    const got = run(kept.map(([n, a]) => [n, a]));
    const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));
    const bad = kept.flatMap(([n, a, want], i) =>
      same(got[i], want) ? [] : [`${n}(${show(a)}) = ${show(got[i])}, raised ${show(want)}`],
    );
    expect(bad.slice(0, 10)).toEqual([]);
    expect(kept.length).toBeGreaterThan(2500);
  }, 900_000);

  it("V8's BigInt arithmetic, shaved from src/bigint, natively equals Node's BigInt (#1516)", () => {
    const unit = shaveV8BigInt();
    expect([...unit.refused]).toEqual([]);
    // What it calls of the C library (a struct's copy, an abort): musl's, shaved.
    const libc = shaveMusl(["memcpy", "memset", "memmove", "abort"]);
    expect(libc.refused).toEqual([]);
    const atoms = new Map([...libc.atoms, ...unit.atoms]);
    const statics = new Map([...libc.units.flatMap((u) => [...u.statics]), ...unit.statics]);
    const M = V8_BIGINT_METHODS;
    const DRIVERS: [string, string][] = [
      // A BigInt's magnitude as V8's Digits ({ digits, len }, 64-bit digits), and back. Each driver
      // calls the library as V8's src/objects/bigint.cc does (zero's string is "0" before it).
      [
        "mk",
        "export function f(x: bigint): number { let m = x < 0n ? -x : x; let n = 0; let t = m; while (t > 0n) { n++; t = t >> 64n; } const d = __ykAlloc((n > 0 ? n : 1) * 8, 8); for (let i = 0; i < n; i++) { __ykStore64(d + 8 * i, m & 18446744073709551615n); m = m >> 64n; } const s = __ykAlloc(16, 8); __ykStore64(s, __ykNumToBig(d)); __ykStore32(s + 8, n); return s; }",
      ],
      [
        "mkz",
        "export function f(n: number): number { const d = __ykAlloc((n > 0 ? n : 1) * 8, 8); const s = __ykAlloc(16, 8); __ykStore64(s, __ykNumToBig(d)); __ykStore32(s + 8, n); return s; }",
      ],
      [
        "val",
        "export function f(s: number): bigint { const d = __ykBigToF64(__ykLoad64(s)); const n = __ykLoad32(s + 8) | 0; let r = 0n; for (let i = n - 1; i >= 0; i--) r = (r << 64n) | __ykLoad64(d + 8 * i); return r; }",
      ],
      [
        "tMul",
        `export function f(a: bigint, b: bigint): bigint { const p = yk_v8_bigint_processor(); const X = mk(a); const Y = mk(b); const Z = mkz(MultiplyResultLength(X, Y)); ${M.multiply}(p, Z, X, Y); const m = val(Z); return (a < 0n) !== (b < 0n) ? -m : m; }`,
      ],
      [
        "tDiv",
        `export function f(a: bigint, b: bigint): unknown { const p = yk_v8_bigint_processor(); const A = mk(a); const B = mk(b); if (Compare(A, B) < 0) return [0n, a]; const Q = mkz(DivideResultLength(A, B)); ${M.divide}(p, Q, A, B); const R = mkz(ModuloResultLength(B)); ${M.modulo}(p, R, A, B); const q = val(Q); const r = val(R); return [(a < 0n) !== (b < 0n) ? -q : q, a < 0n ? -r : r]; }`,
      ],
      [
        "tAdd",
        "export function f(a: bigint, b: bigint): bigint { const X = mk(a); const Y = mk(b); const Z = mkz(AddSignedResultLength(__ykLoad32(X + 8), __ykLoad32(Y + 8), (a < 0n) === (b < 0n))); const neg = AddSigned(Z, X, a < 0n, Y, b < 0n); const m = val(Z); return neg ? -m : m; }",
      ],
      [
        "tStr",
        `export function f(a: bigint, radix: number): string { if (a === 0n) return "0"; const p = yk_v8_bigint_processor(); const X = mk(a); const n = ToStringResultLength(X, radix, a < 0n); const out = __ykAlloc(n > 0 ? n : 1, 1); const len = __ykAlloc(4, 4); __ykStore32(len, n); ${M.toString}(p, out, len, X, radix, a < 0n); let s = ""; for (let i = 0; i < (__ykLoad32(len) | 0); i++) s += String.fromCharCode(__ykLoad8(out + i)); return s; }`,
      ],
      [
        // (Its sign: V8's Compare gives the digits' difference when the lengths differ.)
        "tCmp",
        "export function f(a: bigint, b: bigint): number { const c = Compare(mk(a), mk(b)); return c > 0 ? 1 : c < 0 ? -1 : 0; }",
      ],
    ];
    const run = nativeUnitWith("v8bigint", atoms, DRIVERS, statics);
    const big = (seed: number, n: number) =>
      fc.sample(
        fc.oneof(
          fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }),
          fc.bigInt({ min: -(2n ** 4000n), max: 2n ** 4000n }),
          // (The harness reads a BigInt of at most 4095 characters: Karatsuba, Toom-Cook and
          // Burnikel-Ziegler, not FFT or Barrett.)
          fc.bigInt({ min: -(2n ** 12000n), max: 2n ** 12000n }),
        ),
        { numRuns: n, seed },
      );
    const xs = [0n, 1n, -1n, 2n ** 64n - 1n, 2n ** 64n, -(2n ** 128n), ...big(1516, 40)];
    const ys = [1n, -1n, 3n, 2n ** 64n + 1n, -(2n ** 63n), ...big(1517, 40)].map((y) =>
      y === 0n ? 7n : y,
    );
    const calls: [string, unknown[]][] = [];
    const want: unknown[] = [];
    xs.forEach((x, i) => {
      const y = ys[i % ys.length] as bigint;
      calls.push(["tMul", [x, y]]);
      want.push(x * y);
      calls.push(["tDiv", [x, y]]);
      want.push([x / y, x % y]);
      calls.push(["tAdd", [x, y]]);
      want.push(x + y);
      calls.push(["tCmp", [x, y]]);
      const ax = x < 0n ? -x : x;
      const ay = y < 0n ? -y : y;
      want.push(ax < ay ? -1 : ax > ay ? 1 : 0);
      for (const radix of [10, 16, 7]) {
        calls.push(["tStr", [x, radix]]);
        want.push(x.toString(radix));
      }
    });
    const got = run(calls);
    const bad = calls.flatMap(([f, a], i) =>
      same(got[i], want[i])
        ? []
        : [
            `${f}(${a.map(String).join(", ").slice(0, 80)}): ${String(got[i]).slice(0, 80)} vs ${String(want[i]).slice(0, 80)}`,
          ],
    );
    expect(bad.slice(0, 8)).toEqual([]);
  }, 900_000);

  it("SQLite's record helpers (varints, serial values, text to numbers), shaved, natively equal the native C (#1363)", () => {
    // The SQLite yakcc runs on (better-sqlite3's amalgamation), as raise-c-sqlite.test.ts shaves it.
    let sqlite: string;
    try {
      const req = createRequire(here("../../registry/package.json"));
      sqlite = join(dirname(req.resolve("better-sqlite3/package.json")), "deps/sqlite3/sqlite3.c");
    } catch {
      return;
    }
    const ARGS = [
      "-std=c11",
      "-DSQLITE_THREADSAFE=0",
      "-DSQLITE_OMIT_LOAD_EXTENSION",
      "-DSQLITE_DISABLE_INTRINSIC",
    ];
    const ROOTS = [
      "sqlite3PutVarint",
      "sqlite3GetVarint",
      "sqlite3GetVarint32",
      "sqlite3VarintLen",
      "sqlite3VdbeSerialTypeLen",
      "sqlite3VdbeSerialGet",
      "sqlite3Atoi64",
      "sqlite3GetInt32",
      "sqlite3AtoF",
    ];
    const unit = shaveCUnit(sqlite, ROOTS, ARGS, "clang");
    const libc = shaveMusl(["memcpy", "memset", "strlen", "strcmp"]);
    expect([...unit.refused, ...libc.refused]).toEqual([]);
    const atoms = new Map([...libc.atoms, ...unit.atoms]);
    const statics = new Map([...libc.units.flatMap((u) => [...u.statics]), ...unit.statics]);
    const mem = recordLayouts(
      execFileSync(
        "clang",
        [...ARGS, "-fsyntax-only", "-Xclang", "-fdump-record-layouts-complete", sqlite],
        {
          encoding: "utf8",
          maxBuffer: 1 << 30,
        },
      ),
    ).get("struct sqlite3_value");
    if (mem === undefined) throw new Error("no layout of sqlite3_value");
    const off = (f: string): number => (mem.fields.get(f) as { offset: number }).offset;
    // The oracle: the same helpers compiled natively from the amalgamation.
    const dir = join(work, "sqlite");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "oracle.c"),
      `#include "${sqlite}"
#include <stdio.h>
static char h[1 << 14];
static unsigned char b[1 << 13];
static int fill(void) { int n = 0; for (; h[2 * n]; n++) { unsigned v; sscanf(h + 2 * n, "%2x", &v); b[n] = (unsigned char)v; } b[n] = 0; return n; }
int main(void) {
  char op[32];
  while (scanf("%31s", op) == 1) {
    if (!strcmp(op, "put")) { unsigned long long v; scanf("%llx", &v); unsigned char o[16] = {0}; int n = sqlite3PutVarint(o, v); printf("%d ", n); for (int i = 0; i < 16; i++) printf("%02x", o[i]); printf("\\n"); }
    else if (!strcmp(op, "get")) { scanf("%s", h); fill(); u64 v = 0; int n = sqlite3GetVarint(b, &v); printf("%d %llx\\n", n, (unsigned long long)v); }
    else if (!strcmp(op, "get32")) { scanf("%s", h); fill(); u32 v = 0; int n = sqlite3GetVarint32(b, &v); printf("%d %x\\n", n, v); }
    else if (!strcmp(op, "len")) { unsigned long long v; scanf("%llx", &v); printf("%d\\n", sqlite3VarintLen(v)); }
    else if (!strcmp(op, "tlen")) { unsigned t; scanf("%u", &t); printf("%u\\n", sqlite3VdbeSerialTypeLen(t)); }
    else if (!strcmp(op, "serial")) { unsigned t; scanf("%u %s", &t, h); fill(); Mem m; memset(&m, 0, sizeof m);
      sqlite3VdbeSerialGet(b, t, &m); unsigned long long u; memcpy(&u, &m.u, 8);
      printf("%x %d %llx %ld\\n", m.flags, m.n, u, m.z ? (long)((unsigned char *)m.z - b) : -1L); }
    else if (!strcmp(op, "atoi")) { int len; scanf("%d %s", &len, h); fill(); i64 v = 0; int rc = sqlite3Atoi64((char *)b, &v, len, SQLITE_UTF8); printf("%d %llx\\n", rc, (unsigned long long)v); }
    else if (!strcmp(op, "int32")) { scanf("%s", h); fill(); int v = 0; int rc = sqlite3GetInt32((char *)b, &v); printf("%d %d\\n", rc, v); }
    else if (!strcmp(op, "atof")) { scanf("%s", h); fill(); double v = 0; int rc = sqlite3AtoF((char *)b, &v); unsigned long long u; memcpy(&u, &v, 8); printf("%d %llx\\n", rc, u); }
  }
  return 0;
}
`,
    );
    execFileSync(
      "clang",
      [...ARGS, "-O0", "-fwrapv", "-ffp-contract=off", "oracle.c", "-o", "oracle", "-lm"],
      { cwd: dir, stdio: "ignore" },
    );
    // The drivers: buffers made and read through the leaves; each prints as the oracle does.
    const DRIVERS: [string, string][] = [
      [
        "put",
        "export function f(bytes: number[]): number { const a = __ykAlloc(bytes.length > 0 ? bytes.length : 1, 16); for (let i = 0; i < bytes.length; i++) __ykStore8(a + i, bytes[i] as number); return a; }",
      ],
      [
        "hexOf",
        'export function f(p: number, n: number): string { let s = ""; for (let i = 0; i < n; i++) { const b = __ykLoad8(p + i); s += (b < 16 ? "0" : "") + b.toString(16); } return s; }',
      ],
      [
        "zeros",
        "export function f(n: number): number[] { const z: number[] = []; for (let i = 0; i < n; i++) z.push(0); return z; }",
      ],
      [
        "dPut",
        "export function f(v: bigint): string { const p = put(zeros(16)); const n = sqlite3PutVarint(p, v); return `${n} ${hexOf(p, 16)}`; }",
      ],
      ["dLen", "export function f(v: bigint): string { return String(sqlite3VarintLen(v)); }"],
      [
        "dGet",
        "export function f(bytes: number[]): string { const p = put(bytes); const pv = put(zeros(8)); const n = sqlite3GetVarint(p, pv); return `${n} ${__ykLoad64(pv).toString(16)}`; }",
      ],
      [
        "dGet32",
        "export function f(bytes: number[]): string { const p = put(bytes); const pv = put(zeros(8)); const n = sqlite3GetVarint32(p, pv); return `${n} ${__ykLoad32(pv).toString(16)}`; }",
      ],
      [
        "dTlen",
        "export function f(t: number): string { return String(sqlite3VdbeSerialTypeLen(t)); }",
      ],
      [
        "dSerial",
        `export function f(t: number, bytes: number[]): string { const p = put(bytes); const pm = put(zeros(${mem.size})); sqlite3VdbeSerialGet(p, t, pm); const flags = __ykLoad16(pm + ${off("flags")}); const n = __ykLoad32(pm + ${off("n")}) | 0; const u = __ykLoad64(pm + ${off("u")}); const z = __ykBigToF64(__ykLoad64(pm + ${off("z")})); return \`\${flags.toString(16)} \${n} \${u.toString(16)} \${z === 0 ? -1 : z - p}\`; }`,
      ],
      [
        "dAtoi",
        "export function f(bytes: number[], len: number): string { const p = put([...bytes, 0]); const pv = put(zeros(8)); const rc = sqlite3Atoi64(p, pv, len, 1); return `${rc} ${__ykLoad64(pv).toString(16)}`; }",
      ],
      [
        "dInt32",
        "export function f(bytes: number[]): string { const p = put([...bytes, 0]); const pv = put(zeros(8)); const rc = sqlite3GetInt32(p, pv); return `${rc} ${__ykLoad32(pv) | 0}`; }",
      ],
      [
        "dAtoF",
        "export function f(bytes: number[]): string { const p = put([...bytes, 0]); const pv = put(zeros(8)); const rc = sqlite3AtoF(p, pv); return `${rc} ${__ykLoad64(pv).toString(16)}`; }",
      ],
    ];
    const run = nativeUnitWith("sqlite", atoms, DRIVERS, statics);
    const hex = (b: readonly number[]): string =>
      b.map((x) => x.toString(16).padStart(2, "0")).join("");
    const utf8 = (t: string): number[] => [...Buffer.from(t, "utf8")];
    const calls: [string, unknown[]][] = [];
    const lines: string[] = [];
    const u64s = [
      0n,
      1n,
      127n,
      128n,
      240n,
      2287n,
      2288n,
      67823n,
      67824n,
      (1n << 56n) - 1n,
      1n << 56n,
      2n ** 64n - 1n,
      ...fc.sample(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), { numRuns: 80, seed: 1363 }),
    ];
    for (const v of u64s) {
      calls.push(["dPut", [v]], ["dLen", [v]]);
      lines.push(`put ${v.toString(16)}`, `len ${v.toString(16)}`);
    }
    for (const bytes of fc.sample(
      fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 9, maxLength: 12 }),
      { numRuns: 80, seed: 1364 },
    )) {
      calls.push(["dGet", [bytes]], ["dGet32", [bytes]]);
      lines.push(`get ${hex(bytes)}`, `get32 ${hex(bytes)}`);
    }
    for (const t of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 20, 33]) {
      calls.push(["dTlen", [t]]);
      lines.push(`tlen ${t}`);
      for (const bytes of fc.sample(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 16, maxLength: 16 }),
        { numRuns: 3, seed: 1365 + t },
      )) {
        calls.push(["dSerial", [t, bytes]]);
        lines.push(`serial ${t} ${hex(bytes)}`);
      }
    }
    const texts = [
      "0",
      "-0",
      "+5",
      "  12",
      "12abc",
      "9223372036854775807",
      "9223372036854775808",
      "-9223372036854775808",
      "-9223372036854775809",
      "2147483648",
      "-2147483649",
      "1e10",
      "1.5e-300",
      "1e-400",
      "1e999",
      ".5",
      "-.5e+3",
      "3.14159265358979323846",
      "0.1",
      "2.2250738585072014e-308",
      "4.9e-324",
      "  -1.25E2  ",
      "nan",
      "1e+",
      ...fc.sample(fc.double({ noNaN: true }).map(String), { numRuns: 40, seed: 1366 }),
    ];
    for (const text of texts) {
      const bytes = utf8(text);
      calls.push(["dAtoi", [bytes, bytes.length]], ["dInt32", [bytes]], ["dAtoF", [bytes]]);
      lines.push(`atoi ${bytes.length} ${hex(bytes)}`, `int32 ${hex(bytes)}`, `atof ${hex(bytes)}`);
    }
    const want = execFileSync(join(dir, "oracle"), {
      input: `${lines.join("\n")}\n`,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    const got = run(calls);
    const bad = got.flatMap((g, i) =>
      g === want[i] ? [] : [`${lines[i]}: native ${String(g)}, C ${want[i]}`],
    );
    expect(bad.slice(0, 10)).toEqual([]);
  }, 1_800_000);

  it("musl's memcpy, memset, strlen, strcmp and qsort, shaved, natively over the memory leaves equal their raised source", () => {
    const MUSL_ARGS = [
      "-std=c99",
      "-nostdinc",
      "-ffreestanding",
      "-D_XOPEN_SOURCE=700",
      `-I${MUSL}yakcc`,
      `-I${MUSL}arch/x86_64`,
      `-I${MUSL}src/include`,
      `-I${MUSL}src/internal`,
      `-I${MUSL}obj/include`,
      `-I${MUSL}include`,
    ];
    const units = [
      shaveCUnit(`${MUSL}src/string/memcpy.c`, ["memcpy"], MUSL_ARGS, "clang"),
      shaveCUnit(`${MUSL}src/string/memset.c`, ["memset"], MUSL_ARGS, "clang"),
      shaveCUnit(`${MUSL}src/string/strlen.c`, ["strlen"], MUSL_ARGS, "clang"),
      shaveCUnit(`${MUSL}src/string/strcmp.c`, ["strcmp"], MUSL_ARGS, "clang"),
      shaveCUnit(`${MUSL}src/stdlib/qsort.c`, ["__qsort_r"], MUSL_ARGS, "clang"),
      shaveCUnit(`${MUSL}src/stdlib/qsort_nr.c`, ["qsort"], MUSL_ARGS, "clang"),
    ];
    for (const u of units) expect([...u.refused]).toEqual([]);
    const atoms = new Map(units.flatMap((u) => [...u.atoms]));
    // The drivers: buffers made and read through the leaves, the same source in both memories.
    const DRIVERS: [string, string][] = [
      [
        "put",
        "export function f(bytes: number[]): number { const a = __ykAlloc(bytes.length, 16); for (let i = 0; i < bytes.length; i++) __ykStore8(a + i, bytes[i] as number); return a; }",
      ],
      [
        "get",
        "export function f(a: number, n: number): number[] { const out: number[] = []; for (let i = 0; i < n; i++) out.push(__ykLoad8(a + i)); return out; }",
      ],
      [
        "tMemcpy",
        "export function f(src: number[], dst: number[], d: number, s: number, n: number): unknown { const ps = put(src); const pd = put(dst); const r = memcpy(pd + d, ps + s, BigInt(n)) as number; return [get(pd, dst.length), r - pd]; }",
      ],
      [
        "tMemset",
        "export function f(dst: number[], d: number, c: number, n: number): unknown { const pd = put(dst); const r = memset(pd + d, c, BigInt(n)) as number; return [get(pd, dst.length), r - pd]; }",
      ],
      [
        "tStrlen",
        "export function f(buf: number[], o: number): unknown { return strlen(put(buf) + o); }",
      ],
      [
        "tStrcmp",
        "export function f(p: number[], q: number[], a: number, b: number): unknown { return strcmp(put(p) + a, put(q) + b); }",
      ],
      [
        "cmpInt",
        "export function f(a: number, b: number): number { const x = __ykLoad32(a) | 0; const y = __ykLoad32(b) | 0; return x < y ? -1 : x > y ? 1 : 0; }",
      ],
      [
        "tQsort",
        "export function f(xs: number[]): unknown { const a = __ykAlloc(xs.length * 4, 16); for (let i = 0; i < xs.length; i++) __ykStore32(a + 4 * i, xs[i] as number); qsort(a, BigInt(xs.length), 4n, __ykFnAddr(cmpInt)); const out: number[] = []; for (let i = 0; i < xs.length; i++) out.push(__ykLoad32(a + 4 * i) | 0); return out; }",
      ],
      ["readAt", "export function f(p: number): number { return __ykLoad32(p); }"],
      [
        // Accesses at constant offsets inside the function's own frame, and another block's after
        // it is freed (#1369).
        "frameUse",
        "export function f(n: number, past: boolean): unknown { const a = __ykAlloc(24, 8); __ykStoreF64(a + 8, n); __ykStore32(a + (2 * 8), n); const x = __ykLoadF64(a + (1 * 8)); const y = __ykLoad32(a + 16); if (past) return [x, y]; __ykFree(a); const b = __ykAlloc(24, 8); __ykStoreF64(b + 8, 1.5); const z = __ykLoadF64(b + 8); __ykFree(b); return [x, y, z]; }",
      ],
      [
        // A pointer parameter read and written at constant offsets: its span looked up on entry.
        "spanUse",
        "export function f(p: number, mode: number): unknown { const a = __ykLoad32(p) | 0; if (mode === 1) __ykFree(p); if (mode === 2) __ykStore32(p + 4, 9); const b = __ykLoadF64(p + 8); __ykStoreF64(p + 16, b + a); return [a, b, __ykLoadF64(p + (2 * 8))]; }",
      ],
      [
        "tSpan",
        'export function f(kind: number, mode: number): unknown { let p: unknown = 0; if (kind === 0) { p = __ykAlloc(24, 8); __ykStore32(p as number, 5); __ykStoreF64((p as number) + 8, 2.5); } if (kind === 1) p = __ykData("u32", [1, 2, 3, 4, 5, 6]); if (kind === 2) p = "x"; if (kind === 3) p = __ykAlloc(12, 4); if (kind === 4) { p = __ykAlloc(24, 8); __ykFree(p as number); } try { return spanUse(p as number, mode); } catch (e) { return (e as Error).message; } }',
      ],
      [
        "tFrame",
        "export function f(n: number, past: boolean): unknown { try { return frameUse(n, past); } catch (e) { return (e as Error).message; } }",
      ],
      [
        // Blocks whose address never escapes (a C front end's spilled locals): a bit cast through
        // memory and stores of every width at constant offsets, as allocas (#1369).
        "tLocal",
        "export function f(x: number, k: number): unknown { const n = k | 0; const p = __ykAlloc(8, 8); const q = __ykAlloc(16, 8); __ykStoreF64(p, x); const bits = __ykLoad64(p); __ykStore64(p, (bits & 18446744069414584320n) | 5n); const y = __ykLoadF64(p); __ykStore32(q + 4, n); __ykStore8(q, n); __ykStore16(q + 2, n); __ykStoreF32(q + 8, x); const f32 = __ykLoadF32(q + 8); __ykStore64(q + 8, bits); const r = [y, __ykLoad32(q + 4), __ykLoad8(q), __ykLoad16(q + 2), f32, __ykLoad64(q + 8) === bits]; __ykFree(q); __ykFree(p); return r; }",
      ],
      [
        // A frame used only three branches deep (and handed to another function): allocated there
        // on first use, its frees on every path nothing when it never was (#1369).
        "tLazy",
        "export function f(a: number, b: number, c: number): unknown { const t = __ykAlloc(24, 8); if (a > 0) { if (b > 0) { if (c > 0) { __ykStore32(t + 4, a + b + c); const r = readAt(t + 4); __ykFree(t); return [r, t > 0]; } } __ykFree(t); return [-1]; } __ykFree(t); return [-2]; }",
      ],
      // Blocks passed whole to functions that only access them at constant offsets: an alloca, its
      // bytes and length passed to the callees' raw variants, through two calls; past its length a
      // trap (#1369).
      [
        "rawFill",
        "export function f(p: number, x: number): unknown { __ykStoreF64(p, x); __ykStoreF64(p + 8, -x); return 0; }",
      ],
      [
        "rawPass",
        "export function f(p: number, x: number): unknown { rawFill(p, x * 2); return __ykLoadF64(p + 8) + __ykLoad8(p + 7); }",
      ],
      ["rawOver", "export function f(p: number): unknown { __ykStore32(p + 12, 1); return 0; }"],
      [
        "tRaw",
        "export function f(x: number, n: number): unknown { const y = __ykAlloc(16, 8); const a = rawPass(y, x); const r = [a, __ykLoadF64(y), __ykLoadF64(y + 8)]; let t = false; const z = __ykAlloc(12, 4); try { if (n > 0) rawOver(z); } catch (e) { t = true; } __ykFree(z); __ykFree(y); return [r, t]; }",
      ],
    ];
    const run = nativeUnitWith("musl", atoms, DRIVERS);
    // tRaw's blocks reach rawPass's and rawOver's raw variants, and rawPass's its callee's.
    const lowered = readFileSync(join(work, "musl", "m.ll"), "utf8");
    expect(lowered.match(/call i64 @m0_s\d+\.raw(\.num)?\(/g)?.length ?? 0).toBeGreaterThanOrEqual(
      3,
    );
    // The reference: the raised sources and the drivers in Node, over createCMemory.
    const memory = createCMemory();
    const leaves = {
      ...(C_LEAVES_JS as Record<string, unknown>),
      ...(memory.leaves as Record<string, unknown>),
    };
    const all: [string, string][] = [
      ...[...atoms].map(([n, a]) => [n, a.source] as [string, string]),
      ...DRIVERS,
    ];
    const js = all
      .map(
        ([n, src]) =>
          ts.transpileModule(src.replace(/^export function f\(/, `function ${n}(`), {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
          }).outputText,
      )
      .join("\n");
    const ref = new Function(
      ...Object.keys(leaves),
      `${js}\nreturn { ${DRIVERS.map(([n]) => n).join(", ")} };`,
    )(...Object.values(leaves)) as Record<string, (...a: unknown[]) => unknown>;
    const bytes = (n: number, seed: number, min = 0) =>
      fc.sample(fc.integer({ min, max: 255 }), { numRuns: n, seed });
    const calls: [string, unknown[]][] = [];
    for (let i = 0; i < 60; i++) {
      const n = (i * 37) % 120;
      calls.push(["tMemcpy", [bytes(160, i), bytes(160, i + 500), i % 16, (i * 7) % 16, n]]);
      calls.push(["tMemset", [bytes(160, i + 900), (i * 5) % 16, i * 131 - 3000, n]]);
      calls.push(["tStrlen", [[...bytes(i % 16, i + 50), ...bytes(n, i + 1300, 1), 0], i % 16]]);
      const common = bytes(n % 40, i + 1700, 1);
      calls.push([
        "tStrcmp",
        [[...common, ...bytes(3, i + 1800), 0], [...common, ...bytes(3, i + 1900), 0], 0, 0],
      ]);
      calls.push([
        "tQsort",
        [
          fc.sample(fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), {
            numRuns: (i * 3) % 50,
            seed: i + 2100,
          }),
        ],
      ]);
    }
    // Memory is the machine's natively (#1516): an access outside a live block (past its end, after
    // its free, a store into constant data) is undefined, as in C, where the JavaScript definition
    // traps; only the defined accesses are compared, and an address that is not a number traps in
    // both.
    calls.push(
      ["tSpan", [0, 0]],
      ["tSpan", [0, 2]],
      ...[0, 1, 2].map((mode) => ["tSpan", [2, mode]] as [string, unknown[]]),
      ["tFrame", [7, false]],
      ["tFrame", [-2.5, false]],
      ["tRaw", [1.25, 12]],
      ["tRaw", [-3, 0]],
      ["tRaw", [Number.NaN, 12]],
      ["tLazy", [1, 2, 3]],
      ["tLazy", [1, 2, -3]],
      ["tLazy", [1, -2, 3]],
      ["tLazy", [-1, 2, 3]],
      ["tLocal", [1.5, 300]],
      ["tLocal", [-0, -7]],
      ["tLocal", [Number.NaN, 70000]],
      ["tLocal", [-123456.789, 4294967295]],
    );
    const got = run(calls);
    const bad: string[] = [];
    calls.forEach(([fn, args], i) => {
      let want: unknown;
      try {
        want = ref[fn]?.(...args);
      } catch (e) {
        want = `threw ${(e as Error).message}`;
      }
      if (!same(got[i], want) && bad.length < 5)
        bad.push(`${fn}: ${JSON.stringify(got[i])} vs ${JSON.stringify(want)}`);
    });
    expect(bad).toEqual([]);
  }, 900_000);
});
