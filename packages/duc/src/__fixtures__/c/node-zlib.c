// SPDX-License-Identifier: Apache-2.0
// Node's zlib (vendor/node/deps/zlib, Chromium's) as Node's zlib binding runs it for deflateSync,
// deflateRawSync, gzipSync and their inverses (#1367): the whole input, Z_FINISH, the output in
// chunks of Node's chunk size.
#include <string.h>
#include <zlib.h>

/* Compress: the size, or a negative code (-100 + init's error, -200 out of room, -300 + deflate's
   error). */
long yk_node_deflate(const unsigned char *in, long n, unsigned char *out, long cap, int level,
                     int wbits, int memlevel, int strategy, int chunk) {
  z_stream s;
  memset(&s, 0, sizeof s);
  int r = deflateInit2(&s, level, Z_DEFLATED, wbits, memlevel, strategy);
  if (r != Z_OK) return -100 + r;
  s.next_in = (unsigned char *)in;
  s.avail_in = (unsigned)n;
  long total = 0;
  do {
    if (total + chunk > cap) {
      deflateEnd(&s);
      return -200;
    }
    s.next_out = out + total;
    s.avail_out = (unsigned)chunk;
    r = deflate(&s, Z_FINISH);
    total += chunk - (long)s.avail_out;
  } while (s.avail_out == 0 && r != Z_STREAM_END);
  deflateEnd(&s);
  return r == Z_STREAM_END ? total : -300 + r;
}

/* Decompress (wbits as inflateInit2 takes it): the size, or a negative code as above. */
long yk_node_inflate(const unsigned char *in, long n, unsigned char *out, long cap, int wbits,
                     int chunk) {
  z_stream s;
  memset(&s, 0, sizeof s);
  int r = inflateInit2(&s, wbits);
  if (r != Z_OK) return -100 + r;
  s.next_in = (unsigned char *)in;
  s.avail_in = (unsigned)n;
  long total = 0;
  do {
    if (total + chunk > cap) {
      inflateEnd(&s);
      return -200;
    }
    s.next_out = out + total;
    s.avail_out = (unsigned)chunk;
    r = inflate(&s, Z_FINISH);
    total += chunk - (long)s.avail_out;
  } while (r == Z_BUF_ERROR ? s.avail_out == 0 : r == Z_OK);
  inflateEnd(&s);
  return r == Z_STREAM_END ? total : -300 + r;
}

/* adler32 and crc32 (zlib.crc32 in Node 22). */
unsigned long yk_node_adler32(const unsigned char *in, long n) { return adler32(1, in, (unsigned)n); }
unsigned long yk_node_crc32(const unsigned char *in, long n, unsigned long init) {
  return crc32(init, in, (unsigned)n);
}
