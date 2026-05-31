// SPDX-License-Identifier: MIT
/**
 * Identifier transforms for the IR->Go lower adapter.
 *
 * Go identifier conventions differ from TypeScript in two ways:
 *   1. Exported identifiers start with an uppercase letter (PascalCase).
 *   2. Unexported (local) identifiers start with lowercase (camelCase is fine).
 *
 * The IR uses camelCase function names for exported TS functions. When lowering
 * to Go we capitalise the first letter to make them exported Go functions.
 * Local variable names and parameter names stay camelCase (idiomatic Go).
 *
 * @decision DEC-WI973-002
 * @title compile-go names.ts: exported IR identifiers -> PascalCase Go exported names
 * @status accepted (WI-973)
 * @rationale
 *   Go's visibility rule is mechanical: first-letter uppercase = exported.
 *   IR function names that originate from TS `export function foo(...)` should
 *   become `func Foo(...)` in Go so callers outside the package can use them.
 *   Parameter and local variable names keep camelCase because Go style prefers
 *   short camelCase locals (unlike Python's snake_case preference).
 *   This is the minimal transform needed for idiomatic round-trip correctness.
 */

/**
 * Convert a camelCase function name to PascalCase for Go export.
 * "add" -> "Add", "myFunc" -> "MyFunc", "parseIntLeadingZeros" -> "ParseIntLeadingZeros"
 * Already-PascalCase names are returned unchanged.
 * Empty string returns empty string.
 */
export function toGoExportedName(name: string): string {
  if (!name) return name;
  return name[0]?.toUpperCase() + name.slice(1);
}

/**
 * Keep a local (parameter / variable) identifier as-is.
 * Go uses camelCase for locals, which matches TS-subset IR identifiers directly.
 * This function is a no-op but exists as a named transform so the lower adapter
 * always calls a named function (symmetry with toGoExportedName). Future
 * Implementers can hook normalization here without touching lower.ts.
 */
export function toGoLocalName(name: string): string {
  return name;
}
