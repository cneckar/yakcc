// SPDX-License-Identifier: Apache-2.0
/**
 * Shaving C (DEC-DUC-OPERATIONS-AS-ATOMS-001, #1329): a C or C++ translation unit's functions raised
 * to atoms. clang parses the unit (its own preprocessor and type checker: macros expanded, every
 * implicit conversion and integer promotion explicit) and dumps its typed AST; each function is
 * written, mechanically, as the TypeScript the lifter reads, with C's meaning on every value:
 *
 * - `int` (32 bits): a number in [-2^31, 2^31); arithmetic wraps (`| 0`, `__ykI32Mul`).
 * - `unsigned int`: a number in [0, 2^32); arithmetic wraps (`>>> 0`); `>>` is logical.
 * - 64-bit integers: bigints, wrapped by the fixed-width leaves (`__ykU64`, `__ykI64`).
 * - `double`: a number; its arithmetic is IEEE 754's, as JavaScript's.
 * - `bool`: a boolean; conversions to and from integers as C's.
 * - a conversion from `double` to an integer truncates; `bit_cast` is the float64-bits leaf.
 * - a call to another function of the unit is a reference by its name: linked, it is that atom.
 *
 * As the Python raiser (#1298), it is total over what it accepts, and refuses anything else with a
 * reason, never guessing a meaning. It is a front end, not a translation by hand: the same unit
 * always raises to the same graphs.
 */
import { execFileSync } from "node:child_process";

export class RaiseCError extends Error {}

/** A node of clang's JSON AST: the fields the raiser reads. */
export interface ClangNode {
  readonly kind: string;
  readonly id?: string;
  readonly name?: string;
  readonly opcode?: string;
  readonly castKind?: string;
  readonly value?: string;
  readonly isPostfix?: boolean;
  readonly storageClass?: string;
  readonly valueCategory?: string;
  readonly type?: { readonly qualType: string; readonly desugaredQualType?: string };
  readonly computeLHSType?: { readonly qualType: string; readonly desugaredQualType?: string };
  readonly computeResultType?: { readonly qualType: string; readonly desugaredQualType?: string };
  readonly referencedDecl?: ClangNode;
  readonly init?: string;
  readonly inner?: readonly ClangNode[];
  readonly array_filler?: readonly ClangNode[];
}

/**
 * The functions a unit defines, by name, from clang's AST of it. `filters` select declarations by
 * qualified name (clang's `-ast-dump-filter`), so only the unit's own code is dumped, not its
 * headers'.
 */
export function clangFunctions(
  file: string,
  filters: readonly string[],
  args: readonly string[] = [],
  clang = "clang++",
): Map<string, ClangNode> {
  const out = new Map<string, ClangNode>();
  for (const filter of filters) {
    const json = execFileSync(
      clang,
      [
        ...args,
        "-fsyntax-only",
        "-Xclang",
        "-ast-dump=json",
        "-Xclang",
        `-ast-dump-filter=${filter}`,
        file,
      ],
      { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] },
    );
    // The filtered dump is a sequence of JSON values, one per matching declaration.
    let i = 0;
    while (i < json.length) {
      while (i < json.length && /\s/.test(json[i] as string)) i++;
      if (i >= json.length) break;
      const [node, next] = readJsonValue(json, i);
      i = next;
      const n = node as ClangNode;
      if (n.kind === "FunctionDecl" && n.name !== undefined && body(n) !== undefined)
        out.set(n.name, n);
    }
  }
  return out;
}

/** One JSON value starting at `at`, and where it ends. */
function readJsonValue(text: string, at: number): [unknown, number] {
  let depth = 0;
  let inString = false;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return [JSON.parse(text.slice(at, i + 1)), i + 1];
    }
  }
  throw new RaiseCError("clang's AST dump ended inside a value");
}

const body = (fn: ClangNode): ClangNode | undefined =>
  fn.inner?.find((c) => c.kind === "CompoundStmt");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The value kinds the raiser represents: C's integers by width and sign, double, bool, arrays. */
type CType =
  | { readonly k: "f64" }
  | { readonly k: "i32" }
  | { readonly k: "u32" }
  | { readonly k: "i64" }
  | { readonly k: "u64" }
  | { readonly k: "bool" }
  | { readonly k: "void" }
  | { readonly k: "arr"; readonly of: CType; readonly size?: number };

const F64: CType = { k: "f64" };

function ctype(t: { qualType: string; desugaredQualType?: string } | undefined): CType {
  if (t === undefined) throw new RaiseCError("a node with no type");
  const raw = (t.desugaredQualType ?? t.qualType).replace(/\b(const|volatile)\b/g, "").trim();
  const arr = /^(.*?)\s*\[(\d*)\]$/.exec(raw);
  if (arr !== null) {
    const of = ctype({ qualType: arr[1] as string });
    return arr[2] === "" ? { k: "arr", of } : { k: "arr", of, size: Number(arr[2]) };
  }
  const ptr = /^(.*?)\s*\*$/.exec(raw);
  if (ptr !== null) return { k: "arr", of: ctype({ qualType: ptr[1] as string }) };
  switch (raw.replace(/\s+/g, " ")) {
    case "int32_t":
      return { k: "i32" };
    case "uint32_t":
      return { k: "u32" };
    case "int64_t":
      return { k: "i64" };
    case "uint64_t":
      return { k: "u64" };
    case "double":
      return F64;
    case "int":
    case "signed int":
      return { k: "i32" };
    case "unsigned int":
      return { k: "u32" };
    case "long":
    case "long long":
    case "signed long":
      return { k: "i64" };
    case "unsigned long":
    case "unsigned long long":
      return { k: "u64" };
    case "bool":
    case "_Bool":
      return { k: "bool" };
    case "void":
      return { k: "void" };
    default:
      throw new RaiseCError(`the C type "${raw}" is not raised yet`);
  }
}

const wide = (t: CType): boolean => t.k === "i64" || t.k === "u64";
const zeroOf = (t: CType): string =>
  t.k === "f64" || t.k === "i32" || t.k === "u32"
    ? "0"
    : wide(t)
      ? "0n"
      : t.k === "bool"
        ? "false"
        : t.k === "arr"
          ? `[${Array.from({ length: t.size ?? 0 }, () => zeroOf(t.of)).join(", ")}]`
          : "undefined";

/** C's conversion of a value of type `from` to type `to`. */
function convert(e: string, from: CType, to: CType): string {
  if (from.k === to.k || to.k === "void") return e;
  if (to.k === "bool") return from.k === "f64" || !wide(from) ? `(${e} !== 0)` : `(${e} !== 0n)`;
  if (from.k === "bool") return wide(to) ? `(${e} ? 1n : 0n)` : `(${e} ? 1 : 0)`;
  if (to.k === "f64") return wide(from) ? `__ykBigToF64(${e})` : e;
  if (from.k === "f64") {
    // Truncation toward zero; out of range is undefined in C.
    if (to.k === "i32") return `(${e} | 0)`;
    if (to.k === "u32") return `(${e} >>> 0)`;
    return to.k === "i64" ? `__ykF64ToI64(${e})` : `__ykU64(__ykF64ToI64(${e}))`;
  }
  switch (to.k) {
    case "i32":
      return wide(from) ? `__ykBigToI32(${e})` : `(${e} | 0)`;
    case "u32":
      return wide(from) ? `__ykBigToU32(${e})` : `(${e} >>> 0)`;
    case "i64":
      return wide(from) ? `__ykI64(${e})` : `__ykNumToBig(${e})`;
    case "u64":
      return wide(from) ? `__ykU64(${e})` : `__ykU64(__ykNumToBig(${e}))`;
    default:
      throw new RaiseCError(`a conversion to ${to.k} is not raised yet`);
  }
}

/** A binary operation on two values of type `t` (clang has converted both), as C means it. */
function arith(op: string, a: string, b: string, t: CType, rhs: CType): string {
  if (["<", "<=", ">", ">="].includes(op)) return `(${a} ${op} ${b})`;
  if (op === "==") return `(${a} === ${b})`;
  if (op === "!=") return `(${a} !== ${b})`;
  if (t.k === "f64") {
    if (!["+", "-", "*", "/"].includes(op)) throw new RaiseCError(`"${op}" on double`);
    return `(${a} ${op} ${b})`;
  }
  if (t.k === "bool") throw new RaiseCError(`"${op}" on bool`);
  if (t.k === "i32" || t.k === "u32") {
    // Each wrapped in its own parentheses: `a & b >>> 0` would bind as `a & (b >>> 0)`.
    const fix = t.k === "i32" ? (x: string) => `((${x}) | 0)` : (x: string) => `((${x}) >>> 0)`;
    switch (op) {
      case "+":
      case "-":
      case "/":
      case "%":
      case "&":
      case "|":
      case "^":
      case "<<":
        return fix(`${a} ${op} ${b}`);
      case "*":
        return fix(`__ykI32Mul(${a}, ${b})`);
      case ">>":
        return t.k === "i32" ? `(${a} >> ${b})` : `(${a} >>> ${b})`;
      default:
        throw new RaiseCError(`"${op}" on ${t.k}`);
    }
  }
  if (wide(t)) {
    const fix = t.k === "i64" ? (x: string) => `__ykI64(${x})` : (x: string) => `__ykU64(${x})`;
    // A shift's count is its own type: as a bigint here.
    const count = wide(rhs) ? b : `__ykNumToBig(${b})`;
    switch (op) {
      case "+":
      case "-":
      case "*":
        return fix(`${a} ${op} ${b}`);
      case "/":
      case "%":
      case "&":
      case "|":
      case "^":
        return `(${a} ${op} ${b})`;
      case "<<":
        return fix(`${a} << ${count}`);
      case ">>":
        return `(${a} >> ${count})`;
      default:
        throw new RaiseCError(`"${op}" on ${t.k}`);
    }
  }
  throw new RaiseCError(`"${op}" on ${t.k}`);
}

// ---------------------------------------------------------------------------
// The raiser
// ---------------------------------------------------------------------------

/**
 * Calls that are leaves (DEC-DUC-OPERATIONS-AS-ATOMS-001): the C library functions clang knows as
 * builtins and that are exact IEEE 754 operations, and the compiler's own builtins.
 */
const LEAF_CALLS: Readonly<Record<string, (args: readonly string[]) => string>> = {
  fabs: (a) => `Math.abs(${a[0]})`,
  __builtin_fabs: (a) => `Math.abs(${a[0]})`,
  sqrt: (a) => `Math.sqrt(${a[0]})`,
  __builtin_sqrt: (a) => `Math.sqrt(${a[0]})`,
  floor: (a) => `Math.floor(${a[0]})`,
  __builtin_floor: (a) => `Math.floor(${a[0]})`,
  ceil: (a) => `Math.ceil(${a[0]})`,
  __builtin_ceil: (a) => `Math.ceil(${a[0]})`,
  trunc: (a) => `Math.trunc(${a[0]})`,
  __builtin_trunc: (a) => `Math.trunc(${a[0]})`,
  __builtin_huge_val: () => "Infinity",
  __builtin_inf: () => "Infinity",
  __builtin_nan: () => "NaN",
  __builtin_nans: () => "NaN",
  __builtin_signbit: (a) => `__ykBigToI32(__ykF64Bits(${a[0]}) >> 63n)`,
};

/** A callee: the declaration a call refers to. */
export interface Callee {
  readonly name: string;
  readonly kind: string;
  readonly type: string;
}

/**
 * What a call is: the identifier of the atom it references (a function of the unit, or one of a
 * header whose body clang has), or undefined when the unit has no body for it: an external
 * reference by its name, linked to an atom another unit shaves (a C library's `scalbn`).
 */
export type CalleeResolver = (callee: Callee) => string | undefined;

/** A variable at namespace or file scope, by name and type: its declaration, when clang has it. */
export type GlobalResolver = (name: string, type: string) => ClangNode | undefined;

const RESERVED = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "f",
  "Math",
  "NaN",
  "Infinity",
  "undefined",
]);
const ident = (name: string): string => (RESERVED.has(name) ? `${name}_` : name);

/**
 * A function of the unit as the TypeScript the lifter reads: `export function f(..)`. A call to
 * another function of the unit is a call of that name, a reference the link makes an atom.
 */
export function raiseCFunction(
  fn: ClangNode,
  resolve: CalleeResolver,
  externals: Set<string> = new Set(),
  resolveGlobal: GlobalResolver = () => undefined,
): string {
  // The constants at namespace or file scope the function reads: each a const at its top.
  const globals = new Map<string, string>(); // decl id -> its const's line
  const globalNames = new Map<string, string>();
  const params = (fn.inner ?? []).filter((c) => c.kind === "ParmVarDecl");
  const result = ctype({ qualType: (fn.type?.qualType ?? "").replace(/\(.*$/, "").trim() });
  const vars = new Map<string, CType>();
  const names = new Map<string, string>();
  const declName = (n: ClangNode): string => {
    const id = n.id ?? "";
    let nm = names.get(id);
    if (nm === undefined) {
      const base = ident(n.name ?? "v");
      nm = [...names.values()].includes(base) ? `${base}_${names.size}` : base;
      names.set(id, nm);
    }
    return nm;
  };
  for (const p of params) vars.set(p.id ?? "", ctype(p.type));

  // A variable of namespace or file scope: a constant is its value, raised once at the top; a
  // variable that is written is module state, not raised here.
  const globalRef = (d: ClangNode): string => {
    const id = d.id ?? "";
    const known = globalNames.get(id);
    if (known !== undefined) return known;
    const decl = resolveGlobal(d.name ?? "", normType(d.type?.qualType ?? ""));
    if (decl === undefined || decl.inner?.[0] === undefined)
      throw new RaiseCError(
        `the variable "${d.name}" outside the function, with no initializer clang has`,
      );
    if (
      !/\bconst\b/.test(decl.type?.qualType ?? "") &&
      !/\bconstexpr\b/.test(decl.type?.qualType ?? "")
    )
      throw new RaiseCError(
        `the variable "${d.name}" outside the function is not constant: it is state`,
      );
    const name = `${ident(d.name ?? "g")}_g`;
    globalNames.set(id, name);
    vars.set(id, ctype(decl.type));
    globals.set(id, `const ${name} = ${expr(decl.inner[0] as ClangNode)};`);
    return name;
  };
  const typeOf = (e: ClangNode): CType => {
    if (e.type === undefined) throw new RaiseCError(`the ${e.kind} node has no type`);
    return ctype(e.type);
  };

  const expr = (e: ClangNode): string => {
    const kids = e.inner ?? [];
    const k0 = kids[0] as ClangNode;
    switch (e.kind) {
      case "ParenExpr":
      case "ConstantExpr":
      case "ExprWithCleanups":
      case "MaterializeTemporaryExpr":
        return `(${expr(k0)})`;
      case "IntegerLiteral":
        return wide(typeOf(e)) ? `${e.value}n` : String(Number(e.value));
      case "FloatingLiteral": {
        const v = Number(e.value);
        if (Number.isNaN(v)) throw new RaiseCError(`the floating literal ${e.value}`);
        return Object.is(v, -0) ? "-0" : String(v);
      }
      case "StringLiteral":
        return JSON.stringify(JSON.parse(e.value ?? '""'));
      case "CXXBoolLiteralExpr":
        return e.value === "true" || (e as { value?: unknown }).value === true ? "true" : "false";
      case "DeclRefExpr": {
        const d = e.referencedDecl as ClangNode;
        if (d.kind === "FunctionDecl") return d.name ?? "";
        if (d.kind === "VarDecl" && !vars.has(d.id ?? "")) return globalRef(d);
        return declName(d);
      }
      case "ImplicitCastExpr":
      case "CStyleCastExpr":
      case "CXXStaticCastExpr":
      case "CXXConstCastExpr":
      case "CXXFunctionalCastExpr": {
        const ck = e.castKind ?? "";
        if (
          ["LValueToRValue", "NoOp", "ArrayToPointerDecay", "FunctionToPointerDecay"].includes(ck)
        )
          return expr(k0);
        if (
          [
            "IntegralCast",
            "IntegralToFloating",
            "FloatingToIntegral",
            "IntegralToBoolean",
            "FloatingToBoolean",
          ].includes(ck)
        )
          return convert(expr(k0), typeOf(k0), typeOf(e));
        if (ck === "FloatingCast") {
          if (typeOf(e).k !== "f64" || typeOf(k0).k !== "f64")
            throw new RaiseCError("a conversion between floating types other than double");
          return expr(k0);
        }
        throw new RaiseCError(`the cast ${ck} is not raised yet`);
      }
      case "ArraySubscriptExpr":
        return `${expr(k0)}[${expr(kids[1] as ClangNode)}]`;
      case "UnaryOperator": {
        const t = typeOf(e);
        const op = e.opcode ?? "";
        if (op === "++" || op === "--") {
          const target = expr(k0);
          const next = arith(op === "++" ? "+" : "-", target, wide(t) ? "1n" : "1", t, t);
          if (e.isPostfix === true) {
            // The value before, then the write.
            return `((${target} = ${next}), ${arith(op === "++" ? "-" : "+", target, wide(t) ? "1n" : "1", t, t)})`;
          }
          return `(${target} = ${next})`;
        }
        if (op === "-")
          return t.k === "f64"
            ? `(-${expr(k0)})`
            : arith("-", wide(t) ? "0n" : "0", expr(k0), t, t);
        if (op === "+") return expr(k0);
        if (op === "~")
          return t.k === "i32"
            ? `(~${expr(k0)})`
            : t.k === "u32"
              ? `((~${expr(k0)}) >>> 0)`
              : convert(`(~${expr(k0)})`, { k: "i64" }, t);
        if (op === "!") return t.k === "bool" ? `(!${cond(k0)})` : `(${cond(k0)} ? 0 : 1)`;
        if (op === "*") {
          // *&x is x (fdlibm writes `*(volatile double *)&a[3]` to stop a compiler folding).
          const inner = stripCasts(k0);
          if (inner.kind === "UnaryOperator" && inner.opcode === "&")
            return expr((inner.inner as ClangNode[])[0] as ClangNode);
          return `${expr(k0)}[0]`;
        }
        if (op === "&") return expr(k0);
        throw new RaiseCError(`the unary operator "${op}" is not raised yet`);
      }
      case "BinaryOperator": {
        const op = e.opcode ?? "";
        const a = kids[0] as ClangNode;
        const b = kids[1] as ClangNode;
        if (op === "=") {
          const pun = punOf(stripCasts(a));
          if (pun !== undefined) {
            const v = expr(b);
            const bits =
              pun.field.k === "f64"
                ? `__ykF64Bits(${v})`
                : pun.field.k === "i64"
                  ? `__ykU64(${v})`
                  : v;
            return `(${pun.word} = ${bits})`;
          }
          return `(${expr(a)} = ${expr(b)})`;
        }
        // A comparison or logical operator is a bool in C++ and an int (1 or 0) in C.
        const truth = (x: string): string => (typeOf(e).k === "bool" ? x : `(${x} ? 1 : 0)`);
        if (op === "&&" || op === "||") return truth(`(${cond(a)} ${op} ${cond(b)})`);
        if (op === ",") return `(${expr(a)}, ${expr(b)})`;
        if (["<", "<=", ">", ">=", "==", "!="].includes(op))
          return truth(arith(op, expr(a), expr(b), typeOf(a), typeOf(b)));
        return arith(op, expr(a), expr(b), typeOf(e), typeOf(b));
      }
      case "CompoundAssignOperator": {
        // a op= b: computed in the computation type, then converted to a's.
        const op = (e.opcode ?? "").slice(0, -1);
        const a = kids[0] as ClangNode;
        const b = kids[1] as ClangNode;
        const lhs = typeOf(a);
        const comp = ctype(e.computeLHSType);
        const res = ctype(e.computeResultType);
        const target = expr(a);
        const value = arith(op, convert(target, lhs, comp), expr(b), res, typeOf(b));
        return `(${target} = ${convert(value, res, lhs)})`;
      }
      case "MemberExpr": {
        const pun = punOf(e);
        if (pun === undefined)
          throw new RaiseCError("a member of a struct or class is not raised yet");
        return pun.field.k === "f64"
          ? `__ykF64FromBits(${pun.word})`
          : pun.field.k === "i64"
            ? `__ykI64(${pun.word})`
            : pun.word;
      }
      case "CXXMemberCallExpr":
        throw new RaiseCError("a call of a method on an object is not raised yet");
      case "ConditionalOperator":
        return `(${expr(k0)} ? ${expr(kids[1] as ClangNode)} : ${expr(kids[2] as ClangNode)})`;
      case "CallExpr": {
        const callee = stripCasts(k0);
        const name = callee.referencedDecl?.name ?? "";
        const args = kids.slice(1).map(expr);
        if (name === "bit_cast") {
          const to = typeOf(e);
          const from = typeOf(kids[1] as ClangNode);
          if (to.k === "u64" && from.k === "f64") return `__ykF64Bits(${args[0]})`;
          if (to.k === "f64" && from.k === "u64") return `__ykF64FromBits(${args[0]})`;
          throw new RaiseCError(`bit_cast from ${from.k} to ${to.k}`);
        }
        if (callee.kind === "MemberExpr")
          throw new RaiseCError(`a call of the method "${name}" on an object`);
        const leaf = Object.hasOwn(LEAF_CALLS, name) ? LEAF_CALLS[name] : undefined;
        if (leaf !== undefined) return leaf(args);
        const d = callee.referencedDecl as ClangNode;
        const key = resolve({ name, kind: d.kind, type: normType(d.type?.qualType ?? "") });
        if (key !== undefined) return `${key}(${args.join(", ")})`;
        externals.add(name);
        return `${ident(name)}(${args.join(", ")})`;
      }
      case "InitListExpr": {
        const t = typeOf(e);
        const items = kids.map(expr);
        if (t.k === "arr" && t.size !== undefined)
          while (items.length < t.size) items.push(zeroOf(t.of));
        return `[${items.join(", ")}]`;
      }
      default:
        throw new RaiseCError(`the expression ${e.kind} is not raised yet`);
    }
  };

  const lines: string[] = [];
  const continueLabels = new Set<string>();
  // A union of 64-bit members (`union { double f; uint64_t i; }`): one 64-bit word, its members
  // views of it through the float64-bits leaf. By the variable's id: its members' types.
  const puns = new Map<string, Map<string, CType>>();
  let lastUnion: Map<string, CType> | undefined;
  const punOf = (e: ClangNode): { word: string; field: CType } | undefined => {
    if (e.kind !== "MemberExpr") return undefined;
    const base = stripCasts((e.inner as ClangNode[])[0] as ClangNode);
    const d = base.referencedDecl;
    const fields = d === undefined ? undefined : puns.get(d.id ?? "");
    if (fields === undefined || d === undefined) return undefined;
    const field = fields.get(e.name ?? "");
    if (field === undefined) throw new RaiseCError(`the union member ${e.name}`);
    return { word: declName(d), field };
  };
  const push = (s: string): void => {
    lines.push(s);
  };

  function cond(e: ClangNode): string {
    const t = typeOf(e);
    return t.k === "bool" ? expr(e) : wide(t) ? `(${expr(e)} !== 0n)` : `(${expr(e)} !== 0)`;
  }

  const stmt = (s: ClangNode): void => {
    const kids = s.inner ?? [];
    switch (s.kind) {
      case "CompoundStmt": {
        push("{");
        // A backward goto to a label of this block, from a statement after it and in no loop or
        // switch of its own: the statements from the label through that one are a loop the goto
        // continues, left at its end.
        for (let i = 0; i < kids.length; i++) {
          const c = kids[i] as ClangNode;
          if (c.kind !== "LabelStmt") {
            stmt(c);
            continue;
          }
          const label = (c as { declId?: string }).declId ?? "";
          let last = i;
          for (let j = i; j < kids.length; j++) if (gotosTo(kids[j] as ClangNode, label)) last = j;
          if (last === i && !gotosTo(c, label)) {
            stmt((c.inner as ClangNode[])[0] as ClangNode);
            continue;
          }
          for (let j = i; j <= last; j++)
            if (gotoInLoop(kids[j] as ClangNode, label, false))
              throw new RaiseCError("a goto inside a loop or switch of its own");
          continueLabels.add(label);
          push("while (true) {");
          stmt((c.inner as ClangNode[])[0] as ClangNode);
          for (let j = i + 1; j <= last; j++) stmt(kids[j] as ClangNode);
          push("break;");
          push("}");
          i = last;
        }
        push("}");
        return;
      }
      case "GotoStmt": {
        const target = (s as { targetLabelDeclId?: string }).targetLabelDeclId ?? "";
        if (!continueLabels.has(target))
          throw new RaiseCError("a goto forward, or out of its block");
        push("continue;");
        return;
      }
      case "LabelStmt":
        stmt((s.inner as ClangNode[])[0] as ClangNode);
        return;
      case "NullStmt":
        return;
      case "DeclStmt":
        for (const d of kids) {
          // A compile-time declaration computes nothing.
          if (["StaticAssertDecl", "TypeAliasDecl", "TypedefDecl", "UsingDecl"].includes(d.kind))
            continue;
          if (d.kind === "RecordDecl" && (d as { tagUsed?: string }).tagUsed === "union") {
            const fields = new Map<string, CType>();
            for (const fd of d.inner ?? []) {
              if (fd.kind !== "FieldDecl") continue;
              const t = ctype(fd.type);
              if (!(t.k === "f64" || wide(t)))
                throw new RaiseCError("a union with a member that is not 64 bits");
              fields.set(fd.name ?? "", t);
            }
            lastUnion = fields;
            continue;
          }
          if (d.kind === "VarDecl" && /^union\b/.test(d.type?.qualType ?? "")) {
            if (lastUnion === undefined || d.inner?.[0] !== undefined)
              throw new RaiseCError("a union variable other than a word of 64-bit views");
            puns.set(d.id ?? "", lastUnion);
            push(`let ${declName(d)} = 0n;`);
            continue;
          }
          if (d.kind !== "VarDecl") throw new RaiseCError(`the declaration ${d.kind}`);
          const t = ctype(d.type);
          vars.set(d.id ?? "", t);
          const init = d.inner?.[0];
          push(`let ${declName(d)} = ${init !== undefined ? expr(init) : zeroOf(t)};`);
        }
        return;
      case "ReturnStmt":
        push(kids.length > 0 ? `return ${expr(kids[0] as ClangNode)};` : "return;");
        return;
      case "IfStmt": {
        const [c, then, otherwise] = kids as [ClangNode, ClangNode, ClangNode?];
        push(`if (${cond(c)}) {`);
        stmt(then);
        if (otherwise !== undefined) {
          push("} else {");
          stmt(otherwise);
        }
        push("}");
        return;
      }
      case "WhileStmt": {
        const [c, b] = kids as [ClangNode, ClangNode];
        push(`while (${cond(c)}) {`);
        stmt(b);
        push("}");
        return;
      }
      case "DoStmt": {
        const [b, c] = kids as [ClangNode, ClangNode];
        // `do { .. } while (false)`, as a macro writes a statement, is its body once.
        const once = stripCasts(c).kind === "CXXBoolLiteralExpr" && !hasJump(b);
        if (once) {
          stmt(b);
          return;
        }
        push("do {");
        stmt(b);
        push(`} while (${cond(c)});`);
        return;
      }
      case "ForStmt": {
        // init, (condition variable), cond, inc, body; absent parts are empty objects.
        const [init, , c, inc, b] = kids as ClangNode[];
        push("{");
        if (init?.kind !== undefined) {
          if (init.kind === "DeclStmt") stmt(init);
          else push(`${expr(init)};`);
        }
        const test = c?.kind !== undefined ? cond(c) : "true";
        push(`for (; ${test}; ${inc?.kind !== undefined ? expr(inc) : ""}) {`);
        stmt(b as ClangNode);
        push("}");
        push("}");
        return;
      }
      case "BreakStmt":
        push("break;");
        return;
      case "ContinueStmt":
        push("continue;");
        return;
      case "SwitchStmt": {
        const [c, b] = kids as [ClangNode, ClangNode];
        push(`switch (${expr(c)}) {`);
        for (const item of b.inner ?? []) caseItem(item);
        push("}");
        return;
      }
      default:
        if (s.kind.endsWith("Operator") || s.kind.endsWith("Expr")) {
          push(`${expr(s)};`);
          return;
        }
        throw new RaiseCError(`the statement ${s.kind} is not raised yet`);
    }
  };
  // A switch's body: its cases, each with the statement it labels.
  const caseItem = (s: ClangNode): void => {
    if (s.kind === "CaseStmt") {
      const [v, inner] = s.inner as [ClangNode, ClangNode];
      push(`case ${expr(v)}:`);
      caseItem(inner);
      return;
    }
    if (s.kind === "DefaultStmt") {
      push("default:");
      caseItem((s.inner as ClangNode[])[0] as ClangNode);
      return;
    }
    stmt(s);
  };

  const b = body(fn);
  if (b === undefined) throw new RaiseCError(`${fn.name} has no body`);
  const sig = params.map((p) => `${declName(p)}: ${tsType(ctype(p.type))}`).join(", ");
  // C passes arguments by value: a parameter assigned in the body is a local.
  stmt(b);
  const top = [...globals.values()];
  return `export function f(${sig}): ${tsType(result)} {\n${top.join("\n")}\n${lines.join("\n")}\n}`;
}

const tsType = (t: CType): string =>
  t.k === "f64" || t.k === "i32" || t.k === "u32"
    ? "number"
    : wide(t)
      ? "bigint"
      : t.k === "bool"
        ? "boolean"
        : t.k === "arr"
          ? `${tsType(t.of)}[]`
          : "void";

function stripCasts(e: ClangNode): ClangNode {
  let n = e;
  while (
    (n.kind === "ImplicitCastExpr" ||
      n.kind === "ParenExpr" ||
      n.kind === "ConstantExpr" ||
      ((n.kind === "CStyleCastExpr" ||
        n.kind === "CXXConstCastExpr" ||
        n.kind === "CXXStaticCastExpr") &&
        (n.castKind === "NoOp" || n.castKind === "BitCast"))) &&
    n.inner?.[0] !== undefined
  )
    n = n.inner[0];
  return n;
}

function gotosTo(s: ClangNode, label: string): boolean {
  if (s.kind === "GotoStmt" && (s as { targetLabelDeclId?: string }).targetLabelDeclId === label)
    return true;
  return (s.inner ?? []).some((c) => gotosTo(c, label));
}
/** Whether a goto to the label is inside a loop or switch below `s`. */
function gotoInLoop(s: ClangNode, label: string, inLoop: boolean): boolean {
  if (s.kind === "GotoStmt" && (s as { targetLabelDeclId?: string }).targetLabelDeclId === label)
    return inLoop;
  const loop = ["ForStmt", "WhileStmt", "DoStmt", "SwitchStmt"].includes(s.kind);
  return (s.inner ?? []).some((c) => gotoInLoop(c, label, inLoop || loop));
}

const normType = (t: string): string => t.replace(/\s+/g, " ").trim();

function hasJump(s: ClangNode): boolean {
  if (s.kind === "BreakStmt" || s.kind === "ContinueStmt") return true;
  return (s.inner ?? []).some(hasJump);
}

/** A unit shaved: each function an atom's source, and what was refused, with the reason. */
export interface ShavedUnit {
  readonly atoms: ReadonlyMap<
    string,
    { readonly source: string; readonly externals: readonly string[] }
  >;
  readonly refused: ReadonlyMap<string, string>;
}

/**
 * Shave a C or C++ unit: the functions the filters select, and every function they call whose body
 * clang has (a header's inline function, a template's instance), each an atom. A callee with no body
 * is an external reference.
 */
export function shaveCUnit(
  file: string,
  filters: readonly string[],
  args: readonly string[] = [],
  clang = "clang++",
): ShavedUnit {
  const roots = clangFunctions(file, filters, args, clang);
  const dumps = new Map<string, ClangNode[]>();
  const found = new Map<string, ClangNode>(); // key -> declaration
  const keyOf = new Map<string, string>(); // name + type -> key
  const sig = (name: string, type: string): string => `${name} :: ${normType(type)}`;
  for (const [name, fn] of roots) {
    found.set(name, fn);
    keyOf.set(sig(name, fn.type?.qualType ?? ""), name);
  }
  const dumpOf = (name: string): ClangNode[] => {
    let nodes = dumps.get(name);
    if (nodes === undefined) {
      nodes = [];
      const json = execFileSync(
        clang,
        [
          ...args,
          "-fsyntax-only",
          "-Xclang",
          "-ast-dump=json",
          "-Xclang",
          `-ast-dump-filter=${name}`,
          file,
        ],
        { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] },
      );
      let i = 0;
      while (i < json.length) {
        while (i < json.length && /\s/.test(json[i] as string)) i++;
        if (i >= json.length) break;
        const [node, next] = readJsonValue(json, i);
        i = next;
        nodes.push(node as ClangNode);
      }
      dumps.set(name, nodes);
    }
    return nodes;
  };
  const lookup = (c: Callee): ClangNode | undefined => {
    const nodes = dumpOf(c.name);
    let hit: ClangNode | undefined;
    const walk = (n: ClangNode): void => {
      if (hit !== undefined) return;
      if (
        (n.kind === "FunctionDecl" || n.kind === "CXXMethodDecl") &&
        n.name === c.name &&
        normType(n.type?.qualType ?? "") === c.type &&
        body(n) !== undefined
      ) {
        hit = n;
        return;
      }
      for (const k of n.inner ?? []) walk(k);
    };
    for (const n of nodes) walk(n);
    return hit;
  };
  const resolve: CalleeResolver = (c) => {
    const known = keyOf.get(sig(c.name, c.type));
    if (known !== undefined) return known;
    const decl = lookup(c);
    if (decl === undefined) return undefined;
    let key = ident(c.name);
    for (let n = 2; found.has(key); n++) key = `${ident(c.name)}_${n}`;
    found.set(key, decl);
    keyOf.set(sig(c.name, c.type), key);
    return key;
  };
  const resolveGlobal: GlobalResolver = (name, type) => {
    const nodes = dumpOf(name);
    let hit: ClangNode | undefined;
    const walk = (n: ClangNode, inFunction: boolean): void => {
      if (hit !== undefined) return;
      if (
        n.kind === "VarDecl" &&
        !inFunction &&
        n.name === name &&
        normType(n.type?.qualType ?? "") === type &&
        n.inner?.[0] !== undefined
      ) {
        hit = n;
        return;
      }
      const fn = n.kind === "FunctionDecl" || n.kind === "CXXMethodDecl";
      for (const k of n.inner ?? []) walk(k, inFunction || fn);
    };
    for (const n of nodes) walk(n, false);
    return hit;
  };
  const atoms = new Map<string, { source: string; externals: string[] }>();
  const refused = new Map<string, string>();
  const done = new Set<string>();
  for (let progress = true; progress; ) {
    progress = false;
    for (const [key, fn] of [...found]) {
      if (done.has(key)) continue;
      done.add(key);
      progress = true;
      const externals = new Set<string>();
      try {
        atoms.set(key, {
          source: raiseCFunction(fn, resolve, externals, resolveGlobal),
          externals: [...externals],
        });
      } catch (e) {
        refused.set(key, e instanceof Error ? e.message : String(e));
      }
    }
  }
  return { atoms, refused };
}

/** The fixed-width leaves the raised code uses, as JavaScript (DEC-DUC-OPERATIONS-AS-ATOMS-001). */
export const C_LEAVES_JS = {
  __ykI32Mul: (a: number, b: number): number => Math.imul(a, b),
  __ykU64: (x: bigint): bigint => BigInt.asUintN(64, x),
  __ykI64: (x: bigint): bigint => BigInt.asIntN(64, x),
  __ykNumToBig: (x: number): bigint => BigInt(x),
  __ykBigToI32: (x: bigint): number => Number(BigInt.asIntN(32, x)),
  __ykBigToU32: (x: bigint): number => Number(BigInt.asUintN(32, x)),
  __ykBigToF64: (x: bigint): number => Number(x),
  __ykF64ToI64: (x: number): bigint => BigInt.asIntN(64, BigInt(Math.trunc(x))),
  __ykF64Bits: (x: number): bigint => {
    const v = new DataView(new ArrayBuffer(8));
    v.setFloat64(0, x);
    return v.getBigUint64(0);
  },
  __ykF64FromBits: (x: bigint): number => {
    const v = new DataView(new ArrayBuffer(8));
    v.setBigUint64(0, BigInt.asUintN(64, x));
    return v.getFloat64(0);
  },
} as const;
