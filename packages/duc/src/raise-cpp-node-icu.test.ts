// SPDX-License-Identifier: Apache-2.0
// Node's icu binding (#1367), shaved from node/src's C++ (src/node_i18n.cc) rather than written by
// hand: with the node/src it calls and Node's ICU (deps/icu-small, as icu-generic.gyp compiles
// it), its data given as Node's startup gives it, over V8's API as leaves and musl. A per-isolate
// binding: its methods set on an ObjectTemplate (CreatePerIsolateProperties). Against Node's own
// internalBinding('icu'): getStringWidth, icuErrName, hasConverter and transcode.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NODE, instantiateBinding, shaveBinding } from "./__fixtures__/c-node.js";

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    execFileSync("c++filt", ["--version"], { stdio: "ignore" });
    execFileSync("bunzip2", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const PER_ISOLATE =
  "_ZN4node4i18nL26CreatePerIsolatePropertiesEPNS_11IsolateDataEN2v85LocalINS3_14ObjectTemplateEEE__node_i18n";
const ICU = "deps/icu-small/source/";
const FILES = [
  "src/util.cc",
  "src/node_errors.cc",
  "src/debug_utils.cc",
  "src/string_bytes.cc",
  "src/node_buffer.cc",
  "src/api/encoding.cc",
  "src/node_options.cc",
  "src/env.cc",
  "src/node_realm.cc",
  "deps/simdutf/simdutf.cpp",
  "deps/nbytes/src/nbytes.cpp",
  ...["common", "i18n"].flatMap((d) =>
    readdirSync(`${NODE}${ICU}${d}`)
      .filter((f) => f.endsWith(".cpp"))
      .sort()
      .map((f) => `${ICU}${d}/${f}`),
  ),
  `${ICU}stubdata/stubdata.cpp`,
];

type Case = [string, unknown[]];
const ORACLE = `
const { internalBinding } = require('internal/test/binding');
const b = internalBinding('icu');
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const arg = (a) => (a && typeof a === 'object' && Array.isArray(a.b) ? Buffer.from(a.b) : a);
console.log(JSON.stringify(cases.map(([m, args]) => {
  try { const r = b[m](...args.map(arg)); return ArrayBuffer.isView(r) ? [...r] : r; }
  catch (e) { return 'throw ' + e.name + ' ' + e.message; }
})));`;

describe.skipIf(!hasClang)("Node's icu binding, shaved from node/src and ICU", () => {
  const shaved = shaveBinding("src/node_i18n.cc", [PER_ISOLATE], FILES, [
    "yk_node_isolate_data",
    "yk_node_icu_data",
  ]);

  it("shaves with no refusal off Node's fatal-error path", () => {
    for (const u of shaved.units) expect([...u.refused]).toEqual([]);
    const fatal =
      /^_ZNK?(?:4node28NativeSymbolDebuggingContext|St7__cxx1119basic_ostringstream|St7__cxx1115basic_stringbuf)/;
    expect(shaved.files.refused.filter((r) => !fatal.test(r))).toEqual([]);
    expect(shaved.musl.refused).toEqual([]);
  });

  it("computes as Node's own binding does (as raised)", () => {
    const data = execFileSync("bunzip2", ["-c", `${NODE}${ICU}data/in/icudt78l.dat.bz2`], {
      maxBuffer: 1 << 27,
    });
    const { binding } = instantiateBinding(shaved, undefined, {
      perIsolate: PER_ISOLATE,
      icuData: data,
    });
    const strs = ["", "abc", "日本語a", "😀👍🏽", "é", "\u0007\u001b[31m", "한국어", "ｶﾀｶﾅ"];
    const cases: Case[] = [];
    for (const s of strs)
      for (const amb of [false, true])
        for (const emoji of [false, true]) cases.push(["getStringWidth", [s, amb, emoji]]);
    for (const code of [-128, -127, 0, 1, 2, 5, 10, 27, 65536, 66560])
      cases.push(["icuErrName", [code]]);
    for (const n of ["utf8", "latin1", "ascii", "ucs2", "utf-16le", "nope"])
      cases.push(["hasConverter", [n]]);
    for (const [s, from, to] of [
      ["héllo €", "utf8", "latin1"],
      ["héllo", "latin1", "utf8"],
      ["日本", "utf8", "ucs2"],
      ["abc", "ascii", "utf8"],
    ] as const)
      cases.push([
        "transcode",
        [{ b: [...Buffer.from(s, from === "latin1" ? "latin1" : "utf8")] }, from, to],
      ]);
    const node = JSON.parse(
      execFileSync(process.execPath, ["--expose-internals", "--no-warnings", "-e", ORACLE], {
        input: JSON.stringify(cases),
        encoding: "utf8",
      }),
    ) as unknown[];
    const arg = (a: unknown): unknown =>
      a !== null && typeof a === "object" && Array.isArray((a as { b?: unknown }).b)
        ? Buffer.from((a as { b: number[] }).b)
        : a;
    const results = cases.map(([m, args]) => {
      try {
        const r = (binding[m] as (...a: unknown[]) => unknown)(...args.map(arg));
        return ArrayBuffer.isView(r) ? [...(r as Uint8Array)] : r;
      } catch (e) {
        return `throw ${(e as Error).name} ${(e as Error).message}`;
      }
    });
    expect(JSON.parse(JSON.stringify(results))).toEqual(node);
  });
});
