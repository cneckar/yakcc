// SPDX-License-Identifier: MIT
//
// raise-function.ts -- render a full TS-subset IR function declaration from a
// raised Go signature (slice 1) + structured body (slice 2).  This is the
// composition layer: it does not parse, it only stitches.
//
// Mirrors packages/shave-python/src/raise-function.ts for the Go adapter.
//
// @decision DEC-POLYGLOT-GO-RAISE-FN-001 (WI-870 slice 2)
// @title raise-function.ts composes parse-fn-signature + raise-body, no direct parsing
// @status accepted (WI-870 slice 2)
// @rationale
//   The composition pattern follows shave-python's raise-function.ts exactly:
//   the signature surface (Slice-1: parse-fn-signature.ts) and the body raiser
//   (Slice-2: raise-body.ts) are independent concerns.  Keeping them separate
//   allows each to evolve without coupling.  raise-function.ts owns only the
//   stitching logic — param list formatting, return type, body indentation.

import type { GoAstBodyNode } from "./go-ast-parser.js";
import type { FunctionSignature } from "./parse-fn-signature.js";
import { renderBody } from "./raise-body.js";

/**
 * Render the full TS-subset IR text for one Go function.
 *
 * Produces:
 *   export function <name>(p1: T1, p2: T2): R {
 *     <body>
 *   }
 *
 * For Go functions with multiple return types (returnTypes.length > 1) the
 * TS return annotation is rendered as a tuple: [T1, T2].
 * For void functions (returnTypes.length === 0) the return annotation is
 * `void`.
 *
 * Exports the function unconditionally so the emitted text is a valid
 * single-file module that downstream tooling can compile in isolation.
 * Name normalization (Go PascalCase -> camelCase) is deferred to slice 3.
 *
 * Throws CannotRaiseToIRError (via raise-body.ts) if the body contains a
 * banned construct (goroutine, channel, select, defer) or an unsupported
 * statement/expression type.
 */
export function renderFunctionDeclaration(
  signature: FunctionSignature,
  body: GoAstBodyNode,
  file = "stdin.go",
): string {
  const paramList = signature.params.map((p) => `${p.name}: ${p.tsType}`).join(", ");

  let returnAnnotation: string;
  if (signature.returnTypes.length === 0) {
    returnAnnotation = "void";
  } else if (signature.returnTypes.length === 1) {
    returnAnnotation = signature.returnTypes[0] ?? "void";
  } else {
    returnAnnotation = `[${signature.returnTypes.join(", ")}]`;
  }

  const bodyText = renderBody(body, "  ", file);
  return `export function ${signature.name}(${paramList}): ${returnAnnotation} {\n${bodyText}\n}`;
}
