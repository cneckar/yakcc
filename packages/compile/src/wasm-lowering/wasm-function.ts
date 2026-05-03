// SPDX-License-Identifier: MIT
/**
 * wasm-function.ts — Intermediate representation for a single compiled WASM function.
 *
 * Purpose:
 *   A `WasmFunction` captures the locals and opcode stream produced by the
 *   `LoweringVisitor` for one exported TypeScript function. The existing
 *   wave-2 binary emitter in `wasm-backend.ts` serialises it into the WASM
 *   code section. This clean separation lets visitor WIs (02–11) focus on
 *   lowering logic without touching binary encoding.
 *
 * Rationale:
 *   - Decouples "what opcodes to emit" from "how to encode opcodes as bytes".
 *   - Keeps the WasmFunction type small so wave-3 WIs can evolve it
 *     incrementally as new node kinds are supported.
 *   - Numeric domain enum lives here (not in visitor.ts) so symbol-table.ts
 *     can reference it without a circular import.
 *
 * @decision DEC-V1-WAVE-3-WASM-PARSE-001
 * @title Lower from ts-morph AST parsed at codegen-time from ResolvedBlock.source
 * @status accepted
 * @rationale
 *   ResolvedBlock carries only `source: string` — no precomputed AST. The
 *   wave-2 forbidden-list bars modifying @yakcc/shave (which has ts-morph),
 *   so @yakcc/compile adds the dep at its own package.json. ts-morph's
 *   typechecker also answers the i32/i64/f64 inference question in
 *   WI-V1W3-WASM-LOWER-02 — a separate parser would re-implement that
 *   infrastructure. See also MASTER_PLAN.md DEC-V1-WAVE-3-WASM-PARSE-001.
 */

// ---------------------------------------------------------------------------
// Numeric domain
//
// WI-V1W3-WASM-LOWER-02 populates this via ts-morph type inference.
// This WI stubs it at "i32" (the wave-2 default) for all fast-path substrates.
// ---------------------------------------------------------------------------

/**
 * The WASM numeric value type inferred for a TypeScript expression.
 *
 * Inference rules (wave-2 defaults, refined in WI-V1W3-WASM-LOWER-02):
 *   - `number`  → i32  (host ABI; most substrates are integer arithmetic)
 *   - `bigint`  → i64  (reserved; not yet emitted by any wave-2 substrate)
 *   - `float`   → f64  (reserved; surfaced only when a typeHint='float'
 *                        annotation is present — not yet available)
 *
 * @decision DEC-V1-WAVE-2-WASM-TYPE-LOWERING-001 (WI-V1W2-WASM-02):
 *   Default TypeScript `number` → i32. Consistent with host ABI and the
 *   fact that memory addresses are i32 in the 32-bit WASM linear-memory model.
 */
export type NumericDomain = "i32" | "i64" | "f64";

// ---------------------------------------------------------------------------
// Local variable declaration
//
// WASM local declarations appear in the function body as (count × valtype)
// pairs that precede the instruction stream. See WASM binary format §5.4.6.
// ---------------------------------------------------------------------------

/**
 * A single group of local variable declarations inside a WASM function body.
 *
 * Example: `{ count: 2, type: "i32" }` encodes two i32 locals in one group.
 * Grouping is an optimisation: adjacent locals of the same type share a count
 * prefix. The visitor emits one group per unique type unless it knows multiple
 * consecutive locals share a type.
 */
export interface LocalDecl {
  readonly count: number;
  readonly type: NumericDomain;
}

// ---------------------------------------------------------------------------
// WasmFunction — the primary output of LoweringVisitor per exported function
// ---------------------------------------------------------------------------

/**
 * Intermediate representation for a single compiled WASM function.
 *
 * The fields map directly to the WASM binary code section structure:
 *   - `locals` — local variable declarations (not including params, which are
 *     implicit in WASM and assigned the first local slots by convention)
 *   - `body` — opcode stream as raw bytes (each element is one byte)
 *
 * The wave-2 emitter in wasm-backend.ts serialises this as:
 *   uleb128(locals.length)
 *   [ uleb128(d.count), valtype(d.type) for d in locals ]
 *   [ b for b in body ]
 *   0x0b  (end)
 *
 * Note: the `end` opcode (0x0b) is appended by the emitter, NOT included in
 * `body`, so visitor implementations must not include it.
 */
export interface WasmFunction {
  /** Explicit local variable declarations (params are implicit, not listed here). */
  readonly locals: ReadonlyArray<LocalDecl>;
  /**
   * Opcode byte stream. Each number is a byte in [0, 255].
   * Does NOT include the terminal `end` (0x0b) — the emitter appends that.
   */
  readonly body: ReadonlyArray<number>;
}

// ---------------------------------------------------------------------------
// Helpers for building WasmFunction values during lowering
// ---------------------------------------------------------------------------

/**
 * Encode a WASM numeric type as its binary valtype byte.
 *
 * Spec reference: WASM binary format §5.3.1 (value types).
 *   i32 = 0x7f, i64 = 0x7e, f64 = 0x7c
 */
export function valtypeByte(domain: NumericDomain): number {
  switch (domain) {
    case "i32":
      return 0x7f;
    case "i64":
      return 0x7e;
    case "f64":
      return 0x7c;
  }
}
