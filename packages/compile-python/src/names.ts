// SPDX-License-Identifier: MIT
// camelCase → snake_case de-normalization for Python lower adapter.

/**
 * Convert a camelCase identifier to snake_case.
 * "digitOrThrow" → "digit_or_throw"
 * "eofCheck" → "eof_check"
 * Already-snake or single-word identifiers are returned unchanged.
 *
 * @decision DEC-947-001 — toSnakeCase preserves ALL_CAPS identifiers verbatim
 * @title ALL_CAPS identifiers (Python class constant convention) are never lowercased
 * @status accepted (#947)
 * @rationale Python uses ALL_CAPS by convention for class constants (e.g.
 *   `AMPERSAND_OR_BRACKET`, `MAX_LENGTH`).  Applying the CamelCase→snake_case
 *   transform would produce `ampersand_or_bracket` which does not match the
 *   original constant and causes AttributeError at runtime.  The guard regex
 *   `/^[A-Z][A-Z0-9_]*$/` matches identifiers that consist only of uppercase
 *   letters, digits, and underscores starting with an uppercase letter —
 *   exactly the ALL_CAPS convention.  Mixed-case identifiers (e.g. `MixedCASE`)
 *   are NOT matched and continue through the standard CamelCase→snake_case path.
 *   Cross-reference: #947
 */
export function toSnakeCase(name: string): string {
  // #947: preserve ALL_CAPS identifiers verbatim (Python class constant convention).
  // Regex: starts with uppercase letter, followed only by uppercase letters / digits / underscores.
  if (/^[A-Z][A-Z0-9_]*$/.test(name)) return name;
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Convert a shave-python IR function identifier to a Python function name,
 * handling the `ClassName_methodName` encoding produced by #941.
 *
 * The shave-python pipeline encodes classmethod identifiers as
 * `ClassName_methodName` (e.g. `EntitySubstitution_substituteXml`) so that the
 * class name CamelCase is preserved verbatim.  To round-trip back to Python, we
 * must split at the class/method boundary and reconstruct `ClassName.method_name`.
 *
 * Detection rule: if the identifier matches `UpperCamelCasePart_lowerCamelCasePart`
 * (LHS starts with an uppercase letter, single underscore separator, RHS starts
 * with a lowercase letter), it is treated as a class.method boundary.
 * Identifiers with multiple underscores (e.g. `_invert`, `_chardetDammit`) or
 * a leading underscore are treated as plain snake_case and passed through
 * `toSnakeCase` directly.
 *
 * @decision DEC-941-003 — compile-python splits ClassName_methodName at class boundary
 * @title Identifier "ClassName_methodName" → "ClassName.method_name" on the Python side
 * @status accepted (#941)
 * @rationale The shave-python encoding (DEC-941-001/002) preserves the class name
 *   verbatim in the IR identifier.  The compile adapter must detect and reverse
 *   this encoding.  The detection heuristic (UpperCase LHS + lowerCase RHS at a
 *   single underscore boundary) is unambiguous for the generated identifiers
 *   because the shave pipeline guarantees the class name starts with uppercase.
 *   Regular snake_case identifiers (leading lowercase or leading underscore) are
 *   never confused with this pattern.
 *
 * Examples:
 *   "EntitySubstitution_substituteXml" → "EntitySubstitution.substitute_xml"
 *   "_invert"                          → "_invert"       (leading underscore — plain)
 *   "_chardetDammit"                   → "_chardet_dammit" (leading underscore — plain)
 *   "substituteXml"                    → "substitute_xml"  (no underscore — plain)
 */
export function classMethToSnake(name: string): string {
  // Must not start with underscore (leading underscore → private, not a class name).
  if (!name || name.startsWith("_")) {
    return toSnakeCase(name);
  }
  // Detect the pattern: UpperCamelCase_lowerCamelCase
  // Single underscore that separates an uppercase-starting LHS from a
  // lowercase-starting RHS.
  const match = /^([A-Z][A-Za-z0-9]*)_([a-z][A-Za-z0-9]*)$/.exec(name);
  if (match) {
    // Both capture groups are guaranteed present when the regex matched.
    // Use ?? "" fallback to satisfy strict-null checks without non-null assertion.
    const className = match[1] ?? ""; // preserved verbatim (already CamelCase)
    const methodPart = match[2] ?? ""; // convert camelCase → snake_case
    return `${className}.${toSnakeCase(methodPart)}`;
  }
  // Not a class/method boundary — fall through to plain snake_case conversion.
  return toSnakeCase(name);
}
