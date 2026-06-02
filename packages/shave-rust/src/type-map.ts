// SPDX-License-Identifier: Apache-2.0
//
// type-map.ts -- Rust -> TS-subset IR type mapping (WI-868 slice 1).
//
// Implements the type column of the mapping table for Rust primitives and
// common std types.  Slice 1 covers:
//   - Signed integers:   i8, i16, i32, i64, i128, isize
//   - Unsigned integers: u8, u16, u32, u64, u128, usize
//   - Floats:            f32, f64
//   - Boolean:           bool
//   - Strings:           String, &str, &'a str (lifetime stripped)
//   - Unit:              () -> void
//   - Option<T>          -> T | null
//   - Vec<T>             -> T[]
//   - Slice reference:   &[T], &'a [T] -> T[]
//   - References:        &T, &mut T -> T (indirection flattened in TS-subset IR)
//   - Tuples:            (T, U) -> [T, U]
//   - Result<T, E>       -> T (error case deferred; Slice 2 will surface E)
//
// Types outside this set throw UnsupportedTypeError so callers can surface
// them via CannotRaiseToIRError (slice 4 wires that).
//
// @decision DEC-POLYGLOT-RUST-TYPE-MAP-001 (WI-868 slice 1)
// @title Rust -> TS type mapping table; lossless within the documented subset
// @status accepted (WI-868 slice 1)
// @rationale
//   All Rust integer types map to `number` in the TS-subset IR — yakcc's IR
//   does not model machine-word widths at slice 1.  i64/u64/i128/u128 precision
//   loss vs TS number is deliberately deferred to slice 3+ once the warning
//   channel exists (matching shave-go / shave-python approach).
//   Lifetimes in type strings (e.g. `&'a str`) are stripped before mapping
//   because they have no TS-subset IR equivalent and carry no semantic meaning
//   for pure-function raise.

/**
 * Thrown when a Rust type cannot be mapped to a TS-subset IR type using the
 * current MVP table.  Slice 4 will wrap these in `CannotRaiseToIRError` from
 * `@yakcc/contracts`.
 */
export class UnsupportedTypeError extends Error {
  constructor(
    public readonly rustType: string,
    message?: string,
  ) {
    super(message ?? `Unsupported Rust type for raise to TS-subset IR: ${rustType}`);
    this.name = "UnsupportedTypeError";
  }
}

/**
 * Map a Rust type string to its TS-subset IR equivalent.
 *
 * Returns the TS type string.  Throws `UnsupportedTypeError` for types outside
 * the supported set.
 *
 * Lifetime annotations (e.g. `'a`) are stripped before mapping.
 */
export function mapRustType(rustType: string): string {
  return mapRustTypeInner(rustType.trim());
}

// ---------------------------------------------------------------------------
// Core mapping logic (internal).
// ---------------------------------------------------------------------------

function mapRustTypeInner(t: string): string {
  if (t.length === 0) {
    throw new UnsupportedTypeError("", "Empty type string");
  }

  // Unit type: () -> void
  if (t === "()") {
    return "void";
  }

  // References: &T, &mut T, &'lifetime T — strip ref/lifetime, map inner type.
  // Also handles &[T] and &'a [T] (slice references).
  if (t.startsWith("&")) {
    const inner = stripRefPrefix(t);
    return mapRustTypeInner(inner);
  }

  // mut T — strip mut prefix (from `mut T` in function params)
  if (t.startsWith("mut ")) {
    return mapRustTypeInner(t.slice(4).trim());
  }

  // Slice type: [T] -> T[]
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    const mapped = mapRustTypeInner(inner);
    return `${mapped}[]`;
  }

  // Tuple types: (T, U, ...) -> [T, U, ...]
  if (t.startsWith("(") && t.endsWith(")")) {
    return parseTupleType(t);
  }

  // Generic types: Name<T, ...>
  if (t.includes("<")) {
    return parseGenericType(t);
  }

  // Primitives
  switch (t) {
    case "i8":
    case "i16":
    case "i32":
    case "i64":
    case "i128":
    case "isize":
    case "u8":
    case "u16":
    case "u32":
    case "u64":
    case "u128":
    case "usize":
    case "f32":
    case "f64":
      return "number";

    case "bool":
      return "boolean";

    case "str":
    case "String":
      return "string";

    case "char":
      // Rust char is a Unicode scalar value; TS has no distinct char type.
      // Map to string (single-character string in practice).
      return "string";
  }

  throw new UnsupportedTypeError(
    t,
    `Type '${t}' is not in the slice-1 mapping table. Supported: i8/i16/i32/i64/i128/isize, u8/u16/u32/u64/u128/usize, f32/f64, bool, str/String/char, Option<T>, Vec<T>, Result<T,E>, &T, &mut T, &[T], [T], (T,U) tuples.`,
  );
}

// ---------------------------------------------------------------------------
// Reference stripping (lifetimes + mut)
// ---------------------------------------------------------------------------

/**
 * Strip the leading `&`, optional lifetime (`'ident`), and optional `mut`
 * from a reference type string, returning the inner type.
 *
 * Examples:
 *   "&str"        -> "str"
 *   "&'a str"     -> "str"
 *   "&mut String" -> "String"
 *   "&'a [u8]"    -> "[u8]"
 */
function stripRefPrefix(t: string): string {
  // t starts with '&'
  let i = 1; // skip '&'

  // Skip optional lifetime: 'ident followed by whitespace
  if (i < t.length && t[i] === "'") {
    // Consume lifetime name until whitespace
    i++;
    while (i < t.length && t[i] !== " " && t[i] !== "\t") i++;
    // Skip trailing whitespace
    while (i < t.length && (t[i] === " " || t[i] === "\t")) i++;
  }

  // Skip optional 'mut '
  if (t.slice(i).startsWith("mut ")) {
    i += 4;
  }

  return t.slice(i).trim();
}

// ---------------------------------------------------------------------------
// Tuple type parser: (T, U, V) -> [T, U, V]
// ---------------------------------------------------------------------------

function parseTupleType(t: string): string {
  // t is "(T, U, ...)" — strip outer parens
  const inner = t.slice(1, -1).trim();
  if (inner.length === 0) {
    // Empty tuple () was already handled above as "void"
    return "void";
  }
  const parts = splitTypeList(inner);
  if (parts.length === 1) {
    // Single-element tuple: (T,) in Rust — map to T[] is wrong; map to [T].
    return `[${mapRustTypeInner(parts[0] ?? "")}]`;
  }
  const mapped = parts.map((p) => mapRustTypeInner(p));
  return `[${mapped.join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Generic type parser: Name<T, U> -> mapped form
// ---------------------------------------------------------------------------

function parseGenericType(t: string): string {
  const angleBracket = t.indexOf("<");
  if (angleBracket === -1) {
    throw new UnsupportedTypeError(t, `Internal: parseGenericType called without '<' in '${t}'`);
  }
  const name = t.slice(0, angleBracket).trim();
  // Find matching closing '>'
  let depth = 0;
  let closeIdx = -1;
  for (let i = angleBracket; i < t.length; i++) {
    if (t[i] === "<") depth++;
    else if (t[i] === ">") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) {
    throw new UnsupportedTypeError(t, `Malformed generic type: unbalanced angle brackets in '${t}'`);
  }
  const argStr = t.slice(angleBracket + 1, closeIdx).trim();
  const trailing = t.slice(closeIdx + 1).trim();
  if (trailing.length > 0) {
    throw new UnsupportedTypeError(t, `Unexpected trailing characters in generic type '${t}'`);
  }

  switch (name) {
    case "Option": {
      const args = splitTypeList(argStr);
      if (args.length !== 1) {
        throw new UnsupportedTypeError(t, `Option<T> requires exactly 1 type argument, got ${args.length}`);
      }
      const inner = mapRustTypeInner(args[0] ?? "");
      return `${inner} | null`;
    }

    case "Vec": {
      const args = splitTypeList(argStr);
      if (args.length !== 1) {
        throw new UnsupportedTypeError(t, `Vec<T> requires exactly 1 type argument, got ${args.length}`);
      }
      const inner = mapRustTypeInner(args[0] ?? "");
      return `${inner}[]`;
    }

    case "Result": {
      // Result<T, E> -> T  (E is the error case; slice 1 ignores E)
      // The caller's return type will be T; error propagation is out of scope.
      const args = splitTypeList(argStr);
      if (args.length !== 2) {
        throw new UnsupportedTypeError(t, `Result<T, E> requires exactly 2 type arguments, got ${args.length}`);
      }
      return mapRustTypeInner(args[0] ?? "");
    }

    case "Box":
    case "Rc":
    case "Arc": {
      // Smart pointers: Box<T>, Rc<T>, Arc<T> — flatten to inner type.
      const args = splitTypeList(argStr);
      if (args.length !== 1) {
        throw new UnsupportedTypeError(t, `${name}<T> requires exactly 1 type argument, got ${args.length}`);
      }
      return mapRustTypeInner(args[0] ?? "");
    }

    default:
      throw new UnsupportedTypeError(
        t,
        `Generic type '${name}<...>' is not in the slice-1 mapping table. Supported generics: Option<T>, Vec<T>, Result<T,E>, Box<T>, Rc<T>, Arc<T>.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Bracket-aware type-list splitter (comma-separated, respecting <> and [])
// ---------------------------------------------------------------------------

/**
 * Split a comma-separated Rust type list (e.g. `"T, U"` or `"Vec<i32>, bool"`)
 * into individual type strings, respecting nested angle brackets and square brackets.
 */
export function splitTypeList(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "<" || ch === "[" || ch === "(") depth++;
    else if (ch === ">" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = s.slice(start).trim();
  if (last.length > 0) parts.push(last);
  return parts.filter((p) => p.length > 0);
}
