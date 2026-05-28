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
export function renderFunctionDeclaration(
  signature: FunctionSignature,
  body: readonly WireStmt[],
): string {
  const paramList = signature.params.map((p) => `${p.name}: ${p.tsType}`).join(", ");
  const bodyText = body.length === 0 ? "  void 0;" : renderBody(body, "  ");
  return `export function ${signature.name}(${paramList}): ${signature.returnType} {\n${bodyText}\n}`;
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
  const normalizedSig = normalizeSignatureNames(signature);

  // Step 3: normalize body Name references
  const normalizedBody = normalizeBodyNames(body, renameMap);

  // Step 4: render
  return renderFunctionDeclaration(normalizedSig, normalizedBody);
}
