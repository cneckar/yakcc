// SPDX-License-Identifier: Apache-2.0
// Node's brotli (vendor/node/deps/brotli, behind zlib.brotliCompress and brotliDecompress) as C
// functions for the C front end's test (#1367).
#include <brotli/decode.h>
#include <brotli/encode.h>

/* Compress at a quality (0..11), window (10..24) and mode (0 generic, 1 text, 2 font): the size,
   or -1. */
long yk_brotli_compress(const unsigned char *in, long n, unsigned char *out, long cap, int quality,
                        int lgwin, int mode) {
  size_t size = (size_t)cap;
  if (!BrotliEncoderCompress(quality, lgwin, (BrotliEncoderMode)mode, (size_t)n, in, &size, out))
    return -1;
  return (long)size;
}

/* Decompress, fed `step` bytes at a time into an output of `step` bytes at a time (0: all at once):
   the size, or minus the decoder's error code minus 1000. */
long yk_brotli_decompress(const unsigned char *in, long n, unsigned char *out, long cap, int step) {
  BrotliDecoderState *s = BrotliDecoderCreateInstance(0, 0, 0);
  if (s == 0) return -1;
  size_t avail_in = 0, avail_out = 0, total = 0;
  const unsigned char *next_in = in;
  unsigned char *next_out = out;
  long fed = 0;
  BrotliDecoderResult r = BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT;
  for (;;) {
    if (r == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT) {
      if (fed >= n) break;
      long k = step <= 0 || n - fed < step ? n - fed : step;
      avail_in += (size_t)k;
      fed += k;
    }
    if (r == BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT || avail_out == 0) {
      long used = (long)(next_out - out);
      long k = step <= 0 || cap - used < step ? cap - used : step;
      if (k <= 0) break;
      avail_out += (size_t)k;
    }
    r = BrotliDecoderDecompressStream(s, &avail_in, &next_in, &avail_out, &next_out, &total);
    if (r == BROTLI_DECODER_RESULT_SUCCESS || r == BROTLI_DECODER_RESULT_ERROR) break;
  }
  long result = r == BROTLI_DECODER_RESULT_SUCCESS ? (long)total
                : r == BROTLI_DECODER_RESULT_ERROR  ? -1000 + (long)BrotliDecoderGetErrorCode(s)
                                                     : -2;
  BrotliDecoderDestroyInstance(s);
  return result;
}
