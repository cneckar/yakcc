// SPDX-License-Identifier: Apache-2.0
/**
 * Raising the Python lowering back (#1278): the Python `emitPython` writes, read as the TypeScript
 * it means, so lower → raise → lift can be checked against the graph's identity. As for Rust and Go,
 * each prelude call maps back to the reference vocabulary; statements are read by their indentation
 * into the same shapes, with the prelude's names translated to the Rust lowering's, and written by
 * the same writer. It reads the lowering's own dialect, not Python in general.
 */
import { execFileSync } from "node:child_process";
import { PRIMITIVE_COMMENT } from "./params.js";
import { type Expr, RaiseError, type Stmt, paramText, writeFunction } from "./raise-rust.js";

/** A table's own entry for a key: never one of Object.prototype's (`hasOwnProperty`, `constructor`). */
function entry<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

type Tok = { readonly k: "id" | "num" | "str" | "p"; readonly v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j] as string)) j++;
      out.push({ k: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?(e[+-]?[0-9]+)?/i.exec(src.slice(i)) as RegExpExecArray;
      out.push({ k: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      // A string the lowering wrote with JSON.stringify: read it as JSON.
      let j = i + 1;
      while (src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out.push({ k: "str", v: JSON.parse(src.slice(i, j + 1)) as string });
      i = j + 1;
      continue;
    }
    out.push({ k: "p", v: c });
    i++;
  }
  return out;
}

/** Prelude names, where the Rust lowering's differ from the name without its underscore. */
const NAMES: Record<string, string> = {
  _typeof: "type_of",
  _try: "try_catch",
  _test: "re_test",
  _replace: "replace_str",
  _map: "map_arr",
  _filter: "filter_arr",
  _for_each: "for_each_arr",
  _some: "some_arr",
  _every: "every_arr",
  _find: "find_arr",
  _find_index: "find_index_arr",
  _reduce: "reduce_arr",
  _max: "math_max",
  _min: "math_min",
  _string_of: "str_v",
};

const LIST_AFTER_FIRST = new Set([
  "push",
  "reduce_arr",
  "concat",
  "call",
  "call_opt",
  "call_detached",
  "to_string_m",
]);
const LIST_ALL = new Set(["math_max", "math_min", "try_catch"]);

const NAMED: Record<string, Expr> = {
  True: { t: "name", name: "true" },
  False: { t: "name", name: "false" },
  None: { t: "name", name: "V::Null" },
  UNDEFINED: { t: "name", name: "V::Undef" },
  NONE: { t: "name", name: "NONE" },
  _JS_NAN: { t: "call", fn: "n", args: [{ t: "name", name: "f64::NAN" }] },
  _JS_INF: { t: "call", fn: "n", args: [{ t: "name", name: "f64::INFINITY" }] },
  _arguments: { t: "call", fn: "arr", args: [{ t: "name", name: "args" }] },
  _fn_parse_int: { t: "call", fn: "fn_parse_int", args: [] },
  _fn_parse_float: { t: "call", fn: "platform", args: [{ t: "str", v: "parseFloat" }] },
  _fn_string: { t: "call", fn: "fn_string", args: [] },
  _fn_number: { t: "call", fn: "fn_number", args: [] },
  _fn_boolean: { t: "call", fn: "fn_boolean", args: [] },
  _fn_is_nan: { t: "call", fn: "platform", args: [{ t: "str", v: "isNaN" }] },
};

class ExprParser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private next(): Tok {
    const t = this.toks[this.i++];
    if (t === undefined) throw new RaiseError("unexpected end of expression");
    return t;
  }
  private is(v: string): boolean {
    const t = this.toks[this.i];
    return t !== undefined && t.k !== "str" && t.v === v;
  }
  private eat(v: string): void {
    const t = this.next();
    if (t.k === "str" || t.v !== v) throw new RaiseError(`expected ${v}, found ${t.v}`);
  }
  done(): boolean {
    return this.i >= this.toks.length;
  }

  /** An argument: an expression, or `*e`, a spread. */
  private args(close: string): Expr[] {
    const out: Expr[] = [];
    while (!this.is(close)) {
      if (this.is("*")) {
        this.eat("*");
        out.push({ t: "call", fn: "__star", args: [this.expr()] });
      } else out.push(this.expr());
      if (this.is(",")) this.eat(",");
    }
    this.eat(close);
    return out;
  }

  expr(): Expr {
    // `a | b` only joins regex flags, which the raiser does not need.
    const e = this.unary();
    while (this.is("|")) {
      this.eat("|");
      this.unary();
    }
    return e;
  }

  private unary(): Expr {
    const t = this.next();
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.k === "num") return { t: "num", v: t.v };
    if (t.v === "-") return { t: "neg", e: this.unary() };
    if (t.v === "(") {
      const e = this.expr();
      this.eat(")");
      return e;
    }
    if (t.v === "[") return { t: "slice", items: this.args("]") };
    if (t.v === "lambda") {
      this.eat(":");
      return { t: "thunk", body: this.expr() };
    }
    if (t.k !== "id") throw new RaiseError(`unexpected ${t.v}`);
    if (!this.is("(")) return entry(NAMED, t.v) ?? { t: "name", name: t.v };
    this.eat("(");
    return this.call(t.v, this.args(")"));
  }

  /** A prelude call as the Rust lowering writes the same operation. */
  private call(pyName: string, given: Expr[]): Expr {
    let args = given;
    const star = args.some((a) => a.t === "call" && a.fn === "__star");
    // A spread argument of a call: `f(...xs)`.
    if (star && pyName !== "_arr")
      args = args.map(
        (a): Expr =>
          a.t === "call" && a.fn === "__star"
            ? { t: "call", fn: "__spread_arg", args: (a.args[0] as { args: Expr[] }).args }
            : a,
      );
    if (pyName === "_re_js") {
      const lit = (args[0] as { v: string }).v;
      const end = lit.lastIndexOf("/");
      return {
        t: "call",
        fn: "re",
        args: [
          { t: "str", v: lit.slice(1, end) },
          { t: "str", v: lit.slice(end + 1) },
        ],
      };
    }
    if (pyName === "_template") {
      const [texts, ...vals] = args;
      return { t: "call", fn: "template", args: [texts as Expr, { t: "vec", items: vals }] };
    }
    if (pyName === "_obj") {
      const entries = args.map((a): Expr => {
        const c = a as { fn: string; args: Expr[] };
        return c.fn === "ospread"
          ? { t: "call", fn: "Entry::Spread", args: c.args }
          : { t: "call", fn: "Entry::Key", args: c.args };
      });
      return { t: "call", fn: "obj", args: [{ t: "vec", items: entries }] };
    }
    if (pyName === "_arr") {
      if (!star) return { t: "call", fn: "arr", args: [{ t: "vec", items: args }] };
      const parts = args.map((a): Expr => {
        if (a.t === "call" && a.fn === "__star") {
          const inner = a.args[0] as { args: Expr[] };
          return { t: "call", fn: "values", args: inner.args };
        }
        return { t: "vec", items: [a] };
      });
      return { t: "call", fn: "spread", args: [{ t: "vec", items: parts }] };
    }
    if (pyName === "_new_error" || pyName === "_call_error")
      return { t: "call", fn: pyName.slice(1), args };
    if (pyName === "_parse_float") return { t: "call", fn: "parse_float", args };
    if (pyName === "_is_nullish") return { t: "call", fn: "is_nullish", args };
    if (!pyName.startsWith("_")) {
      // A call of a free name the lowering wrote directly: not the dialect.
      throw new RaiseError(`the call ${pyName}(...) is not of the dialect`);
    }
    const fn = entry(NAMES, pyName) ?? pyName.slice(1);
    if (LIST_ALL.has(fn)) return { t: "call", fn, args: [{ t: "vec", items: args }] };
    if (LIST_AFTER_FIRST.has(fn))
      return { t: "call", fn, args: [args[0] as Expr, { t: "vec", items: args.slice(1) }] };
    return { t: "call", fn, args };
  }
}

function parseExpr(text: string): Expr {
  const p = new ExprParser(tokenize(text));
  const e = p.expr();
  if (!p.done()) throw new RaiseError(`more after the expression: ${text}`);
  return e;
}

interface Line {
  readonly indent: number;
  readonly text: string;
}

class Reader {
  private i = 0;
  constructor(private readonly lines: Line[]) {}

  /** A function's parameters, from its header's `(..)`, and its body below it. */
  fn(
    header: string,
    indent: number,
  ): { params: { name: string; rest: boolean; prim?: boolean }[]; body: Stmt[] } {
    const inside = header.slice(header.indexOf("(") + 1, header.lastIndexOf(")"));
    const params: { name: string; rest: boolean; prim?: boolean }[] = [];
    let usesArgs = false;
    let restName: string | undefined;
    for (const raw of inside.split(",").map((x) => x.trim())) {
      if (raw === "*_args") usesArgs = true;
      else if (raw === "*_rest" || raw === "") continue;
      else if (raw.startsWith("*")) restName = raw.slice(1);
      else {
        // `v0: "primitive"=UNDEFINED` is a parameter declared a primitive (#1370).
        const prim = /^\w+\s*:\s*"primitive"/.test(raw);
        params.push({ name: raw.replace(/[:=].*$/, "").trim(), rest: false, prim });
      }
    }
    const body = this.block(indent);
    const out: Stmt[] = [];
    for (const st of body) {
      // The bindings of `arguments` mode and of a rest parameter are the parameters.
      if (st.t === "expr" && st.e.t === "call" && st.e.fn === "__args_binding") {
        const [name, at] = st.e.args as unknown as [{ v: string }, { v: string }];
        params[Number(at.v)] = { name: name.v, rest: false };
        continue;
      }
      if (st.t === "expr" && st.e.t === "call" && st.e.fn === "__rest_binding") {
        restName = (st.e.args[0] as { v: string }).v;
        continue;
      }
      if (st.t === "expr" && st.e.t === "call" && st.e.fn === "__skip") continue;
      out.push(st);
    }
    if (restName !== undefined) params.push({ name: restName, rest: true });
    if (usesArgs && params.some((p) => p === undefined))
      throw new RaiseError("a gap in the parameters");
    return { params, body: out };
  }

  /** The statements more indented than `indent`. */
  block(indent: number): Stmt[] {
    const out: Stmt[] = [];
    while (this.i < this.lines.length && (this.lines[this.i] as Line).indent > indent) {
      const st = this.stmt();
      if (st !== undefined) out.push(...(Array.isArray(st) ? st : [st]));
    }
    return out;
  }

  private stmt(): Stmt | Stmt[] | undefined {
    const { indent, text } = this.lines[this.i++] as Line;
    let m: RegExpExecArray | null;
    if (text === "pass") return undefined;
    if (text === "break") return { t: "break" };
    // biome-ignore lint/suspicious/noAssignInExpressions: one match per form, tried in order
    if ((m = /^def (\w+)\((.*)\):$/.exec(text)) !== null) {
      const { params, body } = this.fn(text, indent);
      return {
        t: "closure",
        name: m[1] as string,
        captures: [],
        body: [
          {
            t: "expr",
            e: {
              t: "call",
              fn: "__params",
              args: params.map((p) => ({ t: "str", v: paramText(p) })),
            },
          },
          ...body,
        ],
      };
    }
    // biome-ignore lint/suspicious/noAssignInExpressions: one match per form, tried in order
    if ((m = /^if not _truthy\((.*)\):$/.exec(text)) !== null) {
      const body = this.block(indent);
      if (body.length !== 1 || body[0]?.t !== "break")
        throw new RaiseError("a guard without its break");
      return { t: "guard", c: parseExpr(m[1] as string) };
    }
    // biome-ignore lint/suspicious/noAssignInExpressions: one match per form, tried in order
    if ((m = /^if _truthy\((.*)\):$/.exec(text)) !== null) {
      const c = parseExpr(m[1] as string);
      const then = this.block(indent);
      const next = this.lines[this.i];
      if (next === undefined || next.indent !== indent || next.text !== "else:")
        return { t: "if", c, then };
      this.i++;
      const otherwise = this.block(indent);
      // A join is assigned on both sides (Python has no block scope): it is declared before the if.
      const joins = then.flatMap((st) =>
        st.t === "let" && otherwise.some((o) => o.t === "assign" && o.name === st.name)
          ? [st.name]
          : [],
      );
      const declared: Stmt[] = joins.map((name) => ({
        t: "let",
        name,
        e: { t: "name", name: "V::Undef" },
      }));
      const asAssign = (list: Stmt[]): Stmt[] =>
        list.map((st) =>
          st.t === "let" && joins.includes(st.name) ? { t: "assign", name: st.name, e: st.e } : st,
        );
      // biome-ignore lint/suspicious/noThenProperty: the statement's own field, never awaited
      return [...declared, { t: "if", c, then: asAssign(then), else: otherwise }];
    }
    // biome-ignore lint/suspicious/noAssignInExpressions: one match per form, tried in order
    if ((m = /^while _truthy\((.*)\):$/.exec(text)) !== null)
      return { t: "while", c: parseExpr(m[1] as string), body: this.block(indent) };
    // biome-ignore lint/suspicious/noAssignInExpressions: one match per form, tried in order
    if ((m = /^for (\w+) in _(values|keys)\((.*)\):$/.exec(text)) !== null)
      return {
        t: "for",
        name: m[1] as string,
        of: m[2] as "values" | "keys",
        e: parseExpr(m[3] as string),
        body: this.block(indent),
      };
    // biome-ignore lint/suspicious/noAssignInExpressions: one match per form, tried in order
    if ((m = /^return (.*)$/.exec(text)) !== null)
      return { t: "return", e: parseExpr(m[1] as string) };
    // biome-ignore lint/suspicious/noAssignInExpressions: one match per form, tried in order
    if ((m = /^(\w+) = _args\[(\d+)\] if len\(_args\) > \d+ else UNDEFINED$/.exec(text)) !== null)
      return {
        t: "expr",
        e: {
          t: "call",
          fn: "__args_binding",
          args: [
            { t: "str", v: m[1] as string },
            { t: "num", v: m[2] as string },
          ],
        },
      };
    if (text === "_arguments = list(_args)")
      return { t: "expr", e: { t: "call", fn: "__skip", args: [] } };
    // biome-ignore lint/suspicious/noAssignInExpressions: one match per form, tried in order
    if ((m = /^(\w+) = list\((\w+)\)$/.exec(text)) !== null && m[1] === m[2])
      return {
        t: "expr",
        e: { t: "call", fn: "__rest_binding", args: [{ t: "str", v: m[1] as string }] },
      };
    // biome-ignore lint/suspicious/noAssignInExpressions: one match per form, tried in order
    if ((m = /^(\w+), = (.*),$/.exec(text)) !== null) {
      // `a, = x,`: one carry.
      return [
        { t: "tuple", items: [parseExpr(m[2] as string)] },
        {
          t: "assign",
          name: m[1] as string,
          e: { t: "field", e: { t: "name", name: "next" }, field: "0" },
        },
      ];
    }
    // biome-ignore lint/suspicious/noAssignInExpressions: one match per form, tried in order
    if ((m = /^(\w+(?:, \w+)+) = (.*)$/.exec(text)) !== null) {
      // `a, b = x, y`: the carries, assigned together.
      const names = (m[1] as string).split(", ");
      const values = splitTop(m[2] as string).map(parseExpr);
      return [
        { t: "tuple", items: values },
        ...names.map(
          (name, i): Stmt => ({
            t: "assign",
            name,
            e: { t: "field", e: { t: "name", name: "next" }, field: String(i) },
          }),
        ),
      ];
    }
    // biome-ignore lint/suspicious/noAssignInExpressions: one match per form, tried in order
    if ((m = /^(\w+) = (.*)$/.exec(text)) !== null) {
      const name = m[1] as string;
      const e = parseExpr(m[2] as string);
      return this.declared.has(name) ? { t: "assign", name, e } : this.declare(name, e);
    }
    const e = parseExpr(text);
    if (e.t === "call" && e.fn === "throw") return { t: "throw", e: e.args[0] as Expr };
    if (e.t === "call" && e.fn === "unread") {
      const thunk = e.args[0] as { body: Expr };
      return { t: "expr", e: thunk.body };
    }
    return { t: "expr", e };
  }

  /** Names assigned before: a second assignment of a name assigns it again. */
  private readonly declared = new Set<string>();
  private declare(name: string, e: Expr): Stmt {
    this.declared.add(name);
    return { t: "let", name, e };
  }
}

/** Splits `a, b(c, d), e` at its top-level commas. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last !== "") out.push(last);
  return out;
}

/** The TypeScript the Python lowering of a graph means: `export function f(..) {..}`. */
export function raisePython(py: string): string {
  const lines: Line[] = py
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  const first = lines[0];
  if (first === undefined || !first.text.startsWith("def f(")) throw new RaiseError("no def f");
  const reader = new Reader(lines.slice(1));
  const { params, body } = reader.fn(first.text, first.indent);
  return writeFunction(params, body);
}

// =================================================================================================
// Raising Python source (#1298)
//
// The functions above read the lowering's own dialect. What follows reads Python as people write
// it: a `def`, parsed by Python's own `ast` module (the standard library, no third-party parser),
// and written as the TypeScript the JavaScript lifter reads.
//
// Each Python operation is written with the reference language's operations, so that the result
// keeps Python's meaning where a composition of them has it: `//` is `Math.floor(a / b)`, `%` is
// `((a % b) + b) % b`, `s.replace(a, b)` replaces every occurrence, a negative literal index counts
// from the end, `str.partition` is a split at the first occurrence. Where no composition has
// Python's meaning, the raiser refuses with a reason (a module global, `int.bit_length`, a slice
// step, printf formatting, …). What it does not refuse but cannot make faithful without types is
// measured, not hidden: Python's integers past 2^53, `int` versus `float`, a tuple versus a list,
// the truthiness of an empty list, and exception classes JavaScript does not have. These are the
// evidence for DEC-DUC-CROSS-LANGUAGE-OPS-001 (proposed), which decides how operations are named
// across languages. This raiser does not change any label the JavaScript lifter writes.
// =================================================================================================

/** A node of Python's `ast`, as `PY_AST_DUMP` writes it: `_t` is the node's class. */
export interface PyNode {
  readonly _t: string;
  readonly [field: string]: unknown;
}

/**
 * The Python program that dumps a module's `ast` as JSON. An int is `{"_t":"int","v":"…"}` and a
 * float `{"_t":"float","v":repr}`, so neither loses precision or its kind in JSON.
 */
export const PY_AST_DUMP = `import ast, json, sys

def conv(x):
    if isinstance(x, ast.AST):
        d = {"_t": type(x).__name__}
        for f in x._fields:
            d[f] = conv(getattr(x, f, None))
        return d
    if isinstance(x, list):
        return [conv(e) for e in x]
    if x is None or isinstance(x, (bool, str)):
        return x
    if isinstance(x, int):
        return {"_t": "int", "v": str(x)}
    if isinstance(x, float):
        return {"_t": "float", "v": repr(x)}
    return {"_t": type(x).__name__}

print(json.dumps(conv(ast.parse(sys.stdin.read()))))
`;

/** Parse Python source with the system's Python (`ast.parse`). Throws RaiseError on a syntax error. */
export function pythonAst(source: string, python = "python3"): PyNode {
  try {
    const out = execFileSync(python, ["-I", "-c", PY_AST_DUMP], {
      input: source,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(out) as PyNode;
  } catch (e) {
    const err = e as { stderr?: string };
    const last =
      String(err.stderr ?? e)
        .trim()
        .split("\n")
        .pop() ?? "";
    throw new RaiseError(`Python could not parse the source: ${last}`);
  }
}

const node = (x: unknown): PyNode => x as PyNode;
const nodes = (x: unknown): PyNode[] => (Array.isArray(x) ? (x as PyNode[]) : []);

/** JavaScript's reserved words: a Python name that is one is written with a trailing `_`. */
const JS_RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends " +
    "false finally for function if import in instanceof new null return super switch this throw " +
    "true try typeof var void while with yield let static implements interface package private " +
    "protected public await arguments eval undefined NaN Infinity"
  ).split(" "),
);

/** Python's exception classes that JavaScript has, by the same name. Others raise `Error`. */
const SAME_ERRORS = new Set(["TypeError", "SyntaxError"]);

const BIN_OPS: Record<string, string> = {
  Add: "+",
  Sub: "-",
  Mult: "*",
  Div: "/",
  Pow: "**",
  LShift: "<<",
  RShift: ">>",
  BitAnd: "&",
  BitOr: "|",
  BitXor: "^",
};

const CMP_OPS: Record<string, string> = {
  Eq: "===",
  NotEq: "!==",
  Lt: "<",
  LtE: "<=",
  Gt: ">",
  GtE: ">=",
  Is: "===",
  IsNot: "!==",
};

/**
 * Compositions of reference operations with CPython's meaning, defined once at the top of a raised
 * function when it uses them. `__divmod` is CPython's float_divmod (Objects/floatobject.c): `//`
 * and `%` take the sign of the divisor and round as CPython does, and a zero divisor raises.
 * `__idx` is Python's subscript check: a negative index counts from the end, and an index out of
 * range raises.
 */
const HELPERS: Record<string, string> = {
  __divmod: [
    "const __divmod = (a, b) => {",
    '  if (b === 0) throw new Error("integer division or modulo by zero");',
    "  let mod = a % b;",
    "  let div = (a - mod) / b;",
    "  if (mod !== 0) {",
    "    if ((b < 0) !== (mod < 0)) {",
    "      mod = mod + b;",
    "      div = div - 1;",
    "    }",
    "  } else {",
    "    mod = b < 0 ? -0 : 0;",
    "  }",
    "  let q = 0;",
    "  if (div !== 0) {",
    "    q = Math.floor(div);",
    "    if (div - q > 0.5) q = q + 1;",
    "  } else {",
    "    q = a / b < 0 ? -0 : 0;",
    "  }",
    "  return [q, mod];",
    "};",
  ].join("\n"),
  __div: [
    "const __div = (a, b) => {",
    '  if (b === 0) throw new Error("division by zero");',
    "  return a / b;",
    "};",
  ].join("\n"),
  __idx: [
    "const __idx = (x, i, what) => {",
    '  if (typeof x === "string" || Array.isArray(x)) {',
    "    if (i < -x.length || i >= x.length) throw new Error(what);",
    "    return i < 0 ? x.length + i : i;",
    "  }",
    "  return i;",
    "};",
  ].join("\n"),
};

/** What a module gives a raised function: its constants, its functions, and what it imports. */
interface ModuleEnv {
  readonly consts: ReadonlyMap<string, PyNode>;
  readonly fns: ReadonlyMap<string, PyNode>;
  readonly imported: ReadonlyMap<string, string>;
  /** Names module statements other than one plain assignment set or change. */
  readonly computed: ReadonlySet<string>;
}

/** Shared by the raisers of one function and of the module names it reads. */
interface Hoist {
  readonly env: ModuleEnv;
  readonly helpers: Set<string>;
  /** Module names raised as local definitions, in dependency order. */
  readonly defs: Map<string, string[]>;
}

function moduleEnv(body: readonly PyNode[], target: PyNode): ModuleEnv {
  const consts = new Map<string, PyNode>();
  const fns = new Map<string, PyNode>();
  const imported = new Map<string, string>();
  const computed = new Set<string>();
  const assigned = new Map<string, number>();
  // The names a module statement sets (stores) or changes (the receiver of a method call).
  const stored = (n: PyNode, out: Set<string>): void => {
    if (n._t === "Name" && node(n.ctx)._t === "Store") out.add(String(n.id));
    if (
      n._t === "Call" &&
      node(n.func)._t === "Attribute" &&
      node(node(n.func).value)._t === "Name"
    )
      out.add(String(node(node(n.func).value).id));
    for (const v of Object.values(n)) {
      if (Array.isArray(v))
        for (const c of v)
          if (c !== null && typeof c === "object" && "_t" in c) stored(c as PyNode, out);
      if (v !== null && typeof v === "object" && "_t" in (v as object)) stored(v as PyNode, out);
    }
  };
  for (const st of body) {
    if (st === target) continue;
    if (st._t === "FunctionDef") fns.set(String(st.name), st);
    else if (st._t === "Import" || st._t === "ImportFrom")
      for (const a of nodes(st.names)) {
        const as = String(a.asname ?? a.name).split(".")[0] as string;
        imported.set(as, String(st._t === "ImportFrom" ? st.module : a.name));
      }
    else if (
      st._t === "Assign" &&
      nodes(st.targets).length === 1 &&
      node(nodes(st.targets)[0])._t === "Name"
    ) {
      const name = String(node(nodes(st.targets)[0]).id);
      consts.set(name, node(st.value));
      assigned.set(name, (assigned.get(name) ?? 0) + 1);
    } else {
      const names = new Set<string>();
      stored(st, names);
      for (const n of names) computed.add(n);
    }
  }
  for (const [n, count] of assigned) if (count > 1) computed.add(n);
  return { consts, fns, imported, computed };
}

class PySourceRaiser {
  private readonly scope = new Set<string>();
  private temp = 0;

  constructor(
    private readonly fn: PyNode | undefined,
    private readonly hoist: Hoist,
  ) {}

  /** The function as `function <name>(…) {…}` lines; `name` is `f` for the raised function. */
  run(name: string): string[] {
    const fn = this.fn as PyNode;
    const args = node(fn.args);
    if (
      nodes(args.posonlyargs).length > 0 ||
      args.vararg ||
      args.kwarg ||
      nodes(args.kwonlyargs).length > 0
    )
      throw new RaiseError("a parameter that is not positional (*args, **kwargs, keyword-only)");
    if (nodes(fn.decorator_list).length > 0) throw new RaiseError("a decorator");
    const params = nodes(args.args).map((a) => String(a.arg));
    for (const p of params) this.scope.add(p);
    const defaults = nodes(args.defaults);
    const first = params.length - defaults.length;
    const locals = [...this.storedNames(nodes(fn.body))].filter((n) => !this.scope.has(n));
    for (const l of locals) this.scope.add(l);
    // A parameter hinted `float`, `int`, `str` or `bool` is declared a primitive, as TypeScript's
    // `number` is (#1370): no operator on it runs a dunder method.
    const hinted = nodes(args.args).map((a) => {
      const t = a.annotation as PyNode | undefined;
      return (
        t !== undefined &&
        t !== null &&
        node(t)._t === "Name" &&
        ["float", "int", "str", "bool"].includes(String(node(t).id))
      );
    });
    const head = params
      .map((p, i) => {
        const name = `${this.id(p)}${hinted[i] === true ? ` ${PRIMITIVE_COMMENT}` : ""}`;
        return i >= first ? `${name} = ${this.expr(defaults[i - first] as PyNode)}` : name;
      })
      .join(", ");
    const body = [
      ...locals.map((l) => `let ${this.id(l)} = undefined;`),
      ...this.block(nodes(fn.body)),
      // Falling off the end of a Python function returns None.
      "return null;",
    ];
    return [`function ${name}(${head}) {`, ...this.indent(body), "}"];
  }

  private id(name: string): string {
    return JS_RESERVED.has(name) ? `${name}_` : name;
  }

  /** The names a body assigns: Python's locals (a name assigned anywhere in a function is local). */
  private storedNames(body: readonly PyNode[]): Set<string> {
    const out = new Set<string>();
    const target = (t: PyNode): void => {
      if (t._t === "Name") out.add(String(t.id));
      else if (t._t === "Tuple" || t._t === "List") for (const e of nodes(t.elts)) target(e);
    };
    const visit = (s: PyNode): void => {
      if (s._t === "Assign") for (const t of nodes(s.targets)) target(t);
      if (s._t === "AugAssign" || s._t === "AnnAssign") target(node(s.target));
      if (s._t === "For") target(node(s.target));
      for (const k of ["body", "orelse", "finalbody"]) for (const c of nodes(s[k])) visit(c);
    };
    for (const s of body) visit(s);
    return out;
  }

  /** A module-level name the function reads: raised once, as a local definition. */
  private moduleName(name: string): string {
    const { env, defs } = this.hoist;
    if (defs.has(name)) return this.id(name);
    if (env.computed.has(name))
      throw new RaiseError(`reads the module name ${name}, which module statements compute`);
    const imported = env.imported.get(name);
    if (imported !== undefined)
      throw new RaiseError(`reads the imported module or name ${name} (${imported})`);
    const fn = env.fns.get(name);
    const value = env.consts.get(name);
    if (fn === undefined && value === undefined) throw new RaiseError(`reads the builtin ${name}`);
    defs.set(name, []); // placeholder: a recursive reference resolves to the name
    const lines =
      fn !== undefined
        ? new PySourceRaiser(fn, this.hoist).run(this.id(name))
        : [
            `const ${this.id(name)} = ${new PySourceRaiser(undefined, this.hoist).expr(value as PyNode)};`,
          ];
    defs.delete(name);
    defs.set(name, lines);
    return this.id(name);
  }

  private helper(name: string): string {
    this.hoist.helpers.add(name);
    return name;
  }

  private fresh(): string {
    this.temp++;
    return `__t${this.temp}`;
  }

  private block(body: readonly PyNode[]): string[] {
    return body.flatMap((s) => this.stmt(s));
  }

  private indent(lines: readonly string[]): string[] {
    return lines.map((l) => `  ${l}`);
  }

  private stmt(s: PyNode): string[] {
    switch (s._t) {
      case "Expr": {
        const v = node(s.value);
        if (v._t === "Constant" && typeof v.value === "string") return []; // a docstring
        return [`${this.expr(v)};`];
      }
      case "Pass":
        return [];
      case "Return":
        return [`return ${s.value === null ? "null" : this.expr(node(s.value))};`];
      case "Assign": {
        const targets = nodes(s.targets);
        if (targets.length !== 1)
          throw new RaiseError("an assignment to several targets (a = b = …)");
        return this.assign(targets[0] as PyNode, this.expr(node(s.value)));
      }
      case "AugAssign": {
        const t = node(s.target);
        return this.assign(
          t,
          this.binop(String(node(s.op)._t), this.expr(t), this.expr(node(s.value)), t),
        );
      }
      case "If": {
        const out = [
          `if (${this.expr(node(s.test))}) {`,
          ...this.indent(this.block(nodes(s.body))),
        ];
        const orelse = nodes(s.orelse);
        if (orelse.length > 0) out.push("} else {", ...this.indent(this.block(orelse)));
        out.push("}");
        return out;
      }
      case "While":
        if (nodes(s.orelse).length > 0) throw new RaiseError("a while loop with an else");
        return [
          `while (${this.expr(node(s.test))}) {`,
          ...this.indent(this.block(nodes(s.body))),
          "}",
        ];
      case "For":
        return this.forLoop(s);
      case "Break":
        return ["break;"];
      case "Continue":
        return ["continue;"];
      case "Raise":
        return [`throw ${this.exception(s.exc === null ? undefined : node(s.exc))};`];
      case "Assert": {
        const msg = s.msg === null ? "" : `String(${this.expr(node(s.msg))})`;
        return [`if (!(${this.expr(node(s.test))})) throw new Error(${msg});`];
      }
      case "Global":
      case "Nonlocal":
        throw new RaiseError(`a ${s._t.toLowerCase()} statement`);
      default:
        throw new RaiseError(`the statement ${s._t}`);
    }
  }

  private assign(t: PyNode, value: string): string[] {
    if (t._t === "Name") return [`${this.id(String(t.id))} = ${value};`];
    if (t._t === "Subscript") {
      const sl = node(t.slice);
      if (sl._t === "Slice") throw new RaiseError("an assignment to a slice");
      const of = this.expr(node(t.value));
      return [
        `${of}[${this.helper("__idx")}(${of}, ${this.expr(sl)}, "list assignment index out of range")] = ${value};`,
      ];
    }
    if (t._t === "Tuple" || t._t === "List") {
      const tmp = this.fresh();
      const elts = nodes(t.elts);
      if (elts.some((e) => e._t === "Starred")) throw new RaiseError("a starred assignment target");
      // Python unpacks exactly: a length mismatch is a ValueError.
      return [
        `const ${tmp} = ${value};`,
        `if (${tmp}.length !== ${elts.length}) throw new Error("unpack: expected ${elts.length} values");`,
        ...elts.flatMap((e, i) => this.assign(e, `${tmp}[${i}]`)),
      ];
    }
    throw new RaiseError(`an assignment to ${t._t}`);
  }

  private forLoop(s: PyNode): string[] {
    if (nodes(s.orelse).length > 0) throw new RaiseError("a for loop with an else");
    const t = node(s.target);
    if (t._t !== "Name")
      throw new RaiseError("a for loop over a tuple target (enumerate, zip, items)");
    const v = this.id(String(t.id));
    const it = node(s.iter);
    const body = this.indent(this.block(nodes(s.body)));
    const f = node(it.func);
    if (it._t === "Call" && f._t === "Name" && f.id === "range" && !this.scope.has("range")) {
      const a = nodes(it.args);
      const step = a[2];
      const [start, stop] =
        a.length === 1
          ? ["0", this.expr(a[0] as PyNode)]
          : [this.expr(a[0] as PyNode), this.expr(a[1] as PyNode)];
      const neg = step !== undefined && this.isNegativeLiteral(step);
      if (step !== undefined && !neg && !this.isPositiveLiteral(step))
        throw new RaiseError("a range whose step is not a literal");
      const i = this.fresh();
      const by = step === undefined ? "1" : this.expr(step);
      return [
        `for (let ${i} = ${start}; ${i} ${neg ? ">" : "<"} ${stop}; ${i} += ${by}) {`,
        `  ${v} = ${i};`,
        ...body,
        "}",
      ];
    }
    const e = this.fresh();
    return [`for (const ${e} of ${this.expr(it)}) {`, `  ${v} = ${e};`, ...body, "}"];
  }

  private isNegativeLiteral(n: PyNode): boolean {
    return n._t === "UnaryOp" && node(n.op)._t === "USub" && node(n.operand)._t === "Constant";
  }

  private isPositiveLiteral(n: PyNode): boolean {
    return n._t === "Constant" && node(n.value)._t === "int" && Number(node(n.value).v) > 0;
  }

  private exception(exc: PyNode | undefined): string {
    if (exc === undefined) throw new RaiseError("a bare raise (re-raise)");
    const call = exc._t === "Call" ? exc : undefined;
    const cls = call !== undefined ? node(call.func) : exc;
    if (cls._t !== "Name") throw new RaiseError("raising an exception that is not a class by name");
    const name = String(cls.id);
    const args = call !== undefined ? nodes(call.args) : [];
    const msg = args.length === 0 ? "" : `String(${this.expr(args[0] as PyNode)})`;
    // JavaScript has TypeError and SyntaxError; Python's other classes have no reference form.
    return `new ${SAME_ERRORS.has(name) ? name : "Error"}(${msg})`;
  }

  /** `'…%d…%s…' % args` with `%d`, `%s` and `%%` only: `%d` of a number truncates it. */
  private printf(format: string, args: PyNode | undefined): string {
    if (args === undefined) throw new RaiseError("printf-style formatting of a computed format");
    const values = args._t === "Tuple" ? nodes(args.elts) : [args];
    const parts = format.split(/(%[%ds])/);
    let k = 0;
    const out = parts.map((p) => {
      if (p === "%%") return "%";
      if (p === "%d" || p === "%s") {
        const v = values[k++];
        if (v === undefined) throw new RaiseError("printf-style formatting with too few arguments");
        const x = this.expr(v);
        return `\${String(${p === "%d" ? `Math.trunc(${x})` : x})}`;
      }
      if (p.includes("%"))
        throw new RaiseError("printf-style formatting with a conversion other than %d, %s");
      return p.replace(/[`\\$]/g, (c) => `\\${c}`);
    });
    if (k !== values.length)
      throw new RaiseError("printf-style formatting with too many arguments");
    return `\`${out.join("")}\``;
  }

  private binop(op: string, a: string, b: string, left?: PyNode, right?: PyNode): string {
    if (op === "FloorDiv") return `${this.helper("__divmod")}(${a}, ${b})[0]`;
    if (op === "Mod") {
      if (left?._t === "Constant" && typeof left.value === "string")
        return this.printf(String(left.value), right);
      return `${this.helper("__divmod")}(${a}, ${b})[1]`;
    }
    if (op === "Div") return `${this.helper("__div")}(${a}, ${b})`;
    if (op === "MatMult") throw new RaiseError("the @ operator");
    const js = BIN_OPS[op];
    if (js === undefined) throw new RaiseError(`the operator ${op}`);
    return `(${a} ${js} ${b})`;
  }

  private constant(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "boolean") return String(v);
    if (typeof v === "string") return JSON.stringify(v);
    const c = node(v);
    if (c._t === "int") {
      if (Math.abs(Number(c.v)) > 2 ** 53) throw new RaiseError("an integer literal past 2^53");
      return String(c.v);
    }
    if (c._t === "float") {
      const text = String(c.v);
      if (text === "inf") return "Infinity";
      if (text === "nan") return "NaN";
      return text;
    }
    throw new RaiseError(`a ${c._t} literal`);
  }

  expr(n: PyNode): string {
    switch (n._t) {
      case "Constant":
        return this.constant(n.value);
      case "Name": {
        const name = String(n.id);
        return this.scope.has(name) ? this.id(name) : this.moduleName(name);
      }
      case "BinOp":
        return this.binop(
          String(node(n.op)._t),
          this.expr(node(n.left)),
          this.expr(node(n.right)),
          node(n.left),
          node(n.right),
        );
      case "UnaryOp": {
        const op = String(node(n.op)._t);
        const a = this.expr(node(n.operand));
        if (op === "Not") return `!(${a})`;
        if (op === "USub") return `(-${a})`;
        if (op === "UAdd") return `(+${a})`;
        return `(~${a})`;
      }
      case "BoolOp": {
        const js = node(n.op)._t === "And" ? " && " : " || ";
        return `(${nodes(n.values)
          .map((v) => this.expr(v))
          .join(js)})`;
      }
      case "Compare": {
        const ops = nodes(n.ops);
        const operands = [node(n.left), ...nodes(n.comparators)];
        const parts = ops.map((o, i) => {
          const a = this.expr(operands[i] as PyNode);
          const b = this.expr(operands[i + 1] as PyNode);
          if (o._t === "In") return `${b}.includes(${a})`;
          if (o._t === "NotIn") return `!${b}.includes(${a})`;
          return `(${a} ${CMP_OPS[o._t] as string} ${b})`;
        });
        return parts.length === 1 ? (parts[0] as string) : `(${parts.join(" && ")})`;
      }
      case "IfExp":
        return `(${this.expr(node(n.test))} ? ${this.expr(node(n.body))} : ${this.expr(node(n.orelse))})`;
      case "Tuple":
      case "List": {
        const elts = nodes(n.elts);
        if (elts.some((e) => e._t === "Starred")) throw new RaiseError("a starred element");
        return `[${elts.map((e) => this.expr(e)).join(", ")}]`;
      }
      case "Dict": {
        const keys = nodes(n.keys);
        const values = nodes(n.values);
        return `{ ${keys
          .map((k, i) => {
            if (k === null || k._t !== "Constant" || typeof k.value !== "string")
              throw new RaiseError("a dict whose key is not a string literal");
            return `${JSON.stringify(k.value)}: ${this.expr(values[i] as PyNode)}`;
          })
          .join(", ")} }`;
      }
      case "Subscript": {
        const sl = node(n.slice);
        const of = this.expr(node(n.value));
        if (sl._t === "Slice") {
          if (sl.step !== null) throw new RaiseError("a slice with a step");
          const lo = sl.lower === null ? "0" : this.expr(node(sl.lower));
          return sl.upper === null
            ? `${of}.slice(${lo})`
            : `${of}.slice(${lo}, ${this.expr(node(sl.upper))})`;
        }
        return `${of}[${this.helper("__idx")}(${of}, ${this.expr(sl)}, (typeof ${of} === "string" ? "string" : "list") + " index out of range")]`;
      }
      case "JoinedStr":
        return `\`${nodes(n.values)
          .map((p) => {
            if (p._t === "Constant") return String(p.value).replace(/[`\\$]/g, (c) => `\\${c}`);
            if (p.format_spec !== null || p.conversion !== -1)
              throw new RaiseError("an f-string field with a format spec or conversion");
            return `\${String(${this.expr(node(p.value))})}`;
          })
          .join("")}\``;
      case "Lambda": {
        const ps = nodes(node(n.args).args).map((x) => String(x.arg));
        for (const p of ps) this.scope.add(p);
        return `((${ps.map((p) => this.id(p)).join(", ")}) => ${this.expr(node(n.body))})`;
      }
      case "Call":
        return this.call(n);
      case "Attribute":
        throw new RaiseError(`reading the attribute .${String(n.attr)}`);
      default:
        throw new RaiseError(`the expression ${n._t}`);
    }
  }

  private call(n: PyNode): string {
    const f = node(n.func);
    if (nodes(n.keywords).length > 0) throw new RaiseError("a call with keyword arguments");
    const args = nodes(n.args);
    if (args.some((a) => a._t === "Starred")) throw new RaiseError("a call with *args");
    const local = f._t === "Name" && this.scope.has(String(f.id));
    const module = f._t === "Name" && !local && this.hoist.env.fns.has(String(f.id));
    const isMap = f._t === "Name" && f.id === "map" && !local && !module;
    // map(str.capitalize, xs): the unbound method is read by map, not as a value.
    const a = args.map((x, i) => (isMap && i === 0 && x._t === "Attribute" ? "" : this.expr(x)));
    if (f._t === "Name" && !local && !module) return this.builtin(String(f.id), a, args);
    if (f._t === "Attribute") return this.method(node(f.value), String(f.attr), a);
    return `${this.expr(f)}(${a.join(", ")})`;
  }

  private builtin(name: string, a: readonly string[], args: readonly PyNode[]): string {
    const one = (): string => {
      if (a.length !== 1) throw new RaiseError(`${name}() with ${a.length} arguments`);
      return a[0] as string;
    };
    switch (name) {
      case "len":
        return `${one()}.length`;
      case "str":
        return `String(${one()})`;
      case "int":
        return `Math.trunc(${one()})`;
      case "float":
        return `Number(${one()})`;
      case "bool":
        return `Boolean(${one()})`;
      case "abs":
        return `Math.abs(${one()})`;
      case "min":
      case "max":
        if (a.length < 2) throw new RaiseError(`${name}() of one iterable`);
        return `Math.${name}(${a.join(", ")})`;
      case "divmod":
        if (a.length !== 2) throw new RaiseError("divmod() with other than 2 arguments");
        return `${this.helper("__divmod")}(${a[0]}, ${a[1]})`;
      case "map": {
        const fn = args[0];
        if (a.length !== 2 || fn === undefined)
          throw new RaiseError("map() with other than 2 arguments");
        if (fn._t === "Attribute" && node(fn.value)._t === "Name" && node(fn.value).id === "str")
          return `${a[1] as string}.map((__w) => ${this.method(undefined, String(fn.attr), [], "__w")})`;
        return `${a[1] as string}.map(${a[0] as string})`;
      }
      default:
        if (
          this.hoist.env.imported.has(name) ||
          this.hoist.env.computed.has(name) ||
          this.hoist.env.consts.has(name)
        )
          return `${this.moduleName(name)}(${a.join(", ")})`;
        throw new RaiseError(`the builtin ${name}()`);
    }
  }

  private method(
    recv: PyNode | undefined,
    m: string,
    a: readonly string[],
    recvText?: string,
  ): string {
    const r = recvText ?? this.expr(recv as PyNode);
    const arity = (lo: number, hi = lo): void => {
      if (a.length < lo || a.length > hi)
        throw new RaiseError(`.${m}() with ${a.length} arguments`);
    };
    // str.split() with no separator splits on runs of whitespace and drops empty strings.
    const words = `${r}.split(/\\s+/).filter((__w) => __w !== "")`;
    switch (m) {
      case "replace":
        arity(2);
        // Python replaces every occurrence.
        return `${r}.split(${a[0]}).join(${a[1]})`;
      case "strip":
      case "lstrip":
      case "rstrip":
        if (a.length > 0) throw new RaiseError(`.${m}() of given characters`);
        return `${r}.${m === "strip" ? "trim" : m === "lstrip" ? "trimStart" : "trimEnd"}()`;
      case "upper":
        arity(0);
        return `${r}.toUpperCase()`;
      case "lower":
        arity(0);
        return `${r}.toLowerCase()`;
      case "startswith":
      case "endswith":
        arity(1);
        return `${r}.${m === "startswith" ? "startsWith" : "endsWith"}(${a[0]})`;
      case "find":
        arity(1, 2);
        return `${r}.indexOf(${a.join(", ")})`;
      case "rfind":
        arity(1);
        return `${r}.lastIndexOf(${a[0]})`;
      case "join":
        arity(1);
        return `${a[0]}.join(${r})`;
      case "split":
        arity(0, 1);
        if (a.length === 1 && a[0] !== "null")
          return `(${a[0]} === null ? ${words} : ${r}.split(${a[0]}))`;
        return words;
      case "partition":
      case "rpartition": {
        arity(1);
        const at = m === "partition" ? "indexOf" : "lastIndexOf";
        const none = m === "partition" ? '[__s, "", ""]' : '["", "", __s]';
        return `((__s, __p, __i) => (__i < 0 ? ${none} : [__s.slice(0, __i), __p, __s.slice(__i + __p.length)]))(${r}, ${a[0]}, ${r}.${at}(${a[0]}))`;
      }
      case "capitalize":
        arity(0);
        return `(${r}.charAt(0).toUpperCase() + ${r}.slice(1).toLowerCase())`;
      case "append":
        arity(1);
        return `${r}.push(${a[0]})`;
      case "format": {
        if (recv === undefined || recv._t !== "Constant" || typeof recv.value !== "string")
          throw new RaiseError(".format() on a string that is not a literal");
        const parts = String(recv.value).split("{}");
        if (parts.some((p) => /[{}]/.test(p)) || parts.length - 1 !== a.length)
          throw new RaiseError(".format() with fields other than {}");
        return `\`${parts.map((p, i) => p.replace(/[`\\$]/g, (c) => `\\${c}`) + (i < a.length ? `\${String(${a[i]})}` : "")).join("")}\``;
      }
      default:
        throw new RaiseError(`the method .${m}()`);
    }
  }
}

/**
 * Raise one Python function to the TypeScript the lifter reads (`export function f(…) {…}`).
 * `module` is the dumped `ast` of a module (`pythonAst`); `name` picks the function, else the last.
 * The module's other top-level statements resolve the names the function reads: a constant
 * assigned once, and a function, are raised as local definitions inside `f` (standing in for a
 * link to the module's atoms); a name module statements compute, an import, or a builtin the
 * raiser does not know is refused. Throws RaiseError with the reason.
 */
export function raisePythonFunction(module: PyNode, name?: string): string {
  const body = nodes(module.body);
  const fns = body.filter((s) => s._t === "FunctionDef" || s._t === "AsyncFunctionDef");
  const fn =
    name === undefined ? fns[fns.length - 1] : [...fns].reverse().find((s) => s.name === name);
  if (fn === undefined) throw new RaiseError(`no function ${name ?? ""} in the module`);
  if (fn._t === "AsyncFunctionDef") throw new RaiseError("an async function");
  const hoist: Hoist = { env: moduleEnv(body, fn), helpers: new Set(), defs: new Map() };
  const [head, ...rest] = new PySourceRaiser(fn, hoist).run("f");
  const prologue = [
    ...[...hoist.helpers].sort().flatMap((h) => (HELPERS[h] as string).split("\n")),
    ...[...hoist.defs.values()].flat(),
  ];
  return [`export ${head as string}`, ...prologue.map((l) => `  ${l}`), ...rest, ""].join("\n");
}
