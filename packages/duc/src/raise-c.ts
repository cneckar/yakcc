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
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class RaiseCError extends Error {
  constructor(m: string) {
    super(
      process.env.YK_TRACE
        ? `${m} @@ ${new Error().stack
            ?.split("\n")
            .slice(2, 9)
            .map((l) =>
              l
                .trim()
                .replace(/^at /, "")
                .replace(/ \(.*:(\d+):\d+\)/, ":$1"),
            )
            .join(" < ")}`
        : m,
    );
  }
}

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
/**
 * A unit's AST, dumped once to a file (SQLite's is 725 MB of JSON) and indexed: each declaration,
 * at any depth, by id (one dump, so a reference's id is its declaration's), and the top-level ones
 * in order and by name. A declaration is parsed when it is asked for.
 */
interface UnitIndex {
  readonly path: string;
  /** The top-level declarations, in order. */
  readonly decls: readonly IndexedDecl[];
  readonly byName: ReadonlyMap<string, readonly IndexedDecl[]>;
  readonly byId: ReadonlyMap<string, IndexedDecl>;
  readonly byMangled: ReadonlyMap<string, IndexedDecl>;
  /** A redeclaration's later declaration (`previousDecl` read backward): toward the definition. */
  readonly next: ReadonlyMap<string, string>;
  readonly previous: ReadonlyMap<string, string>;
}
interface IndexedDecl {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /** A function with a body (a definition). */
  readonly body: boolean;
  readonly mangled?: string | undefined;
  /** A member's class: its id (the enclosing record, or an out-of-line definition's context). */
  readonly parent?: string | undefined;
  /** A record's tag (struct, class, union). */
  readonly tag?: string | undefined;
  /** The function a declaration is inside (a lambda's closure class), if any. */
  readonly owner?: string | undefined;
}

const RECORD_KINDS = new Set(["CXXRecordDecl", "RecordDecl", "ClassTemplateSpecializationDecl"]);

const FUNCTION_KINDS = new Set([
  "FunctionDecl",
  "CXXMethodDecl",
  "CXXConstructorDecl",
  "CXXDestructorDecl",
  "CXXConversionDecl",
]);

/** Dump a unit's AST to a file and index its declarations. */
function indexUnit(clang: string, args: readonly string[], file: string): UnitIndex {
  // One dump per unit (its command and its file, as last changed), kept in a shared cache and
  // reused: SQLite's is 725 MB, and a process that ends without its exit handlers (a test
  // worker) would leave one behind each run. Dumps unused for a day are removed.
  const dir = join(tmpdir(), "yakcc-ast");
  mkdirSync(dir, { recursive: true });
  const st = statSync(file);
  const key = createHash("sha256")
    .update(JSON.stringify([clang, args, file, st.size, st.mtimeMs]))
    .digest("hex")
    .slice(0, 32);
  const path = join(dir, `${key}.json`);
  for (const old of readdirSync(dir))
    try {
      if (Date.now() - statSync(join(dir, old)).atimeMs > 86_400_000)
        rmSync(join(dir, old), { force: true });
    } catch {
      // another process's, gone
    }
  if (!existsSync(path)) {
    const part = `${path}.${process.pid}.part`;
    const out = openSync(part, "w");
    try {
      execFileSync(clang, [...args, "-fsyntax-only", "-Xclang", "-ast-dump=json", file], {
        stdio: ["ignore", out, "ignore"],
        maxBuffer: 1 << 30,
      });
    } finally {
      closeSync(out);
    }
    renameSync(part, path);
  }
  const decls: IndexedDecl[] = [];
  const byName = new Map<string, IndexedDecl[]>();
  const byId = new Map<string, IndexedDecl>();
  const byMangled = new Map<string, IndexedDecl>();
  const next = new Map<string, string>();
  const previous = new Map<string, string>();
  // The open containers: an object's start, its id, kind, name and previous declaration as they
  // are read, whether a child of it is a body; an array is null.
  interface Frame {
    start: number;
    key: string | undefined;
    expectKey: boolean;
    id?: string;
    kind?: string;
    name?: string;
    previous?: string;
    mangled?: string;
    context?: string;
    tag?: string;
    body: boolean;
  }
  const stack: (Frame | null)[] = [];
  // For each open array, the key it is the value of: a declaration is an element of an `inner`
  // (a reference to one, `"referencedDecl": {"id", "kind", "name"}`, is not).
  const arrayKeys: (string | undefined)[] = [];
  let functions = 0; // open function declarations: their locals are not indexed
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const chunk = Buffer.alloc(1 << 24);
    let inString = false;
    let escaped = false;
    let text: number[] | undefined; // a string's bytes, when it may be a key or a wanted value
    for (let at = 0; at < size; ) {
      const n = readSync(fd, chunk, 0, chunk.length, at);
      for (let i = 0; i < n; i++) {
        const c = chunk[i] as number;
        if (inString) {
          if (escaped) escaped = false;
          else if (c === 0x5c) escaped = true;
          else if (c === 0x22) {
            inString = false;
            const top = stack[stack.length - 1];
            if (top !== null && top !== undefined && text !== undefined) {
              const value = Buffer.from(text).toString("utf8");
              if (top.expectKey) top.key = value;
              else if (top.key === "id" && top.id === undefined) top.id = value;
              else if (top.key === "kind" && top.kind === undefined) {
                top.kind = value;
                if (FUNCTION_KINDS.has(value)) functions++;
              } else if (top.key === "name" && top.name === undefined) top.name = value;
              else if (top.key === "previousDecl" && top.previous === undefined)
                top.previous = value;
              else if (top.key === "mangledName" && top.mangled === undefined) top.mangled = value;
              else if (top.key === "parentDeclContextId" && top.context === undefined)
                top.context = value;
              else if (top.key === "tagUsed" && top.tag === undefined) top.tag = value;
            }
            text = undefined;
            continue;
          }
          if (text !== undefined && text.length < 4096) text.push(c);
          continue;
        }
        if (c === 0x22) {
          inString = true;
          const top = stack[stack.length - 1];
          text =
            top !== null &&
            top !== undefined &&
            (top.expectKey ||
              [
                "id",
                "kind",
                "name",
                "previousDecl",
                "mangledName",
                "parentDeclContextId",
                "tagUsed",
              ].includes(top.key ?? ""))
              ? []
              : undefined;
        } else if (c === 0x3a) {
          const top = stack[stack.length - 1];
          if (top !== null && top !== undefined) top.expectKey = false;
        } else if (c === 0x2c) {
          const top = stack[stack.length - 1];
          if (top !== null && top !== undefined) {
            top.expectKey = true;
            top.key = undefined;
          }
        } else if (c === 0x7b)
          stack.push({ start: at + i, key: undefined, expectKey: true, body: false });
        else if (c === 0x5b) {
          const top = stack[stack.length - 1];
          arrayKeys.push(top === null || top === undefined ? undefined : top.key);
          stack.push(null);
        } else if (c === 0x7d || c === 0x5d) {
          const f = stack.pop();
          if (f === null) arrayKeys.pop();
          if (f === null || f === undefined) continue;
          if (FUNCTION_KINDS.has(f.kind ?? "")) functions--;
          const inInner =
            stack[stack.length - 1] === null && arrayKeys[arrayKeys.length - 1] === "inner";
          if (!inInner) continue;
          // The body of the function whose `inner` this object is in.
          const parent = stack[stack.length - 2];
          if (f.kind === "CompoundStmt" && parent !== null && parent !== undefined)
            parent.body = true;
          if (f.id === undefined || f.kind === undefined || !/Decl$/.test(f.kind)) continue;
          const top = stack.length === 2;
          // A local is not indexed; a function or a record inside a function (a lambda's) is.
          if (!top && functions > 0 && !FUNCTION_KINDS.has(f.kind) && !RECORD_KINDS.has(f.kind))
            continue;
          let enclosing: string | undefined;
          for (let k = stack.length - 1; k >= 0 && enclosing === undefined; k--) {
            const o = stack[k];
            if (o !== null && o !== undefined && RECORD_KINDS.has(o.kind ?? "")) enclosing = o.id;
          }
          let owner: string | undefined;
          for (let k = stack.length - 1; k >= 0 && owner === undefined; k--) {
            const o = stack[k];
            if (o !== null && o !== undefined && FUNCTION_KINDS.has(o.kind ?? "")) owner = o.id;
          }
          const d: IndexedDecl = {
            id: f.id,
            kind: f.kind,
            name: f.name ?? "",
            start: f.start,
            end: at + i + 1,
            body: f.body,
            mangled: f.mangled,
            parent: f.context ?? enclosing,
            tag: f.tag,
            owner,
          };
          // A template's specialization is dumped in full once, and as a reference elsewhere.
          const seen = byId.get(d.id);
          if (seen !== undefined && seen.end - seen.start > d.end - d.start) continue;
          byId.set(d.id, d);
          if (d.mangled !== undefined && d.body) byMangled.set(d.mangled, d);
          if (f.previous !== undefined) {
            next.set(f.previous, d.id);
            previous.set(d.id, f.previous);
          }
          if (top) decls.push(d);
          byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
        }
      }
      at += n;
    }
  } finally {
    closeSync(fd);
  }

  return { path, decls, byName, byId, byMangled, next, previous };
}

/** One indexed declaration, parsed. */
function readDecl(ix: UnitIndex, d: IndexedDecl): ClangNode {
  const fd = openSync(ix.path, "r");
  try {
    const b = Buffer.alloc(d.end - d.start);
    readSync(fd, b, 0, b.length, d.start);
    // (Documentation comments clang attaches to declarations are not code: left out.)
    const text = b.toString("utf8");
    if (!text.includes('"FullComment"')) return JSON.parse(text) as ClangNode;
    return JSON.parse(text, (_k, v: unknown) =>
      Array.isArray(v) && v.some((x) => (x as { kind?: string } | null)?.kind === "FullComment")
        ? v.filter((x) => (x as { kind?: string } | null)?.kind !== "FullComment")
        : v,
    ) as ClangNode;
  } finally {
    closeSync(fd);
  }
}

/** A declaration's definition (its body), through its redeclarations, by id. */
function definitionIn(ix: UnitIndex, id: string): IndexedDecl | undefined {
  // Back to the first declaration, then forward through every later one.
  let first = id;
  for (let guard = 0; ix.previous.has(first) && guard < 1000; guard++)
    first = ix.previous.get(first) as string;
  for (let at: string | undefined = first, guard = 0; at !== undefined && guard < 1000; guard++) {
    const d = ix.byId.get(at);
    if (d?.body) return d;
    at = ix.next.get(at);
  }
  return undefined;
}

/** clang's output for `args` (an AST dump). */
export function clangDump(clang: string, args: readonly string[]): string {
  return execFileSync(clang, [...args], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function clangFunctions(
  file: string,
  filters: readonly string[],
  args: readonly string[] = [],
  clang = "clang++",
): Map<string, ClangNode> {
  const out = new Map<string, ClangNode>();
  for (const filter of filters) {
    const json = clangDump(clang, [
      ...args,
      "-fsyntax-only",
      "-Xclang",
      "-ast-dump=json",
      "-Xclang",
      `-ast-dump-filter=${filter}`,
      file,
    ]);
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
  if (only?.kind === "StringLiteral" && /\[\d*\]$/.test(n.type?.qualType ?? "")) return only;
  // A scalar in braces (C++'s `uint64_t v{a | b}`) is its value; empty braces, zero.
  let scalar = false;
  try {
    const k = ctype(n.type).k;
    scalar = k !== "rec" && k !== "arr";
  } catch {
    scalar = false;
  }
  if (!scalar) return n;
  return only ?? ({ kind: "ImplicitValueInitExpr", type: n.type } as ClangNode);
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
  /** C++: each base class's offset (by its record key), and the vtable pointer's. */
  readonly bases?: ReadonlyMap<string, number>;
  readonly vptr?: number;
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
/** The unit's classes (UnitTypes.cxx). */
let unitCxx: CxxUnit | undefined;
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
/** The classes a member function is in, innermost first (C++: names in them need no scope). */
let localScopes: readonly string[] = [];

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
  // C++'s character types (x86-64 Linux: wchar_t is a signed 32-bit integer).
  char8_t: { k: "u8" },
  char16_t: { k: "u16" },
  char32_t: { k: "u32" },
  wchar_t: { k: "i32" },
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
  // (C++: a member alias desugared one step, `const value_type *`: its names in the class that
  // declares it, `basic_string_view<char>`.)
  const alias = (t as { typeAliasDeclId?: string }).typeAliasDeclId;
  const scope = alias === undefined ? undefined : unitCxx?.typedefsOf(alias);
  if (scope === undefined || scope.size === 0) return parseType(t.desugaredQualType ?? t.qualType);
  const saved = new Map(localTypedefs);
  for (const [k, v] of scope) localTypedefs.set(k, v);
  try {
    return parseType(t.desugaredQualType ?? t.qualType);
  } finally {
    localTypedefs.clear();
    for (const [k, v] of saved) localTypedefs.set(k, v);
  }
}

/** A C type as clang spells it, typedefs resolved through the unit. */
function parseType(spelled: string, depth = 0): CType {
  if (depth > 32) throw new RaiseCError(`the type "${spelled}" does not resolve`);
  const raw = spelled
    .replace(/\s*\[\[[^\]]*\]\]/g, "")
    // A vector (`__m128i`: `__attribute__((__vector_size__(2 * sizeof(long long)))) long long`):
    // an object of its bytes.
    .replace(
      /__attribute__\(\(__vector_size__\((\d+)(?:\s*\*\s*sizeof\(([^()]*)\))?\)(?:,\s*__aligned__\(\d+\))?\)\)\s*((?:(?:unsigned|signed|long|short|int|char|float|double)\b\s*)+)/g,
      (_m, n: string, of: string | undefined) =>
        `struct __yk_vector<${Number(n) * (of === undefined ? 1 : (VECTOR_LANE[of.trim()] ?? 0))}> `,
    )
    .replace(/__attribute__\(\(.*?\)\)\s*/g, "")
    // (Qualifiers inside a template's arguments are part of its name: `<const char *>`.)
    .replace(/<[\s\S]*>|\b(?:const|volatile|restrict|__restrict)\b/g, (m) =>
      m.startsWith("<") ? m : "",
    )
    .replace(/\s*\bnoexcept\b(\([^)]*\))?/g, "")
    .replace(/\s*\bthrow\b\s*(\(\s*\))?/g, "")
    .replace(/\s+/g, " ")
    // (`int (*const *)(int)` without its qualifier is `int (**)(int)`.)
    .replace(/\*\s+(?=[*)\[])/g, "*")
    .replace(/\(\s+\*/g, "(*")
    .trim();
  // A pointer to a function, and a pointer to one (`void (**)(int)`).
  const fnPtr = /\((\*+)((?:\[\d*\])*)\)\s*\(.*\)$/.exec(raw);
  if (fnPtr !== null) {
    let t: CType = { k: "fn" };
    for (let i = 0; i < (fnPtr[1] as string).length; i++) t = { k: "ptr", to: t };
    // An array of them (`void (*[3])(int)`): its dimensions, outermost first.
    const dims = [...(fnPtr[2] as string).matchAll(/\[(\d*)\]/g)].map((m) => m[1] as string);
    for (const d of dims.reverse())
      t = d === "" ? { k: "arr", of: t } : { k: "arr", of: t, size: Number(d) };
    return t;
  }
  // std::enable_if<C, T>::type, and enable_if_t (an instance exists only where C holds): T.
  const enable = /^(?:typename )?(?:std::)?enable_if(?:_t)?<(.*)>(?:::type)?$/.exec(raw);
  if (enable !== null) {
    const args = splitTemplateArgs(enable[1] as string);
    return parseType(args.length > 1 ? (args[args.length - 1] as string) : "void", depth + 1);
  }
  // A lambda's closure (C++): a class.
  if (/^(class )?\(lambda at .*\)$/.test(raw))
    return { k: "rec", name: raw.startsWith("class ") ? raw : `class ${raw}` };
  // A function type with a ref-qualifier or a trailing return type (C++): a function.
  if (/\)\s*&{1,2}$/.test(raw) || /^auto\s*\(.*\)\s*->/.test(raw)) return { k: "fn" };
  // A reference is an address (C++): `T &`, `T &&`.
  const ref = /^(.*?)\s*&&?$/.exec(raw);
  if (ref !== null && !/\)$/.test(ref[1] as string))
    return { k: "ptr", to: parseType(ref[1] as string, depth + 1) };
  // A reference or a pointer to an array (`int (&)[5]`, `char (*)[16]`): its address.
  const toArr = /^(.*?)\s*\((&&?|\*)\)\s*((?:\[\d*\])+)$/.exec(raw);
  if (toArr !== null)
    return { k: "ptr", to: parseType(`${toArr[1] as string} ${toArr[3] as string}`, depth + 1) };
  const arr = /^(.*?)\s*\[(\d*)\]$/.exec(raw);
  if (arr !== null) {
    const of = parseType(arr[1] as string, depth + 1);
    return arr[2] === "" ? { k: "arr", of } : { k: "arr", of, size: Number(arr[2]) };
  }
  const ptr = /^(.*?)\s*\*$/.exec(raw);
  if (ptr !== null) return { k: "ptr", to: parseType(ptr[1] as string, depth + 1) };
  const builtin = BUILTIN[raw];
  if (builtin !== undefined) return builtin;
  if (/^(struct|union|class) /.test(raw)) return { k: "rec", name: raw };
  if (/^enum /.test(raw)) {
    const e = unitTypedef(raw);
    if (e !== undefined) return parseType(e, depth + 1);
  }
  // An anonymous member record (C++), desugared (`std::basic_string<char>::(anonymous union at
  // f.h:204:7)`): the record, tagged as its spelling says.
  const anon = /\((?:anonymous|unnamed) (struct|union|class) at [^()]*\)$/.exec(raw);
  if (anon !== null) return { k: "rec", name: `${anon[1]} ${raw}` };
  if (/\)$/.test(raw)) return { k: "fn" };
  if (raw === "long double" && unitLongDouble64) return F64;
  if (raw === "long double") throw new RaiseCError(`the C type "${raw}" is not raised yet`);
  if (raw === "__builtin_va_list") return parseType("struct __va_list_tag[1]", depth + 1);
  const named = localTypedefs.get(raw) ?? unitTypedef(raw) ?? LP64_TYPEDEFS[raw];
  if (named !== undefined) return parseType(named, depth + 1);
  // A C++ class by its name alone (`yk::Point`): a record clang laid out.
  for (const tag of ["struct", "class", "union"])
    if (unitLayout(recordKey(`${tag} ${raw}`)) !== undefined)
      return { k: "rec", name: `${tag} ${raw}` };
  // A class named in the scope of the member function's class (`_Storage<int>`).
  for (const scope of localScopes)
    for (const tag of ["struct", "class", "union"])
      if (unitLayout(recordKey(`${tag} ${scope}::${raw}`)) !== undefined)
        return { k: "rec", name: `${tag} ${scope}::${raw}` };
  // (Its template's arguments spelled with typedefs, `optional<std::string_view>`: the types.)
  const parts = templateParts(raw);
  if (parts !== undefined && depth < 16) {
    const args = parts.args.map((a) => unitTypedef(a) ?? a);
    if (args.some((a, i) => a !== parts.args[i]))
      return parseType(`${parts.head}<${args.join(", ")}>${parts.tail}`, depth + 1);
  }
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

/** A vector's lane sizes, by the type its size is counted in. */
const VECTOR_LANE: Readonly<Record<string, number>> = {
  char: 1,
  "signed char": 1,
  "unsigned char": 1,
  short: 2,
  "unsigned short": 2,
  int: 4,
  "unsigned int": 4,
  long: 8,
  "long long": 8,
  "unsigned long long": 8,
  float: 4,
  double: 8,
};

const layoutOf = (t: CType): RecordLayout => {
  if (t.k !== "rec") throw new RaiseCError(`${t.k} is not a record`);
  if (t.name === "struct __va_list_tag") return VA_LIST_TAG;
  const vector = /^struct __yk_vector<(\d+)>$/.exec(t.name);
  if (vector !== null)
    return { size: Number(vector[1]), align: Number(vector[1]), fields: new Map() };
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
  // A shift's count has its own type (`1 << (h & 7)` with h 64-bit): the count as a number.
  if ((op === "<<" || op === ">>") && !wide(t) && wide(rhs))
    return arith(op, a, `__ykBigToI32(${b})`, t, { k: "i32" });
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
const clz64 = (x: string): string =>
  `(__ykBigToU32(${x} >> 32n) !== 0 ? Math.clz32(__ykBigToU32(${x} >> 32n)) : 32 + Math.clz32(__ykBigToU32(${x})))`;
const ctz32 = (x: string): string => `(31 - Math.clz32((${x}) & -(${x})))`;
const ctz64 = (x: string): string =>
  `(__ykBigToU32(${x}) !== 0 ? ${ctz32(`__ykBigToU32(${x})`)} : 32 + ${ctz32(`__ykBigToU32(${x} >> 32n)`)})`;

const LEAF_CALLS: Readonly<Record<string, (args: readonly string[]) => string>> = {
  // Bit counts (undefined for 0 in C; as x86's tzcnt/lzcnt would give otherwise).
  __builtin_clz: (a) => `Math.clz32(${a[0]})`,
  __builtin_ctz: (a) => ctz32(a[0] as string),
  __builtin_clzl: (a) => clz64(a[0] as string),
  __builtin_clzll: (a) => clz64(a[0] as string),
  __builtin_ctzl: (a) => ctz64(a[0] as string),
  __builtin_ctzll: (a) => ctz64(a[0] as string),
  // (C++: no constant evaluation at run time; nothing reaches an unreachable point.)
  __builtin_is_constant_evaluated: () => "false",
  __builtin_constant_p: () => "0",
  __builtin_unreachable: () => "undefined",
  // (Its size is a size_t: a bigint.)
  __builtin_operator_new: (a) => `__ykAlloc(__ykBigToF64(${a[0]}), 16)`,
  __builtin_operator_delete: (a) => `__ykFree(${a[0]})`,
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
  /**
   * Where the call is: its caller's symbol, and which call of a function of this name it is, in
   * the order code generation emits them. It tells template instances apart that have the same
   * name and type (simdutf's `convert<LITTLE>` and `convert<BIG>`): the unit's IR names the
   * instance each call calls.
   */
  readonly at?: { readonly caller: string; readonly index: number } | undefined;
  /** The declaration's id in the unit's dump (an indexed unit's: one dump, so it is exact). */
  readonly id?: string | undefined;
}

/**
 * What a call is: the identifier of the atom it references (a function of the unit, or one of a
 * header whose body clang has), or undefined when the unit has no body for it: an external
 * reference by its name, linked to an atom another unit shaves (a C library's `scalbn`).
 */
export type CalleeResolver = (callee: Callee) => string | undefined;

/** A variable at namespace or file scope, by name and type: its declaration, when clang has it. */
export type GlobalResolver = (name: string, type: string, id?: string) => ClangNode | undefined;

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
const OPERATOR_NAMES: Readonly<Record<string, string>> = {
  "+": "plus",
  "-": "minus",
  "*": "star",
  "/": "slash",
  "%": "percent",
  "^": "caret",
  "&": "amp",
  "|": "pipe",
  "~": "tilde",
  "!": "not",
  "=": "assign",
  "<": "lt",
  ">": "gt",
  "+=": "plus_assign",
  "-=": "minus_assign",
  "*=": "star_assign",
  "/=": "slash_assign",
  "%=": "percent_assign",
  "^=": "caret_assign",
  "&=": "amp_assign",
  "|=": "pipe_assign",
  "<<": "shl",
  ">>": "shr",
  "<<=": "shl_assign",
  ">>=": "shr_assign",
  "==": "eq",
  "!=": "ne",
  "<=": "le",
  ">=": "ge",
  "<=>": "cmp",
  "&&": "and",
  "||": "or",
  "++": "inc",
  "--": "dec",
  ",": "comma",
  "->*": "arrow_star",
  "->": "arrow",
  "()": "call",
  "[]": "index",
  " new": "new",
  " delete": "delete",
};
/**
 * A C or C++ name as a JavaScript identifier: reserved words suffixed; a C++ operator, destructor
 * or qualified name spelled out (`operator+` is operator_plus, `~Guard` is Guard_dtor).
 */
const ident = (name: string): string => {
  if (/^[A-Za-z_$][\w$]*$/.test(name)) return RESERVED.has(name) ? `${name}_` : name;
  const op = /^operator\s*(.*)$/.exec(name);
  if (op !== null) {
    const spelled =
      OPERATOR_NAMES[(op[1] as string).trim()] ?? OPERATOR_NAMES[` ${(op[1] as string).trim()}`];
    if (spelled !== undefined) return `operator_${spelled}`;
  }
  const bare = name.split("::").pop() ?? name;
  if (bare.startsWith("~")) return `${ident(bare.slice(1))}_dtor`;
  return bare.replace(/[^\w$]/g, "_") || "f";
};

/** The rest of what raising a function needs from its unit: typedefs and record layouts. */
export interface UnitTypes {
  readonly typedef?: TypedefResolver;
  readonly layout?: LayoutResolver;
  /**
   * A variable with static storage that the function writes or takes the address of (module
   * state): its key for `__ykStatic`, its definition recorded by the unit. `fn` names the function
   * for a static local. Undefined when the unit cannot define it (then it is refused).
   */
  /**
   * A static's key, defined; `dynamic`, a function's static initialized when its declaration is
   * first reached (C++): its memory zero, and a guard byte beside it (its key, `#guard`).
   */
  readonly static?: (decl: ClangNode, fn?: string, dynamic?: boolean) => string | undefined;
  /** The unit is parsed with clang's -mlong-double-64: long double is double. */
  readonly longDouble64?: boolean;
  /** An enumeration constant's value, by its name (one scope in C; ids differ between dumps). */
  readonly enumValue?: (name: string) => bigint | undefined;
  /** An offsetof expression's value (clang's JSON does not say which member). */
  readonly offsetOf?: (e: ClangNode) => number | undefined;
  /** C++: a unit's classes (an indexed unit's). */
  readonly cxx?: CxxUnit;
}

/** A lambda's closure (C++): its type, and each capture's field, in order. */
export interface Lambda {
  readonly record: string;
  readonly captures: readonly {
    readonly id: string;
    readonly byRef: boolean;
    readonly type: string;
  }[];
}

/** What the raiser asks of a C++ unit about its classes. */
export interface CxxUnit {
  /** A member function's class, as a record type (`struct Point`), by the function's id. */
  readonly classOf: (fnId: string) => string | undefined;
  /** The constructor of a class (by its record type) of a type (`void (int, int)`). */
  readonly constructorOf: (
    record: string,
    type: string,
  ) => { readonly id: string; readonly body: boolean } | undefined;
  /** A class's destructor, if it declares one. */
  readonly destructorOf: (
    record: string,
  ) => { readonly id: string; readonly body: boolean } | undefined;
  /** Whether a member function is virtual. */
  readonly isVirtual: (methodId: string) => boolean;
  /** A function's parameter's default argument (its expression), by the function's id. */
  readonly defaultArgOf: (fnId: string, index: number) => ClangNode | undefined;
  /**
   * The member typedefs and aliases in scope in a member function, by its id (its class's, then
   * the classes it is nested in): each name's type, as the class template's instance has it.
   */
  readonly typedefsOf: (fnId: string) => ReadonlyMap<string, string>;
  /** A member's default initializer (`bool has = false;`), by the member's id. */
  readonly fieldInitOf: (fieldId: string) => ClangNode | undefined;
  /**
   * A class's move constructor (`move`) or copy constructor, when not trivial: an object moved or
   * copied to another place runs it (std::string's points into itself).
   */
  readonly copyCtorOf: (
    record: string,
    move: boolean,
  ) => { readonly id: string; readonly body: boolean } | undefined;
  /** Whether a class's copy and move constructors are trivial (a copy is its bytes). */
  readonly trivialCopy: (record: string) => boolean;
  /** A member's default initializer, by its class's name and its own. */
  readonly memberInitOf: (record: string, field: string) => ClangNode | undefined;
  /**
   * A lambda's call operator, by its id: the closure's type, and its captures (each captured
   * variable's id, in the closure's field order, by reference or by copy).
   */
  readonly lambdaOf: (methodId: string) => Lambda | undefined;
  /** A virtual member function's slot in its class's vtable; a destructor's, `deleting`. */
  readonly slotOf: (methodId: string) => number | undefined;
  readonly deletingSlotOf: (record: string) => number | undefined;
  /**
   * A class's vtable, as module state: its static's key (the functions' addresses, from the
   * address point). Its destructor entries are made from `destroy` (complete, and deleting: then
   * freed).
   */
  readonly vtableOf: (record: string, destroy: (addr: string, t: CType) => string[]) => string;
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
/**
 * A member function's key within its class: its name and its parameters and qualifiers, without
 * namespaces or spaces (`area() const`, as a declaration's type or clang's vtable dump spells it).
 */
const memberKey = (name: string, signature: string): string =>
  name +
  signature
    .slice(signature.indexOf("("))
    .replace(/\s*\bnoexcept\b(\([^)]*\))?/g, "")
    .replace(/\s*\bthrow\b\s*(\(\s*\))?/g, "")
    .replace(/\b[A-Za-z_]\w*::/g, "")
    .replace(/\s+/g, "");

/** A template's arguments, split at its top-level commas. */
function splitTemplateArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  // (Inside parentheses, `decltype(a() > b())`, an angle bracket can be an operator.)
  let parens = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[") parens++;
    else if (c === ")" || c === "]") parens--;
    else if (parens === 0 && c === "<") depth++;
    else if (parens === 0 && c === ">") depth--;
    else if (c === "," && depth === 0 && parens === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** A function type's return type: what is before its parameter list (the last parenthesis). */
export function returnTypeOf(spelled: string): string {
  // (Attributes after the parameters, `[[clang::lifetimebound]]`, are not the type.)
  const fnType = spelled
    .replace(/\s*\[\[[^\]]*\]\]/g, "")
    .replace(/\s*__attribute__\(\((?:[^()]|\([^()]*\))*\)\)/g, "");
  // A trailing return type (C++: `auto (uint32_t) -> std::string`): the one it trails.
  if (/^auto\s*\(/.test(fnType)) {
    const open = fnType.indexOf("(");
    for (let i = open, depth = 0; i < fnType.length; i++) {
      if (fnType[i] === "(") depth++;
      else if (fnType[i] === ")" && --depth === 0) {
        const arrow = /^[^>]*?->\s*(.*)$/.exec(fnType.slice(i + 1));
        if (arrow !== null) return returnTypeOf(`${arrow[1] as string} ()`);
        break;
      }
    }
  }
  // (Every qualifier after the parameters: `() const noexcept`.)
  let t = fnType.trim();
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/\s*(const|volatile|noexcept(\([^)]*\))?|&&?)\s*$/, "").trim();
  }
  if (!t.endsWith(")")) return t;
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === ")") depth++;
    else if (t[i] === "(" && --depth === 0) return t.slice(0, i).trim();
  }
  return t;
}

/**
 * Whether a variable of this type is itself constant: `const int`, `const char [4]`,
 * `char *const`; not `const char *` (a pointer to constants, itself writable).
 */
const constVariable = (qualType: string): boolean => {
  const star = qualType.lastIndexOf("*");
  return star < 0 ? /\bconst\b/.test(qualType) : /\bconst\b/.test(qualType.slice(star));
};

/** Whether two clang types are one C type (as raised). */
const sameType = (
  a: { qualType: string } | undefined,
  b: { qualType: string } | undefined,
): boolean => {
  try {
    return JSON.stringify(ctype(a)) === JSON.stringify(ctype(b));
  } catch {
    return false;
  }
};

/** A record type's name as parseType names it (a lambda's closure: `class (lambda at ..)`). */
const parseRecordName = (spelled: string): string => {
  const t = parseType(spelled);
  return t.k === "rec" ? t.name : spelled;
};

/** A lambda's closure fields (C++): each capture's offset, by reference an address (8 bytes). */
function closureFields(
  caps: readonly { readonly byRef: boolean; readonly type: string }[],
): { offset: number; byRef: boolean }[] {
  let at = 0;
  return caps.map((c) => {
    const t = c.byRef ? undefined : parseType(c.type);
    const size = t === undefined ? 8 : sizeOf(t);
    const align = t === undefined ? 8 : alignOf(t);
    at = Math.ceil(at / align) * align;
    const offset = at;
    at += size;
    return { offset, byRef: c.byRef };
  });
}

/** Where a class's vtable pointer is (C++): its own, or its primary base's. */
function vptrOf(record: string): number | undefined {
  const l = unitLayout(recordKey(record));
  if (l?.vptr !== undefined) return l.vptr;
  for (const [b, o] of l?.bases ?? []) {
    const v = vptrOf(b);
    if (v !== undefined) return o + v;
  }
  return undefined;
}

/** A base class's offset in a derived one (C++), through intermediate bases. */
function baseOffset(derived: string, base: string): number | undefined {
  if (recordKey(derived) === recordKey(base)) return 0;
  const l = unitLayout(recordKey(derived));
  for (const [b, o] of l?.bases ?? []) {
    const rest = baseOffset(b, base);
    if (rest !== undefined) return o + rest;
  }
  return undefined;
}

/** A function's symbol: its mangled name (C++), or its name (C). */
export const symbolOf = (fn: ClangNode): string =>
  (fn as { mangledName?: string }).mangledName ?? fn.name ?? "";

/**
 * Each direct call in a function, numbered among the calls of functions of the same name, in
 * the order code generation emits them: a call's arguments (and their calls) before it, a for
 * loop's body before its increment.
 */
function emissionOrder(fn: ClangNode): Map<ClangNode, number> {
  const out = new Map<ClangNode, number>();
  const counts = new Map<string, number>();
  const walk = (n: ClangNode): void => {
    const kids = n.inner ?? [];
    if (n.kind === "ForStmt") {
      const [init, condVar, c, inc, b] = kids;
      for (const k of [init, condVar, c, b, inc]) if (k?.kind !== undefined) walk(k);
      return;
    }
    for (const k of kids) walk(k);
    if (n.kind === "CallExpr") {
      const name = stripCasts(kids[0] as ClangNode).referencedDecl?.name;
      if (name !== undefined) {
        const i = counts.get(name) ?? 0;
        counts.set(name, i + 1);
        out.set(n, i);
      }
    }
  };
  walk(fn);
  return out;
}

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
  const savedEnum = [unitEnumValue, unitOffsetOf, unitCxx] as const;
  unitCxx = types.cxx;
  unitEnumValue = types.enumValue ?? (() => undefined);
  unitOffsetOf = types.offsetOf ?? (() => undefined);
  localTypedefs.clear();
  try {
    return raiseBody(fn, resolve, externals, resolveGlobal, types.static);
  } finally {
    [unitTypedef, unitLayout, unitLongDouble64] = saved;
    [unitEnumValue, unitOffsetOf, unitCxx] = savedEnum;
    localTypedefs.clear();
    localScopes = [];
  }
}

function raiseBody(
  asWritten: ClangNode,
  resolve: CalleeResolver,
  externals: Set<string>,
  resolveGlobal: GlobalResolver,
  unitStatic: UnitTypes["static"],
): string {
  // (C++: a range-based for is the for loop clang spells it as.)
  const fn = lowerRangeFor(asWritten);
  // Each direct call's place among the calls of functions of its name (see Callee.at).
  const callOrder = emissionOrder(fn);
  // The constants at namespace or file scope the function reads: each a const at its top.
  const globals = new Map<string, string>(); // decl id -> its const's line
  const globalNames = new Map<string, string>();
  const globalDecls = new Map<string, ClangNode>(); // decl id -> its declaration (initializer)
  const globalData = new Map<string, string>(); // decl id -> its constant memory's name
  const params = (fn.inner ?? []).filter((c) => c.kind === "ParmVarDecl");
  // A member function (not a static one) takes its object's address first, `__this`.
  const method =
    ["CXXMethodDecl", "CXXConstructorDecl", "CXXDestructorDecl", "CXXConversionDecl"].includes(
      fn.kind,
    ) && fn.storageClass !== "static";
  const lambda = method ? unitCxx?.lambdaOf(fn.id ?? "") : undefined;
  const thisRecord = method
    ? lambda !== undefined
      ? parseRecordName(lambda.record)
      : unitCxx?.classOf(fn.id ?? "")
    : undefined;
  // A lambda's captures, as its closure's fields: each captured variable's offset.
  const captured = new Map<string, { offset: number; byRef: boolean }>();
  if (lambda !== undefined)
    closureFields(lambda.captures).forEach((f, i) =>
      captured.set((lambda.captures[i] as { id: string }).id, f),
    );
  if (method && thisRecord === undefined) throw new RaiseCError(`the class of ${fn.name}`);
  // A member function's class's typedefs (`char_type`): the instance's, before the unit's.
  for (const [n, t] of unitCxx?.typedefsOf(fn.id ?? "") ?? []) localTypedefs.set(n, t);
  {
    const cls = thisRecord ?? unitCxx?.classOf(fn.id ?? "");
    const scopes: string[] = [];
    if (cls !== undefined) {
      let at = cls.replace(/^(struct|class|union) /, "");
      for (let guard = 0; at !== "" && guard < 8; guard++) {
        scopes.push(at);
        // (Up one class: its scope's last `::` outside a template's arguments.)
        let depth = 0;
        let last = -1;
        for (let i = 0; i < at.length; i++) {
          if (at[i] === "<") depth++;
          else if (at[i] === ">") depth--;
          else if (depth === 0 && at[i] === ":" && at[i + 1] === ":") last = i;
        }
        at = last < 0 ? "" : at.slice(0, last);
      }
    }
    localScopes = scopes;
  }
  // A variadic function takes its variable arguments' address as a last parameter, `__va`.
  const variadic = variadicParams(fn.type?.qualType ?? "") !== undefined;
  // (A template instance's type spelled as written can be `typename enable_if<..>::type (T)`: its
  // desugared form is the type.)
  const fnType = fn.type?.desugaredQualType ?? fn.type?.qualType ?? "";
  const result = ctype({ qualType: returnTypeOf(fnType) });
  // C++: a record returned is made in the caller's slot, `__ret` (copy elision); a variable that
  // is the named return value lives there.
  const sret = unitCxx !== undefined && result.k === "rec";
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
  // C++: an object a reference binds to (an lvalue argument, a reference's initializer) is in
  // memory: the reference is its address.
  {
    const bind = (x: ClangNode | undefined): void => {
      let n = x;
      // (C++: `++x` is x.)
      while (
        n !== undefined &&
        ((n.kind === "ImplicitCastExpr" && n.castKind === "NoOp") ||
          n.kind === "ParenExpr" ||
          (n.kind === "UnaryOperator" &&
            (n.opcode === "++" || n.opcode === "--") &&
            n.isPostfix !== true))
      )
        n = (n.inner ?? [])[0];
      // (A reference is already an address: what it names is in memory, not it.)
      if (
        n?.kind === "DeclRefExpr" &&
        (n as { valueCategory?: string }).valueCategory === "lvalue" &&
        !isReferenceType(n.referencedDecl?.type?.qualType ?? "")
      )
        inMemory.add(n.referencedDecl?.id ?? "");
    };
    const walk = (n: ClangNode): void => {
      const kids = n.inner ?? [];
      if (n.kind === "CallExpr" || n.kind === "CXXOperatorCallExpr")
        for (const a of kids.slice(1)) bind(a);

      if (
        n.kind === "CXXMemberCallExpr" ||
        n.kind === "CXXConstructExpr" ||
        n.kind === "CXXTemporaryObjectExpr"
      )
        for (const a of kids.slice(n.kind === "CXXMemberCallExpr" ? 1 : 0)) bind(a);
      if (n.kind === "LambdaExpr") for (const a of kids.slice(1, -1)) bind(a);
      if (n.kind === "VarDecl" && isReferenceType(n.type?.qualType ?? ""))
        bind(kids.find((k) => !k.kind.endsWith("Attr")));
      for (const k of kids) walk(k);
    };
    const b = body(fn);
    if (b !== undefined) walk(b);
    for (const init of (fn.inner ?? []).filter((c) => c.kind === "CXXCtorInitializer")) walk(init);
  }
  // Variables the function writes: a `static` local it never writes is a constant, not state.
  const written = new Set<string>();
  // `viaDeref`: inside `*(cast)&x` (fdlibm's `*(volatile double *)&a[3]`), which is x itself.
  const scan = (n: ClangNode, parent: ClangNode | undefined, viaDeref = false): void => {
    const derefOfAddr =
      n.kind === "UnaryOperator" &&
      n.opcode === "*" &&
      (() => {
        const s = stripCasts((n.inner ?? [])[0] as ClangNode);
        return (
          s.kind === "UnaryOperator" &&
          s.opcode === "&" &&
          sameType(n.type, ((s.inner ?? [])[0] as ClangNode).type)
        );
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
  // (C++: the named return value, made in the caller's slot.)
  if (sret) {
    const walk = (n: ClangNode): void => {
      if (n.kind === "VarDecl" && (n as { nrvo?: boolean }).nrvo === true && n.id !== undefined)
        mems.set(n.id, { k: "mem", addr: "__ret", t: ctype(n.type) });
      for (const k of n.inner ?? []) walk(k);
    };
    walk(fn);
  }
  // C++'s return slot: a call of a function returning a record passes, first, where the record is
  // made (copy elision): a destination copyFrom names (`pendingRet`), else a slot of this frame.
  let pendingRet: string | undefined;
  const claimRet = (e: ClangNode): Ret => {
    const mine = pendingRet;
    pendingRet = undefined;
    const t = e.type === undefined ? undefined : typeOf(e);
    const applies =
      unitCxx !== undefined && t?.k === "rec" && (e.valueCategory ?? "prvalue") === "prvalue";
    let slot: string | undefined;
    return {
      applies,
      slot: () => {
        if (!applies || t === undefined) return [];
        if (slot === undefined) {
          slot = mine;
          if (slot === undefined) {
            slot = `__ret${temps++}`;
            top.push(
              `const ${slot} = __ykAlloc(${Math.max(8, sizeOf(t))}, ${Math.max(8, alignOf(t))});`,
            );
            frame.push(slot);
          }
        }
        return [slot];
      },
    };
  };
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
  const isMem = (d: ClangNode, t: CType): boolean =>
    inMemory.has(d.id ?? "") || t.k === "rec" || (t.k === "arr" && t.of.k === "rec");

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
      decl = resolveGlobal(d.name ?? "", normType(d.type?.qualType ?? ""), d.id);
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
    // (Two constants of one name, `value` of two class instances: the second numbered.)
    const base = `${ident(d.name ?? "g")}_g`;
    const taken = new Set(globalNames.values());
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
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
    // A record, or an array of records, is memory (its members are at offsets): static memory.
    const t = ctype(d.type);
    if (t.k === "rec" || (t.k === "arr" && t.of.k === "rec")) return false;
    const decl = resolveGlobal(d.name ?? "", normType(d.type?.qualType ?? ""), d.id);
    return (
      decl !== undefined &&
      initOf(decl) !== undefined &&
      (constVariable(decl.type?.qualType ?? "") || /\bconstexpr\b/.test(decl.type?.qualType ?? ""))
    );
  };
  /** Whether this unit has a global's initializer. */
  const hasInit = (d: ClangNode): boolean => {
    const decl = resolveGlobal(d.name ?? "", normType(d.type?.qualType ?? ""), d.id);
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
      case "SubstNonTypeTemplateParmExpr":
        return place(kids[kids.length - 1] as ClangNode);
      // A call that returns a reference (an lvalue): the object at the address it returns.
      case "CallExpr":
      case "CXXMemberCallExpr":
      case "CXXOperatorCallExpr":
        return { k: "mem", addr: expr(e), t: typeOf(e) };
      case "CXXThisExpr":
        return { k: "reg", e: "__this", t: typeOf(e) };
      case "ImplicitCastExpr":
      case "CStyleCastExpr":
      case "CXXConstCastExpr":
      case "CXXStaticCastExpr":
      case "CXXFunctionalCastExpr":
        // A cast that keeps an lvalue (a qualification): the same object; a record read as a
        // value (to be copied), the record itself.
        if (e.castKind === "NoOp") return place(k0);
        if (e.castKind === "LValueToRValue" && typeOf(e).k === "rec") return place(k0);
        // A record made by a conversion (C++: a converting constructor, a conversion operator):
        // a temporary in a frame slot.
        if (
          (e.castKind === "ConstructorConversion" || e.castKind === "UserDefinedConversion") &&
          typeOf(e).k === "rec"
        ) {
          const t = typeOf(e);
          const slot = `__tmp${temps++}`;
          top.push(
            `const ${slot} = __ykAlloc(${Math.max(8, sizeOf(t))}, ${Math.max(8, alignOf(t))});`,
          );
          frame.push(slot);
          return { k: "mem", addr: `(${[...copyFrom(slot, t, e), slot].join(", ")})`, t };
        }
        // An object as its base's subobject (C++): at the base's offset.
        if (e.castKind === "DerivedToBase" || e.castKind === "UncheckedDerivedToBase") {
          const from = typeOf(k0);
          const to = typeOf(e);
          const p = place(k0);
          if (from.k !== "rec" || to.k !== "rec" || p.k !== "mem") break;
          const off = baseOffset(from.name, to.name);
          if (off === undefined) throw new RaiseCError(`${to.name} as a base of ${from.name}`);
          return { k: "mem", addr: off === 0 ? p.addr : `(${p.addr} + ${off})`, t: to };
        }
        break;
      case "DeclRefExpr": {
        const d = e.referencedDecl as ClangNode;
        const t = typeOf(e);
        const mem = mems.get(d.id ?? "");
        if (mem !== undefined) return mem;
        // A lambda's capture (C++): its closure's field; by reference, the address held there.
        const cap = captured.get(d.id ?? "");
        if (cap !== undefined) {
          const at = cap.offset === 0 ? "__this" : `(__this + ${cap.offset})`;
          return { k: "mem", addr: cap.byRef ? `__ykBigToF64(__ykI64(__ykLoad64(${at})))` : at, t };
        }
        // A reference (C++): its value is the address of the object it names.
        if (isReferenceType(d.type?.qualType ?? "") && !isGlobal(d))
          return { k: "mem", addr: declName(d), t };
        if (isGlobal(d)) {
          if (constGlobal(d)) return { k: "reg", e: globalRef(d), t };
          const sp = staticPlace(d, t);
          if (sp !== undefined) return sp;
          return { k: "reg", e: globalRef(d), t };
        }
        return { k: "reg", e: declName(d), t };
      }
      case "UnaryOperator": {
        // (C++: `++x` is x itself, after the increment; an object in memory, its address.)
        if ((e.opcode === "++" || e.opcode === "--") && e.isPostfix !== true) {
          const p = place(k0);
          if (p.k === "mem") {
            const a = temp({ k: "f64" });
            return { k: "mem", addr: `((${a} = ${p.addr}), ${expr(e)}, ${a})`, t: typeOf(e) };
          }
          return { k: "reg", e: expr(e), t: typeOf(e) };
        }
        if (e.opcode !== "*") break;
        // *&x is x (fdlibm writes `*(volatile double *)&a[3]` to stop a compiler folding).
        // (Only as the same type: `*(u16 *)&c[2]` reads two chars as one u16, in memory.)
        const inner = stripCasts(k0);
        if (
          inner.kind === "UnaryOperator" &&
          inner.opcode === "&" &&
          sameType(e.type, ((inner.inner as ClangNode[])[0] as ClangNode).type)
        )
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
        {
          // A conditional of two objects in memory (records): the chosen one, by address.
          const a = place(kids[1] as ClangNode);
          const b = place(kids[2] as ClangNode);
          if (a.k === "mem" && b.k === "mem")
            return { k: "mem", addr: `(${cond(k0)} ? ${a.addr} : ${b.addr})`, t: typeOf(e) };
        }
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
        if (baseT.k !== "rec")
          throw new RaiseCError(
            `the member ${e.name} of a ${baseT.k} (${JSON.stringify(k0.type)})`,
          );
        const field = layoutOf(baseT).fields.get(memberName(e));
        if (field === undefined) throw new RaiseCError(`the field "${e.name}"`);
        let addr: string;
        if (arrow) addr = expr(k0);
        else {
          const p = place(k0);
          if (p.k !== "mem")
            throw new RaiseCError(
              `a member of a record that is not in memory (${`${stripCasts(k0).kind} ${stripCasts(k0).referencedDecl?.name ?? stripCasts(k0).name ?? ""}`})`,
            );
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
      // `__func__`, `__PRETTY_FUNCTION__`: their string.
      case "PredefinedExpr":
      // (C++: a full expression, and a temporary to destroy: the object; temporaries are not
      // destroyed.)
      case "ExprWithCleanups":
      case "CXXBindTemporaryExpr":
        return place(k0);
      // A temporary object (C++: `std::string_view(p, n).size()`): constructed in a frame slot.
      case "CXXConstructExpr":
      case "CXXTemporaryObjectExpr": {
        const t = typeOf(e);
        if (t.k !== "rec") break;
        const slot = `__tmp${temps++}`;
        top.push(
          `const ${slot} = __ykAlloc(${Math.max(8, sizeOf(t))}, ${Math.max(8, alignOf(t))});`,
        );
        frame.push(slot);
        return { k: "mem", addr: `(${construct(slot, e)}, ${slot})`, t };
      }
      // A temporary bound to a reference (C++): an object of its own, in a frame slot,
      // initialized where it is evaluated.
      case "MaterializeTemporaryExpr": {
        const t = typeOf(e);
        if (typeOf(k0).k === "rec" && /lvalue|xvalue/.test(k0.valueCategory ?? ""))
          return place(k0);
        const slot = `__tmp${temps++}`;
        top.push(
          `const ${slot} = __ykAlloc(${Math.max(1, sizeOf(t))}, ${Math.max(1, alignOf(t))});`,
        );
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
    throw new RaiseCError(
      `the lvalue ${e.kind}${e.castKind !== undefined ? ` (${e.castKind})` : ""} is not raised yet`,
    );
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
      // A template argument's value where its parameter is used: the argument (the last child).
      case "SubstNonTypeTemplateParmExpr":
        return `(${expr(kids[kids.length - 1] as ClangNode)})`;
      // An atomic access: one thread (the raised code has no other), so a plain load or store.
      case "AtomicExpr": {
        const op = e.name ?? "";
        const pt = typeOf(k0);
        if (pt.k !== "ptr") throw new RaiseCError(`${op} on a ${pt.k}`);
        if (op === "__atomic_load_n" || op === "__c11_atomic_load") return loadAt(expr(k0), pt.to);
        if (op === "__atomic_store_n" || op === "__c11_atomic_store") {
          const v = kids[2] as ClangNode;
          return `(${storeAt(expr(k0), pt.to, convert(expr(v), typeOf(v), pt.to))}, undefined)`;
        }
        throw new RaiseCError(`the atomic operation ${op}`);
      }
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
      case "CXXScalarValueInitExpr":
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
            id: d.id,
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
            // An array of records is memory too (its members are at offsets).
            const at = typeOf(target);
            const records = at.k === "arr" && at.of.k === "rec";
            // (A global's address is the same from every function: `zName == row_numberName`
            // compares them. Its static memory, then, constant or not.)
            if (global) {
              const sp = staticPlace(d, at);
              if (sp !== undefined) return sp.addr;
            }
            if (!records && (global || /\bconst\b/.test(d.type?.qualType ?? "")))
              return constData(d, global);
          }
          // (One of two arrays: the one chosen, as a pointer; a row of an array of arrays: the
          // array's address, the row's offset on.)
          const decayOf = (x: ClangNode): ClangNode =>
            ({
              kind: "ImplicitCastExpr",
              castKind: "ArrayToPointerDecay",
              type: e.type,
              valueCategory: "prvalue",
              inner: [x],
            }) as ClangNode;
          if (target.kind === "ConditionalOperator") {
            const [c, x, y] = target.inner as [ClangNode, ClangNode, ClangNode];
            return `(${cond(c)} ? ${expr(decayOf(x))} : ${expr(decayOf(y))})`;
          }
          if (target.kind === "ArraySubscriptExpr") {
            const [b, i] = target.inner as [ClangNode, ClangNode];
            const bt = typeOf(b);
            if (bt.k === "ptr" && bt.to.k === "arr")
              return `(${expr(b)} + ${scaled(indexNum(expr(i), typeOf(i)), sizeOf(bt.to))})`;
          }
          const p = place(k0);
          if (p.k !== "mem")
            throw new RaiseCError(
              `an array used as a pointer that is not in memory (${target.kind} ${target.referencedDecl?.name ?? target.name ?? ""} ${target.referencedDecl?.kind ?? ""})`,
            );
          return p.addr;
        }
        if (["NoOp", "FunctionToPointerDecay", "BitCast"].includes(ck)) return expr(k0);
        // A pointer to a derived class as one to its base (C++), and back: the base's offset.
        if (ck === "DerivedToBase" || ck === "UncheckedDerivedToBase" || ck === "BaseToDerived") {
          const from = typeOf(k0);
          const to = typeOf(e);
          if (from.k !== "ptr" || to.k !== "ptr" || from.to.k !== "rec" || to.to.k !== "rec")
            throw new RaiseCError(`the cast ${ck} of a ${from.k}`);
          const [d, b] =
            ck === "BaseToDerived" ? [to.to.name, from.to.name] : [from.to.name, to.to.name];
          const off = baseOffset(d, b);
          if (off === undefined) throw new RaiseCError(`${b} as a base of ${d}`);
          if (off === 0) return expr(k0);
          const p = temp({ k: "f64" });
          return `(((${p} = ${expr(k0)}) !== 0) ? ${p} ${ck === "BaseToDerived" ? "-" : "+"} ${off} : 0)`;
        }
        if (ck === "NullToPointer") return "0";
        // A conversion operator's call (C++), or a record a conversion makes: its value.
        if (ck === "UserDefinedConversion" && typeOf(e).k !== "rec") return expr(k0);
        if (
          (ck === "UserDefinedConversion" || ck === "ConstructorConversion") &&
          typeOf(e).k === "rec"
        )
          return (place(e) as Place & { k: "mem" }).addr;
        // (A record cast to void, `(void)u.minor;`, is not read.)
        if (ck === "ToVoid") return typeOf(k0).k === "rec" ? "undefined" : expr(k0);
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
        // A function through its pointer (`(*xFunc)`, as a callee decays it back): the address.
        if (op === "*" && typeOf(e).k === "fn") return expr(k0);
        if (op === "*") return read(place(e));
        if (op === "&") {
          const p = place(k0);
          if (p.k === "mem") return p.addr;
          throw new RaiseCError(
            `the address of an object that is not in memory (${stripCasts(k0).kind} ${stripCasts(stripCasts(k0).inner?.[0] ?? k0).referencedDecl?.name ?? stripCasts(k0).referencedDecl?.name ?? ""})`,
          );
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
      case "CXXThisExpr":
        return "__this";
      // new (C++): memory for the object, constructed there; its address.
      case "CXXNewExpr": {
        // A placement new (`::new (p) T(..)`, the standard placement operator): constructed at p.
        const placement = e as {
          isPlacement?: boolean;
          initStyle?: string;
          operatorNewDecl?: { type?: { qualType?: string } };
        };
        if (
          placement.isPlacement === true &&
          (e as { isArray?: boolean }).isArray !== true &&
          /^void \*\((std::)?size_t, void \*\)/.test(
            placement.operatorNewDecl?.type?.qualType ?? "",
          )
        ) {
          const t = typeOf(e);
          if (t.k !== "ptr") throw new RaiseCError("a new of a non-pointer");
          const hasInit = placement.initStyle !== undefined;
          const where = kids[hasInit ? 1 : 0] as ClangNode;
          const a = temp({ k: "f64" });
          const init = hasInit ? kids[0] : undefined;
          const made =
            init === undefined
              ? "undefined"
              : t.to.k === "rec"
                ? construct(a, init)
                : storeAt(a, t.to, expr(init));
          return `((${a} = ${expr(where)}), ${made}, ${a})`;
        }
        if (
          (e as { isArray?: boolean }).isArray === true ||
          (e as { isPlacement?: boolean }).isPlacement === true
        )
          throw new RaiseCError("an array or placement new");
        const t = typeOf(e);
        if (t.k !== "ptr") throw new RaiseCError("a new of a non-pointer");
        const a = temp({ k: "f64" });
        const init = kids[0];
        const made =
          init === undefined
            ? "undefined"
            : t.to.k === "rec"
              ? construct(a, init)
              : storeAt(a, t.to, expr(init));
        return `((${a} = __ykAlloc(${Math.max(1, sizeOf(t.to))}, ${Math.max(8, alignOf(t.to))})), ${made}, ${a})`;
      }
      // delete (C++): a null pointer, nothing; an object with a virtual destructor, its deleting
      // destructor from its vtable; any other, destroyed and freed.
      case "CXXDeleteExpr": {
        const t = typeOf(k0);
        if (t.k !== "ptr") throw new RaiseCError("a delete of a non-pointer");
        const p = temp({ k: "f64" });
        let gone: string;
        const slot = t.to.k === "rec" ? unitCxx?.deletingSlotOf(t.to.name) : undefined;
        if (slot !== undefined) {
          const vt = `__ykBigToF64(__ykI64(__ykLoad64(${p})))`;
          gone = `__ykFnAt(__ykBigToF64(__ykI64(__ykLoad64(${vt} + ${8 * slot}))))(${p})`;
        } else gone = [...destroy(p, t.to), `__ykFree(${p})`].join(", ");
        return `(((${p} = ${expr(k0)}) !== 0) ? (${gone}, undefined) : undefined)`;
      }
      case "CXXNullPtrLiteralExpr":
        return "0";
      // A throw (C++; no handler is raised): the program ends, as an uncaught exception does.
      case "CXXThrowExpr":
        externals.add("abort");
        return "abort()";
      // A method call (C++): the object's address, then the arguments.
      case "CXXMemberCallExpr": {
        const ret = claimRet(e);
        const m = stripCasts(k0);
        if (m.kind !== "MemberExpr") throw new RaiseCError(`a method call through ${m.kind}`);
        const base = (m.inner ?? [])[0] as ClangNode;
        let self: string;
        if ((m as { isArrow?: boolean }).isArrow === true) self = expr(base);
        else {
          const p = place(base);
          if (p.k !== "mem") throw new RaiseCError("a method called on an object not in memory");
          self = p.addr;
        }
        return methodCall(self, m, kids.slice(1), ret);
      }
      // An operator (C++): a member one is a method of its first operand; a free one, a call.
      case "CXXOperatorCallExpr": {
        const ret = claimRet(e);
        const callee = stripCasts(k0);
        const d = callee.referencedDecl;
        if (d?.kind === "CXXMethodDecl") {
          const p = place(kids[1] as ClangNode);
          if (p.k !== "mem") throw new RaiseCError("an operator of an object not in memory");
          return methodCall(p.addr, callee, kids.slice(2), ret);
        }
        const key = resolve({
          name: d?.name ?? "",
          kind: d?.kind ?? "",
          type: normType(d?.type?.qualType ?? ""),
          id: d?.id,
        });
        if (key === undefined) {
          throw new RaiseCError(`the operator ${d?.name ?? callee.kind} is not in the unit`);
        }
        return `${key}(${[...ret.slot(), ...kids.slice(1).map(argOf)].join(", ")})`;
      }
      case "ConditionalOperator":
        return `(${cond(k0)} ? ${expr(kids[1] as ClangNode)} : ${expr(kids[2] as ClangNode)})`;
      case "CallExpr": {
        const ret = claimRet(e);
        const callee = stripCasts(k0);
        // (The C library's builtins are its functions: `__builtin_memcpy` is memcpy.)
        const name = (callee.referencedDecl?.name ?? "").replace(
          /^__builtin_((?:mem|str)\w+)$/,
          "$1",
        );
        // std::move, forward, addressof, as_const (clang's builtins, C++): the object's address.
        // (Those the unit has no definition of: clang folds them.)
        if (
          /^(move|forward|addressof|__addressof|as_const)$/.test(name) &&
          kids.length === 2 &&
          resolve({
            name,
            kind: callee.referencedDecl?.kind ?? "",
            type: normType(callee.referencedDecl?.type?.qualType ?? ""),
            id: callee.referencedDecl?.id,
          }) === undefined
        )
          return argOf(kids[1] as ClangNode);
        // libstdc++'s throws and failed assertions: the program ends (no handler is raised).
        if (/^(__throw_\w+|__glibcxx_assert_fail)$/.test(name)) {
          externals.add("abort");
          return "abort()";
        }
        // (A record argument is passed by address: see argOf.)
        const args = kids
          .slice(1)
          .map((x) =>
            x.kind === "CXXDefaultArgExpr"
              ? "undefined"
              : typeOf(x).k === "rec" || typeOf(x).k === "arr"
                ? argOf(x)
                : expr(x),
          );
        // SSE2's integer intrinsics (x86-64's baseline; ada's and simdutf's fast paths): a vector
        // is its 16 bytes, and a vector made is a fresh object's address, as a record returned.
        if (
          /^_mm_(loadu_si128|set1_epi8|cmpeq_epi8|or_si128|and_si128|movemask_epi8)$/.test(name)
        ) {
          const xs = kids.slice(1);
          const r = temp({ k: "f64" });
          const alloc = `(${r} = __ykAlloc(16, 16))`;
          const at = (b: string, i: number): string => (i === 0 ? b : `(${b} + ${i})`);
          const lanes = Array.from({ length: 16 }, (_, i) => i);
          const operand = (x: ClangNode): string => {
            const v = temp({ k: "f64" });
            return `(${v} = ${argOf(x)})`;
          };
          switch (name) {
            case "_mm_loadu_si128": {
              const p = temp({ k: "f64" });
              return `(${alloc}, (${p} = ${expr(xs[0] as ClangNode)}), __ykStore64(${r}, __ykLoad64(${p})), __ykStore64(${at(r, 8)}, __ykLoad64(${at(p, 8)})), ${r})`;
            }
            case "_mm_set1_epi8": {
              const v = temp({ k: "i32" });
              return `(${alloc}, (${v} = ${expr(xs[0] as ClangNode)} & 255), ${lanes.map((i) => `__ykStore8(${at(r, i)}, ${v})`).join(", ")}, ${r})`;
            }
            case "_mm_cmpeq_epi8": {
              const a = operand(xs[0] as ClangNode);
              const b = operand(xs[1] as ClangNode);
              const [va, vb] = [a.slice(1, a.indexOf(" =")), b.slice(1, b.indexOf(" ="))];
              return `(${alloc}, ${a}, ${b}, ${lanes.map((i) => `__ykStore8(${at(r, i)}, __ykLoad8(${at(va, i)}) === __ykLoad8(${at(vb, i)}) ? 255 : 0)`).join(", ")}, ${r})`;
            }
            case "_mm_or_si128":
            case "_mm_and_si128": {
              const op = name === "_mm_or_si128" ? "|" : "&";
              const a = operand(xs[0] as ClangNode);
              const b = operand(xs[1] as ClangNode);
              const [va, vb] = [a.slice(1, a.indexOf(" =")), b.slice(1, b.indexOf(" ="))];
              return `(${alloc}, ${a}, ${b}, ${[0, 8].map((i) => `__ykStore64(${at(r, i)}, __ykLoad64(${at(va, i)}) ${op} __ykLoad64(${at(vb, i)}))`).join(", ")}, ${r})`;
            }
            default: {
              const a = operand(xs[0] as ClangNode);
              const va = a.slice(1, a.indexOf(" ="));
              return `(${a}, ${lanes.map((i) => `((__ykLoad8(${at(va, i)}) >>> 7) << ${i})`).join(" | ")})`;
            }
          }
        }
        if (name === "bit_cast") {
          const to = typeOf(e);
          const from = typeOf(kids[1] as ClangNode);
          if (to.k === "u64" && from.k === "f64") return `__ykF64Bits(${args[0]})`;
          if (to.k === "f64" && from.k === "u64") return `__ykF64FromBits(${args[0]})`;
          // Between integers of one width: the same bits, read as the other signedness.
          if (
            sizeOf(to) === sizeOf(from) &&
            to.k !== "f64" &&
            from.k !== "f64" &&
            to.k !== "f32" &&
            from.k !== "f32"
          )
            return convert(args[0] as string, from, to);
          throw new RaiseCError(`bit_cast from ${from.k} to ${to.k}`);
        }
        // A static member function named through an object (C++; `this->_S_copy(..)` in a
        // template): the function, the object unused.
        if (callee.kind === "MemberExpr" && !(typeOf(callee).k === "ptr")) {
          const id = (callee as { referencedMemberDecl?: string }).referencedMemberDecl;
          const base = stripCasts((callee.inner ?? [])[0] as ClangNode);
          const key =
            id === undefined || base.kind !== "CXXThisExpr"
              ? undefined
              : resolve({
                  name: callee.name ?? "",
                  kind: "CXXMethodDecl",
                  type: normType(callee.type?.qualType ?? ""),
                  id,
                });
          if (key === undefined)
            throw new RaiseCError(`a call of the method "${callee.name}" on an object`);
          return `${key}(${withDefaults(kids.slice(1), id).map(argOf).join(", ")})`;
        }
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
        // The checked arithmetic builtins: the exact result (as a bigint), stored at the third
        // argument in its type, and whether that changed it.
        const checked = (
          {
            __builtin_add_overflow: "+",
            __builtin_sub_overflow: "-",
            __builtin_mul_overflow: "*",
          } as Record<string, string | undefined>
        )[name];
        if (checked !== undefined && kids.length === 4) {
          const rt = typeOf(kids[3] as ClangNode);
          if (rt.k !== "ptr") throw new RaiseCError(`${name}'s result is not a pointer`);
          const R = rt.to;
          const big = (x: ClangNode): string =>
            wide(typeOf(x)) ? expr(x) : `__ykNumToBig(${expr(x)})`;
          const exact = temp({ k: "i64" });
          const out = temp(R);
          const narrowed =
            R.k === "i64"
              ? `__ykI64(${exact})`
              : R.k === "u64"
                ? `__ykU64(${exact})`
                : R.k === "u32"
                  ? `__ykBigToU32(${exact})`
                  : convert(`__ykBigToI32(${exact})`, { k: "i32" }, R);
          const back = wide(R) ? out : `__ykNumToBig(${out})`;
          return `((${exact} = ${big(kids[1] as ClangNode)} ${checked} ${big(kids[2] as ClangNode)}), (${out} = ${narrowed}), ${storeAt(expr(kids[3] as ClangNode), R, out)}, ${back} !== ${exact})`;
        }
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
        const index = callOrder.get(e);
        const key = resolve({
          name,
          kind: d.kind,
          type: normType(d.type?.qualType ?? ""),
          at: index === undefined ? undefined : { caller: symbolOf(fn), index },
          id: d.id,
        });
        const target = key ?? ident(name);
        if (key === undefined) externals.add(name);
        // C++: an argument bound to a reference parameter is its object's address; a default
        // argument, the callee's.
        if (fixed === undefined) callArgs = withDefaults(kids.slice(1), d.id).map(argOf);
        // (C++: a record returned is made in the caller's slot; the C library's, returned as C
        // does, is copied there.)
        if (fixed === undefined && ret.applies) {
          if (key !== undefined) return `${target}(${[...ret.slot(), ...callArgs].join(", ")})`;
          const into = ret.slot()[0] as string;
          const r = temp({ k: "f64" });
          return `((${r} = ${target}(${callArgs.join(", ")})), ${copyBytes(into, r, sizeOf(typeOf(e))).join(", ")}, __ykFree(${r}), ${into})`;
        }
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
        // A scalar in braces (`int64_t{x}`): its value (clang has converted it), or zero.
        if (t.k !== "arr" && t.k !== "rec") {
          const only = initItems(e)[0];
          return only === undefined ? zeroOf(t) : expr(only);
        }
        const items = initItems(e).map(expr);
        if (t.k === "arr" && t.size !== undefined)
          while (items.length < t.size) items.push(zeroOf(t.of));
        return `[${items.join(", ")}]`;
      }
      default:
        // A temporary record (C++: `std::string_view(p, n)`, a cleanup around one): made in a
        // frame slot, its address.
        if (
          [
            "CXXTemporaryObjectExpr",
            "CXXConstructExpr",
            "CXXBindTemporaryExpr",
            "MaterializeTemporaryExpr",
            "ExprWithCleanups",
          ].includes(e.kind) &&
          typeOf(e).k === "rec"
        ) {
          const t = typeOf(e);
          const slot = `__tmp${temps++}`;
          top.push(
            `const ${slot} = __ykAlloc(${Math.max(8, sizeOf(t))}, ${Math.max(8, alignOf(t))});`,
          );
          frame.push(slot);
          return `(${[...copyFrom(slot, t, e), slot].join(", ")})`;
        }
        if (e.kind === "ExprWithCleanups" || e.kind === "CXXBindTemporaryExpr") return expr(k0);
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
  const relocate = (to: string, from: string, t: CType, move: boolean): string[] => {
    // An object of a class that is not trivially copyable (C++), moved or copied to `to` from
    // `from`: its move (or copy) constructor; any other, its bytes.
    if (t.k === "rec" && unitCxx !== undefined && !unitCxx.trivialCopy(t.name)) {
      const ctor = unitCxx.copyCtorOf(t.name, move) ?? unitCxx.copyCtorOf(t.name, !move);
      if (ctor?.body === true) {
        const key = resolve({
          name: className(t.name),
          kind: "CXXConstructorDecl",
          type: "",
          id: ctor.id,
        });
        if (key !== undefined) return [`${key}(${to}, ${from})`];
      }
      // (One defined by default, with no body in the unit: its bytes, then each base and member
      // that is not trivially copyable moved or copied in turn; a union's bytes alone.)
      if (!/^union /.test(t.name)) {
        const l = layoutOf(t);
        const out = copyBytes(to, from, sizeOf(t));
        const at = (b: string, o: number): string => (o === 0 ? b : `(${b} + ${o})`);
        for (const [b, o] of l.bases ?? [])
          out.push(...relocate(at(to, o), at(from, o), { k: "rec", name: b }, move));
        for (const [, f] of l.fields) {
          const ft = isReferenceType(f.type) || f.bit !== undefined ? undefined : parseType(f.type);
          if (ft?.k === "rec")
            out.push(...relocate(at(to, f.offset), at(from, f.offset), ft, move));
        }
        return out;
      }
    }
    return copyBytes(to, from, sizeOf(t));
  };
  const copyFrom = (to: string, t: CType, src: ClangNode): string[] => {
    const made = constructed(src);
    if (made !== undefined) return [construct(to, made)];
    const s0 = unwrapTemporary(src);
    // A lambda (C++): its closure, each capture stored in its field.
    if (s0.kind === "LambdaExpr") {
      const inits = (s0.inner ?? []).slice(1, -1);
      const caps = inits.map((init) => ({
        byRef: (init as { valueCategory?: string }).valueCategory === "lvalue",
        type: init.type?.qualType ?? "",
      }));
      const base = temp({ k: "f64" });
      const steps = [`(${base} = ${to})`];
      closureFields(caps).forEach((f, i) => {
        const init = inits[i] as ClangNode;
        const at = f.offset === 0 ? base : `(${base} + ${f.offset})`;
        if (f.byRef) steps.push(`__ykStore64(${at}, __ykNumToBig(${argOf(init)}))`);
        else
          steps.push(
            ...initialize(at, parseType(caps[i]?.type ?? ""), init).map(
              (x) => `(${x.replace(/;$/, "")})`,
            ),
          );
      });
      return steps;
    }
    const from = temp({ k: "f64" });
    if (
      s0.kind === "CallExpr" ||
      s0.kind === "CXXMemberCallExpr" ||
      s0.kind === "CXXOperatorCallExpr"
    ) {
      // A call returning a reference (`std::move(x)`): the object it names, moved or copied.
      const cat = s0.valueCategory ?? "prvalue";
      if (cat !== "prvalue")
        return [`(${from} = ${expr(s0)})`, ...relocate(to, from, t, cat === "xvalue")];
      // C++: made where it goes (the call's return slot).
      if (unitCxx !== undefined) {
        pendingRet = to;
        const call = expr(s0);
        pendingRet = undefined;
        return [call];
      }
      return [`(${from} = ${expr(s0)})`, ...copyBytes(to, from, sizeOf(t)), `__ykFree(${from})`];
    }
    const sp = place(s0);
    if (sp.k !== "mem")
      throw new RaiseCError(
        `a record copied from one not in memory (${`${stripCasts(s0).kind} ${stripCasts(s0).referencedDecl?.name ?? stripCasts(s0).name ?? ""}`})`,
      );
    return [`(${from} = ${sp.addr})`, ...relocate(to, from, t, false)];
  };
  /** A C++ temporary's wrappers (cleanups, materialization, binding, casts) stripped. */
  const unwrapTemporary = (e: ClangNode): ClangNode => {
    let n = e;
    while (
      [
        "ExprWithCleanups",
        "MaterializeTemporaryExpr",
        "CXXBindTemporaryExpr",
        "ParenExpr",
        "CXXFunctionalCastExpr",
      ].includes(n.kind) ||
      ((n.kind === "ImplicitCastExpr" ||
        n.kind === "CStyleCastExpr" ||
        n.kind === "CXXStaticCastExpr") &&
        (n.castKind === "NoOp" ||
          n.castKind === "ConstructorConversion" ||
          n.castKind === "UserDefinedConversion"))
    ) {
      const k = (n.inner ?? [])[0];
      if (k === undefined) break;
      n = k;
    }
    return n;
  };
  /** The constructor call an object expression is (C++), if it is one. */
  const constructed = (e: ClangNode): ClangNode | undefined => {
    const n = unwrapTemporary(e);
    return n.kind === "CXXConstructExpr" || n.kind === "CXXTemporaryObjectExpr" ? n : undefined;
  };
  /** A constructor run on the object at `addr` (C++): an expression. */
  const construct = (addr: string, ce: ClangNode): string => {
    // An inheriting constructor's base (C++, `using Base::Base;`): the base's constructor of the
    // same type, given this constructor's parameters.
    if (ce.kind === "CXXInheritedCtorInitExpr") {
      const refs = params.map((p): ClangNode => {
        const pt = p.type?.desugaredQualType ?? p.type?.qualType ?? "";
        const isRef = isReferenceType(pt);
        const referred = pt.replace(/\s*&&?$/, "");
        const ref = {
          kind: "DeclRefExpr",
          type: { qualType: referred },
          valueCategory: "lvalue",
          referencedDecl: { id: p.id, kind: "ParmVarDecl", name: p.name, type: p.type },
        } as ClangNode;
        if (isRef || parseType(referred).k === "rec") return ref;
        return {
          kind: "ImplicitCastExpr",
          castKind: "LValueToRValue",
          type: { qualType: referred },
          valueCategory: "prvalue",
          inner: [ref],
        } as ClangNode;
      });
      return construct(addr, {
        kind: "CXXConstructExpr",
        type: ce.type,
        ctorType: { qualType: fn.type?.qualType ?? "" },
        inner: refs,
      } as ClangNode);
    }
    const t = typeOf(ce);
    if (t.k !== "rec") throw new RaiseCError(`a constructor of a ${t.k}`);
    const args = ce.inner ?? [];
    const ctorType = normType(
      (ce as { ctorType?: { qualType?: string } }).ctorType?.qualType ?? "",
    );
    const ctor = unitCxx?.constructorOf(t.name, ctorType);
    // (A copy or move the class does not declare, a lambda's closure's, or a trivial one: its
    // bytes.)
    if (
      (ctor === undefined || unitCxx?.trivialCopy(t.name) === true) &&
      args.length === 1 &&
      (() => {
        const at = typeOf(args[0] as ClangNode);
        return at.k === "rec" && recordKey(at.name) === recordKey(t.name);
      })()
    ) {
      const to = temp({ k: "f64" });
      const from = temp({ k: "f64" });
      return `((${to} = ${addr}), (${from} = ${argOf(args[0] as ClangNode)}), ${copyBytes(to, from, sizeOf(t)).join(", ")}, undefined)`;
    }
    if (ctor === undefined) throw new RaiseCError(`the constructor ${t.name}(${ctorType})`);
    const to = temp({ k: "f64" });
    if (!ctor.body) {
      // The implicit (or defaulted) constructors: the default one constructs each base and
      // member (its default initializer, or its class's default constructor); a copy or move,
      // each in turn (see relocate).
      if (args.length === 0) {
        if (unitCxx === undefined || /^union /.test(t.name)) return "undefined";
        const l = layoutOf(t);
        const at = (o: number): string => (o === 0 ? to : `(${to} + ${o})`);
        const steps: string[] = [];
        const dflt = (name: string): ClangNode =>
          ({
            kind: "CXXConstructExpr",
            type: { qualType: name },
            ctorType: { qualType: "void ()" },
            inner: [],
          }) as ClangNode;
        for (const [b, o] of l.bases ?? []) steps.push(construct(at(o), dflt(b)));
        for (const [name, f] of l.fields) {
          if (f.bit !== undefined || isReferenceType(f.type)) continue;
          const ft = parseType(f.type);
          const given = unitCxx.memberInitOf(t.name, name);
          if (given !== undefined)
            steps.push(
              ...initialize(at(f.offset), ft, given).map((x) => `(${x.replace(/;$/, "")})`),
            );
          else if (ft.k === "rec" && !/^union /.test(ft.name))
            steps.push(construct(at(f.offset), dflt(ft.name)));
        }
        return steps.length === 0
          ? "undefined"
          : `((${to} = ${addr}), ${steps.join(", ")}, undefined)`;
      }
      if (args.length === 1) {
        const from = temp({ k: "f64" });
        const a0 = args[0] as ClangNode;
        const move = /&&\s*\)/.test(ctorType) || (a0.valueCategory ?? "prvalue") !== "lvalue";
        return `((${to} = ${addr}), (${from} = ${argOf(a0)}), ${relocate(to, from, t, move).join(", ")}, undefined)`;
      }
      throw new RaiseCError(`the implicit constructor ${t.name}(${ctorType})`);
    }
    const key = resolve({
      name:
        t.name
          .replace(/^(struct|class|union) /, "")
          .split("::")
          .pop() ?? "",
      kind: "CXXConstructorDecl",
      type: ctorType,
      id: ctor.id,
    });
    if (key === undefined)
      throw new RaiseCError(`the constructor ${t.name}(${ctorType}) is not in the unit`);
    return `${key}(${[addr, ...withDefaults(args, ctor.id).map(argOf)].join(", ")})`;
  };
  /**
   * The destruction of the object at `addr` (C++): its destructor's body, then its members' and
   * bases' destructions, in reverse; nothing for a trivially destructible one. Expressions.
   */
  const destroy = (addr: string, t: CType): string[] => {
    if (t.k !== "rec" || unitCxx === undefined) return [];
    const l = unitLayout(recordKey(t.name));
    if (l === undefined) return [];
    const out: string[] = [];
    const dtor = unitCxx.destructorOf(t.name);
    if (dtor?.body) {
      const key = resolve({
        name: `~${className(t.name)}`,
        kind: "CXXDestructorDecl",
        type: "",
        id: dtor.id,
      });
      if (key === undefined) throw new RaiseCError(`the destructor of ${t.name}`);
      out.push(`${key}(${addr})`);
    }
    const at = (o: number): string => (o === 0 ? addr : `(${addr} + ${o})`);
    // (A union's members are not destroyed with it: its owner knows which one lives.)
    if (/^union /.test(t.name)) return out;
    for (const [, f] of [...l.fields].reverse()) {
      const ft = isReferenceType(f.type) ? undefined : parseType(f.type);
      if (ft?.k === "rec") out.push(...destroy(at(f.offset), ft));
    }
    for (const [b, o] of [...(l.bases ?? [])].reverse())
      out.push(...destroy(at(o), { k: "rec", name: b }));
    return out;
  };
  /**
   * An argument (C++): a value; bound to a reference, the address of the object it names, or of a
   * slot holding a temporary.
   */
  const argOf = (x: ClangNode): string => {
    const cat = (x as { valueCategory?: string }).valueCategory;
    // A record by value: a copy in a slot of this frame, its address.
    if (cat !== "lvalue" && cat !== "xvalue" && typeOf(x).k === "rec") {
      const t = typeOf(x);
      const slot = `__arg${temps++}`;
      top.push(`const ${slot} = __ykAlloc(${Math.max(8, sizeOf(t))}, ${Math.max(8, alignOf(t))});`);
      frame.push(slot);
      return `(${copyFrom(slot, t, x).join(", ")}, ${slot})`;
    }
    if (cat !== "lvalue" && cat !== "xvalue") return expr(x);
    let n = x;
    while (
      ((n.kind === "ImplicitCastExpr" && n.castKind === "NoOp") || n.kind === "ParenExpr") &&
      n.inner?.[0] !== undefined
    )
      n = n.inner[0] as ClangNode;
    if (n.kind === "MaterializeTemporaryExpr") {
      const t = typeOf(n);
      const slot = `__tmp${temps++}`;
      top.push(`const ${slot} = __ykAlloc(${Math.max(8, sizeOf(t))}, ${Math.max(8, alignOf(t))});`);
      frame.push(slot);
      const inner = (n.inner ?? [])[0] as ClangNode;
      if (t.k === "rec") return `(${copyFrom(slot, t, inner).join(", ")}, ${slot})`;
      return `(${storeAt(slot, t, expr(inner))}, ${slot})`;
    }
    const p = place(n);
    if (p.k !== "mem")
      throw new RaiseCError(
        `a reference to an object not in memory (${n.kind} ${stripCasts(n).referencedDecl?.name ?? ""} ${stripCasts(n).referencedDecl?.kind ?? ""})`,
      );
    return p.addr;
  };
  /** Arguments with a callee's default ones in place of clang's CXXDefaultArgExpr (C++). */
  const withDefaults = (args: readonly ClangNode[], fnId: string | undefined): ClangNode[] =>
    args.map((a, i) => {
      if (a.kind !== "CXXDefaultArgExpr") return a;
      const d = fnId === undefined ? undefined : unitCxx?.defaultArgOf(fnId, i);
      if (d === undefined) throw new RaiseCError("a default argument not found");
      return d;
    });
  /** A member function called on the object at `self` (C++). */
  const methodCall = (
    self: string,
    member: ClangNode,
    args: readonly ClangNode[],
    ret: Ret = noRet,
  ): string => {
    const id =
      (member as { referencedMemberDecl?: string }).referencedMemberDecl ??
      member.referencedDecl?.id;
    const name = member.name ?? member.referencedDecl?.name ?? "";
    // An explicit destructor call (`m_val.~T()`): the object's destruction (nothing, trivially).
    if (name.startsWith("~") && member.kind === "MemberExpr") {
      const base = (member.inner ?? [])[0] as ClangNode;
      const bt = typeOf(base);
      const t = (member as { isArrow?: boolean }).isArrow === true && bt.k === "ptr" ? bt.to : bt;
      const o = temp({ k: "f64" });
      const steps = destroy(o, t);
      return steps.length === 0
        ? `(${self}, undefined)`
        : `((${o} = ${self}), ${steps.join(", ")}, undefined)`;
    }
    // A virtual call (not one a qualifier names): the function in the object's vtable.
    const qualified = (member.inner ?? []).some((k) => k.kind === "NestedNameSpecifier");
    if (id !== undefined && !qualified && unitCxx?.isVirtual(id) === true) {
      const slot = unitCxx.slotOf(id);
      if (slot === undefined) throw new RaiseCError(`the vtable slot of ${name}`);
      const o = temp({ k: "f64" });
      const vt = `__ykBigToF64(__ykI64(__ykLoad64(${o})))`;
      const fnAt = `__ykBigToF64(__ykI64(__ykLoad64(${vt} + ${8 * slot})))`;
      return `((${o} = ${self}), __ykFnAt(${fnAt})(${[...ret.slot(), o, ...args.map(argOf)].join(", ")}))`;
    }
    const key = resolve({ name, kind: "CXXMethodDecl", type: "", id });
    if (key === undefined) throw new RaiseCError(`the method ${name} is not in the unit`);
    return `${key}(${[...ret.slot(), self, ...withDefaults(args, id).map(argOf)].join(", ")})`;
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
      const items: (ClangNode | undefined)[] = s === undefined ? [] : [...initItems(s)];
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
      for (const [name, f] of l.fields) {
        const ft = parseType(f.type);
        // (A member the list leaves to its default initializer, C++: that initializer.)
        if (items[i]?.kind === "CXXDefaultInitExpr") {
          const d = unitCxx?.memberInitOf(t.name, name);
          if (d === undefined) throw new RaiseCError(`the default initializer of ${name}`);
          items[i] = d;
        }
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
  // Each label's name, by its declaration id (for messages).
  const labelNames = new Map<string, string>();
  {
    const walk = (n: ClangNode): void => {
      if (n.kind === "LabelStmt")
        labelNames.set((n as { declId?: string }).declId ?? "", n.name ?? "");
      for (const k of n.inner ?? []) walk(k);
    };
    walk(fn);
  }
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
    const field = fields.get(memberName(e));
    if (field === undefined) throw new RaiseCError(`the union member ${e.name}`);
    return { word: declName(d), field };
  };
  const push = (s: string): void => {
    lines.push(s);
  };
  // C++: the objects each open block must destroy when left (in construction order), and the
  // loops and switches between them ("loop": a break or continue leaves the blocks inside one).
  const scopes: (string[] | "loop")[] = [];
  /** The destructions leaving the blocks back to (not past) the innermost loop, or all of them. */
  const leaving = (toLoop: boolean): string[] => {
    const out: string[] = [];
    for (let i = scopes.length - 1; i >= 0; i--) {
      const sc = scopes[i] as string[] | "loop";
      if (sc === "loop") {
        if (toLoop) break;
        continue;
      }
      out.push(...[...sc].reverse());
    }
    return out;
  };
  // Return: the value first, then the objects destroyed, then the frame freed.
  const returnLine = (value: string | undefined): void => {
    const dtors = leaving(false).map((d) => `${d};`);
    if (dtors.length > 0) {
      if (value === undefined)
        push(
          `{ ${dtors.join(" ")} ${[...frame]
            .reverse()
            .map((a) => `__ykFree(${a});`)
            .join(" ")} return; }`,
        );
      else {
        const r = temp(result);
        push(
          `{ ${r} = ${value}; ${dtors.join(" ")} ${[...frame]
            .reverse()
            .map((a) => `__ykFree(${a});`)
            .join(" ")} return ${r}; }`,
        );
      }
      return;
    }
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
  // A dispatched switch body's declaration (see guarded): its variables declared at the top.
  let hoisting = false;
  const hoisted = new Set<string>();
  /**
   * The switch being dispatched (see SwitchStmt): its target variable, its jump variable, its
   * targets' numbers, and how many loops or switches of its body the statement is inside.
   */
  interface Dispatch {
    sw: string;
    j: string;
    targets: Map<ClangNode, number>;
    depth: number;
    continues: boolean;
    /** The jumps out of the body (gotos), each made after it when the jump code is 3 + its index. */
    exits: { key: string; emit: () => void }[];
    /** The dispatched switch whose body this one is in. */
    parent: Dispatch | undefined;
    /** A block's region (a break leaves the loop around it), not a switch's (a break ends it). */
    block: boolean;
    /**
     * The block around the loop or switch of the body the statement is in, when a goto in it
     * names one of the body's labels: the goto breaks out of it.
     */
    exitLabel?: string | undefined;
  }
  let dispatch: Dispatch | undefined;
  const stmt = (s: ClangNode): void => {
    if (["ForStmt", "WhileStmt", "DoStmt", "SwitchStmt"].includes(s.kind)) {
      scopes.push("loop");
      try {
        stmtInLoop(s);
      } finally {
        scopes.pop();
      }
      return;
    }
    stmtInLoop(s);
  };
  const stmtInLoop = (s: ClangNode): void => {
    if (
      dispatch !== undefined &&
      ["ForStmt", "WhileStmt", "DoStmt", "SwitchStmt"].includes(s.kind)
    ) {
      const d = dispatch;
      // A goto from inside it to a label of the body: the loop in a block the goto leaves.
      const label = d.depth === 0 && gotoToTarget(d, s) ? `__dl${temps++}` : undefined;
      if (label !== undefined) {
        push(`${label}: do {`);
        d.exitLabel = label;
      }
      d.depth++;
      try {
        stmtOf(s);
      } finally {
        d.depth--;
        if (label !== undefined) {
          d.exitLabel = undefined;
          push("} while (false);");
        }
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
      const code = d.exits.push({ key: `return${d.exits.length}`, emit: () => push(jump) }) - 1;
      push(`${d.sw} = -1; ${d.j} = ${code + 3};`);
      return;
    }
    stmtOf(s);
  };
  /** Whether `s` has a jump of a dispatched switch's body (not of a loop or switch inside it). */
  const bodyJump = (s: ClangNode): boolean => {
    if (["BreakStmt", "ContinueStmt", "GotoStmt", "ReturnStmt"].includes(s.kind)) return true;
    if (["ForStmt", "WhileStmt", "DoStmt", "SwitchStmt"].includes(s.kind))
      return dispatch !== undefined && gotoToTarget(dispatch, s);
    return (s.inner ?? []).some(bodyJump);
  };
  /** Whether a goto inside `s` names a label of a dispatched switch's body. */
  const gotoToTarget = (d: Dispatch, s: ClangNode): boolean => {
    // (This region's labels, and those of the regions it is inside.)
    const labels = new Set<string>();
    for (let x: Dispatch | undefined = d; x !== undefined; x = x.parent)
      for (const n of x.targets.keys()) {
        const id = (n as { declId?: string }).declId;
        if (id !== undefined) labels.add(id);
      }
    const walk = (n: ClangNode): boolean =>
      (n.kind === "GotoStmt" &&
        labels.has((n as { targetLabelDeclId?: string }).targetLabelDeclId as string)) ||
      (n.inner ?? []).some(walk);
    return walk(s);
  };
  /**
   * A dispatched region (a switch's body, or a block a goto enters inside one of its statements):
   * its statements guarded by the target number (see guarded); a goto to one of its targets sets
   * the number and runs the region again; the jumps out are made after it. `start` sets the
   * number first (a switch maps its value to a case; a block starts at its top, 0).
   */
  const runDispatch = (
    b: ClangNode,
    targets: readonly ClangNode[],
    block: boolean,
    start: (sw: string) => void,
  ): void => {
    const outer = dispatch;
    const sw = `__sw${temps++}`;
    const j = `__j${temps++}`;
    top.push(`let ${sw} = -1;`, `let ${j} = 0;`);
    start(sw);
    const again = targets.some((n) => n.kind === "LabelStmt");
    if (again) push("while (true) {");
    push(`${j} = 0;`);
    const d: Dispatch = {
      sw,
      j,
      targets: new Map(targets.map((n, i) => [n, i + 1] as const)),
      depth: 0,
      continues: false,
      exits: [],
      parent: outer,
      block,
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
    // The jumps out, made here: in the region this one is inside (as one of its own statements,
    // not inside a loop of its body), or plainly. (A switch was counted as a loop of its region.)
    if (outer !== undefined && !block) outer.depth--;
    try {
      if (d.continues) {
        push(`if (${j} === 1) {`);
        stmtOf({ kind: "ContinueStmt" } as ClangNode);
        push("}");
      }
      d.exits.forEach((x, i) => {
        push(`if (${j} === ${i + 3}) {`);
        x.emit();
        push("}");
      });
    } finally {
      if (outer !== undefined && !block) outer.depth++;
    }
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
    const loop = ["ForStmt", "WhileStmt", "DoStmt", "SwitchStmt"].includes(s.kind);
    if (here.length === 0 && (jumps || loop || !bodyJump(s))) {
      if (s.kind === "NullStmt") return;
      if (s.kind === "DeclStmt") {
        // A declaration at the body's level: its variables live at the function's top (later
        // statements in other guards read them); its initialization is guarded.
        push(`if (${d.sw} === 0) {`);
        hoisting = true;
        try {
          stmt(s);
        } finally {
          hoisting = false;
        }
        push("}");
        return;
      }
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
  /** A block, with its forward and backward gotos as blocks and loops. */
  const compound = (s: ClangNode): void => {
    const kids = s.inner ?? [];
    push("{");
    const scope: string[] = [];
    scopes.push(scope);
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
      if (forward.has(i)) throw new RaiseCError("a label reached by gotos both forward and back");
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
    for (const d of [...scope].reverse()) push(`${d};`);
    scopes.pop();
    push("}");
    return;
  };
  const stmtOf = (s: ClangNode): void => {
    const kids = s.inner ?? [];
    switch (s.kind) {
      case "CompoundStmt": {
        // Gotos to labels inside this block's statements (into a branch, back into one): the
        // block dispatched, from its top.
        const into = blockTargets(s, false);
        if (into.length > 0) {
          push("{");
          runDispatch(s, into, true, (sw) => push(`${sw} = 0;`));
          push("}");
          return;
        }
        // The block's own forms (forward blocks, backward loops) first; where they cannot reach a
        // label, the block dispatched over all its gotos' labels.
        const at = lines.length;
        const depth = scopes.length;
        const saved = [new Map(forwardLabels), new Set(continueLabels), new Map(enterIf)] as const;
        try {
          compound(s);
        } catch (err) {
          const all = blockTargets(s, true);
          if (!(err instanceof RaiseCError) || !/goto/.test(err.message) || all.length === 0)
            throw err;
          // The first try undone: its lines, its blocks, and its gotos' labels.
          lines.length = at;
          scopes.length = depth;
          forwardLabels.clear();
          for (const [k, v] of saved[0]) forwardLabels.set(k, v);
          continueLabels.clear();
          for (const k of saved[1]) continueLabels.add(k);
          enterIf.clear();
          for (const [k, v] of saved[2]) enterIf.set(k, v);
          push("{");
          runDispatch(s, all, true, (sw) => push(`${sw} = 0;`));
          push("}");
        }
        return;
      }
      case "GotoStmt": {
        if (scopes.some((sc) => sc !== "loop" && sc.length > 0))
          throw new RaiseCError("a goto where objects would be destroyed");
        const target = (s as { targetLabelDeclId?: string }).targetLabelDeclId ?? "";
        if (dispatch !== undefined) {
          const d = dispatch;
          const targetOf = (x: Dispatch): number | undefined =>
            [...x.targets].find(([n]) => (n as { declId?: string }).declId === target)?.[1];
          const k = targetOf(d);
          if (k !== undefined) {
            if (d.depth > 0) {
              if (d.exitLabel === undefined)
                throw new RaiseCError("a goto into a switch body from a loop inside it");
              push(`${d.sw} = ${k}; ${d.j} = 2; break ${d.exitLabel};`);
              return;
            }
            push(`${d.sw} = ${k}; ${d.j} = 2;`);
            return;
          }
          // A label of a dispatched switch this one is inside: out of this body, then the goto
          // again, there.
          let up = d.parent;
          while (up !== undefined && targetOf(up) === undefined) up = up.parent;
          if (up !== undefined && (d.depth === 0 || d.exitLabel !== undefined)) {
            const key = `goto:${target}`;
            let code = d.exits.findIndex((x) => x.key === key);
            if (code < 0) code = d.exits.push({ key, emit: () => stmt(s) }) - 1;
            push(
              `${d.sw} = -1; ${d.j} = ${code + 3};${d.depth > 0 ? ` break ${d.exitLabel};` : ""}`,
            );
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
          throw new RaiseCError(
            `a goto into a block, or out of it (${(s as { targetLabelDeclId?: string }).targetLabelDeclId}: ${labelNames.get((s as { targetLabelDeclId?: string }).targetLabelDeclId ?? "") ?? ""})`,
          );
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
          let code = d.exits.findIndex((x) => x.key === jump);
          if (code < 0) code = d.exits.push({ key: jump, emit: () => push(jump) }) - 1;
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
      // A statement with attributes ([[fallthrough]], __attribute__((fallthrough))): the statement.
      case "AttributedStmt":
        stmt(kids[kids.length - 1] as ClangNode);
        return;
      case "DeclStmt":
        for (const d of kids) {
          // A compile-time declaration computes nothing; a typedef names a type for what follows.
          if (d.kind === "TypedefDecl") {
            localTypedefs.set(d.name ?? "", d.type?.desugaredQualType ?? d.type?.qualType ?? "");
            continue;
          }
          if (
            [
              "StaticAssertDecl",
              "TypeAliasDecl",
              "UsingDecl",
              "UsingDirectiveDecl",
              "UsingShadowDecl",
              "EnumDecl",
              // (A local class, C++: its member functions are the unit's, by id.)
              "CXXRecordDecl",
            ].includes(d.kind)
          )
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
          // A static whose initializer runs code (C++: `static std::u32string s = U"";`):
          // initialized the first time its declaration is reached, then a guard says so.
          if (d.storageClass === "static" && initializerRuns(d) !== undefined) {
            const key = unitStatic?.(d, fn.name, true);
            if (key === undefined) throw new RaiseCError(`the static variable "${d.name}"`);
            const addr = `__ykStatic(${JSON.stringify(key)})`;
            const guard = `__ykStatic(${JSON.stringify(`${key}#guard`)})`;
            vars.set(d.id ?? "", t);
            mems.set(d.id ?? "", { k: "mem", addr, t });
            push(`if (__ykLoad8(${guard}) === 0) {`);
            for (const line of initialize(addr, t, initOf(d))) push(line);
            push(`__ykStore8(${guard}, 1);`);
            push("}");
            continue;
          }
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
          if (
            isMem(d, t) &&
            d.storageClass === "static" &&
            /\bconst\b/.test(d.type?.qualType ?? "") &&
            t.k === "arr" &&
            t.of.k !== "arr" &&
            t.of.k !== "rec" &&
            init !== undefined &&
            stripParens(init).kind === "InitListExpr" &&
            !mems.has(d.id ?? "")
          ) {
            // A static constant array in memory: its elements laid out in constant memory, once
            // (static storage: the same address every call), not a frame filled on each call.
            const name = declName(d);
            push(`let ${name} = ${expr(init)};`);
            const addr = `${name}_d`;
            push(`const ${addr} = __ykData("${dataKind(t.of)}", ${name});`);
            mems.set(d.id ?? "", { k: "mem", addr, t });
            continue;
          }
          // A reference (C++): the address of what it binds to (itself never in memory).
          if (init !== undefined && isReferenceType(d.type?.qualType ?? "")) {
            push(`let ${declName(d)} = ${argOf(init)};`);
            continue;
          }
          if (isMem(d, t)) {
            const p = memOf(d, t);
            // An object with no initializer has an indeterminate value (C11 6.7.9p10): its frame
            // block, zeroed when allocated, is not filled again.
            if (init !== undefined) for (const line of initialize(p.addr, t, init)) push(line);
            // C++: an object with a destructor is destroyed when its block is left.
            // (Not the named return value: it is the caller's.)
            const dtor = t.k === "rec" && p.addr !== "__ret" ? destroy(p.addr, t) : [];
            const scope = scopes[scopes.length - 1];
            if (dtor.length > 0 && scope !== undefined && scope !== "loop")
              scope.push(dtor.join(", "));
            continue;
          }
          if (hoisting) {
            // (Once: a block raised twice, its first try rolled back, declares it again.)
            if (!hoisted.has(declName(d))) {
              hoisted.add(declName(d));
              top.push(`let ${declName(d)} = ${zeroOf(t)};`);
            }
            if (init !== undefined) push(`${declName(d)} = ${expr(init)};`);
            continue;
          }
          push(`let ${declName(d)} = ${init !== undefined ? expr(init) : zeroOf(t)};`);
        }
        return;
      case "ReturnStmt": {
        const v = kids[0];
        if (v !== undefined && result.k === "rec") {
          if (sret) {
            const s1 = stripCasts(v);
            // (The named return value, through the move clang writes around it.)
            let named = unwrapTemporary(s1);
            if (
              (named.kind === "CXXConstructExpr" || named.kind === "CXXFunctionalCastExpr") &&
              (named.inner ?? []).length === 1
            )
              named = stripCasts(unwrapTemporary((named.inner ?? [])[0] as ClangNode));
            const nrvo =
              named.kind === "DeclRefExpr" &&
              mems.get(named.referencedDecl?.id ?? "")?.addr === "__ret";
            const made = nrvo
              ? []
              : s1.kind === "InitListExpr"
                ? initialize("__ret", result, s1).map((x) => `(${x.replace(/;$/, "")})`)
                : copyFrom("__ret", result, v);
            returnLine(`(${[...made, "__ret"].join(", ")})`);
            return;
          }
          // A record returned: a fresh copy's address (the caller copies it and frees it).
          const out = temp({ k: "f64" });
          const s0 = stripCasts(v);
          const lit = s0.kind === "CompoundLiteralExpr" ? (s0.inner ?? [])[0] : s0;
          // (A local returned, named return value: moved out, as it dies with the function.)
          const local =
            s0.kind === "DeclRefExpr" &&
            s0.referencedDecl?.kind === "VarDecl" &&
            !isGlobal(s0.referencedDecl as ClangNode)
              ? place(s0)
              : undefined;
          const fill =
            s0.kind === "InitListExpr" || s0.kind === "CompoundLiteralExpr"
              ? initialize(out, result, lit).map((x) => `(${x.replace(/;$/, "")})`)
              : local?.k === "mem"
                ? relocate(out, local.addr, result, true)
                : copyFrom(out, result, s0);
          returnLine(
            `((${out} = __ykAlloc(${sizeOf(result)}, ${alignOf(result)})), ${fill.join(", ")}, ${out})`,
          );
          return;
        }
        // A function returning a reference (C++) returns the address of what it names.
        // (Or one spelled through an alias, `_If_sv<T, basic_string &>`: an object for an
        // address.)
        const vt = v === undefined ? undefined : typeOf(v);
        if (
          v !== undefined &&
          (/&\s*\(/.test(fn.type?.qualType ?? "") ||
            isReferenceType(returnTypeOf(fn.type?.qualType ?? "")) ||
            // (An lvalue that is not a pointer, returned as one: a reference, its type a
            // typedef's, `const_reference`.)
            (result.k === "ptr" &&
              vt !== undefined &&
              vt.k !== "ptr" &&
              vt.k !== "fn" &&
              v.valueCategory === "lvalue"))
        ) {
          returnLine(argOf(v));
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
        for (const d of leaving(true)) push(`${d};`);
        if (dispatch !== undefined && dispatch.depth === 0) {
          const d = dispatch;
          if (d.block) {
            // A break of the loop around a block's region: made after the region.
            let code = d.exits.findIndex((x) => x.key === "break");
            if (code < 0)
              code =
                d.exits.push({
                  key: "break",
                  emit: () => stmtOf({ kind: "BreakStmt" } as ClangNode),
                }) - 1;
            push(`${d.sw} = -1; ${d.j} = ${code + 3};`);
          } else push(`${d.sw} = -1;`);
        } else push("break;");
        return;
      case "ContinueStmt":
        for (const d of leaving(true)) push(`${d};`);
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
          const t = typeOf(c);
          runDispatch(b, targets, false, (sw) => {
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
          });
          return;
        }
        const outer = switchType;
        switchType = typeOf(c);
        // Declarations before the first case (in scope for the whole body, never run): before it.
        const items = b.inner ?? [];
        const first = items.findIndex((k) => k.kind === "CaseStmt" || k.kind === "DefaultStmt");
        for (const item of items.slice(0, Math.max(0, first)))
          if (item.kind === "DeclStmt") stmt(item);
          else if (item.kind !== "NullStmt")
            throw new RaiseCError("a statement before a switch's first case");
        push(`switch (${expr(c)}) {`);
        for (const item of items.slice(Math.max(0, first))) caseItem(item);
        push("}");
        switchType = outer;
        return;
      }
      default:
        if (
          s.kind.endsWith("Operator") ||
          s.kind.endsWith("Expr") ||
          s.kind === "ExprWithCleanups"
        ) {
          // (An object named and not used, C++'s `*this;` after an assignment: its address,
          // evaluated for what computing it does.)
          const st = typeOf(s);
          if ((st.k === "rec" || st.k === "arr") && s.valueCategory === "lvalue") {
            const p = place(s);
            push(`${p.k === "mem" ? p.addr : "undefined"};`);
            return;
          }
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
    ...(sret ? ["__ret: number"] : []),
    ...(method ? ["__this: number"] : []),
    ...params.map((p) => `${declName(p)}: ${tsType(ctype(p.type))}`),
    ...(variadic ? ["__va: number"] : []),
  ].join(", ");
  // C passes arguments by value: a parameter assigned in the body is a local. A parameter whose
  // address is taken is copied into its slot.
  const entry: string[] = [];
  for (const p of params) {
    const t = ctype(p.type);
    // A record by value: the address of the caller's copy (see argOf), the record itself.
    if (t.k === "rec") {
      mems.set(p.id ?? "", { k: "mem", addr: declName(p), t });
      continue;
    }
    if (!inMemory.has(p.id ?? "")) continue;
    const name = declName(p);
    const slot = memOf(p, t);
    entry.push(`${storeAt(slot.addr, t, name)};`);
  }
  // A constructor's base initializers, then its vtable pointer, then its member initializers,
  // before its body; a destructor's vtable pointer is its own class's again, first.
  const inits = (fn.inner ?? []).filter((c) => c.kind === "CXXCtorInitializer");
  const baseFirst = [
    ...inits.filter((i) => (i as { baseInit?: unknown }).baseInit !== undefined),
    undefined,
    ...inits.filter((i) => (i as { baseInit?: unknown }).baseInit === undefined),
  ];
  const vptrAt = thisRecord === undefined ? undefined : vptrOf(thisRecord);
  const setVptr = (): string =>
    `__ykStore64(${vptrAt === 0 ? "__this" : `(__this + ${vptrAt})`}, __ykNumToBig(__ykStatic(${JSON.stringify(unitCxx?.vtableOf(thisRecord as string, destroy))})));`;
  if (fn.kind === "CXXDestructorDecl" && vptrAt !== undefined) entry.push(setVptr());
  for (const init of fn.kind === "CXXConstructorDecl" ? baseFirst : []) {
    if (init === undefined) {
      if (vptrAt !== undefined) entry.push(setVptr());
      continue;
    }
    const rec: CType = { k: "rec", name: thisRecord as string };
    const l = layoutOf(rec);
    const any = (init as { anyInit?: { name?: string; id?: string } }).anyInit;
    let value = (init.inner ?? [])[0];
    if (value?.kind === "CXXDefaultInitExpr" && any?.id !== undefined) {
      value = unitCxx?.fieldInitOf(any.id);
      if (value === undefined) throw new RaiseCError(`the default initializer of ${any.name}`);
    }
    const base = (init as { baseInit?: { qualType?: string } }).baseInit;
    if (any !== undefined) {
      const f = l.fields.get(any.name ?? "") ?? throughAnonymous(l, any.name ?? "");
      if (f === undefined) throw new RaiseCError(`the member ${any.name} initialized`);
      const at = f.offset === 0 ? "__this" : `(__this + ${f.offset})`;
      if (isReferenceType(f.type))
        entry.push(`${storeAt(at, { k: "ptr", to: { k: "void" } }, argOf(value as ClangNode))};`);
      else entry.push(...initialize(at, parseType(f.type), value));
    } else if (base !== undefined) {
      // (A base named by a typedef or an alias, `allocator_type`: the class it names; an empty
      // one the dump leaves out is at the start.)
      let named: CType | undefined;
      try {
        named = parseType(base.qualType ?? "");
      } catch {
        named = undefined;
      }
      // (Or by its constructor's type, and with arguments the dump leaves out.)
      const made = value === undefined ? undefined : typeOf(value);
      const baseAt = (name: string): number | undefined => {
        const key = recordKey(name);
        const exact = l.bases?.get(key);
        if (exact !== undefined) return exact;
        for (const [k, o] of l.bases ?? []) if (argsPrefix(k, key)) return o;
        return undefined;
      };
      let emptyBase = false;
      try {
        emptyBase =
          named?.k === "rec" && layoutOf(named).fields.size === 0 && layoutOf(named).size <= 1;
      } catch {
        emptyBase = made?.k === "rec" && unitLayout(recordKey(made.name)) === undefined;
      }
      const off =
        baseAt(`struct ${base.qualType ?? ""}`) ??
        baseAt(`class ${base.qualType ?? ""}`) ??
        (named?.k === "rec" ? baseAt(named.name) : undefined) ??
        (made?.k === "rec" ? baseAt(made.name) : undefined) ??
        (emptyBase ? 0 : undefined);
      if (off === undefined)
        throw new RaiseCError(
          `the base ${base.qualType} (of ${thisRecord}: ${[...(l.bases?.keys() ?? [])].join("; ")})`,
        );
      entry.push(`${construct(off === 0 ? "__this" : `(__this + ${off})`, value as ClangNode)};`);
    } else if ((init as { delegatingInit?: unknown }).delegatingInit !== undefined) {
      // A delegating constructor (C++): the other constructor, on this object.
      entry.push(`${construct("__this", value as ClangNode)};`);
    } else throw new RaiseCError("a constructor's initializer of another kind");
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

/**
 * The labels a block's dispatch enters (see CompoundStmt), when a goto in the block names a
 * label inside one of its statements (not a loop or switch of it) that the block's own forms do
 * not reach: a branch's first label reached only from earlier statements (a forward goto into a
 * then branch) is the if's. None when no such goto.
 */
function blockTargets(block: ClangNode, all: boolean): ClangNode[] {
  const kids = block.inner ?? [];
  const gotos = new Map<string, number[]>(); // label id -> the indices of the children with gotos to it
  kids.forEach((k, i) => {
    const walk = (n: ClangNode): void => {
      if (n.kind === "GotoStmt") {
        const t = (n as { targetLabelDeclId?: string }).targetLabelDeclId ?? "";
        gotos.set(t, [...(gotos.get(t) ?? []), i]);
      }
      for (const c of n.inner ?? []) walk(c);
    };
    walk(k);
  });
  const labels: ClangNode[] = [];
  let nested = false;
  kids.forEach((k, i) => {
    const walk = (n: ClangNode, depth: number, firstOfThen: boolean): void => {
      if (["ForStmt", "WhileStmt", "DoStmt", "SwitchStmt"].includes(n.kind)) return;
      if (n.kind === "LabelStmt") {
        const id = (n as { declId?: string }).declId ?? "";
        const from = gotos.get(id);
        if (from !== undefined) {
          labels.push(n);
          if (depth > 0 && !(firstOfThen && from.every((j) => j < i))) nested = true;
        }
      }
      const inner = n.inner ?? [];
      inner.forEach((c, ci) => {
        const then = n.kind === "IfStmt" && ci === 1;
        const first =
          then &&
          (c.kind === "LabelStmt" ||
            (c.kind === "CompoundStmt" && c.inner?.[0]?.kind === "LabelStmt"));
        walk(
          c,
          depth + (n.kind === "LabelStmt" ? 0 : 1),
          first || (firstOfThen && n.kind === "CompoundStmt" && ci === 0),
        );
      });
    };
    walk(k, 0, false);
  });
  return nested || all ? labels : [];
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
  // A large unit (an amalgamation), and any C++ one, is dumped once and indexed by declaration id;
  // a small C one, filtered per name.
  const large =
    /\+\+$/.test(clang) ||
    statSync(file).size > 2_000_000 ||
    execFileSync(clang, [...args, "-E", file], {
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "ignore"],
    }).length > 1_000_000;
  const indexed = large ? indexUnit(clang, args, file) : undefined;
  // The roots, as the filters name them; in an indexed unit, the index's own nodes (its ids).
  const roots = clangFunctions(file, filters, args, clang);
  if (indexed !== undefined)
    for (const [name, fn] of roots) {
      const m = (fn as { mangledName?: string }).mangledName;
      const def =
        (m !== undefined ? indexed.byMangled.get(m) : undefined) ??
        (indexed.byName.get(name) ?? []).find((d) => d.body && FUNCTION_KINDS.has(d.kind));
      if (def !== undefined) roots.set(name, readDecl(indexed, def));
    }
  const dumps = new Map<string, ClangNode[]>();
  const found = new Map<string, ClangNode>(); // key -> declaration
  const keyOf = new Map<string, string>(); // name + type -> key
  const sig = (name: string, type: string): string => `${name} :: ${normType(type)}`;
  const keyBySymbol = new Map<string, string>(); // mangled name -> key (template instances)
  const keyById = new Map<string, string>(); // declaration id (an indexed unit's) -> key
  for (const [name, fn] of roots) {
    found.set(name, fn);
    keyOf.set(sig(name, fn.type?.qualType ?? ""), name);
    keyBySymbol.set(symbolOf(fn), name);
    if (fn.id !== undefined) keyById.set(fn.id, name);
  }
  // The unit's calls by caller, as code generation emits them (no inlining): each callee's symbol.
  let calls: Map<string, string[]> | undefined;
  let irText: string | undefined;
  const unitIR = (): string => {
    irText ??= execFileSync(
      clang,
      [...args, "-S", "-emit-llvm", "-O0", "-Xclang", "-disable-llvm-passes", "-o", "-", file],
      { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] },
    );
    return irText;
  };
  const irCalls = (caller: string): string[] => {
    if (calls === undefined) {
      calls = new Map();
      const ir = unitIR();
      let current: string[] | undefined;
      for (const line of ir.split("\n")) {
        const def = /^define .*?@("?)([^\s("]+)\1\(/.exec(line);
        if (def !== null) {
          current = [];
          calls.set(def[2] as string, current);
        } else if (line === "}") current = undefined;
        else if (current !== undefined) {
          const call = /\b(?:call|invoke) [^@]*@("?)([^\s("]+)\1\(/.exec(line);
          if (call !== null) current.push(call[2] as string);
        }
      }
    }
    return calls.get(caller) ?? [];
  };
  /** The unit's top-level declarations in order, each parsed in turn (an indexed unit's). */
  const eachDecl = function* (kinds?: ReadonlySet<string>): Generator<ClangNode> {
    if (indexed === undefined) {
      yield wholeUnit();
      return;
    }
    for (let i = 0; i < indexed.decls.length; i++)
      if (kinds === undefined || kinds.has((indexed.decls[i] as IndexedDecl).kind))
        yield readDecl(indexed, indexed.decls[i] as IndexedDecl);
  };
  const dumpOf = (name: string): ClangNode[] => {
    let nodes = dumps.get(name);
    if (nodes === undefined && indexed !== undefined) {
      nodes = (indexed.byName.get(name) ?? []).map((d) => readDecl(indexed, d));
      dumps.set(name, nodes);
    }
    if (nodes === undefined) {
      nodes = [];
      const json = clangDump(clang, [
        ...args,
        "-fsyntax-only",
        "-Xclang",
        "-ast-dump=json",
        "-Xclang",
        `-ast-dump-filter=${name}`,
        file,
      ]);
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
  /** The definitions of a name and type: more than one when template instances share them. */
  const candidates = new Map<string, ClangNode[]>();
  const lookup = (c: Callee): { decl: ClangNode | undefined; ambiguous: boolean } => {
    let all = candidates.get(sig(c.name, c.type));
    if (all === undefined) {
      const hits: ClangNode[] = [];
      const walk = (n: ClangNode): void => {
        if (
          (n.kind === "FunctionDecl" || n.kind === "CXXMethodDecl") &&
          n.name === c.name &&
          normType(n.type?.qualType ?? "") === c.type &&
          body(n) !== undefined
        ) {
          if (!hits.some((h) => symbolOf(h) === symbolOf(n))) hits.push(n);
          return;
        }
        for (const k of n.inner ?? []) walk(k);
      };
      for (const n of dumpOf(c.name)) walk(n);
      all = hits;
      candidates.set(sig(c.name, c.type), all);
    }
    if (all.length <= 1 || c.at === undefined) return { decl: all[0], ambiguous: all.length > 1 };
    // Template instances alike in name and type: the one this call calls, by the IR.
    const length = String(c.name.length);
    const called = irCalls(c.at.caller).filter((s) => s.includes(`${length}${c.name}`))[c.at.index];
    const decl = all.find((d) => symbolOf(d) === called);
    if (decl === undefined)
      throw new RaiseCError(
        `the instance of ${c.name} a call calls (${called ?? "not in the IR"})`,
      );
    return { decl, ambiguous: true };
  };
  const resolve: CalleeResolver = (c) => {
    // An indexed unit: the declaration the reference names, through its redeclarations.
    if (indexed !== undefined && c.id !== undefined) {
      const byId = keyById.get(c.id);
      if (byId !== undefined) return byId;
      const def = definitionIn(indexed, c.id);
      if (def !== undefined) {
        const already = keyById.get(def.id);
        if (already !== undefined) {
          keyById.set(c.id, already);
          return already;
        }
        const decl = readDecl(indexed, def);
        const base =
          decl.kind === "FunctionDecl" && decl.storageClass === "static"
            ? `${ident(c.name)}__${(unit.split("/").pop() ?? unit).replace(/\.\w+$/, "").replace(/\W/g, "_")}`
            : ident(c.name);
        let key = base;
        for (let n = 2; found.has(key); n++) key = `${base}_${n}`;
        found.set(key, decl);
        keyById.set(c.id, key);
        keyById.set(def.id, key);
        keyBySymbol.set(symbolOf(decl), key);
        return key;
      }
    }
    const known = keyOf.get(sig(c.name, c.type));
    const { decl, ambiguous } = lookup(c);
    if (!ambiguous && known !== undefined) return known;
    if (decl === undefined) return undefined;
    const bySymbol = keyBySymbol.get(symbolOf(decl));
    if (bySymbol !== undefined) return bySymbol;
    // A static function's name is its unit's alone (strtol.c's strtox is not strtod.c's): its key
    // carries the unit's.
    const base =
      decl.kind === "FunctionDecl" && decl.storageClass === "static"
        ? `${ident(c.name)}__${(unit.split("/").pop() ?? unit).replace(/\.\w+$/, "").replace(/\W/g, "_")}`
        : ident(c.name);
    let key = base;
    for (let n = 2; found.has(key); n++) key = `${base}_${n}`;
    found.set(key, decl);
    keyBySymbol.set(symbolOf(decl), key);
    if (!ambiguous) keyOf.set(sig(c.name, c.type), key);
    return key;
  };
  const resolveGlobal: GlobalResolver = (name, type, id) => {
    // An indexed unit: the declaration the reference names (a class template instance's static
    // member, not its pattern's), through its redeclarations, the one with an initializer.
    if (indexed !== undefined && id !== undefined && indexed.byId.has(id)) {
      let first = id;
      for (let g = 0; indexed.previous.has(first) && g < 1000; g++)
        first = indexed.previous.get(first) as string;
      for (let at: string | undefined = first, g = 0; at !== undefined && g < 1000; g++) {
        const d = indexed.byId.get(at);
        if (d !== undefined && d.kind === "VarDecl") {
          const n = readDecl(indexed, d);
          if (initOf(n) !== undefined) return n;
        }
        at = indexed.next.get(at);
      }
    }
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
  /**
   * A class's definition by its record type (`struct v8::base::Magic<uint32_t>`): the record of
   * its name; a class template's instance, the one with its arguments.
   */
  const findRecord = (record: string): ClangNode | undefined => {
    if (indexed === undefined) return undefined;
    const bare = record.replace(/^(struct|class|union) /, "");
    // (An integer argument without its suffix: `256UL` is `256`; a bool as clang's dump has it,
    // `true` as -1 or 1.)
    const canon = (t: string): string =>
      recordKey(t)
        .replace(/\s+/g, "")
        .replace(/^(-?\d+)[uUlL]*$/, "$1")
        .replace(/^true$/, "1")
        .replace(/^false$/, "0");
    const argsOf = (node: ClangNode): string[] =>
      (node.inner ?? [])
        .filter((a) => a.kind === "TemplateArgument")
        .map((a) => {
          const v = canon(a.type?.qualType ?? String((a as { value?: unknown }).value ?? ""));
          return v === "-1" && a.type === undefined ? "1" : v;
        });
    // The candidate whose arguments these are (a type spelled without its default arguments,
    // `basic_string_view<char>`: the ones it spells).
    const pick = (candidates: Iterable<ClangNode>, name: string): ClangNode | undefined => {
      const lt = name.indexOf("<");
      const want =
        lt < 0 ? [] : splitTemplateArgs(name.slice(lt + 1, name.lastIndexOf(">"))).map(canon);
      for (const node of candidates) {
        if ((node as { completeDefinition?: boolean }).completeDefinition !== true) continue;
        const args = argsOf(node);
        if (
          args.length >= want.length &&
          args.slice(0, want.length).join(",") === want.join(",") &&
          (want.length > 0 || args.length === 0)
        )
          return node;
      }
      return undefined;
    };
    // A class nested in a class template's instance (`std::basic_string<char>::_Alloc_hider`,
    // `_Optional_payload_base<T>::_Storage<T>`): the member class, or member class template's
    // instance, of that name in the instance.
    let depth = 0;
    let cut = -1;
    for (let i = 0; i < bare.length; i++) {
      const c = bare[i];
      if (c === "<") depth++;
      else if (c === ">") depth--;
      else if (c === ":" && bare[i + 1] === ":" && depth === 0) cut = i;
    }
    if (cut > 0 && bare.slice(0, cut).includes("<")) {
      const outer = findRecord(`struct ${bare.slice(0, cut)}`);
      const name = bare.slice(cut + 2);
      const plain = name.replace(/<.*$/, "");
      const members = (outer?.inner ?? []).flatMap((c) =>
        c.kind === "ClassTemplateDecl" && c.name === plain
          ? (c.inner ?? []).filter((x) => x.kind === "ClassTemplateSpecializationDecl")
          : RECORD_KINDS.has(c.kind ?? "") && c.name === plain
            ? [c]
            : [],
      );
      return pick(members, name);
    }
    const lt = bare.indexOf("<");
    const base = (lt < 0 ? bare : bare.slice(0, lt)).split("::").pop() ?? "";
    function* candidates(): Generator<ClangNode> {
      for (const d of (indexed as UnitIndex).byName.get(base) ?? [])
        if (RECORD_KINDS.has(d.kind)) yield readDecl(indexed as UnitIndex, d);
    }
    return pick(candidates(), bare);
  };
  const typedefScopes = new Map<string, Map<string, string>>();
  // C++: classes, from the index.
  const cxx: CxxUnit | undefined =
    indexed === undefined
      ? undefined
      : {
          classOf: (fnId) => {
            const parent = indexed.byId.get(fnId)?.parent;
            const cls = parent === undefined ? undefined : indexed.byId.get(parent);
            if (cls === undefined || !RECORD_KINDS.has(cls.kind)) return undefined;
            // A class template's instance: its name with its arguments; a class nested in one,
            // qualified by it.
            const named = (c: IndexedDecl, depth: number): string => {
              const args =
                c.kind === "ClassTemplateSpecializationDecl"
                  ? (readDecl(indexed, c).inner ?? [])
                      .filter((a) => a.kind === "TemplateArgument")
                      .map((a) => {
                        if (a.type?.qualType !== undefined) return a.type.qualType;
                        // (A bool's true is dumped as -1.)
                        const v = String((a as { value?: unknown }).value ?? "");
                        return v === "-1" ? "1" : v;
                      })
                  : [];
              const own = `${c.name}${args.length > 0 ? `<${args.join(", ")}>` : ""}`;
              // (A local class, inside a function, is named alone, as the dump names it.)
              const outer =
                c.parent === undefined || c.owner !== undefined
                  ? undefined
                  : indexed.byId.get(c.parent);
              return outer !== undefined && RECORD_KINDS.has(outer.kind) && depth < 8
                ? `${named(outer, depth + 1)}::${own}`
                : own;
            };
            return `${cls.tag ?? "struct"} ${named(cls, 0)}`;
          },
          constructorOf: (record, type) => {
            // (Local classes of one name, libstdc++'s `_Guard` in each instance: each, until one
            // has a constructor of this type.)
            const plainName = record.replace(/^(struct|class|union) /, "");
            const nodes = [
              findRecord(record),
              ...(/^[A-Za-z_]\w*$/.test(plainName)
                ? (indexed.byName.get(plainName) ?? [])
                    .filter((d) => RECORD_KINDS.has(d.kind) && d.owner !== undefined)
                    .map((d) => readDecl(indexed, d))
                : []),
            ];
            // Its constructors, and its constructor templates' instances; by type (scopes
            // aside: a type can be spelled with or without them).
            const bare = (t: string): string =>
              normType(t.replace(/\b[A-Za-z_]\w*::/g, "").replace(/\s*\bnoexcept\b(\(.*\))?$/, ""));
            const all = nodes.flatMap((node) =>
              (node?.inner ?? []).flatMap((c) =>
                c.kind === "FunctionTemplateDecl" ? (c.inner ?? []) : [c],
              ),
            );
            // (A constructor template's own declaration in the instance has the type of its
            // instance: the one defined.)
            const matching = (same: (t: string) => boolean): ClangNode | undefined => {
              const hits = all.filter(
                (c) => c.kind === "CXXConstructorDecl" && same(c.type?.qualType ?? ""),
              );
              return hits.find((c) => definitionIn(indexed, c.id ?? "") !== undefined) ?? hits[0];
            };
            const ctor =
              matching((t) => normType(t) === normType(type)) ??
              matching((t) => bare(t) === bare(type));
            return ctor === undefined
              ? undefined
              : { id: ctor.id ?? "", body: definitionIn(indexed, ctor.id ?? "") !== undefined };
          },
          destructorOf: (record) => {
            const dtor = (findRecord(record)?.inner ?? []).find(
              (c) => c.kind === "CXXDestructorDecl",
            );
            return dtor === undefined
              ? undefined
              : { id: dtor.id ?? "", body: definitionIn(indexed, dtor.id ?? "") !== undefined };
          },
          lambdaOf: (methodId) => {
            const m = indexed.byId.get(methodId);
            const cls = m?.parent === undefined ? undefined : indexed.byId.get(m.parent);
            const owner = cls?.owner === undefined ? undefined : indexed.byId.get(cls.owner);
            if (cls === undefined || owner === undefined || cls.name !== "") return undefined;
            let lambda: ClangNode | undefined;
            const walk = (n: ClangNode): void => {
              if (lambda !== undefined) return;
              if (n.kind === "LambdaExpr" && (n.inner ?? [])[0]?.id === cls.id) lambda = n;
              else for (const k of n.inner ?? []) walk(k);
            };
            walk(readDecl(indexed, owner));
            if (lambda === undefined) return undefined;
            const captures = (lambda.inner ?? []).slice(1, -1).map((init) => {
              let n = init;
              while (
                [
                  "ImplicitCastExpr",
                  "ExprWithCleanups",
                  "MaterializeTemporaryExpr",
                  "ParenExpr",
                  "CXXConstructExpr",
                ].includes(n.kind) &&
                n.inner?.[0] !== undefined
              )
                n = n.inner[0] as ClangNode;
              return {
                id: n.referencedDecl?.id ?? "",
                byRef: (init as { valueCategory?: string }).valueCategory === "lvalue",
                type: n.type?.qualType ?? "",
              };
            });
            return { record: lambda.type?.qualType ?? "", captures };
          },
          typedefsOf: (fnId) => {
            const memo = typedefScopes.get(fnId);
            if (memo !== undefined) return memo;
            const out = new Map<string, string>();
            typedefScopes.set(fnId, out);
            let at = indexed.byId.get(fnId)?.parent;
            for (let depth = 0; at !== undefined && depth < 8; depth++) {
              const cls = indexed.byId.get(at);
              if (cls === undefined || !RECORD_KINDS.has(cls.kind)) break;
              for (const c of readDecl(indexed, cls).inner ?? []) {
                if (c.kind !== "TypedefDecl" && c.kind !== "TypeAliasDecl") continue;
                const t = c.type?.desugaredQualType ?? c.type?.qualType;
                if (t !== undefined && !out.has(c.name ?? "")) out.set(c.name ?? "", t);
              }
              at = cls.parent;
            }
            // Then those of the classes its typedefs name (`traits_type`'s `char_type`), which
            // its members' types spell through them.
            for (const t of [...out.values()]) {
              if (!/^(?:(?:struct|class) )?[\w:]+<.*>$/.test(t)) continue;
              for (const c of findRecord(`struct ${t.replace(/^(struct|class) /, "")}`)?.inner ??
                []) {
                if (c.kind !== "TypedefDecl" && c.kind !== "TypeAliasDecl") continue;
                const u = c.type?.desugaredQualType ?? c.type?.qualType;
                if (u !== undefined && !out.has(c.name ?? "")) out.set(c.name ?? "", u);
              }
            }
            return out;
          },
          copyCtorOf: (record, move) => {
            const node = findRecord(record);
            const self = className(record);
            for (const c of node?.inner ?? []) {
              if (c.kind !== "CXXConstructorDecl") continue;
              const ps = (c.inner ?? []).filter((x) => x.kind === "ParmVarDecl");
              if (ps.length !== 1) continue;
              const pt = (ps[0]?.type?.qualType ?? "").trim();
              if (!pt.includes(self) || !(move ? /&&$/.test(pt) : /[^&]&$/.test(pt))) continue;
              return { id: c.id ?? "", body: definitionIn(indexed, c.id ?? "") !== undefined };
            }
            return undefined;
          },
          trivialCopy: (record) => {
            const dd = (
              findRecord(record) as
                | {
                    definitionData?: {
                      copyCtor?: { trivial?: boolean };
                      moveCtor?: { trivial?: boolean; exists?: boolean };
                    };
                  }
                | undefined
            )?.definitionData;
            return dd?.copyCtor?.trivial === true && dd.moveCtor?.trivial !== false;
          },
          memberInitOf: (record, field) => {
            const f = (findRecord(record)?.inner ?? []).find(
              (c) => c.kind === "FieldDecl" && c.name === field,
            );
            return f?.id === undefined ? undefined : cxx?.fieldInitOf(f.id);
          },
          fieldInitOf: (fieldId) => {
            const d = indexed.byId.get(fieldId);
            if (d === undefined) return undefined;
            const initOfField = (x: IndexedDecl): ClangNode | undefined =>
              (readDecl(indexed, x).inner ?? []).find((c) => !/Attr$/.test(c.kind ?? ""));
            const own = initOfField(d);
            if (own !== undefined) return own;
            // (A class template's instance may not have it instantiated: its template's, alike.)
            const owner = d.parent === undefined ? undefined : indexed.byId.get(d.parent)?.name;
            for (const x of indexed.byName.get(d.name) ?? []) {
              if (x.kind !== "FieldDecl" || x.id === d.id) continue;
              if (x.parent === undefined || indexed.byId.get(x.parent)?.name !== owner) continue;
              const i = initOfField(x);
              if (i !== undefined) return i;
            }
            return undefined;
          },
          defaultArgOf: (fnId, index) => {
            const d = indexed.byId.get(fnId);
            if (d === undefined) return undefined;
            // The declaration that gives the defaults: any of the function's (they are written once).
            const decls = [d, ...[definitionIn(indexed, fnId)].filter((x) => x !== undefined)];
            const count = (readDecl(indexed, d).inner ?? []).filter(
              (c) => c.kind === "ParmVarDecl",
            ).length;
            // (A template's instance has none: its template's declaration of that name gives them.)
            const others = (indexed.byName.get(d.name) ?? []).filter((x) =>
              FUNCTION_KINDS.has(x.kind),
            );
            for (const x of [...decls, ...others]) {
              const parms = (readDecl(indexed, x as IndexedDecl).inner ?? []).filter(
                (c) => c.kind === "ParmVarDecl",
              );
              if (parms.length !== count) continue;
              const init = (parms[index]?.inner ?? []).find((c) => !c.kind.endsWith("Attr"));
              if (init !== undefined) return init;
            }
            return undefined;
          },
          isVirtual: (methodId) => {
            const d = indexed.byId.get(methodId);
            return (
              d !== undefined && (readDecl(indexed, d) as { virtual?: boolean }).virtual === true
            );
          },
          slotOf: (methodId) => {
            const d = indexed.byId.get(methodId);
            const cls = d?.parent === undefined ? undefined : indexed.byId.get(d.parent);
            if (d === undefined || cls === undefined) return undefined;
            const node = readDecl(indexed, d);
            return vtables()
              .indices.get(cls.name)
              ?.get(memberKey(node.name ?? "", node.type?.qualType ?? ""));
          },
          deletingSlotOf: (record) => {
            const simple =
              record
                .replace(/^(struct|class|union) /, "")
                .split("::")
                .pop() ?? "";
            return vtables().indices.get(simple)?.get(`~${simple}()[deleting]`);
          },
          vtableOf: (record, destroy) => {
            const simple =
              record
                .replace(/^(struct|class|union) /, "")
                .split("::")
                .pop() ?? "";
            const key = `vtable:${unit}:${simple}`;
            if (statics.has(key)) return key;
            const entries = vtables().tables.get(simple);
            if (entries === undefined) throw new RaiseCError(`the vtable of ${record}`);
            const rec: CType = { k: "rec", name: record };
            const synth = (name: string, source: string): string => {
              let k = name;
              for (let n = 2; found.has(k) || (atoms.has(k) && !synthesized.has(k)); n++)
                k = `${name}_${n}`;
              if (!atoms.has(k)) {
                atoms.set(k, { source, externals: [] });
                synthesized.add(k);
              }
              return k;
            };
            const complete = (): string =>
              synth(
                `${ident(simple)}_destroy`,
                `export function f(__this: number): void {\n${destroy("__this", rec)
                  .map((x) => `${x};`)
                  .join("\n")}\n}`,
              );
            const init: StaticItem[] = [];
            entries.forEach((text, i) => {
              const offset = 8 * i;
              if (text.endsWith("[pure]")) return;
              if (text.endsWith("[complete]")) init.push({ offset, fn: complete() });
              else if (text.endsWith("[deleting]"))
                init.push({
                  offset,
                  fn: synth(
                    `${ident(simple)}_delete`,
                    `export function f(__this: number): void {\n${complete()}(__this);\n__ykFree(__this);\n}`,
                  ),
                });
              else {
                // The final overrider: a method of the class the entry names.
                const head = text.slice(0, text.indexOf("("));
                const owner = head.split("::").slice(-2, -1)[0] ?? "";
                const name = head.split("::").pop() ?? "";
                const want = memberKey(name, text.slice(text.indexOf("(")));
                let id: string | undefined;
                for (const d of indexed.byName.get(owner) ?? []) {
                  if (!RECORD_KINDS.has(d.kind)) continue;
                  const node = readDecl(indexed, d);
                  const m = (node.inner ?? []).find(
                    (c) =>
                      c.kind === "CXXMethodDecl" &&
                      memberKey(c.name ?? "", c.type?.qualType ?? "") === want,
                  );
                  if (m !== undefined) id = m.id;
                }
                const fnKey =
                  id === undefined
                    ? undefined
                    : resolve({ name, kind: "CXXMethodDecl", type: "", id });
                if (fnKey === undefined) throw new RaiseCError(`the overrider ${text}`);
                init.push({ offset, fn: fnKey });
              }
            });
            statics.set(key, { size: Math.max(8, 8 * entries.length), align: 8, init });
            return key;
          },
        };
  // The unit's vtables, as clang lays them out (its code generation dumps them): each class's
  // entries from its address point, and the slot of each virtual function it declares.
  let vt: { tables: Map<string, string[]>; indices: Map<string, Map<string, number>> } | undefined;
  const vtables = (): NonNullable<typeof vt> => {
    if (vt !== undefined) return vt;
    const text = execFileSync(
      clang,
      [...args, "-S", "-emit-llvm", "-o", "/dev/null", "-Xclang", "-fdump-vtable-layouts", file],
      { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] },
    );
    const tables = new Map<string, string[]>();
    const indices = new Map<string, Map<string, number>>();
    for (const block of text.split(/\n\s*\n/)) {
      const lines = block.split("\n");
      const head = /^(Vtable for|VTable indices for) '(.+?)'/.exec(lines[0] ?? "");
      if (head === null) continue;
      const simple = (head[2] as string).split("::").pop() ?? "";
      const rows = lines.flatMap((l) => {
        const m = /^\s*(\d+) \| (.*)$/.exec(l);
        return m === null ? [] : [[Number(m[1]), (m[2] as string).trim()] as const];
      });
      if (head[1] === "Vtable for") {
        // The primary vtable: the entries after its offset-to-top and RTTI, up to a secondary one.
        const after = rows.filter(([i]) => i >= 2);
        const end = after.findIndex(([, t]) =>
          /^(offset_to_top|vcall_offset|vbase_offset)/.test(t),
        );
        tables.set(
          simple,
          (end < 0 ? after : after.slice(0, end)).map(([, t]) => t),
        );
      } else {
        const m = new Map<string, number>();
        for (const [i, t] of rows) {
          const marker = /\[(complete|deleting)\]$/.exec(t)?.[1];
          const bare = t.replace(/\s*\[(pure|complete|deleting)\]$/, "");
          const name = bare.slice(0, bare.indexOf("(")).split("::").pop()?.split(" ").pop() ?? "";
          m.set(
            memberKey(name, bare.slice(bare.indexOf("("))) +
              (marker !== undefined ? `[${marker}]` : ""),
            i,
          );
        }
        indices.set(simple, m);
      }
    }
    vt = { tables, indices };
    return vt;
  };
  // The whole unit's declarations, read once, when an enumeration constant or offsetof is used.
  let whole: ClangNode | undefined;
  const wholeUnit = (): ClangNode => {
    whole ??= JSON.parse(
      clangDump(clang, [...args, "-fsyntax-only", "-Xclang", "-ast-dump=json", file]),
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
      for (const d of eachDecl()) walk(d);
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
      for (const d of eachDecl(
        new Set(["EnumDecl", "TypedefDecl", "NamespaceDecl", "LinkageSpecDecl"]),
      ))
        walk(d);
      enums = values;
    }
    return enums.get(name);
  };
  const typedef: TypedefResolver = (name) => {
    let hit: string | undefined;
    let anonymous: ClangNode | undefined;
    const walk = (n: ClangNode): void => {
      if (hit !== undefined) return;
      if (n.kind === "TypedefDecl" && n.name === name) {
        const t = n.type?.desugaredQualType ?? n.type?.qualType;
        // `typedef struct { .. } Ctx;`: the desugared type is the typedef's own name.
        if (t === name) anonymous = n;
        else hit = t;
        return;
      }
      for (const k of n.inner ?? []) walk(k);
    };
    for (const n of dumpOf(name)) walk(n);
    if (hit !== undefined) return hit;
    if (anonymous !== undefined) return unnamedRecord(anonymous);
    // A member typedef of a class template's instance (`typename iterator_traits<char *>::
    // difference_type`): the instance's.
    const member = /^(?:typename )?(.*>)::([A-Za-z_]\w*)$/.exec(name);
    if (member !== null) {
      // (In the class, or a base: `iterator_traits<It>` derives `__iterator_traits<It>`.)
      const inClass = (cls: ClangNode | undefined, depth: number): string | undefined => {
        for (const c of cls?.inner ?? [])
          if ((c.kind === "TypedefDecl" || c.kind === "TypeAliasDecl") && c.name === member[2]) {
            const t = c.type?.desugaredQualType ?? c.type?.qualType;
            if (t !== undefined) return t;
          }
        if (depth > 8) return undefined;
        for (const b of (
          cls as
            | { bases?: { type?: { qualType?: string; desugaredQualType?: string } }[] }
            | undefined
        )?.bases ?? []) {
          const bt = b.type?.desugaredQualType ?? b.type?.qualType;
          if (bt === undefined) continue;
          const hit = inClass(
            findRecord(`struct ${bt.replace(/^(struct|class) /, "")}`),
            depth + 1,
          );
          if (hit !== undefined) return hit;
        }
        return undefined;
      };
      const fr = findRecord(`struct ${member[1]}`);
      const hit = inClass(fr, 0);
      if (hit !== undefined) return hit;
    }
    // A namespace's typedef or alias by its qualified name (`std::string`), in an indexed unit:
    // the one of that bare name inside a namespace of the qualifier's name.
    const scoped = /^(?:([A-Za-z_]\w*)::)+([A-Za-z_]\w*)$/.exec(name);
    if (indexed !== undefined && scoped !== null) {
      const [space, bare] = [scoped[1] as string, scoped[2] as string];
      const spaces = (indexed.byName.get(space) ?? []).filter((d) => d.kind === "NamespaceDecl");
      for (const d of indexed.byName.get(bare) ?? []) {
        if (d.kind !== "TypedefDecl" && d.kind !== "TypeAliasDecl") continue;
        if (d.parent !== undefined || !spaces.some((s) => s.start < d.start && d.end <= s.end))
          continue;
        const n = readDecl(indexed, d);
        const t = n.type?.desugaredQualType ?? n.type?.qualType;
        if (t !== undefined && t !== name && !/\b_[A-Z]\w*\b/.test(t)) return t;
      }
    }
    // An alias template's instance (`ada::result<url_aggregator>`, `template <class T> using
    // result = tl::expected<T, errors>`): its type with the arguments for its parameters.
    const lt = name.indexOf("<");
    // (A class template's instance of the same bare name, `std::basic_string<..>` against
    // `std::pmr::basic_string<..>`, is the class: its layout says so.)
    const isClass = ["struct", "class", "union"].some(
      (tag) => layout(recordKey(`${tag} ${name}`)) !== undefined,
    );
    if (lt > 0 && name.endsWith(">") && !isClass) {
      const bareAlias = name.slice(0, lt).split("::").pop() ?? "";
      const args = splitTemplateArgs(name.slice(lt + 1, -1));
      for (const n of dumpOf(bareAlias)) {
        if (n.kind !== "TypeAliasTemplateDecl" || n.name !== bareAlias) continue;
        const paramDecls = (n.inner ?? []).filter(
          (c) => c.kind === "TemplateTypeParmDecl" || c.kind === "NonTypeTemplateParmDecl",
        );
        const params = paramDecls.map((c) => c.name ?? "");
        // A parameter the instance leaves out: its default, itself in the parameters before it.
        paramDecls.forEach((c, i) => {
          if (args[i] !== undefined) return;
          let dflt = (c as { defaultArg?: { type?: { qualType?: string } } }).defaultArg?.type
            ?.qualType;
          if (dflt === undefined) return;
          params.slice(0, i).forEach((pn, j) => {
            if (pn !== "" && args[j] !== undefined)
              dflt = (dflt as string).replace(new RegExp(`\\b${pn}\\b`, "g"), args[j] as string);
          });
          args[i] = dflt;
        });
        const alias = (n.inner ?? []).find((c) => c.kind === "TypeAliasDecl");
        let t = alias?.type?.qualType;
        if (t === undefined) continue;
        params.forEach((pn, i) => {
          if (pn !== "" && args[i] !== undefined)
            t = (t as string).replace(new RegExp(`\\b${pn}\\b`, "g"), args[i] as string);
        });
        return t;
      }
    }
    // (A name in a class template's instance that is none of these is a class: not an
    // enumeration of its bare name elsewhere.)
    if (/>::/.test(name)) return undefined;
    // An enumeration (`enum e`, `ns::e`): its underlying type, fixed (`enum class e : uint8_t`,
    // and int for a scoped one) or chosen by the compiler (int, or unsigned int when no
    // enumerator is negative).
    const bare =
      name
        .replace(/^enum /, "")
        .split("::")
        .pop() ?? name;
    let found: ClangNode | undefined;
    const find = (n: ClangNode): void => {
      if (found !== undefined) return;
      if (n.kind === "EnumDecl" && n.name === bare) {
        found = n;
        return;
      }
      for (const k of n.inner ?? []) find(k);
    };
    for (const n of dumpOf(bare)) find(n);
    if (found === undefined) return undefined;
    const fixed = (
      found as { fixedUnderlyingType?: { qualType?: string; desugaredQualType?: string } }
    ).fixedUnderlyingType;
    if (fixed !== undefined) return fixed.desugaredQualType ?? fixed.qualType;
    if ((found as { scopedEnumTag?: string }).scopedEnumTag !== undefined) return "int";
    const negative = (found.inner ?? []).some(
      (c) => c.kind === "EnumConstantDecl" && (enumValue(c.name ?? "") ?? 0n) < 0n,
    );
    return negative ? "int" : "unsigned int";
  };
  /**
   * A typedef of an unnamed record: the layout dump's name for it (`struct (unnamed at f.c:1:9)`),
   * the unnamed layout with the record's fields, in order (an indexed unit: the record by id).
   */
  const unnamedRecord = (typedef: ClangNode): string | undefined => {
    let id: string | undefined;
    const find = (n: ClangNode): void => {
      const d =
        (n as { decl?: { id?: string; kind?: string }; ownedTagDecl?: { id?: string } })
          .ownedTagDecl ?? (n as { decl?: { id?: string; kind?: string } }).decl;
      if (id === undefined && d?.id !== undefined) id = d.id;
      for (const k of n.inner ?? []) find(k);
    };
    find(typedef);
    const rec = id === undefined || indexed === undefined ? undefined : indexed.byId.get(id);
    if (rec === undefined) return undefined;
    const fields = (readDecl(indexed as UnitIndex, rec).inner ?? [])
      .filter((f) => f.kind === "FieldDecl")
      .map((f) => f.name ?? "");
    layout(""); // the layouts, read
    for (const [key, l] of layouts ?? [])
      if (/\(unnamed at /.test(key) && [...l.fields.keys()].join(",") === fields.join(","))
        return key;
    return undefined;
  };
  let layouts: Map<string, RecordLayout> | undefined;
  const layout: LayoutResolver = (name) => {
    if (layouts === undefined) {
      const run = (more: readonly string[]): string =>
        execFileSync(clang, [...args, ...more, file], {
          encoding: "utf8",
          maxBuffer: 1 << 30,
          stdio: ["ignore", "pipe", "ignore"],
        });
      let dump: string;
      try {
        dump = run(["-fsyntax-only", "-Xclang", "-fdump-record-layouts-complete"]);
      } catch {
        // clang 18 can crash dumping every record of libstdc++'s headers: the records code
        // generation lays out, then.
        dump = run(["-S", "-emit-llvm", "-o", "/dev/null", "-Xclang", "-fdump-record-layouts"]);
      }
      layouts = recordLayouts(dump);
    }
    // (A class template's instance spelled with its default arguments, which the dump omits.)
    let key = recordKey(name);
    for (let tries = 0; tries < 8; tries++) {
      const l = layouts.get(key);
      if (l !== undefined) return l;
      // (Its first argument list, and what follows it: `basic_string<..>::_Alloc_hider`.)
      const lt = key.indexOf("<");
      let gt = -1;
      for (let i = lt, depth = 0; lt >= 0 && i < key.length && gt < 0; i++) {
        if (key[i] === "<") depth++;
        else if (key[i] === ">" && --depth === 0) gt = i;
      }
      if (gt < 0) break;
      const args = splitTemplateArgs(key.slice(lt + 1, gt));
      if (args.length < 2) break;
      key = `${key.slice(0, lt + 1)}${args.slice(0, -1).join(", ")}${key.slice(gt)}`;
    }
    // (Default arguments spelled at any depth, `<const char *, basic_string<char, char_traits<
    // char>, allocator<char>>>`: the layout whose arguments are a prefix of these, at each.)
    const want = recordKey(name);
    const lt = want.indexOf("<");
    if (lt < 0) return undefined;
    const head = want.slice(0, lt + 1);
    let byHead = layoutsByHead.get(head);
    if (byHead === undefined) {
      byHead = [...layouts.keys()].filter((k) => k.startsWith(head));
      layoutsByHead.set(head, byHead);
    }
    for (const k of byHead) if (argsPrefix(k, want)) return layouts.get(k);
    return undefined;
  };
  const layoutsByHead = new Map<string, string[]>();
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
  const staticHook = (d: ClangNode, fnName?: string, dynamic = false): string | undefined => {
    const id = fnName === undefined ? `g:${d.name}` : (d.id ?? "");
    if (staticKeys.has(id)) return staticKeys.get(id);
    if (dynamic && fnName !== undefined) {
      const key = `${unit}:${fnName}.${d.name}`;
      const t = ctype(d.type);
      statics.set(key, { size: Math.max(1, sizeOf(t)), align: Math.max(1, alignOf(t)), init: [] });
      statics.set(`${key}#guard`, { size: 1, align: 1, init: [] });
      staticKeys.set(id, key);
      return key;
    }
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
            constInit: (g) => {
              const c = resolveGlobal(g.name ?? "", normType(g.type?.qualType ?? ""), g.id);
              return c === undefined ? undefined : initOf(c);
            },
            fnKey: (f) =>
              resolve({
                name: f.name ?? "",
                kind: f.kind,
                type: normType(f.type?.qualType ?? ""),
                id: f.id,
              }) ??
              f.name ??
              "",
          }),
        );
      } catch (e) {
        // (C++: a constant whose initializer the evaluator does not fold, a constexpr call's:
        // its bytes as code generation emits them.)
        // (A class template's static member declared in its class: the mangled name is its
        // definition's, a redeclaration.)
        let mangled = (decl as { mangledName?: string }).mangledName;
        if (mangled === undefined && indexed !== undefined && decl.id !== undefined) {
          let first = decl.id;
          for (let g = 0; indexed.previous.has(first) && g < 100; g++)
            first = indexed.previous.get(first) as string;
          for (let at: string | undefined = first, g = 0; at !== undefined && g < 100; g++) {
            const r = indexed.byId.get(at);
            if (r?.mangled !== undefined) {
              mangled = r.mangled;
              break;
            }
            at = indexed.next.get(at);
          }
        }
        // (An inline static member, C++17, has no definition to name it: its class's mangled
        // prefix, from a member function's, and its own name.)
        const owner = decl.id === undefined ? undefined : indexed?.byId.get(decl.id)?.parent;
        if (mangled === undefined && owner !== undefined && indexed !== undefined) {
          const rec = indexed.byId.get(owner);
          for (const m of rec === undefined ? [] : (readDecl(indexed, rec).inner ?? [])) {
            const mm =
              (m as { mangledName?: string }).mangledName ??
              (m.id === undefined ? undefined : indexed.byId.get(m.id)?.mangled);
            const mn = m.name ?? "";
            if (mm === undefined || !mm.startsWith("_ZN") || !/^[A-Za-z_]\w*$/.test(mn)) continue;
            const k = mm.indexOf(`${mn.length}${mn}E`);
            if (k < 0) continue;
            const n = d.name ?? "";
            mangled = `_ZN${mm.slice(3, k)}${n.length}${n}E`;
            break;
          }
        }
        // (Else the one global of the unit's IR named for its class and itself.)
        if (mangled === undefined && owner !== undefined && indexed !== undefined) {
          const cls = indexed.byId.get(owner)?.name ?? "";
          const n = d.name ?? "";
          const want = `${cls.length}${cls}`;
          const hits = [...unitIR().matchAll(/^@(_Z\w+) = /gm)]
            .map((m) => m[1] as string)
            .filter((g) => g.includes(want) && g.endsWith(`${n.length}${n}E`));
          if (hits.length === 1) mangled = hits[0];
        }
        let fromIR: StaticDef | undefined;
        try {
          fromIR =
            mangled === undefined || indexed === undefined
              ? undefined
              : irConstantStatic(unitIR(), mangled);
        } catch {
          fromIR = undefined;
        }
        if (fromIR === undefined)
          throw new RaiseCError(
            `the static "${d.name}": ${e instanceof Error ? e.message : String(e)}`,
          );
        statics.set(key, fromIR);
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
  const synthesized = new Set<string>(); // atoms written, not raised (a class's destructors)
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
            ...(cxx !== undefined ? { cxx } : {}),
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
 * A constant global as code generation emits it (C++: `static constexpr std::array<..> t =
 * build();`, whose value clang's AST does not carry): its bytes from the unit's LLVM IR, each
 * pointer in it to another constant global (a string) as that global's bytes, constant data.
 * Undefined when the global is not a constant the parser reads.
 */
export function irConstantStatic(ir: string, symbol: string): StaticDef | undefined {
  const globalLine = (name: string): string | undefined => {
    const q = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`^@(?:"${q}"|${q}) = [^\\n]*?\\bconstant ([^\\n]*)$`, "m").exec(ir);
    return m?.[1];
  };
  const named = new Map<string, string>();
  const typeOfNamed = (n: string): string => {
    let t = named.get(n);
    if (t === undefined) {
      const q = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = new RegExp(`^${q} = type ([^\\n]*)$`, "m").exec(ir);
      if (m === null) throw new RaiseCError(`the IR type ${n}`);
      t = m[1] as string;
      named.set(n, t);
    }
    return t;
  };
  type T =
    | { k: "int"; size: number }
    | { k: "ptr" }
    | { k: "f"; size: number }
    | { k: "arr"; n: number; of: T }
    | { k: "struct"; fields: T[]; packed: boolean };
  const sizeAlign = (t: T): [number, number] => {
    switch (t.k) {
      case "int":
      case "f":
        return [t.size, Math.min(t.size, 16)];
      case "ptr":
        return [8, 8];
      case "arr": {
        const [s, a] = sizeAlign(t.of);
        return [s * t.n, a];
      }
      case "struct": {
        let off = 0;
        let al = 1;
        for (const f of t.fields) {
          const [fs, fa] = sizeAlign(f);
          const a = t.packed ? 1 : fa;
          off = Math.ceil(off / a) * a + fs;
          al = Math.max(al, a);
        }
        return [Math.ceil(off / al) * al, al];
      }
    }
  };
  // A cursor over one global's text: a type, then its value.
  const parse = (source: string, bytes: number[], ptrs: [number, string][], depth: number) => {
    let text = source;
    let i = 0;
    const ws = () => {
      while (text[i] === " ") i++;
    };
    const take = (s: string): boolean => {
      ws();
      if (text.startsWith(s, i)) {
        i += s.length;
        return true;
      }
      return false;
    };
    const expect = (s: string) => {
      if (!take(s)) throw new RaiseCError(`IR: "${s}" at ${text.slice(i, i + 40)}`);
    };
    const word = (): string => {
      ws();
      const m = /^(?:%"[^"]*"|@"[^"]*"|c"[^"]*"|[%@]?[\w.$-]+)/.exec(text.slice(i));
      if (m === null) throw new RaiseCError(`IR: a word at ${text.slice(i, i + 40)}`);
      i += m[0].length;
      return m[0];
    };
    const type = (): T => {
      ws();
      if (take("[")) {
        const n = Number(word());
        expect("x");
        const of = type();
        expect("]");
        return { k: "arr", n, of };
      }
      const packed = take("<{");
      if (packed || take("{")) {
        const fields: T[] = [];
        if (!take(packed ? "}>" : "}")) {
          do fields.push(type());
          while (take(","));
          expect(packed ? "}>" : "}");
        }
        return { k: "struct", fields, packed };
      }
      const w = word();
      if (/^i\d+$/.test(w)) return { k: "int", size: Math.ceil(Number(w.slice(1)) / 8) };
      if (w === "ptr") return { k: "ptr" };
      if (w === "float") return { k: "f", size: 4 };
      if (w === "double") return { k: "f", size: 8 };
      if (w.startsWith("%")) {
        const inner = typeOfNamed(w);
        const save = [text, i] as const;
        text = inner;
        i = 0;
        const t = type();
        [text, i] = save;
        return t;
      }
      throw new RaiseCError(`IR: the type ${w}`);
    };
    const put = (at: number, size: number, v: bigint) => {
      for (let b = 0; b < size; b++) bytes[at + b] = Number((v >> BigInt(8 * b)) & 0xffn);
    };
    const value = (t: T, at: number): void => {
      ws();
      if (take("zeroinitializer") || take("undef") || take("poison") || take("null")) return;
      if (t.k === "arr" && text.startsWith('c"', i)) {
        const lit = word().slice(2, -1);
        let o = at;
        for (let j = 0; j < lit.length; j++) {
          if (lit[j] === "\\") {
            bytes[o++] = Number.parseInt(lit.slice(j + 1, j + 3), 16);
            j += 2;
          } else bytes[o++] = lit.charCodeAt(j);
        }
        return;
      }
      if (t.k === "arr") {
        expect("[");
        const [es] = sizeAlign(t.of);
        for (let n = 0; n < t.n; n++) {
          if (n > 0) expect(",");
          type();
          value(t.of, at + n * es);
        }
        expect("]");
        return;
      }
      if (t.k === "struct") {
        expect(t.packed ? "<{" : "{");
        let off = 0;
        t.fields.forEach((f, n) => {
          if (n > 0) expect(",");
          const [fs, fa] = sizeAlign(f);
          off = Math.ceil(off / (t.packed ? 1 : fa)) * (t.packed ? 1 : fa);
          type();
          value(f, at + off);
          off += fs;
        });
        expect(t.packed ? "}>" : "}");
        return;
      }
      const w = word();
      if (t.k === "int") {
        put(at, t.size, w === "true" ? 1n : w === "false" ? 0n : BigInt(w));
        return;
      }
      if (t.k === "ptr" && w.startsWith("@")) {
        ptrs.push([at, w.slice(1).replace(/^"(.*)"$/, "$1")]);
        return;
      }
      if (t.k === "f" && /^0x[0-9A-Fa-f]+$/.test(w)) {
        put(at, 8, BigInt(w));
        if (t.size === 4) throw new RaiseCError("IR: a float constant");
        return;
      }
      throw new RaiseCError(`IR: the value ${w}${depth}`);
    };
    const t = type();
    value(t, 0);
    return t;
  };
  const line = globalLine(symbol);
  if (line === undefined) return undefined;
  const bytes: number[] = [];
  const ptrs: [number, string][] = [];
  const text = line.replace(/, (?:comdat\b|align \d+|section ).*$/, "");
  const t = parse(text, bytes, ptrs, 0);
  const [size, align] = sizeAlign(t);
  const init: StaticItem[] = [];
  bytes.forEach((b, o) => {
    if (b !== 0) init.push({ offset: o, kind: "u8", value: b });
  });
  for (const [o, g] of ptrs) {
    const gl = globalLine(g);
    if (gl === undefined) throw new RaiseCError(`IR: the global ${g}`);
    const gb: number[] = [];
    const gp: [number, string][] = [];
    const gt = parse(gl.replace(/, (?:comdat\b|align \d+|section ).*$/, ""), gb, gp, 1);
    if (gp.length > 0) throw new RaiseCError(`IR: the global ${g} holds addresses`);
    const n = sizeAlign(gt)[0];
    init.push({
      offset: o,
      data: { kind: "u8", values: Array.from({ length: n }, (_, j) => gb[j] ?? 0) },
    });
  }
  return { size, align, init };
}

/** The call or construction a variable's initializer runs (C++), outside unevaluated operands. */
function initializerRuns(decl: ClangNode): ClangNode | undefined {
  const runs = (n: ClangNode): ClangNode | undefined => {
    if (
      /^(CallExpr|CXXMemberCallExpr|CXXOperatorCallExpr|CXXConstructExpr|CXXTemporaryObjectExpr|LambdaExpr)$/.test(
        n.kind,
      )
    )
      return n;
    if (n.kind === "UnaryExprOrTypeTraitExpr") return undefined;
    for (const k of n.inner ?? []) {
      const r = runs(k);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  const e = initOf(decl);
  return e === undefined ? undefined : runs(e);
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
    /** A constant variable's initializer (C++: `constexpr int n = a * b;`). */
    readonly constInit?: (d: ClangNode) => ClangNode | undefined;
  },
): StaticDef {
  const t = ctype(decl.type);
  const init: StaticItem[] = [];
  const typeOf = (e: ClangNode): CType => ctype(e.type);
  // (C++: an initializer that runs code, a call or a constructor, is not C's constant one: the
  // unit's code generation has its value.)
  {
    const code = initializerRuns(decl);
    if (code !== undefined) throw new RaiseCError(`the initializer ${code.kind}`);
  }
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
      case "SubstNonTypeTemplateParmExpr":
        return scalar(kids[kids.length - 1] as ClangNode);
      case "IntegerLiteral":
        return { k: "v", v: BigInt(e.value ?? "0") };
      case "DeclRefExpr": {
        const d = e.referencedDecl as ClangNode;
        const v = d.kind === "EnumConstantDecl" ? unitEnumValue(d.name ?? "") : undefined;
        if (v !== undefined) return { k: "v", v };
        // Another constant's value (its initializer, folded the same way).
        if (d.kind === "VarDecl" && /\bconst\b/.test(d.type?.qualType ?? "")) {
          const i = hooks.constInit?.(d);
          if (i !== undefined) return scalar(i);
        }
        break;
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
          // Comparisons and logic: C's int 0 or 1.
          "==": () => (x === y ? 1n : 0n),
          "!=": () => (x !== y ? 1n : 0n),
          "<": () => (x < y ? 1n : 0n),
          "<=": () => (x <= y ? 1n : 0n),
          ">": () => (x > y ? 1n : 0n),
          ">=": () => (x >= y ? 1n : 0n),
          "&&": () => (x !== 0n && y !== 0n ? 1n : 0n),
          "||": () => (x !== 0n || y !== 0n ? 1n : 0n),
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
      const field = layoutOf(typeOf((n.inner ?? [])[0] as ClangNode)).fields.get(memberName(n));
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

/**
 * A range-based for (C++) as clang spells it: its range, begin and end variables, then a for loop
 * of its condition and increment over the loop variable and the body. Other nodes are kept, and
 * a subtree with no range-based for is the same object.
 */
function lowerRangeFor(n: ClangNode, bindings = new Map<string, ClangNode>()): ClangNode {
  // A structured binding's name (C++17): the expression it binds; the object decomposed, a
  // variable.
  if (n.kind === "DeclRefExpr") {
    const d = n.referencedDecl;
    if (d?.kind === "BindingDecl") {
      const b = bindings.get(d.id ?? "");
      if (b === undefined) throw new RaiseCError(`the binding ${d.name}`);
      return b;
    }
    if (d?.kind === "DecompositionDecl")
      return { ...n, referencedDecl: { ...d, kind: "VarDecl", name: "__decomposed" } };
    return n;
  }
  const all = n.inner;
  if (all === undefined) return n;
  // (A documentation comment clang attaches to a declaration is not code.)
  const kids = all.some((k) => k.kind === "FullComment")
    ? all.filter((k) => k.kind !== "FullComment")
    : all;
  if (n.kind === "DeclStmt" && kids.some((k) => k.kind === "DecompositionDecl")) {
    const decls: ClangNode[] = [];
    for (const k of kids) {
      if (k.kind !== "DecompositionDecl") {
        decls.push(lowerRangeFor(k, bindings));
        continue;
      }
      const inner = k.inner ?? [];
      const init = inner.filter((x) => x.kind !== "BindingDecl");
      decls.push({
        ...k,
        kind: "VarDecl",
        name: "__decomposed",
        inner: init.map((x) => lowerRangeFor(x, bindings)),
      } as ClangNode);
      for (const b of inner.filter((x) => x.kind === "BindingDecl")) {
        const parts = b.inner ?? [];
        // (Tuple-like: a reference variable holding get<i>'s result, then the name of it.)
        for (const h of parts.slice(0, -1))
          if (h.kind === "VarDecl") decls.push(lowerRangeFor(h, bindings));
        const bound = parts[parts.length - 1];
        if (bound === undefined) throw new RaiseCError(`the binding ${b.name} binds nothing`);
        bindings.set(b.id ?? "", lowerRangeFor(bound, bindings));
      }
    }
    return { ...n, inner: decls };
  }
  let changed = kids !== all;
  const next = kids.map((k) => {
    const l = lowerRangeFor(k, bindings);
    if (l !== k) changed = true;
    return l;
  });
  if (n.kind === "CXXForRangeStmt") {
    const [init, range, begin, end, cond, inc, loopVar, body] = next as ClangNode[];
    const loop: ClangNode = {
      kind: "ForStmt",
      inner: [
        {} as ClangNode,
        {} as ClangNode,
        cond as ClangNode,
        inc as ClangNode,
        {
          kind: "CompoundStmt",
          inner: [loopVar as ClangNode, body as ClangNode],
        } as ClangNode,
      ],
    } as ClangNode;
    return {
      kind: "CompoundStmt",
      inner: [
        ...(init?.kind !== undefined ? [init] : []),
        range as ClangNode,
        begin as ClangNode,
        end as ClangNode,
        loop,
      ],
    } as ClangNode;
  }
  // An if or a switch with an init statement or a condition variable (C++17,
  // `if (auto r = f(); r.ok)`): those first, in a block of their own.
  const flags = n as { hasInit?: boolean; hasVar?: boolean };
  if ((n.kind === "IfStmt" || n.kind === "SwitchStmt") && (flags.hasInit || flags.hasVar)) {
    const lead = next.slice(0, (flags.hasInit ? 1 : 0) + (flags.hasVar ? 1 : 0));
    const rest = next.slice(lead.length);
    const {
      hasInit: _i,
      hasVar: _v,
      ...plain
    } = n as ClangNode & {
      hasInit?: boolean;
      hasVar?: boolean;
    };
    return {
      kind: "CompoundStmt",
      inner: [...lead, { ...plain, inner: rest } as ClangNode],
    } as ClangNode;
  }
  return changed ? { ...n, inner: next } : n;
}

/** A call's return slot (C++, see claimRet): whether it has one, and its address argument. */
type Ret = { readonly applies: boolean; readonly slot: () => string[] };
const noRet: Ret = { applies: false, slot: () => [] };

/** A record's class name alone: no tag, scope or arguments (`basic_string<char>::_Alloc_hider`
 * is `_Alloc_hider`). */
function className(record: string): string {
  const bare = record.replace(/^(struct|class|union) /, "");
  let depth = 0;
  let last = 0;
  for (let i = 0; i < bare.length; i++) {
    if (bare[i] === "<") depth++;
    else if (bare[i] === ">") depth--;
    else if (depth === 0 && bare[i] === ":" && bare[i + 1] === ":") last = i + 2;
  }
  return bare.slice(last).replace(/<.*$/, "");
}

/** Whether a C++ type is a reference (`T &`, `T &&`, `int (&)[5]`). */
const isReferenceType = (qualType: string): boolean =>
  /&$|\(&&?\)\s*(\[\d*\])+$/.test(qualType.trim());

/** A spelling split at its first template argument list: before, the arguments, after. */
function templateParts(t: string): { head: string; args: string[]; tail: string } | undefined {
  const lt = t.indexOf("<");
  if (lt < 0) return undefined;
  for (let i = lt, depth = 0; i < t.length; i++) {
    if (t[i] === "<") depth++;
    else if (t[i] === ">" && --depth === 0)
      return {
        head: t.slice(0, lt),
        args: splitTemplateArgs(t.slice(lt + 1, i)).map((a) => a.trim()),
        tail: t.slice(i + 1),
      };
  }
  return undefined;
}

/**
 * Whether `short` is `long` with trailing template arguments left out, at any depth (clang's
 * layout dump omits default arguments: `basic_string<char>` for `basic_string<char,
 * char_traits<char>, allocator<char>>`).
 */
function argsPrefix(short: string, long: string, depth = 0): boolean {
  if (short === long) return true;
  if (depth > 16) return false;
  const a = templateParts(short);
  const b = templateParts(long);
  if (a === undefined || b === undefined) return false;
  if (a.head !== b.head || a.args.length > b.args.length) return false;
  if (!a.args.every((x, i) => argsPrefix(x, b.args[i] as string, depth + 1))) return false;
  return a.tail === b.tail || argsPrefix(a.tail, b.tail, depth + 1);
}

/** A record's name as a key: C++ scopes dropped (`union P::(unnamed at f.c:1:40)` and the C spelling meet). */
const FIXED_WIDTH: Readonly<Record<string, string>> = {
  int8_t: "signed char",
  uint8_t: "unsigned char",
  int16_t: "short",
  uint16_t: "unsigned short",
  int32_t: "int",
  uint32_t: "unsigned int",
  int64_t: "long",
  uint64_t: "unsigned long",
  size_t: "unsigned long",
  uintptr_t: "unsigned long",
  intptr_t: "long",
  ptrdiff_t: "long",
};
/** A member of an anonymous member (C++: `union { T m_val; E m_unexpect; };`): at its offset. */
function throughAnonymous(
  l: RecordLayout,
  name: string,
): { offset: number; type: string } | undefined {
  for (const [key, f] of l.fields) {
    if (!key.startsWith("(anonymous) ")) continue;
    const inner = unitLayout(recordKey(f.type));
    const g =
      inner?.fields.get(name) ?? (inner === undefined ? undefined : throughAnonymous(inner, name));
    if (g !== undefined) return { offset: f.offset + g.offset, type: g.type };
  }
  return undefined;
}

/** An anonymous member's key in its record's fields: its record's key. */
const anonymousField = (type: string): string =>
  `(anonymous) ${recordKey(type.replace(/\b(const|volatile)\s+/g, "")).replace(/^(struct|union|class) /, "")}`;
/** A member expression's key in its record's fields (an anonymous member's, by its type). */
const memberName = (e: ClangNode): string =>
  e.name === "" || e.name === undefined
    ? anonymousField(e.type?.desugaredQualType ?? e.type?.qualType ?? "")
    : e.name;
// An unnamed record is named by where it is: the layout dump writes `(unnamed at rel/f.h:17:2)`,
// a type `(unnamed struct at /abs/f.h:17:2)`; both are keyed `(unnamed at f.h:17:2)`.
const recordKey = (name: string): string =>
  normType(
    name
      .replace(/\b[A-Za-z_]\w*::/g, "")
      // A template argument's tag (`<struct ada::url, enum ada::errors>` is `<url, errors>`).
      .replace(/([<,]\s*)(?:struct|class|union|enum) /g, "$1")
      .replace(
        /\((?:unnamed|anonymous)(?: struct| union| class)? at (?:[^)]*\/)?([^/)]+:\d+:\d+)\)/g,
        "(unnamed at $1)",
      )
      .replace(
        /^(?:class |struct )?\(lambda at (?:[^)]*\/)?([^/)]+:\d+:\d+)\)/,
        "class (lambda at $1)",
      )
      // A template's arguments as their types (`<uint32_t>` is `<unsigned int>`).
      .replace(
        /\b(u?int(?:8|16|32|64)_t|size_t|uintptr_t|intptr_t|ptrdiff_t)\b/g,
        (t) => FIXED_WIDTH[t] ?? t,
      )
      // (The dump's spellings: `_Bool`, `noexcept` in a function type, `> >`; a bool template
      // argument as its number.)
      .replace(/([<,]\s*)true(?=\s*[,>])/g, "$11")
      .replace(/([<,]\s*)false(?=\s*[,>])/g, "$10")
      .replace(/\b_Bool\b/g, "bool")
      .replace(/\s*\bnoexcept\b/g, "")
      .replace(/\s+>/g, ">")
      .replace(/<\s+/g, "<"),
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
    const head = /^\s*\d+ \| (.*?)(?: \(empty\))?$/.exec(lines[0] ?? "");
    const tail = /\[sizeof=(\d+),.*?align=(\d+)/.exec(block);
    if (head === null || tail === null) continue;
    const fields = new Map<
      string,
      { offset: number; type: string; bit?: { start: number; width: number } }
    >();
    const bases = new Map<string, number>();
    let vptr: number | undefined;
    for (const l of lines.slice(1)) {
      // `8 |   int x`, or a bit-field `32:0-4 |   uintptr_t last_idx` (byte, then its first and
      // last bit counted from that byte).
      const m = /^\s*(\d+)(?::(\d+)-(\d+))? \| {3}(\S.*)$/.exec(l);
      if (m === null) continue; // nested deeper, or the size line
      const text = (m[4] as string).trim().replace(/ \(empty\)$/, "");
      const baseOf = /^(.*?) \((?:primary )?(?:virtual )?base\)$/.exec(text);
      if (baseOf !== null) {
        bases.set(recordKey(baseOf[1] as string), Number(m[1]));
        continue;
      }
      if (/vtable pointer\)$/.test(text)) {
        vptr ??= Number(m[1]);
        continue;
      }
      // An anonymous member record: keyed by its type (a member expression names it by that).
      if (/\((?:unnamed|anonymous)(?: struct| union| class)? at [^()]*\)$/.test(text)) {
        fields.set(anonymousField(text), { offset: Number(m[1]), type: text });
        continue;
      }
      const name = /([A-Za-z_]\w*)$/.exec(text)?.[1];
      if (name === undefined) continue;
      const offset = Number(m[1]);
      const type = text.slice(0, -name.length).trim();
      // An unnamed field (a lambda's capture prints as its type alone): not a named member.
      if (type === "" || /[&*]$/.test(text)) continue;
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
      ...(bases.size > 0 ? { bases } : {}),
      ...(vptr !== undefined ? { vptr } : {}),
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
