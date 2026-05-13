// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/json-pointer-resolve/reference-impl.ts
//
// @decision DEC-V0-B4-TASKS-EXPAND-001
// @title B4 Slice 2 task corpus: json-pointer-resolve reference implementation
// @status accepted
// @rationale
//   Reference implementation for oracle validation. Proves oracle tests correctly
//   distinguish RFC-compliant from broken JSON pointer resolvers. Hand-written;
//   not LLM-generated (DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001).
//
//   Adversarial trap: ~01 must decode to ~1 (apply ~1→/ first, then ~0→~).
//   Applying ~0 first gives ~1→/ which is wrong. This is the RFC-specified decode
//   order and the most common correctness failure in model-generated implementations.

/**
 * Decode a single RFC 6901 reference token.
 * Escape sequences: ~1 → /, ~0 → ~. Order matters: ~1 first, then ~0.
 *
 * @throws {Error} If an invalid escape sequence is found
 */
function decodeToken(token: string): string {
  // Validate: ~ must be followed by 0 or 1
  // Find all ~ chars and check the character after each
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "~") {
      const next = token[i + 1];
      if (next !== "0" && next !== "1") {
        throw new Error(
          `Invalid JSON Pointer escape sequence: ~${next ?? "(end)"} in token "${token}"`
        );
      }
    }
  }

  // RFC 6901 §3: decode ~1 → / first, then ~0 → ~
  // This order prevents ~01 from being decoded as / instead of ~1.
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Resolve an RFC 6901 JSON Pointer against a document.
 *
 * @param doc - The JSON document to resolve against (any JSON-compatible value)
 * @param pointer - RFC 6901 JSON Pointer string (e.g. "/foo/bar/0")
 * @returns The value at the pointed location
 * @throws {Error} For invalid pointer syntax, missing keys, or out-of-bounds access
 */
export function jsonPointerResolve(doc: unknown, pointer: string): unknown {
  // Empty pointer: reference the whole document
  if (pointer === "") return doc;

  // Non-empty pointer must start with /
  if (!pointer.startsWith("/")) {
    throw new Error(
      `Invalid JSON Pointer: must be empty or start with "/", got "${pointer}"`
    );
  }

  // Split into reference tokens (skip the leading empty string before first /)
  const rawTokens = pointer.slice(1).split("/");

  let current: unknown = doc;

  for (const rawToken of rawTokens) {
    // Decode escape sequences in the reference token
    const token = decodeToken(rawToken);

    if (Array.isArray(current)) {
      // Array indexing rules
      if (token === "-") {
        throw new Error(
          `JSON Pointer "-" token refers to a non-existent array element (end-of-array)`
        );
      }

      // Token must be a non-negative integer with no leading zeros (except "0" itself)
      if (!/^(?:0|[1-9]\d*)$/.test(token)) {
        throw new Error(
          `JSON Pointer array index must be a non-negative integer without leading zeros, got "${token}"`
        );
      }

      const index = parseInt(token, 10);
      if (index >= current.length) {
        throw new Error(
          `JSON Pointer index ${index} is out of bounds for array of length ${current.length}`
        );
      }

      current = current[index];
    } else if (current !== null && typeof current === "object") {
      const obj = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, token)) {
        throw new Error(
          `JSON Pointer key "${token}" not found in object`
        );
      }
      current = obj[token];
    } else {
      // current is a primitive — cannot traverse further
      throw new Error(
        `JSON Pointer cannot traverse into primitive value ${JSON.stringify(current)} with token "${token}"`
      );
    }
  }

  return current;
}
