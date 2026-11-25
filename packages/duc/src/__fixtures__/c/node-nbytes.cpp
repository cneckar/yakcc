// SPDX-License-Identifier: Apache-2.0
// Node's nbytes (vendor/node/deps/nbytes, the byte logic of the buffer and string_decoder
// bindings) as C functions for the C++ front end's test (#1367).
#include <cstdlib>
// Node's CHECK (src/util.h): abort when false.
#define CHECK(expr) \
  do {                \
    if (!(expr)) abort(); \
  } while (0)
#include "nbytes.cpp"

extern "C" {

// base64 (or base64url: the decoder takes both) and hex decoding: the bytes written.
long yk_base64_decode(const char *src, long n, char *dst, long cap) {
  return (long)nbytes::Base64Decode(dst, (size_t)cap, src, (size_t)n);
}
long yk_base64_decoded_size(const char *src, long n) {
  return (long)nbytes::Base64DecodedSize(src, (size_t)n);
}
long yk_hex_decode(const char *src, long n, char *dst, long cap) {
  return (long)nbytes::HexDecode(dst, (size_t)cap, src, (size_t)n);
}
long yk_hex_encode(const char *src, long n, char *dst, long cap) {
  return (long)nbytes::HexEncode(src, (size_t)n, dst, (size_t)cap);
}

// Buffer#swap16/32/64 in place: whether the length allowed it.
long yk_swap(char *data, long n, int width) {
  return width == 16 ? nbytes::SwapBytes16(data, (size_t)n)
         : width == 32 ? nbytes::SwapBytes32(data, (size_t)n)
                       : nbytes::SwapBytes64(data, (size_t)n);
}

// ASCII with the high bit cleared (latin1 to ascii).
void yk_force_ascii(const char *src, char *dst, long n) { nbytes::ForceAscii(src, dst, (size_t)n); }

// Buffer#indexOf/lastIndexOf: the position, or -1. `wide` searches UTF-16 code units.
long yk_search(const void *hay, long hn, const void *needle, long nn, long start, int forward,
               int wide) {
  size_t r, len;
  if (wide) {
    len = (size_t)hn;
    r = nbytes::SearchString((const uint16_t *)hay, len, (const uint16_t *)needle, (size_t)nn,
                             (size_t)start, forward != 0);
  } else {
    len = (size_t)hn;
    r = nbytes::SearchString((const uint8_t *)hay, len, (const uint8_t *)needle, (size_t)nn,
                             (size_t)start, forward != 0);
  }
  return r == len ? -1 : (long)r;
}
}
