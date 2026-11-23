// SPDX-License-Identifier: Apache-2.0
/**
 * Raising the Go lowering back (#1278): the Go `emitGo` writes, read as the TypeScript it means,
 * so lower → raise → lift can be checked against the graph's identity. As for Rust (raise-rust.ts),
 * each runtime call maps back to the reference vocabulary; the statements and expressions are read
 * into the same shapes, with Go's runtime names translated to the Rust lowering's, and written by
 * the same writer. It reads the lowering's own dialect, not Go in general.
 */
import { type Expr, RaiseError, type Stmt, writeFunction } from "./raise-rust.js";

type Tok = { readonly k: "id" | "num" | "str" | "p" | "nl"; readonly v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "\n") {
      out.push({ k: "nl", v: "\n" });
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j++;
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
      // A Go string the lowering wrote with JSON.stringify: read it as JSON.
      let j = i + 1;
      while (src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out.push({ k: "str", v: JSON.parse(src.slice(i, j + 1)) as string });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === ":=" || two === "..") {
      out.push({ k: "p", v: two === ".." ? "..." : two });
      i += two === ".." ? 3 : 2;
      continue;
    }
    out.push({ k: "p", v: c });
    i++;
  }
  return out;
}

/** Go runtime names, where the Rust lowering's differ. */
const NAMES: Record<string, string> = {
  hasKey: "has_key",
  typeOf: "type_of",
  isNullish: "is_nullish",
  addAssign: "add_assign",
  subAssign: "sub_assign",
  mulAssign: "mul_assign",
  divAssign: "div_assign",
  remAssign: "rem_assign",
  preInc: "pre_inc",
  postInc: "post_inc",
  preDec: "pre_dec",
  postDec: "post_dec",
  putMember: "put_member",
  voidOf: "void_of",
  getOpt: "get_opt",
  idxOpt: "idx_opt",
  callOpt: "call_opt",
  callDetached: "call_detached",
  callError: "call_error",
  newError: "new_error",
  lazyAnd: "lazy_and",
  lazyOr: "lazy_or",
  lazySel: "lazy_sel",
  indexOf: "index_of",
  mapArr: "map_arr",
  filterArr: "filter_arr",
  someArr: "some_arr",
  everyArr: "every_arr",
  reduceArr: "reduce_arr",
  forEachArr: "for_each_arr",
  findArr: "find_arr",
  findIndexArr: "find_index_arr",
  charAt: "char_at",
  charCodeAt: "char_code_at",
  toUpper: "to_upper",
  toLower: "to_lower",
  startsWith: "starts_with",
  endsWith: "ends_with",
  reTest: "re_test",
  replace: "replace_str",
  match: "match_str",
  toStringM: "to_string_m",
  mathAbs: "math_abs",
  mathFloor: "math_floor",
  mathCeil: "math_ceil",
  mathTrunc: "math_trunc",
  mathSqrt: "math_sqrt",
  mathPow: "math_pow",
  mathMax: "math_max",
  mathMin: "math_min",
  objectKeys: "object_keys",
  isArrayV: "is_array",
  isFiniteNumber: "is_finite_number",
  isIntegerNumber: "is_integer_number",
  isNaNNumber: "is_nan_number",
  tryCatch: "try_catch",
  stringOf: "str_v",
  numberOf: "number_of",
  booleanOf: "boolean_of",
  parseInt: "parse_int",
  globalIsNaN: "global_is_nan",
  globalIsFinite: "global_is_finite",
};

/** Functions whose arguments after the first (or all of them) the Rust lowering passes as a list. */
const LIST_AFTER_FIRST = new Set([
  "push",
  "reduce_arr",
  "concat",
  "call",
  "call_opt",
  "call_detached",
  "to_string_m",
]);
const LIST_ALL = new Set(["math_max", "math_min", "try_catch", "arr"]);

const PLATFORM_NAMES: Record<string, Expr> = {
  fnParseInt: { t: "call", fn: "fn_parse_int", args: [] },
  fnString: { t: "call", fn: "fn_string", args: [] },
  fnNumber: { t: "call", fn: "fn_number", args: [] },
  fnBoolean: { t: "call", fn: "fn_boolean", args: [] },
  jsInfinity: { t: "call", fn: "n", args: [{ t: "name", name: "f64::INFINITY" }] },
  jsNaN: { t: "call", fn: "n", args: [{ t: "name", name: "f64::NAN" }] },
  nil: { t: "name", name: "V::Null" },
  Undefined: { t: "name", name: "V::Undef" },
};

class Parser {
  private i = 0;
  private readonly declared = new Set<string>();
  constructor(private readonly toks: Tok[]) {}

  private peek(o = 0): Tok | undefined {
    let k = this.i;
    let seen = 0;
    while (k < this.toks.length) {
      const t = this.toks[k] as Tok;
      if (t.k !== "nl") {
        if (seen === o) return t;
        seen++;
      }
      k++;
    }
    return undefined;
  }
  private skipNl(): void {
    while (this.toks[this.i]?.k === "nl") this.i++;
  }
  private next(): Tok {
    this.skipNl();
    const t = this.toks[this.i++];
    if (t === undefined) throw new RaiseError("unexpected end");
    return t;
  }
  private is(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t !== undefined && t.k !== "str" && t.v === v;
  }
  private eat(v: string): void {
    const t = this.next();
    if (t.k === "str" || t.v !== v) throw new RaiseError(`expected ${v}, found ${t.v}`);
  }
  /** The rest of the statement's line has nothing more. */
  private endOfLine(): boolean {
    let k = this.i;
    while (k < this.toks.length && this.toks[k]?.k !== "nl") {
      if (this.toks[k]?.v !== "}") return false;
      k++;
    }
    return true;
  }

  fn(): { params: { name: string; rest: boolean }[]; body: Stmt[] } {
    while (!this.is("{")) this.next();
    return this.body();
  }

  body(): { params: { name: string; rest: boolean }[]; body: Stmt[] } {
    const stmts = this.block();
    const params: { name: string; rest: boolean }[] = [];
    const body: Stmt[] = [];
    for (const st of stmts) {
      if (st.t === "let" && st.e.t === "call" && (st.e.fn === "arg" || st.e.fn === "restArgs")) {
        const at = st.e.args[1];
        if (at?.t !== "num") throw new RaiseError("a parameter without its index");
        params[Number(at.v)] = { name: st.name, rest: st.e.fn === "restArgs" };
        continue;
      }
      body.push(st);
    }
    return { params, body };
  }

  block(): Stmt[] {
    this.eat("{");
    const out: Stmt[] = [];
    while (!this.is("}")) {
      const st = this.stmt();
      if (st !== undefined) out.push(...(Array.isArray(st) ? st : [st]));
    }
    this.eat("}");
    return out;
  }

  stmt(): Stmt | Stmt[] | undefined {
    const t = this.next();
    if (t.v === "var") {
      const name = this.next().v;
      this.declared.add(name);
      this.eat("any");
      if (!this.is("=")) return { t: "let", name, e: { t: "name", name: "V::Undef" } };
      this.eat("=");
      if (this.is("func") && this.is("(", 1)) {
        // A closure: its own parameters and body; it reads what it captures by name.
        this.eat("func");
        while (!this.is("{")) this.next();
        const { params, body } = this.body();
        return {
          t: "closure",
          name,
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
      return { t: "let", name, e: this.expr() };
    }
    if (t.v === "_") {
      this.eat("=");
      const e = this.expr();
      // `_ = name` keeps a variable used; anything else is read for itself.
      if (e.t === "name" && this.declared.has(e.name)) return undefined;
      return { t: "expr", e };
    }
    if (t.v === "if") {
      if (this.is("!")) {
        this.eat("!");
        const c = this.truthyArg();
        this.eat("{");
        this.eat("break");
        this.eat("}");
        return { t: "guard", c };
      }
      const c = this.truthyArg();
      const then = this.block();
      if (this.is("else")) {
        this.next();
        return { t: "if", c, then, else: this.block() };
      }
      return { t: "if", c, then };
    }
    if (t.v === "for") {
      if (this.is("_")) {
        this.eat("_");
        this.eat(",");
        const name = this.next().v;
        this.declared.add(name);
        this.eat(":=");
        this.eat("range");
        const of = this.next().v as "values" | "keys";
        this.eat("(");
        const e = this.expr();
        this.eat(")");
        return { t: "for", name, of, e, body: this.block() };
      }
      const c = this.truthyArg();
      return { t: "while", c, body: this.block() };
    }
    if (t.v === "break") return { t: "break" };
    if (t.v === "return") return { t: "return", e: this.expr() };
    if (t.v === "throw") {
      this.eat("(");
      const e = this.expr();
      this.eat(")");
      return { t: "throw", e };
    }
    if (t.k === "id" && (this.is("=") || this.is(","))) {
      // `a = e`, or the carries `a, b = x, y`.
      const names = [t.v];
      while (this.is(",")) {
        this.eat(",");
        names.push(this.next().v);
      }
      this.eat("=");
      const values = [this.expr()];
      while (this.is(",")) {
        this.eat(",");
        values.push(this.expr());
      }
      if (names.length === 1)
        return { t: "assign", name: names[0] as string, e: values[0] as Expr };
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
    throw new RaiseError(`a statement the dialect does not write: ${t.v}`);
  }

  private truthyArg(): Expr {
    this.eat("truthy");
    this.eat("(");
    const c = this.expr();
    this.eat(")");
    return c;
  }

  private args(close: string): Expr[] {
    const out: Expr[] = [];
    while (!this.is(close)) {
      out.push(this.expr());
      if (this.is("...")) this.eat("...");
      if (this.is(",")) this.eat(",");
    }
    this.eat(close);
    return out;
  }

  expr(): Expr {
    const t = this.next();
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.k === "num") return { t: "num", v: t.v };
    if (t.v === "-") return { t: "neg", e: this.expr() };
    if (t.v === "(") {
      const e = this.expr();
      this.eat(")");
      return e;
    }
    if (t.v === "[") {
      // []string{...} or []any{...}
      this.eat("]");
      this.next();
      this.eat("{");
      return { t: "slice", items: this.args("}") };
    }
    if (t.v === "func") {
      // func() any { return e }: a deferred value.
      this.eat("(");
      this.eat(")");
      this.eat("any");
      this.eat("{");
      this.eat("return");
      const e = this.expr();
      this.eat("}");
      return { t: "thunk", body: e };
    }
    if (t.k !== "id") throw new RaiseError(`unexpected ${t.v}`);
    if (t.v === "objSpread") {
      this.eat("{");
      const e = this.expr();
      this.eat("}");
      return { t: "call", fn: "Entry::Spread", args: [e] };
    }
    if (!this.is("(")) {
      const platform = PLATFORM_NAMES[t.v];
      if (platform !== undefined) return platform;
      if (t.v === "true" || t.v === "false") return { t: "name", name: t.v };
      return { t: "name", name: t.v };
    }
    this.eat("(");
    const args = this.args(")");
    return this.call(t.v, args);
  }

  /** A Go runtime call as the Rust lowering writes the same operation. */
  private call(goName: string, args: Expr[]): Expr {
    if (goName === "any") return args[0] as Expr;
    if (goName === "float64") {
      const a = args[0] as Expr;
      return a.t === "neg" && a.e.t === "num" ? { t: "num", v: `-${a.e.v}` } : a;
    }
    if (goName === "argumentsOf")
      return { t: "call", fn: "arr", args: [{ t: "name", name: "args" }] };
    if (goName === "reJs") {
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
    if (goName === "template") {
      const [texts, ...vals] = args;
      return { t: "call", fn: "template", args: [texts as Expr, { t: "vec", items: vals }] };
    }
    if (goName === "obj") {
      const entries: Expr[] = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k] as Expr;
        if (a.t === "call" && a.fn === "Entry::Spread") entries.push(a);
        else {
          entries.push({ t: "call", fn: "Entry::Key", args: [a, args[k + 1] as Expr] });
          k++;
        }
      }
      return { t: "call", fn: "obj", args: [{ t: "vec", items: entries }] };
    }
    if (goName === "spread") {
      const parts = args.map((p): Expr => (p.t === "slice" ? { t: "vec", items: p.items } : p));
      return { t: "call", fn: "spread", args: [{ t: "vec", items: parts }] };
    }
    if (goName === "newError" || goName === "callError") {
      return { t: "call", fn: NAMES[goName] as string, args };
    }
    const fn = NAMES[goName] ?? goName;
    if (LIST_ALL.has(fn)) return { t: "call", fn, args: [{ t: "vec", items: args }] };
    if (LIST_AFTER_FIRST.has(fn))
      return { t: "call", fn, args: [args[0] as Expr, { t: "vec", items: args.slice(1) }] };
    return { t: "call", fn, args };
  }
}

/** The TypeScript the Go lowering of a graph means: `export function f(..) {..}`. */
export function raiseGo(go: string): string {
  const p = new Parser(tokenize(go));
  const { params, body } = p.fn();
  return writeFunction(params, body);
}
