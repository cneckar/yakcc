// SPDX-License-Identifier: Apache-2.0
// Node's buffer binding (#1367), shaved from node/src's C++ rather than rewritten: its own
// src/node_buffer.cc, with the node/src it calls (string_bytes.cc, util.cc, api/encoding.cc,
// node_errors.cc, ...) and its deps (simdutf, nbytes), over V8's API as leaves (raise-cpp-v8.ts)
// and musl. Against Node's own binding (internalBinding('buffer'), in a Node run with
// --expose-internals): for each of its methods that computes (byteLengthUtf8, compare,
// compareOffset, the swaps, isUtf8, isAscii, every encoding's slice and write, the indexOfs, atob,
// btoa, fill), the same results and the same bytes in its buffers after it.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type Fn, link, runInitializers } from "./__fixtures__/c-link.js";
import { shaveBinding } from "./__fixtures__/c-node.js";
import { createCMemory, createCSystem } from "./raise-c.js";
import { createV8 } from "./raise-cpp-v8.js";

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    execFileSync("c++filt", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The files buffer's calls reach (env.cc and node_realm.cc for statics). */
const FILES = [
  "src/string_bytes.cc",
  "src/util.cc",
  "src/api/encoding.cc",
  "src/node_errors.cc",
  "src/debug_utils.cc",
  "src/node_options.cc",
  "src/env.cc",
  "src/node_realm.cc",
  "deps/simdutf/simdutf.cpp",
  "deps/nbytes/src/nbytes.cpp",
];
const INITIALIZE =
  "_ZN4node6Buffer12_GLOBAL__N_110InitializeEN2v85LocalINS2_6ObjectEEENS3_INS2_5ValueEEENS3_INS2_7ContextEEEPv";

type Case = [string, number[] | null, unknown[]];

/** Node's own binding, the oracle: each case's result and its buffers' bytes after it. */
const ORACLE = `
const { internalBinding } = require('internal/test/binding');
const b = internalBinding('buffer');
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const arg = (a) => (a && typeof a === 'object' && Array.isArray(a.b) ? Buffer.from(a.b) : a);
console.log(JSON.stringify(cases.map(([m, self, args]) => {
  try {
    const t = self === null ? undefined : Buffer.from(self);
    const as = args.map(arg);
    const r = b[m].apply(t, as);
    return [typeof r === 'object' && r !== null ? [...r] : r,
      as.map((x) => (Buffer.isBuffer(x) ? [...x] : null)), t ? [...t] : null];
  } catch (e) { return ['throw ' + e.name + ' ' + e.message]; }
})));`;

describe.skipIf(!hasClang)("Node's buffer binding, shaved from node/src", () => {
  const shaved = shaveBinding("src/node_buffer.cc", [INITIALIZE], FILES);

  it("shaves with no refusal off Node's fatal-error path, but one static's constructor", () => {
    for (const u of shaved.units) expect([...u.refused]).toEqual([]);
    // (What CHECK's failure reaches, node::Assert's report and native backtrace: iostreams and
    // libstdc++'s compiled locale, not vendored; a try statement. And per_process::cli_options,
    // a global a constructor makes at startup, which the raised unit does not run yet: only
    // createUnsafeArrayBuffer reads it.)
    const known =
      /^_ZN(?:K4node28NativeSymbolDebuggingContext|St7__cxx1119basic_ostringstream|St7__cxx1115basic_stringbuf|St27__uninitialized_default_n_1|4node11per_process11cli_optionsE)/;
    expect(shaved.files.refused.filter((r) => !known.test(r))).toEqual([]);
    expect(shaved.musl.refused).toEqual([]);
    expect([...shaved.musl.missing].sort()).toEqual([
      "__cxa_demangle",
      "backtrace",
      "uv_get_process_title",
      "uv_os_getpid",
    ]);
    expect(shaved.missing.every((m) => /^_ZN?K?St(?:6locale|8ios_base|9basic_ios)/.test(m))).toBe(
      true,
    );
  });

  it("computes as Node's own binding does (as raised)", () => {
    const memory = createCMemory();
    const system = createCSystem(memory);
    const v8 = createV8(memory, shaved.v8);
    const env = link(
      new Map([
        ...shaved.musl.atoms,
        ...shaved.files.atoms,
        ...shaved.units.flatMap((u) => [...u.atoms]),
      ]),
      false,
      memory,
      [...shaved.musl.units, ...shaved.files.units, ...shaved.units],
      { ...(system.leaves as unknown as Record<string, Fn>), ...v8.leaves },
    );
    env.yk_musl_init?.();
    // (Node's C++ globals constructed, as its startup does.)
    runInitializers(env, [...shaved.files.units, ...shaved.units]);
    const context = memory.leaves.__ykAlloc(8, 8);
    memory.leaves.__ykStore64(context, BigInt(v8.context));
    (env.yk_node_environment as Fn)(v8.isolate, context);
    const binding: Record<string, (...a: unknown[]) => unknown> = {};
    (env[INITIALIZE] as Fn)(v8.local(binding), v8.local(undefined), context, 0);

    let seed = 1367;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const bytes = (n: number): number[] => Array.from({ length: n }, () => Math.floor(rnd() * 256));
    const strs = [
      "",
      "abc",
      "héllo wörld €",
      "日本語",
      "😀👍🏽",
      "aGVsbG8=",
      "deadBEEF",
      "\u0000ÿ",
    ];
    const cases: Case[] = [];
    for (const s of strs) cases.push(["byteLengthUtf8", null, [s]]);
    for (let i = 0; i < 30; i++) {
      const a = bytes(Math.floor(rnd() * 6));
      const c = rnd() < 0.3 ? [...a] : bytes(Math.floor(rnd() * 6));
      cases.push(["compare", null, [{ b: a }, { b: c }]]);
    }
    for (let i = 0; i < 20; i++)
      cases.push([
        "compareOffset",
        null,
        [
          { b: bytes(8) },
          { b: bytes(8) },
          Math.floor(rnd() * 4),
          Math.floor(rnd() * 4),
          4 + Math.floor(rnd() * 4),
          4 + Math.floor(rnd() * 4),
        ],
      ]);
    for (const sw of ["swap16", "swap32", "swap64"])
      for (let i = 0; i < 3; i++) cases.push([sw, null, [{ b: bytes(16) }]]);
    for (let i = 0; i < 10; i++) {
      const s = Buffer.from(strs[i % strs.length] as string);
      cases.push(["isUtf8", null, [{ b: [...s, ...(i % 3 === 0 ? [0xff] : [])] }]]);
      cases.push(["isAscii", null, [{ b: bytes(12).map((x) => x & (i % 2 ? 0x7f : 0xff)) }]]);
    }
    for (const sl of [
      "asciiSlice",
      "base64Slice",
      "base64urlSlice",
      "latin1Slice",
      "hexSlice",
      "ucs2Slice",
      "utf8Slice",
    ])
      for (const s of strs) cases.push([sl, [...Buffer.from(s)], [0, Buffer.from(s).length]]);
    for (const w of ["base64Write", "base64urlWrite", "hexWrite", "ucs2Write"])
      for (const s of strs) cases.push([w, new Array(32).fill(0), [s, 0, 32]]);
    for (const s of strs)
      cases.push([
        "indexOfString",
        null,
        [{ b: [...Buffer.from("xx héllo abc 日本語 abc")] }, s, 0, 1, true],
      ]);
    for (let i = 0; i < 10; i++)
      cases.push(["indexOfNumber", null, [{ b: bytes(20) }, Math.floor(rnd() * 256), 0, true]]);
    for (let i = 0; i < 10; i++) {
      const h = bytes(24);
      const off = Math.floor(rnd() * 20);
      cases.push(["indexOfBuffer", null, [{ b: h }, { b: h.slice(off, off + 3) }, 0, 1, true]]);
    }
    for (const s of strs) {
      cases.push(["atob", null, [s]]);
      cases.push(["btoa", null, [s]]);
    }
    for (let i = 0; i < 6; i++)
      cases.push(["fill", null, [{ b: new Array(16).fill(0) }, i % 2 ? "ab" : 7, 2, 14, "utf8"]]);

    const node = JSON.parse(
      execFileSync(process.execPath, ["--expose-internals", "--no-warnings", "-e", ORACLE], {
        input: JSON.stringify(cases),
        encoding: "utf8",
        maxBuffer: 1 << 28,
      }),
    ) as unknown[];
    const arg = (a: unknown): unknown =>
      a !== null && typeof a === "object" && Array.isArray((a as { b?: unknown }).b)
        ? Buffer.from((a as { b: number[] }).b)
        : a;
    const results = cases.map(([m, self, args]) => {
      try {
        const t = self === null ? undefined : Buffer.from(self);
        const as = args.map(arg);
        const r = (binding[m] as (...a: unknown[]) => unknown).apply(t, as);
        return [
          typeof r === "object" && r !== null ? [...(r as Iterable<unknown>)] : r,
          as.map((x) => (Buffer.isBuffer(x) ? [...x] : null)),
          t ? [...t] : null,
        ];
      } catch (e) {
        return [`throw ${(e as Error).name} ${(e as Error).message}`];
      }
    });
    // (Both as JSON: the oracle's results come through it, an undefined in an array as null.)
    expect(JSON.parse(JSON.stringify(results))).toEqual(node);
  });
});
