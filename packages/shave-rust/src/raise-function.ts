// SPDX-License-Identifier: Apache-2.0
//
// raise-function.ts -- render a full TS-subset IR function declaration from a
// raised Rust signature (slice 1).  This is the composition layer: it does not
// parse, it only stitches.
//
// Slice 1: signature surface only (params + return type).
// Slice 2 will add structured body raise (render body statements).
//
// Mirrors packages/shave-go/src/raise-function.ts for the Rust adapter.
//
// @decision DEC-POLYGLOT-RUST-RAISE-FN-001 (WI-868 slice 1)
// @title raise-function.ts composes parse-fn-signature output into TS-subset IR text
// @status accepted (WI-868 slice 1)
// @rationale
//   The composition pattern follows shave-go and shave-python exactly:
//   parse-fn-signature.ts (slice 1) provides the typed signature; raise-function.ts
//   stitches param list, return type, and body placeholder into an export declaration.
//   Keeping stitching separate from parsing allows each concern to evolve without
//   coupling.  In slice 1 the body is a stub comment — slice 2 will replace it with
//   the rendered body AST.

import type { FunctionSignature } from "./parse-fn-signature.js";

/**
 * Render the full TS-subset IR text for one Rust function.
 *
 * Produces:
 *   export function <camelCaseName>(p1: T1, p2: T2): R {
 *     // TODO: body raise (slice 2)
 *   }
 *
 * For void functions (returnType === "void") the return annotation is `void`.
 *
 * Exports the function unconditionally so the emitted text is a valid
 * single-file module that downstream tooling can compile in isolation.
 *
 * Name normalization (snake_case -> camelCase) is already applied by
 * parse-fn-signature.ts; this function uses `signature.name` directly.
 *
 * The `file` parameter is used in future slice error messages (CannotRaiseToIRError
 * location) — accepted now to match the shave-go API surface.
 */
export function renderFunctionDeclaration(
  signature: FunctionSignature,
  _file = "stdin.rs",
): string {
  const paramList = signature.params.map((p) => `${p.name}: ${p.tsType}`).join(", ");

  const returnAnnotation = signature.returnType;

  return `export function ${signature.name}(${paramList}): ${returnAnnotation} {\n  // TODO: body raise (slice 2)\n}`;
}

/**
 * Render only the TS function signature line (no body block).
 *
 * Useful for interface generation and documentation tooling.
 *
 * Returns a string of the form:
 *   (p1: T1, p2: T2) => R
 */
export function renderSignatureType(signature: FunctionSignature): string {
  const paramList = signature.params.map((p) => `${p.name}: ${p.tsType}`).join(", ");
  return `(${paramList}) => ${signature.returnType}`;
}
