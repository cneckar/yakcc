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
  normalizeIdentifier,
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
 * Rewrite a dotted Python name to a valid TS identifier preserving the class
 * name's CamelCase.
 *
 * WI-890: class method names arrive as "ClassName.methodName" (dotted) from
 * the libcst envelope.  A dot is not valid in a TS identifier.
 *
 * #941 (DEC-941-001): the original dot-to-underscore rewrite lost the class name
 * boundary when followed by `normalizeIdentifier`, causing it to treat
 * "EntitySubstitution_substitute_xml" as a single snake_case name →
 * "entitysubstitutionSubstituteXml".
 *
 * New: for dotted names, the function name is pre-processed by `dottedToSnake`
 * so that by the time it reaches `normalizeSignatureNames` it already has the
 * class name preserved: "ClassName.substituteXml" (dot still present but method
 * already camelCased).  Then `tsIdentifier` does a simple dot→underscore:
 * "ClassName.substituteXml" → "ClassName_substituteXml".
 *
 * For non-dotted names, `tsIdentifier` returns the name unchanged.
 *
 * The original dotted name is the canonical identity used for lookup in the
 * envelope (envelope lookups happen before this rewrite), so this is safe.
 *
 * @decision DEC-941-001 — tsIdentifier does simple dot-to-underscore on pre-normalized name
 * @title After dottedToSnake pre-normalizes the method part, tsIdentifier does dot→underscore
 * @status accepted (#941)
 */
function tsIdentifier(name: string): string {
  // Simple dot-to-underscore: "ClassName.substituteXml" → "ClassName_substituteXml".
  // For non-dotted names this is identity.
  return name.replace(/\./g, "_");
}

/**
 * Pre-normalize a dotted method name so that `normalizeSignatureNames` receives
 * a name with the class boundary already encoded as a dot (not underscore).
 *
 * WI-890/#941: for dotted names ("ClassName.method_name"), normalizeIdentifier
 * cannot handle dots — it would split "EntitySubstitution.substitute_xml" on
 * `_` across the dot, corrupting the class name casing.
 *
 * Strategy: normalize only the method part (after the dot), keep the class name
 * verbatim, and return "ClassName.camelMethodName".  normalizeSignatureNames then
 * calls normalizeIdentifier on this result; since "ClassName.camelMethodName"
 * has no underscores visible (the only `_` was inside the method part, now
 * camelCased away), normalizeIdentifier leaves it unchanged.  tsIdentifier at
 * render time does the final dot→underscore:
 *   "EntitySubstitution.substitute_xml"
 *   → dottedToSnake → "EntitySubstitution.substituteXml"
 *   → normalizeSignatureNames → "EntitySubstitution.substituteXml" (no change, no `_`)
 *   → tsIdentifier → "EntitySubstitution_substituteXml"
 *
 * For non-dotted names, this is identity (same as the original dottedToSnake).
 *
 * @decision DEC-941-002 — dottedToSnake normalizes only the method part of a dotted name
 * @title "ClassName.method_name" → "ClassName.methodName" (class name verbatim, method camelCased)
 * @status accepted (#941)
 * @rationale Feeds into normalizeSignatureNames which calls normalizeIdentifier;
 *   normalizeIdentifier must receive a name with no mixed-case-and-underscore
 *   boundary crossing the class name.  Normalizing only the method part and
 *   retaining the dot is the minimal-change fix that preserves class casing.
 */
function dottedToSnake(name: string): string {
  const dotIdx = name.indexOf(".");
  if (dotIdx < 0) {
    // Not dotted (module-level function) — original behaviour: no-op.
    return name;
  }
  // Dotted ("ClassName.method_name"): keep class name verbatim, normalize method part.
  const className = name.slice(0, dotIdx);
  const methodPart = name.slice(dotIdx + 1);
  return `${className}.${normalizeIdentifier(methodPart)}`;
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
  // #941 (DEC-941-002): for dotted names ("ClassName.method_name"), dottedToSnake
  // normalizes only the method part and keeps the class name verbatim with the dot:
  //   "EntitySubstitution.substitute_xml" → "EntitySubstitution.substituteXml"
  // normalizeSignatureNames then calls normalizeIdentifier on this result; since
  // "EntitySubstitution.substituteXml" contains no remaining underscores, it is
  // returned unchanged.  tsIdentifier() at render time does the final dot→underscore:
  //   "EntitySubstitution.substituteXml" → "EntitySubstitution_substituteXml"
  //
  // For non-dotted names, dottedToSnake is identity and the path is unchanged.
  const sigForNormalize: typeof signature = signature.name.includes(".")
    ? { ...signature, name: dottedToSnake(signature.name) }
    : signature;
  const normalizedSig = normalizeSignatureNames(sigForNormalize);

  // Step 3: normalize body Name references
  const normalizedBody = normalizeBodyNames(body, renameMap);

  // Step 4: render
  return renderFunctionDeclaration(normalizedSig, normalizedBody);
}
