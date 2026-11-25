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
