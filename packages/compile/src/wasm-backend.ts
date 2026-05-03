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
 * v1 wave-2 W2 scope (WI-V1W2-WASM-03): extends the WI-V1W2-WASM-01 scaffold to
 * emit a host-contract-conformant module with:
 *   - Import section (id=2): memory + 4 host functions under yakcc_host
 *   - Table section (id=4) + table export: _yakcc_table (funcref, size 0)
 *   - Three hard-coded exported functions:
 *       __wasm_export_add(a:i32,b:i32)→i32          — arithmetic substrate
 *       __wasm_export_string_len(ptr:i32,len:i32)→i32 — string interchange
 *       __wasm_export_panic_demo()→()               — panic path demo
 *
 * The binary encoding follows WASM_HOST_CONTRACT.md §§3–4 exactly.
 * Import indices in the function section are shifted by the number of imported
 * functions (5 type-imports count as nothing; only func imports shift indices):
 *   - Imported funcs: host_log=0, host_alloc=1, host_free=2, host_panic=3
 *   - Defined funcs:  add=4, string_len=5, panic_demo=6
 *
 * Type-lowering for arbitrary IR types is out of scope here — that is WI-V1W2-WASM-02.
 *
 * Future implementers (WI-V1W2-WASM-02): inspect `resolution` to lower the IR
 * type annotations in each block's source to WASM types, then emit the appropriate
 * type/function/code sections. Replace `emitSubstrateModule` with a lowering pass
 * that iterates over `resolution.order` and emits one WASM function per block.
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

/**
 * Encode a UTF-8 string as a WASM name: uleb128(byteLen) + bytes.
 * Used in import/export descriptors.
 */
function encodeName(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concat(uleb128(bytes.length), bytes);
}

// ---------------------------------------------------------------------------
// WASM value types and descriptors
// ---------------------------------------------------------------------------

const I32 = 0x7f; // i32 value type
const FUNCTYPE = 0x60; // function type marker
const FUNCREF = 0x70; // funcref type

// ---------------------------------------------------------------------------
// Substrate module: import section + 3 hard-coded exported functions
//
// Index space overview (per WASM spec §2.5.1):
//   Types    — indices into the type section (0-based)
//   Functions — ALL functions (imported + defined) share one index space
//     0: host_log         (imported func, type 0: (i32 i32) → ())
//     1: host_alloc       (imported func, type 1: (i32) → (i32))
//     2: host_free        (imported func, type 2: (i32) → ())
//     3: host_panic       (imported func, type 3: (i32 i32 i32) → ())
//     4: add              (defined func,  type 4: (i32 i32) → (i32))
//     5: string_len       (defined func,  type 4: (i32 i32) → (i32)) — same sig as add
//     6: panic_demo       (defined func,  type 5: () → ())
//
//   Tables — one table: _yakcc_table (size 0)
//   Memories — one memory: imported from yakcc_host (index 0)
//
// The memory import index (0) is separate from the function import index space.
// ---------------------------------------------------------------------------

/**
 * Emit the substrate WASM module with host imports + 3 exported functions.
 *
 * Sections emitted (in required order per spec §2.5):
 *   1. Type section (id=1)   — 6 function type signatures
 *   2. Import section (id=2) — memory + 4 host funcs under yakcc_host
 *   3. Function section (id=3) — 3 defined functions (typeidx references)
 *   4. Table section (id=4)  — 1 funcref table, size 0
 *   5. Export section (id=7) — 4 exports: 3 functions + 1 table
 *   6. Code section (id=10)  — 3 function bodies
 *
 * Conforms to WASM_HOST_CONTRACT.md §§3–4.
 */
function emitSubstrateModule(): Uint8Array<ArrayBuffer> {
  // -----------------------------------------------------------------------
  // Type section (id=1)
  // -----------------------------------------------------------------------
  // Type 0: (i32 i32) → ()           — host_log signature
  // Type 1: (i32) → (i32)            — host_alloc signature
  // Type 2: (i32) → ()               — host_free signature
  // Type 3: (i32 i32 i32) → ()       — host_panic signature
  // Type 4: (i32 i32) → (i32)        — add / string_len signature
  // Type 5: () → ()                  — panic_demo signature

  const type0 = new Uint8Array([FUNCTYPE, 2, I32, I32, 0]); // (i32 i32) → ()
  const type1 = new Uint8Array([FUNCTYPE, 1, I32, 1, I32]); // (i32) → (i32)
  const type2 = new Uint8Array([FUNCTYPE, 1, I32, 0]); // (i32) → ()
  const type3 = new Uint8Array([FUNCTYPE, 3, I32, I32, I32, 0]); // (i32 i32 i32) → ()
  const type4 = new Uint8Array([FUNCTYPE, 2, I32, I32, 1, I32]); // (i32 i32) → (i32)
  const type5 = new Uint8Array([FUNCTYPE, 0, 0]); // () → ()

  const typeSection = section(
    1,
    concat(
      uleb128(6), // 6 types
      type0,
      type1,
      type2,
      type3,
      type4,
      type5,
    ),
  );

  // -----------------------------------------------------------------------
  // Import section (id=2)
  // -----------------------------------------------------------------------
  // Imports under module "yakcc_host":
  //   "memory"      → memory, limits {initial:1, maximum:1}
  //   "host_log"    → func, type 0
  //   "host_alloc"  → func, type 1
  //   "host_free"   → func, type 2
  //   "host_panic"  → func, type 3
  //
  // Import descriptor kinds: 0x00=func, 0x01=table, 0x02=memory, 0x03=global
  //
  // Memory limits encoding: 0x01 <min> <max> (flags=0x01 means max is present)

  const modName = encodeName("yakcc_host");

  // memory import
  const memImport = concat(
    modName,
    encodeName("memory"),
    new Uint8Array([0x02]), // importdesc: memory
    new Uint8Array([0x01, 0x01, 0x01]), // limits: flags=0x01 (max present), min=1, max=1
  );

  // host_log func import (type 0)
  const hostLogImport = concat(
    modName,
    encodeName("host_log"),
    new Uint8Array([0x00]), // importdesc: func
    uleb128(0), // typeidx: 0
  );

  // host_alloc func import (type 1)
  const hostAllocImport = concat(
    modName,
    encodeName("host_alloc"),
    new Uint8Array([0x00]),
    uleb128(1), // typeidx: 1
  );

  // host_free func import (type 2)
  const hostFreeImport = concat(
    modName,
    encodeName("host_free"),
    new Uint8Array([0x00]),
    uleb128(2), // typeidx: 2
  );

  // host_panic func import (type 3)
  const hostPanicImport = concat(
    modName,
    encodeName("host_panic"),
    new Uint8Array([0x00]),
    uleb128(3), // typeidx: 3
  );

  const importSection = section(
    2,
    concat(
      uleb128(5), // 5 imports
      memImport,
      hostLogImport,
      hostAllocImport,
      hostFreeImport,
      hostPanicImport,
    ),
  );

  // -----------------------------------------------------------------------
  // Function section (id=3)
  // -----------------------------------------------------------------------
  // vec(3): typeidx for each defined function
  //   func 4 (add)         → type 4
  //   func 5 (string_len)  → type 4
  //   func 6 (panic_demo)  → type 5

  const funcSection = section(
    3,
    concat(
      uleb128(3), // 3 defined functions
      uleb128(4), // add: type 4
      uleb128(4), // string_len: type 4
      uleb128(5), // panic_demo: type 5
    ),
  );

  // -----------------------------------------------------------------------
  // Table section (id=4)
  // -----------------------------------------------------------------------
  // vec(1): one funcref table with limits {initial:0, maximum:0}
  // Table type encoding: reftype(0x70) + limits
  // Limits: flags=0x01 (max present), min=0, max=0

  const tableSection = section(
    4,
    concat(
      uleb128(1), // 1 table
      new Uint8Array([FUNCREF, 0x01, 0x00, 0x00]), // funcref, limits {min:0, max:0}
    ),
  );

  // -----------------------------------------------------------------------
  // Export section (id=7)
  // -----------------------------------------------------------------------
  // 4 exports:
  //   "__wasm_export_add"        → func 4
  //   "__wasm_export_string_len" → func 5
  //   "__wasm_export_panic_demo" → func 6
  //   "_yakcc_table"             → table 0
  //
  // exportdesc: 0x00=func, 0x01=table, 0x02=memory, 0x03=global

  const expAdd = concat(
    encodeName("__wasm_export_add"),
    new Uint8Array([0x00]), // func
    uleb128(4), // funcidx: 4
  );
  const expStringLen = concat(
    encodeName("__wasm_export_string_len"),
    new Uint8Array([0x00]),
    uleb128(5), // funcidx: 5
  );
  const expPanicDemo = concat(
    encodeName("__wasm_export_panic_demo"),
    new Uint8Array([0x00]),
    uleb128(6), // funcidx: 6
  );
  const expTable = concat(
    encodeName("_yakcc_table"),
    new Uint8Array([0x01]), // table
    uleb128(0), // tableidx: 0
  );

  const exportSection = section(
    7,
    concat(
      uleb128(4), // 4 exports
      expAdd,
      expStringLen,
      expPanicDemo,
      expTable,
    ),
  );

  // -----------------------------------------------------------------------
  // Code section (id=10)
  // -----------------------------------------------------------------------
  // 3 function bodies, in definition order (add, string_len, panic_demo)
  //
  // Body format: uleb128(body_size) + [uleb128(local_decl_count)] + instructions + end(0x0b)
  // All function params are accessible as locals 0, 1, ... (params count as locals)

  // --- add body: local.get 0, local.get 1, i32.add, end ---
  const addBody = concat(
    uleb128(0), // 0 local decl groups
    new Uint8Array([
      0x20,
      0x00, // local.get 0  (param a)
      0x20,
      0x01, // local.get 1  (param b)
      0x6a, // i32.add
      0x0b, // end
    ]),
  );

  // --- string_len body: local.get 1 (len param), end ---
  // __wasm_export_string_len(ptr: i32, len: i32) → i32
  // Returns the byte-length unchanged (exercises string interchange path).
  // In a real substrate, this would decode the string and return its character count.
  // Here we return the byte-length to keep the substrate minimal and testable.
  const stringLenBody = concat(
    uleb128(0), // 0 local decl groups
    new Uint8Array([
      0x20,
      0x01, // local.get 1  (param len)
      0x0b, // end
    ]),
  );

  // --- panic_demo body: call host_panic(0x42, 0, 0), unreachable, end ---
  // Calls host_panic with code=0x42 (mapped to "unreachable" kind) and empty message.
  // The unreachable instruction after the call is never reached (host_panic throws),
  // but it is included per WASM_HOST_CONTRACT.md §3.5 (module MUST execute unreachable).
  //
  // Encoding for i32.const:
  //   0x41 <sleb128_value>
  // call instruction: 0x10 <funcidx>
  //   funcidx for host_panic = 3 (import index in the combined func index space)
  const panicDemoBody = concat(
    uleb128(0), // 0 local decl groups
    new Uint8Array([
      0x41,
      0xc2,
      0x00, // i32.const 0x42 (+66) — SLEB128 requires 2 bytes: 0x42 has bit6=1
      // so single byte 0x42 would sign-extend to -62. Correct encoding: 0xC2 (continuation)
      // + 0x00 (sign bit = 0, positive). Decodes as: (0x42 & 0x7F) | (0 << 7) = 0x42 = 66.
      0x41,
      0x00, // i32.const 0     (ptr = 0)
      0x41,
      0x00, // i32.const 0     (len = 0)
      0x10,
      0x03, // call 3          (host_panic, funcidx=3)
      0x00, // unreachable     (trap — host_panic already threw, but spec requires it)
      0x0b, // end
    ]),
  );

  const codeSection = section(
    10,
    concat(
      uleb128(3), // 3 function bodies
      // add body
      uleb128(addBody.length),
      addBody,
      // string_len body
      uleb128(stringLenBody.length),
      stringLenBody,
      // panic_demo body
      uleb128(panicDemoBody.length),
      panicDemoBody,
    ),
  );

  return concat(
    WASM_MAGIC,
    WASM_VERSION,
    typeSection,
    importSection,
    funcSection,
    tableSection,
    exportSection,
    codeSection,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a ResolutionResult to a WebAssembly binary module.
 *
 * v1 wave-2 W2 (WI-V1W2-WASM-03): emits the substrate module with:
 *   - yakcc_host imports (memory, host_log, host_alloc, host_free, host_panic)
 *   - 3 exported functions: __wasm_export_add, __wasm_export_string_len, __wasm_export_panic_demo
 *   - _yakcc_table export (funcref, size 0)
 *
 * The `resolution` parameter is accepted for API parity with ts-backend and to
 * establish the signature that WI-V1W2-WASM-02 will use for real IR-to-WASM lowering.
 *
 * Future implementers (WI-V1W2-WASM-02): inspect `resolution` to lower the IR
 * type annotations in each block's source to WASM types, then emit the appropriate
 * type/function/code sections. Replace `emitSubstrateModule()` with a lowering pass
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
  return emitSubstrateModule();
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
