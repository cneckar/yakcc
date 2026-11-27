// SPDX-License-Identifier: Apache-2.0
// node/src's bindings shaved over V8's API (#1367): Node's own C++ (vendor/node/src, v22.23.5) as
// node.gyp and node.gypi compile it for linux-x64, each file a unit linked by its symbols, V8's
// API the boundary (raise-c's isV8Api; its leaves, raise-cpp-v8.ts), the C library musl.
import { fileURLToPath } from "node:url";
import { type ShavedUnit, isV8Api, shaveCUnit } from "../raise-c.js";
import { type ShavedFiles, shaveCFiles } from "./c-files.js";
import { shaveMusl, withMuslInit } from "./c-musl.js";

export const NODE = fileURLToPath(new URL("../../vendor/node/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./c/", import.meta.url));

/**
 * node.gyp's and node.gypi's defines and include directories (Linux, x64, the bundled deps), and
 * common.gypi's flags for C++ on Linux (no RTTI, no exceptions, no strict aliasing; its
 * -std=gnu++17 is configure.py's gnu++20 in Node 22, whose src/ needs it).
 */
export const NODE_ARGS: readonly string[] = [
  "-std=gnu++20",
  "-fno-rtti",
  "-fno-exceptions",
  "-fno-strict-aliasing",
  "-D__STDC_FORMAT_MACROS",
  "-DNODE_WANT_INTERNALS=1",
  '-DNODE_ARCH="x64"',
  '-DNODE_PLATFORM="linux"',
  "-DHAVE_OPENSSL=1",
  "-DNODE_HAVE_I18N_SUPPORT=1",
  "-DHAVE_AMARO=1",
  "-DNODE_USE_V8_PLATFORM=1",
  "-D__POSIX__",
  "-DNODE_BUNDLED_ZLIB",
  "-DHAVE_INSPECTOR=0",
  "-DOPENSSL_NO_ASM",
  "-DOPENSSL_API_COMPAT=0x10100001L",
  // simdutf's portable kernel, as Node builds it for a CPU without SIMD (the zlib tests' choice).
  "-DSIMDUTF_IMPLEMENTATION_HASWELL=0",
  "-DSIMDUTF_IMPLEMENTATION_ICELAKE=0",
  "-DSIMDUTF_IMPLEMENTATION_WESTMERE=0",
  "-DSIMDUTF_IMPLEMENTATION_FALLBACK=1",
  "-Wno-invalid-offsetof",
  ...[
    "src",
    "deps/v8/include",
    "deps/uv/include",
    "deps/icu-small/source/common",
    "deps/icu-small/source/i18n",
    "deps/openssl/config",
    "deps/openssl/config/archs/linux-x86_64/no-asm/include",
    "deps/openssl/openssl/include",
    "deps/nbytes/include",
    "deps/simdutf",
    "deps/histogram/include",
    "deps/zstd/lib",
    "deps/ncrypto",
    "deps/ada",
    "deps/zlib",
    "deps/brotli/c/include",
    "deps/llhttp/include",
    "deps/nghttp2/lib/includes",
    "deps/cares/include",
    "deps/sqlite",
    "deps/simdjson",
    "deps/uvwasi/include",
  ].map((d) => `-I${NODE}${d}`),
];

export interface ShavedBinding {
  /** The binding's own unit and node-env.cc's (Node's startup for its context). */
  readonly units: readonly ShavedUnit[];
  readonly files: ShavedFiles;
  readonly musl: ReturnType<typeof shaveMusl>;
  /** The V8 API it calls: the leaves' names. */
  readonly v8: readonly string[];
  /** C++ functions none of the files defines (libstdc++'s compiled ones). */
  readonly missing: readonly string[];
}

/**
 * A binding of node/src (`src/string_decoder.cc`) from its roots, over the files of node/src and
 * its deps that its calls reach (`others`, relative to vendor/node), and the C library.
 */
export function shaveBinding(
  file: string,
  roots: readonly string[],
  others: readonly string[],
): ShavedBinding {
  const env = shaveCUnit(
    `${FIXTURES}node-env.cc`,
    ["yk_node_environment"],
    NODE_ARGS,
    "clang++",
    "node-env.cc",
    [],
    true,
  );
  const root = shaveCUnit(`${NODE}${file}`, roots, NODE_ARGS, "clang++", file, [], true);
  const own = new Set([...env.atoms.keys(), ...root.atoms.keys()]);
  const wanted = [
    ...new Set([...env.atoms.values(), ...root.atoms.values()].flatMap((a) => a.externals)),
  ].filter((x) => !own.has(x));
  const files = shaveCFiles(
    [
      // (The binding's own file too: its functions other files call, Buffer::Length.)
      `${NODE}${file}`,
      ...others.filter((f) => f !== file).map((f) => `${NODE}${f}`),
      `${FIXTURES}libstdcxx-inst.cpp`,
      `${FIXTURES}cxx-runtime.cpp`,
    ],
    wanted,
    NODE_ARGS,
    "clang++",
    // (The statics the binding's unit and node-env.cc use that another file defines: env.cc's
    // context tag.)
    [env, root].flatMap((u) => [...u.staticRefs].filter((k) => !u.statics.has(k))),
  );
  const outside = [...new Set([...files.externals, ...wanted])].filter(
    (x) => !own.has(x) && !files.atoms.has(x),
  );
  const libc = outside.filter((x) => !x.startsWith("_Z"));
  const musl = withMuslInit(shaveMusl([...libc, "malloc", "free"]));
  return {
    units: [env, root],
    files,
    musl,
    v8: outside.filter(isV8Api),
    missing: outside.filter((x) => x.startsWith("_Z") && !isV8Api(x)),
  };
}
