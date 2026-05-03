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
  type BinaryExpression,
  type Block,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type NumericLiteral,
  type PrefixUnaryExpression,
  Project,
  type ReturnStatement,
  type SourceFile,
  type Statement,
  SyntaxKind,
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
  if (params.includes("{") || params.includes("Record")) return "sum_record";
  if (params.includes("[]") || params.includes("Array<")) return "sum_array";
  if (params.includes("string")) return "string_bytecount";

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
 *   1. Any `/` (true division) binary operator → f64
 *   2. Any numeric literal with a decimal point → f64
 *   3. Any call to Math.{sqrt,sin,cos,log,...} or Number.isFinite/isNaN → f64
 *   4. Any bitwise operator (& | ^ << >> >>> ~) → i32
 *   5. Any integer literal > 2^31-1 or < -2^31 (i64-range) → i64
 *   6. Math.floor/ceil/round/trunc usage → i32
 *   7. Ambiguous (no conclusive hint) → f64 with downgrade warning
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001 (see file header)
 */
function inferNumericDomain(fn: FunctionDeclaration): {
  domain: NumericDomain;
  warning: string | null;
} {
  let hasF64Indicator = false;
  let hasBitop = false;
  let hasI64RangeLiteral = false;
  let hasIntegerFloorHint = false;

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
  });

  // Priority resolution
  if (hasF64Indicator) {
    return { domain: "f64", warning: null };
  }
  if (hasBitop) {
    return { domain: "i32", warning: null };
  }
  if (hasI64RangeLiteral) {
    return { domain: "i64", warning: null };
  }
  if (hasIntegerFloorHint) {
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
 */
interface LoweringContext {
  readonly domain: NumericDomain;
  readonly table: SymbolTable;
  opcodes: number[];
  locals: LocalDecl[];
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

    lowerExpression(ctx, binExpr.getLeft());
    lowerExpression(ctx, binExpr.getRight());

    // Arithmetic
    const arithOps = ctx.domain === "i32" ? I32_OPS : ctx.domain === "i64" ? I64_OPS : F64_OPS;

    // Comparison
    const cmpOps =
      ctx.domain === "i32" ? I32_CMP_OPS : ctx.domain === "i64" ? I64_CMP_OPS : F64_CMP_OPS;

    // Bitops (always i32)
    const bitopOps = I32_BITOP_OPS;

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
    if (ctx.domain === "i32" && opText in bitopOps) {
      ctx.opcodes.push(...(bitopOps[opText] ?? []));
      return;
    }

    // Assignment expression: local.set
    if (opKind === SyntaxKind.EqualsToken) {
      // The left and right are already emitted in wrong order — we shouldn't
      // have emitted left; assignment expressions are complex (they need the
      // lhs name, not its value). Fall through to unsupported.
    }

    throw new LoweringError({
      kind: "unsupported-node",
      message: `LoweringVisitor: unsupported binary operator '${opText}' (SyntaxKind '${SyntaxKind[opKind]}') for domain ${ctx.domain} in general numeric lowering`,
    });
  }

  // Prefix unary expression: -x, ~x
  if (kind === SyntaxKind.PrefixUnaryExpression) {
    const unary = expr as PrefixUnaryExpression;
    const opToken = unary.getOperatorToken();

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
      // For single-return functions, the return value stays on the stack.
      // If there are subsequent statements, we'd need a return opcode (0x0f).
      // For simple numeric functions (the scope of this WI), fall-through works.
      // @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-RETURN-001: omit explicit
      // return opcode for the final return statement — the value on the stack
      // at function end is the implicit return value per the WASM spec §3.3.6.
      // The emitter appends 0x0b (end), which is the function exit. This is
      // correct for simple single-return functions. Multi-return and early-return
      // patterns require 0x0f opcodes — deferred to WI-03 (control flow).
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
        lowerExpression(ctx, initializer);
      }
      // Allocate a local slot for this variable
      const slot = ctx.table.defineLocal(varName, ctx.domain);
      ctx.locals.push({ count: 1, type: ctx.domain });
      ctx.opcodes.push(0x21, slot.index); // local.set
    }
    return;
  }

  throw new LoweringError({
    kind: "unsupported-node",
    message: `LoweringVisitor: unsupported statement SyntaxKind '${SyntaxKind[kind]}' in general numeric lowering — add coverage in WI-V1W3-WASM-LOWER-03 (control flow)`,
  });
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
 * Any other exported function triggers a LoweringError with kind
 * "unsupported-node" naming the first unhandled SyntaxKind, per Sacred
 * Practice #5 (fail loudly and early, never silently).
 *
 * @decision DEC-V1-WAVE-3-WASM-PARSE-001 (see file header)
 * @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001 (see file header)
 */
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

    // Report hard parse errors loudly (syntax errors, not type errors).
    const diagnostics = sf.getPreEmitDiagnostics().filter(
      (d) => d.getCategory() === 1, // DiagnosticCategory.Error = 1
    );
    if (diagnostics.length > 0) {
      const msgs = diagnostics
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
    const shape = detectWave2Shape(fn);

    if (shape !== null) {
      // Wave-2 fast-path: recognised substrate shape.
      const wasmFn = this._wave2FastPath(shape, fn);
      return { fnName, wasmFn, wave2Shape: shape, warnings: [] };
    }

    // General numeric lowering (WI-V1W3-WASM-LOWER-02):
    // Attempt to lower as a pure numeric function.
    return this._lowerNumericFunction(fn);
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
   * @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001 (see file header)
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
    };

    // Register parameters in the symbol table
    this._table.pushFrame({ isFunctionBoundary: true });
    for (const param of fn.getParameters()) {
      const paramName = param.getName();
      this._table.defineParam(paramName, domain);
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
      warnings,
    };
  }
}
