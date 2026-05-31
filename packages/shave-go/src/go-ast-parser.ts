// SPDX-License-Identifier: MIT
//
// go-ast-parser.ts -- subprocess wrapper around Go's go/ast standard library (WI-870 slice 1+2).
//
// Invokes `go run scripts/go-ast-parse.go` as a child process, feeds Go
// source over stdin, and reads a JSON AST envelope from stdout.  The wire
// shape is intentionally minimal -- only enough to prove the subprocess
// plumbing and let the signature parser consume real function declarations.
//
// Slice 2 adds the structured body AST wire types (GoBodyNode, GoStmt, GoExpr)
// and bumps the schema version to 2.  raise-body.ts consumes these types.
//
// All Go runtime concerns (Go toolchain install, version pinning, performance
// tuning) are gated behind this single seam.  Tests inject a mock interpreter
// via `GoAstParseOptions.spawnImpl` so the suite runs in pure-Node CI with no
// Go toolchain installed.
//
// @decision DEC-POLYGLOT-GO-SUBPROCESS-001 (WI-870 slice 1)
// @title Subprocess-per-file go/ast invocation (no daemon, no batching) in MVP
// @status accepted (WI-870 slice 1)
// @rationale
//   The MVP performance budget allows < 500ms per file (per #870, mirroring #782).
//   A fresh `go run` process is ~100-200ms cold-start on commodity hardware; go/ast
//   parse of a typical function adds < 5ms.  Total budget is comfortably met for
//   the MVP corpus.  Daemonizing the Go worker is a perf optimization for a later
//   slice once real corpus measurements show it is needed.  Using go/ast (stdlib)
//   rather than tree-sitter-go (Node binding) avoids a native addon build step in
//   CI, keeping the Node-side purely JS/TS.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Thrown when the go/ast subprocess fails for any reason -- Go not on PATH,
 * parse failure, non-zero exit, or stdout that cannot be parsed as JSON.
 * The .message carries an actionable remediation hint where possible
 * (e.g. "install the Go toolchain from https://go.dev/dl/").
 *
 * Slice 4 will reroute parse-side failures to `CannotRaiseToIRError` from
 * `@yakcc/contracts` where appropriate (syntactically invalid Go is not the
 * same class of failure as "Go is not installed").
 */
export class AdapterSubprocessError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "AdapterSubprocessError";
  }
}

/**
 * A Go function parameter as represented in the JSON envelope.
 */
export interface GoAstParam {
  /** Parameter name (may be empty for unnamed return params). */
  readonly name: string;
  /** Go type as a source string, e.g. "int", "[]string", "map[string]bool". */
  readonly goType: string;
}

/**
 * A Go generic type parameter (Go 1.18+).
 */
export interface GoAstTypeParam {
  /** Type parameter name, e.g. "T". */
  readonly name: string;
  /** Constraint as a source string, e.g. "comparable", "any". */
  readonly constraint: string;
}

// ---------------------------------------------------------------------------
// Slice-2 structured body AST wire types
//
// These mirror the Go-side tagged-union output of scripts/go-ast-parse.go.
// Each node carries line/col from go/token.FileSet so raise-body.ts can
// populate SourceLocation for CannotRaiseToIRError / AmbiguousPurityError.
// ---------------------------------------------------------------------------

/** Source location embedded in every body AST node. */
export interface GoAstLocation {
  readonly line: number;
  readonly col: number;
}

/** Identifier expression: a bare name. */
export interface GoAstIdentExpr extends GoAstLocation {
  readonly type: "Ident";
  readonly name: string;
}

/** Integer, float, string, or rune literal. */
export interface GoAstBasicLitExpr extends GoAstLocation {
  readonly type: "BasicLit";
  /** "INT" | "FLOAT" | "STRING" | "CHAR" */
  readonly kind: string;
  /** Raw literal text as Go source. */
  readonly value: string;
}

/** Binary expression: x op y. */
export interface GoAstBinaryExpr extends GoAstLocation {
  readonly type: "BinaryExpr";
  readonly op: string;
  readonly x: GoAstExpr;
  readonly y: GoAstExpr;
}

/** Unary expression: op x (not channel receive). */
export interface GoAstUnaryExpr extends GoAstLocation {
  readonly type: "UnaryExpr";
  readonly op: string;
  readonly x: GoAstExpr;
}

/** Function or method call. */
export interface GoAstCallExpr extends GoAstLocation {
  readonly type: "CallExpr";
  readonly fun: GoAstExpr;
  readonly args: readonly GoAstExpr[];
}

/** Selector expression: x.sel. */
export interface GoAstSelectorExpr extends GoAstLocation {
  readonly type: "SelectorExpr";
  readonly x: GoAstExpr;
  readonly sel: string;
}

/** Index expression: x[index]. */
export interface GoAstIndexExpr extends GoAstLocation {
  readonly type: "IndexExpr";
  readonly x: GoAstExpr;
  readonly index: GoAstExpr;
}

/**
 * BANNED: channel receive (<-ch) or channel type literal.
 * raise-body.ts throws GoChanRecvError on this node type.
 */
export interface GoAstChanRecvExpr extends GoAstLocation {
  readonly type: "ChanRecv";
}

/**
 * Slice literal expression: `[]T{a, b, c}` (#986).
 * Type field captures the element type as a Go source string (e.g. "int", "string").
 * elements is the ordered list of element expressions.
 */
export interface GoAstSliceLitExpr extends GoAstLocation {
  readonly type: "SliceLit";
  /** Go element type string, e.g. "int", "string", "T". */
  readonly elementType: string;
  readonly elements: readonly GoAstExpr[];
}

/**
 * Map literal expression: `map[K]V{k: v, ...}` (#986).
 * keyType and valueType capture the Go source strings.
 * entries is the ordered list of key/value pairs.
 */
export interface GoAstMapLitExpr extends GoAstLocation {
  readonly type: "MapLit";
  /** Go key type string, e.g. "string", "int". */
  readonly keyType: string;
  /** Go value type string, e.g. "int", "bool". */
  readonly valueType: string;
  readonly entries: readonly GoAstMapEntry[];
}

/** One key/value pair in a MapLit expression (#986). */
export interface GoAstMapEntry {
  readonly key: GoAstExpr;
  readonly value: GoAstExpr;
}

/** Expression not in the slice-2 supported set. */
export interface GoAstUnsupportedExpr extends GoAstLocation {
  readonly type: "UnsupportedExpr";
  /** go/ast node kind string, e.g. "*ast.CompositeLit". */
  readonly reason: string;
}

/** Discriminated union of all expression node types in the wire AST. */
export type GoAstExpr =
  | GoAstIdentExpr
  | GoAstBasicLitExpr
  | GoAstBinaryExpr
  | GoAstUnaryExpr
  | GoAstCallExpr
  | GoAstSelectorExpr
  | GoAstIndexExpr
  | GoAstChanRecvExpr
  | GoAstSliceLitExpr
  | GoAstMapLitExpr
  | GoAstUnsupportedExpr;

/** Return statement: `return expr1, expr2, ...` */
export interface GoAstReturnStmt extends GoAstLocation {
  readonly type: "ReturnStmt";
  readonly results: readonly GoAstExpr[];
}

/** Expression statement: a bare expression as a statement. */
export interface GoAstExprStmt extends GoAstLocation {
  readonly type: "ExprStmt";
  readonly x: GoAstExpr;
}

/** Assignment: lhs := rhs or lhs = rhs. */
export interface GoAstAssignStmt extends GoAstLocation {
  readonly type: "AssignStmt";
  readonly lhs: readonly GoAstExpr[];
  readonly rhs: readonly GoAstExpr[];
  /** ":=" or "=" */
  readonly tok: string;
}

/** Variable declaration statement (var x = ...). */
export interface GoAstDeclStmt extends GoAstLocation {
  readonly type: "DeclStmt";
  readonly decl: GoAstDecl;
}

/**
 * BANNED: goroutine launch (`go func()`).
 * raise-body.ts throws GoGoroutineError on this node type.
 */
export interface GoAstGoStmt extends GoAstLocation {
  readonly type: "GoStmt";
}

/**
 * BANNED: select statement.
 * raise-body.ts throws GoSelectError on this node type.
 */
export interface GoAstSelectStmt extends GoAstLocation {
  readonly type: "SelectStmt";
}

/**
 * BANNED: defer statement.
 * raise-body.ts throws GoDeferError on this node type.
 */
export interface GoAstDeferStmt extends GoAstLocation {
  readonly type: "DeferStmt";
}

/**
 * BANNED: channel send (`ch <- val`).
 * raise-body.ts throws GoChanSendError on this node type.
 */
export interface GoAstSendStmt extends GoAstLocation {
  readonly type: "SendStmt";
}

/**
 * Increment/decrement statement: `i++` or `i--` (#982).
 * Go's *ast.IncDecStmt is a first-class statement node (not an expression
 * statement wrapping a unary operator).  TS supports postfix `i++` / `i--`
 * natively; the wire shape records just the target name and operator.
 */
export interface GoAstIncDecStmt extends GoAstLocation {
  readonly type: "IncDecStmt";
  /** Name of the target identifier (e.g. "i"). */
  readonly target: string;
  /** "++" or "--" */
  readonly op: "++" | "--";
}

/** Statement not in the slice-2 supported set. */
export interface GoAstUnsupportedStmt extends GoAstLocation {
  readonly type: "UnsupportedStmt";
  /** go/ast node kind string, e.g. "*ast.IfStmt". */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// WI-964: control-flow statement wire types
// ---------------------------------------------------------------------------

/**
 * If statement: `if cond { body } else { orelse }`.
 * `init` captures the optional init statement (e.g. `if x := f(); x > 0 { ... }`).
 * `orelse` is either null (no else), another IfStmt (else-if chain), or a
 * BlockStmt-equivalent represented as a GoAstBodyNode (plain else branch).
 */
export interface GoAstIfStmt extends GoAstLocation {
  readonly type: "IfStmt";
  readonly init: GoAstStmt | null;
  readonly cond: GoAstExpr;
  readonly body: GoAstBodyNode;
  /** null = no else; IfStmt = else-if chain; BlockNode = plain else body */
  readonly orelse: GoAstIfStmt | GoAstElseBody | null;
}

/** A plain else block (not an else-if chain). */
export interface GoAstElseBody {
  readonly type: "BlockNode";
  readonly body: GoAstBodyNode;
}

/**
 * Classic C-style for loop: `for init; cond; post { body }`.
 * Any of init/cond/post may be null (e.g. `for ; x > 0; { ... }`).
 */
export interface GoAstForStmt extends GoAstLocation {
  readonly type: "ForStmt";
  readonly init: GoAstStmt | null;
  readonly cond: GoAstExpr | null;
  readonly post: GoAstStmt | null;
  readonly body: GoAstBodyNode;
}

/**
 * Range loop: `for k, v := range items { body }`.
 * `key` and `value` are the loop variable names (or null if blank `_`).
 * `tok` is ":=" or "=" (the assignment token used in the range clause).
 */
export interface GoAstRangeStmt extends GoAstLocation {
  readonly type: "RangeStmt";
  readonly key: string | null;
  readonly value: string | null;
  readonly tok: string;
  readonly x: GoAstExpr;
  readonly body: GoAstBodyNode;
}

/**
 * One case clause in a switch: `case expr1, expr2: body`.
 * `list` is empty for the `default:` clause.
 */
export interface GoAstCaseClause {
  readonly type: "CaseClause";
  readonly list: readonly GoAstExpr[];
  readonly body: GoAstBodyNode;
}

/**
 * Switch statement: `switch tag { case ...: ... default: ... }`.
 * `tag` is null for a tagless switch (`switch { case x > 0: ... }`).
 * `init` is null when no init statement precedes the tag.
 */
export interface GoAstSwitchStmt extends GoAstLocation {
  readonly type: "SwitchStmt";
  readonly init: GoAstStmt | null;
  readonly tag: GoAstExpr | null;
  readonly cases: readonly GoAstCaseClause[];
}

/** Discriminated union of all statement node types in the wire AST. */
export type GoAstStmt =
  | GoAstReturnStmt
  | GoAstExprStmt
  | GoAstAssignStmt
  | GoAstDeclStmt
  | GoAstGoStmt
  | GoAstSelectStmt
  | GoAstDeferStmt
  | GoAstSendStmt
  | GoAstIfStmt
  | GoAstForStmt
  | GoAstRangeStmt
  | GoAstSwitchStmt
  | GoAstIncDecStmt
  | GoAstUnsupportedStmt;

/** Variable spec declaration (from a DeclStmt). */
export interface GoAstValueSpecDecl {
  readonly type: "ValueSpec";
  readonly names: readonly string[];
  readonly values: readonly GoAstExpr[];
}

/** Declaration not in the slice-2 supported set. */
export interface GoAstUnsupportedDecl {
  readonly type: "UnsupportedDecl";
  readonly reason: string;
}

export type GoAstDecl = GoAstValueSpecDecl | GoAstUnsupportedDecl;

/** Structured body AST for a single function: a list of statements. */
export interface GoAstBodyNode {
  readonly stmts: readonly GoAstStmt[];
}

/**
 * A single function declaration from the Go AST envelope.
 *
 * This is the wire shape produced by scripts/go-ast-parse.go.  In slice 2
 * the `body` field carries the structured statement/expression AST;
 * `bodySource` is retained for diagnostics only.
 */
export interface GoAstFunction {
  /** Function name as written in Go source. */
  readonly name: string;
  /** Receiver type source string for methods, or null for top-level funcs. */
  readonly receiver: string | null;
  /** Generic type parameters (Go 1.18+); empty array for non-generic funcs. */
  readonly typeParams: readonly GoAstTypeParam[];
  /** Input parameters in declaration order. */
  readonly params: readonly GoAstParam[];
  /**
   * Return parameters.  Named returns carry a name; unnamed returns have
   * name === "".  Multiple returns are represented as an array.
   */
  readonly results: readonly GoAstParam[];
  /**
   * Verbatim function body source text (diagnostics only; raise-body.ts
   * consumes the structured `body` field, not this string).
   * May be null if the function is a forward declaration or external.
   */
  readonly bodySource: string | null;
  /**
   * Structured body AST emitted by scripts/go-ast-parse.go (slice 2).
   * Null when the function has no body (forward declaration / extern).
   */
  readonly body: GoAstBodyNode | null;
}

/**
 * Top-level shape of the JSON envelope emitted by scripts/go-ast-parse.go.
 * Slice 2 bumps the schema version from 1 to 2.
 */
export interface GoAstParseResult {
  /** Schema version of the envelope. Slice 2 ships v=2. */
  readonly version: 2;
  /** Package name declared at the top of the file. */
  readonly packageName: string;
  /** Top-level function declarations. */
  readonly functions: readonly GoAstFunction[];
}

/**
 * Injectable subprocess constructor -- defaults to `node:child_process.spawn`.
 * Tests pass a fake that emits a known stdout/stderr/exit-code triple so the
 * suite does not require Go to be installed.
 *
 * Matches the relevant subset of node spawn signature so the default
 * implementation slots in without an adapter.
 */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options?: { readonly env?: NodeJS.ProcessEnv },
) => ChildProcess;

export interface GoAstParseOptions {
  /**
   * Go executable to invoke.  Defaults to `process.env.YAKCC_GO ?? "go"`.
   * Slice 4 will honor `go.mod` toolchain directives when present.
   */
  readonly goExecutable?: string;
  /**
   * Absolute path to `scripts/go-ast-parse.go`.  Defaults to the script
   * shipped with this package.
   */
  readonly scriptPath?: string;
  /**
   * Injectable subprocess factory (for tests).  Defaults to `spawn` from
   * `node:child_process`.
   */
  readonly spawnImpl?: SpawnImpl;
}

const DEFAULT_GO = "go";

/** Resolve the bundled `scripts/go-ast-parse.go` from this module location.
 *
 * @decision DEC-SHAVE-GO-SCRIPTPATH-001
 * @title Resolve script path via import.meta.url with explicit dist-layout depth
 * @status accepted (WI-966)
 * @rationale
 *   The dist/ layout places the compiled file at packages/shave-go/dist/go-ast-parser.js.
 *   Walking up 3 levels reaches the repo root where scripts/go-ast-parse.go lives.
 *   Using import.meta.url (rather than __dirname or process.cwd) is the ESM-safe
 *   approach that survives symlinks, worktrees, and external callers who import
 *   the package from node_modules.  Two levels (the prior bug) landed in packages/
 *   instead of repo root, causing ENOENT for any caller outside the monorepo.
 */
function defaultScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Built layout:  packages/shave-go/dist/go-ast-parser.js
  //   dist/             → [1] packages/shave-go/
  //   dist/../..        → [2] packages/
  //   dist/../../..     → [3] repo root  ← scripts/ lives here
  // Source layout: packages/shave-go/src/go-ast-parser.ts (same depth)
  return resolve(here, "..", "..", "..", "scripts", "go-ast-parse.go");
}

/**
 * Parse a Go source string into a `GoAstParseResult` by invoking the
 * go/ast subprocess.
 *
 * Behavior:
 *   - Go source is fed over stdin (UTF-8).
 *   - stdout is parsed as JSON and shape-checked against `GoAstParseResult`.
 *   - Non-zero exit -> AdapterSubprocessError carrying exitCode + stderr.
 *   - Spawn failure (e.g. go not on PATH) -> AdapterSubprocessError with a
 *     remediation hint pointing at https://go.dev/dl/.
 *   - JSON parse failure -> AdapterSubprocessError (stderr contains the raw bytes).
 */
export async function parseGoSource(
  source: string,
  options: GoAstParseOptions = {},
): Promise<GoAstParseResult> {
  const goExe = options.goExecutable ?? process.env.YAKCC_GO ?? DEFAULT_GO;
  const script = options.scriptPath ?? defaultScriptPath();
  const spawnFn = options.spawnImpl ?? (spawn as unknown as SpawnImpl);

  return new Promise<GoAstParseResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawnFn(goExe, ["run", script]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rejectPromise(
        new AdapterSubprocessError(
          `Failed to spawn ${goExe}: ${msg}. Ensure the Go toolchain (>=1.18) is installed and on PATH (download from https://go.dev/dl/ or set YAKCC_GO to override).`,
          null,
          "",
        ),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err: Error) => {
      rejectPromise(
        new AdapterSubprocessError(
          `${goExe} subprocess error: ${err.message}. Ensure the Go toolchain (>=1.18) is installed and on PATH.`,
          null,
          Buffer.concat(stderrChunks).toString("utf-8"),
        ),
      );
    });

    child.on("close", (code: number | null) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      if (code !== 0) {
        rejectPromise(
          new AdapterSubprocessError(
            `${goExe} exited with code ${String(code)}. stderr: ${stderr.trim() || "(empty)"}. If Go is missing, install from https://go.dev/dl/`,
            code,
            stderr,
          ),
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        rejectPromise(
          new AdapterSubprocessError(
            `go-ast-parse stdout was not valid JSON: ${msg}`,
            code,
            stdout,
          ),
        );
        return;
      }
      const validationError = validateParseResult(parsed);
      if (validationError !== null) {
        rejectPromise(new AdapterSubprocessError(validationError, code, stderr));
        return;
      }
      resolvePromise(parsed as GoAstParseResult);
    });

    // Trap EPIPE on stdin: if the subprocess exits before consuming all input
    // (e.g. parse error causes early exit), Node emits 'error' on the write
    // stream.  Without this handler the event is unhandled and crashes the host
    // process.  The non-zero exit code is surfaced through the 'close' handler
    // below, so EPIPE is safe to swallow here.
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return; // subprocess exited early — handled by exit-code path
      // Non-EPIPE stdin errors: let the existing 'error' handler on `child` surface them.
    });

    child.stdin?.end(source, "utf-8");
  });
}

/**
 * Lightweight runtime shape check.  Returns null if `value` matches
 * `GoAstParseResult`, else a descriptive error string.
 */
function validateParseResult(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "go-ast-parse output: expected a non-null object";
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 2) {
    return `go-ast-parse output: schema version must be 2, got ${String(obj.version)}`;
  }
  if (typeof obj.packageName !== "string") {
    return 'go-ast-parse output: "packageName" must be a string';
  }
  if (!Array.isArray(obj.functions)) {
    return 'go-ast-parse output: "functions" must be an array';
  }
  return null;
}
