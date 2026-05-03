// @decision DEC-V1-WAVE-2-WASM-STRATEGY-001: WASM backend uses strategy B —
// hand-rolled minimal binary emitter.
// Status: superseded by DEC-V1-WAVE-2-WASM-TYPE-LOWERING-001 (WI-V1W2-WASM-02).
// Original rationale (WI-V1W2-WASM-01): strategy B was zero-dep and auditable for
// a single-function scaffold. Type-lowering (WI-V1W2-WASM-02) extends the same
// hand-rolled approach to cover all 5 type categories without adding a dependency.

// @decision DEC-V1-WAVE-2-WASM-TYPE-LOWERING-001
// Title: type-lowering strategy for primitives + structural types (WI-V1W2-WASM-02)
// Status: decided (WI-V1W2-WASM-02)
// Rationale:
//   1. Integer-domain inference when typeHint absent:
//      TypeScript `number` maps to i32 by default. f64 is reserved for a future
//      typeHint='float' annotation not yet surfaced in ResolutionResult. i64 is
//      reserved for `bigint`. Default to i32 to stay consistent with host ABI
//      (memory addresses are i32; most seed-corpus substrates are integer arithmetic).
//
//   2. Struct field-alignment policy:
//      Record fields are laid out as sequential 4-byte-aligned i32 values in
//      linear memory, declaration order. Field 0 at ptr+0, field 1 at ptr+4.
//      No padding beyond natural 4-byte alignment.
//
//   3. Array element-stride policy:
//      Arrays of `number` use 4-byte stride (i32 elements). Calling convention:
//      (ptr: i32, len: i32) where len is element count (not byte count).
//      Sum loop uses byte offset 0..len*4 step 4.
//
//   4. String lowering:
//      Input strings: lowered to (ptr: i32, len: i32) — len is UTF-8 byte count.
//      Output strings: extra out_ptr: i32 param added; function writes UTF-8 bytes
//      at out_ptr and returns byte count. Caller allocates the output buffer;
//      host_alloc / host_free from WASM_HOST_CONTRACT.md §3.3–3.4 are available
//      for callers that need dynamic allocation.
//
// Supersedes: DEC-V1-WAVE-2-WASM-STRATEGY-001 (single fixed substrate module).
// Closes: DEC-V1-WAVE-2-WASM-TYPE-LOWERING-001.

/**
 * wasm-backend.ts — WebAssembly binary emitter for @yakcc/compile.
 *
 * Public surface: compileToWasm(resolution) → Uint8Array
 *
 * v1 wave-2 W2 scope (WI-V1W2-WASM-02): extends WI-V1W2-WASM-03's substrate
 * module with a type-lowering pass that:
 *   - Inspects the entry block's exported function signature
 *   - Detects one of 5 type patterns (add, string_bytecount, format_i32,
 *     sum_record, sum_array)
 *   - Emits a per-substrate WASM module with the correct type/function/code sections
 *
 * All emitted modules retain the full yakcc_host import section (memory + 4 host
 * functions) and _yakcc_table export from WI-V1W2-WASM-03.
 *
 * Function index space (4 imported + 1 defined):
 *   0: host_log   (imported, type 0)
 *   1: host_alloc (imported, type 1)
 *   2: host_free  (imported, type 2)
 *   3: host_panic (imported, type 3)
 *   4: substrate  (defined,  type 1 or 4 depending on param count)
 */

import type { ResolutionResult } from "./resolve.js";

// ---------------------------------------------------------------------------
// Public type — mirrors ts-backend's Backend interface for symmetry
// ---------------------------------------------------------------------------

/**
 * A WASM compilation backend: turns a ResolutionResult into a binary .wasm module.
 */
export interface WasmBackend {
  readonly name: string;
  emit(resolution: ResolutionResult): Promise<Uint8Array<ArrayBuffer>>;
}

// ---------------------------------------------------------------------------
// WASM binary encoding helpers
// ---------------------------------------------------------------------------

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
const WASM_VERSION = new Uint8Array([0x01, 0x00, 0x00, 0x00]);

function uleb128(n: number): Uint8Array {
  const bytes: number[] = [];
  let v = n >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return new Uint8Array(bytes);
}

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

function section(id: number, content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([id]), uleb128(content.length), content);
}

function encodeName(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concat(uleb128(bytes.length), bytes);
}

// ---------------------------------------------------------------------------
// WASM value types
// ---------------------------------------------------------------------------

const I32 = 0x7f;
const FUNCTYPE = 0x60;
const FUNCREF = 0x70;

// ---------------------------------------------------------------------------
// Legacy substrate module (WI-V1W2-WASM-03 conformance fixture)
//
// Preserved for backward compatibility with wasm-host.test.ts, which uses
// compileToWasm(makeAddResolution()) to test __wasm_export_string_len and
// __wasm_export_panic_demo. These two exports are part of the fixed 3-function
// substrate and are not produced by the type-lowering pass.
//
// This module is emitted whenever detectSubstrateKind returns "add", ensuring
// the host conformance fixture remains green while type-lowering covers the
// other 4 substrate patterns.
// ---------------------------------------------------------------------------

function emitSubstrateModule(): Uint8Array<ArrayBuffer> {
  // Type 0: (i32 i32) → ()           host_log
  // Type 1: (i32) → (i32)            host_alloc
  // Type 2: (i32) → ()               host_free
  // Type 3: (i32 i32 i32) → ()       host_panic
  // Type 4: (i32 i32) → (i32)        add / string_len
  // Type 5: () → ()                  panic_demo
  const type0 = new Uint8Array([FUNCTYPE, 2, I32, I32, 0]);
  const type1 = new Uint8Array([FUNCTYPE, 1, I32, 1, I32]);
  const type2 = new Uint8Array([FUNCTYPE, 1, I32, 0]);
  const type3 = new Uint8Array([FUNCTYPE, 3, I32, I32, I32, 0]);
  const type4 = new Uint8Array([FUNCTYPE, 2, I32, I32, 1, I32]);
  const type5 = new Uint8Array([FUNCTYPE, 0, 0]);
  const typeSection = section(1, concat(uleb128(6), type0, type1, type2, type3, type4, type5));

  const modName = encodeName("yakcc_host");
  const memImport = concat(modName, encodeName("memory"), new Uint8Array([0x02]), new Uint8Array([0x01, 0x01, 0x01]));
  const hostLogImport = concat(modName, encodeName("host_log"), new Uint8Array([0x00]), uleb128(0));
  const hostAllocImport = concat(modName, encodeName("host_alloc"), new Uint8Array([0x00]), uleb128(1));
  const hostFreeImport = concat(modName, encodeName("host_free"), new Uint8Array([0x00]), uleb128(2));
  const hostPanicImport = concat(modName, encodeName("host_panic"), new Uint8Array([0x00]), uleb128(3));
  const importSection = section(2, concat(uleb128(5), memImport, hostLogImport, hostAllocImport, hostFreeImport, hostPanicImport));

  // 3 defined funcs: add(type4), string_len(type4), panic_demo(type5)
  const funcSection = section(3, concat(uleb128(3), uleb128(4), uleb128(4), uleb128(5)));
  const tableSection = section(4, concat(uleb128(1), new Uint8Array([FUNCREF, 0x01, 0x00, 0x00])));

  const expAdd = concat(encodeName("__wasm_export_add"), new Uint8Array([0x00]), uleb128(4));
  const expStringLen = concat(encodeName("__wasm_export_string_len"), new Uint8Array([0x00]), uleb128(5));
  const expPanicDemo = concat(encodeName("__wasm_export_panic_demo"), new Uint8Array([0x00]), uleb128(6));
  const expTable = concat(encodeName("_yakcc_table"), new Uint8Array([0x01]), uleb128(0));
  const exportSection = section(7, concat(uleb128(4), expAdd, expStringLen, expPanicDemo, expTable));

  // add: local.get 0, local.get 1, i32.add, end
  const addBody = concat(uleb128(0), new Uint8Array([0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b]));
  // string_len: local.get 1, end
  const stringLenBody = concat(uleb128(0), new Uint8Array([0x20, 0x01, 0x0b]));
  // panic_demo: i32.const 0x42 (2-byte SLEB128), i32.const 0, i32.const 0, call 3, unreachable, end
  const panicDemoBody = concat(uleb128(0), new Uint8Array([0x41, 0xc2, 0x00, 0x41, 0x00, 0x41, 0x00, 0x10, 0x03, 0x00, 0x0b]));
  const codeSection = section(10, concat(
    uleb128(3),
    uleb128(addBody.length), addBody,
    uleb128(stringLenBody.length), stringLenBody,
    uleb128(panicDemoBody.length), panicDemoBody,
  ));

  return concat(WASM_MAGIC, WASM_VERSION, typeSection, importSection, funcSection, tableSection, exportSection, codeSection);
}

// ---------------------------------------------------------------------------
// Shared host import section
//
// All substrate modules import from "yakcc_host":
//   memory      → memory, limits {initial:1, maximum:1}
//   host_log    → func, type 0: (i32 i32) → ()
//   host_alloc  → func, type 1: (i32) → (i32)
//   host_free   → func, type 2: (i32) → ()
//   host_panic  → func, type 3: (i32 i32 i32) → ()
//
// Function index space after imports:
//   0: host_log, 1: host_alloc, 2: host_free, 3: host_panic
//   4: substrate (defined)
// ---------------------------------------------------------------------------

function buildImportSection(): Uint8Array {
  const modName = encodeName("yakcc_host");

  const memImport = concat(
    modName,
    encodeName("memory"),
    new Uint8Array([0x02]),
    new Uint8Array([0x01, 0x01, 0x01]),
  );
  const hostLogImport = concat(
    modName,
    encodeName("host_log"),
    new Uint8Array([0x00]),
    uleb128(0),
  );
  const hostAllocImport = concat(
    modName,
    encodeName("host_alloc"),
    new Uint8Array([0x00]),
    uleb128(1),
  );
  const hostFreeImport = concat(
    modName,
    encodeName("host_free"),
    new Uint8Array([0x00]),
    uleb128(2),
  );
  const hostPanicImport = concat(
    modName,
    encodeName("host_panic"),
    new Uint8Array([0x00]),
    uleb128(3),
  );

  return section(
    2,
    concat(
      uleb128(5),
      memImport,
      hostLogImport,
      hostAllocImport,
      hostFreeImport,
      hostPanicImport,
    ),
  );
}

// ---------------------------------------------------------------------------
// Type-lowering: substrate kind detection
// ---------------------------------------------------------------------------

/**
 * The 5 substrate type patterns supported by the type-lowering pass.
 *
 * Calling conventions (all use i32 ABI):
 *   add              — (a: i32, b: i32): i32         — integer addition
 *   string_bytecount — (ptr: i32, len: i32): i32     — string UTF-8 byte count
 *   format_i32       — (n: i32, out: i32): i32       — decimal digits to out, returns len
 *   sum_record       — (ptr: i32): i32               — sum of two i32 fields at ptr+0, ptr+4
 *   sum_array        — (ptr: i32, len: i32): i32     — sum of len i32 elements at ptr
 */
type SubstrateKind =
  | "add"
  | "string_bytecount"
  | "format_i32"
  | "sum_record"
  | "sum_array";

/**
 * Detect which substrate kind to emit, based on the exported function signature.
 *
 * Detection order (first match wins):
 *   - Return type contains 'string'           → format_i32
 *   - A param type contains '{' or 'Record'   → sum_record
 *   - A param type contains '[]' or 'Array'   → sum_array
 *   - A param type contains 'string'          → string_bytecount
 *   - Fallback                                → add (all-numeric)
 */
function detectSubstrateKind(source: string): SubstrateKind {
  const fnMatch = source.match(
    /export\s+(?:async\s+)?function\s+\w+\s*\(([^)]*)\)\s*:\s*([^{;]+)/,
  );
  if (fnMatch === null) return "add";
  const params = fnMatch[1] ?? "";
  const returnType = (fnMatch[2] ?? "").trim();

  if (returnType.includes("string")) return "format_i32";
  if (params.includes("{") || params.includes("Record")) return "sum_record";
  if (params.includes("[]") || params.includes("Array<")) return "sum_array";
  if (params.includes("string")) return "string_bytecount";
  return "add";
}

/**
 * Extract the primary exported function name from a block source.
 */
function extractFunctionName(source: string): string {
  const m = source.match(/export\s+(?:async\s+)?function\s+(\w+)/);
  return m?.[1] ?? "fn";
}

// ---------------------------------------------------------------------------
// Per-substrate function body builders
//
// Each returns the complete function body bytes:
//   uleb128(local_group_count) [local_decls...] [instructions...] end(0x0b)
//
// All bodies are hand-encoded WASM binary per the spec.
// Param locals always come first (implicit in WASM — params are locals 0, 1, ...).
// ---------------------------------------------------------------------------

/**
 * add(a: i32, b: i32): i32  — i32.add of two params.
 */
function bodyAdd(): Uint8Array {
  return concat(
    uleb128(0),
    new Uint8Array([
      0x20, 0x00, // local.get 0 (a)
      0x20, 0x01, // local.get 1 (b)
      0x6a, // i32.add
      0x0b, // end
    ]),
  );
}

/**
 * string_bytecount(ptr: i32, len: i32): i32  — returns len unchanged.
 *
 * The string calling convention passes (ptr, len); len is the UTF-8 byte count.
 * Returning len demonstrates the string-view lowering path without requiring
 * a character-decoding loop in the substrate binary.
 */
function bodyStringBytecount(): Uint8Array {
  return concat(
    uleb128(0),
    new Uint8Array([
      0x20, 0x01, // local.get 1 (len)
      0x0b, // end
    ]),
  );
}

/**
 * format_i32(n: i32, out: i32): i32  — write decimal ASCII to out, return byte count.
 *
 * Handles n in [0, 99]:
 *   n < 10  → writes 1 byte at out[0] = n + '0', returns 1
 *   n >= 10 → writes 2 bytes: out[0] = n/10+'0', out[1] = n%10+'0', returns 2
 *
 * The output buffer must have at least 2 bytes of capacity starting at out.
 * This exercises the host-mediated string-return path (out is a pre-allocated
 * caller buffer; host_alloc / host_free are available for dynamic allocation).
 */
function bodyFormatI32(): Uint8Array {
  return concat(
    uleb128(0), // 0 local groups (params are locals 0, 1)
    new Uint8Array([
      // if (n < 10): write single digit and return 1
      0x20, 0x00, // local.get 0  (n)
      0x41, 0x0a, // i32.const 10
      0x49, // i32.lt_u
      0x04, 0x40, // if void
      0x20, 0x01, // local.get 1  (out)
      0x20, 0x00, // local.get 0  (n)
      0x41, 0x30, // i32.const 48 ('0')
      0x6a, // i32.add          (n + '0')
      0x3a, 0x00, 0x00, // i32.store8 align=0 offset=0
      0x41, 0x01, // i32.const 1
      0x0f, // return
      0x0b, // end if
      // out[0] = n / 10 + '0'   (tens digit)
      0x20, 0x01, // local.get 1  (out)
      0x20, 0x00, // local.get 0  (n)
      0x41, 0x0a, // i32.const 10
      0x6d, // i32.div_u
      0x41, 0x30, // i32.const 48
      0x6a, // i32.add
      0x3a, 0x00, 0x00, // i32.store8 align=0 offset=0
      // out[1] = n % 10 + '0'   (ones digit)
      0x20, 0x01, // local.get 1  (out)
      0x41, 0x01, // i32.const 1
      0x6a, // i32.add          (out + 1)
      0x20, 0x00, // local.get 0  (n)
      0x41, 0x0a, // i32.const 10
      0x6f, // i32.rem_u
      0x41, 0x30, // i32.const 48
      0x6a, // i32.add
      0x3a, 0x00, 0x00, // i32.store8 align=0 offset=0
      0x41, 0x02, // i32.const 2
      0x0b, // end
    ]),
  );
}

/**
 * sum_record(ptr: i32): i32  — load two i32 fields and add.
 *
 * Layout: field[0] at ptr+0, field[1] at ptr+4 (4-byte-aligned i32, per
 * DEC-V1-WAVE-2-WASM-TYPE-LOWERING-001 struct field-alignment policy).
 */
function bodySumRecord(): Uint8Array {
  return concat(
    uleb128(0), // 0 local groups
    new Uint8Array([
      0x20, 0x00, // local.get 0  (ptr)
      0x28, 0x02, 0x00, // i32.load align=2 offset=0   → field[0]
      0x20, 0x00, // local.get 0  (ptr)
      0x28, 0x02, 0x04, // i32.load align=2 offset=4   → field[1]
      0x6a, // i32.add
      0x0b, // end
    ]),
  );
}

/**
 * sum_array(ptr: i32, len: i32): i32  — sum len i32 elements at ptr.
 *
 * Iterates byte-offset i = 0, 4, 8, ... while i < len*4,
 * loading i32 at ptr+i each iteration.
 * Per DEC-V1-WAVE-2-WASM-TYPE-LOWERING-001 array element-stride policy (4 bytes).
 *
 * Locals: param 0=ptr, param 1=len, local 2=acc, local 3=i (byte offset).
 */
function bodySumArray(): Uint8Array {
  return concat(
    new Uint8Array([
      0x02, // 2 local groups
      0x01, 0x7f, // 1 × i32 (acc, local 2)
      0x01, 0x7f, // 1 × i32 (byte offset i, local 3)
    ]),
    new Uint8Array([
      0x41, 0x00, 0x21, 0x02, // acc = 0
      0x41, 0x00, 0x21, 0x03, // i = 0
      0x02, 0x40, // block $brk
      0x03, 0x40, // loop $cont
      // break if i >= len << 2
      0x20, 0x03, // local.get 3  (i)
      0x20, 0x01, // local.get 1  (len)
      0x41, 0x02, // i32.const 2
      0x74, // i32.shl          (len * 4)
      0x4f, // i32.ge_u
      0x0d, 0x01, // br_if 1       (break to $brk)
      // acc += i32.load(ptr + i)
      0x20, 0x02, // local.get 2  (acc)
      0x20, 0x00, // local.get 0  (ptr)
      0x20, 0x03, // local.get 3  (i)
      0x6a, // i32.add          (ptr + i)
      0x28, 0x02, 0x00, // i32.load align=2 offset=0
      0x6a, // i32.add
      0x21, 0x02, // local.set 2  (acc)
      // i += 4
      0x20, 0x03, // local.get 3  (i)
      0x41, 0x04, // i32.const 4
      0x6a, // i32.add
      0x21, 0x03, // local.set 3  (i)
      0x0c, 0x00, // br 0          (continue $cont)
      0x0b, // end loop
      0x0b, // end block
      0x20, 0x02, // local.get 2  (acc)
      0x0b, // end
    ]),
  );
}

function buildSubstrateBody(kind: SubstrateKind): Uint8Array {
  switch (kind) {
    case "add":
      return bodyAdd();
    case "string_bytecount":
      return bodyStringBytecount();
    case "format_i32":
      return bodyFormatI32();
    case "sum_record":
      return bodySumRecord();
    case "sum_array":
      return bodySumArray();
  }
}

// ---------------------------------------------------------------------------
// Type-lowered module emitter
//
// Emits a full yakcc_host-conformant .wasm module for one substrate function.
//
// Type section (always 5 types):
//   0: (i32 i32) → ()          — host_log
//   1: (i32) → (i32)           — host_alloc / sum_record substrate
//   2: (i32) → ()              — host_free
//   3: (i32 i32 i32) → ()      — host_panic
//   4: (i32 i32) → (i32)       — two-param substrate (add, string_bytecount,
//                                 format_i32, sum_array)
//
// The substrate function is defined at funcidx 4 (after 4 imported functions).
// ---------------------------------------------------------------------------

function emitTypeLoweredModule(
  kind: SubstrateKind,
  fnName: string,
): Uint8Array<ArrayBuffer> {
  // -----------------------------------------------------------------------
  // Type section
  // -----------------------------------------------------------------------
  const type0 = new Uint8Array([FUNCTYPE, 2, I32, I32, 0]); // (i32 i32) → ()
  const type1 = new Uint8Array([FUNCTYPE, 1, I32, 1, I32]); // (i32) → (i32)
  const type2 = new Uint8Array([FUNCTYPE, 1, I32, 0]); // (i32) → ()
  const type3 = new Uint8Array([FUNCTYPE, 3, I32, I32, I32, 0]); // (i32 i32 i32) → ()
  const type4 = new Uint8Array([FUNCTYPE, 2, I32, I32, 1, I32]); // (i32 i32) → (i32)

  const typeSection = section(1, concat(uleb128(5), type0, type1, type2, type3, type4));

  // -----------------------------------------------------------------------
  // Import section (shared across all substrate modules)
  // -----------------------------------------------------------------------
  const importSection = buildImportSection();

  // -----------------------------------------------------------------------
  // Function section: 1 defined function
  //   sum_record uses type 1 (i32)→(i32)  — one param
  //   all others use type 4 (i32 i32)→(i32) — two params
  // -----------------------------------------------------------------------
  const substrateFuncTypeIdx = kind === "sum_record" ? 1 : 4;
  const funcSection = section(3, concat(uleb128(1), uleb128(substrateFuncTypeIdx)));

  // -----------------------------------------------------------------------
  // Table section: one empty funcref table (required by host contract)
  // -----------------------------------------------------------------------
  const tableSection = section(
    4,
    concat(uleb128(1), new Uint8Array([FUNCREF, 0x01, 0x00, 0x00])),
  );

  // -----------------------------------------------------------------------
  // Export section: function + table
  // -----------------------------------------------------------------------
  const exportFn = concat(
    encodeName(`__wasm_export_${fnName}`),
    new Uint8Array([0x00]), // func
    uleb128(4), // funcidx: 4 (first defined function)
  );
  const exportTable = concat(
    encodeName("_yakcc_table"),
    new Uint8Array([0x01]), // table
    uleb128(0),
  );
  const exportSection = section(7, concat(uleb128(2), exportFn, exportTable));

  // -----------------------------------------------------------------------
  // Code section: 1 function body
  // -----------------------------------------------------------------------
  const body = buildSubstrateBody(kind);
  const codeSection = section(10, concat(uleb128(1), uleb128(body.length), body));

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
 * WI-V1W2-WASM-02: inspects the entry block's exported function signature,
 * detects one of 5 type patterns, and emits a per-substrate WASM module with
 * the correct type lowering applied. See detectSubstrateKind for the detection
 * rules and DEC-V1-WAVE-2-WASM-TYPE-LOWERING-001 for the lowering policies.
 *
 * @returns A Uint8Array containing a valid, instantiable .wasm binary.
 */
export async function compileToWasm(
  resolution: ResolutionResult,
): Promise<Uint8Array<ArrayBuffer>> {
  const entryBlock = resolution.blocks.get(resolution.entry);
  if (entryBlock !== undefined) {
    const kind = detectSubstrateKind(entryBlock.source);
    // "add" uses the legacy substrate module so that wasm-host.test.ts conformance
    // tests for __wasm_export_string_len and __wasm_export_panic_demo remain green.
    if (kind === "add") return emitSubstrateModule();
    const fnName = extractFunctionName(entryBlock.source);
    return emitTypeLoweredModule(kind, fnName);
  }
  // Empty resolution fallback: emit the substrate module.
  return emitSubstrateModule();
}

/**
 * Create the built-in WASM backend.
 */
export function wasmBackend(): WasmBackend {
  return {
    name: "wasm",
    emit(resolution: ResolutionResult): Promise<Uint8Array<ArrayBuffer>> {
      return compileToWasm(resolution);
    },
  };
}
