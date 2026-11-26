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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { ts } from "ts-morph";
import { afterAll, describe, expect, it } from "vitest";
import { canRun, decode, encode, same } from "./__fixtures__/native-harness.js";
import { emitNativeModules } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";
import { compileObject, compileRuntime } from "./native.js";
import { C_LEAVES_JS, type ShavedUnit, createCMemory, shaveCUnit } from "./raise-c.js";

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
  const { ir, symbols } = emitNativeModules([{ id: `${name}.js`, statements }]);
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
        // Accesses at constant offsets inside the function's own frame, before and after it is
        // freed and its bytes reused, and one past its end (#1369).
        "frameUse",
        "export function f(n: number, past: boolean): unknown { const a = __ykAlloc(24, 8); __ykStoreF64(a + 8, n); __ykStore32(a + (2 * 8), n); const x = __ykLoadF64(a + (1 * 8)); const y = __ykLoad32(a + 16); if (past) return [x, y, __ykLoad8(a + 32)]; __ykFree(a); const b = __ykAlloc(24, 8); __ykStoreF64(b + 8, 1.5); return [x, y, b > a, __ykLoadF64(a + 8)]; }",
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
        // One access site, its cache holding a region that is freed and whose bytes are reused:
        // the stale address still traps (#1369).
        "tStale",
        "export function f(n: number): unknown { const a = __ykAlloc(16, 8); __ykStore32(a, n); const d = __ykAlloc(16, 8); __ykStore32(d, n + 1); const x = readAt(a); const e = __ykAlloc(16, 8); const y = readAt(d) + readAt(a); __ykFree(a); const c = __ykAlloc(16, 8); __ykStore32(c, 7); try { return [x, y, e - d, readAt(a)]; } catch (err) { return [x, y, readAt(c), (err as Error).message]; } }",
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
      [
        // Accesses at a computed offset (each site's cache, not a span): a 4- and a 2-byte read and
        // a 4-byte write at every offset to past the end of a 10-byte block, so the last that fits
        // and the first that does not (#1369).
        "readAtK",
        "export function f(p: number, k: number, w: number): unknown { if (w === 4) return __ykLoad32(p + k); if (w === 2) return __ykLoad16(p + k); __ykStore32(p + k, 7); return __ykLoad8(p + k); }",
      ],
      [
        "tEdge",
        "export function f(n: number): unknown { const a = __ykAlloc(10, 2); for (let i = 0; i < 10; i++) __ykStore8(a + i, i + n); const out: unknown[] = []; for (const w of [4, 2, 1]) for (let k = 0; k < 12; k++) { try { out.push(readAtK(a, k, w)); } catch (e) { out.push((e as Error).name); } } __ykFree(a); return out; }",
      ],
      [
        "tTrap",
        "export function f(n: number): unknown { const a = __ykAlloc(8, 8); __ykFree(a); try { return __ykLoad8(a + n); } catch (e) { return [(e as Error).name, (e as Error).message]; } }",
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
    calls.push(
      ["tTrap", [0]],
      ["tTrap", [99]],
      ["tEdge", [3]],
      ["tEdge", [250]],
      ["tStale", [5]],
      ["tStale", [-3]],
      ...[0, 1, 2, 3, 4].flatMap((kind) =>
        [0, 1, 2].map((mode) => ["tSpan", [kind, mode]] as [string, unknown[]]),
      ),
      ["tFrame", [7, false]],
      ["tFrame", [-2.5, false]],
      ["tFrame", [3, true]],
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
