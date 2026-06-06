// SPDX-License-Identifier: Apache-2.0
//
// names.ts -- camelCase -> snake_case identifier transform for the IR->Rust lower adapter.
//
// The IR uses camelCase for all function and variable names (TS/JS convention).
// Rust idiomatically uses snake_case for function names, parameters, and locals.
// This module is the inverse of shave-rust/src/name-normalize.ts (snake->camel).
//
// @decision DEC-POLYGLOT-RUST-COMPILE-NAMES-001
// @title IR camelCase identifiers -> snake_case for Rust lower; inverse of shave-rust name-normalize
// @status decided (Slice 1)
// @rationale
//   Mirrors compile-python/src/names.ts (camelCase -> snake_case for Python).
//   shave-rust normalizes Rust snake_case -> camelCase on raise; this module
//   performs the inverse direction on lower.  The identity is:
//     normalizeRustName(toRustSnakeCase(name)) === name  (for simple names)
//   PascalCase type names (e.g. String, Error) are NOT converted -- they appear
//   in type positions, not identifier positions.  fn/param/local identifiers go
//   through toRustSnakeCase; type strings go through lowerTypeNode.

/**
 * Convert a camelCase or PascalCase identifier to Rust snake_case.
 *
 * Conversion rules (inverse of shave-rust normalizeRustName):
 *   - Inserts '_' before each uppercase letter that follows a lowercase or digit.
 *   - Lowercases the entire result.
 *   - Leading underscores are preserved.
 *   - Empty string -> empty string (no throw; let callers handle empty).
 *
 * @example
 *   toRustSnakeCase("add")          // "add"
 *   toRustSnakeCase("addNumbers")   // "add_numbers"
 *   toRustSnakeCase("getUserId")    // "get_user_id"
 *   toRustSnakeCase("myFuncABC")    // "my_func_abc"
 *   toRustSnakeCase("_private")     // "_private"
 *   toRustSnakeCase("maxValue")     // "max_value"
 */
export function toRustSnakeCase(name: string): string {
  if (!name) return name;

  // Count leading underscores (preserve them)
  let leadingUnderscores = 0;
  while (leadingUnderscores < name.length && name[leadingUnderscores] === "_") {
    leadingUnderscores++;
  }
  const prefix = name.slice(0, leadingUnderscores);
  const body = name.slice(leadingUnderscores);

  // Insert underscore before sequences of uppercase letters that follow a
  // lowercase letter or digit, then lowercase everything.
  // e.g. "addNumbers" -> "add_Numbers" -> "add_numbers"
  // e.g. "myFuncABC" -> "my_func_abc" (contiguous uppercase blocks stay together)
  const snaked = body
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

  return prefix + snaked;
}

/**
 * Keep a Rust function name as snake_case.
 * Equivalent to toRustSnakeCase for function names -- exists for API symmetry
 * with compile-go (toGoExportedName / toGoLocalName pairing).
 */
export function toRustFunctionName(name: string): string {
  return toRustSnakeCase(name);
}

/**
 * Keep a local (parameter / variable) identifier as snake_case.
 * Same transform as toRustSnakeCase; exists as a named function for symmetry.
 */
export function toRustLocalName(name: string): string {
  return toRustSnakeCase(name);
}
