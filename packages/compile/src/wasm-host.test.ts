/**
 * wasm-host.test.ts — Conformance fixture for the yakcc WASM host runtime.
 *
 * This file IS the conformance fixture referenced by WASM_HOST_CONTRACT.md §9.
 * Any host claiming "Conformant with WASM_HOST_CONTRACT.md v1 wave-2" must
 * pass all 8 tests defined here.
 *
 * Production sequence exercised:
 *   compileToWasm(resolution) → instantiateAndRun(bytes, fnName, args)
 *   → host.logs / WasmTrap propagation
 *
 * ts-backend parity note (test 8):
 *   compileToTypeScript is not exercised in isolation here because its test
 *   ergonomics require an eval() round-trip that adds test complexity without
 *   adding coverage value for the WASM host contract. Instead, the reference
 *   implementation (a + b) is used as the ts-backend stand-in. This is
 *   explicitly documented per the dispatch brief: "a hand-written reference
 *   function satisfies the acceptance criterion for the add substrate."
 *
 * Tests:
 *   1. importObject shape — all 5 yakcc_host keys present
 *   2. __wasm_export_add(2,3) === 5 via instantiateAndRun
 *   3. __wasm_export_string_len round-trips UTF-8 string through host_alloc + passback
 *   4. __wasm_export_panic_demo throws WasmTrap { kind:"unreachable", hostPanicCode:0x42 }
 *   5. Bump allocator — 3 sequential host_alloc(8) return increasing non-overlapping ptrs
 *   6. OOM — host_alloc(70000) throws WasmTrap { kind:"oom" }
 *   7. _yakcc_table exported as WebAssembly.Table with size 0
 *   8. Acceptance: ts-backend parity — ≥5 input pairs match between WASM and reference
 *
 * @decision DEC-V1-WAVE-2-WASM-TEST-002: conformance tests use compileToWasm() for
 * the actual WASM bytes (not hand-crafted bytes), so the tests exercise the emitter
 * and the host together as a compound system. host_alloc tests use createHost() +
 * direct import calls to isolate allocator behavior without needing a substrate function.
 * Status: decided (WI-V1W2-WASM-03)
 */

import {
  type BlockMerkleRoot,
  type LocalTriplet,
  blockMerkleRoot,
  specHash,
} from "@yakcc/contracts";
import type { SpecYak } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import type { ResolutionResult, ResolvedBlock } from "./resolve.js";
import { compileToWasm } from "./wasm-backend.js";
import { WasmTrap, createHost, instantiateAndRun } from "./wasm-host.js";

// ---------------------------------------------------------------------------
// Fixture helpers — mirrors wasm-backend.test.ts pattern
// ---------------------------------------------------------------------------

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

const ADD_IMPL_SOURCE = "export function add(a: number, b: number): number { return a + b; }";

function makeAddResolution(): ResolutionResult {
  const id = makeMerkleRoot("add", "Return the sum of two integers", ADD_IMPL_SOURCE);
  return makeResolution([{ id, source: ADD_IMPL_SOURCE }]);
}

// ---------------------------------------------------------------------------
// Test 1: importObject shape
// ---------------------------------------------------------------------------

describe("createHost() — importObject shape", () => {
  it("exposes all 5 required yakcc_host keys", () => {
    const host = createHost();
    const yh = host.importObject.yakcc_host as Record<string, unknown>;
    expect(yh).toBeDefined();
    // memory must be a WebAssembly.Memory
    expect(yh.memory).toBeInstanceOf(WebAssembly.Memory);
    // host_log, host_alloc, host_free, host_panic must be functions
    expect(typeof yh.host_log).toBe("function");
    expect(typeof yh.host_alloc).toBe("function");
    expect(typeof yh.host_free).toBe("function");
    expect(typeof yh.host_panic).toBe("function");
    host.close();
  });

  it("memory is fixed at 1 page (65536 bytes)", () => {
    const host = createHost();
    expect(host.memory.buffer.byteLength).toBe(65536);
    host.close();
  });
});

// ---------------------------------------------------------------------------
// Test 2: __wasm_export_add via instantiateAndRun
// ---------------------------------------------------------------------------

describe("instantiateAndRun — __wasm_export_add", () => {
  it("add(2, 3) === 5", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const { result } = await instantiateAndRun(bytes, "__wasm_export_add", [2, 3]);
    expect(result).toBe(5);
  });

  it("add(0, 0) === 0", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const { result } = await instantiateAndRun(bytes, "__wasm_export_add", [0, 0]);
    expect(result).toBe(0);
  });

  it("add(-7, 3) === -4", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const { result } = await instantiateAndRun(bytes, "__wasm_export_add", [-7, 3]);
    expect(result).toBe(-4);
  });
});

// ---------------------------------------------------------------------------
// Test 3: __wasm_export_string_len round-trip
// ---------------------------------------------------------------------------

describe("instantiateAndRun — __wasm_export_string_len", () => {
  it("returns the byte-length of a UTF-8 string written via host_alloc", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const host = createHost();
    const { instance } = await WebAssembly.instantiate(bytes, host.importObject);

    // Write a test string into memory via host_alloc, then call string_len
    const testString = "hello";
    const encoded = new TextEncoder().encode(testString);
    const byteLen = encoded.length; // 5

    // Allocate space for the string
    const hostAlloc = (host.importObject.yakcc_host as Record<string, unknown>).host_alloc as (
      size: number,
    ) => number;
    const ptr = hostAlloc(byteLen);

    // Write the bytes into memory
    const memView = new Uint8Array(host.memory.buffer);
    memView.set(encoded, ptr);

    // Call __wasm_export_string_len(ptr, byteLen) — should return byteLen
    const stringLen = instance.exports.__wasm_export_string_len as (
      ptr: number,
      len: number,
    ) => number;
    const result = stringLen(ptr, byteLen);
    expect(result).toBe(byteLen);
    host.close();
  });

  it("returns 0 for an empty string (len=0)", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const { result } = await instantiateAndRun(bytes, "__wasm_export_string_len", [0, 0]);
    expect(result).toBe(0);
  });

  it("returns correct byte-length for a multi-byte UTF-8 string", async () => {
    // "café" = 5 bytes in UTF-8 (é is 2 bytes)
    const bytes = await compileToWasm(makeAddResolution());
    const host = createHost();
    const { instance } = await WebAssembly.instantiate(bytes, host.importObject);

    const testString = "café";
    const encoded = new TextEncoder().encode(testString);
    const byteLen = encoded.length; // 5

    const hostAlloc = (host.importObject.yakcc_host as Record<string, unknown>).host_alloc as (
      size: number,
    ) => number;
    const ptr = hostAlloc(byteLen);
    const memView = new Uint8Array(host.memory.buffer);
    memView.set(encoded, ptr);

    const stringLen = instance.exports.__wasm_export_string_len as (
      ptr: number,
      len: number,
    ) => number;
    expect(stringLen(ptr, byteLen)).toBe(byteLen);
    host.close();
  });
});

// ---------------------------------------------------------------------------
// Test 4: __wasm_export_panic_demo throws WasmTrap
// ---------------------------------------------------------------------------

describe("instantiateAndRun — __wasm_export_panic_demo", () => {
  it("throws WasmTrap with kind='unreachable' and hostPanicCode=0x42", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    await expect(instantiateAndRun(bytes, "__wasm_export_panic_demo", [])).rejects.toSatisfy(
      (e: unknown) => {
        if (!(e instanceof WasmTrap)) return false;
        return e.kind === "unreachable" && e.hostPanicCode === 0x42;
      },
    );
  });

  it("the thrown error is an instance of WasmTrap", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    await expect(instantiateAndRun(bytes, "__wasm_export_panic_demo", [])).rejects.toBeInstanceOf(
      WasmTrap,
    );
  });
});

// ---------------------------------------------------------------------------
// Test 5: Bump allocator — sequential allocations
// ---------------------------------------------------------------------------

describe("createHost() — bump allocator", () => {
  it("3 sequential host_alloc(8) calls return strictly increasing non-overlapping pointers", () => {
    const host = createHost();
    const yakccHost = host.importObject.yakcc_host as Record<string, unknown>;
    const hostAlloc = yakccHost.host_alloc as (size: number) => number;

    const ptr1 = hostAlloc(8);
    const ptr2 = hostAlloc(8);
    const ptr3 = hostAlloc(8);

    // All pointers must be >= 16 (reserved region is 0..15)
    expect(ptr1).toBeGreaterThanOrEqual(16);
    // Each subsequent pointer must be strictly greater than the previous
    expect(ptr2).toBeGreaterThan(ptr1);
    expect(ptr3).toBeGreaterThan(ptr2);
    // No overlap: ptr2 >= ptr1 + 8
    expect(ptr2).toBeGreaterThanOrEqual(ptr1 + 8);
    expect(ptr3).toBeGreaterThanOrEqual(ptr2 + 8);

    host.close();
  });

  it("host_free is a valid no-op (does not throw on any pointer value)", () => {
    const host = createHost();
    const yakccHost = host.importObject.yakcc_host as Record<string, unknown>;
    const hostAlloc = yakccHost.host_alloc as (size: number) => number;
    const hostFree = yakccHost.host_free as (ptr: number) => void;

    const ptr = hostAlloc(16);
    // host_free must not throw
    expect(() => hostFree(ptr)).not.toThrow();
    expect(() => hostFree(0)).not.toThrow();
    expect(() => hostFree(65535)).not.toThrow();

    host.close();
  });
});

// ---------------------------------------------------------------------------
// Test 6: OOM — host_alloc beyond 64 KiB
// ---------------------------------------------------------------------------

describe("createHost() — OOM handling", () => {
  it("host_alloc(70000) throws WasmTrap { kind:'oom' }", () => {
    const host = createHost();
    const yakccHost = host.importObject.yakcc_host as Record<string, unknown>;
    const hostAlloc = yakccHost.host_alloc as (size: number) => number;

    expect(() => hostAlloc(70000)).toThrow(WasmTrap);
    expect(() => {
      try {
        hostAlloc(70000);
      } catch (e) {
        if (e instanceof WasmTrap) {
          expect(e.kind).toBe("oom");
          throw e;
        }
      }
    }).toThrow(WasmTrap);

    host.close();
  });

  it("host_alloc that exhausts remaining space throws WasmTrap { kind:'oom' }", () => {
    const host = createHost();
    const yakccHost = host.importObject.yakcc_host as Record<string, unknown>;
    const hostAlloc = yakccHost.host_alloc as (size: number) => number;

    // Allocate most of the heap (64 KiB - 16 bytes reserved = 65520 usable)
    hostAlloc(65520); // fills the heap to the brim
    // Next allocation should OOM
    expect(() => hostAlloc(1)).toThrow(WasmTrap);
    host.close();
  });
});

// ---------------------------------------------------------------------------
// Test 7: _yakcc_table exported as WebAssembly.Table with size 0
// ---------------------------------------------------------------------------

describe("compileToWasm — _yakcc_table export", () => {
  it("_yakcc_table is a WebAssembly.Table with size 0", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const host = createHost();
    const { instance } = await WebAssembly.instantiate(bytes, host.importObject);

    const table = instance.exports._yakcc_table;
    expect(table).toBeInstanceOf(WebAssembly.Table);
    expect((table as WebAssembly.Table).length).toBe(0);
    host.close();
  });
});

// ---------------------------------------------------------------------------
// Test 8: Acceptance — ts-backend parity for add substrate
// ---------------------------------------------------------------------------

describe("Acceptance: ts-backend parity for add substrate", () => {
  // Reference implementation (ts-backend stand-in).
  // The actual compileToTypeScript output for add(a,b) is (a+b); we use the
  // direct function as the reference per the dispatch brief.
  function referenceAdd(a: number, b: number): number {
    return a + b;
  }

  const pairCases: Array<[number, number]> = [
    [2, 3], // positive
    [-5, 3], // negative + positive
    [0, 0], // zero
    [100, -100], // symmetric
    [2147483647, 0], // MAX_INT32 edge (i32 max)
  ];

  it("WASM add substrate produces same results as reference for all 5 input pairs", async () => {
    const bytes = await compileToWasm(makeAddResolution());

    for (const [a, b] of pairCases) {
      const { result } = await instantiateAndRun(bytes, "__wasm_export_add", [a, b]);
      const expected = referenceAdd(a, b) | 0; // apply i32 truncation to match WASM i32 semantics
      expect(result).toBe(expected);
    }
  });

  it("panic_demo path: WASM throws WasmTrap as expected (non-add path coverage)", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    await expect(instantiateAndRun(bytes, "__wasm_export_panic_demo", [])).rejects.toBeInstanceOf(
      WasmTrap,
    );
  });

  it("WasmTrap is identifiable as an Error subclass", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    let caught: unknown;
    try {
      await instantiateAndRun(bytes, "__wasm_export_panic_demo", []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(WasmTrap);
    expect((caught as WasmTrap).name).toBe("WasmTrap");
  });
});

// ---------------------------------------------------------------------------
// Test 9: host_string_codepoint_at and host_string_codepoint_next_offset
//
// Conformance tests for Wave-3.1 codepoint iteration imports (WI-V1W3-WASM-LOWER-08
// followup, closes #82).  Calls both host functions directly on known inputs and
// asserts outputs against the spec in WASM_HOST_CONTRACT.md §3.11–§3.12.
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-CF5-HOST-001 (see wasm-host.ts)
// ---------------------------------------------------------------------------

describe("createHost() — host_string_codepoint_at conformance", () => {
  /** Write UTF-8 bytes into host memory via host_alloc and return (ptr, len). */
  function writeStr(host: ReturnType<typeof createHost>, s: string): { ptr: number; len: number } {
    const enc = new TextEncoder().encode(s);
    const yakccHost = host.importObject.yakcc_host as Record<string, unknown>;
    const hostAlloc = yakccHost.host_alloc as (n: number) => number;
    const ptr = hostAlloc(Math.max(enc.length, 1));
    if (enc.length > 0) new Uint8Array(host.memory.buffer).set(enc, ptr);
    return { ptr, len: enc.length };
  }

  it("'hello'[0] = 104 (h)", () => {
    const host = createHost();
    const cpAt = (host.importObject.yakcc_host as Record<string, unknown>)
      .host_string_codepoint_at as (ptr: number, len: number, byteOffset: number) => number;
    const { ptr, len } = writeStr(host, "hello");
    expect(cpAt(ptr, len, 0)).toBe(104); // 'h'
    host.close();
  });

  it("'hello'[1..4] = e,l,l,o", () => {
    const host = createHost();
    const cpAt = (host.importObject.yakcc_host as Record<string, unknown>)
      .host_string_codepoint_at as (ptr: number, len: number, byteOffset: number) => number;
    const { ptr, len } = writeStr(host, "hello");
    expect(cpAt(ptr, len, 1)).toBe(101); // 'e'
    expect(cpAt(ptr, len, 2)).toBe(108); // 'l'
    expect(cpAt(ptr, len, 3)).toBe(108); // 'l'
    expect(cpAt(ptr, len, 4)).toBe(111); // 'o'
    host.close();
  });

  it("returns -1 (sentinel) when byteOffset >= len", () => {
    const host = createHost();
    const cpAt = (host.importObject.yakcc_host as Record<string, unknown>)
      .host_string_codepoint_at as (ptr: number, len: number, byteOffset: number) => number;
    const { ptr, len } = writeStr(host, "hello");
    expect(cpAt(ptr, len, 5)).toBe(-1); // past end
    expect(cpAt(ptr, len, 100)).toBe(-1);
    host.close();
  });

  it("'a😀b': codepoint at offset 0 = 97 (a)", () => {
    const host = createHost();
    const cpAt = (host.importObject.yakcc_host as Record<string, unknown>)
      .host_string_codepoint_at as (ptr: number, len: number, byteOffset: number) => number;
    const { ptr, len } = writeStr(host, "a\u{1F600}b");
    // 'a' is 1 byte: offset 0
    expect(cpAt(ptr, len, 0)).toBe(97); // 'a'
    host.close();
  });

  it("'a😀b': codepoint at offset 1 = 0x1F600 (😀, astral-plane)", () => {
    const host = createHost();
    const cpAt = (host.importObject.yakcc_host as Record<string, unknown>)
      .host_string_codepoint_at as (ptr: number, len: number, byteOffset: number) => number;
    const { ptr, len } = writeStr(host, "a\u{1F600}b");
    // 😀 is 4 bytes in UTF-8: starts at offset 1
    expect(cpAt(ptr, len, 1)).toBe(0x1f600);
    host.close();
  });

  it("'a😀b': codepoint at offset 5 = 98 (b)", () => {
    const host = createHost();
    const cpAt = (host.importObject.yakcc_host as Record<string, unknown>)
      .host_string_codepoint_at as (ptr: number, len: number, byteOffset: number) => number;
    const { ptr, len } = writeStr(host, "a\u{1F600}b");
    // 'b' is at offset 1+4=5
    expect(cpAt(ptr, len, 5)).toBe(98); // 'b'
    host.close();
  });

  it("empty string: offset 0 returns -1", () => {
    const host = createHost();
    const cpAt = (host.importObject.yakcc_host as Record<string, unknown>)
      .host_string_codepoint_at as (ptr: number, len: number, byteOffset: number) => number;
    const { ptr } = writeStr(host, "");
    expect(cpAt(ptr, 0, 0)).toBe(-1);
    host.close();
  });
});

describe("createHost() — host_string_codepoint_next_offset conformance", () => {
  function writeStr(host: ReturnType<typeof createHost>, s: string): { ptr: number; len: number } {
    const enc = new TextEncoder().encode(s);
    const yakccHost = host.importObject.yakcc_host as Record<string, unknown>;
    const hostAlloc = yakccHost.host_alloc as (n: number) => number;
    const ptr = hostAlloc(Math.max(enc.length, 1));
    if (enc.length > 0) new Uint8Array(host.memory.buffer).set(enc, ptr);
    return { ptr, len: enc.length };
  }

  it("'hello': next offset after 'h' (offset 0) = 1", () => {
    const host = createHost();
    const cpNext = (host.importObject.yakcc_host as Record<string, unknown>)
      .host_string_codepoint_next_offset as (
      ptr: number,
      len: number,
      byteOffset: number,
    ) => number;
    const { ptr, len } = writeStr(host, "hello");
    expect(cpNext(ptr, len, 0)).toBe(1);
    host.close();
  });

  it("'hello': offsets advance 0→1→2→3→4, last char returns -1 (sentinel)", () => {
    const host = createHost();
    const cpNext = (host.importObject.yakcc_host as Record<string, unknown>)
      .host_string_codepoint_next_offset as (
      ptr: number,
      len: number,
      byteOffset: number,
    ) => number;
    const { ptr, len } = writeStr(host, "hello");
    // Each call returns the next byte offset, except after the last char
    // where nextOffset == lenBytes (5) → returns -1 (end-of-string sentinel)
    expect(cpNext(ptr, len, 0)).toBe(1);
    expect(cpNext(ptr, len, 1)).toBe(2);
    expect(cpNext(ptr, len, 2)).toBe(3);
    expect(cpNext(ptr, len, 3)).toBe(4);
    expect(cpNext(ptr, len, 4)).toBe(-1); // last char: nextOffset = 5 = lenBytes → -1
    host.close();
  });

  it("'hello': next offset past end returns -1", () => {
    const host = createHost();
    const cpNext = (host.importObject.yakcc_host as Record<string, unknown>)
      .host_string_codepoint_next_offset as (
      ptr: number,
      len: number,
      byteOffset: number,
    ) => number;
    const { ptr, len } = writeStr(host, "hello");
    expect(cpNext(ptr, len, 5)).toBe(-1); // offset >= len
    host.close();
  });

  it("'a😀b': offset 0→1 (1-byte 'a'), 1→5 (4-byte emoji), 5→-1 (last char 'b'), 6→-1", () => {
    const host = createHost();
    const cpNext = (host.importObject.yakcc_host as Record<string, unknown>)
      .host_string_codepoint_next_offset as (
      ptr: number,
      len: number,
      byteOffset: number,
    ) => number;
    const { ptr, len } = writeStr(host, "a\u{1F600}b");
    // 'a' = 1 byte, '😀' = 4 bytes, 'b' = 1 byte → total 6 bytes (len=6)
    expect(cpNext(ptr, len, 0)).toBe(1); // after 'a': nextOffset=1 < 6 → 1
    expect(cpNext(ptr, len, 1)).toBe(5); // after '😀': nextOffset=1+4=5 < 6 → 5
    expect(cpNext(ptr, len, 5)).toBe(-1); // after 'b': nextOffset=5+1=6 = lenBytes → -1 (sentinel)
    expect(cpNext(ptr, len, 6)).toBe(-1); // already past end → -1
    host.close();
  });

  it("empty string: next offset from offset 0 returns -1", () => {
    const host = createHost();
    const cpNext = (host.importObject.yakcc_host as Record<string, unknown>)
      .host_string_codepoint_next_offset as (
      ptr: number,
      len: number,
      byteOffset: number,
    ) => number;
    const { ptr } = writeStr(host, "");
    expect(cpNext(ptr, 0, 0)).toBe(-1);
    host.close();
  });
});
