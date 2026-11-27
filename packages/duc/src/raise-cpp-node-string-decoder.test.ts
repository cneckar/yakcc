// SPDX-License-Identifier: Apache-2.0
// Node's string_decoder binding (#1367), shaved from node/src's C++ rather than rewritten: its
// own src/string_decoder.cc, with the node/src it calls (StringBytes::Encode, Buffer::Data,
// SetMethod, ...) and its deps (simdutf, nbytes), over V8's API as leaves (raise-cpp-v8.ts) and
// musl. Against Node's own binding (internalBinding('string_decoder'), in a Node run with
// --expose-internals): the same constants, and for chunked input in each encoding the decoder
// takes, the same strings and the same state bytes after every decode and the flush.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type Fn, link } from "./__fixtures__/c-link.js";
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

/** The files string_decoder's calls reach (env.cc for its context tag, a static). */
const FILES = [
  "src/string_bytes.cc",
  "src/node_buffer.cc",
  "src/util.cc",
  "src/node_errors.cc",
  "src/debug_utils.cc",
  "src/env.cc",
  "src/node_realm.cc",
  "deps/simdutf/simdutf.cpp",
  "deps/nbytes/src/nbytes.cpp",
];

/** Node's own binding, the oracle: each case's results, in a Node with its internals exposed. */
const ORACLE = `
const { internalBinding } = require('internal/test/binding');
const b = internalBinding('string_decoder');
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = { consts: {}, results: [] };
for (const k of Object.keys(b)) if (typeof b[k] !== 'function') out.consts[k] = b[k];
for (const c of cases) {
  const st = Buffer.alloc(b.kSize); st[b.kEncodingField] = c.enc; const r = [];
  for (const ch of c.chunks) r.push([b.decode(st, Buffer.from(ch)), [...st]]);
  r.push([b.flush(st), [...st]]);
  out.results.push(r);
}
console.log(JSON.stringify(out));`;

describe.skipIf(!hasClang)("Node's string_decoder binding, shaved from node/src", () => {
  const shaved = shaveBinding(
    "src/string_decoder.cc",
    ["InitializeStringDecoder", "DecodeData", "FlushData"],
    FILES,
  );

  it("shaves with no refusal off Node's fatal-error path, its C library down to the leaves", () => {
    for (const u of shaved.units) expect([...u.refused]).toEqual([]);
    // (What CHECK's failure reaches, node::Assert's report and native backtrace: iostreams and
    // libstdc++'s compiled locale, not vendored; a try statement; std::shared_ptr's control
    // block. None of it runs unless a CHECK fails.)
    const fatal =
      /^_ZNK?(?:4node28NativeSymbolDebuggingContext|St7__cxx1119basic_ostringstream|St7__cxx1115basic_stringbuf|St15__uniq_ptr_implIN4node28Native|St12__shared_ptrIN2v812BackingStore|St14__shared_count|St27__uninitialized_default_n_1)/;
    expect(shaved.files.refused.filter((r) => !fatal.test(r))).toEqual([]);
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

  it("decodes as Node's own binding does, in every encoding it takes (as raised)", () => {
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
    // The context, tagged as Node's and given its Environment; the binding's initializer on it.
    const context = memory.leaves.__ykAlloc(8, 8);
    memory.leaves.__ykStore64(context, BigInt(v8.context));
    (env.yk_node_environment as Fn)(v8.isolate, context);
    const binding: Record<string, unknown> = {};
    (env.InitializeStringDecoder as Fn)(v8.local(binding), v8.local(undefined), context, 0);
    const decode = binding.decode as (s: Buffer, b: Buffer) => unknown;
    const flush = binding.flush as (s: Buffer) => unknown;

    // Chunked input in each encoding Node's string_decoder.js gives the decoder (ascii, utf8,
    // base64, utf16le, latin1, hex, base64url; not buffer, which the binding CHECKs against).
    let seed = 1367;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const samples = ["héllo wörld €", "日本語テキスト", "😀 emoji 👍🏽", "plain ascii", "\u0000ÿĀ"];
    const cases: { enc: number; chunks: number[][] }[] = [];
    for (const enc of [0, 1, 2, 3, 4, 5, 7])
      for (const s of samples)
        for (let k = 0; k < 3; k++) {
          const bytes = [
            ...Buffer.from(s, "utf8"),
            ...Array.from({ length: Math.floor(rnd() * 6) }, () => Math.floor(rnd() * 256)),
          ];
          const chunks: number[][] = [];
          for (let i = 0; i < bytes.length; ) {
            const n = 1 + Math.floor(rnd() * 4);
            chunks.push(bytes.slice(i, i + n));
            i += n;
          }
          cases.push({ enc, chunks });
        }
    const node = JSON.parse(
      execFileSync(process.execPath, ["--expose-internals", "--no-warnings", "-e", ORACLE], {
        input: JSON.stringify(cases),
        encoding: "utf8",
        maxBuffer: 1 << 28,
      }),
    ) as { consts: Record<string, unknown>; results: unknown[] };

    const consts = Object.fromEntries(
      Object.entries(binding).filter(([, v]) => typeof v !== "function"),
    );
    expect(consts).toEqual(node.consts);
    const kSize = binding.kSize as number;
    const kEncodingField = binding.kEncodingField as number;
    const results = cases.map((c) => {
      const st = Buffer.alloc(kSize);
      st[kEncodingField] = c.enc;
      const r: unknown[] = [];
      for (const ch of c.chunks) r.push([decode(st, Buffer.from(ch)), [...st]]);
      r.push([flush(st), [...st]]);
      return r;
    });
    expect(results).toEqual(node.results);
  });
});
