// SPDX-License-Identifier: MIT
//
// raise-function.ts — render a full TS-subset IR function declaration from a
// raised signature (slice 2) + structured body (slice 2b).  This is the
// composition layer: it does not parse, it only stitches.

import type { FunctionSignature } from "./parse-fn-signature.js";
import { renderBody, type WireStmt } from "./raise-body.js";

/**
 * Render the full TS-subset IR text for one Python function.
 *
 * Produces:
 *   export function <name>(p1: T1, p2: T2): R {
 *     <body>
 *   }
 *
 * Exports the function unconditionally so the emitted text is a valid
 * single-file module that downstream tooling can compile in isolation.
 * Naming normalization (`snake_case` → `camelCase`) is deferred to slice 3.
 */
export function renderFunctionDeclaration(
  signature: FunctionSignature,
  body: readonly WireStmt[],
): string {
  const paramList = signature.params
    .map((p) => `${p.name}: ${p.tsType}`)
    .join(", ");
  const bodyText = body.length === 0 ? "  void 0;" : renderBody(body, "  ");
  return `export function ${signature.name}(${paramList}): ${signature.returnType} {\n${bodyText}\n}`;
}
