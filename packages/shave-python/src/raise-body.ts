// SPDX-License-Identifier: MIT
//
// raise-body.ts — render Python AST body nodes (from the libcst envelope) as
// TS-subset IR expressions and statements (WI-782 slices 2b + 4).
//
// Slice 4 additions to the wire AST:
//   Expr: IfExp (ternary), LenCall (len(x)→x.length), Call (simple calls),
//         ListComp (map / filter patterns), UnaryOp
//   Stmt: Raise (throw new ExcClass(msg))
//
// Slice 4 error taxonomy: UnsupportedAstError now extends CannotRaiseToIRError
// from @yakcc/contracts so callers can catch either class.
//
// @decision DEC-POLYGLOT-SHAVE-PY-BODY-RAISE-001 (WI-782 slice 2b)
// @title Body translation pass operates on a structured wire AST, not raw text
// @status accepted
//
// @decision DEC-POLYGLOT-SHAVE-PY-ERROR-TAXONOMY-001 (WI-782 slice 4)
// @title UnsupportedAstError extends CannotRaiseToIRError for unified error hierarchy
// @status accepted (WI-782 slice 4)
// @rationale
//   Per #782 acceptance criteria all unsupported construct errors must be
//   CannotRaiseToIRError instances. Extending rather than replacing preserves
//   the `reason` property and existing catch-by-class tests.

import { CannotRaiseToIRError, type SourceLocation } from "@yakcc/contracts";

const UNKNOWN_LOCATION: SourceLocation = { file: "<python-source>", line: 0, col: 0 };

/**
 * Thrown when a wire-AST node carries `{type: "Unsupported"}` — the Python
 * libcst pass encountered a construct outside the supported subset.
 *
 * Extends `CannotRaiseToIRError` so callers can catch either class.
 * The `reason` string is forwarded as the `construct` field of the parent.
 */
export class UnsupportedAstError extends CannotRaiseToIRError {
  constructor(public readonly reason: string) {
    super(
      reason,
      UNKNOWN_LOCATION,
      `Unsupported Python construct for raise to TS-subset IR: ${reason}`,
    );
    this.name = "UnsupportedAstError";
  }
}

// ---------------------------------------------------------------------------
// Wire AST types (mirror the JSON shapes emitted by libcst-parse.py)
// ---------------------------------------------------------------------------

export type WireExpr =
  | { readonly type: "Name"; readonly name: string }
  | { readonly type: "Integer"; readonly value: string }
  | { readonly type: "Float"; readonly value: string }
  | { readonly type: "String"; readonly value: string }
  | { readonly type: "Bool"; readonly value: boolean }
  | { readonly type: "None" }
  | {
      readonly type: "BinaryOp";
      readonly op: string;
      readonly left: WireExpr;
      readonly right: WireExpr;
    }
  | { readonly type: "UnaryOp"; readonly op: string; readonly operand: WireExpr }
  | {
      readonly type: "IfExp";
      readonly test: WireExpr;
      readonly body: WireExpr;
      readonly orelse: WireExpr;
    }
  | { readonly type: "LenCall"; readonly arg: WireExpr }
  | { readonly type: "Call"; readonly func: string; readonly args: readonly WireExpr[] }
  | {
      readonly type: "ListComp";
      readonly kind: "map";
      readonly iter: WireExpr;
      readonly param: string;
      readonly elt: WireExpr;
    }
  | {
      readonly type: "ListComp";
      readonly kind: "filter";
      readonly iter: WireExpr;
      readonly param: string;
      readonly cond: WireExpr;
    }
  | { readonly type: "Unsupported"; readonly reason: string };

export type WireStmt =
  | { readonly type: "Return"; readonly value: WireExpr | null }
  | { readonly type: "Pass" }
  | { readonly type: "Raise"; readonly excClass: string; readonly message: WireExpr | null }
  | { readonly type: "Unsupported"; readonly reason: string };

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** Operators that libcst-parse.py emits as wire-op strings — must match TS. */
const ALLOWED_BINARY_OPS = new Set<string>([
  "+",
  "-",
  "*",
  "/",
  "%",
  "==",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
]);

const ALLOWED_UNARY_OPS = new Set<string>(["-", "+", "!", "~"]);

/** Render a single expression node to TS source text (no trailing semicolon). */
export function renderExpr(expr: WireExpr): string {
  switch (expr.type) {
    case "Name":
      return expr.name;
    case "Integer":
      return expr.value;
    case "Float":
      return expr.value;
    case "String":
      return JSON.stringify(expr.value);
    case "Bool":
      return expr.value ? "true" : "false";
    case "None":
      return "null";
    case "BinaryOp": {
      if (!ALLOWED_BINARY_OPS.has(expr.op)) {
        throw new UnsupportedAstError(`BinaryOp '${expr.op}'`);
      }
      // Always parenthesize to avoid precedence surprises across the Python → TS boundary.
      return `(${renderExpr(expr.left)} ${expr.op} ${renderExpr(expr.right)})`;
    }
    case "UnaryOp": {
      if (!ALLOWED_UNARY_OPS.has(expr.op)) {
        throw new UnsupportedAstError(`UnaryOp '${expr.op}'`);
      }
      return `${expr.op}${renderExpr(expr.operand)}`;
    }
    case "IfExp":
      // `x if c else y` → `(c ? x : y)` — always parenthesized for safety.
      return `(${renderExpr(expr.test)} ? ${renderExpr(expr.body)} : ${renderExpr(expr.orelse)})`;
    case "LenCall":
      // `len(xs)` → `(xs).length` — wraps the arg to handle complex expressions.
      return `(${renderExpr(expr.arg)}).length`;
    case "Call": {
      const args = expr.args.map(renderExpr).join(", ");
      return `${expr.func}(${args})`;
    }
    case "ListComp":
      if (expr.kind === "map") {
        // `[f(x) for x in xs]` → `(xs).map((x) => f(x))`
        return `(${renderExpr(expr.iter)}).map((${expr.param}) => ${renderExpr(expr.elt)})`;
      }
      // `[x for x in xs if p(x)]` → `(xs).filter((x) => p(x))`
      return `(${renderExpr(expr.iter)}).filter((${expr.param}) => ${renderExpr(expr.cond)})`;
    case "Unsupported":
      throw new UnsupportedAstError(expr.reason);
  }
}

/** Render a single statement to TS source text (with trailing semicolon). */
export function renderStmt(stmt: WireStmt, indent = "  "): string {
  switch (stmt.type) {
    case "Return": {
      if (stmt.value === null) {
        return `${indent}return;`;
      }
      return `${indent}return ${renderExpr(stmt.value)};`;
    }
    case "Pass":
      // Python's pass has no direct TS equivalent inside a function body.
      // We emit `void 0;` so the function still compiles when this is the only body content.
      return `${indent}void 0;`;
    case "Raise": {
      // `raise ValueError("msg")` → `throw new ValueError("msg");`
      const msgArg = stmt.message !== null ? renderExpr(stmt.message) : "";
      return `${indent}throw new ${stmt.excClass}(${msgArg});`;
    }
    case "Unsupported":
      throw new UnsupportedAstError(stmt.reason);
  }
}

/** Render a list of statements joined by newlines. */
export function renderBody(stmts: readonly WireStmt[], indent = "  "): string {
  return stmts.map((s) => renderStmt(s, indent)).join("\n");
}
