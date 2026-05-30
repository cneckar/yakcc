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
// WI-888 additions to the wire AST:
//   Stmt: Docstring    — silently skipped by renderStmt (returns "")
//   Stmt: ImpureStatement — throws ImpureFunctionError(kind:"forbidden_construct")
//
// WI-903 additions to the wire AST:
//   Stmt: If — Python if/elif/else → TS if/else if/else blocks
//
// WI-904 additions to the wire AST:
//   Expr: GeneratorExp — Python generator expression → TS .map()/.filter()
//   Expr: DictComp     — Python dict comprehension → TS Object.fromEntries()
//   Expr: SetComp      — Python set comprehension → TS new Set(.map())
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
//
// @decision DEC-WI888-005 — ImpureStatement wire nodes throw at render time
// @title ImpureStatement is consumed here, not by the checkFunctionPurity walker
// @status accepted
// @rationale Wire-node classification is a statement-level determination already
//   made by the Python layer; no walker recursion is needed. Throw at render time
//   is consistent with how Unsupported is handled. The purity walker handles
//   Call/Attribute/Global *inside expressions*; ImpureStatement is a top-level stmt.
//   Cross-reference: PLAN.md §4 / #888
//
// @decision DEC-WI888-007 — fnName plumbing into renderBody / renderStmt
// @title Optional fnName parameter threads function name to ImpureFunctionError
// @status accepted
// @rationale Avoids a catch+rewrap layer in raise-function.ts. Existing callers
//   that don't pass fnName get "<unknown>" as fallback — backward-compatible.
//   Cross-reference: PLAN.md §4 / #888
//
// @decision DEC-WI903-001 — If statement lowering to TS if/else if/else
// @title Python if/elif/else lowers to nested TS if/else blocks
// @status accepted
// @rationale Standard Python → TS structural equivalence. The elif chain is
//   represented as a nested If in orelse (Python AST convention), which maps
//   naturally to TS `else if`. Single-pass recursive renderStmt handles arbitrary
//   depth. Cross-reference: #903
//
// @decision DEC-WI904-001 — Comprehension lowering MVP: single-source single-clause
// @title ListComp/DictComp/SetComp/GeneratorExp lower to .map/.filter/Object.fromEntries
// @status accepted
// @rationale MVP scope: single generator, no nested comprehension. Multi-source
//   comprehensions are rare in the bs4 target set and raise UnsupportedAstError
//   so they fail loudly rather than silently. Cross-reference: #904

import { CannotRaiseToIRError, type SourceLocation } from "@yakcc/contracts";
import { ImpureFunctionError } from "./purity-check.js";

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
  // WI-904: GeneratorExp — `(f(x) for x in xs [if cond])` → same lowering as ListComp
  | {
      readonly type: "GeneratorExp";
      readonly kind: "map";
      readonly iter: WireExpr;
      readonly param: string;
      readonly elt: WireExpr;
    }
  | {
      readonly type: "GeneratorExp";
      readonly kind: "filter_map";
      readonly iter: WireExpr;
      readonly param: string;
      readonly cond: WireExpr;
      readonly elt: WireExpr;
    }
  // WI-904: DictComp — `{k: v for target in iter [if cond]}` → Object.fromEntries(iter.map(...))
  | {
      readonly type: "DictComp";
      readonly iter: WireExpr;
      readonly param: string;
      readonly keyElt: WireExpr;
      readonly valElt: WireExpr;
      readonly cond: WireExpr | null;
    }
  // WI-904: SetComp — `{f(x) for x in xs [if cond]}` → new Set(iter.map(...))
  | {
      readonly type: "SetComp";
      readonly kind: "map";
      readonly iter: WireExpr;
      readonly param: string;
      readonly elt: WireExpr;
    }
  | {
      readonly type: "SetComp";
      readonly kind: "filter_map";
      readonly iter: WireExpr;
      readonly param: string;
      readonly cond: WireExpr;
      readonly elt: WireExpr;
    }
  | { readonly type: "Unsupported"; readonly reason: string };

export type WireStmt =
  | { readonly type: "Return"; readonly value: WireExpr | null }
  | { readonly type: "Pass" }
  | { readonly type: "Raise"; readonly excClass: string; readonly message: WireExpr | null }
  // WI-888: Docstring — first-statement string literal (PEP-257). renderStmt silently skips.
  // DEC-WI888-001: emit to wire envelope for downstream tooling; TS renderer drops it.
  | { readonly type: "Docstring"; readonly value: string }
  // WI-888: ImpureStatement — bare expression statement (call or other expr).
  // renderStmt throws ImpureFunctionError(kind:"forbidden_construct").
  // DEC-WI888-002/003: bare_call = Expr(Call); bare_expression = everything else.
  | {
      readonly type: "ImpureStatement";
      readonly construct: "bare_call" | "bare_expression";
      readonly detail: string;
    }
  // WI-903: If statement — Python if/elif/else → TS if/else if/else (DEC-WI903-001)
  // orelse: [] = no else; [WireStmt...] = else block; [{type:"If",...}] = elif chain.
  | {
      readonly type: "If";
      readonly test: WireExpr;
      readonly body: readonly WireStmt[];
      readonly orelse: readonly WireStmt[];
    }
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
  "//", // WI-875: Python floor-divide; rendered as Math.floor(left/right), not a TS operator
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
      // WI-875: TS has no floor-divide operator; emit Math.floor(left / right)
      // which matches Python semantics for integer division.
      if (expr.op === "//") {
        return `Math.floor(${renderExpr(expr.left)} / ${renderExpr(expr.right)})`;
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
    case "GeneratorExp":
      // WI-904: generator expressions lower identically to ListComp — the consumer
      // receives an Array (TS doesn't have lazy generators in this subset).
      if (expr.kind === "map") {
        // `(f(x) for x in xs)` → `(xs).map((x) => f(x))`
        return `(${renderExpr(expr.iter)}).map((${expr.param}) => ${renderExpr(expr.elt)})`;
      }
      // `(f(x) for x in xs if cond)` → `(xs).filter((x) => cond).map((x) => f(x))`
      return (
        `(${renderExpr(expr.iter)}).filter((${expr.param}) => ${renderExpr(expr.cond)})` +
        `.map((${expr.param}) => ${renderExpr(expr.elt)})`
      );
    case "DictComp": {
      // WI-904: `{k: v for target in iter [if cond]}`
      // → `Object.fromEntries(<iter>[.filter(...)].map((target) => [k, v]))`
      const iterPart =
        expr.cond !== null
          ? `(${renderExpr(expr.iter)}).filter((${expr.param}) => ${renderExpr(expr.cond)})`
          : `(${renderExpr(expr.iter)})`;
      return `Object.fromEntries(${iterPart}.map((${expr.param}) => [${renderExpr(expr.keyElt)}, ${renderExpr(expr.valElt)}]))`;
    }
    case "SetComp":
      // WI-904: `{f(x) for x in xs [if cond]}` → `new Set(<iter>[.filter(...)].map(...))`
      if (expr.kind === "map") {
        return `new Set((${renderExpr(expr.iter)}).map((${expr.param}) => ${renderExpr(expr.elt)}))`;
      }
      return (
        `new Set((${renderExpr(expr.iter)}).filter((${expr.param}) => ${renderExpr(expr.cond)})` +
        `.map((${expr.param}) => ${renderExpr(expr.elt)}))`
      );
    case "Unsupported":
      throw new UnsupportedAstError(expr.reason);
  }
}

/**
 * Render a single statement to TS source text (with trailing semicolon).
 *
 * @param stmt   — the wire statement to render
 * @param indent — indentation prefix (default "  ")
 * @param fnName — optional function name for ImpureFunctionError messages.
 *   When omitted, ImpureStatement throws with functionName="<unknown>".
 *   Pass the enclosing function's name to produce actionable error messages.
 *   (DEC-WI888-007: optional to preserve backward compatibility.)
 */
export function renderStmt(stmt: WireStmt, indent = "  ", fnName?: string): string {
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
    case "Docstring":
      // WI-888 DEC-WI888-001: silently drop. The wire envelope retains the value
      // for downstream tooling; the TS-subset IR has no equivalent and we don't
      // fabricate one. renderFunctionDeclaration filters Docstrings before the
      // void-0 fallback check (DEC-WI888-008).
      return "";
    case "ImpureStatement": {
      // WI-888 DEC-WI888-005: throw at render time, not from the purity walker.
      // The wire node classification was already made by the Python layer.
      const verb = stmt.construct === "bare_call" ? "calls" : "evaluates";
      const detail = `${verb} bare expression-statement: ${stmt.detail}`;
      throw new ImpureFunctionError(fnName ?? "<unknown>", "forbidden_construct", detail);
    }
    case "If": {
      // WI-903 DEC-WI903-001: Python if/elif/else → TS if/else if/else.
      //
      // Python's elif is represented as orelse=[{type:"If",...}] — a single-element
      // list containing a nested If. We detect that shape and emit `else if` rather
      // than a nested `else { if (...) { } }` block, matching Python's flat style.
      //
      // indent for the inner body uses two extra spaces relative to the current level.
      const innerIndent = `${indent}  `;
      const bodyLines = stmt.body
        .map((s) => renderStmt(s, innerIndent, fnName))
        .filter((l) => l !== "")
        .join("\n");
      const bodyBlock = bodyLines || `${innerIndent}void 0;`;
      let result = `${indent}if (${renderExpr(stmt.test)}) {\n${bodyBlock}\n${indent}}`;
      if (stmt.orelse.length > 0) {
        // elif chain: orelse is a single If node — emit `else if`
        const firstOrelse = stmt.orelse[0];
        if (stmt.orelse.length === 1 && firstOrelse?.type === "If") {
          // Recurse: renderStmt will produce `<indent>if (...) { ... }` — splice after `else `.
          const elseIfText = renderStmt(firstOrelse, indent, fnName);
          // elseIfText starts with `${indent}if` — trim the leading indent for the else clause.
          result += ` else ${elseIfText.trimStart()}`;
        } else {
          // Plain else block
          const elseLines = stmt.orelse
            .map((s) => renderStmt(s, innerIndent, fnName))
            .filter((l) => l !== "")
            .join("\n");
          const elseBlock = elseLines || `${innerIndent}void 0;`;
          result += ` else {\n${elseBlock}\n${indent}}`;
        }
      }
      return result;
    }
    case "Unsupported":
      throw new UnsupportedAstError(stmt.reason);
  }
}

/**
 * Render a list of statements joined by newlines.
 *
 * @param stmts  — wire statements to render
 * @param indent — indentation prefix (default "  ")
 * @param fnName — optional function name forwarded to renderStmt for
 *   ImpureFunctionError messages. (DEC-WI888-007)
 */
export function renderBody(stmts: readonly WireStmt[], indent = "  ", fnName?: string): string {
  return stmts.map((s) => renderStmt(s, indent, fnName)).join("\n");
}
