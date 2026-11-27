# Node v22.23.5 sources (vendored, in part)

Files of Node v22.23.5 (the Node yakcc runs on, and whose library `@yakcc/node-platform` vendors),
from https://github.com/nodejs/node at tag `v22.23.5`, unmodified, under their own licenses, for
the C/C++ front end to shave (#1367):

- `deps/nbytes/` (nbytes 0.1.3, MIT, `deps/nbytes/LICENSE`): the byte logic of the `buffer` and
  `string_decoder` bindings: base64 and hex decoding, byte swaps, `ForceAscii`, and the
  Boyer-Moore(-Horspool) `SearchString` behind `Buffer#indexOf`/`lastIndexOf`. The fixture
  `src/__fixtures__/c/node-nbytes.cpp` names each operation as a C function (and defines Node's
  `CHECK`, from `src/util.h`, as an abort).
- `deps/llhttp/` (llhttp 9.4.4, MIT, `deps/llhttp/LICENSE` and `LICENSE-MIT`): Node's HTTP/1
  parser, the generated state machine (`src/llhttp.c`) and its API (`src/api.c`, `src/http.c`).
  The fixture `src/__fixtures__/c/node-llhttp.c` runs it with every callback logged.
- `deps/brotli/` (brotli 1.1.0 with Node's decoder patch to `c/dec/decode.c` and
  `c/include/brotli/decode.h`, MIT, `deps/brotli/LICENSE`): the `c/` tree behind
  `zlib.brotliCompress` and `brotliDecompress`. The fixture `src/__fixtures__/c/node-brotli.c`
  compresses in one call and decompresses as a stream.
- `deps/zlib/` (Chromium's zlib, `1.3.1-e00f703`, zlib's license, `deps/zlib/LICENSE`): the
  library behind `node:zlib`, which gives different deflate bytes from zlib 1.3.1's own. The core
  files, `contrib/optimizations/` and the x86 SIMD files. The test shaves both the portable
  configuration (`CPU_NO_SIMD`, as Node builds it for a CPU without SIMD) and Node's own x64 one
  (`zlib.gyp`'s defines: SSSE3 adler32, SSE2 slide hash and chunked inflate, chosen by `cpuid` as it
  runs); the streams of each equal Node's. The fixture `src/__fixtures__/c/node-zlib.c` runs it as
  Node's binding does.
- `deps/simdutf/` (simdutf 6.4.2, MIT, `deps/simdutf/LICENSE-MIT`; it replaces the 7.3.0 release
  `vendor/simdutf` held, which is not Node's): Node's UTF-8/UTF-16/Latin-1 transcoding. Node
  compiles every kernel and picks one by the CPU; the test shaves the portable one (fallback),
  through `src/__fixtures__/c/simdutf-scalar.cpp`.
- `deps/sqlite/` (SQLite 3.54.1, public domain): the amalgamation behind `node:sqlite`. The test
  shaves it with `sqlite.gyp`'s defines (FTS3/4/5, R*Tree, Geopoly, sessions, RBU, math functions,
  dbstat, column metadata, the preupdate hook; threadsafe; the unix VFS), and the fixture
  `src/__fixtures__/c/node-sqlite.c` opens a database as `DatabaseSync` does.
- `deps/nghttp2/` (nghttp2 1.69.0, MIT, `deps/nghttp2/COPYING`): Node's HTTP/2 library, `lib/`
  (its sources and headers). The fixture `src/__fixtures__/c/node-nghttp2.c` runs HPACK and a
  client and a server session in memory, every frame and callback logged.
- `deps/cares/` (c-ares 1.34.9, MIT, `deps/cares/LICENSE.md`): Node's DNS library, `include/`,
  `src/lib/` and `config/linux/`. The fixture `src/__fixtures__/c/node-cares.c` runs a DNS response
  through each reply parser Node's `dns.resolve*` uses and through the record layer.
- `deps/histogram/` (HdrHistogram_c, public domain/BSD-2, `deps/histogram/LICENSE.txt`):
  `perf_hooks.createHistogram`'s histogram. The fixture `src/__fixtures__/c/node-histogram.c` runs it
  as Node's `src/histogram-inl.h` does.
- `deps/openssl/` (OpenSSL 3.5.9, Apache-2.0, `deps/openssl/openssl/LICENSE.txt`), in Node's
  layout: of `openssl/`, the files (sources, headers and `.inc` fragments) that Node's
  linux-x86_64 `no-asm` build compiles, by the arch's `openssl.gypi` and clang's dependencies;
  Node's stub headers and `config/` wrappers; and that arch's generated files
  (`config/archs/linux-x86_64/no-asm/`), here regenerated from the 3.5.9 release with Node's
  `Configure` options and equal to Node's. The fixture `src/__fixtures__/c/node-openssl.c` calls
  the EVP functions behind Node's `crypto` module.
- `deps/uv/` (libuv 1.51.0, MIT, `deps/uv/LICENSE` and `LICENSE-extra`): Node's event loop library,
  `include/` and `src/`. The fixture `src/__fixtures__/c/node-uv.c` runs its computing parts: the
  error names and messages, IDNA, and address text.
- `deps/icu-small/` (ICU 78.3, Unicode-3.0, `deps/icu-small/LICENSE`): Node's `full-icu` subset of
  ICU4C, as Node ships it (`common/`, `i18n/`, `stubdata/`, `tools/`, and the data,
  `source/data/in/icudt78l.dat.bz2`); `tools/icu/` holds Node's `icu-generic.gyp` (its defines and
  sources), `icu_small.json` and the version file. Node compiles the data into the program as the
  symbol `icudt78_dat` (genccode); the fixture gives ICU the same bytes, by `udata_setCommonData`.
- `deps/simdjson/` (simdjson 4.5.0, Apache-2.0, `deps/simdjson/LICENSE`): the parser Node's module
  loader reads `package.json` with. The fixture `src/__fixtures__/c/node-simdjson.cpp` reads a
  document as `src/node_modules.cc` does, through the on-demand API; the test builds its portable
  kernel.
- `deps/uvwasi/` (uvwasi 0.0.23, MIT, `deps/uvwasi/LICENSE`): Node's WASI implementation, over
  libuv. The fixture `src/__fixtures__/c/node-uvwasi.c` runs its computing parts: path
  normalization, error names and mapping, and its structures as a guest reads them.
- `src/` (Node's own C++, MIT, `LICENSE`), `node.gyp`, `node.gypi`, `common.gypi`: the bindings
  below Node's JavaScript (`internalBinding`), to shave as atoms over V8's API (#1367), in place of
  the hand-written stand-ins (`src/__fixtures__/node/bindings.js`, the native runtime's
  `internalBinding` layer; `docs/duc/runtime-inventory-1516.md`).
- `deps/v8/include/` (V8 12.4.254, BSD-3, `deps/v8/LICENSE`): V8's
  public API, the boundary `src/` is written against.
- `deps/zstd/` (zstd 1.5.7, BSD/GPLv2 dual, `deps/zstd/LICENSE`), `deps/ncrypto/` (Node's OpenSSL
  wrapper, MIT, as Node's), `deps/ada/` (ada 2.9.2, MIT/Apache-2.0, `deps/ada/LICENSE-MIT`): the
  dependencies `src/` includes that were not here (`node_zlib.cc`'s zstd, `src/crypto/`'s ncrypto,
  `node_url.cc`'s ada).
