// SPDX-License-Identifier: MIT
/**
 * Lower TS-subset IR source to idiomatic Go source.
 *
 * Entry point: lowerSource(implSource) -> LowerResult
 * Consumers call compileToGo() (compile-go.ts) which wraps lowerSource.
 *
 * @decision DEC-WI973-001
 * @title IR->Go lowering uses ts-morph AST walk; all emitted constructs from MVP table
 * @status accepted (WI-973)
 * @rationale
 *   ts-morph gives exact typed AST nodes identical to those the strict-subset
 *   validator already accepts, so we inherit the validator's guarantees: only
 *   pure-function constructs, no async, no DOM, no eval. The emitter therefore
 *   does not need to defensively guard against constructs the validator already
 *   blocks at shave-time.
 *
 *   Go MVP mapping table (DEC-WI973-001):
 *     Types:  number -> int | float64, string -> string, boolean -> bool,
 *             T[] -> []T, Record<K,V> -> map[K]V, void -> (no return),
 *             any/unknown -> interface{}, generic T -> [T any] constraint
 *     Stmts:  return, if/else, const/let/var -> :=, ExpressionStatement,
 *             switch/case/default (implicit break), for/for-of/while,
 *             for-in -> range (key-only, #975), for-of Object.entries -> range (#975)
 *     Exprs:  numeric literal, string literal, bool literal, identifier,
 *             BinaryExpr, PrefixUnary (!/-), Call, PropertyAccess (len),
 *             ElementAccess
 *     Fn:     export function name<T extends Ordered,R>(p T, q int): R
 *             -> func Name[T constraints.Ordered, R any](p T, q int) R (#976)
 *
 *   Everything else -> CannotLowerToGoError (loud failure, DEC-WI973-003).
 *
 * @decision DEC-WI973-003
 * @title IR->Go lowering throws CannotLowerToGoError on all unhandled nodes; no silent fallbacks
 * @status accepted (WI-973)
 * @rationale
 *   Mirrors DEC-COMPILE-PYTHON-LOUD-001 (WI-943). Silent fallbacks allowed raw TS
 *   syntax to appear verbatim in Python output. CannotLowerToGoError surfaces coverage
 *   gaps immediately instead of letting TS syntax leak into Go output.
 *
 * @decision DEC-WI977-001
 * @title Import synthesis: table-driven package-name -> import-path resolution; unknown -> placeholder
 * @status accepted (WI-977)
 * @rationale
 *   Dotted-identifier references (pkg.Symbol) in the lowered output require a
 *   corresponding import block for the Go file to compile. A table mapping well-known
 *   package names to their canonical import paths covers stdlib and common golang.org/x/*
 *   packages without requiring shave-go to carry import metadata through the IR.
 *   Unknown packages emit a "unknown/<pkg>" placeholder import + GoLowerWarning so the
 *   user can identify and fix missing paths manually (less disruptive than hard rejection).
 *
 * @decision DEC-WI978-001
 * @title SwitchStatement lowering: implicit-break removal; TS-fallthrough merging into Go multi-value cases
 * @status accepted (WI-978)
 * @rationale
 *   Go switch has implicit break unlike TS/JS. TS empty fallthrough cases (case a: case b: body)
 *   map naturally to Go multi-value cases (case a, b: body). We collect consecutive
 *   empty cases then emit them as a single "case a, b, c:" header. The last case in
 *   a group is the one with a non-empty body; its body statements are lowered normally.
 *   Explicit TS `break` statements inside case bodies are dropped since Go does not
 *   need them. `default:` passes through unchanged.
 *
 * @decision DEC-POLYGLOT-GO-RANGE-ROUNDTRIP-001 (#975)
 * @title for...in (ForInStatement) lowered to Go key-only range; Object.entries() to key+value range
 * @status accepted (#975)
 * @rationale
 *   shave-go emits key-only range as TS `for (const k in x)` (ForInStatement) and
 *   key+value range as `for (const [k, v] of Object.entries(x))` (ForOfStatement).
 *   This lowerer detects both patterns precisely at the ts-morph AST level — no
 *   text-pattern matching needed — and emits the correct Go range form in each case.
 *   Prior to #975, key-only range was emitted as `for (const k of Object.keys(x))`
 *   which lowerForOf treated as `for _, k := range x` (adding spurious `_` blank).
 *
 * @decision DEC-POLYGLOT-GO-CONSTRAINT-ROUNDTRIP-001 (#976)
 * @title TS `extends Constraint` in type params is reverse-mapped to Go constraint syntax
 * @status accepted (#976)
 * @rationale
 *   shave-go emits `<T extends Ordered>` for `[T constraints.Ordered]` in Go.
 *   This lowerer reads the ts-morph TypeParameter's constraint node and reverse-maps
 *   the TS name back to the canonical Go constraint string using TS_CONSTRAINT_TO_GO.
 *   `GoConstraint_*` prefix names carry encoded tilde type-sets; others are custom
 *   interfaces passed through verbatim. The prior code emitted `[T any]` for every
 *   type parameter regardless of constraint, causing functions that use `<` or `>`
 *   on `T` to fail compilation in Go.
 */

import { CannotLowerToGoError } from "@yakcc/contracts";
import {
  type ForOfStatement,
  type FunctionDeclaration,
  type FunctionTypeNode,
  Node,
  Project,
  SyntaxKind,
  type TypeNode,
  type TypeParameterDeclaration,
} from "ts-morph";
import { toGoExportedName, toGoLocalName } from "./names.js";

// ---------------------------------------------------------------------------
// Constraint back-mapping table (#976, DEC-POLYGLOT-GO-CONSTRAINT-ROUNDTRIP-001)
//
// Maps the TS `extends X` name emitted by shave-go back to the canonical Go
// constraint string.  This is the exact inverse of GO_CONSTRAINT_TO_TS in
// packages/shave-go/src/raise-function.ts — both tables must stay in sync.
//
// Key:   TS extends name (what appears after `extends` in the IR)
// Value: Go constraint string (what to emit between [ and ] in the type param list)
// ---------------------------------------------------------------------------

const TS_CONSTRAINT_TO_GO: Readonly<Record<string, string>> = {
  Ordered: "constraints.Ordered", // golang.org/x/exp/constraints.Ordered
  Comparable: "comparable", // Go built-in comparable interface
};

/**
 * Reverse-map a TS `extends` constraint name to a Go constraint string.
 *
 * Handles:
 *   - Well-known mapped names ("Ordered" -> "constraints.Ordered")
 *   - GoConstraint_Tilde_SliceOf_T prefix (tilde type-sets)
 *   - Custom interface names (pass-through verbatim)
 *   - Empty string / undefined (maps to "any")
 */
function tsConstraintToGo(tsConstraint: string | undefined): string {
  if (!tsConstraint || tsConstraint === "") return "any";

  // Well-known table lookup
  const mapped = TS_CONSTRAINT_TO_GO[tsConstraint];
  if (mapped !== undefined) return mapped;

  // GoConstraint_Tilde_SliceOf_T -> ~[]T (decode the encoding from raise-function.ts)
  if (tsConstraint.startsWith("GoConstraint_Tilde_SliceOf_")) {
    const typeArg = tsConstraint.slice("GoConstraint_Tilde_SliceOf_".length);
    return `~[]${typeArg}`;
  }
  if (tsConstraint.startsWith("GoConstraint_Tilde_")) {
    const rest = tsConstraint.slice("GoConstraint_Tilde_".length);
    return `~${rest}`;
  }
  if (tsConstraint.startsWith("GoConstraint_")) {
    // Unknown GoConstraint_ encoding: strip prefix and pass through
    return tsConstraint.slice("GoConstraint_".length);
  }

  // Custom interface or unknown: pass through verbatim
  return tsConstraint;
}

/**
 * Mapping from canonical Go constraint string to the bare package name that
 * must be added to ctx.importRefs for KNOWN_IMPORT_PATHS resolution.
 * Only constraints that require a non-stdlib import are listed here.
 */
const CONSTRAINT_IMPORT_PKG: Readonly<Record<string, string>> = {
  "constraints.Ordered": "constraints",
};

/**
 * Record any package references needed for constraint import synthesis.
 * e.g. `constraints.Ordered` requires `import "golang.org/x/exp/constraints"`.
 * The package name is added to ctx.importRefs; lowerSource resolves it via
 * KNOWN_IMPORT_PATHS (which includes `constraints` -> `golang.org/x/exp/constraints`).
 */
function recordConstraintImport(goConstraint: string, ctx: Ctx): void {
  const pkg = CONSTRAINT_IMPORT_PKG[goConstraint];
  if (pkg) {
    ctx.importRefs.add(pkg);
  }
}

// ---------------------------------------------------------------------------
// Import path resolution table (WI-977, DEC-WI977-001)
//
// Maps the bare Go package name (as used in dotted expressions like pkg.Sym)
// to the canonical import path that must appear in the import block.
// stdlib packages whose path equals their name are included explicitly
// so the table is the single source of truth.
// ---------------------------------------------------------------------------

const KNOWN_IMPORT_PATHS: Readonly<Record<string, string>> = {
  // stdlib
  fmt: "fmt",
  strings: "strings",
  strconv: "strconv",
  sort: "sort",
  slices: "slices",
  maps: "maps",
  errors: "errors",
  reflect: "reflect",
  time: "time",
  context: "context",
  io: "io",
  os: "os",
  bytes: "bytes",
  bufio: "bufio",
  sync: "sync",
  regexp: "regexp",
  math: "math",
  unicode: "unicode",
  utf8: "unicode/utf8",
  json: "encoding/json",
  // golang.org/x/text
  cases: "golang.org/x/text/cases",
  language: "golang.org/x/text/language",
  // golang.org/x/exp/constraints (#976 — constraint round-trip)
  constraints: "golang.org/x/exp/constraints",
};

// ---------------------------------------------------------------------------
// Internal context
// ---------------------------------------------------------------------------

interface Ctx {
  warnings: GoLowerWarning[];
  /** type params declared on the current function (e.g. ["T", "R"]) */
  typeParams: string[];
  /** Name of the function being lowered, for error messages.
   *  Optional — not set at top level, only set by lowerFunctionDecl.
   */
  fnName?: string | undefined;
  /**
   * Set of bare package names seen in dotted-identifier expressions
   * (e.g. "reflect" from reflect.ValueOf, "cases" from cases.Title).
   * Populated during the lowering walk; used by lowerSource to synthesize
   * the import block (WI-977, DEC-WI977-001).
   */
  importRefs: Set<string>;
  /**
   * Go type hint propagated from the surrounding variable declaration.
   * Set by lowerVarStatement when a TypeNode is present (e.g. `const x: number[] = [1, 2]`
   * or inferred from the declared type in `const x: Record<string, number> = {}`).
   * Consumed by lowerArrayLiteral and lowerObjectLiteral (#986) to emit the correct
   * Go element/key/value types instead of falling back to `interface{}`.
   *
   * This field is transient: it is set immediately before lowering the initializer
   * expression and cleared after.  It MUST NOT be used outside expression lowering.
   */
  goTypeHint?: string | undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GoLowerWarning {
  readonly kind: string;
  readonly message: string;
}

export interface LowerResult {
  goLines: string[];
  warnings: GoLowerWarning[];
  /**
   * Resolved import paths collected during the lowering walk.
   * Each entry is a canonical Go import path (e.g. "reflect",
   * "golang.org/x/text/cases") ready for inclusion in an import block.
   * Callers (compile-go.ts) are responsible for synthesizing the actual
   * import statement from this set (WI-977, DEC-WI977-001).
   */
  importPaths: Set<string>;
}

/**
 * Lower a TS-subset IR source string to Go lines.
 * Returned goLines do NOT include a package declaration; callers prepend
 * `package <name>` when assembling a full .go file.
 */
export function lowerSource(implSource: string): LowerResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      target: 99,
      module: 99,
      skipLibCheck: true,
    },
  });
  const sf = project.createSourceFile("impl.ts", implSource);

  const ctx: Ctx = { warnings: [], typeParams: [], importRefs: new Set() };
  const goLines: string[] = [];

  for (const stmt of sf.getStatements()) {
    if (Node.isFunctionDeclaration(stmt)) {
      const fnLines = lowerFunctionDecl(stmt, ctx);
      goLines.push(...fnLines);
      goLines.push("");
    }
    // type aliases, import declarations, and comments are silently skipped
  }

  // Resolve collected package references to canonical import paths (WI-977)
  const importPaths = new Set<string>();
  for (const pkg of ctx.importRefs) {
    const resolved = KNOWN_IMPORT_PATHS[pkg];
    if (resolved !== undefined) {
      importPaths.add(resolved);
    } else {
      const placeholder = `unknown/${pkg}`;
      importPaths.add(placeholder);
      ctx.warnings.push({
        kind: "unknown-import",
        message: `Unknown package "${pkg}" — using placeholder import path "${placeholder}". Update manually.`,
      });
    }
  }

  return { goLines, warnings: ctx.warnings, importPaths };
}

// ---------------------------------------------------------------------------
// Location helper
// ---------------------------------------------------------------------------

function nodeLocation(node: Node): { line: number; column: number } {
  return node.getSourceFile().getLineAndColumnAtPos(node.getStart());
}

// ---------------------------------------------------------------------------
// Function declaration
// ---------------------------------------------------------------------------

/**
 * Lower a TS function declaration to a Go func declaration.
 *
 * TS:  export function add<T>(a: T, b: number): T { ... }
 * Go:  func Add[T any](a T, b int) T { ... }
 */
function lowerFunctionDecl(fn: FunctionDeclaration, ctx: Ctx): string[] {
  const name = fn.getName() ?? "unknown";
  const goName = toGoExportedName(name);

  // Capture type params for this function
  const tpNodes = fn.getTypeParameters();
  const typeParams = tpNodes.map((tp) => tp.getName());
  ctx.typeParams = typeParams;
  ctx.fnName = name;

  // Build type constraint suffix: [T constraints.Ordered, R any] etc.
  // #976: read the `extends` constraint from each TypeParameter node and
  // reverse-map to the Go constraint string.
  const typeParamStr =
    typeParams.length > 0 ? `[${tpNodes.map((tp) => lowerTypeParam(tp, ctx)).join(", ")}]` : "";

  // Parameters: (p1 T, p2 int)
  const params = fn.getParameters().map((p) => {
    const paramName = toGoLocalName(p.getName());
    const typeNode = p.getTypeNode();
    const goType = typeNode ? lowerTypeNode(typeNode, ctx) : "interface{}";
    return `${paramName} ${goType}`;
  });

  // Return type
  const returnTypeNode = fn.getReturnTypeNode();
  const returnType = returnTypeNode ? lowerTypeNode(returnTypeNode, ctx) : "";
  const returnSuffix = returnType && returnType !== "" ? ` ${returnType}` : "";

  const sig = `func ${goName}${typeParamStr}(${params.join(", ")})${returnSuffix} {`;
  const lines: string[] = [sig];

  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) {
    lines.push("}");
    return lines;
  }

  const bodyLines = lowerBlock(body.getStatements(), ctx, 1);
  lines.push(...bodyLines);
  lines.push("}");
  return lines;
}

// ---------------------------------------------------------------------------
// Type parameter lowering (#976, DEC-POLYGLOT-GO-CONSTRAINT-ROUNDTRIP-001)
// ---------------------------------------------------------------------------

/**
 * Lower a single TS TypeParameter to its Go `Name Constraint` form.
 *
 * Reads the `extends` clause (if any) from the TypeParameter node via ts-morph,
 * reverse-maps the TS constraint name to the canonical Go constraint string,
 * records any required import (e.g. `constraints`), and returns the Go fragment.
 *
 * Examples:
 *   T (no extends)           -> "T any"
 *   T extends Ordered        -> "T constraints.Ordered"
 *   T extends Comparable     -> "T comparable"
 *   T extends MyInterface    -> "T MyInterface"
 *   T extends GoConstraint_Tilde_SliceOf_T -> "T ~[]T"
 */
function lowerTypeParam(tp: TypeParameterDeclaration, ctx: Ctx): string {
  const name = tp.getName();
  const constraintNode = tp.getConstraint();
  const tsConstraint = constraintNode?.getText() ?? "";
  const goConstraint = tsConstraintToGo(tsConstraint);

  // Record import for well-known constraint packages
  recordConstraintImport(goConstraint, ctx);

  return `${name} ${goConstraint}`;
}

// ---------------------------------------------------------------------------
// Statement lowering
// ---------------------------------------------------------------------------

const TAB = "\t";

function indent(depth: number): string {
  return TAB.repeat(depth);
}

function lowerBlock(stmts: Node[], ctx: Ctx, depth: number): string[] {
  const lines: string[] = [];
  for (const stmt of stmts) {
    lines.push(...lowerStatement(stmt, ctx, depth));
  }
  return lines;
}

function lowerStatement(node: Node, ctx: Ctx, depth: number): string[] {
  const ind = indent(depth);
  const k = node.getKind();

  if (k === SyntaxKind.ReturnStatement) {
    const rs = node.asKindOrThrow(SyntaxKind.ReturnStatement);
    const expr = rs.getExpression();
    return expr ? [`${ind}return ${lowerExpr(expr, ctx)}`] : [`${ind}return`];
  }

  if (k === SyntaxKind.IfStatement) {
    return lowerIf(node, ctx, depth);
  }

  if (k === SyntaxKind.VariableStatement) {
    return lowerVarStatement(node, ctx, depth);
  }

  if (k === SyntaxKind.ExpressionStatement) {
    const es = node.asKindOrThrow(SyntaxKind.ExpressionStatement);
    return [`${ind}${lowerExpr(es.getExpression(), ctx)}`];
  }

  if (k === SyntaxKind.ForOfStatement) {
    return lowerForOf(node, ctx, depth);
  }

  if (k === SyntaxKind.ForInStatement) {
    return lowerForIn(node, ctx, depth);
  }

  if (k === SyntaxKind.ForStatement) {
    return lowerFor(node, ctx, depth);
  }

  if (k === SyntaxKind.WhileStatement) {
    return lowerWhile(node, ctx, depth);
  }

  if (k === SyntaxKind.Block) {
    const b = node.asKindOrThrow(SyntaxKind.Block);
    return lowerBlock(b.getStatements(), ctx, depth);
  }

  if (k === SyntaxKind.SwitchStatement) {
    return lowerSwitch(node, ctx, depth);
  }

  // Go has implicit break — TS break inside a switch case body is dropped (WI-978)
  if (k === SyntaxKind.BreakStatement) return [];
  if (k === SyntaxKind.ContinueStatement) return [`${ind}continue`];

  // Skip: type alias, interface, import
  if (
    k === SyntaxKind.TypeAliasDeclaration ||
    k === SyntaxKind.InterfaceDeclaration ||
    k === SyntaxKind.ImportDeclaration
  ) {
    return [];
  }

  // Loud failure: any unhandled statement kind
  const snippet = node.getText().slice(0, 60).replace(/\n/g, " ");
  throw new CannotLowerToGoError(SyntaxKind[k], nodeLocation(node), snippet, ctx.fnName);
}

// ---------------------------------------------------------------------------
// Variable statement: const/let/var x = expr -> x := expr
// ---------------------------------------------------------------------------

function lowerVarStatement(node: Node, ctx: Ctx, depth: number): string[] {
  const ind = indent(depth);
  const vs = node.asKindOrThrow(SyntaxKind.VariableStatement);
  const lines: string[] = [];
  for (const vd of vs.getDeclarationList().getDeclarations()) {
    const varName = toGoLocalName(vd.getName());
    const init = vd.getInitializer();
    if (init) {
      // #986: propagate the declared Go type as a hint for array/object literal lowering.
      // e.g. `const xs: number[] = []` -> hint="[]int" -> lowerArrayLiteral emits `[]int{}`
      // The hint is cleared after lowering the initializer (transient, see Ctx.goTypeHint).
      const typeNode = vd.getTypeNode();
      if (typeNode) {
        ctx.goTypeHint = lowerTypeNode(typeNode, ctx);
      }
      const initStr = lowerExpr(init, ctx);
      ctx.goTypeHint = undefined;
      lines.push(`${ind}${varName} := ${initStr}`);
    } else {
      // uninitialized var: emit var x T (requires type annotation)
      const typeNode = vd.getTypeNode();
      const goType = typeNode ? lowerTypeNode(typeNode, ctx) : "interface{}";
      lines.push(`${ind}var ${varName} ${goType}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// If statement
// ---------------------------------------------------------------------------

function lowerIf(node: Node, ctx: Ctx, depth: number): string[] {
  const ifNode = node.asKindOrThrow(SyntaxKind.IfStatement);
  const cond = lowerExpr(ifNode.getExpression(), ctx);
  const ind = indent(depth);
  const lines: string[] = [`${ind}if ${cond} {`];

  const then = ifNode.getThenStatement();
  if (Node.isBlock(then)) {
    lines.push(...lowerBlock(then.getStatements(), ctx, depth + 1));
  } else {
    lines.push(...lowerStatement(then, ctx, depth + 1));
  }

  const elseStmt = ifNode.getElseStatement();
  if (elseStmt) {
    if (elseStmt.getKind() === SyntaxKind.IfStatement) {
      // else if: emit `} else if cond {`
      const innerLines = lowerIf(elseStmt, ctx, depth);
      if (innerLines.length > 0) {
        // Replace the leading indent+`if` with `} else if`
        const first = innerLines[0] ?? "";
        const trimmed = first.trimStart();
        innerLines[0] = `${ind}} else ${trimmed}`;
        lines.push(...innerLines);
        // Note: lowerIf already ends with `}`, don't add another
        return lines;
      }
    } else {
      lines.push(`${ind}} else {`);
      if (Node.isBlock(elseStmt)) {
        lines.push(...lowerBlock(elseStmt.getStatements(), ctx, depth + 1));
      } else {
        lines.push(...lowerStatement(elseStmt, ctx, depth + 1));
      }
    }
  }

  lines.push(`${ind}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// For-of: for (const x of xs) -> for _, x := range xs { ... }
//         for (const [k, v] of Object.entries(xs)) -> for k, v := range xs { ... }  (#975)
// ---------------------------------------------------------------------------

/**
 * Detect whether a ts-morph Node is a call to `Object.entries(expr)`.
 * Returns the inner iterable expression text if matched, or null.
 *
 * @decision DEC-POLYGLOT-GO-RANGE-ROUNDTRIP-001 (#975)
 * @title Object.entries() callee pattern detection enables key+value range round-trip
 * @status accepted (#975)
 * @rationale
 *   shave-go emits `for (const [k, v] of Object.entries(x))` for Go's key+value range.
 *   We detect the `Object.entries` callee at the AST level (not via text matching)
 *   so we can emit `for k, v := range x` preserving both bindings.
 *   Similarly, `Object.values(x)` is detected for value-only range -> `for _, v := range x`.
 *   The ForOfStatement without these patterns falls back to the general `for _, v := range`.
 */
/** General for-of fallback: for (const x of xs) -> for _, x := range xs */
function lowerForOfGeneral(fo: ForOfStatement, initDecl: Node, ctx: Ctx, depth: number): string[] {
  const ind = indent(depth);
  let varName = "item";
  if (Node.isVariableDeclarationList(initDecl)) {
    const decls = initDecl.getDeclarations();
    const first = decls[0];
    if (first) varName = toGoLocalName(first.getName());
  }
  const iterable = lowerExpr(fo.getExpression(), ctx);
  const lines: string[] = [`${ind}for _, ${varName} := range ${iterable} {`];
  const body = fo.getStatement();
  if (Node.isBlock(body)) {
    lines.push(...lowerBlock(body.getStatements(), ctx, depth + 1));
  } else {
    lines.push(...lowerStatement(body, ctx, depth + 1));
  }
  lines.push(`${ind}}`);
  return lines;
}

function detectObjectMethod(expr: Node, method: "entries" | "values"): string | null {
  if (expr.getKind() !== SyntaxKind.CallExpression) return null;
  const ce = expr.asKindOrThrow(SyntaxKind.CallExpression);
  const callee = ce.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  if (pa.getName() !== method) return null;
  const obj = pa.getExpression();
  if (obj.getKind() !== SyntaxKind.Identifier) return null;
  if (obj.getText() !== "Object") return null;
  const args = ce.getArguments();
  if (args.length !== 1 || !args[0]) return null;
  return lowerExprText(args[0], {} as Ctx); // get raw text of the iterable
}

/**
 * Get the Go expression text for a Node — thin wrapper used only for iterable
 * extraction where ctx doesn't matter (identifier or dotted path).
 */
function lowerExprText(node: Node, ctx: Ctx): string {
  return lowerExpr(node, ctx);
}

function lowerForOf(node: Node, ctx: Ctx, depth: number): string[] {
  const fo = node.asKindOrThrow(SyntaxKind.ForOfStatement);
  const initDecl = fo.getInitializer();
  const ind = indent(depth);
  const iterExpr = fo.getExpression();

  // Detect Object.entries(x) -> for k, v := range x
  const entriesIterable = detectObjectMethod(iterExpr, "entries");
  if (entriesIterable !== null) {
    // Initializer must be a destructuring: const [k, v]
    let keyName = "_";
    let valName = "_";
    if (Node.isVariableDeclarationList(initDecl)) {
      const decls = initDecl.getDeclarations();
      const first = decls[0];
      if (first) {
        // The binding is an ArrayBindingPattern: [k, v]
        const nameNode = first.getNameNode();
        if (nameNode.getKind() === SyntaxKind.ArrayBindingPattern) {
          const abp = nameNode.asKindOrThrow(SyntaxKind.ArrayBindingPattern);
          const elements = abp.getElements();
          const k = elements[0];
          const v = elements[1];
          if (k && k.getKind() === SyntaxKind.BindingElement) {
            keyName = toGoLocalName(k.asKindOrThrow(SyntaxKind.BindingElement).getName());
          }
          if (v && v.getKind() === SyntaxKind.BindingElement) {
            valName = toGoLocalName(v.asKindOrThrow(SyntaxKind.BindingElement).getName());
          }
        } else {
          // Fallback: treat as value name
          valName = toGoLocalName(first.getName());
        }
      }
    }
    const entriesCallArgs = iterExpr.asKindOrThrow(SyntaxKind.CallExpression).getArguments();
    const entriesArg = entriesCallArgs[0];
    if (!entriesArg) return lowerForOfGeneral(fo, initDecl, ctx, depth); // unreachable: detectObjectMethod checked
    const iterableStr = lowerExpr(entriesArg, ctx);
    const lines: string[] = [`${ind}for ${keyName}, ${valName} := range ${iterableStr} {`];
    const body = fo.getStatement();
    if (Node.isBlock(body)) {
      lines.push(...lowerBlock(body.getStatements(), ctx, depth + 1));
    } else {
      lines.push(...lowerStatement(body, ctx, depth + 1));
    }
    lines.push(`${ind}}`);
    return lines;
  }

  // Detect Object.values(x) -> for _, v := range x
  const valuesIterable = detectObjectMethod(iterExpr, "values");
  if (valuesIterable !== null) {
    let varName = "v";
    if (Node.isVariableDeclarationList(initDecl)) {
      const decls = initDecl.getDeclarations();
      const first = decls[0];
      if (first) varName = toGoLocalName(first.getName());
    }
    const valuesCallArgs = iterExpr.asKindOrThrow(SyntaxKind.CallExpression).getArguments();
    const valuesArg = valuesCallArgs[0];
    if (!valuesArg) return lowerForOfGeneral(fo, initDecl, ctx, depth); // unreachable: detectObjectMethod checked
    const iterableStr = lowerExpr(valuesArg, ctx);
    const lines: string[] = [`${ind}for _, ${varName} := range ${iterableStr} {`];
    const body = fo.getStatement();
    if (Node.isBlock(body)) {
      lines.push(...lowerBlock(body.getStatements(), ctx, depth + 1));
    } else {
      lines.push(...lowerStatement(body, ctx, depth + 1));
    }
    lines.push(`${ind}}`);
    return lines;
  }

  // General for-of: for (const x of xs) -> for _, x := range xs
  let varName = "item";
  if (Node.isVariableDeclarationList(initDecl)) {
    const decls = initDecl.getDeclarations();
    const first = decls[0];
    if (first) {
      varName = toGoLocalName(first.getName());
    }
  }

  const iterable = lowerExpr(fo.getExpression(), ctx);
  const lines: string[] = [`${ind}for _, ${varName} := range ${iterable} {`];
  const body = fo.getStatement();
  if (Node.isBlock(body)) {
    lines.push(...lowerBlock(body.getStatements(), ctx, depth + 1));
  } else {
    lines.push(...lowerStatement(body, ctx, depth + 1));
  }
  lines.push(`${ind}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// For-in: for (const k in obj) -> for k := range obj { ... }  (#975)
// ---------------------------------------------------------------------------

/**
 * Lower a TS `for...in` statement to Go key-only range.
 *
 * TS:   for (const k in items) { body }
 * Go:   for k := range items { body }
 *
 * @decision DEC-POLYGLOT-GO-RANGE-ROUNDTRIP-001 (#975)
 * @title ForInStatement lowers to Go key-only range without blank `_` prefix
 * @status accepted (#975)
 * @rationale
 *   shave-go emits key-only range as `for (const k in x)` (TS ForInStatement),
 *   a distinct AST node from ForOfStatement. This handler emits `for k := range x`
 *   precisely matching the original Go source and avoiding the spurious `_` blank
 *   that the prior Object.keys() path introduced.
 */
function lowerForIn(node: Node, ctx: Ctx, depth: number): string[] {
  const fi = node.asKindOrThrow(SyntaxKind.ForInStatement);
  const initDecl = fi.getInitializer();
  const ind = indent(depth);

  let keyName = "k";
  if (Node.isVariableDeclarationList(initDecl)) {
    const decls = initDecl.getDeclarations();
    const first = decls[0];
    if (first) keyName = toGoLocalName(first.getName());
  }

  const iterable = lowerExpr(fi.getExpression(), ctx);
  const lines: string[] = [`${ind}for ${keyName} := range ${iterable} {`];
  const body = fi.getStatement();
  if (Node.isBlock(body)) {
    lines.push(...lowerBlock(body.getStatements(), ctx, depth + 1));
  } else {
    lines.push(...lowerStatement(body, ctx, depth + 1));
  }
  lines.push(`${ind}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// For statement: for (let i = 0; i < n; i++) -> for i := 0; i < n; i++ {
// ---------------------------------------------------------------------------

function lowerFor(node: Node, ctx: Ctx, depth: number): string[] {
  const forNode = node.asKindOrThrow(SyntaxKind.ForStatement);
  const ind = indent(depth);

  // Init clause
  let initStr = "";
  const init = forNode.getInitializer();
  if (init && Node.isVariableDeclarationList(init)) {
    const parts: string[] = [];
    for (const vd of init.getDeclarations()) {
      const varName = toGoLocalName(vd.getName());
      const initExpr = vd.getInitializer();
      parts.push(`${varName} := ${initExpr ? lowerExpr(initExpr, ctx) : "0"}`);
    }
    initStr = parts.join(", ");
  }

  const condNode = forNode.getCondition();
  const condStr = condNode ? lowerExpr(condNode, ctx) : "";
  const incrNode = forNode.getIncrementor();
  const incrStr = incrNode ? lowerExpr(incrNode, ctx) : "";

  const lines: string[] = [`${ind}for ${initStr}; ${condStr}; ${incrStr} {`];
  const body = forNode.getStatement();
  if (Node.isBlock(body)) {
    lines.push(...lowerBlock(body.getStatements(), ctx, depth + 1));
  } else {
    lines.push(...lowerStatement(body, ctx, depth + 1));
  }
  lines.push(`${ind}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// While: while (cond) { ... } -> for cond { ... }
// ---------------------------------------------------------------------------

function lowerWhile(node: Node, ctx: Ctx, depth: number): string[] {
  const ws = node.asKindOrThrow(SyntaxKind.WhileStatement);
  const cond = lowerExpr(ws.getExpression(), ctx);
  const ind = indent(depth);
  const lines: string[] = [`${ind}for ${cond} {`];
  const body = ws.getStatement();
  if (Node.isBlock(body)) {
    lines.push(...lowerBlock(body.getStatements(), ctx, depth + 1));
  } else {
    lines.push(...lowerStatement(body, ctx, depth + 1));
  }
  lines.push(`${ind}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Switch statement (WI-978, DEC-WI978-001)
//
// TS switch  ->  Go switch
//   switch (expr) { ... }  ->  switch expr { ... }
//   switch (true) { ... }  ->  switch { ... }   (tagless)
//
// Case merging for TS fallthrough (adjacent empty cases):
//   case a:
//   case b:
//   case c:
//     body;   ->   case a, b, c:
//                    body
//
// TS break inside case body is silently dropped (Go has implicit break).
// Only 'fallthrough' needs to be explicit in Go, but we don't emit it here
// because the TS pattern we handle is the empty-case fallthrough, not
// intentional fall-through with body.
// ---------------------------------------------------------------------------

function lowerSwitch(node: Node, ctx: Ctx, depth: number): string[] {
  const sw = node.asKindOrThrow(SyntaxKind.SwitchStatement);
  const ind = indent(depth);

  // Tag expression: switch(true) -> tagless; otherwise emit the expression
  const tagExpr = sw.getExpression();
  const isTagless = tagExpr.getKind() === SyntaxKind.TrueKeyword;
  const tagStr = isTagless ? "" : ` ${lowerExpr(tagExpr, ctx)}`;
  const lines: string[] = [`${ind}switch${tagStr} {`];

  const caseBlock = sw.getCaseBlock();
  const clauses = caseBlock.getClauses();

  // Walk clauses, merging consecutive empty-body cases into multi-value heads.
  // A "group" is 1..N case expressions whose accumulated body is the body of
  // the last (non-empty) clause in the run, or the first clause with statements.
  let pendingLabels: string[] = [];

  for (const clause of clauses) {
    if (Node.isDefaultClause(clause)) {
      // Flush any pending labels (shouldn't happen in well-formed TS, but be safe)
      if (pendingLabels.length > 0) {
        lines.push(`${ind}\tcase ${pendingLabels.join(", ")}:`);
        pendingLabels = [];
      }
      lines.push(`${ind}default:`);
      const stmts = clause.getStatements();
      lines.push(...lowerBlock(stmts, ctx, depth + 1));
      continue;
    }

    // CaseClause
    const cc = clause.asKindOrThrow(SyntaxKind.CaseClause);
    const labelExpr = lowerExpr(cc.getExpression(), ctx);
    const stmts = cc.getStatements();

    // Filter out break statements — Go has implicit break (DEC-WI978-001)
    const nonBreakStmts = stmts.filter((s) => s.getKind() !== SyntaxKind.BreakStatement);

    if (nonBreakStmts.length === 0) {
      // Empty case body: accumulate label for multi-value merging
      pendingLabels.push(labelExpr);
    } else {
      // Non-empty body: emit all accumulated labels + this one as the case header
      pendingLabels.push(labelExpr);
      lines.push(`${ind}\tcase ${pendingLabels.join(", ")}:`);
      pendingLabels = [];
      lines.push(...lowerBlock(nonBreakStmts, ctx, depth + 1));
    }
  }

  // Any trailing empty cases with no body (unusual but safe to emit)
  if (pendingLabels.length > 0) {
    lines.push(`${ind}\tcase ${pendingLabels.join(", ")}:`);
  }

  lines.push(`${ind}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Expression lowering
// ---------------------------------------------------------------------------

function lowerExpr(node: Node, ctx: Ctx): string {
  const k = node.getKind();

  if (k === SyntaxKind.NumericLiteral) return node.getText();
  if (k === SyntaxKind.StringLiteral) return node.getText(); // Go uses double-quoted strings
  if (k === SyntaxKind.TrueKeyword) return "true";
  if (k === SyntaxKind.FalseKeyword) return "false";
  if (k === SyntaxKind.NullKeyword || k === SyntaxKind.UndefinedKeyword) return "nil";

  if (k === SyntaxKind.Identifier) {
    return toGoLocalName(node.getText());
  }

  if (k === SyntaxKind.ParenthesizedExpression) {
    const pe = node.asKindOrThrow(SyntaxKind.ParenthesizedExpression);
    return `(${lowerExpr(pe.getExpression(), ctx)})`;
  }

  if (k === SyntaxKind.AsExpression) {
    const ae = node.asKindOrThrow(SyntaxKind.AsExpression);
    return lowerExpr(ae.getExpression(), ctx);
  }

  if (k === SyntaxKind.NonNullExpression) {
    const nne = node.asKindOrThrow(SyntaxKind.NonNullExpression);
    return lowerExpr(nne.getExpression(), ctx);
  }

  if (k === SyntaxKind.BinaryExpression) return lowerBinary(node, ctx);
  if (k === SyntaxKind.PrefixUnaryExpression) return lowerPrefixUnary(node, ctx);
  if (k === SyntaxKind.PostfixUnaryExpression) return lowerPostfixUnary(node, ctx);

  if (k === SyntaxKind.CallExpression) return lowerCall(node, ctx);

  if (k === SyntaxKind.PropertyAccessExpression) {
    return lowerPropertyAccess(node, ctx);
  }

  if (k === SyntaxKind.ElementAccessExpression) {
    const ea = node.asKindOrThrow(SyntaxKind.ElementAccessExpression);
    const obj = lowerExpr(ea.getExpression(), ctx);
    const idx = ea.getArgumentExpression();
    return idx ? `${obj}[${lowerExpr(idx, ctx)}]` : `${obj}[]`;
  }

  if (k === SyntaxKind.ArrayLiteralExpression) {
    return lowerArrayLiteral(node, ctx);
  }

  // #986: ObjectLiteralExpression -> map[K]V{k: v, ...}
  // shave-go emits map[K]V{} as TS `{}` or `{k: v}` object literals.
  // compile-go resolves the Go map type from variable-declaration context
  // via the Ctx.goTypeHint set by lowerVarStatement, or defaults to
  // map[string]interface{}{} when no hint is available.
  if (k === SyntaxKind.ObjectLiteralExpression) {
    return lowerObjectLiteral(node, ctx);
  }

  // Loud failure: unhandled expression kind (DEC-WI973-003)
  const snippet = node.getText().slice(0, 60).replace(/\n/g, " ");
  throw new CannotLowerToGoError(SyntaxKind[k], nodeLocation(node), snippet, ctx.fnName);
}

// ---------------------------------------------------------------------------
// #986: Array and Object literal lowering
//
// @decision DEC-COMPOSITELIT-LOWER-001 (#986)
// @title Array/object literals use goTypeHint from surrounding declaration; fall back to interface{}
// @status accepted (#986)
// @rationale
//   The Go element/key/value types for composite literals cannot be inferred from
//   the TS literal elements alone (e.g. `[1, 2, 3]` could be []int, []int64, or []float64).
//   The surrounding variable declaration type node (e.g. `number[]` -> `[]int`) is the
//   correct authority.  lowerVarStatement sets ctx.goTypeHint before calling lowerExpr on
//   the initializer.  lowerArrayLiteral / lowerObjectLiteral read the hint to emit the
//   correct Go element/key/value type.
//   When no hint is available (e.g. literal in return position or argument position),
//   fall back to `interface{}` to avoid silent type corruption — the Go compiler will
//   flag the mismatch if the inferred type is wrong.
//   Return-position type propagation (reading the enclosing function's return type) is
//   deferred to a later work item; it requires threading the return TypeNode through Ctx.
// ---------------------------------------------------------------------------

/**
 * Parse a Go slice type string (e.g. "[]int", "[]string") and return just the
 * element type ("int", "string"). Returns "interface{}" for unrecognized shapes.
 */
function sliceElementType(goSliceType: string): string {
  if (goSliceType.startsWith("[]")) {
    return goSliceType.slice(2);
  }
  return "interface{}";
}

/**
 * Parse a Go map type string (e.g. "map[string]int") and return [keyType, valueType].
 * Returns ["string", "interface{}"] for unrecognized shapes.
 */
function mapKeyValueTypes(goMapType: string): [string, string] {
  // map[K]V — find the ] that closes the key bracket
  if (!goMapType.startsWith("map[")) return ["string", "interface{}"];
  let depth = 0;
  let closeIdx = -1;
  for (let i = 4; i < goMapType.length; i++) {
    const ch = goMapType[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      if (depth === 0) {
        closeIdx = i;
        break;
      }
      depth--;
    }
  }
  if (closeIdx < 0) return ["string", "interface{}"];
  const keyType = goMapType.slice(4, closeIdx);
  const valueType = goMapType.slice(closeIdx + 1);
  return [keyType || "string", valueType || "interface{}"];
}

/**
 * Lower a TS array literal `[a, b, c]` to Go `[]T{a, b, c}`.
 * Uses ctx.goTypeHint (set by lowerVarStatement) to determine T.
 */
function lowerArrayLiteral(node: Node, ctx: Ctx): string {
  const al = node.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
  const elems = al.getElements().map((e) => lowerExpr(e, ctx));
  const elemType = ctx.goTypeHint ? sliceElementType(ctx.goTypeHint) : "interface{}";
  return `[]${elemType}{${elems.join(", ")}}`;
}

/**
 * Lower a TS object literal `{k: v}` to Go `map[K]V{k: v}`.
 * Uses ctx.goTypeHint to determine K and V.
 * String property keys are emitted as Go string literals (double-quoted).
 * Numeric (computed) property keys are emitted as-is.
 */
function lowerObjectLiteral(node: Node, ctx: Ctx): string {
  const ol = node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
  const [keyType, valueType] = ctx.goTypeHint
    ? mapKeyValueTypes(ctx.goTypeHint)
    : ["string", "interface{}"];

  const entries = ol.getProperties().map((prop) => {
    if (prop.getKind() === SyntaxKind.PropertyAssignment) {
      const pa = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
      const nameNode = pa.getNameNode();
      const valExpr = lowerExpr(pa.getInitializer() ?? pa, ctx);

      // Key rendering: string identifier keys become Go string literals.
      // Numeric literal keys pass through verbatim.
      let keyStr: string;
      if (nameNode.getKind() === SyntaxKind.Identifier) {
        // Bare identifier property key: emit as Go string literal.
        keyStr = `"${nameNode.getText()}"`;
      } else if (nameNode.getKind() === SyntaxKind.StringLiteral) {
        // Already a string literal: use as-is (TS double-quoted matches Go).
        keyStr = nameNode.getText();
      } else {
        // Computed / numeric: lower as expression.
        keyStr = lowerExpr(nameNode, ctx);
      }
      return `${keyStr}: ${valExpr}`;
    }
    // Shorthand, spread, method: not in scope for #986 MVP.
    const snippet = prop.getText().slice(0, 40);
    throw new CannotLowerToGoError(
      SyntaxKind[prop.getKind()],
      nodeLocation(prop),
      snippet,
      ctx.fnName,
    );
  });

  return `map[${keyType}]${valueType}{${entries.join(", ")}}`;
}

// ---------------------------------------------------------------------------
// Binary expression
// ---------------------------------------------------------------------------

const TS_TO_GO_OP: Readonly<Record<string, string>> = {
  "===": "==",
  "!==": "!=",
  "==": "==",
  "!=": "!=",
  "&&": "&&",
  "||": "||",
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "=": "=",
  "+=": "+=",
  "-=": "-=",
  "*=": "*=",
  "/=": "/=",
  "%=": "%=",
  "&": "&",
  "|": "|",
  "^": "^",
  "<<": "<<",
  ">>": ">>",
};

function lowerBinary(node: Node, ctx: Ctx): string {
  const be = node.asKindOrThrow(SyntaxKind.BinaryExpression);
  const left = lowerExpr(be.getLeft(), ctx);
  const right = lowerExpr(be.getRight(), ctx);
  const op = be.getOperatorToken().getText();
  const goOp = TS_TO_GO_OP[op] ?? op;
  return `${left} ${goOp} ${right}`;
}

// ---------------------------------------------------------------------------
// Prefix/postfix unary
// ---------------------------------------------------------------------------

function lowerPrefixUnary(node: Node, ctx: Ctx): string {
  const pu = node.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
  const operand = lowerExpr(pu.getOperand(), ctx);
  const op = pu.getOperatorToken();
  if (op === SyntaxKind.ExclamationToken) return `!${operand}`;
  if (op === SyntaxKind.MinusToken) return `-${operand}`;
  if (op === SyntaxKind.PlusToken) return `+${operand}`;
  if (op === SyntaxKind.PlusPlusToken) return `${operand}++`;
  if (op === SyntaxKind.MinusMinusToken) return `${operand}--`;
  const snippet = node.getText().slice(0, 60);
  throw new CannotLowerToGoError(
    SyntaxKind[node.getKind()],
    nodeLocation(node),
    snippet,
    ctx.fnName,
  );
}

function lowerPostfixUnary(node: Node, ctx: Ctx): string {
  const pu = node.asKindOrThrow(SyntaxKind.PostfixUnaryExpression);
  const operand = lowerExpr(pu.getOperand(), ctx);
  const op = pu.getOperatorToken();
  if (op === SyntaxKind.PlusPlusToken) return `${operand}++`;
  if (op === SyntaxKind.MinusMinusToken) return `${operand}--`;
  return operand;
}

// ---------------------------------------------------------------------------
// Property access
// ---------------------------------------------------------------------------

/**
 * Detect whether a property-access expression's object is a bare package
 * reference (e.g. `reflect` in `reflect.ValueOf`). We use a simple heuristic:
 * if the direct object is an Identifier (not itself a property access chain)
 * then it is a potential package name. We record it in ctx.importRefs; the
 * resolver in lowerSource will skip names it doesn't recognise OR emit a
 * warning placeholder (DEC-WI977-001).
 *
 * This intentionally fires on every dotted access — field accesses on local
 * variables will also be recorded, but since local variable names go through
 * toGoLocalName() they will be lowercase and unlikely to match KNOWN_IMPORT_PATHS,
 * so the resolver will emit a placeholder + warning that the user can ignore.
 * A future improvement could use ts-morph's type checker to distinguish package
 * refs from field accesses, but the table-driven MVP approach is sufficient.
 */
function recordPackageRefIfNeeded(objNode: Node, ctx: Ctx): void {
  if (objNode.getKind() !== SyntaxKind.Identifier) return;
  const name = objNode.getText();
  // Skip single-char type params (T, R, K, V etc.) and common Go builtins
  if (name.length === 1) return;
  if (name === "len" || name === "append" || name === "make" || name === "new") return;
  ctx.importRefs.add(name);
}

function lowerPropertyAccess(node: Node, ctx: Ctx): string {
  const pa = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const objNode = pa.getExpression();
  const prop = pa.getName();

  // len(xs) for .length — handled before recording, no import needed
  if (prop === "length") {
    const obj = lowerExpr(objNode, ctx);
    return `len(${obj})`;
  }

  // Record potential package reference for import synthesis (WI-977)
  recordPackageRefIfNeeded(objNode, ctx);

  const obj = lowerExpr(objNode, ctx);
  return `${obj}.${prop}`;
}

// ---------------------------------------------------------------------------
// Call expression
// ---------------------------------------------------------------------------

function lowerCall(node: Node, ctx: Ctx): string {
  const ce = node.asKindOrThrow(SyntaxKind.CallExpression);
  const callee = ce.getExpression();
  const args = ce.getArguments();
  const argStrs = args.map((a) => lowerExpr(a, ctx));

  // Handle method calls on objects
  if (Node.isPropertyAccessExpression(callee)) {
    const obj = callee.getExpression();
    const method = callee.getName();

    // Record package ref for import synthesis (WI-977, DEC-WI977-001).
    // This fires for pkg.Func(...) calls where the receiver is a bare identifier.
    recordPackageRefIfNeeded(obj, ctx);

    const objStr = lowerExpr(obj, ctx);

    // xs.append(v) -> append(xs, v)
    if (method === "push" && args.length === 1) {
      const v = args[0];
      return `append(${objStr}, ${v ? lowerExpr(v, ctx) : ""})`;
    }

    // Generic method call
    return `${objStr}.${method}(${argStrs.join(", ")})`;
  }

  const calleeStr = lowerExpr(callee, ctx);
  return `${calleeStr}(${argStrs.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Type node lowering
// ---------------------------------------------------------------------------

export function lowerTypeNode(typeNode: TypeNode, ctx: Ctx): string {
  const k = typeNode.getKind();

  if (k === SyntaxKind.NumberKeyword) return "int";
  if (k === SyntaxKind.StringKeyword) return "string";
  if (k === SyntaxKind.BooleanKeyword) return "bool";
  if (k === SyntaxKind.VoidKeyword) return "";
  if (k === SyntaxKind.NullKeyword || k === SyntaxKind.UndefinedKeyword) return "interface{}";
  if (k === SyntaxKind.AnyKeyword || k === SyntaxKind.UnknownKeyword) return "interface{}";

  if (k === SyntaxKind.ArrayType) {
    const at = typeNode.asKindOrThrow(SyntaxKind.ArrayType);
    const inner = lowerTypeNode(at.getElementTypeNode(), ctx);
    return `[]${inner}`;
  }

  if (k === SyntaxKind.TypeReference) {
    const tr = typeNode.asKindOrThrow(SyntaxKind.TypeReference);
    const name = tr.getTypeName().getText();
    const typeArgs = tr.getTypeArguments();

    // Record<K, V> -> map[K]V
    if (name === "Record") {
      const k2 = typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "string";
      const v = typeArgs[1] ? lowerTypeNode(typeArgs[1], ctx) : "interface{}";
      return `map[${k2}]${v}`;
    }

    // Map<K, V> -> map[K]V
    if (name === "Map") {
      const k2 = typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "interface{}";
      const v = typeArgs[1] ? lowerTypeNode(typeArgs[1], ctx) : "interface{}";
      return `map[${k2}]${v}`;
    }

    // ReadonlyArray<T> / Array<T> -> []T
    if (name === "ReadonlyArray" || name === "Array") {
      const inner = typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "interface{}";
      return `[]${inner}`;
    }

    // Type params (T, R, etc.) declared on the current function
    if (ctx.typeParams.includes(name)) return name;

    // Generic wrapper types: pass through name with first arg
    if (typeArgs.length > 0) {
      ctx.warnings.push({
        kind: "unknown-generic",
        message: `Unknown generic type ${name}<...> -> interface{}`,
      });
      return "interface{}";
    }

    return name;
  }

  // @decision DEC-WI984-001
  // @title FunctionType lowering: TS (a0: T, a1: number) => boolean -> Go func(T, int) bool
  // @status accepted (WI-984)
  // @rationale
  //   shave-go #981 made iteratee params structurally typed as TS FunctionType nodes
  //   (e.g. `(a0: T, a1: number) => boolean`). Without this case, lowerTypeNode fell
  //   through to the `interface{}` fallback, producing uncompilable Go (predicate
  //   interface{} instead of func(T, int) bool). Go func-type literals omit param
  //   names — only types are emitted. The void return is handled by checking lowerTypeNode
  //   for the return node: "" (void) -> no return suffix; anything else -> " ReturnType".
  if (k === SyntaxKind.FunctionType) {
    const fnType = typeNode.asKindOrThrow(SyntaxKind.FunctionType) as FunctionTypeNode;
    const paramStrs = fnType.getParameters().map((p) => {
      const pTypeNode = p.getTypeNode();
      // Go func types don't include param names; emit type only.
      return pTypeNode ? lowerTypeNode(pTypeNode, ctx) : "interface{}";
    });
    const retNode = fnType.getReturnTypeNode();
    const ret = retNode ? lowerTypeNode(retNode, ctx) : "";
    // void lowers to "" — no return suffix for void functions
    return ret && ret !== ""
      ? `func(${paramStrs.join(", ")}) ${ret}`
      : `func(${paramStrs.join(", ")})`;
  }

  // Fallback: emit the raw TS text as a Go comment-style placeholder
  ctx.warnings.push({
    kind: "unknown-type",
    message: `Unknown type ${SyntaxKind[k]} -> interface{}`,
  });
  return "interface{}";
}
