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
// WI-981 extends parseFuncLitType to handle named parameters inside Go func
// literal types (e.g. `func(item T) R` as the goType of an iteratee/predicate
// parameter).  Before WI-981, only anonymous-parameter func types worked
// (func(T) R); named ones like `func(item T, index int) R` (used by samber/lo
// Map, Filter, Reduce, etc.) threw UnsupportedTypeError on the "item T" token.
// The fix: strip the leading Go identifier from each comma-split parameter token
// when it is followed by a type-starting token.  Variadic `...T` forms are also
// handled.
//
// WI-991 adds user-defined type identifier passthrough.  Plain Go identifiers
// (e.g. `ifElse`, `Tuple3`) that are not in the primitive table and not in the
// typeParams set are passed through verbatim as TS types with a
// "user-defined-type-identifier" LowerWarning (mirroring shave-python #901).
// Parameterized user types (e.g. `Foo[T, R]`) are expanded to `Foo<T, R>` via
// recursive mapGoTypeInner calls on each type argument, preserving the current
// typeParams scope.
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
//
// @decision DEC-POLYGLOT-GO-NAMED-FUNC-PARAMS-001 (WI-981)
// @title Strip Go parameter names from func-literal-type parameter tokens
// @status accepted (WI-981)
// @rationale
//   In Go, `func(item T) R` is a valid function-typed parameter where "item" is
//   the parameter name and "T" is the type.  The type-mapper only needs the type
//   token for conversion; the name is discarded (TS arrow types use synthesized
//   names a0, a1, ...).  Detection rule: if a comma-split token starts with a Go
//   identifier (matches /^[A-Za-z_]\w*/) followed by a space followed by a
//   type-starting character (not itself an identifier start — so the second token
//   must start with *, [, f (for func), or be a known primitive), strip the first
//   token.  Variadic ...T strips the "..." prefix before type-mapping and treats
//   the result as a plain T (TS doesn't model variadic parameter types in arrow
//   signatures at slice-1).  This handles the full samber/lo iteratee/predicate
//   surface.

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
 * WI-991: adds `code` field (mirrors shave-python LowerWarning shape) and
 * adds the "user-defined-type-identifier" code for plain Go identifiers that
 * are not in the primitive mapping table.
 *
 * @decision DEC-SHAVE-GO-TYPE-MAP-991
 * @title LowerWarning gains stable `code` discriminant; user-defined identifiers pass through
 * @status accepted (WI-991)
 * @rationale
 *   Real Go codebases use user-defined types (type aliases, named structs,
 *   NewType-equivalent patterns) pervasively.  Throwing on every unknown
 *   identifier makes extraction fail for almost all annotated functions.
 *   Option A (pass-through with warning, matching shave-python #901) is the
 *   MVP: least friction, lets exploration proceed.  Adding `code` now aligns
 *   the LowerWarning shape with shave-python so future cross-package
 *   consumers can handle both without special-casing.  Only plain identifiers
 *   and identifier-bracketed generics (Foo[T,R]) are eligible; dotted names
 *   and other composite forms still throw.
 */
export interface LowerWarning {
  /**
   * Stable code identifying the warning category.
   * Adding new codes is non-breaking (no consumer should exhaustively switch
   * without a default branch).
   */
  readonly code: "user-defined-type-identifier";
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
  // Arrow types (from func literals) need parentheses to avoid precedence
  // ambiguity: []func(T) R must become ((a0: T) => R)[] not (a0: T) => R[].
  if (t.startsWith("[]")) {
    const inner = mapGoTypeInner(t.slice(2), opts);
    const needsParens = inner.tsType.includes("=>");
    const elemType = needsParens ? `(${inner.tsType})` : inner.tsType;
    return { tsType: `${elemType}[]`, warnings: inner.warnings };
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

  // Generic instantiation types: Foo[A, B, C] -> Foo<A, B, C> (#985).
  //
  // Go generic instantiation types appear in two contexts that block samber/lo:
  //   - Parameter types: `t Tuple3[A, B, C]` in Unpack3
  //   - Return types:    `Tuple3[A, B, C]` in T3, `[]Tuple2[A, B]` in Zip2
  //
  // Detection: a Go identifier (no brackets/parens/dots) followed immediately
  // by `[`.  This is distinct from slice types (which start with `[`) and map
  // types (which start with `map[`).  The type arguments are parsed with the
  // same bracket-depth-aware splitter used for func params.
  //
  // Each type argument is recursively mapped so that type params (e.g. A, B)
  // pass through verbatim (via typeParams set) and primitives are mapped.
  //
  // @decision DEC-POLYGLOT-GO-GENERIC-INST-001 (#985)
  // @title Generic instantiation types map Go Foo[A,B] to TS Foo<A,B>
  // @status accepted (#985)
  // @rationale
  //   samber/lo tuples.go uses Tuple2..Tuple9 as both parameter and return types
  //   in Unpack*, T*, Zip* functions.  The type string `Tuple3[A, B, C]` is
  //   emitted verbatim by go/ast's printer.Fprint for *ast.IndexListExpr nodes
  //   (Go 1.18+).  The TS equivalent is `Tuple3<A, B, C>` — a direct syntactic
  //   substitution of `[...]` with `<...>`.  Each type argument is recursively
  //   mapped so that generic type params pass through verbatim and primitives
  //   (string, int, bool) receive their proper TS mapping.  The detection rule
  //   (bare identifier + `[`) is unambiguous because: slice types start with
  //   bare `[`, map types start with `map[`, func types start with `func(`, and
  //   all other recognized patterns are handled before this branch.
  const bracketIdx = findGenericInstBracket(t);
  if (bracketIdx !== -1) {
    return parseGenericInstType(t, bracketIdx, opts);
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

  // ---------------------------------------------------------------------------
  // WI-991: User-defined generic type passthrough.
  // Pattern: Identifier[TypeArg, TypeArg, ...] where Identifier matches
  // /^[A-Za-z_][A-Za-z0-9_]*$/ and is followed immediately by '['.
  // The outer name passes through verbatim; each type argument is recursively
  // mapped via mapGoTypeInner (preserving the current typeParams scope).
  // Result: Name<MappedArg1, MappedArg2, ...> with a user-defined-type-identifier
  // warning on the outer name.
  //
  // This must come BEFORE the plain-identifier check so that `Foo[T]` is
  // expanded rather than thrown as a plain-identifier match (plain identifiers
  // do not contain '[').
  // ---------------------------------------------------------------------------
  const bracketIdx = t.indexOf("[");
  if (bracketIdx > 0) {
    const outerName = t.slice(0, bracketIdx);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(outerName)) {
      // Verify the rest is a balanced bracket list.
      const rest = t.slice(bracketIdx);
      if (rest.startsWith("[") && rest.endsWith("]")) {
        const inner = rest.slice(1, rest.length - 1);
        const typeArgs = splitTypeList(inner);
        if (typeArgs.length > 0) {
          const warnings: LowerWarning[] = [
            {
              code: "user-defined-type-identifier",
              message: `Go user-defined type '${outerName}' passed through verbatim`,
              goType: t,
            },
          ];
          const mappedArgs = typeArgs.map((arg) => {
            const mapped = mapGoTypeInner(arg, opts);
            warnings.push(...mapped.warnings);
            return mapped.tsType;
          });
          return { tsType: `${outerName}<${mappedArgs.join(", ")}>`, warnings };
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // WI-991: Plain user-defined type identifier pass-through.
  // A bare Go identifier (no brackets, no operators, no dots) that is not in
  // the mapping table and not in typeParams is likely a user-defined type
  // (type alias, named struct, etc.).  Pass it through verbatim as the TS
  // type name with a LowerWarning (mirrors shave-python #901).
  //
  // Acceptance rule:
  //   - PLAIN identifier: /^[A-Za-z_][A-Za-z0-9_]*$/  (no brackets or operators)
  //   - Known composite types ([]T, *T, map[K]V, func(...)) are handled above
  //   - Dotted names (pkg.Type) still throw (contain a dot)
  // ---------------------------------------------------------------------------
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    return {
      tsType: t,
      warnings: [
        {
          code: "user-defined-type-identifier",
          message: `Go user-defined type '${t}' passed through verbatim`,
          goType: t,
        },
      ],
    };
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
 * Parameter names are synthesized as `a0`, `a1`, ... since TS arrow types
 * in type position do not use Go parameter names.
 *
 * WI-981: Also handles named Go parameters like `func(item T, index int) R` —
 * go/ast's printer.Fprint preserves the parameter name when it is present in
 * the source.  The name token is detected and stripped before type-mapping.
 * Variadic `...T` (or `items ...T`) strips the `...` prefix and maps the base
 * type (TS does not model variadic arrow parameter types at slice-1).
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
  const paramTokens = paramStr.length === 0 ? [] : splitTypeList(paramStr);
  const tsParams = paramTokens.map((pToken, idx) => {
    const typeStr = stripGoParamName(pToken);
    const mapped = mapGoTypeInner(typeStr, opts);
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
 * Strip a Go parameter name from a func-literal parameter token.
 *
 * In Go, a parameter inside a func-literal type can appear in two forms:
 *   - Anonymous: just the type, e.g. `T`, `int`, `[]T`, `func(T) R`
 *   - Named: identifier + type, e.g. `item T`, `index int`, `items ...T`
 *
 * go/ast's printer.Fprint preserves the name when present.  We detect the
 * named form by checking whether the token starts with a bare Go identifier
 * (matches `[A-Za-z_]\w*`) followed by a space.  If yes, we strip the
 * identifier prefix to get the pure type token.
 *
 * Variadic parameters `...T` (or `items ...T`) have their `...` prefix
 * stripped because TS arrow types do not model variadic parameter types
 * at slice-1; the base element type is used instead.
 *
 * WI-981: This is the key fix for samber/lo iteratee/predicate shapes.
 */
function stripGoParamName(token: string): string {
  const t = token.trim();

  // Check for named parameter: starts with a Go identifier followed by a space.
  // A Go identifier is /^[A-Za-z_]\w*/; type-starting characters are not plain
  // identifiers before a space (they start with *, [, f(unc), or are keywords
  // we already handle).  We split on the first space and check that the prefix
  // is a pure identifier (no brackets, dots, etc.).
  const spaceIdx = t.indexOf(" ");
  if (spaceIdx > 0) {
    const prefix = t.slice(0, spaceIdx);
    const rest = t.slice(spaceIdx + 1).trim();
    // prefix is a plain Go identifier if it matches [A-Za-z_]\w* with no special
    // characters.  This distinguishes `item T` (name + type) from a type that
    // could never have a space in it (all Go types that contain spaces are not
    // valid in this position).
    if (/^[A-Za-z_]\w*$/.test(prefix)) {
      // Named parameter detected; rest is the type (possibly "...T" variadic).
      return stripVariadic(rest);
    }
  }

  // No name prefix — strip variadic `...` if present (unnamed variadic param).
  return stripVariadic(t);
}

/**
 * Strip a leading `...` variadic prefix from a Go type token.
 * `...T` -> `T`, `...[]int` -> `[]int`, `T` -> `T` (no-op).
 */
function stripVariadic(t: string): string {
  if (t.startsWith("...")) {
    return t.slice(3);
  }
  return t;
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

// ---------------------------------------------------------------------------
// #985: Generic instantiation type parser (Foo[A, B, C] -> Foo<A, B, C>)
// ---------------------------------------------------------------------------

/**
 * Find the index of the opening `[` that starts the type argument list for a
 * Go generic instantiation type (e.g. `Tuple3[A, B, C]`).
 *
 * Returns -1 if the type string does not match the `Identifier[...` pattern.
 *
 * Detection rule: the string must begin with one or more Go identifier
 * characters (`[A-Za-z_][\w.]*`) followed immediately by `[`.  This
 * distinguishes generic instantiations from:
 *   - slice types (`[]T` — starts with bare `[`)
 *   - map types   (`map[K]V` — handled by the `map[` branch above)
 *   - func types  (`func(...)` — handled by `func(` branch above)
 */
function findGenericInstBracket(t: string): number {
  // A generic instantiation name is a qualified or simple identifier:
  // e.g. "Tuple3", "lo.Tuple3", "MyPkg.Pair"
  // It must start with a letter or underscore and contain only word chars and dots.
  let i = 0;
  // Must start with an identifier character.
  if (i >= t.length || !/^[A-Za-z_]/.test(t)) {
    return -1;
  }
  // Consume identifier + qualified-name dots.
  while (i < t.length && /[\w.]/.test(t[i] ?? "")) {
    i++;
  }
  // At least one identifier character must have been consumed, and next char
  // must be `[`.
  if (i === 0 || i >= t.length || t[i] !== "[") {
    return -1;
  }
  return i;
}

/**
 * Parse a Go generic instantiation type `Name[T1, T2, ...]` into a TS
 * generic instantiation `Name<T1, T2, ...>`, recursively mapping each type
 * argument through `mapGoTypeInner`.
 *
 * Called only when `findGenericInstBracket` returned a non-negative index,
 * so the input is guaranteed to be `<identifier>[<typeArgs>]`.
 */
function parseGenericInstType(
  t: string,
  bracketIdx: number,
  opts: MapGoTypeOpts,
): { tsType: string; warnings: LowerWarning[] } {
  const name = t.slice(0, bracketIdx);

  // Find the matching closing `]` for the opening `[` at bracketIdx.
  let depth = 1;
  let i = bracketIdx + 1;
  while (i < t.length && depth > 0) {
    if (t[i] === "[") depth++;
    else if (t[i] === "]") depth--;
    i++;
  }
  if (depth !== 0) {
    throw new UnsupportedTypeError(
      t,
      `Malformed generic instantiation type: unbalanced brackets in '${t}'`,
    );
  }
  // Trailing characters after the closing `]` are not expected for a bare type.
  if (i !== t.length) {
    throw new UnsupportedTypeError(
      t,
      `Malformed generic instantiation type: unexpected trailing characters in '${t}'`,
    );
  }

  const argStr = t.slice(bracketIdx + 1, i - 1).trim();
  if (argStr.length === 0) {
    throw new UnsupportedTypeError(
      t,
      `Generic instantiation type has empty type argument list: '${t}'`,
    );
  }

  const argTokens = splitTypeList(argStr);
  const warnings: LowerWarning[] = [];
  const mappedArgs = argTokens.map((arg) => {
    const mapped = mapGoTypeInner(arg.trim(), opts);
    warnings.push(...mapped.warnings);
    return mapped.tsType;
  });

  return { tsType: `${name}<${mappedArgs.join(", ")}>`, warnings };
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
