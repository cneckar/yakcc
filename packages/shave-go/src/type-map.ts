// SPDX-License-Identifier: MIT
//
// type-map.ts -- Go -> TS-subset IR type mapping (WI-870 slice 1).
//
// Implements the type column of the mapping table for Go primitives and common
// composite types.  Slice 1 covers the primitive subset (int, int8, int16,
// int32, int64, uint, uint8/byte, uint16, uint32, uint64, float32, float64,
// complex64, complex128, string, bool, rune) plus slices ([]T), pointers (*T),
// and maps (map[string]V).
//
// Composite types are recursively mapped.  Types outside the supported set
// throw UnsupportedTypeError so callers can surface them via CannotRaiseToIRError
// (slice 4 wires that -- slice 1 throws plain UnsupportedTypeError so the
// dependency on @yakcc/contracts is not load-bearing yet).
//
// @decision DEC-POLYGLOT-GO-TYPE-MAP-001 (WI-870 slice 1)
// @title Go -> TS type mapping table; lossless within the documented subset
// @status accepted (WI-870 slice 1)
// @rationale
//   Go integer types all map to `number` in the TS-subset IR -- yakcc's IR
//   does not model machine-word widths at slice 1.  int64/uint64 precision
//   loss vs TS number is deliberately deferred to slice 3+ once the warning
//   channel exists (matching the Python shave approach).  complex64/complex128
//   are unsupported -- no TS-native equivalent without a library.

/**
 * Thrown when a Go type cannot be mapped to a TS-subset IR type using the
 * current MVP table.  Slice 4 will wrap these in `CannotRaiseToIRError` from
 * `@yakcc/contracts`.
 */
export class UnsupportedTypeError extends Error {
  constructor(
    public readonly goType: string,
    message?: string,
  ) {
    super(message ?? `Unsupported Go type for raise to TS-subset IR: ${goType}`);
    this.name = "UnsupportedTypeError";
  }
}

/**
 * Map a Go type string (e.g. "int", "[]string", "map[string]bool") to its
 * TS-subset IR equivalent.
 *
 * The input is whatever go/ast printed as the type expression.  Leading and
 * trailing whitespace is tolerated.
 *
 * Throws `UnsupportedTypeError` for types outside the slice 1 MVP set.
 */
export function mapGoType(goType: string): string {
  const t = goType.trim();
  if (t.length === 0) {
    throw new UnsupportedTypeError("", "Empty type string");
  }

  // Pointer types: *T -> T (pointer indirection is flattened in TS-subset IR).
  if (t.startsWith("*")) {
    return mapGoType(t.slice(1));
  }

  // Slice types: []T -> T[]
  if (t.startsWith("[]")) {
    return `${mapGoType(t.slice(2))}[]`;
  }

  // Map types: map[K]V -> Record<K, V>.  Slice 1 requires K = string.
  if (t.startsWith("map[")) {
    const { key, value } = parseMapType(t);
    if (key !== "string") {
      throw new UnsupportedTypeError(
        t,
        `map key must be 'string' for raise to TS-subset Record<string, V>; got '${key}'`,
      );
    }
    return `Record<string, ${mapGoType(value)}>`;
  }

  // Primitives -- signed integers
  switch (t) {
    case "int":
    case "int8":
    case "int16":
    case "int32":
    case "int64":
    case "uint":
    case "uint8":
    case "byte": // alias for uint8
    case "uint16":
    case "uint32":
    case "uint64":
    case "uintptr":
    case "float32":
    case "float64":
      return "number";

    case "rune": // alias for int32; represents a Unicode code point
      return "number";

    case "string":
      return "string";

    case "bool":
      return "boolean";

    case "error":
      // Go's built-in error interface -> Error in TS-subset IR.
      return "Error";

    case "any":
    case "interface{}":
      // Explicit any -- caller can treat as opaque.
      return "unknown";
  }

  throw new UnsupportedTypeError(
    t,
    `Type '${t}' is not in the slice-1 mapping table. Supported: int/int8/int16/int32/int64, uint/uint8/byte/uint16/uint32/uint64, float32/float64, rune, string, bool, error, any, []T, *T, map[string]V.`,
  );
}

/**
 * Parse a Go map type string like `map[string]int` or `map[string][]bool`
 * into key and value type strings.  Handles nested brackets in the value type.
 *
 * Throws `UnsupportedTypeError` if the string is not a valid map type.
 */
function parseMapType(t: string): { key: string; value: string } {
  // t must start with "map["
  const keyStart = 4; // length of "map["
  let depth = 1;
  let i = keyStart;
  while (i < t.length && depth > 0) {
    if (t[i] === "[") depth++;
    else if (t[i] === "]") depth--;
    i++;
  }
  if (depth !== 0) {
    throw new UnsupportedTypeError(t, `Malformed map type: unbalanced brackets in '${t}'`);
  }
  // keyEnd is the index of the closing ']' for the key bracket
  const keyEnd = i - 1;
  const key = t.slice(keyStart, keyEnd);
  const value = t.slice(i);
  if (key.length === 0 || value.length === 0) {
    throw new UnsupportedTypeError(t, `Malformed map type: empty key or value in '${t}'`);
  }
  return { key, value };
}
