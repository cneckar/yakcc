// @decision DEC-CANON-001: Canonical JSON encoder is hand-rolled, not JSON.stringify.
// Status: decided (WI-002)
// Rationale: JSON.stringify does not satisfy the canonicalization rules required for
// stable content-addressing: (1) it does not sort object keys, (2) it emits numbers
// in implementation-defined form that may include scientific notation or platform-
// specific rounding, (3) it does not enforce no-trailing-zeros or signed-zero collapse.
// A 90-line encoder written from first principles is the only way to guarantee
// byte-identical output on every JS runtime.

import type { ContractSpec } from "./index.js";

// ---------------------------------------------------------------------------
// Internal JSON value type (closed over ContractSpec shape)
// ---------------------------------------------------------------------------

type JsonPrimitive = string | number | boolean | null;
type JsonObject = { readonly [key: string]: JsonValue };
type JsonArray = readonly JsonValue[];
type JsonValue = JsonPrimitive | JsonObject | JsonArray;

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/**
 * Encode a JSON value to its canonical string representation.
 *
 * Rules:
 * - Object keys sorted lexicographically (Unicode code-point order), depth-first.
 * - Arrays: element order preserved.
 * - Numbers: integer form when value is a finite integer, else fixed-form decimal
 *   with no trailing zeros. NaN and Infinity throw — they are not valid contract
 *   spec values and must not silently produce `null` (which JSON.stringify does).
 * - Strings: RFC 8259 JSON string encoding. Escape only the characters that MUST
 *   be escaped per RFC (control chars U+0000–U+001F, U+0022 `"`, U+005C `\`).
 *   No over-escaping of forward slashes or non-ASCII code points.
 * - Boolean / null: standard JSON literals.
 * - undefined: must not appear (optional fields absent from objects, not null).
 */
function encodeValue(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) {
    const arr = value as JsonArray;
    if (arr.length === 0) return "[]";
    return `[${arr.map(encodeValue).join(",")}]`;
  }
  // Object
  const obj = value as JsonObject;
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) return "{}";
  const pairs = keys
    .filter((k) => (obj[k] as JsonValue | undefined) !== undefined)
    .map((k) => `${encodeString(k)}:${encodeValue(obj[k] as JsonValue)}`);
  if (pairs.length === 0) return "{}";
  return `{${pairs.join(",")}}`;
}

/**
 * Encode a number to its canonical JSON form.
 *
 * - NaN and ±Infinity are invalid and throw.
 * - Signed zero (-0) is collapsed to 0.
 * - Integer values use integer form (no decimal point).
 * - Non-integer values: JSON.stringify is canonical for the integer and
 *   fixed-decimal range we currently encode. We throw on scientific notation
 *   as a tripwire for future schema additions — if a ContractSpec field ever
 *   holds a value in the magnitude range that triggers scientific notation
 *   (e.g. 5e-7), this guard fires loudly rather than silently producing
 *   non-deterministic output. Add a fixed-decimal renderer (e.g. Ryu) before
 *   extending ContractSpec with values in such a magnitude range.
 */
function encodeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(
      `canonicalize: non-finite number ${String(n)} is not a valid ContractSpec value`,
    );
  }
  // Collapse -0 to 0
  if (Object.is(n, -0)) return "0";
  // Integer form: avoid decimal point for whole numbers. Use String() which is
  // canonical for integers within safe-integer range. For very large integers
  // (≥1e21) String() emits scientific notation — guard against that too.
  if (Number.isInteger(n)) {
    const s = String(n);
    if (s.includes("e") || s.includes("E")) {
      throw new TypeError(
        `Non-canonical numeric encoding for ${n}: produced scientific notation "${s}". Canonical encoding requires fixed-decimal form. Add a fixed-decimal renderer (e.g. Ryu) before extending ContractSpec with values in this magnitude range.`,
      );
    }
    return s;
  }
  // Non-integer: JSON.stringify produces the shortest round-trip decimal on all
  // V8/SpiderMonkey/JSC runtimes for ordinary finite non-integers. However, for
  // values with very small or very large magnitude it emits scientific notation
  // (e.g. 5e-7), which is not canonical. Throw immediately so the caller knows
  // a fixed-decimal renderer is required before adding such values to the schema.
  const s = JSON.stringify(n);
  if (s.includes("e") || s.includes("E")) {
    throw new TypeError(
      `Non-canonical numeric encoding for ${n}: produced scientific notation "${s}". Canonical encoding requires fixed-decimal form. Add a fixed-decimal renderer (e.g. Ryu) before extending ContractSpec with values in this magnitude range.`,
    );
  }
  return s;
}

/** RFC-8259 character escape table. */
const ESCAPE: Record<number, string> = {
  0: "\\u0000",
  1: "\\u0001",
  2: "\\u0002",
  3: "\\u0003",
  4: "\\u0004",
  5: "\\u0005",
  6: "\\u0006",
  7: "\\u0007",
  8: "\\b",
  9: "\\t",
  10: "\\n",
  11: "\\u000b",
  12: "\\f",
  13: "\\r",
  14: "\\u000e",
  15: "\\u000f",
  16: "\\u0010",
  17: "\\u0011",
  18: "\\u0012",
  19: "\\u0013",
  20: "\\u0014",
  21: "\\u0015",
  22: "\\u0016",
  23: "\\u0017",
  24: "\\u0018",
  25: "\\u0019",
  26: "\\u001a",
  27: "\\u001b",
  28: "\\u001c",
  29: "\\u001d",
  30: "\\u001e",
  31: "\\u001f",
  34: '\\"',
  92: "\\\\",
};

/**
 * Encode a string to its canonical JSON form.
 * Escapes only what RFC 8259 requires; no over-escaping.
 */
function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    const esc = ESCAPE[cp];
    if (esc !== undefined) {
      out += esc;
    } else {
      out += s[i];
    }
  }
  return `${out}"`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();

/**
 * Produce the canonical UTF-8 byte encoding of a ContractSpec.
 *
 * The canonical form deterministically encodes the spec such that two specs with
 * identical content produce the same byte sequence on every JS runtime, on every
 * platform, across time. This byte sequence is what is hashed to derive the
 * ContractId.
 *
 * Invariants:
 * - Object keys sorted lexicographically at every depth.
 * - Array element order preserved.
 * - NaN / Infinity → throws TypeError.
 * - undefined (absent optional fields) → omitted, not encoded as null.
 * - Signed zero → encoded as 0.
 */
export function canonicalize(spec: ContractSpec): Uint8Array {
  const text = canonicalizeText(spec);
  return TEXT_ENCODER.encode(text);
}

/**
 * Convenience: return the canonical form as a UTF-8 string rather than bytes.
 * Useful for debugging and for feeding into embedding models.
 */
export function canonicalizeText(spec: ContractSpec): string {
  return encodeValue(spec as unknown as JsonValue);
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

/**
 * Internal encoder surfaces exposed only for unit tests.
 * Do NOT import this namespace from production code.
 */
export const __testing__ = {
  encodeNumber,
} as const;
