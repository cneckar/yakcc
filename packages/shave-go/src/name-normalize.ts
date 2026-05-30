// SPDX-License-Identifier: MIT
//
// name-normalize.ts -- Go identifier normalization for the TS-subset IR (WI-870 slice 1).
//
// Go uses PascalCase (UpperCamelCase) for exported identifiers and camelCase
// for unexported ones.  The TS-subset IR preserves this convention:
//   - Exported Go names (start with uppercase): preserved as-is (PascalCase is
//     valid camelCase in TS and common for class/interface names).
//   - Unexported Go names (start with lowercase): preserved as-is (they are
//     already camelCase-compatible for TS local variables and function names).
//
// No rename is performed in slice 1 -- Go naming is already idiomatic TS.
// Slice 3 will add opinion-layer normalization if the IR policy requires it.
//
// Mirror: compile-python/src/names.ts provides the inverse direction
// (camelCase -> snake_case for Python lower).  This module is the raise
// direction (Go -> TS) and simply validates + preserves the name.

/**
 * Thrown when a Go identifier cannot be normalized to a TS-compatible name.
 * Slice 1 only rejects blank names and names with Go-specific characters not
 * valid in TS (currently none in practice, but validated for safety).
 */
export class InvalidIdentifierError extends Error {
  constructor(
    public readonly identifier: string,
    message?: string,
  ) {
    super(message ?? `Invalid Go identifier for TS normalization: '${identifier}'`);
    this.name = "InvalidIdentifierError";
  }
}

/**
 * Normalize a Go identifier to a TS-compatible name.
 *
 * Policy (slice 1):
 *   - Exported names (start with uppercase letter) -> preserved as-is.
 *     E.g. "Add", "ParseFnSignature", "HTTPClient" -> same.
 *   - Unexported names (start with lowercase letter or underscore) -> preserved
 *     as-is.  E.g. "add", "parseFnSignature", "_internal" -> same.
 *   - Blank string -> throws InvalidIdentifierError.
 *   - Names containing characters invalid in a JS identifier -> throws.
 *
 * Slice 3 will introduce optional snake_case -> camelCase conversion for
 * identifiers that arrive from Go cgo or generated code.
 */
export function normalizeGoName(name: string): string {
  if (name.length === 0) {
    throw new InvalidIdentifierError(name, "Go identifier must not be empty");
  }
  // JS identifier validity: starts with letter, $, or _; rest are letters,
  // digits, $, or _.  Go identifiers also follow this rule (minus $ in Go),
  // so any valid Go identifier is already a valid JS identifier.
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    throw new InvalidIdentifierError(
      name,
      `Go identifier '${name}' contains characters not valid in a TypeScript identifier`,
    );
  }
  return name;
}

/**
 * Return true when the Go identifier is exported (starts with an uppercase letter).
 *
 * Per the Go spec: an identifier is exported if it begins with a Unicode upper
 * case letter.  Slice 1 restricts to ASCII uppercase for simplicity; unicode
 * exported identifiers (rare in practice) will return false here.
 */
export function isExported(name: string): boolean {
  if (name.length === 0) return false;
  const first = name.charCodeAt(0);
  return first >= 65 && first <= 90; // 'A'..'Z'
}
