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
import type { FunctionSignature, RaisedTypeParam } from "./parse-fn-signature.js";
import { renderBody } from "./raise-body.js";

// ---------------------------------------------------------------------------
// Constraint mapping table (#976, DEC-POLYGLOT-GO-CONSTRAINT-ROUNDTRIP-001)
//
// Maps well-known Go constraint expressions to TS-friendly `extends` names.
// These names are chosen to:
//   (a) be valid TS identifiers (no special chars like ~ or qualified names)
//   (b) be unambiguously reversible by compile-go's constraint back-mapper
//
// The reverse mapping lives in packages/compile-go/src/lower.ts.
// ---------------------------------------------------------------------------

const GO_CONSTRAINT_TO_TS: Readonly<Record<string, string>> = {
  any: "", // `any` -> no extends clause (default, omit for brevity)
  "constraints.Ordered": "Ordered", // golang.org/x/exp/constraints.Ordered
  comparable: "Comparable", // Go built-in comparable interface
};

/**
 * Map a Go constraint string to a TS `extends X` suffix.
 *
 * @decision DEC-POLYGLOT-GO-CONSTRAINT-ROUNDTRIP-001 (#976)
 * @title Go constraints preserved as TS `extends` clauses for round-trip fidelity
 * @status accepted (#976)
 * @rationale
 *   Prior to #976, ALL generic type params were emitted as `<T>` (no constraint),
 *   causing compile-go to emit `[T any]` regardless of the original Go constraint.
 *   Functions using `constraints.Ordered` (e.g. `Clamp`) then failed to compile
 *   because the `<` operator is not defined for `any`.
 *
 *   Solution: carry the constraint through the IR using TS's native `extends`
 *   syntax. Well-known Go constraints are mapped to short TS names that compile-go
 *   can reverse-map back to their canonical Go forms. Custom constraints and
 *   tilde-prefixed type sets (e.g. `~[]T`) are passed through with a `GoConstraint:`
 *   comment prefix so compile-go can reconstruct them precisely.
 *
 *   `any` maps to the empty string (no extends clause) because `<T>` already
 *   implies `any` in TS and `[T any]` is the Go default.
 */
function goConstraintToTsExtends(constraint: string): string {
  // Check the well-known mapping table first
  const mapped = GO_CONSTRAINT_TO_TS[constraint];
  if (mapped !== undefined) {
    return mapped; // "" means no extends clause
  }

  // Tilde type-set: `~[]T` (approximation type) — encode as GoConstraint prefix
  // compile-go reads this prefix and re-emits the original string verbatim.
  if (constraint.startsWith("~")) {
    // e.g. ~[]T -> GoConstraint_TildeT (not a valid TS type; encode as a name)
    // Safer: pass it through as a string that compile-go will pattern-detect.
    // We use a synthetic TS name with the tilde-form encoded in the constraint.
    return `GoConstraint_${encodeConstraint(constraint)}`;
  }

  // Custom interface or unknown constraint: pass through verbatim as a TS name.
  // e.g. `MyInterface` -> `extends MyInterface`
  // This covers single-identifier custom constraints (the common case).
  return constraint;
}

/**
 * Encode a Go constraint string as a valid TS identifier fragment.
 * Used for tilde type-sets that cannot be expressed as plain TS types.
 * compile-go decodes this back to the original constraint string.
 *
 * Encoding: replace non-identifier characters with underscores, preserving
 * enough information for the reverse mapping.
 */
function encodeConstraint(constraint: string): string {
  // ~[]T -> Tilde_SliceOf_T (simple heuristic for the common case)
  // The encoding is reversible for the patterns we support.
  return constraint
    .replace(/^~\[\]/, "Tilde_SliceOf_")
    .replace(/^~/, "Tilde_")
    .replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Render a single type parameter as a TS generic with optional extends clause.
 * Returns e.g. "T", "T extends Ordered", "T extends Comparable".
 */
function renderTypeParam(tp: RaisedTypeParam): string {
  const tsExtends = goConstraintToTsExtends(tp.constraint);
  if (tsExtends === "") {
    return tp.name;
  }
  return `${tp.name} extends ${tsExtends}`;
}

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
 *
 * #976: type parameters now carry `extends <Constraint>` when the Go function
 * has a non-`any` constraint, enabling compile-go to reconstruct the original
 * Go constraint.
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

  // WI-963 + #976: emit TS generic type parameters with constraint extends clauses.
  // e.g. typeParams=[{name:"T", constraint:"constraints.Ordered"}] -> "<T extends Ordered>"
  // e.g. typeParams=[{name:"T", constraint:"any"}] -> "<T>" (no extends for any)
  const typeParamSuffix =
    signature.typeParams.length > 0
      ? `<${signature.typeParams.map(renderTypeParam).join(", ")}>`
      : "";

  const bodyText = renderBody(body, "  ", file);
  return `export function ${signature.name}${typeParamSuffix}(${paramList}): ${returnAnnotation} {\n${bodyText}\n}`;
}
