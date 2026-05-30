// SPDX-License-Identifier: MIT
//
// raise-function.ts — render a full TS-subset IR function declaration from a
// raised signature (slice 2) + structured body (slice 2b).  This is the
// composition layer: it does not parse, it only stitches.
//
// Slice 3 adds two passes that run around the existing pipeline:
//   Pre-mapping:  checkPurity(envelope)  — reject impure functions
//   Post-mapping: normalizeSignatureNames + normalizeBodyNames — snake→camel
//
// Pipeline order:
//   1. checkPurity(envelope)          [slice 3 — pre-mapping]
//   2. extractFunctionSignatures      [slice 2 — parse + type-map]
//   3. normalizeSignatureNames(sig)   [slice 3 — post-mapping]
//   4. buildParamRenameMap(orig)      [slice 3 — build rename set]
//   5. normalizeBodyNames(body, map)  [slice 3 — body walk]
//   6. renderFunctionDeclaration      [slice 2b — IR text render]

import type { LibcstParseResult, PythonAstNode } from "./libcst-parser.js";
import {
  buildParamRenameMap,
  normalizeBodyNames,
  normalizeSignatureNames,
} from "./normalize-names.js";
import type { FunctionSignature } from "./parse-fn-signature.js";
import { checkFunctionPurity, checkModuleImports } from "./purity-check.js";
import { type WireStmt, renderBody } from "./raise-body.js";

export { ImpureFunctionError } from "./purity-check.js";

/**
 * Render the full TS-subset IR text for one Python function.
 *
 * Accepts a pre-normalized signature (names already in camelCase) and a
 * pre-normalized body (Name references already rewritten).  The render step
 * itself is pure string concatenation — it does not apply normalization.
 *
 * Produces:
 *   export function <name>(p1: T1, p2: T2): R {
 *     <body>
 *   }
 *
 * Exports the function unconditionally so the emitted text is a valid
 * single-file module that downstream tooling can compile in isolation.
 */
/**
 * Render the full TS-subset IR text for one Python function.
 *
 * Accepts a pre-normalized signature (names already in camelCase) and a
 * pre-normalized body (Name references already rewritten).  The render step
 * itself is pure string concatenation — it does not apply normalization.
 *
 * Produces:
 *   export function <name>(p1: T1, p2: T2): R {
 *     <body>
 *   }
 *
 * Exports the function unconditionally so the emitted text is a valid
 * single-file module that downstream tooling can compile in isolation.
 *
 * @decision DEC-WI888-008 — Docstring-only body emits void 0;
 * @title Docstring nodes are filtered before the empty-body fallback check
 * @status accepted
 * @rationale A function whose only body statement is a docstring
 *   (def foo(): """doc""") is a legal no-op. After renderStmt silently drops
 *   Docstring nodes, the body text would be empty — syntactically valid but
 *   visually confusing. Filtering Docstrings before the void-0 check preserves
 *   the existing convention for no-op functions.
 *   Cross-reference: PLAN.md §4 / #888
 */
/**
 * Rewrite a dotted Python name to a valid TS identifier.
 *
 * WI-890: class method names arrive as "ClassName.methodName" (dotted) from
 * the libcst envelope.  A dot is not valid in a TS identifier, so we replace
 * every dot with an underscore: "Foo.bar" → "Foo_bar".
 *
 * The original dotted name is the canonical identity used for lookup in the
 * envelope (e.g. `raiseFunctionWithPurityAndNormalization` searches by
 * `signature.name`), so this rewrite happens only at render time — after all
 * envelope lookups have completed.
 *
 * @decision DEC-WI890-006 — dot-to-underscore rewrite at render time
 * @title Dotted method names rewritten to underscore form for TS identifier validity
 * @status accepted
 * @rationale Full round-trip metadata (original dotted name in a separate field)
 *   is deferred as out of scope for WI-890 MVP.  The underscore form is unique
 *   as long as no two methods share the same ClassName_methodName after rewrite —
 *   acceptable for the shave corpus.
 */
function tsIdentifier(name: string): string {
  return name.replace(/\./g, "_");
}

/**
 * Produce a snake_case-safe form of a dotted method name for `normalizeIdentifier`.
 *
 * WI-890: `normalizeIdentifier` in normalize-names.ts is not aware of dots and
 * would corrupt "MyClass.static_method" by splitting on `_` across the dot boundary.
 * This helper replaces dots with `_` BEFORE normalization so the dotted name
 * normalizes correctly:
 *   "MyClass.static_method" → "MyClass_static_method" → normalizeIdentifier
 *                           → "myClass_staticMethod" (camelCase per Rule 5)
 *
 * The actual TS identifier used in `renderFunctionDeclaration` comes from
 * `tsIdentifier(normalizedSig.name)`, which is equivalent to `normalizeIdentifier`
 * applied to the dot-replaced form.
 */
function dottedToSnake(name: string): string {
  return name.replace(/\./g, "_");
}

export function renderFunctionDeclaration(
  signature: FunctionSignature,
  body: readonly WireStmt[],
): string {
  const paramList = signature.params.map((p) => `${p.name}: ${p.tsType}`).join(", ");
  // WI-890: rewrite dotted names to valid TS identifiers at render time.
  const renderName = tsIdentifier(signature.name);
  // DEC-WI888-008: filter Docstring nodes before deciding the void-0 fallback and rendering.
  // A docstring-only body (visibleStmts.length === 0) produces void 0; just as an empty
  // body does. visibleStmts is passed to renderBody (not the full body) to avoid a leading
  // blank line from the empty string that renderStmt(Docstring) returns.
  // ImpureStatement nodes are NOT filtered by this step (only Docstrings are) — they remain
  // in visibleStmts and will throw at render time per DEC-WI888-005.
  const visibleStmts = body.filter((s) => s.type !== "Docstring");
  const bodyText =
    visibleStmts.length === 0 ? "  void 0;" : renderBody(visibleStmts, "  ", renderName);
  return `export function ${renderName}(${paramList}): ${signature.returnType} {\n${bodyText}\n}`;
}

/**
 * Full slice-3 raise pipeline: purity check → normalize → render.
 *
 * @param envelope  The libcst parse result (from parsePythonSource).
 * @param signature The function signature extracted by extractFunctionSignatures.
 * @param body      The wire-AST body statements.
 * @returns         TS-subset IR text for the function.
 *
 * Throws `ImpureFunctionError` if the function fails the purity check.
 * The purity check runs against the full envelope (for module-level import
 * analysis) before any normalization or rendering occurs.
 *
 * @decision DEC-POLYGLOT-SHAVE-PY-PIPELINE-001 (WI-782 slice 3)
 * @title Purity runs pre-mapping; normalization runs post-mapping
 * @status accepted (WI-782 slice 3)
 * @rationale
 *   Purity must run BEFORE type-mapping so impure functions are rejected
 *   before we produce any IR.  Normalization runs AFTER type-mapping because
 *   it operates on the already-mapped FunctionSignature (TS types are in
 *   tsType, not the name field).  Body normalization uses the original
 *   param names as the rename key set, so it must build the map from the
 *   pre-normalization signature and apply it to the body simultaneously.
 */
export function raiseFunctionWithPurityAndNormalization(
  envelope: LibcstParseResult,
  signature: FunctionSignature,
  body: readonly WireStmt[],
): string {
  // Step 1: purity check (pre-mapping — rejects before any IR is produced).
  // Phase A: module-level forbidden imports (apply to all functions in the module).
  checkModuleImports(envelope, signature.name);
  // Phase B: per-function purity — envelope.impurities[] and wire-AST body walk.
  // Find the matching function record in the envelope by name so we can check
  // its impurities[] array (emitted by the slice-3 Python script extension).
  const moduleNode = envelope.module as PythonAstNode;
  const fns = (moduleNode.functions as PythonAstNode[] | undefined) ?? [];
  const fnRecord =
    fns.find((fn) => String((fn as { name?: string }).name ?? "") === signature.name) ??
    ({ type: "FunctionDef", body: [] } as unknown as PythonAstNode);
  checkFunctionPurity(fnRecord, moduleNode, signature.name);

  // Step 2: normalize the signature names (post-mapping)
  //         Build rename map from ORIGINAL param names before normalizing,
  //         so the body walk has the correct old→new mapping.
  const renameMap = buildParamRenameMap(signature.params);
  // WI-890: if the function name is dotted ("ClassName.methodName"), replace
  // dots with underscores before normalizeSignatureNames so normalizeIdentifier
  // doesn't corrupt it by splitting across the dot boundary.
  // "Foo.static_bar" → "Foo_static_bar" → normalizeIdentifier → "foo_StaticBar"
  // tsIdentifier("foo_StaticBar") == "foo_StaticBar" (no dots remain).
  const sigForNormalize: typeof signature = signature.name.includes(".")
    ? { ...signature, name: dottedToSnake(signature.name) }
    : signature;
  const normalizedSig = normalizeSignatureNames(sigForNormalize);

  // Step 3: normalize body Name references
  const normalizedBody = normalizeBodyNames(body, renameMap);

  // Step 4: render
  return renderFunctionDeclaration(normalizedSig, normalizedBody);
}
