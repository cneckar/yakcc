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
import { bodyPathOf, isPrefix, joinOwners, printLineForm, sidePath } from "./line-form.js";
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
    if x == int(x) and abs(x) < 1e21:
        return str(int(x))
    return repr(x)


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
        return -r if a < 0 else r
    return math.fmod(a, b)


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


def _index_of(s, x):
    if isinstance(s, str):
        return s.find(_str(x))
    for i, e in enumerate(s):
        if _seq(e, x):
            return i
    return -1


def _includes(s, x):
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


def _test(r, s):
    return r.compiled.search(_str(s)) is not None


def _replace(s, pattern, replacement):
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
    return max((_num(x) for x in xs), default=-math.inf)


def _min(*xs):
    return min((_num(x) for x in xs), default=math.inf)
`;

/** String and array methods, as Python: `(receiver, args) => expression`. */
const METHODS: Record<string, (recv: string, args: readonly string[]) => string> = {
  trim: (r) => `${r}.strip()`,
  trimStart: (r) => `${r}.lstrip()`,
  trimEnd: (r) => `${r}.rstrip()`,
  toUpperCase: (r) => `${r}.upper()`,
  toLowerCase: (r) => `${r}.lower()`,
  startsWith: (r, a) => `${r}.startswith(_str(${a[0] ?? '""'}))`,
  endsWith: (r, a) => `${r}.endswith(_str(${a[0] ?? '""'}))`,
  includes: (r, a) => `_includes(${r}, ${a[0] ?? "UNDEFINED"})`,
  indexOf: (r, a) => `_index_of(${r}, ${a[0] ?? "UNDEFINED"})`,
  slice: (r, a) => `_slice(${[r, ...a].join(", ")})`,
  substring: (r, a) => `_substring(${[r, ...a].join(", ")})`,
  split: (r, a) => `_split(${[r, ...a].join(", ")})`,
  join: (r, a) => `_join(${[r, ...a].join(", ")})`,
  repeat: (r, a) => `(${r} * int(_num(${a[0] ?? "0"})))`,
  charAt: (r, a) => `_str(_idx(${r}, ${a[0] ?? "0"})).replace("undefined", "")`,
  charCodeAt: (r, a) => `ord(${r}[int(_num(${a[0] ?? "0"}))])`,
  concat: (r, a) => `(${r} + ${a.map((x) => `_str(${x})`).join(" + ") || '""'})`,
  toString: (r: string) => `_str(${r})`,
  test: (r, a) => `_test(${r}, ${a[0] ?? "UNDEFINED"})`,
  map: (r, a) => `_map(${r}, ${a[0]})`,
  filter: (r, a) => `_filter(${r}, ${a[0]})`,
  forEach: (r, a) => `_for_each(${r}, ${a[0]})`,
  some: (r, a) => `_some(${r}, ${a[0]})`,
  every: (r, a) => `_every(${r}, ${a[0]})`,
  find: (r, a) => `_find(${r}, ${a[0]})`,
  findIndex: (r, a) => `_find_index(${r}, ${a[0]})`,
  reduce: (r, a) => `_reduce(${[r, ...a].join(", ")})`,
  replace: (r, a) => `_replace(${r}, ${a[0] ?? "UNDEFINED"}, ${a[1] ?? "UNDEFINED"})`,
  push: (r, a) => `_push(${[r, ...a].join(", ")})`,
  pop: (r) => `_pop(${r})`,
};

/** Members of platform namespaces, as Python. */
const AMBIENT_MEMBERS: Record<string, Record<string, (args: readonly string[]) => string>> = {
  Math: {
    abs: (a) => `abs(_num(${a[0]}))`,
    floor: (a) => `math.floor(_num(${a[0]}))`,
    ceil: (a) => `math.ceil(_num(${a[0]}))`,
    trunc: (a) => `math.trunc(_num(${a[0]}))`,
    round: (a) => `_round(${a[0]})`,
    sqrt: (a) => `math.sqrt(_num(${a[0]}))`,
    max: (a) => `_max(${a.join(", ")})`,
    min: (a) => `_min(${a.join(", ")})`,
    pow: (a) => `(_num(${a[0]}) ** _num(${a[1]}))`,
  },
  Object: { keys: (a) => `_keys(${a[0]})` },
  Array: { isArray: (a) => `isinstance(${a[0]}, list)` },
};

const AMBIENT_CALLS: Record<string, (args: readonly string[]) => string> = {
  String: (a) => `_str(${a[0] ?? '""'})`,
  Number: (a) => `_num(${a[0] ?? "0"})`,
  parseInt: (a) => `_parse_int(${a.join(", ")})`,
  parseFloat: (a) => `_parse_float(${a[0] ?? "UNDEFINED"})`,
  isNaN: (a) => `_isnan(${a[0] ?? "UNDEFINED"})`,
  isFinite: (a) =>
    `(not _isnan(${a[0] ?? "UNDEFINED"}) and not math.isinf(_num(${a[0] ?? "UNDEFINED"})))`,
  Boolean: (a) => `_truthy(${a[0] ?? "UNDEFINED"})`,
};

/** Platform functions used as values (passed, stored), as the prelude functions that are them. */
const PLATFORM_VALUES: Record<string, string> = {
  // Called back with (element, index, array), as JavaScript does; the rest is ignored.
  parseInt: "(lambda s=UNDEFINED, radix=UNDEFINED, *_rest: _parse_int(s, radix))",
  parseFloat: "(lambda s=UNDEFINED, *_rest: _parse_float(s))",
  String: '(lambda x="", *_rest: _str(x))',
  Number: "(lambda x=0, *_rest: _num(x))",
  Boolean: "(lambda x=UNDEFINED, *_rest: _truthy(x))",
  isNaN: "(lambda x=UNDEFINED, *_rest: _isnan(x))",
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
    return `_re(${JSON.stringify(r.pattern)}, ${r.flags}, ${r.global ? "True" : "False"})`;
  }
  if (label === "true") return "True";
  if (label === "false") return "False";
  if (label === "null") return "None";
  if (label === "undefined" || label === "Uninitialized") return "UNDEFINED";
  if (label.startsWith('"')) return JSON.stringify(JSON.parse(label) as string);
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(label)) return label;
  if (label === "NaN") return "math.nan";
  if (label === "Infinity") return "math.inf";
  throw new PyEmitError(`the literal ${label} has no Python form`);
}

/** Lowers a graph to a Python module defining `f`. Throws PyEmitError for what it does not lower. */
export function emitPython(g: DucGraph): string {
  try {
    printLineForm(g);
  } catch (e) {
    throw new PyEmitError(e instanceof Error ? e.message : String(e));
  }
  const { params, body } = pyFunction(g, "", []);
  return [`def f(${params.join(", ")}):`, ...indent(body.length > 0 ? body : ["pass"]), ""].join(
    "\n",
  );
}

const indent = (lines: readonly string[]): string[] => lines.map((l) => `    ${l}`);

function pyFunction(
  g: DucGraph,
  prefix: string,
  bound: readonly string[],
): { params: string[]; body: string[] } {
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
    if (p?.kind === "param-source" && Number(p.label) < bound.length)
      return bound[Number(p.label)] as string;
    if (p?.kind === "diamond-source" && p.diamond !== undefined) {
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
        const asValue = PLATFORM_VALUES[name.slice(1)];
        if (asValue === undefined) {
          throw new PyEmitError(
            `the platform name ${name.slice(1)} is used as a value; Python has no form for it`,
          );
        }
        return asValue;
      }
      return name;
    }
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
        if (b === c) return `(${ref(a)} if _truthy(${ref(c)}) else ${ref(c)})`;
        if (a === c) return `(${ref(c)} if _truthy(${ref(c)}) else ${ref(b)})`;
      }
      return `(${ref(a)} if _truthy(${ref(c)}) else ${ref(b)})`;
    }
    if (node.kind !== "op") throw new PyEmitError(`a ${node.kind} is not an expression`);
    const label = node.label ?? "";
    const ins = node.inputs;
    const arg = (i: number): string => ref(ins[i] as ValueId);
    if (ins.length === 2) {
      switch (label) {
        case "+":
          return `_add(${arg(0)}, ${arg(1)})`;
        case "-":
          return `(_num(${arg(0)}) - _num(${arg(1)}))`;
        case "*":
          return `(_num(${arg(0)}) * _num(${arg(1)}))`;
        case "/":
          return `_div(${arg(0)}, ${arg(1)})`;
        case "%":
          return `_rem(${arg(0)}, ${arg(1)})`;
        case "**":
          return `(_num(${arg(0)}) ** _num(${arg(1)}))`;
        case "<":
        case ">":
        case "<=":
        case ">=":
          return `(${arg(0)} ${label} ${arg(1)})`;
        case "===":
          return `_seq(${arg(0)}, ${arg(1)})`;
        case "!==":
          return `(not _seq(${arg(0)}, ${arg(1)}))`;
        case "&&":
          return `(${arg(1)} if _truthy(${arg(0)}) else ${arg(0)})`;
        case "||":
          return `(${arg(0)} if _truthy(${arg(0)}) else ${arg(1)})`;
        case "??":
          return `(${arg(1)} if ${arg(0)} is None or ${arg(0)} is UNDEFINED else ${arg(0)})`;
        case "==":
          if (producer.get(ins[1] as ValueId)?.label === "null")
            return `(${arg(0)} is None or ${arg(0)} is UNDEFINED)`;
          break;
        case "in":
          return `(_str(${arg(0)}) in ${arg(1)})`;
        case "ElementAccess":
          return `_idx(${arg(0)}, ${arg(1)})`;
        case ",":
          // Both run, in order; the value is the second.
          return `(${arg(0)}, ${arg(1)})[1]`;
      }
    }
    if (ins.length === 1) {
      switch (label) {
        case "!":
          return `(not _truthy(${arg(0)}))`;
        case "-":
          return `(-_num(${arg(0)}))`;
        case "+":
          return `_num(${arg(0)})`;
        case "TypeOfExpression":
          return `_typeof(${arg(0)})`;
        case "VoidExpression":
          return "UNDEFINED";
        case "...":
          return `*_values(${arg(0)})`;
      }
      if (isMemberRead(label)) {
        const name = label.replace(/^\??\./, "");
        return `_get(${arg(0)}, ${JSON.stringify(name)})`;
      }
    }
    if (label === "CallExpression" || label === "NewExpression") {
      // `(0, f)(x)` calls f: the comma's first operand is a literal, which does nothing.
      let callee = ins[0] as ValueId;
      const viaComma = producer.get(callee);
      if (
        viaComma?.label === "," &&
        producer.get(viaComma.inputs[0] as ValueId)?.kind === "literal-source"
      ) {
        callee = viaComma.inputs[1] as ValueId;
      }
      const args = ins.slice(1).map((v) => ref(v));
      const amb = ambientMember(callee);
      if (amb !== undefined) {
        const fn = AMBIENT_MEMBERS[amb.ns]?.[amb.member];
        if (fn === undefined)
          throw new PyEmitError(`${amb.ns}.${amb.member} has no Python form here`);
        return fn(args);
      }
      const cp = producer.get(callee);
      const platform = producer.get(outerOf(callee));
      if (
        platform?.kind === "diamond-source" &&
        platform.diamond?.reason === "platform-primitive"
      ) {
        const sym = platform.diamond.symbol;
        if (ERRORS.has(sym)) return `JsError(${args[0] ?? "UNDEFINED"}, ${JSON.stringify(sym)})`;
        const call = AMBIENT_CALLS[sym];
        if (call === undefined) throw new PyEmitError(`${sym}(...) has no Python form here`);
        return call(args);
      }
      if (cp?.kind === "diamond-source" && cp.diamond?.reason === "platform-primitive") {
        const sym = cp.diamond.symbol;
        if (ERRORS.has(sym)) return `JsError(${args[0] ?? "UNDEFINED"}, ${JSON.stringify(sym)})`;
        const call = AMBIENT_CALLS[sym];
        if (call === undefined) throw new PyEmitError(`${sym}(...) has no Python form here`);
        return call(args);
      }
      if (cp !== undefined && inline.has(cp.id) && isMemberRead(cp.label ?? "")) {
        const method = (cp.label ?? "").replace(/^\??\./, "");
        const fn = METHODS[method];
        if (fn === undefined) throw new PyEmitError(`the method ${method} has no Python form here`);
        return fn(ref(cp.inputs[0] as ValueId), args);
      }
      if (label === "NewExpression")
        throw new PyEmitError("new of a value other than an Error has no Python form here");
      return `${ref(callee)}(${args.join(", ")})`;
    }
    if (label === "ArrayLiteral") {
      // A spread is written in the list itself: `*xs` is not an expression on its own.
      const items = ins.map((v) => {
        const p = producer.get(v);
        return p !== undefined && p.label === "..."
          ? `*_values(${ref(p.inputs[0] as ValueId)})`
          : ref(v);
      });
      return `[${items.join(", ")}]`;
    }
    if (label.startsWith("object:")) {
      const entries = JSON.parse(label.slice("object:".length)) as unknown[];
      let at = 0;
      const next = (): string => ref(ins[at++] as ValueId);
      const parts = entries.map((entry) => {
        if (entry === null) return `**${next()}`;
        if (typeof entry === "string") return `${JSON.stringify(entry)}: ${next()}`;
        throw new PyEmitError(
          "an object with a computed key, a method or an accessor has no Python form here",
        );
      });
      return `{${parts.join(", ")}}`;
    }
    if (label.startsWith("template:")) {
      const texts = JSON.parse(label.slice("template:".length)) as string[];
      const pieces: string[] = [];
      texts.forEach((t, i) => {
        if (t !== "") pieces.push(JSON.stringify(t));
        if (i < ins.length) pieces.push(`_str(${arg(i)})`);
      });
      return pieces.length > 0 ? `(${pieces.join(" + ")})` : '""';
    }
    throw new PyEmitError(`the operation "${label}" has no Python form`);
  };

  const statementsOf = (node: DucNode): string[] => {
    const out = node.outputs[0];
    const label = node.label ?? "";
    if (node.kind === "literal-source") return [`${nameOf(out as ValueId)} = UNDEFINED`];
    if (node.kind === "sel") return [`${nameOf(out as ValueId)} = ${render(node)}`];
    if (node.kind !== "op") throw new PyEmitError(`a ${node.kind} is not a statement`);
    const arg = (i: number): string => ref(node.inputs[i] as ValueId);
    if (label === "throw") {
      const thrown = producer.get(node.inputs[0] as ValueId);
      return [
        thrown !== undefined && /^JsError\(/.test(safeRender(thrown))
          ? `raise ${arg(0)}`
          : `raise JsThrow(${arg(0)})`,
      ];
    }
    if (out === undefined) {
      // A call or another expression run for its effect.
      return [render(node)];
    }
    const name = nameOf(out);
    if (node.closure !== undefined) {
      if (label === "function")
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
    if (["+=", "-=", "*=", "/=", "%="].includes(label)) {
      const op = label.slice(0, -1);
      const fn =
        op === "+"
          ? `_add(${arg(0)}, ${arg(1)})`
          : op === "/"
            ? `_div(${arg(0)}, ${arg(1)})`
            : op === "%"
              ? `_rem(${arg(0)}, ${arg(1)})`
              : `(_num(${arg(0)}) ${op} _num(${arg(1)}))`;
      return [`${name} = ${fn}`];
    }
    if (label === "++" || label === "post++") return [`${name} = _num(${arg(0)}) + 1`];
    if (label === "--" || label === "post--") return [`${name} = _num(${arg(0)}) - 1`];
    if (label.startsWith(".") && label.endsWith("="))
      return [`${name} = _put(${arg(0)}, ${JSON.stringify(label.slice(1, -1))}, ${arg(1)})`];
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
  const needs = (node: DucNode): ValueId[] =>
    node.inputs.flatMap((v) => {
      const p = producer.get(v);
      return p !== undefined && inline.has(p.id) ? needs(p) : [v];
    });

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
    const inner = [...body, ...next];
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
        produces: node.outputs,
        requires: needs(node),
        lines: () => statementsOf(node),
      });
    }
    for (const loop of loops) {
      if (loop.region !== scope) continue;
      items.push({
        first: nodeIndex.get(loop.id) as number,
        last: 0,
        produces: loop.outputs,
        requires: loop.inputs,
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
        ...subtree.flatMap((n) => n.inputs),
        ...joins.flatMap((n) => n.inputs),
      ];
      items.push({
        first: Math.min(
          g.nodes.length,
          ...[...subtree, ...joins].map((n) => nodeIndex.get(n.id) as number),
        ),
        last: subtree.some((n) => n.label === "throw") ? 1 : 0,
        produces: joins.flatMap((n) => n.outputs),
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
          return p === undefined || done.has(p);
        });
      const rank = Math.min(...items.filter(ready).map((item) => item.last));
      const next = items.findIndex((item, i) => ready(item, i) && item.last === rank);
      if (next === -1) throw new PyEmitError("the graph has a cycle");
      done.add(next);
      lines.push(...(items[next] as Item).lines());
    }
    return lines;
  }

  const params = g.nodes
    .filter((n) => n.kind === "param-source" && Number(n.label) >= bound.length)
    .sort((a, b) => Number(a.label) - Number(b.label))
    .map((n) => `${nameOf(n.outputs[0] as ValueId)}=UNDEFINED`);
  // A JavaScript function ignores arguments past its parameters.
  params.push("*_rest");
  const body = emitScope(undefined);
  const obs = g.obs[0];
  if (obs !== undefined) body.push(`return ${ref(obs)}`);
  else body.push("return UNDEFINED");
  return { params, body };
}
