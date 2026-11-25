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
  files, `contrib/optimizations/` and the x86 SIMD files (Node's x64 build); the test shaves the
  portable configuration (`CPU_NO_SIMD`, as Node builds it for a CPU without SIMD), whose streams
  equal Node's. The fixture `src/__fixtures__/c/node-zlib.c` runs it as Node's binding does.
