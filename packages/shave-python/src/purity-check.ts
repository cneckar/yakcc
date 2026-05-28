// SPDX-License-Identifier: MIT
//
// purity-check.ts — static purity inference for Python functions (WI-782 slice 3).
//
// Inspects the libcst JSON envelope (already produced by libcst-parser.ts) and
// rejects functions that use I/O, mutable globals, or other impure constructs.
// This is a static reject-list: no new Python subprocess is spawned.
//
// @decision DEC-POLYGLOT-SHAVE-PY-PURITY-001 (WI-782 slice 3)
// @title Static reject-list purity inference — no new subprocess
// @status accepted (WI-782 slice 3)
// @rationale
//   Slice 3 ships a conservative static reject-list that covers the most common
//   impurity patterns (I/O builtins, forbidden modules, global declarations,
//   forbidden attribute reads). This operates entirely on the libcst JSON
//   envelope already produced by the subprocess from slice 1 — no new Python
//   invocation.  Pyright-based escalation is deferred to slice 4 if the
//   static reject-list proves insufficient for a real corpus.

import type { LibcstParseResult, PythonAstNode } from "./libcst-parser.js";

// ---------------------------------------------------------------------------
// Reject-list constants
// ---------------------------------------------------------------------------

/**
 * Module names whose import or use renders a function impure.
 * Covers I/O, networking, system access, randomness, and time-dependency.
 */
export const FORBIDDEN_MODULES = new Set([
  "os",
  "sys",
  "random",
  "datetime",
  "time",
  "subprocess",
  "pathlib",
  "socket",
  "requests",
  "urllib",
  "urllib2",
  "urllib3",
  "http",
  "httpx",
  "aiohttp",
]);

/**
 * Built-in names that constitute I/O or unsafe evaluation.
 * Encountering a Call node with one of these as the callee function name
 * makes the function impure.
 */
export const FORBIDDEN_BUILTINS = new Set([
  "open",
  "print",
  "input",
  "eval",
  "exec",
  "compile",
  "__import__",
]);

/**
 * Attribute accesses on forbidden modules that signal impurity
 * (e.g. `os.environ`, `sys.argv`). Stored as "module.attr" strings.
 */
export const FORBIDDEN_ATTRS = new Set([
  "os.environ",
  "os.getenv",
  "os.putenv",
  "os.getcwd",
  "os.listdir",
  "os.makedirs",
  "os.path",
  "sys.argv",
  "sys.stdin",
  "sys.stdout",
  "sys.stderr",
  "sys.exit",
  "sys.modules",
]);

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when a Python function is rejected by the static purity check.
 *
 * Carries the function name, the offending construct (kind + detail), and
 * an optional source location if the envelope provides one.
 *
 * Slice 4 will reconcile this with `CannotRaiseToIRError` from `@yakcc/contracts`
 * as part of the broader error taxonomy unification.
 */
export class ImpureFunctionError extends Error {
  constructor(
    /** The Python function name that was rejected. */
    public readonly functionName: string,
    /** Short classifier of the impurity kind, e.g. "forbidden_import". */
    public readonly kind: ImpurityKind,
    /** Human-readable description of the offending construct. */
    public readonly detail: string,
    /** 1-based line number if available from the envelope, else null. */
    public readonly line: number | null = null,
    /** 1-based column number if available from the envelope, else null. */
    public readonly col: number | null = null,
  ) {
    const loc = line !== null ? ` (line ${line}${col !== null ? `:${col}` : ""})` : "";
    super(
      `Function '${functionName}' is impure: ${detail}${loc}. Use a pure function that avoids I/O, mutable globals, and non-deterministic constructs.`,
    );
    this.name = "ImpureFunctionError";
  }
}

/** Classifier for purity violation kinds. */
export type ImpurityKind = "forbidden_import" | "forbidden_call" | "forbidden_attr" | "global_decl";

// ---------------------------------------------------------------------------
// Internal wire-AST walker types
// ---------------------------------------------------------------------------

interface ImpurityRecord {
  readonly kind: ImpurityKind;
  readonly detail: string;
  readonly line: number | null;
  readonly col: number | null;
}

// ---------------------------------------------------------------------------
// Envelope shape (slice 3 additions from libcst-parse.py)
// ---------------------------------------------------------------------------

/**
 * A purity violation record as emitted by the slice-3 Python script extension.
 * The TS-side purity check produces equivalent records from the wire AST when
 * the Python script does not yet emit them (backward compat with pre-slice-3 envelopes).
 */
interface EnvelopeImpurity {
  readonly kind: string;
  readonly detail: string;
  readonly line?: number | null;
  readonly col?: number | null;
}

/**
 * Slice-3 extension to the module envelope: top-level import names.
 */
interface EnvelopeImport {
  readonly kind: "import" | "from";
  /** Top-level module name, e.g. "os" or "sys". */
  readonly module: string;
  readonly name: string;
  readonly alias?: string | null;
}

// ---------------------------------------------------------------------------
// Internal wire-AST walker for purity analysis
// ---------------------------------------------------------------------------

/**
 * Walk a wire AST node tree (as produced by libcst-parse.py body[]) and
 * collect impurity violations.  This operates on the EXISTING body wire AST —
 * no new Python subprocess invocation is required.
 *
 * Wire AST node shapes mirror those defined in raise-body.ts (WireStmt / WireExpr).
 * Unknown/unsupported shapes are skipped conservatively — the reject-list is
 * additive, not exhaustive.
 */
function collectBodyImpurities(body: readonly PythonAstNode[]): ImpurityRecord[] {
  const violations: ImpurityRecord[] = [];

  function visitExpr(node: PythonAstNode): void {
    if (!node || typeof node !== "object") return;
    const type = String(node.type ?? "");

    if (type === "Attribute") {
      // Attribute access: obj.attr — check for forbidden module.attr pairs
      const obj = node.obj as PythonAstNode | undefined;
      const attr = node.attr as string | undefined;
      if (obj?.type === "Name" && typeof attr === "string") {
        const pair = `${String(obj.name)}.${attr}`;
        if (FORBIDDEN_ATTRS.has(pair)) {
          violations.push({
            kind: "forbidden_attr",
            detail: `reads forbidden attribute '${pair}'`,
            line: (node.line as number | undefined) ?? null,
            col: (node.col as number | undefined) ?? null,
          });
        } else if (FORBIDDEN_MODULES.has(String(obj.name))) {
          violations.push({
            kind: "forbidden_attr",
            detail: `accesses forbidden module '${String(obj.name)}' via '.${attr}'`,
            line: (node.line as number | undefined) ?? null,
            col: (node.col as number | undefined) ?? null,
          });
        }
      }
    }

    if (type === "Call") {
      // Call nodes: check if callee is a forbidden builtin name
      const func = node.func as PythonAstNode | undefined;
      if (func?.type === "Name") {
        const calleeName = String(func.name);
        if (FORBIDDEN_BUILTINS.has(calleeName)) {
          violations.push({
            kind: "forbidden_call",
            detail: `calls forbidden builtin '${calleeName}()'`,
            line: (node.line as number | undefined) ?? null,
            col: (node.col as number | undefined) ?? null,
          });
        }
      }
      // Recurse into callee (catches method calls on forbidden objects)
      if (func) visitExpr(func);
      // Recurse into arguments
      const args = node.args as PythonAstNode[] | undefined;
      if (Array.isArray(args)) {
        for (const arg of args) visitExpr(arg as PythonAstNode);
      }
    }

    if (type === "BinaryOp") {
      const left = node.left as PythonAstNode | undefined;
      const right = node.right as PythonAstNode | undefined;
      if (left) visitExpr(left);
      if (right) visitExpr(right);
    }

    if (type === "Return" || type === "Expr" || type === "Assign") {
      const value = node.value as PythonAstNode | undefined;
      if (value) visitExpr(value);
    }
  }

  function visitStmt(stmt: PythonAstNode): void {
    if (!stmt || typeof stmt !== "object") return;
    const type = String(stmt.type ?? "");

    if (type === "Global") {
      // global x — mutable global reference; always impure
      const names = stmt.names as string[] | undefined;
      const nameList = Array.isArray(names) ? names.join(", ") : "(unknown)";
      violations.push({
        kind: "global_decl",
        detail: `declares global variable(s): ${nameList}`,
        line: (stmt.line as number | undefined) ?? null,
        col: (stmt.col as number | undefined) ?? null,
      });
    }

    if (type === "Return" || type === "Expr" || type === "Assign") {
      const value = stmt.value as PythonAstNode | undefined;
      if (value) visitExpr(value);
    }

    // Recurse into nested statement blocks (if/for/while bodies)
    const innerBody = stmt.body as PythonAstNode[] | undefined;
    if (Array.isArray(innerBody)) {
      for (const inner of innerBody) visitStmt(inner as PythonAstNode);
    }
  }

  for (const stmt of body) visitStmt(stmt as PythonAstNode);
  return violations;
}

// ---------------------------------------------------------------------------
// Module-level import analysis
// ---------------------------------------------------------------------------

/**
 * Inspect `module.imports` (slice 3 envelope extension) for forbidden imports.
 * Returns empty array when the envelope does not carry import metadata yet
 * (pre-slice-3 Python script) — the check is additive, not blocking.
 */
function collectImportImpurities(moduleNode: PythonAstNode): ImpurityRecord[] {
  const violations: ImpurityRecord[] = [];

  const imports = moduleNode.imports as EnvelopeImport[] | undefined;
  if (!Array.isArray(imports)) return violations;

  for (const imp of imports) {
    const topModule = (imp.module ?? "").split(".")[0] ?? "";
    if (FORBIDDEN_MODULES.has(topModule)) {
      violations.push({
        kind: "forbidden_import",
        detail: `imports forbidden module '${imp.module}'`,
        line: null,
        col: null,
      });
    }
  }
  return violations;
}

/**
 * Collect impurities from the envelope's per-function impurities[] array if
 * present (emitted by the slice-3 Python script extension).
 */
function collectEnvelopeImpurities(fnRecord: PythonAstNode): ImpurityRecord[] {
  const raw = fnRecord.impurities as EnvelopeImpurity[] | undefined;
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((r): r is EnvelopeImpurity => typeof r === "object" && r !== null)
    .map((r) => ({
      kind: normalizeImpurityKind(r.kind),
      detail: String(r.detail ?? ""),
      line: typeof r.line === "number" ? r.line : null,
      col: typeof r.col === "number" ? r.col : null,
    }));
}

function normalizeImpurityKind(kind: string): ImpurityKind {
  switch (kind) {
    case "forbidden_import":
    case "forbidden_call":
    case "forbidden_attr":
    case "global_decl":
      return kind;
    default:
      return "forbidden_call";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check a function envelope record for purity violations.
 *
 * @param fnRecord  — a single functions[] entry from the libcst envelope
 * @param moduleNode — the module node (for import inspection)
 * @param fnName    — function name (for error messages)
 *
 * Throws `ImpureFunctionError` on the FIRST impurity found.
 * Returns void if the function passes the static reject-list.
 *
 * Note: passing this check means "not detected as impure" — not proved pure.
 * Pyright-based deeper purity analysis is deferred to slice 4.
 */
export function checkFunctionPurity(
  fnRecord: PythonAstNode,
  moduleNode: PythonAstNode,
  fnName: string,
): void {
  // 1. Module-level import analysis (slice 3 envelope extension)
  const importViolations = collectImportImpurities(moduleNode);
  const firstImport = importViolations[0];
  if (firstImport !== undefined) {
    throw new ImpureFunctionError(
      fnName,
      firstImport.kind,
      firstImport.detail,
      firstImport.line,
      firstImport.col,
    );
  }

  // 2. Envelope-level per-function impurities (slice 3 Python script extension)
  const envelopeViolations = collectEnvelopeImpurities(fnRecord);
  const firstEnvelope = envelopeViolations[0];
  if (firstEnvelope !== undefined) {
    throw new ImpureFunctionError(
      fnName,
      firstEnvelope.kind,
      firstEnvelope.detail,
      firstEnvelope.line,
      firstEnvelope.col,
    );
  }

  // 3. Wire-AST body walk (works with existing slice-2b body[] nodes)
  const body = fnRecord.body as PythonAstNode[] | undefined;
  if (Array.isArray(body)) {
    const bodyViolations = collectBodyImpurities(body);
    const firstBody = bodyViolations[0];
    if (firstBody !== undefined) {
      throw new ImpureFunctionError(
        fnName,
        firstBody.kind,
        firstBody.detail,
        firstBody.line,
        firstBody.col,
      );
    }
  }
}

/**
 * Check module-level imports for purity violations.
 *
 * Module-level forbidden imports make ALL functions in the module impure
 * regardless of what those functions do.  This check runs independently of
 * the per-function walk so it fires even when `module.functions[]` is empty
 * (e.g. in `raiseFunctionWithPurityAndNormalization` which checks the envelope
 * for the function being raised, not all functions in the module).
 *
 * Throws `ImpureFunctionError` with `fnName` if a forbidden import is found.
 * Returns void if no forbidden imports are present.
 */
export function checkModuleImports(envelope: LibcstParseResult, fnName: string): void {
  const moduleNode = envelope.module as PythonAstNode;
  const importViolations = collectImportImpurities(moduleNode);
  const firstImport = importViolations[0];
  if (firstImport !== undefined) {
    throw new ImpureFunctionError(
      fnName,
      firstImport.kind,
      firstImport.detail,
      firstImport.line,
      firstImport.col,
    );
  }
}

/**
 * Walk the full libcst envelope and check every function for purity.
 *
 * Throws `ImpureFunctionError` on the first impure function found.
 * Returns void if all functions pass the static reject-list.
 *
 * This is the primary integration point for `raise-function.ts`.
 * Call this BEFORE type-mapping (pre-mapping) so impure functions
 * are rejected before any IR is produced.
 */
export function checkPurity(envelope: LibcstParseResult): void {
  const moduleNode = envelope.module as PythonAstNode;
  const fns = (moduleNode.functions as PythonAstNode[] | undefined) ?? [];

  // Module-level import check fires first — applies to all functions.
  // Use "(module)" as a placeholder function name when no function name is
  // yet resolved; checkFunctionPurity will use the real name per-function.
  const importViolations = collectImportImpurities(moduleNode);
  const firstImport = importViolations[0];
  if (firstImport !== undefined && fns.length > 0) {
    // Report on the first function name (same import applies to all)
    const firstName = String((fns[0] as { name?: string }).name ?? "(unknown)");
    throw new ImpureFunctionError(
      firstName,
      firstImport.kind,
      firstImport.detail,
      firstImport.line,
      firstImport.col,
    );
  }

  for (const fn of fns) {
    const fnName = String((fn as { name?: string }).name ?? "(unknown)");
    checkFunctionPurity(fn, moduleNode, fnName);
  }
}
