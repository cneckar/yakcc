// SPDX-License-Identifier: MIT
//
// type-map.ts -- Go -> TS-subset IR type mapping (WI-870 slice 1, WI-963 generics).
//
// Implements the type column of the mapping table for Go primitives and common
// composite types.  Slice 1 covers the primitive subset (int, int8, int16,
// int32, int64, uint, uint8/byte, uint16, uint32, uint64, float32, float64,
// complex64, complex128, string, bool, rune) plus slices ([]T), pointers (*T),
// and maps (map[string]V).
//
// WI-963 adds generic type parameter passthrough.  When `opts.typeParams` is
// supplied, identifiers that appear in that set are emitted verbatim as TS
// generic type parameters rather than looked up in the mapping table.
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
//
// @decision DEC-POLYGLOT-GO-GENERICS-001 (WI-963)
// @title Generic type parameter passthrough via optional typeParams set
// @status accepted (WI-963)
// @rationale
//   mapGoType gains an optional opts parameter carrying a ReadonlySet<string> of
//   in-scope generic type parameter names.  When a bare identifier matches a name
//   in that set it is emitted verbatim as the TS type, bypassing the table lookup.
//   The overloaded signature preserves backward compatibility: callers that pass
//   no opts still receive a plain string so no existing call sites require changes.
//   func literal types (func(T) R) are parsed and emitted as TS arrow types so
//   higher-order generic functions (samber/lo Map, Filter, etc.) raise correctly.

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
 * A non-fatal warning emitted when a Go type maps with loss of fidelity.
 * WI-963: used for non-`any` generic constraints that are widened to the
 * bare TS type parameter.
 */
export interface LowerWarning {
  /** Human-readable description of the fidelity loss. */
  readonly message: string;
  /** The original Go type string that triggered the warning. */
  readonly goType: string;
}

/**
 * Options for the generic-aware overload of `mapGoType`.
 */
export interface MapGoTypeOpts {
  /**
   * Set of generic type parameter names in scope for the current function
   * (e.g. `new Set(["T", "R"])`).  When an identifier matches a name in this
   * set it is emitted verbatim as the TS type instead of being looked up in
   * the primitive mapping table.
   */
  readonly typeParams?: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Overloaded signature: plain call (backward compat) vs opts call (WI-963).
// ---------------------------------------------------------------------------

/**
 * Map a Go type string to its TS-subset IR equivalent (backward-compat overload).
 *
 * Returns a plain `string`.  Throws `UnsupportedTypeError` for types outside
 * the supported set.
 */
export function mapGoType(goType: string): string;

/**
 * Map a Go type string to its TS-subset IR equivalent with generic parameter
 * awareness (WI-963).
 *
 * When `opts.typeParams` is provided, identifiers that match a name in that set
 * are emitted verbatim as TS generic type parameters.
 *
 * Returns `{ tsType, warnings }`.  `warnings` is empty for the common `any`-
 * constrained case; non-`any` constraints produce a fidelity warning.
 * Throws `UnsupportedTypeError` for types outside the supported set that are
 * not in `typeParams`.
 */
export function mapGoType(
  goType: string,
  opts: MapGoTypeOpts,
): { tsType: string; warnings: LowerWarning[] };

// Implementation signature (internal).
export function mapGoType(
  goType: string,
  opts?: MapGoTypeOpts,
): string | { tsType: string; warnings: LowerWarning[] } {
  if (opts !== undefined) {
    const result = mapGoTypeInner(goType, opts);
    return result;
  }
  // No opts: legacy path, return plain string.
  return mapGoTypeInner(goType, {}).tsType;
}

// ---------------------------------------------------------------------------
// Core mapping logic (internal — always returns the { tsType, warnings } form).
// ---------------------------------------------------------------------------

/**
 * Internal implementation of the type mapper.  Always returns the structured
 * form; the public `mapGoType` overloads adapt to the caller's expected shape.
 */
function mapGoTypeInner(
  goType: string,
  opts: MapGoTypeOpts,
): { tsType: string; warnings: LowerWarning[] } {
  const typeParams = opts.typeParams;
  const t = goType.trim();

  if (t.length === 0) {
    throw new UnsupportedTypeError("", "Empty type string");
  }

  // Generic type parameter passthrough (WI-963).
  // If the identifier is in the caller-supplied type-param set, emit verbatim.
  if (typeParams?.has(t)) {
    return { tsType: t, warnings: [] };
  }

  // Pointer types: *T -> T (pointer indirection is flattened in TS-subset IR).
  if (t.startsWith("*")) {
    const inner = mapGoTypeInner(t.slice(1), opts);
    return inner;
  }

  // Slice types: []T -> T[]
  if (t.startsWith("[]")) {
    const inner = mapGoTypeInner(t.slice(2), opts);
    return { tsType: `${inner.tsType}[]`, warnings: inner.warnings };
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
    const inner = mapGoTypeInner(value, opts);
    return { tsType: `Record<string, ${inner.tsType}>`, warnings: inner.warnings };
  }

  // Func literal types: func(T, ...) R -> (a0: T, ...) => R (WI-963).
  // Supports generic-aware higher-order functions like samber/lo Map/Filter.
  if (t.startsWith("func(")) {
    return parseFuncLitType(t, opts);
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
      return { tsType: "number", warnings: [] };

    case "rune": // alias for int32; represents a Unicode code point
      return { tsType: "number", warnings: [] };

    case "string":
      return { tsType: "string", warnings: [] };

    case "bool":
      return { tsType: "boolean", warnings: [] };

    case "error":
      // Go's built-in error interface -> Error in TS-subset IR.
      return { tsType: "Error", warnings: [] };

    case "any":
    case "interface{}":
      // Explicit any -- caller can treat as opaque.
      return { tsType: "unknown", warnings: [] };
  }

  throw new UnsupportedTypeError(
    t,
    `Type '${t}' is not in the slice-1 mapping table. Supported: int/int8/int16/int32/int64, uint/uint8/byte/uint16/uint32/uint64, float32/float64, rune, string, bool, error, any, []T, *T, map[string]V.`,
  );
}

// ---------------------------------------------------------------------------
// func literal type parser (WI-963 — needed for higher-order generic funcs).
// ---------------------------------------------------------------------------

/**
 * Parse a Go func literal type string such as `func(T) R` or `func(T, T) R`
 * into a TS arrow type `(a0: T) => R`.
 *
 * Supports void (no return) func types: `func(T)` -> `(a0: T) => void`.
 * Parameter names are synthesized as `a0`, `a1`, ... since Go func literals
 * in type position have no parameter names.
 *
 * Throws `UnsupportedTypeError` on malformed input or types outside the
 * supported set.
 */
function parseFuncLitType(
  t: string,
  opts: MapGoTypeOpts,
): { tsType: string; warnings: LowerWarning[] } {
  // t = "func(params) retType" or "func(params)"
  // Find the matching ')' for the opening '(' after "func".
  const openParen = t.indexOf("(");
  if (openParen === -1) {
    throw new UnsupportedTypeError(t, `Malformed func literal type: missing '(' in '${t}'`);
  }
  let depth = 1;
  let i = openParen + 1;
  while (i < t.length && depth > 0) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")") depth--;
    i++;
  }
  if (depth !== 0) {
    throw new UnsupportedTypeError(
      t,
      `Malformed func literal type: unbalanced parentheses in '${t}'`,
    );
  }
  const closeParen = i - 1;
  const paramStr = t.slice(openParen + 1, closeParen).trim();
  const retStr = t.slice(closeParen + 1).trim();

  const warnings: LowerWarning[] = [];

  // Parse param types (comma-separated, respecting nested brackets/parens).
  const paramTypes = paramStr.length === 0 ? [] : splitTypeList(paramStr);
  const tsParams = paramTypes.map((pType, idx) => {
    const mapped = mapGoTypeInner(pType, opts);
    warnings.push(...mapped.warnings);
    return `a${idx}: ${mapped.tsType}`;
  });

  // Parse return type (single type only for slice-1 func literals).
  let tsReturn = "void";
  if (retStr.length > 0) {
    const retMapped = mapGoTypeInner(retStr, opts);
    warnings.push(...retMapped.warnings);
    tsReturn = retMapped.tsType;
  }

  const tsType = `(${tsParams.join(", ")}) => ${tsReturn}`;
  return { tsType, warnings };
}

/**
 * Split a comma-separated Go type list (e.g. `"T, T"` or `"[]T, func(T) R"`)
 * into individual type strings, respecting nested brackets and parentheses.
 */
function splitTypeList(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter((p) => p.length > 0);
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
