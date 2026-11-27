/* SPDX-License-Identifier: Apache-2.0
 *
 * The C library the runtime uses, on Linux's system calls alone (#1361 P1, #1370): no libc is
 * linked. yk.c includes this instead of the system's headers when built with -DYK_NOLIBC, with
 * -ffreestanding -fno-builtin -fno-math-errno, and the program links with -nostdlib -static.
 *
 * What it gives: the system calls (write, read, mmap, munmap, clock_gettime, getpid, getppid, exit_group);
 * an allocator on mmap; the string and memory functions; buffered stdio on file descriptors;
 * snprintf and strtod, both exact (a double's decimal digits from its integer value, a decimal's
 * double by rounding its exact value, half to even, with big integers); the math functions the
 * runtime and the lowered code call, on the bits of the doubles; setjmp and longjmp; the context
 * switch a coroutine runs on; and the process's start (yk_nolibc_start, which _start calls). The
 * system call itself and _start are the system module's, in LLVM (native-system.ts).
 *
 * For x86_64, AArch64, ARMv7 (EABI, hard float) and RISC-V 64 Linux: each its system calls' numbers
 * and calling convention, the registers a switch saves, and its _start.
 */
#ifndef YK_NOLIBC_H
#define YK_NOLIBC_H

#if !defined(__x86_64__) && !defined(__aarch64__) && !defined(__arm__) && \
    !(defined(__riscv) && __riscv_xlen == 64)
#error "nolibc.h: x86_64, aarch64, arm and riscv64 Linux only"
#endif

#include <float.h>
#include <limits.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>

#define YK_NOLIBC_API __attribute__((used))

/* ---------------------------------------------------------------- system calls */

/* The system call: the system module's (native-system.ts, in LLVM), per architecture. */
long yk_sys(long n, long a, long b, long c, long d, long e, long f);
/* Each architecture's numbers: x86_64's; the generic table's (AArch64, RISC-V); ARM EABI's. */
#if defined(__x86_64__)
enum { SYS_read = 0, SYS_write = 1, SYS_mmap = 9, SYS_munmap = 11, SYS_getpid = 39,
       SYS_getppid = 110, SYS_clock_gettime = 228, SYS_exit_group = 231 };
#elif defined(__arm__)
enum { SYS_read = 3, SYS_write = 4, SYS_mmap = 192 /* mmap2 */, SYS_munmap = 91, SYS_getpid = 20,
       SYS_getppid = 64, SYS_clock_gettime = 403 /* clock_gettime64 */, SYS_exit_group = 248 };
#else
enum { SYS_read = 63, SYS_write = 64, SYS_mmap = 222, SYS_munmap = 215, SYS_getpid = 172,
       SYS_getppid = 173, SYS_clock_gettime = 113, SYS_exit_group = 94 };
#endif

typedef long ssize_t;
typedef long off_t;
typedef int clockid_t;
typedef long time_t;
struct timespec {
  time_t tv_sec;
  long tv_nsec;
};
#define CLOCK_REALTIME 0
#define PROT_READ 1
#define PROT_WRITE 2
#define MAP_PRIVATE 2
#define MAP_ANONYMOUS 0x20
#define MAP_NORESERVE 0x4000
#define MAP_FAILED ((void *)-1)

YK_NOLIBC_API ssize_t write(int fd, const void *buf, size_t n) {
  return yk_sys(SYS_write, fd, (long)buf, (long)n, 0, 0, 0);
}
YK_NOLIBC_API ssize_t read(int fd, void *buf, size_t n) {
  return yk_sys(SYS_read, fd, (long)buf, (long)n, 0, 0, 0);
}
YK_NOLIBC_API void *mmap(void *addr, size_t len, int prot, int flags, int fd, off_t off) {
#if defined(__arm__)
  off /= 4096; /* mmap2: the offset in pages */
#endif
  long r = yk_sys(SYS_mmap, (long)addr, (long)len, prot, flags, fd, off);
  return (unsigned long)r > -4096UL ? MAP_FAILED : (void *)r;
}
YK_NOLIBC_API int munmap(void *addr, size_t len) {
  return (int)yk_sys(SYS_munmap, (long)addr, (long)len, 0, 0, 0, 0);
}
YK_NOLIBC_API int clock_gettime(clockid_t clock, struct timespec *ts) {
#if defined(__arm__)
  /* clock_gettime64: 64-bit seconds and nanoseconds. */
  int64_t t[2];
  int r = (int)yk_sys(SYS_clock_gettime, clock, (long)t, 0, 0, 0, 0);
  ts->tv_sec = (time_t)t[0];
  ts->tv_nsec = (long)t[1];
  return r;
#else
  return (int)yk_sys(SYS_clock_gettime, clock, (long)ts, 0, 0, 0, 0);
#endif
}
YK_NOLIBC_API int getpid(void) { return (int)yk_sys(SYS_getpid, 0, 0, 0, 0, 0, 0); }
YK_NOLIBC_API int getppid(void) { return (int)yk_sys(SYS_getppid, 0, 0, 0, 0, 0, 0); }
static _Noreturn void yk_exit_group(int code) {
  for (;;) yk_sys(SYS_exit_group, code, 0, 0, 0, 0, 0);
}

/* ---------------------------------------------------------------- memory and strings */

YK_NOLIBC_API void *memcpy(void *restrict d, const void *restrict s, size_t n) {
  unsigned char *p = d;
  const unsigned char *q = s;
  for (; n >= 8; n -= 8, p += 8, q += 8) {
    uint64_t w;
    __builtin_memcpy(&w, q, 8);
    __builtin_memcpy(p, &w, 8);
  }
  while (n--) *p++ = *q++;
  return d;
}
YK_NOLIBC_API void *memmove(void *d, const void *s, size_t n) {
  unsigned char *p = d;
  const unsigned char *q = s;
  if (p == q || n == 0) return d;
  if (p < q || p >= q + n) {
    while (n--) *p++ = *q++;
  } else {
    while (n--) p[n] = q[n];
  }
  return d;
}
YK_NOLIBC_API void *memset(void *d, int c, size_t n) {
  unsigned char *p = d;
  uint64_t w = 0x0101010101010101ull * (unsigned char)c;
  for (; n >= 8; n -= 8, p += 8) __builtin_memcpy(p, &w, 8);
  while (n--) *p++ = (unsigned char)c;
  return d;
}
YK_NOLIBC_API int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *p = a, *q = b;
  for (size_t i = 0; i < n; i++)
    if (p[i] != q[i]) return p[i] - q[i];
  return 0;
}
YK_NOLIBC_API int bcmp(const void *a, const void *b, size_t n) { return memcmp(a, b, n); }
YK_NOLIBC_API void *memchr(const void *s, int c, size_t n) {
  const unsigned char *p = s;
  for (size_t i = 0; i < n; i++)
    if (p[i] == (unsigned char)c) return (void *)(p + i);
  return NULL;
}
YK_NOLIBC_API size_t strlen(const char *s) {
  size_t n = 0;
  while (s[n]) n++;
  return n;
}
YK_NOLIBC_API int strcmp(const char *a, const char *b) {
  while (*a && *a == *b) a++, b++;
  return (unsigned char)*a - (unsigned char)*b;
}
YK_NOLIBC_API int strncmp(const char *a, const char *b, size_t n) {
  for (; n > 0; n--, a++, b++) {
    if (*a != *b) return (unsigned char)*a - (unsigned char)*b;
    if (*a == 0) return 0;
  }
  return 0;
}
YK_NOLIBC_API char *strchr(const char *s, int c) {
  for (;; s++) {
    if (*s == (char)c) return (char *)s;
    if (*s == 0) return NULL;
  }
}
static int abs(int x) { return x < 0 ? -x : x; }
static int atoi(const char *s) {
  int neg = 0, r = 0;
  while (*s == ' ' || (*s >= '\t' && *s <= '\r')) s++;
  if (*s == '+' || *s == '-') neg = *s++ == '-';
  while (*s >= '0' && *s <= '9') r = r * 10 + (*s++ - '0');
  return neg ? -r : r;
}

/* ---------------------------------------------------------------- process */

char **environ;
static uintptr_t yk_nolibc_stack_top;
static void (*yk_atexit_fns[32])(void);
static int yk_atexit_n;
YK_NOLIBC_API int atexit(void (*f)(void)) {
  if (yk_atexit_n == 32) return -1;
  yk_atexit_fns[yk_atexit_n++] = f;
  return 0;
}
YK_NOLIBC_API char *getenv(const char *name) {
  size_t n = strlen(name);
  for (char **e = environ; e != NULL && *e != NULL; e++)
    if (strncmp(*e, name, n) == 0 && (*e)[n] == '=') return *e + n + 1;
  return NULL;
}
static void yk_stdio_flush_all(void);
YK_NOLIBC_API _Noreturn void exit(int code) {
  while (yk_atexit_n > 0) yk_atexit_fns[--yk_atexit_n]();
  yk_stdio_flush_all();
  yk_exit_group(code);
}
/* A signal raised (ARM's libgcc, for a division by zero): the process ends as the signal's. */
YK_NOLIBC_API int raise(int sig) {
  yk_stdio_flush_all();
  yk_exit_group(128 + sig);
}
YK_NOLIBC_API _Noreturn void abort(void) {
  yk_stdio_flush_all();
  yk_exit_group(134);
}

/* ---------------------------------------------------------------- the allocator
 * Blocks of up to 4096 bytes come from 1 MiB arenas, by class (16-byte steps), and go back on their
 * class's free list; larger ones are their own mapping. Each has a 16-byte header: its class's size,
 * or its mapping's length with the low bit set. */

static unsigned char *yk_arena, *yk_arena_end;
static void *yk_free_lists[257];
static void *yk_map(size_t n) {
  void *p = mmap(NULL, n, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  return p == MAP_FAILED ? NULL : p;
}
YK_NOLIBC_API void *malloc(size_t n) {
  if (n <= 4096) {
    size_t sz = n <= 16 ? 16 : (n + 15) & ~(size_t)15;
    void **list = &yk_free_lists[sz / 16];
    if (*list != NULL) {
      void *p = *list;
      *list = *(void **)p;
      return p;
    }
    if (yk_arena == NULL || (size_t)(yk_arena_end - yk_arena) < sz + 16) {
      yk_arena = yk_map((size_t)1 << 20);
      if (yk_arena == NULL) return NULL;
      yk_arena_end = yk_arena + ((size_t)1 << 20);
    }
    unsigned char *b = yk_arena;
    yk_arena += sz + 16;
    *(size_t *)b = sz;
    return b + 16;
  }
  size_t len = (n + 16 + 4095) & ~(size_t)4095;
  if (len < n) return NULL;
  unsigned char *b = yk_map(len);
  if (b == NULL) return NULL;
  *(size_t *)b = len | 1;
  return b + 16;
}
YK_NOLIBC_API void free(void *p) {
  if (p == NULL) return;
  unsigned char *b = (unsigned char *)p - 16;
  size_t h = *(size_t *)b;
  if (h & 1) {
    munmap(b, h & ~(size_t)1);
    return;
  }
  *(void **)p = yk_free_lists[h / 16];
  yk_free_lists[h / 16] = p;
}
static size_t yk_usable(void *p) {
  size_t h = *(size_t *)((unsigned char *)p - 16);
  return h & 1 ? (h & ~(size_t)1) - 16 : h;
}
YK_NOLIBC_API void *calloc(size_t n, size_t m) {
  if (m != 0 && n > (size_t)-1 / m) return NULL;
  void *p = malloc(n * m);
  if (p != NULL) memset(p, 0, n * m);
  return p;
}
YK_NOLIBC_API void *realloc(void *p, size_t n) {
  if (p == NULL) return malloc(n);
  size_t have = yk_usable(p);
  if (n <= have) return p;
  void *q = malloc(n);
  if (q == NULL) return NULL;
  memcpy(q, p, have);
  free(p);
  return q;
}

/* ---------------------------------------------------------------- big integers, for exact conversions
 * Little-endian 32-bit limbs; enough for a double's integer value times a power of 5 or 10 (a
 * double's exact decimal value has at most 767 significant digits), and for strtod's 800 digits
 * times its scale. */

#define YK_BN_LIMBS 400
typedef struct {
  int n;
  uint32_t d[YK_BN_LIMBS];
} yk_bn;
static void bn_set(yk_bn *a, uint64_t v) {
  a->n = 0;
  while (v != 0) {
    a->d[a->n++] = (uint32_t)v;
    v >>= 32;
  }
}
static void bn_mul_small(yk_bn *a, uint32_t m) {
  uint64_t carry = 0;
  for (int i = 0; i < a->n; i++) {
    uint64_t t = (uint64_t)a->d[i] * m + carry;
    a->d[i] = (uint32_t)t;
    carry = t >> 32;
  }
  if (carry != 0 && a->n < YK_BN_LIMBS) a->d[a->n++] = (uint32_t)carry;
}
static void bn_add_small(yk_bn *a, uint32_t v) {
  uint64_t carry = v;
  for (int i = 0; i < a->n && carry != 0; i++) {
    uint64_t t = (uint64_t)a->d[i] + carry;
    a->d[i] = (uint32_t)t;
    carry = t >> 32;
  }
  if (carry != 0 && a->n < YK_BN_LIMBS) a->d[a->n++] = (uint32_t)carry;
}
static void bn_shl(yk_bn *a, int k) {
  if (a->n == 0 || k == 0) return;
  int w = k / 32, b = k % 32;
  int n = a->n + w + 1;
  if (n > YK_BN_LIMBS) n = YK_BN_LIMBS;
  for (int i = n - 1; i >= 0; i--) {
    int s = i - w;
    uint64_t hi = s >= 0 && s < a->n ? a->d[s] : 0;
    uint64_t lo = s - 1 >= 0 && s - 1 < a->n ? a->d[s - 1] : 0;
    a->d[i] = b == 0 ? (uint32_t)hi : (uint32_t)((hi << b) | (lo >> (32 - b)));
  }
  a->n = n;
  while (a->n > 0 && a->d[a->n - 1] == 0) a->n--;
}
static void bn_mul_pow(yk_bn *a, uint32_t base, int k) {
  /* base^k in steps that fit a limb: 5^13 and 10^9. */
  uint32_t step = base == 5 ? 1220703125u : 1000000000u;
  int per = base == 5 ? 13 : 9;
  for (; k >= per; k -= per) bn_mul_small(a, step);
  uint32_t r = 1;
  while (k-- > 0) r *= base;
  if (r != 1) bn_mul_small(a, r);
}
static int bn_cmp(const yk_bn *a, const yk_bn *b) {
  if (a->n != b->n) return a->n < b->n ? -1 : 1;
  for (int i = a->n - 1; i >= 0; i--)
    if (a->d[i] != b->d[i]) return a->d[i] < b->d[i] ? -1 : 1;
  return 0;
}
static void bn_sub(yk_bn *a, const yk_bn *b) { /* a -= b, a >= b */
  int64_t borrow = 0;
  for (int i = 0; i < a->n; i++) {
    int64_t t = (int64_t)a->d[i] - (i < b->n ? b->d[i] : 0) - borrow;
    borrow = t < 0;
    a->d[i] = (uint32_t)(t + (borrow ? ((int64_t)1 << 32) : 0));
  }
  while (a->n > 0 && a->d[a->n - 1] == 0) a->n--;
}
static int bn_bits(const yk_bn *a) {
  if (a->n == 0) return 0;
  return 32 * (a->n - 1) + (32 - __builtin_clz(a->d[a->n - 1]));
}
static int bn_bit(const yk_bn *a, int i) {
  return i / 32 < a->n ? (int)((a->d[i / 32] >> (i % 32)) & 1) : 0;
}
/* The decimal digits of a (most significant first), into out; their count. */
static int bn_decimal(const yk_bn *a0, char *out, int cap) {
  static yk_bn a;
  a = *a0;
  char rev[YK_BN_LIMBS * 10];
  int k = 0;
  while (a.n > 0) {
    uint64_t rem = 0;
    for (int i = a.n - 1; i >= 0; i--) {
      uint64_t cur = (rem << 32) | a.d[i];
      a.d[i] = (uint32_t)(cur / 1000000000u);
      rem = cur % 1000000000u;
    }
    while (a.n > 0 && a.d[a.n - 1] == 0) a.n--;
    for (int j = 0; j < 9; j++) {
      rev[k++] = (char)('0' + rem % 10);
      rem /= 10;
    }
  }
  while (k > 0 && rev[k - 1] == '0') k--;
  int n = k < cap ? k : cap;
  for (int i = 0; i < n; i++) out[i] = rev[k - 1 - i];
  return n;
}

/* ---------------------------------------------------------------- doubles' bits */

static inline uint64_t yk_bits(double d) {
  uint64_t b;
  __builtin_memcpy(&b, &d, 8);
  return b;
}
static inline double yk_double(uint64_t b) {
  double d;
  __builtin_memcpy(&d, &b, 8);
  return d;
}
#define INFINITY (__builtin_inf())
#define NAN (__builtin_nan(""))
#define HUGE_VAL (__builtin_huge_val())
#define isnan(x) __builtin_isnan(x)
#define isinf(x) __builtin_isinf(x)
#define isfinite(x) __builtin_isfinite(x)
#define signbit(x) __builtin_signbit(x)
#define fabs(x) __builtin_fabs(x)
#define copysign(x, y) __builtin_copysign(x, y)

YK_NOLIBC_API double sqrt(double x) { return __builtin_sqrt(x); /* the instruction (no errno) */ }
YK_NOLIBC_API double trunc(double x) {
  uint64_t b = yk_bits(x);
  int e = (int)((b >> 52) & 0x7ff) - 1023;
  if (e >= 52) return x; /* integral, infinite or NaN */
  if (e < 0) return yk_double(b & 0x8000000000000000ull);
  return yk_double(b & ~((1ull << (52 - e)) - 1));
}
YK_NOLIBC_API double floor(double x) {
  double t = trunc(x);
  return x < 0 && t != x ? t - 1 : t;
}
YK_NOLIBC_API double ceil(double x) {
  double t = trunc(x);
  return x > 0 && t != x ? t + 1 : t;
}
YK_NOLIBC_API double round(double x) { /* half away from zero */
  double t = trunc(x);
  double f = x - t;
  if (f >= 0.5) return t + 1;
  if (f <= -0.5) return t - 1;
  return t;
}
YK_NOLIBC_API double ldexp(double x, int n) {
  /* In steps that keep each product exact until the last, which rounds once. */
  if (n > 1023) {
    x *= 0x1p1023;
    n -= 1023;
    if (n > 1023) {
      x *= 0x1p1023;
      n -= 1023;
      if (n > 1023) n = 1023;
    }
  } else if (n < -1022) {
    x *= 0x1p-1022 * 0x1p53;
    n += 1022 - 53;
    if (n < -1022) {
      x *= 0x1p-1022 * 0x1p53;
      n += 1022 - 53;
      if (n < -1022) n = -1022;
    }
  }
  return x * yk_double((uint64_t)(0x3ff + n) << 52);
}
YK_NOLIBC_API double scalbn(double x, int n) { return ldexp(x, n); }
YK_NOLIBC_API double frexp(double x, int *e) {
  uint64_t b = yk_bits(x);
  int ee = (int)((b >> 52) & 0x7ff);
  if (ee == 0) {
    if (x == 0) {
      *e = 0;
      return x;
    }
    x = frexp(x * 0x1p64, e);
    *e -= 64;
    return x;
  }
  if (ee == 0x7ff) {
    *e = 0;
    return x;
  }
  *e = ee - 1022;
  return yk_double((b & 0x800fffffffffffffull) | 0x3fe0000000000000ull);
}
YK_NOLIBC_API double nextafter(double x, double y) {
  if (x != x || y != y) return x + y;
  if (x == y) return y;
  if (x == 0) return yk_double((yk_bits(y) & 0x8000000000000000ull) | 1);
  uint64_t b = yk_bits(x);
  if ((y > x) == (x > 0)) b++;
  else b--;
  return yk_double(b);
}
/* The remainder of x / y with x's sign, exact (ECMA-262's %, C's fmod). */
YK_NOLIBC_API double fmod(double x, double y) {
  uint64_t bx = yk_bits(x), by = yk_bits(y);
  int ex = (int)((bx >> 52) & 0x7ff), ey = (int)((by >> 52) & 0x7ff);
  uint64_t sx = bx & 0x8000000000000000ull;
  if ((by << 1) == 0 || x != x || y != y || ex == 0x7ff) return (x * y) / (x * y);
  if ((bx << 1) <= (by << 1)) return (bx << 1) == (by << 1) ? x * 0.0 : x;
  uint64_t mx, my;
  /* The integer mantissas, subnormals normalized. */
  if (ex == 0) {
    uint64_t m = bx & 0x000fffffffffffffull;
    int z = __builtin_clzll(m) - 11;
    mx = m << z;
    ex = 1 - z;
  } else
    mx = (bx & 0x000fffffffffffffull) | 0x0010000000000000ull;
  if (ey == 0) {
    uint64_t m = by & 0x000fffffffffffffull;
    int z = __builtin_clzll(m) - 11;
    my = m << z;
    ey = 1 - z;
  } else
    my = (by & 0x000fffffffffffffull) | 0x0010000000000000ull;
  for (; ex > ey; ex--) {
    if (mx >= my) {
      mx -= my;
      if (mx == 0) return x * 0.0;
    }
    mx <<= 1;
  }
  if (mx >= my) {
    mx -= my;
    if (mx == 0) return x * 0.0;
  }
  /* Normalize back: leading bit at 52, the exponent lowered with it. */
  int z = __builtin_clzll(mx) - 11;
  mx <<= z;
  ex -= z;
  if (ex > 0) return yk_double(sx | ((uint64_t)ex << 52) | (mx & 0x000fffffffffffffull));
  /* Subnormal: exact (the remainder is below |y|, and y's bits hold it). */
  return yk_double(sx | (mx >> (1 - ex)));
}

/* ---------------------------------------------------------------- exact decimal digits of a double
 * |d| = N x 10^(point - n): its digits N (n of them, no leading zero) and the decimal point's place. */

static int yk_exact_digits(double d, char *digits, int *point) {
  static yk_bn a;
  uint64_t b = yk_bits(d) & 0x7fffffffffffffffull;
  int e = (int)(b >> 52);
  uint64_t m = b & 0x000fffffffffffffull;
  if (e == 0) e = 1;
  else m |= 0x0010000000000000ull;
  e -= 1075; /* |d| = m x 2^e */
  if (m == 0) {
    digits[0] = '0';
    *point = 1;
    return 1;
  }
  bn_set(&a, m);
  int n;
  if (e >= 0) {
    bn_shl(&a, e);
    n = bn_decimal(&a, digits, 800);
    *point = n;
  } else {
    bn_mul_pow(&a, 5, -e);
    n = bn_decimal(&a, digits, 800);
    *point = n + e;
  }
  /* Trailing zeros carry no value. */
  while (n > 1 && digits[n - 1] == '0') n--;
  return n;
}
/* digits rounded to keep of them, half to even on the exact value (keep may be 0 or less: then
 * the value rounds to 0 or to one unit at the place keep names). Returns the count; point may grow. */
static int yk_round_digits(char *digits, int n, int keep, int *point) {
  if (keep >= n) return n;
  if (keep < 0) {
    digits[0] = '0';
    return 0;
  }
  int up;
  char next = digits[keep];
  if (next > '5') up = 1;
  else if (next < '5') up = 0;
  else {
    int rest = 0;
    for (int i = keep + 1; i < n; i++)
      if (digits[i] != '0') rest = 1;
    up = rest ? 1 : (keep > 0 ? (digits[keep - 1] - '0') & 1 : 0);
  }
  n = keep;
  if (up) {
    int i = keep - 1;
    while (i >= 0 && digits[i] == '9') digits[i--] = '0';
    if (i >= 0) digits[i]++;
    else {
      /* All nines (or no digit kept): one more place. */
      memmove(digits + 1, digits, (size_t)n);
      digits[0] = '1';
      n++;
      (*point)++;
    }
  }
  return n;
}

/* ---------------------------------------------------------------- formatted output */

typedef struct {
  char *buf;
  size_t cap, len;
} yk_out;
static void out_c(yk_out *o, char c) {
  if (o->len + 1 < o->cap) o->buf[o->len] = c;
  o->len++;
}
static void out_n(yk_out *o, char c, int n) {
  while (n-- > 0) out_c(o, c);
}
static void out_s(yk_out *o, const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) out_c(o, s[i]);
}
/* A field: sign or prefix, zeros, then the body, padded to width. */
static void out_field(yk_out *o, const char *pre, const char *body, size_t blen, int width, int left,
                      int zero) {
  size_t plen = strlen(pre);
  int pad = width - (int)(plen + blen);
  if (pad < 0) pad = 0;
  if (!left && !zero) out_n(o, ' ', pad);
  out_s(o, pre, plen);
  if (!left && zero) out_n(o, '0', pad);
  out_s(o, body, blen);
  if (left) out_n(o, ' ', pad);
}
static char yk_fmt_digits[1100];
/* %e, %f or %g of a finite double's magnitude, into body; its length. */
static int yk_fmt_double(double d, char conv, int prec, int alt, char *body) {
  int point;
  int n = yk_exact_digits(d, yk_fmt_digits, &point);
  char *g = yk_fmt_digits;
  int zero = d == 0;
  int k = 0;
  int upper = conv == 'E' || conv == 'G';
  char c = conv | 0x20;
  if (c == 'g') {
    int p = prec == 0 ? 1 : prec;
    int pt = point;
    int m = zero ? 1 : yk_round_digits(g, n, p, &pt);
    if (zero) pt = 1;
    int x = pt - 1;
    if (p > x && x >= -4) {
      c = 'f';
      prec = p - 1 - x;
    } else {
      c = 'e';
      prec = p - 1;
    }
    n = m;
    point = pt;
    if (!alt) {
      /* Trailing zeros dropped: the precision shrinks to the digits there are. */
      int sig = n;
      while (sig > 1 && g[sig - 1] == '0') sig--;
      if (c == 'e') {
        if (prec > sig - 1) prec = sig - 1;
      } else {
        int frac = sig - point;
        if (zero) frac = 0;
        if (frac < 0) frac = 0;
        if (prec > frac) prec = frac;
      }
    }
  }
  if (c == 'e') {
    int pt = point;
    if (zero) {
      n = 1;
      g[0] = '0';
      pt = 1;
    } else
      n = yk_round_digits(g, n, prec + 1, &pt);
    body[k++] = n > 0 ? g[0] : '0';
    if (prec > 0 || alt) body[k++] = '.';
    for (int i = 1; i <= prec; i++) body[k++] = i < n ? g[i] : '0';
    int x = zero ? 0 : pt - 1;
    body[k++] = upper ? 'E' : 'e';
    body[k++] = x < 0 ? '-' : '+';
    if (x < 0) x = -x;
    char t[8];
    int tn = 0;
    do {
      t[tn++] = (char)('0' + x % 10);
      x /= 10;
    } while (x > 0);
    if (tn < 2) t[tn++] = '0';
    while (tn > 0) body[k++] = t[--tn];
    return k;
  }
  /* %f: the digits up to prec places after the point. */
  int pt = point;
  if (!zero) n = yk_round_digits(g, n, point + prec, &pt);
  else n = 0;
  if (pt <= 0) body[k++] = '0';
  else
    for (int i = 0; i < pt; i++) body[k++] = i < n ? g[i] : '0';
  if (prec > 0 || alt) body[k++] = '.';
  for (int i = 0; i < prec; i++) {
    int at = pt + i;
    body[k++] = at >= 0 && at < n ? g[at] : '0';
  }
  return k;
}
static int yk_vformat(yk_out *o, const char *f, va_list ap) {
  static char body[1200];
  for (; *f; f++) {
    if (*f != '%') {
      out_c(o, *f);
      continue;
    }
    f++;
    int left = 0, zero = 0, plus = 0, space = 0, alt = 0;
    for (;; f++) {
      if (*f == '-') left = 1;
      else if (*f == '0') zero = 1;
      else if (*f == '+') plus = 1;
      else if (*f == ' ') space = 1;
      else if (*f == '#') alt = 1;
      else break;
    }
    int width = 0, prec = -1;
    if (*f == '*') {
      width = va_arg(ap, int);
      if (width < 0) {
        left = 1;
        width = -width;
      }
      f++;
    } else
      while (*f >= '0' && *f <= '9') width = width * 10 + (*f++ - '0');
    if (*f == '.') {
      f++;
      prec = 0;
      if (*f == '*') {
        prec = va_arg(ap, int);
        f++;
      } else
        while (*f >= '0' && *f <= '9') prec = prec * 10 + (*f++ - '0');
    }
    int lng = 0; /* 0 int, 1 long, 2 long long, 3 size_t */
    for (;; f++) {
      if (*f == 'l') lng++;
      else if (*f == 'z' || *f == 'j' || *f == 't') lng = 2;
      else if (*f == 'h') {
      } else
        break;
    }
    char conv = *f;
    if (conv == 0) break;
    if (left) zero = 0;
    switch (conv) {
    case '%':
      out_c(o, '%');
      break;
    case 'c': {
      char ch = (char)va_arg(ap, int);
      out_field(o, "", &ch, 1, width, left, 0);
      break;
    }
    case 's': {
      const char *s = va_arg(ap, const char *);
      if (s == NULL) s = "(null)";
      size_t n = strlen(s);
      if (prec >= 0 && (size_t)prec < n) n = (size_t)prec;
      out_field(o, "", s, n, width, left, 0);
      break;
    }
    case 'd':
    case 'i':
    case 'u':
    case 'x':
    case 'X':
    case 'o':
    case 'p': {
      uint64_t v;
      int neg = 0;
      if (conv == 'p') {
        v = (uint64_t)(uintptr_t)va_arg(ap, void *);
        alt = 1;
      } else if (conv == 'd' || conv == 'i') {
        int64_t s = lng >= 1 ? va_arg(ap, long long) : va_arg(ap, int);
        neg = s < 0;
        v = neg ? (uint64_t)0 - (uint64_t)s : (uint64_t)s;
      } else
        v = lng >= 1 ? va_arg(ap, unsigned long long) : va_arg(ap, unsigned);
      unsigned base = conv == 'o' ? 8 : (conv == 'x' || conv == 'X' || conv == 'p') ? 16 : 10;
      const char *dig = conv == 'X' ? "0123456789ABCDEF" : "0123456789abcdef";
      char t[32];
      int tn = 0;
      while (v != 0) {
        t[tn++] = dig[v % base];
        v /= base;
      }
      int minimum = prec < 0 ? 1 : prec;
      while (tn < minimum) t[tn++] = '0';
      int bn = 0;
      while (tn > 0) body[bn++] = t[--tn];
      const char *pre = neg ? "-" : plus ? "+" : space ? " " : "";
      if (alt && base == 16 && (conv == 'p' || bn > 0)) pre = conv == 'X' ? "0X" : "0x";
      out_field(o, pre, body, (size_t)bn, width, left, zero && prec < 0);
      break;
    }
    case 'e':
    case 'E':
    case 'f':
    case 'F':
    case 'g':
    case 'G': {
      double d = va_arg(ap, double);
      int neg = signbit(d) != 0;
      const char *pre = neg ? "-" : plus ? "+" : space ? " " : "";
      if (d != d || isinf(d)) {
        const char *s = d != d ? "nan" : "inf";
        if (conv == 'E' || conv == 'F' || conv == 'G') s = d != d ? "NAN" : "INF";
        if (d != d) pre = plus ? "+" : space ? " " : "";
        out_field(o, pre, s, 3, width, left, 0);
        break;
      }
      int bn = yk_fmt_double(fabs(d), conv, prec < 0 ? 6 : prec, alt, body);
      out_field(o, pre, body, (size_t)bn, width, left, zero);
      break;
    }
    default:
      out_c(o, '%');
      out_c(o, conv);
    }
  }
  if (o->cap > 0) o->buf[o->len < o->cap ? o->len : o->cap - 1] = 0;
  return (int)o->len;
}
YK_NOLIBC_API int vsnprintf(char *buf, size_t cap, const char *f, va_list ap) {
  yk_out o = {buf, cap, 0};
  return yk_vformat(&o, f, ap);
}
YK_NOLIBC_API int snprintf(char *buf, size_t cap, const char *f, ...) {
  va_list ap;
  va_start(ap, f);
  int r = vsnprintf(buf, cap, f, ap);
  va_end(ap);
  return r;
}

/* ---------------------------------------------------------------- strtod, exact */

/* A double from Q x 2^x, Q's bits past the precision (and sticky, any below them) rounding half to
 * even; the precision 53 bits, fewer for a subnormal. */
static double yk_make_double(yk_bn *q, int x, int sticky) {
  int nb = bn_bits(q);
  if (nb == 0) return 0.0;
  int top = nb - 1 + x; /* the leading bit's exponent */
  if (top > 1023) return INFINITY;
  int keep = top >= -1022 ? 53 : 53 - (-1022 - top);
  if (keep < 0) return 0.0;
  int drop = nb - keep;
  uint64_t m = 0;
  if (drop <= 0) {
    for (int i = nb - 1; i >= 0; i--) m = (m << 1) | (uint64_t)bn_bit(q, i);
    m <<= -drop;
  } else {
    for (int i = nb - 1; i >= drop; i--) m = (m << 1) | (uint64_t)bn_bit(q, i);
    int half = bn_bit(q, drop - 1);
    int below = sticky;
    for (int i = drop - 2; i >= 0 && !below; i--) below = bn_bit(q, i);
    if (half && (below || (m & 1))) m++;
  }
  /* value = m x 2^(x + drop); m may have grown to 2^keep. */
  int e = x + drop;
  if (keep == 0 && m == 0) return 0.0;
  /* m < 2^54: build it exactly (m and a power of two, each a double; their product exact or the
     smallest subnormal's multiple). */
  double r = (double)m;
  return ldexp(r, e);
}
YK_NOLIBC_API double strtod(const char *s, char **end) {
  static yk_bn num, den, part;
  const char *p = s;
  while (*p == ' ' || (*p >= '\t' && *p <= '\r')) p++;
  int neg = 0;
  if (*p == '+' || *p == '-') neg = *p++ == '-';
  /* Infinity and NaN, as C writes them. */
  {
    const char *q = p;
    char w[9];
    int i = 0;
    while (i < 8 && q[i] != 0) {
      char c = q[i];
      w[i] = (char)(c >= 'A' && c <= 'Z' ? c + 32 : c);
      i++;
    }
    w[i] = 0;
    if (strncmp(w, "infinity", 8) == 0 || strncmp(w, "inf", 3) == 0) {
      if (end != NULL) *end = (char *)(q + (strncmp(w, "infinity", 8) == 0 ? 8 : 3));
      return neg ? -INFINITY : INFINITY;
    }
    if (strncmp(w, "nan", 3) == 0) {
      if (end != NULL) *end = (char *)(q + 3);
      return NAN;
    }
  }
  /* The significant digits (the first 800; any nonzero digit past them is sticky). */
  char digs[801];
  int nd = 0, dexp = 0, any = 0, sticky = 0;
  for (; *p >= '0' && *p <= '9'; p++) {
    any = 1;
    if (nd == 0 && *p == '0') continue;
    if (nd < 800) digs[nd++] = *p;
    else {
      dexp++;
      if (*p != '0') sticky = 1;
    }
  }
  if (*p == '.') {
    p++;
    for (; *p >= '0' && *p <= '9'; p++) {
      any = 1;
      if (nd == 0 && *p == '0') {
        dexp--;
        continue;
      }
      if (nd < 800) {
        digs[nd++] = *p;
        dexp--;
      } else if (*p != '0')
        sticky = 1;
    }
  }
  if (!any) {
    if (end != NULL) *end = (char *)s;
    return 0.0;
  }
  if (*p == 'e' || *p == 'E') {
    const char *q = p + 1;
    int eneg = 0;
    if (*q == '+' || *q == '-') eneg = *q++ == '-';
    if (*q >= '0' && *q <= '9') {
      long ev = 0;
      for (; *q >= '0' && *q <= '9'; q++)
        if (ev < 100000) ev = ev * 10 + (*q - '0');
      dexp += (int)(eneg ? -ev : ev);
      p = q;
    }
  }
  if (end != NULL) *end = (char *)p;
  if (nd == 0) return neg ? -0.0 : 0.0;
  /* value = digits x 10^dexp; out of the double's range entirely past these. */
  if (nd + dexp > 310) return neg ? -INFINITY : INFINITY;
  if (nd + dexp < -330) return neg ? -0.0 : 0.0;
  num.n = 0;
  for (int i = 0; i < nd; i++) {
    bn_mul_small(&num, 10);
    if (num.n == 0) bn_set(&num, (uint64_t)(digs[i] - '0'));
    else bn_add_small(&num, (uint32_t)(digs[i] - '0'));
  }
  double r;
  if (dexp >= 0) {
    bn_mul_pow(&num, 10, dexp);
    r = yk_make_double(&num, 0, sticky);
  } else {
    /* num / 10^-dexp: num scaled up by 2^s so the quotient has 64 bits or so, by long division. */
    bn_set(&den, 1);
    bn_mul_pow(&den, 10, -dexp);
    int s = bn_bits(&den) - bn_bits(&num) + 66;
    if (s < 0) s = 0;
    bn_shl(&num, s);
    yk_bn *q = &part;
    q->n = 0;
    /* Binary long division, bit by bit from the quotient's top (at most 70 bits). */
    int qbits = bn_bits(&num) - bn_bits(&den) + 1;
    uint64_t qv[2] = {0, 0};
    static yk_bn shifted;
    for (int i = qbits; i >= 0; i--) {
      shifted = den;
      bn_shl(&shifted, i);
      if (bn_cmp(&num, &shifted) >= 0) {
        bn_sub(&num, &shifted);
        qv[i / 64] |= 1ull << (i % 64);
      }
    }
    q->n = 0;
    for (int i = 0; i < 4; i++) {
      uint32_t limb = (uint32_t)(qv[i / 2] >> (32 * (i % 2)));
      q->d[q->n++] = limb;
    }
    while (q->n > 0 && q->d[q->n - 1] == 0) q->n--;
    r = yk_make_double(q, -s, sticky || num.n != 0);
  }
  return neg ? -r : r;
}

/* ---------------------------------------------------------------- stdio */

#define EOF (-1)
typedef struct {
  int fd;
  int write;
  int unbuffered;
  int eof;
  int ungot;
  size_t len, pos;
  unsigned char buf[4096];
} FILE;
static FILE yk_stdin = {0, 0, 0, 0, -1, 0, 0, {0}};
static FILE yk_stdout = {1, 1, 0, 0, -1, 0, 0, {0}};
static FILE yk_stderr = {2, 1, 1, 0, -1, 0, 0, {0}};
FILE *stdin = &yk_stdin;
FILE *stdout = &yk_stdout;
FILE *stderr = &yk_stderr;
static void yk_write_all(int fd, const unsigned char *p, size_t n) {
  while (n > 0) {
    ssize_t w = write(fd, p, n);
    if (w <= 0) return;
    p += w;
    n -= (size_t)w;
  }
}
YK_NOLIBC_API int fflush(FILE *f) {
  if (f == NULL) {
    yk_stdio_flush_all();
    return 0;
  }
  if (f->write && f->len > 0) {
    yk_write_all(f->fd, f->buf, f->len);
    f->len = 0;
  }
  return 0;
}
static void yk_stdio_flush_all(void) {
  fflush(stdout);
  fflush(stderr);
}
YK_NOLIBC_API size_t fwrite(const void *p, size_t size, size_t n, FILE *f) {
  size_t total = size * n;
  const unsigned char *q = p;
  if (f->len + total > sizeof f->buf) fflush(f);
  if (total >= sizeof f->buf) yk_write_all(f->fd, q, total);
  else {
    memcpy(f->buf + f->len, q, total);
    f->len += total;
  }
  if (f->unbuffered) fflush(f);
  return n;
}
YK_NOLIBC_API int fputc(int c, FILE *f) {
  unsigned char ch = (unsigned char)c;
  fwrite(&ch, 1, 1, f);
  return ch;
}
YK_NOLIBC_API int fputs(const char *s, FILE *f) {
  fwrite(s, 1, strlen(s), f);
  return 0;
}
YK_NOLIBC_API int vfprintf(FILE *f, const char *fmt, va_list ap) {
  char small[512];
  va_list again;
  va_copy(again, ap);
  int n = vsnprintf(small, sizeof small, fmt, ap);
  if (n < (int)sizeof small) fwrite(small, 1, (size_t)n, f);
  else {
    char *big = malloc((size_t)n + 1);
    vsnprintf(big, (size_t)n + 1, fmt, again);
    fwrite(big, 1, (size_t)n, f);
    free(big);
  }
  va_end(again);
  return n;
}
YK_NOLIBC_API int fprintf(FILE *f, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int n = vfprintf(f, fmt, ap);
  va_end(ap);
  return n;
}
YK_NOLIBC_API int printf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int n = vfprintf(stdout, fmt, ap);
  va_end(ap);
  return n;
}
YK_NOLIBC_API int fgetc(FILE *f) {
  if (f->ungot >= 0) {
    int c = f->ungot;
    f->ungot = -1;
    return c;
  }
  if (f->pos == f->len) {
    if (f->eof) return EOF;
    fflush(stdout);
    ssize_t r = read(f->fd, f->buf, sizeof f->buf);
    if (r <= 0) {
      f->eof = 1;
      return EOF;
    }
    f->len = (size_t)r;
    f->pos = 0;
  }
  return f->buf[f->pos++];
}
YK_NOLIBC_API int ungetc(int c, FILE *f) {
  if (c == EOF) return EOF;
  f->ungot = c;
  return c;
}

/* ---------------------------------------------------------------- setjmp, and a coroutine's switch
 * A jmp_buf and a context hold the same: the stack pointer, where to go on, and the callee-saved
 * registers (rbx, rbp, r12-r15), with the SSE control word. A context also has its stack. */

typedef uint64_t jmp_buf[32];
int setjmp(jmp_buf env) __attribute__((returns_twice));
_Noreturn void longjmp(jmp_buf env, int value);
/* yk_switch(from, to): this one's registers into from (it goes on when switched back to), to's in.
   yk_resume(to): to's in. A jmp_buf's layout, each architecture's: where to go on, the stack pointer
   and the callee-saved registers (with x86_64's SSE control word). */
void yk_switch(void *from, const void *to);
_Noreturn void yk_resume(const void *to);
#if defined(__x86_64__)
#define YK_SAVE                                                                                    \
  "  lea 8(%rsp), %rax\n"                                                                          \
  "  mov %rax, 0(%rdi)\n"                                                                          \
  "  mov (%rsp), %rax\n"                                                                           \
  "  mov %rax, 8(%rdi)\n"                                                                          \
  "  mov %rbx, 16(%rdi)\n"                                                                         \
  "  mov %rbp, 24(%rdi)\n"                                                                         \
  "  mov %r12, 32(%rdi)\n"                                                                         \
  "  mov %r13, 40(%rdi)\n"                                                                         \
  "  mov %r14, 48(%rdi)\n"                                                                         \
  "  mov %r15, 56(%rdi)\n"                                                                         \
  "  stmxcsr 64(%rdi)\n"
#define YK_LOAD                                                                                    \
  "  mov 16(%rdi), %rbx\n"                                                                         \
  "  mov 24(%rdi), %rbp\n"                                                                         \
  "  mov 32(%rdi), %r12\n"                                                                         \
  "  mov 40(%rdi), %r13\n"                                                                         \
  "  mov 48(%rdi), %r14\n"                                                                         \
  "  mov 56(%rdi), %r15\n"                                                                         \
  "  ldmxcsr 64(%rdi)\n"                                                                           \
  "  mov 0(%rdi), %rsp\n"                                                                          \
  "  jmp *8(%rdi)\n"
__asm__(".text\n"
        ".globl setjmp\n.type setjmp,@function\nsetjmp:\n" YK_SAVE "  xor %eax, %eax\n  ret\n"
        ".globl longjmp\n.type longjmp,@function\nlongjmp:\n"
        "  mov %esi, %eax\n  test %eax, %eax\n  jnz 1f\n  mov $1, %eax\n1:\n" YK_LOAD
        ".globl yk_switch\n.type yk_switch,@function\nyk_switch:\n" YK_SAVE "  mov %rsi, %rdi\n"
        ".globl yk_resume\n.type yk_resume,@function\nyk_resume:\n" YK_LOAD);
#elif defined(__aarch64__)
#define YK_SAVE                                                                                    \
  "  mov x16, sp\n"                                                                                \
  "  stp x19, x20, [x0, #0]\n"                                                                     \
  "  stp x21, x22, [x0, #16]\n"                                                                    \
  "  stp x23, x24, [x0, #32]\n"                                                                    \
  "  stp x25, x26, [x0, #48]\n"                                                                    \
  "  stp x27, x28, [x0, #64]\n"                                                                    \
  "  stp x29, x30, [x0, #80]\n"                                                                    \
  "  str x16, [x0, #96]\n"                                                                         \
  "  stp d8, d9, [x0, #104]\n"                                                                     \
  "  stp d10, d11, [x0, #120]\n"                                                                   \
  "  stp d12, d13, [x0, #136]\n"                                                                   \
  "  stp d14, d15, [x0, #152]\n"
#define YK_LOAD                                                                                    \
  "  ldp x19, x20, [x0, #0]\n"                                                                     \
  "  ldp x21, x22, [x0, #16]\n"                                                                    \
  "  ldp x23, x24, [x0, #32]\n"                                                                    \
  "  ldp x25, x26, [x0, #48]\n"                                                                    \
  "  ldp x27, x28, [x0, #64]\n"                                                                    \
  "  ldp x29, x30, [x0, #80]\n"                                                                    \
  "  ldr x16, [x0, #96]\n"                                                                         \
  "  ldp d8, d9, [x0, #104]\n"                                                                     \
  "  ldp d10, d11, [x0, #120]\n"                                                                   \
  "  ldp d12, d13, [x0, #136]\n"                                                                   \
  "  ldp d14, d15, [x0, #152]\n"                                                                   \
  "  mov sp, x16\n"
__asm__(".text\n"
        ".globl setjmp\n.type setjmp,%function\nsetjmp:\n" YK_SAVE "  mov w0, #0\n  ret\n"
        ".globl longjmp\n.type longjmp,%function\nlongjmp:\n" YK_LOAD
        "  cmp w1, #0\n  csinc w0, w1, wzr, ne\n  br x30\n"
        ".globl yk_switch\n.type yk_switch,%function\nyk_switch:\n" YK_SAVE "  mov x0, x1\n"
        ".globl yk_resume\n.type yk_resume,%function\nyk_resume:\n" YK_LOAD "  br x30\n");
#elif defined(__arm__)
/* r4-r11, the stack pointer, lr; then d8-d15. */
__asm__(".text\n.syntax unified\n.arm\n"
        ".globl setjmp\n.type setjmp,%function\nsetjmp:\n"
        "  mov ip, sp\n  stmia r0!, {r4-r11, ip, lr}\n  vstmia r0, {d8-d15}\n  mov r0, #0\n  bx lr\n"
        ".globl longjmp\n.type longjmp,%function\nlongjmp:\n"
        "  ldmia r0!, {r4-r11, ip, lr}\n  vldmia r0, {d8-d15}\n  mov sp, ip\n"
        "  movs r0, r1\n  moveq r0, #1\n  bx lr\n"
        ".globl yk_switch\n.type yk_switch,%function\nyk_switch:\n"
        "  mov ip, sp\n  stmia r0!, {r4-r11, ip, lr}\n  vstmia r0, {d8-d15}\n  mov r0, r1\n"
        ".globl yk_resume\n.type yk_resume,%function\nyk_resume:\n"
        "  ldmia r0!, {r4-r11, ip, lr}\n  vldmia r0, {d8-d15}\n  mov sp, ip\n  bx lr\n");
#else /* riscv64: ra, sp, s0-s11, fs0-fs11 */
#define YK_SAVE                                                                                    \
  "  sd ra, 0(a0)\n  sd sp, 8(a0)\n"                                                               \
  "  sd s0, 16(a0)\n  sd s1, 24(a0)\n  sd s2, 32(a0)\n  sd s3, 40(a0)\n"                           \
  "  sd s4, 48(a0)\n  sd s5, 56(a0)\n  sd s6, 64(a0)\n  sd s7, 72(a0)\n"                           \
  "  sd s8, 80(a0)\n  sd s9, 88(a0)\n  sd s10, 96(a0)\n  sd s11, 104(a0)\n"                        \
  "  fsd fs0, 112(a0)\n  fsd fs1, 120(a0)\n  fsd fs2, 128(a0)\n  fsd fs3, 136(a0)\n"               \
  "  fsd fs4, 144(a0)\n  fsd fs5, 152(a0)\n  fsd fs6, 160(a0)\n  fsd fs7, 168(a0)\n"               \
  "  fsd fs8, 176(a0)\n  fsd fs9, 184(a0)\n  fsd fs10, 192(a0)\n  fsd fs11, 200(a0)\n"
#define YK_LOAD                                                                                    \
  "  ld ra, 0(a0)\n  ld sp, 8(a0)\n"                                                               \
  "  ld s0, 16(a0)\n  ld s1, 24(a0)\n  ld s2, 32(a0)\n  ld s3, 40(a0)\n"                           \
  "  ld s4, 48(a0)\n  ld s5, 56(a0)\n  ld s6, 64(a0)\n  ld s7, 72(a0)\n"                           \
  "  ld s8, 80(a0)\n  ld s9, 88(a0)\n  ld s10, 96(a0)\n  ld s11, 104(a0)\n"                        \
  "  fld fs0, 112(a0)\n  fld fs1, 120(a0)\n  fld fs2, 128(a0)\n  fld fs3, 136(a0)\n"               \
  "  fld fs4, 144(a0)\n  fld fs5, 152(a0)\n  fld fs6, 160(a0)\n  fld fs7, 168(a0)\n"               \
  "  fld fs8, 176(a0)\n  fld fs9, 184(a0)\n  fld fs10, 192(a0)\n  fld fs11, 200(a0)\n"
__asm__(".text\n"
        ".globl setjmp\n.type setjmp,@function\nsetjmp:\n" YK_SAVE "  li a0, 0\n  ret\n"
        ".globl longjmp\n.type longjmp,@function\nlongjmp:\n" YK_LOAD
        "  mv a0, a1\n  bnez a0, 1f\n  li a0, 1\n1:\n  ret\n"
        ".globl yk_switch\n.type yk_switch,@function\nyk_switch:\n" YK_SAVE "  mv a0, a1\n"
        ".globl yk_resume\n.type yk_resume,@function\nyk_resume:\n" YK_LOAD "  ret\n");
#endif

typedef struct {
  void *ss_sp;
  size_t ss_size;
} stack_t;
typedef struct ucontext_t {
  jmp_buf regs;
  stack_t uc_stack;
  struct ucontext_t *uc_link;
} ucontext_t;
static int getcontext(ucontext_t *c) {
  (void)c;
  return 0;
}
/* Entering a context made for f: f is called on its stack, as a call would (x86_64: a return
   address of 0 above it; the others: f in the link register's slot). */
static void makecontext(ucontext_t *c, void (*f)(void), int argc, ...) {
  (void)argc;
  uintptr_t top = ((uintptr_t)c->uc_stack.ss_sp + c->uc_stack.ss_size) & ~(uintptr_t)15;
  memset(c->regs, 0, sizeof c->regs);
#if defined(__x86_64__)
  top -= 8;
  *(uint64_t *)top = 0;
  c->regs[0] = top;
  c->regs[1] = (uint64_t)(uintptr_t)f;
  uint32_t mxcsr;
  __asm__ volatile("stmxcsr %0" : "=m"(mxcsr));
  c->regs[8] = mxcsr;
#elif defined(__aarch64__)
  c->regs[11] = (uint64_t)(uintptr_t)f; /* x30 */
  c->regs[12] = top;                    /* sp */
#elif defined(__arm__)
  uint32_t *w = (uint32_t *)c->regs;
  w[8] = (uint32_t)top;          /* sp */
  w[9] = (uint32_t)(uintptr_t)f; /* lr */
#else
  c->regs[0] = (uint64_t)(uintptr_t)f; /* ra */
  c->regs[1] = top;                    /* sp */
#endif
}
static int swapcontext(ucontext_t *from, const ucontext_t *to) {
  yk_switch(from->regs, to->regs);
  return 0;
}
static int setcontext(const ucontext_t *to) { yk_resume(to->regs); }

/* ---------------------------------------------------------------- the program's ELF segments
 * The collector scans the writable ones (the program's globals): its own program headers, from the
 * ELF header the linker places first (__ehdr_start). */

#if defined(__LP64__)
typedef uint64_t yk_addr;
typedef struct {
  uint32_t p_type, p_flags;
  uint64_t p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_align;
} yk_phdr;
#else
typedef uint32_t yk_addr;
typedef struct {
  uint32_t p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_flags, p_align;
} yk_phdr;
#endif
typedef struct {
  unsigned char e_ident[16];
  uint16_t e_type, e_machine;
  uint32_t e_version;
  yk_addr e_entry, e_phoff, e_shoff;
  uint32_t e_flags;
  uint16_t e_ehsize, e_phentsize, e_phnum, e_shentsize, e_shnum, e_shstrndx;
} yk_ehdr;
extern const yk_ehdr __ehdr_start __attribute__((weak));
/* Each writable loaded segment's bounds, to f. */
static void yk_writable_segments(void (*f)(uint8_t *lo, uint8_t *hi)) {
  const yk_ehdr *eh = &__ehdr_start;
  if (eh == NULL) return;
  const yk_phdr *ph = (const yk_phdr *)((const char *)eh + eh->e_phoff);
  uintptr_t bias = 0;
  for (int i = 0; i < eh->e_phnum; i++)
    if (ph[i].p_type == 1 && ph[i].p_offset == 0) bias = (uintptr_t)eh - ph[i].p_vaddr;
  for (int i = 0; i < eh->e_phnum; i++) {
    if (ph[i].p_type != 1 || !(ph[i].p_flags & 2)) continue;
    uint8_t *lo = (uint8_t *)(bias + ph[i].p_vaddr);
    f(lo, lo + ph[i].p_memsz);
  }
}

/* ---------------------------------------------------------------- the entry */

int main(int argc, char **argv);
/* The program's constructors (.init_array: the lowered modules' keys, made once), as libc's start
   runs them; the linker defines the bounds, absent when there are none. */
extern void (*const __init_array_start[])(void) __attribute__((weak));
extern void (*const __init_array_end[])(void) __attribute__((weak));
YK_NOLIBC_API _Noreturn void yk_nolibc_start(uintptr_t *sp) {
  int argc = (int)sp[0];
  char **argv = (char **)(sp + 1);
  environ = argv + argc + 1;
  yk_nolibc_stack_top = (uintptr_t)sp;
  for (void (*const *f)(void) = __init_array_start; f != NULL && f < __init_array_end; f++) (*f)();
  exit(main(argc, argv));
}
/* _start, which calls yk_nolibc_start with the initial stack, is the system module's (in LLVM). */

#endif
