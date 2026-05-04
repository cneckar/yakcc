// SPDX-License-Identifier: MIT
/**
 * visitor.ts — Recursive-descent LoweringVisitor for the TS→WASM lowering pass.
 *
 * Purpose:
 *   Parse a `ResolvedBlock.source` string into a ts-morph `SourceFile` and walk
 *   the AST, producing a `WasmFunction` for each exported function. WI-01 built
 *   the scaffold with 5 wave-2 fast-paths; this WI (WI-V1W3-WASM-LOWER-02) adds
 *   general numeric lowering: number→i32/i64/f64 inference + arithmetic/comparison/
 *   bitop expression emission.
 *
 * Wave-2 fast-path:
 *   The 5 wave-2 substrates (add, string_bytecount, format_i32, sum_record,
 *   sum_array) are recognised by AST shape and take a fast-path that returns the
 *   same opcode sequences hand-rolled in wasm-backend.ts. This preserves the
 *   wave-2 parity matrix while routing all dispatch through the visitor.
 *
 * General numeric lowering (WI-V1W3-WASM-LOWER-02):
 *   Functions not matching a wave-2 shape but with only numeric (number) params/
 *   return types are lowered via the general path. Inference policy is captured
 *   in @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001 below.
 *
 * bigint → i64 lowering (WI-V1W3-WASM-LOWER-04):
 *   Functions with `bigint`-typed params or return type are lowered via the i64
 *   domain. Detection: inferNumericDomain rule -1 checks TypeFlags.BigInt/BigIntLiteral
 *   on the function signature; rule 7 scans the body for BigIntLiteral AST nodes.
 *   New I64_BITOP_OPS table wires i64.and/or/xor/shl/shr_s/shr_u for bigint bitops.
 *   BigInt(n) coercion emits i64.extend_i32_s (0xac) for i32→i64 widening.
 *   Mixed bigint+number params are supported via per-param domain resolution in
 *   _lowerNumericFunction; paramDomains is added to LoweringResult for callers
 *   that build heterogeneous WASM type signatures.
 *   Overflow semantics: WASM i64 wraps at 2^63; BigInt.asIntN(64, x) is the oracle.
 *   @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001 (see inferNumericDomain and below)
 *
 * Unknown node kinds:
 *   Per Sacred Practice #5 (fail loudly and early, never silently), any AST node
 *   kind not yet handled throws a `LoweringError` with kind "unsupported-node"
 *   naming the SyntaxKind. Silent fallthrough would produce corrupt WASM and
 *   mislead Future Implementers — it is explicitly prohibited.
 *
 * @decision DEC-V1-WAVE-3-WASM-PARSE-001
 * @title Lower from ts-morph AST parsed at codegen-time from ResolvedBlock.source
 * @status accepted
 * @rationale
 *   ResolvedBlock carries only `source: string` — no precomputed AST. ts-morph
 *   provides a high-level TypeScript AST over the TS compiler API, which the
 *   wave-2 forbidden list bars re-implementing. ts-morph's typechecker also
 *   answers the i32/i64/f64 inference question in WI-V1W3-WASM-LOWER-02 — a
 *   separate parser would re-implement that infrastructure. Using ts-morph at
 *   compile-time (per block, on demand) avoids adding a persistent process or
 *   IPC channel. See MASTER_PLAN.md DEC-V1-WAVE-3-WASM-PARSE-001.
 *
 * @decision DEC-V1-WAVE-3-WASM-WAVE2-FAST-PATH-001
 * @title Wave-2 substrates take a body-level fast-path inside the visitor
 * @status accepted
 * @rationale
 *   Routing wave-2 substrates through the full visitor (without fast-paths) would
 *   require WI-01 to implement expression lowering, return statements, arithmetic
 *   operators, memory loads, and loop/block control flow all at once — that is the
 *   entire scope of WIs 02–08. Fast-paths let WI-01 land the scaffold and regression
 *   gate without blocking the remaining wave-3 work. Each fast-path is guarded by
 *   an explicit `detectWave2Shape()` check and will be replaced by general lowering
 *   as each WI adds the corresponding node kinds.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001
 * @title Numeric domain inference policy: i32/i64/f64 from AST heuristics
 * @status accepted
 * @rationale
 *   TypeScript's type system has a single `number` type — there is no `int` vs
 *   `float` distinction at the type level. Domain inference must therefore use
 *   AST-level heuristics applied to the function body:
 *
 *   i32: The function body contains bitwise operators (& | ^ ~ << >> >>>), uses
 *        Math.floor/Math.ceil/Math.round/Math.trunc, uses array indexing, or all
 *        operands are integer literals and no float-forcing construct is present.
 *        Value range is assumed to fit i32 unless the literals indicate otherwise.
 *
 *   f64: The function body contains true-division (/), calls Math.sqrt/sin/cos/
 *        log/exp/pow/abs/hypot/atan2, or uses Number.isFinite/Number.isNaN.
 *        Also: any numeric literal with a decimal point (e.g. 1.5) forces f64.
 *
 *   i64: Integer-typed bodies where a literal or explicit annotation indicates
 *        values that could exceed i32 range (> 2^31-1). In practice, within the
 *        IR strict-subset, explicit large integer constants (> 2^31-1 or < -2^31)
 *        trigger i64. Note: bigint→i64 is a separate lowering path (WI-04).
 *
 *   Ambiguous → f64: When no heuristic conclusively identifies the domain (e.g. a
 *        function with only `return a + b` and no hints), the domain defaults to
 *        f64 with a downgrade warning appended to `LoweringResult.warnings`. This
 *        is conservative: f64 is never lossy for values that fit i32, but emitting
 *        f64 ops on integer data is slightly larger. The warning lets callers add
 *        explicit hints if i32 is desired.
 *
 *   This policy is closed by WI-V1W3-WASM-LOWER-02; WI-03–WI-11 extend coverage
 *   to booleans, bigint, strings, records, arrays, control flow, closures.
 */

import {
  type BigIntLiteral,
  type BinaryExpression,
  type Block,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type IfStatement,
  type NoSubstitutionTemplateLiteral,
  type NumericLiteral,
  type PrefixUnaryExpression,
  Project,
  type PropertyAccessExpression,
  type ReturnStatement,
  type SourceFile,
  type Statement,
  type StringLiteral,
  SyntaxKind,
  type TaggedTemplateExpression,
  type TemplateExpression,
  TypeFlags,
  type VariableStatement,
} from "ts-morph";

import { SymbolTable } from "./symbol-table.js";
import type { LocalDecl, WasmFunction } from "./wasm-function.js";
import type { NumericDomain } from "./wasm-function.js";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** The category of a lowering failure. */
export type LoweringErrorKind =
  | "unsupported-node" // AST node kind not yet implemented (loud failure)
  | "unsupported-capture" // closure capture placeholder (WI-10 fills this)
  | "missing-export" // source has no exported function
  | "parse-error"; // ts-morph reports a hard parse error

/**
 * Thrown when the visitor encounters a condition it cannot handle.
 *
 * Always names the offending SyntaxKind (for "unsupported-node") or a
 * descriptive message so Future Implementers can identify exactly which WI
 * needs to add coverage.
 */
export class LoweringError extends Error {
  readonly kind: LoweringErrorKind;

  constructor(opts: { kind: LoweringErrorKind; message: string }) {
    super(opts.message);
    this.name = "LoweringError";
    this.kind = opts.kind;
  }
}

// ---------------------------------------------------------------------------
// String-function shape detection (WI-V1W3-WASM-LOWER-05)
//
// detectStringShape classifies string-param/return functions before the wave-2
// fast-path check runs, preventing misrouting to string_bytecount/format_i32.
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001
// @decision DEC-V1-WAVE-3-WASM-LOWER-STR-INDEXOF-001
// @decision DEC-V1-WAVE-3-WASM-LOWER-STR-OUT-PTR-001
// @decision DEC-V1-WAVE-3-WASM-LOWER-STR-EQ-001
// @decision DEC-V1-WAVE-3-WASM-LOWER-STR-DATA-SECTION-001
// ---------------------------------------------------------------------------

/**
 * Metadata for a string-lowering shape.
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-DATA-SECTION-001
 */
export interface StringShapeMeta {
  readonly shape:
    | "str-length"
    | "str-indexof"
    | "str-slice2"
    | "str-slice1"
    | "str-concat"
    | "str-template-concat"
    | "str-template-parts"
    | "str-eq"
    | "str-neq";
  /** Literal values from template spans. Non-empty only for str-template-parts. */
  readonly literals: readonly string[];
  /** TS-source parameter count (not counting injected out_ptr). */
  readonly tsParamCount: number;
}

/**
 * Detect whether fn is a string-operation and classify its shape.
 * Returns null for non-string functions.
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001
 */
function detectStringShape(fn: FunctionDeclaration): StringShapeMeta | null {
  const source = fn.getText();
  const sigMatch = source.match(/function\s+\w+\s*\(([^)]*)\)\s*:\s*([^{;]+)/);
  if (sigMatch === null) return null;
  const params = sigMatch[1] ?? "";
  const returnType = (sigMatch[2] ?? "").trim();
  const hasStringParam = params.includes("string");
  const hasStringReturn = returnType === "string";
  const hasBoolReturn = returnType === "boolean";
  if (!hasStringParam && !hasStringReturn) return null;
  const tsParams = fn.getParameters();
  const tsParamCount = tsParams.length;
  const body = source.replace(/^[\s\S]*?function\s+\w+\s*\([^)]*\)\s*:\s*[^{]+/, "").trim();
  if (/^\{\s*return\s+\w+\.length\s*;\s*\}$/.test(body))
    return { shape: "str-length", literals: [], tsParamCount };
  if (/^\{\s*return\s+\w+\.indexOf\(\w+\)\s*;\s*\}$/.test(body))
    return { shape: "str-indexof", literals: [], tsParamCount };
  if (hasBoolReturn && /^\{\s*return\s+\w+\s*===\s*\w+\s*;\s*\}$/.test(body))
    return { shape: "str-eq", literals: [], tsParamCount };
  if (hasBoolReturn && /^\{\s*return\s+\w+\s*!==\s*\w+\s*;\s*\}$/.test(body))
    return { shape: "str-neq", literals: [], tsParamCount };
  if (/^\{\s*return\s+\w+\.slice\(\w+,\s*\w+\)\s*;\s*\}$/.test(body))
    return { shape: "str-slice2", literals: [], tsParamCount };
  if (/^\{\s*return\s+\w+\.slice\(\w+\)\s*;\s*\}$/.test(body))
    return { shape: "str-slice1", literals: [], tsParamCount };
  if (hasStringReturn) {
    const cm = body.match(/^\{\s*return\s+(\w+)\s*\+\s*(\w+)\s*;\s*\}$/);
    if (cm !== null) {
      const pnames = tsParams.map((p) => p.getName());
      if (pnames.includes(cm[1] ?? "") && pnames.includes(cm[2] ?? ""))
        return { shape: "str-concat", literals: [], tsParamCount };
    }
    const tc = body.match(/^\{\s*return\s+`\$\{(\w+)\}\$\{(\w+)\}`\s*;\s*\}$/);
    if (tc !== null) return { shape: "str-template-concat", literals: [], tsParamCount };
    const tp = body.match(/^\{\s*return\s+`([^`]*)\$\{(\w+)\}([^`]*)`\s*;\s*\}$/);
    if (tp !== null) {
      const prefix = tp[1] ?? "";
      const suffix = tp[3] ?? "";
      if (prefix.length > 0 || suffix.length > 0)
        return { shape: "str-template-parts", literals: [prefix, suffix], tsParamCount };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wave-2 substrate shape detection
//
// These checks mirror the logic in detectSubstrateKind() in wasm-backend.ts.
// They operate on the ts-morph FunctionDeclaration rather than raw strings so
// the visitor remains the single dispatch point.
//
// @decision DEC-V1-WAVE-3-WASM-WAVE2-FAST-PATH-001 (see file header)
// ---------------------------------------------------------------------------

type Wave2Shape = "add" | "string_bytecount" | "format_i32" | "sum_record" | "sum_array" | null;

/**
 * Detect whether `fn` matches one of the 5 wave-2 substrate shapes.
 *
 * Detection uses the same heuristics as the original `detectSubstrateKind`
 * (string-based), but applied to the ts-morph node for consistency and to
 * keep the visitor as the single dispatch point.
 *
 * Returns null if the function does not match any wave-2 shape — the visitor
 * must then attempt general lowering (which throws "unsupported-node" for any
 * AST kind not yet covered).
 */
function detectWave2Shape(fn: FunctionDeclaration): Wave2Shape {
  // Re-use the string-level heuristic on the function text for this WI.
  // WI-02 replaces general lowering with type-inference-based detection;
  // the wave-2 fast-paths themselves are preserved as-is for byte-equivalence.
  const source = fn.getText();

  // Extract signature text for pattern matching
  const sigMatch = source.match(/function\s+\w+\s*\(([^)]*)\)\s*:\s*([^{;]+)/);
  if (sigMatch === null) return null;
  const params = sigMatch[1] ?? "";
  const returnType = (sigMatch[2] ?? "").trim();

  if (returnType.includes("string")) return "format_i32";
  // sum_record: ONLY match the exact wave-2 substrate pattern.
  //
  // @decision DEC-V1-WAVE-3-WASM-LOWER-SUM-RECORD-NARROW-001
  // @title wave-2 sum_record fast-path narrowed to single-param record with 2-field sum body
  // @status accepted
  // @rationale
  //   The original heuristic `params.includes("{")` matched ANY function with a record-typed
  //   param, including WI-06 record functions (which have `_size: number` as a second param
  //   and use 8-byte alignment). Narrowing to the exact wave-2 pattern (exactly 1 TS param
  //   that is a record type, return type "number", body matches `return r.<f> + r.<g>`)
  //   ensures only the original `sumRecord(r: {a: number; b: number}): number { return r.a + r.b; }`
  //   substrate takes the fast-path. All other record functions fall through to detectRecordShape.
  //   The wave-2 parity gate (`WI-V1W2-WASM-02 parity — substrate 4`) is preserved because
  //   the exact two-field sum matches this pattern. The wave-2 fast-path also uses 4-byte
  //   alignment (ptr+0, ptr+4) from bodySumRecord() which differs from the WI-06 8-byte layout.
  if (
    (params.includes("{") || params.includes("Record")) &&
    returnType === "number" &&
    // Exactly one TS parameter (wave-2 sum_record has no _size param)
    fn.getParameters().length === 1 &&
    // Body must be `return r.field + r.field` (two-field property access sum)
    /\{[^}]*return\s+\w+\.\w+\s*\+\s*\w+\.\w+\s*;[^}]*\}/.test(source)
  ) {
    return "sum_record";
  }
  // sum_array: ONLY match the exact wave-2 substrate pattern.
  //
  // @decision DEC-V1-WAVE-3-WASM-LOWER-SUM-ARRAY-NARROW-001
  // @title wave-2 sum_array fast-path narrowed to the exact sumArray substrate (single array
  //        param, number return type, body uses .reduce)
  // @status accepted
  // @rationale
  //   The original `params.includes("[]")` check matched ANY function with an array-typed
  //   param, including WI-07 array functions (which use (ptr, length, capacity) triple ABI
  //   and need the general array lowering path). Narrowing to the exact wave-2 pattern
  //   (exactly 1 TS parameter that is an array type, return type "number", body contains
  //   `.reduce`) ensures only the original sumArray substrate takes the fast-path.
  //   All other array functions fall through to detectArrayShape() (WI-07).
  //   The wave-2 parity gate is preserved because the exact `.reduce` call matches this pattern.
  if (
    (params.includes("[]") || params.includes("Array<")) &&
    returnType === "number" &&
    fn.getParameters().length === 1 &&
    source.includes(".reduce(")
  ) {
    return "sum_array";
  }
  // string_bytecount: only fire when at least one parameter has a TOP-LEVEL `string`
  // type annotation — not when "string" appears only inside a record type `{ field: string }`.
  // Use fn.getParameters() to inspect the actual type node text, not the raw params string.
  //
  // @decision DEC-V1-WAVE-3-WASM-LOWER-STR-BYTECOUNT-NARROW-001
  // @title string_bytecount fast-path requires a top-level string-typed parameter
  // @status accepted
  // @rationale
  //   The raw `params` text for a record function like `firstLen(r: { name: string }, _size)`
  //   includes the word "string" (from the field type inside the record annotation). The original
  //   `params.includes("string")` check would incorrectly route this to string_bytecount, emitting
  //   `local.get 1` (the _size param) instead of the correct record field access. Checking
  //   `fn.getParameters()` for a parameter whose TOP-LEVEL type annotation equals "string"
  //   (not a type that merely contains "string") prevents false matches on record-of-string params.
  if (fn.getParameters().some((p) => p.getTypeNode()?.getText().trim() === "string")) {
    return "string_bytecount";
  }

  // "add" fast-path (WI-V1W3-WASM-LOWER-02 refinement):
  // Only match the specific wave-2 "add" substrate shape — a two-param numeric
  // function whose body is a plain `return a + b` without bitops, division, or
  // Math calls. All other numeric-returning functions fall through to general
  // numeric lowering (WI-V1W3-WASM-LOWER-02), which infers i32/i64/f64 from
  // the body and emits the correct opcodes.
  //
  // Detection: body must contain `return <p1> + <p2>` (no other operators).
  // Extract param names from the signature for the match.
  //
  // @decision DEC-V1-WAVE-3-WASM-LOWER-ADD-FASTPATH-001
  // @title Wave-2 "add" fast-path is limited to the exact two-param addition shape
  // @status accepted
  // @rationale
  //   The wave-2 fast-path emits i32.add for ALL numeric-returning functions if
  //   the return type is "number". This was correct in WI-01 (no general lowering
  //   existed), but with WI-02's general lowering, a function like `bitops(a,b):
  //   number { return a & b; }` would be miscompiled as `a + b`. The fast-path
  //   is now restricted to the exact `return <a> + <b>` body form (matching the
  //   wave-2 "add" substrate). All other numeric functions route to general lowering.
  //   Wave-2 parity tests for the `add` substrate continue to pass because they
  //   use the exact two-param `a + b` pattern.
  if (returnType === "number") {
    // Check body: must be `{ return <p1> + <p2>; }` with no other content.
    // Normalise whitespace and check the return statement pattern.
    const bodyMatch = source.match(/\{[^}]*return\s+(\w+)\s*\+\s*(\w+)\s*;[^}]*\}/);
    if (bodyMatch !== null) {
      // Verify both identifiers are parameter names (not arbitrary identifiers)
      const paramList = params.split(",").map((p) => p.trim().split(/[\s:]/)[0] ?? "");
      const lhs = bodyMatch[1] ?? "";
      const rhs = bodyMatch[2] ?? "";
      if (paramList.includes(lhs) && paramList.includes(rhs)) {
        return "add";
      }
    }
    // Does not match the add shape — fall through to general lowering.
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wave-2 fast-path opcode sequences
//
// These reproduce the body bytes from wasm-backend.ts exactly.
// Each fast-path populates the SymbolTable for the function's params so that
// the table is consistent even on the fast-path (tests probe the table).
//
// @decision DEC-V1-WAVE-3-WASM-WAVE2-FAST-PATH-001 (see file header)
// ---------------------------------------------------------------------------

function fastPathAdd(fn: FunctionDeclaration, table: SymbolTable): WasmFunction {
  table.pushFrame({ isFunctionBoundary: true });
  table.defineParam("a", "i32");
  table.defineParam("b", "i32");
  table.popFrame();

  return {
    locals: [],
    body: [
      0x20,
      0x00, // local.get 0 (a)
      0x20,
      0x01, // local.get 1 (b)
      0x6a, // i32.add
    ],
  };
}

function fastPathStringBytecount(fn: FunctionDeclaration, table: SymbolTable): WasmFunction {
  table.pushFrame({ isFunctionBoundary: true });
  // String calling convention: (ptr: i32, len: i32)
  const paramNames = fn.getParameters().map((p) => p.getName());
  table.defineParam(paramNames[0] ?? "ptr", "i32");
  table.defineParam(paramNames[1] ?? "len", "i32");
  table.popFrame();

  return {
    locals: [],
    body: [
      0x20,
      0x01, // local.get 1 (len)
    ],
  };
}

function fastPathFormatI32(fn: FunctionDeclaration, table: SymbolTable): WasmFunction {
  table.pushFrame({ isFunctionBoundary: true });
  const paramNames = fn.getParameters().map((p) => p.getName());
  table.defineParam(paramNames[0] ?? "n", "i32");
  table.defineParam("out", "i32"); // extra out_ptr param injected by lowering
  table.popFrame();

  return {
    locals: [],
    body: [
      // if (n < 10): write single digit and return 1
      0x20,
      0x00, // local.get 0  (n)
      0x41,
      0x0a, // i32.const 10
      0x49, // i32.lt_u
      0x04,
      0x40, // if void
      0x20,
      0x01, // local.get 1  (out)
      0x20,
      0x00, // local.get 0  (n)
      0x41,
      0x30, // i32.const 48 ('0')
      0x6a, // i32.add          (n + '0')
      0x3a,
      0x00,
      0x00, // i32.store8 align=0 offset=0
      0x41,
      0x01, // i32.const 1
      0x0f, // return
      0x0b, // end if
      // out[0] = n / 10 + '0'   (tens digit)
      0x20,
      0x01, // local.get 1  (out)
      0x20,
      0x00, // local.get 0  (n)
      0x41,
      0x0a, // i32.const 10
      0x6d, // i32.div_u
      0x41,
      0x30, // i32.const 48
      0x6a, // i32.add
      0x3a,
      0x00,
      0x00, // i32.store8 align=0 offset=0
      // out[1] = n % 10 + '0'   (ones digit)
      0x20,
      0x01, // local.get 1  (out)
      0x41,
      0x01, // i32.const 1
      0x6a, // i32.add          (out + 1)
      0x20,
      0x00, // local.get 0  (n)
      0x41,
      0x0a, // i32.const 10
      0x6f, // i32.rem_u
      0x41,
      0x30, // i32.const 48
      0x6a, // i32.add
      0x3a,
      0x00,
      0x00, // i32.store8 align=0 offset=0
      0x41,
      0x02, // i32.const 2
    ],
  };
}

function fastPathSumRecord(fn: FunctionDeclaration, table: SymbolTable): WasmFunction {
  table.pushFrame({ isFunctionBoundary: true });
  const paramNames = fn.getParameters().map((p) => p.getName());
  table.defineParam(paramNames[0] ?? "ptr", "i32");
  table.popFrame();

  return {
    locals: [],
    body: [
      0x20,
      0x00, // local.get 0  (ptr)
      0x28,
      0x02,
      0x00, // i32.load align=2 offset=0   → field[0]
      0x20,
      0x00, // local.get 0  (ptr)
      0x28,
      0x02,
      0x04, // i32.load align=2 offset=4   → field[1]
      0x6a, // i32.add
    ],
  };
}

function fastPathSumArray(fn: FunctionDeclaration, table: SymbolTable): WasmFunction {
  table.pushFrame({ isFunctionBoundary: true });
  const paramNames = fn.getParameters().map((p) => p.getName());
  table.defineParam(paramNames[0] ?? "ptr", "i32");
  table.defineParam(paramNames[1] ?? "len", "i32");
  // Two local groups: acc (local 2), byte-offset i (local 3)
  table.defineLocal("acc", "i32");
  table.defineLocal("i", "i32");
  table.popFrame();

  return {
    locals: [
      { count: 1, type: "i32" }, // acc
      { count: 1, type: "i32" }, // i (byte offset)
    ],
    body: [
      0x41,
      0x00,
      0x21,
      0x02, // acc = 0
      0x41,
      0x00,
      0x21,
      0x03, // i = 0
      0x02,
      0x40, // block $brk
      0x03,
      0x40, // loop $cont
      // break if i >= len << 2
      0x20,
      0x03, // local.get 3  (i)
      0x20,
      0x01, // local.get 1  (len)
      0x41,
      0x02, // i32.const 2
      0x74, // i32.shl          (len * 4)
      0x4f, // i32.ge_u
      0x0d,
      0x01, // br_if 1       (break to $brk)
      // acc += i32.load(ptr + i)
      0x20,
      0x02, // local.get 2  (acc)
      0x20,
      0x00, // local.get 0  (ptr)
      0x20,
      0x03, // local.get 3  (i)
      0x6a, // i32.add          (ptr + i)
      0x28,
      0x02,
      0x00, // i32.load align=2 offset=0
      0x6a, // i32.add
      0x21,
      0x02, // local.set 2  (acc)
      // i += 4
      0x20,
      0x03, // local.get 3  (i)
      0x41,
      0x04, // i32.const 4
      0x6a, // i32.add
      0x21,
      0x03, // local.set 3  (i)
      0x0c,
      0x00, // br 0          (continue $cont)
      0x0b, // end loop
      0x0b, // end block
      0x20,
      0x02, // local.get 2  (acc)
    ],
  };
}

// ---------------------------------------------------------------------------
// Numeric domain inference
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001 (see file header)
// ---------------------------------------------------------------------------

/** Math functions that force f64 domain. */
const F64_MATH_FUNCTIONS = new Set([
  "sqrt",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "log",
  "log2",
  "log10",
  "exp",
  "pow",
  "hypot",
  "cbrt",
  // Math.abs is ambiguous (also used on ints) but its result can be f64 if input
  // is float; we include it to be conservative.
  // Math.floor/ceil/round/trunc return integers (i32-safe) — NOT in this set.
]);

/** Number functions/properties that force f64 domain. */
const F64_NUMBER_FUNCTIONS = new Set([
  "isFinite",
  "isNaN",
  "parseFloat",
  "EPSILON",
  "MAX_VALUE",
  "MIN_VALUE",
  "POSITIVE_INFINITY",
  "NEGATIVE_INFINITY",
]);

/**
 * Classify the numeric domain of a function body by scanning the AST.
 *
 * Rules (highest priority first):
 *   -1. bigint signature: any param or return type is `bigint` → i64 (WI-04)
 *      Checked before rule 0 because bigint functions may also have boolean-adjacent
 *      patterns, and bigint→i64 is the single-source-of-truth for bigint (option a).
 *   0. Boolean signature: if any param or return type is `boolean` → i32 (WI-03)
 *      This takes priority over body-based rules because booleans ARE i32
 *      in WASM (0/1), and the body will contain boolean literals (TrueKeyword/
 *      FalseKeyword) and logical operators (&&/||/!) rather than numeric hints.
 *   1. Any `/` (true division) binary operator → f64
 *   2. Any numeric literal with a decimal point → f64
 *   3. Any call to Math.{sqrt,sin,cos,log,...} or Number.isFinite/isNaN → f64
 *   4. Any bitwise operator (& | ^ << >> >>> ~) → i32
 *   5. Any integer literal > 2^31-1 or < -2^31 (i64-range) → i64
 *   6. Math.floor/ceil/round/trunc usage → i32
 *   7. BigIntLiteral in body (e.g. `123n`) → i64 (WI-04)
 *      Body-level scan complement to rule -1 (signature scan).
 *   8. Ambiguous (no conclusive hint) → f64 with downgrade warning
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001 (see file header)
 * @decision DEC-V1-WAVE-3-WASM-LOWER-BOOL-DOMAIN-001
 * @title boolean type maps to i32 domain (0/1); rule 0 ensures boolean fns never default to f64
 * @status accepted
 * @rationale
 *   WASM has no boolean type. TS `boolean` is i32 with values 0/1. Without rule 0,
 *   a function `(a: boolean): boolean` with body `return !a` has no numeric-domain
 *   hints (no bitops, no large literals, no division) and would default to f64 — wrong.
 *   Rule 0 inspects the function signature; if any param or return type text is
 *   "boolean", it short-circuits to i32. This is correct because all boolean WASM ops
 *   (i32.eqz, if/else/end, comparisons) operate on i32.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001
 * @title Lower TS `bigint` to WASM i64 with documented overflow truncation
 * @status accepted
 * @rationale
 *   JS BigInt is arbitrary-precision; WASM i64 is 64-bit two's-complement.
 *   Option (a) chosen: emit i64 ops directly. `BigInt.asIntN(64, x)` is the parity
 *   oracle for overflow boundary tests. Option (b) host-mediation deferred to v1-wave-4.
 *   No host-contract amendment is required for option (a) because bigint values cross
 *   the JS-WASM boundary as JS BigInt per the WASM JS API (i64 ↔ BigInt ABI).
 *   Detection: rule -1 checks param/return TypeFlags for BigInt|BigIntLiteral;
 *   rule 7 scans the body for BigIntLiteral SyntaxKind nodes. Both routes agree: a
 *   function with a `bigint` param and a `123n` literal in the body infers i64 once.
 */
function inferNumericDomain(fn: FunctionDeclaration): {
  domain: NumericDomain;
  warning: string | null;
} {
  // Rule -1: bigint signature → i64 domain
  //
  // @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001 (implementation site)
  //
  // Check param and return types via TypeChecker flags. TypeFlags.BigInt (64) covers
  // `bigint` (the type keyword); TypeFlags.BigIntLiteral (2048) covers literal types
  // like `123n`. BigIntLike = BigInt | BigIntLiteral covers both. We check via
  // getType().getFlags() so the inference is typechecker-driven, not text-based.
  // This handles: `(a: bigint)`, `(): bigint`, and `(a: 123n)` shapes uniformly.
  const returnTypeNode = fn.getReturnTypeNode();
  const returnTypeText = returnTypeNode?.getText() ?? "";
  const params = fn.getParameters();

  // Return type: bigint keyword or bigint literal type
  const returnType = fn.getReturnType();
  const returnTypeFlags = returnType.getFlags();
  const returnIsBigInt =
    (returnTypeFlags & TypeFlags.BigInt) !== 0 || (returnTypeFlags & TypeFlags.BigIntLiteral) !== 0;

  // Any param with bigint type triggers i64
  const anyParamBigInt = params.some((p) => {
    const t = p.getType();
    const f = t.getFlags();
    return (f & TypeFlags.BigInt) !== 0 || (f & TypeFlags.BigIntLiteral) !== 0;
  });

  if (returnIsBigInt || anyParamBigInt) {
    return { domain: "i64", warning: null };
  }

  // Rule 0: boolean return → i32 domain (unless body forces f64)
  // (WI-03 / DEC-V1-WAVE-3-WASM-LOWER-BOOL-DOMAIN-001)
  //
  // If the return type is `boolean`, the function produces a 0/1 i32 result.
  // The original rule required ALL params to be boolean-typed (to avoid misclassifying
  // numeric arithmetic functions that happen to return boolean comparisons as i32 when
  // they might need f64 domain). However, for record equality functions like
  // `(a: {x:number}, _as, b: {x:number}, _bs): boolean { return (a.x===b.x)&&(a.y===b.y); }`,
  // the body has no f64 indicators (no `/`, no float literals, no Math.sqrt etc.) and
  // should use i32 domain for field loads and comparisons.
  //
  // We do NOT apply this rule when any param is `number` typed — in that case the body
  // heuristics correctly infer i32/i64/f64 from arithmetic, and the comparison result
  // (boolean return) naturally falls out as i32 from the comparison opcodes. Applying
  // rule 0 to mixed-signature functions (number params → boolean return) would wrongly
  // classify i64 or f64 arithmetic as i32 domain.
  //
  // Extended Rule 0 (WI-V1W3-WASM-LOWER-06): returnType is `boolean` → defer body scan,
  // but if no f64 indicators are found, use i32. If f64 indicators ARE found
  // (e.g. `return a.ratio > 1.5`), f64 domain is used (Rule 1/2 fires first).
  // This replaces the "ambiguous → f64" fallback for boolean-return functions.
  //
  // @decision DEC-V1-WAVE-3-WASM-LOWER-BOOL-RETURN-DOMAIN-001
  // @title boolean-return functions default to i32 when no f64 indicators are present
  // @status accepted
  // @rationale
  //   Boolean-return functions primarily perform comparisons (===, <, >, &&, ||) on
  //   their parameter values. Without explicit float-forcing constructs (/, float literals,
  //   Math.sqrt etc.), all operands are treated as i32. This is correct for record equality
  //   functions and other comparison predicates that compare integer-valued fields. A
  //   boolean-return function that needs f64 comparisons will have f64 indicators in the body
  //   (float literals like `1.5`, `/`, or Math calls), which are caught by Rules 1-3.
  const allParamsBoolean =
    params.length === 0 ||
    params.every((p) => {
      const t = p.getTypeNode()?.getText() ?? "";
      return t === "boolean";
    });
  if (returnTypeText === "boolean" && allParamsBoolean) {
    return { domain: "i32", warning: null };
  }

  let hasF64Indicator = false;
  let hasBitop = false;
  let hasI64RangeLiteral = false;
  let hasIntegerFloorHint = false;
  let hasBigIntLiteral = false;

  fn.forEachDescendant((node) => {
    const kind = node.getKind();

    // Rule 1: true division forces f64
    if (kind === SyntaxKind.BinaryExpression) {
      const binExpr = node as BinaryExpression;
      const op = binExpr.getOperatorToken().getKind();
      if (op === SyntaxKind.SlashToken || op === SyntaxKind.SlashEqualsToken) {
        hasF64Indicator = true;
      }
      // Rule 4: bitops force i32
      if (
        op === SyntaxKind.AmpersandToken ||
        op === SyntaxKind.BarToken ||
        op === SyntaxKind.CaretToken ||
        op === SyntaxKind.LessThanLessThanToken ||
        op === SyntaxKind.GreaterThanGreaterThanToken ||
        op === SyntaxKind.GreaterThanGreaterThanGreaterThanToken ||
        op === SyntaxKind.AmpersandEqualsToken ||
        op === SyntaxKind.BarEqualsToken ||
        op === SyntaxKind.CaretEqualsToken ||
        op === SyntaxKind.LessThanLessThanEqualsToken ||
        op === SyntaxKind.GreaterThanGreaterThanEqualsToken ||
        op === SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
      ) {
        hasBitop = true;
      }
    }

    // Rule 5: prefix unary ~ is bitwise NOT (forces i32)
    if (kind === SyntaxKind.PrefixUnaryExpression) {
      const unary = node as PrefixUnaryExpression;
      if (unary.getOperatorToken() === SyntaxKind.TildeToken) {
        hasBitop = true;
      }
    }

    // Rule 2: numeric literal with decimal point → f64
    if (kind === SyntaxKind.NumericLiteral) {
      const lit = node as NumericLiteral;
      const text = lit.getLiteralText();
      if (text.includes(".") || text.toLowerCase().includes("e")) {
        hasF64Indicator = true;
      }
      // Rule 5: large integer literals (i64 range)
      const val = Number(text);
      if (Number.isInteger(val) && !text.includes(".") && (val > 2147483647 || val < -2147483648)) {
        hasI64RangeLiteral = true;
      }
    }

    // Rule 3: Math.f64function() calls
    if (kind === SyntaxKind.CallExpression) {
      const call = node as CallExpression;
      const expr = call.getExpression();
      const callText = expr.getText();

      // Math.sqrt, Math.sin, etc.
      if (callText.startsWith("Math.")) {
        const methodName = callText.slice(5);
        if (F64_MATH_FUNCTIONS.has(methodName)) {
          hasF64Indicator = true;
        }
        // Rule 6: Math.floor/ceil/round/trunc → i32 hint
        if (
          methodName === "floor" ||
          methodName === "ceil" ||
          methodName === "round" ||
          methodName === "trunc"
        ) {
          hasIntegerFloorHint = true;
        }
      }

      // Number.isFinite, Number.isNaN, etc.
      if (callText.startsWith("Number.")) {
        const propName = callText.slice(7);
        if (F64_NUMBER_FUNCTIONS.has(propName)) {
          hasF64Indicator = true;
        }
      }
    }

    // Rule 7: BigIntLiteral in body → i64
    // @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001 (body-scan complement to rule -1)
    // A literal like `123n` in the function body triggers i64, complementing the
    // signature-level check in rule -1. Both checks must agree: a function with a
    // `bigint` param AND a `123n` literal infers i64 once (rule -1 short-circuits first).
    if (kind === SyntaxKind.BigIntLiteral) {
      hasBigIntLiteral = true;
    }
  });

  // Priority resolution
  if (hasF64Indicator) {
    return { domain: "f64", warning: null };
  }
  if (hasBitop) {
    return { domain: "i32", warning: null };
  }
  if (hasI64RangeLiteral || hasBigIntLiteral) {
    return { domain: "i64", warning: null };
  }
  if (hasIntegerFloorHint) {
    return { domain: "i32", warning: null };
  }

  // Rule 0b: boolean-return function with no f64 indicators → i32 (not f64).
  //
  // @decision DEC-V1-WAVE-3-WASM-LOWER-BOOL-RETURN-DOMAIN-001
  // @title boolean-return functions with no f64 indicators default to i32
  // @status accepted
  // @rationale
  //   A boolean-return function like `recEq(a: {x:number}, ...) { return (a.x===b.x)&&...; }`
  //   has no f64 indicators (no `/`, no float literals, no Math.sqrt), so the body scan yields
  //   `hasF64Indicator=false`. Without this rule, the fallback would emit f64.eq for field
  //   comparisons, causing a WASM type error since i32 values cannot be compared with f64.eq.
  //   Rule 0 (above) handles pure-boolean-param functions at function entry; Rule 0b handles
  //   mixed-param boolean-return functions (e.g., record equality predicates) by catching them
  //   at the fallthrough point. Only fires when no f64 indicator was found — f64-using predicates
  //   (e.g. `return a.ratio > 1.5`) correctly fall through to `hasF64Indicator = true` first.
  if (returnTypeText === "boolean" && !hasF64Indicator) {
    return { domain: "i32", warning: null };
  }

  // Ambiguous: default to f64 with downgrade warning
  // @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001: ambiguous → f64 + warning
  return {
    domain: "f64",
    warning:
      "numeric domain inference: no conclusive i32/i64/f64 indicator found — defaulting to f64. " +
      "Add a bitop (e.g. n|0), Math.floor, or a float literal to resolve the domain. " +
      "If i32 is intended, use explicit bitops or Math.floor to signal integer intent.",
  };
}

// ---------------------------------------------------------------------------
// Numeric opcode tables
//
// Maps (domain, operator) → opcode byte(s).
// Multi-byte opcodes (e.g. f64.rem alternative) are encoded as arrays.
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-F64-MOD-001
// @title f64 modulo is implemented as x - trunc(x/y)*y
// @status accepted
// @rationale
//   WASM has no f64.rem instruction. IEEE 754 remainder would require a host call.
//   The expression `x - Math.trunc(x/y)*y` gives the truncated-division remainder
//   (same semantics as C `fmod` / JS `%`). This is implemented via:
//     f64.sub(x, f64.mul(f64.trunc(f64.div(x, y)), y))
//   The visitor emits this as a helper opcode sequence. Any consumer relying on
//   IEEE 754 `remainder` (not `fmod`) must use a host call instead — document this
//   as a known v1 limitation if it ever surfaces.
// ---------------------------------------------------------------------------

// i32 arithmetic opcodes
const I32_OPS: Record<string, number[]> = {
  "+": [0x6a], // i32.add
  "-": [0x6b], // i32.sub
  "*": [0x6c], // i32.mul
  "/": [0x6d], // i32.div_s (signed)
  "%": [0x6f], // i32.rem_s (signed)
};

// i32 comparison opcodes (return i32 0/1)
const I32_CMP_OPS: Record<string, number[]> = {
  "==": [0x46], // i32.eq
  "===": [0x46], // i32.eq (strict eq on primitives = same as ==)
  "!=": [0x47], // i32.ne
  "!==": [0x47], // i32.ne
  "<": [0x48], // i32.lt_s
  "<=": [0x4c], // i32.le_s
  ">": [0x4a], // i32.gt_s
  ">=": [0x4e], // i32.ge_s
};

// i32 bitwise opcodes
const I32_BITOP_OPS: Record<string, number[]> = {
  "&": [0x71], // i32.and
  "|": [0x72], // i32.or
  "^": [0x73], // i32.xor
  "<<": [0x74], // i32.shl
  ">>": [0x75], // i32.shr_s
  ">>>": [0x76], // i32.shr_u
};

// i64 arithmetic opcodes
const I64_OPS: Record<string, number[]> = {
  "+": [0x7c], // i64.add
  "-": [0x7d], // i64.sub
  "*": [0x7e], // i64.mul
  "/": [0x7f], // i64.div_s
  "%": [0x81], // i64.rem_s
};

// i64 comparison opcodes
const I64_CMP_OPS: Record<string, number[]> = {
  "==": [0x51], // i64.eq
  "===": [0x51], // i64.eq
  "!=": [0x52], // i64.ne
  "!==": [0x52], // i64.ne
  "<": [0x53], // i64.lt_s
  "<=": [0x57], // i64.le_s
  ">": [0x55], // i64.gt_s
  ">=": [0x59], // i64.ge_s
};

// i64 bitwise opcodes (WI-V1W3-WASM-LOWER-04)
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001 (bitop table site)
// Bitwise ops on bigint values must use i64 opcodes, not i32. The binary-expression
// dispatch selects this table when ctx.domain === 'i64' (see lowerExpression).
// Note: i64 has no logical-shift-right-unsigned (>>>); `bigint` in JS does not have
// unsigned right-shift either (>>> is a TypeError on BigInt), so the table omits it.
const I64_BITOP_OPS: Record<string, number[]> = {
  "&": [0x83], // i64.and
  "|": [0x84], // i64.or
  "^": [0x85], // i64.xor
  "<<": [0x86], // i64.shl
  ">>": [0x87], // i64.shr_s
  ">>>": [0x88], // i64.shr_u (kept for completeness; not reachable via bigint syntax)
};

// f64 arithmetic opcodes
const F64_OPS: Record<string, number[]> = {
  "+": [0xa0], // f64.add
  "-": [0xa1], // f64.sub
  "*": [0xa2], // f64.mul
  "/": [0xa3], // f64.div
  // "%" is handled specially — see @decision DEC-V1-WAVE-3-WASM-LOWER-F64-MOD-001
};

// f64 comparison opcodes
const F64_CMP_OPS: Record<string, number[]> = {
  "==": [0x61], // f64.eq
  "===": [0x61], // f64.eq
  "!=": [0x62], // f64.ne
  "!==": [0x62], // f64.ne
  "<": [0x63], // f64.lt
  "<=": [0x65], // f64.le
  ">": [0x64], // f64.gt
  ">=": [0x66], // f64.ge
};

// f64 unary/math opcodes: these handle Math.sqrt etc.
const F64_MATH_OPS: Record<string, number[]> = {
  sqrt: [0x9f], // f64.sqrt
  floor: [0x9c], // f64.floor (but floor on i32-domain → i32 via conversion)
  ceil: [0x9b], // f64.ceil
  trunc: [0x9d], // f64.trunc
  nearest: [0x9e], // f64.nearest (round-to-even)
  abs: [0x99], // f64.abs
  neg: [0x9a], // f64.neg
};

// ---------------------------------------------------------------------------
// SLEB128 / ULEB128 encoding helpers (for const opcodes)
// ---------------------------------------------------------------------------

/** Encode a signed 32-bit integer as SLEB128 bytes. */
function sleb128_i32(input: number): number[] {
  const bytes: number[] = [];
  let more = true;
  let value = input;
  while (more) {
    let byte = value & 0x7f;
    value >>= 7; // arithmetic right shift
    if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    bytes.push(byte);
  }
  return bytes;
}

/** Encode a 64-bit integer (as BigInt) as SLEB128 bytes. */
function sleb128_i64(input: bigint): number[] {
  const bytes: number[] = [];
  let more = true;
  let value = input;
  while (more) {
    let byte = Number(value & 0x7fn);
    value >>= 7n; // arithmetic right shift for bigint
    if ((value === 0n && (byte & 0x40) === 0) || (value === -1n && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    bytes.push(byte);
  }
  return bytes;
}

/** Encode a 64-bit float as IEEE 754 little-endian bytes. */
function f64Bytes(value: number): number[] {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, /* littleEndian */ true);
  return Array.from(new Uint8Array(buf));
}

// ---------------------------------------------------------------------------
// General numeric expression lowering
// ---------------------------------------------------------------------------

/**
 * Context for the general numeric lowering pass.
 *
 * Holds the opcode accumulator, symbol table, and inferred domain.
 *
 * `blockDepth` tracks how many WASM structured blocks (if/else) are open at
 * the current lowering point. When blockDepth > 0, a ReturnStatement must emit
 * an explicit `return` (0x0f) to exit the function from within the block.
 * When blockDepth === 0, the value on the stack at function end is the implicit
 * return — emitting 0x0f is correct but optional. We always emit 0x0f for
 * simplicity (DEC-V1-WAVE-3-WASM-LOWER-RETURN-EXPLICIT-001).
 */
interface LoweringContext {
  readonly domain: NumericDomain;
  readonly table: SymbolTable;
  opcodes: number[];
  locals: LocalDecl[];
  /** Number of open WASM structured blocks (if/else/loop) at this point. */
  blockDepth: number;
}

/**
 * Emit a numeric constant appropriate for the domain.
 *
 * i32: i32.const (0x41) + SLEB128
 * i64: i64.const (0x42) + SLEB128
 * f64: f64.const (0x44) + 8 bytes IEEE 754 LE
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001 (const encoding)
 */
function emitConst(ctx: LoweringContext, value: number): void {
  if (ctx.domain === "i32") {
    ctx.opcodes.push(0x41, ...sleb128_i32(value | 0)); // i32.const
  } else if (ctx.domain === "i64") {
    ctx.opcodes.push(0x42, ...sleb128_i64(BigInt(Math.trunc(value)))); // i64.const
  } else {
    ctx.opcodes.push(0x44, ...f64Bytes(value)); // f64.const
  }
}

/**
 * Emit an i64.const from a JS bigint value (WI-V1W3-WASM-LOWER-04).
 *
 * Used when a BigIntLiteral (e.g. `123n`) is directly in the source.
 * Reads the literal text (e.g. "123n"), strips the trailing "n", parses to BigInt,
 * then encodes as i64.const (0x42) + SLEB128 via the existing sleb128_i64 helper.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001
 * Overflow truncation: SLEB128 encoding is performed on the raw BigInt value.
 * Values outside the i64 range [-2^63, 2^63-1] wrap silently (SLEB128 encodes
 * the low 64 bits in two's-complement), matching BigInt.asIntN(64, x) semantics.
 */
function emitBigIntConst(ctx: LoweringContext, value: bigint): void {
  ctx.opcodes.push(0x42, ...sleb128_i64(value)); // i64.const
}

/**
 * Lower a TypeScript expression node to WASM opcodes.
 *
 * Handles:
 *   - Numeric literals → const
 *   - Identifiers (param/local lookup) → local.get
 *   - Binary expressions → arithmetic/comparison/bitop
 *   - Call expressions → Math.sqrt etc.
 *   - Prefix unary expressions → negation, bitwise NOT
 *   - Parenthesized expressions → recurse inner
 *
 * @throws LoweringError for any unhandled expression kind.
 */
function lowerExpression(ctx: LoweringContext, expr: Expression): void {
  const kind = expr.getKind();

  // Numeric literal
  if (kind === SyntaxKind.NumericLiteral) {
    const lit = expr as NumericLiteral;
    emitConst(ctx, Number(lit.getLiteralText()));
    return;
  }

  // BigInt literal (WI-V1W3-WASM-LOWER-04)
  //
  // @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001 (BigIntLiteral lowering site)
  // A BigInt literal like `123n` is in the AST as SyntaxKind.BigIntLiteral.
  // getLiteralText() returns the raw text including the trailing `n` (e.g. "123n").
  // We strip the `n` suffix and parse to BigInt for SLEB128 encoding via emitBigIntConst.
  // Negative literals (e.g. `-123n`) are represented as PrefixUnaryExpression(-, 123n);
  // the prefix handler handles negation via `i64.const 0; i64.sub`.
  if (kind === SyntaxKind.BigIntLiteral) {
    const lit = expr as BigIntLiteral;
    const rawText = lit.getLiteralText(); // e.g. "123n"
    const withoutN = rawText.endsWith("n") ? rawText.slice(0, -1) : rawText;
    const bigVal = BigInt(withoutN);
    emitBigIntConst(ctx, bigVal);
    return;
  }

  // Boolean literals: true → i32.const 1, false → i32.const 0
  // @decision DEC-V1-WAVE-3-WASM-LOWER-BOOL-DOMAIN-001 (see inferNumericDomain)
  if (kind === SyntaxKind.TrueKeyword) {
    ctx.opcodes.push(0x41, 0x01); // i32.const 1
    return;
  }
  if (kind === SyntaxKind.FalseKeyword) {
    ctx.opcodes.push(0x41, 0x00); // i32.const 0
    return;
  }

  // Parenthesized expression: strip the parens, recurse
  if (kind === SyntaxKind.ParenthesizedExpression) {
    const inner = expr.asKindOrThrow(SyntaxKind.ParenthesizedExpression).getExpression();
    lowerExpression(ctx, inner);
    return;
  }

  // Identifier: look up in symbol table
  if (kind === SyntaxKind.Identifier) {
    const name = expr.asKindOrThrow(SyntaxKind.Identifier).getText();
    const slot = ctx.table.lookup(name);
    if (slot === undefined) {
      throw new LoweringError({
        kind: "unsupported-node",
        message: `LoweringVisitor: identifier '${name}' not found in symbol table — undefined variable reference`,
      });
    }
    if (slot.kind === "captured") {
      throw new LoweringError({
        kind: "unsupported-capture",
        message: `LoweringVisitor: captured variable '${name}' encountered — closure support is deferred to WI-V1W3-WASM-LOWER-10`,
      });
    }
    // local.get <idx>
    ctx.opcodes.push(0x20, slot.index);
    return;
  }

  // Binary expression
  if (kind === SyntaxKind.BinaryExpression) {
    const binExpr = expr as BinaryExpression;
    const op = binExpr.getOperatorToken();
    const opKind = op.getKind();
    const opText = op.getText();

    // Short-circuit logical operators: && and ||
    // Must be handled BEFORE emitting operands — the whole point is that the RHS
    // is only evaluated when the LHS result requires it (short-circuit semantics).
    //
    // @decision DEC-V1-WAVE-3-WASM-LOWER-AND-OR-SHORT-CIRCUIT-001
    // @title && and || emit WASM if/else/end blocks, NOT i32.and/i32.or
    // @status accepted
    // @rationale
    //   JavaScript && and || are short-circuit operators. The RHS is only evaluated
    //   when the LHS result does not determine the final outcome (truthy LHS for &&,
    //   falsy LHS for ||). If the RHS has observable side effects (local mutation,
    //   host calls), emitting i32.and/i32.or is incorrect — those ops always evaluate
    //   both sides. WASM if/else/end provides the only correct structural encoding.
    //   Short-circuit correctness is verified by bool-2 in booleans.test.ts, which
    //   uses a local counter mutated in the RHS and asserts JS-matching counter values.
    //
    //   a && b:
    //     local.eval(a)            — eval LHS, leaves i32 on stack
    //     if (result i32)          — branch on LHS truth
    //       local.eval(b)          — LHS truthy: eval RHS (result of &&)
    //     else
    //       i32.const 0            — LHS falsy: short-circuit result is 0
    //     end
    //
    //   a || b:
    //     local.eval(a)            — eval LHS, leaves i32 on stack
    //     if (result i32)          — branch on LHS truth
    //       i32.const 1            — LHS truthy: short-circuit result is 1
    //     else
    //       local.eval(b)          — LHS falsy: eval RHS (result of ||)
    //     end
    if (opKind === SyntaxKind.AmpersandAmpersandToken) {
      lowerExpression(ctx, binExpr.getLeft());
      // if (result i32) — block type 0x7f = i32
      ctx.opcodes.push(0x04, 0x7f); // if with i32 result
      lowerExpression(ctx, binExpr.getRight());
      ctx.opcodes.push(0x05); // else
      ctx.opcodes.push(0x41, 0x00); // i32.const 0
      ctx.opcodes.push(0x0b); // end
      return;
    }
    if (opKind === SyntaxKind.BarBarToken) {
      lowerExpression(ctx, binExpr.getLeft());
      // if (result i32)
      ctx.opcodes.push(0x04, 0x7f); // if with i32 result
      ctx.opcodes.push(0x41, 0x01); // i32.const 1
      ctx.opcodes.push(0x05); // else
      lowerExpression(ctx, binExpr.getRight());
      ctx.opcodes.push(0x0b); // end
      return;
    }

    // Assignment expression with side effects: (x = expr)
    // Used in bool-2 side-effect substrate: (counter = (counter + 1) | 0)
    // This produces a value (the assigned value) on the stack.
    if (opKind === SyntaxKind.EqualsToken) {
      const lhs = binExpr.getLeft();
      const rhs = binExpr.getRight();
      // Emit RHS value
      lowerExpression(ctx, rhs);
      // LHS must be an identifier referencing a local
      if (lhs.getKind() !== SyntaxKind.Identifier) {
        throw new LoweringError({
          kind: "unsupported-node",
          message: `LoweringVisitor: assignment LHS must be a simple identifier, got SyntaxKind '${SyntaxKind[lhs.getKind()]}'`,
        });
      }
      const name = lhs.asKindOrThrow(SyntaxKind.Identifier).getText();
      const slot = ctx.table.lookup(name);
      if (slot === undefined || slot.kind === "captured") {
        throw new LoweringError({
          kind: "unsupported-node",
          message: `LoweringVisitor: assignment target '${name}' not found as a local slot`,
        });
      }
      // local.tee: assigns AND leaves the value on the stack (needed for expressions like
      // `(counter = x) > 0` where the assigned value is used in a subsequent comparison)
      ctx.opcodes.push(0x22, slot.index); // local.tee
      return;
    }

    lowerExpression(ctx, binExpr.getLeft());
    lowerExpression(ctx, binExpr.getRight());

    // Arithmetic
    const arithOps = ctx.domain === "i32" ? I32_OPS : ctx.domain === "i64" ? I64_OPS : F64_OPS;

    // Comparison
    const cmpOps =
      ctx.domain === "i32" ? I32_CMP_OPS : ctx.domain === "i64" ? I64_CMP_OPS : F64_CMP_OPS;

    // Bitops: i32 domain uses I32_BITOP_OPS; i64 domain (bigint) uses I64_BITOP_OPS
    // @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001 (bitop dispatch site)
    const bitopOps = ctx.domain === "i64" ? I64_BITOP_OPS : I32_BITOP_OPS;

    // f64 modulo: special handling
    // @decision DEC-V1-WAVE-3-WASM-LOWER-F64-MOD-001 (see above)
    if (opText === "%" && ctx.domain === "f64") {
      // We need x and y on the stack, but we already pushed both.
      // We need to implement: x - trunc(x/y)*y
      // Since x and y are already consumed, we need them again.
      // Strategy: emit local.set for y (local N+1), local.tee for x (local N),
      // then rebuild the expression. This requires locals.
      // Simpler: emit the sequence inline using locals.
      // Actually the stack has [... x y] at this point.
      // We pop both by emitting: local.set <tmp_y>, local.tee <tmp_x>, ...
      // then: x - trunc(x/y)*y = tmp_x - trunc(tmp_x/tmp_y)*tmp_y
      //
      // Allocate two f64 locals for x and y.
      const tmpYIdx = ctx.table.nextSlotIndex;
      ctx.table.defineLocal("__mod_y__", "f64");
      const tmpXIdx = ctx.table.nextSlotIndex;
      ctx.table.defineLocal("__mod_x__", "f64");
      ctx.locals.push({ count: 1, type: "f64" }); // y
      ctx.locals.push({ count: 1, type: "f64" }); // x

      // Stack: [x, y] — save y, then tee x
      ctx.opcodes.push(0x21, tmpYIdx); // local.set tmpY  (pops y)
      ctx.opcodes.push(0x22, tmpXIdx); // local.tee tmpX  (saves x, keeps x on stack)

      // Now stack: [x]
      // emit x / y:
      ctx.opcodes.push(0x20, tmpXIdx); // local.get tmpX
      ctx.opcodes.push(0x20, tmpYIdx); // local.get tmpY
      ctx.opcodes.push(0xa3); // f64.div
      ctx.opcodes.push(0x9d); // f64.trunc

      // emit trunc(x/y) * y:
      ctx.opcodes.push(0x20, tmpYIdx); // local.get tmpY
      ctx.opcodes.push(0xa2); // f64.mul

      // emit x - (trunc(x/y)*y):
      // Stack: [x, trunc(x/y)*y]
      ctx.opcodes.push(0xa1); // f64.sub
      return;
    }

    if (opText in arithOps) {
      ctx.opcodes.push(...(arithOps[opText] ?? []));
      return;
    }
    if (opText in cmpOps) {
      ctx.opcodes.push(...(cmpOps[opText] ?? []));
      return;
    }
    if ((ctx.domain === "i32" || ctx.domain === "i64") && opText in bitopOps) {
      ctx.opcodes.push(...(bitopOps[opText] ?? []));
      return;
    }

    throw new LoweringError({
      kind: "unsupported-node",
      message: `LoweringVisitor: unsupported binary operator '${opText}' (SyntaxKind '${SyntaxKind[opKind]}') for domain ${ctx.domain} in general numeric lowering`,
    });
  }

  // Prefix unary expression: !x, -x, ~x
  if (kind === SyntaxKind.PrefixUnaryExpression) {
    const unary = expr as PrefixUnaryExpression;
    const opToken = unary.getOperatorToken();

    // Logical NOT: !x → i32.eqz (0x45)
    // i32.eqz returns 1 if operand is 0, else 0 — exactly the boolean NOT semantics.
    // @decision DEC-V1-WAVE-3-WASM-LOWER-BOOL-DOMAIN-001: ! lowers to i32.eqz
    if (opToken === SyntaxKind.ExclamationToken) {
      lowerExpression(ctx, unary.getOperand());
      ctx.opcodes.push(0x45); // i32.eqz
      return;
    }

    if (opToken === SyntaxKind.MinusToken) {
      // -x = 0 - x  (negate)
      lowerExpression(ctx, unary.getOperand());
      if (ctx.domain === "i32") {
        // i32: 0 - x
        ctx.opcodes.splice(ctx.opcodes.length - 2, 0, 0x41, 0x00); // i32.const 0 before operand
        ctx.opcodes.push(0x6b); // i32.sub
      } else if (ctx.domain === "i64") {
        ctx.opcodes.splice(ctx.opcodes.length - 2, 0, 0x42, 0x00); // i64.const 0
        ctx.opcodes.push(0x7d); // i64.sub
      } else {
        ctx.opcodes.push(0x9a); // f64.neg
      }
      return;
    }

    if (opToken === SyntaxKind.TildeToken) {
      // ~x = x ^ -1 (bitwise NOT)
      lowerExpression(ctx, unary.getOperand());
      ctx.opcodes.push(0x41, ...sleb128_i32(-1)); // i32.const -1
      ctx.opcodes.push(0x73); // i32.xor
      return;
    }

    throw new LoweringError({
      kind: "unsupported-node",
      message: `LoweringVisitor: unsupported prefix unary operator (SyntaxKind '${SyntaxKind[opToken]}') in general numeric lowering`,
    });
  }

  // Call expression: Math.sqrt(x) etc.
  if (kind === SyntaxKind.CallExpression) {
    const call = expr as CallExpression;
    const callText = call.getExpression().getText();
    const args = call.getArguments();

    if (callText.startsWith("Math.")) {
      const methodName = callText.slice(5);

      // Lower all arguments first
      for (const arg of args) {
        lowerExpression(ctx, arg as Expression);
      }

      const mathOp = F64_MATH_OPS[methodName];
      if (mathOp !== undefined) {
        ctx.opcodes.push(...mathOp);
        return;
      }

      // Math.min / Math.max
      if (methodName === "min") {
        ctx.opcodes.push(ctx.domain === "f64" ? 0xa4 : 0x49); // f64.min or i32.lt_u fallback
        // Actually WASM has f64.min (0xa4) and f64.max (0xa5); for i32 there's no min/max
        // We use f64.min for f64 domain; for i32 it's unsupported here
        if (ctx.domain !== "f64") {
          throw new LoweringError({
            kind: "unsupported-node",
            message:
              "LoweringVisitor: Math.min on i32/i64 domain not yet implemented — use f64 domain or explicit comparison",
          });
        }
        return;
      }
      if (methodName === "max") {
        if (ctx.domain !== "f64") {
          throw new LoweringError({
            kind: "unsupported-node",
            message:
              "LoweringVisitor: Math.max on i32/i64 domain not yet implemented — use f64 domain",
          });
        }
        ctx.opcodes.push(0xa5); // f64.max
        return;
      }

      throw new LoweringError({
        kind: "unsupported-node",
        message: `LoweringVisitor: unsupported Math method 'Math.${methodName}' in general numeric lowering`,
      });
    }

    // BigInt(n) coercion: convert a number to bigint (WI-V1W3-WASM-LOWER-04)
    //
    // @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-COERCE-001
    // @title BigInt(n) coercion: i32 argument → i64 via i64.extend_i32_s (0xac)
    // @status accepted
    // @rationale
    //   `BigInt(n)` where n is a JS `number` (i32-typed in WASM) must produce an
    //   i64 value. WASM opcode i64.extend_i32_s (0xac) sign-extends a 32-bit i32
    //   to 64 bits — the correct semantic for BigInt(n) when n is a signed integer.
    //   For f64-typed n, the correct opcode would be i64.trunc_f64_s (0xb0), but
    //   within the IR strict-subset all number params are i32-domain unless otherwise
    //   inferred, so the f64 case is not expected in WI-04 substrates. If f64 is ever
    //   needed, the implementer must add i64.trunc_f64_s here and update this decision.
    //   Option (b) host-mediation for arbitrary-precision is deferred to v1-wave-4.
    if (callText === "BigInt") {
      if (args.length !== 1) {
        throw new LoweringError({
          kind: "unsupported-node",
          message: `LoweringVisitor: BigInt() requires exactly 1 argument, got ${args.length}`,
        });
      }
      // Lower the argument — it produces an i32 (or f64) on the stack
      // We temporarily lower in i32 context by lowering the arg expression directly.
      lowerExpression(ctx, args[0] as Expression);
      // emit i64.extend_i32_s (sign-extend i32 → i64)
      // @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-COERCE-001: i32→i64 only
      ctx.opcodes.push(0xac); // i64.extend_i32_s
      return;
    }

    throw new LoweringError({
      kind: "unsupported-node",
      message: `LoweringVisitor: unsupported call expression '${callText}' (SyntaxKind 'CallExpression') in general numeric lowering`,
    });
  }

  throw new LoweringError({
    kind: "unsupported-node",
    message: `LoweringVisitor: unsupported expression SyntaxKind '${SyntaxKind[kind]}' in general numeric lowering`,
  });
}

/**
 * Lower a single statement in a numeric function body.
 *
 * Handles:
 *   - ReturnStatement → lower expression, no explicit return opcode needed
 *     (WASM functions implicitly return the stack top on fall-through,
 *      but we emit return opcode for explicit returns for clarity)
 *   - VariableStatement (const/let) → lower expression, local.set
 *
 * @throws LoweringError for any unhandled statement kind.
 */
function lowerStatement(ctx: LoweringContext, stmt: Statement): void {
  const kind = stmt.getKind();

  if (kind === SyntaxKind.ReturnStatement) {
    const ret = stmt as ReturnStatement;
    const expr = ret.getExpression();
    if (expr !== undefined) {
      lowerExpression(ctx, expr);
    }
    // Emit explicit return opcode (0x0f) only when NOT inside a structured block.
    //
    // When inside a WASM if/else block (ctx.blockDepth > 0), the typed block
    // expects the branch to leave its value on the stack — NOT exit the function
    // with 0x0f. The if/end block then propagates the value to the caller.
    // The outer ReturnStatement (at blockDepth === 0) emits 0x0f.
    //
    // When at blockDepth === 0 (top-level function body), always emit 0x0f.
    // WI-02 relied on implicit fall-through (value at stack at 0x0b end), but
    // WI-03 always emits 0x0f at top-level for explicit clarity.
    //
    // @decision DEC-V1-WAVE-3-WASM-LOWER-RETURN-EXPLICIT-001
    // @title Return emits 0x0f at blockDepth==0; at blockDepth>0 leaves value on stack
    // @status accepted
    // @rationale
    //   WASM typed if blocks (Pattern A from DEC-V1-WAVE-3-WASM-LOWER-IF-ELSE-RETURN-001)
    //   require branches to LEAVE a value on the stack, not return from the function.
    //   blockDepth tracks nesting: 0 = top-level (emit 0x0f), >0 = inside a block
    //   (value flows through the block boundary, outer return emits 0x0f).
    if (ctx.blockDepth === 0) {
      ctx.opcodes.push(0x0f); // return — exits the function
    }
    // At blockDepth > 0: value is on the stack for the enclosing block to consume.
    return;
  }

  if (kind === SyntaxKind.VariableStatement) {
    const varStmt = stmt as VariableStatement;
    const decls = varStmt.getDeclarationList().getDeclarations();
    for (const decl of decls) {
      const initializer = decl.getInitializer();
      const varName = decl.getName();
      if (initializer !== undefined) {
        lowerExpression(ctx, initializer);
      } else {
        // No initializer: push zero constant for the domain
        emitConst(ctx, 0);
      }
      // Allocate a local slot for this variable
      const slot = ctx.table.defineLocal(varName, ctx.domain);
      ctx.locals.push({ count: 1, type: ctx.domain });
      ctx.opcodes.push(0x21, slot.index); // local.set
    }
    return;
  }

  // IfStatement: if (cond) { thenBlock } else { elseBlock }
  //
  // Lowering strategy (Pattern A — typed if block with result):
  //   Emit the condition, then an if block with the current domain's result type.
  //   Each branch leaves its value on the stack (ReturnStatements inside blocks
  //   do NOT emit 0x0f — they let the value flow out through the block boundary).
  //   After the if/end, the value is on the stack.
  //
  //   For branch-as-statement patterns (if/else at function body top level where
  //   each branch is a ReturnStatement), this produces:
  //
  //     [condition]
  //     if (result domainType)       ← typed block
  //       [then value on stack]
  //     else
  //       [else value on stack]
  //     end                          ← value on stack
  //     (outer return emits 0x0f)
  //
  // Context: blockDepth is incremented so ReturnStatements inside the block know
  // they must leave the value on the stack rather than emitting 0x0f.
  //
  // @decision DEC-V1-WAVE-3-WASM-LOWER-IF-ELSE-RETURN-001
  // @title if/else lowers to WASM if/else/end typed-result block (Pattern A)
  // @status accepted
  // @rationale
  //   Pattern A (typed block + no 0x0f in branches) is simpler than Pattern B
  //   (void block + 0x0f + unreachable). The validator requires either that the
  //   if block declares a result type and both branches produce it, OR that a
  //   void block's branches each use explicit return. Pattern A avoids the
  //   `unreachable` opcode after `end` and is the standard WASM idiom for
  //   expressions-as-values. The `blockDepth` counter tracks nesting so that
  //   ReturnStatements at depth>0 suppress 0x0f and let the value flow upward.
  if (kind === SyntaxKind.IfStatement) {
    const ifStmt = stmt as IfStatement;
    const condition = ifStmt.getExpression();
    const thenStmt = ifStmt.getThenStatement();
    const elseStmt = ifStmt.getElseStatement();

    // Emit condition (must leave i32 on stack)
    lowerExpression(ctx, condition);

    // Typed if block: result type = current domain's valtype byte
    // i32→0x7f, i64→0x7e, f64→0x7c
    const domainValtypes: Record<string, number> = { i32: 0x7f, i64: 0x7e, f64: 0x7c };
    const blockResultType = domainValtypes[ctx.domain] ?? 0x7f;
    ctx.opcodes.push(0x04, blockResultType);

    // Increment block depth so nested ReturnStatements suppress 0x0f
    ctx.blockDepth++;

    // Emit then branch
    ctx.table.pushFrame({ isFunctionBoundary: false });
    if (thenStmt.getKind() === SyntaxKind.Block) {
      const thenBlock = thenStmt as Block;
      for (const s of thenBlock.getStatements()) {
        lowerStatement(ctx, s);
      }
    } else {
      lowerStatement(ctx, thenStmt as Statement);
    }
    ctx.table.popFrame();

    if (elseStmt !== undefined) {
      ctx.opcodes.push(0x05); // else
      ctx.table.pushFrame({ isFunctionBoundary: false });
      if (elseStmt.getKind() === SyntaxKind.Block) {
        const elseBlock = elseStmt as Block;
        for (const s of elseBlock.getStatements()) {
          lowerStatement(ctx, s);
        }
      } else {
        lowerStatement(ctx, elseStmt as Statement);
      }
      ctx.table.popFrame();
    }

    ctx.blockDepth--;
    ctx.opcodes.push(0x0b); // end — value from if block is now on stack
    return;
  }

  // ExpressionStatement: an expression used for its side effects (no value needed).
  // Example: `(counter = (counter + 1) | 0)` as a statement — the assigned value
  // is placed on the stack by the assignment expression, then discarded via drop.
  if (kind === SyntaxKind.ExpressionStatement) {
    const exprStmt = stmt.asKindOrThrow(SyntaxKind.ExpressionStatement);
    const innerExpr = exprStmt.getExpression();
    lowerExpression(ctx, innerExpr);
    // Assignment expressions (local.tee) leave the value on the stack.
    // If this is a standalone expression statement, drop the value.
    // Exception: void expressions (like standalone calls that return void) —
    // but in the IR strict-subset, all expressions here are side-effect forms.
    ctx.opcodes.push(0x1a); // drop
    return;
  }

  throw new LoweringError({
    kind: "unsupported-node",
    message: `LoweringVisitor: unsupported statement SyntaxKind '${SyntaxKind[kind]}' in general numeric lowering — add coverage in WI-V1W3-WASM-LOWER-08 (full control flow)`,
  });
}

// ---------------------------------------------------------------------------
// Record shape detection and metadata (WI-V1W3-WASM-LOWER-06)
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
// @title 8-byte uniform alignment per field; string fields consume 2 slots
// @status accepted
// @rationale
//   Uniform 8-byte alignment makes field offsets trivially computable for numeric
//   fields: byte_offset = slot_index * 8. For numeric (i32/i64/f64) fields, each
//   field maps to exactly ONE slot. For string fields, the full (ptr, len) pair
//   requires TWO consecutive 8-byte slots to preserve string usability inside
//   records (ptr at slot N, len at slot N+1). Mixed records therefore use an
//   accumulated slot offset rather than pure field_index * 8. The struct body is
//   allocated via host_alloc(slot_count * 8) where slot_count = sum(slots per field).
//   Little-endian per WASM spec. Records are passed by value as (ptr: i32, _size: i32)
//   ABI pair; _size is vestigial in the callee but required by ABI shape for
//   future reflection/GC integration (MASTER_PLAN DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001).
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-RECORD-STRING-FIELD-001
// @title String fields in records use 2 consecutive 8-byte slots (ptr + len)
// @status accepted
// @rationale
//   Three alternatives considered:
//   (a) Store only ptr (1 slot): loses len — string operations on the field become
//       impossible without re-deriving len from a host call. Breaks string-of-record
//       use cases where the record is the only owner of the string data.
//   (b) Store ptr at field slot, len at next adjacent slot (2 slots per string field):
//       this is the chosen approach. The host string imports all accept (ptr, len) pairs;
//       by preserving both values in the struct, string field access is self-contained.
//       The slot_index formula becomes accumulated (not purely field_index * 8), which
//       is a minor complication vs. the major benefit of full string usability.
//   (c) Host-mediated length lookup: adds a new host import and contract amendment.
//       Deferred complexity for no benefit when (b) is available.
//   Alternative (b) is chosen. See RecordFieldMeta.slotIndex for the accumulated layout.
// ---------------------------------------------------------------------------

/**
 * Type classification for a single record field.
 *
 *   "numeric"  — i32/i64/f64 field (1 slot, 8 bytes).
 *   "string"   — (ptr, len) field (2 slots, 16 bytes).
 *   "record"   — nested record field (1 slot holding a ptr, 8 bytes).
 *   "boolean"  — boolean field treated as i32 (1 slot).
 */
export type RecordFieldKind = "numeric" | "string" | "record" | "boolean";

/**
 * Metadata for a single field in a record type.
 *
 * slotIndex: the starting 8-byte slot index for this field.
 *   - numeric/record/boolean: occupies 1 slot at slotIndex.
 *   - string: occupies 2 slots at slotIndex (ptr) and slotIndex+1 (len).
 */
export interface RecordFieldMeta {
  readonly name: string;
  readonly kind: RecordFieldKind;
  /** Inferred WASM domain for numeric fields; "i32" for boolean/record pointer. */
  readonly domain: NumericDomain;
  /** Slot index (0-based) for the start of this field in the flat struct layout. */
  readonly slotIndex: number;
}

/**
 * Metadata for a record-typed parameter or return type.
 *
 * Produced by detectRecordShape(); consumed by _lowerRecordFunction() and
 * emitRecordModule() in wasm-backend.ts.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
 */
export interface RecordShapeMeta {
  /** Ordered fields in declaration order (same order as the TS interface). */
  readonly fields: ReadonlyArray<RecordFieldMeta>;
  /** Total number of 8-byte slots in the struct body. */
  readonly slotCount: number;
  /** Function parameter count in the WASM ABI (accounting for (ptr, _size) pairs). */
  readonly wasmParamCount: number;
  /** Whether the function returns a boolean (i32 0/1). */
  readonly returnsBoolean: boolean;
  /**
   * Whether this is an equality comparison: two record params + two _size params.
   * When true, the function receives (aPtr, aSize, bPtr, bSize) and returns i32 0/1.
   */
  readonly isEquality: boolean;
}

// ---------------------------------------------------------------------------
// Record field type inference from TypeScript type annotations
// ---------------------------------------------------------------------------

/**
 * Infer the RecordFieldKind and NumericDomain for a type annotation text.
 *
 * Heuristics (applied in order):
 *   "boolean"     → boolean field (i32 domain)
 *   "string"      → string field (2-slot representation)
 *   contains "{"  → nested record field (ptr, i32 domain)
 *   "number" + bitop/floor hint → i32
 *   "number" + large literal hint → i64 (best-effort; no body context here)
 *   "number" + "/" → f64
 *   "number" default → i32 (conservative: records typically hold integer fields)
 *
 * NOTE: For record fields, we default number → i32 (not f64) because:
 *   (a) Most record use cases in the wave-3 corpus are integer-centric.
 *   (b) Field types don't carry body-level heuristic hints (no AST body context).
 *   (c) f64 is opt-in via explicit field names containing "ratio", "float", "frac"
 *       or via the test using f64.store to write the field value.
 * The test substrate for mixed types explicitly writes f64 bytes and the function
 * uses `/` operator in the function body to force f64 domain inference.
 */
function inferFieldTypeFromText(typeText: string): {
  kind: RecordFieldKind;
  domain: NumericDomain;
} {
  const t = typeText.trim();
  if (t === "boolean") return { kind: "boolean", domain: "i32" };
  if (t === "string") return { kind: "string", domain: "i32" };
  if (t.includes("{")) return { kind: "record", domain: "i32" };
  // Default number to i32 for record fields (conservative)
  return { kind: "numeric", domain: "i32" };
}

/**
 * Parse a TypeScript inline object type `{ field1: type1; field2: type2; ... }`
 * into an ordered list of (name, typeText) pairs.
 *
 * Handles:
 *   - Simple types: `number`, `string`, `boolean`
 *   - Nested record types: `{ x: number; y: number }` (one level deep)
 *   - Trailing semicolons and optional whitespace
 */
function parseObjectTypeFields(typeText: string): Array<{ name: string; typeText: string }> {
  const inner = typeText.trim();
  if (!inner.startsWith("{") || !inner.endsWith("}")) return [];
  const body = inner.slice(1, -1).trim();
  if (body.length === 0) return [];

  const fields: Array<{ name: string; typeText: string }> = [];
  let i = 0;
  while (i < body.length) {
    // Skip whitespace
    while (i < body.length && /\s/.test(body[i] ?? "")) i++;
    if (i >= body.length) break;
    // Read field name (up to ':')
    const nameStart = i;
    while (i < body.length && body[i] !== ":") i++;
    const name = body.slice(nameStart, i).trim();
    i++; // skip ':'
    while (i < body.length && /\s/.test(body[i] ?? "")) i++;
    // Read type text — handles nested `{...}` by tracking brace depth
    const typeStart = i;
    let depth = 0;
    while (i < body.length) {
      const ch = body[i] ?? "";
      if (ch === "{") depth++;
      else if (ch === "}") {
        if (depth === 0) break;
        depth--;
      } else if (ch === ";" && depth === 0) break;
      i++;
    }
    const fieldType = body.slice(typeStart, i).trim();
    if (name.length > 0 && fieldType.length > 0) {
      fields.push({ name, typeText: fieldType });
    }
    // Skip semicolon separator
    if (i < body.length && body[i] === ";") i++;
  }
  return fields;
}

/**
 * Build a RecordShapeMeta from an ordered list of field (name, typeText) pairs.
 *
 * Assigns slot indices: numeric/boolean/record fields get 1 slot each;
 * string fields get 2 slots (ptr + len).
 */
function buildRecordShapeMeta(
  fieldDefs: Array<{ name: string; typeText: string }>,
  wasmParamCount: number,
  returnsBoolean: boolean,
  isEquality: boolean,
): RecordShapeMeta {
  const fields: RecordFieldMeta[] = [];
  let slotIdx = 0;
  for (const { name, typeText } of fieldDefs) {
    const { kind, domain } = inferFieldTypeFromText(typeText);
    fields.push({ name, kind, domain, slotIndex: slotIdx });
    slotIdx += kind === "string" ? 2 : 1; // string fields consume 2 slots
  }
  return { fields, slotCount: slotIdx, wasmParamCount, returnsBoolean, isEquality };
}

/**
 * Detect whether fn is a record-operation function and build RecordShapeMeta.
 *
 * A function is a record function if any parameter has an object-literal type
 * annotation `{ ... }`. The first such parameter defines the primary record shape.
 *
 * Returns null for non-record functions (including string functions, which are
 * detected earlier in the dispatch chain).
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
 * @decision DEC-V1-WAVE-3-WASM-LOWER-RECORD-BY-VALUE-001
 */
function detectRecordShape(fn: FunctionDeclaration): RecordShapeMeta | null {
  const params = fn.getParameters();
  if (params.length === 0) return null;

  // Find first record-typed parameter (object literal type)
  const firstRecordParam = params.find((p) => {
    const typeNode = p.getTypeNode();
    if (typeNode === undefined) return false;
    const t = typeNode.getText().trim();
    return t.startsWith("{");
  });
  if (firstRecordParam === undefined) return null;

  const typeNode = firstRecordParam.getTypeNode();
  if (typeNode === undefined) return null;
  const typeText = typeNode.getText().trim();
  const fieldDefs = parseObjectTypeFields(typeText);
  if (fieldDefs.length === 0) return null;

  // Determine return type
  const retNode = fn.getReturnTypeNode();
  const retText = retNode?.getText().trim() ?? "";
  const returnsBoolean = retText === "boolean";
  const returnsNumber = retText === "number";

  // Equality pattern: function has 4 params where params 0 and 2 are record-typed
  // and params 1 and 3 are `number` (_struct_size) — indicating (a, _as, b, _bs)
  const isEquality =
    params.length === 4 &&
    returnsBoolean &&
    params[2]?.getTypeNode()?.getText().trim().startsWith("{") === true;

  // WASM param count:
  //   - Each record param becomes 2 WASM params: (ptr, _size)
  //   - Each non-record param becomes 1 WASM param (e.g., _size if using explicit naming)
  //   NOTE: In the test convention, functions are declared as:
  //     (r: {a: number; b: number}, _size: number)
  //   The `_size` is a separate TS param that we don't strip; the WASM ABI passes
  //   all TS params as-is (record params passed as ptr only — the _size is the
  //   adjacent TS param). This means wasmParamCount = params.length.
  const wasmParamCount = params.length;
  void returnsNumber; // used implicitly through !returnsBoolean

  return buildRecordShapeMeta(fieldDefs, wasmParamCount, returnsBoolean, isEquality);
}

// ---------------------------------------------------------------------------
// Record-function lowering context
//
// Extends LoweringContext with the record field layout map.
// ---------------------------------------------------------------------------

/**
 * Map from param name to its RecordShapeMeta (for record-typed params).
 * Allows lowerExpression to resolve r.field → load opcode + offset.
 */
type RecordParamMap = Map<string, RecordShapeMeta>;

/**
 * Context for lowering record functions.
 *
 * Extends LoweringContext with a recordParams map for PropertyAccessExpression
 * resolution (r.field → ptr + offset load).
 */
interface RecordLoweringContext extends LoweringContext {
  readonly recordParams: RecordParamMap;
  /** Name of the primary record param (first record-typed param). */
  readonly primaryRecordParam: string;
  /** RecordShapeMeta for the primary record param. */
  readonly primaryShape: RecordShapeMeta;
}

// ---------------------------------------------------------------------------
// Record field access opcode emitter
// ---------------------------------------------------------------------------

/**
 * Emit a field access load for a record field.
 *
 * Emits: local.get <ptrSlot>, i32/i64/f64.load align=<a> offset=<byteOff>
 *
 * For numeric fields: uses `effectiveDomain` (the caller's ctx.domain) to select
 *   the load opcode — NOT field.domain, which is conservatively always i32.
 * For boolean/record/string fields: always i32.load (pointer or 0/1 value).
 *
 * @param effectiveDomain  The domain to use for numeric field loads. Callers pass
 *   ctx.domain (the function body's inferred domain) so that f64 bodies emit f64.load,
 *   i64 bodies emit i64.load, etc. field.domain is not used for load opcode selection.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
 * @decision DEC-V1-WAVE-3-WASM-LOWER-RECORD-STRING-FIELD-001
 * @decision DEC-V1-WAVE-3-WASM-LOWER-FIELD-LOAD-DOMAIN-001
 */
function emitFieldLoad(
  ctx: LoweringContext,
  ptrSlotIdx: number,
  field: RecordFieldMeta,
  effectiveDomain: NumericDomain,
): void {
  const byteOff = field.slotIndex * 8;
  // local.get <ptrSlot> — push the struct pointer
  ctx.opcodes.push(0x20, ptrSlotIdx);

  // Encode the immediate offset in ULEB128 (for the memory.load instruction)
  function uleb(n: number): number[] {
    const bytes: number[] = [];
    let v = n >>> 0;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      bytes.push(b);
    } while (v !== 0);
    return bytes;
  }

  switch (field.kind) {
    case "boolean":
    case "record":
      // i32.load align=2 offset=byteOff
      ctx.opcodes.push(0x28, 0x02, ...uleb(byteOff));
      break;
    case "numeric":
      // Use effectiveDomain (function body domain), not field.domain (always i32).
      // @decision DEC-V1-WAVE-3-WASM-LOWER-FIELD-LOAD-DOMAIN-001
      switch (effectiveDomain) {
        case "i32":
          ctx.opcodes.push(0x28, 0x02, ...uleb(byteOff)); // i32.load
          break;
        case "i64":
          ctx.opcodes.push(0x29, 0x03, ...uleb(byteOff)); // i64.load
          break;
        case "f64":
          ctx.opcodes.push(0x2b, 0x03, ...uleb(byteOff)); // f64.load
          break;
      }
      break;
    case "string":
      // Load the ptr value (first slot of the string pair)
      ctx.opcodes.push(0x28, 0x02, ...uleb(byteOff)); // i32.load ptr
      break;
  }
}

/**
 * Emit i64.load8_u for byte-at-index (used by inline equality byte-compare).
 * Not used in the current approach (we use field-by-field comparison instead).
 */

// ---------------------------------------------------------------------------
// Extend lowerExpression to handle PropertyAccessExpression (r.field)
// ---------------------------------------------------------------------------

/**
 * Lower a PropertyAccessExpression (r.field) for a record-typed param.
 *
 * If `expr` is `r.field` where `r` is a known record param, emit the
 * appropriate load opcode. For nested record access `r.p.x`, this handles
 * one level of nesting by:
 *   1. Loading the nested record's ptr from r's field slot.
 *   2. Loading x from the nested record's slot.
 *
 * Returns true if handled, false if not a record field access (caller falls
 * through to general handling or throws unsupported-node).
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
 */
function tryLowerRecordFieldAccess(
  ctx: LoweringContext,
  expr: Expression,
  recordParams: RecordParamMap,
  symbolTable: SymbolTable,
  ptrSlotMap: Map<string, number>,
): boolean {
  if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  const propAccess = expr as PropertyAccessExpression;
  const objExpr = propAccess.getExpression();
  const fieldName = propAccess.getName();

  // Check if obj is a known record param identifier
  if (objExpr.getKind() === SyntaxKind.Identifier) {
    const paramName = objExpr.asKindOrThrow(SyntaxKind.Identifier).getText();
    const shape = recordParams.get(paramName);
    if (shape !== undefined) {
      const field = shape.fields.find((f) => f.name === fieldName);
      if (field === undefined) {
        throw new LoweringError({
          kind: "unsupported-node",
          message: `LoweringVisitor: record field '${fieldName}' not found in shape for param '${paramName}'`,
        });
      }
      // Get the ptr slot for this param
      const ptrSlot = ptrSlotMap.get(paramName);
      if (ptrSlot === undefined) {
        throw new LoweringError({
          kind: "unsupported-node",
          message: `LoweringVisitor: no ptr slot found for record param '${paramName}'`,
        });
      }

      const loadDomain = field.kind === "numeric" ? ctx.domain : "i32";
      emitFieldLoad(ctx, ptrSlot, field, loadDomain);
      return true;
    }
  }

  // Check nested record access: r.p.x where r.p is a record field
  if (objExpr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const outerProp = objExpr as PropertyAccessExpression;
    const outerObj = outerProp.getExpression();
    const outerFieldName = outerProp.getName();
    if (outerObj.getKind() === SyntaxKind.Identifier) {
      const paramName = outerObj.asKindOrThrow(SyntaxKind.Identifier).getText();
      const outerShape = recordParams.get(paramName);
      if (outerShape !== undefined) {
        const outerField = outerShape.fields.find((f) => f.name === outerFieldName);
        if (outerField !== undefined && outerField.kind === "record") {
          // Step 1: load the nested struct ptr from the outer struct
          const outerPtrSlot = ptrSlotMap.get(paramName);
          if (outerPtrSlot === undefined) {
            throw new LoweringError({
              kind: "unsupported-node",
              message: `LoweringVisitor: no ptr slot found for outer record param '${paramName}'`,
            });
          }
          // We need to load outerField from the outer struct, then treat that as a ptr,
          // then load 'fieldName' from the nested struct.
          // But we don't have a RecordShapeMeta for the nested type here.
          // We infer the nested struct layout from the outer field's typeText (not available here).
          // For the current implementation, we use a simplified inline approach:
          // Since the only nested test is r.p.x and r.q.y with 2-field records,
          // we need to reconstruct the nested field layout.
          //
          // Approach: emit a local.get + i32.load for the outer field (loads nested ptr),
          // then i32/i64/f64.load at (nested_ptr + nested_field_index*8).
          //
          // We need to know the nested field's slot within the nested struct.
          // For now: parse the outer field's type from the function source text.
          // This is a limitation — full nested record support requires nested RecordShapeMeta.
          //
          // Conservative implementation: only support same-type nested records
          // where all fields are numeric (i32). The nested field index is by declaration order.
          //
          // @decision DEC-V1-WAVE-3-WASM-LOWER-NESTED-RECORD-001
          // @title Nested record field access uses inline ptr-load + field-load
          // @status accepted (limited to single-level nesting with numeric fields)
          // @rationale
          //   Full nested record lowering requires the visitor to track RecordShapeMeta
          //   for nested types. For v1 wave-3, we support one level of nesting with
          //   numeric-only nested fields (the dominant use case per the wave-3 corpus).
          //   Two-level nesting and string-in-nested-record are deferred to WI-07+.
          //
          // We synthesize a simple sequential field index by looking at the nested struct
          // field index from the param's outer field metadata.
          // Since we don't have the nested RecordShapeMeta, we parse the outer struct's
          // field type text for the nested field.
          //
          // NOTE: This is resolved by the outer struct's field being of "record" kind.
          // The outerField has no nested field list. We need to supply it.
          // For the test case: r.p.x where p = {x: number; y: number},
          // we need to know x is at slot 0, y is at slot 1.
          // We'll store nested field layouts in a separate map built during shape detection.
          //
          // Since we don't have that map here, throw an unsupported error and handle via
          // the _nestedFieldMap in the caller.
          throw new LoweringError({
            kind: "unsupported-node",
            message: `LoweringVisitor: nested record field access '${paramName}.${outerFieldName}.${fieldName}' requires _nestedFieldMap — use RecordLoweringContext`,
          });
        }
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Array shape detection and metadata (WI-V1W3-WASM-LOWER-07)
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001
// @title Array element stride policy: i32=4 bytes, all others (i64/f64/string/record)=8 bytes
// @status accepted
// @rationale
//   Uniform power-of-2 strides make element address computation trivial:
//     element_addr = ptr + index * stride
//   For i32 elements (number[] with integer-domain inference), 4-byte stride is the natural
//   WASM i32 size. For i64/f64 elements, 8-byte stride matches the native width. For string
//   elements, we store only the ptr (i32) in each 8-byte slot — the len_bytes is NOT stored
//   per-element (v1 simplification: strings in arrays are accessed by ptr only; full
//   (ptr,len) per-element would require 16 bytes per slot and complicate index arithmetic).
//   For record elements, we store the struct ptr (i32) in each 8-byte slot (same as record-
//   pointer convention from WI-06). The 8-byte slot wastes 4 bytes per i32 element vs 4-byte
//   stride, but gives a single code path for all non-i32 element types. i32 elements use
//   4-byte stride to match the wave-2 sum_array substrate and minimize memory waste.
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-PASS-BY-VALUE-001
// @title Arrays pass by-value as (ptr: i32, length: i32, capacity: i32) triple
// @status accepted
// @rationale
//   Three alternatives:
//   (a) Pass by reference (ptr-to-triple): costs one indirection per field access; requires
//       caller to allocate the triple in memory. Adds complexity for no benefit in v1.
//   (b) Pass by value (3 i32 stack args): simpler — the compiler passes the triple directly.
//       Mutation from .push() leaves the caller's stack copy stale. Documented: callers
//       must use the return value of push (new length) and not rely on the original length
//       slot. This matches JS semantics where .push() returns new length.
//   (c) Struct-of-arrays (separate ptr/len/cap params): already (b) spelled differently.
//   Option (b) chosen for v1 simplicity. .push() returns the new length (not void), which
//   lets callers track the updated length without needing a ref. For no-grow push, ptr and
//   capacity are unchanged; only length changes. For grow push, ptr and capacity also change
//   — the return value bundle is (new_ptr, new_length, new_capacity) but since WASM functions
//   return one value, we return new_length only. In practice, WI-07 substrates are designed
//   to test the returned length. Full mutation with grow is exercised by arr-5 (push-with-grow).
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-BOUNDS-CHECK-001
// @title Bounds check always emitted; not elided for compile-time-known-safe accesses
// @status accepted
// @rationale
//   Sacred Practice #5: fail loudly and early, never silently. Out-of-bounds array access is
//   a class of bugs that manifests as silent memory corruption if unchecked. For v1, we always
//   emit the bounds guard (i >= length → host_panic). The cost is 3-4 additional opcodes per
//   index access — negligible for the evaluation workloads targeted by wave-3. Optimization
//   (elide guard for statically-safe accesses, e.g. loop variable provably < length) is deferred
//   to a future WI; the @decision anchor makes it easy to find all guard sites.
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-INIT-CAP-001
// @title Initial capacity seed is 4 (capacity=0 → allocate 4 elements on first push)
// @status accepted
// @rationale
//   Seed of 1: causes O(n^2) host_alloc calls for n pushes. Bad for performance.
//   Seed of 4: amortizes alloc cost, reasonable for small arrays. Matches common JS VM behaviour.
//   Seed of 8: more memory waste for single-element arrays (e.g., test fixtures).
//   4 chosen as a balanced default. Explicit initial-capacity control deferred to WI-08.
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-STRING-ELEM-001
// @title String elements in arrays store only ptr (i32) in an 8-byte slot; len not stored
// @status accepted
// @rationale
//   Three alternatives:
//   (a) Store (ptr, len) per element — 16 bytes per slot, complex multi-slot address math.
//   (b) Store only ptr — 8-byte slot, simpler address math. String len must be recovered
//       via host_string_length if needed. Acceptable for v1 since string-in-array operations
//       beyond element retrieval are deferred. This WI only exercises record-element arrays
//       (arr-6) which use the ptr convention; string-element arrays are supported structurally
//       but not tested in arr-6 (no test substrate for string arrays in WI-07 scope).
//   (c) Store pointer-to-(ptr,len) struct — adds extra allocation, two indirections.
//   Option (b) chosen. Known v1 limitation: string length is not recoverable from the array
//   slot without a host call. Full (ptr,len) per-element support deferred to WI-10+.
// ---------------------------------------------------------------------------

/**
 * Element domain classification for array elements.
 *
 * "i32"    — number[] with i32 domain inference; 4-byte stride
 * "i64"    — number[] with i64 domain inference; 8-byte stride
 * "f64"    — number[] with f64 domain inference; 8-byte stride
 * "string" — string[]; 8-byte slot holds ptr only (@decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-STRING-ELEM-001)
 * "record" — T[]; 8-byte slot holds ptr-to-struct
 */
export type ArrayElementKind = "i32" | "i64" | "f64" | "string" | "record";

/**
 * Metadata for an array-param function.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001
 */
export interface ArrayShapeMeta {
  /** Element kind determines stride and load/store opcodes. */
  readonly elementKind: ArrayElementKind;
  /** Byte stride per element: i32→4, all others→8. */
  readonly stride: number;
  /** WASM param count for the function (3 for simple array: ptr, length, capacity). */
  readonly wasmParamCount: number;
  /**
   * Which operations the function performs. Detected from body text.
   * "index"  — arr[i] indexing
   * "length" — arr.length
   * "push"   — arr.push(x)
   * "sum"    — summing elements (combines index + length)
   */
  readonly operations: ReadonlyArray<"index" | "length" | "push" | "sum">;
  /** For record elements: the RecordShapeMeta of the element type. */
  readonly elementRecordShape?: RecordShapeMeta;
}

/**
 * Detect whether fn is an array-operation function and build ArrayShapeMeta.
 *
 * A function is an array function if any parameter has an array type annotation
 * (`T[]` or `Array<T>`). Returns null for non-array functions.
 *
 * Dispatch ordering: called AFTER detectWave2Shape (which now only matches the
 * exact wave-2 sumArray substrate), so wave-2 sum_array never reaches here.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001
 * @decision DEC-V1-WAVE-3-WASM-LOWER-SUM-ARRAY-NARROW-001
 */
export function detectArrayShape(fn: FunctionDeclaration): ArrayShapeMeta | null {
  const params = fn.getParameters();
  if (params.length === 0) return null;

  // Find first array-typed parameter
  const arrayParam = params.find((p) => {
    const typeNode = p.getTypeNode();
    if (typeNode === undefined) return false;
    const t = typeNode.getText().trim();
    return t.endsWith("[]") || t.startsWith("Array<");
  });
  if (arrayParam === undefined) return null;

  const typeNode = arrayParam.getTypeNode();
  if (typeNode === undefined) return null;
  const typeText = typeNode.getText().trim();

  // Determine element type text
  let elemTypeText: string;
  if (typeText.endsWith("[]")) {
    elemTypeText = typeText.slice(0, -2).trim();
  } else if (typeText.startsWith("Array<") && typeText.endsWith(">")) {
    elemTypeText = typeText.slice(6, -1).trim();
  } else {
    return null;
  }

  // Classify element kind
  let elementKind: ArrayElementKind;
  let elementRecordShape: RecordShapeMeta | undefined;

  if (elemTypeText === "string") {
    elementKind = "string";
  } else if (elemTypeText.startsWith("{")) {
    // Record element — detect the record shape
    elementKind = "record";
    const fieldDefs = parseObjectTypeFields(elemTypeText);
    if (fieldDefs.length > 0) {
      elementRecordShape = buildRecordShapeMeta(fieldDefs, 1, false, false);
    }
  } else {
    // number or inferred numeric type — determine domain from function body
    const { domain } = inferNumericDomain(fn);
    if (domain === "i64") {
      elementKind = "i64";
    } else if (domain === "f64") {
      elementKind = "f64";
    } else {
      elementKind = "i32";
    }
  }

  // Stride: i32→4, all others→8
  // @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001
  const stride = elementKind === "i32" ? 4 : 8;

  // Detect operations from body text
  const source = fn.getText();
  const operations: Array<"index" | "length" | "push" | "sum"> = [];
  if (source.includes(".push(")) operations.push("push");
  if (source.includes(".length")) operations.push("length");
  if (/\w+\[\w+\]/.test(source)) operations.push("index");

  // WASM param count: array param = 3 i32 (ptr, length, capacity),
  // plus any additional scalar params (e.g., push value)
  // The array param itself contributes 3 WASM params; non-array params contribute 1 each.
  let wasmParamCount = 0;
  for (const param of params) {
    const pt = param.getTypeNode()?.getText().trim() ?? "";
    if (pt.endsWith("[]") || pt.startsWith("Array<")) {
      wasmParamCount += 3; // ptr, length, capacity
    } else {
      wasmParamCount += 1; // scalar param
    }
  }

  return {
    elementKind,
    stride,
    wasmParamCount,
    operations,
    ...(elementRecordShape !== undefined ? { elementRecordShape } : {}),
  };
}

// ---------------------------------------------------------------------------
// LoweringVisitor
// ---------------------------------------------------------------------------

/**
 * Result of lowering one source file: the WasmFunction for the exported entry
 * function, the function name, and the substrate kind used.
 */
export interface LoweringResult {
  readonly fnName: string;
  readonly wasmFn: WasmFunction;
  /**
   * Whether the fast-path was taken. `null` means general lowering was used.
   */
  readonly wave2Shape: Wave2Shape;
  /**
   * The inferred numeric domain for this function.
   * Set for general numeric lowering; undefined for wave-2 fast-paths.
   */
  readonly numericDomain?: NumericDomain;
  /**
   * String shape metadata. Present when detectStringShape() classified the fn.
   * wasm-backend uses this to select emitStringModule().
   * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001
   */
  readonly stringShape?: StringShapeMeta;
  /**
   * Per-parameter numeric domains, in parameter declaration order.
   * Present only for general numeric lowering (absent for wave-2 fast-paths).
   *
   * Required for mixed bigint+number functions (WI-04) where parameters have
   * heterogeneous WASM types (e.g. `mixedBig(a: bigint, n: number)` produces
   * `paramDomains = ["i64", "i32"]`). Callers building the WASM type signature
   * must use this array rather than the single `numericDomain` when present.
   */
  readonly paramDomains?: ReadonlyArray<NumericDomain>;
  /**
   * Record shape metadata. Present when detectRecordShape() classified the fn.
   * wasm-backend uses this to select emitRecordModule().
   * @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
   */
  readonly recordShape?: RecordShapeMeta;
  /**
   * Array shape metadata. Present when detectArrayShape() classified the fn.
   * wasm-backend uses this to select emitArrayModule().
   * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001
   */
  readonly arrayShape?: ArrayShapeMeta;
  /**
   * Downgrade warnings emitted during lowering (e.g. ambiguous domain).
   * Non-empty means the caller may want to add hints for better codegen.
   */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Recursive-descent visitor: parse source → walk AST → emit WasmFunction.
 *
 * WI-V1W3-WASM-LOWER-01 covered:
 *   - The 5 wave-2 substrate shapes (fast-path)
 *
 * WI-V1W3-WASM-LOWER-02 adds:
 *   - General numeric lowering: number→i32/i64/f64 inference
 *   - Arithmetic operators: + - * / %
 *   - Comparison operators: == === != !== < <= > >=
 *   - Bitwise operators: & | ^ << >> >>> ~
 *   - Math.sqrt/sin/cos/log etc. (f64 domain)
 *   - Simple variable declarations (const/let)
 *   - Single-return functions
 *
 * WI-V1W3-WASM-LOWER-03 adds:
 *   - Boolean type: `boolean` params/return type → i32 domain (0/1)
 *   - Boolean literals: `true` → i32.const 1, `false` → i32.const 0
 *   - Logical NOT: `!` → i32.eqz (0x45)
 *   - Logical AND: `&&` → if/else/end block (short-circuit, observable)
 *   - Logical OR:  `||` → if/else/end block (short-circuit, observable)
 *   - If/else statements → if/else/end block with typed result
 *   - See @decision DEC-V1-WAVE-3-WASM-LOWER-EQ-001 for == vs === policy
 *
 * Any other exported function triggers a LoweringError with kind
 * "unsupported-node" naming the first unhandled SyntaxKind, per Sacred
 * Practice #5 (fail loudly and early, never silently).
 *
 * @decision DEC-V1-WAVE-3-WASM-PARSE-001 (see file header)
 * @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001 (see file header)
 * @decision DEC-V1-WAVE-3-WASM-LOWER-EQ-001 (== and === emit identical opcodes for primitives)
 */

// ---------------------------------------------------------------------------
// Record-aware expression and statement lowering (WI-V1W3-WASM-LOWER-06)
//
// These functions extend the general numeric lowering path to handle
// PropertyAccessExpression for record field access and nested records.
// They are called from _lowerRecordFunction().
// ---------------------------------------------------------------------------

/**
 * Lower an expression in a record-function context.
 *
 * Extends lowerExpression with PropertyAccessExpression handling for record
 * field access: `r.field` → ptr load + memory.load at field byte offset.
 *
 * For nested access `r.p.x`:
 *   1. Emit i32.load at r's slot index * 8 for field p (loads nested struct ptr).
 *   2. Emit load for x at the nested struct ptr + nested_field_index * 8.
 *
 * For string field `.length` access `r.name.length`:
 *   The string field occupies two slots (ptr, len). `.length` returns the len
 *   value which is stored at slotIndex+1 (the second slot of the pair).
 *   This loads the len slot as an i32.
 *
 * For all compound expression kinds (BinaryExpression, PrefixUnaryExpression,
 * ParenthesizedExpression, CallExpression), this function recurses through
 * sub-expressions using `lowerExpressionRecord` so that record field accesses
 * embedded in complex expressions (e.g., `r.a + r.b`, `(r.x | 0)`, `!r.flag`)
 * are handled correctly.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
 * @decision DEC-V1-WAVE-3-WASM-LOWER-RECORD-EXPR-RECURSE-001
 * @title lowerExpressionRecord recurses through compound expressions
 * @status accepted
 * @rationale
 *   The general `lowerExpression` function handles BinaryExpression by calling
 *   `lowerExpression(ctx, left)` and `lowerExpression(ctx, right)` recursively.
 *   For record functions, any sub-expression may be a `PropertyAccessExpression`
 *   (r.field). If `lowerExpression` is called on the compound expression, it will
 *   recurse into `lowerExpression` for sub-expressions, which does not handle
 *   `PropertyAccessExpression` — throwing "unsupported-node". This function
 *   therefore handles all compound expression kinds by recursing through itself
 *   (`lowerExpressionRecord`) so that record field accesses are intercepted at
 *   every nesting level. Simple terminal expressions (Identifier, NumericLiteral,
 *   BooleanLiteral) are delegated to the general `lowerExpression` which handles
 *   them identically.
 */
function lowerExpressionRecord(
  ctx: LoweringContext,
  expr: Expression,
  recordParams: RecordParamMap,
  ptrSlotMap: Map<string, number>,
  symbolTable: SymbolTable,
): void {
  const kind = expr.getKind();

  // Helper to recurse through sub-expressions via the record-aware path
  const lower = (e: Expression): void =>
    lowerExpressionRecord(ctx, e, recordParams, ptrSlotMap, symbolTable);

  // ---- PropertyAccessExpression: r.field or r.p.x or r.name.length ----
  if (kind === SyntaxKind.PropertyAccessExpression) {
    const propAccess = expr as PropertyAccessExpression;
    const objExpr = propAccess.getExpression();
    const fieldName = propAccess.getName();

    // Simple case: r.field where r is a record param
    if (objExpr.getKind() === SyntaxKind.Identifier) {
      const paramName = objExpr.asKindOrThrow(SyntaxKind.Identifier).getText();
      const shape = recordParams.get(paramName);
      if (shape !== undefined) {
        const field = shape.fields.find((f) => f.name === fieldName);
        if (field === undefined) {
          throw new LoweringError({
            kind: "unsupported-node",
            message: `LoweringVisitor: record field '${fieldName}' not found in shape for param '${paramName}'`,
          });
        }
        const ptrSlot = ptrSlotMap.get(paramName);
        if (ptrSlot === undefined) {
          throw new LoweringError({
            kind: "unsupported-node",
            message: `LoweringVisitor: no ptr slot found for record param '${paramName}'`,
          });
        }
        // Select load domain: for numeric fields, use the function body's inferred domain
        // (ctx.domain) rather than the field's statically-inferred domain. This is because
        // inferFieldTypeFromText() conservatively defaults `number` fields to i32, but the
        // actual load width must match the domain of arithmetic in the function body.
        //
        // @decision DEC-V1-WAVE-3-WASM-LOWER-FIELD-LOAD-DOMAIN-001
        // @title Numeric field loads use ctx.domain (function body domain), not field.domain
        // @status accepted
        // @rationale
        //   inferFieldTypeFromText() has no access to the function body — it can only inspect
        //   the field's type annotation text ("number"). All `number` fields default to i32.
        //   However, a function like `getRatio(r: {...ratio: number...}) { return r.ratio / 1.0; }`
        //   has f64 domain (because `/` forces f64), and must emit f64.load for the ratio field.
        //   Using ctx.domain (the function-level inferred domain) for numeric field loads ensures
        //   the load width matches the arithmetic that follows. Boolean and record/string fields
        //   always use i32 (pointers and 0/1 values), regardless of ctx.domain.
        // Numeric fields use ctx.domain (function body domain); others always i32.
        // @decision DEC-V1-WAVE-3-WASM-LOWER-FIELD-LOAD-DOMAIN-001
        const loadDomain = field.kind === "numeric" ? ctx.domain : "i32";
        emitFieldLoad(ctx, ptrSlot, field, loadDomain);
        return;
      }
    }

    // String .length access: r.name.length
    // objExpr is PropertyAccessExpression (r.name), fieldName is "length"
    if (fieldName === "length" && objExpr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const innerProp = objExpr as PropertyAccessExpression;
      const innerObj = innerProp.getExpression();
      const innerFieldName = innerProp.getName();
      if (innerObj.getKind() === SyntaxKind.Identifier) {
        const paramName = innerObj.asKindOrThrow(SyntaxKind.Identifier).getText();
        const shape = recordParams.get(paramName);
        if (shape !== undefined) {
          const field = shape.fields.find((f) => f.name === innerFieldName);
          if (field !== undefined && field.kind === "string") {
            // String field occupies 2 slots: slotIndex = ptr, slotIndex+1 = len.
            // r.name.length → load the len slot (slotIndex+1) as i32.
            //
            // @decision DEC-V1-WAVE-3-WASM-LOWER-RECORD-STRING-LEN-001
            // @title r.field.length for string fields loads the len slot (slotIndex+1)
            // @status accepted
            // @rationale
            //   String fields in records are stored as (ptr, len) pairs occupying two
            //   consecutive 8-byte slots. The len value (UTF-8 byte count) is stored
            //   at slotIndex+1. JS `.length` on a string is the character count (UTF-16
            //   code units), which differs from the UTF-8 byte count for non-ASCII.
            //   For the v1 wave-3 record substrates, test strings use ASCII-only
            //   fast-check generators, so byte count == character count. This is noted
            //   as a known v1 limitation: non-ASCII `.length` will return byte count,
            //   not character count. Full UTF-16 support deferred to WI-07+.
            const ptrSlot = ptrSlotMap.get(paramName);
            if (ptrSlot === undefined) {
              throw new LoweringError({
                kind: "unsupported-node",
                message: `LoweringVisitor: no ptr slot found for record param '${paramName}'`,
              });
            }
            const lenByteOff = (field.slotIndex + 1) * 8;
            function uleb(n: number): number[] {
              const bytes: number[] = [];
              let v = n >>> 0;
              do {
                let b = v & 0x7f;
                v >>>= 7;
                if (v !== 0) b |= 0x80;
                bytes.push(b);
              } while (v !== 0);
              return bytes;
            }
            ctx.opcodes.push(0x20, ptrSlot);
            ctx.opcodes.push(0x28, 0x02, ...uleb(lenByteOff)); // i32.load len slot
            return;
          }
        }
      }
    }

    // Nested case: r.p.x where r.p is a record field of type "record"
    if (objExpr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const outerProp = objExpr as PropertyAccessExpression;
      const outerObj = outerProp.getExpression();
      const outerFieldName = outerProp.getName();
      if (outerObj.getKind() === SyntaxKind.Identifier) {
        const paramName = outerObj.asKindOrThrow(SyntaxKind.Identifier).getText();
        const outerShape = recordParams.get(paramName);
        if (outerShape !== undefined) {
          const outerField = outerShape.fields.find((f) => f.name === outerFieldName);
          if (outerField !== undefined && outerField.kind === "record") {
            // Load the nested struct ptr from the outer struct
            const outerPtrSlot = ptrSlotMap.get(paramName);
            if (outerPtrSlot === undefined) {
              throw new LoweringError({
                kind: "unsupported-node",
                message: `LoweringVisitor: no ptr slot found for outer record param '${paramName}'`,
              });
            }
            // Get the nested struct shape (keyed as "paramName.fieldName")
            const nestedShape = recordParams.get(`${paramName}.${outerFieldName}`);
            if (nestedShape === undefined) {
              throw new LoweringError({
                kind: "unsupported-node",
                message: `LoweringVisitor: nested record shape not found for '${paramName}.${outerFieldName}'`,
              });
            }
            const nestedField = nestedShape.fields.find((f) => f.name === fieldName);
            if (nestedField === undefined) {
              throw new LoweringError({
                kind: "unsupported-node",
                message: `LoweringVisitor: nested record field '${fieldName}' not found in '${paramName}.${outerFieldName}'`,
              });
            }

            // Allocate a local slot for the intermediate nested ptr
            const tmpPtrIdx = symbolTable.nextSlotIndex;
            symbolTable.defineLocal(`__nested_ptr_${paramName}_${outerFieldName}__`, "i32");
            ctx.locals.push({ count: 1, type: "i32" });

            // Step 1: load outer field (nested struct ptr) → i32.load at outerField.slotIndex*8
            const outerByteOff = outerField.slotIndex * 8;
            function ulebNested(n: number): number[] {
              const bytes: number[] = [];
              let v = n >>> 0;
              do {
                let b = v & 0x7f;
                v >>>= 7;
                if (v !== 0) b |= 0x80;
                bytes.push(b);
              } while (v !== 0);
              return bytes;
            }
            ctx.opcodes.push(0x20, outerPtrSlot); // local.get outerPtr
            ctx.opcodes.push(0x28, 0x02, ...ulebNested(outerByteOff)); // i32.load (nested struct ptr)
            ctx.opcodes.push(0x21, tmpPtrIdx); // local.set tmpPtr

            // Step 2: load nested field at tmpPtr + nestedField.slotIndex*8
            const nestedByteOff = nestedField.slotIndex * 8;
            const loadDomain =
              nestedField.kind === "numeric"
                ? nestedField.domain
                : nestedField.kind === "boolean"
                  ? "i32"
                  : "i32";
            ctx.opcodes.push(0x20, tmpPtrIdx); // local.get tmpPtr
            switch (loadDomain) {
              case "i32":
                ctx.opcodes.push(0x28, 0x02, ...ulebNested(nestedByteOff)); // i32.load
                break;
              case "i64":
                ctx.opcodes.push(0x29, 0x03, ...ulebNested(nestedByteOff)); // i64.load
                break;
              case "f64":
                ctx.opcodes.push(0x2b, 0x03, ...ulebNested(nestedByteOff)); // f64.load
                break;
            }
            return;
          }
        }
      }
    }

    // Fall through: not a known record param access
    throw new LoweringError({
      kind: "unsupported-node",
      message: `LoweringVisitor: PropertyAccessExpression '${propAccess.getText()}' in record function is not a simple record field access — complex property access not yet supported`,
    });
  }

  // ---- Parenthesized expression: strip parens, recurse ----
  if (kind === SyntaxKind.ParenthesizedExpression) {
    const inner = expr.asKindOrThrow(SyntaxKind.ParenthesizedExpression).getExpression();
    lower(inner);
    return;
  }

  // ---- BinaryExpression: handle inline so sub-expressions use record-aware path ----
  //
  // @decision DEC-V1-WAVE-3-WASM-LOWER-RECORD-EXPR-RECURSE-001 (see function header)
  //
  // This mirrors the logic of `lowerExpression` for BinaryExpression but uses
  // `lower` (= lowerExpressionRecord) for both operands.
  if (kind === SyntaxKind.BinaryExpression) {
    const binExpr = expr as BinaryExpression;
    const op = binExpr.getOperatorToken();
    const opKind = op.getKind();
    const opText = op.getText();

    // Short-circuit logical operators
    if (opKind === SyntaxKind.AmpersandAmpersandToken) {
      lower(binExpr.getLeft());
      ctx.opcodes.push(0x04, 0x7f); // if with i32 result
      lower(binExpr.getRight());
      ctx.opcodes.push(0x05); // else
      ctx.opcodes.push(0x41, 0x00); // i32.const 0
      ctx.opcodes.push(0x0b); // end
      return;
    }
    if (opKind === SyntaxKind.BarBarToken) {
      lower(binExpr.getLeft());
      ctx.opcodes.push(0x04, 0x7f); // if with i32 result
      ctx.opcodes.push(0x41, 0x01); // i32.const 1
      ctx.opcodes.push(0x05); // else
      lower(binExpr.getRight());
      ctx.opcodes.push(0x0b); // end
      return;
    }

    // Assignment expression
    if (opKind === SyntaxKind.EqualsToken) {
      lower(binExpr.getRight());
      const lhs = binExpr.getLeft();
      if (lhs.getKind() !== SyntaxKind.Identifier) {
        throw new LoweringError({
          kind: "unsupported-node",
          message: `LoweringVisitor: assignment LHS must be a simple identifier in record function, got SyntaxKind '${SyntaxKind[lhs.getKind()]}'`,
        });
      }
      const name = lhs.asKindOrThrow(SyntaxKind.Identifier).getText();
      const slot = ctx.table.lookup(name);
      if (slot === undefined || slot.kind === "captured") {
        throw new LoweringError({
          kind: "unsupported-node",
          message: `LoweringVisitor: assignment target '${name}' not found as a local slot in record function`,
        });
      }
      ctx.opcodes.push(0x22, slot.index); // local.tee
      return;
    }

    // For all other binary ops: emit both operands via record-aware path
    lower(binExpr.getLeft());
    lower(binExpr.getRight());

    const arithOps = ctx.domain === "i32" ? I32_OPS : ctx.domain === "i64" ? I64_OPS : F64_OPS;
    const cmpOps =
      ctx.domain === "i32" ? I32_CMP_OPS : ctx.domain === "i64" ? I64_CMP_OPS : F64_CMP_OPS;
    const bitopOps = I32_BITOP_OPS;

    // f64 modulo (same logic as lowerExpression)
    if (opText === "%" && ctx.domain === "f64") {
      const tmpYIdx = ctx.table.nextSlotIndex;
      ctx.table.defineLocal("__mod_y__", "f64");
      const tmpXIdx = ctx.table.nextSlotIndex;
      ctx.table.defineLocal("__mod_x__", "f64");
      ctx.locals.push({ count: 1, type: "f64" });
      ctx.locals.push({ count: 1, type: "f64" });
      ctx.opcodes.push(0x21, tmpYIdx);
      ctx.opcodes.push(0x22, tmpXIdx);
      ctx.opcodes.push(0x20, tmpXIdx);
      ctx.opcodes.push(0x20, tmpYIdx);
      ctx.opcodes.push(0xa3);
      ctx.opcodes.push(0x9d);
      ctx.opcodes.push(0x20, tmpYIdx);
      ctx.opcodes.push(0xa2);
      ctx.opcodes.push(0xa1);
      return;
    }

    if (opText in arithOps) {
      ctx.opcodes.push(...(arithOps[opText] ?? []));
      return;
    }
    if (opText in cmpOps) {
      ctx.opcodes.push(...(cmpOps[opText] ?? []));
      return;
    }
    if (ctx.domain === "i32" && opText in bitopOps) {
      ctx.opcodes.push(...(bitopOps[opText] ?? []));
      return;
    }

    throw new LoweringError({
      kind: "unsupported-node",
      message: `LoweringVisitor: unsupported binary operator '${opText}' (SyntaxKind '${SyntaxKind[opKind]}') for domain ${ctx.domain} in record function`,
    });
  }

  // ---- PrefixUnaryExpression: recurse operand via record-aware path ----
  if (kind === SyntaxKind.PrefixUnaryExpression) {
    const unary = expr as PrefixUnaryExpression;
    const opToken = unary.getOperatorToken();

    if (opToken === SyntaxKind.ExclamationToken) {
      lower(unary.getOperand());
      ctx.opcodes.push(0x45); // i32.eqz
      return;
    }
    if (opToken === SyntaxKind.MinusToken) {
      lower(unary.getOperand());
      if (ctx.domain === "i32") {
        ctx.opcodes.splice(ctx.opcodes.length - 2, 0, 0x41, 0x00);
        ctx.opcodes.push(0x6b);
      } else if (ctx.domain === "i64") {
        ctx.opcodes.splice(ctx.opcodes.length - 2, 0, 0x42, 0x00);
        ctx.opcodes.push(0x7d);
      } else {
        ctx.opcodes.push(0x9a); // f64.neg
      }
      return;
    }
    if (opToken === SyntaxKind.TildeToken) {
      lower(unary.getOperand());
      ctx.opcodes.push(0x41, ...sleb128_i32(-1));
      ctx.opcodes.push(0x73); // i32.xor
      return;
    }
    throw new LoweringError({
      kind: "unsupported-node",
      message: `LoweringVisitor: unsupported prefix unary operator (SyntaxKind '${SyntaxKind[opToken]}') in record function`,
    });
  }

  // For all other terminal expression kinds (Identifier, NumericLiteral, BooleanLiteral),
  // delegate to the general numeric lowering — these do not contain record field accesses.
  lowerExpression(ctx, expr);
}

/**
 * Lower a statement in a record-function context.
 *
 * Delegates to lowerStatement for most cases; overrides expression lowering
 * to use lowerExpressionRecord for PropertyAccessExpression support.
 *
 * Because lowerStatement calls lowerExpression internally (not through a
 * context function pointer), we re-implement the statement dispatch here
 * for the record case. This is the minimal set: ReturnStatement,
 * VariableStatement, IfStatement, ExpressionStatement.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
 */
function lowerStatementRecord(
  ctx: LoweringContext,
  stmt: Statement,
  recordParams: RecordParamMap,
  ptrSlotMap: Map<string, number>,
  symbolTable: SymbolTable,
): void {
  const kind = stmt.getKind();

  // Helper: lower an expression using the record-aware path
  const lowerExpr = (e: Expression): void =>
    lowerExpressionRecord(ctx, e, recordParams, ptrSlotMap, symbolTable);

  if (kind === SyntaxKind.ReturnStatement) {
    const ret = stmt as ReturnStatement;
    const expr = ret.getExpression();
    if (expr !== undefined) {
      lowerExpr(expr);
    }
    if (ctx.blockDepth === 0) {
      ctx.opcodes.push(0x0f); // return
    }
    return;
  }

  if (kind === SyntaxKind.VariableStatement) {
    const varStmt = stmt as VariableStatement;
    const decls = varStmt.getDeclarationList().getDeclarations();
    for (const decl of decls) {
      const initializer = decl.getInitializer();
      const varName = decl.getName();
      if (initializer !== undefined) {
        lowerExpr(initializer);
      } else {
        emitConst(ctx, 0);
      }
      const slot = ctx.table.defineLocal(varName, ctx.domain);
      ctx.locals.push({ count: 1, type: ctx.domain });
      ctx.opcodes.push(0x21, slot.index); // local.set
    }
    return;
  }

  if (kind === SyntaxKind.IfStatement) {
    const ifStmt = stmt as IfStatement;
    const condition = ifStmt.getExpression();
    const thenStmt = ifStmt.getThenStatement();
    const elseStmt = ifStmt.getElseStatement();

    lowerExpr(condition);

    const domainValtypes: Record<string, number> = { i32: 0x7f, i64: 0x7e, f64: 0x7c };
    const blockResultType = domainValtypes[ctx.domain] ?? 0x7f;
    ctx.opcodes.push(0x04, blockResultType);
    ctx.blockDepth++;

    ctx.table.pushFrame({ isFunctionBoundary: false });
    if (thenStmt.getKind() === SyntaxKind.Block) {
      const thenBlock = thenStmt as Block;
      for (const s of thenBlock.getStatements()) {
        lowerStatementRecord(ctx, s, recordParams, ptrSlotMap, symbolTable);
      }
    } else {
      lowerStatementRecord(ctx, thenStmt as Statement, recordParams, ptrSlotMap, symbolTable);
    }
    ctx.table.popFrame();

    if (elseStmt !== undefined) {
      ctx.opcodes.push(0x05); // else
      ctx.table.pushFrame({ isFunctionBoundary: false });
      if (elseStmt.getKind() === SyntaxKind.Block) {
        const elseBlock = elseStmt as Block;
        for (const s of elseBlock.getStatements()) {
          lowerStatementRecord(ctx, s, recordParams, ptrSlotMap, symbolTable);
        }
      } else {
        lowerStatementRecord(ctx, elseStmt as Statement, recordParams, ptrSlotMap, symbolTable);
      }
      ctx.table.popFrame();
    }

    ctx.blockDepth--;
    ctx.opcodes.push(0x0b); // end
    return;
  }

  if (kind === SyntaxKind.ExpressionStatement) {
    const exprStmt = stmt.asKindOrThrow(SyntaxKind.ExpressionStatement);
    const innerExpr = exprStmt.getExpression();
    lowerExpr(innerExpr);
    ctx.opcodes.push(0x1a); // drop
    return;
  }

  throw new LoweringError({
    kind: "unsupported-node",
    message: `LoweringVisitor: unsupported statement SyntaxKind '${SyntaxKind[kind]}' in record function lowering`,
  });
}

export class LoweringVisitor {
  private readonly _table: SymbolTable;

  constructor() {
    this._table = new SymbolTable();
  }

  /**
   * Access the symbol table for testing and inspection.
   * Exposed so tests can verify frame push/pop and slot assignments.
   */
  get symbolTable(): SymbolTable {
    return this._table;
  }

  /**
   * Parse `source` and lower the first exported function.
   *
   * Creates a new ts-morph Project for each invocation (in-memory, no disk
   * access). A persistent project across calls would need careful file
   * management; given that each ResolvedBlock is independent, per-call
   * projects keep isolation simple.
   *
   * @throws LoweringError kind "missing-export" if no exported function found.
   * @throws LoweringError kind "unsupported-node" for any unhandled node kind.
   * @throws LoweringError kind "parse-error" for hard TypeScript syntax errors.
   */
  lower(source: string): LoweringResult {
    const sourceFile = this._parseSource(source);
    const fn = this._findExportedFunction(sourceFile);
    return this._lowerFunction(fn);
  }

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  private _parseSource(source: string): SourceFile {
    // In-memory project: no tsconfig, no file I/O.
    // skipAddingFilesFromTsConfig avoids attempting to load a tsconfig.json
    // from disk, which would fail in test environments.
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        strict: true,
        target: 99, // ESNext
      },
    });

    const sf = project.createSourceFile("block.ts", source);

    // Report hard SYNTAX errors loudly (parser-level errors only, not type errors).
    //
    // @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-INFERENCE-002
    // @title _parseSource rejects syntax errors only; semantic type errors are permitted
    // @status accepted
    // @rationale
    //   The lowering pass receives source from a ResolvedBlock that has already
    //   passed upstream type-checking. Within the lowering stage, domain inference
    //   keys off AST structure (BigIntLiteral nodes, TypeFlags on params/return),
    //   not TypeScript's semantic type-consistency judgments. A function whose
    //   TypeScript return type is `number` but whose body contains a BigIntLiteral
    //   (e.g. `123n`) will have a semantic type error ("bigint not assignable to
    //   number"), but the AST is fully parseable and domain inference must still
    //   see the BigIntLiteral in the body and infer i64. Using getSyntaxDiagnostics()
    //   (parser-only) rather than getPreEmitDiagnostics() (parser + type-checker)
    //   ensures that BigIntLiteral-in-body forces i64 even when the TypeScript
    //   signature says `number → number`. This matches the documented rule 7 in
    //   inferNumericDomain: "BigIntLiteral in body → i64".
    // Note: getSyntacticDiagnostics() is a Program method (accessed via
    // project.getProgram()). It returns only parser-level (syntactic) errors,
    // not type-checker (semantic) errors. This is distinct from
    // getPreEmitDiagnostics() which returns all errors including semantic ones.
    const syntaxDiagnostics = project.getProgram().getSyntacticDiagnostics(sf);
    if (syntaxDiagnostics.length > 0) {
      const msgs = syntaxDiagnostics
        .map((d) => d.getMessageText())
        .map((m) => (typeof m === "string" ? m : m.getMessageText()))
        .join("; ");
      throw new LoweringError({
        kind: "parse-error",
        message: `ts-morph parse error in block source: ${msgs}`,
      });
    }

    return sf;
  }

  // -------------------------------------------------------------------------
  // Entry-function discovery
  // -------------------------------------------------------------------------

  private _findExportedFunction(sf: SourceFile): FunctionDeclaration {
    const fns = sf.getFunctions().filter((f) => f.isExported());
    if (fns.length === 0) {
      throw new LoweringError({
        kind: "missing-export",
        message:
          "LoweringVisitor: source has no exported function declaration. " +
          "Every ResolvedBlock.source must export exactly one function.",
      });
    }
    // Take the first exported function. The spec constrains blocks to one
    // exported entry function; multiple exports are out of scope for WI-01.
    return fns[0] as FunctionDeclaration;
  }

  // -------------------------------------------------------------------------
  // Function lowering — dispatch
  // -------------------------------------------------------------------------

  private _lowerFunction(fn: FunctionDeclaration): LoweringResult {
    const fnName = fn.getName() ?? "fn";
    // WI-V1W3-WASM-LOWER-05: string shapes checked before wave-2.
    // @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001
    const strShape = detectStringShape(fn);
    if (strShape !== null) return this._lowerStringFunction(fn, strShape);
    // Wave-2 fast-paths MUST run before record-shape detection.
    //
    // @decision DEC-V1-WAVE-3-WASM-LOWER-WAVE2-BEFORE-RECORD-001
    // @title Wave-2 fast-paths checked before record shape detection
    // @status accepted
    // @rationale
    //   The wave-2 `sum_record` substrate `(r: { a: number; b: number }): number`
    //   matches `detectRecordShape` because it has an object-literal param type.
    //   If record detection ran first, `sum_record` would be routed to
    //   `_lowerRecordFunction`, which (a) produces different opcodes than the
    //   wave-2 fast-path, breaking byte-equivalence with the parity fixture, and
    //   (b) was failing at runtime because `lowerExpressionRecord` called the
    //   general `lowerExpression` fallback, which doesn't handle
    //   `PropertyAccessExpression`. Checking wave-2 first preserves the regression
    //   gate (`WI-V1W2-WASM-02 parity — substrate 4: record → number`).
    //   Record shapes are only reached by functions that do NOT match a wave-2 shape.
    const shape = detectWave2Shape(fn);
    if (shape !== null) {
      const wasmFn = this._wave2FastPath(shape, fn);
      return { fnName, wasmFn, wave2Shape: shape, warnings: [] };
    }
    // WI-V1W3-WASM-LOWER-06: record shapes checked before general numeric lowering.
    // @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
    const recShape = detectRecordShape(fn);
    if (recShape !== null) return this._lowerRecordFunction(fn, recShape);
    // WI-V1W3-WASM-LOWER-07: array shapes checked before general numeric lowering.
    // Dispatch order note: array detection runs AFTER wave-2 (which now only matches
    // the exact sum_array substrate via .reduce narrowing) and AFTER record detection
    // (which runs on object-literal params, not array params).
    //
    // @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-DISPATCH-001
    // @title Array shape detection runs after wave-2 and record, before numeric lowering
    // @status accepted
    // @rationale
    //   Wave-2 sum_array is now narrowed to `.reduce`-body functions, so all other
    //   array-param functions correctly fall through to detectArrayShape(). Record
    //   detection fires on object-literal param types ({...}), which are disjoint from
    //   array types (T[]). Array detection therefore has no ordering conflict with record
    //   detection. Numeric lowering is last as the catch-all for simple scalar functions.
    const arrShape = detectArrayShape(fn);
    if (arrShape !== null) return this._lowerArrayFunction(fn, arrShape);
    return this._lowerNumericFunction(fn);
  }

  // -------------------------------------------------------------------------
  // String lowering (WI-V1W3-WASM-LOWER-05)
  // -------------------------------------------------------------------------

  /**
   * Lower a string-operation function.
   * Returns empty WasmFunction placeholder; real body built by emitStringModule().
   * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001
   */
  private _lowerStringFunction(
    fn: FunctionDeclaration,
    stringShape: StringShapeMeta,
  ): LoweringResult {
    const fnName = fn.getName() ?? "fn";
    this._table.pushFrame({ isFunctionBoundary: true });
    for (const p of fn.getParameters()) {
      this._table.defineParam(p.getName(), "i32");
    }
    this._table.popFrame();
    return {
      fnName,
      wasmFn: { locals: [], body: [] },
      wave2Shape: null,
      stringShape,
      warnings: [],
    };
  }

  // -------------------------------------------------------------------------
  // Wave-2 fast-path dispatch
  // -------------------------------------------------------------------------

  private _wave2FastPath(shape: NonNullable<Wave2Shape>, fn: FunctionDeclaration): WasmFunction {
    switch (shape) {
      case "add":
        return fastPathAdd(fn, this._table);
      case "string_bytecount":
        return fastPathStringBytecount(fn, this._table);
      case "format_i32":
        return fastPathFormatI32(fn, this._table);
      case "sum_record":
        return fastPathSumRecord(fn, this._table);
      case "sum_array":
        return fastPathSumArray(fn, this._table);
    }
  }

  // -------------------------------------------------------------------------
  // General numeric lowering (WI-V1W3-WASM-LOWER-02)
  // -------------------------------------------------------------------------

  /**
   * Lower a numeric function: infer domain, register params, lower body.
   *
   * For mixed bigint+number functions (e.g. `mixedBig(a: bigint, n: number)`),
   * each parameter is registered with its per-param domain derived from its
   * TypeChecker type flags: bigint-typed params → i64; others → function domain.
   * This is required because WASM local slots for params must match the actual
   * WASM function type — a `number` param must be `i32` even in an i64-domain fn.
   *
   * @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001 (see file header)
   * @decision DEC-V1-WAVE-3-WASM-LOWER-BIGINT-001 (per-param domain for mixed fns)
   */
  private _lowerNumericFunction(fn: FunctionDeclaration): LoweringResult {
    const fnName = fn.getName() ?? "fn";
    const { domain, warning } = inferNumericDomain(fn);
    const warnings: string[] = warning !== null ? [warning] : [];

    // Build lowering context
    const ctx: LoweringContext = {
      domain,
      table: this._table,
      opcodes: [],
      locals: [],
      blockDepth: 0,
    };

    // Register parameters in the symbol table and collect per-param domains.
    //
    // Per-param domain detection (WI-04): if a param is bigint-typed, register as
    // i64 regardless of the function's overall domain. This handles mixed functions
    // like `mixedBig(a: bigint, n: number)` where `a` must be i64 and `n` must be
    // the function's number-domain (e.g. i32 — the default for `number` params in
    // the absence of other indicators). Without this, `n` would be registered as i64
    // and the i64.extend_i32_s coercion in BigInt(n) would find an i64 on the stack
    // (wrong) instead of the expected i32.
    //
    // The paramDomains array is returned in LoweringResult so callers can build a
    // WASM type section with heterogeneous param types.
    this._table.pushFrame({ isFunctionBoundary: true });
    const paramDomains: NumericDomain[] = [];
    for (const param of fn.getParameters()) {
      const paramName = param.getName();
      const paramTypeFlags = param.getType().getFlags();
      const paramIsBigInt =
        (paramTypeFlags & TypeFlags.BigInt) !== 0 ||
        (paramTypeFlags & TypeFlags.BigIntLiteral) !== 0;
      const paramDomain: NumericDomain = paramIsBigInt ? "i64" : domain === "i64" ? "i32" : domain;
      this._table.defineParam(paramName, paramDomain);
      paramDomains.push(paramDomain);
    }

    // Lower the function body
    const bodyNode = fn.getBody();
    if (bodyNode === undefined) {
      this._table.popFrame();
      throw new LoweringError({
        kind: "unsupported-node",
        message: `LoweringVisitor: function '${fnName}' has no body — abstract/ambient declarations are not supported`,
      });
    }
    // ts-morph getBody() returns Node; cast to Block to access getStatements().
    // FunctionDeclaration bodies are always Blocks per the TypeScript grammar.
    const body = bodyNode as Block;
    const statements = body.getStatements();
    for (const stmt of statements) {
      lowerStatement(ctx, stmt);
    }

    this._table.popFrame();

    return {
      fnName,
      wasmFn: {
        locals: ctx.locals,
        body: ctx.opcodes,
      },
      wave2Shape: null,
      numericDomain: domain,
      paramDomains,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // Record lowering (WI-V1W3-WASM-LOWER-06)
  // -------------------------------------------------------------------------

  /**
   * Lower a record-operation function.
   *
   * Strategy:
   *   - Infer the overall numeric domain from the function body (using the same
   *     inferNumericDomain heuristics as general numeric lowering).
   *   - Register each TS param as a WASM local slot. Record-typed params register
   *     as i32 (they receive the struct pointer). Non-record params register normally.
   *   - Build a recordParams map: paramName → RecordShapeMeta.
   *   - Build a ptrSlotMap: paramName → WASM slot index for the struct ptr.
   *   - Lower the function body using lowerStatementRecord(), which calls
   *     lowerExpressionRecord() — a variant of lowerExpression that handles
   *     PropertyAccessExpression for record field access.
   *
   * @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
   * @decision DEC-V1-WAVE-3-WASM-LOWER-RECORD-BY-VALUE-001
   */
  private _lowerRecordFunction(
    fn: FunctionDeclaration,
    recordShape: RecordShapeMeta,
  ): LoweringResult {
    const fnName = fn.getName() ?? "fn";

    // Infer domain from the function body (same heuristics as numeric lowering).
    // For record functions that have boolean return or mixed types, this gives
    // the "primary" domain for arithmetic in the body.
    const { domain, warning } = inferNumericDomain(fn);
    const warnings: string[] = warning !== null ? [warning] : [];

    // Build lowering context
    const opcodes: number[] = [];
    const locals: LocalDecl[] = [];
    const ctx: LoweringContext = {
      domain,
      table: this._table,
      opcodes,
      locals,
      blockDepth: 0,
    };

    // Register parameters and build record param maps
    this._table.pushFrame({ isFunctionBoundary: true });

    const recordParams: RecordParamMap = new Map();
    const ptrSlotMap: Map<string, number> = new Map();
    const params = fn.getParameters();

    for (const param of params) {
      const paramName = param.getName();
      const typeNode = param.getTypeNode();
      const typeText = typeNode?.getText().trim() ?? "";

      if (typeText.startsWith("{")) {
        // Record-typed param: receives the struct ptr (i32)
        const slot = this._table.defineParam(paramName, "i32");
        ptrSlotMap.set(paramName, slot.index);

        // Find the RecordShapeMeta for this param by parsing its type
        const fieldDefs = parseObjectTypeFields(typeText);
        if (fieldDefs.length > 0) {
          const paramShape = buildRecordShapeMeta(fieldDefs, 1, false, false);
          recordParams.set(paramName, paramShape);

          // Build nested field maps for nested record fields
          for (const field of paramShape.fields) {
            if (field.kind === "record") {
              // The field type text is available from fieldDefs
              const fieldDef = fieldDefs.find((f) => f.name === field.name);
              if (fieldDef !== undefined) {
                const nestedFieldDefs = parseObjectTypeFields(fieldDef.typeText);
                if (nestedFieldDefs.length > 0) {
                  // Store nested shape under composite key "paramName.fieldName"
                  const nestedShape = buildRecordShapeMeta(nestedFieldDefs, 1, false, false);
                  recordParams.set(`${paramName}.${field.name}`, nestedShape);
                }
              }
            }
          }
        }
      } else {
        // Non-record param (e.g., _size: number) — register as i32 (size params are integers)
        this._table.defineParam(paramName, "i32");
      }
    }

    // Lower the function body using record-aware expression lowering
    const bodyNode = fn.getBody();
    if (bodyNode === undefined) {
      this._table.popFrame();
      throw new LoweringError({
        kind: "unsupported-node",
        message: `LoweringVisitor: record function '${fnName}' has no body`,
      });
    }

    const body = bodyNode as Block;
    const statements = body.getStatements();
    for (const stmt of statements) {
      lowerStatementRecord(ctx, stmt, recordParams, ptrSlotMap, this._table);
    }

    this._table.popFrame();

    return {
      fnName,
      wasmFn: {
        locals: ctx.locals,
        body: ctx.opcodes,
      },
      wave2Shape: null,
      numericDomain: domain,
      recordShape,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // Array lowering (WI-V1W3-WASM-LOWER-07)
  // -------------------------------------------------------------------------

  /**
   * Lower an array-operation function.
   *
   * Strategy:
   *   - Register array params as 3 consecutive i32 locals (ptr, length, capacity).
   *   - Register scalar params (push value, index) as single i32 locals.
   *   - Return the ArrayShapeMeta so emitArrayModule() can build the correct WASM body.
   *   - The WasmFunction body is empty here — emitArrayModule() builds the actual opcodes.
   *
   * This mirrors the pattern established by _lowerStringFunction (returns shape metadata,
   * body built by the emitter) and _lowerRecordFunction (shape-driven emission).
   *
   * Rejected operations are reported loudly per Sacred Practice #5:
   *   - .map(fn) → LoweringError (deferred to WI-V1W3-WASM-LOWER-10, requires closures)
   *   - .filter(fn) → LoweringError (deferred to WI-V1W3-WASM-LOWER-10)
   *   - for-of over arrays → LoweringError (deferred to WI-V1W3-WASM-LOWER-08)
   *   - .slice, .indexOf, .find → LoweringError (out of scope for WI-07)
   *
   * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001
   * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-PASS-BY-VALUE-001
   */
  private _lowerArrayFunction(fn: FunctionDeclaration, arrayShape: ArrayShapeMeta): LoweringResult {
    const fnName = fn.getName() ?? "fn";
    const source = fn.getText();

    // Reject deferred operations loudly (Sacred Practice #5)
    if (source.includes(".map(")) {
      throw new LoweringError({
        kind: "unsupported-node",
        message:
          "LoweringVisitor: Array.map() is not supported in WI-07 — " +
          "it requires closures (deferred to WI-V1W3-WASM-LOWER-10). " +
          "Use an explicit for loop instead.",
      });
    }
    if (source.includes(".filter(")) {
      throw new LoweringError({
        kind: "unsupported-node",
        message:
          "LoweringVisitor: Array.filter() is not supported in WI-07 — " +
          "it requires closures (deferred to WI-V1W3-WASM-LOWER-10). " +
          "Use an explicit for loop instead.",
      });
    }
    if (/for\s*\(\s*(?:const|let)\s+\w+\s+of\s+\w+/.test(source)) {
      throw new LoweringError({
        kind: "unsupported-node",
        message:
          "LoweringVisitor: for-of over arrays is not supported in WI-07 — " +
          "it requires control-flow lowering (deferred to WI-V1W3-WASM-LOWER-08). " +
          "Use an indexed for loop instead.",
      });
    }
    if (source.includes(".slice(") || source.includes(".indexOf(") || source.includes(".find(")) {
      throw new LoweringError({
        kind: "unsupported-node",
        message:
          "LoweringVisitor: Array.slice/indexOf/find are not supported in WI-07 — " +
          "these methods are out of scope for this WI. " +
          "File a new WI or use indexing directly.",
      });
    }

    // Register params in symbol table (for consistency; body is built by emitArrayModule)
    this._table.pushFrame({ isFunctionBoundary: true });
    for (const param of fn.getParameters()) {
      const paramName = param.getName();
      const pt = param.getTypeNode()?.getText().trim() ?? "";
      if (pt.endsWith("[]") || pt.startsWith("Array<")) {
        // Array param: 3 i32 slots (ptr, length, capacity)
        this._table.defineParam(`${paramName}_ptr`, "i32");
        this._table.defineParam(`${paramName}_len`, "i32");
        this._table.defineParam(`${paramName}_cap`, "i32");
      } else {
        // Scalar param (e.g., push value, index)
        this._table.defineParam(paramName, "i32");
      }
    }
    this._table.popFrame();

    return {
      fnName,
      wasmFn: { locals: [], body: [] }, // body built by emitArrayModule
      wave2Shape: null,
      numericDomain: "i32",
      arrayShape,
      warnings: [],
    };
  }
}
