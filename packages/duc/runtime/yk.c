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
 *       0xFFFE: the runtime's own (an iterator), never a program's value
 * Strings are UTF-16 code units, as JavaScript's are. Memory is allocated and not freed: a collector
 * is a later slice.
 *
 * Every operation follows ECMA-262 for the values it covers: ToNumber, ToString (the shortest digits
 * that round-trip), ToPrimitive for arrays (join), +, the arithmetic and relational operators, == and
 * ===, typeof, truthiness, `.length`, indexing, and the string and array methods listed below.
 */
#include <math.h>
#include <setjmp.h>
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
  int32_t error; /* made by Error / TypeError / …: its ToString is Error.prototype.toString's */
  int32_t kind;  /* 0 a plain object; 1 a Map, 2 a Set: their entries in `entries` */
  yk_array *entries; /* a Map's [key, value] pairs, a Set's values, in insertion order */
} yk_object;

/* Every function has one calling convention: the closure, the receiver, the arguments. */
typedef yk (*yk_code)(void *closure, yk self, uint64_t argc, const yk *argv);
typedef struct {
  yk_code code;
  int32_t has_this;  /* a `function` (1) takes the receiver; an arrow (0) does not */
  yk props;          /* its own properties (an object), or 0 until one is written */
  uint32_t n;
  yk captures[];
} yk_closure;

#define TAG(v) ((v) >> 48)
#define T_SPECIAL 0xFFF9u
#define T_STRING 0xFFFAu
#define T_ARRAY 0xFFFBu
#define T_OBJECT 0xFFFCu
#define T_CLOSURE 0xFFFDu
#define T_INTERNAL 0xFFFEu
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
static void type_error(const char *what);
static int own_get(yk_object *o, yk key, yk *out);
static int array_callback_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out);
static int collection_method(yk_object *o, yk recv, yk key, uint64_t argc, const yk *argv, yk *out);
static int same_value_zero(yk a, yk b);
static yk_array *iterable_items(yk v);

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
  yk_object *self = (yk_object *)PTR(v);
  static const char *names[2] = {"valueOf", "toString"};
  for (int i = 0; i < 2; i++) {
    yk f;
    if (own_get((yk_object *)PTR(v), ascii(names[i]), &f) && is_closure(f)) {
      yk r = call_value(f, v, 0, NULL);
      if (!is_reference(r)) return r;
    }
  }
  if (self->error) {
    /* Error.prototype.toString: name, ": ", message (either alone when the other is empty). */
    yk name, message;
    yk n = own_get(self, ascii("name"), &name) ? to_string(name) : ascii("Error");
    yk msg = own_get(self, ascii("message"), &message) ? to_string(message) : ascii("");
    if (str(msg)->len == 0) return n;
    if (str(n)->len == 0) return msg;
    return concat(str(concat(str(n), str(ascii(": ")))), str(msg));
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
yk yk_inc(yk a) { return yk_number(to_number(a) + 1); }
yk yk_dec(yk a) { return yk_number(to_number(a) - 1); }
int yk_is_nullish(yk a) { return is_nullish(a); }

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
  if (is_nullish(obj)) type_error(obj == YK_NULL ? "Cannot read properties of null" : "Cannot read properties of undefined");
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
    yk_object *o = (yk_object *)PTR(obj);
    if (o->kind != 0 && key_is(key, "size")) return yk_number(o->entries->len);
    yk v;
    return own_get(o, to_string(key), &v) ? v : YK_UNDEFINED;
  }
  if (is_closure(obj)) {
    yk_closure *c = (yk_closure *)PTR(obj);
    yk v;
    return c->props != 0 && own_get((yk_object *)PTR(c->props), to_string(key), &v) ? v : YK_UNDEFINED;
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
    yk_object *o = (yk_object *)PTR(recv);
    yk f;
    if (o->kind != 0) {
      yk out;
      if (collection_method(o, recv, key, argc, argv, &out)) return out;
    } else if (own_get(o, key, &f))
      return call_value(f, recv, argc, argv);
  }
  if (is_closure(recv)) {
    yk_closure *c = (yk_closure *)PTR(recv);
    yk f;
    if (c->props != 0 && own_get((yk_object *)PTR(c->props), key, &f)) return call_value(f, recv, argc, argv);
    if (key_is(key, "call")) return call_value(recv, arg0, argc > 0 ? argc - 1 : 0, argv + (argc > 0 ? 1 : 0));
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
  o->error = 0;
  o->kind = 0;
  o->entries = NULL;
  o->keys = o->values = NULL;
  for (uint64_t i = 0; i < n; i++) own_set(o, to_string(keys[i]), values[i]);
  return BOX(T_OBJECT, o);
}

static yk make_error(const char *name, yk message) {
  yk keys[2] = {ascii("name"), ascii("message")};
  yk values[2] = {ascii(name), message};
  yk e = yk_object_of(2, keys, values);
  ((yk_object *)PTR(e))->error = 1;
  return e;
}

/* --- exceptions: a stack of handlers, unwound by longjmp --- */

typedef struct handler {
  jmp_buf env;
  struct handler *prev;
} handler;
static handler *handlers = NULL;
static yk thrown;

_Noreturn void yk_throw(yk v) {
  if (handlers == NULL) {
    yk_string *s = str(to_string(v));
    fputs("Uncaught ", stderr);
    for (uint32_t i = 0; i < s->len; i++) fputc(s->units[i] < 0x80 ? (int)s->units[i] : '?', stderr);
    fputc('\n', stderr);
    exit(70);
  }
  thrown = v;
  longjmp(handlers->env, 1);
}

static void type_error(const char *what) { yk_throw(make_error("TypeError", ascii(what))); }

/* Calls f; 1 when it threw, with what it threw in *result, else 0 with its result. */
static int protected_call(yk f, uint64_t argc, const yk *argv, yk *result) {
  handler h;
  h.prev = handlers;
  handlers = &h;
  if (setjmp(h.env) == 0) {
    yk r = call_value(f, YK_UNDEFINED, argc, argv);
    handlers = h.prev;
    *result = r;
    return 0;
  }
  handlers = h.prev;
  *result = thrown;
  return 1;
}

/* obj[key] = value. The graph's write yields the object, as written. */
yk yk_set(yk obj, yk key, yk value) {
  if (is_object(obj)) {
    own_set((yk_object *)PTR(obj), to_string(key), value);
    return obj;
  }
  if (is_closure(obj)) {
    yk_closure *c = (yk_closure *)PTR(obj);
    if (c->props == 0) c->props = yk_object_of(0, NULL, NULL);
    own_set((yk_object *)PTR(c->props), to_string(key), value);
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

/* --- keys, in the order JavaScript gives them: array indexes ascending, then strings as added --- */

static int canonical_index(yk_string *s, uint32_t *out) {
  if (s->len == 0 || s->len > 10 || (s->len > 1 && s->units[0] == '0')) return 0;
  double d = 0;
  for (uint32_t i = 0; i < s->len; i++) {
    if (s->units[i] < '0' || s->units[i] > '9') return 0;
    d = d * 10 + (s->units[i] - '0');
  }
  if (d > 4294967294.0) return 0;
  *out = (uint32_t)d;
  return 1;
}

static yk_array *ordered_keys(yk_object *o) {
  yk_array *r = new_array(o->len);
  uint32_t *idx = alloc((size_t)o->len * sizeof(uint32_t) + 4);
  yk *ik = alloc((size_t)o->len * sizeof(yk) + 8);
  uint32_t n = 0;
  for (uint32_t i = 0; i < o->len; i++) {
    uint32_t k;
    if (canonical_index(str(o->keys[i]), &k)) {
      uint32_t j = n++;
      while (j > 0 && idx[j - 1] > k) idx[j] = idx[j - 1], ik[j] = ik[j - 1], j--;
      idx[j] = k;
      ik[j] = o->keys[i];
    }
  }
  for (uint32_t i = 0; i < n; i++) push(r, ik[i]);
  for (uint32_t i = 0; i < o->len; i++) {
    uint32_t k;
    if (!canonical_index(str(o->keys[i]), &k)) push(r, o->keys[i]);
  }
  free(idx);
  free(ik);
  return r;
}

/* --- iteration: for…of over arrays (live) and strings (by code point); for…in over keys --- */

typedef struct {
  yk src;
  uint32_t i;
  yk_array *keys; /* for…in: the keys, taken when the loop starts */
} yk_iter;

yk yk_iter_new(yk v, int32_t keys) {
  yk_iter *it = alloc(sizeof(yk_iter));
  it->src = v;
  it->i = 0;
  it->keys = NULL;
  if (keys) {
    if (is_object(v))
      it->keys = ordered_keys((yk_object *)PTR(v));
    else {
      it->keys = new_array(4);
      uint32_t n = is_array(v) ? arr(v)->len : is_string(v) ? str(v)->len : 0;
      for (uint32_t i = 0; i < n; i++) push(it->keys, to_string(yk_number(i)));
    }
  } else if (is_object(v) && ((yk_object *)PTR(v))->kind != 0) {
    it->src = BOX(T_ARRAY, iterable_items(v));
  } else if (!is_array(v) && !is_string(v))
    type_error("the value is not iterable here");
  return BOX(T_INTERNAL, it);
}

int yk_iter_next(yk itv, yk *out) {
  yk_iter *it = (yk_iter *)PTR(itv);
  if (it->keys != NULL) {
    if (it->i >= it->keys->len) return 0;
    *out = it->keys->items[it->i++];
    return 1;
  }
  if (is_array(it->src)) {
    yk_array *a = arr(it->src);
    if (it->i >= a->len) return 0;
    *out = a->items[it->i++];
    return 1;
  }
  yk_string *s = str(it->src);
  if (it->i >= s->len) return 0;
  uint16_t u = s->units[it->i];
  uint32_t n = (u >= 0xD800 && u <= 0xDBFF && it->i + 1 < s->len && s->units[it->i + 1] >= 0xDC00 &&
                s->units[it->i + 1] <= 0xDFFF)
                   ? 2
                   : 1;
  yk_string *c = new_string(n);
  memcpy(c->units, s->units + it->i, (size_t)n * 2);
  it->i += n;
  *out = string_of(c);
  return 1;
}

/* --- functions --- */

yk yk_closure_new(yk_code code, int32_t has_this, uint64_t n, const yk *captures) {
  yk_closure *c = alloc(sizeof(yk_closure) + (size_t)n * sizeof(yk));
  c->code = code;
  c->has_this = has_this;
  c->props = 0;
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

/* --- bitwise operators, on ToInt32 / ToUint32 --- */

static uint32_t to_uint32(yk v) {
  double d = to_number(v);
  if (d != d || isinf(d)) return 0;
  d = trunc(d);
  d = fmod(d, 4294967296.0);
  if (d < 0) d += 4294967296.0;
  return (uint32_t)d;
}
static int32_t to_int32(yk v) { return (int32_t)to_uint32(v); }

yk yk_bitor(yk a, yk b) { return yk_number(to_int32(a) | to_int32(b)); }
yk yk_bitand(yk a, yk b) { return yk_number(to_int32(a) & to_int32(b)); }
yk yk_bitxor(yk a, yk b) { return yk_number(to_int32(a) ^ to_int32(b)); }
yk yk_shl(yk a, yk b) { return yk_number((int32_t)((uint32_t)to_int32(a) << (to_uint32(b) & 31))); }
yk yk_shr(yk a, yk b) { return yk_number(to_int32(a) >> (to_uint32(b) & 31)); }
yk yk_ushr(yk a, yk b) { return yk_number(to_uint32(a) >> (to_uint32(b) & 31)); }
yk yk_bitnot(yk a) { return yk_number(~to_int32(a)); }

/* --- Map and Set: entries in insertion order, keys compared by SameValueZero --- */

static yk new_collection(int32_t kind) {
  yk v = yk_object_of(0, NULL, NULL);
  yk_object *o = (yk_object *)PTR(v);
  o->kind = kind;
  o->entries = new_array(4);
  return v;
}

static int64_t collection_find(yk_object *o, yk key) {
  for (uint32_t i = 0; i < o->entries->len; i++) {
    yk k = o->kind == 1 ? arr(o->entries->items[i])->items[0] : o->entries->items[i];
    if (same_value_zero(k, key)) return i;
  }
  return -1;
}

static void collection_remove(yk_object *o, int64_t i) {
  memmove(o->entries->items + i, o->entries->items + i + 1, (size_t)(o->entries->len - i - 1) * sizeof(yk));
  o->entries->len--;
}

static yk_array *iterable_items(yk v);

static void collection_put(yk_object *o, yk key, yk value) {
  if (key == yk_number(-0.0)) key = yk_number(0); /* -0 is stored as +0 */
  int64_t i = collection_find(o, key);
  if (o->kind == 1) {
    if (i >= 0)
      arr(o->entries->items[i])->items[1] = value;
    else {
      yk pair[2] = {key, value};
      push(o->entries, yk_array_of(2, pair));
    }
  } else if (i < 0)
    push(o->entries, key);
}

static int collection_method(yk_object *o, yk recv, yk key, uint64_t argc, const yk *argv, yk *out) {
  yk a0 = argc > 0 ? argv[0] : YK_UNDEFINED, a1 = argc > 1 ? argv[1] : YK_UNDEFINED;
  int64_t i;
  if (key_is(key, "has")) return *out = yk_bool(collection_find(o, a0) >= 0), 1;
  if (o->kind == 1 && key_is(key, "get"))
    return *out = (i = collection_find(o, a0)) >= 0 ? arr(o->entries->items[i])->items[1] : YK_UNDEFINED, 1;
  if ((o->kind == 1 && key_is(key, "set")) || (o->kind == 2 && key_is(key, "add"))) {
    collection_put(o, a0, a1);
    return *out = recv, 1;
  }
  if (key_is(key, "delete")) {
    if ((i = collection_find(o, a0)) < 0) return *out = YK_FALSE, 1;
    collection_remove(o, i);
    return *out = YK_TRUE, 1;
  }
  if (key_is(key, "clear")) {
    o->entries->len = 0;
    return *out = YK_UNDEFINED, 1;
  }
  /* keys / values / entries: the items, as an array (iterable, as the iterators they stand for). */
  int keys = key_is(key, "keys"), values = key_is(key, "values"), entries = key_is(key, "entries");
  if (keys || values || entries) {
    yk_array *r = new_array(o->entries->len);
    for (uint32_t j = 0; j < o->entries->len; j++) {
      yk e = o->entries->items[j];
      if (o->kind == 1) push(r, entries ? yk_array_of(2, arr(e)->items) : arr(e)->items[keys ? 0 : 1]);
      else {
        yk pair[2] = {e, e};
        push(r, entries ? yk_array_of(2, pair) : e);
      }
    }
    return *out = BOX(T_ARRAY, r), 1;
  }
  if (key_is(key, "forEach")) {
    for (uint32_t j = 0; j < o->entries->len; j++) {
      yk e = o->entries->items[j];
      yk args[3] = {o->kind == 1 ? arr(e)->items[1] : e, o->kind == 1 ? arr(e)->items[0] : e, recv};
      call_value(a0, a1, 3, args);
    }
    return *out = YK_UNDEFINED, 1;
  }
  return 0;
}

/* The items of an iterable, as for…of gives them: an array's, a string's code points, a Map's
 * [key, value] pairs, a Set's values. */
static yk_array *iterable_items(yk v) {
  yk_array *r = new_array(4);
  if (is_object(v) && ((yk_object *)PTR(v))->kind != 0) {
    yk out, key = ascii(((yk_object *)PTR(v))->kind == 1 ? "entries" : "values");
    collection_method((yk_object *)PTR(v), v, key, 0, NULL, &out);
    return arr(out);
  }
  yk it = yk_iter_new(v, 0), e;
  while (yk_iter_next(it, &e)) push(r, e);
  return r;
}

/* --- JSON.stringify (no replacer, no indent) --- */

static void json_quote(yk_array *parts, yk_string *s) {
  yk_string *q = new_string(s->len * 6 + 2);
  uint32_t n = 0;
  q->units[n++] = '"';
  for (uint32_t i = 0; i < s->len; i++) {
    uint16_t c = s->units[i];
    int lone = (c >= 0xD800 && c <= 0xDBFF && !(i + 1 < s->len && s->units[i + 1] >= 0xDC00 && s->units[i + 1] <= 0xDFFF)) ||
               (c >= 0xDC00 && c <= 0xDFFF && !(i > 0 && s->units[i - 1] >= 0xD800 && s->units[i - 1] <= 0xDBFF));
    const char *esc = c == '"' ? "\\\"" : c == '\\' ? "\\\\" : c == '\b' ? "\\b" : c == '\f' ? "\\f" : c == '\n' ? "\\n" : c == '\r' ? "\\r" : c == '\t' ? "\\t" : NULL;
    if (esc != NULL)
      for (const char *e = esc; *e; e++) q->units[n++] = (uint16_t)*e;
    else if (c < 0x20 || lone) {
      char buf[8];
      snprintf(buf, sizeof buf, "\\u%04x", c);
      for (const char *e = buf; *e; e++) q->units[n++] = (uint16_t)*e;
    } else
      q->units[n++] = c;
  }
  q->units[n++] = '"';
  q->len = n;
  push(parts, string_of(q));
}

/* 0: nothing written (undefined, a function); 1: written. */
static int json_write(yk_array *parts, yk v) {
  if (v == YK_UNDEFINED || is_closure(v)) return 0;
  if (v == YK_NULL) return push(parts, ascii("null")), 1;
  if (is_bool(v)) return push(parts, ascii(v == YK_TRUE ? "true" : "false")), 1;
  if (is_number(v)) {
    double d = num(v);
    return push(parts, d != d || isinf(d) ? ascii("null") : to_string(v)), 1;
  }
  if (is_string(v)) return json_quote(parts, str(v)), 1;
  if (is_array(v)) {
    push(parts, ascii("["));
    for (uint32_t i = 0; i < arr(v)->len; i++) {
      if (i > 0) push(parts, ascii(","));
      if (!json_write(parts, arr(v)->items[i])) push(parts, ascii("null"));
    }
    return push(parts, ascii("]")), 1;
  }
  yk_object *o = (yk_object *)PTR(v);
  push(parts, ascii("{"));
  if (o->kind == 0) {
    yk_array *keys = ordered_keys(o);
    int first = 1;
    for (uint32_t i = 0; i < keys->len; i++) {
      yk value;
      own_get(o, keys->items[i], &value);
      if (value == YK_UNDEFINED || is_closure(value)) continue;
      if (!first) push(parts, ascii(","));
      first = 0;
      json_quote(parts, str(keys->items[i]));
      push(parts, ascii(":"));
      json_write(parts, value);
    }
  }
  return push(parts, ascii("}")), 1;
}

static yk builtin_json_stringify(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk_array *parts = new_array(16);
  if (!json_write(parts, argc > 0 ? argv[0] : YK_UNDEFINED)) return YK_UNDEFINED;
  return array_join(parts, str(ascii("")));
}

/* --- Array.from, Array.isArray, Object.keys / values / entries / assign / freeze, Map, Set --- */

static yk builtin_array_from(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (is_nullish(v)) type_error("Array.from needs an iterable or array-like");
  yk_array *items;
  if (is_array(v) || is_string(v) || (is_object(v) && ((yk_object *)PTR(v))->kind != 0))
    items = iterable_items(v);
  else {
    /* array-like: length, then each index */
    double n = to_number(yk_get(v, ascii("length")));
    items = new_array(4);
    for (uint32_t i = 0; n == n && i < n; i++) push(items, yk_get(v, yk_number(i)));
  }
  if (argc > 1 && is_closure(argv[1]))
    for (uint32_t i = 0; i < items->len; i++) {
      yk args[2] = {items->items[i], yk_number(i)};
      items->items[i] = call_value(argv[1], YK_UNDEFINED, 2, args);
    }
  return BOX(T_ARRAY, items);
}
static yk builtin_array_is_array(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return yk_bool(argc > 0 && is_array(argv[0]));
}

static yk object_parts(yk v, int which) {
  yk_array *r = new_array(4);
  if (is_object(v) && ((yk_object *)PTR(v))->kind == 0) {
    yk_object *o = (yk_object *)PTR(v);
    yk_array *keys = ordered_keys(o);
    for (uint32_t i = 0; i < keys->len; i++) {
      yk value;
      own_get(o, keys->items[i], &value);
      yk pair[2] = {keys->items[i], value};
      push(r, which == 0 ? keys->items[i] : which == 1 ? value : yk_array_of(2, pair));
    }
  } else if (is_array(v) || is_string(v)) {
    uint32_t n = is_array(v) ? arr(v)->len : str(v)->len;
    for (uint32_t i = 0; i < n; i++) {
      yk k = to_string(yk_number(i)), value = yk_get(v, yk_number(i));
      yk pair[2] = {k, value};
      push(r, which == 0 ? k : which == 1 ? value : yk_array_of(2, pair));
    }
  } else if (is_nullish(v))
    type_error("Cannot convert undefined or null to object");
  return BOX(T_ARRAY, r);
}
static yk builtin_object_keys(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return object_parts(argc > 0 ? argv[0] : YK_UNDEFINED, 0); }
static yk builtin_object_values(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return object_parts(argc > 0 ? argv[0] : YK_UNDEFINED, 1); }
static yk builtin_object_entries(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return object_parts(argc > 0 ? argv[0] : YK_UNDEFINED, 2); }
static yk builtin_object_assign(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk target = argc > 0 ? argv[0] : YK_UNDEFINED;
  for (uint64_t i = 1; i < argc; i++) {
    if (is_nullish(argv[i])) continue;
    yk_array *entries = arr(object_parts(argv[i], 2));
    for (uint32_t j = 0; j < entries->len; j++)
      yk_set(target, arr(entries->items[j])->items[0], arr(entries->items[j])->items[1]);
  }
  return target;
}
static yk builtin_identity(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return argc > 0 ? argv[0] : YK_UNDEFINED; }
static yk builtin_object(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return argc > 0 && is_reference(argv[0]) ? argv[0] : yk_object_of(0, NULL, NULL);
}
static yk builtin_map(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk m = new_collection(1);
  if (argc > 0 && !is_nullish(argv[0])) {
    yk_array *items = iterable_items(argv[0]);
    for (uint32_t i = 0; i < items->len; i++) {
      yk pair = items->items[i];
      collection_put((yk_object *)PTR(m), yk_get(pair, yk_number(0)), yk_get(pair, yk_number(1)));
    }
  }
  return m;
}
static yk builtin_set(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk set = new_collection(2);
  if (argc > 0 && !is_nullish(argv[0])) {
    yk_array *items = iterable_items(argv[0]);
    for (uint32_t i = 0; i < items->len; i++) collection_put((yk_object *)PTR(set), items->items[i], YK_UNDEFINED);
  }
  return set;
}

static yk with_methods(yk_code code, int n, const char *const *names, const yk_code *codes) {
  yk f = code != NULL ? yk_closure_new(code, 0, 0, NULL) : yk_object_of(0, NULL, NULL);
  for (int i = 0; i < n; i++) yk_set(f, ascii(names[i]), yk_closure_new(codes[i], 0, 0, NULL));
  return f;
}

/* --- the global functions, as values --- */

/* __yakccTry(body, handler, finalizer): a try statement, as the TypeScript lowering's runtime has it. */
static yk builtin_try(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk body = argv[0], handler_fn = argc > 1 ? argv[1] : YK_UNDEFINED, fin = argc > 2 ? argv[2] : YK_UNDEFINED;
  yk r;
  int threw = protected_call(body, 0, NULL, &r);
  if (threw && is_closure(handler_fn)) {
    yk exc = r;
    threw = protected_call(handler_fn, 1, &exc, &r);
  }
  if (is_closure(fin)) {
    yk done = call_value(fin, YK_UNDEFINED, 0, NULL);
    if (is_array(done) && arr(done)->len > 0 && strict_equal(arr(done)->items[0], yk_number(1))) return done;
  }
  if (threw) yk_throw(r);
  return r;
}

static yk builtin_error_named(const char *name, uint64_t argc, const yk *argv) {
  return make_error(name, argc > 0 && argv[0] != YK_UNDEFINED ? to_string(argv[0]) : ascii(""));
}
static yk builtin_error(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return builtin_error_named("Error", argc, argv); }
static yk builtin_type_error(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return builtin_error_named("TypeError", argc, argv); }
static yk builtin_range_error(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return builtin_error_named("RangeError", argc, argv); }
static yk builtin_syntax_error(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return builtin_error_named("SyntaxError", argc, argv); }

/* parseFloat: the longest prefix that is a StrDecimalLiteral, after leading white space. */
static double parse_float(yk_string *s) {
  uint32_t i = 0;
  while (i < s->len && is_space(s->units[i])) i++;
  char buf[400];
  uint32_t n = 0;
  while (i < s->len && n < sizeof buf - 1 && s->units[i] < 0x80) buf[n++] = (char)s->units[i++];
  buf[n] = 0;
  const char *p = buf;
  int neg = 0;
  if (*p == '+' || *p == '-') neg = *p++ == '-';
  if (strncmp(p, "Infinity", 8) == 0) return neg ? -INFINITY : INFINITY;
  const char *q = p;
  int digits = 0;
  while (*q >= '0' && *q <= '9') q++, digits++;
  if (*q == '.') {
    q++;
    while (*q >= '0' && *q <= '9') q++, digits++;
  }
  if (digits == 0) return NAN;
  if (*q == 'e' || *q == 'E') {
    const char *e = q + 1;
    if (*e == '+' || *e == '-') e++;
    if (*e >= '0' && *e <= '9') {
      while (*e >= '0' && *e <= '9') e++;
      q = e;
    }
  }
  char num_buf[400];
  size_t len = (size_t)(q - buf);
  memcpy(num_buf, buf, len);
  num_buf[len] = 0;
  return strtod(num_buf, NULL);
}

/* parseInt: an optional sign, the radix's digits (16 after 0x when the radix allows), else NaN. */
static double parse_int(yk_string *s, yk radix_v) {
  uint32_t i = 0;
  while (i < s->len && is_space(s->units[i])) i++;
  int neg = 0;
  if (i < s->len && (s->units[i] == '+' || s->units[i] == '-')) neg = s->units[i++] == '-';
  int32_t radix = to_int32(radix_v);
  int strip = 1;
  if (radix != 0) {
    if (radix < 2 || radix > 36) return NAN;
    if (radix != 16) strip = 0;
  } else
    radix = 10;
  if (strip && i + 1 < s->len && s->units[i] == '0' && (s->units[i + 1] == 'x' || s->units[i + 1] == 'X')) {
    i += 2;
    radix = 16;
  }
  double r = 0;
  int any = 0;
  for (; i < s->len; i++) {
    uint16_t c = s->units[i];
    int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'z' ? c - 'a' + 10 : c >= 'A' && c <= 'Z' ? c - 'A' + 10 : 99;
    if (d >= radix) break;
    r = r * radix + d;
    any = 1;
  }
  if (!any) return NAN;
  return neg ? -r : r;
}

static yk builtin_parse_float(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return yk_number(parse_float(str(to_string(argc > 0 ? argv[0] : YK_UNDEFINED))));
}
static yk builtin_parse_int(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return yk_number(parse_int(str(to_string(argc > 0 ? argv[0] : YK_UNDEFINED)), argc > 1 ? argv[1] : YK_UNDEFINED));
}
static yk builtin_is_nan(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  double d = to_number(argc > 0 ? argv[0] : YK_UNDEFINED);
  return yk_bool(d != d);
}
static yk builtin_is_finite(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  double d = to_number(argc > 0 ? argv[0] : YK_UNDEFINED);
  return yk_bool(d == d && !isinf(d));
}
/* Array(n) and new Array(n): n holes, read as undefined; Array(a, b, …): those elements. */
static yk builtin_array(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  if (argc == 1 && is_number(argv[0])) {
    double d = num(argv[0]);
    if (d < 0 || d > 4294967295.0 || d != floor(d)) {
      fprintf(stderr, "RangeError: Invalid array length\n");
      exit(70);
    }
    yk_array *a = new_array((uint32_t)d);
    for (uint32_t i = 0; i < (uint32_t)d; i++) push(a, YK_UNDEFINED);
    return BOX(T_ARRAY, a);
  }
  return yk_array_of(argc, argv);
}

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

/*
 * A global the platform gives, by name: a function value, NaN or Infinity, or undefined when the
 * runtime has none (so a `typeof` probe for it sees what a platform without it gives).
 */
#define N_GLOBALS 19
yk yk_global(const char *name, uint64_t n) {
  if (n == 3 && memcmp(name, "NaN", 3) == 0) return yk_number(NAN);
  if (n == 8 && memcmp(name, "Infinity", 8) == 0) return yk_number(INFINITY);
  static yk fns[N_GLOBALS];
  static const char *names[N_GLOBALS] = {"String", "Number", "Boolean", "parseFloat", "parseInt",
                                         "isNaN", "isFinite", "Array", "globalThis", "__yakccTry",
                                         "Error", "TypeError", "RangeError", "SyntaxError",
                                         "Map", "Set", "Object", "JSON", "Symbol"};
  static yk_code codes[N_GLOBALS] = {builtin_string, builtin_number, builtin_boolean,
                                     builtin_parse_float, builtin_parse_int, builtin_is_nan,
                                     builtin_is_finite, builtin_array, NULL, builtin_try,
                                     builtin_error, builtin_type_error, builtin_range_error,
                                     builtin_syntax_error, builtin_map, builtin_set, builtin_object,
                                     NULL, NULL};
  for (int i = 0; i < N_GLOBALS; i++)
    if (strlen(names[i]) == n && memcmp(names[i], name, n) == 0) {
      if (fns[i] != 0) return fns[i];
      if (strcmp(names[i], "JSON") == 0) {
        static const char *const m[1] = {"stringify"};
        static const yk_code k[1] = {builtin_json_stringify};
        return fns[i] = with_methods(NULL, 1, m, k);
      }
      if (codes[i] == NULL) return YK_UNDEFINED;
      if (codes[i] == builtin_array) {
        static const char *const m[2] = {"from", "isArray"};
        static const yk_code k[2] = {builtin_array_from, builtin_array_is_array};
        return fns[i] = with_methods(builtin_array, 2, m, k);
      }
      if (codes[i] == builtin_object) {
        static const char *const m[5] = {"keys", "values", "entries", "assign", "freeze"};
        static const yk_code k[5] = {builtin_object_keys, builtin_object_values, builtin_object_entries,
                                     builtin_object_assign, builtin_identity};
        return fns[i] = with_methods(builtin_object, 5, m, k);
      }
      return fns[i] = yk_closure_new(codes[i], 0, 0, NULL);
    }
  return YK_UNDEFINED;
}

/* new F(…): the constructors the runtime has (Array). */
yk yk_new(yk f, uint64_t argc, const yk *argv) {
  if (is_closure(f)) {
    yk_code code = ((yk_closure *)PTR(f))->code;
    if (code == builtin_array || code == builtin_error || code == builtin_type_error ||
        code == builtin_range_error || code == builtin_syntax_error || code == builtin_map ||
        code == builtin_set || code == builtin_object)
      return code(NULL, YK_UNDEFINED, argc, argv);
  }
  type_error("this constructor is not in the runtime yet");
  return YK_UNDEFINED;
}

/* a instanceof F, for the constructors the runtime has: Array, and the Error family. */
yk yk_instanceof(yk v, yk f) {
  if (!is_closure(f)) type_error("Right-hand side of 'instanceof' is not callable");
  yk_code code = ((yk_closure *)PTR(f))->code;
  if (code == builtin_array) return yk_bool(is_array(v));
  if (code == builtin_error || code == builtin_type_error || code == builtin_range_error ||
      code == builtin_syntax_error) {
    if (!is_object(v) || !((yk_object *)PTR(v))->error) return YK_FALSE;
    if (code == builtin_error) return YK_TRUE;
    yk name;
    own_get((yk_object *)PTR(v), ascii("name"), &name);
    const char *want = code == builtin_type_error ? "TypeError" : code == builtin_range_error ? "RangeError" : "SyntaxError";
    return yk_bool(strict_equal(name, ascii(want)));
  }
  return YK_FALSE;
}

/* key in obj: an object's own property, an array's index or length. */
yk yk_in(yk key, yk obj) {
  if (is_object(obj)) {
    yk v;
    return yk_bool(own_get((yk_object *)PTR(obj), to_string(key), &v));
  }
  if (is_array(obj)) {
    if (key_is(to_string(key), "length")) return YK_TRUE;
    int64_t i = index_of_key(key);
    return yk_bool(i >= 0 && i < arr(obj)->len);
  }
  if (is_closure(obj)) return YK_FALSE;
  type_error("Cannot use 'in' operator to search for a key in a primitive");
  return YK_FALSE;
}

/* Whether a value is the string given in UTF-8 (a require's specifier). */
int yk_string_is(yk v, const char *p, uint64_t n) {
  return is_string(v) && string_equal(str(v), str(yk_string_utf8(p, n)));
}

void yk_fail(const char *message) {
  fprintf(stderr, "%s\n", message);
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
  if (c == 'o') {
    unsigned len;
    if (fscanf(in, "%u", &len) != 1) exit(65);
    yk_object *o = alloc(sizeof(yk_object));
    o->len = o->cap = 0;
    o->error = 0;
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
    yk_array *keys = ordered_keys(o);
    fprintf(out, "o%u", keys->len);
    for (uint32_t i = 0; i < keys->len; i++) {
      yk value;
      own_get(o, keys->items[i], &value);
      fputc(' ', out);
      yk_write(out, keys->items[i]);
      fputc(' ', out);
      yk_write(out, value);
    }
  } else if (is_closure(v))
    fputc('F', out);
  else
    fputc(v == YK_UNDEFINED ? 'u' : v == YK_NULL ? 'l' : v == YK_TRUE ? 't' : 'f', out);
}
