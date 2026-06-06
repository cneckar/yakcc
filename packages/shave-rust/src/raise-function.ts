// SPDX-License-Identifier: Apache-2.0
//
// raise-function.ts -- render a full TS-subset IR function declaration from a
// raised Rust signature.  This is the composition layer: it does not parse, it
// only stitches.
//
// Slice 1: signature surface only (params + return type).
// Slice 2 (WI-868-2C): structured body raise — renderBody from raise-body.ts
//   replaces the TODO stub.  Functions with a null body (extern/trait methods)
//   retain the void-body fallback.
//
// Mirrors packages/shave-go/src/raise-function.ts for the Rust adapter.
//
// @decision DEC-POLYGLOT-RUST-RAISE-FN-001 (WI-868 slice 1)
// @title raise-function.ts composes parse-fn-signature output into TS-subset IR text
// @status accepted (WI-868 slice 1, updated WI-868-2C)
// @rationale
//   The composition pattern follows shave-go and shave-python exactly:
//   parse-fn-signature.ts (slice 1) provides the typed signature; raise-function.ts
//   stitches param list, return type, and rendered body into an export declaration.
//   Keeping stitching separate from parsing allows each concern to evolve without
//   coupling.  Slice 2 wires renderBody (raise-body.ts) to consume the structured
//   body AST from the v2 wire envelope; functions with no block body (extern/trait
//   methods) use a void-body placeholder consistent with downstream tooling.

import type { FunctionSignature } from "./parse-fn-signature.js";
import { checkPurity } from "./purity-check.js";
import { renderBody } from "./raise-body.js";

/**
 * Render the full TS-subset IR text for one Rust function.
 *
 * Produces (slice 2+):
 *   export function <camelCaseName>(p1: T1, p2: T2): R {
 *     <rendered body statements>
 *   }
 *
 * For functions with no block body (extern/trait methods, body === null), emits:
 *   export function <camelCaseName>(p1: T1, p2: T2): R {
 *     void 0;
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
 * The `file` parameter threads through to raise-body.ts for CannotRaiseToIRError
 * location messages — matches the shave-go API surface.
 */
export function renderFunctionDeclaration(signature: FunctionSignature, file = "stdin.rs"): string {
  const paramList = signature.params.map((p) => `${p.name}: ${p.tsType}`).join(", ");
  const returnAnnotation = signature.returnType;

  // Slice 3: purity gate fires BEFORE body raise.
  // Throws RustMutableBorrowError / RustIoSideEffectError / RustAmbiguousPurityError
  // on impure functions so they never produce IR.
  checkPurity(signature, file);

  // Slice 2: consume structured body AST when present.
  // null body = extern/trait method without a block — emit void-body placeholder.
  const bodyText = signature.body !== null ? renderBody(signature.body, "  ", file) : "  void 0;";

  return `export function ${signature.name}(${paramList}): ${returnAnnotation} {\n${bodyText}\n}`;
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
