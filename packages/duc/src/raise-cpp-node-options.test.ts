// SPDX-License-Identifier: Apache-2.0
// Node's options binding (#1367), shaved from node/src's C++ (src/node_options.cc) rather than
// written out by hand (the stand-in table of __fixtures__/node/bindings.js): Node's option
// parser, built at startup by node_options.cc's own initializers (per_process::cli_options and
// the parsers), over V8's API as leaves and musl. Against Node's own internalBinding('options'):
// every option's value and its metadata. (The oracle runs with --expose-internals, the one value
// a run's flags set: that option's value is left out.)
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { instantiateBinding, shaveBinding } from "./__fixtures__/c-node.js";

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    execFileSync("c++filt", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const INITIALIZE =
  "_ZN4node14options_parser10InitializeEN2v85LocalINS1_6ObjectEEENS2_INS1_5ValueEEENS2_INS1_7ContextEEEPv";
const FILES = [
  "src/util.cc",
  "src/node_errors.cc",
  "src/debug_utils.cc",
  "src/string_bytes.cc",
  "src/node_buffer.cc",
  "src/api/encoding.cc",
  "src/env.cc",
  "src/node_realm.cc",
  "deps/simdutf/simdutf.cpp",
  "deps/nbytes/src/nbytes.cpp",
];
/** A value as JSON can carry it: a Map as its entries, in order. */
const PLAIN = `(function plain(v) {
  if (v instanceof Map) return { map: [...v].map(([k, x]) => [plain(k), plain(x)]) };
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, plain(v[k])]));
  return v === undefined ? { undefined: true } : v;
})`;
const ORACLE = `
const { internalBinding } = require('internal/test/binding');
const b = internalBinding('options');
const plain = ${PLAIN};
const values = b.getCLIOptionsValues();
delete values['--expose-internals'];
console.log(JSON.stringify(plain({ values, info: b.getCLIOptionsInfo(), envSettings: b.envSettings,
  types: b.types, input: b.getEnvOptionsInputType() })));`;

describe.skipIf(!hasClang)("Node's options binding, shaved from node/src", () => {
  const shaved = shaveBinding("src/node_options.cc", [INITIALIZE], FILES, [
    "yk_node_environment_options",
  ]);

  it("shaves with no refusal off Node's fatal-error path", () => {
    for (const u of shaved.units) expect([...u.refused]).toEqual([]);
    const fatal =
      /^_ZNK?(?:4node28NativeSymbolDebuggingContext|St7__cxx1119basic_ostringstream|St7__cxx1115basic_stringbuf)/;
    expect(shaved.files.refused.filter((r) => !fatal.test(r))).toEqual([]);
    expect(shaved.musl.refused).toEqual([]);
  });

  it("gives Node's own option values and metadata (as raised)", () => {
    const { binding } = instantiateBinding(shaved, INITIALIZE, {
      environment: ["yk_node_environment_options"],
    });
    const call = (m: string): unknown => (binding[m] as () => unknown)();
    const { "--expose-internals": _flag, ...values } = call("getCLIOptionsValues") as Record<
      string,
      unknown
    >;
    // biome-ignore lint/security/noGlobalEval: the same function as the oracle's
    const plain = eval(PLAIN) as (v: unknown) => unknown;
    const mine = plain({
      values,
      info: call("getCLIOptionsInfo"),
      envSettings: binding.envSettings,
      types: binding.types,
      input: call("getEnvOptionsInputType"),
    });
    const node = JSON.parse(
      execFileSync(process.execPath, ["--expose-internals", "--no-warnings", "-e", ORACLE], {
        encoding: "utf8",
        maxBuffer: 1 << 26,
      }),
    );
    expect(JSON.parse(JSON.stringify(mine))).toEqual(node);
  });
});
