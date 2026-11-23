// SPDX-License-Identifier: Apache-2.0
/*
 * The yakcc native runtime (#1292, DEC-DUC-NATIVE-RUNTIME-001): JavaScript's values and operations
 * for the native lowering of graphs that are not in the typed subset. It is compiled for each target
 * by the same LLVM toolchain (clang) and linked like any C library.
 *
 * Values are NaN-boxed into one 64-bit word, as JavaScript engines box them:
 *   - a double is itself (every NaN canonical: 0x7FF8000000000000);
 *   - every other value has the top 16 bits 0xFFF9..0xFFFC, a space no canonical double uses:
 *       0xFFF9: undefined (0), null (1), false (2), true (3)
 *       0xFFFA: a string  (pointer to yk_string)
 *       0xFFFB: an array  (pointer to yk_array)
 * Strings are UTF-16 code units, as JavaScript's are. Memory is allocated and not freed: a collector
 * is a later slice.
 *
 * Every operation follows ECMA-262 for the values it covers: ToNumber, ToString (the shortest digits
 * that round-trip), ToPrimitive for arrays (join), +, the arithmetic and relational operators, == and
 * ===, typeof, truthiness, `.length`, indexing, and the string and array methods listed below.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef uint64_t yk;

typedef struct {
  uint32_t len;
  uint16_t units[];
} yk_string;

typedef struct {
  uint32_t len, cap;
  yk *items;
} yk_array;

#define TAG(v) ((v) >> 48)
#define T_SPECIAL 0xFFF9u
#define T_STRING 0xFFFAu
#define T_ARRAY 0xFFFBu
#define PTR(v) ((void *)(uintptr_t)((v) & 0x0000FFFFFFFFFFFFull))
#define BOX(tag, p) (((yk)(tag) << 48) | (yk)(uintptr_t)(p))

const yk YK_UNDEFINED = ((yk)T_SPECIAL << 48) | 0;
const yk YK_NULL = ((yk)T_SPECIAL << 48) | 1;
const yk YK_FALSE = ((yk)T_SPECIAL << 48) | 2;
const yk YK_TRUE = ((yk)T_SPECIAL << 48) | 3;

static int is_number(yk v) { return TAG(v) < T_SPECIAL; }
static int is_string(yk v) { return TAG(v) == T_STRING; }
static int is_array(yk v) { return TAG(v) == T_ARRAY; }
static int is_bool(yk v) { return v == YK_TRUE || v == YK_FALSE; }
static int is_nullish(yk v) { return v == YK_UNDEFINED || v == YK_NULL; }

static double num(yk v) {
  double d;
  memcpy(&d, &v, 8);
  return d;
}

yk yk_number(double d) {
  yk v;
  if (d != d) return 0x7FF8000000000000ull;
  memcpy(&v, &d, 8);
  return v;
}

yk yk_bool(int b) { return b ? YK_TRUE : YK_FALSE; }

static void *alloc(size_t n) {
  void *p = malloc(n);
  if (p == NULL) abort();
  return p;
}

static yk_string *new_string(uint32_t len) {
  yk_string *s = alloc(sizeof(yk_string) + (size_t)len * 2);
  s->len = len;
  return s;
}

static yk string_of(yk_string *s) { return BOX(T_STRING, s); }

/* A string from UTF-8 bytes, as a source literal is written. */
yk yk_string_utf8(const char *p, uint64_t n) {
  uint16_t *tmp = alloc((size_t)n * 2 + 2);
  uint32_t len = 0;
  for (uint64_t i = 0; i < n;) {
    uint32_t c = (unsigned char)p[i];
    int extra = c < 0x80 ? 0 : c < 0xE0 ? 1 : c < 0xF0 ? 2 : 3;
    c &= extra == 0 ? 0x7F : extra == 1 ? 0x1F : extra == 2 ? 0x0F : 0x07;
    for (int k = 1; k <= extra && i + k < n; k++) c = (c << 6) | ((unsigned char)p[i + k] & 0x3F);
    i += extra + 1;
    if (c >= 0x10000) {
      c -= 0x10000;
      tmp[len++] = (uint16_t)(0xD800 + (c >> 10));
      tmp[len++] = (uint16_t)(0xDC00 + (c & 0x3FF));
    } else
      tmp[len++] = (uint16_t)c;
  }
  yk_string *s = new_string(len);
  memcpy(s->units, tmp, (size_t)len * 2);
  free(tmp);
  return string_of(s);
}

static yk ascii(const char *p) { return yk_string_utf8(p, strlen(p)); }

static yk_string *str(yk v) { return (yk_string *)PTR(v); }
static yk_array *arr(yk v) { return (yk_array *)PTR(v); }

/* --- arrays --- */

static yk_array *new_array(uint32_t cap) {
  yk_array *a = alloc(sizeof(yk_array));
  a->len = 0;
  a->cap = cap < 4 ? 4 : cap;
  a->items = alloc((size_t)a->cap * sizeof(yk));
  return a;
}

static void push(yk_array *a, yk v) {
  if (a->len == a->cap) {
    a->cap *= 2;
    yk *items = alloc((size_t)a->cap * sizeof(yk));
    memcpy(items, a->items, (size_t)a->len * sizeof(yk));
    a->items = items;
  }
  a->items[a->len++] = v;
}

/* An array literal of `n` elements. */
yk yk_array_of(uint64_t n, const yk *items) {
  yk_array *a = new_array((uint32_t)n);
  for (uint64_t i = 0; i < n; i++) push(a, items[i]);
  return BOX(T_ARRAY, a);
}

/* --- ToString --- */

static yk concat(yk_string *a, yk_string *b) {
  yk_string *s = new_string(a->len + b->len);
  memcpy(s->units, a->units, (size_t)a->len * 2);
  memcpy(s->units + a->len, b->units, (size_t)b->len * 2);
  return string_of(s);
}

/* Number::toString(10): the shortest digits that round-trip, laid out as ECMA-262 says. */
static yk number_to_string(double d) {
  if (d != d) return ascii("NaN");
  if (d == 0) return ascii("0");
  if (isinf(d)) return ascii(d < 0 ? "-Infinity" : "Infinity");
  char buf[64], digits[32];
  int k = 0, n = 0;
  for (int p = 1; p <= 17; p++) {
    snprintf(buf, sizeof buf, "%.*e", p - 1, fabs(d));
    if (strtod(buf, NULL) == fabs(d)) break;
  }
  /* buf is d.ddde±x: the digits, and n = x + 1. */
  for (char *c = buf; *c != 'e'; c++)
    if (*c >= '0' && *c <= '9') digits[k++] = *c;
  while (k > 1 && digits[k - 1] == '0') k--;
  n = atoi(strchr(buf, 'e') + 1) + 1;
  char out[64];
  int o = 0;
  if (d < 0) out[o++] = '-';
  if (k <= n && n <= 21) {
    for (int i = 0; i < k; i++) out[o++] = digits[i];
    for (int i = k; i < n; i++) out[o++] = '0';
  } else if (0 < n && n <= 21) {
    for (int i = 0; i < n; i++) out[o++] = digits[i];
    out[o++] = '.';
    for (int i = n; i < k; i++) out[o++] = digits[i];
  } else if (-6 < n && n <= 0) {
    out[o++] = '0';
    out[o++] = '.';
    for (int i = 0; i < -n; i++) out[o++] = '0';
    for (int i = 0; i < k; i++) out[o++] = digits[i];
  } else {
    out[o++] = digits[0];
    if (k > 1) {
      out[o++] = '.';
      for (int i = 1; i < k; i++) out[o++] = digits[i];
    }
    o += snprintf(out + o, sizeof out - o, "e%c%d", n - 1 < 0 ? '-' : '+', abs(n - 1));
  }
  out[o] = 0;
  return ascii(out);
}

static yk to_string(yk v);

static yk array_join(yk_array *a, yk_string *sep) {
  yk s = ascii("");
  for (uint32_t i = 0; i < a->len; i++) {
    if (i > 0) s = concat(str(s), sep);
    if (!is_nullish(a->items[i])) s = concat(str(s), str(to_string(a->items[i])));
  }
  return s;
}

static yk to_string(yk v) {
  if (is_string(v)) return v;
  if (is_number(v)) return number_to_string(num(v));
  if (v == YK_UNDEFINED) return ascii("undefined");
  if (v == YK_NULL) return ascii("null");
  if (v == YK_TRUE) return ascii("true");
  if (v == YK_FALSE) return ascii("false");
  return array_join(arr(v), str(ascii(",")));
}

/* ToPrimitive: an array is its join; every other value here is primitive. */
static yk to_primitive(yk v) { return is_array(v) ? to_string(v) : v; }

/* --- ToNumber --- */

static int is_space(uint16_t c) {
  return c == 9 || c == 10 || c == 11 || c == 12 || c == 13 || c == 32 || c == 0xA0 ||
         c == 0x1680 || (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 ||
         c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
}

static double string_to_number(yk_string *s) {
  uint32_t a = 0, b = s->len;
  while (a < b && is_space(s->units[a])) a++;
  while (b > a && is_space(s->units[b - 1])) b--;
  if (a == b) return 0;
  char buf[400];
  if (b - a >= sizeof buf) return NAN;
  for (uint32_t i = a; i < b; i++) {
    if (s->units[i] > 0x7F) return NAN;
    buf[i - a] = (char)s->units[i];
  }
  buf[b - a] = 0;
  /* 0x, 0o, 0b: an unsigned integer in that radix. */
  if (buf[0] == '0' && (buf[1] == 'x' || buf[1] == 'X' || buf[1] == 'o' || buf[1] == 'O' ||
                        buf[1] == 'b' || buf[1] == 'B')) {
    int radix = buf[1] == 'x' || buf[1] == 'X' ? 16 : buf[1] == 'o' || buf[1] == 'O' ? 8 : 2;
    if (buf[2] == 0) return NAN;
    double r = 0;
    for (char *c = buf + 2; *c; c++) {
      int dgt = *c >= '0' && *c <= '9'   ? *c - '0'
                : *c >= 'a' && *c <= 'f' ? *c - 'a' + 10
                : *c >= 'A' && *c <= 'F' ? *c - 'A' + 10
                                         : 99;
      if (dgt >= radix) return NAN;
      r = r * radix + dgt;
    }
    return r;
  }
  const char *p = buf;
  int neg = 0;
  if (*p == '+' || *p == '-') neg = *p++ == '-';
  if (strcmp(p, "Infinity") == 0) return neg ? -INFINITY : INFINITY;
  /* StrUnsignedDecimalLiteral: digits [. digits] [e[+-]digits], at least one digit before e. */
  const char *q = p;
  int digits = 0;
  while (*q >= '0' && *q <= '9') q++, digits++;
  if (*q == '.') {
    q++;
    while (*q >= '0' && *q <= '9') q++, digits++;
  }
  if (digits == 0) return NAN;
  if (*q == 'e' || *q == 'E') {
    q++;
    if (*q == '+' || *q == '-') q++;
    if (!(*q >= '0' && *q <= '9')) return NAN;
    while (*q >= '0' && *q <= '9') q++;
  }
  if (*q != 0) return NAN;
  return strtod(buf, NULL);
}

static double to_number(yk v) {
  if (is_number(v)) return num(v);
  if (v == YK_UNDEFINED) return NAN;
  if (v == YK_NULL || v == YK_FALSE) return 0;
  if (v == YK_TRUE) return 1;
  if (is_string(v)) return string_to_number(str(v));
  return string_to_number(str(to_string(v)));
}

/* --- operators --- */

int yk_truthy(yk v) {
  if (is_number(v)) {
    double d = num(v);
    return d == d && d != 0;
  }
  if (is_string(v)) return str(v)->len > 0;
  if (is_array(v)) return 1;
  return v == YK_TRUE;
}

yk yk_add(yk a, yk b) {
  a = to_primitive(a);
  b = to_primitive(b);
  if (is_string(a) || is_string(b)) return concat(str(to_string(a)), str(to_string(b)));
  return yk_number(to_number(a) + to_number(b));
}
yk yk_sub(yk a, yk b) { return yk_number(to_number(a) - to_number(b)); }
yk yk_mul(yk a, yk b) { return yk_number(to_number(a) * to_number(b)); }
yk yk_div(yk a, yk b) { return yk_number(to_number(a) / to_number(b)); }
yk yk_mod(yk a, yk b) { return yk_number(fmod(to_number(a), to_number(b))); }
yk yk_neg(yk a) { return yk_number(-to_number(a)); }
yk yk_pos(yk a) { return yk_number(to_number(a)); }
yk yk_not(yk a) { return yk_bool(!yk_truthy(a)); }

static int string_equal(yk_string *a, yk_string *b) {
  return a->len == b->len && memcmp(a->units, b->units, (size_t)a->len * 2) == 0;
}

static int strict_equal(yk a, yk b) {
  if (is_number(a) && is_number(b)) return num(a) == num(b);
  if (is_string(a) && is_string(b)) return string_equal(str(a), str(b));
  return a == b;
}
yk yk_seq(yk a, yk b) { return yk_bool(strict_equal(a, b)); }
yk yk_sne(yk a, yk b) { return yk_bool(!strict_equal(a, b)); }

static int loose_equal(yk a, yk b) {
  /* null and undefined share a tag, and are loosely equal to each other only. */
  if (is_nullish(a) || is_nullish(b)) return is_nullish(a) && is_nullish(b);
  if (TAG(a) == TAG(b) || (is_number(a) && is_number(b))) return strict_equal(a, b);
  if (is_bool(a)) return loose_equal(yk_number(to_number(a)), b);
  if (is_bool(b)) return loose_equal(a, yk_number(to_number(b)));
  if (is_array(a) && !is_array(b)) return loose_equal(to_primitive(a), b);
  if (is_array(b) && !is_array(a)) return loose_equal(a, to_primitive(b));
  if (is_number(a) && is_string(b)) return num(a) == to_number(b);
  if (is_string(a) && is_number(b)) return to_number(a) == num(b);
  return 0;
}
yk yk_eq(yk a, yk b) { return yk_bool(loose_equal(a, b)); }
yk yk_ne(yk a, yk b) { return yk_bool(!loose_equal(a, b)); }

/* IsLessThan: -1 for undefined (a NaN took part), else 0 or 1. */
static int less_than(yk a, yk b) {
  a = to_primitive(a);
  b = to_primitive(b);
  if (is_string(a) && is_string(b)) {
    yk_string *x = str(a), *y = str(b);
    uint32_t n = x->len < y->len ? x->len : y->len;
    for (uint32_t i = 0; i < n; i++)
      if (x->units[i] != y->units[i]) return x->units[i] < y->units[i];
    return x->len < y->len;
  }
  double x = to_number(a), y = to_number(b);
  if (x != x || y != y) return -1;
  return x < y;
}
yk yk_lt(yk a, yk b) { return yk_bool(less_than(a, b) == 1); }
yk yk_gt(yk a, yk b) { return yk_bool(less_than(b, a) == 1); }
yk yk_le(yk a, yk b) { return yk_bool(less_than(b, a) == 0); }
yk yk_ge(yk a, yk b) { return yk_bool(less_than(a, b) == 0); }

yk yk_typeof(yk v) {
  if (is_number(v)) return ascii("number");
  if (is_string(v)) return ascii("string");
  if (is_bool(v)) return ascii("boolean");
  if (v == YK_UNDEFINED) return ascii("undefined");
  return ascii("object");
}

/* A template literal: its strings (n + 1) around its substitutions (n), each by ToString. */
yk yk_template(uint64_t n, const yk *strings, const yk *subs) {
  yk s = strings[0];
  for (uint64_t i = 0; i < n; i++) {
    s = concat(str(s), str(to_string(subs[i])));
    s = concat(str(s), str(strings[i + 1]));
  }
  return s;
}

/* --- properties --- */

/* An array index: a key that is a number (or numeric string) naming 0 .. 2^32 - 2. */
static int64_t index_of_key(yk key) {
  double d;
  if (is_number(key))
    d = num(key);
  else if (is_string(key)) {
    yk_string *s = str(key);
    if (s->len == 0 || s->len > 10) return -1;
    if (s->len > 1 && s->units[0] == '0') return -1;
    d = 0;
    for (uint32_t i = 0; i < s->len; i++) {
      if (s->units[i] < '0' || s->units[i] > '9') return -1;
      d = d * 10 + (s->units[i] - '0');
    }
  } else
    return -1;
  if (d < 0 || d > 4294967294.0 || d != floor(d)) return -1;
  return (int64_t)d;
}

static int key_is(yk key, const char *name) {
  if (!is_string(key)) return 0;
  yk_string *s = str(key);
  size_t n = strlen(name);
  if (s->len != n) return 0;
  for (size_t i = 0; i < n; i++)
    if (s->units[i] != (unsigned char)name[i]) return 0;
  return 1;
}

yk yk_get(yk obj, yk key) {
  if (is_nullish(obj)) {
    fprintf(stderr, "TypeError: Cannot read properties of %s\n", obj == YK_NULL ? "null" : "undefined");
    exit(70);
  }
  if (is_string(obj)) {
    yk_string *s = str(obj);
    if (key_is(key, "length")) return yk_number(s->len);
    int64_t i = index_of_key(key);
    if (i >= 0 && i < s->len) {
      yk_string *c = new_string(1);
      c->units[0] = s->units[i];
      return string_of(c);
    }
    return YK_UNDEFINED;
  }
  if (is_array(obj)) {
    yk_array *a = arr(obj);
    if (key_is(key, "length")) return yk_number(a->len);
    int64_t i = index_of_key(key);
    if (i >= 0 && i < a->len) return a->items[i];
    return YK_UNDEFINED;
  }
  return YK_UNDEFINED;
}

yk yk_get_named(yk obj, const char *name, uint64_t n) { return yk_get(obj, yk_string_utf8(name, n)); }

/* ToIntegerOrInfinity, then clamped as slice / indexOf clamp a relative index. */
static int64_t relative(yk v, int64_t len, int64_t dflt) {
  if (v == YK_UNDEFINED) return dflt;
  double d = to_number(v);
  if (d != d) d = 0;
  d = trunc(d);
  if (d < 0) d = d + len < 0 ? 0 : d + len;
  return d > len ? len : (int64_t)d;
}

/* A method call on a string or an array: the builtins this slice covers. */
yk yk_call_method(yk recv, const char *name, uint64_t n, uint64_t argc, const yk *argv) {
  yk arg0 = argc > 0 ? argv[0] : YK_UNDEFINED;
  yk arg1 = argc > 1 ? argv[1] : YK_UNDEFINED;
  yk key = yk_string_utf8(name, n);
  if (is_string(recv)) {
    yk_string *s = str(recv);
    if (key_is(key, "charCodeAt")) {
      double d = to_number(arg0);
      d = d != d ? 0 : trunc(d);
      return d < 0 || d >= s->len ? yk_number(NAN) : yk_number(s->units[(int64_t)d]);
    }
    if (key_is(key, "slice")) {
      int64_t a = relative(arg0, s->len, 0), b = relative(arg1, s->len, s->len);
      yk_string *r = new_string(b > a ? (uint32_t)(b - a) : 0);
      if (b > a) memcpy(r->units, s->units + a, (size_t)(b - a) * 2);
      return string_of(r);
    }
    if (key_is(key, "indexOf")) {
      yk_string *t = str(to_string(arg0));
      int64_t from = relative(arg1, s->len, 0);
      if (arg1 != YK_UNDEFINED && to_number(arg1) < 0) from = 0;
      for (int64_t i = from; i + t->len <= s->len; i++)
        if (memcmp(s->units + i, t->units, (size_t)t->len * 2) == 0) return yk_number((double)i);
      return yk_number(-1);
    }
  }
  if (is_array(recv)) {
    yk_array *a = arr(recv);
    if (key_is(key, "push")) {
      for (uint64_t i = 0; i < argc; i++) push(a, argv[i]);
      return yk_number(a->len);
    }
    if (key_is(key, "indexOf")) {
      for (int64_t i = relative(arg1, a->len, 0); i < a->len; i++)
        if (strict_equal(a->items[i], arg0)) return yk_number((double)i);
      return yk_number(-1);
    }
    if (key_is(key, "slice")) {
      int64_t s0 = relative(arg0, a->len, 0), s1 = relative(arg1, a->len, a->len);
      yk_array *r = new_array(s1 > s0 ? (uint32_t)(s1 - s0) : 0);
      for (int64_t i = s0; i < s1; i++) push(r, a->items[i]);
      return BOX(T_ARRAY, r);
    }
    if (key_is(key, "join"))
      return array_join(a, str(arg0 == YK_UNDEFINED ? ascii(",") : to_string(arg0)));
  }
  fprintf(stderr, "TypeError: %.*s is not a function here\n", (int)n, name);
  exit(70);
}

/* --- Math, with JavaScript's results --- */

yk yk_math1(const char *name, yk a) {
  double x = to_number(a);
  if (strcmp(name, "floor") == 0) return yk_number(floor(x));
  if (strcmp(name, "ceil") == 0) return yk_number(ceil(x));
  if (strcmp(name, "trunc") == 0) return yk_number(trunc(x));
  if (strcmp(name, "sqrt") == 0) return yk_number(sqrt(x));
  if (strcmp(name, "abs") == 0) return yk_number(fabs(x));
  if (strcmp(name, "sign") == 0) return yk_number(x > 0 ? 1 : x < 0 ? -1 : x);
  if (strcmp(name, "round") == 0) {
    double r = floor(x);
    if (x - r >= 0.5) r += 1;
    return yk_number(r == 0 ? copysign(0, x) : r);
  }
  return yk_number(NAN);
}

static double minmax(int max, double a, double b) {
  if (a != a || b != b) return NAN;
  if (a == b) {
    uint64_t x, y, r;
    memcpy(&x, &a, 8);
    memcpy(&y, &b, 8);
    r = max ? (x & y) : (x | y);
    memcpy(&a, &r, 8);
    return a;
  }
  return max ? (a > b ? a : b) : (a < b ? a : b);
}

yk yk_math_minmax(int max, uint64_t argc, const yk *argv) {
  double r = max ? -INFINITY : INFINITY;
  for (uint64_t i = 0; i < argc; i++) r = minmax(max, r, to_number(argv[i]));
  return yk_number(r);
}

/* --- the host boundary: values in a line-oriented text form --- */
/*   n<16 hex digits>  a number, by its bits    s<count>:<4 hex digits per code unit>  a string
 *   u  undefined   l  null   t  true   f  false   a<count> then the elements             */

yk yk_read(FILE *in) {
  int c;
  do c = fgetc(in);
  while (c == ' ' || c == '\n');
  if (c == EOF) exit(0);
  if (c == 'n') {
    unsigned long long bits;
    if (fscanf(in, "%16llx", &bits) != 1) exit(65);
    double d;
    memcpy(&d, &bits, 8);
    return yk_number(d);
  }
  if (c == 's') {
    unsigned len;
    if (fscanf(in, "%u:", &len) != 1) exit(65);
    yk_string *s = new_string(len);
    for (unsigned i = 0; i < len; i++) {
      unsigned u;
      if (fscanf(in, "%4x", &u) != 1) exit(65);
      s->units[i] = (uint16_t)u;
    }
    return string_of(s);
  }
  if (c == 'a') {
    unsigned len;
    if (fscanf(in, "%u", &len) != 1) exit(65);
    yk_array *a = new_array(len);
    for (unsigned i = 0; i < len; i++) push(a, yk_read(in));
    return BOX(T_ARRAY, a);
  }
  if (c == 'u') return YK_UNDEFINED;
  if (c == 'l') return YK_NULL;
  if (c == 't') return YK_TRUE;
  if (c == 'f') return YK_FALSE;
  exit(65);
}

void yk_write(FILE *out, yk v) {
  if (is_number(v)) {
    double d = num(v);
    unsigned long long bits;
    memcpy(&bits, &d, 8);
    fprintf(out, "n%016llx", bits);
  } else if (is_string(v)) {
    yk_string *s = str(v);
    fprintf(out, "s%u:", s->len);
    for (uint32_t i = 0; i < s->len; i++) fprintf(out, "%04x", s->units[i]);
  } else if (is_array(v)) {
    yk_array *a = arr(v);
    fprintf(out, "a%u", a->len);
    for (uint32_t i = 0; i < a->len; i++) {
      fputc(' ', out);
      yk_write(out, a->items[i]);
    }
  } else
    fputc(v == YK_UNDEFINED ? 'u' : v == YK_NULL ? 'l' : v == YK_TRUE ? 't' : 'f', out);
}
