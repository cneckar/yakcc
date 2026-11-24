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
 *       0xFFFF: a BigInt  (pointer to yk_bigint: a sign and 32-bit limbs)
 * Strings are UTF-16 code units, as JavaScript's are. Memory is allocated and not freed: a collector
 * is a later slice.
 *
 * Every operation follows ECMA-262 for the values it covers: ToNumber, ToString (the shortest digits
 * that round-trip), ToPrimitive for arrays (join), +, the arithmetic and relational operators, == and
 * ===, typeof, truthiness, `.length`, indexing, and the string and array methods listed below.
 */
#define _GNU_SOURCE /* ucontext: an async function's or a generator's own stack (#1295) */
#include <math.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ucontext.h>

typedef uint64_t yk;

typedef struct {
  uint32_t len;
  uint16_t units[];
} yk_string;

typedef struct {
  uint32_t len, cap;
  yk *items;
  yk props; /* its non-index properties (an object: an exec result's index, input, groups), or 0 */
} yk_array;

typedef struct {
  uint32_t len, cap;
  yk *keys; /* strings */
  yk *values;
  int32_t error; /* made by Error / TypeError / …: its ToString is Error.prototype.toString's */
  int32_t kind;  /* 0 a plain object; 1 a Map, 2 a Set: their entries in `entries`; 3 a RegExp;
                    4 a Promise, 5 a generator: their state in `ext` */
  yk proto;      /* the object it inherits from (a class's prototype), or 0 */
  yk *regex;     /* kind 3, a RegExp: its source, flags, matcher, and group names */
  yk_array *entries; /* a Map's [key, value] pairs, a Set's values, in insertion order */
  void *ext;         /* kind 4: its promise state; kind 5: its coroutine */
  void *privates;    /* its private members (#1330): a yk_object no enumeration sees, or NULL */
} yk_object;

/* A BigInt: a sign and a magnitude, 32-bit limbs least significant first, no zero limb on top. */
typedef struct {
  int32_t neg;
  uint32_t len;
  uint32_t d[];
} yk_bigint;

/* Every function has one calling convention: the closure, the receiver, the arguments. */
typedef yk (*yk_code)(void *closure, yk self, uint64_t argc, const yk *argv);
typedef struct {
  yk_code code;
  int32_t has_this;  /* a `function` (1) takes the receiver; an arrow (0) does not */
  int32_t is_class;  /* a class: called only with `new` */
  yk props;          /* its own properties (an object), or 0 until one is written */
  yk class_self;     /* for a class's member (and closures inside it): the class, or 0 */
  yk parent;         /* a derived class: the class it extends (its statics' fallback), or 0 */
  int32_t home_static; /* a static member (or a closure inside one): `super` is the parent itself */
  int32_t mode;      /* 0 a function; 1 async: a call runs it as a coroutine, giving a promise;
                        2 a generator: a call gives the generator object (#1295) */
  uint32_t nfields;  /* a class: its instance fields, defined on each instance it makes (#1330) */
  yk *field_keys;
  yk *field_inits;   /* each a method: run with the instance as its receiver, its result the value */
  uint8_t *field_kind; /* 0 a field, 1 a private field, 2 a private method, 3 a private getter,
                          4 a private setter: the private methods and accessors first */
  yk outer;          /* a class: the class whose member made it, for private names (#1330), or 0 */
  uint32_t npriv;    /* a class: the private names it declares, and its key for each */
  yk *priv_names;
  yk *priv_keys;
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
#define T_BIGINT 0xFFFFu
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
static int is_bigint(yk v) { return TAG(v) == T_BIGINT; }
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
  void *p = calloc(1, n);
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
  a->props = 0;
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
static yk async_member(void *o, yk key);
static yk async_call(void *c, yk self, uint64_t argc, const yk *argv);
static yk generator_new(void *c, yk self, uint64_t argc, const yk *argv);
static int generator_step(yk gen, yk *out);
static void type_error(const char *what);
yk yk_object_of(uint64_t n, const yk *keys, const yk *values);
yk yk_closure_new(yk_code code, int32_t has_this, uint64_t n, const yk *captures);
static int own_get(yk_object *o, yk key, yk *out);
static int chain_get(yk obj, yk key, yk *out);
static yk resolve_slot(yk slot, yk receiver);
static int array_callback_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out);
static int collection_method(yk_object *o, yk recv, yk key, uint64_t argc, const yk *argv, yk *out);
static int same_value_zero(yk a, yk b);
static int string_pattern_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out);
static int is_regexp(yk v);
static yk regexp_exec(yk re, yk s);
static yk_array *iterable_items(yk v);
static yk big_to_string_v(yk v);
static double big_to_double_v(yk v);
static int big_cmp_v(yk a, yk b);
static int big_cmp_double_v(yk a, double y);
static yk big_binary(yk a, yk b, char op);
static int numeric_pair(yk *a, yk *b);
static yk big_from_string_v(yk s);
static yk big_negate(yk a);
static yk big_add_small(yk a, int64_t k);
static uint32_t to_uint32(yk v);
static int32_t to_int32(yk v);
static int buffer_get(yk obj, yk key, yk *out);
static void range_error(const char *what);
static int program_mode;
yk yk_global(const char *name, uint64_t n);
static yk buffer_primitive(yk v);
static int buffer_set(yk obj, yk key, yk value);
static int buffer_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out);

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

/*
 * Number::toString(radix) for a radix other than 10, as V8 writes it (DoubleToRadixCString): the
 * fraction's digits while they are above half a unit in the last place of the value (scaled with
 * them), rounded half to even with a carry back through the digits written; the integer's digits by
 * repeated division, those below the double's precision zeros.
 */
static yk number_to_radix(double value, int radix) {
  static const char chars[] = "0123456789abcdefghijklmnopqrstuvwxyz";
  if (value != value) return ascii("NaN");
  if (isinf(value)) return ascii(value < 0 ? "-Infinity" : "Infinity");
  enum { kBufferSize = 2200 };
  char buffer[kBufferSize];
  int integer_cursor = kBufferSize / 2;
  int fraction_cursor = integer_cursor;
  int negative = value < 0;
  if (negative) value = -value;
  double integer = floor(value);
  double fraction = value - integer;
  double delta = 0.5 * (nextafter(value, INFINITY) - value);
  double min_delta = nextafter(0.0, 1.0);
  if (delta < min_delta) delta = min_delta;
  if (fraction >= delta) {
    buffer[fraction_cursor++] = '.';
    do {
      fraction *= radix;
      delta *= radix;
      int digit = (int)fraction;
      buffer[fraction_cursor++] = chars[digit];
      fraction -= digit;
      if (fraction > 0.5 || (fraction == 0.5 && (digit & 1))) {
        if (fraction + delta > 1) {
          for (;;) {
            fraction_cursor--;
            if (fraction_cursor == kBufferSize / 2) {
              integer += 1;
              break;
            }
            char c = buffer[fraction_cursor];
            int d = c > '9' ? (c - 'a' + 10) : (c - '0');
            if (d + 1 < radix) {
              buffer[fraction_cursor++] = chars[d + 1];
              break;
            }
          }
          break;
        }
      }
    } while (fraction >= delta);
  }
  while (integer / radix >= 9007199254740992.0) {
    integer /= radix;
    buffer[--integer_cursor] = '0';
  }
  do {
    double remainder = fmod(integer, radix);
    buffer[--integer_cursor] = chars[(int)remainder];
    integer = (integer - remainder) / radix;
  } while (integer > 0);
  if (negative) buffer[--integer_cursor] = '-';
  buffer[fraction_cursor] = 0;
  return ascii(buffer + integer_cursor);
}

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
  if (is_bigint(v)) return big_to_string_v(v);
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
  /* A typed array's toString is its join; a buffer's and a view's, their tag. */
  if (self->kind == 7) return buffer_primitive(v);
  if (self->kind == 6) return ascii("[object ArrayBuffer]");
  if (self->kind == 8) return ascii("[object DataView]");
  if (self->kind == 3)
    return concat(str(concat(str(concat(str(ascii("/")), str(self->regex[0]))), str(ascii("/")))), str(self->regex[1]));
  static const char *names[2] = {"valueOf", "toString"};
  for (int i = 0; i < 2; i++) {
    yk f;
    if (chain_get(v, ascii(names[i]), &f) && is_closure(f = resolve_slot(f, v))) {
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
  if (is_bigint(v)) type_error("Cannot convert a BigInt value to a number");
  v = to_primitive(v);
  if (is_bigint(v)) type_error("Cannot convert a BigInt value to a number");
  return to_number(v);
}

/* --- operators --- */

int yk_truthy(yk v) {
  if (is_number(v)) {
    double d = num(v);
    return d == d && d != 0;
  }
  if (is_string(v)) return str(v)->len > 0;
  if (is_reference(v)) return 1;
  if (is_bigint(v)) return ((yk_bigint *)PTR(v))->len != 0;
  return v == YK_TRUE;
}

yk yk_add(yk a, yk b) {
  a = to_primitive(a);
  b = to_primitive(b);
  if (is_string(a) || is_string(b)) return concat(str(to_string(a)), str(to_string(b)));
  if (numeric_pair(&a, &b)) return big_binary(a, b, '+');
  return yk_number(to_number(a) + to_number(b));
}
yk yk_sub(yk a, yk b) { return numeric_pair(&a, &b) ? big_binary(a, b, '-') : yk_number(to_number(a) - to_number(b)); }
yk yk_mul(yk a, yk b) { return numeric_pair(&a, &b) ? big_binary(a, b, '*') : yk_number(to_number(a) * to_number(b)); }
yk yk_div(yk a, yk b) { return numeric_pair(&a, &b) ? big_binary(a, b, '/') : yk_number(to_number(a) / to_number(b)); }
yk yk_mod(yk a, yk b) { return numeric_pair(&a, &b) ? big_binary(a, b, '%') : yk_number(fmod(to_number(a), to_number(b))); }
yk yk_neg(yk a) {
  a = to_primitive(a);
  return is_bigint(a) ? big_negate(a) : yk_number(-to_number(a));
}
yk yk_pos(yk a) { return yk_number(to_number(a)); }
yk yk_not(yk a) { return yk_bool(!yk_truthy(a)); }
yk yk_inc(yk a) {
  a = to_primitive(a);
  return is_bigint(a) ? big_add_small(a, 1) : yk_number(to_number(a) + 1);
}
yk yk_dec(yk a) {
  a = to_primitive(a);
  return is_bigint(a) ? big_add_small(a, -1) : yk_number(to_number(a) - 1);
}
int yk_is_nullish(yk a) { return is_nullish(a); }

static int string_equal(yk_string *a, yk_string *b) {
  return a->len == b->len && memcmp(a->units, b->units, (size_t)a->len * 2) == 0;
}

static int strict_equal(yk a, yk b) {
  if (is_number(a) && is_number(b)) return num(a) == num(b);
  if (is_string(a) && is_string(b)) return string_equal(str(a), str(b));
  if (is_bigint(a) && is_bigint(b)) return big_cmp_v(a, b) == 0;
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
  if (is_bigint(a) && is_number(b)) return big_cmp_double_v(a, num(b)) == 0;
  if (is_number(a) && is_bigint(b)) return big_cmp_double_v(b, num(a)) == 0;
  if (is_bigint(a) && is_string(b)) {
    yk n = big_from_string_v(b);
    return n != 0 && big_cmp_v(a, n) == 0;
  }
  if (is_string(a) && is_bigint(b)) return loose_equal(b, a);
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
  if (is_bigint(a) || is_bigint(b)) {
    if (is_string(a) && (a = big_from_string_v(a)) == 0) return -1;
    if (is_string(b) && (b = big_from_string_v(b)) == 0) return -1;
    if (is_bigint(a) && is_bigint(b)) return big_cmp_v(a, b) < 0;
    if (is_bigint(a)) {
      int c = big_cmp_double_v(a, to_number(b));
      return c == 2 ? -1 : c < 0;
    }
    int c = big_cmp_double_v(b, to_number(a));
    return c == 2 ? -1 : c > 0;
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
  if (is_bigint(v)) return ascii("bigint");
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
    yk v;
    if (i < 0 && a->props != 0 && own_get((yk_object *)PTR(a->props), to_string(key), &v)) return v;
    return YK_UNDEFINED;
  }
  if (is_object(obj) && ((yk_object *)PTR(obj))->kind == 3) {
    yk_object *o = (yk_object *)PTR(obj);
    yk flags = o->regex[1];
    const char *names[8] = {"global", "ignoreCase", "multiline", "dotAll", "unicode", "sticky", "hasIndices", NULL};
    const char letters[8] = "gimsuyd";
    if (key_is(key, "source")) return o->regex[0];
    if (key_is(key, "flags")) return flags;
    for (int f = 0; names[f] != NULL; f++)
      if (key_is(key, names[f])) {
        for (uint32_t i = 0; i < str(flags)->len; i++)
          if (str(flags)->units[i] == (uint16_t)letters[f]) return YK_TRUE;
        return YK_FALSE;
      }
  }
  if (is_object(obj)) {
    yk_object *o = (yk_object *)PTR(obj);
    if (o->kind >= 6 && o->kind <= 8) {
      yk got;
      if (buffer_get(obj, key, &got)) return got;
    }
    if ((o->kind == 1 || o->kind == 2) && key_is(key, "size")) return yk_number(o->entries->len);
    if (o->kind == 4 || o->kind == 5) {
      yk m = async_member(o, key);
      if (m != 0) return m;
    }
    yk v;
    return chain_get(obj, to_string(key), &v) ? resolve_slot(v, obj) : YK_UNDEFINED;
  }
  if (is_closure(obj)) {
    yk v;
    return chain_get(obj, to_string(key), &v) ? resolve_slot(v, obj) : YK_UNDEFINED;
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
  if (is_regexp(recv)) {
    if (key_is(key, "exec")) return regexp_exec(recv, arg0);
    if (key_is(key, "test")) return yk_bool(regexp_exec(recv, arg0) != YK_NULL);
    if (key_is(key, "toString")) return to_primitive(recv);
  }
  if (is_string(recv)) {
    yk out;
    if (string_pattern_method(recv, key, argc, argv, &out)) return out;
  }
  if (is_object(recv)) {
    yk_object *o = (yk_object *)PTR(recv);
    yk f;
    if (o->kind == 4 || o->kind == 5) {
      yk m = async_member(o, key);
      if (m != 0) return call_value(m, recv, argc, argv);
    }
    if (o->kind >= 6 && o->kind <= 8) {
      yk out;
      if (buffer_method(recv, key, argc, argv, &out)) return out;
    }
    if (o->kind == 1 || o->kind == 2) {
      yk out;
      if (collection_method(o, recv, key, argc, argv, &out)) return out;
    } else if (chain_get(recv, key, &f))
      return call_value(resolve_slot(f, recv), recv, argc, argv);
  }
  if (is_closure(recv)) {
    yk f;
    if (chain_get(recv, key, &f)) return call_value(resolve_slot(f, recv), recv, argc, argv);
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
    if (key_is(key, "padStart") || key_is(key, "padEnd")) {
      /* StringPad: to ToLength(maxLength) units, with the filler (default " ") repeated, cut. */
      double max = to_number(arg0);
      if (max != max) max = 0;
      yk_string *fill = str(arg1 == YK_UNDEFINED ? ascii(" ") : to_string(arg1));
      if (max <= s0->len || fill->len == 0) return recv;
      if (max > 536870888) range_error("Invalid string length");
      uint32_t total = (uint32_t)max, pad = total - s0->len;
      yk_string *r = new_string(total);
      int start = key_is(key, "padStart");
      uint32_t at = start ? 0 : s0->len;
      for (uint32_t i = 0; i < pad; i++) r->units[at + i] = fill->units[i % fill->len];
      memcpy(r->units + (start ? pad : 0), s0->units, (size_t)s0->len * 2);
      return string_of(r);
    }
    if (key_is(key, "repeat")) {
      double c = to_number(arg0);
      if (c != c) c = 0;
      c = trunc(c);
      if (c < 0 || isinf(c)) range_error("Invalid count value");
      if (s0->len == 0 || c == 0) return ascii("");
      if (c * s0->len > 536870888) range_error("Invalid string length");
      yk_string *r = new_string((uint32_t)c * s0->len);
      for (uint32_t i = 0; i < (uint32_t)c; i++) memcpy(r->units + (size_t)i * s0->len, s0->units, (size_t)s0->len * 2);
      return string_of(r);
    }
    if (key_is(key, "lastIndexOf")) {
      yk_string *t = str(to_string(arg0));
      double p = arg1 == YK_UNDEFINED ? NAN : to_number(arg1);
      int64_t len = s0->len, from = p != p ? len : p < 0 ? 0 : p > len ? len : (int64_t)trunc(p);
      if (from > len - (int64_t)t->len) from = len - (int64_t)t->len;
      for (int64_t i = from; i >= 0; i--)
        if (memcmp(s0->units + i, t->units, (size_t)t->len * 2) == 0) return yk_number((double)i);
      return yk_number(-1);
    }
    if (key_is(key, "concat")) {
      yk r = recv;
      for (uint64_t i = 0; i < argc; i++) r = concat(str(r), str(to_string(argv[i])));
      return r;
    }
    if (key_is(key, "trimStart") || key_is(key, "trimEnd")) {
      uint32_t a = 0, b = s0->len;
      if (key_is(key, "trimStart")) while (a < b && is_space(s0->units[a])) a++;
      else while (b > a && is_space(s0->units[b - 1])) b--;
      yk_string *r = new_string(b - a);
      memcpy(r->units, s0->units + a, (size_t)(b - a) * 2);
      return string_of(r);
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
    if (key_is(key, "codePointAt")) {
      double d = to_number(arg0);
      d = d != d ? 0 : trunc(d);
      if (d < 0 || d >= s->len) return YK_UNDEFINED;
      uint32_t i = (uint32_t)d;
      uint16_t hi = s->units[i];
      if (hi >= 0xD800 && hi <= 0xDBFF && i + 1 < s->len && s->units[i + 1] >= 0xDC00 && s->units[i + 1] <= 0xDFFF)
        return yk_number(0x10000 + ((hi - 0xD800) << 10) + (s->units[i + 1] - 0xDC00));
      return yk_number(hi);
    }
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
    if (key_is(key, "pop")) return a->len == 0 ? YK_UNDEFINED : a->items[--a->len];
    if (key_is(key, "shift")) {
      if (a->len == 0) return YK_UNDEFINED;
      yk first = a->items[0];
      memmove(a->items, a->items + 1, (size_t)(a->len - 1) * sizeof(yk));
      a->len--;
      return first;
    }
    if (key_is(key, "unshift")) {
      for (uint64_t i = 0; i < argc; i++) push(a, YK_UNDEFINED);
      memmove(a->items + argc, a->items, (size_t)(a->len - argc) * sizeof(yk));
      for (uint64_t i = 0; i < argc; i++) a->items[i] = argv[i];
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
  if ((is_number(recv) || is_bool(recv) || is_bigint(recv)) && key_is(key, "toString")) {
    if (is_number(recv) && arg0 != YK_UNDEFINED) {
      double r = trunc(to_number(arg0));
      if (!(r >= 2 && r <= 36)) range_error("toString() radix must be between 2 and 36");
      if (r != 10) return number_to_radix(num(recv), (int)r);
    }
    return to_string(recv);
  }
  if ((is_number(recv) || is_bool(recv) || is_bigint(recv)) && key_is(key, "valueOf")) return recv;
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

/* --- accessors, prototypes, classes --- */

typedef struct {
  int32_t internal; /* 2: an accessor */
  yk get, set;      /* functions, or 0 */
} yk_accessor;

static int is_accessor(yk v) { return TAG(v) == T_INTERNAL && *(int32_t *)PTR(v) == 2; }

/* A slot's value as a read sees it: an accessor calls its getter on the receiver. */
static yk resolve_slot(yk slot, yk receiver) {
  if (!is_accessor(slot)) return slot;
  yk getter = ((yk_accessor *)PTR(slot))->get;
  return getter == 0 ? YK_UNDEFINED : call_value(getter, receiver, 0, NULL);
}

static yk ensure_prototype(yk f);

/* The object holding a value's own properties: an object itself, or a function's property object. */
static yk_object *own_props(yk v) {
  if (is_object(v)) return (yk_object *)PTR(v);
  yk_closure *c = (yk_closure *)PTR(v);
  if (c->props == 0) c->props = yk_object_of(0, NULL, NULL);
  return (yk_object *)PTR(c->props);
}

/* A property along the prototype chain: its slot (perhaps an accessor). */
static int chain_get(yk obj, yk key, yk *out) {
  if (is_closure(obj)) {
    yk_closure *c = (yk_closure *)PTR(obj);
    /* A function's prototype exists from its first use, as `F.prototype.m = …` needs. */
    if ((c->has_this || c->is_class) && key_is(key, "prototype")) ensure_prototype(obj);
    if (c->props != 0 && own_get((yk_object *)PTR(c->props), key, out)) return 1;
    /* A derived class inherits its parent's statics. */
    return c->parent != 0 && is_closure(c->parent) && chain_get(c->parent, key, out);
  }
  for (yk v = obj; v != 0 && is_object(v); v = ((yk_object *)PTR(v))->proto)
    if (own_get((yk_object *)PTR(v), key, out)) return 1;
  return 0;
}

static yk ensure_prototype(yk f) {
  yk_closure *c = (yk_closure *)PTR(f);
  yk p;
  if (c->props != 0 && own_get((yk_object *)PTR(c->props), ascii("prototype"), &p)) return p;
  yk key = ascii("constructor");
  p = yk_object_of(1, &key, &f);
  own_set(own_props(f), ascii("prototype"), p);
  return p;
}

/* An accessor slot on an object: its getter or setter, merged with the other if there is one. */
static void define_accessor(yk_object *o, yk key, yk getter, yk setter) {
  yk slot;
  if (own_get(o, key, &slot) && is_accessor(slot)) {
    yk_accessor *a = (yk_accessor *)PTR(slot);
    if (getter != 0) a->get = getter;
    if (setter != 0) a->set = setter;
    return;
  }
  yk_accessor *a = alloc(sizeof(yk_accessor));
  a->internal = 2;
  a->get = getter;
  a->set = setter;
  own_set(o, key, BOX(T_INTERNAL, a));
}

/* An object literal built slot by slot (when it has a spread or an accessor). */
yk yk_define(yk obj, yk key, yk value) {
  own_set((yk_object *)PTR(obj), to_string(key), value);
  return obj;
}
yk yk_define_accessor(yk obj, yk key, yk getter, yk setter) {
  define_accessor((yk_object *)PTR(obj), to_string(key), getter == YK_UNDEFINED ? 0 : getter,
                  setter == YK_UNDEFINED ? 0 : setter);
  return obj;
}

/* A class (kinds: 0 constructor, 1 method, 2 getter, 3 setter, 4 field, 5 static block, 8 more for
   a private name; each static or not). A field's member is its initializer; a computed name is the
   key's value (#1330). */
static yk default_constructor(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self, (void)argc, (void)argv;
  return YK_UNDEFINED;
}
static yk builtin_error(void *, yk, uint64_t, const yk *);
static yk builtin_type_error(void *, yk, uint64_t, const yk *);
static yk builtin_range_error(void *, yk, uint64_t, const yk *);
static yk builtin_syntax_error(void *, yk, uint64_t, const yk *);
static int is_error_constructor(yk f) {
  if (!is_closure(f)) return 0;
  yk_code code = ((yk_closure *)PTR(f))->code;
  return code == builtin_error || code == builtin_type_error || code == builtin_range_error ||
         code == builtin_syntax_error;
}
/* A class's instance fields, defined on a receiver in order, each initializer run with it as its
   receiver: by `new` for a base class before its constructor's body, and for a derived class when
   its super(..) returns (#1330). A field is defined, not assigned: a setter does not see it. */
/* --- private names (#1330): a private member is in its object's private table, keyed by the
   private name of one evaluation of one class; no enumeration, `in` or JSON sees the table --- */

/* A private method's slot: the method, not writable. */
typedef struct {
  int32_t internal; /* 3: a private method */
  yk method;
} yk_private_method;
static int is_private_method(yk v) { return TAG(v) == T_INTERNAL && *(int32_t *)PTR(v) == 3; }

static yk_object *privates_of(yk v, int create) {
  if (!is_object(v) && !is_closure(v)) return NULL;
  yk_object *o = own_props(v);
  if (o->privates == NULL && create) o->privates = PTR(yk_object_of(0, NULL, NULL));
  return (yk_object *)o->privates;
}

/* The key a private name means where it is written: that of the nearest class around the
   closure that declares it, as ECMAScript resolves it lexically. */
yk yk_private_key(void *closure, const char *name, uint64_t n) {
  yk want = yk_string_utf8(name, n);
  for (yk cls = closure == NULL ? 0 : ((yk_closure *)closure)->class_self; cls != 0;
       cls = ((yk_closure *)PTR(cls))->outer) {
    yk_closure *c = (yk_closure *)PTR(cls);
    for (uint32_t i = 0; i < c->npriv; i++)
      if (string_equal(str(c->priv_names[i]), str(want))) return c->priv_keys[i];
  }
  type_error("a private name is used outside a class that declares it");
  return YK_UNDEFINED;
}

yk yk_private_get(yk obj, yk key) {
  yk_object *p = privates_of(obj, 0);
  yk slot = 0;
  if (p == NULL || !own_get(p, key, &slot))
    type_error("Cannot read private member from an object whose class did not declare it");
  if (is_private_method(slot)) return ((yk_private_method *)PTR(slot))->method;
  if (is_accessor(slot)) {
    yk getter = ((yk_accessor *)PTR(slot))->get;
    if (getter == 0) type_error("'#' was defined without a getter");
    return call_value(getter, obj, 0, NULL);
  }
  return slot;
}

yk yk_private_set(yk obj, yk key, yk value) {
  yk_object *p = privates_of(obj, 0);
  yk slot = 0;
  if (p == NULL || !own_get(p, key, &slot))
    type_error("Cannot write private member to an object whose class did not declare it");
  if (is_private_method(slot)) type_error("Private method is not writable");
  if (is_accessor(slot)) {
    yk setter = ((yk_accessor *)PTR(slot))->set;
    if (setter == 0) type_error("'#' was defined without a setter");
    call_value(setter, obj, 1, &value);
    return value;
  }
  own_set(p, key, value);
  return value;
}

/* #x in o: whether o has the private member (its class's brand). */
yk yk_private_has(yk obj, yk key) {
  if (!is_object(obj) && !is_closure(obj)) type_error("Cannot use 'in' operator to search for a private field in a value that is not an object");
  yk_object *p = privates_of(obj, 0);
  yk slot;
  return yk_bool(p != NULL && own_get(p, key, &slot));
}

/* A private member of kind 2 (method), 3 (getter) or 4 (setter), or a private field's value. */
static void define_private(yk target, int kind, yk key, yk value) {
  yk_object *p = privates_of(target, 1);
  if (kind == 2) {
    yk_private_method *m = alloc(sizeof(yk_private_method));
    m->internal = 3;
    m->method = value;
    own_set(p, key, BOX(T_INTERNAL, m));
  } else if (kind == 3 || kind == 4)
    define_accessor(p, key, kind == 3 ? value : 0, kind == 4 ? value : 0);
  else
    own_set(p, key, value);
}

static void init_fields(yk cls, yk self) {
  yk_closure *c = (yk_closure *)PTR(cls);
  /* The private methods and accessors are the instance's before any field is (its brand). */
  for (uint32_t i = 0; i < c->nfields; i++)
    if (c->field_kind[i] >= 2) define_private(self, c->field_kind[i], c->field_keys[i], c->field_inits[i]);
  for (uint32_t i = 0; i < c->nfields; i++) {
    if (c->field_kind[i] >= 2) continue;
    yk_closure *init = (yk_closure *)PTR(c->field_inits[i]);
    yk v = init->code(init, self, 0, NULL);
    if (c->field_kind[i] == 1) define_private(self, 1, c->field_keys[i], v);
    else own_set((yk_object *)PTR(self), c->field_keys[i], v);
  }
}
/* super(args) in a derived constructor: the parent's constructor run on this receiver (#1294). */
yk yk_super_construct(void *closure, yk self, uint64_t argc, const yk *argv) {
  yk cls = ((yk_closure *)closure)->class_self;
  yk parent = cls == 0 ? 0 : ((yk_closure *)PTR(cls))->parent;
  if (parent == 0) type_error("'super' keyword unexpected here");
  if (is_error_constructor(parent)) {
    /* An Error subclass: the receiver is made an error, with the parent's name and message. */
    yk made = ((yk_closure *)PTR(parent))->code(NULL, YK_UNDEFINED, argc, argv);
    yk_object *o = (yk_object *)PTR(self), *e = (yk_object *)PTR(made);
    o->error = 1;
    for (uint32_t i = 0; i < e->len; i++) own_set(o, e->keys[i], e->values[i]);
    init_fields(cls, self);
    return self;
  }
  yk_closure *p = (yk_closure *)PTR(parent);
  /* A base parent's fields are defined before its body runs; a derived parent's by its super(). */
  if (p->is_class && p->parent == 0) init_fields(parent, self);
  yk r = p->code(p, self, argc, argv);
  if (is_reference(r)) return r;
  init_fields(cls, self);
  return self;
}
/* A derived class with no constructor of its own passes its arguments to its parent's. */
static yk default_derived_constructor(void *c, yk self, uint64_t argc, const yk *argv) {
  yk_super_construct(c, self, argc, argv);
  return YK_UNDEFINED;
}
/* super[key]: the parent's member by a key's value (#1330); super.name is it by a name. */
yk yk_super_get_key(void *closure, yk self, yk key) {
  yk_closure *c = (yk_closure *)closure;
  yk cls = c->class_self;
  yk parent = cls == 0 ? 0 : ((yk_closure *)PTR(cls))->parent;
  if (parent == 0 || !is_closure(parent)) return YK_UNDEFINED;
  key = to_string(key);
  yk slot;
  yk_closure *p = (yk_closure *)PTR(parent);
  yk base = c->home_static ? parent : (p->is_class || p->has_this) ? ensure_prototype(parent) : 0;
  if (base == 0 || !chain_get(base, key, &slot)) return YK_UNDEFINED;
  return resolve_slot(slot, self);
}
/* super.name: the parent's member (its prototype's, or for a static member the parent's own),
   read with this function's receiver (#1294). */
yk yk_super_get(void *closure, yk self, const char *name, uint64_t n) {
  yk_closure *c = (yk_closure *)closure;
  yk cls = c->class_self;
  yk parent = cls == 0 ? 0 : ((yk_closure *)PTR(cls))->parent;
  if (parent == 0 || !is_closure(parent)) return YK_UNDEFINED;
  yk key = yk_string_utf8(name, n), slot;
  yk_closure *p = (yk_closure *)PTR(parent);
  yk base = c->home_static ? parent : (p->is_class || p->has_this) ? ensure_prototype(parent) : 0;
  if (base == 0 || !chain_get(base, key, &slot)) return YK_UNDEFINED;
  return resolve_slot(slot, self);
}
static void add_field(yk_closure *c, uint8_t kind, yk key, yk member) {
  c->field_keys = realloc(c->field_keys, (c->nfields + 1) * sizeof(yk));
  c->field_inits = realloc(c->field_inits, (c->nfields + 1) * sizeof(yk));
  c->field_kind = realloc(c->field_kind, (c->nfields + 1) * sizeof(uint8_t));
  if (c->field_keys == NULL || c->field_inits == NULL || c->field_kind == NULL) abort();
  c->field_keys[c->nfields] = key;
  c->field_inits[c->nfields] = member;
  c->field_kind[c->nfields++] = kind;
}
/* The key of a private name this class declares: made once per evaluation of the class. */
static yk private_key_of(yk_closure *c, yk cls, yk name) {
  for (uint32_t i = 0; i < c->npriv; i++)
    if (string_equal(str(c->priv_names[i]), str(name))) return c->priv_keys[i];
  char suffix[40];
  int len = snprintf(suffix, sizeof suffix, "@%llx", (unsigned long long)cls);
  yk_string *nm = str(name), *k = new_string(nm->len + (uint32_t)len);
  memcpy(k->units, nm->units, (size_t)nm->len * 2);
  for (int j = 0; j < len; j++) k->units[nm->len + (uint32_t)j] = (uint16_t)suffix[j];
  c->priv_names = realloc(c->priv_names, (c->npriv + 1) * sizeof(yk));
  c->priv_keys = realloc(c->priv_keys, (c->npriv + 1) * sizeof(yk));
  if (c->priv_names == NULL || c->priv_keys == NULL) abort();
  c->priv_names[c->npriv] = name;
  c->priv_keys[c->npriv] = string_of(k);
  return c->priv_keys[c->npriv++];
}
yk yk_class_new(void *creator, yk parent, uint64_t n, const yk *kinds, const yk *names,
                const yk *statics, const yk *members) {
  if (parent != 0 && !is_closure(parent))
    type_error("Class extends value is not a constructor or null");
  if (parent != 0 && !is_error_constructor(parent)) {
    yk_closure *p = (yk_closure *)PTR(parent);
    if (!p->is_class && !p->has_this) type_error("extending this constructor is not in the runtime yet");
  }
  yk cls = 0;
  for (uint64_t i = 0; i < n; i++)
    if (((int)num(kinds[i]) & 7) == 0) cls = members[i];
  if (cls == 0)
    cls = yk_closure_new(parent != 0 ? default_derived_constructor : default_constructor, 1, 0, NULL);
  yk_closure *c = (yk_closure *)PTR(cls);
  c->is_class = 1;
  c->has_this = 1;
  c->parent = parent;
  c->outer = creator == NULL ? 0 : ((yk_closure *)creator)->class_self;
  /* Its private names first: every member's code may use any of them. A member's kind is 8 more
     when its name is private (a computed key is a value, never a private name). */
  for (uint64_t i = 0; i < n; i++)
    if (num(kinds[i]) >= 8) private_key_of(c, cls, names[i]);
  yk proto = ensure_prototype(cls);
  if (parent != 0 && !is_error_constructor(parent))
    ((yk_object *)PTR(proto))->proto = ensure_prototype(parent);
  for (uint64_t i = 0; i < n; i++) {
    int kind = (int)num(kinds[i]) & 7;
    ((yk_closure *)PTR(members[i]))->class_self = cls;
    ((yk_closure *)PTR(members[i]))->home_static =
        kind != 0 && (statics[i] == YK_TRUE || kind == 5);
    if (kind == 0 || kind == 5) continue;
    int private = num(kinds[i]) >= 8;
    yk key = private ? private_key_of(c, cls, names[i]) : 0;
    if (kind == 4) {
      if (statics[i] == YK_TRUE) continue;
      /* An instance field: kept, in order, for each instance. */
      add_field(c, private ? 1 : 0, private ? key : to_string(names[i]), members[i]);
      continue;
    }
    if (private) {
      /* A private method or accessor: each instance's, or the class's own when static. */
      int pkind = kind == 1 ? 2 : kind == 2 ? 3 : 4;
      if (statics[i] == YK_TRUE) define_private(cls, pkind, key, members[i]);
      else add_field(c, (uint8_t)pkind, key, members[i]);
      continue;
    }
    yk_object *target = statics[i] == YK_TRUE ? own_props(cls) : (yk_object *)PTR(proto);
    yk name = to_string(names[i]);
    if (kind == 1) own_set(target, name, members[i]);
    else define_accessor(target, name, kind == 2 ? members[i] : 0, kind == 3 ? members[i] : 0);
  }
  c->class_self = cls;
  /* The static fields and blocks run now, in order, with the class as their receiver. */
  for (uint64_t i = 0; i < n; i++) {
    int kind = (int)num(kinds[i]) & 7;
    if (!(kind == 5 || (kind == 4 && statics[i] == YK_TRUE))) continue;
    yk_closure *m = (yk_closure *)PTR(members[i]);
    yk v = m->code(m, cls, 0, NULL);
    if (kind == 4 && num(kinds[i]) >= 8) define_private(cls, 1, private_key_of(c, cls, names[i]), v);
    else if (kind == 4) own_set(own_props(cls), to_string(names[i]), v);
  }
  return cls;
}
yk yk_closure_class(void *closure) {
  yk cls = ((yk_closure *)closure)->class_self;
  return cls == 0 ? YK_UNDEFINED : cls;
}
/* A closure made inside a class's member knows the class too. */
yk yk_closure_inherit(yk child, void *parent) {
  ((yk_closure *)PTR(child))->class_self = ((yk_closure *)parent)->class_self;
  ((yk_closure *)PTR(child))->home_static = ((yk_closure *)parent)->home_static;
  return child;
}

/* delete obj[key]: an own property removed; an array element becomes undefined. */
yk yk_delete(yk obj, yk key) {
  if (is_nullish(obj)) type_error("Cannot convert undefined or null to object");
  if (is_object(obj) || is_closure(obj)) {
    if (is_closure(obj) && ((yk_closure *)PTR(obj))->props == 0) return YK_TRUE;
    yk_object *o = own_props(obj);
    yk k = to_string(key);
    for (uint32_t i = 0; i < o->len; i++)
      if (string_equal(str(o->keys[i]), str(k))) {
        memmove(o->keys + i, o->keys + i + 1, (size_t)(o->len - i - 1) * sizeof(yk));
        memmove(o->values + i, o->values + i + 1, (size_t)(o->len - i - 1) * sizeof(yk));
        o->len--;
        break;
      }
  } else if (is_array(obj)) {
    int64_t i = index_of_key(key);
    if (i >= 0 && i < arr(obj)->len) arr(obj)->items[i] = YK_UNDEFINED;
  }
  return YK_TRUE;
}
yk yk_delete_named(yk obj, const char *name, uint64_t n) { return yk_delete(obj, yk_string_utf8(name, n)); }

/* An object literal: its keys (by ToPropertyKey) and values, in source order. */
yk yk_object_of(uint64_t n, const yk *keys, const yk *values) {
  yk_object *o = alloc(sizeof(yk_object));
  o->len = o->cap = 0;
  o->error = 0;
  o->kind = 0;
  o->proto = 0;
  o->regex = NULL;
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
    /* A program's uncaught exception exits 1, as Node's; the test harnesses see 70. */
    fflush(stdout);
    exit(program_mode ? 1 : 70);
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
  if (is_object(obj) && ((yk_object *)PTR(obj))->kind == 7 && buffer_set(obj, key, value)) return obj;
  if (is_object(obj) || is_closure(obj)) {
    yk k = to_string(key), slot;
    /* A setter along the chain is called; otherwise the property is the object's own. */
    if (chain_get(obj, k, &slot) && is_accessor(slot)) {
      yk setter = ((yk_accessor *)PTR(slot))->set;
      if (setter == 0) type_error("Cannot set a property that has only a getter");
      call_value(setter, obj, 1, &value);
      return obj;
    }
    own_set(own_props(obj), k, value);
    return obj;
  }
  if (is_array(obj)) {
    yk_array *a = arr(obj);
    int64_t i = index_of_key(key);
    if (i < 0) {
      if (key_is(to_string(key), "length")) {
        double n = to_number(value);
        if (n < 0 || n != floor(n) || n > 4294967295.0) yk_throw(make_error("RangeError", ascii("Invalid array length")));
        while (a->len < n) push(a, YK_UNDEFINED);
        a->len = (uint32_t)n;
        return obj;
      }
      if (a->props == 0) a->props = yk_object_of(0, NULL, NULL);
      own_set((yk_object *)PTR(a->props), to_string(key), value);
      return obj;
    }
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
  int32_t internal; /* 1: an iterator */
  yk src;
  uint32_t i;
  yk_array *keys; /* for…in: the keys, taken when the loop starts */
  yk gen;         /* for…of over a generator: the generator, or 0 */
} yk_iter;

yk yk_iter_new(yk v, int32_t keys) {
  yk_iter *it = alloc(sizeof(yk_iter));
  it->internal = 1;
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
  } else if (is_object(v) && ((yk_object *)PTR(v))->kind == 5) {
    it->gen = v; /* a generator: drawn from one next() at a time */
  } else if (is_object(v) && ((yk_object *)PTR(v))->kind != 0) {
    it->src = BOX(T_ARRAY, iterable_items(v));
  } else if (!is_array(v) && !is_string(v))
    type_error("the value is not iterable here");
  return BOX(T_INTERNAL, it);
}

int yk_iter_next(yk itv, yk *out) {
  yk_iter *it = (yk_iter *)PTR(itv);
  if (it->gen != 0) return generator_step(it->gen, out);
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
  c->is_class = 0;
  c->props = 0;
  c->class_self = 0;
  c->parent = 0;
  c->home_static = 0;
  c->mode = 0;
  c->n = (uint32_t)n;
  memcpy(c->captures, captures, (size_t)n * sizeof(yk));
  return BOX(T_CLOSURE, c);
}
yk yk_closure_self(void *closure) { return BOX(T_CLOSURE, closure); }
yk yk_capture(void *closure, uint64_t i) { return ((yk_closure *)closure)->captures[i]; }
yk yk_arg(uint64_t argc, const yk *argv, uint64_t i) { return i < argc ? argv[i] : YK_UNDEFINED; }
/* A rest parameter (...xs): the arguments from i on, as an array. */
yk yk_rest(uint64_t argc, const yk *argv, uint64_t i) { return yk_array_of(i < argc ? argc - i : 0, argv + (i < argc ? i : argc)); }

static yk call_value(yk f, yk self, uint64_t argc, const yk *argv) {
  if (!is_closure(f)) type_error("not a function");
  yk_closure *c = (yk_closure *)PTR(f);
  if (c->is_class) type_error("Class constructor cannot be invoked without 'new'");
  if (c->mode == 1) return async_call(c, self, argc, argv);
  if (c->mode == 2) return generator_new(c, self, argc, argv);
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

yk yk_bitor(yk a, yk b) { return numeric_pair(&a, &b) ? big_binary(a, b, '|') : yk_number(to_int32(a) | to_int32(b)); }
yk yk_bitand(yk a, yk b) { return numeric_pair(&a, &b) ? big_binary(a, b, '&') : yk_number(to_int32(a) & to_int32(b)); }
yk yk_bitxor(yk a, yk b) { return numeric_pair(&a, &b) ? big_binary(a, b, '^') : yk_number(to_int32(a) ^ to_int32(b)); }
yk yk_shl(yk a, yk b) {
  if (numeric_pair(&a, &b)) return big_binary(a, b, '<');
  return yk_number((int32_t)((uint32_t)to_int32(a) << (to_uint32(b) & 31)));
}
yk yk_shr(yk a, yk b) {
  if (numeric_pair(&a, &b)) return big_binary(a, b, '>');
  return yk_number(to_int32(a) >> (to_uint32(b) & 31));
}
yk yk_ushr(yk a, yk b) {
  if (numeric_pair(&a, &b)) type_error("BigInts have no unsigned right shift, use >> instead");
  return yk_number(to_uint32(a) >> (to_uint32(b) & 31));
}
yk yk_bitnot(yk a) {
  a = to_primitive(a);
  return is_bigint(a) ? big_add_small(big_negate(a), -1) : yk_number(~to_int32(a));
}

/* --- BigInt (ECMA-262 6.1.6.2), and the fixed-width and float64-bits leaves --------------------
 *
 * A BigInt is a sign and a magnitude of 32-bit limbs, least significant first, with no zero limb
 * at the top (zero has none, and is never negative). Every operation is exact, as ECMAScript's:
 * arbitrary precision, division truncating, `>>` flooring, the bitwise operators on the infinite
 * two's complement. The leaves of DEC-DUC-OPERATIONS-AS-ATOMS-001 that C's fixed-width integers
 * and a float64's bits are raised to are defined here as their JavaScript definitions
 * (`raise-c.ts`'s C_LEAVES_JS) define them.
 */

static void range_error(const char *what) { yk_throw(make_error("RangeError", ascii(what))); }

static yk_bigint *big_new(uint32_t len) {
  yk_bigint *b = alloc(sizeof(yk_bigint) + (size_t)len * 4);
  b->neg = 0;
  b->len = len;
  return b;
}
/* Its top zero limbs dropped, and a zero's sign cleared: the normal form. */
static yk big_box(yk_bigint *b) {
  while (b->len > 0 && b->d[b->len - 1] == 0) b->len--;
  if (b->len == 0) b->neg = 0;
  return BOX(T_BIGINT, b);
}
static yk_bigint *big(yk v) { return (yk_bigint *)PTR(v); }

static yk big_from_u64(uint64_t m, int neg) {
  yk_bigint *b = big_new(2);
  b->d[0] = (uint32_t)m;
  b->d[1] = (uint32_t)(m >> 32);
  b->neg = neg;
  return big_box(b);
}
static yk big_from_i64(int64_t x) {
  return x < 0 ? big_from_u64((uint64_t)0 - (uint64_t)x, 1) : big_from_u64((uint64_t)x, 0);
}

/* |a| compared with |b|: -1, 0 or 1. */
static int mag_cmp(const yk_bigint *a, const yk_bigint *b) {
  if (a->len != b->len) return a->len < b->len ? -1 : 1;
  for (uint32_t i = a->len; i-- > 0;)
    if (a->d[i] != b->d[i]) return a->d[i] < b->d[i] ? -1 : 1;
  return 0;
}
static yk_bigint *mag_add(const yk_bigint *a, const yk_bigint *b) {
  uint32_t n = (a->len > b->len ? a->len : b->len) + 1;
  yk_bigint *r = big_new(n);
  uint64_t carry = 0;
  for (uint32_t i = 0; i < n; i++) {
    uint64_t t = carry + (i < a->len ? a->d[i] : 0) + (i < b->len ? b->d[i] : 0);
    r->d[i] = (uint32_t)t;
    carry = t >> 32;
  }
  return r;
}
/* |a| - |b|, for |a| >= |b|. */
static yk_bigint *mag_sub(const yk_bigint *a, const yk_bigint *b) {
  yk_bigint *r = big_new(a->len);
  int64_t borrow = 0;
  for (uint32_t i = 0; i < a->len; i++) {
    int64_t t = (int64_t)a->d[i] - (i < b->len ? b->d[i] : 0) - borrow;
    borrow = t < 0;
    r->d[i] = (uint32_t)(t + (borrow ? ((int64_t)1 << 32) : 0));
  }
  return r;
}
/* a + b with signs: the magnitudes added or subtracted. */
static yk big_add_signed(const yk_bigint *a, int aneg, const yk_bigint *b, int bneg) {
  yk_bigint *r;
  if (aneg == bneg) {
    r = mag_add(a, b);
    r->neg = aneg;
  } else if (mag_cmp(a, b) >= 0) {
    r = mag_sub(a, b);
    r->neg = aneg;
  } else {
    r = mag_sub(b, a);
    r->neg = bneg;
  }
  return big_box(r);
}
static yk big_mul(const yk_bigint *a, const yk_bigint *b) {
  yk_bigint *r = big_new(a->len + b->len);
  memset(r->d, 0, (size_t)r->len * 4);
  for (uint32_t i = 0; i < a->len; i++) {
    uint64_t carry = 0;
    for (uint32_t j = 0; j < b->len; j++) {
      uint64_t t = (uint64_t)a->d[i] * b->d[j] + r->d[i + j] + carry;
      r->d[i + j] = (uint32_t)t;
      carry = t >> 32;
    }
    for (uint32_t k = i + b->len; carry != 0; k++) {
      uint64_t t = (uint64_t)r->d[k] + carry;
      r->d[k] = (uint32_t)t;
      carry = t >> 32;
    }
  }
  r->neg = a->neg != b->neg;
  return big_box(r);
}
static uint64_t mag_bitlen(const yk_bigint *a) {
  if (a->len == 0) return 0;
  uint32_t top = a->d[a->len - 1];
  int bits = 0;
  while (top != 0) bits++, top >>= 1;
  return (uint64_t)(a->len - 1) * 32 + bits;
}
static int mag_bit(const yk_bigint *a, uint64_t i) {
  uint64_t limb = i / 32;
  return limb < a->len ? (a->d[limb] >> (i % 32)) & 1 : 0;
}
/* |a| / |b| and |a| % |b| (b nonzero), by shifting and subtracting. */
static void mag_divmod(const yk_bigint *a, const yk_bigint *b, yk_bigint **q, yk_bigint **r) {
  yk_bigint *quo = big_new(a->len);
  memset(quo->d, 0, (size_t)quo->len * 4);
  yk_bigint *rem = big_new(b->len + 1);
  memset(rem->d, 0, (size_t)rem->len * 4);
  rem->len = 0;
  for (uint64_t i = mag_bitlen(a); i-- > 0;) {
    /* rem = rem * 2 + bit i of a */
    uint32_t carry = (uint32_t)mag_bit(a, i);
    for (uint32_t k = 0; k < rem->len; k++) {
      uint32_t next = rem->d[k] >> 31;
      rem->d[k] = (rem->d[k] << 1) | carry;
      carry = next;
    }
    if (carry) rem->d[rem->len++] = carry;
    if (mag_cmp(rem, b) >= 0) {
      yk_bigint *t = mag_sub(rem, b);
      while (t->len > 0 && t->d[t->len - 1] == 0) t->len--;
      memcpy(rem->d, t->d, (size_t)t->len * 4);
      rem->len = t->len;
      quo->d[i / 32] |= 1u << (i % 32);
    }
  }
  *q = quo;
  *r = rem;
}

/* The infinite two's complement of a, in n limbs (n past its magnitude: the sign extends). */
static void twos(const yk_bigint *a, uint32_t *out, uint32_t n) {
  for (uint32_t i = 0; i < n; i++) out[i] = i < a->len ? a->d[i] : 0;
  if (!a->neg) return;
  uint64_t carry = 1;
  for (uint32_t i = 0; i < n; i++) {
    uint64_t t = (uint64_t)(uint32_t)~out[i] + carry;
    out[i] = (uint32_t)t;
    carry = t >> 32;
  }
}
/* A two's complement of n limbs (its top limb's top bit the sign) as a BigInt. */
static yk from_twos(const uint32_t *in, uint32_t n) {
  yk_bigint *r = big_new(n);
  int neg = n > 0 && (in[n - 1] >> 31);
  memcpy(r->d, in, (size_t)n * 4);
  if (neg) {
    uint64_t carry = 1;
    for (uint32_t i = 0; i < n; i++) {
      uint64_t t = (uint64_t)(uint32_t)~r->d[i] + carry;
      r->d[i] = (uint32_t)t;
      carry = t >> 32;
    }
  }
  r->neg = neg;
  return big_box(r);
}
static yk big_bitwise(const yk_bigint *a, const yk_bigint *b, char op) {
  uint32_t n = (a->len > b->len ? a->len : b->len) + 1;
  uint32_t *x = alloc((size_t)n * 4), *y = alloc((size_t)n * 4);
  twos(a, x, n);
  twos(b, y, n);
  for (uint32_t i = 0; i < n; i++) x[i] = op == '&' ? x[i] & y[i] : op == '|' ? x[i] | y[i] : x[i] ^ y[i];
  return from_twos(x, n);
}

/* a * 2^k (k >= 0). */
static yk big_shl_mag(const yk_bigint *a, int neg, uint64_t k) {
  if (a->len == 0) return big_from_u64(0, 0);
  if (k > (uint64_t)1 << 30) range_error("Maximum BigInt size exceeded");
  uint32_t words = (uint32_t)(k / 32), bits = (uint32_t)(k % 32);
  yk_bigint *r = big_new(a->len + words + 1);
  memset(r->d, 0, (size_t)r->len * 4);
  for (uint32_t i = 0; i < a->len; i++) {
    uint64_t t = (uint64_t)a->d[i] << bits;
    r->d[i + words] |= (uint32_t)t;
    r->d[i + words + 1] |= (uint32_t)(t >> 32);
  }
  r->neg = neg;
  return big_box(r);
}
/* floor(a / 2^k) (k >= 0). */
static yk big_sar(const yk_bigint *a, uint64_t k) {
  if (!a->neg) {
    uint64_t words = k / 32;
    uint32_t bits = (uint32_t)(k % 32);
    if (words >= a->len) return big_from_u64(0, 0);
    yk_bigint *r = big_new(a->len - (uint32_t)words);
    for (uint32_t i = 0; i < r->len; i++) {
      uint64_t lo = a->d[i + words];
      uint64_t hi = i + words + 1 < a->len ? a->d[i + words + 1] : 0;
      r->d[i] = (uint32_t)(((hi << 32) | lo) >> bits);
    }
    return big_box(r);
  }
  /* A negative's: -(((|a| - 1) >> k) + 1). */
  yk_bigint *one_p = big_new(1);
  one_p->d[0] = 1;
  yk_bigint *m = mag_sub(a, one_p);
  m->neg = 0;
  yk s = big_sar(big(big_box(m)), k);
  yk_bigint *r = mag_add(big(s), one_p);
  r->neg = 1;
  return big_box(r);
}
static int64_t shift_count(const yk_bigint *b) {
  if (b->len > 1 || (b->len == 1 && b->d[0] > (1u << 30))) return b->neg ? INT64_MIN : INT64_MAX;
  int64_t k = b->len == 0 ? 0 : b->d[0];
  return b->neg ? -k : k;
}
static yk big_shift(const yk_bigint *a, const yk_bigint *b, int left) {
  int64_t k = shift_count(b);
  if (!left) k = k == INT64_MIN ? INT64_MAX : -k;
  if (k >= 0) return big_shl_mag(a, a->neg, (uint64_t)k);
  return big_sar(a, k == INT64_MIN ? (uint64_t)INT64_MAX : (uint64_t)(-k));
}

/* The low 64 bits of a's two's complement: BigInt.asUintN(64, a). */
static uint64_t big_low64(const yk_bigint *a) {
  uint32_t w[2];
  twos(a, w, 2);
  return ((uint64_t)w[1] << 32) | w[0];
}

/* Number(a): the nearest double, ties to even. */
static double big_to_double(const yk_bigint *a) {
  uint64_t L = mag_bitlen(a);
  double r;
  if (L <= 64) {
    uint64_t m = a->len == 0 ? 0 : a->len == 1 ? a->d[0] : ((uint64_t)a->d[1] << 32) | a->d[0];
    r = (double)m;
  } else {
    /* The top 64 bits, with every lower bit folded into the last (a sticky bit). */
    uint64_t t = 0;
    for (uint64_t i = 0; i < 64; i++) t |= (uint64_t)mag_bit(a, L - 64 + i) << i;
    for (uint64_t i = 0; i < L - 64; i++)
      if (mag_bit(a, i)) {
        t |= 1;
        break;
      }
    r = ldexp((double)t, (int)(L - 64 > 2000 ? 2000 : L - 64));
  }
  return a->neg ? -r : r;
}

/* BigInt(x) for a number: a RangeError unless it is an integer. */
static yk big_from_double(double x) {
  if (x != x || isinf(x) || trunc(x) != x) {
    yk s = number_to_string(x);
    yk msg = concat(str(concat(str(ascii("The number ")), str(s))),
                    str(ascii(" cannot be converted to a BigInt because it is not an integer")));
    yk_throw(make_error("RangeError", msg));
  }
  int neg = x < 0;
  double m = fabs(x);
  if (m < 18446744073709551616.0) return big_from_u64((uint64_t)m, neg);
  int e;
  double f = frexp(m, &e); /* m = f * 2^e, f in [0.5, 1) */
  uint64_t mant = (uint64_t)ldexp(f, 53);
  yk_bigint *b = big(big_from_u64(mant, 0));
  return big_shl_mag(b, neg, (uint64_t)(e - 53));
}

/* The BigInt's decimal digits. */
static yk big_to_string(const yk_bigint *a) {
  if (a->len == 0) return ascii("0");
  uint32_t n = a->len;
  uint32_t *w = alloc((size_t)n * 4);
  memcpy(w, a->d, (size_t)n * 4);
  size_t cap = (size_t)n * 10 + 2, k = 0;
  char *digits = alloc(cap);
  while (n > 0) {
    uint64_t rem = 0;
    for (uint32_t i = n; i-- > 0;) {
      uint64_t cur = (rem << 32) | w[i];
      w[i] = (uint32_t)(cur / 1000000000u);
      rem = cur % 1000000000u;
    }
    while (n > 0 && w[n - 1] == 0) n--;
    for (int j = 0; j < 9 && (n > 0 || rem > 0); j++) {
      digits[k++] = (char)('0' + rem % 10);
      rem /= 10;
    }
  }
  char *out = alloc(k + 2);
  size_t o = 0;
  if (a->neg) out[o++] = '-';
  while (k > 0) out[o++] = digits[--k];
  out[o] = 0;
  return ascii(out);
}

/* StringToBigInt over UTF-16 units: undefined (0) when the string is not one. */
static yk big_from_units(const uint16_t *u, uint32_t len, int literal) {
  uint32_t a = 0, b = len;
  if (!literal) {
    while (a < b && is_space(u[a])) a++;
    while (b > a && is_space(u[b - 1])) b--;
    if (a == b) return big_from_u64(0, 0);
  }
  int neg = 0, radix = 10;
  if (b - a >= 2 && u[a] == '0' && (u[a + 1] | 32) == 'x') radix = 16, a += 2;
  else if (b - a >= 2 && u[a] == '0' && (u[a + 1] | 32) == 'o') radix = 8, a += 2;
  else if (b - a >= 2 && u[a] == '0' && (u[a + 1] | 32) == 'b') radix = 2, a += 2;
  else if (!literal && (u[a] == '+' || u[a] == '-')) neg = u[a] == '-', a++;
  if (a == b) return 0;
  yk_bigint *r = big_new((b - a) / 2 + 2);
  memset(r->d, 0, (size_t)r->len * 4);
  for (uint32_t i = a; i < b; i++) {
    uint16_t c = u[i];
    if (literal && c == '_') continue;
    int d = c >= '0' && c <= '9' ? c - '0' : (c | 32) >= 'a' && (c | 32) <= 'z' ? (c | 32) - 'a' + 10 : 99;
    if (d >= radix) return 0;
    uint64_t carry = (uint64_t)d;
    for (uint32_t k = 0; k < r->len; k++) {
      uint64_t t = (uint64_t)r->d[k] * radix + carry;
      r->d[k] = (uint32_t)t;
      carry = t >> 32;
    }
  }
  r->neg = neg;
  return big_box(r);
}
/* A BigInt literal's value (the n dropped): its digits, as the lowering writes them. */
yk yk_bigint_literal(const char *p, uint64_t n) {
  uint16_t *u = alloc((size_t)n * 2 + 2);
  for (uint64_t i = 0; i < n; i++) u[i] = (uint8_t)p[i];
  yk v = big_from_units(u, (uint32_t)n, 1);
  if (v == 0) type_error("not a BigInt literal");
  return v;
}

/* a compared with a number: -1, 0 or 1; 2 when the number is NaN. */
static int big_cmp_double(const yk_bigint *a, double y) {
  if (y != y) return 2;
  if (isinf(y)) return y > 0 ? -1 : 1;
  double fy = floor(y);
  yk b = big_from_double(fy);
  yk_bigint *bb = big(b);
  int c;
  if (a->neg != bb->neg) c = a->neg ? -1 : 1;
  else {
    c = mag_cmp(a, bb);
    if (a->neg) c = -c;
  }
  if (c != 0) return c;
  return fy < y ? -1 : 0; /* a == floor(y): below y if y has a fraction */
}
static int big_cmp(const yk_bigint *a, const yk_bigint *b) {
  if (a->neg != b->neg) return a->neg ? -1 : 1;
  int c = mag_cmp(a, b);
  return a->neg ? -c : c;
}

static void mix_error(void) { type_error("Cannot mix BigInt and other types, use explicit conversions"); }

/* An arithmetic or bitwise operator of two BigInts. */
static yk big_binary(yk a, yk b, char op) {
  yk_bigint *x = big(a), *y = big(b);
  switch (op) {
  case '+':
    return big_add_signed(x, x->neg, y, y->neg);
  case '-':
    return big_add_signed(x, x->neg, y, !y->neg && y->len > 0);
  case '*':
    return big_mul(x, y);
  case '/':
  case '%': {
    if (y->len == 0) range_error("Division by zero");
    yk_bigint *q, *r;
    mag_divmod(x, y, &q, &r);
    if (op == '/') {
      q->neg = x->neg != y->neg;
      return big_box(q);
    }
    r->neg = x->neg;
    return big_box(r);
  }
  case '&':
  case '|':
  case '^':
    return big_bitwise(x, y, op);
  case '<':
    return big_shift(x, y, 1);
  case '>':
    return big_shift(x, y, 0);
  }
  return YK_UNDEFINED;
}
/* The operands as numbers or BigInts: 1 when both are BigInts, 0 when neither, else a TypeError. */
static int numeric_pair(yk *a, yk *b) {
  *a = to_primitive(*a);
  *b = to_primitive(*b);
  int x = is_bigint(*a), y = is_bigint(*b);
  if (x && y) return 1;
  if (x || y) mix_error();
  return 0;
}

/* --- the leaves --- */

yk yk_leaf_i32mul(yk a, yk b) { return yk_number((int32_t)((uint32_t)to_int32(a) * (uint32_t)to_int32(b))); }
static yk_bigint *want_big(yk v) {
  if (!is_bigint(v)) type_error("Cannot convert to a BigInt");
  return big(v);
}
yk yk_leaf_u64(yk x) { return big_from_u64(big_low64(want_big(x)), 0); }
yk yk_leaf_i64(yk x) { return big_from_i64((int64_t)big_low64(want_big(x))); }
yk yk_leaf_num_to_big(yk x) {
  if (is_bigint(x)) return x;
  return big_from_double(to_number(x));
}
yk yk_leaf_big_to_i32(yk x) { return yk_number((int32_t)(uint32_t)big_low64(want_big(x))); }
yk yk_leaf_big_to_u32(yk x) { return yk_number((uint32_t)big_low64(want_big(x))); }
yk yk_leaf_big_to_f64(yk x) { return yk_number(big_to_double(want_big(x))); }
yk yk_leaf_f64_to_i64(yk x) {
  yk b = big_from_double(trunc(to_number(x)));
  return big_from_i64((int64_t)big_low64(big(b)));
}
yk yk_leaf_f64_bits(yk x) {
  double d = to_number(x);
  uint64_t u;
  memcpy(&u, &d, 8);
  return big_from_u64(u, 0);
}
yk yk_leaf_f64_from_bits(yk x) {
  uint64_t u = big_low64(want_big(x));
  double d;
  memcpy(&d, &u, 8);
  return yk_number(d);
}
yk yk_leaf_f64_hi(yk x) {
  double d = to_number(x);
  uint64_t u;
  memcpy(&u, &d, 8);
  return yk_number((double)(uint32_t)(u >> 32));
}
yk yk_leaf_f64_lo(yk x) {
  double d = to_number(x);
  uint64_t u;
  memcpy(&u, &d, 8);
  return yk_number((double)(uint32_t)u);
}
yk yk_leaf_f64_make(yk hi, yk lo) {
  uint64_t u = ((uint64_t)to_uint32(hi) << 32) | to_uint32(lo);
  double d;
  memcpy(&d, &u, 8);
  return yk_number(d);
}

static yk big_to_string_v(yk v) { return big_to_string(big(v)); }
static double big_to_double_v(yk v) { return big_to_double(big(v)); }
static int big_cmp_v(yk a, yk b) { return big_cmp(big(a), big(b)); }
static int big_cmp_double_v(yk a, double y) { return big_cmp_double(big(a), y); }
static yk big_from_string_v(yk s) { return big_from_units(str(s)->units, str(s)->len, 0); }
static yk big_negate(yk a) {
  yk_bigint *x = big(a), *r = big_new(x->len);
  memcpy(r->d, x->d, (size_t)x->len * 4);
  r->neg = !x->neg;
  return big_box(r);
}
static yk big_add_small(yk a, int64_t k) { return big_binary(a, big_from_i64(k), '+'); }

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
static yk_array *typed_items_v(yk v);
static yk_array *iterable_items(yk v) {
  if (is_object(v) && ((yk_object *)PTR(v))->kind == 7) return typed_items_v(v);
  yk_array *r = new_array(4);
  if (is_object(v) && ((yk_object *)PTR(v))->kind == 5) {
    yk e;
    while (generator_step(v, &e)) push(r, e);
    return r;
  }
  if (is_object(v) && (((yk_object *)PTR(v))->kind == 1 || ((yk_object *)PTR(v))->kind == 2)) {
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
      value = resolve_slot(value, v);
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
  if (is_array(v) || is_string(v) ||
      (is_object(v) && ((yk_object *)PTR(v))->kind != 0 && ((yk_object *)PTR(v))->kind != 3 &&
       ((yk_object *)PTR(v))->kind != 4))
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
      value = resolve_slot(value, v);
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

/* --- RegExp: a matcher compiled from the literal (regex.ts), driven as ECMAScript drives one --- */

static int is_regexp(yk v) { return is_object(v) && ((yk_object *)PTR(v))->kind == 3; }

/* A regex literal's object: source, flags, the matcher (s, start, sticky) → indexes or null, names. */
yk yk_regexp_new(yk source, yk flags, yk matcher, yk names) {
  yk key = ascii("lastIndex"), zero = yk_number(0);
  yk v = yk_object_of(1, &key, &zero);
  yk_object *o = (yk_object *)PTR(v);
  o->kind = 3;
  o->regex = alloc(4 * sizeof(yk));
  o->regex[0] = source;
  o->regex[1] = flags;
  o->regex[2] = matcher;
  o->regex[3] = names;
  return v;
}

static int has_flag(yk re, char f) {
  yk_string *fl = str(((yk_object *)PTR(re))->regex[1]);
  for (uint32_t i = 0; i < fl->len; i++)
    if (fl->units[i] == (uint16_t)f) return 1;
  return 0;
}

static yk substring(yk_string *s, uint32_t a, uint32_t b) {
  yk_string *r = new_string(b > a ? b - a : 0);
  if (b > a) memcpy(r->units, s->units + a, (size_t)(b - a) * 2);
  return string_of(r);
}

/* The matcher at `start` (only there when sticky): the indexes array, or null. */
static yk run_matcher(yk re, yk s, uint32_t start, int sticky) {
  yk args[3] = {s, yk_number(start), yk_bool(sticky)};
  return call_value(((yk_object *)PTR(re))->regex[2], YK_UNDEFINED, 3, args);
}

/* The match array exec gives: the matched text and the groups, with index, input, groups. */
static yk match_array(yk re, yk s, yk idx) {
  yk_array *ix = arr(idx);
  yk_array *r = new_array(ix->len / 2);
  for (uint32_t g = 0; g < ix->len / 2; g++) {
    double a = num(ix->items[2 * g]), b = num(ix->items[2 * g + 1]);
    push(r, a < 0 ? YK_UNDEFINED : substring(str(s), (uint32_t)a, (uint32_t)b));
  }
  yk v = BOX(T_ARRAY, r);
  yk_set(v, ascii("index"), ix->items[0]);
  yk_set(v, ascii("input"), s);
  yk names = ((yk_object *)PTR(re))->regex[3];
  yk groups = YK_UNDEFINED;
  for (uint32_t g = 0; g < arr(names)->len; g++)
    if (arr(names)->items[g] != YK_UNDEFINED) {
      if (groups == YK_UNDEFINED) groups = yk_object_of(0, NULL, NULL);
      yk_set(groups, arr(names)->items[g], r->items[g + 1]);
    }
  yk_set(v, ascii("groups"), groups);
  return v;
}

/* RegExpBuiltinExec. */
static yk regexp_exec(yk re, yk s) {
  s = to_string(s);
  int global = has_flag(re, 'g'), sticky = has_flag(re, 'y');
  uint32_t start = 0;
  if (global || sticky) {
    double li = to_number(yk_get(re, ascii("lastIndex")));
    li = li != li || li < 0 ? 0 : trunc(li);
    if (li > str(s)->len) {
      yk_set(re, ascii("lastIndex"), yk_number(0));
      return YK_NULL;
    }
    start = (uint32_t)li;
  }
  yk idx = run_matcher(re, s, start, sticky);
  if (idx == YK_NULL) {
    if (global || sticky) yk_set(re, ascii("lastIndex"), yk_number(0));
    return YK_NULL;
  }
  if (global || sticky) yk_set(re, ascii("lastIndex"), arr(idx)->items[1]);
  return match_array(re, s, idx);
}

/* The index after i, by code point when the regex is unicode. */
static uint32_t advance(yk_string *s, uint32_t i, int unicode) {
  if (unicode && i + 1 < s->len && s->units[i] >= 0xD800 && s->units[i] <= 0xDBFF && s->units[i + 1] >= 0xDC00 &&
      s->units[i + 1] <= 0xDFFF)
    return i + 2;
  return i + 1;
}

/* GetSubstitution: $$, $&, $`, $', $n, $nn, $<name> in a replacement string. */
static yk substitute(yk_string *rep, yk m) {
  yk_array *caps = arr(m);
  yk_string *input = str(yk_get(m, ascii("input")));
  uint32_t pos = (uint32_t)num(yk_get(m, ascii("index")));
  yk_string *matched = str(caps->items[0]);
  yk groups = yk_get(m, ascii("groups"));
  yk out = ascii("");
  for (uint32_t i = 0; i < rep->len; i++) {
    uint16_t c = rep->units[i];
    if (c != '$' || i + 1 >= rep->len) {
      yk_string *one = new_string(1);
      one->units[0] = c;
      out = concat(str(out), one);
      continue;
    }
    uint16_t d = rep->units[i + 1];
    if (d == '$') out = concat(str(out), str(ascii("$"))), i++;
    else if (d == '&') out = concat(str(out), matched), i++;
    else if (d == '`') out = concat(str(out), str(substring(input, 0, pos))), i++;
    else if (d == '\'') out = concat(str(out), str(substring(input, pos + matched->len, input->len))), i++;
    else if (d >= '0' && d <= '9') {
      uint32_t n = d - '0', used = 1;
      if (i + 2 < rep->len && rep->units[i + 2] >= '0' && rep->units[i + 2] <= '9') {
        uint32_t nn = n * 10 + (rep->units[i + 2] - '0');
        if (nn >= 1 && nn < caps->len) n = nn, used = 2;
      }
      if (n >= 1 && n < caps->len) {
        if (caps->items[n] != YK_UNDEFINED) out = concat(str(out), str(caps->items[n]));
        i += used;
      } else
        out = concat(str(out), str(ascii("$")));
    } else if (d == '<' && groups != YK_UNDEFINED) {
      uint32_t close = i + 2;
      while (close < rep->len && rep->units[close] != '>') close++;
      if (close >= rep->len) {
        out = concat(str(out), str(ascii("$")));
        continue;
      }
      yk v = yk_get(groups, substring(rep, i + 2, close));
      if (v != YK_UNDEFINED) out = concat(str(out), str(to_string(v)));
      i = close;
    } else
      out = concat(str(out), str(ascii("$")));
  }
  return out;
}

/* The replacement for one match: a function's result, or the substituted string. */
static yk replacement(yk repl, yk m) {
  if (!is_closure(repl)) return substitute(str(to_string(repl)), m);
  yk_array *caps = arr(m);
  yk groups = yk_get(m, ascii("groups"));
  yk_array *args = new_array(caps->len + 3);
  for (uint32_t i = 0; i < caps->len; i++) push(args, caps->items[i]);
  push(args, yk_get(m, ascii("index")));
  push(args, yk_get(m, ascii("input")));
  if (groups != YK_UNDEFINED) push(args, groups);
  return to_string(call_value(repl, YK_UNDEFINED, args->len, args->items));
}

/* A match of a plain string at a position, as an exec result (for replace with a string pattern). */
static yk string_match(yk s, yk_string *pat, uint32_t at) {
  yk_array *r = new_array(1);
  push(r, string_of(pat));
  yk v = BOX(T_ARRAY, r);
  yk_set(v, ascii("index"), yk_number(at));
  yk_set(v, ascii("input"), s);
  yk_set(v, ascii("groups"), YK_UNDEFINED);
  return v;
}

static int64_t find_from(yk_string *s, yk_string *t, uint32_t from) {
  for (uint32_t i = from; i + t->len <= s->len; i++)
    if (memcmp(s->units + i, t->units, (size_t)t->len * 2) == 0) return i;
  return -1;
}

/* The string methods that take a pattern: 1 when name is one, with its result in *out. */
static int string_pattern_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out) {
  yk a0 = argc > 0 ? argv[0] : YK_UNDEFINED, a1 = argc > 1 ? argv[1] : YK_UNDEFINED;
  yk_string *s = str(recv);
  int replace_all = key_is(key, "replaceAll");
  if (key_is(key, "replace") || replace_all) {
    if (is_regexp(a0)) {
      int global = has_flag(a0, 'g');
      if (replace_all && !global) type_error("replaceAll must be called with a global RegExp");
      if (global) yk_set(a0, ascii("lastIndex"), yk_number(0));
      yk acc = ascii("");
      uint32_t last = 0;
      for (;;) {
        yk m = regexp_exec(a0, recv);
        if (m == YK_NULL) break;
        uint32_t at = (uint32_t)num(yk_get(m, ascii("index")));
        uint32_t len = str(arr(m)->items[0])->len;
        if (at >= last) {
          acc = concat(str(acc), str(substring(s, last, at)));
          acc = concat(str(acc), str(replacement(a1, m)));
          last = at + len;
        }
        if (!global) break;
        if (len == 0) {
          double li = num(yk_get(a0, ascii("lastIndex")));
          yk_set(a0, ascii("lastIndex"), yk_number(advance(s, (uint32_t)li, has_flag(a0, 'u'))));
        }
      }
      *out = concat(str(acc), str(substring(s, last, s->len)));
      return 1;
    }
    yk_string *pat = str(to_string(a0));
    yk acc = ascii("");
    uint32_t last = 0;
    int64_t at = find_from(s, pat, 0);
    while (at >= 0) {
      acc = concat(str(acc), str(substring(s, last, (uint32_t)at)));
      acc = concat(str(acc), str(replacement(a1, string_match(recv, pat, (uint32_t)at))));
      last = (uint32_t)at + pat->len;
      if (!replace_all) break;
      at = pat->len == 0 ? (at + 1 <= s->len ? find_from(s, pat, (uint32_t)at + 1) : -1) : find_from(s, pat, last);
    }
    *out = concat(str(acc), str(substring(s, last, s->len)));
    return 1;
  }
  if (key_is(key, "match") || key_is(key, "matchAll") || key_is(key, "search")) {
    if (!is_regexp(a0)) type_error("a pattern that is not a regex literal (a dynamic RegExp) is not in the native runtime");
    if (key_is(key, "search")) {
      yk saved = yk_get(a0, ascii("lastIndex"));
      yk idx = run_matcher(a0, recv, 0, has_flag(a0, 'y'));
      yk_set(a0, ascii("lastIndex"), saved);
      *out = idx == YK_NULL ? yk_number(-1) : arr(idx)->items[0];
      return 1;
    }
    int all = key_is(key, "matchAll");
    if (all && !has_flag(a0, 'g')) type_error("matchAll must be called with a global RegExp");
    if (!all && !has_flag(a0, 'g')) {
      *out = regexp_exec(a0, recv);
      return 1;
    }
    yk_set(a0, ascii("lastIndex"), yk_number(0));
    yk_array *r = new_array(4);
    for (;;) {
      yk m = regexp_exec(a0, recv);
      if (m == YK_NULL) break;
      push(r, all ? m : arr(m)->items[0]);
      if (str(arr(m)->items[0])->len == 0) {
        double li = num(yk_get(a0, ascii("lastIndex")));
        yk_set(a0, ascii("lastIndex"), yk_number(advance(s, (uint32_t)li, has_flag(a0, 'u'))));
      }
    }
    *out = !all && r->len == 0 ? YK_NULL : BOX(T_ARRAY, r);
    return 1;
  }
  if (key_is(key, "split") && is_regexp(a0)) {
    /* RegExp.prototype[@@split]: sticky matches at each position, with the captures between. */
    uint32_t limit = a1 == YK_UNDEFINED ? 0xFFFFFFFFu : to_uint32(a1);
    yk_array *r = new_array(4);
    if (limit == 0) return *out = BOX(T_ARRAY, r), 1;
    if (s->len == 0) {
      if (run_matcher(a0, recv, 0, 1) == YK_NULL) push(r, recv);
      return *out = BOX(T_ARRAY, r), 1;
    }
    int unicode = has_flag(a0, 'u');
    uint32_t p = 0, q = 0;
    while (q < s->len) {
      yk idx = run_matcher(a0, recv, q, 1);
      if (idx == YK_NULL) {
        q = advance(s, q, unicode);
        continue;
      }
      uint32_t e = (uint32_t)num(arr(idx)->items[1]);
      if (e > s->len) e = s->len;
      if (e == p) {
        q = advance(s, q, unicode);
        continue;
      }
      push(r, substring(s, p, q));
      if (r->len == limit) return *out = BOX(T_ARRAY, r), 1;
      for (uint32_t g = 1; g < arr(idx)->len / 2; g++) {
        double a = num(arr(idx)->items[2 * g]), b = num(arr(idx)->items[2 * g + 1]);
        push(r, a < 0 ? YK_UNDEFINED : substring(s, (uint32_t)a, (uint32_t)b));
        if (r->len == limit) return *out = BOX(T_ARRAY, r), 1;
      }
      p = e;
      q = p;
    }
    push(r, substring(s, p, s->len));
    return *out = BOX(T_ARRAY, r), 1;
  }
  return 0;
}

/* --- the global functions, as values --- */

static int is_generator_return(yk v);
/* __yakccTry(body, handler, finalizer): a try statement, as the TypeScript lowering's runtime has it. */
static yk builtin_try(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk body = argv[0], handler_fn = argc > 1 ? argv[1] : YK_UNDEFINED, fin = argc > 2 ? argv[2] : YK_UNDEFINED;
  yk r;
  int threw = protected_call(body, 0, NULL, &r);
  if (threw && is_closure(handler_fn) && !is_generator_return(r)) {
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
/* Object.is: SameValue (NaN is NaN; 0 is not -0). */
static yk builtin_object_is(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk a = argc > 0 ? argv[0] : YK_UNDEFINED, b = argc > 1 ? argv[1] : YK_UNDEFINED;
  if (is_number(a) && is_number(b)) {
    double x = num(a), y = num(b);
    if (x != x && y != y) return YK_TRUE;
    if (x == 0 && y == 0) return yk_bool((1 / x < 0) == (1 / y < 0));
    return yk_bool(x == y);
  }
  return yk_bool(strict_equal(a, b));
}
/* Number.isFinite, isInteger, isSafeInteger and isNaN: false for anything but a number. */
static yk builtin_number_is_finite(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  if (argc == 0 || !is_number(argv[0])) return YK_FALSE;
  double d = num(argv[0]);
  return yk_bool(d == d && !isinf(d));
}
static yk builtin_number_is_integer(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  if (argc == 0 || !is_number(argv[0])) return YK_FALSE;
  double d = num(argv[0]);
  return yk_bool(d == d && !isinf(d) && trunc(d) == d);
}
static yk builtin_number_is_safe_integer(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  if (argc == 0 || !is_number(argv[0])) return YK_FALSE;
  double d = num(argv[0]);
  return yk_bool(d == d && !isinf(d) && trunc(d) == d && fabs(d) <= 9007199254740991.0);
}
static yk builtin_number_is_nan(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return yk_bool(argc > 0 && is_number(argv[0]) && num(argv[0]) != num(argv[0]));
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
  if (argc > 0) {
    yk v = to_primitive(argv[0]);
    if (is_bigint(v)) return yk_number(big_to_double_v(v));
  }
  return yk_number(argc == 0 ? 0 : to_number(argv[0]));
}
static yk builtin_boolean(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return yk_bool(argc > 0 && yk_truthy(argv[0]));
}

/* --- promises, async functions and generators (#1295) ---
 *
 * A Promise follows ECMA-262 §27.2: resolving functions with their already-resolved flag, a thenable
 * resolved through a NewPromiseResolveThenableJob, reactions run as jobs in one FIFO queue. An async
 * function and a generator run on a stack of their own (a coroutine): `await` and `yield` suspend it,
 * and a job (for await) or next() (for a generator) resumes it, so the lowering of their bodies is
 * the lowering of any function's. `await v` is PerformPromiseThen(PromiseResolve(v), resume), as the
 * specification has it since ES2019: one job after v settles.
 */

typedef struct reaction {
  int kind;           /* 0 on fulfilment, 1 on rejection */
  yk handler;         /* a function, or 0: the value passes on */
  yk derived;         /* the promise its result settles, or 0 */
  struct coro *resume; /* an await's coroutine, resumed with the value (or with it thrown) */
} reaction;

typedef struct {
  int state; /* 0 pending, 1 fulfilled, 2 rejected */
  yk value;
  reaction **on_fulfil, **on_reject;
  uint32_t n, cap;
} promise_state;

typedef struct coro {
  ucontext_t ctx, back;
  handler *handlers;   /* its own handler chain while it is suspended */
  int state;           /* 0 not started, 1 suspended, 2 running, 3 done */
  int kind;            /* 0 an async function's, 1 a generator's */
  int mode;            /* how it is resumed: 0 with a value, 1 with it thrown, 2 returning it */
  yk transfer;         /* the value it is resumed with, or yields */
  yk_closure *fn;
  yk self;
  uint64_t argc;
  yk *argv;
  yk promise;          /* an async function's result */
  yk result;           /* when done: what it returned, or threw */
  int threw;
  yk returning;        /* a generator's return(v): the v */
  void *stack;
} coro;

#define CORO_STACK (256 * 1024)
static coro *current_coro, *starting_coro;
/* A generator's return() unwinds its body as a throw no catch sees, and finally blocks do. */
static yk generator_return_token;
static int is_generator_return(yk v) { return generator_return_token != 0 && v == generator_return_token; }

static int is_promise(yk v) { return is_object(v) && ((yk_object *)PTR(v))->kind == 4; }
static promise_state *pstate(yk p) { return (promise_state *)((yk_object *)PTR(p))->ext; }

static yk promise_new(void) {
  yk p = yk_object_of(0, NULL, NULL);
  ((yk_object *)PTR(p))->kind = 4;
  ((yk_object *)PTR(p))->ext = alloc(sizeof(promise_state));
  return p;
}

/* The job queue. */
typedef struct {
  int type;     /* 0 a reaction, 1 a thenable to resolve a promise with */
  reaction *r;
  yk argument;
  yk promise, thenable, then;
} job;
static job *jobs;
static size_t jobs_head, jobs_tail, jobs_cap;
static void enqueue(job j) {
  if (jobs_tail == jobs_cap) {
    if (jobs_head > 0) {
      memmove(jobs, jobs + jobs_head, (jobs_tail - jobs_head) * sizeof(job));
      jobs_tail -= jobs_head;
      jobs_head = 0;
    } else {
      jobs_cap = jobs_cap == 0 ? 64 : jobs_cap * 2;
      jobs = realloc(jobs, jobs_cap * sizeof(job));
      if (jobs == NULL) abort();
    }
  }
  jobs[jobs_tail++] = j;
}

static void settle(yk p, int state, yk value) {
  promise_state *s = pstate(p);
  if (s->state != 0) return;
  s->state = state;
  s->value = value;
  /* TriggerPromiseReactions: each of the settled side, in order, as a job. */
  for (uint32_t i = 0; i < s->n; i++)
    enqueue((job){0, state == 1 ? s->on_fulfil[i] : s->on_reject[i], value, 0, 0, 0});
  s->n = 0;
}
static void reject_promise(yk p, yk reason) { settle(p, 2, reason); }

static yk then_of(yk x, int *threw);
/* The promise's resolve function, without its flag: a thenable is resolved through a job. */
static void resolve_promise(yk p, yk x) {
  if (x == p) {
    reject_promise(p, make_error("TypeError", ascii("Chaining cycle detected for promise #<Promise>")));
    return;
  }
  if (!is_object(x) && !is_closure(x)) {
    settle(p, 1, x);
    return;
  }
  int threw;
  yk then = then_of(x, &threw);
  if (threw) {
    reject_promise(p, then);
    return;
  }
  if (!is_closure(then)) {
    settle(p, 1, x);
    return;
  }
  enqueue((job){1, NULL, 0, p, x, then});
}

/* CreateResolvingFunctions: resolve and reject sharing one already-resolved flag. */
static yk resolving_code(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self;
  yk_closure *k = (yk_closure *)c;
  yk_array *flag = arr(k->captures[1]);
  if (flag->items[0] == YK_TRUE) return YK_UNDEFINED;
  flag->items[0] = YK_TRUE;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (k->captures[2] == YK_TRUE) reject_promise(k->captures[0], v);
  else resolve_promise(k->captures[0], v);
  return YK_UNDEFINED;
}
static void resolving_functions(yk p, yk *resolve, yk *reject) {
  yk flag = yk_array_of(1, (yk[]){YK_FALSE});
  *resolve = yk_closure_new(resolving_code, 0, 3, (yk[]){p, flag, YK_FALSE});
  *reject = yk_closure_new(resolving_code, 0, 3, (yk[]){p, flag, YK_TRUE});
}

static int protected_call_with(yk f, yk self, uint64_t argc, const yk *argv, yk *result) {
  handler h;
  h.prev = handlers;
  handlers = &h;
  if (setjmp(h.env) == 0) {
    yk r = call_value(f, self, argc, argv);
    handlers = h.prev;
    *result = r;
    return 0;
  }
  handlers = h.prev;
  *result = thrown;
  return 1;
}

/* PerformPromiseThen. */
static void perform_then(yk p, yk on_fulfil, yk on_reject, yk derived, coro *resume) {
  reaction *f = alloc(sizeof(reaction)), *r = alloc(sizeof(reaction));
  *f = (reaction){0, is_closure(on_fulfil) ? on_fulfil : 0, derived, resume};
  *r = (reaction){1, is_closure(on_reject) ? on_reject : 0, derived, resume};
  promise_state *s = pstate(p);
  if (s->state == 0) {
    if (s->n == s->cap) {
      s->cap = s->cap == 0 ? 2 : s->cap * 2;
      s->on_fulfil = realloc(s->on_fulfil, s->cap * sizeof(reaction *));
      s->on_reject = realloc(s->on_reject, s->cap * sizeof(reaction *));
    }
    s->on_fulfil[s->n] = f;
    s->on_reject[s->n++] = r;
  } else
    enqueue((job){0, s->state == 1 ? f : r, s->value, 0, 0, 0});
}

/* PromiseResolve(%Promise%, x): a promise is itself; anything else a promise resolved with it. */
static yk promise_resolve(yk x) {
  if (is_promise(x)) return x;
  yk p = promise_new();
  resolve_promise(p, x);
  return p;
}

static void coro_resume(coro *co, yk value, int mode);
static void async_finish(coro *co);

static void run_job(job j) {
  if (j.type == 1) {
    /* NewPromiseResolveThenableJob: then.call(thenable, resolve, reject). */
    yk resolve, reject, r;
    resolving_functions(j.promise, &resolve, &reject);
    if (protected_call_with(j.then, j.thenable, 2, (yk[]){resolve, reject}, &r))
      call_value(reject, YK_UNDEFINED, 1, &r);
    return;
  }
  reaction *re = j.r;
  if (re->resume != NULL) {
    coro_resume(re->resume, j.argument, re->kind);
    if (re->resume->state == 3) async_finish(re->resume);
    return;
  }
  if (re->handler == 0) {
    if (re->derived != 0) {
      if (re->kind == 0) resolve_promise(re->derived, j.argument);
      else reject_promise(re->derived, j.argument);
    }
    return;
  }
  yk r;
  int threw = protected_call_with(re->handler, YK_UNDEFINED, 1, &j.argument, &r);
  if (re->derived == 0) return;
  if (threw) reject_promise(re->derived, r);
  else resolve_promise(re->derived, r);
}

/* Runs the jobs until there are none. */
void yk_drain(void) {
  while (jobs_head < jobs_tail) {
    job j = jobs[jobs_head++];
    run_job(j);
  }
  jobs_head = jobs_tail = 0;
}

/* --- coroutines --- */

static void coro_main(void) {
  coro *co = starting_coro;
  handler h;
  h.prev = NULL;
  handlers = &h;
  if (setjmp(h.env) == 0) {
    co->result = co->fn->code(co->fn, co->fn->has_this ? co->self : YK_UNDEFINED, co->argc, co->argv);
    co->threw = 0;
  } else if (is_generator_return(thrown)) {
    co->result = co->returning;
    co->threw = 0;
  } else {
    co->result = thrown;
    co->threw = 1;
  }
  handlers = NULL;
  co->state = 3;
  setcontext(&co->back);
}

static void coro_resume(coro *co, yk value, int mode) {
  coro *prev = current_coro;
  handler *saved = handlers;
  co->transfer = value;
  co->mode = mode;
  current_coro = co;
  if (co->state == 0) {
    co->stack = alloc(CORO_STACK);
    getcontext(&co->ctx);
    co->ctx.uc_stack.ss_sp = co->stack;
    co->ctx.uc_stack.ss_size = CORO_STACK;
    co->ctx.uc_link = NULL;
    makecontext(&co->ctx, coro_main, 0);
    starting_coro = co;
  } else
    handlers = co->handlers;
  co->state = 2;
  swapcontext(&co->back, &co->ctx);
  current_coro = prev;
  handlers = saved;
  if (co->state == 3 && co->stack != NULL) {
    free(co->stack);
    co->stack = NULL;
  }
}

/* Suspends the running coroutine; what it is resumed with, and how (0 next, 1 throw, 2 return). */
static yk coro_suspend_mode(yk out, int *mode) {
  coro *co = current_coro;
  co->transfer = out;
  co->handlers = handlers;
  co->state = 1;
  swapcontext(&co->ctx, &co->back);
  *mode = co->mode;
  return co->transfer;
}

/* The running generator returns `value` through whatever it is in (its finally blocks run). */
static void generator_return_through(yk value) {
  current_coro->returning = value;
  if (generator_return_token == 0) generator_return_token = BOX(T_INTERNAL, alloc(sizeof(int32_t) * 2));
  yk_throw(generator_return_token);
}

/* Suspends the running coroutine; what it is resumed with is returned, thrown, or returned through. */
static yk coro_suspend(yk out) {
  coro *co = current_coro;
  co->transfer = out;
  co->handlers = handlers;
  co->state = 1;
  swapcontext(&co->ctx, &co->back);
  if (co->mode == 1) yk_throw(co->transfer);
  if (co->mode == 2) {
    co->returning = co->transfer;
    if (generator_return_token == 0) generator_return_token = BOX(T_INTERNAL, alloc(sizeof(int32_t) * 2));
    yk_throw(generator_return_token);
  }
  return co->transfer;
}

static coro *coro_new(int kind, yk_closure *c, yk self, uint64_t argc, const yk *argv) {
  coro *co = alloc(sizeof(coro));
  co->kind = kind;
  co->fn = c;
  co->self = self;
  co->argc = argc;
  co->argv = alloc((argc > 0 ? argc : 1) * sizeof(yk));
  memcpy(co->argv, argv, (size_t)argc * sizeof(yk));
  return co;
}

/* --- async functions --- */

static void async_finish(coro *co) {
  if (co->threw) reject_promise(co->promise, co->result);
  else resolve_promise(co->promise, co->result);
}

static yk async_call(void *c, yk self, uint64_t argc, const yk *argv) {
  coro *co = coro_new(0, (yk_closure *)c, self, argc, argv);
  co->promise = promise_new();
  coro_resume(co, YK_UNDEFINED, 0);
  if (co->state == 3) async_finish(co);
  return co->promise;
}

/* await v. */
yk yk_await(yk v) {
  coro *co = current_coro;
  if (co == NULL || co->kind != 0) type_error("await is only valid in async functions here");
  perform_then(promise_resolve(v), 0, 0, 0, co);
  return coro_suspend(YK_UNDEFINED);
}

/* --- generators --- */

static yk generator_new(void *c, yk self, uint64_t argc, const yk *argv) {
  yk g = yk_object_of(0, NULL, NULL);
  ((yk_object *)PTR(g))->kind = 5;
  ((yk_object *)PTR(g))->ext = coro_new(1, (yk_closure *)c, self, argc, argv);
  return g;
}

static yk iter_result(yk value, int done) {
  yk keys[2] = {ascii("value"), ascii("done")};
  yk values[2] = {value, yk_bool(done)};
  return yk_object_of(2, keys, values);
}

/* Resumes a generator; 1 with what it yielded, 0 with what it returned; a throw propagates. */
static int generator_resume(yk g, yk value, int mode, yk *out) {
  coro *co = (coro *)((yk_object *)PTR(g))->ext;
  if (co->state == 2) type_error("Generator is already running");
  if (co->state == 3 || (co->state == 0 && mode != 0)) {
    co->state = 3;
    if (mode == 1) yk_throw(value);
    *out = mode == 2 ? value : YK_UNDEFINED;
    return 0;
  }
  coro_resume(co, value, mode);
  if (co->state == 3) {
    if (co->threw) yk_throw(co->result);
    *out = co->result;
    return 0;
  }
  *out = co->transfer;
  return 1;
}
static int generator_step(yk g, yk *out) { return generator_resume(g, YK_UNDEFINED, 0, out); }

/* yield v. */
yk yk_yield(yk v) {
  coro *co = current_coro;
  if (co == NULL || co->kind != 1) type_error("yield is only valid in generators here");
  return coro_suspend(v);
}

/* yield* v: each value v's iteration gives, yielded in turn; its return value is the result. What
   the consumer sends, throws or returns is passed on to a generator delegated to, so its catch and
   finally blocks see it, as ECMAScript's yield* does (#1330). */
yk yk_yield_star(yk v) {
  if (is_object(v) && ((yk_object *)PTR(v))->kind == 5) {
    coro *co = current_coro;
    if (co == NULL || co->kind != 1) type_error("yield is only valid in generators here");
    yk sent = YK_UNDEFINED, out;
    int mode = 0;
    for (;;) {
      if (!generator_resume(v, sent, mode, &out)) {
        /* Done: by return(), this generator returns too, with what the delegate returned. */
        if (mode == 2) generator_return_through(out);
        return out;
      }
      sent = coro_suspend_mode(out, &mode);
    }
  }
  yk it = yk_iter_new(v, 0), e;
  while (yk_iter_next(it, &e)) yk_yield(e);
  return YK_UNDEFINED;
}

/* __yakccTryGen(body, handler, finalizer): a try statement in a generator whose blocks yield, its
   blocks generator functions delegated to in turn (#1330). As __yakccTry, but each block is run as
   yield* block(): what the consumer sends, throws or returns reaches it. */
static yk star_code(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self;
  return yk_yield_star(call_value(((yk_closure *)c)->captures[0], YK_UNDEFINED, argc, argv));
}
static yk try_gen_code(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk body = argv[0], handler_fn = argc > 1 ? argv[1] : YK_UNDEFINED, fin = argc > 2 ? argv[2] : YK_UNDEFINED;
  yk r;
  int threw = protected_call(yk_closure_new(star_code, 0, 1, &body), 0, NULL, &r);
  if (threw && is_closure(handler_fn) && !is_generator_return(r)) {
    yk exc = r;
    threw = protected_call(yk_closure_new(star_code, 0, 1, &handler_fn), 1, &exc, &r);
  }
  if (is_closure(fin)) {
    yk done = call_value(yk_closure_new(star_code, 0, 1, &fin), YK_UNDEFINED, 0, NULL);
    if (is_array(done) && arr(done)->len > 0 && strict_equal(arr(done)->items[0], yk_number(1))) return done;
  }
  if (threw) yk_throw(r);
  return r;
}

/* Leaving a for…of early (a break, or a return from the loop's function) closes its iterator: a
   generator's return() runs, so its finally blocks do (IteratorClose). Done iterators are left. */
void yk_iter_close(yk itv) {
  yk_iter *it = (yk_iter *)PTR(itv);
  if (it->gen == 0) return;
  coro *co = (coro *)((yk_object *)PTR(it->gen))->ext;
  if (co->state == 3) return;
  yk out;
  generator_resume(it->gen, YK_UNDEFINED, 2, &out);
}

/* --- the methods of promises and generators --- */

static yk promise_then(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c;
  if (!is_promise(self)) type_error("Method Promise.prototype.then called on incompatible receiver");
  yk derived = promise_new();
  perform_then(self, argc > 0 ? argv[0] : 0, argc > 1 ? argv[1] : 0, derived, NULL);
  return derived;
}
static yk promise_catch(void *c, yk self, uint64_t argc, const yk *argv) {
  yk args[2] = {YK_UNDEFINED, argc > 0 ? argv[0] : YK_UNDEFINED};
  return promise_then(c, self, 2, args);
}
/* finally(f): thenFinally / catchFinally, each running f, then passing the value (or reason) on
   after the promise f's result resolves to. */
static yk value_thunk(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self, (void)argc, (void)argv;
  return ((yk_closure *)c)->captures[0];
}
static yk thrower(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self, (void)argc, (void)argv;
  yk_throw(((yk_closure *)c)->captures[0]);
  return YK_UNDEFINED;
}
static yk finally_step(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self;
  yk_closure *k = (yk_closure *)c;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  yk result = call_value(k->captures[0], YK_UNDEFINED, 0, NULL);
  yk p = promise_resolve(result);
  yk next = yk_closure_new(k->captures[1] == YK_TRUE ? thrower : value_thunk, 0, 1, &v);
  return promise_then(NULL, p, 1, &next);
}
static yk promise_finally(void *c, yk self, uint64_t argc, const yk *argv) {
  yk f = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (!is_closure(f)) return promise_then(c, self, 2, (yk[]){f, f});
  yk on_fulfil = yk_closure_new(finally_step, 0, 2, (yk[]){f, YK_FALSE});
  yk on_reject = yk_closure_new(finally_step, 0, 2, (yk[]){f, YK_TRUE});
  return promise_then(c, self, 2, (yk[]){on_fulfil, on_reject});
}
static yk generator_next(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c;
  yk out;
  int more = generator_resume(self, argc > 0 ? argv[0] : YK_UNDEFINED, 0, &out);
  return iter_result(out, !more);
}
static yk generator_throw(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c;
  yk out;
  int more = generator_resume(self, argc > 0 ? argv[0] : YK_UNDEFINED, 1, &out);
  return iter_result(out, !more);
}
static yk generator_return(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c;
  yk out;
  int more = generator_resume(self, argc > 0 ? argv[0] : YK_UNDEFINED, 2, &out);
  return iter_result(out, !more);
}

/* A promise's or a generator's method by name, or 0. */
static yk async_member(void *obj, yk key) {
  yk_object *o = (yk_object *)obj;
  static yk fns[6];
  static const char *const names[6] = {"then", "catch", "finally", "next", "throw", "return"};
  static const yk_code codes[6] = {promise_then, promise_catch, promise_finally,
                                   generator_next, generator_throw, generator_return};
  for (int i = o->kind == 4 ? 0 : 3; i < (o->kind == 4 ? 3 : 6); i++)
    if (key_is(key, names[i])) {
      if (fns[i] == 0) fns[i] = yk_closure_new(codes[i], 1, 0, NULL);
      return fns[i];
    }
  return 0;
}

/* Get(x, "then"), as resolving a promise with x does: a getter may throw. */
static yk then_of(yk x, int *threw) {
  *threw = 0;
  if (is_promise(x)) return async_member(PTR(x), ascii("then"));
  if (is_object(x) && ((yk_object *)PTR(x))->kind != 0) return YK_UNDEFINED;
  handler h;
  h.prev = handlers;
  handlers = &h;
  if (setjmp(h.env) == 0) {
    yk slot, r = chain_get(x, ascii("then"), &slot) ? resolve_slot(slot, x) : YK_UNDEFINED;
    handlers = h.prev;
    return r;
  }
  handlers = h.prev;
  *threw = 1;
  return thrown;
}

/* --- the Promise constructor and its statics --- */

static yk builtin_promise(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self, (void)argc, (void)argv;
  type_error("Promise constructor cannot be invoked without 'new'");
  return YK_UNDEFINED;
}
/* new Promise(executor). */
static yk promise_construct(uint64_t argc, const yk *argv) {
  yk executor = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (!is_closure(executor)) type_error("Promise resolver is not a function");
  yk p = promise_new(), resolve, reject, r;
  resolving_functions(p, &resolve, &reject);
  if (protected_call_with(executor, YK_UNDEFINED, 2, (yk[]){resolve, reject}, &r))
    call_value(reject, YK_UNDEFINED, 1, &r);
  return p;
}
static yk promise_static_resolve(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return promise_resolve(argc > 0 ? argv[0] : YK_UNDEFINED);
}
static yk promise_static_reject(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk p = promise_new();
  reject_promise(p, argc > 0 ? argv[0] : YK_UNDEFINED);
  return p;
}
/* Promise.all / allSettled: each element's settling recorded at its index, once. */
static yk combinator_element(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self;
  /* captures: the result promise, the values, the index, the remaining count, the called flag,
     the shape (0 all, 1 allSettled fulfilled, 2 allSettled rejected) */
  yk_closure *k = (yk_closure *)c;
  yk_array *called = arr(k->captures[4]);
  if (called->items[0] == YK_TRUE) return YK_UNDEFINED;
  called->items[0] = YK_TRUE;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  int shape = (int)num(k->captures[5]);
  if (shape != 0) {
    yk keys[2] = {ascii("status"), ascii(shape == 1 ? "value" : "reason")};
    yk values[2] = {ascii(shape == 1 ? "fulfilled" : "rejected"), v};
    v = yk_object_of(2, keys, values);
  }
  arr(k->captures[1])->items[(uint32_t)num(k->captures[2])] = v;
  yk_array *remaining = arr(k->captures[3]);
  remaining->items[0] = yk_number(num(remaining->items[0]) - 1);
  if (num(remaining->items[0]) == 0) resolve_promise(k->captures[0], k->captures[1]);
  return YK_UNDEFINED;
}
static yk promise_combine(uint64_t argc, const yk *argv, int settled) {
  yk result = promise_new(), resolve, reject;
  resolving_functions(result, &resolve, &reject);
  yk_array *items = iterable_items(argc > 0 ? argv[0] : YK_UNDEFINED);
  yk values = BOX(T_ARRAY, new_array(items->len > 0 ? items->len : 1));
  arr(values)->len = items->len;
  for (uint32_t i = 0; i < items->len; i++) arr(values)->items[i] = YK_UNDEFINED;
  yk remaining = yk_array_of(1, (yk[]){yk_number(1)});
  for (uint32_t i = 0; i < items->len; i++) {
    yk next = promise_resolve(items->items[i]);
    yk called = yk_array_of(1, (yk[]){YK_FALSE});
    yk caps[6] = {result, values, yk_number(i), remaining, called, yk_number(settled ? 1 : 0)};
    yk on_fulfil = yk_closure_new(combinator_element, 0, 6, caps);
    yk on_reject = reject;
    if (settled) {
      caps[5] = yk_number(2);
      on_reject = yk_closure_new(combinator_element, 0, 6, caps);
    }
    arr(remaining)->items[0] = yk_number(num(arr(remaining)->items[0]) + 1);
    promise_then(NULL, next, 2, (yk[]){on_fulfil, on_reject});
  }
  arr(remaining)->items[0] = yk_number(num(arr(remaining)->items[0]) - 1);
  if (num(arr(remaining)->items[0]) == 0) resolve_promise(result, values);
  return result;
}
static yk promise_static_all(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return promise_combine(argc, argv, 0);
}
static yk promise_static_all_settled(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return promise_combine(argc, argv, 1);
}
static yk promise_static_race(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk result = promise_new(), resolve, reject;
  resolving_functions(result, &resolve, &reject);
  yk_array *items = iterable_items(argc > 0 ? argv[0] : YK_UNDEFINED);
  for (uint32_t i = 0; i < items->len; i++)
    promise_then(NULL, promise_resolve(items->items[i]), 2, (yk[]){resolve, reject});
  return result;
}

/* __yakccTryAsync(body, handler, finalizer): the async try primitive, as the TypeScript lowering's
   runtime defines it: try { try { return await body() } catch (t) { …; return await handler(t) } }
   finally { const done = await finalizer(); if (done is [1, …]) return done }. */
static yk try_async_body(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk body = argv[0], handler_fn = argc > 1 ? argv[1] : YK_UNDEFINED, fin = argc > 2 ? argv[2] : YK_UNDEFINED;
  yk r;
  int threw;
  {
    handler h;
    h.prev = handlers;
    handlers = &h;
    if (setjmp(h.env) == 0) {
      r = yk_await(call_value(body, YK_UNDEFINED, 0, NULL));
      threw = 0;
    } else {
      r = thrown;
      threw = 1;
    }
    handlers = h.prev;
  }
  if (threw && is_closure(handler_fn) && !is_generator_return(r)) {
    yk exc = r;
    handler h;
    h.prev = handlers;
    handlers = &h;
    if (setjmp(h.env) == 0) {
      r = yk_await(call_value(handler_fn, YK_UNDEFINED, 1, &exc));
      threw = 0;
    } else {
      r = thrown;
      threw = 1;
    }
    handlers = h.prev;
  }
  if (is_closure(fin)) {
    yk done = yk_await(call_value(fin, YK_UNDEFINED, 0, NULL));
    if (is_array(done) && arr(done)->len > 0 && strict_equal(arr(done)->items[0], yk_number(1))) return done;
  }
  if (threw) yk_throw(r);
  return r;
}

static yk builtin_queue_microtask(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk f = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (!is_closure(f)) type_error("The callback must be a function");
  /* A reaction with no derived promise: the job calls f. */
  reaction *r = alloc(sizeof(reaction));
  *r = (reaction){0, f, 0, NULL};
  enqueue((job){0, r, YK_UNDEFINED, 0, 0, 0});
  return YK_UNDEFINED;
}

/* A closure's mode, set where it is made: async (1) or a generator (2). */
yk yk_closure_mode(yk f, int32_t mode) {
  ((yk_closure *)PTR(f))->mode = mode;
  return f;
}

/* After a call: the jobs run; a promise is its value, or ["rejected", String(reason)], or
   ["pending"] if nothing settles it. */
yk yk_settle(yk v) {
  yk_drain();
  if (!is_promise(v)) return v;
  promise_state *s = pstate(v);
  if (s->state == 1) return s->value;
  if (s->state == 2) return yk_array_of(2, (yk[]){ascii("rejected"), to_string(s->value)});
  return yk_array_of(1, (yk[]){ascii("pending")});
}

/*
 * A global the platform gives, by name: a function value, NaN or Infinity, or undefined when the
 * runtime has none (so a `typeof` probe for it sees what a platform without it gives).
 */
/* --- ArrayBuffer, the typed arrays, DataView and TextEncoder (ECMA-262 25.1-25.3, 23.2; WHATWG
 * Encoding) -----------------------------------------------------------------------------------
 *
 * An ArrayBuffer (object kind 6) owns its bytes; a typed array (kind 7) and a DataView (kind 8) are
 * views of one: its buffer, a byte offset and a length (elements, or bytes for a DataView), so views
 * of one buffer see each other's writes. Elements are stored as the platform's bytes; every target
 * is little-endian, and a DataView reads and writes the order it is told. A typed array's element
 * write converts as ECMA-262's does (ToInt8 … ToUint8Clamp, ToBigInt64 …); an index that is not one
 * of its elements reads undefined and writes nothing.
 */

typedef struct {
  uint32_t len;
  uint8_t *data;
} yk_buffer;
typedef struct {
  yk buffer;
  uint32_t offset, length;
  int32_t type;
} yk_view;

enum { TA_I8, TA_U8, TA_U8C, TA_I16, TA_U16, TA_I32, TA_U32, TA_F32, TA_F64, TA_BI64, TA_BU64, TA_COUNT };
static const char *const ta_names[TA_COUNT] = {"Int8Array",   "Uint8Array",    "Uint8ClampedArray",
                                               "Int16Array",  "Uint16Array",   "Int32Array",
                                               "Uint32Array", "Float32Array",  "Float64Array",
                                               "BigInt64Array", "BigUint64Array"};
static const uint32_t ta_size[TA_COUNT] = {1, 1, 1, 2, 2, 4, 4, 4, 8, 8, 8};
#define K_BUFFER 6
#define K_TYPED 7
#define K_DATAVIEW 8

static yk_object *object_of_kind(yk v, int32_t kind) {
  if (!is_object(v)) return NULL;
  yk_object *o = (yk_object *)PTR(v);
  return o->kind == kind ? o : NULL;
}
static yk_buffer *buffer_of(yk v) {
  yk_object *o = object_of_kind(v, K_BUFFER);
  return o == NULL ? NULL : (yk_buffer *)o->ext;
}
static yk_view *typed_of(yk v) {
  yk_object *o = object_of_kind(v, K_TYPED);
  return o == NULL ? NULL : (yk_view *)o->ext;
}
static yk_view *dataview_of(yk v) {
  yk_object *o = object_of_kind(v, K_DATAVIEW);
  return o == NULL ? NULL : (yk_view *)o->ext;
}
static yk new_kind(int32_t kind, void *ext) {
  yk v = yk_object_of(0, NULL, NULL);
  yk_object *o = (yk_object *)PTR(v);
  o->kind = kind;
  o->ext = ext;
  return v;
}
static yk new_buffer(uint32_t len) {
  yk_buffer *b = alloc(sizeof(yk_buffer));
  b->len = len;
  b->data = alloc(len + 1);
  memset(b->data, 0, len + 1);
  return new_kind(K_BUFFER, b);
}
static yk new_typed(int32_t type, yk buffer, uint32_t offset, uint32_t length) {
  yk_view *t = alloc(sizeof(yk_view));
  *t = (yk_view){buffer, offset, length, type};
  return new_kind(K_TYPED, t);
}
static uint8_t *view_bytes(yk_view *t) { return buffer_of(t->buffer)->data + t->offset; }
static int is_bigint_type(int32_t type) { return type == TA_BI64 || type == TA_BU64; }

/* ToIndex: a RangeError for a negative or too large value. */
static uint32_t to_index(yk v, const char *what) {
  if (v == YK_UNDEFINED) return 0;
  double d = to_number(v);
  if (d != d) d = 0;
  d = trunc(d);
  if (d < 0 || d > 4294967295.0) range_error(what);
  return (uint32_t)d;
}

/* The bits of ToUint32 of a double (modulo 2^32). */
static uint32_t double_to_u32(double d) {
  if (d != d || isinf(d)) return 0;
  d = fmod(trunc(d), 4294967296.0);
  if (d < 0) d += 4294967296.0;
  return (uint32_t)d;
}
static yk_bigint *want_bigint(yk v) {
  v = to_primitive(v);
  if (v == YK_TRUE) return big(big_from_u64(1, 0));
  if (v == YK_FALSE) return big(big_from_u64(0, 0));
  if (is_string(v)) {
    yk b = big_from_string_v(v);
    if (b == 0) yk_throw(make_error("SyntaxError", ascii("Cannot convert the string to a BigInt")));
    return big(b);
  }
  if (!is_bigint(v)) type_error("Cannot convert the value to a BigInt");
  return big(v);
}

static yk ta_get(yk_view *t, uint32_t i) {
  uint8_t *p = view_bytes(t) + (size_t)i * ta_size[t->type];
  switch (t->type) {
  case TA_I8: return yk_number(*(int8_t *)p);
  case TA_U8:
  case TA_U8C: return yk_number(*p);
  case TA_I16: { int16_t x; memcpy(&x, p, 2); return yk_number(x); }
  case TA_U16: { uint16_t x; memcpy(&x, p, 2); return yk_number(x); }
  case TA_I32: { int32_t x; memcpy(&x, p, 4); return yk_number(x); }
  case TA_U32: { uint32_t x; memcpy(&x, p, 4); return yk_number(x); }
  case TA_F32: { float x; memcpy(&x, p, 4); return yk_number(x); }
  case TA_F64: { double x; memcpy(&x, p, 8); return yk_number(x); }
  case TA_BI64: { int64_t x; memcpy(&x, p, 8); return big_from_i64(x); }
  default: { uint64_t x; memcpy(&x, p, 8); return big_from_u64(x, 0); }
  }
}
/* A value converted as an element of the type: its bytes. */
static void ta_encode(int32_t type, yk value, uint8_t *p) {
  if (is_bigint_type(type)) {
    uint64_t x = big_low64(want_bigint(value));
    memcpy(p, &x, 8);
    return;
  }
  double d = to_number(value);
  switch (type) {
  case TA_I8:
  case TA_U8: *p = (uint8_t)double_to_u32(d); return;
  case TA_U8C: {
    /* ToUint8Clamp: NaN 0; clamped to [0, 255]; rounded half to even. */
    uint8_t c;
    if (d != d || d <= 0) c = 0;
    else if (d >= 255) c = 255;
    else {
      double f = floor(d);
      c = (uint8_t)(f + 0.5 < d ? f + 1 : d < f + 0.5 ? f : ((uint32_t)f % 2 == 0 ? f : f + 1));
    }
    *p = c;
    return;
  }
  case TA_I16:
  case TA_U16: { uint16_t x = (uint16_t)double_to_u32(d); memcpy(p, &x, 2); return; }
  case TA_I32:
  case TA_U32: { uint32_t x = double_to_u32(d); memcpy(p, &x, 4); return; }
  case TA_F32: { float x = (float)d; memcpy(p, &x, 4); return; }
  default: memcpy(p, &d, 8); return;
  }
}
static void ta_set(yk_view *t, uint32_t i, yk value) {
  uint8_t tmp[8];
  /* The value converts first (which may throw), then is stored. */
  ta_encode(t->type, value, tmp);
  memcpy(view_bytes(t) + (size_t)i * ta_size[t->type], tmp, ta_size[t->type]);
}

/* A key of an integer-indexed object: 1 and its index if it is a CanonicalNumericIndexString (or
   a number) that names an element; -1 if it is numeric but names none; 0 if it is not numeric. */
static int typed_index(yk key, uint32_t length, uint32_t *out) {
  double d;
  if (is_number(key)) d = num(key);
  else if (is_string(key)) {
    yk_string *s = str(key);
    if (s->len == 2 && s->units[0] == '-' && s->units[1] == '0') return -1;
    d = string_to_number(s);
    if (!string_equal(str(number_to_string(d)), s)) return 0;
  } else
    return 0;
  if (d != d || d != trunc(d) || d < 0 || (d == 0 && 1 / d < 0) || d >= length) return -1;
  *out = (uint32_t)d;
  return 1;
}

/* A typed array made from a source: its elements, each converted. */
static yk typed_from_items(int32_t type, yk_array *items) {
  yk buf = new_buffer(items->len * ta_size[type]);
  yk v = new_typed(type, buf, 0, items->len);
  yk_view *t = typed_of(v);
  for (uint32_t i = 0; i < items->len; i++) ta_set(t, i, items->items[i]);
  return v;
}
static yk_array *typed_items(yk_view *t) {
  yk_array *a = new_array(t->length);
  for (uint32_t i = 0; i < t->length; i++) push(a, ta_get(t, i));
  return a;
}

/* new T(), new T(length), new T(typedArray | arrayLike | iterable), new T(buffer, offset, length). */
static yk typed_construct(int32_t type, uint64_t argc, const yk *argv) {
  yk a0 = argc > 0 ? argv[0] : YK_UNDEFINED;
  uint32_t size = ta_size[type];
  yk_buffer *b = buffer_of(a0);
  if (b != NULL) {
    uint32_t offset = to_index(argc > 1 ? argv[1] : YK_UNDEFINED, "Start offset is out of bounds");
    if (offset % size != 0) range_error("start offset of the typed array should be a multiple of its element size");
    uint32_t length;
    if (argc > 2 && argv[2] != YK_UNDEFINED) {
      length = to_index(argv[2], "Invalid typed array length");
      if ((uint64_t)offset + (uint64_t)length * size > b->len) range_error("Invalid typed array length");
    } else {
      if (b->len % size != 0) range_error("byte length of the typed array should be a multiple of its element size");
      if (offset > b->len) range_error("Start offset is outside the bounds of the buffer");
      length = (b->len - offset) / size;
    }
    return new_typed(type, a0, offset, length);
  }
  yk_view *src = typed_of(a0);
  if (src != NULL) {
    if (is_bigint_type(type) != is_bigint_type(src->type)) type_error("Content types of the typed arrays differ");
    return typed_from_items(type, typed_items(src));
  }
  if (is_reference(a0)) return typed_from_items(type, iterable_items(a0));
  uint32_t n = to_index(a0, "Invalid typed array length");
  return new_typed(type, new_buffer(n * size), 0, n);
}

static int32_t type_of_code(yk_code code);

/* T.from(source, mapFn) and T.of(...items). */
static yk typed_from(int32_t type, uint64_t argc, const yk *argv) {
  yk_array *items = iterable_items(argc > 0 ? argv[0] : YK_UNDEFINED);
  if (argc > 1 && argv[1] != YK_UNDEFINED) {
    if (!is_closure(argv[1])) type_error("the map function is not a function");
    yk_array *mapped = new_array(items->len);
    for (uint32_t i = 0; i < items->len; i++) {
      yk args[2] = {items->items[i], yk_number(i)};
      push(mapped, call_value(argv[1], argc > 2 ? argv[2] : YK_UNDEFINED, 2, args));
    }
    items = mapped;
  }
  return typed_from_items(type, items);
}
static yk typed_of_items(int32_t type, uint64_t argc, const yk *argv) {
  yk_array *items = new_array((uint32_t)argc);
  for (uint64_t i = 0; i < argc; i++) push(items, argv[i]);
  return typed_from_items(type, items);
}

#define TYPED_BUILTINS(k)                                                                       \
  static yk builtin_ta_##k(void *c, yk s, uint64_t argc, const yk *argv) {                       \
    (void)c, (void)s;                                                                            \
    return typed_construct(k, argc, argv);                                                       \
  }                                                                                              \
  static yk builtin_ta_from_##k(void *c, yk s, uint64_t argc, const yk *argv) {                  \
    (void)c, (void)s;                                                                            \
    return typed_from(k, argc, argv);                                                            \
  }                                                                                              \
  static yk builtin_ta_of_##k(void *c, yk s, uint64_t argc, const yk *argv) {                    \
    (void)c, (void)s;                                                                            \
    return typed_of_items(k, argc, argv);                                                        \
  }
TYPED_BUILTINS(0)
TYPED_BUILTINS(1)
TYPED_BUILTINS(2)
TYPED_BUILTINS(3)
TYPED_BUILTINS(4)
TYPED_BUILTINS(5)
TYPED_BUILTINS(6)
TYPED_BUILTINS(7)
TYPED_BUILTINS(8)
TYPED_BUILTINS(9)
TYPED_BUILTINS(10)
static const yk_code ta_codes[TA_COUNT] = {builtin_ta_0, builtin_ta_1, builtin_ta_2, builtin_ta_3,
                                           builtin_ta_4, builtin_ta_5, builtin_ta_6, builtin_ta_7,
                                           builtin_ta_8, builtin_ta_9, builtin_ta_10};
static const yk_code ta_from_codes[TA_COUNT] = {
    builtin_ta_from_0, builtin_ta_from_1, builtin_ta_from_2, builtin_ta_from_3,
    builtin_ta_from_4, builtin_ta_from_5, builtin_ta_from_6, builtin_ta_from_7,
    builtin_ta_from_8, builtin_ta_from_9, builtin_ta_from_10};
static const yk_code ta_of_codes[TA_COUNT] = {builtin_ta_of_0, builtin_ta_of_1, builtin_ta_of_2,
                                              builtin_ta_of_3, builtin_ta_of_4, builtin_ta_of_5,
                                              builtin_ta_of_6, builtin_ta_of_7, builtin_ta_of_8,
                                              builtin_ta_of_9, builtin_ta_of_10};
static int32_t type_of_code(yk_code code) {
  for (int32_t k = 0; k < TA_COUNT; k++)
    if (ta_codes[k] == code) return k;
  return -1;
}

static yk builtin_array_buffer(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return new_buffer(to_index(argc > 0 ? argv[0] : YK_UNDEFINED, "Array buffer allocation failed"));
}
static yk builtin_array_buffer_is_view(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  return yk_bool(typed_of(v) != NULL || dataview_of(v) != NULL);
}
static yk builtin_data_view(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk_buffer *b = buffer_of(argc > 0 ? argv[0] : YK_UNDEFINED);
  if (b == NULL) type_error("First argument to DataView constructor must be an ArrayBuffer");
  uint32_t offset = to_index(argc > 1 ? argv[1] : YK_UNDEFINED, "Start offset is outside the bounds of the buffer");
  if (offset > b->len) range_error("Start offset is outside the bounds of the buffer");
  uint32_t length = b->len - offset;
  if (argc > 2 && argv[2] != YK_UNDEFINED) {
    length = to_index(argv[2], "Invalid DataView length");
    if ((uint64_t)offset + length > b->len) range_error("Invalid DataView length");
  }
  yk_view *v = alloc(sizeof(yk_view));
  *v = (yk_view){argv[0], offset, length, 0};
  return new_kind(K_DATAVIEW, v);
}

/* UTF-8 of a string's units: a lone surrogate is U+FFFD. */
static yk utf8_bytes(yk_string *s) {
  uint8_t *out = alloc((size_t)s->len * 3 + 1);
  uint32_t n = 0;
  for (uint32_t i = 0; i < s->len; i++) {
    uint32_t c = s->units[i];
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s->len && s->units[i + 1] >= 0xDC00 && s->units[i + 1] <= 0xDFFF) {
      c = 0x10000 + ((c - 0xD800) << 10) + (s->units[i + 1] - 0xDC00);
      i++;
    } else if (c >= 0xD800 && c <= 0xDFFF)
      c = 0xFFFD;
    if (c < 0x80) out[n++] = (uint8_t)c;
    else if (c < 0x800) {
      out[n++] = (uint8_t)(0xC0 | (c >> 6));
      out[n++] = (uint8_t)(0x80 | (c & 63));
    } else if (c < 0x10000) {
      out[n++] = (uint8_t)(0xE0 | (c >> 12));
      out[n++] = (uint8_t)(0x80 | ((c >> 6) & 63));
      out[n++] = (uint8_t)(0x80 | (c & 63));
    } else {
      out[n++] = (uint8_t)(0xF0 | (c >> 18));
      out[n++] = (uint8_t)(0x80 | ((c >> 12) & 63));
      out[n++] = (uint8_t)(0x80 | ((c >> 6) & 63));
      out[n++] = (uint8_t)(0x80 | (c & 63));
    }
  }
  yk buf = new_buffer(n);
  memcpy(buffer_of(buf)->data, out, n);
  return new_typed(TA_U8, buf, 0, n);
}
static yk text_encoder_encode(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  return utf8_bytes(str(v == YK_UNDEFINED ? ascii("") : to_string(v)));
}
static yk builtin_text_encoder(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s, (void)argc, (void)argv;
  yk o = yk_object_of(0, NULL, NULL);
  own_set((yk_object *)PTR(o), ascii("encoding"), ascii("utf-8"));
  own_set((yk_object *)PTR(o), ascii("encode"), yk_closure_new(text_encoder_encode, 1, 0, NULL));
  return o;
}

/* A property of a buffer or a view: its element, or its own accessors' values; 0 if none. */
static int buffer_get(yk obj, yk key, yk *out) {
  yk_view *t = typed_of(obj);
  if (t != NULL) {
    uint32_t i;
    int k = typed_index(key, t->length, &i);
    if (k == 1) return *out = ta_get(t, i), 1;
    if (k == -1) return *out = YK_UNDEFINED, 1;
    if (key_is(key, "length")) return *out = yk_number(t->length), 1;
    if (key_is(key, "byteLength")) return *out = yk_number((double)t->length * ta_size[t->type]), 1;
    if (key_is(key, "byteOffset")) return *out = yk_number(t->offset), 1;
    if (key_is(key, "buffer")) return *out = t->buffer, 1;
    if (key_is(key, "BYTES_PER_ELEMENT")) return *out = yk_number(ta_size[t->type]), 1;
    return 0;
  }
  yk_buffer *b = buffer_of(obj);
  if (b != NULL && key_is(key, "byteLength")) return *out = yk_number(b->len), 1;
  yk_view *d = dataview_of(obj);
  if (d != NULL) {
    if (key_is(key, "byteLength")) return *out = yk_number(d->length), 1;
    if (key_is(key, "byteOffset")) return *out = yk_number(d->offset), 1;
    if (key_is(key, "buffer")) return *out = d->buffer, 1;
  }
  return 0;
}
/* A write to a typed array's element (or a numeric key that names none: nothing); 0 otherwise. */
static int buffer_set(yk obj, yk key, yk value) {
  yk_view *t = typed_of(obj);
  if (t == NULL) return 0;
  uint32_t i;
  int k = typed_index(key, t->length, &i);
  if (k == 1) ta_set(t, i, value);
  else if (k == -1) {
    /* Still converted (which may throw), as IntegerIndexedElementSet does. */
    uint8_t tmp[8];
    ta_encode(t->type, value, tmp);
  }
  return k != 0;
}

/* RelativeIndex as slice and fill clamp it. */
static uint32_t clamp_relative(yk v, uint32_t len, uint32_t dflt) {
  if (v == YK_UNDEFINED) return dflt;
  double d = to_number(v);
  if (d != d) d = 0;
  d = trunc(d);
  if (d < 0) d = d + len < 0 ? 0 : d + len;
  return d > len ? len : (uint32_t)d;
}

static int dataview_method(yk_view *d, yk key, uint64_t argc, const yk *argv, yk *out) {
  static const char *const get_names[TA_COUNT] = {"getInt8",   "getUint8",   NULL,         "getInt16",
                                                  "getUint16", "getInt32",   "getUint32",  "getFloat32",
                                                  "getFloat64", "getBigInt64", "getBigUint64"};
  static const char *const set_names[TA_COUNT] = {"setInt8",   "setUint8",   NULL,         "setInt16",
                                                  "setUint16", "setInt32",   "setUint32",  "setFloat32",
                                                  "setFloat64", "setBigInt64", "setBigUint64"};
  for (int32_t type = 0; type < TA_COUNT; type++) {
    int get = get_names[type] != NULL && key_is(key, get_names[type]);
    int set = set_names[type] != NULL && key_is(key, set_names[type]);
    if (!get && !set) continue;
    uint32_t at = to_index(argc > 0 ? argv[0] : YK_UNDEFINED, "Offset is outside the bounds of the DataView");
    yk little = argc > (uint64_t)(get ? 1 : 2) ? argv[get ? 1 : 2] : YK_UNDEFINED;
    uint8_t bytes[8];
    if (set) ta_encode(type, argc > 1 ? argv[1] : YK_UNDEFINED, bytes);
    uint32_t size = ta_size[type];
    if ((uint64_t)at + size > d->length) range_error("Offset is outside the bounds of the DataView");
    uint8_t *p = buffer_of(d->buffer)->data + d->offset + at;
    int le = yk_truthy(little);
    if (set) {
      for (uint32_t i = 0; i < size; i++) p[i] = bytes[le ? i : size - 1 - i];
      return *out = YK_UNDEFINED, 1;
    }
    for (uint32_t i = 0; i < size; i++) bytes[le ? i : size - 1 - i] = p[i];
    yk_view tmp = {0, 0, 1, type};
    (void)tmp;
    uint8_t *saved = bytes;
    switch (type) {
    case TA_I8: return *out = yk_number(*(int8_t *)saved), 1;
    case TA_U8: return *out = yk_number(*saved), 1;
    case TA_I16: { int16_t x; memcpy(&x, saved, 2); return *out = yk_number(x), 1; }
    case TA_U16: { uint16_t x; memcpy(&x, saved, 2); return *out = yk_number(x), 1; }
    case TA_I32: { int32_t x; memcpy(&x, saved, 4); return *out = yk_number(x), 1; }
    case TA_U32: { uint32_t x; memcpy(&x, saved, 4); return *out = yk_number(x), 1; }
    case TA_F32: { float x; memcpy(&x, saved, 4); return *out = yk_number(x), 1; }
    case TA_F64: { double x; memcpy(&x, saved, 8); return *out = yk_number(x), 1; }
    case TA_BI64: { int64_t x; memcpy(&x, saved, 8); return *out = big_from_i64(x), 1; }
    default: { uint64_t x; memcpy(&x, saved, 8); return *out = big_from_u64(x, 0), 1; }
    }
  }
  return 0;
}

/* The methods of a buffer, a typed array and a DataView; 0 if the key is none of them. */
static int buffer_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out) {
  yk a0 = argc > 0 ? argv[0] : YK_UNDEFINED, a1 = argc > 1 ? argv[1] : YK_UNDEFINED;
  yk_buffer *b = buffer_of(recv);
  if (b != NULL && key_is(key, "slice")) {
    uint32_t from = clamp_relative(a0, b->len, 0), to = clamp_relative(a1, b->len, b->len);
    uint32_t n = to > from ? to - from : 0;
    yk r = new_buffer(n);
    memcpy(buffer_of(r)->data, b->data + from, n);
    return *out = r, 1;
  }
  yk_view *d = dataview_of(recv);
  if (d != NULL) return dataview_method(d, key, argc, argv, out);
  yk_view *t = typed_of(recv);
  if (t == NULL) return 0;
  uint32_t len = t->length, size = ta_size[t->type];
  if (key_is(key, "subarray")) {
    uint32_t from = clamp_relative(a0, len, 0), to = clamp_relative(a1, len, len);
    uint32_t n = to > from ? to - from : 0;
    return *out = new_typed(t->type, t->buffer, t->offset + from * size, n), 1;
  }
  if (key_is(key, "slice")) {
    uint32_t from = clamp_relative(a0, len, 0), to = clamp_relative(a1, len, len);
    uint32_t n = to > from ? to - from : 0;
    yk r = new_typed(t->type, new_buffer(n * size), 0, n);
    memcpy(view_bytes(typed_of(r)), view_bytes(t) + (size_t)from * size, (size_t)n * size);
    return *out = r, 1;
  }
  if (key_is(key, "set")) {
    double off = a1 == YK_UNDEFINED ? 0 : trunc(to_number(a1));
    if (off != off) off = 0;
    if (off < 0) range_error("offset is out of bounds");
    yk_view *src = typed_of(a0);
    if (src != NULL) {
      if (is_bigint_type(src->type) != is_bigint_type(t->type)) type_error("Content types of the typed arrays differ");
      if (off + src->length > len) range_error("offset is out of bounds");
      /* Read every element first: the source may share the target's buffer. */
      yk_array *items = typed_items(src);
      for (uint32_t i = 0; i < items->len; i++) ta_set(t, (uint32_t)off + i, items->items[i]);
      return *out = YK_UNDEFINED, 1;
    }
    if (is_nullish(a0)) type_error("Cannot convert undefined or null to object");
    yk lv = yk_get(a0, ascii("length"));
    double n = lv == YK_UNDEFINED ? 0 : to_number(lv);
    if (n != n) n = 0;
    if (off + n > len) range_error("offset is out of bounds");
    for (uint32_t i = 0; i < (uint32_t)n; i++) ta_set(t, (uint32_t)off + i, yk_get(a0, yk_number(i)));
    return *out = YK_UNDEFINED, 1;
  }
  if (key_is(key, "fill")) {
    uint8_t tmp[8];
    ta_encode(t->type, a0, tmp);
    uint32_t from = clamp_relative(a1, len, 0), to = clamp_relative(argc > 2 ? argv[2] : YK_UNDEFINED, len, len);
    for (uint32_t i = from; i < to; i++) memcpy(view_bytes(t) + (size_t)i * size, tmp, size);
    return *out = recv, 1;
  }
  if (key_is(key, "join") || key_is(key, "toString")) {
    yk sep = key_is(key, "join") && a0 != YK_UNDEFINED ? to_string(a0) : ascii(",");
    return *out = array_join(typed_items(t), str(sep)), 1;
  }
  if (key_is(key, "at")) {
    double d0 = a0 == YK_UNDEFINED ? 0 : trunc(to_number(a0));
    if (d0 != d0) d0 = 0;
    if (d0 < 0) d0 += len;
    return *out = d0 < 0 || d0 >= len ? YK_UNDEFINED : ta_get(t, (uint32_t)d0), 1;
  }
  if (key_is(key, "indexOf") || key_is(key, "includes")) {
    int inc = key_is(key, "includes");
    for (uint32_t i = clamp_relative(a1, len, 0); i < len; i++) {
      yk e = ta_get(t, i);
      if (inc ? same_value_zero(e, a0) : strict_equal(e, a0)) return *out = inc ? YK_TRUE : yk_number(i), 1;
    }
    return *out = inc ? YK_FALSE : yk_number(-1), 1;
  }
  if (key_is(key, "reverse")) {
    yk_array *items = typed_items(t);
    for (uint32_t i = 0; i < len; i++) ta_set(t, i, items->items[len - 1 - i]);
    return *out = recv, 1;
  }
  if (key_is(key, "forEach") || key_is(key, "map") || key_is(key, "every") || key_is(key, "some") ||
      key_is(key, "reduce")) {
    if (!is_closure(a0)) type_error("the callback is not a function");
    if (key_is(key, "reduce")) {
      uint32_t i = 0;
      yk acc;
      if (argc > 1) acc = a1;
      else {
        if (len == 0) type_error("Reduce of empty array with no initial value");
        acc = ta_get(t, i++);
      }
      for (; i < len; i++) {
        yk args[4] = {acc, ta_get(t, i), yk_number(i), recv};
        acc = call_value(a0, YK_UNDEFINED, 4, args);
      }
      return *out = acc, 1;
    }
    int map = key_is(key, "map"), every = key_is(key, "every"), some = key_is(key, "some");
    yk r = map ? new_typed(t->type, new_buffer(len * size), 0, len) : YK_UNDEFINED;
    for (uint32_t i = 0; i < len; i++) {
      yk args[3] = {ta_get(t, i), yk_number(i), recv};
      yk got = call_value(a0, a1, 3, args);
      if (map) ta_set(typed_of(r), i, got);
      if (every && !yk_truthy(got)) return *out = YK_FALSE, 1;
      if (some && yk_truthy(got)) return *out = YK_TRUE, 1;
    }
    return *out = map ? r : every ? YK_TRUE : some ? YK_FALSE : YK_UNDEFINED, 1;
  }
  return 0;
}

static yk_array *typed_items_v(yk v) { return typed_items(typed_of(v)); }
static yk buffer_primitive(yk v) { return array_join(typed_items(typed_of(v)), str(ascii(","))); }

/* --- a program's entry: process, console, JSON.parse (#1333) ------------------------------------
 *
 * A program built by `yakcc build --native` runs its entry module from a generated main:
 * yk_main_begin(argc, argv), the entry's initializer, then yk_main_end(), which runs the jobs left and
 * gives the exit code (process.exitCode, else 0). An exception nothing catches ends the program with
 * exit code 1, as Node's does. These are the interim layer-0 primitives over the C library; #1365
 * moves them onto the system-call leaf.
 */

static int program_mode = 0;
static int program_argc = 0;
static char **program_argv = NULL;
static yk process_value = 0;

/* A string's UTF-8 bytes written to a stream (a lone surrogate as U+FFFD, as Node writes it). */
static void write_utf8(FILE *f, yk_string *s) {
  yk bytes = utf8_bytes(s);
  yk_view *t = typed_of(bytes);
  fwrite(view_bytes(t), 1, t->length, f);
}

/* A primitive as util.inspect writes it; an object stops the program (not in the runtime yet). */
static yk inspect_primitive(yk v, int top) {
  if (is_string(v)) {
    if (top) return v;
    type_error("console formatting of a string inside a structure is not in the native runtime yet");
  }
  if (is_number(v)) {
    double d = num(v);
    if (d == 0 && 1 / d < 0) return ascii("-0");
    return number_to_string(d);
  }
  if (is_bigint(v)) return concat(str(big_to_string_v(v)), str(ascii("n")));
  if (is_reference(v)) {
    fputs("TypeError: console formatting of an object is not in the native runtime yet\n", stderr);
    exit(70);
  }
  return to_string(v);
}

/* util.format: %s %d %i %f %j %o %O %c %% in a first string argument, then the rest, spaced. */
static yk format_args(uint64_t argc, const yk *argv) {
  yk out = ascii("");
  uint64_t next = 0;
  if (argc > 0 && is_string(argv[0])) {
    yk_string *f = str(argv[0]);
    next = 1;
    uint32_t last = 0;
    for (uint32_t i = 0; i + 1 < f->len; i++) {
      if (f->units[i] != '%') continue;
      uint16_t c = f->units[i + 1];
      yk piece = 0;
      if (c == '%') piece = ascii("%");
      else if (next < argc && (c == 's' || c == 'd' || c == 'i' || c == 'f' || c == 'j' || c == 'o' ||
                               c == 'O' || c == 'c')) {
        yk a = argv[next++];
        if (c == 's') piece = is_string(a) ? a : inspect_primitive(a, 1);
        else if (c == 'd') piece = is_bigint(a) ? inspect_primitive(a, 1) : is_reference(a) ? ascii("NaN") : inspect_primitive(yk_number(to_number(a)), 1);
        else if (c == 'i') {
          double d = is_reference(a) ? NAN : trunc(to_number(a));
          piece = is_bigint(a) ? inspect_primitive(a, 1) : inspect_primitive(yk_number(d), 1);
        } else if (c == 'f') piece = inspect_primitive(yk_number(string_to_number(str(to_string(a)))), 1);
        else if (c == 'j') piece = yk_call_method(yk_global("JSON", 4), "stringify", 9, 1, &a);
        else if (c == 'c') piece = ascii("");
        else piece = inspect_primitive(a, 1);
      }
      if (piece == 0) continue;
      yk_string *head = new_string(i - last);
      memcpy(head->units, f->units + last, (size_t)(i - last) * 2);
      out = concat(str(out), head);
      out = concat(str(out), str(piece));
      last = i + 2;
      i++;
    }
    yk_string *tail = new_string(f->len - last);
    memcpy(tail->units, f->units + last, (size_t)(f->len - last) * 2);
    out = concat(str(out), tail);
  }
  for (uint64_t k = next; k < argc; k++) {
    if (k > 0) out = concat(str(out), str(ascii(" ")));
    out = concat(str(out), str(inspect_primitive(argv[k], 1)));
  }
  return out;
}
static yk console_out(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  write_utf8(stdout, str(format_args(argc, argv)));
  fputc('\n', stdout);
  return YK_UNDEFINED;
}
static yk console_err(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  fflush(stdout);
  write_utf8(stderr, str(format_args(argc, argv)));
  fputc('\n', stderr);
  return YK_UNDEFINED;
}
static yk stream_write(FILE *f, uint64_t argc, const yk *argv) {
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  yk_view *t = typed_of(v);
  if (t != NULL) fwrite(view_bytes(t), 1, (size_t)t->length * ta_size[t->type], f);
  else if (is_string(v)) write_utf8(f, str(v));
  else type_error("The \"chunk\" argument must be of type string or an instance of Buffer or Uint8Array");
  return YK_TRUE;
}
static yk stdout_write(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return stream_write(stdout, argc, argv);
}
static yk stderr_write(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  fflush(stdout);
  return stream_write(stderr, argc, argv);
}
static int exit_code_of(void) {
  if (process_value == 0) return 0;
  yk code = yk_get(process_value, ascii("exitCode"));
  if (code == YK_UNDEFINED) return 0;
  return (int)(to_int32(code) & 0xff);
}
static yk process_exit(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  if (argc > 0 && argv[0] != YK_UNDEFINED) yk_set(process_value, ascii("exitCode"), argv[0]);
  fflush(stdout);
  fflush(stderr);
  exit(exit_code_of());
}

static yk with_one_method(const char *name, yk_code code) {
  yk o = yk_object_of(0, NULL, NULL);
  own_set((yk_object *)PTR(o), ascii(name), yk_closure_new(code, 0, 0, NULL));
  return o;
}

static yk process_global(void) {
  if (process_value != 0) return process_value;
  extern char **environ;
  yk p = yk_object_of(0, NULL, NULL);
  yk_object *o = (yk_object *)PTR(p);
  /* argv: Node's is [node, script, ...args]; a native program is its own interpreter and script. */
  yk_array *args = new_array(4);
  const char *self = program_argc > 0 ? program_argv[0] : "yakcc-native";
  push(args, ascii(self));
  push(args, ascii(self));
  for (int i = 1; i < program_argc; i++) push(args, ascii(program_argv[i]));
  own_set(o, ascii("argv"), BOX(T_ARRAY, args));
  yk env = yk_object_of(0, NULL, NULL);
  for (char **e = environ; e != NULL && *e != NULL; e++) {
    const char *eq = strchr(*e, '=');
    if (eq == NULL) continue;
    own_set((yk_object *)PTR(env), yk_string_utf8(*e, (uint64_t)(eq - *e)), ascii(eq + 1));
  }
  own_set(o, ascii("env"), env);
  own_set(o, ascii("platform"), ascii("linux"));
  own_set(o, ascii("exit"), yk_closure_new(process_exit, 0, 0, NULL));
  own_set(o, ascii("stdout"), with_one_method("write", stdout_write));
  own_set(o, ascii("stderr"), with_one_method("write", stderr_write));
  return process_value = p;
}
static yk console_global(void) {
  static yk c = 0;
  if (c != 0) return c;
  c = yk_object_of(0, NULL, NULL);
  yk_object *o = (yk_object *)PTR(c);
  const char *outs[3] = {"log", "info", "debug"};
  const char *errs[2] = {"error", "warn"};
  for (int i = 0; i < 3; i++) own_set(o, ascii(outs[i]), yk_closure_new(console_out, 0, 0, NULL));
  for (int i = 0; i < 2; i++) own_set(o, ascii(errs[i]), yk_closure_new(console_err, 0, 0, NULL));
  return c;
}

/* --- JSON.parse (ECMA-262 25.5.1): the strict grammar, else a SyntaxError; then the reviver --- */

typedef struct {
  yk_string *s;
  uint32_t i;
} json_reader;
static _Noreturn void json_error(json_reader *r) {
  (void)r;
  yk_throw(make_error("SyntaxError", ascii("Unexpected token in JSON")));
}
static void json_ws(json_reader *r) {
  while (r->i < r->s->len) {
    uint16_t c = r->s->units[r->i];
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
    r->i++;
  }
}
static int json_word(json_reader *r, const char *w) {
  size_t n = strlen(w);
  if (r->i + n > r->s->len) return 0;
  for (size_t k = 0; k < n; k++)
    if (r->s->units[r->i + k] != (uint16_t)w[k]) return 0;
  r->i += (uint32_t)n;
  return 1;
}
static yk json_string(json_reader *r) {
  r->i++; /* the opening quote */
  yk_array *units = new_array(8);
  for (;;) {
    if (r->i >= r->s->len) json_error(r);
    uint16_t c = r->s->units[r->i++];
    if (c == '"') break;
    if (c < 0x20) json_error(r);
    if (c != '\\') {
      push(units, yk_number(c));
      continue;
    }
    if (r->i >= r->s->len) json_error(r);
    uint16_t e = r->s->units[r->i++];
    uint16_t out;
    switch (e) {
    case '"': out = '"'; break;
    case '\\': out = '\\'; break;
    case '/': out = '/'; break;
    case 'b': out = 8; break;
    case 'f': out = 12; break;
    case 'n': out = 10; break;
    case 'r': out = 13; break;
    case 't': out = 9; break;
    case 'u': {
      if (r->i + 4 > r->s->len) json_error(r);
      out = 0;
      for (int k = 0; k < 4; k++) {
        uint16_t h = r->s->units[r->i++];
        int d = h >= '0' && h <= '9' ? h - '0' : h >= 'a' && h <= 'f' ? h - 'a' + 10 : h >= 'A' && h <= 'F' ? h - 'A' + 10 : -1;
        if (d < 0) json_error(r);
        out = (uint16_t)(out * 16 + d);
      }
      break;
    }
    default: json_error(r);
    }
    push(units, yk_number(out));
  }
  yk_string *s = new_string(units->len);
  for (uint32_t k = 0; k < units->len; k++) s->units[k] = (uint16_t)num(units->items[k]);
  return string_of(s);
}
static yk json_number(json_reader *r) {
  uint32_t start = r->i;
  if (r->i < r->s->len && r->s->units[r->i] == '-') r->i++;
  if (r->i >= r->s->len) json_error(r);
  if (r->s->units[r->i] == '0') r->i++;
  else if (r->s->units[r->i] >= '1' && r->s->units[r->i] <= '9')
    while (r->i < r->s->len && r->s->units[r->i] >= '0' && r->s->units[r->i] <= '9') r->i++;
  else
    json_error(r);
  if (r->i < r->s->len && r->s->units[r->i] == '.') {
    r->i++;
    if (!(r->i < r->s->len && r->s->units[r->i] >= '0' && r->s->units[r->i] <= '9')) json_error(r);
    while (r->i < r->s->len && r->s->units[r->i] >= '0' && r->s->units[r->i] <= '9') r->i++;
  }
  if (r->i < r->s->len && (r->s->units[r->i] == 'e' || r->s->units[r->i] == 'E')) {
    r->i++;
    if (r->i < r->s->len && (r->s->units[r->i] == '+' || r->s->units[r->i] == '-')) r->i++;
    if (!(r->i < r->s->len && r->s->units[r->i] >= '0' && r->s->units[r->i] <= '9')) json_error(r);
    while (r->i < r->s->len && r->s->units[r->i] >= '0' && r->s->units[r->i] <= '9') r->i++;
  }
  char *buf = alloc(r->i - start + 1);
  for (uint32_t k = start; k < r->i; k++) buf[k - start] = (char)r->s->units[k];
  buf[r->i - start] = 0;
  return yk_number(strtod(buf, NULL));
}
static yk json_value(json_reader *r) {
  json_ws(r);
  if (r->i >= r->s->len) json_error(r);
  uint16_t c = r->s->units[r->i];
  if (c == '"') return json_string(r);
  if (c == '-' || (c >= '0' && c <= '9')) return json_number(r);
  if (json_word(r, "true")) return YK_TRUE;
  if (json_word(r, "false")) return YK_FALSE;
  if (json_word(r, "null")) return YK_NULL;
  if (c == '[') {
    r->i++;
    yk_array *a = new_array(4);
    json_ws(r);
    if (r->i < r->s->len && r->s->units[r->i] == ']') {
      r->i++;
      return BOX(T_ARRAY, a);
    }
    for (;;) {
      push(a, json_value(r));
      json_ws(r);
      if (r->i >= r->s->len) json_error(r);
      uint16_t d = r->s->units[r->i++];
      if (d == ']') return BOX(T_ARRAY, a);
      if (d != ',') json_error(r);
    }
  }
  if (c == '{') {
    r->i++;
    yk o = yk_object_of(0, NULL, NULL);
    json_ws(r);
    if (r->i < r->s->len && r->s->units[r->i] == '}') {
      r->i++;
      return o;
    }
    for (;;) {
      json_ws(r);
      if (r->i >= r->s->len || r->s->units[r->i] != '"') json_error(r);
      yk k = json_string(r);
      json_ws(r);
      if (r->i >= r->s->len || r->s->units[r->i++] != ':') json_error(r);
      own_set((yk_object *)PTR(o), k, json_value(r));
      json_ws(r);
      if (r->i >= r->s->len) json_error(r);
      uint16_t d = r->s->units[r->i++];
      if (d == '}') return o;
      if (d != ',') json_error(r);
    }
  }
  json_error(r);
}
/* InternalizeJSONProperty: the holder's value at name, its elements' or properties' revived first
   (one revived to undefined deleted; an array element set to undefined: no holes here). */
static yk json_revive(yk holder, yk name, yk reviver) {
  yk val = yk_get(holder, name);
  if (is_array(val)) {
    yk_array *a = arr(val);
    for (uint32_t i = 0; i < a->len; i++) a->items[i] = json_revive(val, to_string(yk_number(i)), reviver);
  } else if (is_object(val)) {
    yk_array *keys = ordered_keys((yk_object *)PTR(val));
    for (uint32_t i = 0; i < keys->len; i++) {
      yk e = json_revive(val, keys->items[i], reviver);
      if (e == YK_UNDEFINED) yk_delete(val, keys->items[i]);
      else own_set((yk_object *)PTR(val), keys->items[i], e);
    }
  }
  yk args[2] = {name, val};
  return call_value(reviver, holder, 2, args);
}
static yk builtin_json_parse(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  json_reader r = {str(to_string(argc > 0 ? argv[0] : YK_UNDEFINED)), 0};
  yk v = json_value(&r);
  json_ws(&r);
  if (r.i != r.s->len) json_error(&r);
  if (argc > 1 && is_closure(argv[1])) {
    yk root = yk_object_of(0, NULL, NULL);
    own_set((yk_object *)PTR(root), ascii(""), v);
    return json_revive(root, ascii(""), argv[1]);
  }
  return v;
}

/* The generated main's: the arguments, and what an uncaught exception does. */
void yk_main_begin(int argc, char **argv) {
  program_mode = 1;
  program_argc = argc;
  program_argv = argv;
}
int yk_main_end(void) {
  yk_drain();
  fflush(stdout);
  fflush(stderr);
  return exit_code_of();
}

/* BigInt(x): a number (an integer, else a RangeError), a string (StringToBigInt, else a
   SyntaxError), a boolean, or a BigInt. */
static yk builtin_bigint(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk v = to_primitive(argc > 0 ? argv[0] : YK_UNDEFINED);
  if (is_number(v)) return big_from_double(num(v));
  return BOX(T_BIGINT, want_bigint(v));
}
/* BigInt.asUintN(bits, x) and asIntN: x modulo 2^bits, then (asIntN) the upper half negative. */
static yk big_as_n(uint64_t argc, const yk *argv, int is_signed) {
  uint32_t bits = to_index(argc > 0 ? argv[0] : YK_UNDEFINED, "Invalid value: not (convertible to) a safe integer");
  yk_bigint *x = want_bigint(argc > 1 ? argv[1] : YK_UNDEFINED);
  if (bits == 0) return big_from_u64(0, 0);
  uint32_t n = (bits + 31) / 32;
  uint32_t m = (x->len > n ? x->len : n) + 1;
  uint32_t *w = alloc((size_t)m * 4);
  twos(x, w, m);
  if (bits % 32 != 0) w[n - 1] &= (1u << (bits % 32)) - 1;
  for (uint32_t i = n; i < m; i++) w[i] = 0;
  yk_bigint *r = big_new(n);
  memcpy(r->d, w, (size_t)n * 4);
  yk u = big_box(r);
  if (is_signed && mag_bit(big(u), bits - 1)) {
    yk_bigint *p = big(big_shl_mag(big(big_from_u64(1, 0)), 0, bits));
    return big_add_signed(big(u), 0, p, 1);
  }
  return u;
}
static yk builtin_bigint_as_uint_n(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return big_as_n(argc, argv, 0);
}
static yk builtin_bigint_as_int_n(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return big_as_n(argc, argv, 1);
}

/* The constructors of the buffers and views, and TextEncoder, as global values; 0 if none. */
static yk buffer_global(const char *name, uint64_t n) {
  static yk fns[TA_COUNT + 3];
  for (int32_t k = 0; k < TA_COUNT; k++)
    if (strlen(ta_names[k]) == n && memcmp(ta_names[k], name, n) == 0) {
      if (fns[k] != 0) return fns[k];
      const char *const names[2] = {"from", "of"};
      const yk_code codes[2] = {ta_from_codes[k], ta_of_codes[k]};
      yk f = with_methods(ta_codes[k], 2, names, codes);
      yk_set(f, ascii("BYTES_PER_ELEMENT"), yk_number(ta_size[k]));
      return fns[k] = f;
    }
  if (n == 11 && memcmp(name, "ArrayBuffer", 11) == 0) {
    if (fns[TA_COUNT] == 0) {
      static const char *const names[1] = {"isView"};
      static const yk_code codes[1] = {builtin_array_buffer_is_view};
      fns[TA_COUNT] = with_methods(builtin_array_buffer, 1, names, codes);
    }
    return fns[TA_COUNT];
  }
  if (n == 6 && memcmp(name, "BigInt", 6) == 0) {
    static yk bigint_fn;
    if (bigint_fn == 0) {
      static const char *const names[2] = {"asUintN", "asIntN"};
      static const yk_code codes[2] = {builtin_bigint_as_uint_n, builtin_bigint_as_int_n};
      bigint_fn = with_methods(builtin_bigint, 2, names, codes);
    }
    return bigint_fn;
  }
  if (n == 8 && memcmp(name, "DataView", 8) == 0)
    return fns[TA_COUNT + 1] != 0 ? fns[TA_COUNT + 1] : (fns[TA_COUNT + 1] = yk_closure_new(builtin_data_view, 0, 0, NULL));
  if (n == 11 && memcmp(name, "TextEncoder", 11) == 0)
    return fns[TA_COUNT + 2] != 0 ? fns[TA_COUNT + 2] : (fns[TA_COUNT + 2] = yk_closure_new(builtin_text_encoder, 0, 0, NULL));
  return 0;
}
/* A buffer or view constructor's code: what `new` calls. */
static int is_buffer_code(yk_code code) {
  return type_of_code(code) >= 0 || code == builtin_array_buffer || code == builtin_data_view ||
         code == builtin_text_encoder;
}

/* The leaves as function values: each calls the leaf with its arguments (undefined past argc). */
#define LEAF_VALUE1(name, fn)                                                                   \
  static yk name(void *c, yk s, uint64_t argc, const yk *argv) {                                 \
    (void)c, (void)s;                                                                            \
    return fn(argc > 0 ? argv[0] : YK_UNDEFINED);                                                \
  }
#define LEAF_VALUE2(name, fn)                                                                   \
  static yk name(void *c, yk s, uint64_t argc, const yk *argv) {                                 \
    (void)c, (void)s;                                                                            \
    return fn(argc > 0 ? argv[0] : YK_UNDEFINED, argc > 1 ? argv[1] : YK_UNDEFINED);             \
  }
LEAF_VALUE2(leaf_v_i32mul, yk_leaf_i32mul)
LEAF_VALUE1(leaf_v_u64, yk_leaf_u64)
LEAF_VALUE1(leaf_v_i64, yk_leaf_i64)
LEAF_VALUE1(leaf_v_num_to_big, yk_leaf_num_to_big)
LEAF_VALUE1(leaf_v_big_to_i32, yk_leaf_big_to_i32)
LEAF_VALUE1(leaf_v_big_to_u32, yk_leaf_big_to_u32)
LEAF_VALUE1(leaf_v_big_to_f64, yk_leaf_big_to_f64)
LEAF_VALUE1(leaf_v_f64_to_i64, yk_leaf_f64_to_i64)
LEAF_VALUE1(leaf_v_f64_bits, yk_leaf_f64_bits)
LEAF_VALUE1(leaf_v_f64_from_bits, yk_leaf_f64_from_bits)
LEAF_VALUE1(leaf_v_f64_hi, yk_leaf_f64_hi)
LEAF_VALUE1(leaf_v_f64_lo, yk_leaf_f64_lo)
LEAF_VALUE2(leaf_v_f64_make, yk_leaf_f64_make)
#define N_LEAVES 13
static yk leaf_value(const char *name, uint64_t n) {
  static const char *names[N_LEAVES] = {"__ykI32Mul", "__ykU64", "__ykI64", "__ykNumToBig",
                                        "__ykBigToI32", "__ykBigToU32", "__ykBigToF64",
                                        "__ykF64ToI64", "__ykF64Bits", "__ykF64FromBits",
                                        "__ykF64Hi", "__ykF64Lo", "__ykF64Make"};
  static const yk_code codes[N_LEAVES] = {leaf_v_i32mul, leaf_v_u64, leaf_v_i64, leaf_v_num_to_big,
                                          leaf_v_big_to_i32, leaf_v_big_to_u32, leaf_v_big_to_f64,
                                          leaf_v_f64_to_i64, leaf_v_f64_bits, leaf_v_f64_from_bits,
                                          leaf_v_f64_hi, leaf_v_f64_lo, leaf_v_f64_make};
  static yk fns[N_LEAVES];
  for (int i = 0; i < N_LEAVES; i++)
    if (strlen(names[i]) == n && memcmp(names[i], name, n) == 0)
      return fns[i] != 0 ? fns[i] : (fns[i] = yk_closure_new(codes[i], 0, 0, NULL));
  return 0;
}

#define N_GLOBALS 23
yk yk_global(const char *name, uint64_t n) {
  if (n > 4 && memcmp(name, "__yk", 4) == 0) {
    yk leaf = leaf_value(name, n);
    if (leaf != 0) return leaf;
  }
  {
    yk b = buffer_global(name, n);
    if (b != 0) return b;
  }
  if (n == 7 && memcmp(name, "process", 7) == 0) return process_global();
  if (n == 7 && memcmp(name, "console", 7) == 0) return console_global();
  if (n == 3 && memcmp(name, "NaN", 3) == 0) return yk_number(NAN);
  if (n == 8 && memcmp(name, "Infinity", 8) == 0) return yk_number(INFINITY);
  static yk fns[N_GLOBALS];
  static const char *names[N_GLOBALS] = {"String", "Number", "Boolean", "parseFloat", "parseInt",
                                         "isNaN", "isFinite", "Array", "globalThis", "__yakccTry",
                                         "Error", "TypeError", "RangeError", "SyntaxError",
                                         "Map", "Set", "Object", "JSON", "Symbol", "Promise",
                                         "__yakccTryAsync", "queueMicrotask", "__yakccTryGen"};
  static yk_code codes[N_GLOBALS] = {builtin_string, builtin_number, builtin_boolean,
                                     builtin_parse_float, builtin_parse_int, builtin_is_nan,
                                     builtin_is_finite, builtin_array, NULL, builtin_try,
                                     builtin_error, builtin_type_error, builtin_range_error,
                                     builtin_syntax_error, builtin_map, builtin_set, builtin_object,
                                     NULL, NULL, builtin_promise, try_async_body,
                                     builtin_queue_microtask, try_gen_code};
  for (int i = 0; i < N_GLOBALS; i++)
    if (strlen(names[i]) == n && memcmp(names[i], name, n) == 0) {
      if (fns[i] != 0) return fns[i];
      if (strcmp(names[i], "JSON") == 0) {
        static const char *const m[2] = {"stringify", "parse"};
        static const yk_code k[2] = {builtin_json_stringify, builtin_json_parse};
        return fns[i] = with_methods(NULL, 2, m, k);
      }
      if (codes[i] == NULL) return YK_UNDEFINED;
      if (codes[i] == builtin_promise) {
        static const char *const m[5] = {"resolve", "reject", "all", "allSettled", "race"};
        static const yk_code k[5] = {promise_static_resolve, promise_static_reject, promise_static_all,
                                     promise_static_all_settled, promise_static_race};
        return fns[i] = with_methods(builtin_promise, 5, m, k);
      }
      if (codes[i] == try_async_body) return fns[i] = yk_closure_mode(yk_closure_new(try_async_body, 0, 0, NULL), 1);
      if (codes[i] == try_gen_code) return fns[i] = yk_closure_mode(yk_closure_new(try_gen_code, 0, 0, NULL), 2);
      if (codes[i] == builtin_array) {
        static const char *const m[2] = {"from", "isArray"};
        static const yk_code k[2] = {builtin_array_from, builtin_array_is_array};
        return fns[i] = with_methods(builtin_array, 2, m, k);
      }
      if (codes[i] == builtin_number) {
        static const char *const m[6] = {"isFinite", "isInteger", "isSafeInteger", "isNaN", "parseFloat", "parseInt"};
        static const yk_code k[6] = {builtin_number_is_finite, builtin_number_is_integer,
                                     builtin_number_is_safe_integer, builtin_number_is_nan,
                                     builtin_parse_float, builtin_parse_int};
        yk f = with_methods(builtin_number, 6, m, k);
        static const char *const cn[8] = {"MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER", "EPSILON", "MAX_VALUE",
                                          "MIN_VALUE", "POSITIVE_INFINITY", "NEGATIVE_INFINITY", "NaN"};
        const double cv[8] = {9007199254740991.0, -9007199254740991.0, 2.220446049250313e-16, 1.7976931348623157e308,
                              5e-324, INFINITY, -INFINITY, NAN};
        for (int j = 0; j < 8; j++) yk_set(f, ascii(cn[j]), yk_number(cv[j]));
        return fns[i] = f;
      }
      if (codes[i] == builtin_object) {
        static const char *const m[6] = {"keys", "values", "entries", "assign", "freeze", "is"};
        static const yk_code k[6] = {builtin_object_keys, builtin_object_values, builtin_object_entries,
                                     builtin_object_assign, builtin_identity, builtin_object_is};
        return fns[i] = with_methods(builtin_object, 6, m, k);
      }
      return fns[i] = yk_closure_new(codes[i], 0, 0, NULL);
    }
  return YK_UNDEFINED;
}

/* new F(…): the constructors the runtime has (Array). */
yk yk_new(yk f, uint64_t argc, const yk *argv) {
  if (is_closure(f)) {
    yk_code code = ((yk_closure *)PTR(f))->code;
    if (code == builtin_promise) return promise_construct(argc, argv);
    if (((yk_closure *)PTR(f))->mode != 0) type_error("this function is not a constructor");
    if (is_buffer_code(code)) return code(NULL, YK_UNDEFINED, argc, argv);
    if (code == builtin_array || code == builtin_error || code == builtin_type_error ||
        code == builtin_range_error || code == builtin_syntax_error || code == builtin_map ||
        code == builtin_set || code == builtin_object)
      return code(NULL, YK_UNDEFINED, argc, argv);
    /* A class, or a `function`: an object inheriting its prototype, given to it as `this`. */
    yk_closure *c = (yk_closure *)PTR(f);
    if (c->is_class || c->has_this) {
      yk o = yk_object_of(0, NULL, NULL);
      ((yk_object *)PTR(o))->proto = ensure_prototype(f);
      /* A base class's fields are the instance's before its constructor's body runs (#1330). */
      if (c->is_class && c->parent == 0) init_fields(f, o);
      yk r = c->code(c, o, argc, argv);
      return is_reference(r) ? r : o;
    }
  }
  type_error("this constructor is not in the runtime yet");
  return YK_UNDEFINED;
}

/* a instanceof F, for the constructors the runtime has: Array, and the Error family. */
yk yk_instanceof(yk v, yk f) {
  if (!is_closure(f)) type_error("Right-hand side of 'instanceof' is not callable");
  yk_code code = ((yk_closure *)PTR(f))->code;
  if (code == builtin_array) return yk_bool(is_array(v));
  if (type_of_code(code) >= 0) return yk_bool(typed_of(v) != NULL && typed_of(v)->type == type_of_code(code));
  if (code == builtin_array_buffer) return yk_bool(buffer_of(v) != NULL);
  if (code == builtin_data_view) return yk_bool(dataview_of(v) != NULL);
  if (code == builtin_promise) return yk_bool(is_promise(v));
  if (code == builtin_error || code == builtin_type_error || code == builtin_range_error ||
      code == builtin_syntax_error) {
    if (!is_object(v) || !((yk_object *)PTR(v))->error) return YK_FALSE;
    if (code == builtin_error) return YK_TRUE;
    yk name;
    own_get((yk_object *)PTR(v), ascii("name"), &name);
    const char *want = code == builtin_type_error ? "TypeError" : code == builtin_range_error ? "RangeError" : "SyntaxError";
    return yk_bool(strict_equal(name, ascii(want)));
  }
  yk_closure *c = (yk_closure *)PTR(f);
  if (c->is_class || c->has_this) {
    yk proto = ensure_prototype(f);
    for (yk o = is_object(v) ? ((yk_object *)PTR(v))->proto : 0; o != 0 && is_object(o); o = ((yk_object *)PTR(o))->proto)
      if (o == proto) return YK_TRUE;
  }
  return YK_FALSE;
}

/* --- spread: a list's items, each spread one expanded (…xs) --- */

yk yk_spread_list(uint64_t n, const yk *items, const yk *spread) {
  yk_array *r = new_array((uint32_t)n);
  for (uint64_t i = 0; i < n; i++) {
    if (spread[i] != YK_TRUE) {
      push(r, items[i]);
      continue;
    }
    if (is_nullish(items[i])) type_error("the spread value is not iterable");
    yk_array *more = iterable_items(items[i]);
    for (uint32_t j = 0; j < more->len; j++) push(r, more->items[j]);
  }
  return BOX(T_ARRAY, r);
}
yk yk_call_spread(yk f, yk self, yk args) { return call_value(f, self, arr(args)->len, arr(args)->items); }
yk yk_call_method_spread(yk recv, const char *name, uint64_t n, yk args) {
  return yk_call_method(recv, name, n, arr(args)->len, arr(args)->items);
}
yk yk_new_spread(yk f, yk args) { return yk_new(f, arr(args)->len, arr(args)->items); }

/* {…src}: src's own enumerable properties, copied in order (a getter's value, not the getter). */
yk yk_spread_into(yk obj, yk src) {
  if (is_nullish(src) || is_number(src) || is_bool(src)) return obj;
  yk_object *o = (yk_object *)PTR(obj);
  if (is_array(src) || is_string(src)) {
    uint32_t n = is_array(src) ? arr(src)->len : str(src)->len;
    for (uint32_t i = 0; i < n; i++) own_set(o, to_string(yk_number(i)), yk_get(src, yk_number(i)));
    return obj;
  }
  if (is_closure(src) && ((yk_closure *)PTR(src))->props == 0) return obj;
  yk_object *from = own_props(src);
  if (from->kind != 0) return obj;
  yk_array *keys = ordered_keys(from);
  for (uint32_t i = 0; i < keys->len; i++) {
    yk slot;
    own_get(from, keys->items[i], &slot);
    own_set(o, keys->items[i], resolve_slot(slot, src));
  }
  return obj;
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

yk yk_math_minmax(int max, uint64_t argc, const yk *argv);
/* Math.min(...xs) / Math.max(...xs): the expanded list. */
yk yk_math_minmax_list(int max, yk list) { return yk_math_minmax(max, arr(list)->len, arr(list)->items); }
yk yk_math_minmax(int max, uint64_t argc, const yk *argv) {
  double r = max ? -INFINITY : INFINITY;
  for (uint64_t i = 0; i < argc; i++) r = minmax(max, r, to_number(argv[i]));
  return yk_number(r);
}

/* --- the host boundary: values in a line-oriented text form --- */
/*   n<16 hex digits>  a number, by its bits    s<count>:<4 hex digits per code unit>  a string
 *   u  undefined   l  null   t  true   f  false   a<count> then the elements
 *   b<decimal digits>  a BigInt                                                         */

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
  if (c == 'b') {
    /* A BigInt: its decimal digits, a minus first if negative. */
    char buf[4096];
    if (fscanf(in, "%4095[-0-9]", buf) != 1) exit(65);
    int neg = buf[0] == '-';
    size_t n = strlen(buf + neg);
    uint16_t *u = alloc(n * 2 + 2);
    for (size_t i = 0; i < n; i++) u[i] = (uint8_t)buf[neg + i];
    yk v = big_from_units(u, (uint32_t)n, 1);
    return neg ? big_negate(v) : v;
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
  } else if (is_object(v) && ((yk_object *)PTR(v))->kind == 7) {
    /* A typed array: its elements, as an array's. */
    yk_write(out, BOX(T_ARRAY, typed_items_v(v)));
  } else if (is_object(v)) {
    yk_object *o = (yk_object *)PTR(v);
    yk_array *keys = ordered_keys(o);
    fprintf(out, "o%u", keys->len);
    for (uint32_t i = 0; i < keys->len; i++) {
      yk value;
      own_get(o, keys->items[i], &value);
      value = resolve_slot(value, v);
      fputc(' ', out);
      yk_write(out, keys->items[i]);
      fputc(' ', out);
      yk_write(out, value);
    }
  } else if (is_closure(v))
    fputc('F', out);
  else if (is_bigint(v)) {
    yk_string *s = str(big_to_string_v(v));
    fputc('b', out);
    for (uint32_t i = 0; i < s->len; i++) fputc((char)s->units[i], out);
  } else
    fputc(v == YK_UNDEFINED ? 'u' : v == YK_NULL ? 'l' : v == YK_TRUE ? 't' : 'f', out);
}
