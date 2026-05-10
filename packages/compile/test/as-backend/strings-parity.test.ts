// SPDX-License-Identifier: MIT
//
// strings-parity.test.ts — AS-backend T5: string substrates (P3 bucket)
//
// @decision DEC-AS-STRING-LAYOUT-001
// Title: AS-backend string substrates use flat-memory (ptr + len) layout over
//        UTF-8 bytes, not managed AS string type, because --runtime stub does
//        not support the GC-managed string internals required by string.length,
//        string.charCodeAt(), string.indexOf(), and string.slice(). The
//        flat-memory byte protocol (ptr: i32, len: i32 in bytes) mirrors
//        wave-3 lower-layout ABI and is directly wire-comparable across backends.
// Status: decided (WI-AS-PHASE-2B-STRINGS, 2026-05-10)
// Rationale:
//   AS managed string type (string literal, String.fromCharCode, s.length,
//   s.charCodeAt, s.indexOf, s.slice) requires the GC runtime for:
//     - string.length (reads GC-managed string header)
//     - string.charCodeAt(i) (bounds-checked GC read of UTF-16 code unit)
//     - string.indexOf(sub) (GC string search, managed allocation)
//     - string.slice(start, end) (managed string allocation / GC copy)
//   With --runtime stub, any managed-type operation that triggers the GC
//   either traps at runtime or fails to compile.
//
//   FINDING (S-managed): asc 0.28.x with --runtime stub does NOT support
//   AS managed string type. String literals and managed string operations
//   require --runtime minimal or higher (which enables the AS GC and string
//   runtime library). Managed string defers to a future AS runtime upgrade
//   when the GC runtime tier is adopted (DEC-AS-STRING-LAYOUT-001 follow-up).
//
//   ASCII-ONLY CONSTRAINT (v1): These substrates use ASCII-only inputs
//   (single-byte UTF-8 characters, code points 0x20–0x7E). This avoids
//   multi-byte UTF-8 complications (2–4 byte sequences) for the initial parity
//   baseline. Full Unicode / multi-byte UTF-8 handling defers to a follow-up
//   issue when multi-byte string operations are needed.
//
//   The flat-memory byte protocol matches the arrays-parity.test.ts convention:
//     - ptr points to byte[0] of the string in WASM linear memory
//     - len is the byte count (= character count for ASCII)
//     - Byte at index i: load<u8>(ptr + i)
//     - STR_BASE_PTR = 1024 (well above AS stub runtime header region)
//     - DST_BASE_PTR = 4096 (separate output buffer for slice/copy operations)
//   This protocol is directly wire-compatible with wave-3 wasm-lowering's
//   string ABI (DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001).
//
// Five substrates (per eval contract T5):
//   S1: strLen     — return len parameter (flat-memory length pass-through)
//   S2: byteAt     — read byte at index i from string memory
//   S3: strEq      — byte-by-byte equality comparison (memcmp variant)
//   S4: indexOfByte — scan for first occurrence of byte b; return index or -1
//   S5: copySlice  — copy bytes [start, end) from src into dst; return count
//
// Minimum 20 fast-check runs per substrate (eval contract T5).
//
// @decision DEC-AS-PARITY-TEST-NODE-WASM-001 (inherited from numeric-parity.test.ts)
// @decision DEC-AS-PARITY-TEST-RESOLUTION-BUILDER-001 (inherited from numeric-parity.test.ts)
// @decision DEC-AS-BACKEND-OPTIONS-001 (exportMemory: true for all string substrates)

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
// Fixture helpers — mirror arrays-parity.test.ts pattern exactly
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
  const id = makeMerkleRoot(name, `String substrate: ${name}`, source);
  return makeResolution([{ id, source }]);
}

// ---------------------------------------------------------------------------
// Flat-memory layout constants
// @decision DEC-AS-STRING-LAYOUT-001
//
// Strings are byte arrays (UTF-8, ASCII-only for v1).
// ptr points to byte[0]; len is byte count (= char count for ASCII).
// Byte at index i: load<u8>(ptr + i).
//
// STR_BASE_PTR = 1024: placed well above AS stub runtime header region,
//   also above arrays-parity's ARR_BASE_PTR (64) to avoid any collision if
//   tests are read in the same memory model discussion.
// STR2_BASE_PTR = 2048: second string buffer (for S3 strEq two-string case).
// DST_BASE_PTR = 4096: destination buffer for S5 copySlice output.
//
// MAX_STR_LEN = 64: max bytes in fast-check property tests (ASCII chars).
//   Ensures all three buffers are non-overlapping within default WASM page (64 KiB).
// ---------------------------------------------------------------------------

const STR_BASE_PTR = 1024;  // base pointer for primary string in WASM memory
const STR2_BASE_PTR = 2048; // base pointer for second string (S3 equality)
const DST_BASE_PTR = 4096;  // base pointer for copy-slice output (S5)
const MAX_STR_LEN = 64;     // max bytes in fast-check property tests

// ---------------------------------------------------------------------------
// ASCII string generator helper
//
// fc.string({ size: 'small' }) may include non-ASCII characters; we restrict
// to printable ASCII (0x20–0x7E) for v1 to avoid multi-byte UTF-8 complexity.
// @decision DEC-AS-STRING-LAYOUT-001 (ASCII-ONLY CONSTRAINT)
// ---------------------------------------------------------------------------

/** Arbitrary that produces ASCII-only strings of length [0, MAX_STR_LEN].
 *
 * Uses fc.string({ unit: 'grapheme-ascii' }) which generates printable ASCII
 * characters (code points 0x20–0x7E) as single-character graphemes. This is
 * the correct fast-check 4.x API — fc.stringOf() does not exist in this version.
 * The 'grapheme-ascii' unit matches our ASCII-ONLY CONSTRAINT exactly.
 * @decision DEC-AS-STRING-LAYOUT-001 (ASCII-ONLY CONSTRAINT)
 */
const asciiString = fc.string({
  unit: "grapheme-ascii",
  minLength: 0,
  maxLength: MAX_STR_LEN,
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
// S1: strLen — return explicit length parameter
//
// AS source: strLen(ptr: i32, len: i32): i32
//   With --runtime stub, managed string.length is unavailable.
//   The flat-memory protocol passes byte length as an explicit parameter.
//   The function simply returns len, verifying that the parameter is forwarded
//   correctly through the WASM ABI (same shape as A1 from arrays-parity).
//
// TS reference: identity on len.
//
// FINDING: AS managed string.length is NOT supported under --runtime stub.
//   The flat-memory variant (explicit len parameter) is the correct protocol
//   matching wave-3 string ABI.
// @decision DEC-AS-STRING-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend strings — S1: strLen (flat-memory length via explicit parameter)", () => {
  // exportMemory: true — string substrates read/write bytes in WASM memory.
  // @decision DEC-AS-BACKEND-OPTIONS-001
  const STRLEN_SOURCE = `
export function strLen(ptr: i32, len: i32): i32 {
  return len;
}
`.trim();

  it("S1: strLen compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("strLen", STRLEN_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "strLen WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.strLen).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("S1: strLen — fixed cases: empty, single char, and multi-char strings", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("strLen", STRLEN_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.strLen as (ptr: number, len: number) => number;

    expect(fn(STR_BASE_PTR, 0)).toBe(0);   // empty string
    expect(fn(STR_BASE_PTR, 1)).toBe(1);   // single character
    expect(fn(STR_BASE_PTR, 5)).toBe(5);   // "hello"
    expect(fn(STR_BASE_PTR, 64)).toBe(64); // max test size
  }, 30_000);

  it("S1: strLen — value parity vs explicit len (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("strLen", STRLEN_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.strLen as (ptr: number, len: number) => number;

    await fc.assert(
      fc.asyncProperty(
        asciiString,
        async (s) => {
          const bytes = encodeAscii(s);
          // TS reference: byte length is exactly bytes.length
          expect(fn(STR_BASE_PTR, bytes.length)).toBe(bytes.length);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S2: byteAt — read byte at index i from string memory
//
// AS source: byteAt(ptr: i32, len: i32, i: i32): i32
//   Reads the u8 byte at byte offset (ptr + i) using load<u8>.
//   len (byte count) is accepted for protocol parity but not bounds-checked
//   inside the function (fast-check guarantees 0 <= i < len).
//   Returns the u8 value at that position in WASM linear memory.
//
// TS reference: write string bytes into WASM memory via DataView/Uint8Array,
//               then assert fn(ptr, len, i) === bytes[i].
//
// Fast-check: non-empty ASCII strings with a valid byte index.
// @decision DEC-AS-STRING-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend strings — S2: byteAt (flat-memory single byte read)", () => {
  const BYTEAT_SOURCE = `
export function byteAt(ptr: i32, len: i32, i: i32): i32 {
  return load<u8>(ptr + i);
}
`.trim();

  it("S2: byteAt compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("byteAt", BYTEAT_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "byteAt WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.byteAt).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("S2: byteAt — fixed cases: first, middle, last byte of known ASCII strings", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("byteAt", BYTEAT_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.byteAt as (ptr: number, len: number, i: number) => number;
    const dv = new DataView(mem.buffer);

    // "hello" → [104, 101, 108, 108, 111]
    const hello = encodeAscii("hello");
    writeBytes(dv, STR_BASE_PTR, hello);

    expect(fn(STR_BASE_PTR, hello.length, 0)).toBe(104); // 'h'
    expect(fn(STR_BASE_PTR, hello.length, 1)).toBe(101); // 'e'
    expect(fn(STR_BASE_PTR, hello.length, 2)).toBe(108); // 'l'
    expect(fn(STR_BASE_PTR, hello.length, 4)).toBe(111); // 'o'

    // "A" → [65]
    const A = encodeAscii("A");
    writeBytes(dv, STR_BASE_PTR, A);
    expect(fn(STR_BASE_PTR, A.length, 0)).toBe(65); // 'A'
  }, 30_000);

  it("S2: byteAt — value parity vs JS byte read (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("byteAt", BYTEAT_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.byteAt as (ptr: number, len: number, i: number) => number;

    await fc.assert(
      fc.asyncProperty(
        // Non-empty ASCII string and a valid byte index
        fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: MAX_STR_LEN }).chain((s) =>
          fc.tuple(
            fc.constant(s),
            fc.integer({ min: 0, max: s.length - 1 }),
          ),
        ),
        async ([s, i]) => {
          const bytes = encodeAscii(s);
          const dv = new DataView(mem.buffer);
          writeBytes(dv, STR_BASE_PTR, bytes);

          // TS reference: direct byte read from Uint8Array
          const tsRef = bytes[i]!;
          const result = fn(STR_BASE_PTR, bytes.length, i);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S3: strEq — byte-by-byte equality comparison (memcmp variant)
//
// AS source: strEq(p1: i32, len1: i32, p2: i32, len2: i32): i32
//   Returns 0 immediately if len1 !== len2.
//   Otherwise iterates over len1 bytes, returning 0 on first mismatch.
//   Returns 1 if all bytes match.
//
// TS reference: JS string equality (===) on the decoded strings.
//   For ASCII-only inputs, string equality ↔ byte-array equality.
//
// Fast-check: two independent ASCII strings; result === (s1 === s2) ? 1 : 0.
//   Also tests same-string reference (equality guaranteed), and different-length
//   prefix/suffix pairs.
// @decision DEC-AS-STRING-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend strings — S3: strEq (flat-memory byte-by-byte equality)", () => {
  const STREQ_SOURCE = `
export function strEq(p1: i32, len1: i32, p2: i32, len2: i32): i32 {
  if (len1 !== len2) return 0;
  for (let i: i32 = 0; i < len1; i++) {
    if (load<u8>(p1 + i) !== load<u8>(p2 + i)) return 0;
  }
  return 1;
}
`.trim();

  it("S3: strEq compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("strEq", STREQ_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "strEq WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.strEq).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("S3: strEq — fixed cases: equal strings, different lengths, same prefix", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("strEq", STREQ_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.strEq as (
      p1: number, len1: number, p2: number, len2: number
    ) => number;
    const dv = new DataView(mem.buffer);

    // Two empty strings → equal
    expect(fn(STR_BASE_PTR, 0, STR2_BASE_PTR, 0)).toBe(1);

    // "hello" == "hello"
    const hello = encodeAscii("hello");
    writeBytes(dv, STR_BASE_PTR, hello);
    writeBytes(dv, STR2_BASE_PTR, hello);
    expect(fn(STR_BASE_PTR, hello.length, STR2_BASE_PTR, hello.length)).toBe(1);

    // "hello" != "world" (same length, different content)
    const world = encodeAscii("world");
    writeBytes(dv, STR2_BASE_PTR, world);
    expect(fn(STR_BASE_PTR, hello.length, STR2_BASE_PTR, world.length)).toBe(0);

    // "hello" != "hell" (different lengths)
    const hell = encodeAscii("hell");
    writeBytes(dv, STR2_BASE_PTR, hell);
    expect(fn(STR_BASE_PTR, hello.length, STR2_BASE_PTR, hell.length)).toBe(0);

    // "hello" != "helloo" (different lengths, prefix match)
    const helloo = encodeAscii("helloo");
    writeBytes(dv, STR2_BASE_PTR, helloo);
    expect(fn(STR_BASE_PTR, hello.length, STR2_BASE_PTR, helloo.length)).toBe(0);

    // Single char "A" == "A"
    const A = encodeAscii("A");
    writeBytes(dv, STR_BASE_PTR, A);
    writeBytes(dv, STR2_BASE_PTR, A);
    expect(fn(STR_BASE_PTR, A.length, STR2_BASE_PTR, A.length)).toBe(1);

    // Single char "A" != "B"
    const B = encodeAscii("B");
    writeBytes(dv, STR2_BASE_PTR, B);
    expect(fn(STR_BASE_PTR, A.length, STR2_BASE_PTR, B.length)).toBe(0);
  }, 30_000);

  it("S3: strEq — value parity vs JS === comparison (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("strEq", STREQ_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.strEq as (
      p1: number, len1: number, p2: number, len2: number
    ) => number;

    await fc.assert(
      fc.asyncProperty(
        // Two independent ASCII strings — may or may not be equal
        fc.tuple(asciiString, asciiString),
        async ([s1, s2]) => {
          const b1 = encodeAscii(s1);
          const b2 = encodeAscii(s2);
          const dv = new DataView(mem.buffer);
          writeBytes(dv, STR_BASE_PTR, b1);
          writeBytes(dv, STR2_BASE_PTR, b2);

          // TS reference: JS string equality (valid for ASCII where byte equality = string equality)
          const tsRef = s1 === s2 ? 1 : 0;
          const result = fn(STR_BASE_PTR, b1.length, STR2_BASE_PTR, b2.length);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S4: indexOfByte — scan for first occurrence of byte b
//
// AS source: indexOfByte(ptr: i32, len: i32, b: i32): i32
//   Iterates over len bytes starting at ptr.
//   Returns the index of the first byte equal to (b & 0xFF), or -1 if absent.
//   Only the low 8 bits of b are compared (load<u8> naturally returns u8).
//
// TS reference: JS string.indexOf(String.fromCharCode(b)) for ASCII chars.
//   Limit fast-check to printable ASCII (0x20–0x7E) to ensure the searched
//   byte is representable as a single char (ASCII-ONLY CONSTRAINT).
//
// Fast-check: ASCII string + ASCII byte; result matches JS indexOf.
// @decision DEC-AS-STRING-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend strings — S4: indexOfByte (flat-memory byte scan)", () => {
  const INDEXOFBYTE_SOURCE = `
export function indexOfByte(ptr: i32, len: i32, b: i32): i32 {
  for (let i: i32 = 0; i < len; i++) {
    if (load<u8>(ptr + i) === b) return i;
  }
  return -1;
}
`.trim();

  it("S4: indexOfByte compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("indexOfByte", INDEXOFBYTE_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "indexOfByte WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.indexOfByte).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("S4: indexOfByte — fixed cases: found at first, middle, last; not found; empty", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("indexOfByte", INDEXOFBYTE_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.indexOfByte as (ptr: number, len: number, b: number) => number;
    const dv = new DataView(mem.buffer);

    // "hello" → 'h'=104 at 0, 'e'=101 at 1, 'l'=108 at 2, 'o'=111 at 4
    const hello = encodeAscii("hello");
    writeBytes(dv, STR_BASE_PTR, hello);

    expect(fn(STR_BASE_PTR, hello.length, 104)).toBe(0);  // 'h' at index 0
    expect(fn(STR_BASE_PTR, hello.length, 101)).toBe(1);  // 'e' at index 1
    expect(fn(STR_BASE_PTR, hello.length, 108)).toBe(2);  // first 'l' at index 2
    expect(fn(STR_BASE_PTR, hello.length, 111)).toBe(4);  // 'o' at index 4
    expect(fn(STR_BASE_PTR, hello.length, 120)).toBe(-1); // 'x' not in "hello"

    // Empty string → always -1
    expect(fn(STR_BASE_PTR, 0, 104)).toBe(-1);

    // Single char "A" (65): found vs not found
    const A = encodeAscii("A");
    writeBytes(dv, STR_BASE_PTR, A);
    expect(fn(STR_BASE_PTR, A.length, 65)).toBe(0);   // 'A' found at 0
    expect(fn(STR_BASE_PTR, A.length, 66)).toBe(-1);  // 'B' not found
  }, 30_000);

  it("S4: indexOfByte — value parity vs JS indexOf (20 fast-check cases)", async () => {
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
          writeBytes(dv, STR_BASE_PTR, bytes);

          // TS reference: JS string indexOf for ASCII char (byte = char for ASCII)
          const tsRef = s.indexOf(String.fromCharCode(b));
          const result = fn(STR_BASE_PTR, bytes.length, b);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S5: copySlice — copy bytes [start, end) from src to dst; return byte count
//
// AS source: copySlice(srcPtr: i32, srcLen: i32, start: i32, end: i32, dstPtr: i32): i32
//   Copies bytes at src[start .. min(end, srcLen)] to dst[0..n].
//   Returns n (number of bytes copied).
//   Semantically equivalent to: s.slice(start, end) → dst buffer.
//
// FINDING: AS managed string.slice() NOT supported under --runtime stub.
//   asc 0.28.x with --runtime stub does not implement managed string slice
//   (which would allocate a new GC string). The flat-memory manual-copy
//   variant operates entirely within linear memory.
//
// TS reference: JS s.slice(start, end) encoded to bytes; compare dst bytes.
//   Clamped: if end > srcLen, copies up to srcLen.
//
// Memory layout:
//   src: STR_BASE_PTR (1024) — input string bytes
//   dst: DST_BASE_PTR (4096) — output slice bytes (non-overlapping)
//   Both fit MAX_STR_LEN (64) bytes without overlap.
//
// Fast-check: ASCII string + valid [start, end] range within [0, len].
// @decision DEC-AS-STRING-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend strings — S5: copySlice (flat-memory substring copy)", () => {
  // FINDING: Managed string.slice() NOT supported under --runtime stub.
  // See @decision DEC-AS-STRING-LAYOUT-001 and file header FINDING (S-managed).
  // This variant emulates slice semantics via flat linear memory byte copies.
  const COPYSLICE_SOURCE = `
export function copySlice(srcPtr: i32, srcLen: i32, start: i32, end: i32, dstPtr: i32): i32 {
  let n: i32 = 0;
  for (let i: i32 = start; i < end && i < srcLen; i++) {
    store<u8>(dstPtr + n, load<u8>(srcPtr + i));
    n++;
  }
  return n;
}
`.trim();

  it("S5: copySlice compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("copySlice", COPYSLICE_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "copySlice WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.copySlice).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("S5: copySlice — fixed cases: full copy, prefix, suffix, middle, empty range", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("copySlice", COPYSLICE_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.copySlice as (
      srcPtr: number, srcLen: number, start: number, end: number, dstPtr: number
    ) => number;
    const dv = new DataView(mem.buffer);

    const hello = encodeAscii("hello");
    writeBytes(dv, STR_BASE_PTR, hello);

    // Full copy: slice(0, 5) → "hello" (5 bytes)
    let n = fn(STR_BASE_PTR, hello.length, 0, hello.length, DST_BASE_PTR);
    expect(n).toBe(5);
    for (let i = 0; i < hello.length; i++) {
      expect(dv.getUint8(DST_BASE_PTR + i)).toBe(hello[i]!);
    }

    // Prefix: slice(0, 3) → "hel" (3 bytes)
    n = fn(STR_BASE_PTR, hello.length, 0, 3, DST_BASE_PTR);
    expect(n).toBe(3);
    expect(dv.getUint8(DST_BASE_PTR + 0)).toBe(104); // 'h'
    expect(dv.getUint8(DST_BASE_PTR + 1)).toBe(101); // 'e'
    expect(dv.getUint8(DST_BASE_PTR + 2)).toBe(108); // 'l'

    // Suffix: slice(3, 5) → "lo" (2 bytes)
    n = fn(STR_BASE_PTR, hello.length, 3, 5, DST_BASE_PTR);
    expect(n).toBe(2);
    expect(dv.getUint8(DST_BASE_PTR + 0)).toBe(108); // 'l'
    expect(dv.getUint8(DST_BASE_PTR + 1)).toBe(111); // 'o'

    // Middle: slice(1, 4) → "ell" (3 bytes)
    n = fn(STR_BASE_PTR, hello.length, 1, 4, DST_BASE_PTR);
    expect(n).toBe(3);
    expect(dv.getUint8(DST_BASE_PTR + 0)).toBe(101); // 'e'
    expect(dv.getUint8(DST_BASE_PTR + 1)).toBe(108); // 'l'
    expect(dv.getUint8(DST_BASE_PTR + 2)).toBe(108); // 'l'

    // Empty range: slice(2, 2) → "" (0 bytes)
    n = fn(STR_BASE_PTR, hello.length, 2, 2, DST_BASE_PTR);
    expect(n).toBe(0);

    // Clamp to srcLen: slice(3, 100) → "lo" (clamped to [3, 5])
    n = fn(STR_BASE_PTR, hello.length, 3, 100, DST_BASE_PTR);
    expect(n).toBe(2);

    // Empty source string: slice(0, 0) → 0 bytes copied
    n = fn(STR_BASE_PTR, 0, 0, 0, DST_BASE_PTR);
    expect(n).toBe(0);
  }, 30_000);

  it("S5: copySlice — value parity vs JS slice (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("copySlice", COPYSLICE_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.copySlice as (
      srcPtr: number, srcLen: number, start: number, end: number, dstPtr: number
    ) => number;

    await fc.assert(
      fc.asyncProperty(
        // ASCII string + [start, end] range within [0, len]
        asciiString.chain((s) => {
          const len = s.length;
          if (len === 0) {
            return fc.constant({ s, start: 0, end: 0 });
          }
          return fc.tuple(
            fc.integer({ min: 0, max: len }),
            fc.integer({ min: 0, max: len }),
          ).map(([a, b]) => ({ s, start: Math.min(a, b), end: Math.max(a, b) }));
        }),
        async ({ s, start, end }) => {
          const bytes = encodeAscii(s);
          const dv = new DataView(mem.buffer);
          writeBytes(dv, STR_BASE_PTR, bytes);

          const n = fn(STR_BASE_PTR, bytes.length, start, end, DST_BASE_PTR);

          // TS reference: JS slice then encode (for ASCII, bytes = chars)
          const tsSlice = encodeAscii(s.slice(start, end));
          expect(n).toBe(tsSlice.length);

          // Verify each copied byte matches
          for (let i = 0; i < tsSlice.length; i++) {
            const actual = dv.getUint8(DST_BASE_PTR + i);
            expect(actual).toBe(tsSlice[i]!);
          }
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Compound-interaction test
//
// Exercises the full production sequence end-to-end across multiple internal
// component boundaries:
//   source → AS backend → WASM bytes → validate → instantiate → memory write
//   → call (S3 strEq) → value check → call (S4 indexOfByte) → value check
//   → call (S5 copySlice) → verify copied bytes.
//
// Uses S3 (strEq) as the primary substrate: it exercises the length-mismatch
// short-circuit, the for-loop body, and the byte-comparison state transitions —
// the core string-comparison sequence in production.
// Also verifies S4 (indexOfByte) and S5 (copySlice) parity using the same
// in-memory string to cross the source → backend → WASM → call boundary.
//
// This test crosses the ResolutionResult → assemblyScriptBackend() →
// WebAssembly.instantiate() → DataView write → WASM call → JS value compare
// boundary chain — the full production path for string-aware atoms.
//
// @decision DEC-AS-STRING-LAYOUT-001
// @decision DEC-AS-PARITY-TEST-NODE-WASM-001 (inherited from numeric-parity.test.ts)
// ---------------------------------------------------------------------------

describe("AS backend strings — compound-interaction (end-to-end production sequence)", () => {
  it("S3+S4+S5/compound: strEq+indexOfByte+copySlice via full source→backend→wasm→instantiate→call sequence", async () => {
    const STREQ_SOURCE = `
export function strEq(p1: i32, len1: i32, p2: i32, len2: i32): i32 {
  if (len1 !== len2) return 0;
  for (let i: i32 = 0; i < len1; i++) {
    if (load<u8>(p1 + i) !== load<u8>(p2 + i)) return 0;
  }
  return 1;
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

    const COPYSLICE_SOURCE = `
export function copySlice(srcPtr: i32, srcLen: i32, start: i32, end: i32, dstPtr: i32): i32 {
  let n: i32 = 0;
  for (let i: i32 = start; i < end && i < srcLen; i++) {
    store<u8>(dstPtr + n, load<u8>(srcPtr + i));
    n++;
  }
  return n;
}
`.trim();

    // Step 1: compile S3 (strEq) through AS backend
    const eqResolution = makeSourceResolution("compound-strEq", STREQ_SOURCE);
    const eqBackend = assemblyScriptBackend({ exportMemory: true });
    const eqWasmBytes = await eqBackend.emit(eqResolution);

    // Step 2: validate WASM module integrity
    expect(WebAssembly.validate(eqWasmBytes), "strEq WASM bytes must be valid").toBe(true);

    // Step 3: WASM magic header (0x00 0x61 0x73 0x6d)
    expect(eqWasmBytes[0]).toBe(0x00);
    expect(eqWasmBytes[1]).toBe(0x61);
    expect(eqWasmBytes[2]).toBe(0x73);
    expect(eqWasmBytes[3]).toBe(0x6d);

    // Step 4: instantiate and write string data
    const { instance: eqInst } = await WebAssembly.instantiate(eqWasmBytes, {});
    const eqFn = eqInst.exports.strEq as (
      p1: number, len1: number, p2: number, len2: number
    ) => number;
    const eqMem = eqInst.exports.memory as WebAssembly.Memory;
    const eqDv = new DataView(eqMem.buffer);

    // Write "hello" and "hello" for equality, "world" for inequality
    const hello = encodeAscii("hello");
    const world = encodeAscii("world");
    writeBytes(eqDv, STR_BASE_PTR, hello);
    writeBytes(eqDv, STR2_BASE_PTR, hello);

    // Step 5: verify strEq state transitions
    expect(eqFn(STR_BASE_PTR, hello.length, STR2_BASE_PTR, hello.length)).toBe(1); // equal
    writeBytes(eqDv, STR2_BASE_PTR, world);
    expect(eqFn(STR_BASE_PTR, hello.length, STR2_BASE_PTR, world.length)).toBe(0); // not equal
    expect(eqFn(STR_BASE_PTR, 0, STR2_BASE_PTR, 0)).toBe(1);                       // two empties equal
    expect(eqFn(STR_BASE_PTR, hello.length, STR2_BASE_PTR, 3)).toBe(0);             // different lengths

    // Step 6: compile S4 (indexOfByte) independently, verify scan on known string
    const idxResolution = makeSourceResolution("compound-indexOfByte", INDEXOFBYTE_SOURCE);
    const idxBackend = assemblyScriptBackend({ exportMemory: true });
    const idxWasmBytes = await idxBackend.emit(idxResolution);
    const { instance: idxInst } = await WebAssembly.instantiate(idxWasmBytes, {});
    const idxFn = idxInst.exports.indexOfByte as (ptr: number, len: number, b: number) => number;
    const idxMem = idxInst.exports.memory as WebAssembly.Memory;
    const idxDv = new DataView(idxMem.buffer);

    // Write "hello" into indexOfByte's WASM instance memory
    writeBytes(idxDv, STR_BASE_PTR, hello);
    expect(idxFn(STR_BASE_PTR, hello.length, 104)).toBe(0);  // 'h' at 0
    expect(idxFn(STR_BASE_PTR, hello.length, 111)).toBe(4);  // 'o' at 4
    expect(idxFn(STR_BASE_PTR, hello.length, 90)).toBe(-1);  // 'Z' absent

    // Step 7: compile S5 (copySlice) independently, verify copy on known string
    const sliceResolution = makeSourceResolution("compound-copySlice", COPYSLICE_SOURCE);
    const sliceBackend = assemblyScriptBackend({ exportMemory: true });
    const sliceWasmBytes = await sliceBackend.emit(sliceResolution);
    const { instance: sliceInst } = await WebAssembly.instantiate(sliceWasmBytes, {});
    const sliceFn = sliceInst.exports.copySlice as (
      srcPtr: number, srcLen: number, start: number, end: number, dstPtr: number
    ) => number;
    const sliceMem = sliceInst.exports.memory as WebAssembly.Memory;
    const sliceDv = new DataView(sliceMem.buffer);

    // Write "hello" and copy slice [1, 4) → "ell"
    writeBytes(sliceDv, STR_BASE_PTR, hello);
    const copied = sliceFn(STR_BASE_PTR, hello.length, 1, 4, DST_BASE_PTR);
    expect(copied).toBe(3); // "ell" = 3 bytes
    expect(sliceDv.getUint8(DST_BASE_PTR + 0)).toBe(101); // 'e'
    expect(sliceDv.getUint8(DST_BASE_PTR + 1)).toBe(108); // 'l'
    expect(sliceDv.getUint8(DST_BASE_PTR + 2)).toBe(108); // 'l'

    // Step 8: backend identity
    expect(eqBackend.name).toBe("as");
    expect(idxBackend.name).toBe("as");
    expect(sliceBackend.name).toBe("as");
  }, 30_000);
});
