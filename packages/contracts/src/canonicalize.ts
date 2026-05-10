// SPDX-License-Identifier: MIT
// @decision DEC-CANON-001: Canonical JSON encoder is hand-rolled, not JSON.stringify.
// Status: decided (WI-002)
// Rationale: JSON.stringify does not satisfy the canonicalization rules required for
// stable content-addressing: (1) it does not sort object keys, (2) it emits numbers
// in implementation-defined form that may include scientific notation or platform-
// specific rounding, (3) it does not enforce no-trailing-zeros or signed-zero collapse.
// A 90-line encoder written from first principles is the only way to guarantee
// byte-identical output on every JS runtime.

import type { ContractSpec, NonFunctionalProperties } from "./index.js";

// ---------------------------------------------------------------------------
// QueryIntentCard — LLM-facing query surface (D2 ADR, DEC-V3-DISCOVERY-D2-001)
// ---------------------------------------------------------------------------

// @decision DEC-V3-IMPL-QUERY-001
// title: Symmetric query-text derivation via canonicalizeQueryText
// status: accepted
// rationale: canonicalizeQueryText(card: QueryIntentCard): string projects the
//   query into a SpecYak-shaped canonical JSON text so that query and document
//   vectors occupy the same semantic space. Each provided dimension field maps
//   to the corresponding SpecYak optional field (behavior, guarantees, etc.).
//   Absent fields are omitted (same semantics as D1's absent-dimension zero-vector
//   rule). The function uses the same hand-rolled canonical encoder so key ordering
//   and number serialization are identical to storeBlock's embedding text.
//   Canonical site for the 1 - L²/4 formula re-stated in storage.ts (DEC-V3-IMPL-QUERY-007).
//   References: docs/adr/discovery-query-language.md §Q1, docs/adr/discovery-ranking.md §Q3.

/**
 * A query parameter with optional name (at query time the LLM may not know
 * argument names; only the type is required). Used in QueryIntentCard.signature.
 */
export interface QueryTypeSignatureParam {
  /** Optional argument name. If absent, a positional sentinel is generated. */
  readonly name?: string | undefined;
  /** Required type string, e.g. "number", "string[]". */
  readonly type: string;
}

/**
 * The LLM-facing query surface for multi-dimensional vector search.
 *
 * Each field corresponds to one semantic dimension of a stored SpecYak.
 * Omitting a field skips that dimension at scoring time (D1 absent-dimension rule).
 *
 * @decision DEC-V3-DISCOVERY-D2-001 — Query schema. QueryIntentCard is intentionally
 *   smaller than SpecYak: no id/hash/strictness/proof fields; all dimension fields
 *   are optional; freeform description strings replace structured array types.
 *   Reference: docs/adr/discovery-query-language.md §Q1.
 */
export interface QueryIntentCard {
  // Dimension fields — each is optional; omitting skips that dimension
  /** Behavior dimension: maps to SpecYak.behavior. */
  readonly behavior?: string | undefined;
  /** Guarantees dimension: freeform descriptions (no id required at query time). */
  readonly guarantees?: readonly string[] | undefined;
  /** Error-conditions dimension: freeform descriptions. */
  readonly errorConditions?: readonly string[] | undefined;
  /**
   * Non-functional dimension: any subset of NonFunctionalProperties.
   * purity and threadSafety are NOT required at query time (D2 §Q1 deviation).
   */
  readonly nonFunctional?: Partial<NonFunctionalProperties> | undefined;
  /** Property-tests dimension: freeform descriptions. */
  readonly propertyTests?: readonly string[] | undefined;
  /**
   * Structural-match dimension (not embedded; used by D3 Stage 2).
   * Maps to SpecYak inputs/outputs for structuralMatch().
   */
  readonly signature?:
    | {
        readonly inputs?: readonly QueryTypeSignatureParam[] | undefined;
        readonly outputs?: readonly QueryTypeSignatureParam[] | undefined;
      }
    | undefined;

  // Retrieval controls
  /**
   * Per-dimension relative weights for combinedScore computation (D3 §Q1).
   * Keys mirror SpecYak field names (no embedding_ prefix).
   * Omitted dimensions use default weight 1.0.
   */
  readonly weights?:
    | {
        readonly behavior?: number | undefined;
        readonly guarantees?: number | undefined;
        readonly errorConditions?: number | undefined;
        readonly nonFunctional?: number | undefined;
        readonly propertyTests?: number | undefined;
      }
    | undefined;
  /** Maximum number of candidates to return. Default: 10. */
  readonly topK?: number | undefined;
  /** Minimum combinedScore threshold; candidates below this are excluded. */
  readonly minScore?: number | undefined;
}

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
// canonicalizeQueryText — D2/D3 query-text derivation (DEC-V3-IMPL-QUERY-001)
// ---------------------------------------------------------------------------

/**
 * Project a QueryIntentCard into a SpecYak-shaped canonical text for embedding.
 *
 * The produced text uses the same canonical JSON encoder as canonicalizeText(),
 * so the query and document vectors are in the same semantic space
 * (DEC-V3-IMPL-QUERY-001 — symmetric query-text derivation).
 *
 * Projection rules (per D2 ADR §Q1 and D3 ADR §Q3):
 * - `behavior`          → "behavior" key (string, direct)
 * - `guarantees`        → "guarantees" key: array of {id:"q<n>", description: text}
 * - `errorConditions`   → "errorConditions" key: array of {description: text}
 * - `nonFunctional`     → "nonFunctional" key: Partial<NonFunctionalProperties> as-is
 * - `propertyTests`     → "propertyTests" key: array of {id:"p<n>", description: text}
 * - `signature.inputs`  → "inputs" key: array of {name: name|"arg<n>", type}
 * - `signature.outputs` → "outputs" key: array of {name: name|"out<n>", type}
 *
 * Absent fields are omitted from the projection (D1 absent-dimension rule):
 * a query that includes only `behavior` produces only a "behavior" key — the
 * embedding model sees only the behavior text, not noise from absent dimensions.
 *
 * The function is pure and deterministic: same card → same string, byte-for-byte.
 *
 * @param card - The LLM-provided QueryIntentCard.
 * @returns A canonical JSON string suitable for embedding via EmbeddingProvider.embed().
 */
export function canonicalizeQueryText(card: QueryIntentCard): string {
  // Build a plain object with only the keys that are present in the card.
  // The encodeValue function will sort keys lexicographically, matching the
  // storage embedding's key order (same encoder, same rules).
  const projection: Record<string, JsonValue> = {};

  // behavior dimension — direct string
  if (card.behavior !== undefined && card.behavior !== "") {
    projection.behavior = card.behavior;
  }

  // errorConditions dimension — array of {description}
  if (card.errorConditions !== undefined && card.errorConditions.length > 0) {
    projection.errorConditions = card.errorConditions.map((desc) => ({
      description: desc,
    }));
  }

  // guarantees dimension — array of {description, id: "q<n>"}
  if (card.guarantees !== undefined && card.guarantees.length > 0) {
    projection.guarantees = card.guarantees.map((desc, i) => ({
      description: desc,
      id: `q${i}`,
    }));
  }

  // signature.inputs dimension — array of {name, type}
  if (card.signature?.inputs !== undefined && card.signature.inputs.length > 0) {
    projection.inputs = card.signature.inputs.map((p, i) => ({
      name: p.name ?? `arg${i}`,
      type: p.type,
    }));
  }

  // nonFunctional dimension — Partial<NonFunctionalProperties> as-is
  // Only include if at least one key is present (avoid empty-object noise).
  if (card.nonFunctional !== undefined) {
    const nf = card.nonFunctional;
    const nfEntry: Record<string, JsonValue> = {};
    if (nf.purity !== undefined) nfEntry.purity = nf.purity;
    if (nf.space !== undefined) nfEntry.space = nf.space;
    if (nf.threadSafety !== undefined) nfEntry.threadSafety = nf.threadSafety;
    if (nf.time !== undefined) nfEntry.time = nf.time;
    if (Object.keys(nfEntry).length > 0) {
      projection.nonFunctional = nfEntry;
    }
  }

  // signature.outputs dimension — array of {name, type}
  if (card.signature?.outputs !== undefined && card.signature.outputs.length > 0) {
    projection.outputs = card.signature.outputs.map((p, i) => ({
      name: p.name ?? `out${i}`,
      type: p.type,
    }));
  }

  // propertyTests dimension — array of {description, id: "p<n>"}
  if (card.propertyTests !== undefined && card.propertyTests.length > 0) {
    projection.propertyTests = card.propertyTests.map((desc, i) => ({
      description: desc,
      id: `p${i}`,
    }));
  }

  return encodeValue(projection);
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
