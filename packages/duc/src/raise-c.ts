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

/**
 * An initializer list's explicit items. clang's JSON puts a list that has an array filler (the
 * value of the elements past the list: zero) as `array_filler: [filler, ...items]`, with no
 * `inner`.
 */
const initItems = (n: ClangNode): readonly ClangNode[] =>
  n.array_filler !== undefined ? n.array_filler.slice(1) : (n.inner ?? []);

const body = (fn: ClangNode): ClangNode | undefined =>
  fn.inner?.find((c) => c.kind === "CompoundStmt");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The value kinds the raiser represents (LP64): C's integers by width and sign, double, bool,
 * arrays, pointers (an address: an integer in the flat byte memory of the memory leaves), function
 * pointers (the function itself), and records (structs and unions, by clang's layout).
 */
type CType =
  | { readonly k: "f64" }
  | { readonly k: "i8" }
  | { readonly k: "u8" }
  | { readonly k: "i16" }
  | { readonly k: "u16" }
  | { readonly k: "i32" }
  | { readonly k: "u32" }
  | { readonly k: "i64" }
  | { readonly k: "u64" }
  | { readonly k: "bool" }
  | { readonly k: "void" }
  | { readonly k: "fn" }
  | { readonly k: "ptr"; readonly to: CType }
  | { readonly k: "rec"; readonly name: string }
  | { readonly k: "arr"; readonly of: CType; readonly size?: number };

const F64: CType = { k: "f64" };

/** A record's layout as clang computes it for the target: size, alignment, each field's offset. */
export interface RecordLayout {
  readonly size: number;
  readonly align: number;
  readonly fields: ReadonlyMap<string, { readonly offset: number; readonly type: string }>;
}
/** The type a typedef names, as clang spells it, when the unit has the typedef. */
export type TypedefResolver = (name: string) => string | undefined;
/** A record's layout by its name (`struct P`), when clang laid it out. */
export type LayoutResolver = (name: string) => RecordLayout | undefined;

// The unit being raised: its typedefs (a function's own are added as it is raised) and layouts.
let unitTypedef: TypedefResolver = () => undefined;
let unitLayout: LayoutResolver = () => undefined;
const localTypedefs = new Map<string, string>();

/** The C library's fixed typedefs on LP64, for a unit whose headers clang did not show. */
const LP64_TYPEDEFS: Readonly<Record<string, string>> = {
  int8_t: "signed char",
  uint8_t: "unsigned char",
  int16_t: "short",
  uint16_t: "unsigned short",
  int32_t: "int",
  uint32_t: "unsigned int",
  int64_t: "long",
  uint64_t: "unsigned long",
  size_t: "unsigned long",
  ssize_t: "long",
  uintptr_t: "unsigned long",
  intptr_t: "long",
  ptrdiff_t: "long",
};

const BUILTIN: Readonly<Record<string, CType>> = {
  char: { k: "i8" },
  "signed char": { k: "i8" },
  "unsigned char": { k: "u8" },
  short: { k: "i16" },
  "short int": { k: "i16" },
  "signed short": { k: "i16" },
  "unsigned short": { k: "u16" },
  "unsigned short int": { k: "u16" },
  int: { k: "i32" },
  signed: { k: "i32" },
  "signed int": { k: "i32" },
  unsigned: { k: "u32" },
  "unsigned int": { k: "u32" },
  long: { k: "i64" },
  "long int": { k: "i64" },
  "signed long": { k: "i64" },
  "long long": { k: "i64" },
  "long long int": { k: "i64" },
  "unsigned long": { k: "u64" },
  "unsigned long int": { k: "u64" },
  "unsigned long long": { k: "u64" },
  "unsigned long long int": { k: "u64" },
  double: F64,
  bool: { k: "bool" },
  _Bool: { k: "bool" },
  void: { k: "void" },
};

function ctype(t: { qualType: string; desugaredQualType?: string } | undefined): CType {
  if (t === undefined) throw new RaiseCError("a node with no type");
  return parseType(t.desugaredQualType ?? t.qualType);
}

/** A C type as clang spells it, typedefs resolved through the unit. */
function parseType(spelled: string, depth = 0): CType {
  if (depth > 32) throw new RaiseCError(`the type "${spelled}" does not resolve`);
  const raw = spelled
    .replace(/__attribute__\(\(.*?\)\)\s*/g, "")
    .replace(/\b(const|volatile|restrict|__restrict)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/\(\*\)\s*\(.*\)$/.test(raw)) return { k: "ptr", to: { k: "fn" } };
  const arr = /^(.*?)\s*\[(\d*)\]$/.exec(raw);
  if (arr !== null) {
    const of = parseType(arr[1] as string, depth + 1);
    return arr[2] === "" ? { k: "arr", of } : { k: "arr", of, size: Number(arr[2]) };
  }
  const ptr = /^(.*?)\s*\*$/.exec(raw);
  if (ptr !== null) return { k: "ptr", to: parseType(ptr[1] as string, depth + 1) };
  const builtin = BUILTIN[raw];
  if (builtin !== undefined) return builtin;
  if (/^(struct|union) /.test(raw)) return { k: "rec", name: raw };
  if (/\)$/.test(raw)) return { k: "fn" };
  if (raw === "float" || raw === "long double")
    throw new RaiseCError(`the C type "${raw}" is not raised yet`);
  const named = localTypedefs.get(raw) ?? unitTypedef(raw) ?? LP64_TYPEDEFS[raw];
  if (named !== undefined) return parseType(named, depth + 1);
  throw new RaiseCError(`the C type "${raw}" is not raised yet`);
}

const layoutOf = (t: CType): RecordLayout => {
  if (t.k !== "rec") throw new RaiseCError(`${t.k} is not a record`);
  const l = unitLayout(recordKey(t.name));
  if (l === undefined) throw new RaiseCError(`no layout from clang for "${t.name}"`);
  return l;
};

/** A type's size in bytes on LP64 (records: clang's layout). */
function sizeOf(t: CType): number {
  switch (t.k) {
    case "i8":
    case "u8":
    case "bool":
      return 1;
    case "i16":
    case "u16":
      return 2;
    case "i32":
    case "u32":
      return 4;
    case "i64":
    case "u64":
    case "f64":
    case "ptr":
      return 8;
    case "arr":
      if (t.size === undefined) throw new RaiseCError("the size of an array of unknown length");
      return t.size * sizeOf(t.of);
    case "rec":
      return layoutOf(t).size;
    default:
      throw new RaiseCError(`the size of ${t.k}`);
  }
}
const alignOf = (t: CType): number =>
  t.k === "arr" ? alignOf(t.of) : t.k === "rec" ? layoutOf(t).align : sizeOf(t);

const wide = (t: CType): boolean => t.k === "i64" || t.k === "u64";
const narrow = (t: CType): boolean =>
  t.k === "i8" || t.k === "u8" || t.k === "i16" || t.k === "u16";
const integral = (t: CType): boolean =>
  narrow(t) || t.k === "i32" || t.k === "u32" || wide(t) || t.k === "bool";
const zeroOf = (t: CType): string =>
  t.k === "f64" || t.k === "i32" || t.k === "u32" || narrow(t) || t.k === "ptr"
    ? "0"
    : wide(t)
      ? "0n"
      : t.k === "bool"
        ? "false"
        : t.k === "arr"
          ? `[${Array.from({ length: t.size ?? 0 }, () => zeroOf(t.of)).join(", ")}]`
          : "undefined";

/** An int (a number in [-2^31, 2^31)) narrowed to a C type of 8 or 16 bits. */
function toNarrow(e: string, to: CType): string {
  switch (to.k) {
    case "i8":
      return `((${e} << 24) >> 24)`;
    case "u8":
      return `(${e} & 255)`;
    case "i16":
      return `((${e} << 16) >> 16)`;
    case "u16":
      return `(${e} & 65535)`;
    default:
      throw new RaiseCError(`${to.k} is not narrow`);
  }
}

/** C's conversion of a value of type `from` to type `to`. */
function convert(e: string, from: CType, to: CType): string {
  if (from.k === to.k || to.k === "void") return e;
  if (to.k === "bool") return wide(from) ? `(${e} !== 0n)` : `(${e} !== 0)`;
  if (from.k === "bool") return wide(to) ? `(${e} ? 1n : 0n)` : `(${e} ? 1 : 0)`;
  if (to.k === "f64") {
    if (from.k === "ptr") throw new RaiseCError("a conversion of a pointer to double");
    return wide(from) ? `__ykBigToF64(${e})` : e;
  }
  if (from.k === "f64") {
    // Truncation toward zero; out of range is undefined in C.
    if (to.k === "i32") return `(${e} | 0)`;
    if (to.k === "u32") return `(${e} >>> 0)`;
    if (narrow(to)) return toNarrow(`(${e} | 0)`, to);
    if (to.k === "ptr") throw new RaiseCError("a conversion of a double to a pointer");
    return to.k === "i64" ? `__ykF64ToI64(${e})` : `__ykU64(__ykF64ToI64(${e}))`;
  }
  // A pointer is an address (an integer below 2^53); to and from integers, its value.
  if (to.k === "ptr") return wide(from) ? `__ykBigToF64(__ykU64(${e}))` : e;
  if (from.k === "ptr") {
    if (to.k === "i64" || to.k === "u64") return `__ykNumToBig(${e})`;
    if (to.k === "i32") return `(${e} | 0)`;
    if (to.k === "u32") return `(${e} >>> 0)`;
    if (narrow(to)) return toNarrow(`(${e} | 0)`, to);
  }
  if (narrow(to)) return toNarrow(wide(from) ? `__ykBigToI32(${e})` : e, to);
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
      throw new RaiseCError(`a conversion from ${from.k} to ${to.k} is not raised yet`);
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
  // C promotes 8- and 16-bit operands to int; an operation in a narrow type (++ on a char) is
  // computed as int and narrowed.
  if (narrow(t)) return toNarrow(arith(op, a, b, { k: "i32" }, { k: "i32" }), t);
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

/** The rest of what raising a function needs from its unit: typedefs and record layouts. */
export interface UnitTypes {
  readonly typedef?: TypedefResolver;
  readonly layout?: LayoutResolver;
}

/**
 * Where a C object lives. A local whose address is taken or that is passed as an array, every
 * record, and everything reached through a pointer, is memory (`mem`: an address expression); any
 * other local is a JavaScript variable (`reg`), an array only indexed is a JavaScript array.
 */
type Place =
  | { readonly k: "reg"; readonly e: string; readonly t: CType }
  | { readonly k: "mem"; readonly addr: string; readonly t: CType };

/** A value of type `t` loaded from memory at `a` (DEC-DUC-OPERATIONS-AS-ATOMS-001's memory leaves). */
function loadAt(a: string, t: CType): string {
  switch (t.k) {
    case "u8":
      return `__ykLoad8(${a})`;
    case "i8":
      return toNarrow(`__ykLoad8(${a})`, t);
    case "u16":
      return `__ykLoad16(${a})`;
    case "i16":
      return toNarrow(`__ykLoad16(${a})`, t);
    case "u32":
      return `__ykLoad32(${a})`;
    case "i32":
      return `(__ykLoad32(${a}) | 0)`;
    case "u64":
      return `__ykLoad64(${a})`;
    case "i64":
      return `__ykI64(__ykLoad64(${a}))`;
    case "f64":
      return `__ykLoadF64(${a})`;
    case "bool":
      return `(__ykLoad8(${a}) !== 0)`;
    case "ptr":
      if (t.to.k === "fn") throw new RaiseCError("a function pointer stored in memory");
      return `__ykBigToF64(__ykLoad64(${a}))`;
    default:
      throw new RaiseCError(`a load of ${t.k} (a ${t.k === "rec" ? "struct by value" : t.k})`);
  }
}

/** Store `v` (already of type `t`) at `a`; its value is `v`, as an assignment's is. */
function storeAt(a: string, t: CType, v: string): string {
  switch (t.k) {
    case "u8":
    case "i8":
      return `__ykStore8(${a}, ${v})`;
    case "u16":
    case "i16":
      return `__ykStore16(${a}, ${v})`;
    case "u32":
    case "i32":
      return `__ykStore32(${a}, ${v})`;
    case "u64":
    case "i64":
      return `__ykStore64(${a}, ${v})`;
    case "f64":
      return `__ykStoreF64(${a}, ${v})`;
    case "bool":
      return `(__ykStore8(${a}, (${v}) ? 1 : 0) !== 0)`;
    case "ptr":
      if (t.to.k === "fn") throw new RaiseCError("a function pointer stored in memory");
      return `__ykBigToF64(__ykStore64(${a}, __ykNumToBig(${v})))`;
    default:
      throw new RaiseCError(`a store of ${t.k}`);
  }
}

/** An index or offset as a number of elements (a 64-bit one read as signed: addresses wrap). */
const indexNum = (e: string, t: CType): string => (wide(t) ? `__ykBigToF64(__ykI64(${e}))` : e);
const scaled = (e: string, size: number): string => (size === 1 ? e : `(${e} * ${size})`);

/** The bytes of a C string literal's value as clang prints it (C escapes), with its NUL. */
function cStringBytes(literal: string): number[] {
  const body = literal.replace(/^[uUL8]*"/, "").replace(/"$/, "");
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      out.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = body[++i] as string;
    const simple: Record<string, number> = {
      n: 10,
      t: 9,
      r: 13,
      "0": 0,
      a: 7,
      b: 8,
      f: 12,
      v: 11,
      e: 27,
    };
    if (n === "x") {
      const m = /^[0-9a-fA-F]+/.exec(body.slice(i + 1)) as RegExpExecArray;
      out.push(Number.parseInt(m[0], 16) & 255);
      i += m[0].length;
    } else if (/[0-7]/.test(n)) {
      const m = /^[0-7]{1,3}/.exec(body.slice(i)) as RegExpExecArray;
      out.push(Number.parseInt(m[0], 8) & 255);
      i += m[0].length - 1;
    } else if (simple[n] !== undefined && !(n === "0" && /[0-7]/.test(body[i + 1] ?? ""))) {
      out.push(simple[n] as number);
    } else out.push(n.charCodeAt(0));
  }
  out.push(0);
  return out;
}

/** The element kind the data leaf lays out (little-endian): C's scalar kinds. */
const dataKind = (t: CType): string => (t.k === "ptr" ? "u64" : t.k === "bool" ? "u8" : t.k);

/**
 * A function of the unit as the TypeScript the lifter reads: `export function f(..)`. A call to
 * another function of the unit is a call of that name, a reference the link makes an atom.
 */
export function raiseCFunction(
  fn: ClangNode,
  resolve: CalleeResolver,
  externals: Set<string> = new Set(),
  resolveGlobal: GlobalResolver = () => undefined,
  types: UnitTypes = {},
): string {
  const saved = [unitTypedef, unitLayout] as const;
  unitTypedef = types.typedef ?? (() => undefined);
  unitLayout = types.layout ?? (() => undefined);
  localTypedefs.clear();
  try {
    return raiseBody(fn, resolve, externals, resolveGlobal);
  } finally {
    [unitTypedef, unitLayout] = saved;
    localTypedefs.clear();
  }
}

function raiseBody(
  fn: ClangNode,
  resolve: CalleeResolver,
  externals: Set<string>,
  resolveGlobal: GlobalResolver,
): string {
  // The constants at namespace or file scope the function reads: each a const at its top.
  const globals = new Map<string, string>(); // decl id -> its const's line
  const globalNames = new Map<string, string>();
  const globalDecls = new Map<string, ClangNode>(); // decl id -> its declaration (initializer)
  const globalData = new Map<string, string>(); // decl id -> its constant memory's name
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

  // Which locals live in memory: their address is taken (other than `*&x`), they are an array
  // used as a pointer (passed, assigned, offset), or they are records.
  const b0 = body(fn);
  if (b0 === undefined) throw new RaiseCError(`${fn.name} has no body`);
  const inMemory = new Set<string>();
  // Variables the function writes: a `static` local it never writes is a constant, not state.
  const written = new Set<string>();
  // `viaDeref`: inside `*(cast)&x` (fdlibm's `*(volatile double *)&a[3]`), which is x itself.
  const scan = (n: ClangNode, parent: ClangNode | undefined, viaDeref = false): void => {
    const derefOfAddr =
      n.kind === "UnaryOperator" &&
      n.opcode === "*" &&
      (() => {
        const s = stripCasts((n.inner ?? [])[0] as ClangNode);
        return s.kind === "UnaryOperator" && s.opcode === "&";
      })();
    if (n.kind === "UnaryOperator" && n.opcode === "&" && !viaDeref) {
      const target = stripParens((n.inner ?? [])[0] as ClangNode);
      if (target.kind === "DeclRefExpr") inMemory.add(target.referencedDecl?.id ?? "");
    }
    const writes =
      (n.kind === "BinaryOperator" && n.opcode === "=") ||
      n.kind === "CompoundAssignOperator" ||
      (n.kind === "UnaryOperator" && (n.opcode === "++" || n.opcode === "--"));
    if (writes) {
      const target = stripParens((n.inner ?? [])[0] as ClangNode);
      if (target.kind === "DeclRefExpr") written.add(target.referencedDecl?.id ?? "");
    }
    if (n.kind === "ImplicitCastExpr" && n.castKind === "ArrayToPointerDecay") {
      const target = stripParens((n.inner ?? [])[0] as ClangNode);
      const indexed = parent?.kind === "ArraySubscriptExpr" && (parent.inner ?? [])[0] === n;
      if (target.kind === "DeclRefExpr" && !indexed) inMemory.add(target.referencedDecl?.id ?? "");
    }
    const passThrough =
      derefOfAddr ||
      (viaDeref &&
        ["ParenExpr", "ImplicitCastExpr", "CStyleCastExpr", "CXXStaticCastExpr"].includes(n.kind));
    for (const k of n.inner ?? []) scan(k, n, passThrough);
  };
  scan(b0, undefined);

  // Memory locals: allocated at entry (one slot each, as a stack frame), freed at every return.
  const frame: string[] = [];
  const top: string[] = [];
  const mems = new Map<string, Place & { k: "mem" }>(); // decl id -> its place
  const memOf = (d: ClangNode, t: CType): Place & { k: "mem" } => {
    const id = d.id ?? "";
    let p = mems.get(id);
    if (p === undefined) {
      const name = `${declName(d)}_p`;
      top.push(`const ${name} = __ykAlloc(${sizeOf(t)}, ${alignOf(t)});`);
      frame.push(name);
      p = { k: "mem", addr: name, t };
      mems.set(id, p);
    }
    return p;
  };
  const isMem = (d: ClangNode, t: CType): boolean => inMemory.has(d.id ?? "") || t.k === "rec";

  // Temporaries for read-modify-write of memory (`*p += 1`, `s[i]++`): declared at the top.
  let temps = 0;
  const temp = (t: CType): string => {
    const name = `__t${temps++}`;
    top.push(`let ${name} = ${wide(t) ? "0n" : "0"};`);
    return name;
  };

  // A variable of namespace or file scope: a constant is its value, raised once at the top; a
  // variable that is written is module state, not raised here.
  const globalDecl = (d: ClangNode): ClangNode => {
    const id = d.id ?? "";
    let decl = globalDecls.get(id);
    if (decl === undefined) {
      decl = resolveGlobal(d.name ?? "", normType(d.type?.qualType ?? ""));
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
      globalDecls.set(id, decl);
    }
    return decl;
  };
  const globalRef = (d: ClangNode): string => {
    const id = d.id ?? "";
    const known = globalNames.get(id);
    if (known !== undefined) return known;
    const decl = globalDecl(d);
    const name = `${ident(d.name ?? "g")}_g`;
    globalNames.set(id, name);
    vars.set(id, ctype(decl.type));
    globals.set(id, `const ${name} = ${expr(decl.inner?.[0] as ClangNode)};`);
    return name;
  };
  // A constant array used as a pointer: its elements laid out in constant memory, once.
  const constData = (d: ClangNode, viaGlobal: boolean): string => {
    const id = d.id ?? "";
    const known = globalData.get(id);
    if (known !== undefined) return known;
    const t = ctype((viaGlobal ? globalDecl(d) : d).type);
    if (t.k !== "arr") throw new RaiseCError(`constant memory for ${t.k}`);
    const values = viaGlobal ? globalRef(d) : declName(d);
    const name = `${ident(d.name ?? "g")}_d`;
    globals.set(`${id}:data`, `const ${name} = __ykData("${dataKind(t.of)}", ${values});`);
    globalData.set(id, name);
    return name;
  };
  const typeOf = (e: ClangNode): CType => {
    if (e.type === undefined) throw new RaiseCError(`the ${e.kind} node has no type`);
    return ctype(e.type);
  };

  /** Where an lvalue expression's object is. */
  const place = (e: ClangNode): Place => {
    const kids = e.inner ?? [];
    const k0 = kids[0] as ClangNode;
    switch (e.kind) {
      case "ParenExpr":
        return place(k0);
      case "ImplicitCastExpr":
      case "CStyleCastExpr":
      case "CXXConstCastExpr":
      case "CXXStaticCastExpr":
        // A cast that keeps an lvalue (a qualification): the same object.
        if (e.castKind === "NoOp") return place(k0);
        break;
      case "DeclRefExpr": {
        const d = e.referencedDecl as ClangNode;
        const t = typeOf(e);
        const mem = mems.get(d.id ?? "");
        if (mem !== undefined) return mem;
        if (d.kind === "VarDecl" && !vars.has(d.id ?? "")) return { k: "reg", e: globalRef(d), t };
        return { k: "reg", e: declName(d), t };
      }
      case "UnaryOperator": {
        if ((e.opcode === "++" || e.opcode === "--") && e.isPostfix !== true)
          return { k: "reg", e: expr(e), t: typeOf(e) };
        if (e.opcode !== "*") break;
        // *&x is x (fdlibm writes `*(volatile double *)&a[3]` to stop a compiler folding).
        const inner = stripCasts(k0);
        if (inner.kind === "UnaryOperator" && inner.opcode === "&")
          return place((inner.inner as ClangNode[])[0] as ClangNode);
        return { k: "mem", addr: expr(k0), t: typeOf(e) };
      }
      case "ArraySubscriptExpr": {
        const [x, y] = kids as [ClangNode, ClangNode];
        const t = typeOf(e);
        // An array that is a JavaScript array (only ever indexed): its element.
        const arr = stripParens(x).kind === "ImplicitCastExpr" ? valueArray(x) : undefined;
        if (arr !== undefined) return { k: "reg", e: `${arr}[${indexNum(expr(y), typeOf(y))}]`, t };
        // Otherwise base + index * size: C allows the index first.
        const [base, idx] = typeOf(x).k === "ptr" ? [x, y] : [y, x];
        return {
          k: "mem",
          addr: `(${expr(base)} + ${scaled(indexNum(expr(idx), typeOf(idx)), sizeOf(t))})`,
          t,
        };
      }
      case "ConditionalOperator":
        // C++: a conditional of two lvalues is an lvalue; read, it is the chosen one's value.
        return {
          k: "reg",
          e: `(${cond(k0)} ? ${read(place(kids[1] as ClangNode))} : ${read(place(kids[2] as ClangNode))})`,
          t: typeOf(e),
        };
      case "BinaryOperator":
      case "CompoundAssignOperator":
        // C++: an assignment (or a comma ending in an lvalue) is an lvalue; read, its value.
        return { k: "reg", e: expr(e), t: typeOf(e) };
      case "MemberExpr": {
        const t = typeOf(e);
        const pun = punOf(e);
        if (pun !== undefined)
          return {
            k: "reg",
            e:
              pun.field.k === "f64"
                ? `__ykF64FromBits(${pun.word})`
                : pun.field.k === "i64"
                  ? `__ykI64(${pun.word})`
                  : pun.word,
            t,
          };
        const arrow = (e as { isArrow?: boolean }).isArrow === true;
        const baseT = arrow ? (typeOf(k0) as CType & { k: "ptr" }).to : typeOf(k0);
        const field = layoutOf(baseT).fields.get(e.name ?? "");
        if (field === undefined) throw new RaiseCError(`the field "${e.name}"`);
        let addr: string;
        if (arrow) addr = expr(k0);
        else {
          const p = place(k0);
          if (p.k !== "mem") throw new RaiseCError("a member of a record that is not in memory");
          addr = p.addr;
        }
        return { k: "mem", addr: field.offset === 0 ? addr : `(${addr} + ${field.offset})`, t };
      }
      case "StringLiteral":
        return {
          k: "mem",
          addr: `__ykData("u8", [${cStringBytes(e.value ?? '""').join(", ")}])`,
          t: typeOf(e),
        };
    }
    throw new RaiseCError(`the lvalue ${e.kind} is not raised yet`);
  };
  /** The JavaScript array an array expression is (a local only indexed, or a constant table). */
  const valueArray = (decay: ClangNode): string | undefined => {
    const n = stripParens(decay);
    if (n.kind !== "ImplicitCastExpr" || n.castKind !== "ArrayToPointerDecay") return undefined;
    const target = stripParens((n.inner ?? [])[0] as ClangNode);
    if (target.kind !== "DeclRefExpr") return undefined;
    const d = target.referencedDecl as ClangNode;
    if (mems.has(d.id ?? "") || inMemory.has(d.id ?? "")) return undefined;
    if (d.kind === "VarDecl" && !vars.has(d.id ?? "")) return globalRef(d);
    return declName(d);
  };
  const read = (p: Place): string => (p.k === "reg" ? p.e : loadAt(p.addr, p.t));
  const write = (p: Place, v: string): string =>
    p.k === "reg" ? `(${p.e} = ${v})` : storeAt(p.addr, p.t, v);
  /** Read, compute, write back (once for the address): `x op= v`, `++x`, `x++`. */
  const modify = (p: Place, next: (old: string) => string, postfix: boolean): string => {
    if (p.k === "reg") {
      if (!postfix) return `(${p.e} = ${next(p.e)})`;
      const old = temp(p.t);
      return `((${old} = ${p.e}), (${p.e} = ${next(old)}), ${old})`;
    }
    const a = temp({ k: "f64" });
    const at: Place = { k: "mem", addr: a, t: p.t };
    if (!postfix) return `((${a} = ${p.addr}), ${storeAt(a, p.t, next(loadAt(a, p.t)))})`;
    const old = temp(p.t);
    return `((${a} = ${p.addr}), (${old} = ${read(at)}), ${storeAt(a, p.t, next(old))}, ${old})`;
  };
  /** A pointer `p` (to `to`) moved by `n` elements of `nt`; `sign` is "+" or "-". */
  const offset = (p: string, n: string, nt: CType, to: CType, sign: string): string => {
    const size = to.k === "void" ? 1 : sizeOf(to);
    return `(${p} ${sign} ${scaled(indexNum(n, nt), size)})`;
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
      case "CharacterLiteral":
        return String(Number(e.value));
      case "FloatingLiteral": {
        const v = Number(e.value);
        if (Number.isNaN(v)) throw new RaiseCError(`the floating literal ${e.value}`);
        return Object.is(v, -0) ? "-0" : String(v);
      }
      case "StringLiteral":
        return JSON.stringify(JSON.parse(e.value ?? '""'));
      case "CXXBoolLiteralExpr":
        return e.value === "true" || (e as { value?: unknown }).value === true ? "true" : "false";
      case "ImplicitValueInitExpr":
        return zeroOf(typeOf(e));
      case "UnaryExprOrTypeTraitExpr": {
        const arg = (e as { argType?: { qualType: string; desugaredQualType?: string } }).argType;
        const t = arg !== undefined ? ctype(arg) : typeOf(k0);
        const v = e.name === "sizeof" ? sizeOf(t) : alignOf(t);
        return wide(typeOf(e)) ? `${v}n` : String(v);
      }
      case "DeclRefExpr": {
        const d = e.referencedDecl as ClangNode;
        if (d.kind === "FunctionDecl") {
          // A function as a value (passed as a function pointer): a reference to its atom.
          const key = resolve({
            name: d.name ?? "",
            kind: d.kind,
            type: normType(d.type?.qualType ?? ""),
          });
          if (key !== undefined) return key;
          externals.add(d.name ?? "");
          return ident(d.name ?? "");
        }
        if (d.kind === "EnumConstantDecl")
          throw new RaiseCError("an enumeration constant is not raised yet");
        return read(place(e));
      }
      case "ImplicitCastExpr":
      case "CStyleCastExpr":
      case "CXXStaticCastExpr":
      case "CXXConstCastExpr":
      case "CXXReinterpretCastExpr":
      case "CXXFunctionalCastExpr": {
        const ck = e.castKind ?? "";
        if (ck === "LValueToRValue") return read(place(k0));
        if (ck === "ArrayToPointerDecay") {
          // An array used as a pointer: its address in memory (a local, a string, a constant).
          const target = stripParens(k0);
          if (target.kind === "StringLiteral") return (place(target) as Place & { k: "mem" }).addr;
          if (target.kind === "DeclRefExpr") {
            const d = target.referencedDecl as ClangNode;
            const mem = mems.get(d.id ?? "");
            if (mem !== undefined) return mem.addr;
            const global = d.kind === "VarDecl" && !vars.has(d.id ?? "");
            if (global || /\bconst\b/.test(d.type?.qualType ?? "")) return constData(d, global);
          }
          const p = place(k0);
          if (p.k !== "mem")
            throw new RaiseCError("an array used as a pointer that is not in memory");
          return p.addr;
        }
        if (["NoOp", "FunctionToPointerDecay", "BitCast"].includes(ck)) return expr(k0);
        if (ck === "NullToPointer") return "0";
        if (ck === "ToVoid") return expr(k0);
        if (
          [
            "IntegralCast",
            "IntegralToFloating",
            "FloatingToIntegral",
            "IntegralToBoolean",
            "FloatingToBoolean",
            "PointerToIntegral",
            "IntegralToPointer",
            "PointerToBoolean",
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
      case "MemberExpr": {
        const pun = e.kind === "MemberExpr" ? punOf(e) : undefined;
        if (pun !== undefined)
          return pun.field.k === "f64"
            ? `__ykF64FromBits(${pun.word})`
            : pun.field.k === "i64"
              ? `__ykI64(${pun.word})`
              : pun.word;
        return read(place(e));
      }
      case "UnaryOperator": {
        const t = typeOf(e);
        const op = e.opcode ?? "";
        if (op === "++" || op === "--") {
          const p = place(k0);
          const sign = op === "++" ? "+" : "-";
          const next =
            t.k === "ptr"
              ? (old: string) => offset(old, "1", { k: "i32" }, t.to, sign)
              : (old: string) => arith(sign, old, wide(t) ? "1n" : "1", t, t);
          return modify(p, next, e.isPostfix === true);
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
        if (op === "*") return read(place(e));
        if (op === "&") {
          const p = place(k0);
          if (p.k === "mem") return p.addr;
          throw new RaiseCError("the address of an object that is not in memory");
        }
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
          return write(place(a), expr(b));
        }
        // A comparison or logical operator is a bool in C++ and an int (1 or 0) in C.
        const truth = (x: string): string => (typeOf(e).k === "bool" ? x : `(${x} ? 1 : 0)`);
        if (op === "&&" || op === "||") return truth(`(${cond(a)} ${op} ${cond(b)})`);
        if (op === ",") return `(${expr(a)}, ${expr(b)})`;
        const ta = typeOf(a);
        const tb = typeOf(b);
        if (["<", "<=", ">", ">=", "==", "!="].includes(op))
          return truth(arith(op, expr(a), expr(b), ta, tb));
        // Pointer arithmetic: an address moved by whole elements; two addresses' distance.
        if ((op === "+" || op === "-") && ta.k === "ptr" && tb.k !== "ptr")
          return offset(expr(a), expr(b), tb, ta.to, op);
        if (op === "+" && tb.k === "ptr") return offset(expr(b), expr(a), ta, tb.to, "+");
        if (op === "-" && ta.k === "ptr" && tb.k === "ptr") {
          const size = ta.to.k === "void" ? 1 : sizeOf(ta.to);
          const d =
            size === 1 ? `(${expr(a)} - ${expr(b)})` : `((${expr(a)} - ${expr(b)}) / ${size})`;
          return `__ykNumToBig(${d})`;
        }
        return arith(op, expr(a), expr(b), typeOf(e), tb);
      }
      case "CompoundAssignOperator": {
        // a op= b: computed in the computation type, then converted to a's.
        const op = (e.opcode ?? "").slice(0, -1);
        const a = kids[0] as ClangNode;
        const b = kids[1] as ClangNode;
        const lhs = typeOf(a);
        const p = place(a);
        if (lhs.k === "ptr") {
          if (op !== "+" && op !== "-") throw new RaiseCError(`"${op}=" on a pointer`);
          const n = expr(b);
          return modify(p, (old) => offset(old, n, typeOf(b), lhs.to, op), false);
        }
        const comp = ctype(e.computeLHSType);
        const res = ctype(e.computeResultType);
        const v = expr(b);
        return modify(
          p,
          (old) => convert(arith(op, convert(old, lhs, comp), v, res, typeOf(b)), res, lhs),
          false,
        );
      }
      case "CXXMemberCallExpr":
        throw new RaiseCError("a call of a method on an object is not raised yet");
      case "ConditionalOperator":
        return `(${cond(k0)} ? ${expr(kids[1] as ClangNode)} : ${expr(kids[2] as ClangNode)})`;
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
        const d = callee.referencedDecl as ClangNode | undefined;
        // A call through a function pointer (a variable holding a function): call its value.
        if (d === undefined || d.kind === "VarDecl" || d.kind === "ParmVarDecl")
          return `(${expr(callee)})(${args.join(", ")})`;
        const leaf = Object.hasOwn(LEAF_CALLS, name) ? LEAF_CALLS[name] : undefined;
        if (leaf !== undefined) return leaf(args);
        const key = resolve({ name, kind: d.kind, type: normType(d.type?.qualType ?? "") });
        if (key !== undefined) return `${key}(${args.join(", ")})`;
        externals.add(name);
        return `${ident(name)}(${args.join(", ")})`;
      }
      case "InitListExpr": {
        const t = typeOf(e);
        const items = initItems(e).map(expr);
        if (t.k === "arr" && t.size !== undefined)
          while (items.length < t.size) items.push(zeroOf(t.of));
        return `[${items.join(", ")}]`;
      }
      default:
        throw new RaiseCError(`the expression ${e.kind} is not raised yet`);
    }
  };

  /** Stores that initialize an object in memory at `addr` from an initializer (zero-filled). */
  const initialize = (addr: string, t: CType, given: ClangNode | undefined): string[] => {
    // A member an initializer leaves out (clang's ImplicitValueInitExpr) is zero.
    const init = given?.kind === "ImplicitValueInitExpr" ? undefined : given;
    if (t.k === "arr") {
      const n = t.size ?? 0;
      const size = sizeOf(t.of);
      const at = (i: number): string => (i === 0 ? addr : `(${addr} + ${i * size})`);
      const s = init === undefined ? undefined : stripParens(init);
      if (s?.kind === "StringLiteral") {
        const bytes = cStringBytes(s.value ?? '""');
        return Array.from(
          { length: n },
          (_, i) => `${storeAt(at(i), t.of, String(bytes[i] ?? 0))};`,
        );
      }
      if (s !== undefined && s.kind !== "InitListExpr")
        throw new RaiseCError(`an array initialized by ${s.kind}`);
      // Elements past the list (clang's array filler) are zero.
      const items = s === undefined ? [] : initItems(s);
      const out: string[] = [];
      for (let i = 0; i < n; i++) out.push(...initialize(at(i), t.of, items[i]));
      return out;
    }
    if (t.k === "rec") {
      const l = layoutOf(t);
      const s = init === undefined ? undefined : stripParens(init);
      if (s !== undefined && s.kind !== "InitListExpr")
        throw new RaiseCError(`a record initialized by ${s.kind}`);
      const items = s === undefined ? [] : initItems(s);
      const out: string[] = [];
      let i = 0;
      for (const [, f] of l.fields) {
        out.push(
          ...initialize(
            f.offset === 0 ? addr : `(${addr} + ${f.offset})`,
            parseType(f.type),
            items[i],
          ),
        );
        i++;
        if (/^union /.test(t.name)) break; // a union's initializer is its first member's
      }
      return out;
    }
    return [`${storeAt(addr, t, init === undefined ? zeroOf(t) : expr(init))};`];
  };

  const lines: string[] = [];
  const continueLabels = new Set<string>();
  // A union of 64-bit members (`union { double f; uint64_t i; }`) not in memory: one 64-bit word,
  // its members views of it through the float64-bits leaf. By the variable's id: its members.
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
  // Return: the value first, then the frame freed.
  const returnLine = (value: string | undefined): void => {
    if (frame.length === 0) {
      push(value !== undefined ? `return ${value};` : "return;");
      return;
    }
    const frees = [...frame].reverse().map((a) => `__ykFree(${a});`);
    if (value === undefined) {
      push(`{ ${frees.join(" ")} return; }`);
      return;
    }
    const r = temp(result);
    push(`{ ${r} = ${value}; ${frees.join(" ")} return ${r}; }`);
  };

  function cond(e: ClangNode): string {
    const t = typeOf(e);
    if (t.k === "ptr" && t.to.k === "fn") return `(${expr(e)} !== 0)`;
    return t.k === "bool" ? expr(e) : wide(t) ? `(${expr(e)} !== 0n)` : `(${expr(e)} !== 0)`;
  }

  let switchType: CType | undefined;
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
          // A compile-time declaration computes nothing; a typedef names a type for what follows.
          if (d.kind === "TypedefDecl") {
            localTypedefs.set(d.name ?? "", d.type?.desugaredQualType ?? d.type?.qualType ?? "");
            continue;
          }
          if (["StaticAssertDecl", "TypeAliasDecl", "UsingDecl", "EnumDecl"].includes(d.kind))
            continue;
          if (d.kind === "RecordDecl") {
            if ((d as { tagUsed?: string }).tagUsed !== "union") continue;
            const fields = new Map<string, CType>();
            let all64 = true;
            for (const fd of d.inner ?? []) {
              if (fd.kind !== "FieldDecl") continue;
              const t = ctype(fd.type);
              if (!(t.k === "f64" || wide(t))) all64 = false;
              fields.set(fd.name ?? "", t);
            }
            lastUnion = all64 ? fields : undefined;
            continue;
          }
          if (d.kind !== "VarDecl") throw new RaiseCError(`the declaration ${d.kind}`);
          if (
            d.storageClass === "static" &&
            !/\bconst\b/.test(d.type?.qualType ?? "") &&
            (written.has(d.id ?? "") || inMemory.has(d.id ?? ""))
          )
            throw new RaiseCError(`the static variable "${d.name}" is state`);
          const t = ctype(d.type);
          vars.set(d.id ?? "", t);
          const init = d.inner?.[0];
          if (
            t.k === "rec" &&
            lastUnion !== undefined &&
            /^union\b/.test(t.name) &&
            !inMemory.has(d.id ?? "") &&
            init === undefined
          ) {
            puns.set(d.id ?? "", lastUnion);
            push(`let ${declName(d)} = 0n;`);
            continue;
          }
          if (isMem(d, t)) {
            const p = memOf(d, t);
            for (const line of initialize(p.addr, t, init)) push(line);
            continue;
          }
          push(`let ${declName(d)} = ${init !== undefined ? expr(init) : zeroOf(t)};`);
        }
        return;
      case "ReturnStmt":
        returnLine(kids.length > 0 ? expr(kids[0] as ClangNode) : undefined);
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
        const lit = stripCasts(c);
        const once =
          (lit.kind === "CXXBoolLiteralExpr" ||
            (lit.kind === "IntegerLiteral" && Number(lit.value) === 0)) &&
          !hasJump(b);
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
        const outer = switchType;
        switchType = typeOf(c);
        push(`switch (${expr(c)}) {`);
        for (const item of b.inner ?? []) caseItem(item);
        push("}");
        switchType = outer;
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
  // A switch's body: its cases, each with the statement it labels. A case's value is converted to
  // the switch's (promoted) type, as C does.
  const caseItem = (s: ClangNode): void => {
    if (s.kind === "CaseStmt") {
      const [v, inner] = s.inner as [ClangNode, ClangNode];
      const value = switchType === undefined ? expr(v) : convert(expr(v), typeOf(v), switchType);
      push(`case ${value}:`);
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

  const sig = params.map((p) => `${declName(p)}: ${tsType(ctype(p.type))}`).join(", ");
  // C passes arguments by value: a parameter assigned in the body is a local. A parameter whose
  // address is taken is copied into its slot.
  const entry: string[] = [];
  for (const p of params) {
    const t = ctype(p.type);
    if (!inMemory.has(p.id ?? "")) continue;
    const name = declName(p);
    const slot = memOf(p, t);
    entry.push(`${storeAt(slot.addr, t, name)};`);
  }
  stmt(b0);
  if (frame.length > 0 && result.k === "void") returnLine(undefined);
  const consts = [...globals.values()];
  return `export function f(${sig}): ${tsType(result)} {\n${consts.join("\n")}\n${top.join("\n")}\n${entry.join("\n")}\n${lines.join("\n")}\n}`;
}

const tsType = (t: CType): string =>
  t.k === "ptr" && t.to.k === "fn"
    ? "any"
    : t.k === "f64" || t.k === "i32" || t.k === "u32" || narrow(t) || t.k === "ptr"
      ? "number"
      : wide(t)
        ? "bigint"
        : t.k === "bool"
          ? "boolean"
          : t.k === "arr"
            ? `${tsType(t.of)}[]`
            : "void";

function stripParens(e: ClangNode): ClangNode {
  let n = e;
  while (n.kind === "ParenExpr" && n.inner?.[0] !== undefined) n = n.inner[0];
  return n;
}

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
  const typedef: TypedefResolver = (name) => {
    let hit: string | undefined;
    const walk = (n: ClangNode): void => {
      if (hit !== undefined) return;
      if (n.kind === "TypedefDecl" && n.name === name) {
        hit = n.type?.desugaredQualType ?? n.type?.qualType;
        return;
      }
      for (const k of n.inner ?? []) walk(k);
    };
    for (const n of dumpOf(name)) walk(n);
    return hit;
  };
  let layouts: Map<string, RecordLayout> | undefined;
  const layout: LayoutResolver = (name) => {
    layouts ??= recordLayouts(
      execFileSync(clang, [...args, "-fsyntax-only", "-Xclang", "-fdump-record-layouts", file], {
        encoding: "utf8",
        maxBuffer: 1 << 30,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    return layouts.get(recordKey(name));
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
          source: raiseCFunction(fn, resolve, externals, resolveGlobal, { typedef, layout }),
          externals: [...externals],
        });
      } catch (e) {
        refused.set(key, e instanceof Error ? e.message : String(e));
      }
    }
  }
  return { atoms, refused };
}

/** A record's name as a key: C++ scopes dropped (`union P::(unnamed at f.c:1:40)` and the C spelling meet). */
const recordKey = (name: string): string => normType(name.replace(/\b[A-Za-z_]\w*::/g, ""));

/**
 * The record layouts clang computed for a unit (`-fdump-record-layouts`): each record's size,
 * alignment, and its own fields' offsets (nested records' fields are theirs, not the parent's).
 * A bit-field is refused when it is used: its layout is not a byte offset.
 */
export function recordLayouts(dump: string): Map<string, RecordLayout> {
  const out = new Map<string, RecordLayout>();
  for (const block of dump.split("*** Dumping AST Record Layout").slice(1)) {
    const lines = block.split("\n").filter((l) => l.includes("|"));
    const head = /^\s*\d+ \| (.*)$/.exec(lines[0] ?? "");
    const tail = /\[sizeof=(\d+),.*?align=(\d+)/.exec(block);
    if (head === null || tail === null) continue;
    const fields = new Map<string, { offset: number; type: string }>();
    for (const l of lines.slice(1)) {
      const m = /^\s*(\d+) \| {3}(\S.*)$/.exec(l);
      if (m === null) continue; // nested deeper, a bit-field (`0:0-3 |`), or the size line
      const text = (m[2] as string).trim();
      const name = /([A-Za-z_]\w*)$/.exec(text)?.[1];
      if (name === undefined) continue;
      fields.set(name, { offset: Number(m[1]), type: text.slice(0, -name.length).trim() });
    }
    out.set(recordKey((head[1] as string).trim()), {
      size: Number(tail[1]),
      align: Number(tail[2]),
      fields,
    });
  }
  return out;
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

/** A trap of the memory leaves: an access outside every live region, or a write to constant data. */
export class CMemoryTrap extends Error {}

/**
 * The memory leaves as JavaScript (DEC-DUC-OPERATIONS-AS-ATOMS-001, #1363): one flat, byte-addressed
 * memory. An address is an integer; a region is allocated aligned, its size rounded up to 16 bytes
 * (as malloc's granularity, so an aligned word read of a region's last bytes stays inside it) and
 * zeroed. Loads and stores are little-endian, exact and total, and trap outside a live region; a
 * freed region's addresses are never reused, so a stale pointer traps too. `__ykData` is constant
 * memory: a kind's values laid out once per distinct content, read-only.
 */
export function createCMemory() {
  interface Region {
    readonly base: number;
    readonly bytes: Uint8Array;
    readonly view: DataView;
    readonly constant: boolean;
    live: boolean;
  }
  const regions: Region[] = []; // by base, ascending (addresses only grow)
  let next = 0x10000;
  const data = new Map<string, number>();
  const regionOf = (a: number, n: number, write: boolean): Region => {
    let lo = 0;
    let hi = regions.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = regions[mid] as Region;
      if (a < r.base) hi = mid - 1;
      else if (a >= r.base + r.bytes.length) lo = mid + 1;
      else {
        if (!r.live || a + n > r.base + r.bytes.length || (write && r.constant)) break;
        return r;
      }
    }
    throw new CMemoryTrap(
      `memory trap: ${write ? "store" : "load"} of ${n} at 0x${a.toString(16)}`,
    );
  };
  const alloc = (size: number, align: number, constant = false): number => {
    const a = Math.max(16, align);
    const base = Math.ceil(next / a) * a;
    const bytes = new Uint8Array(Math.max(16, Math.ceil(size / 16) * 16));
    regions.push({ base, bytes, view: new DataView(bytes.buffer), constant, live: true });
    next = base + bytes.length + 16; // a gap: one past the end of a region is in no other
    return base;
  };
  const at = (a: number, n: number, write = false): [DataView, number] => {
    if (!Number.isInteger(a)) throw new CMemoryTrap(`memory trap: address ${a}`);
    const r = regionOf(a, n, write);
    return [r.view, a - r.base];
  };
  const KINDS: Record<string, [number, (v: DataView, o: number, x: number & bigint) => void]> = {
    i8: [1, (v, o, x) => v.setInt8(o, x)],
    u8: [1, (v, o, x) => v.setUint8(o, x)],
    i16: [2, (v, o, x) => v.setInt16(o, x, true)],
    u16: [2, (v, o, x) => v.setUint16(o, x, true)],
    i32: [4, (v, o, x) => v.setInt32(o, x, true)],
    u32: [4, (v, o, x) => v.setUint32(o, x, true)],
    i64: [8, (v, o, x) => v.setBigInt64(o, BigInt(x), true)],
    u64: [8, (v, o, x) => v.setBigUint64(o, BigInt(x), true)],
    f64: [8, (v, o, x) => v.setFloat64(o, x, true)],
  };
  const leaves = {
    __ykAlloc: (size: number, align: number): number => alloc(size, align),
    __ykFree: (a: number): void => {
      if (a === 0) return;
      const r = regionOf(a, 1, false);
      if (r.base !== a || r.constant)
        throw new CMemoryTrap(`memory trap: free of 0x${a.toString(16)}`);
      r.live = false;
    },
    __ykData: (kind: string, values: readonly (number | bigint)[]): number => {
      const key = `${kind}:${values.map(String).join(",")}`;
      const known = data.get(key);
      if (known !== undefined) return known;
      const spec = KINDS[kind];
      if (spec === undefined) throw new CMemoryTrap(`constant data of kind ${kind}`);
      const [size, set] = spec;
      const a = alloc(size * values.length, size, true);
      const r = regions[regions.length - 1] as Region;
      values.forEach((x, i) => set(r.view, i * size, x as number & bigint));
      data.set(key, a);
      return a;
    },
    __ykLoad8: (a: number): number => {
      const [v, o] = at(a, 1);
      return v.getUint8(o);
    },
    __ykLoad16: (a: number): number => {
      const [v, o] = at(a, 2);
      return v.getUint16(o, true);
    },
    __ykLoad32: (a: number): number => {
      const [v, o] = at(a, 4);
      return v.getUint32(o, true);
    },
    __ykLoad64: (a: number): bigint => {
      const [v, o] = at(a, 8);
      return v.getBigUint64(o, true);
    },
    __ykLoadF64: (a: number): number => {
      const [v, o] = at(a, 8);
      return v.getFloat64(o, true);
    },
    __ykStore8: (a: number, x: number): number => {
      const [v, o] = at(a, 1, true);
      v.setUint8(o, x & 255);
      return x;
    },
    __ykStore16: (a: number, x: number): number => {
      const [v, o] = at(a, 2, true);
      v.setUint16(o, x & 65535, true);
      return x;
    },
    __ykStore32: (a: number, x: number): number => {
      const [v, o] = at(a, 4, true);
      v.setUint32(o, x >>> 0, true);
      return x;
    },
    __ykStore64: (a: number, x: bigint): bigint => {
      const [v, o] = at(a, 8, true);
      v.setBigUint64(o, BigInt.asUintN(64, x), true);
      return x;
    },
    __ykStoreF64: (a: number, x: number): number => {
      const [v, o] = at(a, 8, true);
      v.setFloat64(o, x, true);
      return x;
    },
  };
  return {
    leaves,
    /** Bytes into a fresh region (for a test's inputs): its address. */
    put(bytes: Uint8Array | readonly number[], align = 16): number {
      const a = alloc(bytes.length, align);
      const r = regions[regions.length - 1] as Region;
      r.bytes.set(bytes);
      return a;
    },
    /** `n` bytes at `a` (for a test's outputs). */
    get(a: number, n: number): Uint8Array {
      const r = regionOf(a, n, false);
      return r.bytes.slice(a - r.base, a - r.base + n);
    },
  };
}

/** The names of the memory leaves (DEC-DUC-OPERATIONS-AS-ATOMS-001, #1363). */
export const C_MEMORY_LEAVES = Object.keys(createCMemory().leaves);
