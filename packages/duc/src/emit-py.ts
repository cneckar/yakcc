import { bodyPathOf, isPrefix, joinOwners, printLineForm, sidePath } from "./line-form.js";
import { ecmaScriptView } from "./ops.js";
import { loweringView } from "./ordering.js";
// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering a DUC graph to Python (#1278, vision 2: the graph is lowered directly to each target).
 *
 * The graph's operations have JavaScript's meaning (TypeScript is the reference language), so the
 * lowering keeps that meaning in Python: a small prelude gives JavaScript's `+`, `/`, `%`, `===`,
 * truthiness, `typeof`, string conversion, and `undefined` (a value of its own, apart from `None`,
 * which is `null`). Member reads on records are dictionary reads that give `undefined` for a missing
 * key. Known methods of strings and arrays, and members of `Math`, map to their Python forms.
 *
 * Anything else is refused with a reason (`PyEmitError`), never guessed: an unknown method, a
 * construct the line form does not express, an opaque node.
 */
import { isPrimitiveParam, isRestParam, paramIndex, readsOwnReceiver } from "./params.js";
import type { DucBranch, DucGraph, DucLoop, DucNode, NodeId, ValueId } from "./types.js";

export class PyEmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PyEmitError";
  }
}

/** JavaScript's meaning, in Python: the prelude every lowered module starts with. */
export const PY_PRELUDE = `import functools
import math
import re


class _Undefined:
    __slots__ = ()

    def __repr__(self):
        return "undefined"


UNDEFINED = _Undefined()


class JsThrow(Exception):
    def __init__(self, value):
        super().__init__(value)
        self.value = value


class JsError(Exception):
    def __init__(self, message=UNDEFINED, kind="Error"):
        super().__init__(message)
        self.message = "" if message is UNDEFINED else _str(message)
        self.kind = kind


def _isnum(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _truthy(x):
    if x is None or x is UNDEFINED or x is False:
        return False
    if _isnum(x):
        return x != 0 and not (isinstance(x, float) and math.isnan(x))
    if isinstance(x, str):
        return x != ""
    return True


def _num(x):
    if isinstance(x, bool):
        return 1 if x else 0
    if x is None:
        return 0
    if _isnum(x):
        return x
    if isinstance(x, str):
        s = x.strip()
        if s == "":
            return 0
        try:
            return int(s) if s.lstrip("+-").isdigit() else float(s)
        except ValueError:
            return math.nan
    return math.nan


def _numstr(x):
    if isinstance(x, int):
        return str(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    # Number::toString: the shortest round-trip digits, laid out as ECMA-262 says.
    sign = "-" if x < 0 else ""
    r = repr(abs(x))
    mant, _, exp = r.partition("e")
    point = mant.find(".")
    digits = mant.replace(".", "")
    n = (len(mant) if point < 0 else point) + (int(exp) if exp else 0)
    stripped = digits.lstrip("0")
    n -= len(digits) - len(stripped)
    digits = stripped.rstrip("0") or "0"
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    es = ("+" if e >= 0 else "-") + str(abs(e))
    return sign + digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + es


def _str(x):
    if isinstance(x, str):
        return x
    if x is None:
        return "null"
    if x is UNDEFINED:
        return "undefined"
    if isinstance(x, bool):
        return "true" if x else "false"
    if _isnum(x):
        return _numstr(x)
    if isinstance(x, list):
        return ",".join("" if e is None or e is UNDEFINED else _str(e) for e in x)
    if isinstance(x, dict):
        return "[object Object]"
    return str(x)


def _add(a, b):
    if isinstance(a, (str, list, dict)) or isinstance(b, (str, list, dict)):
        return _str(a) + _str(b)
    return _num(a) + _num(b)


def _div(a, b):
    a, b = _num(a), _num(b)
    if b == 0:
        if a == 0 or (isinstance(a, float) and math.isnan(a)):
            return math.nan
        return math.inf if (a > 0) == (math.copysign(1, b) > 0) else -math.inf
    return a / b


def _rem(a, b):
    a, b = _num(a), _num(b)
    if b == 0:
        return math.nan
    if isinstance(a, int) and isinstance(b, int):
        r = abs(a) % abs(b)
        # The remainder has the dividend's sign, zero included: -4 % 2 is -0.
        if a < 0:
            return -r if r != 0 else -0.0
        return r
    return math.fmod(a, b)


def _int32(x):
    # ToInt32: truncate toward zero, then wrap to 32 bits; NaN and the infinities are 0.
    n = _num(x)
    if n != n or math.isinf(n):
        return 0
    n = int(n) & 0xFFFFFFFF
    return n - 0x100000000 if n >= 0x80000000 else n


def _uint32(x):
    return _int32(x) & 0xFFFFFFFF


def _shl(a, b):
    return _int32(_int32(a) << (_uint32(b) & 31))


def _shr(a, b):
    return _int32(a) >> (_uint32(b) & 31)


def _ushr(a, b):
    return _uint32(a) >> (_uint32(b) & 31)


def _band(a, b):
    return _int32(a) & _int32(b)


def _bor(a, b):
    return _int32(_int32(a) | _int32(b))


def _bxor(a, b):
    return _int32(_int32(a) ^ _int32(b))


def _bnot(a):
    return _int32(~_int32(a))


def _seq(a, b):
    if _isnum(a) and _isnum(b):
        return a == b
    if type(a) is not type(b):
        return False
    if isinstance(a, (str, bool)) or a is None or a is UNDEFINED:
        return a == b
    return a is b


def _typeof(x):
    if x is UNDEFINED:
        return "undefined"
    if isinstance(x, bool):
        return "boolean"
    if _isnum(x):
        return "number"
    if isinstance(x, str):
        return "string"
    if callable(x):
        return "function"
    return "object"


def _get(o, k):
    if isinstance(o, dict):
        return o.get(k, UNDEFINED)
    if k == "length" and isinstance(o, (str, list)):
        return len(o)
    if isinstance(o, JsError):
        # A caught error: its message and its name.
        return o.message if k == "message" else o.kind if k == "name" else UNDEFINED
    if o is None or o is UNDEFINED:
        raise JsError("Cannot read properties of " + _str(o) + " (reading '" + k + "')", "TypeError")
    return UNDEFINED


def _idx(o, i):
    if isinstance(o, (list, str)):
        if _isnum(i) and i == int(i) and 0 <= int(i) < len(o):
            return o[int(i)]
        return UNDEFINED
    if isinstance(o, dict):
        return o.get(_str(i), UNDEFINED)
    if o is None or o is UNDEFINED:
        raise JsError("Cannot read properties of " + _str(o), "TypeError")
    return UNDEFINED


def _put(o, k, v):
    o[k] = v
    return o


def _keys(o):
    if isinstance(o, dict):
        return list(o.keys())
    if isinstance(o, (list, str)):
        return [str(i) for i in range(len(o))]
    return []


def _values(o):
    if isinstance(o, (list, str)):
        return list(o)
    raise JsError(_str(o) + " is not iterable", "TypeError")


def _round(x):
    return math.floor(_num(x) + 0.5)


def _position(pos, default):
    # ToIntegerOrInfinity: NaN is 0, a fraction is truncated toward zero.
    if pos is UNDEFINED:
        return default
    p = _num(pos)
    if p != p:
        return 0
    if math.isinf(p):
        return p
    return int(p)


def _index_of(s, x=UNDEFINED, pos=UNDEFINED):
    p = _position(pos, 0)
    if isinstance(s, str):
        return s.find(_str(x), int(min(max(p, 0), len(s))))
    start = int(max(len(s) + p, 0) if p < 0 else min(p, len(s)))
    for i in range(start, len(s)):
        if _seq(s[i], x):
            return i
    return -1


def _last_index_of(s, x=UNDEFINED, pos=UNDEFINED):
    if isinstance(s, str):
        t = _str(x)
        n = _num(pos) if pos is not UNDEFINED else math.nan
        p = len(s) if n != n else int(min(max(_position(pos, 0), 0), len(s)))
        return s.rfind(t, 0, min(p + len(t), len(s)))
    p = _position(pos, len(s) - 1)
    start = int(len(s) + p if p < 0 else min(p, len(s) - 1))
    for i in range(start, -1, -1):
        if _seq(s[i], x):
            return i
    return -1


def _includes(s, x=UNDEFINED):
    if isinstance(s, str):
        return _str(x) in s
    return any(_seq(e, x) or (isinstance(e, float) and isinstance(x, float) and math.isnan(e) and math.isnan(x)) for e in s)


def _slice(s, start=UNDEFINED, end=UNDEFINED):
    n = len(s)
    a = 0 if start is UNDEFINED else int(_num(start))
    b = n if end is UNDEFINED else int(_num(end))
    a = max(n + a, 0) if a < 0 else min(a, n)
    b = max(n + b, 0) if b < 0 else min(b, n)
    return s[a:b] if a < b else s[0:0]


def _substring(s, start=UNDEFINED, end=UNDEFINED):
    n = len(s)
    def clamp(x, d):
        if x is UNDEFINED:
            return d
        v = _num(x)
        if isinstance(v, float) and math.isnan(v):
            return 0
        return max(0, min(int(v), n))
    a, b = clamp(start, 0), clamp(end, n)
    return s[min(a, b):max(a, b)]


def _split(s, sep=UNDEFINED):
    if sep is UNDEFINED:
        return [s]
    if isinstance(sep, JsRegExp):
        # String.prototype.split with a RegExp (ECMA-262 22.2.6.14): a match at the current
        # position that is empty there does not split; captures are spliced in.
        r = sep.compiled
        if s == "":
            return [] if r.match(s) else [s]
        out, p, q = [], 0, 0
        while q < len(s):
            m = r.match(s, q)
            if m is None or m.end() == p:
                q += 1
                continue
            out.append(s[p:q])
            out.extend(UNDEFINED if g is None else g for g in m.groups())
            p = q = m.end()
        out.append(s[p:])
        return out
    return list(s) if sep == "" else s.split(sep)


def _join(xs, sep=","):
    sep = "," if sep is UNDEFINED else _str(sep)
    return sep.join("" if e is None or e is UNDEFINED else _str(e) for e in xs)


def _parse_int(s, radix=UNDEFINED):
    t = _str(s).strip()
    base = 10 if radix is UNDEFINED or _num(radix) == 0 else int(_num(radix))
    sign = -1 if t.startswith("-") else 1
    t = t.lstrip("+-")
    if base == 16 and t[:2].lower() == "0x":
        t = t[2:]
    digits = ""
    for ch in t:
        if ch.isdigit() and int(ch) < base or ch.isalpha() and 10 <= int(ch, 36) < base:
            digits += ch
        else:
            break
    return sign * int(digits, base) if digits else math.nan


def _parse_float(s):
    import re
    m = re.match(r"\\s*[+-]?(\\d+\\.?\\d*([eE][+-]?\\d+)?|\\.\\d+([eE][+-]?\\d+)?|Infinity)", _str(s))
    if m is None:
        return math.nan
    t = m.group(0).strip()
    return math.copysign(math.inf, -1 if t.startswith("-") else 1) if t.lstrip("+-") == "Infinity" else float(t)


def _isnan(x):
    x = _num(x)
    return isinstance(x, float) and math.isnan(x)


class JsRegExp:
    def __init__(self, compiled, is_global):
        self.compiled = compiled
        self.is_global = is_global


@functools.lru_cache(maxsize=None)
def _re(pattern, flags, is_global):
    import re
    return JsRegExp(re.compile(pattern, flags), is_global)


def _test(r, s=UNDEFINED):
    return r.compiled.search(_str(s)) is not None


def _replace(s, pattern=UNDEFINED, replacement=UNDEFINED):
    if isinstance(pattern, JsRegExp):
        import re
        rep = _str(replacement)
        # $1, $& and $$ in JavaScript's replacement text, as Python's.
        py = rep.replace("\\\\", "\\\\\\\\")
        py = re.sub(r"\\$(\\d{1,2})", r"\\\\g<\\1>", py).replace("$&", "\\\\g<0>").replace("$$", "$")
        return pattern.compiled.sub(py, s, count=0 if pattern.is_global else 1)
    return s.replace(_str(pattern), _str(replacement), 1)


def _push(xs, *items):
    xs.extend(items)
    return len(xs)


def _pop(xs):
    return xs.pop() if xs else UNDEFINED


def _map(xs, f):
    return [f(e, i, xs) for i, e in enumerate(list(xs))]


def _filter(xs, f):
    return [e for i, e in enumerate(list(xs)) if _truthy(f(e, i, xs))]


def _for_each(xs, f):
    for i, e in enumerate(list(xs)):
        f(e, i, xs)
    return UNDEFINED


def _some(xs, f):
    return any(_truthy(f(e, i, xs)) for i, e in enumerate(list(xs)))


def _every(xs, f):
    return all(_truthy(f(e, i, xs)) for i, e in enumerate(list(xs)))


def _find(xs, f):
    for i, e in enumerate(list(xs)):
        if _truthy(f(e, i, xs)):
            return e
    return UNDEFINED


def _find_index(xs, f):
    for i, e in enumerate(list(xs)):
        if _truthy(f(e, i, xs)):
            return i
    return -1


_NO_INIT = object()


def _reduce(xs, f, init=_NO_INIT):
    items = list(xs)
    if init is _NO_INIT:
        if not items:
            raise JsError("Reduce of empty array with no initial value", "TypeError")
        acc, start = items[0], 1
    else:
        acc, start = init, 0
    for i in range(start, len(items)):
        acc = f(acc, items[i], i, xs)
    return acc


def _max(*xs):
    # Math.max: NaN if any argument is NaN, and +0 is larger than -0.
    r = -math.inf
    for x in xs:
        n = _num(x)
        if n != n:
            return math.nan
        if n > r or (n == 0 and r == 0 and math.copysign(1, r) < 0):
            r = n
    return r


def _min(*xs):
    # Math.min: NaN if any argument is NaN, and -0 is smaller than +0.
    r = math.inf
    for x in xs:
        n = _num(x)
        if n != n:
            return math.nan
        if n < r or (n == 0 and r == 0 and math.copysign(1, n) < 0):
            r = n
    return r


def _try(body, handler, finalizer=UNDEFINED):
    # A try statement as the lifter writes it (#1276): the handler gets what the body threw (with no
    # handler, the throw goes on); the finalizer runs however that ends, and its return wins.
    try:
        try:
            return body()
        except JsThrow as t:
            if handler is UNDEFINED:
                raise
            return handler(t.value)
        except JsError as e:
            if handler is UNDEFINED:
                raise
            return handler(e)
    finally:
        if finalizer is not UNDEFINED:
            done = finalizer()
            if isinstance(done, list) and len(done) > 0 and done[0] == 1:
                return done


# Each graph operation is a function of its own, so the lowering can be raised back (#1278).

NONE = UNDEFINED
_JS_NAN = math.nan
_JS_INF = math.inf


def _uninit():
    return UNDEFINED


def _platform(name):
    return UNDEFINED


def _unread(f):
    return None


def _sub(a, b):
    return _num(a) - _num(b)


def _mul(a, b):
    return _num(a) * _num(b)


def _pow(a, b):
    return _num(a) ** _num(b)


def _lt(a, b):
    return a < b


def _gt(a, b):
    return a > b


def _le(a, b):
    return a <= b


def _ge(a, b):
    return a >= b


def _sne(a, b):
    return not _seq(a, b)


def _and(a, b):
    return b if _truthy(a) else a


def _or(a, b):
    return a if _truthy(a) else b


def _is_nullish(a):
    return a is None or a is UNDEFINED


def _nullish(a, b):
    return b if _is_nullish(a) else a


def _has_key(k, o):
    # \`k in o\`: a TypeError on a value that is not an object, as in JavaScript.
    if o is None or o is UNDEFINED or isinstance(o, (bool, str)) or _isnum(o):
        raise JsError("Cannot use 'in' operator to search for '" + _str(k) + "' in " + _str(o), "TypeError")
    if isinstance(o, list):
        key = _str(k)
        return key == "length" or (key.isdigit() and (key == "0" or not key.startswith("0")) and int(key) < len(o))
    return _str(k) in o


def _idx_opt(o, i):
    return UNDEFINED if _is_nullish(o) else _idx(o, i)


def _get_opt(o, k):
    return UNDEFINED if _is_nullish(o) else _get(o, k)


def _comma(a, b):
    return b


def _not(a):
    return not _truthy(a)


def _neg(a):
    return -_num(a)


def _pos(a):
    return _num(a)


def _void_of(a):
    return UNDEFINED


def _sel(c, a, b):
    return a if _truthy(c) else b


def _lazy_and(c, f):
    return f() if _truthy(c) else c


def _lazy_or(c, f):
    return c if _truthy(c) else f()


def _lazy_sel(c, f, g):
    return f() if _truthy(c) else g()


def _call(f, *args):
    return f(*args)


def _call_detached(f, *args):
    return f(*args)


def _call_opt(f, *args):
    return UNDEFINED if _is_nullish(f) else f(*args)


def _new_error(kind, message=UNDEFINED):
    return JsError(message, kind)


def _call_error(kind, message=UNDEFINED):
    return JsError(message, kind)


def _throw(x):
    if isinstance(x, JsError):
        raise x
    raise JsThrow(x)


def _trim(s):
    return s.strip()


def _trim_start(s):
    return s.lstrip()


def _trim_end(s):
    return s.rstrip()


def _to_upper(s):
    return s.upper()


def _to_lower(s):
    return s.lower()


def _starts_with(s, x=""):
    return s.startswith(_str(x))


def _ends_with(s, x=""):
    return s.endswith(_str(x))


def _repeat(s, n=0):
    return s * int(_num(n))


def _char_at(s, i=0):
    return _str(_idx(s, i)).replace("undefined", "")


def _char_code_at(s, i=0):
    return ord(s[int(_num(i))])


def _concat(s, *xs):
    return s + "".join(_str(x) for x in xs)


def _to_string_m(x, radix=UNDEFINED):
    if radix is UNDEFINED or not _isnum(x) or _num(radix) == 10:
        return _str(x)
    r = int(_num(radix))
    if r < 2 or r > 36:
        raise JsError("toString() radix must be between 2 and 36", "RangeError")
    if math.isnan(x) or math.isinf(x):
        return _str(x)
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    neg = x < 0
    a = abs(x)
    ip = int(a)
    frac = a - ip
    out = ""
    while True:
        out = digits[ip % r] + out
        ip //= r
        if ip == 0:
            break
    if frac > 0:
        out += "."
        count = 0
        while frac > 0 and count < 52:
            frac *= r
            d = int(frac)
            out += digits[d]
            frac -= d
            count += 1
    return "-" + out if neg else out


def _math_abs(x):
    return abs(_num(x))


def _rounded(f, x):
    # Math.floor / ceil / trunc: NaN and the infinities are themselves, and a zero result keeps the
    # sign of a negative argument (-0), as in JavaScript.
    x = _num(x)
    if isinstance(x, float) and (x != x or math.isinf(x)):
        return x
    r = f(x)
    if r == 0 and (x < 0 or (x == 0 and math.copysign(1, x) < 0)):
        return -0.0
    return r


def _math_floor(x):
    return _rounded(math.floor, x)


def _math_ceil(x):
    return _rounded(math.ceil, x)


def _math_trunc(x):
    return _rounded(math.trunc, x)


def _math_sqrt(x):
    return math.sqrt(_num(x))


def _math_pow(a, b):
    return _num(a) ** _num(b)


def _object_keys(x):
    return _keys(x)


def _is_array(x):
    return isinstance(x, list)


_JSON_ESCAPES = {'"': '\\\\"', "\\\\": "\\\\\\\\", "\\b": "\\\\b", "\\f": "\\\\f", "\\n": "\\\\n", "\\r": "\\\\r", "\\t": "\\\\t"}


def _json_quote(s):
    out = ['"']
    for ch in s:
        c = ord(ch)
        if ch in _JSON_ESCAPES:
            out.append(_JSON_ESCAPES[ch])
        elif c < 0x20 or 0xD800 <= c <= 0xDFFF:
            out.append("\\\\u%04x" % c)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _json_str(x):
    """JSON.stringify's SerializeJSONProperty: the text, or None where JavaScript gives undefined."""
    if x is UNDEFINED:
        return None
    if x is None:
        return "null"
    if isinstance(x, bool):
        return "true" if x else "false"
    if _isnum(x):
        if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
            return "null"
        return _numstr(x)
    if isinstance(x, str):
        return _json_quote(x)
    if isinstance(x, list):
        return "[" + ",".join("null" if (t := _json_str(e)) is None else t for e in x) + "]"
    if isinstance(x, dict):
        parts = []
        for k, v in x.items():
            t = _json_str(v)
            if t is not None:
                parts.append(_json_quote(k) + ":" + t)
        return "{" + ",".join(parts) + "}"
    if callable(x) and not isinstance(x, (JsError, JsRegExp)):
        return None
    return "{}"


def _number_is_nan(x=UNDEFINED):
    return isinstance(x, float) and math.isnan(x)


def _number_is_finite(x=UNDEFINED):
    return _isnum(x) and not (isinstance(x, float) and (math.isnan(x) or math.isinf(x)))


def _number_is_integer(x=UNDEFINED):
    return _number_is_finite(x) and x == math.floor(x)


def _json_stringify(x=UNDEFINED):
    t = _json_str(x)
    return UNDEFINED if t is None else t


def _string_of(*a):
    return "" if len(a) == 0 else _str(a[0])


def _number_of(*a):
    return 0 if len(a) == 0 else _num(a[0])


def _global_is_nan(x=UNDEFINED):
    return _isnan(x)


def _global_is_finite(x=UNDEFINED):
    return not _isnan(x) and not math.isinf(_num(x))


def _boolean_of(x=UNDEFINED):
    return _truthy(x)


_fn_parse_int = lambda s=UNDEFINED, radix=UNDEFINED, *_rest: _parse_int(s, radix)
_fn_parse_float = lambda s=UNDEFINED, *_rest: _parse_float(s)
_fn_string = lambda x="", *_rest: _str(x)
_fn_number = lambda x=0, *_rest: _num(x)
_fn_boolean = lambda x=UNDEFINED, *_rest: _truthy(x)
_fn_is_nan = lambda x=UNDEFINED, *_rest: _isnan(x)


def _arr(*items):
    return list(items)


class _OSpread:
    def __init__(self, value):
        self.value = value


def _ospread(x):
    return _OSpread(x)


def _key(k, v):
    return (k, v)


def _obj(*parts):
    out = {}
    for p in parts:
        if isinstance(p, _OSpread):
            out.update(p.value)
        else:
            out[p[0]] = p[1]
    return out


def _template(texts, *vals):
    out = ""
    for i, t in enumerate(texts):
        out += t
        if i < len(vals):
            out += _str(vals[i])
    return out


def _re_js(js, pattern, flags, is_global):
    return _re(pattern, flags, is_global)


def _add_assign(a, b):
    return _add(a, b)


def _sub_assign(a, b):
    return _sub(a, b)


def _mul_assign(a, b):
    return _mul(a, b)


def _div_assign(a, b):
    return _div(a, b)


def _rem_assign(a, b):
    return _rem(a, b)


def _pre_inc(a):
    return _num(a) + 1


def _post_inc(a):
    return _num(a) + 1


def _pre_dec(a):
    return _num(a) - 1


def _post_dec(a):
    return _num(a) - 1


def _put_member(o, k, v):
    return _put(o, k, v)
`;

/** A table's own entry for a key: never one of Object.prototype's (`hasOwnProperty`, `constructor`). */
function entry<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** String and array methods, as Python: `(receiver, args) => expression`. */
/**
 * Each graph operation is a prelude function of its own (#1278), so the lowering can be raised back:
 * a method is called with its receiver first and the arguments as written (so their number is kept).
 */
const METHODS: Record<string, string> = {
  trim: "_trim",
  trimStart: "_trim_start",
  trimEnd: "_trim_end",
  toUpperCase: "_to_upper",
  toLowerCase: "_to_lower",
  startsWith: "_starts_with",
  endsWith: "_ends_with",
  includes: "_includes",
  indexOf: "_index_of",
  lastIndexOf: "_last_index_of",
  slice: "_slice",
  substring: "_substring",
  split: "_split",
  join: "_join",
  repeat: "_repeat",
  charAt: "_char_at",
  charCodeAt: "_char_code_at",
  concat: "_concat",
  toString: "_to_string_m",
  test: "_test",
  map: "_map",
  filter: "_filter",
  forEach: "_for_each",
  some: "_some",
  every: "_every",
  find: "_find",
  findIndex: "_find_index",
  reduce: "_reduce",
  replace: "_replace",
  push: "_push",
  pop: "_pop",
};

/** Members of platform namespaces, as Python. */
const AMBIENT_MEMBERS: Record<string, Record<string, string>> = {
  Math: {
    abs: "_math_abs",
    floor: "_math_floor",
    ceil: "_math_ceil",
    trunc: "_math_trunc",
    round: "_round",
    sqrt: "_math_sqrt",
    max: "_max",
    min: "_min",
    pow: "_math_pow",
  },
  Object: { keys: "_object_keys" },
  Array: { isArray: "_is_array" },
  JSON: { stringify: "_json_stringify" },
  // Number.parseInt and Number.parseFloat are the global functions (ECMA-262 21.1.2.12–13).
  Number: {
    parseInt: "_parse_int",
    parseFloat: "_parse_float",
    // Number.isNaN / isFinite / isInteger do not convert their argument, unlike the globals.
    isNaN: "_number_is_nan",
    isFinite: "_number_is_finite",
    isInteger: "_number_is_integer",
  },
};

const AMBIENT_CALLS: Record<string, string> = {
  __yakccTry: "_try",
  String: "_string_of",
  Number: "_number_of",
  parseInt: "_parse_int",
  parseFloat: "_parse_float",
  isNaN: "_global_is_nan",
  isFinite: "_global_is_finite",
  Boolean: "_boolean_of",
};

/** Platform functions used as values (passed, stored), as the prelude functions that are them. */
const PLATFORM_VALUES: Record<string, string> = {
  parseInt: "_fn_parse_int",
  parseFloat: "_fn_parse_float",
  String: "_fn_string",
  Number: "_fn_number",
  Boolean: "_fn_boolean",
  isNaN: "_fn_is_nan",
};

const ERRORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError"]);

const isMemberRead = (label: string): boolean =>
  (label.startsWith(".") || label.startsWith("?.")) && !label.endsWith("=") && label !== "...";

/** JavaScript's whitespace (`\s`), as the contents of a character class. */
const JS_SPACE =
  "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const JS_NOT_LINE = "[^\\n\\r\\u2028\\u2029]";

/**
 * A regular expression literal as Python `re`, where the two mean the same: `.` stops at every
 * JavaScript line terminator, `$` without the m flag is the end, `\d` and `\w` are ASCII (the A
 * flag) and `\s` is JavaScript's whitespace. Refuses the sticky, unicode, multiline and dotAll
 * flags, unicode escapes and properties, and lookbehind.
 */
export function regexToPython(text: string): {
  readonly pattern: string;
  readonly flags: string;
  readonly global: boolean;
} {
  const close = text.lastIndexOf("/");
  const body = text.slice(1, close);
  const flags = text.slice(close + 1);
  for (const f of flags)
    if (!"gi".includes(f))
      throw new PyEmitError(`the regular expression flag ${f} has no Python form here`);
  let out = "";
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c === "\\") {
      const n = body[i + 1] ?? "";
      i++;
      if (n === "s") out += inClass ? JS_SPACE : `[${JS_SPACE}]`;
      else if (n === "S") {
        if (inClass) throw new PyEmitError("\\S inside a character class has no Python form here");
        out += `[^${JS_SPACE}]`;
      } else if (n === "/") out += "/";
      else if (n === "u" || n === "p" || n === "P" || n === "c" || n === "k")
        throw new PyEmitError(`the escape \\${n} has no Python form here`);
      else out += `\\${n}`;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += c;
      if (body[i + 1] === "^") {
        out += "^";
        i++;
      }
      continue;
    }
    if (c === ".") out += JS_NOT_LINE;
    else if (c === "$") out += "\\Z";
    else if (c === "(" && body.startsWith("(?<", i) && body[i + 3] !== "=" && body[i + 3] !== "!") {
      out += "(?P<";
      i += 2;
    } else if (c === "(" && (body.startsWith("(?<=", i) || body.startsWith("(?<!", i)))
      throw new PyEmitError("lookbehind has no Python form here");
    else out += c;
  }
  return {
    pattern: out,
    flags: `re.ASCII${flags.includes("i") ? " | re.IGNORECASE" : ""}`,
    global: flags.includes("g"),
  };
}

/** A literal label (JavaScript text) as Python. */
function literal(label: string): string {
  if (label.startsWith("/") && label.lastIndexOf("/") > 0) {
    const r = regexToPython(label);
    // The JavaScript literal is kept beside its Python form, for the raiser.
    return `_re_js(${JSON.stringify(label)}, ${JSON.stringify(r.pattern)}, ${r.flags}, ${r.global ? "True" : "False"})`;
  }
  if (label === "true") return "True";
  if (label === "false") return "False";
  if (label === "null") return "None";
  if (label === "undefined" || label === "Uninitialized") return "UNDEFINED";
  if (label.startsWith('"')) return JSON.stringify(JSON.parse(label) as string);
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(label)) return label;
  if (label === "NaN") return "_JS_NAN";
  if (label === "Infinity") return "_JS_INF";
  throw new PyEmitError(`the literal ${label} has no Python form`);
}

/** Lowers a graph to a Python module defining `f`. Throws PyEmitError for what it does not lower. */
export function emitPython(input: DucGraph): string {
  // ECMAScript's operations: each generic operation as the case of them it is (#1310).
  const g = ecmaScriptView(input);
  try {
    printLineForm(g);
  } catch (e) {
    throw new PyEmitError(e instanceof Error ? e.message : String(e));
  }
  if (g.mode !== undefined) throw new PyEmitError(`an ${g.mode} function has no form here`);
  if (g.mode !== undefined) throw new PyEmitError(`an ${g.mode} function has no form here`);
  const { params, body } = pyFunction(g, "", []);
  return [`def f(${params.join(", ")}):`, ...indent(body.length > 0 ? body : ["pass"]), ""].join(
    "\n",
  );
}

const indent = (lines: readonly string[]): string[] => lines.map((l) => `    ${l}`);

function pyFunction(
  source: DucGraph,
  prefix: string,
  bound: readonly string[],
): { params: string[]; body: string[] } {
  // The heap token orders the statements and is not written (#1285).
  const { graph: g, after } = loweringView(source);
  if (g.obs.length > 1) throw new PyEmitError("more than one observation");
  const branches = g.branches ?? [];
  const producer = new Map<ValueId, DucNode>();
  const consumers = new Map<ValueId, DucNode[]>();
  for (const node of g.nodes) {
    for (const v of node.outputs) producer.set(v, node);
    for (const v of node.inputs) consumers.set(v, [...(consumers.get(v) ?? []), node]);
  }
  const owners = joinOwners(g);
  const loops = g.nodes.filter((n) => n.kind === "loop");
  // A function that reads `arguments` takes what it is called with as one list.
  const usesArguments =
    bound.length === 0 &&
    g.nodes.some(
      (n) => n.diamond?.reason === "platform-primitive" && n.diamond.symbol === "arguments",
    );
  const invariantOuter = new Map<ValueId, ValueId>();
  for (const loop of loops) {
    const rec = loop.loop as DucLoop;
    const offset = rec.carry.length + (rec.iterate !== undefined ? 1 : 0);
    rec.invariant.forEach((v, j) => invariantOuter.set(v, loop.inputs[offset + j] as ValueId));
  }

  const nameOf = (v: ValueId): string => {
    const outer = invariantOuter.get(v);
    if (outer !== undefined) return nameOf(outer);
    const p = producer.get(v);
    if (p?.kind === "param-source" && paramIndex(p.label) < bound.length)
      return bound[paramIndex(p.label)] as string;
    if (p?.kind === "diamond-source" && p.diamond !== undefined) {
      // `arguments` is the list of what the function was called with.
      if (
        p.diamond.reason === "platform-primitive" &&
        p.diamond.symbol === "arguments" &&
        usesArguments
      )
        return "_arguments";
      if (p.diamond.reason === "platform-primitive") return `@${p.diamond.symbol}`;
      return p.diamond.symbol;
    }
    return `${prefix}${v}`;
  };

  // Inline: literals, spreads, a method's callee and a platform namespace's member, the condition of
  // a while loop.
  const inline = new Set<NodeId>();
  const lazyBranches = new Set<string>();
  for (const node of g.nodes) {
    if (node.kind === "literal-source" && node.label !== "Uninitialized") inline.add(node.id);
    if (node.kind !== "op") continue;
    const label = node.label ?? "";
    if (label === "...") inline.add(node.id);
    // `(0, f)` as a callee is f: the call writes f, and the comma is not a value of its own.
    if (label === "," && producer.get(node.inputs[0] as ValueId)?.kind === "literal-source") {
      const users = consumers.get(node.outputs[0] as ValueId) ?? [];
      if (
        users.length === 1 &&
        users[0]?.label === "CallExpression" &&
        users[0].inputs[0] === node.outputs[0]
      )
        inline.add(node.id);
    }
    if (isMemberRead(label)) {
      const users = consumers.get(node.outputs[0] as ValueId) ?? [];
      const only = users[0];
      if (
        users.length === 1 &&
        only !== undefined &&
        (only.label === "CallExpression" || only.label === "NewExpression") &&
        only.inputs[0] === node.outputs[0] &&
        only.inputs.indexOf(node.outputs[0] as ValueId, 1) === -1
      ) {
        inline.add(node.id);
      }
    }
  }
  for (const loop of loops) {
    const rec = loop.loop as DucLoop;
    if (rec.cond === undefined) continue;
    const body = bodyPathOf(loop);
    const mark = (v: ValueId, region: string): void => {
      const p = producer.get(v);
      if (
        p === undefined ||
        p.kind === "carry-source" ||
        p.kind === "diamond-source" ||
        p.kind === "literal-source"
      )
        return;
      if (p.region !== region)
        throw new PyEmitError(
          `the condition of loop ${loop.id} is not computed at the top of its body`,
        );
      if (new Set(consumers.get(v) ?? []).size > (v === rec.cond ? 0 : 1))
        throw new PyEmitError(`the condition of loop ${loop.id} shares a value with the body`);
      inline.add(p.id);
      const owner = owners.get(p.id);
      if (p.kind === "sel" && owner !== undefined && owner.cond === p.inputs[0]) {
        lazyBranches.add(owner.id);
        mark(p.inputs[0] as ValueId, region);
        if (p.inputs[1] !== p.inputs[0]) mark(p.inputs[1] as ValueId, sidePath(owner, "t"));
        if (p.inputs[2] !== p.inputs[0]) mark(p.inputs[2] as ValueId, sidePath(owner, "e"));
        return;
      }
      for (const input of p.inputs) mark(input, region);
    };
    mark(rec.cond, body);
  }

  const ref = (v: ValueId): string => {
    const p = producer.get(v);
    if (p === undefined || !inline.has(p.id)) {
      const name = nameOf(v);
      if (name.startsWith("@")) {
        // A platform function passed as a value is its prelude helper.
        const asValue = entry(PLATFORM_VALUES, name.slice(1));
        if (asValue === undefined) {
          throw new PyEmitError(
            `the platform name ${name.slice(1)} is used as a value; Python has no form for it`,
          );
        }
        return asValue;
      }
      return name;
    }
    // A spread is written as it is: `*xs` is an argument, not an expression to parenthesize.
    if (p.label === "...") return render(p);
    return `(${render(p)})`;
  };

  /** The value an invariant stands for, through each loop it reaches into. */
  const outerOf = (v: ValueId): ValueId => {
    const outer = invariantOuter.get(v);
    return outer === undefined ? v : outerOf(outer);
  };

  /** The platform namespace and member a callee reads, when it is one. */
  const ambientMember = (callee: ValueId): { ns: string; member: string } | undefined => {
    const p = producer.get(callee);
    if (p === undefined || !inline.has(p.id) || !isMemberRead(p.label ?? "")) return undefined;
    const base = producer.get(outerOf(p.inputs[0] as ValueId));
    if (base?.kind !== "diamond-source" || base.diamond?.reason !== "platform-primitive")
      return undefined;
    return { ns: base.diamond.symbol, member: (p.label ?? "").replace(/^\??\./, "") };
  };

  const render = (node: DucNode): string => {
    if (node.kind === "literal-source") return literal(node.label ?? "");
    if (node.kind === "sel") {
      const [c, a, b] = node.inputs as [ValueId, ValueId, ValueId];
      if (lazyBranches.has(owners.get(node.id)?.id ?? "")) {
        if (b === c) return `_lazy_and(${ref(c)}, lambda: ${ref(a)})`;
        if (a === c) return `_lazy_or(${ref(c)}, lambda: ${ref(b)})`;
        return `_lazy_sel(${ref(c)}, lambda: ${ref(a)}, lambda: ${ref(b)})`;
      }
      return `_sel(${ref(c)}, ${ref(a)}, ${ref(b)})`;
    }
    if (node.kind !== "op") throw new PyEmitError(`a ${node.kind} is not an expression`);
    const label = node.label ?? "";
    const ins = node.inputs;
    const arg = (i: number): string => ref(ins[i] as ValueId);
    if (ins.length === 2) {
      const binary: Record<string, string> = {
        "+": "_add",
        "-": "_sub",
        "*": "_mul",
        "/": "_div",
        "%": "_rem",
        "**": "_pow",
        "<<": "_shl",
        ">>": "_shr",
        ">>>": "_ushr",
        "&": "_band",
        "|": "_bor",
        "^": "_bxor",
        "<": "_lt",
        ">": "_gt",
        "<=": "_le",
        ">=": "_ge",
        "===": "_seq",
        "!==": "_sne",
        "&&": "_and",
        "||": "_or",
        "??": "_nullish",
        in: "_has_key",
        ElementAccess: "_idx",
        "ElementAccess?.": "_idx_opt",
        ",": "_comma",
      };
      const fn = entry(binary, label);
      if (fn !== undefined) return `${fn}(${arg(0)}, ${arg(1)})`;
      if (label === "==" && producer.get(ins[1] as ValueId)?.label === "null")
        return `_is_nullish(${arg(0)})`;
    }
    if (ins.length === 1) {
      const unary: Record<string, string> = {
        "!": "_not",
        "-": "_neg",
        "+": "_pos",
        "~": "_bnot",
        TypeOfExpression: "_typeof",
        VoidExpression: "_void_of",
      };
      const fn = entry(unary, label);
      if (fn !== undefined) return `${fn}(${arg(0)})`;
      if (label === "...") return `*_values(${arg(0)})`;
      if (isMemberRead(label)) {
        const name = label.replace(/^\??\./, "");
        return `${label.startsWith("?.") ? "_get_opt" : "_get"}(${arg(0)}, ${JSON.stringify(name)})`;
      }
    }
    if (label === "CallExpression" || label === "CallExpression?." || label === "NewExpression") {
      // `(0, f)(x)` calls f with no receiver: the comma's first operand is a literal.
      let callee = ins[0] as ValueId;
      const viaComma = producer.get(callee);
      let detached = false;
      if (
        viaComma?.label === "," &&
        producer.get(viaComma.inputs[0] as ValueId)?.kind === "literal-source" &&
        inline.has(viaComma.id)
      ) {
        callee = viaComma.inputs[1] as ValueId;
        detached = true;
      }
      const args = ins.slice(1).map((v) => ref(v));
      const amb = ambientMember(callee);
      if (amb !== undefined) {
        const fn = entry(entry(AMBIENT_MEMBERS, amb.ns), amb.member);
        if (fn === undefined)
          throw new PyEmitError(`${amb.ns}.${amb.member} has no Python form here`);
        if (amb.ns === "JSON" && args.length > 1)
          throw new PyEmitError(
            "JSON.stringify with a replacer or an indent has no Python form here",
          );
        return `${fn}(${args.join(", ")})`;
      }
      const cp = producer.get(callee);
      const platform = producer.get(outerOf(callee));
      const sym =
        platform?.kind === "diamond-source" && platform.diamond?.reason === "platform-primitive"
          ? platform.diamond.symbol
          : cp?.kind === "diamond-source" && cp.diamond?.reason === "platform-primitive"
            ? cp.diamond.symbol
            : undefined;
      if (sym !== undefined) {
        if (ERRORS.has(sym))
          return `${label === "NewExpression" ? "_new_error" : "_call_error"}(${[JSON.stringify(sym), ...args].join(", ")})`;
        const call = entry(AMBIENT_CALLS, sym);
        if (call === undefined) throw new PyEmitError(`${sym}(...) has no Python form here`);
        return `${call}(${args.join(", ")})`;
      }
      if (cp !== undefined && inline.has(cp.id) && isMemberRead(cp.label ?? "")) {
        if ((cp.label ?? "").startsWith("?."))
          throw new PyEmitError("an optional method call has no Python form here");
        const method = (cp.label ?? "").replace(/^\??\./, "");
        const fn = entry(METHODS, method);
        if (fn === undefined) throw new PyEmitError(`the method ${method} has no Python form here`);
        return `${fn}(${[ref(cp.inputs[0] as ValueId), ...args].join(", ")})`;
      }
      if (label === "NewExpression")
        throw new PyEmitError("new of a value other than an Error has no Python form here");
      const call =
        label === "CallExpression?." ? "_call_opt" : detached ? "_call_detached" : "_call";
      return `${call}(${[ref(callee), ...args].join(", ")})`;
    }
    if (label === "ArrayLiteral") {
      // A spread is written in the call itself: `*xs` is not an expression on its own.
      const items = ins.map((v) => {
        const p = producer.get(v);
        return p !== undefined && p.label === "..."
          ? `*_values(${ref(p.inputs[0] as ValueId)})`
          : ref(v);
      });
      return `_arr(${items.join(", ")})`;
    }
    if (label.startsWith("object:")) {
      const entries = JSON.parse(label.slice("object:".length)) as unknown[];
      let at = 0;
      const next = (): string => ref(ins[at++] as ValueId);
      const parts = entries.map((entry) => {
        if (entry === null) return `_ospread(${next()})`;
        if (typeof entry === "string") return `_key(${JSON.stringify(entry)}, ${next()})`;
        throw new PyEmitError(
          "an object with a computed key, a method or an accessor has no Python form here",
        );
      });
      return `_obj(${parts.join(", ")})`;
    }
    if (label.startsWith("template:")) {
      const texts = JSON.parse(label.slice("template:".length)) as string[];
      return `_template([${texts.map((t) => JSON.stringify(t)).join(", ")}]${ins.map((v) => `, ${ref(v)}`).join("")})`;
    }
    // An operation reference (#1362), as the member call it is written as.
    const opRef = /^Math\.(\w+)$/.exec(label)?.[1];
    const opFn = opRef !== undefined ? AMBIENT_MEMBERS.Math?.[opRef] : undefined;
    if (opFn !== undefined) return `${opFn}(${ins.map((v) => ref(v)).join(", ")})`;
    throw new PyEmitError(`the operation "${label}" has no Python form`);
  };

  const statementsOf = (node: DucNode): string[] => {
    const out = node.outputs[0];
    const label = node.label ?? "";
    if (node.kind === "literal-source") return [`${nameOf(out as ValueId)} = _uninit()`];
    if (node.kind === "sel") return [`${nameOf(out as ValueId)} = ${render(node)}`];
    if (node.kind !== "op") throw new PyEmitError(`a ${node.kind} is not a statement`);
    const arg = (i: number): string => ref(node.inputs[i] as ValueId);
    if (label === "throw") return [`_throw(${arg(0)})`];
    if (out === undefined) {
      // A call or another expression run for its effect.
      return [render(node)];
    }
    const name = nameOf(out);
    if (node.closure !== undefined) {
      if (label !== "closure" && label !== "function")
        throw new PyEmitError(
          `a closure that is ${label.replace(/ closure$/, "")} has no form here`,
        );
      if (label === "function" && readsOwnReceiver(node.closure))
        throw new PyEmitError("a function with its own receiver (this) has no Python form here");
      const inner = pyFunction(
        node.closure,
        `${prefix}${node.id}_`,
        node.inputs.map((v) => ref(v)),
      );
      return [
        `def ${name}(${inner.params.join(", ")}):`,
        ...indent(inner.body.length > 0 ? inner.body : ["pass"]),
      ];
    }
    // A compound assignment and a step are operations of their own, as the graph has them.
    const compound: Record<string, string> = {
      "+=": "_add_assign",
      "-=": "_sub_assign",
      "*=": "_mul_assign",
      "/=": "_div_assign",
      "%=": "_rem_assign",
      "++": "_pre_inc",
      "post++": "_post_inc",
      "--": "_pre_dec",
      "post--": "_post_dec",
    };
    const fn = entry(compound, label);
    if (fn !== undefined) return [`${name} = ${fn}(${node.inputs.map((v) => ref(v)).join(", ")})`];
    if (label.startsWith(".") && label.endsWith("="))
      return [`${name} = _put_member(${arg(0)}, ${JSON.stringify(label.slice(1, -1))}, ${arg(1)})`];
    if (label === "[]=") return [`${name} = _put(${arg(0)}, ${arg(1)}, ${arg(2)})`];
    return [`${name} = ${render(node)}`];
  };
  const safeRender = (node: DucNode): string => {
    try {
      return render(node);
    } catch {
      return "";
    }
  };

  const nodeIndex = new Map(g.nodes.map((n, i) => [n.id, i] as const));
  /** The values of the inline nodes a statement writes inside it. */
  const inlined = (node: DucNode): ValueId[] =>
    node.inputs.flatMap((v) => {
      const p = producer.get(v);
      return p !== undefined && inline.has(p.id) && p.kind === "op"
        ? [...p.outputs, ...inlined(p)]
        : [];
    });
  const needs = (node: DucNode): ValueId[] => [
    ...node.inputs.flatMap((v) => {
      const p = producer.get(v);
      return p !== undefined && inline.has(p.id) ? needs(p) : [v];
    }),
    // An order edge to an inline operation waits for the statement that writes it.
    ...(after.get(node.id) ?? []).flatMap((v) => {
      const p = producer.get(v);
      return p !== undefined && inline.has(p.id) ? [v, ...needs(p)] : [v];
    }),
  ];
  /** The values made inside a region (a branch side or a loop body), nested regions included. */
  const madeWithin = (path: string): ValueId[] =>
    g.nodes.filter((n) => isPrefix(path, n.region)).flatMap((n) => n.outputs);
  /** What the nodes inside a region need from outside it, their order included. */
  const neededBy = (paths: readonly string[]): ValueId[] => {
    const inside = new Set(paths.flatMap(madeWithin));
    return g.nodes
      .filter((n) => paths.some((path) => isPrefix(path, n.region)))
      .flatMap((n) => [...n.inputs, ...(after.get(n.id) ?? [])])
      .filter((v) => !inside.has(v));
  };

  const emitBranch = (b: DucBranch): string[] => {
    const thenPath = sidePath(b, "t");
    const elsePath = sidePath(b, "e");
    const joins = g.nodes.filter((n) => owners.get(n.id)?.id === b.id);
    const thenAssign: string[] = [];
    const elseAssign: string[] = [];
    for (const j of joins) {
      const [, t, e] = j.inputs as [ValueId, ValueId, ValueId];
      const name = nameOf(j.outputs[0] as ValueId);
      // Python has no block scope: each side assigns the join's name.
      thenAssign.push(`${name} = ${ref(t)}`);
      elseAssign.push(`${name} = ${ref(e)}`);
    }
    const thenLines = [...emitScope(thenPath), ...thenAssign];
    const elseLines = [...emitScope(elsePath), ...elseAssign];
    return [
      `if _truthy(${ref(b.cond)}):`,
      ...indent(thenLines.length > 0 ? thenLines : ["pass"]),
      ...(elseLines.length > 0 ? ["else:", ...indent(elseLines)] : []),
    ];
  };

  const emitLoop = (loop: DucNode): string[] => {
    const rec = loop.loop as DucLoop;
    // #1330: `for await` is not in this lowering; core's change forced this one line.
    if (rec.iterate?.of === "async values")
      throw new PyEmitError("for await is not in the subset yet");
    const count = rec.carry.length;
    const carried = rec.carry.map((v) => nameOf(v));
    const before = carried.map((name, i) => `${name} = ${ref(loop.inputs[i] as ValueId)}`);
    const header =
      rec.iterate !== undefined
        ? `for ${nameOf(rec.iterate.element)} in ${rec.iterate.of === "values" ? "_values" : "_keys"}(${ref(loop.inputs[count] as ValueId)}):`
        : `while _truthy(${ref(rec.cond as ValueId)}):`;
    const body = emitScope(bodyPathOf(loop));
    // The next values are assigned together, as JavaScript's carried variables change at once.
    const next =
      carried.length > 0
        ? [
            `${carried.join(", ")}${carried.length === 1 ? "," : ""} = ${rec.next.map((v) => ref(v)).join(", ")}${carried.length === 1 ? "," : ""}`,
          ]
        : [];
    const after = loop.outputs.map((v, i) => `${nameOf(v)} = ${carried[i]}`);
    // An iterating loop's condition stops it before an element's body (#1276).
    const guard =
      rec.iterate !== undefined && rec.cond !== undefined
        ? [`if not _truthy(${ref(rec.cond)}):`, "    break"]
        : [];
    const inner = [...guard, ...body, ...next];
    return [...before, header, ...indent(inner.length > 0 ? inner : ["pass"]), ...after];
  };

  function emitScope(scope: string | undefined): string[] {
    interface Item {
      readonly first: number;
      readonly last: number;
      readonly produces: readonly ValueId[];
      readonly requires: readonly ValueId[];
      readonly lines: () => string[];
    }
    const items: Item[] = [];
    for (const node of g.nodes) {
      if (node.region !== scope || owners.has(node.id) || inline.has(node.id)) continue;
      if (
        node.kind === "param-source" ||
        node.kind === "diamond-source" ||
        node.kind === "carry-source" ||
        node.kind === "loop"
      )
        continue;
      items.push({
        first: nodeIndex.get(node.id) as number,
        last: node.label === "throw" ? 2 : 0,
        // A heap operation written inline (a spread) is done by the statement that writes it.
        produces: [...node.outputs, ...inlined(node)],
        requires: needs(node),
        lines: () => statementsOf(node),
      });
    }
    for (const loop of loops) {
      if (loop.region !== scope) continue;
      const body = bodyPathOf(loop);
      items.push({
        first: nodeIndex.get(loop.id) as number,
        last: 0,
        // A statement ordered after one inside the body comes after the loop.
        produces: [...loop.outputs, ...madeWithin(body)],
        requires: [
          ...new Set([...loop.inputs, ...(after.get(loop.id) ?? []), ...neededBy([body])]),
        ],
        lines: () => emitLoop(loop),
      });
    }
    for (const b of branches) {
      if (b.within !== scope || lazyBranches.has(b.id)) continue;
      const subtree = g.nodes.filter(
        (n) => isPrefix(sidePath(b, "t"), n.region) || isPrefix(sidePath(b, "e"), n.region),
      );
      const joins = g.nodes.filter((n) => owners.get(n.id)?.id === b.id);
      const innerValues = new Set(subtree.flatMap((n) => n.outputs));
      const requires = [
        b.cond,
        ...neededBy([sidePath(b, "t"), sidePath(b, "e")]),
        ...joins.flatMap((n) => n.inputs),
      ];
      items.push({
        first: Math.min(
          g.nodes.length,
          ...[...subtree, ...joins].map((n) => nodeIndex.get(n.id) as number),
        ),
        last: subtree.some((n) => n.label === "throw") ? 1 : 0,
        // A statement ordered after one inside a side comes after the branch.
        produces: [...joins.flatMap((n) => n.outputs), ...innerValues],
        requires: [...new Set(requires)].filter((v) => !innerValues.has(v)),
        lines: () => emitBranch(b),
      });
    }
    items.sort((a, b) => (a.last === b.last ? a.first - b.first : a.last - b.last));
    const producedBy = new Map<ValueId, number>();
    for (const [i, item] of items.entries()) for (const v of item.produces) producedBy.set(v, i);
    const done = new Set<number>();
    const lines: string[] = [];
    while (done.size < items.length) {
      const ready = (item: Item, i: number): boolean =>
        !done.has(i) &&
        item.requires.every((v) => {
          const p = producedBy.get(v);
          return p === undefined || p === i || done.has(p);
        });
      const rank = Math.min(...items.filter(ready).map((item) => item.last));
      const next = items.findIndex((item, i) => ready(item, i) && item.last === rank);
      if (next === -1) throw new PyEmitError("the graph has a cycle");
      done.add(next);
      lines.push(...(items[next] as Item).lines());
    }
    return lines;
  }

  const own = g.nodes
    .filter((n) => n.kind === "param-source" && paramIndex(n.label) >= bound.length)
    .sort((a, b) => paramIndex(a.label) - paramIndex(b.label));
  // A rest parameter is the arguments from its place on, as a list: `*name`, made a list.
  const rest = own.find((n) => isRestParam(n.label));
  const plain = own.filter((n) => n !== rest);
  const restName = rest !== undefined ? nameOf(rest.outputs[0] as ValueId) : undefined;
  const params = usesArguments
    ? ["*_args"]
    : // A JavaScript function ignores arguments past its parameters.
      [
        // A parameter declared a primitive is annotated so (#1370): the annotation keeps the mark.
        ...plain.map(
          (n) =>
            `${nameOf(n.outputs[0] as ValueId)}${isPrimitiveParam(n.label) ? ': "primitive"' : ""}=UNDEFINED`,
        ),
        restName !== undefined ? `*${restName}` : "*_rest",
      ];
  const bindings = usesArguments
    ? [
        "_arguments = list(_args)",
        ...plain.map(
          (n, i) =>
            `${nameOf(n.outputs[0] as ValueId)} = _args[${i}] if len(_args) > ${i} else UNDEFINED`,
        ),
        ...(restName !== undefined ? [`${restName} = list(_args[${plain.length}:])`] : []),
      ]
    : restName !== undefined
      ? [`${restName} = list(${restName})`]
      : [];
  // A free or ambient name that nothing uses is still part of the atom: it is read on its own.
  const used = new Set<ValueId>([...g.obs, ...branches.map((b) => b.cond)]);
  for (const node of g.nodes) for (const v of node.inputs) used.add(v);
  const unread = g.nodes
    .filter((n) => n.kind === "diamond-source" && !used.has(n.outputs[0] as ValueId))
    .map((n) => {
      const d = n.diamond as { reason: string; symbol: string };
      return d.reason === "platform-primitive"
        ? `_platform(${JSON.stringify(d.symbol)})`
        : `_unread(lambda: ${d.symbol})`;
    });
  const body = [...bindings, ...unread, ...emitScope(undefined)];
  const obs = g.obs[0];
  // No observation: the function computes nothing it returns (NONE, not an undefined returned).
  body.push(obs !== undefined ? `return ${ref(obs)}` : "return NONE");
  return { params, body };
}
