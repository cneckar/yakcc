// SPDX-License-Identifier: Apache-2.0
// zlib (vendor/zlib) for the C front end's test (#1367): deflate at a level and strategy, and
// inflate, through zlib's streaming interface. (zlib's files are units of their own.)
#include <zlib.h>

// `in` deflated at `level` with `strategy` and window bits `bits` (15 zlib, -15 raw, 31 gzip)
// into `out`: its length, or a negative zlib error.
int yk_deflate(const unsigned char *in, int n, unsigned char *out, int cap, int level, int strategy, int bits) {
  z_stream s = {0};
  int r = deflateInit2(&s, level, Z_DEFLATED, bits, 8, strategy);
  if (r != Z_OK) return r;
  s.next_in = (Bytef *)in;
  s.avail_in = (uInt)n;
  s.next_out = out;
  s.avail_out = (uInt)cap;
  r = deflate(&s, Z_FINISH);
  int len = (int)s.total_out;
  deflateEnd(&s);
  return r == Z_STREAM_END ? len : (r < 0 ? r : -100);
}

// `in` inflated with window bits `bits` into `out`: its length, or a negative zlib error.
int yk_inflate(const unsigned char *in, int n, unsigned char *out, int cap, int bits) {
  z_stream s = {0};
  int r = inflateInit2(&s, bits);
  if (r != Z_OK) return r;
  s.next_in = (Bytef *)in;
  s.avail_in = (uInt)n;
  s.next_out = out;
  s.avail_out = (uInt)cap;
  r = inflate(&s, Z_FINISH);
  int len = (int)s.total_out;
  inflateEnd(&s);
  return r == Z_STREAM_END ? len : (r < 0 ? r : -100);
}

// The checksums: adler32 and crc32 of `in`.
unsigned long yk_adler32(const unsigned char *in, int n) { return adler32(1, in, (uInt)n); }
unsigned long yk_crc32(const unsigned char *in, int n) { return crc32(0, in, (uInt)n); }
