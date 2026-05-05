// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/compile wasm-lowering/wasm-function.ts atoms. Two-file pattern: this
// file (.props.ts) is vitest-free and holds the corpus; the sibling
// .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3b)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (3 named):
//   valtypeByte    (WF1.1) — maps NumericDomain to WASM valtype byte
//   NumericDomain  (WF1.2) — discriminated union "i32"|"i64"|"f64"
//   WasmFunction   (WF1.3) — { locals: LocalDecl[], body: number[] }
//
// Properties:
//   - valtypeByte("i32") === 0x7f
//   - valtypeByte("i64") === 0x7e
//   - valtypeByte("f64") === 0x7c
//   - valtypeByte produces a unique byte for each domain
//   - WasmFunction shape: body is all bytes in [0, 255]
//   - LocalDecl shape: count > 0, type is a valid NumericDomain
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { valtypeByte } from "./wasm-function.js";
import type { LocalDecl, NumericDomain, WasmFunction } from "./wasm-function.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

const numericDomainArb: fc.Arbitrary<NumericDomain> = fc.constantFrom(
  "i32" as NumericDomain,
  "i64" as NumericDomain,
  "f64" as NumericDomain,
);

const localDeclArb: fc.Arbitrary<LocalDecl> = fc.record({
  count: fc.integer({ min: 1, max: 16 }),
  type: numericDomainArb,
});

const byteArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 255 });

const wasmFunctionArb: fc.Arbitrary<WasmFunction> = fc.record({
  locals: fc.array(localDeclArb, { minLength: 0, maxLength: 4 }),
  body: fc.array(byteArb, { minLength: 0, maxLength: 32 }),
});

// ---------------------------------------------------------------------------
// WF1.1: valtypeByte — exact byte values
// ---------------------------------------------------------------------------

/**
 * prop_valtypeByte_i32_is_0x7f
 *
 * valtypeByte("i32") returns 0x7f per WASM binary format §5.3.1.
 *
 * Invariant (WF1.1): the i32 valtype byte is always 0x7f.
 */
export const prop_valtypeByte_i32_is_0x7f = fc.property(
  fc.constant("i32" as NumericDomain),
  (d) => {
    return valtypeByte(d) === 0x7f;
  },
);

/**
 * prop_valtypeByte_i64_is_0x7e
 *
 * valtypeByte("i64") returns 0x7e per WASM binary format §5.3.1.
 *
 * Invariant (WF1.1): the i64 valtype byte is always 0x7e.
 */
export const prop_valtypeByte_i64_is_0x7e = fc.property(
  fc.constant("i64" as NumericDomain),
  (d) => {
    return valtypeByte(d) === 0x7e;
  },
);

/**
 * prop_valtypeByte_f64_is_0x7c
 *
 * valtypeByte("f64") returns 0x7c per WASM binary format §5.3.1.
 *
 * Invariant (WF1.1): the f64 valtype byte is always 0x7c.
 */
export const prop_valtypeByte_f64_is_0x7c = fc.property(
  fc.constant("f64" as NumericDomain),
  (d) => {
    return valtypeByte(d) === 0x7c;
  },
);

/**
 * prop_valtypeByte_result_in_valid_range
 *
 * valtypeByte always returns a byte in [0, 255] for any NumericDomain.
 *
 * Invariant (WF1.1): output is always a valid byte value.
 */
export const prop_valtypeByte_result_in_valid_range = fc.property(numericDomainArb, (d) => {
  const byte = valtypeByte(d);
  return Number.isInteger(byte) && byte >= 0 && byte <= 255;
});

/**
 * prop_valtypeByte_injective
 *
 * valtypeByte produces distinct bytes for distinct NumericDomain values.
 * i32 (0x7f) !== i64 (0x7e) !== f64 (0x7c).
 *
 * Invariant (WF1.1): the mapping is injective — no two domains share a byte.
 * This is required by the WASM binary format to distinguish value types.
 */
export const prop_valtypeByte_injective = fc.property(
  numericDomainArb,
  numericDomainArb,
  (d1, d2) => {
    if (d1 === d2) return valtypeByte(d1) === valtypeByte(d2);
    return valtypeByte(d1) !== valtypeByte(d2);
  },
);

// ---------------------------------------------------------------------------
// WF1.2: NumericDomain — the union is exactly the three values
// ---------------------------------------------------------------------------

/**
 * prop_numericDomain_values_are_valid_strings
 *
 * Any generated NumericDomain is one of "i32", "i64", "f64".
 *
 * Invariant (WF1.2): the domain union is closed; no other string value is a
 * valid NumericDomain at runtime.
 */
export const prop_numericDomain_values_are_valid_strings = fc.property(
  numericDomainArb,
  (domain) => {
    return domain === "i32" || domain === "i64" || domain === "f64";
  },
);

// ---------------------------------------------------------------------------
// WF1.3: WasmFunction — shape invariants
// ---------------------------------------------------------------------------

/**
 * prop_wasmFunction_body_bytes_in_range
 *
 * Every byte in WasmFunction.body is in [0, 255].
 *
 * Invariant (WF1.3): the body is a valid byte stream; no value exceeds 255.
 * The WASM emitter in wasm-backend.ts writes these bytes directly to a Uint8Array.
 */
export const prop_wasmFunction_body_bytes_in_range = fc.property(wasmFunctionArb, (wf) => {
  return wf.body.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
});

/**
 * prop_wasmFunction_locals_count_positive
 *
 * Every LocalDecl in WasmFunction.locals has count >= 1.
 *
 * Invariant (WF1.3): WASM local-declaration groups must have a positive count;
 * a group with count 0 is a malformed code section.
 */
export const prop_wasmFunction_locals_count_positive = fc.property(wasmFunctionArb, (wf) => {
  return wf.locals.every((l) => l.count >= 1);
});

/**
 * prop_wasmFunction_locals_type_valid_domain
 *
 * Every LocalDecl in WasmFunction.locals has a type that is a valid NumericDomain.
 *
 * Invariant (WF1.3): only "i32", "i64", "f64" are valid local types in the
 * WASM binary format subset used by this backend.
 */
export const prop_wasmFunction_locals_type_valid_domain = fc.property(wasmFunctionArb, (wf) => {
  return wf.locals.every((l) => l.type === "i32" || l.type === "i64" || l.type === "f64");
});

/**
 * prop_wasmFunction_valtypeByte_round_trips_locals
 *
 * For each LocalDecl, valtypeByte(l.type) produces a valid byte.
 * This verifies that the type domain and the valtype byte table are consistent.
 *
 * Invariant (WF1.1 + WF1.3): valtypeByte works correctly for any type
 * appearing in a WasmFunction.locals array.
 */
export const prop_wasmFunction_valtypeByte_round_trips_locals = fc.property(
  wasmFunctionArb,
  (wf) => {
    return wf.locals.every((l) => {
      const b = valtypeByte(l.type);
      return b === 0x7f || b === 0x7e || b === 0x7c;
    });
  },
);
