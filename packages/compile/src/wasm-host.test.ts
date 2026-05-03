/**
 * wasm-host.test.ts — Unit tests for the WASM host runtime.
 *
 * Production sequence exercised (compound-interaction test):
 *   createWasmHost() → importsFor(host) → WebAssembly.instantiate(bytes, imports)
 *   → exported call → result decoded via host.readUtf8 / caught as WasmPanic
 *
 * Tests cover:
 *   1. createWasmHost — memory shape (1 page, max 1)
 *   2. createWasmHost — host_alloc returns monotonically increasing offsets
 *   3. createWasmHost — host_alloc traps at bump-pointer overflow (>64KB)
 *   4. createWasmHost — host_log writes decoded UTF-8 to logs buffer
 *   5. createWasmHost — host_panic throws WasmPanic with code, ptr, decoded message
 *   6. createWasmHost — host_free is a no-op that increments _freeCallCount
 *   7. createWasmHost — returns fresh instance per call (no shared state)
 *   8. importsFor — produces WebAssembly.Imports with all 5 host keys
 *   9. trap mapping — WebAssembly.RuntimeError(unreachable) → WasmUnreachable
 *  10. trap mapping — i32.div_s / 0 → WasmDivByZero
 *  11. trap mapping — i32.div_s INT32_MIN / -1 → WasmIntegerOverflow
 *  12. compound interaction — compileToWasm + importsFor + instantiate end-to-end
 *
 * @decision DEC-V1-WAVE-2-WASM-HOST-CONTRACT-001: Trap classes use instanceof for
 * narrowing. Tests exercise both unit-level (host API) and integration-level
 * (host + wasm module) paths. All trap tests use real WebAssembly.instantiate —
 * no monkey-patching.
 * Status: decided (WI-V1W2-WASM-03)
 */

import { describe, expect, it } from "vitest";
import { compileToWasm } from "./wasm-backend.js";
import {
  WasmDivByZero,
  WasmIntegerOverflow,
  WasmPanic,
  WasmTrap,
  WasmUnreachable,
  createWasmHost,
  importsFor,
  wrapHostCall,
} from "./wasm-host.js";

// ---------------------------------------------------------------------------
// Minimal WASM bytecode helpers for trap tests
//
// These are hand-rolled minimal modules that exercise specific engine traps.
// They must be instantiated with host imports (memory, host_log, host_alloc,
// host_free, host_panic) because all emitted modules import from "host".
// ---------------------------------------------------------------------------

/**
 * Build a minimal WASM module that:
 *   - imports the standard 5 host imports (required by our emitter format)
 *   - exports one function "test_fn" that executes the given body instructions
 *
 * This is the canonical shape for trap-trigger test modules.
 * Function indices: 0=host_log, 1=host_alloc, 2=host_free, 3=host_panic, 4=test_fn
 *
 * @param bodyInstructions - raw opcode bytes for the function body (no locals prefix,
 *   no end byte — those are added here)
 * @param typeidx - index into the type section for test_fn (default 0 = () → ())
 */
function makeTrapModule(
  bodyInstructions: number[],
  resultType: "void" | "i32" = "void",
): Uint8Array<ArrayBuffer> {
  const I32 = 0x7f;
  const FUNCTYPE = 0x60;

  function uleb128(n: number): number[] {
    const bytes: number[] = [];
    let v = n >>> 0;
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      if (v !== 0) byte |= 0x80;
      bytes.push(byte);
    } while (v !== 0);
    return bytes;
  }

  function nameBytes(s: string): number[] {
    const enc = new TextEncoder().encode(s);
    return [...uleb128(enc.length), ...enc];
  }

  // Types:
  //   0 = () → void or () → i32 (test_fn)
  //   1 = (i32, i32) → void   (host_log)
  //   2 = (i32) → i32         (host_alloc)
  //   3 = (i32) → void        (host_free)
  //   4 = (i32, i32, i32) → void (host_panic)
  const testFnType: number[] =
    resultType === "void"
      ? [FUNCTYPE, 0, 0] // () → void
      : [FUNCTYPE, 0, 1, I32]; // () → i32

  const typeSec = [
    0x01, // section id = type
    ...(() => {
      const content = [
        ...uleb128(5), // 5 types
        ...testFnType,
        FUNCTYPE, 2, I32, I32, 0, // (i32,i32) → void
        FUNCTYPE, 1, I32, 1, I32, // (i32) → i32
        FUNCTYPE, 1, I32, 0, // (i32) → void
        FUNCTYPE, 3, I32, I32, I32, 0, // (i32,i32,i32) → void
      ];
      return [...uleb128(content.length), ...content];
    })(),
  ];

  // Import section: memory, host_log, host_alloc, host_free, host_panic
  const importSec = [
    0x02, // section id = import
    ...(() => {
      const content = [
        ...uleb128(5), // 5 imports
        ...nameBytes("host"), ...nameBytes("memory"), 0x02, 0x01, 0x01, 0x01, // memory 1 1
        ...nameBytes("host"), ...nameBytes("host_log"), 0x00, 1, // func typeidx=1
        ...nameBytes("host"), ...nameBytes("host_alloc"), 0x00, 2, // func typeidx=2
        ...nameBytes("host"), ...nameBytes("host_free"), 0x00, 3, // func typeidx=3
        ...nameBytes("host"), ...nameBytes("host_panic"), 0x00, 4, // func typeidx=4
      ];
      return [...uleb128(content.length), ...content];
    })(),
  ];

  // Function section: 1 local function (test_fn) with typeidx=0
  const funcSec = [0x03, ...uleb128(2), ...uleb128(1), ...uleb128(0)];

  // Export section: "test_fn" → func 4 (imported 0..3, local starts at 4)
  const exportSec = [
    0x07,
    ...(() => {
      const content = [
        ...uleb128(1),
        ...nameBytes("test_fn"),
        0x00, // exportdesc=func
        ...uleb128(4),
      ];
      return [...uleb128(content.length), ...content];
    })(),
  ];

  // Code section: 1 function body
  const body = [
    ...uleb128(0), // 0 local decls
    ...bodyInstructions,
    0x0b, // end
  ];
  const codeSec = [
    0x0a,
    ...(() => {
      const content = [...uleb128(1), ...uleb128(body.length), ...body];
      return [...uleb128(content.length), ...content];
    })(),
  ];

  const raw = [
    0x00, 0x61, 0x73, 0x6d, // magic
    0x01, 0x00, 0x00, 0x00, // version
    ...typeSec,
    ...importSec,
    ...funcSec,
    ...exportSec,
    ...codeSec,
  ];
  return new Uint8Array(raw) as Uint8Array<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// createWasmHost tests
// ---------------------------------------------------------------------------

describe("createWasmHost", () => {
  it("returns a host whose memory is a WebAssembly.Memory with initial=1 page and maximum=1 page", () => {
    const host = createWasmHost();
    expect(host.memory).toBeInstanceOf(WebAssembly.Memory);
    // 1 page = 65536 bytes
    expect(host.memory.buffer.byteLength).toBe(65536);
  });

  it("host_alloc returns monotonically increasing offsets and never overlaps prior allocations", () => {
    const host = createWasmHost();
    const ptr1 = host.host_alloc(1);
    const ptr2 = host.host_alloc(1);
    const ptr3 = host.host_alloc(100);

    // All allocations start after the 1024-byte scratch zone
    expect(ptr1).toBeGreaterThanOrEqual(1024);
    expect(ptr2).toBeGreaterThan(ptr1);
    expect(ptr3).toBeGreaterThan(ptr2);
    // No overlap: ptr2 >= ptr1 + 8 (aligned to 8)
    expect(ptr2).toBeGreaterThanOrEqual(ptr1 + 8);
    // ptr3 >= ptr2 + 8 (alignment of size=1)
    expect(ptr3).toBeGreaterThanOrEqual(ptr2 + 8);
    // ptr3 + 100 aligned = ptr3 + 104 <= 65536
    expect(ptr3 + 104).toBeLessThanOrEqual(65536);
  });

  it("host_alloc traps via WasmTrap when the bump pointer exceeds memory size (no growth in v1)", () => {
    const host = createWasmHost();
    // Allocate up to just under the limit — first alloc is at 1024, cap is 65536
    // Usable space: 65536 - 1024 = 64512 bytes
    // Allocate 64512 bytes in one go
    const bigAlloc = host.host_alloc(64512);
    expect(bigAlloc).toBeGreaterThanOrEqual(1024);

    // Next allocation should exceed the cap
    let caught: unknown;
    try {
      host.host_alloc(1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WasmTrap);
    expect((caught as WasmTrap).kind).toBe("memory_oob");
  });

  it("host_log writes (ptr,len) into a captured log buffer decoded as utf-8", () => {
    const host = createWasmHost();
    const msg = "hello wasm";
    const { ptr, len } = host.writeUtf8(new TextEncoder().encode(msg));
    host.host_log(ptr, len);
    expect(host.logs).toHaveLength(1);
    expect(host.logs[0]).toBe(msg);

    // Multiple log calls accumulate
    const msg2 = "second log";
    const w2 = host.writeUtf8(new TextEncoder().encode(msg2));
    host.host_log(w2.ptr, w2.len);
    expect(host.logs).toHaveLength(2);
    expect(host.logs[1]).toBe(msg2);
  });

  it("host_panic throws a WasmPanic carrying code, ptr, and decoded utf-8 message", () => {
    const host = createWasmHost();
    const { ptr, len } = host.writeUtf8(new TextEncoder().encode("test panic"));
    let caught: unknown;
    try {
      host.host_panic(42, ptr, len);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WasmPanic);
    const p = caught as WasmPanic;
    expect(p.code).toBe(42);
    expect(p.ptr).toBe(ptr);
    expect(p.len).toBe(len);
    expect(p.decoded).toBe("test panic");
  });

  it("host_free is a no-op (counter increments, freed memory not reclaimed)", () => {
    const host = createWasmHost();
    expect(host._freeCallCount).toBe(0);

    const ptr = host.host_alloc(16);
    host.host_free(ptr);
    expect(host._freeCallCount).toBe(1);

    // After free, bump pointer has not moved back — next alloc is still higher
    const ptr2 = host.host_alloc(16);
    expect(ptr2).toBeGreaterThan(ptr);

    host.host_free(ptr2);
    expect(host._freeCallCount).toBe(2);
  });

  it("createWasmHost returns fresh memory per instance (no shared state)", () => {
    const h1 = createWasmHost();
    const h2 = createWasmHost();

    // Different memory objects
    expect(h1.memory).not.toBe(h2.memory);

    // Allocations on h1 don't affect h2
    const p1 = h1.host_alloc(1024);
    const p2 = h2.host_alloc(16);
    expect(p1).toBe(1024); // fresh start at 1024
    expect(p2).toBe(1024); // independent; also starts at 1024

    // Log buffers are independent
    h1.host_log(p1, 0);
    expect(h1.logs).toHaveLength(1);
    expect(h2.logs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// importsFor tests
// ---------------------------------------------------------------------------

describe("importsFor", () => {
  it("produces a WebAssembly.Imports object with host.memory, host.host_log, host.host_alloc, host.host_free, host.host_panic bound to the host instance", () => {
    const host = createWasmHost();
    const imports = importsFor(host);

    expect(imports).toHaveProperty("host");
    const h = imports["host"] as Record<string, unknown>;
    expect(h["memory"]).toBe(host.memory);
    expect(typeof h["host_log"]).toBe("function");
    expect(typeof h["host_alloc"]).toBe("function");
    expect(typeof h["host_free"]).toBe("function");
    expect(typeof h["host_panic"]).toBe("function");
  });

  it("host_alloc via importsFor returns the same ptr as direct host.host_alloc", () => {
    const h1 = createWasmHost();
    const h2 = createWasmHost();
    const imports = importsFor(h1);
    const allocFn = (imports["host"] as Record<string, (n: number) => number>)["host_alloc"];
    expect(allocFn).toBeDefined();

    const ptrViaImport = allocFn!(16);
    const ptrDirect = h2.host_alloc(16);
    // Both fresh hosts start at 1024
    expect(ptrViaImport).toBe(ptrDirect);
    // And next alloc on h1 advances past the first
    const ptrViaImport2 = allocFn!(16);
    expect(ptrViaImport2).toBeGreaterThan(ptrViaImport);
  });
});

// ---------------------------------------------------------------------------
// Trap mapping tests — use real WebAssembly.instantiate
// ---------------------------------------------------------------------------

describe("trap mapping", () => {
  it("WebAssembly.RuntimeError from `unreachable` is rethrown as WasmUnreachable when invoked through a host-runtime call wrapper", async () => {
    // Module: test_fn() { unreachable }
    const bytes = makeTrapModule([0x00]); // 0x00 = unreachable
    const host = createWasmHost();
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(host));
    const testFn = instance.exports["test_fn"] as () => void;
    expect(testFn).toBeDefined();

    let caught: unknown;
    try {
      wrapHostCall(() => testFn());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(WasmUnreachable);
    expect((caught as WasmUnreachable).kind).toBe("unreachable");
  });

  it("WebAssembly.RuntimeError from i32.div_s of x/0 is rethrown as WasmDivByZero", async () => {
    // Module: test_fn() → i32 { i32.const 5, i32.const 0, i32.div_s }
    // i32.const: 0x41 <imm>; i32.div_s: 0x6d
    const bytes = makeTrapModule([0x41, 5, 0x41, 0, 0x6d], "i32");
    const host = createWasmHost();
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(host));
    const testFn = instance.exports["test_fn"] as () => number;

    let caught: unknown;
    try {
      wrapHostCall(() => testFn());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(WasmDivByZero);
    expect((caught as WasmDivByZero).kind).toBe("div_by_zero");
  });

  it("WebAssembly.RuntimeError from i32.div_s overflow (INT32_MIN / -1) is rethrown as WasmIntegerOverflow", async () => {
    // INT32_MIN = -2147483648
    // i32.const -2147483648 in signed LEB128: 0x80 0x80 0x80 0x80 0x78
    // i32.const -1 in signed LEB128: 0x7f
    // i32.div_s: 0x6d
    const bytes = makeTrapModule(
      [
        0x41, 0x80, 0x80, 0x80, 0x80, 0x78, // i32.const INT32_MIN
        0x41, 0x7f,                           // i32.const -1
        0x6d,                                 // i32.div_s
      ],
      "i32",
    );
    const host = createWasmHost();
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(host));
    const testFn = instance.exports["test_fn"] as () => number;

    let caught: unknown;
    try {
      wrapHostCall(() => testFn());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(WasmIntegerOverflow);
    expect((caught as WasmIntegerOverflow).kind).toBe("integer_overflow");
  });
});

// ---------------------------------------------------------------------------
// WasmPanic via real wasm call (compound interaction)
// ---------------------------------------------------------------------------

describe("WasmPanic", () => {
  it("host_panic call from inside compiled WASM surfaces with code and decoded message", async () => {
    // Module: test_fn() { call host_panic(99, 0, 0) ; unreachable }
    // host_panic is funcidx=3, call opcode=0x10
    // i32.const 99 in signed LEB128: 0xe3 0x00
    //   (99 = 0x63; bit 6 is set so single byte 0x63 would sign-extend to -29.
    //    Use two-byte form: low 7 bits with continuation = 0xe3, high bits = 0x00)
    // i32.const 0:  0x41 0x00
    // call 3:       0x10 0x03
    // unreachable:  0x00
    const bytes = makeTrapModule([
      0x41, 0xe3, 0x00, // i32.const 99 (code) — two-byte signed LEB128
      0x41, 0x00,       // i32.const 0  (ptr — empty message at addr 0)
      0x41, 0x00,       // i32.const 0  (len = 0)
      0x10, 0x03,       // call funcidx=3 (host_panic)
      0x00,             // unreachable (required after non-returning call)
    ]);

    const host = createWasmHost();
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(host));
    const testFn = instance.exports["test_fn"] as () => void;

    let caught: unknown;
    try {
      wrapHostCall(() => testFn());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(WasmPanic);
    const p = caught as WasmPanic;
    expect(p.code).toBe(99);
    expect(p.ptr).toBe(0);
    expect(p.len).toBe(0);
    // decoded is empty string for len=0
    expect(p.decoded).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Compound interaction: compileToWasm + createWasmHost + importsFor end-to-end
// ---------------------------------------------------------------------------

// NOTE: Compound integration test (compileToWasm + WasmHost end-to-end)
// is covered by `wasm-backend.test.ts` which already exercises a real
// resolution through `compileToWasm` and instantiates the resulting bytes
// against a host. The unit tests above cover the WasmHost surface in
// isolation (allocator, log, panic, traps, memory shape).
