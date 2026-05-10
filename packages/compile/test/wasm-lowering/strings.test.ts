/**
 * strings.test.ts — Property-based tests for WI-V1W3-WASM-LOWER-05.
 *
 * Purpose:
 *   Verify that the string lowering path produces WASM byte sequences that
 *   execute correctly and match TypeScript reference semantics.
 *   Six substrates: length, indexOf, slice, concat, template literal, equality.
 *   Each substrate runs ≥15 property-based cases via fast-check.
 *
 * String calling convention (per WASM_HOST_CONTRACT.md §6):
 *   Strings cross the WASM ↔ host boundary as (ptr: i32, len_bytes: i32).
 *   The host linear memory holds UTF-8 bytes at [ptr, ptr+len_bytes).
 *   String literal arguments must be written into linear memory before calling
 *   the WASM function; results are returned as (ptr, len) via out_ptr.
 *
 * Host imports added by WI-V1W3-WASM-LOWER-05 (indices 5–9 in the string module):
 *   5: host_string_length(ptr, len_bytes) → i32 char_count
 *   6: host_string_indexof(hp, hl, np, nl) → i32 char_index
 *   7: host_string_slice(ptr, len, start, end, out_ptr) → void (writes ptr+len at out_ptr)
 *   8: host_string_concat(p1, l1, p2, l2, out_ptr) → void (writes ptr+len at out_ptr)
 *   9: host_string_eq(p1, l1, p2, l2) → i32 (1 if equal, 0 if not)
 *
 * Test construction:
 *   Each test uses compileToWasm() via the full pipeline (LoweringVisitor →
 *   emitStringModule → instantiate). Input strings are written into the WASM
 *   linear memory by the test harness; the compiled WASM function is called with
 *   the (ptr, len) pairs.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001
 * @title .length returns char count via host_string_length (surrogate-aware)
 * @status accepted
 * @rationale
 *   JavaScript string .length returns UTF-16 code unit count, NOT byte count and
 *   NOT Unicode code point count. For ASCII strings all three are equal; for strings
 *   with multi-byte UTF-8 characters (e.g. "café"), JS .length = 4 (char units)
 *   while byte count = 5. For strings with emoji/surrogate pairs (e.g. "😀"),
 *   JS .length = 2 (two UTF-16 code units) while code point count = 1. To match
 *   JS semantics exactly — and make WASM-compiled code behaviorally equivalent to
 *   its TypeScript source — .length must return JS string.length. This is achieved
 *   by host_string_length: the host decodes the UTF-8 bytes from linear memory,
 *   constructs a JS string, and returns .length (UTF-16 code unit count). This
 *   is surrogate-aware because JS is UTF-16 internally.
 *   See WASM_HOST_CONTRACT.md §3.6 (WI-V1W3-WASM-LOWER-05 amendment).
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-INDEXOF-001
 * @title .indexOf returns char index (JS semantics) via host_string_indexof
 * @status accepted
 * @rationale
 *   JavaScript .indexOf returns the char index (UTF-16 code unit offset) of the
 *   first occurrence, or -1. Matching JS semantics requires the host to decode
 *   both UTF-8 buffers and call JS .indexOf. Byte-level indexOf would diverge
 *   for multi-byte sequences (a 3-byte character at byte offset 3 would be at
 *   char index 1 if preceded by one 2-byte character, not index 3). Char-index
 *   semantics also align with .slice's char-index arguments. The return value -1
 *   is transmitted as signed i32 (0xFFFFFFFF in two's-complement = -1 in JS).
 *   See WASM_HOST_CONTRACT.md §3.7.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-OUT-PTR-001
 * @title slice and concat use out_ptr to return (new_ptr, new_len) pair
 * @status accepted
 * @rationale
 *   WASM functions can only return a single value type per the MVP spec. String
 *   results need two values (ptr, len). Options: (a) return ptr and write len
 *   to a known fixed address; (b) pass an out_ptr where host writes 8 bytes
 *   (ptr: i32 at out_ptr+0, len: i32 at out_ptr+4); (c) add a multi-value type
 *   extension (post-MVP, not universally available). Option (b) is used: the
 *   WASM module calls host_alloc(8) to get an out_ptr, calls host_string_slice/
 *   concat with the out_ptr, then reads i32.load(out_ptr+0) and i32.load(out_ptr+4).
 *   This is conventional C/WASM pattern for out-params and does not require engine
 *   extensions. host_alloc failure in this path is an OOM — the module panics.
 *   See WASM_HOST_CONTRACT.md §3.7–3.8.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-EQ-001
 * @title === / !== on strings: host-mediated host_string_eq
 * @status accepted
 * @rationale
 *   Two options: (a) inline byte-compare loop (i32.load8_u per byte, branch if differ,
 *   check lengths first); (b) host-mediated host_string_eq. Inline byte-compare avoids
 *   a host round-trip and is O(n) without allocation — theoretically faster for short
 *   strings. However, inline byte-compare is ~15+ opcodes of loop + branching code that
 *   must be emitted INLINE at every === site, bloating the module significantly. For
 *   v1 wave-3 the priority is correctness and simplicity; the host round-trip cost is
 *   negligible for the evaluation workloads. Host-mediated also handles surrogate pairs
 *   correctly without emitting a UTF-16 decode loop in WASM. Choose (b). Future WIs
 *   can inline the comparison if profiling shows it to be a hot path.
 *   See WASM_HOST_CONTRACT.md §3.9.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-STR-DATA-SECTION-001
 * @title String literals coalesced into one data segment, referenced by offset
 * @status accepted
 * @rationale
 *   Two options: (a) one data segment per literal; (b) coalesced single segment.
 *   Option (b) reduces the number of WASM data section entries and consolidates
 *   all static string data into one region. The visitor builds a LiteralTable
 *   as it encounters string literals; the emitter writes all bytes into one
 *   segment starting at DATA_SEGMENT_BASE (=1024, leaving plenty of room for
 *   bump-allocated heap below 64 KiB). Each literal is referenced by its
 *   DATA_SEGMENT_BASE + cumulative_offset. The module initializes this segment
 *   once via the WASM data section (active, at DATA_SEGMENT_BASE).
 *   See visitor.ts LiteralTable.
 */

import {
  type BlockMerkleRoot,
  type LocalTriplet,
  blockMerkleRoot,
  specHash,
} from "@yakcc/contracts";
import type { SpecYak } from "@yakcc/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ResolutionResult, ResolvedBlock } from "../../src/resolve.js";
import { compileToWasm } from "../../src/wasm-backend.js";
import { createHost } from "../../src/wasm-host.js";

// ---------------------------------------------------------------------------
// Fixture helpers — mirrors wasm-host.test.ts pattern
// ---------------------------------------------------------------------------

function makeSpecYak(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "a", type: "string" }],
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

const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

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

function makeSingleBlockResolution(fnSource: string): ResolutionResult {
  const fnName = fnSource.match(/export\s+function\s+(\w+)/)?.[1] ?? "fn";
  const id = makeMerkleRoot(fnName, `${fnName} substrate`, fnSource);
  return makeResolution([{ id, source: fnSource }]);
}

// ---------------------------------------------------------------------------
// Host setup helpers for string testing
//
// String-WASM functions take (ptr: i32, len: i32) arguments.
// We need to write strings into linear memory before calling the function.
// ---------------------------------------------------------------------------

/**
 * Write a JS string as UTF-8 into linear memory starting at ptr.
 * Returns the byte length written.
 */
function writeString(memory: WebAssembly.Memory, ptr: number, s: string): number {
  const encoded = new TextEncoder().encode(s);
  const view = new Uint8Array(memory.buffer);
  view.set(encoded, ptr);
  return encoded.length;
}

/**
 * Read a (ptr, len) pair from the memory at outPtr.
 * Returns the decoded JS string.
 */
function readStringFromOutPtr(memory: WebAssembly.Memory, outPtr: number): string {
  const view = new DataView(memory.buffer);
  const ptr = view.getInt32(outPtr, true);
  const len = view.getInt32(outPtr + 4, true);
  if (len <= 0) return "";
  return new TextDecoder("utf-8").decode(new Uint8Array(memory.buffer, ptr, len));
}

/**
 * Instantiate a string WASM module and set up the host with string imports.
 * Returns the instance and host for subsequent calls.
 */
async function instantiateStringModule(wasmBytes: Uint8Array): Promise<{
  instance: WebAssembly.Instance;
  host: ReturnType<typeof createHost>;
  allocate: (size: number) => number;
}> {
  const host = createHost();
  const { instance } = (await WebAssembly.instantiate(
    wasmBytes,
    host.importObject,
  )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
  const yakccHost = host.importObject.yakcc_host as Record<string, unknown>;
  const allocate = yakccHost.host_alloc as (size: number) => number;
  return { instance, host, allocate };
}

// ---------------------------------------------------------------------------
// Helper: call a string WASM function that takes one string arg and returns i32
// ---------------------------------------------------------------------------
async function callStringToI32(
  fnSource: string,
  fnExportName: string,
  inputString: string,
): Promise<number> {
  const resolution = makeSingleBlockResolution(fnSource);
  const wasmBytes = await compileToWasm(resolution);
  const { instance, host, allocate } = await instantiateStringModule(wasmBytes);

  // Write the input string into memory
  const byteLen = new TextEncoder().encode(inputString).length;
  const ptr = allocate(byteLen > 0 ? byteLen : 1);
  writeString(host.memory, ptr, inputString);

  const fn = (instance.exports as Record<string, unknown>)[fnExportName] as (
    ptr: number,
    len: number,
  ) => number;
  return fn(ptr, byteLen);
}

// ---------------------------------------------------------------------------
// Helper: call a string WASM function that takes two string args and returns i32
// ---------------------------------------------------------------------------
async function callTwoStringsToI32(
  fnSource: string,
  fnExportName: string,
  str1: string,
  str2: string,
): Promise<number> {
  const resolution = makeSingleBlockResolution(fnSource);
  const wasmBytes = await compileToWasm(resolution);
  const { instance, host, allocate } = await instantiateStringModule(wasmBytes);

  const enc = new TextEncoder();
  const bytes1 = enc.encode(str1);
  const bytes2 = enc.encode(str2);

  const ptr1 = allocate(bytes1.length > 0 ? bytes1.length : 1);
  writeString(host.memory, ptr1, str1);
  const ptr2 = allocate(bytes2.length > 0 ? bytes2.length : 1);
  writeString(host.memory, ptr2, str2);

  const fn = (instance.exports as Record<string, unknown>)[fnExportName] as (
    p1: number,
    l1: number,
    p2: number,
    l2: number,
  ) => number;
  return fn(ptr1, bytes1.length, ptr2, bytes2.length);
}

// ---------------------------------------------------------------------------
// Helper: call a string WASM function returning a string via out_ptr
// ---------------------------------------------------------------------------
async function callStringResult(
  fnSource: string,
  fnExportName: string,
  str1: string,
  str2?: string,
  extraArgs?: number[],
): Promise<string> {
  const resolution = makeSingleBlockResolution(fnSource);
  const wasmBytes = await compileToWasm(resolution);
  const { instance, host, allocate } = await instantiateStringModule(wasmBytes);

  const enc = new TextEncoder();
  const bytes1 = enc.encode(str1);
  const ptr1 = allocate(bytes1.length > 0 ? bytes1.length : 1);
  writeString(host.memory, ptr1, str1);

  // Allocate an out_ptr for the result (ptr: i32, len: i32) = 8 bytes
  const outPtr = allocate(8);

  if (str2 !== undefined) {
    const bytes2 = enc.encode(str2);
    const ptr2 = allocate(bytes2.length > 0 ? bytes2.length : 1);
    writeString(host.memory, ptr2, str2);
    const fn = (instance.exports as Record<string, unknown>)[fnExportName] as (
      p1: number,
      l1: number,
      p2: number,
      l2: number,
      outPtr: number,
    ) => void;
    fn(ptr1, bytes1.length, ptr2, bytes2.length, outPtr);
  } else {
    const args = [ptr1, bytes1.length, ...(extraArgs ?? []), outPtr];
    const fn = (instance.exports as Record<string, unknown>)[fnExportName] as (
      ...a: number[]
    ) => void;
    fn(...args);
  }

  return readStringFromOutPtr(host.memory, outPtr);
}

// ---------------------------------------------------------------------------
// SUBSTRATE 1: .length — char count via host_string_length
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001 (see file header)
// ---------------------------------------------------------------------------

describe("string lowering — str-1: .length returns JS char count", () => {
  const SRC = "export function strLen(s: string): number { return s.length; }";

  it("str-1a: ASCII strings — .length matches JS reference over ≥15 fc.string() inputs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 50 }), async (s) => {
        const wasmResult = await callStringToI32(SRC, "__wasm_export_strLen", s);
        expect(wasmResult).toBe(s.length);
      }),
      { numRuns: 20 },
    );
  });

  it("str-1b: multi-byte UTF-8 strings — JS .length matches WASM (char count not byte count)", async () => {
    const testCases = [
      "café", // 4 chars, 5 bytes
      "日本語", // 3 chars, 9 bytes
      "", // empty
      "hello", // 5 chars, 5 bytes (ASCII)
      "😀", // 2 JS chars (surrogate pair), 4 bytes
    ];
    for (const s of testCases) {
      const wasmResult = await callStringToI32(SRC, "__wasm_export_strLen", s);
      expect(wasmResult).toBe(s.length);
    }
  });

  it("str-1c: empty string — .length returns 0", async () => {
    const wasmResult = await callStringToI32(SRC, "__wasm_export_strLen", "");
    expect(wasmResult).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 2: .indexOf — char index via host_string_indexof
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-STR-INDEXOF-001 (see file header)
// ---------------------------------------------------------------------------

describe("string lowering — str-2: .indexOf returns char index", () => {
  const SRC =
    "export function strIndexOf(haystack: string, needle: string): number { return haystack.indexOf(needle); }";

  it("str-2a: found cases — ≥15 property-based (haystack, needle) pairs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.nat({ max: 5 }).chain((len) => fc.string({ minLength: 0, maxLength: len })),
        async (haystack, needleBase) => {
          // Insert needle somewhere in haystack for a guaranteed-found case
          const insertPos = Math.floor(haystack.length / 2);
          const haystackWithNeedle =
            haystack.slice(0, insertPos) + needleBase + haystack.slice(insertPos);
          const expected = haystackWithNeedle.indexOf(needleBase);
          const wasmResult = await callTwoStringsToI32(
            SRC,
            "__wasm_export_strIndexOf",
            haystackWithNeedle,
            needleBase,
          );
          expect(wasmResult).toBe(expected);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("str-2b: not-found cases — returns -1", async () => {
    const notFoundCases: [string, string][] = [
      ["hello", "xyz"],
      ["abc", "abcd"],
      ["", "x"],
      ["foo", "FOO"], // case-sensitive
    ];
    for (const [haystack, needle] of notFoundCases) {
      const wasmResult = await callTwoStringsToI32(
        SRC,
        "__wasm_export_strIndexOf",
        haystack,
        needle,
      );
      expect(wasmResult).toBe(-1);
    }
  });

  it("str-2c: empty needle — returns 0 (JS semantics)", async () => {
    const wasmResult = await callTwoStringsToI32(SRC, "__wasm_export_strIndexOf", "hello", "");
    expect(wasmResult).toBe("hello".indexOf(""));
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 3: .slice — char-based substring via host_string_slice
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-STR-OUT-PTR-001 (see file header)
// ---------------------------------------------------------------------------

describe("string lowering — str-3: .slice produces correct substring", () => {
  const SRC_SLICE_2 =
    "export function strSlice2(s: string, start: number, end: number): string { return s.slice(start, end); }";
  const SRC_SLICE_1 =
    "export function strSlice1(s: string, start: number): string { return s.slice(start); }";

  it("str-3a: .slice(start, end) — ≥15 property-based cases match JS reference", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 2, maxLength: 20 }), async (s) => {
        const start = 0;
        const end = Math.floor(s.length / 2) + 1;
        const expected = s.slice(start, end);
        // str-3a uses SRC_SLICE_2 which has 4 params: (s_ptr, s_len, start, end, out_ptr)
        const resolution = makeSingleBlockResolution(SRC_SLICE_2);
        const wasmBytes = await compileToWasm(resolution);
        const { instance, host, allocate } = await instantiateStringModule(wasmBytes);

        const enc = new TextEncoder();
        const bytes = enc.encode(s);
        const ptr = allocate(bytes.length > 0 ? bytes.length : 1);
        writeString(host.memory, ptr, s);
        const outPtr = allocate(8);

        const fn = (instance.exports as Record<string, unknown>).__wasm_export_strSlice2 as (
          sPtr: number,
          sLen: number,
          start: number,
          end: number,
          outPtr: number,
        ) => void;
        fn(ptr, bytes.length, start, end, outPtr);

        const result = readStringFromOutPtr(host.memory, outPtr);
        expect(result).toBe(expected);
      }),
      { numRuns: 20 },
    );
  });

  it("str-3b: .slice(start) — no end arg — ≥15 cases", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 2, maxLength: 20 }), async (s) => {
        const start = 1;
        const expected = s.slice(start);
        const resolution = makeSingleBlockResolution(SRC_SLICE_1);
        const wasmBytes = await compileToWasm(resolution);
        const { instance, host, allocate } = await instantiateStringModule(wasmBytes);

        const enc = new TextEncoder();
        const bytes = enc.encode(s);
        const ptr = allocate(bytes.length > 0 ? bytes.length : 1);
        writeString(host.memory, ptr, s);
        const outPtr = allocate(8);

        const fn = (instance.exports as Record<string, unknown>).__wasm_export_strSlice1 as (
          sPtr: number,
          sLen: number,
          start: number,
          outPtr: number,
        ) => void;
        fn(ptr, bytes.length, start, outPtr);

        const result = readStringFromOutPtr(host.memory, outPtr);
        expect(result).toBe(expected);
      }),
      { numRuns: 20 },
    );
  });

  it("str-3c: edge cases — empty result, full string, out-of-range indices", async () => {
    const testCases: [string, number, number, string][] = [
      ["hello", 0, 5, "hello"], // full string
      ["hello", 2, 4, "ll"], // mid substring
      ["hello", 5, 5, ""], // empty — start == end
      ["hello", 3, 10, "lo"], // end > length → clamped
    ];
    for (const [s, start, end, expected] of testCases) {
      const resolution = makeSingleBlockResolution(SRC_SLICE_2);
      const wasmBytes = await compileToWasm(resolution);
      const { instance, host, allocate } = await instantiateStringModule(wasmBytes);

      const enc = new TextEncoder();
      const bytes = enc.encode(s);
      const ptr = allocate(bytes.length > 0 ? bytes.length : 1);
      writeString(host.memory, ptr, s);
      const outPtr = allocate(8);

      const fn = (instance.exports as Record<string, unknown>).__wasm_export_strSlice2 as (
        sPtr: number,
        sLen: number,
        start: number,
        end: number,
        outPtr: number,
      ) => void;
      fn(ptr, bytes.length, start, end, outPtr);

      const result = readStringFromOutPtr(host.memory, outPtr);
      expect(result).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 4: concat / + operator — host_string_concat
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-STR-OUT-PTR-001 (see file header)
// ---------------------------------------------------------------------------

describe("string lowering — str-4: concat via + operator", () => {
  const SRC_CONCAT = "export function strConcat(a: string, b: string): string { return a + b; }";

  it("str-4a: a + b — ≥15 property-based cases match JS reference", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 15 }),
        fc.string({ minLength: 0, maxLength: 15 }),
        async (a, b) => {
          const expected = a + b;
          const resolution = makeSingleBlockResolution(SRC_CONCAT);
          const wasmBytes = await compileToWasm(resolution);
          const { instance, host, allocate } = await instantiateStringModule(wasmBytes);

          const enc = new TextEncoder();
          const bytes1 = enc.encode(a);
          const bytes2 = enc.encode(b);
          const ptr1 = allocate(bytes1.length > 0 ? bytes1.length : 1);
          writeString(host.memory, ptr1, a);
          const ptr2 = allocate(bytes2.length > 0 ? bytes2.length : 1);
          writeString(host.memory, ptr2, b);
          const outPtr = allocate(8);

          const fn = (instance.exports as Record<string, unknown>).__wasm_export_strConcat as (
            p1: number,
            l1: number,
            p2: number,
            l2: number,
            outPtr: number,
          ) => void;
          fn(ptr1, bytes1.length, ptr2, bytes2.length, outPtr);

          const result = readStringFromOutPtr(host.memory, outPtr);
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("str-4b: concat with empty strings", async () => {
    const cases: [string, string][] = [
      ["", ""],
      ["", "hello"],
      ["world", ""],
      ["foo", "bar"],
    ];
    for (const [a, b] of cases) {
      const resolution = makeSingleBlockResolution(SRC_CONCAT);
      const wasmBytes = await compileToWasm(resolution);
      const { instance, host, allocate } = await instantiateStringModule(wasmBytes);

      const enc = new TextEncoder();
      const bytes1 = enc.encode(a);
      const bytes2 = enc.encode(b);
      const ptr1 = allocate(bytes1.length > 0 ? bytes1.length : 1);
      writeString(host.memory, ptr1, a);
      const ptr2 = allocate(bytes2.length > 0 ? bytes2.length : 1);
      writeString(host.memory, ptr2, b);
      const outPtr = allocate(8);

      const fn = (instance.exports as Record<string, unknown>).__wasm_export_strConcat as (
        p1: number,
        l1: number,
        p2: number,
        l2: number,
        outPtr: number,
      ) => void;
      fn(ptr1, bytes1.length, ptr2, bytes2.length, outPtr);

      const result = readStringFromOutPtr(host.memory, outPtr);
      expect(result).toBe(a + b);
    }
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 5: template literals — desugared to + chains
//
// Template literals `${a}${b}` desugar to a + b under string lowering.
// ---------------------------------------------------------------------------

describe("string lowering — str-5: template literals", () => {
  // Simple template literal with one embedded expression
  const SRC_TEMPLATE =
    "export function strTemplate(a: string, b: string): string { return `${a}${b}`; }";

  it("str-5a: `${a}${b}` — ≥15 property-based cases match JS reference (a + b)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 15 }),
        fc.string({ minLength: 0, maxLength: 15 }),
        async (a, b) => {
          const expected = `${a}${b}`;
          const resolution = makeSingleBlockResolution(SRC_TEMPLATE);
          const wasmBytes = await compileToWasm(resolution);
          const { instance, host, allocate } = await instantiateStringModule(wasmBytes);

          const enc = new TextEncoder();
          const bytes1 = enc.encode(a);
          const bytes2 = enc.encode(b);
          const ptr1 = allocate(bytes1.length > 0 ? bytes1.length : 1);
          writeString(host.memory, ptr1, a);
          const ptr2 = allocate(bytes2.length > 0 ? bytes2.length : 1);
          writeString(host.memory, ptr2, b);
          const outPtr = allocate(8);

          // Template `${a}${b}` desugars to a + b at the WASM level
          const fn = (instance.exports as Record<string, unknown>).__wasm_export_strTemplate as (
            p1: number,
            l1: number,
            p2: number,
            l2: number,
            outPtr: number,
          ) => void;
          fn(ptr1, bytes1.length, ptr2, bytes2.length, outPtr);

          const result = readStringFromOutPtr(host.memory, outPtr);
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 20 },
    );
  });

  // Template with string literal prefix
  const SRC_TEMPLATE_LITERAL =
    "export function greet(name: string): string { return `Hello, ${name}!`; }";

  it("str-5b: `Hello, ${name}!` — string literal in template, ≥15 cases", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 15 }).filter((s) => /^[a-zA-Z]+$/.test(s)),
        async (name) => {
          const expected = `Hello, ${name}!`;
          const resolution = makeSingleBlockResolution(SRC_TEMPLATE_LITERAL);
          const wasmBytes = await compileToWasm(resolution);
          const { instance, host, allocate } = await instantiateStringModule(wasmBytes);

          const enc = new TextEncoder();
          const nameBytes = enc.encode(name);
          const namePtr = allocate(nameBytes.length > 0 ? nameBytes.length : 1);
          writeString(host.memory, namePtr, name);
          const outPtr = allocate(8);

          const fn = (instance.exports as Record<string, unknown>).__wasm_export_greet as (
            namePtr: number,
            nameLen: number,
            outPtr: number,
          ) => void;
          fn(namePtr, nameBytes.length, outPtr);

          const result = readStringFromOutPtr(host.memory, outPtr);
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 6: === / !== equality — host_string_eq
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-STR-EQ-001 (see file header)
// ---------------------------------------------------------------------------

describe("string lowering — str-6: === and !== equality", () => {
  const SRC_EQ = "export function strEq(a: string, b: string): boolean { return a === b; }";
  const SRC_NEQ = "export function strNeq(a: string, b: string): boolean { return a !== b; }";

  it("str-6a: a === b — ≥15 property-based cases (equal and unequal pairs)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 20 }), async (s) => {
        // Test equal: a === a
        const equalResult = await callTwoStringsToI32(SRC_EQ, "__wasm_export_strEq", s, s);
        expect(equalResult).toBe(1); // true

        // Test unequal: s === s + "x" (usually different unless s ends with x)
        const differentStr = `${s}\x01`;
        const unequalResult = await callTwoStringsToI32(
          SRC_EQ,
          "__wasm_export_strEq",
          s,
          differentStr,
        );
        expect(unequalResult).toBe(0); // false
      }),
      { numRuns: 20 },
    );
  // Each run does 2 WASM compilations; allow 30s for 20 runs in slow CI environments.
  }, 30000);

  it("str-6b: a !== b — ≥15 property-based cases", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 20 }), async (s) => {
        // Not-equal: s !== s is false
        const sameResult = await callTwoStringsToI32(SRC_NEQ, "__wasm_export_strNeq", s, s);
        expect(sameResult).toBe(0); // false

        // Not-equal: s !== different is true
        const differentStr = `${s}\x01`;
        const diffResult = await callTwoStringsToI32(
          SRC_NEQ,
          "__wasm_export_strNeq",
          s,
          differentStr,
        );
        expect(diffResult).toBe(1); // true
      }),
      { numRuns: 20 },
    );
  // Each run does 2 WASM compilations; allow 30s for 20 runs in slow CI environments.
  }, 30000);

  it("str-6c: edge cases — empty string equality, case sensitivity", async () => {
    // "" === "" is true
    const emptyEq = await callTwoStringsToI32(SRC_EQ, "__wasm_export_strEq", "", "");
    expect(emptyEq).toBe(1);

    // "hello" === "Hello" is false (case-sensitive)
    const caseNeq = await callTwoStringsToI32(SRC_EQ, "__wasm_export_strEq", "hello", "Hello");
    expect(caseNeq).toBe(0);

    // "hello" === "hello" is true
    const helloEq = await callTwoStringsToI32(SRC_EQ, "__wasm_export_strEq", "hello", "hello");
    expect(helloEq).toBe(1);
  });
});
