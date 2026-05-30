// SPDX-License-Identifier: MIT
//
// type-map.ts — Python → TS-subset IR type mapping (WI-782 slice 2 + WI-889).
//
// Implements the type column of the mapping table from #782 spec (and ADR Q2).
// Slice 2 supports the primitive subset (int/float/str/bool/None) plus the
// common containers (list[T], dict[str,V], Optional[T], tuple[A,B], Union[A,B]).
// Composite types are recursively mapped.
//
// Slice 4: UnsupportedTypeError now extends CannotRaiseToIRError for unified
// error hierarchy per #782 acceptance criteria.
//
// WI-889: adds LowerWarning channel and five new type widenings:
//   - Any / typing.Any → unknown (DEC-WI889-001)
//   - Quoted forward references "Foo" / 'Foo' — strip and recurse (DEC-WI889-002)
//   - Callable (bare), Callable[..., R], Callable[[A1,...], R] (DEC-WI889-003)
//   - ModuleType / types.ModuleType → unknown (DEC-WI889-004)
//   - dict[Any, V] → Record<string, V> with warning (DEC-WI889-005)
//   - mapPythonType return shape changed from string → MapPythonTypeResult (DEC-WI889-006)
//
// @decision DEC-POLYGLOT-SHAVE-PY-TYPE-MAP-001 (WI-782 slice 2)
// @title Python → TS type mapping table; lossless within the documented subset
// @status accepted (WI-782 slice 2, extended WI-889)
// @rationale
//   ADR Q2's mapping table is the authoritative source.  We re-encode it here
//   as TypeScript so the raise adapter can apply it mechanically.  Cross-typed
//   atoms (Python int + TS bigint) are deliberately rejected — see #782
//   "Type precision" section: int → number with warn-on-loss is deferred to
//   slice 3+ once the warning channel exists.  WI-889 implements the warning
//   channel (LowerWarning) and uses it for five new widenings.

import { CannotRaiseToIRError, type SourceLocation } from "@yakcc/contracts";

const UNKNOWN_TYPE_LOCATION: SourceLocation = { file: "<type-annotation>", line: 0, col: 0 };

/**
 * Thrown when a Python type annotation cannot be mapped to a TS-subset IR
 * type using the current MVP table.
 *
 * Extends `CannotRaiseToIRError` so callers can catch either class.
 * The `pythonType` string is forwarded as the `construct` field of the parent.
 */
export class UnsupportedTypeError extends CannotRaiseToIRError {
  constructor(
    public readonly pythonType: string,
    message?: string,
  ) {
    super(
      pythonType,
      UNKNOWN_TYPE_LOCATION,
      message ?? `Unsupported Python type for raise to TS-subset IR: ${pythonType}`,
    );
    this.name = "UnsupportedTypeError";
  }
}

// ---------------------------------------------------------------------------
// WI-889: LowerWarning channel (DEC-WI889-007, DEC-WI889-008)
// ---------------------------------------------------------------------------

/**
 * A structured warning emitted when a Python annotation is mapped to a TS
 * equivalent that widens the original type contract.
 *
 * `code` is a stable string-literal union — adding a member is non-breaking.
 * Consumers that care about specific widening kinds should switch on `code`.
 * No console/stderr side-effect is produced — warnings are structured data
 * only (DEC-WI889-008); presentation is the caller's responsibility.
 *
 * @decision DEC-WI889-007
 * @title LowerWarning lives in shave-python, not @yakcc/contracts
 * @status accepted
 * @rationale Only one package consumes it today; cross-package promotion can
 *   come when a second consumer appears.
 */
export interface LowerWarning {
  /**
   * Stable code identifying the warning category.
   * Adding new codes is non-breaking (no consumer should exhaustively switch
   * without a default branch).
   */
  readonly code:
    | "any-widened" // typing.Any → unknown
    | "callable-widened" // bare Callable or Callable[..., R]
    | "module-type-widened" // types.ModuleType → unknown
    | "dict-any-key-widened"; // dict[Any, V] → Record<string, V>
  /** Human-readable message for diagnostics. */
  readonly message: string;
  /** The original Python annotation fragment that triggered the warning. */
  readonly pythonFragment: string;
}

/**
 * Return shape of `mapPythonType` (changed in WI-889).
 *
 * @decision DEC-WI889-006
 * @title mapPythonType returns { tsType, warnings } (option b)
 * @status accepted
 * @rationale Immutable, composable, smallest blast radius for two call sites
 *   in parse-fn-signature.ts.  Recursion composes naturally by concatenating
 *   warnings on the way up.
 */
export interface MapPythonTypeResult {
  readonly tsType: string;
  readonly warnings: readonly LowerWarning[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convenience factory for a result with no warnings. */
function ok(tsType: string): MapPythonTypeResult {
  return { tsType, warnings: [] };
}

/** Concatenate warnings from multiple inner results onto a parent result. */
function mergeWarnings(...results: MapPythonTypeResult[]): readonly LowerWarning[] {
  return results.flatMap((r) => r.warnings);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a Python type annotation (as a string, e.g. "int", "list[int]",
 * "Optional[str]") to its TS-subset IR equivalent.
 *
 * The input is whatever string libcst's `.code` rendered — leading/trailing
 * whitespace is tolerated.  Generic subscripts use the modern PEP 585 syntax
 * (`list[int]` not `List[int]`); both are normalized so calling code does not
 * need to choose.
 *
 * Returns `{ tsType, warnings }` where `warnings` is an empty array for
 * lossless mappings and non-empty for widenings (DEC-WI889-006).
 *
 * Throws `UnsupportedTypeError` for types outside the supported set.
 */
export function mapPythonType(annotation: string): MapPythonTypeResult {
  const trimmed = annotation.trim();
  if (trimmed.length === 0) {
    throw new UnsupportedTypeError("", "Empty type annotation");
  }

  // ---------------------------------------------------------------------------
  // WI-889 W-2: Quoted forward-reference stripping (DEC-WI889-002)
  // Strip matching outer quotes first — before any other logic — and recurse.
  // Both PEP 563 ("Foo") and single-quoted ('Foo') forms are handled.
  // Edge: empty after strip ("" / '') → falls through to the empty-check
  // above on the next recursive call.
  // ---------------------------------------------------------------------------
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1).trim();
    return mapPythonType(inner); // recursive — inner support check is natural
  }

  // ---------------------------------------------------------------------------
  // WI-889 W-6: Bare Callable (no subscript).
  // Must be checked BEFORE parseSubscript since it has no brackets.
  // DEC-WI889-003: bare Callable → (...args: unknown[]) => unknown + warning.
  // ---------------------------------------------------------------------------
  if (trimmed === "Callable") {
    return {
      tsType: "(...args: unknown[]) => unknown",
      warnings: [
        {
          code: "callable-widened",
          message: "Bare Python 'Callable' widened to '(...args: unknown[]) => unknown'",
          pythonFragment: trimmed,
        },
      ],
    };
  }

  // Primitives
  switch (trimmed) {
    case "int":
    case "float":
      return ok("number");
    case "str":
      return ok("string");
    case "bool":
      return ok("boolean");
    case "bytes":
      return ok("Uint8Array");
    case "None":
    case "NoneType":
      return ok("null");

    // ---------------------------------------------------------------------------
    // WI-889 W-3: Any / typing.Any widening (DEC-WI889-001)
    // TS `unknown` is the safe top type; `any` disables type checking transitively.
    // ---------------------------------------------------------------------------
    case "Any":
    case "typing.Any":
      return {
        tsType: "unknown",
        warnings: [
          {
            code: "any-widened",
            message: `Python '${trimmed}' widened to TS 'unknown'`,
            pythonFragment: trimmed,
          },
        ],
      };

    // ---------------------------------------------------------------------------
    // WI-889 W-4: ModuleType / types.ModuleType widening (DEC-WI889-004)
    // Modules are opaque at raise time; purity-check catches impurity downstream.
    // ---------------------------------------------------------------------------
    case "ModuleType":
    case "types.ModuleType":
      return {
        tsType: "unknown",
        warnings: [
          {
            code: "module-type-widened",
            message: `Python '${trimmed}' widened to TS 'unknown'`,
            pythonFragment: trimmed,
          },
        ],
      };
  }

  // PEP 604 union: `A | B` — handled before bracket parsing to allow `int | None`.
  if (trimmed.includes("|") && !trimmed.includes("[")) {
    const parts = splitTopLevel(trimmed, "|");
    const mapped = parts.map((p) => mapPythonType(p.trim()));
    const tsType = mapped.map((r) => r.tsType).join(" | ");
    const warnings = mergeWarnings(...mapped);
    return { tsType, warnings };
  }

  // Subscript: `Container[Inner]` or `Tuple[A, B]` etc.
  const subscript = parseSubscript(trimmed);
  if (subscript !== null) {
    const { container, inner } = subscript;
    // Normalize PEP 585 modern / typing module legacy spellings.
    const normalizedContainer =
      container === "List"
        ? "list"
        : container === "Dict"
          ? "dict"
          : container === "Tuple"
            ? "tuple"
            : container;

    switch (normalizedContainer) {
      case "list": {
        const inner_result = mapPythonType(inner);
        return {
          tsType: `${inner_result.tsType}[]`,
          warnings: inner_result.warnings,
        };
      }
      case "dict": {
        // dict[K, V] → Record<K, V>.
        // Slice 2 requires K = str; WI-889 also allows K = Any → Record<string, V> + warning.
        const args = splitTopLevel(inner, ",").map((p) => p.trim());
        if (args.length !== 2) {
          throw new UnsupportedTypeError(
            trimmed,
            `dict expects exactly 2 type args, got ${args.length}`,
          );
        }
        const [keyType, valType] = args as [string, string];
        if (keyType === "str") {
          // Normal lossless path.
          const val_result = mapPythonType(valType);
          return {
            tsType: `Record<string, ${val_result.tsType}>`,
            warnings: val_result.warnings,
          };
        }
        // ---------------------------------------------------------------------------
        // WI-889 W-5: dict[Any, V] relaxation (DEC-WI889-005)
        // Any-keyed dicts → Record<string, V> + warning.
        // Non-Any, non-str keys still throw (e.g. dict[int, V]).
        // ---------------------------------------------------------------------------
        if (keyType === "Any" || keyType === "typing.Any") {
          const val_result = mapPythonType(valType);
          const keyWarning: LowerWarning = {
            code: "dict-any-key-widened",
            message: `dict key '${keyType}' widened to 'string' for Record<string, V>`,
            pythonFragment: trimmed,
          };
          return {
            tsType: `Record<string, ${val_result.tsType}>`,
            warnings: [keyWarning, ...val_result.warnings],
          };
        }
        throw new UnsupportedTypeError(
          trimmed,
          `dict key must be 'str' for raise to TS-subset Record<string, V>; got '${keyType}'`,
        );
      }
      case "tuple": {
        const args = splitTopLevel(inner, ",").map((p) => p.trim());
        const mapped = args.map((a) => mapPythonType(a));
        const tsType = `[${mapped.map((r) => r.tsType).join(", ")}]`;
        return { tsType, warnings: mergeWarnings(...mapped) };
      }
      case "Optional": {
        // Optional[T] → T | null
        const inner_result = mapPythonType(inner.trim());
        return {
          tsType: `${inner_result.tsType} | null`,
          warnings: inner_result.warnings,
        };
      }
      case "Union": {
        const args = splitTopLevel(inner, ",").map((p) => p.trim());
        const mapped = args.map((a) => mapPythonType(a));
        const tsType = mapped.map((r) => r.tsType).join(" | ");
        return { tsType, warnings: mergeWarnings(...mapped) };
      }

      // -----------------------------------------------------------------------
      // WI-889 W-6: Callable subscript forms (DEC-WI889-003)
      // Three forms:
      //   Callable[..., R]           → (...args: unknown[]) => R  + warning
      //   Callable[[A1, A2], R]      → (arg0: A1, arg1: A2) => R  (no warning)
      //   Callable[[], R]            → () => R                    (no warning)
      // -----------------------------------------------------------------------
      case "Callable": {
        return mapCallableSubscript(inner, trimmed);
      }
    }
  }

  throw new UnsupportedTypeError(
    trimmed,
    `Type '${trimmed}' is not in the slice-2 mapping table. Supported: int, float, str, bool, bytes, None, list[T], dict[str,V], tuple[..], Optional[T], Union[A,B], 'A | B'.`,
  );
}

// ---------------------------------------------------------------------------
// Internal: Callable subscript mapper
// ---------------------------------------------------------------------------

/**
 * Handle Callable subscript `inner` portion (i.e. the part inside the outer
 * brackets of `Callable[...]`).
 *
 * @decision DEC-WI889-003
 * @title Callable three-form support
 * @status accepted
 * @rationale
 *   Bare and `[..., R]` forms map to widened `(...args: unknown[]) => unknown` /
 *   `(...args: unknown[]) => R` + warning; explicit `[[A1,...], R]` form maps
 *   lossless with no warning (types are fully specified).
 */
function mapCallableSubscript(inner: string, originalAnnotation: string): MapPythonTypeResult {
  // Split at top level to get [paramsPart, returnPart].
  // Callable[..., R] → ["...", "R"]
  // Callable[[A, B], R] → ["[A, B]", "R"]
  const topArgs = splitTopLevel(inner, ",");

  if (topArgs.length < 2) {
    // Malformed Callable subscript — can't parse; widen with warning.
    return {
      tsType: "(...args: unknown[]) => unknown",
      warnings: [
        {
          code: "callable-widened",
          message: `Python '${originalAnnotation}' has unrecognized Callable form; widened to '(...args: unknown[]) => unknown'`,
          pythonFragment: originalAnnotation,
        },
      ],
    };
  }

  // The return type is the LAST top-level arg; everything before is params.
  // For `Callable[..., R]` and `Callable[[A, B], R]`, the first arg is the
  // params spec and the last is the return type.
  const paramsPart = topArgs.slice(0, -1).join(",").trim();
  const retPart = topArgs[topArgs.length - 1]?.trim() ?? "";
  const retResult = mapPythonType(retPart);

  // Ellipsis form: Callable[..., R]
  if (paramsPart === "...") {
    return {
      tsType: `(...args: unknown[]) => ${retResult.tsType}`,
      warnings: [
        {
          code: "callable-widened",
          message: `Python '${originalAnnotation}' uses Callable[..., R] form; widened to '(...args: unknown[]) => ${retResult.tsType}'`,
          pythonFragment: originalAnnotation,
        },
        ...retResult.warnings,
      ],
    };
  }

  // Explicit list form: Callable[[A1, A2], R]
  if (paramsPart.startsWith("[") && paramsPart.endsWith("]")) {
    const paramsInner = paramsPart.slice(1, -1).trim();
    if (paramsInner.length === 0) {
      // Callable[[], R] → () => R
      return {
        tsType: `() => ${retResult.tsType}`,
        warnings: retResult.warnings,
      };
    }
    const paramTypes = splitTopLevel(paramsInner, ",").map((p) => p.trim());
    const mappedParams = paramTypes.map((pt) => mapPythonType(pt));
    const paramList = mappedParams.map((r, i) => `arg${i}: ${r.tsType}`).join(", ");
    const tsType = `(${paramList}) => ${retResult.tsType}`;
    return {
      tsType,
      warnings: mergeWarnings(...mappedParams, retResult),
    };
  }

  // Unrecognized form — widen with warning.
  return {
    tsType: "(...args: unknown[]) => unknown",
    warnings: [
      {
        code: "callable-widened",
        message: `Python '${originalAnnotation}' has unrecognized Callable form; widened to '(...args: unknown[]) => unknown'`,
        pythonFragment: originalAnnotation,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Internal parsing utilities
// ---------------------------------------------------------------------------

/**
 * Parse a single-bracket subscript like `list[int]` or `dict[str, int]`.
 * Returns `{container, inner}` or `null` if the input isn't a subscript.
 *
 * Tolerates nested brackets within `inner`: `list[dict[str, int]]` returns
 * `{container: "list", inner: "dict[str, int]"}`.
 */
function parseSubscript(s: string): { container: string; inner: string } | null {
  const openIdx = s.indexOf("[");
  if (openIdx === -1 || !s.endsWith("]")) return null;
  const container = s.slice(0, openIdx).trim();
  const inner = s.slice(openIdx + 1, -1).trim();
  if (container.length === 0 || inner.length === 0) return null;
  return { container, inner };
}

/**
 * Split a string on `sep` at the top level only — bracket-nested occurrences
 * are skipped.  e.g. `splitTopLevel("dict[str, int], list[int]", ",")` returns
 * `["dict[str, int]", " list[int]"]` (single split, not three).
 */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}
