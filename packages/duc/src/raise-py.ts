// SPDX-License-Identifier: Apache-2.0
/**
 * Raising the Python lowering back (#1278): the Python `emitPython` writes, read as the TypeScript
 * it means, so lower → raise → lift can be checked against the graph's identity. As for Rust and Go,
 * each prelude call maps back to the reference vocabulary; statements are read by their indentation
 * into the same shapes, with the prelude's names translated to the Rust lowering's, and written by
 * the same writer. It reads the lowering's own dialect, not Python in general.
 */
import { type Expr, RaiseError, type Stmt, writeFunction } from "./raise-rust.js";

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
  fn(header: string, indent: number): { params: { name: string; rest: boolean }[]; body: Stmt[] } {
    const inside = header.slice(header.indexOf("(") + 1, header.lastIndexOf(")"));
    const params: { name: string; rest: boolean }[] = [];
    let usesArgs = false;
    let restName: string | undefined;
    for (const raw of inside.split(",").map((x) => x.trim())) {
      if (raw === "*_args") usesArgs = true;
      else if (raw === "*_rest" || raw === "") continue;
      else if (raw.startsWith("*")) restName = raw.slice(1);
      else params.push({ name: raw.replace(/=.*$/, ""), rest: false });
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
              args: params.map((p) => ({ t: "str", v: `${p.rest ? "..." : ""}${p.name}` })),
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
