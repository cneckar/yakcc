// SPDX-License-Identifier: Apache-2.0
//
// raise-body.ts -- Rust body AST -> TS-subset IR text (WI-868-2C).
//
// Consumes the structured RustAstBodyNode emitted by rust-ast-parse/src/main.rs
// (the `body` field, NOT `bodySource`) and renders TS-subset IR source text.
//
// Scope (slice 2 MVP):
//   Stmt:  LetStmt   -- const <camelName> = <expr>;
//   Stmt:  ExprStmt  -- tail (isTail=true) -> return <expr>; ; non-tail -> <expr>;
//   Stmt:  ReturnStmt -- return <expr>; (explicit return)
//   Expr:  Ident     -- camelCase via normalizeRustName
//   Expr:  Lit       -- INT/FLOAT/STR/BOOL verbatim
//   Expr:  BinaryExpr -- parenthesized: (<x> <op> <y>)
//   Expr:  UnaryExpr  -- prefix - or !
//   Expr:  CallExpr   -- fun(args...)
//   Expr:  MethodCallExpr -- receiver.method(args...)
//   Expr:  FieldExpr   -- x.field
//   Expr:  IndexExpr   -- x[index]
//   Expr:  IfExpr      -- if (<cond>) { <then> } else { <orelse> }
//   Expr:  ReturnExpr  -- return <value>; (as expression, emits stmt-style)
//
// Banned constructs emit the named error classes from errors.ts, each
// wrapping CannotRaiseToIRError from @yakcc/contracts.
//
// @decision DEC-POLYGLOT-RUST-BODY-RAISE-001 (WI-868-2C)
// @title Body translation pass operates on structured wire AST, emits TS source strings
// @status accepted (WI-868-2C)
// @rationale
//   Mirrors DEC-POLYGLOT-GO-BODY-RAISE-001 exactly.  The Rust subprocess already
//   walks the syn AST and emits a structured wire shape with source locations;
//   re-parsing bodySource on the TS side would require a Rust lexer in TS.
//   Emitting TS source-text strings (not object IR) follows the shave-go pattern
//   and lets raise-function.ts stitch the result directly into the export declaration.
//   Name normalization (snake_case -> camelCase) is applied to every Ident node here
//   so the output always has idiomatic TS identifiers.
//   Allowed binary operators are the strict subset where Rust and TS semantics align
//   (same arithmetic/comparison/logical operators; bitwise &/|/^ are excluded because
//   Rust applies them to integers while TS coerces to 32-bit signed — silently wrong).

import type { SourceLocation } from "@yakcc/contracts";
import {
  RustAsyncError,
  RustClosureCaptureError,
  RustDynTraitError,
  RustRawPointerError,
  RustUnsafeError,
  RustUnsupportedConstructError,
} from "./errors.js";
import { normalizeRustName } from "./name-normalize.js";
import type {
  RustAstBodyNode,
  RustAstElseBody,
  RustAstExpr,
  RustAstIfExpr,
  RustAstStmt,
} from "./rust-ast-parser.js";

// ---------------------------------------------------------------------------
// Reason → taxonomy class map
//
// The syn helper emits UnsupportedExpr / UnsupportedStmt nodes with reason
// strings that identify the deferred construct.  This map routes each known
// reason prefix to the dedicated errors.ts taxonomy class so callers get
// typed instanceof checks (RustUnsafeError, RustAsyncError, etc.) rather than
// the generic RustUnsupportedConstructError.
//
// @decision DEC-POLYGLOT-RUST-TAXONOMY-WIRED-001 (WI-868 slice 3)
// @title reason→class map wires UnsupportedExpr/Stmt to named taxonomy errors
// @status accepted (WI-868 slice 3)
// @rationale
//   DEC-POLYGLOT-RUST-BODY-RAISE-001 deferred this map to slice 3.  The syn helper
//   already emits distinct reason strings per construct (slice 2); this map
//   promotes each to its named class so the full error taxonomy is reachable
//   from real Rust source.  RustUnsupportedConstructError remains the fallback
//   for any reason string not covered by the known set.  The map is a pure
//   data-driven dispatch: no new error classes, no parallel hierarchy.
// ---------------------------------------------------------------------------

type TaxonomyConstructor = (location: SourceLocation) => Error;

/**
 * Build the typed error for a known deferred-construct reason string.
 * Returns null if the reason is not in the known taxonomy set.
 *
 * Reason strings emitted by rust-ast-parse/src/main.rs (verbatim):
 *   "Expr::Unsafe (unsafe block)"      → RustUnsafeError
 *   "Expr::Await (async/await)"        → RustAsyncError
 *   "Expr::Async (async block)"        → RustAsyncError
 *   "Expr::Closure (closure)"          → RustClosureCaptureError
 *   "Expr::RawAddr"                    → RustRawPointerError
 *   "Expr::Unary (Deref or ...)"       → RustRawPointerError  (raw deref)
 */
const REASON_TO_TAXONOMY: ReadonlyArray<[string, TaxonomyConstructor]> = [
  ["Expr::Unsafe", (loc) => new RustUnsafeError(loc)],
  ["Expr::Await", (loc) => new RustAsyncError(loc)],
  ["Expr::Async", (loc) => new RustAsyncError(loc)],
  ["Expr::Closure", (loc) => new RustClosureCaptureError(loc)],
  ["Expr::RawAddr", (loc) => new RustRawPointerError(loc)],
  // Raw pointer deref emitted by syn helper as "Expr::Unary (Deref or unsupported op)"
  ["Expr::Unary (Deref", (loc) => new RustRawPointerError(loc)],
  // dyn Trait: emitted as "Expr::..." from a dyn-typed expression context.
  // The syn helper does not yet emit a dedicated dyn-trait node; route if added later.
  // "dyn " prefix covers future reason strings like "dyn Trait".
  ["dyn ", (loc) => new RustDynTraitError(loc)],
];

/**
 * Map a reason string from an UnsupportedExpr / UnsupportedStmt node to the
 * appropriate taxonomy error.  Falls back to RustUnsupportedConstructError
 * for unknown reasons.
 */
function taxonomyErrorForReason(reason: string, location: SourceLocation): Error {
  for (const [prefix, ctor] of REASON_TO_TAXONOMY) {
    if (reason.startsWith(prefix) || reason.includes(prefix)) {
      return ctor(location);
    }
  }
  return new RustUnsupportedConstructError(reason, location);
}

// ---------------------------------------------------------------------------
// Location helpers
// ---------------------------------------------------------------------------

/**
 * Build a SourceLocation from a Rust AST node's embedded line/col.
 * `file` is set to the placeholder "stdin.rs" (the subprocess always parses
 * from stdin; slice 4 will thread real file paths through the envelope).
 */
function loc(
  node: { readonly line: number; readonly col: number },
  file = "stdin.rs",
): SourceLocation {
  return { file, line: node.line, col: node.col };
}

// ---------------------------------------------------------------------------
// Allowed binary operators
//
// Strict subset where Rust and TS semantics align for the pure-function
// integer/float/bool domain.  Bitwise &, |, ^ differ between Rust
// (arbitrary-width integers) and TS (coerces to 32-bit signed); excluded.
// ---------------------------------------------------------------------------

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
  "&&",
  "||",
]);

// ---------------------------------------------------------------------------
// renderExpr
// ---------------------------------------------------------------------------

/**
 * Render a single expression node to TS source text (no trailing semicolon).
 *
 * Throws RustUnsupportedConstructError (instanceof CannotRaiseToIRError) for
 * expression types outside the slice-2 render surface.
 *
 * @param expr   The v2 wire expression node.
 * @param file   Source file label for error messages (default "stdin.rs").
 * @param indent Indent prefix for multi-line expressions (if/else).
 */
export function renderExpr(expr: RustAstExpr, file = "stdin.rs", indent = "  "): string {
  switch (expr.type) {
    case "Ident":
      // Normalize Rust snake_case to camelCase for TS-subset IR identifiers.
      // Note: catch InvalidIdentifierError here is not needed — normalizeRustName
      // only throws for truly invalid chars (never emitted by syn).
      return normalizeRustName(expr.name);

    case "Lit": {
      switch (expr.kind) {
        case "INT":
          return expr.value;
        case "FLOAT":
          return expr.value;
        case "STR":
          // syn emits the unescaped string content in `value`.
          // Re-encode via JSON.stringify so TS escape sequences are correct.
          return JSON.stringify(expr.value);
        case "BOOL":
          return expr.value; // "true" or "false"
        default: {
          const _exhaustive: never = expr.kind;
          throw new RustUnsupportedConstructError(`Lit(${String(_exhaustive)})`, loc(expr, file));
        }
      }
    }

    case "BinaryExpr": {
      if (!ALLOWED_BINARY_OPS.has(expr.op)) {
        throw new RustUnsupportedConstructError(`BinaryExpr(${expr.op})`, loc(expr, file));
      }
      // Always parenthesize to avoid precedence surprises at the Rust -> TS boundary.
      return `(${renderExpr(expr.x, file, indent)} ${expr.op} ${renderExpr(expr.y, file, indent)})`;
    }

    case "UnaryExpr": {
      // Wire only emits "-" or "!" (Deref/*x routes to UnsupportedExpr at Rust layer).
      return `${expr.op}${renderExpr(expr.x, file, indent)}`;
    }

    case "CallExpr": {
      const fn = renderExpr(expr.fun, file, indent);
      const args = expr.args.map((a) => renderExpr(a, file, indent)).join(", ");
      return `${fn}(${args})`;
    }

    case "MethodCallExpr": {
      const receiver = renderExpr(expr.receiver, file, indent);
      const args = expr.args.map((a) => renderExpr(a, file, indent)).join(", ");
      return `${receiver}.${expr.method}(${args})`;
    }

    case "FieldExpr":
      return `${renderExpr(expr.x, file, indent)}.${expr.field}`;

    case "IndexExpr":
      return `${renderExpr(expr.x, file, indent)}[${renderExpr(expr.index, file, indent)}]`;

    case "IfExpr":
      return renderIfExpr(expr, file, indent);

    case "ReturnExpr": {
      // `return expr` used as an expression (e.g., inside an if arm).
      // Emit as a statement-like fragment: `return <value>`.
      // The caller (renderStmt) appends the semicolon.
      if (expr.value === null) {
        return "return";
      }
      return `return ${renderExpr(expr.value, file, indent)}`;
    }

    case "UnsupportedExpr":
      throw taxonomyErrorForReason(expr.reason, loc(expr, file));

    default: {
      const _exhaustive: never = expr;
      throw new RustUnsupportedConstructError(String(_exhaustive), { file, line: 0, col: 0 });
    }
  }
}

// ---------------------------------------------------------------------------
// renderIfExpr
//
// Rust if/else is an EXPRESSION (can appear as a tail ExprStmt for implicit
// return or in a let binding).  We render it as a multi-line TS if/else block.
// The `thenBranch` and `orelse` sub-bodies are rendered recursively.
// ---------------------------------------------------------------------------

function renderIfExpr(expr: RustAstIfExpr, file: string, indent: string): string {
  const childIndent = `${indent}  `;
  const condStr = renderExpr(expr.cond, file, childIndent);
  const thenLines = renderBodyLines(expr.thenBranch, childIndent, file);

  const parts: string[] = [];
  parts.push(`if (${condStr}) {`);
  parts.push(thenLines);

  if (expr.orelse === null) {
    parts.push(`${indent}}`);
  } else if (expr.orelse.type === "IfExpr") {
    // else-if: render the nested IfExpr and attach after "} else ".
    const nestedStr = renderIfExpr(expr.orelse, file, indent);
    // nestedStr starts with "if (...)" at no indent; attach directly.
    parts.push(`${indent}} else ${nestedStr}`);
  } else {
    // Plain else block (BlockNode).
    const elseBody = renderBodyLines((expr.orelse as RustAstElseBody).body, childIndent, file);
    parts.push(`${indent}} else {`);
    parts.push(elseBody);
    parts.push(`${indent}}`);
  }

  return parts.join("\n");
}

/**
 * Render body statements as lines (without surrounding braces).
 * Returns `${indent}void 0;` for an empty body.
 */
function renderBodyLines(body: RustAstBodyNode, indent: string, file: string): string {
  if (body.stmts.length === 0) {
    return `${indent}void 0;`;
  }
  return body.stmts.map((s) => renderStmt(s, indent, file)).join("\n");
}

// ---------------------------------------------------------------------------
// renderStmt
// ---------------------------------------------------------------------------

/**
 * Render a single statement node to TS source text (with trailing semicolon).
 *
 * Throws RustUnsupportedConstructError (instanceof CannotRaiseToIRError) for
 * statement types outside the slice-2 render surface.
 *
 * @param stmt   The v2 wire statement node.
 * @param indent Indent prefix (default "  ").
 * @param file   Source file label for error messages (default "stdin.rs").
 */
export function renderStmt(stmt: RustAstStmt, indent = "  ", file = "stdin.rs"): string {
  switch (stmt.type) {
    case "LetStmt": {
      const name = normalizeRustName(stmt.name);
      if (stmt.value === null) {
        // `let x;` (uninitialized binding) — no TS equivalent in pure subset.
        throw new RustUnsupportedConstructError(
          `LetStmt(uninitialized:${stmt.name})`,
          loc(stmt, file),
        );
      }
      const valueStr = renderExpr(stmt.value, file, `${indent}  `);
      return `${indent}const ${name} = ${valueStr};`;
    }

    case "ExprStmt": {
      // Tail ExprStmt (isTail=true) = trailing block expression = implicit return.
      // Render IfExpr tails specially: the `if` block itself emits its own
      // `return` inside the branches via recursive tail rendering.
      // For any other expression at tail position, wrap with `return`.
      if (stmt.isTail) {
        if (stmt.x.type === "IfExpr") {
          // Render the if/else block with return injected in leaves.
          return renderIfExprAsTailStmt(stmt.x, file, indent);
        }
        if (stmt.x.type === "ReturnExpr") {
          // Explicit `return expr` used as tail — redundant but valid.
          const val = stmt.x.value !== null ? renderExpr(stmt.x.value, file, indent) : "";
          return val !== "" ? `${indent}return ${val};` : `${indent}return;`;
        }
        return `${indent}return ${renderExpr(stmt.x, file, indent)};`;
      }
      // Non-tail ExprStmt: render as expression statement.
      // ReturnExpr as non-tail: rare but valid (early return inside block).
      if (stmt.x.type === "ReturnExpr") {
        const val = stmt.x.value !== null ? ` ${renderExpr(stmt.x.value, file, indent)}` : "";
        return `${indent}return${val};`;
      }
      if (stmt.x.type === "IfExpr") {
        // Non-tail if expression used as statement (e.g., if with side effects).
        // Render without injected returns — just the block.
        return renderIfExprAsStmt(stmt.x, file, indent);
      }
      return `${indent}${renderExpr(stmt.x, file, indent)};`;
    }

    case "ReturnStmt": {
      if (stmt.value === null) {
        return `${indent}return;`;
      }
      return `${indent}return ${renderExpr(stmt.value, file, indent)};`;
    }

    case "UnsupportedStmt":
      throw taxonomyErrorForReason(stmt.reason, loc(stmt, file));

    default: {
      const _exhaustive: never = stmt;
      throw new RustUnsupportedConstructError(String(_exhaustive), { file, line: 0, col: 0 });
    }
  }
}

// ---------------------------------------------------------------------------
// Tail IfExpr rendering
//
// In Rust, `if/else` is an expression.  When used as a tail ExprStmt (implicit
// return), each leaf of the if/else chain must emit `return <expr>;`.
// We detect `isTail=true` at the ExprStmt level and call renderIfExprAsTailStmt
// which recursively injects `return` into the final ExprStmt of each branch.
// ---------------------------------------------------------------------------

/**
 * Render a tail IfExpr so that each branch's leaf emits `return <expr>;`.
 *
 * This mirrors the Rust semantics: `if cond { a } else { b }` as a tail
 * expression is equivalent to `if (cond) { return a; } else { return b; }`.
 */
function renderIfExprAsTailStmt(expr: RustAstIfExpr, file: string, indent: string): string {
  const childIndent = `${indent}  `;
  const condStr = renderExpr(expr.cond, file, childIndent);

  const thenLines = renderBodyAsTail(expr.thenBranch, childIndent, file);

  const parts: string[] = [];
  parts.push(`${indent}if (${condStr}) {`);
  parts.push(thenLines);

  if (expr.orelse === null) {
    parts.push(`${indent}}`);
  } else if (expr.orelse.type === "IfExpr") {
    const nestedStr = renderIfExprAsTailStmt(expr.orelse, file, indent);
    // Strip leading indent from the nested result (it already has none for "if").
    parts.push(`${indent}} else ${nestedStr.trimStart()}`);
  } else {
    const elseBody = renderBodyAsTail((expr.orelse as RustAstElseBody).body, childIndent, file);
    parts.push(`${indent}} else {`);
    parts.push(elseBody);
    parts.push(`${indent}}`);
  }

  return parts.join("\n");
}

/**
 * Render a RustAstBodyNode treating its last statement as a tail (implicit return).
 * Non-last statements are rendered normally; the last is treated as isTail=true.
 */
function renderBodyAsTail(body: RustAstBodyNode, indent: string, file: string): string {
  if (body.stmts.length === 0) {
    return `${indent}void 0;`;
  }
  const lines: string[] = [];
  for (let i = 0; i < body.stmts.length - 1; i++) {
    const stmt = body.stmts[i];
    if (stmt !== undefined) {
      lines.push(renderStmt(stmt, indent, file));
    }
  }
  const last = body.stmts[body.stmts.length - 1];
  if (last !== undefined) {
    // Force the last stmt to tail rendering regardless of its isTail flag.
    lines.push(
      renderStmt({ ...last, ...(last.type === "ExprStmt" ? { isTail: true } : {}) }, indent, file),
    );
  }
  return lines.join("\n");
}

/**
 * Render a non-tail IfExpr as an if statement (no injected returns).
 * Used when an IfExpr appears as a non-tail ExprStmt (side-effect-only if block).
 */
function renderIfExprAsStmt(expr: RustAstIfExpr, file: string, indent: string): string {
  const childIndent = `${indent}  `;
  const condStr = renderExpr(expr.cond, file, childIndent);
  const thenLines = renderBodyLines(expr.thenBranch, childIndent, file);

  const parts: string[] = [];
  parts.push(`${indent}if (${condStr}) {`);
  parts.push(thenLines);

  if (expr.orelse === null) {
    parts.push(`${indent}}`);
  } else if (expr.orelse.type === "IfExpr") {
    const nestedStr = renderIfExprAsStmt(expr.orelse, file, indent);
    parts.push(`${indent}} else ${nestedStr.trimStart()}`);
  } else {
    const elseBody = renderBodyLines((expr.orelse as RustAstElseBody).body, childIndent, file);
    parts.push(`${indent}} else {`);
    parts.push(elseBody);
    parts.push(`${indent}}`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// renderBody (public entry point)
// ---------------------------------------------------------------------------

/**
 * Render a list of statements joined by newlines.
 *
 * This is the main entry point for raise-function.ts.  It renders each
 * statement with the given indent (default "  ", i.e. two spaces for the
 * function body).
 *
 * Returns `${indent}void 0;` for an empty body.
 *
 * @param body   The structured body from the v2 wire envelope.
 * @param indent Indent prefix for all statements (default "  ").
 * @param file   Source file label for error messages (default "stdin.rs").
 */
export function renderBody(body: RustAstBodyNode, indent = "  ", file = "stdin.rs"): string {
  if (body.stmts.length === 0) {
    return `${indent}void 0;`;
  }
  return body.stmts.map((s) => renderStmt(s, indent, file)).join("\n");
}
