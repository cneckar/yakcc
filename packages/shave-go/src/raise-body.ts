// SPDX-License-Identifier: MIT
//
// raise-body.ts -- Go body AST -> TS-subset IR text (WI-870 slice 2).
//
// Consumes the structured GoAstBodyNode emitted by scripts/go-ast-parse.go
// (the `body` field, NOT `bodySource`) and renders TS-subset IR source text.
//
// Scope: ReturnStmt, ExprStmt (with limited expression subset), simple
// AssignStmt/DeclStmt.  Banned constructs (GoStmt, SendStmt, ChanRecv,
// SelectStmt, DeferStmt) throw the named error classes from errors.ts, each
// wrapping CannotRaiseToIRError from @yakcc/contracts.
//
// Purity inference runs as a pre-pass over the entire body AST before any
// rendering occurs.  It walks every node to detect banned constructs; it does
// NOT pattern-match raw source strings and does NOT return a hardcoded verdict.
//
// @decision DEC-POLYGLOT-GO-BODY-RAISE-001 (WI-870 slice 2)
// @title Body translation pass operates on a structured wire AST, not raw Go text
// @status accepted (WI-870 slice 2)
// @rationale
//   An alternative was to re-parse the verbatim `bodySource` string on the TS
//   side.  Two reasons against: (1) that would require hand-rolling a Go parser
//   in TS, defeating the go/ast integration; (2) double-parse is redundant cost.
//   The Go subprocess already walks the AST via go/ast; emitting a structured
//   wire shape with source locations is both cheaper and more accurate than
//   text re-parsing.  This mirrors DEC-POLYGLOT-SHAVE-PY-BODY-RAISE-001 for
//   shave-python.  raise-body.ts consumes `body`, never `bodySource`.

import type { SourceLocation } from "@yakcc/contracts";
import {
  GoChanRecvError,
  GoChanSendError,
  GoDeferError,
  GoGoroutineError,
  GoSelectError,
  GoUnsupportedConstructError,
} from "./errors.js";
import type { GoAstBodyNode, GoAstDecl, GoAstExpr, GoAstStmt } from "./go-ast-parser.js";

// ---------------------------------------------------------------------------
// Location helpers
// ---------------------------------------------------------------------------

/**
 * Build a SourceLocation from a Go AST node's embedded line/col.
 * `file` is set to the placeholder "stdin.go" (the subprocess always parses
 * from stdin; slice 3 will thread real file paths through the envelope).
 */
function loc(
  node: { readonly line: number; readonly col: number },
  file = "stdin.go",
): SourceLocation {
  return { file, line: node.line, col: node.col };
}

// ---------------------------------------------------------------------------
// Purity inference
//
// Walks the full body AST before rendering begins.  Throws on the first
// purity-boundary construct found so the raise is aborted early.
// ---------------------------------------------------------------------------

/** Walk an expression node to detect banned constructs. */
function checkExprPurity(expr: GoAstExpr): void {
  switch (expr.type) {
    case "Ident":
    case "BasicLit":
      return; // pure

    case "BinaryExpr":
      checkExprPurity(expr.x);
      checkExprPurity(expr.y);
      return;

    case "UnaryExpr":
      checkExprPurity(expr.x);
      return;

    case "CallExpr":
      // Calls are potentially impure (I/O, mutation, goroutine-spawn inside).
      // We allow them through at the expression level; statement-level rules
      // handle ExprStmt + CallExpr patterns.  Purity of the callee is opaque
      // without interprocedural analysis — slice 2 permits calls for now and
      // defers per-callee purity annotation to slice 3.
      checkExprPurity(expr.fun);
      for (const arg of expr.args) {
        checkExprPurity(arg);
      }
      return;

    case "SelectorExpr":
      checkExprPurity(expr.x);
      return;

    case "IndexExpr":
      checkExprPurity(expr.x);
      checkExprPurity(expr.index);
      return;

    case "ChanRecv":
      throw new GoChanRecvError(loc(expr));

    case "UnsupportedExpr":
      // Unsupported expressions are not banned purity boundaries per se.
      // renderExpr will throw GoUnsupportedConstructError during rendering.
      return;
  }
}

/** Walk a statement node to detect banned constructs. */
function checkStmtPurity(stmt: GoAstStmt): void {
  switch (stmt.type) {
    case "ReturnStmt":
      for (const r of stmt.results) {
        checkExprPurity(r);
      }
      return;

    case "ExprStmt":
      checkExprPurity(stmt.x);
      return;

    case "AssignStmt":
      for (const e of stmt.lhs) checkExprPurity(e);
      for (const e of stmt.rhs) checkExprPurity(e);
      return;

    case "DeclStmt":
      checkDeclPurity(stmt.decl);
      return;

    case "GoStmt":
      throw new GoGoroutineError(loc(stmt));

    case "SelectStmt":
      throw new GoSelectError(loc(stmt));

    case "DeferStmt":
      throw new GoDeferError(loc(stmt));

    case "SendStmt":
      throw new GoChanSendError(loc(stmt));

    case "UnsupportedStmt":
      // Unsupported statements will throw during rendering; not a purity issue.
      return;
  }
}

/** Walk a declaration node to detect banned constructs. */
function checkDeclPurity(decl: GoAstDecl): void {
  switch (decl.type) {
    case "ValueSpec":
      for (const v of decl.values) {
        checkExprPurity(v);
      }
      return;
    case "UnsupportedDecl":
      return;
  }
}

/**
 * Run purity inference over an entire function body.
 *
 * Throws the appropriate CannotRaiseToIRError subclass on the first banned
 * construct found.  Returns void on a clean body.
 *
 * This is a STRUCTURAL walk of the AST nodes — it does not pattern-match
 * raw source strings or return a hardcoded verdict.
 */
export function checkBodyPurity(body: GoAstBodyNode): void {
  for (const stmt of body.stmts) {
    checkStmtPurity(stmt);
  }
}

// ---------------------------------------------------------------------------
// Rendering
//
// Converts a purity-clean body to TS-subset IR text.
// ---------------------------------------------------------------------------

/** Allowed binary operators: the subset where Go and TS semantics align. */
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

/**
 * Render a single expression node to TS source text (no trailing semicolon).
 *
 * Throws GoUnsupportedConstructError for expression types outside the
 * slice-2 render surface, or GoChanRecvError for channel receives.
 */
export function renderExpr(expr: GoAstExpr, file = "stdin.go"): string {
  switch (expr.type) {
    case "Ident":
      return expr.name;

    case "BasicLit": {
      switch (expr.kind) {
        case "INT":
          return expr.value;
        case "FLOAT":
          return expr.value;
        case "STRING":
          // Go string literals use double-quotes or backticks.
          // Strip Go delimiters and re-encode via JSON.stringify so escape
          // sequences are correct for TS.
          if (expr.value.startsWith("`")) {
            // Raw string: content is between backticks verbatim.
            return JSON.stringify(expr.value.slice(1, -1));
          }
          // Interpreted string: eval the Go escape sequences the simple way
          // by stripping Go delimiters; JSON.stringify re-adds TS ones.
          // For the MVP subset (ASCII + basic escapes) this is correct.
          try {
            // eslint-disable-next-line no-new-func
            const raw = new Function(`return ${expr.value}`)() as string;
            return JSON.stringify(raw);
          } catch {
            // Fallback: emit verbatim Go string (will likely not typecheck,
            // but is at least visible for debugging).
            return expr.value;
          }
        case "CHAR":
          // Go rune literal, e.g. 'a' or '\n'.  Convert to char code number.
          // For ASCII runes this is straightforward; exotic escapes fall back.
          try {
            // eslint-disable-next-line no-new-func
            const raw = new Function(`return ${expr.value}`)() as string;
            return String(raw.codePointAt(0) ?? 0);
          } catch {
            return expr.value;
          }
        default:
          throw new GoUnsupportedConstructError(`BasicLit(${expr.kind})`, {
            file,
            line: expr.line,
            col: expr.col,
          });
      }
    }

    case "BinaryExpr": {
      if (!ALLOWED_BINARY_OPS.has(expr.op)) {
        throw new GoUnsupportedConstructError(`BinaryExpr(${expr.op})`, {
          file,
          line: expr.line,
          col: expr.col,
        });
      }
      // Always parenthesize to avoid precedence surprises at the Go -> TS
      // boundary.  TS source is regenerated by tooling; readability is a
      // slice-3+ concern.
      return `(${renderExpr(expr.x, file)} ${expr.op} ${renderExpr(expr.y, file)})`;
    }

    case "UnaryExpr": {
      const ALLOWED_UNARY = new Set(["-", "!", "^"]);
      if (!ALLOWED_UNARY.has(expr.op)) {
        throw new GoUnsupportedConstructError(`UnaryExpr(${expr.op})`, {
          file,
          line: expr.line,
          col: expr.col,
        });
      }
      // Go ^ is bitwise-NOT; TS uses ~.
      const tsOp = expr.op === "^" ? "~" : expr.op;
      return `${tsOp}${renderExpr(expr.x, file)}`;
    }

    case "CallExpr": {
      const fn = renderExpr(expr.fun, file);
      const args = expr.args.map((a) => renderExpr(a, file)).join(", ");
      return `${fn}(${args})`;
    }

    case "SelectorExpr":
      return `${renderExpr(expr.x, file)}.${expr.sel}`;

    case "IndexExpr":
      return `${renderExpr(expr.x, file)}[${renderExpr(expr.index, file)}]`;

    case "ChanRecv":
      throw new GoChanRecvError({ file, line: expr.line, col: expr.col });

    case "UnsupportedExpr":
      throw new GoUnsupportedConstructError(expr.reason, { file, line: expr.line, col: expr.col });
  }
}

/**
 * Render a single statement to TS source text (with trailing semicolon).
 *
 * Throws GoUnsupportedConstructError for statement types outside the
 * slice-2 render surface, or the appropriate banned-construct error.
 */
export function renderStmt(stmt: GoAstStmt, indent = "  ", file = "stdin.go"): string {
  switch (stmt.type) {
    case "ReturnStmt": {
      if (stmt.results.length === 0) {
        return `${indent}return;`;
      }
      if (stmt.results.length === 1) {
        const expr = stmt.results[0];
        if (expr === undefined) return `${indent}return;`;
        return `${indent}return ${renderExpr(expr, file)};`;
      }
      // Multiple returns: render as a tuple array literal.
      // (Multi-return is a Go-specific pattern; TS-subset IR represents it
      // as [T1, T2]; slice 3 will handle proper destructuring at the call site.)
      const rendered = stmt.results.map((r) => renderExpr(r, file)).join(", ");
      return `${indent}return [${rendered}];`;
    }

    case "ExprStmt":
      return `${indent}${renderExpr(stmt.x, file)};`;

    case "AssignStmt": {
      if (stmt.lhs.length === 1 && stmt.rhs.length === 1) {
        const lhsNode = stmt.lhs[0];
        const rhsNode = stmt.rhs[0];
        if (lhsNode === undefined || rhsNode === undefined) {
          throw new GoUnsupportedConstructError("AssignStmt(empty)", {
            file,
            line: stmt.line,
            col: stmt.col,
          });
        }
        const lhsStr = renderExpr(lhsNode, file);
        const rhsStr = renderExpr(rhsNode, file);
        if (stmt.tok === ":=") {
          return `${indent}const ${lhsStr} = ${rhsStr};`;
        }
        return `${indent}${lhsStr} = ${rhsStr};`;
      }
      // Multi-assign: not in slice-2 subset.
      throw new GoUnsupportedConstructError("AssignStmt(multi-lhs)", {
        file,
        line: stmt.line,
        col: stmt.col,
      });
    }

    case "DeclStmt":
      return renderDeclStmt(stmt.decl, indent, file, { line: stmt.line, col: stmt.col });

    case "GoStmt":
      throw new GoGoroutineError({ file, line: stmt.line, col: stmt.col });

    case "SelectStmt":
      throw new GoSelectError({ file, line: stmt.line, col: stmt.col });

    case "DeferStmt":
      throw new GoDeferError({ file, line: stmt.line, col: stmt.col });

    case "SendStmt":
      throw new GoChanSendError({ file, line: stmt.line, col: stmt.col });

    case "UnsupportedStmt":
      throw new GoUnsupportedConstructError(stmt.reason, { file, line: stmt.line, col: stmt.col });
  }
}

/** Render a DeclStmt's inner declaration to TS. */
function renderDeclStmt(
  decl: GoAstDecl,
  indent: string,
  file: string,
  stmtLoc: { line: number; col: number },
): string {
  switch (decl.type) {
    case "ValueSpec": {
      if (decl.names.length === 1 && decl.values.length === 1) {
        const name = decl.names[0];
        const val = decl.values[0];
        if (name === undefined || val === undefined) {
          throw new GoUnsupportedConstructError("ValueSpec(empty)", { file, ...stmtLoc });
        }
        return `${indent}const ${name} = ${renderExpr(val, file)};`;
      }
      // Multi-name decl: not in slice-2 subset.
      throw new GoUnsupportedConstructError("ValueSpec(multi-name)", { file, ...stmtLoc });
    }
    case "UnsupportedDecl":
      throw new GoUnsupportedConstructError(decl.reason, { file, ...stmtLoc });
  }
}

/**
 * Render a list of statements joined by newlines.
 * Runs purity inference first; throws on the first banned construct.
 */
export function renderBody(body: GoAstBodyNode, indent = "  ", file = "stdin.go"): string {
  checkBodyPurity(body);
  if (body.stmts.length === 0) {
    return `${indent}void 0;`;
  }
  return body.stmts.map((s) => renderStmt(s, indent, file)).join("\n");
}
