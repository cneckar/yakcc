// SPDX-License-Identifier: MIT
//
// exceptions-parity.test.ts — AS-backend T6: exception/error substrates (P3 bucket)
//
// @decision DEC-AS-EXCEPTION-LAYOUT-001
// Title: AS-backend exception/error substrates use primitive abort(), flat-memory
//        error codes, and sentinel values under --runtime stub. try/catch exception
//        dispatch is NOT supported under --runtime stub. Bare throw new Error()
//        (without enclosing try/catch) DOES compile under asc 0.28.x --runtime stub.
//        The flat-memory error-code protocol (errPtr: i32, store<u8>(errPtr, code))
//        mirrors wave-3 lower-layout ABI and is directly wire-comparable across backends.
// Status: decided (WI-AS-PHASE-2C-EXCEPTIONS, 2026-05-10)
// Rationale:
//   AS try/catch exception dispatch requires the exception-table support:
//     - Exception dispatch table (catch routing, finalizer calls)
//     - Unwind support (unwinding the call stack to the matching catch block)
//   With --runtime stub, try/catch blocks fail to compile.
//
//   FINDING (E4 throw new Error — UNEXPECTED COMPILE OK): asc 0.28.x with
//   --runtime stub DOES compile `throw new Error("msg")` when there is no
//   enclosing try/catch. The asc compiler emits valid WASM bytes (pass
//   WebAssembly.validate). This updates the initial assumption that Error
//   construction always requires GC heap allocation. It appears asc's stub
//   runtime is more permissive than expected for bare (uncaught) throw paths.
//   Non-negative pass-through verified at runtime. See E4 probe test.
//
//   FINDING (E5 try/catch — EXPECTED COMPILE FAIL): asc 0.28.x with --runtime stub
//   does NOT compile `try { throw new Error("msg"); } catch {}`. The compile fails
//   because try/catch exception dispatch requires exception-table support not
//   present in the stub runtime. The flat-memory sentinel-value variant
//   (return -1 for error) is the correct workaround.
//
//   The flat-memory error protocol matches the arrays-parity.test.ts convention:
//     - abort() is an AS primitive intrinsic (no GC needed) — traps the WASM instance
//     - errPtr is an i32 pointer into WASM linear memory for storing error codes
//     - Error code byte at errPtr: store<u8>(errPtr, code) / load<u8>(errPtr)
//     - Sentinel values (return -1) follow the same pattern as S4/indexOfByte
//     - ERR_BASE_PTR = 512 (well above AS stub runtime header region,
//       below STR_BASE_PTR=1024 from strings-parity to avoid collision)
//   This protocol is directly wire-compatible with wave-3 wasm-lowering's
//   error ABI (DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001).
//
// Five substrates (per eval contract T6):
//   E1: checkNonNeg  — abort() on negative input (AS primitive intrinsic)
//   E2: safeDiv      — error code via store<u8>(errPtr, 1) on division by zero
//   E3: indexOfByte  — sentinel value -1 on not-found (mirrors S4 from strings-parity)
//   E4: managed throw probe — detect compile outcome of `throw new Error("neg")`
//   E5: try/catch probe     — detect compile outcome of `try { throw } catch {}`
//
// Minimum 20 fast-check runs per substrate (eval contract T6 — E1/E2/E3 only;
// E4/E5 are compile-outcome probes).
//
// @decision DEC-AS-PARITY-TEST-NODE-WASM-001 (inherited from numeric-parity.test.ts)
// @decision DEC-AS-PARITY-TEST-RESOLUTION-BUILDER-001 (inherited from numeric-parity.test.ts)
// @decision DEC-AS-BACKEND-OPTIONS-001 (exportMemory: true for E2/E3; not needed for E1)

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type BlockMerkleRoot,
  type LocalTriplet,
  type SpecYak,
  blockMerkleRoot,
  specHash,
} from "@yakcc/contracts";
import { assemblyScriptBackend } from "../../src/as-backend.js";
import type { ResolutionResult, ResolvedBlock } from "../../src/resolve.js";

// ---------------------------------------------------------------------------
// Fixture helpers — mirror arrays-parity.test.ts / strings-parity.test.ts pattern
// ---------------------------------------------------------------------------

const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

function makeSpecYak(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "a", type: "number" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  };
}

function makeMerkleRoot(name: string, behavior: string, implSource: string): BlockMerkleRoot {
  const spec = makeSpecYak(name, behavior);
  const manifest = JSON.parse(MINIMAL_MANIFEST_JSON) as {
    artifacts: Array<{ kind: string; path: string }>;
  };
  const artifactBytes = new TextEncoder().encode(implSource);
  const artifactsMap = new Map<string, Uint8Array>();
  for (const art of manifest.artifacts) {
    artifactsMap.set(art.path, artifactBytes);
  }
  return blockMerkleRoot({
    spec,
    implSource,
    manifest: manifest as LocalTriplet["manifest"],
    artifacts: artifactsMap,
  });
}

function makeResolution(
  blocks: ReadonlyArray<{ id: BlockMerkleRoot; source: string }>,
): ResolutionResult {
  const blockMap = new Map<BlockMerkleRoot, ResolvedBlock>();
  const order: BlockMerkleRoot[] = [];
  for (const { id, source } of blocks) {
    const sh = specHash(makeSpecYak(id.slice(0, 8), `behavior-${id.slice(0, 8)}`));
    blockMap.set(id, { merkleRoot: id, specHash: sh, source, subBlocks: [] });
    order.push(id);
  }
  const entry = order[order.length - 1] as BlockMerkleRoot;
  return { entry, blocks: blockMap, order };
}

function makeSourceResolution(name: string, source: string): ResolutionResult {
  const id = makeMerkleRoot(name, `Exception substrate: ${name}`, source);
  return makeResolution([{ id, source }]);
}

// ---------------------------------------------------------------------------
// Flat-memory layout constants
// @decision DEC-AS-EXCEPTION-LAYOUT-001
//
// Error codes are stored as u8 bytes at errPtr in WASM linear memory.
// ERR_BASE_PTR = 512: placed between AS stub header region (<32 bytes) and
//   STR_BASE_PTR=1024 (strings-parity). Well above arrays' ARR_BASE_PTR=64.
// ARR_BASE_PTR = 64: byte-scan input buffer (E3 indexOfByte mirrors S4).
//   MAX_SCAN_LEN = 64: max elements for E3 fast-check.
// ---------------------------------------------------------------------------

const ERR_BASE_PTR = 512; // base pointer for error-code byte in WASM memory
const ARR_BASE_PTR = 64;  // base pointer for byte-scan input (E3, mirrors S4)
const MAX_SCAN_LEN = 64;  // max bytes for E3 fast-check property tests

// ---------------------------------------------------------------------------
// ASCII string generator helper (mirrors strings-parity.test.ts)
// Restricted to printable ASCII (0x20–0x7E) for byte-scan parity (E3).
// @decision DEC-AS-EXCEPTION-LAYOUT-001
// ---------------------------------------------------------------------------

/** Arbitrary producing ASCII-only strings of length [0, MAX_SCAN_LEN]. */
const asciiString = fc.string({
  unit: "grapheme-ascii",
  minLength: 0,
  maxLength: MAX_SCAN_LEN,
});

/** Encode an ASCII string to a Uint8Array (identity for single-byte chars). */
function encodeAscii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Write a byte array into WASM memory at the given base pointer. */
function writeBytes(dv: DataView, basePtr: number, bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) {
    dv.setUint8(basePtr + i, bytes[i]!);
  }
}

// ---------------------------------------------------------------------------
// E1: checkNonNeg — abort() on negative input (AS primitive intrinsic)
//
// AS source: checkNonNeg(x: i32): i32
//   abort() is an AS primitive intrinsic — it unconditionally traps the WASM
//   instance (unreachable instruction). No GC or managed type required.
//   Returns x unchanged for non-negative inputs.
//
// TS reference: identity for x >= 0; runtime trap for x < 0.
//   Trap detection: WebAssembly.instantiate a fresh instance per test case
//   so that trapping one instance does not poison subsequent calls.
//
// Fast-check: non-negative i32 values — always returns x unchanged.
//   Negative cases verified with fixed inputs (trap expected).
//
// FINDING: abort() is a first-class primitive in AS 0.28.x and compiles
//   cleanly under --runtime stub. No GC required.
// @decision DEC-AS-EXCEPTION-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend exceptions — E1: checkNonNeg (abort() primitive on negative)", () => {
  const CHECKNONNEG_SOURCE = `
export function checkNonNeg(x: i32): i32 {
  if (x < 0) abort();
  return x;
}
`.trim();

  it("E1: checkNonNeg compiles to valid WASM", async () => {
    const backend = assemblyScriptBackend({ exportMemory: false });
    const resolution = makeSourceResolution("checkNonNeg", CHECKNONNEG_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "checkNonNeg WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      env: { abort: () => { throw new WebAssembly.RuntimeError("abort called"); } },
    });
    expect(typeof instance.exports.checkNonNeg).toBe("function");
  }, 30_000);

  it("E1: checkNonNeg — fixed cases: pass-through on non-negative, trap on negative", async () => {
    const backend = assemblyScriptBackend({ exportMemory: false });
    const resolution = makeSourceResolution("checkNonNeg", CHECKNONNEG_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    // Non-negative inputs: pass-through
    const { instance: inst0 } = await WebAssembly.instantiate(wasmBytes, {
      env: { abort: () => { throw new WebAssembly.RuntimeError("abort called"); } },
    });
    const fn0 = inst0.exports.checkNonNeg as (x: number) => number;

    expect(fn0(0)).toBe(0);    // zero: boundary case — non-negative, pass through
    expect(fn0(1)).toBe(1);    // positive small value
    expect(fn0(42)).toBe(42);  // typical positive value
    expect(fn0(1000)).toBe(1000); // larger positive value

    // Negative input: must trap (abort() fires, WebAssembly.RuntimeError or unreachable)
    const { instance: instNeg } = await WebAssembly.instantiate(wasmBytes, {
      env: { abort: () => { throw new WebAssembly.RuntimeError("abort called"); } },
    });
    const fnNeg = instNeg.exports.checkNonNeg as (x: number) => number;

    expect(() => fnNeg(-1)).toThrow();
    expect(() => fnNeg(-42)).toThrow();
  }, 30_000);

  it("E1: checkNonNeg — 20 fast-check cases: non-negative pass-through parity", async () => {
    const backend = assemblyScriptBackend({ exportMemory: false });
    const resolution = makeSourceResolution("checkNonNeg", CHECKNONNEG_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    // Compile once; instantiate once for all non-negative cases.
    // abort() should never fire for non-negative inputs so a single instance is safe.
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      env: { abort: () => { throw new WebAssembly.RuntimeError("abort called"); } },
    });
    const fn = instance.exports.checkNonNeg as (x: number) => number;

    await fc.assert(
      fc.asyncProperty(
        // Only non-negative i32 values — abort() must never fire
        fc.integer({ min: 0, max: 2_147_483_647 }),
        async (x) => {
          // TS reference: identity for non-negative
          expect(fn(x)).toBe(x);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// E2: safeDiv — error code via flat-memory store<u8>(errPtr, 1)
//
// AS source: safeDiv(num: i32, den: i32, errPtr: i32): i32
//   If den == 0: store<u8>(errPtr, 1), return 0.
//   Otherwise:  store<u8>(errPtr, 0), return num / den.
//   The caller reads the error flag at errPtr after the call.
//
// TS reference:
//   - err=1, result=0 when den==0
//   - err=0, result=Math.trunc(num/den) when den!=0
//   Note: AS i32 division truncates toward zero (same as JS Math.trunc for int / int).
//
// This pattern mirrors the "error code out-parameter" convention used in
// flat-memory error signaling in wave-3 wasm-lowering ABI.
//
// FINDING: store<u8>(errPtr, code) compiles cleanly under --runtime stub.
//   No GC required. The flat-memory error-code protocol is a primitive operation.
// @decision DEC-AS-EXCEPTION-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend exceptions — E2: safeDiv (error code via flat-memory store)", () => {
  const SAFEDIV_SOURCE = `
export function safeDiv(num: i32, den: i32, errPtr: i32): i32 {
  if (den == 0) {
    store<u8>(errPtr, 1);
    return 0;
  }
  store<u8>(errPtr, 0);
  return num / den;
}
`.trim();

  it("E2: safeDiv compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("safeDiv", SAFEDIV_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "safeDiv WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.safeDiv).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("E2: safeDiv — fixed cases: division by zero sets err=1, normal division sets err=0", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("safeDiv", SAFEDIV_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.safeDiv as (num: number, den: number, errPtr: number) => number;
    const dv = new DataView(mem.buffer);

    // Division by zero: result=0, err=1
    let result = fn(10, 0, ERR_BASE_PTR);
    expect(result).toBe(0);
    expect(dv.getUint8(ERR_BASE_PTR)).toBe(1);

    // Normal division: 10/2=5, err=0
    result = fn(10, 2, ERR_BASE_PTR);
    expect(result).toBe(5);
    expect(dv.getUint8(ERR_BASE_PTR)).toBe(0);

    // Normal division: 7/3=2 (truncated toward zero), err=0
    result = fn(7, 3, ERR_BASE_PTR);
    expect(result).toBe(2);
    expect(dv.getUint8(ERR_BASE_PTR)).toBe(0);

    // Normal division: -10/3=-3 (truncated toward zero), err=0
    result = fn(-10, 3, ERR_BASE_PTR);
    expect(result).toBe(-3);
    expect(dv.getUint8(ERR_BASE_PTR)).toBe(0);

    // Normal division: 0/5=0, err=0
    result = fn(0, 5, ERR_BASE_PTR);
    expect(result).toBe(0);
    expect(dv.getUint8(ERR_BASE_PTR)).toBe(0);

    // Boundary: num=0, den=0 → err=1, result=0
    result = fn(0, 0, ERR_BASE_PTR);
    expect(result).toBe(0);
    expect(dv.getUint8(ERR_BASE_PTR)).toBe(1);
  }, 30_000);

  it("E2: safeDiv — 20 fast-check cases: error-code + return value parity", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("safeDiv", SAFEDIV_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.safeDiv as (num: number, den: number, errPtr: number) => number;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1_000, max: 1_000 }),
        fc.integer({ min: -1_000, max: 1_000 }),
        async (num, den) => {
          const dv = new DataView(mem.buffer);
          const result = fn(num, den, ERR_BASE_PTR);
          const errCode = dv.getUint8(ERR_BASE_PTR);

          if (den === 0) {
            // TS reference: division by zero → err=1, result=0
            expect(errCode).toBe(1);
            expect(result).toBe(0);
          } else {
            // TS reference: truncated integer division → err=0
            const tsRef = Math.trunc(num / den) | 0;
            expect(errCode).toBe(0);
            expect(result | 0).toBe(tsRef);
          }
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// E3: indexOfByte — sentinel value -1 on not-found (mirrors S4 from strings-parity)
//
// AS source: indexOfByte(ptr: i32, len: i32, b: i32): i32
//   Iterates over len bytes starting at ptr.
//   Returns the index of the first byte equal to b, or -1 if absent.
//   This substrate appears in both strings-parity (S4) and here (E3) because
//   sentinel-value error signaling is a core exception-handling pattern in
//   flat-memory ABI — the -1 return is the canonical "not found / error" sentinel.
//
// TS reference: JS string.indexOf(String.fromCharCode(b)) for ASCII chars.
//
// FINDING: sentinel-value returns (return -1) compile cleanly under --runtime stub.
//   No GC required. This is purely arithmetic.
// @decision DEC-AS-EXCEPTION-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend exceptions — E3: indexOfByte (sentinel -1 for not-found error)", () => {
  const INDEXOFBYTE_SOURCE = `
export function indexOfByte(ptr: i32, len: i32, b: i32): i32 {
  for (let i: i32 = 0; i < len; i++) {
    if (load<u8>(ptr + i) === b) return i;
  }
  return -1;
}
`.trim();

  it("E3: indexOfByte compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("indexOfByte", INDEXOFBYTE_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "indexOfByte WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.indexOfByte).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("E3: indexOfByte — fixed cases: found, not-found (-1 sentinel), empty string", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("indexOfByte", INDEXOFBYTE_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.indexOfByte as (ptr: number, len: number, b: number) => number;
    const dv = new DataView(mem.buffer);

    // "hello" → 'h'=104 at 0, 'e'=101 at 1, 'l'=108 at 2, 'o'=111 at 4
    const hello = encodeAscii("hello");
    writeBytes(dv, ARR_BASE_PTR, hello);

    expect(fn(ARR_BASE_PTR, hello.length, 104)).toBe(0);   // 'h' at index 0
    expect(fn(ARR_BASE_PTR, hello.length, 101)).toBe(1);   // 'e' at index 1
    expect(fn(ARR_BASE_PTR, hello.length, 108)).toBe(2);   // first 'l' at index 2
    expect(fn(ARR_BASE_PTR, hello.length, 111)).toBe(4);   // 'o' at index 4
    expect(fn(ARR_BASE_PTR, hello.length, 120)).toBe(-1);  // 'x' not found → -1 sentinel

    // Empty string → always -1 (sentinel)
    expect(fn(ARR_BASE_PTR, 0, 104)).toBe(-1);

    // Single char "A" (65): found vs sentinel
    const A = encodeAscii("A");
    writeBytes(dv, ARR_BASE_PTR, A);
    expect(fn(ARR_BASE_PTR, A.length, 65)).toBe(0);    // 'A' found at 0
    expect(fn(ARR_BASE_PTR, A.length, 66)).toBe(-1);   // 'B' not found → -1 sentinel
  }, 30_000);

  it("E3: indexOfByte — 20 fast-check cases: sentinel parity vs JS indexOf", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("indexOfByte", INDEXOFBYTE_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.indexOfByte as (ptr: number, len: number, b: number) => number;

    await fc.assert(
      fc.asyncProperty(
        // ASCII string + ASCII byte to search for (printable ASCII range)
        fc.tuple(
          asciiString,
          fc.integer({ min: 0x20, max: 0x7e }),
        ),
        async ([s, b]) => {
          const bytes = encodeAscii(s);
          const dv = new DataView(mem.buffer);
          writeBytes(dv, ARR_BASE_PTR, bytes);

          // TS reference: JS indexOf for ASCII char (byte = char for ASCII)
          const tsRef = s.indexOf(String.fromCharCode(b));
          const result = fn(ARR_BASE_PTR, bytes.length, b);

          // Both return -1 on not-found; both return first occurrence index on found
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// E4: managed throw probe — detect compile outcome of `throw new Error("neg")`
//
// Probe: TRY to compile `function throwIfNeg(x: i32): i32 { if (x < 0) throw new Error("neg"); return x; }`.
// Capture the compile result via try/catch around assemblyScriptBackend().emit().
//
// Either outcome is valid — this test records reality per DEC-AS-EXCEPTION-LAYOUT-001.
//
// FINDING (E4 throw new Error — ACTUAL RESULT: COMPILE OK): asc 0.28.x with
//   --runtime stub DOES compile bare `throw new Error("msg")` (no enclosing try/catch).
//   The probe test confirms "COMPILE OK" and verifies non-negative pass-through.
//   See DEC-AS-EXCEPTION-LAYOUT-001 for updated rationale.
//
// @decision DEC-AS-EXCEPTION-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend exceptions — E4: managed throw new Error() probe", () => {
  const THROW_SOURCE = `
export function throwIfNeg(x: i32): i32 {
  if (x < 0) throw new Error("neg");
  return x;
}
`.trim();

  it("E4 probe: managed throw new Error() compile under --runtime stub", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("throwIfNeg", THROW_SOURCE);

    let compileError: Error | undefined;
    let wasmBytes: Uint8Array | undefined;

    try {
      wasmBytes = await backend.emit(resolution);
    } catch (e) {
      compileError = e as Error;
    }

    if (compileError !== undefined) {
      // If compile FAILS: record the limitation with a meaningful error message.
      // (ACTUAL RESULT: this branch did NOT fire on asc 0.28.x --runtime stub;
      //  bare throw new Error() compiled successfully. See DEC-AS-EXCEPTION-LAYOUT-001.)
      expect(compileError.message.length).toBeGreaterThan(0);
      console.log("E4 result: COMPILE FAIL —", compileError.message.split("\n")[0]);
    } else {
      // Compile succeeded: bare throw new Error() works under stub.
      // ACTUAL RESULT: this branch fires. See DEC-AS-EXCEPTION-LAYOUT-001.
      expect(wasmBytes).toBeDefined();
      expect(WebAssembly.validate(wasmBytes!), "throwIfNeg WASM must be valid if compiled").toBe(true);
      console.log("E4 result: COMPILE OK — managed throw supported");

      // If it compiled, verify pass-through on non-negative input
      const { instance } = await WebAssembly.instantiate(wasmBytes!, {
        env: { abort: () => { throw new WebAssembly.RuntimeError("abort"); } },
      });
      if (typeof instance.exports.throwIfNeg === "function") {
        const fn = instance.exports.throwIfNeg as (x: number) => number;
        // Non-negative: should pass through
        expect(fn(5)).toBe(5);
      }
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// E5: try/catch probe — detect compile outcome of `try { throw } catch {}`
//
// Probe: TRY to compile safeWrap with a try/catch block around throw new Error.
// Capture the compile result via try/catch around assemblyScriptBackend().emit().
//
// Either outcome is valid — this test records reality per DEC-AS-EXCEPTION-LAYOUT-001.
//
// FINDING (E5 try/catch — ACTUAL RESULT: COMPILE FAIL): asc 0.28.x with --runtime stub
//   does NOT compile `try { throw new Error("msg"); } catch {}`. The compile fails
//   because try/catch exception dispatch requires exception-table support not present
//   in stub. Probe test confirms "COMPILE FAIL". See DEC-AS-EXCEPTION-LAYOUT-001.
//
// @decision DEC-AS-EXCEPTION-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend exceptions — E5: try/catch probe", () => {
  const TRYCATCH_SOURCE = `
export function safeWrap(x: i32): i32 {
  try {
    if (x < 0) throw new Error("neg");
    return x;
  } catch {
    return -1;
  }
}
`.trim();

  it("E5 probe: try/catch with throw new Error() compile under --runtime stub", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("safeWrap", TRYCATCH_SOURCE);

    let compileError: Error | undefined;
    let wasmBytes: Uint8Array | undefined;

    try {
      wasmBytes = await backend.emit(resolution);
    } catch (e) {
      compileError = e as Error;
    }

    if (compileError !== undefined) {
      // FINDING: compile FAILS — try/catch with managed throw not supported under --runtime stub.
      // This is the expected outcome per DEC-AS-EXCEPTION-LAYOUT-001.
      expect(compileError.message.length).toBeGreaterThan(0);
      console.log("E5 result: COMPILE FAIL (expected) —", compileError.message.split("\n")[0]);
    } else {
      // Compile succeeded: try/catch works under stub (unexpected).
      // Record the finding and verify runtime behavior.
      expect(wasmBytes).toBeDefined();
      expect(WebAssembly.validate(wasmBytes!), "safeWrap WASM must be valid if compiled").toBe(true);
      console.log("E5 result: COMPILE OK — try/catch supported (update DEC-AS-EXCEPTION-LAYOUT-001)");

      // If it compiled, verify negative input returns -1 and non-negative passes through
      const { instance } = await WebAssembly.instantiate(wasmBytes!, {
        env: { abort: () => { throw new WebAssembly.RuntimeError("abort"); } },
      });
      if (typeof instance.exports.safeWrap === "function") {
        const fn = instance.exports.safeWrap as (x: number) => number;
        expect(fn(5)).toBe(5);    // non-negative: pass through
        expect(fn(-1)).toBe(-1);  // negative: caught, returns -1
      }
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Compound-interaction test
//
// Exercises the full production sequence end-to-end across multiple internal
// component boundaries:
//   source → AS backend → WASM bytes → validate → instantiate → memory write
//   → call (E1 checkNonNeg) → trap detection → call (E2 safeDiv) → error-code
//   read → call (E3 indexOfByte) → sentinel value check.
//
// This test crosses the ResolutionResult → assemblyScriptBackend() →
// WebAssembly.instantiate() → WASM call → JS value / trap check boundary chain
// — the full production path for exception-aware atoms.
//
// Uses all three primitive substrates (E1, E2, E3) that definitely work under
// --runtime stub to verify the complete exception-handling pathway from:
//   abort() trap → error-code out-parameter → sentinel-value return
//
// These three patterns are the canonical error-signaling mechanisms in wave-3
// wasm-lowering ABI for atoms that must communicate failure to callers without
// managed GC exceptions.
//
// @decision DEC-AS-EXCEPTION-LAYOUT-001
// @decision DEC-AS-PARITY-TEST-NODE-WASM-001 (inherited from numeric-parity.test.ts)
// ---------------------------------------------------------------------------

describe("AS backend exceptions — compound-interaction (end-to-end production sequence)", () => {
  it("E1+E2+E3/compound: abort+safeDiv+indexOfByte via full source→backend→wasm→instantiate→call sequence", async () => {
    const CHECKNONNEG_SOURCE = `
export function checkNonNeg(x: i32): i32 {
  if (x < 0) abort();
  return x;
}
`.trim();

    const SAFEDIV_SOURCE = `
export function safeDiv(num: i32, den: i32, errPtr: i32): i32 {
  if (den == 0) {
    store<u8>(errPtr, 1);
    return 0;
  }
  store<u8>(errPtr, 0);
  return num / den;
}
`.trim();

    const INDEXOFBYTE_SOURCE = `
export function indexOfByte(ptr: i32, len: i32, b: i32): i32 {
  for (let i: i32 = 0; i < len; i++) {
    if (load<u8>(ptr + i) === b) return i;
  }
  return -1;
}
`.trim();

    // Step 1: compile E1 (checkNonNeg) through AS backend
    const negResolution = makeSourceResolution("compound-checkNonNeg", CHECKNONNEG_SOURCE);
    const negBackend = assemblyScriptBackend({ exportMemory: false });
    const negWasmBytes = await negBackend.emit(negResolution);

    // Step 2: validate WASM module integrity
    expect(WebAssembly.validate(negWasmBytes), "checkNonNeg WASM bytes must be valid").toBe(true);

    // Step 3: WASM magic header (0x00 0x61 0x73 0x6d)
    expect(negWasmBytes[0]).toBe(0x00);
    expect(negWasmBytes[1]).toBe(0x61);
    expect(negWasmBytes[2]).toBe(0x73);
    expect(negWasmBytes[3]).toBe(0x6d);

    // Step 4: instantiate and verify abort() trap behavior
    const { instance: negInst } = await WebAssembly.instantiate(negWasmBytes, {
      env: { abort: () => { throw new WebAssembly.RuntimeError("abort called"); } },
    });
    const negFn = negInst.exports.checkNonNeg as (x: number) => number;

    // Non-negative state transitions: pass-through
    expect(negFn(0)).toBe(0);       // boundary: zero passes through
    expect(negFn(1)).toBe(1);       // small positive passes through
    expect(negFn(100)).toBe(100);   // larger positive passes through

    // Negative state transition: abort() fires → trap
    // Need a fresh instance since trapping an instance poisons it
    const { instance: negInstTrap } = await WebAssembly.instantiate(negWasmBytes, {
      env: { abort: () => { throw new WebAssembly.RuntimeError("abort called"); } },
    });
    const negFnTrap = negInstTrap.exports.checkNonNeg as (x: number) => number;
    expect(() => negFnTrap(-1)).toThrow(); // trap on negative

    // Step 5: compile E2 (safeDiv) independently, verify error-code protocol
    const divResolution = makeSourceResolution("compound-safeDiv", SAFEDIV_SOURCE);
    const divBackend = assemblyScriptBackend({ exportMemory: true });
    const divWasmBytes = await divBackend.emit(divResolution);
    const { instance: divInst } = await WebAssembly.instantiate(divWasmBytes, {});
    const divFn = divInst.exports.safeDiv as (num: number, den: number, errPtr: number) => number;
    const divMem = divInst.exports.memory as WebAssembly.Memory;
    const divDv = new DataView(divMem.buffer);

    // Normal division state transitions
    let divResult = divFn(12, 4, ERR_BASE_PTR);
    expect(divResult).toBe(3);
    expect(divDv.getUint8(ERR_BASE_PTR)).toBe(0); // no error

    // Division by zero state transition → error-code set
    divResult = divFn(7, 0, ERR_BASE_PTR);
    expect(divResult).toBe(0);
    expect(divDv.getUint8(ERR_BASE_PTR)).toBe(1); // error code 1

    // Recovery: successful division after error — error code resets to 0
    divResult = divFn(9, 3, ERR_BASE_PTR);
    expect(divResult).toBe(3);
    expect(divDv.getUint8(ERR_BASE_PTR)).toBe(0); // error cleared

    // Step 6: compile E3 (indexOfByte) independently, verify sentinel
    const idxResolution = makeSourceResolution("compound-indexOfByte", INDEXOFBYTE_SOURCE);
    const idxBackend = assemblyScriptBackend({ exportMemory: true });
    const idxWasmBytes = await idxBackend.emit(idxResolution);
    const { instance: idxInst } = await WebAssembly.instantiate(idxWasmBytes, {});
    const idxFn = idxInst.exports.indexOfByte as (ptr: number, len: number, b: number) => number;
    const idxMem = idxInst.exports.memory as WebAssembly.Memory;
    const idxDv = new DataView(idxMem.buffer);

    // Write "hello" and verify sentinel transitions
    const hello = encodeAscii("hello");
    writeBytes(idxDv, ARR_BASE_PTR, hello);

    expect(idxFn(ARR_BASE_PTR, hello.length, 104)).toBe(0);   // 'h' at 0 — found
    expect(idxFn(ARR_BASE_PTR, hello.length, 111)).toBe(4);   // 'o' at 4 — found
    expect(idxFn(ARR_BASE_PTR, hello.length, 90)).toBe(-1);   // 'Z' absent → sentinel -1
    expect(idxFn(ARR_BASE_PTR, 0, 104)).toBe(-1);             // empty → sentinel -1

    // Step 7: backend identity verification
    expect(negBackend.name).toBe("as");
    expect(divBackend.name).toBe("as");
    expect(idxBackend.name).toBe("as");
  }, 30_000);
});
