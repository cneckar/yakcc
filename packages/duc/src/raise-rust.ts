// SPDX-License-Identifier: Apache-2.0
/**
 * Raising the Rust lowering back (#1278): the Rust `emitRust` writes, read as the TypeScript it
 * means, so the round trip lower → raise → lift can be checked against the graph's identity.
 *
 * The lowering writes each graph operation as a call of its own runtime function (`add`, `get`,
 * `put_member`, `trim`, ...), with a missing argument written `NONE`; this maps each back to the
 * reference vocabulary, TypeScript's. It reads the lowering's own dialect, not Rust in general:
 * anything else is a RaiseError.
 */

/** A table's own entry for a key: never one of Object.prototype's (`hasOwnProperty`, `constructor`). */
function entry<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

export class RaiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaiseError";
  }
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
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_:]/.test(src[j] as string)) {
        // A path separator `::` is part of the name; a single `:` is a type annotation.
        if (src[j] === ":" && src[j + 1] !== ":" && src[j - 1] !== ":") break;
        j++;
      }
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
      let j = i + 1;
      let text = "";
      while (src[j] !== '"') {
        if (src[j] === "\\") {
          const e = src[j + 1];
          if (e === "u") {
            const close = src.indexOf("}", j);
            text += String.fromCodePoint(Number.parseInt(src.slice(j + 3, close), 16));
            j = close + 1;
            continue;
          }
          text += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : (e as string);
          j += 2;
          continue;
        }
        text += src[j];
        j++;
      }
      out.push({ k: "str", v: text });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "||" || two === "->") {
      out.push({ k: "p", v: two });
      i += 2;
      continue;
    }
    out.push({ k: "p", v: c });
    i++;
  }
  return out;
}

/** An expression of the dialect: a name, a literal, a call, a closure `|| e`, a reference `&e`. */
export type Expr =
  | { readonly t: "name"; readonly name: string }
  | { readonly t: "num"; readonly v: string }
  | { readonly t: "str"; readonly v: string }
  | { readonly t: "call"; readonly fn: string; readonly args: Expr[] }
  | { readonly t: "vec"; readonly items: Expr[] }
  | { readonly t: "slice"; readonly items: Expr[] }
  | { readonly t: "thunk"; readonly body: Expr }
  | { readonly t: "ref"; readonly e: Expr }
  | { readonly t: "field"; readonly e: Expr; readonly field: string }
  | { readonly t: "neg"; readonly e: Expr };

export type Stmt =
  | { readonly t: "let"; readonly name: string; readonly e: Expr }
  | {
      readonly t: "closure";
      readonly name: string;
      readonly captures: [string, Expr][];
      readonly body: Stmt[];
    }
  | { readonly t: "tuple"; readonly items: Expr[] }
  | { readonly t: "assign"; readonly name: string; readonly e: Expr }
  | { readonly t: "expr"; readonly e: Expr }
  | { readonly t: "if"; readonly c: Expr; readonly then: Stmt[]; readonly else?: Stmt[] }
  | { readonly t: "guard"; readonly c: Expr }
  | { readonly t: "while"; readonly c: Expr; readonly body: Stmt[] }
  | {
      readonly t: "for";
      readonly name: string;
      readonly of: "values" | "keys";
      readonly e: Expr;
      readonly body: Stmt[];
    }
  | { readonly t: "break" }
  | { readonly t: "return"; readonly e: Expr }
  | { readonly t: "throw"; readonly e: Expr };

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }
  private next(): Tok {
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
  private skipType(): void {
    // `: V` or `: (V, V,)`.
    if (!this.is(":")) return;
    this.eat(":");
    if (this.is("(")) {
      let depth = 0;
      do {
        const t = this.next();
        if (t.v === "(") depth++;
        if (t.v === ")") depth--;
      } while (depth > 0);
    } else this.next();
  }

  fn(): { params: { name: string; rest: boolean }[]; body: Stmt[] } {
    // pub fn f(args: Vec<V>) -> V { ... }
    while (!this.is("{")) this.next();
    return this.body();
  }

  body(): { params: { name: string; rest: boolean }[]; body: Stmt[] } {
    const stmts = this.block();
    const params: { name: string; rest: boolean }[] = [];
    const body: Stmt[] = [];
    for (const st of stmts) {
      if (st.t === "let" && st.e.t === "call" && (st.e.fn === "arg" || st.e.fn === "rest_args")) {
        const at = st.e.args[1];
        if (at?.t !== "num") throw new RaiseError("a parameter without its index");
        params[Number(at.v)] = { name: st.name, rest: st.e.fn === "rest_args" };
        continue;
      }
      body.push(st);
    }
    return { params, body };
  }

  block(): Stmt[] {
    this.eat("{");
    const out: Stmt[] = [];
    while (!this.is("}")) out.push(this.stmt());
    this.eat("}");
    return out;
  }

  stmt(): Stmt {
    const t = this.peek() as Tok;
    if (t.v === "let") {
      this.next();
      if (this.is("mut")) this.next();
      const name = this.next().v;
      this.skipType();
      this.eat("=");
      if (name === "next" && this.is("(")) {
        this.eat("(");
        const items: Expr[] = [];
        while (!this.is(")")) {
          items.push(this.expr());
          if (this.is(",")) this.eat(",");
        }
        this.eat(")");
        this.eat(";");
        return { t: "tuple", items };
      }
      if (this.is("{")) {
        // A closure: its captures' copies, then fun(move |args: Vec<V>| -> V { body }).
        this.eat("{");
        const captures: [string, Expr][] = [];
        while (this.is("let")) {
          this.next();
          const c = this.next().v;
          this.skipType();
          this.eat("=");
          captures.push([c, this.expr()]);
          this.eat(";");
        }
        this.eat("fun");
        this.eat("(");
        this.eat("move");
        while (!this.is("{")) this.next();
        const { params, body } = this.body();
        this.eat(")");
        this.eat("}");
        this.eat(";");
        return {
          t: "closure",
          name,
          captures,
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
      const e = this.expr();
      this.eat(";");
      return name === "_" ? { t: "expr", e } : { t: "let", name, e };
    }
    if (t.v === "if") {
      this.next();
      if (this.is("!")) {
        this.eat("!");
        const c = this.truthyArg();
        this.eat("{");
        this.eat("break");
        this.eat(";");
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
    if (t.v === "while") {
      this.next();
      const c = this.truthyArg();
      return { t: "while", c, body: this.block() };
    }
    if (t.v === "for") {
      this.next();
      const name = this.next().v;
      this.eat("in");
      const of = this.next().v as "values" | "keys";
      this.eat("(");
      const e = this.expr();
      this.eat(")");
      return { t: "for", name, of, e, body: this.block() };
    }
    if (t.v === "break") {
      this.next();
      this.eat(";");
      return { t: "break" };
    }
    if (t.v === "return") {
      this.next();
      const e = this.expr();
      this.eat(";");
      return { t: "return", e };
    }
    if (t.v === "throw") {
      this.next();
      this.eat("(");
      const e = this.expr();
      this.eat(")");
      this.eat(";");
      return { t: "throw", e };
    }
    if (t.k === "id" && this.is("=", 1)) {
      const name = this.next().v;
      this.eat("=");
      const e = this.expr();
      this.eat(";");
      return { t: "assign", name, e };
    }
    const e = this.expr();
    this.eat(";");
    return { t: "expr", e };
  }

  private truthyArg(): Expr {
    this.eat("truthy");
    this.eat("(");
    this.eat("&");
    const c = this.expr();
    this.eat(")");
    return c;
  }

  private args(close: string): Expr[] {
    const out: Expr[] = [];
    while (!this.is(close)) {
      out.push(this.expr());
      if (this.is(",")) this.eat(",");
    }
    this.eat(close);
    return out;
  }

  expr(): Expr {
    let e = this.primary();
    while (this.is(".")) {
      this.eat(".");
      const f = this.next();
      if (this.is("(")) {
        this.eat("(");
        this.eat(")");
        if (f.v === "clone" || f.v === "to_string") continue;
        throw new RaiseError(`the method .${f.v}() is not of the dialect`);
      }
      e = { t: "field", e, field: f.v };
    }
    return e;
  }

  private primary(): Expr {
    const t = this.next();
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.v === "&") {
      if (this.is("[")) {
        this.eat("[");
        return { t: "slice", items: this.args("]") };
      }
      return { t: "ref", e: this.expr() };
    }
    if (t.v === "-") return { t: "neg", e: this.primary() };
    if (t.v === "||") return { t: "thunk", body: this.expr() };
    if (t.k === "num") return { t: "num", v: t.v };
    if (t.v === "(") {
      const e = this.expr();
      this.eat(")");
      return e;
    }
    if (t.k === "id") {
      if (this.is("!") && this.is("[", 1)) {
        this.eat("!");
        this.eat("[");
        return { t: "vec", items: this.args("]") };
      }
      if (this.is("(")) {
        this.eat("(");
        return { t: "call", fn: t.v, args: this.args(")") };
      }
      return { t: "name", name: t.v };
    }
    throw new RaiseError(
      `unexpected ${t.v} near ${this.toks
        .slice(Math.max(0, this.i - 8), this.i + 4)
        .map((x) => x.v)
        .join(" ")}`,
    );
  }
}

const BINARY: Record<string, string> = {
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
  rem: "%",
  pow: "**",
  and: "&&",
  or: "||",
  nullish: "??",
  band: "&",
  bor: "|",
  bxor: "^",
  shl: "<<",
  shr: ">>",
  ushr: ">>>",
  has_key: "in",
  lt: "<",
  gt: ">",
  le: "<=",
  ge: ">=",
  seq: "===",
  sne: "!==",
};
const PREFIX: Record<string, string> = { not: "!", neg: "-", pos: "+", bnot: "~" };
const COMPOUND: Record<string, string> = {
  add_assign: "+=",
  sub_assign: "-=",
  mul_assign: "*=",
  div_assign: "/=",
  rem_assign: "%=",
};
const STEPS: Record<string, [string, boolean]> = {
  pre_inc: ["++", true],
  post_inc: ["++", false],
  pre_dec: ["--", true],
  post_dec: ["--", false],
};
/** Runtime function → method, with the receiver first; `vec` methods take their arguments as a list. */
const METHODS: Record<string, string> = {
  trim: "trim",
  to_upper: "toUpperCase",
  to_lower: "toLowerCase",
  starts_with: "startsWith",
  ends_with: "endsWith",
  includes: "includes",
  index_of: "indexOf",
  slice: "slice",
  split: "split",
  join: "join",
  push: "push",
  map_arr: "map",
  filter_arr: "filter",
  some_arr: "some",
  every_arr: "every",
  reduce_arr: "reduce",
  to_string_m: "toString",
  replace_str: "replace",
  concat: "concat",
  substring: "substring",
  for_each_arr: "forEach",
  find_arr: "find",
  find_index_arr: "findIndex",
  char_at: "charAt",
  char_code_at: "charCodeAt",
  at: "at",
  pop: "pop",
  shift: "shift",
  reverse: "reverse",
  re_test: "test",
  match_str: "match",
};
const AMBIENT: Record<string, string> = {
  math_abs: "Math.abs",
  math_floor: "Math.floor",
  math_ceil: "Math.ceil",
  math_trunc: "Math.trunc",
  math_sqrt: "Math.sqrt",
  round: "Math.round",
  math_max: "Math.max",
  math_min: "Math.min",
  math_pow: "Math.pow",
  object_keys: "Object.keys",
  freeze: "Object.freeze",
  is_array: "Array.isArray",
  is_finite_number: "Number.isFinite",
  is_integer_number: "Number.isInteger",
  is_nan_number: "Number.isNaN",
  try_catch: "__yakccTry",
  str_v: "String",
  number_of: "Number",
  boolean_of: "Boolean",
  parse_int: "parseInt",
  global_is_nan: "isNaN",
  global_is_finite: "isFinite",
  re_call: "RegExp",
};
const PLATFORM: Record<string, string> = {
  fn_string: "String",
  fn_number: "Number",
  fn_boolean: "Boolean",
  fn_parse_int: "parseInt",
};

const isIdent = (k: string): boolean => /^[A-Za-z_$][\w$]*$/.test(k);

export class Writer {
  private nexts = 0;
  constructor(private readonly assigned: Set<string>) {}

  /** The arguments of a call, the list ones spread, a missing one dropped. */
  private argList(args: readonly Expr[]): string[] {
    return args.flatMap((a) => {
      if (a.t === "vec") return this.argList(a.items);
      if (a.t === "name" && a.name === "NONE") return [];
      return [this.e(a)];
    });
  }

  e(x: Expr): string {
    switch (x.t) {
      case "name":
        if (x.name === "V::Undef" || x.name === "NONE") return "undefined";
        if (x.name === "V::Null") return "null";
        if (x.name.startsWith("Ref_")) return x.name.slice("Ref_".length);
        return x.name;
      case "num":
        return String(Number(x.v));
      case "neg":
        return `-${this.e(x.e)}`;
      case "str":
        return JSON.stringify(x.v);
      case "ref":
        return this.e(x.e);
      case "thunk":
        return this.e(x.body);
      case "vec":
        return `[${this.argList(x.items).join(", ")}]`;
      case "slice":
        return `[${x.items.map((i) => this.e(i)).join(", ")}]`;
      case "field":
        throw new RaiseError(`a field .${x.field} is not of the dialect here`);
      case "call":
        return this.call(x.fn, x.args);
    }
  }

  private call(fn: string, args: readonly Expr[]): string {
    const a = (i: number): string => this.e(args[i] as Expr);
    const op = entry(BINARY, fn);
    if (op !== undefined) return `(${a(0)} ${op} ${a(1)})`;
    const pre = entry(PREFIX, fn);
    if (pre !== undefined) return `${pre}${a(0)}`;
    if (fn === "type_of") return `(typeof ${a(0)})`;
    if (fn === "void_of") return `(void ${a(0)})`;
    if (fn === "n") {
      const inner = args[0] as Expr;
      if (inner.t === "name" && inner.name === "f64::INFINITY") return "Infinity";
      if (inner.t === "name" && inner.name === "f64::NAN") return "NaN";
      return this.e(inner);
    }
    if (fn === "s") return this.e(args[0] as Expr);
    if (fn === "B") {
      const inner = args[0] as Expr;
      if (inner.t === "call" && inner.fn === "is_nullish")
        return `(${this.e(inner.args[0] as Expr)} == null)`;
      return this.e(inner);
    }
    if (fn === "uninit") return "undefined";
    if (fn === "__spread_arg") return `...${a(0)}`;
    if (fn === "is_nullish") return `(${a(0)} == null)`;
    if (fn === "get") return `${a(0)}.${(args[1] as { v: string }).v}`;
    if (fn === "get_opt") return `${a(0)}?.${(args[1] as { v: string }).v}`;
    if (fn === "idx") return `${a(0)}[${a(1)}]`;
    if (fn === "idx_opt") return `${a(0)}?.[${a(1)}]`;
    if (fn === "comma") return `(${a(0)}, ${a(1)})`;
    if (fn === "call") return `${a(0)}(${this.argList(args.slice(1)).join(", ")})`;
    if (fn === "call_opt") return `${a(0)}?.(${this.argList(args.slice(1)).join(", ")})`;
    if (fn === "call_detached") return `(0, ${a(0)})(${this.argList(args.slice(1)).join(", ")})`;
    if (fn === "sel" || fn === "lazy_sel") {
      const c = args[0] as Expr;
      const cond = c.t === "call" && c.fn === "truthy" ? this.e(c.args[0] as Expr) : this.e(c);
      return `(${cond} ? ${a(1)} : ${a(2)})`;
    }
    if (fn === "lazy_and") return `(${a(0)} && ${a(1)})`;
    if (fn === "lazy_or") return `(${a(0)} || ${a(1)})`;
    if (fn === "arr") {
      const inner = args[0] as Expr;
      if (inner.t === "name" && inner.name === "args") return "arguments";
      return this.e(inner);
    }
    if (fn === "spread") {
      const parts = (args[0] as { items: Expr[] }).items.map((p) =>
        p.t === "call" && p.fn === "values"
          ? `...${this.e(p.args[0] as Expr)}`
          : this.e((p as { items: Expr[] }).items[0] as Expr),
      );
      return `[${parts.join(", ")}]`;
    }
    if (fn === "obj") {
      const entries = (args[0] as { items: Expr[] }).items.map((en) => {
        const c = en as { fn: string; args: Expr[] };
        if (c.fn === "Entry::Spread") return `...${this.e(c.args[0] as Expr)}`;
        const k = c.args[0] as Expr;
        const v = this.e(c.args[1] as Expr);
        if (k.t === "str") return `${JSON.stringify(k.v)}: ${v}`;
        if (k.t === "call" && k.fn === "str_of") return `[${this.e(k.args[0] as Expr)}]: ${v}`;
        throw new RaiseError("an object key the dialect does not write");
      });
      return `{ ${entries.join(", ")} }`;
    }
    if (fn === "template") {
      const texts = (args[0] as { items: Expr[] }).items.map((t) => (t as { v: string }).v);
      const vals = (args[1] as { items: Expr[] }).items;
      let out = "`";
      texts.forEach((t, i) => {
        out += t.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
        if (i < vals.length) out += `\${${this.e(vals[i] as Expr)}}`;
      });
      return `${out}\``;
    }
    if (fn === "new_error")
      return `new ${(args[0] as { v: string }).v}(${this.argList(args.slice(1)).join(", ")})`;
    if (fn === "call_error")
      return `${(args[0] as { v: string }).v}(${this.argList(args.slice(1)).join(", ")})`;
    if (fn === "re_new") return `new RegExp(${this.argList(args).join(", ")})`;
    if (fn === "re") {
      const [src, flags] = args as unknown as [{ v: string }, { v: string }];
      return `/${src.v}/${flags.v}`;
    }
    const platform = entry(PLATFORM, fn);
    if (platform !== undefined) return platform;
    const method = entry(METHODS, fn);
    if (method !== undefined) return `${a(0)}.${method}(${this.argList(args.slice(1)).join(", ")})`;
    const ambient = entry(AMBIENT, fn);
    if (ambient !== undefined) return `${ambient}(${this.argList(args).join(", ")})`;
    if (fn.startsWith("Ref_") && args.length === 0) return fn.slice("Ref_".length);
    if (fn === "platform") return (args[0] as { v: string }).v;
    throw new RaiseError(`the runtime function ${fn} is not of the dialect`);
  }

  stmts(list: readonly Stmt[], indent = "  "): string[] {
    const out: string[] = [];
    let tuple: string[] = [];
    for (const st of list) {
      switch (st.t) {
        case "let": {
          const e = st.e;
          if (e.t === "call" && (e.fn === "put_member" || e.fn === "put")) {
            const [o, k, v] = e.args as [Expr, Expr, Expr];
            // Written through a name of its own, as the TypeScript lowering writes it: the base name
            // stays the object it was.
            const t = `${st.name}$`;
            const target =
              e.fn === "put_member" ? `${t}.${(k as { v: string }).v}` : `${t}[${this.e(k)}]`;
            out.push(
              `${indent}let ${t} = ${this.e(o)};`,
              `${indent}${target} = ${this.e(v)};`,
              `${indent}const ${st.name} = ${t};`,
            );
            break;
          }
          const compound = e.t === "call" ? entry(COMPOUND, e.fn) : undefined;
          if (compound !== undefined && e.t === "call") {
            out.push(
              `${indent}let ${st.name}$ = ${this.e(e.args[0] as Expr)};`,
              `${indent}${st.name}$ ${compound} ${this.e(e.args[1] as Expr)};`,
              `${indent}const ${st.name} = ${st.name}$;`,
            );
            break;
          }
          const step = e.t === "call" ? entry(STEPS, e.fn) : undefined;
          if (step !== undefined && e.t === "call") {
            const [tok, prefix] = step;
            out.push(
              `${indent}let ${st.name}$ = ${this.e(e.args[0] as Expr)};`,
              `${indent}${prefix ? `${tok}${st.name}$` : `${st.name}$${tok}`};`,
              `${indent}const ${st.name} = ${st.name}$;`,
            );
            break;
          }
          if (e.t === "call" && e.fn === "uninit") {
            out.push(`${indent}let ${st.name};`);
            break;
          }
          out.push(
            `${indent}${this.assigned.has(st.name) ? "let" : "const"} ${st.name} = ${this.e(e)};`,
          );
          break;
        }
        case "closure": {
          for (const [c, e] of st.captures) out.push(`${indent}const ${c} = ${this.e(e)};`);
          const [head, ...body] = st.body;
          const params = ((head as { e: { args: { v: string }[] } }).e.args ?? []).map((p) => p.v);
          out.push(
            `${indent}const ${st.name} = (${params.join(", ")}) => {`,
            ...this.stmts(body, `${indent}  `),
            `${indent}};`,
          );
          break;
        }
        case "tuple": {
          const k = this.nexts++;
          tuple = st.items.map((_, i) => `$next${k}_${i}`);
          st.items.forEach((item, i) => out.push(`${indent}const ${tuple[i]} = ${this.e(item)};`));
          break;
        }
        case "assign": {
          const e = st.e;
          if (e.t === "field" && e.e.t === "name" && e.e.name === "next") {
            out.push(`${indent}${st.name} = ${tuple[Number(e.field)]};`);
            break;
          }
          out.push(`${indent}${st.name} = ${this.e(e)};`);
          break;
        }
        case "expr":
          out.push(`${indent}${this.e(st.e)};`);
          break;
        case "if":
          out.push(`${indent}if (${this.e(st.c)}) {`, ...this.stmts(st.then, `${indent}  `));
          if (st.else !== undefined)
            out.push(`${indent}} else {`, ...this.stmts(st.else, `${indent}  `));
          out.push(`${indent}}`);
          break;
        case "guard":
          out.push(`${indent}if (!(${this.e(st.c)})) break;`);
          break;
        case "while":
          out.push(
            `${indent}while (${this.e(st.c)}) {`,
            ...this.stmts(st.body, `${indent}  `),
            `${indent}}`,
          );
          break;
        case "for":
          out.push(
            `${indent}for (const ${st.name} ${st.of === "values" ? "of" : "in"} ${this.e(st.e)}) {`,
            ...this.stmts(st.body, `${indent}  `),
            `${indent}}`,
          );
          break;
        case "break":
          out.push(`${indent}break;`);
          break;
        case "return":
          // NONE: the function returns nothing it observes.
          if (!(st.e.t === "name" && st.e.name === "NONE"))
            out.push(`${indent}return ${this.e(st.e)};`);
          break;
        case "throw":
          out.push(`${indent}throw ${this.e(st.e)};`);
          break;
      }
    }
    return out;
  }
}

/** The names a function's statements assign again after declaring them (they are `let`). */
function assignedNames(list: readonly Stmt[], out = new Set<string>()): Set<string> {
  for (const st of list) {
    if (st.t === "assign") out.add(st.name);
    if (st.t === "if") {
      assignedNames(st.then, out);
      if (st.else !== undefined) assignedNames(st.else, out);
    }
    if (st.t === "while" || st.t === "for") assignedNames(st.body, out);
  }
  return out;
}

/** The TypeScript the Rust lowering of a graph means: `export function f(..) {..}`. */
export function raiseRust(rust: string): string {
  const p = new Parser(tokenize(rust));
  const { params, body } = p.fn();
  return writeFunction(params, body);
}

/** `export function f(..) {..}` from a lowering's parameters and statements, read as the dialect. */
export function writeFunction(
  params: readonly { name: string; rest: boolean }[],
  body: readonly Stmt[],
): string {
  const names = assignedNames(body);
  const collect = (list: readonly Stmt[]): void => {
    for (const st of list) {
      if (st.t === "closure") {
        assignedNames(st.body, names);
        collect(st.body);
      }
      if (st.t === "if") {
        collect(st.then);
        if (st.else !== undefined) collect(st.else);
      }
      if (st.t === "while" || st.t === "for") collect(st.body);
    }
  };
  collect(body);
  const w = new Writer(names);
  const list = params.map((q) => `${q.rest ? "..." : ""}${q.name}`).join(", ");
  return [`export function f(${list}) {`, ...w.stmts(body), "}", ""].join("\n");
}
