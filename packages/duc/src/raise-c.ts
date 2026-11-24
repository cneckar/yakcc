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
  (n.array_filler !== undefined ? n.array_filler.slice(1) : (n.inner ?? [])).map(unbrace);

/** A character array's string in braces (`char x[16] = {"0123.."}`) is the string. */
const unbrace = (n: ClangNode): ClangNode => {
  if (n.kind !== "InitListExpr" || n.array_filler !== undefined) return n;
  const only = n.inner?.length === 1 ? (n.inner[0] as ClangNode) : undefined;
  return only?.kind === "StringLiteral" && /\[\d*\]$/.test(n.type?.qualType ?? "") ? only : n;
};

/** A variable declaration's initializer: its child that is not an attribute (`__attribute__((visibility))` comes first). */
const initOf = (d: ClangNode): ClangNode | undefined => {
  const i = (d.inner ?? []).find((c) => !c.kind.endsWith("Attr") && c.kind !== "FullComment");
  return i === undefined ? undefined : unbrace(i);
};

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
  | { readonly k: "f32" }
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
  /** Each field's byte offset and type; a bit-field also its first bit (from the record's start) and width. */
  readonly fields: ReadonlyMap<
    string,
    {
      readonly offset: number;
      readonly type: string;
      readonly bit?: { readonly start: number; readonly width: number };
    }
  >;
}
/** The type a typedef names, as clang spells it, when the unit has the typedef. */
export type TypedefResolver = (name: string) => string | undefined;
/** A record's layout by its name (`struct P`), when clang laid it out. */
export type LayoutResolver = (name: string) => RecordLayout | undefined;

// The unit being raised: its typedefs (a function's own are added as it is raised) and layouts.
let unitTypedef: TypedefResolver = () => undefined;
let unitLayout: LayoutResolver = () => undefined;
// Whether the unit is parsed with -mlong-double-64 (long double is IEEE double).
let unitLongDouble64 = false;
/** The unit's enumeration constants, by name (UnitTypes.enumValue). */
let unitEnumValue: (name: string) => bigint | undefined = () => undefined;
/** The unit's offsetof values (UnitTypes.offsetOf). */
let unitOffsetOf: (e: ClangNode) => number | undefined = () => undefined;

/** A node's source range as offsets only (clang's JSON leaves out a location's repeated parts). */
export function rangeKey(e: ClangNode): string {
  const r = (e as { range?: Record<string, Record<string, unknown>> }).range ?? {};
  const at = (l: Record<string, unknown> | undefined): string =>
    [
      l?.offset,
      (l?.spellingLoc as { offset?: number })?.offset,
      (l?.expansionLoc as { offset?: number })?.offset,
    ].join(",");
  return `${at(r.begin)};${at(r.end)}`;
}

/** The offset of `struct x, a.b[2].c` (as clang's -ast-print writes offsetof) from the layouts. */
function offsetOfDesignator(type: string, path: string): number | undefined {
  let t = parseType(type.trim());
  let offset = 0;
  for (const part of path.trim().match(/\.?[A-Za-z_]\w*|\[\s*\d+\s*\]/g) ?? []) {
    if (part.startsWith("[")) {
      if (t.k !== "arr") return undefined;
      t = t.of;
      offset += Number(part.slice(1, -1)) * sizeOf(t);
      continue;
    }
    if (t.k !== "rec") return undefined;
    const field = unitLayout(t.name)?.fields.get(part.replace(/^\./, ""));
    if (field === undefined) return undefined;
    offset += field.offset;
    t = parseType(field.type);
  }
  return offset;
}
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
  float: { k: "f32" },
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
    .replace(/\s*\bnoexcept\b(\([^)]*\))?/g, "")
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
  if (raw === "long double" && unitLongDouble64) return F64;
  if (raw === "long double") throw new RaiseCError(`the C type "${raw}" is not raised yet`);
  if (raw === "__builtin_va_list") return parseType("struct __va_list_tag[1]", depth + 1);
  const named = localTypedefs.get(raw) ?? unitTypedef(raw) ?? LP64_TYPEDEFS[raw];
  if (named !== undefined) return parseType(named, depth + 1);
  throw new RaiseCError(`the C type "${raw}" is not raised yet`);
}

/**
 * x86-64's `va_list` element (`struct __va_list_tag`, 24 bytes). The raised code keeps one thing
 * in it: at offset 0, the address of the next variable argument (see `__va` below).
 */
const VA_LIST_TAG: RecordLayout = {
  size: 24,
  align: 8,
  fields: new Map([["cursor", { offset: 0, type: "unsigned long" }]]),
};

const layoutOf = (t: CType): RecordLayout => {
  if (t.k !== "rec") throw new RaiseCError(`${t.k} is not a record`);
  if (t.name === "struct __va_list_tag") return VA_LIST_TAG;
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
    case "f32":
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
  t.k === "f64" || t.k === "f32" || t.k === "i32" || t.k === "u32" || narrow(t) || t.k === "ptr"
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
  // float (binary32): a number rounded to binary32 by its leaf. To double, exact; from double or
  // from a 32-bit integer, one rounding; from a 64-bit integer, refused (two roundings can differ).
  if (to.k === "f32") {
    if (from.k === "f64" || narrow(from) || from.k === "i32" || from.k === "u32")
      return `__ykF32(${e})`;
    if (from.k === "bool") return `(${e} ? 1 : 0)`;
    throw new RaiseCError(`a conversion from ${from.k} to float`);
  }
  if (from.k === "f32") return convert(e, F64, to);
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
  // A pointer is an address (an integer below 2^53); to and from integers, its value. The high
  // addresses (MAP_FAILED, (void *)-1) are negative, whatever integer type they came from.
  if (to.k === "ptr") return wide(from) ? `__ykBigToF64(__ykI64(${e}))` : e;
  if (from.k === "ptr") {
    if (to.k === "i64") return `__ykNumToBig(${e})`;
    if (to.k === "u64") return `__ykU64(__ykNumToBig(${e}))`;
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
  // float arithmetic: computed in double and rounded once to binary32, which is exact for these.
  if (t.k === "f32") {
    if (!["+", "-", "*", "/"].includes(op)) throw new RaiseCError(`"${op}" on float`);
    return `__ykF32(${a} ${op} ${b})`;
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
  fabsl: (a) => `Math.abs(${a[0]})`,
  __builtin_fabsl: (a) => `Math.abs(${a[0]})`,
  __builtin_huge_vall: () => "Infinity",
  __builtin_infl: () => "Infinity",
  __builtin_nanl: () => "NaN",
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
  __builtin_huge_valf: () => "Infinity",
  __builtin_inff: () => "Infinity",
  __builtin_nanf: () => "NaN",
  __builtin_inf: () => "Infinity",
  __builtin_nan: () => "NaN",
  __builtin_nans: () => "NaN",
  __builtin_signbit: (a) => `__ykBigToI32(__ykF64Bits(${a[0]}) >> 63n)`,
  // A branch hint: its value is its first argument's.
  __builtin_expect: (a) => `${a[0]}`,
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
  /**
   * A variable with static storage that the function writes or takes the address of (module
   * state): its key for `__ykStatic`, its definition recorded by the unit. `fn` names the function
   * for a static local. Undefined when the unit cannot define it (then it is refused).
   */
  readonly static?: (decl: ClangNode, fn?: string) => string | undefined;
  /** The unit is parsed with clang's -mlong-double-64: long double is double. */
  readonly longDouble64?: boolean;
  /** An enumeration constant's value, by its name (one scope in C; ids differ between dumps). */
  readonly enumValue?: (name: string) => bigint | undefined;
  /** An offsetof expression's value (clang's JSON does not say which member). */
  readonly offsetOf?: (e: ClangNode) => number | undefined;
}

/**
 * Where a C object lives. A local whose address is taken or that is passed as an array, every
 * record, and everything reached through a pointer, is memory (`mem`: an address expression); any
 * other local is a JavaScript variable (`reg`), an array only indexed is a JavaScript array.
 */
type Place =
  | { readonly k: "reg"; readonly e: string; readonly t: CType }
  | { readonly k: "mem"; readonly addr: string; readonly t: CType }
  /** A bit-field: `width` bits from bit `shift` of the storage unit (an unsigned `unit`) at `addr`. */
  | {
      readonly k: "bits";
      readonly addr: string;
      readonly t: CType;
      readonly unit: CType;
      readonly shift: number;
      readonly width: number;
    };

const SIGNED = new Set(["i8", "i16", "i32", "i64"]);

/**
 * A bit-field of a record at `addr`: in a storage unit the size of its type, aligned, holding all
 * its bits (else a 64-bit unit from its first byte).
 */
function bitsPlace(
  addr: string,
  bit: { readonly start: number; readonly width: number },
  t: CType,
): Place & { k: "bits" } {
  const size = sizeOf(t);
  const unitBits = size * 8;
  let unitOff = Math.floor(bit.start / unitBits) * size;
  let unit: CType = { k: size === 1 ? "u8" : size === 2 ? "u16" : size === 4 ? "u32" : "u64" };
  if (bit.start - unitOff * 8 + bit.width > unitBits) {
    unitOff = Math.floor(bit.start / 8);
    unit = { k: "u64" };
    if (bit.start - unitOff * 8 + bit.width > 64)
      throw new RaiseCError("a bit-field straddles its storage");
  }
  return {
    k: "bits",
    addr: unitOff === 0 ? addr : `(${addr} + ${unitOff})`,
    t,
    unit,
    shift: bit.start - unitOff * 8,
    width: bit.width,
  };
}

/** A bit-field's value, from its storage unit's address `a`. */
function bitsRead(a: string, p: Place & { k: "bits" }): string {
  const { unit, shift, width, t } = p;
  if (unit.k === "u64") {
    const raw = `((__ykLoad64(${a}) >> ${shift}n) & ${(1n << BigInt(width)) - 1n}n)`;
    const v =
      SIGNED.has(t.k) && width < 64 ? `(__ykI64(${raw} << ${64 - width}n) >> ${64 - width}n)` : raw;
    return convert(v, { k: SIGNED.has(t.k) ? "i64" : "u64" }, t);
  }
  const raw = `((${loadAt(a, unit)} >>> ${shift}) & ${width === 32 ? 0xffffffff : 2 ** width - 1})`;
  const v =
    SIGNED.has(t.k) && width < 32
      ? `((${raw} << ${32 - width}) >> ${32 - width})`
      : `(${raw} >>> 0)`;
  return convert(v, { k: SIGNED.has(t.k) ? "i32" : "u32" }, t);
}

/** The storage unit's new value with the bit-field set to `v` (of the field's type), at `a`. */
function bitsMerge(a: string, p: Place & { k: "bits" }, v: string): string {
  const { unit, shift, width, t } = p;
  if (unit.k === "u64") {
    const mask = ((1n << BigInt(width)) - 1n) << BigInt(shift);
    const bits = wide(t) ? `__ykU64(${v})` : convert(v, t, { k: "u64" });
    return `((__ykLoad64(${a}) & ${~mask & ((1n << 64n) - 1n)}n) | ((${bits} << ${shift}n) & ${mask}n))`;
  }
  const mask = (width === 32 ? 0xffffffff : 2 ** width - 1) * 2 ** shift;
  const keep = (~mask >>> 0) & (unit.k === "u8" ? 0xff : unit.k === "u16" ? 0xffff : 0xffffffff);
  const bits = convert(v, t, { k: "u32" });
  return `(((${loadAt(a, unit)} & ${keep}) | ((${bits} << ${shift}) & ${mask >>> 0})) >>> 0)`;
}

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
    case "f32":
      return `__ykLoadF32(${a})`;
    case "bool":
      return `(__ykLoad8(${a}) !== 0)`;
    case "ptr":
      return `__ykBigToF64(__ykI64(__ykLoad64(${a})))`;
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
    case "f32":
      return `__ykStoreF32(${a}, ${v})`;
    case "bool":
      return `(__ykStore8(${a}, (${v}) ? 1 : 0) !== 0)`;
    case "ptr":
      return `__ykBigToF64(__ykI64(__ykStore64(${a}, __ykNumToBig(${v}))))`;
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
  const saved = [unitTypedef, unitLayout, unitLongDouble64] as const;
  unitTypedef = types.typedef ?? (() => undefined);
  unitLayout = types.layout ?? (() => undefined);
  unitLongDouble64 = types.longDouble64 === true;
  const savedEnum = [unitEnumValue, unitOffsetOf] as const;
  unitEnumValue = types.enumValue ?? (() => undefined);
  unitOffsetOf = types.offsetOf ?? (() => undefined);
  localTypedefs.clear();
  try {
    return raiseBody(fn, resolve, externals, resolveGlobal, types.static);
  } finally {
    [unitTypedef, unitLayout, unitLongDouble64] = saved;
    [unitEnumValue, unitOffsetOf] = savedEnum;
    localTypedefs.clear();
  }
}

function raiseBody(
  fn: ClangNode,
  resolve: CalleeResolver,
  externals: Set<string>,
  resolveGlobal: GlobalResolver,
  unitStatic: UnitTypes["static"],
): string {
  // The constants at namespace or file scope the function reads: each a const at its top.
  const globals = new Map<string, string>(); // decl id -> its const's line
  const globalNames = new Map<string, string>();
  const globalDecls = new Map<string, ClangNode>(); // decl id -> its declaration (initializer)
  const globalData = new Map<string, string>(); // decl id -> its constant memory's name
  const params = (fn.inner ?? []).filter((c) => c.kind === "ParmVarDecl");
  // A variadic function takes its variable arguments' address as a last parameter, `__va`.
  const variadic = variadicParams(fn.type?.qualType ?? "") !== undefined;
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
      // The address of a variable, or of an element or member of one (`&buf[12]`, `&s.f`).
      let target = stripParens((n.inner ?? [])[0] as ClangNode);
      for (;;) {
        const base = (target.inner ?? [])[0];
        if (
          target.kind === "ArraySubscriptExpr" &&
          base?.kind === "ImplicitCastExpr" &&
          base.castKind === "ArrayToPointerDecay"
        )
          target = stripParens((base.inner ?? [])[0] as ClangNode);
        else if (
          target.kind === "MemberExpr" &&
          (target as { isArrow?: boolean }).isArrow !== true &&
          base !== undefined
        )
          target = stripParens(base);
        else break;
      }
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
      if (decl === undefined || initOf(decl) === undefined)
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
    // A constant with external linkage is also defined as a static: another unit that declares it
    // without its initializer reads it from static memory.
    if (decl.storageClass !== "static") unitStatic?.(d);
    const name = `${ident(d.name ?? "g")}_g`;
    globalNames.set(id, name);
    vars.set(id, ctype(decl.type));
    globals.set(id, `const ${name} = ${expr(initOf(decl) as ClangNode)};`);
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
  const isGlobal = (d: ClangNode): boolean =>
    d.kind === "VarDecl" && (globalNames.has(d.id ?? "") || !vars.has(d.id ?? ""));
  /** Whether a global is a constant read as a value (not module state, its address not taken). */
  const constGlobal = (d: ClangNode): boolean => {
    if (inMemory.has(d.id ?? "")) return false;
    const decl = resolveGlobal(d.name ?? "", normType(d.type?.qualType ?? ""));
    return (
      decl !== undefined &&
      initOf(decl) !== undefined &&
      (/\bconst\b/.test(decl.type?.qualType ?? "") ||
        /\bconstexpr\b/.test(decl.type?.qualType ?? ""))
    );
  };
  /** Whether this unit has a global's initializer. */
  const hasInit = (d: ClangNode): boolean => {
    const decl = resolveGlobal(d.name ?? "", normType(d.type?.qualType ?? ""));
    return decl !== undefined && initOf(decl) !== undefined;
  };
  /** A global that is module state: its static memory. */
  const staticPlace = (d: ClangNode, t: CType): (Place & { k: "mem" }) | undefined => {
    const key = unitStatic?.(d);
    return key === undefined
      ? undefined
      : { k: "mem", addr: `__ykStatic(${JSON.stringify(key)})`, t };
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
        if (isGlobal(d)) {
          if (constGlobal(d)) return { k: "reg", e: globalRef(d), t };
          const sp = staticPlace(d, t);
          if (sp !== undefined) return sp;
          return { k: "reg", e: globalRef(d), t };
        }
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
        if (field.bit !== undefined) return bitsPlace(addr, field.bit, t);
        return { k: "mem", addr: field.offset === 0 ? addr : `(${addr} + ${field.offset})`, t };
      }
      case "CompoundLiteralExpr": {
        // An object of its own (musl's `((union {double _f; uint64_t _i;}){x})._i`): a frame
        // slot, initialized where the expression is evaluated.
        const t = typeOf(e);
        const slot = `__lit${temps++}`;
        top.push(`const ${slot} = __ykAlloc(${sizeOf(t)}, ${alignOf(t)});`);
        frame.push(slot);
        const steps = (
          t.k === "rec" || t.k === "arr" ? initialize(slot, t, k0) : [storeAt(slot, t, expr(k0))]
        ).map((x) => `(${x.replace(/;$/, "")})`);
        return { k: "mem", addr: `(${[...steps, slot].join(", ")})`, t };
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
    // A row of a JavaScript array of arrays (`tab[i][j]` of a constant table): its element.
    if (target.kind === "ArraySubscriptExpr") {
      const row = place(target);
      return row.k === "reg" && row.t.k === "arr" ? row.e : undefined;
    }
    if (target.kind !== "DeclRefExpr") return undefined;
    const d = target.referencedDecl as ClangNode;
    if (mems.has(d.id ?? "") || inMemory.has(d.id ?? "")) return undefined;
    if (isGlobal(d)) return constGlobal(d) ? globalRef(d) : undefined;
    return declName(d);
  };
  const read = (p: Place): string =>
    p.k === "reg" ? p.e : p.k === "bits" ? bitsRead(p.addr, p) : loadAt(p.addr, p.t);
  const write = (p: Place, v: string): string => {
    if (p.k === "reg") return `(${p.e} = ${v})`;
    if (p.k === "mem") return storeAt(p.addr, p.t, v);
    // A bit-field: the unit read, merged and written (once for the address); its value, the field's.
    const a = temp({ k: "f64" });
    const at = { ...p, addr: a };
    return `((${a} = ${p.addr}), ${storeAt(a, p.unit, bitsMerge(a, at, v))}, ${bitsRead(a, at)})`;
  };
  /** Read, compute, write back (once for the address): `x op= v`, `++x`, `x++`. */
  const modify = (p: Place, next: (old: string) => string, postfix: boolean): string => {
    if (p.k === "bits") {
      const a = temp({ k: "f64" });
      const at = { ...p, addr: a };
      const old = temp(p.t);
      const set = `${storeAt(a, p.unit, bitsMerge(a, at, next(old)))}`;
      return `((${a} = ${p.addr}), (${old} = ${bitsRead(a, at)}), ${set}, ${postfix ? old : bitsRead(a, at)})`;
    }
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
        // A string as an array's value (an initializer): its bytes, with the NUL.
        return `[${cStringBytes(e.value ?? '""').join(", ")}]`;
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
      case "OffsetOfExpr": {
        const v = unitOffsetOf(e);
        if (v === undefined) throw new RaiseCError("an offsetof whose member is not known");
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
          if (key !== undefined) return `__ykFnAddr(${key})`;
          externals.add(d.name ?? "");
          return `__ykFnAddr(${ident(d.name ?? "")})`;
        }
        if (d.kind === "EnumConstantDecl") {
          const v = unitEnumValue(d.name ?? "");
          if (v === undefined)
            throw new RaiseCError(`the enumeration constant ${d.name} has no value`);
          return wide(typeOf(e)) ? `${v}n` : String(v);
        }
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
            const global = isGlobal(d);
            // A global that is state, or a constant whose initializer this unit lacks (an extern
            // declaration): static memory.
            if (global && (!/\bconst\b/.test(d.type?.qualType ?? "") || !hasInit(d))) {
              const sp = staticPlace(d, typeOf(target));
              if (sp !== undefined) return sp.addr;
            }
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
        if (ck === "FloatingCast") return convert(expr(k0), typeOf(k0), typeOf(e));
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
          return t.k === "f64" || t.k === "f32"
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
          if (typeOf(a).k === "rec") return assignRecord(place(a), b);
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
        if (callee.kind === "MemberExpr" && !(typeOf(callee).k === "ptr"))
          throw new RaiseCError(`a call of the method "${name}" on an object`);
        const d = callee.referencedDecl as ClangNode | undefined;
        // A call through a function pointer (a variable, a field, any expression): the function at
        // its address.
        // (The callee's own type, before its casts: `((cmpfun)p)(..)` calls a void * as a function.)
        const ct = typeOf(k0);
        const direct =
          callee.kind === "DeclRefExpr" &&
          (d?.kind === "FunctionDecl" || d?.kind === "CXXMethodDecl");
        if (!direct && ct.k === "ptr" && ct.to.k === "fn")
          return `__ykFnAt(${expr(k0)})(${args.join(", ")})`;
        if (callee.kind === "UnaryOperator" && callee.opcode === "*")
          return `__ykFnAt(${expr((callee.inner as ClangNode[])[0] as ClangNode)})(${args.join(", ")})`;
        if (d === undefined || d.kind === "VarDecl" || d.kind === "ParmVarDecl")
          throw new RaiseCError(`a call of ${callee.kind}`);
        const leaf = Object.hasOwn(LEAF_CALLS, name) ? LEAF_CALLS[name] : undefined;
        if (leaf !== undefined) return leaf(args);
        // Variable arguments: va_start sets the list's cursor to this function's `__va`; va_copy
        // copies a cursor; va_end does nothing.
        if (name === "__builtin_va_start" || name === "__builtin_c23_va_start") {
          if (!variadic) throw new RaiseCError("va_start outside a variadic function");
          return `__ykStore64(${args[0]}, __ykNumToBig(__va))`;
        }
        if (name === "__builtin_va_end") return "undefined";
        if (name === "__builtin_va_copy") return `__ykStore64(${args[0]}, __ykLoad64(${args[1]}))`;
        // A call of a variadic function: the arguments past its parameters (promoted by clang)
        // are packed into 8-byte slots, and the slots' address is its last argument, `__va`.
        const fixed = variadicParams(d.type?.qualType ?? "");
        let callArgs = args;
        let pack: string[] = [];
        let area = "";
        if (fixed !== undefined) {
          area = temp({ k: "f64" });
          const extras = kids.slice(1 + fixed);
          pack = [
            `(${area} = __ykAlloc(${Math.max(8, 8 * extras.length)}, 8))`,
            ...extras.map((x, i) => {
              const xt = typeOf(x);
              const slot = i === 0 ? area : `(${area} + ${8 * i})`;
              const v = args[1 + fixed + i - 1] as string;
              if (xt.k === "f64") return `__ykStoreF64(${slot}, ${v})`;
              if (wide(xt)) return `__ykStore64(${slot}, ${v})`;
              if (xt.k === "ptr" || xt.k === "i32" || xt.k === "u32")
                return `__ykStore64(${slot}, __ykNumToBig(${v}))`;
              throw new RaiseCError(`a variable argument of ${xt.k}`);
            }),
          ];
          callArgs = [...args.slice(0, fixed), area];
        }
        const key = resolve({ name, kind: d.kind, type: normType(d.type?.qualType ?? "") });
        const target = key ?? ident(name);
        if (key === undefined) externals.add(name);
        const call = `${target}(${callArgs.join(", ")})`;
        if (fixed === undefined) return call;
        const r = temp(typeOf(e).k === "void" ? { k: "i32" } : typeOf(e));
        return `(${pack.join(", ")}, (${r} = ${call}), __ykFree(${area}), ${r})`;
      }
      case "VAArgExpr": {
        // The next variable argument: read at the list's cursor, which moves 8 bytes on.
        const t = typeOf(e);
        const list = temp({ k: "f64" });
        const at = temp({ k: "f64" });
        return `((${list} = ${expr(k0)}), (${at} = __ykBigToF64(__ykI64(__ykLoad64(${list})))), __ykStore64(${list}, __ykNumToBig(${at} + 8)), ${loadAt(at, t)})`;
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

  /**
   * A record assigned: from a compound literal (`(struct meta){0}`), initialized in place; from
   * another record, its bytes copied (8 at a time, then 1).
   */
  const assignRecord = (dst: Place, src: ClangNode): string => {
    if (dst.k !== "mem") throw new RaiseCError("a record assigned that is not in memory");
    const t = dst.t;
    const s0 = stripCasts(src);
    const d = temp({ k: "f64" });
    const steps = [`(${d} = ${dst.addr})`];
    if (s0.kind === "CompoundLiteralExpr") {
      const init = (s0.inner ?? [])[0];
      steps.push(...initialize(d, t, init).map((x) => `(${x.replace(/;$/, "")})`));
    } else steps.push(...copyFrom(d, t, s0));
    return `(${steps.join(", ")}, undefined)`;
  };
  /** Bytes of `size` copied from `from` to `to` (8 at a time, then 1): expression steps. */
  const copyBytes = (to: string, from: string, size: number): string[] => {
    const steps: string[] = [];
    for (let o = 0; o + 8 <= size; o += 8)
      steps.push(`__ykStore64((${to} + ${o}), __ykLoad64((${from} + ${o})))`);
    for (let o = size - (size % 8); o < size; o++)
      steps.push(`__ykStore8((${to} + ${o}), __ykLoad8((${from} + ${o})))`);
    return steps;
  };
  /**
   * A record value (an lvalue, or a call that returns one: the address of a fresh copy, freed once
   * copied) copied to `to`: expression steps.
   */
  const copyFrom = (to: string, t: CType, src: ClangNode): string[] => {
    const s0 = stripCasts(src);
    const from = temp({ k: "f64" });
    if (s0.kind === "CallExpr")
      return [`(${from} = ${expr(s0)})`, ...copyBytes(to, from, sizeOf(t)), `__ykFree(${from})`];
    const sp = place(s0);
    if (sp.k !== "mem") throw new RaiseCError("a record copied from one not in memory");
    return [`(${from} = ${sp.addr})`, ...copyBytes(to, from, sizeOf(t))];
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
      // A record initialized from another (a copy, or a call returning one): its bytes.
      if (s !== undefined && s.kind !== "InitListExpr")
        return [`(${copyFrom(addr, t, s).join(", ")});`];
      const items = s === undefined ? [] : initItems(s);
      const out: string[] = [];
      // A union's initializer is the member clang names (else its first).
      const member = (s as { field?: { name?: string } } | undefined)?.field?.name;
      if (/^union /.test(t.name) && member !== undefined && l.fields.has(member)) {
        const f = l.fields.get(member) as { offset: number; type: string };
        return initialize(
          f.offset === 0 ? addr : `(${addr} + ${f.offset})`,
          parseType(f.type),
          items[0],
        );
      }
      let i = 0;
      for (const [, f] of l.fields) {
        const ft = parseType(f.type);
        if (f.bit !== undefined) {
          const item = items[i];
          const v =
            item === undefined || item.kind === "ImplicitValueInitExpr" ? zeroOf(ft) : expr(item);
          out.push(`${write(bitsPlace(addr, f.bit, ft), v)};`);
        } else
          out.push(...initialize(f.offset === 0 ? addr : `(${addr} + ${f.offset})`, ft, items[i]));
        i++;
        if (/^union /.test(t.name)) break; // a union's initializer is its first member's
      }
      return out;
    }
    return [`${storeAt(addr, t, init === undefined ? zeroOf(t) : expr(init))};`];
  };

  const lines: string[] = [];
  const continueLabels = new Set<string>();
  const forwardLabels = new Map<string, string>(); // label decl id -> its block's JavaScript label
  const enterLabels = new Map<string, string>(); // label decl id -> the flag a goto into it sets
  // A label that starts a later if's then branch (`if (c) { L: .. }`), reached by forward gotos:
  // label decl id -> the flag the goto sets; the if is then taken as if its condition held.
  const enterIf = new Map<string, string>();
  /** The label that starts an if's then branch. */
  const ifEntry = (c: ClangNode): ClangNode | undefined => {
    if (c.kind !== "IfStmt") return undefined;
    const then = (c.inner ?? [])[1];
    const first = then?.kind === "CompoundStmt" ? (then.inner ?? [])[0] : then;
    return first?.kind === "LabelStmt" ? first : undefined;
  };
  // A union of 64-bit members (`union { double f; uint64_t i; }`) not in memory: one 64-bit word,
  // its members views of it through the float64-bits leaf. By the variable's id: its members.
  const puns = new Map<string, Map<string, CType>>();
  /** Whether a variable is used as a whole record (`ut = ux`): it is then memory, not a word. */
  const wholeRecord = (id: string): boolean => {
    const walk = (n: ClangNode): boolean => {
      const ref = stripCasts(n);
      if (ref.kind === "DeclRefExpr" && ref.referencedDecl?.id === id && n.kind !== "MemberExpr")
        return true;
      if (n.kind === "MemberExpr") return false;
      return (n.inner ?? []).some(walk);
    };
    return walk(b0);
  };
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
  /**
   * The switch being dispatched (see SwitchStmt): its target variable, its jump variable, its
   * targets' numbers, and how many loops or switches of its body the statement is inside.
   */
  let dispatch:
    | {
        sw: string;
        j: string;
        targets: Map<ClangNode, number>;
        depth: number;
        continues: boolean;
        /** The jumps out of the body (gotos), each made after it when the jump code is 3 + its index. */
        exits: string[];
      }
    | undefined;
  const stmt = (s: ClangNode): void => {
    if (
      dispatch !== undefined &&
      ["ForStmt", "WhileStmt", "DoStmt", "SwitchStmt"].includes(s.kind)
    ) {
      const d = dispatch;
      d.depth++;
      try {
        stmtOf(s);
      } finally {
        d.depth--;
      }
      return;
    }
    if (dispatch !== undefined && dispatch.depth === 0 && s.kind === "ReturnStmt") {
      // A return out of a dispatched switch's body: made after the body, as a goto out is (the
      // value is the same there: nothing runs between).
      const d = dispatch;
      const at = lines.length;
      stmtOf(s);
      const jump = lines.splice(at).join("\n");
      const code = d.exits.push(jump) - 1;
      push(`${d.sw} = -1; ${d.j} = ${code + 3};`);
      return;
    }
    stmtOf(s);
  };
  /** Whether `s` has a jump of a dispatched switch's body (not of a loop or switch inside it). */
  const bodyJump = (s: ClangNode): boolean => {
    if (["BreakStmt", "ContinueStmt", "GotoStmt", "ReturnStmt"].includes(s.kind)) return true;
    if (["ForStmt", "WhileStmt", "DoStmt", "SwitchStmt"].includes(s.kind)) return false;
    return (s.inner ?? []).some(bodyJump);
  };
  /** A dispatched statement: run while the target is 0 (reached), entered toward a target in it. */
  const guarded = (s: ClangNode): void => {
    const d = dispatch as NonNullable<typeof dispatch>;
    const inside = (n: ClangNode): number[] => [
      ...(d.targets.has(n) ? [d.targets.get(n) as number] : []),
      ...(n.inner ?? []).flatMap(inside),
    ];
    const here = inside(s);
    const jumps = ["BreakStmt", "ContinueStmt", "GotoStmt", "ReturnStmt"].includes(s.kind);
    if (here.length === 0 && (jumps || !bodyJump(s))) {
      if (s.kind === "NullStmt") return;
      if (s.kind === "DeclStmt")
        throw new RaiseCError("a declaration in a switch body entered at a nested case");
      push(`if (${d.sw} === 0) {`);
      stmt(s);
      push("}");
      return;
    }
    const k = d.targets.get(s);
    if (k !== undefined || s.kind === "LabelStmt") {
      // Reached (a goto's target in this pass, too): the goto's jump code is spent.
      if (k !== undefined) push(`if (${d.sw} === ${k}) { ${d.sw} = 0; ${d.j} = 0; }`);
      const kids = s.inner ?? [];
      guarded(
        (s.kind === "DefaultStmt" || s.kind === "LabelStmt"
          ? kids[0]
          : kids[kids.length - 1]) as ClangNode,
      );
      return;
    }
    if (s.kind === "CompoundStmt") {
      push("{");
      for (const c of s.inner ?? []) guarded(c);
      push("}");
      return;
    }
    if (s.kind === "IfStmt") {
      const [c, then, otherwise] = (s.inner ?? []) as [ClangNode, ClangNode, ClangNode?];
      const into = inside(then).map((t) => `${d.sw} === ${t}`);
      push(
        `if (${d.sw} === 0 ? ${cond(c)} : ${into.length > 0 ? `(${into.join(" || ")})` : "false"}) {`,
      );
      guarded(then);
      if (otherwise !== undefined) {
        push("} else {");
        guarded(otherwise);
      }
      push("}");
      return;
    }
    throw new RaiseCError(`a case label, goto target or jump inside a ${s.kind} of a switch body`);
  };
  const stmtOf = (s: ClangNode): void => {
    const kids = s.inner ?? [];
    switch (s.kind) {
      case "CompoundStmt": {
        push("{");
        // A forward goto to a label of this block, from inside a statement before it: the
        // statements from that one up to the label are a labelled block the goto breaks out of,
        // written `L: do { .. } while (false)` (the lifter's form of a block left by a jump).
        // Blocks that would overlap are widened to nest (starting earlier changes nothing).
        const forward = new Map<number, { label: string; start: number; js: string }>();
        const viaIf = new Set<number>();
        kids.forEach((c0, j) => {
          const c = c0.kind === "LabelStmt" ? c0 : ifEntry(c0);
          if (c === undefined) return;
          const label = (c as { declId?: string }).declId ?? "";
          const start = kids.slice(0, j).findIndex((k) => gotosTo(k, label));
          if (start < 0) return;
          if (c !== c0) viaIf.add(j);
          const name = ident((c as { name?: string }).name ?? "L");
          forward.set(j, { label, start, js: `${name}_${forwardLabels.size + forward.size}` });
        });
        for (let changed = true; changed; ) {
          changed = false;
          for (const [j, a] of forward)
            for (const [k, b] of forward)
              if (k < j && b.start < a.start && a.start < k) {
                a.start = b.start;
                changed = true;
              }
        }
        const opensAt = (i: number): [number, { label: string; start: number; js: string }][] =>
          [...forward].filter(([, f]) => f.start === i).sort(([a], [b]) => b - a);
        for (let i = 0; i < kids.length; i++) {
          // The block a label ends closes before any block that starts at the label opens.
          if (forward.has(i)) push("} while (false);");
          for (const [j, f] of opensAt(i)) {
            // An unlabelled break or continue of an enclosing loop would end the block instead.
            if (kids.slice(i, j).some((k) => escapingJump(k)))
              throw new RaiseCError("a break or continue of an outer loop inside a goto's block");
            forwardLabels.set(f.label, f.js);
            if (viaIf.has(j)) {
              const flag = `__enter${temps++}`;
              top.push(`let ${flag} = false;`);
              push(`${flag} = false;`);
              enterIf.set(f.label, flag);
            }
            push(`${f.js}: do {`);
          }
          const c = kids[i] as ClangNode;
          if (c.kind !== "LabelStmt") {
            stmt(c);
            continue;
          }
          // A backward goto to a label of this block, from a statement after it and in no loop or
          // switch of its own: the statements from the label through that one are a loop the
          // goto continues, left at its end.
          const label = (c as { declId?: string }).declId ?? "";
          let last = i;
          for (let j = i; j < kids.length; j++) if (gotosTo(kids[j] as ClangNode, label)) last = j;
          if (last === i && !gotosTo(c, label)) {
            stmt((c.inner as ClangNode[])[0] as ClangNode);
            continue;
          }
          if (forward.has(i))
            throw new RaiseCError("a label reached by gotos both forward and back");
          for (const [j, f] of forward)
            if ((f.start > i && f.start <= last) || (j > i && j <= last && f.start < i))
              throw new RaiseCError("a backward goto's loop across a forward goto's block");
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
        if (dispatch !== undefined) {
          const d = dispatch;
          const k = [...d.targets].find(([n]) => (n as { declId?: string }).declId === target)?.[1];
          if (k !== undefined) {
            if (d.depth > 0)
              throw new RaiseCError("a goto into a switch body from a loop inside it");
            push(`${d.sw} = ${k}; ${d.j} = 2;`);
            return;
          }
        }
        const enter = enterLabels.get(target);
        if (enter !== undefined) {
          push(`${enter} = true;`);
          return;
        }
        const fwd = forwardLabels.get(target);
        if (fwd === undefined && !continueLabels.has(target))
          throw new RaiseCError("a goto into a block, or out of it");
        const into = enterIf.get(target);
        const jump =
          fwd !== undefined
            ? into !== undefined
              ? `{ ${into} = true; break ${fwd}; }`
              : `break ${fwd};`
            : "continue;";
        // Out of a dispatched switch's body: a jump code, the jump made after the body.
        if (dispatch !== undefined && dispatch.depth === 0) {
          const d = dispatch;
          let code = d.exits.indexOf(jump);
          if (code < 0) code = d.exits.push(jump) - 1;
          push(`${d.sw} = -1; ${d.j} = ${code + 3};`);
          return;
        }
        push(jump);
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
          const t = ctype(d.type);
          if (
            d.storageClass === "static" &&
            !/\bconst\b/.test(d.type?.qualType ?? "") &&
            (written.has(d.id ?? "") || inMemory.has(d.id ?? ""))
          ) {
            // A static local that is written: module state, in static memory (its initializer is
            // its definition's, applied once).
            const key = unitStatic?.(d, fn.name);
            if (key === undefined)
              throw new RaiseCError(`the static variable "${d.name}" is state`);
            vars.set(d.id ?? "", t);
            mems.set(d.id ?? "", { k: "mem", addr: `__ykStatic(${JSON.stringify(key)})`, t });
            continue;
          }
          vars.set(d.id ?? "", t);
          const init = initOf(d);
          if (
            t.k === "rec" &&
            lastUnion !== undefined &&
            /^union\b/.test(t.name) &&
            !inMemory.has(d.id ?? "") &&
            init === undefined &&
            !wholeRecord(d.id ?? "")
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
      case "ReturnStmt": {
        const v = kids[0];
        if (v !== undefined && result.k === "rec") {
          // A record returned: a fresh copy's address (the caller copies it and frees it).
          const out = temp({ k: "f64" });
          const s0 = stripCasts(v);
          const lit = s0.kind === "CompoundLiteralExpr" ? (s0.inner ?? [])[0] : s0;
          const fill =
            s0.kind === "InitListExpr" || s0.kind === "CompoundLiteralExpr"
              ? initialize(out, result, lit).map((x) => `(${x.replace(/;$/, "")})`)
              : copyFrom(out, result, s0);
          returnLine(
            `((${out} = __ykAlloc(${sizeOf(result)}, ${alignOf(result)})), ${fill.join(", ")}, ${out})`,
          );
          return;
        }
        returnLine(v !== undefined ? expr(v) : undefined);
        return;
      }
      case "IfStmt": {
        const [c, then, otherwise] = kids as [ClangNode, ClangNode, ClangNode?];
        // A goto from the else branch into the start of the then branch (`if (a) { L: .. } else
        // { .. goto L; }`), each the last thing its branch does: the condition, or the goto, sets
        // a flag, and the then branch runs when it is set.
        const first = then.kind === "CompoundStmt" ? (then.inner ?? [])[0] : undefined;
        const entry =
          first?.kind === "LabelStmt" ? ((first as { declId?: string }).declId ?? "") : "";
        if (
          entry !== "" &&
          otherwise !== undefined &&
          gotosTo(otherwise, entry) &&
          !gotosTo(then, entry) &&
          gotosInTail(otherwise, entry)
        ) {
          const flag = `__enter${temps++}`;
          top.push(`let ${flag} = false;`);
          push(`${flag} = false;`);
          push(`if (${cond(c)}) {`);
          push(`${flag} = true;`);
          push("} else {");
          enterLabels.set(entry, flag);
          stmt(otherwise);
          enterLabels.delete(entry);
          push("}");
          push(`if (${flag}) {`);
          stmt(then);
          push("}");
          return;
        }
        const entered = enterIf.get((ifEntry(s) as { declId?: string } | undefined)?.declId ?? "");
        push(`if (${entered !== undefined ? `${entered} || ` : ""}${cond(c)}) {`);
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
        // Out of a dispatched switch's body: what follows is skipped.
        if (dispatch !== undefined && dispatch.depth === 0) push(`${dispatch.sw} = -1;`);
        else push("break;");
        return;
      case "ContinueStmt":
        if (dispatch !== undefined && dispatch.depth === 0) {
          dispatch.continues = true;
          push(`${dispatch.sw} = -1; ${dispatch.j} = 1;`);
          return;
        }
        push("continue;");
        return;
      case "SwitchStmt": {
        const [c, b] = kids as [ClangNode, ClangNode];
        // Case labels inside the body's statements (`if (0) { case 'o': .. }`), or gotos to
        // labels of the body: the case is a number, and the body runs once, each statement
        // when the number is 0 and entered toward its target otherwise. A jump of the body sets
        // the number to -1, which skips the rest (no JavaScript jump, which the lifter would
        // have to carry through every statement after it): a break, a continue of the loop
        // outside, a goto out and a return also set a jump code, made after the body; a goto to
        // a label of the body sets the number to the label's, and the body runs again.
        const targets = dispatchTargets(b);
        if (targets.length > 0) {
          const outer = dispatch;
          if (outer !== undefined) throw new RaiseCError("a dispatched switch inside another");
          const sw = `__sw${temps++}`;
          const j = `__j${temps++}`;
          top.push(`let ${sw} = -1;`, `let ${j} = 0;`);
          const t = typeOf(c);
          push(`${sw} = -1;`);
          push(`switch (${expr(c)}) {`);
          targets.forEach((n, i) => {
            if (n.kind === "CaseStmt") {
              const v = (n.inner ?? [])[0] as ClangNode;
              if ((n.inner ?? []).length !== 2) throw new RaiseCError("a case range");
              push(`case ${convert(expr(v), typeOf(v), t)}: ${sw} = ${i + 1}; break;`);
            } else if (n.kind === "DefaultStmt") push(`default: ${sw} = ${i + 1}; break;`);
          });
          push("}");
          const again = targets.some((n) => n.kind === "LabelStmt");
          if (again) push("while (true) {");
          push(`${j} = 0;`);
          const d = {
            sw,
            j,
            targets: new Map(targets.map((n, i) => [n, i + 1] as const)),
            depth: 0,
            continues: false,
            exits: [] as string[],
          };
          dispatch = d;
          try {
            guarded(b);
          } finally {
            dispatch = outer;
          }
          if (again) {
            push(`if (${j} !== 2) break;`);
            push("}");
          }
          if (d.continues) push(`if (${j} === 1) continue;`);
          d.exits.forEach((jump, i) => push(`if (${j} === ${i + 3}) ${jump}`));
          return;
        }
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

  const sig = [
    ...params.map((p) => `${declName(p)}: ${tsType(ctype(p.type))}`),
    ...(variadic ? ["__va: number"] : []),
  ].join(", ");
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
  t.k === "f64" ||
  t.k === "f32" ||
  t.k === "i32" ||
  t.k === "u32" ||
  narrow(t) ||
  t.k === "ptr" ||
  t.k === "rec"
    ? "number"
    : wide(t)
      ? "bigint"
      : t.k === "bool"
        ? "boolean"
        : t.k === "arr"
          ? `${tsType(t.of)}[]`
          : "void";

/**
 * A variadic function type's number of named parameters (`int (const char *, ...)` has 1), or
 * undefined when the type is not variadic.
 */
function variadicParams(type: string): number | undefined {
  const m = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(type.replace(/\s*noexcept\b.*$/, ""));
  if (m === null || !/\.\.\.\s*$/.test(m[1] as string)) return undefined;
  let depth = 0;
  let count = 0;
  for (const c of (m[1] as string).replace(/,?\s*\.\.\.\s*$/, "")) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) count++;
  }
  return (m[1] as string).replace(/,?\s*\.\.\.\s*$/, "").trim() === "" ? 0 : count + 1;
}

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

/**
 * Whether every goto to `label` inside `s` is the last thing `s` does when it runs: the last
 * statement of each block it is in, through ifs, never inside a loop or switch.
 */
function gotosInTail(s: ClangNode, label: string): boolean {
  if (s.kind === "GotoStmt") return true;
  if (!gotosTo(s, label)) return true;
  const kids = s.inner ?? [];
  switch (s.kind) {
    case "CompoundStmt":
      return (
        kids.slice(0, -1).every((k) => !gotosTo(k, label)) &&
        gotosInTail(kids[kids.length - 1] as ClangNode, label)
      );
    case "IfStmt":
      return (
        !gotosTo(kids[0] as ClangNode, label) && kids.slice(1).every((k) => gotosInTail(k, label))
      );
    case "LabelStmt":
      return gotosInTail(kids[0] as ClangNode, label);
    default:
      return false;
  }
}

/**
 * The places a switch's dispatch enters its body (SwitchStmt), in order, when a case label is
 * inside a statement of the body, a goto in the body names a label of it, or one leaves it: the case labels
 * (not those of a switch inside), and the labels gotos in the body name (not inside a loop or
 * switch of it). None when every case label is one of the body's own statements.
 */
function dispatchTargets(body: ClangNode): ClangNode[] {
  const gotos = new Set<string>();
  const collect = (s: ClangNode): void => {
    if (s.kind === "GotoStmt")
      gotos.add((s as { targetLabelDeclId?: string }).targetLabelDeclId ?? "");
    for (const k of s.inner ?? []) collect(k);
  };
  collect(body);
  const out: ClangNode[] = [];
  let nested = false;
  const walk = (s: ClangNode, inLoop: boolean, top: boolean): void => {
    if (s.kind === "SwitchStmt") return;
    const isCase = s.kind === "CaseStmt" || s.kind === "DefaultStmt";
    if (isCase) {
      out.push(s);
      if (!top) nested = true;
    }
    if (s.kind === "LabelStmt" && !inLoop && gotos.has((s as { declId?: string }).declId ?? "")) {
      out.push(s);
      nested = true;
    }
    const loop = ["ForStmt", "WhileStmt", "DoStmt"].includes(s.kind);
    const kids = s.inner ?? [];
    kids.forEach((k, i) =>
      walk(k, inLoop || loop, top && (isCase || s.kind === "LabelStmt") && i === kids.length - 1),
    );
  };
  if (body.kind === "CompoundStmt") for (const k of body.inner ?? []) walk(k, false, true);
  else walk(body, false, false);
  // A goto out of the body (not from a loop or switch inside it) is a jump the lifter cannot carry
  // out of a switch: dispatched too, the goto is a jump code made after it.
  const labels = new Set<string>();
  const ownLabels = (s: ClangNode): void => {
    if (s.kind === "LabelStmt") labels.add((s as { declId?: string }).declId ?? "");
    for (const k of s.inner ?? []) ownLabels(k);
  };
  ownLabels(body);
  const out_ = (s: ClangNode): boolean => {
    if (["ForStmt", "WhileStmt", "DoStmt", "SwitchStmt"].includes(s.kind)) return false;
    if (s.kind === "GotoStmt")
      return !labels.has((s as { targetLabelDeclId?: string }).targetLabelDeclId ?? "");
    return (s.inner ?? []).some(out_);
  };
  if (body.kind === "CompoundStmt" && (body.inner ?? []).some(out_)) nested = true;
  return nested ? out : [];
}

/** Whether `s` has a break or continue that leaves it (not one of a loop or switch inside it). */
function escapingJump(s: ClangNode, inSwitch = false): boolean {
  if (s.kind === "ContinueStmt") return true;
  if (s.kind === "BreakStmt") return !inSwitch;
  if (["ForStmt", "WhileStmt", "DoStmt"].includes(s.kind)) return false;
  const sw = inSwitch || s.kind === "SwitchStmt";
  return (s.inner ?? []).some((c) => escapingJump(c, sw));
}

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
  /**
   * The variables with static storage the atoms use as module state, by key: a global by its name
   * (external linkage, shared by every unit), a file-scope `static` as `unit:name`, a static local
   * as `unit:function.name`. Only the unit that defines one has its definition.
   */
  readonly statics: ReadonlyMap<string, StaticDef>;
  /** Every static key the atoms reference (defined here or in another unit). */
  readonly staticRefs: ReadonlySet<string>;
  /** The unit's source file. */
  readonly file: string;
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
  /** The unit's name in the keys of its internal statics (by default, its file's base name). */
  unit: string = file.split("/").pop() ?? file,
  /** Globals to define as statics even if no function here uses them (another unit's state). */
  defineStatics: readonly string[] = [],
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
    // A static function's name is its unit's alone (strtol.c's strtox is not strtod.c's): its key
    // carries the unit's.
    const base =
      decl.kind === "FunctionDecl" && decl.storageClass === "static"
        ? `${ident(c.name)}__${(unit.split("/").pop() ?? unit).replace(/\.\w+$/, "").replace(/\W/g, "_")}`
        : ident(c.name);
    let key = base;
    for (let n = 2; found.has(key); n++) key = `${base}_${n}`;
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
        initOf(n) !== undefined
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
  // The whole unit's declarations, read once, when an enumeration constant or offsetof is used.
  let whole: ClangNode | undefined;
  const wholeUnit = (): ClangNode => {
    whole ??= JSON.parse(
      execFileSync(clang, [...args, "-fsyntax-only", "-Xclang", "-ast-dump=json", file], {
        encoding: "utf8",
        maxBuffer: 1 << 30,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ) as ClangNode;
    return whole;
  };
  // offsetof: clang's -ast-print writes each one's member, in the order of the unit's nodes.
  let offsets: Map<string, [string, string]> | undefined;
  const offsetOf = (e: ClangNode): number | undefined => {
    if (offsets === undefined) {
      const printed = execFileSync(
        clang,
        [...args, "-fsyntax-only", "-Xclang", "-ast-print", file],
        {
          encoding: "utf8",
          maxBuffer: 1 << 30,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const written = [...printed.matchAll(/__builtin_offsetof\(([^,()]+),([^()]*)\)/g)].map(
        (m) => [m[1] as string, m[2] as string] as [string, string],
      );
      const nodes: ClangNode[] = [];
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) for (const x of v) walk(x);
        else if (v !== null && typeof v === "object") {
          if ((v as ClangNode).kind === "OffsetOfExpr") nodes.push(v as ClangNode);
          for (const x of Object.values(v)) walk(x);
        }
      };
      walk(wholeUnit());
      offsets = new Map();
      if (nodes.length === written.length)
        nodes.forEach((n, i) => offsets?.set(rangeKey(n), written[i] as [string, string]));
    }
    const d = offsets.get(rangeKey(e));
    return d === undefined ? undefined : offsetOfDesignator(...d);
  };
  // Enumeration constants, from the whole unit's declarations.
  let enums: Map<string, bigint> | undefined;
  const enumValue = (name: string): bigint | undefined => {
    if (enums === undefined) {
      const values = new Map<string, bigint>();
      const walk = (n: ClangNode): void => {
        if (n.kind === "EnumDecl") {
          let next = 0n;
          for (const c of n.inner ?? []) {
            if (c.kind !== "EnumConstantDecl") continue;
            const v = (c.inner ?? []).find((k) => k.kind === "ConstantExpr")?.value;
            if (v !== undefined) next = BigInt(v);
            values.set(c.name ?? "", next);
            next += 1n;
          }
        }
        for (const k of n.inner ?? []) walk(k);
      };
      walk(wholeUnit());
      enums = values;
    }
    return enums.get(name);
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
      execFileSync(
        clang,
        [...args, "-fsyntax-only", "-Xclang", "-fdump-record-layouts-complete", file],
        {
          encoding: "utf8",
          maxBuffer: 1 << 30,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ),
    );
    return layouts.get(recordKey(name));
  };
  // Module state: each static the atoms use, keyed and defined (when this unit defines it).
  const statics = new Map<string, StaticDef>();
  const staticKeys = new Map<string, string | undefined>(); // decl id (or name) -> key
  const definitionOf = (name: string, type: string): ClangNode | undefined => {
    let decl: ClangNode | undefined;
    let tentative: ClangNode | undefined;
    const walk = (n: ClangNode, inFunction: boolean): void => {
      if (
        n.kind === "VarDecl" &&
        !inFunction &&
        n.name === name &&
        (type === "" ||
          normType(n.type?.qualType ?? "").replace(/\[\d*\]/g, "[]") ===
            type.replace(/\[\d*\]/g, "[]")) &&
        n.storageClass !== "extern"
      ) {
        if (initOf(n) !== undefined) decl ??= n;
        else tentative ??= n;
      }
      const fn = n.kind === "FunctionDecl" || n.kind === "CXXMethodDecl";
      for (const k of n.inner ?? []) walk(k, inFunction || fn);
    };
    for (const n of dumpOf(name)) walk(n, false);
    return decl ?? tentative;
  };
  const staticHook = (d: ClangNode, fnName?: string): string | undefined => {
    const id = fnName === undefined ? `g:${d.name}` : (d.id ?? "");
    if (staticKeys.has(id)) return staticKeys.get(id);
    staticKeys.set(id, undefined); // a cycle through initializers resolves to the key set below
    let key: string;
    let decl: ClangNode | undefined;
    if (fnName !== undefined) {
      key = `${unit}:${fnName}.${d.name}`;
      decl = d;
    } else {
      decl = definitionOf(d.name ?? "", normType(d.type?.qualType ?? ""));
      key = decl?.storageClass === "static" ? `${unit}:${d.name}` : (d.name ?? "");
    }
    staticKeys.set(id, key);
    if (decl !== undefined) {
      try {
        statics.set(
          key,
          staticDefinition(decl, {
            staticKey: (g) => staticHook(g),
            fnKey: (f) =>
              resolve({
                name: f.name ?? "",
                kind: f.kind,
                type: normType(f.type?.qualType ?? ""),
              }) ??
              f.name ??
              "",
          }),
        );
      } catch (e) {
        throw new RaiseCError(
          `the static "${d.name}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return key;
  };
  // Statics another unit uses and this one defines (first: the functions their initializers
  // name in this unit are then raised with the rest).
  if (defineStatics.length > 0) {
    const saved = [unitTypedef, unitLayout, unitLongDouble64, unitEnumValue, unitOffsetOf] as const;
    unitTypedef = typedef;
    unitLayout = layout;
    unitLongDouble64 = args.includes("-mlong-double-64");
    unitEnumValue = enumValue;
    unitOffsetOf = offsetOf;
    try {
      for (const name of defineStatics)
        staticHook({ kind: "VarDecl", name, type: { qualType: "" } } as ClangNode);
    } finally {
      [unitTypedef, unitLayout, unitLongDouble64, unitEnumValue, unitOffsetOf] = saved;
    }
  }
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
          source: raiseCFunction(fn, resolve, externals, resolveGlobal, {
            typedef,
            layout,
            static: staticHook,
            longDouble64: args.includes("-mlong-double-64"),
            enumValue,
            offsetOf,
          }),
          externals: [...externals],
        });
      } catch (e) {
        refused.set(key, e instanceof Error ? e.message : String(e));
      }
    }
  }
  return {
    file,
    atoms,
    refused,
    statics,
    staticRefs: new Set([...staticKeys.values()].filter((k): k is string => k !== undefined)),
  };
}

/**
 * A static's definition: its size and alignment, and its initializer evaluated to items (C's
 * static initializers are constant: numbers, addresses of statics and functions, string
 * literals). A static with no initializer is zero.
 */
function staticDefinition(
  decl: ClangNode,
  hooks: {
    readonly staticKey: (d: ClangNode) => string | undefined;
    readonly fnKey: (d: ClangNode) => string;
  },
): StaticDef {
  const t = ctype(decl.type);
  const init: StaticItem[] = [];
  const typeOf = (e: ClangNode): CType => ctype(e.type);
  /** A constant scalar: a number or bigint, or an address (a static, a function, a string). */
  type Const =
    | { k: "v"; v: number | bigint }
    | { k: "static"; key: string; addend: number }
    | { k: "fn"; key: string }
    | { k: "data"; kind: string; values: number[] };
  const scalar = (e: ClangNode): Const => {
    const kids = e.inner ?? [];
    const k0 = kids[0] as ClangNode;
    switch (e.kind) {
      case "ParenExpr":
      case "ConstantExpr":
        return scalar(k0);
      case "IntegerLiteral":
        return { k: "v", v: BigInt(e.value ?? "0") };
      case "DeclRefExpr": {
        const d = e.referencedDecl as ClangNode;
        const v = d.kind === "EnumConstantDecl" ? unitEnumValue(d.name ?? "") : undefined;
        if (v === undefined) break;
        return { k: "v", v };
      }
      case "CharacterLiteral":
        return { k: "v", v: BigInt(Number(e.value)) };
      case "FloatingLiteral":
        return { k: "v", v: Number(e.value) };
      case "UnaryExprOrTypeTraitExpr": {
        const arg = (e as { argType?: { qualType: string; desugaredQualType?: string } }).argType;
        const at = arg !== undefined ? ctype(arg) : typeOf(k0);
        return { k: "v", v: BigInt(e.name === "sizeof" ? sizeOf(at) : alignOf(at)) };
      }
      case "OffsetOfExpr": {
        const v = unitOffsetOf(e);
        if (v === undefined) throw new RaiseCError("an offsetof whose member is not known");
        return { k: "v", v: BigInt(v) };
      }
      case "ImplicitCastExpr":
      case "CStyleCastExpr": {
        const ck = e.castKind ?? "";
        if (ck === "ArrayToPointerDecay" || ck === "FunctionToPointerDecay") return address(k0);
        const v = scalar(k0);
        if (v.k !== "v") return v; // an address through a pointer cast
        const to = typeOf(e);
        if (ck === "NullToPointer") return { k: "v", v: 0n };
        if (to.k === "f64" || to.k === "f32") return { k: "v", v: Number(v.v) };
        if (typeof v.v === "number") return { k: "v", v: BigInt(Math.trunc(v.v)) };
        return { k: "v", v: v.v };
      }
      case "UnaryOperator": {
        if (e.opcode === "&") return address(k0);
        const v = scalar(k0);
        if (v.k !== "v") throw new RaiseCError(`"${e.opcode}" of an address`);
        if (e.opcode === "-") return { k: "v", v: typeof v.v === "bigint" ? -v.v : -v.v };
        if (e.opcode === "~" && typeof v.v === "bigint") return { k: "v", v: ~v.v };
        if (e.opcode === "+") return v;
        if (e.opcode === "!") return { k: "v", v: v.v ? 0n : 1n };
        break;
      }
      case "BinaryOperator": {
        const a = scalar(k0);
        const b = scalar(kids[1] as ClangNode);
        const op = e.opcode ?? "";
        // An address plus or minus a constant (`buf + UNGET`).
        if ((a.k === "static" || a.k === "data") && b.k === "v" && (op === "+" || op === "-")) {
          const tt = typeOf(k0);
          const size = tt.k === "ptr" && tt.to.k !== "void" ? sizeOf(tt.to) : 1;
          const n = Number(b.v) * size * (op === "-" ? -1 : 1);
          if (a.k === "static") return { ...a, addend: a.addend + n };
          throw new RaiseCError("an offset into a string literal");
        }
        if (a.k !== "v" || b.k !== "v") throw new RaiseCError(`"${op}" of addresses`);
        if (typeof a.v === "number" || typeof b.v === "number") {
          const x = Number(a.v);
          const y = Number(b.v);
          const r: Record<string, number> = { "+": x + y, "-": x - y, "*": x * y, "/": x / y };
          if (r[op] === undefined) throw new RaiseCError(`"${op}" on doubles in an initializer`);
          return { k: "v", v: r[op] as number };
        }
        const x = a.v;
        const y = b.v;
        const r: Record<string, () => bigint> = {
          "+": () => x + y,
          "-": () => x - y,
          "*": () => x * y,
          "/": () => x / y,
          "%": () => x % y,
          "<<": () => x << y,
          ">>": () => x >> y,
          "&": () => x & y,
          "|": () => x | y,
          "^": () => x ^ y,
        };
        if (r[op] === undefined) throw new RaiseCError(`"${op}" in an initializer`);
        return { k: "v", v: (r[op] as () => bigint)() };
      }
    }
    throw new RaiseCError(`the initializer ${e.kind}`);
  };
  const address = (e: ClangNode): Const => {
    const n = stripParens(e);
    if (n.kind === "StringLiteral")
      return { k: "data", kind: "u8", values: cStringBytes(n.value ?? '""') };
    if (n.kind === "DeclRefExpr") {
      const d = n.referencedDecl as ClangNode;
      if (d.kind === "FunctionDecl") return { k: "fn", key: hooks.fnKey(d) };
      const key = hooks.staticKey(d);
      if (key !== undefined) return { k: "static", key, addend: 0 };
    }
    if (n.kind === "ArraySubscriptExpr") {
      const base = address(stripCasts((n.inner ?? [])[0] as ClangNode));
      const i = scalar((n.inner ?? [])[1] as ClangNode);
      if (base.k === "static" && i.k === "v")
        return { ...base, addend: base.addend + Number(i.v) * sizeOf(typeOf(n)) };
    }
    if (n.kind === "MemberExpr" && (n as { isArrow?: boolean }).isArrow !== true) {
      const base = address((n.inner ?? [])[0] as ClangNode);
      const field = layoutOf(typeOf((n.inner ?? [])[0] as ClangNode)).fields.get(n.name ?? "");
      if (base.k === "static" && field !== undefined)
        return { ...base, addend: base.addend + field.offset };
    }
    throw new RaiseCError(`the address of ${n.kind} in an initializer`);
  };
  const put = (e: ClangNode | undefined, ty: CType, offset: number): void => {
    const n = e === undefined || e.kind === "ImplicitValueInitExpr" ? undefined : stripParens(e);
    if (ty.k === "arr") {
      const count = ty.size ?? 0;
      const size = sizeOf(ty.of);
      if (n?.kind === "StringLiteral") {
        cStringBytes(n.value ?? '""')
          .slice(0, count)
          .forEach((b, i) => {
            if (b !== 0) init.push({ offset: offset + i, kind: "u8", value: b });
          });
        return;
      }
      const items = n === undefined ? [] : initItems(n);
      items.forEach((it, i) => put(it, ty.of, offset + i * size));
      return;
    }
    if (ty.k === "rec") {
      const l = layoutOf(ty);
      const items = n === undefined ? [] : initItems(n);
      let i = 0;
      for (const [name, f] of l.fields) {
        const item = items[i];
        if (f.bit !== undefined) {
          if (item !== undefined && item.kind !== "ImplicitValueInitExpr") {
            const c = scalar(item);
            if (c.k !== "v" || (c.v !== 0n && c.v !== 0))
              throw new RaiseCError(`an initializer of the bit-field "${name}"`);
          }
        } else put(item, parseType(f.type), offset + f.offset);
        i++;
        if (/^union /.test(ty.name)) break;
      }
      return;
    }
    if (n === undefined) return; // zero
    const c = scalar(n);
    if (c.k === "v") {
      if (c.v === 0n || c.v === 0) return;
      const kind = dataKind(ty);
      const v =
        ty.k === "f64" || ty.k === "f32"
          ? Number(c.v)
          : wide(ty) || ty.k === "ptr"
            ? BigInt.asUintN(64, BigInt(c.v))
            : Number(BigInt.asIntN(32, BigInt(c.v)));
      init.push({ offset, kind: kind === "u64" && ty.k === "ptr" ? "u64" : kind, value: v });
    } else if (c.k === "static") init.push({ offset, static: c.key, addend: c.addend });
    else if (c.k === "fn") init.push({ offset, fn: c.key });
    else init.push({ offset, data: { kind: c.kind, values: c.values } });
  };
  put(initOf(decl), t, 0);
  return { size: sizeOf(t), align: alignOf(t), init };
}

/** A record's name as a key: C++ scopes dropped (`union P::(unnamed at f.c:1:40)` and the C spelling meet). */
// An unnamed record is named by where it is: the layout dump writes `(unnamed at rel/f.h:17:2)`,
// a type `(unnamed struct at /abs/f.h:17:2)`; both are keyed `(unnamed at f.h:17:2)`.
const recordKey = (name: string): string =>
  normType(
    name
      .replace(/\b[A-Za-z_]\w*::/g, "")
      .replace(
        /\(unnamed(?: struct| union| class)? at (?:[^)]*\/)?([^/)]+:\d+:\d+)\)/g,
        "(unnamed at $1)",
      ),
  );

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
    const fields = new Map<
      string,
      { offset: number; type: string; bit?: { start: number; width: number } }
    >();
    for (const l of lines.slice(1)) {
      // `8 |   int x`, or a bit-field `32:0-4 |   uintptr_t last_idx` (byte, then its first and
      // last bit counted from that byte).
      const m = /^\s*(\d+)(?::(\d+)-(\d+))? \| {3}(\S.*)$/.exec(l);
      if (m === null) continue; // nested deeper, or the size line
      const text = (m[4] as string).trim();
      const name = /([A-Za-z_]\w*)$/.exec(text)?.[1];
      if (name === undefined) continue;
      const offset = Number(m[1]);
      const type = text.slice(0, -name.length).trim();
      if (m[2] === undefined) fields.set(name, { offset, type });
      else {
        const first = Number(m[2]);
        const width = Number(m[3]) - first + 1;
        fields.set(name, { offset, type, bit: { start: offset * 8 + first, width } });
      }
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
  /** A number rounded to IEEE 754 binary32 (C's float), round to nearest even. */
  __ykF32: (x: number): number => Math.fround(x),
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
/** One item of a static's initializer: a value of a kind at an offset, or an address. */
export type StaticItem =
  | { readonly offset: number; readonly kind: string; readonly value: number | bigint }
  | { readonly offset: number; readonly static: string; readonly addend: number }
  | { readonly offset: number; readonly fn: string }
  | {
      readonly offset: number;
      readonly data: { readonly kind: string; readonly values: readonly (number | bigint)[] };
    };

/** A variable with static storage (module state): its size, alignment and initializer. */
export interface StaticDef {
  readonly size: number;
  readonly align: number;
  readonly init: readonly StaticItem[];
}

export function createCMemory() {
  interface Region {
    readonly base: number;
    readonly bytes: Uint8Array;
    readonly view: DataView;
    readonly constant: boolean;
    live: boolean;
  }
  const regions: Region[] = []; // by base, ascending (addresses only grow)
  // Functions as addresses, for function pointers (stored in memory, compared, called through):
  // a range no region uses, 16 apart.
  const FN_BASE = 0x7f0000000000;
  const fnAddrs = new Map<unknown, number>();
  const fnsAt: unknown[] = [];
  const statics = new Map<string, StaticDef>();
  const staticAddrs = new Map<string, number>();
  let fnByName: (name: string) => unknown = () => undefined;
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
    // Which region is nearest below (for debugging; the message is the native runtime's).
    let near = "";
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i] as Region;
      if (r.base <= a) {
        near = ` (nearest region 0x${r.base.toString(16)}+${r.bytes.length}${r.live ? "" : ", freed"}${r.constant ? ", constant" : ""})`;
        break;
      }
    }
    throw Object.assign(
      new CMemoryTrap(`memory trap: ${write ? "store" : "load"} of ${n} at 0x${a.toString(16)}`),
      { nearest: near.trim() },
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
    f32: [4, (v, o, x) => v.setFloat32(o, x, true)],
  };
  const fnAddr = (f: unknown): number => {
    if (typeof f !== "function") throw new CMemoryTrap(`memory trap: the address of ${String(f)}`);
    let a = fnAddrs.get(f);
    if (a === undefined) {
      a = FN_BASE + 16 * fnsAt.length;
      fnsAt.push(f);
      fnAddrs.set(f, a);
    }
    return a;
  };
  const staticAt = (key: string): number => {
    const known = staticAddrs.get(key);
    if (known !== undefined) return known;
    const def = statics.get(key);
    if (def === undefined) throw new CMemoryTrap(`memory trap: no definition of the static ${key}`);
    const a = alloc(def.size, def.align);
    staticAddrs.set(key, a); // before its initializer, which may point at itself
    const r = regions[regions.length - 1] as Region;
    for (const item of def.init) {
      if ("value" in item) {
        const spec = KINDS[item.kind];
        if (spec === undefined) throw new CMemoryTrap(`a static item of kind ${item.kind}`);
        spec[1](r.view, item.offset, item.value as number & bigint);
        continue;
      }
      const target =
        "static" in item
          ? staticAt(item.static) + item.addend
          : "fn" in item
            ? fnAddr(fnByName(item.fn))
            : leaves.__ykData(item.data.kind, item.data.values);
      r.view.setBigUint64(item.offset, BigInt(target), true);
    }
    return a;
  };
  const leaves = {
    __ykAlloc: (size: number, align: number): number => alloc(size, align),
    /** A function's address (a function pointer's value). */
    __ykFnAddr: fnAddr,
    /** The function at an address (a call through a function pointer). */
    __ykFnAt: (a: number): unknown => {
      const i = (a - FN_BASE) / 16;
      const f = Number.isInteger(i) ? fnsAt[i] : undefined;
      if (f === undefined) throw new CMemoryTrap(`memory trap: a call of 0x${a.toString(16)}`);
      return f;
    },
    /** A static variable's address: allocated and initialized when first used. */
    __ykStatic: staticAt,
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
    __ykLoadF32: (a: number): number => {
      const [v, o] = at(a, 4);
      return v.getFloat32(o, true);
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
    __ykStoreF32: (a: number, x: number): number => {
      const [v, o] = at(a, 4, true);
      v.setFloat32(o, x, true);
      return x;
    },
  };
  return {
    leaves,
    /** Define a static (module state) by its key, from its unit's shave. */
    defineStatic(key: string, def: StaticDef): void {
      statics.set(key, def);
    },
    /** How a static's initializer finds a function it points to, by name. */
    resolveFunctions(by: (name: string) => unknown): void {
      fnByName = by;
    },
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

/** A program's exit through the system-call leaf (exit, exit_group): its status. */
export class CExit extends Error {
  constructor(readonly status: number) {
    super(`exit ${status}`);
  }
}

/**
 * The system-call leaf and the thread pointer as JavaScript (#1365, layer 0), over a memory from
 * createCMemory: x86-64 Linux's numbers, for the calls musl makes on behalf of malloc, stdio,
 * time and exit. Anonymous mmap/munmap are regions of the memory (brk always fails, as musl
 * allows, so malloc maps); write and writev go to `io.write`; anything else is -ENOSYS. A target
 * implements the same leaf with its system-call instruction.
 */
export function createCSystem(
  memory: ReturnType<typeof createCMemory>,
  io: {
    readonly write?: (fd: number, bytes: Uint8Array) => void;
    /** The clock, in nanoseconds since the epoch (default: the host's). */
    readonly now?: () => bigint;
  } = {},
) {
  const { leaves } = memory;
  const ENOSYS = -38n;
  let tp: number | undefined;
  const write = (fd: number, a: number, n: number): bigint => {
    if (n > 0) io.write?.(fd, memory.get(a, n));
    return BigInt(n);
  };
  const call = (nr: bigint, a: bigint, b: bigint, c: bigint, _d: bigint, e: bigint): bigint => {
    const n = (x: bigint): number => Number(BigInt.asIntN(64, x));
    switch (n(nr)) {
      case 1: // write(fd, buf, count)
        return write(n(a), n(b), n(c));
      case 20: {
        // writev(fd, iov, iovcnt): each iovec is { base, len }
        let total = 0n;
        for (let i = 0; i < n(c); i++) {
          const base = Number(leaves.__ykLoad64(n(b) + 16 * i));
          const len = Number(leaves.__ykLoad64(n(b) + 16 * i + 8));
          total += write(n(a), base, len);
        }
        return total;
      }
      case 9: // mmap(addr, length, prot, flags, fd, offset): anonymous only
        if (n(e) !== -1) return ENOSYS;
        // Whole pages, as the kernel maps them: mallocng uses a mapping's last page to its end.
        return BigInt(leaves.__ykAlloc(Math.ceil(n(b) / 4096) * 4096, 4096));
      case 11: // munmap: a whole region is freed; a part of one stays (nothing reads it again)
        return 0n;
      case 12: // brk: no break; malloc then maps
        return 0n;
      case 25: // mremap: not offered; realloc copies instead
        return -12n;
      case 28: // madvise
      case 3: // close
      case 14: // rt_sigprocmask
        return 0n;
      case 16: // ioctl: no terminal
        return -25n;
      case 8: // lseek: not seekable
        return -29n;
      case 39: // getpid
      case 186: // gettid
        return 1n;
      case 228: {
        // clock_gettime(clock, timespec)
        const t = io.now?.() ?? BigInt(Date.now()) * 1000000n;
        leaves.__ykStore64(n(b), t / 1000000000n);
        leaves.__ykStore64(n(b) + 8, t % 1000000000n);
        return 0n;
      }
      case 60: // exit
      case 231: // exit_group
        throw new CExit(n(a));
      default:
        return ENOSYS;
    }
  };
  return {
    leaves: {
      __yk_syscall: (
        nr: bigint,
        a: bigint,
        b: bigint,
        c: bigint,
        d: bigint,
        e: bigint,
        _f: bigint,
      ) => call(nr, a, b, c, d, e),
      /** The thread's control block: zeroed, its first word its own address. */
      __yk_tp: (): bigint => {
        if (tp === undefined) {
          tp = leaves.__ykAlloc(4096, 64);
          leaves.__ykStore64(tp, BigInt(tp));
        }
        return BigInt(tp);
      },
    },
  };
}
