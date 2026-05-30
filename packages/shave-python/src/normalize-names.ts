// SPDX-License-Identifier: MIT
//
// normalize-names.ts — snake_case → camelCase identifier normalization
// for Python function/parameter/local-variable names (WI-782 slice 3).
//
// Normalization rules (per dispatch contract):
//   - snake_case → camelCase: "calc_total" → "calcTotal"
//   - Leading underscore preserved: "_private" → "_private"
//   - Dunder preserved: "__dunder__" → "__dunder__"
//   - ALL_CAPS preserved: "MAX_SIZE" → "MAX_SIZE"
//   - Single-word (no underscore): "total" → "total" (unchanged)
//   - Numeric suffix: "value_1" → "value1"
//   - Multi-segment: "calc_total_sum" → "calcTotalSum"
//
// Normalization applies to: function names, parameter names, local variable
// names referenced in the body.
//
// Normalization does NOT apply to: type names (type-map.ts handles those),
// string literal values, or imported names (rejected by purity-check.ts first).
//
// @decision DEC-POLYGLOT-SHAVE-PY-NORMALIZE-001 (WI-782 slice 3)
// @title snake_case→camelCase normalization: identifier-only, no type/string touch
// @status accepted (WI-782 slice 3)
// @rationale
//   Python convention is snake_case; TypeScript convention is camelCase.  The
//   mapping must be consistent and deterministic so the same Python source always
//   produces the same TS output.  Edge cases (leading underscore = private,
//   dunder = framework magic, ALL_CAPS = constant) are preserved exactly because
//   renaming them would silently change semantics visible to callers.  Type names
//   and string literals are explicitly excluded so normalization cannot corrupt
//   payload data or type system contracts.

import type { FunctionSignature, RaisedParam } from "./parse-fn-signature.js";
import type { WireExpr, WireStmt } from "./raise-body.js";

// ---------------------------------------------------------------------------
// Core identifier normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a single Python identifier according to the slice-3 rules.
 *
 * Rules (applied in order, first match wins):
 *   1. Dunder (`__foo__`) → preserved unchanged
 *   2. Leading underscore (`_foo_bar`) → `_` prefix kept, remainder camelCased
 *   3. ALL_CAPS (`MAX_SIZE`) → preserved unchanged
 *   4. No underscore (single word) → preserved unchanged
 *   5. snake_case → camelCase (first segment lower, rest title-cased)
 *
 * @param name  Raw Python identifier string.
 * @returns     Normalized identifier.
 */
export function normalizeIdentifier(name: string): string {
  if (!name) return name;

  // Rule 1: dunder — __foo__ (starts AND ends with double underscore)
  if (name.startsWith("__") && name.endsWith("__")) {
    return name;
  }

  // Rule 2: leading underscore — preserve prefix, normalize the rest
  if (name.startsWith("_")) {
    const inner = name.slice(1);
    // If the remainder is also all-underscore/empty, return as-is
    if (!inner) return name;
    return `_${normalizeIdentifier(inner)}`;
  }

  // Rule 3: ALL_CAPS constant — every segment is all uppercase letters/digits
  const segments = name.split("_").filter((s) => s.length > 0);
  if (segments.length > 1 && segments.every((s) => /^[A-Z0-9]+$/.test(s))) {
    return name;
  }

  // Rule 4: no underscore (single word or numeric-only) → unchanged
  if (!name.includes("_")) {
    return name;
  }

  // Rule 5: snake_case → camelCase
  // First segment is lowercase, subsequent segments are title-cased.
  // Numeric-only segments are appended directly (value_1 → value1).
  const [first, ...rest] = segments;
  const camel =
    (first ?? "").toLowerCase() +
    rest
      .map((seg) => {
        if (/^\d+$/.test(seg)) return seg; // numeric suffix appended directly
        return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
      })
      .join("");
  return camel;
}

// ---------------------------------------------------------------------------
// FunctionSignature normalization
// ---------------------------------------------------------------------------

/**
 * Apply `normalizeIdentifier` to all name fields in a `FunctionSignature`:
 * the function name and each parameter name.
 *
 * Does NOT touch `tsType`, `pythonAnnotation`, or `pythonReturnAnnotation`
 * (those are type-map.ts territory or raw Python annotations for diagnostics).
 *
 * @returns A new `FunctionSignature` with normalized names.
 */
export function normalizeSignatureNames(sig: FunctionSignature): FunctionSignature {
  const normalizedParams: RaisedParam[] = sig.params.map((p) => ({
    name: normalizeIdentifier(p.name),
    tsType: p.tsType,
    pythonAnnotation: p.pythonAnnotation,
  }));
  return {
    name: normalizeIdentifier(sig.name),
    params: normalizedParams,
    returnType: sig.returnType,
    pythonReturnAnnotation: sig.pythonReturnAnnotation,
    bodyPythonSource: sig.bodyPythonSource,
  };
}

// ---------------------------------------------------------------------------
// Wire-AST body normalization
// ---------------------------------------------------------------------------

/**
 * Build a rename map from the old parameter names to their camelCase equivalents.
 * Used to rewrite Name references in the body that refer to parameters.
 *
 * @param originalParams  The params as extracted by parse-fn-signature.ts (snake_case).
 * @returns  Map from original name → normalized name.
 */
export function buildParamRenameMap(originalParams: readonly RaisedParam[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of originalParams) {
    const normalized = normalizeIdentifier(p.name);
    if (normalized !== p.name) {
      map.set(p.name, normalized);
    }
  }
  return map;
}

/**
 * Rewrite `Name` nodes in a `WireExpr` tree using the provided rename map.
 *
 * Only `Name` nodes whose value appears as a key in `renameMap` are changed.
 * All other node types and all string/numeric literals are left untouched.
 * The function returns a NEW node tree — the input is not mutated.
 *
 * @decision DEC-958-001 — normalizeExprNames covers all WireExpr node types
 * @title Exhaustive expr walker for param rename: Name, BinaryOp, UnaryOp, BoolOp,
 *   IfExp, LenCall, Call, ListComp, GeneratorExp, DictComp, SetComp, Attribute,
 *   Subscript, Tuple. Literals and Unsupported pass through unchanged.
 * @status accepted (#958)
 * @rationale The original implementation only handled Name and BinaryOp, leaving
 *   params inside If.test, Subscript slice, Attribute value, etc. unrenamed.
 *   The fix is a complete structural walk matching the full WireExpr union. Any
 *   node type added to WireExpr in the future must be added here to remain correct.
 */
export function normalizeExprNames(expr: WireExpr, renameMap: Map<string, string>): WireExpr {
  switch (expr.type) {
    case "Name": {
      const renamed = renameMap.get(expr.name);
      return renamed !== undefined ? { type: "Name", name: renamed } : expr;
    }
    case "BinaryOp":
      return {
        type: "BinaryOp",
        op: expr.op,
        left: normalizeExprNames(expr.left, renameMap),
        right: normalizeExprNames(expr.right, renameMap),
      };
    case "UnaryOp":
      return {
        type: "UnaryOp",
        op: expr.op,
        operand: normalizeExprNames(expr.operand, renameMap),
      };
    case "BoolOp":
      return {
        type: "BoolOp",
        op: expr.op,
        left: normalizeExprNames(expr.left, renameMap),
        right: normalizeExprNames(expr.right, renameMap),
      };
    case "IfExp":
      return {
        type: "IfExp",
        test: normalizeExprNames(expr.test, renameMap),
        body: normalizeExprNames(expr.body, renameMap),
        orelse: normalizeExprNames(expr.orelse, renameMap),
      };
    case "LenCall":
      return { type: "LenCall", arg: normalizeExprNames(expr.arg, renameMap) };
    case "Call":
      return {
        type: "Call",
        func: expr.func,
        args: expr.args.map((a) => normalizeExprNames(a, renameMap)),
      };
    case "ListComp": {
      if (expr.kind === "map") {
        return {
          ...expr,
          iter: normalizeExprNames(expr.iter, renameMap),
          elt: normalizeExprNames(expr.elt, renameMap),
        };
      }
      if (expr.kind === "filter") {
        return {
          ...expr,
          iter: normalizeExprNames(expr.iter, renameMap),
          cond: normalizeExprNames(expr.cond, renameMap),
        };
      }
      // filter_map
      return {
        ...expr,
        iter: normalizeExprNames(expr.iter, renameMap),
        cond: normalizeExprNames(expr.cond, renameMap),
        elt: normalizeExprNames(expr.elt, renameMap),
      };
    }
    case "GeneratorExp": {
      if (expr.kind === "map") {
        return {
          ...expr,
          iter: normalizeExprNames(expr.iter, renameMap),
          elt: normalizeExprNames(expr.elt, renameMap),
        };
      }
      // filter_map
      return {
        ...expr,
        iter: normalizeExprNames(expr.iter, renameMap),
        cond: normalizeExprNames(expr.cond, renameMap),
        elt: normalizeExprNames(expr.elt, renameMap),
      };
    }
    case "DictComp":
      return {
        ...expr,
        iter: normalizeExprNames(expr.iter, renameMap),
        keyElt: normalizeExprNames(expr.keyElt, renameMap),
        valElt: normalizeExprNames(expr.valElt, renameMap),
        cond: expr.cond !== null ? normalizeExprNames(expr.cond, renameMap) : null,
      };
    case "SetComp": {
      if (expr.kind === "map") {
        return {
          ...expr,
          iter: normalizeExprNames(expr.iter, renameMap),
          elt: normalizeExprNames(expr.elt, renameMap),
        };
      }
      // filter_map
      return {
        ...expr,
        iter: normalizeExprNames(expr.iter, renameMap),
        cond: normalizeExprNames(expr.cond, renameMap),
        elt: normalizeExprNames(expr.elt, renameMap),
      };
    }
    case "Attribute":
      return {
        type: "Attribute",
        value: normalizeExprNames(expr.value, renameMap),
        attr: expr.attr,
      };
    case "Subscript":
      return {
        type: "Subscript",
        value: normalizeExprNames(expr.value, renameMap),
        slice: normalizeExprNames(expr.slice, renameMap),
      };
    case "Tuple":
      return {
        type: "Tuple",
        elements: expr.elements.map((e) => normalizeExprNames(e, renameMap)),
      };
    // Literals (Integer, Float, String, Bool, None) and Unsupported pass through unchanged.
    default:
      return expr;
  }
}

/**
 * Rewrite `Name` nodes in a `WireStmt` list using the provided rename map.
 *
 * Returns a new array; original statements are not mutated.
 */
export function normalizeBodyNames(
  body: readonly WireStmt[],
  renameMap: Map<string, string>,
): WireStmt[] {
  return body.map((stmt) => normalizeStmtNames(stmt, renameMap));
}

/**
 * @decision DEC-958-002 — normalizeStmtNames covers If, Assign, Raise, Return
 * @title Exhaustive stmt walker for param rename: recurse into If.test/body/orelse,
 *   Assign.value, Raise.message, Return.value. Pass, Docstring, ImpureStatement,
 *   Unsupported have no Name nodes to rewrite and pass through unchanged.
 * @status accepted (#958)
 * @rationale The original implementation only handled Return, leaving params inside
 *   If conditions, Assign right-hand sides, and Raise messages unrenamed. This caused
 *   the bs4 substitute_xml signature/body mismatch: the signature had camelCased param
 *   makeQuotedAttribute but the if-test still referenced make_quoted_attribute.
 */
function normalizeStmtNames(stmt: WireStmt, renameMap: Map<string, string>): WireStmt {
  switch (stmt.type) {
    case "Return":
      return {
        type: "Return",
        value: stmt.value !== null ? normalizeExprNames(stmt.value, renameMap) : null,
      };
    case "If":
      return {
        type: "If",
        test: normalizeExprNames(stmt.test, renameMap),
        body: stmt.body.map((s) => normalizeStmtNames(s, renameMap)),
        orelse: stmt.orelse.map((s) => normalizeStmtNames(s, renameMap)),
      };
    case "Assign":
      return {
        type: "Assign",
        target: stmt.target,
        value: normalizeExprNames(stmt.value, renameMap),
      };
    case "Raise":
      return {
        type: "Raise",
        excClass: stmt.excClass,
        message: stmt.message !== null ? normalizeExprNames(stmt.message, renameMap) : null,
      };
    // Pass, Docstring, ImpureStatement, Unsupported have no Name nodes to rewrite.
    default:
      return stmt;
  }
}
