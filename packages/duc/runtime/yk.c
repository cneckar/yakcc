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
 *       0xFFFC: an object (pointer to yk_object: own properties in insertion order)
 *       0xFFFD: a function (pointer to yk_closure: its code and the values it captures)
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

typedef struct {
  uint32_t len, cap;
  yk *keys; /* strings */
  yk *values;
} yk_object;

/* Every function has one calling convention: the closure, the receiver, the arguments. */
typedef yk (*yk_code)(void *closure, yk self, uint64_t argc, const yk *argv);
typedef struct {
  yk_code code;
  int32_t has_this; /* a `function` (1) takes the receiver; an arrow (0) does not */
  uint32_t n;
  yk captures[];
} yk_closure;

#define TAG(v) ((v) >> 48)
#define T_SPECIAL 0xFFF9u
#define T_STRING 0xFFFAu
#define T_ARRAY 0xFFFBu
#define T_OBJECT 0xFFFCu
#define T_CLOSURE 0xFFFDu
#define PTR(v) ((void *)(uintptr_t)((v) & 0x0000FFFFFFFFFFFFull))
#define BOX(tag, p) (((yk)(tag) << 48) | (yk)(uintptr_t)(p))

const yk YK_UNDEFINED = ((yk)T_SPECIAL << 48) | 0;
const yk YK_NULL = ((yk)T_SPECIAL << 48) | 1;
const yk YK_FALSE = ((yk)T_SPECIAL << 48) | 2;
const yk YK_TRUE = ((yk)T_SPECIAL << 48) | 3;

static int is_number(yk v) { return TAG(v) < T_SPECIAL; }
static int is_string(yk v) { return TAG(v) == T_STRING; }
static int is_array(yk v) { return TAG(v) == T_ARRAY; }
static int is_object(yk v) { return TAG(v) == T_OBJECT; }
static int is_closure(yk v) { return TAG(v) == T_CLOSURE; }
/* Anything that is not a primitive. */
static int is_reference(yk v) { return is_array(v) || is_object(v) || is_closure(v); }
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

static yk call_value(yk f, yk self, uint64_t argc, const yk *argv);
static int own_get(yk_object *o, yk key, yk *out);
static int array_callback_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out);

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

static yk to_primitive(yk v);

static yk to_string(yk v) {
  if (is_object(v) || is_closure(v)) return to_string(to_primitive(v));
  if (is_string(v)) return v;
  if (is_number(v)) return number_to_string(num(v));
  if (v == YK_UNDEFINED) return ascii("undefined");
  if (v == YK_NULL) return ascii("null");
  if (v == YK_TRUE) return ascii("true");
  if (v == YK_FALSE) return ascii("false");
  return array_join(arr(v), str(ascii(",")));
}

/*
 * ToPrimitive (hint default): an array is its join; an object calls its own valueOf, then its own
 * toString, as Object.prototype's would be overridden, else "[object Object]"; a function has no
 * source text here, so it is a fixed string.
 */
static yk to_primitive(yk v) {
  if (is_array(v)) return to_string(v);
  if (is_closure(v)) return ascii("function () { [native code] }");
  if (!is_object(v)) return v;
  static const char *names[2] = {"valueOf", "toString"};
  for (int i = 0; i < 2; i++) {
    yk f;
    if (own_get((yk_object *)PTR(v), ascii(names[i]), &f) && is_closure(f)) {
      yk r = call_value(f, v, 0, NULL);
      if (!is_reference(r)) return r;
    }
  }
  return ascii("[object Object]");
}

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
  if (is_reference(v)) return 1;
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
  if (is_reference(a) && !is_reference(b)) return loose_equal(to_primitive(a), b);
  if (is_reference(b) && !is_reference(a)) return loose_equal(a, to_primitive(b));
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
  if (is_closure(v)) return ascii("function");
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
  if (is_object(obj)) {
    yk v;
    return own_get((yk_object *)PTR(obj), to_string(key), &v) ? v : YK_UNDEFINED;
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
  if (is_object(recv)) {
    yk f;
    if (own_get((yk_object *)PTR(recv), key, &f)) return call_value(f, recv, argc, argv);
  }
  if (is_array(recv)) {
    yk out;
    if (array_callback_method(recv, key, argc, argv, &out)) return out;
  }
  if (is_string(recv)) {
    yk_string *s0 = str(recv);
    if (key_is(key, "includes") || key_is(key, "startsWith") || key_is(key, "endsWith")) {
      yk_string *t = str(to_string(arg0));
      int64_t len = s0->len;
      if (key_is(key, "endsWith")) {
        int64_t end = arg1 == YK_UNDEFINED ? len : relative(arg1, len, len);
        if (arg1 != YK_UNDEFINED && to_number(arg1) < 0) end = 0;
        int64_t start = end - t->len;
        return yk_bool(start >= 0 && memcmp(s0->units + start, t->units, (size_t)t->len * 2) == 0);
      }
      int64_t from = relative(arg1, len, 0);
      if (arg1 != YK_UNDEFINED && to_number(arg1) < 0) from = 0;
      if (key_is(key, "startsWith"))
        return yk_bool(from + t->len <= len && memcmp(s0->units + from, t->units, (size_t)t->len * 2) == 0);
      for (int64_t i = from; i + t->len <= len; i++)
        if (memcmp(s0->units + i, t->units, (size_t)t->len * 2) == 0) return YK_TRUE;
      return YK_FALSE;
    }
    if (key_is(key, "trim")) {
      uint32_t a = 0, b = s0->len;
      while (a < b && is_space(s0->units[a])) a++;
      while (b > a && is_space(s0->units[b - 1])) b--;
      yk_string *r = new_string(b - a);
      memcpy(r->units, s0->units + a, (size_t)(b - a) * 2);
      return string_of(r);
    }
    if (key_is(key, "split")) {
      yk_array *r = new_array(4);
      if (arg0 == YK_UNDEFINED) {
        push(r, recv);
        return BOX(T_ARRAY, r);
      }
      yk_string *sep = str(to_string(arg0));
      if (sep->len == 0) {
        for (uint32_t i = 0; i < s0->len; i++) {
          yk_string *c = new_string(1);
          c->units[0] = s0->units[i];
          push(r, string_of(c));
        }
        return BOX(T_ARRAY, r);
      }
      uint32_t start = 0;
      for (uint32_t i = 0; i + sep->len <= s0->len;) {
        if (memcmp(s0->units + i, sep->units, (size_t)sep->len * 2) == 0) {
          yk_string *part = new_string(i - start);
          memcpy(part->units, s0->units + start, (size_t)(i - start) * 2);
          push(r, string_of(part));
          i += sep->len;
          start = i;
        } else
          i++;
      }
      yk_string *last = new_string(s0->len - start);
      memcpy(last->units, s0->units + start, (size_t)(s0->len - start) * 2);
      push(r, string_of(last));
      return BOX(T_ARRAY, r);
    }
  }
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

/* --- objects --- */

static int own_get(yk_object *o, yk key, yk *out) {
  for (uint32_t i = 0; i < o->len; i++)
    if (string_equal(str(o->keys[i]), str(key))) {
      *out = o->values[i];
      return 1;
    }
  return 0;
}

static void own_set(yk_object *o, yk key, yk value) {
  for (uint32_t i = 0; i < o->len; i++)
    if (string_equal(str(o->keys[i]), str(key))) {
      o->values[i] = value;
      return;
    }
  if (o->len == o->cap) {
    o->cap = o->cap < 4 ? 4 : o->cap * 2;
    yk *k = alloc((size_t)o->cap * sizeof(yk)), *v = alloc((size_t)o->cap * sizeof(yk));
    memcpy(k, o->keys, (size_t)o->len * sizeof(yk));
    memcpy(v, o->values, (size_t)o->len * sizeof(yk));
    o->keys = k;
    o->values = v;
  }
  o->keys[o->len] = key;
  o->values[o->len++] = value;
}

/* An object literal: its keys (by ToPropertyKey) and values, in source order. */
yk yk_object_of(uint64_t n, const yk *keys, const yk *values) {
  yk_object *o = alloc(sizeof(yk_object));
  o->len = o->cap = 0;
  o->keys = o->values = NULL;
  for (uint64_t i = 0; i < n; i++) own_set(o, to_string(keys[i]), values[i]);
  return BOX(T_OBJECT, o);
}

static void type_error(const char *what) {
  fprintf(stderr, "TypeError: %s\n", what);
  exit(70);
}

/* obj[key] = value. The graph's write yields the object, as written. */
yk yk_set(yk obj, yk key, yk value) {
  if (is_object(obj)) {
    own_set((yk_object *)PTR(obj), to_string(key), value);
    return obj;
  }
  if (is_array(obj)) {
    yk_array *a = arr(obj);
    int64_t i = index_of_key(key);
    if (i < 0) type_error("a non-index property of an array is not in the runtime yet");
    while (a->len <= i) push(a, YK_UNDEFINED);
    a->items[i] = value;
    return obj;
  }
  type_error("Cannot create a property on a primitive");
  return obj;
}

yk yk_set_named(yk obj, const char *name, uint64_t n, yk value) {
  return yk_set(obj, yk_string_utf8(name, n), value);
}

/* --- functions --- */

yk yk_closure_new(yk_code code, int32_t has_this, uint64_t n, const yk *captures) {
  yk_closure *c = alloc(sizeof(yk_closure) + (size_t)n * sizeof(yk));
  c->code = code;
  c->has_this = has_this;
  c->n = (uint32_t)n;
  memcpy(c->captures, captures, (size_t)n * sizeof(yk));
  return BOX(T_CLOSURE, c);
}
yk yk_closure_self(void *closure) { return BOX(T_CLOSURE, closure); }
yk yk_capture(void *closure, uint64_t i) { return ((yk_closure *)closure)->captures[i]; }
yk yk_arg(uint64_t argc, const yk *argv, uint64_t i) { return i < argc ? argv[i] : YK_UNDEFINED; }

static yk call_value(yk f, yk self, uint64_t argc, const yk *argv) {
  if (!is_closure(f)) type_error("not a function");
  yk_closure *c = (yk_closure *)PTR(f);
  return c->code(c, c->has_this ? self : YK_UNDEFINED, argc, argv);
}
yk yk_call(yk f, yk self, uint64_t argc, const yk *argv) { return call_value(f, self, argc, argv); }

/* A callback of an array builtin: (element, index, array). */
static yk callback(yk f, yk_array *a, uint32_t i, yk recv) {
  yk args[3] = {a->items[i], yk_number(i), recv};
  return call_value(f, YK_UNDEFINED, 3, args);
}

/* SortCompare: undefined last; the comparator's number, or the strings' order. */
static int sort_before(yk cmp, yk x, yk y) {
  if (x == YK_UNDEFINED) return 0;
  if (y == YK_UNDEFINED) return 1;
  if (cmp != YK_UNDEFINED) {
    yk args[2] = {y, x};
    double d = to_number(call_value(cmp, YK_UNDEFINED, 2, args));
    return d > 0; /* y after x reversed: x strictly before y */
  }
  return less_than(to_string(x), to_string(y)) == 1;
}

static void merge_sort(yk *items, yk *tmp, uint32_t n, yk cmp) {
  if (n < 2) return;
  uint32_t h = n / 2;
  merge_sort(items, tmp, h, cmp);
  merge_sort(items + h, tmp, n - h, cmp);
  uint32_t i = 0, j = h, k = 0;
  while (i < h && j < n) tmp[k++] = sort_before(cmp, items[j], items[i]) ? items[j++] : items[i++];
  while (i < h) tmp[k++] = items[i++];
  while (j < n) tmp[k++] = items[j++];
  memcpy(items, tmp, (size_t)n * sizeof(yk));
}

static int same_value_zero(yk a, yk b) {
  if (is_number(a) && is_number(b)) {
    double x = num(a), y = num(b);
    return x == y || (x != x && y != y);
  }
  return strict_equal(a, b);
}

/* The array builtins that take a function. */
static int array_callback_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out) {
  yk_array *a = arr(recv);
  yk f = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (key_is(key, "includes")) {
    for (uint32_t i = 0; i < a->len; i++)
      if (same_value_zero(a->items[i], f)) return *out = YK_TRUE, 1;
    return *out = YK_FALSE, 1;
  }
  if (key_is(key, "sort")) {
    if (f != YK_UNDEFINED && !is_closure(f)) type_error("the comparator is not a function");
    yk *tmp = alloc((size_t)(a->len + 1) * sizeof(yk));
    merge_sort(a->items, tmp, a->len, f);
    free(tmp);
    return *out = recv, 1;
  }
  int map = key_is(key, "map"), each = key_is(key, "forEach"), filter = key_is(key, "filter"),
      some = key_is(key, "some"), every = key_is(key, "every"), find = key_is(key, "find"),
      find_index = key_is(key, "findIndex"), reduce = key_is(key, "reduce");
  if (!(map || each || filter || some || every || find || find_index || reduce)) return 0;
  if (!is_closure(f)) type_error("the callback is not a function");
  uint32_t len = a->len;
  if (reduce) {
    uint32_t i = 0;
    yk acc;
    if (argc > 1)
      acc = argv[1];
    else {
      if (len == 0) type_error("Reduce of empty array with no initial value");
      acc = a->items[i++];
    }
    for (; i < len && i < a->len; i++) {
      yk args[4] = {acc, a->items[i], yk_number(i), recv};
      acc = call_value(f, YK_UNDEFINED, 4, args);
    }
    return *out = acc, 1;
  }
  yk_array *r = new_array(len);
  for (uint32_t i = 0; i < len && i < a->len; i++) {
    yk v = a->items[i];
    yk got = callback(f, a, i, recv);
    if (map) push(r, got);
    if (filter && yk_truthy(got)) push(r, v);
    if (some && yk_truthy(got)) return *out = YK_TRUE, 1;
    if (every && !yk_truthy(got)) return *out = YK_FALSE, 1;
    if (find && yk_truthy(got)) return *out = v, 1;
    if (find_index && yk_truthy(got)) return *out = yk_number(i), 1;
  }
  if (map || filter) return *out = BOX(T_ARRAY, r), 1;
  if (each) return *out = YK_UNDEFINED, 1;
  if (some) return *out = YK_FALSE, 1;
  if (every) return *out = YK_TRUE, 1;
  if (find) return *out = YK_UNDEFINED, 1;
  return *out = yk_number(-1), 1;
}

/* --- the global functions, as values: String, Number, Boolean --- */

static yk builtin_string(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return argc == 0 ? ascii("") : to_string(argv[0]);
}
static yk builtin_number(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return yk_number(argc == 0 ? 0 : to_number(argv[0]));
}
static yk builtin_boolean(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return yk_bool(argc > 0 && yk_truthy(argv[0]));
}

/* A global the platform gives, by name: a function value, or undefined when there is none. */
yk yk_global(const char *name, uint64_t n) {
  static yk fns[3];
  static const char *names[3] = {"String", "Number", "Boolean"};
  static yk_code codes[3] = {builtin_string, builtin_number, builtin_boolean};
  for (int i = 0; i < 3; i++)
    if (strlen(names[i]) == n && memcmp(names[i], name, n) == 0) {
      if (fns[i] == 0) fns[i] = yk_closure_new(codes[i], 0, 0, NULL);
      return fns[i];
    }
  return YK_UNDEFINED;
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
  if (c == 'o') {
    unsigned len;
    if (fscanf(in, "%u", &len) != 1) exit(65);
    yk_object *o = alloc(sizeof(yk_object));
    o->len = o->cap = 0;
    o->keys = o->values = NULL;
    for (unsigned i = 0; i < len; i++) {
      yk k = yk_read(in);
      own_set(o, k, yk_read(in));
    }
    return BOX(T_OBJECT, o);
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
  } else if (is_object(v)) {
    yk_object *o = (yk_object *)PTR(v);
    fprintf(out, "o%u", o->len);
    for (uint32_t i = 0; i < o->len; i++) {
      fputc(' ', out);
      yk_write(out, o->keys[i]);
      fputc(' ', out);
      yk_write(out, o->values[i]);
    }
  } else if (is_closure(v))
    fputc('F', out);
  else
    fputc(v == YK_UNDEFINED ? 'u' : v == YK_NULL ? 'l' : v == YK_TRUE ? 't' : 'f', out);
}
