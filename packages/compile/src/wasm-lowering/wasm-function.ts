// @decision DEC-V1-WAVE-3-WASM-PARSE-001
// Title: lower from ts-morph AST parsed at codegen-time; WasmFunction is the IR
// Status: decided (WI-V1W3-WASM-LOWER-01)
// Rationale: ResolvedBlock carries only source:string — no precomputed AST. The visitor
// produces WasmFunction; wasm-backend.ts serializes it. Keeps codegen concerns separated.

/**
 * WASM numeric value type.
 * i32 is the default for wave-3 scaffold; i64/f64 inference deferred to WI-V1W3-WASM-LOWER-02.
 */
export type WasmValType = "i32" | "i64" | "f64";

/** A single WASM local (parameter or extra local). */
export interface WasmLocal {
  readonly name: string;
  readonly type: WasmValType;
}

/**
 * Intermediate representation of a single WASM function, produced by LoweringVisitor
 * and consumed by wasm-backend.ts's module emitter.
 *
 * body: raw instruction bytes only — no locals prefix, no end (0x0b) opcode.
 * The module emitter prepends the locals prefix and appends the end opcode.
 */
export interface WasmFunction {
  readonly name: string;
  readonly params: WasmLocal[];
  readonly returnType: WasmValType | null;
  readonly extraLocals: WasmLocal[];
  readonly body: Uint8Array;
}
