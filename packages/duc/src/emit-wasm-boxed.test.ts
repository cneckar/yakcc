// SPDX-License-Identifier: Apache-2.0
/**
 * wasm beyond numbers (#1300, DEC-DUC-WASM-MEMORY-001 proposed): strings, arrays, objects,
 * closures and exceptions. Each program is lifted, lowered (`emitWasmBoxed`: LLVM's wasm32 backend,
 * with the native runtime compiled for wasm32-wasi into the same linear memory), and run in Node's
 * own wasm engine through WASI, on generated inputs of every value kind. The results must be the
 * TypeScript reference's (`emitTypeScript` of the same graph), exactly:
 * - numbers by `Object.is`;
 * - strings by UTF-16 code units;
 * - arrays and objects element by element and key by key, in order;
 * - an uncaught throw by its ToString.
 *
 * Needs clang, llc and wasm-ld (LLVM 18 or later), and a WASI sysroot: YAKCC_WASI_SYSROOT and
 * YAKCC_WASM_BUILTINS (see wasmToolchainFromEnv). Without them the suite is skipped.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "node:wasi";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { encodeValue } from "./__fixtures__/differential.js";
import { FUNCTION, decode, encode } from "./__fixtures__/native-harness.js";
import { runnable } from "./__fixtures__/runnable.js";
import { LlvmEmitError } from "./emit-llvm.js";
import { emitTypeScript } from "./emit-ts.js";
import { WasmEmitError, emitWasmBoxed, wasmToolchainFromEnv } from "./emit-wasm.js";
import { liftAtom } from "./lift.js";

const tc = wasmToolchainFromEnv();
const tools = ["clang", "llc", "wasm-ld"].every((t) => spawnSync(t, ["--version"]).status === 0);
const work = mkdtempSync(join(tmpdir(), "yakcc-wasm-boxed-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

type Outcome = { readonly value: unknown } | { readonly uncaught: string };

/** Runs the command on each call; after an uncaught throw (exit 70) it starts again past that call. */
async function runWasm(bytes: Uint8Array, calls: readonly unknown[][]): Promise<Outcome[]> {
  const mod = await WebAssembly.compile(bytes);
  const out: Outcome[] = [];
  let next = 0;
  for (let round = 0; next < calls.length; round++) {
    const files = ["in", "out", "err"].map((x) => join(work, `${x}-${round}`)) as [
      string,
      string,
      string,
    ];
    writeFileSync(
      files[0],
      `${calls
        .slice(next)
        .map((args) => args.map(encode).join(" "))
        .join("\n")}\n`,
    );
    const [stdin, stdout, stderr] = [
      openSync(files[0], "r"),
      openSync(files[1], "w"),
      openSync(files[2], "w"),
    ];
    const wasi = new WASI({
      version: "preview1",
      args: [],
      env: {},
      stdin,
      stdout,
      stderr,
      returnOnExit: true,
    });
    const code = wasi.start(
      await WebAssembly.instantiate(mod, wasi.getImportObject() as WebAssembly.Imports),
    );
    for (const fd of [stdin, stdout, stderr]) closeSync(fd);
    const lines = readFileSync(files[1], "utf8")
      .split("\n")
      .filter((l) => l !== "");
    for (const l of lines) out.push({ value: decode(l) });
    next += lines.length;
    if (code === 0) break;
    if (code !== 70)
      throw new Error(`the module exited ${code}: ${readFileSync(files[2], "utf8")}`);
    out.push({ uncaught: readFileSync(files[2], "utf8").replace(/\n$/, "") });
    next++;
  }
  return out;
}

/** The TypeScript reference of the same graph, as the wasm command reports each outcome. */
function reference(code: string): (args: unknown[]) => Outcome {
  const f = new Function(`${runnable(code)}; return f;`)() as (...a: unknown[]) => unknown;
  return (args) => {
    try {
      return { value: f(...structuredClone(args)) };
    } catch (e) {
      // The runtime writes an uncaught value's ToString in ASCII, with "?" for any other unit.
      const text = Array.from(String(e), (c) =>
        c.charCodeAt(0) < 0x80 ? c : "?".repeat(c.length),
      ).join("");
      return { uncaught: `Uncaught ${text}` };
    }
  };
}

/** The runtime's text form has no function value, only a mark: any function stands for it. */
const unmark = (v: unknown): unknown =>
  v === FUNCTION
    ? () => undefined
    : Array.isArray(v)
      ? v.map(unmark)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unmark(x)]))
        : v;

const canonical = (o: Outcome): string =>
  "uncaught" in o ? JSON.stringify(o) : JSON.stringify(encodeValue(unmark(o.value)));

const scalar = fc.oneof(
  fc.double(),
  fc.integer({ min: -1000, max: 1000 }),
  fc.constantFrom(0, -0, Number.NaN, Number.POSITIVE_INFINITY, -1e21, 1e21, 0.1, 1e-7, 2 ** 53),
  fc.string({ maxLength: 6 }),
  fc.string({ unit: "binary", maxLength: 4 }),
  fc.constantFrom("", " ", " 12 ", "0x1F", "-0", "Infinity", "12px", ".5", "a", "abc", "ab,c"),
  fc.boolean(),
  fc.constantFrom(null, undefined),
);
const value = fc.oneof(
  { weight: 4, arbitrary: scalar },
  { weight: 1, arbitrary: fc.array(scalar, { maxLength: 4 }) },
);

const PROGRAMS: [string, string, number][] = [
  ["+ on every pair of kinds", "export function f(a, b) { return a + b; }", 2],
  [
    "operators and their coercions",
    "export function f(a, b) { return [a == b, a === b, a < b, a >= b, typeof a, !a, a - b, a * b, a / b, a % b, -a, a && b, a || b]; }",
    2,
  ],
  [
    "strings: template literals, length, index, charCodeAt, slice, indexOf, split, trim",
    "export function f(s, i) { if (typeof s !== 'string') return `${s}|${i}`; return [s.length, s[i], s.charCodeAt(i), s.slice(i), s.slice(-2, i), s.indexOf('a', i), s.split(','), s.trim(), `<${s}>${i}`]; }",
    2,
  ],
  [
    "arrays: a loop, push, index, join, callbacks, sort",
    "export function f(xs, v) { if (typeof xs !== 'object' || xs === null) return xs; const out = []; let i = 0; while (i < xs.length) { out.push(xs[i] + v); i = i + 1; } const ns = xs.map((x, k) => (typeof x === 'number' && x === x ? x : k)); return [out.join('|'), out.slice(-2), out[99], ns.filter((x) => x > 0), ns.reduce((s, x) => s + x, 0), ns.slice().sort((p, q) => p - q), xs.includes(v)]; }",
    2,
  ],
  [
    "objects: literals, computed keys, reads and writes, methods with this",
    "export function f(a, b) { const k = typeof a === 'string' ? a : 'z'; const o = { x: a, [k]: b, n: 0, bump() { this.n = this.n + 1; return this; } }; o.y = o.x + b; o.bump().bump(); return [o, o.n, o.missing, o[k], Object.keys(o)]; }",
    2,
  ],
  [
    "closures: captures, a counter cell, recursion, functions as values",
    "export function f(a, b) { let count = 0; const add = (x) => { count = count + 1; return x + a; }; const fact = (n) => (n > 1 ? n * fact(n - 1) : 1); const pick = typeof b === 'number' ? add : fact; return [add(b), add(add(1)), count, fact(6), pick(3), typeof pick, add]; }",
    2,
  ],
  [
    "exceptions: throw, catch, finally, the error's name and message",
    "export function f(a, b) { const log = []; try { try { if (typeof a !== 'number') throw new TypeError('not a number: ' + typeof a); if (a < 0) throw new RangeError('negative ' + a); log.push('ok ' + a); } finally { log.push('finally'); } } catch (e) { log.push(e.name + ': ' + e.message); } try { log.push(b.length); } catch (e) { log.push(e instanceof TypeError); } return log; }",
    2,
  ],
  [
    "exceptions: uncaught throws of errors and of plain values",
    "export function f(a, b) { if (typeof a === 'string') throw new Error('str ' + a + b); if (a === null) throw a; if (Array.isArray(a)) throw a.length; return [a, b]; }",
    2,
  ],
];

describe.skipIf(tc === undefined || !tools)(
  "boxed values in wasm, run in Node's engine (#1300)",
  () => {
    for (const [name, source, arity] of PROGRAMS) {
      it(`computes what the TypeScript reference computes: ${name}`, async () => {
        const g = liftAtom(source);
        const bytes = emitWasmBoxed(g, tc as NonNullable<typeof tc>, work);
        const inputs = fc.sample(fc.array(value, { minLength: arity, maxLength: arity }), {
          numRuns: 300,
          seed: 1300,
        });
        const ref = reference(emitTypeScript(g));
        const got = await runWasm(bytes, inputs);
        expect(got.length).toBe(inputs.length);
        const bad = inputs.flatMap((args, i) => {
          const want = canonical(ref(args));
          const have = canonical(got[i] as Outcome);
          return want === have ? [] : [`${JSON.stringify(args)}: reference ${want}, wasm ${have}`];
        });
        expect(bad.slice(0, 5)).toEqual([]);
      }, 300_000);
    }

    it("is deterministic: the same graph gives the same bytes", () => {
      const g = liftAtom("export function f(a, b) { return [a + b, `${a}`]; }");
      const t = tc as NonNullable<typeof tc>;
      expect(
        Buffer.from(emitWasmBoxed(g, t, work)).equals(Buffer.from(emitWasmBoxed(g, t, work))),
      ).toBe(true);
    });

    it("the module needs only WASI from its host: no JavaScript glue", async () => {
      const bytes = emitWasmBoxed(
        liftAtom("export function f(a) { return [a, String(a)]; }"),
        tc as NonNullable<typeof tc>,
        work,
      );
      const imports = WebAssembly.Module.imports(await WebAssembly.compile(bytes));
      expect(imports.filter((i) => i.module !== "wasi_snapshot_preview1")).toEqual([]);
      expect(
        WebAssembly.Module.exports(await WebAssembly.compile(bytes)).map((e) => e.name),
      ).toContain("f");
    });
  },
);

describe("what the boxed wasm lowering refuses, with the reason (#1300)", () => {
  // The refusal comes from the lowering, before any tool runs, so no toolchain is needed here.
  const none = { sysroot: "/nonexistent", builtins: "/nonexistent" };
  const refusal = (source: string): string => {
    try {
      emitWasmBoxed(liftAtom(source), none, work);
    } catch (e) {
      if (e instanceof LlvmEmitError || e instanceof WasmEmitError) return e.message;
      throw e;
    }
    return "lowered";
  };
  it("free names, async functions and generators, and Math an engine may approximate", () => {
    expect(refusal("export function f(x) { return helper(x); }")).toMatch(
      /"helper" is not in the native base set/,
    );
    expect(refusal("export function f(x) { return async () => x; }")).toMatch(/no stack switching/);
    expect(refusal("export function* f(x) { yield x; }")).toMatch(/no stack switching/);
    expect(refusal("export function f(x) { return function* () { yield x; }; }")).toMatch(
      /no stack switching/,
    );
    // Math.sin is a reference to V8's shaved atom (#1362), not lowered here yet.
    expect(refusal("export function f(x) { return Math.sin(x); }")).toMatch(
      /"Math.sin" is not in the subset/,
    );
  });
});

describe("the boxed wasm lowering needs its toolchain named (#1300)", () => {
  it("is undefined without a sysroot, so a caller can say what is missing", () => {
    expect(wasmToolchainFromEnv({})).toBeUndefined();
    expect(
      wasmToolchainFromEnv({
        YAKCC_WASI_SYSROOT: "/nonexistent",
        YAKCC_WASM_BUILTINS: "/nonexistent",
      }),
    ).toBeUndefined();
  });
});
