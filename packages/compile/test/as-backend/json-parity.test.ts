// SPDX-License-Identifier: MIT
//
// json-parity.test.ts — AS-backend T7: JSON substrates (P3 bucket)
//
// @decision DEC-AS-JSON-LAYOUT-001
// Title: AS-backend JSON substrates use flat-memory manual integer parsers and
//        writers (ptr + len, byte-by-byte ASCII) over managed JSON.parse() /
//        JSON.stringify() because --runtime stub does not support the GC-managed
//        string and parsing internals required by JSON.parse() and JSON.stringify().
//        The flat-memory byte protocol mirrors wave-3 lower-layout ABI and is
//        directly wire-comparable across backends.
// Status: decided (WI-AS-PHASE-2D-JSON, 2026-05-10)
// Rationale:
//   JSON.parse() and JSON.stringify() in AssemblyScript require the managed string
//   type and the AS JSON library (assemblyscript-json or the built-in JSON stdlib),
//   both of which depend on:
//     - GC-managed string type (AS string internals, UTF-16 storage)
//     - GC-managed object/array allocation (JSON object fields)
//     - Managed parsing state machine (JSON.parse → GC AST nodes)
//   With --runtime stub, managed JSON.parse() and JSON.stringify() fail to compile
//   or trap at runtime because the stub runtime does not include the GC heap,
//   string runtime, or JSON library stubs.
//
//   FINDING (J4 managed JSON.parse() — COMPILE FAIL): asc 0.28.x with --runtime stub
//   does NOT compile a function that calls JSON.parse(). The compile fails because
//   JSON.parse requires the managed string type, GC allocation, and JSON parsing
//   internals — none of which are available under --runtime stub. This is the
//   expected outcome. The flat-memory manual parser (J1 parseI32) is the correct
//   workaround for integer parsing from byte buffers.
//
//   FINDING (J5 managed JSON.stringify() — COMPILE FAIL): asc 0.28.x with
//   --runtime stub does NOT compile a function that calls JSON.stringify(). The
//   compile fails for the same reasons as J4: managed string + GC allocation +
//   JSON library stubs are absent under --runtime stub. The flat-memory manual
//   writer (J2 writeI32) is the correct workaround for integer serialization into
//   byte buffers.
//
//   The flat-memory byte protocol matches the strings-parity.test.ts convention:
//     - JSON_BASE_PTR = 8192: placed above strings-parity (DST_BASE_PTR=4096+64)
//       to avoid collisions with any other test constants.
//     - DST_BASE_PTR = 12288: separate output buffer for J2 writeI32.
//     - Input/output byte buffers are in WASM linear memory (ptr: i32, len: i32).
//   This protocol is directly wire-compatible with wave-3 wasm-lowering's
//   flat-memory number ABI (DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001).
//
//   ASCII-ONLY CONSTRAINT (v1): All numeric strings are ASCII decimal digits plus
//   optional leading '-'. No locale formatting, no float exponents, no hex.
//   This covers the common JSON integer token pattern.
//
// Five substrates (per eval contract T7):
//   J1: parseI32      — manual atoi: parse decimal ASCII digits from byte buffer
//   J2: writeI32      — manual itoa: write i32 as ASCII decimal into byte buffer
//   J3: skipWS        — JSON token helper: skip leading whitespace, return position
//   J4: managed JSON.parse() probe  — detect compile outcome (expected: COMPILE FAIL)
//   J5: managed JSON.stringify() probe — detect compile outcome (expected: COMPILE FAIL)
//
// Minimum 20 fast-check runs per substrate (eval contract T7 — J1/J2/J3 only;
// J4/J5 are compile-outcome probes).
//
// @decision DEC-AS-PARITY-TEST-NODE-WASM-001 (inherited from numeric-parity.test.ts)
// @decision DEC-AS-PARITY-TEST-RESOLUTION-BUILDER-001 (inherited from numeric-parity.test.ts)
// @decision DEC-AS-BACKEND-OPTIONS-001 (exportMemory: true for J1/J2/J3; probe uses true)

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
// Fixture helpers — mirror strings-parity.test.ts / exceptions-parity.test.ts pattern
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
  const id = makeMerkleRoot(name, `JSON substrate: ${name}`, source);
  return makeResolution([{ id, source }]);
}

// ---------------------------------------------------------------------------
// Flat-memory layout constants
// @decision DEC-AS-JSON-LAYOUT-001
//
// All numeric strings are ASCII-encoded in WASM linear memory.
// ptr points to byte[0]; len is byte count (= char count for ASCII decimal).
// Byte at index i: load<u8>(ptr + i).
//
// JSON_BASE_PTR = 8192: placed above strings-parity (DST_BASE_PTR=4096+64=4160)
//   and exceptions-parity (ERR_BASE_PTR=512) to prevent any collision.
// DST_BASE_PTR = 12288: destination buffer for J2 writeI32 output.
//
// MAX_NUM_LEN = 12: max bytes for i32 decimal string (-2147483648 = 11 chars + sign).
// MAX_WS_LEN = 64: max bytes for J3 skipWS fast-check inputs.
// ---------------------------------------------------------------------------

const JSON_BASE_PTR = 8192;   // base pointer for primary input buffer in WASM memory
const DST_BASE_PTR  = 12288;  // base pointer for writeI32 output buffer
const MAX_NUM_LEN   = 12;     // max decimal bytes for an i32 (11 digits + sign)
const MAX_WS_LEN    = 64;     // max bytes for skipWS fast-check inputs

// ---------------------------------------------------------------------------
// Byte-buffer helpers (mirror strings-parity.test.ts)
// ---------------------------------------------------------------------------

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

/** Read n bytes from WASM memory at basePtr, return as Uint8Array. */
function readBytes(dv: DataView, basePtr: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = dv.getUint8(basePtr + i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fast-check generators
// ---------------------------------------------------------------------------

/**
 * Arbitrary that produces valid i32 decimal strings (no leading zeros, may be
 * negative). Range clamped to [-99999, 99999] to keep test strings short while
 * exercising negative, zero, and positive paths.
 * @decision DEC-AS-JSON-LAYOUT-001 (ASCII-ONLY CONSTRAINT)
 */
const decimalI32String = fc
  .integer({ min: -99999, max: 99999 })
  .map((n) => String(n));

/**
 * Arbitrary that produces strings with leading ASCII whitespace (spaces, tabs,
 * CR, LF) followed by a non-whitespace suffix, for J3 skipWS parity.
 * maxLength capped at MAX_WS_LEN for memory safety.
 * @decision DEC-AS-JSON-LAYOUT-001
 */
const wsString = fc.tuple(
  fc.string({ unit: fc.constantFrom(" ", "\t", "\n", "\r"), minLength: 0, maxLength: 32 }),
  fc.string({ unit: "grapheme-ascii", minLength: 0, maxLength: 32 }),
).map(([ws, rest]) => ws + rest);

// ---------------------------------------------------------------------------
// J1: parseI32 — manual atoi from flat-memory byte buffer
//
// AS source: parseI32(ptr: i32, len: i32): i32
//   Reads ASCII decimal bytes from [ptr, ptr+len).
//   Optional leading '-' (0x2D) makes result negative.
//   Stops at first non-digit byte.
//   Returns accumulated i32 value (negative if leading '-').
//
// TS reference: parseInt(str, 10) for decimal ASCII strings.
//   For the ASCII decimal inputs used here, parseInt and the manual atoi
//   produce identical results.
//
// FINDING: Manual byte-by-byte integer parsing compiles cleanly under
//   --runtime stub. load<u8> is a WASM intrinsic; arithmetic on i32 values
//   requires no GC. This is the correct flat-memory JSON integer token parser.
// @decision DEC-AS-JSON-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend JSON — J1: parseI32 (manual atoi from flat-memory bytes)", () => {
  const PARSEI32_SOURCE = `
export function parseI32(ptr: i32, len: i32): i32 {
  let n: i32 = 0;
  let neg: i32 = 0;
  let i: i32 = 0;
  if (i < len && load<u8>(ptr) == 0x2D) {
    neg = 1;
    i = 1;
  }
  for (; i < len; i++) {
    let c: i32 = load<u8>(ptr + i);
    if (c < 0x30 || c > 0x39) break;
    n = n * 10 + (c - 0x30);
  }
  return neg ? -n : n;
}
`.trim();

  it("J1: parseI32 compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("parseI32", PARSEI32_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "parseI32 WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.parseI32).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("J1: parseI32 — fixed cases: zero, positive, negative, leading sign, non-digit stop", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("parseI32", PARSEI32_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.parseI32 as (ptr: number, len: number) => number;
    const dv = new DataView(mem.buffer);

    // "0" → 0
    let bytes = encodeAscii("0");
    writeBytes(dv, JSON_BASE_PTR, bytes);
    expect(fn(JSON_BASE_PTR, bytes.length)).toBe(0);

    // "42" → 42
    bytes = encodeAscii("42");
    writeBytes(dv, JSON_BASE_PTR, bytes);
    expect(fn(JSON_BASE_PTR, bytes.length)).toBe(42);

    // "-1" → -1
    bytes = encodeAscii("-1");
    writeBytes(dv, JSON_BASE_PTR, bytes);
    expect(fn(JSON_BASE_PTR, bytes.length)).toBe(-1);

    // "-99999" → -99999
    bytes = encodeAscii("-99999");
    writeBytes(dv, JSON_BASE_PTR, bytes);
    expect(fn(JSON_BASE_PTR, bytes.length)).toBe(-99999);

    // "12345" → 12345
    bytes = encodeAscii("12345");
    writeBytes(dv, JSON_BASE_PTR, bytes);
    expect(fn(JSON_BASE_PTR, bytes.length)).toBe(12345);

    // "123abc" → stops at 'a', returns 123
    bytes = encodeAscii("123abc");
    writeBytes(dv, JSON_BASE_PTR, bytes);
    expect(fn(JSON_BASE_PTR, bytes.length)).toBe(123);

    // "" (empty) → 0 (no digits consumed)
    expect(fn(JSON_BASE_PTR, 0)).toBe(0);

    // "-" (minus only, no digits) → 0 (neg flag, no accumulation)
    bytes = encodeAscii("-");
    writeBytes(dv, JSON_BASE_PTR, bytes);
    expect(fn(JSON_BASE_PTR, bytes.length)).toBe(0);
  }, 30_000);

  it("J1: parseI32 — 20 fast-check cases: parity vs parseInt(str, 10)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("parseI32", PARSEI32_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.parseI32 as (ptr: number, len: number) => number;

    await fc.assert(
      fc.asyncProperty(
        decimalI32String,
        async (s) => {
          const bytes = encodeAscii(s);
          const dv = new DataView(mem.buffer);
          writeBytes(dv, JSON_BASE_PTR, bytes);

          // TS reference: parseInt(str, 10)
          const tsRef = parseInt(s, 10);
          const result = fn(JSON_BASE_PTR, bytes.length);

          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// J2: writeI32 — manual itoa into flat-memory byte buffer
//
// AS source: writeI32(value: i32, dstPtr: i32): i32
//   Writes the decimal ASCII representation of value into WASM memory at dstPtr.
//   Handles negative values (leading '-').
//   Returns the number of bytes written.
//
// TS reference:
//   - String(value).length (byte count for ASCII decimal)
//   - String(value).charCodeAt(i) for each byte
//
// FINDING: Manual byte-by-byte integer writing compiles cleanly under
//   --runtime stub. store<u8> is a WASM intrinsic; arithmetic on i32 values
//   requires no GC. This is the correct flat-memory JSON integer token writer.
// @decision DEC-AS-JSON-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend JSON — J2: writeI32 (manual itoa into flat-memory bytes)", () => {
  const WRITEI32_SOURCE = `
export function writeI32(value: i32, dstPtr: i32): i32 {
  // Handle zero
  if (value == 0) {
    store<u8>(dstPtr, 0x30); // '0'
    return 1;
  }
  let neg: i32 = 0;
  if (value < 0) {
    neg = 1;
    value = -value;
  }
  // Write digits in reverse order into a temporary area after dstPtr+MAX_DIGITS
  // MAX_DIGITS = 12 is safe for i32 (10 digits + sign + null)
  let tmp: i32 = dstPtr + 12; // scratch area: dstPtr+12..dstPtr+23
  let end: i32 = tmp;
  let v: i32 = value;
  while (v > 0) {
    tmp--;
    store<u8>(tmp, 0x30 + (v % 10));
    v = v / 10;
  }
  let count: i32 = 0;
  if (neg) {
    store<u8>(dstPtr, 0x2D); // '-'
    count = 1;
  }
  let digitLen: i32 = end - tmp;
  for (let i: i32 = 0; i < digitLen; i++) {
    store<u8>(dstPtr + count + i, load<u8>(tmp + i));
  }
  count += digitLen;
  return count;
}
`.trim();

  it("J2: writeI32 compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("writeI32", WRITEI32_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "writeI32 WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.writeI32).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("J2: writeI32 — fixed cases: zero, positive, negative, byte-count and content parity", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("writeI32", WRITEI32_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.writeI32 as (value: number, dstPtr: number) => number;
    const dv = new DataView(mem.buffer);

    // Helper: call fn and read back the written string
    function callAndRead(value: number): string {
      const n = fn(value, DST_BASE_PTR);
      const bytes = readBytes(dv, DST_BASE_PTR, n);
      return new TextDecoder().decode(bytes);
    }

    // 0 → "0" (1 byte)
    expect(fn(0, DST_BASE_PTR)).toBe(1);
    expect(callAndRead(0)).toBe("0");

    // 42 → "42" (2 bytes)
    expect(fn(42, DST_BASE_PTR)).toBe(2);
    expect(callAndRead(42)).toBe("42");

    // -1 → "-1" (2 bytes)
    expect(fn(-1, DST_BASE_PTR)).toBe(2);
    expect(callAndRead(-1)).toBe("-1");

    // 12345 → "12345" (5 bytes)
    expect(fn(12345, DST_BASE_PTR)).toBe(5);
    expect(callAndRead(12345)).toBe("12345");

    // -99999 → "-99999" (6 bytes)
    expect(fn(-99999, DST_BASE_PTR)).toBe(6);
    expect(callAndRead(-99999)).toBe("-99999");

    // 1000000 → "1000000" (7 bytes)
    expect(fn(1000000, DST_BASE_PTR)).toBe(7);
    expect(callAndRead(1000000)).toBe("1000000");
  }, 30_000);

  it("J2: writeI32 — 20 fast-check cases: byte-count and content parity vs String(value)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("writeI32", WRITEI32_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.writeI32 as (value: number, dstPtr: number) => number;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -99999, max: 99999 }),
        async (value) => {
          const dv = new DataView(mem.buffer);
          const n = fn(value, DST_BASE_PTR);
          const writtenBytes = readBytes(dv, DST_BASE_PTR, n);
          const writtenStr = new TextDecoder().decode(writtenBytes);

          // TS reference: String(value) for integer
          const tsRef = String(value);
          expect(n).toBe(tsRef.length);
          expect(writtenStr).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// J3: skipWS — JSON token helper: skip leading whitespace, return position
//
// AS source: skipWS(ptr: i32, len: i32, start: i32): i32
//   Advances from start while bytes are ASCII whitespace (0x20 space, 0x09 tab,
//   0x0A LF, 0x0D CR). Returns the position of the first non-whitespace byte,
//   or len if the entire range is whitespace.
//
// TS reference: str.slice(start).match(/^\s*/)[0].length + start
//   For the four ASCII whitespace bytes used by JSON (space/tab/LF/CR),
//   this is equivalent to the manual loop.
//
// FINDING: Manual byte-by-byte whitespace scan compiles cleanly under
//   --runtime stub. load<u8> comparisons on i32 values require no GC.
//   This is the correct flat-memory JSON lexer whitespace-skip primitive.
// @decision DEC-AS-JSON-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend JSON — J3: skipWS (flat-memory JSON whitespace skip)", () => {
  const SKIPWS_SOURCE = `
export function skipWS(ptr: i32, len: i32, start: i32): i32 {
  let i: i32 = start;
  while (i < len) {
    let c: i32 = load<u8>(ptr + i);
    if (c != 0x20 && c != 0x09 && c != 0x0A && c != 0x0D) break;
    i++;
  }
  return i;
}
`.trim();

  it("J3: skipWS compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("skipWS", SKIPWS_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "skipWS WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.skipWS).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("J3: skipWS — fixed cases: no-ws, leading spaces, tabs, LF, CR, mixed, all-ws", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("skipWS", SKIPWS_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.skipWS as (ptr: number, len: number, start: number) => number;
    const dv = new DataView(mem.buffer);

    function call(s: string, start = 0): number {
      const bytes = encodeAscii(s);
      writeBytes(dv, JSON_BASE_PTR, bytes);
      return fn(JSON_BASE_PTR, bytes.length, start);
    }

    // No whitespace: position stays at start
    expect(call("abc")).toBe(0);

    // Leading spaces: " " × 3 + "x"
    expect(call("   x")).toBe(3);

    // Leading tab
    expect(call("\ta")).toBe(1);

    // Leading LF
    expect(call("\na")).toBe(1);

    // Leading CR
    expect(call("\ra")).toBe(1);

    // Mixed whitespace: " \t\n\r1"
    expect(call(" \t\n\r1")).toBe(4);

    // Non-zero start: "ab  cd", start=2 → skip two spaces → 4
    expect(call("ab  cd", 2)).toBe(4);

    // All whitespace: skip past end → len
    expect(call("   ")).toBe(3);

    // Empty string: start=0, len=0 → 0
    const emptyBytes = encodeAscii("");
    writeBytes(dv, JSON_BASE_PTR, emptyBytes);
    expect(fn(JSON_BASE_PTR, 0, 0)).toBe(0);

    // start == len (already at end): return len unchanged
    const s = "abc";
    const b = encodeAscii(s);
    writeBytes(dv, JSON_BASE_PTR, b);
    expect(fn(JSON_BASE_PTR, b.length, b.length)).toBe(b.length);
  }, 30_000);

  it("J3: skipWS — 20 fast-check cases: position parity vs JS /^\\s*/ match", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("skipWS", SKIPWS_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.skipWS as (ptr: number, len: number, start: number) => number;

    await fc.assert(
      fc.asyncProperty(
        wsString,
        async (s) => {
          // Clamp to MAX_WS_LEN to prevent out-of-bounds memory writes
          const clamped = s.slice(0, MAX_WS_LEN);
          const bytes = encodeAscii(clamped);
          const dv = new DataView(mem.buffer);
          writeBytes(dv, JSON_BASE_PTR, bytes);

          const start = 0;
          const result = fn(JSON_BASE_PTR, bytes.length, start);

          // TS reference: position of first non-whitespace char
          // Only count the four JSON whitespace chars (space, tab, LF, CR)
          // to match the AS implementation exactly.
          const jsonWsRe = /^[ \t\n\r]*/;
          const matched = jsonWsRe.exec(clamped.slice(start));
          const tsRef = start + (matched ? matched[0].length : 0);

          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// J4: managed JSON.parse() probe — detect compile outcome
//
// Probe: TRY to compile a function calling JSON.parse() under --runtime stub.
// Capture the compile result via try/catch around assemblyScriptBackend().emit().
//
// Either outcome is valid — this test records reality per DEC-AS-JSON-LAYOUT-001.
//
// FINDING (J4 — EXPECTED COMPILE FAIL): asc 0.28.x with --runtime stub does NOT
//   compile JSON.parse(). JSON.parse requires managed string type, GC allocation,
//   and the JSON stdlib — all absent under --runtime stub. The flat-memory manual
//   parser (J1 parseI32) is the correct workaround.
//
// @decision DEC-AS-JSON-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend JSON — J4: managed JSON.parse() probe", () => {
  // This source attempts to use AS's JSON.parse() to parse an integer from a string.
  // Under --runtime stub, this is expected to fail to compile.
  // The source is intentionally written as a minimal JSON.parse call to probe
  // exactly where the compile boundary is.
  const JSONPARSE_SOURCE = `
export function parseJsonI32(ptr: i32, len: i32): i32 {
  // Attempt to use managed JSON.parse — probes GC + string + JSON stdlib requirement
  const s: string = "42";
  return i32(JSON.parse<i32>(s));
}
`.trim();

  it("J4 probe: managed JSON.parse() compile under --runtime stub", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("parseJsonI32", JSONPARSE_SOURCE);

    let compileError: Error | undefined;
    let wasmBytes: Uint8Array | undefined;

    try {
      wasmBytes = await backend.emit(resolution);
    } catch (e) {
      compileError = e as Error;
    }

    if (compileError !== undefined) {
      // FINDING: compile FAILS — JSON.parse() not supported under --runtime stub.
      // This is the expected outcome per DEC-AS-JSON-LAYOUT-001.
      // The flat-memory manual parser (J1 parseI32) is the correct workaround.
      expect(compileError.message.length).toBeGreaterThan(0);
      console.log("J4 result: COMPILE FAIL (expected) —", compileError.message.split("\n")[0]);
    } else {
      // Compile succeeded: JSON.parse() works under stub (unexpected — update DEC-AS-JSON-LAYOUT-001).
      // If it compiled, verify the WASM is valid.
      expect(wasmBytes).toBeDefined();
      expect(WebAssembly.validate(wasmBytes!), "parseJsonI32 WASM must be valid if compiled").toBe(true);
      console.log("J4 result: COMPILE OK — JSON.parse() supported (update DEC-AS-JSON-LAYOUT-001)");
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// J5: managed JSON.stringify() probe — detect compile outcome
//
// Probe: TRY to compile a function calling JSON.stringify() under --runtime stub.
// Capture the compile result via try/catch around assemblyScriptBackend().emit().
//
// Either outcome is valid — this test records reality per DEC-AS-JSON-LAYOUT-001.
//
// FINDING (J5 — EXPECTED COMPILE FAIL): asc 0.28.x with --runtime stub does NOT
//   compile JSON.stringify(). JSON.stringify requires managed string type, GC
//   allocation, and the JSON stdlib — all absent under --runtime stub. The
//   flat-memory manual writer (J2 writeI32) is the correct workaround.
//
// @decision DEC-AS-JSON-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend JSON — J5: managed JSON.stringify() probe", () => {
  // This source attempts to use AS's JSON.stringify() to serialize an integer.
  // Under --runtime stub, this is expected to fail to compile.
  const JSONSTRINGIFY_SOURCE = `
export function stringifyI32(value: i32, dstPtr: i32): i32 {
  // Attempt to use managed JSON.stringify — probes GC + string + JSON stdlib requirement
  const s: string = JSON.stringify<i32>(value);
  const bytes = String.UTF8.encode(s);
  return bytes.byteLength;
}
`.trim();

  it("J5 probe: managed JSON.stringify() compile under --runtime stub", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("stringifyI32", JSONSTRINGIFY_SOURCE);

    let compileError: Error | undefined;
    let wasmBytes: Uint8Array | undefined;

    try {
      wasmBytes = await backend.emit(resolution);
    } catch (e) {
      compileError = e as Error;
    }

    if (compileError !== undefined) {
      // FINDING: compile FAILS — JSON.stringify() not supported under --runtime stub.
      // This is the expected outcome per DEC-AS-JSON-LAYOUT-001.
      // The flat-memory manual writer (J2 writeI32) is the correct workaround.
      expect(compileError.message.length).toBeGreaterThan(0);
      console.log("J5 result: COMPILE FAIL (expected) —", compileError.message.split("\n")[0]);
    } else {
      // Compile succeeded: JSON.stringify() works under stub (unexpected — update DEC-AS-JSON-LAYOUT-001).
      expect(wasmBytes).toBeDefined();
      expect(WebAssembly.validate(wasmBytes!), "stringifyI32 WASM must be valid if compiled").toBe(true);
      console.log("J5 result: COMPILE OK — JSON.stringify() supported (update DEC-AS-JSON-LAYOUT-001)");
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Compound-interaction test
//
// Exercises the full production sequence end-to-end across multiple internal
// component boundaries:
//   source → AS backend → WASM bytes → validate → instantiate → memory write
//   → call (J1 parseI32) → value check → call (J2 writeI32) → byte content check
//   → call (J3 skipWS) → position check.
//
// This test crosses the ResolutionResult → assemblyScriptBackend() →
// WebAssembly.instantiate() → DataView write → WASM call → JS value compare
// boundary chain — the full production path for JSON-aware atoms.
//
// Uses all three flat-memory substrates (J1/J2/J3) to verify the complete
// JSON integer token pipeline:
//   skipWS (find start of token) → parseI32 (read token) → writeI32 (emit token)
//
// These three patterns form the canonical JSON integer token read/write
// protocol for flat-memory atoms in wave-3 wasm-lowering ABI.
//
// @decision DEC-AS-JSON-LAYOUT-001
// @decision DEC-AS-PARITY-TEST-NODE-WASM-001 (inherited from numeric-parity.test.ts)
// ---------------------------------------------------------------------------

describe("AS backend JSON — compound-interaction (end-to-end production sequence)", () => {
  it("J1+J2+J3/compound: parseI32+writeI32+skipWS via full source→backend→wasm→instantiate→call sequence", async () => {
    const PARSEI32_SOURCE = `
export function parseI32(ptr: i32, len: i32): i32 {
  let n: i32 = 0;
  let neg: i32 = 0;
  let i: i32 = 0;
  if (i < len && load<u8>(ptr) == 0x2D) {
    neg = 1;
    i = 1;
  }
  for (; i < len; i++) {
    let c: i32 = load<u8>(ptr + i);
    if (c < 0x30 || c > 0x39) break;
    n = n * 10 + (c - 0x30);
  }
  return neg ? -n : n;
}
`.trim();

    const WRITEI32_SOURCE = `
export function writeI32(value: i32, dstPtr: i32): i32 {
  if (value == 0) {
    store<u8>(dstPtr, 0x30);
    return 1;
  }
  let neg: i32 = 0;
  if (value < 0) {
    neg = 1;
    value = -value;
  }
  let tmp: i32 = dstPtr + 12;
  let end: i32 = tmp;
  let v: i32 = value;
  while (v > 0) {
    tmp--;
    store<u8>(tmp, 0x30 + (v % 10));
    v = v / 10;
  }
  let count: i32 = 0;
  if (neg) {
    store<u8>(dstPtr, 0x2D);
    count = 1;
  }
  let digitLen: i32 = end - tmp;
  for (let i: i32 = 0; i < digitLen; i++) {
    store<u8>(dstPtr + count + i, load<u8>(tmp + i));
  }
  count += digitLen;
  return count;
}
`.trim();

    const SKIPWS_SOURCE = `
export function skipWS(ptr: i32, len: i32, start: i32): i32 {
  let i: i32 = start;
  while (i < len) {
    let c: i32 = load<u8>(ptr + i);
    if (c != 0x20 && c != 0x09 && c != 0x0A && c != 0x0D) break;
    i++;
  }
  return i;
}
`.trim();

    // Step 1: compile J3 (skipWS) through AS backend — find token start
    const wsResolution = makeSourceResolution("compound-skipWS", SKIPWS_SOURCE);
    const wsBackend = assemblyScriptBackend({ exportMemory: true });
    const wsWasmBytes = await wsBackend.emit(wsResolution);

    // Step 2: validate WASM module integrity
    expect(WebAssembly.validate(wsWasmBytes), "skipWS WASM bytes must be valid").toBe(true);

    // Step 3: WASM magic header (0x00 0x61 0x73 0x6d)
    expect(wsWasmBytes[0]).toBe(0x00);
    expect(wsWasmBytes[1]).toBe(0x61);
    expect(wsWasmBytes[2]).toBe(0x73);
    expect(wsWasmBytes[3]).toBe(0x6d);

    // Step 4: instantiate skipWS, write " \t\n  42" — token starts at index 5
    const { instance: wsInst } = await WebAssembly.instantiate(wsWasmBytes, {});
    const wsFn = wsInst.exports.skipWS as (ptr: number, len: number, start: number) => number;
    const wsMem = wsInst.exports.memory as WebAssembly.Memory;
    const wsDv = new DataView(wsMem.buffer);

    const jsonInput = " \t\n  42";
    const inputBytes = encodeAscii(jsonInput);
    writeBytes(wsDv, JSON_BASE_PTR, inputBytes);

    const tokenStart = wsFn(JSON_BASE_PTR, inputBytes.length, 0);
    expect(tokenStart).toBe(5); // skip 5 whitespace chars: ' ', '\t', '\n', ' ', ' '

    // Step 5: compile J1 (parseI32) independently — parse the token
    const parseResolution = makeSourceResolution("compound-parseI32", PARSEI32_SOURCE);
    const parseBackend = assemblyScriptBackend({ exportMemory: true });
    const parseWasmBytes = await parseBackend.emit(parseResolution);
    const { instance: parseInst } = await WebAssembly.instantiate(parseWasmBytes, {});
    const parseFn = parseInst.exports.parseI32 as (ptr: number, len: number) => number;
    const parseMem = parseInst.exports.memory as WebAssembly.Memory;
    const parseDv = new DataView(parseMem.buffer);

    // Write the token portion starting at the discovered offset
    const tokenBytes = inputBytes.slice(tokenStart);
    writeBytes(parseDv, JSON_BASE_PTR, tokenBytes);

    // Parse "42" from position 0 of its own buffer
    const parsed = parseFn(JSON_BASE_PTR, tokenBytes.length);
    expect(parsed).toBe(42);

    // Also verify negative: parse "-100"
    const negBytes = encodeAscii("-100");
    writeBytes(parseDv, JSON_BASE_PTR, negBytes);
    expect(parseFn(JSON_BASE_PTR, negBytes.length)).toBe(-100);

    // Parse "0"
    const zeroBytes = encodeAscii("0");
    writeBytes(parseDv, JSON_BASE_PTR, zeroBytes);
    expect(parseFn(JSON_BASE_PTR, zeroBytes.length)).toBe(0);

    // Step 6: compile J2 (writeI32) independently — emit the token back
    const writeResolution = makeSourceResolution("compound-writeI32", WRITEI32_SOURCE);
    const writeBackend = assemblyScriptBackend({ exportMemory: true });
    const writeWasmBytes = await writeBackend.emit(writeResolution);
    const { instance: writeInst } = await WebAssembly.instantiate(writeWasmBytes, {});
    const writeFn = writeInst.exports.writeI32 as (value: number, dstPtr: number) => number;
    const writeMem = writeInst.exports.memory as WebAssembly.Memory;
    const writeDv = new DataView(writeMem.buffer);

    // Emit 42 — should produce "42"
    let n = writeFn(42, DST_BASE_PTR);
    expect(n).toBe(2);
    let written = readBytes(writeDv, DST_BASE_PTR, n);
    expect(new TextDecoder().decode(written)).toBe("42");

    // Emit -100 — should produce "-100"
    n = writeFn(-100, DST_BASE_PTR);
    expect(n).toBe(4);
    written = readBytes(writeDv, DST_BASE_PTR, n);
    expect(new TextDecoder().decode(written)).toBe("-100");

    // Emit 0 — should produce "0"
    n = writeFn(0, DST_BASE_PTR);
    expect(n).toBe(1);
    written = readBytes(writeDv, DST_BASE_PTR, n);
    expect(new TextDecoder().decode(written)).toBe("0");

    // Step 7: round-trip verification — parse then write must reproduce input
    const testValues = [0, 1, -1, 42, -42, 99999, -99999, 1000000];
    for (const v of testValues) {
      // Write v into parse buffer, parse it back
      const vStr = String(v);
      const vBytes = encodeAscii(vStr);
      writeBytes(parseDv, JSON_BASE_PTR, vBytes);
      const parsedBack = parseFn(JSON_BASE_PTR, vBytes.length);
      expect(parsedBack).toBe(v);

      // Write parsed value into write buffer, read it back
      const wn = writeFn(parsedBack, DST_BASE_PTR);
      const wBytes = readBytes(writeDv, DST_BASE_PTR, wn);
      const wStr = new TextDecoder().decode(wBytes);
      expect(wStr).toBe(vStr);
    }

    // Step 8: backend identity verification
    expect(wsBackend.name).toBe("as");
    expect(parseBackend.name).toBe("as");
    expect(writeBackend.name).toBe("as");
  }, 30_000);
});
