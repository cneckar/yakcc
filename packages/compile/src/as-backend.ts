// SPDX-License-Identifier: MIT
//
// @decision DEC-V1-LOWER-BACKEND-REUSE-001
// Title: AssemblyScript backend reuses visitor's numeric-domain analysis; does NOT
//        reuse the in-house WASM byte emitter (LoweringVisitor → WasmFunction bytecode).
// Status: decided (WI-AS-PHASE-1-MVP, Issue #145)
// Rationale:
//   The wave-3 wasm-backend (wasm-backend.ts) contains two distinct halves:
//
//   ANALYSIS HALF (reused here):
//     inferNumericDomain() in wasm-lowering/visitor.ts performs ts-morph AST
//     heuristics to classify `number`-typed TS functions as i32, i64, or f64.
//     That analysis is correct, well-tested, and domain-specific to yakcc's
//     atom signature conventions. The AS backend reuses the same heuristic by
//     re-implementing the lightweight text-scan version (rule -1, 0, 1-7) to
//     avoid importing the entire ts-morph-heavy visitor in a path that already
//     invokes an external compiler process. This re-implementation is validated
//     by the numeric-parity.test.ts suite which uses the same TS function bodies
//     as input. See Phase 0 spike findings (SPIKE_FINDINGS.md §6, Issue #144).
//
//   EMISSION HALF (NOT reused):
//     The hand-rolled WASM binary emitter (WasmFunction IR, opcodes tables,
//     uleb128 encoding) is the incumbent mechanism being superseded by the AS
//     backend in Phase 1. Reusing it would defeat the purpose of this track.
//     Operator adjudication (Issue #142 / Path A) mandates that AS-generated
//     WASM replaces in-house emission as the production path. The in-house
//     emitter continues to run as a differential oracle (wasmBackend()) until
//     Phase 3 retires it.
//
//   Per-atom module boundary (SPIKE_FINDINGS.md §4 / q3-boundary-choice.md):
//     Each yakcc atom maps to one AS file → one .wasm output. This preserves
//     content-addressing granularity: WASM artifact hash traces to a single
//     implSource hash. Per-package batching remains a Phase 1 escape hatch if
//     per-atom instantiation overhead proves excessive in the hot path.
//
// Supporting evidence:
//   - Issue #142: operator adjudication selecting Path A (AS-backed WASM)
//   - Issue #144: Phase 0 spike — asc 0.28.17 determinism confirmed, per-atom
//     boundary validated end-to-end with wasmtime 31.0.0, Q1/Q2/Q3 all PASS
//
// @decision DEC-AS-BACKEND-TMPDIR-001
// Title: AS source and WASM output written to OS temp directory, cleaned up on exit
// Status: decided (WI-AS-PHASE-1-MVP)
// Rationale:
//   The asc compiler requires a real filesystem path for input and output.
//   Using os.tmpdir() keeps the operation stateless from the caller's perspective
//   and avoids polluting the project tree. Temp files are cleaned up after each
//   emit() call regardless of success/failure (finally block). A unique
//   subdirectory per call (randomUUID) prevents concurrent-call collisions.
//
// @decision DEC-AS-JSON-STRATEGY-001
// Title: AS-backend JSON support uses flat-memory manual integer parsers/writers
//        (parseI32/writeI32/skipWS) rather than assemblyscript-json or native
//        AS JSON stdlib, because both managed JSON libraries require --runtime
//        minimal/full (GC heap, managed string type, JSON parsing internals) which
//        are incompatible with the --runtime stub constraint used by this backend.
// Status: decided (WI-AS-PHASE-2D-JSON, Issue #209, 2026-05-03)
// Rationale:
//   AS JSON library options evaluated:
//
//   (A) `assemblyscript-json` package (npm: assemblyscript-json):
//       Requires AS managed types (string, GC allocation, object fields).
//       Under --runtime stub: JSON.parse<T>() fails to compile because the stub
//       runtime omits the GC heap and string internals. PROBE RESULT: COMPILE FAIL.
//
//   (B) Native AS JSON stdlib (JSON.parse / JSON.stringify built into asc):
//       Also requires managed string type and GC allocation. Same failure mode
//       as (A) under --runtime stub. PROBE RESULT: COMPILE FAIL.
//       Evidence: J4/J5 probes in json-parity.test.ts confirm the compile failure.
//
//   (C) Flat-memory manual parsers (CHOSEN):
//       parseI32(ptr, len): byte-by-byte ASCII decimal integer parser (atoi).
//       writeI32(value, dstPtr): byte-by-byte ASCII decimal integer writer (itoa).
//       skipWS(ptr, len, start): JSON whitespace-skip for token boundary detection.
//       These use only WASM intrinsics (load<u8>, store<u8>, i32 arithmetic) with
//       no GC dependency. Compatible with --runtime stub. PROBE RESULT: COMPILE OK.
//
//   Type-parameter inference at codegen time (for JSON.stringify<T>):
//       Not applicable -- the flat-memory approach works on byte buffers, not typed
//       AS values. The integer type (i32) is the only supported token type in v1
//       (ASCII-ONLY CONSTRAINT per DEC-AS-JSON-LAYOUT-001). Type inference for
//       broader JSON support (floats, strings, objects) is deferred to a future
//       phase that adopts --runtime minimal/full.
//
//   JSON.parse destination type resolution:
//       Not applicable in v1. The flat-memory parseI32 always returns i32.
//       Destination type selection for polymorphic JSON.parse is deferred to the
//       same future phase that enables AS managed JSON.
//
//   Decision: Use flat-memory approach (C) for v1. The assemblyscript-json package
//   is NOT added as a dependency at this time -- it would only work with a GC
//   runtime tier that is not yet adopted. A follow-up issue should track the GC
//   runtime upgrade path and reassess JSON library adoption at that point.
//
// See also: DEC-AS-JSON-LAYOUT-001 in json-parity.test.ts for the byte-layout
// specifics (JSON_BASE_PTR, DST_BASE_PTR, ASCII-ONLY CONSTRAINT).
//
// @decision DEC-AS-JSON-STRATEGY-001
// Title: AS-backend JSON support uses flat-memory manual integer parsers/writers
//        (parseI32/writeI32/skipWS) rather than assemblyscript-json or native
//        AS JSON stdlib, because both managed JSON libraries require --runtime
//        minimal/full (GC heap, managed string type, JSON parsing internals) which
//        are incompatible with the --runtime stub constraint used by this backend.
// Status: decided (WI-AS-PHASE-2D-JSON, Issue #209, 2026-05-03)
// Rationale:
//   AS JSON library options evaluated:
//
//   (A) `assemblyscript-json` package (npm: assemblyscript-json):
//       Requires AS managed types (string, GC allocation, object fields).
//       Under --runtime stub: JSON.parse<T>() fails to compile because the stub
//       runtime omits the GC heap and string internals. PROBE RESULT: COMPILE FAIL.
//
//   (B) Native AS JSON stdlib (JSON.parse / JSON.stringify built into asc):
//       Also requires managed string type and GC allocation. Same failure mode
//       as (A) under --runtime stub. PROBE RESULT: COMPILE FAIL.
//       Evidence: J4/J5 probes in json-parity.test.ts confirm the compile failure.
//
//   (C) Flat-memory manual parsers (CHOSEN):
//       parseI32(ptr, len): byte-by-byte ASCII decimal integer parser (atoi).
//       writeI32(value, dstPtr): byte-by-byte ASCII decimal integer writer (itoa).
//       skipWS(ptr, len, start): JSON whitespace-skip for token boundary detection.
//       These use only WASM intrinsics (load<u8>, store<u8>, i32 arithmetic) with
//       no GC dependency. Compatible with --runtime stub. PROBE RESULT: COMPILE OK.
//
//   Type-parameter inference at codegen time (for JSON.stringify<T>):
//       Not applicable -- the flat-memory approach works on byte buffers, not typed
//       AS values. The integer type (i32) is the only supported token type in v1
//       (ASCII-ONLY CONSTRAINT per DEC-AS-JSON-LAYOUT-001). Type inference for
//       broader JSON support (floats, strings, objects) is deferred to a future
//       phase that adopts --runtime minimal/full.
//
//   JSON.parse destination type resolution:
//       Not applicable in v1. The flat-memory parseI32 always returns i32.
//       Destination type selection for polymorphic JSON.parse is deferred to the
//       same future phase that enables AS managed JSON.
//
//   Decision: Use flat-memory approach (C) for v1. The assemblyscript-json package
//   is NOT added as a dependency at this time -- it would only work with a GC
//   runtime tier that is not yet adopted. A follow-up issue should track the GC
//   runtime upgrade path and reassess JSON library adoption at that point.
//
// See also: DEC-AS-JSON-LAYOUT-001 in json-parity.test.ts for the byte-layout
// specifics (JSON_BASE_PTR, DST_BASE_PTR, ASCII-ONLY CONSTRAINT).
//
// @decision DEC-AS-EXCEPTIONS-STRATEGY-001
// Title: AS-backend exception/error handling uses primitive abort(), flat-memory error
//        codes (store<u8>(errPtr, code)), and sentinel return values rather than
//        try/catch exception dispatch, because try/catch requires exception-table
//        support absent from --runtime stub (asc 0.28.x). Bare throw new Error()
//        (no enclosing try/catch) compiles under stub — an unexpected finding.
// Status: decided (WI-AS-PHASE-2C-EXCEPTIONS, Issue #207, 2026-05-10)
// Rationale:
//   AS exception handling options evaluated:
//
//   (A) Managed try/catch exception dispatch:
//       Requires exception-table support in the WASM binary — catch routing,
//       finalizer calls, and stack unwinding to the matching catch block.
//       Under --runtime stub, asc refuses to compile `try { throw } catch {}`.
//       PROBE RESULT (E5): COMPILE FAIL. asc error: exception-table absent.
//
//   (B) Managed throw new Error("msg") with catch:
//       Same failure mode as (A) when enclosed in a try/catch. The Error object
//       constructor itself does not require GC under stub; it is the catch-dispatch
//       mechanism that fails. PROBE RESULT: COMPILE FAIL (when try/catch present).
//
//   (C) Flat-memory error protocol (CHOSEN):
//       Three complementary patterns, all WASM-intrinsic compatible:
//         abort():           AS primitive; traps the WASM instance on error.
//                            No GC or exception-table needed.
//         errPtr (i32):      Caller passes a pointer into WASM linear memory.
//                            store<u8>(errPtr, code) writes error code byte.
//                            load<u8>(errPtr) lets host read error state.
//                            ERR_BASE_PTR=512: above AS stub header,
//                            below STR_BASE_PTR=1024 (strings-parity ABI).
//         Sentinel values:   Return -1 (or other out-of-band integer) on error.
//                            Mirrors S4/indexOfByte pattern from strings-parity.
//       All three patterns use only load<u8>/store<u8>/i32 arithmetic — no GC.
//       Compatible with --runtime stub. PROBE RESULT: COMPILE OK.
//
//   FINDING (E4 — UNEXPECTED): bare `throw new Error("msg")` with NO enclosing
//   try/catch DOES compile under asc 0.28.x --runtime stub and passes
//   WebAssembly.validate(). The Error constructor is more stub-permissive than
//   initially assumed; it is the catch-dispatch that requires the exception-table.
//   The non-negative pass-through path is verified at runtime (E4 probe test).
//
//   Decision: Use flat-memory approach (C) for v1. try/catch exception dispatch
//   is deferred until a future phase adopts --runtime minimal/full (GC tier).
//   A follow-up issue should track the GC runtime upgrade path and reassess
//   native AS exception handling at that point.
//
// See also: DEC-AS-EXCEPTION-LAYOUT-001 in exceptions-parity.test.ts for the
// full substrate inventory (E1-E5), ERR_BASE_PTR layout, and probe methodology.
//
// @decision DEC-AS-STRINGS-STRATEGY-001
// Title: AS-backend string support uses flat-memory UTF-8 byte protocol
//        (ptr: i32, len: i32) over WASM intrinsics (load<u8>, store<u8>,
//        byte-level scanning) rather than AS managed string type, because
//        AS managed strings require --runtime minimal/full (GC heap, UTF-16
//        string header, charCodeAt/indexOf/slice GC internals) which are
//        incompatible with the --runtime stub constraint used by this backend.
// Status: decided (WI-AS-PHASE-2B-STRINGS, Issue #206, 2026-05-03)
// Rationale:
//   AS string support options evaluated:
//
//   (A) AS managed string type (string literals, s.length, s.charCodeAt,
//       s.indexOf, s.slice):
//       Requires the GC runtime for all managed string operations:
//         - string.length reads the GC-managed string header (UTF-16 char count).
//         - string.charCodeAt(i) is a bounds-checked GC read of a UTF-16 code unit.
//         - string.indexOf(sub) performs a GC string search with managed allocation.
//         - string.slice(start, end) allocates a new managed string via GC copy.
//       Under --runtime stub, any managed-type operation that touches the GC
//       either traps at runtime or fails to compile.
//       PROBE RESULT (S-managed): COMPILE FAIL. asc 0.28.x --runtime stub does
//       not support AS managed string type.
//
//   (B) assemblyscript-string-utils or similar npm packages:
//       All evaluated packages wrap AS managed string internals and require the
//       same GC heap and string runtime library as option (A).
//       PROBE RESULT: COMPILE FAIL (same failure mode as managed strings).
//
//   (C) Flat-memory UTF-8 byte protocol (CHOSEN):
//       strLen(ptr, len):       return len parameter (flat-memory length pass-through).
//       byteAt(ptr, len, i):    load<u8>(ptr + i) — read byte at index i.
//       strEq(pA, lA, pB, lB): byte-by-byte equality comparison (memcmp variant).
//       indexOfByte(ptr, len, b): scan for first occurrence of byte b; return index or -1.
//       copySlice(src, len, dst, start, end): copy bytes [start, end) via store<u8>;
//                                             return byte count copied.
//       These operations use only WASM intrinsics (load<u8>, store<u8>, i32
//       arithmetic) with no GC dependency. Compatible with --runtime stub.
//       PROBE RESULT: COMPILE OK.
//
//   ASCII-ONLY CONSTRAINT (v1): Substrates use ASCII-only inputs (single-byte
//   UTF-8, code points 0x20-0x7E). Multi-byte UTF-8 sequences (2-4 bytes),
//   the byte-count vs. char-count distinction, and surrogate-pair handling are
//   deferred to a future phase when the GC runtime tier is adopted.
//
//   Memory layout: STR_BASE_PTR = 1024 (above AS stub runtime header region,
//   above ERR_BASE_PTR = 512); DST_BASE_PTR = 4096 (separate output buffer for
//   slice/copy operations). Layout is wire-compatible with wave-3 wasm-lowering's
//   string ABI and with arrays-parity.test.ts conventions.
//
//   Decision: Use flat-memory approach (C) for v1. AS managed strings are NOT
//   used at this time -- they only work with a GC runtime tier not yet adopted.
//   A follow-up issue should track the GC runtime upgrade path and reassess
//   managed-string support (char-count semantics, full Unicode, surrogate pairs)
//   at that point.
//
// See also: DEC-AS-STRING-LAYOUT-001 in strings-parity.test.ts for the
// full substrate inventory (S1-S5), STR_BASE_PTR/DST_BASE_PTR layout, and
// ASCII-only constraint rationale.
//
// @decision DEC-AS-ARRAYS-STRATEGY-001
// Title: AS-backend array support uses flat-memory (ptr: i32, len: i32) protocol
//        over WASM intrinsics (load<i32>, store<i32>, byte-stride arithmetic) rather
//        than managed AS Array<i32> or StaticArray<i32>, because managed arrays and
//        StaticArray both require --runtime minimal/full (GC heap) or trap at runtime
//        under the --runtime stub constraint used by this backend.
// Status: decided (WI-AS-PHASE-2E-ARRAYS, Issue #210, 2026-05-10)
// Rationale:
//   AS array support options evaluated:
//
//   (A) Managed AS Array<i32> (i32[], Array<i32> with .length, .push, .map, .filter,
//       .reduce):
//       Requires the GC runtime for all managed array operations:
//         - Array<i32>.length reads the GC-managed array header (element count).
//         - Array<i32>[i] subscript is a bounds-checked GC heap read.
//         - Array<i32>.push() triggers GC heap allocation / capacity doubling.
//         - Array<i32>.map(fn) / .filter(fn) require closure allocation — also
//           a GC feature (function table + closure context).
//         - Array<i32>.reduce(fn, init) requires closure support for the accumulator.
//       Under --runtime stub: .map() and .filter() fail to compile (closure
//       allocation absent). .push() compiles syntactically but the resulting WASM
//       traps at runtime because the stub does not implement the ArrayBuffer resize
//       path (GC realloc absent). PROBE RESULT (A4 push): RUNTIME TRAP.
//       PROBE RESULT (A5 map/closure): COMPILE FAIL.
//
//   (B) AS StaticArray<i32> (fixed-size, bounds-checked, no resize):
//       Does not require GC allocation for reads (bounds-checked load<i32>).
//       However, .length and subscript access for StaticArray are GC-managed
//       metadata reads under asc 0.28.x even for stub runtime. The allocation
//       itself (`new StaticArray<i32>(n)`) requires memory.grow plumbing absent
//       from stub. PROBE RESULT: StaticArray allocation fails to compile or
//       traps at runtime under --runtime stub. Rejected for the same root cause
//       as managed arrays: depends on GC allocation infrastructure.
//
//   (C) Flat-memory ptr+len protocol (CHOSEN):
//       Arrays are represented as:
//         - ptr: i32 — pointer to first i32 element in WASM linear memory.
//         - len: i32 — number of elements (not byte length).
//         - Element at index i: byte offset = ptr + i * 4 (i32 = 4 bytes).
//       Operations implemented using only WASM intrinsics (load<i32>, store<i32>,
//       i32 arithmetic):
//         A1 len:        return len parameter (flat-memory length pass-through).
//         A2 get:        return load<i32>(ptr + i * 4) — index access.
//         A3 sum/reduce: manual for-loop; accumulate load<i32> values.
//         A4 pushLen:    write v at index len via store<i32>(ptr + len * 4, v);
//                        return len + 1. (Caller manages buffer capacity.)
//         A5 doubleAll:  manual for-loop; store<i32>(dstPtr + i * 4, 2 * load<i32>...)
//                        Writes doubled values to a separate output buffer (dstPtr).
//       All operations use no GC, no closures, no managed types.
//       Compatible with --runtime stub. PROBE RESULT: COMPILE OK, RUNTIME OK.
//
//   ASCII-ONLY / i32-ONLY CONSTRAINT (v1): Array elements are i32 only. Arrays-of-
//   strings (ptr+len pairs per element), arrays-of-records (struct ABI per element),
//   and GC-managed dynamic arrays are deferred to a future phase that adopts
//   --runtime minimal/full.
//
//   STRUCT_BASE_PTR = 64: same convention as records-parity.test.ts; avoids the AS
//   stub runtime header region at low addresses. Wire-compatible with wave-3
//   wasm-lowering's array ABI (DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001).
//
//   Decision: Use flat-memory approach (C) for v1. Managed Array<i32> and
//   StaticArray<i32> are NOT used -- they require a GC runtime tier not yet adopted.
//   A follow-up issue should track the GC runtime upgrade path and reassess
//   native AS array types (Array<T>.push, .map, .filter, .reduce with closures)
//   at that point. arrays-of-strings and arrays-of-records are deferred to #230
//   (WI-AS-PHASE-2F).
//
// See also: DEC-AS-ARRAY-LAYOUT-001 in arrays-parity.test.ts for the
// full substrate inventory (A1-A5), STRUCT_BASE_PTR layout, i32-stride protocol,
// and the deferred Phase 2F items (arrays-of-strings, closure-based map/filter).
//
// @decision DEC-AS-CONTROL-FLOW-STRATEGY-001
// Title: AS-backend control-flow constructs (if/else, while, for, do-while, switch)
//        are supported by asc 0.28.x natively under --runtime stub without any
//        workarounds in as-backend.ts, because they lower to standard WASM scalar
//        instructions that have no GC or managed-type dependency.
// Status: decided (WI-AS-PHASE-2G-CONTROL-FLOW, Issue #212, 2026-05-10)
// Rationale:
//   AS control-flow support options evaluated:
//
//   (A) Managed iterator protocol (for-of over AS managed string / Array<T>):
//       for-of over AS managed types (string, Array<T>, custom iterables) requires
//       GC-managed iterator objects and Symbol.iterator dispatch. Under --runtime
//       stub the GC heap and Symbol internals are absent. PROBE RESULT: for-of over
//       managed types COMPILE FAIL (or RUNTIME TRAP) under --runtime stub.
//       Affected substrates: any for-of loop whose iterable is an AS managed type.
//
//   (B) for-of over AS managed types via alternative iteration (index-based):
//       Replace for-of with a manual index-for loop (for(let i=0;i<len;i++)).
//       Avoids the iterator protocol entirely; compatible with flat-memory arrays.
//       PROBE RESULT: COMPILE OK under --runtime stub. However, this is a
//       workaround for managed-type arrays, not a feature of the control-flow
//       substrate itself. Considered as a future escalation path only.
//
//   (C) asc-native control-flow constructs (CHOSEN -- no workaround required):
//       if/else, else-if chains, while, for (index-based), do-while, and switch
//       (with explicit cases and default) all lower to standard WASM control
//       instructions:
//         if/else         => WASM if/else block (no GC needed)
//         while           => WASM loop + br_if (no GC needed)
//         for (index)     => WASM loop + br_if + i32 counter (no GC needed)
//         do-while        => WASM loop + br_if at block end (min 1 iteration)
//         switch/default  => WASM block + br_table or nested br_if (no GC needed)
//         break/continue  => WASM br to enclosing block label (no GC needed)
//       These constructs use only i32 arithmetic and WASM branch instructions.
//       No GC allocation, no managed types, no exception-table needed.
//       Compatible with --runtime stub. PROBE RESULT (CF1-CF5): COMPILE OK.
//
//   FINDING (CF1-CF5 -- CONFIRMED EXPECTED): All five control-flow substrates
//   compile cleanly under asc 0.28.x --runtime stub and pass
//   WebAssembly.validate(). Value parity vs TS reference oracle confirmed by
//   20 fast-check runs per substrate. No changes to as-backend.ts were required
//   for this WI -- the existing emit() pipeline handles control-flow atoms
//   without modification.
//
//   Substrates verified (per eval contract T3, DEC-AS-CONTROL-FLOW-001):
//     CF1: classify   -- if / else-if / else (3-branch sign classifier)
//     CF2: sumToN     -- while loop (triangular sum 0..n-1)
//     CF3: product    -- for loop (factorial, index-based, no managed array)
//     CF4: countdown  -- do-while (count down, min 1 iteration guaranteed)
//     CF5: dayName    -- switch with default (3 explicit cases + fallback)
//
//   Decision: Use asc-native path (C) for all scalar control-flow constructs in v1.
//   No workaround layer in as-backend.ts is required. for-of over AS managed types
//   (string, Array<T>) remains deferred to a future phase that adopts --runtime
//   minimal/full (GC tier). A follow-up issue should track the GC runtime upgrade
//   path and reassess managed-type iteration (for-of, Symbol.iterator, closures)
//   at that point.
//
// See also: DEC-AS-CONTROL-FLOW-001 in control-flow-parity.test.ts for the
// full substrate inventory (CF1-CF5), exportMemory: false convention, and the
// 20-run fast-check parity methodology.
//
// @decision DEC-AS-CONTROL-FLOW-STRATEGY-001
// Title: AS-backend control-flow constructs (if/else, while, for, do-while, switch)
//        are supported by asc 0.28.x natively under --runtime stub without any
//        workarounds in as-backend.ts, because they lower to standard WASM scalar
//        instructions that have no GC or managed-type dependency.
// Status: decided (WI-AS-PHASE-2G-CONTROL-FLOW, Issue #212, 2026-05-10)
// Rationale:
//   AS control-flow support options evaluated:
//
//   (A) Managed iterator protocol (for-of over AS managed string / Array<T>):
//       for-of over AS managed types (string, Array<T>, custom iterables) requires
//       GC-managed iterator objects and Symbol.iterator dispatch. Under --runtime
//       stub the GC heap and Symbol internals are absent. PROBE RESULT: for-of over
//       managed types COMPILE FAIL (or RUNTIME TRAP) under --runtime stub.
//       Affected substrates: any for-of loop whose iterable is an AS managed type.
//
//   (B) for-of over AS managed types via alternative iteration (index-based):
//       Replace for-of with a manual index-for loop (for(let i=0;i<len;i++)).
//       Avoids the iterator protocol entirely; compatible with flat-memory arrays.
//       PROBE RESULT: COMPILE OK under --runtime stub. However, this is a
//       workaround for managed-type arrays, not a feature of the control-flow
//       substrate itself. Considered as a future escalation path only.
//
//   (C) asc-native control-flow constructs (CHOSEN — no workaround required):
//       if/else, else-if chains, while, for (index-based), do-while, and switch
//       (with explicit cases and default) all lower to standard WASM control
//       instructions:
//         if/else         → WASM if/else block (no GC needed)
//         while           → WASM loop + br_if (no GC needed)
//         for (index)     → WASM loop + br_if + i32 counter (no GC needed)
//         do-while        → WASM loop + br_if at block end (min 1 iteration)
//         switch/default  → WASM block + br_table or nested br_if (no GC needed)
//         break/continue  → WASM br to enclosing block label (no GC needed)
//       These constructs use only i32 arithmetic and WASM branch instructions.
//       No GC allocation, no managed types, no exception-table needed.
//       Compatible with --runtime stub. PROBE RESULT (CF1-CF5): COMPILE OK.
//
//   FINDING (CF1-CF5 — CONFIRMED EXPECTED): All five control-flow substrates
//   compile cleanly under asc 0.28.x --runtime stub and pass
//   WebAssembly.validate(). Value parity vs TS reference oracle confirmed by
//   20 fast-check runs per substrate. No changes to as-backend.ts were required
//   for this WI — the existing emit() pipeline handles control-flow atoms
//   without modification.
//
//   Substrates verified (per eval contract T3, DEC-AS-CONTROL-FLOW-001):
//     CF1: classify   — if / else-if / else (3-branch sign classifier)
//     CF2: sumToN     — while loop (triangular sum 0..n-1)
//     CF3: product    — for loop (factorial, index-based, no managed array)
//     CF4: countdown  — do-while (count down, min 1 iteration guaranteed)
//     CF5: dayName    — switch with default (3 explicit cases + fallback)
//
//   Decision: Use asc-native path (C) for all scalar control-flow constructs in v1.
//   No workaround layer in as-backend.ts is required. for-of over AS managed types
//   (string, Array<T>) remains deferred to a future phase that adopts --runtime
//   minimal/full (GC tier). A follow-up issue should track the GC runtime upgrade
//   path and reassess managed-type iteration (for-of, Symbol.iterator, closures)
//   at that point.
//
// See also: DEC-AS-CONTROL-FLOW-001 in control-flow-parity.test.ts for the
// full substrate inventory (CF1-CF5), exportMemory: false convention, and the
// 20-run fast-check parity methodology.
//
// @decision DEC-AS-GC-STRATEGY-001
// Title: assemblyScriptBackend() GC objects are exercised by per-substrate probes
//        that document COMPILE OK / COMPILE FAIL / RUNTIME TRAP under the existing
//        --runtime stub baseline; the flat-memory @unmanaged substrate from
//        DEC-AS-RECORD-LAYOUT-001 is the production-supported equivalent for
//        managed-class field access in v1; full managed new T() allocation, GC
//        retention, sweep, cycle handling, and finalizers are deferred to a future
//        phase that adopts --runtime minimal/full.
// Status: decided (WI-AS-PHASE-2H-GC, Issue #232, 2026-05-10)
// Rationale:
//   GC objects in AssemblyScript = managed classes governed by the asc-emitted
//   GC barriers. AssemblyScript has four runtime tiers:
//
//     --runtime stub:        NO GC heap. @unmanaged classes only (flat memory).
//                            new T() without @unmanaged: compile-fail or runtime trap.
//                            Used by this backend (see DEC-AS-BACKEND-TMPDIR-001).
//     --runtime minimal:     Partial GC (manual __pin/__unpin). new T() allocates.
//     --runtime incremental: Full GC, on-the-fly increments.
//     --runtime full:        Full GC, stop-the-world.
//
//   Probe outcomes (G1-G5) recorded in gc-parity.test.ts — empirical, asc 0.28.x
//   --runtime stub, observed 2026-05-10 ("Code is Truth" — planner hypotheses revised):
//
//   (G1) Managed class new Box() (single i32 field): COMPILE OK — UNEXPECTED.
//        asc 0.28.x --runtime stub compiles `new Box()` for a class with a
//        single i32 field. The stub __new path is stub-linked but compilation
//        succeeds. Runtime behavior of the resulting WASM is unprobed.
//
//   (G2) Two managed class allocations (new Box(), new Box()): COMPILE OK.
//        Consistent with G1. Multiple managed allocations compile under stub.
//
//   (G3) Nullable managed reference field (Node | null): COMPILE FAIL.
//        The stub compile boundary: `T | null` reference fields require GC type
//        metadata absent from stub. Scalar i32 fields in managed classes compile
//        OK (G1/G2); nullable managed reference fields COMPILE FAIL.
//
//   (G4) @final class + __finalize() no-op void method: COMPILE OK.
//        @final = optimization modifier (not GC finalizer decorator). There is
//        no @finalize decorator in asc 0.28.x; the GC collect hook is the
//        __finalize() method on the class body. @final + no-op __finalize()
//        compiles under stub (never invoked by stub collect path).
//
//   (G5) @unmanaged flat-memory field access: COMPILE OK + value parity.
//        @unmanaged opts the class out of GC. Field access lowers to
//        load<i32>/store<i32> on host-provided linear-memory pointers.
//        This is the production-supported "GC opt-out" equivalent for v1.
//        Mirrors DEC-AS-RECORD-LAYOUT-001 flat-memory ABI.
//
//   Alternatives rejected (abbreviated; full rationale in PLAN.md §2.4):
//
//   (Alt B) Flip --runtime to minimal/incremental/full for the GC test only:
//       Rejected. Requires either a per-call runtime override field in
//       AsBackendOptions (new emit mode — parallel mechanism, Sacred Practice
//       #12 violation) or a parallel factory (dual-authority). Both paths
//       diverge from every existing sibling's invariant.
//
//   (Alt C) Skip GC entirely; mark #232 as impossible:
//       Rejected. Operator unblocked explicitly (2026-05-10): "start NOW".
//       The probe pattern used by every Phase 2 sibling documents reality.
//
//   Decision: Probe-and-flat-memory pattern for v1. Managed new T() allocation,
//   GC retention, sweep, cycle handling, and finalizers are deferred until a
//   future phase adopts --runtime minimal/full.
//
//   Cross-links: #232 (this WI), DEC-AS-MULTI-EXPORT-001 (parent Phase 2A.0).
//
// See also: DEC-AS-GC-LAYOUT-001 and DEC-AS-GC-ORACLE-001 in gc-parity.test.ts
// for flat-memory layout constants (GC_BASE_PTR = 24576) and oracle details.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolutionResult } from "./resolve.js";
import type { WasmBackend } from "./wasm-backend.js";

// ---------------------------------------------------------------------------
// asc binary resolution
//
// Locate the assemblyscript asc compiler relative to this package's
// node_modules. Using createRequire(import.meta.url) finds the package in
// the correct resolution context even when the file is compiled to dist/.
// ---------------------------------------------------------------------------

function resolveAsc(): string {
  const require = createRequire(import.meta.url);
  // assemblyscript exposes its CLI via the "bin" field in its package.json.
  // The asc entry point is bin/asc.js (runs under Node; not the .cmd shim).
  const ascPkgPath: string = require.resolve("assemblyscript/package.json") as string;
  // ascPkgPath: .../node_modules/assemblyscript/package.json
  // asc.js lives at: .../node_modules/assemblyscript/bin/asc.js
  const pkgDir = ascPkgPath.replace(/[/\\]package\.json$/, "");
  return join(pkgDir, "bin", "asc.js");
}

// ---------------------------------------------------------------------------
// Numeric-domain inference
//
// Re-implements the lightweight subset of inferNumericDomain() from
// wasm-lowering/visitor.ts needed for AS type annotation injection.
// This avoids the ts-morph import (heavy, not needed in the AS path)
// while producing identical domain decisions for the numeric substrate.
//
// Rules (matching visitor.ts rules -1, 0, 1-7):
//   i64: large integer literals (> 2^31-1) or `bigint` keyword
//        or BigInt literal suffix `n`
//   i32: bitwise operators (&|^~<<>>>>>), explicit `| 0` pattern,
//        integer-floor hints (Math.floor/ceil/round/trunc),
//        boolean-typed params/return when no f64 indicator present
//   f64: true division (/), float literals (decimal point or `e` notation),
//        Math.sqrt/sin/cos/log/exp/pow/abs/hypot/atan2 etc.,
//        Number.isFinite/Number.isNaN/Number.isInteger
//   Ambiguous → f64 (conservative: f64 is never lossy for integer inputs)
// ---------------------------------------------------------------------------

const F64_MATH_FNS: ReadonlySet<string> = new Set([
  "sqrt",
  "sin",
  "cos",
  "log",
  "exp",
  "pow",
  "abs",
  "hypot",
  "atan2",
  "sign",
  "cbrt",
  "expm1",
  "log1p",
  "log2",
  "log10",
  "atan",
  "asin",
  "acos",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh",
]);

const INTEGER_FLOOR_MATH_FNS: ReadonlySet<string> = new Set(["floor", "ceil", "round", "trunc"]);

type NumericDomain = "i32" | "i64" | "f64";

// @decision DEC-V1-DOMAIN-INFER-PARITY-001
// Title: as-backend inferDomainFromSource priority order aligned with visitor.ts inferNumericDomain
// Status: decided (WI-AS-PHASE-1-MVP-DOMAIN-INFER-PARITY, Issue #170)
// Rationale:
//   Pre-fix, two early-return paths (bigint/n-suffix → i64; >2^31 literal → i64) won
//   over the subsequent f64/bitop scans. visitor.ts checks the priority block in the
//   order bitop > f64 > i64 > floor > fallback. For two edge-case shapes — (a) source
//   with >2^31 literal AND true division, and (b) source with n-suffix bigint AND a
//   bitwise op — the two implementations disagreed. Phase 1 corpus has no such atoms,
//   so no tests failed, but the @decision DEC-V1-LOWER-BACKEND-REUSE-001 annotation's
//   "identical domain decisions" claim was technically false at the edges.
// Fix:
//   Collect i64 indicators into boolean flags alongside f64/bitop/floor flags, then
//   apply the canonical priority block. This makes the "identical decisions" claim
//   literally true for the documented shapes.
// Reference: packages/compile/src/wasm-lowering/visitor.ts inferNumericDomain (read-only consumer)

/**
 * Infer the numeric domain of a TypeScript atom source via text-level heuristics.
 *
 * Matches the policy of inferNumericDomain() in wasm-lowering/visitor.ts
 * (rules -1 through 7) using string scanning instead of ts-morph AST traversal.
 * This is appropriate here because: (1) the AS backend already shells out to asc,
 * so ts-morph's heaviness is not justified; (2) the numeric substrate functions
 * are guaranteed by the evaluation contract to be simple enough for text scanning.
 *
 * @decision DEC-V1-LOWER-BACKEND-REUSE-001 (analysis half reuse)
 * @decision DEC-V1-DOMAIN-INFER-PARITY-001 (priority order alignment)
 */
export function inferDomainFromSource(src: string): NumericDomain {
  // Strip comments to avoid false positives from commented-out code.
  const noComments = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  let hasF64 = false;
  let hasBitop = false;
  let hasFloorHint = false;
  let hasBigIntKeyword = false;
  let hasBigIntLiteral = false;
  let hasI64RangeLiteral = false;

  // Rule -1 / rule 7: bigint keyword or n-suffix literal (collected as flag, NOT early-return)
  // DEC-V1-DOMAIN-INFER-PARITY-001: these must not short-circuit before bitop/f64 scans
  if (/\bbigint\b/.test(noComments)) hasBigIntKeyword = true;
  if (/\b\d+n\b/.test(noComments)) hasBigIntLiteral = true;

  // Rule 5: large integer literals > 2^31-1 (collected as flag, NOT early-return)
  // DEC-V1-DOMAIN-INFER-PARITY-001: f64 indicators (true division) must win over i64 range literals
  const allNums = noComments.match(/\b(\d+)\b/g);
  if (allNums !== null) {
    for (const lit of allNums) {
      const v = Number(lit);
      if (Number.isInteger(v) && v > 2147483647) {
        hasI64RangeLiteral = true;
        break;
      }
    }
  }

  // Rule 1: true division (/) — but not // (handled by comment stripping)
  // Match `/` that is not `/=` (assign) and not in regex-like contexts.
  if (/[^/*]\s*\/\s*[^/*=]/.test(noComments) || /^\s*\/[^/*=]/.test(noComments)) {
    hasF64 = true;
  }

  // Rule 2: float literals with decimal point or exponent
  if (/\b\d+\.\d*|\b\d*\.\d+|\b\d+[eE][+-]?\d+/.test(noComments)) {
    hasF64 = true;
  }

  // Rule 3: f64 Math functions
  const mathCalls = noComments.match(/Math\.(\w+)/g);
  if (mathCalls !== null) {
    for (const call of mathCalls) {
      const method = call.slice(5); // "Math.".length === 5
      if (F64_MATH_FNS.has(method)) hasF64 = true;
      if (INTEGER_FLOOR_MATH_FNS.has(method)) hasFloorHint = true;
    }
  }

  // Number.isFinite, Number.isNaN, Number.isInteger
  if (/Number\.(isFinite|isNaN|isInteger)/.test(noComments)) {
    hasF64 = true;
  }

  // Rule 4/5: bitwise operators force i32 (takes priority over f64 per visitor.ts)
  // Look for &, |, ^, ~, <<, >>, >>> but not &&, || (logical ops)
  if (/(?<![&|])[&|^~](?![&|])|<<|>>>|>>/.test(noComments)) {
    hasBitop = true;
  }

  // Priority order matching visitor.ts (DEC-V1-DOMAIN-INFER-PARITY-001):
  //   bitop   → i32  (| 0 idiom; DEC-V1-WAVE-3-WASM-LOWER-BITOP-PRIORITY-001)
  //   f64     → f64  (true division / float literal / Math.f64 / Number.is*)
  //   i64     → i64  (bigint keyword / n-suffix / >2^31 literal)
  //   floor   → i32  (Math.floor/ceil/round/trunc hint)
  //   default → f64  (ambiguous → conservative f64)
  if (hasBitop) return "i32";
  if (hasF64) return "f64";
  if (hasBigIntKeyword || hasBigIntLiteral || hasI64RangeLiteral) return "i64";
  if (hasFloorHint) return "i32";

  // Ambiguous → f64 (conservative, matching visitor.ts policy)
  return "f64";
}

// ---------------------------------------------------------------------------
// AS source preparation
//
// Takes the entry block's TypeScript implSource and produces valid
// AssemblyScript source for asc compilation.
//
// Transformations applied (matching tsBackend's cleanBlockSource for stripping,
// then applying AS-specific rewrites):
//   1. Strip TS-only import/export constructs (import type, type aliases,
//      CONTRACT export, shadow type aliases)
//   2. Rewrite `number` type annotations to the inferred AS numeric type
//      (i32 | i64 | f64)
//   3. Handle bigint→i64 rewrites when domain is i64
// ---------------------------------------------------------------------------

const INTRA_IMPORT_RE =
  /^import type\s+\{[^}]*\}\s+from\s+["'](\.|@yakcc\/seeds\/|@yakcc\/blocks\/)[^"']*["'];?\s*$/;
const SHADOW_ALIAS_RE = /^type\s+_\w+\s*=\s*typeof\s+\w+\s*;?\s*$/;
const CONTRACTS_IMPORT_RE = /^import type\s+\{[^}]*\}\s+from\s+["']@yakcc\/contracts["'];?\s*$/;
const CONTRACT_EXPORT_START_RE = /^export const CONTRACT(?:\s*:\s*\w+)?\s*=\s*\{/;

/**
 * Prepare an implSource string for asc compilation.
 *
 * Strips TypeScript-only constructs that asc cannot handle, then rewrites
 * `number` type annotations to the inferred AS numeric type.
 *
 * @param source  - Raw implSource from ResolvedBlock
 * @param domain  - Inferred numeric domain for `number` → AS-type rewriting
 * @returns AS-compatible source string
 */
export function prepareAsSource(source: string, domain: NumericDomain): string {
  const asType = domain === "i64" ? "i64" : domain === "f64" ? "f64" : "i32";

  const lines = source.split("\n");
  const cleaned: string[] = [];
  let contractDepth = 0;

  for (const line of lines) {
    // Skip CONTRACT multi-line declaration (same logic as tsBackend's cleanBlockSource)
    if (contractDepth > 0) {
      for (const ch of line) {
        if (ch === "{") contractDepth++;
        else if (ch === "}") contractDepth--;
      }
      continue;
    }
    if (CONTRACT_EXPORT_START_RE.test(line)) {
      for (const ch of line) {
        if (ch === "{") contractDepth++;
        else if (ch === "}") contractDepth--;
      }
      continue;
    }
    if (INTRA_IMPORT_RE.test(line)) continue;
    if (SHADOW_ALIAS_RE.test(line)) continue;
    if (CONTRACTS_IMPORT_RE.test(line)) continue;

    cleaned.push(line);
  }

  // Remove leading blank lines
  let start = 0;
  while (start < cleaned.length && cleaned[start]?.trim() === "") start++;
  let src = cleaned.slice(start).join("\n");

  // Rewrite TypeScript `number` type annotations to AS numeric type.
  // Replace `: number` in param and return type positions.
  src = src.replace(/:\s*number\b/g, `: ${asType}`);

  // Handle i64 domain: rewrite bigint-specific TS constructs
  if (domain === "i64") {
    // Rewrite `: bigint` type annotations → `: i64`
    src = src.replace(/:\s*bigint\b/g, ": i64");
    // BigInt(n) constructor → direct i64 cast: BigInt(expr) → (expr as i64)
    src = src.replace(/BigInt\(([^)]+)\)/g, "($1 as i64)");
    // BigInt literals: 123n → 123 (AS uses plain integer literals for i64 context)
    src = src.replace(/(\d+)n\b/g, "$1");
  }

  return src;
}

// ---------------------------------------------------------------------------
// Exported factory
// ---------------------------------------------------------------------------

// @decision DEC-AS-BACKEND-OPTIONS-001
// Title: assemblyScriptBackend() accepts optional AsBackendOptions for per-factory asc flags
// Status: decided (WI-AS-PHASE-2A-MULTI-EXPORT-AND-RECORDS, 2026-05-10)
// Rationale:
//   Phase 1 compiled all atoms with --noExportMemory (pure function substrate).
//   Phase 2A adds record substrate support (DEC-AS-RECORD-LAYOUT-001) where the
//   test needs to write struct bytes into the WASM memory before calling the function.
//   This requires omitting --noExportMemory (i.e. exporting memory). Rather than
//   adding a second factory function (which would be a parallel mechanism per
//   Sacred Practice #12), an options bag is passed to the factory. Default behaviour
//   (exportMemory: false) is byte-identical to Phase 1.
//
//   Alternative considered: separate `assemblyScriptRecordBackend()` factory.
//   Rejected: creates two nearly-identical factories that diverge over time. One
//   factory with a documented option is the single-source-of-truth design.
export interface AsBackendOptions {
  /**
   * When true, omit --noExportMemory from the asc invocation so the compiled
   * module exports its linear memory. Required for record substrates where the
   * test harness writes struct bytes directly into WASM memory before calling
   * the entry function. Default: false (matches Phase 1 pure-numeric behaviour).
   *
   * @decision DEC-AS-BACKEND-OPTIONS-001
   * @decision DEC-AS-RECORD-LAYOUT-001
   */
  readonly exportMemory?: boolean;
}

/**
 * Create the AssemblyScript WASM backend.
 *
 * The backend compiles yakcc atoms to .wasm via AssemblyScript (asc).
 * Phase 1 scope: numeric substrate (i32/i64/f64 arithmetic, bitops, Math.*).
 * Phase 2A extensions: multi-export modules (DEC-AS-MULTI-EXPORT-001),
 * records via flat-struct linear-memory (DEC-AS-RECORD-LAYOUT-001).
 *
 * Workflow per emit() call:
 *   1. Extract the entry block's implSource from the ResolutionResult
 *   2. Infer the numeric domain (i32/i64/f64) from source heuristics
 *   3. Prepare AS-compatible source (strip TS-only constructs, rewrite types)
 *   4. Write source to a temp directory, invoke asc via Node child_process
 *   5. Read the .wasm bytes, clean up temp directory, return Uint8Array
 *
 * Multi-export support (DEC-AS-MULTI-EXPORT-001):
 *   asc natively emits exports for every `export function` in the source.
 *   No change to the emitter is needed — prepareAsSource() already preserves
 *   all `export function` declarations. The consumer (closer-parity-as.test.ts)
 *   treats WASM with ≥1 export as covered (structural coverage for P-OTHER,
 *   per-export value parity when an oracle exists).
 *
 * @param opts - Optional factory configuration (see AsBackendOptions)
 * @decision DEC-V1-LOWER-BACKEND-REUSE-001 (see file header)
 * @decision DEC-AS-BACKEND-TMPDIR-001 (see file header)
 * @decision DEC-AS-MULTI-EXPORT-001 (multi-export: asc handles natively; no emitter change)
 * @decision DEC-AS-RECORD-LAYOUT-001 (records: flat-struct linear-memory; exportMemory option)
 * @decision DEC-AS-BACKEND-OPTIONS-001 (optional AsBackendOptions for per-factory asc flags)
 */
export function assemblyScriptBackend(opts?: AsBackendOptions): WasmBackend {
  const exportMemory = opts?.exportMemory ?? false;

  return {
    name: "as",
    async emit(resolution: ResolutionResult): Promise<Uint8Array<ArrayBuffer>> {
      const entryBlock = resolution.blocks.get(resolution.entry);
      if (entryBlock === undefined) {
        throw new Error(
          `assemblyScriptBackend: entry block not found in resolution (entry=${resolution.entry})`,
        );
      }

      const domain = inferDomainFromSource(entryBlock.source);
      const asSource = prepareAsSource(entryBlock.source, domain);

      // Create a unique temp directory for this compilation unit.
      // @decision DEC-AS-BACKEND-TMPDIR-001
      const workDir = join(tmpdir(), `yakcc-as-${randomUUID()}`);
      mkdirSync(workDir, { recursive: true });

      const srcPath = join(workDir, "atom.ts");
      const outPath = join(workDir, "atom.wasm");

      try {
        writeFileSync(srcPath, asSource, "utf8");

        // Invoke asc via Node (asc.js is a Node CLI script, not a native binary).
        // We find asc.js by resolving the assemblyscript package from this module's
        // require context. This works both in src/ (development) and dist/ (built).
        const ascJs = resolveAsc();
        const ascArgs = [
          ascJs,
          srcPath,
          "--outFile",
          outPath,
          "--optimize",
          "--runtime",
          "stub", // minimal AS runtime (no GC) — numeric + struct substrates
        ];

        // --noExportMemory: suppress memory export for pure numeric functions
        // (Phase 1 default). Omit when exportMemory is requested (Phase 2A
        // record substrates need to write struct bytes into WASM memory).
        // @decision DEC-AS-BACKEND-OPTIONS-001
        // @decision DEC-AS-RECORD-LAYOUT-001
        if (!exportMemory) {
          ascArgs.push("--noExportMemory");
        } else {
          // --initialMemory 1: guarantee ≥1 page (64 KiB) when memory is exported.
          // The AS stub runtime does not allocate memory pages by default; without
          // an initial page, DataView writes by the test harness throw RangeError.
          // 1 page (64 KiB) is sufficient for all Phase 2A record substrates
          // (struct pointers start at byte 64, struct data fits well within 64 KiB).
          // @decision DEC-AS-RECORD-LAYOUT-001
          ascArgs.push("--initialMemory", "1");
        }

        execFileSync(process.execPath, ascArgs, {
          // Capture stderr to include in errors; stdio: pipe prevents terminal noise.
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "buffer",
        });

        const wasmBytes = readFileSync(outPath);
        // Cast to the typed Uint8Array<ArrayBuffer> that WasmBackend.emit promises.
        return new Uint8Array(
          wasmBytes.buffer,
          wasmBytes.byteOffset,
          wasmBytes.byteLength,
        ) as Uint8Array<ArrayBuffer>;
      } catch (err: unknown) {
        // Enrich error with source context for debugging.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `assemblyScriptBackend: asc compilation failed for entry=${resolution.entry}\n` +
            `domain: ${domain}\n` +
            `source:\n${asSource}\n` +
            `asc error:\n${msg}`,
        );
      } finally {
        // Always clean up the temp directory, even on error.
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  };
}
