// SPDX-License-Identifier: Apache-2.0
/**
 * The leaves natively, in LLVM (#1516): no runtime code for them. Memory is the machine's own: an
 * address is a pointer's integer, a load or store is the instruction, an allocation the C library's
 * (zeroed, through the system module's `yk_mem_alloc`), constant data a constant in the object. The leaves on integers and a double's bits are
 * the instructions. Each is a `linkonce_odr` definition the lowering puts in every module that calls
 * it (the linker keeps one), so a call inlines; what a leaf needs of JavaScript (ToNumber, ToInt32,
 * a BigInt's words, a thrown error) is the runtime's operation for it, as an atom's own code calls.
 *
 * What changes from raise-c's JavaScript definition of C's memory (createCMemory): an access outside
 * the program's allocations is the machine's (a fault, or the bytes there), not a "memory trap", as
 * the C compiled by a C compiler. An address that is not a non-negative integer still traps.
 */

/** A boxed value below this is a number (0xFFF9 << 48, as a signed i64). */
const NUMBER_LIMIT = "-1970324836974592";
const UNDEFINED = "-1970324836974592";
const CANONICAL_NAN = "9221120237041090560";
const T_CLOSURE = 0xfffdn << 48n;

/** A string constant every module defines alike (the linker keeps one). */
function cstring(name: string, text: string): { decl: string; ref: string; len: number } {
  const bytes = Buffer.from(text, "utf8");
  const body = [...bytes]
    .map((b) =>
      b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c
        ? String.fromCharCode(b)
        : `\\${b.toString(16).padStart(2, "0").toUpperCase()}`,
    )
    .join("");
  return {
    decl: `@yk.l.s.${name} = linkonce_odr unnamed_addr constant [${bytes.length} x i8] c"${body}"`,
    ref: `@yk.l.s.${name}`,
    len: bytes.length,
  };
}

const S = {
  error: cstring("error", "Error"),
  typeError: cstring("type_error", "TypeError"),
  rangeError: cstring("range_error", "RangeError"),
  address: cstring("address", "memory trap: address "),
  big: cstring("big", "Cannot convert to a BigInt"),
  fnAddr: cstring("fn_addr", "memory trap: the address of a value that is no function"),
  fnAt: cstring("fn_at", "memory trap: a call through a pointer that is no function's"),
  size: cstring("size", "memory trap: an allocation of "),
  raw: cstring("raw", "memory trap: an access past the end of a block"),
  oom: cstring("oom", "out of memory\u0000"),
  length: cstring("length", "length"),
  bigint: cstring("bigint", "BigInt"),
  number: cstring("number", "Number"),
};

/** One definition: its IR, the runtime's functions it calls, the declarations and the helpers it needs. */
interface Def {
  readonly ir: readonly string[];
  readonly runtime?: readonly string[];
  readonly decls?: readonly string[];
  readonly helpers?: readonly string[];
}

const FABS = "declare double @llvm.fabs.f64(double)";
const TRUNC = "declare double @llvm.trunc.f64(double)";
const CEIL = "declare double @llvm.ceil.f64(double)";
const CALLOC = "declare ptr @yk_mem_alloc(i64)";
const FREE = "declare void @yk_mem_free(ptr)";

/** The helpers the leaves share. */
const HELPERS: Readonly<Record<string, Def>> = {
  // An error thrown: its constructor's name, its message, and a value its string ends with.
  "yk.l.fail": {
    runtime: ["yk_global", "yk_string_utf8", "yk_add", "yk_new", "yk_throw"],
    ir: [
      "define linkonce_odr void @yk.l.fail(ptr %ctor, i64 %cl, ptr %msg, i64 %ml, i1 %has, i64 %extra) noinline noreturn cold {",
      "entry:",
      "  %s = call i64 @yk_string_utf8(ptr %msg, i64 %ml)",
      "  br i1 %has, label %with, label %go",
      "with:",
      "  %s2 = call i64 @yk_add(i64 %s, i64 %extra)",
      "  br label %go",
      "go:",
      "  %m = phi i64 [ %s, %entry ], [ %s2, %with ]",
      "  %c = call i64 @yk_global(ptr %ctor, i64 %cl)",
      "  %argv = alloca i64",
      "  store i64 %m, ptr %argv",
      "  %e = call i64 @yk_new(i64 %c, i64 1, ptr %argv)",
      "  call void @yk_throw(i64 %e)",
      "  unreachable",
      "}",
    ],
  },
  // ToNumber, a number as it is.
  "yk.l.num": {
    runtime: ["yk_pos"],
    ir: [
      "define linkonce_odr double @yk.l.num(i64 %x) alwaysinline {",
      `  %n = icmp ult i64 %x, ${NUMBER_LIMIT}`,
      "  br i1 %n, label %num, label %slow",
      "num:",
      "  %d = bitcast i64 %x to double",
      "  ret double %d",
      "slow:",
      "  %y = call i64 @yk_pos(i64 %x)",
      "  %e = bitcast i64 %y to double",
      "  ret double %e",
      "}",
    ],
  },
  // A double boxed (NaN canonical).
  "yk.l.box": {
    ir: [
      "define linkonce_odr i64 @yk.l.box(double %d) alwaysinline {",
      "  %nan = fcmp uno double %d, %d",
      "  %b = bitcast double %d to i64",
      `  %r = select i1 %nan, i64 ${CANONICAL_NAN}, i64 %b`,
      "  ret i64 %r",
      "}",
    ],
  },
  // ToInt32 (as ToUint32's bits): a number below 2^63 in magnitude inline, else the runtime's `|`.
  "yk.l.i32": {
    runtime: ["yk_bitor"],
    decls: [FABS],
    ir: [
      "define linkonce_odr i32 @yk.l.i32(i64 %x) alwaysinline {",
      `  %n = icmp ult i64 %x, ${NUMBER_LIMIT}`,
      "  %d = bitcast i64 %x to double",
      "  %a = call double @llvm.fabs.f64(double %d)",
      "  %s = fcmp olt double %a, 9.2e18",
      "  %ok = select i1 %n, i1 %s, i1 false",
      "  br i1 %ok, label %fast, label %slow",
      "fast:",
      "  %w = fptosi double %d to i64",
      "  %t = trunc i64 %w to i32",
      "  ret i32 %t",
      "slow:",
      "  %y = call i64 @yk_bitor(i64 %x, i64 0)",
      "  %e = bitcast i64 %y to double",
      "  %w2 = fptosi double %e to i32",
      "  ret i32 %w2",
      "}",
    ],
  },
  // A BigInt's low 64 bits (a TypeError for anything else).
  "yk.l.big64": {
    runtime: ["yk_bigint_word"],
    helpers: ["yk.l.fail"],
    ir: [
      "define linkonce_odr i64 @yk.l.big64(i64 %x) alwaysinline {",
      "  %t = lshr i64 %x, 48",
      "  %b = icmp eq i64 %t, 65535",
      "  br i1 %b, label %ok, label %bad",
      "ok:",
      "  %w = call i64 @yk_bigint_word(i64 %x, i32 0)",
      "  ret i64 %w",
      "bad:",
      `  call void @yk.l.fail(ptr ${S.typeError.ref}, i64 ${S.typeError.len}, ptr ${S.big.ref}, i64 ${S.big.len}, i1 false, i64 0)`,
      "  unreachable",
      "}",
    ],
  },
  // An address: a number that is a non-negative integer below 2^53, as an integer; else a trap.
  "yk.l.addr": {
    helpers: ["yk.l.fail"],
    ir: [
      "define linkonce_odr i64 @yk.l.addr(i64 %x) alwaysinline {",
      `  %n = icmp ult i64 %x, ${NUMBER_LIMIT}`,
      "  %d = bitcast i64 %x to double",
      "  %ge = fcmp oge double %d, 0.0",
      "  %lt = fcmp olt double %d, 9007199254740992.0",
      "  %r1 = select i1 %n, i1 %ge, i1 false",
      "  %r2 = select i1 %r1, i1 %lt, i1 false",
      "  br i1 %r2, label %conv, label %bad",
      "conv:",
      "  %u = fptoui double %d to i64",
      "  %b = uitofp i64 %u to double",
      "  %int = fcmp oeq double %b, %d",
      "  br i1 %int, label %good, label %bad",
      "good:",
      "  ret i64 %u",
      "bad:",
      `  call void @yk.l.fail(ptr ${S.error.ref}, i64 ${S.error.len}, ptr ${S.address.ref}, i64 ${S.address.len}, i1 true, i64 %x)`,
      "  unreachable",
      "}",
    ],
  },
  // A value's BigInt's low 64 bits: a BigInt's own, a number's BigInt(x)'s.
  "yk.l.tobig64": {
    helpers: ["yk.l.big64", "yk.l.call1"],
    ir: [
      "define linkonce_odr i64 @yk.l.tobig64(i64 %x) {",
      "entry:",
      "  %t = lshr i64 %x, 48",
      "  %b = icmp eq i64 %t, 65535",
      "  br i1 %b, label %big, label %num",
      "num:",
      `  %y = call i64 @yk.l.call1(ptr ${S.bigint.ref}, i64 ${S.bigint.len}, i64 %x)`,
      "  br label %big",
      "big:",
      "  %v = phi i64 [ %x, %entry ], [ %y, %num ]",
      "  %w = call i64 @yk.l.big64(i64 %v)",
      "  ret i64 %w",
      "}",
    ],
  },
  // A BigInt of 64 bits: unsigned (hi 0) or signed (hi the sign).
  "yk.l.u64": {
    runtime: ["yk_bigint_from_i128"],
    ir: [
      "define linkonce_odr i64 @yk.l.u64(i64 %x) alwaysinline {",
      "  %r = call i64 @yk_bigint_from_i128(i64 %x, i64 0)",
      "  ret i64 %r",
      "}",
    ],
  },
  "yk.l.i64": {
    runtime: ["yk_bigint_from_i128"],
    ir: [
      "define linkonce_odr i64 @yk.l.i64(i64 %x) alwaysinline {",
      "  %h = ashr i64 %x, 63",
      "  %r = call i64 @yk_bigint_from_i128(i64 %x, i64 %h)",
      "  ret i64 %r",
      "}",
    ],
  },
  // A global function called with one number (BigInt(x), Number(x)): the cases the leaves leave to it.
  "yk.l.call1": {
    runtime: ["yk_global", "yk_call"],
    ir: [
      "define linkonce_odr i64 @yk.l.call1(ptr %name, i64 %nl, i64 %x) noinline {",
      "  %f = call i64 @yk_global(ptr %name, i64 %nl)",
      "  %argv = alloca i64",
      "  store i64 %x, ptr %argv",
      `  %r = call i64 @yk_call(i64 %f, i64 ${UNDEFINED}, i64 1, ptr %argv)`,
      "  ret i64 %r",
      "}",
    ],
  },
  // A block of n bytes aligned to al (at least 16), zeroed: the C library's, its own pointer kept
  // in the word before it, for the free.
  "yk.l.alloc": {
    runtime: ["yk_fail"],
    decls: [CALLOC],
    ir: [
      "define linkonce_odr i64 @yk.l.alloc(i64 %n, i64 %al0) {",
      "  %big = icmp ugt i64 %al0, 16",
      "  %al = select i1 %big, i64 %al0, i64 16",
      "  %t1 = add i64 %n, %al",
      "  %total = add i64 %t1, 16",
      "  %q = call ptr @yk_mem_alloc(i64 %total)",
      "  %none = icmp eq ptr %q, null",
      "  br i1 %none, label %oom, label %ok",
      "oom:",
      `  call void @yk_fail(ptr ${S.oom.ref})`,
      "  unreachable",
      "ok:",
      "  %qi = ptrtoint ptr %q to i64",
      "  %f = add i64 %qi, 16",
      "  %m = sub i64 %al, 1",
      "  %u = add i64 %f, %m",
      "  %d = udiv i64 %u, %al",
      "  %p = mul i64 %d, %al",
      "  %w = sub i64 %p, 8",
      "  %wp = inttoptr i64 %w to ptr",
      "  store ptr %q, ptr %wp",
      "  ret i64 %p",
      "}",
    ],
  },
  "yk.l.free": {
    decls: [FREE],
    ir: [
      "define linkonce_odr void @yk.l.free(i64 %a) {",
      "  %z = icmp eq i64 %a, 0",
      "  br i1 %z, label %done, label %go",
      "go:",
      "  %w = sub i64 %a, 8",
      "  %wp = inttoptr i64 %w to ptr",
      "  %q = load ptr, ptr %wp",
      "  call void @yk_mem_free(ptr %q)",
      "  br label %done",
      "done:",
      "  ret void",
      "}",
    ],
  },
};

/** Constant data's kinds: each element's size, its type and how a value converts to it. */
export const DATA_KINDS: Readonly<
  Record<string, { size: number; ty: string; conv: "int" | "big" | "f64" | "f32" }>
> = {
  i8: { size: 1, ty: "i8", conv: "int" },
  u8: { size: 1, ty: "i8", conv: "int" },
  i16: { size: 2, ty: "i16", conv: "int" },
  u16: { size: 2, ty: "i16", conv: "int" },
  i32: { size: 4, ty: "i32", conv: "int" },
  u32: { size: 4, ty: "i32", conv: "int" },
  i64: { size: 8, ty: "i64", conv: "big" },
  u64: { size: 8, ty: "i64", conv: "big" },
  f64: { size: 8, ty: "double", conv: "f64" },
  f32: { size: 4, ty: "float", conv: "f32" },
};
/**
 * `__ykData(kind, values)` of values only known when it runs: a block of the elements, each
 * converted (`yk_data_<kind>(values)`). The lowering calls it once per call site, and lays out the
 * data of literal elements as a constant itself.
 */
function dataLeaf(kind: string): Def {
  const k = DATA_KINDS[kind] as (typeof DATA_KINDS)[string];
  const conv =
    k.conv === "int"
      ? [
          "  %w = call i32 @yk.l.i32(i64 %v)",
          ...(k.ty === "i32" ? ["  %x = add i32 %w, 0"] : [`  %x = trunc i32 %w to ${k.ty}`]),
        ]
      : k.conv === "big"
        ? ["  %x = call i64 @yk.l.tobig64(i64 %v)"]
        : k.conv === "f64"
          ? ["  %x = call double @yk.l.num(i64 %v)"]
          : ["  %xd = call double @yk.l.num(i64 %v)", "  %x = fptrunc double %xd to float"];
  return {
    runtime: ["yk_get", "yk_string_utf8"],
    helpers: [
      "yk.l.num",
      "yk.l.alloc",
      k.conv === "int" ? "yk.l.i32" : k.conv === "big" ? "yk.l.tobig64" : "yk.l.num",
    ],
    ir: [
      `define linkonce_odr i64 @yk_data_${kind}(i64 %values) {`,
      "entry:",
      `  %ks = call i64 @yk_string_utf8(ptr ${S.length.ref}, i64 ${S.length.len})`,
      "  %lv = call i64 @yk_get(i64 %values, i64 %ks)",
      "  %ld = call double @yk.l.num(i64 %lv)",
      "  %n = fptoui double %ld to i64",
      `  %bytes = mul i64 %n, ${k.size}`,
      `  %p = call i64 @yk.l.alloc(i64 %bytes, i64 ${k.size})`,
      "  br label %loop",
      "loop:",
      "  %i = phi i64 [ 0, %entry ], [ %i1, %body ]",
      "  %more = icmp ult i64 %i, %n",
      "  br i1 %more, label %body, label %done",
      "body:",
      "  %id = uitofp i64 %i to double",
      "  %ib = bitcast double %id to i64",
      "  %v = call i64 @yk_get(i64 %values, i64 %ib)",
      ...conv,
      `  %off = mul i64 %i, ${k.size}`,
      "  %a = add i64 %p, %off",
      "  %ap = inttoptr i64 %a to ptr",
      `  store ${k.ty} %x, ptr %ap, align 1`,
      "  %i1 = add i64 %i, 1",
      "  br label %loop",
      "done:",
      "  %d = uitofp i64 %p to double",
      "  %r = bitcast double %d to i64",
      "  ret i64 %r",
      "}",
    ],
  };
}

/** Constant data of literal elements as its bytes, little-endian, each element converted. */
export function dataBytes(
  kind: string,
  values: readonly (number | bigint)[],
): Uint8Array | undefined {
  const k = DATA_KINDS[kind];
  if (k === undefined) return undefined;
  const out = new DataView(new ArrayBuffer(k.size * values.length));
  for (const [i, v] of values.entries()) {
    const at = i * k.size;
    if (k.conv === "int") {
      if (typeof v !== "number") return undefined;
      const u = v >>> 0;
      if (k.size === 1) out.setUint8(at, u & 255);
      else if (k.size === 2) out.setUint16(at, u & 65535, true);
      else out.setUint32(at, u, true);
    } else if (k.conv === "big") {
      if (typeof v === "number" && !Number.isInteger(v)) return undefined;
      out.setBigUint64(at, BigInt.asUintN(64, BigInt(v)), true);
    } else if (typeof v !== "number") return undefined;
    else if (k.conv === "f64") out.setFloat64(at, v, true);
    else out.setFloat32(at, v, true);
  }
  return new Uint8Array(out.buffer);
}

/** A leaf on boxed values: `define linkonce_odr i64 @name(i64 ...)`, its body over %a, %b. */
function leaf(name: string, arity: number, body: readonly string[], d: Omit<Def, "ir"> = {}): Def {
  const params = ["%a", "%b", "%c", "%d", "%e", "%f", "%g"].slice(0, arity);
  return {
    ...d,
    ir: [
      `define linkonce_odr i64 @${name}(${params.map((p) => `i64 ${p}`).join(", ")}) {`,
      ...body.map((l) => (l.endsWith(":") ? l : `  ${l}`)),
      "}",
    ],
  };
}

const LOADS: ReadonlyArray<[string, string, "u" | "f64" | "f32" | "u64"]> = [
  ["yk_leaf_load8", "i8", "u"],
  ["yk_leaf_load16", "i16", "u"],
  ["yk_leaf_load32", "i32", "u"],
  ["yk_leaf_load64", "i64", "u64"],
  ["yk_leaf_load_f64", "double", "f64"],
  ["yk_leaf_load_f32", "float", "f32"],
];
const STORES: ReadonlyArray<[string, string, "u" | "f64" | "f32" | "u64"]> = [
  ["yk_leaf_store8", "i8", "u"],
  ["yk_leaf_store16", "i16", "u"],
  ["yk_leaf_store32", "i32", "u"],
  ["yk_leaf_store64", "i64", "u64"],
  ["yk_leaf_store_f64", "double", "f64"],
  ["yk_leaf_store_f32", "float", "f32"],
];

const DEFS: Readonly<Record<string, Def>> = {
  ...HELPERS,
  ...Object.fromEntries(Object.keys(DATA_KINDS).map((k) => [`yk_data_${k}`, dataLeaf(k)])),
  yk_leaf_i32mul: leaf(
    "yk_leaf_i32mul",
    2,
    [
      "%x = call i32 @yk.l.i32(i64 %a)",
      "%y = call i32 @yk.l.i32(i64 %b)",
      "%p = mul i32 %x, %y",
      "%d = sitofp i32 %p to double",
      "%r = bitcast double %d to i64",
      "ret i64 %r",
    ],
    { helpers: ["yk.l.i32"] },
  ),
  yk_leaf_u64: leaf(
    "yk_leaf_u64",
    1,
    ["%x = call i64 @yk.l.big64(i64 %a)", "%r = call i64 @yk.l.u64(i64 %x)", "ret i64 %r"],
    { helpers: ["yk.l.big64", "yk.l.u64"] },
  ),
  yk_leaf_i64: leaf(
    "yk_leaf_i64",
    1,
    ["%x = call i64 @yk.l.big64(i64 %a)", "%r = call i64 @yk.l.i64(i64 %x)", "ret i64 %r"],
    { helpers: ["yk.l.big64", "yk.l.i64"] },
  ),
  yk_leaf_num_to_big: leaf(
    "yk_leaf_num_to_big",
    1,
    [
      "%t = lshr i64 %a, 48",
      "%isbig = icmp eq i64 %t, 65535",
      "br i1 %isbig, label %done, label %num",
      "num:",
      "%x = call double @yk.l.num(i64 %a)",
      "%ax = call double @llvm.fabs.f64(double %x)",
      "%small = fcmp olt double %ax, 9.2e18",
      "br i1 %small, label %conv, label %slow",
      "conv:",
      "%i = fptosi double %x to i64",
      "%back = sitofp i64 %i to double",
      "%int = fcmp oeq double %back, %x",
      "br i1 %int, label %fast, label %slow",
      "fast:",
      "%rf = call i64 @yk.l.i64(i64 %i)",
      "ret i64 %rf",
      "slow:",
      "%bx = call i64 @yk.l.box(double %x)",
      `%rs = call i64 @yk.l.call1(ptr ${S.bigint.ref}, i64 ${S.bigint.len}, i64 %bx)`,
      "ret i64 %rs",
      "done:",
      "ret i64 %a",
    ],
    { helpers: ["yk.l.num", "yk.l.i64", "yk.l.box", "yk.l.call1"], decls: [FABS] },
  ),
  yk_leaf_big_to_i32: leaf(
    "yk_leaf_big_to_i32",
    1,
    [
      "%x = call i64 @yk.l.big64(i64 %a)",
      "%t = trunc i64 %x to i32",
      "%d = sitofp i32 %t to double",
      "%r = bitcast double %d to i64",
      "ret i64 %r",
    ],
    { helpers: ["yk.l.big64"] },
  ),
  yk_leaf_big_to_u32: leaf(
    "yk_leaf_big_to_u32",
    1,
    [
      "%x = call i64 @yk.l.big64(i64 %a)",
      "%t = trunc i64 %x to i32",
      "%d = uitofp i32 %t to double",
      "%r = bitcast double %d to i64",
      "ret i64 %r",
    ],
    { helpers: ["yk.l.big64"] },
  ),
  // A BigInt's double: one of at most two words exactly rounded inline (its two's complement's
  // words), any other Number(x).
  yk_leaf_big_to_f64: leaf(
    "yk_leaf_big_to_f64",
    1,
    [
      "%lo = call i64 @yk.l.big64(i64 %a)",
      "%pi = and i64 %a, 281474976710655",
      "%p = inttoptr i64 %pi to ptr",
      "%lp = getelementptr i8, ptr %p, i64 4",
      "%len = load i32, ptr %lp",
      "%short = icmp ule i32 %len, 2",
      "br i1 %short, label %words, label %slow",
      "words:",
      "%hi = call i64 @yk_bigint_word(i64 %a, i32 1)",
      "%neg = icmp slt i64 %hi, 0",
      "br i1 %neg, label %negative, label %positive",
      "positive:",
      "%dp = uitofp i64 %lo to double",
      "%rp = bitcast double %dp to i64",
      "ret i64 %rp",
      "negative:",
      "%m = sub i64 0, %lo",
      "%dm = uitofp i64 %m to double",
      "%z = icmp eq i64 %lo, 0",
      "%dn0 = fneg double %dm",
      "%dn = select i1 %z, double -18446744073709551616.0, double %dn0",
      "%rn = bitcast double %dn to i64",
      "ret i64 %rn",
      "slow:",
      `%rs = call i64 @yk.l.call1(ptr ${S.number.ref}, i64 ${S.number.len}, i64 %a)`,
      "ret i64 %rs",
    ],
    { helpers: ["yk.l.big64", "yk.l.call1"], runtime: ["yk_bigint_word"] },
  ),
  yk_leaf_f64_to_i64: leaf(
    "yk_leaf_f64_to_i64",
    1,
    [
      "%x0 = call double @yk.l.num(i64 %a)",
      "%x = call double @llvm.trunc.f64(double %x0)",
      "%ax = call double @llvm.fabs.f64(double %x)",
      "%small = fcmp olt double %ax, 9.2e18",
      "br i1 %small, label %fast, label %slow",
      "fast:",
      "%i = fptosi double %x to i64",
      "%rf = call i64 @yk.l.i64(i64 %i)",
      "ret i64 %rf",
      "slow:",
      "%bx = call i64 @yk.l.box(double %x)",
      `%b = call i64 @yk.l.call1(ptr ${S.bigint.ref}, i64 ${S.bigint.len}, i64 %bx)`,
      "%lo = call i64 @yk.l.big64(i64 %b)",
      "%rs = call i64 @yk.l.i64(i64 %lo)",
      "ret i64 %rs",
    ],
    {
      helpers: ["yk.l.num", "yk.l.i64", "yk.l.box", "yk.l.call1", "yk.l.big64"],
      decls: [FABS, TRUNC],
    },
  ),
  yk_leaf_f64_bits: leaf(
    "yk_leaf_f64_bits",
    1,
    [
      "%x = call double @yk.l.num(i64 %a)",
      "%nan = fcmp uno double %x, %x",
      "%b0 = bitcast double %x to i64",
      `%b = select i1 %nan, i64 ${CANONICAL_NAN}, i64 %b0`,
      "%r = call i64 @yk.l.u64(i64 %b)",
      "ret i64 %r",
    ],
    { helpers: ["yk.l.num", "yk.l.u64"] },
  ),
  yk_leaf_f64_from_bits: leaf(
    "yk_leaf_f64_from_bits",
    1,
    [
      "%x = call i64 @yk.l.big64(i64 %a)",
      "%d = bitcast i64 %x to double",
      "%r = call i64 @yk.l.box(double %d)",
      "ret i64 %r",
    ],
    { helpers: ["yk.l.big64", "yk.l.box"] },
  ),
  yk_leaf_f64_hi: leaf(
    "yk_leaf_f64_hi",
    1,
    [
      "%x = call double @yk.l.num(i64 %a)",
      "%nan = fcmp uno double %x, %x",
      "%b0 = bitcast double %x to i64",
      `%b = select i1 %nan, i64 ${CANONICAL_NAN}, i64 %b0`,
      "%h = lshr i64 %b, 32",
      "%d = uitofp i64 %h to double",
      "%r = bitcast double %d to i64",
      "ret i64 %r",
    ],
    { helpers: ["yk.l.num"] },
  ),
  yk_leaf_f64_lo: leaf(
    "yk_leaf_f64_lo",
    1,
    [
      "%x = call double @yk.l.num(i64 %a)",
      "%nan = fcmp uno double %x, %x",
      "%b0 = bitcast double %x to i64",
      `%b = select i1 %nan, i64 ${CANONICAL_NAN}, i64 %b0`,
      "%l = and i64 %b, 4294967295",
      "%d = uitofp i64 %l to double",
      "%r = bitcast double %d to i64",
      "ret i64 %r",
    ],
    { helpers: ["yk.l.num"] },
  ),
  yk_leaf_f64_make: leaf(
    "yk_leaf_f64_make",
    2,
    [
      "%h = call i32 @yk.l.i32(i64 %a)",
      "%l = call i32 @yk.l.i32(i64 %b)",
      "%hz = zext i32 %h to i64",
      "%lz = zext i32 %l to i64",
      "%hs = shl i64 %hz, 32",
      "%u = or i64 %hs, %lz",
      "%d = bitcast i64 %u to double",
      "%r = call i64 @yk.l.box(double %d)",
      "ret i64 %r",
    ],
    { helpers: ["yk.l.i32", "yk.l.box"] },
  ),
  yk_leaf_f32: leaf(
    "yk_leaf_f32",
    1,
    [
      "%x = call double @yk.l.num(i64 %a)",
      "%f = fptrunc double %x to float",
      "%d = fpext float %f to double",
      "%r = call i64 @yk.l.box(double %d)",
      "ret i64 %r",
    ],
    { helpers: ["yk.l.num", "yk.l.box"] },
  ),
  // __ykAlloc(size, align): size bytes (rounded up to a whole one), zeroed.
  yk_leaf_alloc: leaf(
    "yk_leaf_alloc",
    2,
    [
      "%s = call double @yk.l.num(i64 %a)",
      "%al = call double @yk.l.num(i64 %b)",
      "%ge = fcmp oge double %s, 0.0",
      "%lt = fcmp olt double %s, 9007199254740992.0",
      "%ok = and i1 %ge, %lt",
      "br i1 %ok, label %go, label %bad",
      "go:",
      "%sc = call double @llvm.ceil.f64(double %s)",
      "%n = fptoui double %sc to i64",
      "%alok = fcmp oge double %al, 1.0",
      "%al1 = select i1 %alok, double %al, double 1.0",
      "%ali = fptoui double %al1 to i64",
      "%p = call i64 @yk.l.alloc(i64 %n, i64 %ali)",
      "%d = uitofp i64 %p to double",
      "%r = bitcast double %d to i64",
      "ret i64 %r",
      "bad:",
      `call void @yk.l.fail(ptr ${S.error.ref}, i64 ${S.error.len}, ptr ${S.size.ref}, i64 ${S.size.len}, i1 true, i64 %a)`,
      "unreachable",
    ],
    { helpers: ["yk.l.num", "yk.l.alloc", "yk.l.fail"], decls: [CEIL] },
  ),
  yk_leaf_free: leaf(
    "yk_leaf_free",
    1,
    ["%u = call i64 @yk.l.addr(i64 %a)", "call void @yk.l.free(i64 %u)", `ret i64 ${UNDEFINED}`],
    { helpers: ["yk.l.addr", "yk.l.free"] },
  ),
  // A function's address: its closure's.
  yk_leaf_fn_addr: leaf(
    "yk_leaf_fn_addr",
    1,
    [
      "%t = lshr i64 %a, 48",
      "%f = icmp eq i64 %t, 65533",
      "br i1 %f, label %ok, label %bad",
      "ok:",
      "%p = and i64 %a, 281474976710655",
      "%d = uitofp i64 %p to double",
      "%r = bitcast double %d to i64",
      "ret i64 %r",
      "bad:",
      `call void @yk.l.fail(ptr ${S.typeError.ref}, i64 ${S.typeError.len}, ptr ${S.fnAddr.ref}, i64 ${S.fnAddr.len}, i1 false, i64 0)`,
      "unreachable",
    ],
    { helpers: ["yk.l.fail"] },
  ),
  yk_leaf_fn_at: leaf(
    "yk_leaf_fn_at",
    1,
    [
      "%u = call i64 @yk.l.addr(i64 %a)",
      "%z = icmp eq i64 %u, 0",
      "br i1 %z, label %bad, label %ok",
      "ok:",
      `%r = or i64 %u, ${T_CLOSURE}`,
      "ret i64 %r",
      "bad:",
      `call void @yk.l.fail(ptr ${S.typeError.ref}, i64 ${S.typeError.len}, ptr ${S.fnAt.ref}, i64 ${S.fnAt.len}, i1 false, i64 0)`,
      "unreachable",
    ],
    { helpers: ["yk.l.addr", "yk.l.fail"] },
  ),
  ...Object.fromEntries(
    LOADS.map(([name, ty, kind]) => [
      name,
      leaf(
        name,
        1,
        [
          "%u = call i64 @yk.l.addr(i64 %a)",
          "%p = inttoptr i64 %u to ptr",
          `%v = load ${ty}, ptr %p, align 1`,
          ...(kind === "u"
            ? [
                `%z = zext ${ty} %v to i64`,
                "%d = uitofp i64 %z to double",
                "%r = bitcast double %d to i64",
              ]
            : kind === "u64"
              ? ["%r = call i64 @yk.l.u64(i64 %v)"]
              : kind === "f64"
                ? ["%r = call i64 @yk.l.box(double %v)"]
                : ["%d = fpext float %v to double", "%r = call i64 @yk.l.box(double %d)"]),
          "ret i64 %r",
        ],
        {
          helpers: [
            "yk.l.addr",
            ...(kind === "u64" ? ["yk.l.u64"] : kind === "u" ? [] : ["yk.l.box"]),
          ],
        },
      ),
    ]),
  ),
  ...Object.fromEntries(
    STORES.map(([name, ty, kind]) => [
      name,
      leaf(
        name,
        2,
        [
          "%u = call i64 @yk.l.addr(i64 %a)",
          "%p = inttoptr i64 %u to ptr",
          ...(kind === "u"
            ? [
                "%w = call i32 @yk.l.i32(i64 %b)",
                ...(ty === "i32" ? ["%v = add i32 %w, 0"] : [`%v = trunc i32 %w to ${ty}`]),
              ]
            : kind === "u64"
              ? ["%v = call i64 @yk.l.big64(i64 %b)"]
              : kind === "f64"
                ? ["%v = call double @yk.l.num(i64 %b)"]
                : ["%x = call double @yk.l.num(i64 %b)", "%v = fptrunc double %x to float"]),
          `store ${ty} %v, ptr %p, align 1`,
          "ret i64 %b",
        ],
        {
          helpers: [
            "yk.l.addr",
            kind === "u" ? "yk.l.i32" : kind === "u64" ? "yk.l.big64" : "yk.l.num",
          ],
        },
      ),
    ]),
  ),
  // The typed lowering's own (#1369): a frame's block by its size and alignment, its address a
  // number's bits; its free; a raw block's access past its end; ToUint32 of a double; a BigInt's
  // low word.
  yk_frame_alloc: {
    helpers: ["yk.l.alloc"],
    ir: [
      "define linkonce_odr i64 @yk_frame_alloc(i64 %n, i64 %al) {",
      "  %p = call i64 @yk.l.alloc(i64 %n, i64 %al)",
      "  %d = uitofp i64 %p to double",
      "  %r = bitcast double %d to i64",
      "  ret i64 %r",
      "}",
    ],
  },
  yk_frame_free: {
    helpers: ["yk.l.free"],
    ir: [
      "define linkonce_odr void @yk_frame_free(i64 %bits) {",
      "  %d = bitcast i64 %bits to double",
      "  %a = fptoui double %d to i64",
      "  call void @yk.l.free(i64 %a)",
      "  ret void",
      "}",
    ],
  },
  yk_raw_trap: {
    helpers: ["yk.l.fail"],
    ir: [
      "define linkonce_odr void @yk_raw_trap(i64 %off, i64 %size) noinline noreturn cold {",
      `  call void @yk.l.fail(ptr ${S.error.ref}, i64 ${S.error.len}, ptr ${S.raw.ref}, i64 ${S.raw.len}, i1 false, i64 0)`,
      "  unreachable",
      "}",
    ],
  },
  yk_double_to_uint32: {
    decls: [FABS, TRUNC],
    ir: [
      "define linkonce_odr i32 @yk_double_to_uint32(double %d) {",
      "  %a = call double @llvm.fabs.f64(double %d)",
      "  %small = fcmp olt double %a, 9.2e18",
      "  br i1 %small, label %fast, label %big",
      "fast:",
      "  %w = fptosi double %d to i64",
      "  %t = trunc i64 %w to i32",
      "  ret i32 %t",
      "big:",
      // NaN and the infinities are 0; any other is its integer modulo 2^32 (frem is exact).
      "  %fin = fcmp olt double %a, 0x7FF0000000000000",
      "  br i1 %fin, label %mod, label %zero",
      "mod:",
      "  %tr = call double @llvm.trunc.f64(double %d)",
      "  %r = frem double %tr, 4294967296.0",
      "  %neg = fcmp olt double %r, 0.0",
      "  %r2 = fadd double %r, 4294967296.0",
      "  %r3 = select i1 %neg, double %r2, double %r",
      "  %u = fptoui double %r3 to i32",
      "  ret i32 %u",
      "zero:",
      "  ret i32 0",
      "}",
    ],
  },
  yk_big_low64: {
    helpers: ["yk.l.big64"],
    ir: [
      "define linkonce_odr i64 @yk_big_low64(i64 %x) {",
      "  %r = call i64 @yk.l.big64(i64 %x)",
      "  ret i64 %r",
      "}",
    ],
  },
};

/** The leaves (and the typed lowering's memory functions) this file defines in LLVM. */
export const LLVM_LEAVES: ReadonlySet<string> = new Set(
  Object.keys(DEFS).filter((k) => !k.startsWith("yk.l.")),
);

/**
 * The definitions of the leaves a module uses: `used` loses each leaf it defines and gains the
 * runtime's functions they call; `decls` gains the declarations they need. Their IR, once each.
 */
export function leafDefinitions(used: Set<string>, decls: Set<string>): string[] {
  const out: string[] = [];
  const done = new Set<string>();
  const strings = new Set<string>();
  const visit = (name: string): void => {
    if (done.has(name)) return;
    done.add(name);
    const d = DEFS[name] as Def;
    for (const h of d.helpers ?? []) visit(h);
    for (const r of d.runtime ?? []) used.add(r);
    for (const x of d.decls ?? []) decls.add(x);
    for (const l of d.ir) for (const m of l.matchAll(/@yk\.l\.s\.[a-z_]+/g)) strings.add(m[0]);
    out.push(...d.ir, "");
  };
  for (const name of [...used].sort()) {
    if (!LLVM_LEAVES.has(name)) continue;
    used.delete(name);
    visit(name);
  }
  for (const s of Object.values(S)) if (strings.has(s.ref)) out.unshift(s.decl);
  return out;
}

/**
 * A leaf as a function value (`const load = __ykLoad8`): a closure's code calling it with its
 * arguments (undefined past argc). Its name, and its definition.
 */
export function leafValueCode(fn: string, arity: number): { name: string; ir: string[] } {
  const name = `yk.lv.${fn}`;
  const ir = [
    `define linkonce_odr i64 @${name}(ptr %closure, i64 %this, i64 %argc, ptr %argv) {`,
    "entry:",
  ];
  const args: string[] = [];
  for (let i = 0; i < arity; i++) {
    ir.push(
      `  %has${i} = icmp ugt i64 %argc, ${i}`,
      `  %at${i} = getelementptr i64, ptr %argv, i64 ${i}`,
      `  br i1 %has${i}, label %load${i}, label %skip${i}`,
      `load${i}:`,
      `  %v${i} = load i64, ptr %at${i}`,
      `  br label %skip${i}`,
      `skip${i}:`,
      `  %x${i} = phi i64 [ %v${i}, %load${i} ], [ ${UNDEFINED}, %${i === 0 ? "entry" : `skip${i - 1}`} ]`,
    );
    args.push(`i64 %x${i}`);
  }
  ir.push(`  %r = call i64 @${fn}(${args.join(", ")})`, "  ret i64 %r", "}", "");
  return { name, ir };
}
