// SPDX-License-Identifier: Apache-2.0
//
// name-normalize.ts -- Rust identifier normalization for the TS-subset IR (WI-868 slice 1).
//
// Rust uses snake_case for function names, variables, and module items.
// The TS-subset IR uses camelCase for function/variable identifiers.
// This module converts Rust snake_case -> JS camelCase so raised functions
// have idiomatic TS names.
//
// This is the genuinely Rust-specific difference from shave-go:
//   - shave-go: Go names are already PascalCase/camelCase-compatible — no-op.
//   - shave-rust: Rust names are snake_case — must convert.
//
// Mirror: compile-python/src/names.ts provides the inverse direction
// (camelCase -> snake_case for Python lower).  This module is the raise
// direction (Rust -> TS) and performs snake_case -> camelCase conversion.
//
// @decision DEC-POLYGLOT-RUST-NAME-NORMALIZE-001 (WI-868 slice 1)
// @title Rust snake_case identifiers are converted to camelCase for TS-subset IR
// @status accepted (WI-868 slice 1)
// @rationale
//   Rust idiomatically uses snake_case for all function and variable names.
//   The TS-subset IR and downstream consumers expect camelCase (the JS/TS
//   convention for non-class identifiers).  shave-go requires no conversion
//   because Go already uses camelCase/PascalCase.  shave-python performs the
//   same conversion (snake_case -> camelCase).  ALL_CAPS constants are
//   lowercased then camelCased to prevent shouting in TS output.
//   PascalCase identifiers (type names that occasionally appear as function
//   names in impl blocks) are preserved as-is.

/**
 * Thrown when a Rust identifier cannot be normalized to a TS-compatible name.
 * Rejects blank names and names with characters not valid in TS identifiers.
 */
export class InvalidIdentifierError extends Error {
  constructor(
    public readonly identifier: string,
    message?: string,
  ) {
    super(message ?? `Invalid Rust identifier for TS normalization: '${identifier}'`);
    this.name = "InvalidIdentifierError";
  }
}

/**
 * Convert a Rust snake_case identifier to a JS camelCase identifier.
 *
 * Conversion rules:
 *   - Each `_word` segment after the first has its leading letter capitalized.
 *   - Leading underscores are preserved (e.g. `_internal` -> `_internal`).
 *   - Trailing underscores are stripped (Rust convention for reserved-word escaping
 *     e.g. `type_` -> `type`).
 *   - ALL_CAPS identifiers (typical for constants) are lowercased then camelCased
 *     (e.g. `MAX_VALUE` -> `maxValue`).
 *   - PascalCase identifiers (e.g. struct names that appear as type strings) are
 *     preserved as-is since they are already valid TS.
 *   - Empty string -> throws InvalidIdentifierError.
 *   - Names with characters invalid in a JS identifier -> throws.
 *
 * @example
 *   normalizeRustName("add")           // "add"
 *   normalizeRustName("add_numbers")   // "addNumbers"
 *   normalizeRustName("get_user_id")   // "getUserId"
 *   normalizeRustName("_private")      // "_private"
 *   normalizeRustName("MAX_VALUE")     // "maxValue"
 *   normalizeRustName("MyStruct")      // "MyStruct"  (PascalCase preserved)
 *   normalizeRustName("type_")         // "type"      (trailing _ stripped)
 */
export function normalizeRustName(name: string): string {
  if (name.length === 0) {
    throw new InvalidIdentifierError(name, "Rust identifier must not be empty");
  }

  // Validate: only valid Rust/JS identifier characters allowed.
  // Rust identifiers: [A-Za-z_][A-Za-z0-9_]*  (raw identifiers r# excluded)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new InvalidIdentifierError(
      name,
      `Rust identifier '${name}' contains characters not valid in a TypeScript identifier`,
    );
  }

  // PascalCase input: starts with uppercase and has no underscores (or is all-caps
  // struct-like).  Simple heuristic: if it starts with an uppercase letter and
  // contains no underscores, treat as already-TS-compatible PascalCase.
  if (/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    return name;
  }

  // Count leading underscores (preserve them).
  let leadingUnderscores = 0;
  while (leadingUnderscores < name.length && name[leadingUnderscores] === "_") {
    leadingUnderscores++;
  }
  const prefix = name.slice(0, leadingUnderscores);
  let body = name.slice(leadingUnderscores);

  // Strip trailing underscores (Rust reserved-word-escape convention).
  while (body.endsWith("_")) {
    body = body.slice(0, -1);
  }

  if (body.length === 0) {
    // Name was all underscores (e.g. `__`) — return as-is after validation.
    return name;
  }

  // ALL_CAPS check: every non-underscore character is uppercase.
  // e.g. MAX_VALUE, HTTP_CLIENT -> maxValue, httpClient
  const nonUnderscore = body.replace(/_/g, "");
  const isAllCaps =
    nonUnderscore.length > 0 &&
    nonUnderscore === nonUnderscore.toUpperCase() &&
    /[A-Z]/.test(nonUnderscore);
  const normalized = isAllCaps ? body.toLowerCase() : body;

  // Split on underscores and camelCase.
  const segments = normalized.split("_").filter((s) => s.length > 0);
  if (segments.length === 0) {
    return prefix + body;
  }

  const first = segments[0] ?? "";
  const rest = segments.slice(1).map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1));

  return prefix + first + rest.join("");
}

/**
 * Return true when the Rust identifier is exported (public).
 *
 * In Rust, visibility is determined by `pub` keyword on the item, not by naming
 * convention.  This helper is a convenience for callers that already extracted
 * isPub from the AST envelope and want to query it as a boolean.
 *
 * Provided for API symmetry with shave-go's `isExported`.
 */
export function isPublic(isPub: boolean): boolean {
  return isPub;
}
