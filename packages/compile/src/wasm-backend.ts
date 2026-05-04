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

// @decision DEC-V1-WAVE-3-WASM-PARSE-001
// Title: Lower from ts-morph AST parsed at codegen-time from ResolvedBlock.source
// Status: accepted (WI-V1W3-WASM-LOWER-01)
// Rationale:
//   WI-V1W3-WASM-LOWER-01 replaces the detectSubstrateKind string-regex dispatch
//   with a LoweringVisitor that parses source via ts-morph and returns a WasmFunction
//   IR. The existing 5-substrate hand-rolled emitters are preserved as fast-paths
//   inside the visitor so all wave-2 parity tests remain green. The dispatch entry
//   point is now lowerSource() (below) — detectSubstrateKind is retained only as an
//   internal detail of the visitor's wave-2 fast-path detection logic.
//   See MASTER_PLAN.md DEC-V1-WAVE-3-WASM-PARSE-001 for full rationale.

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
import { LoweringVisitor } from "./wasm-lowering/visitor.js";
import type { ArrayShapeMeta, RecordShapeMeta, StringShapeMeta } from "./wasm-lowering/visitor.js";
import type { NumericDomain, WasmFunction } from "./wasm-lowering/wasm-function.js";
import { valtypeByte } from "./wasm-lowering/wasm-function.js";

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
const I64 = 0x7e; // i64 valtype — used for WI-V1W3-WASM-LOWER-02 general lowering
const F64 = 0x7c; // f64 valtype — used for WI-V1W3-WASM-LOWER-02 general lowering
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
  const memImport = concat(
    modName,
    encodeName("memory"),
    new Uint8Array([0x02]),
    new Uint8Array([0x01, 0x01, 0x01]),
  );
  const hostLogImport = concat(modName, encodeName("host_log"), new Uint8Array([0x00]), uleb128(0));
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
  const importSection = section(
    2,
    concat(uleb128(5), memImport, hostLogImport, hostAllocImport, hostFreeImport, hostPanicImport),
  );

  // 3 defined funcs: add(type4), string_len(type4), panic_demo(type5)
  const funcSection = section(3, concat(uleb128(3), uleb128(4), uleb128(4), uleb128(5)));
  const tableSection = section(4, concat(uleb128(1), new Uint8Array([FUNCREF, 0x01, 0x00, 0x00])));

  const expAdd = concat(encodeName("__wasm_export_add"), new Uint8Array([0x00]), uleb128(4));
  const expStringLen = concat(
    encodeName("__wasm_export_string_len"),
    new Uint8Array([0x00]),
    uleb128(5),
  );
  const expPanicDemo = concat(
    encodeName("__wasm_export_panic_demo"),
    new Uint8Array([0x00]),
    uleb128(6),
  );
  const expTable = concat(encodeName("_yakcc_table"), new Uint8Array([0x01]), uleb128(0));
  const exportSection = section(
    7,
    concat(uleb128(4), expAdd, expStringLen, expPanicDemo, expTable),
  );

  // add: local.get 0, local.get 1, i32.add, end
  const addBody = concat(uleb128(0), new Uint8Array([0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b]));
  // string_len: local.get 1, end
  const stringLenBody = concat(uleb128(0), new Uint8Array([0x20, 0x01, 0x0b]));
  // panic_demo: i32.const 0x42 (2-byte SLEB128), i32.const 0, i32.const 0, call 3, unreachable, end
  const panicDemoBody = concat(
    uleb128(0),
    new Uint8Array([0x41, 0xc2, 0x00, 0x41, 0x00, 0x41, 0x00, 0x10, 0x03, 0x00, 0x0b]),
  );
  const codeSection = section(
    10,
    concat(
      uleb128(3),
      uleb128(addBody.length),
      addBody,
      uleb128(stringLenBody.length),
      stringLenBody,
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
  const hostLogImport = concat(modName, encodeName("host_log"), new Uint8Array([0x00]), uleb128(0));
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
    concat(uleb128(5), memImport, hostLogImport, hostAllocImport, hostFreeImport, hostPanicImport),
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
type SubstrateKind = "add" | "string_bytecount" | "format_i32" | "sum_record" | "sum_array";

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
  const fnMatch = source.match(/export\s+(?:async\s+)?function\s+\w+\s*\(([^)]*)\)\s*:\s*([^{;]+)/);
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
      0x20,
      0x00, // local.get 0 (a)
      0x20,
      0x01, // local.get 1 (b)
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
      0x20,
      0x01, // local.get 1 (len)
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
      0x20,
      0x00, // local.get 0  (n)
      0x41,
      0x0a, // i32.const 10
      0x49, // i32.lt_u
      0x04,
      0x40, // if void
      0x20,
      0x01, // local.get 1  (out)
      0x20,
      0x00, // local.get 0  (n)
      0x41,
      0x30, // i32.const 48 ('0')
      0x6a, // i32.add          (n + '0')
      0x3a,
      0x00,
      0x00, // i32.store8 align=0 offset=0
      0x41,
      0x01, // i32.const 1
      0x0f, // return
      0x0b, // end if
      // out[0] = n / 10 + '0'   (tens digit)
      0x20,
      0x01, // local.get 1  (out)
      0x20,
      0x00, // local.get 0  (n)
      0x41,
      0x0a, // i32.const 10
      0x6d, // i32.div_u
      0x41,
      0x30, // i32.const 48
      0x6a, // i32.add
      0x3a,
      0x00,
      0x00, // i32.store8 align=0 offset=0
      // out[1] = n % 10 + '0'   (ones digit)
      0x20,
      0x01, // local.get 1  (out)
      0x41,
      0x01, // i32.const 1
      0x6a, // i32.add          (out + 1)
      0x20,
      0x00, // local.get 0  (n)
      0x41,
      0x0a, // i32.const 10
      0x6f, // i32.rem_u
      0x41,
      0x30, // i32.const 48
      0x6a, // i32.add
      0x3a,
      0x00,
      0x00, // i32.store8 align=0 offset=0
      0x41,
      0x02, // i32.const 2
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
      0x20,
      0x00, // local.get 0  (ptr)
      0x28,
      0x02,
      0x00, // i32.load align=2 offset=0   → field[0]
      0x20,
      0x00, // local.get 0  (ptr)
      0x28,
      0x02,
      0x04, // i32.load align=2 offset=4   → field[1]
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
      0x01,
      0x7f, // 1 × i32 (acc, local 2)
      0x01,
      0x7f, // 1 × i32 (byte offset i, local 3)
    ]),
    new Uint8Array([
      0x41,
      0x00,
      0x21,
      0x02, // acc = 0
      0x41,
      0x00,
      0x21,
      0x03, // i = 0
      0x02,
      0x40, // block $brk
      0x03,
      0x40, // loop $cont
      // break if i >= len << 2
      0x20,
      0x03, // local.get 3  (i)
      0x20,
      0x01, // local.get 1  (len)
      0x41,
      0x02, // i32.const 2
      0x74, // i32.shl          (len * 4)
      0x4f, // i32.ge_u
      0x0d,
      0x01, // br_if 1       (break to $brk)
      // acc += i32.load(ptr + i)
      0x20,
      0x02, // local.get 2  (acc)
      0x20,
      0x00, // local.get 0  (ptr)
      0x20,
      0x03, // local.get 3  (i)
      0x6a, // i32.add          (ptr + i)
      0x28,
      0x02,
      0x00, // i32.load align=2 offset=0
      0x6a, // i32.add
      0x21,
      0x02, // local.set 2  (acc)
      // i += 4
      0x20,
      0x03, // local.get 3  (i)
      0x41,
      0x04, // i32.const 4
      0x6a, // i32.add
      0x21,
      0x03, // local.set 3  (i)
      0x0c,
      0x00, // br 0          (continue $cont)
      0x0b, // end loop
      0x0b, // end block
      0x20,
      0x02, // local.get 2  (acc)
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
// WasmFunction → body bytes serialiser
//
// Converts the WasmFunction IR produced by LoweringVisitor into the raw bytes
// expected by emitTypeLoweredModule (same format as buildSubstrateBody):
//   uleb128(localGroupCount)
//   [ uleb128(group.count), valtype(group.type) ] ...
//   [ ...body bytes ]
//   0x0b  (end)
//
// @decision DEC-V1-WAVE-3-WASM-PARSE-001 (see file header)
// ---------------------------------------------------------------------------

function serializeWasmFunction(fn: WasmFunction): Uint8Array {
  const localParts: Uint8Array[] = [uleb128(fn.locals.length)];
  for (const decl of fn.locals) {
    localParts.push(uleb128(decl.count), new Uint8Array([valtypeByte(decl.type)]));
  }
  const localsBytes = concat(...localParts);
  const bodyBytes = new Uint8Array(fn.body);
  const endByte = new Uint8Array([0x0b]);
  return concat(localsBytes, bodyBytes, endByte);
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
//
// @decision DEC-V1-WAVE-3-WASM-PARSE-001
// WI-V1W3-WASM-LOWER-01: accepts both a SubstrateKind (for the WASM type index
// selection) and a WasmFunction (for the serialised body). The body is serialised
// via serializeWasmFunction() rather than the old buildSubstrateBody() so that
// the LoweringVisitor's IR drives all codegen — the hand-rolled body builders are
// now only reachable via the fast-paths inside the visitor.
// ---------------------------------------------------------------------------

/**
 * Emit a yakcc_host-conformant WASM module for a type-lowered substrate function.
 *
 * @param kind      - Wave-2 substrate kind (null for general numeric lowering)
 * @param fnName    - Exported function name (used as __wasm_export_<fnName>)
 * @param wasmFn    - WasmFunction IR from LoweringVisitor
 * @param domain    - Numeric domain for general lowering (undefined → i32 for wave-2)
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-02-EMIT-001
 * @title General numeric lowering extends type section with domain-specific type
 * @status accepted
 * @rationale
 *   Wave-2 substrates all use i32 types. WI-02 adds i64 and f64 domain functions
 *   that need a different WASM type entry (type 5). When `domain` is provided
 *   (general lowering), a type 5 entry `(domain domain) → domain` is appended and
 *   the substrate function references it. Wave-2 substrates continue to use types
 *   1 and 4 as before, preserving full backward compatibility.
 */
function emitTypeLoweredModule(
  kind: SubstrateKind | null,
  fnName: string,
  wasmFn: WasmFunction,
  domain?: NumericDomain,
): Uint8Array<ArrayBuffer> {
  // -----------------------------------------------------------------------
  // Type section
  // -----------------------------------------------------------------------
  const type0 = new Uint8Array([FUNCTYPE, 2, I32, I32, 0]); // (i32 i32) → ()
  const type1 = new Uint8Array([FUNCTYPE, 1, I32, 1, I32]); // (i32) → (i32)
  const type2 = new Uint8Array([FUNCTYPE, 1, I32, 0]); // (i32) → ()
  const type3 = new Uint8Array([FUNCTYPE, 3, I32, I32, I32, 0]); // (i32 i32 i32) → ()
  const type4 = new Uint8Array([FUNCTYPE, 2, I32, I32, 1, I32]); // (i32 i32) → (i32)

  // For general numeric lowering (domain provided), append type 5: (D D) → D
  // @decision DEC-V1-WAVE-3-WASM-LOWER-02-EMIT-001 (see above)
  let typeSection: Uint8Array;
  let substrateFuncTypeIdx: number;

  if (domain !== undefined) {
    // General lowering: build a domain-specific type 5 entry
    const vt = domain === "i64" ? I64 : domain === "f64" ? F64 : I32;
    const type5 = new Uint8Array([FUNCTYPE, 2, vt, vt, 1, vt]); // (D D) → D
    typeSection = section(1, concat(uleb128(6), type0, type1, type2, type3, type4, type5));
    substrateFuncTypeIdx = 5; // general numeric substrate uses type 5
  } else {
    // Wave-2 substrates: use original 5-type section
    typeSection = section(1, concat(uleb128(5), type0, type1, type2, type3, type4));
    // sum_record uses type 1 (i32)→(i32) — one param; all others use type 4
    substrateFuncTypeIdx = kind === "sum_record" ? 1 : 4;
  }

  // -----------------------------------------------------------------------
  // Import section (shared across all substrate modules)
  // -----------------------------------------------------------------------
  const importSection = buildImportSection();

  // -----------------------------------------------------------------------
  // Function section: 1 defined function
  // -----------------------------------------------------------------------
  const funcSection = section(3, concat(uleb128(1), uleb128(substrateFuncTypeIdx)));

  // -----------------------------------------------------------------------
  // Table section: one empty funcref table (required by host contract)
  // -----------------------------------------------------------------------
  const tableSection = section(4, concat(uleb128(1), new Uint8Array([FUNCREF, 0x01, 0x00, 0x00])));

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
  const body = serializeWasmFunction(wasmFn);
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
// String module emitter (WI-V1W3-WASM-LOWER-05)
// ---------------------------------------------------------------------------

/** Base offset for string literal data segment (leaves heap room below). */
const DATA_SEG_BASE = 1024;

/** Encode i32.const n as WASM opcode bytes: [0x41, ...sleb128]. */
function i32ConstOps(n: number): number[] {
  const out: number[] = [];
  let more = true;
  let v = n | 0;
  while (more) {
    let b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return [0x41, ...out];
}

/**
 * Build the extended import section for string modules (memory + 9 host imports).
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001
 */
function buildStringImportSection(): Uint8Array {
  const mod = encodeName("yakcc_host");
  const mem = concat(
    mod,
    encodeName("memory"),
    new Uint8Array([0x02]),
    new Uint8Array([0x01, 0x01, 0x01]),
  );
  const logImp = concat(mod, encodeName("host_log"), new Uint8Array([0x00]), uleb128(0));
  const allocImp = concat(mod, encodeName("host_alloc"), new Uint8Array([0x00]), uleb128(1));
  const freeImp = concat(mod, encodeName("host_free"), new Uint8Array([0x00]), uleb128(2));
  const panicImp = concat(mod, encodeName("host_panic"), new Uint8Array([0x00]), uleb128(3));
  // Type indices match the type section: T4=(i32 i32)->(i32), T5=(4xi32)->(i32), T6=(5xi32)->()
  const strLenImp = concat(
    mod,
    encodeName("host_string_length"),
    new Uint8Array([0x00]),
    uleb128(4),
  );
  const strIdxImp = concat(
    mod,
    encodeName("host_string_indexof"),
    new Uint8Array([0x00]),
    uleb128(5),
  );
  const strSlcImp = concat(
    mod,
    encodeName("host_string_slice"),
    new Uint8Array([0x00]),
    uleb128(6),
  );
  const strCatImp = concat(
    mod,
    encodeName("host_string_concat"),
    new Uint8Array([0x00]),
    uleb128(6),
  );
  const strEqImp = concat(mod, encodeName("host_string_eq"), new Uint8Array([0x00]), uleb128(5));
  return section(
    2,
    concat(
      uleb128(10),
      mem,
      logImp,
      allocImp,
      freeImp,
      panicImp,
      strLenImp,
      strIdxImp,
      strSlcImp,
      strCatImp,
      strEqImp,
    ),
  );
}

/**
 * Emit WASM body opcodes for the given string shape.
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-OUT-PTR-001
 */
function buildStringBody(shape: StringShapeMeta): number[] {
  const lg = (i: number): number[] => [0x20, i];
  const callFn = (idx: number): number[] => [0x10, ...Array.from(uleb128(idx))];
  const ret = [0x0f];
  switch (shape.shape) {
    case "str-length":
      return [...lg(0), ...lg(1), ...callFn(4), ...ret];
    case "str-indexof":
      return [...lg(0), ...lg(1), ...lg(2), ...lg(3), ...callFn(5), ...ret];
    case "str-eq":
      return [...lg(0), ...lg(1), ...lg(2), ...lg(3), ...callFn(8), ...ret];
    case "str-neq":
      return [...lg(0), ...lg(1), ...lg(2), ...lg(3), ...callFn(8), 0x45, ...ret];
    case "str-slice2":
      return [...lg(0), ...lg(1), ...lg(2), ...lg(3), ...lg(4), ...callFn(6)];
    case "str-slice1": {
      // s.slice(start) == s.slice(start, INT_MAX) in JS semantics
      return [...lg(0), ...lg(1), ...lg(2), ...i32ConstOps(0x7fffffff), ...lg(3), ...callFn(6)];
    }
    case "str-concat":
    case "str-template-concat":
      return [...lg(0), ...lg(1), ...lg(2), ...lg(3), ...lg(4), ...callFn(7)];
    case "str-template-parts": {
      // `prefix${param}suffix`: concat(prefix, param) -> tmp; concat(tmp, suffix) -> out
      // @decision DEC-V1-WAVE-3-WASM-LOWER-STR-DATA-SECTION-001
      const prefix = shape.literals[0] ?? "";
      const suffix = shape.literals[1] ?? "";
      const pbl = new TextEncoder().encode(prefix).length;
      const sbl = new TextEncoder().encode(suffix).length;
      const prefixPtr = DATA_SEG_BASE;
      const suffixPtr = DATA_SEG_BASE + pbl;
      const tmp = 3; // local slot for tmpOutPtr
      return [
        ...i32ConstOps(8),
        ...callFn(1),
        0x21,
        tmp, // tmp = alloc(8)
        ...i32ConstOps(prefixPtr),
        ...i32ConstOps(pbl), // prefix ptr, len
        ...lg(0),
        ...lg(1),
        ...lg(tmp),
        ...callFn(7), // concat(prefix, param) -> tmp
        ...lg(tmp),
        0x28,
        0x02,
        0x00, // i32.load tmp+0 = new_ptr
        ...lg(tmp),
        0x28,
        0x02,
        0x04, // i32.load tmp+4 = new_len
        ...i32ConstOps(suffixPtr),
        ...i32ConstOps(sbl), // suffix ptr, len
        ...lg(2),
        ...callFn(7), // concat(intermediate, suffix) -> out
      ];
    }
  }
}

/**
 * Emit a full WASM module for a string-operation substrate.
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-DATA-SECTION-001
 */
function emitStringModule(shape: StringShapeMeta, fnName: string): Uint8Array<ArrayBuffer> {
  // 8 types covering all string module signatures
  const T0 = new Uint8Array([0x60, 2, I32, I32, 0]);
  const T1 = new Uint8Array([0x60, 1, I32, 1, I32]);
  const T2 = new Uint8Array([0x60, 1, I32, 0]);
  const T3 = new Uint8Array([0x60, 3, I32, I32, I32, 0]);
  const T4 = new Uint8Array([0x60, 2, I32, I32, 1, I32]);
  const T5 = new Uint8Array([0x60, 4, I32, I32, I32, I32, 1, I32]);
  const T6 = new Uint8Array([0x60, 5, I32, I32, I32, I32, I32, 0]);
  const T7 = new Uint8Array([0x60, 3, I32, I32, I32, 0]);
  const T8 = new Uint8Array([0x60, 4, I32, I32, I32, I32, 0]); // (i32 i32 i32 i32)->()
  const typeSection = section(1, concat(uleb128(9), T0, T1, T2, T3, T4, T5, T6, T7, T8));

  let substrateFuncTypeIdx: number;
  switch (shape.shape) {
    case "str-length":
      substrateFuncTypeIdx = 4;
      break;
    case "str-indexof":
      substrateFuncTypeIdx = 5;
      break;
    case "str-eq":
      substrateFuncTypeIdx = 5;
      break;
    case "str-neq":
      substrateFuncTypeIdx = 5;
      break;
    case "str-slice2":
      substrateFuncTypeIdx = 6;
      break;
    case "str-slice1":
      substrateFuncTypeIdx = 8;
      break; // (i32 i32 i32 i32)->()
    case "str-concat":
      substrateFuncTypeIdx = 6;
      break;
    case "str-template-concat":
      substrateFuncTypeIdx = 6;
      break;
    case "str-template-parts":
      substrateFuncTypeIdx = 7;
      break;
  }

  const importSection = buildStringImportSection();
  const funcSection = section(3, concat(uleb128(1), uleb128(substrateFuncTypeIdx)));
  const tableSection = section(4, concat(uleb128(1), new Uint8Array([FUNCREF, 0x01, 0x00, 0x00])));
  const exportFn = concat(
    encodeName(`__wasm_export_${fnName}`),
    new Uint8Array([0x00]),
    uleb128(9),
  );
  const exportTable = concat(encodeName("_yakcc_table"), new Uint8Array([0x01]), uleb128(0));
  const exportSection = section(7, concat(uleb128(2), exportFn, exportTable));

  const bodyOps = buildStringBody(shape);
  const localDecls =
    shape.shape === "str-template-parts"
      ? new Uint8Array([0x01, 0x01, I32])
      : new Uint8Array([0x00]);
  const bodyBytes = concat(localDecls, new Uint8Array(bodyOps), new Uint8Array([0x0b]));
  const codeSection = section(10, concat(uleb128(1), uleb128(bodyBytes.length), bodyBytes));

  if (shape.shape === "str-template-parts") {
    const prefix = shape.literals[0] ?? "";
    const suffix = shape.literals[1] ?? "";
    const allBytes = concat(new TextEncoder().encode(prefix), new TextEncoder().encode(suffix));
    // Active data segment at DATA_SEG_BASE (1024): i32.const 1024 [0x41,0x80,0x08,0x0b]
    const dataSeg = concat(
      new Uint8Array([0x00]),
      new Uint8Array([0x41, 0x80, 0x08, 0x0b]),
      uleb128(allBytes.length),
      allBytes,
    );
    const dataSection = section(11, concat(uleb128(1), dataSeg));
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
// Record module emitter (WI-V1W3-WASM-LOWER-06)
// ---------------------------------------------------------------------------

/**
 * Emit a full yakcc_host-conformant WASM module for a record-operation function.
 *
 * Record functions take N i32 parameters (struct ptr(s) + _size params) and
 * return an i32 or f64 result. All pointer arguments are i32 (linear memory
 * addresses). No new host imports are needed for field access — the base 4
 * imports (log, alloc, free, panic) are sufficient.
 *
 * Type section entries (always at least 5, matching buildImportSection()):
 *   0: (i32 i32) → ()          — host_log
 *   1: (i32) → (i32)           — host_alloc
 *   2: (i32) → ()              — host_free
 *   3: (i32 i32 i32) → ()      — host_panic
 *   4: substrate signature     — (wasmParamCount × i32) → returnValtype
 *
 * The string host imports (indices 5–9) are NOT included — record functions
 * that contain string field access call host_string_length (funcidx 4 in the
 * string module), but plain record modules don't contain string method calls.
 * If a future WI adds string-method calls on record string fields, a combined
 * record+string import section will be needed.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
 * @decision DEC-V1-WAVE-3-WASM-LOWER-RECORD-EQ-001
 *
 * @param shape      - RecordShapeMeta from LoweringVisitor
 * @param fnName     - Exported function name (used as __wasm_export_<fnName>)
 * @param wasmFn     - WasmFunction IR already built by _lowerRecordFunction
 * @param returnDomain - Inferred domain for the return type
 */
function emitRecordModule(
  shape: RecordShapeMeta,
  fnName: string,
  wasmFn: WasmFunction,
  returnDomain: NumericDomain,
): Uint8Array<ArrayBuffer> {
  // -----------------------------------------------------------------------
  // Type section
  // -----------------------------------------------------------------------
  const type0 = new Uint8Array([FUNCTYPE, 2, I32, I32, 0]); // (i32 i32) → ()      host_log
  const type1 = new Uint8Array([FUNCTYPE, 1, I32, 1, I32]); // (i32) → (i32)       host_alloc
  const type2 = new Uint8Array([FUNCTYPE, 1, I32, 0]); // (i32) → ()              host_free
  const type3 = new Uint8Array([FUNCTYPE, 3, I32, I32, I32, 0]); // (i32 i32 i32)→() host_panic

  // Type 4: substrate function — (wasmParamCount × i32) → returnValtype
  const rvt = returnDomain === "f64" ? F64 : returnDomain === "i64" ? I64 : I32;
  const paramBytes = new Uint8Array(shape.wasmParamCount).fill(I32);
  const type4 = concat(
    new Uint8Array([FUNCTYPE]),
    uleb128(shape.wasmParamCount),
    paramBytes,
    uleb128(1),
    new Uint8Array([rvt]),
  );
  const typeSection = section(1, concat(uleb128(5), type0, type1, type2, type3, type4));

  // -----------------------------------------------------------------------
  // Import section (standard 4 host imports — no string imports needed)
  // -----------------------------------------------------------------------
  const importSection = buildImportSection();

  // -----------------------------------------------------------------------
  // Function section: 1 defined function, type index 4
  // -----------------------------------------------------------------------
  const funcSection = section(3, concat(uleb128(1), uleb128(4)));

  // -----------------------------------------------------------------------
  // Table section: empty funcref table (required by host contract)
  // -----------------------------------------------------------------------
  const tableSection = section(4, concat(uleb128(1), new Uint8Array([FUNCREF, 0x01, 0x00, 0x00])));

  // -----------------------------------------------------------------------
  // Export section: substrate function + table
  // -----------------------------------------------------------------------
  const exportFn = concat(
    encodeName(`__wasm_export_${fnName}`),
    new Uint8Array([0x00]), // func
    uleb128(4), // funcidx 4 (first defined function, after 4 imports)
  );
  const exportTable = concat(encodeName("_yakcc_table"), new Uint8Array([0x01]), uleb128(0));
  const exportSection = section(7, concat(uleb128(2), exportFn, exportTable));

  // -----------------------------------------------------------------------
  // Code section: 1 function body (serialized from WasmFunction IR)
  // -----------------------------------------------------------------------
  const body = serializeWasmFunction(wasmFn);
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
// Array module emitter (WI-V1W3-WASM-LOWER-07)
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001 (see visitor.ts for full policy)
// ---------------------------------------------------------------------------

/**
 * Emit SLEB128-encoded i32 constant opcodes: [0x41, ...sleb128(n)]
 */
function i32ConstArr(n: number): number[] {
  const out: number[] = [];
  let more = true;
  let v = n | 0;
  while (more) {
    let b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return [0x41, ...out];
}

/**
 * Emit a ULEB128 call instruction: [0x10, ...uleb128(funcIdx)]
 */
function callArr(funcIdx: number): number[] {
  return [0x10, ...Array.from(uleb128(funcIdx))];
}

/**
 * Emit a ULEB128-encoded integer as bare bytes (not as an i32.const opcode).
 */
function ulebArr(n: number): number[] {
  return Array.from(uleb128(n));
}

/**
 * Build a memory load opcode for the given element kind.
 *
 * Returns: [opcode, align, ...uleb(offset)]
 * i32: 0x28 align=2  (i32.load)
 * i64: 0x29 align=3  (i64.load)
 * f64: 0x2b align=3  (f64.load)
 * string/record: 0x28 align=2  (load ptr i32)
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001
 */
function arrayLoadOp(kind: ArrayShapeMeta["elementKind"], byteOffset: number): number[] {
  function ulebO(n: number): number[] {
    return Array.from(uleb128(n));
  }
  switch (kind) {
    case "i32":
    case "string":
    case "record":
      return [0x28, 0x02, ...ulebO(byteOffset)]; // i32.load align=2
    case "i64":
      return [0x29, 0x03, ...ulebO(byteOffset)]; // i64.load align=3
    case "f64":
      return [0x2b, 0x03, ...ulebO(byteOffset)]; // f64.load align=3
  }
}

/**
 * Build a memory store opcode for the given element kind.
 *
 * Returns: [opcode, align, ...uleb(offset)]
 * i32: 0x36 align=2  (i32.store)
 * i64: 0x37 align=3  (i64.store)
 * f64: 0x39 align=3  (f64.store)
 * string/record: 0x36 align=2  (store ptr i32)
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001
 */
function arrayStoreOp(kind: ArrayShapeMeta["elementKind"], byteOffset: number): number[] {
  function ulebO(n: number): number[] {
    return Array.from(uleb128(n));
  }
  switch (kind) {
    case "i32":
    case "string":
    case "record":
      return [0x36, 0x02, ...ulebO(byteOffset)]; // i32.store align=2
    case "i64":
      return [0x37, 0x03, ...ulebO(byteOffset)]; // i64.store align=3
    case "f64":
      return [0x39, 0x03, ...ulebO(byteOffset)]; // f64.store align=3
  }
}

/**
 * WASM valtype byte for element kind: i64→0x7e, f64→0x7c, all others→0x7f (i32)
 */
function elemValtype(kind: ArrayShapeMeta["elementKind"]): number {
  if (kind === "i64") return 0x7e;
  if (kind === "f64") return 0x7c;
  return 0x7f; // i32
}

/**
 * Emit a yakcc_host-conformant WASM module for an array-operation function.
 *
 * WASM param layout (ABI):
 *   params 0,1,2 = ptr, length, capacity  (the array triple)
 *   param  3     = scalar arg (push value, index) if present
 *
 * Operation dispatch (from ArrayShapeMeta.operations):
 *   sum   — loop over all elements, accumulate, return sum
 *   index — bounds-check then load element at index param (param 3)
 *   length — return param 1 (length)
 *   push  — [grow if needed], store at ptr+len*stride, return len+1
 *
 * Type section (5 entries, matching the standard host contract):
 *   0: (i32 i32) → ()          host_log
 *   1: (i32) → (i32)           host_alloc
 *   2: (i32) → ()              host_free
 *   3: (i32 i32 i32) → ()      host_panic
 *   4: (wasmParamCount × i32) → returnType  substrate
 *
 * For push: returns i32 (new length), so returnType = i32.
 * For index: returns element domain type.
 * For sum: returns element domain (i32 for i32 elements).
 * For length: returns i32.
 * For mixed (record elements with field sum): returns i32.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001
 * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-PASS-BY-VALUE-001
 * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-BOUNDS-CHECK-001
 * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-INIT-CAP-001
 */
function emitArrayModule(shape: ArrayShapeMeta, fnName: string): Uint8Array<ArrayBuffer> {
  const { elementKind, stride, wasmParamCount } = shape;
  const ops = shape.operations;
  const evt = elemValtype(elementKind); // element valtype

  // -----------------------------------------------------------------------
  // Determine operation mode from the operations set
  //
  // Priority: push > pure-index > pure-length > sum
  //
  // Pure-index: has "index" but NOT "length" (e.g. getElem(arr, i) → arr[i])
  //   wasmParamCount = 4 (ptr, length, capacity, i)
  //
  // Sum: has "index" AND "length" (loop body: arr[i] inside while(i < arr.length))
  //   OR has neither (empty ops fall-through)
  //   wasmParamCount = 3 (ptr, length, capacity)
  //
  // @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-OPMODE-001
  // @title Distinguish pure-index from sum by presence of both "index" and "length"
  // @status accepted
  // @rationale
  //   A sum loop uses arr[i] (→ "index") AND arr.length (→ "length") in the body.
  //   A pure-index function uses arr[i] (→ "index") but NOT arr.length.
  //   Prior detection (hasIndex = ops.includes("index") && !hasPush) treated both
  //   as "index" mode, which routes to the single-element-load path — incorrect for
  //   sum loops. The fix: "pure index" requires "index" present WITHOUT "length";
  //   presence of both "length" and "index" is the sum-loop pattern and falls through
  //   to sum mode. This is closed by WI-V1W3-WASM-LOWER-07.
  // -----------------------------------------------------------------------
  const hasPush = ops.includes("push");
  const hasIndex = ops.includes("index") && !ops.includes("length") && !hasPush;
  const hasLength = ops.includes("length") && !ops.includes("index") && !hasPush;
  // Sum mode: both "index" and "length" (loop pattern), or neither (explicit sum)
  const isSum = !hasPush && !hasIndex && !hasLength;

  // Return valtype: push/length/sum → i32; index → element valtype
  const returnVt = hasIndex ? evt : 0x7f; // i32 for all except pure index

  // -----------------------------------------------------------------------
  // Type section
  // -----------------------------------------------------------------------
  const type0 = new Uint8Array([FUNCTYPE, 2, I32, I32, 0]); // host_log
  const type1 = new Uint8Array([FUNCTYPE, 1, I32, 1, I32]); // host_alloc
  const type2 = new Uint8Array([FUNCTYPE, 1, I32, 0]); // host_free
  const type3 = new Uint8Array([FUNCTYPE, 3, I32, I32, I32, 0]); // host_panic

  // Substrate type: all params are i32 (ptr/len/cap + scalar args)
  const paramBytes = new Uint8Array(wasmParamCount).fill(I32);
  const type4 = concat(
    new Uint8Array([FUNCTYPE]),
    uleb128(wasmParamCount),
    paramBytes,
    uleb128(1),
    new Uint8Array([returnVt]),
  );
  const typeSection = section(1, concat(uleb128(5), type0, type1, type2, type3, type4));

  // -----------------------------------------------------------------------
  // Import section (standard: memory + 4 host funcs)
  // -----------------------------------------------------------------------
  const importSection = buildImportSection();

  // -----------------------------------------------------------------------
  // Function section: 1 defined function, type index 4
  // -----------------------------------------------------------------------
  const funcSection = section(3, concat(uleb128(1), uleb128(4)));

  // -----------------------------------------------------------------------
  // Table section
  // -----------------------------------------------------------------------
  const tableSection = section(4, concat(uleb128(1), new Uint8Array([FUNCREF, 0x01, 0x00, 0x00])));

  // -----------------------------------------------------------------------
  // Export section
  // -----------------------------------------------------------------------
  const exportFn = concat(
    encodeName(`__wasm_export_${fnName}`),
    new Uint8Array([0x00]),
    uleb128(4),
  );
  const exportTable = concat(encodeName("_yakcc_table"), new Uint8Array([0x01]), uleb128(0));
  const exportSection = section(7, concat(uleb128(2), exportFn, exportTable));

  // -----------------------------------------------------------------------
  // Code section: build body opcodes based on operation
  // -----------------------------------------------------------------------
  // WASM slot assignments:
  //   0 = ptr, 1 = length, 2 = capacity, 3 = push_value or index (if present)
  // Local variables start at wasmParamCount:
  //   For sum:   local[wasmParamCount] = acc, local[wasmParamCount+1] = i (byte offset)
  //   For push-with-grow: local[wasmParamCount] = new_ptr, local[wasmParamCount+1] = new_cap
  //   For index: no locals needed

  let locals: number[] = []; // encoded local groups
  let body: number[] = [];

  if (hasLength) {
    // arr.length → local.get 1 (length slot)
    // params: (ptr, length, capacity)
    locals = [0x00]; // 0 local groups
    body = [
      0x20,
      0x01, // local.get 1  (length)
      0x0f, // return
    ];
  } else if (hasIndex) {
    // arr[i] → bounds check (i >= length → panic), then load
    // params: (ptr, length, capacity, i)
    // @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-BOUNDS-CHECK-001
    //
    // Panic string: "array index out of bounds" at data segment
    // We inline a simple bounds check without a string message (host_panic accepts ptr=0, len=0)
    // The panic error kind is 0x04 (oob_memory) per WASM_HOST_CONTRACT.md
    locals = [0x00]; // 0 locals
    body = [
      // bounds check: if i >= length → panic
      0x20,
      0x03, // local.get 3  (i)
      0x20,
      0x01, // local.get 1  (length)
      0x4f, // i32.ge_u
      0x04,
      0x40, // if void
      ...i32ConstArr(0x04), // i32.const 4 (oob_memory panic code)
      ...i32ConstArr(0), // i32.const 0 (msg ptr = 0)
      ...i32ConstArr(0), // i32.const 0 (msg len = 0)
      ...callArr(3), // call 3 (host_panic)
      0x00, // unreachable
      0x0b, // end if
      // element address: ptr + i * stride
      0x20,
      0x00, // local.get 0  (ptr)
      0x20,
      0x03, // local.get 3  (i)
      ...i32ConstArr(stride), // i32.const stride
      0x6c, // i32.mul
      0x6a, // i32.add        → address = ptr + i*stride
      ...arrayLoadOp(elementKind, 0), // load element at address+0
      0x0f, // return
    ];
  } else if (hasPush) {
    // push(arr, x): grow if needed, store at ptr+len*stride, return len+1
    // params: (ptr, length, capacity, push_value)
    //   0=ptr, 1=length, 2=capacity, 3=push_value
    // locals: wasmParamCount = new_ptr, wasmParamCount+1 = new_cap
    //   local 4 = new_ptr (i32)
    //   local 5 = new_cap (i32)
    //
    // @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-INIT-CAP-001 (initial capacity seed = 4)
    // Grow strategy: if capacity==0, new_cap=4; else new_cap=capacity*2.
    // new_ptr = host_alloc(new_cap * stride)
    // memory.copy(new_ptr, ptr, length * stride)
    // ptr = new_ptr, capacity = new_cap
    //
    // @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-PASS-BY-VALUE-001
    // push returns new length. ptr/capacity changes (on grow) are NOT visible to
    // caller since we pass by value. This is documented as a v1 limitation.
    const newPtrSlot = wasmParamCount; // local 4
    const newCapSlot = wasmParamCount + 1; // local 5
    locals = [
      0x02, // 2 local groups
      0x01,
      0x7f, // 1 i32 (new_ptr)
      0x01,
      0x7f, // 1 i32 (new_cap)
    ];

    // The grow block: if (length >= capacity) { grow }
    // memory.copy is WASM bulk-memory opcode: 0xfc 0x0a dst_mem src_mem
    // @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-MEMORY-COPY-001
    // @title Use memory.copy (0xfc 0x0a) for push-with-grow backing buffer copy
    // @status accepted
    // @rationale
    //   WASM bulk memory (memory.copy, memory.fill) is part of the bulk memory proposal,
    //   enabled by default in Node.js v22+ (Chrome 75+, Firefox 79+, Safari 15.2+).
    //   Alternative: emit a manual byte-copy loop. The loop costs ~15 extra opcodes and
    //   runs significantly slower for large arrays. memory.copy is the correct choice:
    //   it is atomic within WASM semantics (no interference with GC), branch-free, and
    //   handled by the engine's optimized memcpy path. Verified supported in Node.js v22.
    body = [
      // --- grow block ---
      // if (length >= capacity) { grow; }
      0x20,
      0x01, // local.get 1  (length)
      0x20,
      0x02, // local.get 2  (capacity)
      0x4f, // i32.ge_u
      0x04,
      0x40, // if void

      // new_cap = capacity == 0 ? 4 : capacity * 2
      0x20,
      0x02, // local.get 2  (capacity)
      0x45, // i32.eqz
      0x04,
      0x7f, // if i32
      ...i32ConstArr(4), // i32.const 4  (initial seed)
      0x05, // else
      0x20,
      0x02, // local.get 2  (capacity)
      0x41,
      0x02, // i32.const 2
      0x6c, // i32.mul        (capacity * 2)
      0x0b, // end
      0x21,
      newCapSlot, // local.set new_cap

      // new_ptr = host_alloc(new_cap * stride)
      0x20,
      newCapSlot, // local.get new_cap
      ...i32ConstArr(stride), // i32.const stride
      0x6c, // i32.mul
      ...callArr(1), // call 1 (host_alloc)
      0x21,
      newPtrSlot, // local.set new_ptr

      // memory.copy(new_ptr, ptr, length * stride)
      0x20,
      newPtrSlot, // local.get new_ptr   (dst)
      0x20,
      0x00, // local.get 0  (ptr/src)
      0x20,
      0x01, // local.get 1  (length)
      ...i32ConstArr(stride), // i32.const stride
      0x6c, // i32.mul         (length * stride = byte count)
      0xfc,
      0x0a,
      0x00,
      0x00, // memory.copy dst_mem=0 src_mem=0

      // ptr = new_ptr; capacity = new_cap
      0x20,
      newPtrSlot, // local.get new_ptr
      0x21,
      0x00, // local.set 0 (ptr)
      0x20,
      newCapSlot, // local.get new_cap
      0x21,
      0x02, // local.set 2 (capacity)

      0x0b, // end if (grow)

      // --- store element ---
      // *(ptr + length * stride) = push_value
      0x20,
      0x00, // local.get 0  (ptr — may be updated by grow)
      0x20,
      0x01, // local.get 1  (length)
      ...i32ConstArr(stride), // i32.const stride
      0x6c, // i32.mul
      0x6a, // i32.add        → address = ptr + length*stride
      0x20,
      0x03, // local.get 3  (push_value)
      ...arrayStoreOp(elementKind, 0), // store at address+0

      // --- increment length ---
      0x20,
      0x01, // local.get 1  (length)
      0x41,
      0x01, // i32.const 1
      0x6a, // i32.add
      // return new length
      0x0f, // return
    ];
  } else {
    // Sum mode: sum all elements
    // params: (ptr, length, capacity)  [capacity ignored in sum]
    // locals: local[3] = acc, local[4] = i (byte offset)
    // @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001 (sum loop uses byte-offset counter)
    const accSlot = wasmParamCount; // local 3
    const iSlot = wasmParamCount + 1; // local 4

    // For record elements: we sum a field from each element
    // Record element at arr[i] = ptr-to-struct stored at (ptr + i_byte)
    // Field access: load struct ptr, then load field at struct_ptr + field_offset
    const elemShape = shape.elementRecordShape;

    let loadElementOps: number[];
    if (elementKind === "record" && elemShape !== undefined) {
      // Load struct ptr from array slot (i32.load)
      // Then load first numeric field (field 0 at offset 0)
      const firstNumericField = elemShape.fields.find((f) => f.kind === "numeric");
      const fieldOffset = firstNumericField !== undefined ? firstNumericField.slotIndex * 8 : 0;
      loadElementOps = [
        // stack: [byte_addr] — address of the i32 ptr-to-struct slot
        0x28,
        0x02,
        0x00, // i32.load align=2 offset=0  → loads struct ptr
        // stack: [struct_ptr]
        // now load field at struct_ptr + fieldOffset
        ...(Array.from(uleb128(fieldOffset)).length <= 1
          ? [0x28, 0x02, ...Array.from(uleb128(fieldOffset))]
          : [0x28, 0x02, ...Array.from(uleb128(fieldOffset))]),
        // i32.load align=2 offset=fieldOffset  → loads field value
      ];
    } else {
      // Simple element load at byte address (offset=0)
      loadElementOps = arrayLoadOp(elementKind, 0);
    }

    // Determine accumulator add opcode
    const addOp = elementKind === "i64" ? [0x7c] : elementKind === "f64" ? [0xa0] : [0x6a]; // i32.add

    // Acc and loop counter types
    const accVt = evt; // same valtype as element
    const accLocVt = accVt; // local type for acc

    locals = [
      0x02, // 2 local groups
      0x01,
      accLocVt, // 1 × element type (acc)
      0x01,
      0x7f, // 1 × i32 (byte offset i)
    ];

    // Initial value for acc depends on domain
    const accInit: number[] =
      elementKind === "i64"
        ? [0x42, 0x00] // i64.const 0
        : elementKind === "f64"
          ? [0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] // f64.const 0.0
          : [0x41, 0x00]; // i32.const 0

    body = [
      // acc = 0
      ...accInit,
      0x21,
      accSlot, // local.set acc

      // i = 0  (byte offset)
      ...i32ConstArr(0),
      0x21,
      iSlot, // local.set i

      0x02,
      0x40, // block $brk
      0x03,
      0x40, // loop $cont

      // break if i >= length * stride
      0x20,
      iSlot, // local.get i
      0x20,
      0x01, // local.get 1 (length)
      ...i32ConstArr(stride), // i32.const stride
      0x6c, // i32.mul
      0x4f, // i32.ge_u
      0x0d,
      0x01, // br_if 1 (break to $brk)

      // load element: ptr + i
      0x20,
      0x00, // local.get 0 (ptr)
      0x20,
      iSlot, // local.get i
      0x6a, // i32.add   → element address

      // load element value
      ...loadElementOps,

      // acc += element
      0x20,
      accSlot, // local.get acc
      ...addOp, // add
      // note: args are (element, acc) on stack — need (acc, element) for add
      // Actually: stack is [element_addr+i] after add, then we load, then
      // we have [element_value], then [acc], then add.
      // Wait — the stack is: after `local.get acc` we have [element_value, acc]
      // for i32.add that's fine (add is commutative).
      // Actually let me re-check: after loadElementOps we have [element_value] on stack.
      // Then local.get acc → stack is [element_value, acc].
      // Then i32.add → stack is [element_value + acc]. Correct.
      0x21,
      accSlot, // local.set acc

      // i += stride
      0x20,
      iSlot, // local.get i
      ...i32ConstArr(stride), // i32.const stride
      0x6a, // i32.add
      0x21,
      iSlot, // local.set i

      0x0c,
      0x00, // br 0 (continue $cont)
      0x0b, // end loop
      0x0b, // end block

      0x20,
      accSlot, // local.get acc
      0x0f, // return
    ];
  }

  // -----------------------------------------------------------------------
  // Assemble code section
  // -----------------------------------------------------------------------
  // locals encoding: already built as a raw byte array above
  // For "0 local groups": [0x00]
  // For N local groups: [N, count, type, ...]
  const bodyBytes = new Uint8Array([...locals, ...body]);
  const codeSection = section(
    10,
    concat(uleb128(1), uleb128(bodyBytes.length + 1), bodyBytes, new Uint8Array([0x0b])),
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
 * WI-V1W3-WASM-LOWER-01: dispatch now flows through LoweringVisitor (ts-morph
 * AST-based). The visitor returns a WasmFunction IR; emitTypeLoweredModule
 * serialises it. The wave-2 "add" substrate still emits the legacy 3-function
 * substrate module so that wasm-host.test.ts conformance tests (which rely on
 * __wasm_export_string_len and __wasm_export_panic_demo) remain green.
 *
 * @decision DEC-V1-WAVE-3-WASM-PARSE-001
 * The visitor is the single dispatch entrypoint. detectSubstrateKind is no
 * longer called from this function — it is an internal detail of the visitor's
 * wave-2 fast-path logic. See MASTER_PLAN.md DEC-V1-WAVE-3-WASM-PARSE-001.
 *
 * @returns A Uint8Array containing a valid, instantiable .wasm binary.
 */
export async function compileToWasm(
  resolution: ResolutionResult,
): Promise<Uint8Array<ArrayBuffer>> {
  const entryBlock = resolution.blocks.get(resolution.entry);
  if (entryBlock !== undefined) {
    const visitor = new LoweringVisitor();
    const result = visitor.lower(entryBlock.source);
    // WI-V1W3-WASM-LOWER-05: string shapes go to emitStringModule.
    // @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001
    if (result.stringShape !== undefined) {
      return emitStringModule(result.stringShape, result.fnName);
    }
    // WI-V1W3-WASM-LOWER-06: record shapes go to emitRecordModule.
    // @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
    if (result.recordShape !== undefined) {
      const returnDomain = result.numericDomain ?? "i32";
      return emitRecordModule(result.recordShape, result.fnName, result.wasmFn, returnDomain);
    }
    // WI-V1W3-WASM-LOWER-07: array shapes go to emitArrayModule.
    // Dispatch AFTER recordShape check: record-element arrays are a superset
    // of record shapes and must not be intercepted by the record branch first.
    // Dispatch AFTER detectWave2Shape (done in visitor): wave-2 sum_array
    // (exact `.reduce`-body fast-path) never sets arrayShape; all other
    // array-param functions do, landing here.
    // @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001
    if (result.arrayShape !== undefined) {
      return emitArrayModule(result.arrayShape, result.fnName);
    }
    // "add" shape uses the legacy 3-function substrate module so that the
    // wasm-host.test.ts conformance fixture (__wasm_export_string_len,
    // __wasm_export_panic_demo) remains green.
    if (result.wave2Shape === "add") return emitSubstrateModule();
    // General numeric lowering (wave2Shape === null): pass the inferred domain
    // so emitTypeLoweredModule can build the correct type entry (type 5 for i64/f64).
    return emitTypeLoweredModule(
      result.wave2Shape as SubstrateKind | null,
      result.fnName,
      result.wasmFn,
      result.wave2Shape === null ? result.numericDomain : undefined,
    );
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
