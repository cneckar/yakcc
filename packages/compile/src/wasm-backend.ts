// @decision DEC-V1-WAVE-2-WASM-STRATEGY-001: WASM backend uses strategy B —
// hand-rolled minimal binary emitter.
// Status: decided (WI-V1W2-WASM-01)
// Rationale:
//   Strategy A (binaryen npm package) is ~10 MB and ergonomic but premature for
//   a single-function substrate (add(a,b) ⟹ ~30-byte .wasm). The dependency cost
//   is not justified until type-lowering (WI-V1W2-WASM-02) requires arbitrary IR.
//   Strategy B (hand-rolled binary emitter) is zero-dep, auditable, ~100 lines,
//   and produces a byte-for-byte correct WebAssembly binary module. The emitter
//   is expressed as pure data (section bytes) so the WASM spec is self-documenting
//   in the code. This is the lowest-risk choice for a scaffold WI.
//   Strategy C (WAT → wabt → binary) adds a build-time tool dependency without
//   buying ergonomics for a single function. Rejected for same reasons as A.
//   This decision is superseded only by a later DEC when type-lowering requires
//   a full IR-to-WASM lowering pass.
// Closes: opens — superseded only by a later DEC covering WI-V1W2-WASM-02+.

/**
 * wasm-backend.ts — WebAssembly binary emitter for @yakcc/compile.
 *
 * Public surface: compileToWasm(assembly) → Uint8Array
 *
 * v1 wave-2 W1 scope: emits a minimal WASM module for the hard-coded substrate
 *   add(a: number, b: number): number   (both args and result treated as i32)
 *
 * Type-lowering for arbitrary IR types is out of scope here — that is WI-V1W2-WASM-02.
 * Host memory imports / host bindings are out of scope — that is WI-V1W2-WASM-03.
 *
 * The emitter writes the binary encoding directly per the WebAssembly 1.0 spec
 * (https://webassembly.github.io/spec/core/binary/index.html), section by section.
 * No code is generated from the Assembly IR at this stage; the substrate is
 * hard-coded to prove the pipeline compiles and the binary is valid.
 *
 * Future implementers: when WI-V1W2-WASM-02 lands, replace `emitMinimalAddModule`
 * with a real IR-to-WASM lowering pass that inspects `assembly` and emits the
 * appropriate type/function/code sections. The public signature does not change.
 */

import type { ResolutionResult } from "./resolve.js";

// ---------------------------------------------------------------------------
// Public type — mirrors ts-backend's Backend interface for symmetry
// ---------------------------------------------------------------------------

/**
 * A WASM compilation backend: turns a ResolutionResult into a binary .wasm module.
 *
 * emit() returns Uint8Array<ArrayBuffer> (not the wider Uint8Array<ArrayBufferLike>)
 * so the result can be passed directly to WebAssembly.instantiate / WebAssembly.Module
 * whose BufferSource constraint requires ArrayBufferView<ArrayBuffer>.
 */
export interface WasmBackend {
  readonly name: string;
  emit(resolution: ResolutionResult): Promise<Uint8Array<ArrayBuffer>>;
}

// ---------------------------------------------------------------------------
// WASM binary encoding helpers
// ---------------------------------------------------------------------------

/**
 * WebAssembly binary magic bytes and version.
 * All valid .wasm files begin with these eight bytes.
 *   Magic:   0x00 0x61 0x73 0x6d  ("\0asm")
 *   Version: 0x01 0x00 0x00 0x00  (version 1, little-endian)
 */
const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
const WASM_VERSION = new Uint8Array([0x01, 0x00, 0x00, 0x00]);

/**
 * Unsigned LEB128 encoding of a non-negative integer.
 *
 * Used for section lengths, vector lengths, and most integer immediates
 * in the WASM binary format.
 */
function uleb128(n: number): Uint8Array {
  const bytes: number[] = [];
  let v = n >>> 0; // treat as unsigned 32-bit
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return new Uint8Array(bytes);
}

/**
 * Concatenate an arbitrary number of Uint8Arrays into one.
 *
 * The return type is explicitly Uint8Array<ArrayBuffer> (not the wider
 * Uint8Array<ArrayBufferLike>) because new Uint8Array(n) always allocates
 * a plain ArrayBuffer at runtime. The explicit cast satisfies the WebAssembly
 * JS API's BufferSource constraint (= ArrayBufferView<ArrayBuffer> | ArrayBuffer)
 * without introducing any unsafety.
 */
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total) as Uint8Array<ArrayBuffer>;
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Encode a WASM section: section id byte + uleb128(length) + content bytes.
 */
function section(id: number, content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([id]), uleb128(content.length), content);
}

// ---------------------------------------------------------------------------
// Minimal substrate: add(a: i32, b: i32) → i32
//
// The binary encoding follows the WebAssembly 1.0 spec exactly.
// Each section is annotated with its spec reference.
// ---------------------------------------------------------------------------

/**
 * Emit the WASM binary for the minimal substrate: add(a: i32, b: i32) → i32.
 *
 * Sections emitted (in required order per spec §2.5):
 *   1. Type section (id=1)   — one function type: (i32, i32) → i32
 *   2. Function section (id=3) — one function, index into type section
 *   3. Export section (id=7) — exports "add" as function index 0
 *   4. Code section (id=10)  — one function body: local.get 0, local.get 1, i32.add, end
 *
 * No import, memory, global, element, or data sections are needed for this substrate.
 */
function emitMinimalAddModule(): Uint8Array<ArrayBuffer> {
  // --- Type section (id=1) ---
  // vec(1) of functype: [0x60] param_count=2 [i32, i32] result_count=1 [i32]
  // WASM value types: i32=0x7f, i64=0x7e, f32=0x7d, f64=0x7c
  // functype marker: 0x60
  const I32 = 0x7f;
  const FUNCTYPE = 0x60;
  const typeSection = section(
    1,
    concat(
      uleb128(1), // vec length: 1 type
      new Uint8Array([
        FUNCTYPE,
        2, // param count: 2
        I32,
        I32, // param types: i32, i32
        1, // result count: 1
        I32, // result type: i32
      ]),
    ),
  );

  // --- Function section (id=3) ---
  // vec(1) of typeidx: [0] — function 0 has type 0
  const funcSection = section(
    3,
    concat(
      uleb128(1), // vec length: 1 function
      uleb128(0), // typeidx: 0 (the add function type defined above)
    ),
  );

  // --- Export section (id=7) ---
  // vec(1) of export: name="add" (4 bytes), exportdesc=func 0x00, funcidx=0
  const nameBytes = new TextEncoder().encode("add");
  const exportSection = section(
    7,
    concat(
      uleb128(1), // vec length: 1 export
      uleb128(nameBytes.length), // name length
      nameBytes, // name bytes: "add"
      new Uint8Array([0x00]), // exportdesc: func
      uleb128(0), // funcidx: 0
    ),
  );

  // --- Code section (id=10) ---
  // vec(1) of code: one function body
  // Function body: locals=[] (no extra locals beyond params), then instructions
  // Instructions: local.get 0, local.get 1, i32.add, end
  //   local.get: 0x20 <localidx>
  //   i32.add:   0x6a
  //   end:       0x0b
  const funcBody = concat(
    uleb128(0), // local decl count: 0 (params are already in scope as locals 0 and 1)
    new Uint8Array([
      0x20,
      0x00, // local.get 0  (parameter a)
      0x20,
      0x01, // local.get 1  (parameter b)
      0x6a, // i32.add
      0x0b, // end
    ]),
  );
  const codeSection = section(
    10,
    concat(
      uleb128(1), // vec length: 1 function body
      uleb128(funcBody.length), // body size in bytes
      funcBody,
    ),
  );

  return concat(WASM_MAGIC, WASM_VERSION, typeSection, funcSection, exportSection, codeSection);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a ResolutionResult to a WebAssembly binary module.
 *
 * v1 wave-2 W1: always emits the hard-coded minimal substrate (add(a:i32,b:i32)→i32).
 * The `resolution` parameter is accepted for API parity with ts-backend and to
 * establish the signature that WI-V1W2-WASM-02 will use for real IR-to-WASM lowering.
 *
 * Future implementers (WI-V1W2-WASM-02): inspect `resolution` to lower the IR
 * type annotations in each block's source to WASM types, then emit the appropriate
 * type/function/code sections. Replace `emitMinimalAddModule()` with a lowering pass
 * that iterates over `resolution.order` and emits one WASM function per block.
 *
 * @returns A Uint8Array containing a valid, instantiable .wasm binary.
 */
export async function compileToWasm(
  // resolution is intentionally used as a parameter even though it is not yet
  // inspected, to establish the public signature for downstream WIs.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _resolution: ResolutionResult,
): Promise<Uint8Array<ArrayBuffer>> {
  return emitMinimalAddModule();
}

/**
 * Create the built-in WASM backend.
 *
 * Returns a WasmBackend whose emit() method delegates to compileToWasm().
 * Callers may use this backend directly or pass it to the assemble() target
 * parameter once target-routing is wired (WI-V1W2-WASM-01 scope).
 */
export function wasmBackend(): WasmBackend {
  return {
    name: "wasm",
    emit(resolution: ResolutionResult): Promise<Uint8Array<ArrayBuffer>> {
      return compileToWasm(resolution);
    },
  };
}
