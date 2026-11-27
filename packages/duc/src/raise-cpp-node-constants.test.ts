// SPDX-License-Identifier: Apache-2.0
// Node's constants binding (#1367), shaved from node/src's C++ rather than written out by hand
// (the stand-in in __fixtures__/node/bindings.js): src/node_constants.cc, whose values are the
// headers' (glibc's errno, signals and fs flags, OpenSSL's, zlib's, libuv's), over V8's API as
// leaves and musl. Against Node's own internalBinding('constants'): the same objects, each with a
// null prototype, each property with the same attributes and value.
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

const ROOT =
  "_ZN4node9constants26CreatePerContextPropertiesEN2v85LocalINS1_6ObjectEEENS2_INS1_5ValueEEENS2_INS1_7ContextEEEPv";
/** The files constants' calls reach (env.cc and node_realm.cc for statics). */
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
];
/** An object as its own properties and their attributes say, nested; and its prototype null. */
const DUMP = `(function dump(o) {
  return { proto: Object.getPrototypeOf(o) === null,
    props: Object.getOwnPropertyNames(o).sort().map((k) => {
      const d = Object.getOwnPropertyDescriptor(o, k);
      return [k, d.writable, d.enumerable, d.configurable,
        typeof d.value === 'object' && d.value !== null ? dump(d.value) : d.value];
    }) };
})`;

describe.skipIf(!hasClang)("Node's constants binding, shaved from node/src", () => {
  const shaved = shaveBinding("src/node_constants.cc", [ROOT], FILES);

  it("shaves with no refusal off Node's fatal-error path", () => {
    for (const u of shaved.units) expect([...u.refused]).toEqual([]);
    // (What CHECK's failure reaches: node::Assert's report, iostreams and libstdc++'s compiled
    // locale, not vendored.)
    const fatal =
      /^_ZNK?(?:4node28NativeSymbolDebuggingContext|St7__cxx1119basic_ostringstream|St7__cxx1115basic_stringbuf)/;
    expect(shaved.files.refused.filter((r) => !fatal.test(r))).toEqual([]);
    expect(shaved.musl.refused).toEqual([]);
  });

  it("is Node's own, every object and property (as raised)", () => {
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
    runInitializers(env, [...shaved.files.units, ...shaved.units]);
    const context = memory.leaves.__ykAlloc(8, 8);
    memory.leaves.__ykStore64(context, BigInt(v8.context));
    (env.yk_node_environment as Fn)(v8.isolate, context);
    const binding: object = {};
    (env[ROOT] as Fn)(v8.local(binding), v8.local(undefined), context, 0);
    const node = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--expose-internals",
          "--no-warnings",
          "-e",
          `const { internalBinding } = require('internal/test/binding'); console.log(JSON.stringify(${DUMP}(internalBinding('constants'))));`,
        ],
        { encoding: "utf8", maxBuffer: 1 << 26 },
      ),
    );
    // biome-ignore lint/security/noGlobalEval: the same dump function as the oracle's
    expect(JSON.parse(JSON.stringify(eval(DUMP)(binding)))).toEqual(node);
  });
});
