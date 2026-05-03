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
 * v1 wave-2 W3 scope: emits a module with host imports, 3-function substrate:
 *   add(a: i32, b: i32) → i32        — back-compat from WASM-01
 *   greet(ptr: i32, len: i32) → i64  — utf-8 string round-trip via host_alloc
 *   divide(a: i32, b: i32) → i32     — explicit host_panic on b==0
 *
 * Imports (namespace "host"):
 *   memory (1 page, max 1), host_log, host_alloc, host_free, host_panic
 *
 * Exports:
 *   __wasm_export_add, __wasm_export_greet, __wasm_export_divide, _yakcc_table
 *
 * See WASM_HOST_CONTRACT.md for the boundary contract.
 *
 * Future implementers (WI-V1W2-WASM-02): replace the hard-coded substrate with a
 * real IR-to-WASM lowering pass that inspects `resolution` and emits per-block functions.
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

/** WASM value types per spec §5.3.1 */
const I32 = 0x7f;
const I64 = 0x7e;
/** functype marker per spec §5.3.6 */
const FUNCTYPE = 0x60;

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

/** Encode a WASM name (length-prefixed UTF-8 bytes). */
function encodeName(name: string): Uint8Array {
  const bytes = new TextEncoder().encode(name);
  return concat(uleb128(bytes.length), bytes);
}

// ---------------------------------------------------------------------------
// Module with host imports + 3-function substrate
//
// Function index space (per WASM spec §2.5.5 — imports first):
//   0 = host.host_log    (imported)
//   1 = host.host_alloc  (imported)
//   2 = host.host_free   (imported)
//   3 = host.host_panic  (imported)
//   4 = add              (local, typeidx 0)
//   5 = greet            (local, typeidx 1)
//   6 = divide           (local, typeidx 2)
//
// Type index space:
//   0 = (i32, i32) → i32           — add, divide
//   1 = (i32, i32) → i64           — greet
//   2 = (i32, i32) → ()            — host_log
//   3 = (i32) → i32                — host_alloc
//   4 = (i32) → ()                 — host_free
//   5 = (i32, i32, i32) → ()       — host_panic
//
// Data segment layout (one passive segment in a data section at offset DATA_OFFSET):
//   Offset 0x00: "Hello, "   (7 bytes) — used by greet
//   Offset 0x07: "!"         (1 byte)  — used by greet
//   Offset 0x08: "division by zero" (16 bytes) — used by divide host_panic
// Total data bytes: 24
//
// The data is copied into memory via memory.init / data.drop — but since we target
// WASM 1.0 only (no bulk-memory proposal), we use active data segments (offset 0)
// and hardcode addresses. The data segment is placed starting at byte 0 of the
// reserved scratch zone. Static addresses:
//   HELLO_PTR  = 0   ("Hello, " — 7 bytes)
//   BANG_PTR   = 7   ("!"       — 1 byte)
//   DIV0_PTR   = 8   ("division by zero" — 16 bytes)
//   DIV0_LEN   = 16
// ---------------------------------------------------------------------------

const HELLO_PREFIX = new TextEncoder().encode("Hello, ");
const BANG = new TextEncoder().encode("!");
const DIV0_MSG = new TextEncoder().encode("division by zero");

const HELLO_PTR = 0; // offset in scratch zone
const BANG_PTR = 7;
const DIV0_PTR = 8;
const DIV0_LEN = 16;

// Funcidx constants (imported funcs first per spec §2.5.5)
// 0=host_log, 1=host_alloc, 2=host_free, 3=host_panic (declaration order)
const FUNCIDX_HOST_ALLOC = 1;
const FUNCIDX_HOST_PANIC = 3;
const FUNCIDX_ADD = 4;
const FUNCIDX_GREET = 5;
const FUNCIDX_DIVIDE = 6;

// Typeidx constants (must match type section order)
const TYPEIDX_I32I32_TO_I32 = 0;
const TYPEIDX_I32I32_TO_I64 = 1;
const TYPEIDX_I32I32_TO_VOID = 2;
const TYPEIDX_I32_TO_I32 = 3;
const TYPEIDX_I32_TO_VOID = 4;
const TYPEIDX_I32I32I32_TO_VOID = 5;

/**
 * Emit the full WASM module with host imports and 3-function substrate.
 *
 * Sections emitted (in required order per spec §2.5):
 *   1. Type section (id=1)
 *   2. Import section (id=2)  — memory + 4 host functions
 *   3. Function section (id=3)
 *   4. Table section (id=4)   — placeholder table for _yakcc_table
 *   5. Export section (id=7)
 *   6. Code section (id=10)
 *   7. Data section (id=11)   — static strings for greet and divide
 */
function emitHostModule(): Uint8Array<ArrayBuffer> {
  // ---------------------------------------------------------------------------
  // Type section (id=1) — 6 function types
  // ---------------------------------------------------------------------------
  const typeSection = section(
    1,
    concat(
      uleb128(6), // 6 types
      // type 0: (i32, i32) → i32  (add, divide)
      new Uint8Array([FUNCTYPE, 2, I32, I32, 1, I32]),
      // type 1: (i32, i32) → i64  (greet)
      new Uint8Array([FUNCTYPE, 2, I32, I32, 1, I64]),
      // type 2: (i32, i32) → ()   (host_log)
      new Uint8Array([FUNCTYPE, 2, I32, I32, 0]),
      // type 3: (i32) → i32       (host_alloc)
      new Uint8Array([FUNCTYPE, 1, I32, 1, I32]),
      // type 4: (i32) → ()        (host_free)
      new Uint8Array([FUNCTYPE, 1, I32, 0]),
      // type 5: (i32, i32, i32) → ()  (host_panic)
      new Uint8Array([FUNCTYPE, 3, I32, I32, I32, 0]),
    ),
  );

  // ---------------------------------------------------------------------------
  // Import section (id=2) — 5 imports from "host" namespace
  // Order: memory, host_log, host_alloc, host_free, host_panic
  // per WASM_HOST_CONTRACT.md §3
  // ---------------------------------------------------------------------------

  // Memory import: importdesc=0x02, limits flag=0x01 (has max), min=1, max=1
  const memImport = concat(
    encodeName("host"),
    encodeName("memory"),
    new Uint8Array([0x02, 0x01, 0x01, 0x01]), // importdesc=memory, flags=has-max, min=1, max=1
  );

  // host_log import: importdesc=0x00 func, typeidx=2
  const hostLogImport = concat(
    encodeName("host"),
    encodeName("host_log"),
    new Uint8Array([0x00]), // importdesc=func
    uleb128(TYPEIDX_I32I32_TO_VOID),
  );

  // host_alloc import: importdesc=0x00 func, typeidx=3
  const hostAllocImport = concat(
    encodeName("host"),
    encodeName("host_alloc"),
    new Uint8Array([0x00]),
    uleb128(TYPEIDX_I32_TO_I32),
  );

  // host_free import: importdesc=0x00 func, typeidx=4
  const hostFreeImport = concat(
    encodeName("host"),
    encodeName("host_free"),
    new Uint8Array([0x00]),
    uleb128(TYPEIDX_I32_TO_VOID),
  );

  // host_panic import: importdesc=0x00 func, typeidx=5
  const hostPanicImport = concat(
    encodeName("host"),
    encodeName("host_panic"),
    new Uint8Array([0x00]),
    uleb128(TYPEIDX_I32I32I32_TO_VOID),
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

  // ---------------------------------------------------------------------------
  // Function section (id=3) — 3 local functions (add, greet, divide)
  // ---------------------------------------------------------------------------
  const funcSection = section(
    3,
    concat(
      uleb128(3), // 3 local functions
      uleb128(TYPEIDX_I32I32_TO_I32), // add: type 0
      uleb128(TYPEIDX_I32I32_TO_I64), // greet: type 1
      uleb128(TYPEIDX_I32I32_TO_I32), // divide: type 0
    ),
  );

  // ---------------------------------------------------------------------------
  // Table section (id=4) — one table: funcref, min=0, max=0
  // Placeholder for _yakcc_table (WI-V1W2-WASM-04+)
  // Binary: elem_type=funcref=0x70, limits flag=0x01, min=0, max=0
  // ---------------------------------------------------------------------------
  const tableSection = section(
    4,
    concat(
      uleb128(1), // 1 table
      new Uint8Array([0x70, 0x01, 0x00, 0x00]), // funcref, has-max, min=0, max=0
    ),
  );

  // ---------------------------------------------------------------------------
  // Export section (id=7) — 4 exports
  // __wasm_export_add (func 4), __wasm_export_greet (func 5),
  // __wasm_export_divide (func 6), _yakcc_table (table 0)
  // ---------------------------------------------------------------------------
  const exportSection = section(
    7,
    concat(
      uleb128(4), // 4 exports

      // __wasm_export_add → funcidx 4
      encodeName("__wasm_export_add"),
      new Uint8Array([0x00]), // exportdesc=func
      uleb128(FUNCIDX_ADD),

      // __wasm_export_greet → funcidx 5
      encodeName("__wasm_export_greet"),
      new Uint8Array([0x00]),
      uleb128(FUNCIDX_GREET),

      // __wasm_export_divide → funcidx 6
      encodeName("__wasm_export_divide"),
      new Uint8Array([0x00]),
      uleb128(FUNCIDX_DIVIDE),

      // _yakcc_table → tableidx 0
      encodeName("_yakcc_table"),
      new Uint8Array([0x01]), // exportdesc=table
      uleb128(0),
    ),
  );

  // ---------------------------------------------------------------------------
  // Code section (id=10) — 3 function bodies
  // ---------------------------------------------------------------------------

  // ---- add(a: i32, b: i32) → i32 ----
  // No locals beyond params.
  // Instructions: local.get 0, local.get 1, i32.add, end
  //   local.get: 0x20 <localidx>
  //   i32.add:   0x6a
  //   end:       0x0b
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

  // ---- greet(in_ptr: i32, in_len: i32) → i64 ----
  //
  // Allocates output buffer: "Hello, " (7) + in_len + "!" (1) bytes.
  // Copies "Hello, " from data segment at addr HELLO_PTR (0).
  // Copies input string from linear memory.
  // Copies "!" from data segment at addr BANG_PTR (7).
  // Returns packed i64 = (out_ptr << 32) | out_len.
  //
  // Locals (declared after params 0=in_ptr, 1=in_len):
  //   local 2: i32 — out_len = 7 + in_len + 1
  //   local 3: i32 — out_ptr (from host_alloc)
  //   local 4: i32 — loop counter / source ptr
  //
  // Memory copy is done byte-by-byte with a loop (WASM 1.0 has no bulk-memory).
  // For simplicity we copy "Hello, " as 7 individual i32.store8 instructions
  // using the static byte values (no data segment read needed for small constants).
  // The input string is copied via a loop.
  //
  // "Hello, " bytes: 72 65 6c 6c 6f 2c 20
  // "!"            : 21
  //
  // WASM opcodes used:
  //   i32.const:     0x41 <sleb128 i32>
  //   i64.const:     0x42 <sleb128 i64>
  //   i32.add:       0x6a
  //   i32.sub:       0x6b (not needed here)
  //   i32.store8:    0x3a <align=0> <offset>
  //   i32.load8_u:   0x2d <align=0> <offset>
  //   i32.ge_u:      0x4f  (not needed — we use i32.ge_s)
  //   i32.ge_s:      0x4e
  //   i32.lt_s:      0x48
  //   local.get:     0x20 <idx>
  //   local.set:     0x21 <idx>
  //   local.tee:     0x22 <idx>
  //   call:          0x10 <funcidx>
  //   block:         0x02 <blocktype>
  //   loop:          0x03 <blocktype>
  //   br:            0x0c <labelidx>
  //   br_if:         0x0d <labelidx>
  //   end:           0x0b
  //   i64.extend_i32_u: 0xad
  //   i64.shl:       0x86
  //   i64.or:        0x84
  //
  // blocktype empty = 0x40

  const BLOCKTYPE_EMPTY = 0x40;

  // Convenience: emit a byte-copy loop from src_local to dst_local for count_local bytes.
  // Uses an inner local for the offset counter.
  // Parameters are local indices (already declared as i32).
  // We inline the loop directly for the greet body.

  const greetBody = (() => {
    // Locals: 2=out_len, 3=out_ptr, 4=i (loop counter)
    // local 0 = in_ptr (param)
    // local 1 = in_len (param)
    const localDecls = concat(
      uleb128(1), // 1 local decl group: 3 locals of type i32
      uleb128(3),
      new Uint8Array([I32]),
    );

    // out_len = 7 + in_len + 1 = 8 + in_len
    const computeOutLen = new Uint8Array([
      0x41,
      8, // i32.const 8
      0x20,
      0x01, // local.get 1 (in_len)
      0x6a, // i32.add
      0x21,
      0x02, // local.set 2 (out_len)
    ]);

    // out_ptr = host_alloc(out_len)
    const callAlloc = new Uint8Array([
      0x20,
      0x02, // local.get 2 (out_len)
      0x10,
      FUNCIDX_HOST_ALLOC, // call host_alloc
      0x21,
      0x03, // local.set 3 (out_ptr)
    ]);

    // Copy "Hello, " (7 bytes) from addresses 0..6 using i32.load8_u + i32.store8
    // i32.store8 operand order (per WASM spec §2.4.5): [addr, val] — addr pushed first.
    // We do: for k in 0..6: mem[out_ptr + k] = mem[HELLO_PTR + k]
    // Instruction sequence per iteration:
    //   push (out_ptr + k)     ← destination address
    //   push mem[HELLO_PTR+k]  ← source byte value
    //   i32.store8
    const copyHello: number[] = [];
    for (let k = 0; k < 7; k++) {
      // Push destination address: out_ptr + k
      copyHello.push(0x20, 0x03); // local.get 3 (out_ptr)
      if (k > 0) {
        copyHello.push(0x41, k); // i32.const k
        copyHello.push(0x6a); // i32.add  → out_ptr + k on stack
      }
      // Push source byte value: mem[HELLO_PTR+k]
      copyHello.push(0x41, HELLO_PTR + k); // i32.const (HELLO_PTR+k)
      copyHello.push(0x2d, 0x00, 0x00); // i32.load8_u align=0 offset=0
      // Store: i32.store8(addr=out_ptr+k, val=mem[HELLO_PTR+k])
      copyHello.push(0x3a, 0x00, 0x00); // i32.store8 align=0 offset=0
    }

    // Copy in_len bytes from in_ptr to out_ptr+7 using a loop
    // local 4 = i (loop index, initialized to 0)
    const copyInput: number[] = [
      // i = 0
      0x41,
      0x00, // i32.const 0
      0x21,
      0x04, // local.set 4 (i)
      // block
      0x02,
      BLOCKTYPE_EMPTY, // block []
      // loop
      0x03,
      BLOCKTYPE_EMPTY, // loop []
      // if i >= in_len: br 1 (exit block)
      0x20,
      0x04, // local.get 4 (i)
      0x20,
      0x01, // local.get 1 (in_len)
      0x4e, // i32.ge_s
      0x0d,
      0x01, // br_if 1 (break out of block)
      // push destination address: out_ptr + 7 + i
      0x20,
      0x03, // local.get 3 (out_ptr)
      0x41,
      7, // i32.const 7
      0x6a, // i32.add
      0x20,
      0x04, // local.get 4 (i)
      0x6a, // i32.add  → out_ptr + 7 + i on stack
      // push source byte value: mem[in_ptr + i]
      0x20,
      0x00, // local.get 0 (in_ptr)
      0x20,
      0x04, // local.get 4 (i)
      0x6a, // i32.add
      0x2d,
      0x00,
      0x00, // i32.load8_u align=0 offset=0
      // i32.store8(addr=out_ptr+7+i, val=mem[in_ptr+i])
      0x3a,
      0x00,
      0x00, // i32.store8 align=0 offset=0
      // i++
      0x20,
      0x04, // local.get 4 (i)
      0x41,
      0x01, // i32.const 1
      0x6a, // i32.add
      0x21,
      0x04, // local.set 4 (i)
      0x0c,
      0x00, // br 0 (continue loop)
      0x0b, // end loop
      0x0b, // end block
    ];

    // Copy "!" (1 byte) to out_ptr + 7 + in_len
    // i32.store8 operand order: addr first, val second (per WASM spec §2.4.5).
    const copyBang: number[] = [
      // push destination address: out_ptr + 7 + in_len
      0x20,
      0x03, // local.get 3 (out_ptr)
      0x41,
      7, // i32.const 7
      0x6a, // i32.add
      0x20,
      0x01, // local.get 1 (in_len)
      0x6a, // i32.add  → out_ptr + 7 + in_len on stack
      // push source byte value: mem[BANG_PTR]
      0x41,
      BANG_PTR, // i32.const BANG_PTR
      0x2d,
      0x00,
      0x00, // i32.load8_u
      // i32.store8(addr=out_ptr+7+in_len, val='!')
      0x3a,
      0x00,
      0x00, // i32.store8
    ];

    // Return packed i64 = (out_ptr << 32) | out_len
    // i64.extend_i32_u: 0xad
    // i64.const 32: 0x42 0x20
    // i64.shl: 0x86 01
    // i64.extend_i32_u out_len
    // i64.or: 0x84 01
    const packReturn: number[] = [
      0x20,
      0x03, // local.get 3 (out_ptr)
      0xad, // i64.extend_i32_u
      0x42,
      0x20, // i64.const 32
      0x86,
      0x01, // i64.shl
      0x20,
      0x02, // local.get 2 (out_len)
      0xad, // i64.extend_i32_u
      0x84,
      0x01, // i64.or
    ];

    const instructions = concat(
      new Uint8Array(computeOutLen),
      new Uint8Array(callAlloc),
      new Uint8Array(copyHello),
      new Uint8Array(copyInput),
      new Uint8Array(copyBang),
      new Uint8Array(packReturn),
      new Uint8Array([0x0b]), // end
    );

    return concat(localDecls, instructions);
  })();

  // ---- divide(a: i32, b: i32) → i32 ----
  //
  // Explicit b==0 check: calls host_panic(1, DIV0_PTR, DIV0_LEN) then unreachable.
  // Otherwise: i32.div_s(a, b).
  //
  // No extra locals needed.
  //
  // Instructions:
  //   if (local.get 1 == 0):
  //     call host_panic(1, DIV0_PTR, DIV0_LEN)
  //     unreachable
  //   else:
  //     local.get 0, local.get 1, i32.div_s, end
  //
  // i32.div_s: 0x6d
  // unreachable: 0x00
  // if: 0x04 <blocktype>
  // else: 0x05
  // i32.eqz: 0x45
  const divideBody = concat(
    uleb128(0), // 0 extra locals
    new Uint8Array([
      // if (b == 0)
      0x20,
      0x01, // local.get 1 (b)
      0x45, // i32.eqz
      0x04,
      I32, // if [i32] — the if/else block produces i32 (matches function return type)
      // then-branch: call host_panic(1, DIV0_PTR, DIV0_LEN), then unreachable
      // The `unreachable` opcode satisfies the stack-typing: since unreachable is a
      // "stack-polymorphic" instruction, it makes the stack valid for any type.
      0x41,
      0x01, // i32.const 1  (panic code)
      0x41,
      DIV0_PTR, // i32.const DIV0_PTR
      0x41,
      DIV0_LEN, // i32.const DIV0_LEN
      0x10,
      FUNCIDX_HOST_PANIC, // call host_panic
      0x00, // unreachable (stack-polymorphic — satisfies i32 return in then-branch)
      0x05, // else
      0x20,
      0x00, // local.get 0 (a)
      0x20,
      0x01, // local.get 1 (b)
      0x6d, // i32.div_s — leaves i32 on stack for the if/else block result
      0x0b, // end if
      0x0b, // end function
    ]),
  );

  // Encode a function body: uleb128(body_size) followed by body bytes.
  function encodeBody(body: Uint8Array): Uint8Array {
    return concat(uleb128(body.length), body);
  }

  const codeSection = section(
    10,
    concat(
      uleb128(3), // 3 function bodies
      encodeBody(addBody),
      encodeBody(greetBody),
      encodeBody(divideBody),
    ),
  );

  // ---------------------------------------------------------------------------
  // Data section (id=11) — active data segment at offset 0
  // Static strings used by greet and divide, placed in the scratch zone [0, 1024).
  //
  // Active data segment: flag=0x00 (active, memidx=0), offset expr, byte vec.
  // offset expr: i32.const 0, end  (bytes: 0x41 0x00 0x0b)
  // ---------------------------------------------------------------------------

  const dataBytes = concat(HELLO_PREFIX, BANG, DIV0_MSG);
  // Sanity: layout is HELLO_PTR=0 (7 bytes), BANG_PTR=7 (1 byte), DIV0_PTR=8 (16 bytes)
  // Total = 24 bytes

  const dataSection = section(
    11,
    concat(
      uleb128(1), // 1 data segment
      new Uint8Array([0x00]), // flag=active, memidx=0 (implicit)
      new Uint8Array([0x41, 0x00, 0x0b]), // offset: i32.const 0, end
      uleb128(dataBytes.length), // vec length
      dataBytes, // actual bytes
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
    dataSection,
  );
}

// ---------------------------------------------------------------------------
// Back-compat: minimal add module (no host imports)
//
// The WASM-01 tests call compileToWasm and then WebAssembly.instantiate(bytes)
// WITHOUT providing host imports. The new module requires host imports, so the
// old tests would fail at instantiate time. We detect the WASM-01 test pattern
// (single-block add resolution) and emit the appropriate module.
//
// Rather than breaking the existing tests, we make compileToWasm() smart:
// when the resolution looks like the "add" substrate (entry block source
// contains `function add`), we still emit the host-import module — but the
// existing WASM-01 tests' direct instantiate calls need to provide imports.
//
// For backward compat, we keep emitMinimalAddModule() available for the
// wasmBackend() factory tests that use it, but compileToWasm now always emits
// the full host-import module. The wasm-backend tests that test the "add" export
// without host imports need to be updated (they are in wasm-backend.test.ts
// which is in scope).
//
// NOTE: The old tests that call WebAssembly.instantiate(bytes) without imports
// will fail because the new module requires host imports. Those tests are updated
// in wasm-backend.test.ts as part of this WI scope.
// ---------------------------------------------------------------------------

/**
 * Compile a ResolutionResult to a WebAssembly binary module.
 *
 * Emits the 3-function substrate with host imports (add, greet, divide).
 * The `resolution` parameter is accepted for API parity with ts-backend and to
 * establish the signature for WI-V1W2-WASM-02.
 *
 * @returns A Uint8Array containing a valid, instantiable .wasm binary.
 */
export async function compileToWasm(
  // resolution accepted for API parity; WI-V1W2-WASM-02 will use it for IR lowering.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _resolution: ResolutionResult,
): Promise<Uint8Array<ArrayBuffer>> {
  return emitHostModule();
}

/**
 * Create the built-in WASM backend.
 *
 * Returns a WasmBackend whose emit() method delegates to compileToWasm().
 */
export function wasmBackend(): WasmBackend {
  return {
    name: "wasm",
    emit(resolution: ResolutionResult): Promise<Uint8Array<ArrayBuffer>> {
      return compileToWasm(resolution);
    },
  };
}
