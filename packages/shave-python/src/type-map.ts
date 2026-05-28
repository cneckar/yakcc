// SPDX-License-Identifier: MIT
//
// type-map.ts — Python → TS-subset IR type mapping (WI-782 slice 2).
//
// Implements the type column of the mapping table from #782 spec (and ADR Q2).
// Slice 2 supports the primitive subset (int/float/str/bool/None) plus the
// common containers (list[T], dict[str,V], Optional[T], tuple[A,B], Union[A,B]).
// Composite types are recursively mapped.
//
// Unsupported types throw a marker error so callers can surface them via
// CannotRaiseToIRError (slice 4 wires that — slice 2 throws plain UnsupportedTypeError
// so the dependency on @yakcc/contracts isn't load-bearing yet).
//
// @decision DEC-POLYGLOT-SHAVE-PY-TYPE-MAP-001 (WI-782 slice 2)
// @title Python → TS type mapping table; lossless within the documented subset
// @status accepted (WI-782 slice 2)
// @rationale
//   ADR Q2's mapping table is the authoritative source.  We re-encode it here
//   as TypeScript so the raise adapter can apply it mechanically.  Cross-typed
//   atoms (Python int + TS bigint) are deliberately rejected — see #782
//   "Type precision" section: int → number with warn-on-loss is deferred to
//   slice 3+ once the warning channel exists.

/**
 * Thrown when a Python type annotation cannot be mapped to a TS-subset IR
 * type using the current MVP table.  Slice 4 will wrap these in
 * `CannotRaiseToIRError` from `@yakcc/contracts`.
 */
export class UnsupportedTypeError extends Error {
  constructor(
    public readonly pythonType: string,
    message?: string,
  ) {
    super(message ?? `Unsupported Python type for raise to TS-subset IR: ${pythonType}`);
    this.name = "UnsupportedTypeError";
  }
}

/**
 * Map a Python type annotation (as a string, e.g. "int", "list[int]",
 * "Optional[str]") to its TS-subset IR equivalent.
 *
 * The input is whatever string libcst's `.code` rendered — leading/trailing
 * whitespace is tolerated.  Generic subscripts use the modern PEP 585 syntax
 * (`list[int]` not `List[int]`); both are normalized so calling code does not
 * need to choose.
 *
 * Throws `UnsupportedTypeError` for types outside the slice 2 MVP set.
 */
export function mapPythonType(annotation: string): string {
  const trimmed = annotation.trim();
  if (trimmed.length === 0) {
    throw new UnsupportedTypeError("", "Empty type annotation");
  }

  // Primitives
  switch (trimmed) {
    case "int":
    case "float":
      return "number";
    case "str":
      return "string";
    case "bool":
      return "boolean";
    case "bytes":
      return "Uint8Array";
    case "None":
    case "NoneType":
      return "null";
  }

  // PEP 604 union: `A | B` — handled before bracket parsing to allow `int | None`.
  if (trimmed.includes("|") && !trimmed.includes("[")) {
    const parts = splitTopLevel(trimmed, "|").map((p) => mapPythonType(p));
    return parts.join(" | ");
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
        return `${mapPythonType(inner)}[]`;
      }
      case "dict": {
        // dict[K, V] → Record<K, V>. Slice 2 requires K = str.
        const args = splitTopLevel(inner, ",").map((p) => p.trim());
        if (args.length !== 2) {
          throw new UnsupportedTypeError(
            trimmed,
            `dict expects exactly 2 type args, got ${args.length}`,
          );
        }
        const [keyType, valType] = args as [string, string];
        if (keyType !== "str") {
          throw new UnsupportedTypeError(
            trimmed,
            `dict key must be 'str' for raise to TS-subset Record<string, V>; got '${keyType}'`,
          );
        }
        return `Record<string, ${mapPythonType(valType)}>`;
      }
      case "tuple": {
        const args = splitTopLevel(inner, ",").map((p) => mapPythonType(p.trim()));
        return `[${args.join(", ")}]`;
      }
      case "Optional": {
        // Optional[T] → T | null
        return `${mapPythonType(inner.trim())} | null`;
      }
      case "Union": {
        const args = splitTopLevel(inner, ",").map((p) => mapPythonType(p.trim()));
        return args.join(" | ");
      }
    }
  }

  throw new UnsupportedTypeError(
    trimmed,
    `Type '${trimmed}' is not in the slice-2 mapping table. Supported: int, float, str, bool, bytes, None, list[T], dict[str,V], tuple[..], Optional[T], Union[A,B], 'A | B'.`,
  );
}

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
