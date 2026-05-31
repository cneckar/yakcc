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
// WI-964 additions:
//   Stmt: IfStmt    — if (cond) { ... } else if (...) { ... } else { ... }
//   Stmt: ForStmt   — for (let i = 0; i < n; i++) { ... }
//   Stmt: RangeStmt — for (const [k, v] of Object.entries(items)) { ... }
//                     or items.forEach((v, k) => ...) for index-only
//   Stmt: SwitchStmt — switch (x) { case ...: ...; break; }
//   Expr: BinaryExpr >> / << (bitshift)
//   Decl: ValueSpec multi-name — var a, b = x, y splits into multiple consts
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
//
// @decision DEC-POLYGLOT-GO-CONTROL-FLOW-001 (WI-964)
// @title Go control-flow lowering strategy for IfStmt/ForStmt/RangeStmt/SwitchStmt
// @status accepted (WI-964)
// @rationale
//   IfStmt: direct structural equivalence — Go `if/else if/else` maps to TS
//   `if/else if/else` by recursion through the `orelse` chain (IfStmt = else-if,
//   BlockNode = plain else).  Init statements in if-headers are emitted as a
//   preceding `const` assignment in the same block scope.
//   ForStmt: Go classic for (init; cond; post) maps directly to TS for (init; cond; post).
//   The post statement is rendered without a trailing semicolon (it is already
//   provided by the for(...) header syntax).
//   RangeStmt: for maps `for k, v := range m` uses `for...of Object.entries()`
//   which is the closest semantic match for maps; arrays use the same form since
//   Object.entries on an array yields [index, value] pairs.  The `forEach` variant
//   is NOT chosen because it cannot contain `return` statements (they return from
//   the callback, not the outer function), which would silently change semantics.
//   SwitchStmt: Go switch maps to TS switch.  Each case gets an explicit `break`
//   appended because Go cases do NOT fall through by default (opposite of JS/TS).
//   Tagless switch (switch { case x > 0: ... }) lowers to `switch (true)`.
//   ValueSpec multi-name: `var a, b = x, y` emits two sequential `const` declarations.
//   Bitshift >>/<< are now included in ALLOWED_BINARY_OPS — semantics are identical
//   between Go and TS for the integer domain used in pure functions.

import type { SourceLocation } from "@yakcc/contracts";
import {
  GoChanRecvError,
  GoChanSendError,
  GoDeferError,
  GoGoroutineError,
  GoSelectError,
  GoUnsupportedConstructError,
} from "./errors.js";
import type {
  GoAstBodyNode,
  GoAstCaseClause,
  GoAstDecl,
  GoAstElseBody,
  GoAstExpr,
  GoAstForStmt,
  GoAstIfStmt,
  GoAstIncDecStmt,
  GoAstMapEntry,
  GoAstRangeStmt,
  GoAstStmt,
  GoAstSwitchStmt,
} from "./go-ast-parser.js";

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

    // #986: SliceLit — walk element expressions for purity.
    case "SliceLit":
      for (const el of expr.elements) {
        checkExprPurity(el);
      }
      return;

    // #986: MapLit — walk key and value expressions for purity.
    case "MapLit":
      for (const entry of expr.entries) {
        checkExprPurity(entry.key);
        checkExprPurity(entry.value);
      }
      return;

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

    // WI-964: control-flow nodes — walk into child nodes for purity.
    case "IfStmt":
      if (stmt.init !== null) checkStmtPurity(stmt.init);
      checkExprPurity(stmt.cond);
      checkBodyNodePurity(stmt.body);
      if (stmt.orelse !== null) {
        if (stmt.orelse.type === "IfStmt") {
          checkStmtPurity(stmt.orelse);
        } else {
          checkBodyNodePurity(stmt.orelse.body);
        }
      }
      return;

    case "ForStmt":
      if (stmt.init !== null) checkStmtPurity(stmt.init);
      if (stmt.cond !== null) checkExprPurity(stmt.cond);
      if (stmt.post !== null) checkStmtPurity(stmt.post);
      checkBodyNodePurity(stmt.body);
      return;

    case "RangeStmt":
      checkExprPurity(stmt.x);
      checkBodyNodePurity(stmt.body);
      return;

    case "SwitchStmt":
      if (stmt.init !== null) checkStmtPurity(stmt.init);
      if (stmt.tag !== null) checkExprPurity(stmt.tag);
      for (const c of stmt.cases) {
        for (const e of c.list) checkExprPurity(e);
        checkBodyNodePurity(c.body);
      }
      return;

    // #982: IncDecStmt (i++, i--) is a pure mutation of a local numeric variable.
    // No channel ops, goroutines, or side effects outside the local scope.
    case "IncDecStmt":
      return;

    case "UnsupportedStmt":
      // Unsupported statements will throw during rendering; not a purity issue.
      return;
  }
}

/** Walk all statements in a body node for purity (helper for nested blocks). */
function checkBodyNodePurity(body: GoAstBodyNode): void {
  for (const s of body.stmts) checkStmtPurity(s);
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

/**
 * Allowed binary operators: the subset where Go and TS semantics align.
 *
 * WI-964: >> and << are added.  Both Go and TS use arithmetic right-shift
 * for signed integers (Go: int is signed; TS: >> is signed right-shift).
 * The unsigned right-shift >>> is intentionally excluded — Go has no unsigned
 * right-shift operator and raising a Go uint >> to TS >>> is out of scope.
 */
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
  ">>",
  "<<",
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

    // #986: SliceLit — Go []T{a, b, c} -> TS array literal [a, b, c].
    //
    // @decision DEC-COMPOSITELIT-RAISE-001 (#986)
    // @title Slice literals lower to plain TS array literals; map literals to object literals
    // @status accepted (#986)
    // @rationale
    //   []T{a, b, c} -> [a, b, c] is the natural TS representation and round-trips
    //   back correctly through compile-go's ArrayLiteralExpression handler (which
    //   uses variable-declaration type context to reconstruct the Go element type).
    //   map[K]V{k: v} -> {k: v} as an object literal matches the Record<K,V> type
    //   used for Go maps throughout the IR, and round-trips via ObjectLiteralExpression
    //   handling in compile-go.  Type annotation comments are NOT emitted here because
    //   the variable declaration that receives the literal already carries the Go type
    //   via shave-go's type-map pass; compile-go reads it from the assignment context.
    case "SliceLit": {
      const elems = expr.elements.map((e) => renderExpr(e, file)).join(", ");
      return `[${elems}]`;
    }

    // #986: MapLit — Go map[K]V{k: v} -> TS object literal {k: v}.
    // Non-string keys are rendered via renderExpr (numeric keys become computed
    // property notation via bracket syntax in the object literal).
    case "MapLit": {
      const entries = expr.entries
        .map((entry: GoAstMapEntry) => {
          const keyStr = renderExpr(entry.key, file);
          const valStr = renderExpr(entry.value, file);
          // String literal keys: use bare key (strip quotes for property name).
          // Non-string keys: use computed property [key]: value.
          if (entry.key.type === "BasicLit" && entry.key.kind === "STRING") {
            // Strip Go string delimiters to get the bare property name.
            // e.g. `"foo"` -> `"foo": val` (keep quoted for TS object literal).
            return `${keyStr}: ${valStr}`;
          }
          // Numeric or identifier key: computed property.
          return `[${keyStr}]: ${valStr}`;
        })
        .join(", ");
      return `{${entries}}`;
    }

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

    // WI-964: control-flow renderers.

    case "IfStmt":
      return renderIfStmt(stmt, indent, file);

    case "ForStmt":
      return renderForStmt(stmt, indent, file);

    case "RangeStmt":
      return renderRangeStmt(stmt, indent, file);

    case "SwitchStmt":
      return renderSwitchStmt(stmt, indent, file);

    // #982: IncDecStmt — Go i++/i-- map directly to TS postfix i++/i--.
    // TS supports postfix increment/decrement natively; round-trip is lossless.
    case "IncDecStmt":
      return `${indent}${stmt.target}${stmt.op};`;

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
      if (decl.names.length === 0) {
        throw new GoUnsupportedConstructError("ValueSpec(empty)", { file, ...stmtLoc });
      }
      if (decl.names.length === 1 && decl.values.length === 1) {
        const name = decl.names[0];
        const val = decl.values[0];
        if (name === undefined || val === undefined) {
          throw new GoUnsupportedConstructError("ValueSpec(empty)", { file, ...stmtLoc });
        }
        return `${indent}const ${name} = ${renderExpr(val, file)};`;
      }
      // WI-964: multi-name decl — `var a, b = x, y` splits into sequential consts.
      // Names without a matching value get `undefined` (zero-value initializer
      // is not in scope for the pure-function subset; uninitialized vars are rare).
      if (decl.names.length !== decl.values.length) {
        throw new GoUnsupportedConstructError(
          `ValueSpec(names=${decl.names.length},values=${decl.values.length})`,
          { file, ...stmtLoc },
        );
      }
      return decl.names
        .map((name, i) => {
          const val = decl.values[i];
          if (val === undefined) {
            throw new GoUnsupportedConstructError("ValueSpec(empty-value)", { file, ...stmtLoc });
          }
          return `${indent}const ${name} = ${renderExpr(val, file)};`;
        })
        .join("\n");
    }
    case "UnsupportedDecl":
      throw new GoUnsupportedConstructError(decl.reason, { file, ...stmtLoc });
  }
}

// ---------------------------------------------------------------------------
// WI-964: control-flow rendering helpers
// ---------------------------------------------------------------------------

/**
 * Render an IfStmt to TS if/else if/else.
 *
 * If the IfStmt has an `init` statement (e.g. `if x := f(); x > 0 { ... }`),
 * the init is emitted as a preceding const declaration in the same block scope,
 * separated from the if by a newline at the same indent.
 */
function renderIfStmt(stmt: GoAstIfStmt, indent: string, file: string): string {
  const childIndent = `${indent}  `;
  const parts: string[] = [];

  // Emit optional init statement before the if header.
  if (stmt.init !== null) {
    parts.push(renderStmt(stmt.init, indent, file));
  }

  const condStr = renderExpr(stmt.cond, file);
  const bodyLines = renderBodyLines(stmt.body, childIndent, file);

  parts.push(`${indent}if (${condStr}) {`);
  parts.push(bodyLines);
  parts.push(`${indent}}`);

  // Handle else / else-if chain.
  if (stmt.orelse !== null) {
    // Remove the closing brace we just added — we'll attach "else" to it.
    parts.pop();
    if (stmt.orelse.type === "IfStmt") {
      // else-if: render the nested IfStmt and attach it to the else.
      const elseIfText = renderIfStmt(stmt.orelse, indent, file);
      // elseIfText starts with optional init lines followed by "indent if (..."
      // We want "} else if ..." so we strip the leading indent from the first "if"
      // token of the nested block.
      const elseIfTrimmed = elseIfText.trimStart();
      parts.push(`${indent}} else ${elseIfTrimmed}`);
    } else {
      // Plain else block (BlockNode).
      const elseBody = renderBodyLines((stmt.orelse as GoAstElseBody).body, childIndent, file);
      parts.push(`${indent}} else {`);
      parts.push(elseBody);
      parts.push(`${indent}}`);
    }
  }

  return parts.join("\n");
}

/**
 * Render body statements as lines (without the surrounding braces).
 * Returns the placeholder `${indent}void 0;` for an empty body.
 */
function renderBodyLines(body: GoAstBodyNode, indent: string, file: string): string {
  if (body.stmts.length === 0) {
    return `${indent}void 0;`;
  }
  return body.stmts.map((s) => renderStmt(s, indent, file)).join("\n");
}

/**
 * Render a classic C-style for loop to TS.
 *
 * Go:   for i := 0; i < n; i++ { body }
 * TS:   for (let i = 0; i < n; i++) { body }
 *
 * The init `const` becomes `let` (the loop variable is mutated by post).
 * The post statement is rendered without its trailing semicolon because the
 * for(...) header already provides the enclosing parentheses.
 */
function renderForStmt(stmt: GoAstForStmt, indent: string, file: string): string {
  const childIndent = `${indent}  `;

  const initStr = stmt.init !== null ? renderForInit(stmt.init, file) : "";
  const condStr = stmt.cond !== null ? renderExpr(stmt.cond, file) : "";
  const postStr = stmt.post !== null ? renderForPost(stmt.post, file) : "";

  const bodyLines = renderBodyLines(stmt.body, childIndent, file);
  return [`${indent}for (${initStr}; ${condStr}; ${postStr}) {`, bodyLines, `${indent}}`].join(
    "\n",
  );
}

/**
 * Render the init part of a for(...) header.
 * `:=` becomes `let` (not `const`) because the for-post mutates the variable.
 * `=` stays as a bare assignment.
 */
function renderForInit(stmt: GoAstStmt, file: string): string {
  if (stmt.type === "AssignStmt" && stmt.lhs.length === 1 && stmt.rhs.length === 1) {
    const lhsNode = stmt.lhs[0];
    const rhsNode = stmt.rhs[0];
    if (lhsNode !== undefined && rhsNode !== undefined) {
      const lhsStr = renderExpr(lhsNode, file);
      const rhsStr = renderExpr(rhsNode, file);
      if (stmt.tok === ":=") {
        return `let ${lhsStr} = ${rhsStr}`;
      }
      return `${lhsStr} = ${rhsStr}`;
    }
  }
  if (stmt.type === "DeclStmt") {
    return renderDeclStmt(stmt.decl, "", file, { line: stmt.line, col: stmt.col });
  }
  // Fallback: strip trailing semicolon from normal statement render.
  return renderStmt(stmt, "", file).replace(/;$/, "");
}

/**
 * Render the post part of a for(...) header (no trailing semicolon).
 * Handles the common `i++` / `i--` (`IncDecStmt`) and `i += 1` (`AssignStmt`).
 */
function renderForPost(stmt: GoAstStmt, file: string): string {
  // Go i++ is an ExprStmt wrapping a UnaryExpr increment?  No — Go i++ is an
  // *ast.IncDecStmt which the Go parser emits as an ExprStmt with the raw
  // source text.  In practice go-ast-parse.go emits IncDecStmt as UnsupportedStmt
  // because it is not listed, so we handle the common case via a fallback:
  // strip trailing semicolon from the normal render.
  return renderStmt(stmt, "", file).replace(/;$/, "");
}

/**
 * Render a range loop to TS, preserving Go range semantics for round-trip fidelity.
 *
 * @decision DEC-POLYGLOT-GO-RANGE-ROUNDTRIP-001 (#975)
 * @title Key-only range uses TS for...in to enable precise Go round-trip
 * @status accepted (#975)
 * @rationale
 *   The prior implementation emitted `for (const k of Object.keys(x))` for
 *   key-only range. compile-go's lowerForOf would then emit `for _, k := range x`
 *   (adding a spurious blank `_` prefix), corrupting the round-trip and producing
 *   non-building Go output.
 *
 *   TS `for...in` (ForInStatement) is the natural semantic match for Go's key-only
 *   range: both iterate over the keys of a collection. compile-go detects the
 *   ForInStatement SyntaxKind and emits `for k := range x` without the `_` prefix.
 *   This is a distinct AST node from ForOfStatement, enabling precise lowering.
 *
 *   Key+value range continues to use `for (const [k, v] of Object.entries(x))`.
 *   compile-go detects the Object.entries() callee pattern in lowerForOf to emit
 *   `for k, v := range x` (preserving both bindings).
 *
 *   Value-only range (blank key `_`) uses `for (const v of Object.values(x))` and
 *   compile-go emits `for _, v := range x`.
 *
 * Go:   for k, v := range m { body }
 * TS:   for (const [k, v] of Object.entries(m)) { body }
 *
 * If only the key is present:
 * Go:   for k := range m { body }
 * TS:   for (const k in m) { body }         ← ForInStatement, not ForOfStatement
 *
 * If only the value (key is blank):
 * Go:   for _, v := range m { body }
 * TS:   for (const v of Object.values(m)) { body }
 *
 * The `for...of`/`for...in` forms (not forEach) are chosen because they correctly
 * propagate `return` statements from the outer function — forEach would trap them
 * inside the callback and silently change semantics.
 */
function renderRangeStmt(stmt: GoAstRangeStmt, indent: string, file: string): string {
  const childIndent = `${indent}  `;
  const xStr = renderExpr(stmt.x, file);
  const bodyLines = renderBodyLines(stmt.body, childIndent, file);

  let header: string;
  if (stmt.key !== null && stmt.value !== null) {
    // key+value: for (const [k, v] of Object.entries(x))
    header = `for (const [${stmt.key}, ${stmt.value}] of Object.entries(${xStr}))`;
  } else if (stmt.key !== null) {
    // key-only: for (const k in x) — ForInStatement, round-trips precisely to Go
    header = `for (const ${stmt.key} in ${xStr})`;
  } else if (stmt.value !== null) {
    // value-only (blank key): for (const v of Object.values(x))
    header = `for (const ${stmt.value} of Object.values(${xStr}))`;
  } else {
    // Both key and value are blank — iterate for side effects only.
    header = `for (const _entry of Object.values(${xStr}))`;
  }

  return [`${indent}${header} {`, bodyLines, `${indent}}`].join("\n");
}

/**
 * Render a switch statement to TS.
 *
 * Go:   switch x { case 1, 2: stmts case 3: stmts default: stmts }
 * TS:   switch (x) { case 1: case 2: stmts; break; case 3: stmts; break; default: stmts; break; }
 *
 * Tagless Go switch (`switch { case x > 0: ... }`) lowers to `switch (true) { ... }`.
 * Each case gets an explicit `break` because Go does NOT fall through by default
 * (the opposite convention from JS/TS).
 */
function renderSwitchStmt(stmt: GoAstSwitchStmt, indent: string, file: string): string {
  const childIndent = `${indent}  `;
  const bodyIndent = `${childIndent}  `;
  const tagStr = stmt.tag !== null ? renderExpr(stmt.tag, file) : "true";

  const caseLines = stmt.cases.map((c) => renderCaseClause(c, childIndent, bodyIndent, file));

  return [`${indent}switch (${tagStr}) {`, ...caseLines, `${indent}}`].join("\n");
}

/** Render one case clause inside a switch. */
function renderCaseClause(
  c: GoAstCaseClause,
  indent: string,
  bodyIndent: string,
  file: string,
): string {
  const lines: string[] = [];
  if (c.list.length === 0) {
    // default clause
    lines.push(`${indent}default:`);
  } else {
    for (const e of c.list) {
      lines.push(`${indent}case ${renderExpr(e, file)}:`);
    }
  }
  const bodyLines = renderBodyLines(c.body, bodyIndent, file);
  lines.push(bodyLines);
  lines.push(`${bodyIndent}break;`);
  return lines.join("\n");
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
