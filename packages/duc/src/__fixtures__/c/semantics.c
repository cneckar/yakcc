/* C semantics the raiser must keep (#1329): each function is compiled natively (with -fwrapv: signed
   overflow wraps, the meaning the raiser gives it) and shaved, and the two must agree on every
   input. Only defined behaviour is compared: no division of the least value by -1. */
#include <stdint.h>

static const double SCALE[3] = {0.5, 2.0, -4.0};
static const int32_t BIAS = 0x7FFFFFF0;

int wrap_add(int a, int b) { return a + b; }
int wrap_mul(int a, int b) { return a * b; }
unsigned u_sub_shift(unsigned a, unsigned b) { return (a - b) >> (b & 31u); }
int s_shift(int a, int b) { return a >> (b & 31); }
int trunc_div(int a, int b) { return (b == 0 || (a == INT32_MIN && b == -1)) ? 0 : a / b; }
int trunc_rem(int a, int b) { return (b == 0 || (a == INT32_MIN && b == -1)) ? 0 : a % b; }
int truth(int a, int b) { return (a < b) + (a == b) * 2 + (!a) * 4 + ((a && b) << 3) + ((a || b) << 4); }
int mixed(int a, unsigned b) { return a < b; } /* a converts to unsigned */
double to_double(int a, unsigned b) { return (double)a / 3.0 + (double)b; }
int from_double(double x) { return (x > -2e9 && x < 2e9) ? (int)x : 0; }
uint64_t wide(uint64_t a, int s) { return (a << (s & 63)) ^ (a >> 3) ^ (a * 0x9E3779B97F4A7C15ull); }
int64_t wide_signed(int64_t a, int64_t b) { return (b == 0 || (a == INT64_MIN && b == -1)) ? a : a / b + a % b - (a >> 2); }
uint32_t words(double x) {
  union { double f; uint64_t i; } u;
  u.f = x;
  return (uint32_t)(u.i >> 32) ^ (uint32_t)u.i;
}
double from_words(uint32_t hi, uint32_t lo) {
  union { double f; uint64_t i; } u;
  u.i = ((uint64_t)hi << 32) | lo;
  return u.f;
}
int compound(int a, int b) {
  int x = a;
  x += b; x *= 3; x -= a; x <<= (b & 7); x >>= 1; x ^= 0x5555; x |= 1; x &= ~2;
  unsigned u = (unsigned)a;
  u += 0xFFFFFFFFu; u >>= 4;
  return x + (int)u;
}
int incdec(int a) {
  int b = a++;
  int c = ++a;
  int d = a--;
  return b * 7 + c * 5 + d * 3 + --a;
}
int fallthrough(int a) {
  int r = 0;
  switch (a & 7) {
    case 0: r += 1;
    case 1: r += 2; break;
    case 2:
    case 3: r += 4;
    default: r += 8;
  }
  return r;
}
int collatz(int n) {
  int steps = 0;
  unsigned x = (unsigned)n | 1u;
again:
  if (x == 1u) return steps;
  x = (x & 1u) ? 3u * x + 1u : x >> 1;
  steps++;
  if (steps < 200) goto again;
  return -steps;
}
double table(int i, double x) { return SCALE[(i & 0x7FFFFFFF) % 3] * x + (double)(BIAS >> 4); }
int loops(int n) {
  int s = 0;
  for (int i = 0; i < (n & 63); i++) {
    if (i % 3 == 0) continue;
    s += i;
    if (s > 500) break;
  }
  int j = 0;
  while (j < 10) j += 3;
  do { s -= 1; } while (s > 1000);
  return s + j;
}
